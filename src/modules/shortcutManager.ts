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

/**
 * 모든 단축키 등록
 */
export function registerAll(): void {
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

  log('[SHORTCUT] All shortcuts registered');
}

/**
 * 모든 단축키 해제
 */
export function unregisterAll(): void {
  globalShortcut.unregisterAll();
  log('[SHORTCUT] All shortcuts unregistered');
}

/**
 * 포커스 상태 업데이트에 따른 단축키 동적 제어
 * @param isFocused 게임 창 또는 앱 창이 포커스되었는지 여부
 */
export function updateFocusState(isFocused: boolean): void {
  if (_isFocused === isFocused) return;
  _isFocused = isFocused;

  if (_isFocused) {
    unregisterAll(); // 안전을 위해 기존 단축키 제거 후 재등록
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
