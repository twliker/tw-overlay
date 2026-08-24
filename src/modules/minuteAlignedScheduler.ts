import { powerMonitor } from 'electron';

/**
 * 매 분 00초에 맞춰 실행되는 단일 콜백 스케줄러.
 * 100ms 여유를 포함한 기존 알림 루프의 정렬 방식을 사용하며,
 * 시스템 절전 모드 복귀(resume) 시 즉시 오차를 보정하고 재정렬한다.
 */
export class MinuteAlignedScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentCallback: (() => void) | null = null;
  private resumeHandler: (() => void) | null = null;

  public start(callback: () => void): boolean {
    if (this.running) return false;
    this.running = true;
    this.currentCallback = callback;

    if (!this.resumeHandler) {
      this.resumeHandler = () => {
        if (!this.running || !this.currentCallback) return;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        // 절전 모드 복귀 시 1초 후 즉시 체크 및 다음 분 00초 재정렬
        setTimeout(() => {
          if (!this.running || !this.currentCallback) return;
          this.currentCallback();
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
      callback();
      this.schedule(callback);
    }, millisecondsUntilNextMinute);
  }
}
