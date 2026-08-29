/**
 * 기능 계약 — 오늘 요약 HUD 데이터 조립
 *
 * - 이 모듈은 채팅 로그를 다시 해석하지 않고, 모험일지 DB에서 조회한 해당 날짜 활동과 현재 숙제
 *   설정을 읽기 전용으로 요약합니다. 원본 기록 누락을 여기서 추정값으로 보정하지 않습니다.
 * - SEED·ELSO·보스·득템은 activity type별로 합산합니다. 경험의 정수는 일반 득템 키워드 등록 여부와
 *   무관하게 loot 활동의 실제 수량을 합산하되, 일반 득템 수·종류·목록에는 다시 포함하지 않는
 *   별도 지표입니다. 요약 HUD에서 전용 합계와 일반 득템 목록에 이중 표시하지 않습니다.
 * - 아이템 이름은 현재 형식과 과거 `[득템]` 저장 형식을 모두 읽을 수 있어야 합니다. 저장 문자열
 *   형식을 바꿀 때는 모험일지 조회와 이 호환 파서를 함께 검증해야 합니다.
 * - 숙제는 현재 선택 캐릭터의 표시/제외/완료 상태를 사용하고, 남은 항목은 HUD 공간 때문에 최대
 *   `MAX_REMAINING_HOMEWORK_ITEMS`개만 반환합니다. 원본 숙제 상태나 순서는 변경하지 않습니다.
 */
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
        continue;
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
