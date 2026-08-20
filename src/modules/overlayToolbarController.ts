interface OverlayToolbarControllerOptions {
  hideDelayMs: number;
  canHide: () => boolean;
  isCursorInsideWindow: () => boolean;
  show: () => void;
  hide: () => void;
}

/** 브라우저 오버레이의 툴바와 콘텐츠 영역 마우스 상태 및 자동 숨김 타이머를 관리합니다. */
export class OverlayToolbarController {
  private mouseInToolbar = false;
  private mouseInContent = false;
  private hideTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: OverlayToolbarControllerOptions) {}

  enterToolbar(): void {
    this.mouseInToolbar = true;
    this.show();
  }

  leaveToolbar(): void {
    this.mouseInToolbar = false;
    if (!this.mouseInContent) this.scheduleHide();
  }

  enterContent(): void {
    this.mouseInContent = true;
    this.show();
  }

  leaveContent(): void {
    this.mouseInContent = false;
    if (!this.mouseInToolbar) this.scheduleHide();
  }

  dispose(): void {
    if (!this.hideTimer) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private show(): void {
    this.dispose();
    this.options.show();
  }

  private scheduleHide(): void {
    this.dispose();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.mouseInToolbar || this.mouseInContent) return;
      if (!this.options.canHide() || this.options.isCursorInsideWindow()) return;
      this.options.hide();
    }, this.options.hideDelayMs);
  }
}
