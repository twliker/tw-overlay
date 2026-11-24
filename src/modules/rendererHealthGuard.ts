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
const mouseModes = new WeakMap<BrowserWindow, {ignore:boolean; options?:{forward?:boolean}}>();
const failedWindows = new WeakMap<BrowserWindow, {wasVisible:boolean; needsReload:boolean}>();
let hasShownFailureDialog = false;

export function setWindowMouseMode(window:BrowserWindow,ignore:boolean,options?:{forward?:boolean}):void {
  mouseModes.set(window,{ignore,options});
  if (!failedWindows.has(window)) window.setIgnoreMouseEvents(ignore,options);
}

export const hasRendererFailure=(window:BrowserWindow):boolean=>failedWindows.has(window);
/** 렌더러가 죽었거나 페이지 로드에 실패해 다시 불러와야만 쓸 수 있는 창. 일시적인 응답 없음(unresponsive)은
 * 'responsive'로 스스로 회복하고 초안도 남아 있으므로 교체 대상이 아니다. 회귀: check-window-visibility.ts */
export const needsRendererReplacement=(window:BrowserWindow):boolean=>failedWindows.get(window)?.needsReload===true;

function describeWindow(window: BrowserWindow): string {
  const webContents = window.webContents;
  const url = webContents.isDestroyed() ? '' : webContents.getURL();
  return `id=${window.id} webContents=${webContents.id} url=${url || 'not-loaded'}`;
}

function enterInputSafeFailureState(window: BrowserWindow, page: string, reason: string, diagnostic = reason, needsReload = true): void {
  if (appState.isQuitting || window.isDestroyed()) return;
  log(`[RENDERER_HEALTH] ${reason} page=${page} version=${app.getVersion()} ${describeWindow(window)}`, true);
  try {
    const previous=failedWindows.get(window);
    failedWindows.set(window,{wasVisible:previous?.wasVisible ?? window.isVisible(),needsReload:needsReload || previous?.needsReload===true});
    window.setIgnoreMouseEvents(true, { forward: true });
    if (window.isVisible()) window.hide();
  } catch (error) {
    log(`[RENDERER_HEALTH] fail-safe 적용 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (needsReload && !hasShownFailureDialog) {
    hasShownFailureDialog = true;
    dialog.showErrorBox(
      'TW-Overlay 화면 표시 오류',
      `화면을 표시하지 못했습니다. 문제가 반복되면 아래 오류 정보를 전달해 주세요.\n\nTW-Overlay ${app.getVersion()} | ${page} | ${diagnostic}`,
    );
  }
}

export function attachRendererHealthGuard(window: BrowserWindow, restoreVisibility:()=>void=()=>window.showInactive()): void {
  if (guardedWindows.has(window)) return;
  guardedWindows.add(window);
  const recover=(loaded:boolean)=>{
    const failure=failedWindows.get(window);
    if (!failure || failure.needsReload && !loaded || appState.isQuitting || window.isDestroyed()
      || window.webContents.isDestroyed() || window.webContents.isCrashed()) return;
    try {
      const mode=mouseModes.get(window);
      window.setIgnoreMouseEvents(mode?.ignore ?? false,mode?.options);
      failedWindows.delete(window);
      if (failure.wasVisible) restoreVisibility();
    } catch (error) {log('[RENDERER_HEALTH] 창 복구 실패: '+String(error),true);}
  };
  let page = 'unknown';
  // The current URL can be empty when the first renderer fails to start.
  // Keep only the local page name for the native error dialog.
  window.webContents.on('did-start-navigation', ({ url, isMainFrame }) => {
    if (isMainFrame) page = url.startsWith('file:') ? basename(new URL(url).pathname) : 'unknown';
  });

  window.webContents.on('did-finish-load', () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    log(`[RENDERER_HEALTH] loaded ${describeWindow(window)}`);
    recover(true);
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (appState.isQuitting || !isMainFrame || errorCode === -3) return;
    const diagnostic = `load-failed code=${errorCode} description=${errorDescription}`;
    enterInputSafeFailureState(
      window,
      page,
      `${diagnostic} validatedUrl=${validatedURL || 'unknown'}`,
      diagnostic,
    );
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (appState.isQuitting) return;
    enterInputSafeFailureState(window, page, `process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  window.on('unresponsive', () => {
    if (appState.isQuitting) return;
    enterInputSafeFailureState(window, page, 'unresponsive', 'unresponsive', false);
  });
  window.on('responsive', () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    log(`[RENDERER_HEALTH] responsive ${describeWindow(window)}`);
    recover(false);
  });
}
