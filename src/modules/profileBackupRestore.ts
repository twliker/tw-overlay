import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import Database = require('better-sqlite3');
import {ApplicationData} from './applicationData';
import {readBackupConfiguration} from './config';
import {DEFAULT_CONFIG} from './constants';
import {deviceConfigOnly} from '../shared/playProfiles';
import {createUserDataSnapshot,type SnapshotManifest} from './localSnapshot';
import {RENDERER_STORAGE_FILE} from '../shared/rendererStorage';
import {PROFILE_TOOL_KEYS} from '../shared/profileTools';
import {normalizeChatLogSyncState} from './chatLogSyncState';

const DIARY_TABLES=new Set(['diaries','homework_logs','activity_logs','shout_history','word_alarm_history',
  'word_alarm_chat_context','hunting_grounds','hunting_paths','alarm_logs','timer_records','elso_flush_operations',
  'gold_pouch_flush_operations','chat_sync_committed_events','diary_profile_meta','diary_profile_days']);
const quote=(name:string) => `"${name.replace(/"/g,'""')}"`;
const exists=(root:string,name:string) => fs.existsSync(path.join(root,name));

/** 기기 ID는 휴대용 백업에 포함하지 않는다. config의 옛 복사본으로 ID를 되돌리지 않는다. */
export function getPlayProfileDeviceId(directory:string,previous?:unknown):string {
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'device-state.json');
  if (fs.existsSync(file)) {
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if (value.version!==1 || typeof value.deviceId!=='string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(value.deviceId)) throw new Error('기기 식별 정보를 읽지 못했습니다.');
    return value.deviceId;
  }
  const deviceId=typeof previous==='string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(previous) ? previous : randomUUID();
  const temporary=`${file}.${randomUUID()}.tmp`;
  const fd=fs.openSync(temporary,'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify({version:1,deviceId}),'utf8');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(temporary,file);return deviceId;
}

function validateSqlite(db:Database.Database):void {
  if (db.pragma('quick_check',{simple:true})!=='ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('백업 데이터베이스의 무결성을 확인하지 못했습니다.');
}

/** 구형 일지 선택 복원은 프로필/숙제 원본을 유지하고 일지 영역만 교체한다.
 * 연결이 닫힌 복사본에서 처리하며 실제 userData에는 검증한 결과만 게시한다. */
function restoreLegacyDiary(target:Database.Database,file:string):void {
  const source=new Database(file,{readonly:true,fileMustExist:true});
  try {
    validateSqlite(source);
    const version=Number(source.pragma('user_version',{simple:true}));
    if (version>9) throw new Error('지원하지 않는 일지 백업 버전입니다.');
    const tables=source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string;sql:string}[];
    if (!tables.some(table => table.name==='diaries') || tables.some(table => !DIARY_TABLES.has(table.name))) throw new Error('지원하지 않는 구형 일지 구조입니다.');
    for (const table of tables) {
      const columns=source.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as {name:string}[];
      if (columns.some(column => column.name==='profile_id') && source.prepare(`SELECT 1 FROM ${quote(table.name)} WHERE profile_id IS NOT NULL LIMIT 1`).get()) throw new Error('프로필 정보가 포함된 백업 전체를 선택해 주세요.');
    }
    const indexes=source.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as {tbl_name:string;sql:string}[];
    target.pragma('foreign_keys=OFF');
    target.prepare('ATTACH DATABASE ? AS restored_diary').run(file);
    try {
      target.transaction(() => {
        const current=target.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
        for (const table of current) if (DIARY_TABLES.has(table.name)) target.exec(`DROP TABLE ${quote(table.name)}`);
        for (const table of tables) {
          target.exec(table.sql);
          target.exec(`INSERT INTO main.${quote(table.name)} SELECT * FROM restored_diary.${quote(table.name)}`);
        }
        for (const index of indexes) if (DIARY_TABLES.has(index.tbl_name)) target.exec(index.sql);
        // 일지 원본이 바뀌면 과거 DB의 완료 위치/원본 귀속 증거를 재사용하지 않는다.
        // 설정만 복원하거나 새 DB 전체를 복원할 때는 이 진행 정보도 그대로 보존한다.
        for (const table of ['profile_log_sync_state','profile_log_sources','profile_log_source_ranges','profile_log_legacy_aggregates']) target.exec(`DELETE FROM ${table}`);
        target.prepare("UPDATE app_meta SET value=? WHERE key='legacy_chat_log_sync_state'").run(JSON.stringify(normalizeChatLogSyncState(null)));
        target.pragma(`user_version=${version}`);
      })();
    } finally {target.exec('DETACH DATABASE restored_diary');target.pragma('foreign_keys=ON');}
    validateSqlite(target);
  } finally {source.close();}
}

export interface PreparedProfileRestore {root:string;manifest:SnapshotManifest;removePaths:string[]}

/** 기능 계약 — 프로필 백업은 DB+기기 설정을 함께 검증한다. 실제 파일 교체 전 staging에서
 * 구형 설정/일지를 변환한다. 설정만 복원하면 현재 일지를, 일지만 복원하면 현재 프로필을 유지한다.
 * 이전/삭제 프로필의 귀속은 보존한다. 새 복원 세대·현 기기 ID를 사용하고 옛 ACK는 신뢰하지 않는다.
 * 호출 전 config/일지 쓰기를 잠그고 공유 DB 연결을 닫아야 한다. 회귀: check-profile-backup.ts.
 */
export async function prepareProfileBackupRestore(sourceRoot:string,currentRoot:string,workingRoot:string,
  manifest:SnapshotManifest):Promise<PreparedProfileRestore | null> {
  const names=new Set(manifest.entries.map(entry => entry.relativePath));
  const rendererValues=names.has(RENDERER_STORAGE_FILE) ? JSON.parse(fs.readFileSync(path.join(sourceRoot,RENDERER_STORAGE_FILE),'utf8')).values as Record<string,string> : null;
  const hasLegacyTools=!!rendererValues && PROFILE_TOOL_KEYS.some(key => rendererValues[key]!==undefined);
  const incoming=names.has('app-data.db'),current=exists(currentRoot,'app-data.db');
  if (!incoming && ['app-data.db-wal','app-data.db-shm','app-data-config-write.json'].some(name => names.has(name))) throw new Error('프로필 백업의 데이터베이스가 빠져 있습니다.');
  if (!names.has('diary.db') && ['diary.db-wal','diary.db-shm'].some(name => names.has(name))) throw new Error('일지 백업의 데이터베이스가 빠져 있습니다.');
  if (!incoming && names.has('config.json')) {
    const value=JSON.parse(fs.readFileSync(path.join(sourceRoot,'config.json'),'utf8'));
    if (value.activePlayProfileId && !Array.isArray(value.characterPresets)) throw new Error('프로필 백업의 데이터베이스가 빠져 있습니다. 백업 전체를 선택해 주세요.');
  }
  if (!incoming && !current) return null;
  if (incoming && !names.has('config.json')) throw new Error('프로필 백업의 설정 파일이 빠져 있습니다. 백업 전체를 선택해 주세요.');
  if (!incoming && !names.has('config.json') && !names.has('diary.db') && !hasLegacyTools) return null;
  const rawCurrent=exists(currentRoot,'config.json') ? JSON.parse(fs.readFileSync(path.join(currentRoot,'config.json'),'utf8')) : {};
  const deviceId=getPlayProfileDeviceId(currentRoot,rawCurrent.profileDeviceId);
  const work=path.join(workingRoot,'profile-conversion');fs.mkdirSync(work);
  for (const entry of manifest.entries) {
    const destination=path.join(work,entry.relativePath);fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(path.join(sourceRoot,entry.relativePath),destination);
  }
  if (!incoming) {
    for (const name of ['app-data.db','app-data.db-wal','app-data.db-shm','app-data-config-write.json']) {
      if (exists(currentRoot,name)) fs.copyFileSync(path.join(currentRoot,name),path.join(work,name));
    }
    if (!names.has('config.json')) fs.writeFileSync(path.join(work,'config.json'),JSON.stringify(rawCurrent));
  }
  const configFile=path.join(work,'config.json');
  const raw=JSON.parse(fs.readFileSync(configFile,'utf8'));
  const legacy=readBackupConfiguration(raw);
  const store=await ApplicationData.initialize({directory:work,deviceId,defaults:DEFAULT_CONFIG},legacy);
  try {
    validateSqlite(store.database);
    if (!store.list().length) throw new Error('백업에 기본 프로필이 없습니다.');
    for (const profile of store.list()) store.project(profile.id,legacy);
    // 중단된 JSON+DB commit은 initialize가 복구했으므로 복구 후 JSON을 사용한다.
    let device=JSON.parse(fs.readFileSync(configFile,'utf8'));
    if (!incoming && names.has('config.json')) device={...deviceConfigOnly(legacy),activePlayProfileId:store.restoreLegacyConfiguration(legacy,raw.userServer)};
    if (!incoming && names.has('diary.db')) restoreLegacyDiary(store.database,path.join(work,'diary.db'));
    if (!incoming && rendererValues) store.migrateToolValues(rendererValues,true);
    store.ensureDiaryAttribution();
    store.database.prepare("INSERT INTO app_meta(key,value) VALUES('restore_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(randomUUID());
    device={...deviceConfigOnly(device),profileDeviceId:deviceId,profileSelectionRequired:true};
    delete device.profileSessionId;
    fs.writeFileSync(configFile,JSON.stringify(device));
    validateSqlite(store.database);store.database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {store.close();}
  const root=path.join(workingRoot,'profile-ready');
  const renderer=exists(work,RENDERER_STORAGE_FILE) ? JSON.parse(fs.readFileSync(path.join(work,RENDERER_STORAGE_FILE),'utf8')) : undefined;
  const result=createUserDataSnapshot(work,root,{reason:'profile-restore',appVersion:manifest.appVersion,allowedDestinationRoot:workingRoot,rendererStorage:renderer});
  return {root,manifest:result,removePaths:['app-data.db-wal','app-data.db-shm','app-data-config-write.json']};
}
