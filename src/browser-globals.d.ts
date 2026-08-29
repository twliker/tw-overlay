type BrowserAppConfig = import('./shared/types').AppConfig;
type BrowserChatItem = import('./shared/types').ChatItem;
type BrowserFocusedChatState = import('./shared/types').FocusedChatState;
type BrowserTodaySummary = import('./shared/types').TodaySummary;

interface SoundListItem {
  name: string;
  file: string;
}

interface AudioPlaybackController {
  enqueue(sound: { soundFile: string; volume?: number | null }): void;
  interruptAndPlay(sound: { soundFile: string; volume?: number | null }): void;
  dispose(): void;
  pendingCount(): number;
  isPlaying(): boolean;
}

interface SoundThrottle {
  shouldPlay(soundFile: string): boolean;
  clear(): void;
  size(): number;
}

interface ViewRequestGeneration {
  begin(key: string): { generation: number; key: string };
  isCurrent(token: { generation: number; key: string }): boolean;
  invalidate(): void;
  currentKey(): string | null;
}

interface VirtualListOptions<T> {
  container: HTMLElement;
  renderRow(item: T, index: number): HTMLElement;
  getKey(item: T, index: number): string;
  estimatedHeight?: number;
  gap?: number;
  overscanPx?: number;
  paddingStart?: number;
  paddingEnd?: number;
  insetStart?: number;
  insetEnd?: number;
}

interface VirtualListSetOptions {
  scrollToEnd?: boolean;
  preserveAnchor?: boolean;
  resetMeasurements?: boolean;
}

interface VirtualListAppendOptions {
  followEnd?: boolean;
}

interface VirtualListState {
  totalCount: number;
  renderedCount: number;
  startIndex: number;
  endIndex: number;
  totalHeight: number;
}

interface VirtualListController<T> {
  setItems(items: readonly T[], options?: VirtualListSetOptions): void;
  appendItems(items: readonly T[], options?: VirtualListAppendOptions): void;
  prependItems(items: readonly T[]): void;
  resetMeasurements(preserveAnchor?: boolean): void;
  scrollToEnd(): void;
  isAtEnd(threshold?: number): boolean;
  getItems(): readonly T[];
  getState(): VirtualListState;
  destroy(): void;
}

interface BossToastPresentation {
  isRealBoss: boolean;
  validSpawnTime: string | null;
  displayName: string;
  iconName: string;
  iconColor: string;
}

interface ScamToastPresentation {
  isScam: boolean;
  title: string;
  colorClass: string;
  reason: string;
}

interface GameOverlayAlerts {
  showAbandonedAlert(region: string): void;
  showEssenceAlert(): void;
  showPittaAlert(): void;
  showSpecialMonsterAlert(): void;
  showQuestComplete(options: {
    questName: string;
    target: number;
    iconName: string;
  }): void;
  showContentComplete(options: {
    title: string;
    badge: string;
    iconName: string;
  }): void;
}

interface GameOverlayEditMode {
  enterEditMode(): void;
  exitEditMode(save?: boolean): void;
  isEditMode(): boolean;
}

interface SettingsSoundPreview {
  previewAlertSound(options: {
    soundElementId: string;
    volumeElementId: string;
    label: string;
    fallbackSound?: string | null;
    fallbackVolume: number;
    allowNone?: boolean;
  }): void;
}

interface SettingsListRendering {
  createKeywordTag(
    keyword: string,
    className: string,
    onRemove: () => void,
  ): HTMLSpanElement;
  createCustomSoundRow(options: {
    sound: SoundListItem;
    onPreview: () => void;
    onRename: (name: string) => void;
    onDelete: () => void;
  }): HTMLDivElement;
}

interface SettingsColorPicker {
  getColor(): {
    toHEXA(): {
      toString(index: number): string;
    };
  };
}

interface SettingsFormCollection {
  collectChatOverlayDisplaySettings(blacklistFilters?: string[], customTabs?: unknown[]): Record<string, unknown>;
  collectChatAlertSettings(lootKeywords: string[], shoutKeywords: string[]): Record<string, unknown>;
  collectTodaySummaryHudSettings(): Record<string, unknown>;
}

interface SettingsShortcuts {
  getShortcuts(): Record<string, string>;
  mergeShortcuts(shortcuts: Record<string, string> | null | undefined): void;
  renderInputs(): void;
  handleKeyDown(event: KeyboardEvent): boolean;
  stopRecording(): void;
}

interface SettingsMenuManagement {
  initialize(config?: { hiddenMenuIds?: string[]; visibleMenuIds?: string[] } | null): Promise<void>;
  render(
    menus: Array<Record<string, unknown>>,
    config?: { hiddenMenuIds?: string[]; visibleMenuIds?: string[] } | null,
  ): void;
  applyConfig(config: { hiddenMenuIds?: string[]; visibleMenuIds?: string[] } | null | undefined): void;
  collectHiddenMenuIds(): string[];
}

interface SettingsAudioControls {
  initializeAlertSoundSelects(): Promise<void>;
  refreshAlertSoundSelects(): Promise<void>;
  applyAlertSoundConfig(config: {
    waveMonsterWarningSound?: string;
    ethosAlertSound?: string;
    abyssApostleStartSound?: string;
    abyssApostleEndSound?: string;
    lokagosAlertSound?: string;
  }): void;
  bindVolumeControl(type: string, initialValue: number): void;
  toggleMute(type: string): void;
}

interface SettingsConfigBinding {
  applyGeneralSettings(config: unknown, defaultConfig: unknown): void;
  applyChatAndAlertSettings(config: unknown, defaultConfig: unknown): void;
  applyOverlayDisplayOptions(
    config: unknown,
    defaultConfig: unknown,
  ): void;
  applyRadioSettings(config: unknown, defaultConfig: unknown): void;
  trackChatOverlaySizeInputs(): void;
  refreshUntouchedChatOverlaySizes(config: unknown): void;
}

interface ContentsAudioFeedback {
  getVolume(config: { volumeContentsChecker?: number } | null | undefined): number;
  play(
    config: { volumeContentsChecker?: number } | null | undefined,
    soundFile: string,
  ): void;
  getCompletionSound(resetType: string): string;
}

interface ContentsDomRendering {
  createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K];
  createIcon(name: string, className: string): HTMLElement;
  createBadge(text: string, className: string): HTMLSpanElement;
  createIconButton(options: {
    icon: string;
    className: string;
    iconClassName: string;
    title?: string;
    onClick: (event: MouseEvent) => void;
  }): HTMLButtonElement;
  setStatusButtonContent(
    button: HTMLButtonElement,
    characterName: string,
    statusText: string,
    statusClassName: string,
  ): void;
}

interface DiaryLogUtils {
  parseAutoLogAmount(content: string): number;
  formatLogContent(content: string): string;
  resolveLootCount(content: string, storedAmount: unknown): number;
}

interface HuntingExpCalculatorGlobal {
  EXPERIENCE_ESSENCE_XP: number;
  DEFAULT_DOPINGS: readonly import('./shared/types').HuntingExpDoping[];
  DEFAULT_GROUNDS: readonly import('./shared/types').HuntingExpGround[];
  calculate(input: {
    dopings: readonly import('./shared/types').HuntingExpDoping[];
    baseXp: number;
    killsPerHour: number;
    happyHour: boolean;
  }): {
    appliedPercent: number;
    experiencePerKill: number;
    experiencePerHour: number;
    experienceEssencePerHour: number;
  };
}

interface Window {
  lucide?: {
    createIcons(): void;
  };
  REAL_BOSSES: readonly string[];
  refreshIcons(): void;
  replayAnimation(element: HTMLElement | null, className?: string): void;
  bindEscapeClose(): void;
  bindElectronListenerCleanup(): void;
  highlightElement(
    element: HTMLElement | null,
    activeStyle: { borderColor: string; boxShadow: string },
  ): void;
  loadSoundList(): Promise<SoundListItem[]>;
  updateRangeValue(inputElement: HTMLInputElement, targetId: string): void;
  formatElapsedTime(milliseconds: number): string;
  formatLocaleNumber(value: number): string;
  compareKoreanText(left: unknown, right: unknown): number;
  normalizeChatDisplayText(value: unknown): string;
  formatSeedAmount(seed: number): string;
  playPreview(soundFile: string, volume?: number | null, bossName?: string): void;
  escapeHtml(value: string): string;
  escapeHtmlText(value: string): string;
  escapeHtmlAttribute(value: string): string;
  getBossToastPresentation(
    bossName: string,
    isCustomFromApi: boolean,
    spawnTime: string | null | undefined,
    offset: number,
  ): BossToastPresentation;
  getScamToastPresentation(result: {
    verdict: string;
    analysisReason?: string;
    detectedScamTypes?: string;
  }): ScamToastPresentation;
  createInteractiveToastRegistry(
    onCountChanged: (count: number) => void,
  ): InteractiveToastRegistry;
  createAudioPlaybackController(options?: {
    createAudio?: (sourceUrl: string) => Pick<HTMLAudioElement, 'onended' | 'pause' | 'play' | 'volume'>;
    getDefaultVolume?: () => number;
    setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
    createCacheToken?: () => string;
    transitionDelayMs?: number;
    onError?: (error: unknown) => void;
  }): AudioPlaybackController;
  createSoundThrottle(options?: {
    intervalMs?: number;
    maxEntries?: number;
    now?: () => number;
  }): SoundThrottle;
  createViewRequestGeneration(): ViewRequestGeneration;
  createVirtualList<T>(options: VirtualListOptions<T>): VirtualListController<T>;
  showChatLogWarningBanner(options?: { variant?: 'overlay' }): void;
  bindChatLogStatusWarning(options?: { variant?: 'overlay' }): void;
  gameOverlayAlerts: GameOverlayAlerts;
  gameOverlayEditMode?: GameOverlayEditMode;
  __isTimerRunning?: () => boolean;
  __isAbandonedActive?: () => boolean;
  __isDigsiteActive?: () => boolean;
  __isQuestActive?: () => boolean;
  settingsSoundPreview: SettingsSoundPreview;
  settingsListRendering: SettingsListRendering;
  settingsFormCollection: SettingsFormCollection;
  settingsShortcuts: SettingsShortcuts;
  settingsMenuManagement: SettingsMenuManagement;
  settingsAudioControls: SettingsAudioControls;
  settingsConfigBinding: SettingsConfigBinding;
  recordShortcut(key: string): void;
  resetShortcut(key: string): void;
  toggleMute(type: string): void;
  lastConfig?: BrowserAppConfig | null;
  chatPickers?: Record<string, SettingsColorPicker>;
  nicknamePickers?: Record<string, SettingsColorPicker>;
  contentsAudioFeedback: ContentsAudioFeedback;
  contentsDomRendering: ContentsDomRendering;
  diaryLogUtils: DiaryLogUtils;
  huntingExpCalculator: HuntingExpCalculatorGlobal;
  __twEscapeCloseBound?: boolean;
  __twElectronListenerCleanupBound?: boolean;
  __twChatLogStatusWarningBound?: boolean;
  __twOverlayDevtoolsInitialized?: boolean;
  testEssenceAlert(): void;
  testSpecialMonsterAlert(): void;
  testLokagos(type?: string, zone?: string): void;
  testEthos(passwordOrDirection?: string): void;
  testAbyssApostle(): void;
}

interface InteractiveToastRegistry {
  add(id: string): void;
  remove(id: string): void;
  count(): number;
}
