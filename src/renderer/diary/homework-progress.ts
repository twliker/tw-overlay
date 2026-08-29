/**
 * 기능 계약: 모험일지 주간 숙제 진행 표시
 *
 * - 체크리스트가 저장한 당시 전체 숙제 수가 있으면 `완료/전체`로 표시한다.
 * - 과거 채팅 로그에는 당시 캐릭터·숙제 설정 전체가 남지 않으므로, 과거 주차의 전체 수는
 *   현재 체크리스트의 캐릭터별 주간 숙제 전체 수를 사용해 현재 주와 같은 `완료/전체`로 표시한다.
 * - 완료 이력과 전체 수가 모두 없을 때만 달력의 기본 `주간 상세` 문구를 사용한다.
 */
(() => {
  interface WeeklyHomeworkProgress {
    done: number;
    total: number;
    hasProgress: boolean;
    hasTotal: boolean;
    isComplete: boolean;
    text: string;
  }

  function normalizeCount(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
  }

  function format(doneValue: unknown, totalValue: unknown): WeeklyHomeworkProgress {
    const done = normalizeCount(doneValue);
    const total = normalizeCount(totalValue);
    const hasTotal = total > 0;
    return {
      done,
      total,
      hasProgress: done > 0 || hasTotal,
      hasTotal,
      isComplete: hasTotal && done >= total,
      text: hasTotal ? `${done}/${total}` : `${done}건`,
    };
  }

  const diaryHomeworkProgress = Object.freeze({ format });
  if (typeof module !== 'undefined' && module.exports) module.exports = diaryHomeworkProgress;
  if (typeof window !== 'undefined') window.diaryHomeworkProgress = diaryHomeworkProgress;
})();

interface Window {
  diaryHomeworkProgress: {
    format(done: unknown, total: unknown): {
      done: number;
      total: number;
      hasProgress: boolean;
      hasTotal: boolean;
      isComplete: boolean;
      text: string;
    };
  };
}
