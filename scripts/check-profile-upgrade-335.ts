/** v3.3.5 → 현재 버전 업그레이드: v3.3.5 태그 빌드가 실제로 쓴 사냥 기록 DB를 현재 빌드로 연다.
 * - produce(별도 프로세스, v3.3.5 빌드 코드): 게임 실행 중 프로필 선택 전 줄(미배정 대기)을 기록하고, 프로필을 고른 뒤
 *   경험치·SEED 줄을 실시간으로 기록한다. v3.3.5는 줄마다 대기 원문(pending_profile_events)·줄 귀속·HUD 대기를 남긴다.
 * - upgrade(별도 프로세스, 현재 빌드): 같은 사용자 폴더를 열어 다음을 확인한다.
 *   일지 기록 보존 / 완료된 대기 원문이 1분 압축으로 처리 구간(log_ranges applied)이 되고 원문은 지워짐(영수증 없음) /
 *   재분석(이미 동기화한 로그도 다시 분석)이 중복을 만들지 않음 / 새 실시간 줄은 대기 원문 없이 바로 반영 /
 *   원문을 다 바꾼 뒤 한 번만 파일 축소를 판단(live_rows_converted).
 * v3.2.2에서 바로 올라오는 경로는 check-profile-upgrade.ts가 확인한다.
 * 사용: npm run test:profile-upgrade-335 (prepare-upgrade-baseline.js --tag v3.3.5 가 태그 빌드를 준비) */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawn} from 'node:child_process';
import {app} from 'electron';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const phase=argument('--phase');
const baseline=path.resolve(argument('--old-build') || path.join(root,'output/profile-upgrade-baseline/v3.3.5'));
const fixture=argument('--fixture') ? fs.realpathSync(argument('--fixture')!) : fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-upgrade-335-'));
assert.ok(path.basename(fixture).startsWith('tw-profile-upgrade-335-'));
const data=path.join(fixture,'data'),logs=path.join(fixture,'logs'),expectedPath=path.join(fixture,'expected.json');
fs.mkdirSync(data,{recursive:true});fs.mkdirSync(logs,{recursive:true});
app.setPath('userData',phase ? data : path.join(fixture,'driver'));
app.on('window-all-closed',()=>{});
const pause=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string,ms=20_000):Promise<void> {
  const end=Date.now()+ms;
  while (Date.now()<end) {if (check()) return;await pause();}
  throw new Error(`${label} 대기 시간 초과`);
}
function line(message:string):string {
  const d=new Date();
  const time=`${String(d.getHours()).padStart(2,'0')}시 ${String(d.getMinutes()).padStart(2,'0')}분 ${String(d.getSeconds()).padStart(2,'0')}초`;
  return `<font size="2" color="white"> [ ${time}] </font> <font size="2" color="#ff64ff">${message}</font></br>\r\n`;
}
const seed=(amount:number)=>line(`콘텐츠 클리어 보상으로 ${amount} SEED를 획득했습니다.`);
const xp=(amount:number)=>line(`경험치가 ${amount.toLocaleString('en-US')} 올랐습니다.`);
const BEFORE_SELECTION=[33_101,33_102],LIVE=[33_201,33_202,33_203],AFTER_UPGRADE=33_301;

async function start(buildRoot:string) {
  const built=(name:string)=>require(path.join(buildRoot,'dist/modules',name+'.js'));
  const config=built('config');
  assert.equal(config.saveConfirmed({chatLogPath:logs,userServer:7,analyticsEnabled:false}),true);
  const application=built('profileApplication');
  const clock=new (built('profileClock').ProfileClock)(async()=>{throw new Error('offline upgrade fixture');});
  const controller=await application.startProfileApplication(()=>{},clock);
  built('diaryDb').initDb();
  built('contentsChecker').init();
  built('chatLogProcessor').chatLogProcessor.start();
  return {built,config,application,controller,live:built('chatLogManager').chatLogManager,store:controller.runtime.service.store,
    sync:built('chatLogSyncManager'),diary:built('diaryDb')};
}
const seedRows=(store:any,amount:number)=>store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='calc' AND amount=?").get(amount).n;

async function produce():Promise<void> {
  const version=JSON.parse(fs.readFileSync(path.join(baseline,'package.json'),'utf8')).version;
  assert.equal(version,'3.3.5','v3.3.5 태그 빌드로 데이터를 만든다');
  const {application,controller,live,store}=await start(baseline);
  const {service,replay}=controller.runtime;
  await controller.runtime.onGameState('running');
  const file=live.getTodayFilePath();
  fs.writeFileSync(file,'﻿');
  live.start(false);
  // 프로필 선택 전 줄: 미배정 대기로 남는다.
  fs.appendFileSync(file,seed(BEFORE_SELECTION[0])+xp(1_000_001)+seed(BEFORE_SELECTION[1]));live._tail.refresh();
  await until(()=>store.pending().length>=2,'선택 전 대기');
  const profile=store.list()[0].id;
  assert.equal(service.update(profile,'3.3.5 사용자',7).success,true);
  assert.equal((await service.select(profile,replay)).success,true);
  await until(()=>BEFORE_SELECTION.every(amount=>seedRows(store,amount)===1),'선택 전 기록 배정');
  // 프로필 선택 뒤 사냥 줄: v3.3.5는 줄마다 대기 원문과 반영을 남긴다.
  fs.appendFileSync(file,LIVE.map((amount,index)=>xp(1_250_000+index)+seed(amount)).join(''));live._tail.refresh();
  await until(()=>LIVE.every(amount=>seedRows(store,amount)===1),'실시간 기록');
  const resolvedLive=store.database.prepare("SELECT COUNT(*) n FROM pending_profile_events WHERE resolved_at IS NOT NULL AND event_id GLOB 'live-line:*'").get().n;
  assert.ok(resolvedLive>=BEFORE_SELECTION.length+LIVE.length*2,`v3.3.5는 완료한 줄의 대기 원문을 남긴다: ${resolvedLive}`);
  application.checkpointProfileApplication();
  live.stop();application.stopProfileApplication();controller.dispose();
  fs.writeFileSync(expectedPath,JSON.stringify({profile,file,resolvedLive}));
}

async function upgrade():Promise<void> {
  const {profile,file,resolvedLive}=JSON.parse(fs.readFileSync(expectedPath,'utf8')) as {profile:string;file:string;resolvedLive:number};
  const {application,controller,live,store,sync}=await start(root);
  for (const amount of [...BEFORE_SELECTION,...LIVE]) assert.equal(seedRows(store,amount),1,`${amount}: v3.3.5 기록 보존`);
  const resolvedRows=()=>store.database.prepare("SELECT COUNT(*) n FROM pending_profile_events WHERE resolved_at IS NOT NULL AND (event_id GLOB 'live-line:*' OR event_id GLOB 'live:*')").get().n;
  assert.equal(resolvedRows(),resolvedLive,'열기만 해서는 원문을 지우지 않는다');
  assert.ok(store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_log_ranges_end'").get(),'v3.3.5 업그레이드: 구간 끝 인덱스');
  await controller.runtime.onGameState('running');
  assert.equal((await controller.runtime.service.select(profile,controller.runtime.replay)).success,true);
  // 1분 압축(체크포인트 포함): 완료한 실시간 줄 원문을 처리 구간으로 바꾸고 지운다.
  application.checkpointProfileApplication(true);application.checkpointProfileApplication(true);
  assert.equal(resolvedRows(),0,'완료한 v3.3.5 대기 원문은 처리 구간으로 바뀌고 지워진다');
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_event_receipts').get().n,0,'영수증을 만들지 않는다');
  assert.ok(store.database.prepare("SELECT COUNT(*) n FROM log_ranges WHERE state='applied' AND profile_id=?").get(profile).n>0);
  assert.equal(store.database.prepare("SELECT value FROM app_meta WHERE key='live_rows_converted'").get()?.value,'done','원문을 다 바꾼 뒤 파일 축소를 한 번만 판단한다');
  // 재분석해도 중복이 없다(처리 구간·줄 귀속으로 이미 아는 줄).
  const today=new Date();today.setHours(0,0,0,0);
  assert.equal((await sync.syncWeeklyChatLogs({profileId:profile,startDate:today,endDate:today,reanalyzeCompletedLogs:true})).success,true);
  for (const amount of [...BEFORE_SELECTION,...LIVE]) assert.equal(seedRows(store,amount),1,`${amount}: 재분석 뒤에도 한 건`);
  // 새 실시간 줄은 대기 원문 없이 바로 반영한다.
  live.start();
  fs.appendFileSync(file,seed(AFTER_UPGRADE));live._tail.refresh();
  await until(()=>seedRows(store,AFTER_UPGRADE)===1,'업그레이드 뒤 실시간 기록');
  await pause(500);
  assert.equal(seedRows(store,AFTER_UPGRADE),1);
  assert.equal(store.pending().filter((event:any)=>event.payload?.data?.amount===AFTER_UPGRADE).length,0);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM pending_profile_events WHERE json_extract(payload,'$.data.amount')=?").get(AFTER_UPGRADE).n,0,'바로 반영한 줄은 대기 원문이 없다');
  assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
  live.stop();application.stopProfileApplication();controller.dispose();
}

async function driver():Promise<void> {
  if (!fs.existsSync(path.join(baseline,'dist/modules/profileApplication.js'))) {
    throw new Error(`v3.3.5 태그 빌드가 없습니다: ${baseline}\n먼저 node dist-tools/prepare-upgrade-baseline.js --tag v3.3.5 를 실행하세요.`);
  }
  let output='';
  const launch=(which:string)=>new Promise<number | null>((resolve,reject)=>{
    const child=spawn(process.execPath,[__filename,'--phase',which,'--fixture',fixture,'--old-build',baseline],{windowsHide:true,stdio:'pipe'});
    child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));
    const timer=setTimeout(()=>child.kill(),120_000);
    child.once('exit',code=>{clearTimeout(timer);resolve(code);});child.once('error',reject);
  });
  try {
    assert.equal(await launch('produce'),0,output.slice(-8000));
    assert.equal(await launch('upgrade'),0,output.slice(-8000));
    console.log('PASS profile upgrade 3.3.5: real v3.3.5 pending/owner/runtime data preserved, resolved live rows converted to ranges without receipts, reanalysis without duplicates, new live lines applied directly');
  } finally {
    try {fs.rmSync(fixture,{recursive:true,force:true});} catch { /* Windows가 잠근 파일은 남긴다. */ }
  }
}

app.whenReady().then(()=>phase==='produce' ? produce() : phase==='upgrade' ? upgrade() : driver())
  .then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
