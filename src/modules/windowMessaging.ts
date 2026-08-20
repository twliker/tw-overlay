/**
 * BrowserWindow 검색과 렌더러 IPC 전송을 한곳에서 처리한다.
 * 페이지별 첫 창 전송/전체 창 전송/앱 전체 브로드캐스트를 구분해
 * 기존 각 호출부의 전송 범위를 그대로 유지한다.
 */
import { BrowserWindow, WebContents } from 'electron';

function safeSend(window: BrowserWindow, channel: string, ...args: unknown[]): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
  try {
    // Electron 42에서는 창 닫힘 중 WebContents보다 mainFrame이 먼저 폐기될 수 있다.
    // webContents.send()는 이 짧은 구간에 내부 오류를 출력하므로 프레임 상태를 직접 확인한다.
    const frame = window.webContents.mainFrame;
    if (frame.isDestroyed() || frame.detached) return false;
    frame.send(channel, ...args);
    return true;
  } catch (error) {
    if (error instanceof Error && (
      error.message.includes('Render frame was disposed')
      || error.message.includes('WebFrameMain could be accessed')
    )) {
      return false;
    }
    throw error;
  }
}

function isPageWindow(window: BrowserWindow, pageName: string): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
  try {
    return window.webContents.getURL().includes(pageName);
  } catch {
    return false;
  }
}

export function findFirstWindowByPage(pageName: string): BrowserWindow | undefined {
  const windows = BrowserWindow?.getAllWindows?.() ?? [];
  return windows.find(window => isPageWindow(window, pageName));
}

export function sendToFirstWindowByPage(
  pageName: string,
  channel: string,
  ...args: unknown[]
): boolean {
  const target = findFirstWindowByPage(pageName);
  if (!target) return false;
  return safeSend(target, channel, ...args);
}

export function sendToAllWindowsByPage(
  pageName: string,
  channel: string,
  ...args: unknown[]
): number {
  let sentCount = 0;
  const windows = BrowserWindow?.getAllWindows?.() ?? [];
  windows.forEach(window => {
    if (!isPageWindow(window, pageName)) return;
    if (safeSend(window, channel, ...args)) sentCount++;
  });
  return sentCount;
}

export function broadcastToAllWindows(channel: string, ...args: unknown[]): number {
  let sentCount = 0;
  const windows = BrowserWindow?.getAllWindows?.() ?? [];
  windows.forEach(window => {
    if (safeSend(window, channel, ...args)) sentCount++;
  });
  return sentCount;
}

export function broadcastToAllWindowsExcept(
  excludedWebContents: WebContents,
  channel: string,
  ...args: unknown[]
): number {
  let sentCount = 0;
  const windows = BrowserWindow?.getAllWindows?.() ?? [];
  windows.forEach(window => {
    if (window.isDestroyed() || window.webContents === excludedWebContents) return;
    if (safeSend(window, channel, ...args)) sentCount++;
  });
  return sentCount;
}
