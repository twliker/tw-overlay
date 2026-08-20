/** 사냥 도핑 선택과 예상 경험치 계산기 화면을 관리합니다. */
(() => {
  type Doping = import('../shared/types').HuntingExpDoping;
  type Ground = import('../shared/types').HuntingExpGround;
  type Config = import('../shared/types').AppConfig;

  const api = window.electronAPI as typeof window.electronAPI & {
    DEFAULT_CONFIG: Config;
    onConfigData(callback: (config: Config) => void): void;
    applySettings(settings: Partial<Config>): void;
  };

  let dopings: Doping[] = [];
  let grounds: Ground[] = [];
  let selectedGroundId = '';
  let killsPerHour = 40_000;
  let happyHour = true;
  let editingType: 'doping' | 'ground' | null = null;
  let editingId: string | null = null;

  const DOPING_IMAGE_BY_ID: Readonly<Record<string, string>> = Object.freeze({
    'legend-potato': 'assets/img/buffs/전설의_군고구마.png',
    'exp-heart': 'assets/img/buffs/경험의심장.png',
    'supreme-eos': 'assets/img/buffs/최상급_에오스의_파편.png',
    'earlybird-exp': 'assets/img/buffs/얼리버드_경험치_부스터.png',
    illumination: 'assets/img/buffs/일루미네이션축체음료.png',
  });

  const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
  const cloneDopings = (items: readonly Doping[]): Doping[] => items.map(item => ({ ...item }));
  const cloneGrounds = (items: readonly Ground[]): Ground[] => items.map(item => ({ ...item }));
  const finiteNumber = (value: unknown, fallback = 0): number => {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };
  const textValue = (value: unknown, fallback = ''): string => (
    typeof value === 'string' ? value.trim().slice(0, 100) : fallback
  );
  const makeId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function normalizeDopings(value: unknown): Doping[] {
    if (!Array.isArray(value)) return cloneDopings(window.huntingExpCalculator.DEFAULT_DOPINGS);
    const ids = new Set<string>();
    return value.flatMap((raw, index) => {
      if (!raw || typeof raw !== 'object') return [];
      const item = raw as Partial<Doping>;
      const name = textValue(item.name);
      if (!name) return [];
      let id = textValue(item.id, `doping-${index}`);
      if (!id || ids.has(id)) id = makeId('doping');
      ids.add(id);
      return [{
        id,
        name,
        percent: Math.min(finiteNumber(item.percent), 100_000),
        duration: textValue(item.duration, '미정'),
        enabled: item.enabled === true,
        note: textValue(item.note),
      }];
    });
  }

  function normalizeGrounds(value: unknown): Ground[] {
    if (!Array.isArray(value)) return cloneGrounds(window.huntingExpCalculator.DEFAULT_GROUNDS);
    const ids = new Set<string>();
    return value.flatMap((raw, index) => {
      if (!raw || typeof raw !== 'object') return [];
      const item = raw as Partial<Ground>;
      const name = textValue(item.name);
      if (!name) return [];
      let id = textValue(item.id, `ground-${index}`);
      if (!id || ids.has(id)) id = makeId('ground');
      ids.add(id);
      return [{ id, name, baseXp: Math.min(finiteNumber(item.baseXp), Number.MAX_SAFE_INTEGER) }];
    });
  }

  function persist(): void {
    api.applySettings({
      huntingExpDopings: cloneDopings(dopings),
      huntingExpGrounds: cloneGrounds(grounds),
      huntingExpSelectedGroundId: selectedGroundId,
      huntingExpKillsPerHour: killsPerHour,
      huntingExpHappyHour: happyHour,
    });
  }

  function icon(name: string, className: string): HTMLElement {
    const element = document.createElement('i');
    element.setAttribute('data-lucide', name);
    element.className = className;
    return element;
  }

  function actionButton(action: string, id: string, iconName: string, title: string, danger = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = id;
    button.title = title;
    button.className = `row-action ${danger ? 'danger' : ''}`;
    button.append(icon(iconName, 'w-3.5 h-3.5'));
    return button;
  }

  function updateDopingCount(): void {
    const activeCount = dopings.filter(item => item.enabled).length;
    const count = byId('doping-count');
    if (count) count.textContent = `${activeCount}/${dopings.length}개 적용`;
  }

  function renderDopings(): void {
    const list = byId<HTMLDivElement>('doping-list');
    if (!list) return;
    const prevScrollTop = list.scrollTop;
    list.replaceChildren();
    const query = (byId<HTMLInputElement>('doping-search')?.value || '').trim().toLocaleLowerCase('ko');
    const filtered = dopings.filter(item => !query
      || item.name.toLocaleLowerCase('ko').includes(query)
      || item.note.toLocaleLowerCase('ko').includes(query));

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = dopings.length ? '검색 결과가 없습니다.' : '도핑을 추가해 주세요.';
      list.append(empty);
    }

    filtered.forEach(item => {
      const row = document.createElement('div');
      row.className = `doping-row ${item.enabled ? 'active' : ''}`;
      row.dataset.id = item.id;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.enabled;
      checkbox.dataset.action = 'toggle-doping';
      checkbox.dataset.id = item.id;
      checkbox.className = 'doping-check';
      checkbox.setAttribute('aria-label', `${item.name} 적용`);

      const imageBox = document.createElement('div');
      imageBox.className = 'doping-icon';
      const imagePath = DOPING_IMAGE_BY_ID[item.id];
      if (imagePath) {
        const image = document.createElement('img');
        image.src = imagePath;
        image.alt = '';
        image.loading = 'lazy';
        imageBox.append(image);
      } else {
        imageBox.textContent = 'EXP';
      }

      const info = document.createElement('div');
      info.className = 'doping-info';
      const title = document.createElement('div');
      title.className = 'doping-name';
      title.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'doping-meta';
      meta.textContent = [item.duration || '미정', item.note].filter(Boolean).join(' · ');
      info.append(title, meta);

      let percentElement: HTMLElement;
      if (item.id === 'core-siokan') {
        const wrap = document.createElement('label');
        wrap.className = 'percent-input-wrap';
        wrap.title = '시오칸 코어 경험치 증가율 직접 입력';
        const prefix = document.createElement('span');
        prefix.textContent = '+';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = '100000';
        input.step = '1';
        input.value = String(item.percent);
        input.dataset.action = 'percent-input';
        input.dataset.id = item.id;
        input.className = 'percent-input';
        input.setAttribute('aria-label', `${item.name} 증가율 직접 입력`);
        const suffix = document.createElement('span');
        suffix.textContent = '%';
        wrap.append(prefix, input, suffix);
        percentElement = wrap;
      } else {
        const badge = document.createElement('span');
        badge.className = 'percent-badge';
        badge.textContent = `+${item.percent.toLocaleString()}%`;
        percentElement = badge;
      }

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(
        actionButton('edit-doping', item.id, 'pencil', '수정'),
        actionButton('delete-doping', item.id, 'trash-2', '삭제', true),
      );
      row.append(checkbox, imageBox, info, percentElement, actions);
      list.append(row);
    });

    updateDopingCount();
    window.lucide?.createIcons();
    if (prevScrollTop > 0) list.scrollTop = prevScrollTop;
  }

  function renderGrounds(): void {
    const select = byId<HTMLSelectElement>('ground-select');
    if (!select) return;
    select.replaceChildren();
    grounds.forEach(ground => {
      const option = document.createElement('option');
      option.value = ground.id;
      option.textContent = ground.name;
      select.append(option);
    });
    if (!grounds.some(ground => ground.id === selectedGroundId)) selectedGroundId = grounds[0]?.id || '';
    select.value = selectedGroundId;
    select.disabled = grounds.length === 0;
    const selected = grounds.find(ground => ground.id === selectedGroundId);
    const base = byId('selected-base-xp');
    if (base) base.textContent = selected ? selected.baseXp.toLocaleString() : '0';
    const edit = byId<HTMLButtonElement>('edit-ground-btn');
    const remove = byId<HTMLButtonElement>('delete-ground-btn');
    if (edit) edit.disabled = !selected;
    if (remove) remove.disabled = !selected;
  }

  function formatEok(value: number): string {
    const eok = value / 100_000_000;
    return `${eok.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}억`;
  }

  function formatEssenceCount(value: number): string {
    return `약 ${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}개`;
  }

  function calculateAndRender(): void {
    const selected = grounds.find(ground => ground.id === selectedGroundId);
    const result = window.huntingExpCalculator.calculate({
      dopings,
      baseXp: selected?.baseXp || 0,
      killsPerHour,
      happyHour,
    });
    const values: Record<string, string> = {
      'applied-percent': `${result.appliedPercent.toLocaleString()}%`,
      'xp-per-kill': result.experiencePerKill.toLocaleString(),
      'xp-per-hour': result.experiencePerHour.toLocaleString(),
      'xp-per-hour-eok': formatEok(result.experiencePerHour),
      'essence-per-hour': formatEssenceCount(result.experienceEssencePerHour),
      'happy-hour-multiplier': happyHour ? '× 1.5' : '× 1.0',
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = byId(id);
      if (element) element.textContent = value;
    });
    const formula = byId('formula-text');
    if (formula) {
      formula.textContent = `${(selected?.baseXp || 0).toLocaleString()} × (1 + ${result.appliedPercent.toLocaleString()} ÷ 100)${happyHour ? ' × 1.5' : ''}`;
    }
  }

  function render(): void {
    renderDopings();
    renderGrounds();
    const killsInput = byId<HTMLInputElement>('kills-per-hour');
    if (killsInput) killsInput.value = String(killsPerHour);
    const happyInput = byId<HTMLInputElement>('happy-hour-input');
    if (happyInput) happyInput.checked = happyHour;
    calculateAndRender();
  }

  function openEditor(type: 'doping' | 'ground', id: string | null = null): void {
    editingType = type;
    editingId = id;
    const doping = type === 'doping' ? dopings.find(item => item.id === id) : undefined;
    const ground = type === 'ground' ? grounds.find(item => item.id === id) : undefined;
    const modal = byId<HTMLDivElement>('editor-modal');
    const title = byId('editor-title');
    const name = byId<HTMLInputElement>('editor-name');
    const value = byId<HTMLInputElement>('editor-value');
    const durationWrap = byId('editor-duration-wrap');
    const noteWrap = byId('editor-note-wrap');
    const duration = byId<HTMLInputElement>('editor-duration');
    const note = byId<HTMLInputElement>('editor-note');
    const valueLabel = byId('editor-value-label');
    if (!modal || !title || !name || !value || !duration || !note || !valueLabel) return;
    title.textContent = `${id ? '수정' : '추가'} · ${type === 'doping' ? '도핑' : '사냥터'}`;
    valueLabel.textContent = type === 'doping' ? '경험치 증가율 (%)' : '몬스터 기본 경험치';
    name.value = doping?.name || ground?.name || '';
    value.value = String(doping?.percent ?? ground?.baseXp ?? '');
    duration.value = doping?.duration || '';
    note.value = doping?.note || '';
    durationWrap?.classList.toggle('hidden', type === 'ground');
    noteWrap?.classList.toggle('hidden', type === 'ground');
    modal.classList.remove('hidden');
    requestAnimationFrame(() => name.focus());
  }

  function closeEditor(): void {
    editingType = null;
    editingId = null;
    byId('editor-modal')?.classList.add('hidden');
  }

  function submitEditor(event: SubmitEvent): void {
    event.preventDefault();
    const name = textValue(byId<HTMLInputElement>('editor-name')?.value);
    const value = finiteNumber(byId<HTMLInputElement>('editor-value')?.value, -1);
    if (!editingType || !name || value < 0) return;
    if (editingType === 'doping') {
      const duration = textValue(byId<HTMLInputElement>('editor-duration')?.value, '미정');
      const note = textValue(byId<HTMLInputElement>('editor-note')?.value);
      const existing = dopings.find(item => item.id === editingId);
      const percent = Math.min(value, 100_000);
      if (existing) Object.assign(existing, { name, percent, duration, note });
      else dopings.push({ id: makeId('doping'), name, percent, duration, note, enabled: false });
    } else {
      const baseXp = Math.min(value, Number.MAX_SAFE_INTEGER);
      const existing = grounds.find(item => item.id === editingId);
      if (existing) Object.assign(existing, { name, baseXp });
      else {
        const ground = { id: makeId('ground'), name, baseXp };
        grounds.push(ground);
        selectedGroundId = ground.id;
      }
    }
    closeEditor();
    render();
    persist();
  }

  function removeDoping(id: string): void {
    const item = dopings.find(doping => doping.id === id);
    if (!item || !confirm(`'${item.name}' 도핑을 삭제하시겠습니까?`)) return;
    dopings = dopings.filter(doping => doping.id !== id);
    render();
    persist();
  }

  function removeGround(): void {
    const item = grounds.find(ground => ground.id === selectedGroundId);
    if (!item || !confirm(`'${item.name}' 사냥터를 삭제하시겠습니까?`)) return;
    grounds = grounds.filter(ground => ground.id !== item.id);
    selectedGroundId = grounds[0]?.id || '';
    render();
    persist();
  }

  byId('doping-search')?.addEventListener('input', renderDopings);
  byId('add-doping-btn')?.addEventListener('click', () => openEditor('doping'));
  byId('add-ground-btn')?.addEventListener('click', () => openEditor('ground'));
  byId('edit-ground-btn')?.addEventListener('click', () => openEditor('ground', selectedGroundId));
  byId('delete-ground-btn')?.addEventListener('click', removeGround);
  byId('close-editor-btn')?.addEventListener('click', closeEditor);
  byId('cancel-editor-btn')?.addEventListener('click', closeEditor);
  byId<HTMLFormElement>('editor-form')?.addEventListener('submit', submitEditor);
  byId('editor-modal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closeEditor();
  });
  byId('close-window-btn')?.addEventListener('click', () => window.close());

  byId('doping-list')?.addEventListener('input', event => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.action !== 'percent-input') return;
    const item = dopings.find(doping => doping.id === target.dataset.id);
    if (!item) return;
    const value = Math.min(finiteNumber(target.value), 100_000);
    item.percent = value;
    calculateAndRender();
  });

  byId('doping-list')?.addEventListener('change', event => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.action === 'toggle-doping') {
      const item = dopings.find(doping => doping.id === target.dataset.id);
      if (!item) return;
      item.enabled = target.checked;
      const row = target.closest<HTMLElement>('.doping-row');
      if (row) row.classList.toggle('active', item.enabled);
      updateDopingCount();
      calculateAndRender();
      persist();
      return;
    }
    if (target.dataset.action === 'percent-input') {
      const item = dopings.find(doping => doping.id === target.dataset.id);
      if (!item) return;
      const value = Math.min(finiteNumber(target.value), 100_000);
      item.percent = value;
      target.value = String(value);
      calculateAndRender();
      persist();
    }
  });

  byId('doping-list')?.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && target.classList.contains('percent-input')) {
      (target as HTMLInputElement).blur();
    }
  });
  byId('doping-list')?.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button?.dataset.id) return;
    if (button.dataset.action === 'edit-doping') openEditor('doping', button.dataset.id);
    if (button.dataset.action === 'delete-doping') removeDoping(button.dataset.id);
  });
  byId<HTMLSelectElement>('ground-select')?.addEventListener('change', event => {
    selectedGroundId = (event.currentTarget as HTMLSelectElement).value;
    renderGrounds();
    calculateAndRender();
    persist();
  });
  byId<HTMLInputElement>('kills-per-hour')?.addEventListener('input', event => {
    killsPerHour = Math.min(finiteNumber((event.currentTarget as HTMLInputElement).value), 10_000_000);
    calculateAndRender();
  });
  byId<HTMLInputElement>('kills-per-hour')?.addEventListener('change', () => {
    persist();
  });
  byId<HTMLInputElement>('happy-hour-input')?.addEventListener('change', event => {
    happyHour = (event.currentTarget as HTMLInputElement).checked;
    calculateAndRender();
    persist();
  });
  byId('enable-all-btn')?.addEventListener('click', () => {
    dopings.forEach(item => { item.enabled = true; });
    render();
    persist();
  });
  byId('disable-all-btn')?.addEventListener('click', () => {
    dopings.forEach(item => { item.enabled = false; });
    render();
    persist();
  });
  byId('reset-dopings-btn')?.addEventListener('click', () => {
    if (!confirm('도핑 목록과 적용 상태를 기본값으로 복원하시겠습니까?')) return;
    dopings = cloneDopings(window.huntingExpCalculator.DEFAULT_DOPINGS);
    render();
    persist();
  });
  byId('reset-grounds-btn')?.addEventListener('click', () => {
    if (!confirm('사냥터 목록을 기본값으로 복원하시겠습니까?')) return;
    grounds = cloneGrounds(window.huntingExpCalculator.DEFAULT_GROUNDS);
    selectedGroundId = grounds[0]?.id || '';
    render();
    persist();
  });

  api.onConfigData(config => {
    dopings = normalizeDopings(config.huntingExpDopings);
    grounds = normalizeGrounds(config.huntingExpGrounds);
    selectedGroundId = textValue(config.huntingExpSelectedGroundId, grounds[0]?.id || '');
    killsPerHour = Math.min(finiteNumber(config.huntingExpKillsPerHour, 40_000), 10_000_000);
    happyHour = config.huntingExpHappyHour !== false;
    render();
  });

  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!byId('editor-modal')?.classList.contains('hidden')) closeEditor();
    else window.close();
  });
})();
