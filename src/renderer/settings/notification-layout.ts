interface Window { settingsNotificationLayout: { bind(config: Partial<BrowserAppConfig>): void; collect(): { settings: Record<string, unknown>; fieldIds: string[] } }; }

(() => {
  type Positions = import('../../shared/types').NotificationPositions;
  const api = window.electronAPI as typeof window.electronAPI & { previewNotificationPositions(positions: Positions): Promise<{ success: boolean; error?: string }> };
  const groups = ['center', 'buff', 'hunting', 'toast'] as const;
  const labels = ['게임 진행', '버프 만료', '입장·사냥', '독 알림'];
  const choices = [['default', '기존 위치'], ['top-left', '상단 왼쪽'], ['top-center', '상단 가운데'], ['top-right', '상단 오른쪽'], ['middle-left', '중앙 왼쪽'], ['middle-center', '정가운데'], ['middle-right', '중앙 오른쪽'], ['bottom-left', '하단 왼쪽'], ['bottom-center', '하단 가운데'], ['bottom-right', '하단 오른쪽']];
  const fieldIds = groups.map(group => `notification-position-${group}`);
  function positions(): Positions { return Object.fromEntries(groups.map(group => [group, (document.getElementById(`notification-position-${group}`) as HTMLSelectElement | null)?.value || 'default'])) as Positions; }
  function preview(): void {
    const stage = document.getElementById('notification-position-preview');
    if (!stage) return;
    stage.replaceChildren();
    groups.forEach((group, index) => {
      const value = positions()[group];
      const [vertical, horizontal] = value.split('-');
      const defaults = [[50, 45], [50, 24], [83, 14], [83, 70]];
      const x = value === 'default' ? defaults[index][0] : horizontal === 'left' ? 16 : horizontal === 'right' ? 84 : 50;
      const y = value === 'default' ? defaults[index][1] : vertical === 'top' ? 14 : vertical === 'bottom' ? 86 : 50;
      const chip = document.createElement('span'); chip.textContent = labels[index];
      chip.className = 'ui-notification-chip';
      chip.dataset.group = group;
      chip.style.left = `${x}%`;
      chip.style.top = `${y}%`;
      stage.appendChild(chip);
    });
  }
  fieldIds.forEach(id => {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (!select) return;
    select.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
    select.addEventListener('change', preview);
  });
  window.settingsNotificationLayout = {
    bind(config) {
      for (const group of groups) {
        const select = document.getElementById(`notification-position-${group}`) as HTMLSelectElement | null;
        if (select) select.value = config.notificationPositions?.[group] || 'default';
      }
      requestAnimationFrame(preview);
    },
    collect: () => ({ settings: { notificationPositions: positions() }, fieldIds }),
  };
  const status = document.getElementById('notification-position-status');
  document.getElementById('notification-position-save')?.addEventListener('click', async () => {
    const host = window as typeof window & { applySettingsWithDraft(settings: Record<string, unknown>, ids: string[]): Promise<{ success: boolean }> };
    try {
      const result = await host.applySettingsWithDraft({ notificationPositions: positions() }, fieldIds);
      if (status) status.textContent = result?.success ? '알림 위치를 저장했습니다.' : '저장하지 못했습니다.';
    } catch { if (status) status.textContent = '저장하지 못했습니다.'; }
  });
  document.getElementById('notification-position-test')?.addEventListener('click', async () => {
    try {
      const result = await api.previewNotificationPositions(positions());
      if (status) status.textContent = result.success ? '게임 화면에 5초간 표시합니다.' : result.error || '게임 화면을 먼저 열어 주세요.';
    } catch { if (status) status.textContent = '미리보기를 표시하지 못했습니다.'; }
  });
})();
