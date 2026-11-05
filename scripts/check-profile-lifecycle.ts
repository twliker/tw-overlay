/** 임시 사용자 폴더에서 실제 시작/실시간 tail/프로필/SQLite/ZIP 실패 복구와 별도 프로세스 재시작을 검사한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawnSync} from 'node:child_process';
import {app,dialog,BrowserWindow} from 'electron';
const root=path.resolve(__dirname,'..'),restartFixture=process.env.TW_PROFILE_LIFECYCLE_RESTART_FIXTURE;
if (restartFixture) {
  const resolved=fs.realpathSync(restartFixture),temporaryRoot=fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(),temporaryRoot.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('tw-profile-lifecycle-'));
  assert.ok(fs.existsSync(path.join(resolved,'restart-expected.json')),'재시작은 이 검사가 만든 임시 데이터만 사용한다.');
}
const fixture=restartFixture ? fs.realpathSync(restartFixture) : fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-lifecycle-'));
app.setPath('userData',fixture);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name+'.js'));
const pause=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean | Promise<boolean>):Promise<void> {for(let n=0;n<160;n++){if(await check())return;await pause();}throw new Error('lifecycle timed out');}
async function main():Promise<void> {
  await app.whenReady();
  const config=built('modules/config'),defaults=built('modules/constants').DEFAULT_CONFIG;
  if (restartFixture) {
    const expected=JSON.parse(fs.readFileSync(path.join(fixture,'restart-expected.json'),'utf8'));
    built('modules/ipcHandlers').register();
    const application=built('modules/profileApplication'),clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
    let opened=0;
    const controller=await application.startProfileApplication(()=>opened++,clock);
    built('modules/chatLogProcessor').chatLogProcessor.start();
    const {service,replay}=controller.runtime,store=service.store;
    const sum=(id:string)=>store.database.prepare('SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE profile_id=?').get(id).n;
    assert.deepEqual(store.list().map(({id,name,userServer}:any)=>({id,name,userServer})),expected.profiles,'앱 재시작으로 기존 프로필을 다시 이전하거나 늘리지 않는다.');
    assert.equal(service.status().selectionRequired,true);
    assert.equal(store.getRecordContext().profileId,null,'마지막 선택 프로필에 자동 기록하지 않는다.');
    assert.equal(config.load().activePlayProfileId,expected.b);
    assert.equal(config.load().userServer,16);
    assert.equal(config.load().pinnedNoteText,'재시작 B 메모');
    assert.equal(store.project(expected.a,config.load()).pinnedNoteText,'재시작 A 메모');
    const homework=store.homework(expected.b).find((item:any)=>item.id==='restart-custom');
    assert.deepEqual(homework.completedState[expected.b],expected.homeworkState);
    assert.equal(store.homework(expected.a).some((item:any)=>item.id==='restart-custom'),false);
    assert.equal(store.toolValues(expected.b)['tw-coefficient-calculator-settings-v7final'],expected.toolValue);
    assert.equal(sum(expected.a),-101);assert.equal(sum(expected.b),-79);
    assert.equal(store.hasEvent('manual-compact-fixture'),true,'정리된 이벤트 영수증도 프로세스 재시작 뒤 유지한다.');
    assert.equal(store.pending(expected.sessionId).length,1);
    controller.runtime.onGameState('running');assert.equal(opened,1);
    assert.notEqual(service.status().sessionId,expected.sessionId);
    assert.equal((await service.select(expected.b,replay)).success,true);
    assert.equal(sum(expected.b),-79,'새 실행에서 선택해도 이전 세션의 미배정 지출을 자동 반영하지 않는다.');
    assert.equal(store.pending(expected.sessionId).length,1);
    const assigned=service.assignSession(expected.sessionId,replay);
    assert.equal(assigned.success,true,JSON.stringify(assigned));
    assert.equal(sum(expected.b),-98);assert.equal(store.pending(expected.sessionId).length,0);
    assert.equal(service.assignSession(expected.sessionId,replay).success,true);
    assert.equal(sum(expected.b),-98,'같은 이전 세션을 재확인해도 두 번 반영하지 않는다.');
    assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
    application.stopProfileApplication();controller.dispose();built('modules/diaryDb').closeDb();return;
  }
  if (process.argv.includes('--fresh')) {
    const raw={...structuredClone(defaults),analyticsEnabled:false,characterPresets:[],contentsCheckerItems:[]};delete raw.userServer;
    fs.writeFileSync(path.join(fixture,'config.json'),JSON.stringify(raw));built('modules/ipcHandlers').register();
    const application=built('modules/profileApplication'),clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
    const controller=await application.startProfileApplication(()=>{},clock),profiles=controller.runtime.service.status().profiles;
    assert.equal(profiles.length,1);assert.equal(profiles[0].userServer,null);assert.equal(profiles[0].name,'');
    application.stopProfileApplication();controller.dispose();built('modules/diaryDb').closeDb();return;
  }
  const logs=path.join(fixture,'logs');fs.mkdirSync(logs);
  const today=built('shared/localDate').formatLocalDateKey(),file=path.join(logs,`TWChatLog_${today.replace(/-/g,'_')}.html`);
  const line=(message:string,time='10시 00분 00초')=>`<font size="2" color="white"> [${time}] </font><font size="2" color="#ff64ff">${message}</font></br>\r\n`;
  fs.writeFileSync(file,'\ufeff'+line('초기 안내')+line('가짜 달여왕 군단의 군자금 [ 금화 주머니 3개 ]를 획득했습니다.'),'utf8');
  config.saveConfirmed({...structuredClone(defaults),analyticsEnabled:false,userServer:7,chatLogPath:logs,xpAutoStart:true,
    characterPresets:[{id:'A',name:'통합 A'},{id:'B',name:'통합 B'}],selectedCharacterId:'A',
    showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,contentsCheckerEnabled:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false});
  built('modules/ipcHandlers').register();
  const application=built('modules/profileApplication'),clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
  let opened=0;
  const starting=application.startProfileApplication(()=>{opened++;},clock);
  assert.equal(application.startProfileApplication(()=>{}),starting);
  const controller=await starting;
  assert.equal(await application.startProfileApplication(()=>{}),controller);
  const {service,replay}=controller.runtime,store=service.store;
  const [a,b]=store.list();assert.equal(store.list().length,2);
  assert.equal(service.status().selectionRequired,true);assert.equal(built('modules/cloudSyncManager').getSyncStatus().profileSync?.version,1,'구형 전송 중지 뒤 새 프로필 전용 동기화 경계');
  controller.runtime.onGameState('minimized');assert.equal(opened,0,'최소화 시작 중 자동 선택창 보류');
  const hiddenSession=service.status().sessionId;assert.ok(hiddenSession);
  controller.runtime.onGameState('running');assert.equal(opened,1);assert.equal(service.status().sessionId,hiddenSession);
  built('modules/chatLogProcessor').chatLogProcessor.start();
  const live=built('modules/chatLogManager').chatLogManager,sync=built('modules/chatLogSyncManager'),diary=built('modules/diaryDb');
  diary.addActivityLog(today,'09:00:00','calc',diary.GOLD_POUCH_DAILY_CONTENT,1500000);
  live.start();
  const sum=(id:string)=>store.database.prepare('SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE profile_id=?').get(id).n;
  const append=async(message:string,time?:string)=>{const before=fs.statSync(file).size;fs.appendFileSync(file,line(message,time),'utf8');await pause(1200);return before;};
  const firstOffset=await append('입장료 101 Seed를 지불하였습니다.');
  await until(()=>store.pending().length>0);assert.equal(sum(a.id),0);
  const queued=store.pending().find((row:any)=>row.payload.event==='ABANDONED_FEE');
  assert.equal(queued.payload.source.start,firstOffset);assert.equal(queued.payload.source.end,fs.statSync(file).size);
  assert.equal((await service.select(a.id,replay)).success,true);assert.equal(sum(a.id),-101);
  assert.equal((await service.select(b.id,replay)).success,true);
  assert.equal((await sync.syncWeeklyChatLogs({profileId:b.id, startDate:new Date(today+'T00:00:00'),endDate:new Date(today+'T00:00:00')})).success,true);
  assert.equal(sum(b.id),0);assert.equal(sum(a.id),-101,'live records must not copy into another profile restore');
  await append('입장료 23 Seed를 지불하였습니다.','10시 00분 01초');assert.equal(sum(b.id),-23);
  await append('경험치가 57 올랐습니다.','10시 00분 02초');
  application.checkpointProfileApplication(true);assert.equal(store.runtimeState(b.id).xp.total,57);

  // 30일이 지난 완료 원문만 줄인다. 재확인은 다시 적용하지 않고 변조 요청은 거부한다.
  const payload={fixture:'compact'},eventId='manual-compact-fixture';
  store.enqueue('compact-session',payload,100,eventId);store.assignPending('compact-session',b.id,()=>{});
  store.database.prepare('UPDATE pending_profile_events SET resolved_at=1 WHERE event_id=?').run(eventId);
  assert.equal(store.compactResolvedEvents(),1);assert.equal(store.hasEvent(eventId),true);
  store.enqueue('compact-session',payload,100,eventId);let applied=0;store.assignPending('compact-session',b.id,()=>applied++);assert.equal(applied,0);
  assert.throws(()=>store.enqueue('compact-session',{fixture:'changed'},100,eventId),/서로 다른/);

  // 실제 ZIP 교체 후 실패: 입력을 멈추고 DB rollback 뒤 새로 쌓인 파일을 이어받는다.
  const backup=built('modules/backupManager'),zip=path.join(fixture,'profiles.zip');
  const original={save:dialog.showSaveDialog,open:dialog.showOpenDialog,message:dialog.showMessageBox};
  const parent=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  await parent.loadFile(path.join(root,'dist/settings.html'));
  parent.webContents.send('config-data',config.load());
  await until(()=>parent.webContents.executeJavaScript("Boolean(window.settingsProfileTransition?.status().ready && _initReady && (!document.getElementById('loading-overlay') || getComputedStyle(document.getElementById('loading-overlay')).visibility==='hidden'))"));
  parent.setSize(800,600);await pause(250);
  fs.mkdirSync(path.join(root,'output/profile-lifecycle'),{recursive:true});
  fs.writeFileSync(path.join(root,'output/profile-lifecycle/settings-800.png'),(await parent.webContents.capturePage()).toPNG());
  assert.equal(await parent.webContents.executeJavaScript("document.getElementById('activity-presets-card')"),null);
  assert.equal(await parent.webContents.executeJavaScript("typeof electronAPI.applyActivityPreset"),'undefined');
  try {
    (dialog as any).showSaveDialog=async()=>({canceled:false,filePath:zip});assert.equal(await backup.exportBackup(parent),true);
    (dialog as any).showOpenDialog=async()=>({canceled:false,filePaths:[zip]});
    (dialog as any).showMessageBox=async()=>{
      assert.equal(service.isStorageMaintenanceActive(),true);assert.equal((await service.select(a.id,replay)).success,false);
      const denied=await parent.webContents.executeJavaScript(`electronAPI.applySettingsConfirmed({userServer:16},${JSON.stringify(b.id)})`);
      assert.equal(denied.error,'profile-storage-busy');
      assert.match(await parent.webContents.executeJavaScript(`getSettingsApplyErrorMessage(${JSON.stringify(denied)})`),/데이터 복구 중/);
      fs.appendFileSync(file,line('입장료 31 Seed를 지불하였습니다.','10시 00분 03초'),'utf8');throw new Error('fixture post-replacement failure');
    };
    assert.equal(await backup.importBackup(parent),false);
    assert.equal(service.status().busy,false);assert.equal(sum(b.id),-54);assert.equal(store.pending().length,0);
    await append('입장료 7 Seed를 지불하였습니다.','10시 00분 04초');assert.equal(sum(b.id),-61);
    assert.equal(built('modules/xpTracker').xpTracker.getStats().total,57);
    (dialog as any).showMessageBox=async()=>{
      controller.runtime.onGameState('not-running');controller.runtime.onGameState('running');
      fs.appendFileSync(file,line('입장료 5 Seed를 지불하였습니다.','10시 00분 04초'),'utf8');throw new Error('fixture game restart during restore');
    };
    assert.equal(await backup.importBackup(parent),false);assert.equal(service.status().selectionRequired,true);
    assert.equal(sum(b.id),-61);assert.ok(store.pending().length>0);
    assert.equal((await service.select(b.id,replay)).success,true);assert.equal(sum(b.id),-66);
  } finally {dialog.showSaveDialog=original.save;dialog.showOpenDialog=original.open;dialog.showMessageBox=original.message;parent.destroy();}

  // 이전 미선택 세션의 원본 구간은 현재 프로필 복원으로 가로채지 않는다.
  controller.runtime.onGameState('not-running');controller.runtime.onGameState('running');
  const oldSession=service.status().sessionId;await append('입장료 13 Seed를 지불하였습니다.','10시 00분 05초');
  controller.runtime.onGameState('not-running');controller.runtime.onGameState('running');
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal((await sync.syncWeeklyChatLogs({profileId:a.id,startDate:new Date(today+'T00:00:00'),endDate:new Date(today+'T00:00:00'),reanalyzeCompletedLogs:true})).success,true);
  assert.equal(sum(a.id),-101);assert.ok(store.pending(oldSession).length>0);
  assert.equal((await service.select(b.id,replay)).success,true);assert.equal(service.assignSession(oldSession,replay).success,true);
  assert.equal(sum(b.id),-79);assert.equal(sum(a.id),-101);assert.equal(store.pending().length,0);

  // 서로 다른 서버/설정/숙제와 이전 세션 원본을 남기고 실제 별도 프로세스에서 다시 연다.
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal(config.saveConfirmed({pinnedNoteText:'재시작 A 메모'}),true);
  assert.equal((await service.select(b.id,replay)).success,true);
  const homeworkState={currentCount:2,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()};
  const custom={id:'restart-custom',name:'재시작 숙제',category:'주간',isVisible:true,isCustom:true,maxCount:3,
    resetRule:{type:'weekly',dayOfWeek:0,hour:6},completedState:{[b.id]:homeworkState}};
  assert.equal(config.saveConfirmed({userServer:16,pinnedNoteText:'재시작 B 메모',contentsCheckerItems:[...config.load().contentsCheckerItems,custom]}),true);
  const toolValue=JSON.stringify({character:'fixture',attack:321});
  store.saveToolValue(b.id,'tw-coefficient-calculator-settings-v7final',toolValue);
  controller.runtime.onGameState('not-running');controller.runtime.onGameState('running');
  const restartSession=service.status().sessionId;await append('입장료 19 Seed를 지불하였습니다.','10시 00분 06초');
  assert.equal(store.pending(restartSession).length,1);assert.equal(sum(b.id),-79);
  fs.writeFileSync(path.join(fixture,'restart-expected.json'),JSON.stringify({
    a:a.id,b:b.id,profiles:store.list().map(({id,name,userServer}:any)=>({id,name,userServer})),
    sessionId:restartSession,homeworkState,toolValue,
  }));

  // 종료 요청은 준비 중 worker까지 취소하고 이후 늦은 DB 쓰기를 막는다.
  const job=sync.syncWeeklyChatLogs({profileId:b.id,startDate:new Date(today+'T00:00:00'),endDate:new Date(today+'T00:00:00')});
  const stopped=sync.stopHistoricalChatLogSync();await Promise.allSettled([job,stopped]);
  live.stop();application.stopProfileApplication();assert.equal(service.status().busy,false);
  await assert.rejects(sync.syncWeeklyChatLogs({profileId:b.id}),/종료/);
  assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
  controller.dispose();config.beginExternalRestore();diary.suspendForRestore();
  const restart=spawnSync(process.execPath,[__filename],{encoding:'utf8',timeout:30000,env:{...process.env,TW_PROFILE_LIFECYCLE_RESTART_FIXTURE:fixture}});
  assert.equal(restart.status,0,restart.stdout+restart.stderr);
  const fresh=spawnSync(process.execPath,[__filename,'--fresh'],{encoding:'utf8',timeout:20000});assert.equal(fresh.status,0,fresh.stdout+fresh.stderr);
  console.log('PASS profile lifecycle: startup selection, actual CRLF live source/restore, periodic checkpoint, compact receipts, ZIP rollback/catch-up, shutdown and separate-process restart');
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
