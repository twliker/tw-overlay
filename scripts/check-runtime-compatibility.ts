/** Electron 주버전 이전 경계: 실제 sandbox preload/IPC와 SQLite·Win32 native 연동.
 * 소유한 임시 userData와 숨긴 검사 창만 사용하며 설치/사용자 게임/관리자 Z-order는 다루지 않는다.
 * --app-root로 unpacked app.asar의 실제 모듈/프리로드도 같은 조건에서 검사한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {createRequire} from 'node:module';
import {app,BrowserWindow,WebContentsView,ipcMain,safeStorage} from 'electron';

const root=path.resolve(__dirname,'..'),index=process.argv.indexOf('--app-root');
const appRoot=path.resolve(index<0 ? path.join(root,'dist') : process.argv[index+1]);
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-runtime-compatibility-'));
app.setPath('appData',fixture);app.setPath('userData',path.join(fixture,'userData'));
app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(appRoot,name+'.js'));
const applicationRequire=createRequire(path.join(appRoot,'main.js'));
const errors:string[]=[];
app.on('web-contents-created',(_event,contents)=>{
  contents.on('preload-error',(_event,file,error)=>errors.push(`${file}: ${error}`));
  contents.on('render-process-gone',(_event,details)=>errors.push(`renderer gone: ${details.reason}`));
});
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(check:()=>boolean | Promise<boolean>,label:string):Promise<void> {
  const end=Date.now()+5000;while(!await check()){assert.ok(Date.now()<end,label);await pause();}
}
async function run():Promise<void> {
  await app.whenReady();
  assert.equal(process.platform,'win32');
  const Database=applicationRequire('better-sqlite3'),file=path.join(fixture,'native.db');
  let db=new Database(file);db.pragma('journal_mode=WAL');db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, amount INTEGER)');
  db.prepare('INSERT INTO records VALUES (?, ?)').run('entry',-52800000);
  assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE records SET amount=1').run();throw new Error('rollback');})(),/rollback/);
  db.close();db=new Database(file);assert.equal(db.prepare('SELECT amount FROM records').get().amount,-52800000);
  assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);db.close();

  const defaults=built('modules/constants').DEFAULT_CONFIG;
  ipcMain.on('get-default-config-sync',event=>{event.returnValue=defaults;});
  const create=(preload:string)=>new BrowserWindow({show:false,webPreferences:{preload:path.join(appRoot,preload+'.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const main=create('preload');
  await main.loadURL('data:text/html,<title>runtime fixture</title>');
  assert.equal(await main.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await main.webContents.executeJavaScript('typeof window.electronAPI.getPlayProfiles'),'function');
  await main.webContents.executeJavaScript('window.fixtureCalls=[0,0];window.electronAPI.onConfigData(()=>{window.fixtureCalls[0]++});window.electronAPI.onConfigData(config=>{window.fixtureCalls[1]++;window.fixtureValue=config.userServer})');
  main.webContents.send('config-data',{...defaults,userServer:7});
  await until(async()=>await main.webContents.executeJavaScript('window.fixtureValue')===7,'main preload config IPC');
  assert.deepEqual(await main.webContents.executeJavaScript('window.fixtureCalls'),[0,1],'다시 등록한 수신자만 한 번 호출한다.');
  const hwnd=main.getNativeWindowHandle().readBigUInt64LE(),win32=built('modules/win32'),owner=Buffer.alloc(4);
  assert.ok(win32.GetWindowThreadProcessId(hwnd,owner)>0);
  assert.equal(owner.readUInt32LE(0),process.pid,'Koffi가 소유한 실제 창의 PID를 읽는다.');

  const splash=create('splashPreload');await splash.loadURL('data:text/html,<title>splash fixture</title>');
  await splash.webContents.executeJavaScript('window.splashAPI.onUpdateStatus(data=>{window.fixtureStatus=data.status})');
  splash.webContents.send('update-status',{status:'checking'});
  await until(async()=>await splash.webContents.executeJavaScript('window.fixtureStatus')==='checking','splash preload update IPC');

  const view=new WebContentsView({webPreferences:{preload:path.join(appRoot,'overlay-view-preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  main.contentView.addChildView(view);view.setBounds({x:0,y:0,width:100,height:100});
  let enters=0,leaves=0,escapes=0;
  for(const channel of ['overlay-wcv-mouse-enter','overlay-wcv-mouse-leave','embedded-view-escape'])ipcMain.on(channel,event=>{
    if(event.sender!==view.webContents)return;
    if(channel==='overlay-wcv-mouse-enter')enters++;else if(channel==='overlay-wcv-mouse-leave')leaves++;else escapes++;
  });
  await view.webContents.loadURL('data:text/html,<title>view fixture</title>');
  await view.webContents.executeJavaScript(`document.dispatchEvent(new Event('mouseenter'));document.dispatchEvent(new Event('mouseleave'));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}))`);
  await until(()=>enters===1 && leaves===1 && escapes===1,'WebContentsView preload IPC');
  await view.webContents.executeJavaScript(`document.addEventListener('keydown',e=>e.preventDefault(),{once:true});document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}))`);
  await pause();assert.equal(escapes,1,'콘텐츠에서 처리한 Escape는 창을 닫지 않는다.');
  assert.ok(safeStorage.isEncryptionAvailable(),'Windows 토큰 암호화 사용 가능');
  const token='owned fixture token';assert.equal(safeStorage.decryptString(safeStorage.encryptString(token)),token);
  assert.deepEqual(errors,[]);
  view.webContents.close();splash.destroy();main.destroy();
  console.log(`PASS runtime compatibility: Electron ${process.versions.electron}, Node ${process.versions.node}, ABI ${process.versions.modules}; SQLite WAL/rollback/reopen, Koffi HWND/PID, 3 sandbox preloads/IPC, encrypted token roundtrip (${appRoot})`);
}
run().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
