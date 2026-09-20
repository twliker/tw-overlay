import { BrowserWindow, screen } from 'electron';
const geometry = require('../shared/windowSnap') as WindowSnapApi;

/** 사용자가 끌어 놓은 실제 창만 한 번 맞춘다. 숨김·최소화·다른 화면의 창은 제외한다.
 * 이동 저장은 기존 windowMovePersistence가 맡는다. DPI 변환을 다시 하지 않는다.
 */
export function snapReleasedWindow(win: BrowserWindow, peers: BrowserWindow[], beforeMove: (x: number, y: number) => void): void {
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isMaximized()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const candidates = peers.filter(peer => peer !== win && !peer.isDestroyed() && peer.isVisible() && !peer.isMinimized()
    && screen.getDisplayMatching(peer.getBounds()).id === display.id).map(peer => peer.getBounds());
  const next = geometry.snap(bounds, candidates, display.workArea);
  if (next.x === bounds.x && next.y === bounds.y) return;
  beforeMove(next.x, next.y);
  win.setPosition(Math.round(next.x), Math.round(next.y));
}
