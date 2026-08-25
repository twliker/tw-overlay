import * as fs from 'fs';
import * as iconv from 'iconv-lite';
import { decodeChatLogBuffer, normalizeChatLogLines } from './chatLogNormalizer';
import type { ChatLogEncoding } from './chatLogNormalizer';

export const MAX_FULL_CHAT_LOG_BYTES = 32 * 1024 * 1024;
export const RECENT_CHAT_LOG_BYTES = 16 * 1024 * 1024;
export const CHAT_LOG_HEADER_BYTES = 64 * 1024;
export const MAX_RECENT_HISTORY_CHARS = 16 * 1024 * 1024;
export const TARGET_RECENT_HISTORY_CHARS = 12 * 1024 * 1024;

export interface InitialChatLogSnapshot {
  lines: string[];
  encoding: ChatLogEncoding;
  damaged: boolean;
  limited: boolean;
  fileSize: number;
}

interface InitialChatLogReadOptions {
  maxFullReadBytes?: number;
  recentReadBytes?: number;
  headerReadBytes?: number;
}

function readRange(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const bytesRead = fs.readSync(fd, buffer, totalRead, length - totalRead, start + totalRead);
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  return totalRead === length ? buffer : buffer.subarray(0, totalRead);
}

/**
 * 정상 크기 로그는 기존처럼 전부 읽고, 비정상적으로 큰 로그만 날짜 헤더와
 * 최근 구간으로 제한해 시작 시 전파일 버퍼/문자열 이중 적재를 피합니다.
 */
export function readInitialChatLogSnapshot(
  filePath: string,
  options: InitialChatLogReadOptions = {},
): InitialChatLogSnapshot {
  const maxFullReadBytes = options.maxFullReadBytes ?? MAX_FULL_CHAT_LOG_BYTES;
  const recentReadBytes = options.recentReadBytes ?? RECENT_CHAT_LOG_BYTES;
  const headerReadBytes = options.headerReadBytes ?? CHAT_LOG_HEADER_BYTES;
  const fileSize = fs.statSync(filePath).size;

  if (fileSize <= maxFullReadBytes) {
    const decoded = decodeChatLogBuffer(fs.readFileSync(filePath));
    return {
      lines: normalizeChatLogLines(decoded.content.split('\n')),
      encoding: decoded.encoding,
      damaged: decoded.damaged,
      limited: false,
      fileSize,
    };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const prefixLength = Math.min(headerReadBytes, fileSize);
    const recentStart = Math.max(prefixLength, fileSize - recentReadBytes);
    const prefixBuffer = readRange(fd, 0, prefixLength);
    const recentBuffer = readRange(fd, recentStart, fileSize - recentStart);

    // ASCII-only 헤더만으로 인코딩을 단정하지 않도록 최근 표본도 함께 비교합니다.
    const encodingProbe = Buffer.concat([prefixBuffer, Buffer.from('\n'), recentBuffer]);
    const detected = decodeChatLogBuffer(encodingProbe);
    const prefixText = iconv.decode(prefixBuffer, detected.encoding);
    let recentText = iconv.decode(recentBuffer, detected.encoding);

    // 최근 표본은 문자나 HTML 로그 행 중간에서 시작할 수 있으므로 첫 불완전 행을 버립니다.
    const firstNewline = recentText.indexOf('\n');
    recentText = firstNewline >= 0 ? recentText.slice(firstNewline + 1) : '';

    const prefixLines = prefixText.split('\n');
    if (prefixLength < fileSize) prefixLines.pop();
    const headerLines = prefixLines.slice(0, 25);
    const recentLines = normalizeChatLogLines(recentText.split('\n'));
    return {
      lines: headerLines.concat(recentLines),
      encoding: detected.encoding,
      damaged: detected.damaged,
      limited: true,
      fileSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function trimRecentChatLogLines(
  lines: readonly string[],
  maxChars = MAX_RECENT_HISTORY_CHARS,
  targetChars = TARGET_RECENT_HISTORY_CHARS,
): { lines: string[]; removedCount: number; totalChars: number } {
  let totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (totalChars <= maxChars) {
    return { lines: Array.from(lines), removedCount: 0, totalChars };
  }

  const safeTarget = Math.min(maxChars, Math.max(0, targetChars));
  let removedCount = 0;
  while (removedCount < lines.length && totalChars > safeTarget) {
    totalChars -= lines[removedCount].length + 1;
    removedCount++;
  }
  return { lines: Array.from(lines.slice(removedCount)), removedCount, totalChars };
}
