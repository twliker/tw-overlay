/** 한 숙제의 한 리셋 주기 안에서 감지한 진행 기록(채팅 로그 1건 또는 복원 파일 1개의 집계). */
export interface HomeworkCycleContribution {
  /** 증분(+N)이면 더하고, 절대 횟수(게임이 알려 준 누적 N회)면 기존 값과 큰 쪽을 쓴다. */
  count: number;
  isIncrement: boolean;
  /** 원본 로그 시각(ms). 완료 시각과 일지 날짜는 최대 횟수에 처음 도달한 기록의 시각이다. */
  occurredAt: number;
}

export interface HomeworkCycleProgress {count: number;completedAt?: number}

/** 기록 묶음 하나를 시각 순으로 접는 기본 규칙. 같은 원본 줄이 두 번 들어오지 않는 묶음에만 쓴다.
 * - base: 묶음보다 먼저 적용할 횟수(시각 없음).
 * - contributions: 시각 순으로 적용한다. 증분은 더하고 절대 횟수는 최대값을 쓴다.
 * - completedAt: base가 이미 최대 횟수면 비워 둔다. 그 밖에는 최대 횟수에 처음 도달한 기록의 시각이다.
 * 기존(프로필 아님) 과거 로그 복원은 base 0과 파일별 집계로 이 규칙만 쓴다. */
export function foldHomeworkCycleProgress(
  base: number,
  contributions: readonly HomeworkCycleContribution[],
  maxCount: number,
): HomeworkCycleProgress {
  const max = Math.max(1, maxCount || 1);
  let count = Math.max(0, base || 0);
  let completedAt: number | undefined;
  const ordered = contributions
    .map((entry, index) => ({entry, index}))
    .filter(({entry}) => entry.count > 0 && Number.isFinite(entry.occurredAt) && entry.occurredAt > 0)
    .sort((left, right) => left.entry.occurredAt - right.entry.occurredAt || left.index - right.index);
  for (const {entry} of ordered) {
    const previous = count;
    count = entry.isIncrement ? count + entry.count : Math.max(count, entry.count);
    if (previous < max && count >= max && completedAt === undefined) completedAt = entry.occurredAt;
  }
  return {count: Math.min(count, max), ...(completedAt === undefined ? {} : {completedAt})};
}

/** 프로필·숙제·리셋 주기 하나의 누적 장부(homework_cycle_progress). */
export interface HomeworkCycleLedger {
  /** 'checklist': 그 주기에 체크리스트가 가진 마지막 횟수. 실시간 기록·직접 편집·그 주기 중의 복원 병합을 포함한다. */
  base: number;
  /** 'event:<원본 ID>': 주기가 지난 뒤 배정·감지된 기록. 원본 ID마다 한 행이다. */
  events: readonly HomeworkCycleContribution[];
  /** 'restore:<로그 날짜>': 과거 로그 복원이 그 날짜 로그 파일에서 집계한 값(그 프로필 소유 줄 전체). */
  restored: readonly HomeworkCycleContribution[];
}

/** 숙제 주기 장부 집계 계약 — 과거 로그 복원(chatLogSyncManager)과 지난 주기 기록 배정
 * (diaryDb.recordLateHomeworkProgress)이 같은 규칙을 쓴다. 원본 로그 한 줄은 최대 한 번만 센다.
 *
 * 세 출처가 겹치는 방식(원본 줄 기준):
 * - base ∩ events = ∅: events는 그 주기 동안 대기 중이라 체크리스트에 들어가지 않았던 줄과, 주기가
 *   끝난 뒤 처리된 줄이다. base는 주기가 끝나면 더 바뀌지 않는다. 그래서 base + events는 더해도 된다.
 * - restored ⊇ (복원한 파일 안의 base 줄·events 줄): 복원은 그 프로필이 이미 소유한 줄(실시간 기록,
 *   지난 주기 배정, 이전 복원)도 다시 집계한다. 그 주기 중의 복원은 체크리스트에 최대값으로 병합되어
 *   base에도 들어간다. 따라서 restored는 base·events 어느 쪽과도 더하면 안 된다.
 * - restored끼리는 로그 날짜마다 한 행이고 같은 날짜를 다시 복원하면 그 행만 교체한다. 같은 날짜
 *   로그의 다른 폴더 복사본도 같은 행이라 두 번 세지 않는다. 다른 날짜의 행은 서로 다른 줄이다.
 *
 * 규칙: 진행 = max(fold(base, events), fold(0, restored)). 두 값은 각각 겹침 없는 줄 집합의 횟수라
 * 실제 수행 횟수보다 클 수 없다(오탐 완료 없음). 실시간 기록과 앱 밖 기록이 섞인 주기를 일부 날짜만
 * 복원하면 덜 셀 수 있으나, 그 주기 로그를 모두 복원하면 restored가 전체를 센다.
 * completedAt: base가 이미 최대 횟수면 체크리스트가 완료를 기록했으므로 비운다. 그 밖에는 두 묶음 중
 * 최대 횟수에 먼저 도달한 기록의 시각이다.
 * 회귀: check-audit-regressions.ts(겹침 시나리오), check-profile-recording.ts(지난 주기 배정),
 * check-profile-log-restore.ts(실제 복원). */
export function foldHomeworkCycleLedger(ledger: HomeworkCycleLedger, maxCount: number): HomeworkCycleProgress {
  const max = Math.max(1, maxCount || 1);
  if (Math.max(0, ledger.base || 0) >= max) return {count: max};
  const recorded = foldHomeworkCycleProgress(ledger.base, ledger.events, max);
  const restored = foldHomeworkCycleProgress(0, ledger.restored, max);
  const times = [recorded.completedAt, restored.completedAt].filter((value): value is number => value !== undefined);
  const count = Math.max(recorded.count, restored.count);
  return times.length ? {count, completedAt: Math.min(...times)} : {count};
}
