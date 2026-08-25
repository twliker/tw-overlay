/**
 * Google Drive 분리 파일 동기화 오케스트레이터.
 * 설정과 숙제는 서로 다른 dirty/debounce 정책을 사용하고 모든 Drive 전송은 single-flight로 실행한다.
 */
import * as crypto from 'crypto';
import { AppConfig, GoogleSyncMetaPayload, GoogleSyncPayload, GoogleSyncResult, GoogleSyncStatus } from '../shared/types';
import * as cloudState from './cloudSyncState';
import * as config from './config';
import * as googleAuth from './googleAuth';
import * as googleDriveSync from './googleDriveSync';
import * as syncDataHelper from './syncDataHelper';
import { log } from './logger';
import { broadcastToAllWindows } from './windowMessaging';

type SyncKind = 'settings' | 'checklist';

const SETTINGS_DEBOUNCE_MS = 1_500;
const CHECKLIST_DEBOUNCE_MS = 500;
const CONFIG_PERSIST_RETRY_MS = 250;
const GAME_RUNNING_PULL_MS = 30_000;
const IDLE_PULL_MS = 5 * 60_000;

let settingsTimer: NodeJS.Timeout | null = null;
let checklistTimer: NodeJS.Timeout | null = null;
let pullTimer: NodeJS.Timeout | null = null;
let transferTail: Promise<unknown> = Promise.resolve();
let activeTransfers = 0;
let applyingCloud = false;
let settingsChangeSerial = 0;
let backgroundStarted = false;
const uploadFailureCount: Record<SyncKind, number> = { settings: 0, checklist: 0 };
let pullFailureCount = 0;

interface SyncFiles {
  settings?: googleDriveSync.DriveFileMeta;
  checklist?: googleDriveSync.DriveFileMeta;
  meta?: googleDriveSync.DriveFileMeta;
  generationId?: string;
  all: googleDriveSync.DriveFileMeta[];
}

function fileForKind(files: SyncFiles, kind: SyncKind): googleDriveSync.DriveFileMeta | undefined {
  return kind === 'settings' ? files.settings : files.checklist;
}

function fileNameForKind(kind: SyncKind): string {
  return kind === 'settings'
    ? googleDriveSync.SETTINGS_SYNC_FILE_NAME
    : googleDriveSync.CHECKLIST_SYNC_FILE_NAME;
}

function canAutoSync(): boolean {
  const cfg = config.load();
  return cfg.googleSyncEnabled === true
    && cfg.googleSyncAutoSync !== false
    && googleAuth.isLoggedIn();
}

function revisionOf(payload: GoogleSyncPayload): string {
  return payload.revision || String(payload.lastSyncedAt);
}

function getStatusFileName(): string {
  return `${googleDriveSync.SETTINGS_SYNC_FILE_NAME}, ${googleDriveSync.CHECKLIST_SYNC_FILE_NAME}`;
}

/** 현재 구글 동기화 상태 반환 */
export function getSyncStatus(): GoogleSyncStatus {
  const isLinked = googleAuth.isLoggedIn();
  const profile = googleAuth.loadStoredProfile();
  const cfg = config.load();
  return {
    isLinked,
    email: profile?.email || cfg.googleSyncUserEmail,
    lastSyncedAt: cfg.googleSyncLastTime,
    fileName: getStatusFileName(),
    isSyncing: activeTransfers > 0,
    autoSync: cfg.googleSyncAutoSync !== false,
  };
}

/** config/DB 생성 전에 호출해 이 PC의 최초 프로필 상태를 내구 기록한다. */
export function initializeLocalProfileState(): void {
  cloudState.load();
}

function broadcastStatus(): void {
  broadcastToAllWindows('google-sync-status-changed', getSyncStatus());
}

function enqueueTransfer<T>(label: string, task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    activeTransfers++;
    broadcastStatus();
    try {
      return await task();
    } finally {
      activeTransfers--;
      broadcastStatus();
    }
  };
  const result = transferTail.then(run, run);
  transferTail = result.catch(error => {
    log(`[CloudSyncManager] ${label} 전송 실패: ${error}`);
  });
  return result;
}

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

function selectNewest(files: googleDriveSync.DriveFileMeta[], name: string): googleDriveSync.DriveFileMeta | undefined {
  return files
    .filter(file => file.name === name)
    .sort((left, right) => String(right.modifiedTime || '').localeCompare(String(left.modifiedTime || '')))[0];
}

async function discoverFiles(): Promise<SyncFiles> {
  const all = await googleDriveSync.listSyncFiles();
  const files: SyncFiles = {
    settings: selectNewest(all, googleDriveSync.SETTINGS_SYNC_FILE_NAME),
    checklist: selectNewest(all, googleDriveSync.CHECKLIST_SYNC_FILE_NAME),
    meta: selectNewest(all, googleDriveSync.META_SYNC_FILE_NAME),
    all,
  };
  if (files.meta) {
    let validMeta = false;
    try {
      const rawMeta = await googleDriveSync.downloadJsonPayload<unknown>(files.meta.id);
      if (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
        const meta = rawMeta as Partial<GoogleSyncMetaPayload>;
        if (meta.schemaVersion === 1 && typeof meta.generationId === 'string' && meta.files) {
          validMeta = true;
          files.generationId = meta.generationId;
          cloudState.update(state => { state.generationId = meta.generationId!; });
          const settingsId = meta.files.settings?.id;
          const checklistId = meta.files.checklist?.id;
          const settingsById = settingsId ? all.find(file => file.id === settingsId) : undefined;
          const checklistById = checklistId ? all.find(file => file.id === checklistId) : undefined;
          if (settingsById?.name === googleDriveSync.SETTINGS_SYNC_FILE_NAME) files.settings = settingsById;
          if (checklistById?.name === googleDriveSync.CHECKLIST_SYNC_FILE_NAME) files.checklist = checklistById;
        }
      }
    } catch (error) {
      log(`[CloudSyncManager] 메타 파일을 읽지 못해 이름 기준 탐색을 사용합니다: ${error}`);
    }
    if (!validMeta) files.meta = undefined;
  }
  cloudState.update(state => {
    state.fileIds.settings = files.settings?.id;
    state.fileIds.checklist = files.checklist?.id;
    state.fileIds.meta = files.meta?.id;
  });
  return files;
}

async function downloadValidated(
  kind: SyncKind,
  file: googleDriveSync.DriveFileMeta | undefined,
  expectedGenerationId?: string,
): Promise<GoogleSyncPayload | null> {
  if (!file) return null;
  const declaredSize = Number(file.size || 0);
  if (Number.isFinite(declaredSize) && declaredSize > 5 * 1024 * 1024) {
    throw new Error(`${file.name} 파일이 허용 크기를 초과했습니다.`);
  }
  const value = await googleDriveSync.downloadJsonPayload<unknown>(file.id);
  if (!syncDataHelper.validateSyncPayload(value, kind)) {
    throw new Error(`${file.name} 파일의 형식 또는 체크섬이 올바르지 않습니다.`);
  }
  if (expectedGenerationId && value.generationId !== expectedGenerationId) {
    throw new Error(`${file.name} 파일의 생성 세대가 메타 파일과 일치하지 않습니다.`);
  }
  return value;
}

async function applyConfigFromCloud(nextConfig: AppConfig): Promise<void> {
  syncDataHelper.createLocalBackupBeforeSync(config.load());
  applyingCloud = true;
  try {
    if (!config.saveImmediate(nextConfig)) {
      throw new Error(`클라우드 데이터를 로컬에 저장하지 못했습니다: ${config.getLastSaveError() || '알 수 없는 오류'}`);
    }
    try {
      const contentsChecker = await import('./contentsChecker');
      contentsChecker.init();
    } catch (error) {
      log(`[CloudSyncManager] 숙제 화면 갱신 실패: ${error}`);
    }
    try {
      const wm = await import('./windowManager');
      wm.applySettings(nextConfig);
    } catch (error) {
      log(`[CloudSyncManager] 창 설정 갱신 실패: ${error}`);
    }
  } finally {
    applyingCloud = false;
  }
}

function combineRemoteIntoLocal(
  kind: SyncKind,
  payload: GoogleSyncPayload,
  manualRestore: boolean,
  settingsKeysChangedDuringRequest: string[] = [],
): AppConfig {
  const current = config.load();
  const state = cloudState.load();
  if (kind === 'settings') {
    return syncDataHelper.mergeSettingsSnapshot(
      current,
      payload,
      manualRestore ? [] : settingsKeysChangedDuringRequest,
    );
  }
  const checklist = syncDataHelper.mergeChecklistThreeWay(state.baseChecklist, current, payload.data);
  const merged = { ...current, ...checklist };
  if (merged.characterPresets && merged.characterPresets.length > 0
    && !merged.characterPresets.some(character => character.id === merged.selectedCharacterId)) {
    merged.selectedCharacterId = merged.characterPresets[0].id;
  }
  return merged;
}

async function receiveKind(
  kind: SyncKind,
  payload: GoogleSyncPayload,
  manualRestore: boolean,
  requestStartedAt = Date.now(),
): Promise<boolean> {
  const state = cloudState.load();
  const remoteRevision = revisionOf(payload);
  if (!manualRestore && state.remoteRevisions[kind] === remoteRevision) return false;

  const settingsKeysChangedDuringRequest = kind === 'settings'
    ? state.settingsDirtyKeys.filter(key => (state.settingsDirtyAt[key] || 0) > requestStartedAt)
    : [];
  let effectivePayload = payload;
  if (kind === 'checklist') {
    const remoteOperationIds = new Set((payload.operations || []).map(operation => operation.id));
    const localOperations = new Map([
      ...state.confirmedChecklistOperations,
      ...state.checklistOutbox,
    ].map(operation => [operation.id, operation]));
    const missingOperations = Array.from(localOperations.values())
      .filter(operation => !remoteOperationIds.has(operation.id));
    if (missingOperations.length > 0) {
      effectivePayload = {
        ...payload,
        data: syncDataHelper.replayChecklistOperations(payload.data, missingOperations),
      };
    }
  }
  const nextConfig = combineRemoteIntoLocal(kind, effectivePayload, manualRestore, settingsKeysChangedDuringRequest);
  await applyConfigFromCloud(nextConfig);
  cloudState.update(next => {
    next.remoteRevisions[kind] = remoteRevision;
    if (kind === 'settings') {
      next.baseSettings = structuredClone(payload.data);
      next.settingsDirtyKeys = manualRestore ? [] : settingsKeysChangedDuringRequest;
      next.settingsDirtyAt = Object.fromEntries(next.settingsDirtyKeys.map(key => [key, next.settingsDirtyAt[key]]));
    } else {
      next.baseChecklist = structuredClone(payload.data);
      const remoteOperations = payload.operations || [];
      const remoteOperationIds = new Set(remoteOperations.map(operation => operation.id));
      next.checklistOutbox = next.checklistOutbox.filter(operation => !remoteOperationIds.has(operation.id));
      const queuedIds = new Set(next.checklistOutbox.map(operation => operation.id));
      for (const missing of next.confirmedChecklistOperations) {
        if (!remoteOperationIds.has(missing.id) && !queuedIds.has(missing.id)) {
          next.checklistOutbox.push(structuredClone(missing));
        }
      }
      const confirmedById = new Map(next.confirmedChecklistOperations.map(operation => [operation.id, operation]));
      for (const operation of remoteOperations) confirmedById.set(operation.id, structuredClone(operation));
      next.confirmedChecklistOperations = Array.from(confirmedById.values()).slice(-1_000);
    }
    next.lastPullAt = Date.now();
  });
  return true;
}

async function uploadMeta(files: SyncFiles): Promise<void> {
  if (!files.settings?.id && !files.checklist?.id) return;
  const state = cloudState.load();
  const payload: GoogleSyncMetaPayload = {
    schemaVersion: 1,
    generationId: state.generationId,
    updatedAt: Date.now(),
    files: {
      ...(files.settings?.id ? {
        settings: { id: files.settings.id, name: googleDriveSync.SETTINGS_SYNC_FILE_NAME },
      } : {}),
      ...(files.checklist?.id ? {
        checklist: { id: files.checklist.id, name: googleDriveSync.CHECKLIST_SYNC_FILE_NAME },
      } : {}),
    },
  };
  const metaId = await googleDriveSync.uploadJsonPayload(
    googleDriveSync.META_SYNC_FILE_NAME,
    payload,
    files.meta?.id,
  );
  files.meta = { id: metaId, name: googleDriveSync.META_SYNC_FILE_NAME };
  cloudState.update(next => { next.fileIds.meta = metaId; });
}

function markSettingsDirty(keys: string[]): void {
  if (keys.length === 0) return;
  settingsChangeSerial++;
  cloudState.update(state => {
    state.settingsDirtyKeys = Array.from(new Set([...state.settingsDirtyKeys, ...keys]));
    const changedAt = Date.now();
    for (const key of keys) state.settingsDirtyAt[key] = changedAt;
  });
}

function markChecklistDirty(keys: string[]): void {
  if (keys.length === 0) return;
  cloudState.update(state => {
    const currentChecklist = syncDataHelper.extractChecklistSyncData(config.load());
    const operationBase = syncDataHelper.replayChecklistOperations(
      state.baseChecklist || {},
      state.checklistOutbox,
    );
    state.checklistOutbox.push({
      id: crypto.randomUUID(),
      deviceId: state.deviceId,
      createdAt: Date.now(),
      keys: Array.from(new Set(keys)),
      mutations: syncDataHelper.createChecklistOperationMutations(operationBase, currentChecklist),
    });
    state.checklistOutbox = state.checklistOutbox.slice(-1_000);
  });
}

function jitteredDelay(delay: number): number {
  const deviceId = cloudState.load().deviceId;
  const seed = crypto.createHash('sha256').update(deviceId).digest().readUInt16BE(0) / 0xffff;
  return Math.max(0, Math.round(delay * (0.9 + seed * 0.2)));
}

function scheduleUpload(kind: SyncKind, immediate = false, retryDelay?: number): void {
  if (!canAutoSync()) return;
  const delay = retryDelay !== undefined
    ? jitteredDelay(retryDelay)
    : immediate ? 0 : (kind === 'settings' ? SETTINGS_DEBOUNCE_MS : CHECKLIST_DEBOUNCE_MS);
  if (kind === 'settings') settingsTimer = clearTimer(settingsTimer);
  else checklistTimer = clearTimer(checklistTimer);

  const callback = () => {
    if (config.hasPending()) {
      if (kind === 'settings') settingsTimer = setTimeout(callback, CONFIG_PERSIST_RETRY_MS);
      else checklistTimer = setTimeout(callback, CONFIG_PERSIST_RETRY_MS);
      return;
    }
    if (kind === 'settings') settingsTimer = null;
    else checklistTimer = null;
    enqueueTransfer(`${kind} 자동 업로드`, () => uploadKinds([kind])).then(result => {
      if (!result.success) throw new Error(result.error || `${kind} 자동 업로드 실패`);
      uploadFailureCount[kind] = 0;
    }).catch(error => {
      uploadFailureCount[kind]++;
      const retryMs = Math.min(60_000, (kind === 'settings' ? SETTINGS_DEBOUNCE_MS : CHECKLIST_DEBOUNCE_MS)
        * (2 ** uploadFailureCount[kind]));
      log(`[CloudSyncManager] ${kind} 자동 업로드 실패, ${retryMs}ms 후 재시도: ${error}`);
      scheduleUpload(kind, false, retryMs);
    });
  };

  if (kind === 'settings') settingsTimer = setTimeout(callback, delay);
  else checklistTimer = setTimeout(callback, delay);
}

async function reconcileRemoteBeforeUpload(kind: SyncKind, files: SyncFiles): Promise<void> {
  const requestStartedAt = Date.now();
  const remote = await downloadValidated(kind, fileForKind(files, kind), files.generationId);
  if (!remote) return;
  if (!files.generationId && remote.generationId) {
    files.generationId = remote.generationId;
    cloudState.update(state => { state.generationId = remote.generationId!; });
  }
  const state = cloudState.load();
  if (state.remoteRevisions[kind] === revisionOf(remote)) return;
  await receiveKind(kind, remote, false, requestStartedAt);
}

async function uploadKinds(kinds: SyncKind[], forceLocalSettings = false): Promise<GoogleSyncResult> {
  if (!googleAuth.isLoggedIn()) return { success: false, error: 'Google 로그인이 필요합니다.' };
  if (config.hasPending() && !config.saveImmediate()) {
    return { success: false, error: '로컬 설정 저장이 완료되지 않아 클라우드 업로드를 보류했습니다.' };
  }

  const files = await discoverFiles();
  let latestAt = 0;
  let metaNeedsUpdate = !files.meta;
  for (const kind of kinds) {
    const before = cloudState.load();
    if (kind === 'settings' && before.settingsDirtyKeys.length === 0) continue;
    if (kind === 'checklist' && before.checklistOutbox.length === 0) continue;

    if (kind !== 'settings' || !forceLocalSettings) {
      await reconcileRemoteBeforeUpload(kind, files);
    }
    const current = config.load();
    const state = cloudState.load();
    if (kind === 'settings' && state.settingsDirtyKeys.length === 0) continue;
    if (kind === 'checklist' && state.checklistOutbox.length === 0) continue;
    const dirtyKeys = [...state.settingsDirtyKeys];
    const outboxIds = state.checklistOutbox.map(entry => entry.id);
    const capturedSerial = settingsChangeSerial;
    const payload = kind === 'settings'
      ? syncDataHelper.buildSettingsSyncPayload(current, state.deviceId, state.generationId)
      : syncDataHelper.buildChecklistSyncPayload(
        current,
        state.deviceId,
        state.generationId,
        Array.from(new Map([
          ...state.confirmedChecklistOperations,
          ...state.checklistOutbox.map(operation => ({ ...operation, deviceId: state.deviceId })),
        ].map(operation => [operation.id, operation])).values()),
      );
    const previousFileId = fileForKind(files, kind)?.id;
    const fileId = await googleDriveSync.uploadJsonPayload(
      fileNameForKind(kind),
      payload,
      fileForKind(files, kind)?.id,
    );
    const meta: googleDriveSync.DriveFileMeta = { id: fileId, name: fileNameForKind(kind) };
    if (kind === 'settings') files.settings = meta;
    else files.checklist = meta;
    if (fileId !== previousFileId) metaNeedsUpdate = true;
    latestAt = Math.max(latestAt, payload.lastSyncedAt);

    if (kind === 'checklist') {
      const verified = await downloadValidated('checklist', files.checklist, state.generationId);
      const verifiedIds = new Set((verified?.operations || []).map(operation => operation.id));
      if (!verified || revisionOf(verified) !== revisionOf(payload)
        || outboxIds.some(operationId => !verifiedIds.has(operationId))) {
        throw new Error('숙제 업로드 확인에 실패했습니다. outbox를 유지하고 다시 시도합니다.');
      }
    }

    cloudState.update(next => {
      next.fileIds[kind] = fileId;
      next.remoteRevisions[kind] = revisionOf(payload);
      if (kind === 'settings') {
        next.baseSettings = structuredClone(payload.data);
        if (settingsChangeSerial === capturedSerial) {
          next.settingsDirtyKeys = next.settingsDirtyKeys.filter(key => !dirtyKeys.includes(key));
          for (const key of dirtyKeys) delete next.settingsDirtyAt[key];
        }
      } else {
        next.baseChecklist = structuredClone(payload.data);
        next.checklistOutbox = next.checklistOutbox.filter(entry => !outboxIds.includes(entry.id));
        const confirmedById = new Map(next.confirmedChecklistOperations.map(operation => [operation.id, operation]));
        for (const operation of payload.operations || []) confirmedById.set(operation.id, structuredClone(operation));
        next.confirmedChecklistOperations = Array.from(confirmedById.values()).slice(-1_000);
      }
    });
  }

  if (latestAt > 0) {
    if (metaNeedsUpdate) await uploadMeta(files);
    applyingCloud = true;
    try {
      config.saveImmediate({ googleSyncLastTime: latestAt });
    } finally {
      applyingCloud = false;
    }
  }
  return {
    success: true,
    message: latestAt > 0 ? '클라우드 동기화가 완료되었습니다.' : '업로드할 변경 사항이 없습니다.',
    fileName: getStatusFileName(),
    lastSyncedAt: latestAt || config.load().googleSyncLastTime,
    fileCount: files.all.length,
    files: files.all,
  };
}

async function pullFromCloud(manualRestore: boolean): Promise<GoogleSyncResult> {
  if (!googleAuth.isLoggedIn()) return { success: false, error: 'Google 로그인이 필요합니다.' };
  const files = await discoverFiles();
  if (!files.settings && !files.checklist) {
    if (manualRestore) {
      return { success: false, error: '구글 드라이브에 저장된 동기화 데이터가 없습니다.' };
    }
    markSettingsDirty(syncDataHelper.SETTINGS_SYNCABLE_KEYS.map(String));
    markChecklistDirty(syncDataHelper.CHECKLIST_SYNCABLE_KEYS.map(String));
    return uploadKinds(['settings', 'checklist']);
  }

  let latestAt = 0;
  let applied = false;
  let discoveredGeneration = files.generationId;
  for (const kind of ['settings', 'checklist'] as const) {
    const requestStartedAt = Date.now();
    const payload = await downloadValidated(kind, fileForKind(files, kind), discoveredGeneration);
    if (!payload) {
      if (kind === 'settings') markSettingsDirty(syncDataHelper.SETTINGS_SYNCABLE_KEYS.map(String));
      else markChecklistDirty(syncDataHelper.CHECKLIST_SYNCABLE_KEYS.map(String));
      continue;
    }
    if (!discoveredGeneration && payload.generationId) {
      discoveredGeneration = payload.generationId;
      files.generationId = payload.generationId;
      cloudState.update(state => { state.generationId = payload.generationId!; });
    }
    latestAt = Math.max(latestAt, payload.lastSyncedAt);
    applied = (await receiveKind(kind, payload, manualRestore, requestStartedAt)) || applied;
  }

  if (latestAt > 0) {
    if (!files.meta) await uploadMeta(files);
    applyingCloud = true;
    try {
      config.saveImmediate({ googleSyncLastTime: latestAt });
    } finally {
      applyingCloud = false;
    }
  }
  const pendingState = cloudState.load();
  if (!manualRestore && pendingState.settingsDirtyKeys.length > 0) scheduleUpload('settings', true);
  if (pendingState.checklistOutbox.length > 0) scheduleUpload('checklist', true);
  return {
    success: true,
    message: applied ? '클라우드 변경 사항을 반영했습니다.' : '이미 최신 상태입니다.',
    fileName: getStatusFileName(),
    lastSyncedAt: latestAt || config.load().googleSyncLastTime,
    fileCount: files.all.length,
    files: files.all,
  };
}

function scheduleNextPull(): void {
  pullTimer = clearTimer(pullTimer);
  if (!backgroundStarted || !canAutoSync()) return;
  void import('./pollingLoop').then(pollingLoop => {
    const baseDelay = pollingLoop.getGameStatus() === 'running' ? GAME_RUNNING_PULL_MS : IDLE_PULL_MS;
    const delay = jitteredDelay(Math.min(15 * 60_000, baseDelay * (2 ** pullFailureCount)));
    pullTimer = setTimeout(() => {
      syncFromCloud(false).catch(error => log(`[CloudSyncManager] 주기적 수신 실패: ${error}`));
    }, delay);
  });
}

/** 로그인 및 최초 pull. 기존 파일이 없을 때만 이 PC의 로컬 상태를 최초 업로드한다. */
export async function loginAndInit(): Promise<{ success: boolean; status: GoogleSyncStatus; error?: string }> {
  try {
    const loginResult = await googleAuth.startLogin();
    if (!loginResult.success || !loginResult.profile) {
      return { success: false, status: getSyncStatus(), error: loginResult.error || '로그인에 실패했습니다.' };
    }
    const cfg = config.load();
    config.saveImmediate({
      googleSyncEnabled: true,
      googleSyncUserEmail: loginResult.profile.email,
      ...(cfg.googleSyncAutoSync === undefined ? { googleSyncAutoSync: true } : {}),
    });
    startBackgroundSync();
    const result = await syncFromCloud(false);
    return { success: result.success, status: getSyncStatus(), error: result.error };
  } catch (error: any) {
    log(`[CloudSyncManager] 로그인 초기화 실패: ${error}`);
    return { success: false, status: getSyncStatus(), error: error.message || String(error) };
  }
}

export function cancelLogin(): boolean {
  return googleAuth.cancelLogin();
}

export function isLoggingIn(): boolean {
  return googleAuth.isLoggingIn();
}

export function logout(): GoogleSyncStatus {
  stopBackgroundSync();
  settingsTimer = clearTimer(settingsTimer);
  checklistTimer = clearTimer(checklistTimer);
  googleDriveSync.cancelPendingRequests();
  googleAuth.logout();
  applyingCloud = true;
  try {
    config.saveImmediate({ googleSyncEnabled: false });
  } finally {
    applyingCloud = false;
  }
  broadcastStatus();
  return getSyncStatus();
}

/** 수동 백업: 설정과 숙제의 현재 로컬 상태를 모두 명시적 변경으로 업로드한다. */
export async function syncToCloud(_manual = false): Promise<GoogleSyncResult> {
  markSettingsDirty(syncDataHelper.SETTINGS_SYNCABLE_KEYS.map(String));
  markChecklistDirty(syncDataHelper.CHECKLIST_SYNCABLE_KEYS.map(String));
  return enqueueTransfer('수동 백업', () => uploadKinds(['settings', 'checklist'], true));
}

/** 자동 pull은 로컬 dirty를 보존하며, 명시적 복원은 일반 설정에 클라우드 스냅샷을 적용한다. */
export async function syncFromCloud(manual = false): Promise<GoogleSyncResult> {
  try {
    const result = await enqueueTransfer(manual ? '수동 복원' : '원격 변경 확인', () => pullFromCloud(manual));
    if (!result.success && !manual) pullFailureCount++;
    else if (result.success) pullFailureCount = 0;
    return result;
  } catch (error) {
    if (!manual) pullFailureCount++;
    throw error;
  } finally {
    scheduleNextPull();
  }
}

/** 설정 화면용 미리보기: 두 데이터 파일을 하나의 읽기 전용 payload로 합쳐 반환한다. */
export async function getCloudDataPreview(): Promise<{
  success: boolean;
  payload?: GoogleSyncPayload;
  fileMeta?: googleDriveSync.DriveFileMeta;
  fileCount?: number;
  files?: googleDriveSync.DriveFileMeta[];
  error?: string;
}> {
  if (!googleAuth.isLoggedIn()) return { success: false, error: 'Google 로그인이 필요합니다.' };
  try {
    return await enqueueTransfer('미리보기', async () => {
      const files = await discoverFiles();
      const settings = await downloadValidated('settings', files.settings, files.generationId);
      const checklist = await downloadValidated('checklist', files.checklist, files.generationId);
      if (!settings && !checklist) {
        return { success: false, error: '구글 드라이브에 저장된 동기화 파일이 없습니다.', files: files.all };
      }
      const latest = Math.max(settings?.lastSyncedAt || 0, checklist?.lastSyncedAt || 0);
      return {
        success: true,
        payload: {
          schemaVersion: 1,
          appVersion: settings?.appVersion || checklist?.appVersion || '',
          lastSyncedAt: latest,
          updatedBy: '',
          data: { ...(settings?.data || {}), ...(checklist?.data || {}) },
        },
        fileMeta: files.settings || files.checklist,
        fileCount: files.all.length,
        files: files.all,
      };
    });
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

/** 이전 호출부 호환: 이미 dirty로 분류된 파일의 업로드를 짧게 예약한다. */
export function requestDebouncedSync(): void {
  const state = cloudState.load();
  if (state.settingsDirtyKeys.length > 0) scheduleUpload('settings');
  if (state.checklistOutbox.length > 0) scheduleUpload('checklist');
}

export function startBackgroundSync(): void {
  backgroundStarted = true;
  scheduleNextPull();
}

export function stopBackgroundSync(): void {
  backgroundStarted = false;
  pullTimer = clearTimer(pullTimer);
}

/** 절전 복귀·네트워크 복구·게임 시작 시 호출하는 즉시 pull 경계. */
export function requestImmediatePull(reason: string): void {
  if (!canAutoSync()) return;
  log(`[CloudSyncManager] 즉시 원격 확인 요청: ${reason}`);
  pullTimer = clearTimer(pullTimer);
  syncFromCloud(false).catch(error => log(`[CloudSyncManager] 즉시 원격 확인 실패: ${error}`));
}

export function refreshBackgroundSchedule(): void {
  if (canAutoSync()) startBackgroundSync();
  else stopBackgroundSync();
}

/** 종료 전 현재 큐를 비운다. main의 3초 제한이 이 Promise 바깥에서 적용된다. */
export async function flushPendingSync(): Promise<void> {
  settingsTimer = clearTimer(settingsTimer);
  checklistTimer = clearTimer(checklistTimer);
  const state = cloudState.load();
  if (canAutoSync() && (state.settingsDirtyKeys.length > 0 || state.checklistOutbox.length > 0)) {
    await enqueueTransfer('종료 flush', () => uploadKinds(['settings', 'checklist']));
  }
  await transferTail;
}

googleAuth.setOnAuthInvalidated(() => {
  log('[CloudSyncManager] 구글 인증 만료 감지');
  stopBackgroundSync();
  googleDriveSync.cancelPendingRequests();
  applyingCloud = true;
  try {
    config.saveImmediate({ googleSyncEnabled: false });
  } finally {
    applyingCloud = false;
  }
  broadcastStatus();
});

config.addConfigChangeListener(changed => {
  if (applyingCloud) return;
  const keys = Object.keys(changed);
  const settingsKeys = keys.filter(key => syncDataHelper.SETTINGS_SYNCABLE_KEYS.includes(key as keyof AppConfig));
  const checklistKeys = keys.filter(key => syncDataHelper.CHECKLIST_SYNCABLE_KEYS.includes(key as keyof AppConfig));
  if (settingsKeys.length > 0 && config.load().googleSyncEnabled === true && googleAuth.isLoggedIn()) {
    markSettingsDirty(settingsKeys);
    scheduleUpload('settings');
  }
  if (checklistKeys.length > 0) {
    markChecklistDirty(checklistKeys);
    scheduleUpload('checklist');
  }
});
