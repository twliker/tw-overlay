/** 사람이 실제 창을 조작하는 UX 검수용 앱. 자동 통과 판정을 내리지 않는다.
 * userData/로그/DB는 전부 새 임시 자료이며 OS 게임 대역·실제 게임 탐지·원격 동기화·
 * 자동 실행/전역 단축키는 사용하지 않는다. 제품 main/preload/IPC/창 생성은 그대로 사용한다. */
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow,session} from 'electron';
import {captureProductScreens} from './manual-ui-review-capture';

const root=path.resolve(__dirname,'..'),output=path.join(root,'output/manual-ui-review');
const captureOnly=process.argv.includes('--capture');
const desktopTools=process.argv.includes('--desktop-tools');
if(captureOnly) {
  app.disableHardwareAcceleration();
  void app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true})));
}
app.getAppPath=()=>root;
app.getVersion=()=>JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
fs.mkdirSync(output,{recursive:true});
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-manual-ui-review-'));
const data=path.join(fixture,'appData/twOverlay'),logs=path.join(fixture,'chat');
fs.mkdirSync(data,{recursive:true});fs.mkdirSync(logs);
app.setPath('appData',path.dirname(data));app.setPath('userData',data);
const built=(name:string)=>require(path.join(root,'dist',name+'.js'));
const items=JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/contents.json'),'utf8'));
for(const [index,item] of items.entries())item.completedState={A:{currentCount:index<3 ? item.maxCount || 1 : 0,isCompleted:index<3,lastCompletedAt:Date.now()}};
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({analyticsEnabled:false,autoUpdateEnabled:false,
  hasSeenWelcomeGuide:true,setupCompleted:true,userServer:7,url:'about:blank',homeUrl:'about:blank',chatLogPath:logs,
  sidebarPosition:'dock',overlayVisible:false,followGameWindow:false,gameExitReminderEnabled:true,
  gameExitReminderMessage:'프로필별 남은 숙제를 확인하세요.',showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,
  contentsCheckerEnabled:false,chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,
  characterPresets:[{id:'A',name:'검수용 본 프로필'},{id:'B',name:'검수용 보조 프로필'}],selectedCharacterId:'A',contentsCheckerItems:items,
  ...(desktopTools ? {lastNoticeVersion:app.getVersion()} : {})}));
built('modules/autoStart').setupAutoStart=()=>{};
built('modules/updater').setupUpdater=(ready:()=>void)=>ready();
built('modules/galleryMonitor').start=()=>{};built('modules/tradeMonitor').start=()=>{};
built('modules/etaCacheManager').etaCacheManager.init=()=>{};
if(captureOnly)built('modules/etaRanking').fetchEtaRanking=async()=>({lastUpdate:'',entries:[]});
built('modules/profileClock').ProfileClock.prototype.refresh=async()=>{};
const tracker=built('modules/tracker');
tracker.start=()=>{};tracker.queryGameRect=async()=>({notRunning:true});tracker.getGameHwnd=()=>undefined;
tracker.isGameRunning=()=>false;tracker.isGameOrAppForeground=()=>false;
tracker.canAutomaticallyRestoreGameFocus=()=>false;tracker.focusGameForAppActivation=()=>false;
tracker.restoreGameAfterOwnedWindowClose=()=>false;
built('modules/pollingLoop').start=()=>{};
const shortcuts=built('modules/shortcutManager');shortcuts.registerAll=()=>{};shortcuts.reloadShortcuts=()=>{};
const errors:Array<{at:string;kind:string;page:string;message:string}>=[];
const record=(kind:string,page:string,message:string)=>{errors.push({at:new Date().toISOString(),kind,page,message});fs.writeFileSync(path.join(output,'errors.json'),JSON.stringify(errors,null,2));};
app.on('browser-window-created',(_event,window)=>{
  // The renderer review never raises/focuses OS windows or sends input to the desktop.
  if(captureOnly) {window.show=()=>{};window.showInactive=()=>{};window.focus=()=>{};window.webContents.setBackgroundThrottling(false);}
  window.webContents.on('preload-error',(_event,file,error)=>record('preload',file,String(error)));
  window.webContents.on('render-process-gone',(_event,details)=>record('renderer',window.webContents.getURL(),details.reason));
  window.webContents.on('console-message',event=>{if(event.level==='error')record('console',window.webContents.getURL(),`${event.message} (${event.sourceId}:${event.lineNumber})`);});
});
const start=setInterval(()=>{
  const runtime=built('modules/profileRuntime').getProfileRuntime(),wm=built('modules/windowManager');
  if(!runtime || !wm.getMainWindow())return;
  clearInterval(start);
  runtime.onGameState('running');
  runtime.service.store.enqueue('manual-old-session',{kind:'parsed-profile-event',version:1,event:'ABANDONED_FEE',data:{date:'2026-11-04',timestamp:'19:28:57',amount:52800000,message:'입장료 52,800,000 Seed를 지불하였습니다.'}},Date.now()-86400000,'manual-old-fee');
  if(desktopTools && !captureOnly) {
    void runtime.service.select('profile-default',runtime.replay).then(()=>{
      wm.toggleSettingsWindow();wm.toggleDiaryWindow();wm.toggleContentsCheckerWindow();
    }).catch((error:unknown)=>{console.error(error);app.exit(1);});
  } else {
    wm.openProfilesWindow('user-open');
    wm.toggleDockWindow();
  }
  if(captureOnly) {
    void captureProductScreens({wm,runtime,output,errors}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
    return;
  }
  setInterval(()=>fs.writeFileSync(path.join(output,'state.json'),JSON.stringify({pid:process.pid,data,fixture,electron:process.versions.electron,
    automaticPass:false,profileStatus:runtime.service.status(),windows:BrowserWindow.getAllWindows().map(win=>({id:win.id,title:win.getTitle(),url:win.webContents.getURL(),visible:win.isVisible(),bounds:win.getBounds()}))},null,2)),1000).unref();
},100);
require(path.join(root,'dist/main.js'));
