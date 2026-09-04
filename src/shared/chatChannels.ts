interface ChatChannelConstants {
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
  isMessageBlacklisted(message: string, blacklistFilters?: string[]): boolean;
}

interface Window {
  chatChannels: ChatChannelConstants;
}

(function exposeChatChannels(globalObject: Window | null): void {
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

  const chatChannels: ChatChannelConstants = Object.freeze({
    OVERLAY_CHANNELS,
    OVERLAY_BUILT_IN_TABS,
    COLOR_SWATCHES,
    COLORS,
    OVERLAY_COLORS,
    SYSTEM_COLOR_CATEGORIES,
    getSystemColorGroup,
    formatTimestamp,
    stripShoutSuffix,
    isMessageBlacklisted,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = chatChannels;
  if (globalObject) globalObject.chatChannels = chatChannels;
})(typeof window !== 'undefined' ? window : null);
