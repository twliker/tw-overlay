/** 프로필 진단 로그가 상태가 바뀔 때만 남고, 짧은 간격 안의 변화는 묶되 멈춘 상태는 결국 남기는지 실제 logger로 검사한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app} from 'electron';

const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-diag-'));
app.setPath('appData',fixture);app.setPath('userData',path.join(fixture,'userData'));
app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name+'.js'));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function run():Promise<void> {
  await app.whenReady();
  const constants=built('modules/constants');
  const diag=built('modules/profileDiagnostics');
  const logPath=constants.get_LOG_PATH();
  const lines=(key:string)=>fs.existsSync(logPath) ? fs.readFileSync(logPath,'utf8').split(/\r?\n/).filter(line=>line.includes(`[PROFILE_DIAG] ${key}=`)) : [];
  const waitFor=async (key:string,count:number,message:string)=>{
    const end=Date.now()+5000;
    while (lines(key).length<count) {assert.ok(Date.now()<end,message);await sleep(20);}
  };

  // 처음 상태는 남기고 같은 상태가 이어지면 남기지 않는다.
  diag.diagTransition('t-same','direct');
  for (let i=0;i<100;i++) diag.diagTransition('t-same','direct');
  await waitFor('t-same',1,'처음 상태를 남긴다.');
  await sleep(100);
  assert.equal(lines('t-same').length,1,'같은 상태가 이어지면 다시 남기지 않는다.');

  // 간격 0이면 바뀔 때마다 바로 남긴다.
  diag.diagTransition('t-zero','a',undefined,0);diag.diagTransition('t-zero','b',undefined,0);diag.diagTransition('t-zero','a',undefined,0);
  await waitFor('t-zero',3,'간격 0이면 모든 변화를 남긴다.');

  // 간격 안에서 다른 상태로 바뀌고 그대로 멈추면 간격이 지난 뒤 그 상태를 남긴다.
  diag.diagTransition('t-stuck','direct',undefined,300);
  diag.diagTransition('t-stuck','queued:owned-pending-first','session=abc',300);
  await waitFor('t-stuck',1,'처음 상태를 남긴다.');
  await sleep(100);
  assert.equal(lines('t-stuck').length,1,'간격 안의 변화는 바로 남기지 않는다.');
  await waitFor('t-stuck',2,'멈춘 상태는 간격이 지나면 남긴다.');
  assert.match(lines('t-stuck')[1],/t-stuck=queued:owned-pending-first session=abc \(그 사이 1회 변화\)/);

  // 간격 안에서 바뀌었다가 원래 상태로 돌아오면 남기지 않는다.
  diag.diagTransition('t-flip','direct',undefined,200);
  diag.diagTransition('t-flip','queued:selecting',undefined,200);
  diag.diagTransition('t-flip','direct',undefined,200);
  await sleep(400);
  assert.equal(lines('t-flip').length,1,'잠깐 바뀌었다 돌아온 상태는 남기지 않는다.');

  // 드문 사건은 매번 남긴다.
  diag.diagEvent('t-event','selected profile=abcd1234 again=true');
  diag.diagEvent('t-event','selected profile=abcd1234 again=true');
  const end=Date.now()+5000;
  while ((fs.readFileSync(logPath,'utf8').match(/\[PROFILE_DIAG\] t-event selected/g) || []).length<2) {
    assert.ok(Date.now()<end,'드문 사건은 매번 남긴다.');await sleep(20);
  }
  assert.equal(diag.shortId('36c046d8-42c0-4d60-b3b4-6bc2c76275ca'),'36c046d8');
  assert.equal(diag.shortId(null),'-');
  diag.resetProfileDiagnostics();
  console.log('PASS profile diagnostics: transitions only, coalesced flips, stuck state logged after interval, events always logged');
}
run().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
