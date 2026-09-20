import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import assert = require('node:assert/strict');
import { createRequire } from 'node:module';
import * as electron from 'electron';
const { app, BrowserWindow } = electron;
const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-preset-position-'));
app.setPath('userData', fixture); app.on('window-all-closed', () => {});
const pause = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
const built = (name: string) => require(path.join(root, 'dist', name + '.js'));

async function main(): Promise<void> {
  await app.whenReady();
  const cfg = built('modules/config');
  let area = { x: 0, y: 0, width: 3840, height: 1080 };
  let secondary: typeof area | undefined;
  const display = (bounds = area) => ({ ...electron.screen.getPrimaryDisplay(), bounds, workArea: bounds,
    workAreaSize: { width: bounds.width, height: bounds.height } });
  const tasks: Promise<void>[] = [];
  let holdLoads = false;
  const heldLoads: Array<() => void> = [];
  const firstShownBounds = new WeakMap<electron.BrowserWindow, electron.Rectangle>();
  const html = path.join(fixture, 'window.html'); fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><p>Native preset position fixture</p>');
  // Window content and external game services are isolated. All native placement methods are real.
  const Native = function(options: electron.BrowserWindowConstructorOptions) {
    const win = new BrowserWindow({ ...options, show: false, webPreferences: {
      preload: path.join(root, 'dist/preload.js'), sandbox: true, contextIsolation: true, offscreen: true,
    } });
    win.once('show', () => firstShownBounds.set(win, win.getBounds()));
    const load = win.loadFile.bind(win); win.loadFile = () => {
      const task = holdLoads ? new Promise<void>((resolve, reject) => heldLoads.push(() => { void load(html).then(resolve, reject); })) : load(html);
      tasks.push(task); return task;
    }; return win;
  };
  Object.assign(Native, { getAllWindows: BrowserWindow.getAllWindows, fromWebContents: BrowserWindow.fromWebContents });
  const filename = path.join(root, 'dist/modules/windowManager.js');
  const original = createRequire(filename), local = { exports: {} as any };
  const mocks: Record<string, any> = {
    electron: { ...electron, BrowserWindow: Native, screen: { getPrimaryDisplay: display, getDisplayMatching: () => display(),
      getDisplayNearestPoint: () => display(), getAllDisplays: () => [display(), ...(secondary ? [display(secondary)] : [])], on() {} } },
    './tracker': { getGameHwnd: () => null, canAutomaticallyRestoreGameFocus: () => false, isGameOrAppForeground: () => false,
      reconcileGameZOrder() {}, focusGameWindow() {}, restoreGameAfterOwnedWindowClose() {} },
    './bossNotifier': {}, './galleryMonitor': {}, './tradeMonitor': { updateWindows() {} }, './tray': { updateTrayMenu() {} },
    './buffTimerManager': { buffTimerManager: { refreshConfig() {} } }, './contentsChecker': { init() {} },
  };
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){' + fs.readFileSync(filename, 'utf8')
    + '\nexports.__probe={registry:windowRegistry,create:createToggleableWindow};\n})', { filename })(
    local.exports, (key: string) => Object.prototype.hasOwnProperty.call(mocks, key) ? mocks[key] : original(key), local, filename, path.dirname(filename));
  const wm = local.exports;
  require.cache[filename] = { id: filename, filename, loaded: true, exports: wm } as NodeModule;
  built('modules/ipcHandlers').register();
  const control = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'dist/preload.js'),
    sandbox: true, contextIsolation: true, offscreen: true } });
  await control.loadFile(html);
  cfg.saveImmediate({ chatOverlayEnabled: false, chatOverlaySubEnabled: false, chatOverlaySub2Enabled: false,
    contentsCheckerEnabled: false, followGameWindow: false, fixedWindowPositionsActive: true });
  wm.__probe.create('diary', undefined, 'user-open'); await Promise.all(tasks); await pause();
  let win: electron.BrowserWindow = wm.__probe.registry.diary.ref;
  win.setPosition(2200, 120); cfg.saveImmediate({ fixedWindowPositions: { diary: { x: 2200, y: 120 } } }); await pause();
  const captured = win.getBounds(); assert.ok(captured.x + captured.width <= area.width);
  assert.equal((await win.webContents.executeJavaScript('electronAPI.saveActivityPreset("넓은 화면")')).success, true);
  const preset = cfg.load().activityPresets.find((row: any) => row.name === '넓은 화면');
  const saved = JSON.stringify(preset);
  const apply = async (id = preset.id, waitForReady = true) => {
    // Native move events settle through the real persistence/drag guard before the user applies a preset.
    await pause();
    for (let i = 0; i < 50 && wm.isAnyUserDragging(); i++) await pause(50);
    const result = await control.webContents.executeJavaScript(`electronAPI.applyActivityPreset(${JSON.stringify(id)})`);
    assert.equal(result.success, true, JSON.stringify(result));
    if (waitForReady) { await Promise.all(tasks); await pause(); }
  };
  const inside = () => {
    const b = win.getBounds(); assert.ok(b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width
      && b.y + b.height <= area.y + area.height, JSON.stringify({ b, area }));
  };
  area = { x: 0, y: 0, width: 800, height: 600 }; win.setPosition(10, 10); await apply(); inside();
  assert.deepEqual(win.getMinimumSize(), [760, 560]); const reused = win.getBounds();
  await apply(); assert.deepEqual(win.getBounds(), reused);
  win.destroy(); wm.restoreActivityLayout(preset.openWindows); await Promise.all(tasks); await pause();
  win = wm.__probe.registry.diary.ref; assert.deepEqual(win.getBounds(), reused, 'Reused and newly created windows must both recover');
  area = { x: -1280, y: -1024, width: 1280, height: 1024 }; await apply(); inside();
  // A valid saved second-monitor position must remain there, not be forced onto the primary display.
  area = { x: 0, y: 0, width: 1920, height: 1080 }; secondary = { x: 1920, y: 0, width: 1920, height: 1080 };
  await apply(); assert.equal(win.getBounds().x, 2200); assert.equal(win.getBounds().y, 120);
  area = { x: 1800, y: 0, width: 800, height: 600 }; secondary = undefined;
  await apply(); assert.equal(win.getBounds().x, 2200, 'Keep an intentionally partially visible placement');
  area = { x: 0, y: 0, width: 1920, height: 1080 };
  secondary = undefined; await apply(); inside();
  assert.equal(JSON.stringify(cfg.load().activityPresets.find((row: any) => row.id === preset.id)), saved, 'Recovery must not rewrite preset source');

  // Valid positions must survive one apply when all 10 windows are closed, including special onReady callbacks.
  const keys: string[] = built('shared/activityPresets').ACTIVITY_WINDOWS;
  area = { x: 0, y: 0, width: 3840, height: 2160 };
  cfg.saveImmediate({ chatOverlayEnabled: true, chatOverlaySubEnabled: true, chatOverlaySub2Enabled: true, contentsCheckerEnabled: true });
  wm.restoreActivityLayout(keys); await Promise.all(tasks); await pause();
  const capture = async (name: string, offset: number) => {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [i, key] of keys.entries()) {
      positions[key] = { x: 160 + i * 30 + offset, y: 120 + i * 20 };
      wm.__probe.registry[key].ref.setPosition(positions[key].x, positions[key].y);
    }
    cfg.saveImmediate({ fixedWindowPositions: positions }); await pause();
    assert.equal((await control.webContents.executeJavaScript(`electronAPI.saveActivityPreset(${JSON.stringify(name)})`)).success, true);
    return cfg.load().activityPresets.find((row: any) => row.name === name);
  };
  const valid = await capture('정상 위치', 0);
  const newer = await capture('다른 정상 위치', 100);
  const destroyTargets = () => keys.forEach(key => wm.__probe.registry[key].ref?.destroy());
  const checkPositions = (expected: any, checkFirstShow = false) => {
    for (const key of keys) {
      const target = wm.__probe.registry[key].ref;
      const { x, y, width, height } = target.getBounds();
      assert.deepEqual({ x, y }, expected.settings.fixedWindowPositions[key], `${key}: valid preset position`);
      assert.deepEqual({ width, height }, expected.settings.managedWindowSizes[key], `${key}: captured size`);
      if (checkFirstShow) assert.deepEqual(firstShownBounds.get(target), target.getBounds(), `${key}: restore before first show`);
    }
  };
  destroyTargets(); await apply(valid.id); checkPositions(valid, true);
  await apply(valid.id); checkPositions(valid);
  // Two presets applied before the first HTML load completes must restore only the last layout.
  destroyTargets(); holdLoads = true;
  await apply(valid.id, false); await apply(newer.id, false);
  holdLoads = false; heldLoads.splice(0).forEach(start => start());
  await Promise.all(tasks); await pause(); checkPositions(newer, true);
  // Runtime-created windows that are still loading must also receive the preset layout.
  destroyTargets(); holdLoads = true;
  wm.__probe.create('diary', undefined, 'user-open');
  await apply(valid.id, false);
  holdLoads = false; heldLoads.splice(0).forEach(start => start());
  await Promise.all(tasks); await pause(); checkPositions(valid, true);
  // A regular settings save from another window during loading is newer than the preset request.
  destroyTargets(); holdLoads = true; await apply(valid.id, false);
  const editedPosition = { x: 480, y: 220 };
  assert.equal((await control.webContents.executeJavaScript(`electronAPI.applySettingsConfirmed(${JSON.stringify({ fixedWindowPositions: { diary: editedPosition } })})`)).success, true);
  holdLoads = false; heldLoads.splice(0).forEach(start => start());
  await Promise.all(tasks); await pause();
  const edited = structuredClone(valid); edited.settings.fixedWindowPositions.diary = editedPosition;
  checkPositions(edited, true);
  BrowserWindow.getAllWindows().forEach(window => window.destroy());
  console.log('Preset positions: full capture/save/merge/runtime/restore IPC; all 10 native windows restore valid positions before first show, reuse/reopen and delayed load/latest preset or settings; offscreen, negative area and monitor removal passed.');
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
