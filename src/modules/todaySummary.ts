import type {
  AppConfig,
  DiaryData,
  TodaySummary,
  TodaySummaryHomeworkItem,
} from '../shared/types';
import { DEFAULT_CHAR_NAME, MAIN_CHAR_ID } from '../shared/types';
import { parseItemAcquisition } from './itemAcquisition';
import { formatLocalDateKey } from '../shared/localDate';
import { countsTowardLootTotal } from '../shared/lootPolicy';

const MAX_REMAINING_HOMEWORK_ITEMS = 5;

export function getLocalDateKey(now = new Date()): string {
  return formatLocalDateKey(now);
}

const LOOT_NAME_CACHE = new Map<string, string>();

function getLootName(content: string): string {
  const cached = LOOT_NAME_CACHE.get(content);
  if (cached !== undefined) return cached;

  const message = content.replace(/^\[득템\]\s*/, '').trim();
  const simpleMatch = message.match(/^\[([^\]]+)\](?:\s*\[?\d+\]?개)?$/);
  let parsedName = '';

  if (simpleMatch) {
    parsedName = simpleMatch[1].trim();
  } else {
    const acquisition = parseItemAcquisition(message, { isSelfChat: true });
    parsedName = acquisition?.itemName
      || message.replace(/\s+(?:아이템)?(?:을\(를\)|을|를).*$/, '');
    parsedName = parsedName
      .normalize('NFC')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
      .replace(/[\s\u00A0]+/gu, ' ')
      .replace(/\s+\[?[\d,]+\]?개$/u, '')
      .replace(/^\[+|\]+$/gu, '')
      .trim();
  }

  if (LOOT_NAME_CACHE.size > 2000) LOOT_NAME_CACHE.clear();
  LOOT_NAME_CACHE.set(content, parsedName);
  return parsedName;
}

/** 기존 모험일지와 숙제 체크리스트 상태를 game-overlay용 간략 요약으로 변환합니다. */
export function buildTodaySummary(
  cfg: AppConfig,
  diaryData: DiaryData,
  date = getLocalDateKey(),
): TodaySummary {
  let totalSeed = 0;
  let totalElso = 0;
  let totalEssence = 0;
  let bossKills = 0;
  let totalLootCount = 0;
  const lootCounts = new Map<string, number>();

  for (const activity of diaryData.activityLogs || []) {
    const amount = Number.isFinite(activity.amount) ? activity.amount : 0;
    if (activity.type === 'calc') totalSeed += amount;
    else if (activity.type === 'elso') totalElso += amount;
    else if (activity.type === 'boss') bossKills++;
    else if (activity.type === 'loot') {
      const count = amount > 0 ? amount : 1;
      const name = getLootName(activity.content);
      if (!name) continue;
      if (name === '경험의 정수') {
        totalEssence += count;
      }
      if (countsTowardLootTotal(name)) totalLootCount += count;
      lootCounts.set(name, (lootCounts.get(name) || 0) + count);
    }
  }

  const presets = cfg.characterPresets?.length
    ? cfg.characterPresets
    : [{ id: MAIN_CHAR_ID, name: DEFAULT_CHAR_NAME }];
  const selectedCharacter = presets.find(character => character.id === cfg.selectedCharacterId)
    || presets[0];
  const homeworkItems = (cfg.contentsCheckerItems || []).filter(item => {
    const state = item.completedState?.[selectedCharacter.id];
    return item.isVisible !== false && !state?.isExcluded;
  });
  const completedCount = homeworkItems.filter(item => (
    item.completedState?.[selectedCharacter.id]?.isCompleted
  )).length;
  const remainingItems: TodaySummaryHomeworkItem[] = homeworkItems
    .filter(item => !item.completedState?.[selectedCharacter.id]?.isCompleted)
    .slice(0, MAX_REMAINING_HOMEWORK_ITEMS)
    .map(item => ({
      name: item.name,
      category: item.category,
      type: item.resetRule.type,
      currentCount: item.completedState?.[selectedCharacter.id]?.currentCount || 0,
      maxCount: item.maxCount || 1,
    }));

  return {
    date,
    totalSeed,
    totalElso,
    totalEssence,
    bossKills,
    totalLootCount,
    lootItems: [...lootCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'ko')),
    homework: {
      characterName: selectedCharacter.name,
      completedCount,
      totalCount: homeworkItems.length,
      remainingCount: homeworkItems.length - completedCount,
      remainingItems,
    },
  };
}
