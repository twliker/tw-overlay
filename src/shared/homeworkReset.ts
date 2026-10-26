/**
 * 숙제 리셋 계산 순수 유틸리티 모듈
 * contentsChecker 및 profileManager 양쪽에서 순환 참조 없이 재사용합니다.
 */
import { ContentsCheckerItem, ResetRule } from './types';

export interface HomeworkResetResult {
  items: ContentsCheckerItem[];
  resetEntries: Array<{ itemName: string; characterId: string; resetType: ResetRule['type'] }>;
}

const cloneItems = (items: ContentsCheckerItem[] | undefined): ContentsCheckerItem[] => structuredClone(items || []);

/** 특정 규칙에 따라 초기화 여부 판단 (직전 리셋 시점 기준 안전 판정) */
export function shouldReset(rule: ResetRule, lastCompleted: Date, now: Date): boolean {
  const resetHour = rule.hour ?? 0;

  if (rule.type === 'daily') {
    // 현재 시점(now) 기준 가장 최근에 지난 일일 리셋 시점 계산
    const mostRecentReset = new Date(now);
    mostRecentReset.setHours(resetHour, 0, 0, 0);

    // 아직 오늘의 리셋 시각에 도달하지 않은 경우 어제의 리셋 시각이 기준
    if (now < mostRecentReset) {
      mostRecentReset.setDate(mostRecentReset.getDate() - 1);
    }

    // 마지막 완료 시점이 직전 리셋 시점 이전이면 초기화 대상
    return lastCompleted < mostRecentReset;
  }

  if (rule.type === 'weekly') {
    const resetDay = rule.dayOfWeek ?? 1; // 기본 월요일 (1)

    // 현재 시점(now) 기준 가장 최근에 지난 주간 리셋 시점 계산
    const mostRecentReset = new Date(now);
    mostRecentReset.setHours(resetHour, 0, 0, 0);

    // 요일 차이 계산 (0 ~ 6)
    const dayDiff = (now.getDay() - resetDay + 7) % 7;
    mostRecentReset.setDate(mostRecentReset.getDate() - dayDiff);

    // 요일은 같으나 아직 오늘의 resetHour 이전인 경우 지난주(7일 전)가 직전 리셋 시점
    if (dayDiff === 0 && now < mostRecentReset) {
      mostRecentReset.setDate(mostRecentReset.getDate() - 7);
    }

    // 마지막 완료 시점이 직전 주간 리셋 시점 이전이면 초기화 대상
    return lastCompleted < mostRecentReset;
  }

  return false;
}

/** 저장 부작용 없이 지난 리셋 주기의 완료 상태를 현재 주기로 정규화한다. */
export function resetExpiredHomeworkItems(
  sourceItems: ContentsCheckerItem[] | undefined,
  nowTimestamp: number = Date.now(),
): HomeworkResetResult {
  const items = cloneItems(sourceItems);
  const now = new Date(nowTimestamp);
  const resetEntries: HomeworkResetResult['resetEntries'] = [];

  for (const item of items) {
    for (const [characterId, state] of Object.entries(item.completedState || {})) {
      if (!state.isCompleted && !(state.currentCount && state.currentCount > 0)) continue;
      const lastCompleted = state.lastCompletedAt ? new Date(state.lastCompletedAt) : new Date(0);
      if (!shouldReset(item.resetRule, lastCompleted, now)) continue;

      state.isCompleted = false;
      state.lastCompletedAt = undefined;
      state.currentCount = 0;
      resetEntries.push({
        itemName: item.name,
        characterId,
        resetType: item.resetRule.type,
      });
    }
  }

  return { items, resetEntries };
}

/** 현재 시각 뒤 가장 먼저 도착할 숙제 리셋 경계를 반환한다. */
export function getNextHomeworkResetAt(
  items: ContentsCheckerItem[],
  nowTimestamp: number = Date.now(),
): number | undefined {
  const now = new Date(nowTimestamp);
  let nextResetAt: number | undefined;

  for (const item of items) {
    const rule = item.resetRule;
    const candidate = new Date(now);
    candidate.setHours(rule.hour ?? 0, 0, 0, 0);

    if (rule.type === 'daily') {
      if (candidate.getTime() <= nowTimestamp) candidate.setDate(candidate.getDate() + 1);
    } else {
      const resetDay = rule.dayOfWeek ?? 1;
      const daysAhead = (resetDay - now.getDay() + 7) % 7;
      candidate.setDate(candidate.getDate() + daysAhead);
      if (candidate.getTime() <= nowTimestamp) candidate.setDate(candidate.getDate() + 7);
    }

    const candidateTimestamp = candidate.getTime();
    if (nextResetAt === undefined || candidateTimestamp < nextResetAt) {
      nextResetAt = candidateTimestamp;
    }
  }

  return nextResetAt;
}
