/**
 * Google Drive 동기화의 PC별 내구 상태.
 * config.json과 분리해 클라우드 복원으로 동기화 제어 정보가 덮이지 않게 한다.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AppConfig, GoogleChecklistSyncOperation, GoogleSyncFileRestoreResult, GoogleSyncProfileState } from '../shared/types';
import { log } from './logger';
import { isValidChecklistOperation, SETTINGS_SYNCABLE_KEYS } from './syncDataHelper';

const STATE_FILE_NAME = 'cloud-sync-state.json';
const STATE_SCHEMA_VERSION = 1;

export type ChecklistOutboxEntry = GoogleChecklistSyncOperation;

export interface CloudShutdownRecovery {
  createdAt: number;
  settings?: {
    dirtyKeys: string[];
    checksum: string;
    remoteRevision?: string;
  };
  checklist?: {
    operationIds: string[];
    checksum: string;
    remoteRevision?: string;
  };
}

export interface CloudSyncLocalState {
  schemaVersion: number;
  deviceId: string;
  generationId: string;
  createdAt: number;
  profileState: GoogleSyncProfileState;
  fileIds: {
    settings?: string;
    checklist?: string;
    meta?: string;
  };
  remoteRevisions: {
    settings?: string;
    checklist?: string;
  };
  baseSettings?: Partial<AppConfig>;
  baseChecklist?: Partial<AppConfig>;
  settingsDirtyKeys: string[];
  settingsDirtyAt: Record<string, number>;
  checklistOutbox: ChecklistOutboxEntry[];
  confirmedChecklistOperations: GoogleChecklistSyncOperation[];
  restoreResults?: GoogleSyncFileRestoreResult[];
  restorePartial?: boolean;
  shutdownRecovery?: CloudShutdownRecovery;
  lastPullAt?: number;
}

let cachedState: CloudSyncLocalState | null = null;

export function detectProfileStateAtPath(userData: string): GoogleSyncProfileState {
  const configPath = path.join(userData, 'config.json');
  const diaryPath = path.join(userData, 'diary.db');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return 'established';
      return 'needs-confirmation';
    } catch {
      return 'needs-confirmation';
    }
  }
  if (fs.existsSync(diaryPath)) {
    try {
      const fd = fs.openSync(diaryPath, 'r');
      const header = Buffer.alloc(16);
      try {
        if (fs.readSync(fd, header, 0, header.length, 0) === header.length
          && header.toString('utf8') === 'SQLite format 3\0') return 'established';
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 손상되었거나 읽지 못한 DB는 자동 복원 대상으로 판정하지 않는다.
    }
    return 'needs-confirmation';
  }
  const ambiguousFiles = [
    STATE_FILE_NAME,
    `${STATE_FILE_NAME}.tmp`,
    'config.json.tmp',
    'config.quarantine.json',
    'diary.db-wal',
    'diary.db-shm',
  ];
  return ambiguousFiles.some(name => fs.existsSync(path.join(userData, name))) ? 'needs-confirmation' : 'fresh';
}

function detectProfileState(): GoogleSyncProfileState {
  return detectProfileStateAtPath(app.getPath('userData'));
}

function createState(): CloudSyncLocalState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    deviceId: crypto.randomUUID(),
    generationId: crypto.randomUUID(),
    createdAt: Date.now(),
    profileState: detectProfileState(),
    fileIds: {},
    remoteRevisions: {},
    settingsDirtyKeys: [],
    settingsDirtyAt: {},
    checklistOutbox: [],
    confirmedChecklistOperations: [],
  };
}

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE_NAME);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function normalizeStringFields<T extends string>(
  value: unknown,
  keys: readonly T[],
  maxLength: number,
): Partial<Record<T, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.flatMap(key => {
    const candidate = source[key];
    return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= maxLength
      ? [[key, candidate]]
      : [];
  })) as Partial<Record<T, string>>;
}

function normalizeOperations(value: unknown): GoogleChecklistSyncOperation[] {
  return Array.isArray(value)
    ? value.filter(isValidChecklistOperation).slice(-1_000).map(operation => structuredClone(operation))
    : [];
}

function normalizeRestoreResults(value: unknown): GoogleSyncFileRestoreResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowedStatuses = new Set(['available', 'restored', 'unchanged', 'missing', 'invalid', 'generation-mismatch', 'skipped']);
  return value.filter((entry): entry is GoogleSyncFileRestoreResult => !!entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry.kind === 'settings' || entry.kind === 'checklist')
    && typeof entry.selected === 'boolean'
    && allowedStatuses.has(entry.status));
}

function normalizeShutdownRecovery(value: unknown): CloudShutdownRecovery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const parsed = value as Partial<CloudShutdownRecovery>;
  if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) return undefined;
  const settings = parsed.settings && typeof parsed.settings === 'object'
    && isStringArray(parsed.settings.dirtyKeys)
    && typeof parsed.settings.checksum === 'string'
    && /^[a-f0-9]{64}$/i.test(parsed.settings.checksum)
    ? {
      dirtyKeys: Array.from(new Set(parsed.settings.dirtyKeys
        .filter(key => SETTINGS_SYNCABLE_KEYS.includes(key as keyof AppConfig)))).slice(0, 500),
      checksum: parsed.settings.checksum,
      remoteRevision: typeof parsed.settings.remoteRevision === 'string'
        && parsed.settings.remoteRevision.length > 0 && parsed.settings.remoteRevision.length <= 500
        ? parsed.settings.remoteRevision : undefined,
    }
    : undefined;
  const checklist = parsed.checklist && typeof parsed.checklist === 'object'
    && isStringArray(parsed.checklist.operationIds)
    && typeof parsed.checklist.checksum === 'string'
    && /^[a-f0-9]{64}$/i.test(parsed.checklist.checksum)
    ? {
      operationIds: Array.from(new Set(parsed.checklist.operationIds
        .filter(id => id.length > 0 && id.length <= 200))).slice(0, 1_000),
      checksum: parsed.checklist.checksum,
      remoteRevision: typeof parsed.checklist.remoteRevision === 'string'
        && parsed.checklist.remoteRevision.length > 0 && parsed.checklist.remoteRevision.length <= 500
        ? parsed.checklist.remoteRevision : undefined,
    }
    : undefined;
  if (!settings && !checklist) return undefined;
  return { createdAt: parsed.createdAt, settings, checklist };
}

function normalizeState(value: unknown): CloudSyncLocalState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<CloudSyncLocalState>;
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION
    || typeof parsed.deviceId !== 'string' || parsed.deviceId.length === 0 || parsed.deviceId.length > 200
    || typeof parsed.generationId !== 'string' || parsed.generationId.length === 0
    || parsed.generationId.length > 200) return null;

  const settingsDirtyKeys = isStringArray(parsed.settingsDirtyKeys)
    ? Array.from(new Set(parsed.settingsDirtyKeys.filter(key => SETTINGS_SYNCABLE_KEYS.includes(key as keyof AppConfig))))
    : [];
  const dirtyKeySet = new Set(settingsDirtyKeys);
  const settingsDirtyAt = parsed.settingsDirtyAt && typeof parsed.settingsDirtyAt === 'object'
    && !Array.isArray(parsed.settingsDirtyAt)
    ? Object.fromEntries(Object.entries(parsed.settingsDirtyAt)
      .filter(([key, timestamp]) => dirtyKeySet.has(key)
        && typeof timestamp === 'number' && Number.isFinite(timestamp)))
    : {};

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    deviceId: parsed.deviceId,
    generationId: parsed.generationId,
    createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
      ? parsed.createdAt : Date.now(),
    profileState: parsed.profileState === 'fresh'
      || parsed.profileState === 'established'
      || parsed.profileState === 'needs-confirmation'
      ? parsed.profileState
      : 'needs-confirmation',
    fileIds: normalizeStringFields(parsed.fileIds, ['settings', 'checklist', 'meta'], 200),
    remoteRevisions: normalizeStringFields(parsed.remoteRevisions, ['settings', 'checklist'], 500),
    baseSettings: parsed.baseSettings,
    baseChecklist: parsed.baseChecklist,
    settingsDirtyKeys,
    settingsDirtyAt,
    checklistOutbox: normalizeOperations(parsed.checklistOutbox),
    confirmedChecklistOperations: normalizeOperations(parsed.confirmedChecklistOperations),
    restoreResults: normalizeRestoreResults(parsed.restoreResults),
    restorePartial: typeof parsed.restorePartial === 'boolean' ? parsed.restorePartial : undefined,
    shutdownRecovery: normalizeShutdownRecovery(parsed.shutdownRecovery),
    lastPullAt: typeof parsed.lastPullAt === 'number' && Number.isFinite(parsed.lastPullAt)
      ? parsed.lastPullAt : undefined,
  };
}

function writeAtomic(state: CloudSyncLocalState): void {
  const filePath = getStatePath();
  const tempPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

function readNormalizedState(filePath: string): CloudSyncLocalState | null {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown);
  } catch {
    return null;
  }
}

export function load(): CloudSyncLocalState {
  if (cachedState) return structuredClone(cachedState);
  const filePath = getStatePath();
  const tempPath = `${filePath}.tmp`;
  const primaryState = readNormalizedState(filePath);
  if (primaryState) {
    cachedState = primaryState;
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (error) {
      log(`[CloudSyncState] 오래된 임시 상태 정리 실패: ${error}`);
    }
    return structuredClone(cachedState);
  }

  const temporaryState = readNormalizedState(tempPath);
  cachedState = temporaryState || createState();
  try {
    writeAtomic(cachedState);
    if (temporaryState) log('[CloudSyncState] 원자 저장 중 남은 임시 상태를 복구했습니다.');
  } catch (error) {
    log(`[CloudSyncState] 초기 상태 저장 실패: ${error}`);
  }
  return structuredClone(cachedState);
}

export function save(next: CloudSyncLocalState): boolean {
  const normalized = normalizeState(next);
  if (!normalized) return false;
  try {
    writeAtomic(normalized);
    cachedState = structuredClone(normalized);
    return true;
  } catch (error) {
    log(`[CloudSyncState] 상태 저장 실패: ${error}`);
    return false;
  }
}

export function update(mutator: (state: CloudSyncLocalState) => void): CloudSyncLocalState {
  const next = load();
  mutator(next);
  if (!save(next)) throw new Error('클라우드 동기화 상태를 저장하지 못했습니다.');
  return next;
}

export function resetCacheForTests(): void {
  cachedState = null;
}
