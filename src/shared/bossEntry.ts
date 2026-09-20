import type { AppConfig, BossEntryWindow } from './types';

/** 입장 제한이 있는 콘텐츠만 관리한다. 등장 스케줄은 bossNotifier의 단일 원본을 받는다. */
export const BOSS_ENTRY_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  '혼란한 대지': 4,
  '파멸의 기원': 6,
});

export function getActiveBossEntryWindows(
  schedule: readonly { name: string; time: string }[],
  config: Pick<AppConfig, 'fieldBossNotifyEnabled' | 'fieldBossSettings' | 'bossEntryCountdownBosses'>,
  now: Date,
): BossEntryWindow[] {
  if (!config.fieldBossNotifyEnabled) return [];
  const enabled = config.bossEntryCountdownBosses ?? Object.keys(BOSS_ENTRY_MINUTES);
  return getScheduledBossEntryWindows(schedule, now).filter(boss =>
    enabled.includes(boss.name) && config.fieldBossSettings?.[boss.name]?.enabled);
}

/** 설정을 꺼 둔 동안 받은 참여 로그도 해당 회차에 연결할 수 있도록 시간 계산을 공유한다. */
export function getScheduledBossEntryWindows(
  schedule: readonly { name: string; time: string }[],
  now: Date,
): BossEntryWindow[] {
  const result: BossEntryWindow[] = [];
  for (const boss of schedule) {
    const duration = BOSS_ENTRY_MINUTES[boss.name];
    if (!duration) continue;
    const [hour, minute] = boss.time.split(':').map(Number);
    // 자정을 넘는 입장 창도 닫히는 시각까지 유지한다.
    for (const dayOffset of [-1, 0]) {
      const occurrence = new Date(now);
      occurrence.setDate(occurrence.getDate() + dayOffset);
      occurrence.setHours(hour, minute, 0, 0);
      const opensAt = occurrence.getTime();
      const closesAt = opensAt + duration * 60_000;
      if (now.getTime() >= opensAt && now.getTime() < closesAt) {
        result.push({ id: `${boss.name}-${opensAt}`, name: boss.name, opensAt, closesAt });
      }
    }
  }
  return result.sort((a, b) => a.closesAt - b.closesAt);
}

/**
 * 기능 계약 — 파멸의 기원 참여 로그
 * 원본 #ff64ff 시스템 로그의 마티아 시작 대사 또는 파멸의 기원 대미지 결과만 감지한다.
 * 실제 2026-09-05 로그는 시작 대사와 !가 두 줄이고, 09-09 보상 부족 결과는 숫자가
 * 다음 줄로 잘려 있다. 따라서 시작 대사의 !와 보상 부족 뒤의 전체 수치를 요구하지 않는다.
 * 입구 출현 공지, 일반 퇴장 예고, 이클립스의 '서클릿의 사제, 마티아', 유저 인용은 제외한다.
 * ChatParser → ORIGIN_OF_DOOM_ACTIVITY → bossNotifier의 이번 회차 HUD 숨김으로 이어지며
 * 숙제·보상 집계에는 연결하지 않는다. 회귀: scripts/check-hunting-assist.ts의 원본 HTML fixture.
 */
export function parseOriginOfDoomActivity(message: string, color: string): 'started' | 'finished' | null {
  if (color.toLowerCase() !== '#ff64ff') return null;
  const text = message.replace(/\s+/g, ' ').trim();
  if (/^마티아\s*:\s*저열한 존재들이여 달여왕님의 하해와 같은 은총에 납작 엎드려 굴복하십시오\s*!?$/.test(text)) return 'started';
  if (/^파멸의 기원에 입힌 총 대미지\s*:\s*\d[\d,]*$/.test(text)
    || /^파멸의 기원에 입힌 대미지가 부족하여 보상을 획득할 수 없습니다\.(?:\s|$)/.test(text)) return 'finished';
  return null;
}
