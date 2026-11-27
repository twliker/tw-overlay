/**
 * 기능 계약 — 실시간 채팅 로그 파일 입력
 *
 * - 사용자가 지정한 채팅 로그 경로가 없을 때만 설치 경로를 자동 탐색하고, 오늘 파일을 tail하여
 *   인코딩 디코딩과 줄 정규화를 거친 완전한 줄만 `chatParser`에 전달합니다.
 * - 시작 시 오늘 로그의 기존 구간을 재생해 HUD/채팅 상태를 복원하지만, 장기 누락 기록의 DB 복구는
 *   `chatLogSyncManager`/worker가 담당합니다. 두 경로가 같은 활동을 처리할 수 있으므로 하위 저장소의
 *   event ID와 중복 방지 계약을 제거하면 안 됩니다.
 * - 자정에는 다음 파일이 만들어질 때까지 이전 파일의 늦은 줄도 추적합니다. 파일 교체·watch
 *   오류에서는 기존 watcher를 해제하고 제한된 지수 재시도로 다시 붙습니다.
 * - 대형 파일은 메모리 상한을 위해 최근 구간만 유지하되, 채팅 화면별 읽기 인덱스도 같은 만큼
 *   보정해야 합니다. 잘라낸 앞부분 때문에 새 줄을 건너뛰거나 과거 줄을 다시 보내면 안 됩니다.
 * - 실시간 읽기는 개행이 없는 구간에서도 나눠 실행합니다. 1 MiB를 넘는 비정상 행만 물리 개행까지
 *   건너뛰고 정상 행의 byte 위치·귀속을 유지합니다. 회귀: check-profile-lifecycle.ts.
 * - 원시 로그와 채팅 내용은 로컬 기능에만 사용하며 GA 사용 통계 payload로 전달하지 않습니다.
 */
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { log } from './logger';
import {diagTransition} from './profileDiagnostics';
import { chatParser, parseChatLogDateHeader } from './chatParser';
import * as config from './config';
import { chatLogProcessor } from './chatLogProcessor';
import { findChatLogPath } from './chatLogPathFinder';
import { DEFAULT_CONFIG } from './constants';
import * as diaryDb from './diaryDb';
import { sendToFirstWindowByPage } from './windowMessaging';
import { etaCacheManager } from './etaCacheManager';
import { ChatLogLineNormalizer, probeChatLogEncoding } from './chatLogNormalizer';
import type { ChatLogEncoding } from './chatLogNormalizer';
import { parseItemAcquisition } from './itemAcquisition';
import {
  MAX_RECENT_HISTORY_CHARS,
  CHAT_LOG_HEADER_BYTES,
  chatLogFileIdentity,
  sampleChatLogBoundary,
  type ChatLogReadBoundary,
  type InitialChatLogSnapshot,
  readInitialChatLogSnapshot,
  trimRecentChatLogLines,
} from './chatLogFileReader';
import { formatLocalDateKey } from '../shared/localDate';
import {prepareProfileLogSource,withProfileLogSource,type ProfileLogSource} from './profileLogSource';
import {getProfileRuntime} from './profileRuntime';
import type {LiveProfileRecord,LiveReadSpan,ProfileInputBoundary} from './profileService';
import {collectLiveProfileLine,createProfileRecoveryParser,persistLiveProfileBatch,persistLiveProfileRecords} from './profileParserEvents';
import type Database = require('better-sqlite3');

const { isLegacyNpcSender, isNpcChat } = require('../shared/chatConstants') as ChatConstants;
const { COLORS: CHAT_COLORS, parseShoutContent, isOverlayChatVisible, getSystemColorGroup, resolveOverlayCustomTab } = require('../shared/chatChannels') as ChatChannelConstants;

type HistoryCategory = 'General' | 'Team' | 'Club' | 'Whisper' | 'System';
type HistoryMessageType = 'general' | 'team' | 'club' | 'whisper' | 'system';
const MAX_TAIL_RETRY_ATTEMPTS = 5;
const SYNC_CATCH_UP_CHUNK_BYTES = 256 * 1024;
const LIVE_READ_SLICE_MS=12;
const LIVE_READ_MAX_LINES=32;
const LIVE_READ_MAX_BYTES=1024*1024;
const LIVE_MAX_ROW_BYTES=1024*1024;
const LIVE_POLL_MS=1000;
const BOUNDARY_RECHECK_MS=15_000;
/** 경험치 줄만 읽는 동안(처리 구간을 메모리에 미룬 동안) 감시 북마크를 저장하는 최소 간격. 1분 체크포인트와 같다. */
const DEFERRED_BOOKMARK_MS=60_000;
const HANDOFF_PREFIX='live-chat-handoff:';
const WATCH_CHECKPOINT_PREFIX='live-chat-watch:';
/** 저장이 밀린 프로필 기록을 메모리에 보관할 최대 줄 수. 넘으면 북마크 고정으로 다음 실행에 맡긴다. */
const MAX_PROFILE_PERSIST_RETRY_LINES=5000;
/** 오늘 감시 경계 복구 실패를 기다리는 최대 횟수(점점 늘려 최대 10초 간격). 넘으면 복구 대기로 넘기고 감시를 시작한다. */
const MAX_WATCH_STARTUP_BLOCKED_ATTEMPTS=10;

type LogBoundary=ChatLogReadBoundary;
interface LogReadLimit {size:number;identity:string;bytes:Buffer}
interface TailReconnect {filePath:string;boundary?:LogBoundary;offset?:number}
interface LiveLogWatch {
  checkpoint():LogBoundary | undefined;
  readTo(limit:LogReadLimit,protectIncomplete:boolean):void | Promise<void>;
  protectPartial():void;
  read(options?:{flushClosed?:boolean;protectIncomplete?:boolean;limit?:LogReadLimit}):LogBoundary;
  refresh():void;
  unwatch():void;
}

export interface ChatLogSyncPauseToken {
  id: number;
  filePath: string;
  /** 중지 전에 실시간 파서가 확실히 처리한 마지막 완전한 물리 줄 다음 byte 위치. */
  resumeOffset: number;
  encoding: ChatLogEncoding;
  boundary?:LogBoundary;
  checkpointKey?:string;
}

export interface ChatLogSyncCatchUpResult {
  startOffset: number;
  handoffOffset: number;
  /** 끝이 잘린 물리 줄을 제외하고 실제 parser에 전달한 마지막 byte 위치. */
  completedOffset: number;
  processedBytes: number;
}

type StoredLogHandoff={
  filePath:string;
  encoding:ChatLogEncoding;
  boundary?:Omit<LogBoundary,'bytes'> & {bytes:string};
  includeFollowingDays?:boolean;
  localDeviceId?:string;
};

/** ZIP 복원에는 현재 PC의 감시 위치만 싣는다. 백업 파일에 과거에 저장된 위치는 이어받지 않는다. */
export function prepareRestoredChatLogHandoff(db:Database.Database,portable:boolean,localDeviceId:string,token?:ChatLogSyncPauseToken):void {
  if (portable) db.prepare('DELETE FROM app_meta WHERE key GLOB ? OR key GLOB ?').run(HANDOFF_PREFIX+'*',WATCH_CHECKPOINT_PREFIX+'*');
  if (!token) return;
  const {encoding,boundary}=token,filePath=path.resolve(token.filePath);
  const handoff:StoredLogHandoff={filePath,encoding,localDeviceId,includeFollowingDays:true,
    boundary:boundary && {...boundary,bytes:boundary.bytes.toString('hex')}};
  db.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)')
    .run(HANDOFF_PREFIX+path.resolve(filePath).toLowerCase(),JSON.stringify(handoff));
}

export function getTailRetryDelayMs(attempt: number): number {
  return Math.min(16000, 1000 * (2 ** Math.max(0, attempt - 1)));
}

export function releaseFailedTail(tail: { unwatch(): void }): null {
  try {
    tail.unwatch();
  } catch {
    // 이미 닫힌 watcher의 정리 오류는 재연결을 막지 않습니다.
  }
  return null;
}

export function shouldAutoDiscoverChatLogPath(configuredPath: unknown): boolean {
  return typeof configuredPath !== 'string' || configuredPath.trim().length === 0;
}

function isSeedGainMessage(message: string): boolean {
  return /SEED|Seed|시드/i.test(message) && /(?:획득|습득|입수|얻었|받았|지급|증가|올랐|주웠)/.test(message);
}

export function classifyHistoryMessage(
  rawColor: string,
  cleanMessage: string
): {
  category: HistoryCategory;
  type: HistoryMessageType;
  sender: string;
  message: string;
  color: string;
} {
  let category: HistoryCategory = 'System';
  let type: HistoryMessageType = 'system';
  let sender = '시스템';
  let message = cleanMessage;
  let color = rawColor;

  const chatMatch = cleanMessage.match(/^(.+?)\s*:\s*(.*)$/);
  if (color === CHAT_COLORS.club) {
    category = 'Club';
    type = 'club';
    sender = '클럽 알림';
    if (chatMatch) {
      sender = chatMatch[1].trim();
      message = chatMatch[2].trim();
    } else if (cleanMessage.includes('[클럽 공지]')) {
      sender = '클럽 공지';
    }
  } else if (color === CHAT_COLORS.team) {
    category = 'Team';
    type = 'team';
    sender = '팀 알림';
    if (chatMatch) {
      sender = chatMatch[1].trim();
      message = chatMatch[2].trim();
    }
  } else if (color === CHAT_COLORS.whisper) {
    category = 'Whisper';
    type = 'whisper';
    sender = '귓속말';
    if (chatMatch) {
      sender = chatMatch[1].trim();
      message = chatMatch[2].trim();
    }
  } else if (
    (color === CHAT_COLORS.general || color === CHAT_COLORS.selfGeneral) &&
    chatMatch &&
    !chatMatch[1].trim().includes(' ') &&
    !chatMatch[1].trim().includes(',') &&
    !isLegacyNpcSender(chatMatch[1].trim())
  ) {
    category = 'General';
    type = 'general';
    sender = chatMatch[1].trim();
    message = chatMatch[2].trim();
  } else {
    // 시스템 로그 영역: SEED 획득 / 아이템 획득 색상 보정
    if (isSeedGainMessage(cleanMessage)) {
      color = CHAT_COLORS.system;
    } else if (parseItemAcquisition(cleanMessage, { isSelfChat: color === CHAT_COLORS.selfGeneral })?.isOwn) {
      color = '#ffd700';
    }
  }

  return { category, type, sender, message, color };
}

export class ChatLogManager {
  private _tail: LiveLogWatch | null = null;
  private _currentFilePath: string | null = null;
  private _watchTimer: NodeJS.Timeout | null = null;
  private _directoryWatch: {path:string;watcher:fs.FSWatcher} | undefined;
  private _watchNotification: NodeJS.Immediate | undefined;
  private _dailyLogTimer: NodeJS.Timeout | undefined;
  private _pathSwitchTimer: NodeJS.Timeout | undefined;
  private _todayLines: string[] = [];
  private _lastReadIndex: Record<string, number> = {};
  private _initialReadIndex: Record<string, number> = {};
  private readonly _lineNormalizer = new ChatLogLineNormalizer();
  private _normalizerFlushTimer: NodeJS.Timeout | null = null;
  private _tailRetryTimer: NodeJS.Timeout | null = null;
  private _tailRetryAttempts = 0;
  private _tailReconnect?:TailReconnect;
  private _chatLogEncoding: ChatLogEncoding = 'euc-kr';
  private _recentHistoryMode = false;
  private _todayLineChars = 0;
  private _syncPaused = false;
  private pausedToken?:ChatLogSyncPauseToken;
  private recoveryParser?:ReturnType<typeof createProfileRecoveryParser>;
  private _syncPauseSequence = 0;
  private _syncCatchUpActive = false;
  private _sourceFingerprint:string | undefined;
  private _sourceLogDate:string | undefined;
  private _sourceFilePath:string | undefined;
  /** 실시간 읽은 범위(ProfileService.acceptLiveLines의 span). processed는 해석을 마친 마지막 줄의 끝,
   * covered는 마지막으로 범위를 확정한 commit의 끝이다. 기록 없는 채팅만 읽은 동안은 commit하지 않고,
   * 다음 기록 줄의 commit이 covered부터 이어 붙인다. 파일·감시·세션 경계에서 지운다. */
  private _liveProcessed:{fingerprint:string;logDate:string;end:number;filePath?:string} | undefined;
  private _liveCovered:{fingerprint:string;end:number} | undefined;
  /** 소유자를 확정할 수 없어 미배정으로 읽은 줄(재시작 복구·세션 경계·재연결 중 전환)의 끝. 바로 반영 구간은 이 앞으로 가지 않는다.
   * 그 안의 경험치 줄은 기록하지 않고 버리므로(onProfileEvent), 구간에 넣으면 비정상 종료 뒤 새 프로필 HUD에 재생된다. */
  private _liveUnassignedEnd:{fingerprint:string;end:number} | undefined;
  private _waitingForDailyLog=false;
  private _deferredLiveRead=false;
  private _unassignedReadPending=false;
  private _pendingProfileSource:ProfileLogSource | undefined;
  private _pendingProfileLine:string | undefined;
  private _watchStartupRetry?:NodeJS.Timeout;
  private readonly _normalizedRetry:Array<{line:string;source?:ProfileLogSource;originalLine?:string}>=[];
  /** 해석은 끝났지만 프로필 기록 저장만 실패한 줄(원본 시작 위치 포함).
   * 저장 실패 계약:
   * - 원문을 다시 해석하지 않고 모은 기록만 순서대로 다시 저장한다. 화면·순간 알림은 이미 전달됐다.
   * - 저장이 밀린 동안에도 다음 줄을 계속 읽어 채팅·기믹 알림이 멈추지 않게 하고, 다음 줄의 기록은 뒤에 쌓는다.
   * - 감시 북마크는 가장 앞선 미저장 줄의 시작에 머문다. 종료돼도 다음 실행이 그 구간을 이벤트 ID로 다시 기록한다.
   *   북마크 저장 자체가 실패해도 읽기는 멈추지 않고 마지막 저장 위치를 유지한다(saveWatchBookmark).
   * - 프로필 전환·세션 종료 경계는 이 대기열을 먼저 저장하고, 실패하면 전환하지 않는다(다른 프로필로 넘기지 않음).
   * - 메모리 상한을 넘으면 더 쌓지 않고 북마크 고정(_profilePersistPinnedStart)으로 다음 실행에 맡긴다.
   * 회귀: check-profile-lifecycle.ts(저장 실패 중 다음 줄 처리, 재시도 뒤 정확히 한 건). */
  private readonly _profilePersistRetry:Array<{records:LiveProfileRecord[];start?:number}>=[];
  private _profilePersistPinnedStart:number | undefined;
  /** 저장 대기 메모리 상한(줄). 회귀 테스트가 실제 로그 줄로 상한 초과 경로를 확인하도록 인스턴스 값으로 둔다. */
  private _maxProfilePersistRetryLines=MAX_PROFILE_PERSIST_RETRY_LINES;
  private _profilePersistRetryTimer:NodeJS.Timeout | null=null;
  /** 진행 중인 read()에서 모은 줄별 프로필 기록(withLiveBatch). read() 밖에서는 undefined. */
  private _liveBatch:Array<{records:LiveProfileRecord[];start?:number}> | undefined;
  /** 감시 북마크 저장이 처음 실패한 시각(회복 전까지 유지)과 마지막 실패 로그 시각. */
  private _bookmarkSaveFailedSince:number | undefined;
  private _bookmarkSaveFailureLoggedAt=0;
  private _watchStartupBlockedAttempts=0;

  private source(filePath:string,start:number,end:number):ProfileLogSource | undefined {
    this._sourceFingerprint ||= prepareProfileLogSource(filePath,formatLocalDateKey());
    this._sourceLogDate=this.logFileDate(filePath);this._sourceFilePath=filePath;
    return this._sourceFingerprint ? {fingerprint:this._sourceFingerprint,start,end} : undefined;
  }

  /**
   * 스트리밍 시작
   */
  public start(replayExisting=true): void {
    if (this._syncPaused) {
      log('[CHAT_LOG] 과거 로그 동기화 catch-up 중이므로 중복 감시 시작을 건너뜁니다.');
      return;
    }
    this.stop();
    const filePath=replayExisting ? this.getTodayFilePath() : null;
    let snapshot:InitialChatLogSnapshot | undefined;
    if (filePath && fs.existsSync(filePath)) {
      try {snapshot=readInitialChatLogSnapshot(filePath);}
      catch (error) {log(`[CHAT_LOG] 시작 로그 경계 읽기 실패: ${String(error)}`);}
    }
    const interruptedWatch=replayExisting
      ? new ChatLogManager().recoverInterruptedHandoffs(WATCH_CHECKPOINT_PREFIX,snapshot) : undefined;
    if (interruptedWatch?.blockedToday) {
      // 일시적인 잠금·DB 오류는 잠시 뒤 다시 복구한다. 계속 실패하면 경계를 복구 대기로 넘기고
      // 실시간 감시를 시작해, 채팅·알림이 앱을 다시 실행해도 영구히 멈추지 않게 한다.
      // 회귀: check-profile-lifecycle.ts(손상된 감시 경계 정리). 횟수 제한 뒤 handoff 이관은 수동 확인 범위.
      if (++this._watchStartupBlockedAttempts<MAX_WATCH_STARTUP_BLOCKED_ATTEMPTS) {
        this._watchStartupRetry=setTimeout(()=>this.start(),Math.min(LIVE_POLL_MS*this._watchStartupBlockedAttempts,10_000));
        this._watchStartupRetry.unref();
        return;
      }
      log(`[CHAT_LOG] 오늘 로그의 이전 감시 경계를 ${MAX_WATCH_STARTUP_BLOCKED_ATTEMPTS}회 복구하지 못해 복구 대기로 넘기고 실시간 감시를 시작합니다.`);
      if (filePath) this.deferBlockedTodayWatch(filePath);
    }
    this._watchStartupBlockedAttempts=0;
    if (snapshot && interruptedWatch?.protectTodayPartial) {
      snapshot.boundary.unassignedUntil=snapshot.fileSize;
    }
    this.initWatch(replayExisting,undefined,replayExisting ? undefined : 0,false,filePath ?? undefined,false,snapshot);
    const historicalHandoff=replayExisting ? new ChatLogManager().recoverInterruptedHandoffs() : undefined;
    if (historicalHandoff?.protectTodayPartial) this._tail?.protectPartial();
    this.cleanupOldLogs().catch(e => log(`[CHAT_LOG] Cleanup error: ${e}`));
    
    // 1분마다 날짜 변경(자정) 및 파일 존재 여부 체크
    this._watchTimer = setInterval(() => this.checkFileChange(), 60000);
    log('[CHAT_LOG] 매니저 시작됨');
  }

  /**
   * 스트리밍 중지
   */
  public stop(flushLive=false,drainPaused=true): void {
    try {
      const token=this.pausedToken;
      if (flushLive && drainPaused && token?.checkpointKey) this.resumeAfterHistoricalSync(token,token.resumeOffset);
      if (flushLive) this.flushProfileBoundary('switch');
      else this.flushPendingNormalizedLine();
      if (flushLive && this._currentFilePath) this.removeCompleteWatchBookmark(this._currentFilePath);
    } finally {
      const tail=this._tail;
      this._tail=null;
      try {tail?.unwatch();}
      finally {this.resetWatchState();}
    }
  }

  private resetWatchState():void {
    if (this._watchStartupRetry) clearTimeout(this._watchStartupRetry);
    this._watchStartupRetry=undefined;
    if (this._pathSwitchTimer) clearTimeout(this._pathSwitchTimer);
    this._pathSwitchTimer=undefined;
    this._directoryWatch?.watcher.close();
    this._directoryWatch=undefined;
    if (this._watchNotification) clearImmediate(this._watchNotification);
    this._watchNotification=undefined;
    if (this._dailyLogTimer) clearTimeout(this._dailyLogTimer);
    this._dailyLogTimer=undefined;
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    if (this._normalizerFlushTimer) {
      clearTimeout(this._normalizerFlushTimer);
      this._normalizerFlushTimer = null;
    }
    if (this._profilePersistRetryTimer) {
      clearTimeout(this._profilePersistRetryTimer);
      this._profilePersistRetryTimer = null;
    }
    if (this._tailRetryTimer) {
      clearTimeout(this._tailRetryTimer);
      this._tailRetryTimer = null;
    }
    this._tailRetryAttempts = 0;
    this._tailReconnect=undefined;
    this._lineNormalizer.reset();
    this._sourceFingerprint=undefined;this._pendingProfileSource=undefined;this._pendingProfileLine=undefined;this._normalizedRetry.length=0;
    this._liveProcessed=undefined;this._liveCovered=undefined;this._liveUnassignedEnd=undefined;
    // 저장하지 못한 기록은 북마크가 그 시작에 머물러 있으므로 다시 감시할 때 원본부터 다시 기록한다.
    this._profilePersistRetry.length=0;this._profilePersistPinnedStart=undefined;
    this._currentFilePath = null;
    this._todayLines = [];
    this._todayLineChars = 0;
    this._recentHistoryMode = false;
    this._lastReadIndex = {};
    this._initialReadIndex = {};
    this._syncPaused = false;
    this.pausedToken=undefined;
    this._syncCatchUpActive = false;
    this._waitingForDailyLog=false;this._deferredLiveRead=false;this._unassignedReadPending=false;
    log('[CHAT_LOG] 매니저 중지됨');
  }

  /**
   * 오늘 로그 전체 재구성 전 실시간 tail을 완전한 줄 경계에서 일시 정지합니다.
   *
   * 현재 파일을 한 번 더 읽고 마지막으로 처리한 물리 줄의 끝을 남긴다. 미완성 줄은
   * 다음 감시에서 그 시작점부터 다시 읽으므로 연속 복원에서도 조각을 보존한다.
   */
  public async pauseForLocalRestore():Promise<ChatLogSyncPauseToken | null> {
    if (this._syncPaused || this.profileBoundaryActive) throw new Error('채팅 로그 처리가 끝난 뒤 다시 시도해 주세요.');
    const filePath=this._currentFilePath;
    if (!filePath) return null;
    let boundary=this._tail?.checkpoint();
    if (!boundary && (!this._waitingForDailyLog || this._tailReconnect)) {
      throw new Error('채팅 로그 감시를 복구한 뒤 다시 시도해 주세요.');
    }
    // 결합 대기 줄도 복원된 DB에서 처리할 수 있도록 첫 물리 줄 직전까지 되감는다.
    // 위치를 확인할 수 없는 드문 경우에는 기존 저장 경로로 먼저 처리한다.
    const buffered=[this._pendingProfileSource,...this._normalizedRetry.map(row=>row.source)];
    const rewind=Math.min(buffered.reduce((offset,source)=>Math.min(offset,source?.start ?? Infinity),Infinity),
      this.firstUnpersistedProfileStart() ?? Infinity);
    if (boundary && rewind<boundary.offset) {
      const fd=fs.openSync(filePath,'r');
      try {
        const stat=fs.fstatSync(fd);
        if (chatLogFileIdentity(stat)!==boundary.identity || stat.size<boundary.offset
          || !sampleChatLogBoundary(fd,boundary.offset).equals(boundary.bytes)) {
          throw new Error('채팅 로그 원본을 다시 연결한 뒤 복원해 주세요.');
        }
        boundary={...boundary,offset:rewind,bytes:sampleChatLogBoundary(fd,rewind)};
      } finally {fs.closeSync(fd);}
      this._lineNormalizer.reset();
      this._pendingProfileSource=undefined;
      this._pendingProfileLine=undefined;
      this._normalizedRetry.length=0;
      this._profilePersistRetry.length=0;this._profilePersistPinnedStart=undefined;
    } else this.flushPendingNormalizedLine();
    if (this._normalizerFlushTimer) clearTimeout(this._normalizerFlushTimer);
    this._normalizerFlushTimer=null;
    this._tail?.unwatch();
    this._tail=null;
    if (this._tailRetryTimer) clearTimeout(this._tailRetryTimer);
    this._tailRetryTimer=null;
    const token={id:++this._syncPauseSequence,filePath,resumeOffset:boundary?.offset ?? 0,
      encoding:this._chatLogEncoding,boundary};
    this._syncPaused=true;
    this.pausedToken=token;
    return token;
  }

  public resumeAfterLocalRestore(token: ChatLogSyncPauseToken): void {
    if (!this._syncPaused || token.id!==this._syncPauseSequence) return;
    const today=this.getTodayFilePath();
    const sameDirectory=today && path.dirname(today)===path.dirname(token.filePath);
    try {
      if (!sameDirectory) throw new Error('현재 감시할 채팅 로그가 바뀌었습니다.');
      if (!token.boundary && !fs.existsSync(token.filePath)) {
        this._syncPaused=false;this.pausedToken=undefined;return;
      }
      const encoding=token.boundary ? token.encoding : readInitialChatLogSnapshot(token.filePath).encoding;
      this.resumeAfterHistoricalSync(token,token.resumeOffset,encoding);
    } catch (error) {
      this._syncPaused=false;this.pausedToken=undefined;
      log('[CHAT_LOG] 복원 후 현재 로그 감시를 다시 시작합니다: '+String(error));
      if (sameDirectory) {
        this._currentFilePath=token.filePath;
        this.scheduleTailReconnect(token.filePath,token.boundary,token.resumeOffset);
      } else this.start();
    }
  }

  public async pauseForHistoricalSync(expectedFilePath: string,durable=true): Promise<ChatLogSyncPauseToken | null> {
    if (this.profileBoundaryActive) throw new Error('프로필 전환의 채팅 기록 처리가 끝난 뒤 다시 시도해 주세요.');
    if (this._syncPaused) throw new Error('실시간 채팅 로그가 이미 동기화 대기 상태입니다.');
    if (!this._tail || !this._currentFilePath) return null;
    if (path.resolve(this._currentFilePath) !== path.resolve(expectedFilePath)) return null;

    this._syncPaused = true;
    const tail = this._tail;
    try {
      if (getProfileRuntime()?.canReadLiveLog?.()===false) {
        this._unassignedReadPending=true;
        this.flushPendingNormalizedLine();
      }
      const boundary=tail.read({flushClosed:true});
      this.flushPendingNormalizedLine();
      const resumeOffset=boundary.offset;
      const token:ChatLogSyncPauseToken={id:++this._syncPauseSequence,filePath:expectedFilePath,resumeOffset,
        boundary,encoding:this._chatLogEncoding};
      const db=getProfileRuntime()?.service.store.database;
      if (durable && db) {
        token.checkpointKey=HANDOFF_PREFIX+path.resolve(expectedFilePath).toLowerCase();
        this.saveHandoff(token.checkpointKey,token.filePath,token.encoding,boundary);
      }
      tail.unwatch();
      if (this._tail === tail) this._tail = null;
      if (this._tailRetryTimer) {
        clearTimeout(this._tailRetryTimer);
        this._tailRetryTimer = null;
      }

      this.pausedToken=token;
      log(`[CHAT_LOG] 과거 로그 동기화 대기 시작: offset=${resumeOffset}`);
      return token;
    } catch (error) {
      this._syncPaused = false;
      log(`[CHAT_LOG] 과거 로그 동기화 대기 실패: ${error}`);
      throw error;
    }
  }

  private saveHandoff(key:string,filePath:string,encoding:ChatLogEncoding,boundary:LogBoundary,localDeviceId?:string):void {
    getProfileRuntime()?.service.store.database.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)').run(key,
      JSON.stringify({filePath,encoding,localDeviceId,boundary:{...boundary,bytes:boundary.bytes.toString('hex')}}));
  }

  /** 기능 계약 — 실시간 감시 북마크 저장 실패(디스크 가득 참·IO 오류·app_meta 쓰기 실패)는 읽기를 멈추지 않는다.
   * - 예외를 던지지 않고 false를 돌려준다. 감시는 유지되어 다음 줄의 채팅 표시·기믹 알림이 계속된다.
   * - DB에는 마지막으로 저장에 성공한 위치가 남는다. 종료돼도 다음 실행이 그 위치부터 다시 읽고,
   *   이미 저장된 기록은 이벤트 ID로 걸러진다(기존 at-least-once 계약과 같은 범위).
   * - 호출자는 성공했을 때만 저장 위치를 갱신하므로 다음 읽기에서 자동으로 다시 저장을 시도한다.
   * - 실패 로그는 60초에 한 번만 남기고, 회복되면 한 번 알린다.
   * 회귀: check-profile-lifecycle.ts(app_meta 쓰기 실패 중 다음 줄 처리·회복 뒤 북마크 갱신). */
  private saveWatchBookmark(key:string,filePath:string,boundary:LogBoundary,localDeviceId?:string):boolean {
    try {this.saveHandoff(key,filePath,this._chatLogEncoding,boundary,localDeviceId);}
    catch (error) {
      const now=Date.now();
      this._bookmarkSaveFailedSince ??= now;
      if (now-this._bookmarkSaveFailureLoggedAt>=60_000) {
        this._bookmarkSaveFailureLoggedAt=now;
        log(`[CHAT_LOG] 감시 북마크 저장 실패, 읽기는 계속하고 다음 읽기에서 다시 저장합니다: ${String(error)}`);
      }
      return false;
    }
    if (this._bookmarkSaveFailedSince!==undefined) {
      log(`[CHAT_LOG] 감시 북마크 저장이 회복되었습니다 (${Math.round((Date.now()-this._bookmarkSaveFailedSince)/1000)}초 동안 실패).`);
      this._bookmarkSaveFailedSince=undefined;this._bookmarkSaveFailureLoggedAt=0;
    }
    return true;
  }

  private removeCompleteWatchBookmark(filePath:string):void {
    const checkpoint=this._tail?.checkpoint();
    if (!checkpoint || this._pendingProfileSource || this._normalizedRetry.length || this.hasUnpersistedProfileRecords()) return;
    try {
      const stat=fs.statSync(filePath,{throwIfNoEntry:false});
      if (!stat || checkpoint.offset!==stat.size || checkpoint.identity!==chatLogFileIdentity(stat)) return;
      getProfileRuntime()?.service.store.database.prepare('DELETE FROM app_meta WHERE key=?')
        .run(WATCH_CHECKPOINT_PREFIX+path.resolve(filePath).toLowerCase());
    } catch (error) {log(`[CHAT_LOG] 완료된 감시 경계 정리 보류: ${String(error)}`);}
  }

  /** Bytes that were never captured before shutdown have no proven game owner. */
  private recoverInterruptedHandoffs(prefix=HANDOFF_PREFIX,snapshot?:InitialChatLogSnapshot):{protectTodayPartial:boolean;blockedToday:boolean} {
    const store=getProfileRuntime()?.service.store,today=this.getTodayFilePath();
    if (!store?.database.open) return {protectTodayPartial:false,blockedToday:false};
    const db=store.database,deviceId=store.getRecordContext().deviceId;
    let protectTodayPartial=false,blockedToday=false;
    const rows=db.prepare('SELECT key,value FROM app_meta WHERE key GLOB ? ORDER BY key').all(`${prefix}*`) as {key:string;value:string}[];
    const isDailyLog=(name:string)=>/^TWChatLog_\d{4}_\d{2}_\d{2}\.html$/i.test(name);
    const isAllowedSource=({filePath,localDeviceId}:StoredLogHandoff)=>isDailyLog(path.basename(filePath)) &&
      (path.isAbsolute(filePath) && !!localDeviceId && localDeviceId===deviceId || !!today &&
        path.resolve(path.dirname(filePath)).toLowerCase()===path.resolve(path.dirname(today)).toLowerCase());
    const queued=new Set(rows.map(row=>row.key));
    for (const row of [...rows]) {
      try {
        const handoff=JSON.parse(row.value) as StoredLogHandoff;
        if (!handoff.includeFollowingDays || !isAllowedSource(handoff)) continue;
        const sourceDirectory=path.resolve(path.dirname(handoff.filePath));
        const first=path.basename(handoff.filePath).toLowerCase(),last=`twchatlog_${formatLocalDateKey().replace(/-/g,'_')}.html`;
        const later=fs.readdirSync(sourceDirectory).filter(name=>isDailyLog(name)
          && name.toLowerCase()>first && name.toLowerCase()<=last).sort();
        const additions=later.map(name=>{
          const filePath=path.join(sourceDirectory,name),key=HANDOFF_PREFIX+filePath.toLowerCase();
          return {key,value:JSON.stringify({filePath,encoding:'utf8',localDeviceId:handoff.localDeviceId} satisfies StoredLogHandoff)};
        }).filter(entry=>!queued.has(entry.key));
        const insert=db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)');
        db.transaction(()=>{for (const {key,value} of additions) insert.run(key,value);})();
        for (const entry of additions) {rows.push(entry);queued.add(entry.key);}
      } catch (error) {log(`[CHAT_LOG] 이후 날짜 로그 복구 대기: ${String(error)}`);}
    }
    for (const row of rows) {
      let watch:LiveLogWatch | undefined;
      let isToday=false;
      try {
        const handoff=JSON.parse(row.value) as StoredLogHandoff;
        if (!isAllowedSource(handoff)) continue;
        const {filePath,encoding,boundary,localDeviceId}=handoff;
        isToday=!!today && path.resolve(filePath).toLowerCase()===path.resolve(today).toLowerCase();
        if (prefix===WATCH_CHECKPOINT_PREFIX && !fs.existsSync(filePath)) {
          db.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
          continue;
        }
        if (prefix===WATCH_CHECKPOINT_PREFIX && isToday && !snapshot) {
          blockedToday=true;
          continue;
        }
        let checkpoint:LogBoundary | undefined;
        if (boundary) {
          if (!Number.isSafeInteger(boundary.offset) || boundary.offset<0 || !/^(?:[a-f0-9]{2}){0,256}$/.test(boundary.bytes)
            || !['euc-kr','utf8'].includes(encoding)) {
            // 손상된 감시 경계는 다시 시도해도 쓸 수 없다. 남겨 두면 매 실행 오늘 감시를 막으므로 정리한다.
            if (prefix===WATCH_CHECKPOINT_PREFIX) {
              db.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
              log(`[CHAT_LOG] 손상된 감시 경계를 정리했습니다: ${filePath}`);
              continue;
            }
            throw new Error('Invalid live log checkpoint');
          }
          const bytes=Buffer.from(boundary.bytes,'hex');
          const fd=fs.openSync(filePath,'r');
          try {
            const stat=fs.fstatSync(fd);
            if (chatLogFileIdentity(stat)!==boundary.identity || stat.size<boundary.offset || !sampleChatLogBoundary(fd,boundary.offset).equals(bytes)) {
              if (prefix===WATCH_CHECKPOINT_PREFIX) {
                db.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
                log(`[CHAT_LOG] 교체된 파일의 감시 경계를 정리했습니다: ${filePath}`);
                continue;
              }
              throw new Error('The source of the live log checkpoint has changed');
            }
          } finally {fs.closeSync(fd);}
          checkpoint={...boundary,bytes};
        } else if (!fs.existsSync(filePath)) {
          db.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
          continue;
        }
        this.recoveryParser=createProfileRecoveryParser(this.logFileDate(filePath));
        this._chatLogEncoding=checkpoint ? encoding : readInitialChatLogSnapshot(filePath).encoding;
        this._unassignedReadPending=true;
        watch=this.watchLog(filePath,checkpoint?.offset ?? 0,true,checkpoint,false,true).watch;
        const limit=prefix===WATCH_CHECKPOINT_PREFIX && isToday && snapshot
          ? {...snapshot.boundary,size:snapshot.boundary.offset} : undefined;
        const lastComplete=watch.read({flushClosed:true,protectIncomplete:true,limit});
        this.flushPendingNormalizedLine();
        if ((lastComplete.unassignedUntil ?? 0)>lastComplete.offset) {
          this.saveHandoff(row.key,filePath,this._chatLogEncoding,lastComplete,localDeviceId);
          protectTodayPartial ||= !!today && path.resolve(filePath).toLowerCase()===path.resolve(today).toLowerCase();
        } else if (limit) {
          this.saveHandoff(row.key,filePath,this._chatLogEncoding,lastComplete,localDeviceId);
          protectTodayPartial ||= snapshot!.fileSize>lastComplete.offset;
        } else db.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
      } catch(error) {
        blockedToday ||= isToday && prefix===WATCH_CHECKPOINT_PREFIX;
        log(`[CHAT_LOG] 실시간 로그 복구 대기: ${String(error)}`);
      }
      finally {watch?.unwatch();this.recoveryParser=undefined;this.resetWatchState();}
    }
    return {protectTodayPartial,blockedToday};
  }

  /** 실시간 감시와 복원 인계에서 실제 파일 바이트를 같은 방식으로 읽는다. */
  private profileBoundaryActive=false;
  private profileBoundaryTask?:Promise<void>;

  private watchLog(filePath:string,startOffset:number,flushClosedLine:boolean,previous?:LogBoundary,background=false,deferInitial=false) {
    let position=startOffset,completed=startOffset,boundary=previous;
    const bookmarkPath=path.resolve(filePath);
    const bookmarkKey=WATCH_CHECKPOINT_PREFIX+bookmarkPath.toLowerCase();
    let lastSavedOffset:number | undefined,lastSavedAt:number | undefined,deferredFailedAt:number | undefined;
    let partial:Buffer | undefined;
    let lastCheckpoint=previous;
    let lastStat:fs.Stats | undefined,lastVerifiedAt=0;
    let unassignedUntil=previous?.unassignedUntil ?? 0;
    let encodingConfirmed=previous?.encodingConfirmed ?? startOffset>0;
    let encodingHeader:Buffer | undefined,encodingHeaderLength=0;
    const parse=(bytes:Buffer,start:number,end:number)=>{
      if (!encodingConfirmed) {
        // Empty files and ASCII headers can precede the game's first encoded line.
        if (start===encodingHeaderLength && start<CHAT_LOG_HEADER_BYTES) {
          encodingHeader ??= Buffer.alloc(CHAT_LOG_HEADER_BYTES);
          const copied=bytes.copy(encodingHeader,start);
          encodingHeaderLength=start+copied;
          if (encodingHeaderLength<CHAT_LOG_HEADER_BYTES) encodingHeader[encodingHeaderLength++]=10;
        }
        const declaresCharset=start<CHAT_LOG_HEADER_BYTES && bytes.toString('latin1').toLowerCase().includes('charset');
        const detected=(declaresCharset && encodingHeader ? probeChatLogEncoding(encodingHeader.subarray(0,encodingHeaderLength)) : undefined)
          ?? (bytes.some(byte=>byte>127) || declaresCharset ? probeChatLogEncoding(bytes) : undefined);
        if (detected) {
          this._chatLogEncoding=detected;
          encodingConfirmed=true;
          encodingHeader=undefined;
        }
      }
      const line=iconv.decode(bytes,this._chatLogEncoding).replace(/\r$/,'');
      const source=this.source(filePath,start,end);
      if (source && start<unassignedUntil) source.unassigned=true;
      this.consumeDecodedLine(line,source);
    };
    const bufferPartial=(bytes:Buffer)=>{
      const used=position-completed,size=used+bytes.length;
      if (size>LIVE_MAX_ROW_BYTES) {partial=undefined;return;}
      if (!partial || partial.length<size) {
        const next=Buffer.allocUnsafe(Math.min(LIVE_MAX_ROW_BYTES,Math.max(4096,size,(partial?.length ?? 0)*2)));
        partial?.copy(next,0,0,used);
        partial=next;
      }
      bytes.copy(partial,used);
    };
    const finishRow=(bytes:Buffer,end:number)=>{
      const size=position-completed+bytes.length;
      if (size<=LIVE_MAX_ROW_BYTES) {
        if (partial) bufferPartial(bytes);
        parse(partial ? partial.subarray(0,size) : bytes,completed,end);
      } else {
        log(`[CHAT_LOG] 로그 행 길이 오류, 건너뜀: ${filePath} offset=${completed} bytes=${size}`);
      }
      partial=undefined;
      position=completed=end;
      this.drainNormalizedLines();
    };
    type ReadOptions={flushClosed?:boolean;protectIncomplete?:boolean;bounded?:boolean;limit?:LogReadLimit};
    // 실시간 읽기 한 번의 프로필 기록은 한 commit으로 모으고(withLiveBatch), 이 범위의 commit은 flush 없이 확정한다
    // (ApplicationData.withRelaxedDurability: 정전 시 북마크와 함께 되돌아가 원본에서 다시 기록).
    const read=(options?:ReadOptions)=>{
      const run=()=>this.withLiveBatch(()=>readNow(options));
      const store=getProfileRuntime()?.service.store;
      return store ? store.withRelaxedDurability(run) : run();
    };
    const readNow=(options?:ReadOptions)=>{
      this.drainNormalizedLines();
      const fd=fs.openSync(filePath,'r');
      try {
        const stat=fs.fstatSync(fd),identity=chatLogFileIdentity(stat),limit=options?.limit;
        const store=!this.recoveryParser && !this._syncPaused ? getProfileRuntime()?.service.store : undefined;
        const persistBookmark=(offset:number)=>{
          if (!store || (lastSavedOffset===offset && lastStat && chatLogFileIdentity(lastStat)===identity)) return;
          // 경험치 줄만 읽는 동안은 처리 구간을 메모리에 두므로(ApplicationData.deferAppliedRange) 북마크도 최대 1분 간격으로
          // 저장한다. 저장할 때는 구간을 먼저 써서 북마크가 처리 구간을 앞서지 않게 한다.
          // 구간 쓰기가 실패하면 같은 1분 간격으로만 다시 시도한다(디스크 오류 동안 매 읽기 재시도·로그 반복 방지).
          if (store.hasDeferredRange) {
            const now=Date.now();
            if ([lastSavedAt,deferredFailedAt].some(at=>at!==undefined && now-at<DEFERRED_BOOKMARK_MS)) return;
            try {store.flushDeferredRange();deferredFailedAt=undefined;}
            catch (error) {deferredFailedAt=now;log(`[CHAT_LOG] 미룬 처리 구간 저장 보류: ${String(error)}`);return;}
          }
          // 저장에 실패하면 lastSavedOffset을 그대로 두어 다음 읽기에서 다시 저장한다(saveWatchBookmark 계약).
          if (this.saveWatchBookmark(bookmarkKey,bookmarkPath,
            {offset,identity,bytes:sampleChatLogBoundary(fd,offset),unassignedUntil,encodingConfirmed},
            store.getRecordContext().deviceId ?? undefined)) {lastSavedOffset=offset;lastSavedAt=Date.now();}
        };
        // 감시 북마크는 결합 대기 줄과 저장하지 못한 프로필 기록의 시작을 넘지 않는다(다음 실행이 그 줄부터 다시 기록).
        const safeBookmarkOffset=()=>Math.min(this._pendingProfileSource?.start ?? completed,this.firstUnpersistedProfileStart() ?? completed);
        if (limit && (identity!==limit.identity || stat.size<limit.size || !sampleChatLogBoundary(fd,limit.size).equals(limit.bytes))) {
          throw new Error('처리 중 채팅 로그 파일이 바뀌었습니다. 다시 시도해 주세요.');
        }
        const end=limit?.size ?? stat.size;
        // 파일이 이미 다시 커졌어도 이전 읽기 경계의 원문이나 파일 ID가 바뀌면 새로 읽는다.
        if (position>stat.size || boundary && (identity!==boundary.identity || boundary.offset>stat.size
          || !sampleChatLogBoundary(fd,boundary.offset).equals(boundary.bytes))) {
          if (this.recoveryParser) throw new Error('The source of the live log checkpoint has changed');
          position=completed=0;partial=undefined;unassignedUntil=0;
          // 처음부터 다시 읽으므로 이전 내용 기준의 읽은 범위(끝 위치)와 미룬 처리 구간을 버린다. 남기면 다음 구간 끝이 바뀐 파일의
          // 크기를 넘어, 그 자리에 새로 쓰이는 줄을 이미 처리한 줄로 보고 버린다(회귀: check-profile-log-replace.ts).
          const replacedFingerprint=this._sourceFingerprint;
          this._liveProcessed=undefined;this._liveCovered=undefined;this._liveUnassignedEnd=undefined;
          if (replacedFingerprint) getProfileRuntime()?.service.store.discardDeferredRange(replacedFingerprint);
          this._sourceFingerprint=undefined;
          this._lineNormalizer.reset();this._pendingProfileSource=undefined;this._pendingProfileLine=undefined;
          this._chatLogEncoding='euc-kr';
          encodingConfirmed=false;
          lastSavedOffset=undefined;
          encodingHeader=undefined;encodingHeaderLength=0;
          chatParser.setCurrentDate(this.logFileDate(filePath));
        }
        // 아직 저장한 위치가 없으면(첫 읽기·저장 실패 뒤 회복) 끝 저장과 같은 규칙으로 미저장 기록의 시작을 넘지 않는다.
        if (lastSavedOffset===undefined) persistBookmark(safeBookmarkOffset());
        if (this._unassignedReadPending) unassignedUntil=Math.max(unassignedUntil,end);
        const start=position,deadline=options?.bounded ? performance.now()+LIVE_READ_SLICE_MS : Infinity;
        const sliceEnd=options?.bounded ? Math.min(end,start+LIVE_READ_MAX_BYTES) : end;
        let linesRead=0,yielded=false;
        readBlocks: while (position<sliceEnd) {
          const chunkStart=position;
          const chunk=Buffer.allocUnsafe(Math.min(SYNC_CATCH_UP_CHUNK_BYTES,sliceEnd-position));
          const length=fs.readSync(fd,chunk,0,chunk.length,position);
          if (!length) break;
          const data=chunk.subarray(0,length);
          let lineStart=0;
          for (let index=data.indexOf(10);index!==-1;index=data.indexOf(10,lineStart)) {
            finishRow(data.subarray(lineStart,index),chunkStart+index+1);
            lineStart=index+1;
            if (options?.bounded && (++linesRead>=LIVE_READ_MAX_LINES || linesRead>=4 && performance.now()>=deadline)) {
              yielded=position<end;
              break readBlocks;
            }
          }
          // 다음 개행까지 오프셋은 유지하되 비정상 행은 메모리에 쌓지 않는다.
          if (lineStart<length) bufferPartial(data.subarray(lineStart));
          position=chunkStart+length;
          if (options?.bounded && performance.now()>=deadline) {yielded=position<end;break;}
        }
        yielded ||= sliceEnd<end && position===sliceEnd;
        if (!yielded && (flushClosedLine || options?.flushClosed) && partial) {
          const row=partial.subarray(0,position-completed);
          if (/<\/br>\s*$/i.test(iconv.decode(row,this._chatLogEncoding))) finishRow(Buffer.alloc(0),position);
        }
        if (!yielded && options?.protectIncomplete && position>completed) unassignedUntil=Math.max(unassignedUntil,position);
        if (completed>=unassignedUntil) unassignedUntil=0;
        if (!yielded) flushClosedLine=false;
        this._unassignedReadPending=false;this._deferredLiveRead=false;
        diagTransition('log-read','reading');
        boundary={offset:position,identity,bytes:sampleChatLogBoundary(fd,position),unassignedUntil,encodingConfirmed};
        if (!yielded && this._lineNormalizer.hasPending() && !this._normalizerFlushTimer && !this._syncCatchUpActive && !this.profileBoundaryActive) {
          this.scheduleNormalizedFlush(100);
        }
        this._tailRetryAttempts=0;
        lastCheckpoint={offset:completed,identity,bytes:sampleChatLogBoundary(fd,completed),unassignedUntil,encodingConfirmed};
        // A normalized line still waiting for its continuation has not passed the
        // durable event boundary. Restart from its first byte if the process stops.
        // 저장하지 못한 프로필 기록이 있으면 그 줄의 시작에서 멈춘다(다음 실행이 다시 기록).
        this.flushActiveLiveBatch();
        persistBookmark(safeBookmarkOffset());
        lastStat=stat;
        lastVerifiedAt=performance.now();
        return {checkpoint:lastCheckpoint,start,end:position,yielded};
      } finally {fs.closeSync(fd);}
    };
    const initial=deferInitial ? undefined : read({bounded:background});
    let continuation:NodeJS.Immediate | undefined;
    const scheduleContinuation=()=>{
      if (continuation) return;
      continuation=setImmediate(()=>{continuation=undefined;onChange();});
      continuation.unref();
    };
    const onChange=()=>{
      if (this._tail!==watch || this._syncPaused || this.profileBoundaryActive) return;
      if (getProfileRuntime()?.canReadLiveLog?.()===false) {this.deferLiveRead();return;}
      try {if (read({bounded:true}).yielded) scheduleContinuation();}
      catch (error) {
        log('[CHAT_LOG] 감시 오류: '+String(error));
        this._tail=releaseFailedTail(watch);
        this.scheduleTailReconnect(filePath,boundary,completed);
      }
    };
    // 파일 이벤트 누락을 보완한다. 유휴 상태에서는 메타데이터만 읽고,
    // 동일한 메타데이터로 다시 쓰인 경우도 주기적으로 바이트 경계를 재검증한다.
    const poll=()=>{
      if (this._tail!==watch || this._syncPaused || this.profileBoundaryActive) return;
      if (this.logFileDate(filePath)!==formatLocalDateKey() && this.checkDailyLog(this.getTodayFilePath())) return;
      if (getProfileRuntime()?.canReadLiveLog?.()===false) {
        this.deferLiveRead();
        return;
      }
      const previous=lastStat;
      if (previous && !this._deferredLiveRead && performance.now()-lastVerifiedAt<BOUNDARY_RECHECK_MS) {
        try {
          const stat=fs.statSync(filePath);
          if (stat.size===position && stat.mtimeMs===previous.mtimeMs && stat.ctimeMs===previous.ctimeMs
            && chatLogFileIdentity(stat)===chatLogFileIdentity(previous)) return;
        } catch { /* 기존 읽기 경로에서 오류를 처리하고 재연결한다. */ }
      }
      onChange();
    };
    const timer=setInterval(poll,LIVE_POLL_MS);timer.unref();
    const watch:LiveLogWatch={checkpoint:()=>lastCheckpoint,readTo:(limit,protectIncomplete)=>{
      const step=():void | Promise<void>=>{
        if (this._tail!==watch) throw new Error('채팅 로그 감시가 중단되었습니다.');
        if (read({flushClosed:true,protectIncomplete,bounded:true,limit}).yielded) {
          return new Promise<void>(resolve=>setImmediate(resolve)).then(step);
        }
      };
      return step();
    },protectPartial:()=>{
      if (position===completed) return;
      unassignedUntil=Math.max(unassignedUntil,position);
      if (boundary) boundary.unassignedUntil=unassignedUntil;
      if (lastCheckpoint) lastCheckpoint.unassignedUntil=unassignedUntil;
    },read:options=>read(options).checkpoint,refresh:onChange,unwatch:()=>{
      clearInterval(timer);
      if (continuation) clearImmediate(continuation);
    }};
    if (initial?.yielded) scheduleContinuation();
    return {watch,initial};
  }

  public resumeAfterHistoricalSync(
    token: ChatLogSyncPauseToken,
    startOffset: number,
    encoding: ChatLogEncoding = token.encoding,
  ): ChatLogSyncCatchUpResult {
    if (!this._syncPaused || token.id !== this._syncPauseSequence) {
      throw new Error('실시간 채팅 로그 동기화 대기 토큰이 유효하지 않습니다.');
    }
    this._chatLogEncoding=encoding;
    this._syncCatchUpActive=true;
    if (getProfileRuntime()?.canReadLiveLog?.()===false) this._unassignedReadPending=true;
    try {
      const {watch,initial}=this.watchLog(token.filePath,Math.max(0,Math.trunc(startOffset)),true,token.boundary);
      this._tail=watch;
      this.flushPendingNormalizedLine();
      this._currentFilePath=token.filePath;
      this._waitingForDailyLog=false;
      if (token.checkpointKey) {
        if (initial!.checkpoint.offset<initial!.end) this.saveHandoff(token.checkpointKey,token.filePath,this._chatLogEncoding,initial!.checkpoint);
        else getProfileRuntime()?.service.store.database.prepare('DELETE FROM app_meta WHERE key=?').run(token.checkpointKey);
      }
      this._syncPaused=false;
      this.pausedToken=undefined;
      this.watchLogDirectory(path.dirname(token.filePath));
      return {startOffset:initial!.start,handoffOffset:initial!.end,
        completedOffset:initial!.checkpoint.offset,processedBytes:initial!.end-initial!.start};
    } catch (error) {
      if (this._tail) this._tail=releaseFailedTail(this._tail);
      throw error;
    } finally {this._syncCatchUpActive=false;}
  }

  /**
   * 오늘 날짜에 해당하는 로그 파일 경로 생성
   */
  public getTodayFilePath(): string | null {
    const {chatLogPath} = config.loadFields(['chatLogPath']);
    if (!chatLogPath || !chatLogPath.trim()) return null;

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    
    const fileName = `TWChatLog_${yyyy}_${mm}_${dd}.html`;
    return path.join(chatLogPath, fileName);
  }

  /**
   * 파일 감시 초기화
   */
  private initWatch(replayExisting = true, boundary?:LogBoundary, offset?:number, strict=false, retryPath?:string,deferInitial=false,startupSnapshot?:InitialChatLogSnapshot): void {
    if (this._syncPaused) return;
    const filePath = retryPath ?? this.getTodayFilePath();
    if (!filePath) {
      log('[CHAT_LOG] 로그 폴더가 설정되지 않았거나 유효하지 않습니다.');
      return;
    }

    this.watchLogDirectory(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
      log(`[CHAT_LOG] 오늘의 로그 파일이 아직 생성되지 않음: ${filePath}`);
      this._currentFilePath=filePath;
      this._waitingForDailyLog=true;
      diagTransition('log-tail','waiting-daily-file');
      this.waitForDailyLog();
      return;
    }

    this._waitingForDailyLog=false;
    if (this._dailyLogTimer) clearTimeout(this._dailyLogTimer);
    this._dailyLogTimer=undefined;
    chatParser.setCurrentDate(this.logFileDate(filePath));
    let startBoundary=boundary;
    // 초기 이력과 tail은 같은 파일의 마지막 완성 줄을 인계 경계로 사용한다.
    if (replayExisting) {
      try {
        const snapshot = startupSnapshot ?? readInitialChatLogSnapshot(filePath);
        startBoundary=snapshot.boundary;
        this._chatLogEncoding = snapshot.encoding;
        this._recentHistoryMode = snapshot.limited;
        const bounded = snapshot.limited
          ? trimRecentChatLogLines(snapshot.lines)
          : { lines: snapshot.lines, removedCount: 0, totalChars: snapshot.lines.reduce((sum, line) => sum + line.length + 1, 0) };
        this._todayLines = bounded.lines;
        this._todayLineChars = bounded.totalChars;
        if (snapshot.damaged) {
          log(`[CHAT_LOG] 문자 손상이 감지되었습니다. 일부 로그를 해석하지 못할 수 있습니다: ${filePath}`);
        }
        if (snapshot.limited) {
          log(`[CHAT_LOG] 대형 로그 최근 구간 모드: ${(snapshot.fileSize / 1024 / 1024).toFixed(1)}MB, ${this._todayLines.length}줄 유지`);
        }

        for (let i = 0; i < Math.min(this._todayLines.length, 20); i++) {
          if (parseChatLogDateHeader(this._todayLines[i])) {
            chatParser.parseLine(this._todayLines[i]);
            break;
          }
        }
        // 앱 시작 시 오늘 로그 전체를 히스토리에 채우기 (알림/DB 저장 없이)
        this.replayTodayLog(this._todayLines);
      } catch (e) {
        log(`[CHAT_LOG] 초기 날짜 읽기 실패: ${e}`);
      }
    }

    try {
      const sourceFingerprint=prepareProfileLogSource(filePath,formatLocalDateKey());
      this._sourceFingerprint=sourceFingerprint;
      if (!startBoundary && offset===undefined) {
        const snapshot=readInitialChatLogSnapshot(filePath);
        startBoundary=snapshot.boundary;this._chatLogEncoding=snapshot.encoding;
      }
      if (offset===0 && !startBoundary) this._chatLogEncoding='euc-kr';
      if (getProfileRuntime()?.canReadLiveLog?.()===false) this._unassignedReadPending=true;
      this._tail=this.watchLog(filePath,offset ?? startBoundary!.offset,false,startBoundary,!strict,deferInitial).watch;

      this._currentFilePath = filePath;
      this._tailReconnect=undefined;
      log(`[CHAT_LOG] 파일 감시 시작: ${filePath}`);
      diagTransition('log-tail','watching',path.basename(filePath));

    } catch (err) {
      log(`[CHAT_LOG] 감시 시작 실패: ${err}`);
      if (this._tail) this._tail = releaseFailedTail(this._tail);
      this.scheduleTailReconnect(filePath,startBoundary,offset ?? startBoundary?.offset);
      if (strict) throw err;
    }
  }

  private scheduleTailReconnect(filePath: string,boundary?:LogBoundary,offset?:number): void {
    if (this._syncPaused) return;
    this._tailReconnect={filePath,boundary,offset};
    // 빠른 재시도를 다 쓰면 폴더 이벤트·주기 확인만 남는다. 그동안 실시간 기록이 멈추므로 진단에 남긴다.
    if (!this._tail && !this._tailRetryTimer) diagTransition('log-tail',this._tailRetryAttempts >= MAX_TAIL_RETRY_ATTEMPTS ? 'retry-exhausted' : 'reconnecting',path.basename(filePath));
    if (this._tailRetryTimer || this._tail || this._tailRetryAttempts >= MAX_TAIL_RETRY_ATTEMPTS) return;
    const attempt = ++this._tailRetryAttempts;
    const delayMs = getTailRetryDelayMs(attempt);
    log(`[CHAT_LOG] 파일 감시 재연결 예약: ${delayMs}ms 후 (${attempt}/${MAX_TAIL_RETRY_ATTEMPTS})`);
    this._tailRetryTimer = setTimeout(() => {
      this._tailRetryTimer = null;
      const currentPath = this.getTodayFilePath();
      if (currentPath!==filePath && this._currentFilePath!==filePath) return;
      if (!fs.existsSync(filePath)) {
        this.scheduleTailReconnect(filePath,boundary,offset);
        return;
      }
      this.tryTailReconnect();
    }, delayMs);
  }

  /** Keep the checkpoint after fast retries so directory events and polling can still catch up. */
  private tryTailReconnect(deferInitial=false):boolean {
    const pending=this._tailReconnect;
    if (this._tail || !pending || this._tailRetryTimer && !deferInitial || !fs.existsSync(pending.filePath)) return false;
    if (this._tailRetryTimer) clearTimeout(this._tailRetryTimer);
    this._tailRetryTimer=null;
    if (deferInitial) this.initWatch(false,pending.boundary,pending.offset,true,pending.filePath,true);
    else this.initWatch(false,pending.boundary,pending.offset,false,pending.filePath);
    return true;
  }

  private consumeDecodedLine(decodedLine: string,source?:ProfileLogSource): void {
    if (this._normalizerFlushTimer) {
      clearTimeout(this._normalizerFlushTimer);
      this._normalizerFlushTimer = null;
    }
    const hadPending=this._lineNormalizer.hasPending(),previous=this._pendingProfileSource;
    const previousLine=this._pendingProfileLine;
    const output=this._lineNormalizer.push(decodedLine);
    output.forEach((line,index)=>{
      const joined=output.length===1 && !this._lineNormalizer.hasPending();
      const origin=hadPending && index===0 ? previous && source && joined
        ? {...previous,end:source.end,unassigned:previous.unassigned || source.unassigned} : previous : source;
      this._normalizedRetry.push({line,source:origin,originalLine:hadPending && index===0 ? previousLine : decodedLine});
    });
    this._pendingProfileLine=this._lineNormalizer.hasPending() ? hadPending && !output.length ? previousLine : decodedLine : undefined;
    this._pendingProfileSource=this._lineNormalizer.hasPending() ? hadPending && !output.length && previous && source ? {...previous,end:source.end,unassigned:previous.unassigned || source.unassigned} : source : undefined;
  }

  /** 현재 소유자를 닫기 전에 디스크와 줄 결합 버퍼를 비운다. 프로세스 교체와 경계에 걸친
   * 미완성 줄은 새 선택 때도 자동 배정하지 않는다. 회귀: check-profile-lifecycle.ts. */
  flushProfileBoundary(kind:ProfileInputBoundary):void {
    try {
      if (kind==='replacement' || kind!=='end' && getProfileRuntime()?.canReadLiveLog?.()===false) {
        this._unassignedReadPending=true;
        this.flushPendingNormalizedLine();
      }
      this.openNewDailyLog(true);
      if (!this._syncPaused) this.tryTailReconnect(true);
      if (!this._tail && this._tailRetryTimer) throw new Error('채팅 로그 감시를 복구한 뒤 다시 시도해 주세요.');
      const readBoundary=()=>this._tail?.read({flushClosed:true,protectIncomplete:kind!=='selection'});
      readBoundary();
      this.flushPendingNormalizedLine();
      if (this.rotateDailyLog()) {
        this.openNewDailyLog(true);
        readBoundary();
        this.flushPendingNormalizedLine();
      }
    } catch (error) {
      if (kind==='end' || kind==='replacement') this.markPendingProfileInputUnassigned();
      throw error;
    }
  }

  /** 양쪽 날짜 파일의 끝을 고정해 처리 중 새 줄이 이전 프로필에 섞이지 않게 한다. */
  drainProfileBoundary(kind:ProfileInputBoundary):void | Promise<void> {
    if (this.profileBoundaryTask) return this.profileBoundaryTask.catch(()=>{}).then(()=>this.drainProfileBoundary(kind));
    if (this._syncPaused) throw new Error('과거 로그 복원이 끝난 뒤 다시 시도해 주세요.');
    this.profileBoundaryActive=true;
    const capture=(file:string | null):LogReadLimit | undefined=>{
      if (!file || !fs.existsSync(file)) return;
      const fd=fs.openSync(file,'r');
      try {const stat=fs.fstatSync(fd);return {size:stat.size,identity:chatLogFileIdentity(stat),bytes:sampleChatLogBoundary(fd,stat.size)};}
      finally {fs.closeSync(fd);}
    };
    const fail=(error:unknown):never=>{
      this.profileBoundaryActive=false;
      if (kind==='end' || kind==='replacement') this.markPendingProfileInputUnassigned();
      throw error;
    };
    try {
      const current=this._currentFilePath,today=this.getTodayFilePath();
      const nextLimit=current!==today && current && today && path.dirname(current)===path.dirname(today) ? capture(today) : undefined;
      let previousDeferred=false;
      const deferPrevious=(error:unknown)=>{
        const code=(error as NodeJS.ErrnoException | undefined)?.code;
        if (!nextLimit || !current || !['EACCES','EPERM','EBUSY','ENOENT','EIO'].includes(code || '')) throw error;
        this.flushPendingNormalizedLine();
        const store=getProfileRuntime()?.service.store;
        if (store) {
          const filePath=path.resolve(current), boundary=this._tail?.checkpoint() ?? this._tailReconnect?.boundary;
          const handoff:StoredLogHandoff={filePath,encoding:this._chatLogEncoding,localDeviceId:store.getRecordContext().deviceId ?? undefined,
            boundary:boundary && {...boundary,bytes:boundary.bytes.toString('hex')}};
          // 기존 복구 시작점이 더 앞설 수 있다. 원본은 정리 대상에서 제외하고 다음 실행에서 미배정으로 복구한다.
          store.database.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)')
            .run(HANDOFF_PREFIX+filePath.toLowerCase(),JSON.stringify(handoff));
        }
        previousDeferred=true;
        log(`[CHAT_LOG] 이전 날짜 로그는 복구 대기로 남기고 오늘 감시를 시작합니다: ${String(error)}`);
      };
      let currentLimit:LogReadLimit | undefined;
      try {currentLimit=capture(current);}
      catch (error) {deferPrevious(error);}
      if (!currentLimit && !previousDeferred && (this._tail || this._tailReconnect) && nextLimit) {
        deferPrevious(Object.assign(new Error('이전 날짜 로그 파일을 찾을 수 없습니다.'),{code:'ENOENT'}));
      }
      const drain=(limit:LogReadLimit | undefined,keepPartial:boolean)=>{
        const finish=()=>{
          if (keepPartial && this._pendingProfileSource && this._lineNormalizer.hasPending()) {
            // 이어지는 줄이 새 프로필에서 읽혀도 결합 원문은 미배정으로 남긴다.
            if (kind!=='switch') this._pendingProfileSource.unassigned=true;
          } else this.flushPendingNormalizedLine();
        };
        if (!limit || !this._tail) {finish();return;}
        const read=this._tail.readTo(limit,kind==='end' || kind==='replacement');
        if (read) return read.then(finish);
        finish();
      };
      if (kind==='replacement' || kind!=='end' && getProfileRuntime()?.canReadLiveLog?.()===false) {
        this._unassignedReadPending=true;this.flushPendingNormalizedLine();
      }
      if (currentLimit && this._tailReconnect?.filePath===current) {
        try {this.tryTailReconnect(true);}
        catch (error) {deferPrevious(error);}
      }
      if (!this._tail && !this._tailReconnect && this._waitingForDailyLog && currentLimit && current===today) {
        this.initWatch(false,undefined,0,true,current!,true);
      }
      if (!this._tail && this._tailReconnect && (kind==='end' || kind==='replacement')) this._unassignedReadPending=true;
      if (!previousDeferred && (!this._tail && this._tailRetryTimer || this._tail && !currentLimit)) throw new Error('채팅 로그 감시를 복구한 뒤 다시 시도해 주세요.');
      if (this._normalizerFlushTimer) clearTimeout(this._normalizerFlushTimer);
      this._normalizerFlushTimer=null;
      const next=()=>{
        // 자정이 작업 중 지나갔다면 다음 폴링에서 새 파일을 발견한다.
        if (!nextLimit || this.getTodayFilePath()!==today || !this.rotateDailyLog()) return;
        if (kind==='replacement') this._unassignedReadPending=true;
        this.initWatch(false,undefined,0,true,this._currentFilePath!,true);
        return drain(nextLimit,kind!=='selection');
      };
      const finish=()=>{
        this.profileBoundaryActive=false;this.profileBoundaryTask=undefined;
        if (this._tail && this._lineNormalizer.hasPending() && !this._normalizerFlushTimer) this.scheduleNormalizedFlush(100);
      };
      let first:void | Promise<void>=undefined;
      if (!previousDeferred) {
        try {first=drain(currentLimit,kind!=='selection' && !nextLimit)?.catch(deferPrevious);}
        catch (error) {deferPrevious(error);}
      }
      const pending=first ? first.then(next) : next();
      if (pending) {
        const task=pending.catch(fail).finally(finish);
        this.profileBoundaryTask=task;
        return task;
      }
      finish();
    } catch (error) {fail(error);}
  }

  /** 로컬 전환 확정 전에 실패하면 나머지 원문도 기존 프로필에 이어서 기록한다. */
  commitProfileInputBoundary():void {
    this._liveCovered=undefined;
    this._tail?.protectPartial();
    if (this._tailReconnect) this._unassignedReadPending=true;
    if (this._pendingProfileSource) this._pendingProfileSource.unassigned=true;
  }

  /** 게임 프로세스 확인이 맞지 않아 실시간 읽기를 미룬다. 미루는 동안 HUD·일지가 멈추므로 진단에 남긴다. */
  private deferLiveRead():void {
    this._deferredLiveRead=true;
    diagTransition('log-read','deferred:game-process-not-current');
  }

  resumeDeferredLiveRead():void {if (this._deferredLiveRead) this._tail?.refresh();}

  private scheduleNormalizedFlush(delay:number):void {
    this._normalizerFlushTimer=setTimeout(()=>{
      this._normalizerFlushTimer=null;
      if (getProfileRuntime()?.canReadLiveLog?.()===false) {this.scheduleNormalizedFlush(1000);return;}
      try {this.flushPendingNormalizedLine();}
      catch (error) {log('[CHAT_LOG] 보류한 로그 저장 실패, 재시도합니다: '+String(error));}
    },delay);
    this._normalizerFlushTimer.unref();
  }

  flushPendingNormalizedLine(): void {
    if (this._normalizerFlushTimer) clearTimeout(this._normalizerFlushTimer);
    this._normalizerFlushTimer=null;
    this.drainNormalizedLines();
    for (const line of this._lineNormalizer.flush()) {
      this._normalizedRetry.push({line,source:this._pendingProfileSource,originalLine:this._pendingProfileLine});
    }
    this._pendingProfileSource=undefined;
    this._pendingProfileLine=undefined;
    this.drainNormalizedLines();
    // 경계(전환·종료)와 예약 재시도는 저장이 밀린 기록까지 확정해야 한다. 실패하면 호출자에게 알린다.
    this.drainProfilePersistRetry();
  }

  /** 저장이 밀린 줄이 남아 있는지(북마크·파일 전환 판단용). */
  private hasUnpersistedProfileRecords():boolean {
    return this._profilePersistRetry.length>0 || this._profilePersistPinnedStart!==undefined || !!this._liveBatch?.length;
  }

  /** 다음 실행에서 다시 읽어야 하는 가장 앞선 원본 위치. 없으면 undefined. */
  private firstUnpersistedProfileStart():number | undefined {
    const starts=[this._profilePersistPinnedStart,...this._profilePersistRetry.map(item=>item.start),...(this._liveBatch ?? []).map(item=>item.start)]
      .filter((start):start is number=>start!==undefined);
    return starts.length ? Math.min(...starts) : undefined;
  }

  /** 이번에 저장할 줄들과 그 사이·뒤의 채팅 줄을 덮는 읽기 구간. 저장이 밀린 줄이 없을 때만 부른다
   * (해석을 마친 줄 중 기록 줄은 모두 이번 저장에 들어 있으므로 processed 끝까지 덮어도 된다).
   * 기능 계약 — 구간은 이 프로필이 이번에 반영하는 줄과 그 사이의 기록 없는 줄만 덮는다.
   * - 시작은 직전 확정 구간의 끝(covered)이다. 저장 재시도 대기열을 거친 줄은 대기 경로(대기 행·HUD 대기 행)로 저장되므로
   *   재시도에 넣을 때 covered를 지운다(queueProfilePersistRetry). 남기면 다음 구간이 그 줄까지 덮어 비정상 종료 뒤 HUD에 두 번 재생된다.
   * - 미배정으로 읽은 줄(_liveUnassignedEnd 앞)은 덮지 않는다. 그 안의 경험치 줄은 버린 줄이다.
   * 회귀: check-profile-lifecycle.ts(저장 재시도 뒤 HUD 복원 구간, 미배정 줄 뒤 구간 시작). */
  private liveSpan(starts:Array<number | undefined>):LiveReadSpan | undefined {
    const processed=this._liveProcessed;
    if (!processed) return;
    const unassigned=this._liveUnassignedEnd,floor=unassigned?.fingerprint===processed.fingerprint ? unassigned.end : 0;
    // 미배정 기록 줄(구간 앞)은 시작 후보에서 뺀다. 대기 경로로 처리되고 구간이 덮지 않는다.
    const known=starts.filter((start):start is number=>start!==undefined && start>=floor);
    if (!known.length) return;
    const first=Math.min(...known),covered=this._liveCovered;
    if (first>processed.end) return;
    const start=covered?.fingerprint===processed.fingerprint && covered.end<=first && covered.end>=floor ? covered.end : first;
    return {fingerprint:processed.fingerprint,logDate:processed.logDate,start,end:processed.end,...(processed.filePath ? {filePath:processed.filePath} : {})};
  }

  private persistLiveRecords(records:LiveProfileRecord[],start?:number):void {
    if (!records.length) return;
    if (this._profilePersistPinnedStart!==undefined) return; // 상한 초과 뒤에는 다음 실행이 다시 기록한다.
    if (this._liveBatch) {this._liveBatch.push({records,start});return;}
    if (!this._profilePersistRetry.length) {
      const span=this.liveSpan([start]);
      try {persistLiveProfileRecords(records,span);if (span) this._liveCovered={fingerprint:span.fingerprint,end:span.end};return;}
      catch (error) {log('[CHAT_LOG] 프로필 기록 저장 실패, 다음 줄은 계속 읽고 기록만 재시도합니다: '+String(error));}
    }
    this.queueProfilePersistRetry(records,start);
  }

  /** 기능 계약 — 실시간 읽기 한 번(read)의 프로필 기록은 그 읽기 안에서 모아 한 commit으로 저장한다.
   * - 묶음은 동기 read() 안에서만 존재하고, 북마크 저장 직전과 read()를 벗어날 때(예외 포함) 반드시 저장한다.
   *   다른 경로(줄 결합 타이머·경계 처리·재시도)는 묶음 없이 줄마다 저장한다.
   * - 묶음 저장이 실패하면 줄별로 기존 재시도 대기열에 넣는다. 줄 수 상한·북마크 고정 규칙은 줄 단위 그대로다.
   * - 묶음에 있는 동안에도 북마크는 그 첫 줄의 시작을 넘지 않는다(firstUnpersistedProfileStart).
   * 회귀: check-profile-recording.ts(읽기 묶음 한 commit), check-profile-lifecycle.ts(저장 실패 줄별 재시도·상한). */
  private withLiveBatch<T>(work:()=>T):T {
    if (this._liveBatch) return work();
    this._liveBatch=[];
    try {return work();}
    finally {
      const batch=this._liveBatch;
      this._liveBatch=undefined;
      if (batch.length) this.flushLiveBatch(batch);
    }
  }

  private flushActiveLiveBatch():void {
    const batch=this._liveBatch;
    if (!batch?.length) return;
    this._liveBatch=[];
    this.flushLiveBatch(batch);
  }

  /** 예외를 던지지 않는다. 저장하지 못한 줄은 재시도 대기열(또는 상한 뒤 북마크 고정)로 넘긴다. */
  private flushLiveBatch(batch:Array<{records:LiveProfileRecord[];start?:number}>):void {
    if (this._profilePersistPinnedStart===undefined && !this._profilePersistRetry.length) {
      const span=this.liveSpan(batch.map(item=>item.start));
      try {
        persistLiveProfileBatch(batch.map(item=>item.records),span);
        if (span) this._liveCovered={fingerprint:span.fingerprint,end:span.end};
        return;
      }
      catch (error) {log('[CHAT_LOG] 프로필 기록 저장 실패, 다음 줄은 계속 읽고 기록만 재시도합니다: '+String(error));}
    }
    for (const {records,start} of batch) {
      if (this._profilePersistPinnedStart!==undefined) return;
      this.queueProfilePersistRetry(records,start);
    }
  }

  private queueProfilePersistRetry(records:LiveProfileRecord[],start?:number):void {
    // 재시도로 저장하는 줄은 대기 경로(대기 행·HUD 대기 행)로 들어간다. 다음 바로 반영 구간이 그 줄을 덮지 않게 한다(liveSpan 계약).
    this._liveCovered=undefined;
    if (this._profilePersistRetry.length>=this._maxProfilePersistRetryLines) {
      this._profilePersistPinnedStart=Math.min(start ?? Infinity,this.firstUnpersistedProfileStart() ?? Infinity);
      if (!Number.isFinite(this._profilePersistPinnedStart)) this._profilePersistPinnedStart=0;
      log(`[CHAT_LOG] 저장하지 못한 기록이 ${this._maxProfilePersistRetryLines}줄을 넘어 메모리 보관을 멈춥니다. 다음 실행에서 원본부터 다시 기록합니다.`);
      return;
    }
    this._profilePersistRetry.push({records,start});
    this.scheduleProfilePersistRetry();
  }

  /** 저장이 밀린 기록을 순서대로 확정한다. 실패하면 남은 기록을 보존한 채 재시도를 예약하고 예외를 던진다. */
  private drainProfilePersistRetry():void {
    while (this._profilePersistRetry.length) {
      try {persistLiveProfileRecords(this._profilePersistRetry[0].records);}
      catch (error) {
        this.scheduleProfilePersistRetry();
        throw error;
      }
      this._profilePersistRetry.shift();
    }
  }

  /** 저장 재시도는 줄 결합 타이머와 따로 예약한다. 결합 타이머는 새 줄을 읽을 때마다 취소되므로
   * 함께 쓰면 줄이 이어서 들어온 뒤 멈췄을 때 재시도가 사라져 DB가 회복돼도 저장하지 않는다. */
  private scheduleProfilePersistRetry():void {
    if (this._profilePersistRetryTimer || !this._profilePersistRetry.length) return;
    this._profilePersistRetryTimer=setTimeout(()=>{
      this._profilePersistRetryTimer=null;
      if (getProfileRuntime()?.canReadLiveLog?.()===false) {this.scheduleProfilePersistRetry();return;}
      try {this.drainProfilePersistRetry();}
      catch (error) {log('[CHAT_LOG] 보류한 프로필 기록 저장 실패, 재시도합니다: '+String(error));}
    },1000);
    this._profilePersistRetryTimer.unref();
  }

  /** 복구하지 못한 오늘 파일의 감시 경계를 복구 대기(handoff)로 옮긴다. 새 감시가 같은 키의 북마크를
   * 덮어써 복구 구간을 잃지 않게 하고, 다음 실행의 handoff 복구가 그 구간을 미배정으로 다시 기록한다. */
  private deferBlockedTodayWatch(filePath:string):void {
    const store=getProfileRuntime()?.service.store;
    if (!store) return;
    const resolved=path.resolve(filePath).toLowerCase();
    try {
      store.database.transaction(()=>{
        const row=store.database.prepare('SELECT value FROM app_meta WHERE key=?').get(WATCH_CHECKPOINT_PREFIX+resolved) as {value:string} | undefined;
        if (!row) return;
        store.database.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)').run(HANDOFF_PREFIX+resolved,row.value);
        store.database.prepare('DELETE FROM app_meta WHERE key=?').run(WATCH_CHECKPOINT_PREFIX+resolved);
      })();
    } catch (error) {log('[CHAT_LOG] 오늘 로그 감시 경계를 복구 대기로 옮기지 못했습니다: '+String(error));}
  }

  /** 메모리 상한으로 버린 기록이 있는 파일을 떠날 때, 그 시작 위치를 복구 대기(handoff)로 남긴다.
   * 오늘 파일의 감시 북마크는 날짜가 바뀌면 복구 대상이 아니므로 다음 실행이 이 경계부터 미배정으로 복구한다. */
  private handOffPinnedProfileRecords(filePath:string):void {
    const offset=this._profilePersistPinnedStart;
    this._profilePersistPinnedStart=undefined;
    const store=getProfileRuntime()?.service.store;
    if (offset===undefined || !store) return;
    try {
      const fd=fs.openSync(filePath,'r');
      try {
        const stat=fs.fstatSync(fd),resolved=path.resolve(filePath);
        const handoff:StoredLogHandoff={filePath:resolved,encoding:this._chatLogEncoding,localDeviceId:store.getRecordContext().deviceId ?? undefined,
          boundary:{offset,identity:chatLogFileIdentity(stat),bytes:sampleChatLogBoundary(fd,offset).toString('hex')}};
        store.database.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)').run(HANDOFF_PREFIX+resolved.toLowerCase(),JSON.stringify(handoff));
      } finally {fs.closeSync(fd);}
    } catch (error) {log('[CHAT_LOG] 저장하지 못한 이전 날짜 기록의 복구 위치를 남기지 못했습니다: '+String(error));}
  }

  /** 세션 종료·교체로 현재 소유자에게 기록할 수 없게 된 보류 입력을 미배정으로 돌린다. */
  private markPendingProfileInputUnassigned():void {
    this._unassignedReadPending=true;
    this._liveCovered=undefined;
    if (this._pendingProfileSource) this._pendingProfileSource.unassigned=true;
    for (const row of this._normalizedRetry) if (row.source) row.source.unassigned=true;
    for (const item of this._profilePersistRetry) for (const record of item.records) record.unassigned=true;
  }

  private drainNormalizedLines():void {
    // 결합 결과와 원본 위치를 보관한 뒤 물리 줄의 읽기 위치를 넘긴다.
    // 중간 저장 실패 뒤에도 같은 첫 줄의 이벤트 ID로 재시도한다.
    while (this._normalizedRetry.length) {
      const {line,source,originalLine}=this._normalizedRetry[0];
      try {this.processNormalizedLine(line,source,originalLine);}
      catch (error) {
        if (this._normalizerFlushTimer) clearTimeout(this._normalizerFlushTimer);
        this.scheduleNormalizedFlush(1000);
        throw error;
      }
      this._normalizedRetry.shift();
    }
  }

  private processNormalizedLine(line: string,source?:ProfileLogSource,originalLine?:string): void {
    // 회복 로그 등 너무 빈번한 로그는 결합이 끝난 뒤 1차로 제외합니다.
    if (line.includes('회복되었습니다')) return;
    const parser=this.recoveryParser || chatParser;
    const parse=()=>withProfileLogSource(source,()=>parser.parseLine(line),originalLine);
    if (source && !this.recoveryParser) {
      const records=collectLiveProfileLine(parse);
      // 해석을 마친 줄의 끝(읽은 범위의 후보). 기록 줄은 아래 저장(또는 묶음)에 들어간 뒤의 위치다.
      if (this._sourceLogDate) {
        const previous=this._liveProcessed;
        this._liveProcessed={fingerprint:source.fingerprint,logDate:this._sourceLogDate,filePath:this._sourceFilePath,
          end:previous?.fingerprint===source.fingerprint ? Math.max(previous.end,source.end) : source.end};
        if (source.unassigned) {
          const before=this._liveUnassignedEnd;
          this._liveUnassignedEnd={fingerprint:source.fingerprint,end:before?.fingerprint===source.fingerprint ? Math.max(before.end,source.end) : source.end};
        }
      }
      if (records) this.persistLiveRecords(records,source.start);
    } else parse();
    if (this.recoveryParser) return;
    this._todayLines.push(line);
    this._todayLineChars += line.length + 1;
    this.trimRecentHistoryIfNeeded();
  }

  /** 오늘 로그 메모리 창은 시작 모드와 관계없이 MAX_RECENT_HISTORY_CHARS를 넘으면 오래된 줄부터 정리한다.
   * 작은 파일로 시작해 하루 종일 사냥하면 줄이 계속 쌓였다(줄당 약 286바이트, 초당 40줄이면 시간당 약 33MB).
   * 상한 안에서는 기존처럼 오늘 전체를 검색·탭 이력에 쓴다. 회귀: check-refactor-regressions.ts(checkLargeChatLogReadBoundary). */
  private trimRecentHistoryIfNeeded(): void {
    if (this._todayLineChars <= MAX_RECENT_HISTORY_CHARS) return;
    const trimmed = trimRecentChatLogLines(this._todayLines);
    if (trimmed.removedCount === 0) return;
    this._todayLines = trimmed.lines;
    this._todayLineChars = trimmed.totalChars;
    for (const indexes of [this._initialReadIndex, this._lastReadIndex]) {
      for (const key of Object.keys(indexes)) {
        indexes[key] = Math.max(0, indexes[key] - trimmed.removedCount);
      }
    }
    log(`[CHAT_LOG] 대형 로그 메모리 창 정리: 오래된 ${trimmed.removedCount}줄 제거`);
  }

  /**
   * 오늘 로그 파일의 기존 내용을 파싱해 히스토리에 채움 (알림/DB저장 없이 replay만)
   */
  private replayTodayLog(lines: string[]): void {
    const cfg = config.load();
    const serverCode = cfg.userServer || (DEFAULT_CONFIG.userServer as number);

    // 리플레이 시작 전 기존 버퍼스토어 초기화
    chatLogProcessor.clearHistoryStore();

    // 날짜 헤더 감지 (파서와 같은 parseChatLogDateHeader 계약. 채팅 본문의 "Date :"는 무시)
    let currentDate = formatLocalDateKey();
    for (const line of lines.slice(0, 20)) {
      const headerDate = parseChatLogDateHeader(line);
      if (headerDate) { currentDate = headerDate; break; }
    }

    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').trim();
    
    // 각 카테고리별로 최대 150개씩 수집하도록 제한
    const limit = 150;
    const categoryCounts: Record<string, number> = {
      Basic: 0,
      System: 0,
      Shout: 0,
      General: 0,
      Team: 0,
      Club: 0,
      Whisper: 0
    };

    // 각 카테고리별로 어디까지 스캔했는지 기록할 변수들
    const categoryFinalIndexes: Record<string, number> = {
      Basic: 0,
      System: 0,
      Shout: 0,
      General: 0,
      Team: 0,
      Club: 0,
      Whisper: 0
    };

    type ChatItemData = {
      type: 'normal' | 'shout' | 'system';
      shoutKind?: import('../shared/types').ShoutKind;
      timestamp: string;
      sender: string;
      message: string;
      color: string;
      serverCode: number;
    };

    const collectedReplays: Record<string, ChatItemData[]> = {
      Basic: [],
      System: [],
      Shout: [],
      General: [],
      Team: [],
      Club: [],
      Whisper: []
    };

    // 뒤에서부터 역순으로 루프를 돌며 각 카테고리가 150개씩 채워질 때까지 수집
    for (let i = lines.length - 1; i >= 0; i--) {
      // 모든 카테고리가 각각 150개씩 수집되었거나, 더 이상 읽을 라인이 없으면 종료
      const allFilled = categoryCounts.Basic >= limit &&
                        categoryCounts.System >= limit &&
                        categoryCounts.Shout >= limit &&
                        categoryCounts.General >= limit &&
                        categoryCounts.Team >= limit &&
                        categoryCounts.Club >= limit &&
                        categoryCounts.Whisper >= limit;
      if (allFilled) {
        break;
      }

      const rawLine = lines[i];
      if (!rawLine) continue;

      // 1. 단순 문자열 includes()로 색상 대분류 초고속 판별
      let color = CHAT_COLORS.system;
      if (rawLine.includes(`color="${CHAT_COLORS.club}"`)) {
        color = CHAT_COLORS.club;
      } else if (rawLine.includes(`color="${CHAT_COLORS.team}"`)) {
        color = CHAT_COLORS.team;
      } else if (rawLine.includes(`color="${CHAT_COLORS.whisper}"`)) {
        color = CHAT_COLORS.whisper;
      } else if (rawLine.includes(`color="${CHAT_COLORS.shout}"`)) {
        color = CHAT_COLORS.shout;
      } else if (rawLine.includes(`color="${CHAT_COLORS.general}"`)) {
        color = CHAT_COLORS.general;
      } else if (rawLine.includes(`color="${CHAT_COLORS.selfGeneral}"`)) {
        color = CHAT_COLORS.selfGeneral;
      } else {
        const colorMatch = rawLine.match(/color=["']?(#[0-9a-fA-F]{6})["']?/);
        if (colorMatch) {
          color = colorMatch[1].toLowerCase();
        }
      }

      // 2. 이 색상 카테고리가 현재 추가 스캔이 필요한지 1차로 필터링
      let catName: 'General' | 'Team' | 'Club' | 'Whisper' | 'System' | 'Shout' = 'System';
      if (color === CHAT_COLORS.club) catName = 'Club';
      else if (color === CHAT_COLORS.team) catName = 'Team';
      else if (color === CHAT_COLORS.whisper) catName = 'Whisper';
      else if (color === CHAT_COLORS.shout) catName = 'Shout';
      else if (color === CHAT_COLORS.general || color === CHAT_COLORS.selfGeneral) {
        catName = 'General';
      }

      const needForCat = categoryCounts[catName] < limit;
      const needForBasic = categoryCounts.Basic < limit;

      // 둘 다 안 필요하면, 정규식/HTML 연산을 아예 스킵하고 즉시 다음 줄로 이동!
      if (!needForCat && !needForBasic) {
        continue;
      }

      // 3. 시간 없는 라인 스킵 (여기서부터 무거운 연산 수행)
      const timeMatch = rawLine.match(/\[\s*(\d+(?:시|분)\s*\d+분\s*\d+(?:초|분))\s*\]/);
      if (!timeMatch) continue;

      const timestamp = timeMatch[1];
      const cleanMsg = stripHtml(rawLine.replace(/\[.*?\]/, ''));
      if (cleanMsg.length === 0) continue; // 빈 라인 예외 처리

      // 회복 로그는 스킵 (성능 최적화)
      if (cleanMsg.includes('회복되었습니다')) continue;

      // 4. 외치기
      if (rawLine.includes(`color="${CHAT_COLORS.shout}"`) && cleanMsg.includes('외치기 :')) {
        const shoutContent = cleanMsg.replace('외치기 :', '').trim();
        {
          const { sender, message, shoutKind } = parseShoutContent(shoutContent);

          const needForShout = categoryCounts.Shout < limit;
          const needForBasic = categoryCounts.Basic < limit;

          const shoutItem: ChatItemData = {
            type: 'shout', timestamp, sender, message, shoutKind,
            color: CHAT_COLORS.shout, serverCode
          };

          if (needForShout) {
            collectedReplays.Shout.push(shoutItem);
            categoryCounts.Shout++;
            categoryFinalIndexes.Shout = i;
          }
          if (needForBasic) {
            collectedReplays.Basic.push(shoutItem);
            categoryCounts.Basic++;
            categoryFinalIndexes.Basic = i;
          }
        }
        continue;
      }

      // 5. 일반/시스템/채널 분류 및 적재
      const classified = classifyHistoryMessage(color, cleanMsg);
      const catFinalName = classified.category;
      const type: 'normal' | 'system' =
        classified.type === 'system' ? 'system' : 'normal';
      const { sender, message, color: finalColor } = classified;

      const finalNeedForCat = categoryCounts[catFinalName] < limit;
      const finalNeedForBasic = categoryCounts.Basic < limit;

      const chatItem: ChatItemData = {
        type, timestamp, sender, message, color: finalColor, serverCode
      };

      if (finalNeedForCat) {
        collectedReplays[catFinalName].push(chatItem);
        categoryCounts[catFinalName]++;
        categoryFinalIndexes[catFinalName] = i;
      }
      if (finalNeedForBasic) {
        collectedReplays.Basic.push(chatItem);
        categoryCounts.Basic++;
        categoryFinalIndexes.Basic = i;
      }
    }

    // 각 카테고리별 수집 배열을 개별적으로 정방향 정렬(reverse)하고 replay 실행
    for (const category of Object.keys(collectedReplays)) {
      collectedReplays[category].reverse();
      for (const item of collectedReplays[category]) {
        chatLogProcessor.replayChat(category, item);
      }
    }

    // 외치기 히스토리 DB 적재 (앱 시작 시 오늘 로그의 외치기도 누락 없이 DB에 보존)
    if (collectedReplays.Shout && collectedReplays.Shout.length > 0) {
      const [y, m, d] = currentDate.split('-').map(Number);
      const midnightSec = Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000);
      for (const item of collectedReplays.Shout) {
        let fullTimestamp: number | undefined;
        if (item.timestamp) {
          const timeMatch = item.timestamp.match(/(\d+)시\s*(\d+)분\s*(\d+)초/);
          if (timeMatch) {
            const sec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseInt(timeMatch[3], 10);
            fullTimestamp = midnightSec + sec;
          }
        }
        diaryDb.addShoutLog(item.sender, item.message, fullTimestamp, item.shoutKind);
      }
      sendToFirstWindowByPage('shout-history.html', 'shout-history-updated');
    }

    this._initialReadIndex = { ...categoryFinalIndexes };
    this._lastReadIndex = { ...categoryFinalIndexes };
    this._lastReadIndex['initial'] = categoryFinalIndexes.Basic;

    log(`[CHAT_LOG] 오늘 로그 replay 완료: 각 탭별로 최대 150개씩 수집 및 적재 완료.`);

    // 리플레이 완료 후 렌더러에 갱신 알림 브로드캐스트
    chatLogProcessor.broadcastHistoryCleared();
  }

  private historyReaderKey(category: string, readerId?: number): string {
    return readerId === undefined ? category : `renderer:${readerId}:${category}`;
  }

  public releaseHistoryReader(readerId: number): void {
    const prefix = `renderer:${readerId}:`;
    for (const key of Object.keys(this._lastReadIndex)) {
      if (key.startsWith(prefix)) delete this._lastReadIndex[key];
    }
  }

  public resetLastReadIndex(category: string, readerId?: number): void {
    const cursorKey = this.historyReaderKey(category, readerId);
    if (this._initialReadIndex[category] !== undefined) {
      this._lastReadIndex[cursorKey] = this._initialReadIndex[category];
      return;
    }

    // 커스텀 탭인 경우 포함된 채널들의 initialReadIndex 중 최소값으로 안전하게 설정
    const cfg = config.load();
    const customTabs = cfg.chatOverlayCustomTabs || [];
    const customTab = resolveOverlayCustomTab(category, customTabs);
    if (customTab && Array.isArray(customTab.channels) && customTab.channels.length > 0) {
      const channelToKey: Record<string, string> = {
        general: 'General',
        team: 'Team',
        club: 'Club',
        whisper: 'Whisper',
        shout: 'Shout',
        system: 'System'
      };
      let minIndex = this._lastReadIndex['initial'] ?? this._todayLines.length;
      customTab.channels.forEach(ch => {
        const key = channelToKey[ch];
        if (key && this._initialReadIndex[key] !== undefined) {
          minIndex = Math.min(minIndex, this._initialReadIndex[key]);
        }
      });
      this._lastReadIndex[cursorKey] = minIndex;
      return;
    }

    this._lastReadIndex[cursorKey] = this._lastReadIndex['initial'] ?? 0;
  }

  public async getMoreHistory(category: string, readerId?: number): Promise<any[]> {
    const cfg = config.load();
    const serverCode = cfg.userServer || (DEFAULT_CONFIG.userServer as number);
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').trim();

    const cursorKey = this.historyReaderKey(category, readerId);
    if (typeof this._lastReadIndex[cursorKey] !== 'number') {
      this.resetLastReadIndex(category, readerId);
    }
    const startIndex = this._lastReadIndex[cursorKey] ?? 0;

    const collected: any[] = [];
    let finalIndex = 0;

    // 커스텀 탭 정보 조회
    const customTabs = cfg.chatOverlayCustomTabs || [];
    const customTab = resolveOverlayCustomTab(category, customTabs);
    const targetType = (!customTab && category !== 'Basic') ? category.toLowerCase() : null;

    for (let i = startIndex - 1; i >= 0; i--) {
      if (collected.length >= 150) {
        // 다음 요청은 startIndex - 1부터 읽으므로 아직 처리하지 않은 i를 남긴다.
        finalIndex = i + 1;
        break;
      }

      const rawLine = this._todayLines[i];
      if (!rawLine) continue;

      const timeMatch = rawLine.match(/\[\s*(\d+(?:시|분)\s*\d+분\s*\d+(?:초|분))\s*\]/);
      if (!timeMatch) continue;

      const timestamp = timeMatch[1];
      const cleanMsg = stripHtml(rawLine.replace(/\[.*?\]/, ''));
      if (cleanMsg.length === 0) continue;
      if (cleanMsg.includes('회복되었습니다')) continue;

      // 외치기
      if (rawLine.includes(`color="${CHAT_COLORS.shout}"`) && cleanMsg.includes('외치기 :')) {
        if (customTab && !customTab.channels.includes('shout')) continue;
        if (targetType && targetType !== 'shout') continue;

        const shoutContent = cleanMsg.replace('외치기 :', '').trim();
        {
          const { sender, message, shoutKind } = parseShoutContent(shoutContent);
          const rankInfo = etaCacheManager.getRankInfo(serverCode, sender);
          const level = rankInfo ? rankInfo.level : null;
          const characterCode = rankInfo ? rankInfo.characterCode : null;

          collected.push({
            id: `more-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            type: 'shout',
            shoutKind,
            timestamp,
            sender,
            message,
            color: CHAT_COLORS.shout,
            level,
            characterCode
          });
        }
        continue;
      }

      // 색상 기반 카테고리 분류
      let color = CHAT_COLORS.system;
      const colorMatch = rawLine.match(/color=["']?(#[0-9a-fA-F]{6})["']?/);
      if (colorMatch) {
        color = colorMatch[1].toLowerCase();
      }

      const { type, sender, message, color: finalColor } = classifyHistoryMessage(color, cleanMsg);

      if (customTab) {
        if (!customTab.channels.includes(type)) continue;
        if (type === 'system' && Array.isArray(customTab.systemColorFilters) && customTab.systemColorFilters.length > 0) {
          const group = getSystemColorGroup(finalColor);
          if (!customTab.systemColorFilters.includes(group)) continue;
        }
      } else if (targetType && targetType !== type) {
        continue;
      }

      const rankInfo = etaCacheManager.getRankInfo(serverCode, sender);
      const level = rankInfo ? rankInfo.level : null;
      const characterCode = rankInfo ? rankInfo.characterCode : null;

      collected.push({
        id: `more-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        type,
        timestamp,
        sender,
        message,
        color: finalColor,
        level,
        characterCode
      });
    }

    this._lastReadIndex[cursorKey] = finalIndex;
    return collected.reverse();
  }

  /**
   * 오늘 하루 전체 로그 중 검색어가 포함된 채팅 검색
   * renderer와 같은 공통 표시 필터를 결과 제한 전에 적용한다. 숨긴 NPC/XP/ELSO/외치기,
   * 제외 문구 및 미선택 채널이 표시할 결과의 자리를 차지하지 않는다.
   * 변경 시 check-chat-visibility 및 check-companion-features의 실제 검색 경계 검사를 실행한다.
   */
  public async searchChatLogs(
    query: string,
    options?: { category?: string; limit?: number }
  ): Promise<any[]> {
    if (!query || !query.trim()) return [];

    const queryClean = query.trim().toLowerCase();
    const limit = Math.max(1, Math.min(options?.limit || 300, 1000));
    const category = options?.category || 'Basic';

    const cfg = config.load();
    const serverCode = cfg.userServer || (DEFAULT_CONFIG.userServer as number);
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').trim();

    const collected: any[] = [];

    // 최신 로그부터 역순으로 검색
    for (let i = this._todayLines.length - 1; i >= 0; i--) {
      if (collected.length >= limit) break;

      const rawLine = this._todayLines[i];
      if (!rawLine) continue;

      const timeMatch = rawLine.match(/\[\s*(\d+(?:시|분)\s*\d+분\s*\d+(?:초|분))\s*\]/);
      if (!timeMatch) continue;

      const timestamp = timeMatch[1];
      const cleanMsg = stripHtml(rawLine.replace(/\[.*?\]/, ''));
      if (cleanMsg.length === 0) continue;
      if (cleanMsg.includes('회복되었습니다')) continue;

      // 1. 외치기
      if (rawLine.includes(`color="${CHAT_COLORS.shout}"`) && cleanMsg.includes('외치기 :')) {
        const shoutContent = cleanMsg.replace('외치기 :', '').trim();
        {
          const { sender, message, shoutKind } = parseShoutContent(shoutContent);

          if (!isOverlayChatVisible({ type: 'shout', message, shoutKind, color: CHAT_COLORS.shout }, cfg, category,
            isNpcChat({ type: 'shout', sender, message }))) continue;
          const senderMatch = sender.toLowerCase().includes(queryClean);
          const messageMatch = message.toLowerCase().includes(queryClean);
          const timeQueryMatch = timestamp.includes(queryClean);

          if (senderMatch || messageMatch || timeQueryMatch) {
            const rankInfo = etaCacheManager.getRankInfo(serverCode, sender);
            const level = rankInfo ? rankInfo.level : null;
            const characterCode = rankInfo ? rankInfo.characterCode : null;

            collected.push({
              id: `search-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
              type: 'shout',
              shoutKind,
              timestamp,
              sender,
              message,
              color: CHAT_COLORS.shout,
              level,
              characterCode
            });
          }
        }
        continue;
      }

      // 2. 색상 기반 카테고리 분류
      let color = CHAT_COLORS.system;
      const colorMatch = rawLine.match(/color=["']?(#[0-9a-fA-F]{6})["']?/);
      if (colorMatch) {
        color = colorMatch[1].toLowerCase();
      }

      const { type, sender, message, color: finalColor } = classifyHistoryMessage(color, cleanMsg);

      if (!isOverlayChatVisible({ type, message, color: finalColor }, cfg, category, isNpcChat({ type, sender, message }))) continue;

      const senderMatch = sender.toLowerCase().includes(queryClean);
      const messageMatch = message.toLowerCase().includes(queryClean);
      const timeQueryMatch = timestamp.includes(queryClean);

      if (senderMatch || messageMatch || timeQueryMatch) {
        const rankInfo = etaCacheManager.getRankInfo(serverCode, sender);
        const level = rankInfo ? rankInfo.level : null;
        const characterCode = rankInfo ? rankInfo.characterCode : null;

        collected.push({
          id: `search-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          type,
          timestamp,
          sender,
          message,
          color: finalColor,
          level,
          characterCode
        });
      }
    }

    return collected.reverse();
  }

  private logFileDate(filePath:string):string {
    return path.basename(filePath).match(/^TWChatLog_(\d{4})_(\d{2})_(\d{2})\.html$/i)?.slice(1).join('-') ?? formatLocalDateKey();
  }

  /** 이전 파일을 비운 직후 날짜 파일만 교체한다. 새 파일은 항상 시작부터 읽는다. */
  private rotateDailyLog():boolean {
    const current=this._currentFilePath,today=this.getTodayFilePath();
    if (this._syncPaused || !current || !today || current===today || path.dirname(current)!==path.dirname(today) || !fs.existsSync(today)) return false;
    // 이전 파일 기준 위치를 가진 미저장 기록을 새 파일로 옮기지 않는다. 경계 처리가 먼저 저장을 끝내야 넘어간다.
    if (this._profilePersistRetry.length) return false;
    this.handOffPinnedProfileRecords(current);
    this.removeCompleteWatchBookmark(current);
    this._tail?.unwatch();
    this._tail=null;
    if (this._tailRetryTimer) clearTimeout(this._tailRetryTimer);
    this._tailRetryTimer=null;
    this._tailRetryAttempts=0;
    this._tailReconnect=undefined;
    this._lineNormalizer.reset();
    this._sourceFingerprint=undefined;
    this._todayLines=[];
    this._todayLineChars=0;
    this._recentHistoryMode=false;
    this._lastReadIndex={};
    this._initialReadIndex={};
    this._currentFilePath=today;
    this._waitingForDailyLog=true;
    this.waitForDailyLog();
    chatLogProcessor.clearHistoryStore();
    chatLogProcessor.broadcastHistoryCleared();
    void this.cleanupOldLogs();
    return true;
  }

  private openNewDailyLog(strict=false,today?:string | null):boolean {
    // 앱이 이미 기다리던 파일의 첫 줄부터 실시간 기록을 처리한다.
    const file=this._currentFilePath;
    if (!this._waitingForDailyLog || this._syncPaused || !file
      || file!==(today===undefined ? this.getTodayFilePath() : today) || !fs.existsSync(file)) return false;
    if (this._tailReconnect?.filePath===file) return this.tryTailReconnect(strict);
    this.initWatch(false,undefined,0,strict);
    return true;
  }

  /** 폴더 이벤트는 읽기를 깨우는 신호다. 바이트 위치와 귀속은 기존 읽기 경로에서 확정한다. */
  private watchLogDirectory(directory:string):void {
    if (this._directoryWatch?.path===directory) return;
    this._directoryWatch?.watcher.close();
    this._directoryWatch=undefined;
    if (this._watchNotification) clearImmediate(this._watchNotification);
    this._watchNotification=undefined;
    if (!fs.existsSync(directory)) return;
    try {
      const watcher=fs.watch(directory,{persistent:false},(_event,filename)=>{
        if (this._directoryWatch?.watcher!==watcher || this._watchNotification) return;
        const name=filename?.toLowerCase();
        if (name && !/^twchatlog_\d{4}_\d{2}_\d{2}\.html$/.test(name)) return;
        this._watchNotification=setImmediate(()=>{
          this._watchNotification=undefined;
          if (this._directoryWatch?.watcher!==watcher || this._syncPaused || this.profileBoundaryActive) return;
          if (!this.checkDailyLog(this.getTodayFilePath()) && !this.tryTailReconnect()) this._tail?.refresh();
        });
      });
      this._directoryWatch={path:directory,watcher};
      watcher.on('error',error=>{
        if (this._directoryWatch?.watcher!==watcher) return;
        this._directoryWatch=undefined;
        watcher.close();
        log('[CHAT_LOG] 폴더 감시 오류, 주기 확인 유지: '+String(error));
      });
    } catch (error) {log('[CHAT_LOG] 폴더 감시 시작 실패, 주기 확인 유지: '+String(error));}
  }

  private waitForDailyLog():void {
    if (this._dailyLogTimer || !this._waitingForDailyLog) return;
    this._dailyLogTimer=setTimeout(()=>{
      this._dailyLogTimer=undefined;
      if (!this._syncPaused && !this.profileBoundaryActive) this.checkDailyLog(this.getTodayFilePath());
      this.waitForDailyLog();
    },LIVE_POLL_MS);
    this._dailyLogTimer.unref();
  }

  private checkDailyLog(today:string | null):boolean {
    if (this.openNewDailyLog(false,today)) return true;
    const current=this._currentFilePath;
    // 다음 파일이 생길 때까지 이전 파일의 늦게 기록된 줄을 계속 감시한다.
    if (!current || !today || current===today || path.dirname(current)!==path.dirname(today) || !fs.existsSync(today)) return false;
    try {
      void this.drainProfileBoundary('selection')?.catch(error=>log(`[CHAT_LOG] 날짜 변경 전 로그 반영 실패: ${String(error)}`));
      return true;
    } catch (error) {
      log(`[CHAT_LOG] 날짜 변경 전 로그 반영 실패: ${String(error)}`);
      return false;
    }
  }

  /** 설정 저장 직후 이전 파일의 완성 줄을 확정하고 새 경로를 감시한다. */
  applyConfiguredPath():void {
    if (this._pathSwitchTimer) clearTimeout(this._pathSwitchTimer);
    this._pathSwitchTimer=undefined;
    try {
      if (!this._syncPaused && !this.profileBoundaryActive) {
        const target=this.getTodayFilePath();
        if (this.checkDailyLog(target)) return;
        if (target===this._tailReconnect?.filePath && this.tryTailReconnect()) return;
        if (target===this._currentFilePath && (this._tail || this._waitingForDailyLog || this._tailRetryTimer)) return;
        this._tail?.read({flushClosed:true});
        this.flushPendingNormalizedLine();
        this.start();
        return;
      }
    } catch (error) {log('[CHAT_LOG] 설정 경로 전환 재시도: '+String(error));}
    this._pathSwitchTimer=setTimeout(()=>this.applyConfiguredPath(),LIVE_POLL_MS);
    this._pathSwitchTimer.unref();
  }

  /**
   * 날짜 변경 또는 파일 생성 감지
   */
  private checkFileChange(): void {
    if (this._syncPaused || this.profileBoundaryActive) return;
    let cfg = config.load();

    // 설정값이 비어 있을 때만 자동 탐색합니다. 지정 경로의 일시 장애는 설정을 바꾸지 않습니다.
    if (shouldAutoDiscoverChatLogPath(cfg.chatLogPath)) {
      const foundPath = findChatLogPath();
      if (foundPath) {
        config.save({ chatLogPath: foundPath });
        cfg = config.load(); // 최신 config 반영
        log(`[CHAT_LOG] 주기적 탐색을 통해 로그 경로 설정 완료: ${foundPath}`);
      }
    }

    const todayPath = this.getTodayFilePath();

    if (todayPath && this._currentFilePath && path.dirname(todayPath)===path.dirname(this._currentFilePath)) {
      this.watchLogDirectory(path.dirname(todayPath));
    }
    if (this.checkDailyLog(todayPath)) return;
    if (todayPath===this._tailReconnect?.filePath && this.tryTailReconnect()) return;
    if (todayPath !== this._currentFilePath || (todayPath && !this._tail && !this._tailRetryTimer && fs.existsSync(todayPath))) {
      const previous=this._currentFilePath;
      const dayChanged=!!todayPath && !!previous && todayPath!==previous && path.dirname(todayPath)===path.dirname(previous);
      if (dayChanged || this._normalizedRetry.length || this._profilePersistRetry.length) return;
      log('[CHAT_LOG] 로그 파일 변경 감지, 재연결 시도');
      this.applyConfiguredPath();
    }
  }

  /**
   * 오래된 채팅 로그 파일 정리
   */
  private async cleanupOldLogs(): Promise<void> {
    const cfg = config.load();
    const days = cfg.chatLogAutoDeleteDays || 0;
    if (days <= 0 || !cfg.chatLogPath || !fs.existsSync(cfg.chatLogPath)) return;

    try {
      const files = await fsp.readdir(cfg.chatLogPath);
      const now = new Date();
      // 시간/분/초를 무시하고 날짜만 비교하기 위해 자정으로 설정
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const msPerDay = 24 * 60 * 60 * 1000;
      const regex = /^TWChatLog_(\d{4})_(\d{2})_(\d{2})\.html$/;

      const todayStr = `TWChatLog_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}.html`;

      let deletedCount = 0;
      for (const file of files) {
        // 오늘 날짜 파일은 절대 건드리지 않음
        if (file === todayStr) continue;

        const match = file.match(regex);
        if (match) {
          const fileDate = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
          const diffMs = today.getTime() - fileDate.getTime();
          
          if (diffMs > days * msPerDay) {
            const filePath = path.join(cfg.chatLogPath, file);
            try {
              const db=getProfileRuntime()?.service.store.database;
              if (db && (!db.open || db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(HANDOFF_PREFIX+path.resolve(filePath).toLowerCase()))) continue;
              await fsp.unlink(filePath);
              deletedCount++;
            } catch (err) {
              // 게임이 사용 중이거나 권한 문제 등으로 삭제 실패 시 로그만 남기고 패스
              log(`[CHAT_LOG] 파일 삭제 실패 (${file}): ${err}`);
            }
          }
        }
      }
      if (deletedCount > 0) {
        log(`[CHAT_LOG] 오래된 로그 파일 ${deletedCount}개 삭제 완료 (기준: ${days}일)`);
      }
    } catch (e) {
      log(`[CHAT_LOG] 오래된 로그 정리 실패: ${e}`);
    }
  }
}

export const chatLogManager = new ChatLogManager();
