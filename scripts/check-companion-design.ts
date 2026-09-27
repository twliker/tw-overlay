import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import ts = require('typescript');
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-companion-design-'));
const output = path.join(root, 'output', 'companion-replan-2026-09-20', 'product-checks');
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name));
const code = (name: string) => fs.readFileSync(path.join(root, 'dist', name), 'utf8');
async function settle(win: BrowserWindow, predicate: string): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if (await win.webContents.executeJavaScript(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Renderer condition failed: ${predicate}`);
}
async function capture(win: BrowserWindow, name: string): Promise<void> {
  // offscreen paint can deliver a frame queued before the last DOM/viewport update.
  // Flush the compositor before keeping the final production-component screenshot.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  let screenshot!: Electron.NativeImage;
  for (let frame = 0; frame < 3; frame++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    screenshot = await new Promise<Electron.NativeImage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Offscreen paint timeout')), 3000);
      win.webContents.once('paint', (_event, _dirty, image) => { clearTimeout(timeout); resolve(image); });
      win.webContents.invalidate();
    });
  }
  fs.writeFileSync(path.join(output, name), screenshot.toPNG());
}
async function loadMarkup(win: BrowserWindow, name: string): Promise<void> {
  const original = path.join(root, 'dist', name);
  const html = fs.readFileSync(original, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(original).href}">`);
  const file = path.join(fixture, name);
  fs.writeFileSync(file, html);
  await win.loadFile(file);
  await win.webContents.executeJavaScript(code('assets/tailwind.min.js'));
}

async function main(): Promise<void> {
  await app.whenReady();
  fs.mkdirSync(output, { recursive: true });
  const config = built('modules/config.js');
  const defaults = built('modules/constants.js').DEFAULT_CONFIG;
  const session = built('modules/gameOverlayEditSession.js');
  const win = new BrowserWindow({ show: false, width: 1000, height: 720, webPreferences: {
    preload: path.join(root, 'dist', 'preload.js'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false,
  } });
  let clickThrough = true;
  const setIgnore = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (value, options) => { clickThrough = value; setIgnore(value, options); };
  ipcMain.handle('supply-run-get', () => null);
  ipcMain.on('get-default-config-sync', event => { event.returnValue = defaults; });
  let failSave = false;
  let holdSave: Promise<void> | undefined;
  let holdInfo: Promise<void> | undefined;
  let failInfo = false;
  const handlers = new Map<string, (...args: any[]) => any>();
  const source = fs.readFileSync(path.join(root, 'src', 'modules', 'ipcHandlers.ts'), 'utf8');
  const from = source.indexOf('  const applyExternalSettings =');
  const applySource = source.slice(from, source.indexOf("  ipcMain.on('apply-settings'", from));
  const names = ['set-game-overlay-edit-mode', 'finish-game-overlay-edit-mode', 'save-game-overlay-positions', 'nickname-info-get', 'nickname-note-save'];
  const handlerSource = names.map(name => {
    const start = source.indexOf(`  ipcMain.handle('${name}'`);
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf('\n  });', start) + 6);
  }).join('\n');
  // Execute production IPC handlers and sanitizer/persistence. Only game availability and
  // the persistence failure/delay boundary are controlled; no replacement save algorithm.
  const bindings = {
    ...session, config, require: createRequire(path.join(root, 'dist', 'modules', 'ipcHandlers.js')),
    cancelNotificationEdit: () => {},
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) },
    isBoolean: (value: unknown) => typeof value === 'boolean',
    tracker: { isGameRunning: () => true, focusGameWindow: () => false },
    reconcileGameAttachedWindows() {}, applyRuntimeSettings() {}, broadcastChatLogStatus() {}, log: console.log,
    wm: { areAllWindowsHidden: () => false, getGameOverlayWindow: () => win, getSettingsWindow: () => null,
      applySettings: (patch: unknown) => {
        const success = !failSave && config.saveConfirmed(patch);
        if (success) win.webContents.send('config-data', config.load());
        return success;
      } },
  };
  const handlerCode = ts.transpileModule(applySource + handlerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInThisContext(`(function({${Object.keys(bindings).join(',')}}){${handlerCode}\n})`)(bindings);
  for (const [name, handler] of handlers) ipcMain.handle(name, async (...args) => {
    if (name === 'save-game-overlay-positions') await holdSave;
    if (name === 'nickname-info-get' && args[1] === 7) await holdInfo;
    if (name === 'nickname-info-get' && failInfo) throw new Error('조회 실패 fixture');
    const result = await handler(...args);
    if (name === 'save-game-overlay-positions') console.log(name, result);
    return result;
  });
  await loadMarkup(win, 'game-overlay.html');
  await win.webContents.executeJavaScript(`
    ${code('renderer/game-overlay/companion-hud.js')}
    ${code('shared/windowSnap.js')}
    ${code('renderer/game-overlay/edit-mode.js')}
    window.electronAPI.onGameOverlayEditState(value => window.__editing = value);
    window.electronAPI.onConfigData(value => companionHud.updateConfig(value));
    companionHud.updateConfig({ pinnedNoteEnabled:true, pinnedNoteText:'위치 설정에서 본문을 스크롤할 수 있습니다.\\n' + '검증용 긴 메모\\n'.repeat(25), pinnedNotePos:{left:90,top:110} });
  `);
  assert.equal(await win.webContents.executeJavaScript('electronAPI.setGameOverlayEditMode(true)'), true);
  await settle(win, 'gameOverlayEditMode.isEditMode()');
  assert.equal(clickThrough, false);
  assert.equal(session.isGameOverlayEditRequest(win.webContents, undefined), false);
  const closedListeners = win.listenerCount('closed');
  // Real drag handlers: snap affects the selected HUD only and can be disabled.
  const drag = await win.webContents.executeJavaScript(`(() => {
    const note = document.getElementById('pinned-note-hud'), summary = document.getElementById('today-summary-hud');
    const other = summary.style.cssText;
    const move = x => {
      const rect = note.getBoundingClientRect();
      note.querySelector('.ui-hud-heading').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:4,clientX:rect.left+5,clientY:rect.top+5}));
      window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:4,clientX:x+5,clientY:115}));
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:4}));
    };
    move(18); const snapped = note.style.left;
    document.getElementById('hud-edit-snap').checked=false; move(18);
    return {snapped,free:note.style.left,otherUnchanged:other===summary.style.cssText};
  })()`);
  assert.deepEqual(drag, { snapped: '12px', free: '18px', otherUnchanged: true });
  failSave = true;
  assert.equal(await win.webContents.executeJavaScript('electronAPI.setGameOverlayEditMode(false,true)'), false);
  await settle(win, `document.getElementById('hud-edit-error').textContent.includes('저장하지 못')`);
  assert.equal(clickThrough, false);
  assert.equal(await win.webContents.executeJavaScript('gameOverlayEditMode.isEditMode()'), true);
  await capture(win, 'hud-save-failure.png');
  failSave = false;
  let release!: () => void;
  holdSave = new Promise(resolve => { release = resolve; });
  await win.webContents.executeJavaScript(`document.getElementById('hud-edit-save').click(); true`);
  await settle(win, `document.getElementById('hud-edit-error').textContent === '저장 중…'`);
  assert.equal(clickThrough, false);
  release(); holdSave = undefined;
  await settle(win, '!gameOverlayEditMode.isEditMode()');
  assert.equal(clickThrough, true);
  assert.equal(config.load().pinnedNotePos.left, 18);
  await win.webContents.executeJavaScript('electronAPI.setGameOverlayEditMode(true)');
  await settle(win, 'gameOverlayEditMode.isEditMode()');
  await win.webContents.executeJavaScript(`document.getElementById('pinned-note-hud').style.left='140px'; document.getElementById('hud-edit-cancel').click(); true`);
  await settle(win, '!gameOverlayEditMode.isEditMode()');
  assert.equal(config.load().pinnedNotePos.left, 18);
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('pinned-note-hud').style.left`), '18px');
  assert.equal(clickThrough, true);
  // Closing settings before the queued IPC arrives must invalidate that write.
  await win.webContents.executeJavaScript('electronAPI.setGameOverlayEditMode(true)');
  await settle(win, 'gameOverlayEditMode.isEditMode()');
  holdSave = new Promise(resolve => { release = resolve; });
  await win.webContents.executeJavaScript(`document.getElementById('pinned-note-hud').style.left='333px'; document.getElementById('hud-edit-save').click(); true`);
  await settle(win, `document.getElementById('hud-edit-error').textContent === '저장 중…'`);
  session.cancelGameOverlayEdit();
  await settle(win, '!gameOverlayEditMode.isEditMode()');
  await win.webContents.executeJavaScript('electronAPI.setGameOverlayEditMode(true)');
  release(); holdSave = undefined;
  await settle(win, 'gameOverlayEditMode.isEditMode()');
  assert.equal(config.load().pinnedNotePos.left, 18);
  assert.equal(clickThrough, false);
  session.cancelGameOverlayEdit();
  assert.equal(win.listenerCount('closed'), closedListeners, '반복 편집으로 종료 리스너가 늘면 안 됩니다.');

  // Cache parser + real nickname IPC + preload + production dialog, without remote lookup.
  fs.writeFileSync(path.join(fixture, 'eta_ranking_cache.json'), JSON.stringify({ CollectDate:'2020-01-01 12:00:00', Rankings:[
    { ServerCode:7, UserId:'설계확인', CharacterCode:8, Level:123, Essence:0 },
    { ServerCode:16, UserId:'설계확인', CharacterCode:18, Level:456, Essence:0 },
  ] }));
  const cache = built('modules/etaCacheManager.js').etaCacheManager;
  cache.loadFromLocalCache();
  await loadMarkup(win, 'settings.html');
  await win.webContents.executeJavaScript(`
    document.body.replaceChildren(document.getElementById('nickname-note-list').closest('section'));
    document.body.style.padding='24px';
    ${code('renderer/nickname-notes.js')}
    nicknameNotes.updateConfig({userServer:7,nicknameNotes:[{server:7,nickname:'설계확인',note:'함께 사냥한 분'}]});
    document.querySelector('.nickname-note-list-item').click();
  `);
  await settle(win, `document.getElementById('note-character-info').textContent === '티치엘 · 에타 123'`);
  assert.match(await win.webContents.executeJavaScript(`document.getElementById('note-info-date').textContent`), /이전 자료/);
  await capture(win, 'nickname-info.png');
  await win.webContents.executeJavaScript(`
    document.getElementById('note-text').value='정보와 별도로 저장한 메모';
    document.querySelector('.nickname-note-form').requestSubmit();
  `);
  await settle(win, '!document.querySelector("dialog").open');
  assert.equal(config.load().nicknameNotes[0].note, '정보와 별도로 저장한 메모');
  await win.webContents.executeJavaScript(`
    nicknameNotes.updateConfig({userServer:16,chatNicknameNotesCompact:true,nicknameNotes:[{server:16,nickname:'설계확인',note:'본문은 툴팁에 유지'}]});
    nicknameNotes.appendBadge(document.body,'설계확인'); document.querySelector('.nickname-note-badge').click();
  `);
  await settle(win, `document.getElementById('note-character-info').textContent === '예프넨 · 에타 456'`);
  assert.deepEqual(await win.webContents.executeJavaScript(`({text:document.querySelector('.nickname-note-badge').textContent,title:document.querySelector('.nickname-note-badge').title})`), { text:'메모',title:'본문은 툴팁에 유지' });
  assert.equal((await win.webContents.executeJavaScript(`electronAPI.getNicknameInfo(7,'없는 닉네임')`)).level, null);
  assert.equal((await win.webContents.executeJavaScript(`electronAPI.getNicknameInfo(99,'설계확인')`)).characterName, null);
  holdInfo = new Promise(resolve => { release = resolve; });
  await win.webContents.executeJavaScript(`
    document.getElementById('note-cancel').click();
    nicknameNotes.updateConfig({userServer:7,nicknameNotes:[{server:7,nickname:'설계확인',note:'조회 대기'}]});
    document.querySelector('.nickname-note-list-item').click();
    document.getElementById('note-cancel').click();
    nicknameNotes.updateConfig({userServer:16,nicknameNotes:[{server:16,nickname:'설계확인',note:'새 편집'}]});
    document.querySelector('.nickname-note-list-item').click();
  `);
  await settle(win, `document.getElementById('note-character-info').textContent === '예프넨 · 에타 456'`);
  release(); holdInfo = undefined;
  await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve,80))');
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('note-character-info').textContent`), '예프넨 · 에타 456');
  win.setContentSize(420, 720);
  await settle(win, 'innerWidth === 420');
  assert.equal(await win.webContents.executeJavaScript(`(() => { const r=document.querySelector('dialog').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight; })()`), true);
  await capture(win, 'nickname-info-narrow.png');
  failInfo = true;
  await win.webContents.executeJavaScript(`document.getElementById('note-cancel').click(); document.querySelector('.nickname-note-list-item').click();`);
  await settle(win, `document.getElementById('note-character-info').textContent.includes('메모는 저장')`);
  await win.webContents.executeJavaScript(`document.getElementById('note-text').value='조회 실패 중에도 저장'; document.querySelector('.nickname-note-form').requestSubmit();`);
  await settle(win, '!document.querySelector("dialog").open');
  assert.equal(config.load().nicknameNotes.find((note: any) => note.server === 16).note, '조회 실패 중에도 저장');

  await loadMarkup(win, 'settings.html');
  await win.webContents.executeJavaScript(`
    document.body.replaceChildren(document.getElementById('activity-presets-card'));
    document.body.style.cssText='padding:24px;overflow:auto;height:auto';
    ${code('renderer/settings/activity-presets.js')}
    settingsActivityPresets.bind({showXpWidget:true, activityPresets:[
      {id:'hunt',name:'사냥 준비 · 창 배치와 알림',openWindows:['chatOverlay','xpHud','buffTimer'],settings:{showXpWidget:true},updatedAt:0},
      {id:'boss',name:'보스 공략',openWindows:['contentsChecker','chatOverlay'],settings:{showXpWidget:false},updatedAt:0}
    ]});
  `);
  assert.equal(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ui-preset-detail')).every(el=>el.hidden)`), true);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#activity-preset-list button')).find(el=>el.textContent==='상세').click()`);
  assert.match(await win.webContents.executeJavaScript(`document.querySelector('.ui-preset-detail').textContent`), /현재와 같습니다/);
  assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth`), true);
  await capture(win, 'presets-narrow.png');
  win.setContentSize(1000, 720);
  await settle(win, 'innerWidth === 1000');
  await capture(win, 'presets.png');
  win.destroy();
  console.log('Companion design: actual Electron/preload/IPC, cache, persistence, HUD snap/save/failure/cancel/stale response and input policy passed.');
  app.exit(0);
}
void main().catch(error => { console.error(error); app.exit(1); });
