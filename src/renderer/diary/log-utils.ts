/** 모험일지 주간/일일 타임라인에서 공유하는 로그 처리 유틸리티. */
(() => {
  const systemTags = new Set(['숙제 완료', '자동', '득템', '수익']);

  function parseAutoLogAmount(content: string): number {
    const amountText = content.match(/\(([^)]+)\)/)?.[1];
    if (!amountText) return 0;
    const rawNumber = amountText.match(/([\d,]+)/)?.[1];
    let amount = rawNumber ? parseInt(rawNumber.replace(/,/g, ''), 10) : 0;
    if (amountText.includes('조')) amount *= 1000000000000;
    if (amountText.includes('억')) amount *= 100000000;
    else if (amountText.includes('만')) amount *= 10000;
    return amount;
  }

  function formatLogContent(content: string): string {
    return content.replace(/\[(.*?)\]/g, (match: string, tag: string) => {
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
