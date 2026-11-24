/** 개발 콘솔이 끊겨도 기록/저장과 파일 로그가 계속되는지 실제 logger/SQLite로 검사한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app} from 'electron';

const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-logger-'));
app.setPath('appData',fixture);app.setPath('userData',path.join(fixture,'userData'));
app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name+'.js'));
async function run():Promise<void> {
  await app.whenReady();
  const {log}=built('modules/logger'),constants=built('modules/constants');
  assert.equal(constants.IS_DEV,true);
  const original=console.log;let calls=0;
  try {
    console.log=()=>{calls++;throw Object.assign(new Error('fixture closed console pipe'),{code:'EPIPE'});};
    assert.doesNotThrow(()=>log('[LOGGER_TEST] sync pipe failed'),'콘솔 오류를 기능 호출자에게 전파하지 않는다.');
    assert.doesNotThrow(()=>log('[LOGGER_TEST] after sync failure'));
    assert.equal(calls,1,'이미 끊긴 콘솔에 반복 쓰지 않는다.');
  } finally {console.log=original;}
  assert.doesNotThrow(()=>process.stdout.emit('error',Object.assign(new Error('fixture asynchronous pipe failure'),{code:'EPIPE'})),
    '비동기 stdout 오류도 uncaughtException을 만들지 않는다.');
  const diary=built('modules/diaryDb');diary.initDb();
  assert.equal(diary.addHomeworkLog('2026-11-05','logger-homework','콘솔 오류 후 숙제','일일','daily',Date.now()),true);
  assert.ok(diary.addManualActivityLog('2026-11-05','10:00:00','calc','콘솔 오류 후 지출',-52800000));
  assert.equal(diary.getStmt('SELECT COUNT(*) n FROM homework_logs WHERE content_id=?').get('logger-homework').n,1);
  assert.equal(diary.getStmt('SELECT amount FROM activity_logs WHERE content=?').get('콘솔 오류 후 지출').amount,-52800000);
  diary.closeDb();
  const logPath=constants.get_LOG_PATH(),end=Date.now()+5000;
  while(!fs.existsSync(logPath) || !fs.readFileSync(logPath,'utf8').includes('[LOGGER_TEST] after sync failure')) {
    assert.ok(Date.now()<end,'콘솔 실패 후에도 파일 로그를 남긴다.');await new Promise(resolve=>setTimeout(resolve,20));
  }
  console.log('PASS logger: synchronous/asynchronous EPIPE contained, dead sink disabled, file log and real homework/negative SEED writes preserved');
}
run().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
