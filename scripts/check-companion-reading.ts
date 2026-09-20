import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import ts = require('typescript');
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, screen } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-companion-reading-'));
const output = path.join(root, 'output/companion-replan-2026-09-20/phase3-screens');
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name));
const code = (name: string) => fs.readFileSync(path.join(root, 'dist', name), 'utf8');
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function until(win: BrowserWindow, predicate: string): Promise<void> {
  for (let n = 0; n < 100; n++) { if (await win.webContents.executeJavaScript(predicate)) return; await pause(); }
  console.error('renderer state', await win.webContents.executeJavaScript(`({rows:document.querySelectorAll('.chat-message-row').length, family:document.body.style.fontFamily, fonts:Array.from(document.fonts).map(f=>({family:f.family,status:f.status})), config:typeof chatOverlayAppConfig==='undefined'?null:chatOverlayAppConfig, mode:typeof isModeReceived==='undefined'?null:isModeReceived})`));
  throw new Error(`Timed out: ${predicate}`);
}
async function capture(win: BrowserWindow, name: string): Promise<void> {
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  let image!: Electron.NativeImage;
  for (let i = 0; i < 3; i++) { await pause(120); image = await win.webContents.capturePage(); }
  fs.writeFileSync(path.join(output, name), image.toPNG());
}
async function markup(win: BrowserWindow, name: string): Promise<void> {
  const source = path.join(root, 'dist', name), target = path.join(fixture, name);
  fs.writeFileSync(target, fs.readFileSync(source, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(source).href}">`));
  await win.loadFile(target);
  await win.webContents.executeJavaScript(code('assets/tailwind.min.js'));
  await win.webContents.executeJavaScript(code('assets/lucide.min.js'));
}

async function main(): Promise<void> {
  await app.whenReady(); fs.mkdirSync(output, { recursive: true });
  const config = built('modules/config.js'), fonts = built('modules/customChatFonts.js');
  const defaults = built('modules/constants.js').DEFAULT_CONFIG;
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: {
    preload: path.join(root, 'dist/preload.js'), sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', (...args: any[]) => { const message = args[0]?.message || args[2]; if (message) console.log('[renderer]', message); });
  ipcMain.on('get-default-config-sync', event => { event.returnValue = defaults; });
  ipcMain.handle('get-config', () => config.load());
  ipcMain.handle('supply-run-get', () => ({ expiresAt: 0, orderExpiresAt: 0, colors: [] }));
  const source = fs.readFileSync(path.join(root, 'src/modules/ipcHandlers.ts'), 'utf8');
  const tree = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true);
  const channels = new Set(['chat-font-list', 'chat-font-read', 'chat-font-import', 'apply-settings-confirmed']);
  const handlers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle'
      && ts.isStringLiteral(node.arguments[0]) && channels.has(node.arguments[0].text)) handlers.push(node.getText(tree) + ';');
    node.forEachChild(visit);
  }
  visit(tree); assert.equal(handlers.length, channels.size);
  const start = source.indexOf('  const applyExternalSettings =');
  const apply = source.slice(start, source.indexOf("  ipcMain.on('apply-settings'", start));
  let failSave = false, delaySave: Promise<void> | undefined, selectedFile: string | undefined;
  const bindings = { ...fonts, BrowserWindow, config, isBoolean: (value: unknown) => typeof value === 'boolean',
    log() {}, applyRuntimeSettings() {}, broadcastChatLogStatus() {},
    dialog: { showOpenDialog: async () => ({ canceled: !selectedFile, filePaths: selectedFile ? [selectedFile] : [] }) },
    wm: { getSettingsWindow: () => win, getGameOverlayWindow: () => null,
      applySettings: (patch: unknown) => !failSave && config.saveConfirmed(patch) },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => ipcMain.handle(channel, async (...args) => {
      if (channel === 'apply-settings-confirmed') await delaySave;
      return handler(...args);
    }) },
  };
  const compiled = ts.transpileModule(apply + handlers.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext(`(function({${Object.keys(bindings).join(',')}}){${compiled}\n})`)(bindings);

  // A real installed font, copied only into the isolated fixture via the production import handler.
  const sourceFont = ['malgun.ttf', 'segoeui.ttf', 'arial.ttf'].map(name => path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', name)).find(file => fs.existsSync(file));
  assert.ok(sourceFont, 'Windows fixture font is required');
  selectedFile = sourceFont;
  await markup(win, 'settings.html');
  const imported = await win.webContents.executeJavaScript('electronAPI.importChatFont()');
  assert.ok(imported.font?.id.startsWith('custom:'));
  const id: string = imported.font.id;
  assert.equal((await fonts.importChatFont(sourceFont)).id, id, '같은 파일이 중복 항목이 됨');
  assert.equal((await fonts.listChatFonts()).length, 1);
  const snapshots = built('modules/localSnapshot.js');
  const snapshotPath = path.join(fixture, 'font-backup');
  const snapshot = snapshots.createUserDataSnapshot(fixture, snapshotPath, { reason: 'font-test', appVersion: 'test' });
  assert.ok(snapshot.entries.some((entry: any) => entry.relativePath.replace(/\\/g, '/') === `custom_fonts/${id.slice(7)}.font`));
  assert.ok(snapshots.isRestorableSnapshotPath(`custom_fonts/${id.slice(7)}.font`));
  assert.equal(snapshots.isRestorableSnapshotPath('custom_fonts/other.exe'), false);
  assert.equal(await fonts.readChatFont('../config.json'), null);
  fs.writeFileSync(path.join(fixture, 'wrong.ttf'), 'not a font'); selectedFile = path.join(fixture, 'wrong.ttf');
  assert.ok((await win.webContents.executeJavaScript('electronAPI.importChatFont()')).error);
  selectedFile = undefined;
  assert.deepEqual(await win.webContents.executeJavaScript('electronAPI.importChatFont()'), {});
  assert.equal(config.sanitizeExternalConfigPatch({ pinnedNoteFontSize: 11 }), null);
  assert.equal(config.sanitizeExternalConfigPatch({ pinnedNoteColor: 'url(secret)' }), null);
  assert.equal(config.sanitizeExternalConfigPatch({ chatOverlayFontFamily: 'custom:../config' }), null);
  assert.ok(config.sanitizeExternalConfigPatch({ chatOverlayFontFamily: id }));
  const presets = built('shared/activityPresets.js');
  assert.deepEqual(presets.captureActivitySettings({ pinnedNoteText: 'private', pinnedNoteFontSize: 20, pinnedNoteColor: '#facc15', pinnedNoteBackground: false }),
    { pinnedNoteFontSize: 20, pinnedNoteColor: '#facc15', pinnedNoteBackground: false });

  const settingsSource = fs.readFileSync(path.join(root, 'src/settings.html'), 'utf8');
  const saveFrom = settingsSource.indexOf('    async function applySettingsWithDraft(');
  const saveFunction = settingsSource.slice(saveFrom, settingsSource.indexOf('    async function applyChatOverlaySettingsOnly()', saveFrom));
  await win.webContents.executeJavaScript(`
    const noteSection=document.getElementById('pinned-note-enabled').closest('section');
    const fontsSection=document.getElementById('chat-font-settings');
    const readingSection=document.getElementById('chat-reading-settings');
    document.body.replaceChildren(noteSection,fontsSection,readingSection); document.body.style.padding='20px';document.body.style.overflow='auto';
    ${code('shared/chatChannels.js')}
    ${code('renderer/custom-chat-fonts.js')}
    ${code('renderer/settings/draft.js')}
    ${code('renderer/settings/companion-controls.js')}
    ${code('renderer/settings/config-binding.js')}
    ${code('renderer/settings/form-collection.js')}
    ${code('renderer/settings/chat-preview.js')}
    function collectSettingsDraftExtras(){return {}};
    ${saveFunction}
    window.receive = cfg => { const draft=settingsDraft.beforeRefresh({}); settingsCompanion.bind(cfg); settingsConfigBinding.applyChatAndAlertSettings(cfg,electronAPI.DEFAULT_CONFIG); draft.restore({}); };
    receive(${JSON.stringify(defaults)}); lucide.createIcons();
  `);
  const js = (value: string) => win.webContents.executeJavaScript(value);
  await until(win, `!!Array.from(document.getElementById('chat-overlay-fontfamily-input').options).find(o=>o.value===${JSON.stringify(id)})`);
  await js(`document.getElementById('chat-overlay-fontfamily-input').value=${JSON.stringify(id)};settingsChatPreview.refresh();`);
  await until(win, `Array.from(document.fonts).some(font=>font.family==='tw-${id.slice(7)}' && font.status==='loaded')`);
  await js(`document.getElementById('chat-overlay-sub-fontfamily-input').value='gulim';document.getElementById('chat-font-use-main').click();`);
  assert.equal(await js(`document.getElementById('chat-font-preview-sub1').style.fontFamily`), await js(`document.getElementById('chat-font-preview-main').style.fontFamily`));
  const missing = 'custom:' + 'a'.repeat(64);
  await js(`customChatFonts.ensureOption(document.getElementById('chat-overlay-sub2-fontfamily-input'),${JSON.stringify(missing)});document.getElementById('chat-overlay-sub2-fontfamily-input').value=${JSON.stringify(missing)};settingsChatPreview.refresh();`);
  await until(win, `document.getElementById('chat-font-status').textContent.includes('기본 글꼴')`);
  assert.equal(await js(`document.getElementById('chat-overlay-sub2-fontfamily-input').value`), missing);
  await js(`document.getElementById('chat-font-use-main').click();document.getElementById('pinned-note-text').value=${JSON.stringify('오늘 목표\n숙제 후 거래 확인')};document.getElementById('pinned-note-enabled').checked=true;document.getElementById('pinned-note-font-size').value='20';document.getElementById('pinned-note-color').value='#facc15';document.getElementById('pinned-note-text').dispatchEvent(new Event('input'));`);
  failSave = true; await js(`document.querySelector('[data-save-companion]').click()`);
  await until(win, `document.querySelector('.ui-status').textContent.includes('못')`);
  assert.equal(config.load().pinnedNoteText, '');
  assert.equal(await js(`document.getElementById('pinned-note-font-size').value`), '20');
  failSave = false;
  let release!: () => void; delaySave = new Promise(resolve => { release = resolve; });
  await js(`document.querySelector('[data-save-companion]').click();document.getElementById('pinned-note-text').value='저장 대기 중 이어 쓴 내용';document.getElementById('pinned-note-text').dispatchEvent(new Event('input'));`);
  release(); delaySave = undefined;
  await until(win, `!document.querySelector('[data-save-companion]').disabled`);
  await js(`receive(${JSON.stringify(config.load())})`);
  assert.equal(await js(`document.getElementById('pinned-note-text').value`), '저장 대기 중 이어 쓴 내용');
  assert.equal(await js(`document.querySelector('.ui-status').textContent`), '', '늦은 저장 응답은 새 초안을 저장 완료로 표시하지 않는다.');
  await js(`document.querySelector('[data-save-companion]').click()`);
  await until(win, `document.querySelector('.ui-status').textContent === '저장했습니다.'`);
  const previewSize = await js(`(() => {
    const input = document.getElementById('pinned-note-text');
    input.value = Array.from({length:30}, (_, i) => (i + 1) + '번째 메모').join(String.fromCharCode(10));
    input.dispatchEvent(new Event('input'));
    const preview = document.getElementById('pinned-note-preview');
    return { height: preview.getBoundingClientRect().height, overflow: preview.scrollHeight > preview.clientHeight,
      status: document.querySelector('.ui-status').textContent };
  })()`);
  assert.equal(previewSize.status, '', '저장 후 다시 편집하면 이전 성공 안내가 사라진다.');
  assert.ok(previewSize.height <= 160 && previewSize.overflow, '긴 메모 미리보기는 설정 카드를 늘리지 않고 내부에서 스크롤한다.');
  await js(`document.getElementById('pinned-note-text').value='저장 대기 중 이어 쓴 내용';document.getElementById('pinned-note-text').dispatchEvent(new Event('input'));`);
  config.saveConfirmed({ pinnedNoteFontSize: 24 }); await js(`receive(${JSON.stringify(config.load())})`);
  assert.equal(await js(`document.getElementById('pinned-note-font-size').value`), '24');
  await capture(win, 'reading-settings.png');
  await js(`document.getElementById('chat-font-settings').scrollIntoView({block:'start'})`);
  await capture(win, 'chat-font-settings.png');
  await js(`document.getElementById('chat-compact-display').click();document.getElementById('chat-reading-settings').scrollIntoView({block:'start'});`);
  assert.equal(await js(`settingsFormCollection.collectChatOverlayDisplaySettings().chatCompactDisplay`), true);
  assert.equal(await js(`getComputedStyle(document.querySelector('#chat-reading-preview .chat-timestamp')).display`), 'none');
  failSave = true;
  assert.equal((await js(`applySettingsWithDraft({chatCompactDisplay:true},['chat-compact-display'])`)).success, false);
  assert.equal(config.load().chatCompactDisplay, false);
  assert.equal(await js(`document.getElementById('chat-compact-display').checked`), true);
  failSave = false;
  assert.equal((await js(`applySettingsWithDraft({chatCompactDisplay:true},['chat-compact-display'])`)).success, true);
  config.saveConfirmed({ chatCompactDisplay: false }); await js(`receive(${JSON.stringify(config.load())})`);
  assert.equal(await js(`document.getElementById('chat-compact-display').checked`), false);
  await capture(win, 'chat-reading-settings.png');

  // Actual chat HTML and renderer, real preload/IPC and virtual list. Only history/game input is a fixture.
  const history = Array.from({ length: 200 }, (_, n) => ({ id: `reading-${n}`, type: 'general', sender: '모험가', message: `글꼴 확인 ${n} ${'함께 사냥해요! '.repeat(5)}`, timestamp: '12시 00분 00초', color: '#ffffff' }));
  ipcMain.handle('check-chat-log-status', () => ({ isValid: true, isMonitoring: true }));
  ipcMain.handle('chat-get-history', () => history);
  ipcMain.handle('chat-get-more-history', () => []);
  config.saveConfirmed({ chatOverlayFontFamily: id, chatOverlaySubFontFamily: '', chatOverlaySub2FontFamily: '', chatOverlayClickThrough: false });
  await win.loadFile(path.join(root, 'dist/chat-overlay.html'));
  win.webContents.send('chat-overlay-mode', 'main');
  win.webContents.send('config-data', config.load());
  await until(win, `document.querySelectorAll('.chat-message-row').length>0 && Array.from(document.fonts).some(font=>font.family==='tw-${id.slice(7)}' && font.status==='loaded')`);
  for (const mode of ['main', 'sub1', 'sub2']) {
    win.webContents.send('chat-overlay-mode', mode); await pause(80);
    assert.match(await js('document.body.style.fontFamily'), new RegExp(id.slice(7)));
  }
  const before = await js(`(() => {const container=document.getElementById('chatArea');container.scrollTop=500;container.dispatchEvent(new Event('scroll'));return true})()`);
  assert.equal(before, true);
  await pause(100);
  const anchor = await js(`chatVirtualList.captureAnchor()`);
  config.saveConfirmed({ chatOverlayFontFamily: 'gulim' }); win.webContents.send('config-data', config.load()); await pause(180);
  config.saveConfirmed({ chatOverlayFontFamily: id }); win.webContents.send('config-data', config.load()); await pause(180);
  assert.equal((await js(`chatVirtualList.captureAnchor()`)).key, anchor.key, '글꼴 변경이 읽던 행을 바꿈');

  await markup(win, 'game-overlay.html');
  await js(`${code('assets/ui-utils.js')}\n${code('shared/windowSnap.js')}\n${code('renderer/game-overlay/companion-hud.js')}\n${code('renderer/game-overlay/edit-mode.js')}\n${code('renderer/game-overlay/alerts.js')}\n${code('renderer/game-overlay/notification-priority.js')}`);
  await js(`companionHud.updateConfig({pinnedNoteEnabled:true,pinnedNoteText:${JSON.stringify('긴 메모 읽기\n'.repeat(50))},pinnedNoteFontSize:28,pinnedNoteColor:'#facc15',pinnedNoteBackground:false,pinnedNotePos:{left:24,top:90}});lucide.createIcons()`);
  assert.equal(await js(`getComputedStyle(document.getElementById('pinned-note-hud')).pointerEvents`), 'none');
  assert.equal(await js(`getComputedStyle(document.getElementById('pinned-note-hud')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  await js(`gameOverlayEditMode.enterEditMode();document.getElementById('pinned-note-content').scrollTop=99999;`);
  assert.ok(await js(`document.getElementById('pinned-note-content').scrollTop>0`));
  const aligned = await js(`(() => {
    const note=document.getElementById('pinned-note-hud'),other=document.getElementById('today-summary-hud');
    const bounds=other.getBoundingClientRect(), rect=note.getBoundingClientRect();
    note.querySelector('.ui-hud-heading').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:3,clientX:rect.left+5,clientY:rect.top+5}));
    window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:3,clientX:bounds.right+8+4+5,clientY:bounds.top+5}));
    const result={left:note.getBoundingClientRect().left,expected:bounds.right+8,guide:!document.querySelector('.hud-snap-guide.vertical').hidden};
    window.dispatchEvent(new PointerEvent('pointerup',{pointerId:3}));return result;
  })()`);
  assert.equal(aligned.left,aligned.expected);assert.equal(aligned.guide,true);
  await capture(win, 'note-reading-edit.png');
  await js(`gameOverlayEditMode.exitEditMode(false);document.getElementById('pinned-note-hud').classList.add('hidden');
    const high=document.getElementById('abyss-apostle-alert'),low=document.getElementById('quest-alert');
    high.style.top=low.style.top='40%'; high.classList.add('warn');high.classList.remove('hide');
    gameOverlayAlerts.showContentComplete({title:'숙제 완료',badge:'기록했습니다',iconName:'check'});`);
  await until(win, `document.getElementById('quest-alert').dataset.notificationMuted==='true'`);
  await capture(win, 'notification-priority.png');
  await js(`document.getElementById('abyss-apostle-alert').className='abyss-apostle-alert-overlay hide'`);
  await until(win, `!document.getElementById('quest-alert').dataset.notificationMuted`);
  await js(`const container=document.getElementById('dock-toast-container');const toast=document.createElement('div');toast.className='boss-toast show';toast.dataset.repeatKey='same';container.append(toast);window.mergeRepeatedToast(container,'same');window.mergeRepeatedToast(container,'same');`);
  assert.equal(await js(`document.querySelector('.toast-repeat-count').textContent`), '같은 알림 3회');

  // Production OS grouping module with only Electron's native Notification boundary replaced.
  const notices: Array<{ title: string; body: string }> = [];
  const filename = path.join(root, 'dist/modules/desktopNotification.js'), local = { exports: {} as any };
  class Notice { static isSupported() { return true; } constructor(private options: any) {} show() { notices.push(this.options); } }
  vm.runInThisContext(`(function(exports,require,module){${fs.readFileSync(filename, 'utf8')}\n})`)(local.exports,
    (id: string) => id === 'electron' ? { Notification: Notice } : createRequire(filename)(id), local);
  const notify = local.exports.showSupportedDesktopNotification;
  notify('득템', 'A', { itemName: '금화 주머니', count: 2 }); notify('득템', 'A', { itemName: '금화 주머니', count: 3 });
  notify('득템', 'B', { itemName: '별도 아이템', count: 1 }); notify('일반', '즉시 알림');
  assert.equal(notices.length, 1); await pause(800);
  assert.deepEqual(notices.map(item => item.body), ['즉시 알림', '금화 주머니 × 5', '별도 아이템 × 1']);

  // Native final movement + persistence, real BrowserWindow geometry; no game/DPI hardware assertion.
  const area = screen.getPrimaryDisplay().workArea;
  const moving = new BrowserWindow({ show: true, frame: false, width: 240, height: 180, x: area.x + 50, y: area.y + 70 });
  const peer = new BrowserWindow({ show: true, frame: false, width: 240, height: 180, x: area.x + 400, y: area.y + 70 });
  await pause(100);
  const { ProgrammaticMoveTracker } = built('modules/programmaticMoveTracker.js');
  const tracker = new ProgrammaticMoveTracker(2, 1000), saved: Electron.Rectangle[] = [];
  const { snapReleasedWindow } = built('modules/windowSnap.js');
  built('modules/windowMovePersistence.js').attachWindowMovePersistence(moving, {
    key: 'fixture', tracker, canSave: () => true,
    beforeSaveDrag: () => snapReleasedWindow(moving, [peer], (x: number, y: number) => tracker.record('fixture', { x, y }, moving.getBounds())),
    savePosition: (bounds: Electron.Rectangle) => saved.push(bounds),
  });
  moving.emit('will-move', {} as Electron.Event, moving.getBounds());
  moving.setPosition(peer.getBounds().x - 240 - 8 + 4, peer.getBounds().y + 4); await pause(30);
  moving.emit('moved'); await pause(200);
  assert.equal(saved.length, 1); assert.equal(saved[0].x, peer.getBounds().x - 248); assert.equal(saved[0].y, peer.getBounds().y);
  peer.hide(); moving.emit('will-move', {} as Electron.Event, moving.getBounds());
  moving.setPosition(saved[0].x + 4, saved[0].y + 4); await pause(30); moving.emit('moved'); await pause(200);
  assert.equal(saved[1].x, saved[0].x + 4, '숨겨진 창에 맞춤');
  const geometry = built('shared/windowSnap.js');
  assert.equal(geometry.snap({ x: -801, y: 100, width: 200, height: 100 }, [], { x: -1000, y: 0, width: 1000, height: 700 }).x, -801);
  for (const window of BrowserWindow.getAllWindows()) window.destroy(); config.saveImmediate();
  console.log('Companion reading: real font import/preload/rendering, fallback, note save races, presets, priority, repeat grouping and native snap persistence passed.');
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
