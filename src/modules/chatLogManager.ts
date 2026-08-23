import { Tail } from 'tail';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { log } from './logger';
import { chatParser } from './chatParser';
import * as config from './config';
import { chatLogProcessor } from './chatLogProcessor';
import { findChatLogPath } from './chatLogPathFinder';
import { DEFAULT_CONFIG } from './constants';
import { etaCacheManager } from './etaCacheManager';
import {
  ChatLogLineNormalizer,
  decodeChatLogBuffer,
  normalizeChatLogLines,
} from './chatLogNormalizer';
import type { ChatLogEncoding } from './chatLogNormalizer';
import { parseItemAcquisition } from './itemAcquisition';

const { isLegacyNpcSender } = require('../shared/chatConstants') as ChatConstants;
const { COLORS: CHAT_COLORS } = require('../shared/chatChannels') as ChatChannelConstants;

type HistoryCategory = 'General' | 'Team' | 'Club' | 'Whisper' | 'System';
type HistoryMessageType = 'general' | 'team' | 'club' | 'whisper' | 'system';

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

class ChatLogManager {
  private _tail: Tail | null = null;
  private _currentFilePath: string | null = null;
  private _watchTimer: NodeJS.Timeout | null = null;
  private _todayLines: string[] = [];
  private _lastReadIndex: Record<string, number> = {};
  private _initialReadIndex: Record<string, number> = {};
  private readonly _lineNormalizer = new ChatLogLineNormalizer();
  private _normalizerFlushTimer: NodeJS.Timeout | null = null;
  private _chatLogEncoding: ChatLogEncoding = 'euc-kr';

  /**
   * 스트리밍 시작
   */
  public start(): void {
    this.stop();
    this.initWatch();
    this.cleanupOldLogs().catch(e => log(`[CHAT_LOG] Cleanup error: ${e}`));
    
    // 1분마다 날짜 변경(자정) 및 파일 존재 여부 체크
    this._watchTimer = setInterval(() => this.checkFileChange(), 60000);
    log('[CHAT_LOG] 매니저 시작됨');
  }

  /**
   * 스트리밍 중지
   */
  public stop(): void {
    this.flushPendingNormalizedLine();
    if (this._tail) {
      this._tail.unwatch();
      this._tail = null;
    }
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    if (this._normalizerFlushTimer) {
      clearTimeout(this._normalizerFlushTimer);
      this._normalizerFlushTimer = null;
    }
    this._lineNormalizer.reset();
    this._currentFilePath = null;
    this._todayLines = [];
    this._lastReadIndex = {};
    log('[CHAT_LOG] 매니저 중지됨');
  }

  /**
   * 오늘 날짜에 해당하는 로그 파일 경로 생성
   */
  public getTodayFilePath(): string | null {
    const cfg = config.load();
    if (!cfg.chatLogPath || !fs.existsSync(cfg.chatLogPath)) return null;

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    
    const fileName = `TWChatLog_${yyyy}_${mm}_${dd}.html`;
    return path.join(cfg.chatLogPath, fileName);
  }

  /**
   * 파일 감시 초기화
   */
  private initWatch(): void {
    const filePath = this.getTodayFilePath();
    if (!filePath) {
      log('[CHAT_LOG] 로그 폴더가 설정되지 않았거나 유효하지 않습니다.');
      return;
    }

    if (!fs.existsSync(filePath)) {
      log(`[CHAT_LOG] 오늘의 로그 파일이 아직 생성되지 않음: ${filePath}`);
      this._currentFilePath = filePath; // 경로는 저장해둠
      return;
    }

    // [추가] 새 파일을 읽기 시작할 때, 상단 헤더를 읽어 날짜 정보를 파서에 전달
    try {
      const buffer = fs.readFileSync(filePath);
      const decoded = decodeChatLogBuffer(buffer);
      this._chatLogEncoding = decoded.encoding;
      if (decoded.damaged) {
        log(`[CHAT_LOG] 문자 손상이 감지되었습니다. 일부 로그를 해석하지 못할 수 있습니다: ${filePath}`);
      }
      const lines = normalizeChatLogLines(decoded.content.split('\n'));
      this._todayLines = lines; // 로그 전체 라인 캐시 보관
      
      for (let i = 0; i < Math.min(lines.length, 20); i++) {
        if (lines[i].includes('Date :')) {
          chatParser.parseLine(lines[i]);
          break;
        }
      }
      // 앱 시작 시 오늘 로그 전체를 히스토리에 채우기 (알림/DB 저장 없이)
      this.replayTodayLog(lines);
    } catch (e) {
      log(`[CHAT_LOG] 초기 날짜 읽기 실패: ${e}`);
    }

    try {
      this._tail = new Tail(filePath, {
        fromBeginning: false,
        follow: true,
        useWatchFile: true, // 네트워크 드라이브나 특정 윈도우 환경 대응
        fsWatchOptions: { interval: 1000 },
        encoding: 'binary' // 원본 바이너리 보존을 위해 binary로 읽음
      });

      this._tail.on('line', (data: string) => {
        // 바이너리 문자열을 Buffer로 변환 후 초기 파일에서 판별한 문자셋으로 디코딩
        const buffer = Buffer.from(data, 'binary');
        const decodedLine = iconv.decode(buffer, this._chatLogEncoding);
        this.consumeDecodedLine(decodedLine);
      });

      this._tail.on('error', (error) => {
        log(`[CHAT_LOG] Tail 오류: ${error}`);
      });

      this._currentFilePath = filePath;
      log(`[CHAT_LOG] 파일 감시 시작: ${filePath}`);

    } catch (err) {
      log(`[CHAT_LOG] 감시 시작 실패: ${err}`);
    }
  }

  private consumeDecodedLine(decodedLine: string): void {
    if (this._normalizerFlushTimer) {
      clearTimeout(this._normalizerFlushTimer);
      this._normalizerFlushTimer = null;
    }
    this._lineNormalizer.push(decodedLine).forEach(line => this.processNormalizedLine(line));
    if (this._lineNormalizer.hasPending()) {
      this._normalizerFlushTimer = setTimeout(() => {
        this._normalizerFlushTimer = null;
        this.flushPendingNormalizedLine();
      }, 100);
    }
  }

  private flushPendingNormalizedLine(): void {
    this._lineNormalizer.flush().forEach(line => this.processNormalizedLine(line));
  }

  private processNormalizedLine(line: string): void {
    // 회복 로그 등 너무 빈번한 로그는 결합이 끝난 뒤 1차로 제외합니다.
    if (line.includes('회복되었습니다')) return;
    this._todayLines.push(line);
    chatParser.parseLine(line);
  }

  /**
   * 오늘 로그 파일의 기존 내용을 파싱해 히스토리에 채움 (알림/DB저장 없이 replay만)
   */
  private replayTodayLog(lines: string[]): void {
    const cfg = config.load();
    const serverCode = cfg.userServer || (DEFAULT_CONFIG.userServer as number);

    // 리플레이 시작 전 기존 버퍼스토어 초기화
    chatLogProcessor.clearHistoryStore();

    // 날짜 헤더 감지 (파서와 동일한 방식)
    let currentDate = new Date().toISOString().split('T')[0];
    const dateHeaderMatch = lines.slice(0, 20).find(l => l.includes('Date :'));
    if (dateHeaderMatch) {
      const m1 = dateHeaderMatch.match(/Date\s*:\s*(\d{4}-\d{2}-\d{2})/);
      const m2 = dateHeaderMatch.match(/Date\s*:\s*(\d+)년\s*(\d+)월\s*(\d+)일/);
      if (m1) currentDate = m1[1];
      else if (m2) currentDate = `${m2[1]}-${m2[2].padStart(2,'0')}-${m2[3].padStart(2,'0')}`;
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
        const userMatch = shoutContent.match(/\[([^\]]+)\]$/);
        if (userMatch) {
          const sender = userMatch[1];
          const message = shoutContent.replace(/\[([^\]]+)\]$/, '').trim();

          const needForShout = categoryCounts.Shout < limit;
          const needForBasic = categoryCounts.Basic < limit;

          const shoutItem: ChatItemData = {
            type: 'shout', timestamp, sender, message,
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

    this._initialReadIndex = { ...categoryFinalIndexes };
    this._lastReadIndex = { ...categoryFinalIndexes };
    this._lastReadIndex['initial'] = categoryFinalIndexes.Basic;

    log(`[CHAT_LOG] 오늘 로그 replay 완료: 각 탭별로 최대 150개씩 수집 및 적재 완료.`);

    // 리플레이 완료 후 렌더러에 갱신 알림 브로드캐스트
    chatLogProcessor.broadcastHistoryCleared();
  }

  public resetLastReadIndex(category: string): void {
    this._lastReadIndex[category] = this._initialReadIndex[category] ?? this._lastReadIndex['initial'] ?? 0;
  }

  public async getMoreHistory(category: string): Promise<any[]> {
    const cfg = config.load();
    const serverCode = cfg.userServer || (DEFAULT_CONFIG.userServer as number);
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').trim();

    let startIndex = this._lastReadIndex[category];
    if (typeof startIndex !== 'number') {
      startIndex = this._lastReadIndex['initial'] ?? 0;
    }

    const collected: any[] = [];
    let finalIndex = 0;
    const targetType = category === 'Basic' ? null : category.toLowerCase();

    for (let i = startIndex - 1; i >= 0; i--) {
      if (collected.length >= 150) {
        finalIndex = i;
        break;
      }

      const rawLine = this._todayLines[i];
      if (!rawLine) continue;

      const timeMatch = rawLine.match(/\[\s*(\d+시\s*\d+분\s*\d+초)\s*\]/);
      if (!timeMatch) continue;

      const timestamp = timeMatch[1];
      const cleanMsg = stripHtml(rawLine.replace(/\[.*?\]/, ''));
      if (cleanMsg.length === 0) continue;
      if (cleanMsg.includes('회복되었습니다')) continue;

      // 외치기
      if (rawLine.includes(`color="${CHAT_COLORS.shout}"`) && cleanMsg.includes('외치기 :')) {
        if (targetType && targetType !== 'shout') continue;

        const shoutContent = cleanMsg.replace('외치기 :', '').trim();
        const userMatch = shoutContent.match(/\[([^\]]+)\]$/);
        if (userMatch) {
          const sender = userMatch[1];
          const message = shoutContent.replace(/\[([^\]]+)\]$/, '').trim();
          const rankInfo = etaCacheManager.getRankInfo(serverCode, sender);
          const level = rankInfo ? rankInfo.level : null;
          const characterCode = rankInfo ? rankInfo.characterCode : null;
          collected.push({
            id: `more-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            type: 'shout', timestamp, sender, message,
            color: CHAT_COLORS.shout,
            level,
            characterCode
          });
        }
        continue;
      }

      // 2. 색상 최우선 기반 카테고리 분류 적용
      let color = CHAT_COLORS.system;
      const colorMatch = rawLine.match(/color=["']?(#[0-9a-fA-F]{6})["']?/);
      if (colorMatch) {
        color = colorMatch[1].toLowerCase();
      }

      const { type, sender, message, color: finalColor } = classifyHistoryMessage(color, cleanMsg);

      // 타겟 카테고리 필터 매칭 여부 판정
      if (targetType && targetType !== type) {
        continue;
      }

      const rankInfo = etaCacheManager.getRankInfo(serverCode, sender);
      const level = rankInfo ? rankInfo.level : null;
      const characterCode = rankInfo ? rankInfo.characterCode : null;

      collected.push({
        id: `more-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        type, timestamp, sender, message, color: finalColor,
        level,
        characterCode
      });
    }

    this._lastReadIndex[category] = finalIndex;
    return collected.reverse();
  }

  /**
   * 오늘 하루 전체 로그 중 검색어가 포함된 채팅 검색
   */
  public async searchChatLogs(
    query: string,
    options?: { category?: string; limit?: number }
  ): Promise<any[]> {
    if (!query || !query.trim()) return [];

    const queryClean = query.trim().toLowerCase();
    const limit = Math.max(1, Math.min(options?.limit || 300, 1000));
    const category = options?.category || 'Basic';
    const targetType = category === 'Basic' ? null : category.toLowerCase();

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
        if (targetType && targetType !== 'shout') continue;

        const shoutContent = cleanMsg.replace('외치기 :', '').trim();
        const userMatch = shoutContent.match(/\[([^\]]+)\]$/);
        if (userMatch) {
          const sender = userMatch[1];
          const message = shoutContent.replace(/\[([^\]]+)\]$/, '').trim();

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

      if (targetType && targetType !== type) {
        continue;
      }

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

  /**
   * 날짜 변경 또는 파일 생성 감지
   */
  private checkFileChange(): void {
    let cfg = config.load();

    // 1. 만약 config에 chatLogPath가 없거나, 설정된 경로가 실제로 존재하지 않는 경우 자동 탐색을 재시도
    if (!cfg.chatLogPath || !fs.existsSync(cfg.chatLogPath)) {
      const foundPath = findChatLogPath();
      if (foundPath) {
        config.save({ chatLogPath: foundPath });
        cfg = config.load(); // 최신 config 반영
        log(`[CHAT_LOG] 주기적 탐색을 통해 로그 경로 설정 완료: ${foundPath}`);
      }
    }

    const todayPath = this.getTodayFilePath();

    // 2. 파일 경로가 바뀌었거나(자정), 이전에 파일이 없었는데 새로 생겼을 경우
    if (todayPath !== this._currentFilePath || (todayPath && !this._tail && fs.existsSync(todayPath))) {
      log('[CHAT_LOG] 로그 파일 변경 감지, 재연결 시도');
      // 날짜가 바뀐 시점(자정)에 오래된 로그 정리도 함께 실행
      if (todayPath !== this._currentFilePath) {
        this.cleanupOldLogs().catch(e => log(`[CHAT_LOG] Cleanup error: ${e}`));
      }
      this.start();
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
