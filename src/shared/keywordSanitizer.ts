export const MAX_NOTIFICATION_KEYWORDS = 200;
export const MAX_NOTIFICATION_KEYWORD_LENGTH = 100;

export function normalizeNotificationKeyword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_NOTIFICATION_KEYWORD_LENGTH) return null;
  return normalized;
}

export function normalizeNotificationKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawKeyword of value) {
    const keyword = normalizeNotificationKeyword(rawKeyword);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    result.push(keyword);
    if (result.length >= MAX_NOTIFICATION_KEYWORDS) break;
  }
  return result;
}
