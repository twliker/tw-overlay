/** 모험일지 주간/일일 타임라인에서 공유하는 로그 처리 유틸리티. */
(() => {
  const systemTags = new Set(['숙제 완료', '자동', '득템', '수익']);

  /**
   * 기능 계약: 일·주·월의 수익 묶음과 펼친 원본은 DB의 확정 amount를 사용한다.
   * 금화 주머니처럼 문구에 금액이 없어도 표시하며 0·음수도 유효한 저장값이다.
   * amount가 없는 구버전 응답에만 표시 문구 파싱을 보조로 사용한다.
   */
  function parseAutoLogAmount(content: string, storedAmount?: number): number {
    if (typeof storedAmount === 'number' && Number.isFinite(storedAmount)) return storedAmount;
    const amountText = content.match(/\(([^)]+)\)/)?.[1];
    if (!amountText) return 0;

    const unitValues: Array<[RegExp, number]> = [
      [/([\d,]+)\s*조/u, 1_000_000_000_000],
      [/([\d,]+)\s*억/u, 100_000_000],
      [/([\d,]+)\s*만/u, 10_000],
    ];
    let amount = 0;
    let matchedUnit = false;
    for (const [pattern, multiplier] of unitValues) {
      const matched = amountText.match(pattern)?.[1];
      if (!matched) continue;
      amount += parseInt(matched.replace(/,/g, ''), 10) * multiplier;
      matchedUnit = true;
    }
    if (matchedUnit) return amount;

    const rawNumber = amountText.match(/([\d,]+)/)?.[1];
    return rawNumber ? parseInt(rawNumber.replace(/,/g, ''), 10) : 0;
  }

  /**
   * 기능 계약: 실제 로그의 `0:2:20`과 숙제 completed_at(ms)을 같은 로컬 시각으로 정렬한다.
   * 날짜는 호출 화면의 기록 날짜를 유지하며, 초까지 정렬한 뒤 화면에는 시·분만 표시한다.
   * DB 원본을 바꾸지 않는다. check-companion-files의 실제 DB/IPC/일·주 타임라인을 함께 검사한다.
   */
  function normalizeLogTime(value: string | number): string {
    const date = typeof value === 'number' ? new Date(value) : null;
    const parts = date
      ? [date.getHours(), date.getMinutes(), date.getSeconds()]
      : String(value || '').split(':').map(Number);
    return [24, 60, 60].map((limit, index) => {
      const part = parts[index];
      return String(Number.isFinite(part) && part >= 0 && part < limit ? Math.trunc(part) : 0).padStart(2, '0');
    }).join(':');
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatLogContent(content: string): string {
    const escaped = escapeHtml(content);
    return escaped.replace(/\[(.*?)\]/g, (match: string, tag: string) => {
      if (systemTags.has(tag)) return match;
      return `<span class="char-badge">${tag}</span>`;
    });
  }

  /** 저장된 amount를 우선 사용하고, 구버전 기록은 content의 'N개'를 보조로 읽습니다. */
  function resolveLootCount(content: string, storedAmount: unknown): number {
    const amount = typeof storedAmount === 'number' ? storedAmount : Number(storedAmount);
    if (Number.isFinite(amount) && amount > 0) return Math.floor(amount);
    const contentCount = content.match(/\[?([\d,]+)\]?개/u)?.[1];
    if (!contentCount) return 1;
    const parsed = Number(contentCount.replace(/,/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
  }

  const diaryLogUtils = Object.freeze({ parseAutoLogAmount, normalizeLogTime, formatLogContent, resolveLootCount });
  if (typeof module !== 'undefined' && module.exports) module.exports = diaryLogUtils;
  if (typeof window !== 'undefined') window.diaryLogUtils = diaryLogUtils;
})();
