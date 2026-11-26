/**
 * 기능 계약 — 과거 채팅 로그 복구 오케스트레이터
 *
 * - 모험일지 보존 기간과 숙제 복구에 필요한 최근 주간 범위의 로그 파일만 worker에 전달하며,
 *   파일명 날짜·실제 경로·크기/변경 상태를 검증한 대상만 처리합니다.
 * - CPU가 큰 파싱은 worker에서 수행하고 DB 쓰기와 숙제 상태 반영은 메인 프로세스가 batch ACK 단위로
 *   확정합니다. ACK 전에 완료 offset을 저장하면 충돌/종료 후 데이터가 영구 누락될 수 있습니다.
 * - 파일 fingerprint뿐 아니라 파싱 정책 버전도 sync state에 포함합니다. 정책을 고쳐 이미 완료된 파일을
 *   다시 읽어야 할 때 버전을 올리고, 안정적인 event ID와 DB 멱등성으로 기존 기록 중복을 막습니다.
 * - 재분석은 파일 처음부터 읽습니다. 프로필 모드는 이미 기록한 줄의 귀속을 유지하고 새 줄만 추가합니다.
 *   오늘 파일은 실시간 감시를 잠시 멈춰 분석한 뒤 그사이 추가된 구간을 읽고 감시를 재개합니다.
 * - 프로필 모드는 복원 시작 시 대상과 플레이 세션을 고정합니다. 활동 기록·줄 키·확정 위치를
 *   한 transaction에서 확정하고 ACK하며, 외치기는 공통으로 유지합니다. 구형 경로 정보는
 *   확인할 수 있는 이전 귀속에 사용합니다. 줄 키와 진행 위치는 로컬에 보관합니다.
 * - 복원 중 전환/삭제와 프로필 설정·숙제 편집을 막고 자동 이벤트는 durable 대기로 보존합니다.
 *   성공/실패 모두 시작한 세션의 대기를 재생하며, 새 미선택 게임 세션은 임의 배정하지 않습니다.
 *   프로필 기능 활성화 전에는 기존 JSON 진행 상태와 char-main 정책을 그대로 사용합니다.
 * - 실시간 `chatLogManager`와 같은 로그를 볼 수 있으므로 결과 의미는 `chatLogProcessor`와 일치해야 합니다.
 *   경험의 정수 직접 획득·100억 감소 교환처럼 키워드 독립 정책을 두 경로 중 한쪽에만 적용하지 않습니다.
 * - 취소·worker 오류·앱 종료 시 마지막 ACK 지점까지 재개할 수 있어야 하며, 진행률 완료를 데이터 저장
 *   완료보다 먼저 사용자에게 보내지 않습니다.
 */
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { log } from './logger';
import * as config from './config';
import * as diaryDb from './diaryDb';
import type { SyncedHomeworkLogInput } from './diaryDb';
import * as contentsChecker from './contentsChecker';
import { MAIN_CHAR_ID, type SyncProgressInfo, type SyncResultReport } from '../shared/types';
import { broadcastToAllWindows, sendToFirstWindowByPage } from './windowMessaging';
import { normalizeNotificationKeywords } from '../shared/keywordSanitizer';
import { getHomeworkCycleEnd, getHomeworkCycleStart, getHomeworkResetCycleKey } from '../shared/homeworkResetCycle';
import { foldHomeworkCycleLedger, foldHomeworkCycleProgress, type HomeworkCycleContribution, type HomeworkCycleLedger } from '../shared/homeworkCycleProgress';
import { findLastCompleteChatLogOffset } from './chatLogFileReader';
import { chatLogManager, type ChatLogSyncPauseToken } from './chatLogManager';
import {beginProfileLogRestore} from './profileLogRestore';
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

/** 모험일지 정리 정책과 같은 시작일. 영구 보관에서는 시작일 제한이 없다. */
export function getDiaryRetentionStartDate(keepDays: number, baseDate: Date = new Date()): Date | null {
  if (keepDays === 0) return null;
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
  startDate: Date | null = getRecentMonday(),
  endDate: Date = new Date()
): Promise<SyncTargetFile[]> {
  if (!chatLogPath || !fs.existsSync(chatLogPath)) {
    return [];
  }

  const files = await fsp.readdir(chatLogPath);
  const startMs = startDate ? new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime() : -Infinity;
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
  profileId?:string;
  startDate?: Date;
  endDate?: Date;
  onProgress?: (info: SyncProgressInfo) => void;
  /** 완료 위치를 무시하고 파일 전체를 다시 분석한다. 프로필 일지에서는 새 줄만 추가한다. */
  reanalyzeCompletedLogs?: boolean;
}

export interface HomeworkSyncDefinition {
  rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number };
  cycleKey: string;
  maxCount: number;
  name: string;
  category: string;
  isVisible: boolean;
  replayExclusions?:Array<{start:number;end:number}>;
}

/** 'daily:1700000000000' 형식의 주기 키에서 주기 시작 시각을 읽는다. */
export function parseHomeworkCycleStart(cycleKey: string): number {
  return Number(cycleKey.slice(cycleKey.indexOf(':') + 1));
}

/** 복원 파일별·주기별·숙제별 집계를 장부의 'restore:<로그 날짜>' 행 형태로 펼친다. 파일 집계는 그 파일에서
 * 그 프로필이 소유한 줄 전체(이미 실시간·배정으로 기록한 줄 포함)이므로 장부에서는 base·event와 더하지 않는다. */
export function collectRestoredHomeworkCycleProgress(
  states: Array<Pick<WorkerSyncTargetFile['aggregate'], 'homeworkByCycle'> & { dateStr: string }>,
  definitions: Record<string, HomeworkSyncDefinition>,
): Array<{ itemId: string; cycleStart: number; logDate: string; count: number; isIncrement: boolean; occurredAt: number }> {
  return states.flatMap(state => Object.entries(state.homeworkByCycle || {}).flatMap(([cycleKey, items]) =>
    Object.entries(items).filter(([id, detected]) => definitions[id]?.isVisible && detected.count > 0 && detected.latestTimestamp > 0)
      .map(([itemId, detected]) => ({
        itemId, cycleStart: parseHomeworkCycleStart(cycleKey), logDate: state.dateStr,
        count: detected.count, isIncrement: detected.isIncrement, occurredAt: detected.latestTimestamp,
      }))));
}

/**
 * 파일별 숙제 이벤트를 리셋 주기 순서대로 합쳐 실제 완료에 도달한 날짜의 모험일지 행을 만든다.
 * 체크리스트의 현재 상태와 독립적으로 계산해야 지난주·지지난주 완료 이력이 현재 주기 필터에 사라지지 않는다.
 * - ledger 없음(기존 모드·현재 주기): 이번에 분석한 파일 집계만 foldHomeworkCycleProgress로 합친다.
 * - ledger 있음(프로필 모드의 지난 주기): 그 주기의 장부(체크리스트 기준값·지난 주기 배정·모든 날짜의 복원
 *   행)가 유일한 근거다. 이번 파일 집계는 이미 장부의 복원 행으로 교체되어 있으므로 다시 더하지 않는다.
 *   규칙은 지난 주기 배정과 같은 foldHomeworkCycleLedger다(원본 줄 중복 없음).
 * 일지는 날짜·숙제마다 한 행이므로 같은 날짜에 두 주기의 완료가 나오면 최신 주기만 남긴다.
 */
export function buildSyncedHomeworkLogs(
  states: Array<Pick<WorkerSyncTargetFile['aggregate'], 'homeworkByCycle'> & { dateStr: string }>,
  definitions: Record<string, HomeworkSyncDefinition>,
  mainCharacterName: string,
  characterId:string=MAIN_CHAR_ID,
  ledger?: (itemId: string, cycleStart: number) => HomeworkCycleLedger | undefined,
): SyncedHomeworkLogInput[] {
  const contributionsByCycleAndId = new Map<string, { cycleKey: string; id: string; contributions: HomeworkCycleContribution[] }>();

  for (const state of [...states].sort((left, right) => left.dateStr.localeCompare(right.dateStr))) {
    for (const [cycleKey, items] of Object.entries(state.homeworkByCycle || {})) {
      for (const [id, detected] of Object.entries(items)) {
        const definition = definitions[id];
        if (!definition || !definition.isVisible || detected.count <= 0 || detected.latestTimestamp <= 0) continue;
        const aggregateKey = `${cycleKey}\0${id}`;
        const group = contributionsByCycleAndId.get(aggregateKey) ?? { cycleKey, id, contributions: [] };
        group.contributions.push({ count: detected.count, isIncrement: detected.isIncrement, occurredAt: detected.latestTimestamp });
        contributionsByCycleAndId.set(aggregateKey, group);
      }
    }
  }

  const completions = new Map<string, SyncedHomeworkLogInput>();
  for (const { cycleKey, id, contributions } of contributionsByCycleAndId.values()) {
    const definition = definitions[id];
    const recorded = ledger?.(id, parseHomeworkCycleStart(cycleKey));
    const { completedAt } = recorded
      ? foldHomeworkCycleLedger(recorded, definition.maxCount)
      : foldHomeworkCycleProgress(0, contributions, definition.maxCount);
    if (completedAt === undefined) continue;
    const entry: SyncedHomeworkLogInput = {
      date: formatDateString(new Date(completedAt)),
      contentId: `${id}_${characterId}`,
      contentName: `[${mainCharacterName}] ${definition.name}`,
      category: definition.category,
      type: definition.rule.type,
      completedAt,
    };
    const dayKey = `${entry.date}\0${entry.contentId}`;
    const sameDay = completions.get(dayKey);
    if (!sameDay || sameDay.completedAt < completedAt) completions.set(dayKey, entry);
  }
  return [...completions.values()];
}

let activeChatLogSyncPromise: Promise<SyncResultReport> | null = null;
let activeSyncProfileId:string | undefined;
let stoppingHistoricalSync=false;
let cancelActiveSync:(()=>void) | undefined;

/** 종료 뒤 새 worker를 시작하거나 닫힌 DB에 늦은 배치를 반영하지 않는다. */
export async function stopHistoricalChatLogSync():Promise<void> {
  stoppingHistoricalSync=true;cancelActiveSync?.();
  try {await activeChatLogSyncPromise;} catch { /* 확정 배치와 대기 원본은 DB에 보존됨 */ }
}

/** 같은 DB·상태 파일을 쓰는 과거 로그 복원은 항상 single-flight로 실행한다. */
export function syncWeeklyChatLogs(options?: ChatLogSyncOptions): Promise<SyncResultReport> {
  if (stoppingHistoricalSync) return Promise.reject(new Error('앱을 종료하고 있어 과거 로그를 복원하지 않았습니다.'));
  if (activeChatLogSyncPromise) return options?.profileId===activeSyncProfileId ? activeChatLogSyncPromise : Promise.reject(new Error('다른 프로필의 과거 로그를 복원 중입니다. 완료 후 다시 시도해 주세요.'));
  activeSyncProfileId=options?.profileId;
  const running = runProfileAwareSync(options).finally(() => {
    if (activeChatLogSyncPromise === running) {activeChatLogSyncPromise = null;activeSyncProfileId=undefined;cancelActiveSync=undefined;}
  });
  activeChatLogSyncPromise = running;
  return running;
}

async function runProfileAwareSync(options?:ChatLogSyncOptions):Promise<SyncResultReport> {
  const owner=beginProfileLogRestore(options?.profileId);
  let result:SyncResultReport | undefined;
  try {result=await runChatLogSync(options,owner);return result;}
  finally {
    const warning=owner?.finish();
    if (result && owner) {result.profileId=owner.profileId;result.profileName=owner.config.characterPresets?.[0]?.name || '기본 프로필';if (warning) result.pendingReplayWarning=warning;}
  }
}

/** 모험일지 보관 기간 안의 채팅 로그를 독립 워커에서 안전하게 동기화합니다. */
async function runChatLogSync(options?: ChatLogSyncOptions,owner:ReturnType<typeof beginProfileLogRestore>=null): Promise<SyncResultReport> {
  const cfg = owner?.config || config.load();
  const chatLogPath = cfg.chatLogPath;

  const startDate = options?.startDate || getDiaryRetentionStartDate(cfg.diaryKeepDays ?? 180);
  const endDate = options?.endDate || new Date();
  const reanalyzeCompletedLogs = options?.reanalyzeCompletedLogs === true;
  let startDateStr = startDate ? formatDateString(startDate) : '';
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

  let targetFiles = await getSyncTargetLogFiles(chatLogPath, startDate, endDate);
  if (!startDate && targetFiles.length) startDateStr = targetFiles[0].dateStr;
  if (stoppingHistoricalSync) throw new Error('앱 종료로 과거 로그 복원을 중단했습니다.');
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

  const todayStr = formatDateString(new Date());
  const todayTarget = targetFiles.find(target => target.dateStr === todayStr);
  let livePauseToken: ChatLogSyncPauseToken | null = null;
  let liveLogResumed = false;
  let liveResumeOffset = 0;
  let todayCatchUpBytes = 0;
  const resumeLiveLogs=(encoding:ChatLogSyncPauseToken['encoding']) => {
    const apply=()=>{
      const result=chatLogManager.resumeAfterHistoricalSync(livePauseToken!,liveResumeOffset,encoding);
      liveLogResumed=true;
      todayCatchUpBytes=Math.max(todayCatchUpBytes,result.processedBytes);
      return result;
    };
    return owner ? owner.catchUp(apply) : apply();
  };

  if (todayTarget) {
    livePauseToken = await chatLogManager.pauseForHistoricalSync(todayTarget.filePath);
    if (livePauseToken) {
      liveResumeOffset = livePauseToken.resumeOffset;
      // 오늘 자동 기록과 실시간 감시를 먼저 정상화한 뒤 오래된 대형 파일 분석을 계속합니다.
      targetFiles = [todayTarget, ...targetFiles.filter(target => target !== todayTarget)];
    }
  }

  try {

  const lootKeywords = normalizeNotificationKeywords(cfg.lootKeywords);
  const syncNow = Date.now();
  const homeworkCycleKeys: Record<string, HomeworkSyncDefinition> = {};
  const replayExclusions=owner ? diaryDb.getHomeworkReplayExclusions(owner.profileId) : {};
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
      maxCount: Math.max(1, item.maxCount || 1),
      name: item.name,
      category: item.category,
      isVisible: item.isVisible !== false,
      ...(Object.hasOwn(replayExclusions,item.id) ? {replayExclusions:replayExclusions[item.id]} : {}),
    };
  }
  const policyFingerprint = createHash('sha256')
    // 분석 정책 fingerprint가 달라지면 완료 파일도 offset 0부터 다시 읽습니다. 이벤트 ID와
    // DB 멱등 처리가 기존 기록의 중복을 막고, 새 정책에서 과거에 놓친 기록만 보충합니다.
    // 리셋 주기 key는 매일/매주 바뀌므로 포함하지 않고 규칙 자체·득템 설정만 포함합니다.
    .update(JSON.stringify({
      // v3: v3.0.1에서 등록 목록에 종속되어 누락된 경험의 정수 직접 획득과
      // 100억 감소 교환 기록을 이미 완료 처리된 파일에서도 한 번 재탐색합니다.
      // v4: 괄호에 적힌 에타 성장 지원 정수 보상도 완료 파일에서 한 번 찾아 보충합니다.
      lootMatchingPolicy: 4,
      ...(owner ? {profileLogLinePolicy:1} : {}),
      lootKeywords,
      homeworkRules: Object.fromEntries(
        Object.entries(homeworkCycleKeys).map(([id, value]) => [id,
          value.replayExclusions ? {rule:value.rule,replayExclusions:value.replayExclusions} : value.rule]),
      ),
      homeworkDiaryPolicy: 1,
      // 조각 획득으로 집계한 이전 파일 누적치를 포탈 생성 기준으로 다시 분석한다.
      architectMineDetectionPolicy: 1,
      abandonedFeeDiaryPolicy: 1,
      shoutKindPolicy: 1,
    }))
    .digest('hex');
  const workerScriptPath = path.join(__dirname, 'chatLogSyncWorker.js');
  const syncState = owner ? owner.load() : loadChatLogSyncState();
  const retainedStateKeys = new Set(targetFiles.map(target => getChatLogSyncStateKey(target.filePath)));
  for (const stateKey of Object.keys(syncState.files)) {
    if (!retainedStateKeys.has(stateKey)) delete syncState.files[stateKey];
  }
  const workerTargets: WorkerSyncTargetFile[] = [];
  const preflightFailedFiles: WorkerDoneData['failedFiles'] = [];
  for (let targetIndex = 0; targetIndex < targetFiles.length; targetIndex++) {
    const target = targetFiles[targetIndex];
    const stateKey = getChatLogSyncStateKey(target.filePath);
    const previous = syncState.files[stateKey];
    let inspection: Awaited<ReturnType<typeof inspectChatLogFileAsyncWithRetry>>;
    try {
      inspection = await inspectChatLogFileAsyncWithRetry(target.filePath, target.dateStr, owner ? owner.probe(stateKey) : previous);
      if (stoppingHistoricalSync) throw new Error('앱 종료로 과거 로그 복원을 중단했습니다.');
      if (livePauseToken && target.dateStr === todayStr) {
        inspection = {
          ...inspection,
          snapshotSize: findLastCompleteChatLogOffset(target.filePath, inspection.snapshotSize),
        };
      }
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
    const excludedRanges=owner?.exclusions(stateKey,inspection,target.filePath,target.dateStr);
    const finishTodayBeforeCatchUp=Boolean(livePauseToken && target.dateStr===todayStr);
    const replaceAutomaticDateOnComplete = owner
      ? finishTodayBeforeCatchUp
      : reanalyzeCompletedLogs || target.dateStr===todayStr;
    const canResume = !reanalyzeCompletedLogs && (owner || !replaceAutomaticDateOnComplete)
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
        homeworkByCycle: durable.homeworkByCycle,
        magicStones: durable.magicStones,
        elsoByDate: durable.elsoByDate,
        goldPouchSeedByDate: durable.goldPouchSeedByDate,
      },
      replaceAutomaticDateOnComplete,
      catchUpAfterReplace: !!livePauseToken && target.dateStr === todayStr,
      ...(owner ? {excludedRanges,aggregateOwnerKey:owner.profileId,
        knownLines:owner.knownLines(target.dateStr),legacyOwnedRanges:owner.legacyOwnedRanges(inspection.fingerprint),
        appliedRanges:owner.appliedRanges(inspection.fingerprint),
        repairKnownActivities:reanalyzeCompletedLogs} : {}),
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
  if (owner) owner.save(syncState);else await saveChatLogSyncStateAsync(syncState);
  if (stoppingHistoricalSync) throw new Error('앱 종료로 과거 로그 복원을 중단했습니다.');
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
  let automaticRecordsRebuiltDates = 0;
  let activityRecordsHeld=0;
  const automaticRebuiltDateSet = new Set<string>();
  const automaticRecordRebuildDeferredFiles: string[] = [];

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
      cancelActiveSync=()=>rejectOnce(new Error('앱 종료로 과거 로그 복원을 중단했습니다.'));

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
            if (stoppingHistoricalSync) throw new Error('앱 종료로 과거 로그 복원을 중단했습니다.');
            const expected = workerTargets.find(target => target.filePath === batch.filePath);
            if (!expected || expected.fingerprint !== batch.fingerprint
              || expected.policyFingerprint !== batch.policyFingerprint) {
              throw new Error(`채팅 로그 배치 파일 fingerprint가 일치하지 않습니다: ${batch.fileName}`);
            }
            let effectiveBatch = batch;
            if (batch.replaceAutomaticDate) {
              const isTodayRebuild = batch.replaceAutomaticDate === todayStr;
              try {
                const latestStat = await fsp.stat(batch.filePath);
                const canCatchUpGrowth = expected.catchUpAfterReplace === true
                  && latestStat.size >= batch.snapshotSize;
                if (latestStat.size !== batch.snapshotSize && !canCatchUpGrowth) {
                  // snapshot 뒤 실시간 로그가 추가됐다면 교체가 새 기록을 지울 수 있으므로 병합으로 강등한다.
                  effectiveBatch = { ...batch, replaceAutomaticDate: undefined };
                  automaticRecordRebuildDeferredFiles.push(batch.fileName);
                  if (isTodayRebuild) todayRebuildDeferred = true;
                  log(`[SYNC] 로그가 분석 중 변경되어 자동 기록 전체 교체를 보류합니다: ${batch.fileName}`);
                } else {
                  if (!owner) {
                    automaticRecordsRebuiltDates++;
                    automaticRebuiltDateSet.add(batch.replaceAutomaticDate);
                  }
                  if (isTodayRebuild) todayRebuilt = true;
                  if (canCatchUpGrowth && latestStat.size > batch.snapshotSize) {
                    log(`[SYNC] 오늘 snapshot 이후 로그를 실시간 catch-up으로 처리합니다: ${batch.fileName}`);
                  }
                }
              } catch (error) {
                effectiveBatch = { ...batch, replaceAutomaticDate: undefined };
                automaticRecordRebuildDeferredFiles.push(batch.fileName);
                if (isTodayRebuild) todayRebuildDeferred = true;
                log(`[SYNC] 로그 최종 상태 확인 실패로 자동 기록 전체 교체를 보류합니다: ${batch.fileName} (${error})`);
              }
            }
            const stateKey = getChatLogSyncStateKey(batch.filePath);
            const nextState = {
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
            const apply=() => {
              const value=diaryDb.batchInsertSyncResults({
                ...effectiveBatch,
                ...(owner ? {replaceAutomaticDate:undefined,scopedLogRecords:true} : {}),
              });
              if (!value.success) throw new Error(value.error || '채팅 로그 DB 배치 반영 실패');
              return value;
            };
            const batchResult=owner ? owner.commit(stateKey,nextState,batch.lineKeys ?? [],apply,batch.ownedSpans) : apply();
            if (batchResult.activitiesRepaired && !automaticRebuiltDateSet.has(batch.dateStr)) {
              automaticRebuiltDateSet.add(batch.dateStr);automaticRecordsRebuiltDates++;
            }
            activityRecordsHeld+=batchResult.activitiesHeld ?? 0;
            syncState.files[stateKey]=nextState;
            if (!owner) await saveChatLogSyncStateAsync(syncState);
            if (expected.catchUpAfterReplace && effectiveBatch.replaceAutomaticDate === todayStr) liveResumeOffset = batch.confirmedOffset;
            if (
              expected.catchUpAfterReplace
              && effectiveBatch.replaceAutomaticDate === todayStr
              && livePauseToken
              && !liveLogResumed
            ) {
              const catchUpProgress: SyncProgressInfo = {
                currentFile: batch.fileName,
                currentFileIndex: 1,
                totalFiles: targetFiles.length,
                percent: 95,
                date: todayStr,
                processedLines: batch.aggregate.totalLines,
                lootsAdded: batch.aggregate.lootsDetected,
                shoutsAdded: batch.aggregate.shoutsDetected,
                homeworkUpdated: Object.keys(batch.aggregate.homework).length,
                seedsAdded: batch.aggregate.seedsDetected,
                elsoPointsAdded: batch.aggregate.elsoPointsDetected,
                phase: 'catching-up',
                failedFiles: [...preflightFailedFiles],
              };
              if (options?.onProgress) options.onProgress(catchUpProgress);
              broadcastToAllWindows('chat-log-sync-progress', catchUpProgress);
              resumeLiveLogs(expected.encoding);
            }
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

  const targetCharacterId=owner?.profileId || MAIN_CHAR_ID;
  const mainCharacterName = cfg.characterPresets?.find(character => character.id === targetCharacterId)?.name
    || '메인 캐릭터';
  let syncedHomeworkLogs: SyncedHomeworkLogInput[] = [];
  /** 프로필 모드: 이번에 분석한 로그 날짜의 복원 집계로 장부의 그 날짜 복원 행만 교체한 뒤(다른 날짜 행은
   * 유지), 지난 주기는 장부 전체를 foldHomeworkCycleLedger로 판단한다. 복원 집계는 이미 실시간·배정으로
   * 기록한 줄도 담으므로 체크리스트 기준값·지난 주기 배정과 더하지 않는다(규칙: shared/homeworkCycleProgress.ts).
   * 체크리스트·지난 주기 배정이 이미 완료 일지를 남긴 주기와, 일지 날짜에 다른 주기의 완료 행이 있는 경우는
   * 기록하지 않는다. 장부 조회는 프로필 기록 문맥 안에서만 가능하다.
   * 회귀: check-profile-log-restore.ts, check-audit-regressions.ts. */
  const buildHomeworkLogs = (): SyncedHomeworkLogInput[] => {
    if (!owner) return buildSyncedHomeworkLogs(currentFileStates, homeworkCycleKeys, mainCharacterName, targetCharacterId);
    const restoredFiles = workerTargets.map(target => ({ dateStr: target.dateStr,
      homeworkByCycle: syncState.files[getChatLogSyncStateKey(target.filePath)]?.homeworkByCycle ?? {} }));
    diaryDb.replaceRestoredHomeworkCycleProgress(restoredFiles.map(file => file.dateStr),
      collectRestoredHomeworkCycleProgress(restoredFiles, homeworkCycleKeys));
    // 현재 주기는 체크리스트가 기준이며 복원 완료 시각이 체크리스트 병합의 완료 시각으로 쓰인다.
    // 장부 판단과 주기 중복 방지는 지난 주기에만 적용해 현재 주기의 기존 복원·병합 동작을 바꾸지 않는다.
    const isCurrentCycle = (itemId: string, cycleStart: number) => {
      const definition = homeworkCycleKeys[itemId];
      return !!definition && parseHomeworkCycleStart(definition.cycleKey) === cycleStart;
    };
    const ledger = diaryDb.getHomeworkCycleLedger();
    return buildSyncedHomeworkLogs(currentFileStates, homeworkCycleKeys, mainCharacterName, targetCharacterId,
      (itemId, cycleStart) => isCurrentCycle(itemId, cycleStart) ? undefined : ledger.get(diaryDb.homeworkCycleLedgerKey(itemId, cycleStart)))
      .filter(entry => {
        const itemId = entry.contentId.slice(0, -targetCharacterId.length - 1);
        const rule = homeworkCycleKeys[itemId]?.rule;
        if (!rule) return true;
        const cycleStart = getHomeworkCycleStart(rule, entry.completedAt);
        if (isCurrentCycle(itemId, cycleStart)) return true;
        const cycleEnd = getHomeworkCycleEnd(rule, entry.completedAt);
        return !diaryDb.hasHomeworkCompletionInCycle(itemId, cycleStart, cycleEnd, { includeRestored: false })
          && !diaryDb.hasOtherCycleHomeworkLogOnDate(itemId, entry.date, cycleStart, cycleEnd);
      });
  };
  const finishHomework=() => {
    if (stoppingHistoricalSync) throw new Error('앱 종료로 과거 로그 복원을 중단했습니다.');
    syncedHomeworkLogs = buildHomeworkLogs();
    const homeworkLogResult = diaryDb.upsertSyncedHomeworkLogs(syncedHomeworkLogs,[...automaticRebuiltDateSet]);
    if (!homeworkLogResult.success) throw new Error(`과거 숙제 모험일지 반영 실패: ${homeworkLogResult.error || '알 수 없는 오류'}`);
    const completionsByContent=new Map(syncedHomeworkLogs.filter(entry=>{
      const id=entry.contentId.slice(0,-targetCharacterId.length-1);
      const definition=homeworkCycleKeys[id];
      return definition && getHomeworkResetCycleKey(definition.rule,entry.completedAt)===definition.cycleKey;
    }).map(entry=>[entry.contentId,entry.completedAt]));
    for (const [hwId, detected] of Object.entries(accumulatedHomework)) {
      // 프로필 모드는 고정 프로필에, 기존 모드는 메인 캐릭터에만 병합한다.
      const completedAt=owner ? completionsByContent.get(`${hwId}_${targetCharacterId}`) : undefined;
      const updated = contentsChecker.mergeHomeworkCountFromSync(hwId, detected.count, targetCharacterId,completedAt);
      if (updated) homeworkUpdated++;
    }
  };
  // 바깥 DB commit 자체가 실패해도 메모리 설정을 이전 값으로 되돌려 재시도할 수 있어야 한다.
  if (owner) config.withConfirmedWrites(()=>owner.withRecords(finishHomework));else finishHomework();

  // 동기화 완료 후 다이어리 및 외치기 창에 갱신 브로드캐스트
  broadcastToAllWindows('diary-updated');
  sendToFirstWindowByPage('shout-history.html', 'shout-history-updated');

  const partial = failedFiles.length > 0;
  log(`[SYNC] 과거 채팅 로그 워커 동기화 완료: 파일 ${targetFiles.length - failedFiles.length}/${targetFiles.length}개, 득템 ${lootsDetected}건(신규 ${lootsAdded}건), 외치기 ${shoutsDetected}건(신규 ${shoutsAdded}건), 숙제 일지 ${syncedHomeworkLogs.length}건, 현재 주기 숙제 ${homeworkDetected}종(신규 ${homeworkUpdated}종), SEED ${seedsDetected}건(신규 ${seedsAdded}건), 엘소 ${elsoPointsDetected}P(신규 ${elsoPointsAdded}P), 경험의 정수 ${essencesDetected}개(신규 ${essencesAdded}개)`);

  return {
    success: true,
    startDate: startDateStr,
    endDate: endDateStr,
    totalFiles: targetFiles.length,
    totalLines: currentFileStates.reduce((sum, state) => sum + state.totalLines, 0),
    // 신규 반영 결과
    lootsAdded,
    homeworkUpdated,
    homeworkLogsDetected: syncedHomeworkLogs.length,
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
    todayCatchUpProcessed: liveLogResumed && todayRebuilt,
    todayCatchUpBytes,
    reanalyzedCompletedLogs: reanalyzeCompletedLogs,
    automaticRecordsRebuiltDates,
    activityRecordsHeld,
    automaticRecordRebuildDeferredFiles,
    partial,
    failedFiles,
  };
  } finally {
    if (livePauseToken && !liveLogResumed && !stoppingHistoricalSync) {
      // 분석/DB 반영이 실패해도 중지 직전 확정 위치부터 파일 queue를 재생해 실시간 기능을 복구합니다.
      try {resumeLiveLogs(livePauseToken.encoding);}
      catch (error) {
        log('[SYNC] 이전 로그 인계 실패, 현재 파일에서 감시를 다시 시작합니다: '+String(error));
        chatLogManager.resumeAfterLocalRestore(livePauseToken);
      }
    }
  }
}
