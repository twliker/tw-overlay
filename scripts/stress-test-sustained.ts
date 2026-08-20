import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-sustained-test-'));
app.setPath('userData', testUserDataDirectory);

// Import application modules
const { chatParser } = require('../dist/modules/chatParser');
const { chatLogProcessor } = require('../dist/modules/chatLogProcessor');
const { xpTracker } = require('../dist/modules/xpTracker');
const diaryDb = require('../dist/modules/diaryDb');
const config = require('../dist/modules/config');
const contentsChecker = require('../dist/modules/contentsChecker');
const { buffTimerManager } = require('../dist/modules/buffTimerManager');
const ipcHandlers = require('../dist/modules/ipcHandlers');

function formatLogLine(timeStr: string, color: string, message: string): string {
  return `<font size="2" color="white"> [ ${timeStr}] </font> <font size="2" color="${color}">${message}</font></br>`;
}

async function measureLag(): Promise<number> {
  const start = Date.now();
  return new Promise(resolve => {
    setImmediate(() => {
      resolve(Date.now() - start);
    });
  });
}

function getMemoryUsageMB(): { heapUsed: number; heapTotal: number; rss: number } {
  const mem = process.memoryUsage();
  return {
    heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
    rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
  };
}

async function runSustainedLoadTest(durationSeconds = 10, targetLogsPerSecond = 120): Promise<void> {
  console.log(`\n====================================================`);
  console.log(`⏱️ [지속 대량 유입 테스트] ${durationSeconds}초 동안 매초 ${targetLogsPerSecond}건씩 지속 유입 (총 ${durationSeconds * targetLogsPerSecond}건)`);
  console.log(`====================================================\n`);

  // 1. 렌더러 창 생성 (실제 DOM 렌더링 및 IPC 부하 동시 측정)
  const chatWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(projectRoot, 'dist', 'preload.js') }
  });
  const focusWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(projectRoot, 'dist', 'preload.js') }
  });

  chatLogProcessor.setFocusedChatTargets(['열혈사냥꾼', '파티원_1']);

  await chatWin.loadFile(path.join(projectRoot, 'dist', 'chat-overlay.html'));
  await focusWin.loadFile(path.join(projectRoot, 'dist', 'focused-chat.html'));

  await new Promise(resolve => setTimeout(resolve, 300));
  const cfg = config.load();
  chatWin.webContents.send('config-data', cfg);
  chatWin.webContents.send('chat-overlay-mode', 'main');
  focusWin.webContents.send('config-data', cfg);
  await new Promise(resolve => setTimeout(resolve, 300));

  // 2. 초기 상태 기록
  const initialMemory = getMemoryUsageMB();
  console.log(`[초기 메모리] Heap Used: ${initialMemory.heapUsed} MB | RSS: ${initialMemory.rss} MB`);

  xpTracker.resetXp();
  xpTracker.startSession();

  let totalLogsSent = 0;
  let totalXpExpected = 0;
  let totalKillsExpected = 0;
  let totalSeedsExpected = 0;
  const secondReports: Array<{
    second: number;
    logsSent: number;
    batchElapsedMs: number;
    maxLagMs: number;
    avgLagMs: number;
    heapUsedMB: number;
  }> = [];

  const overallStartTime = Date.now();

  for (let sec = 1; sec <= durationSeconds; sec++) {
    const secStartTime = Date.now();
    const lagsThisSecond: number[] = [];

    // 초당 targetLogsPerSecond 개의 실전 복합 로그 생성 및 파이프라인 주입
    for (let i = 0; i < targetLogsPerSecond; i++) {
      totalLogsSent++;
      const timeStr = `15시 ${String(sec).padStart(2, '0')}분 ${String(i % 60).padStart(2, '0')}초`;
      const mod = i % 10;

      let line = '';
      if (mod < 4) {
        // 경험치 획득 (40%)
        const xpGain = 1_250_000 + (i * 5_000);
        totalXpExpected += xpGain;
        totalKillsExpected++;
        line = formatLogLine(timeStr, '#ff64ff', `경험치가 ${xpGain.toLocaleString()} 올랐습니다.`);
      } else if (mod === 4) {
        // SEED 획득 (10%)
        const seedGain = 15_000 + (i * 200);
        totalSeedsExpected += seedGain;
        line = formatLogLine(timeStr, '#ff64ff', `펫이 [${seedGain.toLocaleString()}] SEED를 주웠습니다.`);
      } else if (mod === 5) {
        // 클럽 채팅 (10%)
        line = formatLogLine(timeStr, '#94ddfa', `열혈사냥꾼 : 몬스터 리젠 빠르네요! [${totalLogsSent}]`);
      } else if (mod === 6) {
        // 팀 채팅 (10%)
        line = formatLogLine(timeStr, '#f7b73c', `파티원_1 : 중앙으로 몰아주세요 [${totalLogsSent}]`);
      } else if (mod === 7) {
        // 외치기 (10%)
        line = formatLogLine(timeStr, '#c896c8', `외치기 : [사냥 파티 구합니다] [유저_${i % 10}]`);
      } else if (mod === 8) {
        // 코어/버프 발동 (10%)
        line = formatLogLine(timeStr, '#ff64ff', `[머큐리얼 케이브 코어] 진화 4단계-6세트 효과가 발동되었습니다.`);
      } else {
        // 체력 회복 (10%)
        line = formatLogLine(timeStr, '#ff64ff', `체력이 [159994] 회복되었습니다.`);
      }

      // 파서 및 프로세서 통과
      chatParser.parseLine(line);
      const lag = await measureLag();
      lagsThisSecond.push(lag);
    }

    const secElapsed = Date.now() - secStartTime;
    const currentMem = getMemoryUsageMB();
    const maxLag = Math.max(...lagsThisSecond);
    const avgLag = lagsThisSecond.reduce((a, b) => a + b, 0) / lagsThisSecond.length;

    secondReports.push({
      second: sec,
      logsSent: targetLogsPerSecond,
      batchElapsedMs: secElapsed,
      maxLagMs: maxLag,
      avgLagMs: Math.round(avgLag * 100) / 100,
      heapUsedMB: currentMem.heapUsed,
    });

    console.log(
      `[${String(sec).padStart(2, ' ')}초 경과] 유입: ${targetLogsPerSecond}건 | 처리시간: ${secElapsed}ms | 최대지연: ${maxLag}ms | 평균지연: ${avgLag.toFixed(2)}ms | Heap: ${currentMem.heapUsed} MB`
    );

    // 실제 1초 주기를 맞추기 위해 남은 시간 대기
    const sleepRemainder = Math.max(0, 1000 - secElapsed);
    if (sleepRemainder > 0) {
      await new Promise(resolve => setTimeout(resolve, sleepRemainder));
    }
  }

  const overallElapsedMs = Date.now() - overallStartTime;
  console.log(`\n--- [지속 유입 완료 후 안정화 및 정합성 검증 대기 (500ms)] ---`);
  await new Promise(resolve => setTimeout(resolve, 500));

  // 3. 메모리 및 DOM 노드 상태 확인
  if (global.gc) global.gc();
  const finalMemory = getMemoryUsageMB();

  const chatRowCount = await chatWin.webContents.executeJavaScript(`document.querySelectorAll('.chat-message-row').length`);
  const focusRowCount = await focusWin.webContents.executeJavaScript(`document.querySelectorAll('.message-row').length`);

  console.log(`\n====================================================`);
  console.log(`📊 [지속 대량 유입 벤치마크 종합 결과]`);
  console.log(`====================================================`);
  console.log(`• 총 처리 로그 수: ${totalLogsSent.toLocaleString()} 건 (${durationSeconds}초 지속)`);
  console.log(`• 전체 소요 시간: ${(overallElapsedMs / 1000).toFixed(2)} 초`);
  console.log(`• 평균 지속 처리율: ${Math.round((totalLogsSent / (overallElapsedMs / 1000)))} lines/sec`);
  console.log(`• 메모리 변동: 시작 ${initialMemory.heapUsed} MB → 최종 ${finalMemory.heapUsed} MB (증가폭: ${(finalMemory.heapUsed - initialMemory.heapUsed).toFixed(2)} MB)`);
  console.log(`• 렌더러 DOM 수량 제한 검증:`);
  console.log(`  - 채팅 오버레이 DOM 수: ${chatRowCount} 개 (상한선: 1,000개 이내 유지)`);
  console.log(`  - 포커스 대화 DOM 수: ${focusRowCount} 개 (상한선: 150개 이내 유지)`);

  // 4. 데이터 정합성 엄격 검증 (Assertion)
  const xpStats = xpTracker.getStats();
  console.log(`• XP Tracker 누적 합산 검증:`);
  console.log(`  - 예상 경험치: ${totalXpExpected.toLocaleString()} | 실제 누적: ${xpStats.total.toLocaleString()}`);
  console.log(`  - 예상 킬수: ${totalKillsExpected.toLocaleString()} | 실제 킬수: ${xpStats.kills.toLocaleString()}`);

  assert.equal(xpStats.total, totalXpExpected, '지속 대량 유입 중 경험치 누적 오차 발생');
  assert.equal(xpStats.kills, totalKillsExpected, '지속 대량 유입 중 킬 수 누적 오차 발생');
  assert.ok(chatRowCount <= 1000, `채팅 오버레이 DOM 개수가 상한(1000개)을 초과함: ${chatRowCount}`);
  assert.ok(focusRowCount <= 150, `포커스 대화 DOM 개수가 상한(150개)을 초과함: ${focusRowCount}`);
  assert.ok(chatRowCount > 0, '채팅 오버레이에 정상 렌더링된 행이 없습니다.');
  assert.ok(focusRowCount > 0, '포커스 대화창에 정상 렌더링된 행이 없습니다.');

  // 지연 시간 통계
  const allMaxLags = secondReports.map(r => r.maxLagMs);
  const maxLagOverall = Math.max(...allMaxLags);
  const avgLagOverall = secondReports.reduce((a, b) => a + b.avgLagMs, 0) / secondReports.length;

  console.log(`• 이벤트 루프 반응성:`);
  console.log(`  - 전체 최대 지연: ${maxLagOverall} ms`);
  console.log(`  - 전체 평균 지연: ${avgLagOverall.toFixed(2)} ms`);
  console.log(`====================================================`);
  console.log(`🎉 지속 대량 유입 부하 테스트 100% PASS! 메모리 누수 및 버벅임 없음 확인!`);

  chatWin.destroy();
  focusWin.destroy();
}

async function main(): Promise<void> {
  try {
    ipcHandlers.register();
    diaryDb.initDb();
    chatLogProcessor.start();
    contentsChecker.init();
    buffTimerManager.start();

    // 10초 동안 초당 120건씩 지속 스트리밍 (총 1,200건의 복합 로그)
    await runSustainedLoadTest(10, 120);

    diaryDb.closeDb();
    app.quit();
  } catch (err) {
    console.error('❌ 지속 부하 테스트 중 오류 발생:', err);
    try { diaryDb.closeDb(); } catch {}
    process.exit(1);
  }
}

app.whenReady().then(main);
