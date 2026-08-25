import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { log } from './logger';
import * as config from './config';
import * as diaryDb from './diaryDb';
import * as contentsChecker from './contentsChecker';
import type { SyncProgressInfo, SyncResultReport } from '../shared/types';
import { broadcastToAllWindows, sendToFirstWindowByPage } from './windowMessaging';
import type { WorkerDoneData } from './chatLogSyncWorker';
import { normalizeNotificationKeywords } from '../shared/keywordSanitizer';

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

/**
 * 주간 채팅 로그를 완전히 독립된 백그라운드 워커 스레드에서 안전하게 동기화합니다.
 */
export async function syncWeeklyChatLogs(options?: {
  startDate?: Date;
  endDate?: Date;
  onProgress?: (info: SyncProgressInfo) => void;
}): Promise<SyncResultReport> {
  const cfg = config.load();
  const chatLogPath = cfg.chatLogPath;

  const startDate = options?.startDate || getRecentMonday();
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
  const workerScriptPath = path.join(__dirname, 'chatLogSyncWorker.js');

  let doneData: WorkerDoneData;
  try {
    doneData = await new Promise<WorkerDoneData>((resolve, reject) => {
      const worker = new Worker(workerScriptPath, {
        workerData: {
          targetFiles,
          lootKeywords
        }
      });

      worker.on('message', (msg: { type: string; data?: any; error?: string }) => {
        if (msg.type === 'progress') {
          const progressInfo = msg.data as SyncProgressInfo;
          if (options?.onProgress) options.onProgress(progressInfo);
          broadcastToAllWindows('chat-log-sync-progress', progressInfo);
        } else if (msg.type === 'done') {
          resolve(msg.data as WorkerDoneData);
        } else if (msg.type === 'error') {
          reject(new Error(msg.error || 'Worker error'));
        }
      });

      worker.on('error', (err) => {
        reject(err);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
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

  const lootsDetected = doneData.loots.length;
  const essencesDetected = (doneData.essences || []).reduce((sum, item) => sum + item.count, 0);
  const seedsDetected = doneData.seeds.length;
  const shoutsDetected = doneData.shouts.length;
  const homeworkDetected = Object.keys(doneData.accumulatedHomework).length;
  const elsoPointsDetected = doneData.elsoPoints.reduce((sum, item) => sum + item.amount, 0);
  const failedFiles = doneData.failedFiles || [];
  if (failedFiles.length === targetFiles.length) {
    return {
      success: false,
      startDate: startDateStr,
      endDate: endDateStr,
      totalFiles: targetFiles.length,
      totalLines: doneData.totalLines,
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

  // 메인 프로세스에서 단 1회의 트랜잭션으로 초고속 일괄 반영 (0.01초 미만 완료, UI 프리징 제로)
  const batchResult = diaryDb.batchInsertSyncResults(doneData);
  if (!batchResult.success) {
    log(`[SYNC] 주간 채팅 로그 DB 반영 실패: ${batchResult.error || '알 수 없는 오류'}`);
    return {
      success: false,
      startDate: startDateStr,
      endDate: endDateStr,
      totalFiles: targetFiles.length,
      totalLines: doneData.totalLines,
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
      error: `동기화 결과 저장 중 오류가 발생했습니다: ${batchResult.error || '알 수 없는 오류'}`
    };
  }

  const lootsAdded = batchResult.lootsAdded;
  const essencesAdded = batchResult.essencesAdded;
  const seedsAdded = batchResult.seedsAdded;
  const elsoPointsAdded = batchResult.elsoPointsAdded;
  const shoutsAdded = batchResult.shoutsAdded;

  let homeworkUpdated = 0;
  for (const [hwId, detectedCount] of Object.entries(doneData.accumulatedHomework)) {
    const updated = contentsChecker.mergeHomeworkCountFromSync(hwId, detectedCount);
    if (updated) homeworkUpdated++;
  }

  // 동기화 완료 후 다이어리 및 외치기 창에 갱신 브로드캐스트
  broadcastToAllWindows('diary-updated');
  sendToFirstWindowByPage('shout-history.html', 'shout-history-updated');

  const partial = failedFiles.length > 0;
  log(`[SYNC] 주간 채팅 로그 워커 동기화 완료: 파일 ${targetFiles.length - failedFiles.length}/${targetFiles.length}개, 득템 ${lootsDetected}건(신규 ${lootsAdded}건), 외치기 ${shoutsDetected}건(신규 ${shoutsAdded}건), 숙제 ${homeworkDetected}종(신규 ${homeworkUpdated}종), SEED ${seedsDetected}건(신규 ${seedsAdded}건), 엘소 ${elsoPointsDetected}P(신규 ${elsoPointsAdded}P), 경험의 정수 ${essencesDetected}개(신규 ${essencesAdded}개)`);

  return {
    success: true,
    startDate: startDateStr,
    endDate: endDateStr,
    totalFiles: targetFiles.length,
    totalLines: doneData.totalLines,
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
    partial,
    failedFiles,
  };
}
