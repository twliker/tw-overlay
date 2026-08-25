/**
 * 공유 타입 정의 — 메인 프로세스와 렌더러 프로세스 양쪽에서 사용
 * constants.ts와 preload.ts 모두 여기서 import합니다.
 */

// ── ChatParser 이벤트 타입 맵 ──
// chatParser.emit() / chatParser.on() 에서 컴파일 타임 타입 검증에 사용

export const MAIN_CHAR_ID = 'char-main';
export const DEFAULT_CHAR_NAME = '본캐';

export interface ChatParserEventMap {
    SEED_GAINED: { date: string; timestamp: string; amount: number; message: string };
    ABANDONED_FEE: { date: string; timestamp: string; amount: number; message: string };
    ABANDONED_ENTRY: { date: string; timestamp: string; region: string; count: number; message: string };
    MAGIC_STONE_GAIN: { date: string; timestamp: string; grade: string; count: number; message: string };
    MAGIC_STONE_LOSS: { date: string; timestamp: string; grade: string; count: number; message: string };
    ITEM_LOOTED: {
        date: string;
        timestamp: string;
        message: string;
        itemName: string;
        count: number;
        source: 'direct' | 'pet' | 'other';
        isOwn: boolean;
    };
    XP_CHANGED: { date: string; timestamp: string; amount: number; message: string };
    TRADE_SHOUT: { date: string; timestamp: string; sender: string; message: string };
    BUFF_USED: { date: string; timestamp: string; buffId: string; usedBy: string; message: string };
    PITTA_ENTRY: { date: string; timestamp: string; energy: number; grade: string; message: string };
    PITTA_CLEAR: { date: string; timestamp: string; grade: string; itemName: string; message: string };
    ETHOS_PASSWORD: { date: string; timestamp: string; password: string; message: string };
    ECLIPSE_BOSS_CLEAR: { date: string; timestamp: string; bossName: string; count: number; message: string };
    ECLIPSE_SUPPLIES_CLEAR: { date: string; timestamp: string; count: number; message: string };
    ECLIPSE_SPECIAL_FORCE_CLEAR: { date: string; timestamp: string; count: number; message: string };
    MERCURIAL_BOSS_CLEAR: { date: string; timestamp: string; bossName: string; count: number; message: string };
    CORE_MASTER_CLEAR: { date: string; timestamp: string; contentName: string; count: number; isIncrement?: boolean; message: string };
    RELIC_SANCTUARY_CLEAR: { date: string; timestamp: string; count: number; message: string };
    TESIS_CORE_CLEAR: { date: string; timestamp: string; message: string };
    POWER_ROOT_CLEAR: { date: string; timestamp: string; count: number; message: string };
    ABYSS_TREASURE_ENTRY: { date: string; timestamp: string; count: number; message: string };
    FORTRESS_GHOST_CLEAR: { date: string; timestamp: string; count: number; message: string };
    DIGSITE_ENTRY: { date: string; timestamp: string; count?: number; message: string };
    CONTENT_SHINJO_NEST_CLEAR: { date: string; timestamp: string; count: number; message: string };
    ABYSS_DUNGEON_CLEAR: { date: string; timestamp: string; depth: string; count: number; message: string };
    ABYSS_BOSS_EX_CLEAR: { date: string; timestamp: string; count: number; message: string };
    PRAVA_DEFENSE_CLEAR: { date: string; timestamp: string; count: number; message: string };
    CATACOMB_CLEAR: { date: string; timestamp: string; count: number; message: string };
    SIOKAN_BOSS_CLEAR: { date: string; timestamp: string; count: number; message: string };
    THURSDAY_CLEAN_CLEAR: { date: string; timestamp: string; message: string };
    ETA_DAILY_BOX_GAIN: { date: string; timestamp: string; message: string };
    ETA_WILL_UPGRADE_GAIN: { date: string; timestamp: string; message: string };
    CLUB_POINT_500_GAIN: { date: string; timestamp: string; message: string };
    SPECIAL_MONSTER_SPAWN: { date: string; timestamp: string; message: string };
    ETERNAL_FLOOR_CLEAR: { date: string; timestamp: string; message: string };

    VESTIGE_CLEAR: { date: string; timestamp: string; message: string };
    APETHIRIA_RAID_CLEAR: { date: string; timestamp: string; count: number; message: string };
    ORLY_DEFENSE_CLEAR: { date: string; timestamp: string; message: string };
    SIOKAN_ODIN_CLEAR: { date: string; timestamp: string; count: number; message: string };
    ECLIPSE_BOSS_SUBJUGATION_CLEAR: { date: string; timestamp: string; count: number; message: string };
    MOON_QUEEN_TRAINING_CLEAR: { date: string; timestamp: string; count: number; message: string };
    CONFUSED_LAND_CLEAR: { date: string; timestamp: string; message: string };
    COLORLESS_LAND_CLEAR: { date: string; timestamp: string; message: string };
    ARCHITECT_MINE_ENTRY: { date: string; timestamp: string; count?: number; message: string };
    NORMAL_CHAT: { date: string; timestamp: string; sender: string; message: string; color: string };
    ABYSS_APOSTLE_PATTERN: { date: string; timestamp: string; message: string };
    WAVE_MONSTER_WARNING: { date: string; timestamp: string; message: string };
    LOKAGOS_PATTERN: { date: string; timestamp: string; type: 'EXCLUDE' | 'TARGET'; zone: '알파' | '브라보' | '찰리' | '델타'; message: string };
}

// ── 어벤던로드 상태 타입 ──
export interface AbandonedRoadState {
    regions: Record<string, number>;
    profit: number;
    isActive: boolean;
    isEnabled: boolean;
    stoneGains: Record<string, number>;
    stoneLosses: Record<string, number>;
    totalFee: number;
    unassignedFee?: number;
    currentRegion: string;
    regionDetails: Record<string, {
        count: number;
        totalFee: number;
        stoneGains: Record<string, number>;
        stoneLosses: Record<string, number>;
    }>;
}

export interface QuickSlotItem {
    label: string;
    icon: string;
    url: string;
    external: boolean;
    iconType?: 'icon' | 'text';
    textChar?: string;
}

export interface WatchedPost {
    title: string;
    commentCount: number;
    addedAt: number;
}

export interface WindowPosition {
    offsetX: number;
    offsetY: number;
}

export interface HudPosition {
    left: number;
    bottom?: number;
    top?: number;
}

export interface HuntingExpDoping {
    id: string;
    name: string;
    percent: number;
    duration: string;
    enabled: boolean;
    note: string;
}

export interface HuntingExpGround {
    id: string;
    name: string;
    baseXp: number;
}

export type WindowPositionKey =
    | 'overlay' | 'settings' | 'gallery' | 'abbreviation' | 'equipmentDic' | 'buffs'
    | 'bossSettings' | 'etaRanking' | 'trade' | 'coefficientCalculator' | 'contentsChecker'
    | 'focusedChat' | 'evolutionCalculator' | 'thesisCoreCalculator' | 'magicStoneCalculator'
    | 'customAlert' | 'diary' | 'uniformColor' | 'swordEnhance' | 'shoutHistory'
    | 'gameOverlay' | 'buffTimer' | 'xpHud' | 'scamDetector' | 'sienaAura' | 'wordAlarm'
    | 'discordAlarm' | 'huntingPathSimulator' | 'stopwatch' | 'chatOverlay'
    | 'chatOverlaySub' | 'chatOverlaySub2' | 'huntingExpCalculator' | 'relicCalculator' | 'equipmentSimulator' | 'dock';

export interface XpStats {
    total: number;
    epm: number;
    movingEpm: number;
    startTime: number;
    history: number[];
    kills: number;
    essenceCount: number;
    xpSinceLastExchange: number;
    accumulatedTime: number;
    isActive: boolean;
    lastGain?: number;
}

export type ChatChannel = 'general' | 'team' | 'club' | 'shout' | 'whisper' | 'system';
export type ChatOverlayTab = 'Basic' | 'General' | 'Team' | 'Club' | 'Shout' | 'Whisper' | 'System';

export type SystemColorGroup = 'purple' | 'yellow' | 'red' | 'green' | 'blue' | 'gray';

export interface CustomChatTab {
    id: string;
    name: string;
    channels: ChatChannel[];
    systemColorFilters?: SystemColorGroup[];
}

export interface ChatItem {
    id: string;
    type: ChatChannel;
    timestamp: string;
    sender: string;
    message: string;
    color: string;
    level: number | null;
    characterCode: number | null;
    isSelf?: boolean;
}

export interface FocusedChatState {
    selfNickname: string;
    targets: string[];
    knownNicknames: string[];
}

export interface EquipmentDictionaryItem {
    name: string;
    category?: string;
    subCategory?: string;
    [key: string]: unknown;
}

export interface IncompleteContentItem {
    charName: string;
    name: string;
    category: string;
    type: ResetRule['type'];
}

export interface GameRect {
    x: number;
    y: number;
    width: number;
    height: number;
    gameHwnd?: string;
    isForeground?: boolean;
}

export interface GameNotRunning {
    notRunning: true;
}

export interface GameError {
    error: string;
}

export type GameQueryResult = GameRect | GameNotRunning | GameError | null | undefined;

export interface BossSetting {
    name: string;
    enabled: boolean;
    soundFile: string;
}

export interface CustomAlert {
    id: string;
    enabled: boolean;
    type: 'daily' | 'hourly';  // daily: 매일 HH:mm, hourly: 매시 ?분
    time?: string;      // 'daily' 전용: "HH:mm"
    minute?: number;    // 'hourly' 전용: 0~59
    offsets: number[];  // e.g. [10, 5, 0]
    message: string;
    soundFile: string;
    volume?: number;    // 알림 재생 볼륨 (0~100)
}

export interface ShortcutsConfig {
    /** 창 투과(Click-through) 토글 */
    toggleClickThrough: string;
    /** 숙제 체크 리스트 창 토글 */
    toggleContentsChecker?: string;
    /** 버프 타이머 HUD 표시 토글 */
    toggleBuffHud?: string;
    /** 오늘 요약 HUD 표시 토글 */
    toggleTodaySummaryHud?: string;
    /** 어벤던로드 HUD 보이기/숨기기 토글 */
    toggleAbandonedHud?: string;
    /** Dock 바 토글 */
    toggleDock?: string;
    /** 채팅창 오버레이 토글/싱크 */
    toggleChatOverlaySync?: string;
    /** 경험치 세션 초기화 */
    resetXpSession?: string;
    /** 경험치 세션 시작/중지 토글 */
    toggleXpSession?: string;
    /** 버프 타이머 버프 전체 삭제 */
    clearAllBuffs?: string;
    /** 시간 측정 시작/종료 토글 */
    toggleTimer?: string;
}

/** 채팅 로그 버프 감지 트리거 */
export type ChatPatternType = 'SELF_USE' | 'PARTY_ITEM' | 'EFFECT_APPLIED' | 'FIXED_MSG';

export interface ChatTrigger {
    pattern: ChatPatternType;
    keyword: string;
    matchType?: 'exact' | 'contains'; // 기본값: 'exact'
}

export interface BuffEffects {
    exp?: number;          // 경험치 (%)
    expTeam?: number;      // 파티원 경험치 (%)
    rare?: number;         // 레어 드랍율 (%)
    stat?: number;         // 모든 능력치 고정값
    statRate?: number;     // 모든 능력치 비율 (%)
    damage?: number;       // 대미지 증가 (%)
    critical?: number;     // 크리티컬 확률 (%)
    speed?: number;        // 이동속도
    attribute?: number;    // 속성 (화, 수, 풍 등)
    accuracy?: number;     // 명중률 (%)
    evasion?: number;      // 회피율 (%)
    defense?: number;      // 방어력 / 피해 감소 (%)
    maxHp?: number;        // 최대 HP 고정값/비율
    maxMp?: number;        // 최대 MP 고정값/비율
    maxSp?: number;        // 최대 SP 고정값/비율
}

/** buffs.json 단일 항목 타입 */
export interface BuffDefinition {
    id: string;
    name: string;
    category: string;
    effect: string;
    duration: string;
    durationMs: number;
    group: string;
    removeOnExit?: boolean;
    removeOnDeath?: boolean;
    image: string;
    chatTriggers: ChatTrigger[];
    description: string;
    effects?: BuffEffects;
}

export interface BuffTimerState {
    buffId: string;
    name: string;
    image: string;
    durationMs: number;
    remainingMs: number;
    usedBy: string;
    phase: 'normal' | 'warn1' | 'warn2';
}


export interface ResetRule {
    type: 'daily' | 'weekly';
    dayOfWeek?: number;
    hour?: number;
}

export interface ContentsCheckerItem {
    id: string;
    name: string;
    category: string;
    isVisible: boolean;
    isCustom?: boolean;
    resetRule: ResetRule;
    maxCount?: number; // 최대 완료 필요 횟수 (생략 시 기본값: 1)
    auto?: boolean;    // 실시간 채팅 로그를 통한 자동 체크 지원 여부

    /** 캐릭터별 완료 상태 (다중 캐릭터 지원) */
    completedState: {
        [characterId: string]: {
            isCompleted: boolean;
            lastCompletedAt?: number;
            isExcluded?: boolean; // 캐릭터별 참여 제외 여부
            currentCount?: number; // 현재 완료 횟수 (0 ~ maxCount)
        }
    };
}

export interface CharacterPreset {
    id: string;   // 고유 ID (예: 'char-1')
    name: string; // 사용자 지정 이름 (예: '본캐', '티치엘')
}

export interface PendingHomework {
    id: string;         // 숙제 ID (예: 'weekly-eclipse-boss-ethos')
    count: number;      // 감지된 횟수
    isIncrement: boolean; // 횟수 누적 방식 여부
    timestamp: number;  // 감지된 시간
    /** 같은 채팅 로그의 재처리를 막는 안정적인 이벤트 ID 목록 (레거시 데이터에는 없음) */
    sourceEventIds?: string[];
    /** 서로 다른 일일/주간 리셋 주기의 이벤트가 합쳐지지 않도록 하는 주기 키 */
    resetCycleKey?: string;
}

export interface DiscordKeywordRule {
    keyword: string;          // 감지할 키워드
    targetNormal: boolean;    // 일반 채팅 감지 여부 (#ffffff & #c8ffc8)
    targetClub: boolean;      // 클럽 채팅 감지 여부 (#94ddfa)
    targetShout: boolean;     // 외치기 감지 여부 (#c896c8)
    targetSender?: string;    // 특정 보낸 사람 필터 (비어있으면 전체 감지)
}

export interface AppConfig {
    width: number;
    height: number;
    opacity: number;
    url: string;
    homeUrl: string;
    quickSlots: QuickSlotItem[];
    galleryLastSeen?: number;
    galleryWatched?: Record<string, WatchedPost>;
    galleryNotify?: boolean;
    overlayVisible?: boolean;
    autoLaunch?: boolean;
    autoOpenContentsChecker?: boolean;
    contentsCheckerEnabled?: boolean;
    autoUpdateEnabled?: boolean;
    hasSeenWelcomeGuide?: boolean;
    lastNoticeVersion?: string;
    galleryKeywords?: string[];
    hiddenMenuIds?: string[];
    visibleMenuIds?: string[];
    fieldBossNotifyEnabled?: boolean;
    fieldBossNotifyOffsets?: number[];
    fieldBossNotifyVolume?: number;
    fieldBossSettings?: Record<string, BossSetting>;
    notifyWhenGameClosed?: boolean;
    positions?: Partial<Record<WindowPositionKey, WindowPosition>>;
    storedPositionKeys?: WindowPositionKey[];
    tradeServer?: string;
    tradeKeywords?: string[];
    tradeNotify?: boolean;
    tradeLastSeen?: number;
    gameExitReminderEnabled?: boolean;
    gameExitReminderMessage?: string;
    contentsCheckerItems?: ContentsCheckerItem[];
    characterPresets?: CharacterPreset[];
    selectedCharacterId?: string;
    pendingHomeworks?: PendingHomework[];
    lastContentsResetCheck?: number;
    shortcuts?: ShortcutsConfig;
    customAlerts?: CustomAlert[];
    customSounds?: { name: string; file: string }[];

    // --- Chat Log Settings ---
    chatLogPath?: string;
    chatLogAutoDeleteDays?: number;
    diaryKeepDays?: number;
    lootKeywords?: string[];
    lootKeywordsMigratedV2?: boolean;
    quickSlotsMigratedV2?: boolean;
    shoutKeywords?: string[];
    ethosAlertEnabled?: boolean;
    abyssApostleAlertEnabled?: boolean;
    wordAlarmEnabled?: boolean;
    wordAlarmKeywords?: string[];
    wordAlarmSound?: string;
    wordAlarmVolume?: number;
    wordAlarmHistoryEnabled?: boolean;
    showXpWidget?: boolean;
    xpAutoStart?: boolean;
    ignoreNegativeXp?: boolean;
    xpWidgetPos?: HudPosition;
    showTodaySummaryHud?: boolean;
    todaySummaryCollapsed?: boolean;
    todaySummaryHudPos?: HudPosition;
    huntingExpDopings?: HuntingExpDoping[];
    huntingExpGrounds?: HuntingExpGround[];
    huntingExpSelectedGroundId?: string;
    huntingExpKillsPerHour?: number;
    huntingExpHappyHour?: boolean;
    waveMonsterWarningEnabled?: boolean;
    waveMonsterWarningSound?: string;
    waveMonsterWarningVolume?: number;
    ethosAlertSound?: string;
    ethosAlertVolume?: number;
    abyssApostleStartSound?: string;
    abyssApostleEndSound?: string;
    abyssApostleVolume?: number;
    lokagosAlertEnabled?: boolean;
    lokagosAlertSound?: string;
    lokagosAlertVolume?: number;

    // --- Buff Timer Settings ---
    buffTimerEnabled?: boolean;
    showBuffHud?: boolean;
    showHudShortcuts?: boolean;
    buffTimerWarnSeconds?: number[];
    buffTimerAudioAlert?: boolean;
    buffTimerVisualAlert?: boolean;
    buffTimerVolume?: number;
    buffTimerSound?: string;
    buffTimerBuffs?: { [buffId: string]: boolean }; // buffId → 감지 활성화 여부
    buffTimerCenterAlert?: boolean;
    buffTimerHudPos?: HudPosition;

    // --- Essence Alert Settings ---
    essenceAlertEnabled?: boolean;
    essenceAlertSound?: string;
    essenceAlertVolume?: number;

    // --- Overlay Alerts Settings ---
    specialMonsterAlertEnabled?: boolean;
    abandonedAlertEnabled?: boolean;
    pittaHillAlertEnabled?: boolean;
    questCompleteAlertEnabled?: boolean;

    // --- Abandoned Road Settings ---
    abandonedAutoHideMinutes?: number;
    abandonedEnabled?: boolean;
    abandonedWidgetPos?: HudPosition;

    // --- Scam Detector Settings ---
    scamDetectorEnabled?: boolean;
    msgerLogPath?: string;
    scamAlertSound?: string;
    scamGpuVariant?: LlamaServerVariant;
    scamLlmDisabled?: boolean;

    // --- Discord Webhook Settings ---
    discordWebhookUrl?: string;
    discordAlertEnabled?: boolean;
    discordKeywords?: string[];
    discordRules?: DiscordKeywordRule[];

    // --- Sound Settings ---
    volumeContentsChecker?: number;
    volumeCalculators?: number;
    sidebarPosition?: 'left' | 'right' | 'dock' | 'dock-top';

    // --- Chat Overlay Settings ---
    chatOverlayEnabled?: boolean;
    chatOverlaySubEnabled?: boolean; // 신규 추가
    chatOverlaySub2Enabled?: boolean;
    chatOverlayOpacity?: number;
    chatOverlaySubOpacity?: number;
    chatOverlaySub2Opacity?: number;
    chatOverlayFontSize?: number;
    chatOverlayClickThrough?: boolean;
    chatOverlayKeywords?: string[];
    userServer?: number; // 16: 네냐플, 7: 하이아칸
    etaDataUrl?: string;
    chatOverlayWidth?: number;
    chatOverlayHeight?: number;
    focusedChatWidth?: number;
    focusedChatHeight?: number;
    contentsCheckerWidth?: number;
    contentsCheckerHeight?: number;
    followGameWindow?: boolean;
    chatOverlaySelectedChannels?: string[];
    chatOverlaySubWidth?: number;
    chatOverlaySubHeight?: number;
    chatOverlayTab?: string;
    chatOverlaySubTab?: string;
    chatOverlaySub2Width?: number;
    chatOverlaySub2Height?: number;
    chatOverlaySub2Tab?: string;
    chatOverlayShowNpcChat?: boolean;
    chatOverlayBlacklistFilters?: string[];
    chatOverlayShowXpGain?: boolean;
    chatOverlayShowElsoGain?: boolean;
    chatOverlayHighlightScamNicknames?: boolean;
    chatOverlayColorGeneral?: string;
    chatOverlayColorWhisper?: string;
    chatOverlayColorTeam?: string;
    chatOverlayColorClub?: string;
    chatOverlayColorShout?: string;
    chatOverlayNicknameColorMode?: 'same' | 'custom';
    chatOverlayNicknameColorGeneral?: string;
    chatOverlayNicknameColorWhisper?: string;
    chatOverlayNicknameColorTeam?: string;
    chatOverlayNicknameColorClub?: string;
    chatOverlayNicknameColorShout?: string;
    focusedChatSelfNickname?: string;
    forgeQuestHudPos?: HudPosition;
    questHudPos?: HudPosition;
    showSidebarToastOnOverlay?: boolean;
    setupCompleted?: boolean;
    chatOverlayCustomTabs?: CustomChatTab[];

    // --- Google Drive Sync Settings ---
    googleSyncEnabled?: boolean;
    googleSyncAutoSync?: boolean;
    googleSyncLastTime?: number;
    googleSyncUserEmail?: string;
}

export interface GoogleUserProfile {
    email: string;
    name?: string;
    picture?: string;
}

export interface GoogleAuthTokens {
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
    token_type?: string;
    scope?: string;
}

export interface GoogleDriveFileMeta {
    id: string;
    name: string;
    modifiedTime?: string;
    size?: string;
}

export type GoogleSyncProfileState = 'fresh' | 'established' | 'needs-confirmation';
export type GoogleSyncDataKind = 'settings' | 'checklist';

export interface GoogleSyncFileRestoreResult {
    kind: GoogleSyncDataKind;
    selected: boolean;
    status: 'available' | 'restored' | 'unchanged' | 'missing' | 'invalid' | 'generation-mismatch' | 'skipped';
    fileName?: string;
    revision?: string;
    lastSyncedAt?: number;
    error?: string;
}

export interface GoogleSyncChangeSummary {
    kind: GoogleSyncDataKind;
    addedKeys: string[];
    changedKeys: string[];
    preservedLocalKeys: string[];
    unchangedCount: number;
}

export interface GoogleSyncFileStatus {
    kind: GoogleSyncDataKind;
    localChecksum: string;
    cloudRevision?: string;
    pendingChanges: number;
    retryCount: number;
    lastError?: string;
}

export interface GoogleSyncStatus {
    isLinked: boolean;
    email?: string;
    lastSyncedAt?: number;
    isSyncing?: boolean;
    autoSync?: boolean;
    fileName?: string;
    cloudModifiedTime?: string;
    fileCount?: number;
    files?: GoogleDriveFileMeta[];
    profileState?: GoogleSyncProfileState;
    restoreResults?: GoogleSyncFileRestoreResult[];
    restorePartial?: boolean;
    localBackupAvailable?: boolean;
    localBackupCreatedAt?: number;
    fileStatuses?: GoogleSyncFileStatus[];
    pullRetryCount?: number;
    error?: string;
}

export interface GoogleSyncPayload {
    schemaVersion: number;
    appVersion: string;
    lastSyncedAt: number;
    updatedBy: string;
    kind?: 'settings' | 'checklist';
    revision?: string;
    generationId?: string;
    checksum?: string;
    operations?: GoogleChecklistSyncOperation[];
    operationsChecksum?: string;
    data: Partial<AppConfig>;
}

export interface GoogleChecklistSyncOperation {
    id: string;
    deviceId: string;
    createdAt: number;
    keys: string[];
    mutations: GoogleChecklistSyncMutation[];
}

export interface GoogleChecklistSyncMutation {
    path: string[];
    beforeExists: boolean;
    afterExists: boolean;
    before?: unknown;
    after?: unknown;
}

export interface GoogleSyncMetaPayload {
    schemaVersion: number;
    generationId: string;
    updatedAt: number;
    files: {
        settings?: { id: string; name: string };
        checklist?: { id: string; name: string };
    };
}

export interface GoogleSyncResult {
    success: boolean;
    message?: string;
    lastSyncedAt?: number;
    fileName?: string;
    cloudModifiedTime?: string;
    fileCount?: number;
    files?: GoogleDriveFileMeta[];
    profileState?: GoogleSyncProfileState;
    restoreResults?: GoogleSyncFileRestoreResult[];
    changeSummaries?: GoogleSyncChangeSummary[];
    partial?: boolean;
    error?: string;
}

export interface SyncProgressInfo {
    currentFile: string;
    currentFileIndex: number;
    totalFiles: number;
    percent: number;
    date: string;
    processedLines: number;
    lootsAdded: number;
    shoutsAdded: number;
    homeworkUpdated: number;
    seedsAdded: number;
    elsoPointsAdded: number;
}

export interface SyncResultReport {
    success: boolean;
    startDate: string;
    endDate: string;
    totalFiles: number;
    totalLines: number;
    // 신규 반영 결과 (DB에 새로 추가/갱신된 수량)
    lootsAdded: number;
    homeworkUpdated: number;
    shoutsAdded: number;
    seedsAdded: number;
    elsoPointsAdded: number;
    essencesAdded: number;
    // 로그 총 검출 결과 (로그 파일에서 감지된 총 수량)
    lootsDetected: number;
    homeworkDetected: number;
    shoutsDetected: number;
    seedsDetected: number;
    elsoPointsDetected: number;
    essencesDetected: number;
    error?: string;
}

export interface GalleryPost {
    no: number;
    title: string;
    writer: string;
    replyCount: number;
    time: string;
}

export interface GalleryActivity {
    type: string;
    count: number;
    postNo?: string;
}

export interface UpdateStatusInfo {
    state: 'checking' | 'available' | 'latest' | 'downloading' | 'ready' | 'error' | 'dev-mode' | 'mandatory';
    isMandatory?: boolean;
    version?: string;
    percent?: number;
    message?: string;
    releaseNotes?: string;
}

export interface EtaRankingEntry {
    rank: number;
    character: string;
    nickname: string;
    level: number;
    point: number;
}

export interface EtaRankingResult {
    lastUpdate: string;
    entries: EtaRankingEntry[];
}

export interface EtaRankingParams {
    sc?: number;
    cc?: number;
    page?: number;
    search?: string;
}

export interface TradePost {
    no: number;
    title: string;
    writer: string;
    date: string;
    url: string;
}

export interface TradeActivity {
    type: string;
    count: number;
}

// --- Scam Detector Types ---

export interface MessengerMessage {
  timestamp: string;
  sender: string;
  content: string;
  isSystem: boolean;
  etaLevel?: number | null;
  isSelf?: boolean;
}

export interface ScamAnalysisResult {
  verdict: 'SCAM' | 'SUSPICIOUS' | 'SAFE' | 'UNKNOWN';
  detectedScamTypes: string;
  analysisReason: string;
  actionGuidance: string;
  rawResponse: string;
  filePath: string;
  analyzedAt: number;
}

export interface ModelStatus {
  downloaded: boolean;
  downloading: boolean;
  progress: number;
  modelPath: string;
  serverBinaryReady: boolean;
}

export interface ServerStatus {
  running: boolean;
  ready: boolean;
  pid: number | null;
  activeSessions: number;
}

export interface SessionState {
  filePath: string;
  fileName: string;
  messageCount: number;
  newSinceLastAnalysis: number;
  analyzing: boolean;
  debounceActive: boolean;
  lastVerdict: 'SCAM' | 'SUSPICIOUS' | 'SAFE' | 'UNKNOWN';
  lastMessageTime: number;
  lastAnalysisAt: number;
  messages?: MessengerMessage[];
}

export type LlamaServerVariant = 'cuda-13.1' | 'cuda-12.4' | 'vulkan' | 'cpu';

export interface GpuDetectionResult {
  gpuType: 'nvidia' | 'amd' | 'intel' | 'none';
  gpuName: string;
  cudaVersion?: string;     // e.g. "12.4", "13.1"
  binaryVariant: LlamaServerVariant;
  binaryUrl: string;
  cudartUrl?: string;       // CUDA 빌드 전용 — 런타임 DLL zip
}

// --- Diary (Adventure Log) System Types ---

export interface DiaryEntry {
    date: string;         // YYYY-MM-DD
    total_score: number;
    monster_id: string;
    daily_done: number;
    daily_total: number;
    weekly_done: number;
    weekly_total: number;
}

export interface HomeworkLog {
    id?: number;
    date: string;         // YYYY-MM-DD
    content_id: string;
    content_name: string;
    category: string;
    type: 'daily' | 'weekly';
    completed_at: number; // Timestamp
}

export interface ActivityLog {
    id?: number;
    date: string;         // YYYY-MM-DD
    type: 'boss' | 'calc' | 'memo' | 'loot' | 'homework' | 'elso';
    content: string;
    time: string;         // HH:mm:ss
    amount: number;
    source?: 'manual' | 'automatic' | 'legacy-unknown';
}

export interface DiaryData {
    diary: DiaryEntry | null;
    homeworkLogs: HomeworkLog[];
    activityLogs: ActivityLog[];
}

export interface TodaySummaryLootItem {
    name: string;
    count: number;
}

export interface TodaySummaryHomeworkItem {
    name: string;
    category: string;
    type: ResetRule['type'];
    currentCount: number;
    maxCount: number;
}

export interface TodaySummary {
    date: string;
    totalSeed: number;
    totalElso: number;
    totalEssence: number;
    bossKills: number;
    totalLootCount: number;
    lootItems: TodaySummaryLootItem[];
    homework: {
        characterName: string;
        completedCount: number;
        totalCount: number;
        remainingCount: number;
        remainingItems: TodaySummaryHomeworkItem[];
    };
}

export interface AbandonedRoadState {
    regions: Record<string, number>;
    profit: number;
    isActive: boolean;
    stoneGains: Record<string, number>;
    stoneLosses: Record<string, number>;
    totalFee: number;
    unassignedFee?: number;
    currentRegion: string;
    regionDetails: Record<string, {
        count: number;
        totalFee: number;
        stoneGains: Record<string, number>;
        stoneLosses: Record<string, number>;
    }>;
}

export interface AlarmLog {
    id?: number;
    timestamp: number;
    type: 'boss' | 'custom' | 'word' | 'wave' | 'buff' | 'etc';
    title: string;
    message: string;
}
export interface TimerRecord {
    id?: number;
    date: string;          // YYYY-MM-DD HH:mm:ss
    duration: number;      // 소요 시간 (밀리초)
    title: string;
    series: string;
    core_master: string;
    coefficient: number;
    char_main: number;
    char_sub: number;
    base_main: number;
    enchant_main: number;
    base_sub: number;
    enchant_sub: number;
    accuracy: number;
    raw_profile_data: string; // 계수 계산기 설정의 스냅샷 JSON 텍스트
}

export interface UpdateNoticeSection {
    badge?: string;
    badgeColor?: 'purple' | 'orange' | 'blue' | 'green' | 'teal' | 'red' | 'amber';
    title: string;
    description: string;
    items?: string[];
    image?: string;
    imageCaption?: string;
}

export interface UpdateNoticeData {
    version: string;
    title: string;
    date: string;
    summary: string;
    sections: UpdateNoticeSection[];
    images?: string[];
}

export interface ChatLogValidationResult {
    valid: boolean;
    exists: boolean;
    isDirectory: boolean;
    fileCount: number;
    latestFile?: string;
    suggestedPath?: string;
    message: string;
}

