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
    googleSyncEnabled:false,googleSyncAutoSync:false,
    contentsCheckerEnabled:false,showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false}),true);
  const auth=built('modules/googleAuth');let linked=false;
  const account={email:'test@example.invalid'};
  auth.isLoggedIn=()=>linked;auth.loadStoredProfile=()=>linked ? account : null;auth.logout=()=>{linked=false;};
  let browserLogins=0;
  auth.startLogin=async()=>{browserLogins++;linked=true;return {success:true,profile:account};};
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
  // v3.2.2에서 이전한 프로필의 동기화 ID는 캐릭터 ID에서 정해지므로 로컬 ID와 다르다. 매핑으로 찾는다.
  const remoteIdOf=(local:string):string=>store.database.prepare('SELECT remote_id FROM profile_sync_ids WHERE local_id=?').get(local).remote_id;
  const rid=remoteIdOf(a.id);
  const remoteA=localSyncProfileId(remote.database,rid);model.rebaseOwn(true);
  const remoteImport=process.argv.includes('--remote-import');
  let remoteAvailable=!remoteImport;
  let fileVersion=1,envelope=model.envelope(),uploads=0,ownEnvelope:any;
  let delayedScan:Promise<void> | undefined;
  sync.transport={cancel(){},async allocate(){return 'own-file';},async scan(){if (delayedScan) await delayedScan;return {files:[...(remoteAvailable ? [{id:'remote-file',name:'remote',version:String(fileVersion),md5Checksum:String(fileVersion),appProperties:{twProfileSync:'1',device:envelope.device}}] : []),
      ...(ownEnvelope ? [{id:'own-file',name:'own',version:String(uploads),md5Checksum:String(uploads),appProperties:{twProfileSync:'1',device:ownEnvelope.device}}] : [])],removed:[],cursor:String(fileVersion),full:true};},
    async download(file:any){return structuredClone(file.id==='own-file' ? ownEnvelope : envelope);},async upload(_id:string,data:any){uploads++;ownEnvelope=structuredClone(data);}};
  const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  const js=(code:string)=>win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(root,'dist/settings.html'));win.webContents.send('config-data',config.load());
    await until(()=>js("Boolean(_initReady && window.settingsProfileTransition?.status().ready && document.getElementById('profile-sync-state'))"));
    await js("openSettingsPage('google-sync')");
    assert.ok(await js(`(() => {
      const steps = document.getElementById('profile-sync-steps');
      const description = steps.previousElementSibling.getBoundingClientRect();
      return steps.firstElementChild.getBoundingClientRect().top - description.bottom >= 12;
    })()`), 'Google 동기화 안내와 단계 배지 사이에 여백이 있어야 합니다.');
    if(process.argv.includes('--capture-docs')) {
      const status=cloud.status();status.isLinked=false;delete status.email;delete status.lastSyncedAt;
      status.profileSync={...status.profileSync,connection:'disconnected',pending:0,reviews:[],backupAvailable:false};
      await js(`window.settingsProfileCloudPause.render(${JSON.stringify(status)});clearSettingsSearch();openSettingsPage('google-sync')`);win.setSize(800,600);await pause(300);
      await js("document.getElementById('google-sync-card').scrollIntoView()");await pause(80);
      const output=path.join(root,'output/profile-sync-ui');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'login-800.png'),(await win.webContents.capturePage()).toPNG());
      win.setSize(1100,850);await js(`window.settingsProfileCloudPause.render(${JSON.stringify(cloud.status())})`);
    }
    {
      // 형식 검증으로 이 PC에만 보관한 설정은 설정 카드에 계속 안내한다(수동 동기화 메시지에만 의존하지 않음).
      const status=cloud.status();
      status.isLinked=true;status.email='fixture@example.test';
      status.profileSync={...status.profileSync,connection:'ready',pending:0,reviews:[],
        uploadSizing:{fullBytes:1024,uploadBytes:1024,deferredTools:0,heldCells:1,heldLabels:['사용자 알림']}};
      await js(`window.settingsProfileCloudPause.render(${JSON.stringify(status)})`);
      assert.match(await js("document.getElementById('profile-sync-capacity').hidden ? '' : document.getElementById('profile-sync-capacity').textContent"),
        /형식을 확인할 수 없는 설정 1개는 이 PC에만 보관[\s\S]*사용자 알림/,'보류한 설정 안내가 설정 카드에 표시되어야 합니다.');
      assert.match(await js("document.getElementById('profile-sync-state').textContent"),/형식을 확인할 수 없는 설정 1개/);
      await js(`window.settingsProfileCloudPause.render(${JSON.stringify(cloud.status())})`);
    }
    const login=async()=>{
      const loginButton="Array.from(document.querySelectorAll('#profile-sync-actions button')).find(b=>['Google 계정으로 연결','다시 로그인'].includes(b.textContent))";
      await until(()=>js(`${loginButton}?.disabled===false`));
      await js(`${loginButton}.click()`);
    };
    if(remoteImport) {
      let releaseScan!:()=>void;
      delayedScan=new Promise(resolve=>{releaseScan=resolve;});
      await login();
      const cancelCheck="Array.from(document.querySelectorAll('#profile-sync-actions button')).find(b=>b.textContent==='연결 해제')";
      await until(()=>js(`${cancelCheck}?.disabled===false`));
      await js(`${cancelCheck}.click()`);await until(()=>!linked);
      delayedScan=undefined;releaseScan();
      await until(()=>!sync.syncing);
      assert.equal(sync.details().connection,'disconnected');
      assert.equal(uploads,0,'연결 해제 후 도착한 응답을 적용하지 않는다.');
      await login();
      await until(()=>js("document.getElementById('profile-sync-apply-choice')?.disabled===false"));
      assert.match(await js("document.getElementById('profile-sync-choice').textContent"),/Google에 가져올 프로필이 없습니다/);
      assert.equal(await js("document.querySelector('#profile-sync-choice input')"),null);
      const firstSignOut="Array.from(document.querySelectorAll('#profile-sync-actions button')).find(b=>b.textContent==='연결 해제')";
      await js(`${firstSignOut}.click()`);await until(()=>!linked);
      assert.equal(uploads,0);
      await login();await until(()=>js("document.getElementById('profile-sync-apply-choice')?.disabled===false"));
      await js("Array.from(document.querySelectorAll('#profile-sync-choice button')).find(b=>b.textContent==='나중에 설정').click()");
      await until(()=>js("document.getElementById('profile-sync-choice').hidden && document.querySelector('#profile-sync-actions button')?.disabled===false"));
      assert.equal(sync.details().connection,'disconnected');
      assert.equal(linked,true);
      // 나중에 설정은 로그인을 유지한다. 다시 켤 때 브라우저 로그인 없이 첫 연결 선택으로 돌아간다.
      const actionButton=(label:string)=>`Array.from(document.querySelectorAll('#profile-sync-actions button')).find(b=>b.textContent===${JSON.stringify(label)})`;
      assert.equal(await js(`Boolean(${actionButton('동기화 다시 켜기')})`),true,'로그인 유지 중에는 동기화 다시 켜기를 제공');
      assert.equal(await js(`Boolean(${actionButton('Google 계정으로 연결')})`),false,'다시 켜기에 브라우저 로그인을 요구하지 않음');
      const loginsBeforeResume=browserLogins;
      await js(`${actionButton('동기화 다시 켜기')}.click()`);
      await until(()=>js("document.getElementById('profile-sync-apply-choice')?.disabled===false"));
      assert.equal(browserLogins,loginsBeforeResume,'다시 켜기는 OAuth를 다시 실행하지 않음');
      assert.equal(sync.details().connection,'choice');assert.equal(config.load().googleSyncEnabled,true);
      assert.equal(uploads,0,'다시 켜도 데이터 선택 전에는 전송하지 않음');
      await js("Array.from(document.querySelectorAll('#profile-sync-choice button')).find(b=>b.textContent==='나중에 설정').click()");
      await until(()=>js("document.getElementById('profile-sync-choice').hidden && document.querySelector('#profile-sync-actions button')?.disabled===false"));
      assert.equal(sync.details().connection,'disconnected');
      const signOut="Array.from(document.querySelectorAll('#profile-sync-actions button')).find(b=>b.textContent==='연결 해제')";
      assert.equal(await js(`Boolean(${signOut})`),true);
      await js(`${signOut}.click()`);await until(()=>!linked);
      assert.equal(uploads,0);
      remoteAvailable=true;
    }
    await login();
    await until(()=>js("!document.getElementById('profile-sync-choice').hidden && !document.querySelector('#profile-sync-choice fieldset')?.disabled && !!document.getElementById('profile-sync-apply-choice')"));
    assert.equal(await js("document.getElementById('profile-sync-state').textContent"),'Google 로그인 완료 · 동기화 설정이 필요합니다');
    assert.equal(await js("Array.from(document.querySelectorAll('#profile-sync-actions button')).some(b=>b.textContent==='연결 해제' && !b.disabled)"),true);
    assert.match(await js("document.querySelector('#profile-sync-steps [aria-current=step]').textContent"),/동기화 설정/);
    assert.equal(await js("document.getElementById('profile-sync-apply-choice').disabled"),true);
    assert.equal(uploads,0);assert.equal(await js("document.querySelectorAll('#profile-sync-choice li').length"),2);
    assert.match(await js("document.getElementById('profile-sync-choice').textContent"),/사냥용 <A>/);
    assert.equal(await js("document.querySelector('#profile-sync-choice A')"),null,'프로필명은 HTML로 해석하지 않음');
    const normalChoice=cloud.status();
    const blockedChoice={...normalChoice,profileSync:{...normalChoice.profileSync,remoteIdentityConflicts:1,damagedFiles:1}};
    await js(`window.settingsProfileCloudSync.render(${JSON.stringify(blockedChoice)})`);
    assert.equal(await js("document.querySelector('#profile-sync-choice input[value=remote]')"),null);
    assert.match(await js("document.getElementById('profile-sync-choice').textContent"),/이름 또는 서버를 확인할 Google 프로필 1개/);
    assert.match(await js("document.getElementById('profile-sync-choice').textContent"),/읽을 수 없는 Google 파일 1개/);
    assert.equal(await js("document.getElementById('profile-sync-apply-choice').disabled"),true);
    await js("document.querySelector('#profile-sync-choice input[value=merge]').click()");
    assert.equal(await js("document.getElementById('profile-sync-apply-choice').disabled"),false);
    await js(`window.settingsProfileCloudSync.render(${JSON.stringify(normalChoice)})`);
    if(process.argv.includes('--capture-docs')) {
      win.setSize(1100,720);await js("clearSettingsSearch();openSettingsPage('google-sync')");await pause(300);
      await js("document.getElementById('google-sync-card').scrollIntoView()");await pause(80);
      fs.writeFileSync(path.join(root,'output/profile-sync-ui/first-setup-1100.png'),(await win.webContents.capturePage()).toPNG());
      win.setSize(1100,850);
    }
    await js("window.addEventListener('settings-profile-changed',()=>{window.fixtureConfigRefreshed=true},{once:true})");
    win.webContents.send('config-data',config.load());
    await until(()=>js('window.fixtureConfigRefreshed===true'));
    await js("window.confirm=()=>{window.profileSyncExtraConfirm=true;return false};document.querySelector('#profile-sync-choice input[value=remote]').click()");
    assert.equal(await js('window.settingsProfileTransition.status().dirty'),false,'설정 갱신 뒤 가져오기 방식 선택은 환경설정 초안에 포함하지 않는다');
    assert.equal(await js("document.getElementById('profile-sync-apply-choice').disabled"),false);
    assert.equal(store.list().length,2);
    assert.equal(sync.details().connection,'choice','방법 선택만으로는 가져오거나 설정을 완료하지 않음');
    const originalReminder = await js("document.getElementById('game-exit-reminder-message').value");
    await js("document.getElementById('game-exit-reminder-message').value='가져오기 전 초안';document.getElementById('game-exit-reminder-message').dispatchEvent(new Event('input',{bubbles:true}))");
    await js("document.getElementById('profile-sync-apply-choice').click()");
    await until(()=>js("document.getElementById('profile-sync-feedback').textContent.includes('작성 중인 내용을 먼저')"));
    assert.equal(store.list().length,2);assert.equal(await js('document.body.inert'),false);assert.equal(await js("document.getElementById('game-exit-reminder-message').value"),'가져오기 전 초안');
    assert.equal(await js("document.querySelector('#profile-sync-choice input[value=remote]').checked"),true);
    await js(`document.getElementById('game-exit-reminder-message').value=${JSON.stringify(originalReminder)};document.getElementById('game-exit-reminder-message').dispatchEvent(new Event('input',{bubbles:true}))`);
    if(remoteImport) {
      const transition=built('modules/profileSettingsTransition');
      const run=transition.runProfileWindowScript;
      const execute=win.webContents.executeJavaScript.bind(win.webContents);
      let delayedScript:string | undefined;
      let held=false;
      transition.runProfileWindowScript=(target:BrowserWindow,code:string)=>run(target,code,45);
      win.webContents.executeJavaScript=(code:string,userGesture?:boolean)=>{
        if (!held && code.includes('window.__twGoogleImportLock=') && code.includes('?.lock()')) {
          held=true;delayedScript=code;
          return new Promise(()=>{});
        }
        return execute(code,userGesture);
      };
      try {
        await js("document.getElementById('profile-sync-apply-choice').click()");
        await until(()=>js("document.getElementById('profile-sync-feedback').textContent.includes('응답을 확인하지 못했습니다')"));
        assert.equal(sync.syncing,false);
        assert.equal(await js('document.body.inert'),false);
        assert.ok(delayedScript);
        const elapsedScript=delayedScript.replace(/Date\.now\(\)>=[0-9]+/,'true');
        await execute(elapsedScript);
        assert.equal(await js('document.body.inert'),false,'기한 지난 호출은 늦게 도착해도 잠그지 않는다');
      } finally {
        transition.runProfileWindowScript=run;
        win.webContents.executeJavaScript=execute;
      }
      const before=remote.project(remoteA,defaults);before.pinnedNoteText='선택 화면을 연 뒤 변경';remote.saveProjection(remoteA,before);
      envelope=model.envelope();fileVersion++;
      await js("document.getElementById('profile-sync-apply-choice').click()");
      await until(()=>js("document.getElementById('profile-sync-feedback').textContent.includes('갱신된 내용을 확인')"));
      assert.equal(service.status().selectionRequired,false);
      assert.equal(store.setting(a.id,'pinnedNoteText'),'A 저장');
      store.database.exec("CREATE TRIGGER reject_import_commit BEFORE INSERT ON app_meta WHEN NEW.key='device_config_commit' BEGIN SELECT RAISE(ABORT,'first import commit failure');END");
      try {
        await js("document.getElementById('profile-sync-apply-choice').click()");
        await until(()=>js("document.getElementById('profile-sync-feedback').textContent.includes('first import commit failure')"));
        assert.equal(service.status().selectionRequired,false);
        assert.equal(store.getRecordContext().profileId,a.id);
        assert.equal(store.list().length,2);
      } finally {store.database.exec('DROP TRIGGER reject_import_commit');}
    } else await js("document.querySelector('#profile-sync-choice input[value=merge]').click()");
    await js("document.getElementById('profile-sync-apply-choice').click()");
    await until(()=>sync.details().connection==='ready');await until(()=>js("document.getElementById('profile-sync-choice').hidden"));
    assert.equal(await js("getComputedStyle(document.getElementById('profile-sync-steps')).display"),'none');
    assert.equal(await js("document.querySelector('#profile-sync-steps [aria-current]')"),null);
    await until(()=>js(`document.getElementById('profile-sync-feedback').textContent.includes(${JSON.stringify(remoteImport ? 'Google 데이터를 가져왔습니다' : 'Google 동기화를 설정했습니다')})`));
    assert.equal(await js('Boolean(window.profileSyncExtraConfirm)'),false,'같은 선택을 다시 묻는 팝업 없음');
    const saveConfirmed=config.saveConfirmed;
    config.saveConfirmed=(patch:any)=>'googleSyncAutoSync' in patch ? false : saveConfirmed(patch);
    try {
      const toggle="document.querySelector('#profile-sync-actions input[type=checkbox]')";
      assert.equal(await js(`${toggle}.checked`),false);
      await js(`${toggle}.click()`);
      await until(()=>js("document.getElementById('profile-sync-feedback').textContent.includes('자동 동기화 설정을 저장하지 못했습니다')"));
      assert.equal(await js(`${toggle}.checked`),false,'저장 실패 시 자동 동기화 체크 상태를 복구한다.');
      assert.equal(config.load().googleSyncAutoSync,false);
    } finally {config.saveConfirmed=saveConfirmed;}
    const readyStatus=cloud.status(),lastCheckedAt=Date.now(),lastUploadedAt=lastCheckedAt-86400000;
    const blockedStatus={...readyStatus,isSyncing:false,error:undefined,profileSync:{...readyStatus.profileSync,
      damagedFiles:1,uploadBlocked:true,lastCheckedAt,lastUploadedAt}};
    await js(`window.settingsProfileCloudSync.render(${JSON.stringify(blockedStatus)})`);
    assert.match(await js("document.getElementById('profile-sync-state').textContent"),/전송이 보류/);
    const syncTimes=await js("document.getElementById('profile-sync-account').textContent");
    assert.ok(syncTimes.includes(`마지막 확인 ${new Date(lastCheckedAt).toLocaleString()}`));
    assert.ok(syncTimes.includes(`마지막 전송 ${new Date(lastUploadedAt).toLocaleString()}`));
    await js(`window.settingsProfileCloudSync.render(${JSON.stringify(readyStatus)})`);
    if(remoteImport) {assert.equal(service.status().selectionRequired,true);assert.equal((await service.select(a.id,replay)).success,true);}
    assert.equal(store.list().length,2);assert.equal(service.status().activeProfileId,a.id);assert.equal(service.status().selectionRequired,false);
    assert.equal(sync.details().backupAvailable,true);const zip=sync.model.meta('backupPath','');assert.equal(fs.existsSync(zip),true);assert.ok(zip.endsWith('.zip'));
    const AdmZip=require('adm-zip'),backup=new AdmZip(zip);assert.ok(backup.getEntry('app-data.db'));assert.ok(!backup.getEntry('device-state.json'));
    assert.ok(!backup.getEntry('app-data.db-wal'));assert.ok(!backup.getEntry('app-data.db-shm'));
    assert.deepEqual(fs.readdirSync(path.dirname(zip)).filter(name=>name.includes('before-google-profile-sync')), [path.basename(zip)],
      '성공한 ZIP만 남고 스냅샷 폴더와 실패한 연결의 백업은 정리한다.');
    // 같은 소유자의 수신은 편집 중인 초안과 검색/스크롤/포커스를 유지한다.
    await js("document.getElementById('game-exit-reminder-message').value='입력 중 메모';document.getElementById('game-exit-reminder-message').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('settings-quick-search').value='경험치'");
    const cfg=remote.project(remoteA,defaults);cfg.pinnedNoteText='다른 PC 메모';cfg.buffTimerWarnSeconds=[25];remote.saveProjection(remoteA,cfg);envelope=model.envelope();fileVersion++;
    await pause(2100);await sync.sync(true);
    assert.equal(store.setting(a.id,'pinnedNoteText'),'다른 PC 메모');assert.equal(await js("document.getElementById('game-exit-reminder-message').value"),'입력 중 메모');
    assert.equal(await js("document.getElementById('settings-quick-search').value"),'경험치');assert.equal((await js('window.settingsProfileTransition.status()')).dirty,true);
    const cursorBefore=sync.model.meta('cursor',''),oldWarning=store.setting(a.id,'buffTimerWarnSeconds');const failConfig=remote.project(remoteA,defaults);failConfig.buffTimerWarnSeconds=[31];remote.saveProjection(remoteA,failConfig);envelope=model.envelope();fileVersion++;
    store.database.exec("CREATE TRIGGER reject_external_commit BEFORE INSERT ON app_meta WHEN NEW.key='device_config_commit' BEGIN SELECT RAISE(ABORT,'external commit failure');END");
    await pause(2100);await assert.rejects(sync.sync(true),/external commit failure/);assert.deepEqual(store.setting(a.id,'buffTimerWarnSeconds'),oldWarning);assert.equal(sync.model.meta('cursor',''),cursorBefore,'DB/기기 선택/cursor의 외부 commit 실패는 함께 rollback');
    // 첫 재시도 지연은 2초에 최대20% 지터가 붙는다. 실시간 UI 검사는 그 상한 뒤 재시도한다.
    store.database.exec('DROP TRIGGER reject_external_commit');await pause(2600);await sync.sync(true);assert.deepEqual(store.setting(a.id,'buffTimerWarnSeconds'),[31]);
    // 원격 반영의 대기(도구 저장·백업·입력 확정) 중 생긴 설정 저장은 반영 전에 확정된다.
    // 이후 debounce 저장이 반영 전 projection으로 DB를 되돌리거나 그 되돌림을 다시 전송하지 않는다.
    {
      // 저장 작업 시작(beginStorageMaintenance)의 설정 확정 뒤 백업·입력 확정 대기 위치에서 저장이 생긴 경우를 재현한다.
      const begin=service.beginStorageMaintenance;
      const raced=remote.project(remoteA,defaults);raced.pinnedNoteText='원격 반영 중 설정 저장';
      raced.contentsCheckerItems=[...raced.contentsCheckerItems,{id:'remote-race-task',name:'원격 반영 경합 숙제',category:'일일',isCustom:true,resetRule:{type:'daily',hour:6},completedState:{}}];
      remote.saveProjection(remoteA,raced);envelope=model.envelope();fileVersion++;
      service.beginStorageMaintenance=(...args:unknown[])=>{const lease=begin.apply(service,args);config.save({galleryLastSeen:424242});return lease;};
      try {await pause(2100);await sync.sync(true);} finally {service.beginStorageMaintenance=begin;}
      assert.equal(config.flushPending(),true);
      assert.equal(store.setting(a.id,'pinnedNoteText'),'원격 반영 중 설정 저장','대기 저장 확정이 원격 설정을 되돌리지 않음');
      assert.ok(store.homework(a.id).some((item:any)=>item.id==='remote-race-task'),'대기 저장 확정이 원격 숙제를 지우지 않음');
      assert.equal(config.load().galleryLastSeen,424242,'원격 반영 중 저장한 기기 설정 보존');
      assert.equal(config.load().pinnedNoteText,'원격 반영 중 설정 저장','설정 캐시도 원격 반영 값');
      assert.equal(sync.model.pending(),0,'되돌린 값을 새 로컬 변경으로 만들지 않음');
      const raceUploads=uploads;await pause(2100);await sync.sync(true);
      assert.equal(uploads,raceUploads,'오래된 설정을 Google에 다시 올리지 않음');
      // 안전망: 확정 사이에 대기 저장이 남아도 기기 설정만 새 projection 위에 다시 얹는다.
      config.save({galleryLastSeen:515151});
      const committed=store.project(a.id,config.load());committed.pinnedNoteText='저장 계층 확정 값';store.saveProjection(a.id,committed);
      config.acceptPersistentCommit(store.readConfiguration(config.load()));
      assert.equal(config.load().galleryLastSeen,515151,'대기 중인 기기 설정은 보존');
      assert.equal(config.load().pinnedNoteText,'저장 계층 확정 값');
      assert.equal(config.flushPending(),true);
      assert.equal(store.setting(a.id,'pinnedNoteText'),'저장 계층 확정 값','대기 저장이 확정된 프로필 설정을 되돌리지 않음');
      assert.ok(store.homework(a.id).some((item:any)=>item.id==='remote-race-task'));
      await pause(2100);await sync.sync(true);
    }
    // 저장을 확정한 뒤 두 PC가 같은 필드 수정: 화면에서 후보를 선택하고 한 번만 반영.
    assert.equal(await js('saveSettings(true)'),true);assert.equal(config.flushPending(),true);const local=store.project(a.id,config.load());local.pinnedNoteText='이 PC 충돌';store.saveProjection(a.id,local);config.refreshFromPersistence();
    const next=remote.project(remoteA,defaults);next.pinnedNoteText='저쪽 PC 충돌';remote.saveProjection(remoteA,next);envelope=model.envelope();fileVersion++;
    await pause(2100);await sync.sync(true);await until(()=>js("document.querySelectorAll('[data-sync-review-key]').length>0"));
    const conflict=sync.details().reviews.find((r:any)=>r.label.includes('메모'));assert.ok(conflict);assert.equal(conflict.reason,'conflict');
    const candidateIndex=conflict.candidates.findIndex((candidate:any)=>candidate.value==='저쪽 PC 충돌');assert.ok(candidateIndex>=0);
    const card=`Array.from(document.querySelectorAll('[data-sync-review-key]')).find(n=>n.dataset.syncReviewKey===${JSON.stringify(conflict.key)})`;
    const candidateButton=`${card}.querySelectorAll('button')[${candidateIndex+1}]`;
    const resolve=sync.resolve.bind(sync);let resolveCalls=0,finishReview:((apply:boolean)=>void) | undefined;
    sync.resolve=async (key:string,choice:string)=>{
      resolveCalls++;
      if(!await new Promise<boolean>(done=>{finishReview=done;})) throw new Error('저장을 마친 뒤 다시 시도해 주세요.');
      return resolve(key,choice);
    };
    try {
      await js(`clearSettingsSearch();openSettingsPage('google-sync');${card}.scrollIntoView({block:'center'});${candidateButton}.click()`);
      await until(()=>finishReview!==undefined);
      assert.equal(await js(`${candidateButton}.textContent`),'적용 중…');
      assert.equal(await js(`${card}.querySelector('fieldset').getAttribute('aria-busy')`),'true');
      const panel=`${card}.querySelector('[data-sync-review-progress]')`;
      assert.equal(await js(`${panel}.textContent`),'선택한 값을 적용하고 있습니다…');
      assert.equal(await js(`getComputedStyle(${panel}).display`),'flex');
      assert.ok(await js(`(() => {const box=${panel}.getBoundingClientRect();return box.height>0 && box.top>=0 && box.bottom<=innerHeight;})()`),'설정 창 안에서 진행 패널이 보임');
      const output=path.join(root,'output/profile-sync-ui');fs.mkdirSync(output,{recursive:true});
      fs.writeFileSync(path.join(output,'review-applying.png'),(await win.webContents.capturePage()).toPNG());
      await js(`window.settingsProfileCloudPause.render(${JSON.stringify(cloud.status())});${candidateButton}.click();${card}.querySelector('button').click()`);
      assert.equal(await js("Array.from(document.querySelectorAll('#profile-sync-reviews button')).every(button=>button.disabled)"),true);
      assert.equal(resolveCalls,1,'진행 중 중복 클릭과 다른 값 클릭이 IPC를 다시 호출하지 않음');
      finishReview!(false);
      await until(()=>js(`${panel}.textContent.includes('다시 시도') && !${candidateButton}.disabled`));
      finishReview=undefined;
      await js(`${candidateButton}.click()`);await until(()=>finishReview!==undefined);finishReview!(true);
      await until(()=>js(`!(${card})`));
      assert.equal(store.setting(a.id,'pinnedNoteText'),'저쪽 PC 충돌');assert.equal(resolveCalls,2);
    } finally {sync.resolve=resolve;}
    // 계산기 창에서 이름을 입력하는 중이면 원격 반영만 미루고 이 PC의 변경은 전송한다.
    // 실패·재시도 대기로 다루지 않고, 프로필 전환 안내 대신 동기화 안내를 표시한다. 편집을 마치면 반영한다.
    {
      const calculator=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true}});
      const calc=(code:string)=>calculator.webContents.executeJavaScript(code);
      try {
        await calculator.loadFile(path.join(root,'dist/coefficient-calculator.html'));
        await until(()=>calc(`window.profileToolStorage?.profileId()===${JSON.stringify(a.id)} && window.profileToolStorage.flush()`));
        await calc("document.getElementById('btn-add-profile').click();document.getElementById('modal-input').value='작성 중인 계산 프리셋'");
        const remoteEdit=remote.project(remoteA,defaults);remoteEdit.xpAutoPauseSeconds=97;remote.saveProjection(remoteA,remoteEdit);envelope=model.envelope();fileVersion++;
        assert.equal(await js('saveSettings(true)'),true);assert.equal(config.flushPending(),true);
        const localEdit=store.project(a.id,config.load());localEdit.buffTimerWarnSeconds=[41];store.saveProjection(a.id,localEdit);config.refreshFromPersistence();
        const deferUploads=uploads,pauseBefore=store.setting(a.id,'xpAutoPauseSeconds');
        await pause(2100);await sync.sync(true);
        assert.equal(uploads,deferUploads+1,'계산기 편집 중에도 이 PC의 변경은 전송');assert.equal(sync.model.pending(),0);
        assert.equal(store.setting(a.id,'xpAutoPauseSeconds'),pauseBefore,'편집 중에는 원격 변경을 반영하지 않음');assert.notEqual(pauseBefore,97);
        assert.equal(sync.error,undefined);assert.equal(sync.retryCount,0,'편집 중 반영 보류는 실패·재시도 대기가 아님');
        assert.match(sync.details().remoteDeferred,/계수 계산기에서 작성 중인 내용이 있어/);
        await until(()=>js("document.getElementById('profile-sync-state').textContent.includes('계수 계산기에서 작성 중인 내용이 있어')"));
        assert.doesNotMatch(await js("document.getElementById('profile-sync-state').textContent"),/프로필을 전환/);
        assert.doesNotMatch(await calc("document.querySelector('.profile-tool-context').textContent"),/프로필을 전환/,'계산기 창에 전환 안내를 남기지 않음');
        assert.equal(await calc("document.getElementById('modal-input').value"),'작성 중인 계산 프리셋');
        assert.equal(await calc('document.body.inert'),false);
        await calc("document.getElementById('modal-cancel').click()");
        await pause(2100);await sync.sync(true);
        assert.equal(store.setting(a.id,'xpAutoPauseSeconds'),97,'편집을 마치면 미룬 원격 변경을 반영');
        assert.equal(sync.details().remoteDeferred,undefined);
      } finally {calculator.destroy();}
    }
    // 전송하지 않는 기록/기기 설정: 대기를 비운 뒤 직접 원본을 기록해도 새 예약 없음.
    sync.model.acknowledge(sync.model.envelope().sequence);const before=sync.model.envelope().sequence;
    const diary=built('modules/diaryDb');store.withRecordContext(a.id,service.status().sessionId,()=>diary.addActivityLog('2026-11-04','12:00:00','manual','로컬 SEED',-37));
    assert.equal(config.saveConfirmed({chatLogPath:path.join(fixture,'private-logs'),masterMute:true}),true);
    assert.equal(sync.model.envelope().sequence,before);assert.equal(sync.model.pending(),0,'일지/로그 경로/음소거는 전송 예약 없음');
    remote.update(remoteA,'다른 이름',16);envelope=model.envelope();fileVersion++;await pause(2100);await sync.sync(true);
    assert.equal(store.list().find((p:any)=>p.id===a.id).name,'사냥용 <A>');assert.equal(config.load().userServer,7);
    assert.ok(sync.details().reviews.some((r:any)=>r.reason==='playing-profile'));
    // 사용 중 프로필의 이름을 "이 PC 값 유지"로 정하면 로컬 값이 그대로이므로 프로필 선택을 해제하지 않는다.
    const nameReview=sync.details().reviews.find((r:any)=>r.key.endsWith(',"name"]'));assert.equal(nameReview?.reason,'playing-profile');
    const reviewCard=(key:string)=>`Array.from(document.querySelectorAll('[data-sync-review-key]')).find(n=>n.dataset.syncReviewKey===${JSON.stringify(key)})`;
    await until(()=>js(`Boolean(${reviewCard(nameReview.key)})`));
    assert.equal(await js(`${reviewCard(nameReview.key)}.querySelectorAll('button')[0].textContent`),'이 PC 값 유지');
    await js(`${reviewCard(nameReview.key)}.querySelectorAll('button')[0].click()`);
    await until(()=>!sync.details().reviews.some((r:any)=>r.key===nameReview.key) && !sync.syncing);
    assert.equal(service.status().selectionRequired,false,'이 PC 값 유지는 사용 중 프로필의 선택을 해제하지 않음');
    assert.equal(store.list().find((p:any)=>p.id===a.id).name,'사냥용 <A>');assert.equal(service.status().activeProfileId,a.id);
    const review=sync.details().reviews.find((r:any)=>r.key.endsWith(',"userServer"]'));
    await until(()=>js(`Boolean(${reviewCard(review.key)}) && !${reviewCard(review.key)}.querySelectorAll('button')[1].disabled`));
    await js(`Array.from(document.querySelectorAll('[data-sync-review-key]')).find(n=>n.dataset.syncReviewKey===${JSON.stringify(review.key)}).querySelectorAll('button')[1].click()`);
    await until(()=>service.status().selectionRequired);assert.equal(config.load().userServer,16);
    const pending=store.pending().length;service.dispatch({kind:'legacy-homework',value:{id:store.homework(a.id)[0].id,count:1,isIncrement:true,timestamp:Date.now()}},()=>{throw new Error('선택 전 적용하면 안 됨');},Date.now(),'sync-pending');assert.equal(store.pending().length,pending+1);
    // 외부 페이지에서 새 쓰기 IPC는 거부된다.
    const other=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true}});
    try {await other.loadFile(path.join(root,'dist/profiles.html'));await assert.rejects(other.webContents.executeJavaScript("window.electronAPI.googleSyncConnectChoice('local')"),/환경설정/);
      await assert.rejects(other.webContents.executeJavaScript('window.electronAPI.googleSyncResume()'),/환경설정/,'동기화 다시 켜기도 환경설정에서만 허용');} finally {other.destroy();}
    // 실제 카드만 추출해 800x600에서 긴 후보/이름의 가로 넘침을 확인한다.
    win.setSize(800,600);await js("clearSettingsSearch();openSettingsPage('google-sync')");await pause(300);
    await js("document.getElementById('google-sync-card').scrollIntoView()");await pause(80);
    assert.equal(await js("(() => {const r=document.getElementById('google-sync-card').getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth && getComputedStyle(document.getElementById('google-sync-card').closest('.settings-section')).display!=='none';})()"),true,'실제 800px 설정 화면에서 카드가 표시되고 가로 넘침 없음');
    const output=path.join(root,'output/profile-sync-ui');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'settings-800.png'),(await win.webContents.capturePage()).toPNG());
    win.destroy();await pause(60);config.flushPending();
    // 다른 프로필로 이동해도 원래 프로필의 진행 중 측정은 원격 삭제에서 보호한다.
    const stopwatch=built('modules/profileStopwatch');assert.equal((await service.select(b.id,replay)).success,true);
    await stopwatch.controlProfileStopwatch('start',b.id);assert.equal((await service.select(a.id,replay)).success,true);
    const protectedSession='before-google-delete';
    store.enqueue(protectedSession,{kind:'legacy-homework',value:{id:store.homework(b.id)[0].id,count:1,isIncrement:true,timestamp:Date.now()}},Date.now(),'pending-before-google-delete',b.id);
    const remoteB=localSyncProfileId(remote.database,remoteIdOf(b.id));assert.ok(remoteB);remote.remove(remoteB);envelope=model.envelope();fileVersion++;await pause(2100);await sync.sync(true);
    assert.ok(store.list().some((p:any)=>p.id===b.id),'비활성 프로필의 실행 중 측정 소유자도 보존');
    const deletion=sync.details().reviews.find((r:any)=>r.key===JSON.stringify(['profile',remoteIdOf(b.id),'deleted']));assert.ok(deletion);
    assert.equal(deletion.reason,'pending-records');
    await assert.rejects(sync.resolve(deletion.key,deletion.candidates[0].id),/대기 기록|저장/);
    assert.equal((await service.select(b.id,replay)).success,true);await stopwatch.controlProfileStopwatch('stop',b.id);
    await sync.sync(true);
    assert.ok(store.list().some((p:any)=>p.id===b.id),'측정을 끝내도 대기 기록만으로 삭제를 막음');
    const snapshot=store.pendingSessionSnapshot(protectedSession);
    assert.equal(service.ignoreSession(protectedSession,snapshot.token).success,true);
    assert.equal((await service.select(a.id,replay)).success,true);
    await sync.sync(true);
    const remainingReview=sync.details().reviews.find((r:any)=>r.key===deletion.key);
    if (remainingReview) await sync.resolve(remainingReview.key,remainingReview.candidates[0].id);
    assert.equal(store.list().some((p:any)=>p.id===b.id),false);
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
