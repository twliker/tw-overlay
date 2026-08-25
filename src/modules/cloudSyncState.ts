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

const STATE_FILE_NAME = 'cloud-sync-state.json';
const STATE_SCHEMA_VERSION = 1;

export type ChecklistOutboxEntry = GoogleChecklistSyncOperation;

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

function normalizeState(value: unknown): CloudSyncLocalState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<CloudSyncLocalState>;
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION
    || typeof parsed.deviceId !== 'string'
    || typeof parsed.generationId !== 'string') return null;

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    deviceId: parsed.deviceId,
    generationId: parsed.generationId,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    profileState: parsed.profileState === 'fresh'
      || parsed.profileState === 'established'
      || parsed.profileState === 'needs-confirmation'
      ? parsed.profileState
      : 'needs-confirmation',
    fileIds: parsed.fileIds && typeof parsed.fileIds === 'object' ? parsed.fileIds : {},
    remoteRevisions: parsed.remoteRevisions && typeof parsed.remoteRevisions === 'object'
      ? parsed.remoteRevisions : {},
    baseSettings: parsed.baseSettings,
    baseChecklist: parsed.baseChecklist,
    settingsDirtyKeys: isStringArray(parsed.settingsDirtyKeys) ? parsed.settingsDirtyKeys : [],
    settingsDirtyAt: parsed.settingsDirtyAt && typeof parsed.settingsDirtyAt === 'object'
      ? Object.fromEntries(Object.entries(parsed.settingsDirtyAt)
        .filter(([key, timestamp]) => typeof key === 'string' && typeof timestamp === 'number'))
      : {},
    checklistOutbox: Array.isArray(parsed.checklistOutbox)
      ? parsed.checklistOutbox.filter(entry => entry
        && typeof entry.id === 'string'
        && typeof entry.deviceId === 'string'
        && typeof entry.createdAt === 'number'
        && isStringArray(entry.keys)
        && Array.isArray(entry.mutations)).slice(-1_000)
      : [],
    confirmedChecklistOperations: Array.isArray(parsed.confirmedChecklistOperations)
      ? parsed.confirmedChecklistOperations.filter(entry => entry
        && typeof entry.id === 'string'
        && typeof entry.deviceId === 'string'
        && typeof entry.createdAt === 'number'
        && isStringArray(entry.keys)
        && Array.isArray(entry.mutations)).slice(-1_000)
      : [],
    restoreResults: normalizeRestoreResults(parsed.restoreResults),
    restorePartial: typeof parsed.restorePartial === 'boolean' ? parsed.restorePartial : undefined,
    lastPullAt: typeof parsed.lastPullAt === 'number' ? parsed.lastPullAt : undefined,
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

export function load(): CloudSyncLocalState {
  if (cachedState) return structuredClone(cachedState);
  try {
    const parsed = JSON.parse(fs.readFileSync(getStatePath(), 'utf-8')) as unknown;
    cachedState = normalizeState(parsed) || createState();
  } catch {
    cachedState = createState();
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
