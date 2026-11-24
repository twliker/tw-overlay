/** 실제 공유 SQLite 연결의 기록 귀속·합계·복구·중복 방지 검사. 실제 사용자 폴더는 사용하지 않는다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app} from 'electron';
import Database = require('better-sqlite3');

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
  // v3.2.2가 남긴 복구 journal: 엘소는 DB 반영 뒤 파일 정리만 실패한 operation, 금화는 아직 미반영.
  const journalDate='2026-09-15';
  const legacyDb=new Database(path.join(fixture,'diary.db'));
  legacyDb.prepare('INSERT INTO elso_flush_operations(operation_id,committed_at) VALUES(?,?)').run('v322-elso-applied',1);
  // v3.2.2 알람 기록 upsert가 요구하는 unique 인덱스. 이전 전 initDb가 열면 삭제되므로 보존 여부를 확인한다.
  legacyDb.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_alarm_logs_dedupe_key_unique ON alarm_logs(dedupe_key) WHERE dedupe_key IS NOT NULL');
  legacyDb.close();
  const elsoJournal=JSON.stringify({schemaVersion:1,operationId:'v322-elso-applied',createdAt:1,entries:[{date:journalDate,latestTime:'08:00:00',totalAmount:40}]});
  const goldJournal=JSON.stringify({schemaVersion:1,operationId:'v322-gold-pending',createdAt:1,entries:[{date:journalDate,latestTime:'08:01:00',totalAmount:700}]});
  fs.writeFileSync(diary.getElsoRecoveryJournalPath(),elsoJournal);fs.writeFileSync(diary.getGoldPouchRecoveryJournalPath(),goldJournal);
  const original=fs.readFileSync(path.join(fixture,'diary.db'));
  // 이전 전 닫기와 실패 후 종료 flush는 journal 재생만을 위해 원본 diary.db를 열지 않는다.
  assert.equal(diary.closeDb(),true);
  assert.equal(diary.flushPendingElso(),true);assert.equal(diary.flushPendingGoldPouchSeed(),true);
  assert.deepEqual(fs.readFileSync(path.join(fixture,'diary.db')),original,'이전 전 journal 재생으로 원본 diary.db를 바꾸지 않음');
  assert.equal(fs.existsSync(path.join(fixture,'diary.db-wal')),false,'원본 diary.db를 열지 않음');
  assert.equal(fs.readFileSync(diary.getElsoRecoveryJournalPath(),'utf8'),elsoJournal,'journal은 이전 뒤 재생하도록 보존');
  assert.equal(fs.readFileSync(diary.getGoldPouchRecoveryJournalPath(),'utf8'),goldJournal);
  const store=await ApplicationData.initialize({directory:fixture,deviceId:'PC-diary',defaults:DEFAULT_CONFIG},legacy);
  // 이전 빌드의 복원이 구버전(캐릭터 A) 숙제 행과 겹치게 만든 프로필 복원 행은 연결 시 한 번 정리하고 구버전 행을 프로필로 옮긴다.
  const overlapDate='2026-08-20',hunter=store.list().find((p:any) => p.name==='사냥용');
  store.database.prepare('INSERT OR IGNORE INTO diaries(date) VALUES(?)').run(overlapDate);
  store.database.prepare('INSERT INTO diary_profile_days(date,profile_id,total_score) VALUES(?,NULL,10),(?,?,20)').run(overlapDate,overlapDate,hunter.id);
  const addHomeworkRow=store.database.prepare('INSERT INTO homework_logs(date,content_id,content_name,category,type,completed_at,source,profile_id) VALUES(?,?,?,?,?,?,?,?)');
  addHomeworkRow.run(overlapDate,'dup-homework_A','겹친 숙제','일일','daily',4000,'chat-log-sync',null);
  addHomeworkRow.run(overlapDate,`dup-homework_${hunter.id}`,'겹친 숙제','일일','daily',4000,'chat-log-sync',hunter.id);
  addHomeworkRow.run(overlapDate,`other-homework_${hunter.id}`,'다른 숙제','일일','daily',4000,'chat-log-sync',hunter.id);
  diary.connectApplicationData(store);
  assert.deepEqual(store.database.prepare('SELECT content_id,profile_id FROM homework_logs WHERE date=? ORDER BY id').all(overlapDate),
    [{content_id:`dup-homework_${hunter.id}`,profile_id:hunter.id},{content_id:`other-homework_${hunter.id}`,profile_id:hunter.id}],'겹친 복원 행을 정리하고 구버전 원본 행을 프로필로 옮김');
  assert.equal(store.database.prepare("SELECT source FROM homework_logs WHERE date=? AND content_id=?").get(overlapDate,`dup-homework_${hunter.id}`).source,'checklist','옮긴 구버전 행은 재분석이 지우지 않도록 보존 대상으로 둠');
  assert.equal(store.database.prepare('SELECT total_score FROM diary_profile_days WHERE date=? AND profile_id=?').get(overlapDate,hunter.id).total_score,20,'옮긴 숙제 점수는 프로필에 남음');
  assert.equal(store.database.prepare('SELECT total_score FROM diary_profile_days WHERE date=? AND profile_id IS NULL').get(overlapDate).total_score,0,'미배정 일자에서 옮긴 점수를 뺌');
  assert.equal(diary.getDiaryByDate(overlapDate).diary.total_score,20,'모든 프로필 일일 점수는 한 번만 집계');
  store.database.prepare('DELETE FROM homework_logs WHERE date=?').run(overlapDate);
  assert.equal(fs.existsSync(diary.getElsoRecoveryJournalPath()),false,'이전 뒤 연결에서 journal 재생 후 정리');
  assert.equal(fs.existsSync(diary.getGoldPouchRecoveryJournalPath()),false);
  const journalRows=()=>store.database.prepare("SELECT type,content,amount,profile_id FROM activity_logs WHERE date=? ORDER BY id").all(journalDate);
  assert.deepEqual(journalRows(),[{type:'calc',content:diary.GOLD_POUCH_DAILY_CONTENT,amount:700,profile_id:null}],
    '미반영 금화 journal은 app-data.db에 한 번, 이미 반영된 엘소 operation은 다시 더하지 않음');
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
  assert.equal(diary.getDiaryByDate(date).diary.daily_done,3);
  assert.equal(diary.getDiaryByDate(date).diary.daily_total,7,'프로필별 통계가 갖춰진 날짜는 이전 전체 분모를 다시 더하지 않는다.');
  assert.equal(diary.getDiaryByDate(date,undefined,unassigned).diary.daily_total,10,'미배정 조회에서는 이전 전체 분모를 보존한다.');
  assert.equal(diary.getDiaryByDate(date,undefined,fa).diary.daily_total,3);
  const monday='2026-11-16',tuesday='2026-11-17';
  owner(a.id,'weekly-a',()=>{
    assert.ok(diary.addHomeworkLog(monday,'weekly-1','주간 1','주간','weekly',1000));
    assert.ok(diary.addHomeworkLog(monday,'weekly-2','주간 2','주간','weekly',1100));
    assert.ok(diary.updateHomeworkStats(monday,0,0,2,2));
  });
  owner(b.id,'weekly-b',()=>{
    assert.ok(diary.addHomeworkLog(tuesday,'weekly-1','주간 1','주간','weekly',1200));
    assert.ok(diary.updateHomeworkStats(tuesday,0,0,1,1));
  });
  const weekly=(filter:any,days:string[])=>diary.getDiariesByMonth('2026-11',0,filter).filter((row:any)=>days.includes(row.date)).map((row:any)=>[row.weekly_done,row.weekly_total]);
  assert.deepEqual(weekly({kind:'all'},[monday,tuesday]),[[3,3],[3,3]]);
  assert.deepEqual(weekly(fa,[monday,tuesday]),[[2,2]]);
  assert.deepEqual(weekly(fb,[monday,tuesday]),[[1,1]]);
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
  // '상급'은 '최상급'에 포함되지만 같은 날의 다른 등급 행에 합치거나 이름을 바꾸지 않는다.
  const gradeDay='2026-11-20';
  owner(a.id,'grade-a',()=>{
    assert.ok(diary.addMagicStoneDaily(gradeDay,'09:00:00','최상급',1));
    assert.ok(diary.addMagicStoneDaily(gradeDay,'09:01:00','상급',2));
    assert.ok(diary.addMagicStoneDaily(gradeDay,'09:02:00','최상급',1));
  });
  assert.deepEqual(store.database.prepare("SELECT content,amount FROM activity_logs WHERE date=? AND profile_id=? AND type='loot' ORDER BY content").all(gradeDay,a.id),
    [{content:'[득템] [상급 마정석]',amount:2},{content:'[득템] [최상급 마정석]',amount:2}],'마정석 등급별 일일 행 분리');
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
  const SystemDate=Date;
  class RetentionFixtureDate extends SystemDate {
    constructor(value:string | number='2026-11-16T12:00:00') {super(value);}
  }
  global.Date=RetentionFixtureDate as DateConstructor;
  try {diary.cleanOldDiaryData(14);}
  finally {global.Date=SystemDate;}
  assert.equal(diary.getDiaryByDate(aggregateDate).activityLogs.length,0,'보존 기간 정리는 프로필별 날짜 요약도 함께 정리');
  // 삭제/유실 프로필 무시: 현재 프로필로 추정하지 않고 미배정 조회만 확장한다.
  const archive=built('modules/diaryArchivedProfiles');
  const originalRows=store.database.prepare('SELECT record_uuid,profile_id FROM activity_logs ORDER BY id').all();
  const changesBeforeArchive=count();
  assert.throws(()=>archive.reclassifyArchivedDiaryProfile(store,b.id),/사용 중/);
  archive.reclassifyArchivedDiaryProfile(store,a.id);
  assert.equal(count(),changesBeforeArchive,'로컬 일지 정리는 Google 변경 이력을 만들지 않음');
  archive.reclassifyArchivedDiaryProfile(store,a.id);
  assert.equal(diary.getMonthlySummary('2026-11',undefined,fa).totalSeed,0);
  const archivedDay=diary.getDiaryByDate(date,undefined,unassigned).diary;
  const archivedCalendar=diary.getDiariesByMonth('2026-11',0,unassigned).find((entry:any)=>entry.date===date);
  for (const row of [archivedDay,archivedCalendar]) {
    assert.deepEqual([row.daily_done,row.daily_total,row.weekly_done,row.weekly_total],[2,3,1,4],
      '이전 전체 스냅샷이 이미 있는 날도 미배정에 옮긴 A의 일간·주간 통계만 센다');
  }
  assert.equal(diary.getDiaryByDate(date).diary.daily_total,7,'미배정 재분류 뒤 모든 프로필의 합계는 유지한다.');
  store.database.prepare('DELETE FROM diary_homework_snapshots WHERE date=? AND profile_id=?').run(date,b.id);
  try {
    const oldDay=diary.getDiaryByDate(date,undefined,unassigned).diary;
    const oldCalendar=diary.getDiariesByMonth('2026-11',0,unassigned).find((row:any)=>row.date===date);
    for (const row of [oldDay,oldCalendar]) {
      assert.deepEqual([row.daily_done,row.daily_total,row.weekly_done,row.weekly_total],[1,10,0,3],
        '일부 프로필의 통계만 있는 경우에는 이전 전체 스냅샷과 재분류된 부분을 중복 집계하지 않는다');
    }
  } finally {store.database.prepare('INSERT INTO diary_homework_snapshots VALUES(?,?)').run(date,b.id);}
  for(const read of [()=>diary.getMonthlySummary('2026-11',undefined,unassigned).totalSeed,
    ()=>diary.getMonthlyStatistics('2026-11',undefined,unassigned).totalSeed,
    ()=>diary.getMonthlyRevenueData('2026-11',unassigned).reduce((sum:number,r:any)=>sum+r.amount,0),
    ()=>diary.getDiaryExportSnapshot(date,historyDate,[],unassigned).totalSeed])assert.equal(read(),2545);
  assert.equal(diary.getMonthlySummary('2026-11').totalSeed,3988);
  assert.equal(diary.getMonthlySummary('2026-11',undefined,fb).totalSeed,1443);
  assert.equal(diary.getDiaryByDate(historyDate,undefined,unassigned).activityLogs.every((r:any)=>r.profile_id===null),true);
  assert.equal(diary.getAlarmLogs(10,unassigned).some((r:any)=>r.profile_id===a.id),true);
  assert.equal(diary.getTimerRecords(unassigned).some((r:any)=>r.profile_id===a.id),true);
  assert.deepEqual(store.database.prepare('SELECT record_uuid,profile_id FROM activity_logs ORDER BY id').all(),originalRows,'원본 UUID/소유자 보존');
  assert.equal(archive.readArchivedDiaryProfiles(store).some((p:any)=>p.id===a.id),false);
  const duplicateDate='2099-12-01';
  store.withRecordContext(null,null,()=>diary.addHomeworkLog(duplicateDate,'same-archive-homework','동일 숙제','기타','weekly',Date.now()));
  store.database.prepare("INSERT INTO homework_logs(date,content_id,content_name,category,type,completed_at,profile_id,record_uuid) SELECT date,content_id,content_name,category,type,completed_at,?,'archive-homework-original' FROM homework_logs WHERE date=?").run(a.id,duplicateDate);
  assert.equal(diary.getDiaryByDate(duplicateDate,undefined,unassigned).homeworkLogs.length,2,'다른 이전 캐릭터의 같은 숙제를 잃지 않음');

  // 실제 신고 형식: 구형 원문 + 새 과거 복원 문구. 반복/수동/다른 현재 프로필은 보존한다.
  const feeDate='2099-12-02',other=store.create('다른 현재 프로필',7);
  store.database.prepare('INSERT OR IGNORE INTO diaries(date) VALUES(?)').run(feeDate);
  let rawNumber=0;
  const rawFee=(ownerId:string|null,time:string,amount:number,source='automatic',device:string|null=null)=>{
    const uuid=`legacy-fee-${++rawNumber}`;
    store.database.prepare('INSERT INTO activity_logs(date,time,type,content,amount,source,profile_id,record_uuid,record_device_id) VALUES(?,?,\'calc\',?,?,?,?,?,?)')
      .run(feeDate,time,`[자동] 입장료 ${Math.abs(amount)/10000}만 Seed를 지불 하였습니다. (${amount/10000}만)`,amount,source,ownerId,uuid,device);
    return uuid;
  };
  const canonical=(id:string,time:string,amount:number)=>owner(id,'fee-restore',()=>diary.addActivityLog(feeDate,time,'calc',`[자동] 어벤던로드 입장료 (-${Math.abs(amount).toLocaleString('en-US')} SEED)`,amount));
  const legacyFeeUuid=rawFee('profile-lost','0:7:37',-52800000);
  canonical(b.id,'00:07:37',-52800000);
  assert.equal(diary.getDiaryByDate(feeDate).activityLogs.length,1,'유실 소유자의 구형/복원 입장료 1회');
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE date=?').get(feeDate).n,2,'원본 2행 보존');
  canonical(b.id,'00:07:37',-52800000);
  assert.equal(diary.getDiaryByDate(feeDate).activityLogs.length,2,'같은 초 정상 반복은 1:1 대응으로 보존');
  rawFee(other.id,'01:00:00',-54000000);canonical(b.id,'01:00:00',-54000000);
  rawFee(null,'02:00:00',-54800000,'manual');canonical(b.id,'02:00:00',-54800000);
  rawFee(null,'03:00:00',-56000000);canonical(b.id,'03:00:01',-56000000);
  rawFee(null,'04:00:00',-56800000,'automatic','other-device');canonical(b.id,'04:00:00',-56800000);
  assert.equal(diary.getDiaryByDate(feeDate).activityLogs.length,10,'다른 현재 프로필/수동/다른 초/기기 원본 보존');
  const feeSum=diary.getDiaryByDate(feeDate).activityLogs.reduce((sum:number,r:any)=>sum+r.amount,0);
  for(const read of [()=>diary.getMonthlySummary('2099-12').totalSeed,()=>diary.getMonthlyStatistics('2099-12').totalSeed,
    ()=>diary.getMonthlyRevenueData('2099-12').reduce((sum:number,r:any)=>sum+r.amount,0),
    ()=>diary.getDiaryExportSnapshot(feeDate,feeDate).totalSeed])assert.equal(read(),feeSum);
  const exportedFees=diary.getDiaryExportSnapshot(feeDate,feeDate);
  assert.ok(exportedFees.rows.every((row:any)=>row.kind==='지출' && row.amount<0));
  const exportHtml=built('modules/diaryExport').renderDiaryExport({...exportedFees,legacyGoldReviewSeed:500000,
    rows:[...exportedFees.rows,{date:feeDate,time:'00:00:00',kind:'확인 필요',content:'금화 주머니',amount:500000}]});
  assert.match(exportHtml,/<td>지출<\/td>/);
  assert.match(exportHtml,/<td>확인 필요<\/td><td>금화 주머니<\/td><td>500,000 SEED<\/td>/);
  store.database.prepare('DELETE FROM activity_logs WHERE record_uuid IN (SELECT canonical_uuid FROM diary_fee_duplicates WHERE legacy_uuid=?)').run(legacyFeeUuid);
  assert.equal(diary.getDiaryByDate(feeDate).activityLogs.some((r:any)=>r.record_uuid===legacyFeeUuid),true,'복원 원본 제거 시 보존한 구형 기록 재표시');
  const beforeRollback=store.database.prepare('SELECT * FROM diary_fee_duplicates ORDER BY legacy_uuid').all();
  assert.throws(()=>store.database.transaction(()=>{canonical(b.id,'00:07:37',-52800000);throw new Error('fee rollback');})(),/fee rollback/);
  assert.deepEqual(store.database.prepare('SELECT * FROM diary_fee_duplicates ORDER BY legacy_uuid').all(),beforeRollback);
  const batchFeeDate='2099-12-03';
  store.database.prepare('INSERT OR IGNORE INTO diaries(date) VALUES(?)').run(batchFeeDate);
  store.database.prepare("INSERT INTO activity_logs(date,time,type,content,amount,source,profile_id,record_uuid) VALUES(?,'0:8:30','calc','[자동] 입장료 5400만 Seed를 지불 하였습니다. (-5400만)',-54000000,'automatic','profile-lost','batch-legacy-fee')").run(batchFeeDate);
  const restoredFee={eventId:'batch-fee-source-line',date:batchFeeDate,timeOnly:'00:08:30',content:'[자동] 어벤던로드 입장료 (-54,000,000 SEED)',amount:-54000000};
  owner(b.id,'batch-fee',()=>{
    assert.equal(diary.batchInsertSyncResults(batch([restoredFee])).seedsAdded,1);
    assert.equal(diary.batchInsertSyncResults(batch([restoredFee])).seedsAdded,0);
  });
  assert.equal(diary.getDiaryByDate(batchFeeDate).activityLogs.length,1,'과거 배치 복원도 구형 원문과 중복 집계하지 않음');
  assert.equal(diary.getDiaryExportSnapshot(batchFeeDate,batchFeeDate).totalSeed,-54000000);
  const orphanFirst=rawFee('profile-lost','05:00:00',-58000000),sameOwner=rawFee(b.id,'05:00:00',-58000000);
  canonical(b.id,'05:00:00',-58000000);
  const ownerPairs=store.database.prepare('SELECT legacy_uuid FROM diary_fee_duplicates WHERE legacy_uuid IN (?,?)').all(orphanFirst,sameOwner);
  assert.deepEqual(ownerPairs,[{legacy_uuid:sameOwner}],'같은 소유자의 대응을 먼저 확정해 미배정 자료가 가로채지 않음');
  const beforeRead=store.database.prepare('SELECT total_changes() n').get().n;
  diary.getMonthlySummary('2099-12');diary.getMonthlyStatistics('2099-12');diary.getDiaryByDate(batchFeeDate);
  assert.equal(store.database.prepare('SELECT total_changes() n').get().n,beforeRead,'조회는 중복 메타데이터나 원본을 쓰지 않음');
  const inconsistentDate='2099-12-04';
  store.database.prepare('INSERT OR IGNORE INTO diaries(date) VALUES(?)').run(inconsistentDate);
  const inconsistentFee=store.database.prepare("INSERT INTO activity_logs(date,time,type,content,amount,source,profile_id,record_uuid) VALUES(?,?,'calc',?,-54000000,'automatic',?,?)");
  inconsistentFee.run(inconsistentDate,'00:00:00','[자동] 입장료 5400만 Seed를 지불 하였습니다. (-5400만)','profile-lost','inconsistent-old-1');
  inconsistentFee.run(inconsistentDate,'00:00:00','[자동] 어벤던로드 입장료 (-1 SEED)',b.id,'inconsistent-new-1');
  inconsistentFee.run(inconsistentDate,'01:00:00','[자동] 입장료 5280만 Seed를 지불 하였습니다. (-5400만)','profile-lost','inconsistent-old-2');
  inconsistentFee.run(inconsistentDate,'01:00:00','[자동] 어벤던로드 입장료 (-54,000,000 SEED)',b.id,'inconsistent-new-2');
  built('modules/diaryLegacyFees').reconcileDiaryFees(store.database,true,inconsistentDate);
  assert.equal(diary.getDiaryByDate(inconsistentDate).activityLogs.length,4,'원문 지불액/복원 문구와 저장 amount가 다르면 추정해서 숨기지 않음');
  const bufferedDate='2099-12-05',buffered=store.create('보류 금액 정리',7);
  owner(buffered.id,'archive-buffer',()=>{
    diary.addManualActivityLog(bufferedDate,'12:00:00','calc','정리 전 원본',1);
    diary.addGoldPouchSeed(bufferedDate,'12:00:01',100);diary.addElsoPoints(bufferedDate,'12:00:02',55);
  });
  store.remove(buffered.id);archive.reclassifyArchivedDiaryProfile(store,buffered.id);
  assert.equal(diary.getDiaryByDate(bufferedDate,undefined,{kind:'profile',profileId:buffered.id}).activityLogs.length,0,'미배정으로 정리한 메모리 버퍼도 이전 프로필 조회에 다시 섞이지 않음');
  assert.equal(seed(bufferedDate,unassigned),101);
  assert.equal(diary.getDiaryByDate(bufferedDate,undefined,unassigned).activityLogs.find((r:any)=>r.type==='elso').amount,55);
  assert.equal(diary.flushPendingGoldPouchSeed(),true);assert.equal(diary.flushPendingElso(),true);
  assert.equal(seed(bufferedDate,unassigned),101,'메모리/영구 저장 조회의 분류와 합계 일치');
  assert.equal(store.database.prepare("SELECT profile_id FROM activity_logs WHERE date=? AND content=?").get(bufferedDate,diary.GOLD_POUCH_DAILY_CONTENT).profile_id,buffered.id,'버퍼 원래 귀속 보존');
  diary.closeDb();diary.initDb();
  assert.equal(diary.getMonthlySummary('2026-11',undefined,unassigned).totalSeed,2545,'미배정 정리 재시작 보존');
  assert.equal(diary.getDiaryByDate(feeDate).activityLogs.length,11,'재시작 재계산은 남은 canonical과 1:1 대응');
  assert.equal(store.database.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(store.database.pragma('foreign_key_check'),[]);
  const restoredOnly='2026-10-12';
  for (const profile of [b,other]) owner(profile.id,'weekly-fallback',()=>{
    assert.equal(diary.addHomeworkLog(restoredOnly,'restored-weekly','복원한 숙제','주간','weekly',Date.parse(restoredOnly+'T10:00:00')),true);
  });
  const totals=new Map([[b.id,53],[other.id,51]]);
  const recoveredWeek=(filter:any)=>diary.getDiariesByMonth('2026-10',totals,filter).find((day:any)=>day.date===restoredOnly);
  for (const [filter,expected] of [[fb,[1,53]],[{kind:'profile',profileId:other.id},[1,51]],[{kind:'all'},[2,104]]] as const) {
    const week=recoveredWeek(filter);
    assert.deepEqual([week.weekly_done,week.weekly_total],expected);
  }
  const legacyLoot='[득템] [Legacy-only]';
  store.withRecordContext(null,null,()=>assert.equal(diary.addActivityLog(restoredOnly,'12:30:00','loot',legacyLoot,1),true));
  for (const keywords of [['Legacy-only'],['Different-profile-keyword'],[]]) {
    assert.ok(diary.getDiaryByDate(restoredOnly,keywords,unassigned).activityLogs.some((row:any)=>row.content===legacyLoot));
    assert.ok(diary.getDiaryExportSnapshot(restoredOnly,restoredOnly,keywords,unassigned).rows.some((row:any)=>row.content===legacyLoot));
  }
  // 복원 실패 뒤 재연결처럼 일지 초기화가 실패해도 ApplicationData 소유의 공유 연결은 닫지 않는다.
  store.database.exec("CREATE TRIGGER reject_elso_replay BEFORE INSERT ON elso_flush_operations BEGIN SELECT RAISE(ABORT,'fixture diary init failure'); END;");
  assert.equal(diary.closeDb(),true);assert.equal(store.database.open,false);
  const failedInitDate='2026-09-16';
  fs.writeFileSync(diary.getElsoRecoveryJournalPath(),JSON.stringify({schemaVersion:2,operationId:'diary-init-failure',createdAt:1,
    entries:[{date:failedInitDate,latestTime:'09:00:00',totalAmount:12,profileId:null,deviceId:null,sessionId:null}]}));
  diary.initDb();
  assert.equal(store.database.open,true,'일지 초기화 실패가 공유 연결을 닫지 않음');
  assert.equal(config.saveConfirmed({pinnedNoteText:'일지 초기화 실패 뒤 설정 저장'}),true,'설정 저장은 계속 가능');
  assert.equal(store.list().length>0,true,'프로필 조회도 계속 가능');
  assert.ok(fs.existsSync(diary.getElsoRecoveryJournalPath()),'실패한 journal은 다음 초기화까지 보존');
  store.database.exec('DROP TRIGGER reject_elso_replay');
  diary.initDb();
  assert.equal(fs.existsSync(diary.getElsoRecoveryJournalPath()),false,'다음 일지 초기화에서 재시도');
  assert.equal(store.database.prepare("SELECT amount FROM activity_logs WHERE date=? AND type='elso'").get(failedInitDate)?.amount,12);
  assert.equal(diary.getStmt('PRAGMA database_list').all()[0].file,store.filePath,'재시도도 같은 app-data.db 연결');
  assert.equal(diary.closeDb(),true);
  assert.deepEqual(fs.readFileSync(path.join(fixture,'diary.db')),original,'공유 저장/재연결은 원래 diary.db를 변경하지 않음');
  console.log('PASS profile diary: shared connection, original preservation, attribution/aggregates, pending/recovery/restart, source dedup/rebuild, deleted profiles, rollback/ACK, filtered totals/export.');
}

run().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
