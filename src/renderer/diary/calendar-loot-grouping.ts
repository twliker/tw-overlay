/** 타임라인 원본은 유지하면서 달력 셀에서만 같은 의미의 득템을 합산합니다. */
(() => {
  interface CalendarLootEntry {
    name: string;
    count: number;
    img: string;
  }

  function normalizeName(name: string): string {
    return String(name ?? '').replace(/\s+/gu, ' ').trim();
  }

  function parseAcquisition(content: string): { name: string; countText?: string } | null {
    const patterns = [
      /^\[(.*?)\](?:\s*(?:을\(를\)|아이템을))?\s*(?:\[?([\d,]+)\]?개)?\s*(?:(?:획득\s*하였(?:습니다)?)|(?:습득\s*했습니다))\.?$/u,
      /^(.*?)(?:\s+아이템을)?\s*(?:\[?([\d,]+)\]?개)?\s*(?:(?:획득\s*하였(?:습니다)?)|(?:습득\s*했습니다))\.?$/u,
    ];
    for (const pattern of patterns) {
      const matched = content.match(pattern);
      if (matched?.[1]?.trim()) {
        return { name: matched[1].trim(), countText: matched[2] };
      }
    }
    return null;
  }

  function group(entries: readonly CalendarLootEntry[]): CalendarLootEntry[] {
    const grouped = new Map<string, CalendarLootEntry>();
    entries.forEach(entry => {
      const name = normalizeName(entry.name);
      const count = Number.isFinite(Number(entry.count)) ? Math.max(0, Number(entry.count)) : 0;
      const existing = grouped.get(name);
      if (existing) {
        existing.count += count;
        if (!existing.img && entry.img) existing.img = entry.img;
        return;
      }
      grouped.set(name, { name, count, img: entry.img });
    });
    return Array.from(grouped.values());
  }

  const diaryCalendarLootGrouping = Object.freeze({ normalizeName, parseAcquisition, group });
  if (typeof module !== 'undefined' && module.exports) module.exports = diaryCalendarLootGrouping;
  if (typeof window !== 'undefined') window.diaryCalendarLootGrouping = diaryCalendarLootGrouping;
})();

interface Window {
  diaryCalendarLootGrouping: {
    normalizeName(name: string): string;
    parseAcquisition(content: string): { name: string; countText?: string } | null;
    group(entries: readonly { name: string; count: number; img: string }[]): Array<{
      name: string;
      count: number;
      img: string;
    }>;
  };
}
