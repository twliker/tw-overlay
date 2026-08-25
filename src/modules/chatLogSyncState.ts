import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { detectChatLogEncoding, type ChatLogEncoding } from './chatLogNormalizer';
import {
  createEmptyChatLogFileAggregate,
  type ChatLogFileAggregate,
  type DurableChatLogFileState,
} from './chatLogSyncProtocol';

const STATE_FILE_NAME = 'chat-log-sync-state.json';
const STATE_SCHEMA_VERSION = 1;
const MAX_STATE_FILES = 32;
const MAX_FINGERPRINT_BYTES = 4 * 1024;
const ENCODING_SAMPLE_BYTES = 32 * 1024;

export interface ChatLogSyncLocalState {
  schemaVersion: number;
  files: Record<string, DurableChatLogFileState>;
}

function readRange(filePath: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const bytesRead = fs.readSync(fd, buffer, totalRead, length - totalRead, start + totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return totalRead === length ? buffer : buffer.subarray(0, totalRead);
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeAggregate(value: unknown): ChatLogFileAggregate {
  const empty = createEmptyChatLogFileAggregate();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const parsed = value as Partial<ChatLogFileAggregate>;
  const homework: ChatLogFileAggregate['homework'] = {};
  if (parsed.homework && typeof parsed.homework === 'object') {
    for (const [id, item] of Object.entries(parsed.homework)) {
      if (!item || typeof item !== 'object'
        || typeof item.count !== 'number' || !Number.isFinite(item.count)
        || typeof item.isIncrement !== 'boolean') continue;
      homework[id] = { count: Math.max(0, item.count), isIncrement: item.isIncrement };
    }
  }
  const magicStones: ChatLogFileAggregate['magicStones'] = {};
  if (parsed.magicStones && typeof parsed.magicStones === 'object') {
    for (const [date, grades] of Object.entries(parsed.magicStones)) {
      if (!grades || typeof grades !== 'object') continue;
      const normalizedGrades: ChatLogFileAggregate['magicStones'][string] = {};
      for (const [grade, info] of Object.entries(grades)) {
        if (!info || typeof info !== 'object'
          || typeof info.latestTime !== 'string'
          || typeof info.totalCount !== 'number' || !Number.isFinite(info.totalCount)) continue;
        normalizedGrades[grade] = { latestTime: info.latestTime, totalCount: Math.max(0, info.totalCount) };
      }
      if (Object.keys(normalizedGrades).length > 0) magicStones[date] = normalizedGrades;
    }
  }
  const elsoByDate: ChatLogFileAggregate['elsoByDate'] = {};
  if (parsed.elsoByDate && typeof parsed.elsoByDate === 'object') {
    for (const [date, info] of Object.entries(parsed.elsoByDate)) {
      if (!info || typeof info !== 'object'
        || typeof info.latestTime !== 'string'
        || typeof info.totalAmount !== 'number' || !Number.isFinite(info.totalAmount)) continue;
      elsoByDate[date] = { latestTime: info.latestTime, totalAmount: Math.max(0, info.totalAmount) };
    }
  }
  return {
    totalLines: normalizeNumber(parsed.totalLines),
    lootsDetected: normalizeNumber(parsed.lootsDetected),
    essencesDetected: normalizeNumber(parsed.essencesDetected),
    shoutsDetected: normalizeNumber(parsed.shoutsDetected),
    seedsDetected: normalizeNumber(parsed.seedsDetected),
    elsoPointsDetected: normalizeNumber(parsed.elsoPointsDetected),
    homework,
    magicStones,
    elsoByDate,
  };
}

export function getChatLogSyncStateKey(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

export function loadChatLogSyncStateAtPath(userDataPath: string): ChatLogSyncLocalState {
  const statePath = path.join(userDataPath, STATE_FILE_NAME);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<ChatLogSyncLocalState>;
    if (parsed.schemaVersion !== STATE_SCHEMA_VERSION || !parsed.files || typeof parsed.files !== 'object') {
      throw new Error('unsupported state');
    }
    const files: Record<string, DurableChatLogFileState> = {};
    for (const [key, value] of Object.entries(parsed.files)) {
      if (!value || typeof value !== 'object') continue;
      const file = value as Partial<DurableChatLogFileState>;
      if (typeof file.filePath !== 'string'
        || typeof file.fileName !== 'string'
        || typeof file.dateStr !== 'string'
        || typeof file.fingerprint !== 'string') continue;
      files[key] = {
        ...normalizeAggregate(file),
        filePath: file.filePath,
        fileName: file.fileName,
        dateStr: file.dateStr,
        fingerprint: file.fingerprint,
        fingerprintBytes: normalizeNumber(file.fingerprintBytes),
        confirmedOffset: normalizeNumber(file.confirmedOffset),
        snapshotSize: normalizeNumber(file.snapshotSize),
        updatedAt: normalizeNumber(file.updatedAt),
      };
    }
    return { schemaVersion: STATE_SCHEMA_VERSION, files };
  } catch {
    return { schemaVersion: STATE_SCHEMA_VERSION, files: {} };
  }
}

export function saveChatLogSyncStateAtPath(userDataPath: string, state: ChatLogSyncLocalState): void {
  const statePath = path.join(userDataPath, STATE_FILE_NAME);
  const tempPath = `${statePath}.tmp`;
  fs.mkdirSync(userDataPath, { recursive: true });
  const retained = Object.entries(state.files)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_STATE_FILES);
  const serialized: ChatLogSyncLocalState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    files: Object.fromEntries(retained),
  };
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, statePath);
}

export function loadChatLogSyncState(): ChatLogSyncLocalState {
  return loadChatLogSyncStateAtPath(app.getPath('userData'));
}

export function saveChatLogSyncState(state: ChatLogSyncLocalState): void {
  saveChatLogSyncStateAtPath(app.getPath('userData'), state);
}

export function inspectChatLogFile(
  filePath: string,
  dateStr: string,
  previous?: DurableChatLogFileState,
): { fingerprint: string; fingerprintBytes: number; snapshotSize: number; encoding: ChatLogEncoding } {
  const stat = fs.statSync(filePath);
  const snapshotSize = stat.size;
  const reusableProbeBytes = previous
    && previous.fingerprintBytes > 0
    && previous.fingerprintBytes <= snapshotSize
    ? previous.fingerprintBytes : undefined;
  const fingerprintBytes = reusableProbeBytes ?? Math.min(snapshotSize, MAX_FINGERPRINT_BYTES);
  const prefix = readRange(filePath, 0, fingerprintBytes);
  const fingerprint = createHash('sha256')
    .update(path.resolve(filePath).replace(/\\/g, '/').toLowerCase())
    .update('\0')
    .update(dateStr)
    .update('\0')
    .update(String(Math.trunc(stat.birthtimeMs)))
    .update('\0')
    .update(prefix)
    .digest('hex');

  const sampleLength = Math.min(snapshotSize, ENCODING_SAMPLE_BYTES);
  const middleStart = Math.max(0, Math.floor((snapshotSize - sampleLength) / 2));
  const endStart = Math.max(0, snapshotSize - sampleLength);
  const encodingProbe = Buffer.concat([
    readRange(filePath, 0, sampleLength),
    Buffer.from('\n'),
    readRange(filePath, middleStart, sampleLength),
    Buffer.from('\n'),
    readRange(filePath, endStart, sampleLength),
  ]);
  return {
    fingerprint,
    fingerprintBytes,
    snapshotSize,
    encoding: detectChatLogEncoding(encodingProbe),
  };
}

export function canResumeChatLogFile(
  previous: DurableChatLogFileState | undefined,
  inspection: { fingerprint: string; snapshotSize: number },
  dateStr: string,
): previous is DurableChatLogFileState {
  return !!previous
    && previous.fingerprint === inspection.fingerprint
    && previous.dateStr === dateStr
    && previous.confirmedOffset <= inspection.snapshotSize;
}

export function createDurableFileState(
  filePath: string,
  fileName: string,
  dateStr: string,
  fingerprint: string,
  fingerprintBytes: number,
  snapshotSize: number,
): DurableChatLogFileState {
  return {
    ...createEmptyChatLogFileAggregate(),
    filePath,
    fileName,
    dateStr,
    fingerprint,
    fingerprintBytes,
    confirmedOffset: 0,
    snapshotSize,
    updatedAt: Date.now(),
  };
}
