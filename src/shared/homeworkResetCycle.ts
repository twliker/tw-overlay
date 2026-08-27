import type { ResetRule } from './types';

/** 이벤트 시각이 속한 가장 최근 숙제 리셋 주기를 안정적인 문자열 키로 반환한다. */
export function getHomeworkResetCycleKey(rule: ResetRule, timestamp: number): string {
  const at = new Date(timestamp);
  const boundary = new Date(at);
  const resetHour = rule.hour ?? 0;
  boundary.setHours(resetHour, 0, 0, 0);

  if (rule.type === 'daily') {
    if (at < boundary) boundary.setDate(boundary.getDate() - 1);
  } else {
    const resetDay = rule.dayOfWeek ?? 1;
    const dayDiff = (at.getDay() - resetDay + 7) % 7;
    boundary.setDate(boundary.getDate() - dayDiff);
    if (dayDiff === 0 && at < boundary) boundary.setDate(boundary.getDate() - 7);
  }

  return `${rule.type}:${boundary.getTime()}`;
}
