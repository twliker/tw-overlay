import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, dialog } from 'electron';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-renderer-health-'));
app.setPath('userData', fixture);
Object.defineProperty(app, 'isPackaged', { value: true });
app.on('window-all-closed', () => {});

async function check(): Promise<void> {
  await app.whenReady();
  const { attachRendererHealthGuard, setWindowMouseMode } = require(path.resolve(__dirname, '../dist/modules/rendererHealthGuard')) as {
    attachRendererHealthGuard(window: BrowserWindow, restoreVisibility:()=>void): void;
    setWindowMouseMode(window: BrowserWindow, ignore:boolean):void;
  };
  const notices: string[] = [];
  dialog.showErrorBox = (_title, message) => { notices.push(message); };
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const setIgnoreMouseEvents = window.setIgnoreMouseEvents.bind(window);
  let mouseInputBlocked = false;
  window.setIgnoreMouseEvents = (ignore, options) => {
    mouseInputBlocked = ignore;
    setIgnoreMouseEvents(ignore, options);
  };
  let allowRestore=true;
  attachRendererHealthGuard(window,()=>{if (allowRestore) window.showInactive();});
  const fixturePage = path.join(fixture, 'renderer-check.html');
  fs.writeFileSync(fixturePage, '<!doctype html><title>Renderer health check</title>', 'utf8');
  await window.loadFile(fixturePage);
  window.showInactive();
  window.emit('unresponsive');
  assert.equal(window.isVisible(),false);
  assert.equal(mouseInputBlocked,true);
  window.emit('responsive');
  assert.equal(window.isVisible(),true);
  assert.equal(mouseInputBlocked,false);
  assert.equal(notices.length,0);
  setWindowMouseMode(window,true);
  window.emit('unresponsive');
  allowRestore=false;
  window.emit('responsive');
  assert.equal(window.isVisible(),false);
  assert.equal(mouseInputBlocked,true);
  await window.webContents.executeJavaScript("window.onbeforeunload = () => false; void 0");
  const vetoed=once(window.webContents,'will-prevent-unload',{signal:AbortSignal.timeout(5000)});
  window.close();
  await vetoed;
  assert.equal(window.isDestroyed(),false);
  const exited = once(window.webContents, 'render-process-gone', { signal: AbortSignal.timeout(5000) });
  window.webContents.forcefullyCrashRenderer();
  const [, details] = await exited;
  assert.equal(mouseInputBlocked, true);
  assert.equal(notices.length, 1);

  const logPath = path.join(fixture, 'debug.log');
  const expected = `process-gone reason=${details.reason} exitCode=${details.exitCode}`;
  const deadline = Date.now() + 2000;
  let log = '';
  while (Date.now() < deadline && !log.includes(expected)) {
    if (fs.existsSync(logPath)) log = fs.readFileSync(logPath, 'utf8');
    if (!log.includes(expected)) await delay(20);
  }
  assert.ok(log.includes('[PROD] [RENDERER_HEALTH] ' + expected), 'The packaged app must log the renderer failure.');
  assert.ok(notices[0].includes(expected), 'The dialog must show the reason and exit code.');
  assert.ok(notices[0].includes(`TW-Overlay ${app.getVersion()} | renderer-check.html`));
  assert.ok(!notices[0].includes(fixture), 'The popup must not include a local file path.');
  window.destroy();
}

void check().then(() => {
  console.log('Packaged renderer failure logging, error dialog and input protection verified.');
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
