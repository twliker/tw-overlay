/** 실제 설정 HTML/preload/IPC/SQLite 및 프로필 전환의 초안 경계를 확인한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow,dialog,ipcMain} from 'electron';

const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-settings-'));
const output=path.join(root,'output/profile-settings');
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const pause=(ms=30) => new Promise(resolve => setTimeout(resolve,ms));
const js=(win:BrowserWindow,source:string):Promise<any> => win.webContents.executeJavaScript(source);
async function until(win:BrowserWindow,source:string):Promise<void> {
  for (let n=0;n<200;n++) {if (await js(win,`Boolean(${source})`)) return;await pause();}
  throw new Error(`Timed out: ${source}`);
}
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(output,{recursive:true});
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,lootKeywords:['A 저장값'],volumeCalculators:30,
    analyticsEnabled:false,autoLaunch:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,
    contentsCheckerEnabled:false,showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,pinnedNoteEnabled:false,
    characterPresets:[{id:'A',name:'사냥 <A>'},{id:'B',name:'다른 프로필 B'}],selectedCharacterId:'A'}),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline fixture');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  const a=store.list().find((p:any) => p.name==='사냥 <A>'),b=store.list().find((p:any) => p.name==='다른 프로필 B');
  store.saveProjection(b.id,{...store.project(b.id,config.load()),userServer:16,lootKeywords:['B 저장값']});
  let cancelAfterPrepare=false;
  let afterPrepare:(()=>Promise<void>) | undefined;
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {},prepareTransition:async () => {
    await afterPrepare?.();
    return !cancelAfterPrepare;
  }});
  const {service,replay}=controller.runtime;service.beginSession('settings-ui');assert.equal((await service.select(a.id,replay)).success,true);
  let before:Promise<void> | undefined,after:Promise<void> | undefined,releaseBefore:()=>void=() => {},releaseAfter:()=>void=() => {},entered=0,committed=0;
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler) => register(channel,async (event,...args) => {
    if (channel==='trade-force-check' || channel==='gallery-force-check') return [];
    if (channel==='apply-settings-confirmed') {entered++;if (before) await before;}
    if (channel==='save-monitor-preferences' && before) await before;
    const result=await handler(event,...args);
    if (channel==='apply-settings-confirmed') {committed++;if (after) await after;}
    return result;
  });
  built('modules/ipcHandlers').register();ipcMain.handle=register;
  let response=2,questions=0;
  const originalMessage=dialog.showMessageBox;
  dialog.showMessageBox=(async (_win:unknown,options:any) => {
    assert.equal(await js(_win as BrowserWindow,'document.body.inert'),true,'선택 확인 중 원래 입력을 잠근다');
    assert.deepEqual(options.buttons,['저장 후 전환','저장하지 않고 전환','취소']);assert.equal(options.cancelId,2);
    assert.match(options.message,/변경한 설정/);questions++;return {response};
  }) as typeof dialog.showMessageBox;
  const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  try {
    await win.loadFile(path.join(root,'dist/settings.html'));win.webContents.send('config-data',config.load());
    await until(win,'window.settingsProfileTransition?.status().ready && _initReady');
    const state=() => js(win,'window.settingsProfileTransition.status()');
    const note=() => js(win,`lootKeywordsList[0]`);
    const edit=async (text:string) => js(win,`lootKeywordsList[0]=${JSON.stringify(text)};renderLootKeywordList()`);
    const saved=(id:string) => store.project(id,config.load()).lootKeywords[0];
    const ready=async (id:string) => {await until(win,`window.settingsProfileTransition.status().profileId===${JSON.stringify(id)} && !document.body.inert`);};
    assert.equal((await state()).dirty,false,'처음 연 설정은 미저장 초안이 아니다');
    assert.equal(await note(),'A 저장값');assert.match(await js(win,`document.getElementById('settings-profile-target').textContent`),/사냥 <A>.*하이아칸/);
    assert.equal(await js(win,`document.querySelector('#settings-profile-target a')`),null);
    store.database.prepare("DELETE FROM profile_settings WHERE profile_id=? AND key='userServer'").run(a.id);config.refreshFromPersistence();win.webContents.send('config-data',config.load());await pause(70);
    assert.equal(await js(win,`document.getElementById('chat-overlay-user-server-input').value`),'','기존 서버가 없으면 임의 서버를 선택하지 않는다');
    await js(win,`document.getElementById('volume-calculators').value='37'`);
    assert.equal(await js(win,'saveSettings(true)'),true);assert.equal(config.load().userServer,undefined);
    assert.equal(config.load().volumeCalculators,37,'서버 선택 전에 공통 음량을 저장할 수 있다');
    const missingServer=await service.select(a.id,replay);
    assert.equal(missingServer.success,false);assert.match(missingServer.error,/서버를 선택/);
    assert.equal(config.flushPending(),true);
    store.update(a.id,a.name,7);config.refreshFromPersistence();win.webContents.send('config-data',config.load());await pause(70);
    await js(win,`document.getElementById('settings-quick-search').value='위치';document.getElementById('settings-quick-search').dispatchEvent(new Event('input',{bubbles:true}))`);
    const q=questions;assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);assert.equal(questions,q,'검색/조회 필터만 바꾸면 확인하지 않는다');
    assert.equal(await note(),'B 저장값');assert.match(await js(win,`document.getElementById('settings-profile-target').textContent`),/네냐플/);
    assert.equal(await js(win,`document.getElementById('settings-quick-search').value`),'위치','전환해도 검색/조회 화면 상태 유지');await js(win,'clearSettingsSearch()');
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);

    await edit('A 작성 중');
    assert.equal((await service.select(a.id,replay)).success,true);assert.equal(questions,q);assert.equal(await note(),'A 작성 중');
    response=2;let result=await service.select(b.id,replay);assert.equal(result.success,false);await ready(a.id);
    assert.equal(await note(),'A 작성 중');assert.equal(saved(a.id),'A 저장값');assert.equal((await state()).dirty,true);
    response=1;cancelAfterPrepare=true;result=await service.select(b.id,replay);assert.equal(result.success,false);await ready(a.id);
    assert.equal(await note(),'A 작성 중','버리기 선택 후 전환 자체가 실패하면 초안 보존');cancelAfterPrepare=false;
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    assert.equal(await note(),'B 저장값');assert.equal(saved(a.id),'A 저장값');assert.equal((await state()).dirty,false);

    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    await edit('저장 실패 초안');response=0;
    store.database.exec("CREATE TRIGGER fail_profile_settings BEFORE INSERT ON profile_settings WHEN NEW.key='lootKeywords' BEGIN SELECT RAISE(ABORT,'settings fixture failure');END");
    result=await service.select(b.id,replay);assert.equal(result.success,false);await ready(a.id);
    assert.equal(await note(),'저장 실패 초안');assert.equal(saved(a.id),'A 저장값');assert.equal(saved(b.id),'B 저장값');
    assert.equal((await state()).dirty,true);assert.match(await js(win,`document.getElementById('settings-profile-status').textContent`),/저장하지 못/);
    store.database.exec('DROP TRIGGER fail_profile_settings');
    await js(win,`document.getElementById('volume-calculators').value='45'`);
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    assert.equal(saved(a.id),'저장 실패 초안');assert.equal(saved(b.id),'B 저장값');assert.equal(config.load().volumeCalculators,45);
    assert.equal(win.isDestroyed(),false,'전환을 위한 저장은 설정 창을 닫지 않는다');

    // 작성 중이지만 아직 목록에 추가하지 않은 입력은 저장 성공으로 오인하지 않는다.
    await js(win,`document.getElementById('shout-keyword-input').value='미등록 키워드'`);
    result=await service.select(a.id,replay);assert.equal(result.success,false);await ready(b.id);
    assert.equal(await js(win,`document.getElementById('shout-keyword-input').value`),'미등록 키워드');
    response=1;assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    assert.equal(await js(win,`document.getElementById('shout-keyword-input').value`),'');

    // 일반 즉시 적용의 응답 대기 중에는 전환을 막고 실제 저장 완료 뒤 재시도한다.
    before=new Promise(resolve => {releaseBefore=resolve;});const count=entered;
    await edit('즉시 적용 A');await js(win,`window.pendingImmediate=applySettingsWithDraft({lootKeywords:['즉시 적용 A']},[],{lootKeywordsList:['즉시 적용 A']});void 0`);
    for (let n=0;n<100 && entered===count;n++) await pause();assert.ok(entered>count);
    result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/저장 중/);
    releaseBefore();before=undefined;assert.equal((await js(win,'window.pendingImmediate')).success,true);assert.equal(saved(a.id),'즉시 적용 A');
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);

    // 메인에 늦게 도착한 이전 프로필 요청은 공통 항목까지 원자적으로 거부한다.
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    before=new Promise(resolve => {releaseBefore=resolve;});const oldCount=entered;
    await js(win,`window.staleWrite=electronAPI.applySettingsConfirmed({lootKeywords:['다른 프로필 오염'],volumeCalculators:99},${JSON.stringify(a.id)});void 0`);
    for (let n=0;n<100 && entered===oldCount;n++) await pause();assert.ok(entered>oldCount);
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    releaseBefore();before=undefined;assert.deepEqual(await js(win,'window.staleWrite'),{success:false,error:'profile-changed'});
    assert.equal(saved(a.id),'즉시 적용 A');assert.equal(saved(b.id),'B 저장값');assert.equal(config.load().volumeCalculators,45);
    const blankGuard=built('modules/profileSettingsAccess').validateSettingsProfileWrite;
    assert.equal(blankGuard(win.webContents,undefined),'profile-changed');
    assert.equal(blankGuard({getURL() {throw new Error('closed frame');}},undefined),'profile-changed');

    // 시작 안내의 저장 대상은 실제 안내 화면에서 읽은 ID로 고정한다.
    const wm=built('modules/windowManager');
    assert.equal(config.saveConfirmed({overlayVisible:false}),true);
    const guideLogPath=path.join(fixture,'guide-logs'),previousLogPath=config.load().chatLogPath;
    fs.mkdirSync(guideLogPath);
    fs.writeFileSync(path.join(guideLogPath,'TWChatLog_2026_11_16.html'),'');
    wm.createWelcomeGuideWindow();
    const guide=wm.getWelcomeGuideWindow() as BrowserWindow;
    try {
      await until(guide,`typeof wizardReady!=='undefined' && wizardReady && wizardProfileId===${JSON.stringify(b.id)}`);
      const showOpenDialog=dialog.showOpenDialog;
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[guideLogPath]});
      try {await js(guide,'browseLogFolder()');}
      finally {dialog.showOpenDialog=showOpenDialog;}
      assert.equal(config.load().chatLogPath,previousLogPath,'폴더 선택은 시작 안내의 확정 저장을 기다린다.');
      await js(guide,'selectServer(7)');
      assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
      await js(guide,"document.querySelector('[data-wizard-finish]').click()");
      await until(guide,"document.querySelector('[data-wizard-status]').textContent.includes('프로필이 바뀌었습니다')");
      assert.equal(saved(a.id),'즉시 적용 A');
      assert.equal(store.setting(a.id,'userServer'),7);
      assert.equal(store.setting(b.id,'userServer'),16);
      assert.equal(config.load().chatLogPath,previousLogPath,'이전 프로필의 안내는 공통 경로도 저장하지 않는다.');
      assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
      store.database.exec("CREATE TRIGGER fail_wizard BEFORE INSERT ON profile_settings WHEN NEW.key='userServer' BEGIN SELECT RAISE(ABORT,'wizard fixture failure'); END");
      try {
        await js(guide,'finishWizardAndStart()');
        assert.match(await js(guide,"document.querySelector('[data-wizard-status]').textContent"),/저장하지 못했습니다/);
        assert.equal(store.setting(b.id,'userServer'),16);
        assert.equal(config.load().chatLogPath,previousLogPath,'저장 실패 시 서버와 공통 경로를 함께 되돌린다.');
      } finally {store.database.exec('DROP TRIGGER fail_wizard');}
      await js(win,"electronAPI.onChatLogStatusChanged(value => { window.guideLogStatus=value; }); void 0");
      const closed=new Promise<void>(resolve=>guide.once('closed',()=>resolve()));
      void js(guide,'void finishWizardAndStart()').catch(()=>{});
      await closed;
      assert.equal(store.setting(b.id,'userServer'),7);
      assert.equal(config.load().chatLogPath,guideLogPath);
      await until(win,'window.guideLogStatus===true');
      assert.equal(saved(b.id),'B 저장값','다시 연 안내의 완료는 기존 키워드를 재저장하지 않는다.');
      store.update(b.id,b.name,16);config.refreshFromPersistence();
    } finally {if (!guide.isDestroyed()) guide.destroy();}

    // 강제로 새 설정을 수신한 예외에서도 이전 성공 ACK가 새 프로필의 초안 기준을 바꾸지 않는다.
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    after=new Promise(resolve => {releaseAfter=resolve;});const c=committed;
    await edit('늦은 성공 A');await js(win,`window.oldSuccess=applySettingsWithDraft({lootKeywords:['늦은 성공 A']},[],{lootKeywordsList:['늦은 성공 A']});void 0`);
    for (let n=0;n<100 && committed===c;n++) await pause();assert.ok(committed>c);
    assert.equal(config.saveConfirmed({activePlayProfileId:b.id}),true);win.webContents.send('config-data',config.load());await ready(b.id);
    await edit('B의 새 초안');releaseAfter();after=undefined;assert.equal((await js(win,'window.oldSuccess')).success,true);
    win.webContents.send('config-data',config.load());await pause(80);
    assert.equal(await note(),'B의 새 초안');assert.equal((await state()).dirty,true);assert.equal(saved(b.id),'B 저장값');
    response=1;assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    await js(win,'isHudEditing=true');result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/위치 편집/);
    await js(win,'isHudEditing=false');await ready(a.id);
    assert.equal((await state()).dirty,false);
    assert.equal(service.update(a.id,'새 표시 이름 <A>',7).success,true);
    await until(win,`document.getElementById('settings-profile-target').textContent.includes('새 표시 이름 <A>')`);
    assert.equal(await js(win,`document.getElementById('settings-profile-status').textContent`),'');
    assert.equal((await js(win,`electronAPI.applySettingsConfirmed({lootKeywords:[${JSON.stringify(saved(a.id))}]})`)).success,true,'preload도 마지막으로 수신한 프로필 ID를 기본 전달한다');
    await js(win,`clearSettingsSearch();document.querySelector('.content-area').scrollTop=0`);await pause(150);
    fs.writeFileSync(path.join(output,'settings-1100.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(800,600);await pause(150);fs.writeFileSync(path.join(output,'settings-800.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js(win,`(()=>{const r=document.getElementById('settings-profile-target').getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth})()`),true);

    const tool = new BrowserWindow({show:false,width:520,height:560,webPreferences:{
      preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false,
    }});
    try {
      await tool.loadFile(path.join(root,'dist/pinned-note.html'));
      tool.webContents.send('config-data',config.load());
      await until(tool,'window.settingsProfileTransition?.status().ready');
      await js(tool,`const memo = document.getElementById('pinned-note-text');memo.value='별도 창에서 저장';memo.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('save-memo').click()`);
      await until(tool,"document.getElementById('memo-status').textContent==='저장했습니다.'");
      assert.equal(store.setting(a.id,'pinnedNoteText'),'별도 창에서 저장');
      await js(tool,`document.getElementById('pinned-note-text').value='전환 전 메모 초안';document.getElementById('pinned-note-text').dispatchEvent(new Event('input',{bubbles:true}))`);
      response=2;assert.equal((await service.select(b.id,replay)).success,false);
      assert.equal(await js(tool,"document.getElementById('pinned-note-text').value"),'전환 전 메모 초안');
      response=0;assert.equal((await service.select(b.id,replay)).success,true);
      assert.equal(store.setting(a.id,'pinnedNoteText'),'전환 전 메모 초안');
      await until(tool,`window.settingsProfileTransition.status().profileId===${JSON.stringify(b.id)}`);
      assert.notEqual(await js(tool,"document.getElementById('pinned-note-text').value"),'전환 전 메모 초안');
      await js(tool,`document.getElementById('pinned-note-text').value='오늘 할 일\\n주간 숙제 확인';document.getElementById('pinned-note-text').dispatchEvent(new Event('input',{bubbles:true}))`);
      await until(tool,"document.getElementById('pinned-note-preview').textContent.includes('주간 숙제 확인')");
      assert.match(await js(tool,"document.getElementById('memo-length').textContent"),/1,000자/);
      await until(tool,"document.getElementById('pinned-note-background').getBoundingClientRect().bottom <= document.querySelector('.tool-body').getBoundingClientRect().bottom");
      fs.writeFileSync(path.join(output,'pinned-note.png'),(await tool.webContents.capturePage()).toPNG());
      tool.setSize(400,300);
      await until(tool,"document.getElementById('save-memo').getBoundingClientRect().bottom <= innerHeight");
      tool.setSize(620,550);
      await tool.loadFile(path.join(root,'dist/alarm-history.html'));
      assert.equal(diary.addAlarmLog('boss','필드 보스','기록 화면 갱신 검사'),true);
      assert.equal(diary.addAlarmLog('custom','커스텀','별도 종류 검사'),true);
      await until(tool,"document.getElementById('alarm-log-list').textContent.includes('기록 화면 갱신 검사')");
      await js(tool,`(() => {const control=document.getElementById('alarm-log-filter');control.value='custom';control.dispatchEvent(new Event('change'));})()`);
      await until(tool,"document.getElementById('alarm-log-list').textContent.includes('별도 종류 검사')");
      assert.equal(await js(tool,"document.getElementById('alarm-log-list').textContent.includes('기록 화면 갱신 검사')"),false);
      assert.match(await js(tool,"document.getElementById('alarm-log-list').textContent"),/별도 종류 검사/);
      assert.equal(await js(tool,"document.getElementById('alarm-history-count').textContent"),'1건');
      await js(tool,`(() => {const control=document.getElementById('alarm-log-filter');control.value='word';control.dispatchEvent(new Event('change'));})()`);
      await until(tool,"!document.getElementById('alarm-log-empty').hidden && !document.getElementById('alarm-show-all').hidden");
      await js(tool,"document.getElementById('alarm-show-all').click()");
      await until(tool,"document.querySelectorAll('.history-entry').length===2");
      fs.writeFileSync(path.join(output,'alarm-history.png'),(await tool.webContents.capturePage()).toPNG());
      const insertAlarm=store.database.prepare('INSERT INTO alarm_logs(timestamp,scheduled_at,recorded_at,type,title,message) VALUES(?,?,?,?,?,?)');
      const at=Date.now()+1000;
      for (let i=0;i<200;i++) insertAlarm.run(at+i,at+i,at+i,'custom','최근 알림','최근 테스트');
      assert.equal(diary.getAlarmLogs(200).some((row:any)=>row.type==='boss'),false);
      await js(tool,`(() => {const control=document.getElementById('alarm-log-filter');control.value='boss';control.dispatchEvent(new Event('change'));})()`);
      await until(tool,"document.getElementById('alarm-log-list').textContent.includes('기록 화면 갱신 검사')");
      await js(tool,"window.confirm=()=>true;document.getElementById('clear-alarm-history').click()");
      await until(tool,"document.getElementById('alarm-history-status').textContent==='기록을 삭제했습니다.'");
      assert.deepEqual(diary.getAlarmLogs(10),[]);
      await until(tool,"!document.getElementById('alarm-log-empty').hidden && document.getElementById('clear-alarm-history').disabled");
      for (const name of ['trade','gallery']) {
        await tool.loadFile(path.join(root,'dist',name+'.html'));
        await js(tool,`document.querySelector('[data-monitor-preferences]').click()`);
        const modalReady="document.querySelector('.monitor-preferences').open && !document.querySelector('.monitor-preferences fieldset').disabled";
        await until(tool,modalReady);
        const escapeScript="document.querySelector('.monitor-preferences input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))";
        await js(tool,escapeScript);
        await until(tool,"!document.querySelector('.monitor-preferences').open");
        assert.equal(tool.isDestroyed(),false);
        await js(tool,"document.querySelector('[data-monitor-preferences]').click()");
        await until(tool,modalReady);
        before=new Promise<void>(resolve=>{releaseBefore=resolve;});
        try {
        await js(tool,`(() => {
          const modal = document.querySelector('.monitor-preferences');
          modal.querySelector('input').value='설정 창 저장 검사';
          if (${JSON.stringify(name)} === 'trade') modal.querySelector('select').value='Siwv';
          modal.querySelector('form').requestSubmit();
        })()`);
        await until(tool,"document.querySelector('.monitor-preferences [role=status]').textContent==='저장 중…'");
        await js(tool,escapeScript);
        assert.equal(await js(tool,"document.querySelector('.monitor-preferences').open"),true);
        } finally {before=undefined;releaseBefore();}
        await until(tool,"!document.querySelector('.monitor-preferences').open");
        assert.ok((name==='trade' ? config.load().tradeKeywords : config.load().galleryKeywords).includes('설정 창 저장 검사'));
        if (name==='trade') assert.equal(config.load().tradeServer,'Siwv');
      }
    } finally {tool.destroy();}
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);

    let lateEditor:BrowserWindow | undefined;
    afterPrepare=async()=>{
      lateEditor=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
      await lateEditor.loadFile(path.join(root,'dist/settings.html'));
      lateEditor.webContents.send('config-data',config.load());
      await until(lateEditor,'window.settingsProfileTransition?.status().ready && _initReady');
      await js(lateEditor,`document.getElementById('game-exit-reminder-message').value='전환 중 작성한 초안'`);
    };
    try {
      const result=await service.select(b.id,replay);
      assert.equal(result.success,false);
      assert.match(result.error,/전환 중 설정 또는 도구 창/);
      assert.equal(config.load().activePlayProfileId,a.id);
      assert.equal(await js(lateEditor!,`document.getElementById('game-exit-reminder-message').value`),'전환 중 작성한 초안');
      await ready(a.id);
    } finally {afterPrepare=undefined;lateEditor?.destroy();}

    await edit('삭제 전 초안');response=2;assert.equal((await service.remove(a.id)).success,false);await ready(a.id);assert.equal(await note(),'삭제 전 초안');
    response=1;assert.equal((await service.remove(a.id)).success,true);await ready(b.id);assert.equal(await note(),'B 저장값');assert.equal((await state()).dirty,false);
    console.log('Profile settings: actual Save/Discard/Cancel, rollback/disk-failure draft preservation, frozen writes, late ACK isolation, busy/HUD guards and minimum-size UI passed.');
  } finally {
    dialog.showMessageBox=originalMessage;releaseBefore();releaseAfter();if (!win.isDestroyed()) win.destroy();
    controller.dispose();prepared.stopClock();config.flushPending();
  }
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
