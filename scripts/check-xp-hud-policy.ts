import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-xp-policy-test-'));

async function main(): Promise<void> {
  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();

  const constants = require(path.join(projectRoot, 'dist', 'modules', 'constants.js')) as {
    DEFAULT_CONFIG: { showXpWidget?: boolean; xpAutoStart?: boolean };
  };
  assert.equal(constants.DEFAULT_CONFIG.showXpWidget, false, '신규 사용자의 경험치 HUD가 숨김으로 시작하지 않습니다.');
  assert.equal(constants.DEFAULT_CONFIG.xpAutoStart, false, '신규 사용자의 경험치 세션이 정지로 시작하지 않습니다.');

  const xpModule = require(path.join(projectRoot, 'dist', 'modules', 'xpTracker.js')) as {
    shouldAutoStartXpSession: (config: { xpAutoStart?: boolean }) => boolean;
    xpTracker: {
      start(): void;
      startSession(): void;
      stopSession(): void;
      toggleSession(): void;
      resetXp(): void;
      getStats(): {
        isActive?: boolean;
        total: number;
        kills: number;
        essenceCount: number;
        xpSinceLastExchange: number;
      };
    };
  };
  assert.equal(xpModule.shouldAutoStartXpSession({}), false, '누락된 자동 시작 값이 true로 해석됩니다.');
  assert.equal(xpModule.shouldAutoStartXpSession({ xpAutoStart: false }), false);
  assert.equal(xpModule.shouldAutoStartXpSession({ xpAutoStart: true }), true);

  const config = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as {
    load: () => { showXpWidget?: boolean; xpAutoStart?: boolean; essenceAlertEnabled?: boolean };
    saveImmediate: (patch: Record<string, unknown>) => unknown;
  };
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js')) as {
    chatParser: {
      emit(eventName: 'XP_CHANGED', data: { amount: number; timestamp: string; message: string }): void;
      parseLine(line: string): void;
    };
  };
  xpModule.xpTracker.start();
  assert.equal(xpModule.xpTracker.getStats().isActive, false, '기본 XP 세션이 자동으로 시작됐습니다.');

  config.saveImmediate({ showXpWidget: false });
  xpModule.xpTracker.startSession();
  assert.equal(xpModule.xpTracker.getStats().isActive, true, 'XP 세션 시작이 추적 상태를 켜지 못했습니다.');
  assert.equal(config.load().showXpWidget, false, 'XP 세션 시작이 숨겨 둔 HUD를 강제로 표시했습니다.');

  config.saveImmediate({ showXpWidget: true });
  xpModule.xpTracker.stopSession();
  assert.equal(xpModule.xpTracker.getStats().isActive, false, 'XP 세션 중지가 추적 상태를 끄지 못했습니다.');
  assert.equal(config.load().showXpWidget, true, 'XP 세션 중지가 표시 중인 HUD를 강제로 숨겼습니다.');

  xpModule.xpTracker.toggleSession();
  assert.equal(xpModule.xpTracker.getStats().isActive, true, 'XP 단축키 토글이 세션을 시작하지 못했습니다.');
  assert.equal(config.load().showXpWidget, true, 'XP 단축키로 세션을 시작할 때 HUD가 표시되지 않았습니다.');

  xpModule.xpTracker.toggleSession();
  assert.equal(xpModule.xpTracker.getStats().isActive, false, 'XP 단축키 토글이 세션을 일시정지하지 못했습니다.');
  assert.equal(config.load().showXpWidget, false, 'XP 단축키로 일시정지할 때 HUD가 숨겨지지 않았습니다.');

  // 경고 누적은 세션과 독립적이지만 테스트 중 실제 소리는 재생하지 않습니다.
  config.saveImmediate({ essenceAlertEnabled: false });
  const emitXp = (amount: number): void => chatParser.emit('XP_CHANGED', {
    amount,
    timestamp: '15시 57분 14초',
    message: amount >= 0 ? `경험치가 ${amount} 올랐습니다.` : `경험치가 ${Math.abs(amount)} 감소했습니다.`,
  });
  const parseExactExchangeLog = (): void => chatParser.parseLine(
    '<font size="2" color="white"> [15시 57분 14초] </font> <font size="2" color="#ff64ff">경험치가 10000000000 감소했습니다.</font></br>',
  );

  emitXp(5_000_000_000);
  let stats = xpModule.xpTracker.getStats();
  assert.equal(stats.xpSinceLastExchange, 5_000_000_000,
    '세션 정지 중 획득 경험치가 경고용 누적에 반영되지 않았습니다.');
  assert.equal(stats.total, 0, '세션 정지 중 경험치가 세션 총 경험치에 반영됐습니다.');
  assert.equal(stats.kills, 0, '세션 정지 중 경험치가 세션 처치 수에 반영됐습니다.');
  assert.equal(stats.essenceCount, 0, '세션 정지 중 교환이 없는데 세션 정수 횟수가 변경됐습니다.');

  xpModule.xpTracker.startSession();
  emitXp(2_000_000_000);
  parseExactExchangeLog();
  stats = xpModule.xpTracker.getStats();
  assert.equal(stats.total, 2_000_000_000,
    '100억 교환 로그가 세션 총 획득 경험치를 차감했습니다.');
  assert.equal(stats.kills, 1, '교환 로그가 처치로 집계되거나 양수 경험치 처치가 누락됐습니다.');
  assert.equal(stats.essenceCount, 1, '세션 중 정확한 100억 감소가 정수 교환 1회로 집계되지 않았습니다.');
  assert.equal(stats.xpSinceLastExchange, 0,
    '정확한 100억 감소가 경고용 경험치를 0으로 초기화하지 않았습니다.');

  emitXp(3_000_000_000);
  xpModule.xpTracker.resetXp();
  stats = xpModule.xpTracker.getStats();
  assert.equal(stats.total, 0, '세션 초기화 뒤 총 경험치가 남아 있습니다.');
  assert.equal(stats.kills, 0, '세션 초기화 뒤 처치 수가 남아 있습니다.');
  assert.equal(stats.essenceCount, 0, '세션 초기화 뒤 세션 정수 교환 횟수가 남아 있습니다.');
  assert.equal(stats.xpSinceLastExchange, 3_000_000_000,
    '세션 초기화가 독립적인 경고용 경험치까지 초기화했습니다.');

  xpModule.xpTracker.stopSession();
  parseExactExchangeLog();
  stats = xpModule.xpTracker.getStats();
  assert.equal(stats.xpSinceLastExchange, 0,
    '세션 정지 중 정확한 100억 감소가 경고용 경험치를 초기화하지 않았습니다.');
  assert.equal(stats.essenceCount, 0,
    '세션 정지 중 교환이 세션 정수 교환 횟수에 포함됐습니다.');

  const gameOverlay = fs.readFileSync(path.join(projectRoot, 'src', 'game-overlay.html'), 'utf8');
  const xpHud = fs.readFileSync(path.join(projectRoot, 'src', 'xp-hud.html'), 'utf8');
  assert.match(gameOverlay, /let showXpWidget = false;/, '게임 오버레이의 로컬 HUD 초기값이 숨김이 아닙니다.');
  assert.match(gameOverlay, /showXpWidget = config\.showXpWidget === true;/,
    '게임 오버레이가 누락된 HUD 표시 값을 보임으로 해석합니다.');
  assert.match(xpHud, /Math\.max\(0, ESSENCE_XP - xpSinceExchange\)/,
    '100억을 넘긴 경고용 경험치가 HUD에 음수 남은 시간으로 표시될 수 있습니다.');
  assert.match(xpHud, /xpSinceExchange >= ESSENCE_XP[\s\S]*?교환 확인 필요/,
    '100억 경고 이후 HUD가 사용자에게 교환 확인 필요 상태를 안내하지 않습니다.');
  assert.match(xpHud, /let currentShowXpWidget = false;/, '경험치 관리 창의 로컬 HUD 초기값이 숨김이 아닙니다.');
  assert.doesNotMatch(xpHud, /id="toggle-xp-auto-start"\s+checked/,
    '설정을 받기 전에 경험치 세션 자동 시작 체크박스가 켜져 보입니다.');

  console.log('XP HUD visibility and session policy checks passed.');
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
