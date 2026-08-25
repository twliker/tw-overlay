import { chatParser } from './chatParser';
import { createHash } from 'crypto';
import * as diaryDb from './diaryDb';
import * as config from './config';
import { log } from './logger';
import { getEssenceExchangeCount, xpTracker } from './xpTracker';
import { abandonedTracker } from './abandonedTracker';
import * as contentsChecker from './contentsChecker';
import { discordNotifier } from './discordNotifier';
import { etaCacheManager } from './etaCacheManager';
import { DEFAULT_CONFIG } from './constants';
import * as wm from './windowManager';
import {
  sendToAllWindowsByPage,
  sendToFirstWindowByPage,
} from './windowMessaging';
import type { ChatChannel, ChatItem, FocusedChatState, ChatParserEventMap } from '../shared/types';
import { showSupportedDesktopNotification } from './desktopNotification';
import { formatLootDiaryContent, parseElsoMessage } from './itemAcquisition';
import { normalizeNotificationKeyword, normalizeNotificationKeywords } from '../shared/keywordSanitizer';
export { parseElsoMessage };
const { COLORS: CHAT_COLORS, getSystemColorGroup, isMessageBlacklisted } = require('../shared/chatChannels') as ChatChannelConstants;

type HomeworkSourceEvent = { date: string; timestamp: string; message: string };

/** 동일한 채팅 줄을 재처리해도 같은 숙제 이벤트 ID가 생성되도록 한다. */
export function createHomeworkSourceEventId(
  eventName: string,
  homeworkId: string,
  data: HomeworkSourceEvent
): string {
  return createHash('sha256')
    .update(JSON.stringify([eventName, homeworkId, data.date, data.timestamp, data.message]))
    .digest('hex')
    .slice(0, 32);
}

/** 채팅 파일의 날짜/시각을 로컬 타임스탬프로 변환하고, 손상된 값만 현재 시각으로 대체한다. */
export function parseHomeworkSourceTimestamp(data: HomeworkSourceEvent): number {
  const dateMatch = data.date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const timeMatch = data.timestamp.match(/(\d{1,2})\s*시\s*(\d{1,2})\s*분\s*(\d{1,2})\s*초/);
  if (!dateMatch || !timeMatch) return Date.now();

  const parsed = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3]),
    0
  );
  const timestamp = parsed.getTime();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

/**
 * 파싱된 채팅 데이터를 실제 앱 기능(DB 저장, 알림 등)으로 연결하는 프로세서
 *
 * XP 추적은 xpTracker, 어벤던로드는 abandonedTracker에 위임합니다.
 * 이 클래스는 SEED/아이템/외치기 핸들러와 외부 API를 관리합니다.
 */
class ChatLogProcessor {
  private _started = false;
  private _chatContextCache: Array<{ timestamp: number; sender: string; message: string; color: string }> = [];
  private _activeTrackingAlarms: Array<{ alarmId: number; endTime: number }> = [];

  // 채팅 오버레이 탭별 히스토리 저장 버퍼스토어
  private _chatHistoryStore: Record<string, ChatItem[]> = {
    Basic: [],
    General: [],
    Team: [],
    Club: [],
    Shout: [],
    Whisper: [],
    System: []
  };
  private readonly _maxHistoryCount = 150;
  private readonly _maxKnownNicknameCount = 300;
  private _knownNicknames = new Map<string, string>();
  private _focusedChatTargets: string[] = [];
  private _isFocusedChatCollecting = false;

  private normalizeNickname(value: string): string {
    return value.normalize('NFC').trim().toLocaleLowerCase('ko-KR');
  }

  private rememberNickname(sender: string): void {
    if (!this._isFocusedChatCollecting) return;
    const nickname = sender.normalize('NFC').trim();
    const excluded = new Set(['나', '시스템', '시스템 공지', '시스템 알림', '귓속말', '팀 알림', '클럽 알림', '클럽 공지']);
    if (!nickname || nickname.length > 40 || excluded.has(nickname)) return;

    const known = this._knownNicknames;
    const normalized = this.normalizeNickname(nickname);
    if (known.has(normalized)) return;
    known.set(normalized, nickname);

    while (known.size > this._maxKnownNicknameCount) {
      const oldest = known.keys().next().value as string | undefined;
      if (!oldest) break;
      known.delete(oldest);
    }
  }

  public getKnownNicknames(): string[] {
    return [...this._knownNicknames.values()].sort((left, right) => left.localeCompare(right, 'ko'));
  }

  public getFocusedChatState(): FocusedChatState {
    return {
      selfNickname: config.load().focusedChatSelfNickname || '',
      targets: [...this._focusedChatTargets],
      knownNicknames: this.getKnownNicknames()
    };
  }

  public setFocusedChatSelfNickname(nickname: string): void {
    const normalized = typeof nickname === 'string' ? nickname.normalize('NFC').trim().slice(0, 40) : '';
    config.save({ focusedChatSelfNickname: normalized });
  }

  public setFocusedChatTargets(nicknames: string[]): void {
    const unique = new Map<string, string>();
    if (Array.isArray(nicknames)) {
      nicknames.forEach(value => {
        if (typeof value !== 'string') return;
        const nickname = value.normalize('NFC').trim().slice(0, 40);
        if (nickname) unique.set(this.normalizeNickname(nickname), nickname);
      });
    }
    this._focusedChatTargets = [...unique.values()];
  }

  public startFocusedChatSession(): void {
    this._isFocusedChatCollecting = true;
    this._knownNicknames.clear();
    const recentChats = this._chatHistoryStore.Basic || [];
    recentChats.forEach(item => {
      if (item.type !== 'system') this.rememberNickname(item.sender);
    });
  }

  public clearFocusedChatSession(): void {
    this._isFocusedChatCollecting = false;
    this._focusedChatTargets = [];
    this._knownNicknames.clear();
  }

  private addChatToHistory(tab: string, chat: ChatItem): void {
    const list = this._chatHistoryStore[tab];
    if (!list) return;
    list.push(chat);
    if (list.length > this._maxHistoryCount) {
      list.shift();
    }
  }

  private broadcastChatUpdate(chatItem: ChatItem): void {
    sendToAllWindowsByPage('chat-overlay.html', 'chat-updated', chatItem);
    sendToAllWindowsByPage('focused-chat.html', 'chat-updated', chatItem);
  }

  /** 게임 오버레이가 열려 있을 때만 렌더러 이벤트를 전달합니다. */
  private sendGameOverlayEvent(channel: string, data: unknown): void {
    const gameOverlay = wm.getGameOverlayWindow();
    if (gameOverlay && !gameOverlay.isDestroyed()) {
      gameOverlay.webContents.send(channel, data);
    }
  }

  /** 설정된 커스텀 사운드를 기존 핸들러와 동일한 기본 볼륨 규칙으로 재생합니다. */
  private playAlertSound(options: {
    label: string;
    soundFile?: string;
    volume?: number;
    defaultVolume: number;
    logMessage: string;
    allowNone?: boolean;
  }): void {
    if (!options.soundFile || (!options.allowNone && options.soundFile === 'none')) return;

    wm.sendPlaySound({
      label: options.label,
      soundFile: options.soundFile,
      volume: options.volume !== undefined ? options.volume : options.defaultVolume,
      isCustom: true,
      logMessage: options.logMessage
    });
  }

  /** 동일한 구조로 렌더링되는 채팅 항목을 생성합니다. */
  private createChatItem(options: {
    type: ChatChannel;
    timestamp: string;
    sender: string;
    message: string;
    color: string;
    level?: number | null;
    characterCode?: number | null;
  }): ChatItem {
    return {
      id: `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      ...options,
      level: options.level ?? null,
      characterCode: options.characterCode ?? null,
      isSelf: options.color === CHAT_COLORS.selfGeneral
    };
  }

  /** 지정 탭에 기록한 후 모든 채팅 오버레이에 한 번만 전파합니다. */
  private publishChatItem(chatItem: ChatItem, tabs: string[]): void {
    tabs.forEach(tab => this.addChatToHistory(tab, chatItem));
    this.broadcastChatUpdate(chatItem);
  }

  public getChatHistory(category: string): ChatItem[] {
    if (this._chatHistoryStore[category]) {
      return this._chatHistoryStore[category];
    }
    // 커스텀 탭 (ID: custom_xxx 또는 탭 이름) 조회 지원
    try {
      const cfg = config.load();
      const customTabs = cfg.chatOverlayCustomTabs || [];
      const customTab = customTabs.find((t: import('../shared/types').CustomChatTab) => t.id === category || t.name === category || (t.name && t.name.toLowerCase() === category.toLowerCase()));
      if (customTab && Array.isArray(customTab.channels) && customTab.channels.length > 0) {
        // 커스텀 탭에 지정된 채널들의 전용 히스토리 스토어 풀을 수집
        const channelToStoreKey: Record<string, string> = {
          system: 'System',
          general: 'General',
          team: 'Team',
          club: 'Club',
          shout: 'Shout',
          whisper: 'Whisper'
        };

        let candidateList: ChatItem[] = [];
        if (customTab.channels.length === 1 && channelToStoreKey[customTab.channels[0]]) {
          // 단일 채널 전용 탭인 경우 해당 채널 전용 스토어 사용 (예: System 전용 스토어)
          const storeKey = channelToStoreKey[customTab.channels[0]];
          candidateList = this._chatHistoryStore[storeKey] || [];
        } else {
          // 여러 채널이 혼합된 경우 Basic 스토어와 각 채널 스토어를 병합하고 시간순 정렬
          const itemsMap = new Map<string, ChatItem>();
          const basicList = this._chatHistoryStore['Basic'] || [];
          basicList.forEach(item => itemsMap.set(item.id, item));

          customTab.channels.forEach(ch => {
            const key = channelToStoreKey[ch];
            if (key && this._chatHistoryStore[key]) {
              this._chatHistoryStore[key].forEach(item => {
                if (!itemsMap.has(item.id)) {
                  itemsMap.set(item.id, item);
                }
              });
            }
          });

          candidateList = Array.from(itemsMap.values());

          // ID에서 생성 타임스탬프 밀리초 추출 (chat-1718000000000-xxx, more-1718000000000-xxx, replay-1718000000000-xxx)
          const extractTime = (item: ChatItem): number => {
            const match = item.id.match(/(?:chat|more|replay)-(\d+)/);
            if (match) return parseInt(match[1], 10);
            return 0;
          };

          candidateList.sort((a, b) => {
            const tA = extractTime(a);
            const tB = extractTime(b);
            if (tA && tB && tA !== tB) return tA - tB;
            return 0;
          });
        }

        const blacklist = cfg.chatOverlayBlacklistFilters;
        return candidateList.filter(item => {
          if (!customTab.channels.includes(item.type)) return false;
          if (blacklist && blacklist.length > 0 && item.message && isMessageBlacklisted(item.message, blacklist)) {
            return false;
          }
          // 시스템 메시지인 경우 해당 커스텀 탭의 색상 필터 적용
          if (item.type === 'system' && Array.isArray(customTab.systemColorFilters) && customTab.systemColorFilters.length > 0) {
            const group = getSystemColorGroup(item.color);
            return customTab.systemColorFilters.includes(group);
          }
          return true;
        });
      }
    } catch (e) {
      log(`[CHAT_PROCESSOR] 커스텀 탭 히스토리 조회 실패: ${e}`);
    }
    return [];
  }

  /**
   * 채팅 히스토리 저장 버퍼스토어 초기화
   */
  public clearHistoryStore(): void {
    this._chatHistoryStore = {
      Basic: [],
      General: [],
      Team: [],
      Club: [],
      Shout: [],
      Whisper: [],
      System: []
    };
    log('[CHAT_PROCESSOR] 채팅 히스토리 저장 버퍼스토어가 초기화되었습니다.');
  }

  /**
   * 모든 채팅 오버레이 창에 히스토리 청소/갱신 이벤트 브로드캐스트
   */
  public broadcastHistoryCleared(): void {
    sendToAllWindowsByPage('chat-overlay.html', 'chat-history-cleared');
    sendToAllWindowsByPage('focused-chat.html', 'chat-history-cleared');
    log('[CHAT_PROCESSOR] 모든 채팅 오버레이 창에 히스토리 갱신 이벤트를 전송했습니다.');
  }

  /**
   * 앱 시작 시 오늘 로그에서 읽어온 기존 채팅을 히스토리에만 추가 (알림/DB 저장 없이)
   */
  public replayChat(
    targetTab: string,
    data: {
      type: 'normal' | 'shout' | 'system';
      timestamp: string;
      sender: string;
      message: string;
      color: string;
      serverCode: number;
    }
  ): void {
    const rankInfo = etaCacheManager.getRankInfo(data.serverCode, data.sender);
    const level = rankInfo ? rankInfo.level : null;
    const characterCode = rankInfo ? rankInfo.characterCode : null;

    let type: ChatChannel = 'system';
    if (data.type === 'shout') {
      type = 'shout';
    } else if (data.type === 'normal') {
      type = data.color === CHAT_COLORS.team ? 'team' :
             (data.color === CHAT_COLORS.club ? 'club' :
             (data.color === CHAT_COLORS.whisper ? 'whisper' : 'general'));
    }

    const chatItem = {
      id: `replay-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type,
      timestamp: data.timestamp,
      sender: data.sender || (data.type === 'system' ? '시스템' : ''),
      message: data.message,
      color: data.color || CHAT_COLORS.system,
      level,
      characterCode,
      isSelf: data.color === CHAT_COLORS.selfGeneral
    };

    if (chatItem.type !== 'system') this.rememberNickname(chatItem.sender);

    this.addChatToHistory(targetTab, chatItem);
  }

  public start(): void {
    if (this._started) {
      log('[CHAT_PROCESSOR] 이미 시작되어 중복 이벤트 리스너 등록을 건너뜁니다.');
      return;
    }
    this._started = true;
    log('[CHAT_PROCESSOR] 시작됨 - 이벤트 리스너 등록');

    const queueFixedHomework = (event: keyof ChatParserEventMap, homeworkId: string): void => {
      chatParser.on(event, (data) => {
        contentsChecker.queuePendingHomework(
          homeworkId,
          1,
          true,
          createHomeworkSourceEventId(event, homeworkId, data),
          parseHomeworkSourceTimestamp(data)
        );
      });
    };
    const queueCountHomework = (event: keyof ChatParserEventMap, homeworkId: string): void => {
      chatParser.on(event, (data) => {
        const count = (data as { count?: number }).count;
        if (typeof count === 'number') {
          contentsChecker.queuePendingHomework(
            homeworkId,
            count,
            false,
            createHomeworkSourceEventId(event, homeworkId, data),
            parseHomeworkSourceTimestamp(data)
          );
        }
      });
    };

    // 0. 공허 특별 몬스터 출현 알림
    chatParser.on('SPECIAL_MONSTER_SPAWN', (data) => {
      const cfg = config.load();
      if (cfg.specialMonsterAlertEnabled === false) return;
      log(`[CHAT_PROCESSOR] 특별 몬스터 출현 감지: ${data.message}`);
      this.sendGameOverlayEvent('special-monster-alert', data);
    });

    // 0-1. 이터널 플로어 보상 상자 획득 처리
    queueFixedHomework('ETERNAL_FLOOR_CLEAR', 'weekly-eternal-floor');

    // 1. SEED 획득 처리
    chatParser.on('SEED_GAINED', (data) => {
      const timeOnly = data.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
      const content = `[자동] ${data.message} (${this.formatNumber(data.amount)})`;
      diaryDb.addActivityLog(data.date, timeOnly, 'calc', content, data.amount);

      const chatItem = this.createChatItem({
        type: 'system',
        timestamp: data.timestamp,
        sender: '시스템',
        message: data.message,
        color: CHAT_COLORS.system
      });
      this.publishChatItem(chatItem, ['Basic', 'System']);
    });

    // 2. 아이템 획득 처리
    chatParser.on('ITEM_LOOTED', (data) => {
      const cfg = config.load();

      // 엘소 포인트 누적 획득 체크 및 DB 반영
      let elsoPoints = 0;
      try {
        elsoPoints = parseElsoMessage(data.message);
        if (elsoPoints > 0) {
          const timeOnly = data.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
          diaryDb.addElsoPoints(data.date, timeOnly, elsoPoints);
        }
      } catch (err) {
        log(`[Processor] Elso parse/save error: ${err}`);
      }

      const keywords = normalizeNotificationKeywords(cfg.lootKeywords);
      // String.prototype.includes는 기본적으로 대소문자를 구분(Case-sensitive)합니다.
      const matchedKeyword = keywords.find(k => data.message.includes(k));
      // 경험의 정수는 기존 전용 기록 동작을 보존하되 공통 아이템 경로에서 한 번만 기록합니다.
      const isAlwaysTrackedItem = data.itemName === '경험의 정수';
      if (data.isOwn && (matchedKeyword || isAlwaysTrackedItem)) {
        if (!data.itemName.includes('마정석') && !data.message.includes('마정석')) {
          const timeOnly = data.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
          const diaryContent = isAlwaysTrackedItem
            ? formatLootDiaryContent(data.itemName)
            : `[득템] ${data.message}`;
          diaryDb.addActivityLog(
            data.date,
            timeOnly,
            'loot',
            diaryContent,
            data.count,
          );
          if (!isAlwaysTrackedItem) {
            showSupportedDesktopNotification('아이템 획득 알림', data.message);
          }
        }
      }

      const chatItem = this.createChatItem({
        type: 'system',
        timestamp: data.timestamp,
        sender: '시스템',
        message: data.message,
        color: '#ffd700'
      });
      this.publishChatItem(chatItem, ['Basic', 'System']);
    });

    // 2-1. 마정석 획득 처리 (모험일지 일일 누적 기록)
    chatParser.on('MAGIC_STONE_GAIN', (data) => {
      const timeOnly = data.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
      diaryDb.addMagicStoneDaily(data.date, timeOnly, data.grade, data.count);
    });

    // 2-2. 경험치 변동 처리
    chatParser.on('XP_CHANGED', (data) => {
      // 100억 단위 경험치 차감(경험의 정수 수동/자동 교환) 시 모험일지 및 요약에 기록합니다.
      const essenceCount = getEssenceExchangeCount(data.amount);
      if (essenceCount > 0) {
        const timeOnly = data.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
        diaryDb.addActivityLog(
          data.date,
          timeOnly,
          'loot',
          formatLootDiaryContent('경험의 정수'),
          essenceCount,
        );
      }

      const chatItem = this.createChatItem({
        type: 'system',
        timestamp: data.timestamp,
        sender: '시스템',
        message: data.message,
        color: '#ff64ff'
      });
      this.publishChatItem(chatItem, ['Basic', 'System']);
    });

    // 3. 외치기 처리
    chatParser.on('TRADE_SHOUT', (data) => {
      this.rememberNickname(data.sender);
      let fullTimestamp: number | undefined;
      if (data.date && data.timestamp) {
        const [y, m, d] = data.date.split('-').map(Number);
        const midnightSec = Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000);
        const timeMatch = data.timestamp.match(/(\d+)시\s*(\d+)분\s*(\d+)초/);
        if (timeMatch) {
          const sec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseInt(timeMatch[3], 10);
          fullTimestamp = midnightSec + sec;
        }
      }
      diaryDb.addShoutLog(data.sender, data.message, fullTimestamp);
      sendToFirstWindowByPage('shout-history.html', 'shout-history-updated');
      const cfg = config.load();
      const keywords = normalizeNotificationKeywords(cfg.shoutKeywords);
      // String.prototype.includes는 기본적으로 대소문자를 구분(Case-sensitive)합니다.
      const matchedKeyword = keywords.find(k => data.message.includes(k));
      if (keywords.length > 0 && matchedKeyword) {
        showSupportedDesktopNotification(`외치기 알림: [${data.sender}]`, data.message);
      }

      // 에타 랭킹 정보 조회 및 탭 히스토리 누적
      const serverCode = cfg.userServer || (DEFAULT_CONFIG.userServer as number);
      const rankInfo = etaCacheManager.getRankInfo(serverCode, data.sender);
      const level = rankInfo ? rankInfo.level : null;
      const characterCode = rankInfo ? rankInfo.characterCode : null;

      const chatItem = this.createChatItem({
        type: 'shout',
        timestamp: data.timestamp,
        sender: data.sender,
        message: data.message,
        color: CHAT_COLORS.shout,
        level,
        characterCode
      });
      this.publishChatItem(chatItem, ['Basic', 'Shout']);

      // 디스코드 전용 알림 처리 (외치기 전용)
      if (cfg.discordAlertEnabled && cfg.discordWebhookUrl) {
        const rules = cfg.discordRules || [];
        for (const rule of rules) {
          const keyword = normalizeNotificationKeyword(rule.keyword);
          if (!keyword || !data.message.includes(keyword)) continue;

          // 1. 발송 대상(외치기) 필터링
          if (!rule.targetShout) continue;

          // 2. 발신인(보낸 사람) 닉네임 필터링
          if (rule.targetSender && rule.targetSender.trim() !== '') {
            if (data.sender !== rule.targetSender.trim()) continue;
          }

          // 모든 필터를 통과하면 디스코드에 알림 발송
          void discordNotifier.sendWord(data.sender, data.message, keyword);
          break; // 단어 하나가 매칭되어 발송되었다면 한 메시지에 대해 중복 발송 차단
        }
      }
    });

    // 3-2. 일반 채팅 알림 처리
    chatParser.on('NORMAL_CHAT', (data) => {
      const now = Date.now();

      // 1. 만료된(5분이 경과한) 실시간 감지 추적 목록 필터링
      this._activeTrackingAlarms = this._activeTrackingAlarms.filter(a => now <= a.endTime);

      const cfg = config.load();

      // 에타 랭킹 정보 조회 및 탭 히스토리 누적
      const serverCode = cfg.userServer || (DEFAULT_CONFIG.userServer as number);
      const rankInfo = etaCacheManager.getRankInfo(serverCode, data.sender);
      const level = rankInfo ? rankInfo.level : null;
      const characterCode = rankInfo ? rankInfo.characterCode : null;

      // #ffffff = 타인 일반, #c8ffc8 = 본인 일반, #94ddfa = 클럽, #f7b73c = 팀, #64ff64 = 귓속말
      let type: ChatChannel = 'general';
      if (data.sender === '시스템' || data.color === CHAT_COLORS.system) {
        type = 'system';
      } else if (data.color === CHAT_COLORS.team) {
        type = 'team';
      } else if (data.color === CHAT_COLORS.club) {
        type = 'club';
      } else if (data.color === CHAT_COLORS.whisper) {
        type = 'whisper';
      }

      // 시스템 탭으로 분류되는 로그 또는 시스템 발신인의 메시지는 시스템 로그로 판단
      const isSystemLog = type === 'system' || data.sender === '시스템' || data.sender === '시스템 공지' || data.sender === '시스템 알림';

      if (!isSystemLog) this.rememberNickname(data.sender);

      // 2. 대화 캐시 적재 및 5분 만료 처리 (시스템 로그는 제외)
      if (!isSystemLog) {
        this._chatContextCache.push({
          timestamp: now,
          sender: data.sender,
          message: data.message,
          color: data.color
        });
        // 5분(300초) 이상 지난 데이터 삭제
        this._chatContextCache = this._chatContextCache.filter(c => now - c.timestamp <= 5 * 60 * 1000);
      }

      const chatItem = this.createChatItem({
        type,
        timestamp: data.timestamp,
        sender: data.sender,
        message: data.message,
        color: data.color,
        level,
        characterCode
      });
      const tabByType: Record<string, string> = {
        general: 'General',
        team: 'Team',
        club: 'Club',
        whisper: 'Whisper',
        system: 'System'
      };
      const typedTab = tabByType[type];
      this.publishChatItem(chatItem, typedTab ? ['Basic', typedTab] : ['Basic']);

      // 3. 현재 추적 활성 상태인 알림들에 대해 감지 이후의 후속 대화 기입 (시스템 로그는 제외)
      if (!isSystemLog) {
        for (const active of this._activeTrackingAlarms) {
          diaryDb.addWordAlarmContextLine(active.alarmId, now, data.sender, data.message, data.color);
        }
      }

      // 디스코드 전용 알림 처리 (독립 동작 - 클럽 공지 제외)
      if (cfg.discordAlertEnabled && cfg.discordWebhookUrl && !isSystemLog && data.sender !== '클럽 공지') {
        // 기존 discordKeywords 필드만 있고 discordRules가 없는 구버전 설정을 위한 마이그레이션
        let rules = cfg.discordRules || [];
        if (rules.length === 0 && cfg.discordKeywords && cfg.discordKeywords.length > 0) {
          rules = normalizeNotificationKeywords(cfg.discordKeywords).map(kw => ({
            keyword: kw,
            targetNormal: true,
            targetClub: true,
            targetShout: true
          }));
        }

        for (const rule of rules) {
          const keyword = normalizeNotificationKeyword(rule.keyword);
          if (!keyword) continue;
          // String.prototype.includes는 기본적으로 대소문자를 구분(Case-sensitive)합니다.
          if (!data.message.includes(keyword)) continue;

          // 1. 발송 대상(대화 유형별) 필터링
          let isTarget = false;
          if (type === 'general' && rule.targetNormal) isTarget = true;
          if (type === 'club' && rule.targetClub) isTarget = true;
          if (!isTarget) continue;

          // 2. 발신인(보낸 사람) 닉네임 필터링
          if (rule.targetSender && rule.targetSender.trim() !== '') {
            if (data.sender !== rule.targetSender.trim()) continue;
          }

          // 모든 필터를 통과하면 디스코드에 알림 발송
          void discordNotifier.sendWord(data.sender, data.message, keyword);
          break; // 단어 하나가 매칭되어 발송되었다면 한 메시지에 대해 중복 발송 차단
        }
      }

      // 4. 지정 단어 알림 처리
      if (!cfg.wordAlarmEnabled) return;
      if (isSystemLog) return;
      if (data.sender === '클럽 공지') return;

      const keywords = normalizeNotificationKeywords(cfg.wordAlarmKeywords);
      // String.prototype.includes는 기본적으로 대소문자를 구분(Case-sensitive)합니다.
      const matchedKeyword = keywords.find(k => data.message.includes(k));
      
      if (keywords.length > 0 && matchedKeyword) {
        // DB에 히스토리 및 현재 대화 캐시 큐 목록 저장 (대화 기록이 켜져있을 때만 캐시 제공)
        const historyContext = cfg.wordAlarmHistoryEnabled !== false ? [...this._chatContextCache] : [];
        const alarmId = diaryDb.addWordAlarmHistory(matchedKeyword, data.sender, data.message, historyContext);
        
        // 새로 생성된 알림에 대해 향후 5분 동안 발생하는 대화를 추적하도록 등록 (대화 기록이 켜져있을 때만)
        if (alarmId !== -1 && cfg.wordAlarmHistoryEnabled !== false) {
          this._activeTrackingAlarms.push({
            alarmId,
            endTime: now + 5 * 60 * 1000 // 5분 동안 후속 수집
          });
        }

        // OS 토스트 알림 발송
        showSupportedDesktopNotification(`일반 채팅 알림: [${data.sender}]`, data.message);

        // 지정 사운드 재생
        this.playAlertSound({
            label: '지정 단어 알림',
            soundFile: cfg.wordAlarmSound,
            volume: cfg.wordAlarmVolume,
            defaultVolume: 70,
            logMessage: `[지정 단어] [@${matchedKeyword}] ${data.sender}: ${data.message}`,
            allowNone: true
        });
      }
    });

    // 4. 에토스 기믹 알림 처리
    chatParser.on('ETHOS_PASSWORD', (data) => {
      const cfg = config.load();
      if (!cfg.ethosAlertEnabled) return;

      this.sendGameOverlayEvent('ethos-alert', data);
      this.playAlertSound({
          label: '이클립스 에토스 기믹 알림',
          soundFile: cfg.ethosAlertSound,
          volume: cfg.ethosAlertVolume,
          defaultVolume: 40,
          logMessage: `[에토스] 암호 감지: ${data.password}`
      });
    });

    // 4-2. 심연의 제2사도 기믹 알림 처리
    chatParser.on('ABYSS_APOSTLE_PATTERN', (data) => {
      const cfg = config.load();
      if (!cfg.abyssApostleAlertEnabled) return;

      this.sendGameOverlayEvent('abyss-apostle-alert', data);
      this.playAlertSound({
          label: '심연의 제2사도 반사 시작',
          soundFile: cfg.abyssApostleStartSound,
          volume: cfg.abyssApostleVolume,
          defaultVolume: 40,
          logMessage: `[제2사도] 반사 패턴 감지`
      });

      if (cfg.abyssApostleEndSound && cfg.abyssApostleEndSound !== 'none') {
        setTimeout(() => {
          const currentCfg = config.load();
          if (currentCfg.abyssApostleAlertEnabled) {
            this.playAlertSound({
              label: '심연의 제2사도 반사 종료',
              soundFile: currentCfg.abyssApostleEndSound,
              volume: currentCfg.abyssApostleVolume,
              defaultVolume: 40,
              logMessage: `[제2사도] 반사 패턴 종료`
            });
          }
        }, 6500);
      }
    });

    // 4-3. 몬스터 웨이브 종료 대기 알림 처리
    chatParser.on('WAVE_MONSTER_WARNING', (data) => {
      const cfg = config.load();
      if (!cfg.waveMonsterWarningEnabled) return;

      this.sendGameOverlayEvent('wave-warning-alert', data);
      this.playAlertSound({
          label: '몬스터 웨이브 종료 대기 알림',
          soundFile: cfg.waveMonsterWarningSound,
          volume: cfg.waveMonsterWarningVolume,
          defaultVolume: 70,
          logMessage: `[웨이브] ${data.message}`
      });
    });

    // 4-4. 로카고스 기믹 알림 처리
    chatParser.on('LOKAGOS_PATTERN', (data) => {
      const cfg = config.load();
      if (!cfg.lokagosAlertEnabled) return;

      this.sendGameOverlayEvent('lokagos-alert', data);
      this.playAlertSound({
          label: '이클립스 로카고스 기믹 알림',
          soundFile: cfg.lokagosAlertSound,
          volume: cfg.lokagosAlertVolume,
          defaultVolume: 40,
          logMessage: `[로카고스] 기믹 패턴 감지`
      });
    });

    // 5. 이클립스 보스 클리어 처리
    chatParser.on('ECLIPSE_BOSS_CLEAR', (data) => {
      const bossMapping: Record<string, string> = {
        '에토스': 'weekly-eclipse-boss-ethos',
        '마티아': 'weekly-eclipse-boss-matias',
        '티로로스': 'weekly-eclipse-boss-tyrorost',
        '라이코스': 'weekly-eclipse-boss-lycos',
        '체리아': 'weekly-eclipse-boss-cheria',
        '로카고스': 'weekly-eclipse-boss-lokagos'
      };
      const id = bossMapping[data.bossName];
      if (id) {
        contentsChecker.queuePendingHomework(id, data.count, false, createHomeworkSourceEventId('ECLIPSE_BOSS_CLEAR', id, data), parseHomeworkSourceTimestamp(data));
      }
    });
 
    // 6. 머큐리얼 보스 클리어 처리
    chatParser.on('MERCURIAL_BOSS_CLEAR', (data) => {
      const bossMapping: Record<string, string> = {
        '실반': 'weekly-mur-sylvan',
        '샐리온': 'weekly-mur-salion',
        '실라이론': 'weekly-mur-silyron',
        '샐레아나': 'weekly-mur-saleana',
        '루미너스': 'weekly-mur-luminous',
        '루미너스 (EX)': 'weekly-mur-luminous-ex',
        '루미너스(EX)': 'weekly-mur-luminous-ex'
      };
      const id = bossMapping[data.bossName];
      if (id) {
        contentsChecker.queuePendingHomework(id, data.count, false, createHomeworkSourceEventId('MERCURIAL_BOSS_CLEAR', id, data), parseHomeworkSourceTimestamp(data));
      }
    });
 
    // 7. 코어 마스터 클리어 처리
    chatParser.on('CORE_MASTER_CLEAR', (data) => {
      const coreMapping: Record<string, string> = {
        '심층Ⅰ': 'weekly-abyss-core-master-1',
        '심층Ⅱ': 'weekly-abyss-core-master-2',
        '심층ⅠⅠ': 'weekly-abyss-core-master-2', // 복수 표기 대응 가능성 등
        '심층Ⅲ': 'weekly-abyss-core-master-3',
        '실반': 'weekly-mur-core-master-sylvan',
        '샐리온': 'weekly-mur-core-master-salion',
        '실라이론': 'weekly-mur-core-master-silyron',
        '샐레아나': 'weekly-mur-core-master-saleana',
        '루미너스': 'weekly-mur-core-master-luminous'
      };
      const id = coreMapping[data.contentName];
      if (id) {
        contentsChecker.queuePendingHomework(
          id,
          data.count,
          data.isIncrement !== false,
          createHomeworkSourceEventId('CORE_MASTER_CLEAR', id, data),
          parseHomeworkSourceTimestamp(data)
        );
      }
    });
 
    // 절대 횟수가 로그에 포함되는 숙제
    [
      ['RELIC_SANCTUARY_CLEAR', 'weekly-ancient-relic'],
      ['POWER_ROOT_CLEAR', 'weekly-power-root'],
      ['ABYSS_TREASURE_ENTRY', 'weekly-abyss-treasure'],
      ['ECLIPSE_SUPPLIES_CLEAR', 'weekly-eclipse-recapture-supplies'],
      ['ECLIPSE_SPECIAL_FORCE_CLEAR', 'weekly-eclipse-special-force-suppression'],
      ['FORTRESS_GHOST_CLEAR', 'weekly-fortress-ghost']
    ].forEach(([event, homeworkId]) => queueCountHomework(event as keyof ChatParserEventMap, homeworkId));
    queueCountHomework('CONTENT_SHINJO_NEST_CLEAR', 'weekly-shinjo-nest');

    // 완료 로그만 제공되는 숙제
    [
      ['TESIS_CORE_CLEAR', 'weekly-tesis-core']
    ].forEach(([event, homeworkId]) => queueFixedHomework(event as keyof ChatParserEventMap, homeworkId));
 
    // 15. 발굴지 입장 처리
    chatParser.on('DIGSITE_ENTRY', (data) => {
      const sourceEventId = createHomeworkSourceEventId('DIGSITE_ENTRY', 'weekly-digsite', data);
      if (typeof data.count === 'number') {
        contentsChecker.queuePendingHomework('weekly-digsite', data.count, false, sourceEventId, parseHomeworkSourceTimestamp(data));
      } else {
        contentsChecker.queuePendingHomework('weekly-digsite', 1, true, sourceEventId, parseHomeworkSourceTimestamp(data));
      }
    });
 
    // 17. 어비스 보스 (심층 1~3) 클리어 처리
    chatParser.on('ABYSS_DUNGEON_CLEAR', (data) => {
      const depthMap: Record<string, string> = {
        '심층Ⅰ': 'weekly-abyss-dungeon-1',
        '심층Ⅱ': 'weekly-abyss-dungeon-2',
        '심층Ⅲ': 'weekly-abyss-dungeon-3'
      };
      const id = depthMap[data.depth];
      if (id) {
        contentsChecker.queuePendingHomework(id, data.count, false, createHomeworkSourceEventId('ABYSS_DUNGEON_CLEAR', id, data), parseHomeworkSourceTimestamp(data));
      }
    });
 
    [
      ['ABYSS_BOSS_EX_CLEAR', 'weekly-abyss-boss-ex'],
      ['SIOKAN_BOSS_CLEAR', 'weekly-siokan-boss'],
      ['SIOKAN_ODIN_CLEAR', 'weekly-siokan-odin'],
      ['ECLIPSE_BOSS_SUBJUGATION_CLEAR', 'weekly-eclipse-boss'],
      ['MOON_QUEEN_TRAINING_CLEAR', 'weekly-moon-queen'],
      ['APETHIRIA_RAID_CLEAR', 'weekly-apethiria-raid']
    ].forEach(([event, homeworkId]) => queueCountHomework(event as keyof ChatParserEventMap, homeworkId));

    [
      ['PRAVA_DEFENSE_CLEAR', 'weekly-prava-defense'],
      ['ORLY_DEFENSE_CLEAR', 'weekly-orly-defense'],
      ['CATACOMB_CLEAR', 'weekly-catacomb-hell'],
      ['VESTIGE_CLEAR', 'weekly-vestige'],
      ['THURSDAY_CLEAN_CLEAR', 'weekly-thursday-clean'],
      ['ETA_DAILY_BOX_GAIN', 'daily-eta-quest'],
      ['ETA_WILL_UPGRADE_GAIN', 'daily-eta-will-upgrade'],
      ['CLUB_POINT_500_GAIN', 'daily-club-boss'],
      ['CONFUSED_LAND_CLEAR', 'daily-confused-land'],
      ['COLORLESS_LAND_CLEAR', 'daily-colorless-land'],
      ['ARCHITECT_MINE_ENTRY', 'daily-architect-mine']
    ].forEach(([event, homeworkId]) => queueFixedHomework(event as keyof ChatParserEventMap, homeworkId));

    // 어벤던로드 지역별 도전 횟수 감지 및 숙제 리스트 연동
    chatParser.on('ABANDONED_ENTRY', (data) => {
      const regionMapping: Record<string, string> = {
        '필멸의 땅': 'weekly-abandon-road-mortal',
        '카디프': 'weekly-abandon-road-cardiff',
        '오를란느': 'weekly-abandon-road-orlanne'
      };
      const id = regionMapping[data.region];
      if (id) {
        contentsChecker.queuePendingHomework(id, data.count, false, createHomeworkSourceEventId('ABANDONED_ENTRY', id, data), parseHomeworkSourceTimestamp(data));
      }
    });

    // 팔색조 언덕 (갈망하는 즐거움) 진입 처리
    chatParser.on('PITTA_ENTRY', (data) => {
      const energy = typeof data.energy === 'number' && !isNaN(data.energy) ? data.energy : 0;
      const computedCount = (20 - energy) + 1;
      const grade = data.grade ? data.grade.trim().toUpperCase() : '';
      const cfg = config.load();

      log(`[CHAT_PROCESSOR] PITTA_ENTRY 수신: grade="${data.grade}" (정규화="${grade}"), energy=${energy}, computedCount=${computedCount}, pittaHillAlertEnabled=${cfg.pittaHillAlertEnabled}`);
      
      // 유효 범위(1~5회)인 경우에만 숙제 카운팅 동기화
      if (computedCount >= 1 && computedCount <= 5) {
        contentsChecker.queuePendingHomework(
          'daily-pitta',
          computedCount,
          false,
          createHomeworkSourceEventId('PITTA_ENTRY', 'daily-pitta', data),
          parseHomeworkSourceTimestamp(data)
        );
      } else {
        log(`[CHAT_PROCESSOR] 팔색조 언덕 카운트 범위 초과 혹은 예외로 무시됨: computedCount=${computedCount} (energy=${energy})`);
      }

      // SS 등급 5회차(남은 에너지 16) 진입 시 게임 오버레이 알림 전송
      if ((grade === 'SS' || grade === 'SSS') && energy === 16) {
        if (cfg.pittaHillAlertEnabled !== false) {
          const gameOverlay = wm.getGameOverlayWindow();
          const overlayExists = !!gameOverlay && !gameOverlay.isDestroyed();
          const overlayVisible = overlayExists ? gameOverlay.isVisible() : false;
          log(`[CHAT_PROCESSOR] 팔색조 언덕 SS 5회차 진입 감지 -> 오버레이 이벤트 전송 시도 (오버레이창 존재: ${overlayExists}, 표시여부: ${overlayVisible})`);
          this.sendGameOverlayEvent('pitta-alert', null);
        } else {
          log('[CHAT_PROCESSOR] 팔색조 언덕 알림이 설정에서 비활성화(OFF)되어 있어 전송하지 않음');
        }
      } else {
        log(`[CHAT_PROCESSOR] 팔색조 언덕 알림 조건 미충족: grade="${grade}" (SS 필요), energy=${energy} (16 필요)`);
      }
    });

    // XP 추적 (xpTracker에 위임)
    xpTracker.start();

    // 어벤던로드 추적 (abandonedTracker에 위임)
    abandonedTracker.start();
  }

  // ── 외부 API (기존 호출자 호환성 유지) ──

  public resetXp(): void {
    xpTracker.resetXp();
    log('[CHAT_PROCESSOR] XP 세션 초기화됨');
  }

  public resetAbandoned(): void {
    abandonedTracker.reset();
    log('[CHAT_PROCESSOR] 어벤던로드 세션 초기화됨');

    this.sendGameOverlayEvent('abandoned-update', abandonedTracker.getState());
  }

  public getStats() {
    return xpTracker.getStats();
  }

  public getAbandonedState() {
    return abandonedTracker.getState();
  }

  public forceAbandonedVisible(visible: boolean): void {
    abandonedTracker.forceVisible(visible);
  }

  private formatNumber(num: number): string {
    if (num === 0) return '0';
    const units = [
      { label: '조', value: 1000000000000 },
      { label: '억', value: 100000000 },
      { label: '만', value: 10000 },
    ];
    let result = '';
    let remainder = num;
    for (const unit of units) {
      if (remainder >= unit.value) {
        const value = Math.floor(remainder / unit.value);
        result += `${value}${unit.label} `;
        remainder %= unit.value;
      }
    }
    if (result === '') result = remainder.toLocaleString();
    return result.trim();
  }

}

export const chatLogProcessor = new ChatLogProcessor();
