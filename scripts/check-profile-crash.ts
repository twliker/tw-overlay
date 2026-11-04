/** 실제 파일 tail/SQLite WAL commit 뒤 프로세스를 강제 종료하고 별도 프로세스로 복구한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawn} from 'node:child_process';
import {app} from 'electron';

const root=path.resolve(__dirname,'..'),phaseIndex=process.argv.indexOf('--phase'),phase=phaseIndex<0 ? undefined : process.argv[phaseIndex+1];
const fixtureIndex=process.argv.indexOf('--fixture');
const fixture=fixtureIndex<0 ? fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-crash-')) : fs.realpathSync(process.argv[fixtureIndex+1]);
assert.equal(path.dirname(fixture).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
assert.ok(path.basename(fixture).startsWith('tw-profile-crash-'));
const marker=path.join(fixture,'owned-fixture');
if(!phase)fs.writeFileSync(marker,'profile crash acceptance');else assert.equal(fs.readFileSync(marker,'utf8'),'profile crash acceptance');
const data=path.join(fixture,'appData','twOverlay');fs.mkdirSync(data,{recursive:true});
const driverData=phase ? data : path.join(fixture,'driver');fs.mkdirSync(driverData,{recursive:true});
app.setPath('appData',path.dirname(driverData));app.setPath('userData',driverData);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name+'.js'));
const pause=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string):Promise<void> {
  const end=Date.now()+20000;
  while(Date.now()<end){if(check())return;await pause();}throw new Error(label+' timed out');
}
const expectedPath=path.join(fixture,'expected.json');
const logs=path.join(data,'logs');
const day=built('shared/localDate').formatLocalDateKey(),file=path.join(logs,`TWChatLog_${day.replace(/-/g,'_')}.html`);
const line=(message:string,second:number)=>`<font size="2" color="white"> [10시 00분 ${String(second).padStart(2,'0')}초] </font><font size="2" color="#ff64ff">${message}</font></br>\r\n`;

async function driver():Promise<void> {
  let log='';
  const launch=(which:string)=>{
    const childProcess=spawn(process.execPath,[__filename,'--phase',which,'--fixture',fixture],{windowsHide:true,stdio:'pipe'});
    childProcess.stdout.on('data',chunk=>log+=String(chunk));childProcess.stderr.on('data',chunk=>log+=String(chunk));
    const completed=new Promise<number | null>((resolve,reject)=>{childProcess.once('exit',code=>resolve(code));childProcess.once('error',reject);});
    return {process:childProcess,completed};
  };
  const producer=launch('produce');
  try {
    await until(()=>{if(producer.process.exitCode!==null)throw new Error(log);return fs.existsSync(expectedPath);},'durable crash checkpoint');
    assert.ok(fs.statSync(path.join(data,'app-data.db-wal')).size>0,'미체크포인트 WAL을 남긴 채 종료한다.');
    assert.equal(producer.process.kill('SIGKILL'),true);await producer.completed;
    assert.equal(fs.existsSync(path.join(fixture,'graceful-producer-exit')),false,'정상 종료 경로를 호출하지 않는다.');
    const recovery=launch('recover');
    const timeout=setTimeout(()=>recovery.process.kill(),30000);
    let status:number | null;
    try {status=await recovery.completed;} finally {clearTimeout(timeout);}
    assert.equal(status,0,log.slice(-16000));
    const output=path.join(root,'output/profile-crash');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({passed:true,forcedProcessExit:true,uncheckpointedWal:true,
      confirmedRecordsPreserved:true,pendingSessionsPreserved:true,syncOutboxPreserved:true,explicitAssignmentOnce:true,historicalReplayOnce:true},null,2));
    console.log('PASS profile crash: real SIGKILL/WAL recovery, settings/tools/confirmed/pending records, explicit assignment and historical replay');
  } finally {if(producer.process.exitCode===null && !producer.process.killed)producer.process.kill();}
}

async function run():Promise<void> {
  await app.whenReady();
  if(!phase){await driver();return;}
  const config=built('modules/config'),defaults=built('modules/constants').DEFAULT_CONFIG;
  if(phase==='produce') {
    fs.mkdirSync(logs,{recursive:true});fs.writeFileSync(file,'\ufeff'+line('초기 안내',0));
    assert.equal(config.saveConfirmed({...structuredClone(defaults),analyticsEnabled:false,userServer:7,chatLogPath:logs,
      showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,contentsCheckerEnabled:false,
      characterPresets:[{id:'A',name:'강제 종료 A'},{id:'B',name:'강제 종료 B'}],selectedCharacterId:'A'}),true);
    app.on('before-quit',()=>fs.writeFileSync(path.join(fixture,'graceful-producer-exit'),'quit'));
  }
  const application=built('modules/profileApplication'),clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
  const controller=await application.startProfileApplication(()=>{},clock),{service,replay}=controller.runtime,store=service.store;
  built('modules/chatLogProcessor').chatLogProcessor.start();
  const live=built('modules/chatLogManager').chatLogManager,diary=built('modules/diaryDb');
  const sum=(id:string)=>store.database.prepare('SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE profile_id=?').get(id).n;
  store.database.pragma('wal_autocheckpoint=0');
  if(phase==='produce') {
    const a=store.list().find((item:any)=>item.name==='강제 종료 A'),b=store.list().find((item:any)=>item.name==='강제 종료 B');
    controller.runtime.onGameState('running');assert.equal((await service.select(a.id,replay)).success,true);
    assert.equal(config.saveConfirmed({pinnedNoteText:'강제 종료 전 저장 메모'}),true);
    store.saveToolValue(a.id,'tw-coefficient-calculator-settings-v7final',JSON.stringify({attack:123}));
    live.start();fs.appendFileSync(file,line('입장료 37 Seed를 지불하였습니다.',1));
    await until(()=>sum(a.id)===-37,'confirmed fee');
    controller.runtime.onGameState('not-running');controller.runtime.onGameState('running');
    const sessionId=service.status().sessionId;
    fs.appendFileSync(file,line('입장료 13 Seed를 지불하였습니다.',2)+line('경험치가 55 올랐습니다.',3));
    await until(()=>store.pending(sessionId).length===2,'unassigned source events');
    const ids=store.database.prepare('SELECT event_id FROM pending_profile_events WHERE session_id=? AND resolved_at IS NULL ORDER BY event_id').all(sessionId);
    assert.equal(config.flushPending(),true);
    const model=built('modules/profileCloudSync').getProfileCloudSync().coordinator.model;assert.ok(model.pending()>0);
    fs.writeFileSync(`${expectedPath}.tmp`,JSON.stringify({a:a.id,b:b.id,sessionId,ids,syncEnvelope:model.envelope()}));fs.renameSync(`${expectedPath}.tmp`,expectedPath);
    await new Promise<void>(()=>{setInterval(()=>{},1000);});
    return;
  }
  assert.equal(phase,'recover');
  const expected=JSON.parse(fs.readFileSync(expectedPath,'utf8'));
  assert.equal(store.list().length,2);assert.equal(service.status().selectionRequired,true);
  assert.equal(config.load().pinnedNoteText,'강제 종료 전 저장 메모');
  assert.equal(store.toolValues(expected.a)['tw-coefficient-calculator-settings-v7final'],JSON.stringify({attack:123}));
  const recoveredSync=built('modules/profileCloudSync').getProfileCloudSync().coordinator.model,recoveredEnvelope=recoveredSync.envelope();
  assert.ok(recoveredSync.pending()>0,'SIGKILL 뒤 미전송 sync journal 유지');assert.ok(recoveredEnvelope.sequence>=expected.syncEnvelope.sequence);
  for(const [key,value] of Object.entries(expected.syncEnvelope.cells)) if(key.includes('pinnedNoteText') || JSON.parse(key)[0]==='tool') assert.deepEqual(recoveredEnvelope.cells[key],value,'강제 종료/재시작으로 원래 변경 ID와 시각을 바꾸지 않음');
  assert.equal(sum(expected.a),-37);assert.equal(sum(expected.b),0);
  assert.deepEqual(store.database.prepare('SELECT event_id FROM pending_profile_events WHERE session_id=? AND resolved_at IS NULL ORDER BY event_id').all(expected.sessionId),expected.ids);
  assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
  controller.runtime.onGameState('running');live.start();
  assert.equal((await service.select(expected.b,replay)).success,true);
  assert.equal(sum(expected.b),0);assert.equal(store.pending(expected.sessionId).length,2);
  assert.equal(service.assignSession(expected.sessionId,replay).success,true);
  assert.equal(sum(expected.b),-13);assert.equal(store.pending(expected.sessionId).length,0);
  assert.equal(built('modules/xpTracker').xpTracker.getStats().total,0,'이전 세션의 경험치를 현재 측정에 적용하지 않는다.');
  assert.equal(service.assignSession(expected.sessionId,replay).success,true);assert.equal(sum(expected.b),-13);
  const sync=built('modules/chatLogSyncManager');
  const result=await sync.syncWeeklyChatLogs({profileId:expected.b,startDate:new Date(day+'T00:00:00'),endDate:new Date(day+'T00:00:00'),reanalyzeCompletedLogs:true});
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(sum(expected.a),-37);assert.equal(sum(expected.b),-13);
  live.stop();await sync.stopHistoricalChatLogSync();application.stopProfileApplication();controller.dispose();config.beginExternalRestore();diary.suspendForRestore();
}
run().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
