import sidebarMenuData from '../assets/data/sidebar_menus.json';

export const SIDEBAR_MENU_ACTIONS = [
  'openGallery',
  'toggleTrade',
  'toggleShoutHistory',
  'toggleFocusedChat',
  'toggleWordAlarm',
  'toggleDiscordAlarm',
  'toggleCustomAlert',
  'toggleAbbreviation',
  'toggleEquipmentDic',
  'toggleBuffs',
  'toggleCoefficientCalculator',
  'toggleEvolutionCalculator',
  'toggleThesisCoreCalculator',
  'toggleMagicStoneCalculator',
  'toggleHuntingExpCalculator',
  'toggleRelicCalculator',
  'toggleEquipmentSimulator',
  'toggleSienaAura',
  'toggleUniformColor',
  'toggleSwordEnhance',
  'toggleQteChallenge',
  'toggleScamDetector',
  'toggleEtaRanking',
  'toggleHuntingPathSimulator',
  'toggleXpHud',
  'toggleContentsChecker',
  'toggleDiary',
  'toggleStopwatch',
  'toggleBossSettings',
  'toggleBuffTimer',
  'goHome',
  'toggleOverlay',
  'toggleChatOverlay',
  'toggleClickThrough',
  'toggleWelcomeGuide',
] as const;

export type SidebarMenuAction = typeof SIDEBAR_MENU_ACTIONS[number];

export interface SidebarMenuDefinition {
  id: string;
  label: string;
  icon: string;
  tooltip: string;
  color: string;
  category?: string;
  api?: SidebarMenuAction;
  action?: SidebarMenuAction;
  image?: string;
  isOneDepth?: boolean;
  isSystem?: boolean;
}

const actionSet = new Set<string>(SIDEBAR_MENU_ACTIONS);

function validateSidebarMenus(value: unknown): readonly SidebarMenuDefinition[] {
  if (!Array.isArray(value)) throw new Error('사이드바 메뉴 데이터는 배열이어야 합니다.');

  const ids = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`사이드바 메뉴 ${index + 1}번 항목이 객체가 아닙니다.`);
    }

    const menu = item as Record<string, unknown>;
    for (const field of ['id', 'label', 'icon', 'tooltip', 'color'] as const) {
      if (typeof menu[field] !== 'string' || menu[field].length === 0) {
        throw new Error(`사이드바 메뉴 ${index + 1}번 항목의 ${field} 값이 올바르지 않습니다.`);
      }
    }

    if (ids.has(menu.id as string)) throw new Error(`중복된 사이드바 메뉴 ID입니다: ${menu.id}`);
    ids.add(menu.id as string);

    const action = menu.api ?? menu.action;
    if (typeof action !== 'string' || !actionSet.has(action)) {
      throw new Error(`지원하지 않는 사이드바 메뉴 동작입니다: ${String(action)}`);
    }

    return Object.freeze(menu) as unknown as SidebarMenuDefinition;
  }));
}

/** 사이드바, 독, 설정, 트레이가 함께 사용하는 메뉴 메타데이터의 단일 원본입니다. */
export const SIDEBAR_MENUS = validateSidebarMenus(sidebarMenuData);

export function getSidebarMenuAction(menu: SidebarMenuDefinition): SidebarMenuAction {
  return (menu.api ?? menu.action)!;
}
