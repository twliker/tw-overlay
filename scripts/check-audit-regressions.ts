/** 실제 저장·병합·네트워크 경계와 Electron DOM으로 2026-09 감사의 실패 조건을 고정한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { app, BrowserWindow, dialog } from 'electron';

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
  for (const action of ['toggle', 'count', 'exclude']) {
    const previous = new Date(); previous.setDate(previous.getDate() - 1);
    const completed = item(`custom-previous-${action}`, 1, 1, true);
    completed.completedState.main.lastCompletedAt = previous.getTime();
    seed([completed]);
    const id = `${completed.id}_main`;
    diary.addHomeworkLog(dateKey(previous), id, 'audit', 'audit', 'weekly', previous.getTime());
    if (action === 'toggle') checker.toggleItem(completed.id, 'main');
    if (action === 'count') checker.updateItemCount(completed.id, 'main', 0);
    if (action === 'exclude') checker.toggleExcludeItem(completed.id, 'main');
    assert.equal(diary.getStmt('SELECT count(*) AS n FROM homework_logs WHERE content_id=?').get(id).n, 0);
  }
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
    await instance.api.auditLoop(); await instance.api.auditLoop();
    assert.deepEqual(instance.delays.slice(0, 2), [60_000, 120_000]);
    fail = false; await instance.api.auditLoop();
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
  const runtime = isolatedModule('runtimeSettings', { './galleryMonitor': runtimeGallery, './tradeMonitor': runtimeTrade,
    './shortcutManager': { reloadShortcuts: () => reloads++ }, './analytics': { analytics: { refreshEnabledState: () => analyticsRefreshes++, trackEvent() {} } },
    './autoStart': { setupAutoStart: () => autoStarts++ }, './diaryDb': { cleanOldDiaryData: () => cleanups++ },
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
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  try {
    const source = fs.readFileSync(path.join(root, 'dist', 'settings.html'), 'utf8');
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(source.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link[^>]*>/gi, ''))}`);
    const start = source.indexOf('function initChatAndNicknameColorPickers(cfg)');
    const callback = source.slice(start, source.indexOf('// 초기화 실행', start));
    const binding = fs.readFileSync(path.join(root, 'dist/renderer/settings/config-binding.js'), 'utf8');
    const draft = fs.readFileSync(path.join(root, 'dist/renderer/settings/draft.js'), 'utf8');
    const actual = await window.webContents.executeJavaScript(`(() => {
      let lastConfig=null, _pickrsInitialized=false;
      let currentSlots=[], currentKeywords=[], tradeKeywordsList=[], lootKeywordsList=[], shoutKeywordsList=[], chatOverlayFilterList=[], customTabsList=[], hasCustomLootKeywords=false;
      const noop=()=>{}; let shortcuts={};
      window.electronAPI={DEFAULT_CONFIG:{},onConfigData:cb=>window.__receive=cb,getAppVersion:async()=> 'audit'};
      window.chatChannels={OVERLAY_BUILT_IN_TABS:[],OVERLAY_CHANNELS:[],OVERLAY_COLORS:{general:'#ffffff',whisper:'#aaaaaa'},COLORS:{nickname:'#cccccc'},COLOR_SWATCHES:[]};
      window.Pickr={create:opts=>{let value=opts.default;return {getColor:()=>({toHEXA:()=>({toString:()=>value})}),setColor:next=>value=next,destroyAndRemoveEl:noop,on:noop};}};
      for(const name of ['renderChatOverlayFilterList','renderCustomTabsList','validateSettingsChatLogPath','ensureContentsItems','ensureOptimizeStatus','toggleNicknameColorPickers','renderEditList','renderKeywordList','renderTradeKeywordList','renderLootKeywordList','renderShoutKeywordList','renderCustomSounds','hideLoading','updateEtaCacheStatusText','refreshIcons','ensureChatAndNicknameColorPickers'])window[name]=noop;
      window.settingsMenuManagement={applyConfig:noop};window.settingsAudioControls={bindVolumeControl:noop};
      window.settingsShortcuts={getShortcuts:()=>shortcuts,mergeShortcuts:value=>{shortcuts={...shortcuts,...value};},renderInputs:noop};
      ${binding}\n${draft}\n${callback}
      const cfg={homeUrl:'https://saved.example/',width:800,height:600,quickSlots:[],shortcuts:{first:'F1',second:'F2'}};
      window.__receive(cfg);
      initChatAndNicknameColorPickers(cfg);
      window.chatPickers.general.setColor('#123456');
      document.getElementById('home-url-input').value='https://edited.example/';
      currentSlots.push({label:'draft',url:'https://draft.example/'}); shortcuts.first='F3';
      window.__receive({...cfg,width:900,shortcuts:{first:'F1',second:'F4'},chatOverlayColorGeneral:'#222222',chatOverlayColorWhisper:'#333333'});
      window.__receive({...cfg,width:950,shortcuts:{first:'F1',second:'F5'},chatOverlayColorGeneral:'#444444',chatOverlayColorWhisper:'#555555'});
      return {home:document.getElementById('home-url-input').value,width:document.getElementById('width-input').value,slots:currentSlots,shortcuts,colors:collectSettingsDraftExtras().colors};
    })()`);
    assert.equal(actual.home, 'https://edited.example/'); assert.equal(actual.width, '950');
    assert.equal(actual.slots[0].label, 'draft'); assert.deepEqual(actual.shortcuts, { first: 'F3', second: 'F5' });
    assert.equal(actual.colors.chatPickers.general, '#123456'); assert.equal(actual.colors.chatPickers.whisper, '#555555');
  } finally { window.destroy(); }
  console.log('[AUDIT] actual settings receiver preserves dirty fields and accepts unrelated remote changes');
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
      return {one,two,vianu:document.querySelector('#incrypt-exp-metrics strong').textContent};
    })()`);
    assert.equal(actual.one, '1.0회');
    assert.ok(!actual.two.includes('2회 성공 시: 약 2.0회'));
    assert.equal(Number(actual.vianu.replace(/[^0-9.]/g, '')), 2967.0);
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
  await checkMonitorsAndRuntime(); await checkCloudConcurrency(); await checkHttpAndServer();
  await checkSettingsDraft(); await checkCalculatorDom(); await checkStorageAndRestore();
  console.log('Audit regression checks passed.');
  app.exit(0);
}
main().catch(error => { console.error(error); app.exit(1); });
