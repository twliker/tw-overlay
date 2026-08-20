/**
 * 세션 관리 — Tail 감시, 분석 트리거, 폴더 워치, 테스트 세션
 */
import { Tail } from 'tail';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import * as wm from '../windowManager';
import { log } from '../logger';
import type { MessengerMessage, ScamAnalysisResult, SessionState } from '../../shared/types';
import { getMsgerLogPath, getModelStatus } from './modelManager';
import { startServer, stopServer, callLlmQueued } from './serverManager';
import { parseLine, buildConversationText, parseResponse, sendAlert, END_KEYWORDS, TEST_SCENARIOS } from './parser';
import { etaCacheManager } from '../etaCacheManager';
import * as config from '../config';
import { DEFAULT_CONFIG } from '../constants';

// ── 상수 ──
const MAX_SESSIONS = 5;
const DEBOUNCE_MS = 3_000;
const ANALYSIS_INTERVAL_MS = 60_000;
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;

// ── 내부 타입 ──
interface ActiveSession {
  filePath: string;
  tail: Tail;
  messages: MessengerMessage[];
  newSinceLastAnalysis: number;
  lastMessageTime: number;
  lastAnalysisAt: number;
  analysisTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  inactivityTimer: NodeJS.Timeout | null;
  analyzing: boolean;
  lastVerdict: ScamAnalysisResult['verdict'];
  closed: boolean;
  isTest?: boolean;
}

// ── 상태 ──
const _sessions = new Map<string, ActiveSession>();
const _sessionQueue: Array<{ filePath: string; isTest: boolean }> = [];
const _testFilePaths = new Set<string>();
let _folderWatcher: fs.FSWatcher | null = null;
let _folderPollTimer: NodeJS.Timeout | null = null;

// ── 세션 상태 조회 ──
export function getSessionCount(): number {
  return _sessions.size;
}

export function getSessionStates(): SessionState[] {
  return [..._sessions.values()].map(s => ({
    filePath: s.filePath,
    fileName: path.basename(s.filePath),
    messageCount: s.messages.length,
    newSinceLastAnalysis: s.newSinceLastAnalysis,
    analyzing: s.analyzing,
    debounceActive: s.debounceTimer !== null,
    lastVerdict: s.lastVerdict,
    lastMessageTime: s.lastMessageTime,
    lastAnalysisAt: s.lastAnalysisAt,
    messages: s.messages,
  }));
}

export function getQueueLength(): number {
  return _sessionQueue.length;
}

export function getConstants() {
  return { analysisIntervalSec: ANALYSIS_INTERVAL_MS / 1000 };
}

// ── 브로드캐스트 ──
function broadcastSessionUpdate(): void {
  const scamWin = wm.getScamDetectorWindow();
  if (scamWin && !scamWin.isDestroyed()) {
    scamWin.webContents.send('scam-session-update', getSessionStates(), _sessionQueue.length);
  }
}

async function publishAnalysisResult(
  session: ActiveSession,
  result: ScamAnalysisResult,
): Promise<void> {
  const scamWin = wm.getScamDetectorWindow();
  if (scamWin && !scamWin.isDestroyed()) {
    scamWin.webContents.send('scam-analysis-result', result);
  }

  const shouldAlert =
    (result.verdict === 'SCAM' || result.verdict === 'SUSPICIOUS') &&
    result.verdict !== session.lastVerdict;
  session.lastVerdict = result.verdict;

  if (shouldAlert) await sendAlert(result);
}

// ── 타이머 ──
function resetInactivityTimer(session: ActiveSession): void {
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
  session.inactivityTimer = setTimeout(async () => {
    if (!session.closed) {
      log(`[SCAM] 무활동 타임아웃: ${path.basename(session.filePath)}`);
      await analyze(session);
      cleanupSession(session);
    }
  }, INACTIVITY_TIMEOUT_MS);
}

// ── 세션 정리 ──
function cleanupSession(session: ActiveSession): void {
  if (session.closed) return;
  session.closed = true;
  if (session.analysisTimer) clearInterval(session.analysisTimer);
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
  try { session.tail.unwatch(); } catch (_) { }
  _sessions.delete(session.filePath);
  _testFilePaths.delete(session.filePath);
  log(`[SCAM] 세션 종료: ${path.basename(session.filePath)}`);

  while (_sessionQueue.length > 0 && _sessions.size < MAX_SESSIONS) {
    const next = _sessionQueue.shift()!;
    if (fs.existsSync(next.filePath)) {
      log(`[SCAM] 대기열에서 세션 시작: ${path.basename(next.filePath)} (남은 대기 ${_sessionQueue.length}개)`);
      startSession(next.filePath, next.isTest);
      break;
    }
  }
  broadcastSessionUpdate();
}

// ── 새 줄 처리 ──
function onNewLine(session: ActiveSession, line: string): void {
  if (session.closed) return;
  const msg = parseLine(line);
  if (!msg) return;

  // 상대방의 에타 레벨만 표시
  if (!msg.isSystem && msg.sender && !msg.isSelf) {
    const serverCode = config.load().userServer ?? (DEFAULT_CONFIG.userServer as number);
    const rankInfo = etaCacheManager.getRankInfo(serverCode, msg.sender);
    msg.etaLevel = rankInfo ? rankInfo.level : null;
  }

  session.messages.push(msg);
  session.lastMessageTime = Date.now();
  session.newSinceLastAnalysis++;
  broadcastSessionUpdate();

  resetInactivityTimer(session);

  if (msg.isSystem && END_KEYWORDS.some((k) => msg.content.includes(k))) {
    log(`[SCAM] 대화 종료 감지: ${msg.content}`);
    if (session.debounceTimer) { clearTimeout(session.debounceTimer); session.debounceTimer = null; }
    analyze(session).finally(() => cleanupSession(session));
    return;
  }

  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  session.debounceTimer = setTimeout(() => {
    session.debounceTimer = null;
    broadcastSessionUpdate();
    const elapsed = Date.now() - session.lastAnalysisAt;
    if (!session.closed && !session.analyzing && session.newSinceLastAnalysis > 0
        && elapsed >= ANALYSIS_INTERVAL_MS) {
      void analyze(session);
    }
  }, DEBOUNCE_MS);
  broadcastSessionUpdate();
}

// ── 가상 분석 (Mock Analysis) ──
async function runMockAnalysis(session: ActiveSession): Promise<void> {
  session.analyzing = true;
  session.newSinceLastAnalysis = 0;
  session.lastAnalysisAt = Date.now();
  broadcastSessionUpdate();

  try {
    let verdict: ScamAnalysisResult['verdict'] = 'UNKNOWN';
    let detectedScamTypes = '알 수 없음';
    let analysisReason = '가상 분석 결과입니다.';
    let actionGuidance = '가상 분석 결과입니다.';

    const senders = new Set(session.messages.map(m => m.sender).filter(Boolean));

    if (senders.has('룰러')) {
      verdict = 'SCAM';
      detectedScamTypes = '가중치 거래 코드 유도 / Ctrl+1 키 입력 요구';
      analysisReason = '거래 전 "가중치 코드" 입력을 요구하며 특정 단축키(Ctrl+1)의 작동 방식을 오도하고 있습니다. 전형적인 권한 편취 및 해킹 사기 패턴입니다.';
      actionGuidance = '사기 위험 대화입니다. 대화를 즉시 중단하시고 거래 상대방을 차단하세요.';
    } else if (senders.has('대표：')) {
      verdict = 'SCAM';
      detectedScamTypes = '특수문자(：) 이용 닉네임 사칭';
      analysisReason = '닉네임 끝에 특수문자 콜론(：)을 붙여 일반 유저나 클럽장, 운영자 등 신뢰할 수 있는 대상을 사칭하는 대표적인 사칭 사기 패턴입니다.';
      actionGuidance = '사기 및 사칭 위험 대화입니다. 거래 및 대화를 즉시 중단하시고 차단하세요.';
    } else if (senders.has('클럽장-햄찌') || senders.has('판매자햄찌')) {
      verdict = 'SCAM';
      detectedScamTypes = '3자 대화 유도 / 클럽장 사칭 사기';
      analysisReason = '클럽장 또는 신뢰할 만한 대상을 사칭하여 특이한 거래 규칙(상속거래 시스템)이나 코드를 요구하고 있습니다. 교란을 목적으로 다수가 공모하는 사기입니다.';
      actionGuidance = '사기 위험 대화입니다. 해당 유저들과의 대화를 거부하고 즉시 신뢰할 수 있는 경로로 확인하세요.';
    } else if (senders.has('할리퀸')) {
      verdict = 'SCAM';
      detectedScamTypes = '게임 운영자 사칭 / 보증금 및 시드 전송 요구';
      analysisReason = '비정상적인 규정(운영자 규정, 롤벤)을 운운하며 시드를 먼저 송금하라고 요구하고 있습니다. 수수료나 보증금을 먼저 요구하는 선입금 사기입니다.';
      actionGuidance = '사기 위험 대화입니다. 절대 시드나 아이템을 먼저 전송하지 마세요.';
    } else if (senders.has('췌릴')) {
      verdict = 'SUSPICIOUS';
      detectedScamTypes = '교환창 장시간 지연 / 비정상적 지연';
      analysisReason = '교환창을 열어둔 채 컴퓨터 렉 등을 핑계로 비정상적으로 시간을 지체하고 있습니다. 주의력을 흐트러뜨리는 행동 패턴으로 판단됩니다.';
      actionGuidance = '의심스러운 대화입니다. 불필요한 대기 시간이 길어질 경우 교환창을 닫고 안전한 장소로 이동하세요.';
    } else if (senders.has('밍키')) {
      verdict = 'SAFE';
      detectedScamTypes = '없음';
      analysisReason = '일상적이고 명확한 의사의 거래 대화가 오가고 있으며, 비정상적인 요구 사항이나 외부 링크, 정체불명의 조작 유도가 발견되지 않았습니다.';
      actionGuidance = '안전한 대화로 판단되나, 거래 최종 수락 전에 다시 한번 아이템과 금액을 확인해 주십시오.';
    }

    const result: ScamAnalysisResult = {
      verdict,
      detectedScamTypes,
      analysisReason,
      actionGuidance,
      rawResponse: `[MOCK ANALYSIS RESPONSE]\nVerdict: ${verdict}\nTypes: ${detectedScamTypes}\nReason: ${analysisReason}\nGuidance: ${actionGuidance}`,
      filePath: session.filePath,
      analyzedAt: Date.now(),
    };

    // 가상 딜레이 연출 (0.5초)
    await new Promise(resolve => setTimeout(resolve, 500));

    await publishAnalysisResult(session, result);
  } catch (e) {
    log(`[SCAM] [MOCK] 가상 분석 예외 발생: ${e}`);
  } finally {
    session.analyzing = false;
    broadcastSessionUpdate();
  }
}

// ── 분석 ──
async function analyze(session: ActiveSession): Promise<void> {
  if (session.analyzing || session.messages.length === 0) return;

  const isLlmDisabled = config.load().scamLlmDisabled;
  const isModelDownloaded = getModelStatus().downloaded;

  if (isLlmDisabled || !isModelDownloaded) {
    if (session.isTest) {
      log(`[SCAM] AI 비활성화 또는 모델 미준비 상태에서 테스트 세션 가상 분석을 진행합니다: ${path.basename(session.filePath)}`);
      await runMockAnalysis(session);
      return;
    } else {
      if (isLlmDisabled) {
        log(`[SCAM] AI 분석(LLM)이 비활성화되어 대화 분석을 건너뜁니다: ${path.basename(session.filePath)}`);
      } else {
        log(`[SCAM] AI 모델이 다운로드되지 않아 자동 대화 분석을 건너뜁니다: ${path.basename(session.filePath)}`);
      }
      return;
    }
  }

  session.analyzing = true;
  const savedCount = session.newSinceLastAnalysis;
  session.newSinceLastAnalysis = 0;
  session.lastAnalysisAt = Date.now();
  broadcastSessionUpdate();

  log(`[SCAM] 분석 시작: ${path.basename(session.filePath)} (${session.messages.length}개 메시지)`);

  try {
    await startServer();

    const userMessage = `[분석할 대화 내용]\n${buildConversationText(session.messages)}`;
    const raw = await callLlmQueued(session.filePath, userMessage, () => session.closed);

    const parsed = parseResponse(raw);
    const result: ScamAnalysisResult = {
      ...parsed,
      filePath: session.filePath,
      analyzedAt: Date.now(),
    };

    await publishAnalysisResult(session, result);
  } catch (e) {
    session.newSinceLastAnalysis = savedCount;
    log(`[SCAM] 분석 실패: ${e}`);
  } finally {
    session.analyzing = false;
    broadcastSessionUpdate();
  }
}

// ── 세션 시작 ──
export function startSession(filePath: string, isTest = false): void {
  if (_sessions.has(filePath)) return;
  if (_sessions.size >= MAX_SESSIONS) {
    if (!_sessionQueue.some(q => q.filePath === filePath)) {
      _sessionQueue.push({ filePath, isTest });
      log(`[SCAM] 세션 슬롯 부족, 대기열 추가: ${path.basename(filePath)} (대기 ${_sessionQueue.length}개)`);
      broadcastSessionUpdate();
    }
    return;
  }

  let tail: Tail;
  try {
    tail = new Tail(filePath, {
      fromBeginning: true,
      follow: true,
      useWatchFile: true,
      fsWatchOptions: { interval: 1000 },
      encoding: 'binary',
    });
  } catch (e) {
    log(`[SCAM] Tail 생성 실패 (${path.basename(filePath)}): ${e}`);
    return;
  }

  const session: ActiveSession = {
    filePath, tail, messages: [],
    newSinceLastAnalysis: 0,
    lastMessageTime: Date.now(),
    lastAnalysisAt: 0,
    analysisTimer: null, debounceTimer: null, inactivityTimer: null,
    analyzing: false, lastVerdict: 'UNKNOWN', closed: false,
    isTest,
  };

  tail.on('line', (data: string) => {
    const buf = Buffer.from(data, 'binary');
    onNewLine(session, iconv.decode(buf, 'euc-kr'));
  });
  tail.on('error', (err) => log(`[SCAM] Tail 오류: ${err}`));

  session.analysisTimer = setInterval(() => {
    if (!session.closed && session.newSinceLastAnalysis >= 1 && !session.analyzing) {
      if (session.debounceTimer) { clearTimeout(session.debounceTimer); session.debounceTimer = null; }
      void analyze(session);
    }
  }, ANALYSIS_INTERVAL_MS);

  if (!isTest) resetInactivityTimer(session);

  _sessions.set(filePath, session);
  log(`[SCAM] 새 1:1 대화 감지: ${path.basename(filePath)}${isTest ? ' [테스트]' : ''}`);
  broadcastSessionUpdate();

  if (config.load().scamDetectorEnabled) {
    try {
      wm.openScamDetectorWindow();
    } catch (e) {
      log(`[SCAM] 사기꾼 탐지 창 자동 열기 실패: ${e}`);
    }
  }
}

export function triggerAnalyze(filePath: string): void {
  const session = _sessions.get(filePath);
  if (!session || session.closed || session.analyzing) return;
  if (session.debounceTimer) {
    clearTimeout(session.debounceTimer);
    session.debounceTimer = null;
  }
  void analyze(session);
}

export function closeSession(filePath: string): void {
  const session = _sessions.get(filePath);
  if (session) {
    cleanupSession(session);
  } else {
    const idx = _sessionQueue.findIndex(q => q.filePath === filePath);
    if (idx !== -1) {
      _sessionQueue.splice(idx, 1);
      broadcastSessionUpdate();
    }
  }
}

// ── 폴더 감시 ──
function startWatcher(msgerLogPath: string): void {
  if (_folderWatcher) return;
  try {
    _folderWatcher = fs.watch(msgerLogPath, (eventType, filename) => {
      if (eventType === 'rename' && filename?.endsWith('.html')) {
        const filePath = path.join(msgerLogPath, filename);
        setTimeout(() => {
          if (fs.existsSync(filePath) && !_sessions.has(filePath)) {
            startSession(filePath, _testFilePaths.has(filePath));
          }
        }, 500);
      }
    });
    log(`[SCAM] 사기꾼 탐지 모니터 시작 → ${msgerLogPath}`);
  } catch (e) {
    log(`[SCAM] 폴더 감시 시작 실패: ${e}`);
  }
}

export function start(): void {
  const msgerLogPath = getMsgerLogPath();
  if (!msgerLogPath) {
    log('[SCAM] chatLogPath 미설정 → MsgerLog 경로 불명, 감시 건너뜀');
    return;
  }

  if (fs.existsSync(msgerLogPath)) {
    startWatcher(msgerLogPath);
  } else {
    log(`[SCAM] MsgerLog 폴더 없음, 1분마다 재시도: ${msgerLogPath}`);
  }

  if (!_folderPollTimer) {
    _folderPollTimer = setInterval(() => {
      if (_folderWatcher) return;
      const p = getMsgerLogPath();
      if (p && fs.existsSync(p)) {
        log('[SCAM] MsgerLog 폴더 생성 감지, 감시 시작');
        startWatcher(p);
      }
    }, 60_000);
  }
}

export function stop(): void {
  if (_folderPollTimer) { clearInterval(_folderPollTimer); _folderPollTimer = null; }
  if (_folderWatcher) { _folderWatcher.close(); _folderWatcher = null; }
  for (const session of [..._sessions.values()]) {
    cleanupSession(session);
  }
  stopServer();
  log('[SCAM] 사기꾼 탐지 모니터 중지');
}

export function injectTestSession(scenario = 'scam_keyword'): { success: boolean; error?: string } {
  const msgerLogPath = getMsgerLogPath();
  if (!msgerLogPath) return { success: false, error: 'MsgerLog 경로를 알 수 없습니다. ChatLog 경로를 먼저 설정해주세요.' };

  const scenarioFn = TEST_SCENARIOS[scenario] ?? TEST_SCENARIOS['scam_keyword'];

  try {
    if (!fs.existsSync(msgerLogPath)) fs.mkdirSync(msgerLogPath, { recursive: true });

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const fileName = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${ms}.html`;
    const filePath = path.join(msgerLogPath, fileName);

    const h = now.getHours(), m = now.getMinutes();
    const lines = scenarioFn(h, m);

    fs.writeFileSync(filePath, iconv.encode(lines.join('\n') + '\n', 'euc-kr'));
    log(`[SCAM] 테스트 파일 생성: ${fileName} (시나리오: ${scenario})`);

    _testFilePaths.add(filePath);

    if (!_folderWatcher) startWatcher(msgerLogPath);
    if (!_sessions.has(filePath)) startSession(filePath, true);

    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
