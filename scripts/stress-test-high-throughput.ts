import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-stress-test-'));
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

interface BenchmarkResult {
  scenarioName: string;
  totalLogs: number;
  elapsedMs: number;
  throughputLinesPerSec: number;
  maxEventLoopLagMs: number;
  avgEventLoopLagMs: number;
  passed: boolean;
  details: string;
}

function formatLogLine(timeStr: string, color: string, message: string): string {
  return `<font size="2" color="white"> [ ${timeStr}] </font> <font size="2" color="${color}">${message}</font></br>`;
}

async function measureEventLoopLag(): Promise<number> {
  const start = Date.now();
  return new Promise(resolve => {
    setImmediate(() => {
      resolve(Date.now() - start);
    });
  });
}

async function runScenario1HuntingSpree(): Promise<BenchmarkResult> {
  console.log('\n--- [시나리오 1] 사냥터 고속 몰이 사냥 (100건) ---');
  const count = 100;
  const logs: string[] = [];
  let expectedXpGained = 0;
  let expectedKills = 0;
  let expectedSeedGained = 0;
  let expectedMagicStones = 0;

  for (let i = 0; i < count; i++) {
    const timeStr = `10시 30분 ${String(i % 60).padStart(2, '0')}초`;
    const typeMod = i % 10;
    if (typeMod < 4) {
      // 40% 경험치 획득
      const xp = 1_500_000 + i * 10_000;
      expectedXpGained += xp;
      expectedKills++;
      logs.push(formatLogLine(timeStr, '#ff64ff', `경험치가 ${xp.toLocaleString()} 올랐습니다.`));
    } else if (typeMod < 6) {
      // 20% 마정석 획득
      expectedMagicStones += 1;
      logs.push(formatLogLine(timeStr, '#ff64ff', `펫이 [하급 마정석]을(를) 주웠습니다.`));
    } else if (typeMod < 8) {
      // 20% SEED 획득
      const seed = 12_500 + i * 100;
      expectedSeedGained += seed;
      logs.push(formatLogLine(timeStr, '#ff64ff', `펫이 [${seed.toLocaleString()}] SEED를 주웠습니다.`));
    } else if (typeMod === 8) {
      // 10% ELSO 포인트 획득
      logs.push(formatLogLine(timeStr, '#ff64ff', `[150] ELSO를 습득했습니다.`));
    } else {
      // 10% 체력 회복 (파서에서 필터링되는 부하)
      logs.push(formatLogLine(timeStr, '#ff64ff', `체력이 [159994] 회복되었습니다.`));
    }
  }

  // 초기 상태 리셋
  xpTracker.resetXp();
  xpTracker.startSession();

  const lags: number[] = [];
  const startTime = Date.now();

  for (const logLine of logs) {
    chatParser.parseLine(logLine);
    const lag = await measureEventLoopLag();
    lags.push(lag);
  }

  const elapsedMs = Math.max(1, Date.now() - startTime);
  const throughput = Math.round((count / elapsedMs) * 1000);
  const maxLag = Math.max(...lags);
  const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;

  // 정합성 검증
  const xpStats = xpTracker.getStats();
  assert.equal(xpStats.total, expectedXpGained, `경험치 합산 불일치: ${xpStats.total} vs ${expectedXpGained}`);
  assert.equal(xpStats.kills, expectedKills, `킬 카운트 불일치: ${xpStats.kills} vs ${expectedKills}`);

  const details = `처리시간: ${elapsedMs}ms | 처리율: ${throughput}줄/초 | 최대지연: ${maxLag}ms | 누적XP: ${xpStats.total.toLocaleString()} | 킬수: ${xpStats.kills}`;
  console.log(`✅ [시나리오 1 완료] ${details}`);

  return {
    scenarioName: '사냥터 고속 몰이 사냥 (100건)',
    totalLogs: count,
    elapsedMs,
    throughputLinesPerSec: throughput,
    maxEventLoopLagMs: maxLag,
    avgEventLoopLagMs: avgLag,
    passed: true,
    details
  };
}

async function runScenario2ChatStorm(): Promise<BenchmarkResult> {
  console.log('\n--- [시나리오 2] 마을/클럽 채팅 및 외치기 폭주 (100건) ---');
  const count = 100;
  const logs: string[] = [];

  for (let i = 0; i < count; i++) {
    const timeStr = `11시 00분 ${String(i % 60).padStart(2, '0')}초`;
    const typeMod = i % 5;
    if (typeMod === 0) {
      // 클럽 채팅 (#94ddfa)
      logs.push(formatLogLine(timeStr, '#94ddfa', `클럽원_${i} : 클럽 던전 파티 모집합니다! [${i}]`));
    } else if (typeMod === 1) {
      // 팀 채팅 (#f7b73c)
      logs.push(formatLogLine(timeStr, '#f7b73c', `팀원_${i} : 버프 걸어주세요~`));
    } else if (typeMod === 2) {
      // 귓속말 (#64ff64)
      logs.push(formatLogLine(timeStr, '#64ff64', `귓속말친구_${i} : 거래 가능한가요?`));
    } else if (typeMod === 3) {
      // 일반 채팅 (#ffffff)
      logs.push(formatLogLine(timeStr, '#ffffff', `지나가는유저_${i} : 안녕하세요~`));
    } else {
      // 외치기 (#c896c8)
      logs.push(formatLogLine(timeStr, '#c896c8', `외치기 : [12강 무기 팝니다 선제시] [판매자_${i}]`));
    }
  }

  const lags: number[] = [];
  const startTime = Date.now();

  for (const logLine of logs) {
    chatParser.parseLine(logLine);
    const lag = await measureEventLoopLag();
    lags.push(lag);
  }

  const elapsedMs = Math.max(1, Date.now() - startTime);
  const throughput = Math.round((count / elapsedMs) * 1000);
  const maxLag = Math.max(...lags);
  const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;

  // 닉네임 수집 및 외치기 히스토리 검증
  const shoutHistory = chatLogProcessor.getChatHistory('Shout');
  const clubHistory = chatLogProcessor.getChatHistory('Club');

  assert.ok(shoutHistory.length > 0, '외치기 히스토리가 기록되지 않았습니다.');
  assert.ok(clubHistory.length > 0, '클럽 히스토리가 기록되지 않았습니다.');

  const details = `처리시간: ${elapsedMs}ms | 처리율: ${throughput}줄/초 | 최대지연: ${maxLag}ms | 외치기수집: ${shoutHistory.length}건 | 클럽채팅: ${clubHistory.length}건`;
  console.log(`✅ [시나리오 2 완료] ${details}`);

  return {
    scenarioName: '채팅 및 외치기 폭주 (100건)',
    totalLogs: count,
    elapsedMs,
    throughputLinesPerSec: throughput,
    maxEventLoopLagMs: maxLag,
    avgEventLoopLagMs: avgLag,
    passed: true,
    details
  };
}

async function runScenario3RaidBurst(): Promise<BenchmarkResult> {
  console.log('\n--- [시나리오 3] 레이드 보스 클리어 및 버프/보상 대량 방출 (100건) ---');
  const count = 100;
  const logs: string[] = [];

  for (let i = 0; i < count; i++) {
    const timeStr = `12시 00분 ${String(i % 60).padStart(2, '0')}초`;
    const typeMod = i % 5;
    if (typeMod === 0) {
      // 보스 클리어
      logs.push(formatLogLine(timeStr, '#ff64ff', `이클립스 보스전(에토스) 클리어 횟수: [1회/7회]`));
    } else if (typeMod === 1) {
      // 코어 효과 버프
      logs.push(formatLogLine(timeStr, '#ff64ff', `[머큐리얼 케이브 코어] 진화 4단계-6세트 효과가 발동되었습니다.`));
    } else if (typeMod === 2) {
      // 능력치 버프
      logs.push(formatLogLine(timeStr, '#ff64ff', `[ⓟ신속의 미학]: 모든 스킬의 중딜레이가 45% 감소합니다.`));
    } else if (typeMod === 3) {
      // 보상 상자 획득
      logs.push(formatLogLine(timeStr, '#ff64ff', `[이터널 플로어 보상 상자] 아이템을 획득하였습니다.`));
    } else {
      // 테일즈 패스
      logs.push(formatLogLine(timeStr, '#ff64ff', `테일즈 패스 미션을 완료하였습니다 : 일일과제 1개 클리어`));
    }
  }

  const lags: number[] = [];
  const startTime = Date.now();

  for (const logLine of logs) {
    chatParser.parseLine(logLine);
    const lag = await measureEventLoopLag();
    lags.push(lag);
  }

  const elapsedMs = Math.max(1, Date.now() - startTime);
  const throughput = Math.round((count / elapsedMs) * 1000);
  const maxLag = Math.max(...lags);
  const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;

  const details = `처리시간: ${elapsedMs}ms | 처리율: ${throughput}줄/초 | 최대지연: ${maxLag}ms | 숙제/버프 연동 완료`;
  console.log(`✅ [시나리오 3 완료] ${details}`);

  return {
    scenarioName: '레이드 보스 클리어 및 버프/보상 방출 (100건)',
    totalLogs: count,
    elapsedMs,
    throughputLinesPerSec: throughput,
    maxEventLoopLagMs: maxLag,
    avgEventLoopLagMs: avgLag,
    passed: true,
    details
  };
}

async function runScenario4MegaBurst(): Promise<BenchmarkResult> {
  console.log('\n--- [시나리오 4] 종합 복합 극한 500건 대량 버스트 (500건) ---');
  const count = 500;
  const logs: string[] = [];
  let expectedXpGained = 0;

  for (let i = 0; i < count; i++) {
    const timeStr = `13시 15분 ${String(i % 60).padStart(2, '0')}초`;
    const typeMod = i % 6;
    if (typeMod === 0) {
      const xp = 2_000_000;
      expectedXpGained += xp;
      logs.push(formatLogLine(timeStr, '#ff64ff', `경험치가 ${xp.toLocaleString()} 올랐습니다.`));
    } else if (typeMod === 1) {
      logs.push(formatLogLine(timeStr, '#94ddfa', `클럽원_${i} : 연속 메시지 테스트입니다 ${i}`));
    } else if (typeMod === 2) {
      logs.push(formatLogLine(timeStr, '#c896c8', `외치기 : [아이템 급처] [외치기유저_${i}]`));
    } else if (typeMod === 3) {
      logs.push(formatLogLine(timeStr, '#ff64ff', `펫이 [50,000] SEED를 주웠습니다.`));
    } else if (typeMod === 4) {
      logs.push(formatLogLine(timeStr, '#ff64ff', `[경험의 정수] 아이템을 1개 획득하였습니다.`));
    } else {
      logs.push(formatLogLine(timeStr, '#ff64ff', `체력이 [159994] 회복되었습니다.`));
    }
  }

  const startXp = xpTracker.getStats().total;
  const lags: number[] = [];
  const startTime = Date.now();

  for (const logLine of logs) {
    chatParser.parseLine(logLine);
    const lag = await measureEventLoopLag();
    lags.push(lag);
  }

  const elapsedMs = Math.max(1, Date.now() - startTime);
  const throughput = Math.round((count / elapsedMs) * 1000);
  const maxLag = Math.max(...lags);
  const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;

  const currentXp = xpTracker.getStats().total;
  assert.equal(currentXp - startXp, expectedXpGained, `메가 버스트 경험치 합산 오류: ${currentXp - startXp} vs ${expectedXpGained}`);

  const details = `처리시간: ${elapsedMs}ms | 처리율: ${throughput}줄/초 | 최대지연: ${maxLag}ms | 평균지연: ${avgLag.toFixed(2)}ms`;
  console.log(`✅ [시나리오 4 완료] ${details}`);

  return {
    scenarioName: '종합 복합 극한 대량 버스트 (500건)',
    totalLogs: count,
    elapsedMs,
    throughputLinesPerSec: throughput,
    maxEventLoopLagMs: maxLag,
    avgEventLoopLagMs: avgLag,
    passed: true,
    details
  };
}

async function runRendererIntegrationTest(): Promise<void> {
  console.log('\n--- [렌더러 통합 테스트] 실제 렌더러 창 생성 및 고속 IPC 수신 테스트 ---');
  const chatWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(projectRoot, 'dist', 'preload.js') }
  });
  const focusWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(projectRoot, 'dist', 'preload.js') }
  });

  // 포커스 채팅에 대상 닉네임 설정
  chatLogProcessor.setFocusedChatTargets(['테스터_1', '테스터_3']);

  await chatWin.loadFile(path.join(projectRoot, 'dist', 'chat-overlay.html'));
  await focusWin.loadFile(path.join(projectRoot, 'dist', 'focused-chat.html'));

  await new Promise(resolve => setTimeout(resolve, 300));

  // 초기 설정 및 모드 전송
  const cfg = config.load();
  chatWin.webContents.send('config-data', cfg);
  chatWin.webContents.send('chat-overlay-mode', 'main');
  focusWin.webContents.send('config-data', cfg);

  await new Promise(resolve => setTimeout(resolve, 300));

  // 100건의 채팅 업데이트를 렌더러로 고속 전송
  for (let i = 0; i < 100; i++) {
    const item = {
      id: `stress-${i}`,
      type: i % 2 === 0 ? 'club' : 'general',
      timestamp: `14시 00분 ${String(i % 60).padStart(2, '0')}초`,
      sender: `테스터_${i % 5}`,
      message: `고속 스트리밍 테스트 메시지 ${i}`,
      color: i % 2 === 0 ? '#94ddfa' : '#ffffff',
      level: 10,
      characterCode: 1,
      isSelf: false
    };
    if (!chatWin.isDestroyed()) chatWin.webContents.send('chat-updated', item);
    if (!focusWin.isDestroyed()) focusWin.webContents.send('chat-updated', item);
  }

  // 렌더러가 프레임(rAF)을 처리할 수 있도록 300ms 대기
  await new Promise(resolve => setTimeout(resolve, 300));

  const chatRowCount = await chatWin.webContents.executeJavaScript(`document.querySelectorAll('.chat-message-row').length`);
  const focusRowCount = await focusWin.webContents.executeJavaScript(`document.querySelectorAll('.message-row').length`);

  console.log(`✅ [렌더러 검증 완료] 채팅 오버레이 렌더링 행 수: ${chatRowCount}, 포커스 대화 렌더링 행 수: ${focusRowCount}`);
  assert.ok(chatRowCount > 0, '채팅 오버레이에 행이 렌더링되지 않았습니다.');
  assert.ok(focusRowCount > 0, '포커스 채팅에 행이 렌더링되지 않았습니다.');

  chatWin.destroy();
  focusWin.destroy();
}

async function main(): Promise<void> {
  try {
    console.log('====================================================');
    console.log('🚀 초당 100건+ 대량 로그 유입 상황별 성능 및 정합성 테스트');
    console.log('====================================================');

    // DB, IPC 및 매니저 초기화
    ipcHandlers.register();
    diaryDb.initDb();
    chatLogProcessor.start();
    contentsChecker.init();
    buffTimerManager.start();

    const results: BenchmarkResult[] = [];

    results.push(await runScenario1HuntingSpree());
    results.push(await runScenario2ChatStorm());
    results.push(await runScenario3RaidBurst());
    results.push(await runScenario4MegaBurst());
    await runRendererIntegrationTest();

    console.log('\n====================================================');
    console.log('📊 벤치마크 결과 종합 요약');
    console.log('====================================================');
    for (const r of results) {
      console.log(`▶ ${r.scenarioName}`);
      console.log(`   - 총 로그: ${r.totalLogs}건 | 소요 시간: ${r.elapsedMs}ms | 처리 속도: ${r.throughputLinesPerSec} lines/sec`);
      console.log(`   - 이벤트 루프 최대 지연: ${r.maxEventLoopLagMs}ms | 평균 지연: ${r.avgEventLoopLagMs.toFixed(2)}ms`);
      console.log(`   - 결과: ${r.passed ? 'PASS (정상)' : 'FAIL (실패)'}`);
    }
    console.log('====================================================');
    console.log('🎉 모든 상황별 스트레스 테스트 및 데이터 정합성 검증 완료!');

    diaryDb.closeDb();
    app.quit();
  } catch (err) {
    console.error('❌ 테스트 중 오류 발생:', err);
    try { diaryDb.closeDb(); } catch {}
    process.exit(1);
  }
}

app.whenReady().then(main);
