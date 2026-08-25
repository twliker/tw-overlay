export type ShutdownRequestDecision = 'start' | 'wait' | 'allow';
export type ShutdownDrainOutcome = 'flushed' | 'timeout' | 'failed';

export interface ShutdownGate {
  requestQuit(): ShutdownRequestDecision;
  allowFinalQuit(): void;
}

/** 첫 quit만 종료 작업을 시작하고, 작업 중 재진입은 막으며 finalizer의 quit만 통과시킨다. */
export function createShutdownGate(): ShutdownGate {
  let started = false;
  let finalAllowed = false;
  return {
    requestQuit(): ShutdownRequestDecision {
      if (finalAllowed) return 'allow';
      if (started) return 'wait';
      started = true;
      return 'start';
    },
    allowFinalQuit(): void {
      finalAllowed = true;
    },
  };
}

/** flush rejection을 소비하고 제한시간 결과를 명시적으로 반환한다. */
export async function drainShutdownTask(
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<ShutdownDrainOutcome> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task.then(() => 'flushed' as const, () => 'failed' as const),
      new Promise<'timeout'>(resolve => {
        timeout = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
