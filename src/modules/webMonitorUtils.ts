/**
 * 게시판 모니터가 공유하는 요청 간격, 백오프, HTTPS 텍스트 요청 유틸리티.
 * 인증서 검증 오류는 연결 실패로 전달하며 검증을 자동 해제하지 않는다.
 */
import * as https from 'https';

export const MONITOR_CHECK_INTERVAL_MS = 300000;
export const MONITOR_RATE_LIMIT = Object.freeze({
  MIN_DELAY_MS: 1500,
  MAX_DELAY_MS: 3000,
  BACKOFF_BASE_MS: 60000,
  MAX_BACKOFF_MS: 300000,
});

export interface FetchTextOptions {
  headers: https.RequestOptions['headers'];
  timeoutMs: number;
  onSslRetry: (message: string) => void;
}

export function waitRandomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, Math.floor(ms)));
}

export function calculateBackoffMs(
  consecutiveErrors: number,
  baseMs: number,
  maxMs: number,
): number {
  if (consecutiveErrors <= 0) return 0;
  return Math.min(baseMs * Math.pow(2, consecutiveErrors - 1), maxMs);
}

export function fetchTextWithSslRetry(
  url: string,
  options: FetchTextOptions,
  _legacySkipSslVerify = false,
  maxRedirects = 5,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Max redirects exceeded'));
      return;
    }

    const requestOptions: https.RequestOptions = {
      headers: options.headers,
      timeout: options.timeoutMs,
    };

    const request = https.get(url, requestOptions, response => {
      response.on('error', reject);
      if (
        response.statusCode
        && response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
      ) {
        fetchTextWithSslRetry(
          new URL(response.headers.location, url).toString(),
          options,
          false,
          maxRedirects - 1,
        ).then(resolve).catch(reject);
        response.resume();
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      let data = '';
      response.setEncoding('utf-8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve(data));
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}
