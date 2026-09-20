import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import { createRequire } from 'node:module';
import * as electron from 'electron';

const { app, BrowserWindow, ipcMain } = electron;
const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-hud-edit-settings-'));
const output = path.join(root, 'output', 'fix-hud-edit-2026-09-22');
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', `${name}.js`));
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
async function until(win: electron.BrowserWindow, expression: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await pause(30);
  }
  throw new Error(`Timed out: ${expression}`);
}
function install(name: string, value: unknown): void {
  const filename = path.join(root, 'dist/modules', `${name}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: value } as NodeModule;
}

async function main(): Promise<void> {
  await app.whenReady();
  fs.mkdirSync(output, { recursive: true });
  const tasks: Promise<void>[] = [], mouse = new Map<number, boolean>();
  const tracker = { isGameRunning: () => true, getGameHwnd: () => null,
    canAutomaticallyRestoreGameFocus: () => false, isGameOrAppForeground: () => false,
    reconcileGameZOrder() {}, focusGameWindow: () => false, restoreGameAfterOwnedWindowClose() {} };
  install('tracker', tracker);
  // Full product HTML, preload, IPC, config persistence, preset/share and windowManager.
  // Only game/focus, native file selection, IPC delivery and a temporary-file failure are controlled.
  const Native = function(options: electron.BrowserWindowConstructorOptions) {
    const win = new BrowserWindow({ ...options, show: false, webPreferences: { ...options.webPreferences,
      preload: path.join(root, 'dist/preload.js'), sandbox: true, contextIsolation: true,
      offscreen: true, backgroundThrottling: false } });
    const ignore = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = (value, opts) => { mouse.set(win.id, value); ignore(value, opts); };
    const load = win.loadFile.bind(win);
    win.loadFile = (...args) => { const task = load(...args); tasks.push(task); return task; };
    return win;
  };
  Object.assign(Native, { getAllWindows: BrowserWindow.getAllWindows, fromWebContents: BrowserWindow.fromWebContents });
  const filename = path.join(root, 'dist/modules/windowManager.js');
  const original = createRequire(filename), local = { exports: {} as any };
  const mocks: Record<string, any> = { electron: { ...electron, BrowserWindow: Native },
    './tracker': tracker, './tray': { updateTrayMenu() {} } };
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){' + fs.readFileSync(filename, 'utf8')
    + '\nexports.__probe={registry:windowRegistry,create:createToggleableWindow};\n})', { filename })(
    local.exports, (key: string) => Object.prototype.hasOwnProperty.call(mocks, key) ? mocks[key] : original(key),
    local, filename, path.dirname(filename));
  const wm = local.exports;
  install('windowManager', wm);
  let beforeSave: Promise<void> | undefined, afterSave: Promise<void> | undefined, saved = false;
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, handler) => handle(name, async (...args) => {
    if (name === 'save-game-overlay-positions') await beforeSave;
    const result = await handler(...args);
    if (name === 'save-game-overlay-positions') { saved = true; await afterSave; }
    return result;
  });
  built('modules/ipcHandlers').register(); ipcMain.handle = handle;
  const config = built('modules/config');
  config.saveImmediate({ chatOverlayEnabled: false, chatOverlaySubEnabled: false, chatOverlaySub2Enabled: false,
    contentsCheckerEnabled: false, analyticsEnabled: false, tradeNotify: false, galleryNotify: false,
    pinnedNoteEnabled: true, pinnedNoteText: '저장 배치 확인', pinnedNotePos: { left: 24, top: 80 } });
  wm.__probe.create('settings', undefined, 'user-open'); wm.createGameOverlayWindow(); await Promise.all(tasks);
  let settings: electron.BrowserWindow = wm.__probe.registry.settings.ref;
  const hud: electron.BrowserWindow = wm.getGameOverlayWindow();
  hud.setSize(1200, 900);
  const js = (script: string) => settings.webContents.executeJavaScript(script);
  const hjs = (script: string) => hud.webContents.executeJavaScript(script);
  await until(settings, "document.getElementById('pinned-note-text').value==='저장 배치 확인'");
  await until(hud, "document.getElementById('pinned-note-content').textContent==='저장 배치 확인'");
  const specs = { 'xp-hud': 'xpWidgetPos', 'buff-hud': 'buffTimerHudPos', 'abandoned-widget': 'abandonedWidgetPos',
    'digsite-widget': 'digsiteWidgetPos', 'today-summary-hud': 'todaySummaryHudPos', 'pinned-note-hud': 'pinnedNotePos' };
  const first = { showXpWidget: true, showBuffHud: true, showTodaySummaryHud: true, pinnedNoteEnabled: true,
    digsiteHudEnabled: true, xpWidgetPos: { left: 30, bottom: 45 }, buffTimerHudPos: { left: 50, bottom: 60 },
    abandonedWidgetPos: { left: 70, bottom: 80 }, digsiteWidgetPos: { left: 90, bottom: 100 },
    todaySummaryHudPos: { left: 110, top: 120 }, pinnedNotePos: { left: 130, top: 140 } };
  const second = { ...first, xpWidgetPos: { left: 350, bottom: 160 }, buffTimerHudPos: { left: 370, bottom: 180 },
    abandonedWidgetPos: { left: 390, bottom: 200 }, digsiteWidgetPos: { left: 410, bottom: 220 },
    todaySummaryHudPos: { left: 430, top: 240 }, pinnedNotePos: { left: 450, top: 260 } };
  const third = { ...second, xpWidgetPos: { left: 550, bottom: 260 }, pinnedNotePos: { left: 650, top: 160 } };
  const set = async (value: unknown, other = false) => {
    assert.equal((await (other ? hjs : js)(`electronAPI.applySettingsConfirmed(${JSON.stringify(value)})`)).success, true);
    await pause();
  };
  const disk = () => JSON.parse(fs.readFileSync(path.join(fixture, 'config.json'), 'utf8'));
  const start = async () => {
    await js("document.getElementById('btn-start-hud-edit').click();true");
    await until(hud, 'gameOverlayEditMode.isEditMode()'); assert.equal(mouse.get(hud.id), false);
  };
  const exit = async (save = false) => {
    await hjs(`document.getElementById('hud-edit-${save ? 'save' : 'cancel'}').click();true`);
    await until(hud, '!gameOverlayEditMode.isEditMode()'); await pause();
    assert.equal(mouse.get(hud.id), true);
  };
  const results: Array<{ name: string; positions?: unknown; visibility?: unknown }> = [];
  const check = async (name: string) => {
    const actual = await hjs(`Object.fromEntries(${JSON.stringify(Object.keys(specs))}.map(id=>{
      const el=document.getElementById(id);return [id,{left:el.style.left,top:el.style.top,bottom:el.style.bottom}];}))`);
    const expected = disk();
    for (const [id, key] of Object.entries(specs)) {
      for (const [axis, value] of Object.entries(expected[key])) {
        assert.equal(actual[id][axis], `${value}px`, `${name}: ${id}.${axis} must match disk`);
      }
    }
    results.push({ name, positions: actual });
  };
  // Unrelated settings must not remove the empty HUD previews while the user is placing them.
  await set(first); await start();
  hud.webContents.send('digsite-update', null); await pause();
  await exit(); await start();
  await set({ pinnedNoteColor: '#aabbcc' }, true);
  assert.equal(await hjs("document.getElementById('abandoned-widget').classList.contains('hidden')"), false);
  assert.equal(await hjs("document.getElementById('digsite-widget').classList.contains('hidden')"), false);
  await exit();
  results.push({ name: 'unrelated settings preserve empty edit previews' });
  await set(second);
  await js("(()=>{const n=document.getElementById('activity-preset-name');n.value='배치 B';n.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('activity-preset-save').click();})()");
  await until(settings, "document.querySelectorAll('#activity-preset-list .ui-preset-row').length===1");
  const shareFile = path.join(fixture, 'hud-layout.json');
  electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: shareFile });
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shareFile] });
  assert.equal((await js("electronAPI.exportSettingsShare(['layout'])")).success, true);
  const preset = async () => {
    await js("document.querySelector('#activity-preset-list .ui-preset-title button').click();true");
    await until(settings, "document.getElementById('activity-preset-status').textContent.startsWith('적용했습니다')"); await pause();
  };
  const share = async () => {
    await js("document.getElementById('settings-share-open').click();true");
    await until(settings, "!document.getElementById('settings-share-review').hidden && !document.getElementById('settings-share-compare').disabled");
    await js("document.getElementById('settings-share-compare').click();true");
    await until(settings, "!document.getElementById('settings-share-apply').disabled");
    await js("document.getElementById('settings-share-apply').click();true");
    await until(settings, "document.getElementById('settings-share-status').textContent.startsWith('설정을 적용했습니다')"); await pause();
  };
  for (const [name, apply] of [['preset', preset], ['share', share], ['other-window', () => set(second, true)]] as const) {
    for (const save of [false, true]) {
      await set(first); await start(); await apply();
      assert.equal(await hjs("document.getElementById('xp-hud').style.left"), '30px', 'External settings must preserve the active drag draft');
      await exit(save);
      assert.equal(disk().xpWidgetPos.left, save ? first.xpWidgetPos.left : second.xpWidgetPos.left);
      await check(`${name}/${save ? 'save' : 'cancel'}`);
    }
  }
  // The live event payload is input; production renderers determine visibility/expiry/manual suppression.
  const live = async (active: boolean) => {
    hud.webContents.send('abandoned-update', { isActive: active, regions: {}, profit: 0, stoneGains: {}, stoneLosses: {} });
    hud.webContents.send('digsite-update', { isActive: active, expiresAt: Date.now() + 60000, normalRewards: 2, portalRewards: 1, alternateRewards: 0, portalVisits: {} });
    await pause();
  };
  const visible = () => hjs(`Object.fromEntries(${JSON.stringify(Object.keys(specs))}.map(id=>[id,!document.getElementById(id).classList.contains('hidden')]))`);
  const off = { showXpWidget: false, showBuffHud: false, showTodaySummaryHud: false, pinnedNoteEnabled: false, digsiteHudEnabled: false };
  await set({ ...first, ...off }); await live(false); await start(); await preset(); await live(true); await exit();
  assert.deepEqual(await visible(), Object.fromEntries(Object.keys(specs).map(id => [id, true])));
  results.push({ name: 'OFF to ON preset and live activation', visibility: await visible() });
  await start(); await set(off, true); await live(false); await exit();
  assert.deepEqual(await visible(), Object.fromEntries(Object.keys(specs).map(id => [id, false])));
  results.push({ name: 'ON to OFF and live completion', visibility: await visible() });
  await set(first); await live(true); await start();
  hud.webContents.send('abandoned-hide-now');
  hud.webContents.send('digsite-update', { isActive: true, expiresAt: Date.now() - 1 });
  await exit();
  assert.equal((await visible())['abandoned-widget'], false); assert.equal((await visible())['digsite-widget'], false);
  results.push({ name: 'manual hide and expired content stay hidden' });
  // A failed apply must not become the state restored by cancel.
  await set(first); await start();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith('.confirmed.tmp')) throw Object.assign(Error('fixture locked config'), { code: 'EACCES' });
    return rename(from, to);
  };
  try { assert.equal((await hjs(`electronAPI.applySettingsConfirmed(${JSON.stringify(second)})`)).success, false); }
  finally { fs.renameSync = rename; }
  await exit(); assert.equal(disk().xpWidgetPos.left, first.xpWidgetPos.left); await check('failed external apply/cancel');
  // Failed HUD save keeps the draft and input; cancel still uses the successful preset.
  await set(first); await start(); await preset();
  fs.renameSync = (from, to) => {
    if (String(from).endsWith('.confirmed.tmp')) throw Object.assign(Error('fixture locked HUD save'), { code: 'EACCES' });
    return rename(from, to);
  };
  try {
    await hjs("document.getElementById('hud-edit-save').click();true");
    await until(hud, "document.getElementById('hud-edit-error').textContent.includes('저장하지 못했습니다')");
    assert.equal(await hjs('gameOverlayEditMode.isEditMode()'), true); assert.equal(mouse.get(hud.id), false);
    assert.equal(disk().xpWidgetPos.left, second.xpWidgetPos.left);
  } finally { fs.renameSync = rename; }
  await exit(); await check('failed HUD save then cancel');
  // A later successful write wins even while the earlier HUD-save reply is withheld.
  await set(first); await start(); saved = false;
  let release!: () => void;
  afterSave = new Promise(resolve => { release = resolve; });
  await hjs("document.getElementById('hud-edit-save').click();true");
  for (let i = 0; i < 150 && !saved; i++) await pause(20);
  assert.equal(saved, true); await set(third, true); release(); afterSave = undefined;
  await until(hud, '!gameOverlayEditMode.isEditMode()'); await pause();
  assert.equal(disk().xpWidgetPos.left, third.xpWidgetPos.left); await check('later write before delayed save reply');
  assert.equal(mouse.get(hud.id), true);
  // Settings close cancels a queued save; its old request must not close a new edit session.
  await set(first); await start(); await preset(); saved = false;
  beforeSave = new Promise(resolve => { release = resolve; });
  await hjs("document.getElementById('hud-edit-save').click();true");
  await until(hud, "document.getElementById('hud-edit-save').disabled");
  settings.close(); await until(hud, '!gameOverlayEditMode.isEditMode()'); await pause();
  await check('settings close with pending save'); assert.equal(mouse.get(hud.id), true);
  wm.__probe.create('settings', undefined, 'user-open'); await Promise.all(tasks); await pause();
  settings = wm.__probe.registry.settings.ref;
  await start(); release(); beforeSave = undefined; await pause();
  assert.equal(await hjs('gameOverlayEditMode.isEditMode()'), true); assert.equal(mouse.get(hud.id), false);
  assert.equal(disk().xpWidgetPos.left, second.xpWidgetPos.left);
  await exit(); await check('stale save rejected after new edit');
  await set(first); await start(); await share(); settings.close();
  await until(hud, '!gameOverlayEditMode.isEditMode()'); await pause();
  await check('share/settings close'); assert.equal(mouse.get(hud.id), true);
  fs.writeFileSync(path.join(output, 'hud-restored.png'), (await hud.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'hud-edit-settings.json'), JSON.stringify({ fixture, results }, null, 2));
  console.log('HUD edit settings: full UI/preset/share/IPC/disk; all HUD coordinates, visibility/live state, failed/delayed writes, close/cancel/save and stale sessions passed.');
  BrowserWindow.getAllWindows().forEach(win => win.destroy());
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
