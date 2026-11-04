/** 제품 설정/preload/IPC/프로필 기록과 SQLite를 함께 검증한다. 사용자 폴더/Google 계정은 사용하지 않는다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {app,BrowserWindow} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-sync-ui-'));
app.setPath('userData',fixture);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name));
const pause=(ms=30)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean> | boolean):Promise<void>{for(let n=0;n<250;n++){if(await check())return;await pause();}throw new Error('profile sync UI timed out');}
async function main():Promise<void> {
  await app.whenReady();const config=built('modules/config'),defaults=built('modules/constants').DEFAULT_CONFIG;
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,analyticsEnabled:false,autoLaunch:false,
    characterPresets:[{id:'A',name:'사냥용 <A>'},{id:'B',name:'숙제용 B'}],selectedCharacterId:'A',pinnedNoteText:'A 저장',
    googleSyncEnabled:true,googleSyncAutoSync:false,googleSyncUserEmail:'test@example.invalid',
    contentsCheckerEnabled:false,showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false}),true);
  const auth=built('modules/googleAuth');let linked=true;
  auth.isLoggedIn=()=>linked;auth.loadStoredProfile=()=>({email:'test@example.invalid'});auth.logout=()=>{linked=false;};
  const appProfile=built('modules/profileApplication'),clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline fixture');});
  const controller=await appProfile.startProfileApplication(()=>{},clock),{service,replay}=controller.runtime,store=service.store;
  service.beginSession('profile-sync-ui');const a=store.list().find((p:any)=>p.name==='사냥용 <A>'),b=store.list().find((p:any)=>p.name==='숙제용 B');assert.equal((await service.select(a.id,replay)).success,true);
  built('modules/ipcHandlers').register();
  const cloud=built('modules/profileCloudSync').getProfileCloudSync(),sync=cloud.coordinator;
  const remoteDir=path.join(fixture,'remote');fs.mkdirSync(remoteDir);
  const remote=await built('modules/applicationData').ApplicationData.initialize({directory:remoteDir,deviceId:'PC-Remote',defaults,
    clock:()=>({utcMs:Date.now(),source:'unverified',uncertaintyMs:null})},{...structuredClone(defaults),characterPresets:[]},{value:undefined});
  const {ProfileSyncModel,localSyncProfileId}=built('modules/profileSyncModel'),model=new ProfileSyncModel(remote.database,'PC-Remote',()=>({utcMs:Date.now(),source:'unverified',uncertaintyMs:null}));
  const baseline=sync.model.envelope();model.prepareRemoteImport([baseline]);model.merge(baseline);model.apply();
  const rid=JSON.parse(Object.keys(baseline.cells).find(k=>JSON.parse(k)[0]==='profile' && JSON.parse(k)[1]!==b.id)!)[1];
  const remoteA=localSyncProfileId(remote.database,rid);model.rebaseOwn(true);
  let fileVersion=1,envelope=model.envelope(),uploads=0,ownEnvelope:any;
  sync.transport={cancel(){},async allocate(){return 'own-file';},async scan(){return {files:[{id:'remote-file',name:'remote',version:String(fileVersion),md5Checksum:String(fileVersion),appProperties:{twProfileSync:'1',device:envelope.device}},
      ...(ownEnvelope ? [{id:'own-file',name:'own',version:String(uploads),md5Checksum:String(uploads),appProperties:{twProfileSync:'1',device:ownEnvelope.device}}] : [])],removed:[],cursor:String(fileVersion),full:true};},
    async download(file:any){return structuredClone(file.id==='own-file' ? ownEnvelope : envelope);},async upload(_id:string,data:any){uploads++;ownEnvelope=structuredClone(data);}};
  const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  const js=(code:string)=>win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(root,'dist/settings.html'));win.webContents.send('config-data',config.load());
    await until(()=>js("Boolean(_initReady && window.settingsProfileTransition?.status().ready && document.getElementById('profile-sync-state'))"));
    if(process.argv.includes('--capture-docs')) {
      const status=cloud.status();status.isLinked=false;delete status.email;delete status.lastSyncedAt;
      status.profileSync={...status.profileSync,connection:'disconnected',pending:0,reviews:[],backupAvailable:false};
      await js(`window.settingsProfileCloudPause.render(${JSON.stringify(status)});clearSettingsSearch();openSettingsSubTabDirectly('system',1)`);win.setSize(800,600);await pause(300);
      await js("document.getElementById('google-sync-card').scrollIntoView()");await pause(80);
      const output=path.join(root,'output/profile-sync-ui');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'login-800.png'),(await win.webContents.capturePage()).toPNG());
      win.setSize(1100,850);await js(`window.settingsProfileCloudPause.render(${JSON.stringify(cloud.status())})`);
    }
    await sync.sync(true);await until(()=>js("!document.getElementById('profile-sync-choice').hidden"));
    assert.equal(uploads,0);assert.equal(await js("document.querySelectorAll('#profile-sync-choice li').length"),2);
    assert.match(await js("document.getElementById('profile-sync-choice').textContent"),/사냥용 <A>/);
    assert.equal(await js("document.querySelector('#profile-sync-choice A')"),null,'프로필명은 HTML로 해석하지 않음');
    await js("document.getElementById('pinned-note-text').value='가져오기 전 초안';document.getElementById('pinned-note-text').dispatchEvent(new Event('input',{bubbles:true}))");
    const blockedImport=await cloud.choose('remote');assert.equal(blockedImport.success,false);assert.match(blockedImport.error,/작성 중인 내용을 먼저/);assert.equal(store.list().length,2);assert.equal(await js('document.body.inert'),false);assert.equal(await js("document.getElementById('pinned-note-text').value"),'가져오기 전 초안');
    await js("document.getElementById('pinned-note-text').value='A 저장';document.getElementById('pinned-note-text').dispatchEvent(new Event('input',{bubbles:true}))");
    if(process.argv.includes('--remote-import')) {assert.equal((await js("electronAPI.googleSyncConnectChoice('remote')")).success,true);assert.equal(service.status().selectionRequired,true);assert.equal((await service.select(a.id,replay)).success,true);}
    else await js("Array.from(document.querySelectorAll('#profile-sync-choice button')).find(b=>b.textContent.includes('양쪽 병합')).click()");
    await until(()=>sync.details().connection==='ready');await until(()=>js("document.getElementById('profile-sync-choice').hidden"));
    assert.equal(store.list().length,2);assert.equal(service.status().activeProfileId,a.id);assert.equal(service.status().selectionRequired,false);
    assert.equal(sync.details().backupAvailable,true);const zip=sync.model.meta('backupPath','');assert.equal(fs.existsSync(zip),true);assert.ok(zip.endsWith('.zip'));
    const AdmZip=require('adm-zip'),backup=new AdmZip(zip);assert.ok(backup.getEntry('app-data.db'));assert.ok(!backup.getEntry('device-state.json'));
    // 같은 소유자의 수신은 편집 중인 초안과 검색/스크롤/포커스를 유지한다.
    await js("document.getElementById('pinned-note-text').value='입력 중 메모';document.getElementById('pinned-note-text').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('settings-quick-search').value='경험치'");
    const cfg=remote.project(remoteA,defaults);cfg.pinnedNoteText='다른 PC 메모';cfg.buffTimerWarnSeconds=[25];remote.saveProjection(remoteA,cfg);envelope=model.envelope();fileVersion++;
    await pause(2100);await sync.sync(true);
    assert.equal(store.setting(a.id,'pinnedNoteText'),'다른 PC 메모');assert.equal(await js("document.getElementById('pinned-note-text').value"),'입력 중 메모');
    assert.equal(await js("document.getElementById('settings-quick-search').value"),'경험치');assert.equal((await js('window.settingsProfileTransition.status()')).dirty,true);
    const cursorBefore=sync.model.meta('cursor',''),oldWarning=store.setting(a.id,'buffTimerWarnSeconds');const failConfig=remote.project(remoteA,defaults);failConfig.buffTimerWarnSeconds=[31];remote.saveProjection(remoteA,failConfig);envelope=model.envelope();fileVersion++;
    store.database.exec("CREATE TRIGGER reject_external_commit BEFORE INSERT ON app_meta WHEN NEW.key='device_config_commit' BEGIN SELECT RAISE(ABORT,'external commit failure');END");
    await pause(2100);await assert.rejects(sync.sync(true),/external commit failure/);assert.deepEqual(store.setting(a.id,'buffTimerWarnSeconds'),oldWarning);assert.equal(sync.model.meta('cursor',''),cursorBefore,'DB/기기 선택/cursor의 외부 commit 실패는 함께 rollback');
    // 첫 재시도 지연은 2초에 최대20% 지터가 붙는다. 실시간 UI 검사는 그 상한 뒤 재시도한다.
    store.database.exec('DROP TRIGGER reject_external_commit');await pause(2600);await sync.sync(true);assert.deepEqual(store.setting(a.id,'buffTimerWarnSeconds'),[31]);
    // 저장을 확정한 뒤 두 PC가 같은 필드 수정: 화면에서 후보를 선택하고 한 번만 반영.
    assert.equal(await js('saveSettings(true)'),true);assert.equal(config.flushPending(),true);const local=store.project(a.id,config.load());local.pinnedNoteText='이 PC 충돌';store.saveProjection(a.id,local);config.refreshFromPersistence();
    const next=remote.project(remoteA,defaults);next.pinnedNoteText='저쪽 PC 충돌';remote.saveProjection(remoteA,next);envelope=model.envelope();fileVersion++;
    await pause(2100);await sync.sync(true);await until(()=>js("document.querySelectorAll('[data-sync-review-key]').length>0"));
    const conflict=sync.details().reviews.find((r:any)=>r.label.includes('메모'));assert.ok(conflict);assert.equal(conflict.reason,'conflict');
    await js(`Array.from(document.querySelectorAll('[data-sync-review-key]')).find(n=>n.dataset.syncReviewKey===${JSON.stringify(conflict.key)}).querySelector('button').click()`);
    await until(()=>!sync.details().reviews.some((r:any)=>r.key===conflict.key));assert.equal(store.setting(a.id,'pinnedNoteText'),'이 PC 충돌');
    // 전송하지 않는 기록/기기 설정: 대기를 비운 뒤 직접 원본을 기록해도 새 예약 없음.
    sync.model.acknowledge(sync.model.envelope().sequence);const before=sync.model.envelope().sequence;
    const diary=built('modules/diaryDb');store.withRecordContext(a.id,service.status().sessionId,()=>diary.addActivityLog('2026-11-04','12:00:00','manual','로컬 SEED',-37));
    assert.equal(config.saveConfirmed({chatLogPath:path.join(fixture,'private-logs'),masterMute:true}),true);
    assert.equal(sync.model.envelope().sequence,before);assert.equal(sync.model.pending(),0,'일지/로그 경로/음소거는 전송 예약 없음');
    remote.update(remoteA,'다른 이름',16);envelope=model.envelope();fileVersion++;await pause(2100);await sync.sync(true);
    assert.equal(store.list().find((p:any)=>p.id===a.id).name,'사냥용 <A>');assert.equal(config.load().userServer,7);
    assert.ok(sync.details().reviews.some((r:any)=>r.reason==='playing-profile'));
    const review=sync.details().reviews.find((r:any)=>r.key.endsWith(',"userServer"]'));
    await js(`Array.from(document.querySelectorAll('[data-sync-review-key]')).find(n=>n.dataset.syncReviewKey===${JSON.stringify(review.key)}).querySelectorAll('button')[1].click()`);
    await until(()=>service.status().selectionRequired);assert.equal(config.load().userServer,16);
    const pending=store.pending().length;service.dispatch({kind:'legacy-homework',value:{id:store.homework(a.id)[0].id,count:1,isIncrement:true,timestamp:Date.now()}},()=>{throw new Error('선택 전 적용하면 안 됨');},Date.now(),'sync-pending');assert.equal(store.pending().length,pending+1);
    // 외부 페이지에서 새 쓰기 IPC는 거부된다.
    const other=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true}});
    try {await other.loadFile(path.join(root,'dist/profiles.html'));await assert.rejects(other.webContents.executeJavaScript("window.electronAPI.googleSyncConnectChoice('local')"),/환경설정/);} finally {other.destroy();}
    // 실제 카드만 추출해 800x600에서 긴 후보/이름의 가로 넘침을 확인한다.
    win.setSize(800,600);await js("clearSettingsSearch();openSettingsSubTabDirectly('system',1)");await pause(300);
    await js("document.getElementById('google-sync-card').scrollIntoView()");await pause(80);
    assert.equal(await js("(() => {const r=document.getElementById('google-sync-card').getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth && getComputedStyle(document.getElementById('google-sync-card').closest('.settings-section')).display!=='none';})()"),true,'실제 800px 설정 화면에서 카드가 표시되고 가로 넘침 없음');
    const output=path.join(root,'output/profile-sync-ui');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'settings-800.png'),(await win.webContents.capturePage()).toPNG());
    win.destroy();await pause(60);config.flushPending();
    // 다른 프로필로 이동해도 원래 프로필의 진행 중 측정은 원격 삭제에서 보호한다.
    const stopwatch=built('modules/profileStopwatch');assert.equal((await service.select(b.id,replay)).success,true);
    await stopwatch.controlProfileStopwatch('start',b.id);assert.equal((await service.select(a.id,replay)).success,true);
    const remoteB=localSyncProfileId(remote.database,b.id);assert.ok(remoteB);remote.remove(remoteB);envelope=model.envelope();fileVersion++;await pause(2100);await sync.sync(true);
    assert.ok(store.list().some((p:any)=>p.id===b.id),'비활성 프로필의 실행 중 측정 소유자도 보존');
    const deletion=sync.details().reviews.find((r:any)=>r.key===JSON.stringify(['profile',b.id,'deleted']));assert.ok(deletion);
    await assert.rejects(sync.resolve(deletion.key,deletion.candidates[0].id),/측정|저장/);
    assert.equal((await service.select(b.id,replay)).success,true);await stopwatch.controlProfileStopwatch('stop',b.id);assert.equal((await service.select(a.id,replay)).success,true);
    await sync.resolve(deletion.key,deletion.candidates[0].id);assert.equal(store.list().some((p:any)=>p.id===b.id),false);
    assert.equal(service.status().selectionRequired,false,'다른 프로필 삭제 수락은 현재 선택을 해제하지 않음');
    const checklist=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true}});
    try {
      await checklist.loadFile(path.join(root,'dist/contents-checker.html'));
      const result=await checklist.webContents.executeJavaScript(`electronAPI.mutateProfileChecklist(${JSON.stringify({profileId:a.id,requestId:'stale-cloud-edit',createdAt:Date.now(),kind:'updateItem',args:['already-deleted','입력 유지','일일',{type:'daily',hour:6},1]})})`);
      assert.equal(result.success,false);assert.match(result.error,/삭제되었습니다.*입력은 유지/);
      assert.equal(store.hasEvent('stale-cloud-edit'),false,'실패한 오래된 편집은 성공 ACK로 남기지 않음');
    } finally {checklist.destroy();}
    console.log('PASS profile sync UI: product settings/preload/IPC/SQLite, initial merge/ZIP, draft preservation, conflict choice, local diary/privacy, active server review/pending gate, sender validation; screenshot output/profile-sync-ui/settings-800.png');
  } finally {if(!win.isDestroyed())win.destroy();await pause(50);config.flushPending();remote.close();appProfile.stopProfileApplication();controller.dispose();config.flushPending();config.beginExternalRestore();built('modules/diaryDb').closeDb();}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
