/** 실제 3.2.2의 저장 API가 만든 임시 데이터를 새 프로필 저장소로 이전한다.
 * 이전 버전 코드는 설치 패키지(app.asar) 또는 git 태그로 만든 빌드 폴더(`npm run test:profile-upgrade`가
 * prepare-upgrade-baseline으로 준비)를 `--old-archive`로 받는다. 손으로 만든 목업이 아니라 v3.2.2 코드가 쓴
 * 설정 파일·diary.db·렌더러 저장소를 입력으로 쓴다.
 * 설치 프로그램 실행/레지스트리 변경이나 실제 사용자 폴더 접근은 하지 않는다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {createHash} from 'node:crypto';
import {app,BrowserWindow,session} from 'electron';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
// 지정이 없으면 추출한 설치본(app.asar)을, 없으면 git 태그 빌드(prepare-upgrade-baseline 결과)를 쓴다.
const installedArchive=path.join(root,'output/profile-upgrade-old/app/resources/app.asar');
const taggedBaseline=path.join(root,'output/profile-upgrade-baseline/v3.2.2');
const oldArchive=path.resolve(argument('--old-archive') || ((require('original-fs') as typeof fs).existsSync(installedArchive) ? installedArchive : taggedBaseline));
if (!(require('original-fs') as typeof fs).existsSync(oldArchive)) {
  throw new Error(`3.2.2 코드가 없습니다: ${oldArchive}\n먼저 node dist-tools/prepare-upgrade-baseline.js 로 git 태그 빌드를 준비하세요.`);
}
const newRoot=path.resolve(argument('--new-root') || path.join(root,'dist'));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-upgrade-')),data=path.join(fixture,'appData/twOverlay');
fs.mkdirSync(data,{recursive:true});app.setPath('appData',path.dirname(data));app.setPath('userData',data);app.on('window-all-closed',()=>{});
const old=(name:string)=>require(path.join(oldArchive,'dist',name+'.js'));
const current=(name:string)=>require(path.join(newRoot,name+'.js'));
const hash=(file:string)=>createHash('sha256').update((require('original-fs') as typeof fs).readFileSync(file)).digest('hex');

async function run():Promise<void> {
  await app.whenReady();
  assert.equal(require(path.join(oldArchive,'package.json')).version,'3.2.2');
  const oldConfig=old('modules/config'),oldDiary=old('modules/diaryDb'),defaults=old('modules/constants').DEFAULT_CONFIG;
  const today=new Date(),date=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
  const homework={id:'custom-release-upgrade',name:'이전할 숙제',category:'주간',isVisible:true,isCustom:true,maxCount:3,
    resetRule:{type:'weekly',dayOfWeek:0,hour:6},completedState:{
      A:{currentCount:1,isCompleted:false,lastCompletedAt:Date.now()},
      B:{currentCount:2,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()},
      C:{currentCount:3,isCompleted:true,lastCompletedAt:Date.now()},
    }};
  const expired={...structuredClone(homework),id:'custom-release-expired',completedState:{
    A:{currentCount:3,isCompleted:true,lastCompletedAt:Date.now()-8*86400000},
    B:{currentCount:3,isCompleted:true,lastCompletedAt:Date.now()-8*86400000},
    C:{currentCount:3,isCompleted:true,lastCompletedAt:Date.now()-8*86400000},
  }};
  const legacy={...structuredClone(defaults),analyticsEnabled:false,autoUpdateEnabled:false,userServer:7,
    pinnedNoteText:'3.2.2 사용자 메모',buffTimerEnabled:false,xpAutoStart:false,volumeContentsChecker:0,
    sidebarPosition:'dock-top',hiddenMenuIds:['stopwatch-btn'],xpWidgetPos:{left:38,bottom:68},
    pinnedNoteFontSize:22,pinnedNoteBackground:false,lootKeywords:['이전 득템','하급 마정석'],tradeKeywords:['이전 거래'],
    xpAutoPauseSeconds:180,buffTimerWarnSeconds:[25,70],
    characterPresets:[{id:'A',name:'이전 A'},{id:'B',name:'이전 B'},{id:'C',name:'이전 C'}],selectedCharacterId:'B',contentsCheckerItems:[homework,expired],pendingHomeworks:[]};
  assert.equal(oldConfig.saveConfirmed(legacy),true);
  oldDiary.initDb();
  assert.ok(oldDiary.addManualActivityLog(date,'09:00:00','calc','이전 수익',400));
  assert.ok(oldDiary.addManualActivityLog(date,'09:01:00','calc','이전 지출',-50));
  assert.equal(oldDiary.addActivityLog(date,'09:02:00','loot','이전 득템',1),true);
  assert.equal(oldDiary.addHomeworkLog(date,homework.id,homework.name,'주간','weekly',Date.now()),true);
  const legacyCompletion=homework.completedState.C.lastCompletedAt;
  assert.equal(oldDiary.addHomeworkLog(date,`${homework.id}_C`,'[이전 C] 이전할 숙제','주간','weekly',legacyCompletion),true);
  oldDiary.addGoldPouchSeed(date,'09:03:00',500000);
  assert.equal(oldDiary.flushPendingGoldPouchSeed(),true);
  const oldParser=old('modules/chatParser').chatParser;
  old('modules/chatLogProcessor').chatLogProcessor.start();oldParser.setCurrentDate(date);
  const logLine=(time:string,message:string)=>`<font size="2" color="white"> [${time}] </font><font size="2" color="#ff64ff">${message}</font></br>\r\n`;
  const seedLine=logLine('09시 04분 00초','콘텐츠 클리어 보상으로 509 SEED를 획득했습니다.');
  const lootLine=logLine('09시 05분 00초','[이전 득템] 아이템을 획득하였습니다.');
  // v3.2.2 실시간 엘소·마정석 일합계도 복원과 겹친다(엘소 3P, 하급 마정석 2개).
  const elsoLine=logLine('09시 07분 00초','[엘소 스크롤 (1 포인트)]을(를) [3]개 획득하였습니다.');
  const stoneLine=logLine('09시 08분 00초','하급 마정석 2개를 획득 하였습니다.');
  // 구버전은 이 로그를 실시간 획득으로 처리한다. 알림 요청은 검증하고 Windows에는 보내지 않는다.
  const oldNotifications=old('modules/desktopNotification'),showNotification=oldNotifications.showSupportedDesktopNotification;
  const notices:Array<{title:string;loot?:{itemName:string;count:number}}> = [];
  oldNotifications.showSupportedDesktopNotification=(title:string,_body:string,loot?:{itemName:string;count:number})=>{
    notices.push({title,loot});
  };
  try {oldParser.parseLine(seedLine);oldParser.parseLine(lootLine);oldParser.parseLine(elsoLine);oldParser.parseLine(stoneLine);}
  finally {oldNotifications.showSupportedDesktopNotification=showNotification;}
  assert.deepEqual(notices,[{title:'아이템 획득 알림',loot:{itemName:'이전 득템',count:1}}]);
  assert.equal(oldDiary.getStmt("SELECT count(*) n FROM activity_logs WHERE time IN ('09:04:00','09:05:00')").get().n,2);
  assert.equal(oldDiary.flushPendingElso(),true);
  assert.deepEqual(oldDiary.getStmt("SELECT type,amount FROM activity_logs WHERE time IN ('09:07:00','09:08:00') ORDER BY time").all(),[{type:'elso',amount:3},{type:'loot',amount:2}]);
  assert.equal(oldDiary.updateHomeworkStats(date,4,66,5,42),true);
  const before=oldDiary.getStmt('SELECT date,time,type,content,amount,source FROM activity_logs ORDER BY id').all();
  assert.equal(oldDiary.closeDb(),true);
  const sourceHash=hash(path.join(data,'diary.db'));
  const key='tw-coefficient-calculator-settings-v7final',toolValue=JSON.stringify({character:'release-fixture',attack:321});
  const writeToolValue=async (value:string)=>{
    const bridge=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
    try {
      await bridge.loadFile(path.join(oldArchive,'dist/storage-bridge.html'));
      await bridge.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(value)})`);
      session.defaultSession.flushStorageData();
    } finally {bridge.destroy();}
  };
  await writeToolValue(toolValue);

  const application=current('modules/profileApplication'),config=current('modules/config');
  const clock=new (current('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline fixture');});
  const controller=await application.startProfileApplication(()=>{},clock),{service,replay}=controller.runtime,store=service.store;
  const profiles=store.list();assert.equal(profiles.length,3,'기본 프로필을 별도로 더하지 않는다.');
  const a=profiles.find((item:any)=>item.name==='이전 A'),b=profiles.find((item:any)=>item.name==='이전 B'),c=profiles.find((item:any)=>item.name==='이전 C');assert.ok(a && b && c);
  assert.equal(b.id,'profile-default','기존 선택 캐릭터가 기본 프로필을 사용한다.');
  assert.deepEqual(store.database.prepare('SELECT character_id,profile_id FROM legacy_character_profiles ORDER BY character_id').all(),
    [{character_id:'A',profile_id:a.id},{character_id:'B',profile_id:b.id},{character_id:'C',profile_id:c.id}]);
  for(const profile of profiles) {
    assert.equal(profile.userServer,7);
    const projection=store.project(profile.id,config.load());
    assert.equal(projection.pinnedNoteText,legacy.pinnedNoteText);assert.equal(projection.buffTimerEnabled,false);
    assert.equal(projection.xpAutoStart,false);assert.equal(projection.volumeContentsChecker,0);
    for(const key of ['sidebarPosition','hiddenMenuIds','xpWidgetPos','pinnedNoteFontSize','pinnedNoteBackground','lootKeywords','tradeKeywords','xpAutoPauseSeconds','buffTimerWarnSeconds'] as const) {
      assert.deepEqual(projection[key],legacy[key],`3.2.2 사용자 설정 보존: ${key}`);
    }
    assert.equal(store.toolValues(profile.id)[key],toolValue,'기존 file-origin 계산기 입력을 각 프로필에 복사한다.');
    assert.equal(store.homework(profile.id).find((item:any)=>item.id===expired.id).completedState[profile.id].currentCount,0,'이전 준비의 지난 주기 초기화는 유지한다.');
  }
  assert.deepEqual(store.homework(a.id).find((item:any)=>item.id===homework.id).completedState[a.id],homework.completedState.A);
  assert.deepEqual(store.homework(b.id).find((item:any)=>item.id===homework.id).completedState[b.id],homework.completedState.B);
  assert.deepEqual(store.homework(c.id).find((item:any)=>item.id===homework.id).completedState[c.id],homework.completedState.C);
  assert.deepEqual(store.database.prepare('SELECT date,time,type,content,amount,source FROM activity_logs ORDER BY id').all(),before);
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE profile_id IS NOT NULL').get().n,0,'과거 일지는 임의 귀속하지 않는다.');
  const currentDiary=current('modules/diaryDb');
  assert.equal(currentDiary.getDiaryByDate(date).diary.daily_total,66);
  assert.equal(currentDiary.getDiaryByDate(date).diary.weekly_total,42);
  assert.equal(hash(path.join(data,'diary.db')),sourceHash,'기존 DB 원본을 변경하지 않는다.');
  const backups=path.join(data,'backups');
  const preparation=fs.readdirSync(backups).find(name=>name.startsWith('before-profile-preparation-'));assert.ok(preparation);
  const manifest=current('modules/localSnapshot').verifyUserDataSnapshot(path.join(backups,preparation));
  assert.equal(hash(path.join(backups,preparation,'diary.db')),sourceHash,'이전 전 원본 백업을 검증한다.');
  assert.ok(manifest.entries.some((entry:any)=>entry.relativePath==='renderer-storage.json'));
  const rendererBackup=JSON.parse(fs.readFileSync(path.join(backups,preparation,'renderer-storage.json'),'utf8'));
  assert.equal(rendererBackup.values[key],toolValue,'v3.2.2 폴더로 복사할 이전 백업에도 계산기 입력을 포함한다.');
  const oldRendererStorage=old('modules/rendererStorageBackup');
  await writeToolValue('다른 사용자 폴더의 값');
  const rollbackFile=path.join(data,'renderer-storage.json');
  fs.copyFileSync(path.join(backups,preparation,'renderer-storage.json'),rollbackFile);
  await oldRendererStorage.restoreRendererStorageOnStartup();
  assert.equal((await oldRendererStorage.readRendererStorage([key]))[key],toolValue,'v3.2.2의 시작 복원 경로로 백업을 실제로 읽는다.');
  assert.equal(fs.existsSync(rollbackFile),false,'정상 복원된 파일은 한 번만 적용한다.');
  controller.runtime.onGameState('running');assert.equal(service.status().selectionRequired,true);
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal(currentDiary.getDiaryByDate(date).diary.daily_total,66,'일부 프로필을 선택해도 이전 합계를 중복 집계하지 않는다.');
  assert.equal(config.saveConfirmed({pinnedNoteText:'이전 후 A 변경'}),true);
  assert.equal(store.project(b.id,config.load()).pinnedNoteText,legacy.pinnedNoteText);
  assert.equal(service.update(b.id,'이전 B',16).success,true);
  assert.equal((await service.select(b.id,replay)).success,true);assert.equal(config.load().userServer,16);
  assert.equal(currentDiary.getDiaryByDate(date).diary.daily_total,66,'매핑된 프로필 3개 중 두 개로는 이전 합계를 교체하지 않는다.');
  for (const profile of [a,b,c]) store.withRecordContext(profile.id,null,()=>currentDiary.updateHomeworkStats(date,3,14,2,10));
  assert.equal(currentDiary.getDiaryByDate(date).diary.daily_total,42);
  assert.equal(currentDiary.getDiaryByDate(date).diary.weekly_total,30);
  assert.equal(currentDiary.getDiariesByMonth(date.slice(0,7)).find((row:any)=>row.date===date)?.weekly_total,30);
  const contents=current('modules/contentsChecker');
  assert.equal((await service.select(c.id,replay)).success,true);
  contents.toggleItem(homework.id,c.id);
  assert.equal(store.homework(c.id).find((item:any)=>item.id===homework.id).completedState[c.id].isCompleted,false);
  assert.equal(currentDiary.getDiaryByDate(date).homeworkLogs.some((row:any)=>row.content_id===`${homework.id}_C`),false,
    '현재 주기의 이전된 완료를 취소하면 원래 완료 행도 일지에서 빠진다.');
  assert.equal(currentDiary.getDiaryByDate(date).homeworkLogs.some((row:any)=>row.content_id===homework.id),true,
    '캐릭터 귀속을 확인할 수 없는 일지 기록은 보존한다.');
  const cancelled=currentDiary.getHomeworkReplayExclusions(c.id)[homework.id];
  assert.equal(cancelled.length,1);
  assert.ok(cancelled[0].start<=legacyCompletion && legacyCompletion<=cancelled[0].end);
  assert.equal(currentDiary.getHomeworkReplayExclusions(b.id)[homework.id],undefined);
  contents.toggleItem(homework.id,c.id);
  assert.equal(currentDiary.getDiaryByDate(date).homeworkLogs.filter((row:any)=>row.content_id===`${homework.id}_${c.id}`).length,1);
  contents.toggleExcludeItem(homework.id,c.id);
  assert.equal(currentDiary.getDiaryByDate(date).homeworkLogs.some((row:any)=>row.content_id===`${homework.id}_${c.id}`),false);
  assert.equal((await service.select(b.id,replay)).success,true);
  const diary=current('modules/diaryDb'),logs=path.join(fixture,'logs');
  fs.mkdirSync(logs);
  const logName=`TWChatLog_${date.replace(/-/g,'_')}.html`;
  fs.writeFileSync(path.join(logs,logName),'\ufeff'+logLine('09시 03분 00초','가짜 달여왕 군단의 군자금 [ 금화 주머니 1개 ]를 획득했습니다.')+seedLine+lootLine+elsoLine+stoneLine);
  assert.equal(config.saveConfirmed({chatLogPath:logs}),true);
  const day=new Date(date+'T00:00:00');
  const restored=await current('modules/chatLogSyncManager').syncWeeklyChatLogs({profileId:b.id,startDate:day,endDate:day});
  assert.equal(restored.success,true);
  const copied=path.join(fixture,'copied');fs.mkdirSync(copied);fs.copyFileSync(path.join(logs,logName),path.join(copied,logName));
  assert.equal(config.saveConfirmed({chatLogPath:copied}),true);
  assert.equal((await current('modules/chatLogSyncManager').syncWeeklyChatLogs({profileId:b.id,startDate:day,endDate:day,reanalyzeCompletedLogs:true})).success,true);
  fs.appendFileSync(path.join(copied,logName),logLine('09시 06분 00초','콘텐츠 클리어 보상으로 17 SEED를 획득했습니다.'));
  assert.equal((await current('modules/chatLogSyncManager').syncWeeklyChatLogs({profileId:b.id,startDate:day,endDate:day})).success,true);
  const daily=diary.getDiaryByDate(date),monthly=diary.getMonthlySummary(date.slice(0,7));
  assert.equal(daily.activityLogs.filter((row:any)=>row.amount===509).length,1);
  assert.equal(daily.activityLogs.filter((row:any)=>row.time==='09:05:00').length,1);
  const gold=daily.activityLogs.filter((row:any)=>row.content===diary.GOLD_POUCH_DAILY_CONTENT);
  assert.equal(gold.length,2,'원본과 복원 금액 모두 보존');
  assert.equal(gold.find((row:any)=>row.legacy_gold_review).amount,500000);
  assert.equal(monthly.totalSeed,500876);
  assert.equal(monthly.legacyGoldReviewSeed,500000);
  assert.equal(diary.getMonthlyStatistics(date.slice(0,7)).totalSeed,500876);
  assert.equal(diary.getMonthlyRevenueData(date.slice(0,7)).find((row:any)=>row.date===date).amount,500876);
  const exported=diary.getDiaryExportSnapshot(date,date,[]);
  assert.equal(exported.totalSeed,500876);
  assert.equal(exported.legacyGoldReviewSeed,500000);
  assert.equal(exported.rows.find((row:any)=>row.kind==='확인 필요').amount,500000);
  assert.match(current('modules/diaryExport').renderDiaryExport(exported),/확인 필요 금화 주머니 500,000 SEED/);
  // 엘소·마정석 구버전 일합계도 원본은 보존하고 '모든 프로필' 합계에는 복원 행만 센다.
  const review=daily.activityLogs.filter((row:any)=>row.legacy_review).map((row:any)=>[row.type,row.amount]).sort();
  assert.deepEqual(review,[['calc',500000],['elso',3],['loot',2]]);
  assert.equal(daily.activityLogs.filter((row:any)=>row.type==='elso' && !row.legacy_review).reduce((sum:number,row:any)=>sum+row.amount,0),3);
  assert.equal(diary.getMonthlyStatistics(date.slice(0,7)).totalElso,3);
  const stoneCount=(rows:any[])=>rows.filter((row:any)=>row.date===date && row.content.includes('마정석')).reduce((sum:number,row:any)=>sum+row.amount,0);
  assert.equal(stoneCount(monthly.calendarLootList),2);assert.equal(stoneCount(diary.getLootHistory(date,date,['하급 마정석'])),2);
  assert.equal(stoneCount(exported.rows.filter((row:any)=>row.kind==='득템')),2);
  assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
  // 처리 구간 끝 인덱스(변환·실시간 구간 쓰기의 앞 구간 찾기)는 v3.2.2에서 올라온 DB에도 만든다.
  assert.ok(store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_log_ranges_end'").get(),'v3.2.2 업그레이드: 구간 끝 인덱스');
  const output=path.join(root,'output/profile-upgrade');fs.mkdirSync(output,{recursive:true});
  // 이전 버전은 설치본 app.asar 또는 git 태그로 만든 빌드 폴더(prepare-upgrade-baseline)다. 폴더는 태그 커밋으로 식별한다.
  const originalFs=require('original-fs') as typeof fs,baselineMarker=path.join(oldArchive,'.baseline.json');
  const oldSource=originalFs.statSync(oldArchive).isDirectory()
    ? `git:${fs.existsSync(baselineMarker) ? JSON.parse(fs.readFileSync(baselineMarker,'utf8')).commit : 'unknown'}`
    : `asar-sha256:${hash(oldArchive)}`;
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({passed:true,oldVersion:'3.2.2',oldSource,
    newRoot,profiles:3,legacySourceUnchanged:true,backupVerified:true,settingsPreserved:true,homeworkPreserved:true,
    diaryPreserved:true,toolsPreserved:true,serverSwitch:true,installerExecuted:false},null,2));
  application.stopProfileApplication();controller.dispose();config.beginExternalRestore();current('modules/diaryDb').suspendForRestore();
  console.log('PASS profile release upgrade: actual 3.2.2 storage APIs -> profile storage, source/backup/settings/homework/diary/tools preserved');
}
run().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
