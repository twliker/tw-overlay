/** 실제 SQLite/WAL·디스크의 프로필 이전/격리/실패 복구 검사. 사용자 데이터는 사용하지 않는다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app } from 'electron';
import Database = require('better-sqlite3');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-profile-storage-'));
app.setPath('userData', fixture);
const root = path.resolve(__dirname,'..');
const { ApplicationData } = require(path.join(root,'dist/modules/applicationData.js'));
const { deviceConfigOnly } = require(path.join(root,'dist/shared/playProfiles.js'));
const { DEFAULT_CONFIG } = require(path.join(root,'dist/modules/constants.js'));
const base = () => structuredClone(DEFAULT_CONFIG);
const directory = (name: string) => {
  const result = path.join(fixture,name); fs.mkdirSync(result); return result;
};

async function run(): Promise<void> {
  await app.whenReady();
  const defaults = base();
  defaults.contentsCheckerItems = [{ id:'base',name:'기본 숙제',category:'일일',isVisible:true,
    resetRule:{type:'daily',hour:0},completedState:{} }];
  const legacy = { ...base(), userServer:7,buffTimerEnabled:false,wordAlarmKeywords:['보존'],
    pinnedNoteText:'기존 메모',positions:{ diary:{ offsetX:31,offsetY:42 } },
    characterPresets:[{id:'A',name:'캐릭터 A'},{id:'B',name:'캐릭터 B'}],selectedCharacterId:'B',
    contentsCheckerItems:[{id:'custom-old',name:'옛 숙제',category:'주간',isVisible:false,isCustom:true,
      resetRule:{type:'weekly',dayOfWeek:4,hour:6},maxCount:7,
      completedState:{A:{currentCount:2,isCompleted:false,lastCompletedAt:123},
        B:{currentCount:4,isCompleted:false,isExcluded:true,lastCompletedAt:456}}}],
    pendingHomeworks:[{id:'custom-old',count:1,isIncrement:true,timestamp:789}] };
  const dir = directory('upgrade');
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(legacy));
  const old = new Database(path.join(dir,'diary.db'));
  old.pragma('journal_mode=WAL');
  old.pragma('wal_autocheckpoint=0');
  old.exec('CREATE TABLE activity_logs(id INTEGER PRIMARY KEY, content TEXT, amount INTEGER); CREATE TABLE alarm_logs(id INTEGER PRIMARY KEY, message TEXT);');
  old.prepare('INSERT INTO activity_logs VALUES(?,?,?)').run(1,'기존 수익',300);
  old.prepare('INSERT INTO activity_logs VALUES(?,?,?)').run(2,'기존 지출',-50);
  old.prepare('INSERT INTO alarm_logs VALUES(?,?)').run(1,'기존 알람');
  const configBytes = fs.readFileSync(path.join(dir,'config.json'));
  let store = await ApplicationData.initialize({directory:dir,deviceId:'PC-A',defaults},legacy);
  assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),configBytes,'기존 설정 원본 보존');
  assert.equal((old.prepare('SELECT COUNT(*) n FROM activity_logs').get() as {n:number}).n,2,'기존 DB 보존');
  old.close();
  assert.equal(store.database.prepare('SELECT SUM(amount) n FROM activity_logs').get().n,250,'WAL 수익/지출 합계 이전');
  assert.equal(store.database.prepare('SELECT message FROM alarm_logs').get().message,'기존 알람','일지 외 테이블 보존');
  assert.equal(store.list().length,2,'기존 2캐릭터는 총 2프로필');
  const a = store.list().find((p:any) => p.name==='캐릭터 A');
  const b = store.list().find((p:any) => p.name==='캐릭터 B');
  assert.equal(b.id,'profile-default','선택 캐릭터가 빈 기본 프로필 재사용');
  const oldRows = store.database.prepare('SELECT profile_id,record_uuid FROM activity_logs').all();
  assert.ok(oldRows.every((row:any) => row.profile_id===null && !!row.record_uuid),'과거 일지 미지정·고유 ID');
  const outboxBeforeDiary = store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n;
  store.withRecordContext(a.id,'session-A',() => store.database.prepare('INSERT INTO activity_logs(id,content,amount) VALUES(?,?,?)').run(3,'귀속 검사',0));
  const attributed = store.database.prepare('SELECT * FROM activity_logs WHERE id=3').get();
  assert.equal(attributed.profile_id,a.id);
  assert.equal(attributed.record_session_id,'session-A');
  assert.equal(attributed.record_device_id,'PC-A');
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n,outboxBeforeDiary,'일지는 동기화 이력에서 제외');
  assert.equal(a.userServer,7);
  assert.equal(store.homework(a.id)[0].completedState[a.id].currentCount,2);
  assert.deepEqual(store.homework(b.id)[0].completedState[b.id],legacy.contentsCheckerItems[0].completedState.B);
  assert.equal(store.homework(a.id)[0].resetRule.hour,6);
  assert.equal(store.homework(a.id)[0].isVisible,false);
  assert.equal(store.pending('legacy-unassigned').length,1,'미배정 숙제 임의 귀속 금지');
  const projectionA = store.project(a.id,legacy);
  assert.equal(projectionA.buffTimerEnabled,false,'사용자 false 값 이전');
  assert.equal(projectionA.pinnedNoteText,'기존 메모');
  assert.equal(projectionA.positions.diary.offsetX,31,'공통 창 위치 유지');
  assert.equal(projectionA.characterPresets.length,1,'현재 캐릭터 하나만 projection');
  assert.deepEqual(projectionA.pendingHomeworks,[],'과거 대기 자동 배정 금지');
  const projectedB = store.project(b.id,legacy);
  projectionA.pinnedNoteText = 'A만 변경';
  projectionA.contentsCheckerItems[0].completedState[a.id].currentCount=3;
  store.saveProjection(a.id,projectionA);
  assert.equal(store.project(b.id,legacy).pinnedNoteText,'기존 메모','프로필 설정 격리');
  assert.equal(store.homework(b.id)[0].completedState[b.id].currentCount,4,'숙제 격리');
  assert.equal(store.project(a.id,legacy).pinnedNoteText,'A만 변경');
  const changesBefore = store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n;
  store.saveProjection(a.id,projectionA);
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n,changesBefore,'무변경 저장에 이력 추가 없음');
  // 원본 저장 이후 outbox 쓰기가 실패해도 원본까지 rollback.
  store.database.exec("CREATE TRIGGER reject_profile_change BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END;");
  projectionA.pinnedNoteText='저장되면 안 됨';
  assert.throws(() => store.saveProjection(a.id,projectionA),/fixture outbox failure/);
  assert.equal(store.project(a.id,legacy).pinnedNoteText,'A만 변경','outbox 실패 시 원본도 rollback');
  store.database.exec('DROP TRIGGER reject_profile_change');
  const c = store.create('캐릭터 C',16,a.id);
  assert.equal(store.project(c.id,legacy).pinnedNoteText,'A만 변경','환경설정 복사');
  assert.deepEqual(store.homework(c.id).map(({completedState,...item}:any)=>item),store.homework(a.id).map(({completedState,...item}:any)=>item),'숙제 정의·커스텀·숨김·정렬도 설정으로 복사');
  for (const item of store.homework(c.id)) {
    assert.equal(item.completedState[c.id].currentCount,undefined);assert.equal(item.completedState[c.id].lastCompletedAt,undefined);
    assert.equal(item.completedState[c.id].isExcluded===true,store.homework(a.id).find((source:any)=>source.id===item.id).completedState[a.id].isExcluded===true);
  }
  assert.equal(c.userServer,16,'복사 원본 서버보다 생성 시 지정 서버 우선');
  const portable=require(path.join(root,'dist/modules/profileSyncModel.js')).portableProfileSnapshot;
  const portableBeforeOrder=portable(store.database),journalBeforeOrder=store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n;
  const homeworkBeforeOrder=JSON.stringify(store.database.prepare('SELECT * FROM profile_homework ORDER BY profile_id,item_id').all());
  const orderedIds=[c.id,a.id,b.id];store.setProfileOrder(orderedIds);
  assert.deepEqual(store.list().map((profile:any)=>profile.id),orderedIds);
  store.markUsed(b.id);store.markUsed(a.id);assert.deepEqual(store.list().map((profile:any)=>profile.id),orderedIds,'프로필 사용으로 수동 순서가 바뀌지 않음');
  assert.deepEqual(portable(store.database),portableBeforeOrder,'이 PC의 보기 순서는 Google 전송 원본을 바꾸지 않음');
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n,journalBeforeOrder);
  assert.equal(JSON.stringify(store.database.prepare('SELECT * FROM profile_homework ORDER BY profile_id,item_id').all()),homeworkBeforeOrder);
  assert.throws(()=>store.setProfileOrder([a.id,a.id,b.id]),/올바르지/);
  assert.throws(()=>store.setProfileOrder([a.id,b.id]),/목록이 변경/);
  assert.throws(()=>store.setProfileOrder([a.id,b.id,'unknown-profile']),/목록이 변경/);
  store.database.exec("CREATE TRIGGER reject_profile_order BEFORE UPDATE OF value ON app_meta WHEN OLD.key='profile_display_order' BEGIN SELECT RAISE(ABORT,'fixture profile order failure');END;");
  assert.throws(()=>store.setProfileOrder([...orderedIds].reverse()),/fixture profile order failure/);assert.deepEqual(store.list().map((profile:any)=>profile.id),orderedIds);
  store.database.exec('DROP TRIGGER reject_profile_order');
  const appended=store.create('순서 뒤에 추가',7);assert.deepEqual(store.list().map((profile:any)=>profile.id),[...orderedIds,appended.id],'새 프로필은 지정한 순서 뒤에 표시');
  store.markUsed(appended.id);assert.deepEqual(store.list().map((profile:any)=>profile.id),[...orderedIds,appended.id]);store.remove(appended.id);
  const markCount = store.list().length;
  assert.throws(() => store.create('실패',99),/서버/);
  assert.equal(store.list().length,markCount);
  assert.throws(() => store.saveProjection(a.id,projectedB),/다른 캐릭터/,'오래된 다른 프로필 응답 차단');
  // 삭제된 이력을 정리해도 기기 순번은 재사용하지 않음.
  const lastSequence = store.database.prepare('SELECT MAX(sequence) n FROM profile_change_log').get().n;
  store.database.prepare('DELETE FROM profile_change_log').run();
  store.update(c.id,'이름 변경',7);
  assert.ok(store.database.prepare('SELECT MIN(sequence) n FROM profile_change_log').get().n>lastSequence);
  assert.equal(store.list().find((p:any) => p.id===c.id).name,'이름 변경','이름 변경 시 ID 유지');
  store.database.exec('CREATE TABLE replay_test(id TEXT PRIMARY KEY,value TEXT)');
  store.enqueue('session-1',{amount:100},1000,'event-1');
  store.enqueue('session-1',{amount:100},1000,'event-1');
  store.enqueue('session-2',{amount:200},1001,'event-2');
  assert.equal(store.pending('session-1').length,1,'재전송 중복 방지');
  assert.throws(() => store.assignPending('session-1',a.id,(_payload:any,id:string) => {
    store.database.prepare('INSERT INTO replay_test VALUES(?,?)').run(id,'100'); throw new Error('fixture interrupted replay');
  }),/fixture interrupted replay/);
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM replay_test').get().n,0);
  assert.equal(store.pending('session-1').length,1,'반영 실패 시 대기 기록 보존');
  assert.equal(store.assignPending('session-1',a.id,(_payload:any,id:string) => store.database.prepare('INSERT INTO replay_test VALUES(?,?)').run(id,'100')),1);
  assert.equal(store.assignPending('session-1',a.id,() => assert.fail('재처리')),0);
  assert.equal(store.pending('session-2').length,1,'다른 세션 자동 배정 금지');
  const ignoredRaw={kind:'legacy-homework',value:{count:143,timestamp:1000}},ignoredSession='ignore-fixture';
  const ignoreChanges=store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n;
  store.enqueue(ignoredSession,ignoredRaw,1000,'ignored-original');store.enqueue(ignoredSession,{amount:2},1000,'ignored-second');
  const firstIgnore=store.pendingSessionSnapshot(ignoredSession);
  store.database.prepare('UPDATE pending_profile_events SET payload=? WHERE event_id=?').run(JSON.stringify({amount:3}),'ignored-second');
  assert.throws(()=>store.ignorePendingSession(ignoredSession,firstIgnore.token),/변경/,'개수/시각이 같아도 다른 원문은 무시하지 않음');
  const secondIgnore=store.pendingSessionSnapshot(ignoredSession);
  const ignoredSource={fingerprint:'ignored-fixture',start:12,end:80,lineKey:'a'.repeat(64)};
  const ignoredDate='2026-01-01';
  store.enqueue(ignoredSession,{data:{date:ignoredDate},source:ignoredSource},1000,'ignored-arrived-later');
  assert.throws(()=>store.ignorePendingSession(ignoredSession,secondIgnore.token),/변경/,'확인 중 새 기록도 함께 무시하지 않음');
  const finalIgnore=store.pendingSessionSnapshot(ignoredSession);
  store.database.exec("CREATE TRIGGER reject_ignore BEFORE UPDATE OF resolved_at ON pending_profile_events WHEN OLD.session_id='ignore-fixture' BEGIN SELECT RAISE(ABORT,'fixture ignore save failure');END;");
  assert.throws(()=>store.ignorePendingSession(ignoredSession,finalIgnore.token),/fixture ignore save failure/);assert.equal(store.pending(ignoredSession).length,3);
  assert.equal(store.database.prepare('SELECT 1 FROM profile_log_source_ranges WHERE fingerprint=?').get(ignoredSource.fingerprint),undefined,'무시 저장 실패 시 제외 구간도 롤백');
  store.database.exec('DROP TRIGGER reject_ignore');
  assert.equal(store.ignorePendingSession(ignoredSession,finalIgnore.token),3);assert.equal(store.pending(ignoredSession).length,0);
  const ignoredRow=store.database.prepare('SELECT * FROM pending_profile_events WHERE event_id=?').get('ignored-original');
  assert.deepEqual(JSON.parse(ignoredRow.payload),ignoredRaw,'무시는 원본 payload를 삭제/변경하지 않음');assert.equal(ignoredRow.assigned_profile_id,null);assert.ok(ignoredRow.resolved_at);
  assert.equal(store.ignorePendingSession(ignoredSession,finalIgnore.token),0,'중복 요청은 다시 처리하지 않음');
  store.enqueue(ignoredSession,ignoredRaw,1000,'ignored-original');assert.equal(store.pending(ignoredSession).length,0,'같은 원문 재수신으로 다시 표시하지 않음');
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n,ignoreChanges,'무시는 로컬 대기에만 적용');
  const legacySource={...ignoredSource,fingerprint:'already-ignored-fixture',lineKey:'b'.repeat(64)};
  store.enqueue('old-ignore-fixture',{data:{date:ignoredDate},source:legacySource},1000,'legacy-ignore-event');
  store.database.prepare("UPDATE pending_profile_events SET resolved_at=? WHERE event_id='legacy-ignore-event'").run(2000);
  store.database.prepare("DELETE FROM app_meta WHERE key='ignored_log_ranges_backfilled'").run();
  store.close();
  store = await ApplicationData.initialize({directory:dir,deviceId:'PC-A',defaults},legacy);
  assert.deepEqual(store.list().map((profile:any)=>profile.id),orderedIds,'수동 순서는 저장소 재시작 후 유지');
  assert.equal(store.list().length,3,'재실행 이전 중복 없음');
  assert.equal(store.project(a.id,legacy).pinnedNoteText,'A만 변경','재실행 후 사용자 변경 유지');
  assert.equal(store.pending('session-2').length,1,'재시작 대기 보존');
  assert.equal(store.pending(ignoredSession).length,0,'무시 상태도 재시작 후 유지');
  assert.ok(store.database.prepare('SELECT 1 FROM profile_log_source_ranges WHERE fingerprint=? AND profile_id IS NULL').get(legacySource.fingerprint));
  assert.ok(store.database.prepare('SELECT 1 FROM profile_ignored_log_ranges WHERE fingerprint=?').get(legacySource.fingerprint));
  assert.ok(store.database.prepare('SELECT 1 FROM profile_log_line_owners WHERE line_key=? AND profile_id IS NULL AND live=0').get(Buffer.from(legacySource.lineKey,'hex')));
  assert.ok(store.compactResolvedEvents(Date.now()+31*86400000)>0);
  assert.equal(store.database.prepare('SELECT assigned_profile_id FROM profile_event_receipts WHERE event_id=?').get('ignored-original').assigned_profile_id,null,'기존 원문 정리 후 무시 영수증 유지');
  store.enqueue(ignoredSession,ignoredRaw,1000,'ignored-original');assert.equal(store.pending(ignoredSession).length,0);
  assert.throws(()=>store.enqueue(ignoredSession,{different:true},1000,'ignored-original'),/다른/,'무시 영수증도 동일 ID 변조를 거부');
  // 리뷰 P3: 일지에 남지 않는 실시간 줄(정수 교환이 아닌 경험치·다른 사람의 획득)은 30일 압축 뒤 영수증·줄 귀속을
  // 남기지 않는다. 기록 줄은 계속 보존하고, 일지가 실제로 정리한 날짜보다 이전 증거만 제한된 개수씩 지운다.
  const {claimProfileLogLine}=require(path.join(root,'dist/modules/profileLogSource.js'));
  require(path.join(root,'dist/modules/profileParserEvents.js'));
  const retentionKey=(n:number)=>n.toString(16).padStart(64,'0');
  const ownerOf=(n:number)=>store.database.prepare('SELECT profile_id,live FROM profile_log_line_owners WHERE line_key=?').get(Buffer.from(retentionKey(n),'hex'));
  const liveEvent=(n:number,event:string,data:Record<string,unknown>,resolved=true)=>{
    const id=`live-line:${retentionKey(n)}:${event}:0`;
    store.enqueue('retention-session',{kind:'parsed-profile-event',version:1,event,sessionId:'retention-session',observedAt:5000,
      data:{date:'2026-11-10',timestamp:'10시 00분 00초',message:'',...data},source:{fingerprint:'retention',start:n,end:n+1,lineKey:retentionKey(n)}},5000,id,a.id);
    if (resolved) store.database.prepare('UPDATE pending_profile_events SET resolved_at=1 WHERE event_id=?').run(id);
    return id;
  };
  assert.equal(claimProfileLogLine(store.database,retentionKey(1),'2026-11-10',a.id,false),true);
  assert.equal(ownerOf(1),undefined,'기록 없는 줄은 귀속 행을 새로 만들지 않는다');
  assert.equal(claimProfileLogLine(store.database,retentionKey(2),'2026-11-10',a.id),true);
  assert.equal(claimProfileLogLine(store.database,retentionKey(2),'2026-11-10',b.id,false),false,'기존 귀속 확인은 그대로');
  for (const n of [1,3,4,5,6,7]) claimProfileLogLine(store.database,retentionKey(n),'2026-11-10',a.id);
  const transientXp=liveEvent(1,'XP_CHANGED',{amount:57}),exchange=liveEvent(2,'XP_CHANGED',{amount:-10_000_000_000});
  const otherLoot=liveEvent(3,'ITEM_LOOTED',{isOwn:false,itemName:'남의 보석',count:1,message:'누군가 [남의 보석]을 획득하였습니다.'});
  const ownLoot=liveEvent(4,'ITEM_LOOTED',{isOwn:true,itemName:'내 보석',count:1});
  const elsoOther=liveEvent(5,'ITEM_LOOTED',{isOwn:false,itemName:'ELSO',count:3,message:'[엘소 스크롤 (1 포인트)]을(를) [3]개 획득하였습니다.'});
  const sharedXp=liveEvent(6,'XP_CHANGED',{amount:9});liveEvent(6,'SEED_GAINED',{amount:10},false);
  const seed=liveEvent(7,'SEED_GAINED',{amount:10});
  store.compactResolvedEvents(Date.now()+31*86400000);
  const receipt=(id:string)=>!!store.database.prepare('SELECT 1 FROM profile_event_receipts WHERE event_id=?').get(id);
  assert.deepEqual([transientXp,exchange,otherLoot,ownLoot,elsoOther,sharedXp,seed].map(receipt),[false,true,false,true,true,false,true],
    '기록 줄만 재시도 영수증을 남긴다');
  assert.deepEqual([1,2,3,4,5,6,7].map(n=>!!ownerOf(n)),[false,true,false,true,true,true,true],'같은 줄의 다른 대기 기록이 있으면 귀속 보존');
  // 일지 정리 기준(activity_pruned_before) 이전의 증거만 지우고 무시 표식은 보존한다. 영구 보관이면 기준이 없다.
  const owners=store.database.prepare('INSERT OR REPLACE INTO profile_log_line_owners VALUES(?,?,?,?)');
  owners.run(Buffer.from(retentionKey(20),'hex'),'2026-01-31',a.id,1);owners.run(Buffer.from(retentionKey(21),'hex'),'2026-01-31',a.id,0);
  owners.run(Buffer.from(retentionKey(22),'hex'),'2026-01-31',null,0);owners.run(Buffer.from(retentionKey(23),'hex'),'2026-02-01',a.id,1);
  const receipts=store.database.prepare("INSERT INTO profile_event_receipts VALUES(?,'retention-session',?,'hash',NULL,1)");
  receipts.run('old-receipt',new Date('2026-01-31T23:59:59').getTime());receipts.run('kept-receipt',new Date('2026-02-01T00:00:00').getTime());
  store.compactResolvedEvents();
  assert.deepEqual([20,21,22,23].map(n=>!!ownerOf(n)),[true,true,true,true],'일지 정리 기준이 없으면(영구 보관) 지우지 않는다');
  store.database.exec("CREATE TABLE IF NOT EXISTS diary_profile_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT OR REPLACE INTO diary_profile_meta VALUES('activity_pruned_before','2026-02-01')");
  store.compactResolvedEvents();
  assert.deepEqual([20,21,22,23].map(n=>!!ownerOf(n)),[false,false,true,true]);
  assert.deepEqual(['old-receipt','kept-receipt'].map(receipt),[false,true]);
  assert.ok(store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_profile_event_receipts_occurred'").get());
  // 이 계약 이전에 쌓인 기록 없는 경험치 영수증은 일지 행이 없는 줄만 한 번 훑어 지운다.
  store.database.exec(`CREATE TABLE IF NOT EXISTS diary_live_activity_events(id INTEGER PRIMARY KEY,line_key TEXT NOT NULL,date TEXT NOT NULL,
    profile_id TEXT,signature TEXT NOT NULL,activity_id INTEGER NOT NULL);DELETE FROM app_meta WHERE key='profile_event_receipt_backfill_rowid'`);
  for (const n of [30,31,32]) claimProfileLogLine(store.database,retentionKey(n),'2026-11-10',a.id);
  const legacyReceipt=(n:number,event:string)=>{const id=`live-line:${retentionKey(n)}:${event}:0`;receipts.run(id,Date.now());return id;};
  const oldXp=legacyReceipt(30,'XP_CHANGED'),oldExchange=legacyReceipt(31,'XP_CHANGED'),oldLoot=legacyReceipt(32,'ITEM_LOOTED');
  store.database.prepare("INSERT INTO diary_live_activity_events(line_key,date,profile_id,signature,activity_id) VALUES(?,'2026-11-10',?,'essence',1)").run(retentionKey(31),a.id);
  store.compactResolvedEvents();
  assert.deepEqual([oldXp,oldExchange,oldLoot].map(receipt),[false,true,true]);
  assert.deepEqual([30,31,32].map(n=>!!ownerOf(n)),[false,true,true]);
  assert.equal(store.database.prepare("SELECT value FROM app_meta WHERE key='profile_event_receipt_backfill_rowid'").get().value,'done');
  store.database.exec("DROP TABLE diary_live_activity_events;DELETE FROM diary_profile_meta WHERE key='activity_pruned_before'");
  // 실제 config facade와 혼합 파일 저장. 프로필 본문은 config.json에 중복 저장하지 않음.
  const config = require(path.join(root,'dist/modules/config.js'));
  const persistence = {
    read:(value:any) => store.readConfiguration(value),
    commit:(value:any,previous:any) => store.commitConfiguration(value,previous),
  };
  // config 모듈은 fixture 루트를 사용하므로 여기서는 facade callback과 같은 입력을 직접 검사한다.
  let committed = persistence.read({...legacy,activePlayProfileId:a.id});
  committed = persistence.commit({...committed,pinnedNoteText:'저장 계층 연결',width:800},committed);
  const diskDevice = JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(diskDevice.width,800);
  assert.ok(!('pinnedNoteText' in diskDevice) && !('contentsCheckerItems' in diskDevice),'본문 JSON 중복 원본 없음');
  assert.equal(store.project(a.id,legacy).pinnedNoteText,'저장 계층 연결');
  committed = persistence.commit({...committed,activePlayProfileId:b.id},committed);
  assert.equal(committed.pinnedNoteText,'기존 메모','전환 시 새 프로필에 이전 설정 덮어쓰기 없음');
  assert.equal(committed.selectedCharacterId,b.id);
  const beforeMixed = fs.readFileSync(path.join(dir,'config.json'),'utf8');
  // SQLite commit 자체가 실패하는 경우 JSON 교체까지 되돌린다.
  store.database.exec(`CREATE TABLE bad_commit(value TEXT REFERENCES app_meta(key) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER UPDATE ON app_meta WHEN NEW.key='device_config_commit'
    BEGIN INSERT INTO bad_commit VALUES('does-not-exist'); END;`);
  assert.throws(() => persistence.commit({...committed,width:901,pinnedNoteText:'commit 실패'},committed),/FOREIGN KEY/);
  assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),beforeMixed,'DB commit 실패 후 JSON rollback');
  assert.equal(store.project(b.id,legacy).pinnedNoteText,'기존 메모');
  store.database.exec('DROP TRIGGER fail_commit');
  // 저장 중 강제 종료를 journal만 남은 상태로 재현.
  fs.writeFileSync(path.join(dir,'app-data-config-write.json'),JSON.stringify({version:1,commitId:'not-committed',before:beforeMixed}));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({width:9999}));
  store.close();
  store = await ApplicationData.initialize({directory:dir,deviceId:'PC-A',defaults},legacy);
  assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),beforeMixed,'강제 종료 후 JSON/DB 복구');
  assert.equal(config.sanitizeExternalConfigPatch({activePlayProfileId:a.id}),null,'일반 설정 patch로 프로필 전환 불가');
  store.remove(a.id); store.remove(b.id); store.remove(c.id);
  const remaining = store.list();
  assert.equal(remaining.length,1,'마지막 삭제 후 빈 기본 하나');
  assert.equal(remaining[0].name,''); assert.equal(remaining[0].userServer,null);
  assert.equal(store.homework(remaining[0].id)[0].id,'base','빈 기본에도 기본 숙제 제공');
  assert.ok(![a.id,b.id,c.id].includes(remaining[0].id),'삭제 ID 재사용 금지');
  assert.equal(store.database.prepare('SELECT SUM(amount) n FROM activity_logs').get().n,250,'프로필 삭제로 일지 삭제 안 함');
  assert.equal(store.list(true).filter((p:any) => p.deletedAt!==null).length,4,'삭제된 프로필 식별 보존');
  assert.throws(() => store.markUsed(remaining[0].id),/이름과 서버/);
  store.close();
  const blank = await ApplicationData.initialize({directory:directory('fresh'),deviceId:'PC-B',defaults},base());
  assert.equal(blank.list().length,1,'신규 설치 기본 하나');
  assert.equal(blank.list()[0].userServer,null,'앱 기본 서버를 사용자 선택으로 간주하지 않음');
  assert.equal(blank.homework(blank.list()[0].id)[0].id,'base');
  blank.close();
  const onlyDevice = deviceConfigOnly(legacy);
  assert.ok(!('userServer' in onlyDevice) && !('contentsCheckerItems' in onlyDevice) && !('wordAlarmKeywords' in onlyDevice));
  assert.equal(onlyDevice.positions.diary.offsetX,31);
  // 기존 앱의 config 공개 API를 실제 저장소에 연결해 확정/지연 저장과 전환을 검사.
  assert.equal(config.saveConfirmed(legacy),true);
  const diaryModule = require(path.join(root,'dist/modules/diaryDb.js'));
  diaryModule.initDb();
  assert.equal(diaryModule.closeDb(),true);
  const facade = await ApplicationData.initialize({directory:fixture,deviceId:'PC-facade',defaults},config.load());
  config.installPersistence({read:(value:any) => facade.readConfiguration(value),
    commit:(value:any,previous:any) => facade.commitConfiguration(value,previous)});
  const initial = config.load();
  assert.equal(initial.activePlayProfileId,'profile-default');
  assert.equal(config.saveConfirmed({pinnedNoteText:'공개 API 저장',userServer:16}),true);
  assert.equal(facade.setting(initial.activePlayProfileId,'pinnedNoteText'),'공개 API 저장');
  assert.equal(config.load().userServer,16);
  config.save({width:777});
  const other = facade.list().find((p:any) => p.id!==initial.activePlayProfileId);
  assert.equal(config.saveConfirmed({activePlayProfileId:other.id}),true);
  assert.equal(config.load().width,777,'전환 전 위치/크기 pending 보존');
  assert.equal(config.load().pinnedNoteText,'기존 메모','다른 프로필 projection 로드');
  const jsonConfig = JSON.parse(fs.readFileSync(path.join(fixture,'config.json'),'utf8'));
  assert.ok(!('userServer' in jsonConfig) && !('pinnedNoteText' in jsonConfig),'공개 API도 단일 원본 보장');
  assert.equal(jsonConfig.activePlayProfileId,other.id);
  const beforeFacadeFailure = config.load();
  facade.database.exec("CREATE TRIGGER reject_facade BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture facade failure'); END;");
  assert.equal(config.saveConfirmed({pinnedNoteText:'실패할 공개 저장'}),false);
  assert.deepEqual(config.load(),beforeFacadeFailure,'공개 확정 저장 실패 시 캐시/DB 유지');
  facade.database.exec('DROP TRIGGER reject_facade');
  const { ProfileService } = require(path.join(root,'dist/modules/profileService.js'));
  let allowTransition = true,failRuntime = false;
  let duringTransition:(() => void) | null=null;
  let prepareWait:Promise<void> | null=null;
  let finishTransition:(()=>void | Promise<void>) | undefined;
  const service = new ProfileService(facade,config,{
    prepareTransition:async () => {duringTransition?.();if (prepareWait) await prepareWait;return allowTransition;},
    afterTransition:() => { if (failRuntime) throw new Error('fixture runtime failure'); },
    transitionFinished:()=>finishTransition?.(),
  });
  const session1 = service.beginSession('game-process-1').sessionId;
  const assign=(id:string,profileId=service.status().activeProfileId,token=facade.pendingSessionSnapshot(id)?.token ?? '')=>service.assignSession(id,profileId,token,applyEvent);
  assert.equal(service.beginSession('game-process-1').sessionId,session1,'반복 감지/복귀는 같은 세션');
  const applyEvent = (payload:any,eventId:string) => {
    facade.database.prepare("INSERT OR IGNORE INTO diaries(date) VALUES('2026-11-02')").run();
    return facade.database.prepare(
      "INSERT INTO activity_logs(date,type,content,time,amount) VALUES('2026-11-02','calc',?,'13:00:00',?)").run(eventId,payload.amount);
  };
  service.dispatch({amount:111},applyEvent,1111,'runtime-event-1');
  assert.equal(facade.pending(session1).length,1,'선택 전 기록 내구 대기');
  allowTransition=false;
  assert.equal((await service.select(initial.activePlayProfileId,applyEvent)).success,false);
  assert.equal(service.status().selectionRequired,true,'전환 취소 시 기존 선택 대기 유지');
  assert.equal(service.status().busy,false);
  allowTransition=true;failRuntime=true;
  const failedTransition = await service.select(initial.activePlayProfileId,applyEvent);
  assert.equal(failedTransition.success,false);
  assert.equal(service.status().activeProfileId,other.id,'런타임 실패 시 이전 프로필 복구');
  assert.equal(service.status().selectionRequired,true);
  failRuntime=false;
  const selected = await service.select(initial.activePlayProfileId,applyEvent);
  assert.equal(selected.success,true);
  assert.equal(selected.error,undefined);
  assert.equal(selected.status.busy,false,'반환 상태도 전환 종료');
  assert.equal(facade.pending(session1).length,0,'선택한 현재 세션만 반영');
  finishTransition=async()=>{
    await Promise.resolve();
    service.dispatch({amount:1},applyEvent,1112,'late-transition-event');
    assert.equal(facade.pending(session1).length,0,'창 정리 중에도 활성 프로필의 기록을 즉시 확정');
  };
  try {
    assert.equal((await service.select(initial.activePlayProfileId,applyEvent)).success,true);
    assert.equal(facade.pending(session1).length,0);
    assert.equal(facade.database.prepare('SELECT profile_id FROM activity_logs WHERE content=?').get('late-transition-event').profile_id,initial.activePlayProfileId);
  } finally {finishTransition=undefined;}
  assert.equal(facade.database.prepare('SELECT profile_id FROM activity_logs WHERE content=?').get('runtime-event-1').profile_id,initial.activePlayProfileId);
  duringTransition=()=>{
    service.dispatch({amount:2},applyEvent,1113,'during-confirmation');
    assert.throws(()=>service.dispatch({amount:3},()=>{throw new Error('fixture record failure');},1114,'during-confirmation-failed'));
  };
  finishTransition=()=>service.dispatch({amount:4},applyEvent,1115,'after-confirmation');
  try {
    assert.equal((await service.select(other.id,applyEvent)).success,true);
    const owner=(id:string)=>facade.database.prepare('SELECT profile_id FROM activity_logs WHERE content=?').get(id).profile_id;
    assert.equal(owner('during-confirmation'),initial.activePlayProfileId);
    assert.equal(owner('during-confirmation-failed'),initial.activePlayProfileId,'전환 전 실패한 기록도 A에서 재시도');
    assert.equal(owner('after-confirmation'),other.id);
    assert.equal(facade.pending(session1).length,0);
    facade.enqueue('past-owned-session',{amount:5},1116,'past-owned-record',initial.activePlayProfileId);
    assert.equal((await assign('past-owned-session')).success,false,'다른 프로필에서 저장 실패 기록을 가져올 수 없다');
  } finally {duringTransition=null;finishTransition=undefined;}
  assert.equal((await service.select(initial.activePlayProfileId,applyEvent)).success,true);
  assert.equal((await assign('past-owned-session')).success,true);
  assert.equal(facade.database.prepare('SELECT profile_id FROM activity_logs WHERE content=?').get('past-owned-record').profile_id,initial.activePlayProfileId);
  const profileMemoBefore=config.load().pinnedNoteText;
  const deviceBytesBefore=fs.readFileSync(path.join(fixture,'config.json'),'utf8');
  // 선택한 프로필이 있는 동안 현재 세션의 기록은 그 프로필 소유로 쌓인다(선택 전 미배정 구간은 첫 선택 프로필 몫).
  facade.enqueue(session1,{amount:333},3333,'rollback-homework-event',initial.activePlayProfileId);
  const replayFailure=await service.select(initial.activePlayProfileId,(payload:any,eventId:string) => {
    assert.equal(config.saveConfirmed({pinnedNoteText:'실패한 이벤트의 숙제/설정 변경'}),true);
    applyEvent(payload,eventId);
    throw new Error('fixture replay failure');
  });
  assert.equal(replayFailure.success,true,'이미 확정된 프로필 선택은 보존');
  assert.match(replayFailure.error,/대기 기록/);
  assert.equal(facade.pending(session1).length,1,'반영 실패 이벤트는 ACK하지 않음');
  assert.equal(config.load().pinnedNoteText,profileMemoBefore,'대기 반영 rollback 후 config cache도 DB로 복구');
  assert.equal(facade.database.prepare('SELECT id FROM activity_logs WHERE content=?').get('rollback-homework-event'),undefined,'일지와 프로필 설정 함께 rollback');
  assert.equal(fs.readFileSync(path.join(fixture,'config.json'),'utf8'),deviceBytesBefore,'프로필 이벤트 transaction은 기기 JSON을 변경하지 않음');
  assert.equal((await service.select(initial.activePlayProfileId,applyEvent)).success,true);
  assert.equal(facade.pending(session1).length,0,'실패한 기록 재시도');
  allowTransition=false;
  duringTransition=() => service.dispatch({amount:444},applyEvent,4444,'cancelled-switch-event');
  assert.equal((await service.select(other.id,applyEvent)).success,false);
  assert.equal(service.status().selectionRequired,false,'취소한 전환은 기존 선택 유지');
  assert.equal(facade.pending(session1).length,0,'전환 취소 동안 들어온 기록도 기존 프로필에 반영');
  assert.equal(facade.database.prepare('SELECT profile_id FROM activity_logs WHERE content=?').get('cancelled-switch-event').profile_id,initial.activePlayProfileId);
  allowTransition=true;duringTransition=null;
  facade.database.exec("CREATE TRIGGER reject_new_session BEFORE UPDATE ON app_meta WHEN NEW.key='device_config_commit' BEGIN SELECT RAISE(ABORT,'fixture new session failure'); END;");
  assert.throws(() => service.beginSession('failed-new-game'),/선택 대기/);
  const failedNewSession=service.status().sessionId;
  assert.equal(service.status().selectionRequired,true,'새 세션 저장 실패도 자동 기록을 막음');
  service.dispatch({amount:555},applyEvent,5555,'failed-session-event');
  assert.equal(facade.database.prepare('SELECT id FROM activity_logs WHERE content=?').get('failed-session-event'),undefined,'실패 중 이전 선택 프로필에 쓰지 않음');
  assert.equal(facade.pending(failedNewSession).length,1);
  facade.database.exec('DROP TRIGGER reject_new_session');
  service.beginSession('failed-new-game');
  assert.equal(service.status().sessionId,failedNewSession,'저장 실패 재시도도 대기 세션 ID 유지');
  assert.equal((await service.select(initial.activePlayProfileId,applyEvent)).success,true);
  assert.equal(facade.pending(failedNewSession).length,0);
  let finishPrepare!:() => void;
  prepareWait=new Promise<void>(resolve => {finishPrepare=resolve;});
  const interruptedSelect=service.select(other.id,applyEvent);
  service.endSession();finishPrepare();
  assert.equal((await interruptedSelect).success,false,'전환 확인 중 게임 종료는 늦은 선택 저장 차단');
  assert.equal(service.status().activeProfileId,initial.activePlayProfileId);
  assert.equal(service.status().selectionRequired,true);
  prepareWait=null;
  service.endSession();
  const session2 = service.beginSession('game-process-2').sessionId;
  service.dispatch({amount:222},applyEvent,2222,'runtime-event-2');
  service.endSession();
  service.beginSession('game-process-3');
  assert.equal((await service.select(other.id,applyEvent)).success,true);
  assert.equal(facade.pending(session2).length,1,'이전 세션은 다음 선택에 자동 배정하지 않음');
  const confirmed=facade.pendingSessionSnapshot(session2)!.token;
  assert.match((await assign(session2,initial.activePlayProfileId,confirmed)).error,/사용 중인 프로필이 변경/);
  assert.equal(facade.pending(session2).length,1);
  facade.enqueue(session2,{amount:223},2223,'runtime-event-2-later');
  assert.match((await assign(session2,other.id,confirmed)).error,/대기 기록이 변경/);
  assert.equal(facade.pending(session2).length,2);
  assert.equal((await assign(session2)).success,true);
  assert.equal(facade.pending(session2).length,0,'명시적 이전 세션 배정');
  // 확인한 행만 포함하며 배치 사이에 Win32/IPC 이벤트 루프가 진행된다.
  const large='large-replay-fixture';
  facade.database.transaction(()=>{
    for(let index=0;index<385;index++)facade.enqueue(large,{amount:index+1},index,`large-replay-${index}`);
  })();
  const largeToken=facade.pendingSessionSnapshot(large).token;
  let partialCommitted=0;
  const observeReplay=new Promise<void>(resolve=>setImmediate(()=>{
    partialCommitted=385-facade.pendingReplayBoundary(large,other.id,true).count;
    facade.enqueue(large,{amount:900},-1,'outside-confirmed-boundary');
    resolve();
  }));
  const batched=service.assignSession(large,other.id,largeToken,(payload:any,id:string)=>{
    if (id==='large-replay-150') throw new Error('fixture interrupted batch');
    return applyEvent(payload,id);
  });
  await observeReplay;
  assert.ok(partialCommitted>0 && partialCommitted<385,'일부만 확정된 상태에서 이벤트 루프가 진행');
  assert.match((await batched).error,/interrupted batch/);
  assert.equal(facade.eventRecordState('large-replay-150').resolved,false);
  assert.equal(facade.eventRecordState('outside-confirmed-boundary').resolved,false);
  assert.equal((await assign(large)).success,true,'중단 뒤 남은 행만 재시도');
  assert.equal(facade.pending(large).length,0);
  const selectingSession=service.status().sessionId;
  facade.database.transaction(()=>{
    // 전환 대상 프로필 소유로 남은 대기 기록(이전 저장 실패분)을 일괄 재생한다. 현재 세션의 미배정 행은
    // 그 선택 대기 구간을 끝낸 프로필 몫이라 다른 프로필로 전환해도 가져가지 않는다(check-profile-recording.ts).
    for(let index=0;index<140;index++) facade.enqueue(selectingSession,{amount:index+1},index,`select-replay-${index}`,other.id);
  })();
  let liveDuringReplay:Promise<void> | undefined;
  let liveWasQueued=false;
  const completedSelection=await service.select(other.id,(payload:any,id:string)=>{
    if(id==='select-replay-0') liveDuringReplay=new Promise(resolve=>setImmediate(()=>{
      service.dispatch({amount:900},applyEvent,-1,'live-during-replay');
      liveWasQueued=facade.eventRecordState('live-during-replay')?.resolved===false;
      resolve();
    }));
    return applyEvent(payload,id);
  });
  assert.ok(liveDuringReplay);
  await liveDuringReplay;
  assert.equal(liveWasQueued,true,'반영 도중 들어온 이벤트는 이전 대기 이벤트 뒤에 처리');
  assert.equal(completedSelection.error,undefined);
  assert.equal(facade.pending(selectingSession).length,0);
  assert.equal(facade.database.prepare('SELECT profile_id FROM activity_logs WHERE content=?').get('live-during-replay').profile_id,other.id);
  const beforeDeleteStatus=service.status();
  const beforeDeleteRecords=facade.database.prepare('SELECT COUNT(*) n FROM activity_logs').get().n;
  facade.database.exec("CREATE TRIGGER reject_delete BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END;");
  assert.equal((await service.remove(other.id)).success,false);
  assert.equal(service.status().activeProfileId,beforeDeleteStatus.activeProfileId,'삭제 저장 실패 시 선택 보존');
  assert.equal(facade.list().length,2,'삭제 저장 실패 시 프로필 보존');
  facade.database.exec('DROP TRIGGER reject_delete');
  assert.equal((await service.remove(other.id)).success,true);
  assert.equal((await service.remove(initial.activePlayProfileId)).success,true);
  assert.equal(service.status().profiles.length,1,'삭제 제어 경로도 기본 하나 보장');
  assert.equal(service.status().selectionRequired,true);
  assert.equal(config.load().activePlayProfileId,service.status().profiles[0].id);
  assert.equal(facade.database.prepare('SELECT COUNT(*) n FROM activity_logs').get().n,beforeDeleteRecords,'삭제 제어 경로 일지 보존');
  const {ProfileGameLifecycle}=require(path.join(root,'dist/modules/profileGameLifecycle.js'));
  let selectionWindows=0;
  const lifecycle=new ProfileGameLifecycle(service,() => {++selectionWindows;});
  lifecycle.observe('minimized');
  const hiddenStartupSession=service.status().sessionId;
  assert.ok(hiddenStartupSession);
  assert.equal(selectionWindows,0,'최소화/숨김 시작은 기록 세션만 준비하고 선택창을 열지 않음');
  lifecycle.observe('minimized');assert.equal(selectionWindows,0);
  lifecycle.observe('running');lifecycle.observe('minimized');lifecycle.observe('running');
  assert.equal(selectionWindows,1,'최소화 복귀는 선택창 반복 없음');
  assert.equal(service.status().sessionId,hiddenStartupSession,'동일 게임 세션 유지');
  lifecycle.observe('not-running');lifecycle.observe('not-running');lifecycle.observe('running');
  assert.equal(selectionWindows,2,'실제 종료 후 재시작만 새 선택');
  assert.notEqual(service.status().sessionId,hiddenStartupSession);
  lifecycle.observe('not-running');
  let failedOpen=true;
  const retryLifecycle=new ProfileGameLifecycle(service,() => {if (failedOpen) throw new Error('fixture open failure');++selectionWindows;});
  assert.throws(() => retryLifecycle.observe('running'),/open failure/);
  const retrySession=service.status().sessionId;
  failedOpen=false;retryLifecycle.observe('running');
  assert.equal(service.status().sessionId,retrySession,'창 재시도는 대기 기록의 세션을 바꾸지 않음');
  retryLifecycle.observe('not-running');
  facade.database.exec("CREATE TRIGGER reject_session BEFORE UPDATE ON app_meta WHEN NEW.key='device_config_commit' BEGIN SELECT RAISE(ABORT,'fixture session failure'); END;");
  assert.throws(() => retryLifecycle.observe('running'),/선택 대기/);
  assert.equal(selectionWindows,3,'선택 대기 저장 실패 시 창을 성공 처리하지 않음');
  facade.database.exec('DROP TRIGGER reject_session');
  retryLifecycle.observe('running');
  assert.equal(selectionWindows,4,'다음 감지에서 재시도');
  assert.equal(service.status().selectionRequired,true);
  retryLifecycle.observe('not-running');
  const manualLifecycle=new ProfileGameLifecycle(service,()=>{++selectionWindows;});
  manualLifecycle.observe('minimized');const manualSession=service.status().sessionId;
  const manualId=service.status().profiles[0].id;assert.equal(service.update(manualId,'숨김 중 수동 선택',7).success,true);
  service.dispatch({amount:13},applyEvent,Date.now(),'hidden-manual-event');assert.equal(facade.pending(manualSession).length,1);
  assert.equal((await service.select(manualId,applyEvent)).success,true);
  manualLifecycle.observe('running');assert.equal(selectionWindows,4,'숨김 중 시스템 메뉴에서 선택했다면 복귀 때 자동 선택창 없음');
  assert.equal(service.status().sessionId,manualSession);assert.equal(facade.pending(manualSession).length,0);
  manualLifecycle.observe('not-running');manualLifecycle.observe('minimized');const neverShownSession=service.status().sessionId;
  manualLifecycle.observe('not-running');manualLifecycle.observe('running');
  assert.equal(selectionWindows,5,'최소화 상태에서 종료한 게임은 다음 실제 실행에서 새로 선택');
  assert.notEqual(service.status().sessionId,neverShownSession);
  const resyncSession=service.status().sessionId;
  assert.equal((await service.select(manualId,applyEvent)).success,true);
  service.acceptSyncSelection();
  manualLifecycle.observe('minimized');assert.equal(selectionWindows,5);
  manualLifecycle.observe('running');manualLifecycle.observe('running');
  assert.equal(selectionWindows,6,'같은 게임에서도 Google 재선택 요청에 한 번만 표시');
  assert.equal(service.status().sessionId,resyncSession);
  const firstDay=Date.UTC(2026,10,20),secondDay=Date.UTC(2026,10,21);
  service.dispatch({amount:1},applyEvent,firstDay,'unassigned-first-day',true);
  service.dispatch({amount:1},applyEvent,secondDay,'unassigned-second-day',true);
  manualLifecycle.observe('not-running');manualLifecycle.observe('running');
  service.dispatch({amount:1},applyEvent,secondDay,'unassigned-next-game',true);
  const unassigned=facade.pending().filter((event:any)=>event.eventId.startsWith('unassigned-'));
  assert.equal(new Set(unassigned.map((event:any)=>event.sessionId)).size,3);
  facade.enqueue('outside-game-unassigned',{data:{date:'2026-11-20'},source:{fingerprint:'old-file',start:20}},firstDay,'legacy-first');
  facade.enqueue('outside-game-unassigned',{data:{date:'2026-11-20'},source:{fingerprint:'old-file',start:21}},firstDay,'legacy-second');
  facade.close();facade.reopen();
  const legacySplit=facade.pending().filter((event:any)=>['legacy-first','legacy-second'].includes(event.eventId));
  assert.equal(new Set(legacySplit.map((event:any)=>event.sessionId)).size,2);
  facade.close();
  const { ProfileClock } = require(path.join(root,'dist/modules/profileClock.js'));
  let elapsed = 0,queries = 0,wall=7_000_000;
  const clock = new ProfileClock(async () => {queries++;return {utcMs:1_000_000,uncertaintyMs:20};},() => elapsed,()=>wall);
  assert.equal(clock.now().source,'unverified','조회 전 PC 시간을 인터넷 시간으로 표시하지 않음');
  const firstRefresh = clock.refresh();
  assert.equal(clock.refresh(),firstRefresh,'중복 인터넷 시간 요청 병합');
  assert.equal(await firstRefresh,true);
  assert.equal(queries,1);
  elapsed=5000;wall+=3_600_000;
  assert.equal(clock.now().utcMs,1_005_000,'단조 경과시간 기준');
  assert.equal(clock.now().source,'internet');
  elapsed=3_600_001;
  assert.equal(clock.now().source,'unverified','오래된 기준 신뢰도 만료');
  assert.equal(clock.now().utcMs,wall,'신뢰 기간이 끝나면 현재 Windows 시간을 사용한다');
  const failedClock = new ProfileClock(() => {throw new Error('offline');},()=>elapsed,()=>wall);
  assert.equal(await failedClock.refresh(),false);
  const oldStamp=failedClock.now();
  wall-=3_600_000;
  assert.equal(await failedClock.refresh(),false,'실패 후 재시도 가능');
  assert.equal(failedClock.now().utcMs,wall,'오프라인 Windows 시간 변경을 반영한다');
  assert.equal(oldStamp.utcMs,wall+3_600_000,'이미 만든 타임스탬프는 바뀌지 않는다');
  const samples:Array<(sample:{utcMs:number;uncertaintyMs:number})=>void>=[];
  const resumedClock=new ProfileClock(()=>new Promise(resolve=>samples.push(resolve)),()=>elapsed,()=>wall);
  const preSleep=resumedClock.refresh();await Promise.resolve();
  resumedClock.invalidate();
  const postWake=resumedClock.refresh();await Promise.resolve();
  assert.notEqual(preSleep,postWake);
  samples[0]({utcMs:100,uncertaintyMs:1});
  assert.equal(await preSleep,false);
  assert.equal(resumedClock.now().source,'unverified');
  assert.equal(resumedClock.refresh(),postWake,'이전 조회의 완료가 복귀 후 요청을 해제하지 않는다');
  samples[1]({utcMs:500,uncertaintyMs:2});
  assert.equal(await postWake,true);
  assert.equal(resumedClock.now().utcMs,500);
  // 결정적으로 실패하는 이전은 시도마다 staging DB/백업 사본을 남기지 않는다. 원본은 그대로 둔다.
  const failedDirectory = directory('failed-migration');
  const failedLegacy = {...base(),characterPresets:[{id:'dup',name:'중복 1'},{id:'dup',name:'중복 2'}],selectedCharacterId:'dup',
    pendingHomeworks:[{id:'custom-old',count:2,isIncrement:true,timestamp:1_700_000_000_000},
      {id:'custom-old',count:1,isIncrement:true},{id:'custom-old',count:3,isIncrement:false,timestamp:'어제'},null]};
  fs.writeFileSync(path.join(failedDirectory,'config.json'),JSON.stringify(failedLegacy));
  const failedSource = new Database(path.join(failedDirectory,'diary.db'));
  failedSource.exec('CREATE TABLE activity_logs(id INTEGER PRIMARY KEY, content TEXT, amount INTEGER)');
  failedSource.prepare('INSERT INTO activity_logs VALUES(?,?,?)').run(1,'실패 이전 원본',77);failedSource.close();
  const abandonedStaging = path.join(failedDirectory,'app-data-migration-00000000-0000-4000-8000-000000000000.db');
  fs.writeFileSync(abandonedStaging,'강제 종료로 남은 staging');fs.writeFileSync(`${abandonedStaging}-wal`,'');
  const failedSourceBytes = fs.readFileSync(path.join(failedDirectory,'diary.db'));
  const migrationLeftovers = () => ({
    staging:fs.readdirSync(failedDirectory).filter(name => name.startsWith('app-data-migration-')),
    backups:fs.existsSync(path.join(failedDirectory,'backups')) ? fs.readdirSync(path.join(failedDirectory,'backups')).filter(name => name.startsWith('before-play-profiles-')) : [],
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(() => ApplicationData.initialize({directory:failedDirectory,deviceId:'PC-failed',defaults},failedLegacy),/중복/);
    assert.deepEqual(migrationLeftovers(),{staging:[],backups:[]},'실패한 이전 시도의 staging DB와 백업 사본을 남기지 않는다');
    assert.equal(fs.existsSync(path.join(failedDirectory,'app-data.db')),false);
  }
  assert.deepEqual(fs.readFileSync(path.join(failedDirectory,'diary.db')),failedSourceBytes,'실패한 이전은 원본 diary.db를 바꾸지 않는다');
  // 시각이 없거나 손상된 구형 보류 숙제도 이전을 막지 않고 원본 그대로 배정 불가 대기로 보존한다.
  const repairedLegacy = {...failedLegacy,characterPresets:[{id:'dup',name:'정상 캐릭터'}]};
  const repaired = await ApplicationData.initialize({directory:failedDirectory,deviceId:'PC-failed',defaults},repairedLegacy);
  const leftovers = migrationLeftovers();
  assert.deepEqual(leftovers.staging,[],'성공 뒤에도 staging 파일 없음');
  assert.equal(leftovers.backups.length,1,'성공한 이전의 백업은 하나만 보관');
  const completed = JSON.parse(repaired.database.prepare("SELECT value FROM app_meta WHERE key='legacy_migration_complete'").get().value);
  assert.equal(path.basename(completed.backup),leftovers.backups[0],'완료 표식이 보관한 백업을 가리킨다');
  assert.ok(fs.existsSync(path.join(completed.backup,'diary.db')) && fs.existsSync(path.join(completed.backup,'config.json')));
  const legacyRows = repaired.database.prepare("SELECT occurred_at,payload FROM pending_profile_events WHERE session_id='legacy-unassigned' ORDER BY rowid").all()
    .map((row:any) => ({occurredAt:row.occurred_at,value:JSON.parse(row.payload).value}));
  assert.deepEqual(legacyRows,failedLegacy.pendingHomeworks.map((value:any) => ({occurredAt:value?.timestamp===1_700_000_000_000 ? value.timestamp : 0,value})),
    '유효한 시각은 유지하고 손상된 시각은 0으로 두며 원본 항목을 그대로 보존');
  const {readLegacyPendingHomework} = require(path.join(root,'dist/shared/legacyHomework.js'));
  assert.deepEqual(legacyRows.map((row:any) => !!readLegacyPendingHomework(row.value)),[true,false,false,false],'손상 항목은 재생 단계에서 배정 불가');
  const {readProfilePendingDetails} = require(path.join(root,'dist/modules/profilePendingPreview.js'));
  const legacySession = repaired.pendingSessions().filter((session:any) => session.sessionId==='legacy-unassigned');
  assert.equal(readProfilePendingDetails(repaired,legacySession,new Map())['legacy-unassigned'].unassignableCount,3,'프로필 화면의 배정 불가 안내 경로');
  // 구형 설정 ZIP 복원도 같은 변환을 사용하며 다시 복원해도 대기 행을 늘리지 않는다.
  const restoredLegacyPending = () => repaired.database.prepare("SELECT occurred_at,payload FROM pending_profile_events WHERE session_id='legacy-backup-homework' ORDER BY rowid").all();
  const legacyBackup = {...repairedLegacy,pendingHomeworks:[...failedLegacy.pendingHomeworks,{id:'restore-only',count:4,isIncrement:true,timestamp:Number.NaN}]};
  repaired.restoreLegacyConfiguration(legacyBackup,undefined);
  const restoredOnce = restoredLegacyPending();
  assert.equal(restoredOnce.length,1,'이미 이전된 같은 원본은 다시 넣지 않고 새 항목만 보존');
  assert.equal(restoredOnce[0].occurred_at,0);
  assert.equal(JSON.parse(restoredOnce[0].payload).value.id,'restore-only');
  repaired.restoreLegacyConfiguration(legacyBackup,undefined);
  assert.deepEqual(restoredLegacyPending(),restoredOnce,'같은 구형 백업 재복원은 멱등');
  repaired.close();
  const corruptDirectory = directory('unsupported');
  const unsupportedFile = path.join(corruptDirectory,'app-data.db');
  const unsupported = new Database(unsupportedFile);
  unsupported.exec('CREATE TABLE unrelated(value TEXT)'); unsupported.close();
  await assert.rejects(() => ApplicationData.initialize({directory:corruptDirectory,deviceId:'PC-corrupt',defaults},base()),/app_meta/);
  fs.renameSync(unsupportedFile,`${unsupportedFile}.preserved`);
  assert.ok(fs.existsSync(`${unsupportedFile}.preserved`),'알 수 없는 DB는 덮어쓰지 않고 핸들도 해제');
  const incompleteDirectory=directory('incomplete');
  const incompleteFile=path.join(incompleteDirectory,'app-data.db');
  const incomplete=new Database(incompleteFile);
  incomplete.exec("CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_meta VALUES('schema_version','1');");incomplete.close();
  await assert.rejects(() => ApplicationData.initialize({directory:incompleteDirectory,deviceId:'PC-incomplete',defaults},base()),/지원하지 않는/);
  fs.renameSync(incompleteFile,`${incompleteFile}.preserved`);
  console.log('PASS profile storage: SQLite/WAL migration, profile count, server provenance, isolated settings/homework, atomic outbox, durable sequence/pending, mixed JSON/DB commit rollback/crash recovery and deletion preservation.');
}
run().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
