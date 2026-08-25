import { powerMonitor } from 'electron';

const MISSED_MINUTE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type ScheduledTimer = ReturnType<typeof setTimeout>;
type MinuteCallback = () => void | Promise<void>;

export interface MinuteSchedulerRuntime {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
  onPowerEvent(event: 'resume' | 'unlock-screen', listener: () => void): void;
  removePowerEventListener(event: 'resume' | 'unlock-screen', listener: () => void): void;
}

const defaultRuntime: MinuteSchedulerRuntime = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
  onPowerEvent: (event, listener) => {
    if (event === 'resume') powerMonitor.on('resume', listener);
    else powerMonitor.on('unlock-screen', listener);
  },
  removePowerEventListener: (event, listener) => {
    if (event === 'resume') powerMonitor.removeListener('resume', listener);
    else powerMonitor.removeListener('unlock-screen', listener);
  },
};

/** 마지막 정상 검사 뒤 절전으로 완전히 지나간 분(현재 분 제외)의 시작 시각 목록을 반환한다. */
export function getMissedMinuteTimestamps(
  lastCheckedAt: number,
  resumedAt: number,
  maxLookbackMs: number = MISSED_MINUTE_LOOKBACK_MS
): number[] {
  if (!Number.isFinite(lastCheckedAt) || !Number.isFinite(resumedAt) || resumedAt <= lastCheckedAt) return [];
  const safeLookback = Math.max(0, Math.min(MISSED_MINUTE_LOOKBACK_MS, maxLookbackMs));
  const effectiveStart = Math.max(lastCheckedAt, resumedAt - safeLookback);
  const currentMinuteStart = Math.floor(resumedAt / 60_000) * 60_000;
  const firstMissedMinute = Math.floor(effectiveStart / 60_000) * 60_000 + 60_000;
  const missed: number[] = [];
  for (let timestamp = firstMissedMinute; timestamp < currentMinuteStart; timestamp += 60_000) {
    missed.push(timestamp);
  }
  return missed;
}

/**
 * 매 분 00초에 맞춰 실행되는 단일 콜백 스케줄러.
 * 100ms 여유를 포함한 기존 알림 루프의 정렬 방식을 사용하며,
 * 시스템 절전 모드 복귀(resume) 시 즉시 오차를 보정하고 재정렬한다.
 */
export class MinuteAlignedScheduler {
  private timer: ScheduledTimer | null = null;
  private resumeDelayTimer: ScheduledTimer | null = null;
  private running = false;
  private callbackInFlightGeneration: number | null = null;
  private generation = 0;
  private currentCallback: MinuteCallback | null = null;
  private missedMinutesCallback: ((timestamps: number[]) => void) | null = null;
  private resumeHandler: (() => void) | null = null;
  private lastCheckedAt = 0;

  public constructor(private readonly runtime: MinuteSchedulerRuntime = defaultRuntime) {}

  public start(callback: MinuteCallback, onMissedMinutes?: (timestamps: number[]) => void): boolean {
    if (this.running) return false;
    this.running = true;
    const generation = ++this.generation;
    this.currentCallback = callback;
    this.missedMinutesCallback = onMissedMinutes || null;
    this.lastCheckedAt = this.runtime.now();

    if (!this.resumeHandler) {
      this.resumeHandler = () => {
        if (!this.running || !this.currentCallback) return;
        const resumeGeneration = ++this.generation;
        this.clearScheduledTimers();
        const resumedAt = this.runtime.now();
        const missedMinutes = getMissedMinuteTimestamps(this.lastCheckedAt, resumedAt);
        this.lastCheckedAt = resumedAt;
        if (missedMinutes.length > 0 && this.missedMinutesCallback) {
          try {
            this.missedMinutesCallback(missedMinutes);
          } catch (error) {
            // 이력 기록 실패가 현재 분 검사와 다음 분 재정렬까지 중단시키면 안 된다.
            console.error('[MinuteAlignedScheduler] missed-minute callback failed:', error);
          }
        }
        // 절전 모드 복귀 시 1초 후 즉시 체크 및 다음 분 00초 재정렬
        this.resumeDelayTimer = this.runtime.setTimeout(() => {
          this.resumeDelayTimer = null;
          void this.runTick(resumeGeneration);
        }, 1000);
      };
      this.runtime.onPowerEvent('resume', this.resumeHandler);
      this.runtime.onPowerEvent('unlock-screen', this.resumeHandler);
    }

    this.schedule(generation);
    return true;
  }

  public stop(): void {
    this.running = false;
    this.generation += 1;
    this.currentCallback = null;
    this.missedMinutesCallback = null;
    this.clearScheduledTimers();
    if (this.resumeHandler) {
      this.runtime.removePowerEventListener('resume', this.resumeHandler);
      this.runtime.removePowerEventListener('unlock-screen', this.resumeHandler);
      this.resumeHandler = null;
    }
  }

  private clearScheduledTimers(): void {
    if (this.timer) {
      this.runtime.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.resumeDelayTimer) {
      this.runtime.clearTimeout(this.resumeDelayTimer);
      this.resumeDelayTimer = null;
    }
  }

  private schedule(generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    if (this.timer) this.runtime.clearTimeout(this.timer);
    const now = this.runtime.now();
    const millisecondsUntilNextMinute = 60_000 - (now % 60_000) + 100;

    this.timer = this.runtime.setTimeout(() => {
      this.timer = null;
      void this.runTick(generation);
    }, millisecondsUntilNextMinute);
  }

  private async runTick(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation) || !this.currentCallback) return;
    if (this.callbackInFlightGeneration !== null) {
      this.schedule(generation);
      return;
    }

    const callback = this.currentCallback;
    this.callbackInFlightGeneration = generation;
    this.lastCheckedAt = this.runtime.now();
    try {
      await callback();
    } catch (error) {
      console.error('[MinuteAlignedScheduler] callback failed:', error);
    } finally {
      if (this.callbackInFlightGeneration === generation) {
        this.callbackInFlightGeneration = null;
      }
      if (this.isCurrentGeneration(generation)) this.schedule(generation);
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.running && generation === this.generation;
  }
}
