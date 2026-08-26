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

  function measureCell(cell: HTMLElement): void {
    const parts = getParts(cell);
    if (!parts) return;

    const wasExpanded = cell.classList.contains('expanded');
    if (wasExpanded) cell.classList.remove('expanded');
    const overflowing = parts.stack.scrollHeight > COLLAPSED_LOOT_HEIGHT + 1;
    if (wasExpanded && overflowing) cell.classList.add('expanded');

    cell.classList.toggle('has-overflow', overflowing);
    parts.button.hidden = !overflowing;
    if (!overflowing) cell.classList.remove('expanded');
    syncButton(cell, parts.button);
  }

  function refresh(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>('.calendar-cell[data-calendar-day]').forEach(measureCell);
  }

  function toggle(button: HTMLButtonElement, event?: Event): void {
    event?.stopPropagation();
    const cell = button.closest<HTMLElement>('.calendar-cell[data-calendar-day]');
    if (!cell || button.hidden) return;
    cell.classList.toggle('expanded');
    syncButton(cell, button);
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
