/**
 * 기능 계약 — renderer 표시 실패 안전장치
 *
 * - renderer의 메인 문서 로드 실패, 프로세스 종료 또는 무응답이 감지되면 해당 창을 즉시 숨기고
 *   마우스 입력을 투과시켜 보이지 않는 네이티브 창이 게임 조작을 막지 않게 합니다.
 * - 정상적인 탐색 취소(ERR_ABORTED)와 하위 frame 실패는 화면 전체 실패로 취급하지 않습니다.
 * - 배포판에서도 오류 원인과 URL을 앱 로그에 남기고, 한 실행에서 한 번만
 *   오류 코드가 포함된 네이티브 안내를 표시합니다.
 *   renderer가 고장난 상태에서 HTML 기반 안내창에 의존하면 안 됩니다.
 * - 회귀: scripts/check-renderer-health.ts에서 실제 화면 프로세스를 종료시켜 확인합니다.
 */
import { app, BrowserWindow, dialog } from 'electron';
import { basename } from 'node:path';
import { log } from './logger';
import { appState } from './constants';

const guardedWindows = new WeakSet<BrowserWindow>();
let hasShownFailureDialog = false;

function describeWindow(window: BrowserWindow): string {
  const webContents = window.webContents;
  const url = webContents.isDestroyed() ? '' : webContents.getURL();
  return `id=${window.id} webContents=${webContents.id} url=${url || 'not-loaded'}`;
}

function enterInputSafeFailureState(window: BrowserWindow, page: string, reason: string, diagnostic = reason): void {
  if (appState.isQuitting || window.isDestroyed()) return;
  log(`[RENDERER_HEALTH] ${reason} page=${page} version=${app.getVersion()} ${describeWindow(window)}`, true);
  try {
    window.setIgnoreMouseEvents(true, { forward: true });
    if (window.isVisible()) window.hide();
  } catch (error) {
    log(`[RENDERER_HEALTH] fail-safe 적용 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!hasShownFailureDialog) {
    hasShownFailureDialog = true;
    dialog.showErrorBox(
      'TW-Overlay 화면 표시 오류',
      `화면을 표시하지 못했습니다. 문제가 반복되면 아래 오류 정보를 전달해 주세요.\n\nTW-Overlay ${app.getVersion()} | ${page} | ${diagnostic}`,
    );
  }
}

export function attachRendererHealthGuard(window: BrowserWindow): void {
  if (guardedWindows.has(window)) return;
  guardedWindows.add(window);
  let isClosing = false;
  let page = 'unknown';
  window.on('close', () => { isClosing = true; });
  // The current URL can be empty when the first renderer fails to start.
  // Keep only the local page name for the native error dialog.
  window.webContents.on('did-start-navigation', ({ url, isMainFrame }) => {
    if (isMainFrame) page = url.startsWith('file:') ? basename(new URL(url).pathname) : 'unknown';
  });

  window.webContents.on('did-finish-load', () => {
    log(`[RENDERER_HEALTH] loaded ${describeWindow(window)}`);
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isClosing || appState.isQuitting || !isMainFrame || errorCode === -3) return;
    const diagnostic = `load-failed code=${errorCode} description=${errorDescription}`;
    enterInputSafeFailureState(
      window,
      page,
      `${diagnostic} validatedUrl=${validatedURL || 'unknown'}`,
      diagnostic,
    );
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (isClosing || appState.isQuitting) return;
    enterInputSafeFailureState(window, page, `process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  window.on('unresponsive', () => {
    if (isClosing || appState.isQuitting) return;
    enterInputSafeFailureState(window, page, 'unresponsive');
  });
  window.on('responsive', () => {
    log(`[RENDERER_HEALTH] responsive ${describeWindow(window)}`);
  });
}
