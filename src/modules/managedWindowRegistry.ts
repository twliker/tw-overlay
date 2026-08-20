import type { BrowserWindow } from 'electron';
import type { GameRect, WindowPosition } from './constants';
import type { WindowPositionKey } from '../shared/types';
import { copyDefaultWindowPosition } from '../shared/windowPositions';

export interface ManagedWindow {
  ref: BrowserWindow | null;
  pos: WindowPosition;
  key: WindowPositionKey;
  html: string;
  width: number;
  height: number;
  skipTaskbar?: boolean;
  onOpen?: (win: BrowserWindow) => void;
  onClose?: () => void;
  calcPosition?: (gameRect: GameRect, pos: WindowPosition) => { x: number; y: number };
}

type StaticWindowDefinition = Omit<ManagedWindow, 'ref' | 'pos'>;

const STATIC_WINDOW_DEFINITIONS: readonly StaticWindowDefinition[] = [
  { key: 'settings', html: 'settings.html', width: 1100, height: 720 },
  { key: 'gallery', html: 'gallery.html', width: 450, height: 600 },
  { key: 'abbreviation', html: 'abbreviation.html', width: 540, height: 720 },
  { key: 'equipmentDic', html: 'equipment-dic.html', width: 1120, height: 800 },
  { key: 'buffs', html: 'buffs.html', width: 1080, height: 740 },
  { key: 'bossSettings', html: 'boss-settings.html', width: 460, height: 780 },
  { key: 'etaRanking', html: 'eta-ranking.html', width: 400, height: 600 },
  { key: 'trade', html: 'trade.html', width: 450, height: 600 },
  { key: 'coefficientCalculator', html: 'coefficient-calculator.html', width: 1420, height: 860 },
  { key: 'contentsChecker', html: 'contents-checker.html', width: 400, height: 1200 },
  { key: 'focusedChat', html: 'focused-chat.html', width: 460, height: 720 },
  { key: 'evolutionCalculator', html: 'evolution-calculator.html', width: 600, height: 720 },
  { key: 'thesisCoreCalculator', html: 'thesis-core-calculator.html', width: 850, height: 880 },
  { key: 'magicStoneCalculator', html: 'magic-stone-calculator.html', width: 400, height: 800 },
  { key: 'customAlert', html: 'custom-alert.html', width: 580, height: 640 },
  { key: 'diary', html: 'diary.html', width: 1400, height: 920 },
  { key: 'uniformColor', html: 'uniform-color.html', width: 360, height: 800 },
  { key: 'swordEnhance', html: 'sword-enhance.html', width: 1300, height: 850 },
  { key: 'shoutHistory', html: 'shout-history.html', width: 450, height: 600 },
  { key: 'gameOverlay', html: 'game-overlay.html', width: 0, height: 0 },
  { key: 'buffTimer', html: 'buff-timer.html', width: 900, height: 850 },
  { key: 'xpHud', html: 'xp-hud.html', width: 420, height: 1050 },
  { key: 'scamDetector', html: 'scam-detector.html', width: 480, height: 780 },
  { key: 'sienaAura', html: 'siena-aura.html', width: 1230, height: 930 },
  { key: 'wordAlarm', html: 'word-alarm.html', width: 450, height: 950 },
  { key: 'discordAlarm', html: 'discord-alarm.html', width: 450, height: 950 },
  { key: 'huntingPathSimulator', html: 'hunting-path-simulator.html', width: 860, height: 800 },
  { key: 'huntingExpCalculator', html: 'hunting-exp-calculator.html', width: 940, height: 780 },
  { key: 'relicCalculator', html: 'relic-calculator.html', width: 920, height: 760 },
  { key: 'equipmentSimulator', html: 'equipment-simulator.html', width: 960, height: 820 },
  { key: 'stopwatch', html: 'stopwatch.html', width: 870, height: 750 },
  { key: 'chatOverlay', html: 'chat-overlay.html', width: 450, height: 400, skipTaskbar: true },
  { key: 'chatOverlaySub', html: 'chat-overlay.html', width: 450, height: 400, skipTaskbar: true },
  { key: 'chatOverlaySub2', html: 'chat-overlay.html', width: 450, height: 400, skipTaskbar: true },
  { key: 'dock', html: 'dock.html', width: 800, height: 380 },
];

/** 새 런타임 상태를 가진 창 레지스트리를 생성합니다. */
export function createManagedWindowRegistry(): Record<string, ManagedWindow> {
  return Object.fromEntries(STATIC_WINDOW_DEFINITIONS.map(definition => [
    definition.key,
    {
      ...definition,
      ref: null,
      pos: copyDefaultWindowPosition(definition.key),
    },
  ]));
}

export const MANAGED_WINDOW_COUNT = STATIC_WINDOW_DEFINITIONS.length;
