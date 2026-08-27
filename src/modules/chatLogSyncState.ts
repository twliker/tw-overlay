import { createHash } from 'crypto';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { detectChatLogEncoding, type ChatLogEncoding } from './chatLogNormalizer';
import { getChatLogReadRetryDelayMs, isRetryableChatLogReadError } from './chatLogFileRetry';
import {
  createEmptyChatLogFileAggregate,
  type ChatLogFileAggregate,
  type DurableChatLogFileState,
} from './chatLogSyncProtocol';

const STATE_FILE_NAME = 'chat-log-sync-state.json';
const STATE_SCHEMA_VERSION = 2;
// 모험일지 보관 기간의 최대값(3,650일)과 당일 파일을 모두 보존할 수 있는 안전 상한이다.
const MAX_STATE_FILES = 4_096;
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
  const goldPouchSeedByDate: ChatLogFileAggregate['goldPouchSeedByDate'] = {};
  if (parsed.goldPouchSeedByDate && typeof parsed.goldPouchSeedByDate === 'object') {
    for (const [date, info] of Object.entries(parsed.goldPouchSeedByDate)) {
      if (!info || typeof info !== 'object'
        || typeof info.latestTime !== 'string'
        || typeof info.totalAmount !== 'number' || !Number.isFinite(info.totalAmount)) continue;
      goldPouchSeedByDate[date] = { latestTime: info.latestTime, totalAmount: Math.max(0, info.totalAmount) };
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
    goldPouchSeedByDate,
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
        || typeof file.fingerprint !== 'string'
        || typeof file.policyFingerprint !== 'string') continue;
      files[key] = {
        ...normalizeAggregate(file),
        filePath: file.filePath,
        fileName: file.fileName,
        dateStr: file.dateStr,
        fingerprint: file.fingerprint,
        policyFingerprint: file.policyFingerprint,
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

export async function saveChatLogSyncStateAtPathAsync(
  userDataPath: string,
  state: ChatLogSyncLocalState,
): Promise<void> {
  const statePath = path.join(userDataPath, STATE_FILE_NAME);
  const tempPath = `${statePath}.tmp`;
  await fsp.mkdir(userDataPath, { recursive: true });
  const retained = Object.entries(state.files)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_STATE_FILES);
  const serialized: ChatLogSyncLocalState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    files: Object.fromEntries(retained),
  };
  const handle = await fsp.open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, statePath);
}

export function loadChatLogSyncState(): ChatLogSyncLocalState {
  return loadChatLogSyncStateAtPath(app.getPath('userData'));
}

export function saveChatLogSyncState(state: ChatLogSyncLocalState): void {
  saveChatLogSyncStateAtPath(app.getPath('userData'), state);
}

export async function saveChatLogSyncStateAsync(state: ChatLogSyncLocalState): Promise<void> {
  await saveChatLogSyncStateAtPathAsync(app.getPath('userData'), state);
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

export async function inspectChatLogFileWithRetry(
  filePath: string,
  dateStr: string,
  previous?: DurableChatLogFileState,
  inspect: typeof inspectChatLogFile = inspectChatLogFile,
  wait: (delayMs: number) => Promise<void> = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
): Promise<ReturnType<typeof inspectChatLogFile>> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return inspect(filePath, dateStr, previous);
    } catch (error) {
      if (!isRetryableChatLogReadError(error) || attempt === 4) throw error;
      await wait(getChatLogReadRetryDelayMs(attempt));
    }
  }
  throw new Error('채팅 로그 사전 검사 재시도 상태가 올바르지 않습니다.');
}

async function readRangeAsync(
  handle: fsp.FileHandle,
  start: number,
  length: number,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(buffer, totalRead, length - totalRead, start + totalRead);
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  return totalRead === length ? buffer : buffer.subarray(0, totalRead);
}

/** 대량 로그 사전 검사에서 메인 이벤트 루프를 막지 않는 비동기 구현. */
export async function inspectChatLogFileAsync(
  filePath: string,
  dateStr: string,
  previous?: DurableChatLogFileState,
): Promise<ReturnType<typeof inspectChatLogFile>> {
  const stat = await fsp.stat(filePath);
  const snapshotSize = stat.size;
  const reusableProbeBytes = previous
    && previous.fingerprintBytes > 0
    && previous.fingerprintBytes <= snapshotSize
    ? previous.fingerprintBytes : undefined;
  const fingerprintBytes = reusableProbeBytes ?? Math.min(snapshotSize, MAX_FINGERPRINT_BYTES);
  const handle = await fsp.open(filePath, 'r');
  try {
    const prefix = await readRangeAsync(handle, 0, fingerprintBytes);
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
      await readRangeAsync(handle, 0, sampleLength),
      Buffer.from('\n'),
      await readRangeAsync(handle, middleStart, sampleLength),
      Buffer.from('\n'),
      await readRangeAsync(handle, endStart, sampleLength),
    ]);
    return {
      fingerprint,
      fingerprintBytes,
      snapshotSize,
      encoding: detectChatLogEncoding(encodingProbe),
    };
  } finally {
    await handle.close();
  }
}

export async function inspectChatLogFileAsyncWithRetry(
  filePath: string,
  dateStr: string,
  previous?: DurableChatLogFileState,
  inspect: typeof inspectChatLogFileAsync = inspectChatLogFileAsync,
  wait: (delayMs: number) => Promise<void> = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
): Promise<Awaited<ReturnType<typeof inspectChatLogFileAsync>>> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await inspect(filePath, dateStr, previous);
    } catch (error) {
      if (!isRetryableChatLogReadError(error) || attempt === 4) throw error;
      await wait(getChatLogReadRetryDelayMs(attempt));
    }
  }
  throw new Error('채팅 로그 비동기 사전 검사 재시도 상태가 올바르지 않습니다.');
}

export function canResumeChatLogFile(
  previous: DurableChatLogFileState | undefined,
  inspection: { fingerprint: string; snapshotSize: number },
  dateStr: string,
  policyFingerprint?: string,
): previous is DurableChatLogFileState {
  return !!previous
    && previous.fingerprint === inspection.fingerprint
    && previous.dateStr === dateStr
    && (policyFingerprint === undefined || previous.policyFingerprint === policyFingerprint)
    && previous.confirmedOffset <= inspection.snapshotSize;
}

export function createDurableFileState(
  filePath: string,
  fileName: string,
  dateStr: string,
  fingerprint: string,
  policyFingerprint: string,
  fingerprintBytes: number,
  snapshotSize: number,
): DurableChatLogFileState {
  return {
    ...createEmptyChatLogFileAggregate(),
    filePath,
    fileName,
    dateStr,
    fingerprint,
    policyFingerprint,
    fingerprintBytes,
    confirmedOffset: 0,
    snapshotSize,
    updatedAt: Date.now(),
  };
}
