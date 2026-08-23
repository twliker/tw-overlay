interface ChatChannelConstants {
  OVERLAY_CHANNELS: readonly string[];
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
  formatTimestamp(timestamp: string): string;
  stripShoutSuffix(message: string): string;
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

  const chatChannels: ChatChannelConstants = Object.freeze({
    OVERLAY_CHANNELS,
    COLOR_SWATCHES,
    COLORS,
    OVERLAY_COLORS,
    formatTimestamp,
    stripShoutSuffix,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = chatChannels;
  if (globalObject) globalObject.chatChannels = chatChannels;
})(typeof window !== 'undefined' ? window : null);
