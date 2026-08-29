function normalizeLootText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\s\u00A0]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('ko-KR');
}

function extractLootCandidateNames(value: unknown): string[] {
  const normalized = normalizeLootText(value);
  if (!normalized) return [];

  const candidates = new Set<string>([normalized]);
  const withoutDiaryTag = normalized.replace(/^\[득템\]\s*/u, '').trim();
  if (withoutDiaryTag) candidates.add(withoutDiaryTag);

  // 구버전 DB의 원문 저장 형식도 정확한 대괄호 아이템명으로 판정합니다.
  const bracketItem = withoutDiaryTag.match(/^\[([^\]]+)\]/u)?.[1];
  if (bracketItem) candidates.add(normalizeLootText(bracketItem));

  return Array.from(candidates);
}

/** 부분 문자열이 아닌 실제 아이템명 단위로 등록 여부를 확인합니다. */
export function matchesRegisteredLoot(
  lootKeywords: readonly string[] | undefined,
  ...candidates: unknown[]
): boolean {
  if (!Array.isArray(lootKeywords) || lootKeywords.length === 0) return false;
  const normalizedCandidates = candidates.flatMap(extractLootCandidateNames);
  return lootKeywords.some(keyword => {
    const normalizedKeyword = normalizeLootText(keyword);
    return normalizedKeyword.length > 0
      && normalizedCandidates.some(candidate => candidate === normalizedKeyword);
  });
}

export function isMagicStoneLoot(value: unknown): boolean {
  return normalizeLootText(value).includes('마정석');
}

/**
 * 일반 득템 등록 목록과 무관하게 별도 재화 집계가 항상 유지되어야 하는 항목입니다.
 * 현재는 경험의 정수만 해당합니다. 직접 획득 기록, 모험일지 표시, 월간/오늘 요약이 모두
 * 이 예외를 공유하므로 일반 키워드 정리 과정에서 제거하거나 부분 문자열로 넓히지 않습니다.
 */
export function isAlwaysTrackedLoot(...candidates: unknown[]): boolean {
  return candidates
    .flatMap(extractLootCandidateNames)
    .some(candidate => candidate === '경험의 정수');
}

/** 경험의 정수와 마정석은 별도 재화이므로 일반 득템 개수 합계에서 제외합니다. */
export function countsTowardLootTotal(value: unknown): boolean {
  const normalized = normalizeLootText(value);
  return !normalized.includes('경험의 정수') && !normalized.includes('마정석');
}
