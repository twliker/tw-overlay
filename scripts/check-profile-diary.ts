/** 실제 공유 SQLite 연결의 기록 귀속·합계·복구·중복 방지 검사. 실제 사용자 폴더는 사용하지 않는다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app} from 'electron';

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-diary-'));
app.setPath('userData',fixture);
const root=path.resolve(__dirname,'..');
const built=(file:string) => require(path.join(root,'dist',file));

async function run():Promise<void> {
  await app.whenReady();
  const diary=built('modules/diaryDb');
  const config=built('modules/config');
  const {DEFAULT_CONFIG}=built('modules/constants');
  const {ApplicationData}=built('modules/applicationData');
  const date='2026-11-02',historyDate='2026-11-03';
  const legacy={...structuredClone(DEFAULT_CONFIG),userServer:7,characterPresets:[{id:'A',name:'사냥용'},{id:'B',name:'거래용'}],selectedCharacterId:'A'};
  assert.equal(config.saveConfirmed(legacy),true);
  diary.initDb();
  assert.ok(diary.addManualActivityLog(date,'09:00:00','calc','기존 수익',400));
  assert.ok(diary.addManualActivityLog(date,'09:01:00','calc','기존 지출',-50));
  assert.equal(diary.addMagicStoneDaily(date,'09:02:00','상급',2),true);
  assert.equal(diary.addHomeworkLog(date,'same-homework','기존 숙제','일일','daily',1000),true);
  assert.equal(diary.updateHomeworkStats(date,1,10,0,3),true);
  assert.equal(diary.closeDb(),true);
  const original=fs.readFileSync(path.join(fixture,'diary.db'));
  const store=await ApplicationData.initialize({directory:fixture,deviceId:'PC-diary',defaults:DEFAULT_CONFIG},legacy);
  diary.connectApplicationData(store);
  assert.equal(diary.getStmt('PRAGMA database_list').all()[0].file,store.filePath,'일지와 프로필은 같은 파일/연결');
  const [a,b]=[store.list().find((p:any) => p.name==='사냥용'),store.list().find((p:any) => p.name==='거래용')];
  const fa={kind:'profile',profileId:a.id},fb={kind:'profile',profileId:b.id},unassigned={kind:'unassigned'};
  for (const [id,keyword] of [[a.id,'A 품목'],[b.id,'B 품목']]) {
    const projection=store.project(id,legacy);
    store.saveProjection(id,{...projection,lootKeywords:[keyword,'상급 마정석']});
  }
  const seed=(day:string,filter:any) => diary.getDiaryByDate(day,undefined,filter).activityLogs.filter((row:any) => row.type==='calc').reduce((sum:number,row:any) => sum+row.amount,0);
  const owner=(id:string,session:string,write:() => void) => store.withRecordContext(id,session,write);
  const count=() => store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n;
  const diaryOutboxBefore=count();
  assert.equal(seed(date,unassigned),350,'기존 기록은 미배정으로 보존');
  assert.equal(seed(date,fa),0,'현재 선택으로 과거 기록을 추정하지 않음');
  const daysBefore=store.database.prepare('SELECT COUNT(*) n FROM diaries').get().n;
  diary.getDiaryByDate('2099-12-31',undefined,fb);
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM diaries').get().n,daysBefore,'조회는 빈 날짜를 DB에 쓰지 않음');
  owner(a.id,'A-session',() => {
    assert.ok(diary.addManualActivityLog(date,'10:00:00','calc','수익',1000));
    assert.equal(diary.addActivityLog(date,'10:01:00','calc','[자동] 입장료',-100),true);
    assert.equal(diary.addActivityLog(date,'10:02:00','boss','[보스 처치] 공통 보스'),true);
    diary.addGoldPouchSeed(date,'10:03:00',500);diary.addElsoPoints(date,'10:04:00',11);
    assert.equal(diary.addMagicStoneDaily(date,'10:05:00','상급',3),true);
    assert.equal(diary.addActivityLog(date,'10:06:00','loot','[득템] [A 품목]',1),true);
    assert.equal(diary.addHomeworkLog(date,'same-homework','프로필 숙제','일일','daily',2000),true);
    assert.equal(diary.addHomeworkLog(date,'same-homework','프로필 숙제','일일','daily',3000),true);
    diary.updateHomeworkStats(date,2,3,1,4);
  });
  owner(b.id,'B-session',() => {
    assert.ok(diary.addManualActivityLog(date,'11:00:00','calc','수익',500));
    assert.equal(diary.addActivityLog(date,'11:01:00','calc','[자동] 입장료',-50),true);
    assert.equal(diary.addActivityLog(date,'11:02:00','boss','[보스 처치] 공통 보스'),true,'다른 프로필의 같은 보스 허용');
    diary.addGoldPouchSeed(date,'11:03:00',1000);diary.addElsoPoints(date,'11:04:00',22);
    assert.equal(diary.addMagicStoneDaily(date,'11:05:00','상급',4),true);
    assert.equal(diary.addActivityLog(date,'11:06:00','loot','[득템] [B 품목]',1),true);
    assert.equal(diary.addHomeworkLog(date,'same-homework','프로필 숙제','일일','daily',4000),true);
    diary.updateHomeworkStats(date,1,4,2,5);
  });
  store.setRecordContext(b.id,'B-session');
  assert.equal(seed(date,fa),1400,'A의 아직 저장되지 않은 금화 포함');
  assert.equal(seed(date,fb),1450,'B의 아직 저장되지 않은 금화 포함');
  assert.equal(seed(date,unassigned),350);
  assert.equal(seed(date,{kind:'all'}),3200,'같은 종류의 대기 금액을 프로필 수만큼 중복 합산하지 않음');
  assert.equal(diary.getDiaryByDate(date,undefined,fa).homeworkLogs.length,1);
  assert.equal(diary.getDiaryByDate(date).homeworkLogs.length,3,'같은 숙제 ID가 프로필별로 공존');
  assert.equal(diary.getDiaryByDate(date).diary.daily_done,4);
  assert.equal(diary.getDiaryByDate(date).diary.daily_total,17);
  assert.equal(diary.getDiaryByDate(date,undefined,fa).diary.daily_total,3);
  assert.equal(diary.flushPendingElso(),true);assert.equal(diary.flushPendingGoldPouchSeed(),true);
  assert.equal(seed(date,fa),1400);assert.equal(seed(date,fb),1450);
  const goldUuid=store.database.prepare('SELECT record_uuid FROM activity_logs WHERE profile_id=? AND content=?').get(a.id,diary.GOLD_POUCH_DAILY_CONTENT).record_uuid;
  owner(a.id,'A-next-session',() => {diary.addGoldPouchSeed(date,'12:00:00',200);diary.addElsoPoints(date,'12:01:00',5);});
  store.setRecordContext(b.id,'B-session');
  assert.equal(diary.flushPendingGoldPouchSeed(),true);assert.equal(diary.flushPendingElso(),true);
  const merged=store.database.prepare('SELECT * FROM activity_logs WHERE profile_id=? AND content=?').get(a.id,diary.GOLD_POUCH_DAILY_CONTENT);
  assert.equal(merged.amount,700);assert.equal(merged.record_uuid,goldUuid);assert.equal(merged.record_session_id,null,'복수 세션 합산 행은 하나의 세션이라고 오인시키지 않음');
  const stone=(filter:any) => diary.getDiaryByDate(date,undefined,filter).activityLogs.filter((row:any) => row.content.includes('상급 마정석')).reduce((n:number,row:any) => n+row.amount,0);
  assert.equal(stone(fa),3);assert.equal(stone(fb),4);assert.equal(stone(unassigned),2);
  assert.ok(diary.getDiaryByDate(date,['A 품목']).activityLogs.find((row:any) => row.content.includes('B 품목')),'전체 조회에서 B 품목에 A 프로필 키워드를 적용하지 않음');
  assert.ok(diary.getLootHistory(date,date,['A 품목']).find((row:any) => row.content.includes('B 품목')));
  assert.ok(diary.getMonthlySummary('2026-11',['A 품목']).lootList.find((row:any) => row.content.includes('B 품목')));
  assert.ok(diary.getDiaryExportSnapshot(date,date,['A 품목']).rows.find((row:any) => row.content.includes('B 품목')));

  // flush 실패 뒤 선택이 달라져도 journal의 원래 귀속을 유지한다.
  owner(a.id,'A-recovery',() => diary.addGoldPouchSeed(date,'13:00:00',250));
  store.setRecordContext(b.id,'B-session');
  store.database.exec(`CREATE TRIGGER reject_gold BEFORE UPDATE ON activity_logs WHEN NEW.content='${diary.GOLD_POUCH_DAILY_CONTENT}' BEGIN SELECT RAISE(ABORT,'fixture gold failure'); END;`);
  assert.equal(diary.flushPendingGoldPouchSeed(),false);
  assert.throws(() => diary.getMonthlySummary('2026-11',undefined,fa),/금액을 저장하지 못했습니다/,'실패한 금액을 뺀 합계를 정상 결과로 표시하지 않음');
  assert.throws(() => diary.getMonthlyStatistics('2026-11',undefined,fb),/금액을 저장하지 못했습니다/);
  assert.throws(() => diary.getDiaryExportSnapshot(date,date,[],fa),/기록을 읽지 못했습니다/);
  const journalPath=diary.getGoldPouchRecoveryJournalPath();
  const journal=fs.readFileSync(journalPath,'utf8');
  assert.equal(JSON.parse(journal).schemaVersion,2);assert.equal(JSON.parse(journal).entries[0].profileId,a.id);
  assert.equal(diary.closeDb(),false,'flush 실패 시 열린 연결을 유지해 재시도 가능');
  assert.equal(store.database.open,true);
  store.database.exec('DROP TRIGGER reject_gold');
  assert.equal(diary.closeDb(),true);assert.equal(store.database.open,false);
  fs.writeFileSync(journalPath,journal); // DB commit 후 파일 정리만 실패한 재시작
  diary.initDb();
  assert.equal(seed(date,fa),1850,'재시작/재연결 후 원래 프로필에 정확히 한 번');
  assert.equal(seed(date,fb),1450);
  assert.equal(diary.getStmt('PRAGMA database_list').all()[0].file,store.filePath,'재연결이 원본 diary.db로 돌아가지 않음');
  fs.writeFileSync(journalPath,JSON.stringify({schemaVersion:1,operationId:'legacy-gold-operation',createdAt:1,entries:[{date,latestTime:'13:01:00',totalAmount:30}]}));
  assert.equal(diary.replayGoldPouchRecoveryJournal(),true);
  assert.equal(seed(date,unassigned),380,'소유자 없는 구버전 journal도 현재 프로필로 추정하지 않음');
  fs.writeFileSync(diary.getElsoRecoveryJournalPath(),JSON.stringify({schemaVersion:1,operationId:'legacy-elso-operation',createdAt:1,entries:[{date,latestTime:'13:02:00',totalAmount:30}]}));
  assert.equal(diary.replayElsoRecoveryJournal(),true);

  const batch=(entries:any[],replace?:string) => ({loots:[],essences:[],seeds:entries,elsoPoints:[],shouts:[],replaceAutomaticDate:replace});
  const historySeed={eventId:'source-line-A',date:historyDate,timeOnly:'14:00:00',content:'[자동] 기록 A',amount:10};
  owner(a.id,'A-history',() => {
    assert.equal(diary.batchInsertSyncResults(batch([historySeed])).success,true);
    assert.ok(diary.addManualActivityLog(historyDate,'14:01:00','calc','직접 기록',5));
    assert.equal(diary.upsertSyncedHomeworkLogs([{date:historyDate,contentId:'sync-homework',contentName:'복원 숙제',category:'주간',type:'weekly',completedAt:1000}]).success,true);
  });
  owner(b.id,'B-history',() => {
    assert.equal(diary.batchInsertSyncResults(batch([historySeed])).seedsAdded,0,'같은 source ID를 다른 프로필로 중복 복원하지 않음');
    assert.equal(diary.batchInsertSyncResults(batch([{...historySeed,eventId:'source-line-B',content:'[자동] 기록 B',amount:20}])).success,true);
    assert.ok(diary.addManualActivityLog(historyDate,'14:02:00','calc','직접 기록',-2));
    assert.equal(diary.upsertSyncedHomeworkLogs([{date:historyDate,contentId:'sync-homework',contentName:'복원 숙제',category:'주간',type:'weekly',completedAt:2000}]).success,true);
  });
  owner(a.id,'A-history',() => {
    assert.equal(diary.batchInsertSyncResults(batch([historySeed],historyDate)).success,true);
    assert.equal(diary.upsertSyncedHomeworkLogs([],[historyDate]).success,true);
  });
  assert.equal(seed(historyDate,fa),15);assert.equal(seed(historyDate,fb),18,'A 재구성이 B의 자동/수동 원본 보존');
  assert.equal(diary.getDiaryByDate(historyDate,undefined,fb).homeworkLogs.length,1,'숙제 재구성도 다른 프로필 보존');
  owner(a.id,'A-toggle',() => diary.removeHomeworkLog(date,'same-homework'));
  assert.equal(diary.getDiaryByDate(date,undefined,fb).homeworkLogs.length,1);
  assert.equal(diary.getDiaryByDate(date,undefined,unassigned).homeworkLogs.length,1);
  owner(a.id,'A-toggle',() => diary.removeActivityLog(date,'boss','[보스 처치] 공통 보스'));
  assert.equal(diary.getDiaryByDate(date,undefined,fb).activityLogs.filter((row:any) => row.type==='boss').length,1);

  const alarmTime=Date.now();
  for (const id of [a.id,a.id,b.id]) owner(id,'alarm',() => assert.equal(diary.addAlarmLog('buff','공통 알림','내용',{recordedAt:alarmTime,dedupeKey:'same-alarm'}),true));
  assert.equal(diary.getAlarmLogs(10,fa).length,1);assert.equal(diary.getAlarmLogs(1,fb).length,1,'필터는 LIMIT보다 먼저 적용');
  const timer={date,duration:1000,title:'측정',series:'stab',core_master:'none',coefficient:1,char_main:1,char_sub:1,base_main:1,enchant_main:1,base_sub:1,enchant_sub:1,accuracy:1,raw_profile_data:'{}'};
  for (const id of [a.id,b.id]) owner(id,'timer',() => assert.equal(diary.addTimerRecord(timer),true));
  assert.equal(diary.getTimerRecords(fa).length,1);assert.equal(diary.getTimerRecords(fb).length,1);
  const aggregateDate='2026-10-01';
  const aggregateBatch=(amount:number) => ({...batch([]),
    loots:[{eventId:'file-A-stone',date:aggregateDate,timeOnly:'14:00:00',diaryContent:'[득템] [상급 마정석]',count:amount}],
    elsoPoints:[{eventId:'file-A-elso',date:aggregateDate,timeOnly:'14:00:00',amount}],
    goldPouchSeeds:[{eventId:'file-A-gold',date:aggregateDate,timeOnly:'14:00:00',amount}]});
  owner(a.id,'aggregate-A',() => {
    assert.equal(diary.batchInsertSyncResults(aggregateBatch(60)).success,true);
    assert.equal(diary.batchInsertSyncResults(aggregateBatch(80)).success,true);
  });
  owner(b.id,'aggregate-B',() => assert.equal(diary.batchInsertSyncResults(aggregateBatch(80)).success,true));
  assert.equal(seed(aggregateDate,fa),80,'동일 원본 합계 갱신은 같은 프로필에서 멱등');
  assert.equal(seed(aggregateDate,fb),0,'금화/엘소/마정석 집계 ID도 다른 프로필로 중복 복원하지 않음');
  assert.equal(diary.getDiaryByDate(aggregateDate,undefined,fb).activityLogs.length,0);
  store.database.transaction(() => assert.equal(diary.closeDb(),false,'외부 기록 transaction 중 연결을 닫지 않음'))();
  assert.equal(count(),diaryOutboxBefore,'모험일지/알람/타이머는 Google 변경 이력을 만들지 않음');

  const beforeTransaction=seed(date,fb);
  assert.throws(() => owner(b.id,'transaction',() => store.database.transaction(() => {
    diary.addActivityLog(date,'15:00:00','calc','rollback fee',-999);
    diary.addGoldPouchSeed(date,'15:01:00',999);diary.addElsoPoints(date,'15:02:00',999);
    throw new Error('fixture rollback');
  })()),/fixture rollback/);
  assert.equal(seed(date,fb),beforeTransaction,'이벤트 transaction의 금화/일지 함께 rollback');
  assert.equal(diary.hasPendingGoldPouchSeed(),false);assert.equal(diary.hasPendingElso(),false,'rollback된 이벤트를 버퍼에서 나중에 쓰지 않음');

  owner(a.id,'deleted-profile',() => diary.addGoldPouchSeed(date,'16:00:00',300));
  store.setRecordContext(b.id,'B-session');store.remove(a.id);
  assert.equal(diary.flushPendingGoldPouchSeed(),true);
  assert.equal(seed(date,fa),2150,'삭제 전 발생한 버퍼는 삭제된 프로필 귀속으로 보존');
  assert.ok(store.list(true).find((p:any) => p.id===a.id).deletedAt);

  config.installPersistence({read:(value:any) => store.readConfiguration(value),commit:(value:any,previous:any) => store.commitConfiguration(value,previous)});
  const {ProfileService}=built('modules/profileService');
  const service=new ProfileService(store,config);
  const session=service.beginSession('fixture-game').sessionId;
  const apply=(payload:any) => {diary.addActivityLog(date,'17:00:00','calc','pending fee',payload.amount);};
  service.dispatch({amount:-25},apply,1000,'pending-diary-fee');
  store.database.exec("CREATE TRIGGER reject_pending BEFORE INSERT ON activity_logs WHEN NEW.content='pending fee' BEGIN SELECT RAISE(ABORT,'fixture pending failure'); END;");
  const failed=await service.select(b.id,apply);
  assert.equal(failed.success,true);assert.match(failed.error,/대기 기록/);
  assert.equal(store.pending(session).length,1,'DB 쓰기 실패를 무시해 대기 이벤트를 ACK하지 않음');
  store.database.exec('DROP TRIGGER reject_pending');
  assert.equal((await service.select(b.id,apply)).success,true);assert.equal(store.pending(session).length,0);
  assert.equal(seed(date,fb),1425);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE content='pending fee'").get().n,1);

  assert.equal(diary.getMonthlySummary('2026-11',undefined,fa).totalSeed,2165);
  assert.equal(diary.getMonthlySummary('2026-11',undefined,fb).totalSeed,1443);
  assert.equal(diary.getMonthlySummary('2026-11',undefined,unassigned).totalSeed,380);
  assert.equal(diary.getMonthlySummary('2026-11').totalSeed,3988);
  for (const [filter,expected] of [[fa,2165],[fb,1443],[unassigned,380],[{kind:'all'},3988]] as const) {
    assert.equal(diary.getMonthlyStatistics('2026-11',undefined,filter).totalSeed,expected);
    assert.equal(diary.getMonthlyRevenueData('2026-11',filter).reduce((sum:number,row:any) => sum+row.amount,0),expected);
    assert.equal(diary.getDiaryExportSnapshot(date,historyDate,[],filter).totalSeed,expected);
  }
  assert.equal(diary.getMonthlyStatistics('2026-11',undefined,fa).totalElso,16);
  assert.equal(diary.getMonthlyStatistics('2026-11',undefined,fb).totalElso,22);
  assert.equal(diary.getMonthlyStatistics('2026-11',undefined,unassigned).totalElso,30);
  assert.equal(diary.getDiariesByMonth('2026-11',10,fb).find((row:any) => row.date===historyDate).weekly_done>=1,true);
  diary.cleanOldDiaryData(14);
  assert.equal(diary.getDiaryByDate(aggregateDate).activityLogs.length,0,'보존 기간 정리는 프로필별 날짜 요약도 함께 정리');
  assert.equal(store.database.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(store.database.pragma('foreign_key_check'),[]);
  assert.equal(diary.closeDb(),true);
  assert.deepEqual(fs.readFileSync(path.join(fixture,'diary.db')),original,'공유 저장/재연결은 원래 diary.db를 변경하지 않음');
  console.log('PASS profile diary: shared connection, original preservation, attribution/aggregates, pending/recovery/restart, source dedup/rebuild, deleted profiles, rollback/ACK, filtered totals/export.');
}

run().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
