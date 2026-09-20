import type { BrowserWindow, Rectangle } from 'electron';
import type { ProgrammaticMoveTracker } from './programmaticMoveTracker';

interface WindowMovePersistenceOptions {
  key: string;
  tracker: ProgrammaticMoveTracker;
  canSave: () => boolean;
  savePosition: (bounds: Rectangle) => void;
  beforeSaveDrag?: () => void;
}

/**
 * 기능 계약 — 창 드래그 중에는 설정 복제·병합·저장을 하지 않습니다.
 *
 * - move는 프로그램 이동을 걸러내고 저장 필요 여부만 기록합니다. Windows의 will-move부터
 *   moved까지 자동 위치/Z-order 보정을 막으며, 마우스를 잡고 멈춰도 보호를 해제하지 않습니다.
 * - moved에서 실제 최종 좌표를 한 번 저장합니다. setPosition을 쓰는 renderer 이동처럼
 *   네이티브 종료 이벤트가 없는 경우에만 마지막 move 후 150ms에 저장합니다.
 * - 숨김/닫힘에서도 대기 좌표를 반영하고 타이머·드래그 상태를 정리합니다. 생성·자동 재배치와
 *   게임 미추적·화면 모드 전환 좌표의 저장 여부는 호출부의 기존 정책을 따릅니다.
 * - 회귀: scripts/check-window-move-persistence.ts, scripts/check-refactor-regressions.ts.
 */
export function attachWindowMovePersistence(win: BrowserWindow, options: WindowMovePersistenceOptions): void {
  const { key, tracker, canSave, savePosition } = options;
  let nativeDragging = false;
  let pending = false;
  let dragStart: Rectangle | undefined;
  let timer: NodeJS.Timeout | null = null;

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const finish = (adjust = false) => {
    cancelTimer();
    const shouldSave = pending;
    pending = false;
    try {
      if (shouldSave && !win.isDestroyed() && canSave()) {
        const final = win.getBounds();
        // Windows Escape 취소로 시작 좌표에 돌아왔으면 맞춤으로 다시 이동시키지 않는다.
        if (adjust && (!dragStart || final.x !== dragStart.x || final.y !== dragStart.y)) options.beforeSaveDrag?.();
        savePosition(win.getBounds());
      }
    } finally {
      nativeDragging = false;
      dragStart = undefined;
      tracker.endUserDrag(key);
    }
  };

  win.on('will-move', () => {
    cancelTimer();
    if (!nativeDragging) dragStart = win.getBounds();
    nativeDragging = true;
    tracker.beginUserDrag(key);
  });
  win.on('move', () => {
    if (tracker.consume(key, win.getBounds())) return;
    pending = canSave();
    tracker.markUserDrag(key);
    if (!nativeDragging) {
      cancelTimer();
      timer = setTimeout(() => finish(true), 150);
    }
  });
  win.on('moved', () => finish(true));
  win.on('hide', () => finish());
  // prepend하여 호출부의 isClosing 표시보다 먼저 마지막 위치를 반영합니다.
  win.prependListener('close', () => finish());
  win.on('closed', () => {
    cancelTimer();
    pending = false;
    nativeDragging = false;
    tracker.endUserDrag(key);
  });
}
