/** 프로필 전환 전 기존 Google 전송을 완전히 중지하고 로컬 데이터/인증을 보존한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {pathToFileURL} from 'node:url';
import { app, BrowserWindow } from 'electron';

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-cloud-pause-'));
app.setPath('userData',fixture);
const root=path.resolve(__dirname,'..');
const built=(file:string) => require(path.join(root,'dist',file));

async function run():Promise<void> {
  await app.whenReady();
  const config=built('modules/config');
  assert.equal(config.saveConfirmed({googleSyncEnabled:true,googleSyncAutoSync:true,userServer:7,pinnedNoteText:'로컬 메모'}),true);
  const auth=built('modules/googleAuth');
  const drive=built('modules/googleDriveSync');
  const state=built('modules/cloudSyncState');
  let loginRequests=0,logoutRequests=0,networkRequests=0;
  auth.isLoggedIn=() => true;
  auth.loadStoredProfile=() => ({email:'fixture@example.invalid'});
  let resolveLogin!:(value:unknown) => void;
  auth.startLogin=() => {++loginRequests;return new Promise(resolve => {resolveLogin=resolve;});};
  auth.logout=() => {++logoutRequests;};
  let resolveList!:(files:unknown[]) => void;
  let announceList!:() => void;
  const listStarted=new Promise<void>(resolve => {announceList=resolve;});
  drive.listSyncFiles=() => {++networkRequests;announceList();return new Promise(resolve => {resolveList=resolve;});};
  for (const method of ['downloadJsonPayload','uploadJsonPayload','getFileEtag']) drive[method]=async () => {++networkRequests;throw new Error(`중지 후 네트워크 요청: ${method}`);};
  const cloud=built('modules/cloudSyncManager');
  cloud.initializeLocalProfileState();
  const credential=path.join(fixture,'google_auth.enc');
  fs.writeFileSync(credential,'preserve-credential-fixture');
  const credentialBefore=fs.readFileSync(credential);
  const lateLogin=cloud.loginAndInit();
  const preview=cloud.getCloudDataPreview();
  await listStarted;
  // 시작한 전송 뒤에 예약된 전송도 실제 실행 때 중지 상태를 확인해야 한다.
  const queued=cloud.syncToCloud(true).catch((error:Error) => ({success:false,error:error.message}));
  const stateBefore=structuredClone(state.load());
  let drained=false;
  const pause=cloud.pauseForPlayProfiles().then(() => {drained=true;});
  await Promise.resolve();
  assert.equal(drained,false,'기존 전송 배출 전에는 프로필 이전을 시작할 수 없음');
  resolveList([]);
  const latePreview=await preview;
  assert.equal(latePreview.success,false,'중지 뒤 도착한 목록으로 원격 처리를 이어가지 않음');
  assert.match(latePreview.error,/일시 중지/);
  assert.equal((await queued).success,false,'예약됐던 전송도 차단');
  await pause;
  assert.equal(drained,true);
  const configBeforeLogin=structuredClone(config.load());
  resolveLogin({success:true,profile:{email:'late@example.invalid'}});
  assert.equal((await lateLogin).success,false,'중지 뒤 늦게 끝난 로그인으로 초기 동기화를 시작하지 않음');
  assert.deepEqual(config.load(),configBeforeLogin,'늦은 로그인은 새 로컬 설정을 덮지 않음');
  for (const result of [await cloud.loginAndInit(),await cloud.syncToCloud(true),await cloud.syncFromCloud(true),await cloud.getCloudDataPreview(),await cloud.rollbackLastRestore()]) {
    assert.equal(result.success,false);assert.match(result.error,/일시 중지/);
  }
  cloud.startBackgroundSync();cloud.requestDebouncedSync();cloud.requestImmediatePull('fixture-resume');cloud.refreshBackgroundSchedule();
  assert.equal(config.saveConfirmed({buffTimerEnabled:!config.load().buffTimerEnabled}),true,'로컬 설정은 계속 저장');
  assert.equal(cloud.prepareShutdownRecovery(),true);
  await cloud.flushPendingSync();
  cloud.logout();
  assert.equal(loginRequests,1,'중지 이후 새 로그인 요청 없음');assert.equal(logoutRequests,0);
  assert.equal(networkRequests,1,'중지 이전에 시작된 목록 요청 이외 네트워크 없음');
  assert.deepEqual(state.load(),stateBefore,'기존 dirty/outbox/복원 기준은 유지');
  assert.deepEqual(fs.readFileSync(credential),credentialBefore,'기존 인증 파일 보존');
  assert.equal(config.load().pinnedNoteText,'로컬 메모');
  const status=cloud.getSyncStatus();
  assert.equal(status.isLinked,true);assert.equal(status.autoSync,false);assert.match(status.pausedReason,/일시 중지/);

  // 실제 설정 카드 DOM과 제품 렌더러를 사용해 일시 중지 안내/버튼 숨김을 검사한다.
  const win=new BrowserWindow({show:false,width:820,height:680,webPreferences:{backgroundThrottling:false}});
  try {
    const emptyPage=path.join(fixture,'cloud-card-fixture.html');
    fs.writeFileSync(emptyPage,'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>설정 카드 검사</title></head><body></body></html>');
    await win.loadFile(emptyPage);
    const html=fs.readFileSync(path.join(root,'dist/settings.html'),'utf8');
    const renderer=fs.readFileSync(path.join(root,'dist/renderer/settings/profile-cloud-pause.js'),'utf8');
    assert.doesNotMatch(renderer,/\brequire\s*\(|\bexports\s*[.[]/,'브라우저 렌더러는 CommonJS에 의존하지 않음');
    await win.webContents.executeJavaScript(`(async () => {
      const parsed=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');
      document.body.replaceChildren(document.importNode(parsed.getElementById('google-sync-card'),true));
      document.body.style.cssText='padding:24px;background:var(--ui-panel);color:var(--ui-secondary)';
      await Promise.all([new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=${JSON.stringify(pathToFileURL(path.join(root,'dist/style.css')).href)};link.onload=resolve;link.onerror=reject;document.head.append(link);}),new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=${JSON.stringify(pathToFileURL(path.join(root,'dist/assets/tailwind.min.js')).href)};script.onload=resolve;script.onerror=reject;document.head.append(script);})]);
      ${renderer}
      return window.settingsProfileCloudPause.render(${JSON.stringify(status)});
    })()`);
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('google-sync-profile-paused').hidden"),false);
    assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('btn-google-backup')).display==='none' || getComputedStyle(document.getElementById('google-sync-linked-view')).display==='none'"),true);
    assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('google-sync-unlinked-view')).display"),'none');
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('google-sync-badge').textContent"),'일시 중지');
    assert.match(await win.webContents.executeJavaScript("document.getElementById('google-sync-profile-paused-account').textContent"),/기존 연결 정보는 보관/);
    await win.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))');
    const capture=path.join(fixture,'cloud-paused.png');
    fs.writeFileSync(capture,(await win.webContents.capturePage()).toPNG());
    console.log(`PASS profile cloud pause: in-flight/queued/manual/automatic isolation, local/credentials/outbox preserved, actual settings card; screenshot ${capture}`);
  } finally {win.destroy();}
}

run().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
