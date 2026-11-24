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
    const live=built('modules/chatLogManager').chatLogManager;
    live.start();
    const {service,replay}=controller.runtime,store=service.store;
    const sum=(id:string)=>store.database.prepare('SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE profile_id=? AND amount<0').get(id).n;
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
    const restoredFees=()=>store.pending().filter((row:any)=>[8081,8082].includes(row.payload.data?.amount));
    assert.deepEqual(restoredFees().map((row:any)=>row.payload.data.amount),[8081,8082]);
    assert.ok(restoredFees().every((row:any)=>row.payload.sessionId===null),'복원 중 입력은 원래 세션에 자동 배정하지 않는다.');
    live.start();
    assert.equal(restoredFees().length,2,'인계 위치를 다시 확인해도 대기 기록을 중복 생성하지 않는다.');
    controller.runtime.onGameState('running');assert.equal(opened,1);
    assert.notEqual(service.status().sessionId,expected.sessionId);
    assert.equal((await service.select(expected.b,replay)).success,true);
    assert.equal(sum(expected.b),-79,'새 실행에서 선택해도 이전 세션의 미배정 지출을 자동 반영하지 않는다.');
    assert.equal(store.pending(expected.sessionId).length,1);
    const confirmed=store.pendingSessionSnapshot(expected.sessionId).token;
    const assigned=await service.assignSession(expected.sessionId,expected.b,confirmed,replay);
    assert.equal(assigned.success,true,JSON.stringify(assigned));
    assert.equal(sum(expected.b),-98);assert.equal(store.pending(expected.sessionId).length,0);
    assert.equal((await service.assignSession(expected.sessionId,expected.b,confirmed,replay)).success,false);
    assert.equal(sum(expected.b),-98,'같은 이전 세션을 재확인해도 두 번 반영하지 않는다.');
    assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
    live.stop();application.stopProfileApplication();controller.dispose();built('modules/diaryDb').closeDb();return;
  }
  if (process.argv.includes('--fresh')) {
    const raw={...structuredClone(defaults),analyticsEnabled:false,characterPresets:[],contentsCheckerItems:[]};delete raw.userServer;
    fs.writeFileSync(path.join(fixture,'config.json'),JSON.stringify(raw));built('modules/ipcHandlers').register();
    const application=built('modules/profileApplication'),clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
    const controller=await application.startProfileApplication(()=>{},clock),profiles=controller.runtime.service.status().profiles;
    assert.equal(profiles.length,1);assert.equal(profiles[0].userServer,null);assert.equal(profiles[0].name,'');
    application.stopProfileApplication();controller.dispose();built('modules/diaryDb').closeDb();return;
  }
  const boundaryFixture=process.argv.includes('--boundaries');
  const logs=path.join(fixture,'logs');fs.mkdirSync(logs);
  const today=built('shared/localDate').formatLocalDateKey(),file=path.join(logs,`TWChatLog_${today.replace(/-/g,'_')}.html`);
  const line=(message:string,time='10시 00분 00초')=>`<font size="2" color="white"> [${time}] </font><font size="2" color="#ff64ff">${message}</font></br>\r\n`;
  fs.writeFileSync(file,'\ufeff'+line('초기 안내')+line('가짜 달여왕 군단의 군자금 [ 금화 주머니 3개 ]를 획득했습니다.'),'utf8');
  config.saveConfirmed({...structuredClone(defaults),analyticsEnabled:false,userServer:7,chatLogPath:logs,xpAutoStart:true,
    characterPresets:[{id:'A',name:'통합 A'},{id:'B',name:boundaryFixture ? '나'.repeat(100) : '통합 B'}],selectedCharacterId:'A',
    showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,contentsCheckerEnabled:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false});
  built('modules/ipcHandlers').register();
  const application=built('modules/profileApplication'),clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
  let opened=0,gameProcess=100;
  const starting=application.startProfileApplication(()=>{opened++;},clock,(id:number)=>id===gameProcess);
  assert.equal(application.startProfileApplication(()=>{}),starting);
  const controller=await starting;
  assert.equal(await application.startProfileApplication(()=>{}),controller);
  const {service,replay}=controller.runtime,store=service.store;
  const profiles=store.list();assert.equal(profiles.length,2);
  const a=profiles.find((profile:any)=>profile.name==='통합 A'),b=profiles.find((profile:any)=>profile.id!==a?.id);
  assert.ok(a && b);
  assert.equal(service.status().selectionRequired,true);assert.equal(built('modules/cloudSyncManager').getSyncStatus().profileSync?.version,1,'구형 전송 중지 뒤 새 프로필 전용 동기화 경계');
  controller.runtime.onGameState('minimized');assert.equal(opened,0,'최소화 시작 중 자동 선택창 보류');
  const hiddenSession=service.status().sessionId;assert.ok(hiddenSession);
  controller.runtime.onGameState('running');assert.equal(opened,1);assert.equal(service.status().sessionId,hiddenSession);
  built('modules/chatLogProcessor').chatLogProcessor.start();
  const live=built('modules/chatLogManager').chatLogManager,sync=built('modules/chatLogSyncManager'),diary=built('modules/diaryDb');
  if (boundaryFixture) {
    const observe=controller.runtime.onGameState,amount=(id:string)=>store.database.prepare(
      "SELECT COALESCE(SUM(amount),0) AS total FROM activity_logs WHERE profile_id=? AND type='calc'").get(id).total;
    const fee=(n:number,time='10시 01분 00초')=>line(`입장료 ${n} Seed를 지불하였습니다.`,time);
    const split=(n:number)=>{
      const bytes=Buffer.from(fee(n)),cut=bytes.indexOf(Buffer.from('입장료'))+1;
      return [bytes.subarray(0,cut),bytes.subarray(cut)];
    };
    observe('running',gameProcess);
    assert.equal((await service.select(a.id,replay)).success,true);
    assert.equal(b.name.length,100);
    const {validateProfileSyncEnvelope}=built('modules/profileSyncModel');
    const envelope=built('modules/profileCloudSync').getProfileCloudSync().coordinator.model.envelope();
    validateProfileSyncEnvelope(envelope);
    assert.ok(Object.values(envelope.cells).some((cell:any)=>cell.value===b.name));
    assert.ok(Object.values(envelope.cells).some((cell:any)=>cell.value===a.name));
    assert.equal(service.create('초'.repeat(101),7).success,false);
    const [head,tail]=split(7);
    fs.appendFileSync(file,head);
    const replayToday=live.replayTodayLog;
    live.replayTodayLog=(lines:string[])=>{
      replayToday.call(live,lines);
      fs.appendFileSync(file,Buffer.concat([tail,Buffer.from(fee(11))]));
    };
    const startInterval=global.setInterval;
    global.setInterval=((callback:()=>void,delay:number)=>{
      if (delay===1000) fs.appendFileSync(file,fee(2,'10시 00분 59초'));
      return startInterval(callback,delay);
    }) as typeof setInterval;
    try {live.start();} finally {global.setInterval=startInterval;live.replayTodayLog=replayToday;}
    assert.equal(amount(a.id),-18,'이력 스냅샷의 미완성 UTF-8 행과 직후 추가된 행을 모두 읽는다');
    await until(()=>amount(a.id)===-20);

    fs.appendFileSync(file,fee(19,'10시 01분 01초').trimEnd());
    assert.equal((await service.select(b.id,replay)).success,true);
    assert.equal(amount(a.id),-39,'감시 콜백 전에 실행한 전환은 기존 프로필의 완성 줄을 먼저 읽는다');
    assert.equal(amount(b.id),0,'100자 이름으로도 프로필 선택 가능');
    const [nextHead,nextTail]=split(23);
    fs.appendFileSync(file,Buffer.concat([Buffer.from('\r\n'),nextHead]));
    assert.equal((await service.select(a.id,replay)).success,true);
    fs.appendFileSync(file,nextTail);live._tail.refresh();
    assert.equal(store.pending().filter((event:any)=>event.sessionId.startsWith('unassigned:')).length,1,'소유 경계에 걸친 미완성 줄은 보관한다');
    assert.equal(amount(a.id),-39);assert.equal(amount(b.id),0);

    fs.appendFileSync(file,fee(29,'10시 01분 02초'));
    observe('not-running');
    assert.equal(amount(a.id),-68,'게임 종료 요약 전에 디스크에 남은 마지막 완성 로그를 반영한다');

    observe('running',gameProcess);assert.equal((await service.select(a.id,replay)).success,true);
    const session=service.currentSessionId,windowsBefore=opened;
    observe('minimized',gameProcess);observe('running',gameProcess);
    assert.equal(service.currentSessionId,session);assert.equal(opened,windowsBefore);
    gameProcess++;
    fs.appendFileSync(file,fee(31,'10시 01분 03초'));live._tail.refresh();
    assert.equal(amount(a.id),-68,'프로세스 교체가 확정되기 전에는 이전 프로필로 읽지 않는다');
    observe('minimized',gameProcess);
    assert.notEqual(service.currentSessionId,session);assert.equal(opened,windowsBefore);
    assert.equal(service.status().selectionRequired,true);
    assert.equal(store.pending().filter((event:any)=>event.sessionId.startsWith('unassigned:')).length,2);
    observe('running',gameProcess);assert.equal(opened,windowsBefore+1);
    assert.equal((await service.select(b.id,replay)).success,true);
    fs.appendFileSync(file,fee(52_800_000,'10시 01분 04초'));live._tail.refresh();
    assert.equal(amount(b.id),-52_800_000);assert.equal(amount(a.id),-68);
    assert.equal(store.pending().filter((event:any)=>event.sessionId.startsWith('unassigned:')).length,2,'새 프로필 선택 시 미배정 원본 보존');

    const window=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),contextIsolation:true,sandbox:true,offscreen:true}});
    try {
      await window.loadFile(path.join(root,'dist/game-overlay.html'));
      window.webContents.send('today-summary-config',{...config.load(),showTodaySummaryHud:true});
      const js=(code:string)=>window.webContents.executeJavaScript(code);
      assert.equal((await js('electronAPI.getTodaySummary()')).totalSeed,-52_800_000,'A의 SEED는 B 요약에 섞이지 않는다');
      await until(()=>js("document.getElementById('today-summary-seed').textContent==='-5280만'"));
      assert.match(await js("document.getElementById('today-summary-hud').textContent"),/SEED 순수익/);
      assert.equal(config.saveConfirmed({digsiteHudEnabled:false}),true);
      window.webContents.send('config-data',config.load());
      const showDigsite=()=>window.webContents.send('digsite-update',{isActive:true,expiresAt:Date.now()+60_000,portalVisits:{},portalRewards:0,normalRewards:0,alternateRewards:0});
      await until(()=>js('currentConfig?.digsiteHudEnabled===false'));
      showDigsite();await until(()=>js("document.getElementById('digsite-widget').classList.contains('hidden')"));
      assert.equal((await service.select(a.id,replay)).success,true);
      await until(()=>js('currentConfig?.digsiteHudEnabled===true'));
      showDigsite();await until(()=>js("!document.getElementById('digsite-widget').classList.contains('hidden')"));
      assert.equal((await service.select(b.id,replay)).success,true);
      await until(()=>js('currentConfig?.digsiteHudEnabled===false'));
      showDigsite();await until(()=>js("document.getElementById('digsite-widget').classList.contains('hidden')"));
      const wm=built('modules/windowManager'),originalOverlay=wm.getGameOverlayWindow;
      const beforeReflection=config.load();
      await js(`window.abyssTimingSafeAt=0;
        new MutationObserver(()=>{
          if(document.getElementById('abyss-apostle-alert').classList.contains('safe')) window.abyssTimingSafeAt=Date.now();
        }).observe(document.getElementById('abyss-apostle-alert'),{attributes:true,attributeFilter:['class']});`);
      let reflectionDetectedAt=0;
      try {
        wm.getGameOverlayWindow=()=>window;
        assert.equal(config.saveConfirmed({abyssApostleAlertEnabled:true,abyssApostleStartSound:'none',abyssApostleEndSound:'none'}),true);
        const logged=new Date(Date.now()-2500);
        const timestamp=`${logged.getHours()}시 ${logged.getMinutes()}분 ${logged.getSeconds()}초`;
        reflectionDetectedAt=Date.now();
        fs.appendFileSync(file,line('심연의 제2사도 : 절제와 균형의 중심에서 빗나간 힘은 칼날이 되어 돌아오지.',timestamp));
        live._tail.refresh();
        await until(()=>js("document.getElementById('abyss-apostle-alert').classList.contains('warn')"));
        await pause(6000);
        await until(()=>js('window.abyssTimingSafeAt>0'));
        assert.ok(await js(`window.abyssTimingSafeAt>=${reflectionDetectedAt+6500}`),'실제 tail/파서/IPC/화면에서도 지연된 로그가 6.5초 경고를 줄이지 않는다');
        assert.equal(await js("document.getElementById('abyss-apostle-title').innerText"),'공격 반사 패턴 종료!');
        assert.equal(await js("document.getElementById('abyss-apostle-subtitle').innerText"),'공격 가능');
      } finally {
        wm.getGameOverlayWindow=originalOverlay;
        config.saveConfirmed({abyssApostleAlertEnabled:beforeReflection.abyssApostleAlertEnabled,
          abyssApostleStartSound:beforeReflection.abyssApostleStartSound,abyssApostleEndSound:beforeReflection.abyssApostleEndSound});
      }
      window.webContents.send('abyss-apostle-alert',{message:'만료 검사',endsAt:Date.now()-1});
      await pause(40);
      assert.equal(await js("document.getElementById('abyss-apostle-alert').classList.contains('warn')"),false);
      observe('not-running');
      assert.equal(await js('electronAPI.getTodaySummary()'),null);
      await until(()=>js("document.getElementById('today-summary-hud').classList.contains('hidden')"));
    } finally {window.destroy();}
    observe('running',gameProcess);assert.equal((await service.select(a.id,replay)).success,true);
    live.stop();fs.renameSync(file,file+'.old');live.start();
    fs.writeFileSync(file,'\ufeff'+fee(41,'10시 01분 05초'));
    assert.equal((await service.select(b.id,replay)).success,true);
    assert.equal(amount(a.id),-109,'생성을 기다리던 로그 파일은 전환 전에 첫 줄부터 읽는다');

    const pendingFee=line('입장료 67 Seed를 지불하였습니다. [','10시 01분 06초');
    store.database.exec("CREATE TRIGGER fail_tail_enqueue BEFORE INSERT ON pending_profile_events BEGIN SELECT RAISE(ABORT,'fixture last line write'); END;");
    fs.appendFileSync(file,pendingFee);live._tail.refresh();
    await until(()=>live._profilePersistRetry.length===1);
    assert.equal(live._normalizedRetry.length,0,'저장만 실패한 줄은 원문을 다시 해석하지 않는다');
    assert.equal(amount(b.id),-52_800_000,'쓰기 실패 즉시 확정으로 처리하지 않는다');
    // 저장이 밀린 동안에도 다음 줄을 계속 읽어 채팅 표시가 멈추지 않는다.
    const liveChat=built('modules/chatLogProcessor').chatLogProcessor;
    const stillReading='저장 실패 중에도 읽는 일반 안내';
    fs.appendFileSync(file,line(stillReading,'10시 01분 06초'));live._tail.refresh();
    await until(()=>liveChat.getChatHistory('System').some((item:any)=>item.message===stillReading));
    assert.equal(live._profilePersistRetry.length,1,'기록이 없는 다음 줄은 저장 대기열에 쌓지 않는다');
    assert.equal((await service.select(a.id,replay)).success,false,'실패한 원문을 다른 프로필로 넘기지 않는다');
    store.database.exec('DROP TRIGGER fail_tail_enqueue');
    await until(()=>amount(b.id)===-52_800_067);
    assert.equal((await service.select(a.id,replay)).success,true);
    assert.equal(amount(a.id),-109);assert.equal(amount(b.id),-52_800_067,'새 입력 없이 재시도하고 정확히 한 건만 기록한다');
    const splitTime='10시 01분 07초';
    const splitFee=line('입장료 77 Seed를 지불하였습',splitTime)+line('니다.',splitTime);
    store.database.exec("CREATE TRIGGER fail_join_enqueue BEFORE INSERT ON pending_profile_events BEGIN SELECT RAISE(ABORT,'fixture joined line write'); END;");
    fs.appendFileSync(file,splitFee);live._tail.refresh();
    await until(()=>live._profilePersistRetry.length===1);
    assert.equal(live._normalizedRetry.length,0,'두 줄을 합친 결과의 기록이 저장 실패 후에도 남고 원문은 다시 해석하지 않는다');
    assert.equal(amount(a.id),-109);
    store.database.exec('DROP TRIGGER fail_join_enqueue');
    await until(()=>amount(a.id)===-186);
    fs.appendFileSync(file,fee(89,'10시 01분 08초'));
    await until(()=>amount(a.id)===-275);
    assert.equal(store.pending().filter((event:any)=>event.payload?.data?.amount===77).length,0);

    // 감시 북마크(app_meta)까지 모든 DB 쓰기가 실패해도(디스크 가득 참) 감시를 놓지 않고 다음 줄의 채팅·기믹 이벤트를
    // 계속 처리한다. DB에는 마지막으로 저장한 북마크가 남고, 회복되면 다음 읽기에서 북마크를 다시 저장한다.
    {
      const watchKey='live-chat-watch:'+path.resolve(file).toLowerCase();
      const savedOffset=()=>JSON.parse(store.database.prepare('SELECT value FROM app_meta WHERE key=?').get(watchKey).value).boundary.offset;
      const parser=built('modules/chatParser').chatParser;
      let lokagos=0;const countLokagos=()=>{lokagos++;};
      parser.on('LOKAGOS_PATTERN',countLokagos);
      const tail=live._tail,savedBefore=savedOffset();
      store.database.exec(`CREATE TRIGGER fail_meta_insert BEFORE INSERT ON app_meta BEGIN SELECT RAISE(ABORT,'fixture disk full'); END;
        CREATE TRIGGER fail_meta_update BEFORE UPDATE ON app_meta BEGIN SELECT RAISE(ABORT,'fixture disk full'); END;
        CREATE TRIGGER fail_meta_enqueue BEFORE INSERT ON pending_profile_events BEGIN SELECT RAISE(ABORT,'fixture disk full'); END;`);
      try {
        for (const [index,message] of ['북마크 저장 실패 중 첫 줄','북마크 저장 실패 중 둘째 줄'].entries()) {
          fs.appendFileSync(file,line(message,'10시 01분 09초')+line('선봉대장, 로카고스 : 알파 구역에 마법 공격 지원 바란다!','10시 01분 09초'));
          live._tail.refresh();
          await until(()=>liveChat.getChatHistory('System').some((item:any)=>item.message===message));
          assert.equal(lokagos,index+1,'북마크 저장 실패 중에도 기믹 이벤트를 계속 발행한다');
          assert.equal(live._tail,tail,'북마크 저장 실패로 실시간 감시를 놓거나 재연결하지 않는다');
        }
        assert.equal(savedOffset(),savedBefore,'저장 실패 동안 DB의 북마크는 마지막으로 저장한 위치에 남는다');
      } finally {
        store.database.exec('DROP TRIGGER IF EXISTS fail_meta_insert;DROP TRIGGER IF EXISTS fail_meta_update;DROP TRIGGER IF EXISTS fail_meta_enqueue;');
        parser.removeListener('LOKAGOS_PATTERN',countLokagos);
      }
      fs.appendFileSync(file,line('북마크 저장 회복 확인','10시 01분 09초'));live._tail.refresh();
      await until(()=>savedOffset()===fs.statSync(file).size);
      assert.equal(live._tail,tail);
    }

    // 저장 대기 메모리 상한: 넘은 뒤의 기록은 메모리에 쌓지 않고 북마크를 첫 미저장 줄에 고정한다.
    // 다음 실행(감시 재시작)이 그 위치부터 이벤트 ID로 다시 기록해 잃지 않고, 이미 저장된 줄은 중복하지 않는다.
    const watchKeyToday='live-chat-watch:'+path.resolve(file).toLowerCase();
    const bookmarkOffset=()=>JSON.parse(store.database.prepare('SELECT value FROM app_meta WHERE key=?').get(watchKeyToday).value).boundary.offset;
    const feeRows=(value:number)=>store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE amount=? AND type='calc'").get(-value).n;
    const pendingFeeCount=(value:number)=>store.pending().filter((event:any)=>event.payload?.data?.amount===value).length;
    const firstUnsaved=fs.statSync(file).size;
    live._maxProfilePersistRetryLines=2;
    try {
      store.database.exec("CREATE TRIGGER fail_overflow_enqueue BEFORE INSERT ON pending_profile_events BEGIN SELECT RAISE(ABORT,'fixture overflow write'); END;");
      try {
        fs.appendFileSync(file,fee(201,'10시 01분 10초'));live._tail.refresh();
        await until(()=>live._profilePersistRetry.length===1);
        fs.appendFileSync(file,fee(203,'10시 01분 11초'));live._tail.refresh();
        await until(()=>live._profilePersistRetry.length===2);
        fs.appendFileSync(file,fee(207,'10시 01분 12초')+fee(209,'10시 01분 13초'));live._tail.refresh();
        await until(()=>live._profilePersistPinnedStart!==undefined);
        assert.equal(live._profilePersistPinnedStart,firstUnsaved,'상한을 넘으면 첫 미저장 줄 위치에 북마크를 고정');
        assert.equal(live._profilePersistRetry.length,2,'상한을 넘은 뒤의 기록은 메모리에 더 쌓지 않는다');
        await until(()=>bookmarkOffset()===firstUnsaved);
      } finally {store.database.exec('DROP TRIGGER IF EXISTS fail_overflow_enqueue');}
      await until(()=>live._profilePersistRetry.length===0);
      assert.equal(feeRows(201)+feeRows(203),2,'보관한 기록은 DB가 회복되면 순서대로 저장');
      assert.equal(feeRows(207)+feeRows(209)+pendingFeeCount(207)+pendingFeeCount(209),0,'상한을 넘은 기록은 이번 실행에서 저장하지 않는다');
      fs.appendFileSync(file,line('상한 뒤 북마크 확인','10시 01분 14초'));live._tail.refresh();await pause(300);
      assert.equal(bookmarkOffset(),firstUnsaved,'버린 기록이 있는 동안 북마크를 넘기지 않는다');
      live.stop();live.start();
      await until(()=>pendingFeeCount(207)===1 && pendingFeeCount(209)===1);
      assert.equal(feeRows(201),1);assert.equal(feeRows(203),1);
      assert.equal(pendingFeeCount(201)+pendingFeeCount(203),0,'이미 저장된 줄은 다시 기록하지 않는다');
      await until(()=>!!live._tail && bookmarkOffset()>firstUnsaved);
    } finally {live._maxProfilePersistRetryLines=5000;}

    // 오늘 감시 경계 복구가 계속 실패하면(파일 잠금·DB 오류) 다시 시도하다가, 정해진 횟수 뒤에는
    // 경계를 복구 대기로 넘기고 감시를 시작한다. 앱을 다시 실행해도 감시가 영구히 막히지 않는다.
    const LogManager=built('modules/chatLogManager').ChatLogManager;
    const originalRecover=LogManager.prototype.recoverInterruptedHandoffs;
    const handoffKeyToday='live-chat-handoff:'+path.resolve(file).toLowerCase();
    const blockedWatch=store.database.prepare('SELECT value FROM app_meta WHERE key=?').get(watchKeyToday)?.value;
    assert.ok(blockedWatch,'오늘 파일의 감시 경계가 있어야 이관을 확인할 수 있다');
    let handoffAtRecovery:string | undefined;
    LogManager.prototype.recoverInterruptedHandoffs=function(this:unknown,prefix?:string,...rest:unknown[]) {
      if (prefix==='live-chat-watch:') return {protectTodayPartial:false,blockedToday:true};
      handoffAtRecovery=store.database.prepare('SELECT value FROM app_meta WHERE key=?').get(handoffKeyToday)?.value;
      return originalRecover.call(this,prefix,...rest);
    };
    try {
      live.stop();live._watchStartupBlockedAttempts=0;
      live.start();
      assert.equal(live._tail,null,'복구가 막히면 바로 감시하지 않고 다시 시도한다');
      assert.ok(live._watchStartupRetry,'잠시 뒤 다시 시도를 예약한다');
      assert.equal(live._watchStartupBlockedAttempts,1);
      live._watchStartupBlockedAttempts=9; // 다음 시도가 10번째
      live.start();
      assert.ok(live._tail,'반복 실패 뒤에는 실시간 감시를 시작한다');
      assert.equal(live._watchStartupRetry,undefined);
      assert.equal(live._watchStartupBlockedAttempts,0,'감시를 시작하면 실패 횟수를 초기화한다');
      assert.equal(handoffAtRecovery,blockedWatch,'막힌 감시 경계를 복구 대기로 옮긴 뒤 복구를 시도한다');
    } finally {LogManager.prototype.recoverInterruptedHandoffs=originalRecover;}
    await until(()=>!!live._tail);
    // 대기열은 확정됐지만 일지 트랜잭션이 실패한 경우도 새 로그 없이 원래 프로필로 반영한다.
    store.database.exec("CREATE TRIGGER fail_diary_after_enqueue BEFORE INSERT ON activity_logs WHEN NEW.amount=-61 BEGIN SELECT RAISE(ABORT,'fixture diary write after enqueue'); END;");
    const amountBeforeDiaryFailure=amount(a.id);
    fs.appendFileSync(file,fee(61,'10시 01분 09초'));live._tail.refresh();
    const unprocessed=store.pending().find((event:any)=>event.payload?.data?.amount===61);
    assert.ok(unprocessed);
    assert.equal(store.eventRecordState(unprocessed.eventId).profileId,a.id);
    assert.equal(store.eventRecordState(unprocessed.eventId).resolved,false);
    store.database.exec('DROP TRIGGER fail_diary_after_enqueue');
    await until(()=>amount(a.id)===amountBeforeDiaryFailure-61);
    assert.equal(store.eventRecordState(unprocessed.eventId).resolved,true);

    const exchange='경험치가 10000000000 감소했습니다.';
    const chat=built('modules/chatLogProcessor').chatLogProcessor;
    const countExchange=()=>chat.getChatHistory('System').filter((item:any)=>item.message===exchange).length;
    await until(()=>!!live._tail);
    const beforeExchange=countExchange();
    store.database.exec("CREATE TRIGGER fail_essence_diary BEFORE INSERT ON activity_logs WHEN NEW.type='loot' AND NEW.content LIKE '%경험의 정수%' BEGIN SELECT RAISE(ABORT,'fixture essence diary write'); END;");
    fs.appendFileSync(file,line(exchange,'10시 01분 10초'));live._tail.refresh();
    assert.ok(store.pending().some((event:any)=>event.payload?.data?.message===exchange));
    assert.equal(countExchange(),beforeExchange+1);
    store.database.exec('DROP TRIGGER fail_essence_diary');
    await until(()=>!store.pending().some((event:any)=>event.payload?.data?.message===exchange));
    assert.equal(countExchange(),beforeExchange+1,'일지 재시도 중 보상 채팅 한 번만 표시');

    // 60초 검사 전에 새 날짜 파일을 작성하고 전환한다. 파일 이름의 날짜를 그대로 사용한다.
    await until(()=>!!live._tail);
    const tomorrow=built('shared/localDate').formatLocalDateKey(new Date(Date.now()+86_400_000));
    const tomorrowFile=path.join(logs,`TWChatLog_${tomorrow.replace(/-/g,'_')}.html`);
    const oldToday=live.getTodayFilePath;
    live.getTodayFilePath=()=>tomorrowFile;
    const feeOwner=(value:number)=>store.database.prepare('SELECT profile_id,date FROM activity_logs WHERE amount=? AND type=\'calc\'').get(value);
    const previousTail=live._tail;
    assert.equal((await service.select(b.id,replay)).success,true);
    assert.equal(live._tail,previousTail,'오늘 파일이 생기기 전에는 프로필을 바꿔도 이전 감시를 유지한다');
    fs.appendFileSync(file,fee(127,'23시 59분 57초'));
    live._tail.refresh();
    await until(()=>feeOwner(-127)?.profile_id===b.id);
    assert.deepEqual(feeOwner(-127),{profile_id:b.id,date:today});
    assert.equal((await service.select(a.id,replay)).success,true);
    fs.appendFileSync(file,fee(13,'23시 59분 58초'));
    fs.writeFileSync(tomorrowFile,'\ufeff'+fee(101,'00시 00분 01초'));
    store.database.exec("CREATE TRIGGER fail_midnight_diary BEFORE INSERT ON activity_logs WHEN NEW.amount=-101 BEGIN SELECT RAISE(ABORT,'fixture midnight write'); END;");
    try {
      assert.equal((await service.select(b.id,replay)).success,false);
      assert.equal(service.status().activeProfileId,a.id);
      store.database.exec('DROP TRIGGER fail_midnight_diary');
      await until(()=>!!live._tail);
      assert.equal((await service.select(b.id,replay)).success,true);
      assert.deepEqual(feeOwner(-13),{profile_id:a.id,date:today});
      assert.deepEqual(feeOwner(-101),{profile_id:a.id,date:tomorrow});
      fs.appendFileSync(tomorrowFile,fee(103,'00시 00분 02초'));
      await until(()=>feeOwner(-103)?.profile_id===b.id);
      assert.equal(store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE amount=-101').get().n,1);

      // 개행 없이 큰 행을 읽는 중에도 다음 이벤트 루프 turn에 제어를 돌려준다.
      const oversized=Buffer.alloc(4*1024*1024,65);
      fs.appendFileSync(tomorrowFile,oversized);
      fs.appendFileSync(tomorrowFile,'\n'+fee(129,'00시 00분 03초'));
      live._tail.refresh();
      assert.equal(feeOwner(-129),undefined);
      await until(()=>feeOwner(-129)?.profile_id===b.id);
      live._tail.refresh();
      assert.equal(store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE amount=-129').get().n,1);

      const burstMessage='경험치가 1283 올랐습니다.';
      const burstParser=built('modules/chatParser').chatParser;
      let processed=0;
      const previousPending=store.pending().length;
      const countBurst=(event:{message:string})=>{if(event.message===burstMessage) processed++;};
      burstParser.on('XP_CHANGED',countBurst);
      try {
        fs.appendFileSync(tomorrowFile,line(burstMessage,'00시 00분 03초').repeat(500));
        live._tail.refresh();
        assert.ok(processed>0 && processed<=32,'첫 감시 콜백에서 500줄을 한꺼번에 처리하지 않는다');
        await new Promise(resolve=>setImmediate(resolve));
        assert.ok(processed<500,'다른 이벤트 루프 작업이 로그 묶음 사이에 실행된다');
        await until(()=>processed===500);
        assert.equal(store.pending().length,previousPending,'한꺼번에 들어온 줄이 미배정으로 남지 않는다');

        processed=0;
        fs.appendFileSync(tomorrowFile,line(burstMessage,'00시 00분 04초').repeat(2000)+fee(107,'00시 00분 05초'));
        const switching=service.select(a.id,replay);
        await until(()=>live.profileBoundaryActive && processed>0);
        await new Promise<void>(resolve=>setImmediate(resolve));
        assert.ok(processed<2000,'프로필 전환 대기열 사이에도 메인 이벤트 루프가 응답한다');
        fs.appendFileSync(tomorrowFile,fee(109,'00시 00분 06초'));
        assert.equal((await switching).success,true);
        assert.equal(processed,2000);
        assert.equal(feeOwner(-107)?.profile_id,b.id,'전환 시작 전 파일 바이트는 이전 프로필에 남는다');
        await until(()=>feeOwner(-109)?.profile_id===a.id);

        processed=0;
        fs.appendFileSync(tomorrowFile,line(burstMessage,'00시 00분 07초').repeat(160)+fee(113,'00시 00분 08초'));
        const ending=controller.runtime.onGameState('not-running');
        if (ending) await ending;
        assert.equal(processed,160);
        assert.equal(feeOwner(-113)?.profile_id,a.id,'게임 종료 완료 전에 기존 기록을 확정한다');
        await controller.runtime.onGameState('running');assert.equal((await service.select(a.id,replay)).success,true);
        const crossTime='00시 00분 09초';
        fs.appendFileSync(tomorrowFile,line('입장료 117 Seed를 지불하였습',crossTime));
        assert.equal((await service.select(b.id,replay)).success,true);
        fs.appendFileSync(tomorrowFile,line('니다.',crossTime));live._tail.refresh();
        assert.equal(feeOwner(-117),undefined);
        assert.ok(store.pending().some((event:any)=>event.sessionId.startsWith('unassigned:') && event.payload?.data?.amount===117),
          '전환 경계에 걸쳐 두 줄로 나뉜 원문은 미배정으로 보존한다');

        const originalSave=config.saveConfirmed;
        config.saveConfirmed=(patch:any)=>patch.activePlayProfileId===a.id && patch.profileSelectionRequired===false
          ? false : originalSave(patch);
        try {
          const faultTime='00시 00분 10초';
          fs.appendFileSync(tomorrowFile,line('입장료 119 Seed를 지불하였습',faultTime));
          assert.equal((await service.select(a.id,replay)).success,false);
          assert.equal(service.selectedProfileId,b.id);
          fs.appendFileSync(tomorrowFile,line('니다.',faultTime));live._tail.refresh();
          assert.equal(feeOwner(-119)?.profile_id,b.id,'전환 저장 실패 뒤 결합한 두 줄의 원래 프로필을 유지한다');

          const incomplete=fee(121,'00시 00분 11초'),split=incomplete.indexOf('지불');
          assert.ok(split>0);fs.appendFileSync(tomorrowFile,incomplete.slice(0,split));
          assert.equal((await service.select(a.id,replay)).success,false);
          fs.appendFileSync(tomorrowFile,incomplete.slice(split));live._tail.refresh();
          assert.equal(feeOwner(-121)?.profile_id,b.id,'전환 저장 실패 뒤 하나의 미완성 물리 줄도 기존 프로필에 기록한다');
        } finally {config.saveConfirmed=originalSave;}
        const incomplete=fee(123,'00시 00분 12초'),split=incomplete.indexOf('지불');
        assert.ok(split>0);fs.appendFileSync(tomorrowFile,incomplete.slice(0,split));
        assert.equal((await service.select(a.id,replay)).success,true);
        fs.appendFileSync(tomorrowFile,incomplete.slice(split));live._tail.refresh();
        assert.equal(feeOwner(-123),undefined);
        assert.ok(store.pending().some((event:any)=>event.sessionId.startsWith('unassigned:') && event.payload?.data?.amount===123),
          '실제로 전환한 경우에만 미완성 물리 줄을 미배정으로 보존한다');

        const sync=built('modules/profileCloudSync').getProfileCloudSync().coordinator;
        fs.appendFileSync(tomorrowFile,fee(137,'00시 00분 13초'));
        await assert.rejects(sync.hooks.apply(()=>{throw new Error('fixture sync rollback');},true),/fixture sync rollback/);
        assert.equal(service.selectedProfileId,a.id);
        assert.equal(feeOwner(-137)?.profile_id,a.id);
        fs.appendFileSync(tomorrowFile,fee(139,'00시 00분 14초'));
        await sync.hooks.apply(()=>{},true);
        assert.equal(service.status().selectionRequired,true);
        assert.equal((await service.select(b.id,replay)).success,true);
        assert.equal(feeOwner(-139)?.profile_id,a.id,'Google 재선택 전 미처리 로그는 A에 귀속된다');
        assert.equal(store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE amount IN (-137,-139)').get().n,2);

        const later=built('shared/localDate').formatLocalDateKey(new Date(Date.now()+172_800_000));
        const laterFile=path.join(logs,`TWChatLog_${later.replace(/-/g,'_')}.html`);
        const open=fs.openSync;
        fs.appendFileSync(tomorrowFile,fee(149,'23시 59분 58초'));
        fs.writeFileSync(laterFile,'\ufeff'+fee(151,'00시 00분 01초'));
        live.getTodayFilePath=()=>laterFile;
        try {
          (fs as any).openSync=(filename:unknown,...args:any[])=>{
            if(filename===tomorrowFile) throw Object.assign(new Error('fixture previous file unavailable'),{code:'EACCES'});
            return (open as any)(filename,...args);
          };
          await live.drainProfileBoundary('selection');
        } finally {(fs as any).openSync=open;}
        assert.deepEqual(feeOwner(-151),{profile_id:b.id,date:later});
        assert.equal(feeOwner(-149),undefined);
        const recovery=new (built('modules/chatLogManager').ChatLogManager)();
        recovery.getTodayFilePath=()=>laterFile;
        recovery.recoverInterruptedHandoffs();
        assert.equal(store.pending().filter((event:any)=>event.payload?.data?.amount===149).length,1,'이전 파일의 미처리 기록은 복구 때 한 번만 보관한다');
        assert.equal(store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE amount=-151').get().n,1);
        // 손상된 오늘 감시 경계는 다시 시도해도 쓸 수 없으므로 정리하고, 매 실행 오늘 감시를 막지 않는다.
        const watchKey='live-chat-watch:'+path.resolve(laterFile).toLowerCase();
        store.database.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)').run(watchKey,JSON.stringify({
          filePath:laterFile,encoding:'euc-kr',boundary:{offset:-1,identity:'corrupt',bytes:'zz'}}));
        const corrupt=new (built('modules/chatLogManager').ChatLogManager)();
        corrupt.getTodayFilePath=()=>laterFile;
        const corruptResult=corrupt.recoverInterruptedHandoffs('live-chat-watch:',built('modules/chatLogFileReader').readInitialChatLogSnapshot(laterFile));
        assert.equal(corruptResult.blockedToday,false,'손상된 감시 경계가 오늘 감시를 막지 않는다');
        assert.equal(store.database.prepare('SELECT COUNT(*) n FROM app_meta WHERE key=?').get(watchKey).n,0,'손상된 감시 경계를 정리한다');
      } finally {burstParser.off('XP_CHANGED',countBurst);}
    } finally {live.getTodayFilePath=oldToday;}
    live.stop();application.stopProfileApplication();controller.dispose();config.beginExternalRestore();diary.suspendForRestore();
    console.log('PASS chat log boundaries, process replacement, legacy 100-char profiles, scoped signed HUD');
    return;
  }
  diary.addActivityLog(today,'09:00:00','calc',diary.GOLD_POUCH_DAILY_CONTENT,1500000);
  store.database.exec("CREATE TRIGGER fail_live_source BEFORE INSERT ON profile_log_sources BEGIN SELECT RAISE(ABORT,'fixture live source failure'); END;");
  const setIntervalOriginal=global.setInterval;
  let scheduledWatches=0;
  global.setInterval=((callback:()=>void,delay:number)=> {
    if (delay===1000) scheduledWatches++;
    return setIntervalOriginal(callback,delay);
  }) as typeof setInterval;
  try {
    live.start();
    assert.equal(scheduledWatches,0,'로그 식별 정보 저장 실패 시 watcher를 생성하지 않는다');
  } finally {
    global.setInterval=setIntervalOriginal;
    store.database.exec('DROP TRIGGER fail_live_source');
  }
  live.start();
  const sum=(id:string)=>store.database.prepare('SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE profile_id=? AND amount<0').get(id).n;
  const append=async(message:string,time?:string)=>{const before=fs.statSync(file).size;fs.appendFileSync(file,line(message,time),'utf8');await pause(1200);return before;};
  const firstOffset=await append('입장료 101 Seed를 지불하였습니다.');
  await until(()=>store.pending().length>0);assert.equal(sum(a.id),0);
  const queued=store.pending().find((row:any)=>row.payload.event==='ABANDONED_FEE');
  assert.equal(queued.payload.source.start,firstOffset);assert.equal(queued.payload.source.end,fs.statSync(file).size);
  assert.equal((await service.select(a.id,replay)).success,true);assert.equal(sum(a.id),-101);
  assert.equal((await service.select(b.id,replay)).success,true);
  assert.equal((await sync.syncWeeklyChatLogs({profileId:b.id, startDate:new Date(today+'T00:00:00'),endDate:new Date(today+'T00:00:00')})).success,true);
  assert.equal(sum(b.id),0);assert.equal(sum(a.id),-101,'live records must not copy into another profile restore');
  assert.deepEqual(store.database.prepare('SELECT profile_id,amount FROM activity_logs WHERE content=? ORDER BY id').all(diary.GOLD_POUCH_DAILY_CONTENT),
    [{profile_id:null,amount:1500000},{profile_id:b.id,amount:1500000}],'출처 없는 기존 합계는 보존하고 복원한 원본은 새로 기록');
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
    (dialog as any).showMessageBox=async()=>{
      fs.renameSync(file,file+'.moved');
      throw new Error('fixture log moved during rollback');
    };
    assert.equal(await backup.importBackup(parent),false);
    assert.equal(service.status().busy,false);
    assert.equal(await backup.exportBackup(parent),true,'로그 재연결 실패 뒤에도 후속 백업 가능');
    fs.renameSync(file+'.moved',file);
    live.checkFileChange();
    const marker='복원 실패 뒤 실시간 감시 확인';
    await append(marker);
    await until(()=>built('modules/chatLogProcessor').chatLogProcessor.getChatHistory('System').some((entry:any)=>entry.message===marker));
    assert.equal(live._syncPaused,false);
  } finally {dialog.showSaveDialog=original.save;dialog.showOpenDialog=original.open;dialog.showMessageBox=original.message;parent.destroy();}

  // 이전 미선택 세션의 원본 구간은 현재 프로필 복원으로 가로채지 않는다.
  controller.runtime.onGameState('not-running');controller.runtime.onGameState('running');
  const oldSession=service.status().sessionId;await append('입장료 13 Seed를 지불하였습니다.','10시 00분 05초');
  controller.runtime.onGameState('not-running');controller.runtime.onGameState('running');
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal((await sync.syncWeeklyChatLogs({profileId:a.id,startDate:new Date(today+'T00:00:00'),endDate:new Date(today+'T00:00:00'),reanalyzeCompletedLogs:true})).success,true);
  assert.equal(sum(a.id),-101);assert.ok(store.pending(oldSession).length>0);
  assert.equal((await service.select(b.id,replay)).success,true);assert.equal((await service.assignSession(oldSession,b.id,store.pendingSessionSnapshot(oldSession).token,replay)).success,true);
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
  // ZIP 복원 성공 뒤 새 프로세스가 인계 위치를 읽는다. 재시작 전 입력의 귀속은 확정하지 않는다.
  fs.appendFileSync(file,line('입장료 8081 Seed를 지불하였습니다.','10시 00분 07초'),'utf8');
  const restorePause=await live.pauseForLocalRestore();assert.ok(restorePause);
  fs.appendFileSync(file,line('입장료 8082 Seed를 지불하였습니다.','10시 00분 08초'),'utf8');
  built('modules/chatLogManager').prepareRestoredChatLogHandoff(store.database,false,store.getRecordContext().deviceId,restorePause);
  assert.equal(store.pending(restartSession).length,1,'감시 중단 시 미처리된 줄은 인계 경계에 남는다.');
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
  const boundaries=spawnSync(process.execPath,[__filename,'--boundaries'],{encoding:'utf8',timeout:25000});
  assert.equal(boundaries.status,0,boundaries.stdout+boundaries.stderr);
  console.log(boundaries.stdout.split(/\r?\n/).find(value=>value.startsWith('PASS chat log boundaries')));
  console.log('PASS profile lifecycle: startup selection, actual CRLF live source/restore, periodic checkpoint, compact receipts, ZIP rollback/catch-up, shutdown and separate-process restart');
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
