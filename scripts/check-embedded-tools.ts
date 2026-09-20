import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import assert = require('node:assert/strict');
import { createRequire } from 'node:module';
import * as electron from 'electron';

  const { app, BrowserWindow, WebContentsView, session } = electron;
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tw-embedded-tools-')));
app.on('window-all-closed', () => {});
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

async function main(): Promise<void> {
  await app.whenReady();
  // Only the external site's document is a fixed-size fixture. Product window creation,
  // preload, resize IPC, native child bounds and injected CSS all run unchanged.
  session.defaultSession.protocol.handle('https', () => new Response(`<!doctype html><meta charset="utf-8">
    <style>body{margin:0}main{width:340px;height:820px}select{display:block;margin-top:100px}</style>
    <header style="height:79px">External header</header><main>
    <select><option>Character</option></select><select><option>Coat</option></select>
    <select><option>Accessory</option></select><select><option>Sleeves</option></select>
    <select id="last-color"><option>Last color</option></select></main>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const filename = path.join(root, 'dist/modules/windowManager.js');
  const original = createRequire(filename);
  const local = { exports: {} as any };
  const mocks: Record<string, any> = {
    './tracker': { getGameHwnd: () => null, canAutomaticallyRestoreGameFocus: () => false, isGameOrAppForeground: () => false,
      reconcileGameZOrder() {}, focusGameWindow() {}, restoreGameAfterOwnedWindowClose() {} },
    './bossNotifier': {}, './galleryMonitor': {}, './tradeMonitor': { updateWindows() {} }, './tray': { updateTrayMenu() {} },
    './buffTimerManager': { buffTimerManager: { refreshConfig() {} } }, './contentsChecker': { init() {} },
  };
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
    local.exports, (key: string) => Object.prototype.hasOwnProperty.call(mocks, key) ? mocks[key] : original(key), local, filename, path.dirname(filename));
  const wm = local.exports;
  require.cache[filename] = { id: filename, filename, loaded: true, exports: wm } as NodeModule;
  require(path.join(root, 'dist/modules/ipcHandlers.js')).register();
  const cfg = require(path.join(root, 'dist/modules/config.js'));
  cfg.saveImmediate({ followGameWindow: false, managedWindowSizes: {} });
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
  for (const key of ['uniformColor', 'swordEnhance'] as const) {
    const open = key === 'uniformColor' ? wm.toggleUniformColorWindow : wm.toggleSwordEnhanceWindow;
    open();
    // loadFile starts asynchronously; the newly created native host is the only host of this pair.
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    let win: electron.BrowserWindow = BrowserWindow.getAllWindows()[0];
    const ready = async () => {
      for (let i = 0; i < 80; i++) {
        if (!win.webContents.isLoading() && await win.webContents.executeJavaScript("!!document.getElementById('tw-managed-window-resize-handle')")) return;
        await pause();
      }
      throw new Error('Embedded host did not finish loading');
    };
    await ready();
    const child = () => win.contentView.children.find(view => view instanceof WebContentsView && view.webContents !== win.webContents) as electron.WebContentsView;
    for (let i = 0; i < 80 && (child().webContents.isLoading() || !child().webContents.getURL()); i++) await pause();
    await pause();
    const verifyBounds = (label: string) => {
      const bounds = win.getContentBounds();
      check(JSON.stringify(child().getBounds()) === JSON.stringify({ x: 0, y: 56, width: bounds.width, height: bounds.height - 84 }), `${key}/${label}: child overlaps footer/resize handle`);
    };
    verifyBounds('initial');
    const width = key === 'uniformColor' ? 360 : 1100;
    await win.webContents.executeJavaScript(`electronAPI.setWindowSize(${width},600)`);
    await pause(); verifyBounds('shrink via IPC');
    if (key === 'uniformColor') {
      const scroll = await child().webContents.executeJavaScript(`(() => {
        const css = { root: getComputedStyle(document.documentElement).overflowY, body: getComputedStyle(document.body).overflowY };
        document.getElementById('last-color').scrollIntoView({ block: 'end' });
        const rect = document.getElementById('last-color').getBoundingClientRect();
        return { css, moved: scrollY > 0, reachable: rect.top >= 0 && rect.bottom <= innerHeight };
      })()`);
      check(['auto', 'scroll'].includes(scroll.css.root) && scroll.css.body !== 'hidden' && scroll.moved && scroll.reachable,
        'uniformColor: small viewport does not allow reaching the last color');
    }
    win.close(); await pause(); open();
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    win = BrowserWindow.getAllWindows()[0]; await ready();
    verifyBounds('reopen saved small size');
    await win.webContents.executeJavaScript(`electronAPI.setWindowSize(${width},800)`);
    await pause(); verifyBounds('expand via IPC');
    win.close(); await pause();
  }
  assert.deepEqual(failures, [], 'Embedded tools must follow their host and preserve access to controls.');
  console.log('Embedded tools: actual creation/preload/resize IPC/native view/CSS, shrink/expand/reopen and last color access passed.');
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
