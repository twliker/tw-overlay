/** 실제 로그 worker·SQLite·프로필 제어·설정 HTML/preload/IPC를 임시 데이터로 검사한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-log-restore-'));
const output=path.join(root,'output/profile-log-restore'),logs=path.join(fixture,'logs');
app.setPath('userData',fixture);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name+'.js'));
const pause=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
const js=(win:BrowserWindow,source:string):Promise<any>=>win.webContents.executeJavaScript(source);
async function until(win:BrowserWindow,source:string):Promise<void> {
  for (let n=0;n<240;n++) {if(await js(win,`Boolean(${source})`))return;await pause();}
  throw new Error(`Timed out: ${source}`);
}
const date=(offset:number)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return d;};
const key=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const line=(message:string,time='10시 00분 00초',color='#ff64ff')=>`<font size="2" color="white"> [${time}] </font><font size="2" color="${color}">${message}</font></br>\r\n`;
const file=(d:Date)=>path.join(logs,`TWChatLog_${key(d).replace(/-/g,'_')}.html`);
const write=(d:Date,messages:string[])=>fs.writeFileSync(file(d),'\ufeff'+messages.join(''),'utf8');
const amounts=(gold:number,elso:number,stone:number)=>[
  line(`가짜 달여왕 군단의 군자금 [ 금화 주머니 ${gold}개 ]를 획득했습니다.`),
  line(`[엘소 스크롤 (1 포인트)]을(를) [${elso}]개 획득하였습니다.`),
  line(`하급 마정석 ${stone}개를 획득 하였습니다.`),
];
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(logs,{recursive:true});fs.mkdirSync(output,{recursive:true});
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  const sync=built('modules/chatLogSyncManager'),states=built('modules/chatLogSyncState');
  const known=date(-2),unknown=date(-3),fresh=date(-1),failure=date(-4);
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,analyticsEnabled:false,chatLogPath:logs,lootKeywords:['테스트 보석','하급 마정석'],
    showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,contentsCheckerEnabled:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,
    characterPresets:[{id:'char-main',name:'복원 <A>'},{id:'B',name:'다른 프로필 B'}],selectedCharacterId:'char-main',
    contentsCheckerItems:[{id:'weekly-eternal-floor',name:'이터널 플로어',category:'확인',isVisible:true,maxCount:1,resetRule:{type:'weekly',dayOfWeek:1,hour:0},completedState:{}}]}),true);
  write(known,[line('콘텐츠 클리어 보상으로 50 SEED를 획득했습니다.'),...amounts(1,1,1),line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.')]);
  diary.initDb();assert.equal((await sync.syncWeeklyChatLogs({startDate:known,endDate:known})).success,true);
  const legacyState=fs.readFileSync(path.join(fixture,'chat-log-sync-state.json'),'utf8');
  // 실시간 구버전 일 합계만 있고 과거 복원 offset이 없는 경우도 원본 NULL을 보존한다.
  diary.addActivityLog(key(unknown),'10:00:00','calc',diary.GOLD_POUCH_DAILY_CONTENT,500000);
  diary.addActivityLog(key(unknown),'10:00:00','elso','엘소 포인트 획득',3);
  diary.addActivityLog(key(unknown),'10:00:00','loot','[득템] [하급 마정석]',2);
  write(unknown,amounts(2,5,4));
  const clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  assert.deepEqual(JSON.parse(store.database.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get().value),JSON.parse(legacyState));
  const a=store.list().find((p:any)=>p.name==='복원 <A>'),b=store.list().find((p:any)=>p.name==='다른 프로필 B');
  store.update(b.id,b.name,16);
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:()=>{}});
  const {service,replay}=controller.runtime;service.beginSession('restore-game');
  const processor=built('modules/chatLogProcessor').chatLogProcessor,parser=built('modules/chatParser').chatParser;
  processor.start();parser.setCurrentDate(key(date(0)));
  const fee=(amount:number)=>parser.parseLine(line(`입장료 ${amount} Seed를 지불하였습니다.`));
  const scope=(id:string | null,d:Date,content?:string)=>store.database.prepare(`SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE profile_id IS ? AND date=?${content ? ' AND content=?' : ''}`).get(id,key(d),...(content?[content]:[])).n;
  const gold=(id:string | null,d:Date)=>scope(id,d,diary.GOLD_POUCH_DAILY_CONTENT);
  const elso=(id:string | null,d:Date)=>scope(id,d,'엘소 포인트 획득');
  const stones=(id:string | null,d:Date)=>scope(id,d,'[득템] [하급 마정석]');
  const hw=(id:string,d:Date)=>store.database.prepare('SELECT COUNT(*) n FROM homework_logs WHERE profile_id=? AND date=?').get(id,key(d)).n;
  const run=(id:string,d:Date,reanalyzeCompletedLogs=false,onProgress?:any)=>sync.syncWeeklyChatLogs({profileId:id,startDate:d,endDate:d,reanalyzeCompletedLogs,onProgress});
  let win:BrowserWindow | undefined;
  try {
    await assert.rejects(run(a.id,fresh),/프로필/);assert.equal((await service.select(a.id,replay)).success,true);
    assert.equal((await run(a.id,known)).success,true);assert.equal(scope(a.id,known),0);assert.equal(gold(null,known),500000);assert.equal(hw(a.id,known),0);
    const first=await run(a.id,unknown);assert.equal(first.success,true);assert.equal(gold(null,unknown),500000);assert.equal(elso(null,unknown),3);assert.equal(stones(null,unknown),2);
    assert.equal(gold(a.id,unknown),500000);assert.equal(elso(a.id,unknown),2);assert.equal(stones(a.id,unknown),2);
    await run(a.id,unknown,true);assert.equal(gold(a.id,unknown),500000);
    fs.appendFileSync(file(unknown),amounts(1,1,1).join(''),'utf8');await run(a.id,unknown);
    assert.equal(gold(a.id,unknown),1000000);assert.equal(elso(a.id,unknown),3);assert.equal(stones(a.id,unknown),3);
    assert.equal((await service.select(b.id,replay)).success,true);await run(b.id,unknown);
    assert.equal(gold(b.id,unknown),0);fs.appendFileSync(file(unknown),amounts(1,2,3).join(''),'utf8');await run(b.id,unknown);
    assert.equal(gold(b.id,unknown),500000);assert.equal(elso(b.id,unknown),2);assert.equal(stones(b.id,unknown),3);
    assert.equal((await service.select(a.id,replay)).success,true);await run(a.id,unknown,true);
    assert.equal(gold(a.id,unknown),1000000);assert.equal(gold(b.id,unknown),500000);assert.equal(gold(null,unknown),500000);

    write(fresh,[line('평범한 시스템 안내'),line('입장료 100 Seed를 지불하였습니다.'),line('콘텐츠 클리어 보상으로 500 SEED를 획득했습니다.'),
      line('[테스트 보석] 아이템을 획득하였습니다.'),line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.'),
      line('외치기 : 물건 팝니다 Click [복원테스터]','23시 59분 57초','#c896c8')]);
    let checked=false,blocked:Promise<any> | undefined,blockedDelete:Promise<any> | undefined;
    const job=run(a.id,fresh,false,()=>{
      if (checked) return;checked=true;assert.equal(service.status().busy,true);
      fee(33);assert.equal(store.pending().length,1);blocked=service.select(b.id,replay);
      blockedDelete=service.remove(a.id);
      assert.equal(service.update(a.id,'변경 금지',7).success,false);
    });
    assert.equal(run(a.id,fresh),job);await assert.rejects(run(b.id,fresh),/복원 중/);
    assert.equal((await job).success,true);assert.equal((await blocked).success,false);
    assert.equal((await blockedDelete).success,false);assert.equal(store.database.prepare('SELECT COUNT(*) n FROM shout_history').get().n,1);
    assert.equal(scope(a.id,fresh),401);assert.equal(hw(a.id,fresh),1);assert.equal(store.pending().length,0);assert.equal(scope(a.id,date(0)),-33);
    store.withRecordContext(a.id,null,()=>diary.addManualActivityLog(key(fresh),'11:00:00','calc','수동 보존',999));
    await run(a.id,fresh,true);assert.equal(scope(a.id,fresh),1400);
    assert.equal((await service.select(b.id,replay)).success,true);await run(b.id,fresh,true);assert.equal(scope(b.id,fresh),0);assert.equal(hw(b.id,fresh),0);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM shout_history').get().n,1,'shared shouts survive another profile snapshot');
    fs.appendFileSync(file(fresh),[line('입장료 20 Seed를 지불하였습니다.','12시 00분 00초'),line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.','12시 00분 01초'),line('외치기 : 새 글 삽니다 Click [다른테스터]','23시 59분 58초','#c896c8')].join(''),'utf8');
    await run(b.id,fresh,true);assert.equal(scope(b.id,fresh),-20);assert.equal(hw(b.id,fresh),1);assert.equal(hw(a.id,fresh),1);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM shout_history').get().n,2);

    // SQLite 확정 위치 저장 실패도 활동·원본 구간과 함께 rollback한다.
    assert.equal((await service.select(a.id,replay)).success,true);write(failure,[line('입장료 77 Seed를 지불하였습니다.')]);
    store.database.exec("CREATE TRIGGER fail_restore_checkpoint BEFORE UPDATE ON profile_log_sync_state WHEN json_extract(NEW.state_json,'$.confirmedOffset')>0 BEGIN SELECT RAISE(ABORT,'fixture checkpoint failure');END");
    assert.equal((await run(a.id,failure)).success,false);assert.equal(scope(a.id,failure),0);assert.equal(service.status().busy,false);
    const failureKey=states.getChatLogSyncStateKey(file(failure));
    assert.equal(JSON.parse(store.database.prepare('SELECT state_json FROM profile_log_sync_state WHERE profile_id=? AND file_key=?').get(a.id,failureKey).state_json).confirmedOffset,0);
    assert.equal(store.database.prepare('SELECT 1 FROM profile_log_sources WHERE file_key=?').get(failureKey),undefined);
    store.database.exec('DROP TRIGGER fail_restore_checkpoint');assert.equal((await run(a.id,failure)).success,true);assert.equal(scope(a.id,failure),-77);
    // 손상된 진행 정보는 빈 상태로 재분석하지 않고 기록을 유지한 채 거부한다.
    const originalSource=store.database.prepare('SELECT state_json FROM profile_log_sources WHERE file_key=?').get(failureKey).state_json;
    store.database.prepare('UPDATE profile_log_sources SET state_json=? WHERE file_key=?').run('{',failureKey);
    assert.equal((await run(a.id,failure)).success,false);assert.equal(scope(a.id,failure),-77);assert.equal(service.status().busy,false);
    store.database.prepare('UPDATE profile_log_sources SET state_json=? WHERE file_key=?').run(originalSource,failureKey);
    const originalState=store.database.prepare('SELECT state_json FROM profile_log_sync_state WHERE profile_id=? AND file_key=?').get(a.id,failureKey).state_json;
    store.database.prepare('UPDATE profile_log_sync_state SET state_json=? WHERE profile_id=? AND file_key=?').run('',a.id,failureKey);
    await assert.rejects(run(a.id,failure),/진행 정보/);assert.equal(scope(a.id,failure),-77);assert.equal(service.status().busy,false);
    store.database.prepare('UPDATE profile_log_sync_state SET state_json=? WHERE profile_id=? AND file_key=?').run(originalState,a.id,failureKey);
    assert.equal((await run(a.id,failure)).success,true);assert.equal(scope(a.id,failure),-77);
    assert.equal(fs.readFileSync(path.join(fixture,'chat-log-sync-state.json'),'utf8'),legacyState,'profile jobs must preserve legacy global progress');
    assert.ok(store.database.prepare('SELECT COUNT(DISTINCT profile_id) n FROM profile_log_sync_state').get().n===2);

    // 오늘 snapshot 뒤에 실제 파일로 추가된 기록은 실시간 경로로 대기/재생한다.
    // 이어받은 구간도 원래 프로필에 보존해 다른 프로필의 다음 복원에 복제하지 않는다.
    const live=built('modules/chatLogManager').chatLogManager;
    write(date(0),[line('일반 시스템 안내'),line('입장료 33 Seed를 지불하였습니다.').trimEnd()]);live.start();
    let appended=false;
    try {
      const result=await run(a.id,date(0),false,(info:any)=>{
        if (appended || info.phase!=='preparing') return;appended=true;
        fs.appendFileSync(file(date(0)),'\r\n'+line('입장료 44 Seed를 지불하였습니다.','10시 00분 01초'),'utf8');
      });
      assert.equal(result.success,true);assert.equal(result.todayRebuilt,true);assert.equal(result.todayCatchUpProcessed,true);
      assert.equal(result.seedsDetected,1,'닫힌 마지막 행은 개행이 없어도 worker snapshot에서 복원해야 함');
      assert.equal(appended,true);assert.ok(result.todayCatchUpBytes>0);assert.equal(store.pending().length,0);assert.equal(scope(a.id,date(0)),-77);
    } finally {live.stop();}
    assert.equal((await service.select(b.id,replay)).success,true);assert.equal((await run(b.id,date(0),true)).success,true);
    assert.equal(scope(b.id,date(0)),0);assert.equal(scope(a.id,date(0)),-77);
    assert.equal((await service.select(a.id,replay)).success,true);assert.equal((await run(a.id,date(0),true)).success,true);assert.equal(scope(a.id,date(0)),-77);

    // 최종 숙제 저장의 바깥 COMMIT 실패도 설정 메모리와 DB를 함께 되돌린다.
    const resetItems=structuredClone(config.load().contentsCheckerItems);
    const targetId='weekly-eternal-floor',targetItem=resetItems.find((item:any)=>item.id===targetId);assert.ok(targetItem);
    targetItem.completedState={[a.id]:{isCompleted:false,currentCount:0}};
    assert.equal(config.saveConfirmed({contentsCheckerItems:resetItems}),true);
    const homeworkSnapshot=()=>store.database.prepare('SELECT profile_id,item_id,definition,state,position FROM profile_homework ORDER BY profile_id,item_id').all();
    const beforeFinalCommit=homeworkSnapshot();
    store.database.exec(`CREATE TABLE restore_commit_fixture(owner TEXT REFERENCES play_profiles(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_restore_final_commit AFTER INSERT ON profile_homework BEGIN INSERT INTO restore_commit_fixture VALUES('missing-owner');END;`);
    await assert.rejects(run(a.id,fresh),/FOREIGN KEY/);assert.equal(service.status().busy,false);
    assert.equal(config.load().contentsCheckerItems.find((item:any)=>item.id===targetId).completedState[a.id].currentCount,0);
    assert.deepEqual(homeworkSnapshot(),beforeFinalCommit,'복원 COMMIT 실패 시 실제 기본 목록 전체와 다른 프로필 상태도 보존');
    assert.equal(JSON.parse(store.database.prepare('SELECT state FROM profile_homework WHERE profile_id=? AND item_id=?').get(a.id,targetId).state).currentCount,0);
    store.database.exec('DROP TRIGGER fail_restore_final_commit;DROP TABLE restore_commit_fixture');
    assert.equal((await run(a.id,fresh)).success,true);assert.equal(config.load().contentsCheckerItems.find((item:any)=>item.id===targetId).completedState[a.id].currentCount,1);
    assert.equal(JSON.parse(store.database.prepare('SELECT state FROM profile_homework WHERE profile_id=? AND item_id=?').get(a.id,targetId).state).currentCount,1);

    // 실제 설정 화면에서 경고/고정 ID/결과와 작은 창을 확인한다.
    built('modules/ipcHandlers').register();
    win=new BrowserWindow({show:false,frame:false,width:1100,height:850,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
    await win.loadFile(path.join(root,'dist/settings.html'));win.webContents.send('config-data',config.load());
    await until(win,'window.settingsProfileTransition?.status().ready && _initReady');
    await js(win,`openSettingsSubTabDirectly('chat',0);document.getElementById('profile-log-restore-notice').scrollIntoView({block:'center'})`);
    assert.match(await js(win,`document.getElementById('profile-log-restore-target').textContent`),/복원 <A>.*하이아칸/);
    assert.match(await js(win,`document.getElementById('profile-log-restore-notice').textContent`),/접속한 캐릭터 정보가 포함되어 있지 않아/);
    const lease=service.beginHistoricalRestore(a.id);
    try {
      const response=await js(win,`electronAPI.applySettingsConfirmed({userServer:16},${JSON.stringify(a.id)})`);
      assert.equal(response.success,false);assert.equal(response.error,'profile-restore-busy');assert.equal(config.load().userServer,7);
      assert.match(await js(win,`getSettingsApplyErrorMessage(${JSON.stringify(response)})`),/과거 로그 복원 중/);
      const checklist=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true}});
      try {
        await checklist.loadFile(path.join(root,'dist/contents-checker.html'));
        const request={kind:'checkReset',args:[],profileId:a.id,requestId:'restore-busy-check',createdAt:Date.now()};
        const reply=await js(checklist,`electronAPI.mutateProfileChecklist(${JSON.stringify(request)})`);
        assert.equal(reply.success,false);assert.match(reply.error,/복원 중/);
        assert.equal(store.database.prepare('SELECT 1 FROM pending_profile_events WHERE event_id=?').get(request.requestId),undefined);
      } finally {checklist.destroy();}
    } finally {lease.finish(replay);}
    assert.equal((await js(win,`electronAPI.startChatLogSync(false,${JSON.stringify(b.id)})`)).success,false);
    await js(win,`document.getElementById('btn-manual-sync').click()`);
    await until(win,`!manualChatLogSyncRunning && document.getElementById('settings-sync-status-text').textContent.includes('복원 완료')`);
    win.setSize(800,600);await js(win,`document.getElementById('profile-log-restore-notice').scrollIntoView({block:'center'})`);await pause(150);
    fs.writeFileSync(path.join(output,'restore-settings-800.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js(win,`(()=>{const r=document.getElementById('profile-log-restore-notice').getBoundingClientRect();return r.top>=0 && r.bottom<innerHeight && document.documentElement.scrollWidth<=innerWidth;})()`),true);
    win.destroy();win=undefined;

    // 게임이 끝나도 시작 당시 세션만 원래 프로필에 처리하고 새 미선택 기록은 남긴다.
    let ended=false;await run(a.id,fresh,false,()=>{if(ended)return;ended=true;fee(11);service.endSession();fee(22);});
    assert.equal(service.status().selectionRequired,true);assert.equal(scope(a.id,date(0)),-88);assert.equal(store.pending().length,1);
    assert.equal(service.status().busy,false);
    assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
    console.log('PASS profile log restore: actual worker, owner/range isolation, legacy NULL aggregates, checkpoint rollback, retries, queued session records and real settings UI');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();controller.dispose();prepared.stopClock();config.flushPending();
  }
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
