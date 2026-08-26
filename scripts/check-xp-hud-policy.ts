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
      getStats(): { isActive?: boolean };
    };
  };
  assert.equal(xpModule.shouldAutoStartXpSession({}), false, '누락된 자동 시작 값이 true로 해석됩니다.');
  assert.equal(xpModule.shouldAutoStartXpSession({ xpAutoStart: false }), false);
  assert.equal(xpModule.shouldAutoStartXpSession({ xpAutoStart: true }), true);

  const config = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as {
    load: () => { showXpWidget?: boolean; xpAutoStart?: boolean };
    saveImmediate: (patch: Record<string, unknown>) => unknown;
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

  const gameOverlay = fs.readFileSync(path.join(projectRoot, 'src', 'game-overlay.html'), 'utf8');
  const xpHud = fs.readFileSync(path.join(projectRoot, 'src', 'xp-hud.html'), 'utf8');
  assert.match(gameOverlay, /let showXpWidget = false;/, '게임 오버레이의 로컬 HUD 초기값이 숨김이 아닙니다.');
  assert.match(gameOverlay, /showXpWidget = config\.showXpWidget === true;/,
    '게임 오버레이가 누락된 HUD 표시 값을 보임으로 해석합니다.');
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
