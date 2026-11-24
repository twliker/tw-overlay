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
const mechanicAlerts:string[]=[];
let treasureAlerts=0;
const abyssDeadlines:number[]=[];
require.cache[path.join(root,'dist/modules/windowManager.js')]={exports:{getGameOverlayWindow:() => ({isDestroyed:() => false,webContents:{send:(channel:string,data?:{endsAt:number}) => {
  if (channel==='abyss-apostle-alert' && data) abyssDeadlines.push(data.endsAt);
  if (channel==='abyss-treasure-complete-alert') treasureAlerts++;
  if (['ethos-alert','abyss-apostle-alert','wave-warning-alert','lokagos-alert'].includes(channel)) mechanicAlerts.push(channel);
}}}),sendPlaySound:(value:unknown) => sounds.push(value),applySettings:() => true}} as NodeModule;
const pause=(ms:number) => new Promise(resolve => setTimeout(resolve,ms));

async function run():Promise<void> {
  await app.whenReady();
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  const legacy={...structuredClone(defaults),userServer:7,xpAutoStart:true,abandonedEnabled:true,buffTimerEnabled:true,specialMonsterAlertEnabled:true,specialMonsterAlertSound:'orb.mp3',
    ethosAlertEnabled:false,abyssApostleAlertEnabled:false,waveMonsterWarningEnabled:false,lokagosAlertEnabled:false,abyssApostleEndSound:'none',
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
  const {canControlProfileXp}=built('modules/profileRuntime');
  assert.equal(canControlProfileXp(a.id,true),false,'선택 전에는 XP 명령을 실행할 수 없다.');
  const assign=(id:string)=>service.assignSession(id,service.status().activeProfileId,store.pendingSessionSnapshot(id)?.token ?? '',replay);
  onGameState('running');onGameState('minimized');onGameState('running');assert.equal(opened,1);
  const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const time=(offset=0) => {const t=new Date(Date.now()+offset);return `${t.getHours()}시 ${t.getMinutes()}분 ${t.getSeconds()}초`;};
  parser.setCurrentDate(date);
  const {parseChatLogDateHeader}=built('modules/chatParser');
  assert.equal(parseChatLogDateHeader('<font size="2" color="white"> <b> Date : 2026년  4월 22일 </b></font></br></br></br>\r'),'2026-04-22','실제 게임 헤더');
  assert.equal(parseChatLogDateHeader('﻿Date : 2026년 8월 25일'),'2026-08-25');
  assert.equal(parseChatLogDateHeader('Date : 2026-07-28'),'2026-07-28','개발용 주입 헤더');
  for (const spoof of [
    '<font size="2" color="white"> [13시 47분 0초] </font><font size="2" color="#c896c8">Date : 2000-01-01</font></br>',
    '<font size="2" color="white"> [ 9시 1분 1초 ] </font><font size="2" color="#ffffff"> <b> Date : 2000년 1월 1일 </b></font></br>',
    '<font size="2" color="#ffffff">장난꾸러기 : Date : 2000-01-01</font></br>',
    'Date : 2000-01-01 이후로 바뀜',
  ]) assert.equal(parseChatLogDateHeader(spoof),null,`채팅 줄은 날짜 헤더가 아니다: ${spoof}`);
  const line=(message:string,t=time()) => parser.parseLine(`<font size="2" color="white"> [${t}] </font><font size="2" color="#ff64ff">${message}</font></br>`);
  const fee=(amount:number) => line(`입장료 ${amount} Seed를 지불하였습니다.`);
  const gain=(amount:number) => line(`경험치가 ${amount} 올랐습니다.`);
  const stateCount=(id:string) => store.homework(id)[0].completedState[id]?.currentCount || 0;
  const net=(id:string) => diary.getMonthlySummary(date.slice(0,7),undefined,{kind:'profile',profileId:id}).totalSeed;
  const rows=() => store.database.prepare('SELECT COUNT(*) n FROM activity_logs').get().n;
  fee(100);line('이번 주 어벤던로드 카디프 지역의 도전 횟수는 1번 입니다.');
  line('경험치가 50 올랐습니다.',time(-60_000));
  line('[경험의 심장]을 사용하였습니다.');line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.');
  assert.equal(store.pending().length,6,'한 파서 이벤트의 여러 소비자를 한 건으로 보관 (상자는 아이템/숙제 이벤트 각 한 건)');
  assert.equal(rows(),0);assert.equal(xp.getStats().total,0);assert.equal(abandoned.getState().totalFee,0);assert.equal(buffs.getActiveBuffs().length,0);
  assert.ok(processor.getChatHistory('System').some((item:any) => item.message==='경험치가 50 올랐습니다.'),'프로필 선택 전에도 채팅 표시');
  const pendingBefore=store.pending().length;
  const spawnSoundCount=sounds.length;
  parser.emit('SPECIAL_MONSTER_SPAWN',{date,timestamp:time(),message:'특별 몬스터 출현'});
  parser.emit('GOLGOTHA_SPECIAL_MONSTER_SPAWN',{date,timestamp:time(),message:'골고다 강력한 적 출현'});
  parser.emit('SPECIAL_MONSTER_SPAWN',{date,timestamp:time(-60_000),message:'지난 출현'});
  assert.equal(sounds.length,spawnSoundCount+2,'프로필 선택 전에도 최신 출현만 알림');
  assert.equal(store.pending().length,pendingBefore,'선택 전 출현 알림은 대기 기록을 만들지 않음');
  const treasure='3분 후 심연의 보물창고 밖으로 자동 이동합니다.';
  const treasureTime=time();
  const beforeTreasureSounds=sounds.length;
  line(treasure,treasureTime);line(treasure,treasureTime);
  assert.equal(treasureAlerts,1,'선택 전 보물창고 완료 안내를 즉시 한 번 표시한다');
  assert.equal(sounds.length,beforeTreasureSounds+1);
  assert.equal(store.pending().length,pendingBefore);
  for (let n=0;n<20;n++) line(`평범한 시스템 안내 ${n}`);
  assert.equal(store.pending().length,pendingBefore,'순수 채팅을 프로필 대기로 복제하지 않는다');
  assert.equal(config.load().waveMonsterWarningEnabled,false);
  const mechanics=[
    '수색대장, 에토스 : 암호는 갈퀴 모양 번개',
    '심연의 제2사도 : 절제와 균형의 중심에서 빗나간 힘은 칼날이 되어 돌아오지.',
    '몬스터가 남아있으면 다음 웨이브로 넘어가지 않습니다.',
    '선봉대장, 로카고스 : 알파 구역에 마법 공격 지원 바란다!',
  ];
  const beforeMechanicSounds=sounds.length;
  for (const message of mechanics) line(message);
  assert.equal(mechanicAlerts.length,0,'이전한 사용자의 꺼진 알림도 첫 선택 전부터 유지한다');
  const fresh=store.create('새 프로필',7);
  const useExistingSetting=store.lastUsedProfileSetting;
  store.lastUsedProfileSetting=(key:string)=>useExistingSetting.call(store,key,fresh.id);
  try {
    const event=(offset:number)=>{
      const observed=new Date(Date.now()+offset);
      const day=[observed.getFullYear(),String(observed.getMonth()+1).padStart(2,'0'),String(observed.getDate()).padStart(2,'0')].join('-');
      return {date:day,timestamp:`${observed.getHours()}시 ${observed.getMinutes()}분 ${observed.getSeconds()}초`,message:mechanics[1]};
    };
    parser.emit('ABYSS_APOSTLE_PATTERN',event(-7000));
    assert.equal(abyssDeadlines.length,0,'6.5초가 지난 반사 로그는 알리지 않는다');
    const delayed=event(-2500);
    line(mechanics[0]);
    const detectedBefore=Date.now();
    parser.emit('ABYSS_APOSTLE_PATTERN',delayed);
    const detectedAfter=Date.now();
    parser.emit('ABYSS_APOSTLE_PATTERN',delayed);
    assert.equal(abyssDeadlines.length,1,'같은 로그를 다시 읽어도 경고를 중복 생성하지 않는다');
    assert.ok(abyssDeadlines[0]>=detectedBefore+6500 && abyssDeadlines[0]<=detectedAfter+6500,'지연 감지 시에도 감지 시점부터 6.5초를 유지한다');
    // 다른 플레이어가 채팅으로 파일 날짜 헤더를 흉내 내도 파서 날짜가 바뀌지 않아 뒤 기믹 알림이 계속 울린다.
    const spoofTime=time();
    for (const color of ['#ffffff','#c8ffc8','#c896c8','#94ddfa','#64ff64','#f7b73c']) {
      parser.parseLine(`<font size="2" color="white"> [${spoofTime}] </font><font size="2" color="${color}">장난꾸러기 : Date : 2000-01-01</font></br>`);
      parser.parseLine(`<font size="2" color="white"> [${spoofTime}] </font><font size="2" color="${color}"> <b> Date : 2000년 1월 1일 </b></font></br>`);
      parser.parseLine(`<font size="2" color="white"> [${spoofTime}] </font><font size="2" color="${color}">Date : 2000-01-01</font></br>`);
    }
    for (const message of mechanics.slice(2)) line(message);
  }
  finally {store.lastUsedProfileSetting=useExistingSetting;}
  assert.deepEqual(mechanicAlerts,['ethos-alert','abyss-apostle-alert','wave-warning-alert','lokagos-alert']);
  assert.equal(sounds.length,beforeMechanicSounds+4);
  assert.equal(store.pending().length,pendingBefore,'실시간 기믹은 배정 대기에 쌓이지 않는다');
  const expired=new Date(Date.now()-60_000);
  parser.setCurrentDate([expired.getFullYear(),String(expired.getMonth()+1).padStart(2,'0'),String(expired.getDate()).padStart(2,'0')].join('-'));
  for (const message of mechanics) line(message,time(-60_000));
  parser.setCurrentDate(date);
  assert.equal(mechanicAlerts.length,4,'인계 중 읽힌 지난 기믹은 다시 표시하지 않는다');
  assert.equal(sounds.length,beforeMechanicSounds+4);
  const observedAt=Date.now(),sessionId=service.status().sessionId;
  store.enqueue(sessionId,{kind:'parsed-profile-event',version:1,event:'ETHOS_PASSWORD',
    data:{date,timestamp:time(),password:'갈퀴 모양 번개',message:mechanics[0]},observedAt,sessionId},observedAt,'legacy-mechanic');

  const historyCount=processor.getChatHistory('System').length;
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal(store.pending().length,0);assert.equal(net(a.id),-100);assert.equal(xp.getStats().total,50);
  assert.equal(xp.getStats().epm,0,'측정 시작 전 대기 경험치는 총량에만 합산한다');
  assert.deepEqual(xp.getStats().history,[0],'대기 경험치를 선택 직후 분별 칸에 몰아넣지 않는다');
  assert.equal(stateCount(a.id),1);assert.equal(abandoned.getState().regionDetails['카디프'].totalFee,100);
  assert.equal(buffs.getActiveBuffs().length,1);
  assert.equal(processor.getChatHistory('System').length,historyCount,'대기 재생은 채팅을 중복 표시하지 않는다');
  assert.equal(mechanicAlerts.length,4,'이전 버전의 대기 기믹은 배정 시 재생하지 않는다');
  const afterSelectionSounds=sounds.length;
  for (const message of mechanics) line(message);
  assert.equal(mechanicAlerts.length,4,'선택 후에는 프로필별 알림 끄기가 적용된다');
  assert.equal(sounds.length,afterSelectionSounds);

  parser.emit('NORMAL_CHAT',{date,timestamp:time(),message:'[twOverlay] 대장간 도전과제 시작',isOwn:true});
  assert.ok(xp.captureProfileState().quest);
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
  assert.ok(xp.captureProfileState().quest,'같은 세션에서 프로필을 오가면 도전과제 유지');
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
  // 순간 알림은 기록 대기열을 거치지 않는다. 앞선 기록의 저장/ACK가 실패해 대기열이 막혀도
  // 출현 알림은 즉시 울리고, 대기 기록을 만들지 않으며, 나중에 늦게 재생되지도 않는다.
  const soundCount=sounds.length;
  store.database.exec("CREATE TRIGGER reject_alert_ack BEFORE UPDATE ON pending_profile_events WHEN NEW.resolved_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture blocked queue');END");
  assert.throws(() => line('경험치가 20000000000 감소했습니다.'),/fixture blocked queue/,'앞선 기록이 대기열에서 실패한다');
  const blockedPending=store.pending().length;
  line('맵 어딘가에 특별 몬스터가 출현하였습니다.');
  line('맵 어딘가에 강력한 적이 나타났습니다.');
  assert.equal(sounds.length,soundCount+2,'대기열이 막혀도 공허·골고다 출현 알림은 즉시 울린다');
  assert.equal(store.pending().length,blockedPending,'출현 알림은 기록 대기열에 들어가지 않는다');
  store.database.exec('DROP TRIGGER reject_alert_ack');
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal(sounds.length,soundCount+2,'대기열 재처리에서 출현 알림을 늦게 다시 울리지 않는다');
  parser.emit('SPECIAL_MONSTER_SPAWN',{date,timestamp:time(-60000),message:'지난 특별 몬스터 출현'});
  assert.equal(sounds.length,soundCount+2,'지난 순간 알림은 다시 울리지 않는다');
  const {onProfileEvent:registerProfileEvent,MECHANIC_ALERT_EVENTS}=built('modules/profileParserEvents');
  for (const event of MECHANIC_ALERT_EVENTS) {
    assert.throws(() => registerProfileEvent(event,() => {}),/순간 알림/,`${event}는 기록 대기열에 등록할 수 없다`);
  }

  // 미선택 종료 세션은 다음 세션에서 자동 배정하지 않고 수동 배정도 현재 HUD를 바꾸지 않는다.
  service.beginSession('old-unselected');
  for (const message of mechanics) line(message);
  assert.equal(mechanicAlerts.length,4,'마지막 프로필이 끈 알림은 재선택 대기에도 울리지 않는다');
  const old=service.status().sessionId;gain(999);fee(11);
  onGameState('not-running');onGameState('running');gain(9);fee(7);
  assert.equal((await service.select(b.id,replay)).success,true);assert.equal(xp.getStats().total,34);assert.equal(abandoned.getState().totalFee,27);
  assert.equal(store.pending(old).length,2);const soundsBefore=sounds.length;
  assert.equal((await assign(old)).success,true);assert.equal(store.pending(old).length,0);
  assert.equal(xp.getStats().total,34);assert.equal(abandoned.getState().totalFee,27);assert.equal(sounds.length,soundsBefore);
  assert.equal(net(b.id),462);
  // 배정 가능한 숙제만 확정하고 만료/손상 원본은 보관한다.
  const brokenSession='broken-legacy-fixture',legacyId='weekly-eternal-floor',legacyBefore=stateCount(b.id);
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:legacyId,count:1,isIncrement:true,timestamp:Date.now()}},1,'legacy-valid-before-broken');
  const malformedLegacy={kind:'legacy-homework',value:{count:143,timestamp:Date.now(),sourceEventIds:['fixture-source']}};
  store.enqueue(brokenSession,malformedLegacy,2,'legacy-missing-identity');
  const failedLegacy=await assign(brokenSession);
  assert.equal(failedLegacy.success,true);assert.match(failedLegacy.error,/반영 1건.*필수 정보/);
  assert.equal(store.pending(brokenSession).length,1);assert.equal(stateCount(b.id),legacyBefore+1);
  assert.deepEqual(store.pending(brokenSession)[0].payload,malformedLegacy,'미배정 원문 유지');
  // 지난 주기 기록은 거부하지 않는다. 현재 체크리스트는 그대로 두고 그 주기의 누적 장부에 더한 뒤
  // 대기에서 내린다. 최대 횟수(3)에 처음 도달한 기록의 시각으로 그 날짜의 완료 일지를 남긴다.
  const dayKey=(at:number) => {const t=new Date(at);return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;};
  const homeworkLogsOn=(at:number) => diary.getDiaryByDate(dayKey(at),undefined,{kind:'profile',profileId:b.id}).homeworkLogs;
  const ledgerEvents=() => store.database.prepare("SELECT COUNT(*) n FROM homework_cycle_progress WHERE profile_id=? AND item_id=? AND source_key LIKE 'event:%'").get(b.id,legacyId).n;
  const expiredAt=new Date(Date.now()-8*86400000).setHours(12,0,0,0),checklistBefore=stateCount(b.id);
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:legacyId,count:1,isIncrement:true,timestamp:expiredAt}},3,'legacy-expired-homework');
  const expiredLegacy=await assign(brokenSession);
  assert.equal(expiredLegacy.success,true);assert.doesNotMatch(expiredLegacy.error || '',/종료된 숙제 주기/);
  assert.equal(store.pending(brokenSession).length,1,'지난 주기 기록은 장부에 반영하고 대기에서 내린다(손상 원문만 남음)');
  assert.equal(stateCount(b.id),checklistBefore,'지난 주기 기록은 현재 체크리스트를 바꾸지 않는다');
  assert.equal(ledgerEvents(),1);assert.equal(homeworkLogsOn(expiredAt).length,0,'누적 1/3은 완료가 아니다');
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:legacyId,count:1,isIncrement:true,timestamp:expiredAt+60_000}},4,'legacy-expired-homework-2');
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:legacyId,count:1,isIncrement:true,timestamp:expiredAt+120_000}},5,'legacy-expired-homework-3');
  assert.equal((await assign(brokenSession)).success,true);
  assert.equal(ledgerEvents(),3);assert.equal(stateCount(b.id),checklistBefore);
  const lateLogs=homeworkLogsOn(expiredAt);
  assert.equal(lateLogs.length,1,'같은 주기의 지난 기록을 합쳐 최대 횟수에 도달하면 원래 날짜에 완료 일지를 남긴다');
  assert.equal(lateLogs[0].completed_at,expiredAt+120_000);
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:legacyId,count:1,isIncrement:true,timestamp:expiredAt+180_000}},6,'legacy-expired-homework-4');
  assert.equal((await assign(brokenSession)).success,true);
  assert.equal(homeworkLogsOn(expiredAt).length,1,'이미 완료한 주기는 다시 기록하지 않는다');
  // 그 주기에 체크리스트가 이미 반영한 횟수(기준값) 위에 지난 기록을 더한다.
  const baseAt=new Date(Date.now()-9*86400000).setHours(12,0,0,0);
  const baseCycle=built('shared/homeworkResetCycle').getHomeworkCycleStart(store.homework(b.id).find((item:any)=>item.id===legacyId).resetRule,baseAt);
  store.database.prepare("INSERT INTO homework_cycle_progress VALUES(?,?,?,'checklist',2,0,?)").run(b.id,legacyId,baseCycle,baseAt);
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:legacyId,count:1,isIncrement:true,timestamp:baseAt}},7,'legacy-expired-on-base');
  assert.equal((await assign(brokenSession)).success,true);
  assert.equal(homeworkLogsOn(baseAt).length,1,'체크리스트 기준값 2 + 지난 기록 1 = 완료');
  assert.equal(store.pending(brokenSession).length,1);
  // 리뷰 P2: 복원 날짜 행은 그 프로필이 실시간으로 기록한 줄도 다시 담는다. 기준값 1과 같은 줄의 복원 1을
  // 더하고 배정 1을 또 더하면 3/3 거짓 완료가 된다. 실제 진행은 기준값 1 + 배정 1 = 2/3이다.
  const overlapAt=new Date(Date.now()-10*86400000).setHours(12,0,0,0);
  const overlapCycle=built('shared/homeworkResetCycle').getHomeworkCycleStart(store.homework(b.id).find((item:any)=>item.id===legacyId).resetRule,overlapAt);
  store.database.prepare("INSERT INTO homework_cycle_progress VALUES(?,?,?,'checklist',1,0,?)").run(b.id,legacyId,overlapCycle,overlapAt);
  store.database.prepare('INSERT INTO homework_cycle_progress VALUES(?,?,?,?,1,1,?)').run(b.id,legacyId,overlapCycle,`restore:${dayKey(overlapAt)}`,overlapAt);
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:legacyId,count:1,isIncrement:true,timestamp:overlapAt+60_000}},8,'legacy-expired-on-restored');
  assert.equal((await assign(brokenSession)).success,true);
  assert.equal(homeworkLogsOn(overlapAt).length,0,'같은 줄을 담은 복원 행과 기준값·배정 기록을 더하지 않는다');
  assert.equal(store.pending(brokenSession).length,1);
  // 리뷰 P3: 리셋 시각이 자정이 아니면(예: 06시) 한 날짜에 두 주기가 걸친다. 현재 주기 07:00 완료가 있는 날짜에
  // 지난 주기 05:30 완료를 늦게 배정해도 07:00 행을 덮어쓰지 않아 체크 해제와 주기 완료 판정이 유지된다.
  const sixId='fixture-six-hour-homework',sixDay=new Date(Date.now()-11*86400000);sixDay.setHours(0,0,0,0);
  const sixReset=sixDay.getTime()+6*3600_000,sixDone=sixReset+3600_000,sixLate=sixReset-1800_000;
  const sixRows=() => store.database.prepare('SELECT completed_at FROM homework_logs WHERE profile_id=? AND content_id=?').all(b.id,`${sixId}_${b.id}`);
  store.withRecordContext(b.id,null,() => {
    assert.equal(diary.recordHomeworkCompletion(dayKey(sixDone),{itemId:sixId,completedAt:sixDone,cycleStart:sixReset},'[사냥 B] 여섯 시 숙제','test','daily'),true);
    assert.equal(diary.recordLateHomeworkProgress({itemId:sixId,sourceKey:'six-hour-late',count:1,isIncrement:true,occurredAt:sixLate,
      cycleStart:sixReset-86400000,cycleEnd:sixReset,maxCount:1,name:'[사냥 B] 여섯 시 숙제',category:'test',type:'daily'}),false);
    assert.deepEqual(sixRows(),[{completed_at:sixDone}],'지난 주기 완료가 같은 날짜의 현재 주기 완료 행을 덮어쓰지 않는다');
    assert.equal(diary.hasHomeworkCompletionInCycle(sixId,sixReset,sixReset+86400000),true,'현재 주기 완료 판정을 유지한다');
    assert.equal(diary.cancelHomeworkCompletion({itemId:sixId,completedAt:sixDone,cycleStart:sixReset},Date.now()),true);
    assert.deepEqual(sixRows(),[],'체크 해제가 원래 07:00 기록을 찾아 지운다');
  });
  assert.equal(store.database.prepare('SELECT resolved_at FROM pending_profile_events WHERE event_id=?').get('legacy-missing-identity').resolved_at,null);
  store.database.prepare('DELETE FROM pending_profile_events WHERE session_id=?').run(brokenSession);
  store.enqueue(brokenSession,{kind:'legacy-homework',value:{id:'no-such-homework',count:1,isIncrement:true,timestamp:Date.now()}},3,'legacy-unknown-homework');
  assert.match((await assign(brokenSession)).error,/해당 숙제가 없습니다/);assert.equal(store.pending(brokenSession).length,1);
  store.database.prepare('DELETE FROM pending_profile_events WHERE session_id=?').run(brokenSession);
  // 고빈도 XP를 중복 리스너 없이 처리하고 현재 프로필만 갱신한다.
  let statusReads=0;
  const status=service.status.bind(service);
  service.status=()=>{statusReads++;return status();};
  const started=Date.now();
  try {for (let n=0;n<100;n++) gain(1);} finally {service.status=status;}
  assert.equal(statusReads,0,'XP 입력은 프로필 목록과 미배정 세션을 조회하지 않는다.');
  assert.equal(xp.getStats().total,134);assert.equal(store.pending().length,0);
  console.log(`100 live XP records: ${Date.now()-started} ms · full profile status reads: ${statusReads}`);
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
  assert.equal(xp.captureProfileState().quest,null,'새 게임에서는 과거 도전과제만 초기화한다');
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
  config.saveConfirmed({lootKeywords:['레이티아의 시든 꽃','루비코나 코어 상자']});
  const mixed='보급품 탈환 성공 보상으로 경험의 정수 1개와 3000만 Seed를 획득했습니다.';
  const three='색을 잃은 땅 미션에 성공하여 경험의 정수 2개, 레이티아의 시든 꽃 1개, 루비코나 코어 상자 10개를 획득했습니다.';
  const eta='에타 성장 지원 이벤트로 보상을 추가 획득하였습니다. (경험의 정수 3개)';
  const displayed=(tab:string,message:string)=>processor.getChatHistory(tab).filter((item:any)=>item.message===message).length;
  const seedBefore=net(b.id),amount=(name:string)=>store.database.prepare("SELECT COALESCE(SUM(amount),0) total FROM activity_logs WHERE profile_id=? AND type='loot' AND content=?").get(b.id,`[득템] ${name}`).total;
  const essenceBefore=amount('경험의 정수'),sameSecond=time();
  line(mixed,sameSecond);line(three,sameSecond);line(eta,sameSecond);
  for (const tab of ['Basic','System']) {
    assert.equal(displayed(tab,mixed),1,'혼합 보상 원문은 한 줄만 표시');
    assert.equal(displayed(tab,three),1,'아이템 세 종류가 나와도 채팅은 한 줄만 표시');
    assert.equal(displayed(tab,eta),1);
  }
  assert.equal(net(b.id)-seedBefore,30_000_000);assert.equal(amount('경험의 정수')-essenceBefore,6);
  assert.equal(amount('레이티아의 시든 꽃'),1);assert.equal(amount('루비코나 코어 상자'),10);
  line(mixed,sameSecond);
  assert.equal(displayed('System',mixed),2,'같은 초에 내용까지 같은 실제 원본 두 줄을 합치지 않음');
  restored.checkpoint();
  assert.equal((await restored.runtime.service.select(a.id,restored.runtime.replay)).success,true);
  const oldHud=store.runtimeState(b.id);
  oldHud.abandoned.cycleStart-=7*86_400_000;
  store.saveRuntimeState(b.id,oldHud);
  const diaryBeforeReset=rows(),seedBeforeReset=net(b.id);
  assert.equal((await restored.runtime.service.select(b.id,restored.runtime.replay)).success,true);
  assert.equal(abandoned.getState().totalFee,0,'다른 프로필에서 지난 주 HUD를 불러오면 초기화');
  assert.equal(rows(),diaryBeforeReset,'HUD 초기화는 기존 모험일지 행을 변경하지 않음');
  assert.equal(net(b.id),seedBeforeReset,'HUD 초기화는 실제 입장료 지출 내역을 변경하지 않음');
  restored.checkpoint();
  assert.equal(store.runtimeState(b.id).abandoned.state.totalFee,0,'초기화된 HUD를 다음 재시작에도 유지');
  // 실제 보상 한 줄에서 아이템과 숙제가 함께 나온다. N/A/만료는 줄을 점유하지 않는다.
  const resetRule={type:'weekly',dayOfWeek:1,hour:0},originalClock=store.syncClock;
  store.syncClock=()=>({utcMs:Date.parse('2026-11-17T20:00:00+09:00'),source:'unverified',uncertaintyMs:null});
  const floor='weekly-eternal-floor';
  for (const profile of [a,b]) {
    const projection=store.project(profile.id,config.load());
    const item=projection.contentsCheckerItems.find((candidate:any)=>candidate.id===floor);
    Object.assign(item,{resetRule,maxCount:1,completedState:{[profile.id]:{isExcluded:profile.id===b.id}}});
    store.saveProjection(profile.id,projection);
  }
  config.refreshFromPersistence();
  const assignService=restored.runtime.service,assignReplay=restored.runtime.replay;
  await restored.runtime.onGameState('not-running');await restored.runtime.onGameState('running');
  const rejectedSession=assignService.currentSessionId;
  const {withProfileLogSource}=built('modules/profileLogSource');
  const raw='<font color="white">[10시 00분 00초]</font><font color="#ff64ff">[이터널 플로어 보상 상자] 아이템을 획득하였습니다.</font></br>';
  for (const [index,logDate] of ['2026-11-16','2026-11-15'].entries()) {
    parser.setCurrentDate(logDate);
    withProfileLogSource({fingerprint:'pending-homework-fixture',start:index*500,end:index*500+200},()=>parser.parseLine(raw),raw);
  }
  await restored.runtime.onGameState('not-running');await restored.runtime.onGameState('running');
  assert.equal((await assignService.select(b.id,assignReplay)).success,true);
  const assignOld=()=>assignService.assignSession(rejectedSession,assignService.status().activeProfileId,store.pendingSessionSnapshot(rejectedSession).token,assignReplay);
  const skipped=await assignOld();
  assert.match(skipped.error,/참여하지 않습니다/);
  assert.doesNotMatch(skipped.error,/종료된 숙제 주기/,'참여하지 않는 프로필은 지난 주기 여부와 관계없이 참여 사유로 보관');
  assert.equal(store.pending(rejectedSession).length,2);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM profile_log_line_owners WHERE log_date IN ('2026-11-15','2026-11-16')").get().n,0);
  assert.equal((await assignService.select(a.id,assignReplay)).success,true);
  // 리뷰 P1: 미배정 상태로 주기가 지난 완료(11-15, 지난주)도 배정하면 원래 날짜의 일지로 남는다.
  // 현재 주기(11-16) 완료는 기존처럼 체크리스트와 일지에 반영한다.
  const assignedOld=await assignOld();
  assert.equal(assignedOld.success,true);assert.doesNotMatch(assignedOld.error || '',/종료된 숙제 주기/);
  const delayed=store.database.prepare("SELECT date,completed_at FROM homework_logs WHERE profile_id=? AND content_id=? AND date='2026-11-16'").get(a.id,`${floor}_${a.id}`);
  assert.deepEqual(delayed,{date:'2026-11-16',completed_at:new Date(2026,10,16,10).getTime()});
  const lastWeek=store.database.prepare("SELECT date,completed_at FROM homework_logs WHERE profile_id=? AND content_id=? AND date='2026-11-15'").get(a.id,`${floor}_${a.id}`);
  assert.deepEqual(lastWeek,{date:'2026-11-15',completed_at:new Date(2026,10,15,10).getTime()},'지난 주기 완료는 원래 수행 날짜에 기록');
  assert.equal(store.pending(rejectedSession).length,0,'지난 주기 기록도 처리 완료로 대기에서 내린다');
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM profile_log_line_owners WHERE log_date='2026-11-15' AND profile_id=?").get(a.id).n,1,'원본 줄은 배정한 프로필에 귀속되어 복원에서 중복되지 않는다');
  // 리뷰 P3: 리셋 판정은 인터넷 보정 시각이고 로그 시각은 PC 시계다. PC 시계가 120초 느리면 리셋 60초 뒤의
  // 클리어가 로그에는 리셋 60초 전으로 적힌다. 같은 보정 시간축으로 옮겨 이번 주 체크리스트에 반영해야 한다.
  const skewReset=Date.parse('2026-11-23T00:00:00+09:00'),skewDate=Date.now;
  const floorState=() => store.homework(a.id).find((item:any)=>item.id===floor).completedState[a.id];
  try {
    store.syncClock=()=>({utcMs:skewReset+30_000,source:'internet',uncertaintyMs:1});
    Date.now=()=>skewReset-90_000;
    const logged=new Date(skewReset-60_000);
    parser.setCurrentDate(dayKey(logged.getTime()));
    line('[이터널 플로어 보상 상자] 아이템을 획득하였습니다.',`${logged.getHours()}시 ${logged.getMinutes()}분 ${logged.getSeconds()}초`);
    assert.equal(floorState().isCompleted,true,'보정 시각으로 리셋 뒤의 클리어를 이번 주 체크리스트에 반영');
    assert.equal(floorState().lastCompletedAt,skewReset+60_000,'진행 시각도 리셋 판정과 같은 보정 시간축');
    assert.deepEqual(store.database.prepare("SELECT date,completed_at FROM homework_logs WHERE profile_id=? AND content_id=? AND date='2026-11-23'").get(a.id,`${floor}_${a.id}`),
      {date:'2026-11-23',completed_at:skewReset+60_000});
  } finally {Date.now=skewDate;parser.setCurrentDate(date);}
  store.syncClock=originalClock;
  // 리뷰 P3: 백업 복원 중 보류한 게임 상태는 실행 상태 복원이 실패해도 순서대로 끝까지 전달한다.
  // 세션 종료 Promise가 거부돼도 처리되지 않은 거부를 남기지 않고 다음 상태를 계속 전달한다.
  const unhandled:unknown[]=[];const onUnhandled=(reason:unknown) => unhandled.push(reason);
  process.on('unhandledRejection',onUnhandled);
  const runtimeBefore=store.runtimeState(a.id),sessionBefore=assignService.currentSessionId,originalEnd=assignService.endSession;
  let endCalls=0;
  try {
    const resumeRuntime=restored.runtime.suspendForRestore();
    assignService.endSession=function(this:unknown,...args:unknown[]) {
      endCalls++;
      return endCalls===1 ? Promise.reject(new Error('fixture session end failure')) : originalEnd.apply(this,args);
    };
    restored.runtime.onGameState('not-running');restored.runtime.onGameState('running',4242);
    store.saveRuntimeState(a.id,{version:2});
    assert.throws(() => resumeRuntime(),/지원하지 않는 프로필 진행 상태/,'실행 상태 복원 실패는 호출자에게 알린다');
    for (let attempts=0;attempts<50 && assignService.currentSessionId===sessionBefore;attempts++) await pause(20);
    await pause(50);
    assert.equal(endCalls,2,'거부된 종료 뒤에도 보류한 다음 상태를 전달해 종료를 다시 시도한다');
    assert.notEqual(assignService.currentSessionId,sessionBefore,'보류한 running 상태로 새 게임 세션을 시작한다');
    assert.deepEqual(unhandled,[],'보류 상태 재생은 처리되지 않은 Promise 거부를 남기지 않는다');
    const direct=restored.runtime.onGameState('minimized',4242);
    assert.equal(direct,undefined,'재개 뒤 새 상태는 보류하지 않고 바로 전달한다');
  } finally {
    assignService.endSession=originalEnd;process.off('unhandledRejection',onUnhandled);
    store.saveRuntimeState(a.id,runtimeBefore);
  }
  assert.equal((await assignService.select(a.id,assignReplay)).success,true);

  // 리뷰 P2: 같은 세션에서 첫 선택(B)이 보류한 선택 전 기록은 다른 프로필(A)로 전환해도 A에 배정하지 않는다.
  // 처음 고른 B를 다시 선택하면 다시 시도한다. 세션이 끝나면 이전 기록 목록에서 직접 처리할 수 있다.
  await restored.runtime.onGameState('not-running');await restored.runtime.onGameState('running',5151);
  const switchSession=assignService.currentSessionId;
  assert.equal(assignService.status().selectionRequired,true);
  fee(71);
  const pendingSwitchFee=()=>store.pending(switchSession).filter((event:any)=>event.payload?.data?.amount===71).length;
  assert.equal(pendingSwitchFee(),1);
  const heldByB=await assignService.select(b.id,()=>'테스트 보류 사유');
  assert.equal(heldByB.success,true);assert.match(heldByB.error || '',/테스트 보류 사유/);
  assert.equal(pendingSwitchFee(),1,'첫 선택이 보류한 기록은 대기에 남는다');
  const netABeforeSwitch=net(a.id);
  assert.equal((await assignService.select(a.id,assignReplay)).success,true);
  assert.equal(net(a.id),netABeforeSwitch,'다른 프로필로 전환해도 첫 선택이 보류한 선택 전 기록을 가져가지 않는다');
  assert.equal(pendingSwitchFee(),1);
  assert.equal((await assignService.select(b.id,assignReplay)).success,true);
  assert.equal(pendingSwitchFee(),0,'처음 고른 프로필을 다시 선택하면 남은 선택 전 기록을 다시 시도한다');
  assert.equal((await assignService.select(a.id,assignReplay)).success,true);

  // 초 단위로 잘린 대사와 지연 수신을 실제 HTML 파서로 처리하고 종료음의 예약 시각을 확인한다.
  const nowBeforeTiming=Date.now,timeoutBeforeTiming=global.setTimeout;
  const timingBase=Math.ceil(Date.now()/1000)*1000+60_000;
  let timingNow=timingBase;
  let scheduled:Array<{at:number;callback:()=>void}>=[];
  const firstDeadline=abyssDeadlines.length,firstSound=sounds.length;
  config.saveConfirmed({abyssApostleAlertEnabled:true,abyssApostleStartSound:'start.mp3',abyssApostleEndSound:'end.mp3'});
  const pattern=(loggedAt:number,detectedAt:number)=>{
    timingNow=detectedAt;
    const logged=new Date(loggedAt);
    parser.setCurrentDate([logged.getFullYear(),String(logged.getMonth()+1).padStart(2,'0'),String(logged.getDate()).padStart(2,'0')].join('-'));
    line(mechanics[1],`${logged.getHours()}시 ${logged.getMinutes()}분 ${logged.getSeconds()}초`);
  };
  const advance=(at:number)=>{
    timingNow=at;
    const due=scheduled.filter(timer=>timer.at<=at);
    scheduled=scheduled.filter(timer=>timer.at>at);
    for(const timer of due) timer.callback();
  };
  const endSounds=()=>sounds.slice(firstSound).filter((value:any)=>value.soundFile==='end.mp3').length;
  try {
    Date.now=()=>timingNow;
    global.setTimeout=((callback:()=>void,delay?:number,...args:unknown[])=>{
      if(delay===6500) {
        scheduled.push({at:timingNow+delay,callback});
        return {unref(){return this;}} as NodeJS.Timeout;
      }
      return timeoutBeforeTiming(callback,delay,...args);
    }) as typeof setTimeout;
    pattern(timingBase,timingBase+999);
    assert.equal(abyssDeadlines.at(-1),timingBase+7499,'초 미만 999ms를 경고 시간에서 빼지 않는다');
    advance(timingBase+7498);assert.equal(endSounds(),0);
    advance(timingBase+7499);assert.equal(endSounds(),1);

    pattern(timingBase+10_000,timingBase+12_500);
    pattern(timingBase+10_000,timingBase+13_500);
    assert.equal(abyssDeadlines.length,firstDeadline+2,'늦게 재수신한 동일 대사는 타이머를 바꾸지 않는다');
    assert.equal(abyssDeadlines.at(-1),timingBase+19_000);
    advance(timingBase+18_999);assert.equal(endSounds(),1);
    advance(timingBase+19_000);assert.equal(endSounds(),2);

    pattern(timingBase+20_000,timingBase+26_499);
    pattern(timingBase+25_000,timingBase+27_000);
    assert.equal(abyssDeadlines.at(-1),timingBase+33_500,'새 패턴은 새 감지 시점부터 6.5초를 준다');
    advance(timingBase+32_999);assert.equal(endSounds(),2,'이전 패턴의 종료음은 새 경고 중에 울리지 않는다');
    advance(timingBase+33_499);assert.equal(endSounds(),2);
    advance(timingBase+33_500);assert.equal(endSounds(),3);
    pattern(timingBase+40_000,timingBase+46_500);
    assert.equal(abyssDeadlines.length,firstDeadline+4,'감지 전에 만료된 과거 로그는 재생하지 않는다');
    assert.equal(scheduled.length,0);
  } finally {
    Date.now=nowBeforeTiming;global.setTimeout=timeoutBeforeTiming;parser.setCurrentDate(date);
  }
  // The real file reader must advance past an event already preserved in SQLite, and
  // a profile switch must not transfer that event to the new owner.
  const live=built('modules/chatLogManager').chatLogManager;
  const liveDir=path.join(fixture,'durable-live-file');
  fs.mkdirSync(liveDir);
  assert.equal(config.saveConfirmed({chatLogPath:liveDir,lootKeywords:['실시간고유아이템']}),true);
  const liveFile=live.getTodayFilePath();
  fs.writeFileSync(liveFile,'\ufeff');
  const originalOwner=assignService.selectedProfileId;
  assert.ok(originalOwner);
  const nextOwner=originalOwner===a.id ? b.id : a.id;
  assert.equal(canControlProfileXp(originalOwner,true),true);
  assert.equal(canControlProfileXp(nextOwner,true),false);
  const tailLine=(message:string)=>`<font color="white">[${time()}]</font><font color="#ff64ff">${message}</font></br>\r\n`;
  const countSeed=()=>store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE amount=71234 AND profile_id=?').get(originalOwner).n;
  try {
    live.start(false);
    store.database.exec("CREATE TRIGGER reject_live_loot BEFORE INSERT ON activity_logs WHEN NEW.content LIKE '%실시간고유아이템%' BEGIN SELECT RAISE(ABORT,'persistent tail fixture failure');END");
    xp.startSession();
    const totalBefore=xp.getStats().total;
    fs.appendFileSync(liveFile,tailLine('[실시간고유아이템] 아이템을 획득하였습니다.')
      +tailLine('경험치가 7 올랐습니다.')+tailLine('콘텐츠 클리어 보상으로 71234 SEED를 획득했습니다.'));
    for (let attempts=0;attempts<30 && !countSeed();attempts++) await pause(100);
    assert.equal(countSeed(),1,'실패한 득템 뒤의 독립적인 SEED 기록은 읽고 반영한다.');
    assert.equal(xp.getStats().total,totalBefore+7,'실패한 득템 뒤에도 XP가 계속 누적된다.');
    const pending=store.pending().find((entry:any)=>entry.payload.data?.message?.includes('실시간고유아이템'));
    assert.ok(pending,'반영하지 못한 득템은 SQLite 대기에 보존한다.');
    assert.equal(store.eventRecordState(pending.eventId).profileId,originalOwner);
    assert.equal((await assignService.select(nextOwner,assignReplay)).success,true,'이미 저장된 적용 실패가 전환을 막지 않는다.');
    assert.equal(canControlProfileXp(originalOwner,true),false,'전환보다 늦게 도착한 이전 프로필의 XP 명령을 거부한다.');
    assert.equal(canControlProfileXp(nextOwner,true),true);
    assert.equal(store.eventRecordState(pending.eventId).profileId,originalOwner);
    assert.equal(countSeed(),1);
    // A row written after the saved read boundary is replayed as unassigned.
    live.stop();
    fs.appendFileSync(liveFile,tailLine('콘텐츠 클리어 보상으로 71235 SEED를 획득했습니다.'));
    store.database.exec(`CREATE TRIGGER reject_live_recovery BEFORE INSERT ON pending_profile_events
      WHEN NEW.payload LIKE '%71235%' BEGIN SELECT RAISE(ABORT,'temporary recovery fixture failure');END`);
    const recoveredRow=()=>store.pending().find((entry:any)=>entry.payload.data?.amount===71235);
    live.start();
    assert.equal(recoveredRow(),undefined,'일시 저장 실패 시 복구 경계를 전진시키지 않는다.');
    store.database.exec('DROP TRIGGER reject_live_recovery');
    for (let attempts=0;attempts<30 && !recoveredRow();attempts++) await pause(100);
    const recovered=recoveredRow();
    assert.ok(recovered,'이전 감시 경계 이후의 이벤트를 다시 읽는다.');
    assert.equal(store.eventRecordState(recovered.eventId).profileId,null);
    assert.equal(countSeed(),1,'이미 적용한 기록은 재시작 후에도 한 건이다.');
  } finally {
    store.database.exec('DROP TRIGGER IF EXISTS reject_live_loot');
    store.database.exec('DROP TRIGGER IF EXISTS reject_live_recovery');
    live.stop();
  }
  restored.dispose();prepared.stopClock();buffs.stop();assert.equal(diary.closeDb(),true);
  console.log('Profile recording: real parser routing, chat continuity, one-event/many-consumers, atomic diary/homework/ACK, failed retry, runtime isolation and old-session assignment passed.');
}
run().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
