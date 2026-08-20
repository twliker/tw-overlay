import type { Rectangle } from 'electron';
import type { GameRect, WindowPosition } from '../shared/types';

export interface Size {
  width: number;
  height: number;
}

export function resolvePhysicalGameRect(
  currentRect: GameRect,
  lastForegroundSize: Size | null,
): { physicalRect: GameRect; foregroundSize: Size | null } {
  const foregroundSize = currentRect.isForeground
    ? { width: currentRect.width, height: currentRect.height }
    : lastForegroundSize;
  return {
    physicalRect: {
      x: currentRect.x,
      y: currentRect.y,
      width: foregroundSize?.width ?? currentRect.width,
      height: foregroundSize?.height ?? currentRect.height,
      isForeground: currentRect.isForeground,
    },
    foregroundSize,
  };
}

export function isFullscreenBounds(gameBounds: Rectangle, displayBounds: Rectangle): boolean {
  return gameBounds.x === displayBounds.x
    && gameBounds.y === displayBounds.y
    && gameBounds.width === displayBounds.width
    && gameBounds.height === displayBounds.height;
}

export function calculateAttachedWindowPosition(gameRect: GameRect, position: WindowPosition): { x: number; y: number } {
  return {
    x: Math.round(gameRect.x + gameRect.width + position.offsetX),
    y: Math.round(gameRect.y + position.offsetY),
  };
}

export function calculateBrowserOverlayPosition(gameRect: GameRect, position: WindowPosition): { x: number; y: number } {
  return {
    x: Math.round(gameRect.x + position.offsetX),
    y: Math.round(gameRect.y + position.offsetY),
  };
}

export function calculateSidebarBounds(
  sidebarPosition: string,
  gameRect: GameRect,
  gameEdgeDipX: number,
  currentSidebarBounds: Rectangle,
): Rectangle {
  return {
    x: sidebarPosition === 'left' ? gameEdgeDipX - currentSidebarBounds.width : gameEdgeDipX,
    y: gameRect.y + 30,
    width: currentSidebarBounds.width,
    height: gameRect.height - 30,
  };
}

export function calculateSidebarResizeBounds(
  sidebarPosition: string,
  currentBounds: Rectangle,
  newWidth: number,
): Rectangle {
  return {
    x: sidebarPosition === 'left'
      ? currentBounds.x + currentBounds.width - newWidth
      : currentBounds.x,
    y: currentBounds.y,
    width: newWidth,
    height: currentBounds.height,
  };
}

export function resizeBounds(
  currentBounds: Rectangle,
  width?: number,
  height?: number,
): Rectangle {
  return {
    x: currentBounds.x,
    y: currentBounds.y,
    width: width ?? currentBounds.width,
    height: height ?? currentBounds.height,
  };
}

export function hasBoundsChanged(current: Rectangle, target: Rectangle, threshold: number): boolean {
  return Math.abs(current.x - target.x) > threshold
    || Math.abs(current.y - target.y) > threshold
    || Math.abs(current.width - target.width) > threshold
    || Math.abs(current.height - target.height) > threshold;
}

export function hasPositionChanged(current: Rectangle, target: { x: number; y: number }, threshold: number): boolean {
  return Math.abs(current.x - target.x) > threshold
    || Math.abs(current.y - target.y) > threshold;
}
