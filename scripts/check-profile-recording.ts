/** 실제 로그 파서·프로세서·숙제·추적기와 SQLite transaction/재시도/프로필 전환. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,dialog} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-recording-'));
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const sounds:unknown[]=[];
require.cache[path.join(root,'dist/modules/windowManager.js')]={exports:{getGameOverlayWindow:() => null,sendPlaySound:(value:unknown) => sounds.push(value),applySettings:() => true}} as NodeModule;
const pause=(ms:number) => new Promise(resolve => setTimeout(resolve,ms));

async function run():Promise<void> {
  await app.whenReady();
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  const legacy={...structuredClone(defaults),userServer:7,xpAutoStart:true,abandonedEnabled:true,buffTimerEnabled:true,specialMonsterAlertEnabled:true,specialMonsterAlertSound:'orb.mp3',
    lootKeywords:['하급 마정석'],characterPresets:[{id:'A',name:'사냥 A'},{id:'B',name:'사냥 B'}],selectedCharacterId:'A',
    contentsCheckerItems:[{id:'weekly-eternal-floor',name:'이터널 플로어',category:'test',isVisible:true,maxCount:3,resetRule:{type:'daily',hour:0},completedState:{}}]};
  assert.equal(config.saveConfirmed(legacy),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  const a=store.list().find((profile:any) => profile.name==='사냥 A'),b=store.list().find((profile:any) => profile.name==='사냥 B');
  store.saveProjection(b.id,{...store.project(b.id,config.load()),userServer:16});
  const parser=built('modules/chatParser').chatParser,processor=built('modules/chatLogProcessor').chatLogProcessor;
  const xp=built('modules/xpTracker').xpTracker,buffs=built('modules/buffTimerManager').buffTimerManager;
  const abandoned=built('modules/abandonedTracker').abandonedTracker,contents=built('modules/contentsChecker');
  processor.start();buffs.start();
  const listenerCount=parser.listenerCount('XP_CHANGED');processor.start();buffs.start();
  assert.equal(parser.listenerCount('XP_CHANGED'),listenerCount);
  let opened=0;
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {opened++;}});
  const {service,replay,onGameState}=controller.runtime;
  onGameState('running');onGameState('minimized');onGameState('running');assert.equal(opened,1);
  const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const time=(offset=0) => {const t=new Date(Date.now()+offset);return `${t.getHours()}시 ${t.getMinutes()}분 ${t.getSeconds()}초`;};
  parser.setCurrentDate(date);
  const line=(message:string,t=time()) => parser.parseLine(`<font size="2" color="white"> [${t}] </font><font size="2" color="#ff64ff">${message}</font></br>`);
  const fee=(amount:number) => line(`입장료 ${amount} Seed를 지불하였습니다.`);
  const gain=(amount:number) => line(`경험치가 ${amount} 올랐습니다.`);
  const stateCount=(id:string) => store.homework(id)[0].completedState[id]?.currentCount || 0;
  const net=(id:string) => diary.getMonthlySummary(date.slice(0,7),undefined,{kind:'profile',profileId:id}).totalSeed;
  const rows=() => store.database.prepare('SELECT COUNT(*) n FROM activity_logs').get().n;
  fee(100);line('이번 주 어벤던로드 카디프 지역의 도전 횟수는 1번 입니다.');gain(50);
  line('[경험의 심장]을 사용하였습니다.');line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.');
  assert.equal(store.pending().length,6,'한 파서 이벤트의 여러 소비자를 한 건으로 보관 (상자는 아이템/숙제 이벤트 각 한 건)');
  assert.equal(rows(),0);assert.equal(xp.getStats().total,0);assert.equal(abandoned.getState().totalFee,0);assert.equal(buffs.getActiveBuffs().length,0);
  assert.ok(processor.getChatHistory('System').some((item:any) => item.message==='경험치가 50 올랐습니다.'),'프로필 선택 전에도 채팅 표시');
  const pendingBefore=store.pending().length;
  for (let n=0;n<20;n++) line(`평범한 시스템 안내 ${n}`);
  assert.equal(store.pending().length,pendingBefore,'순수 채팅을 프로필 대기로 복제하지 않는다');
  const historyCount=processor.getChatHistory('System').length;
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal(store.pending().length,0);assert.equal(net(a.id),-100);assert.equal(xp.getStats().total,50);
  assert.equal(stateCount(a.id),1);assert.equal(abandoned.getState().regionDetails['카디프'].totalFee,100);
  assert.equal(buffs.getActiveBuffs().length,1);
  assert.equal(processor.getChatHistory('System').length,historyCount,'대기 재생은 채팅을 중복 표시하지 않는다');
  const buffStart=buffs.getActiveBuffs()[0].startTime;
  const inactive=store.project(b.id,config.load());
  inactive.contentsCheckerItems[0].completedState[b.id]={currentCount:3,isCompleted:true,lastCompletedAt:Date.now()-2*86400000};
  inactive.contentsCheckerItems.push({id:'custom-weekly-expiry',name:'주간 만료',isCustom:true,isVisible:true,category:'주간',maxCount:3,
    resetRule:{type:'weekly',dayOfWeek:0,hour:6},completedState:{[b.id]:{currentCount:2,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()-8*86400000}}});
  store.saveProjection(b.id,inactive);
  const prior=new Date(Date.now()-2*86400000),priorDate=`${prior.getFullYear()}-${String(prior.getMonth()+1).padStart(2,'0')}-${String(prior.getDate()).padStart(2,'0')}`;
  store.withRecordContext(b.id,'previous-cycle',()=>assert.equal(diary.addHomeworkLog(priorDate,'weekly-eternal-floor','이터널 플로어','test','daily',prior.getTime()),true));
  store.database.exec(`CREATE TRIGGER reject_profile_reset BEFORE INSERT ON diary_profile_days WHEN NEW.profile_id='${b.id}' BEGIN SELECT RAISE(ABORT,'fixture reset failure');END`);
  assert.equal((await service.select(b.id,replay)).success,false,'만료 초기화에 실패한 전환은 성공으로 처리하지 않는다.');
  assert.equal(service.status().activeProfileId,a.id);
  assert.equal(stateCount(b.id),3,'초기화 집계 실패는 해당 숙제 상태도 rollback한다.');
  assert.equal(store.homework(b.id).find((item:any)=>item.id==='custom-weekly-expiry').completedState[b.id].currentCount,2);
  assert.equal(xp.getStats().total,50,'실패한 전환은 기존 진행 상태를 복원한다.');
  store.database.exec('DROP TRIGGER reject_profile_reset');
  assert.equal((await service.select(b.id,replay)).success,true);
  assert.equal(stateCount(b.id),0,'비활성 동안 주기가 지난 숙제는 선택 즉시 초기화한다.');
  const resetWeekly=store.homework(b.id).find((item:any)=>item.id==='custom-weekly-expiry').completedState[b.id];
  assert.equal(resetWeekly.currentCount,0);assert.equal(resetWeekly.isExcluded,true,'주간 초기화는 N/A 선택을 보존한다.');
  assert.equal(diary.getDiaryByDate(priorDate,undefined,{kind:'profile',profileId:b.id}).homeworkLogs.length,1,'지난 완료 일지는 초기화로 삭제하지 않는다.');
  assert.equal(config.load().userServer,16);assert.equal(xp.getStats().total,0);assert.equal(buffs.getActiveBuffs().length,0);
  assert.equal(abandoned.getState().totalFee,0);assert.equal(contents.getLatestDetectedHomework(config.load()),null);
  line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.');
  assert.equal(stateCount(b.id),1,'화면을 열지 않아도 새 주기의 첫 자동 감지가 1회부터 시작한다.');
  gain(25);fee(20);line('콘텐츠 클리어 보상으로 500 SEED를 획득했습니다.');
  assert.equal(net(b.id),480);assert.equal(net(a.id),-100);
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal(xp.getStats().total,50);assert.equal(abandoned.getState().totalFee,100);
  assert.equal(buffs.getActiveBuffs()[0].startTime,buffStart);
  const outbox=store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n;
  controller.checkpoint();assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_change_log').get().n,outbox,'실행 상태는 Google 변경 이력에 넣지 않는다');

  // DB 실패는 ACK·런타임/소리를 확정하지 않으며 성공 후 원래 이벤트를 한 번 반영한다.
  store.database.exec("CREATE TRIGGER reject_profile_record BEFORE INSERT ON activity_logs BEGIN SELECT RAISE(ABORT,'fixture activity failure');END");
  assert.throws(() => fee(33));assert.equal(net(a.id),-100);assert.equal(abandoned.getState().totalFee,100);assert.equal(store.pending().length,1);
  store.database.exec('DROP TRIGGER reject_profile_record');
  assert.equal((await service.select(a.id,replay)).success,true);assert.equal(net(a.id),-133);assert.equal(abandoned.getState().totalFee,133);
  store.database.exec("CREATE TRIGGER reject_profile_settings BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture settings failure');END");
  assert.throws(() => line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.',time(1000)));
  assert.equal(stateCount(a.id),1);assert.equal(config.hasPending(),false);assert.equal(store.pending().length,1);
  store.database.exec('DROP TRIGGER reject_profile_settings');
  assert.equal((await service.select(a.id,replay)).success,true);assert.equal(stateCount(a.id),2);
  line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.',time(2000));assert.equal(stateCount(a.id),3);
  assert.equal(diary.getDiaryByDate(date,undefined,{kind:'profile',profileId:a.id}).homeworkLogs.length,1);
  store.database.exec("CREATE TRIGGER reject_profile_ack BEFORE UPDATE ON pending_profile_events WHEN NEW.resolved_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture ACK failure');END");
  const essences=xp.getStats().essenceCount,activityBefore=rows();
  assert.throws(() => line('경험치가 10000000000 감소했습니다.'));
  assert.equal(rows(),activityBefore);assert.equal(xp.getStats().essenceCount,essences);assert.equal(store.pending().length,1);
  store.database.exec('DROP TRIGGER reject_profile_ack');
  assert.equal((await service.select(a.id,replay)).success,true);assert.equal(rows(),activityBefore+1);assert.equal(xp.getStats().essenceCount,essences+1);
  assert.equal((await service.select(a.id,replay)).success,true);assert.equal(rows(),activityBefore+1);
  const soundCount=sounds.length;
  store.database.exec("CREATE TRIGGER reject_alert_ack BEFORE UPDATE ON pending_profile_events WHEN NEW.resolved_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture alert ACK failure');END");
  assert.throws(() => parser.emit('SPECIAL_MONSTER_SPAWN',{date,timestamp:time(),message:'특별 몬스터 출현'}));
  assert.equal(sounds.length,soundCount,'알림도 ACK 실패 전에 실행하지 않는다');
  store.database.exec('DROP TRIGGER reject_alert_ack');
  assert.equal((await service.select(a.id,replay)).success,true);assert.equal(sounds.length,soundCount+1);
  parser.emit('SPECIAL_MONSTER_SPAWN',{date,timestamp:time(-60000),message:'지난 특별 몬스터 출현'});
  assert.equal(sounds.length,soundCount+1,'지난 순간 알림은 다시 울리지 않는다');

  // 미선택 종료 세션은 다음 세션에서 자동 배정하지 않고 수동 배정도 현재 HUD를 바꾸지 않는다.
  service.beginSession('old-unselected');const old=service.status().sessionId;gain(999);fee(11);
  onGameState('not-running');onGameState('running');gain(9);fee(7);
  assert.equal((await service.select(b.id,replay)).success,true);assert.equal(xp.getStats().total,34);assert.equal(abandoned.getState().totalFee,27);
  assert.equal(store.pending(old).length,2);const soundsBefore=sounds.length;
  assert.equal(service.assignSession(old,replay).success,true);assert.equal(store.pending(old).length,0);
  assert.equal(xp.getStats().total,34);assert.equal(abandoned.getState().totalFee,27);assert.equal(sounds.length,soundsBefore);
  assert.equal(net(b.id),462);
  // 고빈도 XP를 중복 리스너 없이 처리하고 현재 프로필만 갱신한다.
  const started=Date.now();for (let n=0;n<100;n++) gain(1);
  assert.equal(xp.getStats().total,134);assert.equal(store.pending().length,0);
  console.log(`100 live XP records: ${Date.now()-started} ms`);
  parser.emit('DIGSITE_ENTRY',{date,timestamp:time(-6*60000),count:1,message:'지난 발굴지 입장'});
  assert.equal(processor.getDigsiteState().isActive,false,'대기 재생으로 5분 현황판을 다시 시작하지 않는다');
  await pause(200);
  const backupFile=path.join(fixture,'runtime-backup.zip'),saveDialog=dialog.showSaveDialog;
  try {
    (dialog as any).showSaveDialog=async () => ({canceled:false,filePath:backupFile});
    assert.equal(await built('modules/backupManager').exportBackup({}),true);
    const archived=path.join(fixture,'runtime-archive');new (require('adm-zip'))(backupFile).extractAllTo(archived,false);
    const copy=new (require('better-sqlite3'))(path.join(archived,'app-data.db'),{readonly:true,fileMustExist:true});
    try {assert.equal(JSON.parse(copy.prepare('SELECT value FROM profile_runtime_state WHERE profile_id=?').get(b.id).value).xp.total,134,'실제 ZIP 백업 직전에 현재 진행 상태를 확정');} finally {copy.close();}
  } finally {dialog.showSaveDialog=saveDialog;}
  controller.checkpoint();assert.equal((await service.select(a.id,replay)).success,true);assert.equal(xp.getStats().total,50);
  await service.select(b.id,replay);
  const savedA=store.runtimeState(a.id);savedA.buffs[0].startTime=Date.now()-2*60*60000;store.saveRuntimeState(a.id,savedA);
  await service.select(a.id,replay);assert.equal(buffs.getActiveBuffs().length,0,'다른 프로필을 사용하는 동안 만료된 버프는 복구하지 않는다');
  // 선택 대기 때 이전 프로필의 버프 tick/진행 상태를 남기지 않는다.
  onGameState('not-running');assert.equal(xp.getStats().isActive,false);assert.equal(buffs.getActiveBuffs().length,0);
  controller.dispose();assert.equal(xp.getStats().total,0);
  const restored=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {}});
  restored.runtime.onGameState('running');
  assert.equal((await restored.runtime.service.select(b.id,restored.runtime.replay)).success,true);
  assert.equal(xp.getStats().total,134,'기록 경로를 다시 조립해도 DB에 보존한 원래 진행을 복원');
  gain(1);assert.equal(xp.getStats().total,135,'다시 조립해도 파서 소비자가 중복 반영하지 않는다');
  restored.dispose();prepared.stopClock();buffs.stop();assert.equal(diary.closeDb(),true);
  console.log('Profile recording: real parser routing, chat continuity, one-event/many-consumers, atomic diary/homework/ACK, failed retry, runtime isolation and old-session assignment passed.');
}
run().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
