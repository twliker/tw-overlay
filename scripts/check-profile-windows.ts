/** 실제 main/tracker/polling/제품 창을 임시 데이터와 WinForms 게임 대역으로 검사한다.
 * 일반 권한 개발 검사이며 실게임·관리자 Z-order·설치 완료 증거로 사용하지 않는다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {app,BrowserWindow} from 'electron';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const scenario=argument('--scenario');
const layout=argument('--layout') || 'sidebar',mode=argument('--mode') || 'windowed';
const caseName=[scenario,layout,mode].join('-');
const appRoot=path.resolve(argument('--app-root') || path.join(root,'dist'));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-windows-'));
const data=path.join(fixture,'appData','twOverlay');
fs.mkdirSync(data,{recursive:true});
app.setPath('appData',path.dirname(data));app.setPath('userData',data);
const output=path.join(root,'output','profile-windows',...(appRoot.includes('.asar') ? ['packaged'] : []));fs.mkdirSync(output,{recursive:true});
const built=(name:string)=>require(path.join(appRoot,name+'.js'));
const pause=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean | Promise<boolean>,label:string,timeout=20000):Promise<void> {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await pause();}
  throw new Error(`${label}: timed out`);
}
const gameExecutable=path.join(root,'output','profile-game-fixture','InphaseNXD-zorder-fixture.exe');

async function driver():Promise<void> {
  const build=path.dirname(gameExecutable);
  fs.mkdirSync(build,{recursive:true});
  execFileSync('dotnet',['build',path.join(root,'scripts/fixtures/FakeTalesWeaver/FakeTalesWeaver.csproj'),'--configuration','Release','--nologo','--output',build,'-p:FixtureRequireAdministrator=false'],{windowsHide:true,stdio:'pipe',timeout:60000});
  const results=[];
  for(const name of ['app-first','game-first','minimized-first']) for(const targetLayout of ['sidebar','dock']) for(const targetMode of ['windowed','borderless']) {
    const targetName=[name,targetLayout,targetMode].join('-');
    const result=await new Promise<{code:number | null;log:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,[__filename,'--scenario',name,'--layout',targetLayout,'--mode',targetMode,'--app-root',appRoot],{windowsHide:false,stdio:'pipe'});
      let log='';child.stdout.on('data',chunk=>log+=String(chunk));child.stderr.on('data',chunk=>log+=String(chunk));
      const timer=setTimeout(()=>{child.kill();reject(new Error(`${name}: process timed out\n${log.slice(-10000)}`));},90000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);resolve({code,log});});
    });
    assert.equal(result.code,0,result.log.slice(-12000));
    results.push(JSON.parse(fs.readFileSync(path.join(output,targetName+'.json'),'utf8')));
    console.log(`PASS profile Windows ${targetName}`);
  }
  assert.equal(results.length,12);
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({passed:true,developmentFixture:true,appRoot,caseCount:results.length,results},null,2));
}

let game:ChildProcess | undefined,sequence=0;
const gameStatus=path.join(fixture,'game-status.json'),gameCommand=path.join(fixture,'game-command.json');
function writeGameCommand(value:unknown):void {
  // WinForms가 명령을 읽는 짧은 구간에는 Windows 공유 잠금이 걸릴 수 있다.
  // 완성된 파일을 교체하고 그 잠금만 제한적으로 재시도한다. 제품 오류는 재시도하지 않는다.
  const temporary=gameCommand+'.tmp',signal=new Int32Array(new SharedArrayBuffer(4)),end=Date.now()+2000;
  fs.writeFileSync(temporary,JSON.stringify(value));
  for (;;) {
    try {fs.renameSync(temporary,gameCommand);return;}
    catch(error) {
      if (!['EBUSY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code || '') || Date.now()>=end) throw error;
      Atomics.wait(signal,0,0,10);
    }
  }
}
function launchGame():void {
  sequence=0;writeGameCommand({sequence:0,action:'startup'});
  game=spawn(gameExecutable,['--mode',mode,'--status-file',gameStatus,'--command-file',gameCommand,'--bounds','120,120,1000,700','--lifetime-ms','120000'],{stdio:'ignore'});
  game.on('error',error=>{console.error(error);app.exit(1);});
}
async function startGame(minimized=false):Promise<void> {
  launchGame();
  await until(()=>fs.existsSync(gameStatus) && JSON.parse(fs.readFileSync(gameStatus,'utf8')).processId===game!.pid,'native game window');
  if(minimized)await commandGame('minimize');
}
function startGameBeforeBootstrap(minimized:boolean):void {
  launchGame();
  // main의 프로토콜 등록 전에 준비해야 하므로 ready 이벤트를 진행시키지 않고 외부 창만 기다린다.
  const wait=(check:()=>boolean)=>{
    const end=Date.now()+8000,signal=new Int32Array(new SharedArrayBuffer(4));
    while(!check()) {if(Date.now()>end)throw new Error('pre-bootstrap native game timed out');Atomics.wait(signal,0,0,25);}
  };
  wait(()=>fs.existsSync(gameStatus) && JSON.parse(fs.readFileSync(gameStatus,'utf8')).processId===game!.pid);
  if(minimized) {
    writeGameCommand({sequence:++sequence,action:'minimize'});
    wait(()=>JSON.parse(fs.readFileSync(gameStatus,'utf8')).windowState==='minimized');
  }
}
async function commandGame(action:string):Promise<void> {
  const current=++sequence;
  writeGameCommand({sequence:current,action});
  if(action==='close') {await until(()=>game?.exitCode!==null,'game close');return;}
  await until(()=>JSON.parse(fs.readFileSync(gameStatus,'utf8')).commandSequence===current,`native game ${action}`);
}
const page=(file:string)=>BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && win.webContents.getURL().split('?')[0].endsWith('/'+file));
async function openFromSystemMenu():Promise<void> {
  if(layout==='dock' && !page('dock.html')?.isVisible())built('modules/windowManager').toggleDockWindow();
  const file=layout==='dock' ? 'dock.html' : 'index.html',id=layout==='dock' ? 'dock-profiles-btn' : 'profiles-btn';
  await until(async()=>!!page(file) && await page(file)!.webContents.executeJavaScript(`Boolean(document.getElementById(${JSON.stringify(id)}))`),'profile system menu button');
  await page(file)!.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`);
  await until(()=>!!page('profiles.html')?.isVisible(),'system menu opens profile window');
}

async function probe():Promise<void> {
  assert.ok(['app-first','game-first','minimized-first'].includes(scenario!));
  assert.ok(['sidebar','dock'].includes(layout));assert.ok(['windowed','borderless'].includes(mode));
  const logs=path.join(data,'logs');fs.mkdirSync(logs);
  const date=new Date(),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('_');
  const logfile=path.join(logs,`TWChatLog_${day}.html`);
  const line=(message:string,second:number)=>`<font size="2" color="white"> [10시 00분 ${String(second).padStart(2,'0')}초] </font><font size="2" color="#ff64ff">${message}</font></br>\r\n`;
  fs.writeFileSync(logfile,'\ufeff'+line('검사 시작',0));
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({userServer:7,analyticsEnabled:false,autoUpdateEnabled:false,
    hasSeenWelcomeGuide:true,setupCompleted:true,overlayVisible:false,url:'about:blank',homeUrl:'about:blank',chatLogPath:logs,
    sidebarPosition:layout==='dock' ? 'dock' : 'right',gameExitReminderEnabled:false,showXpWidget:false,showBuffHud:false,showTodaySummaryHud:false,contentsCheckerEnabled:false,
    chatOverlayEnabled:false,chatOverlaySubEnabled:false,chatOverlaySub2Enabled:false,
    characterPresets:[{id:'A',name:'윈도우 A'},{id:'B',name:'윈도우 B'}],selectedCharacterId:'A',
    contentsCheckerItems:[{id:'native-custom',name:'기존 숙제',isCustom:true,category:'주간',isVisible:true,maxCount:3,
      resetRule:{type:'weekly',dayOfWeek:0,hour:6},completedState:{B:{currentCount:2,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()}}}]}));
  // 게임 탐지와 로컬 기록은 실제 경로를 유지하며 시스템 자동 실행·원격 서비스만 분리한다.
  built('modules/autoStart').setupAutoStart=()=>{};
  built('modules/updater').setupUpdater=(ready:()=>void)=>ready();
  built('modules/galleryMonitor').start=()=>{};built('modules/tradeMonitor').start=()=>{};
  built('modules/etaCacheManager').etaCacheManager.init=()=>{};
  built('modules/profileClock').ProfileClock.prototype.refresh=async()=>{};
  const errors:string[]=[];
  app.on('browser-window-created',(_event,win)=>{
    win.webContents.on('preload-error',(_event,_file,error)=>errors.push(String(error)));
    win.webContents.on('render-process-gone',(_event,details)=>errors.push(`renderer ${details.reason}`));
  });
  if(scenario!=='app-first')startGameBeforeBootstrap(scenario==='minimized-first');
  const done=(async()=>{
    await app.whenReady();
    await until(()=>!!page('index.html') && !!built('modules/profileRuntime').getProfileRuntime(),'main startup');
    if(scenario==='app-first') {
      await until(()=>built('modules/pollingLoop').getGameStatus()==='not-running','app before game');
      assert.equal(page('profiles.html'),undefined);
      await startGame();
    }
    await until(()=>!!page('profiles.html')?.isVisible(),'initial profile selection window');
    let profiles=page('profiles.html')!;
    await until(async()=>await profiles.webContents.executeJavaScript('document.querySelectorAll(".profile-row").length===2'),'profile rows');
    const runtime=built('modules/profileRuntime').getProfileRuntime(),service=runtime.service,store=service.store;
    const a=store.list().find((item:any)=>item.name==='윈도우 A'),b=store.list().find((item:any)=>item.name==='윈도우 B');
    assert.ok(a && b);assert.equal(store.list().length,2);assert.equal(service.status().selectionRequired,true);
    if(scenario==='minimized-first')assert.equal(built('modules/pollingLoop').getGameStatus(),'minimized');
    if(scenario!=='minimized-first') {
      await commandGame('minimize');await until(()=>built('modules/pollingLoop').getGameStatus()==='minimized','selection during minimize');
    }
    profiles.focus();await pause(100);
    assert.equal(built('modules/tracker').canAutomaticallyRestoreGameFocus(),false,'프로필 창에 포커스가 있어도 최소화한 게임의 자동 복구를 허용하지 않는다.');
    assert.equal(profiles.isVisible(),true,'선택창은 게임 최소화 중에도 유지한다.');
    if(scenario!=='minimized-first') {
      await commandGame('restore');await until(()=>built('modules/pollingLoop').getGameStatus()==='running','selection after restore');
    }
    await profiles.webContents.executeJavaScript("document.getElementById('close-profiles').click()");
    await until(()=>!page('profiles.html'),'unselected window closes');
    assert.equal(service.status().selectionRequired,true);
    fs.appendFileSync(logfile,line('입장료 41 Seed를 지불하였습니다.',1));
    await until(()=>store.pending().length===1,'unselected log waiting');
    const sum=(id:string)=>store.database.prepare('SELECT COALESCE(SUM(amount),0) n FROM activity_logs WHERE profile_id=?').get(id).n;
    assert.equal(sum(a.id),0);
    await openFromSystemMenu();profiles=page('profiles.html')!;
    await until(async()=>await profiles.webContents.executeJavaScript('document.querySelectorAll(".profile-row").length===2'),'reopened waiting rows');
    const use=async(id:string)=>{
      const win=page('profiles.html')!;
      await win.webContents.executeJavaScript(`document.querySelector('[data-focus-key="use:${id}"]').click()`);
      await until(()=>!service.status().selectionRequired && service.status().activeProfileId===id,'selected profile');
      await until(()=>!page('profiles.html'),'selection closes');
    };
    await use(a.id);assert.equal(sum(a.id),-41);
    const session=service.status().sessionId;
    if(scenario==='minimized-first')await commandGame('restore');
    await until(()=>built('modules/pollingLoop').getGameStatus()==='running','game restored');
    await commandGame('minimize');await until(()=>built('modules/pollingLoop').getGameStatus()==='minimized','game minimized');
    assert.equal(service.status().sessionId,session);assert.equal(service.status().selectionRequired,false);
    await commandGame('restore');await until(()=>built('modules/pollingLoop').getGameStatus()==='running','game resumed');
    assert.equal(service.status().sessionId,session);assert.equal(page('profiles.html'),undefined);
    // 실제 사이드바/독의 시스템 메뉴 DOM과 preload 진입점으로 다시 연다.
    await openFromSystemMenu();profiles=page('profiles.html')!;
    await until(async()=>await profiles.webContents.executeJavaScript('document.querySelectorAll(".profile-row").length===2'),'reopened rows');
    await profiles.webContents.executeJavaScript(`document.querySelector('[data-focus-key="edit:${b.id}"]').click()`);
    await until(async()=>await profiles.webContents.executeJavaScript(`document.getElementById('profile-name').value==='윈도우 B'`),'edit B');
    await profiles.webContents.executeJavaScript("document.getElementById('profile-server').value='16';document.getElementById('profile-server').dispatchEvent(new Event('change'));document.getElementById('save-profile').click()");
    await until(()=>store.list().find((item:any)=>item.id===b.id).userServer===16 && !service.status().busy,'save server');
    await until(async()=>await profiles.webContents.executeJavaScript("!document.getElementById('save-profile').disabled"),'save server ready');
    await use(b.id);assert.equal(built('modules/config').load().userServer,16);
    assert.equal(store.homework(b.id).find((item:any)=>item.id==='native-custom').completedState[b.id].currentCount,2);
    fs.appendFileSync(logfile,line('입장료 17 Seed를 지불하였습니다.',2));await until(()=>sum(b.id)===-17,'B local recording');
    assert.equal(sum(a.id),-41);
    await commandGame('close');await until(()=>built('modules/pollingLoop').getGameStatus()==='not-running','game ended');
    assert.equal(service.status().selectionRequired,true);
    await startGame();await until(()=>!!page('profiles.html')?.isVisible(),'new game selection');
    assert.notEqual(service.status().sessionId,session);
    assert.equal(BrowserWindow.getAllWindows().filter(win=>win.webContents.getURL().endsWith('/profiles.html')).length,1);
    profiles=page('profiles.html')!;await pause(200);
    fs.writeFileSync(path.join(output,caseName+'.png'),(await profiles.webContents.capturePage()).toPNG());
    const debug=fs.readFileSync(path.join(data,'debug.log'),'utf8');
    assert.doesNotMatch(debug,/\[MAIN\] (?:Uncaught Exception|Unhandled Rejection)/);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,caseName+'.json'),JSON.stringify({passed:true,scenario,layout,mode,appRoot,developmentFixture:true,
      startupSelection:true,minimizedSessionPreserved:true,systemEntry:true,closeBeforeSelectionPreserved:true,serverSwitch:true,sourceOwnerPreserved:true,newGameSelection:true,errors},null,2));
    console.log(`PASS ${caseName}: actual main/tracker/polling/profile UI/IPC/logs`);
    await commandGame('close');app.quit();
  })();
  require(path.join(appRoot,'main.js'));
  await done;
}

(scenario ? probe() : driver().then(()=>app.exit(0))).catch(error=>{console.error(error);game?.kill();app.exit(1);});
