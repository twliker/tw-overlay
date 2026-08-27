import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { log } from './logger';
import * as config from './config';
import * as diaryDb from './diaryDb';
import * as contentsChecker from './contentsChecker';
import type { SyncProgressInfo, SyncResultReport } from '../shared/types';
import { broadcastToAllWindows, sendToFirstWindowByPage } from './windowMessaging';
import { normalizeNotificationKeywords } from '../shared/keywordSanitizer';
import { getHomeworkResetCycleKey } from '../shared/homeworkResetCycle';
import {
  createChatLogSyncJobId,
  type ChatLogFileAggregate,
  type ChatLogSyncBatchAck,
  type ChatLogSyncBatchData,
  type ChatLogSyncWorkerMessage,
  type WorkerDoneData,
  type WorkerSyncTargetFile,
} from './chatLogSyncProtocol';
import {
  canResumeChatLogFile,
  createDurableFileState,
  getChatLogSyncStateKey,
  inspectChatLogFileAsyncWithRetry,
  loadChatLogSyncState,
  saveChatLogSyncStateAsync,
} from './chatLogSyncState';

/**
 * 테일즈위버 주간 초기화 기준인 최근 월요일(00:00:00) Date 객체를 반환합니다.
 */
export function getRecentMonday(baseDate: Date = new Date()): Date {
  const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const day = date.getDay(); // 0: 일, 1: 월, 2: 화, 3: 수, 4: 목, 5: 금, 6: 토
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** 모험일지 정리 정책과 동일하게 오늘을 포함해 보존하는 가장 오래된 날짜를 반환한다. */
export function getDiaryRetentionStartDate(keepDays: number, baseDate: Date = new Date()): Date {
  const safeKeepDays = Number.isFinite(keepDays)
    ? Math.max(1, Math.min(3_650, Math.trunc(keepDays)))
    : 180;
  const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  date.setDate(date.getDate() - safeKeepDays);
  return date;
}

function formatDateString(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export interface SyncTargetFile {
  filePath: string;
  fileName: string;
  fileDate: Date;
  dateStr: string;
}

export function parseChatLogFileDate(fileName: string): { fileDate: Date; dateStr: string } | null {
  const match = fileName.match(/^TWChatLog_(\d{4})_(\d{2})_(\d{2})\.html$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const fileDate = new Date(year, month, day);
  if (
    fileDate.getFullYear() !== year
    || fileDate.getMonth() !== month
    || fileDate.getDate() !== day
  ) return null;
  return {
    fileDate,
    dateStr: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * 동기화 대상 로그 파일 목록을 조회합니다.
 */
export async function getSyncTargetLogFiles(
  chatLogPath: string,
  startDate: Date = getRecentMonday(),
  endDate: Date = new Date()
): Promise<SyncTargetFile[]> {
  if (!chatLogPath || !fs.existsSync(chatLogPath)) {
    return [];
  }

  const files = await fsp.readdir(chatLogPath);
  const startMs = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0).getTime();
  const endMs = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59).getTime();

  const matched: SyncTargetFile[] = [];

  for (const fileName of files) {
    const parsedDate = parseChatLogFileDate(fileName);
    if (parsedDate) {
      const { fileDate, dateStr } = parsedDate;
      const fileMs = fileDate.getTime();

      if (fileMs >= startMs && fileMs <= endMs) {
        matched.push({
          filePath: path.join(chatLogPath, fileName),
          fileName,
          fileDate,
          dateStr
        });
      }
    }
  }

  // 날짜 오름차순 정렬 (월요일 -> 화요일 -> ...)
  return matched.sort((a, b) => a.fileDate.getTime() - b.fileDate.getTime());
}

function parseTimeToSeconds(timeStr: string): number {
  const match = timeStr.match(/(\d+)시\s*(\d+)분\s*(\d+)초/);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  return h * 3600 + m * 60 + s;
}

function formatKoreanNumber(val: number): string {
  if (val >= 100000000) {
    const eok = Math.floor(val / 100000000);
    const man = Math.floor((val % 100000000) / 10000);
    return man > 0 ? `${eok}억 ${man}만` : `${eok}억`;
  }
  if (val >= 10000) {
    return `${Math.floor(val / 10000)}만`;
  }
  return val.toLocaleString();
}

interface ChatLogSyncOptions {
  startDate?: Date;
  endDate?: Date;
  onProgress?: (info: SyncProgressInfo) => void;
}

let activeChatLogSyncPromise: Promise<SyncResultReport> | null = null;

/** 같은 DB·상태 파일을 쓰는 과거 로그 복원은 항상 single-flight로 실행한다. */
export function syncWeeklyChatLogs(options?: ChatLogSyncOptions): Promise<SyncResultReport> {
  if (activeChatLogSyncPromise) return activeChatLogSyncPromise;
  const running = runChatLogSync(options).finally(() => {
    if (activeChatLogSyncPromise === running) activeChatLogSyncPromise = null;
  });
  activeChatLogSyncPromise = running;
  return running;
}

/** 모험일지 보관 기간 안의 채팅 로그를 독립 워커에서 안전하게 동기화합니다. */
async function runChatLogSync(options?: ChatLogSyncOptions): Promise<SyncResultReport> {
  const cfg = config.load();
  const chatLogPath = cfg.chatLogPath;

  const startDate = options?.startDate || getDiaryRetentionStartDate(cfg.diaryKeepDays ?? 180);
  const endDate = options?.endDate || new Date();
  const startDateStr = formatDateString(startDate);
  const endDateStr = formatDateString(endDate);

  if (!chatLogPath || !fs.existsSync(chatLogPath)) {
    return {
      success: false,
      startDate: startDateStr,
      endDate: endDateStr,
      totalFiles: 0,
      totalLines: 0,
      lootsAdded: 0,
      shoutsAdded: 0,
      homeworkUpdated: 0,
      seedsAdded: 0,
      elsoPointsAdded: 0,
      essencesAdded: 0,
      lootsDetected: 0,
      homeworkDetected: 0,
      shoutsDetected: 0,
      seedsDetected: 0,
      elsoPointsDetected: 0,
      essencesDetected: 0,
      error: '채팅 로그 폴더 경로가 설정되지 않았거나 존재하지 않습니다.'
    };
  }

  const targetFiles = await getSyncTargetLogFiles(chatLogPath, startDate, endDate);
  if (targetFiles.length === 0) {
    return {
      success: true,
      startDate: startDateStr,
      endDate: endDateStr,
      totalFiles: 0,
      totalLines: 0,
      lootsAdded: 0,
      shoutsAdded: 0,
      homeworkUpdated: 0,
      seedsAdded: 0,
      elsoPointsAdded: 0,
      essencesAdded: 0,
      lootsDetected: 0,
      homeworkDetected: 0,
      shoutsDetected: 0,
      seedsDetected: 0,
      elsoPointsDetected: 0,
      essencesDetected: 0
    };
  }

  const lootKeywords = normalizeNotificationKeywords(cfg.lootKeywords);
  const syncNow = Date.now();
  const homeworkCycleKeys: Record<string, {
    rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number };
    cycleKey: string;
  }> = {};
  for (const item of cfg.contentsCheckerItems || []) {
    const rule = item.resetRule;
    if (!rule || (rule.type !== 'daily' && rule.type !== 'weekly')) continue;
    const normalizedRule = {
      type: rule.type,
      hour: rule.hour ?? 0,
      ...(rule.type === 'weekly' ? { dayOfWeek: rule.dayOfWeek ?? 1 } : {}),
    };
    homeworkCycleKeys[item.id] = {
      rule: normalizedRule,
      cycleKey: getHomeworkResetCycleKey(normalizedRule, syncNow),
    };
  }
  const policyFingerprint = createHash('sha256')
    // 리셋 주기 key는 매일/매주 바뀌므로 포함하지 않는다. 규칙 자체나 득템 설정이 바뀔 때만 재탐색한다.
    .update(JSON.stringify({
      lootMatchingPolicy: 2,
      lootKeywords,
      homeworkRules: Object.fromEntries(
        Object.entries(homeworkCycleKeys).map(([id, value]) => [id, value.rule]),
      ),
    }))
    .digest('hex');
  const workerScriptPath = path.join(__dirname, 'chatLogSyncWorker.js');
  const syncState = loadChatLogSyncState();
  const retainedStateKeys = new Set(targetFiles.map(target => getChatLogSyncStateKey(target.filePath)));
  for (const stateKey of Object.keys(syncState.files)) {
    if (!retainedStateKeys.has(stateKey)) delete syncState.files[stateKey];
  }
  const workerTargets: WorkerSyncTargetFile[] = [];
  const preflightFailedFiles: WorkerDoneData['failedFiles'] = [];
  const todayStr = formatDateString(new Date());
  for (let targetIndex = 0; targetIndex < targetFiles.length; targetIndex++) {
    const target = targetFiles[targetIndex];
    const stateKey = getChatLogSyncStateKey(target.filePath);
    const previous = syncState.files[stateKey];
    let inspection: Awaited<ReturnType<typeof inspectChatLogFileAsyncWithRetry>>;
    try {
      inspection = await inspectChatLogFileAsyncWithRetry(target.filePath, target.dateStr, previous);
    } catch (error) {
      preflightFailedFiles.push({
        fileName: target.fileName,
        date: target.dateStr,
        error: String(error),
      });
      const progressInfo: SyncProgressInfo = {
        currentFile: target.fileName,
        currentFileIndex: targetIndex + 1,
        totalFiles: targetFiles.length,
        percent: Math.round(((targetIndex + 1) / targetFiles.length) * 10),
        date: target.dateStr,
        processedLines: 0,
        lootsAdded: 0,
        shoutsAdded: 0,
        homeworkUpdated: 0,
        seedsAdded: 0,
        elsoPointsAdded: 0,
        phase: 'preparing',
        failedFiles: [...preflightFailedFiles],
      };
      if (options?.onProgress) options.onProgress(progressInfo);
      broadcastToAllWindows('chat-log-sync-progress', progressInfo);
      continue;
    }
    const replaceAutomaticDateOnComplete = target.dateStr === todayStr;
    const canResume = !replaceAutomaticDateOnComplete
      && canResumeChatLogFile(previous, inspection, target.dateStr, policyFingerprint);
    const durable = canResume ? {
      ...previous,
      // 파일별 숙제 누적치는 해당 파일 날짜가 여전히 현재 리셋 주기에 속할 때만 재사용한다.
      homework: Object.fromEntries(Object.entries(previous.homework).filter(([id]) => {
        const cycle = homeworkCycleKeys[id];
        if (!cycle) return false;
        const [year, month, day] = target.dateStr.split('-').map(Number);
        const fileEnd = new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
        return getHomeworkResetCycleKey(cycle.rule, fileEnd) === cycle.cycleKey;
      })),
      snapshotSize: inspection.snapshotSize,
      updatedAt: Date.now(),
    } : createDurableFileState(
      target.filePath,
      target.fileName,
      target.dateStr,
      inspection.fingerprint,
      policyFingerprint,
      inspection.fingerprintBytes,
      inspection.snapshotSize,
    );
    syncState.files[stateKey] = durable;
    workerTargets.push({
      filePath: target.filePath,
      fileName: target.fileName,
      dateStr: target.dateStr,
      fingerprint: durable.fingerprint,
      policyFingerprint,
      fingerprintBytes: durable.fingerprintBytes,
      startOffset: durable.confirmedOffset,
      snapshotSize: inspection.snapshotSize,
      encoding: inspection.encoding,
      aggregate: {
        totalLines: durable.totalLines,
        lootsDetected: durable.lootsDetected,
        essencesDetected: durable.essencesDetected,
        shoutsDetected: durable.shoutsDetected,
        seedsDetected: durable.seedsDetected,
        elsoPointsDetected: durable.elsoPointsDetected,
        homework: durable.homework,
        magicStones: durable.magicStones,
        elsoByDate: durable.elsoByDate,
        goldPouchSeedByDate: durable.goldPouchSeedByDate,
      },
      replaceAutomaticDateOnComplete,
    });
    const progressInfo: SyncProgressInfo = {
      currentFile: target.fileName,
      currentFileIndex: targetIndex + 1,
      totalFiles: targetFiles.length,
      percent: Math.round(((targetIndex + 1) / targetFiles.length) * 10),
      date: target.dateStr,
      processedLines: 0,
      lootsAdded: 0,
      shoutsAdded: 0,
      homeworkUpdated: 0,
      seedsAdded: 0,
      elsoPointsAdded: 0,
      phase: 'preparing',
      failedFiles: [...preflightFailedFiles],
    };
    if (options?.onProgress) options.onProgress(progressInfo);
    broadcastToAllWindows('chat-log-sync-progress', progressInfo);
  }
  await saveChatLogSyncStateAsync(syncState);
  const jobId = createChatLogSyncJobId();

  const committed = {
    lootsAdded: 0,
    essencesAdded: 0,
    seedsAdded: 0,
    elsoPointsAdded: 0,
    shoutsAdded: 0,
  };
  let todayRebuilt = false;
  let todayRebuildDeferred = false;

  let doneData: WorkerDoneData;
  try {
    doneData = await new Promise<WorkerDoneData>((resolve, reject) => {
      const worker = new Worker(workerScriptPath, {
        workerData: {
          jobId,
          targetFiles: workerTargets,
          lootKeywords,
          homeworkCycleKeys,
        }
      });

      let settled = false;
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
        void worker.terminate();
      };

      worker.on('message', async (msg: ChatLogSyncWorkerMessage) => {
        if (msg.type === 'progress') {
          const workerProgress = msg.data as SyncProgressInfo;
          const progressInfo: SyncProgressInfo = {
            ...workerProgress,
            failedFiles: [
              ...preflightFailedFiles,
              ...(workerProgress.failedFiles || []),
            ],
          };
          if (options?.onProgress) options.onProgress(progressInfo);
          broadcastToAllWindows('chat-log-sync-progress', progressInfo);
        } else if (msg.type === 'batch') {
          const batch = msg.data as ChatLogSyncBatchData;
          const ack: ChatLogSyncBatchAck = {
            type: 'batch-ack',
            jobId,
            batchId: batch.batchId,
            success: false,
          };
          try {
            if (batch.jobId !== jobId) throw new Error('채팅 로그 배치 작업 ID가 일치하지 않습니다.');
            const expected = workerTargets.find(target => target.filePath === batch.filePath);
            if (!expected || expected.fingerprint !== batch.fingerprint
              || expected.policyFingerprint !== batch.policyFingerprint) {
              throw new Error(`채팅 로그 배치 파일 fingerprint가 일치하지 않습니다: ${batch.fileName}`);
            }
            let effectiveBatch = batch;
            if (batch.replaceAutomaticDate) {
              try {
                const latestStat = await fsp.stat(batch.filePath);
                if (latestStat.size !== batch.snapshotSize) {
                  // snapshot 뒤 실시간 로그가 추가됐다면 교체가 새 기록을 지울 수 있으므로 병합으로 강등한다.
                  effectiveBatch = { ...batch, replaceAutomaticDate: undefined };
                  todayRebuildDeferred = true;
                  log(`[SYNC] 오늘 로그가 분석 중 변경되어 자동 기록 전체 교체를 보류합니다: ${batch.fileName}`);
                } else {
                  todayRebuilt = true;
                }
              } catch (error) {
                effectiveBatch = { ...batch, replaceAutomaticDate: undefined };
                todayRebuildDeferred = true;
                log(`[SYNC] 오늘 로그 최종 상태 확인 실패로 자동 기록 전체 교체를 보류합니다: ${error}`);
              }
            }
            const batchResult = diaryDb.batchInsertSyncResults(effectiveBatch);
            if (!batchResult.success) {
              throw new Error(batchResult.error || '채팅 로그 DB 배치 반영 실패');
            }

            const stateKey = getChatLogSyncStateKey(batch.filePath);
            syncState.files[stateKey] = {
              ...batch.aggregate,
              filePath: batch.filePath,
              fileName: batch.fileName,
              dateStr: batch.dateStr,
              fingerprint: batch.fingerprint,
              policyFingerprint: batch.policyFingerprint,
              fingerprintBytes: batch.fingerprintBytes,
              confirmedOffset: batch.confirmedOffset,
              snapshotSize: batch.snapshotSize,
              updatedAt: Date.now(),
            };
            await saveChatLogSyncStateAsync(syncState);
            committed.lootsAdded += batchResult.lootsAdded;
            committed.essencesAdded += batchResult.essencesAdded;
            committed.seedsAdded += batchResult.seedsAdded;
            committed.elsoPointsAdded += batchResult.elsoPointsAdded;
            committed.shoutsAdded += batchResult.shoutsAdded;
            ack.success = true;
            worker.postMessage(ack);
          } catch (error) {
            ack.error = error instanceof Error ? error.message : String(error);
            worker.postMessage(ack);
            rejectOnce(new Error(ack.error));
          }
        } else if (msg.type === 'done') {
          if (msg.data.jobId !== jobId) {
            rejectOnce(new Error('채팅 로그 워커 완료 작업 ID가 일치하지 않습니다.'));
          } else if (!settled) {
            settled = true;
            resolve(msg.data as WorkerDoneData);
            void worker.terminate();
          }
        } else if (msg.type === 'error') {
          rejectOnce(new Error(msg.error || 'Worker error'));
        }
      });

      worker.on('error', (err) => {
        rejectOnce(err);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          rejectOnce(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    });
  } catch (err) {
    log(`[SYNC] 워커 실행 오류: ${err}`);
    return {
      success: false,
      startDate: startDateStr,
      endDate: endDateStr,
      totalFiles: targetFiles.length,
      totalLines: 0,
      lootsAdded: 0,
      shoutsAdded: 0,
      homeworkUpdated: 0,
      seedsAdded: 0,
      elsoPointsAdded: 0,
      essencesAdded: 0,
      lootsDetected: 0,
      homeworkDetected: 0,
      shoutsDetected: 0,
      seedsDetected: 0,
      elsoPointsDetected: 0,
      essencesDetected: 0,
      error: `동기화 분석 중 오류 발생: ${err}`
    };
  }

  const currentFileStates = workerTargets.map(target => syncState.files[getChatLogSyncStateKey(target.filePath)])
    .filter((state): state is NonNullable<typeof state> => !!state);
  const lootsDetected = currentFileStates.reduce((sum, state) => sum + state.lootsDetected, 0);
  const essencesDetected = currentFileStates.reduce((sum, state) => sum + state.essencesDetected, 0);
  const seedsDetected = currentFileStates.reduce((sum, state) => sum + state.seedsDetected, 0);
  const shoutsDetected = currentFileStates.reduce((sum, state) => sum + state.shoutsDetected, 0);
  const elsoPointsDetected = currentFileStates.reduce((sum, state) => sum + state.elsoPointsDetected, 0);
  const accumulatedHomework: ChatLogFileAggregate['homework'] = {};
  for (const state of currentFileStates) {
    for (const [id, detected] of Object.entries(state.homework)) {
      const existing = accumulatedHomework[id];
      if (!existing) accumulatedHomework[id] = { ...detected };
      else if (detected.isIncrement) existing.count += detected.count;
      else {
        existing.count = Math.max(existing.count, detected.count);
        existing.isIncrement = false;
      }
    }
  }
  const homeworkDetected = Object.keys(accumulatedHomework).length;
  const failedFiles = [...preflightFailedFiles, ...(doneData.failedFiles || [])];
  if (failedFiles.length === targetFiles.length) {
    return {
      success: false,
      startDate: startDateStr,
      endDate: endDateStr,
      totalFiles: targetFiles.length,
      totalLines: currentFileStates.reduce((sum, state) => sum + state.totalLines, 0),
      lootsAdded: 0,
      shoutsAdded: 0,
      homeworkUpdated: 0,
      seedsAdded: 0,
      elsoPointsAdded: 0,
      essencesAdded: 0,
      lootsDetected,
      homeworkDetected,
      shoutsDetected,
      seedsDetected,
      elsoPointsDetected,
      essencesDetected,
      failedFiles,
      error: `모든 채팅 로그 파일을 읽지 못했습니다: ${failedFiles.map(file => file.fileName).join(', ')}`,
    };
  }

  const { lootsAdded, essencesAdded, seedsAdded, elsoPointsAdded, shoutsAdded } = committed;

  let homeworkUpdated = 0;
  const finalizingProgress: SyncProgressInfo = {
    currentFile: '',
    currentFileIndex: targetFiles.length,
    totalFiles: targetFiles.length,
    percent: 100,
    date: endDateStr,
    processedLines: currentFileStates.reduce((sum, state) => sum + state.totalLines, 0),
    lootsAdded,
    shoutsAdded,
    homeworkUpdated: 0,
    seedsAdded,
    elsoPointsAdded,
    phase: 'finalizing',
    failedFiles,
  };
  if (options?.onProgress) options.onProgress(finalizingProgress);
  broadcastToAllWindows('chat-log-sync-progress', finalizingProgress);
  for (const [hwId, detected] of Object.entries(accumulatedHomework)) {
    const updated = contentsChecker.mergeHomeworkCountFromSync(hwId, detected.count);
    if (updated) homeworkUpdated++;
  }

  // 동기화 완료 후 다이어리 및 외치기 창에 갱신 브로드캐스트
  broadcastToAllWindows('diary-updated');
  sendToFirstWindowByPage('shout-history.html', 'shout-history-updated');

  const partial = failedFiles.length > 0;
  log(`[SYNC] 과거 채팅 로그 워커 동기화 완료: 파일 ${targetFiles.length - failedFiles.length}/${targetFiles.length}개, 득템 ${lootsDetected}건(신규 ${lootsAdded}건), 외치기 ${shoutsDetected}건(신규 ${shoutsAdded}건), 숙제 ${homeworkDetected}종(신규 ${homeworkUpdated}종), SEED ${seedsDetected}건(신규 ${seedsAdded}건), 엘소 ${elsoPointsDetected}P(신규 ${elsoPointsAdded}P), 경험의 정수 ${essencesDetected}개(신규 ${essencesAdded}개)`);

  return {
    success: true,
    startDate: startDateStr,
    endDate: endDateStr,
    totalFiles: targetFiles.length,
    totalLines: currentFileStates.reduce((sum, state) => sum + state.totalLines, 0),
    // 신규 반영 결과
    lootsAdded,
    homeworkUpdated,
    shoutsAdded,
    seedsAdded,
    elsoPointsAdded,
    essencesAdded,
    // 로그 총 검출 결과
    lootsDetected,
    homeworkDetected,
    shoutsDetected,
    seedsDetected,
    elsoPointsDetected,
    essencesDetected,
    todayRebuilt,
    todayRebuildDeferred,
    partial,
    failedFiles,
  };
}
