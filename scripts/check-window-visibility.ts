import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import ts = require('typescript');
import { createRequire } from 'node:module';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { pathToFileURL } from 'node:url';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-window-visibility-'));
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name));
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 100; n++) { if (await check()) return; await pause(); }
  assert.ok(await check(), 'Electron window state timed out');
}

function isolatedModule(name: string, dependencies: Record<string, unknown>): any {
  const filename = path.join(root, 'dist/modules', `${name}.js`);
  const local = { exports: {} }, originalRequire = createRequire(filename);
  const run = vm.runInThisContext(`(function(exports,require,module,__dirname,__filename){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  run(local.exports, (key: string) => key in dependencies ? dependencies[key] : originalRequire(key), local, path.dirname(filename), filename);
  return local.exports;
}

async function main(): Promise<void> {
  await app.whenReady();
  const config = built('modules/config.js');
  config.saveImmediate({ sidebarPosition: 'dock', overlayVisible: false, chatOverlayEnabled: true,
    chatOverlaySubEnabled: true, chatOverlaySub2Enabled: true, contentsCheckerEnabled: false,
    followGameWindow: true, hasSeenWelcomeGuide: true, setupCompleted: true });
  ipcMain.on('get-default-config-sync', event => { event.returnValue = built('modules/constants.js').DEFAULT_CONFIG; });
  const markup = path.join(fixture, 'draft.html');
  fs.writeFileSync(markup, '<!doctype html><meta charset="utf-8"><textarea id="draft">작성 중인 내용</textarea>');
  const windows = new Map<string, BrowserWindow[]>();
  const tasks: Promise<unknown>[] = [];
  const soundEvents: any[] = [];
  let fixtureWindowCount = 0;
  let nativeNextWindow = false;
  // Native BrowserWindow and the complete production windowManager run unchanged. Only external
  // game/services and page contents are fixtures; visibility/placement/persistence are real code.
  const FixtureWindow = function(options: Electron.BrowserWindowConstructorOptions) {
    // The first (main sidebar) window needs native focus for Chromium's real :focus-visible behavior.
    const offscreen = fixtureWindowCount++ > 0 && !nativeNextWindow;
    nativeNextWindow = false;
    const win = new BrowserWindow({ ...options, webPreferences: { preload: path.join(root, 'dist/preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen } });
    const nativeLoad = win.loadFile.bind(win);
    win.loadFile = (file: string) => {
      const key = path.basename(file);
      windows.set(key, [...(windows.get(key) || []), win]);
      const promise = nativeLoad(markup);
      tasks.push(promise);
      return promise;
    };
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => { if (channel === 'play-sound') soundEvents.push(args[0]); send(channel, ...args); };
    return win;
  };
  Object.assign(FixtureWindow, { getAllWindows: BrowserWindow.getAllWindows });
  let trayUpdates = 0;
  const wm = isolatedModule('windowManager', {
    electron: { ...require('electron'), BrowserWindow: FixtureWindow },
    './tracker': { getGameHwnd: () => null, isGameOrAppForeground: () => false, canAutomaticallyRestoreGameFocus: () => false,
      reconcileGameZOrder() {}, focusGameWindow() {}, restoreGameAfterOwnedWindowClose() {} },
    './updater': { getCurrentStatus: () => null }, './tray': { updateTrayMenu: () => { trayUpdates++; } },
    './galleryMonitor': {}, './tradeMonitor': {}, './bossNotifier': {},
    './buffTimerManager': { buffTimerManager: { refreshConfig() {} } }, './diaryDb': { addAlarmLog() {} },
    './contentsChecker': { init() {} },
  });
  async function loaded(): Promise<void> { await Promise.all(tasks); await pause(100); }
  wm.createMainWindow();
  const area = screen.getPrimaryDisplay().workArea;
  const game = { x: area.x + 40, y: area.y + 40, width: 900, height: 600, isForeground: false, gameHwnd: 'fixture' };
  wm.syncOverlay(game);
  wm.toggleSettingsWindow();
  wm.toggleAbbreviationWindow();
  await loaded();
  wm.syncOverlay(game);
  const settings: BrowserWindow = wm.getSettingsWindow();
  const abbreviation: BrowserWindow = wm.getAbbreviationWindow();
  let dock: BrowserWindow = wm.getDockWindow();
  const hud: BrowserWindow = wm.getGameOverlayWindow();
  const chats = windows.get('chat-overlay.html')!;
  assert.equal(chats.length, 3);
  await eventually(() => settings.isVisible() && abbreviation.isVisible() && chats.every(win => win.isVisible()));
  assert.equal(dock.isVisible(), false, '사전 로딩된 독은 숨김 상태여야 함');

  // 실제 preload/IPC/설정 검증/네이티브 창 경로로 사이드바 50↔400px 전환을 확인한다.
  // 게임과 페이지 내용만 fixture이며 resize와 launcher 순서 계산은 대체하지 않는다.
  config.saveImmediate({ sidebarPosition: 'right' });
  wm.syncOverlay(game);
  await loaded();
  const sidebar: BrowserWindow = wm.getMainWindow();
  await eventually(() => sidebar.isVisible());
  const resizeIpcSource = fs.readFileSync(path.join(root, 'src/modules/ipcHandlers.ts'), 'utf8');
  const resizeStart = resizeIpcSource.indexOf('  type ApplySettingsResult =');
  const resizeSource = resizeIpcSource.slice(resizeStart, resizeIpcSource.indexOf("  ipcMain.handle('save-game-overlay-positions'", resizeStart));
  const resizeBindings = { ipcMain, wm, config, isBoolean: (value: unknown) => typeof value === 'boolean', log() {},
    applyRuntimeSettings() { throw new Error('런처 너비 변경은 런타임 설정 변경이 아니다.'); },
    broadcastChatLogStatus() { throw new Error('런처 너비 변경은 로그 설정 방송이 아니다.'); } };
  vm.runInThisContext(`(function({${Object.keys(resizeBindings).join(',')}}){${ts.transpileModule(resizeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}})`)(resizeBindings);
  const browserWidth = config.load().width;
  for (const width of [50, 400, 50]) {
    assert.deepEqual(await sidebar.webContents.executeJavaScript(`electronAPI.applySettingsConfirmed({isSidebarResize:true,width:${width}})`), { success: true });
    assert.equal(sidebar.getBounds().width, width);
    assert.equal(config.load().width, browserWidth, '일시적 사이드바 크기가 브라우저 너비를 덮으면 안 된다.');
  }
  for (const patch of [{ isSidebarResize: true, width: 75 }, { isSidebarResize: true, width: 50, opacity: 0.4 }]) {
    assert.equal((await sidebar.webContents.executeJavaScript(`electronAPI.applySettingsConfirmed(${JSON.stringify(patch)})`)).success, false);
  }
  assert.equal((await settings.webContents.executeJavaScript('electronAPI.applySettingsConfirmed({isSidebarResize:true,width:400})')).success, false,
    '다른 창이 사이드바 전용 명령을 실행하면 안 된다.');
  assert.equal(config.sanitizeExternalConfigPatch({ width: 50 }), null, '일반 창의 너비 검증은 유지한다.');
  // The full production sidebar page owns focus/mouse/resize behavior. Keep its preload and resize IPC real.
  let sidebarIgnoresMouse = true;
  ipcMain.on('set-ignore-mouse-events', (event, ignore: boolean, options: { forward?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(ignore, options || {});
    wm.setLauncherInteractive(win, !ignore);
    if (win === sidebar) sidebarIgnoresMouse = ignore;
  });
  await sidebar.webContents.executeJavaScript('electronAPI.applySettingsConfirmed({isSidebarResize:true,width:400})');
  ipcMain.handle('google-sync-get-status', () => null);
  await sidebar.webContents.loadFile(path.join(root, 'dist/index.html'));
  sidebar.webContents.send('config-data', config.load());
  await eventually(() => sidebar.getBounds().width === 50);
  for (let n = 0; n < 100 && !await sidebar.webContents.executeJavaScript(`Boolean(document.querySelector('#cat-records .category-btn'))`); n++) await pause();
  sidebar.focus();
  await eventually(() => sidebar.isFocused());
  await sidebar.webContents.executeJavaScript(`document.querySelector('#cat-records .category-btn').focus()`);
  await eventually(() => sidebar.getBounds().width === 400 && !sidebarIgnoresMouse);
  // Native setSize completes before Chromium receives the matching viewport resize.
  await eventually(() => sidebar.webContents.executeJavaScript('innerWidth === 400'));
  const flyout = await sidebar.webContents.executeJavaScript(`(() => {
    const menu = document.getElementById('flyout-records');
    const rect = menu.getBoundingClientRect();
    return { visible: getComputedStyle(menu).display !== 'none', contained: rect.left >= 0 && rect.right <= innerWidth };
  })()`);
  assert.deepEqual(flyout, { visible: true, contained: true }, '키보드 메뉴가 50px 창 바깥에 잘립니다.');
  assert.equal(wm.getAllWindowHwnds()[0], sidebar.getNativeWindowHandle().readBigUInt64LE().toString(),
    '키보드로 여는 메뉴도 다른 도구 창 앞에 표시되어야 합니다.');
  await sidebar.webContents.executeJavaScript(`document.getElementById('diary-btn').focus(); window.dispatchEvent(new MouseEvent('mousemove', {clientX:350,clientY:500})); interactiveToasts.add('keyboard-test'); interactiveToasts.remove('keyboard-test');`);
  await pause(350);
  assert.equal(sidebar.getBounds().width, 400, '하위 항목 탐색 중 투명 여백의 포인터 때문에 접힙니다.');
  assert.equal(sidebarIgnoresMouse, false);
  await sidebar.webContents.executeJavaScript(`document.getElementById('home-btn').focus()`);
  await eventually(() => sidebar.getBounds().width === 50 && sidebarIgnoresMouse);
  await sidebar.webContents.executeJavaScript(`document.querySelector('#cat-records .category-btn').focus()`);
  await eventually(() => sidebar.getBounds().width === 400);
  await sidebar.webContents.executeJavaScript(`window.dispatchEvent(new Event('blur'))`);
  await eventually(() => sidebar.getBounds().width === 50 && sidebarIgnoresMouse);
  // Subsequent visibility tests retain their original minimal page fixture.
  await sidebar.webContents.loadFile(markup);
  ipcMain.removeHandler('google-sync-get-status');
  ipcMain.removeAllListeners('set-ignore-mouse-events');
  ipcMain.removeAllListeners('apply-settings');
  ipcMain.removeHandler('apply-settings-confirmed');
  const sidebarHandle = sidebar.getNativeWindowHandle().readBigUInt64LE().toString();
  const nativeOrder = wm.getAllWindowHwnds();
  wm.setLauncherInteractive(sidebar, true);
  assert.equal(wm.getAllWindowHwnds()[0], sidebarHandle);
  wm.setLauncherInteractive(settings, true);
  assert.equal(wm.getAllWindowHwnds()[0], sidebarHandle, '일반 설정창이 런처 우선순위를 점유하면 안 된다.');
  wm.setLauncherInteractive(sidebar, false);
  assert.deepEqual(wm.getAllWindowHwnds(), nativeOrder);
  config.saveImmediate({ sidebarPosition: 'dock' });
  wm.syncOverlay(game);
  await loaded();
  // 배치 모드 전환은 독을 다시 생성한다. 이후 숨김/복원은 새 창을 기준으로 검사한다.
  dock = wm.getDockWindow();
  assert.equal(dock.isVisible(), false);
  await settings.webContents.executeJavaScript("document.getElementById('draft').value='저장하지 않은 설정'; document.getElementById('draft').setSelectionRange(2, 5)");
  const visibilityConfig = () => {
    const cfg = config.load();
    return [cfg.overlayVisible, cfg.chatOverlayEnabled, cfg.chatOverlaySubEnabled,
      cfg.chatOverlaySub2Enabled, cfg.contentsCheckerEnabled, cfg.sidebarPosition, cfg.shortcuts];
  };
  const beforeConfig = visibilityConfig();
  const ids = BrowserWindow.getAllWindows().map(win => win.id).sort();
  assert.equal(wm.toggleAllWindowsHidden(), true);
  assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()));
  wm.syncOverlay({ ...game, x: game.x + 15 });
  assert.ok(BrowserWindow.getAllWindows().every(win => !win.isVisible()), '폴링이 숨긴 창을 다시 표시함');
  assert.deepEqual(visibilityConfig(), beforeConfig, '일시 숨김이 영구 표시·단축키 설정을 바꿈');
  wm.sendPlaySound({ label: '숨긴 동안의 알림', soundFile: 'test.wav', isPreview: true });
  assert.ok(soundEvents.length > 0 && soundEvents.every(event => event.showToast === false));
  assert.equal(wm.openScamDetectorWindow(), false, '새 대화의 자동 열기가 전체 숨김을 해제함');
  assert.equal(wm.areAllWindowsHidden(), true);
  wm.hideAll({ preserveForResume: true }); // 실제 게임 최소화 경로
  assert.ok(!settings.isDestroyed() && !abbreviation.isDestroyed());
  wm.restoreUserHiddenWindows();
  assert.ok(settings.isVisible() && abbreviation.isVisible(), '독립 도구를 복원하지 못함');
  assert.ok(chats.every(win => !win.isVisible()) && !hud.isVisible(), '게임 최소화 중 게임 부착 창을 복원함');
  wm.syncOverlay(game);
  assert.ok(chats.every(win => win.isVisible()) && hud.isVisible());
  assert.equal(dock.isVisible(), false, '숨기기 전 숨겨진 독까지 복원함');
  assert.deepEqual(BrowserWindow.getAllWindows().map(win => win.id).sort(), ids, '숨김·복원이 renderer를 재생성함');
  assert.deepEqual(await settings.webContents.executeJavaScript(`(() => {const d=document.getElementById('draft');return [d.value,d.selectionStart,d.selectionEnd]})()`), ['저장하지 않은 설정', 2, 5]);
  wm.toggleDockWindow();
  assert.equal(dock.isVisible(), true, '명시적인 독 열기가 복원 제외에 막힘');

  wm.toggleAllWindowsHidden();
  abbreviation.close();
  await pause();
  wm.restoreUserHiddenWindows();
  assert.equal(wm.getAbbreviationWindow(), null, '숨긴 사이 닫힌 창을 재생성함');
  assert.equal(dock.isVisible(), true);

  // Loading completion after hide/restore must not add a window absent from the snapshot.
  wm.toggleBuffsWindow();
  const delayed = wm.getBuffsWindow() as BrowserWindow;
  wm.toggleAllWindowsHidden();
  wm.restoreUserHiddenWindows();
  await loaded();
  assert.equal(delayed.isVisible(), false, '늦게 도착한 ready-to-show가 원래 없던 창을 표시함');
  wm.toggleBuffsWindow();
  assert.equal(delayed.isVisible(), true);
  wm.toggleAllWindowsHidden();
  wm.toggleSettingsWindow();
  assert.equal(wm.areAllWindowsHidden(), false);
  assert.equal(wm.getSettingsWindow(), settings);
  assert.ok(trayUpdates > 0);

  // Production shortcut entry and tray menu wiring, without registering OS-wide test shortcuts.
  const registered = new Map<string, () => void>();
  config.saveImmediate({ shortcuts: { ...config.load().shortcuts, toggleAllWindows: 'CommandOrControl+Shift+Space' } });
  const shortcut = isolatedModule('shortcutManager', {
    electron: { globalShortcut: { unregisterAll: () => registered.clear(), register: (key: string, cb: () => void) => { registered.set(key, cb); return true; }, isRegistered: (key: string) => registered.has(key) } },
    './windowManager': wm, './tracker': { isGameOrAppForeground: () => true }, './chatLogProcessor': {},
    './buffTimerManager': {}, './abandonedTracker': {},
  });
  shortcut.registerAll();
  registered.get('CommandOrControl+Shift+Space')!();
  assert.equal(wm.areAllWindowsHidden(), true);
  registered.get('CommandOrControl+Shift+Space')!();
  assert.equal(wm.areAllWindowsHidden(), false);

  // Actual production IPC + renderer and native window sizing, with a controllable persistence boundary.
  let failSave = false, releaseSave: (() => void) | undefined;
  let saveDelay: Promise<void> | undefined;
  let replyDelay: Promise<void> | undefined;
  const ipcSource = fs.readFileSync(path.join(root, 'src/modules/ipcHandlers.ts'), 'utf8');
  const collapseHandler = ipcSource.match(/  ipcMain\.handle\('contents-collapse'[\s\S]*?\n  \}\);/)![0];
  vm.runInThisContext(`(function(ipcMain,wm,isBoolean){${ts.transpileModule(collapseHandler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}})`)(ipcMain, wm, (value: unknown) => typeof value === 'boolean');
  ipcMain.handle('apply-settings-confirmed', async (_event, patch) => {
    await saveDelay;
    if (failSave) return { success: false };
    const result = { success: wm.applySettings(patch) };
    await replyDelay;
    return result;
  });
  wm.toggleContentsCheckerWindow();
  await loaded();
  let checklist = wm.getContentsCheckerWindow() as BrowserWindow;
  await eventually(() => checklist.isVisible());
  const originalHtml = path.join(root, 'dist/contents-checker.html');
  // Load every production script: a stripped page hides competing config-data subscriptions.
  ipcMain.handle('google-sync-get-status', () => null);
  ipcMain.handle('check-chat-log-status', () => ({ status: 'ok' }));
  await BrowserWindow.prototype.loadFile.call(checklist, originalHtml);
  const js = (source: string) => checklist.webContents.executeJavaScript(source);
  const sendConfig = () => checklist.webContents.send('config-data', config.load());
  const age = () => js(`document.activeElement?.blur(); document.documentElement.dispatchEvent(new PointerEvent('pointerleave')); window.__now ||= Date.now; window.__offset = (window.__offset || 0) + 20000; Date.now = () => window.__now() + window.__offset; true`);
  sendConfig();
  await age(); await pause(650);
  assert.equal(await js("document.body.classList.contains('contents-collapsed')"), false, '기본 꺼짐');
  await js("document.getElementById('add-form').classList.add('show'); document.getElementById('contents-auto-collapse').click()");
  await eventually(() => config.load().contentsAutoCollapse === true);
  await pause(100);
  assert.equal(await js("document.getElementById('contents-auto-collapse-status').textContent"), '');
  await age(); await pause(650);
  assert.equal(await js("document.body.classList.contains('contents-collapsed')"), false, '관리 중 접힘');
  await js("document.getElementById('add-form').classList.remove('show'); document.getElementById('search-input').value='검색 초안'");
  const expandedHeight = checklist.getBounds().height;
  await age();
  await eventually(() => checklist.getBounds().height === 56);
  assert.equal(wm.captureActivityLayout().settings.contentsCheckerHeight, expandedHeight, '프리셋에 접힌 높이 저장');
  assert.notEqual(config.load().contentsCheckerHeight, 56);
  // Opening a real DOM selection modal expands the native window and retains the query.
  await js("document.getElementById('pending-modal').classList.remove('hidden')");
  await eventually(() => checklist.getBounds().height > 56);
  await age(); await pause(650);
  assert.equal(await js("document.body.classList.contains('contents-collapsed')"), false, '캐릭터 선택 중 접힘');
  assert.equal(await js("document.getElementById('search-input').value"), '검색 초안');
  await js("document.getElementById('pending-modal').classList.add('hidden'); document.getElementById('search-input').focus()");
  await pause(650);
  assert.equal(checklist.getBounds().height, expandedHeight, '입력 중 접힘');
  // Failed and delayed option saves preserve the confirmed setting and block collapse.
  failSave = true;
  await js("document.getElementById('add-form').classList.add('show'); document.getElementById('contents-auto-collapse').click()");
  await pause(150);
  assert.equal(config.load().contentsAutoCollapse, true);
  assert.equal(await js("document.getElementById('contents-auto-collapse').checked"), true);
  failSave = false;
  saveDelay = new Promise(resolve => { releaseSave = resolve; });
  await js("document.getElementById('contents-auto-collapse').click(); document.getElementById('add-form').classList.remove('show')");
  await age(); await pause(650);
  assert.equal(checklist.getBounds().height, expandedHeight);
  releaseSave!(); saveDelay = undefined;
  await eventually(() => config.load().contentsAutoCollapse === false);
  await pause(100);
  // Another window changes the saved value after persistence but before the old reply arrives.
  replyDelay = new Promise(resolve => { releaseSave = resolve; });
  await js("document.getElementById('add-form').classList.add('show'); document.getElementById('contents-auto-collapse').click()");
  await eventually(() => config.load().contentsAutoCollapse === true);
  config.saveConfirmed({ contentsAutoCollapse: false }); sendConfig();
  await pause(100);
  releaseSave!(); replyDelay = undefined;
  await pause(100);
  assert.equal(await js("document.getElementById('contents-auto-collapse').checked"), false, '늦은 저장 응답이 다른 창의 최신 설정을 덮음');

  // Expanding near the screen bottom may reposition the window, but must not overwrite user placement/size.
  config.saveConfirmed({ contentsAutoCollapse: true }); sendConfig();
  await js("document.getElementById('add-form').classList.remove('show'); document.activeElement?.blur()");
  assert.equal(await js('electronAPI.setContentsCollapsed(true)'), true);
  const currentArea = screen.getDisplayMatching(checklist.getBounds()).workArea;
  checklist.setPosition(currentArea.x + 40, currentArea.y + currentArea.height - 56);
  await pause(250);
  const savedPosition = structuredClone(config.load().positions.contentsChecker);
  const savedHeight = config.load().contentsCheckerHeight;
  assert.equal(await js('electronAPI.setContentsCollapsed(false)'), true);
  await pause(250);
  assert.deepEqual(config.load().positions.contentsChecker, savedPosition, '펼침 시 화면 보정이 저장 위치를 덮음');
  assert.equal(config.load().contentsCheckerHeight, savedHeight, '일시적인 펼침 크기가 저장 높이를 덮음');
  checklist.setSize(500, 700);
  await eventually(() => config.load().contentsCheckerHeight === 700);

  // Keep screenshots of the product settings control and collapsed header for visual inspection.
  const output = path.join(root, 'output/companion-replan-2026-09-20/phase2-screens');
  fs.mkdirSync(output, { recursive: true });
  async function capture(win: BrowserWindow, name: string): Promise<void> {
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    let frame!: Electron.NativeImage;
    for (let n = 0; n < 3; n++) {
      await pause(100);
      frame = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('paint timeout')), 3000);
        win.webContents.once('paint', (_event, _rect, image) => { clearTimeout(timer); resolve(image); });
        win.webContents.invalidate();
      });
    }
    fs.writeFileSync(path.join(output, name), frame.toPNG());
  }
  await js("document.getElementById('add-form').classList.add('show')");
  await capture(checklist, 'contents-auto-collapse-setting.png');
  checklist.setSize(400, 300); await pause(150);
  const formVisible = await js(`(() => {
    const form = document.getElementById('add-form');
    form.scrollTop = form.scrollHeight;
    const button = form.querySelector('button:last-child');
    const rect = form.getBoundingClientRect();
    return {scrollable:form.scrollHeight > form.clientHeight,inside:rect.bottom <= innerHeight + 1 && rect.top >= 0};
  })()`);
  assert.deepEqual(formVisible, { scrollable: true, inside: true }, '작은 창에서 숙제 관리 폼이 잘림');
  await capture(checklist, 'contents-narrow-management.png');
  checklist.setSize(500, 700); await pause(100);
  config.saveConfirmed({ contentsAutoCollapse: true }); sendConfig();
  await js("document.getElementById('add-form').classList.remove('show')"); await age();
  await eventually(() => checklist.getBounds().height === 56);
  await capture(checklist, 'contents-collapsed.png');
  const collapsedShare = { contentsCheckerWidth: 480, contentsCheckerHeight: 620 };
  assert.equal(wm.applySettings(collapsedShare), true); wm.applySharedWindowLayout(collapsedShare);
  assert.equal(checklist.getBounds().height, 56, '공유 배치가 접힌 숙제창을 펼침');
  await js("document.getElementById('contents-expand').click()");
  await eventually(() => checklist.getBounds().height > 56);
  assert.equal(checklist.getBounds().height, 620, '펼친 숙제창에 공유 크기가 반영되지 않음');

  // Use the complete production page, including its actual management-button handler.
  // DOM .click() skips pointer entry and missed the button replacement during hover expansion.
  // Recreate through the real manager and exercise pointer/keyboard input in a native focused window.
  wm.toggleContentsCheckerWindow();
  await eventually(() => wm.getContentsCheckerWindow() === null);
  nativeNextWindow = true;
  wm.toggleContentsCheckerWindow();
  await loaded();
  checklist = wm.getContentsCheckerWindow();
  await BrowserWindow.prototype.loadFile.call(checklist, originalHtml);
  sendConfig(); await pause(150);
  assert.equal(await js("document.getElementById('contents-auto-collapse').checked"), true,
    '저장된 자동 접기 설정이 재개방한 실제 페이지에 반영되지 않음');
  const pointer = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => {
    checklist.webContents.sendInputEvent({ type, x, y, ...(type === 'mouseMove' ? {} : { button: 'left' as const, clickCount: 1 }) });
  };
  const collapseForPointer = async () => {
    pointer('mouseMove', -10, -10);
    await pause(50);
    await age();
    await eventually(() => checklist.getBounds().height === 56);
    await pause(100);
  };
  const center = (selector: string) => js(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  await collapseForPointer();
  const expandPoint = await center('#contents-expand');
  pointer('mouseMove', expandPoint.x, expandPoint.y);
  await pause(150);
  pointer('mouseDown', expandPoint.x, expandPoint.y);
  pointer('mouseUp', expandPoint.x, expandPoint.y);
  await eventually(() => checklist.getBounds().height === 620);
  await pause(250);
  assert.equal(await js("document.getElementById('add-form').classList.contains('show')"), false,
    '펼치기 클릭이 호버로 교체된 관리 버튼까지 실행함');
  // Entering the controls and then moving into the title must still expand without a click.
  await collapseForPointer();
  pointer('mouseMove', expandPoint.x, expandPoint.y);
  await pause(150);
  assert.equal(checklist.getBounds().height, 56, '버튼 위에서는 클릭 대상을 유지해야 함');
  pointer('mouseMove', 90, expandPoint.y);
  await eventually(() => checklist.getBounds().height === 620);
  assert.equal(await js("document.getElementById('add-form').classList.contains('show')"), false);
  // After expansion the normal management control must remain usable.
  const editPoint = await center('#btn-edit');
  pointer('mouseMove', editPoint.x, editPoint.y);
  pointer('mouseDown', editPoint.x, editPoint.y);
  pointer('mouseUp', editPoint.x, editPoint.y);
  await pause(250);
  assert.equal(await js("document.getElementById('add-form').classList.contains('show')"), true);
  await js("document.getElementById('btn-edit').click()");
  await collapseForPointer();
  checklist.focus();
  await eventually(() => checklist.isFocused());
  await js("document.getElementById('contents-expand').focus()");
  assert.equal(await js("document.activeElement.id"), 'contents-expand');
  checklist.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  checklist.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  checklist.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await eventually(() => checklist.getBounds().height === 620);
  assert.equal(await js("document.getElementById('add-form').classList.contains('show')"), false,
    '키보드 펼치기가 관리 모드를 실행함');
  await collapseForPointer();
  const closePoint = await center('.win-close-btn');
  pointer('mouseMove', closePoint.x, closePoint.y);
  await pause(150);
  assert.equal(checklist.getBounds().height, 56, '닫기 전에 호버가 창을 펼침');
  ipcMain.once('toggle-contents-checker', () => wm.toggleContentsCheckerWindow());
  pointer('mouseDown', closePoint.x, closePoint.y);
  pointer('mouseUp', closePoint.x, closePoint.y);
  await eventually(() => checklist.isDestroyed());

  const settingsFile = path.join(fixture, 'settings-controls.html');
  const settingsSource = path.join(root, 'dist/settings.html');
  fs.writeFileSync(settingsFile, fs.readFileSync(settingsSource, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(settingsSource).href}">`));
  await BrowserWindow.prototype.loadFile.call(settings, settingsFile);
  await settings.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'dist/assets/tailwind.min.js'), 'utf8'));
  await settings.webContents.executeJavaScript(`const shortcutsSection=document.getElementById('section-shortcuts'); shortcutsSection.classList.remove('hidden');document.body.replaceChildren(shortcutsSection);`);
  await settings.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'dist/assets/lucide.min.js'), 'utf8'));
  await settings.webContents.executeJavaScript('lucide.createIcons()');
  await settings.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'dist/renderer/settings/shortcuts.js'), 'utf8'));
  await settings.webContents.executeJavaScript(`settingsShortcuts.mergeShortcuts({toggleAllWindows:'CommandOrControl+Shift+Space'});settingsShortcuts.renderInputs();resetShortcut('toggleAllWindows');`);
  assert.equal(await settings.webContents.executeJavaScript("document.getElementById('shortcut-toggleAllWindows').value"), '', '기본 미지정으로 초기화 실패');
  await capture(settings, 'all-windows-shortcut.png');
  // A hide session begun while the game was already minimized must not permanently suppress the HUD.
  wm.hideAll({ preserveForResume: true });
  await eventually(() => wm.getSettingsWindow() === null);
  wm.toggleSettingsWindow(); await loaded();
  await eventually(() => wm.getSettingsWindow()?.isVisible() === true);
  wm.toggleAllWindowsHidden();
  wm.restoreUserHiddenWindows();
  assert.equal(hud.isVisible(), false);
  wm.syncOverlay(game);
  assert.equal(hud.isVisible(), true, '최소화 중 시작한 전체 숨김 이후 HUD가 영구히 숨겨짐');
  assert.ok(chats.every(win => win.isVisible()));
  // Complete manager opt-in wiring, with real native windows and production position saving.
  for (const win of BrowserWindow.getAllWindows()) if (!chats.includes(win)) win.hide();
  chats[2].hide();
  const moving = chats[0], peer = chats[1];
  peer.setPosition(area.x + 700, area.y + 200); await pause(180);
  const moveNearPeer = async () => {
    moving.emit('will-move', {} as Electron.Event, moving.getBounds());
    moving.setPosition(peer.getBounds().x - moving.getBounds().width - 8 + 4, peer.getBounds().y + 4);
    await pause(30); moving.emit('moved'); await pause(180);
  };
  assert.equal(config.load().windowSnapEnabled, false);
  await moveNearPeer();
  assert.equal(moving.getBounds().x, peer.getBounds().x - moving.getBounds().width - 4, '기본 꺼짐인데 창이 맞춰짐');
  wm.applySettings({ windowSnapEnabled: true });
  moving.setPosition(area.x + 40, area.y + 70); await pause(180);
  await moveNearPeer();
  assert.equal(moving.getBounds().x, peer.getBounds().x - moving.getBounds().width - 8, '창 관리자의 정렬 옵션이 적용되지 않음');
  assert.equal(config.load().fixedWindowPositions.chatOverlay.x, moving.getBounds().x, '맞춘 최종 좌표가 저장되지 않음');
  const beforeShare = BrowserWindow.getAllWindows().map(win => ({ id: win.id, visible: win.isVisible() }));
  const sharedLayout = { positions: { ...config.load().positions, chatOverlay: { offsetX: 90000, offsetY: 90000 } }, chatOverlayWidth: 9000, chatOverlayHeight: 9000 };
  assert.equal(wm.applySettings(sharedLayout), true);
  wm.applySharedWindowLayout(sharedLayout);
  const sharedBounds = moving.getBounds();
  assert.ok(sharedBounds.x >= area.x && sharedBounds.y >= area.y && sharedBounds.x + sharedBounds.width <= area.x + area.width && sharedBounds.y + sharedBounds.height <= area.y + area.height, '공유 배치가 현재 작업 영역을 벗어남');
  assert.deepEqual(BrowserWindow.getAllWindows().map(win => ({ id: win.id, visible: win.isVisible() })), beforeShare, '공유 적용이 열림/숨김 상태를 바꿈');
  assert.equal(await moving.webContents.executeJavaScript(`document.getElementById('draft').value`), '작성 중인 내용', '공유 배치가 renderer를 다시 만듦');
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  config.saveImmediate();
  console.log('Window visibility + auto collapse: native lifecycle, drafts, game resume, late loading, notifications, shortcuts, busy UI, failed/delayed save, preset size and product screenshots passed.');
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
