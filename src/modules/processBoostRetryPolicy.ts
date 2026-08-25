/** 같은 게임 PID의 우선순위 상승 실패를 single-flight 지수 백오프로 제한합니다. */
export class ProcessBoostRetryPolicy {
  private processId: number | null = null;
  private inFlight = false;
  private succeeded = false;
  private nextAttemptAt = 0;
  private nextDelayMs: number;

  constructor(
    private readonly initialDelayMs: number,
    private readonly maximumDelayMs: number,
  ) {
    this.nextDelayMs = initialDelayMs;
  }

  tryStart(processId: number, now: number): boolean {
    if (this.processId !== processId) this.resetForProcess(processId);
    if (this.succeeded || this.inFlight || now < this.nextAttemptAt) return false;
    this.inFlight = true;
    return true;
  }

  finish(processId: number, success: boolean, now: number): number | null {
    if (this.processId !== processId || !this.inFlight) return null;
    this.inFlight = false;
    if (success) {
      this.succeeded = true;
      this.nextAttemptAt = 0;
      this.nextDelayMs = this.initialDelayMs;
      return null;
    }

    const retryDelayMs = this.nextDelayMs;
    this.nextAttemptAt = now + retryDelayMs;
    this.nextDelayMs = Math.min(this.maximumDelayMs, retryDelayMs * 2);
    return retryDelayMs;
  }

  reset(): void {
    this.processId = null;
    this.inFlight = false;
    this.succeeded = false;
    this.nextAttemptAt = 0;
    this.nextDelayMs = this.initialDelayMs;
  }

  private resetForProcess(processId: number): void {
    this.reset();
    this.processId = processId;
  }
}
