/** 설정 화면의 전역 단축키 녹화와 기본값 복원을 관리합니다. */
(() => {
  type ShortcutMap = Record<string, string>;

  const shortcutApi = window.electronAPI as typeof window.electronAPI & {
    DEFAULT_CONFIG: { shortcuts: ShortcutMap };
    shortcutsUnregister?: () => void;
    shortcutsRegister?: () => void;
  };
  const DEFAULT_SHORTCUTS: Readonly<ShortcutMap> = Object.freeze({
    ...shortcutApi.DEFAULT_CONFIG.shortcuts,
  });
  let recordingKey: string | null = null;
  let shortcuts: ShortcutMap = { ...DEFAULT_SHORTCUTS };

  const shortcutInput = (key: string): HTMLInputElement | null =>
    document.getElementById(`shortcut-${key}`) as HTMLInputElement | null;

  function updateDockShortcutGuide(): void {
    const guide = document.getElementById('dock-shortcut-guide');
    if (guide) guide.innerText = (shortcuts.toggleDock || DEFAULT_SHORTCUTS.toggleDock).replace('CommandOrControl', 'Ctrl');
  }

  function stopRecording(): void {
    if (!recordingKey) return;
    const key = recordingKey;
    recordingKey = null;
    shortcutApi.shortcutsRegister?.();

    const input = shortcutInput(key);
    if (input) {
      input.value = shortcuts[key] || '';
      input.classList.remove('animate-pulse', '!border-purple-500', 'ring-2', 'ring-purple-500/20');
    }
  }

  function recordShortcut(key: string): void {
    const input = shortcutInput(key);
    if (!input) return;
    if (recordingKey === key) {
      stopRecording();
      return;
    }

    stopRecording();
    recordingKey = key;
    shortcutApi.shortcutsUnregister?.();
    input.value = '키를 입력하세요...';
    input.classList.add('animate-pulse', '!border-purple-500', 'ring-2', 'ring-purple-500/20');
  }

  function resetShortcut(key: string): void {
    const defaultValue = DEFAULT_SHORTCUTS[key];
    if (!defaultValue) return;
    shortcuts[key] = defaultValue;
    const input = shortcutInput(key);
    if (input) input.value = defaultValue;
    if (key === 'toggleDock') updateDockShortcutGuide();
  }

  function electronShortcutKey(event: KeyboardEvent): string | null {
    const keys: string[] = [];
    if (event.ctrlKey || event.metaKey) keys.push('CommandOrControl');
    if (event.altKey) keys.push('Alt');
    if (event.shiftKey) keys.push('Shift');

    const keyCode = event.code;
    let keyChar = event.key.toUpperCase();
    if (['CONTROL', 'ALT', 'SHIFT', 'META'].includes(keyChar)) return null;

    if (keyCode.startsWith('Numpad')) {
      if (keyCode.length === 7 && keyCode[6] >= '0' && keyCode[6] <= '9') keyChar = `num${keyCode[6]}`;
      else if (keyCode === 'NumpadDecimal') keyChar = 'numdec';
      else if (keyCode === 'NumpadAdd') keyChar = 'numadd';
      else if (keyCode === 'NumpadSubtract') keyChar = 'numsub';
      else if (keyCode === 'NumpadMultiply') keyChar = 'nummult';
      else if (keyCode === 'NumpadDivide') keyChar = 'numdiv';
      else keyChar = keyCode;
    } else if (keyCode.startsWith('Key')) keyChar = keyCode.replace('Key', '');
    else if (keyCode.startsWith('Digit')) keyChar = keyCode.replace('Digit', '');
    else if (keyCode === 'Space') keyChar = 'Space';
    else if (keyCode === 'ArrowUp') keyChar = 'Up';
    else if (keyCode === 'ArrowDown') keyChar = 'Down';
    else if (keyCode === 'ArrowLeft') keyChar = 'Left';
    else if (keyCode === 'ArrowRight') keyChar = 'Right';
    else if (keyCode === 'Escape') keyChar = 'Esc';
    else if (keyCode === 'Enter') keyChar = 'Return';
    else if (keyCode.startsWith('F') && keyCode.length <= 3) keyChar = keyCode;

    keys.push(keyChar);
    return keys.join('+');
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!recordingKey) return false;
    event.preventDefault();
    event.stopPropagation();
    const shortcut = electronShortcutKey(event);
    if (!shortcut) return true;

    const key = recordingKey;
    shortcuts[key] = shortcut;
    const input = shortcutInput(key);
    if (input) input.value = shortcut;
    stopRecording();
    // 기존 동작과 동일하게 녹화 완료 시에는 독 안내를 즉시 다시 쓰지 않습니다.
    return true;
  }

  function mergeShortcuts(saved: ShortcutMap | null | undefined): void {
    if (saved) shortcuts = { ...shortcuts, ...saved };
  }

  function renderInputs(): void {
    Object.keys(shortcuts).forEach(key => {
      const input = shortcutInput(key);
      if (input) input.value = shortcuts[key];
    });
    updateDockShortcutGuide();
  }

  window.recordShortcut = recordShortcut;
  window.resetShortcut = resetShortcut;
  window.settingsShortcuts = Object.freeze({
    getShortcuts: () => shortcuts,
    mergeShortcuts,
    renderInputs,
    handleKeyDown,
    stopRecording,
  });
})();
