import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-abandoned-visibility-test-'));

async function main(): Promise<void> {
  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();
  const originalNow = Date.now;
  const boundary = Date.parse('2026-11-16T06:00:00+09:00');
  let clock = boundary - 500;
  Date.now = () => clock;
  const updates: any[] = [];
  const messaging = require(path.join(projectRoot, 'dist', 'modules', 'windowMessaging.js'));
  messaging.broadcastToAllWindows = (channel: string, state: unknown) => {
    if (channel === 'abandoned-update') updates.push(structuredClone(state));
  };

  const config = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as {
    saveImmediate: (patch: Record<string, unknown>) => unknown;
  };
  const { abandonedTracker } = require(path.join(projectRoot, 'dist', 'modules', 'abandonedTracker.js')) as {
    abandonedTracker: {
      start(): void;
      reset(): void;
      forceVisible(visible: boolean): void;
      beginGameSession(): void;
      captureProfileState(): any;
      restoreProfileState(value: any): void;
      checkReset(): void;
      getState(): {
        isActive: boolean;
        profit: number;
        regions: Record<string, number>;
        stoneGains: Record<string, number>;
        stoneLosses: Record<string, number>;
        totalFee: number;
        nuEncounters?: number;
        lastNuBroadcastTime?: number;
        lastNuBroadcastText?: string;
      };
    };
  };
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js')) as {
    chatParser: NodeJS.EventEmitter;
  };

  config.saveImmediate({ abandonedEnabled: true, abandonedAutoHideMinutes: 10 });
  abandonedTracker.start();
  abandonedTracker.reset();

  chatParser.emit('MAGIC_STONE_GAIN', {
    date: '2026-08-27', timestamp: '10시 00분 00초', grade: '하급', count: 2, message: '획득',
  });
  assert.equal(abandonedTracker.getState().isActive, true, '일반 활동에서 어벤던로드 HUD가 표시되지 않습니다.');

  abandonedTracker.forceVisible(false);
  chatParser.emit('MAGIC_STONE_GAIN', {
    date: '2026-08-27', timestamp: '10시 00분 01초', grade: '중급', count: 3, message: '획득',
  });
  chatParser.emit('MAGIC_STONE_LOSS', {
    date: '2026-08-27', timestamp: '10시 00분 02초', grade: '중급', count: 1, message: '소실',
  });
  chatParser.emit('ABANDONED_FEE', {
    date: '2026-08-27', timestamp: '10시 00분 03초', amount: 100, message: '입장료',
  });
  chatParser.emit('ABANDONED_ENTRY', {
    date: '2026-08-27', timestamp: '10시 00분 04초', region: '숨김 테스트 지역', count: 4, message: '입장',
  });
  const hiddenState = abandonedTracker.getState();
  assert.equal(hiddenState.isActive, false, '수동 숨김 뒤 자동 활동이 HUD를 다시 표시했습니다.');
  assert.equal(hiddenState.stoneGains['중급'], 3, '수동 숨김 중 마정석 획득 집계가 누락됐습니다.');
  assert.equal(hiddenState.stoneLosses['중급'], 1, '수동 숨김 중 마정석 소실 집계가 누락됐습니다.');
  assert.equal(hiddenState.nuEncounters, 1, '수동 숨김 중 누 조우 횟수 집계가 누락됐습니다.');
  assert.equal(hiddenState.totalFee, 100, '수동 숨김 중 입장료 집계가 누락됐습니다.');
  assert.equal(hiddenState.regions['숨김 테스트 지역'], 4, '수동 숨김 중 지역 도전 횟수가 누락됐습니다.');

  abandonedTracker.forceVisible(true);
  assert.equal(abandonedTracker.getState().isActive, true, '사용자가 명시적으로 HUD를 다시 표시하지 못했습니다.');
  assert.equal(abandonedTracker.getState().stoneGains['중급'], 3, '다시 표시한 HUD에 숨김 중 누적값이 남지 않았습니다.');

  abandonedTracker.forceVisible(false);
  abandonedTracker.beginGameSession();
  chatParser.emit('MAGIC_STONE_GAIN', {
    date: '2026-08-27', timestamp: '10시 00분 05초', grade: '상급', count: 1, message: '새 세션 획득',
  });
  assert.equal(abandonedTracker.getState().isActive, true, '새 게임 세션에서 이전 수동 숨김 억제가 해제되지 않았습니다.');

  abandonedTracker.reset();
  config.saveImmediate({ abandonedAutoHideMinutes: 0 });
  chatParser.emit('MAGIC_STONE_GAIN', {
    date: '2026-08-27', timestamp: '10시 00분 06초', grade: '최상급', count: 1, message: '자동 숨김',
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(abandonedTracker.getState().isActive, false, '자동 숨김 시간이 지난 뒤 HUD가 숨겨지지 않았습니다.');
  chatParser.emit('MAGIC_STONE_GAIN', {
    date: '2026-08-27', timestamp: '10시 00분 07초', grade: '최상급', count: 1, message: '다음 활동',
  });
  abandonedTracker.reset();

  // 누(Nu) 마정석 대량 획득 서버 전체 공지 수신 및 숨김 유지 정책 검증
  abandonedTracker.forceVisible(false);
  assert.equal(abandonedTracker.getState().isActive, false);
  const parserInstance = chatParser as unknown as { parseLine(line: string): void };
  parserInstance.parseLine('[ 18시 25분 30초 ] 누군가 누에게서 하급 마정석을(를) 대량으로 획득하였습니다.');
  const broadcastState = abandonedTracker.getState();
  assert.equal(broadcastState.isActive, false, '서버 전체 공지 수신 시 숨겨진 HUD가 강제로 표시되면 안 됩니다.');
  assert.equal(broadcastState.lastNuBroadcastText, '18시 25분 30초', '로그 타임스탬프가 lastNuBroadcastText에 기록되지 않았습니다.');
  assert.ok(typeof broadcastState.lastNuBroadcastTime === 'number' && broadcastState.lastNuBroadcastTime > 0, 'lastNuBroadcastTime이 기록되지 않았습니다.');

  // 실제 테일즈위버 로그 포맷 ([ 누 ] 내부 공백 및 HTML 태그 포함) 수신 검증
  parserInstance.parseLine('<font size="2" color="white"> [19시 19분 29초] </font> <font size="2" color="#ff64ff">누군가 [ 누 ] 에게서 하급 마정석을 대량으로 획득 하였습니다.</font></br>');
  assert.equal(abandonedTracker.getState().lastNuBroadcastText, '19시 19분 29초', '실제 테일즈위버 공지 포맷([ 누 ])이 감지되지 않았습니다.');

  // reset() 시 서버 공지 시각 보존 검증
  abandonedTracker.reset();
  assert.equal(abandonedTracker.getState().lastNuBroadcastText, '19시 19분 29초', 'reset() 후에도 서버 전체 공지 시각이 보존되어야 합니다.');

  const event = { date: '2026-11-16', timestamp: '05시 59분 59초', message: '주간 경계' };
  chatParser.emit('ABANDONED_ENTRY', { ...event, region: '카디프', count: 11 });
  chatParser.emit('ABANDONED_FEE', { ...event, amount: 100 });
  chatParser.emit('MAGIC_STONE_GAIN', { ...event, grade: '하급', count: 20 });
  chatParser.emit('MAGIC_STONE_LOSS', { ...event, grade: '하급', count: 2 });
  abandonedTracker.forceVisible(false);
  const previousWeek = abandonedTracker.captureProfileState();
  clock = boundary - 1;
  abandonedTracker.restoreProfileState(previousWeek);
  assert.equal(abandonedTracker.getState().regions['카디프'], 11, '초기화 1ms 전에는 같은 주간 상태 유지');
  const beforeTimer = updates.length;
  clock = boundary;
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.ok(updates.slice(beforeTimer).some(state => state.totalFee === 0 && Object.keys(state.regions).length === 0),
    '새 채팅이나 조회 없이도 경계 타이머가 HUD를 초기화해야 한다');
  const resetState = abandonedTracker.getState();
  assert.equal(resetState.profit, 0);assert.equal(resetState.totalFee, 0);
  assert.deepEqual(resetState.stoneGains, {});assert.deepEqual(resetState.stoneLosses, {});
  assert.equal(resetState.nuEncounters, 0);
  assert.equal(resetState.lastNuBroadcastText, '19시 19분 29초');
  assert.equal(abandonedTracker.captureProfileState().suppressed, true, '주간 리셋으로 수동 숨김을 풀지 않는다');
  chatParser.emit('ABANDONED_FEE', { ...event, amount: 5 });
  chatParser.emit('ABANDONED_ENTRY', { ...event, region: '필멸의 땅', count: 1 });
  assert.equal(abandonedTracker.getState().totalFee, 5);
  assert.equal(abandonedTracker.getState().isActive, false);
  const currentWeek = abandonedTracker.captureProfileState();
  abandonedTracker.restoreProfileState(previousWeek);
  assert.deepEqual(abandonedTracker.getState().regions, {}, '지난주 프로필 snapshot을 복원하면 만료 처리');
  assert.equal(abandonedTracker.captureProfileState().pendingFee, null, '이전 주 입장료와 새 입장을 연결하지 않는다');
  abandonedTracker.restoreProfileState(currentWeek);
  assert.equal(abandonedTracker.getState().totalFee, 5, '같은 주 프로필 전환은 집계 유지');
  const effects = require(path.join(projectRoot, 'dist', 'modules', 'recordEffects.js'));
  effects.collectRecordEffects(() => chatParser.emit('ABANDONED_FEE', { ...event, amount: 900 }), false, boundary - 1)();
  assert.equal(abandonedTracker.getState().totalFee, 5, '리셋 전 선택 대기 기록은 이번 주 HUD에 누적하지 않는다');
  const legacy = structuredClone(currentWeek);delete legacy.cycleStart;
  abandonedTracker.restoreProfileState(legacy);
  assert.equal(abandonedTracker.getState().totalFee, 0, '주기를 알 수 없는 구형 HUD snapshot은 한 번 초기화');
  clock += 14 * 86_400_000;
  abandonedTracker.restoreProfileState(currentWeek);
  assert.equal(abandonedTracker.getState().totalFee, 0, '2주 후 재실행/절전 복원도 만료 처리');
  // PC 시계가 리셋 전이어도 인터넷으로 보정된 기준이 리셋 이후면 초기화한다.
  clock = boundary - 120_000;
  abandonedTracker.restoreProfileState(previousWeek);
  const runtime = require(path.join(projectRoot, 'dist', 'modules', 'profileRuntime.js'));
  runtime.setProfileRuntime({service:{store:{syncClock:()=>({utcMs:boundary,source:'internet',uncertaintyMs:1})}}});
  // 기록의 주기 분류도 같은 보정 시간축이다. 로그 시각은 PC 시계로 적히므로 보정량만큼 옮겨 판정한다.
  const acceptsLoggedAt = (loggedAt: number): boolean => {
    let accepted = false;
    effects.collectRecordEffects(() => {
      accepted = (abandonedTracker as unknown as { acceptCurrentCycleActivity(): boolean }).acceptCurrentCycleActivity();
    }, false, loggedAt)();
    return accepted;
  };
  try {
    abandonedTracker.checkReset();
    assert.equal(abandonedTracker.getState().totalFee,0, '주간 리셋은 보정된 시각을 따른다');
    // PC 시계가 120초 느림: 리셋 60초 뒤의 활동이 로그에는 리셋 60초 전으로 적힌다.
    assert.equal(acceptsLoggedAt(boundary - 60_000), true, 'PC 시계가 느려도 리셋 직후 활동을 이번 주 HUD에 반영');
    assert.equal(acceptsLoggedAt(boundary - 150_000), false, '보정해도 리셋 전인 활동은 지난주 기록');
    // PC 시계가 120초 빠름: 리셋 60초 전의 활동이 로그에는 리셋 60초 뒤로 적힌다.
    clock = boundary + 90_000;
    runtime.setProfileRuntime({service:{store:{syncClock:()=>({utcMs:boundary - 30_000,source:'internet',uncertaintyMs:1})}}});
    abandonedTracker.restoreProfileState(previousWeek);
    assert.equal(abandonedTracker.getState().regions['카디프'], 11, '보정 시각이 리셋 전이면 PC 시계가 지나도 지난주 HUD 유지');
    assert.equal(acceptsLoggedAt(boundary + 60_000), true, 'PC 시계가 빨라도 리셋 직전 활동은 지난주 HUD에 반영');
    assert.equal(acceptsLoggedAt(boundary + 150_000), false, '보정해도 리셋 뒤인 활동은 지난주 HUD에 합산하지 않음');
  } finally {runtime.setProfileRuntime(null);}
  Date.now = originalNow;

  const overlayHtml = fs.readFileSync(path.join(projectRoot, 'src', 'game-overlay.html'), 'utf8');
  assert.match(overlayHtml, /id="abandoned-nu-broadcast-time"/, 'game-overlay.html에 누 전체 알림 표시 요소가 없습니다.');
  assert.match(overlayHtml, /function updateAbandonedBroadcastUI\(\)/, 'game-overlay.html에 updateAbandonedBroadcastUI 함수가 없습니다.');

  const calcHtml = fs.readFileSync(path.join(projectRoot, 'src', 'magic-stone-calculator.html'), 'utf8');
  assert.match(calcHtml, /id="calc-nu-broadcast-time"/, 'magic-stone-calculator.html에 누 전체 알림 표시 요소가 없습니다.');
  assert.match(calcHtml, /function updateCalcNuBroadcastUI\(\)/, 'magic-stone-calculator.html에 updateCalcNuBroadcastUI 함수가 없습니다.');

  const pollingSource = fs.readFileSync(path.join(projectRoot, 'src', 'modules', 'pollingLoop.ts'), 'utf8');
  const ipcSource = fs.readFileSync(path.join(projectRoot, 'src', 'modules', 'ipcHandlers.ts'), 'utf8');
  const {isNewDisplayedGameSession}=require(path.join(projectRoot,'dist','modules','pollingLoop.js'));
  assert.equal(isNewDisplayedGameSession(false,undefined,42),true);
  assert.equal(isNewDisplayedGameSession(true,42,42),false,'같은 PID의 최소화 복귀는 HUD 수동 숨김을 보존');
  assert.equal(isNewDisplayedGameSession(true,42,43),true,'프로세스 교체는 새 게임 세션');
  assert.equal(isNewDisplayedGameSession(true,42,undefined),false,'PID 조회 실패만으로는 새 게임을 시작하지 않음');
  assert.match(pollingSource, /const isNewGameSession=isNewDisplayedGameSession\([^;]+;[\s\S]*?if \(isNewGameSession\)[\s\S]*?abandonedTracker\.beginGameSession\(\)/,
    '최소화 복귀가 아닌 새 게임 세션에서만 수동 숨김 억제를 해제하지 않습니다.');
  assert.match(ipcSource, /abandoned-hide-now[\s\S]*?abandonedTracker\.forceVisible\(false\)/,
    '계산기 화면의 숨기기 동작이 메인 추적기의 수동 숨김 상태에 연결되지 않았습니다.');

  console.log('Abandoned HUD manual visibility policy checks passed.');
  try {
    fs.rmSync(testUserDataDirectory, { recursive: true, force: true });
  } catch {
    // Electron 종료 직전 잠긴 임시 파일은 운영체제의 임시 폴더 정리에 맡깁니다.
  }
  app.exit(0);
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
