interface ChatChannelConstants {
  CHAT_FONTS: Readonly<Record<string, { label: string; css: string }>>;
  resolveChatFont(config: import('./types').AppConfig, mode: 'main' | 'sub1' | 'sub2'): { size: number; family: string; key: string };
  OVERLAY_CHANNELS: readonly string[];
  OVERLAY_BUILT_IN_TABS: readonly import('./types').ChatOverlayBuiltInTab[];
  COLOR_SWATCHES: readonly string[];
  COLORS: Readonly<{
    general: string;
    selfGeneral: string;
    whisper: string;
    team: string;
    club: string;
    shout: string;
    system: string;
    nickname: string;
  }>;
  OVERLAY_COLORS: Readonly<Record<'general' | 'whisper' | 'team' | 'club' | 'shout', string>>;
  SYSTEM_COLOR_CATEGORIES: readonly { id: string; label: string; color: string; sampleText: string }[];
  getSystemColorGroup(colorHex: string): import('./types').SystemColorGroup;
  formatTimestamp(timestamp: string): string;
  stripShoutSuffix(message: string): string;
  parseShoutContent(message: string): { sender: string; message: string; shoutKind: import('./types').ShoutKind };
  isShoutVisible(item: { shoutKind?: string }, config: import('./types').AppConfig): boolean;
  getEtaColor(level: number, config: Partial<import('./types').AppConfig>): string | null;
  applyReadingDisplay(row: HTMLElement, config: Partial<import('./types').AppConfig>): void;
  isMessageBlacklisted(message: string, blacklistFilters?: string[]): boolean;
  isOverlayChatVisible(item: Pick<import('./types').ChatItem, 'type' | 'message' | 'color' | 'shoutKind'>,
    config: Partial<import('./types').AppConfig>, category: string, npcDialogue: boolean): boolean;
  resolveOverlayCustomTab(category: string, tabs?: readonly import('./types').CustomChatTab[]): import('./types').CustomChatTab | undefined;
}

interface Window {
  chatChannels: ChatChannelConstants;
}

(function exposeChatChannels(globalObject: Window | null): void {
  const CHAT_FONTS = Object.freeze({
    system: { label: '기본 글꼴', css: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
    malgun: { label: '맑은 고딕', css: '"Malgun Gothic", sans-serif' },
    gulim: { label: '굴림', css: 'Gulim, sans-serif' },
    dotum: { label: '돋움', css: 'Dotum, sans-serif' },
    batang: { label: '바탕', css: 'Batang, serif' },
  });
  /** 기능 계약: 보조 창의 0/빈 글꼴은 메인 설정을 상속한다. 기존 사용자의 표시를 보존한다. */
  function resolveChatFont(config: import('./types').AppConfig, mode: 'main' | 'sub1' | 'sub2') {
    const size = (mode === 'sub1' ? config.chatOverlaySubFontSize : mode === 'sub2' ? config.chatOverlaySub2FontSize : 0)
      || config.chatOverlayFontSize || 14;
    const key = (mode === 'sub1' ? config.chatOverlaySubFontFamily : mode === 'sub2' ? config.chatOverlaySub2FontFamily : '')
      || config.chatOverlayFontFamily || 'system';
    return { key, size: Math.min(72, Math.max(8, size)), family: /^custom:[a-f0-9]{64}$/.test(key) ? `"tw-${key.slice(7)}", ${CHAT_FONTS.system.css}` : (CHAT_FONTS[key as keyof typeof CHAT_FONTS] || CHAT_FONTS.system).css };
  }
  const COLORS = Object.freeze({
    general: '#ffffff',
    selfGeneral: '#c8ffc8',
    whisper: '#64ff64',
    team: '#f7b73c',
    club: '#94ddfa',
    shout: '#c896c8',
    system: '#a8a8a8',
    nickname: '#94a3b8',
  });
  const OVERLAY_CHANNELS = Object.freeze(['general', 'whisper', 'team', 'club', 'shout', 'system']);
  const OVERLAY_BUILT_IN_TABS = Object.freeze([
    'Basic', 'General', 'Whisper', 'Team', 'Club', 'Shout', 'System',
  ] as const);
  const OVERLAY_COLORS = Object.freeze({
    general: COLORS.general,
    whisper: COLORS.whisper,
    team: COLORS.team,
    club: COLORS.club,
    shout: COLORS.shout,
  });
  const COLOR_SWATCHES = Object.freeze([
    COLORS.general,
    COLORS.whisper,
    COLORS.team,
    COLORS.club,
    COLORS.shout,
    COLORS.system,
    '#f43f5e',
    '#3b82f6',
  ]);

  function formatTimestamp(timestamp: string): string {
    if (!timestamp) return '';
    const match = timestamp.match(/(오전|오후)?\s*(\d+)시\s*(\d+)분/);
    if (!match) return timestamp;
    let hour = Number(match[2]);
    if (match[1] === '오후' && hour < 12) hour += 12;
    // 오전/오후가 없는 게임 채팅 로그도 기존 오버레이 규칙에 따라 12시를 00시로 표시합니다.
    if (match[1] !== '오후' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${match[3].padStart(2, '0')}`;
  }

  function stripShoutSuffix(message: string): string {
    if (!message) return '';
    return message.replace(/(?:(?:\s+|^)(?:Click|From))+\s*$/i, '').trim();
  }

  /** 기능 계약: 줄 끝 From [이름]은 무료, Click [이름]은 유료, 그 외는 공지다.
   * 본문 속 From/Click은 보존한다. 실시간·재시작 복원·검색이 이 분류를 공유한다.
   * 이전 DB에서 종류를 알 수 없는 행은 세 필터와 무관하게 보존한다.
   */
  function parseShoutContent(message: string): { sender: string; message: string; shoutKind: import('./types').ShoutKind } {
    const suffix = message.match(/\s+(From|Click)\s*\[([^\]]+)\]\s*$/i);
    if (!suffix) return { sender: '시스템 공지', message: message.trim(), shoutKind: 'notice' };
    return { sender: suffix[2], message: stripShoutSuffix(message.slice(0, suffix.index).trim()), shoutKind: suffix[1].toLowerCase() === 'from' ? 'free' : 'paid' };
  }
  function isShoutVisible(item: { shoutKind?: string }, config: import('./types').AppConfig): boolean {
    return item.shoutKind === 'free' ? config.chatOverlayShowFreeShout !== false
      : item.shoutKind === 'paid' ? config.chatOverlayShowPaidShout !== false
      : item.shoutKind === 'notice' ? config.chatOverlayShowNoticeShout !== false : true;
  }

  function getEtaColor(level: number, config: Partial<import('./types').AppConfig>): string | null {
    if (!config.chatEtaColorsEnabled || !Number.isFinite(level) || level < 1) return null;
    const color = config.chatEtaColors?.[Math.min(4, Math.floor((level - 1) / 20))];
    return color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  }

  /** 간단 표시는 시간·에타만 접는다. 채널/주의/메모와 원문은 보존하며 모든 채팅 경로가 공유한다. */
  function applyReadingDisplay(row: HTMLElement, config: Partial<import('./types').AppConfig>): void {
    const details = row.querySelectorAll<HTMLElement>('.chat-timestamp, .time, .eta-badge');
    const compact = config.chatCompactDisplay === true;
    row.title = compact ? Array.from(details).map(node => node.textContent).filter(Boolean).join(' · ') : '';
    details.forEach(node => { node.style.display = compact ? 'none' : ''; });
  }

  const SYSTEM_COLOR_CATEGORIES = Object.freeze([
    { id: 'purple', label: '보라색 (경험치 획득/버프/소모품/코어)', color: '#c084fc', sampleText: '경험치 획득, 군고구마, 심장, 버프 만료, 코어 세트 발동 등' },
    { id: 'yellow', label: '노란색 (아이템 획득/서버 긴급 공지)', color: '#facc15', sampleText: '아이템 획득(득템), 전 서버 긴급 점검 공지, 핫타임 등' },
    { id: 'red', label: '붉은색 (시스템 공지/팁)', color: '#f87171', sampleText: '사기 주의 공지, 단축키 팁, 거래소 안내 등' },
    { id: 'green', label: '초록색 (던전 진행/상태이상/앰플)', color: '#4ade80', sampleText: '남은 공격 횟수, 자동 퇴장 카운트, 속성 앰플, 무력화 등' },
    { id: 'blue', label: '파란색 (인게임 알림)', color: '#60a5fa', sampleText: '채팅로그 동작 알림 등' },
    { id: 'gray', label: '흰색/회색 (보스 기믹 대사/NPC 대사)', color: '#94a3b8', sampleText: '보스/사제 패턴 대사, NPC 일반 대사, SEED 획득 등' },
  ]);

  function getSystemColorGroup(colorHex: string): import('./types').SystemColorGroup {
    if (!colorHex || typeof colorHex !== 'string') return 'gray';
    const clean = colorHex.replace('#', '').trim();
    if (clean.length !== 6) return 'gray';

    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return 'gray';

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;
    const s = max > 0 ? diff / max : 0;

    // 저채도 또는 어두운 색상은 회색/기본 시스템으로 분류
    if (s < 0.20 || max < 40 || diff < 30) {
      return 'gray';
    }

    let h = 0;
    if (max === r) {
      h = ((g - b) / diff) % 6;
    } else if (max === g) {
      h = (b - r) / diff + 2;
    } else {
      h = (r - g) / diff + 4;
    }
    h = Math.round(h * 60);
    if (h < 0) h += 360;

    if (h >= 45 && h <= 65) {
      return 'yellow';
    } else if (h > 65 && h <= 165) {
      return 'green';
    } else if (h > 165 && h <= 260) {
      return 'blue';
    } else if (h > 260 && h < 340) {
      return 'purple';
    } else {
      return 'red';
    }
  }

  function isMessageBlacklisted(message: string, blacklistFilters?: string[]): boolean {
    if (!message || !Array.isArray(blacklistFilters) || blacklistFilters.length === 0) return false;

    return blacklistFilters.some(rawFilter => {
      if (!rawFilter) return false;
      const filter = rawFilter.trim();
      if (!filter) return false;

      // 1. /pattern/flags 형태의 정규식 검사
      const slashRegexMatch = filter.match(/^\/(.+)\/([a-z]*)$/i);
      if (slashRegexMatch) {
        try {
          const normalizedPattern = slashRegexMatch[1].replace(/\\\\/g, '\\');
          const regex = new RegExp(normalizedPattern, slashRegexMatch[2] || 'i');
          return regex.test(message);
        } catch {
          return message.includes(filter);
        }
      }

      // 2. regex:pattern 형태의 정규식 검사
      if (filter.toLowerCase().startsWith('regex:')) {
        const pattern = filter.substring(6).trim();
        try {
          const normalizedPattern = pattern.replace(/\\\\/g, '\\');
          const regex = new RegExp(normalizedPattern, 'i');
          return regex.test(message);
        } catch {
          return message.includes(pattern);
        }
      }

      // 3. 일반 부분 문자열 일치
      return message.includes(filter);
    });
  }

  /** 탭 ID가 표시 이름보다 우선한다. 기본 ID는 동명의 사용자 탭이 있어도 기본 채널이다.
   * 사용자 탭은 고유 ID로 조회하고, 예전 이름 기반 요청만 마지막에 호환한다.
   * 초기 이력·검색·추가 페이지·화면 표시가 이 규칙을 공유한다.
   */
  function resolveOverlayCustomTab(category: string, tabs: readonly import('./types').CustomChatTab[] = []) {
    if ((OVERLAY_BUILT_IN_TABS as readonly string[]).includes(category)) return undefined;
    return tabs.find(tab => tab.id === category)
      || tabs.find(tab => tab.name.toLowerCase() === category.toLowerCase());
  }

  /** 화면과 검색의 표시 조건은 이 함수를 공유한다. 검색은 조건을 통과한 결과만 한도에 센다.
   * NPC 여부는 공통 chatConstants 판별 결과를 받으며 수집/원본 데이터는 변경하지 않는다.
   * 통합 채널 선택, 기본 탭, 사용자 탭 색상과 NPC/XP/ELSO/외치기/제외 문구 모두 같은 순서로 적용한다.
   * 회귀: check-chat-visibility의 실제 로그→검색 IPC→메인·보조 renderer.
   */
  function isOverlayChatVisible(
    item: Pick<import('./types').ChatItem, 'type' | 'message' | 'color' | 'shoutKind'>,
    config: Partial<import('./types').AppConfig>, category: string, npcDialogue: boolean,
  ): boolean {
    if (item.type === 'shout' && !isShoutVisible(item, config as import('./types').AppConfig)) return false;
    if (config.chatOverlayShowNpcChat === false && npcDialogue) return false;
    if (isMessageBlacklisted(item.message, config.chatOverlayBlacklistFilters)) return false;
    if (config.chatOverlayShowElsoGain === false && (/\[엘소\s*[\d,]+포인트\]/i.test(item.message)
      || /\[엘소\s*스크롤\s*\([\d,]+\s*포인트\)\]/i.test(item.message)
      || /루미나의\s*회랑\s*ELSO\s*획득량\s*증가\s*효과로/i.test(item.message)
      || /\[[\d,]+\]\s*ELSO를\s*습득했습니다/i.test(item.message)
      || /ELSO\s*포인트를\s*추가로\s*획득/i.test(item.message))) return false;
    if (config.chatOverlayShowXpGain === false && /경험치가\s+([\[\]\d,억만\s]+)\s*(올랐|상승)/.test(item.message)) return false;
    if (category === 'Basic') return (config.chatOverlaySelectedChannels || OVERLAY_CHANNELS).includes(item.type);
    if ((OVERLAY_BUILT_IN_TABS as readonly string[]).includes(category)) return item.type === category.toLowerCase();
    const custom = resolveOverlayCustomTab(category, config.chatOverlayCustomTabs);
    if (!custom) return true;
    if (!custom.channels.includes(item.type)) return false;
    return item.type !== 'system' || !custom.systemColorFilters?.length || custom.systemColorFilters.includes(getSystemColorGroup(item.color));
  }

  const chatChannels: ChatChannelConstants = Object.freeze({
    CHAT_FONTS,
    resolveChatFont,
    OVERLAY_CHANNELS,
    OVERLAY_BUILT_IN_TABS,
    COLOR_SWATCHES,
    COLORS,
    OVERLAY_COLORS,
    SYSTEM_COLOR_CATEGORIES,
    getSystemColorGroup,
    formatTimestamp,
    stripShoutSuffix,
    parseShoutContent,
    getEtaColor,
    applyReadingDisplay,
    isShoutVisible,
    isMessageBlacklisted,
    isOverlayChatVisible,
    resolveOverlayCustomTab,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = chatChannels;
  if (globalObject) globalObject.chatChannels = chatChannels;
})(typeof window !== 'undefined' ? window : null);
