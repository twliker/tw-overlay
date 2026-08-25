/** 사이드바 알림 사운드의 큐, 재생 수명, 중복 제한을 한 경계에서 관리한다. */

(() => {
type PlaybackAudio = Pick<HTMLAudioElement, 'onended' | 'pause' | 'play' | 'volume'>;

interface QueuedSound {
  soundFile: string;
  volume?: number | null;
}

interface AudioPlaybackOptions {
  createAudio?: (sourceUrl: string) => PlaybackAudio;
  getDefaultVolume?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  createCacheToken?: () => string;
  transitionDelayMs?: number;
  onError?: (error: unknown) => void;
}

interface SoundThrottleOptions {
  intervalMs?: number;
  maxEntries?: number;
  now?: () => number;
}

function buildSoundUrl(soundFile: string, cacheToken: string): string {
  const soundType = soundFile.startsWith('custom_') ? 'custom' : 'default';
  return `tw-sound://${soundType}/${soundFile}?t=${cacheToken}`;
}

window.createAudioPlaybackController = function (options: AudioPlaybackOptions = {}) {
  const createAudio = options.createAudio || (sourceUrl => new Audio(sourceUrl));
  const getDefaultVolume = options.getDefaultVolume || (() => 0.5);
  const scheduleTimeout = options.setTimeout || ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimeout = options.clearTimeout || (timer => clearTimeout(timer));
  const createCacheToken = options.createCacheToken
    || (() => Math.random().toString(36).substring(2, 9));
  const transitionDelayMs = Math.max(0, options.transitionDelayMs ?? 500);
  const onError = options.onError || (error => console.error('Audio play failed:', error));

  const queue: QueuedSound[] = [];
  let generation = 0;
  let currentAudio: PlaybackAudio | null = null;
  let transitionTimer: ReturnType<typeof setTimeout> | null = null;
  let playing = false;

  const clearTransitionTimer = (): void => {
    if (transitionTimer === null) return;
    cancelTimeout(transitionTimer);
    transitionTimer = null;
  };

  const releaseCurrentAudio = (): void => {
    if (!currentAudio) return;
    try {
      currentAudio.onended = null;
      currentAudio.pause();
    } catch {
      // 이미 폐기된 브라우저 오디오 객체 정리 실패는 새 재생을 막지 않는다.
    }
    currentAudio = null;
  };

  const scheduleNext = (ownedGeneration: number): void => {
    if (ownedGeneration !== generation) return;
    clearTransitionTimer();
    transitionTimer = scheduleTimeout(() => {
      transitionTimer = null;
      playNext(ownedGeneration);
    }, transitionDelayMs);
  };

  const finishAudio = (audio: PlaybackAudio, ownedGeneration: number, error?: unknown): void => {
    if (ownedGeneration !== generation || currentAudio !== audio) return;
    audio.onended = null;
    currentAudio = null;
    const errorName = error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name)
      : '';
    if (error && errorName !== 'AbortError') onError(error);
    scheduleNext(ownedGeneration);
  };

  const playNext = (ownedGeneration: number = generation): void => {
    if (ownedGeneration !== generation) return;
    const next = queue.shift();
    if (!next) {
      playing = false;
      return;
    }

    playing = true;
    releaseCurrentAudio();
    const audio = createAudio(buildSoundUrl(next.soundFile, createCacheToken()));
    currentAudio = audio;
    audio.volume = next.volume !== undefined && next.volume !== null
      ? next.volume / 100
      : getDefaultVolume();
    audio.onended = () => finishAudio(audio, ownedGeneration);
    try {
      void audio.play().catch(error => finishAudio(audio, ownedGeneration, error));
    } catch (error) {
      finishAudio(audio, ownedGeneration, error);
    }
  };

  const enqueue = (sound: QueuedSound): void => {
    queue.push(sound);
    if (!playing) playNext();
  };

  return Object.freeze({
    enqueue,
    interruptAndPlay(sound: QueuedSound): void {
      generation += 1;
      queue.length = 0;
      clearTransitionTimer();
      releaseCurrentAudio();
      playing = false;
      enqueue(sound);
    },
    dispose(): void {
      generation += 1;
      queue.length = 0;
      clearTransitionTimer();
      releaseCurrentAudio();
      playing = false;
    },
    pendingCount: () => queue.length,
    isPlaying: () => playing,
  });
};

window.createSoundThrottle = function (options: SoundThrottleOptions = {}) {
  const intervalMs = Math.max(0, options.intervalMs ?? 800);
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 128));
  const now = options.now || (() => performance.now());
  const playedAt = new Map<string, number>();

  return Object.freeze({
    shouldPlay(soundFile: string): boolean {
      const current = now();
      for (const [key, timestamp] of playedAt) {
        if (current < timestamp || current - timestamp >= intervalMs) playedAt.delete(key);
      }

      const previous = playedAt.get(soundFile);
      if (previous !== undefined && current - previous < intervalMs) return false;

      playedAt.delete(soundFile);
      playedAt.set(soundFile, current);
      while (playedAt.size > maxEntries) {
        const oldestKey = playedAt.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        playedAt.delete(oldestKey);
      }
      return true;
    },
    clear(): void {
      playedAt.clear();
    },
    size: () => playedAt.size,
  });
};
})();
