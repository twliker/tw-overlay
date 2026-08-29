/** 설정 창의 알림음 미리듣기 입력 처리. */
(() => {
  function previewAlertSound({
    soundElementId,
    volumeElementId,
    label,
    fallbackSound = null,
    fallbackVolume,
    allowNone = false,
  }: {
    soundElementId: string;
    volumeElementId: string;
    label: string;
    fallbackSound?: string | null;
    fallbackVolume: number;
    allowNone?: boolean;
  }): void {
    const soundElement = document.getElementById(soundElementId) as HTMLSelectElement | null;
    const volumeElement = document.getElementById(volumeElementId) as HTMLInputElement | null;
    const sound = soundElement?.value || fallbackSound;
    if (!sound || (!allowNone && sound === 'none')) return;
    const parsedVolume = parseInt(volumeElement?.value ?? '', 10);
    const volume = Number.isFinite(parsedVolume) ? parsedVolume : fallbackVolume;
    window.playPreview(sound, volume, label);
  }

  window.settingsSoundPreview = Object.freeze({ previewAlertSound });
})();
