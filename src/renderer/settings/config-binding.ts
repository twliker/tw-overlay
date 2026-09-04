/** 수신한 설정값을 설정 화면의 독립적인 입력 요소에 반영합니다. */
(() => {
  interface SettingsBindingConfig {
    homeUrl?: string;
    width?: number;
    height?: number;
    autoLaunch?: boolean;
    autoUpdateEnabled?: boolean;
    followGameWindow?: boolean;
    autoOpenContentsChecker?: boolean;
    gameExitReminderEnabled?: boolean;
    gameExitReminderMessage?: string;
    diaryKeepDays?: number;
    analyticsEnabled?: boolean;
    chatLogPath?: string;
    chatLogAutoDeleteDays?: number;
    ethosAlertEnabled?: boolean;
    ethosAlertSound?: string;
    ethosAlertVolume?: number;
    abyssApostleAlertEnabled?: boolean;
    abyssApostleStartSound?: string;
    abyssApostleEndSound?: string;
    abyssApostleVolume?: number;
    lokagosAlertEnabled?: boolean;
    lokagosAlertSound?: string;
    lokagosAlertVolume?: number;
    waveMonsterWarningEnabled?: boolean;
    waveMonsterWarningSound?: string;
    waveMonsterWarningVolume?: number;
    specialMonsterAlertEnabled?: boolean;
    abandonedAlertEnabled?: boolean;
    pittaHillAlertEnabled?: boolean;
    questCompleteAlertEnabled?: boolean;
    questCompleteAlertSound?: string;
    questCompleteAlertVolume?: number;
    abyssTreasureAlertEnabled?: boolean;
    abyssTreasureAlertSound?: string;
    abyssTreasureAlertVolume?: number;
    notifyWhenGameClosed?: boolean;
    userServer?: number;
    chatOverlayFontSize?: number;
    chatOverlayOpacity?: number;
    chatOverlaySubOpacity?: number;
    chatOverlaySub2Opacity?: number;
    chatOverlayWidth?: number;
    chatOverlayHeight?: number;
    chatOverlaySubWidth?: number;
    chatOverlaySubHeight?: number;
    chatOverlaySub2Width?: number;
    chatOverlaySub2Height?: number;
    chatOverlayVisibleTabs?: string[];
    chatOverlaySelectedChannels?: string[];
    chatOverlayShowNpcChat?: boolean;
    chatOverlayBlacklistFilters?: string[];
    chatOverlayShowXpGain?: boolean;
    chatOverlayShowElsoGain?: boolean;
    chatOverlayHighlightScamNicknames?: boolean;
    chatOverlayNicknameColorMode?: string;
    forgeQuestHudPos?: { left: number; bottom: number };
    showTodaySummaryHud?: boolean;
    todaySummaryCollapsed?: boolean;
    todaySummaryHudPos?: { left: number; top?: number; bottom?: number };
    showHudShortcuts?: boolean;
    digsiteHudEnabled?: boolean;
    tradeServer?: string;
    sidebarPosition?: string;
    showSidebarToastOnOverlay?: boolean;
  }

  const input = (id: string): HTMLInputElement | null =>
    document.getElementById(id) as HTMLInputElement | null;
  const select = (id: string): HTMLSelectElement | null =>
    document.getElementById(id) as HTMLSelectElement | null;

  const CHAT_OVERLAY_SIZE_FIELDS = [
    ['chat-overlay-width-input', 'chatOverlayWidth'],
    ['chat-overlay-height-input', 'chatOverlayHeight'],
    ['chat-overlay-sub-width-input', 'chatOverlaySubWidth'],
    ['chat-overlay-sub-height-input', 'chatOverlaySubHeight'],
    ['chat-overlay-sub2-width-input', 'chatOverlaySub2Width'],
    ['chat-overlay-sub2-height-input', 'chatOverlaySub2Height'],
  ] as const;

  function setValue(id: string, value: string | number): void {
    const element = input(id) || select(id);
    if (element) element.value = String(value);
  }

  function setChecked(id: string, checked: boolean): void {
    const element = input(id);
    if (element) element.checked = checked;
  }

  function bindRange(
    inputId: string,
    labelId: string,
    value: number,
    format: (current: string) => string,
  ): void {
    const range = input(inputId);
    const label = document.getElementById(labelId);
    if (!range || !label) return;
    range.value = String(value);
    label.innerText = format(String(value));
    range.oninput = event => {
      label.innerText = format((event.target as HTMLInputElement).value);
    };
  }

  function applyGeneralSettings(configValue: unknown, defaultConfigValue: unknown): void {
    const config = configValue as SettingsBindingConfig;
    const defaults = defaultConfigValue as SettingsBindingConfig;
    setValue('home-url-input', config.homeUrl || defaults.homeUrl || '');
    setValue('width-input', config.width || defaults.width || 800);
    setValue('height-input', config.height || defaults.height || 600);
    setChecked('auto-launch-input', config.autoLaunch ?? defaults.autoLaunch ?? false);
    setChecked('auto-update-input', config.autoUpdateEnabled ?? defaults.autoUpdateEnabled ?? true);
    setChecked('analytics-enabled-input', config.analyticsEnabled ?? defaults.analyticsEnabled ?? true);
    setChecked('follow-game-window-input', config.followGameWindow ?? defaults.followGameWindow ?? true);
    setChecked('auto-open-contents-checker-input', config.autoOpenContentsChecker ?? defaults.autoOpenContentsChecker ?? false);
    setChecked('game-exit-reminder-input', config.gameExitReminderEnabled ?? defaults.gameExitReminderEnabled ?? false);
    setValue('game-exit-reminder-message', config.gameExitReminderMessage || defaults.gameExitReminderMessage || '');
    setValue('diary-keep-days-input', config.diaryKeepDays ?? defaults.diaryKeepDays ?? 180);
  }

  function applyChatAndAlertSettings(configValue: unknown, defaultConfigValue: unknown): void {
    const config = configValue as SettingsBindingConfig;
    const defaults = defaultConfigValue as SettingsBindingConfig;
    setValue('chat-log-path-input', config.chatLogPath || defaults.chatLogPath || '');
    setValue('chat-log-auto-delete-input', config.chatLogAutoDeleteDays ?? defaults.chatLogAutoDeleteDays ?? 0);

    setChecked('ethos-alert-enabled', config.ethosAlertEnabled ?? defaults.ethosAlertEnabled ?? false);
    setValue('ethos-alert-sound', config.ethosAlertSound || defaults.ethosAlertSound || '');
    bindRange(
      'ethos-alert-volume',
      'ethos-alert-volume-val',
      config.ethosAlertVolume ?? defaults.ethosAlertVolume ?? 40,
      value => `${value}%`,
    );

    setChecked('abyss-apostle-alert-enabled', config.abyssApostleAlertEnabled ?? defaults.abyssApostleAlertEnabled ?? false);
    setValue('abyss-apostle-start-sound', config.abyssApostleStartSound || defaults.abyssApostleStartSound || '');
    setValue('abyss-apostle-end-sound', config.abyssApostleEndSound || defaults.abyssApostleEndSound || '');
    bindRange(
      'abyss-apostle-volume',
      'abyss-apostle-volume-val',
      config.abyssApostleVolume ?? defaults.abyssApostleVolume ?? 40,
      value => `${value}%`,
    );

    setChecked('lokagos-alert-enabled', config.lokagosAlertEnabled ?? defaults.lokagosAlertEnabled ?? false);
    setValue('lokagos-alert-sound', config.lokagosAlertSound || defaults.lokagosAlertSound || '');
    bindRange(
      'lokagos-alert-volume',
      'lokagos-alert-volume-val',
      config.lokagosAlertVolume ?? defaults.lokagosAlertVolume ?? 40,
      value => `${value}%`,
    );

    setChecked('wave-warning-enabled', config.waveMonsterWarningEnabled ?? defaults.waveMonsterWarningEnabled ?? true);
    setValue('wave-warning-sound', config.waveMonsterWarningSound || defaults.waveMonsterWarningSound || '');
    bindRange(
      'wave-warning-volume',
      'wave-warning-volume-val',
      config.waveMonsterWarningVolume ?? defaults.waveMonsterWarningVolume ?? 70,
      value => `${value}%`,
    );

    setChecked('special-monster-alert-enabled', config.specialMonsterAlertEnabled ?? defaults.specialMonsterAlertEnabled ?? true);
    setChecked('abandoned-alert-enabled', config.abandonedAlertEnabled ?? defaults.abandonedAlertEnabled ?? true);
    setChecked('pitta-hill-alert-enabled', config.pittaHillAlertEnabled ?? defaults.pittaHillAlertEnabled ?? true);
    setChecked('quest-complete-alert-enabled', config.questCompleteAlertEnabled ?? defaults.questCompleteAlertEnabled ?? true);
    setValue('quest-complete-alert-sound', config.questCompleteAlertSound || defaults.questCompleteAlertSound || '');
    bindRange(
      'quest-complete-alert-volume',
      'quest-complete-alert-volume-val',
      config.questCompleteAlertVolume ?? defaults.questCompleteAlertVolume ?? 40,
      value => `${value}%`,
    );
    setChecked('abyss-treasure-alert-enabled', config.abyssTreasureAlertEnabled ?? defaults.abyssTreasureAlertEnabled ?? true);
    setValue('abyss-treasure-alert-sound', config.abyssTreasureAlertSound || defaults.abyssTreasureAlertSound || '');
    bindRange(
      'abyss-treasure-alert-volume',
      'abyss-treasure-alert-volume-val',
      config.abyssTreasureAlertVolume ?? defaults.abyssTreasureAlertVolume ?? 40,
      value => `${value}%`,
    );
    setChecked('notify-when-game-closed-input', config.notifyWhenGameClosed ?? defaults.notifyWhenGameClosed ?? false);

    setValue('chat-overlay-user-server-input', config.userServer ?? defaults.userServer ?? 7);
    bindRange('chat-overlay-fontsize-input', 'chat-overlay-fontsize-val', config.chatOverlayFontSize ?? defaults.chatOverlayFontSize ?? 14, value => `${value}px`);
    const opacityLabel = (value: string): string => `${Math.round(parseFloat(value) * 100)}%`;
    bindRange('chat-overlay-opacity-input', 'chat-overlay-opacity-val', config.chatOverlayOpacity ?? defaults.chatOverlayOpacity ?? 0.8, opacityLabel);
    bindRange('chat-overlay-sub-opacity-input', 'chat-overlay-sub-opacity-val', config.chatOverlaySubOpacity ?? defaults.chatOverlaySubOpacity ?? 0.8, opacityLabel);
    bindRange('chat-overlay-sub2-opacity-input', 'chat-overlay-sub2-opacity-val', config.chatOverlaySub2Opacity ?? defaults.chatOverlaySub2Opacity ?? 0.8, opacityLabel);

    setValue('chat-overlay-width-input', config.chatOverlayWidth ?? defaults.chatOverlayWidth ?? 450);
    setValue('chat-overlay-height-input', config.chatOverlayHeight ?? defaults.chatOverlayHeight ?? 400);
    setValue('chat-overlay-sub-width-input', config.chatOverlaySubWidth ?? defaults.chatOverlaySubWidth ?? 450);
    setValue('chat-overlay-sub-height-input', config.chatOverlaySubHeight ?? defaults.chatOverlaySubHeight ?? 400);
    setValue('chat-overlay-sub2-width-input', config.chatOverlaySub2Width ?? defaults.chatOverlaySub2Width ?? 450);
    setValue('chat-overlay-sub2-height-input', config.chatOverlaySub2Height ?? defaults.chatOverlaySub2Height ?? 400);
  }

  function applyOverlayDisplayOptions(
    configValue: unknown,
    defaultConfigValue: unknown,
  ): void {
    const config = configValue as SettingsBindingConfig;
    const defaults = defaultConfigValue as SettingsBindingConfig;
    const visibleTabs = config.chatOverlayVisibleTabs
      || defaults.chatOverlayVisibleTabs
      || [...window.chatChannels.OVERLAY_BUILT_IN_TABS];
    window.chatChannels.OVERLAY_BUILT_IN_TABS.forEach(tab => {
      setChecked(`chat-overlay-visible-tab-${tab}`, visibleTabs.includes(tab));
    });
    const selectedChannels = config.chatOverlaySelectedChannels
      || defaults.chatOverlaySelectedChannels
      || [...window.chatChannels.OVERLAY_CHANNELS];
    window.chatChannels.OVERLAY_CHANNELS.forEach(channel => {
      setChecked(`chat-overlay-channel-${channel}`, selectedChannels.includes(channel));
    });
    setChecked('chat-overlay-show-npc-chat', config.chatOverlayShowNpcChat ?? defaults.chatOverlayShowNpcChat ?? true);
    setChecked('chat-overlay-show-xp-gain', config.chatOverlayShowXpGain ?? defaults.chatOverlayShowXpGain ?? true);
    setChecked('chat-overlay-show-elso-gain', config.chatOverlayShowElsoGain ?? defaults.chatOverlayShowElsoGain ?? true);
    setChecked('chat-overlay-highlight-scam-nicknames', config.chatOverlayHighlightScamNicknames ?? defaults.chatOverlayHighlightScamNicknames ?? true);
    setValue('chat-overlay-nickname-color-mode-input', config.chatOverlayNicknameColorMode || defaults.chatOverlayNicknameColorMode || 'same');

    const forgePosition = config.forgeQuestHudPos || defaults.forgeQuestHudPos || { left: 50, bottom: 215 };
    setValue('forge-hud-pos-left', forgePosition.left);
    setValue('forge-hud-pos-bottom', forgePosition.bottom);

    setChecked('today-summary-show-input', config.showTodaySummaryHud ?? defaults.showTodaySummaryHud ?? true);
    setChecked('today-summary-collapsed-input', config.todaySummaryCollapsed ?? defaults.todaySummaryCollapsed ?? true);
    setChecked('show-hud-shortcuts-input', config.showHudShortcuts ?? defaults.showHudShortcuts ?? true);
    setChecked('digsite-hud-enabled-input', config.digsiteHudEnabled ?? defaults.digsiteHudEnabled ?? true);
    const todaySummaryPosition = config.todaySummaryHudPos
      || defaults.todaySummaryHudPos
      || { left: 0, top: 200 };
    setValue('today-summary-pos-left', todaySummaryPosition.left ?? 0);
    setValue('today-summary-pos-top', todaySummaryPosition.top ?? 200);
  }

  function applyRadioSettings(configValue: unknown, defaultConfigValue: unknown): void {
    const config = configValue as SettingsBindingConfig;
    const defaults = defaultConfigValue as SettingsBindingConfig;
    const tradeServer = config.tradeServer || defaults.tradeServer || 'RyXp';
    document.querySelectorAll<HTMLInputElement>('input[name="trade-server"]').forEach(radio => {
      if (radio.value === tradeServer) radio.checked = true;
    });
    const sidebarPosition = config.sidebarPosition || defaults.sidebarPosition || 'right';
    document.querySelectorAll<HTMLInputElement>('input[name="sidebar-position"]').forEach(radio => {
      if (radio.value === sidebarPosition) radio.checked = true;
    });
    setChecked('show-sidebar-toast-on-overlay-input', config.showSidebarToastOnOverlay ?? defaults.showSidebarToastOnOverlay ?? false);
  }

  function trackChatOverlaySizeInputs(): void {
    for (const [inputId] of CHAT_OVERLAY_SIZE_FIELDS) {
      const element = input(inputId);
      if (!element || element.dataset.liveSizeTrackingBound === 'true') continue;
      element.dataset.liveSizeTrackingBound = 'true';
      element.addEventListener('input', () => {
        element.dataset.userEditedSinceLoad = 'true';
      });
    }
  }

  function refreshUntouchedChatOverlaySizes(configValue: unknown): void {
    const config = configValue as SettingsBindingConfig;
    for (const [inputId, configKey] of CHAT_OVERLAY_SIZE_FIELDS) {
      const element = input(inputId);
      const latestValue = config[configKey];
      if (!element || element.dataset.userEditedSinceLoad === 'true' || latestValue === undefined) continue;
      element.value = String(latestValue);
    }
  }

  window.settingsConfigBinding = Object.freeze({
    applyGeneralSettings,
    applyChatAndAlertSettings,
    applyOverlayDisplayOptions,
    applyRadioSettings,
    trackChatOverlaySizeInputs,
    refreshUntouchedChatOverlaySizes,
  });
})();
