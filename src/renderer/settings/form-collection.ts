/** 설정 화면의 채팅 오버레이·기믹 알림 입력값을 수집합니다. */
(() => {
  interface RendererDefaults {
    userServer: number;
    chatOverlayFontSize: number;
    chatOverlayOpacity: number;
    chatOverlaySubOpacity: number;
    chatOverlaySub2Opacity: number;
    chatOverlayWidth: number;
    chatOverlayHeight: number;
    chatOverlaySubWidth: number;
    chatOverlaySubHeight: number;
    chatOverlaySub2Width: number;
    chatOverlaySub2Height: number;
    chatOverlayNicknameColorMode: string;
    chatOverlayShowNpcChat: boolean;
    chatOverlayBlacklistFilters?: string[];
    chatOverlayShowXpGain: boolean;
    chatOverlayShowElsoGain: boolean;
    chatOverlayHighlightScamNicknames: boolean;
    ethosAlertEnabled: boolean;
    ethosAlertSound: string;
    ethosAlertVolume: number;
    abyssApostleAlertEnabled: boolean;
    abyssApostleStartSound: string;
    abyssApostleEndSound: string;
    abyssApostleVolume: number;
    lokagosAlertEnabled: boolean;
    lokagosAlertSound: string;
    lokagosAlertVolume: number;
    waveMonsterWarningEnabled: boolean;
    waveMonsterWarningSound: string;
    waveMonsterWarningVolume: number;
    essenceAlertEnabled: boolean;
    specialMonsterAlertEnabled: boolean;
    abandonedAlertEnabled: boolean;
    pittaHillAlertEnabled: boolean;
    questCompleteAlertEnabled: boolean;
    showTodaySummaryHud: boolean;
    todaySummaryCollapsed: boolean;
    todaySummaryHudPos: { left: number; top?: number; bottom?: number };
  }

  const defaultConfig = (window.electronAPI as typeof window.electronAPI & {
    DEFAULT_CONFIG: RendererDefaults;
  }).DEFAULT_CONFIG;
  const input = (id: string): HTMLInputElement | HTMLSelectElement | null =>
    document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;

  const integerValue = (id: string, fallback: number): number => {
    const element = input(id);
    return element ? parseInt(element.value) : fallback;
  };

  const floatValue = (id: string, fallback: number): number => {
    const element = input(id);
    return element ? parseFloat(element.value) : fallback;
  };

  const stringValue = (id: string, fallback: string): string => input(id)?.value ?? fallback;

  const checkedValue = (id: string, fallback: boolean): boolean => {
    const element = input(id) as HTMLInputElement | null;
    return element ? element.checked : fallback;
  };

  const pickerColor = (
    pickers: Record<string, SettingsColorPicker> | undefined,
    channel: string,
    configKey: keyof BrowserAppConfig,
    fallback: string,
  ): string => {
    if (pickers?.[channel]) {
      return pickers[channel].getColor().toHEXA().toString(0);
    }
    const lastConfig = (window as unknown as { lastConfig?: BrowserAppConfig | null }).lastConfig;
    if (lastConfig && typeof lastConfig[configKey] === 'string' && lastConfig[configKey]) {
      return lastConfig[configKey] as string;
    }
    return fallback;
  };

  function collectChatOverlayDisplaySettings(blacklistFilters?: string[]): Record<string, unknown> {
    return {
      chatOverlayFontSize: integerValue('chat-overlay-fontsize-input', defaultConfig.chatOverlayFontSize),
      chatOverlayOpacity: floatValue('chat-overlay-opacity-input', defaultConfig.chatOverlayOpacity),
      chatOverlaySubOpacity: floatValue('chat-overlay-sub-opacity-input', defaultConfig.chatOverlaySubOpacity),
      chatOverlaySub2Opacity: floatValue('chat-overlay-sub2-opacity-input', defaultConfig.chatOverlaySub2Opacity),
      chatOverlayWidth: integerValue('chat-overlay-width-input', defaultConfig.chatOverlayWidth),
      chatOverlayHeight: integerValue('chat-overlay-height-input', defaultConfig.chatOverlayHeight),
      chatOverlaySubWidth: integerValue('chat-overlay-sub-width-input', defaultConfig.chatOverlaySubWidth),
      chatOverlaySubHeight: integerValue('chat-overlay-sub-height-input', defaultConfig.chatOverlaySubHeight),
      chatOverlaySub2Width: integerValue('chat-overlay-sub2-width-input', defaultConfig.chatOverlaySub2Width),
      chatOverlaySub2Height: integerValue('chat-overlay-sub2-height-input', defaultConfig.chatOverlaySub2Height),
      chatOverlayColorGeneral: pickerColor(window.chatPickers, 'general', 'chatOverlayColorGeneral', window.chatChannels.OVERLAY_COLORS.general),
      chatOverlayColorWhisper: pickerColor(window.chatPickers, 'whisper', 'chatOverlayColorWhisper', window.chatChannels.OVERLAY_COLORS.whisper),
      chatOverlayColorTeam: pickerColor(window.chatPickers, 'team', 'chatOverlayColorTeam', window.chatChannels.OVERLAY_COLORS.team),
      chatOverlayColorClub: pickerColor(window.chatPickers, 'club', 'chatOverlayColorClub', window.chatChannels.OVERLAY_COLORS.club),
      chatOverlayColorShout: pickerColor(window.chatPickers, 'shout', 'chatOverlayColorShout', window.chatChannels.OVERLAY_COLORS.shout),
      chatOverlayNicknameColorMode: stringValue('chat-overlay-nickname-color-mode-input', defaultConfig.chatOverlayNicknameColorMode),
      chatOverlayNicknameColorGeneral: pickerColor(window.nicknamePickers, 'general', 'chatOverlayNicknameColorGeneral', window.chatChannels.COLORS.nickname),
      chatOverlayNicknameColorWhisper: pickerColor(window.nicknamePickers, 'whisper', 'chatOverlayNicknameColorWhisper', window.chatChannels.COLORS.nickname),
      chatOverlayNicknameColorTeam: pickerColor(window.nicknamePickers, 'team', 'chatOverlayNicknameColorTeam', window.chatChannels.COLORS.nickname),
      chatOverlayNicknameColorClub: pickerColor(window.nicknamePickers, 'club', 'chatOverlayNicknameColorClub', window.chatChannels.COLORS.nickname),
      chatOverlayNicknameColorShout: pickerColor(window.nicknamePickers, 'shout', 'chatOverlayNicknameColorShout', window.chatChannels.COLORS.nickname),
      chatOverlaySelectedChannels: window.chatChannels.OVERLAY_CHANNELS
        .filter(channel => checkedValue(`chat-overlay-channel-${channel}`, false)),
      chatOverlayShowNpcChat: checkedValue('chat-overlay-show-npc-chat', defaultConfig.chatOverlayShowNpcChat),
      chatOverlayBlacklistFilters: Array.isArray(blacklistFilters) ? blacklistFilters : (defaultConfig.chatOverlayBlacklistFilters || []),
      chatOverlayShowXpGain: checkedValue('chat-overlay-show-xp-gain', defaultConfig.chatOverlayShowXpGain),
      chatOverlayShowElsoGain: checkedValue('chat-overlay-show-elso-gain', defaultConfig.chatOverlayShowElsoGain),
      chatOverlayHighlightScamNicknames: checkedValue('chat-overlay-highlight-scam-nicknames', defaultConfig.chatOverlayHighlightScamNicknames),
      userServer: integerValue('chat-overlay-user-server-input', defaultConfig.userServer),
    };
  }

  function collectChatAlertSettings(lootKeywords: string[], shoutKeywords: string[]): Record<string, unknown> {
    return {
      lootKeywords,
      shoutKeywords,
      ethosAlertEnabled: checkedValue('ethos-alert-enabled', defaultConfig.ethosAlertEnabled),
      ethosAlertSound: stringValue('ethos-alert-sound', defaultConfig.ethosAlertSound),
      ethosAlertVolume: integerValue('ethos-alert-volume', defaultConfig.ethosAlertVolume),
      abyssApostleAlertEnabled: checkedValue('abyss-apostle-alert-enabled', defaultConfig.abyssApostleAlertEnabled),
      abyssApostleStartSound: stringValue('abyss-apostle-start-sound', defaultConfig.abyssApostleStartSound),
      abyssApostleEndSound: stringValue('abyss-apostle-end-sound', defaultConfig.abyssApostleEndSound),
      abyssApostleVolume: integerValue('abyss-apostle-volume', defaultConfig.abyssApostleVolume),
      lokagosAlertEnabled: checkedValue('lokagos-alert-enabled', defaultConfig.lokagosAlertEnabled),
      lokagosAlertSound: stringValue('lokagos-alert-sound', defaultConfig.lokagosAlertSound),
      lokagosAlertVolume: integerValue('lokagos-alert-volume', defaultConfig.lokagosAlertVolume),
      waveMonsterWarningEnabled: checkedValue('wave-warning-enabled', defaultConfig.waveMonsterWarningEnabled),
      waveMonsterWarningSound: stringValue('wave-warning-sound', defaultConfig.waveMonsterWarningSound),
      waveMonsterWarningVolume: integerValue('wave-warning-volume', defaultConfig.waveMonsterWarningVolume),
      essenceAlertEnabled: checkedValue('essence-alert-enabled', defaultConfig.essenceAlertEnabled),
      specialMonsterAlertEnabled: checkedValue('special-monster-alert-enabled', defaultConfig.specialMonsterAlertEnabled),
      abandonedAlertEnabled: checkedValue('abandoned-alert-enabled', defaultConfig.abandonedAlertEnabled),
      pittaHillAlertEnabled: checkedValue('pitta-hill-alert-enabled', defaultConfig.pittaHillAlertEnabled),
      questCompleteAlertEnabled: checkedValue('quest-complete-alert-enabled', defaultConfig.questCompleteAlertEnabled),
    };
  }

  function collectTodaySummaryHudSettings(): Record<string, unknown> {
    return {
      showTodaySummaryHud: checkedValue('today-summary-show-input', defaultConfig.showTodaySummaryHud),
      todaySummaryCollapsed: checkedValue('today-summary-collapsed-input', defaultConfig.todaySummaryCollapsed),
      todaySummaryHudPos: {
        left: integerValue('today-summary-pos-left', defaultConfig.todaySummaryHudPos.left),
        top: integerValue('today-summary-pos-top', defaultConfig.todaySummaryHudPos.top ?? 0),
      },
    };
  }

  window.settingsFormCollection = Object.freeze({
    collectChatOverlayDisplaySettings,
    collectChatAlertSettings,
    collectTodaySummaryHudSettings,
  });
})();
