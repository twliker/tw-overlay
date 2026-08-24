import { powerMonitor } from 'electron';

const MISSED_MINUTE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
  private timer: NodeJS.Timeout | null = null;
  private resumeDelayTimer: NodeJS.Timeout | null = null;
  private running = false;
  private currentCallback: (() => void) | null = null;
  private missedMinutesCallback: ((timestamps: number[]) => void) | null = null;
  private resumeHandler: (() => void) | null = null;
  private lastCheckedAt = 0;

  public start(callback: () => void, onMissedMinutes?: (timestamps: number[]) => void): boolean {
    if (this.running) return false;
    this.running = true;
    this.currentCallback = callback;
    this.missedMinutesCallback = onMissedMinutes || null;
    this.lastCheckedAt = Date.now();

    if (!this.resumeHandler) {
      this.resumeHandler = () => {
        if (!this.running || !this.currentCallback) return;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        if (this.resumeDelayTimer) {
          clearTimeout(this.resumeDelayTimer);
          this.resumeDelayTimer = null;
        }
        const resumedAt = Date.now();
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
        this.resumeDelayTimer = setTimeout(() => {
          this.resumeDelayTimer = null;
          if (!this.running || !this.currentCallback) return;
          this.currentCallback();
          this.lastCheckedAt = Date.now();
          this.schedule(this.currentCallback);
        }, 1000);
      };
      powerMonitor.on('resume', this.resumeHandler);
      powerMonitor.on('unlock-screen', this.resumeHandler);
    }

    this.schedule(callback);
    return true;
  }

  public stop(): void {
    this.running = false;
    this.currentCallback = null;
    this.missedMinutesCallback = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.resumeDelayTimer) {
      clearTimeout(this.resumeDelayTimer);
      this.resumeDelayTimer = null;
    }
    if (this.resumeHandler) {
      powerMonitor.removeListener('resume', this.resumeHandler);
      powerMonitor.removeListener('unlock-screen', this.resumeHandler);
      this.resumeHandler = null;
    }
  }

  private schedule(callback: () => void): void {
    if (!this.running) return;
    const now = new Date();
    const millisecondsUntilNextMinute =
      60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 100;

    this.timer = setTimeout(() => {
      this.timer = null;
      callback();
      this.lastCheckedAt = Date.now();
      this.schedule(callback);
    }, millisecondsUntilNextMinute);
  }
}
