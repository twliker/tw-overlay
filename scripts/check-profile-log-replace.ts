/** 실시간 감시 중 오늘 로그가 앞부분이 같은 더 짧은 파일로 바뀌어도 기록이 중복되거나 사라지지 않는지 실제 앱 조립으로 확인한다.
 * - in-place: 같은 경로를 짧은 사본으로 덮어쓴다(파일 ID 유지, 감시는 처음부터 다시 읽음). 이전에는 읽은 범위 끝이
 *   바뀌기 전 끝으로 남아 그 자리에 새로 쓰인 줄을 이미 처리한 줄로 버렸고, 처리 구간이 통째로 지워져 앞부분이 두 번 기록됐다.
 * - recreate: 파일을 지우고 짧은 사본을 새로 만든다(파일 ID·지문 변경, 내용 키는 같아 같은 원본 파일로 묶인다).
 * 두 경우 모두 앞부분 SEED는 한 번만(줄 귀속·남은 처리 구간으로 거름), 바뀐 뒤 새로 쓴 SEED는 한 번 기록돼야 한다.
 * 사용: npm run test:profile-log-replace */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawn} from 'node:child_process';
import {app} from 'electron';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const phase=argument('--phase');
const fixture=argument('--fixture') ? fs.realpathSync(argument('--fixture')!) : fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-log-replace-'));
assert.ok(path.basename(fixture).startsWith('tw-profile-log-replace-'));
const data=path.join(fixture,phase ?? 'driver'),logs=path.join(fixture,`logs-${phase ?? 'driver'}`);
fs.mkdirSync(data,{recursive:true});fs.mkdirSync(logs,{recursive:true});
app.setPath('userData',data);
app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist/modules',name+'.js'));
const pause=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string,ms=15_000):Promise<void> {
  const end=Date.now()+ms;
  while (Date.now()<end) {if (check()) return;await pause();}
  throw new Error(`${label} 대기 시간 초과`);
}
function seedLine(amount:number):string {
  const d=new Date();
  const time=`${String(d.getHours()).padStart(2,'0')}시 ${String(d.getMinutes()).padStart(2,'0')}분 ${String(d.getSeconds()).padStart(2,'0')}초`;
  return `<font size="2" color="white"> [ ${time}] </font> <font size="2" color="#ff64ff">콘텐츠 클리어 보상으로 ${amount} SEED를 획득했습니다.</font></br>\r\n`;
}

async function run(mode:'in-place' | 'recreate'):Promise<void> {
  assert.equal(built('config').saveConfirmed({chatLogPath:logs,userServer:7,analyticsEnabled:false}),true);
  const application=built('profileApplication');
  const clock=new (built('profileClock').ProfileClock)(async()=>{throw new Error('offline log replace fixture');});
  const controller=await application.startProfileApplication(()=>{},clock);
  built('diaryDb').initDb();
  built('chatLogProcessor').chatLogProcessor.start();
  const live=built('chatLogManager').chatLogManager;
  const {service,replay}=controller.runtime,store=service.store;
  await controller.runtime.onGameState('running');
  const profile=store.list()[0].id;
  assert.equal(service.update(profile,'교체 검사',7).success,true);
  if (service.status().selectionRequired) assert.equal((await service.select(profile,replay)).success,true);
  await until(()=>!service.status().selectionRequired && !service.status().busy,'프로필 선택');
  const file=live.getTodayFilePath();
  fs.writeFileSync(file,'﻿');
  live.start(false);
  const base=mode==='in-place' ? 92_000 : 93_000,amounts=Array.from({length:7},(_,index)=>base+index+1);
  const count=(amount:number)=>store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='calc' AND amount=?").get(amount).n as number;
  const append=(values:number[])=>{fs.appendFileSync(file,values.map(seedLine).join(''));live._tail.refresh();};
  append(amounts.slice(0,3));
  await until(()=>amounts.slice(0,3).every(amount=>count(amount)===1),'앞부분 기록');
  const prefix=fs.readFileSync(file);
  await pause(1100);
  append(amounts.slice(3,5));
  await until(()=>amounts.slice(0,5).every(amount=>count(amount)===1),'뒷부분 기록');
  // 앞부분만 있는 사본으로 바꾼다(예: 이전 사본을 되돌림·동기화 도구가 이전 버전으로 교체).
  if (mode==='recreate') {fs.rmSync(file);await pause(300);}
  fs.writeFileSync(file,prefix);
  await pause(300);live._tail?.refresh();
  await pause(2500);
  for (const amount of amounts.slice(0,3)) assert.equal(count(amount),1,`${mode} ${amount}: 바뀐 파일을 처음부터 다시 읽어도 앞부분은 한 번만 기록`);
  // 바뀐 뒤 새로 쓴 줄(이전 끝보다 앞 위치)은 이미 처리한 줄로 버리지 않고 기록한다.
  await pause(1100);
  append(amounts.slice(5));
  await until(()=>amounts.slice(5).every(amount=>count(amount)>=1),`${mode} 바뀐 뒤 새 줄 기록`);
  await pause(1500);
  for (const amount of amounts) assert.equal(count(amount),1,`${mode} ${amount}: 정확히 한 번`);
  // 처리 구간은 지금 파일보다 길지 않다(잘린 뒤 늦게 쓴 구간이 앞으로 쓰일 줄을 덮지 않음).
  const size=fs.statSync(file).size;
  const maxEnd=store.database.prepare("SELECT MAX(end_offset) n FROM log_ranges WHERE state='applied'").get().n as number;
  assert.ok(maxEnd<=size,`${mode}: 처리 구간 끝(${maxEnd})이 파일 크기(${size})를 넘지 않는다`);
  live.stop();application.stopProfileApplication();controller.dispose();built('diaryDb').closeDb();
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
    assert.equal(await launch('in-place'),0,output.slice(-8000));
    assert.equal(await launch('recreate'),0,output.slice(-8000));
    console.log('PASS profile log replace: a shorter same-prefix rewrite (in place or recreated) is re-read without duplicate records, and lines written after it are recorded once');
  } finally {
    try {fs.rmSync(fixture,{recursive:true,force:true});} catch { /* Windows가 잠근 파일은 남긴다. */ }
  }
}

app.whenReady().then(()=>phase==='in-place' ? run('in-place') : phase==='recreate' ? run('recreate') : driver())
  .then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
