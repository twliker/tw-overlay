import fs = require('node:fs');
import path = require('node:path');
import { app } from 'electron';

type ProbeMode = 'loss' | 'restart';

interface RemoteFile {
  id: string;
  name: string;
  modifiedTime: string;
  size: string;
  payload: any;
}

interface RemoteStore {
  files: Record<string, RemoteFile>;
  uploadCounts: Record<string, number>;
  checklistLossCommitted?: boolean;
}

const projectRoot = path.resolve(__dirname, '..');
const [modeValue, probeRoot, resultPath] = process.argv.slice(2);
const mode = modeValue as ProbeMode;
if (!['loss', 'restart'].includes(mode)
  || !path.isAbsolute(probeRoot || '')
  || !path.isAbsolute(resultPath || '')) {
  throw new Error('runtime main response loss probe arguments are invalid');
}

const appDataRoot = path.join(probeRoot, 'appData');
const userData = path.join(appDataRoot, 'twOverlay');
const storePath = path.join(probeRoot, 'remote-store.json');
fs.mkdirSync(userData, { recursive: true });
app.setPath('appData', appDataRoot);
app.setPath('userData', userData);

if (mode === 'loss') {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    userServer: 1,
    overlayVisible: false,
    autoUpdateEnabled: false,
    googleSyncEnabled: true,
    googleSyncAutoSync: true,
    contentsCheckerItems: [],
    characterPresets: [],
    pendingHomeworks: [],
  }), 'utf8');
  fs.writeFileSync(storePath, JSON.stringify({ files: {}, uploadCounts: {} }), 'utf8');
}

const contentsChecker = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as {
  init(): boolean;
};
if (!contentsChecker.init()) throw new Error('runtime response loss contents initialization failed');

const operationId = 'response-loss-checklist-operation';
if (mode === 'loss') {
  const now = Date.now();
  fs.writeFileSync(path.join(userData, 'cloud-sync-state.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: 'response-loss-device',
    generationId: 'response-loss-generation',
    createdAt: now,
    profileState: 'established',
    fileIds: {},
    remoteRevisions: {},
    settingsDirtyKeys: ['userServer'],
    settingsDirtyAt: { userServer: now },
    checklistOutbox: [{
      id: operationId,
      deviceId: 'response-loss-device',
      createdAt: now,
      keys: ['contentsCheckerItems'],
      mutations: [],
    }],
    confirmedChecklistOperations: [],
  }), 'utf8');
}

function loadStore(): RemoteStore {
  return JSON.parse(fs.readFileSync(storePath, 'utf8')) as RemoteStore;
}

function saveStore(store: RemoteStore): void {
  fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
}

const googleAuth = require(path.join(projectRoot, 'dist', 'modules', 'googleAuth.js')) as any;
const googleDriveSync = require(path.join(projectRoot, 'dist', 'modules', 'googleDriveSync.js')) as any;
googleAuth.isLoggedIn = () => true;
googleDriveSync.listSyncFiles = async () => Object.values(loadStore().files)
  .map(file => ({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, size: file.size }));
googleDriveSync.downloadJsonPayload = async (fileId: string) => {
  const file = Object.values(loadStore().files).find(candidate => candidate.id === fileId);
  return file ? structuredClone(file.payload) : null;
};
let cancelledRequestCount = 0;
googleDriveSync.cancelPendingRequests = () => { cancelledRequestCount++; };
googleDriveSync.uploadJsonPayload = async (fileName: string, payload: any, existingFileId?: string) => {
  const store = loadStore();
  const id = existingFileId || `${fileName}-id`;
  store.uploadCounts[fileName] = (store.uploadCounts[fileName] || 0) + 1;
  store.files[fileName] = {
    id,
    name: fileName,
    modifiedTime: new Date().toISOString(),
    size: String(Buffer.byteLength(JSON.stringify(payload), 'utf8')),
    payload: structuredClone(payload),
  };
  const loseChecklistResponse = mode === 'loss'
    && fileName === 'tw_overlay_checklist.json'
    && store.checklistLossCommitted !== true;
  if (loseChecklistResponse) store.checklistLossCommitted = true;
  saveStore(store);
  if (loseChecklistResponse) return new Promise<string>(() => undefined);
  return id;
};

let quitRequestedAt = 0;
let probeError: string | null = null;
let convergenceObservation: Record<string, unknown> | null = null;

app.on('quit', () => {
  const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
  const logPath = path.join(userData, 'debug.log');
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  fs.writeFileSync(resultPath, JSON.stringify({
    probeError,
    quitElapsedMs: quitRequestedAt > 0 ? Date.now() - quitRequestedAt : null,
    cancelledRequestCount,
    shutdownTimeoutLogged: logText.includes('[SHUTDOWN] 클라우드 flush timeout'),
    settingsDirtyKeys: state.settingsDirtyKeys,
    checklistOperationIds: state.checklistOutbox.map((operation: any) => operation.id),
    confirmedChecklistOperationIds: state.confirmedChecklistOperations.map((operation: any) => operation.id),
    recoverySettingsDirtyKeys: state.shutdownRecovery?.settings?.dirtyKeys || [],
    recoveryChecklistOperationIds: state.shutdownRecovery?.checklist?.operationIds || [],
    remoteStore: loadStore(),
    convergenceObservation,
  }), 'utf8');
});

void app.whenReady().then(() => {
  if (mode === 'loss') {
    setTimeout(() => {
      quitRequestedAt = Date.now();
      app.quit();
    }, 1_800);
    return;
  }

  const deadline = Date.now() + 8_000;
  const poll = setInterval(() => {
    const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
    const checklistRecovery = state.shutdownRecovery?.checklist;
    if (state.checklistOutbox.length === 0 && !checklistRecovery) {
      clearInterval(poll);
      const store = loadStore();
      convergenceObservation = {
        checklistOperationIds: state.checklistOutbox.map((operation: any) => operation.id),
        confirmedChecklistOperationIds: state.confirmedChecklistOperations.map((operation: any) => operation.id),
        recoveryChecklistOperationIds: checklistRecovery?.operationIds || [],
        checklistUploadCount: store.uploadCounts['tw_overlay_checklist.json'] || 0,
      };
      quitRequestedAt = Date.now();
      app.quit();
    } else if (Date.now() >= deadline) {
      clearInterval(poll);
      probeError = 'restart process did not reconcile the committed checklist operation';
      quitRequestedAt = Date.now();
      app.quit();
    }
  }, 50);
});

require(path.join(projectRoot, 'dist', 'main.js'));
