import type { Display, Rectangle } from 'electron';

export interface WindowPlacement {
  x: number;
  y: number;
}

function getOverlapArea(left: Rectangle, right: Rectangle): number {
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return overlapWidth * overlapHeight;
}

/** 창이 어떤 디스플레이에 한 픽셀이라도 걸쳐 있는지 판정합니다. */
export function isWindowVisibleOnDisplays(bounds: Rectangle, displays: readonly Display[]): boolean {
  return displays.some(display => getOverlapArea(bounds, display.bounds) > 0);
}

/** 지정된 작업 영역의 중앙에 창을 배치할 좌표를 계산합니다. */
export function centerWindowInWorkArea(width: number, height: number, workArea: Rectangle): WindowPlacement {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}
