import { contextBridge, ipcRenderer } from 'electron';
import type { QuickSlotItem, AppConfig, GalleryPost, GalleryActivity, WatchedPost, UpdateStatusInfo, EtaRankingParams, TradePost, TradeActivity, ScamAnalysisResult, ModelStatus, GpuDetectionResult, ServerStatus, SessionState, XpStats, ResetRule, AbandonedRoadState, ChatItem, TimerRecord, EquipmentDictionaryItem, IncompleteContentItem, BuffTimerState, TodaySummary, UpdateNoticeData, SyncProgressInfo, SyncResultReport, ChatLogValidationResult, GoogleSyncStatus, GoogleSyncResult, GoogleSyncPayload, GoogleSyncDataKind, GoogleSyncFileRestoreResult, GoogleSyncChangeSummary, GoogleDriveFileMeta } from './shared/types';
import type { SyncTargetFile } from './modules/chatLogSyncManager';

// sandbox preload은 로컬 모듈 require가 제한되므로 메인 프로세스의 단일 기본값 원본을 동기 조회합니다.
const MAIN_DEFAULT_CONFIG = ipcRenderer.sendSync('get-default-config-sync') as AppConfig;

const DEFAULT_CONFIG: AppConfig = MAIN_DEFAULT_CONFIG;

function bindIpcListener<TArgs extends unknown[]>(
  channel: string,
  callback: (...args: TArgs) => void,
): void {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_event, ...args) => callback(...args as TArgs));
}

contextBridge.exposeInMainWorld('electronAPI', {
  DEFAULT_CONFIG,
  // 창 제어
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),
  toggleDock: () => ipcRenderer.send('toggle-dock'),
  toggleOverlay: () => ipcRenderer.send('toggle-overlay'),
  toggleClickThrough: () => ipcRenderer.send('toggle-click-through'),
  toggleSettings: (tabId?: string) => ipcRenderer.send('toggle-settings', tabId),
  toggleGallery: () => ipcRenderer.send('toggle-gallery'),
  toggleAbbreviation: () => ipcRenderer.send('toggle-abbreviation'),
  toggleEquipmentDic: () => ipcRenderer.send('toggle-equipment-dic'),
  toggleBuffs: () => ipcRenderer.send('toggle-buffs'),
  toggleBossSettings: () => ipcRenderer.send('toggle-boss-settings'),
  toggleEtaRanking: () => ipcRenderer.send('toggle-eta-ranking'),
  toggleTrade: () => ipcRenderer.send('toggle-trade'),
  toggleCoefficientCalculator: () => ipcRenderer.send('toggle-coefficient-calculator'),
  openCoefficientCalculator: () => ipcRenderer.send('open-coefficient-calculator'),
  sendEquipmentToCoefficient: (item: EquipmentDictionaryItem) => ipcRenderer.send('send-to-coefficient', item),
  sendEquipmentToEvolution: (item: EquipmentDictionaryItem) => ipcRenderer.send('send-to-evolution', item),
  toggleContentsChecker: () => ipcRenderer.send('toggle-contents-checker'),
  toggleEvolutionCalculator: () => ipcRenderer.send('toggle-evolution-calculator'),
  toggleThesisCoreCalculator: () => ipcRenderer.send('toggle-thesis-core-calculator'),
  toggleMagicStoneCalculator: () => ipcRenderer.send('toggle-magic-stone-calculator'),
  toggleHuntingExpCalculator: () => ipcRenderer.send('toggle-hunting-exp-calculator'),
  toggleRelicCalculator: () => ipcRenderer.send('toggle-relic-calculator'),
  toggleEquipmentSimulator: () => ipcRenderer.send('toggle-equipment-simulator'),
  toggleCustomAlert: () => ipcRenderer.send('toggle-custom-alert'),
  toggleScamDetector: () => ipcRenderer.send('toggle-scam-detector'),
  toggleUniformColor: () => ipcRenderer.send('toggle-uniform-color'),
  toggleSwordEnhance: () => ipcRenderer.send('toggle-sword-enhance'),
  toggleDiary: () => ipcRenderer.send('toggle-diary'),
  toggleXpHud: () => ipcRenderer.send('toggle-xp-hud'),
  toggleSienaAura: () => ipcRenderer.send('toggle-siena-aura'),
  toggleHuntingPathSimulator: () => ipcRenderer.send('toggle-hunting-path-simulator'),
  toggleWelcomeGuide: () => ipcRenderer.send('toggle-welcome-guide'),
  toggleUpdateNotice: () => ipcRenderer.send('toggle-update-notice'),
  toggleStopwatch: () => ipcRenderer.send('toggle-stopwatch'),
  getHuntingGrounds: () => ipcRenderer.invoke('get-hunting-grounds'),
  getHuntingPath: (groundId: string) => ipcRenderer.invoke('get-hunting-path', groundId),
  saveHuntingPath: (groundId: string, points: Array<[number, number, string?]>) => ipcRenderer.send('save-hunting-path', groundId, points),
  resetXp: () => ipcRenderer.send('xp-reset'),
  startXpSession: () => ipcRenderer.send('xp-start-session'),
  stopXpSession: () => ipcRenderer.send('xp-stop-session'),
  getXpStats: (): Promise<XpStats> => ipcRenderer.invoke('xp-get-stats'),
  abandonedReset: () => ipcRenderer.send('abandoned-reset'),
  startChatLogWatch: () => ipcRenderer.send('start-chat-log-watch'),
  checkChatLogStatus: () => ipcRenderer.invoke('check-chat-log-status'),
  validateChatLogPath: (customPath?: string): Promise<ChatLogValidationResult> => ipcRenderer.invoke('validate-chat-log-path', customPath),
  sendRendererReady: (windowKey: string) => ipcRenderer.send('renderer-ready', windowKey),
  openAndHighlight: (key: string) => ipcRenderer.send('open-and-highlight', key),
  contentsToggleItem: (id: string, characterId?: string) => ipcRenderer.send('contents-toggle-item', id, characterId),
  contentsUpdateCount: (id: string, characterId: string, count: number) => ipcRenderer.send('contents-update-count', id, characterId, count),
  contentsToggleExclude: (id: string, characterId: string) => ipcRenderer.send('contents-toggle-exclude', id, characterId),
  contentsToggleVisibility: (id: string) => ipcRenderer.send('contents-toggle-visibility', id),
  contentsUpdateCategory: (id: string, category: string) => ipcRenderer.send('contents-update-category', id, category),
  contentsUpdateName: (id: string, name: string) => ipcRenderer.send('contents-update-name', id, name),
  contentsUpdateItem: (id: string, name: string, category: string, rule: ResetRule, maxCount?: number) => ipcRenderer.send('contents-update-item', id, name, category, rule, maxCount),
  contentsAddCustom: (name: string, category: string, rule: ResetRule, maxCount?: number) => ipcRenderer.send('contents-add-custom', name, category, rule, maxCount),
  contentsRemoveItem: (id: string) => ipcRenderer.send('contents-remove-item', id),
  contentsMoveItem: (id: string, direction: 'up' | 'down') => ipcRenderer.send('contents-move-item', id, direction),
  contentsMoveCategory: (resetType: ResetRule['type'], category: string, direction: 'up' | 'down') => ipcRenderer.send('contents-move-category', resetType, category, direction),
  contentsReorderItem: (sourceId: string, targetId: string, position: 'before' | 'after') => ipcRenderer.send('contents-reorder-item', sourceId, targetId, position),
  contentsReorderCategory: (resetType: ResetRule['type'], sourceCategory: string, targetCategory: string, position: 'before' | 'after') => ipcRenderer.send('contents-reorder-category', resetType, sourceCategory, targetCategory, position),
  contentsManualReset: () => ipcRenderer.send('contents-manual-reset'),
  contentsAddCharacter: (name: string) => ipcRenderer.send('contents-add-character', name),
  contentsRemoveCharacter: (id: string) => ipcRenderer.send('contents-remove-character', id),
  contentsRenameCharacter: (id: string, name: string) => ipcRenderer.send('contents-rename-character', id, name),
  contentsSelectCharacter: (id: string) => ipcRenderer.send('contents-select-character', id),
  contentsApplyPending: (characterId: string) => ipcRenderer.send('contents-apply-pending', characterId),
  contentsClearPending: () => ipcRenderer.send('contents-clear-pending'),
  setIgnoreMouseEvents: (ignore: boolean, options: { forward?: boolean }) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
  setAlwaysOnTop: (flag: boolean) => ipcRenderer.send('set-always-on-top', flag),
  setWindowSize: (width: number, height: number) => ipcRenderer.send('set-window-size', width, height),
  setWindowPosition: (x: number, y: number) => ipcRenderer.send('set-window-position', x, y),
  welcomeGuideClose: () => ipcRenderer.send('welcome-guide-close'),
  welcomeGuideOpen: () => ipcRenderer.send('welcome-guide-open'),
  startChatLogSync: (): Promise<SyncResultReport> => ipcRenderer.invoke('start-chat-log-sync'),
  getRecentMondayDate: (): Promise<string> => ipcRenderer.invoke('get-recent-monday-date'),
  getSyncTargetFiles: (): Promise<SyncTargetFile[]> => ipcRenderer.invoke('get-sync-target-files'),
  completeSetupWizard: (wizardConfig?: { chatLogPath?: string; userServer?: number; chatLogAutoDeleteDays?: number; diaryKeepDays?: number; lootKeywords?: string[] }) =>
    ipcRenderer.send('complete-setup-wizard', wizardConfig),
  updateNoticeClose: () => ipcRenderer.send('update-notice-close'),
  updateNoticeOpen: () => ipcRenderer.send('update-notice-open'),
  getUpdateNoticeData: (): Promise<UpdateNoticeData | null> => ipcRenderer.invoke('get-update-notice-data'),
  setGameOverlayEditMode: (enabled: boolean, saveOnExit: boolean = true): Promise<boolean> =>
    ipcRenderer.invoke('set-game-overlay-edit-mode', enabled, saveOnExit),
  resetGameOverlayPositions: () => ipcRenderer.send('reset-game-overlay-positions'),
  closeApp: () => ipcRenderer.send('close-app'),
  toolbarMouseEnter: () => ipcRenderer.send('toolbar-mouse-enter'),
  toolbarMouseLeave: () => ipcRenderer.send('toolbar-mouse-leave'),

  // 내비게이션
  navigate: (url: string) => ipcRenderer.send('navigate', url),
  goHome: () => ipcRenderer.send('go-home'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),

  // 데이터 및 설정
  setOpacity: (opacity: number) => ipcRenderer.send('set-opacity', opacity),
  saveQuickSlots: (slots: QuickSlotItem[]) => ipcRenderer.send('save-quick-slots', slots),
  applySettings: (settings: Partial<AppConfig>) => ipcRenderer.send('apply-settings', settings),
  getConfig: () => ipcRenderer.invoke('get-config'),
  selectCustomSound: () => ipcRenderer.invoke('select-custom-sound'),
  deleteCustomSound: (filename: string) => ipcRenderer.invoke('delete-custom-sound', filename),
  setChatOverlaySize: (mode: 'main' | 'sub1' | 'sub2', width: number, height: number) => ipcRenderer.send('set-chat-overlay-size', mode, width, height),
  previewBossSound: (soundFile: string, volume: number | null = null, bossName: string = '미리보기') => ipcRenderer.send('preview-boss-sound', soundFile, volume, bossName),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  startUpdateDownload: () => ipcRenderer.send('start-update-download'),
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getGameStatus: () => ipcRenderer.invoke('get-game-status'),
  getOptimizationStatus: () => ipcRenderer.invoke('get-optimization-status'),
  setOptimization: (enable: boolean) => ipcRenderer.invoke('set-optimization', enable),
  sidebarReady: () => ipcRenderer.send('sidebar-ready'),

  // 갤러리 모니터
  galleryAddWatch: (postNo: number) => ipcRenderer.invoke('gallery-add-watch', postNo),
  galleryRemoveWatch: (postNo: number) => ipcRenderer.send('gallery-remove-watch', postNo),
  galleryGetWatched: () => ipcRenderer.invoke('gallery-get-watched'),
  galleryForceCheck: () => ipcRenderer.invoke('gallery-force-check'),
  galleryOpenPost: (postNo: number | string) => ipcRenderer.send('gallery-open-post', postNo),
  galleryGetNotify: () => ipcRenderer.invoke('gallery-get-notify'),
  gallerySetNotify: (enabled: boolean) => ipcRenderer.send('gallery-set-notify', enabled),

  // 에타 랭킹
  getEtaRanking: (params: EtaRankingParams) => ipcRenderer.invoke('get-eta-ranking', params),

  // 거래 게시판 모니터
  tradeForceCheck: () => ipcRenderer.invoke('trade-force-check'),
  tradeGetNotify: () => ipcRenderer.invoke('trade-get-notify'),
  tradeSetNotify: (enabled: boolean) => ipcRenderer.send('trade-set-notify', enabled),
  tradeOpenPost: (url: string) => ipcRenderer.send('trade-open-post', url),
  tradeSetServer: (serverId: string) => ipcRenderer.send('trade-set-server', serverId),
  tradeGetServer: () => ipcRenderer.invoke('trade-get-server'),
  tradeGetServers: () => ipcRenderer.invoke('trade-get-servers'),

  // 일지 (Adventure Log) 시스템
  diaryGetByDate: (date: string) => ipcRenderer.invoke('diary-get-by-date', date),
  getTodaySummary: (): Promise<TodaySummary> => ipcRenderer.invoke('today-summary-get'),
  diaryGetByMonth: (yearMonth: string) => ipcRenderer.invoke('diary-get-by-month', yearMonth),
  diaryGetMonthlySummary: (yearMonth: string) => ipcRenderer.invoke('diary-get-monthly-summary', yearMonth),
  diaryGetStatistics: (yearMonth: string) => ipcRenderer.invoke('diary-get-statistics', yearMonth),
  diaryGetMonthlyRevenue: (yearMonth: string) => ipcRenderer.invoke('diary-get-monthly-revenue', yearMonth),
  diaryAddActivity: (date: string, time: string, type: 'boss' | 'calc' | 'memo' | 'loot' | 'homework', content: string, amount: number = 0) => ipcRenderer.invoke('diary-add-activity', date, time, type, content, amount),
  diaryRemoveActivity: (id: number) => ipcRenderer.invoke('diary-remove-activity', id),
  diaryUpdateMonster: (date: string, monsterId: string) => ipcRenderer.send('diary-update-monster', date, monsterId),

  shortcutsUnregister: () => ipcRenderer.send('shortcuts-unregister'),
  shortcutsRegister: () => ipcRenderer.send('shortcuts-register'),
  requestGameFocus: () => ipcRenderer.send('request-game-focus'),

  // 백업 및 복구
  backupExport: () => ipcRenderer.invoke('backup-export'),
  backupImport: () => ipcRenderer.invoke('backup-import'),
  testDiscordWebhook: (webhookUrl: string) => ipcRenderer.invoke('test-discord-webhook', webhookUrl),

  // Google Drive 동기화
  googleSyncLogin: (): Promise<{ success: boolean; status: GoogleSyncStatus; error?: string }> =>
    ipcRenderer.invoke('google-sync-login'),
  googleSyncCancelLogin: (): Promise<boolean> =>
    ipcRenderer.invoke('google-sync-cancel-login'),
  googleSyncIsLoggingIn: (): Promise<boolean> =>
    ipcRenderer.invoke('google-sync-is-logging-in'),
  googleSyncLogout: (): Promise<GoogleSyncStatus> =>
    ipcRenderer.invoke('google-sync-logout'),
  googleSyncGetStatus: (): Promise<GoogleSyncStatus> =>
    ipcRenderer.invoke('google-sync-get-status'),
  googleSyncBackup: (): Promise<GoogleSyncResult> =>
    ipcRenderer.invoke('google-sync-backup'),
  googleSyncRestore: (selectedKinds: GoogleSyncDataKind[] = ['settings', 'checklist']): Promise<GoogleSyncResult> =>
    ipcRenderer.invoke('google-sync-restore', selectedKinds),
  googleSyncRollback: (): Promise<GoogleSyncResult> =>
    ipcRenderer.invoke('google-sync-rollback'),
  googleSyncPreview: (): Promise<{
    success: boolean;
    payload?: GoogleSyncPayload;
    fileMeta?: GoogleDriveFileMeta;
    fileCount?: number;
    files?: GoogleDriveFileMeta[];
    restoreResults?: GoogleSyncFileRestoreResult[];
    changeSummaries?: GoogleSyncChangeSummary[];
    partial?: boolean;
    error?: string;
  }> =>
    ipcRenderer.invoke('google-sync-preview'),
  googleSyncToggleAuto: (enabled: boolean): Promise<GoogleSyncStatus> =>
    ipcRenderer.invoke('google-sync-toggle-auto', enabled),

  // 채팅 로그
  openChatLogFolderDialog: () => ipcRenderer.invoke('dialog:openChatLogFolder'),
  getShoutHistory: (hours: number, searchQuery: string) => ipcRenderer.invoke('diary-get-shout-history', hours, searchQuery),
  toggleShoutHistory: () => ipcRenderer.send('toggle-shout-history'),
  
  // 채팅 오버레이
  toggleChatOverlay: () => ipcRenderer.send('toggle-chat-overlay'),
  toggleFocusedChat: () => ipcRenderer.send('toggle-focused-chat'),
  toggleChatOverlaySub: (subNum: 1 | 2) => ipcRenderer.send('toggle-chat-overlay-sub', subNum),
  getChatHistory: (category: string) => ipcRenderer.invoke('chat-get-history', category),
  getFocusedChatHistory: () => ipcRenderer.invoke('focused-chat-get-history'),
  getFocusedChatState: () => ipcRenderer.invoke('focused-chat-get-state'),
  setFocusedChatSelfNickname: (nickname: string) => ipcRenderer.send('focused-chat-set-self', nickname),
  setFocusedChatTargets: (nicknames: string[]) => ipcRenderer.send('focused-chat-set-targets', nicknames),
  setFocusedChatSize: (width: number, height: number) => ipcRenderer.send('set-focused-chat-size', width, height),
  getMoreChatHistory: (category: string) => ipcRenderer.invoke('chat-get-more-history', category),
  searchChatLogs: (query: string, options?: { category?: string; limit?: number }) =>
    ipcRenderer.invoke('chat-search-logs', query, options),
  openTodayLog: () => ipcRenderer.send('chat-open-today-log'),
  fetchEtaRankings: () => ipcRenderer.invoke('chat-fetch-eta-rankings'),
  getEtaCacheStatus: () => ipcRenderer.invoke('chat-get-eta-cache-status'),
  
  playSound: (file: string, volume: number) => ipcRenderer.send('play-sound', { file, volume }),
  toggleWordAlarm: () => ipcRenderer.send('toggle-word-alarm'),
  toggleDiscordAlarm: () => ipcRenderer.send('toggle-discord-alarm'),
  getWordAlarmHistory: (hours: number) => ipcRenderer.invoke('word-alarm-get-history', hours),
  getWordAlarmContext: (alarmId: number) => ipcRenderer.invoke('word-alarm-get-context', alarmId),
  deleteWordAlarmHistoryItem: (id: number) => ipcRenderer.send('word-alarm-delete-item', id),
  clearWordAlarmHistory: () => ipcRenderer.send('word-alarm-clear-history'),

  // 사기꾼 탐지
  scamSetEnabled: (enabled: boolean) => ipcRenderer.send('scam-set-enabled', enabled),
  scamGetModelStatus: (): Promise<ModelStatus> => ipcRenderer.invoke('scam-get-model-status'),
  scamGetConstants: (): Promise<{ analysisIntervalSec: number }> => ipcRenderer.invoke('scam-get-constants'),
  scamGetMsgerLogPath: (): Promise<string> => ipcRenderer.invoke('scam-get-msger-log-path'),
  openMsgerLogFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openMsgerLogFolder'),
  scamDownloadModel: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('scam-download-model'),
  scamDetectGpu: (): Promise<GpuDetectionResult> => ipcRenderer.invoke('scam-detect-gpu'),
  scamGetServerStatus: (): Promise<ServerStatus> => ipcRenderer.invoke('scam-get-server-status'),
  scamGetSessionStates: (): Promise<SessionState[]> => ipcRenderer.invoke('scam-get-session-states'),
  scamGetQueueLength: (): Promise<number> => ipcRenderer.invoke('scam-get-queue-length'),
  scamCloseSession: (filePath: string) => ipcRenderer.send('scam-close-session', filePath),
  scamTriggerAnalyze: (filePath: string) => ipcRenderer.send('scam-trigger-analyze', filePath),
  scamStopServer: () => ipcRenderer.send('scam-stop-server'),
  scamInjectTest: (scenario?: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('scam-inject-test', scenario),
  scamDownloadBinaryVariant: (variant: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('scam-download-binary-variant', variant),

  // 이스터애그
  triggerJellyppyRainGlobal: () => ipcRenderer.send('trigger-jellyppy-rain-global'),
  onTriggerJellyppyRain: (callback: () => void) =>
    bindIpcListener('trigger-jellyppy-rain', callback),
  triggerFireworkGlobal: () => ipcRenderer.send('trigger-firework-global'),
  onTriggerFirework: (callback: () => void) =>
    bindIpcListener('trigger-firework', callback),

  // 이벤트 리스너 (중복 등록 방지를 위해 기존 리스너 제거 후 재등록)
  onSidebarStatus: (callback: (isCollapsed: boolean) => void) =>
    bindIpcListener('sidebar-status', callback),
  onOverlayStatus: (callback: (status: boolean) => void) =>
    bindIpcListener('overlay-status', callback),
  onChatOverlayStatus: (callback: (status: boolean) => void) =>
    bindIpcListener('chat-overlay-status', callback),
  onClickThroughStatus: (callback: (status: boolean) => void) =>
    bindIpcListener('click-through-status', callback),
  onActiveWindows: (callback: (activeKeys: string[]) => void) =>
    bindIpcListener('active-windows', callback),
  onConfigData: (callback: (config: AppConfig) => void) =>
    bindIpcListener('config-data', callback),
  onChatLogSyncProgress: (callback: (info: SyncProgressInfo) => void) =>
    bindIpcListener('chat-log-sync-progress', callback),
  onTodaySummaryConfig: (callback: (config: AppConfig) => void) =>
    bindIpcListener('today-summary-config', callback),
  onUrlChange: (callback: (url: string) => void) =>
    bindIpcListener('url-change', callback),
  onLoadStatus: (callback: (isLoading: boolean) => void) =>
    bindIpcListener('load-status', callback),
  onGalleryPosts: (callback: (posts: GalleryPost[]) => void) =>
    bindIpcListener('gallery-posts', callback),
  onGalleryNewActivity: (callback: (data: GalleryActivity) => void) =>
    bindIpcListener('gallery-new-activity', callback),
  onGalleryWatchedUpdate: (callback: (watched: Record<string, WatchedPost>) => void) =>
    bindIpcListener('gallery-watched-update', callback),
  onGalleryConnectionStatus: (callback: (isConnected: boolean) => void) =>
    bindIpcListener('gallery-connection-status', callback),
  onUpdateStatus: (callback: (data: UpdateStatusInfo) => void) =>
    bindIpcListener('update-status', callback),
  onBossTimesData: (callback: (times: Record<string, string[]>) => void) =>
    bindIpcListener('boss-times-data', callback),
  onPlaySound: (callback: (data: { label: string, soundFile: string, spawnTime?: string, offset?: number, isCustom?: boolean, isAlreadyRecorded?: boolean, volume?: number, isPreview?: boolean }) => void) =>
    bindIpcListener('play-sound', callback),
  onTradePosts: (callback: (posts: TradePost[]) => void) =>
    bindIpcListener('trade-posts', callback),
  onTradeNewActivity: (callback: (data: TradeActivity) => void) =>
    bindIpcListener('trade-new-activity', callback),
  onTradeConnectionStatus: (callback: (isConnected: boolean) => void) =>
    bindIpcListener('trade-connection-status', callback),
  onOpenSettingsTab: (callback: (tabId: string) => void) =>
    bindIpcListener('open-settings-tab', callback),
  onHighlightAlarmSettings: (callback: () => void) =>
    bindIpcListener('highlight-alarm-settings', callback),
  onToolbarHover: (callback: (isHover: boolean) => void) =>
    bindIpcListener('toolbar-hover', callback),
  onReminderMessage: (callback: (message: string) => void) =>
    bindIpcListener('reminder-message', callback),
  onIncompleteContents: (callback: (items: IncompleteContentItem[]) => void) =>
    bindIpcListener('incomplete-contents', callback),
  onDiaryUpdated: (callback: () => void) =>
    bindIpcListener('diary-updated', callback),
  onXpUpdate: (callback: (data: { total: number, epm: number, movingEpm: number, lastGain: number, history: number[], kills?: number, essenceCount?: number, xpSinceLastExchange?: number }) => void) =>
    bindIpcListener('xp-update', callback),
  onShoutHistoryUpdated: (callback: () => void) =>
    bindIpcListener('shout-history-updated', callback),
  onBuffTimerUpdate: (callback: (states: BuffTimerState[]) => void) =>
    bindIpcListener('buff-timer-update', callback),
  onBuffTimerWarning: (callback: (data: { buffId: string, phase: string, warnSec: number }) => void) =>
    bindIpcListener('buff-timer-warning', callback),
  toggleBuffTimer: () => ipcRenderer.send('toggle-buff-timer'),
  buffTimerTest: (seconds?: number) => ipcRenderer.send('buff-timer-test', seconds),
  buffTimerClearTest: () => ipcRenderer.send('buff-timer-clear-test'),
  buffTimerClearAll: () => ipcRenderer.send('buff-timer-clear-all'),
  buffTimerDeactivate: (buffId: string) => ipcRenderer.send('buff-timer-deactivate', buffId),
  onXpResetDone: (callback: (data: { startTime: number }) => void) =>
    bindIpcListener('xp-reset-done', callback),
  onEssenceAlert: (callback: () => void) =>
    bindIpcListener('essence-alert', callback),
  onPittaHillAlert: (callback: () => void) =>
    bindIpcListener('pitta-alert', callback),
  onSpecialMonsterAlert: (callback: (data: { message: string }) => void) =>
    bindIpcListener('special-monster-alert', callback),
  onEthosAlert: (callback: (data: { password: string; message: string }) => void) =>
    bindIpcListener('ethos-alert', callback),
  onAbyssApostleAlert: (callback: (data: { message: string }) => void) =>
    bindIpcListener('abyss-apostle-alert', callback),
  onWaveWarningAlert: (callback: () => void) =>
    bindIpcListener('wave-warning-alert', callback),
  onLokagosAlert: (callback: (data: { type: 'EXCLUDE' | 'TARGET'; zone: '알파' | '브라보' | '찰리' | '델타'; message: string }) => void) =>
    bindIpcListener('lokagos-alert', callback),
  onQuestStarted: (callback: (data: { questType: 'forge' | 'golgotha' | 'void', startTime: number, duration: number, startKills: number, targetKills: number }) => void) =>
    bindIpcListener('quest-started', callback),
  onQuestUpdate: (callback: (data: { currentKills: number }) => void) =>
    bindIpcListener('quest-update', callback),
  onQuestComplete: (callback: (data: { questType: 'forge' | 'golgotha' | 'void' }) => void) =>
    bindIpcListener('quest-complete', callback),
  onQuestCancelled: (callback: () => void) =>
    bindIpcListener('quest-cancelled', callback),
  onScamAlert: (callback: (result: ScamAnalysisResult) => void) =>
    bindIpcListener('scam-alert', callback),
  onScamAnalysisResult: (callback: (result: ScamAnalysisResult) => void) =>
    bindIpcListener('scam-analysis-result', callback),
  onScamProgress: (callback: (pct: number) => void) =>
    bindIpcListener('scam-progress', callback),
  onScamSessionUpdate: (callback: (sessions: SessionState[]) => void) =>
    bindIpcListener('scam-session-update', callback),
  onScamAnalysisToken: (callback: (data: { filePath: string; token: string }) => void) =>
    bindIpcListener('scam-analysis-token', callback),
  onAutoSelectEquipment: (callback: (item: EquipmentDictionaryItem) => void) =>
    bindIpcListener('auto-select-equipment', callback),
  onAutoSelectEvolution: (callback: (data: EquipmentDictionaryItem) => void) =>
    bindIpcListener('auto-select-evolution', callback),
  onAbandonedUpdate: (callback: (state: AbandonedRoadState) => void) =>
    bindIpcListener('abandoned-update', callback),
  onAbandonedAlert: (callback: (data: { region: string, count: number }) => void) =>
    bindIpcListener('abandoned-alert', callback),
  onAbandonedHideNow: (callback: () => void) =>
    bindIpcListener('abandoned-hide-now', callback),
  onChatUpdated: (callback: (chatItem: ChatItem) => void) =>
    bindIpcListener('chat-updated', callback),
  onChatHistoryCleared: (callback: () => void) =>
    bindIpcListener('chat-history-cleared', callback),
  onChatOverlayMode: (callback: (mode: 'main' | 'sub1' | 'sub2') => void) =>
    bindIpcListener('chat-overlay-mode', callback),
  onChatLogStatusChanged: (callback: (isValid: boolean) => void) =>
    bindIpcListener('chat-log-status-changed', callback),
  abandonedGetState: () => ipcRenderer.invoke('abandoned-get-state'),
  abandonedForceVisible: (visible: boolean) => ipcRenderer.send('abandoned-force-visible', visible),
  abandonedSetEnabled: (enabled: boolean) => ipcRenderer.send('abandoned-set-enabled', enabled),
  abandonedHideNow: () => ipcRenderer.send('abandoned-hide-now'),
  setAbandonedAutoHide: (minutes: number) => ipcRenderer.send('set-abandoned-autohide', minutes),
  getAlarmLogs: (limit?: number) => ipcRenderer.invoke('alarm-get-logs', limit),
  clearAlarmLogs: () => ipcRenderer.send('alarm-clear-logs'),
  onAlarmLogsUpdated: (callback: () => void) =>
    bindIpcListener('alarm-logs-updated', callback),

  onTimerToggle: (callback: (state: 'start' | 'stop' | 'toggle') => void) =>
    bindIpcListener('timer-toggle', callback),
  onTimerUpdated: (callback: () => void) =>
    bindIpcListener('timer-updated', callback),
  timerSaveRecord: (record: TimerRecord) => ipcRenderer.send('timer-save-record', record),
  timerGetRecords: () => ipcRenderer.invoke('timer-get-records'),
  timerUpdateTitle: (id: number, title: string) => ipcRenderer.send('timer-update-title', id, title),
  timerUpdateSeriesCore: (
    id: number, 
    series: string, 
    core_master: string, 
    coefficient: number,
    char_main: number,
    char_sub: number,
    base_main: number,
    enchant_main: number,
    base_sub: number,
    enchant_sub: number,
    accuracy: number
  ) => ipcRenderer.send(
    'timer-update-series-core', 
    id, 
    series, 
    core_master, 
    coefficient,
    char_main,
    char_sub,
    base_main,
    enchant_main,
    base_sub,
    enchant_sub,
    accuracy
  ),
  timerDeleteRecord: (id: number) => ipcRenderer.send('timer-delete-record', id),
  timerToggleSession: (state: 'start' | 'stop') => ipcRenderer.send('timer-toggle-session', state),

  onGameOverlayEditMode: (callback: (enabled: boolean, saveOnExit?: boolean) => void) =>
    bindIpcListener('game-overlay-edit-mode', callback),
  onGameOverlayResetPositions: (callback: () => void) =>
    bindIpcListener('game-overlay-reset-positions', callback),
  onGoogleSyncStatusChanged: (callback: (status: GoogleSyncStatus) => void) =>
    bindIpcListener('google-sync-status-changed', callback),

  cleanupAllListeners: () => {
    const events = [
      'sidebar-status', 'overlay-status', 'chat-overlay-status', 'click-through-status', 'config-data', 'today-summary-config',
      'url-change', 'load-status', 'gallery-posts', 'gallery-new-activity',
      'gallery-watched-update', 'gallery-connection-status', 'update-status',
      'boss-times-data', 'play-sound', 'trade-posts', 'trade-new-activity',
      'trade-connection-status', 'open-settings-tab', 'toolbar-hover', 'reminder-message',
      'incomplete-contents', 'diary-updated', 'xp-update', 'shout-history-updated',
      'buff-timer-update', 'buff-timer-warning', 'xp-reset-done', 'abandoned-update', 'abandoned-alert', 'abandoned-hide-now', 'pitta-alert', 'special-monster-alert', 'ethos-alert', 'abyss-apostle-alert',
      'scam-alert', 'scam-progress', 'scam-session-update', 'scam-analysis-token', 'scam-analysis-result', 'wave-warning-alert', 'lokagos-alert', 'chat-updated', 'chat-overlay-mode', 'chat-history-cleared',
      'auto-select-equipment', 'auto-select-evolution',
      'quest-started', 'quest-update', 'quest-complete', 'quest-cancelled',
      'trigger-jellyppy-rain', 'trigger-firework', 'chat-log-status-changed',
      'alarm-logs-updated', 'highlight-alarm-settings', 'timer-toggle', 'timer-updated',
      'game-overlay-edit-mode', 'game-overlay-reset-positions', 'google-sync-status-changed',
      'chat-log-sync-progress', 'active-windows'
    ];
    events.forEach(event => ipcRenderer.removeAllListeners(event));
  }
});

const isDevelopmentTestRuntime = typeof process !== 'undefined'
  && (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
  && process.argv.includes('--dev');

if (isDevelopmentTestRuntime) {
  contextBridge.exposeInMainWorld('testChat', (rawLine: string) => {
    ipcRenderer.send('inject-test-chat', rawLine);
  });

  contextBridge.exposeInMainWorld('testEssence', (count: number = 1) => {
    const today = new Date().toISOString().split('T')[0];
    ipcRenderer.send('inject-test-chat', `Date : ${today}`);
    const safeCount = Number.isInteger(count) ? Math.max(1, Math.min(count, 100)) : 1;
    const xpAmount = safeCount * 10_000_000_000;
    const formattedXp = xpAmount.toLocaleString();
    ipcRenderer.send('inject-test-chat', `[22시 50분 00초] 경험치가 ${formattedXp} 감소하였습니다.`);
  });

  contextBridge.exposeInMainWorld('testQuestStart', (type: 'forge' | 'golgotha' | 'void' = 'forge') => {
    const questName = type === 'forge' ? '대장간' : type === 'golgotha' ? '골고다' : '공허';
    ipcRenderer.send('inject-test-chat', `[22시 50분 00초] [twOverlay] ${questName} 도전과제 시작`);
  });

  contextBridge.exposeInMainWorld('testQuestKill', (count: number = 100) => {
    const today = new Date().toISOString().split('T')[0];
    const safeCount = Number.isInteger(count) ? Math.max(1, Math.min(count, 1_000)) : 100;
    ipcRenderer.send('inject-test-chat', `Date : ${today}`);
    for (let i = 0; i < safeCount; i++) {
      ipcRenderer.send('inject-test-chat', `[22시 50분 00초] 경험치가 1,000 올랐습니다.`);
    }
  });
}
