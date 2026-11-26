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
import {computeLogIdentity,LogFileProbe,logFileSize,matchesLogPrefix,readLogEndSample,sampleLogEnd} from './logFileIdentity';
import {log} from './logger';
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
/** 처리 구간 한 행의 최대 byte. 파일이 바뀌면 끝 표본이 맞지 않는 행만 지우므로, 작을수록 앞부분 구간이 많이 남는다(하루 사냥 로그 약 80MB면 약 320행). */
const RANGE_ROW_MAX_BYTES=256*1024;
/** v3.3.5 완료 대기 원문 변환: 한 번에 읽는 행 수와 1분 압축 한 번의 시간 예산(메인 스레드를 오래 막지 않게).
 * 예산은 변환 작업만이고, 같은 transaction의 commit(바꾼 page 쓰기·flush)이 20~30ms 더 걸려 압축 전체는 약 150ms다.
 * 같은 압축이 30일 지난 완료 행의 영수증 전환(최대 1000행)도 하므로, 그런 행이 남은 DB에서는 압축 한 번이 약 180~220ms까지
 * 걸린다(합성 2만 행 측정). v3.3.5에서 올라온 DB는 30일 지난 행이 거의 없어 실제로는 드물다. */
const CONVERT_BATCH_ROWS=500;
const CONVERT_BUDGET_MS=120;

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
  private relaxedDurabilityDepth=0;
  private directLiveApplyDepth=0;
  /** 경험치 줄만 읽은 동안 메모리에서 늘리는 반영 구간(deferAppliedRange). 1분 체크포인트·일지 기록·종료 때 DB에 쓴다. */
  private deferredRange?:{profileId:string;fingerprint:string;logDate:string;start:number;end:number;filePath?:string;endSample?:string};
  /** 자주 쓰는 처리 구간 문장의 준비 결과. reopen으로 연결이 바뀌면 버린다. */
  private statementCache?:{connection:Database.Database;statements:Map<string,Database.Statement>};
  /** 여러 구간을 한꺼번에 쓰는 동안(v3.3.5 대기 원문 변환) 파일 크기·핸들을 재사용한다. 그 밖에는 매번 연다. */
  private fileProbe?:LogFileProbe;

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
      // 출시 전 개발 빌드(a52766c)의 log_files는 경로가 섞인 지문으로 파일을 정했다. 내용 키 구조로 다시 만든다.
      if ((this.database.prepare("PRAGMA table_info(log_files)").all() as {name:string}[]).some(column=>column.name==='fingerprint')) {
        this.database.exec('DROP TABLE IF EXISTS log_ranges;DROP TABLE IF EXISTS log_files;');
      }
      // 출시 전 개발 빌드(0db12fd~)의 log_files에는 앞부분 표본 열이 없다.
      const logFileColumns=this.database.prepare('PRAGMA table_info(log_files)').all() as {name:string}[];
      if (logFileColumns.length && !logFileColumns.some(column=>column.name==='probe_length')) {
        this.database.exec('ALTER TABLE log_files ADD COLUMN probe_length INTEGER;ALTER TABLE log_files ADD COLUMN probe_hash TEXT;');
      }
      const logRangeColumns=this.database.prepare('PRAGMA table_info(log_ranges)').all() as {name:string}[];
      if (logRangeColumns.length && !logRangeColumns.some(column=>column.name==='end_sample')) this.database.exec('ALTER TABLE log_ranges ADD COLUMN end_sample TEXT');
      this.database.exec(`CREATE INDEX IF NOT EXISTS idx_profile_events_resolved ON pending_profile_events(resolved_at);
        CREATE INDEX IF NOT EXISTS idx_pending_profile_session_time ON pending_profile_events(session_id,occurred_at)
          WHERE resolved_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_pending_profile_owner ON pending_profile_events(assigned_profile_id)
          WHERE resolved_at IS NULL AND assigned_profile_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS profile_runtime_events(
          sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES pending_profile_events(event_id),
          profile_id TEXT NOT NULL REFERENCES play_profiles(id));
        CREATE INDEX IF NOT EXISTS idx_profile_runtime_events_owner ON profile_runtime_events(profile_id,sequence);
        CREATE TABLE IF NOT EXISTS log_files(id INTEGER PRIMARY KEY,content_key TEXT NOT NULL UNIQUE,file_path TEXT NOT NULL,log_date TEXT NOT NULL,
          probe_length INTEGER,probe_hash TEXT);
        CREATE TABLE IF NOT EXISTS log_file_aliases(fingerprint TEXT PRIMARY KEY,file_id INTEGER NOT NULL REFERENCES log_files(id));
        CREATE TABLE IF NOT EXISTS log_ranges(file_id INTEGER NOT NULL REFERENCES log_files(id),start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('applied','pending','ignored','legacy')),profile_id TEXT REFERENCES play_profiles(id),session_id TEXT,
          log_date TEXT NOT NULL,end_sample TEXT,PRIMARY KEY(file_id,start_offset));
        CREATE INDEX IF NOT EXISTS idx_log_ranges_profile ON log_ranges(profile_id,state,log_date);
        -- 구간 끝으로 앞 구간·겹치는 구간을 찾는다(extendRange). 없으면 그 파일의 행을 전부 훑어 행이 늘수록 느려진다.
        CREATE INDEX IF NOT EXISTS idx_log_ranges_end ON log_ranges(file_id,end_offset);
        CREATE TABLE IF NOT EXISTS profile_runtime_ranges(profile_id TEXT NOT NULL,file_id INTEGER NOT NULL,start_offset INTEGER NOT NULL,
          end_offset INTEGER NOT NULL,log_date TEXT NOT NULL,PRIMARY KEY(profile_id,file_id,start_offset));`);
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
    this.vacuumIfRequested();
  }

  /** 기능 계약 — 한 번만 하는 파일 축소(VACUUM).
   * - v3.3.5에서 올라온 DB는 완료된 실시간 대기 원문을 1분 압축이 처리 구간으로 바꾸며 지운다(convertResolvedLiveRows).
   *   다 지운 뒤 빈 공간이 8MB를 넘으면 표식(vacuum_on_next_start)을 남기고, 다음 시작 때 여기서 한 번 VACUUM한다.
   * - 표식은 먼저 지운다. 디스크가 모자라 실패해도 앱은 그대로 시작하고 다시 시도하지 않는다(작은 디스크 반복 실패 방지).
   * - v3.2.2에서 바로 올라오거나 새로 설치한 DB는 지울 대기 원문이 없어 표식이 생기지 않는다.
   * 회귀: check-profile-storage.ts. */
  private vacuumIfRequested():void {
    try {
      if (!this.database.prepare("SELECT 1 FROM app_meta WHERE key='vacuum_on_next_start'").get()) return;
      this.database.prepare("DELETE FROM app_meta WHERE key='vacuum_on_next_start'").run();
      this.database.exec('VACUUM');
    } catch {/* 공간 부족 등: 다음에 다시 시도하지 않고 그대로 쓴다. */}
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

  /** 기능 계약 — 실시간 채팅 로그 읽기의 commit만 WAL `synchronous=NORMAL`로 확정한다(commit마다 디스크 flush 없음).
   * - 기본값은 FULL이다. 설정·프로필 편집·동기화·복원 등 다른 저장은 그대로 commit마다 flush한다.
   * - 정전·OS 중단 때는 마지막으로 flush되지 않은 commit들이 사라질 수 있다. WAL은 앞에서부터 이어진 commit만
   *   복구하므로 DB는 손상되지 않고, 감시 북마크(app_meta)도 같은 DB에서 기록보다 늦게 commit되므로 함께 되돌아간다.
   *   다음 실행은 되돌아간 북마크부터 원본 로그를 다시 읽고, 이미 남은 기록은 이벤트 ID로 걸러진다(at-least-once).
   *   앱 프로세스만 죽는 경우에는 OS가 쓰기를 마치므로 잃지 않는다.
   *   단, 되돌아간 구간은 재시작 복구 읽기라 소유자를 확정할 수 없어, 그 사이 득템·SEED·숙제 줄은 자동 기록되지 않고
   *   **미배정**으로 돌아온다(사용자가 배정. 경험치 줄은 HUD에서만 빠진다). v3.3.5(FULL)에서는 그대로 기록돼 있던 줄이다.
   *   잃는 범위는 OS가 아직 디스크에 쓰지 않은 마지막 몇 초다. 회귀: check-profile-durability.ts(정전 뒤 기록+대기 합 1건).
   * - Google 동기화 순서: 업로드 전에 FULL commit(ProfileSyncCoordinator의 setMeta('uploadSizing'))이 먼저 있어야 한다.
   *   WAL은 한 파일이라 FULL commit의 flush가 앞의 NORMAL commit까지 디스크에 확정한다. 그래서 Google에 올린 변경이
   *   정전으로 로컬에서 사라지는 일이 없다. 이 순서가 깨지면 정전 뒤 같은 변경 번호를 다른 내용으로 다시 쓰고, 다음 수신에서
   *   "작성자 되돌림"으로 계정 연결을 풀어 사용자에게 다시 고르게 한다. 회귀: check-refactor-regressions.ts(업로드 전 FULL commit).
   * - 안에서 JSON 원본을 함께 바꾸는 설정 commit(commitConfiguration)은 FULL로 확정한다(withDurableCommit).
   * - transaction 안에서 시작하면 설정을 바꾸지 않는다. 중첩 호출은 바깥 범위가 끝날 때 FULL로 돌린다.
   * 측정·회귀: benchmark-runtime-resources.ts, check-profile-durability.ts. */
  withRelaxedDurability<T>(work:()=>T):T {
    if (this.relaxedDurabilityDepth>0 || !this.database.open || this.database.inTransaction) return work();
    this.database.pragma('synchronous = NORMAL');
    this.relaxedDurabilityDepth++;
    try {return work();}
    finally {
      this.relaxedDurabilityDepth--;
      if (this.database.open && !this.database.inTransaction) this.database.pragma('synchronous = FULL');
    }
  }

  /** withRelaxedDurability 범위 안에서도 이 commit은 FULL로 flush한다. 디스크 밖 원본(JSON 등)을 commit 뒤에 바꾸는 저장용. */
  private withDurableCommit<T>(work:()=>T):T {
    if (this.relaxedDurabilityDepth===0 || this.database.inTransaction) return work();
    this.database.pragma('synchronous = FULL');
    try {return work();}
    finally {if (this.database.open && !this.database.inTransaction) this.database.pragma('synchronous = NORMAL');}
  }

  /** 처리 구간처럼 줄마다 부르는 문장을 연결별로 한 번만 준비한다(1분 압축 변환 등). */
  private sql(text:string):Database.Statement {
    if (this.statementCache?.connection!==this.connection) this.statementCache={connection:this.connection,statements:new Map()};
    let statement=this.statementCache.statements.get(text);
    if (!statement) {statement=this.connection.prepare(text);this.statementCache.statements.set(text,statement);}
    return statement;
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
      // commit 뒤 journal을 지우므로 DB commit이 디스크에 확정되어야 한다(실시간 읽기 범위 안에서도 FULL).
      effective = this.withDurableCommit(() => this.database.transaction(() => {
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
      })());
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
      // 체크포인트 뒤 HUD 복원 구간도 HUD 복원 대기 행·진행 상태와 함께 지운다. 남기면 Google 적용으로 프로필이 되살아나
      // 선택될 때 옛 구간의 경험치가 빈 HUD에 재생된다. 미룬 구간은 먼저 써서 그 HUD 복원 행까지 함께 지운다(처리 구간은 남긴다).
      if (this.deferredRange?.profileId===id) this.flushDeferredRange();
      this.database.prepare('DELETE FROM profile_runtime_ranges WHERE profile_id=?').run(id);
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
  /** 완료된 HUD 입력은 해당 프로필의 다음 스냅샷과 함께 한 번만 정리한다.
   * 바로 반영한 실시간 구간의 HUD 복원 표(profile_runtime_ranges)도 같은 commit에 비운다(스냅샷에 이미 들어 있다). */
  saveRuntimeState(id:string,value:unknown):void {
    this.requireProfile(id);
    this.database.transaction(() => {
      this.database.prepare('INSERT INTO profile_runtime_state VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET value=excluded.value').run(id,json(value));
      this.database.prepare('DELETE FROM profile_runtime_events WHERE profile_id=?').run(id);
      this.database.prepare('DELETE FROM profile_runtime_ranges WHERE profile_id=?').run(id);
    })();
  }

  stageRuntimeEvent(profileId:string,eventId:string):void {
    // 바로 반영한 실시간 줄은 대기 원문이 없다. HUD는 profile_runtime_ranges의 구간을 원본에서 다시 읽어 복원한다.
    if (this.directLiveApplyDepth>0) return;
    this.database.prepare('INSERT INTO profile_runtime_events(event_id,profile_id) VALUES(?,?)').run(eventId,profileId);
  }

  /** 기능 계약 — 체크포인트 뒤 HUD 복원 구간(profile_runtime_ranges).
   * - 실시간 바로 반영(extendLiveRange)과 미룬 구간 쓰기(flushDeferredRange)가 새로 채운 반영 byte 구간만 같은 commit에 남긴다.
   *   과거 로그 복원·v3.3.5 대기 원문 변환·이전 세션 배정이 만든 반영 구간은 넣지 않는다(그 줄은 HUD에 재생하지 않는 계약).
   * - 체크포인트(saveRuntimeState)가 그 프로필의 행을 비우고, 비정상 종료 뒤 선택 때 남은 행만 원본에서 다시 읽어 HUD를 복원한다.
   * - 파일 내용이 바뀌어 반영 구간을 지우면(validateLogRanges) 겹치는 행도 지운다(다른 내용을 HUD에 재생하지 않게).
   * 회귀: check-profile-durability.ts, check-profile-crash.ts, check-profile-log-replace.ts(변환 구간은 재생 안 함). */
  runtimeRanges(profileId:string):{filePath:string;date:string;start:number;end:number}[] {
    this.flushDeferredRange();
    const rows=this.database.prepare(`SELECT r.file_id AS fileId,r.start_offset AS start,r.end_offset AS end,r.log_date AS date,f.file_path AS filePath
      FROM profile_runtime_ranges r JOIN log_files f ON f.id=r.file_id WHERE r.profile_id=? ORDER BY r.file_id,r.start_offset`)
      .all(profileId) as {fileId:number;start:number;end:number;date:string;filePath:string}[];
    // 행 경계는 줄 경계가 아닐 수 있으므로(처리 구간 행 크기 상한) 이어지는 행은 하나로 합쳐 줄을 자르지 않고 읽게 한다.
    const merged:Array<typeof rows[number]>=[];
    for (const row of rows) {
      const last=merged.at(-1);
      if (last && last.fileId===row.fileId && last.end>=row.start) last.end=Math.max(last.end,row.end);
      else merged.push({...row});
    }
    return merged.filter(row=>row.filePath).map(({filePath,date,start,end})=>({filePath,date,start,end}));
  }

  private recordRuntimeRanges(profileId:string | null,file:number,logDate:string,spans:ReadonlyArray<[number,number]>):void {
    if (!profileId || !spans.length) return;
    const extend=this.sql('UPDATE profile_runtime_ranges SET end_offset=? WHERE profile_id=? AND file_id=? AND end_offset=?');
    const insert=this.sql('INSERT OR IGNORE INTO profile_runtime_ranges VALUES(?,?,?,?,?)');
    for (const [start,end] of spans) if (!extend.run(end,profileId,file,start).changes) insert.run(profileId,file,start,end,logDate);
  }

  /** 기능 계약 — 실시간 줄 바로 반영(대기 원문 없음). ProfileService.acceptLiveLines가 한 줄의 기록을 이 범위 안에서 반영한다.
   * - 범위 안에서는 HUD 복원 대기(profile_runtime_events) 행을 만들지 않는다. 대신 같은 commit에 그 줄의 byte 범위를 소유 프로필의
   *   반영 구간(extendLiveRange)에 이어 붙이고 HUD 복원 구간(profile_runtime_ranges)에 남긴다.
   * - 일지·숙제에 남는 줄은 줄 귀속(profile_log_line_owners, live=1)도 남긴다(v3.3.5와 같은 범위). 처리 구간이 파일 교체로
   *   지워져도 같은 줄을 다시 기록하지 않게 하는 내용 기준 증거다. 경험치 등 기록 없는 줄은 귀속을 만들지 않는다.
   * - 기존 줄 귀속(과거 복원이 다른 프로필에 귀속한 줄 등)은 지금처럼 확인해 기록을 건너뛴다.
   * 회귀: check-profile-recording.ts, check-profile-durability.ts, check-profile-log-replace.ts. */
  withDirectLiveApply<T>(work:()=>T):T {
    this.directLiveApplyDepth++;
    try {return work();} finally {this.directLiveApplyDepth--;}
  }
  get directLiveApply():boolean {return this.directLiveApplyDepth>0;}

  /** 경로별 원본 지문(inspectChatLogFile)이 가리키는 원본 로그 파일 행(log_files)의 id. 모르면 undefined. */
  logFileIdForFingerprint(fingerprint:string):number | undefined {
    return (this.sql('SELECT file_id AS id FROM log_file_aliases WHERE fingerprint=?').get(fingerprint) as {id:number} | undefined)?.id;
  }

  /** 기능 계약 — 원본 로그 파일의 정체(log_files)는 경로와 무관한 내용 키(logFileIdentity.computeLogContentKey)로 정하고,
   * 경로별 지문은 별칭(log_file_aliases)으로 연결한다. 같은 로그를 다른 폴더로 복사해도 같은 파일 행이라 처리 구간과 일지 행의
   * 원본 위치가 그대로 맞는다("경로가 달라도 같은 줄은 같은 기록"). 내용 키를 아직 만들 수 없으면(시각 표시 줄 없음)
   * fallback일 때만 지문 자체를 키로 쓰고, 아니면 등록하지 않는다. 회귀: check-profile-lifecycle.ts(다른 폴더 복사본).
   * 알려진 한계: 내용 키의 날짜는 처음 등록한 호출의 logDate다. 실시간·복원은 파일명 날짜를 쓰지만, v3.3.5 대기 원문 변환이
   * 처음 보는 지문을 등록하면 이벤트 날짜(data.date)를 쓴다. 둘이 다르면(자정 직후 줄 등) 같은 파일의 다른 폴더 복사본을
   * 같은 파일로 묶지 못한다. 같은 파일 자체의 중복 방지는 지문 별칭으로 지켜진다. */
  registerLogFile(fingerprint:string,filePath:string | undefined,logDate:string,fallback=true):number | undefined {
    const known=this.logFileIdForFingerprint(fingerprint);
    if (known!==undefined) {
      if (filePath) this.sql('UPDATE log_files SET file_path=? WHERE id=? AND file_path<>?').run(filePath,known,filePath);
      return known;
    }
    const identity=filePath ? computeLogIdentity(filePath,logDate) : undefined;
    let key=identity?.contentKey ?? (fallback ? `fingerprint:${fingerprint}` : undefined);
    if (!key) return;
    // 같은 내용 키라도 처음 등록한 앞부분과 다르면(같은 날짜 파일을 다른 내용으로 다시 씀) 다른 파일로 둔다.
    const existing=this.database.prepare('SELECT id,probe_length AS probeLength,probe_hash AS probeHash FROM log_files WHERE content_key=?').get(key) as
      {id:number;probeLength:number | null;probeHash:string | null} | undefined;
    if (existing && identity && filePath && existing.probeLength && existing.probeHash && !matchesLogPrefix(filePath,existing.probeLength,existing.probeHash)) {
      key=`${key}:${identity.probeHash}`;
    }
    this.database.prepare(`INSERT INTO log_files(content_key,file_path,log_date,probe_length,probe_hash) VALUES(?,?,?,?,?)
      ON CONFLICT(content_key) DO UPDATE SET file_path=CASE WHEN excluded.file_path<>'' THEN excluded.file_path ELSE file_path END`)
      .run(key,filePath ?? '',logDate,identity?.probeLength ?? null,identity?.probeHash ?? null);
    const id=(this.database.prepare('SELECT id FROM log_files WHERE content_key=?').get(key) as {id:number}).id;
    this.database.prepare('INSERT OR IGNORE INTO log_file_aliases VALUES(?,?)').run(fingerprint,id);
    return id;
  }

  /** 기능 계약 — 처리 구간(log_ranges)의 "반영(applied)" 구간: 그 프로필이 반영을 마친 줄(실시간 바로 반영).
   * - 통합 설계(.agents/development/unified-log-storage-design.md)의 처리 구간 표다. 상태는 applied·pending·ignored·legacy이며
   *   지금은 실시간 바로 반영만 applied를 쓴다(나머지 상태는 다음 단계에서 옛 대기·귀속·무시 표를 옮겨 온다).
   * - 같은 원본 파일(log_files)의 구간은 상태와 관계없이 겹치지 않는다. 이어지는 같은 (상태, 프로필, 세션) 구간은 끝만
   *   늘리되 한 행은 RANGE_ROW_MAX_BYTES(256KB)를 넘지 않는다. 파일이 짧아지거나 바뀌면 끝 표본이 맞지 않는 행만 지우므로
   *   (validateLogRanges) 그대로 남은 앞부분의 구간은 유지된다. 이미 다른 구간이 덮은 byte는 새 구간에서 잘라 낸다.
   * - 지금 파일보다 끝이 긴 구간은 쓰지 않는다(파일이 잘린 뒤 늦게 쓰는 구간이 나중에 같은 위치에 새로 쓰인 줄을 덮지 않게).
   * - applied 구간 안의 줄은 반영을 마친 줄이다. 재읽기 중복 방지는 이벤트 행(대기·영수증)이 먼저이고, 행이 없으면 구간을 본다
   *   (appliedRangeCovers). 구간에는 기록 없는 채팅 줄도 들어간다(기록 없는 줄은 다시 읽어도 기록이 생기지 않는다).
   * - 이 함수(복원 등)는 HUD 복원 구간을 남기지 않는다. 실시간 바로 반영은 extendLiveRange를 쓴다.
   * 회귀: check-profile-storage.ts, check-profile-recording.ts, check-profile-log-replace.ts. */
  extendAppliedRange(profileId:string,fingerprint:string,logDate:string,start:number,end:number,filePath?:string):void {
    this.flushDeferredRange();
    this.extendRange('applied',profileId,fingerprint,logDate,start,end,filePath);
  }

  /** 실시간 바로 반영의 처리 구간. extendAppliedRange와 같고, 새로 채운 byte를 체크포인트 뒤 HUD 복원 구간으로도 남긴다. */
  extendLiveRange(profileId:string,fingerprint:string,logDate:string,start:number,end:number,filePath?:string):void {
    this.flushDeferredRange();
    const written=this.extendRange('applied',profileId,fingerprint,logDate,start,end,filePath);
    if (written) this.recordRuntimeRanges(profileId,written.file,logDate,written.spans);
  }

  /** 기능 계약 — 경험치 줄만 있는 실시간 읽기의 처리 구간은 DB에 바로 쓰지 않는다(사냥 정보는 DB에 줄 단위로 남기지 않는다).
   * - 구간을 메모리에서 이어 붙인다. 같은 프로필·같은 파일이면 사이의 기록 없는 줄(채팅 등)까지 한 구간으로 늘린다.
   * - 쓰는 때(flushDeferredRange): 기록이 있는 읽기(같은 commit), 구간을 읽거나 바꾸는 모든 호출(appliedRanges·runtimeRanges·
   *   validateLogRanges·extendAppliedRange·압축), 1분 체크포인트(profileRecording.checkpoint), 감시 북마크 저장(최대 1분 간격), 종료(close).
   * - 같은 프로세스 안의 중복 확인(appliedRangeCovers·rangeAt)은 메모리 구간도 본다.
   * - 비정상 종료하면 메모리 구간을 잃는다. 그 줄들은 일지·숙제 기록이 없는 경험치 줄이라 다시 읽어도 기록이 생기지 않고,
   *   마지막 체크포인트 뒤 최대 1분의 경험치·처치 수만 HUD에서 빠진다(사용자 결정 2026-11-25). 버프 등은 바로 쓴다.
   * 회귀: check-profile-durability.ts, check-profile-storage.ts. */
  deferAppliedRange(profileId:string,fingerprint:string,logDate:string,start:number,end:number,filePath?:string):void {
    if (!fingerprint || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end<=start) return;
    const current=this.deferredRange;
    if (current && current.profileId===profileId && current.fingerprint===fingerprint && current.logDate===logDate && start>=current.start) {
      const grew=end>current.end || (!!filePath && filePath!==current.filePath);
      current.end=Math.max(current.end,end);
      if (filePath) current.filePath=filePath;
      // 방금 읽은 내용의 구간 끝 표본. 쓸 때 다시 재서 파일이 그 사이 바뀌었으면 쓰지 않는다(flushDeferredRange).
      // 알려진 한계: 표본은 경로로 파일을 다시 열어 잰다(읽기 한 번에 약 0.4ms, 사냥 중 초당 1~5회). 읽은 직후 표본을 재기 전
      // (1ms 미만) 파일이 교체되면 새 파일에서 재므로 쓸 때 비교를 통과한다. 읽기 버퍼로 재면 둘 다 없어지지만, 구간 끝이
      // 버퍼 밖일 수 있어 chatLogManager부터 넘기는 값을 바꿔야 한다.
      if (grew && current.filePath) current.endSample=sampleLogEnd(current.filePath,current.end);
      return;
    }
    this.flushDeferredRange();
    this.deferredRange={profileId,fingerprint,logDate,start,end,filePath,...(filePath ? {endSample:sampleLogEnd(filePath,end)} : {})};
  }

  /** 쓰지 못한 미룬 구간을 버리기 직전에 남긴다(flushDeferredRange 계약). 그 줄은 경험치 줄뿐이다. */
  private logUnwrittenDeferredRange(reason:string):void {
    const range=this.deferredRange;
    if (range) log(`[PROFILE] 미룬 처리 구간을 쓰지 못하고 버립니다(${reason}, ${range.end-range.start}byte). 경험치 줄만 다시 읽힐 수 있습니다.`);
  }

  /** 미뤄 둔 구간이 이 (프로필, 파일, 날짜)의 것이 아니면 transaction 밖에서 먼저 쓴다. 경험치 줄만 있는 읽기가
   * transaction 안에서 다른 구간으로 바꿔 끼우다 그 commit이 취소되면 앞 구간을 잃기 때문이다(acceptLiveLines). */
  flushDeferredRangeUnlessFor(profileId:string,fingerprint:string,logDate:string):void {
    const current=this.deferredRange;
    if (current && (current.profileId!==profileId || current.fingerprint!==fingerprint || current.logDate!==logDate)) this.flushDeferredRange();
  }

  /** 메모리에 미뤄 둔 반영 구간이 있는지(감시 북마크 저장 간격 판단용). */
  get hasDeferredRange():boolean {return !!this.deferredRange;}

  /** 미뤄 둔 반영 구간을 DB에 쓴다. 실패하면 메모리에 남겨 다음에 다시 쓴다(호출자에게 예외를 넘긴다).
   * 바깥 transaction 안에서 쓰면 그 commit이 취소될 수 있으므로 메모리에서 지우지 않는다. 다시 써도 같은 구간이라
   * 결과가 같고, transaction 밖의 다음 쓰기(북마크 저장·체크포인트·기록 있는 읽기 앞)가 지운다.
   * 기능 계약 — 쓰기 전에 구간 끝 표본을 미룰 때 잰 값과 비교한다. 파일이 교체·다시 쓰기로 바뀌었는데 실시간 감시가 아직
   * 알아채지 못한 사이(최대 1초)에 체크포인트·압축·선택·복원이 먼저 부르면, 끝 표본이 바뀐 파일에서 계산되어 검증을 통과하고
   * 그 byte의 새 줄(득템 포함)을 처리한 줄로 보고 건너뛴다. 표본이 다르면(또는 파일이 짧아졌으면) 구간을 버린다.
   * 버린 구간의 줄은 경험치 줄뿐이라 HUD만 다시 읽힐 수 있다(discardDeferredRange와 같은 결과).
   * 원본 경로가 있는데 확인할 수 없으면(쓸 때 파일을 열지 못함, 또는 미룰 때 표본을 재지 못함 — 백신 등의 잠깐 잠금·옮김·삭제)
   * 바뀌지 않았다고 볼 근거가 없으므로 같은 이유로 버리고 로그를 남긴다. 메모리에 남겨 다시 확인하면 그 사이 끼어든 대기 경로 줄·
   * 체크포인트·프로필 삭제·감시 북마크와 맞물리는 상태가 늘어난다. 버려도 일지·숙제 기록에는 영향이 없고(경험치 줄뿐), 체크포인트가
   * 버리면 바로 뒤 HUD 저장이 그 경험치를 담는다. 그 밖에서 버린 뒤 다음 체크포인트 전에 비정상 종료하면 그 경험치(최대 1분)만 HUD
   * 복원에서 빠진다(위 계약의 "마지막 1분" 한계와 같은 범위). 회귀: check-profile-storage.ts(바뀐·잘린·열지 못한·표본 없는 미룬 구간). */
  flushDeferredRange():void {
    const range=this.deferredRange;
    if (!range || !this.database.open) return;
    if (range.filePath) {
      const now=range.endSample===undefined ? undefined : readLogEndSample(range.filePath,range.end);
      if (now===undefined || now!==range.endSample) {
        if (now===undefined) this.logUnwrittenDeferredRange(range.endSample===undefined ? '미룰 때 원본 표본을 재지 못함' : '원본을 열지 못함');
        if (this.deferredRange===range) this.deferredRange=undefined;
        return;
      }
    }
    this.database.transaction(()=>{
      const written=this.extendRange('applied',range.profileId,range.fingerprint,range.logDate,range.start,range.end,range.filePath);
      // 미룬 구간도 실시간으로 반영한 줄이라 체크포인트 뒤라면 HUD 복원 대상이다.
      if (written) this.recordRuntimeRanges(range.profileId,written.file,range.logDate,written.spans);
    })();
    if (this.deferredRange===range && !this.database.inTransaction) this.deferredRange=undefined;
  }

  /** 실시간 감시가 파일 교체·절단을 감지해 처음부터 다시 읽을 때, 그 파일의 미룬 구간을 버린다.
   * 미룬 구간은 바뀌기 전 내용을 읽은 결과인데, 쓸 때 끝 표본은 바뀐 파일에서 계산되므로 검증을 통과해 엉뚱한 줄을 덮을 수 있다.
   * 버리면 그 사이 경험치 줄은 다시 읽혀 HUD에 한 번 더 들어갈 수 있다(일지·숙제 기록은 줄 귀속으로 걸러진다). */
  discardDeferredRange(fingerprint:string):void {
    const range=this.deferredRange;
    if (!range) return;
    const file=this.logFileIdForFingerprint(fingerprint);
    if (range.fingerprint===fingerprint || (file!==undefined && this.logFileIdForFingerprint(range.fingerprint)===file)) this.deferredRange=undefined;
  }

  private deferredCovers(fingerprint:string,offset:number):boolean {
    const range=this.deferredRange;
    return !!range && range.fingerprint===fingerprint && offset>=range.start && offset<range.end;
  }

  /** 처리 구간을 이어 붙인다. 이미 다른 구간이 덮은 byte는 건너뛰고, 그 사이의 빈 곳마다 채운다(구간 하나가 중간에 있어도
   * 그 뒤를 버리지 않는다. 예: 실시간으로 반영한 구간이 있는 오늘 파일을 같은 프로필이 처음부터 복원).
   * 빈 곳 바로 앞 구간이 같은 (상태, 소유, 세션 없음)이면 행 크기 상한 안에서 그 끝만 늘리고, 넘으면 새 행을 만든다.
   * 새로 채운 byte 구간(written.spans)을 돌려준다. 파일보다 끝이 긴 빈 곳은 쓰지 않는다. */
  private extendRange(state:'applied' | 'ignored',profileId:string | null,fingerprint:string,logDate:string,start:number,end:number,filePath?:string):
    {file:number;spans:Array<[number,number]>} | undefined {
    if (!fingerprint || !/^\d{4}-\d{2}-\d{2}$/.test(logDate) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<=start) return;
    const file=this.registerLogFile(fingerprint,filePath,logDate)!;
    // 구간 끝 표본: 파일이 다른 내용으로 바뀌면(같은 날짜 파일 다시 쓰기·교체) 그 구간을 가려낸다(validateLogRanges).
    const samplePath=filePath || this.logFilePath(file);
    const probe=this.fileProbe;
    const sample=(at:number)=>samplePath ? (probe ? probe.sampleEnd(samplePath,at) : sampleLogEnd(samplePath,at)) ?? null : null;
    // 파일이 있는데 구간 끝보다 짧으면 이미 잘린 파일이다(없는 파일은 표본 없이 쓴다: 지워진 옛 로그의 v3.3.5 원문 변환 등).
    const size=samplePath ? (probe ? probe.size(samplePath) : logFileSize(samplePath)) : undefined;
    // 구간은 겹치지 않으므로 끝 위치 순서가 시작 위치 순서와 같다. 끝 인덱스로 start 뒤에서 끝나는 행부터 읽고
    // 시작이 end를 넘으면 멈춘다(시작 위치 PK로 start_offset<end를 찾으면 파일 앞쪽 행을 전부 훑는다).
    const overlapping:{start:number;end:number}[]=[];
    for (const range of this.sql(`SELECT start_offset AS start,end_offset AS end FROM log_ranges INDEXED BY idx_log_ranges_end
      WHERE file_id=? AND end_offset>? ORDER BY end_offset`).iterate(file,start) as Iterable<{start:number;end:number}>) {
      if (range.start>=end) break;
      overlapping.push(range);
    }
    const gaps:Array<[number,number]>=[];
    let cursor=start;
    for (const range of overlapping) {
      if (range.start>cursor) gaps.push([cursor,range.start]);
      cursor=Math.max(cursor,range.end);
    }
    if (cursor<end) gaps.push([cursor,end]);
    const adjacent=this.sql(`SELECT start_offset AS start,state,profile_id AS owner,session_id AS session FROM log_ranges
      INDEXED BY idx_log_ranges_end WHERE file_id=? AND end_offset=? LIMIT 1`);
    const following=this.sql(`SELECT end_offset AS end,end_sample AS sample,state,profile_id AS owner,session_id AS session FROM log_ranges
      WHERE file_id=? AND start_offset=?`);
    const extend=this.sql('UPDATE log_ranges SET end_offset=?,end_sample=? WHERE file_id=? AND start_offset=?');
    const remove=this.sql('DELETE FROM log_ranges WHERE file_id=? AND start_offset=?');
    const insert=this.sql('INSERT INTO log_ranges(file_id,start_offset,end_offset,state,profile_id,session_id,log_date,end_sample) VALUES(?,?,?,?,?,NULL,?,?)');
    const sameKey=(row:{state:string;owner:string | null;session:string | null} | undefined)=>!!row && row.state===state && row.owner===profileId && row.session===null;
    const spans:Array<[number,number]>=[];
    for (const [from,to] of gaps) {
      if (size!==undefined && to>size) continue;
      let position=from,lastStart:number;
      const before=adjacent.get(file,from) as {start:number;state:string;owner:string | null;session:string | null} | undefined;
      if (sameKey(before) && from-before!.start<RANGE_ROW_MAX_BYTES) {
        const stop=Math.min(to,before!.start+RANGE_ROW_MAX_BYTES);
        extend.run(stop,sample(stop),file,before!.start);
        lastStart=before!.start;position=stop;
      } else lastStart=from;
      while (position<to) {
        const stop=Math.min(to,position+RANGE_ROW_MAX_BYTES);
        insert.run(file,position,stop,state,profileId,logDate,sample(stop));
        lastStart=position;position=stop;
      }
      // 빈 곳 뒤의 같은 (상태, 소유) 구간과 상한 안에서 한 행으로 합친다.
      const after=following.get(file,to) as {end:number;sample:string | null;state:string;owner:string | null;session:string | null} | undefined;
      if (sameKey(after) && after!.end-lastStart<=RANGE_ROW_MAX_BYTES) {
        remove.run(file,to);
        extend.run(after!.end,after!.sample,file,lastStart);
      }
      spans.push([from,to]);
    }
    return {file,spans};
  }

  /** 기능 계약 — 처리 구간은 byte 위치라, 같은 파일이 다른 내용으로 바뀌면(파일 교체·같은 날짜 파일 다시 쓰기) 엉뚱한 줄을 덮는다.
   * 줄 키(내용 해시) 시절처럼 바뀐 줄을 새 줄로 보도록, 과거 로그 복원 시작과 실시간 감시 준비 때 그 파일 구간의 끝 표본을
   * 지금 파일과 비교해 맞지 않는(파일이 짧아졌거나 내용이 다른) 구간을 지운다. 덧붙이기만 하는 로그와 복사본은 그대로다.
   * 행은 최대 256KB라 앞부분이 그대로인 파일에서는 바뀐 지점이 걸친 행과 그 뒤만 지운다. 지운 구간의 일지·숙제 줄은
   * 줄 귀속(live=1)으로 다시 기록되지 않는다. 겹치는 HUD 복원 구간도 함께 지운다.
   * 표본이 없는 구간(경로를 몰랐던 이전 행)은 둔다. 회귀: check-profile-log-restore.ts(같은 날짜 파일 다시 쓰기), check-profile-log-replace.ts. */
  validateLogRanges(fingerprint:string,filePath:string):number {
    this.flushDeferredRange();
    const file=this.logFileIdForFingerprint(fingerprint);
    if (file===undefined) return 0;
    const rows=this.database.prepare('SELECT start_offset AS start,end_offset AS end,end_sample AS sample FROM log_ranges WHERE file_id=? AND end_sample IS NOT NULL')
      .all(file) as {start:number;end:number;sample:string}[];
    const remove=this.database.prepare('DELETE FROM log_ranges WHERE file_id=? AND start_offset=?');
    const removeHud=this.database.prepare('DELETE FROM profile_runtime_ranges WHERE file_id=? AND start_offset<? AND end_offset>?');
    let removed=0;
    for (const row of rows) if (sampleLogEnd(filePath,row.end)!==row.sample) {remove.run(file,row.start);removeHud.run(file,row.end,row.start);removed++;}
    // transaction 안이라 메모리에 남은 미룬 구간이 바뀐 파일의 것이면 버린다(다음 쓰기가 지운 구간을 되살리지 않게).
    const deferred=this.deferredRange;
    if (removed && deferred && this.logFileIdForFingerprint(deferred.fingerprint)===file) this.deferredRange=undefined;
    return removed;
  }

  /** 이 원본 위치(줄 시작 byte)가 이미 처리한 구간(반영 applied 또는 무시 ignored) 안인지. 실시간 재읽기 중복 방지용. */
  appliedRangeCovers(fingerprint:string,offset:number):boolean {
    if (this.deferredCovers(fingerprint,offset)) return true;
    const file=this.logFileIdForFingerprint(fingerprint);
    if (file===undefined) return false;
    const row=this.sql('SELECT end_offset AS end,state FROM log_ranges WHERE file_id=? AND start_offset<=? ORDER BY start_offset DESC LIMIT 1')
      .get(file,offset) as {end:number;state:string} | undefined;
    return !!row && (row.state==='applied' || row.state==='ignored') && row.end>offset;
  }

  /** 이 줄을 어떤 프로필이 실시간으로 이미 반영했는지(줄 귀속 live=1). 일지·숙제에 남는 줄만 귀속을 남기므로,
   * 처리 구간이 지워진 뒤(파일 교체·절단) 같은 줄을 다시 읽어도 기록을 중복하지 않게 하는 내용 기준 확인이다. */
  lineAppliedLive(lineKey:string):boolean {
    if (!/^[a-f0-9]{64}$/.test(lineKey)) return false;
    return !!this.sql('SELECT 1 FROM profile_log_line_owners WHERE line_key=? AND live=1 AND profile_id IS NOT NULL').get(Buffer.from(lineKey,'hex'));
  }

  /** 이 원본 위치(줄 시작 byte)를 덮는 처리 구간의 상태·소유. 없으면 undefined. */
  rangeAt(fingerprint:string,offset:number):{state:string;profileId:string | null} | undefined {
    if (this.deferredCovers(fingerprint,offset)) return {state:'applied',profileId:this.deferredRange!.profileId};
    const file=this.logFileIdForFingerprint(fingerprint);
    if (file===undefined) return;
    const row=this.database.prepare('SELECT end_offset AS end,state,profile_id AS profileId FROM log_ranges WHERE file_id=? AND start_offset<=? ORDER BY start_offset DESC LIMIT 1')
      .get(file,offset) as {end:number;state:string;profileId:string | null} | undefined;
    return row && row.end>offset ? {state:row.state,profileId:row.profileId} : undefined;
  }

  /** 반영(applied) 구간. fingerprint를 주면 그 지문이 가리키는 파일만, fromDate를 주면 그 날짜 이후만.
   * 파일·시작 위치 순서다(재분석 워커가 시작 위치 순서로 한 번 훑는다. 한 파일에 날짜가 다른 구간이 섞여도 순서가 맞아야 한다). */
  appliedRanges(query:{profileId?:string;notProfileId?:string;fingerprint?:string;fromDate?:string}):{fileId:number;start:number;end:number;profileId:string;logDate:string}[] {
    this.flushDeferredRange();
    const where:string[]=["state='applied'"],params:Array<string | number>=[];
    if (query.profileId!==undefined) {where.push('profile_id=?');params.push(query.profileId);}
    if (query.notProfileId!==undefined) {where.push('profile_id<>?');params.push(query.notProfileId);}
    if (query.fingerprint!==undefined) {
      const file=this.logFileIdForFingerprint(query.fingerprint);
      if (file===undefined) return [];
      where.push('file_id=?');params.push(file);
    }
    if (query.fromDate!==undefined) {where.push('log_date>=?');params.push(query.fromDate);}
    return this.database.prepare(`SELECT file_id AS fileId,start_offset AS start,end_offset AS end,profile_id AS profileId,log_date AS logDate
      FROM log_ranges WHERE ${where.join(' AND ')} ORDER BY file_id,start_offset`).all(...params) as
      {fileId:number;start:number;end:number;profileId:string;logDate:string}[];
  }

  /** 원본 로그 파일 경로(log_files, 마지막으로 본 경로). 모르면 undefined. */
  logFilePath(fileId:number):string | undefined {
    return (this.sql('SELECT file_path AS path FROM log_files WHERE id=?').get(fileId) as {path:string} | undefined)?.path || undefined;
  }

  /** 이 줄이 다른 프로필(또는 무시·복원 귀속)에 이미 귀속돼 있는지. 그런 줄은 바로 반영하지 않고 대기 경로로 처리해
   * 이 프로필의 읽은 범위에 넣지 않는다(넣으면 원래 소유자의 재분석에서 제외되고 HUD 재생 대상이 된다). */
  lineOwnedElsewhere(lineKey:string,profileId:string):boolean {
    if (!/^[a-f0-9]{64}$/.test(lineKey)) return false;
    const owner=this.database.prepare('SELECT profile_id AS owner,live FROM profile_log_line_owners WHERE line_key=?')
      .get(Buffer.from(lineKey,'hex')) as {owner:string | null;live:number} | undefined;
    return !!owner && !(owner.live===1 && owner.owner===profileId);
  }

  /** 바로 반영을 멈춰야 하는 미완료 소유 실시간 기록(저장·반영 실패 재시도)이 있는지. 있으면 순서를 지키려 대기 경로로 처리한다.
   * 알려진 한계: 같은 세션에 계속 실패하는 소유 기록이 하나라도 남으면 세션 끝까지 v3.3.5처럼 줄마다 대기 원문(약 680바이트)이
   * 쌓인다(순서 보장이 우선). 프로필이 둘 이상인 사용자가 선택창에 답하지 않은 채 사냥하는 동안도 같다(선택 뒤 배정·압축으로 줄어듦). */
  hasOwnedLivePending(session:string,profileId:string):boolean {
    return !!this.database.prepare(`SELECT 1 FROM pending_profile_events INDEXED BY idx_pending_profile_owner
      WHERE assigned_profile_id=? AND resolved_at IS NULL AND session_id=? AND (event_id GLOB 'live:*' OR event_id GLOB 'live-line:*') LIMIT 1`)
      .get(profileId,session);
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
    // 미룬 구간은 압축 transaction 밖에서 먼저 쓴다(압축이 취소돼도 구간은 남는다).
    this.flushDeferredRange();
    return this.database.transaction(()=>{
      this.convertResolvedLiveRows();
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

  /**
   * 기능 계약 — 미룬 실시간 기록(선택 전·반영 실패·이전 세션 배정)은 대기 행으로 두되 미룬 동안만 둔다.
   * - 완료(반영 또는 무시)된 실시간 줄 행(`live-line:`·`live:`, payload에 원본 위치)은 1분 압축 때 그 줄을 처리 구간으로 바꾸고
   *   행을 지운다: 소유자가 있으면 반영(applied), 없으면(무시) 무시(ignored). 30일 원문 보관·완료 영수증은 쓰지 않는다.
   * - HUD 복원 대기(profile_runtime_events)에 있는 행은 체크포인트 뒤로 미룬다. 미완료 행(배정·무시 대기)은 건드리지 않으므로
   *   선택 대기 배정·수동 배정·무시·미배정 화면·확인 토큰·Google 동기화 가드는 그대로다.
   * - 재읽기 중복 방지는 이벤트 행 → 처리 구간(applied·ignored) 순이라 행을 지워도 같은 줄을 다시 기록하지 않는다.
   * - 줄 귀속은 놓지 않는다. 같은 줄의 일지·숙제 기록 행이 먼저(다른 묶음에서) 지워졌으면 귀속이 그 줄의 유일한 내용 증거이기
   *   때문이다. v3.3.5는 기록 없는 줄에 귀속을 만들지 않았으므로 남는 귀속은 기록 있는 줄 것이고, 일지 정리 날짜와 함께 지워진다.
   * - 만든 구간은 HUD 복원 구간에 넣지 않는다(이미 HUD에 반영됐거나, 이전 세션 배정처럼 재생하지 않는 줄).
   * - 성능: 위치·날짜는 SQL에서 꺼내고, 이어지는(또는 겹치는) 같은 (파일, 소유, 날짜) 줄은 한 구간으로 합쳐 쓴다. 한 번 압축은
   *   CONVERT_BATCH_ROWS씩 골라 구간마다 CONVERT_BUDGET_MS 예산을 확인한다(구간 하나는 항상 처리해 앞으로 나아간다).
   *   파일 크기·핸들은 한 번 압축 안에서 재사용하고(LogFileProbe), 앞·겹치는 구간은 끝 위치 인덱스(idx_log_ranges_end)로 찾는다.
   *   실제 v3.3.5 DB는 평균 2.19행마다 줄 사이가 끊겨, 예산을 묶음 사이에서만 보던 때는 1분마다 0.5~1.8초를 막았다.
   *   측정: scripts/benchmark-convert-live-rows.ts.
   * 회귀: check-profile-storage.ts(완료 행의 구간 전환·HUD 대기 보존·무시 구간), check-profile-crash.ts, check-profile-upgrade-335.ts. */
  private convertResolvedLiveRows(batchRows=CONVERT_BATCH_ROWS,budgetMs=CONVERT_BUDGET_MS):void {
    const select=this.sql(`SELECT event_id AS id,assigned_profile_id AS owner,json_extract(payload,'$.source.fingerprint') AS fingerprint,
      json_extract(payload,'$.source.start') AS start,json_extract(payload,'$.source.end') AS end,json_extract(payload,'$.data.date') AS date
      FROM pending_profile_events
      WHERE resolved_at IS NOT NULL AND (event_id GLOB 'live-line:*' OR event_id GLOB 'live:*')
      AND NOT EXISTS (SELECT 1 FROM profile_runtime_events r WHERE r.event_id=pending_profile_events.event_id)
      -- 구간으로 바꿀 수 없는 행(원본 위치·날짜 없음, 손상)은 고르지 않는다. 매번 다시 읽거나 앞 묶음을 막지 않게 하고,
      -- 이런 행은 이전처럼 30일 뒤 완료 영수증으로 옮긴다.
      AND CASE WHEN json_valid(payload) THEN json_type(payload,'$.source.fingerprint')='text' AND json_extract(payload,'$.source.fingerprint')<>''
        AND json_type(payload,'$.source.start')='integer' AND json_type(payload,'$.source.end')='integer'
        AND json_extract(payload,'$.source.start')>=0 AND json_extract(payload,'$.source.end')>json_extract(payload,'$.source.start')
        AND json_type(payload,'$.data.date')='text' AND json_extract(payload,'$.data.date') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        ELSE 0 END LIMIT ?`);
    const remove=this.sql('DELETE FROM pending_profile_events WHERE event_id=?');
    const sourcePaths=new Map<string,string | undefined>();
    const pathOf=(fingerprint:string)=>{
      if (!sourcePaths.has(fingerprint)) {
        let found:string | undefined;
        if (this.logFileIdForFingerprint(fingerprint)===undefined) {
          for (const {state_json} of this.database.prepare('SELECT state_json FROM profile_log_sources').all() as {state_json:string}[]) {
            try {const value=JSON.parse(state_json) as {fingerprint?:unknown;filePath?:unknown};if (value.fingerprint===fingerprint && typeof value.filePath==='string') {found=value.filePath;break;}}
            catch {/* 손상된 원본 정보는 건너뛴다. */}
          }
        }
        sourcePaths.set(fingerprint,found);
      }
      return sourcePaths.get(fingerprint);
    };
    const deadline=performance.now()+budgetMs;
    // 한 번 압축 동안 파일마다 한 번만 열고 크기를 잰다(구간마다 stat·open·close를 하지 않는다).
    const ownProbe=!this.fileProbe;
    if (ownProbe) this.fileProbe=new LogFileProbe();
    try {
      for (let wrote=false;;) {
        if (wrote && performance.now()>=deadline) return;
        const rows=select.all(batchRows) as {id:string;owner:string | null;fingerprint:string;start:number;end:number;date:string}[];
        if (!rows.length) {
          // 이전 버전(v3.3.5)이 쌓은 완료 원문을 다 바꾼 첫 시점에 한 번만, 빈 공간이 크면 다음 시작 때 파일을 줄인다(vacuumIfRequested).
          if (!this.database.prepare("SELECT 1 FROM app_meta WHERE key='live_rows_converted'").get()) {
            this.database.prepare("INSERT INTO app_meta VALUES('live_rows_converted','done')").run();
            const free=Number(this.database.pragma('freelist_count',{simple:true}))*Number(this.database.pragma('page_size',{simple:true}));
            if (free>8*2**20) this.database.prepare("INSERT OR IGNORE INTO app_meta VALUES('vacuum_on_next_start','1')").run();
          }
          return;
        }
        // 같은 (파일 지문, 소유, 날짜)의 이어지거나 겹치는 줄을 합친다. 사이가 빈 줄(다른 소유·기록 없는 채팅)은 합치지 않는다.
        rows.sort((a,b)=>a.fingerprint<b.fingerprint ? -1 : a.fingerprint>b.fingerprint ? 1
          : (a.owner ?? '')<(b.owner ?? '') ? -1 : (a.owner ?? '')>(b.owner ?? '') ? 1
          : a.date<b.date ? -1 : a.date>b.date ? 1 : a.start-b.start);
        const runs:Array<{fingerprint:string;owner:string | null;date:string;start:number;end:number;ids:string[]}>=[];
        for (const row of rows) {
          const run=runs.at(-1);
          // 위치가 안전한 정수가 아닌 행은 구간으로 바꿀 수 없다. 이전처럼 행만 지운다.
          if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end)) {remove.run(row.id);continue;}
          if (run && run.fingerprint===row.fingerprint && run.owner===row.owner && run.date===row.date && row.start<=run.end) {
            run.end=Math.max(run.end,row.end);run.ids.push(row.id);
          } else runs.push({fingerprint:row.fingerprint,owner:row.owner,date:row.date,start:row.start,end:row.end,ids:[row.id]});
        }
        // 시간 예산은 구간마다 본다(줄 사이가 자주 끊기면 한 묶음도 수백 ms가 걸린다). 한 번 압축에 구간 하나는 반드시 처리해
        // 앞으로 나아가고, 쓰지 못한 구간의 행은 남겨 다음 압축이 다시 고른다.
        for (const run of runs) {
          if (wrote && performance.now()>=deadline) return;
          this.extendRange(run.owner ? 'applied' : 'ignored',run.owner,run.fingerprint,run.date,run.start,run.end,pathOf(run.fingerprint));
          for (const id of run.ids) remove.run(id);
          wrote=true;
        }
      }
    } finally {
      if (ownProbe) {this.fileProbe?.close();this.fileProbe=undefined;}
    }
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
      // 반영 구간도 일지가 정리한 날짜 이전 것은 지운다(그 날짜의 일지 행이 없으므로 다시 기록돼도 이중 집계가 아니다).
      this.database.prepare("DELETE FROM log_ranges WHERE state='applied' AND log_date<?").run(prunedBefore);
      // 체크포인트가 비우지 못한(삭제된 프로필 등) 오래된 HUD 복원 구간도 같은 기준으로 지운다.
      this.database.prepare('DELETE FROM profile_runtime_ranges WHERE log_date<?').run(prunedBefore);
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

  close(): void {
    try {this.flushDeferredRange();} catch {/* 종료: 미룬 구간은 경험치 줄뿐이라 잃어도 기록은 그대로다. */}
    this.logUnwrittenDeferredRange('종료');
    this.deferredRange=undefined;
    if (this.database.open) this.database.close();
  }
}
