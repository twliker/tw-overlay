/** 모험일지 주간/일일 타임라인에서 공유하는 로그 처리 유틸리티. */
(() => {
  const systemTags = new Set(['숙제 완료', '자동', '득템', '수익']);

  function parseAutoLogAmount(content: string): number {
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

  const diaryLogUtils = Object.freeze({ parseAutoLogAmount, formatLogContent, resolveLootCount });
  if (typeof module !== 'undefined' && module.exports) module.exports = diaryLogUtils;
  if (typeof window !== 'undefined') window.diaryLogUtils = diaryLogUtils;
})();
