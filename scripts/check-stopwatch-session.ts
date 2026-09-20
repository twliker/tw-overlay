/** Real file-origin storage, production IPC/preload, full renderer pages and SQLite. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow, ipcMain } from 'electron';

const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-stopwatch-session-'));
app.setPath('userData', data);
app.on('window-all-closed', () => {});
const built = (file: string) => require(path.join(root, 'dist', file));
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code);
async function page(name: string, native = false): Promise<BrowserWindow> {
  const win = new BrowserWindow({ show: native, width: 1000, height: 800,
    webPreferences: { preload: path.join(root, 'dist/preload.js'), contextIsolation: true,
      sandbox: true, offscreen: !native, backgroundThrottling: false } });
  await win.loadFile(path.join(root, 'dist', name));
  return win;
}

async function main(): Promise<void> {
  await app.whenReady();
  const db = built('modules/diaryDb.js');
  const timer = built('modules/stopwatchSession.js');
  const defaults = built('modules/constants.js').DEFAULT_CONFIG;
  db.initDb(); timer.registerStopwatchIpc(); timer.registerStopwatchIpc();
  // Only unrelated HUD feature reads are fixtures; no stopwatch/storage/DB path is replaced.
  ipcMain.on('get-default-config-sync', event => { event.returnValue = defaults; });
  ipcMain.handle('get-config', () => defaults);
  ipcMain.handle('xp-get-stats', () => null);
  ipcMain.handle('boss-entry-get-windows', () => []);
  ipcMain.handle('supply-run-get', () => null);
  ipcMain.handle('today-summary-get', () => null);
  ipcMain.handle('abandoned-get-state', () => null);
  ipcMain.handle('digsite-get-state', () => null);
  const storage = await page('storage-bridge.html');
  const key = 'tw-coefficient-calculator-profiles-v1';
  const profile = { currentType: 'stab', mainCore: 'none', stats: { stab: '100', hack: '20', dex: '30' }, buffPreset: 'fixture', bonuses: { coreMercurial: '10' } };
  await js(storage, `localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify({ default: { data: profile } }))}); localStorage.setItem('buff_presets', JSON.stringify([{id:'fixture',buffIds:['stat_izabel_fixed']}]));`);
  let hud = await page('game-overlay.html');
  let management = await page('stopwatch.html', true);
  await until(() => js(management, `document.getElementById('status-text').innerText === '대기 중'`), 'idle');

  await js(management, `document.getElementById('btn-toggle-timer').click()`);
  await until(() => timer.getStopwatchState().running, 'button start');
  const start = timer.getStopwatchState();
  const expectedBuff = built('assets/data/buffs.json').find((buff: any) => buff.id === 'stat_izabel_fixed').effects.stat;
  management.close();
  // Changing both profile and its referenced preset after start must not alter the record.
  await js(storage, `localStorage.setItem(${JSON.stringify(key)},JSON.stringify({default:{data:{stats:{stab:'9999'}}}}));localStorage.setItem('buff_presets','[]');`);
  await pause(80);
  const stopped = await timer.controlStopwatch('toggle'); // exact entry point used by the global shortcut
  assert.equal(db.getTimerRecords().length, 1, 'closed window lost record');
  const first = db.getTimerRecords()[0];
  assert.equal(first.duration, stopped.stoppedAt - start.startedAt);
  assert.equal(first.char_main, 100 + expectedBuff);
  assert.equal(JSON.parse(first.raw_profile_data).stats.stab, '100');
  await until(() => js(hud, `document.getElementById('timer-hud-status').innerText.startsWith('HOLDING')`), 'HUD stopped');
  const format = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2,'0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2,'0')}.${String(Math.floor(ms % 1000 / 10)).padStart(2,'0')}`;
  assert.equal(await js(hud, `document.getElementById('timer-hud-display').innerText`), format(first.duration));
  await timer.controlStopwatch('stop');
  assert.equal(db.getTimerRecords().length, 1, 'duplicate stop saved twice');
  // Recreating the HUD during HOLDING restores exactly the saved duration.
  hud.close(); hud = await page('game-overlay.html');
  await until(() => js(hud, `document.getElementById('timer-hud-display').innerText === ${JSON.stringify(format(first.duration))}`), 'HUD holding restore');

  // Start with no management window, reopen it and the HUD during the session, stop by button.
  await timer.controlStopwatch('toggle');
  const secondStart = timer.getStopwatchState().startedAt;
  await timer.controlStopwatch('start');
  assert.equal(timer.getStopwatchState().startedAt, secondStart, 'duplicate start reset clock');
  hud.close(); hud = await page('game-overlay.html');
  management = await page('stopwatch.html', true);
  await until(() => js(management, `document.getElementById('btn-text').innerText === '측정 종료'`), 'management resumes');
  await until(() => js(hud, `window.__isTimerRunning() && timerStartTime === ${secondStart}`), 'HUD resumes same start');
  await js(management, `document.getElementById('btn-toggle-timer').click()`);
  await until(() => db.getTimerRecords().length === 2, 'reopened button saves');
  await until(() => js(management, `document.getElementById('record-count').innerText === '총 2건'`), 'table refreshed');
  // Recalculation must retain captured buffs even though the named preset is now empty.
  await js(management, `electronAPI.timerUpdateSeriesCore(${first.id}, 'hack', null);electronAPI.timerUpdateSeriesCore(${first.id}, null, 'mercurial')`);
  await until(() => db.getTimerRecords().find((r: any) => r.id === first.id).core_master === 'mercurial', 'recalculation');
  const edited = db.getTimerRecords().find((r: any) => r.id === first.id);
  assert.equal(edited.series, 'hack'); assert.equal(edited.char_main, 20 + expectedBuff);
  assert.equal(edited.enchant_main, 10);
  assert.equal(edited.raw_profile_data, first.raw_profile_data);

  // Escape must cancel the active title edit even when rendering removes the focused input.
  management.show(); management.focus();
  await until(() => js(management, `document.querySelector('.core-select[data-id="${first.id}"]').value === 'mercurial'`), 'edited row');
  await js(management, `document.querySelector('.record-title[data-id="${first.id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const edit=document.querySelector('#record-tbody input');edit.value='cancelled draft';edit.focus();`);
  assert.equal(await js(management, `document.activeElement === document.querySelector('#record-tbody input')`), true);
  management.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  management.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(() => js(management, `!document.querySelector('#record-tbody input')`), 'cancel title');
  await pause(100);
  assert.equal(db.getTimerRecords().find((r: any) => r.id === first.id).title, '', 'Escape saved cancelled title');
  await js(management, `document.querySelector('.record-title[data-id="${first.id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const edit2=document.querySelector('#record-tbody input');edit2.value='saved title';edit2.focus();`);
  management.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  management.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await until(() => db.getTimerRecords().find((r: any) => r.id === first.id).title === 'saved title', 'Enter saves title');
  await until(() => js(management, `!document.querySelector('#record-tbody input')`), 'saved title rendered');
  await js(management, `document.querySelector('.record-title[data-id="${first.id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const edit3=document.querySelector('#record-tbody input');edit3.value='blur title';edit3.focus();document.getElementById('btn-toggle-guide').focus();`);
  await until(() => db.getTimerRecords().find((r: any) => r.id === first.id).title === 'blur title', 'blur still saves title');

  // Rapid start/stop during async file-storage capture must retain one record and both input times.
  management.close();
  const beforeRapid = db.getTimerRecords().length;
  const rapidStart = timer.controlStopwatch('toggle');
  const rapidStop = timer.controlStopwatch('toggle');
  const [a,b] = await Promise.all([rapidStart, rapidStop]);
  assert.equal(db.getTimerRecords().length, beforeRapid + 1);
  assert.equal(b.duration, Math.max(0, b.stoppedAt - a.startedAt));

  // A real SQLite failure leaves a retryable session; no mocked save function.
  await timer.controlStopwatch('start');
  db.getStmt(`CREATE TRIGGER reject_timer_test BEFORE INSERT ON timer_records BEGIN SELECT RAISE(ABORT, 'fixture save failure'); END`).run();
  await assert.rejects(timer.controlStopwatch('stop'), /Failed to save/);
  assert.equal(timer.getStopwatchState().running, true);
  db.getStmt('DROP TRIGGER reject_timer_test').run();
  await timer.controlStopwatch('stop');
  assert.equal(db.getTimerRecords().length, beforeRapid + 2);
  console.log('PASS stopwatch: closed/unopened/reopened windows, shared HUD clock, start profile+buffs, recalculation, native title Escape/Enter/blur, rapid input, SQLite failure/retry');
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
