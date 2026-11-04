/** 독립 설정 5개 제품 창과 실제 preload/IPC/프로필 SQLite를 임시 userData에서 검사한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow,ipcMain,dialog} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-settings-pages-'));
const output=path.join(root,'output/profile-settings-pages');
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const pause=(ms=30) => new Promise(resolve => setTimeout(resolve,ms));
const js=(win:BrowserWindow,code:string):Promise<any> => win.webContents.executeJavaScript(code);
async function until(win:BrowserWindow,code:string):Promise<void> {
  for (let n=0;n<220;n++) {if (await js(win,`Boolean(${code})`)) return;await pause();}
  throw new Error(`Timed out (${path.basename(win.webContents.getURL())}): ${code}`);
}
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(output,{recursive:true});
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  assert.equal(config.saveConfirmed({...structuredClone(defaults),analyticsEnabled:false,userServer:7,
    chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,contentsCheckerEnabled:false,showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,pinnedNoteEnabled:false,
    characterPresets:[{id:'A',name:'사냥 <A>'},{id:'B',name:'다른 프로필 B'}],selectedCharacterId:'A',
    huntingExpKillsPerHour:1000,huntingExpHappyHour:false,buffTimerWarnSeconds:[60],xpAutoPauseSeconds:60,fieldBossNotifyVolume:0,bossEntryCountdownBosses:[],customAlerts:[]}),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  const a=store.list().find((p:any) => p.name==='사냥 <A>'),b=store.list().find((p:any) => p.name==='다른 프로필 B');
  store.saveProjection(b.id,{...store.project(b.id,config.load()),userServer:16,huntingExpKillsPerHour:2000,huntingExpHappyHour:true,buffTimerWarnSeconds:[30],xpAutoPauseSeconds:270});
  let cancelAfterPrepare=false;
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {},prepareTransition:async () => !cancelAfterPrepare});
  const {service,replay}=controller.runtime;service.beginSession('settings-pages');assert.equal((await service.select(a.id,replay)).success,true);
  let before:Promise<void> | null=null,after:Promise<void> | null=null,releaseBefore=() => {},releaseAfter=() => {},entered=0,committed=0;
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler) => register(channel,async (event,...args) => {
    if (channel==='apply-settings-confirmed') {entered++;if (before) await before;}
    const result=await handler(event,...args);
    if (channel==='apply-settings-confirmed' && result?.error==='invalid-settings') console.error('Invalid fixture page settings',args[0]);
    if (channel==='apply-settings-confirmed') {committed++;if (after) await after;}
    return result;
  });
  built('modules/ipcHandlers').register();ipcMain.handle=register;
  const files=['hunting-exp-calculator.html','xp-hud.html','buff-timer.html','boss-settings.html','custom-alert.html'];
  const windows:BrowserWindow[]=[];
  let response=2,questions=0;
  const originalMessage=dialog.showMessageBox;
  dialog.showMessageBox=(async (win:any,options:any) => {assert.equal(await js(win,'document.body.inert'),true);assert.deepEqual(options.buttons,['저장 후 전환','저장하지 않고 전환','취소']);questions++;return {response};}) as typeof dialog.showMessageBox;
  const state=(win:BrowserWindow) => js(win,'window.settingsProfileTransition.status()');
  const ready=async (win:BrowserWindow,id:string) => until(win,`window.settingsProfileTransition?.status().ready && window.settingsProfileTransition.status().profileId===${JSON.stringify(id)} && !window.settingsProfileTransition.status().busy && !document.body.inert`);
  const allReady=async (id:string) => {for (const win of windows) await ready(win,id);};
  const choose=async (id:string) => {const result=await service.select(id,replay);assert.equal(result.success,true,result.error);await allReady(id);};
  const projected=(id:string) => store.project(id,config.load());
  try {
    for (const file of files) {
      const win=new BrowserWindow({show:false,frame:false,width:1100,height:850,webPreferences:{preload:path.join(root,'dist/preload.js'),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
      windows.push(win);await win.loadFile(path.join(root,'dist',file));win.webContents.send('config-data',config.load());
      if (file==='boss-settings.html') win.webContents.send('boss-times-data',{'혼란한 대지':['00:00'],'골론':['00:00']});
      await ready(win,a.id);assert.equal((await state(win)).dirty,false,`${file} initially dirty`);
      assert.match(await js(win,`document.querySelector('.profile-settings-context').textContent`),/사냥 <A>.*하이아칸/);
      assert.equal(built('modules/profileSettingsAccess').validateSettingsProfileWrite(win.webContents,undefined),'profile-changed');
    }
    const [hunting,xp,buff,boss,alerts]=windows;
    // 타이핑 중 change 전 입력, 취소/버리기, 후속 전환 실패와 폼 저장 실패/재시도.
    await js(hunting,`document.getElementById('kills-per-hour').value='1234';document.getElementById('kills-per-hour').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal((await state(hunting)).dirty,true);const q=questions;
    assert.equal((await service.select(a.id,replay)).success,true);assert.equal(questions,q);
    assert.equal((await service.select(b.id,replay)).success,false);await allReady(a.id);assert.equal(await js(hunting,`document.getElementById('kills-per-hour').value`),'1234');
    response=1;cancelAfterPrepare=true;assert.equal((await service.select(b.id,replay)).success,false);await allReady(a.id);assert.equal(await js(hunting,`document.getElementById('kills-per-hour').value`),'1234');
    cancelAfterPrepare=false;await choose(b.id);assert.equal(await js(hunting,`document.getElementById('kills-per-hour').value`),'2000');assert.equal(projected(a.id).huntingExpKillsPerHour,1000);
    await choose(a.id);await js(hunting,`document.getElementById('add-ground-btn').click();document.getElementById('editor-name').value='A 사냥터';document.getElementById('editor-value').value='12345'`);
    response=0;store.database.exec("CREATE TRIGGER fail_page_save BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture save failure');END");
    assert.equal((await service.select(b.id,replay)).success,false);await allReady(a.id);
    assert.equal(await js(hunting,`document.getElementById('editor-name').value`),'A 사냥터');assert.equal(await js(hunting,`document.getElementById('editor-modal').classList.contains('hidden')`),false);
    store.database.exec('DROP TRIGGER fail_page_save');await choose(b.id);
    assert.equal(projected(a.id).huntingExpGrounds.filter((g:any)=>g.name==='A 사냥터').length,1);assert.equal(projected(b.id).huntingExpGrounds.some((g:any)=>g.name==='A 사냥터'),false);
    await choose(a.id);assert.equal(await js(hunting,`document.getElementById('ground-select').selectedOptions[0].textContent`),'A 사냥터');
    await js(hunting,`document.getElementById('add-doping-btn').click();document.getElementById('editor-name').value='실패 후 취소할 도핑';document.getElementById('editor-value').value='25'`);
    store.database.exec("CREATE TRIGGER fail_cancel_doping BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture cancel doping');END");
    await js(hunting,`document.getElementById('editor-form').requestSubmit()`);await until(hunting,`!settingsProfileTransition.status().busy && !document.querySelector('#editor-form button[type="submit"]').disabled`);
    await js(hunting,`document.getElementById('cancel-editor-btn').click()`);
    assert.equal(await js(hunting,`document.getElementById('doping-list').textContent.includes('실패 후 취소할 도핑')`),false);
    assert.equal((await state(hunting)).dirty,false);store.database.exec('DROP TRIGGER fail_cancel_doping');

    // 일부 필드 저장 ACK가 다른 초안을 승인하지 않는다. 경고 시점과 기기 음량 범위를 유지한다.
    await js(buff,`document.querySelector('.add-chip-btn').click();document.getElementById('add-warn-input').value='77';document.getElementById('confirm-add-warn').click();document.getElementById('master-toggle').checked=false;document.getElementById('master-toggle').dispatchEvent(new Event('change',{bubbles:true}))`);
    await ready(buff,a.id);assert.equal((await state(buff)).dirty,true);assert.equal(projected(a.id).buffTimerEnabled,false);
    assert.equal(projected(a.id).buffTimerWarnSeconds.includes(77),false);
    const originalBuffVolume=await js(buff,`document.getElementById('volume-slider').value`);
    assert.equal(config.saveConfirmed({buffTimerVolume:55}),true);
    for (const win of windows) win.webContents.send('config-data',config.load());
    await allReady(a.id);assert.equal(await js(buff,`document.getElementById('volume-slider').value`),originalBuffVolume);
    await choose(b.id);assert.equal(projected(a.id).buffTimerWarnSeconds.includes(77),true);assert.deepEqual(projected(b.id).buffTimerWarnSeconds,[30]);
    assert.equal(config.load().buffTimerVolume,55,'saving a profile draft must not restore an untouched old common volume');
    await choose(a.id);
    // 이전 저장을 기다리는 동안 원래 값으로 되돌린 입력도 생략하지 않는다.
    before=new Promise(resolve=>{releaseBefore=resolve;});const rapid=entered;
    await js(xp,`(()=>{const el=document.getElementById('toggle-xp-auto-start');el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    for (let n=0;n<100 && entered===rapid;n++) await pause();assert.equal(entered,rapid+1);
    before=null;releaseBefore();await ready(xp,a.id);assert.equal(projected(a.id).xpAutoStart,false);
    await js(xp,`document.getElementById('xp-idle-seconds').value='90';document.getElementById('xp-idle-seconds').dispatchEvent(new Event('input',{bubbles:true}))`);
    await choose(b.id);assert.equal(projected(a.id).xpAutoPauseSeconds,90);assert.equal(await js(xp,`document.getElementById('xp-idle-seconds').value`),'270');
    const commonVolume=config.load().volumeCalculators;
    assert.equal((await js(xp,`electronAPI.applySettingsConfirmed({xpAutoPauseSeconds:1,volumeCalculators:99},${JSON.stringify(a.id)})`)).success,false);
    assert.equal(config.load().volumeCalculators,commonVolume);assert.equal(projected(b.id).xpAutoPauseSeconds,270);

    await choose(a.id);await js(boss,`toggleBossEntry('혼란한 대지',true)`);await ready(boss,a.id);
    assert.equal(projected(a.id).bossEntryCountdownBosses.includes('혼란한 대지'),true);
    await choose(b.id);assert.equal(projected(b.id).bossEntryCountdownBosses.includes('혼란한 대지'),false);
    assert.equal(await js(boss,`document.getElementById('boss-volume-input').value`),'0','0% volume must remain common and silent');
    await choose(a.id);

    // 새 알림 저장 실패 후 폼/ID 유지, 저장 중 다음 입력을 지우지 않고 같은 ID로 재시도.
    await js(alerts,`openAddForm()`);assert.equal((await service.select(b.id,replay)).success,false);await allReady(a.id);
    assert.match(await js(alerts,`document.querySelector('.profile-settings-context').textContent`),/메시지를 입력/);
    await js(alerts,`document.getElementById('form-message').value='A 알림 원본'`);
    store.database.exec("CREATE TRIGGER fail_alert_save BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture alert save failure');END");
    assert.equal(await js(alerts,'saveNewAlert()'),false);assert.equal(await js(alerts,`document.getElementById('add-form').classList.contains('hidden')`),false);
    const draftId=await js(alerts,`document.getElementById('form-id').value`);assert.ok(draftId);assert.equal(projected(a.id).customAlerts.length,0);
    store.database.exec('DROP TRIGGER fail_alert_save');before=new Promise(resolve=>{releaseBefore=resolve;});const e=entered;
    await js(alerts,'window.pageSaving=saveNewAlert();void 0');for (let n=0;n<100 && entered===e;n++) await pause();assert.equal(entered,e+1);
    await js(alerts,`document.getElementById('form-message').value='저장 중 다음 입력'`);
    assert.equal((await service.select(b.id,replay)).success,false,'pending save blocks profile transition');
    before=null;releaseBefore();assert.equal(await js(alerts,'window.pageSaving'),true);await ready(alerts,a.id);
    assert.equal(await js(alerts,`document.getElementById('add-form').classList.contains('hidden')`),false);
    assert.equal(await js(alerts,`document.getElementById('form-message').value`),'저장 중 다음 입력');
    assert.equal(await js(alerts,'saveNewAlert()'),true);await ready(alerts,a.id);
    assert.equal(projected(a.id).customAlerts.length,1);assert.equal(projected(a.id).customAlerts[0].id,draftId);assert.equal(projected(a.id).customAlerts[0].message,'저장 중 다음 입력');
    await js(alerts,`openAddForm();document.getElementById('form-message').value='실패 후 취소할 알림'`);
    store.database.exec("CREATE TRIGGER fail_cancel_alert BEFORE INSERT ON profile_change_log BEGIN SELECT RAISE(ABORT,'fixture cancel alert');END");
    assert.equal(await js(alerts,'saveNewAlert()'),false);await js(alerts,'cancelAddForm()');
    assert.equal(await js(alerts,`document.getElementById('alert-list').textContent.includes('실패 후 취소할 알림')`),false);
    assert.equal((await state(alerts)).dirty,false);store.database.exec('DROP TRIGGER fail_cancel_alert');
    await choose(b.id);assert.equal(projected(b.id).customAlerts.length,0);assert.match(await js(alerts,`document.getElementById('alert-list').textContent`),/등록된 커스텀 알림이 없습니다/);

    // 확정된 A 저장의 늦은 성공 응답도 B 초안 기준을 바꾸지 않는다.
    await choose(a.id);after=new Promise(resolve=>{releaseAfter=resolve;});const c=committed;
    await js(xp,`document.getElementById('xp-idle-seconds').value='120';window.delayedSave=profileSettingsPage.write({xpAutoPauseSeconds:120});void 0`);
    for (let n=0;n<100 && committed===c;n++) await pause();assert.equal(committed,c+1);
    xp.webContents.send('config-data',{...projected(b.id),activePlayProfileId:b.id});await until(xp,`settingsProfileTransition.status().profileId===${JSON.stringify(b.id)} && settingsProfileTransition.status().ready`);
    await js(xp,`document.getElementById('xp-idle-seconds').value='180'`);
    after=null;releaseAfter();assert.equal(await js(xp,'window.delayedSave'),true);await pause(60);
    assert.equal((await state(xp)).dirty,true);assert.equal(await js(xp,`document.getElementById('xp-idle-seconds').value`),'180');
    response=1;await choose(b.id);await choose(a.id);await choose(b.id);response=0;

    // 이전 프로필의 느린 알림음 목록이 새 프로필의 화면을 되돌리지 않는다.
    await js(buff,`window.soundResolvers=[];window.originalSounds=window.loadSoundList;window.loadSoundList=()=>new Promise(resolve=>soundResolvers.push(resolve));void 0`);
    buff.webContents.send('config-data',{...projected(a.id),activePlayProfileId:a.id,buffTimerSound:'orb.mp3'});await until(buff,'soundResolvers.length===1');
    buff.webContents.send('config-data',{...projected(b.id),activePlayProfileId:b.id,buffTimerSound:'level_up.mp3',buffTimerVolume:0});await until(buff,'soundResolvers.length===2');
    await js(buff,`soundResolvers[1]([{file:'orb.mp3',name:'A'},{file:'level_up.mp3',name:'B'}])`);
    await ready(buff,b.id);await js(buff,`soundResolvers[0]([{file:'orb.mp3',name:'A'}]);window.loadSoundList=window.originalSounds;void 0`);await pause(80);
    assert.equal(await js(buff,`document.getElementById('sound-select').value`),'level_up.mp3');assert.equal(await js(buff,`document.getElementById('volume-slider').value`),'0');
    // Restore actual common sound/volume for clean screen verification.
    buff.webContents.send('config-data',config.load());await ready(buff,b.id);
    assert.equal(service.update(b.id,'표시 이름 <변경>',16).success,true);await allReady(b.id);
    for (let index=0;index<windows.length;index++) {
      const win=windows[index];win.setSize(800,600);await pause(130);
      fs.writeFileSync(path.join(output,files[index].replace('.html','-800.png')),(await win.webContents.capturePage()).toPNG());
      assert.equal(await js(win,`(()=>{const r=document.querySelector('.profile-settings-context').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && getComputedStyle(document.querySelector('.profile-settings-context')).fontSize==='14px' && document.documentElement.scrollWidth<=innerWidth;})()`),true);
      assert.match(await js(win,`document.querySelector('.profile-settings-context').textContent`),/표시 이름 <변경>/);
    }
    await js(hunting,`document.getElementById('add-doping-btn').click();document.getElementById('editor-name').value='도핑 입력 확인'`);
    await pause(100);fs.writeFileSync(path.join(output,'hunting-editor-800.png'),(await hunting.webContents.capturePage()).toPNG());
    assert.equal(await js(hunting,`(()=>{const r=document.querySelector('#editor-form button[type="submit"]').getBoundingClientRect();return r.top>0 && r.bottom<innerHeight;})()`),true);
    await js(hunting,`document.getElementById('cancel-editor-btn').click()`);
    await js(alerts,`openAddForm();document.getElementById('form-message').value='알림 입력 확인'`);
    await pause(100);fs.writeFileSync(path.join(output,'custom-alert-editor-800.png'),(await alerts.webContents.capturePage()).toPNG());
    assert.equal(await js(alerts,`(()=>{const r=document.getElementById('save-btn').getBoundingClientRect();return r.top>0 && r.bottom<innerHeight;})()`),true,'minimum-size custom alert editor must keep Save visible');
    console.log('PASS profile settings pages: five real pages, per-profile restore, Save/Discard/Cancel, failed/retried forms, partial ACK, next draft, stale owner/ACK/sound and minimum-size UI');
  } finally {
    before=null;after=null;releaseBefore();releaseAfter();dialog.showMessageBox=originalMessage;
    for (const win of windows) if (!win.isDestroyed()) win.destroy();controller.dispose();prepared.stopClock();config.flushPending();
  }
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
