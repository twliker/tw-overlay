/** 실시간 읽기 commit을 flush 없이(WAL synchronous=NORMAL) 확정해도 정전 때 기록을 잃지 않는지 별도 프로세스로 확인한다.
 * - produce: 실제 파일 감시·프로필 기록으로 SEED 줄을 세 번 나눠 기록한다. 두 번째 읽기의 기록 commit 직후,
 *   감시 북마크 commit 직전에 DB 파일(app-data.db, -wal)을 복사한다. 이것이 "그 뒤 commit이 디스크에 닿기 전에
 *   전원이 꺼진" 디스크 상태다(WAL은 앞에서부터 이어진 commit만 복구한다).
 * - driver: produce를 정상 종료 없이 끝낸 뒤 DB 파일을 그 복사본으로 되돌린다(-shm 삭제).
 * - recover: 같은 로그 폴더로 다시 실행한다. 되돌아간 북마크부터 원본을 다시 읽어 잃은 줄을 기록하고,
 *   이미 DB에 남은 줄은 이벤트 ID로 걸러 모든 SEED가 정확히 한 번 남는지 확인한다(at-least-once, 중복 없음).
 * - 각 읽기에는 경험치 줄(일지에 남지 않는 기록)도 섞는다. 바로 반영한 줄은 대기 원문 없이 프로필별 읽은 범위만 남고,
 *   재시작해 되돌아간 북마크부터 다시 읽어도 그 범위로 걸러 다시 대기에 넣지 않는다. 첫 읽기 뒤 HUD 체크포인트를 하고
 *   둘째 읽기 뒤 정전되면, 재시작 선택 때 체크포인트 뒤 범위(둘째 읽기)를 원본에서 다시 읽어 HUD 경험치를 복원한다.
 * - 체크포인트 뒤 경험치 줄만 있는 읽기는 DB를 바꾸지 않고(처리 구간을 메모리에 미룸), 둘째 읽기(기록 있음)가 같은 commit에
 *   함께 쓴다. 그래서 그 경험치도 HUD 복원에 들어간다. 경험치만 읽은 뒤 강제 종료하는 경우는 check-profile-crash.ts가 본다.
 * 함께 확인: 실시간 읽기 범위 안에서도 기기 설정 JSON을 바꾸는 commit은 FULL로 확정하고, 범위가 끝나면 FULL로 돌아온다.
 * 사용: npm run test:profile-durability */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawn} from 'node:child_process';
import {app} from 'electron';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const phase=argument('--phase');
const fixture=argument('--fixture') ? fs.realpathSync(argument('--fixture')!) : fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-durability-'));
assert.ok(path.basename(fixture).startsWith('tw-profile-durability-'));
const data=path.join(fixture,'data'),logs=path.join(fixture,'logs'),snapshot=path.join(fixture,'power-loss');
fs.mkdirSync(data,{recursive:true});fs.mkdirSync(logs,{recursive:true});
app.setPath('userData',phase ? data : path.join(fixture,'driver'));
app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist/modules',name+'.js'));
const pause=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string,ms=15_000):Promise<void> {
  const end=Date.now()+ms;
  while (Date.now()<end) {if (check()) return;await pause();}
  throw new Error(`${label} 대기 시간 초과`);
}
const DB_FILES=['app-data.db','app-data.db-wal'];
const AMOUNTS=Array.from({length:15},(_,index)=>81_001+index);
/** 읽기마다 SEED 줄 다음에 붙이는 경험치 줄(정수 교환이 아니므로 일지에 남지 않는다). */
const XP_AMOUNTS=[[1_250_001,1_250_002],[1_250_003,1_250_004],[1_250_005,1_250_006]];
/** 체크포인트 뒤 경험치 줄만 있는 읽기(사냥 중 대부분). DB에 바로 쓰지 않고 다음 기록 있는 읽기와 함께 쓴다. */
const XP_ONLY=[1_250_101,1_250_102];
const expectedPath=path.join(fixture,'expected.json');

function seedLine(amount:number):string {
  const d=new Date();
  const time=`${String(d.getHours()).padStart(2,'0')}시 ${String(d.getMinutes()).padStart(2,'0')}분 ${String(d.getSeconds()).padStart(2,'0')}초`;
  return `<font size="2" color="white"> [ ${time}] </font> <font size="2" color="#ff64ff">콘텐츠 클리어 보상으로 ${amount} SEED를 획득했습니다.</font></br>\r\n`;
}
/** 자기 획득 줄. 등록 아이템(LOOT_KEYWORD)만 일지 득템으로 남고 줄 귀속을 만든다. 등록하지 않은 아이템 줄은
 * 사냥 중 대부분인데 귀속을 만들지 않는다(recordsLootLine 계약: 이전에는 이 줄마다 귀속 행이 쌓였다). */
const LOOT_KEYWORD='정전 검사 보석',UNREGISTERED_LOOT='정전 검사 돌멩이';
function lootLine(item:string):string {
  const d=new Date();
  const time=`${String(d.getHours()).padStart(2,'0')}시 ${String(d.getMinutes()).padStart(2,'0')}분 ${String(d.getSeconds()).padStart(2,'0')}초`;
  return `<font size="2" color="white"> [ ${time}] </font> <font size="2" color="#ff64ff">[${item}] 아이템을 획득하였습니다.</font></br>
`;
}
function xpLine(amount:number):string {
  const d=new Date();
  const time=`${String(d.getHours()).padStart(2,'0')}시 ${String(d.getMinutes()).padStart(2,'0')}분 ${String(d.getSeconds()).padStart(2,'0')}초`;
  return `<font size="2" color="white"> [ ${time}] </font> <font size="2" color="#ff64ff">경험치가 ${amount.toLocaleString('en-US')} 올랐습니다.</font></br>\r\n`;
}
/** 대기 원문으로 남은 경험치 이벤트 수(금액별). */
function pendingXp(store:any,amount:number):number {
  return store.database.prepare("SELECT COUNT(*) n FROM pending_profile_events WHERE event_id GLOB 'live-line:*:XP_CHANGED:*' AND json_extract(payload,'$.data.amount')=?").get(amount).n;
}

async function startApplication() {
  const config=built('config');
  const application=built('profileApplication');
  const clock=new (built('profileClock').ProfileClock)(async()=>{throw new Error('offline durability fixture');});
  const controller=await application.startProfileApplication(()=>{},clock);
  built('diaryDb').initDb();
  built('chatLogProcessor').chatLogProcessor.start();
  const live=built('chatLogManager').chatLogManager;
  return {config,application,controller,live,store:controller.runtime.service.store};
}

/** 프로필별 기록(activity_logs)과 아직 배정하지 않은 대기 기록에서 금액별 개수를 센다. */
function countAmounts(store:any):Record<number,{recorded:number;pending:number}> {
  const result:Record<number,{recorded:number;pending:number}>={};
  for (const amount of AMOUNTS) {
    result[amount]={recorded:store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='calc' AND amount=?").get(amount).n,pending:0};
  }
  for (const event of store.pending()) {
    const amount=Number(event.payload?.data?.amount);
    if (result[amount]) result[amount].pending++;
  }
  return result;
}

async function produce():Promise<void> {
  const {config,controller,live,store,application}=await (async()=>{
    assert.equal(built('config').saveConfirmed({chatLogPath:logs,userServer:7,analyticsEnabled:false,lootKeywords:[LOOT_KEYWORD]}),true);
    return startApplication();
  })();
  const {service,replay}=controller.runtime;
  await controller.runtime.onGameState('running');
  const profile=store.list()[0].id;
  assert.equal(service.update(profile,'정전 검사',7).success,true);
  assert.equal((await service.select(profile,replay)).success,true);
  const file=live.getTodayFilePath();
  fs.writeFileSync(file,'﻿');
  live.start(false);
  const recorded=(amounts:number[])=>amounts.every(amount=>countAmounts(store)[amount].recorded===1);
  const append=(amounts:number[],xp:number[],loot:string[]=[])=>{fs.appendFileSync(file,amounts.map(seedLine).join('')+loot.map(lootLine).join('')+xp.map(xpLine).join(''));live._tail.refresh();};
  const lootRows=(item:string)=>store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='loot' AND content LIKE ?").get(`%${item}%`).n;

  const xpTracker=built('xpTracker').xpTracker;
  // 미룬 구간은 묶음 commit 뒤에만 늘린다(transaction 안에서 늘리면 commit 실패 때 메모리 구간이 남아 재시도 줄과 겹친다).
  const deferCalls={total:0,insideTransaction:0},deferApplied=store.deferAppliedRange.bind(store);
  store.deferAppliedRange=(...values:unknown[])=>{deferCalls.total++;if (store.database.inTransaction) deferCalls.insideTransaction++;return deferApplied(...values);};
  xpTracker.startSession();
  append(AMOUNTS.slice(0,5),XP_AMOUNTS[0],[UNREGISTERED_LOOT,LOOT_KEYWORD,UNREGISTERED_LOOT]);
  await until(()=>recorded(AMOUNTS.slice(0,5)) && lootRows(LOOT_KEYWORD)===1,'첫 읽기 기록');
  assert.equal(lootRows(UNREGISTERED_LOOT),0,'등록하지 않은 아이템은 일지에 남지 않는다');
  await until(()=>xpTracker.captureProfileState().total===XP_AMOUNTS[0][0]+XP_AMOUNTS[0][1],'첫 읽기 HUD 경험치');
  // 1분 HUD 체크포인트: 여기까지의 HUD와 읽은 범위 끝을 저장한다.
  application.checkpointProfileApplication(true);

  // 경험치 줄만 있는 읽기: DB에 쓰지 않고 처리 구간을 메모리에 미룬다. 다음 기록 있는 읽기가 같은 commit에 함께 쓴다.
  const rangeEnd=()=>store.database.prepare("SELECT MAX(end_offset) n FROM log_ranges WHERE state='applied'").get().n;
  const endBefore=rangeEnd(),changesBefore=store.database.prepare('SELECT total_changes() n').get().n;
  append([],XP_ONLY);
  await until(()=>xpTracker.captureProfileState().total===XP_AMOUNTS[0][0]+XP_AMOUNTS[0][1]+XP_ONLY[0]+XP_ONLY[1],'경험치만 읽은 HUD');
  assert.equal(store.hasDeferredRange,true,'경험치 줄만 읽은 구간은 메모리에 미룬다');
  assert.ok(deferCalls.total>0);
  assert.equal(deferCalls.insideTransaction,0,'미룬 구간은 묶음 transaction 안에서 늘리지 않는다');
  assert.equal(rangeEnd(),endBefore,'경험치 줄만 읽으면 처리 구간을 DB에 쓰지 않는다');
  assert.equal(store.database.prepare('SELECT total_changes() n').get().n,changesBefore,'경험치 줄만 읽으면 DB 변경이 없다');

  // 두 번째 읽기: 기록 commit 뒤, 북마크 commit 전에 디스크 상태를 복사한다.
  const saveHandoff=live.saveHandoff;
  let armed=true,captured=false;
  live.saveHandoff=function(this:unknown,key:string,...rest:unknown[]) {
    if (armed && key.startsWith('live-chat-watch:')) {
      armed=false;
      assert.ok(recorded(AMOUNTS.slice(5,10)),'북마크보다 기록이 먼저 commit된다');
      // 바로 반영한 줄은 대기 원문·줄 귀속·HUD 대기 행 없이 읽은 범위만 남는다.
      for (const amount of [...XP_AMOUNTS[0],...XP_ONLY,...XP_AMOUNTS[1]]) assert.equal(pendingXp(store,amount),0,`${amount}: 바로 반영한 경험치 줄은 대기 원문이 없다`);
      assert.equal(store.hasDeferredRange,false,'기록 있는 읽기는 미룬 구간을 같은 commit에 쓴다');
      assert.equal(store.database.prepare('SELECT COUNT(*) n FROM pending_profile_events').get().n,0,'바로 반영한 SEED 줄도 대기 원문이 없다');
      // 일지에 남는 SEED 줄만 줄 귀속(live=1)을 남기고(파일 교체 뒤 재읽기 중복 방지), 경험치 줄은 귀속을 만들지 않는다.
      // 자기 획득 줄도 등록 아이템(일지 득템) 줄만 귀속을 남긴다. 등록하지 않은 아이템 두 줄은 귀속이 없다.
      assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_log_line_owners').get().n,11,'줄 귀속은 일지에 남는 SEED·등록 아이템 줄만');
      assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_log_line_owners WHERE live=1 AND profile_id=?').get(profile).n,11);
      assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_runtime_events').get().n,0,'HUD 복원 대기 행도 없다');
      assert.equal(store.database.prepare("SELECT COUNT(*) n FROM log_ranges WHERE state='applied'").get().n,1,'이어지는 읽기는 한 반영 구간 행으로 늘어난다');
      fs.writeFileSync(path.join(fixture,'hud.json'),JSON.stringify({total:xpTracker.captureProfileState().total}));
      fs.mkdirSync(snapshot,{recursive:true});
      for (const name of DB_FILES) if (fs.existsSync(path.join(data,name))) fs.copyFileSync(path.join(data,name),path.join(snapshot,name));
      captured=true;
    }
    return saveHandoff.call(this,key,...rest);
  };
  append(AMOUNTS.slice(5,10),XP_AMOUNTS[1]);
  await until(()=>captured,'정전 시점 복사');
  live.saveHandoff=saveHandoff;

  // 세 번째 읽기: 이 기록과 북마크는 정전으로 사라진다.
  append(AMOUNTS.slice(10),XP_AMOUNTS[2]);
  await until(()=>recorded(AMOUNTS.slice(10)),'셋째 읽기 기록');

  // 실시간 읽기 범위 안에서도 기기 설정 JSON을 바꾸는 commit은 FULL로 확정한다(commit 뒤 journal을 지우기 때문).
  const database=store.database,originalTransaction=database.transaction;
  const commits:number[]=[];
  database.transaction=function(fn:(...args:unknown[])=>unknown) {
    const transaction=originalTransaction.call(database,fn);
    return Object.assign((...args:unknown[])=>{
      const top=!database.inTransaction,synchronous=database.pragma('synchronous',{simple:true}) as number;
      const result=transaction(...args);
      if (top) commits.push(synchronous);
      return result;
    },transaction);
  };
  const configPath=path.join(data,'config.json'),before=fs.readFileSync(configPath,'utf8');
  try {
    store.withRelaxedDurability(()=>{
      assert.equal(database.pragma('synchronous',{simple:true}),1,'실시간 읽기 범위는 NORMAL');
      assert.equal(config.saveConfirmed({chatOverlayEnabled:!config.load().chatOverlayEnabled}),true);
      assert.equal(database.pragma('synchronous',{simple:true}),1,'설정 commit 뒤 범위의 나머지는 다시 NORMAL');
    });
  } finally {database.transaction=originalTransaction;}
  assert.notEqual(fs.readFileSync(configPath,'utf8'),before,'기기 설정 JSON 경로로 저장했다');
  assert.ok(commits.length>0 && commits.every(value=>value===2),`기기 설정 commit은 FULL: ${JSON.stringify(commits)}`);
  assert.equal(database.pragma('synchronous',{simple:true}),2,'범위가 끝나면 FULL');

  fs.writeFileSync(expectedPath,JSON.stringify({profile}));
  // 정상 종료 경로(checkpoint·DB 닫기)를 거치지 않는다.
  process.exit(0);
}

async function recover():Promise<void> {
  const {profile}=JSON.parse(fs.readFileSync(expectedPath,'utf8')) as {profile:string};
  const {controller,live,store,application}=await startApplication();
  const lost=countAmounts(store);
  for (const amount of AMOUNTS.slice(0,10)) assert.equal(lost[amount].recorded,1,`${amount}: 정전 전에 commit된 기록은 남는다`);
  for (const amount of AMOUNTS.slice(10)) assert.equal(lost[amount].recorded+lost[amount].pending,0,`${amount}: 정전 뒤 commit은 사라졌다(검사 전제)`);
  await controller.runtime.onGameState('running');
  assert.equal((await controller.runtime.service.select(profile,controller.runtime.replay)).success,true);
  live.start();
  const total=(amount:number)=>{const value=countAmounts(store)[amount];return value.recorded+value.pending;};
  await until(()=>AMOUNTS.every(amount=>total(amount)>=1),'원본 로그에서 다시 기록');
  await pause(1500); // 늦은 재읽기·재시도가 중복을 만들지 않는지 본다.
  const counts=countAmounts(store);
  for (const amount of AMOUNTS) {
    assert.equal(counts[amount].recorded+counts[amount].pending,1,`${amount}: 정확히 한 번 남는다 ${JSON.stringify(counts[amount])}`);
  }
  for (const amount of AMOUNTS.slice(5,10)) assert.equal(counts[amount].pending,0,`${amount}: 북마크보다 앞서 commit된 기록은 다시 대기에 넣지 않는다`);
  // 압축한 경험치 줄은 북마크부터 다시 읽어도 영수증으로 걸러 다시 대기에 넣지 않는다(재시작 복구 읽기는 미배정 대기로 넣으므로
  // 걸러지지 않으면 미배정 기록으로 다시 보인다). 정전으로 사라진 셋째 읽기만 한 번 기록한다.
  for (const amount of [...XP_AMOUNTS[0],...XP_ONLY,...XP_AMOUNTS[1]]) assert.equal(pendingXp(store,amount),0,`${amount}: 반영한 범위의 경험치 줄은 다시 기록하지 않는다`);
  // 정전으로 사라진 경험치 줄은 재시작 복구 읽기에서 소유자를 확정할 수 없으므로 미배정 대기로도 남기지 않는다(HUD에서만 빠짐).
  for (const amount of XP_AMOUNTS[2]) assert.equal(pendingXp(store,amount),0,`${amount}: 소유자를 모르는 경험치 줄은 미배정 기록으로 쌓지 않는다`);
  // HUD: 체크포인트(첫 읽기) + 체크포인트 뒤 HUD 복원 구간(경험치만 읽은 줄, 둘째 읽기)을 원본에서 재생. 셋째 읽기는 HUD에 넣지 않는다.
  const hud=JSON.parse(fs.readFileSync(path.join(fixture,'hud.json'),'utf8')) as {total:number};
  assert.equal(hud.total,XP_AMOUNTS[0][0]+XP_AMOUNTS[0][1]+XP_ONLY[0]+XP_ONLY[1]+XP_AMOUNTS[1][0]+XP_AMOUNTS[1][1],'검사 전제: 정전 직전 HUD');
  assert.equal(built('xpTracker').xpTracker.captureProfileState().total,hud.total,'체크포인트 뒤 바로 반영한 줄의 HUD를 원본에서 복원');
  assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
  live.stop();application.stopProfileApplication();controller.dispose();built('diaryDb').closeDb();
}

async function driver():Promise<void> {
  let output='';
  const launch=(which:string)=>new Promise<number | null>((resolve,reject)=>{
    const child=spawn(process.execPath,[__filename,'--phase',which,'--fixture',fixture],{windowsHide:true,stdio:'pipe'});
    child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));
    const timer=setTimeout(()=>child.kill(),60_000);
    child.once('exit',code=>{clearTimeout(timer);resolve(code);});child.once('error',reject);
  });
  try {
    assert.equal(await launch('produce'),0,output.slice(-8000));
    assert.ok(fs.existsSync(expectedPath),output.slice(-8000));
    // 정전: 복사 시점 이후의 commit을 디스크에서 지운다.
    for (const name of DB_FILES) {
      const source=path.join(snapshot,name),target=path.join(data,name);
      if (fs.existsSync(source)) fs.copyFileSync(source,target); else fs.rmSync(target,{force:true});
    }
    fs.rmSync(path.join(data,'app-data.db-shm'),{force:true});
    assert.equal(await launch('recover'),0,output.slice(-8000));
    console.log('PASS profile durability: live-read commits use WAL NORMAL, device config commit stays FULL, lost tail commits are re-recorded once from the source log after simulated power loss, directly applied lines leave only read ranges and HUD is rebuilt from the source after the checkpoint');
  } finally {
    try {fs.rmSync(fixture,{recursive:true,force:true});} catch { /* Windows가 잠근 파일은 남긴다. */ }
  }
}

app.whenReady().then(()=>phase==='produce' ? produce() : phase==='recover' ? recover() : driver())
  .then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
