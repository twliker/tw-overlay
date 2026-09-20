import type { BrowserWindow } from 'electron';

/**
 * 기능 계약 — 사용자가 요청한 전체 창 숨김·복원
 *
 * 영구 표시 설정을 바꾸거나 창을 닫지 않는다. 숨김 시 실제 보이던 창만 세션에 기억하며,
 * 숨김 중 로딩/자동 표시 요청은 버린다. 복원은 포커스를 빼앗지 않고 현재 게임 가시성 정책을
 * 따르며, 게임이 없어서 보류한 창은 다음 정상 동기화에서 복원한다. 숨겨져 있던 독/창을
 * 같은 게임 세션의 자동 동기화가 함께 열지 않도록 억제한다. 명시적인 개별 열기 또는 다음
 * 게임 복귀 시점에는 해당 창의 기존 활성 설정에 따른 표시를 다시 허용한다.
 * 창이 폐기되면 재생성하지 않는다. 세션은 디스크·프리셋·클라우드에 저장하지 않는다.
 */
export class UserWindowVisibility {
  private hidden = false;
  private readonly pending = new Set<BrowserWindow>();
  private readonly excluded = new Set<BrowserWindow>();
  private readonly watched = new WeakSet<BrowserWindow>();

  isHidden(): boolean { return this.hidden; }
  preserves(win: BrowserWindow): boolean { return this.hidden || this.pending.has(win); }
  owns(win: BrowserWindow): boolean { return this.pending.has(win) || this.excluded.has(win); }

  private watch(win: BrowserWindow): void {
    if (this.watched.has(win)) return;
    this.watched.add(win);
    win.once('closed', () => { this.pending.delete(win); this.excluded.delete(win); });
  }

  hide(windows: BrowserWindow[]): void {
    if (this.hidden) return;
    this.hidden = true;
    // 복원 대기 중 다시 숨긴 경우에도 원래 대상은 잃지 않는다.
    for (const win of windows) {
      if (win.isDestroyed()) continue;
      this.watch(win);
      if (win.isVisible() && !win.isMinimized()) {
        this.pending.add(win);
        this.excluded.delete(win);
      } else if (!this.pending.has(win)) this.excluded.add(win);
      if (win.isVisible()) win.hide();
    }
  }

  canShow(win: BrowserWindow): boolean {
    if (win.isDestroyed()) return false;
    if (this.hidden) {
      this.watch(win);
      if (!this.pending.has(win)) this.excluded.add(win);
      return false;
    }
    return !this.excluded.has(win);
  }

  allowExplicitOpen(win: BrowserWindow): void { this.excluded.delete(win); }

  restore(canRestore: (win: BrowserWindow) => boolean): void {
    this.hidden = false;
    this.resume(canRestore);
  }

  resume(canRestore: (win: BrowserWindow) => boolean): void {
    if (this.hidden) return;
    for (const win of this.pending) {
      if (win.isDestroyed()) { this.pending.delete(win); continue; }
      if (!canRestore(win)) continue;
      this.pending.delete(win);
      this.excluded.delete(win);
      win.showInactive();
    }
  }
}
