import type { BrowserWindow } from 'electron';

interface WindowFocusControllerOptions {
  isDev: boolean;
  focusDebounceMs: number;
  focusRestoreDelayMs: number;
  onWindowFocused: () => void;
  canScheduleRestore: () => boolean;
  canRestoreFocus: () => boolean;
  restoreFocus: () => void;
}

/** 활성 창 순서, 개발자 도구 방어와 게임 포커스 복구 타이머를 관리합니다. */
export class WindowFocusController {
  private activeWindows: BrowserWindow[] = [];
  private focusDebounceTimer: NodeJS.Timeout | null = null;
  private focusRestoreTimer: NodeJS.Timeout | null = null;
  private restoreSuppressed = false;
  private interactiveLauncher: BrowserWindow | null = null;

  constructor(private readonly options: WindowFocusControllerOptions) {}

  attach(win: BrowserWindow): void {
    win.on('focus', () => {
      this.push(win);
      if (this.focusDebounceTimer) clearTimeout(this.focusDebounceTimer);
      this.focusDebounceTimer = setTimeout(() => {
        this.focusDebounceTimer = null;
        this.options.onWindowFocused();
      }, this.options.focusDebounceMs);
    });
    win.on('show', () => this.push(win));
    win.on('closed', () => this.remove(win));

    if (!this.options.isDev) {
      win.webContents.on('devtools-opened', () => {
        try {
          win.webContents.closeDevTools();
        } catch {
          // 폐기 중인 webContents는 무시합니다.
        }
      });
    }

    this.push(win);
  }

  setRestoreSuppressed(suppressed: boolean): void {
    this.restoreSuppressed = suppressed;
  }

  cancelPendingRestore(): void {
    if (!this.focusRestoreTimer) return;
    clearTimeout(this.focusRestoreTimer);
    this.focusRestoreTimer = null;
  }

  scheduleRestore(): void {
    if (this.restoreSuppressed || !this.options.canScheduleRestore()) return;
    this.cancelPendingRestore();
    this.focusRestoreTimer = setTimeout(() => {
      this.focusRestoreTimer = null;
      if (this.options.canRestoreFocus()) this.options.restoreFocus();
    }, this.options.focusRestoreDelayMs);
  }

  /** 메뉴/버튼 위에 포인터가 있는 런처만 보조 창 앞으로 둔다. 포커스는 이동하지 않는다. */
  setLauncherInteractive(win: BrowserWindow, active: boolean): boolean {
    if (win.isDestroyed()) return false;
    const next = active ? win : (this.interactiveLauncher === win ? null : this.interactiveLauncher);
    if (next === this.interactiveLauncher) return false;
    this.interactiveLauncher = next;
    return true;
  }

  getOrderedWindowHandles(
    mainWindow: BrowserWindow | null,
    dockWindow: BrowserWindow | null,
    gameOverlayWindow: BrowserWindow | null,
  ): string[] {
    const subWindows = this.activeWindows
      .filter(win => this.isVisible(win)
        && win !== mainWindow
        && win !== dockWindow
        && win !== gameOverlayWindow)
      .reverse();
    const launcher = this.interactiveLauncher;
    const foregroundLauncher = launcher && (launcher === mainWindow || launcher === dockWindow)
      && this.isVisible(launcher) ? launcher : null;
    const orderedWindows = foregroundLauncher ? [foregroundLauncher, ...subWindows] : [...subWindows];

    for (const win of [mainWindow, dockWindow, gameOverlayWindow]) {
      if (win && win !== foregroundLauncher && this.isVisible(win)) orderedWindows.push(win);
    }

    return orderedWindows.flatMap(win => {
      try {
        const handle = win.getNativeWindowHandle();
        if (handle.length >= 8) return [handle.readBigUint64LE().toString()];
        if (handle.length >= 4) return [handle.readUInt32LE(0).toString()];
      } catch {
        // 폐기 중인 네이티브 창 핸들은 제외합니다.
      }
      return [];
    });
  }

  /** 게임을 먼저 활성화한 직후, 사용자가 선택했던 TW-Overlay 창에 입력 포커스를 돌린다. */
  refocusVisibleWindowByHandle(hwndText: string): boolean {
    const target = this.activeWindows.find(win => this.isVisible(win)
      && this.getWindowHandle(win) === hwndText);
    if (!target) return false;
    try {
      target.focus();
      return target.isFocused();
    } catch {
      return false;
    }
  }

  private isVisible(win: BrowserWindow): boolean {
    return !win.isDestroyed() && win.isVisible();
  }

  private getWindowHandle(win: BrowserWindow): string | null {
    try {
      const handle = win.getNativeWindowHandle();
      if (handle.length >= 8) return handle.readBigUint64LE().toString();
      if (handle.length >= 4) return handle.readUInt32LE(0).toString();
    } catch {
      // 폐기 중인 네이티브 창 핸들은 제외합니다.
    }
    return null;
  }

  private push(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.activeWindows = this.activeWindows.filter(item => item !== win && !item.isDestroyed());
    this.activeWindows.push(win);
  }

  private remove(win: BrowserWindow): void {
    if (this.interactiveLauncher === win) this.interactiveLauncher = null;
    this.activeWindows = this.activeWindows.filter(item => item !== win);
  }
}
