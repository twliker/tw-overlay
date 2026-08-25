import { promises as fsp } from 'fs';

const RETRYABLE_READ_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function getChatLogReadRetryDelayMs(attempt: number): number {
  return Math.min(800, 100 * (2 ** Math.max(0, attempt - 1)));
}

export function isRetryableChatLogReadError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && RETRYABLE_READ_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code || ''));
}

export async function readChatLogFileWithRetry(
  filePath: string,
  readFile: (target: string) => Promise<Buffer> = target => fsp.readFile(target),
  wait: (delayMs: number) => Promise<void> = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
): Promise<Buffer> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await readFile(filePath);
    } catch (error) {
      if (!isRetryableChatLogReadError(error) || attempt === maxAttempts) throw error;
      await wait(getChatLogReadRetryDelayMs(attempt));
    }
  }
  throw new Error('채팅 로그 읽기 재시도 상태가 올바르지 않습니다.');
}
