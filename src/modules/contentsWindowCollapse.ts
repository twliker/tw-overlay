import { screen, type BrowserWindow, type Rectangle } from 'electron';

/**
 * 기능 계약 — 숙제창 자동 접기의 임시 크기
 * 접힘은 표시 상태이며 사용자 창 크기를 저장하지 않는다. 원래 최소 크기·높이·리사이즈 상태를
 * 기억하고 펼칠 때 현재 작업 영역 안으로 제한한다. 프리셋 캡처도 펼친 크기를 사용한다.
 * 창 폐기 시 상태를 제거하며, 저장·복원 정책은 windowManager의 동일 경로에서 적용한다.
 */
export class ContentsWindowCollapse {
  private readonly states = new Map<BrowserWindow, { height: number; minimum: number[]; resizable: boolean }>();
  private readonly restoring = new WeakMap<BrowserWindow, { width: number; height: number }>();
  private readonly adjusting = new WeakSet<BrowserWindow>();
  private readonly watched = new WeakSet<BrowserWindow>();
  constructor(private readonly beforePositionChange?: (x: number, y: number) => void) {}
  isCollapsed(win: BrowserWindow): boolean { return this.states.has(win); }
  isTemporarySize(win: BrowserWindow): boolean {
    if (this.states.has(win) || this.adjusting.has(win)) return true;
    const expected = this.restoring.get(win);
    if (!expected) return false;
    const actual = win.getBounds();
    if (actual.width === expected.width && actual.height === expected.height) return true;
    // setBounds의 지연 resize까지 보존하고 실제 사용자가 다른 크기로 바꿀 때 저장을 재개한다.
    this.restoring.delete(win);
    return false;
  }
  captureBounds(win: BrowserWindow): Rectangle {
    const bounds = win.getBounds(), state = this.states.get(win);
    return state ? { ...bounds, height: state.height } : bounds;
  }
  updateExpandedSize(win: BrowserWindow, width: number, height: number, minWidth: number, minHeight: number): boolean {
    const state = this.states.get(win);
    if (!state) return false;
    state.height = height; state.minimum = [minWidth, minHeight];
    win.setMinimumSize(minWidth, 56); win.setSize(width, 56);
    return true;
  }
  set(win: BrowserWindow, collapsed: boolean): boolean {
    if (win.isDestroyed()) return false;
    if (collapsed === this.isCollapsed(win)) return true;
    if (!this.watched.has(win)) {
      this.watched.add(win);
      win.once('closed', () => this.states.delete(win));
    }
    if (collapsed) {
      this.restoring.delete(win);
      this.states.set(win, { height: win.getBounds().height, minimum: win.getMinimumSize(), resizable: win.isResizable() });
      win.setResizable(false);
      win.setMinimumSize(win.getMinimumSize()[0], 56);
      win.setSize(win.getBounds().width, 56);
    } else {
      const state = this.states.get(win)!;
      this.states.delete(win);
      const bounds = win.getBounds(), workArea = screen.getDisplayMatching(bounds).workArea;
      const minWidth = Math.min(state.minimum[0], workArea.width), minHeight = Math.min(state.minimum[1], workArea.height);
      const width = Math.min(bounds.width, workArea.width), height = Math.max(minHeight, Math.min(state.height, workArea.height));
      const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
      const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height));
      this.restoring.set(win, { width, height });
      this.beforePositionChange?.(x, y);
      this.adjusting.add(win);
      try {
        win.setResizable(state.resizable);
        win.setMinimumSize(minWidth, minHeight);
        win.setBounds({ width, height, x, y });
      } finally { this.adjusting.delete(win); }
    }
    win.webContents.send('contents-collapse-state', collapsed);
    return true;
  }
}
