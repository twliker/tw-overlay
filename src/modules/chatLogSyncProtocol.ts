import { createHash, randomUUID } from 'crypto';
import type { ChatLogEncoding } from './chatLogNormalizer';

export const CHAT_SYNC_BATCH_LINE_LIMIT = 2_000;
export const CHAT_SYNC_BATCH_EVENT_LIMIT = 250;
export const CHAT_SYNC_READ_CHUNK_BYTES = 256 * 1024;

export interface SyncHomeworkAggregate {
  count: number;
  isIncrement: boolean;
}

export interface SyncHomeworkHistoryAggregate extends SyncHomeworkAggregate {
  /** 해당 파일에서 이 숙제 집계를 마지막으로 갱신한 실제 채팅 로그 시각. */
  latestTimestamp: number;
}

export interface SyncMagicStoneAggregate {
  latestTime: string;
  totalCount: number;
}

export interface SyncElsoAggregate {
  latestTime: string;
  totalAmount: number;
}

export interface SyncGoldPouchSeedAggregate {
  latestTime: string;
  totalAmount: number;
}

export interface ChatLogFileAggregate {
  totalLines: number;
  lootsDetected: number;
  essencesDetected: number;
  shoutsDetected: number;
  seedsDetected: number;
  elsoPointsDetected: number;
  /** 현재 리셋 주기의 체크리스트 반영용 집계. */
  homework: Record<string, SyncHomeworkAggregate>;
  /** 과거 모험일지 복원용 리셋 주기별 집계. */
  homeworkByCycle: Record<string, Record<string, SyncHomeworkHistoryAggregate>>;
  magicStones: Record<string, Record<string, SyncMagicStoneAggregate>>;
  elsoByDate: Record<string, SyncElsoAggregate>;
  goldPouchSeedByDate: Record<string, SyncGoldPouchSeedAggregate>;
}

export interface DurableChatLogFileState extends ChatLogFileAggregate {
  filePath: string;
  fileName: string;
  dateStr: string;
  fingerprint: string;
  policyFingerprint: string;
  fingerprintBytes: number;
  confirmedOffset: number;
  snapshotSize: number;
  updatedAt: number;
}

export interface WorkerSyncTargetFile {
  filePath: string;
  fileName: string;
  dateStr: string;
  fingerprint: string;
  policyFingerprint: string;
  fingerprintBytes: number;
  startOffset: number;
  snapshotSize: number;
  encoding: ChatLogEncoding;
  aggregate: ChatLogFileAggregate;
  /** 파일 분석 완료까지 기록 적용을 보류한다. 프로필 모드의 오늘 파일은 tail 인수인계에 사용한다. */
  replaceAutomaticDateOnComplete?: boolean;
  /** 실시간 tail이 멈춘 오늘 파일은 snapshot 이후 증가분을 메인 프로세스가 이어서 처리한다. */
  catchUpAfterReplace?: boolean;
  /** 다른 프로필/기존 미배정에 이미 귀속된 구간. 외치기는 공통이므로 계속 분석한다. */
  excludedRanges?:Array<{start:number;end:number}>;
  aggregateOwnerKey?:string;
  knownLines?: Record<string, string | null>;
  legacyOwnedRanges?: Array<{start:number;end:number}>;
  repairKnownActivities?: boolean;
}

export interface ParsedLootEvent {
  eventId?: string;
  repairOnly?: boolean;
  lineKey?: string;
  date: string;
  timeOnly: string;
  diaryContent: string;
  count: number;
}

export interface ParsedShoutEvent {
  shoutKind?: import('../shared/types').ShoutKind;
  eventId?: string;
  fullTimestamp: number;
  sender: string;
  message: string;
}

export interface ParsedSeedEvent {
  eventId?: string;
  repairOnly?: boolean;
  lineKey?: string;
  date: string;
  timeOnly: string;
  content: string;
  amount: number;
}

export interface ParsedElsoEvent {
  eventId?:string;
  date: string;
  timeOnly: string;
  amount: number;
}

export interface ParsedGoldPouchSeedEvent {
  eventId?:string;
  date: string;
  timeOnly: string;
  amount: number;
}

export interface ChatLogSyncBatchData {
  jobId: string;
  batchId: string;
  filePath: string;
  fileName: string;
  dateStr: string;
  fingerprint: string;
  policyFingerprint: string;
  fingerprintBytes: number;
  confirmedOffset: number;
  snapshotSize: number;
  fileComplete: boolean;
  aggregate: ChatLogFileAggregate;
  loots: ParsedLootEvent[];
  essences: ParsedLootEvent[];
  shouts: ParsedShoutEvent[];
  seeds: ParsedSeedEvent[];
  elsoPoints: ParsedElsoEvent[];
  goldPouchSeeds?: ParsedGoldPouchSeedEvent[];
  scopedLogRecords?: boolean;
  lineKeys?: string[];
  /** 지정 날짜의 채팅 로그 유래 automatic row를 이 배치 결과로 원자 교체한다. */
  replaceAutomaticDate?: string;
}

export interface WorkerDoneData {
  jobId: string;
  failedFiles: Array<{ fileName: string; date: string; error: string }>;
}

export interface WorkerProgressMessage {
  type: 'progress';
  data: unknown;
}

export interface WorkerBatchMessage {
  type: 'batch';
  data: ChatLogSyncBatchData;
}

export interface WorkerDoneMessage {
  type: 'done';
  data: WorkerDoneData;
}

export interface WorkerErrorMessage {
  type: 'error';
  error: string;
}

export type ChatLogSyncWorkerMessage = WorkerProgressMessage | WorkerBatchMessage | WorkerDoneMessage | WorkerErrorMessage;

export interface ChatLogSyncBatchAck {
  type: 'batch-ack';
  jobId: string;
  batchId: string;
  success: boolean;
  error?: string;
}

export function createEmptyChatLogFileAggregate(): ChatLogFileAggregate {
  return {
    totalLines: 0,
    lootsDetected: 0,
    essencesDetected: 0,
    shoutsDetected: 0,
    seedsDetected: 0,
    elsoPointsDetected: 0,
    homework: {},
    homeworkByCycle: {},
    magicStones: {},
    elsoByDate: {},
    goldPouchSeedByDate: {},
  };
}

export function createChatLogSyncJobId(): string {
  return randomUUID();
}

export function createStableChatSyncEventId(
  fingerprint: string,
  byteOffset: number,
  kind: string,
  sequence: number,
): string {
  return createHash('sha256')
    .update(`${fingerprint}\0${Math.max(0, Math.trunc(byteOffset))}\0${kind}\0${Math.max(0, Math.trunc(sequence))}`)
    .digest('hex');
}

/** 복사본의 경로/생성일과 무관한 채팅 줄 식별자. 바이트 위치는 줄바꿈까지 포함한 원본 기준이다. */
export function createChatLogLineKey(date:string,timestamp:string,line:string,offset:number):string {
  const time=timestamp.match(/\d+/g)?.map(part=>part.padStart(2,'0')).join(':') ?? '';
  return createHash('sha256').update(`${date}\0${time}\0${offset}\0`).update(line).digest('hex');
}
