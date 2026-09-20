interface Window { settingsActivityPresets: { bind(config: Partial<BrowserAppConfig>): void }; }

(() => {
  const api = window.electronAPI as typeof window.electronAPI & {
    saveActivityPreset(name: string, id?: string, renameOnly?: boolean): Promise<{ success: boolean; error?: string }>;
    deleteActivityPreset(id: string): Promise<{ success: boolean; error?: string }>;
    applyActivityPreset(id: string): Promise<{ success: boolean; error?: string }>;
  };
  const list = document.getElementById('activity-preset-list');
  const status = document.getElementById('activity-preset-status');
  const name = document.getElementById('activity-preset-name') as HTMLInputElement | null;
  let busy = false;
  const expanded = new Set<string>();
  const windowNames: Record<string, string> = { xpHud: '경험치 측정', buffTimer: '버프 타이머', trade: '거래 검색', diary: '모험일지', focusedChat: '집중 채팅', shoutHistory: '외치기 이력', contentsChecker: '숙제 체크', chatOverlay: '메인 채팅', chatOverlaySub: '보조 채팅 1', chatOverlaySub2: '보조 채팅 2' };
  function equalSaved(saved: unknown, current: unknown): boolean {
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const values = current && typeof current === 'object' ? current as Record<string, unknown> : {};
      return Object.entries(saved).every(([key, value]) => equalSaved(value, values[key]));
    }
    return JSON.stringify(saved) === JSON.stringify(current);
  }
  function describeChanges(preset: import('../../shared/types').ActivityPreset, config: Partial<BrowserAppConfig>): string {
    const groups = new Set<string>();
    for (const [key, value] of Object.entries(preset.settings || {})) {
      const current = (config as Record<string, unknown>)[key];
      if (key === 'buffTimerBuffs') {
        const savedBuffs = value as Record<string, boolean>;
        const currentBuffs = (current || {}) as Record<string, boolean>;
        if ([...new Set([...Object.keys(savedBuffs), ...Object.keys(currentBuffs)])].every(id => (savedBuffs[id] !== false) === (currentBuffs[id] !== false))) continue;
      } else if (equalSaved(value, current)) continue;
      groups.add(/positions|Pos$|Width$|Height$|Sizes$/i.test(key) ? '창·HUD 배치' : /alert|notify|sound|volume|boss|warn|notification/i.test(key) ? '알림' : '표시·측정 설정');
    }
    return groups.size ? `현재 저장 설정과 다른 항목: ${[...groups].join(', ')}` : '저장된 표시·배치·알림 설정이 현재와 같습니다.';
  }
  async function run(action: () => Promise<{ success: boolean; error?: string }>, message: string, fieldIds: string[] = []): Promise<void> {
    if (busy) return;
    busy = true;
    const draft = window.settingsDraft?.beforeSave(fieldIds);
    try {
      const result = await action();
      if (result.success) draft?.commit();
      if (status) status.textContent = result.success ? message : result.error || '처리하지 못했습니다.';
    } catch { if (status) status.textContent = '처리하지 못했습니다. 다시 시도해 주세요.'; }
    finally { busy = false; }
  }
  window.settingsActivityPresets = {
    bind(config) {
      if (!list) return;
      list.replaceChildren();
      for (const preset of config.activityPresets || []) {
        const row = document.createElement('div'); row.className = 'ui-preset-row';
        const title = document.createElement('div'); title.className = 'ui-preset-title';
        const input = document.createElement('input'); input.className = 'ui-input'; input.value = preset.name; input.maxLength = 32; input.setAttribute('aria-label', `${preset.name} 프리셋 이름`);
        // config-data로 행을 다시 만들어도 설정 초안·포커스가 같은 이름 입력란을 찾는다.
        input.id = `activity-preset-rename-${preset.id}`;
        const info = document.createElement('span'); info.className = 'ui-chip'; info.textContent = `${preset.openWindows.length}개 창`;
        const label = document.createElement('strong'); label.textContent = preset.name;
        const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'ui-button ui-button-small ui-button-primary'; apply.textContent = '적용';
        apply.addEventListener('click', () => { void run(() => api.applyActivityPreset(preset.id), '적용했습니다. 입력 중이던 미저장 설정은 유지됩니다.'); });
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'ui-button ui-button-small'; toggle.textContent = '상세';
        const detail = document.createElement('div'); detail.className = 'ui-preset-detail'; detail.id = `activity-preset-detail-${preset.id}`; detail.hidden = !expanded.has(preset.id);
        toggle.setAttribute('aria-expanded', String(!detail.hidden)); toggle.setAttribute('aria-controls', detail.id);
        toggle.addEventListener('click', () => {
          detail.hidden = !detail.hidden;
          if (detail.hidden) expanded.delete(preset.id); else expanded.add(preset.id);
          toggle.setAttribute('aria-expanded', String(!detail.hidden));
        });
        title.append(label, info, apply, toggle);
        const windows = document.createElement('p'); windows.className = 'ui-description'; windows.textContent = `열릴 창: ${preset.openWindows.map(key => windowNames[key] || key).join(', ') || '없음'}`;
        const changes = document.createElement('p'); changes.className = 'ui-description'; changes.textContent = describeChanges(preset, config);
        const hint = document.createElement('p'); hint.className = 'ui-description'; hint.textContent = '위 목록에 없는 활동 창은 닫힙니다. 기록과 메모는 유지됩니다. 창 크기와 위치는 현재 화면 범위에 맞춰집니다.';
        const rename = document.createElement('label'); rename.className = 'ui-preset-rename'; rename.textContent = '프리셋 이름'; rename.append(input);
        const controls = document.createElement('div'); controls.className = 'ui-preset-actions';
        detail.append(windows, changes, hint, rename, controls);
        row.append(title, detail);
        const actions: [string, () => Promise<{ success: boolean; error?: string }>, string][] = [
          ['현재 상태로 갱신', () => api.saveActivityPreset(input.value, preset.id), '현재 설정과 창 배치로 갱신했습니다.'],
          ['이름 변경', () => api.saveActivityPreset(input.value, preset.id, true), '이름을 변경했습니다.'],
          ['삭제', () => api.deleteActivityPreset(preset.id), '삭제했습니다.'],
        ];
        for (const [label, action, message] of actions) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
          button.className = `ui-button ui-button-small ${label === '삭제' ? 'ui-button-danger' : ''}`;
          button.addEventListener('click', () => { void run(action, message, label === '이름 변경' || label === '현재 상태로 갱신' ? [input.id] : []); }); controls.appendChild(button);
        }
        list.appendChild(row);
      }
      list.classList.toggle('ui-empty', !list.childElementCount);
      if (!list.childElementCount) list.textContent = '창을 원하는 상태로 배치한 뒤 첫 프리셋을 저장해 보세요.';
    },
  };
  document.getElementById('activity-preset-save')?.addEventListener('click', () => {
    if (name) void run(() => api.saveActivityPreset(name.value), '현재 설정과 창 배치를 저장했습니다. 독의 활동 프리셋 메뉴에서도 전환할 수 있습니다.');
  });
})();
