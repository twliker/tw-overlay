/** 실제 설정 HTML/preload/IPC/SQLite 및 프로필 전환의 초안 경계를 확인한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow,dialog,ipcMain} from 'electron';

const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-settings-'));
const output=path.join(root,'output/profile-settings');
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const pause=(ms=30) => new Promise(resolve => setTimeout(resolve,ms));
const js=(win:BrowserWindow,source:string):Promise<any> => win.webContents.executeJavaScript(source);
async function until(win:BrowserWindow,source:string):Promise<void> {
  for (let n=0;n<200;n++) {if (await js(win,`Boolean(${source})`)) return;await pause();}
  throw new Error(`Timed out: ${source}`);
}
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(output,{recursive:true});
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,pinnedNoteText:'A 저장값',volumeCalculators:30,
    analyticsEnabled:false,autoLaunch:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,
    contentsCheckerEnabled:false,showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,pinnedNoteEnabled:false,
    characterPresets:[{id:'A',name:'사냥 <A>'},{id:'B',name:'다른 프로필 B'}],selectedCharacterId:'A'}),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline fixture');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  const a=store.list().find((p:any) => p.name==='사냥 <A>'),b=store.list().find((p:any) => p.name==='다른 프로필 B');
  store.saveProjection(b.id,{...store.project(b.id,config.load()),userServer:16,pinnedNoteText:'B 저장값'});
  let cancelAfterPrepare=false;
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {},prepareTransition:async () => !cancelAfterPrepare});
  const {service,replay}=controller.runtime;service.beginSession('settings-ui');assert.equal((await service.select(a.id,replay)).success,true);
  let before:Promise<void> | undefined,after:Promise<void> | undefined,releaseBefore:()=>void=() => {},releaseAfter:()=>void=() => {},entered=0,committed=0;
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler) => register(channel,async (event,...args) => {
    if (channel==='apply-settings-confirmed') {entered++;if (before) await before;}
    const result=await handler(event,...args);
    if (channel==='apply-settings-confirmed') {committed++;if (after) await after;}
    return result;
  });
  built('modules/ipcHandlers').register();ipcMain.handle=register;
  let response=2,questions=0;
  const originalMessage=dialog.showMessageBox;
  dialog.showMessageBox=(async (_win:unknown,options:any) => {
    assert.equal(await js(_win as BrowserWindow,'document.body.inert'),true,'선택 확인 중 원래 입력을 잠근다');
    assert.deepEqual(options.buttons,['저장 후 전환','저장하지 않고 전환','취소']);assert.equal(options.cancelId,2);
    assert.match(options.message,/변경한 설정/);questions++;return {response};
  }) as typeof dialog.showMessageBox;
  const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  try {
    await win.loadFile(path.join(root,'dist/settings.html'));win.webContents.send('config-data',config.load());
    await until(win,'window.settingsProfileTransition?.status().ready && _initReady');
    const state=() => js(win,'window.settingsProfileTransition.status()');
    const note=() => js(win,`document.getElementById('pinned-note-text').value`);
    const edit=async (text:string) => js(win,`document.getElementById('pinned-note-text').value=${JSON.stringify(text)};document.getElementById('pinned-note-text').dispatchEvent(new Event('input',{bubbles:true}))`);
    const saved=(id:string) => store.project(id,config.load()).pinnedNoteText;
    const ready=async (id:string) => {await until(win,`window.settingsProfileTransition.status().profileId===${JSON.stringify(id)} && !document.body.inert`);};
    assert.equal((await state()).dirty,false,'처음 연 설정은 미저장 초안이 아니다');
    assert.equal(await note(),'A 저장값');assert.match(await js(win,`document.getElementById('settings-profile-target').textContent`),/사냥 <A>.*하이아칸/);
    assert.equal(await js(win,`document.querySelector('#settings-profile-target a')`),null);
    store.database.prepare("DELETE FROM profile_settings WHERE profile_id=? AND key='userServer'").run(a.id);config.refreshFromPersistence();win.webContents.send('config-data',config.load());await pause(70);
    assert.equal(await js(win,`document.getElementById('chat-overlay-user-server-input').value`),'','기존 서버가 없으면 임의 서버를 선택하지 않는다');
    assert.equal(await js(win,'saveSettings(true)'),false);assert.equal(config.load().userServer,undefined);
    assert.match(await js(win,`document.getElementById('settings-profile-status').textContent`),/서버를 선택/);
    store.update(a.id,a.name,7);config.refreshFromPersistence();win.webContents.send('config-data',config.load());await pause(70);
    await js(win,`document.getElementById('settings-quick-search').value='위치';document.getElementById('settings-quick-search').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('alarm-log-filter').value='system'`);
    const q=questions;assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);assert.equal(questions,q,'검색/조회 필터만 바꾸면 확인하지 않는다');
    assert.equal(await note(),'B 저장값');assert.match(await js(win,`document.getElementById('settings-profile-target').textContent`),/네냐플/);
    assert.equal(await js(win,`document.getElementById('settings-quick-search').value`),'위치','전환해도 검색/조회 화면 상태 유지');await js(win,'clearSettingsSearch()');
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);

    await edit('A 작성 중');
    assert.equal((await service.select(a.id,replay)).success,true);assert.equal(questions,q);assert.equal(await note(),'A 작성 중');
    response=2;let result=await service.select(b.id,replay);assert.equal(result.success,false);await ready(a.id);
    assert.equal(await note(),'A 작성 중');assert.equal(saved(a.id),'A 저장값');assert.equal((await state()).dirty,true);
    response=1;cancelAfterPrepare=true;result=await service.select(b.id,replay);assert.equal(result.success,false);await ready(a.id);
    assert.equal(await note(),'A 작성 중','버리기 선택 후 전환 자체가 실패하면 초안 보존');cancelAfterPrepare=false;
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    assert.equal(await note(),'B 저장값');assert.equal(saved(a.id),'A 저장값');assert.equal((await state()).dirty,false);

    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    await edit('저장 실패 초안');response=0;
    store.database.exec("CREATE TRIGGER fail_profile_settings BEFORE INSERT ON profile_settings WHEN NEW.key='pinnedNoteText' BEGIN SELECT RAISE(ABORT,'settings fixture failure');END");
    result=await service.select(b.id,replay);assert.equal(result.success,false);await ready(a.id);
    assert.equal(await note(),'저장 실패 초안');assert.equal(saved(a.id),'A 저장값');assert.equal(saved(b.id),'B 저장값');
    assert.equal((await state()).dirty,true);assert.match(await js(win,`document.getElementById('settings-profile-status').textContent`),/저장하지 못/);
    store.database.exec('DROP TRIGGER fail_profile_settings');
    await js(win,`document.getElementById('volume-calculators').value='45'`);
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    assert.equal(saved(a.id),'저장 실패 초안');assert.equal(saved(b.id),'B 저장값');assert.equal(config.load().volumeCalculators,45);
    assert.equal(win.isDestroyed(),false,'전환을 위한 저장은 설정 창을 닫지 않는다');

    // 작성 중이지만 아직 목록에 추가하지 않은 입력은 저장 성공으로 오인하지 않는다.
    await js(win,`document.getElementById('shout-keyword-input').value='미등록 키워드'`);
    result=await service.select(a.id,replay);assert.equal(result.success,false);await ready(b.id);
    assert.equal(await js(win,`document.getElementById('shout-keyword-input').value`),'미등록 키워드');
    response=1;assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    assert.equal(await js(win,`document.getElementById('shout-keyword-input').value`),'');

    // 일반 즉시 적용의 응답 대기 중에는 전환을 막고 실제 저장 완료 뒤 재시도한다.
    before=new Promise(resolve => {releaseBefore=resolve;});const count=entered;
    await edit('즉시 적용 A');await js(win,`window.pendingImmediate=applySettingsWithDraft({pinnedNoteText:'즉시 적용 A'},['pinned-note-text']);void 0`);
    for (let n=0;n<100 && entered===count;n++) await pause();assert.ok(entered>count);
    result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/저장 중/);
    releaseBefore();before=undefined;assert.equal((await js(win,'window.pendingImmediate')).success,true);assert.equal(saved(a.id),'즉시 적용 A');
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);

    // 메인에 늦게 도착한 이전 프로필 요청은 공통 항목까지 원자적으로 거부한다.
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    before=new Promise(resolve => {releaseBefore=resolve;});const oldCount=entered;
    await js(win,`window.staleWrite=electronAPI.applySettingsConfirmed({pinnedNoteText:'다른 프로필 오염',volumeCalculators:99},${JSON.stringify(a.id)});void 0`);
    for (let n=0;n<100 && entered===oldCount;n++) await pause();assert.ok(entered>oldCount);
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    releaseBefore();before=undefined;assert.deepEqual(await js(win,'window.staleWrite'),{success:false,error:'profile-changed'});
    assert.equal(saved(a.id),'즉시 적용 A');assert.equal(saved(b.id),'B 저장값');assert.equal(config.load().volumeCalculators,45);
    const blankGuard=built('modules/profileSettingsAccess').validateSettingsProfileWrite;
    assert.equal(blankGuard(win.webContents,undefined),'profile-changed');
    assert.equal(blankGuard({getURL() {throw new Error('closed frame');}},undefined),'profile-changed');

    // 강제로 새 설정을 수신한 예외에서도 이전 성공 ACK가 새 프로필의 초안 기준을 바꾸지 않는다.
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    after=new Promise(resolve => {releaseAfter=resolve;});const c=committed;
    await edit('늦은 성공 A');await js(win,`window.oldSuccess=applySettingsWithDraft({pinnedNoteText:'늦은 성공 A'},['pinned-note-text']);void 0`);
    for (let n=0;n<100 && committed===c;n++) await pause();assert.ok(committed>c);
    assert.equal(config.saveConfirmed({activePlayProfileId:b.id}),true);win.webContents.send('config-data',config.load());await ready(b.id);
    await edit('B의 새 초안');releaseAfter();after=undefined;assert.equal((await js(win,'window.oldSuccess')).success,true);
    win.webContents.send('config-data',config.load());await pause(80);
    assert.equal(await note(),'B의 새 초안');assert.equal((await state()).dirty,true);assert.equal(saved(b.id),'B 저장값');
    response=1;assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    await js(win,'isHudEditing=true');result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/위치 편집/);
    await js(win,'isHudEditing=false');await ready(a.id);
    assert.equal((await state()).dirty,false);
    assert.equal(service.update(a.id,'새 표시 이름 <A>',7).success,true);
    await until(win,`document.getElementById('settings-profile-target').textContent.includes('새 표시 이름 <A>')`);
    assert.equal(await js(win,`document.getElementById('settings-profile-status').textContent`),'');
    assert.equal((await js(win,`electronAPI.applySettingsConfirmed({pinnedNoteText:${JSON.stringify(saved(a.id))}})`)).success,true,'preload도 마지막으로 수신한 프로필 ID를 기본 전달한다');
    await js(win,`clearSettingsSearch();document.querySelector('.content-area').scrollTop=0`);await pause(150);
    fs.writeFileSync(path.join(output,'settings-1100.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(800,600);await pause(150);fs.writeFileSync(path.join(output,'settings-800.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js(win,`(()=>{const r=document.getElementById('settings-profile-target').getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth})()`),true);
    await edit('삭제 전 초안');response=2;assert.equal((await service.remove(a.id)).success,false);await ready(a.id);assert.equal(await note(),'삭제 전 초안');
    response=1;assert.equal((await service.remove(a.id)).success,true);await ready(b.id);assert.equal(await note(),'B 저장값');assert.equal((await state()).dirty,false);
    console.log('Profile settings: actual Save/Discard/Cancel, rollback/disk-failure draft preservation, frozen writes, late ACK isolation, busy/HUD guards and minimum-size UI passed.');
  } finally {
    dialog.showMessageBox=originalMessage;releaseBefore();releaseAfter();if (!win.isDestroyed()) win.destroy();
    controller.dispose();prepared.stopClock();config.flushPending();
  }
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
