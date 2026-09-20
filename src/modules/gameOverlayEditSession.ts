import { BrowserWindow, type WebContents } from 'electron';
import { load as loadConfig } from './config';

let overlay: BrowserWindow | null = null;
let requestId = 0;
const watchedWindows = new WeakSet<BrowserWindow>();
let pending: { id: number; promise: Promise<boolean>; resolve(value: boolean): void } | undefined;

function broadcast(editing: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('game-overlay-edit-state', editing);
  }
}
function restoreInput(): void {
  if (overlay && !overlay.isDestroyed()) {
    overlay.setIgnoreMouseEvents(true);
    overlay.setFocusable(false);
    overlay.setAlwaysOnTop(false);
    // 편집 중 받은 설정은 드래그 좌표를 덮지 않는다. renderer의 편집 정리가 끝난 뒤
    // 최신 확정값을 다시 보내 취소/창 닫기가 그동안 적용한 프리셋·공유 배치를 되돌리지 않게 한다.
    // 저장 성공도 같은 경로를 사용하므로 응답 대기 중 다른 창이 저장한 최신값을 따른다.
    // 실패한 저장은 여기로 오지 않으며, 재저장이나 다른 설정 창의 초안 갱신은 하지 않는다.
    // 회귀: check-hud-edit-settings의 실제 설정 UI/프리셋/공유/IPC/디스크/전체 HUD 검사.
    const config = loadConfig();
    overlay.webContents.send('config-data', config);
    overlay.webContents.send('today-summary-config', config);
  }
  overlay = null;
  broadcast(false);
}

/** 저장 성공 응답을 받은 뒤에만 입력 투과를 복원한다. 실패하면 편집을 유지한다. */
export function beginGameOverlayEdit(win: BrowserWindow): void {
  if (overlay === win) return;
  cancelGameOverlayEdit();
  overlay = win;
  if (!watchedWindows.has(win)) {
    watchedWindows.add(win);
    win.once('closed', () => { if (overlay === win) cancelGameOverlayEdit(); });
  }
  win.setFocusable(true);
  win.setIgnoreMouseEvents(false);
  win.setAlwaysOnTop(false);
  win.show();
  const enter = () => { if (overlay === win && !win.isDestroyed()) win.webContents.send('game-overlay-edit-mode', true); };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', enter);
  else enter();
  broadcast(true);
}

export function requestGameOverlayEditExit(save: boolean): Promise<boolean> {
  if (!overlay || overlay.isDestroyed()) return Promise.resolve(true);
  if (pending) return pending.promise;
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  pending = { id: ++requestId, promise, resolve };
  overlay.webContents.send('game-overlay-edit-mode', false, save, pending.id);
  return promise;
}

export function isGameOverlayEditRequest(sender: WebContents, id: unknown): boolean {
  return Boolean(overlay && !overlay.isDestroyed() && sender === overlay.webContents && pending && pending.id === id);
}

export function finishGameOverlayEdit(sender: WebContents, id: unknown, success: unknown): boolean {
  if (!isGameOverlayEditRequest(sender, id) || typeof success !== 'boolean') return false;
  const completed = pending!;
  pending = undefined;
  if (success) restoreInput();
  completed.resolve(success);
  return true;
}

/** 설정 창 닫기와 위치 초기화는 저장 없이 취소한다. 이전 응답은 새 편집을 종료할 수 없다. */
export function cancelGameOverlayEdit(): void {
  const interrupted = pending;
  pending = undefined;
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('game-overlay-edit-mode', false, false);
  if (overlay) restoreInput();
  interrupted?.resolve(false);
}
