import fs = require('node:fs');
import path = require('node:path');
import { app } from 'electron';

type ProbeMode = 'prepare' | 'run';
type DeviceName = 'company' | 'home';
type ProbeScenario = 'nonconflict' | 'same-field';

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
  uploadOrder: string[];
  checklistUploadOrder: string[];
}

const projectRoot = path.resolve(__dirname, '..');
const [modeValue, deviceValue, probeRoot, resultPath, scenarioValue] = process.argv.slice(2);
const mode = modeValue as ProbeMode;
const device = deviceValue as DeviceName;
const scenario = scenarioValue as ProbeScenario;
if (!['prepare', 'run'].includes(mode)
  || !['company', 'home'].includes(device)
  || !['nonconflict', 'same-field'].includes(scenario)
  || !path.isAbsolute(probeRoot || '')
  || !path.isAbsolute(resultPath || '')) {
  throw new Error('runtime main cross upload probe arguments are invalid');
}

const appDataRoot = path.join(probeRoot, device, 'appData');
const userData = path.join(appDataRoot, 'twOverlay');
const storePath = path.join(probeRoot, 'remote-store.json');
const storeLockPath = path.join(probeRoot, 'remote-store.lock');
const generationId = `cross-upload-${scenario}-generation`;
const checklistFileName = 'tw_overlay_checklist.json';
const checklistFileId = 'cross-upload-checklist-id';
const targetItemId = 'weekly-eclipse-boss-ethos';
const companyOperationId = `cross-upload-${scenario}-company-operation`;
const homeOperationId = `cross-upload-${scenario}-home-operation`;
const ownOperationId = device === 'company' ? companyOperationId : homeOperationId;
const otherDevice = device === 'company' ? 'home' : 'company';

fs.mkdirSync(userData, { recursive: true });
app.setPath('appData', appDataRoot);
app.setPath('userData', userData);

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withStoreLock<T>(callback: () => T): T {
  const deadline = Date.now() + 8_000;
  while (true) {
    try {
      fs.mkdirSync(storeLockPath);
      break;
    } catch (error: any) {
      const retryableLockErrors = new Set(['EEXIST', 'EPERM', 'EACCES', 'ENOENT']);
      if (!retryableLockErrors.has(error?.code) || Date.now() >= deadline) throw error;
      wait(5);
    }
  }
  try {
    return callback();
  } finally {
    fs.rmSync(storeLockPath, { recursive: true, force: true });
  }
}

function loadStore(): RemoteStore {
  return withStoreLock(() => JSON.parse(fs.readFileSync(storePath, 'utf8')) as RemoteStore);
}

function updateStore(callback: (store: RemoteStore) => void): RemoteStore {
  return withStoreLock(() => {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as RemoteStore;
    callback(store);
    const tempPath = `${storePath}.${device}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(store), 'utf8');
    fs.renameSync(tempPath, storePath);
    return structuredClone(store);
  });
}

function operationIds(payload: any): string[] {
  return (payload?.operations || []).map((operation: any) => operation.id).sort();
}

let probeError: string | null = null;
let observation: Record<string, unknown> | null = null;

app.on('quit', () => {
  const statePath = path.join(userData, 'cloud-sync-state.json');
  const configPath = path.join(userData, 'config.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
  fs.writeFileSync(resultPath, JSON.stringify({
    probeError,
    observation,
    state,
    config,
    remoteStore: fs.existsSync(storePath) ? loadStore() : null,
  }), 'utf8');
});

void app.whenReady().then(() => {
  if (mode === 'prepare') {
    const configModule = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as any;
    const contentsChecker = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as any;
    const syncDataHelper = require(path.join(projectRoot, 'dist', 'modules', 'syncDataHelper.js')) as any;
    configModule.saveImmediate({
      overlayVisible: false,
      autoUpdateEnabled: false,
      googleSyncEnabled: true,
      googleSyncAutoSync: true,
      characterPresets: [
        { id: 'company-character', name: '회사 캐릭터' },
        { id: 'home-character', name: '집 캐릭터' },
      ],
      contentsCheckerItems: [],
      pendingHomeworks: [],
    });
    if (!contentsChecker.init()) throw new Error(`${device} contents initialization failed`);

    const initialized = configModule.load();
    const baseChecklist = syncDataHelper.extractChecklistSyncData(initialized);
    const baseItem = baseChecklist.contentsCheckerItems
      .find((item: any) => item.id === targetItemId);
    if (!baseItem) throw new Error(`cross upload target item is missing: ${targetItemId}`);
    baseItem.completedState['company-character'] = { isCompleted: false, currentCount: 0 };
    baseItem.completedState['home-character'] = { isCompleted: false, currentCount: 0 };

    const localChecklist = structuredClone(baseChecklist);
    const localItem = localChecklist.contentsCheckerItems
      .find((item: any) => item.id === targetItemId);
    const changedCharacterId = scenario === 'same-field'
      ? 'company-character'
      : device === 'company' ? 'company-character' : 'home-character';
    localItem.completedState[changedCharacterId] = {
      isCompleted: device === 'company' || scenario === 'nonconflict',
      currentCount: device === 'company' ? 1 : 2,
      lastCompletedAt: device === 'company' ? 10_000 : 20_000,
    };
    const operation = {
      id: ownOperationId,
      deviceId: `${device}-device`,
      createdAt: device === 'company' ? 10_000 : 20_000,
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(baseChecklist, localChecklist),
    };
    configModule.saveImmediate(localChecklist);

    if (device === 'company') {
      for (const name of ['company', 'home']) {
        fs.rmSync(path.join(probeRoot, `${name}-first-download.ready`), { force: true });
        fs.rmSync(path.join(probeRoot, `${name}-first-checklist-upload.ready`), { force: true });
      }
      const payload = syncDataHelper.buildChecklistSyncPayload(
        baseChecklist, 'seed-device', generationId, []);
      const remoteFile: RemoteFile = {
        id: checklistFileId,
        name: checklistFileName,
        modifiedTime: new Date().toISOString(),
        size: String(Buffer.byteLength(JSON.stringify(payload), 'utf8')),
        payload,
      };
      fs.writeFileSync(storePath, JSON.stringify({
        files: { [checklistFileName]: remoteFile },
        uploadCounts: {},
        uploadOrder: [],
        checklistUploadOrder: [],
      } satisfies RemoteStore), 'utf8');
    }
    const seedStore = loadStore();
    const seedPayload = seedStore.files[checklistFileName].payload;
    fs.writeFileSync(path.join(userData, 'cloud-sync-state.json'), JSON.stringify({
      schemaVersion: 1,
      deviceId: `${device}-device`,
      generationId,
      createdAt: Date.now(),
      profileState: 'established',
      fileIds: { checklist: checklistFileId },
      remoteRevisions: { checklist: seedPayload.revision },
      baseChecklist,
      settingsDirtyKeys: [],
      settingsDirtyAt: {},
      checklistOutbox: [operation],
      confirmedChecklistOperations: [],
    }), 'utf8');
    observation = { prepared: true, operationId: ownOperationId };
    app.quit();
    return;
  }

  const googleAuth = require(path.join(projectRoot, 'dist', 'modules', 'googleAuth.js')) as any;
  const googleDriveSync = require(path.join(projectRoot, 'dist', 'modules', 'googleDriveSync.js')) as any;
  googleAuth.isLoggedIn = () => true;
  googleAuth.loadStoredProfile = () => ({ email: 'cross-upload@example.com' });
  googleDriveSync.listSyncFiles = async () => Object.values(loadStore().files)
    .map(file => ({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, size: file.size }));

  let firstChecklistDownload = true;
  let firstChecklistRevision: string | null = null;
  googleDriveSync.downloadJsonPayload = async (fileId: string) => {
    const file = Object.values(loadStore().files).find(candidate => candidate.id === fileId);
    const snapshot = file ? structuredClone(file.payload) : null;
    if (file?.name === checklistFileName && firstChecklistDownload) {
      firstChecklistDownload = false;
      firstChecklistRevision = snapshot?.revision || null;
      fs.writeFileSync(path.join(probeRoot, `${device}-first-download.ready`), 'ready', 'utf8');
      const deadline = Date.now() + 8_000;
      while (!fs.existsSync(path.join(probeRoot, `${otherDevice}-first-download.ready`))) {
        if (Date.now() >= deadline) throw new Error(`${device} first download barrier timed out`);
        wait(10);
      }
    }
    return snapshot;
  };
  googleDriveSync.cancelPendingRequests = () => undefined;
  let firstChecklistUpload = true;
  googleDriveSync.uploadJsonPayload = async (fileName: string, payload: any, existingFileId?: string) => {
    if (fileName === checklistFileName && firstChecklistUpload) {
      firstChecklistUpload = false;
      fs.writeFileSync(path.join(probeRoot, `${device}-first-checklist-upload.ready`), 'ready', 'utf8');
      const deadline = Date.now() + 8_000;
      while (!fs.existsSync(path.join(probeRoot, `${otherDevice}-first-checklist-upload.ready`))) {
        if (Date.now() >= deadline) throw new Error(`${device} first checklist upload barrier timed out`);
        wait(10);
      }
    }
    const id = existingFileId || `${fileName}-id`;
    updateStore(store => {
      store.uploadCounts[device] = (store.uploadCounts[device] || 0) + 1;
      store.uploadOrder.push(device);
      if (fileName === checklistFileName) store.checklistUploadOrder.push(device);
      store.files[fileName] = {
        id,
        name: fileName,
        modifiedTime: new Date().toISOString(),
        size: String(Buffer.byteLength(JSON.stringify(payload), 'utf8')),
        payload: structuredClone(payload),
      };
    });
    return id;
  };

  const deadline = Date.now() + 20_000;
  const poll = async (): Promise<void> => {
    try {
      const cloudSyncManager = require(path.join(projectRoot, 'dist', 'modules', 'cloudSyncManager.js')) as any;
      const configModule = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as any;
      await cloudSyncManager.syncFromCloud(false);
      await cloudSyncManager.flushPendingSync();
      const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
      const config = configModule.load();
      const store = loadStore();
      const remotePayload = store.files[checklistFileName]?.payload;
      const remoteIds = operationIds(remotePayload);
      const confirmedIds = state.confirmedChecklistOperations.map((operation: any) => operation.id).sort();
      const localItem = config.contentsCheckerItems.find((item: any) => item.id === targetItemId);
      const companyState = localItem?.completedState?.['company-character'];
      const homeState = localItem?.completedState?.['home-character'];
      const remoteItem = remotePayload?.data?.contentsCheckerItems
        ?.find((item: any) => item.id === targetItemId);
      const remoteCompanyState = remoteItem?.completedState?.['company-character'];
      const hasBothOperations = [companyOperationId, homeOperationId]
        .every(id => remoteIds.includes(id) && confirmedIds.includes(id));
      const expectedStatesConverged = scenario === 'nonconflict'
        ? companyState?.isCompleted === true
          && companyState?.currentCount === 1
          && homeState?.isCompleted === true
          && homeState?.currentCount === 2
        : companyState?.isCompleted === true
          && companyState?.currentCount === 2
          && companyState?.lastCompletedAt === 20_000
          && remoteCompanyState?.isCompleted === true
          && remoteCompanyState?.currentCount === 2
          && remoteCompanyState?.lastCompletedAt === 20_000
          && homeState?.isCompleted === false
          && homeState?.currentCount === 0;
      if (hasBothOperations
        && state.checklistOutbox.length === 0
        && expectedStatesConverged) {
        observation = {
          remoteOperationIds: remoteIds,
          confirmedOperationIds: confirmedIds,
          checklistOutboxIds: [],
          companyState,
          homeState,
          remoteCompanyState,
          uploadCounts: structuredClone(store.uploadCounts),
          uploadOrder: [...store.uploadOrder],
          checklistUploadOrder: [...store.checklistUploadOrder],
          firstChecklistRevision,
        };
        app.quit();
        return;
      }
      if (Date.now() >= deadline) {
        probeError = `${scenario} ${device} process did not converge after crossed uploads: ${JSON.stringify({
          remoteIds,
          confirmedIds,
          outboxIds: state.checklistOutbox.map((operation: any) => operation.id),
          companyState,
          homeState,
          remoteCompanyState,
          uploadOrder: store.uploadOrder,
        })}`;
        app.quit();
        return;
      }
      setTimeout(() => void poll(), 100);
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
      app.quit();
    }
  };
  setTimeout(() => void poll(), 500);
});

if (mode === 'run') require(path.join(projectRoot, 'dist', 'main.js'));
