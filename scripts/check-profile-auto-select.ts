/** 프로필이 하나뿐이면 선택창 없이 자동으로 쓰는지 실제 앱 조립(startProfileApplication)으로 확인한다.
 * - fresh(신규 설치): 기본 프로필 하나가 이름·서버 없이 만들어지고, 그 상태로 게임을 켜면 선택창을 연다(입력 필요).
 *   이름·서버를 넣은 뒤 다음 게임 실행부터는 선택창 없이 자동 선택한다(최소화 시작 포함).
 *   프로필이 둘이면 선택창을 연다. 자동 선택이 실패하면 선택창을 연다.
 * - legacy(v3.2.2 사용자, 캐릭터 하나): 이전으로 이름·서버가 있는 프로필 하나가 되고, 첫 게임 실행부터 자동 선택한다.
 *   플레이 중 Google 적용이 다시 선택을 요구하면 자동 선택하지 않고 선택창을 연다(다음 게임 실행은 다시 자동 선택).
 * v3.3.5에서 올라온 경로는 check-profile-upgrade-335.ts가 함께 확인한다.
 * 사용: npm run test:profile-auto-select */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawn} from 'node:child_process';
import {app} from 'electron';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const phase=argument('--phase');
const fixture=argument('--fixture') ? fs.realpathSync(argument('--fixture')!) : fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-auto-select-'));
assert.ok(path.basename(fixture).startsWith('tw-profile-auto-select-'));
const data=path.join(fixture,phase ?? 'driver'),logs=path.join(fixture,`logs-${phase ?? 'driver'}`);
fs.mkdirSync(data,{recursive:true});fs.mkdirSync(logs,{recursive:true});
app.setPath('userData',data);
app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist/modules',name+'.js'));
const pause=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string,ms=15_000):Promise<void> {
  const end=Date.now()+ms;
  while (Date.now()<end) {if (check()) return;await pause();}
  throw new Error(`${label} 대기 시간 초과`);
}

async function start(legacy:Record<string,unknown>) {
  const config=built('config');
  assert.equal(config.saveConfirmed({chatLogPath:logs,analyticsEnabled:false,...legacy}),true);
  const application=built('profileApplication');
  const clock=new (built('profileClock').ProfileClock)(async()=>{throw new Error('offline auto-select fixture');});
  let windows=0;
  const controller=await application.startProfileApplication(()=>{windows++;},clock);
  built('diaryDb').initDb();
  const runtime=controller.runtime,service=runtime.service;
  return {application,controller,runtime,service,store:service.store,windows:()=>windows};
}
const selected=(service:any,id:string)=>()=>!service.status().selectionRequired && service.status().activeProfileId===id && !service.status().busy;

async function fresh():Promise<void> {
  const {application,controller,runtime,service,store,windows}=await start({});
  // 1. 신규 설치: 기본 프로필 하나가 이름·서버 없이 만들어진다.
  const profiles=store.list();
  assert.equal(profiles.length,1,'신규 설치는 프로필 하나를 자동으로 만든다');
  const id=profiles[0].id;
  assert.equal(profiles[0].name,'');assert.equal(profiles[0].userServer,null);
  // 이름·서버가 없으면 자동으로 쓸 수 없으므로 선택창을 연다.
  await runtime.onGameState('running',101);
  await pause(200);
  assert.equal(windows(),1,'이름·서버가 없는 하나뿐인 프로필은 선택창을 연다');
  assert.equal(service.status().selectionRequired,true);
  assert.equal(service.update(id,'자동 사용',7).success,true);
  assert.equal((await service.select(id,runtime.replay)).success,true);

  // 2. 이름·서버가 있는 하나뿐인 프로필: 다음 게임 실행부터 선택창 없이 자동 선택한다.
  await runtime.onGameState('not-running');
  assert.equal(service.status().selectionRequired,true);
  await runtime.onGameState('running',102);
  await until(selected(service,id),'게임 실행 시 자동 선택');
  assert.equal(windows(),1,'하나뿐인 프로필은 선택창을 열지 않는다');
  await runtime.onGameState('not-running');
  // 최소화로 시작해도 자동 선택한다(선택창은 원래 보일 때까지 보류하지만 자동 선택은 기다릴 필요가 없다).
  await runtime.onGameState('minimized',103);
  await until(selected(service,id),'최소화 시작 자동 선택');
  assert.equal(windows(),1);

  // 3. 프로필이 둘이면 선택창을 연다.
  const second=service.create('두 번째',7);
  assert.equal(second.success,true);
  await runtime.onGameState('not-running');await runtime.onGameState('running',104);
  await pause(200);
  assert.equal(windows(),2,'프로필이 둘이면 선택창을 연다');
  assert.equal(service.status().selectionRequired,true);
  const secondId=store.list().find((profile:any)=>profile.name==='두 번째').id;
  assert.equal((await service.select(id,runtime.replay)).success,true);
  assert.equal((await service.remove(secondId)).success,true);
  assert.equal(store.list().length,1);

  // 4. 자동 선택이 실패하면 선택창을 연다(게임이 보일 때).
  await runtime.onGameState('not-running');
  const original=service.select;
  let attempts=0;
  service.select=async()=>{attempts++;return {success:false,error:'fixture select failure',status:service.status()};};
  try {
    await runtime.onGameState('running',105);
    await until(()=>windows()===3,'자동 선택 실패 뒤 선택창');
    assert.equal(service.status().selectionRequired,true);
    // 최소화 동안 실패하면 폴링마다 다시 시도하지 않고, 게임이 보일 때 선택창을 연다.
    await runtime.onGameState('not-running');attempts=0;
    for (let poll=0;poll<5;poll++) {await runtime.onGameState('minimized',106);await pause(20);}
    assert.equal(attempts,1,'최소화 동안 자동 선택 실패는 한 번만 시도한다');
    assert.equal(windows(),3,'최소화 동안에는 선택창을 열지 않는다');
    await runtime.onGameState('running',106);
    await until(()=>windows()===4,'최소화 중 자동 선택 실패 뒤 게임이 보일 때 선택창');
    assert.equal(attempts,1,'보일 때는 다시 자동 선택하지 않고 선택창을 연다');
  } finally {service.select=original;}
  application.stopProfileApplication();controller.dispose();built('diaryDb').closeDb();
}

async function legacy():Promise<void> {
  // v3.2.2 사용자(캐릭터 하나, 서버 설정 있음): 이전하면 이름·서버가 있는 프로필 하나가 되고 첫 실행부터 자동 선택한다.
  const {application,controller,runtime,service,store,windows}=await start({
    userServer:7,characterPresets:[{id:'A',name:'예전 캐릭터'}],selectedCharacterId:'A',
  });
  const profiles=store.list();
  assert.equal(profiles.length,1);
  assert.equal(profiles[0].name,'예전 캐릭터');assert.equal(profiles[0].userServer,7);
  assert.equal(service.status().selectionRequired,true,'새 실행은 선택 대기로 시작한다');
  await runtime.onGameState('running',201);
  await until(selected(service,profiles[0].id),'v3.2.2 단일 캐릭터 자동 선택');
  assert.equal(windows(),0,'v3.2.2 단일 캐릭터 사용자는 선택창 없이 시작한다');
  // 플레이 중 Google 적용이 다시 선택을 요구하면(이름·서버 변경 확인·원격 교체) 자동 선택하지 않고 선택창을 연다.
  service.acceptSyncSelection();
  for (let poll=0;poll<3;poll++) {await runtime.onGameState('running',201);await pause(20);}
  await until(()=>windows()===1,'Google 다시 선택 요청의 선택창');
  assert.equal(service.status().selectionRequired,true,'Google 다시 선택 요청은 확인 전까지 선택 대기로 둔다');
  assert.equal((await service.select(profiles[0].id,runtime.replay)).success,true);
  // 다음 게임 실행(새 세션)은 다시 자동 선택한다.
  await runtime.onGameState('not-running');await runtime.onGameState('running',202);
  await until(selected(service,profiles[0].id),'다음 게임 실행 자동 선택');
  assert.equal(windows(),1);
  application.stopProfileApplication();controller.dispose();built('diaryDb').closeDb();
}

async function driver():Promise<void> {
  let output='';
  const launch=(which:string)=>new Promise<number | null>((resolve,reject)=>{
    const child=spawn(process.execPath,[__filename,'--phase',which,'--fixture',fixture],{windowsHide:true,stdio:'pipe'});
    child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));
    const timer=setTimeout(()=>child.kill(),90_000);
    child.once('exit',code=>{clearTimeout(timer);resolve(code);});child.once('error',reject);
  });
  try {
    assert.equal(await launch('fresh'),0,output.slice(-8000));
    assert.equal(await launch('legacy'),0,output.slice(-8000));
    console.log('PASS profile auto-select: fresh install creates one blank profile and opens selection, a sole named profile with a server is selected without the window (running and minimized starts, v3.2.2 single character), two profiles, failed auto-selection and a Google reselection request during play open the window');
  } finally {
    try {fs.rmSync(fixture,{recursive:true,force:true});} catch { /* Windows가 잠근 파일은 남긴다. */ }
  }
}

app.whenReady().then(()=>phase==='fresh' ? fresh() : phase==='legacy' ? legacy() : driver())
  .then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
