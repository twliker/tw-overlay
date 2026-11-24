import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app, BrowserWindow, ipcMain} from 'electron';
import {pathToFileURL} from 'node:url';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-game-path-'));
app.setPath('userData', path.join(fixture, 'app'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function main(): Promise<void> {
  await app.whenReady();
  const finder = require(path.join(root, 'dist/modules/chatLogPathFinder')) as {
    findRunningGamePath(read: () => string | null): {found:boolean;installPath?:string;chatLogPath?:string;message:string};
  };
  const tracker = require(path.join(root, 'dist/modules/tracker')) as { queryProcessExecutablePath(pid:number):string | null };
  const installation = path.join(fixture, '한글 게임 설치 폴더');
  const executable = path.join(installation, 'InphaseNXD.exe');
  fs.mkdirSync(installation);
  const missingLog = finder.findRunningGamePath(() => executable);
  assert.equal(missingLog.installPath, installation);
  assert.equal(missingLog.chatLogPath, undefined);
  assert.match(missingLog.message, /채팅 로그 저장/);
  assert.equal(fs.existsSync(path.join(installation, 'ChatLog')), false, '조회는 로그 폴더를 생성하지 않는다');
  fs.writeFileSync(path.join(installation, 'ChatLog'), 'not a directory');
  assert.equal(finder.findRunningGamePath(() => executable).chatLogPath, undefined);
  fs.unlinkSync(path.join(installation, 'ChatLog'));
  fs.mkdirSync(path.join(installation, 'ChatLog'));
  assert.equal(finder.findRunningGamePath(() => executable).chatLogPath, path.join(installation, 'ChatLog'));
  assert.equal(finder.findRunningGamePath(() => executable.toUpperCase()).found, true);
  assert.equal(finder.findRunningGamePath(() => null).found, false);
  assert.equal(finder.findRunningGamePath(() => { throw new Error('access denied'); }).found, false);
  assert.equal(finder.findRunningGamePath(() => path.join(installation, 'FakeInphaseNXD.exe')).found, false);
  assert.equal(finder.findRunningGamePath(() => 'InphaseNXD.exe').found, false);
  assert.equal(path.normalize(tracker.queryProcessExecutablePath(process.pid)!).toLowerCase(), process.execPath.toLowerCase(),
    '실제 Windows API로 이 검사 프로세스의 실행 경로를 읽는다');
  assert.equal(tracker.queryProcessExecutablePath(0), null, '접근할 수 없는 프로세스는 실패 결과 반환');
  // 채팅 로그 경로 자동 탐색(isGameRunning)이 게임 창 캐시를 먼저 채워도, 전경이 같은 게임 창이면
  // 다음 폴링이 포커스를 다시 알린다(이전 통지는 게임 창이 없을 때 "게임 아님"으로 계산됨).
  const {shouldNotifyForegroundChange: shouldNotify} = require(path.join(root, 'dist/modules/tracker')) as {
    shouldNotifyForegroundChange(last:{foregroundHwnd:bigint;gameIdentity:string|null}|null,next:{foregroundHwnd:bigint;gameIdentity:string|null},force?:boolean):boolean;
  };
  const beforeGame = {foregroundHwnd: 0x1234n, gameIdentity: null};
  assert.equal(shouldNotify(null, beforeGame), true, '첫 통지');
  assert.equal(shouldNotify(beforeGame, {...beforeGame}), false, '같은 전경·같은 게임 창은 중복 통지하지 않는다');
  assert.equal(shouldNotify(beforeGame, {foregroundHwnd: 0x1234n, gameIdentity: '4660:77'}), true,
    '다른 경로가 게임 창을 캐시해 게임 판정이 바뀌면 전경이 같아도 다시 알린다');
  assert.equal(shouldNotify({foregroundHwnd: 0x1234n, gameIdentity: '4660:77'}, {foregroundHwnd: 0x1234n, gameIdentity: '4660:78'}), true,
    '게임이 다시 실행되어 PID가 바뀌면 다시 알린다');
  assert.equal(shouldNotify({foregroundHwnd: 0x1234n, gameIdentity: '4660:77'}, {foregroundHwnd: 0x1234n, gameIdentity: null}), true,
    '게임 창이 사라지면 다시 알린다');
  assert.equal(shouldNotify({foregroundHwnd: 1n, gameIdentity: null}, {foregroundHwnd: 1n, gameIdentity: null}, true), true, '강제 통지');
  const config = require(path.join(root, 'dist/modules/config'));
  const configured = path.join(fixture, '사용자가 선택한 폴더');
  config.saveImmediate({ chatLogPath: configured });
  finder.findRunningGamePath(() => executable);
  assert.equal(config.load().chatLogPath, configured, '찾기만으로 저장된 경로를 덮어쓰지 않는다');
  const manager = require(path.join(root, 'dist/modules/chatLogManager'));
  assert.equal(manager.shouldAutoDiscoverChatLogPath(configured), false);
  assert.equal(manager.shouldAutoDiscoverChatLogPath(''), true);

  let handler: any;
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel === 'chatlog:find-running-game') handler = listener;
    register(channel, listener);
  };
  require(path.join(root, 'dist/modules/ipcHandlers')).register();
  ipcMain.handle = register;
  const frame = {url: pathToFileURL(path.join(root, 'dist/settings.html')).href};
  const sender = {mainFrame: frame};
  assert.throws(() => handler({sender, senderFrame: {url: frame.url}}), /환경설정/, 'iframe 호출 거부');
  const remote = {url: 'https://example.com/settings.html'};
  assert.throws(() => handler({sender: {mainFrame: remote}, senderFrame: remote}), /환경설정/, '외부 페이지 호출 거부');
  const nativeTracker = tracker as any;
  const readRunning = nativeTracker.getRunningGameExecutablePath;
  nativeTracker.getRunningGameExecutablePath = () => executable;
  const window = new BrowserWindow({show:false,width:1100,height:850,webPreferences:{
    preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true,
  }});
  try {
    assert.equal(handler({sender, senderFrame: frame}).chatLogPath, path.join(installation, 'ChatLog'));
    await window.loadFile(path.join(root,'dist/settings.html'));
    window.webContents.send('config-data',config.load());
    let ready = false;
    for (let attempt=0;attempt<200;attempt++) {
      ready = await window.webContents.executeJavaScript('typeof _initReady !== "undefined" && _initReady && _configReady && !document.body.inert && getComputedStyle(document.getElementById("loading-overlay")).opacity === "0"');
      if (ready) break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.equal(ready, true, '실제 조작 가능한 설정 화면이 열린 후 검사한다');
    const value = await window.webContents.executeJavaScript(`(async () => {
      const target=resolveSettingsRoute('chatlog');
      showSettingsGroup(target.groupId,document.querySelector('.nav-item[data-settings-group="'+target.groupId+'"]'),target.routeIndex);
      await findRunningGameLogFolder();
      return document.getElementById('chat-log-path-input').value;
    })()`);
    assert.equal(value, path.join(installation,'ChatLog'), '실제 설정 화면/preload/IPC를 통해 경로를 입력한다');
    assert.equal(await window.webContents.executeJavaScript('!document.getElementById("section-chatlog").classList.contains("hidden")'),true);
    assert.equal(config.load().chatLogPath, configured, '찾은 경로는 저장 전 초안으로 유지한다');
    await new Promise(resolve=>setTimeout(resolve,150));
    const output=path.join(root,'output/game-path');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'settings-1100.png'),(await window.webContents.capturePage()).toPNG());
  } finally {window.destroy();nativeTracker.getRunningGameExecutablePath = readRunning;}
  console.log('Game path discovery passed: native process query, Unicode/spaces, missing process/folder, denied query, exact executable, preserved settings.');
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
