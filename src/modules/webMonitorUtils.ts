/**
 * 게시판 모니터가 공유하는 요청 간격, 백오프, HTTPS 텍스트 요청 유틸리티.
 * 사이트별 헤더/타임아웃/로그 접두사는 호출부가 제공해 기존 동작을 유지한다.
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
  skipSslVerify = false,
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
    if (skipSslVerify) requestOptions.rejectUnauthorized = false;

    const request = https.get(url, requestOptions, response => {
      if (
        response.statusCode
        && response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
      ) {
        fetchTextWithSslRetry(
          response.headers.location,
          options,
          skipSslVerify,
          maxRedirects - 1,
        ).then(resolve).catch(reject);
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

    request.on('error', error => {
      const isSslError = error.message.includes('certificate')
        || error.message.includes('SSL')
        || error.message.includes('CERT');
      if (!skipSslVerify && isSslError) {
        options.onSslRetry(error.message);
        fetchTextWithSslRetry(url, options, true, maxRedirects).then(resolve).catch(reject);
        return;
      }
      reject(error);
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}
