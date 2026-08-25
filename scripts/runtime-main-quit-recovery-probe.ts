import fs = require('node:fs');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

type ProbeScenario = 'settings' | 'checklist' | 'both';

const projectRoot = path.resolve(__dirname, '..');
const [scenarioValue, probeRoot, resultPath] = process.argv.slice(2);
const scenario = scenarioValue as ProbeScenario;
if (!['settings', 'checklist', 'both'].includes(scenario)
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
  googleSyncEnabled: false,
  googleSyncAutoSync: false,
  contentsCheckerItems: [],
  characterPresets: [],
  pendingHomeworks: [],
}), 'utf8');

// 기본 숙제 병합은 cloud listener 등록 전에 끝내 종료 probe의 의도한 outbox만 남긴다.
const contentsChecker = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as {
  init(): boolean;
};
if (!contentsChecker.init()) throw new Error('runtime main quit contents initialization failed');

const expectsSettings = scenario === 'settings' || scenario === 'both';
const expectsChecklist = scenario === 'checklist' || scenario === 'both';
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

app.on('before-quit', () => {
  if (quitRequestedAt === 0 || hidePoll) return;
  firstVisibleWindowCount = BrowserWindow.getAllWindows().filter(window => window.isVisible()).length;
  hidePoll = setInterval(() => {
    const visible = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible());
    if (visible.length === 0) {
      hideLatencyMs = Date.now() - quitRequestedAt;
      if (hidePoll) clearInterval(hidePoll);
      hidePoll = undefined;
    }
  }, 1);
});

app.on('quit', () => {
  if (hidePoll) clearInterval(hidePoll);
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
    walCheckpointLogged: logText.includes('[DiaryDB] WAL Checkpoint executed:'),
    databaseCloseLogged: logText.includes('[DiaryDB] Database connection closed.'),
  }), 'utf8');
});

void app.whenReady().then(() => {
  setTimeout(() => {
    quitRequestedAt = Date.now();
    app.quit();
  }, 1_800);
});

require(path.join(projectRoot, 'dist', 'main.js'));
