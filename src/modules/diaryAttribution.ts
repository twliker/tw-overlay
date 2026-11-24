import type Database = require('better-sqlite3');
import type { DiaryRecordContext } from '../shared/diaryProfiles';

/** 동일 연결의 기본 기록 귀속. 기존 행을 현재 프로필로 추정하지 않는다.
 * 복구/이전처럼 null 귀속을 명시해야 하는 INSERT는 record_uuid도 함께 전달해 기본 trigger를 건너뛴다.
 * TEMP trigger만 사용하므로 다른 연결/백업 도구에 앱 전용 SQL 함수를 요구하지 않는다.
 */
export function ensureDiaryAttribution(db:Database.Database,context:() => DiaryRecordContext):void {
  db.function('app_record_profile',() => context().profileId);
  db.function('app_record_session',() => context().sessionId);
  db.function('app_record_device',() => context().deviceId);
  db.transaction(() => {
    for (const table of ['activity_logs','homework_logs','alarm_logs','timer_records']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns=db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
      for (const column of ['profile_id','record_uuid','record_device_id','record_session_id']) {
        if (!columns.some(item => item.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
      db.exec(`UPDATE ${table} SET record_uuid=lower(hex(randomblob(16))) WHERE record_uuid IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_record_uuid ON ${table}(record_uuid);
        CREATE INDEX IF NOT EXISTS idx_${table}_profile ON ${table}(profile_id);
        CREATE TEMP TRIGGER IF NOT EXISTS attribute_${table} AFTER INSERT ON main.${table}
        WHEN NEW.record_uuid IS NULL BEGIN
          UPDATE ${table} SET record_uuid=lower(hex(randomblob(16))),
            profile_id=COALESCE(NEW.profile_id,app_record_profile()),
            record_device_id=COALESCE(NEW.record_device_id,app_record_device()),
            record_session_id=COALESCE(NEW.record_session_id,app_record_session()) WHERE rowid=NEW.rowid;
        END;`);
    }
  })();
}
