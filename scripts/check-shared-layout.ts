import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import { createRequire } from 'node:module';
import * as electron from 'electron';

const { app, BrowserWindow } = electron;
const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-shared-layout-'));
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', `${name}.js`));
const pause = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
type Positions = Record<string, { x: number; y: number }>;

async function until(win: electron.BrowserWindow, expression: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await pause(30);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function main(): Promise<void> {
  await app.whenReady();
  const config = built('modules/config');
  const area = { x: 0, y: 0, width: 3840, height: 2160 };
  const display = () => ({ ...electron.screen.getPrimaryDisplay(), bounds: area, workArea: area,
    workAreaSize: { width: area.width, height: area.height } });
  let holdLoads = false;
  const heldLoads: Array<() => void> = [], tasks: Promise<void>[] = [];
  const firstShown = new WeakMap<electron.BrowserWindow, electron.Rectangle>();
  const html = path.join(fixture, 'native-window.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><input id="draft">');
  const preferences = { preload: path.join(root, 'dist/preload.js'), sandbox: true,
    contextIsolation: true, offscreen: true, backgroundThrottling: false };
  // Full settings UI, preload/IPC, files, config and entire product windowManager are real.
  // Only game/screen services, native file selection and target HTML/load timing are controlled.
  const Native = function(options: electron.BrowserWindowConstructorOptions) {
    const win = new BrowserWindow({ ...options, show: false, webPreferences: preferences });
    win.once('show', () => firstShown.set(win, win.getBounds()));
    const load = win.loadFile.bind(win);
    win.loadFile = file => {
      const source = path.basename(file) === 'settings.html' ? file : html;
      const task = holdLoads && source === html
        ? new Promise<void>((resolve, reject) => heldLoads.push(() => {
          if (win.isDestroyed()) resolve();
          else void load(source).then(resolve, reject);
        })) : load(source);
      tasks.push(task);
      return task;
    };
    return win;
  };
  Object.assign(Native, { getAllWindows: BrowserWindow.getAllWindows, fromWebContents: BrowserWindow.fromWebContents });
  const shareFile = path.join(fixture, 'layout.json');
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shareFile] });
  electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: shareFile });
  const filename = path.join(root, 'dist/modules/windowManager.js');
  const original = createRequire(filename), local = { exports: {} as any };
  const mocks: Record<string, any> = {
    electron: { ...electron, BrowserWindow: Native, screen: { getPrimaryDisplay: display,
      getDisplayMatching: display, getDisplayNearestPoint: display, getAllDisplays: () => [display()], on() {} } },
    './tracker': { getGameHwnd: () => null, canAutomaticallyRestoreGameFocus: () => false,
      isGameOrAppForeground: () => false, reconcileGameZOrder() {}, focusGameWindow() {}, restoreGameAfterOwnedWindowClose() {} },
    './bossNotifier': {}, './galleryMonitor': {}, './tradeMonitor': { updateWindows() {} },
    './tray': { updateTrayMenu() {} }, './buffTimerManager': { buffTimerManager: { refreshConfig() {} } },
    './contentsChecker': { init() {} },
  };
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){' + fs.readFileSync(filename, 'utf8')
    + '\nexports.__probe={registry:windowRegistry,create:createToggleableWindow};\n})', { filename })(
    local.exports, (key: string) => Object.prototype.hasOwnProperty.call(mocks, key) ? mocks[key] : original(key),
    local, filename, path.dirname(filename));
  const wm = local.exports;
  require.cache[filename] = { id: filename, filename, loaded: true, exports: wm } as NodeModule;
  built('modules/ipcHandlers').register();
  config.saveImmediate({ chatOverlayEnabled: false, contentsCheckerEnabled: false, chatOverlaySubEnabled: false,
    chatOverlaySub2Enabled: false, analyticsEnabled: false, tradeNotify: false, galleryNotify: false,
    followGameWindow: false, fixedWindowPositionsActive: true });
  wm.__probe.create('settings'); await Promise.all(tasks); await pause();
  const settings: electron.BrowserWindow = wm.__probe.registry.settings.ref;
  const js = (script: string) => settings.webContents.executeJavaScript(script);
  const control = new BrowserWindow({ show: false, webPreferences: preferences });
  await control.loadFile(html);
  const other = (script: string) => control.webContents.executeJavaScript(script);
  const keys: string[] = built('shared/activityPresets').ACTIVITY_WINDOWS;
  const positions: Positions = Object.fromEntries(keys.map((key, i) => [key, { x: 160 + 30 * i, y: 120 + 20 * i }]));
  const later: Positions = Object.fromEntries(keys.map(key => [key, { x: positions[key].x + 100, y: positions[key].y + 50 }]));
  config.saveImmediate({ fixedWindowPositions: positions });
  assert.equal((await js("electronAPI.exportSettingsShare(['layout'])")).success, true);
  const exported = JSON.parse(fs.readFileSync(shareFile, 'utf8'));
  const writeShare = (next: Positions) => fs.writeFileSync(shareFile, JSON.stringify({ ...exported,
    settings: { ...exported.settings, fixedWindowPositions: next } }));
  const target = (key: string): electron.BrowserWindow => wm.__probe.registry[key].ref;
  const settle = async () => {
    await pause();
    for (let i = 0; i < 100 && wm.isAnyUserDragging(); i++) await pause(30);
    assert.equal(wm.isAnyUserDragging(), false);
  };
  const release = async () => {
    holdLoads = false; heldLoads.splice(0).forEach(start => start());
    await Promise.all(tasks); await settle();
  };
  const create = async (delayed: boolean) => {
    keys.forEach(key => target(key)?.destroy());
    config.saveImmediate({ fixedWindowPositions: Object.fromEntries(keys.map(key => [key, { x: 900, y: 500 }])) });
    holdLoads = delayed;
    keys.forEach(key => wm.__probe.create(key, undefined, 'settings-apply'));
    if (!delayed) await release();
  };
  const applyShare = async (next = positions) => {
    writeShare(next); await settle();
    await js("document.getElementById('settings-share-open').click()");
    await until(settings, "!document.getElementById('settings-share-review').hidden && !document.getElementById('settings-share-compare').disabled");
    await js("document.getElementById('settings-share-compare').click()");
    await until(settings, "!document.getElementById('settings-share-apply').disabled");
    await js("document.getElementById('settings-share-apply').click()");
    await until(settings, "document.getElementById('settings-share-status').textContent.startsWith('설정을 적용했습니다')");
  };
  const check = (expected: Positions, beforeFirstShow: boolean) => {
    for (const key of keys) {
      const win = target(key), bounds = win.getBounds();
      assert.deepEqual({ x: bounds.x, y: bounds.y }, expected[key], `${key}: imported coordinates must survive ready-to-show`);
      assert.deepEqual(config.load().fixedWindowPositions[key], expected[key]);
      if (beforeFirstShow) assert.deepEqual(firstShown.get(win), bounds, `${key}: restore before first show`);
    }
  };

  await create(false); await applyShare(); check(positions, false);
  config.saveImmediate({ chatOverlayEnabled: true, chatOverlaySubEnabled: true, chatOverlaySub2Enabled: true, contentsCheckerEnabled: true });
  assert.equal((await other('electronAPI.saveActivityPreset("공유와 교차 검증")')).success, true);
  const preset = config.load().activityPresets.find((row: any) => row.name === '공유와 교차 검증');
  const applyPreset = async () => {
    await settle(); assert.equal((await other(`electronAPI.applyActivityPreset(${JSON.stringify(preset.id)})`)).success, true);
  };
  await create(true); await applyShare(); await release(); check(positions, true);
  await create(true); await applyShare(); await applyShare(later); await release(); check(later, true);
  // Other-window saves during loading must supersede the old shared coordinates.
  await create(true); await applyShare();
  const edited = { ...positions, diary: { x: 640, y: 360 } };
  assert.equal((await other(`electronAPI.applySettingsConfirmed(${JSON.stringify({ fixedWindowPositions: { diary: edited.diary }, managedWindowSizes: { diary: { width: 1000, height: 700 } } })})`)).success, true);
  await release(); check(edited, true);
  assert.deepEqual(target('diary').getSize(), [1000, 700], 'Use the latest size saved while loading');
  // Both ordering directions share the same pending-layout slot.
  await create(true); await applyShare(later); await applyPreset(); await release(); check(positions, true);
  await create(true); await applyPreset(); await applyShare(later); await release(); check(later, true);

  // Sharing cannot create closed windows, reveal hidden ones or discard renderer drafts.
  target('diary').destroy(); const hidden = target('focusedChat');
  await hidden.webContents.executeJavaScript("document.getElementById('draft').value='보존할 초안'");
  hidden.hide(); await applyShare();
  assert.equal(wm.__probe.registry.diary.ref, null); assert.equal(hidden.isVisible(), false);
  assert.equal(await hidden.webContents.executeJavaScript("document.getElementById('draft').value"), '보존할 초안');
  const checklist = target('contentsChecker');
  config.saveImmediate({ contentsAutoCollapse: true });
  assert.equal(await checklist.webContents.executeJavaScript('electronAPI.setContentsCollapsed(true)'), true);
  const collapsed = checklist.getBounds();
  await applyShare(later); assert.equal(checklist.getBounds().height, 56);
  assert.equal(checklist.isResizable(), false);
  assert.equal(await checklist.webContents.executeJavaScript('electronAPI.setContentsCollapsed(false)'), true);
  assert.ok(checklist.getBounds().height > collapsed.height);
  // Closing a loading target cancels its pending placement without recreating it.
  await create(true); await applyShare(); target('diary').destroy(); await release();
  assert.equal(wm.__probe.registry.diary.ref, null);

  BrowserWindow.getAllWindows().forEach(win => win.destroy());
  console.log('Shared layout: full settings UI/file/preload/IPC/config/native placement; all 10 windows ready/loading/first show, repeated share, other-window save, preset ordering, closed/hidden/collapsed state and drafts passed.');
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
