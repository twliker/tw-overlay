import type { HudPosition, WindowPosition, WindowPositionKey } from './types';

export type HudPositionConfigKey =
  | 'xpWidgetPos'
  | 'buffTimerHudPos'
  | 'abandonedWidgetPos'
  | 'digsiteWidgetPos'
  | 'forgeQuestHudPos';

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
  evolutionCalculator: { offsetX: -1040, offsetY: 40 },
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
export const DEFAULT_HUD_POSITIONS: Record<'xp' | 'buffTimer' | 'abandoned' | 'digsite' | 'quest' | 'todaySummary', HudPosition> = {
  xp: { left: 200, bottom: 0 },
  buffTimer: { left: 350, bottom: 0 },
  abandoned: { left: 200, bottom: 63 },
  digsite: { left: 0, bottom: 326 },
  quest: { left: 50, bottom: 215 },
  todaySummary: { left: 0, top: 200 },
};

const BOTTOM_HUD_DEFAULTS: Record<HudPositionConfigKey, HudPosition> = {
  xpWidgetPos: DEFAULT_HUD_POSITIONS.xp,
  buffTimerHudPos: DEFAULT_HUD_POSITIONS.buffTimer,
  abandonedWidgetPos: DEFAULT_HUD_POSITIONS.abandoned,
  digsiteWidgetPos: DEFAULT_HUD_POSITIONS.digsite,
  forgeQuestHudPos: DEFAULT_HUD_POSITIONS.quest,
};

/**
 * 3.1.0의 HUD 위치 편집 중 일반 설정을 적용하면, 비활성 HUD가 먼저 `display:none`으로
 * 돌아간 뒤 위치 저장이 실행될 수 있었습니다. 이때 DOM rect가 모두 0이 되어 설정에는
 * `{ left: 0, bottom: 당시 게임 화면 높이 }`가 기록되고 HUD가 화면 위로 사라졌습니다.
 *
 * 과거 게임 화면 높이는 설정에 남지 않으므로 정상 사용자 좌표를 최대한 보존하기 위해
 * 버그 고유 형태인 `left === 0`과 일반적인 게임 viewport 최소 높이 이상의 `bottom`이
 * 동시에 나타난 하단 기준 HUD만 복구합니다. 상단 기준 오늘 요약 HUD와 정상 범위 좌표는
 * 변경하지 않으며, config의 1회 마이그레이션 센티널과 함께 사용합니다.
 */
export function repairLegacyHiddenHudPositions(config: Record<string, unknown>): HudPositionConfigKey[] {
  const repaired: HudPositionConfigKey[] = [];
  for (const [key, defaultPosition] of Object.entries(BOTTOM_HUD_DEFAULTS) as Array<[HudPositionConfigKey, HudPosition]>) {
    const position = config[key];
    if (!position || typeof position !== 'object' || Array.isArray(position)) continue;
    const candidate = position as Record<string, unknown>;
    if (candidate.left !== 0
      || typeof candidate.bottom !== 'number'
      || !Number.isFinite(candidate.bottom)
      || candidate.bottom < 480) continue;
    config[key] = { ...defaultPosition };
    repaired.push(key);
  }
  return repaired;
}

export function copyDefaultWindowPosition(key: WindowPositionKey): WindowPosition {
  return { ...DEFAULT_WINDOW_POSITIONS[key] };
}
