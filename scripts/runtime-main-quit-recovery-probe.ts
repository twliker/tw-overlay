import fs = require('node:fs');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

type ProbeScenario = 'settings' | 'checklist' | 'both' | 'timeout' | 'session-end';

const projectRoot = path.resolve(__dirname, '..');
const [scenarioValue, probeRoot, resultPath] = process.argv.slice(2);
const scenario = scenarioValue as ProbeScenario;
if (!['settings', 'checklist', 'both', 'timeout', 'session-end'].includes(scenario)
  || !path.isAbsolute(probeRoot || '')
  || !path.isAbsolute(resultPath || '')) {
  throw new Error('runtime main quit recovery probe arguments are invalid');
}

const appDataRoot = path.join(probeRoot, 'appData');
const userData = path.join(appDataRoot, 'twOverlay');
fs.mkdirSync(userData, { recursive: true });
app.setPath('appData', appDataRoot);
app.setPath('userData', userData);

fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  userServer: 1,
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
let walCheckpointObserved = false;
let databaseCloseObserved = false;
let shutdownTimeoutObserved = false;

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
  if (message.includes('[DiaryDB] WAL Checkpoint executed:')) walCheckpointObserved = true;
  if (message.includes('[DiaryDB] Database connection closed.')) databaseCloseObserved = true;
  if (message.includes('[SHUTDOWN] 클라우드 flush timeout')) shutdownTimeoutObserved = true;
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
  fs.writeFileSync(resultPath, JSON.stringify({
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
    const targetWindow = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
    if (!targetWindow) throw new Error('runtime session-end probe window was not created');
    let prevented = false;
    targetWindow.emit('query-session-end', {
      preventDefault: () => { prevented = true; },
    });
    const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
    setTimeout(() => {
      const logText = fs.readFileSync(path.join(userData, 'debug.log'), 'utf8');
      sessionEndObservation = {
        prevented,
        recoverySettingsDirtyKeys: state.shutdownRecovery?.settings?.dirtyKeys || [],
        recoveryChecklistOperationIds: state.shutdownRecovery?.checklist?.operationIds || [],
        walCheckpointLogged: walCheckpointObserved
          || logText.includes('[DiaryDB] WAL Checkpoint executed:'),
      };
      quitRequestedAt = Date.now();
      app.quit();
    }, 50);
    return;
  }
  quitRequestedAt = Date.now();
  app.quit();
  if (scenario === 'timeout') setTimeout(() => app.quit(), 100);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

require(path.join(projectRoot, 'dist', 'main.js'));
