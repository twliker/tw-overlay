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

  const config = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as {
    saveImmediate: (patch: Record<string, unknown>) => unknown;
  };
  const { abandonedTracker } = require(path.join(projectRoot, 'dist', 'modules', 'abandonedTracker.js')) as {
    abandonedTracker: {
      start(): void;
      reset(): void;
      forceVisible(visible: boolean): void;
      beginGameSession(): void;
      getState(): {
        isActive: boolean;
        profit: number;
        regions: Record<string, number>;
        stoneGains: Record<string, number>;
        stoneLosses: Record<string, number>;
        totalFee: number;
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
  assert.equal(abandonedTracker.getState().isActive, true, '자동 숨김 뒤 다음 활동에서 HUD가 다시 표시되지 않았습니다.');
  abandonedTracker.reset();

  const pollingSource = fs.readFileSync(path.join(projectRoot, 'src', 'modules', 'pollingLoop.ts'), 'utf8');
  const ipcSource = fs.readFileSync(path.join(projectRoot, 'src', 'modules', 'ipcHandlers.ts'), 'utf8');
  assert.match(pollingSource, /const isNewGameSession = !gameWasEverFound;[\s\S]*?if \(isNewGameSession\)[\s\S]*?abandonedTracker\.beginGameSession\(\)/,
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
