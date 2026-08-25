import fs = require('node:fs');
import path = require('node:path');
import { app } from 'electron';

type ProbeMode = 'partial' | 'blocked';

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
}

const projectRoot = path.resolve(__dirname, '..');
const [modeValue, probeRoot, resultPath] = process.argv.slice(2);
const mode = modeValue as ProbeMode;
if (!['partial', 'blocked'].includes(mode)
  || !path.isAbsolute(probeRoot || '')
  || !path.isAbsolute(resultPath || '')) {
  throw new Error('runtime main partial restore probe arguments are invalid');
}

const appDataRoot = path.join(probeRoot, 'appData');
const userData = path.join(appDataRoot, 'twOverlay');
const storePath = path.join(probeRoot, 'remote-store.json');
fs.mkdirSync(userData, { recursive: true });
app.setPath('appData', appDataRoot);
app.setPath('userData', userData);

const syncDataHelper = require(path.join(projectRoot, 'dist', 'modules', 'syncDataHelper.js')) as any;
const generationId = 'partial-restore-generation';

function saveStore(store: RemoteStore): void {
  fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
}

function loadStore(): RemoteStore {
  return JSON.parse(fs.readFileSync(storePath, 'utf8')) as RemoteStore;
}

if (mode === 'partial') {
  const now = Date.now();
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    userServer: 7,
    overlayVisible: false,
    autoUpdateEnabled: false,
    googleSyncEnabled: true,
    googleSyncAutoSync: true,
    characterPresets: [{ id: 'local-default', name: '로컬 기본 캐릭터' }],
    contentsCheckerItems: [],
    pendingHomeworks: [],
  }), 'utf8');
  fs.writeFileSync(path.join(userData, 'cloud-sync-state.json'), JSON.stringify({
    schemaVersion: 1,
    deviceId: 'partial-restore-device',
    generationId,
    createdAt: now,
    profileState: 'fresh',
    fileIds: {},
    remoteRevisions: {},
    settingsDirtyKeys: [],
    settingsDirtyAt: {},
    checklistOutbox: [],
    confirmedChecklistOperations: [],
  }), 'utf8');
  const checklistPayload = syncDataHelper.buildChecklistSyncPayload({
    characterPresets: [{ id: 'remote-character', name: '원격 캐릭터' }],
    contentsCheckerItems: [],
    pendingHomeworks: [],
  }, 'remote-device', generationId, []);
  const files: Record<string, RemoteFile> = {
    'corrupt-settings': {
      id: 'corrupt-settings',
      name: 'tw_overlay_settings.json',
      modifiedTime: new Date(now).toISOString(),
      size: '32',
      payload: { schemaVersion: 1, kind: 'settings', data: { userServer: 16 } },
    },
    'valid-checklist': {
      id: 'valid-checklist',
      name: 'tw_overlay_checklist.json',
      modifiedTime: new Date(now + 1).toISOString(),
      size: String(Buffer.byteLength(JSON.stringify(checklistPayload), 'utf8')),
      payload: checklistPayload,
    },
    'corrupt-meta': {
      id: 'corrupt-meta',
      name: 'tw_overlay_sync_meta.json',
      modifiedTime: new Date(now + 2).toISOString(),
      size: '21',
      payload: { schemaVersion: 999 },
    },
  };
  saveStore({ files, uploadCounts: {} });
} else {
  const store = loadStore();
  const settingsPayload = syncDataHelper.buildSettingsSyncPayload({ userServer: 16 }, 'remote-device', generationId);
  store.files['corrupt-settings'] = {
    id: 'corrupt-settings',
    name: 'tw_overlay_settings.json',
    modifiedTime: new Date().toISOString(),
    size: String(Buffer.byteLength(JSON.stringify(settingsPayload), 'utf8')),
    payload: settingsPayload,
  };
  saveStore(store);
}

const phaseStartUploadCounts = structuredClone(loadStore().uploadCounts);
let downloadCount = 0;
let observation: Record<string, unknown> | null = null;
let probeError: string | null = null;

const googleAuth = require(path.join(projectRoot, 'dist', 'modules', 'googleAuth.js')) as any;
const googleDriveSync = require(path.join(projectRoot, 'dist', 'modules', 'googleDriveSync.js')) as any;
googleAuth.isLoggedIn = () => true;
googleAuth.loadStoredProfile = () => ({ email: 'partial-restore@example.com' });
googleDriveSync.listSyncFiles = async () => Object.values(loadStore().files)
  .map(file => ({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, size: file.size }));
googleDriveSync.downloadJsonPayload = async (fileId: string) => {
  downloadCount++;
  const file = loadStore().files[fileId];
  return file ? structuredClone(file.payload) : null;
};
googleDriveSync.cancelPendingRequests = () => undefined;
googleDriveSync.uploadJsonPayload = async (fileName: string, payload: any, existingFileId?: string) => {
  const store = loadStore();
  const id = existingFileId || `${fileName}-id`;
  store.uploadCounts[fileName] = (store.uploadCounts[fileName] || 0) + 1;
  store.files[id] = {
    id,
    name: fileName,
    modifiedTime: new Date().toISOString(),
    size: String(Buffer.byteLength(JSON.stringify(payload), 'utf8')),
    payload: structuredClone(payload),
  };
  saveStore(store);
  return id;
};

app.on('quit', () => {
  const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  fs.writeFileSync(resultPath, JSON.stringify({
    probeError,
    observation,
    profileState: state.profileState,
    restoreResults: state.restoreResults,
    settingsDirtyKeys: state.settingsDirtyKeys,
    checklistOperationIds: state.checklistOutbox.map((operation: any) => operation.id),
    userServer: config.userServer,
    characterPresetIds: config.characterPresets.map((character: any) => character.id),
    downloadCount,
    phaseStartUploadCounts,
    remoteStore: loadStore(),
  }), 'utf8');
});

void app.whenReady().then(() => {
  if (mode === 'blocked') {
    setTimeout(() => {
      const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
      const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
      observation = {
        profileState: state.profileState,
        userServer: config.userServer,
        downloadCount,
        uploadCounts: structuredClone(loadStore().uploadCounts),
      };
      app.quit();
    }, 2_200);
    return;
  }

  const deadline = Date.now() + 8_000;
  const poll = setInterval(() => {
    const state = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-sync-state.json'), 'utf8'));
    const settingsResult = state.restoreResults?.find((result: any) => result.kind === 'settings');
    const checklistResult = state.restoreResults?.find((result: any) => result.kind === 'checklist');
    if (state.profileState === 'needs-confirmation'
      && settingsResult?.status === 'invalid'
      && checklistResult?.status === 'restored') {
      clearInterval(poll);
      const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
      observation = {
        profileState: state.profileState,
        settingsStatus: settingsResult.status,
        checklistStatus: checklistResult.status,
        characterPresetIds: config.characterPresets.map((character: any) => character.id),
        uploadCounts: structuredClone(loadStore().uploadCounts),
      };
      app.quit();
    } else if (Date.now() >= deadline) {
      clearInterval(poll);
      probeError = 'main process did not complete the partial fresh restore';
      app.quit();
    }
  }, 50);
});

require(path.join(projectRoot, 'dist', 'main.js'));
