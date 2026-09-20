/** Whole product page, preload, registered IPC, SQLite and native window sizing.
 * Input events below are automated Electron checks, not a human mouse playtest. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow, screen } from 'electron';

const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tw-hunting-path-')));
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name + '.js'));
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function main(): Promise<void> {
  await app.whenReady();
  const db = built('modules/diaryDb');
  db.initDb();
  const ground = db.getHuntingGrounds()[0].id;
  const points = [[100, 100], [120, 130, '#f87171'], [140, 120]];
  db.saveHuntingPath(ground, points);
  const savedPoints = db.getHuntingPath(ground);
  built('modules/ipcHandlers').register();
  const sizing = built('modules/managedWindowSizing').resolveManagedWindowSizing(
    'huntingPathSimulator', 860, 800, built('modules/config').load(), screen.getPrimaryDisplay().workAreaSize);
  const win = new BrowserWindow({
    width: sizing.width, height: sizing.height, minWidth: sizing.minWidth, minHeight: sizing.minHeight,
    show: false, frame: false, resizable: true,
    webPreferences: { preload: path.join(root, 'dist/preload.js'), contextIsolation: true,
      sandbox: true, backgroundThrottling: false },
  });
  const js = (source: string) => win.webContents.executeJavaScript(source);
  const load = async () => {
    await win.loadFile(path.join(root, 'dist/hunting-path-simulator.html'));
    for (let i = 0; i < 100; i++) {
      if (await js(`document.querySelectorAll('#svgOverlay .node').length === 3`)) return;
      await pause();
    }
    throw new Error('Product map and saved path did not load');
  };
  const click = async (selector: string) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await pause();
  };
  const input = async (id: string, value: number) => {
    await js(`{const input=document.getElementById('${id}');input.value='${value}';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
    await pause();
  };
  const failures: string[] = [];
  const check = (actual: unknown, expected: unknown, label: string) => {
    try { assert.deepEqual(actual, expected, label); } catch (error) { failures.push(String(error)); }
  };
  const openOverlay = () => click('[onclick="enableOverlayMode()"]');
  const edit = () => click('[onclick="disableOverlayMode()"]');
  try {
    await load();
    await openOverlay();
    check(await js(`document.getElementById('panelOpacityRange').value`), '0.2', 'default opacity');
    for (const opacity of [0, 0.5, 1]) {
      await input('panelOpacityRange', opacity);
      await edit();
      check(await js(`document.getElementById('mapImage').style.opacity`), '0.8', 'edit opacity');
      await openOverlay();
      check(await js(`document.getElementById('mapImage').style.opacity`), String(opacity), `mode restore ${opacity}`);
      // Restore the tested value so a previous failure cannot hide the reload case.
      await input('panelOpacityRange', opacity);
      await load();
      await openOverlay();
      check(await js(`document.getElementById('panelOpacityRange').value`), String(opacity), `page reload ${opacity}`);
    }
    for (const scale of [1, 0.7, 0.21, 0.7, 0.2]) {
      await input('panelScaleRange', scale);
      const expected = [Math.max(sizing.minWidth, Math.round(828 * scale)), Math.max(sizing.minHeight, Math.round(496 * scale))];
      check(win.getSize(), expected, `native size at scale ${scale}`);
      const mapWidth = await js(`parseFloat(document.getElementById('mapContainer').style.width)`) as number;
      check(Math.abs(mapWidth - 828 * scale) < 0.001, true, `map width ${scale}`);
      check(await js(`{const r=document.getElementById('overlayControlPanel').getBoundingClientRect();r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}`), true, `controls remain visible ${scale}`);
    }
    await load(); await openOverlay();
    check(win.getSize(), [sizing.minWidth, sizing.minHeight], 'small scale after reopening');
    await edit();
    check(win.getSize(), [860, 800], 'edit size restored');
    check(await js(`document.querySelectorAll('#svgOverlay .node').length`), 3, 'path nodes remain');
    check(db.getHuntingPath(ground), savedPoints, 'overlay controls never edit saved path');
    assert.deepEqual(failures, [], failures.join('\n'));
    console.log('PASS hunting path: opacity 0/middle/1 mode and page restore, scale boundaries through real IPC/native sizing, edit return and path preservation.');
  } finally {
    win.destroy(); db.closeDb();
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
