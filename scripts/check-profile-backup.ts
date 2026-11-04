/** 공유 DB의 실제 부팅 준비·ZIP 백업·구형 부분 복원·실패 rollback·재시작 검사. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawnSync} from 'node:child_process';
import {app,dialog} from 'electron';
const root=path.resolve(__dirname,'..');
const mode=process.argv.find(value => value.startsWith('--case='))?.slice(7);
const supplied=process.argv.find(value => value.startsWith('--data='))?.slice(7);
const fixture=supplied || fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-backup-'));
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const Database=require('better-sqlite3');
const Zip=require('adm-zip');
const read=(name:string) => JSON.parse(fs.readFileSync(path.join(fixture,name),'utf8'));
const database=<T>(fn:(db:any) => T):T => {const db=new Database(path.join(fixture,'app-data.db'),{readonly:true,fileMustExist:true});try {return fn(db);} finally {db.close();}};

async function startupCase():Promise<void> {
  const config=built('modules/config'),diary=built('modules/diaryDb');
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline fixture');});
  const startup=built('modules/profileStartup');
  if (mode==='fresh') {
    const prepared=await startup.initializePlayProfileStorage(clock);
    assert.equal(prepared.store.list().length,1);assert.equal(prepared.store.list()[0].name,'');
    assert.equal(prepared.store.list()[0].userServer,null);assert.equal(config.load().profileSelectionRequired,true);
    assert.equal(fs.existsSync(path.join(fixture,'diary.db')),false);
    prepared.stopClock();assert.equal(diary.closeDb(),true);return;
  }
  if (mode==='broken') {
    const before=fs.readFileSync(path.join(fixture,'app-data.db'));
    await assert.rejects(startup.initializePlayProfileStorage(clock),/프로필 저장소 준비/);
    assert.deepEqual(fs.readFileSync(path.join(fixture,'app-data.db')),before);
    assert.equal(fs.existsSync(path.join(fixture,'diary.db')),false,'실패 뒤 빈 diary.db를 새로 만들지 않는다');return;
  }
  assert.equal(built('modules/backupManager').recoverInterruptedRestore(),true);
  if (mode==='journal') assert.equal(config.load().opacity,0.99,'복구 전 값이 캐시에 있어도 복구 후 디스크를 다시 읽는다');
  const prepared=await startup.initializePlayProfileStorage(clock);
  assert.equal(config.load().profileSelectionRequired,true);
  assert.equal(prepared.store.getRecordContext().profileId,null);
  assert.equal(prepared.store.list().length,mode==='converted' ? 3 : 2);
  assert.equal(diary.getDiaryByDate('2026-11-03').activityLogs.reduce((n:number,row:any) => n+(row.amount || 0),0),mode==='converted' ? 77 : 100);
  assert.equal(read('device-state.json').deviceId,read('config.json').profileDeviceId);
  assert.ok(database(db => db.prepare("SELECT value FROM app_meta WHERE key='restore_generation'").get()));
  if (mode==='journal') {assert.equal(config.load().opacity,0.45);assert.equal(fs.existsSync(path.join(fixture,'app-data-config-write.json')),false);}
  prepared.stopClock();assert.equal(diary.closeDb(),true);
}

async function main():Promise<void> {
  await app.whenReady();if (mode) {await startupCase();return;}
  const config=built('modules/config'),diary=built('modules/diaryDb'),backup=built('modules/backupManager');
  const defaults=built('modules/constants').DEFAULT_CONFIG;
  const legacy={...structuredClone(defaults),userServer:7,pinnedNoteText:'백업 설정',opacity:0.8,
    characterPresets:[{id:'A',name:'사냥용'},{id:'B',name:'거래용'}],selectedCharacterId:'A',
    pendingHomeworks:[{id:'legacy-pending',count:1,isIncrement:true,timestamp:1}]};
  assert.equal(config.saveConfirmed(legacy),true);diary.initDb();diary.addManualActivityLog('2026-11-03','01:00:00','calc','기존 수익',100);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline fixture');});
  const startup=built('modules/profileStartup');
  const first=startup.initializePlayProfileStorage(clock);
  assert.equal(startup.initializePlayProfileStorage(clock),first,'반복 시작은 같은 준비 작업을 공유한다');
  const prepared=await first,store=prepared.store;
  assert.equal(store.list().length,2);assert.equal(config.load().profileSelectionRequired,true);
  assert.equal(config.load().pinnedNoteText,'백업 설정');assert.equal(store.pending().length,1);
  assert.match(built('modules/cloudSyncManager').getSyncStatus().pausedReason,/일시 중지/);
  const sourceDiary=fs.readFileSync(path.join(fixture,'diary.db'));
  const a=store.list().find((profile:any) => profile.name==='사냥용');
  store.saveToolValue(a.id,'buff_current_selection','["backup"]');
  const restoreState=JSON.stringify(built('modules/chatLogSyncState').createDurableFileState('fixture-log','fixture-log','2026-11-03','fixture-fingerprint','fixture-policy',64,128));
  store.database.prepare('INSERT INTO profile_log_sync_state VALUES(?,?,?)').run(a.id,'fixture-log',restoreState);
  store.database.prepare('INSERT INTO profile_log_sources VALUES(?,?)').run('fixture-log',restoreState);
  store.database.prepare('INSERT INTO profile_log_source_ranges VALUES(?,?,?,?)').run('fixture-fingerprint',0,128,a.id);
  store.database.prepare('INSERT INTO profile_log_legacy_aggregates VALUES(?,?,?)').run('fixture-fingerprint',a.id,JSON.stringify({stones:{},elso:0,gold:500000}));
  const zipFile=path.join(fixture,'profiles.zip');let chosen=zipFile;
  const original={open:dialog.showOpenDialog,save:dialog.showSaveDialog,message:dialog.showMessageBox,relaunch:app.relaunch,exit:app.exit};
  try {
    (dialog as any).showSaveDialog=async () => ({canceled:false,filePath:zipFile});
    (dialog as any).showOpenDialog=async () => ({canceled:false,filePaths:[chosen]});
    assert.equal(await backup.exportBackup({}),true);
    const exported=new Zip(zipFile),names=exported.getEntries().map((entry:any) => entry.entryName);
    assert.ok(names.includes('app-data.db'));assert.ok(names.includes('config.json'));
    assert.equal(names.includes('diary.db'),false,'옛 원본을 새 백업의 일지로 혼동하지 않는다');
    assert.equal(names.includes('device-state.json'),false,'기기 ID는 휴대용 백업에서 제외');
    const deviceId=read('device-state.json').deviceId;
    const portable=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-portable-'));
    const extracted=path.join(portable,'extracted');exported.extractAllTo(extracted,false);
    const otherPC=path.join(portable,'other-pc'),conversion=path.join(portable,'conversion');fs.mkdirSync(conversion);
    const snap=built('modules/localSnapshot');
    const portableResult=await built('modules/profileBackupRestore').prepareProfileBackupRestore(extracted,otherPC,conversion,snap.verifyUserDataSnapshot(extracted,{enforceRestoreAllowlist:true}));
    const portableConfig=JSON.parse(fs.readFileSync(path.join(portableResult.root,'config.json'),'utf8'));
    assert.notEqual(portableConfig.profileDeviceId,deviceId,'다른 PC에서 복원해도 원본 PC의 기기 ID를 재사용하지 않는다');
    assert.equal(portableConfig.profileSelectionRequired,true);
    assert.equal(fs.existsSync(path.join(portableResult.root,'device-state.json')),false);
    const portableDb=new Database(path.join(portableResult.root,'app-data.db'),{readonly:true});
    try {
      assert.equal(portableDb.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(a.id,'buff_current_selection').value,'["backup"]');
      assert.equal(portableDb.prepare('SELECT state_json FROM profile_log_sync_state WHERE profile_id=? AND file_key=?').get(a.id,'fixture-log').state_json,restoreState);
      assert.equal(portableDb.prepare('SELECT state_json FROM profile_log_sources WHERE file_key=?').get('fixture-log').state_json,restoreState);
      assert.equal(portableDb.prepare('SELECT profile_id FROM profile_log_source_ranges WHERE fingerprint=?').get('fixture-fingerprint').profile_id,a.id);
      assert.equal(JSON.parse(portableDb.prepare('SELECT value FROM profile_log_legacy_aggregates WHERE fingerprint=?').get('fixture-fingerprint').value).gold,500000);
      assert.equal(portableDb.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get().value,store.database.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get().value);
    }
    finally {portableDb.close();}
    const c=store.create('나중에 추가',16);
    store.withRecordContext(c.id,null,() => diary.addManualActivityLog('2026-11-03','02:00:00','calc','현재 수익',900));
    assert.equal(config.saveConfirmed({pinnedNoteText:'현재 설정'}),true);
    store.saveToolValue(a.id,'buff_current_selection','["current"]');
    const currentCount=store.list().length;
    const baseline=() => {
      assert.equal(config.load().pinnedNoteText,'현재 설정');assert.equal(store.list().length,currentCount);
      assert.equal(diary.getMonthlySummary('2026-11').totalSeed,1000);
      assert.equal(config.saveConfirmed({opacity:0.8}),true,'실패 뒤 설정 쓰기 재개');
      assert.equal(read('device-state.json').deviceId,deviceId);
      assert.equal(store.toolValues(a.id).buff_current_selection,'["current"]');
      assert.equal(store.database.prepare('SELECT state_json FROM profile_log_sources WHERE file_key=?').get('fixture-log').state_json,restoreState);
    };
    let inspection:() => void=() => {};
    (dialog as any).showMessageBox=async () => {inspection();throw new Error('fixture failure after replacement');};
    // 새 DB 전체 복원에 실패하면 원래 DB를 먼저 열고 설정 projection을 복구한다.
    inspection=() => database(db => assert.equal(db.prepare('SELECT COUNT(*) n FROM play_profiles WHERE deleted_at IS NULL').get().n,2));
    assert.equal(await backup.importBackup({}),false);baseline();
    // 실제 구형 schema(귀속 컬럼/프로필 일 집계 없음)도 재시작 후 조회 가능해야 한다.
    const oldFile=path.join(fixture,'old-v1.db'),oldDb=new Database(oldFile);
    oldDb.exec(`CREATE TABLE diaries(date TEXT PRIMARY KEY,total_score INTEGER DEFAULT 0,monster_id TEXT DEFAULT '',daily_done INTEGER DEFAULT 0,daily_total INTEGER DEFAULT 0,weekly_done INTEGER DEFAULT 0,weekly_total INTEGER DEFAULT 0);
      CREATE TABLE activity_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,date TEXT NOT NULL REFERENCES diaries(date),type TEXT NOT NULL,content TEXT NOT NULL,time TEXT NOT NULL,amount INTEGER DEFAULT 0);
      INSERT INTO diaries(date) VALUES('2026-11-03');INSERT INTO activity_logs(date,type,content,time,amount) VALUES('2026-11-03','calc','구형 수익','03:00:00',77);PRAGMA user_version=1;`);oldDb.close();
    const oldZipPath=path.join(fixture,'old-v1.zip'),oldZip=new Zip();oldZip.addFile('diary.db',fs.readFileSync(oldFile));oldZip.writeZip(oldZipPath);chosen=oldZipPath;
    inspection=() => {
      const converted=spawnSync(process.execPath,[__filename,'--case=converted',`--data=${fixture}`],{encoding:'utf8',timeout:30000});
      assert.equal(converted.status,0,converted.stdout+converted.stderr);
    };
    assert.equal(await backup.importBackup({}),false);baseline();
    // 구형 설정만 복원: 일지 귀속·현재 수익 유지, 기존 매핑 재사용, 추가 프로필은 삭제 표식.
    const legacyConfigZip=path.join(fixture,'legacy-config.zip');
    const settingsZip=new Zip();settingsZip.addFile('config.json',Buffer.from(JSON.stringify(legacy)));settingsZip.writeZip(legacyConfigZip);chosen=legacyConfigZip;
    inspection=() => database(db => {
      assert.equal(db.prepare('SELECT SUM(amount) n FROM activity_logs').get().n,1000);
      assert.equal(db.prepare('SELECT deleted_at FROM play_profiles WHERE id=?').get(c.id).deleted_at!==null,true);
      assert.equal(db.prepare('SELECT id FROM play_profiles WHERE name=? AND deleted_at IS NULL').get('사냥용').id,a.id);
      assert.equal(JSON.parse(db.prepare('SELECT value FROM profile_settings WHERE profile_id=? AND key=?').get(a.id,'pinnedNoteText').value),'백업 설정');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM pending_profile_events').get().n,1,'기존 이전 대기를 같은 구형 백업으로 중복 생성하지 않는다');
      assert.equal(db.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(a.id,'buff_current_selection').value,'["current"]');
    });
    assert.equal(await backup.importBackup({}),false);baseline();
    // 구형 일지만 복원: 프로필 세 개/현재 설정 유지, 복원 일지는 미배정이다.
    const legacyDiaryZip=path.join(fixture,'legacy-diary.zip'),diaryZip=new Zip();
    diaryZip.addFile('diary.db',sourceDiary);diaryZip.writeZip(legacyDiaryZip);chosen=legacyDiaryZip;
    inspection=() => database(db => {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM play_profiles WHERE deleted_at IS NULL').get().n,3);
      assert.equal(db.prepare('SELECT SUM(amount) n FROM activity_logs').get().n,100);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_logs WHERE profile_id IS NOT NULL').get().n,0);
      assert.equal(JSON.parse(db.prepare('SELECT value FROM profile_settings WHERE profile_id=? AND key=?').get(a.id,'pinnedNoteText').value),'현재 설정');
      for (const table of ['profile_log_sync_state','profile_log_sources','profile_log_source_ranges','profile_log_legacy_aggregates']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
      assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get().value).files,{});
    });
    assert.equal(await backup.importBackup({}),false);baseline();
    // 구형 도구 저장소만 있는 ZIP도 새 프로필 DB에 변환한다. 원래 일지/설정은 보존한다.
    const toolsZipPath=path.join(fixture,'legacy-tools.zip'),toolsZip=new Zip();
    const toolSource=path.join(fixture,'tool-source'),toolSnapshot=path.join(fixture,'tool-snapshot');fs.mkdirSync(toolSource);
    snap.createUserDataSnapshot(toolSource,toolSnapshot,{reason:'legacy-tools',allowedDestinationRoot:fixture,rendererStorage:{schemaVersion:1,values:{buff_current_selection:'["restored"]'}}});
    toolsZip.addLocalFolder(toolSnapshot);toolsZip.writeZip(toolsZipPath);chosen=toolsZipPath;
    let toolsInspected=false;
    inspection=() => database(db => {
      toolsInspected=true;
      assert.equal(db.prepare('SELECT SUM(amount) n FROM activity_logs').get().n,1000);
      const rows=db.prepare('SELECT value FROM profile_tools WHERE key=?').all('buff_current_selection');
      assert.equal(rows.length,3);assert.ok(rows.every((row:any) => row.value==='["restored"]'));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM profile_tools WHERE key!=?').get('buff_current_selection').n,0);
    });
    assert.equal(await backup.importBackup({}),false);assert.equal(toolsInspected,true,'실제 파일 교체 후 검사 지점까지 도달해야 한다');baseline();
    const incomplete=path.join(fixture,'incomplete.zip'),invalid=new Zip();invalid.addFile('app-data.db',exported.readFile('app-data.db'));
    const originalManifest=JSON.parse(exported.readAsText('snapshot.manifest.json'));
    invalid.addFile('snapshot.manifest.json',Buffer.from(JSON.stringify({...originalManifest,entries:originalManifest.entries.filter((entry:any) => entry.relativePath==='app-data.db')})));
    invalid.writeZip(incomplete);chosen=incomplete;
    let shown=false;(dialog as any).showMessageBox=async () => {shown=true;return {response:0};};
    assert.equal(await backup.importBackup({}),false);assert.equal(shown,false);baseline();
    const deviceOnly=path.join(fixture,'device-only.zip'),missingDB=new Zip();missingDB.addFile('config.json',exported.readFile('config.json'));
    missingDB.addFile('snapshot.manifest.json',Buffer.from(JSON.stringify({...originalManifest,entries:originalManifest.entries.filter((entry:any) => entry.relativePath==='config.json')})));
    missingDB.writeZip(deviceOnly);chosen=deviceOnly;
    assert.equal(await backup.importBackup({}),false);assert.equal(shown,false);baseline();
    // 성공 안내 이후 재시작까지 구형 메모리 설정/DB가 다시 쓰이지 않는다.
    chosen=zipFile;(dialog as any).showMessageBox=async () => {
      assert.equal(config.saveConfirmed({pinnedNoteText:'늦은 쓰기'}),false);
      assert.throws(() => diary.getStmt('SELECT 1').get());
      assert.equal(store.database.open,false);return {response:0};
    };
    let restarted=0;(app as any).relaunch=() => {restarted++;};(app as any).exit=() => {};
    assert.equal(await backup.importBackup({}),true);assert.equal(restarted,1);
    assert.equal(read('config.json').profileDeviceId,deviceId);
    assert.deepEqual(fs.readFileSync(path.join(fixture,'diary.db')),sourceDiary,'옛 원본은 변경하지 않는다');
    prepared.stopClock();
    // 파일 교체 도중 종료를 흉내 낸 뒤 새 프로세스에서 journal 복구→부팅 준비를 실행한다.
    const rollback=path.join(fixture,'backups','interrupted-fixture');
    const manifest=snap.createUserDataSnapshot(fixture,rollback,{reason:'fixture-rollback',appVersion:'test'});
    fs.writeFileSync(path.join(fixture,'backups','restore-journal.json'),JSON.stringify({formatVersion:1,createdAt:new Date().toISOString(),rollbackPath:rollback,restorePaths:manifest.entries.map((entry:any) => entry.relativePath)}));
    fs.writeFileSync(path.join(fixture,'app-data.db'),'interrupted replacement');
    const child=spawnSync(process.execPath,[__filename,'--case=restart',`--data=${fixture}`],{encoding:'utf8',timeout:30000});
    assert.equal(child.status,0,child.stdout+child.stderr);
    assert.equal(fs.existsSync(path.join(fixture,'backups','restore-journal.json')),false);
    const restoredConfig=read('config.json');
    fs.writeFileSync(path.join(fixture,'app-data-config-write.json'),JSON.stringify({version:1,commitId:'uncommitted-fixture',before:JSON.stringify({...restoredConfig,opacity:0.45})}));
    fs.writeFileSync(path.join(fixture,'config.json'),JSON.stringify({...restoredConfig,opacity:0.99}));
    const recovered=spawnSync(process.execPath,[__filename,'--case=journal',`--data=${fixture}`],{encoding:'utf8',timeout:30000});
    assert.equal(recovered.status,0,recovered.stdout+recovered.stderr);
    const fresh=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-fresh-'));
    const installed=spawnSync(process.execPath,[__filename,'--case=fresh',`--data=${fresh}`],{encoding:'utf8',timeout:30000});
    assert.equal(installed.status,0,installed.stdout+installed.stderr);
    const broken=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-broken-'));fs.writeFileSync(path.join(broken,'app-data.db'),'corrupt profile database');
    const failed=spawnSync(process.execPath,[__filename,'--case=broken',`--data=${broken}`],{encoding:'utf8',timeout:30000});
    assert.equal(failed.status,0,failed.stdout+failed.stderr);
  } finally {
    dialog.showOpenDialog=original.open;dialog.showSaveDialog=original.save;dialog.showMessageBox=original.message;app.relaunch=original.relaunch;app.exit=original.exit;
  }
  console.log('Profile backup/startup: full ZIP, legacy partial conversion, rollback, blocked stale writes, interrupted recovery and fail-closed startup passed.');
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
