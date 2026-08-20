/**
 * 매 분 00초에 맞춰 실행되는 단일 콜백 스케줄러.
 * 100ms 여유를 포함한 기존 알림 루프의 정렬 방식을 그대로 사용한다.
 */
export class MinuteAlignedScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public start(callback: () => void): boolean {
    if (this.running) return false;
    this.running = true;
    this.schedule(callback);
    return true;
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
