import { BrowserWindow, type WebContents } from 'electron';
import { load as loadConfig } from './config';

let overlay: BrowserWindow | null = null;
let requestId = 0;
const watchedWindows = new WeakSet<BrowserWindow>();
let pending: { id: number; promise: Promise<boolean>; resolve(value: boolean): void; save: boolean } | undefined;
let exitSafetyTimeout: NodeJS.Timeout | null = null;

function broadcast(editing: boolean, outcome?: 'saved' | 'cancelled'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('notification-edit-state', editing, outcome);
  }
}

function restoreInput(outcome?: 'saved' | 'cancelled'): void {
  if (exitSafetyTimeout) {
    clearTimeout(exitSafetyTimeout);
    exitSafetyTimeout = null;
  }
  if (overlay && !overlay.isDestroyed()) {
    overlay.setIgnoreMouseEvents(true);
    overlay.setFocusable(false);
    overlay.setAlwaysOnTop(false);
    const config = loadConfig();
    overlay.webContents.send('config-data', config);
  }
  overlay = null;
  broadcast(false, outcome);
}

/** 알림 위치 편집 모드를 시작합니다. 게임 오버레이의 마우스 투과를 해제하고 편집 상태를 브로드캐스트합니다. */
export function beginNotificationEdit(win: BrowserWindow): void {
  if (overlay === win) return;
  cancelNotificationEdit();
  overlay = win;
  if (!watchedWindows.has(win)) {
    watchedWindows.add(win);
    win.once('closed', () => { if (overlay === win) cancelNotificationEdit(); });
  }
  win.setFocusable(true);
  win.setIgnoreMouseEvents(false);
  win.setAlwaysOnTop(false);
  win.show();
  const enter = () => { if (overlay === win && !win.isDestroyed()) win.webContents.send('notification-edit-mode', true); };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', enter);
  else enter();
  broadcast(true);
}

export function requestNotificationEditExit(save: boolean): Promise<boolean> {
  if (!overlay || overlay.isDestroyed()) {
    restoreInput(save ? 'saved' : 'cancelled');
    return Promise.resolve(true);
  }
  if (pending) return pending.promise;
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  pending = { id: ++requestId, promise, resolve, save };
  overlay.webContents.send('notification-edit-mode', false, save, pending.id);

  // 렌더러 미응답 시에도 마우스 투과가 풀려 방치되지 않도록 안전 타임아웃
  if (exitSafetyTimeout) clearTimeout(exitSafetyTimeout);
  exitSafetyTimeout = setTimeout(() => {
    if (pending) {
      console.warn('[NOTIFICATION_EDIT] 종료 응답 타임아웃 - 강제 입력 투과 복원');
      cancelNotificationEdit();
    }
  }, 2500);

  return promise;
}

export function isNotificationEditRequest(sender: WebContents, id: unknown): boolean {
  return Boolean(overlay && !overlay.isDestroyed() && sender === overlay.webContents && pending && pending.id === id);
}

export function finishNotificationEdit(sender: WebContents, id: unknown, success: unknown): boolean {
  if (!isNotificationEditRequest(sender, id) || typeof success !== 'boolean') return false;
  if (exitSafetyTimeout) {
    clearTimeout(exitSafetyTimeout);
    exitSafetyTimeout = null;
  }
  const completed = pending!;
  pending = undefined;
  if (success) {
    restoreInput(completed.save ? 'saved' : 'cancelled');
  }
  completed.resolve(success);
  return true;
}

export function cancelNotificationEdit(): void {
  if (exitSafetyTimeout) {
    clearTimeout(exitSafetyTimeout);
    exitSafetyTimeout = null;
  }
  const interrupted = pending;
  pending = undefined;
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('notification-edit-mode', false, false);
  if (overlay) restoreInput('cancelled');
  interrupted?.resolve(false);
}
