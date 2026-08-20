import * as wm from './windowManager';
import type { SidebarMenuAction } from '../shared/sidebarMenus';

type TrayMenuHandler = () => void;
type TrayMenuAction = Exclude<SidebarMenuAction, 'goHome'>;

const TRAY_MENU_ACTIONS = {
  openGallery: wm.toggleGalleryWindow,
  toggleTrade: wm.toggleTradeWindow,
  toggleShoutHistory: wm.toggleShoutHistoryWindow,
  toggleFocusedChat: wm.toggleFocusedChatWindow,
  toggleWordAlarm: wm.toggleWordAlarmWindow,
  toggleDiscordAlarm: wm.toggleDiscordAlarmWindow,
  toggleCustomAlert: wm.toggleCustomAlertWindow,
  toggleAbbreviation: wm.toggleAbbreviationWindow,
  toggleEquipmentDic: wm.toggleEquipmentDicWindow,
  toggleBuffs: wm.toggleBuffsWindow,
  toggleCoefficientCalculator: wm.toggleCoefficientCalculatorWindow,
  toggleEvolutionCalculator: wm.toggleEvolutionCalculatorWindow,
  toggleThesisCoreCalculator: wm.toggleThesisCoreCalculatorWindow,
  toggleMagicStoneCalculator: wm.toggleMagicStoneCalculatorWindow,
  toggleHuntingExpCalculator: wm.toggleHuntingExpCalculatorWindow,
  toggleRelicCalculator: wm.toggleRelicCalculatorWindow,
  toggleEquipmentSimulator: wm.toggleEquipmentSimulatorWindow,
  toggleSienaAura: wm.toggleSienaAuraWindow,
  toggleUniformColor: wm.toggleUniformColorWindow,
  toggleSwordEnhance: wm.toggleSwordEnhanceWindow,
  toggleScamDetector: wm.toggleScamDetectorWindow,
  toggleEtaRanking: wm.toggleEtaRankingWindow,
  toggleHuntingPathSimulator: wm.toggleHuntingPathSimulatorWindow,
  toggleXpHud: wm.toggleXpHudWindow,
  toggleContentsChecker: wm.toggleContentsCheckerWindow,
  toggleDiary: wm.toggleDiaryWindow,
  toggleStopwatch: wm.toggleStopwatchWindow,
  toggleBossSettings: wm.toggleBossSettingsWindow,
  toggleBuffTimer: wm.toggleBuffTimerWindow,
  toggleOverlay: wm.toggleOverlay,
  toggleChatOverlay: wm.toggleChatOverlayWindow,
  toggleClickThrough: wm.toggleClickThrough,
  toggleWelcomeGuide: wm.toggleWelcomeGuideWindow,
} satisfies Record<TrayMenuAction, TrayMenuHandler>;

export function getTrayMenuHandler(action: SidebarMenuAction): TrayMenuHandler | undefined {
  if (action === 'goHome') return undefined;
  return TRAY_MENU_ACTIONS[action];
}
