/**
 * 실제 테일즈위버 오늘 로그를 읽기 전용으로 사용하는 실시간 catch-up 수동 검증 도구입니다.
 *
 * - 사용자 로그 파일에는 절대 쓰지 않고, 최초 완전한 물리 줄 다음 위치만 snapshot 경계로 잡습니다.
 * - 게임이 새 완전한 줄을 기록할 때까지 기다린 뒤 snapshot 이후 구간을 catch-up하여 실제 인코딩과
 *   HTML 줄 경계가 손상되지 않는지 확인합니다.
 * - catch-up 뒤에도 게임이 새 줄을 쓰면 일반 Tail watcher가 같은 manager로 이어받는지 확인합니다.
 * - chatLogProcessor를 시작하지 않으므로 사용자 모험일지·오늘 요약·알림에는 영향을 주지 않습니다.
 */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-live-catch-up-'));
app.setPath('userData', isolatedUserData);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function finish(exitCode: number): never {
  try {
    fs.rmSync(isolatedUserData, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  } catch {
    // 읽기 전용 검증 결과를 임시 폴더 정리 지연으로 가리지 않습니다.
  }
  return (process as NodeJS.Process & { reallyExit(code: number): never }).reallyExit(exitCode);
}

async function waitForCompleteGrowth(
  filePath: string,
  afterOffset: number,
  findBoundary: (target: string, size?: number) => number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const boundary = findBoundary(filePath);
    if (boundary > afterOffset) return boundary;
    await sleep(100);
  }
  throw new Error(`${timeoutMs / 1000}초 안에 오늘 채팅 로그의 새 완전한 줄을 확인하지 못했습니다.`);
}

async function run(): Promise<void> {
  const filePath = path.resolve(process.argv[2] || '');
  assert.equal(fs.existsSync(filePath), true, `오늘 채팅 로그 파일이 없습니다: ${filePath}`);
  const fileNameMatch = path.basename(filePath).match(/^TWChatLog_(\d{4})_(\d{2})_(\d{2})\.html$/i);
  assert.ok(fileNameMatch, `오늘 채팅 로그 파일명이 올바르지 않습니다: ${path.basename(filePath)}`);

  const { ChatLogManager } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogManager.js')) as {
    ChatLogManager: new () => Record<string, unknown>;
  };
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js')) as {
    chatParser: { setCurrentDate(date: string): void };
  };
  const {
    findLastCompleteChatLogOffset,
    readInitialChatLogSnapshot,
  } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogFileReader.js')) as {
    findLastCompleteChatLogOffset(target: string, size?: number): number;
    readInitialChatLogSnapshot(target: string): { encoding: 'utf8' | 'euc-kr'; damaged: boolean };
  };

  const dateStr = `${fileNameMatch[1]}-${fileNameMatch[2]}-${fileNameMatch[3]}`;
  const initialSnapshot = readInitialChatLogSnapshot(filePath);
  assert.equal(initialSnapshot.damaged, false, '오늘 채팅 로그에서 손상된 문자를 감지했습니다.');
  chatParser.setCurrentDate(dateStr);

  const initialBoundary = findLastCompleteChatLogOffset(filePath);
  const manager = new ChatLogManager() as Record<string, any>;
  manager._syncPaused = true;
  manager._syncPauseSequence = 1;
  manager._chatLogEncoding = initialSnapshot.encoding;

  let processedLines = 0;
  const originalProcessNormalizedLine = manager.processNormalizedLine.bind(manager);
  manager.processNormalizedLine = (line: string): void => {
    processedLines++;
    originalProcessNormalizedLine(line);
  };

  try {
    const catchUpBoundary = await waitForCompleteGrowth(
      filePath,
      initialBoundary,
      findLastCompleteChatLogOffset,
      30_000,
    );
    const catchUpResult = manager.resumeAfterHistoricalSync({
      id: 1,
      filePath,
      resumeOffset: initialBoundary,
      encoding: initialSnapshot.encoding,
    }, initialBoundary, initialSnapshot.encoding);

    assert.equal(catchUpResult.processedBytes > 0, true, '실제 오늘 로그의 snapshot 이후 byte를 처리하지 않았습니다.');
    assert.equal(catchUpResult.handoffOffset >= catchUpBoundary, true, '확인한 신규 로그 경계까지 catch-up하지 못했습니다.');
    assert.equal(processedLines > 0, true, '실제 오늘 로그의 신규 완전한 줄을 정규화하지 못했습니다.');

    const catchUpLineCount = processedLines;
    const tailBoundary = await waitForCompleteGrowth(
      filePath,
      catchUpResult.handoffOffset,
      findLastCompleteChatLogOffset,
      30_000,
    );
    const tailDeadline = Date.now() + 5_000;
    while (processedLines <= catchUpLineCount && Date.now() < tailDeadline) await sleep(50);
    assert.equal(processedLines > catchUpLineCount, true, 'catch-up 뒤 일반 실시간 감시가 다음 로그 줄을 이어받지 못했습니다.');

    process.stdout.write(`${JSON.stringify({
      passed: true,
      filePath,
      encoding: initialSnapshot.encoding,
      initialBoundary,
      catchUpHandoffOffset: catchUpResult.handoffOffset,
      catchUpBytes: catchUpResult.processedBytes,
      tailBoundary,
      processedLines,
    }, null, 2)}\n`);
  } finally {
    manager.stop();
  }
}

void run().then(() => finish(0)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  finish(1);
});
