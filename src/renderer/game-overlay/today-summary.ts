/** 모험일지의 오늘 데이터와 현재 캐릭터 숙제를 간략 HUD로 표시합니다. */
(() => {
  const api = window.electronAPI as typeof window.electronAPI & {
    getTodaySummary(): Promise<BrowserTodaySummary>;
    onDiaryUpdated(callback: () => void): void;
    onTodaySummaryConfig(callback: (config: BrowserAppConfig) => void): void;
    DEFAULT_CONFIG: BrowserAppConfig;
  };
  const MAX_VISIBLE_LOOT_ITEMS = 3;
  const MAX_VISIBLE_HOMEWORK_ITEMS = 3;
  let currentConfig: BrowserAppConfig | null = null;
  let currentDate = '';
  let refreshSequence = 0;

  function byId(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  function setText(id: string, value: string): void {
    const element = byId(id);
    if (element) element.textContent = value;
  }

  function formatSeed(value: number): string {
    const seed = Math.max(0, Math.floor(value));
    if (seed === 0) return '0';
    if (seed < 10000) return seed.toLocaleString();
    const units = [
      { label: '조', value: 1_000_000_000_000 },
      { label: '억', value: 100_000_000 },
      { label: '만', value: 10_000 },
    ];
    let result = '';
    let remaining = seed;
    for (const unit of units) {
      if (remaining >= unit.value) {
        result += `${Math.floor(remaining / unit.value)}${unit.label} `;
        remaining %= unit.value;
      }
    }
    return result.trim() || '0';
  }

  function createEmptyRow(message: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'today-summary-empty';
    row.textContent = message;
    return row;
  }

  function createListRow(name: string, value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'today-summary-list-row';
    const nameElement = document.createElement('span');
    nameElement.className = 'today-summary-list-name';
    nameElement.textContent = name;
    const valueElement = document.createElement('span');
    valueElement.className = 'today-summary-list-value';
    valueElement.textContent = value;
    row.append(nameElement, valueElement);
    return row;
  }

  function renderLoot(summary: BrowserTodaySummary): void {
    const container = byId('today-summary-loot-list');
    if (!container) return;
    container.replaceChildren();
    const visibleItems = summary.lootItems.slice(0, MAX_VISIBLE_LOOT_ITEMS);
    if (visibleItems.length === 0) {
      container.append(createEmptyRow('기록된 아이템이 없습니다.'));
      return;
    }
    visibleItems.forEach(item => container.append(
      createListRow(item.name, `${item.count.toLocaleString()}개`),
    ));
    const hiddenCount = summary.lootItems.length - visibleItems.length;
    if (hiddenCount > 0) container.append(createEmptyRow(`외 ${hiddenCount}종`));
  }

  function renderHomework(summary: BrowserTodaySummary): void {
    const { homework } = summary;
    setText('today-summary-homework-character', `${homework.characterName} 숙제`);
    setText(
      'today-summary-homework-progress',
      `${homework.completedCount}/${homework.totalCount} · ${homework.remainingCount}개 남음`,
    );
    const container = byId('today-summary-homework-list');
    if (!container) return;
    container.replaceChildren();
    const visibleItems = homework.remainingItems.slice(0, MAX_VISIBLE_HOMEWORK_ITEMS);
    if (visibleItems.length === 0) {
      container.append(createEmptyRow(
        homework.totalCount > 0 ? '모든 숙제를 완료했습니다.' : '표시할 숙제가 없습니다.',
      ));
      return;
    }
    visibleItems.forEach(item => {
      const progress = item.maxCount > 1 ? `${item.currentCount}/${item.maxCount}` : '미완료';
      container.append(createListRow(item.name, progress));
    });
    const hiddenCount = homework.remainingCount - visibleItems.length;
    if (hiddenCount > 0) container.append(createEmptyRow(`외 ${hiddenCount}개 미완료`));
  }

  function renderSummary(summary: BrowserTodaySummary): void {
    currentDate = summary.date;
    setText('today-summary-date', summary.date.slice(5).replace('-', '.'));
    setText('today-summary-seed', formatSeed(summary.totalSeed));
    setText('today-summary-elso', `${summary.totalElso.toLocaleString()} P`);
    setText('today-summary-loot-total', `${summary.lootItems.length}종`);
    setText('today-summary-loot-meta', `${summary.totalLootCount.toLocaleString()}개`);
    setText('today-summary-bosses', `${summary.bossKills.toLocaleString()}회`);
    setText(
      'today-summary-compact',
      `SEED ${formatSeed(summary.totalSeed)}\nELSO ${summary.totalElso.toLocaleString()} P\n경험의 정수 ${summary.totalEssence.toLocaleString()}개 · 남은 숙제 ${summary.homework.remainingCount}개`,
    );
    renderLoot(summary);
    renderHomework(summary);
    positionSummary();
  }

  function applyCollapsedState(collapsed: boolean): void {
    const summary = byId('today-summary-hud');
    summary?.classList.toggle('collapsed', collapsed);
    positionSummary();
  }

  function measureHiddenElement(element: HTMLElement): DOMRect {
    const rect = element.getBoundingClientRect();
    if (rect.height > 0) return rect;
    const clone = element.cloneNode(true) as HTMLElement;
    clone.removeAttribute('id');
    clone.classList.remove('hidden');
    clone.style.setProperty('display', 'flex', 'important');
    clone.style.setProperty('visibility', 'hidden', 'important');
    clone.style.setProperty('left', '0', 'important');
    clone.style.setProperty('top', '0', 'important');
    document.body.appendChild(clone);
    const measured = clone.getBoundingClientRect();
    clone.remove();
    return measured;
  }

  function positionSummary(): void {
    if (window.gameOverlayEditMode?.isEditMode?.()) return;
    const summary = byId('today-summary-hud');
    if (!summary) return;
    const defaultPosition = api.DEFAULT_CONFIG.todaySummaryHudPos || { left: 0, top: 200 };
    const configuredPosition = currentConfig?.todaySummaryHudPos || defaultPosition;
    const summaryRect = measureHiddenElement(summary);
    const left = Math.max(0, Math.min(configuredPosition.left, window.innerWidth - summaryRect.width));
    if (typeof configuredPosition.top === 'number') {
      const top = Math.max(0, Math.min(configuredPosition.top, window.innerHeight - summaryRect.height));
      summary.style.left = `${Math.round(left)}px`;
      summary.style.top = `${Math.round(top)}px`;
      summary.style.bottom = 'auto';
    } else {
      const bottom = Math.max(0, Math.min(configuredPosition.bottom ?? 0, window.innerHeight - summaryRect.height));
      summary.style.left = `${Math.round(left)}px`;
      summary.style.bottom = `${Math.round(bottom)}px`;
      summary.style.top = 'auto';
    }
  }

  async function refreshSummary(): Promise<void> {
    if (currentConfig?.showTodaySummaryHud === false) return;
    const sequence = ++refreshSequence;
    try {
      const summary = await api.getTodaySummary();
      if (sequence === refreshSequence && summary) renderSummary(summary);
    } catch (error) {
      console.error('[TODAY_SUMMARY] 오늘 요약을 불러오지 못했습니다.', error);
    }
  }

  api.onDiaryUpdated(() => { void refreshSummary(); });
  api.onTodaySummaryConfig(config => {
    currentConfig = config;
    const summary = byId('today-summary-hud');
    summary?.classList.toggle('hidden', config.showTodaySummaryHud === false);
    applyCollapsedState(config.todaySummaryCollapsed === true);
    positionSummary();
    void refreshSummary();
  });
  window.addEventListener('resize', positionSummary);
  const abandonedWidget = byId('abandoned-widget');
  if (abandonedWidget) {
    new MutationObserver(positionSummary).observe(abandonedWidget, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
  window.addEventListener('DOMContentLoaded', () => {
    positionSummary();
    void refreshSummary();
  });
  setInterval(() => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (date !== currentDate) void refreshSummary();
  }, 60_000);
})();
