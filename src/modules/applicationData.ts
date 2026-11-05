/**
 * 기능 계약 — 로컬 플레이 데이터의 단일 원본
 * 프로필/설정/숙제와 변경 이력을 같은 SQLite 트랜잭션으로 확정한다. 모험일지는 같은 파일에
 * 보존하되 변경 outbox에 넣지 않는다. 기존 diary.db는 SQLite online backup으로 staging에
 * 복제하고 원본 테이블 건수/합계를 검증한 뒤 게시한다. 기존 사용자 폴더를 테스트에 쓰지 않는다.
 * 초기화는 새 DB의 완료 marker로 멱등이며, 알 수 없는 새 스키마/손상은 빈 DB로 덮지 않는다.
 * 회귀: scripts/check-profile-storage.ts. 통합 상태: docs/development/profile-storage.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID,createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import Database = require('better-sqlite3');
import {loadChatLogSyncStateAtPath} from './chatLogSyncState';
import {ensureDiaryAttribution} from './diaryAttribution';
import {isProfileToolKey,PROFILE_TOOL_KEYS} from '../shared/profileTools';
import {prepareProfileSyncSchema,captureProfileSyncChanges,ProfileSyncModel,rememberProfileHomeworkDeletion} from './profileSyncModel';
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
interface HomeworkRow { item_id: string; definition: string; state: string; position: number }

function writeAtomic(file: string, value: unknown): void {
  writeAtomicText(file,json(value));
}

function writeAtomicText(file: string, value: string): void {
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
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
        CREATE TABLE IF NOT EXISTS profile_log_source_ranges(fingerprint TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,profile_id TEXT REFERENCES play_profiles(id),PRIMARY KEY(fingerprint,start_offset));
        CREATE TABLE IF NOT EXISTS profile_log_legacy_aggregates(fingerprint TEXT PRIMARY KEY,profile_id TEXT NOT NULL REFERENCES play_profiles(id),value TEXT NOT NULL);`);
      // 기존 JSON의 증거도 DB에 한 번 보관해 ZIP/다른 PC 복원에서 진행 기준이 바뀌지 않게 한다.
      if (!this.database.prepare("SELECT 1 FROM app_meta WHERE key='legacy_chat_log_sync_state'").get()) {
        this.database.prepare('INSERT INTO app_meta VALUES(?,?)').run('legacy_chat_log_sync_state',JSON.stringify(loadChatLogSyncStateAtPath(this.options.directory)));
      }
      this.database.exec('CREATE TABLE IF NOT EXISTS profile_event_receipts(event_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,occurred_at INTEGER NOT NULL,payload_hash TEXT NOT NULL,assigned_profile_id TEXT,resolved_at INTEGER NOT NULL)');
      this.database.exec('CREATE INDEX IF NOT EXISTS idx_profile_events_resolved ON pending_profile_events(resolved_at)');
      this.ensureDiaryAttribution();
      prepareProfileSyncSchema(this.database);
      this.database.transaction(() => {
        new ProfileSyncModel(this.database,this.options.deviceId,this.clock);
        const repaired=this.fillMissingDefaultHomework();
        captureProfileSyncChanges(this.database,this.options.deviceId,this.clock(),repaired>0);
      })();
    } catch (error) {
      if (this.database.open) this.database.close();
      throw error;
    }
  }

  static async initialize(options: ProfileStoreOptions, legacy: AppConfig,serverEvidence?:{value:unknown}): Promise<ApplicationData> {
    if (!options.deviceId || options.deviceId.length > 200) throw new Error('기기 식별자가 올바르지 않습니다.');
    fs.mkdirSync(options.directory, { recursive: true });
    const target = path.join(options.directory, 'app-data.db');
    if (fs.existsSync(target)) return new ApplicationData(options);
    // 매 시도마다 고유 staging/backup. 실패한 산출물은 다음 실행의 원본 후보가 아니다.
    const attempt = randomUUID();
    const staging = path.join(options.directory, `app-data-migration-${attempt}.db`);
    const backup = path.join(options.directory, 'backups', `before-play-profiles-${attempt}`);
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
        // 기존 선택 대기는 캐릭터를 추측해서 배정하지 않는다.
        for (const pending of legacy.pendingHomeworks || []) {
          db.prepare('INSERT INTO pending_profile_events(event_id,session_id,occurred_at,payload) VALUES(?,?,?,?)')
            .run(randomUUID(), 'legacy-unassigned', pending.timestamp, json({ kind: 'legacy-homework', value: pending }));
        }
        for (const [table, old] of Object.entries(expected)) {
          if (tableSummary(db)[table]?.count !== old.count) throw new Error(`기존 ${table} 건수 검증 실패`);
          if (tableSummary(db)[table]?.amount !== old.amount) throw new Error(`기존 ${table} 금액 검증 실패`);
        }
        db.prepare('INSERT INTO app_meta VALUES(?,?)').run('schema_version', String(SCHEMA));
        db.prepare('INSERT INTO app_meta VALUES(?,?)').run('legacy_migration_complete', json({ backup, tables: expected }));
      })();
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('프로필 DB 무결성 검증 실패');
    } finally { db.close(); }
    fs.renameSync(staging, target);
    return new ApplicationData(options);
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
    this.database.prepare('INSERT INTO profile_change_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),this.options.deviceId,sequence,profileId,scope,field,operation,json(value),
        clock.utcMs,clock.source,clock.uncertaintyMs,revision);
    this.database.prepare('INSERT INTO profile_revisions VALUES(?,?,?) ON CONFLICT(scope,profile_id) DO UPDATE SET revision=excluded.revision')
      .run(scope,revisionKey,revision+1);
  }
  private syncTransaction<T>(write:()=>T):()=>T {
    return this.database.transaction(()=>{
      ++this.syncTransactionDepth;let result:T;
      try {result=write();} finally {--this.syncTransactionDepth;}
      if (!this.syncTransactionDepth) captureProfileSyncChanges(this.database,this.options.deviceId,this.clock(),this.automaticSyncChange);
      return result;
    });
  }

  get syncDeviceId():string {return this.options.deviceId;}
  syncClock():ProfileClockStamp {return this.clock();}

  /** 배포 기본 숙제의 누락만 보충한다. 기존 정의/상태/정렬·커스텀 숙제는 수정하지 않는다.
   * 빈 기본값으로 만든 과거 프로필과 백업/다른 PC에서 온 빈 목록을 복구한다.
   * 명시적 삭제 이력과 영구 동기화 삭제 표식은 존중해 삭제 항목을 부활시키지 않는다.
   * 원본과 복구 전송 대기는 같은 transaction으로 확정한다.
   * 회귀: check-profile-homework-defaults.ts (실제 contents.json/부팅/별도 프로세스 재시작). */
  ensureDefaultHomework():number {
    return this.withAutomaticSyncChange(()=>this.syncTransaction(()=>this.fillMissingDefaultHomework())());
  }
  private fillMissingDefaultHomework():number {
    const defaults=this.options.defaults.contentsCheckerItems || [];if (!defaults.length)return 0;
    const deleted=new Map<string,Set<string>>();
    const remember=(profile:string,item:string)=>{if(!deleted.has(profile))deleted.set(profile,new Set());deleted.get(profile)!.add(item);};
    for(const row of this.database.prepare("SELECT profile_id,field FROM profile_change_log WHERE scope='homework' AND operation='delete'").all() as {profile_id:string;field:string}[])remember(row.profile_id,row.field);
    const ids=new Map((this.database.prepare('SELECT local_id,remote_id FROM profile_sync_ids').all() as {local_id:string;remote_id:string}[]).map(row=>[row.remote_id,row.local_id]));
    for(const row of this.database.prepare('SELECT key FROM profile_sync_tombstones').all() as {key:string}[]) {
      const parts=JSON.parse(row.key) as string[],local=ids.get(parts[1]);
      if(local && parts[0]==='homework' && parts[3]==='deleted')remember(local,parts[2]);
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
      if (copySettingsFrom) for (const [key,value] of Object.entries(this.toolValues(copySettingsFrom))) this.saveToolValue(id,key,value);
      for (const item of this.homework(id)) this.change(id,'homework',item.id,'create',item);
    })();
    return this.requireProfile(id);
  }

  update(id: string, name: string, userServer: number): void {
    assertProfileName(name);
    if (!isProfileServer(userServer)) throw new Error('서버를 선택하세요.');
    this.syncTransaction(() => {
      this.requireProfile(id);
      this.database.prepare('UPDATE play_profiles SET name=? WHERE id=?').run(name.trim(),id);
      this.database.prepare('INSERT INTO profile_settings VALUES(?,?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value=excluded.value')
        .run(id,'userServer',json(userServer));
      this.change(id,'profile','metadata','set',{ name:name.trim(),userServer });
    })();
  }

  remove(id: string): void {
    this.syncTransaction(() => {
      this.requireProfile(id);
      this.database.prepare('UPDATE play_profiles SET deleted_at=? WHERE id=?').run(Date.now(),id);
      this.database.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(id);
      this.database.prepare("DELETE FROM profile_settings WHERE profile_id=? AND key<>'userServer'").run(id);
      this.database.prepare('DELETE FROM profile_local_state WHERE profile_id=?').run(id);
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
  saveRuntimeState(id:string,value:unknown):void {
    this.requireProfile(id);
    this.database.prepare('INSERT INTO profile_runtime_state VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET value=excluded.value').run(id,json(value));
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
    if (!isProfileToolKey(key) || value!==null && (typeof value!=='string' || value.length>20*1024*1024)) throw new Error('지원하지 않는 계산기 저장 값입니다.');
    this.syncTransaction(() => {
      const previous=this.database.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(id,key) as {value:string} | undefined;
      if ((previous?.value ?? null)===value) return;
      if (value===null) this.database.prepare('DELETE FROM profile_tools WHERE profile_id=? AND key=?').run(id,key);
      else this.database.prepare('INSERT INTO profile_tools VALUES(?,?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value=excluded.value').run(id,key,value);
      this.change(id,'profile-tool',key,value===null ? 'delete' : 'set',value);
    })();
  }
  migrateToolValues(values:Record<string,string | null>,force=false):void {
    if (!force && this.database.prepare("SELECT 1 FROM app_meta WHERE key='legacy_profile_tools_migrated'").get()) return;
    this.syncTransaction(() => {
      for (const profile of this.list()) for (const key of PROFILE_TOOL_KEYS) {
        if (force || values[key]!==undefined && values[key]!==null) this.saveToolValue(profile.id,key,values[key] ?? null);
      }
      this.database.prepare("INSERT OR REPLACE INTO app_meta VALUES('legacy_profile_tools_migrated','1')").run();
    })();
  }

  /** 구형 설정 백업의 다중 캐릭터를 복원한다. 기존 ID 매핑은 재사용하고
   * 더 이상 목록에 없는 프로필은 삭제 표식으로 남겨 일지 귀속을 보존한다.
   * 백업 staging 연결에서만 호출하며 활성 프로필/JSON은 호출자가 함께 교체한다. */
  restoreLegacyConfiguration(legacy:AppConfig,storedServer:unknown):string {
    return this.syncTransaction(() => {
      const characters=legacy.characterPresets?.length ? legacy.characterPresets : [{id:'',name:''}];
      if (characters.some(character => typeof character.id!=='string' || typeof character.name!=='string')) throw new Error('백업의 캐릭터 정보가 올바르지 않습니다.');
      if (new Set(characters.map(character => character.id)).size!==characters.length) throw new Error('백업의 캐릭터 ID가 중복되었습니다.');
      const selected=characters.find(character => character.id===legacy.selectedCharacterId) || characters[0];
      const ordered=[selected,...characters.filter(character => character!==selected)];
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
      for (const profile of this.list()) if (!restored.has(profile.id)) this.remove(profile.id);
      for (const pending of legacy.pendingHomeworks || []) {
        const payload={kind:'legacy-homework',value:pending};
        if (this.database.prepare('SELECT 1 FROM pending_profile_events WHERE payload=? LIMIT 1').get(json(payload))) continue;
        const eventId=`legacy-backup:${createHash('sha256').update(json(pending)).digest('hex')}`;
        this.enqueue('legacy-backup-homework',payload,pending.timestamp,eventId);
      }
      return first;
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
    const rows = this.database.prepare('SELECT * FROM profile_homework WHERE profile_id=? ORDER BY position,item_id').all(id) as HomeworkRow[];
    return rows.map(row => ({ ...JSON.parse(row.definition), completedState: { [id]: JSON.parse(row.state) } }));
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
        const previousMap = new Map(previous.map(item => [item.id,item]));
        const items = config.contentsCheckerItems || [];
        if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('숙제 ID가 중복되었습니다.');
        this.database.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(id);
        items.forEach((item,position) => {
          const { completedState, ...definition } = item;
          const state: HomeworkState | undefined = completedState?.[id];
          this.database.prepare('INSERT INTO profile_homework VALUES(?,?,?,?,?)').run(id,item.id,json(definition),json(state || {}),position);
          const old = previousMap.get(item.id);
          if (json(old) !== json(item) || previous.findIndex(p => p.id === item.id) !== position) {
            this.change(id,'homework',item.id,'set',{ definition,state:state || {},position });
          }
          previousMap.delete(item.id);
        });
        for (const removed of previousMap.keys()) this.change(id,'homework',removed,'delete',null);
      }
      this.database.prepare('INSERT INTO profile_local_state VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET value=excluded.value')
        .run(id,json({ pendingHomeworks:config.pendingHomeworks || [],lastContentsResetCheck:config.lastContentsResetCheck }));
    })();
  }

  hasEvent(eventId:string):boolean {return !!this.database.prepare('SELECT 1 FROM pending_profile_events WHERE event_id=? UNION ALL SELECT 1 FROM profile_event_receipts WHERE event_id=? LIMIT 1').get(eventId,eventId);}

  /** 완료 후 30일이 지난 원문만 줄이고 재시도 검증용 영수증은 유지한다. 미배정은 삭제하지 않는다. */
  compactResolvedEvents(now=Date.now()):number {
    return this.database.transaction(()=>{
      const rows=this.database.prepare('SELECT * FROM pending_profile_events WHERE resolved_at IS NOT NULL AND resolved_at<? LIMIT 1000').all(now-30*86400000) as {event_id:string;session_id:string;occurred_at:number;payload:string;assigned_profile_id:string | null;resolved_at:number}[];
      const insert=this.database.prepare('INSERT INTO profile_event_receipts VALUES(?,?,?,?,?,?)'),remove=this.database.prepare('DELETE FROM pending_profile_events WHERE event_id=?');
      for (const row of rows) {insert.run(row.event_id,row.session_id,row.occurred_at,createHash('sha256').update(row.payload).digest('hex'),row.assigned_profile_id,row.resolved_at);remove.run(row.event_id);}
      return rows.length;
    })();
  }

  enqueue(sessionId: string, payload: unknown, occurredAt: number, eventId: string = randomUUID()): string {
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
    this.database.prepare('INSERT OR IGNORE INTO pending_profile_events(event_id,session_id,occurred_at,payload) VALUES(?,?,?,?)')
      .run(eventId,sessionId,occurredAt,json(payload));
    return eventId;
  }

  pending(sessionId?: string): { eventId: string; sessionId: string; occurredAt: number; payload: unknown }[] {
    const rows = this.database.prepare(`SELECT * FROM pending_profile_events WHERE resolved_at IS NULL ${sessionId ? 'AND session_id=?' : ''} ORDER BY occurred_at,rowid`)
      .all(...(sessionId ? [sessionId] : [])) as { event_id: string; session_id: string; occurred_at: number; payload: string }[];
    return rows.map(r => ({ eventId:r.event_id,sessionId:r.session_id,occurredAt:r.occurred_at,payload:JSON.parse(r.payload) }));
  }

  pendingSessions(): Array<{sessionId:string;count:number;firstOccurredAt:number;lastOccurredAt:number}> {
    return (this.database.prepare('SELECT session_id,COUNT(*) AS count,MIN(occurred_at) AS first,MAX(occurred_at) AS last FROM pending_profile_events WHERE resolved_at IS NULL GROUP BY session_id ORDER BY first,session_id')
      .all() as {session_id:string;count:number;first:number;last:number}[]).map(row => ({sessionId:row.session_id,count:row.count,firstOccurredAt:row.first,lastOccurredAt:row.last}));
  }

  pendingSessionSnapshot(sessionId:string):{token:string;count:number;firstOccurredAt:number;lastOccurredAt:number} | null {
    const hash=createHash('sha256');let count=0,firstOccurredAt=Infinity,lastOccurredAt=-Infinity;
    const rows=this.database.prepare('SELECT event_id,occurred_at,payload FROM pending_profile_events WHERE session_id=? AND resolved_at IS NULL ORDER BY rowid').iterate(sessionId) as Iterable<{event_id:string;occurred_at:number;payload:string}>;
    for(const row of rows) {
      hash.update(json([row.event_id,row.occurred_at,row.payload]));++count;
      firstOccurredAt=Math.min(firstOccurredAt,row.occurred_at);lastOccurredAt=Math.max(lastOccurredAt,row.occurred_at);
    }
    return count ? {token:hash.digest('hex'),count,firstOccurredAt,lastOccurredAt} : null;
  }

  /** 명시적으로 확인한 과거 대기 집합만 무시한다. 원문을 삭제하거나 숙제/일지/프로필에 적용하지 않는다.
   * 확인 중 새 기록·같은 개수의 다른 원문으로 바뀌면 전체 실패한다. 반복 요청은 이미 처리한 경우 0건이다.
   * resolved_at + 배정 대상 null로 보관해 재시작/동일 ID 재수신에도 다시 대기하지 않으며, 기존 30일 이후
   * 원문 압축은 해시 영수증을 남긴다. 회귀: check-profile-storage.ts, check-profiles-ui.ts. */
  ignorePendingSession(sessionId:string,snapshotToken:string):number {
    if(!sessionId || !/^[a-f0-9]{64}$/.test(snapshotToken))throw new Error('대기 기록을 다시 확인해 주세요.');
    return this.database.transaction(()=>{
      const current=this.pendingSessionSnapshot(sessionId);
      if(!current)return 0;
      if(current.token!==snapshotToken)throw new Error('대기 기록이 변경되었습니다. 내용을 다시 확인한 뒤 무시해 주세요.');
      return this.database.prepare('UPDATE pending_profile_events SET assigned_profile_id=NULL,resolved_at=? WHERE session_id=? AND resolved_at IS NULL').run(Date.now(),sessionId).changes;
    }).immediate();
  }

  /** apply는 같은 database 연결을 사용해야 한다. 콜백 실패 시 반영과 ACK를 함께 취소한다. */
  assignPending(sessionId: string, profileId: string, apply: (payload: unknown, eventId: string) => void): number {
    return this.database.transaction(() => {
      this.requireProfile(profileId);
      const rows = this.pending(sessionId);
      for (const row of rows) {
        apply(row.payload,row.eventId);
        this.database.prepare('UPDATE pending_profile_events SET assigned_profile_id=?,resolved_at=? WHERE event_id=? AND resolved_at IS NULL')
          .run(profileId,Date.now(),row.eventId);
      }
      return rows.length;
    })();
  }

  close(): void { if (this.database.open) this.database.close(); }
}
