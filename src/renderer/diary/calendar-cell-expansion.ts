(() => {
  const COLLAPSED_LOOT_HEIGHT = 58;
  const RESIZE_DEBOUNCE_MS = 80;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  function getParts(cell: HTMLElement): { stack: HTMLElement; button: HTMLButtonElement } | null {
    const stack = cell.querySelector<HTMLElement>('.loot-stack');
    const button = cell.querySelector<HTMLButtonElement>('.calendar-cell-toggle');
    return stack && button ? { stack, button } : null;
  }

  function syncButton(cell: HTMLElement, button: HTMLButtonElement): void {
    const expanded = cell.classList.contains('expanded');
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? '득템 목록 접기' : '득템 목록 더보기');
    const label = button.querySelector<HTMLElement>('.calendar-cell-toggle-label');
    if (label) label.textContent = expanded ? '접기' : '더보기';
  }

  function measureCell(cell: HTMLElement): boolean {
    const parts = getParts(cell);
    if (!parts) return false;

    cell.classList.remove('expanded');
    const overflowing = parts.stack.scrollHeight > COLLAPSED_LOOT_HEIGHT + 1;

    cell.classList.toggle('has-overflow', overflowing);
    parts.button.hidden = !overflowing;
    return overflowing;
  }

  function getRowCells(cell: HTMLElement): HTMLElement[] {
    const row = cell.dataset.calendarRow;
    const root = cell.parentElement;
    if (!row || !root) return [cell];
    return Array.from(root.querySelectorAll<HTMLElement>('.calendar-cell[data-calendar-row]'))
      .filter(candidate => candidate.dataset.calendarRow === row);
  }

  function setRowExpanded(cells: readonly HTMLElement[], expanded: boolean): void {
    cells.forEach(cell => {
      cell.classList.toggle('expanded', expanded);
      const parts = getParts(cell);
      if (parts) syncButton(cell, parts.button);
    });
  }

  function refresh(root: ParentNode = document): void {
    const cells = Array.from(root.querySelectorAll<HTMLElement>('.calendar-cell[data-calendar-row]'));
    const expandedRows = new Set(
      cells.filter(cell => cell.classList.contains('expanded'))
        .map(cell => cell.dataset.calendarRow)
        .filter((row): row is string => Boolean(row)),
    );
    const overflowingRows = new Set<string>();

    cells.forEach(cell => {
      if (measureCell(cell) && cell.dataset.calendarRow) overflowingRows.add(cell.dataset.calendarRow);
    });

    const rows = new Map<string, HTMLElement[]>();
    cells.forEach(cell => {
      const row = cell.dataset.calendarRow;
      if (!row) return;
      const rowCells = rows.get(row) ?? [];
      rowCells.push(cell);
      rows.set(row, rowCells);
    });
    rows.forEach((rowCells, row) => setRowExpanded(
      rowCells,
      expandedRows.has(row) && overflowingRows.has(row),
    ));
  }

  function toggle(button: HTMLButtonElement, event?: Event): void {
    event?.stopPropagation();
    const cell = button.closest<HTMLElement>('.calendar-cell[data-calendar-day]');
    if (!cell || button.hidden) return;
    const rowCells = getRowCells(cell);
    setRowExpanded(rowCells, !cell.classList.contains('expanded'));
  }

  function scheduleRefresh(root: ParentNode = document): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      refresh(root);
    }, RESIZE_DEBOUNCE_MS);
  }

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('.calendar-cell-toggle');
    if (button) toggle(button, event);
  });
  window.addEventListener('resize', () => scheduleRefresh());

  Object.assign(window, {
    diaryCalendarExpansion: {
      collapsedLootHeight: COLLAPSED_LOOT_HEIGHT,
      refresh,
      scheduleRefresh,
      toggle,
    },
  });
})();

interface Window {
  diaryCalendarExpansion: {
    collapsedLootHeight: number;
    refresh(root?: ParentNode): void;
    scheduleRefresh(root?: ParentNode): void;
    toggle(button: HTMLButtonElement, event?: Event): void;
  };
}
