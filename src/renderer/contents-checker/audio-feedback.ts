/** 숙제 체크리스트 완료/획득 효과음 처리. */
(() => {
  function getVolume(config: { volumeContentsChecker?: number } | null | undefined): number {
    return (
      config?.volumeContentsChecker !== undefined
        ? config.volumeContentsChecker
        : 50
    ) / 100;
  }

  function play(config: { volumeContentsChecker?: number } | null | undefined, soundFile: string): void {
    const volume = getVolume(config);
    if (volume <= 0) return;
    const audio = new Audio(soundFile);
    audio.volume = volume;
    audio.play().catch(() => {});
  }

  function getCompletionSound(resetType: string): string {
    return resetType === 'daily' ? 'assets/sound/voice_wow.wav' : 'assets/sound/max_affection.wav';
  }

  window.contentsAudioFeedback = Object.freeze({ getVolume, play, getCompletionSound });
})();
