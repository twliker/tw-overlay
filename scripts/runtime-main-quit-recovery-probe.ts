import fs = require('node:fs');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

type ProbeScenario = 'settings' | 'checklist' | 'both' | 'timeout' | 'session-end' | 'log-stop-failure' | 'confirm-failure';

const projectRoot = path.resolve(__dirname, '..');
const [scenarioValue, probeRoot, resultPath] = process.argv.slice(2);
const scenario = scenarioValue as ProbeScenario;
if (!['settings', 'checklist', 'both', 'timeout', 'session-end', 'log-stop-failure', 'confirm-failure'].includes(scenario)
  || !path.isAbsolute(probeRoot || '')
  || !path.isAbsolute(resultPath || '')) {
  throw new Error('runtime main quit recovery probe arguments are invalid');
}

const appDataRoot = path.join(probeRoot, 'appData');
const userData = path.join(appDataRoot, 'twOverlay');
fs.mkdirSync(userData, { recursive: true });
app.setPath('appData', appDataRoot);
app.setPath('userData', userData);
const logs=path.join(userData,'fixture-logs');fs.mkdirSync(logs,{recursive:true});
const built=(name:string)=>require(path.join(projectRoot,'dist',name+'.js'));
// PC에 실제 게임이 떠 있어도 검수 대상 창과 종료 요청만 측정한다.
built('modules/tracker').start=()=>{};
built('modules/tracker').isGameRunning=()=>false;
built('modules/pollingLoop').start=()=>{};
built('modules/chatLogPathFinder').findChatLogPath=()=>logs;
built('modules/etaCacheManager').etaCacheManager.init=()=>{};
if (scenario==='log-stop-failure') {
  const date=built('shared/localDate').formatLocalDateKey().replace(/-/g,'_');
  fs.writeFileSync(path.join(logs,`TWChatLog_${date}.html`),'\ufeff');
}

fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  userServer: 1,
  analyticsEnabled:false,chatLogPath:logs,
  overlayVisible: false,
  autoUpdateEnabled: false,
  googleSyncEnabled: scenario === 'timeout',
  googleSyncAutoSync: scenario === 'timeout',
  contentsCheckerItems: [],
  characterPresets: [],
  pendingHomeworks: [],
}), 'utf8');

// 기본 숙제 병합은 cloud listener 등록 전에 끝내 종료 probe의 의도한 outbox만 남긴다.
const contentsChecker = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as {
  init(): boolean;
};
if (!contentsChecker.init()) throw new Error('runtime main quit contents initialization failed');

const expectsSettings = scenario === 'settings' || scenario === 'both'
  || scenario === 'timeout' || scenario === 'session-end';
const expectsChecklist = scenario === 'checklist' || scenario === 'both'
  || scenario === 'timeout' || scenario === 'session-end';
const operationId = `main-quit-${scenario}-operation`;
const now = Date.now();
fs.writeFileSync(path.join(userData, 'cloud-sync-state.json'), JSON.stringify({
  schemaVersion: 1,
  deviceId: `main-quit-${scenario}-device`,
  generationId: `main-quit-${scenario}-generation`,
  createdAt: now,
  profileState: 'established',
  fileIds: {},
  remoteRevisions: {},
  settingsDirtyKeys: expectsSettings ? ['userServer'] : [],
  settingsDirtyAt: expectsSettings ? { userServer: now } : {},
  checklistOutbox: expectsChecklist ? [{
    id: operationId,
    deviceId: `main-quit-${scenario}-device`,
    createdAt: now,
    keys: ['contentsCheckerItems'],
    mutations: [],
  }] : [],
  confirmedChecklistOperations: [],
}), 'utf8');

let quitRequestedAt = 0;
let firstVisibleWindowCount = 0;
let hideLatencyMs: number | null = null;
let hidePoll: NodeJS.Timeout | undefined;
let cancelledRequestCount = 0;
let firstQuitObserved = false;
let beforeQuitCount = 0;
let sessionEndObservation: Record<string, unknown> | null = null;
let confirmFailureObservation: Record<string, unknown> | null = null;
let walCheckpointObserved = false;
let walCheckpointCount = 0;
let databaseCloseObserved = false;
let shutdownTimeoutObserved = false;
let flushFailureObserved=false;
let watcherStopped=false;
let activeProfileId:string | undefined;

const hardTimeout = setTimeout(() => {
  console.error('runtime main quit recovery probe timed out');
  app.exit(1);
}, 17_000);

function recordHideCompletion(): void {
  if (quitRequestedAt === 0 || hideLatencyMs !== null) return;
  const visible = BrowserWindow.getAllWindows()
    .filter(window => !window.isDestroyed() && window.isVisible());
  if (visible.length === 0) {
    hideLatencyMs = Date.now() - quitRequestedAt;
    if (hidePoll) clearInterval(hidePoll);
    hidePoll = undefined;
  }
}

// 실제 hide 이벤트에서 완료 시각을 기록해, 바쁜 CI runner의 timer 지연을 제품 지연으로 오인하지 않는다.
app.on('browser-window-created', (_event, window) => {
  window.on('hide', recordHideCompletion);
});

const logger = require(path.join(projectRoot, 'dist', 'modules', 'logger.js')) as {
  log(message: string, forceInProd?: boolean): void;
};
const originalLog = logger.log;
logger.log = (message: string, forceInProd?: boolean) => {
  if (message.includes('[DiaryDB] WAL Checkpoint executed:')) {walCheckpointObserved = true;walCheckpointCount++;}
  if (message.includes('[DiaryDB] Database connection closed.')) databaseCloseObserved = true;
  if (message.includes('[SHUTDOWN] 클라우드 flush timeout')) shutdownTimeoutObserved = true;
  if (message.includes('fixture last chat log write failed')) flushFailureObserved=true;
  originalLog(message, forceInProd);
};

if (scenario === 'timeout') {
  const googleAuth = require(path.join(projectRoot, 'dist', 'modules', 'googleAuth.js')) as any;
  const googleDriveSync = require(path.join(projectRoot, 'dist', 'modules', 'googleDriveSync.js')) as any;
  googleAuth.isLoggedIn = () => true;
  googleDriveSync.listSyncFiles = () => new Promise<never>(() => undefined);
  googleDriveSync.cancelPendingRequests = () => { cancelledRequestCount++; };
}

app.on('before-quit', () => {
  beforeQuitCount++;
  if (quitRequestedAt === 0 || firstQuitObserved) return;
  firstQuitObserved = true;
  firstVisibleWindowCount = BrowserWindow.getAllWindows().filter(window => window.isVisible()).length;
  hidePoll = setInterval(recordHideCompletion, 1);
});

app.on('quit', () => {
  clearTimeout(hardTimeout);
  if (hidePoll) clearInterval(hidePoll);
  if (hideLatencyMs === null) {
    const visible = BrowserWindow.getAllWindows()
      .filter(window => !window.isDestroyed() && window.isVisible());
    if (visible.length === 0 && quitRequestedAt > 0) {
      hideLatencyMs = Date.now() - quitRequestedAt;
    }
  }
  const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
  const logPath = path.join(userData, 'debug.log');
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  let shutdownProfile;
  if (activeProfileId) {
    const Database=require('better-sqlite3'),db=new Database(path.join(userData,'app-data.db'),{readonly:true,fileMustExist:true});
    try {
      const state=db.prepare('SELECT value FROM profile_runtime_state WHERE profile_id=?').get(activeProfileId);
      shutdownProfile={savedBuffs:JSON.parse(state?.value ?? '{}').buffs?.map((buff:any)=>buff.buffId),
        flushFailureObserved,watcherStopped};
    } finally {db.close();}
  }
  fs.writeFileSync(resultPath, JSON.stringify({
    shutdownProfile,
    quitElapsedMs: quitRequestedAt > 0 ? Date.now() - quitRequestedAt : null,
    firstVisibleWindowCount,
    hideLatencyMs,
    settingsDirtyKeys: state.settingsDirtyKeys,
    checklistOperationIds: state.checklistOutbox.map((operation: any) => operation.id),
    recoverySettingsDirtyKeys: state.shutdownRecovery?.settings?.dirtyKeys || [],
    recoveryChecklistOperationIds: state.shutdownRecovery?.checklist?.operationIds || [],
    walCheckpointLogged: walCheckpointObserved
      || logText.includes('[DiaryDB] WAL Checkpoint executed:'),
    databaseCloseLogged: databaseCloseObserved
      || logText.includes('[DiaryDB] Database connection closed.'),
    cancelledRequestCount,
    shutdownTimeoutLogged: shutdownTimeoutObserved
      || logText.includes('[SHUTDOWN] 클라우드 flush timeout'),
    beforeQuitCount,
    sessionEndObservation,
    confirmFailureObservation,
  }), 'utf8');
});

void app.whenReady().then(async () => {
  // 종료 시 표시 중인 모든 앱 창이 즉시 숨겨지는지 검증하기 위한 probe 전용 창이다.
  // 제품의 비동기 ready-to-show 속도에 의존하면 느린 CI runner에서 검증이 흔들린다.
  const probeWindow = new BrowserWindow({
    width: 240,
    height: 120,
    show: true,
    skipTaskbar: true,
  });
  probeWindow.showInactive();

  const windowManager = require(path.join(projectRoot, 'dist', 'modules', 'windowManager.js')) as {
    getMainWindow(): BrowserWindow | null;
  };
  const mainWindowDeadline = Date.now() + 10_000;
  while (!windowManager.getMainWindow() && Date.now() < mainWindowDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!windowManager.getMainWindow()) {
    throw new Error('runtime main quit probe main window was not created');
  }

  await new Promise(resolve => setTimeout(resolve, 100));
  if (scenario === 'session-end') {
    // query-session-end는 Windows/다른 앱이 취소할 수 있다. 저장만 하고 실행 중 기능은 멈추지 않아야
    // 취소된 로그오프 뒤에도 앱이 정상 동작하며, 다시 질의되면 같은 저장을 반복한다.
    // 되돌릴 수 없는 정지는 실제 종료가 확정된 session-end에서만 한다.
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    if (windows.length < 2) throw new Error('runtime session-end probe needs two windows');
    const constants = built('modules/constants');
    const stops = { profile: 0, chatLog: 0, backgroundSync: 0 };
    const profileApplication = built('modules/profileApplication');
    const stopProfile = profileApplication.stopProfileApplication;
    profileApplication.stopProfileApplication = () => { stops.profile++; stopProfile(); };
    const chatLog = built('modules/chatLogManager').chatLogManager;
    const stopChatLog = chatLog.stop.bind(chatLog);
    chatLog.stop = (...args: unknown[]) => { stops.chatLog++; return stopChatLog(...args); };
    const cloud = built('modules/cloudSyncManager');
    const stopSync = cloud.stopBackgroundSync;
    cloud.stopBackgroundSync = () => { stops.backgroundSync++; stopSync(); };
    let prevented = false;
    const query = () => {
      // Windows는 최상위 창마다 같은 질의를 보낸다. 한 번의 로그오프는 한 번만 저장한다.
      for (const window of windows) window.emit('query-session-end', { preventDefault: () => { prevented = true; } });
    };
    const beforeQueryWalCount = walCheckpointCount;
    query();
    const firstQueryWalCount = walCheckpointCount - beforeQueryWalCount;
    const afterFirstQuery = { isQuitting: constants.appState.isQuitting, stops: { ...stops } };
    const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
    // 취소된 로그오프 뒤 다시 로그오프하면 저장을 다시 수행해야 한다.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const beforeSecondQueryWalCount = walCheckpointCount;
    query();
    const secondQueryWalCount = walCheckpointCount - beforeSecondQueryWalCount;
    const afterSecondQuery = { isQuitting: constants.appState.isQuitting, stops: { ...stops } };
    windows[0].emit('session-end', { preventDefault: () => { prevented = true; } });
    windows[1].emit('session-end', { preventDefault: () => { prevented = true; } });
    const afterSessionEnd = { isQuitting: constants.appState.isQuitting, stops: { ...stops } };
    setTimeout(() => {
      const logText = fs.readFileSync(path.join(userData, 'debug.log'), 'utf8');
      sessionEndObservation = {
        prevented,
        recoverySettingsDirtyKeys: state.shutdownRecovery?.settings?.dirtyKeys || [],
        recoveryChecklistOperationIds: state.shutdownRecovery?.checklist?.operationIds || [],
        walCheckpointLogged: walCheckpointObserved
          || logText.includes('[DiaryDB] WAL Checkpoint executed:'),
        firstQueryWalCount,
        secondQueryWalCount,
        afterFirstQuery,
        afterSecondQuery,
        afterSessionEnd,
      };
      quitRequestedAt = Date.now();
      app.quit();
    }, 50);
    return;
  }
  if (scenario==='log-stop-failure') {
    const runtime=built('modules/profileRuntime').getProfileRuntime(),service=runtime.service;
    const created=service.create('종료 검사 프로필',7);
    if (!created.success) throw new Error(created.error);
    activeProfileId=created.profileId;
    service.beginSession('shutdown-fixture');
    const selected=await service.select(activeProfileId,runtime.replay);
    if (!selected.success) throw new Error(selected.error);
    const buffs=built('modules/buffTimerManager').buffTimerManager;
    buffs.activateBuff('exp_heart');
    buffs.activateBuff('rare_heart','test');
    if (buffs.getActiveBuffs().length!==2) throw new Error('fixture buffs were not active');
    const live=built('modules/chatLogManager').chatLogManager;
    const tail=live._tail;
    if (!tail) throw new Error('fixture log watch did not start');
    const unwatch=tail.unwatch.bind(tail);
    tail.unwatch=()=>{unwatch();watcherStopped=true;};
    live.flushPendingNormalizedLine=()=>{throw new Error('fixture last chat log write failed');};
  }
  if (scenario === 'confirm-failure') {
    // 초안 확인 대화상자가 실패해도 종료 게이트가 'wait'에 갇히지 않아야 한다.
    // 첫 요청은 입력을 보존한 채 취소되고, 다음 종료 요청은 정상적으로 끝난다.
    const editors = built('modules/profileEditorWindows');
    const confirm = editors.confirmProfileEditorsShutdown;
    let failures = 0;
    // 항상 위인 스플래시(업데이트 잠금·시작 단계)는 모든 종료 확인 동안 내려가야 대화상자를 가리지 않는다.
    // main의 단일 확인 진입점이 실제로 양보시키는지 확인한다(검사 실패는 probe 비정상 종료로 드러난다).
    const wm = built('modules/windowManager');
    const splash: BrowserWindow = wm.createSplashWindow();
    const splashDuringConfirm: boolean[] = [];
    editors.confirmProfileEditorsShutdown = async (...args: unknown[]) => {
      splashDuringConfirm.push(splash.isAlwaysOnTop());
      if (failures++ === 0) throw new Error('fixture exit confirmation dialog failed');
      return confirm(...args);
    };
    app.quit();
    await new Promise(resolve => setTimeout(resolve, 300));
    const constants = built('modules/constants');
    confirmFailureObservation = {
      failures,
      isQuittingAfterFailure: constants.appState.isQuitting,
      visibleAfterFailure: BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible()).length,
    };
    if (splashDuringConfirm.join() !== 'false' || !splash.isAlwaysOnTop()) {
      console.error(`종료 확인 중 스플래시 양보가 맞지 않습니다: during=${splashDuringConfirm.join()} after=${splash.isAlwaysOnTop()}`);
      app.exit(1);
      return;
    }
    wm.closeSplashWindow({ showFollowUpWindows: false });
  }
  quitRequestedAt = Date.now();
  app.quit();
  if (scenario === 'timeout') setTimeout(() => app.quit(), 100);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

require(path.join(projectRoot, 'dist', 'main.js'));
