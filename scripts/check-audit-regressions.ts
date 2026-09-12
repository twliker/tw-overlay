/** 실제 저장·병합·네트워크 경계와 Electron DOM으로 2026-09 감사의 실패 조건을 고정한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import ts = require('typescript');

const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-audit-regressions-'));
app.setPath('userData', data);
app.on('window-all-closed', () => {});
const moduleFile = (name: string) => path.join(root, 'dist', 'modules', `${name}.js`);
const shared = (name: string) => require(path.join(root, 'dist', 'shared', `${name}.js`));
const silentLogger = { log() {} };
require.cache[moduleFile('logger')] = { exports: silentLogger } as NodeModule;
require.cache[moduleFile('windowManager')] = { exports: {
  applySettings: () => true, getScamDetectorWindow: () => null, getMainWindow: () => null,
} } as NodeModule;
require.cache[moduleFile('windowMessaging')] = { exports: {
  broadcastToAllWindows() {}, sendToAllWindowsByPage() {}, sendToFirstWindowByPage() {},
} } as NodeModule;

function isolatedModule(name: string, mocks: Record<string, any>, expose = '', globals: Record<string, any> = {}): any {
  const filename = moduleFile(name), local = { exports: {} };
  const nativeRequire = createRequire(filename);
  const names = Object.keys(globals);
  const wrapper = vm.runInThisContext(`(function(exports,require,module,__filename,__dirname${names.map(key => `,${key}`).join('')}){${fs.readFileSync(filename, 'utf8')}\n${expose}\n})`, { filename });
  wrapper(local.exports, (key: string) => Object.prototype.hasOwnProperty.call(mocks, key) ? mocks[key] : nativeRequire(key),
    local, filename, path.dirname(filename), ...Object.values(globals));
  return local.exports;
}

const config = require(moduleFile('config'));
const diary = require(moduleFile('diaryDb'));
const checker = require(moduleFile('contentsChecker'));
const helper = require(moduleFile('syncDataHelper'));
const defaults = require(moduleFile('constants')).DEFAULT_CONFIG;
const dateKey = shared('localDate').formatLocalDateKey;
const rule = { type: 'weekly', dayOfWeek: (new Date().getDay() + 5) % 7, hour: 0 };
const item = (id: string, count = 0, max = 3, completed = false): any => ({
  id, name: id, category: 'audit', isVisible: true, isCustom: true, resetRule: rule, maxCount: max,
  completedState: { main: { currentCount: count, isCompleted: completed, lastCompletedAt: Date.now() } },
});
const seed = (items: any[]) => config.saveImmediate({ characterPresets: [{ id: 'main', name: 'audit' }],
  selectedCharacterId: 'main', contentsCheckerItems: items, pendingHomeworks: [], lastContentsResetCheck: Date.now() });

function checkHomework(): void {
  diary.initDb();
  seed([item('custom-cap', 1, 1, true)]);
  checker.updateItem('custom-cap', 'custom-cap', 'audit', rule, 2);
  assert.equal(config.load().contentsCheckerItems[0].completedState.main.isCompleted, false);
  seed([item('custom-cap', 2, 3, false)]);
  checker.updateItem('custom-cap', 'custom-cap', 'audit', rule, 2);
  assert.equal(config.load().contentsCheckerItems[0].completedState.main.isCompleted, true);
  seed([item('custom-total', 0, 1)]);
  checker.toggleItem('custom-total', 'main');
  checker.toggleVisibility('custom-total');
  const stats = () => diary.getStmt('SELECT weekly_done,weekly_total FROM diaries WHERE date=?').get(dateKey());
  assert.deepEqual(stats(), { weekly_done: 0, weekly_total: 0 });
  checker.toggleVisibility('custom-total');
  checker.addCharacter('second');
  assert.deepEqual(stats(), { weekly_done: 1, weekly_total: 2 });
  checker.addCustomItem('added', 'audit', rule, 1);
  assert.equal(stats().weekly_total, 4);
  checker.removeItem('custom-total');
  assert.deepEqual(stats(), { weekly_done: 0, weekly_total: 2 });
  for (const action of ['toggle', 'count', 'exclude', 'pending']) {
    const previous = new Date(); previous.setDate(previous.getDate() - 1);
    const completed = item(`custom-previous-${action}`, 1, 1, true);
    completed.completedState.main.lastCompletedAt = previous.getTime();
    seed([completed]);
    const id = `${completed.id}_main`;
    diary.addHomeworkLog(dateKey(previous), id, 'audit', 'audit', 'weekly', previous.getTime());
    // 완료된 셀에서 '+'를 다시 눌러도 기존 완료 날짜는 바뀌지 않아야 한다.
    checker.updateItemCount(completed.id, 'main', 1);
    checker.updateItemCount(completed.id, 'main', 2); // UI/메인 양쪽의 최대 횟수 보정도 동일하다.
    config.saveImmediate({ pendingHomeworks: [{ id: completed.id, count: 1, isIncrement: true, timestamp: Date.now() }] });
    checker.applyPendingHomeworks('main');
    assert.deepEqual(config.load().pendingHomeworks, []);
    assert.equal(config.load().contentsCheckerItems[0].completedState.main.lastCompletedAt, previous.getTime());
    assert.equal(diary.getStmt('SELECT count(*) AS n FROM homework_logs WHERE content_id=?').get(id).n, 1);
    if (action === 'toggle') checker.toggleItem(completed.id, 'main');
    if (action === 'count') checker.updateItemCount(completed.id, 'main', 0);
    if (action === 'exclude') checker.toggleExcludeItem(completed.id, 'main');
    if (action === 'pending') {
      config.saveImmediate({ pendingHomeworks: [{ id: completed.id, count: 0, isIncrement: false, timestamp: Date.now() }] });
      checker.applyPendingHomeworks('main');
    }
    assert.equal(diary.getStmt('SELECT count(*) AS n FROM homework_logs WHERE content_id=?').get(id).n, 0);
  }
  const partial = item('custom-partial-noop', 1, 3);
  partial.completedState.main.lastCompletedAt = Date.now() - 60_000;
  seed([partial]);
  checker.updateItemCount(partial.id, 'main', 1);
  assert.equal(config.load().contentsCheckerItems[0].completedState.main.lastCompletedAt, partial.completedState.main.lastCompletedAt);
  checker.updateItemCount(partial.id, 'main', 3);
  assert.equal(config.load().contentsCheckerItems[0].completedState.main.isCompleted, true);
  // 관리 폼에서 초기화 요일과 최대 횟수를 동시에 변경한다. 만료된 완료 기록은 과거 일지에 남긴다.
  const now = new Date();
  const previous = new Date(now); previous.setDate(previous.getDate() - 2);
  const nextRule = { type: 'weekly', dayOfWeek: (now.getDay() + 6) % 7, hour: 0 };
  const oldRule = { type: 'weekly', dayOfWeek: (now.getDay() + 4) % 7, hour: 0 };
  for (const completed of [false, true]) {
    const changing = item(`custom-rule-and-cap-${completed}`, completed ? 3 : 2, 3, completed);
    changing.resetRule = oldRule;
    changing.completedState.main.lastCompletedAt = previous.getTime();
    seed([changing]);
    if (completed) diary.addHomeworkLog(dateKey(previous), `${changing.id}_main`, 'audit', 'audit', 'weekly', previous.getTime());
    assert.equal(checker.resetExpiredHomeworkItems([changing]).resetEntries.length, 0);
    assert.equal(checker.resetExpiredHomeworkItems([{ ...changing, resetRule: nextRule }]).resetEntries.length, 1);
    checker.updateItem(changing.id, changing.name, 'audit', nextRule, 2);
    checker.checkReset();
    const state = config.load().contentsCheckerItems[0].completedState.main;
    assert.equal(state.currentCount, 0);
    assert.equal(state.isCompleted, false);
    assert.equal(state.lastCompletedAt, undefined);
    const logs = diary.getStmt('SELECT date FROM homework_logs WHERE content_id=?').all(`${changing.id}_main`);
    assert.deepEqual(logs, completed ? [{ date: dateKey(previous) }] : []);
  }
  // 새 규칙에서도 유효한 진행도는 최대 횟수 감소로 정상 완료된다.
  const valid = item('custom-valid-rule-and-cap', 2, 3);
  valid.resetRule = oldRule;
  seed([valid]);
  checker.updateItem(valid.id, valid.name, 'audit', nextRule, 2);
  assert.equal(config.load().contentsCheckerItems[0].completedState.main.isCompleted, true);
  assert.deepEqual(diary.getStmt('SELECT date FROM homework_logs WHERE content_id=?').all(`${valid.id}_main`), [{ date: dateKey() }]);
  console.log('[AUDIT] homework count, structural statistics, previous-date undo passed');
}

function checkOrderingAndCalculators(): void {
  const a = item('custom-a'), b = item('custom-b');
  const base = { contentsCheckerItems: [a, b], characterPresets: [{ id: 'main', name: 'main' }, { id: 'second', name: 'second' }], pendingHomeworks: [] };
  const reordered = { ...base, contentsCheckerItems: [b, a], characterPresets: [...base.characterPresets].reverse() };
  const merged = helper.mergeChecklistThreeWay(base, { ...config.load(), ...base }, reordered);
  assert.deepEqual(merged.contentsCheckerItems.map((value: any) => value.id), ['custom-b', 'custom-a']);
  assert.deepEqual(merged.characterPresets.map((value: any) => value.id), ['second', 'main']);
  const operation = { id: 'reorder', deviceId: 'audit', createdAt: 1, keys: ['contentsCheckerItems', 'characterPresets'],
    mutations: helper.createChecklistOperationMutations(base, reordered), orders: helper.createChecklistOrderChanges(base, reordered) };
  assert.equal(helper.isValidChecklistOperation(operation), true);
  const replay = helper.replayChecklistOperations(base, [operation]);
  assert.deepEqual(replay, reordered);
  assert.deepEqual(helper.replayChecklistOperations(replay, [operation]), replay);
  const withRemoteProgress = structuredClone(base);
  withRemoteProgress.contentsCheckerItems[0].completedState.main.currentCount = 2;
  assert.equal(helper.replayChecklistOperations(withRemoteProgress, [operation]).contentsCheckerItems[1].completedState.main.currentCount, 2);
  assert.equal(helper.isValidChecklistOperation({ ...operation, orders: { contentsCheckerItems: { before: [], after: ['__proto__'] } } }), false);

  const sim = shared('equipmentSimulator');
  const options = { statType: 'stab', enhanceScrollCount: 0, initialBlessing: 1 };
  assert.equal(sim.calculateEnchantExpectation(options).expectedAttemptsPerSuccess, 1);
  const fresh = sim.calculateEnchantExpectation({ ...options, initialBlessing: 0 }).expectedAttemptsPerSuccess;
  assert.ok(Math.abs(sim.calculateEnchantExpectation(options, 2).expectedAttemptsPerSuccess * 2 - (1 + fresh)) < 1e-10);
  assert.equal(sim.calculateEnchantExpectation({ ...options, blessingGainOnFail: 0 }).expectedAttemptsPerSuccess, 1);
  const vianu = sim.calculateIncryptExpectation({ scrollType: 'vianu', protectionScrollCount: 0, scrollPrice: 10 }, 2);
  const expected = 1 / 0.0007 + 1 / 0.00065;
  assert.ok(Math.abs(vianu.expectedCostPerSuccess.scrollCount - expected) < 1e-8);
  assert.ok(Math.abs(vianu.expectedCostPerSuccess.itemCostSeed - expected * 10) < 1e-7);
  const later = sim.calculateIncryptExpectation({ scrollType: 'vianu', protectionScrollCount: 0, currentIncryptCount: 12 }, 2);
  assert.equal(later.expectedCostPerSuccess.scrollCount, 20_000);
  assert.equal(sim.runIncryptSimulation({ scrollType: 'vianu', protectionScrollCount: 0, currentIncryptCount: 1 }, 1, true, 1, () => 0.00068).successCount, 0);
  // 실행 시간 제한 안에서 실제 함수를 호출해 상한 없는 반복문 회귀가 테스트 전체를 멈추지 않게 한다.
  const boundedResult = vm.runInNewContext(`${fs.readFileSync(path.join(root, 'dist/shared/equipmentSimulator.js'), 'utf8')}
    module.exports.calculateIncryptExpectation({scrollType:'vianu',protectionScrollCount:0},1e20).expectedCostPerSuccess.scrollCount`,
  { module: { exports: {} } }, { timeout: 1000 });
  assert.equal(boundedResult, sim.calculateIncryptExpectation({ scrollType: 'vianu', protectionScrollCount: 0 }, 20).expectedCostPerSuccess.scrollCount);
  for (const [input, target] of [[0, 1], [-5, 1], [1.9, 1], [20, 20], [21, 20], [1e20, 20], [NaN, 1], [Infinity, 1], [-Infinity, 1]]) {
    const opts = { scrollType: 'eta', protectionScrollCount: 0 };
    assert.equal(sim.normalizeIncryptTargetSuccesses(input), target);
    assert.deepEqual(sim.calculateIncryptExpectation(opts, input), sim.calculateIncryptExpectation(opts, target));
  }
  console.log('[AUDIT] checklist order and calculator boundary cases passed');
}

const htmlPost = (no: number) => `<a href="/list?datanum=${no}">item-${no}</a>`;
function monitor(kind: 'gallery' | 'trade', fetch: (url: string) => Promise<string>, suppliedConfig?: any): any {
  const notices: any[] = [], status: any[] = [], delays: number[] = [];
  let cfg = suppliedConfig || { tradeServer: 'RyXp', tradeKeywords: ['aa', 'bb'], tradeNotify: true, galleryNotify: true };
  const configMock = { load: () => structuredClone(cfg), save: (patch: any) => Object.assign(cfg, patch) };
  const utils = require(moduleFile('webMonitorUtils'));
  const win = { isDestroyed: () => false, isVisible: () => false, webContents: { send: (...args: any[]) => status.push(args) } };
  const api = isolatedModule(`${kind}Monitor`, { './config': configMock, './logger': silentLogger,
    './desktopNotification': { showDesktopNotification: (value: any) => notices.push(value) },
    './webMonitorUtils': { ...utils, fetchTextWithSslRetry: fetch, waitRandomDelay: async () => undefined },
  }, `exports.auditSet=win=>{isRunning=true;lastSeenPostNo=config.load().${kind === 'trade' ? 'tradeLastSeen' : 'galleryLastSeen'}??100;notifyEnabled=true;${kind === 'trade' ? 'tradeKeywords=config.load().tradeKeywords||["aa","bb"];tradeWindowRef=win;' : 'galleryWindowRef=win;'}};
    exports.auditCheck=${kind === 'trade' ? 'checkKeywordsSearch' : 'checkNewPosts'};exports.auditLoop=doCheck;exports.auditState=()=>({lastSeenPostNo,consecutiveErrors});`,
  { setTimeout: (_callback: any, ms: number) => { delays.push(ms); return 1; }, clearTimeout() {} });
  api.auditSet(win);
  return { api, notices, status, delays, cfg, configMock };
}

async function checkMonitorsAndRuntime(): Promise<void> {
  let phase = 0;
  const trade = monitor('trade', async url => {
    if (url.includes('query=aa')) { if (phase === 0) throw new Error('offline'); return htmlPost(105); }
    return htmlPost(110);
  });
  assert.equal(await trade.api.auditCheck(), false);
  assert.equal(trade.api.auditState().lastSeenPostNo, 110);
  assert.deepEqual(trade.notices.map((notice: any) => notice.body), ['item-110']);
  assert.deepEqual(trade.cfg.tradeSearchState.cursors.map((cursor: any) => cursor.postNo), [100, 110]);
  phase = 1;
  assert.equal(await trade.api.auditCheck(), true);
  assert.deepEqual(trade.notices.map((notice: any) => notice.body).sort(), ['item-105', 'item-110']);
  await trade.api.auditCheck();
  assert.equal(trade.notices.length, 2);

  let latest = 110;
  const persistentFailure = monitor('trade', async url => {
    if (url.includes('query=aa')) throw new Error('persistent keyword failure');
    return htmlPost(latest);
  });
  await persistentFailure.api.auditCheck();
  latest = 115; await persistentFailure.api.auditCheck();
  assert.deepEqual(persistentFailure.notices.map((notice: any) => notice.body), ['item-110', 'item-115']);
  const progress = persistentFailure.cfg.tradeSearchState;
  assert.ok(config.sanitizeExternalConfigPatch({ tradeSearchState: progress }));
  assert.equal(config.sanitizeExternalConfigPatch({ tradeSearchState: { ...progress, cursors: [{ keyword: 'aa', postNo: -1, initialized: true }] } }), null);
  assert.equal(config.saveImmediate({ tradeSearchState: progress }), true);
  const reloadedConfig = isolatedModule('config', { './logger': silentLogger }).load();
  assert.deepEqual(reloadedConfig.tradeSearchState, progress);
  assert.equal(helper.extractSettingsSyncData(reloadedConfig).tradeSearchState, undefined);
  const restarted = monitor('trade', async url => url.includes('query=aa')
    ? htmlPost(105) + htmlPost(110) + htmlPost(115) : htmlPost(115),
  { ...structuredClone(persistentFailure.cfg), tradeSearchState: reloadedConfig.tradeSearchState });
  await restarted.api.auditCheck();
  assert.deepEqual(restarted.notices.map((notice: any) => notice.body), ['item-105']);
  assert.deepEqual(restarted.cfg.tradeSearchState.notifiedRanges, []);
  const restartedAgain = monitor('trade', async () => htmlPost(105) + htmlPost(110) + htmlPost(115), structuredClone(restarted.cfg));
  await restartedAgain.api.auditCheck(); assert.equal(restartedAgain.notices.length, 0);

  const stateHelper = shared('tradeSearchState');
  const bootstrap = stateHelper.createTradeSearchState(undefined, 'RyXp', ['aa', 'bb'], 0);
  assert.deepEqual(stateHelper.applyTradeSearchResult(bootstrap, 'aa', [], 0), []);
  assert.deepEqual(stateHelper.applyTradeSearchResult(bootstrap, 'bb', [110], 0), []);
  assert.deepEqual(stateHelper.applyTradeSearchResult(bootstrap, 'aa', [111], 110), [111]);
  const initialFailure = stateHelper.createTradeSearchState(undefined, 'RyXp', ['aa', 'bb'], 0);
  stateHelper.applyTradeSearchResult(initialFailure, 'bb', [110], 0);
  const bootstrapRestarted = stateHelper.createTradeSearchState(initialFailure, 'RyXp', ['aa', 'bb'], 110);
  assert.deepEqual(stateHelper.applyTradeSearchResult(bootstrapRestarted, 'aa', [109], 110), []);
  assert.deepEqual(stateHelper.applyTradeSearchResult(bootstrapRestarted, 'aa', [111], 110), [111]);
  const keywordEdit = stateHelper.createTradeSearchState(progress, 'RyXp', ['bb', 'cc'], 115);
  assert.deepEqual(keywordEdit.cursors.map((cursor: any) => [cursor.keyword, cursor.postNo]), [['bb', 115], ['cc', 115]]);
  assert.deepEqual(keywordEdit.notifiedRanges, []);
  const changedServer = stateHelper.createTradeSearchState(progress, 'Siwv', ['aa', 'bb'], 0);
  assert.deepEqual(changedServer.cursors.map((cursor: any) => cursor.postNo), [0, 0]);
  assert.deepEqual(changedServer.notifiedRanges, []);
  const manyPosts = monitor('trade', async () => [101, 102, 103, 104, 105].map(htmlPost).join(''));
  await manyPosts.api.auditCheck();
  assert.equal(manyPosts.notices.length, 4);
  assert.ok(manyPosts.notices[3].body.includes('외 2개'));
  const forced = monitor('trade', async url => { if (url.includes('cafesearch')) throw new Error('offline'); return htmlPost(110); });
  await forced.api.forceCheck();
  assert.equal(forced.api.auditState().lastSeenPostNo, 100);
  const unchanged = monitor('trade', async () => htmlPost(110));
  unchanged.api.setServer('RyXp'); await unchanged.api.auditCheck();
  assert.equal(unchanged.notices.length, 1);
  unchanged.api.setServer('Siwv');
  assert.equal(unchanged.api.auditState().lastSeenPostNo, 0);
  for (const kind of ['gallery', 'trade'] as const) {
    let fail = true;
    const instance = monitor(kind, async () => { if (fail) throw new Error('offline'); return ''; });
    for (let attempt = 0; attempt < 5; attempt++) await instance.api.auditLoop();
    assert.deepEqual(instance.delays, [360_000, 420_000, 540_000, 600_000, 600_000]);
    fail = false; await instance.api.auditLoop();
    assert.equal(instance.delays.at(-1), 300_000);
    assert.equal(instance.status.at(-1)[1], true);
    assert.equal(instance.api.auditState().consecutiveErrors, 0);
    instance.api.stop();
  }
  let current = { ...structuredClone(defaults), galleryNotify: false, tradeNotify: false, tradeKeywords: ['old'] };
  const sharedConfig = { load: () => structuredClone(current), save: (patch: any) => Object.assign(current, patch) };
  const runtimeGallery = monitor('gallery', async () => '', current).api;
  const runtimeTrade = monitor('trade', async () => '', current).api;
  runtimeGallery.setNotifyEnabled(false); runtimeTrade.setNotifyEnabled(false);
  let reloads = 0, autoStarts = 0, cleanups = 0, analyticsRefreshes = 0, lootRefreshes = 0;
  const autoStartCalls: Array<[boolean, boolean]> = [];
  const runtime = isolatedModule('runtimeSettings', { './galleryMonitor': runtimeGallery, './tradeMonitor': runtimeTrade,
    './shortcutManager': { reloadShortcuts: () => reloads++ }, './analytics': { analytics: { refreshEnabledState: () => analyticsRefreshes++, trackEvent() {} } },
    './autoStart': { setupAutoStart: (enabled: boolean, interactive: boolean) => {
      autoStarts++; autoStartCalls.push([enabled, interactive]);
    } }, './diaryDb': { cleanOldDiaryData: () => cleanups++ },
    './windowMessaging': { broadcastToAllWindows: () => lootRefreshes++ } });
  const previous = structuredClone(current);
  Object.assign(current, { galleryNotify: true, tradeNotify: true, tradeKeywords: ['new'], shortcuts: { ...current.shortcuts, toggleDock: 'F12' } });
  runtime.applyRuntimeSettings(previous, sharedConfig.load());
  assert.equal(runtimeGallery.getNotifyEnabled(), true);
  assert.equal(runtimeTrade.getNotifyEnabled(), true);
  assert.equal(reloads, 1);
  runtime.applyRuntimeSettings(sharedConfig.load(), sharedConfig.load());
  assert.equal(reloads, 1);
  const explicitPatch = { shortcuts: current.shortcuts, autoLaunch: false, diaryKeepDays: 180, analyticsEnabled: false, lootKeywords: [] };
  Object.assign(current, explicitPatch);
  runtime.applyRuntimeSettings(sharedConfig.load(), sharedConfig.load(), explicitPatch);
  assert.deepEqual([reloads, autoStarts, cleanups, analyticsRefreshes, lootRefreshes], [2, 1, 1, 1, 1]);
  runtime.applyRuntimeSettings(sharedConfig.load(), sharedConfig.load());
  runtime.applyRuntimeSettings(sharedConfig.load(), sharedConfig.load(), { opacity: current.opacity });
  assert.deepEqual([reloads, autoStarts, cleanups, analyticsRefreshes, lootRefreshes], [2, 1, 1, 1, 1]);
  current.tradeLastSeen = 100;
  const cloudApply = isolatedModule('cloudSyncManager', {
    './config': { ...sharedConfig, addConfigChangeListener() {}, saveImmediate: (patch: any) => { Object.assign(current, patch); return true; } },
    './syncDataHelper': { ...helper, createLocalBackupBeforeSync: () => true },
    './runtimeSettings': runtime, './contentsChecker': { init() {} },
    './windowManager': { applySettings: (patch: any) => Object.assign(current, patch) },
  }, 'exports.auditApply=applyConfigFromCloud;');
  await cloudApply.auditApply({ ...sharedConfig.load(), tradeServer: 'Siwv' });
  assert.equal(current.tradeLastSeen, 0, 'window refresh must preserve the runtime server cursor reset');
  assert.deepEqual(autoStartCalls, [[false, true]], '직접 저장한 자동 실행 설정은 Windows 제한 상태를 안내해야 합니다.');
  const disabledConfig = sharedConfig.load();
  const enabledConfig = { ...disabledConfig, autoLaunch: true };
  runtime.applyRuntimeSettings(disabledConfig, enabledConfig);
  runtime.applyRuntimeSettings(enabledConfig, disabledConfig);
  assert.deepEqual(autoStartCalls.slice(1), [[true, false], [false, false]],
    '동기화와 롤백의 자동 실행 적용이 사용자 대화상자를 띄우면 안 됩니다.');
  runtimeGallery.stop(); runtimeTrade.stop();
  console.log('[AUDIT] partial search, cursors, recovery, runtime refresh passed');
}

async function checkCloudConcurrency(): Promise<void> {
  const initialState = require(moduleFile('cloudSyncState')).load();
  const base = { ...structuredClone(defaults), googleSyncEnabled: true, googleSyncAutoSync: true, wordAlarmVolume: 40, volumeCalculators: 50 };
  let remote = helper.buildSettingsSyncPayload(base, 'base', 'audit-generation');
  const remoteBase = structuredClone(remote);
  const meta = { schemaVersion: 1, generationId: 'audit-generation', updatedAt: Date.now(), files: { settings: { id: 'settings', name: 'tw_overlay_settings.json' } } };
  const Conflict = require(moduleFile('googleDriveSync')).DriveWriteConflictError;
  let version = 1, initialUploads = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const drive = { SETTINGS_SYNC_FILE_NAME: 'tw_overlay_settings.json', CHECKLIST_SYNC_FILE_NAME: 'tw_overlay_checklist.json', META_SYNC_FILE_NAME: 'tw_overlay_sync_meta.json', DriveWriteConflictError: Conflict,
    listSyncFiles: async () => [{ id: 'settings', name: 'tw_overlay_settings.json' }, { id: 'meta', name: 'tw_overlay_sync_meta.json' }],
    getFileEtag: async () => String(version),
    downloadJsonPayload: async (id: string) => structuredClone(id === 'meta' ? meta : remote),
    uploadJsonPayload: async (_name: string, payload: any, id: string, etag: string) => {
      if (initialUploads++ < 2) { if (initialUploads === 2) release(); await barrier; }
      if (etag !== String(version)) throw new Conflict();
      remote = structuredClone(payload); version++; return id;
    }, cancelPendingRequests() {},
  };
  const make = (id: string, key: string, value: number) => {
    let cfg = { ...structuredClone(base), [key]: value };
    const state = { ...structuredClone(initialState), profileState: 'established', deviceId: id, generationId: 'audit-generation', remoteRevisions: { settings: remoteBase.revision }, settingsDirtyKeys: [key], baseSettings: remoteBase.data, checklistOutbox: [], confirmedChecklistOperations: [] };
    const manager = isolatedModule('cloudSyncManager', { './config': { load: () => structuredClone(cfg), hasPending: () => false, saveImmediate: (patch: any) => { cfg = { ...cfg, ...patch }; return true; }, addConfigChangeListener() {}, getLastSaveError: () => null },
      './cloudSyncState': { load: () => structuredClone(state), update: (fn: any) => { fn(state); return structuredClone(state); } },
      './googleDriveSync': drive, './googleAuth': { isLoggedIn: () => true, loadStoredProfile: () => null, setOnAuthInvalidated() {} },
      './syncDataHelper': { ...helper, createLocalBackupBeforeSync: () => true, getLocalSyncBackupInfo: () => ({ available: false }) },
      './contentsChecker': { init() {}, checkReset: () => false }, './runtimeSettings': { applyRuntimeSettings() {} },
    }, 'exports.auditUpload=uploadKinds;exports.auditReceive=receiveKind;');
    return { manager, config: () => cfg, state: () => state };
  };
  const A = make('A', 'wordAlarmVolume', 70), B = make('B', 'volumeCalculators', 80);
  const outcomes = await Promise.all([A.manager.auditUpload(['settings']), B.manager.auditUpload(['settings'])]);
  assert.equal(outcomes.every(result => result.success), true);
  assert.equal(remote.data.wordAlarmVolume, 70); assert.equal(remote.data.volumeCalculators, 80);
  await A.manager.auditReceive('settings', remote, false); await B.manager.auditReceive('settings', remote, false);
  assert.equal(A.config().wordAlarmVolume, 70); assert.equal(B.config().wordAlarmVolume, 70);
  assert.equal(A.config().volumeCalculators, 80); assert.deepEqual(A.state().settingsDirtyKeys, []);
  console.log('[AUDIT] two simultaneous settings writers converge without lost edits');
}

async function checkCloudRollback(): Promise<void> {
  let current = { ...structuredClone(defaults), googleSyncEnabled: true, tradeServer: 'RyXp', tradeNotify: false,
    galleryNotify: false, tradeKeywords: ['original'], shortcuts: { ...defaults.shortcuts, toggleDock: 'F11' } };
  const original = structuredClone(current);
  const state = { ...require(moduleFile('cloudSyncState')).load(), profileState: 'established', settingsDirtyKeys: [], checklistOutbox: [] };
  let changed = (_patch: any) => {}, failSave = false, reloads = 0;
  const cfg = { load: () => structuredClone(current), addConfigChangeListener: (listener: any) => { changed = listener; },
    save: (patch: any) => { Object.assign(current, patch); changed(patch); },
    saveImmediate: (patch: any) => { if (failSave) return false; Object.assign(current, patch); changed(patch); return true; },
    getLastSaveError: () => 'audit-save-failure' };
  const trade = isolatedModule('tradeMonitor', { './config': cfg });
  const gallery = isolatedModule('galleryMonitor', { './config': cfg });
  trade.updateWindows(null, null); gallery.updateWindows(null, null, null);
  const runtime = isolatedModule('runtimeSettings', { './tradeMonitor': trade, './galleryMonitor': gallery,
    './shortcutManager': { reloadShortcuts: () => reloads++ } });
  const windows: any[] = [];
  const cloud = isolatedModule('cloudSyncManager', { './config': cfg, './runtimeSettings': runtime,
    './cloudSyncState': { load: () => structuredClone(state), update: (fn: any) => { fn(state); return structuredClone(state); } },
    './googleAuth': { isLoggedIn: () => false, loadStoredProfile: () => null, setOnAuthInvalidated() {} },
    './contentsChecker': { init() {} }, './windowManager': { applySettings: (value: any) => { windows.push(structuredClone(value)); return true; } },
  }, 'exports.auditApply=applyConfigFromCloud;');
  const remote = { ...cfg.load(), tradeServer: 'Siwv', tradeNotify: true, galleryNotify: true,
    tradeKeywords: ['remote'], shortcuts: { ...current.shortcuts, toggleDock: 'F12' } };
  await cloud.auditApply(remote);
  assert.equal(trade.getServer(), 'Siwv'); assert.equal(trade.getNotifyEnabled(), true);
  assert.equal(gallery.getNotifyEnabled(), true); assert.equal(reloads, 1);
  assert.deepEqual(state.settingsDirtyKeys, [], 'cloud receive must not become a local edit');
  const backupBefore = fs.readFileSync(path.join(data, 'config.backup-sync.json'), 'utf8');
  failSave = true;
  assert.equal((await cloud.rollbackLastRestore()).success, false);
  assert.equal(trade.getServer(), 'Siwv'); assert.equal(reloads, 1); assert.equal(windows.length, 1);
  failSave = false;
  assert.equal((await cloud.rollbackLastRestore()).success, true);
  assert.equal(current.tradeServer, 'RyXp'); assert.equal(trade.getServer(), 'RyXp');
  assert.equal(trade.getNotifyEnabled(), false); assert.equal(gallery.getNotifyEnabled(), false);
  assert.deepEqual(current.tradeKeywords, original.tradeKeywords);
  assert.deepEqual(current.shortcuts, original.shortcuts); assert.equal(reloads, 2);
  assert.equal(windows.at(-1).tradeServer, 'RyXp'); assert.equal(windows.at(-1).tradeLastSeen, 0);
  assert.ok(state.settingsDirtyKeys.includes('tradeServer'), 'rollback must retain normal local dirty tracking');
  assert.equal(fs.readFileSync(path.join(data, 'config.backup-sync.json'), 'utf8'), backupBefore, 'rollback must preserve its source backup');
  trade.stop(); gallery.stop();
  console.log('[AUDIT] cloud rollback restores runtime, preserves backup and queues local changes');
}

async function checkHttpAndServer(): Promise<void> {
  const requests: any[] = [];
  const transport = isolatedModule('googleDriveSync', { './googleAuth': { getValidAccessToken: async () => 'test-token' } }, '', {
    fetch: async (url: string, options: any) => { requests.push({ url, options }); return new Response(JSON.stringify(url.includes('fields=etag') ? { etag: '"version-1"' } : { id: 'settings' })); },
  });
  const etag = await transport.getFileEtag('settings');
  await transport.uploadJsonPayload('tw_overlay_settings.json', {}, 'settings', etag);
  assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].options.headers.get('If-Match'), '"version-1"');
  assert.ok(requests[1].url.includes('/drive/v2/files/settings'));
  const failing = isolatedModule('googleDriveSync', { './googleAuth': { getValidAccessToken: async () => 'test-token' } }, '', {
    fetch: async () => new Response('changed', { status: 412 }),
  });
  await assert.rejects(failing.uploadJsonPayload('settings', {}, 'settings', '"old"'), failing.DriveWriteConflictError);
  const sslRequests: any[] = [];
  const httpsMock = { get(_url: string, options: any) {
    sslRequests.push(options); const request = new EventEmitter();
    queueMicrotask(() => request.emit('error', new Error('certificate verify failed'))); return request;
  } };
  const network = isolatedModule('webMonitorUtils', { https: httpsMock });
  await assert.rejects(network.fetchTextWithSslRetry('https://example.invalid', { headers: {}, timeoutMs: 100, onSslRetry() {} }), /certificate/);
  assert.equal(sslRequests.length, 1); assert.notEqual(sslRequests[0].rejectUnauthorized, false);

  const children: any[] = [];
  let healthy = true;
  const server = isolatedModule('scam/serverManager', { fs: { existsSync: () => true },
    http: { get(_url: string, options: any, callback: any) {
      const request: any = new EventEmitter(); request.destroy = (error: Error) => request.emit('error', error);
      options.signal.addEventListener('abort', () => request.emit('error', new Error('aborted')), { once: true });
      if (healthy) queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
      return request;
    } }, child_process: { spawn() { const child: any = new EventEmitter(); child.pid = 100 + children.length; child.kill = () => { child.killed = true; return true; }; children.push(child); return child; } },
    '../config': { load: () => ({ scamGpuVariant: 'cpu' }) }, './modelManager': { getModelPath: () => 'model', getServerBinaryPath: () => 'server', recoverInterruptedServerInstall: () => true, verifyInstalledModel() {}, verifyInstalledServerBinary() {} },
  });
  await Promise.all([server.startServer(), server.startServer()]);
  assert.equal(children.length, 1); server.stopServer(); assert.equal(children[0].killed, true);
  healthy = false;
  const canceled = server.startServer(); server.stopServer();
  await assert.rejects(canceled);
  healthy = true; await server.startServer();
  children[1].emit('exit', 0);
  assert.equal(server.getServerStatus(1).ready, true);
  server.stopServer(); assert.equal(children.every(child => child.killed), true);
  console.log('[AUDIT] conditional transport, TLS validation, server startup/cancellation passed');
}

async function checkSettingsDraft(): Promise<void> {
  const window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: true } });
  let hudConfig = structuredClone(defaults), hudSaveSucceeded = true, hudSender = true;
  const hudConfigStore = { load: () => structuredClone(hudConfig),
    saveImmediate: (patch: any) => { if (hudSaveSucceeded) Object.assign(hudConfig, patch); return hudSaveSucceeded; },
    sanitizeExternalConfigPatch: (patch: any) => config.sanitizeExternalConfigPatch(structuredClone(patch)), getLastSaveError: () => 'fixture save failure' };
  // 실제 설정 저장과 config-data 방송 함수까지 실행하고 플랫폼 창 조작만 격리한다.
  const wmSource = fs.readFileSync(path.join(root, 'src/modules/windowManager.ts'), 'utf8');
  const wmStart = wmSource.indexOf('export function applySettings(');
  const wmFixture: any = { exports: {}, config: hudConfigStore, mainWindow: null, overlayWindow: null, gameOverlayWindow: null,
    windowRegistry: { settings: { ref: window } }, buffTimerManager: { refreshConfig() {} }, physicalGameRect: null,
    require: () => ({ updateTrayMenu() {} }), log() {} };
  vm.runInNewContext(ts.transpileModule(wmSource.slice(wmStart, wmSource.indexOf('export function toggleClickThrough()', wmStart)),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, wmFixture);
  const ipcSource = fs.readFileSync(path.join(root, 'src/modules/ipcHandlers.ts'), 'utf8');
  const ipcStart = ipcSource.indexOf('  type ApplySettingsResult =');
  vm.runInNewContext(ts.transpileModule(ipcSource.slice(ipcStart, ipcSource.indexOf('  function broadcastChatLogStatus()', ipcStart)),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMain, config: hudConfigStore, isBoolean: (value: unknown) => typeof value === 'boolean',
    log() {}, applyRuntimeSettings() {}, broadcastChatLogStatus() {},
    wm: { getSettingsWindow: () => null, getGameOverlayWindow: () => hudSender ? window : null,
      applySettings: wmFixture.exports.applySettings },
  });
  ipcMain.handle('audit-hud-seed', (_event, next: any, success = true, sender = true) => {
    hudConfig = structuredClone(next); hudSaveSucceeded = success; hudSender = sender;
  });
  try {
    const source = fs.readFileSync(path.join(root, 'dist', 'settings.html'), 'utf8');
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(source.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link[^>]*>/gi, ''))}`);
    const start = source.indexOf('function initChatAndNicknameColorPickers(cfg)');
    const callback = source.slice(start, source.indexOf('// 초기화 실행', start));
    const binding = fs.readFileSync(path.join(root, 'dist/renderer/settings/config-binding.js'), 'utf8');
    const draft = fs.readFileSync(path.join(root, 'dist/renderer/settings/draft.js'), 'utf8');
    const collection = fs.readFileSync(path.join(root, 'dist/renderer/settings/form-collection.js'), 'utf8');
    const menus = fs.readFileSync(path.join(root, 'dist/renderer/settings/menu-management.js'), 'utf8');
    const saveStart = source.indexOf('async function applySettingsWithDraft(');
    const saveFunctions = source.slice(saveStart, source.indexOf('let isHudEditing', saveStart));
    const hudEditFunctions = source.slice(source.indexOf('let isHudEditing'), source.indexOf("window.addEventListener('beforeunload'", source.indexOf('let isHudEditing')));
    const hudEditMode = fs.readFileSync(path.join(root, 'dist/renderer/game-overlay/edit-mode.js'), 'utf8');
    const customSaveStart = source.indexOf('function getSettingsApplyErrorMessage(');
    const customSaveFunctions = source.slice(customSaveStart, source.indexOf('function hasPendingCustomChatTabDraft(', customSaveStart));
    const actual = await window.webContents.executeJavaScript(`(async () => {
      let lastConfig=null, _pickrsInitialized=false;
      let currentSlots=[], currentKeywords=[], tradeKeywordsList=[], lootKeywordsList=[], shoutKeywordsList=[], chatOverlayFilterList=[], customTabsList=[], hasCustomLootKeywords=false;
      const noop=()=>{}; let shortcuts={}, cfg;
      let save=async patch=>{cfg={...cfg,...structuredClone(patch)};return {success:true};};
      window.electronAPI={DEFAULT_CONFIG:${JSON.stringify(defaults)},onConfigData:cb=>window.__receive=cb,getAppVersion:async()=> 'audit',
        getConfig:async()=>structuredClone(cfg),applySettingsConfirmed:patch=>save(patch)};
      const alerts=[];window.alert=message=>alerts.push(message);
      window.hasPendingCustomChatTabDraft=()=>false;
      window.chatChannels={OVERLAY_BUILT_IN_TABS:[],OVERLAY_CHANNELS:[],OVERLAY_COLORS:{general:'#ffffff',whisper:'#aaaaaa'},COLORS:{nickname:'#cccccc'},COLOR_SWATCHES:[]};
      window.Pickr={create:opts=>{let value=opts.default;return {getColor:()=>({toHEXA:()=>({toString:()=>value})}),setColor:next=>value=next,destroyAndRemoveEl:noop,on:noop};}};
      for(const name of ['renderChatOverlayFilterList','renderCustomTabsList','validateSettingsChatLogPath','ensureContentsItems','ensureOptimizeStatus','toggleNicknameColorPickers','renderEditList','renderKeywordList','renderTradeKeywordList','renderLootKeywordList','renderShoutKeywordList','renderCustomSounds','hideLoading','updateEtaCacheStatusText','refreshIcons','ensureChatAndNicknameColorPickers'])window[name]=noop;
      window.settingsAudioControls={bindVolumeControl:noop};
      window.settingsShortcuts={getShortcuts:()=>shortcuts,mergeShortcuts:value=>{shortcuts={...shortcuts,...value};},renderInputs:noop};
      window.sidebarCategories=[{id:'audit',trayOrder:0,color:'white',icon:'book',label:'audit'}];
      ${menus}\n${binding}\n${draft}\n${collection}\n${callback}\n${saveFunctions}\n${customSaveFunctions}
      cfg={...window.electronAPI.DEFAULT_CONFIG,homeUrl:'https://saved.example/',width:800,height:600,quickSlots:[],shortcuts:{first:'F1',second:'F2'},tradeServer:'RyXp',sidebarPosition:'right',hiddenMenuIds:[]};
      window.__receive(cfg);
      // 실제 초기화처럼 첫 config 뒤 비동기로 메뉴 DOM을 준비한다.
      window.settingsMenuManagement.render([{id:'audit-first',category:'audit',label:'first'}, {id:'audit-second',category:'audit',label:'second'}],cfg);
      window.settingsDraft.initializeNewFields();
      initChatAndNicknameColorPickers(cfg);
      window.chatPickers.general.setColor('#123456');
      document.getElementById('home-url-input').value='https://edited.example/';
      currentSlots.push({label:'draft',url:'https://draft.example/'}); shortcuts.first='F3';
      document.querySelector('input[name="trade-server"][value="Siwv"]').checked=true;
      document.querySelector('input[name="sidebar-position"][value="left"]').checked=true;
      document.querySelector('.menu-visible-check[value="audit-first"]').checked=false;
      window.__receive({...cfg,width:900,shortcuts:{first:'F1',second:'F4'},chatOverlayColorGeneral:'#222222',chatOverlayColorWhisper:'#333333'});
      cfg={...cfg,width:950,hiddenMenuIds:['audit-second'],shortcuts:{first:'F1',second:'F5'},chatOverlayColorGeneral:'#444444',chatOverlayColorWhisper:'#555555'};
      window.__receive(cfg);
      const initial={home:document.getElementById('home-url-input').value,width:document.getElementById('width-input').value,slots:structuredClone(currentSlots),shortcuts:{...shortcuts},colors:collectSettingsDraftExtras().colors,
        server:document.querySelector('input[name="trade-server"]:checked').value,position:document.querySelector('input[name="sidebar-position"]:checked').value,hiddenMenus:window.settingsMenuManagement.collectHiddenMenuIds()};

      const font=document.getElementById('chat-overlay-fontsize-input');
      const setFont=value=>{font.value=String(value);font.dispatchEvent(new Event('input'));};
      setFont(20);lootKeywordsList=['saved-loot'];shoutKeywordsList=['saved-shout'];
      const size=document.getElementById('chat-overlay-width-input');size.value='600';size.dispatchEvent(new Event('input'));
      await applyChatOverlaySettingsOnly();
      const sizeClean=size.dataset.userEditedSinceLoad!== 'true';
      cfg={...cfg,chatOverlayFontSize:24,chatOverlayWidth:700,lootKeywords:['remote-loot'],shoutKeywords:['remote-shout'],chatOverlayColorGeneral:'#abcdef'};
      window.__receive(cfg);
      const afterSave={font:font.value,size:size.value,sizeClean,loot:[...lootKeywordsList],shout:[...shoutKeywordsList],color:collectSettingsDraftExtras().colors.chatPickers.general,
        home:document.getElementById('home-url-input').value,slots:structuredClone(currentSlots),shortcut:shortcuts.first};

      setFont(21);lootKeywordsList=['failed-loot'];
      save=async()=>({success:false,error:'save-failed'});
      await applyChatOverlaySettingsOnly();
      cfg={...cfg,chatOverlayFontSize:25,lootKeywords:['new-remote-loot']};window.__receive(cfg);
      const afterFailure={font:font.value,loot:[...lootKeywordsList],alerts:alerts.length};

      let sent,finish;const submitted=new Promise(resolve=>{sent=resolve;});
      save=patch=>{cfg={...cfg,...structuredClone(patch)};sent();return new Promise(resolve=>{finish=resolve;});};
      setFont(20);lootKeywordsList=['pending-loot'];
      const pending=applyChatOverlaySettingsOnly();await submitted;
      setFont(22);lootKeywordsList.push('typed-while-saving');size.value='800';size.dispatchEvent(new Event('input'));
      finish({success:true});await pending;
      cfg={...cfg,chatOverlayFontSize:26,lootKeywords:['after-save-remote'],chatOverlayWidth:900};window.__receive(cfg);
      const afterPending={font:font.value,loot:[...lootKeywordsList],size:size.value,sizeDirty:size.dataset.userEditedSinceLoad==='true'};

      save=async patch=>{cfg={...cfg,...structuredClone(patch)};return {success:true};};
      document.getElementById('today-summary-show-input').checked=false;
      await applyTodaySummaryHudSettingsOnly();
      cfg={...cfg,showTodaySummaryHud:true};window.__receive(cfg);
      const afterHud={visible:document.getElementById('today-summary-show-input').checked,font:font.value};
      const nextTabs=[{id:'custom-audit',name:'audit',channels:['general']}];
      if(await saveCustomChatTabs(nextTabs))customTabsList=nextTabs;
      cfg={...cfg,chatOverlayCustomTabs:[]};window.__receive(cfg);
      const tabsAfterRemote=structuredClone(customTabsList);
      const ipc=require('electron').ipcRenderer;
      let configReceived,configFailed;
      ipc.on('config-data',(_event,next,context)=>{
        try {cfg=next;window.__receive(next,context);configReceived?.();} catch(error) {configFailed?.(error);}
      });
      const waitForConfig=stage=>new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('HUD 저장 후 config-data 수신 시간 초과: '+stage)),5000);
        configReceived=()=>{clearTimeout(timeout);resolve();};configFailed=error=>{clearTimeout(timeout);reject(error);};
      });
      window.electronAPI.applySettings=patch=>ipc.send('apply-settings',patch);
      let receiveEdit;
      window.electronAPI.onGameOverlayEditMode=callback=>{receiveEdit=callback;};
      window.electronAPI.setGameOverlayEditMode=async(enabled,saveOnExit)=>{receiveEdit(enabled,saveOnExit);return true;};
      const hud=document.createElement('div');hud.id='today-summary-hud';
      hud.style.cssText='position:fixed;left:0px;top:200px;width:100px;height:20px';document.body.append(hud);
      ${hudEditMode}\n${hudEditFunctions}
      const x=document.getElementById('today-summary-pos-left');
      const dragTo=(from,to)=>{
        hud.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,clientX:from+5,clientY:205}));
        window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:to+5,clientY:205}));
        window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1}));
      };
      x.value='300';
      document.getElementById('forge-hud-pos-left').value='333';
      await ipc.invoke('audit-hud-seed',cfg);
      await startHudEditMode();dragTo(0,900);
      const savedConfig=waitForConfig('save');stopHudEditMode(true);await savedConfig;
      const hudSaved={stored:cfg.todaySummaryHudPos.left,displayed:x.value,home:document.getElementById('home-url-input').value,
        forge:document.getElementById('forge-hud-pos-left').value};
      await applyTodaySummaryHudSettingsOnly();const hudApplied=cfg.todaySummaryHudPos.left;
      cfg={...cfg,todaySummaryHudPos:{left:800,top:200}};window.__receive(cfg);
      const hudFresh=x.value; // 저장한 좌표는 이후 일반 수신도 다시 허용한다.

      x.value='400';await startHudEditMode();dragTo(900,700);stopHudEditMode(false);
      const hudCancelled={displayed:x.value,position:hud.style.left};
      cfg={...cfg,todaySummaryHudPos:{left:600,top:200}};window.__receive(cfg);
      const hudDraftAfterCancel=x.value;
      await ipc.invoke('audit-hud-seed',cfg,false);
      await startHudEditMode();dragTo(900,700);
      const failedConfig=waitForConfig('failed');stopHudEditMode(true);await failedConfig;
      const hudFailed=x.value;
      await ipc.invoke('audit-hud-seed',cfg,true,false); // 다른 창의 위치 변경은 초안을 버리지 않는다.
      const foreignConfig=waitForConfig('foreign');window.electronAPI.applySettings({todaySummaryHudPos:{left:500,top:200}});await foreignConfig;
      const hudForeign=x.value;
      return {initial,afterSave,afterFailure,afterPending,afterHud,tabsAfterRemote,hudSaved,hudApplied,hudFresh,hudCancelled,hudDraftAfterCancel,hudFailed,hudForeign};
    })()`);
    assert.equal(actual.initial.home, 'https://edited.example/'); assert.equal(actual.initial.width, '950');
    assert.equal(actual.initial.slots[0].label, 'draft'); assert.deepEqual(actual.initial.shortcuts, { first: 'F3', second: 'F5' });
    assert.equal(actual.initial.colors.chatPickers.general, '#123456'); assert.equal(actual.initial.colors.chatPickers.whisper, '#555555');
    assert.equal(actual.initial.server, 'Siwv');assert.equal(actual.initial.position, 'left');
    assert.deepEqual(actual.initial.hiddenMenus, ['audit-first', 'audit-second']);
    assert.deepEqual(actual.afterSave, {font:'24',size:'700',sizeClean:true,loot:['remote-loot'],shout:['remote-shout'],color:'#ABCDEF',home:'https://edited.example/',slots:[{label:'draft',url:'https://draft.example/'}],shortcut:'F3'});
    assert.deepEqual(actual.afterFailure,{font:'21',loot:['failed-loot'],alerts:1});
    assert.deepEqual(actual.afterPending,{font:'22',loot:['pending-loot','typed-while-saving'],size:'800',sizeDirty:true});
    assert.deepEqual(actual.afterHud,{visible:true,font:'22'});
    assert.deepEqual(actual.tabsAfterRemote,[]);
    assert.deepEqual(actual.hudSaved,{stored:900,displayed:'900',home:'https://edited.example/',forge:'333'});
    assert.equal(actual.hudApplied,900);assert.equal(actual.hudFresh,'800');
    assert.deepEqual(actual.hudCancelled,{displayed:'400',position:'900px'});
    assert.equal(actual.hudDraftAfterCancel,'400');assert.equal(actual.hudFailed,'400');assert.equal(actual.hudForeign,'400');
  } finally {
    ipcMain.removeAllListeners('apply-settings'); ipcMain.removeHandler('apply-settings-confirmed'); ipcMain.removeHandler('audit-hud-seed');
    window.destroy();
  }
  console.log('[AUDIT] actual settings receiver preserves dirty fields and accepts unrelated remote changes');
}

async function checkSettingsInitializationAndSaveRaces(): Promise<void> {
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const source = read('dist/settings.html');
  const callbackStart = source.indexOf('function initChatAndNicknameColorPickers(cfg)');
  const callback = source.slice(callbackStart, source.indexOf('// 초기화 실행', callbackStart));
  const saveStart = source.indexOf('async function applySettingsWithDraft(');
  const save = source.slice(saveStart, source.indexOf('async function applyChatOverlaySettingsOnly()', saveStart));
  const initStart = source.indexOf('await window.settingsAudioControls.initializeAlertSoundSelects();');
  const initializeSounds = source.slice(initStart, source.indexOf('window.bindEscapeClose();', initStart));
  for (const earlyConfig of [true, false]) {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true } });
    let mainConfig = structuredClone(defaults);
    const remote = (_event: unknown, patch: any) => {
      Object.assign(mainConfig, patch);
      win.webContents.send('audit-draft-config', structuredClone(patch));
    };
    ipcMain.on('audit-draft-remote', remote);
    // 실제 동기식 저장 핸들러와 Electron IPC 순서를 사용하고 파일/창 부수 효과만 격리한다.
    const ipcSource = read('src/modules/ipcHandlers.ts');
    const start = ipcSource.indexOf('  type ApplySettingsResult =');
    const handler = ipcSource.slice(start, ipcSource.indexOf('  function broadcastChatLogStatus()', start));
    vm.runInNewContext(ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      ipcMain, isBoolean: (value: unknown) => typeof value === 'boolean', log() {}, applyRuntimeSettings() {}, broadcastChatLogStatus() {},
      config: { load: () => structuredClone(mainConfig),
        sanitizeExternalConfigPatch: (patch: any) => config.sanitizeExternalConfigPatch(structuredClone(patch)), getLastSaveError: () => null },
      wm: { getSettingsWindow: () => win, getGameOverlayWindow: () => null, applySettings: (patch: any, excluded: any) => {
        Object.assign(mainConfig, patch);
        if (excluded !== win.webContents) win.webContents.send('audit-draft-config', structuredClone(mainConfig));
        return true;
      } },
    });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(source.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link[^>]*>/gi, ''))}`);
      const actual = await win.webContents.executeJavaScript(`(async () => {
        const ipc=require('electron').ipcRenderer, noop=()=>{};
        let lastConfig=null,_pickrsInitialized=false,shortcuts={},cfg,finishSound;
        let currentSlots=[],currentKeywords=[],tradeKeywordsList=[],lootKeywordsList=[],shoutKeywordsList=[],chatOverlayFilterList=[],customTabsList=[],hasCustomLootKeywords=false;
        let saveSettings=patch=>ipc.invoke('apply-settings-confirmed',patch);
        window.electronAPI={DEFAULT_CONFIG:${JSON.stringify(defaults)},onConfigData:cb=>window.__receive=cb,getAppVersion:async()=> 'audit',
          getConfig:async()=>cfg,applySettingsConfirmed:patch=>saveSettings(patch)};
        window.chatChannels={OVERLAY_BUILT_IN_TABS:[],OVERLAY_CHANNELS:[],OVERLAY_COLORS:{general:'#ffffff',whisper:'#aaaaaa'},COLORS:{nickname:'#cccccc'},COLOR_SWATCHES:[]};
        window.Pickr={create:opts=>{let value=opts.default;return {getColor:()=>({toHEXA:()=>({toString:()=>value})}),setColor:next=>value=next,destroyAndRemoveEl:noop,on:noop};}};
        for(const key of ['renderChatOverlayFilterList','renderCustomTabsList','validateSettingsChatLogPath','ensureContentsItems','ensureOptimizeStatus','toggleNicknameColorPickers','renderEditList','renderKeywordList','renderTradeKeywordList','renderLootKeywordList','renderShoutKeywordList','renderCustomSounds','hideLoading','updateEtaCacheStatusText','refreshIcons','ensureChatAndNicknameColorPickers'])window[key]=noop;
        window.settingsMenuManagement={applyConfig:noop};
        window.settingsShortcuts={getShortcuts:()=>shortcuts,mergeShortcuts:value=>{shortcuts={...shortcuts,...value};},renderInputs:noop};
        window.loadSoundList=()=>new Promise(resolve=>{finishSound=resolve;});
        ${read('dist/renderer/settings/audio-controls.js')}
        ${read('dist/renderer/settings/config-binding.js')}
        ${read('dist/renderer/settings/draft.js')}
        ${callback}\n${save}
        const receive=patch=>{cfg={...cfg,...patch};window.__receive(cfg);};
        cfg={...window.electronAPI.DEFAULT_CONFIG,homeUrl:'https://saved.example/',quickSlots:[],shortcuts:{},chatOverlayFontSize:13,waveMonsterWarningSound:'old.wav'};
        const initializing=(async()=>{${initializeSounds}})();
        if(${earlyConfig}){
          receive(cfg);
          document.getElementById('home-url-input').value='https://edited.example/';
        }
        finishSound([{file:'old.wav',name:'old'},{file:'new.wav',name:'new'},{file:'third.wav',name:'third'}]);
        await initializing;
        if(!${earlyConfig})receive(cfg);
        initChatAndNicknameColorPickers(cfg);
        const sound=document.getElementById('wave-warning-sound');
        const initialized=sound.value;
        receive({waveMonsterWarningSound:'new.wav'});
        const received=sound.value;
        sound.value='old.wav';sound.dispatchEvent(new Event('change'));
        window.settingsDraft.initializeNewFields(); // 나중에 메뉴가 준비되어도 실제 편집까지 저장 승인하지 않는다.
        receive({waveMonsterWarningSound:'third.wav'});
        const edited=sound.value,home=document.getElementById('home-url-input').value;

        const font=document.getElementById('chat-overlay-fontsize-input');
        const setFont=value=>{font.value=String(value);font.dispatchEvent(new Event('input'));};
        const sendRemote=patch=>new Promise(resolve=>{
          ipc.once('audit-draft-config',(_event,value)=>{receive(value);resolve();});
          ipc.send('audit-draft-remote',patch);
        });
        const first=sendRemote({chatOverlayFontSize:24,lootKeywords:['remote-24']});
        const saving=applySettingsWithDraft({chatOverlayFontSize:13,lootKeywords:lootKeywordsList},['chat-overlay-fontsize-input'],{lootKeywordsList});
        const [,saved]=await Promise.all([first,saving]);
        if(!saved?.success)throw new Error('실제 설정 IPC 저장이 실패했습니다.');
        await sendRemote({chatOverlayFontSize:25,lootKeywords:['remote-25']});
        const native={font:font.value,loot:[...lootKeywordsList]};

        let finish;
        saveSettings=()=>new Promise(resolve=>{finish=resolve;});
        setFont(20);lootKeywordsList=['submitted'];window.chatPickers.general.setColor('#123456');
        const pending=applySettingsWithDraft({chatOverlayFontSize:20},['chat-overlay-fontsize-input'],{lootKeywordsList,colors:collectSettingsDraftExtras().colors});
        receive({chatOverlayFontSize:26,lootKeywords:['remote-26'],chatOverlayColorGeneral:'#222222',chatOverlayColorWhisper:'#333333'});
        setFont(22);lootKeywordsList.push('typed-again');window.chatPickers.general.setColor('#654321');
        finish({success:true});await pending;
        receive({chatOverlayFontSize:27,lootKeywords:['remote-27'],chatOverlayColorGeneral:'#444444',chatOverlayColorWhisper:'#555555'});
        const reedited={font:font.value,loot:[...lootKeywordsList],colors:collectSettingsDraftExtras().colors.chatPickers};
        // 저장 뒤 추가 수신도 있었으므로 편집을 취소할 기준은 최신 수신값이다.
        setFont(27);lootKeywordsList=['remote-27'];window.chatPickers.general.setColor('#444444');
        receive({chatOverlayFontSize:28,lootKeywords:['remote-28'],chatOverlayColorGeneral:'#666666',chatOverlayColorWhisper:'#777777'});
        const reverted={font:font.value,loot:[...lootKeywordsList],colors:collectSettingsDraftExtras().colors.chatPickers};

        const completions=[];
        saveSettings=()=>new Promise(resolve=>completions.push(resolve));
        setFont(16);const older=applySettingsWithDraft({chatOverlayFontSize:16},['chat-overlay-fontsize-input']);
        setFont(17);const newer=applySettingsWithDraft({chatOverlayFontSize:17},['chat-overlay-fontsize-input']);
        completions[1]({success:true});await newer;completions[0]({success:true});await older;
        receive({chatOverlayFontSize:18});const reverseAck=font.value;

        saveSettings=()=>new Promise(resolve=>{finish=resolve;});
        const nextTabs=[{id:'custom-after-ack',name:'audit',channels:['general']}];
        const tabsSaving=applySettingsWithDraft({chatOverlayCustomTabs:nextTabs},[],{customTabsList:nextTabs});
        receive({chatOverlayCustomTabs:[]});finish({success:true});await tabsSaving;customTabsList=nextTabs;
        receive({chatOverlayCustomTabs:[]});
        return {initialized,received,edited,home,native,reedited,reverted,reverseAck,tabs:customTabsList};
      })()`);
      assert.equal(actual.initialized, 'old.wav'); assert.equal(actual.received, 'new.wav'); assert.equal(actual.edited, 'old.wav');
      assert.equal(actual.home, earlyConfig ? 'https://edited.example/' : 'https://saved.example/');
      assert.deepEqual(actual.native, { font: '25', loot: ['remote-25'] });
      assert.deepEqual(actual.reedited, { font: '22', loot: ['submitted', 'typed-again'], colors: { general: '#654321', whisper: '#555555' } });
      assert.deepEqual(actual.reverted, { font: '28', loot: ['remote-28'], colors: { general: '#666666', whisper: '#777777' } });
      assert.deepEqual(actual.tabs, []);
      assert.equal(actual.reverseAck, '18');
    } finally {
      ipcMain.removeListener('audit-draft-remote', remote);
      ipcMain.removeAllListeners('apply-settings'); ipcMain.removeHandler('apply-settings-confirmed');
      win.destroy();
    }
  }
  console.log('[AUDIT] delayed sound initialization and native save/config races preserve only user edits');
}

async function checkCalculatorDom(): Promise<void> {
  const window = new BrowserWindow({ show: false, width: 1160, height: 820, webPreferences: { backgroundThrottling: false } });
  try {
    await window.loadFile(path.join(root, 'dist', 'equipment-simulator.html'));
    const actual = await window.webContents.executeJavaScript(`(() => {
      const input=(id,value,type='input')=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event(type));};
      document.querySelector('[data-main-tab="enchant"]').click();
      input('enchant-initial-blessing','100');input('enchant-target-success','1');
      const one=document.querySelector('#enchant-exp-metrics strong').textContent;
      input('enchant-target-success','2');
      const two=document.getElementById('enchant-exp-metrics').textContent;
      document.querySelector('[data-main-tab="incrypt"]').click();
      input('incrypt-scroll-type','vianu','change');input('incrypt-target-success','2');
      const vianu=document.querySelector('#incrypt-exp-metrics strong').textContent;
      input('incrypt-target-success','1e20');
      const bounded={value:document.getElementById('incrypt-target-success').value,text:document.getElementById('incrypt-exp-metrics').textContent};
      input('incrypt-target-success','-5');const negative=document.getElementById('incrypt-target-success').value;
      input('incrypt-target-success','1.9');const fractional=document.getElementById('incrypt-target-success').value;
      input('incrypt-target-success','');const empty=document.getElementById('incrypt-target-success').value;
      input('incrypt-target-success','2');
      return {one,two,vianu,bounded,negative,fractional,empty};
    })()`);
    assert.equal(actual.one, '1.0회');
    assert.ok(!actual.two.includes('2회 성공 시: 약 2.0회'));
    assert.equal(Number(actual.vianu.replace(/[^0-9.]/g, '')), 2967.0);
    assert.equal(actual.bounded.value, '20');assert.ok(actual.bounded.text.includes('20회 달성'));
    assert.ok(!/NaN|Infinity/.test(actual.bounded.text));
    assert.equal(actual.negative, '1');assert.equal(actual.fractional, '1');assert.equal(actual.empty, '');
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const screenshot = path.join(root, '.agents', 'reviews', '2026-09-05-audit', 'equipment-fixed.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
  } finally { window.destroy(); }
  console.log('[AUDIT] real calculator DOM displays initial blessing and cumulative Vianu expectation');
}

async function checkStorageAndRestore(): Promise<void> {
  const storage = require(moduleFile('rendererStorageBackup'));
  const schema = shared('rendererStorage');
  const snapshotModule = require(moduleFile('localSnapshot'));
  const window = new BrowserWindow({ show: false });
  const toolPage = path.join(data, 'tool-storage-fixture.html');
  fs.writeFileSync(toolPage, '<!doctype html><title>Tool storage fixture</title>');
  await window.loadFile(toolPage);
  await window.webContents.executeJavaScript(`localStorage.setItem('buff_presets','["before"]');localStorage.setItem('unrelated-key','keep');`);
  window.destroy();
  const captured = await storage.captureRendererStorage();
  assert.equal(captured.values.buff_presets, '["before"]'); assert.equal(captured.values['unrelated-key'], undefined);
  const snapshotPath = path.join(data, 'fixture-snapshot');
  const manifest = snapshotModule.createUserDataSnapshot(data, snapshotPath, { reason: 'test', appVersion: 'test', rendererStorage: captured });
  assert.ok(manifest.entries.some((entry: any) => entry.relativePath === schema.RENDERER_STORAGE_FILE));
  snapshotModule.verifyUserDataSnapshot(snapshotPath, { enforceRestoreAllowlist: true });
  const pendingFile = path.join(data, schema.RENDERER_STORAGE_FILE);
  fs.writeFileSync(pendingFile, JSON.stringify({ schemaVersion: 1, values: { buff_presets: '["restored"]' } }));
  await storage.restoreRendererStorageOnStartup();
  assert.equal((await storage.captureRendererStorage()).values.buff_presets, '["restored"]');
  const verifyWindow = new BrowserWindow({ show: false });
  await verifyWindow.loadFile(path.join(root, 'dist', 'storage-bridge.html'));
  assert.equal(await verifyWindow.webContents.executeJavaScript("localStorage.getItem('unrelated-key')"), 'keep');
  verifyWindow.destroy();
  assert.equal(fs.existsSync(pendingFile), false);
  assert.throws(() => schema.validateRendererStorageSnapshot({ schemaVersion: 1, values: { credentials: 'not allowed' } }));
  assert.match(fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8'), /window-all-closed[^\n]+if \(startupWindowsCreated\)/);
  console.log('[AUDIT] renderer storage is included and restored before tool startup');

  const backup = require(moduleFile('backupManager'));
  const Zip = require(path.join(root, 'node_modules', 'adm-zip'));
  const zipPath = path.join(data, 'restore.zip');
  const zip = new Zip(); zip.addFile('config.json', Buffer.from(JSON.stringify({ ...config.load(), opacity: 0.9 }))); zip.writeZip(zipPath);
  const open = dialog.showOpenDialog, message = dialog.showMessageBox, relaunch = app.relaunch, exit = app.exit;
  try {
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [zipPath] });
    (dialog as any).showMessageBox = async () => { throw new Error('forced failure after file replacement'); };
    config.saveImmediate({ opacity: 0.7 });
    assert.equal(await backup.importBackup({}), false);
    assert.equal(config.load().opacity, 0.7);
    assert.equal(config.saveImmediate({ opacity: 0.6 }), true);
    assert.doesNotThrow(() => diary.getStmt('SELECT 1').get());
    (dialog as any).showMessageBox = async () => {
      config.save({ opacity: 0.2 });
      assert.equal(config.saveImmediate({ opacity: 0.3 }), false);
      assert.throws(() => diary.getStmt('SELECT 1').get());
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).opacity, 0.9);
      return { response: 0 };
    };
    (app as any).relaunch = () => undefined; (app as any).exit = () => undefined;
    config.save({ opacity: 0.4 });
    assert.equal(await backup.importBackup({}), true);
  } finally {
    dialog.showOpenDialog = open; dialog.showMessageBox = message; app.relaunch = relaunch; app.exit = exit;
  }
  console.log('[AUDIT] restore rollback resumes writes; successful restore blocks stale writes and DB reopening');
}

async function main(): Promise<void> {
  await app.whenReady();
  checkHomework(); checkOrderingAndCalculators();
  await checkMonitorsAndRuntime(); await checkCloudConcurrency(); await checkCloudRollback(); await checkHttpAndServer();
  await checkSettingsDraft(); await checkSettingsInitializationAndSaveRaces(); await checkCalculatorDom(); await checkStorageAndRestore();
  console.log('Audit regression checks passed.');
  app.exit(0);
}
main().catch(error => { console.error(error); app.exit(1); });
