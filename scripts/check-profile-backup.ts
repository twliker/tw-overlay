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

function createLegacyDiary(file:string,amount:number):void {
  const db=new Database(file);
  try {
    db.exec(`CREATE TABLE diaries(date TEXT PRIMARY KEY,total_score INTEGER DEFAULT 0,monster_id TEXT DEFAULT '',daily_done INTEGER DEFAULT 0,daily_total INTEGER DEFAULT 0,weekly_done INTEGER DEFAULT 0,weekly_total INTEGER DEFAULT 0);
      CREATE TABLE activity_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,date TEXT NOT NULL REFERENCES diaries(date),type TEXT NOT NULL,content TEXT NOT NULL,time TEXT NOT NULL,amount INTEGER DEFAULT 0);
      INSERT INTO diaries(date) VALUES('2026-11-03');PRAGMA user_version=1;`);
    db.prepare("INSERT INTO activity_logs(date,type,content,time,amount) VALUES('2026-11-03','calc','구형 수익','03:00:00',?)").run(amount);
  } finally {db.close();}
}

/** 결정적으로 실패하는 v3.2.2 이전을 별도 프로세스로 반복 실행한다. 실패마다 사본을 늘리지 않고, 원본
 * diary.db와 엘소/금화 journal은 이전 전 그대로 두며(스냅샷에는 포함), 고친 뒤 이전에서 한 번 재생한다. */
function verifyRepeatedMigrationFailure(snap:any):void {
  // 재사용 판정: 같은 내용(렌더러 키 순서 무관)만 재사용하고, 원본 변경·손상 후보·다른 목적은 재사용하지 않는다.
  const unit=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-snapshot-reuse-')),source=path.join(unit,'source'),root=path.join(unit,'backups');
  fs.mkdirSync(source);fs.writeFileSync(path.join(source,'config.json'),'{"a":1}');fs.writeFileSync(path.join(source,'elso-recovery.json'),'{"journal":1}');
  const reuseOptions=(values:Record<string,string>,reason='before-profile-preparation') => ({reason,appVersion:'test',allowedDestinationRoot:root,includeRecoveryJournals:true,rendererStorage:{schemaVersion:1,values}});
  const created=path.join(root,'created');snap.createUserDataSnapshot(source,created,reuseOptions({tc_qty:'1',tc_from:'2'}));
  assert.equal(snap.findEquivalentUserDataSnapshot(source,[created],reuseOptions({tc_from:'2',tc_qty:'1'})),created);
  assert.equal(snap.findEquivalentUserDataSnapshot(source,[created],reuseOptions({tc_qty:'1'})),undefined,'도구 저장소 값이 다르면 새로 만든다');
  assert.equal(snap.findEquivalentUserDataSnapshot(source,[created],reuseOptions({tc_qty:'1',tc_from:'2'},'other')),undefined);
  fs.writeFileSync(path.join(source,'elso-recovery.json'),'{"journal":2}');
  assert.equal(snap.findEquivalentUserDataSnapshot(source,[created],reuseOptions({tc_qty:'1',tc_from:'2'})),undefined,'journal이 바뀌면 새로 만든다');
  fs.writeFileSync(path.join(source,'elso-recovery.json'),'{"journal":1}');fs.writeFileSync(path.join(created,'config.json'),'{"a":2}');
  assert.equal(snap.findEquivalentUserDataSnapshot(source,[created],reuseOptions({tc_qty:'1',tc_from:'2'})),undefined,'손상된 후보는 재사용하지 않는다');
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-migration-'));
  const defaults=built('modules/constants').DEFAULT_CONFIG;
  const legacy={...structuredClone(defaults),userServer:7,analyticsEnabled:false,
    characterPresets:[{id:'same',name:'중복 A'},{id:'same',name:'중복 B'}],selectedCharacterId:'same',
    pendingHomeworks:[{id:'legacy-pending',count:2,isIncrement:true}]};
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify(legacy));
  const diaryFile=path.join(data,'diary.db');createLegacyDiary(diaryFile,100);
  const legacyDb=new Database(diaryFile);
  legacyDb.exec(`CREATE TABLE elso_flush_operations(operation_id TEXT PRIMARY KEY,committed_at INTEGER NOT NULL);
    CREATE TABLE alarm_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,delivery_status TEXT NOT NULL DEFAULT 'fired',dedupe_key TEXT,type TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_alarm_logs_dedupe_key_unique ON alarm_logs(dedupe_key) WHERE dedupe_key IS NOT NULL;`);
  legacyDb.prepare('INSERT INTO elso_flush_operations VALUES(?,?)').run('v322-elso-already-applied',1);legacyDb.close();
  const journals={'elso-recovery.json':{schemaVersion:1,operationId:'v322-elso-already-applied',createdAt:1,entries:[{date:'2026-10-05',latestTime:'07:00:00',totalAmount:9}]},
    'gold-pouch-seed-recovery.json':{schemaVersion:1,operationId:'v322-gold-not-applied',createdAt:1,entries:[{date:'2026-10-05',latestTime:'07:01:00',totalAmount:500000}]}};
  for (const [name,value] of Object.entries(journals)) fs.writeFileSync(path.join(data,name),JSON.stringify(value));
  fs.writeFileSync(path.join(data,'app-data-migration-11111111-1111-4111-8111-111111111111.db'),'강제 종료로 남은 staging');
  const original=fs.readFileSync(diaryFile);
  const backups=(prefix:string) => fs.existsSync(path.join(data,'backups'))
    ? fs.readdirSync(path.join(data,'backups')).filter(name => name.startsWith(prefix)).map(name => path.join(data,'backups',name)) : [];
  const launch=(which:string) => {
    const child=spawnSync(process.execPath,[__filename,`--case=${which}`,`--data=${data}`],{encoding:'utf8',timeout:45000});
    assert.equal(child.status,0,child.stdout+child.stderr);
  };
  const snapshotCounts:number[]=[];
  for (let attempt=0;attempt<3;attempt++) {
    launch('migration-failure');
    assert.deepEqual(fs.readdirSync(data).filter(name => name.startsWith('app-data')),[],'실패한 시도의 staging DB와 새 DB를 남기지 않는다');
    assert.deepEqual(backups('before-play-profiles-'),[],'실패한 시도의 diary.db 백업 사본을 남기지 않는다');
    snapshotCounts.push(backups('before-profile-preparation-').length);
    assert.deepEqual(fs.readFileSync(diaryFile),original,'이전 전 journal 재생으로 원본 diary.db(v3.2.2 인덱스 포함)를 바꾸지 않는다');
    for (const [name,value] of Object.entries(journals)) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data,name),'utf8')),value,'journal은 이전 뒤 재생하도록 보존');
  }
  // 첫 실행의 설정 정규화가 config.json을 다시 쓰므로 두 번째 실행까지는 원본이 다르다. 그 뒤로는 늘지 않는다.
  assert.equal(snapshotCounts[0],1);assert.ok(snapshotCounts[1]<=2);
  assert.equal(snapshotCounts[2],snapshotCounts[1],'같은 원본으로 반복 실패하면 이전 전 스냅샷을 다시 만들지 않는다');
  const manifests=backups('before-profile-preparation-').map(snapshot => ({snapshot,manifest:snap.verifyUserDataSnapshot(snapshot)}))
    .sort((left,right) => left.manifest.createdAt.localeCompare(right.manifest.createdAt));
  const first=manifests[0];
  for (const name of ['config.json','diary.db',...Object.keys(journals)]) assert.ok(first.manifest.entries.some((entry:any) => entry.relativePath===name),`이전 전 스냅샷에 ${name} 포함`);
  assert.deepEqual(fs.readFileSync(path.join(first.snapshot,'diary.db')),original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.snapshot,'config.json'),'utf8')).characterPresets,legacy.characterPresets,'첫 스냅샷은 이전 전 설정');
  for (const [name,value] of Object.entries(journals)) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.snapshot,name),'utf8')),value);
  const beforeSuccess=snapshotCounts[2];
  // 원본을 고친 뒤 성공한 이전은 바뀐 원본의 스냅샷과 이전 백업을 하나씩 남긴다.
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({...legacy,characterPresets:[{id:'same',name:'정상 A'}]}));
  launch('migration-success');
  assert.equal(backups('before-play-profiles-').length,1,'성공한 이전의 백업은 보존');
  assert.equal(backups('before-profile-preparation-').length,beforeSuccess+1,'원본이 바뀌면 새 이전 전 스냅샷을 만든다');
  for (const snapshot of backups('before-profile-preparation-')) snap.verifyUserDataSnapshot(snapshot);
  assert.deepEqual(fs.readdirSync(data).filter(name => name.startsWith('app-data-migration-')),[]);
  assert.deepEqual(fs.readFileSync(diaryFile),original,'성공한 이전도 원본 diary.db를 바꾸지 않는다');
  assert.equal(fs.existsSync(path.join(data,'elso-recovery.json')) || fs.existsSync(path.join(data,'gold-pouch-seed-recovery.json')),false);
}

async function startupCase():Promise<void> {
  const config=built('modules/config'),diary=built('modules/diaryDb');
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline fixture');});
  const startup=built('modules/profileStartup');
  if (mode==='migration-failure' || mode==='migration-success') {
    // 실제 부팅 경로(이전 전 스냅샷→원본 닫기→이전)를 한 프로세스에 한 번씩 실행한다. 파일 검증은 부모가 한다.
    built('modules/ipcHandlers').register();
    const application=built('modules/profileApplication');
    if (mode==='migration-failure') {
      await assert.rejects(application.startProfileApplication(() => {},clock),/중복/);
      // 실패 후 앱 종료의 일지 flush도 원본 diary.db를 열지 않는다.
      assert.equal(diary.flushPendingElso(),true);assert.equal(diary.flushPendingGoldPouchSeed(),true);
      return;
    }
    const controller=await application.startProfileApplication(() => {},clock),store=controller.runtime.service.store;
    const rows=store.database.prepare("SELECT type,content,amount,profile_id FROM activity_logs WHERE date='2026-10-05' ORDER BY id").all();
    assert.deepEqual(rows,[{type:'calc',content:diary.GOLD_POUCH_DAILY_CONTENT,amount:500000,profile_id:null}],
      '이전 뒤 미반영 금화 journal을 한 번 재생하고, v3.2.2에서 이미 반영된 엘소 operation은 다시 더하지 않는다');
    assert.equal(fs.existsSync(diary.getElsoRecoveryJournalPath()) || fs.existsSync(diary.getGoldPouchRecoveryJournalPath()),false);
    const legacyPending=store.pending('legacy-unassigned');
    assert.deepEqual(legacyPending.map((row:any) => [row.occurredAt,row.payload.value.count]),[[0,2]],'시각 없는 구형 보류 숙제도 원본 그대로 보존');
    application.stopProfileApplication();controller.dispose();assert.equal(diary.closeDb(),true);return;
  }
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
  assert.equal(!!database(db => db.prepare("SELECT value FROM app_meta WHERE key='restore_generation'").get()),mode!=='converted');
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
  assert.equal(config.saveConfirmed(legacy),true);
  createLegacyDiary(path.join(fixture,'diary.db'),100);
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
  const cancelled={start:1000,end:3000};
  assert.equal(store.withRecordContext(a.id,null,()=>diary.cancelHomeworkCompletion({
    itemId:'cancelled-homework',completedAt:2000,cycleStart:cancelled.start,
  },cancelled.end)),true);
  store.saveToolValue(a.id,'buff_current_selection','["backup"]');
  const restoreState=JSON.stringify(built('modules/chatLogSyncState').createDurableFileState('fixture-log','fixture-log','2026-11-03','fixture-fingerprint','fixture-policy',64,128));
  store.database.prepare('INSERT INTO profile_log_sync_state VALUES(?,?,?)').run(a.id,'fixture-log',restoreState);
  store.database.prepare('INSERT INTO profile_log_sources VALUES(?,?)').run('fixture-log',restoreState);
  store.database.prepare('INSERT INTO profile_log_source_ranges VALUES(?,?,?,?)').run('fixture-fingerprint',0,128,a.id);
  store.database.prepare('INSERT INTO profile_log_legacy_aggregates VALUES(?,?,?)').run('fixture-fingerprint',a.id,JSON.stringify({stones:{},elso:0,gold:500000}));
  store.database.prepare('INSERT INTO diary_chat_activity_events(event_id,date,activity_id) VALUES(?,?,?)').run('old-link','2026-11-01',1);
  store.database.prepare('INSERT INTO diary_live_activity_events(line_key,date,profile_id,signature,activity_id) VALUES(?,?,?,?,?)')
    .run('old-line','2026-11-01',a.id,'old-signature',1);
  const ignoredDigest='ab'.repeat(32);
  built('modules/profileLogSource').excludeIgnoredProfileLog(store.database,'2026-11-01',
    {lineKey:ignoredDigest,fingerprint:'explicitly-ignored',start:4,end:15});
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
    const logPath=path.join(otherPC,'logs','TWChatLog_2026_11_03.html');
    const portableResult=await built('modules/profileBackupRestore').prepareProfileBackupRestore(extracted,otherPC,conversion,
      snap.verifyUserDataSnapshot(extracted,{enforceRestoreAllowlist:true}),{id:1,filePath:logPath,resumeOffset:4,
        encoding:'utf8',boundary:{offset:4,identity:'fixture-log-id',bytes:Buffer.from('test')}});
    const portableConfig=JSON.parse(fs.readFileSync(path.join(portableResult.root,'config.json'),'utf8'));
    assert.notEqual(portableConfig.profileDeviceId,deviceId,'다른 PC에서 복원해도 원본 PC의 기기 ID를 재사용하지 않는다');
    assert.equal(portableConfig.profileSelectionRequired,true);
    assert.equal(fs.existsSync(path.join(portableResult.root,'device-state.json')),false);
    const portableDb=new Database(path.join(portableResult.root,'app-data.db'),{readonly:true});
    try {
      const handoff=JSON.parse(portableDb.prepare("SELECT value FROM app_meta WHERE key GLOB 'live-chat-handoff:*'").get().value);
      assert.equal(handoff.filePath,logPath);
      assert.equal(handoff.localDeviceId,portableConfig.profileDeviceId);
      assert.equal(handoff.boundary.offset,4);
      assert.equal(handoff.boundary.bytes,Buffer.from('test').toString('hex'));
      assert.equal(portableDb.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(a.id,'buff_current_selection').value,'["backup"]');
      assert.equal(portableDb.prepare('SELECT state_json FROM profile_log_sync_state WHERE profile_id=? AND file_key=?').get(a.id,'fixture-log').state_json,restoreState);
      assert.equal(portableDb.prepare('SELECT state_json FROM profile_log_sources WHERE file_key=?').get('fixture-log').state_json,restoreState);
      assert.equal(portableDb.prepare('SELECT profile_id FROM profile_log_source_ranges WHERE fingerprint=?').get('fixture-fingerprint').profile_id,a.id);
      assert.equal(JSON.parse(portableDb.prepare('SELECT value FROM profile_log_legacy_aggregates WHERE fingerprint=?').get('fixture-fingerprint').value).gold,500000);
      assert.equal(portableDb.prepare('SELECT activity_id FROM diary_chat_activity_events WHERE event_id=?').get('old-link').activity_id,1);
      assert.equal(portableDb.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get().value,store.database.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get().value);
    }
    finally {portableDb.close();}
    const c=store.create('나중에 추가',16);
    store.saveToolValue(c.id,'buff_current_selection','["new-profile"]');
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
    const oldFile=path.join(fixture,'old-v1.db');
    createLegacyDiary(oldFile,77);
    const oldZipPath=path.join(fixture,'old-v1.zip'),oldZip=new Zip();oldZip.addFile('diary.db',fs.readFileSync(oldFile));oldZip.writeZip(oldZipPath);chosen=oldZipPath;
    inspection=() => {
      const converted=spawnSync(process.execPath,[__filename,'--case=converted',`--data=${fixture}`],{encoding:'utf8',timeout:30000});
      assert.equal(converted.status,0,converted.stdout+converted.stderr);
    };
    assert.equal(await backup.importBackup({}),false);baseline();
    // 구형 설정만 복원: 일지 귀속·현재 수익 유지, 기존 매핑 재사용, 추가 프로필과 도구 프리셋 보존.
    const legacyConfigZip=path.join(fixture,'legacy-config.zip');
    const settingsZip=new Zip();settingsZip.addFile('config.json',Buffer.from(JSON.stringify(legacy)));settingsZip.writeZip(legacyConfigZip);chosen=legacyConfigZip;
    inspection=() => database(db => {
      assert.equal(db.prepare('SELECT SUM(amount) n FROM activity_logs').get().n,1000);
      assert.equal(db.prepare('SELECT deleted_at FROM play_profiles WHERE id=?').get(c.id).deleted_at,null);
      assert.equal(db.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(c.id,'buff_current_selection').value,'["new-profile"]');
      assert.equal(db.prepare('SELECT id FROM play_profiles WHERE name=? AND deleted_at IS NULL').get('사냥용').id,a.id);
      assert.equal(JSON.parse(db.prepare('SELECT value FROM profile_settings WHERE profile_id=? AND key=?').get(a.id,'pinnedNoteText').value),'백업 설정');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM pending_profile_events').get().n,1,'기존 이전 대기를 같은 구형 백업으로 중복 생성하지 않는다');
      assert.equal(db.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(a.id,'buff_current_selection').value,'["current"]');
    });
    assert.equal(await backup.importBackup({}),false);baseline();
    // 구형 일지만 복원: 프로필 세 개/현재 설정 유지, 복원 일지는 미배정이다.
    const legacyDiaryZip=path.join(fixture,'legacy-diary.zip'),diaryZip=new Zip();
    diaryZip.addFile('diary.db',sourceDiary);diaryZip.writeZip(legacyDiaryZip);chosen=legacyDiaryZip;
    let diaryInspected=false;
    inspection=() => database(db => {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM play_profiles WHERE deleted_at IS NULL').get().n,3);
      assert.equal(db.prepare('SELECT SUM(amount) n FROM activity_logs').get().n,100);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_logs WHERE profile_id IS NOT NULL').get().n,0);
      assert.equal(JSON.parse(db.prepare('SELECT value FROM profile_settings WHERE profile_id=? AND key=?').get(a.id,'pinnedNoteText').value),'현재 설정');
      for (const table of ['profile_log_sync_state','profile_log_sources','profile_log_source_ranges','profile_log_legacy_aggregates']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
      assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get().value).files,{});
      assert.equal(db.prepare('SELECT date FROM activity_logs WHERE id=1').get().date,'2026-11-03','다른 날짜에서 숫자 ID를 다시 사용한 구형 행');
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('diary_chat_activity_events','diary_live_activity_events')").get().n,0);
      assert.equal(db.prepare('SELECT log_date FROM profile_log_line_owners WHERE line_key=?').get(Buffer.from(ignoredDigest,'hex')).log_date,'2026-11-01');
      assert.equal(db.prepare('SELECT end_offset FROM profile_ignored_log_ranges WHERE fingerprint=?').get('explicitly-ignored').end_offset,15);
      assert.deepEqual(db.prepare("SELECT cycle_start AS start,cancelled_at AS end FROM diary_homework_completions WHERE profile_id=? AND item_id='cancelled-homework'").get(a.id),cancelled);
      diaryInspected=true;
    });
    assert.equal(await backup.importBackup({}),false);assert.equal(diaryInspected,true);baseline();
    const brokenDiaryPath=path.join(fixture,'broken-diary.db');
    const brokenDiary=new Database(brokenDiaryPath);
    brokenDiary.exec("CREATE TABLE diaries(date TEXT PRIMARY KEY); INSERT INTO diaries VALUES('2026-11-03');");
    brokenDiary.close();
    const brokenZip=new Zip();
    brokenZip.addFile('diary.db',fs.readFileSync(brokenDiaryPath));
    chosen=path.join(fixture,'broken-diary.zip');brokenZip.writeZip(chosen);
    let brokenAccepted=false;
    inspection=()=>{brokenAccepted=true;};
    assert.equal(await backup.importBackup({}),false);
    assert.equal(brokenAccepted,false,'부팅에 필요한 일지 컬럼이 빠진 백업을 파일 교체 전에 거부');
    baseline();
    // 구형 도구 저장소만 있는 ZIP도 새 프로필 DB에 변환한다. 원래 일지/설정은 보존한다.
    const toolsZipPath=path.join(fixture,'legacy-tools.zip'),toolsZip=new Zip();
    const toolSource=path.join(fixture,'tool-source'),toolSnapshot=path.join(fixture,'tool-snapshot');fs.mkdirSync(toolSource);
    const diaryAndDisplay=path.join(fixture,'diary-and-display');
    fs.writeFileSync(path.join(toolSource,'diary.db'),sourceDiary);
    snap.createUserDataSnapshot(toolSource,diaryAndDisplay,{reason:'legacy-diary-and-display',allowedDestinationRoot:fixture,
      rendererStorage:{schemaVersion:1,values:{'hps-overlay-scale':'1'}}});
    const displayZip=new Zip();displayZip.addLocalFolder(diaryAndDisplay);
    chosen=path.join(fixture,'diary-and-display.zip');displayZip.writeZip(chosen);
    let displayInspected=false;
    inspection=()=>database(db=>{
      displayInspected=true;
      assert.equal(db.prepare('SELECT value FROM profile_tools WHERE profile_id=? AND key=?').get(a.id,'buff_current_selection')?.value,'["current"]');
    });
    assert.equal(await backup.importBackup({}),false);assert.equal(displayInspected,true);baseline();
    fs.unlinkSync(path.join(toolSource,'diary.db'));
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
    verifyRepeatedMigrationFailure(snap);
  } finally {
    dialog.showOpenDialog=original.open;dialog.showSaveDialog=original.save;dialog.showMessageBox=original.message;app.relaunch=original.relaunch;app.exit=original.exit;
  }
  console.log('Profile backup/startup: full ZIP, legacy partial conversion, rollback, blocked stale writes, interrupted recovery and fail-closed startup passed.');
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
