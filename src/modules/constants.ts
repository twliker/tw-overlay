/**
 * 앱 전역 상수 정의
 */
import * as path from 'path';
import * as fs from 'fs';

function getElectronApp(): Electron.App | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    return electron?.app || (electron?.remote ? electron.remote.app : null);
  } catch {
    return null;
  }
}

// 타입은 shared/types.ts에서 통합 관리 (preload.ts와 공유)
export { QuickSlotItem, WatchedPost, WindowPosition, GameRect, GameNotRunning, GameError, GameQueryResult, BossSetting, AppConfig, GalleryPost, GalleryActivity, UpdateStatusInfo, TradePost, TradeActivity, MAIN_CHAR_ID, DEFAULT_CHAR_NAME } from '../shared/types';
import type { AppConfig } from '../shared/types';
import { DEFAULT_HUD_POSITIONS, DEFAULT_WINDOW_POSITIONS } from '../shared/windowPositions';
const chatChannels = require('../shared/chatChannels') as ChatChannelConstants;
const huntingExpDefaults = require('../shared/huntingExpCalculator') as {
  DEFAULT_DOPINGS: NonNullable<AppConfig['huntingExpDopings']>;
  DEFAULT_GROUNDS: NonNullable<AppConfig['huntingExpGrounds']>;
};

// 테일즈위버 실제 프로세스 명 (확장자 제외)
export const GAME_PROCESS_NAME = 'InphaseNXD';
export const IS_DEV = (() => {
  if (process.argv.includes('--dev')) return true;
  const electronApp = getElectronApp();
  return electronApp ? !electronApp.isPackaged : false;
})();
export const MIN_W = 400;
export const MIN_H = 300;
export const LOG_MAX_SIZE = 1 * 1024 * 1024; // 1MB
export const SAVE_DEBOUNCE_MS = 300;
export const POLLING_FAST_MS = 100;
export const POLLING_STABLE_MS = 1000;
export const POLLING_MINIMIZED_MS = 2000;
export const POLLING_IDLE_MS = 3000;
export const STABLE_THRESHOLD_COUNT = 10;
export const SIDEBAR_HEIGHT = 800;
export const SIDEBAR_WIDTH = 400;
export const OVERLAY_TOOLBAR_HEIGHT = 70;

// --- 매직 넘버 상수화 ---
/** 창 좌표가 이 값 이하이면 최소화 상태로 판정 */
export const WINDOW_MINIMIZED_THRESHOLD = -10000;
/** 윈도우 이벤트 처리 디바운스 시간(ms) */
export const EVENT_DEBOUNCE_MS = 16;
/** 위치 변경 감지 임계값(px) — 이 값 이하의 차이는 무시 */
export const POSITION_THRESHOLD = 2;
/** 마우스 투과 전환 후 게임 포커스까지 지연시간(ms) */
export const FOCUS_DELAY_MS = 50;
/** 창 닫기 후 게임 포커스 복구까지 지연시간(ms) — OS 포커스 재배치 완료 대기 */
export const FOCUS_RESTORE_DELAY_MS = 100;
/** GetWindowTextW 호출용 타이틀 버퍼 길이 */
export const TITLE_BUFFER_LENGTH = 256;

export const get_CONFIG_PATH = () => {
  const electronApp = getElectronApp();
  const appData = electronApp ? electronApp.getPath('appData') : (process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'));
  const targetDir = path.join(appData, 'twOverlay');
  if (!fs.existsSync(targetDir)) {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
  }
  return path.join(targetDir, 'config.json');
};

export const get_LOG_PATH = () => {
  const electronApp = getElectronApp();
  const appData = electronApp ? electronApp.getPath('appData') : (process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'));
  const targetDir = path.join(appData, 'twOverlay');
  if (!fs.existsSync(targetDir)) {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
  }
  return path.join(targetDir, 'debug.log');
};

/** 리소스 경로 유틸리티 (dist 폴더 기준) */
export const get_RESOURCE_PATH = (...paths: string[]) => {
  const electronApp = getElectronApp();
  const basePath = electronApp ? electronApp.getAppPath() : path.join(__dirname, '..');
  return path.join(basePath, 'dist', ...paths);
};

export const get_CONTENTS_DATA_PATH = () => get_RESOURCE_PATH('assets', 'data', 'contents.json');

export const DEFAULT_CONFIG: AppConfig = {
  width: 800, height: 600, opacity: 1.0,
  url: 'https://www.youtube.com',
  homeUrl: 'https://www.youtube.com',
  overlayVisible: false,
  galleryNotify: false,
  diaryKeepDays: 180,
  customSounds: [],
  quickSlots: [
    {
      label: "테일즈 가이드 요약",
      icon: "BookOpenCheck",
      url: "https://gall.dcinside.com/mini/board/view/?id=talesweaver&no=209726",
      external: true,
      iconType: "icon"
    },
    {
      label: "TW DB",
      icon: "database",
      url: "https://twhome-git.github.io/TWPage/",
      external: true,
      iconType: "icon"
    }
  ],
  quickSlotsMigratedV2: true,
  autoUpdateEnabled: true,
  lastNoticeVersion: '',
  fieldBossNotifyEnabled: true,
  fieldBossNotifyOffsets: [5],
  fieldBossNotifyVolume: 30,
  fieldBossSettings: {
    '골론': { name: '골론', enabled: true, soundFile: 'orb.mp3' },
    '파멸의 기원': { name: '파멸의 기원', enabled: true, soundFile: 'orb.mp3' },
    '스페르첸드': { name: '스페르첸드', enabled: true, soundFile: 'orb.mp3' },
    '골모답': { name: '골모답', enabled: true, soundFile: 'orb.mp3' },
    '아칸': { name: '아칸', enabled: true, soundFile: 'orb.mp3' },
    '혼란한 대지': { name: '혼란한 대지', enabled: true, soundFile: 'orb.mp3' },
  },
  notifyWhenGameClosed: false,
  positions: { ...DEFAULT_WINDOW_POSITIONS },
  tradeServer: 'RyXp',
  tradeKeywords: [],
  tradeNotify: true,
  gameExitReminderEnabled: false,
  gameExitReminderMessage: '',
  contentsCheckerItems: [],
  lastContentsResetCheck: 0,
  shortcuts: {
    toggleClickThrough: 'CommandOrControl+Shift+T',
    toggleContentsChecker: 'CommandOrControl+Shift+C',
    toggleBuffHud: 'CommandOrControl+Shift+B',
    toggleTodaySummaryHud: 'CommandOrControl+Shift+Y',
    toggleAbandonedHud: 'CommandOrControl+Shift+A',
    toggleDock: 'CommandOrControl+Shift+D',
    toggleChatOverlaySync: 'CommandOrControl+Shift+H',
    resetXpSession: 'CommandOrControl+Shift+X',
    toggleXpSession: 'CommandOrControl+Shift+Z',
    clearAllBuffs: 'CommandOrControl+Shift+E',
    toggleTimer: 'CommandOrControl+Shift+S'
  },
  volumeContentsChecker: 30,
  volumeCalculators: 30,
  sidebarPosition: 'right',
  showSidebarToastOnOverlay: false,
  chatLogPath: '',
  lootKeywords: [],
  shoutKeywords: [],
  wordAlarmEnabled: true,
  wordAlarmKeywords: [],
  wordAlarmSound: 'orb.mp3',
  wordAlarmVolume: 40,
  wordAlarmHistoryEnabled: true,
  showXpWidget: true,
  xpAutoStart: true,
  ignoreNegativeXp: true,
  xpWidgetPos: { ...DEFAULT_HUD_POSITIONS.xp },
  showTodaySummaryHud: true,
  todaySummaryCollapsed: true,
  todaySummaryHudPos: { ...DEFAULT_HUD_POSITIONS.todaySummary },
  huntingExpDopings: huntingExpDefaults.DEFAULT_DOPINGS.map(item => ({ ...item })),
  huntingExpGrounds: huntingExpDefaults.DEFAULT_GROUNDS.map(item => ({ ...item })),
  huntingExpSelectedGroundId: 'forge',
  huntingExpKillsPerHour: 40_000,
  huntingExpHappyHour: true,
  buffTimerEnabled: true,
  showBuffHud: true,
  showHudShortcuts: true,
  buffTimerWarnSeconds: [60, 10],
  buffTimerVisualAlert: true,
  buffTimerAudioAlert: true,
  buffTimerVolume: 40,
  buffTimerBuffs: {
    'exp_heart': true,
    'rare_heart': true,
    'stat_exorcist': true,
    'stat_sami_sunryeong': true,
    'rare_loto': true,
    'util_ampoule': true,
    'dmg_izabel': true,
    'util_illumination': true,
    'insight_elixir_large': true,
    'insight_elixir_special': true,
    'exp_eos_supreme': true,
    'exp_sweetpotato_legend': true,
    'exp_earlybird': true,
  },
  buffTimerCenterAlert: true,
  buffTimerHudPos: { ...DEFAULT_HUD_POSITIONS.buffTimer },
  essenceAlertEnabled: true,
  essenceAlertSound: 'orb.mp3',
  essenceAlertVolume: 40,
  specialMonsterAlertEnabled: true,
  abandonedAlertEnabled: true,
  pittaHillAlertEnabled: true,
  questCompleteAlertEnabled: true,
  abandonedAutoHideMinutes: 10,
  abandonedEnabled: true,
  abandonedWidgetPos: { ...DEFAULT_HUD_POSITIONS.abandoned },
  abyssApostleAlertEnabled: false,
  abyssApostleStartSound: '제2사도_반사_패턴_시작.mp3',
  abyssApostleEndSound: '제2사도_반사_패턴_종료.mp3',
  abyssApostleVolume: 40,
  ethosAlertEnabled: false,
  ethosAlertSound: '에코스_기믹_알림.mp3',
  ethosAlertVolume: 40,
  lokagosAlertEnabled: false,
  lokagosAlertSound: '로카고스_기믹_알림.mp3',
  lokagosAlertVolume: 40,
  waveMonsterWarningEnabled: true,
  waveMonsterWarningSound: 'orb.mp3',
  waveMonsterWarningVolume: 40,
  discordWebhookUrl: '',
  discordAlertEnabled: false,
  discordKeywords: [],
  discordRules: [],
  chatOverlayEnabled: false,
  autoOpenContentsChecker: false,
  contentsCheckerEnabled: false,
  chatOverlaySubEnabled: false, // 신규 추가
  chatOverlaySub2Enabled: false,
  chatOverlayOpacity: 0.8,
  chatOverlaySubOpacity: 0.8,
  chatOverlaySub2Opacity: 0.8,
  chatOverlayFontSize: 14,
  chatOverlayClickThrough: true,
  chatOverlayKeywords: [],
  userServer: 7,
  etaDataUrl: '',
  chatOverlayWidth: 450,
  chatOverlayHeight: 400,
  focusedChatWidth: 460,
  focusedChatHeight: 720,
  chatOverlaySelectedChannels: [...chatChannels.OVERLAY_CHANNELS],
  chatOverlaySubWidth: 450,
  chatOverlaySubHeight: 400,
  chatOverlayTab: 'Basic',
  chatOverlaySubTab: 'Basic',
  chatOverlaySub2Width: 450,
  chatOverlaySub2Height: 400,
  chatOverlaySub2Tab: 'Basic',
  chatOverlayShowNpcChat: true,
  chatOverlayBlacklistFilters: [],
  chatOverlayShowXpGain: false,
  chatOverlayShowElsoGain: false,
  chatOverlayHighlightScamNicknames: true,
  chatOverlayCustomTabs: [],
  chatOverlayColorGeneral: chatChannels.OVERLAY_COLORS.general,
  chatOverlayColorWhisper: chatChannels.OVERLAY_COLORS.whisper,
  chatOverlayColorTeam: chatChannels.OVERLAY_COLORS.team,
  chatOverlayColorClub: chatChannels.OVERLAY_COLORS.club,
  chatOverlayColorShout: chatChannels.OVERLAY_COLORS.shout,
  chatOverlayNicknameColorMode: 'same',
  chatOverlayNicknameColorGeneral: chatChannels.COLORS.nickname,
  chatOverlayNicknameColorWhisper: chatChannels.COLORS.nickname,
  chatOverlayNicknameColorTeam: chatChannels.COLORS.nickname,
  chatOverlayNicknameColorClub: chatChannels.COLORS.nickname,
  chatOverlayNicknameColorShout: chatChannels.COLORS.nickname,
  focusedChatSelfNickname: '',
  forgeQuestHudPos: { ...DEFAULT_HUD_POSITIONS.quest },
};

/** 앱 전역 공유 상태 (any 캐스팅 대체) */
export const appState = { isQuitting: false };
