/** 실제 로그 worker·SQLite·프로필 제어·설정 HTML/preload/IPC를 임시 데이터로 검사한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow,dialog} from 'electron';
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
  const known=date(-2),unknown=date(-3),fresh=date(-1),failure=date(-4),ambiguous=date(-7);
  // 테스트용 주기의 시작을 이틀 전 한국 날짜로 고정해 어제 로그가 현재 주기에 속하게 한다.
  const resetDay=new Date(known.getTime()+9*60*60*1000).getUTCDay();
  assert.deepEqual(config.sanitizeExternalConfigPatch({diaryKeepDays:0}),{diaryKeepDays:0});
  assert.equal(sync.getDiaryRetentionStartDate(0),null);
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,analyticsEnabled:false,chatLogPath:logs,lootKeywords:['테스트 보석','하급 마정석'],
    showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,contentsCheckerEnabled:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,
    characterPresets:[{id:'char-main',name:'복원 <A>'},{id:'B',name:'다른 프로필 B'}],selectedCharacterId:'char-main',
    contentsCheckerItems:[{id:'weekly-eternal-floor',name:'이터널 플로어',category:'확인',isVisible:true,maxCount:1,resetRule:{type:'weekly',dayOfWeek:resetDay,hour:0},completedState:{}}]}),true);
  write(known,[line('콘텐츠 클리어 보상으로 50 SEED를 획득했습니다.'),...amounts(1,1,1),line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.')]);
  assert.equal((await sync.getSyncTargetLogFiles(logs,date(-1))).length,0,'기간 제한은 이전 파일을 제외한다');
  assert.equal(config.saveConfirmed({diaryKeepDays:0}),true);
  diary.initDb();
  const permanent=await sync.syncWeeklyChatLogs({endDate:known});
  assert.equal(permanent.success,true);
  assert.equal(permanent.startDate,key(known));
  assert.equal(permanent.totalFiles,1);
  assert.equal(config.saveConfirmed({diaryKeepDays:180}),true);
  const legacyState=fs.readFileSync(path.join(fixture,'chat-log-sync-state.json'),'utf8');
  // 실시간 구버전 일 합계만 있고 과거 복원 offset이 없는 경우도 원본 NULL을 보존한다.
  diary.addActivityLog(key(unknown),'10:00:00','calc',diary.GOLD_POUCH_DAILY_CONTENT,500000);
  diary.addActivityLog(key(unknown),'10:00:00','elso','엘소 포인트 획득',3);
  diary.addActivityLog(key(unknown),'10:00:00','loot','[득템] [하급 마정석]',2);
  // v3.2.2 실시간 체크리스트는 날짜·<숙제>_<캐릭터> 한 행만 남겼다. 같은 줄을 복원해도 두 번째 행을 만들지 않는다.
  assert.equal(diary.addHomeworkLog(key(unknown),'weekly-eternal-floor_char-main','이터널 플로어','확인','weekly',new Date(`${key(unknown)}T10:00:00`).getTime()),true);
  write(unknown,[...amounts(2,5,4),line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.')]);
  const duplicateSeed='콘텐츠 클리어 보상으로 509 SEED를 획득했습니다.';
  for (let n=0;n<2;n++) diary.addActivityLog(key(ambiguous),'10:00:00','calc',`[자동] ${duplicateSeed} (509)`,509);
  write(ambiguous,[line(duplicateSeed)]);
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
    assert.equal((await run(a.id,ambiguous)).activityRecordsHeld,1);
    assert.equal(scope(a.id,ambiguous),0);assert.equal(scope(null,ambiguous),1018);
    assert.equal((await run(a.id,ambiguous,true)).activityRecordsHeld,1);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM diary_chat_activity_events WHERE date=? AND review IS NOT NULL').get(key(ambiguous)).n,1);
    // 리뷰 P2: v3.2.2 실시간 일합계(엘소·마정석·금화)와 숙제가 있는 날짜를 복원해도 '모든 프로필' 합계는 한 번만 센다.
    const unknownDate=key(unknown),unknownMonth=unknownDate.slice(0,7),stoneKeywords=['하급 마정석'];
    const statsBefore=diary.getMonthlyStatistics(unknownMonth,stoneKeywords);
    const stoneSum0=(rows:any[])=>rows.filter(row=>row.date===unknownDate && row.content.includes('마정석')).reduce((sum,row)=>sum+row.amount,0);
    const visibleTotals=()=>{
      const day=diary.getDiaryByDate(unknownDate,stoneKeywords),summary=diary.getMonthlySummary(unknownMonth,stoneKeywords);
      const exported=diary.getDiaryExportSnapshot(unknownDate,unknownDate,stoneKeywords);
      const stoneSum=(rows:any[])=>rows.filter(row=>row.date===unknownDate && row.content.includes('마정석')).reduce((sum,row)=>sum+row.amount,0);
      return {
        reviewElso:day.activityLogs.filter((row:any)=>row.type==='elso' && row.legacy_review).map((row:any)=>row.amount),
        reviewStones:day.activityLogs.filter((row:any)=>row.type==='loot' && row.legacy_review).map((row:any)=>row.amount),
        totalElsoDelta:diary.getMonthlyStatistics(unknownMonth,stoneKeywords).totalElso-statsBefore.totalElso,
        calendarStones:stoneSum(summary.calendarLootList),listStones:stoneSum(summary.lootList),
        historyStones:stoneSum(diary.getLootHistory(unknownDate,unknownDate,stoneKeywords)),
        exportStones:stoneSum(exported.rows.filter((row:any)=>row.kind==='득템')),
        exportReview:exported.rows.filter((row:any)=>row.kind==='확인 필요').map((row:any)=>row.amount).sort((x:number,y:number)=>x-y),
        exportGoldReview:exported.legacyGoldReviewSeed,
        homework:day.homeworkLogs.length,
      };
    };
    const first=await run(a.id,unknown);assert.equal(first.success,true);assert.equal(gold(null,unknown),500000);assert.equal(elso(null,unknown),3);assert.equal(stones(null,unknown),2);
    assert.equal(gold(a.id,unknown),1000000);assert.equal(elso(a.id,unknown),5);assert.equal(stones(a.id,unknown),4);
    assert.equal(hw(a.id,unknown),1,'구버전 같은 날짜·숙제 행은 새로 만들지 않고 복원한 프로필로 옮긴다');
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM homework_logs WHERE date=? AND profile_id IS NULL').get(unknownDate).n,0);
    assert.equal(store.database.prepare('SELECT source FROM homework_logs WHERE profile_id=? AND date=?').get(a.id,unknownDate).source,'checklist','구버전 원본 행을 출처 그대로 옮긴다');
    assert.equal(diary.getDiaryByDate(unknownDate,stoneKeywords,{kind:'profile',profileId:a.id}).homeworkLogs.length,1,'복원한 프로필 보기에도 그 숙제가 보인다');
    assert.equal(diary.getDiaryByDate(unknownDate,stoneKeywords,{kind:'unassigned'}).homeworkLogs.length,0,'옮긴 숙제는 미배정에 남지 않는다');
    assert.deepEqual(visibleTotals(),{reviewElso:[3],reviewStones:[2],totalElsoDelta:5-3,calendarStones:4,listStones:4,historyStones:4,
      exportStones:4,exportReview:[2,500000],exportGoldReview:500000,homework:1},'원본 NULL 행은 보존하되 확인 필요로 분리하고 합계에서 제외');
    assert.match(built('modules/diaryExport').renderDiaryExport(diary.getDiaryExportSnapshot(unknownDate,unknownDate,stoneKeywords)),/\[득템\] \[하급 마정석\]<\/td><td>2개/);
    // 4차 집중 리뷰: v2.7.1 이전 DB는 출처를 지정하지 않은 자동 행이 'legacy-unknown'으로 저장된다. 짝 판정은 이 행도 본다.
    const stoneRowSource=(id:string | null)=>store.database.prepare("SELECT source FROM activity_logs WHERE profile_id IS ? AND date=? AND content='[득템] [하급 마정석]'").get(id,unknownDate).source;
    assert.equal(stoneRowSource(a.id),'automatic','복원 마정석 일합계는 출처를 명시한다');
    const setStoneSource=(source:string)=>store.database.prepare("UPDATE activity_logs SET source=? WHERE profile_id=? AND date=? AND content='[득템] [하급 마정석]'").run(source,a.id,unknownDate);
    setStoneSource('legacy-unknown');
    assert.deepEqual(visibleTotals().reviewStones,[2],'출처가 legacy-unknown인 복원 행도 구버전 일합계의 짝으로 본다');
    setStoneSource('automatic');
    // 미배정 범위에는 짝(프로필 복원 행)이 없어 이중 집계가 없으므로 구버전 일합계를 일반 기록으로 합산한다.
    const unassignedScope={kind:'unassigned'} as const;
    const unassignedDay=diary.getDiaryByDate(unknownDate,stoneKeywords,unassignedScope);
    assert.equal(unassignedDay.activityLogs.filter((row:any)=>row.legacy_review || row.legacy_gold_review).length,0,'미배정 범위는 확인 필요로 분리하지 않는다');
    const legacyElsoInMonth=store.database.prepare("SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE type='elso' AND profile_id IS NULL AND substr(date,1,7)=?").get(unknownMonth).n;
    assert.equal(diary.getMonthlyStatistics(unknownMonth,stoneKeywords,unassignedScope).totalElso,legacyElsoInMonth,'미배정 범위 통계는 구버전 엘소를 그대로 센다');
    assert.equal(stoneSum0(diary.getLootHistory(unknownDate,unknownDate,stoneKeywords,unassignedScope)),2,'미배정 범위 득템 이력은 구버전 마정석을 보여 준다');
    await run(a.id,unknown,true);assert.equal(gold(a.id,unknown),1000000);assert.equal(hw(a.id,unknown),1);
    fs.appendFileSync(file(unknown),amounts(1,1,1).join(''),'utf8');await run(a.id,unknown);
    assert.equal(gold(a.id,unknown),1500000);assert.equal(elso(a.id,unknown),6);assert.equal(stones(a.id,unknown),5);
    assert.equal((await service.select(b.id,replay)).success,true);await run(b.id,unknown);
    assert.equal(gold(b.id,unknown),0);fs.appendFileSync(file(unknown),amounts(1,2,3).join(''),'utf8');await run(b.id,unknown);
    assert.equal(gold(b.id,unknown),500000);assert.equal(elso(b.id,unknown),2);assert.equal(stones(b.id,unknown),3);
    assert.equal((await service.select(a.id,replay)).success,true);await run(a.id,unknown,true);
    assert.equal(gold(a.id,unknown),1500000);assert.equal(gold(b.id,unknown),500000);assert.equal(gold(null,unknown),500000);
    assert.deepEqual(visibleTotals(),{reviewElso:[3],reviewStones:[2],totalElsoDelta:6+2-3,calendarStones:5+3,listStones:5+3,historyStones:5+3,
      exportStones:5+3,exportReview:[2,500000],exportGoldReview:500000,homework:1});
    // 이전 빌드가 이미 만든 겹친 복원 숙제 행은 같은 숙제를 다시 반영할 때 정리하고, 구버전 원본 행을 프로필로 옮긴다.
    const restoredEntry={date:unknownDate,contentId:`weekly-eternal-floor_${a.id}`,contentName:'이터널 플로어',category:'확인',type:'weekly',completedAt:Date.now()};
    // 이전 빌드 상태를 만든다: 구버전 행은 미배정으로 남고 같은 숙제의 복원 행이 따로 있다.
    store.database.prepare("UPDATE homework_logs SET profile_id=NULL,content_id='weekly-eternal-floor_char-main' WHERE profile_id=? AND date=?").run(a.id,unknownDate);
    store.database.prepare("INSERT INTO homework_logs(date,content_id,content_name,category,type,completed_at,source,profile_id) VALUES(?,?,?,?,?,?,'chat-log-sync',?)")
      .run(unknownDate,restoredEntry.contentId,'이터널 플로어','확인','weekly',Date.now(),a.id);
    assert.equal(hw(a.id,unknown),1);
    assert.equal(store.withRecordContext(a.id,null,()=>diary.upsertSyncedHomeworkLogs([restoredEntry])).success,true);
    assert.equal(hw(a.id,unknown),1,'겹친 이전 복원 행을 정리하고 한 행만 남긴다');
    assert.equal(store.database.prepare('SELECT source FROM homework_logs WHERE profile_id=? AND date=?').get(a.id,unknownDate).source,'checklist','남은 행은 구버전 원본 행');
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM homework_logs WHERE date=? AND profile_id IS NULL').get(unknownDate).n,0);
    // 구버전 행이 없는 프로필(B)은 같은 숙제도 그대로 기록한다.
    assert.equal(store.withRecordContext(b.id,null,()=>diary.upsertSyncedHomeworkLogs([{...restoredEntry,contentId:`weekly-eternal-floor_${b.id}`}])).success,true);
    assert.equal(hw(b.id,unknown),1);
    store.database.prepare('DELETE FROM homework_logs WHERE date=? AND profile_id=?').run(unknownDate,b.id);

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
    const feeContent='[자동] 어벤던로드 입장료 (-100 SEED)';
    store.database.prepare('DELETE FROM activity_logs WHERE date=? AND profile_id=? AND content=?').run(key(fresh),a.id,feeContent);
    assert.equal(scope(a.id,fresh),1500);
    const repaired=await run(a.id,fresh,true);
    assert.equal(repaired.automaticRecordsRebuiltDates,1);
    assert.equal(scope(a.id,fresh),1400);
    assert.equal((await run(a.id,fresh,true)).automaticRecordsRebuiltDates,0);
    const id=store.database.prepare('SELECT id FROM activity_logs WHERE profile_id=? AND date=? AND amount=500').get(a.id,key(fresh)).id;
    const removable=store.database.prepare('SELECT content FROM activity_logs WHERE id=?').get(id).content;
    store.withRecordContext(a.id,null,()=>diary.removeActivityLog(key(fresh),'calc',removable));
    assert.equal((await run(a.id,fresh,true)).automaticRecordsRebuiltDates,0);
    assert.equal(scope(a.id,fresh),900,'명시적으로 삭제된 자동 기록은 재분석에 되살아나지 않는다');
    // 뒤의 필터/복사본 검사는 복구된 원래 수익을 예상하므로 같은 값의 수동 행으로 보완한다.
    store.withRecordContext(a.id,null,()=>diary.addManualActivityLog(key(fresh),'11:01:00','calc','수동 대조 수익',500));
    assert.equal((await service.select(b.id,replay)).success,true);await run(b.id,fresh,true);assert.equal(scope(b.id,fresh),0);assert.equal(hw(b.id,fresh),0);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM shout_history').get().n,1,'shared shouts survive another profile snapshot');
    fs.appendFileSync(file(fresh),[line('입장료 20 Seed를 지불하였습니다.','12시 00분 00초'),line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.','12시 00분 01초'),line('외치기 : 새 글 삽니다 Click [다른테스터]','23시 59분 58초','#c896c8')].join(''),'utf8');
    await run(b.id,fresh,true);assert.equal(scope(b.id,fresh),-20);assert.equal(hw(b.id,fresh),1);assert.equal(hw(a.id,fresh),1);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM shout_history').get().n,2);

    const alternative=path.join(fixture,'copied-logs');fs.mkdirSync(alternative);
    const copied=path.join(alternative,path.basename(file(fresh)));
    fs.copyFileSync(file(fresh),copied);
    assert.equal(config.saveConfirmed({chatLogPath:alternative}),true);
    try {
      assert.equal((await run(b.id,fresh,true)).success,true);
      assert.equal(scope(b.id,fresh),-20,'다른 폴더의 복사본에는 새 기록이 없음');
      const feeLine=line('입장료 5 Seed를 지불하였습니다.','12시 00분 02초');
      fs.appendFileSync(copied,feeLine+feeLine+amounts(1,4,7).join(''),'utf8');
      assert.equal((await run(b.id,fresh)).success,true);
      assert.equal(scope(b.id,fresh,'[자동] 어벤던로드 입장료 (-5 SEED)'),-10,'같은 시각·같은 내용의 별도 행 두 건을 각각 기록');
      assert.equal(gold(b.id,fresh),500000);assert.equal(elso(b.id,fresh),4);assert.equal(stones(b.id,fresh),7);
      assert.equal((await run(b.id,fresh,true)).success,true);
      assert.equal(gold(b.id,fresh),500000);assert.equal(elso(b.id,fresh),4);assert.equal(stones(b.id,fresh),7);
      fs.writeFileSync(copied,'\\ufeff'+line('입장료 25 Seed를 지불하였습니다.','13시 00분 00초'),'utf8');
      assert.equal((await run(b.id,fresh,true)).success,true);
      assert.equal(scope(b.id,fresh,'[자동] 어벤던로드 입장료 (-25 SEED)'),-25,'같은 날 다른 원문의 기록도 추가');
      assert.equal(scope(a.id,fresh),1400);assert.equal(gold(b.id,fresh),500000);
      // 복원은 줄 귀속(32바이트 줄 키)과 함께 처리 구간(log_ranges applied)을 남긴다.
      assert.equal(store.database.prepare('SELECT min(length(line_key)) bytes FROM profile_log_line_owners').get().bytes,32);
      assert.ok(store.database.prepare("SELECT COUNT(*) n FROM log_ranges WHERE state='applied' AND profile_id=?").get(b.id).n>0,'복원한 프로필의 처리 구간을 남긴다');
    } finally {assert.equal(config.saveConfirmed({chatLogPath:logs}),true);}

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
      assert.equal(appended,true);assert.ok(result.todayCatchUpBytes>0);assert.equal(store.pending().length,0);assert.equal(scope(a.id,date(0)),-110);
    } finally {live.stop();}
    const todayCopy=path.join(alternative,path.basename(file(date(0))));
    fs.copyFileSync(file(date(0)),todayCopy);
    assert.equal(config.saveConfirmed({chatLogPath:alternative}),true);
    try {
      assert.equal((await run(a.id,date(0),true)).success,true);
      assert.equal(scope(a.id,date(0)),-110,'실시간으로 반영한 줄도 다른 폴더의 복사본에서 제외');
      store.database.prepare('DELETE FROM activity_logs WHERE profile_id=? AND date=? AND amount=-44').run(a.id,key(date(0)));
      assert.equal(scope(a.id,date(0)),-66);
      assert.equal((await run(a.id,date(0),true)).automaticRecordsRebuiltDates,1);
      assert.equal(scope(a.id,date(0)),-110,'실시간 저장이 확인된 기록도 동일 원본 복사본에서 복구한다');
    } finally {assert.equal(config.saveConfirmed({chatLogPath:logs}),true);}
    assert.equal((await service.select(b.id,replay)).success,true);assert.equal((await run(b.id,date(0),true)).success,true);
    assert.equal(scope(b.id,date(0)),0);assert.equal(scope(a.id,date(0)),-110);
    assert.equal((await service.select(a.id,replay)).success,true);assert.equal((await run(a.id,date(0),true)).success,true);assert.equal(scope(a.id,date(0)),-110);

    // 최종 숙제 저장의 바깥 COMMIT 실패도 설정 메모리와 DB를 함께 되돌린다.
    const resetItems=structuredClone(config.load().contentsCheckerItems);
    const targetId='weekly-eternal-floor',targetItem=resetItems.find((item:any)=>item.id===targetId);assert.ok(targetItem);
    targetItem.completedState={[a.id]:{isCompleted:false,currentCount:0}};
    assert.equal(config.saveConfirmed({contentsCheckerItems:resetItems}),true);
    const homeworkSnapshot=()=>store.database.prepare('SELECT profile_id,item_id,definition,state,position FROM profile_homework ORDER BY profile_id,item_id').all();
    const beforeFinalCommit=homeworkSnapshot();
    store.database.exec(`CREATE TABLE restore_commit_fixture(owner TEXT REFERENCES play_profiles(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_restore_final_insert AFTER INSERT ON profile_homework BEGIN INSERT INTO restore_commit_fixture VALUES('missing-owner');END;
      CREATE TRIGGER fail_restore_final_update AFTER UPDATE ON profile_homework BEGIN INSERT INTO restore_commit_fixture VALUES('missing-owner');END;`);
    await assert.rejects(run(a.id,fresh),/FOREIGN KEY/);assert.equal(service.status().busy,false);
    assert.equal(config.load().contentsCheckerItems.find((item:any)=>item.id===targetId).completedState[a.id].currentCount,0);
    assert.deepEqual(homeworkSnapshot(),beforeFinalCommit,'복원 COMMIT 실패 시 실제 기본 목록 전체와 다른 프로필 상태도 보존');
    assert.equal(JSON.parse(store.database.prepare('SELECT state FROM profile_homework WHERE profile_id=? AND item_id=?').get(a.id,targetId).state).currentCount,0);
    store.database.exec('DROP TRIGGER fail_restore_final_insert;DROP TRIGGER fail_restore_final_update;DROP TABLE restore_commit_fixture');
    assert.equal((await run(a.id,fresh)).success,true);assert.equal(config.load().contentsCheckerItems.find((item:any)=>item.id===targetId).completedState[a.id].currentCount,1);
    assert.equal(JSON.parse(store.database.prepare('SELECT state FROM profile_homework WHERE profile_id=? AND item_id=?').get(a.id,targetId).state).currentCount,1);

    const contents=built('modules/contentsChecker');
    const completed=()=>config.load().contentsCheckerItems.find((item:any)=>item.id===targetId).completedState[a.id].isCompleted;
    const diaryCompletion=(day:Date)=>store.database.prepare('SELECT completed_at FROM homework_logs WHERE profile_id=? AND date=? AND content_id=?')
      .get(a.id,key(day),`${targetId}_${a.id}`);
    assert.ok(diaryCompletion(fresh),'현재 체크리스트와 복원 완료 행이 같은 원본 시각을 사용한다.');
    const realClock=store.syncClock;
    store.syncClock=()=>({...realClock.call(store),utcMs:new Date(`${key(fresh)}T10:30:00`).getTime()});
    try {contents.toggleItem(targetId,a.id);}
    finally {store.syncClock=realClock;}
    assert.equal(diaryCompletion(fresh),undefined,'복원으로 생성한 완료도 원래 일지에서 취소한다.');
    assert.equal((await run(a.id,fresh,true)).success,true);
    assert.equal(completed(),false);
    assert.equal(diaryCompletion(fresh),undefined,'같은 파일을 다시 분석해도 취소한 기록이 되살아나지 않는다.');
    fs.appendFileSync(file(fresh),line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.','11시 00분 00초'),'utf8');
    assert.equal((await run(a.id,fresh,true)).success,true);
    assert.equal(completed(),true);
    assert.equal(diaryCompletion(fresh)?.completed_at,new Date(`${key(fresh)}T11:00:00`).getTime(),
      '취소 이후의 새 원본에서만 다시 완료한다.');

    // 리뷰 P2/P3: 지난 주기 복원은 장부의 체크리스트 기준값과 같은 줄을 두 번 세지 않고,
    // 나눠서 복원한 같은 주기의 다른 날짜 행은 합쳐서 판단한다. 증분형 숙제(테시스 코어 +1)로 확인한다.
    const tesisId='weekly-tesis-core',tesisLine=line('던전을 클리어 하였습니다. 곧 마을로 돌아가게 됩니다.');
    const tesisRule={type:'weekly',dayOfWeek:resetDay,hour:0};
    const ledgerItems=structuredClone(config.load().contentsCheckerItems).filter((item:any)=>item.id!==tesisId);
    ledgerItems.push({id:tesisId,name:'테시스 코어',category:'확인',isVisible:true,maxCount:2,resetRule:tesisRule,completedState:{}});
    assert.equal(config.saveConfirmed({contentsCheckerItems:ledgerItems}),true);
    const tesisLogs=()=>store.database.prepare('SELECT date,completed_at FROM homework_logs WHERE profile_id=? AND content_id=? ORDER BY date')
      .all(a.id,`${tesisId}_${a.id}`);
    const {getHomeworkCycleStart}=built('shared/homeworkResetCycle');
    // 시나리오 A: 지난 주기(현재 주기 시작 3일 전)에 실시간으로 1회 기록(기준값 1)한 줄을 복원해도 2/2가 아니다.
    const liveDay=date(-5);write(liveDay,[tesisLine]);
    store.database.prepare("INSERT INTO homework_cycle_progress VALUES(?,?,?,'checklist',1,0,?)")
      .run(a.id,tesisId,getHomeworkCycleStart(tesisRule,new Date(`${key(liveDay)}T10:00:00`).getTime()),Date.now());
    assert.equal((await run(a.id,liveDay)).success,true);
    assert.deepEqual(tesisLogs(),[],'실시간 기준값과 같은 줄의 복원 집계를 더해 거짓 완료를 만들지 않는다');
    assert.equal((await run(a.id,liveDay,true)).success,true);
    assert.deepEqual(tesisLogs(),[],'같은 날짜를 다시 복원해도 행을 교체할 뿐 늘리지 않는다');
    // 그 이전 주기를 두 번에 나눠 복원: 각 1회는 1/2, 두 날짜 행을 합치면 2/2로 두 번째 날짜에 완료한다.
    const splitFirst=date(-12),splitSecond=date(-10);write(splitFirst,[tesisLine]);write(splitSecond,[tesisLine]);
    assert.equal((await run(a.id,splitFirst)).success,true);
    assert.deepEqual(tesisLogs(),[],'첫 복원만으로는 1/2');
    assert.equal((await run(a.id,splitSecond)).success,true);
    assert.deepEqual(tesisLogs(),[{date:key(splitSecond),completed_at:new Date(`${key(splitSecond)}T10:00:00`).getTime()}],
      '이전 복원 실행의 다른 날짜 행과 합쳐 완료');
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM homework_cycle_progress WHERE profile_id=? AND item_id=? AND source_key LIKE 'restore:%'").get(a.id,tesisId).n,3,
      '복원 행은 로그 날짜마다 하나');

    // 무시한 기록은 원문이 압축된 뒤에도 원본 파일과 다른 fingerprint의 복사본에서 제외한다.
    const ignoredDay=date(-6),ignoredDate=key(ignoredDay),ignoredTime='10시 10분 00초';
    const header=line('이전 안내 A'),ignoredLine=line('입장료 73 Seed를 지불하였습니다.',ignoredTime);
    write(ignoredDay,[header,ignoredLine]);
    const {prepareProfileLogSource,withProfileLogSource}=built('modules/profileLogSource');
    const fingerprint=prepareProfileLogSource(file(ignoredDay),ignoredDate);
    const rawIgnored=ignoredLine.trimEnd(),start=Buffer.byteLength('\ufeff'+header),end=start+Buffer.byteLength(ignoredLine);
    parser.setCurrentDate(ignoredDate);
    withProfileLogSource({fingerprint,start,end,unassigned:true},()=>parser.parseLine(rawIgnored),rawIgnored);
    parser.setCurrentDate(key(date(0)));
    const ignoredSession=store.pending().find((event:any)=>event.sessionId.startsWith(`unassigned:${ignoredDate}:`))?.sessionId;
    assert.ok(ignoredSession);
    const ignoredSnapshot=store.pendingSessionSnapshot(ignoredSession);
    assert.equal(ignoredSnapshot?.count,1);
    const ignored=service.ignoreSession(ignoredSession,ignoredSnapshot.token);
    assert.equal(ignored.success,true,ignored.error);
    assert.ok(store.compactResolvedEvents(Date.now()+31*86400000)>0);
    assert.equal((await run(a.id,ignoredDay,true)).success,true);
    assert.equal(scope(a.id,ignoredDay),0,'같은 fingerprint의 무시 구간을 복원하지 않는다');
    const ignoredCopy=path.join(alternative,path.basename(file(ignoredDay)));
    fs.writeFileSync(ignoredCopy,'\ufeff'+line('이전 안내 B')+ignoredLine,'utf8');
    assert.notEqual(prepareProfileLogSource(ignoredCopy,ignoredDate),fingerprint);
    assert.equal((await service.select(b.id,replay)).success,true);
    assert.equal(config.saveConfirmed({chatLogPath:alternative}),true);
    try {
      assert.equal((await run(b.id,ignoredDay,true)).success,true);
      assert.equal(scope(b.id,ignoredDay),0,'fingerprint가 달라도 같은 줄 키는 복원하지 않는다');
    } finally {assert.equal(config.saveConfirmed({chatLogPath:logs}),true);}
    assert.equal((await service.select(a.id,replay)).success,true);

    // 실제 설정 화면에서 경고/고정 ID/결과와 작은 창을 확인한다.
    built('modules/ipcHandlers').register();
    win=new BrowserWindow({show:false,frame:false,width:1100,height:850,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
    await win.loadFile(path.join(root,'dist/settings.html'));win.webContents.send('config-data',config.load());
    await until(win,'window.settingsProfileTransition?.status().ready && _initReady');
    await js(win,`openSettingsPage('log-restore');document.getElementById('profile-log-restore-notice').scrollIntoView({block:'center'})`);
    assert.match(await js(win,`document.getElementById('profile-log-restore-target').textContent`),/복원 <A>.*하이아칸/);
    assert.match(await js(win,`document.getElementById('profile-log-restore-notice').textContent`),/접속한 캐릭터 정보가 포함되어 있지 않아/);
    assert.match(await js(win,`document.getElementById('profile-log-restore-notice').textContent`),/구버전 금화 주머니·엘소 포인트·마정석 합계는 같은 날짜의 복원 기록과 겹칠 수 있습니다/);
    const lease=service.beginHistoricalRestore(a.id);
    try {
      const original=dialog.showOpenDialog;
      let openedSoundPicker=false;
      dialog.showOpenDialog=(async()=>{openedSoundPicker=true;return {canceled:true,filePaths:[]};}) as typeof dialog.showOpenDialog;
      try {
        await js(win,"openSettingsPage('sound-files');addCustomSound()");
        assert.equal(openedSoundPicker,false,'복원 중에는 커스텀 알림음 선택·복사 전 저장 가능 상태를 확인한다');
        assert.equal(fs.existsSync(path.join(fixture,'custom_sounds')),false);
        assert.match(await js(win,"document.getElementById('custom-sound-feedback').textContent"),/과거 로그 복원 중/);
        assert.ok(await js(win,"document.getElementById('custom-sound-feedback').getClientRects().length"));
        await js(win,"openSettingsPage('log-restore')");
      } finally {dialog.showOpenDialog=original;}
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
    const originalPicker=dialog.showOpenDialog;
    let releasePicker:((value:{canceled:boolean;filePaths:string[]})=>void) | undefined;
    dialog.showOpenDialog=(()=>new Promise(resolve=>{releasePicker=resolve;})) as typeof dialog.showOpenDialog;
    try {
      await js(win,"openSettingsPage('sound-files');window.pendingSoundPick=addCustomSound();void 0");
      for (let n=0;n<60 && !releasePicker;n++) await pause();
      assert.ok(releasePicker);
      const duringPicker=service.beginHistoricalRestore(a.id);
      try {
        releasePicker({canceled:false,filePaths:[path.join(root,'src','assets','sound','orb.mp3')]});
        await js(win,'window.pendingSoundPick');
        assert.equal(fs.existsSync(path.join(fixture,'custom_sounds')),false,'파일 선택 중 복원이 시작돼도 복사하지 않는다');
        assert.match(await js(win,"document.getElementById('custom-sound-feedback').textContent"),/과거 로그 복원 중/);
      } finally {duringPicker.finish(replay);}
    } finally {dialog.showOpenDialog=originalPicker;}
    await js(win,"openSettingsPage('log-restore')");
    assert.equal((await js(win,`electronAPI.startChatLogSync(false,${JSON.stringify(b.id)})`)).success,false);
    await js(win,`document.getElementById('btn-manual-sync').click()`);
    await until(win,`!manualChatLogSyncRunning && document.getElementById('settings-sync-status-text').textContent.includes('복원 완료')`);
    win.setSize(800,600);await js(win,`document.getElementById('profile-log-restore-notice').scrollIntoView({block:'center'})`);await pause(150);
    fs.writeFileSync(path.join(output,'restore-settings-800.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js(win,`(()=>{const r=document.getElementById('profile-log-restore-notice').getBoundingClientRect();return r.height>0 && r.top>=0 && r.bottom<innerHeight && document.documentElement.scrollWidth<=innerWidth;})()`),true);
    win.destroy();win=undefined;

    // 게임이 끝나도 시작 당시 세션만 원래 프로필에 처리하고 새 미선택 기록은 남긴다.
    let ended=false;await run(a.id,fresh,false,()=>{if(ended)return;ended=true;fee(11);service.endSession();fee(22);});
    assert.equal(service.status().selectionRequired,true);assert.equal(scope(a.id,date(0)),-121);assert.equal(store.pending().length,1);
    assert.equal(service.status().busy,false);
    assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
    const {ChatLogManager}=built('modules/chatLogManager');
    const recoveryWatch=new ChatLogManager(),todayFile=file(date(0));
    const currentDate=key(date(0));
    recoveryWatch.start();
    try {
      assert.ok(await recoveryWatch.pauseForHistoricalSync(todayFile));
      fs.appendFileSync(todayFile,line('입장료 131 Seed를 지불하였습니다.','22시 30분 01초'));
      recoveryWatch.stop(true,false);
      assert.ok(store.database.prepare("SELECT 1 FROM app_meta WHERE key LIKE 'live-chat-handoff:%'").get());
      recoveryWatch.start();
      const recovered=()=>store.pending().filter((event:any)=>event.sessionId.startsWith(`unassigned:${currentDate}:`) && event.payload?.data?.amount===131);
      assert.equal(recovered().length,1);
      assert.equal(store.database.prepare("SELECT 1 FROM app_meta WHERE key LIKE 'live-chat-handoff:%'").get(),undefined);
      recoveryWatch.start();
      assert.equal(recovered().length,1);
      assert.ok(await recoveryWatch.pauseForHistoricalSync(todayFile));
      const partial=line('입장료 137 Seed를 지불하였습니다.','22시 30분 02초');
      const split=partial.indexOf('</br>');
      assert.ok(split>0);
      fs.appendFileSync(todayFile,partial.slice(0,split));
      recoveryWatch.stop(true);
      assert.ok(store.database.prepare("SELECT 1 FROM app_meta WHERE key LIKE 'live-chat-handoff:%'").get());
      fs.appendFileSync(todayFile,partial.slice(split));
      recoveryWatch.start();
      assert.equal(store.pending().filter((event:any)=>event.payload?.data?.amount===137).length,1);
    } finally {recoveryWatch.stop();}
    // 리뷰 P3: 실시간 줄 중 일지에 남지 않는 줄(정수 교환이 아닌 경험치·다른 사람의 획득)은 줄 귀속을 만들지 않는다.
    service.beginSession('retention-game');assert.equal((await service.select(a.id,replay)).success,true);
    const retentionDay=key(date(-8));parser.setCurrentDate(retentionDay);
    const owned=()=>store.database.prepare('SELECT COUNT(*) n FROM profile_log_line_owners WHERE log_date=?').get(retentionDay).n;
    const parseLive=(message:string,n:number)=>{
      const raw=line(message,`21시 00분 0${n}초`).trimEnd();
      withProfileLogSource({fingerprint:'live-retention',start:n*100,end:n*100+raw.length},()=>parser.parseLine(raw),raw);
    };
    parseLive('경험치가 57 올랐습니다.',1);parseLive('누군가 [테스트 보석]을 획득하였습니다.',2);
    assert.equal(owned(),0,'기록 없는 실시간 줄은 귀속 행을 만들지 않는다');
    assert.ok(store.database.prepare("SELECT 1 FROM pending_profile_events WHERE event_id GLOB 'live-line:*:XP_CHANGED:*' AND resolved_at IS NOT NULL").get(),
      '재파싱 중복 방지용 대기 원문은 30일 동안 유지');
    parseLive('[테스트 보석] 아이템을 획득하였습니다.',3);
    assert.equal(owned(),1,'기록 줄은 복원 중복 방지용 귀속을 유지');
    assert.equal(scope(a.id,date(-8)),1);
    parser.setCurrentDate(key(date(0)));
    console.log('PASS profile log restore: actual worker, owner/range isolation, legacy NULL aggregates, checkpoint rollback, retries, queued session records and real settings UI');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();controller.dispose();prepared.stopClock();config.flushPending();
  }
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
