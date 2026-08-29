/** 설정 화면의 알림음 선택 목록과 볼륨 음소거 상태를 관리합니다. */
(() => {
  interface AlertSoundConfig {
    waveMonsterWarningSound?: string;
    ethosAlertSound?: string;
    abyssApostleStartSound?: string;
    abyssApostleEndSound?: string;
    lokagosAlertSound?: string;
    questCompleteAlertSound?: string;
    abyssTreasureAlertSound?: string;
  }

  const defaultConfig = (window.electronAPI as typeof window.electronAPI & {
    DEFAULT_CONFIG: Required<AlertSoundConfig>;
  }).DEFAULT_CONFIG;

  const ALERT_SOUND_SELECTS = Object.freeze([
    { id: 'wave-warning-sound', configKey: 'waveMonsterWarningSound' },
    { id: 'ethos-alert-sound', configKey: 'ethosAlertSound' },
    { id: 'abyss-apostle-start-sound', configKey: 'abyssApostleStartSound' },
    { id: 'abyss-apostle-end-sound', configKey: 'abyssApostleEndSound' },
    { id: 'lokagos-alert-sound', configKey: 'lokagosAlertSound' },
    { id: 'quest-complete-alert-sound', configKey: 'questCompleteAlertSound' },
    { id: 'abyss-treasure-alert-sound', configKey: 'abyssTreasureAlertSound' },
  ] as const);

  const previousVolumes: Record<string, number> = {
    'contents-checker': 50,
    calculators: 50,
  };

  function replaceAlertSoundOptions(select: HTMLSelectElement, soundFiles: SoundListItem[]): void {
    const fragment = document.createDocumentFragment();
    const noneOption = document.createElement('option');
    noneOption.value = 'none';
    noneOption.textContent = '사용 안 함 (소리 없음)';
    fragment.appendChild(noneOption);

    soundFiles.forEach(sound => {
      const option = document.createElement('option');
      option.value = String(sound.file).slice(0, 500);
      option.textContent = String(sound.name).slice(0, 300);
      fragment.appendChild(option);
    });

    select.replaceChildren(fragment);
  }

  async function populateAlertSoundSelects(preserveValues: boolean): Promise<void> {
    const soundFiles = await window.loadSoundList();
    if (!soundFiles) return;
    ALERT_SOUND_SELECTS.forEach(({ id }) => {
      const select = document.getElementById(id) as HTMLSelectElement | null;
      if (!select) return;
      const previousValue = select.value;
      replaceAlertSoundOptions(select, soundFiles);
      if (preserveValues) select.value = previousValue;
    });
  }

  function applyAlertSoundConfig(config: AlertSoundConfig): void {
    ALERT_SOUND_SELECTS.forEach(({ id, configKey }) => {
      const select = document.getElementById(id) as HTMLSelectElement | null;
      if (select) select.value = config[configKey] || defaultConfig[configKey];
    });
  }

  function updateMuteButtonState(type: string, value: string | number): void {
    const button = document.getElementById(`mute-${type}`);
    if (!button) return;
    if (parseInt(String(value), 10) === 0) {
      button.innerHTML = '<i data-lucide="volume-x" class="w-3.5 h-3.5"></i> 음소거 해제';
      button.classList.add('text-red-400', 'border-red-500/30');
      button.classList.remove('text-slate-400', 'border-white/10');
    } else {
      button.innerHTML = '<i data-lucide="volume-2" class="w-3.5 h-3.5"></i> 음소거';
      button.classList.remove('text-red-400', 'border-red-500/30');
      button.classList.add('text-slate-400', 'border-white/10');
    }
    window.refreshIcons();
  }

  function toggleMute(type: string): void {
    const slider = document.getElementById(`volume-${type}`) as HTMLInputElement | null;
    const valueLabel = document.getElementById(`volume-${type}-val`);
    if (!slider || !valueLabel) return;

    const current = parseInt(slider.value, 10);
    if (current > 0) {
      previousVolumes[type] = current;
      slider.value = '0';
    } else {
      slider.value = String(previousVolumes[type] || 50);
    }
    valueLabel.innerText = `${slider.value}%`;
    updateMuteButtonState(type, slider.value);
  }

  function bindVolumeControl(type: string, initialValue: number): void {
    const slider = document.getElementById(`volume-${type}`) as HTMLInputElement | null;
    const valueLabel = document.getElementById(`volume-${type}-val`);
    if (!slider || !valueLabel) return;

    slider.value = String(initialValue);
    valueLabel.innerText = `${initialValue}%`;
    if (initialValue > 0) previousVolumes[type] = initialValue;
    slider.oninput = event => {
      const value = (event.target as HTMLInputElement).value;
      valueLabel.innerText = `${value}%`;
      updateMuteButtonState(type, value);
      const numericValue = parseInt(value, 10);
      if (numericValue > 0) previousVolumes[type] = numericValue;
    };
    updateMuteButtonState(type, initialValue);
  }

  window.toggleMute = toggleMute;
  window.settingsAudioControls = Object.freeze({
    initializeAlertSoundSelects: () => populateAlertSoundSelects(false),
    refreshAlertSoundSelects: () => populateAlertSoundSelects(true),
    applyAlertSoundConfig,
    bindVolumeControl,
    toggleMute,
  });
})();
