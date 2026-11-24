import type { ResetRule } from './types';

const koreaOffsetMs=9*60*60*1000;
export const homeworkDayMs=86_400_000;

/** PC의 시간대와 관계없이 게임의 한국 시각 경계를 사용한다. */
export function getHomeworkCycleStart(rule: ResetRule, timestamp: number): number {
  const at = new Date(timestamp+koreaOffsetMs);
  const boundary = new Date(at);
  boundary.setUTCHours(rule.hour ?? 0, 0, 0, 0);

  if (rule.type === 'daily') {
    if (at < boundary) boundary.setUTCDate(boundary.getUTCDate() - 1);
  } else {
    const resetDay = rule.dayOfWeek ?? 1;
    const dayDiff = (at.getUTCDay() - resetDay + 7) % 7;
    boundary.setUTCDate(boundary.getUTCDate() - dayDiff);
    if (dayDiff === 0 && at < boundary) boundary.setUTCDate(boundary.getUTCDate() - 7);
  }

  return boundary.getTime()-koreaOffsetMs;
}

export function getHomeworkCycleEnd(rule: ResetRule,timestamp:number):number {
  return getHomeworkCycleStart(rule,timestamp)+(rule.type==='weekly' ? 7 : 1)*homeworkDayMs;
}

export function getHomeworkResetCycleKey(rule: ResetRule,timestamp:number):string {
  return `${rule.type}:${getHomeworkCycleStart(rule,timestamp)}`;
}
