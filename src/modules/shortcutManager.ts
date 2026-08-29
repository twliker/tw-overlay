/**
 * 기능 계약 — 전역 단축키
 *
 * - 설정의 `shortcuts`가 유일한 키 조합 원본이며, 앱/게임이 포커스 범위에 있을 때만 기능을
 *   실행합니다. 다른 프로그램 사용 중 키 입력을 가로채는 동작으로 넓히지 않습니다.
 * - 포커스가 빠져나가면 전역 단축키를 해제하고 돌아오면 전체를 다시 등록합니다. 설정 변경도 기존
 *   등록을 먼저 모두 해제한 뒤 재등록해 이전 키 조합이 남지 않게 합니다.
 * - 게임을 먼저 실행한 뒤 앱을 시작한 경우에도 tracker의 첫 안정 폴링이 실제 전경 창을 다시 판정해
 *   단축키를 등록합니다. 같은 포커스 통지가 반복돼도 등록이 비어 있으면 한 번 더 복구를 시도합니다.
 * - 각 콜백은 해당 기능의 공개 API를 호출해야 하며 설정·창 상태를 별도로 복제하지 않습니다.
 *   특히 경험치 세션은 시작 시 HUD 표시, 일시정지 시 HUD 숨김이라는 결합 동작을 유지합니다.
 * - 운영체제에서 이미 사용 중인 키 등록 실패는 기록하되 다른 단축키 등록을 중단하지 않습니다.
 */
import { globalShortcut } from 'electron';
import * as config from './config';
import * as wm from './windowManager';
import * as tracker from './tracker';
import { FOCUS_DELAY_MS } from './constants';
import { log } from './logger';
import { chatLogProcessor } from './chatLogProcessor';
import { buffTimerManager } from './buffTimerManager';
import { broadcastToAllWindows } from './windowMessaging';
import { abandonedTracker } from './abandonedTracker';

let _isFocused = false;
let _registrationActive = false;

/**
 * 모든 단축키 등록
 */
export function registerAll(): void {
  // 설정 화면의 단축키 입력 종료와 포커스 이벤트가 겹쳐도 자기 자신의 기존 등록과 충돌하지 않게
  // 공개 등록 경로 자체를 멱등적으로 만듭니다.
  globalShortcut.unregisterAll();
  _registrationActive = false;
  const cfg = config.load();
  const shortcuts = cfg.shortcuts;
  if (!shortcuts) return;

  // 1. 창 투과 토글
  if (shortcuts.toggleClickThrough) {
    const registered = globalShortcut.register(shortcuts.toggleClickThrough, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle Click-Through');
      const isClickThrough = wm.toggleClickThrough();
      if (isClickThrough) {
        // 투과 활성화 시 게임창에 포커스 주어 조작 편의성 제공
        setTimeout(() => {
          tracker.focusGameWindow();
        }, FOCUS_DELAY_MS);
      }
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleClickThrough}`);
    }
  }

  // 2. 숙제 체크 리스트 창 토글
  if (shortcuts.toggleContentsChecker) {
    const registered = globalShortcut.register(shortcuts.toggleContentsChecker, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle Contents Checker');
      wm.toggleContentsCheckerWindow();
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleContentsChecker}`);
    }
  }

  // 3. 버프 타이머 HUD 표시 토글
  if (shortcuts.toggleBuffHud) {
    const registered = globalShortcut.register(shortcuts.toggleBuffHud, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle Buff HUD');
      const current = config.load();
      wm.applySettings({ showBuffHud: !current.showBuffHud });
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleBuffHud}`);
    }
  }

  // 3-2. 오늘 요약 HUD 상태 순환: 접힘 → 펼침 → 숨김 → 접힘
  if (shortcuts.toggleTodaySummaryHud) {
    const registered = globalShortcut.register(shortcuts.toggleTodaySummaryHud, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Cycle Today Summary HUD');
      const current = config.load();
      if (current.showTodaySummaryHud === false) {
        wm.applySettings({ showTodaySummaryHud: true, todaySummaryCollapsed: true });
      } else if (current.todaySummaryCollapsed ?? true) {
        wm.applySettings({ todaySummaryCollapsed: false });
      } else {
        wm.applySettings({ showTodaySummaryHud: false });
      }
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleTodaySummaryHud}`);
    }
  }

  // 3-3. 어벤던로드 HUD 표시 토글
  if (shortcuts.toggleAbandonedHud) {
    const registered = globalShortcut.register(shortcuts.toggleAbandonedHud, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle Abandoned HUD');
      abandonedTracker.toggleVisibility();
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleAbandonedHud}`);
    }
  }

  // 4. Dock 바 토글
  if (shortcuts.toggleDock) {
    const registered = globalShortcut.register(shortcuts.toggleDock, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle Dock');
      wm.toggleDockWindow();
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleDock}`);
    }
  }

  // 5. 채팅 오버레이 창 토글
  if (shortcuts.toggleChatOverlaySync) {
    const registered = globalShortcut.register(shortcuts.toggleChatOverlaySync, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle Chat Overlay');
      wm.toggleChatOverlayWindow();
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleChatOverlaySync}`);
    }
  }

  // 6. 경험치 세션 초기화
  if (shortcuts.resetXpSession) {
    const registered = globalShortcut.register(shortcuts.resetXpSession, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Reset XP Session');
      chatLogProcessor.resetXp();
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.resetXpSession}`);
    }
  }

  // 6-2. 경험치 세션 측정 시작/중지 토글
  if (shortcuts.toggleXpSession) {
    const registered = globalShortcut.register(shortcuts.toggleXpSession, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle XP Session');
      // 사용자에게 약속된 결합 동작이다: 시작하면 HUD 표시, 일시정지하면 HUD 숨김.
      // 앱 시작/자동 시작 정책과 혼동해 세션만 토글하도록 분리하지 않는다.
      import('./xpTracker').then(mod => mod.xpTracker.toggleSession())
        .catch(err => log(`[SHORTCUT] xpTracker 로드 실패: ${err}`));
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleXpSession}`);
    }
  }

  // 7. 버프 타이머 버프 전체 삭제
  if (shortcuts.clearAllBuffs) {
    const registered = globalShortcut.register(shortcuts.clearAllBuffs, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Clear All Buffs');
      buffTimerManager.clearAllBuffs();
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.clearAllBuffs}`);
    }
  }

  // 8. 시간 측정(Stopwatch) 토글
  if (shortcuts.toggleTimer) {
    const registered = globalShortcut.register(shortcuts.toggleTimer, () => {
      if (!tracker.isGameOrAppForeground()) return;
      log('[SHORTCUT] Toggle Timer');
      broadcastToAllWindows('timer-toggle', 'toggle');
    });
    if (!registered) {
      log(`[SHORTCUT] 단축키 등록 실패 (이미 사용 중): ${shortcuts.toggleTimer}`);
    }
  }

  const configuredAccelerators = Object.values(shortcuts)
    .filter((accelerator): accelerator is string => typeof accelerator === 'string' && accelerator.length > 0);
  _registrationActive = configuredAccelerators.every(accelerator => globalShortcut.isRegistered(accelerator));
  log(`[SHORTCUT] Shortcut registration pass ${_registrationActive ? 'completed' : 'incomplete'}`);
}

/**
 * 모든 단축키 해제
 */
export function unregisterAll(): void {
  globalShortcut.unregisterAll();
  _registrationActive = false;
  log('[SHORTCUT] All shortcuts unregistered');
}

/**
 * 포커스 상태 업데이트에 따른 단축키 동적 제어
 * @param isFocused 게임 창 또는 앱 창이 포커스되었는지 여부
 */
export function updateFocusState(isFocused: boolean): void {
  if (_isFocused === isFocused && (!isFocused || _registrationActive)) return;
  _isFocused = isFocused;

  if (_isFocused) {
    registerAll();
  } else {
    unregisterAll();
  }
}

/**
 * 설정 변경 시 단축키 갱신 (설정 페이지에서 호출 예정)
 */
export function reloadShortcuts(): void {
  if (_isFocused) {
    unregisterAll();
    registerAll();
  }
}
