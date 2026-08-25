/**
 * Google Drive 동기화의 PC별 내구 상태.
 * config.json과 분리해 클라우드 복원으로 동기화 제어 정보가 덮이지 않게 한다.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AppConfig, GoogleChecklistSyncOperation } from '../shared/types';
import { log } from './logger';

const STATE_FILE_NAME = 'cloud-sync-state.json';
const STATE_SCHEMA_VERSION = 1;

export type ChecklistOutboxEntry = GoogleChecklistSyncOperation;

export interface CloudSyncLocalState {
  schemaVersion: number;
  deviceId: string;
  generationId: string;
  createdAt: number;
  profileState: 'fresh' | 'established' | 'needs-confirmation';
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
  lastPullAt?: number;
}

let cachedState: CloudSyncLocalState | null = null;

function detectProfileState(): CloudSyncLocalState['profileState'] {
  const userData = app.getPath('userData');
  const configPath = path.join(userData, 'config.json');
  const diaryPath = path.join(userData, 'diary.db');
  if (fs.existsSync(configPath) || fs.existsSync(diaryPath)) return 'established';
  const ambiguousFiles = ['config.json.tmp', 'config.quarantine.json', 'diary.db-wal', 'diary.db-shm'];
  return ambiguousFiles.some(name => fs.existsSync(path.join(userData, name))) ? 'needs-confirmation' : 'fresh';
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
