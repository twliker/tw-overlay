interface Window {
  settingsCompanion: { bind(config: Partial<BrowserAppConfig>): void; collect(keys?: string[]): { settings: Record<string, unknown>; fieldIds: string[] } };
}

(() => {
  const fields = [
    ['pinnedNoteEnabled', 'pinned-note-enabled', 'boolean'],
    ['pinnedNoteText', 'pinned-note-text', 'string'],
    ['pinnedNoteFontSize', 'pinned-note-font-size', 'number'],
    ['pinnedNoteColor', 'pinned-note-color', 'string'],
    ['pinnedNoteBackground', 'pinned-note-background', 'boolean'],
    ['windowSnapEnabled', 'window-snap-enabled', 'boolean'],
    ['supplyHelperEnabled', 'supply-helper-enabled', 'boolean'],
  ] as const;
  function preview(): void {
    const text = document.getElementById('pinned-note-preview');
    const input = document.getElementById('pinned-note-text') as HTMLTextAreaElement | null;
    if (text && input) text.textContent = input.value.trim() || '고정 메모를 적어 보세요.';
    if (text) {
      text.style.fontSize = `${(document.getElementById('pinned-note-font-size') as HTMLInputElement)?.value || 14}px`;
      text.style.color = (document.getElementById('pinned-note-color') as HTMLInputElement)?.value || '#ffffff';
      text.classList.toggle('note-text-only', !(document.getElementById('pinned-note-background') as HTMLInputElement)?.checked);
    }
  }
  function collect(keys?: string[]) {
    const settings: Record<string, unknown> = {};
    const fieldIds: string[] = [];
    for (const [key, id, type] of fields) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input || (keys && !keys.includes(key))) continue;
      settings[key] = type === 'boolean' ? input.checked : type === 'number' ? Number(input.value) : input.value;
      fieldIds.push(id);
    }
    return { settings, fieldIds };
  }
  window.settingsCompanion = {
    collect,
    bind(config) {
      for (const [key, id, type] of fields) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (!input) continue;
        const value = config[key] ?? (window.electronAPI as typeof window.electronAPI & { DEFAULT_CONFIG: BrowserAppConfig }).DEFAULT_CONFIG?.[key];
        if (type === 'boolean') input.checked = value === true;
        else input.value = String(value ?? '');
      }
      requestAnimationFrame(preview);
    },
  };
  for (const [, id] of fields) document.getElementById(id)?.addEventListener('input', preview);
  document.querySelectorAll<HTMLButtonElement>('[data-save-companion]').forEach(button => {
    const keys = button.dataset.saveCompanion?.split(',');
    const status = button.nextElementSibling;
    let editRevision = 0;
    for (const id of collect(keys).fieldIds) {
      document.getElementById(id)?.addEventListener('input', () => {
        editRevision++;
        if (status) status.textContent = '';
      });
    }
    button.addEventListener('click', async () => {
      const { settings, fieldIds } = collect(keys);
      const host = window as typeof window & { applySettingsWithDraft(settings: Record<string, unknown>, ids: string[]): Promise<{ success: boolean }> };
      const submittedRevision = editRevision;
      button.disabled = true;
      try {
        const result = await host.applySettingsWithDraft(settings, fieldIds);
        if (status && submittedRevision === editRevision) status.textContent = result?.success ? '저장했습니다.' : '저장하지 못했습니다.';
      } catch { if (status && submittedRevision === editRevision) status.textContent = '저장하지 못했습니다.'; }
      finally { button.disabled = false; }
    });
  });
})();
