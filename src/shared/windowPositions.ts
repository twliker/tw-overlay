import type { HudPosition, WindowPosition, WindowPositionKey } from './types';

/** Electron 창 위치의 단일 기본값 원본입니다. */
export const DEFAULT_WINDOW_POSITIONS: Record<WindowPositionKey, WindowPosition> = {
  overlay: { offsetX: 10, offsetY: 10 },
  settings: { offsetX: -1110, offsetY: 40 },
  gallery: { offsetX: -450, offsetY: 40 },
  abbreviation: { offsetX: -550, offsetY: 40 },
  equipmentDic: { offsetX: -1120, offsetY: 40 },
  buffs: { offsetX: -1080, offsetY: 40 },
  bossSettings: { offsetX: -460, offsetY: 40 },
  etaRanking: { offsetX: -400, offsetY: 40 },
  trade: { offsetX: -450, offsetY: 40 },
  coefficientCalculator: { offsetX: -1430, offsetY: 40 },
  contentsChecker: { offsetX: -400, offsetY: 40 },
  focusedChat: { offsetX: -470, offsetY: 40 },
  evolutionCalculator: { offsetX: -580, offsetY: 40 },
  thesisCoreCalculator: { offsetX: -850, offsetY: 40 },
  magicStoneCalculator: { offsetX: -400, offsetY: 40 },
  customAlert: { offsetX: -580, offsetY: 40 },
  diary: { offsetX: -850, offsetY: 40 },
  uniformColor: { offsetX: -360, offsetY: 40 },
  swordEnhance: { offsetX: -1300, offsetY: 40 },
  qteChallenge: { offsetX: -980, offsetY: 40 },
  shoutHistory: { offsetX: -460, offsetY: 40 },
  gameOverlay: { offsetX: 0, offsetY: 0 },
  buffTimer: { offsetX: -900, offsetY: 40 },
  xpHud: { offsetX: -420, offsetY: 40 },
  scamDetector: { offsetX: -480, offsetY: 40 },
  sienaAura: { offsetX: -900, offsetY: 40 },
  wordAlarm: { offsetX: -450, offsetY: 40 },
  discordAlarm: { offsetX: -450, offsetY: 40 },
  huntingPathSimulator: { offsetX: -860, offsetY: 40 },
  huntingExpCalculator: { offsetX: -940, offsetY: 40 },
  relicCalculator: { offsetX: -920, offsetY: 40 },
  equipmentSimulator: { offsetX: -960, offsetY: 40 },
  stopwatch: { offsetX: -870, offsetY: 40 },
  chatOverlay: { offsetX: -460, offsetY: 450 },
  chatOverlaySub: { offsetX: -460, offsetY: 240 },
  chatOverlaySub2: { offsetX: -460, offsetY: 40 },
  dock: { offsetX: 0, offsetY: 0 },
};

/** 게임 오버레이 내부 HUD 위치의 단일 기본값 원본입니다. */
export const DEFAULT_HUD_POSITIONS: Record<'xp' | 'buffTimer' | 'abandoned' | 'quest' | 'todaySummary', HudPosition> = {
  xp: { left: 200, bottom: 0 },
  buffTimer: { left: 350, bottom: 0 },
  abandoned: { left: 200, bottom: 63 },
  quest: { left: 50, bottom: 215 },
  todaySummary: { left: 0, top: 200 },
};

export function copyDefaultWindowPosition(key: WindowPositionKey): WindowPosition {
  return { ...DEFAULT_WINDOW_POSITIONS[key] };
}
