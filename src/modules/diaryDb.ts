import * as path from 'path';
import { app } from 'electron';
import Database = require('better-sqlite3');
import { log } from './logger';
import { DiaryEntry, HomeworkLog, ActivityLog, DiaryData, AlarmLog, TimerRecord } from '../shared/types';
import { broadcastToAllWindows } from './windowMessaging';
import { formatLootDiaryContent, parseItemAcquisition } from './itemAcquisition';

let db: Database.Database | null = null;

// 포인트 산정 규칙
const POINTS = {
  DAILY_HOMEWORK: 10,
  WEEKLY_HOMEWORK: 0, // 주간 숙제는 포인트 제외
  BOSS_KILL: 10,
  CALC_RECORD: 10
};

/** 엘소 포인트 인메모리 버퍼 (날짜별 누적 및 3초 디바운스 배치 저장) */
const ELSO_FLUSH_DEBOUNCE_MS = 3000;
let _elsoDebounceTimer: NodeJS.Timeout | null = null;
const _pendingElsoByDate = new Map<string, { latestTime: string; totalAmount: number }>();

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
  return _pendingElsoByDate.size > 0;
}

/** 인메모리 버퍼에 대기 중인 엘소 포인트를 DB에 즉시 1회 트랜잭션으로 커밋합니다. */
export function flushPendingElso(): void {
  if (_elsoDebounceTimer) {
    clearTimeout(_elsoDebounceTimer);
    _elsoDebounceTimer = null;
  }
  if (_notifyThrottleTimer) {
    clearTimeout(_notifyThrottleTimer);
    _notifyThrottleTimer = null;
  }
  if (_pendingElsoByDate.size === 0) return;
  if (!db) initDb();
  if (!db) return;

  const entries = Array.from(_pendingElsoByDate.entries());
  _pendingElsoByDate.clear();

  try {
    const transaction = db.transaction(() => {
      const selectElso = db!.prepare("SELECT id, amount FROM activity_logs WHERE date = ? AND type = 'elso'");
      const updateElso = db!.prepare("UPDATE activity_logs SET time = ?, amount = ? WHERE id = ?");
      const insertElso = db!.prepare("INSERT INTO activity_logs (date, type, content, time, amount) VALUES (?, 'elso', '엘소 포인트 획득', ?, ?)");

      for (const [date, info] of entries) {
        if (info.totalAmount <= 0) continue;
        ensureDiaryExists(date);
        const existing = selectElso.get(date) as { id: number; amount: number } | undefined;

        if (existing) {
          const newAmount = existing.amount + info.totalAmount;
          updateElso.run(info.latestTime, newAmount, existing.id);
          log(`[DiaryDB] Elso batch flushed for date ${date}: ${existing.amount} + ${info.totalAmount} = ${newAmount}`);
        } else {
          insertElso.run(date, info.latestTime, info.totalAmount);
          log(`[DiaryDB] Elso batch created for date ${date}: ${info.totalAmount}`);
        }
      }
    });

    transaction();
    notifyUpdate();
  } catch (error) {
    // DB 트랜잭션 실패 시 데이터 유실 방지를 위해 버퍼 복원
    for (const [date, info] of entries) {
      const cur = _pendingElsoByDate.get(date) || { latestTime: info.latestTime, totalAmount: 0 };
      cur.totalAmount += info.totalAmount;
      cur.latestTime = info.latestTime;
      _pendingElsoByDate.set(date, cur);
    }
    log(`[DiaryDB] flushPendingElso failed: ${error}`);
  }
}

const statementCache = new Map<string, Database.Statement>();

/** 캐시된 Prepared Statement 반환 (SQLite VDBE 재컴파일 방지) */
export function getStmt(sql: string): Database.Statement<any[]> {
  if (!db) initDb();
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = db!.prepare(sql);
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

export function initDb(): void {
  if (db) return; // 이미 초기화된 경우 스킵
  try {
    let userDataPath = '';
    try {
      userDataPath = app ? app.getPath('userData') : '.';
    } catch (e) {
      userDataPath = '.';
    }
    const dbPath = path.join(userDataPath, 'diary.db');
    db = new Database(dbPath);

    // 외래 키 제약 조건 활성화 및 고성능 저널 모드 설정
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
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

    // PRAGMA user_version 기반 1회성 마이그레이션 관리 (매 부팅 시 풀스캔 제거)
    const userVersion = (db.pragma('user_version', { simple: true }) as number) || 0;

    if (userVersion < 1) {
      // char_main 및 char_sub 컬럼 하위 호환 마이그레이션
      try {
        db.prepare("ALTER TABLE timer_records ADD COLUMN char_main INTEGER NOT NULL DEFAULT 0").run();
      } catch (e) {}
      try {
        db.prepare("ALTER TABLE timer_records ADD COLUMN char_sub INTEGER NOT NULL DEFAULT 0").run();
      } catch (e) {}

      // 마이그레이션: amount 컬럼이 없는 경우 추가 (이미 테이블이 생성된 경우 대비)
      try {
        const columns = db.prepare("PRAGMA table_info(activity_logs)").all() as any[];
        const hasAmount = columns.some(c => c.name === 'amount');
        if (!hasAmount) {
          db.exec("ALTER TABLE activity_logs ADD COLUMN amount INTEGER DEFAULT 0");
          log('[DiaryDB] activity_logs table updated with amount column.');
          migrateExistingData();
        }
      } catch (e) {
        log(`[DiaryDB] Migration check failed: ${e}`);
      }

      normalizeExistingLootContent();
      consolidateMagicStoneLogs();

      // 마이그레이션: 기존 대장간 이미지 경로를 최신 경로(대장간.png)로 업데이트 및 탭 이름 변경
      try {
        db.prepare(`
          UPDATE hunting_grounds 
          SET image_path = 'assets/img/field-map/대장간.png',
              name = '시오칸하임 대장간'
          WHERE id = 'forge'
        `).run();
        db.prepare(`
          UPDATE hunting_grounds 
          SET name = '골고다의 협곡'
          WHERE id = 'golgotha'
        `).run();
        db.prepare(`
          UPDATE hunting_grounds 
          SET name = '공허의 영역'
          WHERE id = 'void'
        `).run();
        log('[DiaryDB] Hunting grounds names and paths migrated successfully.');
      } catch (e) {
        log(`[DiaryDB] Hunting grounds migration failed: ${e}`);
      }

      // 마이그레이션: hunting_paths 테이블에 color 컬럼이 없는 경우 추가
      try {
        const columns = db.prepare("PRAGMA table_info(hunting_paths)").all() as any[];
        const hasColor = columns.some(c => c.name === 'color');
        if (!hasColor) {
          db.exec("ALTER TABLE hunting_paths ADD COLUMN color TEXT");
          log('[DiaryDB] hunting_paths table updated with color column.');
        }
      } catch (e) {
        log(`[DiaryDB] hunting_paths migration check failed: ${e}`);
      }

      // 마이그레이션: 이클립스 셀피나 -> 로카고스 데이터 인계
      try {
        db.prepare(`
          UPDATE homework_logs 
          SET content_id = replace(content_id, 'weekly-eclipse-boss-selfina', 'weekly-eclipse-boss-lokagos'),
              content_name = replace(content_name, '이클립스 (셀피나)', '이클립스 (로카고스)')
          WHERE content_id LIKE 'weekly-eclipse-boss-selfina%'
        `).run();
        db.prepare(`
          UPDATE activity_logs 
          SET content = replace(content, '셀피나', '로카고스')
          WHERE content LIKE '%셀피나%'
        `).run();
        log('[DiaryDB] SQLite data migrated successfully from selfina to lokagos.');
      } catch (e) {
        log(`[DiaryDB] SQLite selfina to lokagos migration failed: ${e}`);
      }

      // 마이그레이션: 고대 렐릭의 성소 (신조/키시니크) 데이터 합산/인계
      try {
        db.prepare(`
          UPDATE homework_logs 
          SET content_id = replace(replace(content_id, 'weekly-ancient-relic-shinjo', 'weekly-ancient-relic'), 'weekly-ancient-relic-kishinik', 'weekly-ancient-relic'),
              content_name = '고대 렐릭의 성소 (신조/키시니크)'
          WHERE content_id LIKE 'weekly-ancient-relic-shinjo%' OR content_id LIKE 'weekly-ancient-relic-kishinik%'
        `).run();
        
        // 중복 일지 레코드 단일화 처리
        db.prepare(`
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
          )
        `).run();

        db.prepare(`
          UPDATE activity_logs 
          SET content = replace(replace(content, '고대 렐릭의 성소 (신조)', '고대 렐릭의 성소 (신조/키시니크)'), '고대 렐릭의 성소 (키시니크)', '고대 렐릭의 성소 (신조/키시니크)')
          WHERE content LIKE '%고대 렐릭의 성소 (신조)%' OR content LIKE '%고대 렐릭의 성소 (키시니크)%'
        `).run();
        log('[DiaryDB] SQLite data migrated successfully for ancient relic sanctuary.');
      } catch (e) {
        log(`[DiaryDB] SQLite ancient relic migration failed: ${e}`);
      }

      deduplicateShoutHistory();
      db.pragma('user_version = 1');
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
          CREATE UNIQUE INDEX IF NOT EXISTS idx_homework_logs_date_content_unique
          ON homework_logs (date, content_id);
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
    log('[DiaryDB] Database initialized successfully.');
  } catch (error) {
    log(`[DiaryDB] Failed to initialize database: ${error}`);
    console.error('[DiaryDB] Error:', error);
    statementCache.clear();
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
  }
}

/** 과거에 원문 전체나 수량까지 content에 저장된 득템 기록을 표준 형식으로 정리합니다. */
function normalizeExistingLootContent(): void {
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
  }
}

/** 기존에 개별로 등록되어 있던 마정석 로그들을 일자별/등급별 단 1개의 레코드로 압축 통합합니다. */
function consolidateMagicStoneLogs(): void {
  if (!db) return;
  try {
    const rows = db.prepare(`
      SELECT id, date, time, content, amount 
      FROM activity_logs 
      WHERE type = 'loot' AND content LIKE '%마정석%'
      ORDER BY date ASC, time ASC, id ASC
    `).all() as Array<{ id: number; date: string; time: string; content: string; amount: number }>;

    if (rows.length === 0) return;

    // 일자별/등급별로 합산
    const summary: Record<string, Record<string, { latestTime: string; totalCount: number }>> = {};
    for (const r of rows) {
      const grade = r.content.includes('최상급') ? '최상급' : (r.content.includes('상급') ? '상급' : (r.content.includes('중급') ? '중급' : '하급'));
      const parsedCount = r.amount > 0 ? r.amount : (parseInt((r.content.match(/\[?(\d+)\]?개/) || [])[1], 10) || 1);

      if (!summary[r.date]) summary[r.date] = {};
      if (!summary[r.date][grade]) {
        summary[r.date][grade] = { latestTime: r.time, totalCount: 0 };
      }
      summary[r.date][grade].totalCount += parsedCount;
      summary[r.date][grade].latestTime = r.time;
    }

    const deleteStmt = db.prepare('DELETE FROM activity_logs WHERE id = ?');
    const insertStmt = db.prepare('INSERT INTO activity_logs (date, type, content, time, amount) VALUES (?, ?, ?, ?, ?)');

    db.transaction(() => {
      for (const r of rows) {
        deleteStmt.run(r.id);
      }
      for (const [date, grades] of Object.entries(summary)) {
        for (const [grade, info] of Object.entries(grades)) {
          const content = `[득템] [${grade} 마정석]`;
          insertStmt.run(date, 'loot', content, info.latestTime, info.totalCount);
        }
      }
    })();

    log(`[DiaryDB] Consolidated ${rows.length} magic stone records into daily totals.`);
  } catch (error) {
    log(`[DiaryDB] Magic stone consolidation failed: ${error}`);
  }
}

/**
 * 마정석 일자별 누적 기록 (하루에 등급별 1개의 레코드로 수량 누적 관리)
 */
export function addMagicStoneDaily(date: string, time: string, grade: string, count: number): void {
  if (!db) initDb();
  if (!db) return;

  const standardContent = `[득템] [${grade} 마정석]`;
  ensureDiaryExists(date);

  try {
    const existing = db.prepare(`
      SELECT id, amount FROM activity_logs 
      WHERE date = ? AND type = 'loot' AND (content = ? OR content LIKE ?)
      ORDER BY id ASC LIMIT 1
    `).get(date, standardContent, `%${grade}%마정석%`) as { id: number; amount: number } | undefined;

    if (existing) {
      const newAmount = (existing.amount || 0) + count;
      db.prepare(`UPDATE activity_logs SET content = ?, time = ?, amount = ? WHERE id = ?`)
        .run(standardContent, time, newAmount, existing.id);
    } else {
      db.prepare(`INSERT INTO activity_logs (date, type, content, time, amount) VALUES (?, 'loot', ?, ?, ?)`)
        .run(date, standardContent, time, count);
    }
  } catch (e) {
    log(`[DiaryDB] addMagicStoneDaily failed: ${e}`);
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
function parseMigrationNumber(s: string): number {
  let val = 0;
  const joMatch = s.match(/(\d+)조/);
  const eokMatch = s.match(/(\d+)억/);
  const manMatch = s.match(/(\d+)만/);
  const rawMatch = s.match(/([\d,]+)/);

  if (joMatch) val += parseInt(joMatch[1], 10) * 1000000000000;
  if (eokMatch) val += parseInt(eokMatch[1], 10) * 100000000;
  if (manMatch) val += parseInt(manMatch[1], 10) * 10000;
  if (!eokMatch && !manMatch && rawMatch) {
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

/** 데이터베이스 연결을 명시적으로 닫습니다 (백업 복구용). */
export function closeDb(): void {
  flushPendingElso();
  statementCache.clear();
  if (db) {
    db.close();
    db = null;
    log('[DiaryDB] Database connection closed.');
  }
}

/** 특정 날짜의 일지가 없으면 생성합니다. */
function ensureDiaryExists(date: string): void {
  if (!db) initDb();
  if (!db) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO diaries (date) VALUES (?)');
  stmt.run(date);
}

/** 날짜별 일지 데이터를 모두 가져옵니다. (메모리 대기 중인 엘소 포인트도 디스크 I/O 없이 실시간 병합) */
export function getDiaryByDate(date: string): DiaryData {
  if (!db) initDb();
  if (!db) return { diary: null, homeworkLogs: [], activityLogs: [] };

  ensureDiaryExists(date);
  const diary = db.prepare('SELECT * FROM diaries WHERE date = ?').get(date) as DiaryEntry;
  const homeworkLogs = db.prepare('SELECT * FROM homework_logs WHERE date = ? ORDER BY completed_at ASC').all(date) as HomeworkLog[];
  let activityLogs = db.prepare('SELECT * FROM activity_logs WHERE date = ? ORDER BY time ASC').all(date) as ActivityLog[];

  // 메모리에 대기 중인 엘소 포인트가 있다면 디스크 I/O 없이 실시간 합산하여 반환 (오늘의 요약 HUD 초고속 실시간 반영)
  const pending = _pendingElsoByDate.get(date);
  if (pending && pending.totalAmount > 0) {
    let found = false;
    activityLogs = activityLogs.map(log => {
      if (log.type === 'elso') {
        found = true;
        return {
          ...log,
          time: pending.latestTime,
          amount: (log.amount || 0) + pending.totalAmount
        };
      }
      return log;
    });
    if (!found) {
      activityLogs.push({
        id: -1,
        date,
        type: 'elso',
        content: '엘소 포인트 획득',
        time: pending.latestTime,
        amount: pending.totalAmount
      });
    }
  }

  return { diary, homeworkLogs, activityLogs };
}

/** 특정 월의 달력 렌더링을 위해 요약 데이터 목록을 가져옵니다. (주변 날짜 포함) */
export function getDiariesByMonth(yearMonth: string): DiaryEntry[] {
  flushPendingElso();
  if (!db) initDb();
  if (!db) return [];

  const [y, m] = yearMonth.split('-').map(Number);
  const normalizedYearMonth = `${y}-${String(m).padStart(2, '0')}`;

  // 현재 월의 시작일과 다음 달의 시작일 기준 범위를 넓게 가져옴 (주간 합계 계산용)
  const stmt = getStmt(`
    SELECT * FROM diaries 
    WHERE date >= date(?, '-7 days') 
      AND date <= date(?, '+1 month', '+7 days') 
    ORDER BY date ASC
  `);
  return stmt.all(`${normalizedYearMonth}-01`, `${normalizedYearMonth}-01`) as DiaryEntry[];
}

/** 점수를 업데이트하고 몬스터 단계를 결정합니다. (자동 호출됨) */
function addScore(date: string, points: number): void {
  if (!db) return;
  const stmt = getStmt('UPDATE diaries SET total_score = COALESCE(total_score, 0) + ? WHERE date = ?');
  stmt.run(points, date);
}

function subtractScore(date: string, points: number): void {
  if (!db) return;
  const stmt = getStmt('UPDATE diaries SET total_score = MAX(0, COALESCE(total_score, 0) - ?) WHERE date = ?');
  stmt.run(points, date);
}

/** 특정 활동이 이미 기록되어 있는지 확인합니다. */
export function isActivityLogged(date: string, content: string): boolean {
  if (!db) initDb();
  if (!db) return false;
  const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND content = ?').get(date, content);
  return !!existing;
}

/** 날짜, 시간, 내용으로 활동 기록 존재 여부를 확인합니다. (동기화 중복 방지용) */
export function hasActivityLog(date: string, time: string, content: string): boolean {
  if (!db) initDb();
  if (!db) return false;
  const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND time = ? AND content = ?').get(date, time, content);
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

      const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND time = ? AND content = ?').get(date, time, content);
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
        const existing = getStmt('SELECT id FROM activity_logs WHERE date = ? AND content = ?').get(date, content);
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
      const existing = getStmt("SELECT date, type FROM activity_logs WHERE id = ? AND source = 'manual'")
        .get(id) as { date: string; type: string } | undefined;
      if (!existing) return;
      const result = getStmt("DELETE FROM activity_logs WHERE id = ? AND source = 'manual'").run(id);
      if (result.changes !== 1) return;
      if (existing.type === 'boss') subtractScore(existing.date, POINTS.BOSS_KILL);
      if (existing.type === 'calc') subtractScore(existing.date, POINTS.CALC_RECORD);
      removed = true;
    });
    transaction();
    if (removed) notifyUpdate();
    return removed;
  } catch (err) {
    log(`[DiaryDB] removeManualActivityLogById failed: ${err}`);
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
      const stmt = getStmt('DELETE FROM activity_logs WHERE date = ? AND type = ? AND content = ?');
      const info = stmt.run(date, type, content);

      // 삭제된 행이 있을 때만 포인트 차감
      if (info.changes > 0) {
        if (type === 'boss') subtractScore(date, POINTS.BOSS_KILL);
        if (type === 'calc') subtractScore(date, POINTS.CALC_RECORD);
        changed = true;
      }
    });
    transaction();
    if (changed) notifyUpdate();
  } catch (err) {
    log(`[DiaryDB] removeActivityLog failed: ${err}`);
  }
}

/** 숙제 완료 기록을 추가합니다. */
export function addHomeworkLog(date: string, contentId: string, contentName: string, category: string, type: 'daily' | 'weekly', completedAt: number): void {
  if (!db) initDb();
  if (!db) return;

  try {
    let added = false;
    const transaction = db.transaction(() => {
      ensureDiaryExists(date);

      // 이미 해당 숙제가 오늘/이번주 기록되어 있는지 확인
      const existing = getStmt('SELECT id FROM homework_logs WHERE date = ? AND content_id = ?').get(date, contentId) as { id: number } | undefined;
      if (existing) {
        // 1회 초기화권 이후 재완료도 같은 행의 최신 완료 시각/메타데이터로 갱신한다.
        getStmt(`
          UPDATE homework_logs
          SET content_name = ?, category = ?, type = ?, completed_at = ?
          WHERE id = ?
        `).run(contentName, category, type, completedAt, existing.id);
        return;
      }

      const stmt = getStmt('INSERT INTO homework_logs (date, content_id, content_name, category, type, completed_at) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.run(date, contentId, contentName, category, type, completedAt);

      // 포인트 부여
      if (type === 'daily') addScore(date, POINTS.DAILY_HOMEWORK);
      if (type === 'weekly') addScore(date, POINTS.WEEKLY_HOMEWORK);
      added = true;
    });
    transaction();
    if (added) notifyUpdate();
  } catch (err) {
    log(`[DiaryDB] addHomeworkLog failed: ${err}`);
  }
}

/** 숙제 체크 해제 시 기록을 삭제합니다. */
export function removeHomeworkLog(date: string, contentId: string): void {
  if (!db) initDb();
  if (!db) return;

  try {
    let removed = false;
    const transaction = db.transaction(() => {
      const existing = getStmt('SELECT type FROM homework_logs WHERE date = ? AND content_id = ?').get(date, contentId) as { type: string } | undefined;
      if (!existing) return;

      const stmt = getStmt('DELETE FROM homework_logs WHERE date = ? AND content_id = ?');
      stmt.run(date, contentId);

      // 포인트 차감
      if (existing.type === 'daily') subtractScore(date, POINTS.DAILY_HOMEWORK);
      if (existing.type === 'weekly') subtractScore(date, POINTS.WEEKLY_HOMEWORK);
      removed = true;
    });
    transaction();
    if (removed) notifyUpdate();
  } catch (err) {
    log(`[DiaryDB] removeHomeworkLog failed: ${err}`);
  }
}

/** 그 날의 전체 숙제 통계(완료/전체)를 갱신합니다. */
export function updateHomeworkStats(date: string, dailyDone: number, dailyTotal: number, weeklyDone: number, weeklyTotal: number): void {
  if (!db) initDb();
  if (!db) return;

  ensureDiaryExists(date);
  const stmt = db.prepare(`
    UPDATE diaries 
    SET daily_done = ?, daily_total = ?, weekly_done = ?, weekly_total = ? 
    WHERE date = ?
  `);
  stmt.run(dailyDone, dailyTotal, weeklyDone, weeklyTotal, date);
  notifyUpdate();
}

/** 몬스터 스티커 설정을 업데이트합니다. */
export function updateDiaryMonster(date: string, monsterId: string): void {
  if (!db) initDb();
  if (!db) return;

  ensureDiaryExists(date);
  const stmt = db.prepare('UPDATE diaries SET monster_id = ? WHERE date = ?');
  stmt.run(monsterId, date);
  notifyUpdate();
}

/** 특정 월의 요약 정보 (득템 수, 누적 시드, 상세 목록)를 가져옵니다. */
export function getMonthlySummary(yearMonth: string): { totalLoots: number, totalSeed: number, lootList: any[], seedList: any[] } {
  flushPendingElso();
  if (!db) initDb();
  if (!db) return { totalLoots: 0, totalSeed: 0, lootList: [], seedList: [] };

  const { start, end } = getMonthDateRange(yearMonth);
  const logs = getStmt("SELECT date, type, content, amount FROM activity_logs WHERE date >= ? AND date <= ? AND type IN ('loot', 'calc') ORDER BY date DESC, time DESC").all(start, end) as { date: string, type: string, content: string, amount: number }[];

  let totalLoots = 0;
  let totalSeed = 0;
  const lootList: { date: string, content: string, amount: number }[] = [];
  const seedList: { date: string, content: string }[] = [];

  logs.forEach(log => {
    if (log.type === 'loot') {
      lootList.push({ date: log.date, content: log.content, amount: log.amount || 1 });
      if (!log.content.includes('경험의 정수')) {
        totalLoots += log.amount || 1;
      }
    } else if (log.type === 'calc') {
      seedList.push({ date: log.date, content: log.content });
      totalSeed += log.amount || 0;
    }
  });

  return { totalLoots, totalSeed, lootList, seedList };
}

/** 월간 통계 데이터를 추출합니다 (인포그래픽용). */
export function getMonthlyStatistics(yearMonth: string): any {
  flushPendingElso();
  if (!db) initDb();
  if (!db) return null;

  const [year, month] = yearMonth.split('-').map(Number);
  const totalDays = new Date(year, month, 0).getDate();
  const { start, end } = getMonthDateRange(yearMonth);

  // 1. 기본 로그 가져오기 (인덱스 Range Scan 활용)
  const logs = getStmt("SELECT date, time, type, content, amount FROM activity_logs WHERE date >= ? AND date <= ?").all(start, end) as { date: string, time: string, type: string, content: string, amount: number }[];

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
      } else {
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

/**
 * 특정 월의 일별 수익 데이터를 가져옵니다 (차트용).
 */
export function getMonthlyRevenueData(yearMonth: string): { date: string, amount: number }[] {
  if (!db) initDb();
  if (!db) return [];

  const { start, end } = getMonthDateRange(yearMonth);

  // 1. DB에서 해당 월의 일별 합계 가져오기
  const rows = getStmt(`
    SELECT date, SUM(amount) as daily_sum 
    FROM activity_logs 
    WHERE date >= ? AND date <= ? AND type = 'calc'
    GROUP BY date
    ORDER BY date ASC
  `).all(start, end) as { date: string, daily_sum: number }[];

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
export function addShoutLog(sender: string, message: string, customTimestamp?: number): void {
  if (!db) initDb();
  if (!db) return;

  const now = customTimestamp || Math.floor(Date.now() / 1000); // Unix Timestamp (seconds)
  const oneDayAgo = now - (24 * 60 * 60);

  const transaction = db.transaction(() => {
    // 1. 오래된 기록 삭제 (24시간 경과)
    db!.prepare('DELETE FROM shout_history WHERE timestamp < ?').run(oneDayAgo);

    // 2. 5초 이내 동일 발신자 및 메시지 중복 체크
    const existing = db!.prepare('SELECT id FROM shout_history WHERE sender = ? AND message = ? AND ABS(timestamp - ?) <= 5').get(sender, message, now);
    if (!existing) {
      const stmt = db!.prepare('INSERT INTO shout_history (timestamp, sender, message) VALUES (?, ?, ?)');
      stmt.run(now, sender, message);
    }
  });
  transaction();
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

  const existing = db.prepare('SELECT id FROM shout_history WHERE sender = ? AND message = ? AND ABS(timestamp - ?) <= 5').get(sender, message, timestamp);
  if (existing) return false;

  const stmt = db.prepare('INSERT INTO shout_history (timestamp, sender, message) VALUES (?, ?, ?)');
  stmt.run(timestamp, sender, message);
  return true;
}

/** 기존 DB에 존재하는 5초 이내 동일 발신자/메시지 중복을 정리합니다. */
export function deduplicateShoutHistory(): void {
  if (!db) return;
  try {
    db.exec(`
      DELETE FROM shout_history 
      WHERE id NOT IN (
        SELECT MIN(id) 
        FROM shout_history 
        GROUP BY sender, message, CAST(timestamp / 5 AS INT)
      )
    `);
  } catch (err) {
    log(`[DiaryDB] Shout deduplication warning: ${err}`);
  }
}

export interface BatchSyncData {
  loots: Array<{ date: string; timeOnly: string; diaryContent: string; count: number }>;
  essences: Array<{ date: string; timeOnly: string; diaryContent: string; count: number }>;
  seeds: Array<{ date: string; timeOnly: string; content: string; amount: number }>;
  elsoPoints: Array<{ date: string; timeOnly: string; amount: number }>;
  shouts: Array<{ fullTimestamp: number; sender: string; message: string }>;
}

export interface BatchSyncResult {
  lootsAdded: number;
  essencesAdded: number;
  seedsAdded: number;
  elsoPointsAdded: number;
  shoutsAdded: number;
}

/**
 * 주간 동기화 결과물을 단 1회의 트랜잭션으로 초고속 일괄 커밋합니다. (0.01초 미만 완료, UI 멈춤 제로)
 */
export function batchInsertSyncResults(data: BatchSyncData): BatchSyncResult {
  flushPendingElso();
  if (!db) initDb();
  if (!db) return { lootsAdded: 0, essencesAdded: 0, seedsAdded: 0, elsoPointsAdded: 0, shoutsAdded: 0 };

  let lootsAdded = 0;
  let essencesAdded = 0;
  let seedsAdded = 0;
  let elsoPointsAdded = 0;
  let shoutsAdded = 0;

  const selectActivity = db.prepare('SELECT id FROM activity_logs WHERE date = ? AND time = ? AND content = ?');
  const insertActivity = db.prepare('INSERT INTO activity_logs (date, type, content, time, amount) VALUES (?, ?, ?, ?, ?)');
  const selectShout = db.prepare('SELECT id FROM shout_history WHERE sender = ? AND message = ? AND ABS(timestamp - ?) <= 5');
  const insertShout = db.prepare('INSERT INTO shout_history (timestamp, sender, message) VALUES (?, ?, ?)');
  const selectElso = db.prepare("SELECT id, amount FROM activity_logs WHERE date = ? AND type = 'elso' ORDER BY id ASC LIMIT 1");
  const updateElso = db.prepare("UPDATE activity_logs SET time = ?, amount = ? WHERE id = ?");

  const selectStone = db.prepare(`
    SELECT id, amount FROM activity_logs 
    WHERE date = ? AND type = 'loot' AND (content = ? OR content LIKE ?)
    ORDER BY id ASC LIMIT 1
  `);
  const updateStone = db.prepare('UPDATE activity_logs SET content = ?, time = ?, amount = ? WHERE id = ?');

  const runBatch = db.transaction(() => {
    // 1-1. 득템 및 마정석 기록
    const magicStonesByDate: Record<string, Record<string, { latestTime: string; totalCount: number }>> = {};
    for (const item of data.loots) {
      ensureDiaryExists(item.date);
      if (item.diaryContent.includes('마정석')) {
        const grade = item.diaryContent.includes('최상급') ? '최상급' : (item.diaryContent.includes('상급') ? '상급' : (item.diaryContent.includes('중급') ? '중급' : '하급'));
        if (!magicStonesByDate[item.date]) magicStonesByDate[item.date] = {};
        if (!magicStonesByDate[item.date][grade]) {
          magicStonesByDate[item.date][grade] = { latestTime: item.timeOnly, totalCount: 0 };
        }
        magicStonesByDate[item.date][grade].totalCount += (item.count || 1);
        magicStonesByDate[item.date][grade].latestTime = item.timeOnly;
      } else {
        const existing = selectActivity.get(item.date, item.timeOnly, item.diaryContent);
        if (!existing) {
          insertActivity.run(item.date, 'loot', item.diaryContent, item.timeOnly, item.count);
          lootsAdded++;
        }
      }
    }

    // 마정석 일자별 1줄 덮어쓰기/보정
    for (const [date, grades] of Object.entries(magicStonesByDate)) {
      for (const [grade, info] of Object.entries(grades)) {
        const standardContent = `[득템] [${grade} 마정석]`;
        const existing = selectStone.get(date, standardContent, `%${grade}%마정석%`) as { id: number; amount: number } | undefined;

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
      ensureDiaryExists(item.date);
      const existing = selectActivity.get(item.date, item.timeOnly, item.diaryContent);
      if (!existing) {
        insertActivity.run(item.date, 'loot', item.diaryContent, item.timeOnly, item.count);
        essencesAdded++;
      }
    }

    // 2. SEED 기록
    for (const item of data.seeds) {
      ensureDiaryExists(item.date);
      const existing = selectActivity.get(item.date, item.timeOnly, item.content);
      if (!existing) {
        insertActivity.run(item.date, 'calc', item.content, item.timeOnly, item.amount);
        addScore(item.date, POINTS.CALC_RECORD);
        seedsAdded++;
      }
    }

    // 3. 엘소 포인트 (일자별 총합 집계 후 멱등성 있게 반영하여 중복 누적 방지)
    const elsoByDate: Record<string, { latestTime: string; totalAmount: number }> = {};
    for (const item of data.elsoPoints) {
      if (!elsoByDate[item.date]) {
        elsoByDate[item.date] = { latestTime: item.timeOnly, totalAmount: 0 };
      }
      elsoByDate[item.date].totalAmount += item.amount;
      elsoByDate[item.date].latestTime = item.timeOnly;
    }

    for (const [date, info] of Object.entries(elsoByDate)) {
      ensureDiaryExists(date);
      const existing = selectElso.get(date) as { id: number; amount: number } | undefined;
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
      const existing = selectShout.get(item.sender, item.message, item.fullTimestamp);
      if (!existing) {
        insertShout.run(item.fullTimestamp, item.sender, item.message);
        shoutsAdded++;
      }
    }
  });

  try {
    runBatch();
  } catch (err) {
    log(`[DiaryDB] batchInsertSyncResults failed: ${err}`);
  }
  return { lootsAdded, essencesAdded, seedsAdded, elsoPointsAdded, shoutsAdded };
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

  const transaction = db.transaction(() => {
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
  });

  transaction();
  notifyUpdate();
  return alarmId;
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
): void {
  if (!db) initDb();
  if (!db) return;

  try {
    // alarmId가 실제로 존재하지 않으면 insert를 스킵하여 FOREIGN KEY constraint crash 방지
    const exists = db.prepare('SELECT id FROM word_alarm_history WHERE id = ?').get(alarmId);
    if (!exists) {
      log(`[DiaryDB] word_alarm_history에서 alarmId ${alarmId}를 찾을 수 없습니다. context line 추가를 생략합니다.`);
      return;
    }

    const stmt = db.prepare(
      'INSERT INTO word_alarm_chat_context (alarm_id, timestamp, sender, message, color) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(alarmId, Math.floor(timestamp / 1000), sender, message, color);
    notifyUpdate();
  } catch (error) {
    log(`[DiaryDB] addWordAlarmContextLine 실패 (alarmId: ${alarmId}): ${error}`);
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
export function deleteWordAlarmHistoryItem(id: number): void {
  if (!db) initDb();
  if (!db) return;

  db.prepare('DELETE FROM word_alarm_history WHERE id = ?').run(id);
  notifyUpdate();
}

/**
 * 모든 지정 단어 알림 히스토리와 관련된 맥락 데이터를 전체 삭제합니다.
 */
export function clearWordAlarmHistory(): void {
  if (!db) initDb();
  if (!db) return;

  db.prepare('DELETE FROM word_alarm_history').run();
  notifyUpdate();
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
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const transaction = db.transaction(() => {
      const delHw = db!.prepare('DELETE FROM homework_logs WHERE date < ?');
      const delAct = db!.prepare('DELETE FROM activity_logs WHERE date < ?');
      const delDiary = db!.prepare('DELETE FROM diaries WHERE date < ?');

      const infoHw = delHw.run(cutoffStr);
      const infoAct = delAct.run(cutoffStr);
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
  if (points <= 0) return;

  const current = _pendingElsoByDate.get(date) || { latestTime: time, totalAmount: 0 };
  current.totalAmount += points;
  current.latestTime = time;
  _pendingElsoByDate.set(date, current);

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

/**
 * 알람 로그 추가
 */
export function addAlarmLog(
  type: 'boss' | 'custom' | 'word' | 'wave' | 'buff' | 'etc',
  title: string,
  message: string
): void {
  if (!db) initDb();
  if (!db) return;
  try {
    const timestamp = Date.now();
    db.prepare('INSERT INTO alarm_logs (timestamp, type, title, message) VALUES (?, ?, ?, ?)').run(
      timestamp,
      type,
      title,
      message
    );
    log(`[DiaryDB] 알람 로그 추가: [${type}] ${title} - ${message}`);

    // 용량 관리를 위해 24시간 이전의 로그 자동 삭제 (24시간 = 24 * 60 * 60 * 1000 ms)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM alarm_logs WHERE timestamp < ?').run(oneDayAgo);

    notifyAlarmLogUpdate();
  } catch (e) {
    log(`[DiaryDB] addAlarmLog 실패: ${e}`);
  }
}

/**
 * 알람 로그 조회
 */
export function getAlarmLogs(limit: number = 100): AlarmLog[] {
  if (!db) initDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM alarm_logs ORDER BY timestamp DESC LIMIT ?').all(limit) as AlarmLog[];
  } catch (e) {
    log(`[DiaryDB] getAlarmLogs 실패: ${e}`);
    return [];
  }
}

/**
 * 알람 로그 전체 삭제
 */
export function clearAlarmLogs(): void {
  if (!db) initDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM alarm_logs').run();
    log('[DiaryDB] 모든 알람 로그 삭제 완료');
    notifyAlarmLogUpdate();
  } catch (e) {
    log(`[DiaryDB] clearAlarmLogs 실패: ${e}`);
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
export function addTimerRecord(record: Omit<TimerRecord, 'id'>): void {
  if (!db) initDb();
  if (!db) return;
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
  } catch (e) {
    log(`[DiaryDB] addTimerRecord failed: ${e}`);
  }
}

/**
 * 시간 측정 기록 목록 조회
 */
export function getTimerRecords(): TimerRecord[] {
  if (!db) initDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM timer_records ORDER BY date DESC').all() as TimerRecord[];
  } catch (e) {
    log(`[DiaryDB] getTimerRecords failed: ${e}`);
    return [];
  }
}

/**
 * 시간 측정 기록 제목 수정
 */
export function updateTimerRecordTitle(id: number, title: string): void {
  if (!db) initDb();
  if (!db) return;
  try {
    db.prepare('UPDATE timer_records SET title = ? WHERE id = ?').run(title, id);
    log(`[DiaryDB] Timer record title updated (id: ${id}) -> ${title}`);
    notifyTimerUpdate();
  } catch (e) {
    log(`[DiaryDB] updateTimerRecordTitle failed: ${e}`);
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
): void {
  if (!db) initDb();
  if (!db) return;
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
  } catch (e) {
    log(`[DiaryDB] updateTimerRecordSeriesAndCore failed: ${e}`);
  }
}

/**
 * 시간 측정 기록 삭제
 */
export function deleteTimerRecord(id: number): void {
  if (!db) initDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM timer_records WHERE id = ?').run(id);
    log(`[DiaryDB] Timer record deleted (id: ${id})`);
    notifyTimerUpdate();
  } catch (e) {
    log(`[DiaryDB] deleteTimerRecord failed: ${e}`);
  }
}

/**
 * 시간 측정 기록 업데이트 알림
 */
function notifyTimerUpdate(): void {
  broadcastToAllWindows('timer-updated');
}





