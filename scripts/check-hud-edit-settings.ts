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

async function checkSelectTheme(): Promise<void> {
  const dist = path.join(root, 'dist');
  const pages = fs.readdirSync(dist).filter(file => file.endsWith('.html') && (
    /<select\b/.test(fs.readFileSync(path.join(dist, file), 'utf8')) || ['trade.html', 'gallery.html'].includes(file)
  ));
  for (const file of pages) {
    const html = fs.readFileSync(path.join(dist, file), 'utf8');
    assert.match(html, /<link[^>]+href="style\.css"/, `${file} 공통 드롭다운 스타일 누락`);
    assert.match(html, /<script[^>]+src="assets\/ui-utils\.js"/, `${file} 드롭다운 Esc 처리 누락`);
  }

  const win = new BrowserWindow({ show: false, width: 620, height: 550,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(dist, 'alarm-history.html'));
    const js = (code: string) => win.webContents.executeJavaScript(code);
    assert.deepEqual(await js(`(() => {
      const field = document.getElementById('alarm-log-filter');
      window.selectChanges = [];
      field.addEventListener('change', () => window.selectChanges.push(field.value));
      const picker = getComputedStyle(field, '::picker(select)');
      return [getComputedStyle(field).appearance, picker.appearance, picker.backgroundColor, picker.borderRadius];
    })()`), ['base-select', 'base-select', 'rgb(18, 18, 28)', '12px']);
    const open = async () => {
      await win.webContents.executeJavaScript("(() => { const field = document.getElementById('alarm-log-filter'); field.focus(); field.showPicker(); })()", true);
      await until(win, "Boolean(document.querySelector('#alarm-log-filter:open'))");
    };
    const press = (keyCode: string) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    };
    await open();
    if (process.argv.includes('--capture')) {
      fs.mkdirSync(output, { recursive: true });
      const screenshot = await win.webContents.capturePage();
      assert.equal(screenshot.isEmpty(), false);
      fs.writeFileSync(path.join(output, 'alarm-history-dropdown.png'), screenshot.toPNG());
    }
    press('Escape');
    await until(win, "!document.querySelector('#alarm-log-filter:open')");
    assert.deepEqual(await js('window.selectChanges'), []);
    await js(`(() => {
      const unavailable = new Option('사용할 수 없음', 'unavailable');
      unavailable.disabled = true;
      document.getElementById('alarm-log-filter').add(unavailable, 1);
    })()`);
    await open();
    press('Down');
    press('Enter');
    await until(win, "document.getElementById('alarm-log-filter').value === 'boss'");
    assert.deepEqual(await js('window.selectChanges'), ['boss']);
    await js("document.getElementById('alarm-log-filter').add(new Option('추가 옵션', 'dynamic'), 2); true;");
    await open();
    const point = await js(`(() => {
      const bounds = document.querySelector('option[value=dynamic]').getBoundingClientRect();
      return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(win, "document.getElementById('alarm-log-filter').value === 'dynamic'");
    assert.deepEqual(await js('window.selectChanges'), ['boss', 'dynamic']);
    press('Escape');
    for (let attempt = 0; attempt < 150 && !win.isDestroyed(); attempt++) await pause(30);
    assert.equal(win.isDestroyed(), true, '드롭다운을 닫은 뒤 Esc는 창을 닫아야 합니다.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  console.log(`Shared dropdown theme: ${pages.length} app pages, themed picker, keyboard and dynamic option selection passed.`);
}
function install(name: string, value: unknown): void {
  const filename = path.join(root, 'dist/modules', `${name}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: value } as NodeModule;
}

async function main(): Promise<void> {
  await app.whenReady();
  if (process.argv.includes('--dropdown-theme')) return checkSelectTheme();
  if (!process.argv.includes('--settings-links')) await checkSelectTheme();
  fs.mkdirSync(output, { recursive: true });
  const tasks: Promise<void>[] = [], mouse = new Map<number, boolean>();
  const tracker = { isGameRunning: () => true, getGameHwnd: () => null,
    canAutomaticallyRestoreGameFocus: () => false, isGameOrAppForeground: () => false,
    reconcileGameZOrder() {}, focusGameWindow: () => false, restoreGameAfterOwnedWindowClose() {} };
  install('tracker', tracker);
  // Full product HTML, preload, IPC, config persistence, settings/share and windowManager.
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
  // 프로필 선택 대기처럼 메인이 오늘 요약을 제공하지 않는 상태를 재현한다.
  let todaySummaryUnavailable = false;
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, handler) => handle(name, async (...args) => {
    if (name === 'today-summary-get' && todaySummaryUnavailable) return null;
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
  if (process.argv.includes('--settings-links')) {
    const routes: Record<string, Array<[string, string]>> = {
      'diary': [['[onclick="openLootSettingsDirect()"]', '득템'], ['[onclick="openDataSettingsDirect()"]', '일지 보관']],
      'contents-checker': [['#btn-sound-settings', '기능별 음량'], ['#checklist-cloud-sync-status', 'Google 동기화']],
      'welcome-guide': [
        ['[onclick="openGeneralSettingsDirectly()"]', '배치'],
        ['[onclick="openGameOverlaySettingsDirectly()"]', 'HUD 위치'],
        ['[onclick="openTodaySummarySettingsDirectly()"]', '오늘 요약'],
        ['[onclick="openSoundSettingsDirectly()"]', '기능별 음량'],
        ['[onclick="openChatlogSettingsDirectly()"]', '연결'],
        ['[onclick="openHistoricalChatSyncSettingsDirectly()"]', '과거 로그 복원'],
        ['[onclick="openShortcutsSettingsDirectly()"]', '앱 조작'],
      ],
      'xp-hud': [['button[onclick*="display:game-overlay"]', 'HUD 위치']],
      'buff-timer': [['button[onclick*="display:game-overlay"]', 'HUD 위치']],
      'magic-stone-calculator': [['button[onclick*="display:game-overlay"]', 'HUD 위치']],
      'boss-settings': [['#boss-global-notification-link', '공통 정책']],
      'pinned-note': [['#open-hud-position', 'HUD 위치']],
      'chat-overlay': [['#btnSettings', '창 구성']],
      'word-alarm': [['[onclick="goToChatLogSettings()"]', '연결']],
      'shout-history': [['button[onclick*="toggleSettings"]', '연결']],
    };
    const openSource = async (name: string) => {
      const source = new (Native as unknown as typeof BrowserWindow)({ width: 900, height: 720 });
      await source.loadFile(path.join(root, 'dist', name + '.html'));
      return source;
    };
    const getSettings = (): electron.BrowserWindow | null => wm.__probe.registry.settings.ref;
    const click = (source: electron.BrowserWindow, selector: string) => source.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).click(); true`,
    );
    let count = 0;
    for (const [name, buttons] of Object.entries(routes)) {
      const source = await openSource(name);
      for (const [selector, title] of buttons) {
        await until(source, `document.querySelector(${JSON.stringify(selector)})`);
        const prior = getSettings();
        // Make a broken link fail even if the preceding link shared its destination.
        if (prior) await prior.webContents.executeJavaScript("openSettingsPage('startup')");
        await click(source, selector);
        for (let attempt = 0; attempt < 100 && !getSettings(); attempt++) await pause(30);
        const settings = getSettings();
        assert.ok(settings, `${name}: settings window opened`);
        await until(settings, `document.getElementById('settings-page-title')?.textContent === ${JSON.stringify(title)}`);
        if (prior) assert.equal(settings, prior, '기존 설정 창을 재사용한다');
        count++;
      }
      if (!source.isDestroyed()) source.destroy();
    }
    const settings = getSettings()!;
    await until(settings, "document.querySelector('#menu-management-grid input') && document.getElementById('loading-overlay').classList.contains('fade-out')");
    for (const [width, height] of [[1100, 720], [800, 600]]) {
      settings.setContentSize(width, height);
      await until(settings, `innerWidth === ${width} && innerHeight === ${height}`);
      const navigationIssues = await settings.webContents.executeJavaScript(`
        (() => {
          const issues = [];
          const nav = document.querySelector('.nav-container');
          for (const [group, routes] of Object.entries(SETTINGS_NAV_GROUPS)) {
            const groupButton = nav.querySelector('[data-settings-group="' + group + '"]');
            groupButton.click();
            routes.forEach((route, index) => {
              const active = routes.length === 1 ? groupButton : nav.querySelector('[data-settings-route="' + group + ':' + index + '"]');
              active.click();
              const section = document.getElementById('section-' + route.section);
              if (![...section.querySelectorAll('button, input, select, textarea, a[href]')].some(control => control.getClientRects().length)) {
                issues.push(route.id + ': empty');
              }
              const item = active.getBoundingClientRect(), viewport = nav.getBoundingClientRect();
              if (active.getAttribute('aria-current') !== 'page' || item.top < viewport.top - 1 || item.bottom > viewport.bottom + 1) {
                issues.push({ route: route.id, selected: active.getAttribute('aria-current'), top: item.top, bottom: item.bottom, navTop: viewport.top, navBottom: viewport.bottom });
              }
              if (routes.length > 1) {
                const submenu = nav.querySelector('#settings-context-tabs').getBoundingClientRect();
                const header = groupButton.getBoundingClientRect();
                if (submenu.top - header.bottom < 6 || header.top < viewport.top - 1 || submenu.bottom > viewport.bottom + 1) {
                  issues.push({ route: route.id, header: header.top, submenu: submenu.bottom, navTop: viewport.top, navBottom: viewport.bottom });
                }
              }
            });
          }
          for (const item of getSearchItems()) {
            if (item.external || !item.targetId) continue;
            openSettingsSubTabDirectly(item.groupId, item.routeIndex);
            const target = document.getElementById(item.targetId);
            if (target?.closest('[hidden], .settings-section.hidden, .sub-tab-content:not(.active)')) {
              issues.push(item.title + ': target is hidden on its search page');
            }
          }
          openSettingsPage('chat-reading');
          const memo = document.getElementById('chat-nickname-notes-compact');
          const checked = memo.checked;
          memo.closest('label').click();
          if (memo.checked === checked || !memo.nextElementSibling.matches('.ui-switch-track')) issues.push('memo switch');
          memo.closest('label').click();
          if (!document.getElementById('settings-current-profile-server').textContent.trim()) issues.push('ETA server');
          const nativeCheckboxes = [...document.querySelectorAll('.settings-wrapper input[type="checkbox"]')]
            .filter(input => !input.closest('.ui-switch') && getComputedStyle(input).appearance !== 'none');
          if (nativeCheckboxes.length) issues.push('native checkbox style');
          return issues;
        })()
      `);
      assert.deepEqual(navigationIssues, [], '모든 설정 페이지에 콘텐츠가 있고 검색 결과와 선택 메뉴가 올바른 위치를 가리킨다.');
      await until(settings, "getComputedStyle(document.getElementById('loading-overlay')).visibility === 'hidden'");
      const search = await settings.webContents.executeJavaScript(`
        (() => {
          openSettingsPage('startup');
          const input = document.getElementById('settings-quick-search');
          input.focus();
          input.value = '에토스';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const result = document.querySelector('#settings-search-results .search-result-item');
          const title = result.firstElementChild.getBoundingClientRect();
          const category = result.lastElementChild.getBoundingClientRect();
          const menu = document.querySelector('#settings-context-tabs').getBoundingClientRect();
          const points = [title, category].map(rect => ({ x: Math.floor(rect.left + 10), y: Math.floor(rect.top + rect.height / 2) }));
          return {
            point: points[1],
            overlapsMenu: points.some(({ x, y }) => x >= menu.left && x < menu.right && y >= menu.top && y < menu.bottom),
            clickable: points.every(({ x, y }) => result.contains(document.elementFromPoint(x, y))),
            destination: getSearchItems().find(item => item.targetId === 'ethos-alert-enabled').category.split(' → ').at(-1),
          };
        })()
      `);
      assert.equal(search.overlapsMenu, true, `${width}x${height}: 검색 결과와 펼쳐진 메뉴가 겹치는 상황을 재현한다`);
      assert.equal(search.clickable, true, `${width}x${height}: 검색 결과 제목과 경로가 메뉴 위에서 클릭된다`);
      settings.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...search.point });
      settings.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...search.point });
      await until(settings, `document.getElementById('settings-page-title').textContent === ${JSON.stringify(search.destination)} && document.getElementById('settings-search-results').classList.contains('hidden')`);
      if (process.argv.includes('--capture')) {
        const captures = path.join(root, 'output', 'settings-navigation');
        fs.mkdirSync(captures, { recursive: true });
        const style = await settings.webContents.insertCSS('* { animation-duration: 0s !important; transition-duration: 0s !important; }');
        for (const page of ['hud-position', 'chat-reading', 'help', 'optimize']) {
          await settings.webContents.executeJavaScript(`openSettingsPage(${JSON.stringify(page)})`);
          await pause();
          const image = await settings.webContents.capturePage(undefined, { stayHidden: true });
          fs.writeFileSync(path.join(captures, `${page}-${width}.png`), image.toPNG());
        }
        await settings.webContents.removeInsertedCSS(style);
      }
    }
    await settings.webContents.executeJavaScript("openSettingsPage('hud-position')");
    await until(settings, "document.getElementById('btn-start-notif-edit').getClientRects().length > 0");
    await click(settings, '#btn-start-notif-edit');
    await until(settings, "document.getElementById('btn-cancel-notif-edit').getClientRects().length > 0");
    assert.equal(await settings.webContents.executeJavaScript("document.getElementById('settings-page-title').textContent"), 'HUD 위치');
    assert.equal(await settings.webContents.executeJavaScript("document.getElementById('btn-start-hud-edit').disabled && document.getElementById('btn-reset-hud-positions').disabled"), true);
    const notificationOverlay=wm.getGameOverlayWindow()!;
    const savedPosition={center:{x:0.25,y:0.25},buff:'default',hunting:'default',toast:'default'};
    await click(settings, '#btn-cancel-notif-edit');
    await until(settings, "!document.getElementById('btn-start-notif-edit').disabled && !document.getElementById('btn-start-hud-edit').disabled");
    assert.equal(config.saveConfirmed({notificationPositions:savedPosition}),true);
    await click(settings, '#btn-start-notif-edit');
    await until(notificationOverlay, "document.body.classList.contains('notification-edit-mode')");
    await click(notificationOverlay, '#notif-edit-reset');
    const finishRestore=config.beginExternalRestore();
    try {
      await click(settings, '#btn-save-notif-edit');
      await until(notificationOverlay, "document.getElementById('notif-edit-error').textContent.includes('저장하지 못했습니다')");
      assert.equal(await notificationOverlay.webContents.executeJavaScript("document.body.classList.contains('notification-edit-mode')"),true);
      assert.deepEqual(config.load().notificationPositions,savedPosition);
    } finally {finishRestore();}
    await click(settings, '#btn-save-notif-edit');
    await until(settings, "document.getElementById('notif-edit-status-badge').textContent.includes('위치 저장 완료')");
    assert.equal(config.load().notificationPositions.center,'default');
    assert.equal(config.saveConfirmed({notificationPositions:savedPosition}),true);
    const release=config.beginExternalRestore();
    try {
      await click(settings, '#btn-reset-notif-positions');
      await until(settings, "document.getElementById('notif-edit-status-badge').textContent.includes('초기화하지 못했습니다')");
      assert.deepEqual(config.load().notificationPositions,savedPosition);
    } finally {release();}
    await click(settings, '#btn-reset-notif-positions');
    await until(settings, "document.getElementById('notif-edit-status-badge').textContent.includes('기본 위치로 초기화됨')");
    assert.equal(config.load().notificationPositions.center,'default');
    await click(settings, '#btn-start-hud-edit');
    await until(settings, "document.getElementById('btn-cancel-hud-edit').getClientRects().length > 0");
    assert.equal(await settings.webContents.executeJavaScript("document.getElementById('btn-start-notif-edit').disabled && document.getElementById('btn-reset-notif-positions').disabled"), true);
    await click(settings, '#btn-cancel-hud-edit');
    await until(settings, "!document.getElementById('btn-start-notif-edit').disabled && !document.getElementById('btn-start-hud-edit').disabled");
    await settings.webContents.executeJavaScript("openSettingsPage('help')");
    const noticeData = JSON.parse(fs.readFileSync(path.join(root, 'src/assets/notice/notice.json'), 'utf8'));
    assert.equal(noticeData.version, require(path.join(root, 'package.json')).version);
    for (const closeButton of ['#close-btn', '#confirm-btn', 'Escape']) {
      await click(settings, 'button[onclick="openUpdateNotice()"]');
      for (let attempt = 0; attempt < 100 && !wm.getUpdateNoticeWindow(); attempt++) await pause(30);
      const notice: electron.BrowserWindow | null = wm.getUpdateNoticeWindow();
      assert.ok(notice);
      await until(notice, `document.getElementById('version-badge')?.textContent === ${JSON.stringify('v' + noticeData.version)} && document.querySelectorAll('#sections-container .section-card').length === ${noticeData.sections.length}`);
      assert.equal(await notice.webContents.executeJavaScript("document.getElementById('notice-summary').textContent"), noticeData.summary);
      if (closeButton === 'Escape') {
        await notice.webContents.executeJavaScript("setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), 0); true");
      } else {
        await notice.webContents.executeJavaScript(`setTimeout(() => document.querySelector(${JSON.stringify(closeButton)}).click(), 0); true`);
      }
      for (let attempt = 0; attempt < 100 && !notice.isDestroyed(); attempt++) await pause(30);
      assert.equal(notice.isDestroyed(), true, `${closeButton}로 공지창이 닫혀야 합니다.`);
      assert.equal(config.load().lastNoticeVersion, noticeData.version);
    }
    const offlineNotice = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await offlineNotice.loadFile(path.join(root, 'dist/update-notice.html'));
    await until(offlineNotice, "document.getElementById('notice-summary').textContent === '업데이트 공지를 불러오지 못했습니다.' && document.getElementById('version-badge').hidden");
    await offlineNotice.webContents.executeJavaScript("setTimeout(() => document.getElementById('close-btn').click(), 0); true");
    for (let attempt = 0; attempt < 100 && !offlineNotice.isDestroyed(); attempt++) await pause(30);
    assert.equal(offlineNotice.isDestroyed(), true, '공지 연결이 실패해도 창이 닫혀야 합니다.');
    getSettings()?.close();
    for (const name of ['trade', 'gallery']) {
      const source = await openSource(name);
      await click(source, '#guide-btn');
      for (let attempt = 0; attempt < 100 && !wm.__probe.registry[name].ref; attempt++) await pause(30);
      const monitor = wm.__probe.registry[name].ref;
      assert.ok(monitor);
      await until(monitor, "document.querySelector('dialog.monitor-preferences[open]')");
      assert.equal(getSettings(), null, '모니터 자체의 설정을 연다');
      source.destroy();
      monitor.destroy();
      count++;
    }
    console.log(`Settings shortcuts: ${count} source buttons through production preload, IPC and window manager passed.`);
    BrowserWindow.getAllWindows().forEach(win => win.destroy());
    return;
  }
  wm.__probe.create('settings', undefined, 'user-open'); wm.createGameOverlayWindow(); await Promise.all(tasks);
  let settings: electron.BrowserWindow = wm.__probe.registry.settings.ref;
  const hud: electron.BrowserWindow = wm.getGameOverlayWindow();
  hud.setSize(1200, 900);
  const js = (script: string) => settings.webContents.executeJavaScript(script);
  const hjs = (script: string) => hud.webContents.executeJavaScript(script);
  await until(settings, "window.lastConfig?.pinnedNoteText==='저장 배치 확인'");
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
  assert.equal(await js('typeof electronAPI.applyActivityPreset'),'undefined');
  const shareFile = path.join(fixture, 'hud-layout.json');
  electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: shareFile });
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shareFile] });
  assert.equal((await js("electronAPI.exportSettingsShare(['layout'])")).success, true);
  const applySettingsFromPanel = () => set(second);
  const share = async () => {
    await js("document.getElementById('settings-share-open').click();true");
    await until(settings, "!document.getElementById('settings-share-review').hidden && !document.getElementById('settings-share-compare').disabled");
    await js("document.getElementById('settings-share-compare').click();true");
    await until(settings, "!document.getElementById('settings-share-apply').disabled");
    await js("document.getElementById('settings-share-apply').click();true");
    await until(settings, "document.getElementById('settings-share-status').textContent.startsWith('설정을 적용했습니다')"); await pause();
  };
  for (const [name, apply] of [['settings', applySettingsFromPanel], ['share', share], ['other-window', () => set(second, true)]] as const) {
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
  await set({ ...first, ...off }); await live(false); await start(); await applySettingsFromPanel(); await live(true); await exit();
  assert.deepEqual(await visible(), Object.fromEntries(Object.keys(specs).map(id => [id, true])));
  results.push({ name: 'OFF to ON settings and live activation', visibility: await visible() });
  await start(); await set(off, true); await live(false); await exit();
  assert.deepEqual(await visible(), Object.fromEntries(Object.keys(specs).map(id => [id, false])));
  results.push({ name: 'ON to OFF and live completion', visibility: await visible() });
  // 편집 중 프로필 선택 대기로 요약이 사라져도 끌어 옮기던 HUD는 남고, 편집이 끝나면 최신 상태로 숨긴다.
  await set(first); await start();
  todaySummaryUnavailable = true;
  hud.webContents.send('play-profiles-changed', { enabled: true, profiles: [], activeProfileId: null, selectionRequired: true, busy: false });
  await pause();
  assert.equal((await visible())['today-summary-hud'], true, '편집 중 오늘 요약 HUD가 숨겨지면 안 됩니다.');
  await exit();
  assert.equal((await visible())['today-summary-hud'], false, '편집 종료 뒤 요약이 없는 상태를 반영해야 합니다.');
  todaySummaryUnavailable = false;
  results.push({ name: 'today summary availability change waits for edit end' });
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
  // Failed HUD save keeps the draft and input; cancel still uses the successful settings.
  await set(first); await start(); await applySettingsFromPanel();
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
  await set(first); await start(); await applySettingsFromPanel(); saved = false;
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
  console.log('HUD edit settings: full UI/settings/share/IPC/disk; all HUD coordinates, visibility/live state, failed/delayed writes, close/cancel/save and stale sessions passed.');
  BrowserWindow.getAllWindows().forEach(win => win.destroy());
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
