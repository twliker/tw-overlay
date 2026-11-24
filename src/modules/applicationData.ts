/**
 * 기능 계약 — 로컬 플레이 데이터의 단일 원본
 * 프로필/설정/숙제와 변경 이력을 같은 SQLite 트랜잭션으로 확정한다. 모험일지는 같은 파일에
 * 보존하되 변경 outbox에 넣지 않는다. 기존 diary.db는 SQLite online backup으로 staging에
 * 복제하고 원본 테이블 건수/합계를 검증한 뒤 게시한다. 기존 사용자 폴더를 테스트에 쓰지 않는다.
 * 초기화는 새 DB의 완료 marker로 멱등이며, 알 수 없는 새 스키마/손상은 빈 DB로 덮지 않는다.
 * 회귀: scripts/check-profile-storage.ts. 통합 상태: .agents/development/profile-storage.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID,createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import Database = require('better-sqlite3');
import {loadChatLogSyncStateAtPath} from './chatLogSyncState';
import {ensureDiaryAttribution} from './diaryAttribution';
import {excludeIgnoredProfileLog,hasProfileEventDurability,isDurableProfileEvent,profileEventDurabilityByName,type ProfileLogSource} from './profileLogSource';
import {isProfileToolKey,isSyncableProfileToolValue,PROFILE_TOOL_KEYS} from '../shared/profileTools';
import {legacyPendingHomeworkEvents} from '../shared/legacyHomework';
import {prepareProfileSyncSchema,captureProfileSyncChanges,ProfileSyncModel,rememberDeletedHomework,rememberProfileHomeworkDeletion,saveHomeworkExpiry,rememberLegacyDeviceLocalOriginals} from './profileSyncModel';
import type {DiaryRecordContext} from '../shared/diaryProfiles';
import type { AppConfig, ContentsCheckerItem } from '../shared/types';
import {
  PROFILE_SETTING_KEYS, SHARED_SETTING_KEYS, deviceConfigOnly, isProfileServer, assertProfileName,
  type PlayProfile, type ProfileClockStamp, type HomeworkState,
} from '../shared/playProfiles';

const SCHEMA = 1;
const PROFILE_ORDER_KEY='profile_display_order';
const clone = <T>(value: T): T => structuredClone(value);
const json = (value: unknown): string => JSON.stringify(value);

export interface ProfileStoreOptions {
  directory: string;
  deviceId: string;
  defaults: AppConfig;
  clock?: () => ProfileClockStamp;
}

interface ProfileRow { id: string; name: string; created_at: number; last_used_at: number | null; deleted_at: number | null }
interface HomeworkRow { item_id: string; definition: string; state: string; position: number; expires_at: number | null }
type PendingCursor={time:number;rowId:number};
type PendingRow=PendingCursor & {event_id:string;payload:string;assigned_profile_id:string | null};
type ApplyPending=(payload:unknown,eventId:string,unassigned:boolean)=>unknown;
/** 대기 기록 재생에 포함할 미배정 행. true=전부(이전 세션 수동 배정), false=제외,
 * 범위=rowid가 (afterRowId, throughRowId]인 행만(현재 세션에서 한 선택 대기 구간의 기록). */
export type UnassignedReplayScope=boolean | {afterRowId:number;throughRowId:number};
const unassignedRowBounds=(scope:UnassignedReplayScope):[number,number] =>
  scope===true ? [0,Number.MAX_SAFE_INTEGER] : scope===false ? [0,0] : [scope.afterRowId,scope.throughRowId];
export type LiveRecordGroup='profile' | 'experience' | 'seed';
const PENDING_REPLAY_SLICE_MS=12;

function writeAtomic(file: string, value: unknown): void {
  writeAtomicText(file,json(value));
}

function writeAtomicText(file: string, value: string): void {
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

const MIGRATION_STAGING_PREFIX='app-data-migration-';
const MIGRATION_STAGING_FILE=/^app-data-migration-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db(?:-wal|-shm|-journal)?$/i;
const SQLITE_SIDE_FILES=['','-wal','-shm','-journal'];

/** 게시되지 않은 staging DB는 원본 후보가 아니다. 이 프로세스가 이름을 정한 파일만 지운다. */
function removeAbandonedMigrationStaging(directory:string):void {
  for (const name of fs.readdirSync(directory)) {
    if (!MIGRATION_STAGING_FILE.test(name)) continue;
    try {fs.rmSync(path.join(directory,name),{force:true});} catch {/* 다음 실행에서 다시 정리한다. */}
  }
}

/** 실패한 시도의 사본만 지운다. 원본 diary.db/config.json과 다른 시도의 백업은 건드리지 않는다. */
function discardFailedMigration(staging:string,backup:string):void {
  for (const suffix of SQLITE_SIDE_FILES) {
    try {fs.rmSync(`${staging}${suffix}`,{force:true});} catch {/* staging은 다음 실행 시작 시 다시 정리한다. */}
  }
  try {fs.rmSync(backup,{recursive:true,force:true});} catch {/* 원래 오류를 우선 전달한다. */}
}

function tableSummary(db: Database.Database): Record<string, { count: number; amount: number | null }> {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return Object.fromEntries(names.map(({ name }) => {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string }[];
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number }).n;
    const amount = columns.some(c => c.name === 'amount')
      ? (db.prepare(`SELECT COALESCE(SUM(amount),0) AS n FROM ${quoted}`).get() as { n: number }).n : null;
    return [name, { count, amount }];
  }));
}

export class ApplicationData {
  private connection!:Database.Database;
  get database():Database.Database {return this.connection;}
  readonly filePath: string;
  private readonly clock: () => ProfileClockStamp;
  private recordContext: { profileId: string | null; sessionId: string | null } = {profileId:null,sessionId:null};
  private automaticSyncChange=false;
  private syncTransactionDepth=0;

  private constructor(private readonly options: ProfileStoreOptions) {
    this.filePath = path.join(options.directory, 'app-data.db');
    this.clock = options.clock || (() => ({ utcMs: Date.now(), source: 'unverified', uncertaintyMs: null }));
    this.reopen();
  }

  /** 백업 복원 잠금이 해제된 뒤 같은 원본 파일만 다시 연다. diary.db로 폴백하지 않는다. */
  reopen():void {
    if (this.connection?.open) return;
    this.connection = new Database(this.filePath, { fileMustExist: true });
    try {
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('busy_timeout = 5000');
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('synchronous = FULL');
      const version = this.database.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get() as { value: string } | undefined;
      const complete=this.database.prepare("SELECT 1 FROM app_meta WHERE key='legacy_migration_complete'").get();
      if (!version || Number(version.value) !== SCHEMA || !complete) {
        this.database.close();
        throw new Error('지원하지 않는 프로필 저장소 버전입니다.');
      }
      this.recoverConfigCommit();
      this.database.exec('CREATE TABLE IF NOT EXISTS profile_runtime_state(profile_id TEXT PRIMARY KEY REFERENCES play_profiles(id),value TEXT NOT NULL)');
      this.database.exec('CREATE TABLE IF NOT EXISTS profile_tools(profile_id TEXT NOT NULL REFERENCES play_profiles(id),key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(profile_id,key))');
      this.database.exec(`CREATE TABLE IF NOT EXISTS profile_log_sync_state(profile_id TEXT NOT NULL REFERENCES play_profiles(id),file_key TEXT NOT NULL,state_json TEXT NOT NULL,PRIMARY KEY(profile_id,file_key));
        CREATE TABLE IF NOT EXISTS profile_log_sources(file_key TEXT PRIMARY KEY,state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS profile_log_line_owners(line_key BLOB PRIMARY KEY,log_date TEXT NOT NULL,profile_id TEXT REFERENCES play_profiles(id),live INTEGER NOT NULL CHECK(live IN (0,1)));
        CREATE INDEX IF NOT EXISTS idx_profile_log_lines_date ON profile_log_line_owners(log_date);
        CREATE TABLE IF NOT EXISTS profile_ignored_log_ranges(fingerprint TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(fingerprint,start_offset,end_offset));
        CREATE TABLE IF NOT EXISTS profile_log_source_ranges(fingerprint TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,profile_id TEXT REFERENCES play_profiles(id),PRIMARY KEY(fingerprint,start_offset));
        CREATE TABLE IF NOT EXISTS profile_log_legacy_aggregates(fingerprint TEXT PRIMARY KEY,profile_id TEXT NOT NULL REFERENCES play_profiles(id),value TEXT NOT NULL);`);
      // 기존 JSON의 증거도 DB에 한 번 보관해 ZIP/다른 PC 복원에서 진행 기준이 바뀌지 않게 한다.
      if (!this.database.prepare("SELECT 1 FROM app_meta WHERE key='legacy_chat_log_sync_state'").get()) {
        this.database.prepare('INSERT INTO app_meta VALUES(?,?)').run('legacy_chat_log_sync_state',JSON.stringify(loadChatLogSyncStateAtPath(this.options.directory)));
      }
      this.database.exec(`CREATE TABLE IF NOT EXISTS profile_event_receipts(event_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,occurred_at INTEGER NOT NULL,payload_hash TEXT NOT NULL,assigned_profile_id TEXT,resolved_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_profile_event_receipts_occurred ON profile_event_receipts(occurred_at);`);
      this.database.exec(`CREATE INDEX IF NOT EXISTS idx_profile_events_resolved ON pending_profile_events(resolved_at);
        CREATE INDEX IF NOT EXISTS idx_pending_profile_session_time ON pending_profile_events(session_id,occurred_at)
          WHERE resolved_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_pending_profile_owner ON pending_profile_events(assigned_profile_id)
          WHERE resolved_at IS NULL AND assigned_profile_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS profile_runtime_events(
          sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES pending_profile_events(event_id),
          profile_id TEXT NOT NULL REFERENCES play_profiles(id));
        CREATE INDEX IF NOT EXISTS idx_profile_runtime_events_owner ON profile_runtime_events(profile_id,sequence);`);
      this.ensureDiaryAttribution();
      prepareProfileSyncSchema(this.database);
      this.database.transaction(() => {
        // 전송 원본은 profile_sync_own에 있다. 도구 이력에는 키별 최신 본문만 필요하다.
        this.database.exec(`CREATE INDEX IF NOT EXISTS idx_profile_tool_changes ON profile_change_log(profile_id,field)
          WHERE scope='profile-tool';
          CREATE INDEX IF NOT EXISTS idx_profile_change_field ON profile_change_log(scope,profile_id,field);`);
        const toolHistoryMarker='profile_tool_history_compacted';
        if (!this.database.prepare('SELECT 1 FROM app_meta WHERE key=?').get(toolHistoryMarker)) {
          this.database.exec(`DELETE FROM profile_change_log WHERE scope='profile-tool' AND rowid NOT IN (
            SELECT MAX(rowid) FROM profile_change_log WHERE scope='profile-tool' GROUP BY profile_id,field
          )`);
          this.database.prepare('INSERT INTO app_meta VALUES(?,?)').run(toolHistoryMarker,'true');
        }
        // 이전 버전이 쌓아 둔 이력도 항목별 최신 행으로 한 번 줄인다(change() 계약). 숙제 삭제 사실은 지우기 전에 영구 표식으로 옮긴다.
        const changeHistoryMarker='profile_change_history_compacted';
        if (!this.database.prepare('SELECT 1 FROM app_meta WHERE key=?').get(changeHistoryMarker)) {
          this.backfillDeletedHomework();
          this.database.exec(`DELETE FROM profile_change_log WHERE rowid NOT IN (
            SELECT MAX(rowid) FROM profile_change_log GROUP BY scope,profile_id,field
          )`);
          this.database.prepare('INSERT INTO app_meta VALUES(?,?)').run(changeHistoryMarker,'true');
        }
        // Earlier installations put all unassigned input into one session.
        this.database.exec(`UPDATE pending_profile_events SET session_id='unassigned:legacy:' ||
          CASE WHEN json_extract(payload,'$.data.date') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            THEN json_extract(payload,'$.data.date')
            ELSE COALESCE(date(occurred_at/1000,'unixepoch'),'unknown') END || ':' ||
          COALESCE(json_extract(payload,'$.source.lineKey'),
            json_extract(payload,'$.source.fingerprint') || ':' || json_extract(payload,'$.source.start'),CAST(rowid AS TEXT))
          WHERE session_id='outside-game-unassigned' AND resolved_at IS NULL`);
        const ignoredLogMarker='ignored_log_ranges_backfilled';
        if (!this.database.prepare('SELECT 1 FROM app_meta WHERE key=?').get(ignoredLogMarker)) {
          this.saveIgnoredLogExclusions('resolved_at IS NOT NULL AND assigned_profile_id IS NULL');
          this.database.prepare('INSERT INTO app_meta VALUES(?,?)').run(ignoredLogMarker,'true');
        }
        new ProfileSyncModel(this.database,this.options.deviceId,this.clock);
        const repaired=this.fillMissingDefaultHomework();
        captureProfileSyncChanges(this.database,this.options.deviceId,this.clock(),repaired>0);
      })();
    } catch (error) {
      if (this.database.open) this.database.close();
      throw error;
    }
  }

  /**
   * 기능 계약 — 기존 diary.db/config.json → app-data.db 최초 이전.
   * 시도마다 고유 staging DB와 `backups/before-play-profiles-<시도>`를 만든다. 검증·게시(rename)까지 끝난
   * 시도의 백업만 남기고 app_meta.legacy_migration_complete에 경로를 기록한다(릴리즈 노트의 되돌리기 안내).
   * 게시 전에 실패한 시도는 자신의 staging DB와 백업 폴더를 지운다. 원본 diary.db/config.json은 어느 경우에도
   * 읽기만 하므로 결정적 실패(중복 캐릭터 ID, 건수·금액 검증)가 매 실행 반복돼도 사본이 쌓이지 않는다.
   * 이전 실행이 강제 종료로 남긴 staging DB는 원본 후보가 아니므로 시작할 때 정리한다.
   * 회귀: check-profile-storage.ts(실패 정리/재시도), check-profile-backup.ts(실제 부팅의 반복 실패).
   */
  static async initialize(options: ProfileStoreOptions, legacy: AppConfig,serverEvidence?:{value:unknown}): Promise<ApplicationData> {
    if (!options.deviceId || options.deviceId.length > 200) throw new Error('기기 식별자가 올바르지 않습니다.');
    fs.mkdirSync(options.directory, { recursive: true });
    removeAbandonedMigrationStaging(options.directory);
    const target = path.join(options.directory, 'app-data.db');
    if (fs.existsSync(target)) return new ApplicationData(options);
    // 매 시도마다 고유 staging/backup. 실패한 산출물은 다음 실행의 원본 후보가 아니다.
    const attempt = randomUUID();
    const staging = path.join(options.directory, `${MIGRATION_STAGING_PREFIX}${attempt}.db`);
    const backup = path.join(options.directory, 'backups', `before-play-profiles-${attempt}`);
    try {
      await ApplicationData.migrateLegacy(options,legacy,serverEvidence,staging,backup);
      fs.renameSync(staging, target);
    } catch (error) {
      discardFailedMigration(staging,backup);
      throw error;
    }
    return new ApplicationData(options);
  }

  /** 검증한 새 DB를 staging에만 만든다. 게시와 실패 정리는 initialize가 맡는다. */
  private static async migrateLegacy(options: ProfileStoreOptions, legacy: AppConfig,serverEvidence:{value:unknown} | undefined,
    staging:string,backup:string):Promise<void> {
    fs.mkdirSync(backup, { recursive: true });
    const legacyFile = path.join(options.directory, 'diary.db');
    let expected: ReturnType<typeof tableSummary> = {};
    if (fs.existsSync(legacyFile)) {
      const source = new Database(legacyFile, { readonly: true, fileMustExist: true });
      try {
        const sourceVersion = source.pragma('data_version',{simple:true});
        expected = tableSummary(source);
        await source.backup(staging);
        if (source.pragma('data_version',{simple:true}) !== sourceVersion) {
          throw new Error('이전 도중 다른 작업이 기존 일지를 변경했습니다. 다시 실행해 주세요.');
        }
        const copy = new Database(staging, { readonly: true });
        try {
          if (json(tableSummary(copy)) !== json(expected)) throw new Error('이전 도중 기존 일지가 변경되었습니다. 다시 실행해 주세요.');
          await copy.backup(path.join(backup, 'diary.db'));
        } finally { copy.close(); }
      } finally { source.close(); }
    }
    const configFile = path.join(options.directory, 'config.json');
    if (fs.existsSync(configFile)) fs.copyFileSync(configFile, path.join(backup, 'config.json'), fs.constants.COPYFILE_EXCL);
    // 기본값 병합 결과를 사용자가 서버를 선택한 증거로 삼지 않는다.
    const storedServer: unknown = serverEvidence ? serverEvidence.value : fs.existsSync(configFile)
      ? JSON.parse(fs.readFileSync(configFile, 'utf8')).userServer : undefined;
    writeAtomic(path.join(backup, 'migration-source.json'), { schema: SCHEMA, tables: expected, legacyConfig: legacy });
    const db = new Database(staging);
    try {
      db.pragma('foreign_keys = ON');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE play_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
            last_used_at INTEGER, deleted_at INTEGER);
          CREATE TABLE profile_settings (profile_id TEXT NOT NULL REFERENCES play_profiles(id), key TEXT NOT NULL,
            value TEXT NOT NULL, PRIMARY KEY(profile_id,key));
          CREATE TABLE shared_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE profile_homework (profile_id TEXT NOT NULL REFERENCES play_profiles(id), item_id TEXT NOT NULL,
            definition TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(profile_id,item_id));
          CREATE TABLE legacy_character_profiles (character_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES play_profiles(id));
          CREATE TABLE profile_change_log (change_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            profile_id TEXT, scope TEXT NOT NULL, field TEXT NOT NULL, operation TEXT NOT NULL, value TEXT NOT NULL,
            changed_at INTEGER NOT NULL, clock_source TEXT NOT NULL, uncertainty_ms REAL, base_revision INTEGER NOT NULL,
            UNIQUE(device_id,sequence));
          CREATE TABLE profile_revisions (scope TEXT NOT NULL, profile_id TEXT NOT NULL, revision INTEGER NOT NULL,
            PRIMARY KEY(scope,profile_id));
          CREATE TABLE pending_profile_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
            payload TEXT NOT NULL, assigned_profile_id TEXT REFERENCES play_profiles(id), resolved_at INTEGER);
          CREATE INDEX pending_profile_session ON pending_profile_events(session_id,resolved_at);
          CREATE TABLE profile_local_state (profile_id TEXT PRIMARY KEY REFERENCES play_profiles(id), value TEXT NOT NULL);
        `);
        // v3.2.2가 PC마다 따로 보관하던 설정의 원래 값. 동기화가 이전 직후 값(그대로 복사한 값)만 자동 병합하도록 근거로 남긴다.
        rememberLegacyDeviceLocalOriginals(db,legacy);
        const characters = legacy.characterPresets || [];
        if (new Set(characters.map(c => c.id)).size !== characters.length) throw new Error('기존 캐릭터 ID가 중복되어 이전을 중단했습니다.');
        const first = characters.find(c => c.id === legacy.selectedCharacterId) || characters[0];
        const ordered = first ? [first, ...characters.filter(c => c !== first)] : [];
        const insertSetting = db.prepare('INSERT INTO profile_settings VALUES(?,?,?)');
        const insertHomework = db.prepare('INSERT INTO profile_homework VALUES(?,?,?,?,?)');
        for (const [index, character] of (ordered.length ? ordered : [{ id: '', name: '' }]).entries()) {
          const id = index === 0 ? 'profile-default' : randomUUID();
          db.prepare('INSERT INTO play_profiles(id,name,created_at) VALUES(?,?,?)').run(id, character.name, Date.now());
          if (character.id) db.prepare('INSERT INTO legacy_character_profiles VALUES(?,?)').run(character.id, id);
          for (const key of PROFILE_SETTING_KEYS) {
            const value = legacy[key];
            if (key === 'userServer') {
              if (isProfileServer(storedServer)) insertSetting.run(id,key,json(storedServer));
            } else if (value !== undefined) insertSetting.run(id,key,json(value));
          }
          const initialItems = !character.id && !legacy.contentsCheckerItems?.length
            ? options.defaults.contentsCheckerItems || [] : legacy.contentsCheckerItems || [];
          for (const [position, item] of initialItems.entries()) {
            const { completedState, ...definition } = item;
            insertHomework.run(id, item.id, json(definition), json(completedState?.[character.id] || {}), position);
          }
        }
        for (const key of SHARED_SETTING_KEYS) if (legacy[key] !== undefined) {
          db.prepare('INSERT INTO shared_settings VALUES(?,?)').run(key, json(legacy[key]));
        }
        // 기존 선택 대기는 캐릭터를 추측해서 배정하지 않는다. 손상된 항목도 원본 그대로 보존해
        // 배정 불가로 안내하며, 한 항목 때문에 전체 이전을 중단하지 않는다(legacyHomework 계약).
        const insertPending=db.prepare('INSERT INTO pending_profile_events(event_id,session_id,occurred_at,payload) VALUES(?,?,?,?)');
        for (const pending of legacyPendingHomeworkEvents(legacy.pendingHomeworks)) {
          insertPending.run(randomUUID(), 'legacy-unassigned', pending.occurredAt, json(pending.payload));
        }
        const actual = tableSummary(db);
        for (const [table, old] of Object.entries(expected)) {
          if (actual[table]?.count !== old.count) throw new Error(`기존 ${table} 건수 검증 실패`);
          if (actual[table]?.amount !== old.amount) throw new Error(`기존 ${table} 금액 검증 실패`);
        }
        db.prepare('INSERT INTO app_meta VALUES(?,?)').run('schema_version', String(SCHEMA));
        db.prepare('INSERT INTO app_meta VALUES(?,?)').run('legacy_migration_complete', json({ backup, tables: expected }));
      })();
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('프로필 DB 무결성 검증 실패');
    } finally { db.close(); }
  }

  list(includeDeleted = false): PlayProfile[] {
    const rows = this.database.prepare(`SELECT * FROM play_profiles ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
      ORDER BY COALESCE(last_used_at,0) DESC, created_at,id`).all() as ProfileRow[];
    const profiles=rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at,
      deletedAt: row.deleted_at, userServer: this.setting(row.id, 'userServer') as number | null }));
    const saved=this.database.prepare('SELECT value FROM app_meta WHERE key=?').get(PROFILE_ORDER_KEY) as {value:string} | undefined;
    if(!saved)return profiles;
    let order:unknown;try {order=JSON.parse(saved.value);} catch {return profiles;}
    if(!Array.isArray(order) || !order.length || order.some(id=>typeof id!=='string') || new Set(order).size!==order.length)return profiles;
    const rank=new Map(order.map((id,index)=>[id as string,index]));
    return profiles.sort((a,b)=>(rank.get(a.id) ?? order.length)-(rank.get(b.id) ?? order.length) || a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  }

  /** 순서는 이 PC의 보기 설정이다. 직접 지정하기 전에는 기존 최근 사용 순을 유지하고, 지정한 뒤에는
   * 프로필 선택/이름 변경/Google 수신으로 순서를 바꾸지 않는다. 새 ID는 지정한 목록 뒤에 표시한다.
   * 살아 있는 ID 전체를 정확히 한 번씩 받아 원자 저장하며, 선택/숙제/일지/Google 변경 이력은 쓰지 않는다.
   * 회귀: check-profile-storage.ts, check-profiles-ui.ts. */
  setProfileOrder(ids:readonly string[]):void {
    if(!Array.isArray(ids) || !ids.length || ids.some(id=>typeof id!=='string') || new Set(ids).size!==ids.length)throw new Error('프로필 순서가 올바르지 않습니다.');
    this.database.transaction(()=>{
      const live=this.database.prepare('SELECT id FROM play_profiles WHERE deleted_at IS NULL').all() as {id:string}[];
      const requested=new Set(ids);
      if(live.length!==ids.length || live.some(profile=>!requested.has(profile.id)))throw new Error('프로필 목록이 변경되었습니다. 목록을 확인한 뒤 다시 순서를 바꿔 주세요.');
      const value=json(ids),existing=this.database.prepare('SELECT value FROM app_meta WHERE key=?').get(PROFILE_ORDER_KEY) as {value:string} | undefined;
      if(existing?.value===value)return;
      this.database.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PROFILE_ORDER_KEY,value);
    }).immediate();
  }

  /** 기존 기록은 미지정으로 보존. 신규 기록 출처만 같은 DB 연결의 context에서 확정한다. */
  ensureDiaryAttribution(): void {
    ensureDiaryAttribution(this.database,() => this.getRecordContext());
  }

  getRecordContext():DiaryRecordContext {return {...this.recordContext,deviceId:this.options.deviceId};}

  setRecordContext(profileId: string | null,sessionId: string | null): void {
    if (profileId !== null) this.requireProfile(profileId);
    this.recordContext = {profileId,sessionId};
  }

  withRecordContext<T>(profileId: string | null,sessionId: string | null,write: () => T): T {
    const previous = this.recordContext;
    this.setRecordContext(profileId,sessionId);
    try { return write(); } finally { this.recordContext = previous; }
  }
  withAutomaticSyncChange<T>(write:()=>T,automatic=true):T {
    const before=this.automaticSyncChange;this.automaticSyncChange=automatic;
    try {return write();} finally {this.automaticSyncChange=before;}
  }

  private requireProfile(id: string): PlayProfile {
    const profile = this.list().find(p => p.id === id);
    if (!profile) throw new Error('프로필을 찾을 수 없습니다.');
    return profile;
  }

  /** JSON(기기 설정)과 DB(플레이 설정)의 혼합 저장 중단을 복구한다. */
  private recoverConfigCommit(): void {
    const journalPath = path.join(this.options.directory,'app-data-config-write.json');
    if (!fs.existsSync(journalPath)) return;
    const journal = JSON.parse(fs.readFileSync(journalPath,'utf8')) as { version:number; commitId:string; before:string | null };
    if (journal.version !== 1 || typeof journal.commitId !== 'string'
      || (journal.before !== null && typeof journal.before !== 'string')) throw new Error('기기 설정 복구 기록이 올바르지 않습니다.');
    const committed = this.database.prepare("SELECT value FROM app_meta WHERE key='device_config_commit'").get() as {value:string} | undefined;
    if (committed?.value !== journal.commitId) {
      const file = path.join(this.options.directory,'config.json');
      if (journal.before !== null) writeAtomicText(file,journal.before);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.unlinkSync(journalPath);
  }

  readConfiguration(device: AppConfig): AppConfig {
    const profiles = this.list();
    const selected = profiles.find(p => p.id === device.activePlayProfileId)
      || profiles.find(p => p.id === 'profile-default') || profiles[0];
    if (!selected) throw new Error('프로필 저장소에 사용할 프로필이 없습니다.');
    const projected = this.project(selected.id,device);
    projected.activePlayProfileId = selected.id;
    projected.profileDeviceId = this.options.deviceId;
    delete projected.activityPresets;
    return projected;
  }

  /** config.ts의 commit 경계. DB/JSON 양쪽을 복구 journal로 보호하고 확정 projection을 반환한다. */
  commitConfiguration(next: AppConfig, previous: AppConfig,mutate?: (requested:AppConfig) => void,options?:{externalProjection?:boolean}): AppConfig {
    this.recoverConfigCommit();
    const configPath = path.join(this.options.directory,'config.json');
    const journalPath = path.join(this.options.directory,'app-data-config-write.json');
    const oldId = previous.activePlayProfileId || this.list()[0].id;
    next = clone(next);
    const nextId=next.activePlayProfileId || oldId;
    // 프로필/숙제만 바뀐 저장은 DB 안에서 끝낸다. 대기 이벤트 반영 transaction과 함께
    // rollback할 수 있고, 빈번한 자동 감지마다 기기 JSON을 다시 쓰지 않는다.
    if (!mutate && nextId===oldId && this.database.prepare("SELECT 1 FROM app_meta WHERE key='device_config_commit'").get()
      && isDeepStrictEqual(deviceConfigOnly(next),deviceConfigOnly(previous))) {
      this.database.transaction(() => this.saveProjection(oldId,next))();
      delete next.activityPresets;
      return next;
    }
    // 외부 transaction의 최종 commit 전에 JSON journal을 확정하면 두 원본이 갈라진다.
    if (this.database.inTransaction) throw new Error('기기 설정은 자동 기록 반영을 마친 뒤 변경해 주세요.');
    const before = fs.existsSync(configPath) ? fs.readFileSync(configPath,'utf8') : null;
    const commitId = randomUUID();
    writeAtomic(journalPath,{ version:1,commitId,before });
    let effective: AppConfig;
    try {
      effective = this.database.transaction(() => {
        mutate?.(next);
        const nextId = next.activePlayProfileId || oldId;
        this.requireProfile(nextId);
        // 전환 직전 debounce된 이전 캐릭터의 변경부터 저장한다.
        if (!options?.externalProjection && this.list().some(p => p.id === oldId)) this.saveProjection(oldId,{...next,activePlayProfileId:oldId});
        // 원격 반영은 이미 DB 원본을 갱신했다. 이전 메모리 projection을 역저장하지 않는다.
        const value = !options?.externalProjection && nextId === oldId ? clone(next) : this.project(nextId,next);
        value.activePlayProfileId = nextId;
        value.profileDeviceId = this.options.deviceId;
        delete value.activityPresets;
        if (value.profileSelectionRequired === false
          && (nextId !== oldId || previous.profileSelectionRequired !== false)) {
          this.markUsed(nextId);
        }
        this.database.prepare("INSERT INTO app_meta VALUES('device_config_commit',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(commitId);
        writeAtomic(configPath,deviceConfigOnly(value));
        return value;
      })();
    } catch (error) {
      // DB transaction은 rollback. JSON 교체만 완료된 경우 부팅과 같은 복구를 적용한다.
      this.recoverConfigCommit();
      throw error;
    }
    // commit 뒤 정리 실패는 다음 시작에서 확인할 수 있다. 확정 데이터를 취소하지 않는다.
    try { fs.unlinkSync(journalPath); } catch { /* durable journal로 재확인 */ }
    return effective;
  }

  removeAndCommitConfiguration(id:string,previous:AppConfig): AppConfig {
    return this.commitConfiguration(previous,previous,requested => {
      this.remove(id);
      if (previous.activePlayProfileId === id) {
        requested.activePlayProfileId = this.list()[0].id;
        requested.profileSelectionRequired = true;
      }
    });
  }

  setting(id: string, key: string): unknown {
    const row = this.database.prepare('SELECT value FROM profile_settings WHERE profile_id=? AND key=?').get(id,key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  private change(profileId: string | null, scope: string, field: string, operation: string, value: unknown): void {
    const clock = this.clock();
    const revisionKey = profileId || '';
    const prior = this.database.prepare('SELECT revision FROM profile_revisions WHERE scope=? AND profile_id=?').get(scope,revisionKey) as { revision: number } | undefined;
    const revision = prior?.revision || 0;
    const sequenceKey = `device-sequence:${this.options.deviceId}`;
    const sequenceRow = this.database.prepare('SELECT value FROM app_meta WHERE key=?').get(sequenceKey) as { value:string } | undefined;
    const sequence = Number(sequenceRow?.value || 0)+1;
    this.database.prepare('INSERT INTO app_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(sequenceKey,String(sequence));
    // 기능 계약 — 변경 이력은 항목(scope·프로필·필드)별 최신 행만 둔다.
    // Google 전송은 이 이력을 재생하지 않는다. 연결·병합은 원본 snapshot과 profile_sync_own(필드별 최신 셀)을 쓰고,
    // 이 이력은 전송 확인 경계(legacyBoundary: 이 PC의 최대 sequence)와 숙제 삭제 표식의 옛 근거로만 읽는다.
    // 같은 항목의 이전 행은 최신 행이 대신하므로 동기화를 연결하지 않은 PC나 계산기 값 전송이 계속 보류된 PC에서도
    // 이력이 항목 수 이상으로 늘지 않는다. 최대 sequence와 숙제 삭제 표식(아래 rememberDeletedHomework)은 바뀌지 않는다.
    // 회귀: check-profile-sync.ts(연결 전 변경 이력 압축 뒤 첫 연결).
    this.database.prepare('DELETE FROM profile_change_log WHERE scope=? AND profile_id IS ? AND field=?').run(scope,profileId,field);
    this.database.prepare('INSERT INTO profile_change_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),this.options.deviceId,sequence,profileId,scope,field,operation,json(value),
        clock.utcMs,clock.source,clock.uncertaintyMs,revision);
    this.database.prepare('INSERT INTO profile_revisions VALUES(?,?,?) ON CONFLICT(scope,profile_id) DO UPDATE SET revision=excluded.revision')
      .run(scope,revisionKey,revision+1);
    // 변경 이력은 전송 확인 뒤 정리된다. 숙제 삭제 사실은 기본 숙제 보충이 따를 영구 표식으로도 남긴다.
    if (scope==='homework' && operation==='delete' && profileId) rememberDeletedHomework(this.database,profileId,field);
  }
  private syncTransaction<T>(write:()=>T,profileId?:string):()=>T {
    return this.database.transaction(()=>{
      ++this.syncTransactionDepth;let result:T;
      try {result=write();} finally {--this.syncTransactionDepth;}
      if (!this.syncTransactionDepth) captureProfileSyncChanges(this.database,this.options.deviceId,this.clock(),this.automaticSyncChange,profileId);
      return result;
    });
  }

  get syncDeviceId():string {return this.options.deviceId;}
  syncClock():ProfileClockStamp {return this.clock();}

  /** 배포 기본 숙제의 누락만 보충한다. 기존 정의/상태/정렬·커스텀 숙제는 수정하지 않는다.
   * 빈 기본값으로 만든 과거 프로필과 백업/다른 PC에서 온 빈 목록을 복구한다.
   * 이 PC의 삭제와 반영한 원격 삭제는 profile_homework_deleted_items 표식으로 존중해 부활시키지 않는다.
   * 변경 이력은 전송 확인 뒤, 동기화 삭제 표식은 Google 계정 전환 때 정리되므로 그 근거만으로 판단하지 않는다.
   * 원본과 복구 전송 대기는 같은 transaction으로 확정한다.
   * 회귀: check-profile-homework-defaults.ts (실제 contents.json/부팅/별도 프로세스 재시작),
   * check-profile-sync-model.ts (전송 확인·계정 전환 뒤 삭제 유지). */
  ensureDefaultHomework():number {
    return this.withAutomaticSyncChange(()=>this.syncTransaction(()=>this.fillMissingDefaultHomework())());
  }
  /** 표식 도입 전 기록은 아직 남아 있는 변경 이력·동기화 삭제 표식에서 옮긴다(멱등).
   * 변경 이력은 항목별 최신 행만 남으므로 (scope,profile_id,field) 색인으로 숙제 행만 읽는다. */
  private backfillDeletedHomework():void {
    this.database.exec(`INSERT OR IGNORE INTO profile_homework_deleted_items SELECT profile_id,field FROM profile_change_log
        WHERE scope='homework' AND operation='delete' AND profile_id IS NOT NULL;
      INSERT OR IGNORE INTO profile_homework_deleted_items SELECT i.local_id,json_extract(t.key,'$[2]') FROM profile_sync_tombstones t
        JOIN profile_sync_ids i ON i.remote_id=json_extract(t.key,'$[1]')
        WHERE json_extract(t.key,'$[0]')='homework' AND json_extract(t.key,'$[3]')='deleted' AND json_type(t.key,'$[2]')='text';`);
  }
  private fillMissingDefaultHomework():number {
    const defaults=this.options.defaults.contentsCheckerItems || [];if (!defaults.length)return 0;
    this.backfillDeletedHomework();
    const deleted=new Map<string,Set<string>>();
    for(const row of this.database.prepare('SELECT profile_id,item_id FROM profile_homework_deleted_items').all() as {profile_id:string;item_id:string}[]) {
      if(!deleted.has(row.profile_id))deleted.set(row.profile_id,new Set());deleted.get(row.profile_id)!.add(row.item_id);
    }
    const insert=this.database.prepare('INSERT INTO profile_homework VALUES(?,?,?,?,?)');let count=0;
    for(const profile of this.list()) {
      const rows=this.database.prepare('SELECT item_id,position FROM profile_homework WHERE profile_id=?').all(profile.id) as {item_id:string;position:number}[];
      const present=new Set(rows.map(row=>row.item_id));let position=rows.reduce((max,row)=>Math.max(max,row.position),-1)+1;
      for(const item of defaults) {
        if(present.has(item.id) || deleted.get(profile.id)?.has(item.id))continue;
        const {completedState:_state,...definition}=item;
        insert.run(profile.id,item.id,json(definition),'{}',position++);
        this.change(profile.id,'homework',item.id,'create',{...definition,completedState:{[profile.id]:{}}});count++;
      }
    }
    return count;
  }

  ensureEmptyProfile():void {
    if (this.list().length) return;
    const id=randomUUID();
    this.database.prepare("INSERT INTO play_profiles(id,name,created_at) VALUES(?,'',?)").run(id,Date.now());
    for (const key of PROFILE_SETTING_KEYS) if (key!=='userServer' && this.options.defaults[key]!==undefined) {
      this.database.prepare('INSERT INTO profile_settings VALUES(?,?,?)').run(id,key,json(this.options.defaults[key]));
    }
    for (const [position,item] of (this.options.defaults.contentsCheckerItems || []).entries()) {
      const {completedState:_state,...definition}=item;
      this.database.prepare('INSERT INTO profile_homework VALUES(?,?,?,?,?)').run(id,item.id,json(definition),'{}',position);
    }
  }

  /** Google 가져오기에서 실제 사용자 데이터가 없는 기본 슬롯만 재사용한다. */
  isPristineProfilePlaceholder(id:string):boolean {
    const db=this.database;
    const profile=this.list().find(profile=>profile.id===id);
    if (!profile || profile.name || profile.userServer!==null || profile.lastUsedAt!==null) return false;
    if (this.hasPendingForProfile(id) || this.runtimeState(id) || Object.keys(this.toolValues(id)).length) return false;
    const projected=this.project(id,this.options.defaults);
    if (projected.pendingHomeworks?.length) return false;
    for (const key of PROFILE_SETTING_KEYS) {
      if (key==='userServer') continue;
      const value=projected[key],fallback=this.options.defaults[key];
      if (value===undefined && fallback===undefined) continue;
      if (value===undefined || fallback===undefined || !isDeepStrictEqual(JSON.parse(json(value)),JSON.parse(json(fallback)))) return false;
    }
    const defaults=(this.options.defaults.contentsCheckerItems || []).map(({completedState:_,...definition})=>({
      ...definition,completedState:{[id]:{}},
    }));
    // The rows have made a JSON round trip, which omits unset fields in the built-in defaults.
    return isDeepStrictEqual(projected.contentsCheckerItems,JSON.parse(json(defaults)));
  }

  create(name: string, userServer: number, copySettingsFrom?: string): PlayProfile {
    assertProfileName(name);
    if (!isProfileServer(userServer)) throw new Error('서버를 선택하세요.');
    const id = randomUUID();
    this.syncTransaction(() => {
      this.database.prepare('INSERT INTO play_profiles(id,name,created_at) VALUES(?,?,?)').run(id,name.trim(),Date.now());
      const base = copySettingsFrom ? this.project(this.requireProfile(copySettingsFrom).id, this.options.defaults) : this.options.defaults;
      for (const key of PROFILE_SETTING_KEYS) if (base[key] !== undefined) {
        this.database.prepare('INSERT INTO profile_settings VALUES(?,?,?)').run(id,key,json(base[key]));
      }
      this.database.prepare('INSERT INTO profile_settings VALUES(?,?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value=excluded.value')
        .run(id,'userServer',json(userServer));
      // 설정 가져오기는 숙제 정의/커스텀/숨김/정렬/N/A도 복사한다. 완료 횟수·시각은 복사하지 않는다.
      // 원본에서 삭제한 기본 항목은 새 프로필의 복구 및 다른 PC 수신에도 부활하지 않게 표시한다.
      // 회귀: check-profile-homework-defaults.ts, check-profiles-ui.ts, check-profile-storage.ts.
      const homework=base.contentsCheckerItems || [];
      for (const [position,item] of homework.entries()) {
        const { completedState: _state, ...definition } = item;
        const state=copySettingsFrom && item.completedState[copySettingsFrom]?.isExcluded===true ? {isCompleted:false,isExcluded:true} : {};
        this.database.prepare('INSERT INTO profile_homework VALUES(?,?,?,?,?)').run(id,item.id,json(definition),json(state),position);
      }
      if (copySettingsFrom) for (const item of this.options.defaults.contentsCheckerItems || []) {
        if (homework.some(existing=>existing.id===item.id)) continue;
        rememberProfileHomeworkDeletion(this.database,id,item.id);
        this.change(id,'homework',item.id,'delete',null);
      }
      this.change(id,'profile','metadata','create',{ name:name.trim(),userServer });
      this.change(id,'profile','settings','set',Object.fromEntries(PROFILE_SETTING_KEYS.map(k => [k,this.setting(id,k)])));
      if (copySettingsFrom) for (const [key,value] of Object.entries(this.toolValues(copySettingsFrom))) this.writeToolValue(id,key,value);
      for (const item of this.homework(id)) this.change(id,'homework',item.id,'create',item);
    })();
    return this.requireProfile(id);
  }

  update(id: string, name?: string, userServer?: number): void {
    if (name!==undefined) assertProfileName(name);
    if (userServer!==undefined && !isProfileServer(userServer)) throw new Error('서버를 선택하세요.');
    this.syncTransaction(() => {
      const current=this.requireProfile(id);
      const nextName=name?.trim() ?? current.name;
      const nextServer=userServer ?? current.userServer;
      if (nextName===current.name && nextServer===current.userServer) return;
      if (nextName!==current.name) this.database.prepare('UPDATE play_profiles SET name=? WHERE id=?').run(nextName,id);
      if (nextServer!==current.userServer) {
        this.database.prepare('INSERT INTO profile_settings VALUES(?,?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value=excluded.value')
          .run(id,'userServer',json(nextServer));
      }
      this.change(id,'profile','metadata','set',{name:nextName,userServer:nextServer});
    })();
  }

  remove(id: string): void {
    this.syncTransaction(() => {
      this.requireProfile(id);
      this.database.prepare('UPDATE play_profiles SET deleted_at=? WHERE id=?').run(Date.now(),id);
      this.database.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(id);
      this.database.prepare("DELETE FROM profile_settings WHERE profile_id=? AND key<>'userServer'").run(id);
      this.database.prepare('DELETE FROM profile_local_state WHERE profile_id=?').run(id);
      this.database.prepare('DELETE FROM profile_runtime_events WHERE profile_id=?').run(id);
      this.database.prepare('DELETE FROM profile_runtime_state WHERE profile_id=?').run(id);
      this.database.prepare('DELETE FROM profile_tools WHERE profile_id=?').run(id);
      this.change(id,'profile','metadata','delete',null);
      if (!this.list().length) {
        const blankId = randomUUID();
        this.database.prepare("INSERT INTO play_profiles(id,name,created_at) VALUES(?,'',?)").run(blankId,Date.now());
        for (const key of PROFILE_SETTING_KEYS) {
          if (key !== 'userServer' && this.options.defaults[key] !== undefined) {
            this.database.prepare('INSERT INTO profile_settings VALUES(?,?,?)').run(blankId,key,json(this.options.defaults[key]));
          }
        }
        for (const [position,item] of (this.options.defaults.contentsCheckerItems || []).entries()) {
          const { completedState: _state, ...definition } = item;
          this.database.prepare('INSERT INTO profile_homework VALUES(?,?,?,?,?)').run(blankId,item.id,json(definition),'{}',position);
        }
      }
    })();
  }

  lastUsedProfileSetting(key:string, projectedId:string | undefined): unknown {
    const profile=this.database.prepare('SELECT id,deleted_at FROM play_profiles WHERE last_used_at IS NOT NULL ORDER BY last_used_at DESC,id LIMIT 1')
      .get() as {id:string;deleted_at:number | null} | undefined;
    if (profile) return profile.deleted_at===null ? this.setting(profile.id,key) : null;
    // v3.2.2에서 이전한 사용자의 알림 설정도 첫 프로필 선택 전부터 존중한다.
    const migrated=this.database.prepare(`SELECT 1 FROM legacy_character_profiles l JOIN play_profiles p ON p.id=l.profile_id
      WHERE l.profile_id=? AND p.deleted_at IS NULL`).get(projectedId ?? '');
    return migrated && projectedId ? this.setting(projectedId,key) : null;
  }

  markUsed(id: string): void {
    const profile = this.requireProfile(id);
    if (!profile.name.trim() || !isProfileServer(profile.userServer)) throw new Error('이름과 서버를 먼저 설정하세요.');
    this.database.prepare('UPDATE play_profiles SET last_used_at=? WHERE id=?').run(Date.now(),id);
  }

  runtimeState(id:string):unknown {
    this.requireProfile(id);
    const row=this.database.prepare('SELECT value FROM profile_runtime_state WHERE profile_id=?').get(id) as {value:string} | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  /** 완료된 HUD 입력은 해당 프로필의 다음 스냅샷과 함께 한 번만 정리한다. */
  saveRuntimeState(id:string,value:unknown):void {
    this.requireProfile(id);
    this.database.transaction(() => {
      this.database.prepare('INSERT INTO profile_runtime_state VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET value=excluded.value').run(id,json(value));
      this.database.prepare('DELETE FROM profile_runtime_events WHERE profile_id=?').run(id);
    })();
  }

  stageRuntimeEvent(profileId:string,eventId:string):void {
    this.database.prepare('INSERT INTO profile_runtime_events(event_id,profile_id) VALUES(?,?)').run(eventId,profileId);
  }

  pendingRuntimeEvents(id:string):unknown[] {
    return (this.database.prepare(`SELECT e.payload FROM profile_runtime_events r JOIN pending_profile_events e ON e.event_id=r.event_id
      WHERE r.profile_id=? ORDER BY r.sequence`).all(id) as {payload:string}[]).map(row=>JSON.parse(row.payload));
  }

  /** 도구 입력의 원본. 소유자가 삭제되면 새 입력은 거부하며 실제 변경만 outbox에 넣는다.
   * 최초 이전은 사용자 저장값을 각 이전 프로필로 한 번 복사한다. force는 구형 백업의
   * 전체 도구 snapshot 복원에만 사용한다. 회귀: check-profile-tools.ts, check-profile-backup.ts. */
  toolValues(id:string):Record<string,string> {
    this.requireProfile(id);
    return Object.fromEntries((this.database.prepare('SELECT key,value FROM profile_tools WHERE profile_id=?').all(id) as {key:string;value:string}[]).filter(row => isProfileToolKey(row.key)).map(row => [row.key,row.value]));
  }
  saveToolValue(id:string,key:unknown,value:unknown):void {
    this.requireProfile(id);
    if (!isProfileToolKey(key)) throw new Error('지원하지 않는 계산기 저장 값입니다.');
    if (value!==null && !isSyncableProfileToolValue(value)) throw new Error('계산기 프리셋이 저장 한도를 초과했습니다. 기존 값은 보존했습니다.');
    this.writeToolValue(id,key,value);
  }

  /** 이전 파일에서 온 큰 도구 값도 로컬에는 보존한다. 동기화에 넣을 값은 원본 계산에서 검사한다. */
  private writeToolValue(id:string,key:string,value:string | null):void {
    this.syncTransaction(() => {
      const previous=this.database.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(id,key) as {value:string} | undefined;
      if ((previous?.value ?? null)===value) return;
      if (value===null) this.database.prepare('DELETE FROM profile_tools WHERE profile_id=? AND key=?').run(id,key);
      else this.database.prepare('INSERT INTO profile_tools VALUES(?,?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value=excluded.value').run(id,key,value);
      this.change(id,'profile-tool',key,value===null ? 'delete' : 'set',value);
    },id)();
  }
  migrateToolValues(values:Record<string,string | null>,force=false,profileIds?:ReadonlySet<string>):void {
    if (!force && this.database.prepare("SELECT 1 FROM app_meta WHERE key='legacy_profile_tools_migrated'").get()) return;
    this.syncTransaction(() => {
      const profiles=this.list().filter(profile=>!profileIds || profileIds.has(profile.id));
      for (const profile of profiles) for (const key of PROFILE_TOOL_KEYS) {
        if (force || values[key]!==undefined && values[key]!==null) this.writeToolValue(profile.id,key,values[key] ?? null);
      }
      this.database.prepare("INSERT OR REPLACE INTO app_meta VALUES('legacy_profile_tools_migrated','1')").run();
    })();
  }

  /** 구형 설정 백업의 다중 캐릭터를 복원한다. 기존 ID 매핑은 재사용하고
   * 백업에 없는 현재 프로필과 그 프리셋은 보존한다.
   * 백업 staging 연결에서만 호출하며 활성 프로필/JSON은 호출자가 함께 교체한다. */
  restoreLegacyConfiguration(legacy:AppConfig,storedServer:unknown):{selectedId:string;profileIds:ReadonlySet<string>} {
    return this.syncTransaction(() => {
      const characters=legacy.characterPresets?.length ? legacy.characterPresets : [{id:'',name:''}];
      if (characters.some(character => typeof character.id!=='string' || typeof character.name!=='string')) throw new Error('백업의 캐릭터 정보가 올바르지 않습니다.');
      if (new Set(characters.map(character => character.id)).size!==characters.length) throw new Error('백업의 캐릭터 ID가 중복되었습니다.');
      const selected=characters.find(character => character.id===legacy.selectedCharacterId) || characters[0];
      const ordered=[selected,...characters.filter(character => character!==selected)];
      // 복원한 v3.2.2 설정의 PC별 값도 이전 값으로 인정한다(동기화의 이전 값 자동 병합 근거).
      rememberLegacyDeviceLocalOriginals(this.database,legacy);
      const restored=new Set<string>();let first='';
      for (const character of ordered) {
        const mapped=this.database.prepare('SELECT profile_id FROM legacy_character_profiles WHERE character_id=?').get(character.id) as {profile_id:string} | undefined;
        const existing=this.list().find(profile => profile.id===mapped?.profile_id && !restored.has(profile.id))
          || this.list().find(profile => !profile.name && !restored.has(profile.id));
        const id=existing?.id || randomUUID();
        if (!existing) this.database.prepare('INSERT INTO play_profiles(id,name,created_at) VALUES(?,?,?)').run(id,character.name,Date.now());
        else this.database.prepare('UPDATE play_profiles SET name=? WHERE id=?').run(character.name,id);
        restored.add(id);first ||= id;
        if (character.id) this.database.prepare('INSERT INTO legacy_character_profiles VALUES(?,?) ON CONFLICT(character_id) DO UPDATE SET profile_id=excluded.profile_id').run(character.id,id);
        const projected={...clone(legacy),characterPresets:[{id,name:character.name}],selectedCharacterId:id,
          pendingHomeworks:[],
          contentsCheckerItems:(legacy.contentsCheckerItems || []).map(item => ({...item,completedState:{[id]:clone(item.completedState?.[character.id] || {})}}))};
        if (!isProfileServer(storedServer)) delete projected.userServer;
        this.saveProjection(id,projected);
        this.change(id,'profile','metadata','set',{name:character.name,userServer:projected.userServer});
      }
      // 최초 이전과 같은 변환을 쓴다. 시각이 손상된 항목도 고정 시각으로 보존해 재복원 시 같은 행이 된다.
      for (const pending of legacyPendingHomeworkEvents(legacy.pendingHomeworks)) {
        if (this.database.prepare('SELECT 1 FROM pending_profile_events WHERE payload=? LIMIT 1').get(json(pending.payload))) continue;
        const eventId=`legacy-backup:${createHash('sha256').update(json(pending.payload.value) ?? 'null').digest('hex')}`;
        this.enqueue('legacy-backup-homework',pending.payload,pending.occurredAt,eventId);
      }
      return {selectedId:first,profileIds:restored};
    })();
  }

  project(id: string, deviceConfig: AppConfig): AppConfig {
    const profile = this.requireProfile(id);
    const result = { ...clone(this.options.defaults), ...clone(deviceConfigOnly(deviceConfig)) } as AppConfig;
    const settings = this.database.prepare('SELECT key,value FROM profile_settings WHERE profile_id=?').all(id) as { key: string; value: string }[];
    const shared = this.database.prepare('SELECT key,value FROM shared_settings').all() as { key: string; value: string }[];
    for (const row of [...shared,...settings]) (result as unknown as Record<string,unknown>)[row.key] = JSON.parse(row.value);
    // 서버 저장값이 없으면 기본 서버를 선택 완료로 간주하지 않는다.
    if (!isProfileServer(profile.userServer)) delete result.userServer;
    result.characterPresets = [{ id, name: profile.name || '기본 프로필' }];
    result.selectedCharacterId = id;
    result.contentsAutoAssignSingleCandidate = true;
    result.contentsCheckerItems = this.homework(id);
    const state = this.database.prepare('SELECT value FROM profile_local_state WHERE profile_id=?').get(id) as { value: string } | undefined;
    result.pendingHomeworks = state ? JSON.parse(state.value).pendingHomeworks || [] : [];
    result.lastContentsResetCheck = state ? JSON.parse(state.value).lastContentsResetCheck : undefined;
    return result;
  }

  homework(id: string): ContentsCheckerItem[] {
    this.requireProfile(id);
    const rows = this.database.prepare('SELECT * FROM profile_homework_progress WHERE profile_id=? ORDER BY position,item_id').all(id) as HomeworkRow[];
    return rows.map(row => ({...JSON.parse(row.definition),completedState:{[id]:{
      ...JSON.parse(row.state),...(row.expires_at===null ? {} : {progressExpiresAt:row.expires_at}),
    }}}));
  }

  /** 저장 호출자는 전체 projection을 제공한다. 변경 이력은 다른 값에만 생성한다. */
  saveProjection(id: string, config: AppConfig): void {
    this.syncTransaction(() => {
      this.requireProfile(id);
      if (config.characterPresets?.length !== 1 || config.characterPresets[0].id !== id || config.selectedCharacterId !== id) {
        throw new Error('현재 프로필과 다른 캐릭터의 설정은 저장할 수 없습니다.');
      }
      for (const key of PROFILE_SETTING_KEYS) {
        const value = config[key];
        if (key === 'userServer' && value !== undefined && !isProfileServer(value)) throw new Error('서버 값이 올바르지 않습니다.');
        const prior = this.setting(id,key);
        if (json(prior) === json(value ?? null)) continue;
        if (value === undefined) this.database.prepare('DELETE FROM profile_settings WHERE profile_id=? AND key=?').run(id,key);
        else this.database.prepare('INSERT INTO profile_settings VALUES(?,?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value=excluded.value').run(id,key,json(value));
        this.change(id,'profile',key,value === undefined ? 'delete' : 'set',value ?? null);
      }
      for (const key of SHARED_SETTING_KEYS) {
        const value = config[key];
        const prior = this.database.prepare('SELECT value FROM shared_settings WHERE key=?').get(key) as { value: string } | undefined;
        if ((prior?.value ?? 'null') === json(value ?? null)) continue;
        if (value === undefined) this.database.prepare('DELETE FROM shared_settings WHERE key=?').run(key);
        else this.database.prepare('INSERT INTO shared_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,json(value));
        this.change(null,'shared',key,value === undefined ? 'delete' : 'set',value ?? null);
      }
      const previous = this.homework(id);
      if (json(previous) !== json(config.contentsCheckerItems || [])) {
        const previousMap = new Map(previous.map((item,position) => [item.id,{item,position}]));
        const items = config.contentsCheckerItems || [];
        if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('숙제 ID가 중복되었습니다.');
        const saveItem=this.database.prepare(`INSERT INTO profile_homework VALUES(?,?,?,?,?)
          ON CONFLICT(profile_id,item_id) DO UPDATE SET definition=excluded.definition,state=excluded.state,position=excluded.position`);
        const clearExpiry=this.database.prepare('DELETE FROM profile_homework_expiry WHERE profile_id=? AND item_id=?');
        for (const [position,item] of items.entries()) {
          const old=previousMap.get(item.id);
          previousMap.delete(item.id);
          if (old?.position===position && json(old.item)===json(item)) continue;
          const { completedState, ...definition } = item;
          const state: HomeworkState | undefined = completedState?.[id];
          const {progressExpiresAt,...legacyState}=state || {};
          saveItem.run(id,item.id,json(definition),json(legacyState),position);
          if (state?.lastCompletedAt!==undefined && progressExpiresAt!==undefined) {
            saveHomeworkExpiry(this.database,id,item.id,state.lastCompletedAt,progressExpiresAt);
          } else clearExpiry.run(id,item.id);
          this.change(id,'homework',item.id,'set',{definition,state:legacyState,position});
        }
        const removeItem=this.database.prepare('DELETE FROM profile_homework WHERE profile_id=? AND item_id=?');
        for (const removed of previousMap.keys()) {
          removeItem.run(id,removed);
          this.change(id,'homework',removed,'delete',null);
        }
      }
      this.database.prepare(`INSERT INTO profile_local_state VALUES(?,?) ON CONFLICT(profile_id)
        DO UPDATE SET value=excluded.value WHERE value<>excluded.value`)
        .run(id,json({ pendingHomeworks:config.pendingHomeworks || [],lastContentsResetCheck:config.lastContentsResetCheck }));
    },id)();
  }

  eventRecordState(eventId:string):{sessionId:string;profileId:string | null;resolved:boolean} | undefined {
    const row=this.database.prepare(`SELECT session_id,assigned_profile_id,resolved_at FROM pending_profile_events WHERE event_id=?
      UNION ALL SELECT session_id,assigned_profile_id,resolved_at FROM profile_event_receipts WHERE event_id=? LIMIT 1`)
      .get(eventId,eventId) as {session_id:string;assigned_profile_id:string | null;resolved_at:number | null} | undefined;
    return row && {sessionId:row.session_id,profileId:row.assigned_profile_id,resolved:row.resolved_at!==null};
  }

  hasEvent(eventId:string):boolean {return !!this.database.prepare('SELECT 1 FROM pending_profile_events WHERE event_id=? UNION ALL SELECT 1 FROM profile_event_receipts WHERE event_id=? LIMIT 1').get(eventId,eventId);}

  /** 완료 후 30일이 지난 원문만 줄이고 재시도 검증용 영수증은 유지한다. 미배정은 삭제하지 않는다.
   * 일지·숙제에 남지 않는 이벤트(profileLogSource의 보관 범위 계약)는 영수증을 만들지 않고 그 줄만의 귀속도 놓는다.
   * 같은 호출에서 보관 기간 밖 증거를 제한된 개수만 정리한다(pruneProfileEventEvidence). 회귀: check-profile-storage.ts. */
  compactResolvedEvents(now=Date.now()):number {
    return this.database.transaction(()=>{
      const rows=this.database.prepare('SELECT * FROM pending_profile_events WHERE resolved_at IS NOT NULL AND resolved_at<? AND NOT EXISTS (SELECT 1 FROM profile_runtime_events r WHERE r.event_id=pending_profile_events.event_id) LIMIT 1000').all(now-30*86400000) as {event_id:string;session_id:string;occurred_at:number;payload:string;assigned_profile_id:string | null;resolved_at:number}[];
      const insert=this.database.prepare('INSERT INTO profile_event_receipts VALUES(?,?,?,?,?,?)'),remove=this.database.prepare('DELETE FROM pending_profile_events WHERE event_id=?');
      for (const row of rows) {
        let payload:unknown;
        try {payload=JSON.parse(row.payload);} catch {payload=undefined;}
        remove.run(row.event_id);
        if (payload===undefined || isDurableProfileEvent(payload)) insert.run(row.event_id,row.session_id,row.occurred_at,createHash('sha256').update(row.payload).digest('hex'),row.assigned_profile_id,row.resolved_at);
        else this.releaseTransientLine((payload as {source?:ProfileLogSource}).source?.lineKey);
      }
      this.pruneProfileEventEvidence();
      return rows.length;
    })();
  }

  /** 기록이 남지 않는 이벤트만 있던 실시간 줄의 귀속을 놓는다. 같은 줄의 다른 대기/영수증이 남아 있으면
   * 그 이벤트가 기록일 수 있으므로 보존한다. 복원으로 확정한 귀속(live=0)과 무시 표식도 보존한다. */
  private releaseTransientLine(lineKey:unknown):void {
    if (typeof lineKey!=='string' || !/^[a-f0-9]{64}$/.test(lineKey)) return;
    const pattern=`live-line:${lineKey}:*`;
    if (this.database.prepare(`SELECT 1 FROM pending_profile_events WHERE event_id GLOB ?
      UNION ALL SELECT 1 FROM profile_event_receipts WHERE event_id GLOB ? LIMIT 1`).get(pattern,pattern)) return;
    this.database.prepare('DELETE FROM profile_log_line_owners WHERE line_key=? AND live=1').run(Buffer.from(lineKey,'hex'));
  }

  /**
   * 원본 줄 귀속·완료 영수증의 보관 기간 정리. 압축과 같은 호출에서 한 번에 제한된 개수만 지운다.
   * - 모험일지가 실제로 정리한 날짜(cleanOldDiaryData의 activity_pruned_before, diaryKeepDays>0일 때만 생김)보다
   *   이전 줄 귀속과 그 이전에 발생한 영수증은 지운다. 그 날짜의 일지 행이 없으므로 다시 기록돼도 이중 집계가 아니며
   *   다음 정리에서 함께 지워진다. 영구 보관(diaryKeepDays=0)이면 이 기준이 없어 지우지 않는다. 사용자 무시 표식은 보존한다.
   * - 이 계약 이전에 쌓인 기록 없는 경험치·진행 전용 영수증은 rowid 커서로 한 번 훑어 지운다. 경험치는 같은 줄의
   *   일지 행(diary_live_activity_events, 경험의 정수 교환)이 없을 때만 기록 없는 줄로 본다. 획득은 판단할 수 없어 보존한다.
   */
  private pruneProfileEventEvidence(limit=5000):void {
    const table=(name:string)=>!!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const prunedBefore=table('diary_profile_meta')
      ? (this.database.prepare("SELECT value FROM diary_profile_meta WHERE key='activity_pruned_before'").get() as {value:string} | undefined)?.value : undefined;
    if (prunedBefore && /^\d{4}-\d{2}-\d{2}$/.test(prunedBefore)) {
      // 줄 귀속은 같은 기준 날짜로 한 번 끝까지 지우면 다시 훑지 않는다. 남겨 두는 무시 표식(NULL, live=0)을
      // 압축 주기마다 다시 범위 탐색하지 않기 위해서다. 새 귀속은 기준 날짜 이후 줄에만 생기고, 기준은 일지 정리 때 바뀐다.
      const ownersDoneKey='profile_line_owner_pruned_before';
      const ownersDone=(this.database.prepare('SELECT value FROM app_meta WHERE key=?').get(ownersDoneKey) as {value:string} | undefined)?.value;
      if (ownersDone!==prunedBefore) {
        const removed=this.database.prepare(`DELETE FROM profile_log_line_owners WHERE rowid IN (SELECT rowid FROM profile_log_line_owners
          WHERE log_date<? AND NOT (profile_id IS NULL AND live=0) LIMIT ?)`).run(prunedBefore,limit).changes;
        if (removed<limit) this.database.prepare('INSERT INTO app_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(ownersDoneKey,prunedBefore);
      }
      const cutoff=new Date(`${prunedBefore}T00:00:00`).getTime();
      if (Number.isFinite(cutoff)) this.database.prepare(`DELETE FROM profile_event_receipts WHERE rowid IN (
        SELECT rowid FROM profile_event_receipts WHERE occurred_at<? LIMIT ?)`).run(cutoff,limit);
    }
    const cursorKey='profile_event_receipt_backfill_rowid';
    const cursor=(this.database.prepare('SELECT value FROM app_meta WHERE key=?').get(cursorKey) as {value:string} | undefined)?.value;
    // 일지 연결과 이벤트 판단 등록 전에는 판단 근거가 없으므로 커서를 진행하지 않는다.
    if (cursor==='done' || !hasProfileEventDurability() || !table('diary_live_activity_events')) return;
    const liveActivity=this.database.prepare('SELECT 1 FROM diary_live_activity_events WHERE line_key=? LIMIT 1');
    const rows=this.database.prepare('SELECT rowid AS rowId,event_id AS id FROM profile_event_receipts WHERE rowid>? ORDER BY rowid LIMIT ?')
      .all(Number(cursor) || 0,limit) as {rowId:number;id:string}[];
    const remove=this.database.prepare('DELETE FROM profile_event_receipts WHERE rowid=?');
    for (const row of rows) {
      const match=/^live-line:([a-f0-9]{64}):([A-Z_]+):\d+$/.exec(row.id);
      if (!match) continue;
      const [,lineKey,event]=match;
      const transient=event==='XP_CHANGED' ? !liveActivity.get(lineKey)
        : event!=='ITEM_LOOTED' && profileEventDurabilityByName(event)===false;
      if (!transient) continue;
      remove.run(row.rowId);
      this.releaseTransientLine(lineKey);
    }
    this.database.prepare('INSERT INTO app_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(cursorKey,rows.length<limit ? 'done' : String(rows.at(-1)!.rowId));
  }

  hasPendingForProfile(id:string):boolean {
    return !!this.database.prepare('SELECT 1 FROM pending_profile_events WHERE resolved_at IS NULL AND assigned_profile_id=? LIMIT 1').get(id);
  }

  enqueue(sessionId: string, payload: unknown, occurredAt: number, eventId: string = randomUUID(),profileId:string | null=null): string {
    if (!sessionId || !Number.isFinite(occurredAt)) throw new Error('대기 기록 정보가 올바르지 않습니다.');
    const receipt=this.database.prepare('SELECT session_id,occurred_at,payload_hash FROM profile_event_receipts WHERE event_id=?').get(eventId) as {session_id:string;occurred_at:number;payload_hash:string} | undefined;
    if (receipt) {
      if (receipt.session_id!==sessionId || receipt.occurred_at!==occurredAt || receipt.payload_hash!==createHash('sha256').update(json(payload)).digest('hex')) throw new Error('같은 이벤트 ID에 서로 다른 대기 기록이 있습니다.');
      return eventId;
    }
    const existing = this.database.prepare('SELECT session_id,payload,occurred_at FROM pending_profile_events WHERE event_id=?').get(eventId) as
      {session_id:string;payload:string;occurred_at:number} | undefined;
    if (existing && (existing.session_id !== sessionId || existing.payload !== json(payload) || existing.occurred_at !== occurredAt)) {
      throw new Error('같은 이벤트 ID에 서로 다른 대기 기록이 있습니다.');
    }
    // 이미 선택된 프로필의 실패/대기 입력도 재시도 때 같은 소유자만 처리한다.
    this.database.prepare('INSERT OR IGNORE INTO pending_profile_events(event_id,session_id,occurred_at,payload,assigned_profile_id) VALUES(?,?,?,?,?)')
      .run(eventId,sessionId,occurredAt,json(payload),profileId);
    return eventId;
  }

  pending(sessionId?: string): { eventId: string; sessionId: string; occurredAt: number; payload: unknown }[] {
    const rows = this.database.prepare(`SELECT * FROM pending_profile_events WHERE resolved_at IS NULL ${sessionId ? 'AND session_id=?' : ''} ORDER BY occurred_at,rowid`)
      .all(...(sessionId ? [sessionId] : [])) as { event_id: string; session_id: string; occurred_at: number; payload: string }[];
    return rows.map(r => ({ eventId:r.event_id,sessionId:r.session_id,occurredAt:r.occurred_at,payload:JSON.parse(r.payload) }));
  }

  pendingSessions(): Array<{sessionId:string;count:number;firstOccurredAt:number;lastOccurredAt:number}> {
    return (this.database.prepare(`SELECT session_id,COUNT(*) AS count,MIN(occurred_at) AS first,MAX(occurred_at) AS last
      FROM pending_profile_events INDEXED BY idx_pending_profile_session_time WHERE resolved_at IS NULL
      GROUP BY session_id ORDER BY first,session_id`)
      .all() as {session_id:string;count:number;first:number;last:number}[]).map(row => ({sessionId:row.session_id,count:row.count,firstOccurredAt:row.first,lastOccurredAt:row.last}));
  }

  pendingSessionSnapshot(sessionId:string):{token:string;count:number;firstOccurredAt:number;lastOccurredAt:number} | null {
    const hash=createHash('sha256');let count=0,firstOccurredAt=Infinity,lastOccurredAt=-Infinity;
    const rows=this.database.prepare('SELECT event_id,occurred_at,payload,assigned_profile_id FROM pending_profile_events WHERE session_id=? AND resolved_at IS NULL ORDER BY rowid').iterate(sessionId) as Iterable<{event_id:string;occurred_at:number;payload:string;assigned_profile_id:string | null}>;
    for(const row of rows) {
      hash.update(json([row.event_id,row.occurred_at,row.payload,row.assigned_profile_id]));++count;
      firstOccurredAt=Math.min(firstOccurredAt,row.occurred_at);lastOccurredAt=Math.max(lastOccurredAt,row.occurred_at);
    }
    return count ? {token:hash.digest('hex'),count,firstOccurredAt,lastOccurredAt} : null;
  }

  private saveIgnoredLogExclusions(where:string,params:string[]=[]):void {
    const rows=this.database.prepare(`SELECT payload FROM pending_profile_events WHERE ${where}`).all(...params) as {payload:string}[];
    for (const {payload} of rows) {
      const value=JSON.parse(payload) as {source?:ProfileLogSource;data?:{date:string}} | null;
      if (value?.source && typeof value.data?.date==='string') excludeIgnoredProfileLog(this.database,value.data.date,value.source);
    }
  }

  /** 명시적으로 확인한 과거 대기 집합만 무시한다. 원문을 삭제하거나 숙제/일지/프로필에 적용하지 않는다.
   * 확인 중 새 기록·같은 개수의 다른 원문으로 바뀌면 전체 실패한다. 반복 요청은 이미 처리한 경우 0건이다.
   * resolved_at + 배정 대상 null로 보관해 재시작/동일 ID 재수신에도 다시 대기하지 않으며, 기존 30일 이후
   * 원문 압축은 해시 영수증을 남긴다. 같은 트랜잭션에서 채팅 원본도 복원 제외 대상으로 보관한다.
   * 회귀: check-profile-storage.ts, check-profiles-ui.ts, check-profile-log-restore.ts. */
  ignorePendingSession(sessionId:string,snapshotToken:string):number {
    if(!sessionId || !/^[a-f0-9]{64}$/.test(snapshotToken))throw new Error('대기 기록을 다시 확인해 주세요.');
    return this.database.transaction(()=>{
      const current=this.pendingSessionSnapshot(sessionId);
      if(!current)return 0;
      if(current.token!==snapshotToken)throw new Error('대기 기록이 변경되었습니다. 내용을 다시 확인한 뒤 무시해 주세요.');
      this.saveIgnoredLogExclusions('session_id=? AND resolved_at IS NULL',[sessionId]);
      return this.database.prepare('UPDATE pending_profile_events SET assigned_profile_id=NULL,resolved_at=? WHERE session_id=? AND resolved_at IS NULL').run(Date.now(),sessionId).changes;
    }).immediate();
  }

  releaseOrphanedPendingSession(sessionId:string,snapshotToken:string):number {
    return this.database.transaction(()=>{
      if (this.pendingSessionSnapshot(sessionId)?.token!==snapshotToken) throw new Error('대기 기록이 변경되었습니다. 다시 확인해 주세요.');
      return this.database.prepare(`UPDATE pending_profile_events SET assigned_profile_id=NULL
        WHERE session_id=? AND resolved_at IS NULL AND assigned_profile_id IN (SELECT id FROM play_profiles WHERE deleted_at IS NOT NULL)`).run(sessionId).changes;
    }).immediate();
  }

  /** apply는 같은 DB 연결을 사용한다. false인 항목은 대기에 남기고, 예외면 반영과 ACK를 함께 취소한다. */
  assignPending(sessionId: string, profileId: string, apply:ApplyPending,snapshotToken?:string,includeUnassigned=true,includeLive=true): number {
    const assign=this.database.transaction(() => {
      this.requireProfile(profileId);
      if (snapshotToken!==undefined && this.pendingSessionSnapshot(sessionId)?.token!==snapshotToken) {
        throw new Error('대기 기록이 변경되었습니다. 내용을 다시 확인한 뒤 배정해 주세요.');
      }
      const rows=this.database.prepare(`SELECT rowid AS rowId,occurred_at AS time,event_id,payload,assigned_profile_id FROM pending_profile_events
        WHERE session_id=? AND resolved_at IS NULL AND (assigned_profile_id=? OR ? AND assigned_profile_id IS NULL)
        AND (? OR event_id NOT GLOB 'live:*' AND event_id NOT GLOB 'live-line:*')
        ORDER BY occurred_at,rowid`).all(sessionId,profileId,+includeUnassigned,+includeLive) as PendingRow[];
      return this.applyPendingRows(rows,profileId,apply).assigned;
    });
    return snapshotToken===undefined ? assign() : assign.immediate();
  }

  nextOwnedLiveRecord(session:string,profileId:string,group:LiveRecordGroup):string | undefined {
    const row=this.database.prepare(`SELECT event_id AS id
      FROM pending_profile_events WHERE session_id=? AND assigned_profile_id=? AND resolved_at IS NULL
      AND (event_id GLOB 'live:*' OR event_id GLOB 'live-line:*')
      AND CASE json_extract(payload,'$.event')
        WHEN 'SEED_GAINED' THEN 'seed'
        WHEN 'XP_CHANGED' THEN 'experience'
        WHEN 'NORMAL_CHAT' THEN 'experience'
        ELSE 'profile' END=? ORDER BY occurred_at,rowid LIMIT 1`)
      .get(session,profileId,group) as {id:string} | undefined;
    return row?.id;
  }

  assignOwnedLiveRecord(session:string,profileId:string,id:string,apply:ApplyPending):number {
    return this.database.transaction(()=>{
      const row=this.database.prepare(`SELECT rowid AS rowId,occurred_at AS time,event_id,payload,assigned_profile_id
        FROM pending_profile_events WHERE event_id=? AND session_id=? AND assigned_profile_id=? AND resolved_at IS NULL`)
        .get(id,session,profileId) as PendingRow | undefined;
      return row ? this.applyPendingRows([row],profileId,apply).assigned : 0;
    })();
  }

  pendingReplayBoundary(sessionId:string,profileId:string,includeUnassigned:UnassignedReplayScope):{lastRowId:number;count:number} {
    return this.database.prepare(`SELECT COALESCE(MAX(rowid),0) AS lastRowId,COUNT(*) AS count
      FROM pending_profile_events WHERE session_id=? AND resolved_at IS NULL
      AND (assigned_profile_id=? OR assigned_profile_id IS NULL AND rowid>? AND rowid<=?)`)
      .get(sessionId,profileId,...unassignedRowBounds(includeUnassigned)) as {lastRowId:number;count:number};
  }

  /** 확인한 원본 범위 안에서만 적용한다. 배정이 거부된 행도 커서를 넘겨 다음 행을 처리한다.
   * 한 묶음의 변경과 ACK는 함께 확정되고 중단 후 새 요청은 미확정 행만 다시 읽는다. */
  assignPendingBatch(sessionId:string,profileId:string,apply:ApplyPending,lastRowId:number,
    after:PendingCursor | undefined,includeUnassigned:UnassignedReplayScope,limit:number):{cursor:PendingCursor | undefined;processed:number;assigned:number;more:boolean} {
    return this.database.transaction(()=>{
      this.requireProfile(profileId);
      const rows=this.database.prepare(`SELECT rowid AS rowId,occurred_at AS time,event_id,payload,assigned_profile_id FROM pending_profile_events
        WHERE session_id=? AND resolved_at IS NULL AND (assigned_profile_id=? OR assigned_profile_id IS NULL AND rowid>? AND rowid<=?)
        AND rowid<=? AND (occurred_at,rowid)>(?,?) ORDER BY occurred_at,rowid LIMIT ?`)
        .all(sessionId,profileId,...unassignedRowBounds(includeUnassigned),lastRowId,after?.time ?? -Number.MAX_VALUE,after?.rowId ?? 0,limit) as PendingRow[];
      const {processed,assigned}=this.applyPendingRows(rows,profileId,apply,performance.now()+PENDING_REPLAY_SLICE_MS);
      const last=rows[processed-1];
      return {cursor:last && {time:last.time,rowId:last.rowId},processed,assigned,more:processed<rows.length || rows.length===limit};
    }).immediate();
  }

  private applyPendingRows(rows:PendingRow[],profileId:string,apply:ApplyPending,until?:number):{processed:number;assigned:number} {
    const mark=this.database.prepare('UPDATE pending_profile_events SET assigned_profile_id=?,resolved_at=? WHERE event_id=? AND resolved_at IS NULL');
    let assigned=0,processed=0;
    for (const row of rows) {
      if (apply(JSON.parse(row.payload),row.event_id,row.assigned_profile_id===null)!==false) {
        mark.run(profileId,Date.now(),row.event_id);
        assigned++;
      }
      processed++;
      if (until!==undefined && performance.now()>=until) break;
    }
    return {processed,assigned};
  }

  close(): void { if (this.database.open) this.database.close(); }
}
