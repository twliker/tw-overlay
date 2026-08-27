export type LocalDateSource = Pick<Date, 'getFullYear' | 'getMonth' | 'getDate'>;

/** 사용자의 로컬 달력 날짜를 YYYY-MM-DD 형식으로 반환합니다. */
export function formatLocalDateKey(now: LocalDateSource = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
