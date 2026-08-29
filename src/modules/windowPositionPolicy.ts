/**
 * 기능 계약 — 게임 추적 여부에 따른 창 좌표 변환
 *
 * - `게임창 따라가기`가 켜진 동안에는 브라우저 오버레이를 게임 좌측 상단, 그 외 보조 창을
 *   게임 우측 상단 기준의 상대 오프셋으로 저장합니다. 일반 창모드와 창모드 전체화면은
 *   `windowManager`가 서로 다른 상대 오프셋 맵으로 관리하되 좌표 변환 공식은 공유합니다.
 * - 따라가기를 끄면 화면 절대 좌표를 별도로 보존합니다. 게임 창 이동·재실행·앱 재시작은 이 값을
 *   바꾸지 않으며, 다시 따라가기를 켤 때 현재 화면 위치가 튀지 않도록 최신 게임 좌표로 오프셋을
 *   다시 계산합니다.
 * - 게임 화면 자체와 사이드바/독은 제품 구조상 항상 게임에 붙어 있어야 하므로 고정 좌표 대상이 아닙니다.
 */
import type { GameRect, ScreenPosition, WindowPosition, WindowPositionKey } from '../shared/types';

export function supportsFixedScreenPosition(key: WindowPositionKey): boolean {
  return key !== 'gameOverlay' && key !== 'dock';
}

export function toScreenPosition(
  key: WindowPositionKey,
  gameRect: GameRect,
  position: WindowPosition,
): ScreenPosition {
  if (key === 'overlay') {
    return {
      x: Math.round(gameRect.x + position.offsetX),
      y: Math.round(gameRect.y + position.offsetY),
    };
  }
  return {
    x: Math.round(gameRect.x + gameRect.width + position.offsetX),
    y: Math.round(gameRect.y + position.offsetY),
  };
}

export function toRelativePosition(
  key: WindowPositionKey,
  gameRect: GameRect,
  position: ScreenPosition,
): WindowPosition {
  if (key === 'overlay') {
    return {
      offsetX: Math.round(position.x - gameRect.x),
      offsetY: Math.round(position.y - gameRect.y),
    };
  }
  return {
    offsetX: Math.round(position.x - (gameRect.x + gameRect.width)),
    offsetY: Math.round(position.y - gameRect.y),
  };
}

/**
 * Follow ON에서 게임만 이동하면 저장돼 있던 절대 좌표는 이전 화면 위치를 가리킬 수 있습니다.
 * OFF로 전환하는 순간에는 현재 상대 오프셋으로 절대 좌표를 새로 만들고, 이미 OFF인 동안에는
 * 게임이 움직여도 기존 절대 좌표를 그대로 보존합니다.
 */
export function resolveFixedScreenPosition(
  key: WindowPositionKey,
  gameRect: GameRect,
  relativePosition: WindowPosition,
  storedScreenPosition: ScreenPosition | undefined,
  fixedModeWasActive: boolean,
): ScreenPosition {
  if (fixedModeWasActive && storedScreenPosition) return { ...storedScreenPosition };
  return toScreenPosition(key, gameRect, relativePosition);
}
