/**
 * 기능 계약 — 모험일지 SQLite 저장소
 *
 * - 실시간 파서, 과거 로그 동기화, 숙제, 알람, 타이머가 공유하는 영구 기록의 단일 원본입니다.
 *   UI용 조회가 누락 데이터를 추정해 쓰지 않으며 모든 쓰기는 이 모듈의 중복 방지 규칙을 거칩니다.
 * - 로그 재생에 안전하도록 가능한 활동은 안정적인 source event ID로 멱등 저장합니다. 같은 초에 내용이
 *   같은 실제 획득 로그가 여러 줄 존재할 수 있으므로 단순 `date+time+content`만으로 한 배치 안의 서로
 *   다른 이벤트를 합치면 안 됩니다.
 * - 경험의 정수는 일반 `lootKeywords`와 무관하게 저장되고 월간 통계·오늘 요약 집계에 남습니다.
 *   다만 일반 득템 설정 대상이 아니므로 모험일지 3번째 '득템 기록' 목록에서는 항상 숨깁니다.
 *   `룬 경험의 심장` 같은 이름은 자동 별칭으로 확장하지 않고 정확한 품목 정책을 따릅니다.
 * - SEED/ELSO처럼 고빈도 누적값은 메모리 버퍼와 복구 journal을 사용하므로 정상 종료·비정상 종료 모두
 *   금액을 보존해야 합니다. DB 마이그레이션은 기존 행을 삭제하거나 재작성하지 않는 방향으로 수행합니다.
 *   수동 수익은 `content`가 표시 문구이고 `amount`가 통계 원본입니다. 과거 UI 누락으로 `amount=0`인
 *   수동 수익만 표시 문구의 마지막 괄호 금액에서 1회 복구하며 다른 활동 행은 추정하지 않습니다.
 *   마정석 계산기의 0원 기록은 정확한 원문 형식과 주머니 수×50만 SEED가 표시 금액과 일치할 때만 복구합니다.
 * - 완료된 채팅 로그를 다시 분석할 때는 파일 전체 분석과 최종 snapshot 검증이 성공한 날짜만 채팅 로그
 *   기반 자동 활동·외치기를 같은 트랜잭션에서 교체합니다. 과거 숙제도 `chat-log-sync` 출처만 별도
 *   트랜잭션으로 교체하며, `source='manual'`인 일지와 체크리스트 숙제·메모·알람 원본은 삭제하지 않습니다.
 *   분석 실패 시 교체 함수 자체를 호출하지 않아 기존 기록을 보존합니다.
 * - 알람 이력의 `scheduledAt`, `recordedAt`, `deliveryStatus`, `dedupeKey`는 실제 실행과 절전 중 누락을
 *   구분하는 계약입니다. 조회용 필터 변경이 원본 행 삭제로 이어져서는 안 됩니다.
 * - 프로필 저장소가 연결되면 설정/대기 이벤트와 동일한 app-data.db 연결만 사용합니다. 기존/귀속 불명
 *   기록은 NULL로 남고 기록된 프로필의 이름이나 서버 변경·삭제로 재배정하지 않습니다. 날짜별 금화·엘소·
 *   마정석, 숙제 중복 키와 점수/완료 통계도 프로필 경계를 유지합니다. 전체 보기는 이를 합산합니다.
 * - 금화/엘소 버퍼는 입력 때의 프로필·기기·세션을 붙이고 복구 journal v2에 보존합니다. v1의 소유자는
 *   추정하지 않습니다. 대기 이벤트의 외부 transaction 안에서는 메모리/파일에 미루지 않고 같은 DB에
 *   기록하며 실패를 상위로 전달해 일지·설정·ACK가 함께 rollback되게 합니다.
 * - source ID는 전체 프로필에서 중복 방지하되 동일 프로필의 완료 snapshot 재구성은 허용합니다.
 *   자동 기록/숙제의 날짜 교체는 대상 프로필에 한정합니다. 조회·통계·내보내기의 기본 범위는 전체이며
 *   프로필/미배정 필터가 원본 변경이나 빈 날짜 생성으로 이어지지 않습니다. 다른 프로필의 득템에는
 *   그 프로필의 키워드를 사용하고, 삭제되어 설정이 없으면 보존된 원본을 표시합니다.
 * - 회귀: check-profile-diary.ts, check-profile-storage.ts, check-magic-stone-revenue.ts 및
 *   check-refactor-regressions.ts의 실제 worker/완료 snapshot 검사. 실제 앱 부팅 통합은 별도 단계입니다.
 */
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import Database = require('better-sqlite3');
import { log } from './logger';
import { DiaryEntry, HomeworkLog, ActivityLog, DiaryData, AlarmLog, TimerRecord } from '../shared/types';
import { broadcastToAllWindows } from './windowMessaging';
import { formatLootDiaryContent, parseItemAcquisition } from './itemAcquisition';
import { formatLocalDateKey } from '../shared/localDate';
import { countsTowardLootTotal, isAlwaysTrackedLoot, matchesRegisteredLoot } from '../shared/lootPolicy';
import type { DiaryExportSnapshot, DiaryExportRow } from '../shared/companionFiles';
import {ensureDiaryAttribution} from './diaryAttribution';
import type {ApplicationData} from './applicationData';
import {ALL_DIARY_PROFILES,diaryProfilePredicate} from '../shared/diaryProfiles';
import type {DiaryRecordContext,DiaryProfileFilter} from '../shared/diaryProfiles';

let db: Database.Database | null = null;
let applicationData:ApplicationData | null=null;
let initializingDb=false;
const currentOwner=():DiaryRecordContext => !initializingDb && applicationData?.getRecordContext() || {profileId:null,deviceId:null,sessionId:null};

/** 기존 연결을 닫고 이전을 검증한 뒤 연결한다. 이후 조회/복원 재연결도 같은 app-data.db만 사용한다. */
export function connectApplicationData(store:ApplicationData):void {
  if (db || restoreSuspended) throw new Error('기존 일지 연결을 먼저 닫아 주세요.');
  if (applicationData && applicationData!==store) throw new Error('다른 프로필 저장소가 이미 연결되어 있습니다.');
  applicationData=store;
  initDb();
  if (!db) throw new Error('프로필 모험일지 저장소를 연결하지 못했습니다.');
}

function propagateTransactionFailure(error:unknown):void {
  // 일반 UI 호출은 기존 결과 타입을 유지한다. 외부 이벤트 transaction에서는 ACK 전에 실패시킨다.
  if (db?.inTransaction) throw error;
}

interface PendingDailyAmount extends DiaryRecordContext {date:string;latestTime:string;totalAmount:number}
const pendingKey=(entry:Pick<PendingDailyAmount,'date' | 'profileId' | 'deviceId' | 'sessionId'>) => JSON.stringify([entry.date,entry.profileId,entry.deviceId,entry.sessionId]);
const sameOwner=(row:{profile_id?:string | null},owner:DiaryRecordContext) => (row.profile_id ?? null)===owner.profileId;

function initializeProfileDays():void {
  if (!db) return;
  db.transaction(() => {
    db!.exec(`CREATE TABLE IF NOT EXISTS diary_profile_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diary_profile_days(
        date TEXT NOT NULL REFERENCES diaries(date),profile_id TEXT,
        total_score INTEGER NOT NULL DEFAULT 0,monster_id TEXT NOT NULL DEFAULT '',
        daily_done INTEGER NOT NULL DEFAULT 0,daily_total INTEGER NOT NULL DEFAULT 0,
        weekly_done INTEGER NOT NULL DEFAULT 0,weekly_total INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_diary_profile_days_key ON diary_profile_days(date,COALESCE(profile_id,''));
      DROP INDEX IF EXISTS idx_homework_logs_date_content_unique;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_homework_logs_profile_date_content_unique ON homework_logs(date,content_id,COALESCE(profile_id,''));
      DROP INDEX IF EXISTS idx_alarm_logs_dedupe_key_unique;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alarm_logs_profile_dedupe_key_unique ON alarm_logs(COALESCE(profile_id,''),dedupe_key) WHERE dedupe_key IS NOT NULL;`);
    if (!db!.prepare("SELECT 1 FROM diary_profile_meta WHERE key='legacy_days_migrated'").get()) {
      db!.exec(`INSERT INTO diary_profile_days(date,total_score,monster_id,daily_done,daily_total,weekly_done,weekly_total)
        SELECT date,total_score,monster_id,daily_done,daily_total,weekly_done,weekly_total FROM diaries;
        INSERT INTO diary_profile_meta VALUES('legacy_days_migrated','1');`);
    }
    const columns=db!.prepare('PRAGMA table_info(chat_sync_committed_events)').all() as {name:string}[];
    if (!columns.some(item => item.name==='profile_id')) db!.exec('ALTER TABLE chat_sync_committed_events ADD COLUMN profile_id TEXT');
  })();
}

/** 날짜별 누적 행도 입력 당시의 프로필로 합산한다. 여러 세션/기기가 합쳐지면 해당 provenance만 null이다. */
function accumulateDailyAmount(type:'elso' | 'calc',content:string,entry:PendingDailyAmount):void {
  if (!db) throw new Error('DB가 초기화되지 않았습니다.');
  ensureDiaryExists(entry.date,entry.profileId);
  const existing=getStmt('SELECT id FROM activity_logs WHERE date=? AND type=? AND content=? AND profile_id IS ? ORDER BY id LIMIT 1')
    .get(entry.date,type,content,entry.profileId) as {id:number} | undefined;
  if (existing) {
    getStmt(`UPDATE activity_logs SET amount=COALESCE(amount,0)+?,time=MAX(time,?),
      record_device_id=CASE WHEN record_device_id IS ? THEN record_device_id ELSE NULL END,
      record_session_id=CASE WHEN record_session_id IS ? THEN record_session_id ELSE NULL END WHERE id=?`)
      .run(entry.totalAmount,entry.latestTime,entry.deviceId,entry.sessionId,existing.id);
  } else {
    getStmt(`INSERT INTO activity_logs(date,type,content,time,amount,source,profile_id,record_uuid,record_device_id,record_session_id)
      VALUES(?,?,?,?,?,'automatic',?,?,?,?)`).run(entry.date,type,content,entry.latestTime,entry.totalAmount,
        entry.profileId,randomUUID(),entry.deviceId,entry.sessionId);
    if (type==='calc') addScore(entry.date,POINTS.CALC_RECORD,entry.profileId);
  }
}

// 포인트 산정 규칙
const POINTS = {
  DAILY_HOMEWORK: 10,
  WEEKLY_HOMEWORK: 0, // 주간 숙제는 포인트 제외
  BOSS_KILL: 10,
  CALC_RECORD: 10
};

/** 엘소 포인트 인메모리 버퍼 (날짜·입력 당시 귀속별 누적 및 3초 디바운스 저장) */
const ELSO_FLUSH_DEBOUNCE_MS = 3000;
let _elsoDebounceTimer: NodeJS.Timeout | null = null;
const _pendingElsoByDate = new Map<string,PendingDailyAmount>();

/** 금화 주머니 환산 SEED 인메모리 버퍼 (날짜·프로필별 합산 및 3초 디바운스 저장) */
const GOLD_POUCH_FLUSH_DEBOUNCE_MS = 3000;
export const GOLD_POUCH_DAILY_CONTENT = '[자동] 금화 주머니 환산';
let _goldPouchDebounceTimer: NodeJS.Timeout | null = null;
const _pendingGoldPouchSeedByDate = new Map<string,PendingDailyAmount>();

export function migrateAlarmLogsV4(database: Database.Database): void {
  const alarmColumns = database.prepare('PRAGMA table_info(alarm_logs)').all() as Array<{ name: string }>;
  if (!alarmColumns.some(column => column.name === 'scheduled_at')) {
    database.exec('ALTER TABLE alarm_logs ADD COLUMN scheduled_at INTEGER');
  }
  if (!alarmColumns.some(column => column.name === 'recorded_at')) {
    database.exec('ALTER TABLE alarm_logs ADD COLUMN recorded_at INTEGER');
  }
  if (!alarmColumns.some(column => column.name === 'delivery_status')) {
    database.exec("ALTER TABLE alarm_logs ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'fired'");
  }
  if (!alarmColumns.some(column => column.name === 'dedupe_key')) {
    database.exec('ALTER TABLE alarm_logs ADD COLUMN dedupe_key TEXT');
  }
  if (!alarmColumns.some(column => column.name==='profile_id')) database.exec('ALTER TABLE alarm_logs ADD COLUMN profile_id TEXT');
  database.exec(`
    UPDATE alarm_logs
    SET scheduled_at = COALESCE(scheduled_at, timestamp),
        recorded_at = COALESCE(recorded_at, timestamp),
        delivery_status = COALESCE(delivery_status, 'fired');
    DROP INDEX IF EXISTS idx_alarm_logs_dedupe_key_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alarm_logs_profile_dedupe_key_unique
    ON alarm_logs (COALESCE(profile_id,''),dedupe_key)
    WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_alarm_logs_recorded_at
    ON alarm_logs (recorded_at);
  `);
}

interface ElsoRecoveryJournal {
  schemaVersion: 1 | 2;
  operationId: string;
  createdAt: number;
  entries: PendingDailyAmount[];
}

function recoveryOwner(entry:Partial<DiaryRecordContext>,version:1 | 2):DiaryRecordContext {
  if (version===1) return {profileId:null,deviceId:null,sessionId:null};
  for (const key of ['profileId','deviceId','sessionId'] as const) {
    if (entry[key]!==null && (typeof entry[key]!=='string' || !entry[key] || entry[key]!.length>200)) throw new Error('복구 기록의 프로필 정보가 유효하지 않습니다.');
  }
  return {profileId:entry.profileId!,deviceId:entry.deviceId!,sessionId:entry.sessionId!};
}

export function getElsoRecoveryJournalPath(): string {
  return path.join(app.getPath('userData'), 'elso-recovery.json');
}

function validateElsoRecoveryJournal(value: unknown): ElsoRecoveryJournal {
  if (!value || typeof value !== 'object') throw new Error('복구 기록이 객체가 아닙니다.');
  const journal = value as Partial<ElsoRecoveryJournal>;
  if ((journal.schemaVersion !== 1 && journal.schemaVersion !== 2) || typeof journal.operationId !== 'string' || journal.operationId.length < 8) {
    throw new Error('복구 기록 메타데이터가 유효하지 않습니다.');
  }
  if (!Number.isFinite(journal.createdAt) || !Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('복구 기록 항목이 유효하지 않습니다.');
  }
  const entries = journal.entries.map(entry => {
    if (
      !entry || typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      || typeof entry.latestTime !== 'string'
      || !Number.isSafeInteger(entry.totalAmount) || entry.totalAmount <= 0
    ) {
      throw new Error('복구 기록에 잘못된 엘소 항목이 있습니다.');
    }
    return { date: entry.date, latestTime: entry.latestTime, totalAmount: entry.totalAmount,...recoveryOwner(entry,journal.schemaVersion!) };
  });
  return {
    schemaVersion: 2,
    operationId: journal.operationId,
    createdAt: journal.createdAt as number,
    entries
  };
}

function writeElsoRecoveryJournal(journal: ElsoRecoveryJournal): void {
  writeRecoveryJournal(getElsoRecoveryJournalPath(),journal);
}

function writeRecoveryJournal(file:string,journal:ElsoRecoveryJournal | GoldPouchRecoveryJournal):void {
  const temp=`${file}.tmp`;
  const fd=fs.openSync(temp,'w',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(journal),'utf8');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(temp,file);
}

function applyElsoRecoveryOperation(journal: ElsoRecoveryJournal): boolean {
  if (!db) throw new Error('DB가 초기화되지 않았습니다.');
  let applied = false;
  db.transaction(() => {
    const operationResult = db!.prepare(`
      INSERT OR IGNORE INTO elso_flush_operations (operation_id, committed_at)
      VALUES (?, ?)
    `).run(journal.operationId, Date.now());
    if (operationResult.changes === 0) return;

    for (const entry of journal.entries) {
      accumulateDailyAmount('elso','엘소 포인트 획득',entry);
    }
    applied = true;
  })();
  return applied;
}

/** 남아 있는 엘소 복구 기록을 operation ID 기준 정확히 한 번 적용한다. */
export function replayElsoRecoveryJournal(): boolean {
  const journalPath = getElsoRecoveryJournalPath();
  if (!fs.existsSync(journalPath)) return true;
  if (!db) return false;
  let journal: ElsoRecoveryJournal;
  try {
    journal = validateElsoRecoveryJournal(JSON.parse(fs.readFileSync(journalPath, 'utf8')) as unknown);
  } catch (error) {
    const quarantinePath = `${journalPath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(journalPath, quarantinePath);
      log(`[DiaryDB] Invalid Elso recovery journal quarantined: ${quarantinePath} (${error})`);
    } catch (quarantineError) {
      log(`[DiaryDB] Invalid Elso recovery journal quarantine failed: ${quarantineError}`);
      return false;
    }
    return true;
  }

  try {
    const applied = applyElsoRecoveryOperation(journal);
    try {
      fs.unlinkSync(journalPath);
    } catch (cleanupError) {
      // operation ID가 DB에 있으므로 파일이 남아 재생돼도 중복 반영되지 않는다.
      log(`[DiaryDB] Elso recovery journal cleanup deferred: ${cleanupError}`);
    }
    log(`[DiaryDB] Elso recovery journal ${applied ? 'replayed' : 'already committed'}: ${journal.operationId}`);
    if (applied) notifyUpdate();
    return true;
  } catch (error) {
    log(`[DiaryDB] Elso recovery journal replay failed: ${error}`);
    return false;
  }
}

/** 일지 창 및 오늘의 요약에 갱신 신호를 보냅니다. */
function notifyUpdate(): void {
  broadcastToAllWindows('diary-updated');
}

/** 1초(1000ms) 쓰로틀링을 적용하여 초당 수십 건의 이벤트가 들어와도 UI 갱신 신호는 최대 1초에 1회만 발송합니다. */
let _lastNotifyTime = 0;
let _notifyThrottleTimer: NodeJS.Timeout | null = null;
function throttleNotifyUpdate(delayMs = 1000): void {
  const now = Date.now();
  if (now - _lastNotifyTime >= delayMs) {
    _lastNotifyTime = now;
    if (_notifyThrottleTimer) {
      clearTimeout(_notifyThrottleTimer);
      _notifyThrottleTimer = null;
    }
    notifyUpdate();
  } else if (!_notifyThrottleTimer) {
    const wait = delayMs - (now - _lastNotifyTime);
    _notifyThrottleTimer = setTimeout(() => {
      _lastNotifyTime = Date.now();
      _notifyThrottleTimer = null;
      notifyUpdate();
    }, wait);
  }
}

/** 대기 중인 엘소 포인트가 있는지 여부 */
export function hasPendingElso(): boolean {
  return _pendingElsoByDate.size > 0 || fs.existsSync(getElsoRecoveryJournalPath());
}

/** 인메모리 버퍼에 대기 중인 엘소 포인트를 DB에 즉시 1회 트랜잭션으로 커밋합니다. */
export function flushPendingElso(): boolean {
  if (db?.inTransaction && hasPendingElso()) throw new Error('대기 중인 엘소 기록을 프로필 전환 전에 저장해 주세요.');
  if (_elsoDebounceTimer) {
    clearTimeout(_elsoDebounceTimer);
    _elsoDebounceTimer = null;
  }
  if (_notifyThrottleTimer) {
    clearTimeout(_notifyThrottleTimer);
    _notifyThrottleTimer = null;
  }
  if (_pendingElsoByDate.size === 0) {
    if (!db && fs.existsSync(getElsoRecoveryJournalPath())) initDb();
    return replayElsoRecoveryJournal();
  }
  if (!db) initDb();
  if (!db) return false;

  // 이전 실패/종료에서 남은 연산을 먼저 해결해야 새 버퍼와 중복되지 않는다.
  if (!replayElsoRecoveryJournal()) return false;

  const entries = Array.from(_pendingElsoByDate.entries());
  _pendingElsoByDate.clear();
  const journal: ElsoRecoveryJournal = {
    schemaVersion: 2,
    operationId: randomUUID(),
    createdAt: Date.now(),
    entries: entries
      .filter(([, info]) => info.totalAmount > 0)
      .map(([,info]) => ({...info}))
  };

  if (journal.entries.length === 0) return true;

  let journalWritten = false;
  try {
    writeElsoRecoveryJournal(journal);
    journalWritten = true;
    applyElsoRecoveryOperation(journal);
    try {
      fs.unlinkSync(getElsoRecoveryJournalPath());
    } catch (cleanupError) {
      // DB에는 operation ID가 함께 커밋되어 다음 실행의 재생이 중복 반영되지 않는다.
      log(`[DiaryDB] Elso recovery journal cleanup deferred: ${cleanupError}`);
    }
    notifyUpdate();
    return true;
  } catch (error) {
    if (!journalWritten) {
      // journal 자체를 만들지 못한 경우에만 메모리 버퍼로 복원한다.
      for (const [date, info] of entries) {
        const current = _pendingElsoByDate.get(date) || {...info,totalAmount:0};
        current.totalAmount += info.totalAmount;
        current.latestTime = info.latestTime;
        _pendingElsoByDate.set(date, current);
      }
    }
    // journal 생성 후 실패했다면 디스크 기록을 다음 실행의 단일 원본으로 유지한다.
    log(`[DiaryDB] flushPendingElso failed: ${error}`);
    return false;
  }
}

const statementCache = new Map<string, Database.Statement>();

/** 캐시된 Prepared Statement 반환 (SQLite VDBE 재컴파일 방지) */
export function getStmt(sql: string): Database.Statement<any[]> {
  if (!db) initDb();
  if (!db) {
    throw new Error('DiaryDB가 초기화되지 않아 prepared statement를 만들 수 없습니다.');
  }
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt as Database.Statement<any[]>;
}

/** 주기적 또는 유휴 시 WAL 체크포인트 실행 */
export function checkpointWal(): void {
  if (!db) return;
  try {
    const result = db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>;
    log(`[DiaryDB] WAL Checkpoint executed: ${JSON.stringify(result)}`);
  } catch (err) {
    log(`[DiaryDB] WAL Checkpoint error: ${err}`);
  }
}

let restoreSuspended = false;

export function initDb(): void {
  if (restoreSuspended) return;
  if (db) return; // 이미 초기화된 경우 스킵
  initializingDb=true;
  try {
    let userDataPath = '';
    try {
      userDataPath = app ? app.getPath('userData') : '.';
    } catch (e) {
      userDataPath = '.';
    }
    if (applicationData) {applicationData.reopen();db=applicationData.database;}
    else db = new Database(path.join(userDataPath, 'diary.db'));

    // 외래 키 제약 조건 활성화 및 고성능 저널 모드 설정
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma(applicationData ? 'synchronous = FULL' : 'synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 1000');

    // 테이블 생성
    db.exec(`
      CREATE TABLE IF NOT EXISTS diaries (
        date TEXT PRIMARY KEY,
        total_score INTEGER DEFAULT 0,
        monster_id TEXT DEFAULT '',
        daily_done INTEGER DEFAULT 0,
        daily_total INTEGER DEFAULT 0,
        weekly_done INTEGER DEFAULT 0,
        weekly_total INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS homework_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        content_id TEXT NOT NULL,
        content_name TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        completed_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'checklist',
        FOREIGN KEY (date) REFERENCES diaries(date)
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        time TEXT NOT NULL,
        amount INTEGER DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'automatic',
        FOREIGN KEY (date) REFERENCES diaries(date)
      );

      CREATE TABLE IF NOT EXISTS shout_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL, -- Unix Timestamp
        sender TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS word_alarm_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alarm_timestamp INTEGER NOT NULL, -- Unix Timestamp
        keyword TEXT NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS word_alarm_chat_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alarm_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL, -- Unix Timestamp
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        color TEXT NOT NULL,
        FOREIGN KEY (alarm_id) REFERENCES word_alarm_history(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS hunting_grounds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image_path TEXT NOT NULL,
        zoom REAL NOT NULL,
        s REAL NOT NULL,
        ox REAL NOT NULL,
        oy REAL NOT NULL,
        fx REAL NOT NULL,
        fy REAL NOT NULL,
        is_swap INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hunting_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hunting_ground_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        color TEXT,
        FOREIGN KEY (hunting_ground_id) REFERENCES hunting_grounds(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS alarm_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        scheduled_at INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'fired',
        dedupe_key TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS timer_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        duration INTEGER NOT NULL,
        title TEXT DEFAULT '',
        series TEXT NOT NULL,
        core_master TEXT NOT NULL,
        coefficient REAL NOT NULL,
        char_main INTEGER NOT NULL DEFAULT 0,
        char_sub INTEGER NOT NULL DEFAULT 0,
        base_main INTEGER NOT NULL,
        enchant_main INTEGER NOT NULL,
        base_sub INTEGER NOT NULL,
        enchant_sub INTEGER NOT NULL,
        accuracy INTEGER NOT NULL,
        raw_profile_data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS elso_flush_operations (
        operation_id TEXT PRIMARY KEY,
        committed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gold_pouch_flush_operations (
        operation_id TEXT PRIMARY KEY,
        committed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sync_committed_events (
        event_id TEXT PRIMARY KEY,
        committed_at INTEGER NOT NULL
      );

      -- 성능 최적화 인덱스 생성
      CREATE INDEX IF NOT EXISTS idx_activity_logs_date_type ON activity_logs (date, type);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_date_time_content ON activity_logs (date, time, content);
      CREATE INDEX IF NOT EXISTS idx_shout_history_timestamp ON shout_history (timestamp);
      CREATE INDEX IF NOT EXISTS idx_shout_history_sender_msg ON shout_history (sender, message);
      CREATE INDEX IF NOT EXISTS idx_homework_logs_date_content ON homework_logs (date, content_id);
      CREATE INDEX IF NOT EXISTS idx_word_alarm_timestamp ON word_alarm_history (alarm_timestamp);
      CREATE INDEX IF NOT EXISTS idx_word_alarm_ctx_alarm_id ON word_alarm_chat_context (alarm_id);
      CREATE INDEX IF NOT EXISTS idx_alarm_logs_timestamp ON alarm_logs (timestamp);
      CREATE INDEX IF NOT EXISTS idx_timer_records_date ON timer_records (date);
    `);

    ensureDiaryAttribution(db,currentOwner);

    // PRAGMA user_version 기반 1회성 마이그레이션 관리 (매 부팅 시 풀스캔 제거)
    const userVersion = (db.pragma('user_version', { simple: true }) as number) || 0;

    if (userVersion < 1) {
      const migrateV1 = db.transaction(() => {
        const timerColumns = db!.prepare('PRAGMA table_info(timer_records)').all() as Array<{ name: string }>;
        if (!timerColumns.some(column => column.name === 'char_main')) {
          db!.exec('ALTER TABLE timer_records ADD COLUMN char_main INTEGER NOT NULL DEFAULT 0');
        }
        if (!timerColumns.some(column => column.name === 'char_sub')) {
          db!.exec('ALTER TABLE timer_records ADD COLUMN char_sub INTEGER NOT NULL DEFAULT 0');
        }

        const activityColumns = db!.prepare('PRAGMA table_info(activity_logs)').all() as Array<{ name: string }>;
        if (!activityColumns.some(column => column.name === 'amount')) {
          db!.exec('ALTER TABLE activity_logs ADD COLUMN amount INTEGER DEFAULT 0');
          migrateExistingData();
        }

        normalizeExistingLootContent(true);
        consolidateMagicStoneLogs(true);

        db!.prepare(`
          UPDATE hunting_grounds 
          SET image_path = 'assets/img/field-map/대장간.png',
              name = '시오칸하임 대장간'
          WHERE id = 'forge'
        `).run();
        db!.prepare(`
          UPDATE hunting_grounds 
          SET name = '골고다의 협곡'
          WHERE id = 'golgotha'
        `).run();
        db!.prepare(`
          UPDATE hunting_grounds 
          SET name = '공허의 영역'
          WHERE id = 'void'
        `).run();

        const huntingPathColumns = db!.prepare('PRAGMA table_info(hunting_paths)').all() as Array<{ name: string }>;
        if (!huntingPathColumns.some(column => column.name === 'color')) {
          db!.exec('ALTER TABLE hunting_paths ADD COLUMN color TEXT');
        }

        db!.prepare(`
          UPDATE homework_logs 
          SET content_id = replace(content_id, 'weekly-eclipse-boss-selfina', 'weekly-eclipse-boss-lokagos'),
              content_name = replace(content_name, '이클립스 (셀피나)', '이클립스 (로카고스)')
          WHERE content_id LIKE 'weekly-eclipse-boss-selfina%'
        `).run();
        db!.prepare(`
          UPDATE activity_logs 
          SET content = replace(content, '셀피나', '로카고스')
          WHERE content LIKE '%셀피나%'
        `).run();

        db!.prepare(`
          UPDATE homework_logs 
          SET content_id = replace(replace(content_id, 'weekly-ancient-relic-shinjo', 'weekly-ancient-relic'), 'weekly-ancient-relic-kishinik', 'weekly-ancient-relic'),
              content_name = '고대 렐릭의 성소 (신조/키시니크)'
          WHERE content_id LIKE 'weekly-ancient-relic-shinjo%' OR content_id LIKE 'weekly-ancient-relic-kishinik%'
        `).run();
        
        // 중복 일지 레코드 단일화 처리
        db!.prepare(`
          DELETE FROM homework_logs
          WHERE id NOT IN (
            SELECT latest.id
            FROM homework_logs AS latest
            WHERE latest.id = (
              SELECT candidate.id
              FROM homework_logs AS candidate
              WHERE candidate.date = latest.date AND candidate.content_id = latest.content_id AND candidate.profile_id IS latest.profile_id
              ORDER BY candidate.completed_at DESC, candidate.id DESC
              LIMIT 1
            )
          )
        `).run();

        db!.prepare(`
          UPDATE activity_logs 
          SET content = replace(replace(content, '고대 렐릭의 성소 (신조)', '고대 렐릭의 성소 (신조/키시니크)'), '고대 렐릭의 성소 (키시니크)', '고대 렐릭의 성소 (신조/키시니크)')
          WHERE content LIKE '%고대 렐릭의 성소 (신조)%' OR content LIKE '%고대 렐릭의 성소 (키시니크)%'
        `).run();
        deduplicateShoutHistoryOrThrow();
        db!.pragma('user_version = 1');
      });
      migrateV1();
      log('[DiaryDB] Version 1 migrations completed and user_version updated.');
    }

    if (userVersion < 2) {
      const migrateV2 = db.transaction(() => {
        const activityColumns = db!.prepare('PRAGMA table_info(activity_logs)').all() as Array<{ name: string }>;
        if (!activityColumns.some(column => column.name === 'source')) {
          db!.exec("ALTER TABLE activity_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy-unknown'");
        }

        // 날짜/숙제별 최신 완료 한 건과 그 메타데이터를 보존한다.
        db!.exec(`
          DELETE FROM homework_logs
          WHERE id NOT IN (
            SELECT latest.id
            FROM homework_logs AS latest
            WHERE latest.id = (
              SELECT candidate.id
              FROM homework_logs AS candidate
              WHERE candidate.date = latest.date AND candidate.content_id = latest.content_id
              ORDER BY candidate.completed_at DESC, candidate.id DESC
              LIMIT 1
            )
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_homework_logs_profile_date_content_unique
          ON homework_logs (date, content_id,COALESCE(profile_id,''));
        `);

        const insertGround = db!.prepare(`
          INSERT OR IGNORE INTO hunting_grounds
            (id, name, image_path, zoom, s, ox, oy, fx, fy, is_swap)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const defaultGrounds = [
          ['forge', '시오칸하임 대장간', 'assets/img/field-map/대장간.png', 2.0, 1.0, -340.0, 300.0, -1.0, 1.0, 1],
          ['golgotha', '골고다의 협곡', 'assets/img/field-map/골고다의협곡.png', 2.0, 1.0, -340.0, 300.0, -1.0, 1.0, 1],
          ['void', '공허의 영역', 'assets/img/field-map/공허의영역.png', 2.0, 1.0, -340.0, 300.0, -1.0, 1.0, 1],
        ] as const;
        defaultGrounds.forEach(ground => insertGround.run(...ground));
        db!.pragma('user_version = 2');
      });
      migrateV2();
      log('[DiaryDB] Version 2 migration completed: activity source, homework uniqueness, default hunting grounds.');
    }

    if (userVersion < 3) {
      let repairedUnitAmounts = 0;
      const migrateV3 = db.transaction(() => {
        // 과거 파서가 `1조`를 단위 합산한 뒤 raw fallback의 `1`로 다시 덮어쓸 수 있었다.
        // 숫자값(amount === 1)으로 추측하지 않고 원문의 괄호 안 금액에 단위가 있는 calc 행만 재계산한다.
        const rows = db!.prepare(`
          SELECT id, content, amount
          FROM activity_logs
          WHERE type = 'calc'
            AND (instr(content, '조') > 0 OR instr(content, '억') > 0 OR instr(content, '만') > 0)
        `).all() as Array<{ id: number; content: string; amount: number }>;
        const updateAmount = db!.prepare('UPDATE activity_logs SET amount = ? WHERE id = ?');

        for (const row of rows) {
          const amountText = row.content.match(/\(([^)]+)\)/u)?.[1];
          if (!amountText || !/[조억만]/u.test(amountText)) continue;
          const parsedAmount = parseMigrationNumber(amountText);
          if (parsedAmount <= 0 || parsedAmount === row.amount) continue;
          updateAmount.run(parsedAmount, row.id);
          repairedUnitAmounts++;
        }

        db!.pragma('user_version = 3');
      });
      migrateV3();
      log(`[DiaryDB] Version 3 migration completed: repaired ${repairedUnitAmounts} unit-bearing amount rows.`);
    }

    if (userVersion < 4) {
      const migrateV4 = db.transaction(() => {
        migrateAlarmLogsV4(db!);
        db!.pragma('user_version = 4');
      });
      migrateV4();
      log('[DiaryDB] Version 4 migration completed: structured alarm delivery metadata.');
    }
    if (userVersion < 5) {
      const migrateV5 = db.transaction(() => {
        const homeworkColumns = db!.prepare('PRAGMA table_info(homework_logs)').all() as Array<{ name: string }>;
        if (!homeworkColumns.some(column => column.name === 'source')) {
          // 기존 행은 사용자의 체크리스트 조작 또는 실시간 감지 결과일 수 있어 안전하게 보존한다.
          db!.exec("ALTER TABLE homework_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'checklist'");
        }
        db!.pragma('user_version = 5');
      });
      migrateV5();
      log('[DiaryDB] Version 5 migration completed: homework log source metadata.');
    }
    if (userVersion < 6) {
      let repairedManualRevenueAmounts = 0;
      const migrateV6 = db.transaction(() => {
        const rows = db!.prepare(`
          SELECT id, content
          FROM activity_logs
          WHERE type = 'calc'
            AND amount = 0
            AND content LIKE '💰 수익:%'
        `).all() as Array<{ id: number; content: string }>;
        const updateAmount = db!.prepare('UPDATE activity_logs SET amount = ? WHERE id = ?');

        for (const row of rows) {
          const amountText = row.content.match(/\(([^()]*)\)\s*$/u)?.[1];
          if (!amountText) continue;
          const amount = parseMigrationNumber(amountText);
          if (!Number.isSafeInteger(amount) || amount <= 0) continue;
          updateAmount.run(amount, row.id);
          repairedManualRevenueAmounts++;
        }

        db!.pragma('user_version = 6');
      });
      migrateV6();
      log(`[DiaryDB] Version 6 migration completed: repaired ${repairedManualRevenueAmounts} manual revenue rows.`);
    }
    initializeProfileDays();
    if (!replayElsoRecoveryJournal()) {
      throw new Error('엘소 복구 기록을 재생하지 못했습니다.');
    }
    if (!replayGoldPouchRecoveryJournal()) {
      throw new Error('금화 주머니 환산 SEED 복구 기록을 재생하지 못했습니다.');
    }
    // 기존 외치기 기록은 종류를 추측하지 않고 NULL로 유지한다.
    if (userVersion < 7) {
      db.transaction(() => {
        const columns = db!.prepare('PRAGMA table_info(shout_history)').all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === 'shout_kind')) db!.exec('ALTER TABLE shout_history ADD COLUMN shout_kind TEXT');
        db!.pragma('user_version = 7');
      })();
    }
    if (userVersion < 8) {
      // 기능 계약: 구버전 마정석 계산기가 금액 없이 저장한 원본만 보정한다.
      // 정확한 계산기 문구·양수 주머니 수·기록 금액이 50만 SEED 환산과 모두
      // 일치해야 한다. 이미 저장된 0 이외 금액·메모·불일치 문구는 보존한다.
      // 새 행이나 점수를 추가하지 않는다. check-magic-stone-revenue.ts 참고.
      db.transaction(() => {
        const rows = db!.prepare(`SELECT id,content FROM activity_logs
          WHERE type='calc' AND amount=0 AND source IN ('manual','legacy-unknown')
            AND content LIKE '💰 마정석 교환:%'`).all() as Array<{ id: number; content: string }>;
        const update = db!.prepare('UPDATE activity_logs SET amount=? WHERE id=?');
        for (const row of rows) {
          const match = row.content.match(/^💰 마정석 교환: ((?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*))개 \(([^()]+)\)$/u);
          if (!match) continue;
          const pouches = Number(match[1].replace(/,/g, ''));
          const amount = pouches * 500_000;
          if (!Number.isSafeInteger(pouches) || !Number.isSafeInteger(amount) || amount <= 0
            || parseMigrationNumber(match[2]) !== amount) continue;
          update.run(amount, row.id);
        }
        db!.pragma('user_version = 8');
      })();
    }

    if (userVersion<9) db.pragma('user_version=9');
    log('[DiaryDB] Database initialized successfully.');
  } catch (error) {
    log(`[DiaryDB] Failed to initialize database: ${error}`);
    console.error('[DiaryDB] Error:', error);
    statementCache.clear();
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
  } finally {initializingDb=false;}
}

/** 과거에 원문 전체나 수량까지 content에 저장된 득템 기록을 표준 형식으로 정리합니다. */
function normalizeExistingLootContent(throwOnError = false): void {
  if (!db) return;
  try {
    const rows = db.prepare("SELECT id, content, amount FROM activity_logs WHERE type = 'loot'").all() as Array<{
      id: number;
      content: string;
      amount: number;
    }>;
    const update = db.prepare('UPDATE activity_logs SET content = ?, amount = ? WHERE id = ?');
    let changed = 0;
    const transaction = db.transaction(() => {
      for (const row of rows) {
        const message = row.content.replace(/^\[득템\]\s*/u, '').trim();
        const condensed = message
          .normalize('NFC')
          .replace(/[\u200B-\u200D\u2060\uFEFF\s\u00A0]+/gu, '');
        if (!condensed.includes('경험의정수')) continue;

        const acquisition = parseItemAcquisition(message, { isSelfChat: true });
        const simpleCount = message.match(/^.+?\s+\[?([\d,]+)\]?개$/u);
        const content = formatLootDiaryContent('경험의 정수');
        const parsedSimpleCount = simpleCount?.[1]
          ? Number(simpleCount[1].replace(/,/g, ''))
          : 0;
        const amount = row.amount > 0 ? row.amount : (acquisition?.count || parsedSimpleCount || 1);
        if (content === row.content && amount === row.amount) continue;
        update.run(content, amount, row.id);
        changed++;
      }
    });
    transaction();
    if (changed > 0) log(`[DiaryDB] Normalized ${changed} loot activity records.`);
  } catch (error) {
    log(`[DiaryDB] Loot activity normalization failed: ${error}`);
    if (throwOnError) throw error;
  }
}

/** 기존에 개별로 등록되어 있던 마정석 로그들을 일자별/등급별 단 1개의 레코드로 압축 통합합니다. */
function consolidateMagicStoneLogs(throwOnError = false): void {
  if (!db) return;
  try {
    const rows = db.prepare(`
      SELECT id,date,time,content,amount,profile_id,record_device_id,record_session_id
      FROM activity_logs 
      WHERE type = 'loot' AND content LIKE '%마정석%'
      ORDER BY date ASC, time ASC, id ASC
    `).all() as Array<{id:number;date:string;time:string;content:string;amount:number;profile_id:string | null;record_device_id:string | null;record_session_id:string | null}>;

    if (rows.length === 0) return;

    // 기존 버전의 정리도 프로필 경계를 유지한다. 보존 행의 UUID/ID를 바꾸지 않는다.
    const summary=new Map<string,{id:number;content:string;latestTime:string;totalCount:number;ids:number[];deviceId:string | null;sessionId:string | null}>();
    for (const r of rows) {
      const grade = r.content.includes('최상급') ? '최상급' : (r.content.includes('상급') ? '상급' : (r.content.includes('중급') ? '중급' : '하급'));
      const parsedCount = r.amount > 0 ? r.amount : (parseInt((r.content.match(/\[?(\d+)\]?개/) || [])[1], 10) || 1);

      const key=JSON.stringify([r.profile_id,r.date,grade]);
      const group=summary.get(key) || {id:r.id,content:`[득템] [${grade} 마정석]`,latestTime:r.time,totalCount:0,ids:[],deviceId:r.record_device_id,sessionId:r.record_session_id};
      group.totalCount+=parsedCount;group.ids.push(r.id);group.latestTime=r.time;
      if (group.deviceId!==r.record_device_id) group.deviceId=null;
      if (group.sessionId!==r.record_session_id) group.sessionId=null;
      summary.set(key,group);
    }

    const deleteStmt = db.prepare('DELETE FROM activity_logs WHERE id = ?');
    const updateStmt=db.prepare('UPDATE activity_logs SET content=?,time=?,amount=?,record_device_id=?,record_session_id=? WHERE id=?');

    db.transaction(() => {
      for (const info of summary.values()) {
        updateStmt.run(info.content,info.latestTime,info.totalCount,info.deviceId,info.sessionId,info.id);
        for (const id of info.ids) if (id!==info.id) deleteStmt.run(id);
      }
    })();

    log(`[DiaryDB] Consolidated ${rows.length} magic stone records into daily totals.`);
  } catch (error) {
    log(`[DiaryDB] Magic stone consolidation failed: ${error}`);
    if (throwOnError) throw error;
  }
}

/**
 * 마정석 일자별 누적 기록 (프로필마다 하루에 등급별 1개 행)
 */
export function addMagicStoneDaily(date: string, time: string, grade: string, count: number): boolean {
  if (!db) initDb();
  if (!db) return false;

  const standardContent = `[득템] [${grade} 마정석]`;

  try {
    db.transaction(() => {
      ensureDiaryExists(date);
      const existing = db!.prepare(`
        SELECT id, amount FROM activity_logs
        WHERE date = ? AND type = 'loot' AND (content = ? OR content LIKE ?) AND profile_id IS ?
        ORDER BY id ASC LIMIT 1
      `).get(date, standardContent, `%${grade}%마정석%`,currentOwner().profileId) as { id: number; amount: number } | undefined;

      if (existing) {
        const newAmount = (existing.amount || 0) + count;
        const owner=currentOwner();
        db!.prepare(`UPDATE activity_logs SET content=?,time=MAX(time,?),amount=?,
          record_device_id=CASE WHEN record_device_id IS ? THEN record_device_id ELSE NULL END,
          record_session_id=CASE WHEN record_session_id IS ? THEN record_session_id ELSE NULL END WHERE id=?`)
          .run(standardContent,time,newAmount,owner.deviceId,owner.sessionId,existing.id);
      } else {
        db!.prepare(`INSERT INTO activity_logs (date, type, content, time, amount) VALUES (?, 'loot', ?, ?, ?)`)
          .run(date, standardContent, time, count);
      }
    })();
    return true;
  } catch (e) {
    log(`[DiaryDB] addMagicStoneDaily failed: ${e}`);
    propagateTransactionFailure(e);
    return false;
  }
}

/** 기존 문자열 데이터를 amount 컬럼으로 마이그레이션 */
function migrateExistingData(): void {
  if (!db) return;
  log('[DiaryDB] Migrating existing activity data to amount column...');
  
  const rows = db.prepare("SELECT id, type, content FROM activity_logs WHERE amount = 0").all() as any[];
  const updateStmt = db.prepare("UPDATE activity_logs SET amount = ? WHERE id = ?");

  const transaction = db.transaction((rows) => {
    for (const row of rows) {
      let amount = 0;
      if (row.type === 'calc') {
        const match = row.content.match(/\(([^)]+)\)/);
        if (match) amount = parseMigrationNumber(match[1]);
      } else if (row.type === 'loot') {
        const match = row.content.match(/(\d+)개$/);
        amount = match ? parseInt(match[1], 10) : 1;
      }
      if (amount > 0) {
        updateStmt.run(amount, row.id);
      }
    }
  });

  transaction(rows);
  log(`[DiaryDB] Migration completed for ${rows.length} rows.`);
}

/** 마이그레이션용 숫자 파싱 (chatParser의 로직과 유사) */
export function parseMigrationNumber(s: string): number {
  let val = 0;
  const joMatch = s.match(/([\d,]+)\s*조/u);
  const eokMatch = s.match(/([\d,]+)\s*억/u);
  const manMatch = s.match(/([\d,]+)\s*만/u);
  const rawMatch = s.match(/([\d,]+)/);

  if (joMatch) val += parseInt(joMatch[1].replace(/,/g, ''), 10) * 1_000_000_000_000;
  if (eokMatch) val += parseInt(eokMatch[1].replace(/,/g, ''), 10) * 100_000_000;
  if (manMatch) val += parseInt(manMatch[1].replace(/,/g, ''), 10) * 10_000;
  if (!joMatch && !eokMatch && !manMatch && rawMatch) {
    val = parseInt(rawMatch[1].replace(/,/g, ''), 10);
  }
  return val;
}

/** 월간 범위(시작일~종료일) 계산 헬퍼 (Range Scan 인덱스 활용용) */
export function getMonthDateRange(yearMonth: string): { start: string; end: string } {
  const [y, m] = yearMonth.split('-').map(Number);
  const normalizedYearMonth = `${y}-${String(m).padStart(2, '0')}`;
  const lastDay = new Date(y, m, 0).getDate();
  const start = `${normalizedYearMonth}-01`;
  const end = `${normalizedYearMonth}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

/**
 * 모험일지 조회 시 자동 득템의 표시 여부를 결정합니다.
 * 수동 기록은 사용자가 직접 만든 데이터이므로 항상 보존하고, 일반 자동 득템만 현재
 * 등록 목록을 따릅니다. 경험의 정수는 별도 재화 집계이므로 등록 목록에서 빠져 있어도
 * 날짜별 데이터·월간 통계·오늘의 요약에서 숨기지 않습니다. 주간/월간 득템 전용 목록만은
 * 일반 득템 UI이므로 `getLootHistory`에서 별도로 제외합니다.
 */
function isVisibleLootLog(log: Pick<ActivityLog, 'type' | 'content' | 'source'>, lootKeywords?: readonly string[]): boolean {
  if (log.type !== 'loot' || lootKeywords === undefined) return true;
  if (log.source === 'manual') return true;
  if (isAlwaysTrackedLoot(log.content)) return true;
  return matchesRegisteredLoot(lootKeywords, log.content);
}

function filterVisibleLootLogs<T extends Pick<ActivityLog,'type' | 'content' | 'source' | 'profile_id'>>(
  logs: T[],
  lootKeywords?: readonly string[],
): T[] {
  if (lootKeywords===undefined) return logs;
  const keywordsByProfile=new Map<string,readonly string[] | undefined>();
  return logs.filter(log => {
    if (!applicationData || !log.profile_id || log.type!=='loot' || log.source==='manual') return isVisibleLootLog(log,lootKeywords);
    if (!keywordsByProfile.has(log.profile_id)) {
      const saved=applicationData.setting(log.profile_id,'lootKeywords');
      // 전체 조회에서 다른 프로필의 득템을 현재 프로필 키워드로 숨기지 않는다.
      // 삭제된 프로필처럼 설정이 없는 경우에는 보존된 원본을 그대로 보여 준다.
      keywordsByProfile.set(log.profile_id,Array.isArray(saved) ? saved.filter((item):item is string => typeof item==='string') : undefined);
    }
    return isVisibleLootLog(log,keywordsByProfile.get(log.profile_id));
  });
}

/** 데이터베이스 연결을 명시적으로 닫습니다 (백업 복구용). */
export function closeDb(): boolean {
  if (db?.inTransaction) return false;
  const elsoFlushed = flushPendingElso();
  const goldPouchFlushed = flushPendingGoldPouchSeed();
  if (!elsoFlushed || !goldPouchFlushed) return false;
  statementCache.clear();
  if (db) {
    if (applicationData) applicationData.close();
    else db.close();
    db = null;
    log('[DiaryDB] Database connection closed.');
  }
  return elsoFlushed && goldPouchFlushed;
}

/** 특정 날짜의 일지가 없으면 생성합니다. */
function ensureDiaryExists(date: string,profileId:string | null=currentOwner().profileId): void {
  if (!db) initDb();
  if (!db) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO diaries (date) VALUES (?)');
  stmt.run(date);
  getStmt('INSERT OR IGNORE INTO diary_profile_days(date,profile_id) VALUES(?,?)').run(date,profileId);
}

function syncDiaryAggregate(date:string):void {
  getStmt(`UPDATE diaries SET
    total_score=(SELECT COALESCE(SUM(total_score),0) FROM diary_profile_days WHERE date=?),
    daily_done=(SELECT COALESCE(SUM(daily_done),0) FROM diary_profile_days WHERE date=?),
    daily_total=(SELECT COALESCE(SUM(daily_total),0) FROM diary_profile_days WHERE date=?),
    weekly_done=(SELECT COALESCE(SUM(weekly_done),0) FROM diary_profile_days WHERE date=?),
    weekly_total=(SELECT COALESCE(SUM(weekly_total),0) FROM diary_profile_days WHERE date=?) WHERE date=?`)
    .run(date,date,date,date,date,date);
}

/** 날짜별 일지 데이터를 모두 가져옵니다. (메모리 대기 중인 엘소 포인트도 디스크 I/O 없이 실시간 병합) */
export function getDiaryByDate(date: string, lootKeywords?: readonly string[],filter:DiaryProfileFilter=ALL_DIARY_PROFILES): DiaryData {
  if (!db) initDb();
  if (!db) return { diary: null, homeworkLogs: [], activityLogs: [] };

  const scope=diaryProfilePredicate(filter);
  const diary=(filter.kind==='all' ? getStmt('SELECT * FROM diaries WHERE date=?').get(date)
    :getStmt(`SELECT date,total_score,monster_id,daily_done,daily_total,weekly_done,weekly_total FROM diary_profile_days WHERE date=?${scope.sql}`).get(date,...scope.params)) as DiaryEntry | undefined;
  const homeworkLogs = getStmt(`SELECT * FROM homework_logs WHERE date=?${scope.sql} ORDER BY completed_at ASC`).all(date,...scope.params) as HomeworkLog[];
  let activityLogs = getStmt(`SELECT * FROM activity_logs WHERE date=?${scope.sql} ORDER BY time ASC`).all(date,...scope.params) as ActivityLog[];

  // 메모리에 대기 중인 엘소 포인트가 있다면 디스크 I/O 없이 실시간 합산하여 반환 (오늘의 요약 HUD 초고속 실시간 반영)
  const mergePending=(pending:PendingDailyAmount,type:'calc' | 'elso',content:string) => {
    if (pending.date!==date || pending.totalAmount<=0
      || filter.kind==='unassigned' && pending.profileId!==null
      || filter.kind==='profile' && pending.profileId!==filter.profileId) return;
    const existing=activityLogs.find(log => log.type===type && log.content===content && sameOwner(log,pending));
    if (existing) {
      existing.amount=(existing.amount || 0)+pending.totalAmount;existing.time=[existing.time,pending.latestTime].sort().at(-1)!;
      if (existing.record_device_id!==pending.deviceId) existing.record_device_id=null;
      if (existing.record_session_id!==pending.sessionId) existing.record_session_id=null;
    }
    else activityLogs.push({id:-1-activityLogs.length,date,type,content,time:pending.latestTime,amount:pending.totalAmount,
      source:'automatic',profile_id:pending.profileId,record_device_id:pending.deviceId,record_session_id:pending.sessionId});
  };
  for (const pending of _pendingElsoByDate.values()) mergePending(pending,'elso','엘소 포인트 획득');
  for (const pending of _pendingGoldPouchSeedByDate.values()) mergePending(pending,'calc',GOLD_POUCH_DAILY_CONTENT);
  activityLogs.sort((a,b) => a.time.localeCompare(b.time) || (a.id || 0)-(b.id || 0));
  return {diary:diary || {date,total_score:0,monster_id:'',daily_done:0,daily_total:0,weekly_done:0,weekly_total:0},
    homeworkLogs,activityLogs:filterVisibleLootLogs(activityLogs,lootKeywords)};
}

/** 기간 내보내기는 일지의 숙제·표시 대상 득템·확정 SEED만 읽는다. 채팅/개인 메모는 제외한다.
 * 금화 대기 합계도 먼저 확정하고 기존 amount를 사용하므로 주머니를 다시 환산하지 않는다.
 * 미리보기와 파일 저장은 같은 스냅샷을 사용하며 원본 삭제/빈 날짜 생성은 하지 않는다.
 */
export function getDiaryExportSnapshot(start: string, end: string, lootKeywords: readonly string[],filter:DiaryProfileFilter=ALL_DIARY_PROFILES): DiaryExportSnapshot {
  if (!db) initDb();
  if (!db || !flushPendingGoldPouchSeed()) throw new Error('모험 일지 기록을 읽지 못했습니다.');
  return db.transaction(() => {
    const scope=diaryProfilePredicate(filter);
    const activities = db!.prepare(`SELECT date,time,type,content,amount,source,profile_id FROM activity_logs WHERE date >= ? AND date <= ? AND type IN ('homework', 'loot', 'calc')${scope.sql} ORDER BY date, time, id LIMIT 100001`).all(start,end,...scope.params) as ActivityLog[];
    const homework = db!.prepare(`SELECT date, content_name, completed_at FROM homework_logs WHERE date >= ? AND date <= ?${scope.sql} ORDER BY date, completed_at, id LIMIT 100001`).all(start,end,...scope.params) as HomeworkLog[];
    if (activities.length + homework.length > 100000) throw new Error('기록이 많습니다. 기간을 나누어 저장해 주세요.');
    const visible = filterVisibleLootLogs(activities, lootKeywords);
    const rows: DiaryExportRow[] = visible.map(row => ({ date: row.date, time: row.time,
      kind: row.type === 'calc' ? '수익' : row.type === 'loot' ? '득템' : '숙제', content: row.content,
      amount: row.type === 'loot' ? (row.amount > 0 ? Math.floor(row.amount) : Number(row.content.match(/\[?([\d,]+)\]?개/u)?.[1]?.replace(/,/g, '')) || 1) : row.type === 'calc' ? row.amount || 0 : 1,
    }));
    rows.push(...homework.map(row => {
      const time = new Date(row.completed_at);
      return { date: row.date, time: [time.getHours(), time.getMinutes(), time.getSeconds()].map(value => String(value).padStart(2, '0')).join(':'), kind: '숙제' as const, content: row.content_name, amount: 1 };
    }));
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    return { start, end, rows, totalSeed: visible.filter(row => row.type === 'calc').reduce((sum, row) => sum + (row.amount || 0), 0) };
  })();
}

function getCalendarWeekKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return formatLocalDateKey(date);
}

/** 복원 완료 안내를 기다리는 동안에도 조회/기록 경로가 교체된 DB를 다시 열지 못하게 한다. */
export function suspendForRestore(): () => void {
  if (restoreSuspended) throw new Error('일지 복원이 이미 진행 중입니다.');
  if (!closeDb()) {
    initDb();
    throw new Error('복원 전 일지의 대기 기록을 저장하지 못했습니다.');
  }
  restoreSuspended = true;
  return () => {
    restoreSuspended = false;
    initDb();
  };
}

/**
 * 특정 월의 달력 렌더링을 위해 주변 날짜를 포함한 요약 데이터를 가져옵니다.
 *
 * 체크리스트의 `weekly_done/weekly_total`은 현재 상태를 저장한 날짜에만 존재할 수 있습니다.
 * 과거 로그 동기화로 복원된 주간 숙제는 `homework_logs`에만 있으므로 같은 월~일 주기의
 * 고유 완료 행을 세어 `weekly_done`의 최소값으로 보완합니다. 과거 주차의 분모는 사용자가 요청한
 * 현재 체크리스트 기준을 따르며, 완료 이력이 있는 주에만 `currentWeeklyTotal`을 보완값으로 사용합니다.
 * 기록이 전혀 없는 과거 주까지 `0/전체`로 단정해서는 안 됩니다.
 */
export function getDiariesByMonth(yearMonth: string,currentWeeklyTotal:number=0,filter:DiaryProfileFilter=ALL_DIARY_PROFILES): DiaryEntry[] {
  requireFlushedDiaryAmounts();
  if (!db) initDb();
  if (!db) return [];

  const [y, m] = yearMonth.split('-').map(Number);
  const normalizedYearMonth = `${y}-${String(m).padStart(2, '0')}`;

  // 현재 월의 시작일과 다음 달의 시작일 기준 범위를 넓게 가져옴 (주간 합계 계산용)
  const scope=diaryProfilePredicate(filter);
  const stmt = getStmt(`
    SELECT date,total_score,monster_id,daily_done,daily_total,weekly_done,weekly_total FROM ${filter.kind==='all' ? 'diaries' : 'diary_profile_days'}
    WHERE date >= date(?, '-7 days') 
      AND date <= date(?, '+1 month', '+7 days') ${scope.sql}
    ORDER BY date ASC
  `);
  const rangeAnchor = `${normalizedYearMonth}-01`;
  const diaries = stmt.all(rangeAnchor,rangeAnchor,...scope.params) as DiaryEntry[];
  const weeklyLogs = getStmt(`
    SELECT date, content_id,profile_id
    FROM homework_logs
    WHERE type = 'weekly'
      AND date >= date(?, '-7 days')
      AND date <= date(?, '+1 month', '+7 days')
      ${scope.sql}
  `).all(rangeAnchor,rangeAnchor,...scope.params) as Array<{date:string;content_id:string;profile_id:string | null}>;

  const completedIdsByWeek = new Map<string, Set<string>>();
  weeklyLogs.forEach(row => {
    const weekKey = getCalendarWeekKey(row.date);
    const completedIds = completedIdsByWeek.get(weekKey) ?? new Set<string>();
    completedIds.add(JSON.stringify([row.profile_id,row.content_id]));
    completedIdsByWeek.set(weekKey, completedIds);
  });

  const safeCurrentWeeklyTotal = Number.isFinite(currentWeeklyTotal)
    ? Math.max(0, Math.trunc(currentWeeklyTotal))
    : 0;
  return diaries.map(entry => {
    const weeklyDone = Math.max(
      entry.weekly_done || 0,
      completedIdsByWeek.get(getCalendarWeekKey(entry.date))?.size || 0,
    );
    return {
      ...entry,
      weekly_done: weeklyDone,
      weekly_total: entry.weekly_total > 0
        ? entry.weekly_total
        : weeklyDone > 0 ? safeCurrentWeeklyTotal : 0,
    };
  });
}

/** 점수를 업데이트하고 몬스터 단계를 결정합니다. (자동 호출됨) */
function addScore(date: string, points: number,profileId:string | null=currentOwner().profileId): void {
  if (!db) return;
  ensureDiaryExists(date,profileId);
  getStmt('UPDATE diary_profile_days SET total_score=total_score+? WHERE date=? AND profile_id IS ?').run(points,date,profileId);
  syncDiaryAggregate(date);
}

function subtractScore(date: string, points: number,profileId:string | null=currentOwner().profileId): void {
  if (!db) return;
  getStmt('UPDATE diary_profile_days SET total_score=MAX(0,total_score-?) WHERE date=? AND profile_id IS ?').run(points,date,profileId);
  syncDiaryAggregate(date);
}

/** 특정 활동이 이미 기록되어 있는지 확인합니다. */
export function isActivityLogged(date: string, content: string): boolean {
  if (!db) initDb();
  if (!db) return false;
  const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND content = ? AND profile_id IS ?').get(date, content,currentOwner().profileId);
  return !!existing;
}

/** 날짜, 시간, 내용으로 활동 기록 존재 여부를 확인합니다. (동기화 중복 방지용) */
export function hasActivityLog(date: string, time: string, content: string): boolean {
  if (!db) initDb();
  if (!db) return false;
  const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND time = ? AND content = ? AND profile_id IS ?').get(date,time,content,currentOwner().profileId);
  return !!existing;
}

/** 활동 기록이 없을 때만 안전하게 추가합니다. (동기화 멱등성 보장) */
export function addActivityLogIfAbsent(
  date: string,
  time: string,
  type: 'boss' | 'calc' | 'memo' | 'loot' | 'homework',
  content: string,
  amount: number = 0,
  notify: boolean = false
): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    let inserted = false;
    const transaction = db.transaction(() => {
      ensureDiaryExists(date);

      const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND time = ? AND content = ? AND profile_id IS ?').get(date,time,content,currentOwner().profileId);
      if (existing) return;

      const stmt = getStmt("INSERT INTO activity_logs (date, type, content, time, amount, source) VALUES (?, ?, ?, ?, ?, 'automatic')");
      stmt.run(date, type, content, time, amount);

      if (type === 'boss') addScore(date, POINTS.BOSS_KILL);
      if (type === 'calc') addScore(date, POINTS.CALC_RECORD);
      inserted = true;
    });

    transaction();
    if (inserted && notify) throttleNotifyUpdate();
    return inserted;
  } catch (err) {
    log(`[DiaryDB] addActivityLogIfAbsent failed: ${err}`);
    propagateTransactionFailure(err);
    return false;
  }
}

type ActivityWriteType = 'boss' | 'calc' | 'memo' | 'loot' | 'homework';
type ActivitySource = 'manual' | 'automatic';

function addActivityLogInternal(
  date: string,
  time: string,
  type: ActivityWriteType,
  content: string,
  amount: number,
  source: ActivitySource,
): number | null {
  if (!db) initDb();
  if (!db) return null;

  try {
    let insertedId: number | null = null;
    const transaction = db.transaction(() => {
      ensureDiaryExists(date);

      // 보스 처치 기록인 경우 중복 체크 (동일 날짜, 동일 내용)
      if (type === 'boss') {
        const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND content = ? AND profile_id IS ?').get(date,content,currentOwner().profileId);
        if (existing) {
          log(`[DIARY_DB] 이미 존재하는 보스 기록입니다. 스킵: ${content}`);
          return;
        }
      }

      const stmt = getStmt('INSERT INTO activity_logs (date, type, content, time, amount, source) VALUES (?, ?, ?, ?, ?, ?)');
      const result = stmt.run(date, type, content, time, amount, source);
      insertedId = Number(result.lastInsertRowid);

      // 포인트 부여
      if (type === 'boss') addScore(date, POINTS.BOSS_KILL);
      if (type === 'calc') addScore(date, POINTS.CALC_RECORD);
    });
    transaction();
    if (insertedId !== null) throttleNotifyUpdate();
    return insertedId;
  } catch (err) {
    log(`[DiaryDB] addActivityLog failed: ${err}`);
    propagateTransactionFailure(err);
    return null;
  }
}

/** 자동 감지/내부 로직에서 활동 기록을 추가합니다. */
export function addActivityLog(date: string, time: string, type: ActivityWriteType, content: string, amount: number = 0): boolean {
  return addActivityLogInternal(date, time, type, content, amount, 'automatic') !== null;
}

/** 사용자가 UI에서 직접 등록한 활동을 추가하고 개별 삭제용 row ID를 반환합니다. */
export function addManualActivityLog(date: string, time: string, type: ActivityWriteType, content: string, amount: number = 0): number | null {
  return addActivityLogInternal(date, time, type, content, amount, 'manual');
}

/** 수동 등록 행 한 건만 ID로 삭제합니다. */
export function removeManualActivityLogById(id: number): boolean {
  if (!db) initDb();
  if (!db) return false;
  try {
    let removed = false;
    const transaction = db.transaction(() => {
      const existing = getStmt("SELECT date,type,profile_id FROM activity_logs WHERE id = ? AND source = 'manual'")
        .get(id) as { date:string;type:string;profile_id:string | null } | undefined;
      if (!existing) return;
      const result = getStmt("DELETE FROM activity_logs WHERE id = ? AND source = 'manual'").run(id);
      if (result.changes !== 1) return;
      if (existing.type === 'boss') subtractScore(existing.date, POINTS.BOSS_KILL,existing.profile_id);
      if (existing.type === 'calc') subtractScore(existing.date, POINTS.CALC_RECORD,existing.profile_id);
      removed = true;
    });
    transaction();
    if (removed) notifyUpdate();
    return removed;
  } catch (err) {
    log(`[DiaryDB] removeManualActivityLogById failed: ${err}`);
    propagateTransactionFailure(err);
    return false;
  }
}

/** 활동 기록을 삭제합니다 (토글 해제용). */
export function removeActivityLog(date: string, type: string, content: string): void {
  if (!db) initDb();
  if (!db) return;

  try {
    let changed = false;
    const transaction = db.transaction(() => {
      const stmt = getStmt('DELETE FROM activity_logs WHERE date = ? AND type = ? AND content = ? AND profile_id IS ?');
      const info = stmt.run(date,type,content,currentOwner().profileId);

      // 삭제된 행이 있을 때만 포인트 차감
      if (info.changes > 0) {
        if (type === 'boss') subtractScore(date,POINTS.BOSS_KILL*info.changes);
        if (type === 'calc') subtractScore(date,POINTS.CALC_RECORD*info.changes);
        changed = true;
      }
    });
    transaction();
    if (changed) notifyUpdate();
  } catch (err) {
    log(`[DiaryDB] removeActivityLog failed: ${err}`);
    propagateTransactionFailure(err);
  }
}

/** 숙제 완료 기록을 추가합니다. */
export function addHomeworkLog(date: string, contentId: string, contentName: string, category: string, type: 'daily' | 'weekly', completedAt: number): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    let changed = false;
    const transaction = db.transaction(() => {
      ensureDiaryExists(date);

      // 이미 해당 숙제가 오늘/이번주 기록되어 있는지 확인
      const existing = getStmt('SELECT id FROM homework_logs WHERE date = ? AND content_id = ? AND profile_id IS ?').get(date,contentId,currentOwner().profileId) as {id:number} | undefined;
      if (existing) {
        // 사용자가 직접 조작하거나 실시간 감지한 체크리스트 기록이 과거 동기화 기록보다 우선한다.
        getStmt(`
          UPDATE homework_logs
          SET content_name = ?, category = ?, type = ?, completed_at = ?, source = 'checklist'
          WHERE id = ?
        `).run(contentName, category, type, completedAt, existing.id);
        changed = true;
        return;
      }

      const stmt = getStmt("INSERT INTO homework_logs (date, content_id, content_name, category, type, completed_at, source,profile_id) VALUES (?, ?, ?, ?, ?, ?, 'checklist',?)");
      stmt.run(date,contentId,contentName,category,type,completedAt,currentOwner().profileId);

      // 포인트 부여
      if (type === 'daily') addScore(date, POINTS.DAILY_HOMEWORK);
      if (type === 'weekly') addScore(date, POINTS.WEEKLY_HOMEWORK);
      changed = true;
    });
    transaction();
    if (changed) notifyUpdate();
    return true;
  } catch (err) {
    log(`[DiaryDB] addHomeworkLog failed: ${err}`);
    propagateTransactionFailure(err);
    return false;
  }
}

/** 숙제 체크 해제 시 기록을 삭제합니다. */
export function removeHomeworkLog(date: string, contentId: string): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    let removed = false;
    const transaction = db.transaction(() => {
      const existing = getStmt('SELECT type FROM homework_logs WHERE date = ? AND content_id = ? AND profile_id IS ?').get(date,contentId,currentOwner().profileId) as {type:string} | undefined;
      if (!existing) return;

      const stmt = getStmt('DELETE FROM homework_logs WHERE date = ? AND content_id = ? AND profile_id IS ?');
      stmt.run(date,contentId,currentOwner().profileId);

      // 포인트 차감
      if (existing.type === 'daily') subtractScore(date, POINTS.DAILY_HOMEWORK);
      if (existing.type === 'weekly') subtractScore(date, POINTS.WEEKLY_HOMEWORK);
      removed = true;
    });
    transaction();
    if (removed) notifyUpdate();
    return true;
  } catch (err) {
    log(`[DiaryDB] removeHomeworkLog failed: ${err}`);
    propagateTransactionFailure(err);
    return false;
  }
}

/** 그 날의 전체 숙제 통계(완료/전체)를 갱신합니다. */
export function updateHomeworkStats(date: string, dailyDone: number, dailyTotal: number, weeklyDone: number, weeklyTotal: number): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    db.transaction(() => {
      ensureDiaryExists(date);
      db!.prepare(`
        UPDATE diary_profile_days
        SET daily_done = ?, daily_total = ?, weekly_done = ?, weekly_total = ?
        WHERE date = ? AND profile_id IS ?
      `).run(dailyDone, dailyTotal, weeklyDone, weeklyTotal, date,currentOwner().profileId);
      syncDiaryAggregate(date);
    })();
    notifyUpdate();
    return true;
  } catch (err) {
    log(`[DiaryDB] updateHomeworkStats failed: ${err}`);
    propagateTransactionFailure(err);
    return false;
  }
}

/** 몬스터 스티커 설정을 업데이트합니다. */
export function updateDiaryMonster(date: string, monsterId: string): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    db.transaction(() => {
      ensureDiaryExists(date);
      db!.prepare('UPDATE diaries SET monster_id = ? WHERE date = ?').run(monsterId, date);
      db!.prepare('UPDATE diary_profile_days SET monster_id=? WHERE date=? AND profile_id IS ?').run(monsterId,date,currentOwner().profileId);
    })();
    notifyUpdate();
    return true;
  } catch (err) {
    log(`[DiaryDB] updateDiaryMonster failed: ${err}`);
    propagateTransactionFailure(err);
    return false;
  }
}

interface MonthlySummaryData {
  totalLoots: number;
  totalSeed: number;
  /** 통계 탭의 '이번 달 누적 득템 리스트': 일반 득템만 포함합니다. */
  lootList: Array<{ date: string; content: string; amount: number }>;
  /** 활동 달력의 날짜별 배지: 경험의 정수 같은 별도 집계 활동도 유지합니다. */
  calendarLootList: Array<{ date: string; content: string; amount: number }>;
  seedList: Array<{ date: string; content: string; amount: number }>;
}

export interface SyncedHomeworkLogInput {
  date: string;
  contentId: string;
  contentName: string;
  category: string;
  type: 'daily' | 'weekly';
  completedAt: number;
}

/**
 * 과거 채팅 로그에서 확정된 숙제 완료 이력을 날짜별로 반영한다.
 *
 * - `replaceDates`는 채팅 로그 동기화가 안전하게 전체 분석을 마친 날짜만 받으며, 그 날짜의
 *   대상 프로필의 `chat-log-sync` 행만 삭제 후 재생성한다.
 * - 사용자가 직접 체크했거나 실시간 체크리스트가 만든 `checklist` 행은 같은 키여도 덮어쓰지 않는다.
 * - 삭제와 삽입, 일일 숙제 점수 보정은 하나의 트랜잭션이므로 중간 실패로 과거 이력이 비지 않는다.
 */
export function upsertSyncedHomeworkLogs(
  entries: SyncedHomeworkLogInput[],
  replaceDates: string[] = [],
): { success: boolean; changed: number; error?: string } {
  if (!db) initDb();
  if (!db) return { success: false, changed: 0, error: '데이터베이스를 초기화하지 못했습니다.' };

  const validDate = /^\d{4}-\d{2}-\d{2}$/;
  const normalizedReplaceDates = [...new Set(replaceDates.filter(date => validDate.test(date)))];
  const normalizedEntries = entries.filter(entry => (
    validDate.test(entry.date)
    && entry.contentId.length > 0
    && entry.contentName.length > 0
    && (entry.type === 'daily' || entry.type === 'weekly')
    && Number.isFinite(entry.completedAt)
    && entry.completedAt > 0
  ));

  let changed = 0;
  try {
    db.transaction(() => {
      if (normalizedReplaceDates.length > 0) {
        const placeholders = normalizedReplaceDates.map(() => '?').join(', ');
        const removedDaily = db!.prepare(`
          SELECT date, COUNT(*) AS count
          FROM homework_logs
          WHERE source = 'chat-log-sync' AND type = 'daily' AND date IN (${placeholders}) AND profile_id IS ?
          GROUP BY date
        `).all(...normalizedReplaceDates,currentOwner().profileId) as Array<{date:string;count:number}>;
        for (const row of removedDaily) subtractScore(row.date, row.count * POINTS.DAILY_HOMEWORK);
        changed += db!.prepare(`
          DELETE FROM homework_logs
          WHERE source = 'chat-log-sync' AND date IN (${placeholders}) AND profile_id IS ?
        `).run(...normalizedReplaceDates,currentOwner().profileId).changes;
      }

      const selectExisting = db!.prepare('SELECT id, source FROM homework_logs WHERE date = ? AND content_id = ? AND profile_id IS ?');
      const updateSynced = db!.prepare(`
        UPDATE homework_logs
        SET content_name = ?, category = ?, type = ?, completed_at = ?
        WHERE id = ? AND source = 'chat-log-sync'
      `);
      const insertSynced = db!.prepare(`
        INSERT INTO homework_logs
          (date, content_id, content_name, category, type, completed_at, source,profile_id)
        VALUES (?, ?, ?, ?, ?, ?, 'chat-log-sync',?)
      `);

      for (const entry of normalizedEntries) {
        ensureDiaryExists(entry.date);
        const existing = selectExisting.get(entry.date,entry.contentId,currentOwner().profileId) as {id:number;source:string} | undefined;
        if (existing?.source === 'checklist') continue;
        if (existing) {
          changed += updateSynced.run(
            entry.contentName,
            entry.category,
            entry.type,
            entry.completedAt,
            existing.id,
          ).changes;
          continue;
        }
        insertSynced.run(
          entry.date,
          entry.contentId,
          entry.contentName,
          entry.category,
          entry.type,
          entry.completedAt,
          currentOwner().profileId,
        );
        if (entry.type === 'daily') addScore(entry.date, POINTS.DAILY_HOMEWORK);
        if (entry.type === 'weekly') addScore(entry.date, POINTS.WEEKLY_HOMEWORK);
        changed++;
      }
    })();
    if (changed > 0) notifyUpdate();
    return { success: true, changed };
  } catch (error) {
    log(`[DiaryDB] upsertSyncedHomeworkLogs failed: ${error}`);
    propagateTransactionFailure(error);
    return { success: false, changed: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 특정 월의 요약 정보(득템 수, 누적 SEED, 화면별 상세 목록)를 가져옵니다.
 *
 * 통계 탭의 누적 득템 목록과 활동 달력은 같은 월 데이터를 사용하지만 표시 목적이 다릅니다.
 * 경험의 정수는 일반 득템 목록인 `lootList`에서는 제외하고, 날짜별 활동을 보여 주는
 * `calendarLootList`에는 남깁니다. 두 목록을 다시 합치면 두 번째 탭에 정수가 재노출됩니다.
 */
export function getMonthlySummary(yearMonth:string,lootKeywords?:readonly string[],filter:DiaryProfileFilter=ALL_DIARY_PROFILES): MonthlySummaryData {
  requireFlushedDiaryAmounts();
  if (!db) initDb();
  if (!db) return { totalLoots: 0, totalSeed: 0, lootList: [], calendarLootList: [], seedList: [] };

  const { start, end } = getMonthDateRange(yearMonth);
  const scope=diaryProfilePredicate(filter);
  const rawLogs = getStmt(`SELECT date,type,content,amount,source,profile_id FROM activity_logs WHERE date>=? AND date<=? AND type IN ('loot','calc')${scope.sql} ORDER BY date DESC,time DESC`).all(start,end,...scope.params) as ActivityLog[];
  const logs = filterVisibleLootLogs(rawLogs, lootKeywords);

  let totalLoots = 0;
  let totalSeed = 0;
  const lootList: { date: string, content: string, amount: number }[] = [];
  const calendarLootList: { date: string, content: string, amount: number }[] = [];
  const seedList: { date: string, content: string, amount: number }[] = [];

  logs.forEach(log => {
    if (log.type === 'loot') {
      const item = { date: log.date, content: log.content, amount: log.amount || 1 };
      calendarLootList.push(item);
      if (!isAlwaysTrackedLoot(log.content)) lootList.push(item);
      if (countsTowardLootTotal(log.content)) {
        totalLoots += log.amount || 1;
      }
    } else if (log.type === 'calc') {
      seedList.push({ date: log.date, content: log.content, amount: log.amount || 0 });
      totalSeed += log.amount || 0;
    }
  });

  return { totalLoots, totalSeed, lootList, calendarLootList, seedList };
}

/** 월간 통계 데이터를 추출합니다 (인포그래픽용). */
export function getMonthlyStatistics(yearMonth:string,lootKeywords?:readonly string[],filter:DiaryProfileFilter=ALL_DIARY_PROFILES): any {
  requireFlushedDiaryAmounts();
  if (!db) initDb();
  if (!db) return null;

  const [year, month] = yearMonth.split('-').map(Number);
  const totalDays = new Date(year, month, 0).getDate();
  const { start, end } = getMonthDateRange(yearMonth);

  // 1. 기본 로그 가져오기 (인덱스 Range Scan 활용)
  const scope=diaryProfilePredicate(filter);
  const rawLogs = getStmt(`SELECT date,time,type,content,amount,source,profile_id FROM activity_logs WHERE date>=? AND date<=?${scope.sql}`).all(start,end,...scope.params) as ActivityLog[];
  const logs = filterVisibleLootLogs(rawLogs, lootKeywords);

  // 2. 출석일수 (활동 로그가 있는 고유 날짜 수)
  const attendanceDays = new Set(logs.map(l => l.date)).size;

  // 3. 보람찬 활동들 (보스, 득템, 수익)
  let totalBosses = 0;
  let totalLoots = 0;
  let totalEssences = 0;
  let totalSeed = 0;
  let totalElso = 0;
  const bossCounts: Record<string, number> = {};
  const weeklyActivity = [0, 0, 0, 0, 0, 0, 0]; // 월~일 (0~6)
  const hourlyActivity = [0, 0, 0, 0]; // 아침/오전(06-12), 오후(12-18), 저녁/밤(18-24), 새벽/심야(00-06)
  const heatmap: Record<string, number> = {};
  const weeklySeedList = [0, 0, 0, 0, 0, 0]; // 최대 6주
  const firstDay = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 1일의 요일 (0: 월요일)

  logs.forEach(log => {
    // 요일별 활동량 계산
    const day = new Date(log.date).getDay();
    const dayIdx = day === 0 ? 6 : day - 1; // 월요일(0) ~ 일요일(6)로 변환
    weeklyActivity[dayIdx]++;

    // 시간대별 활동량 계산
    if (log.time) {
      const hour = parseInt(log.time.split(':')[0], 10);
      if (!isNaN(hour)) {
        if (hour >= 6 && hour < 12) {
          hourlyActivity[0]++;
        } else if (hour >= 12 && hour < 18) {
          hourlyActivity[1]++;
        } else if (hour >= 18 && hour < 24) {
          hourlyActivity[2]++;
        } else {
          hourlyActivity[3]++;
        }
      }
    }

    // 히트맵용 일별 활동량
    heatmap[log.date] = (heatmap[log.date] || 0) + 1;

    if (log.type === 'boss') {
      totalBosses++;
      // 보스 이름 추출 (예: "[보스 처치] 어비스" -> "어비스")
      const bossName = log.content.replace('[보스 처치] ', '').trim();
      bossCounts[bossName] = (bossCounts[bossName] || 0) + 1;
    } else if (log.type === 'loot') {
      if (log.content.includes('경험의 정수')) {
        totalEssences += log.amount || 1;
      } else if (countsTowardLootTotal(log.content)) {
        totalLoots += log.amount || 1;
      }
    } else if (log.type === 'calc') {
      totalSeed += log.amount || 0;
      const dateNum = parseInt(log.date.split('-')[2], 10);
      const weekIdx = Math.floor((dateNum + firstDay - 1) / 7);
      if (weekIdx >= 0 && weekIdx < 6) {
        weeklySeedList[weekIdx] += log.amount || 0;
      }
    } else if (log.type === 'elso') {
      totalElso += log.amount || 0;
    }
  });

  // 4. 최애 보스 Top 3
  const topBosses = Object.entries(bossCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  // 5. 히트맵 배열 변환
  const heatmapList = Object.entries(heatmap).map(([date, count]) => ({ date, count }));

  // 6. 등급 산출 로직 (출석일수 기준)
  let grade: 'S' | 'A' | 'B' | 'C' | 'D' = 'D';
  if (attendanceDays >= 25) grade = 'S';
  else if (attendanceDays >= 20) grade = 'A';
  else if (attendanceDays >= 12) grade = 'B';
  else if (attendanceDays >= 5) grade = 'C';

  return {
    attendanceDays,
    totalDays,
    totalBosses,
    totalLoots,
    totalEssences,
    totalSeed,
    totalElso,
    topBosses,
    weeklyActivity,
    weeklySeedList,
    heatmap: heatmapList,
    grade,
    hourlyActivity
  };
}

export interface LootHistoryRow {
  profile_id?:string | null;
  date: string;
  time: string;
  content: string;
  amount: number;
  source: ActivityLog['source'];
}

/**
 * 주간/월간 득템 전용 목록을 위한 날짜 범위 조회입니다.
 *
 * 경험의 정수는 저장 스키마상 loot 활동이지만 사용자가 등록할 수 있는 일반 득템 아이템이
 * 아니므로 이 3번째 탭에서는 항상 제외합니다. 이 표시 필터는 DB 원본, 오늘 요약과 월간
 * `totalEssences` 집계에는 영향을 주지 않습니다.
 */
export function getLootHistory(
  startDate: string,
  endDate: string,
  lootKeywords?: readonly string[],
  filter:DiaryProfileFilter=ALL_DIARY_PROFILES,
): LootHistoryRow[] {
  if (!db) initDb();
  if (!db) return [];
  const scope=diaryProfilePredicate(filter);
  const rows = getStmt(`
    SELECT date,time,content,amount,source,profile_id
    FROM activity_logs
    WHERE date >= ? AND date <= ? AND type = 'loot' ${scope.sql}
    ORDER BY date DESC, time DESC
  `).all(startDate,endDate,...scope.params) as LootHistoryRow[];
  const generalLootRows = rows
    .map(row => ({ ...row, type: 'loot' as const }))
    .filter(row => !isAlwaysTrackedLoot(row.content));
  return filterVisibleLootLogs(
    generalLootRows,
    lootKeywords,
  ).map(({ type: _type, ...row }) => row);
}

/**
 * 특정 월의 일별 수익 데이터를 가져옵니다 (차트용).
 */
export function getMonthlyRevenueData(yearMonth:string,filter:DiaryProfileFilter=ALL_DIARY_PROFILES): {date:string;amount:number}[] {
  if (!flushPendingGoldPouchSeed()) throw new Error('금화 주머니 기록을 먼저 저장해 주세요.');
  if (!db) initDb();
  if (!db) return [];

  const { start, end } = getMonthDateRange(yearMonth);

  // 1. DB에서 해당 월의 일별 합계 가져오기
  const scope=diaryProfilePredicate(filter);
  const rows = getStmt(`
    SELECT date, SUM(amount) as daily_sum 
    FROM activity_logs 
    WHERE date >= ? AND date <= ? AND type = 'calc' ${scope.sql}
    GROUP BY date
    ORDER BY date ASC
  `).all(start,end,...scope.params) as {date:string;daily_sum:number}[];

  const dailyMap = new Map(rows.map(r => [r.date, r.daily_sum]));

  // 2. 해당 월의 모든 날짜를 생성 (데이터가 없는 날은 0으로 채움)
  const [year, month] = yearMonth.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const result = [];

  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    result.push({
      date: dateStr,
      amount: dailyMap.get(dateStr) || 0
    });
  }

  return result;
}

/** 
 * 외치기 기록을 추가합니다. 
 * 추가 시 24시간이 지난 기록은 자동으로 삭제하며, 5초 이내 동일 발신자/메시지는 중복 삽입을 방지합니다.
 */
export function addShoutLog(sender: string, message: string, customTimestamp?: number, shoutKind?: import('../shared/types').ShoutKind): boolean {
  if (!db) initDb();
  if (!db) return false;

  const now = customTimestamp || Math.floor(Date.now() / 1000); // Unix Timestamp (seconds)
  const oneDayAgo = now - (24 * 60 * 60);

  try {
    db.transaction(() => {
      // 1. 오래된 기록 삭제 (24시간 경과)
      db!.prepare('DELETE FROM shout_history WHERE timestamp < ?').run(oneDayAgo);

      // 2. 5초 이내 동일 발신자 및 메시지 중복 체크
      const existing = db!.prepare('SELECT id FROM shout_history WHERE sender = ? AND message = ? AND ABS(timestamp - ?) <= 5').get(sender, message, now);
      if (!existing) {
        db!.prepare('INSERT INTO shout_history (timestamp, sender, message, shout_kind) VALUES (?, ?, ?, ?)').run(now, sender, message, shoutKind ?? null);
      }
    })();
    return true;
  } catch (err) {
    log(`[DiaryDB] addShoutLog failed: ${err}`);
    return false;
  }
}

/** 외치기 존재 여부 확인 (동기화 중복 방지용: 5초 오차 허용) */
export function hasShoutLog(timestamp: number, sender: string, message: string): boolean {
  if (!db) initDb();
  if (!db) return false;
  const existing = db.prepare('SELECT id FROM shout_history WHERE sender = ? AND message = ? AND ABS(timestamp - ?) <= 5').get(sender, message, timestamp);
  return !!existing;
}

/** 과거 타임스탬프를 보존하여 외치기를 중복 없이 추가합니다. */
export function addShoutLogWithTimestampIfAbsent(timestamp: number, sender: string, message: string): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    const existing = db.prepare('SELECT id FROM shout_history WHERE sender = ? AND message = ? AND ABS(timestamp - ?) <= 5').get(sender, message, timestamp);
    if (existing) return false;

    db.prepare('INSERT INTO shout_history (timestamp, sender, message, shout_kind) VALUES (?, ?, ?, ?)')
      .run(timestamp, sender, message, null);
    return true;
  } catch (err) {
    log(`[DiaryDB] addShoutLogWithTimestampIfAbsent failed: ${err}`);
    return false;
  }
}

/** 기존 DB에 존재하는 5초 이내 동일 발신자/메시지 중복을 정리합니다. */
function deduplicateShoutHistoryOrThrow(): void {
  if (!db) throw new Error('DB가 초기화되지 않았습니다.');
  const rows = db.prepare(`
    SELECT id, timestamp, sender, message
    FROM shout_history
    ORDER BY sender ASC, message ASC, timestamp ASC, id ASC
  `).all() as Array<{ id: number; timestamp: number; sender: string; message: string; shoutKind?: import('../shared/types').ShoutKind }>;
  const deleteRow = db.prepare('DELETE FROM shout_history WHERE id = ?');

  db.transaction(() => {
    let previousSender: string | null = null;
    let previousMessage: string | null = null;
    let lastKeptTimestamp: number | null = null;
    for (const row of rows) {
      if (row.sender !== previousSender || row.message !== previousMessage) {
        previousSender = row.sender;
        previousMessage = row.message;
        lastKeptTimestamp = row.timestamp;
        continue;
      }

      // 실시간 삽입 계약과 동일하게 마지막으로 실제 보존한 행에서 ±5초 이내만 제거한다.
      if (lastKeptTimestamp !== null && row.timestamp - lastKeptTimestamp <= 5) {
        deleteRow.run(row.id);
      } else {
        lastKeptTimestamp = row.timestamp;
      }
    }
  })();
}

export function deduplicateShoutHistory(): void {
  if (!db) return;
  try {
    deduplicateShoutHistoryOrThrow();
  } catch (err) {
    log(`[DiaryDB] Shout deduplication warning: ${err}`);
  }
}

export interface BatchSyncData {
  loots: Array<{ eventId?: string; date: string; timeOnly: string; diaryContent: string; count: number }>;
  essences: Array<{ eventId?: string; date: string; timeOnly: string; diaryContent: string; count: number }>;
  seeds: Array<{ eventId?: string; date: string; timeOnly: string; content: string; amount: number }>;
  elsoPoints: Array<{eventId?:string;date:string;timeOnly:string;amount:number}>;
  goldPouchSeeds?: Array<{eventId?:string;date:string;timeOnly:string;amount:number}>;
  shouts: Array<{ eventId?: string; fullTimestamp: number; sender: string; message: string; shoutKind?: import('../shared/types').ShoutKind }>;
  replaceAutomaticDate?: string;
}

interface GoldPouchRecoveryJournal {
  schemaVersion: 1 | 2;
  operationId: string;
  createdAt: number;
  entries: PendingDailyAmount[];
}

export function getGoldPouchRecoveryJournalPath(): string {
  return path.join(app.getPath('userData'), 'gold-pouch-seed-recovery.json');
}

function validateGoldPouchRecoveryJournal(value: unknown): GoldPouchRecoveryJournal {
  if (!value || typeof value !== 'object') throw new Error('복구 기록이 객체가 아닙니다.');
  const journal = value as Partial<GoldPouchRecoveryJournal>;
  if ((journal.schemaVersion !== 1 && journal.schemaVersion !== 2) || typeof journal.operationId !== 'string' || journal.operationId.length < 8) {
    throw new Error('복구 기록 메타데이터가 유효하지 않습니다.');
  }
  if (!Number.isFinite(journal.createdAt) || !Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('복구 기록 항목이 유효하지 않습니다.');
  }
  const entries = journal.entries.map(entry => {
    if (
      !entry || typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      || typeof entry.latestTime !== 'string'
      || !Number.isSafeInteger(entry.totalAmount) || entry.totalAmount <= 0
    ) throw new Error('복구 기록에 잘못된 금화 주머니 항목이 있습니다.');
    return { date: entry.date, latestTime: entry.latestTime, totalAmount: entry.totalAmount,...recoveryOwner(entry,journal.schemaVersion!) };
  });
  return {
    schemaVersion: 2,
    operationId: journal.operationId,
    createdAt: journal.createdAt as number,
    entries,
  };
}

function writeGoldPouchRecoveryJournal(journal: GoldPouchRecoveryJournal): void {
  writeRecoveryJournal(getGoldPouchRecoveryJournalPath(),journal);
}

function applyGoldPouchRecoveryOperation(journal: GoldPouchRecoveryJournal): boolean {
  if (!db) throw new Error('DB가 초기화되지 않았습니다.');
  let applied = false;
  db.transaction(() => {
    const operationResult = db!.prepare(`
      INSERT OR IGNORE INTO gold_pouch_flush_operations (operation_id, committed_at)
      VALUES (?, ?)
    `).run(journal.operationId, Date.now());
    if (operationResult.changes === 0) return;

    for (const entry of journal.entries) {
      accumulateDailyAmount('calc',GOLD_POUCH_DAILY_CONTENT,entry);
    }
    applied = true;
  })();
  return applied;
}

/** 남아 있는 금화 주머니 복구 기록을 operation ID 기준 정확히 한 번 적용한다. */
export function replayGoldPouchRecoveryJournal(): boolean {
  const journalPath = getGoldPouchRecoveryJournalPath();
  if (!fs.existsSync(journalPath)) return true;
  if (!db) return false;
  let journal: GoldPouchRecoveryJournal;
  try {
    journal = validateGoldPouchRecoveryJournal(JSON.parse(fs.readFileSync(journalPath, 'utf8')) as unknown);
  } catch (error) {
    const quarantinePath = `${journalPath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(journalPath, quarantinePath);
      log(`[DiaryDB] Invalid gold pouch recovery journal quarantined: ${quarantinePath} (${error})`);
    } catch (quarantineError) {
      log(`[DiaryDB] Invalid gold pouch recovery journal quarantine failed: ${quarantineError}`);
      return false;
    }
    return true;
  }

  try {
    const applied = applyGoldPouchRecoveryOperation(journal);
    try {
      fs.unlinkSync(journalPath);
    } catch (cleanupError) {
      log(`[DiaryDB] Gold pouch recovery journal cleanup deferred: ${cleanupError}`);
    }
    if (applied) notifyUpdate();
    return true;
  } catch (error) {
    log(`[DiaryDB] Gold pouch recovery journal replay failed: ${error}`);
    return false;
  }
}

export function hasPendingGoldPouchSeed(): boolean {
  return _pendingGoldPouchSeedByDate.size > 0 || fs.existsSync(getGoldPouchRecoveryJournalPath());
}

function requireFlushedDiaryAmounts():void {
  if (!flushPendingElso() || !flushPendingGoldPouchSeed()) throw new Error('대기 중인 일지 금액을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

/** 금화 주머니 환산 SEED 버퍼를 복구 가능한 단일 트랜잭션으로 저장합니다. */
export function flushPendingGoldPouchSeed(): boolean {
  if (db?.inTransaction && hasPendingGoldPouchSeed()) throw new Error('대기 중인 금화 기록을 프로필 전환 전에 저장해 주세요.');
  if (_goldPouchDebounceTimer) {
    clearTimeout(_goldPouchDebounceTimer);
    _goldPouchDebounceTimer = null;
  }
  if (_pendingGoldPouchSeedByDate.size === 0) {
    if (!db && fs.existsSync(getGoldPouchRecoveryJournalPath())) initDb();
    return replayGoldPouchRecoveryJournal();
  }
  if (!db) initDb();
  if (!db || !replayGoldPouchRecoveryJournal()) return false;

  const entries = Array.from(_pendingGoldPouchSeedByDate.entries());
  _pendingGoldPouchSeedByDate.clear();
  const journal: GoldPouchRecoveryJournal = {
    schemaVersion: 2,
    operationId: randomUUID(),
    createdAt: Date.now(),
    entries: entries
      .filter(([, info]) => info.totalAmount > 0)
      .map(([,info]) => ({...info})),
  };
  if (journal.entries.length === 0) return true;

  let journalWritten = false;
  try {
    writeGoldPouchRecoveryJournal(journal);
    journalWritten = true;
    applyGoldPouchRecoveryOperation(journal);
    try {
      fs.unlinkSync(getGoldPouchRecoveryJournalPath());
    } catch (cleanupError) {
      log(`[DiaryDB] Gold pouch recovery journal cleanup deferred: ${cleanupError}`);
    }
    notifyUpdate();
    return true;
  } catch (error) {
    if (!journalWritten) {
      for (const [date, info] of entries) {
        const current = _pendingGoldPouchSeedByDate.get(date) || {...info,totalAmount:0};
        current.totalAmount += info.totalAmount;
        current.latestTime = info.latestTime;
        _pendingGoldPouchSeedByDate.set(date, current);
      }
    }
    log(`[DiaryDB] flushPendingGoldPouchSeed failed: ${error}`);
    return false;
  }
}

export interface BatchSyncResult {
  success: boolean;
  lootsAdded: number;
  essencesAdded: number;
  seedsAdded: number;
  elsoPointsAdded: number;
  shoutsAdded: number;
  error?: string;
}

function createFailedBatchSyncResult(error: string): BatchSyncResult {
  return {
    success: false,
    lootsAdded: 0,
    essencesAdded: 0,
    seedsAdded: 0,
    elsoPointsAdded: 0,
    shoutsAdded: 0,
    error
  };
}

/**
 * 과거 로그 동기화 결과물을 작은 유한 배치 단위 트랜잭션으로 커밋합니다.
 */
export function batchInsertSyncResults(data: BatchSyncData): BatchSyncResult {
  if (!flushPendingElso() || !flushPendingGoldPouchSeed()) return createFailedBatchSyncResult('대기 중인 일지 기록을 먼저 저장해 주세요.');
  if (!db) initDb();
  if (!db) return createFailedBatchSyncResult('데이터베이스를 초기화하지 못했습니다.');

  let lootsAdded = 0;
  let essencesAdded = 0;
  let seedsAdded = 0;
  let elsoPointsAdded = 0;
  let shoutsAdded = 0;

  const profileId=currentOwner().profileId;
  const selectActivity = db.prepare('SELECT id FROM activity_logs WHERE date = ? AND time = ? AND content = ? AND profile_id IS ?');
  const insertActivity = db.prepare('INSERT INTO activity_logs (date, type, content, time, amount) VALUES (?, ?, ?, ?, ?)');
  const selectShout = db.prepare('SELECT id FROM shout_history WHERE sender = ? AND message = ? AND ABS(timestamp - ?) <= 5');
  const insertShout = db.prepare('INSERT INTO shout_history (timestamp, sender, message, shout_kind) VALUES (?, ?, ?, ?)');
  const selectElso = db.prepare("SELECT id, amount FROM activity_logs WHERE date = ? AND type = 'elso' AND profile_id IS ? ORDER BY id ASC LIMIT 1");
  const updateElso = db.prepare("UPDATE activity_logs SET time = ?, amount = ? WHERE id = ?");
  const selectGoldPouchSeed = db.prepare("SELECT id, amount FROM activity_logs WHERE date = ? AND type = 'calc' AND content = ? AND profile_id IS ? ORDER BY id ASC LIMIT 1");
  const updateGoldPouchSeed = db.prepare('UPDATE activity_logs SET time = ?, amount = ? WHERE id = ?');
  const countAutomaticCalcRows = db.prepare(`
    SELECT COUNT(*) AS count FROM activity_logs
    WHERE date = ? AND source = 'automatic' AND type = 'calc' AND content LIKE '[자동] %' AND profile_id IS ?
  `);
  const deleteAutomaticLogRows = db.prepare(`
    DELETE FROM activity_logs
    WHERE date = ? AND source = 'automatic' AND profile_id IS ? AND (
      type = 'loot'
      OR type = 'elso'
      OR (type = 'calc' AND content LIKE '[자동] %')
    )
  `);
  const deleteShoutsForDate = db.prepare(`
    DELETE FROM shout_history
    WHERE timestamp >= ? AND timestamp < ?
  `);

  const selectStone = db.prepare(`
    SELECT id, amount FROM activity_logs 
    WHERE date = ? AND type = 'loot' AND (content = ? OR content LIKE ?) AND profile_id IS ?
    ORDER BY id ASC LIMIT 1
  `);
  const updateStone = db.prepare('UPDATE activity_logs SET content = ?, time = ?, amount = ? WHERE id = ?');
  const insertCommittedEvent = db.prepare(`
    INSERT OR IGNORE INTO chat_sync_committed_events (event_id, committed_at,profile_id)
    VALUES (?, ?,?)
  `);

  const runBatch = db.transaction(() => {
    const insertedActivityKeys = new Set<string>();
    const insertDistinctNewActivity = (
      date: string,
      type: 'loot' | 'calc',
      content: string,
      timeOnly: string,
      amount: number,
    ): boolean => {
      const eventKey = JSON.stringify([date, timeOnly, content]);
      const existing = selectActivity.get(date,timeOnly,content,profileId);
      // 같은 배치 안의 서로 다른 실제 이벤트는 같은 초·같은 내용이어도 모두 보존한다.
      // 배치 시작 전에 있던 행은 구버전 재탐색 중복일 수 있으므로 기존처럼 건너뛴다.
      if (existing && !insertedActivityKeys.has(eventKey)) return false;
      insertActivity.run(date, type, content, timeOnly, amount);
      insertedActivityKeys.add(eventKey);
      return true;
    };

    const replaceDate = data.replaceAutomaticDate;
    if (replaceDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(replaceDate)) {
        throw new Error('자동 채팅 로그 기록 교체 날짜가 유효하지 않습니다.');
      }
      const invalidDate = [
        ...data.loots,
        ...(data.essences || []),
        ...data.seeds,
        ...data.elsoPoints,
        ...(data.goldPouchSeeds || []),
      ].some(item => item.date !== replaceDate);
      if (invalidDate) throw new Error('자동 채팅 로그 기록 교체 배치에 다른 날짜가 포함되어 있습니다.');

      const [year, month, day] = replaceDate.split('-').map(Number);
      const replaceDateStart = Math.floor(new Date(year, month - 1, day, 0, 0, 0, 0).getTime() / 1000);
      const replaceDateEnd = Math.floor(new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime() / 1000);
      if (data.shouts.some(item => item.fullTimestamp < replaceDateStart || item.fullTimestamp >= replaceDateEnd)) {
        throw new Error('자동 채팅 로그 외치기 교체 배치에 다른 날짜가 포함되어 있습니다.');
      }

      const previousCalcCount = (countAutomaticCalcRows.get(replaceDate,profileId) as {count:number} | undefined)?.count || 0;
      if (previousCalcCount > 0) subtractScore(replaceDate, previousCalcCount * POINTS.CALC_RECORD);
      deleteAutomaticLogRows.run(replaceDate,profileId);
      deleteShoutsForDate.run(replaceDateStart, replaceDateEnd);
    }

    const claimEvent = (eventId?:string,allowExisting=!!data.replaceAutomaticDate,owner=profileId): boolean => {
      if (!eventId) return true;
      const existing=getStmt('SELECT profile_id FROM chat_sync_committed_events WHERE event_id=?').get(eventId) as {profile_id:string | null} | undefined;
      // 같은 원본 이벤트를 다른 프로필로 중복 복원하거나 기존 미배정 기록을 암묵 재배정하지 않는다.
      if (existing) return allowExisting && existing.profile_id===owner;
      return insertCommittedEvent.run(eventId,Date.now(),owner).changes>0;
    };

    // 1-1. 득템 및 마정석 기록
    const magicStonesByDate: Record<string, Record<string, { latestTime: string; totalCount: number }>> = {};
    for (const item of data.loots) {
      ensureDiaryExists(item.date);
      if (item.diaryContent.includes('마정석')) {
        if (!claimEvent(item.eventId,true)) continue;
        const grade = item.diaryContent.includes('최상급') ? '최상급' : (item.diaryContent.includes('상급') ? '상급' : (item.diaryContent.includes('중급') ? '중급' : '하급'));
        if (!magicStonesByDate[item.date]) magicStonesByDate[item.date] = {};
        if (!magicStonesByDate[item.date][grade]) {
          magicStonesByDate[item.date][grade] = { latestTime: item.timeOnly, totalCount: 0 };
        }
        magicStonesByDate[item.date][grade].totalCount += (item.count || 1);
        magicStonesByDate[item.date][grade].latestTime = item.timeOnly;
      } else {
        if (!claimEvent(item.eventId)) continue;
        if (insertDistinctNewActivity(item.date, 'loot', item.diaryContent, item.timeOnly, item.count)) lootsAdded++;
      }
    }

    // 마정석 일자별 1줄 덮어쓰기/보정
    for (const [date, grades] of Object.entries(magicStonesByDate)) {
      for (const [grade, info] of Object.entries(grades)) {
        const standardContent = `[득템] [${grade} 마정석]`;
        const existing = selectStone.get(date,standardContent,`%${grade}%마정석%`,profileId) as {id:number;amount:number} | undefined;

        if (existing) {
          if (existing.amount !== info.totalCount) {
            if (info.totalCount > existing.amount) {
              lootsAdded += (info.totalCount - existing.amount);
            }
            updateStone.run(standardContent, info.latestTime, info.totalCount, existing.id);
          }
        } else {
          insertActivity.run(date, 'loot', standardContent, info.latestTime, info.totalCount);
          lootsAdded += info.totalCount;
        }
      }
    }

    // 1-2. 경험의 정수 기록
    for (const item of (data.essences || [])) {
      if (!claimEvent(item.eventId)) continue;
      ensureDiaryExists(item.date);
      if (insertDistinctNewActivity(item.date, 'loot', item.diaryContent, item.timeOnly, item.count)) {
        // 동기화 결과의 단위는 로그 줄 수가 아니라 실제 경험의 정수 개수입니다.
        essencesAdded += item.count;
      }
    }

    // 2. SEED 기록
    for (const item of data.seeds) {
      if (!claimEvent(item.eventId)) continue;
      ensureDiaryExists(item.date);
      if (insertDistinctNewActivity(item.date, 'calc', item.content, item.timeOnly, item.amount)) {
        addScore(item.date, POINTS.CALC_RECORD);
        seedsAdded++;
      }
    }

    // 2-1. 과거 로그의 날짜별 금화 주머니 총액과 로컬 DB 중 큰 값을 유지한다.
    for (const item of (data.goldPouchSeeds || [])) {
      if (!claimEvent(item.eventId,true)) continue;
      ensureDiaryExists(item.date);
      const existing = selectGoldPouchSeed.get(item.date,GOLD_POUCH_DAILY_CONTENT,profileId) as {id:number;amount:number} | undefined;
      if (existing) {
        if (item.amount > (existing.amount || 0)) {
          updateGoldPouchSeed.run(item.timeOnly, item.amount, existing.id);
          seedsAdded++;
        }
      } else if (item.amount > 0) {
        insertActivity.run(item.date, 'calc', GOLD_POUCH_DAILY_CONTENT, item.timeOnly, item.amount);
        addScore(item.date, POINTS.CALC_RECORD);
        seedsAdded++;
      }
    }

    // 3. 엘소 포인트 (일자별 총합 집계 후 멱등성 있게 반영하여 중복 누적 방지)
    const elsoByDate: Record<string, { latestTime: string; totalAmount: number }> = {};
    for (const item of data.elsoPoints) {
      if (!claimEvent(item.eventId,true)) continue;
      if (!elsoByDate[item.date]) {
        elsoByDate[item.date] = { latestTime: item.timeOnly, totalAmount: 0 };
      }
      elsoByDate[item.date].totalAmount += item.amount;
      elsoByDate[item.date].latestTime = item.timeOnly;
    }

    for (const [date, info] of Object.entries(elsoByDate)) {
      ensureDiaryExists(date);
      const existing = selectElso.get(date,profileId) as {id:number;amount:number} | undefined;
      if (existing) {
        if (existing.amount !== info.totalAmount) {
          if (info.totalAmount > existing.amount) {
            elsoPointsAdded += (info.totalAmount - existing.amount);
          }
          updateElso.run(info.latestTime, info.totalAmount, existing.id);
        }
      } else {
        insertActivity.run(date, 'elso', '엘소 포인트 획득', info.latestTime, info.totalAmount);
        elsoPointsAdded += info.totalAmount;
      }
    }

    // 4. 외치기 기록 (5초 이내 동일 발신자/내용 중복 방지)
    for (const item of data.shouts) {
      if (!claimEvent(item.eventId,!!data.replaceAutomaticDate,null)) continue;
      const existing = selectShout.get(item.sender, item.message, item.fullTimestamp);
      if (!existing) {
        insertShout.run(item.fullTimestamp, item.sender, item.message, item.shoutKind ?? null);
        shoutsAdded++;
      }
    }
  });

  try {
    runBatch();
  } catch (err) {
    log(`[DiaryDB] batchInsertSyncResults failed: ${err}`);
    propagateTransactionFailure(err);
    // 트랜잭션은 전부 롤백되므로 중간에 증가한 메모리 카운터를 성공 건수로 반환하면 안 된다.
    return createFailedBatchSyncResult(err instanceof Error ? err.message : String(err));
  }
  return { success: true, lootsAdded, essencesAdded, seedsAdded, elsoPointsAdded, shoutsAdded };
}

/** 
 * 최근 N시간 동안의 외치기 기록을 가져옵니다. (검색어 지원)
 */
export function getShoutHistory(hours: number = 24, searchQuery: string = ''): any[] {
  if (!db) initDb();
  if (!db) return [];

  const since = Math.floor(Date.now() / 1000) - (hours * 60 * 60);

  if (searchQuery.trim()) {
    const stmt = db.prepare(`
      SELECT * FROM shout_history 
      WHERE timestamp > ? 
      AND (message LIKE ? OR sender LIKE ?)
      ORDER BY timestamp DESC
    `);
    const s = `%${searchQuery.trim()}%`;
    return stmt.all(since, s, s);
  } else {
    const stmt = db.prepare('SELECT * FROM shout_history WHERE timestamp > ? ORDER BY timestamp DESC');
    return stmt.all(since);
  }
}

/**
 * 지정 단어 알림 이력과 당시 5분간의 대화 맥락을 하나의 트랜잭션으로 저장합니다.
 * 또한 24시간이 지난 오래된 알림 이력은 자동으로 삭제합니다.
 */
export function addWordAlarmHistory(
  keyword: string, 
  sender: string, 
  message: string, 
  contextList: Array<{ timestamp: number; sender: string; message: string; color: string }>
): number {
  if (!db) initDb();
  if (!db) return -1;

  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - (24 * 60 * 60);
  let alarmId = -1;

  try {
    db.transaction(() => {
      // 1. 24시간 지난 오래된 알림 삭제 (ON DELETE CASCADE에 의해 대화 맥락도 자동 삭제됨)
      db!.prepare('DELETE FROM word_alarm_history WHERE alarm_timestamp < ?').run(oneDayAgo);

      // 2. 새 알림 이력 추가
      const insertHistoryStmt = db!.prepare(
        'INSERT INTO word_alarm_history (alarm_timestamp, keyword, sender, message) VALUES (?, ?, ?, ?)'
      );
      const result = insertHistoryStmt.run(now, keyword, sender, message);
      alarmId = Number(result.lastInsertRowid);

      // 3. 연관된 5분 대화 맥락 추가
      const insertContextStmt = db!.prepare(
        'INSERT INTO word_alarm_chat_context (alarm_id, timestamp, sender, message, color) VALUES (?, ?, ?, ?, ?)'
      );
      for (const ctx of contextList) {
        const ctxTimestamp = Math.floor(ctx.timestamp / 1000);
        insertContextStmt.run(alarmId, ctxTimestamp, ctx.sender, ctx.message, ctx.color);
      }
    })();

    notifyUpdate();
    return alarmId;
  } catch (err) {
    log(`[DiaryDB] addWordAlarmHistory failed: ${err}`);
    return -1;
  }
}

/**
 * 감지 후 5분 동안 발생하는 개별 대화 한 줄을 특정 알림 ID에 매핑하여 추가합니다.
 */
export function addWordAlarmContextLine(
  alarmId: number,
  timestamp: number,
  sender: string,
  message: string,
  color: string
): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    // alarmId가 실제로 존재하지 않으면 insert를 스킵하여 FOREIGN KEY constraint crash 방지
    const exists = db.prepare('SELECT id FROM word_alarm_history WHERE id = ?').get(alarmId);
    if (!exists) {
      log(`[DiaryDB] word_alarm_history에서 alarmId ${alarmId}를 찾을 수 없습니다. context line 추가를 생략합니다.`);
      return false;
    }

    const stmt = db.prepare(
      'INSERT INTO word_alarm_chat_context (alarm_id, timestamp, sender, message, color) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(alarmId, Math.floor(timestamp / 1000), sender, message, color);
    notifyUpdate();
    return true;
  } catch (error) {
    log(`[DiaryDB] addWordAlarmContextLine 실패 (alarmId: ${alarmId}): ${error}`);
    return false;
  }
}

/**
 * 최근 N시간 동안 발생한 지정 단어 알림 이력을 가져옵니다.
 */
export function getWordAlarmHistory(hours: number = 24): any[] {
  if (!db) initDb();
  if (!db) return [];

  const since = Math.floor(Date.now() / 1000) - (hours * 60 * 60);
  const stmt = db.prepare('SELECT * FROM word_alarm_history WHERE alarm_timestamp > ? ORDER BY alarm_timestamp DESC');
  return stmt.all(since);
}

/**
 * 특정 알림에 연동된 5분 대화 맥락을 가져옵니다.
 */
export function getWordAlarmContext(alarmId: number): any[] {
  if (!db) initDb();
  if (!db) return [];

  const stmt = db.prepare('SELECT * FROM word_alarm_chat_context WHERE alarm_id = ? ORDER BY timestamp ASC');
  return stmt.all(alarmId);
}

/**
 * 특정 지정 단어 알림 히스토리 아이템을 개별 삭제합니다. (Cascades to context)
 */
export function deleteWordAlarmHistoryItem(id: number): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    db.prepare('DELETE FROM word_alarm_history WHERE id = ?').run(id);
    notifyUpdate();
    return true;
  } catch (err) {
    log(`[DiaryDB] deleteWordAlarmHistoryItem failed: ${err}`);
    return false;
  }
}

/**
 * 모든 지정 단어 알림 히스토리와 관련된 맥락 데이터를 전체 삭제합니다.
 */
export function clearWordAlarmHistory(): boolean {
  if (!db) initDb();
  if (!db) return false;

  try {
    db.prepare('DELETE FROM word_alarm_history').run();
    notifyUpdate();
    return true;
  } catch (err) {
    log(`[DiaryDB] clearWordAlarmHistory failed: ${err}`);
    return false;
  }
}

export function getHuntingGrounds(): any[] {
  if (!db) initDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM hunting_grounds').all();
  } catch (e) {
    log(`[DiaryDB] getHuntingGrounds failed: ${e}`);
    return [];
  }
}

export function getHuntingPath(groundId: string): Array<[number, number, string?]> {
  if (!db) initDb();
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT x, y, color FROM hunting_paths WHERE hunting_ground_id = ? ORDER BY seq ASC').all(groundId) as any[];
    return rows.map(r => [r.x, r.y, r.color || undefined]);
  } catch (e) {
    log(`[DiaryDB] getHuntingPath failed (groundId: ${groundId}): ${e}`);
    return [];
  }
}

export function saveHuntingPath(groundId: string, points: Array<[number, number, string?]>): void {
  if (!db) initDb();
  if (!db) return;
  try {
    const transaction = db.transaction(() => {
      db!.prepare('DELETE FROM hunting_paths WHERE hunting_ground_id = ?').run(groundId);
      const stmt = db!.prepare('INSERT INTO hunting_paths (hunting_ground_id, seq, x, y, color) VALUES (?, ?, ?, ?, ?)');
      points.forEach((p, idx) => {
        stmt.run(groundId, idx, p[0], p[1], p[2] || null);
      });
    });
    transaction();
  } catch (e) {
    log(`[DiaryDB] saveHuntingPath failed (groundId: ${groundId}): ${e}`);
  }
}

export function cleanOldDiaryData(keepDays: number): void {
  if (!db) initDb();
  if (!db) return;

  if (keepDays <= 0) return;

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    cutoff.setHours(0, 0, 0, 0);
    const cutoffStr = formatLocalDateKey(cutoff);

    const transaction = db.transaction(() => {
      const delHw = db!.prepare('DELETE FROM homework_logs WHERE date < ?');
      const delAct = db!.prepare('DELETE FROM activity_logs WHERE date < ?');
      const delDiary = db!.prepare('DELETE FROM diaries WHERE date < ?');

      const infoHw = delHw.run(cutoffStr);
      const infoAct = delAct.run(cutoffStr);
      db!.prepare('DELETE FROM diary_profile_days WHERE date < ?').run(cutoffStr);
      const infoDiary = delDiary.run(cutoffStr);

      log(`[DiaryDB] Cleanup completed. Removed: ${infoDiary.changes} diaries, ${infoHw.changes} homework logs, ${infoAct.changes} activity logs (Older than ${cutoffStr})`);
    });

    transaction();
    notifyUpdate();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[DiaryDB] Failed to clean old data: ${errMsg}`);
  }
}

export function addElsoPoints(date: string, time: string, points: number): void {
  if (!Number.isSafeInteger(points) || points <= 0) return;
  if (!db) initDb();
  const owner=currentOwner();
  if (db?.inTransaction) {accumulateDailyAmount('elso','엘소 포인트 획득',{...owner,date,latestTime:time,totalAmount:points});return;}
  const key=pendingKey({...owner,date});
  const current = _pendingElsoByDate.get(key) || {...owner,date,latestTime:time,totalAmount:0};
  if (!Number.isSafeInteger(current.totalAmount+points)) throw new Error('엘소 포인트 합계가 저장 범위를 초과했습니다.');
  current.totalAmount += points;
  current.latestTime = time;
  _pendingElsoByDate.set(key, current);

  // 1. 디스크 영구 저장용 3초 디바운스 타이머
  if (_elsoDebounceTimer) {
    clearTimeout(_elsoDebounceTimer);
  }
  _elsoDebounceTimer = setTimeout(() => {
    flushPendingElso();
  }, ELSO_FLUSH_DEBOUNCE_MS);

  // 2. 오늘의 요약 HUD 실시간 반영용 1초 쓰로틀링 UI 알림 (디스크 I/O 없이 메모리 데이터로 부드럽게 실시간 갱신)
  throttleNotifyUpdate(1000);
}

/** 실시간으로 감지한 금화 주머니 환산 SEED를 날짜별 단일 행에 누적합니다. */
export function addGoldPouchSeed(date: string, time: string, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  if (!db) initDb();
  const owner=currentOwner();
  if (db?.inTransaction) {accumulateDailyAmount('calc',GOLD_POUCH_DAILY_CONTENT,{...owner,date,latestTime:time,totalAmount:amount});return;}
  const key=pendingKey({...owner,date});
  const current = _pendingGoldPouchSeedByDate.get(key) || {...owner,date,latestTime:time,totalAmount:0};
  if (!Number.isSafeInteger(current.totalAmount+amount)) throw new Error('금화 주머니 합계가 저장 범위를 초과했습니다.');
  current.totalAmount += amount;
  current.latestTime = time;
  _pendingGoldPouchSeedByDate.set(key, current);

  if (_goldPouchDebounceTimer) clearTimeout(_goldPouchDebounceTimer);
  _goldPouchDebounceTimer = setTimeout(() => {
    flushPendingGoldPouchSeed();
  }, GOLD_POUCH_FLUSH_DEBOUNCE_MS);

  throttleNotifyUpdate(1000);
}

/**
 * 알람 로그 추가
 */
export function addAlarmLog(
  type: 'boss' | 'custom' | 'word' | 'wave' | 'buff' | 'etc',
  title: string,
  message: string,
  metadata: {
    scheduledAt?: number;
    recordedAt?: number;
    deliveryStatus?: 'fired' | 'missed-sleep';
    dedupeKey?: string;
  } = {}
): boolean {
  if (!db) initDb();
  if (!db) return false;
  try {
    const recordedAt = metadata.recordedAt ?? Date.now();
    const scheduledAt = metadata.scheduledAt ?? recordedAt;
    const deliveryStatus = metadata.deliveryStatus ?? 'fired';
    if (!Number.isFinite(recordedAt) || !Number.isFinite(scheduledAt)) return false;
    if (deliveryStatus !== 'fired' && deliveryStatus !== 'missed-sleep') return false;
    const dedupeKey = metadata.dedupeKey?.trim() || null;
    db.transaction(() => {
      db!.prepare(`
        INSERT INTO alarm_logs
          (timestamp, scheduled_at, recorded_at, delivery_status, dedupe_key, type, title, message,profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?,?)
        ON CONFLICT DO NOTHING
      `).run(
        recordedAt,
        scheduledAt,
        recordedAt,
        deliveryStatus,
        dedupeKey,
        type,
        title,
        message,
        currentOwner().profileId
      );

      // 용량 관리를 위해 24시간 이전의 로그 자동 삭제 (24시간 = 24 * 60 * 60 * 1000 ms)
      const oneDayAgo = recordedAt - 24 * 60 * 60 * 1000;
      db!.prepare('DELETE FROM alarm_logs WHERE recorded_at < ?').run(oneDayAgo);
    })();
    log(`[DiaryDB] 알람 로그 추가: [${type}] ${title} - ${message}`);

    notifyAlarmLogUpdate();
    return true;
  } catch (e) {
    log(`[DiaryDB] addAlarmLog 실패: ${e}`);
    propagateTransactionFailure(e);
    return false;
  }
}

/**
 * 알람 로그 조회
 */
export function getAlarmLogs(limit:number=100,filter:DiaryProfileFilter=ALL_DIARY_PROFILES): AlarmLog[] {
  if (!db) initDb();
  if (!db) return [];
  try {
    const scope=diaryProfilePredicate(filter);
    return db.prepare(`
      SELECT id,timestamp,type,title,message,profile_id,record_uuid,record_device_id,record_session_id,
             scheduled_at AS scheduledAt,
             recorded_at AS recordedAt,
             delivery_status AS deliveryStatus,
             dedupe_key AS dedupeKey
      FROM alarm_logs
      WHERE 1=1 ${scope.sql}
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(...scope.params,limit) as AlarmLog[];
  } catch (e) {
    log(`[DiaryDB] getAlarmLogs 실패: ${e}`);
    return [];
  }
}

/**
 * 알람 로그 전체 삭제
 */
export function clearAlarmLogs(): boolean {
  if (!db) initDb();
  if (!db) return false;
  try {
    db.prepare('DELETE FROM alarm_logs').run();
    log('[DiaryDB] 모든 알람 로그 삭제 완료');
    notifyAlarmLogUpdate();
    return true;
  } catch (e) {
    log(`[DiaryDB] clearAlarmLogs 실패: ${e}`);
    return false;
  }
}

/**
 * 알람 로그 업데이트 알림
 */
function notifyAlarmLogUpdate(): void {
  broadcastToAllWindows('alarm-logs-updated');
}

/**
 * 시간 측정 기록 추가
 */
export function addTimerRecord(record: Omit<TimerRecord, 'id'>): boolean {
  if (!db) initDb();
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO timer_records (date, duration, title, series, core_master, coefficient, char_main, char_sub, base_main, enchant_main, base_sub, enchant_sub, accuracy, raw_profile_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.date,
      record.duration,
      record.title,
      record.series,
      record.core_master,
      record.coefficient,
      record.char_main,
      record.char_sub,
      record.base_main,
      record.enchant_main,
      record.base_sub,
      record.enchant_sub,
      record.accuracy,
      record.raw_profile_data
    );
    log(`[DiaryDB] Timer record added: ${record.date} - ${record.duration}ms`);
    notifyTimerUpdate();
    return true;
  } catch (e) {
    log(`[DiaryDB] addTimerRecord failed: ${e}`);
    propagateTransactionFailure(e);
    return false;
  }
}

/**
 * 시간 측정 기록 목록 조회
 */
export function getTimerRecords(filter:DiaryProfileFilter=ALL_DIARY_PROFILES): TimerRecord[] {
  if (!db) initDb();
  if (!db) return [];
  try {
    const scope=diaryProfilePredicate(filter);
    return db.prepare(`SELECT * FROM timer_records WHERE 1=1${scope.sql} ORDER BY date DESC`).all(...scope.params) as TimerRecord[];
  } catch (e) {
    log(`[DiaryDB] getTimerRecords failed: ${e}`);
    return [];
  }
}

/**
 * 시간 측정 기록 단건 조회 (조회 화면의 프로필 필터와 독립적)
 */
export function getTimerRecord(id:number):TimerRecord | null {
  if (!db) initDb();if (!db) return null;
  return db.prepare('SELECT * FROM timer_records WHERE id=?').get(id) as TimerRecord | undefined || null;
}

export function updateTimerRecordTitle(id: number, title: string): boolean {
  if (!db) initDb();
  if (!db) return false;
  try {
    db.prepare('UPDATE timer_records SET title = ? WHERE id = ?').run(title, id);
    log(`[DiaryDB] Timer record title updated (id: ${id}) -> ${title}`);
    notifyTimerUpdate();
    return true;
  } catch (e) {
    log(`[DiaryDB] updateTimerRecordTitle failed: ${e}`);
    return false;
  }
}

/**
 * 시간 측정 기록 계열, 코어 마스터, 계산된 계수 수정
 */
export function updateTimerRecordSeriesAndCore(
  id: number,
  series: string,
  core_master: string,
  coefficient: number,
  char_main: number,
  char_sub: number,
  base_main: number,
  enchant_main: number,
  base_sub: number,
  enchant_sub: number,
  accuracy: number
): boolean {
  if (!db) initDb();
  if (!db) return false;
  try {
    db.prepare(`
      UPDATE timer_records 
      SET series = ?, core_master = ?, coefficient = ?, 
          char_main = ?, char_sub = ?, base_main = ?, enchant_main = ?, 
          base_sub = ?, enchant_sub = ?, accuracy = ? 
      WHERE id = ?
    `).run(
      series,
      core_master,
      coefficient,
      char_main,
      char_sub,
      base_main,
      enchant_main,
      base_sub,
      enchant_sub,
      accuracy,
      id
    );
    log(`[DiaryDB] Timer record updated (id: ${id}) -> series: ${series}, core: ${core_master}, coeff: ${coefficient}`);
    notifyTimerUpdate();
    return true;
  } catch (e) {
    log(`[DiaryDB] updateTimerRecordSeriesAndCore failed: ${e}`);
    return false;
  }
}

/**
 * 시간 측정 기록 삭제
 */
export function deleteTimerRecord(id: number): boolean {
  if (!db) initDb();
  if (!db) return false;
  try {
    db.prepare('DELETE FROM timer_records WHERE id = ?').run(id);
    log(`[DiaryDB] Timer record deleted (id: ${id})`);
    notifyTimerUpdate();
    return true;
  } catch (e) {
    log(`[DiaryDB] deleteTimerRecord failed: ${e}`);
    return false;
  }
}

/**
 * 시간 측정 기록 업데이트 알림
 */
function notifyTimerUpdate(): void {
  try {broadcastToAllWindows('timer-updated');} catch (error) {log(`[DiaryDB] Timer refresh failed: ${error}`);}
}



