/**
 * 기능 계약 — 테일즈위버 창모드/창모드 전체화면 전환
 *
 * - 게임 창이 모니터 경계를 거의 덮으면 `windowed-fullscreen`, 그 외에는 `windowed`로 봅니다.
 *   DWM/혼합 DPI의 1~수 px 오차 때문에 정확한 좌표 일치만 요구하지 않습니다.
 * - 테두리 스타일 변경, 큰 해상도 변화 또는 두 모드 사이의 이동은 즉시 확정하지 않고 짧은 안정화
 *   구간을 둡니다. 이 구간에는 보조 창을 움직이거나 화면 이탈 복구 위치를 저장하면 안 됩니다.
 * - 일반적인 작은 창 이동·크기 조절은 전환으로 오인하지 않고 기존 Follow 동작을 유지합니다.
 */
import type { Rectangle } from 'electron';

export type GameWindowMode = 'windowed' | 'windowed-fullscreen';
export type GameWindowModePhase = 'stable' | 'transitioning';

export interface GameWindowModeObservation {
  bounds: Rectangle;
  displayBounds: Rectangle;
  windowStyle?: number;
}

export interface GameWindowModeResult {
  phase: GameWindowModePhase;
  mode: GameWindowMode;
  targetMode: GameWindowMode;
  modeChanged: boolean;
  previousMode: GameWindowMode | null;
  previousStableBounds: Rectangle | null;
}

const WS_CAPTION = 0x00c00000;
const FULLSCREEN_EDGE_TOLERANCE = 12;
const LARGE_RESIZE_RATIO = 0.1;
const TRANSITION_COVERAGE_RATIO = 0.8;
export const GAME_WINDOW_MODE_STABLE_MS = 250;

function copyBounds(bounds: Rectangle): Rectangle {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function sameObservation(left: GameWindowModeObservation, right: GameWindowModeObservation): boolean {
  return sameBounds(left.bounds, right.bounds)
    && sameBounds(left.displayBounds, right.displayBounds)
    && left.windowStyle === right.windowStyle;
}

function hasCaption(windowStyle: number | undefined): boolean | null {
  return typeof windowStyle === 'number' ? (windowStyle & WS_CAPTION) !== 0 : null;
}

function coverageRatio(bounds: Rectangle, displayBounds: Rectangle): number {
  const left = Math.max(bounds.x, displayBounds.x);
  const top = Math.max(bounds.y, displayBounds.y);
  const right = Math.min(bounds.x + bounds.width, displayBounds.x + displayBounds.width);
  const bottom = Math.min(bounds.y + bounds.height, displayBounds.y + displayBounds.height);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const displayArea = Math.max(1, displayBounds.width * displayBounds.height);
  return overlap / displayArea;
}

/** DWM 테두리와 DPI 반올림 오차를 허용한 창모드 전체화면 경계 판정입니다. */
export function isNearFullscreenBounds(gameBounds: Rectangle, displayBounds: Rectangle): boolean {
  const leftDelta = Math.abs(gameBounds.x - displayBounds.x);
  const topDelta = Math.abs(gameBounds.y - displayBounds.y);
  const rightDelta = Math.abs(
    (gameBounds.x + gameBounds.width) - (displayBounds.x + displayBounds.width),
  );
  const bottomDelta = Math.abs(
    (gameBounds.y + gameBounds.height) - (displayBounds.y + displayBounds.height),
  );
  return leftDelta <= FULLSCREEN_EDGE_TOLERANCE
    && topDelta <= FULLSCREEN_EDGE_TOLERANCE
    && rightDelta <= FULLSCREEN_EDGE_TOLERANCE
    && bottomDelta <= FULLSCREEN_EDGE_TOLERANCE;
}

export function classifyGameWindowMode(
  bounds: Rectangle,
  displayBounds: Rectangle,
): GameWindowMode {
  return isNearFullscreenBounds(bounds, displayBounds) ? 'windowed-fullscreen' : 'windowed';
}

/**
 * 연속 위치 이벤트가 발생하는 동안 기존 안정 모드를 유지하고, 마지막 변화 뒤 일정 시간이 지난
 * 관측에서만 새 모드를 확정합니다. 호출자는 `transitioning` 동안 보조 창 배치를 동결해야 합니다.
 */
export class GameWindowModeController {
  private stableMode: GameWindowMode | null = null;
  private stableBounds: Rectangle | null = null;
  private lastObservation: GameWindowModeObservation | null = null;
  private transitionLastChangedAt: number | null = null;

  constructor(private readonly stableDurationMs = GAME_WINDOW_MODE_STABLE_MS) {}

  private shouldStartTransition(observation: GameWindowModeObservation, targetMode: GameWindowMode): boolean {
    if (!this.stableMode || !this.lastObservation) return false;
    if (targetMode !== this.stableMode) return true;

    const previousCaption = hasCaption(this.lastObservation.windowStyle);
    const currentCaption = hasCaption(observation.windowStyle);
    if (previousCaption !== null && currentCaption !== null && previousCaption !== currentCaption) return true;

    if (this.stableMode === 'windowed-fullscreen'
      && !sameBounds(this.lastObservation.bounds, observation.bounds)) return true;

    const previous = this.lastObservation.bounds;
    const widthChange = Math.abs(observation.bounds.width - previous.width) / Math.max(1, previous.width);
    const heightChange = Math.abs(observation.bounds.height - previous.height) / Math.max(1, previous.height);
    const nearDisplay = Math.max(
      coverageRatio(previous, this.lastObservation.displayBounds),
      coverageRatio(observation.bounds, observation.displayBounds),
    ) >= TRANSITION_COVERAGE_RATIO;
    return nearDisplay && Math.max(widthChange, heightChange) >= LARGE_RESIZE_RATIO;
  }

  observe(observation: GameWindowModeObservation, now: number = Date.now()): GameWindowModeResult {
    const normalized: GameWindowModeObservation = {
      bounds: copyBounds(observation.bounds),
      displayBounds: copyBounds(observation.displayBounds),
      windowStyle: observation.windowStyle,
    };
    const targetMode = classifyGameWindowMode(normalized.bounds, normalized.displayBounds);

    if (!this.stableMode) {
      this.stableMode = targetMode;
      this.stableBounds = copyBounds(normalized.bounds);
      this.lastObservation = normalized;
      return {
        phase: 'stable', mode: targetMode, targetMode, modeChanged: false,
        previousMode: null, previousStableBounds: null,
      };
    }

    const observationChanged = !this.lastObservation || !sameObservation(this.lastObservation, normalized);
    if (this.transitionLastChangedAt === null
      && this.shouldStartTransition(normalized, targetMode)) {
      this.transitionLastChangedAt = now;
    } else if (this.transitionLastChangedAt !== null && observationChanged) {
      this.transitionLastChangedAt = now;
    }
    this.lastObservation = normalized;

    if (this.transitionLastChangedAt !== null) {
      if (now - this.transitionLastChangedAt < this.stableDurationMs) {
        return {
          phase: 'transitioning', mode: this.stableMode, targetMode, modeChanged: false,
          previousMode: this.stableMode,
          previousStableBounds: this.stableBounds ? copyBounds(this.stableBounds) : null,
        };
      }

      const previousMode = this.stableMode;
      const previousStableBounds = this.stableBounds ? copyBounds(this.stableBounds) : null;
      this.stableMode = targetMode;
      this.stableBounds = copyBounds(normalized.bounds);
      this.transitionLastChangedAt = null;
      return {
        phase: 'stable', mode: targetMode, targetMode,
        modeChanged: previousMode !== targetMode,
        previousMode,
        previousStableBounds,
      };
    }

    this.stableBounds = copyBounds(normalized.bounds);
    return {
      phase: 'stable', mode: this.stableMode, targetMode: this.stableMode, modeChanged: false,
      previousMode: this.stableMode,
      previousStableBounds: this.stableBounds ? copyBounds(this.stableBounds) : null,
    };
  }

  isTransitioning(): boolean {
    return this.transitionLastChangedAt !== null;
  }

  getStableBounds(): Rectangle | null {
    return this.stableBounds ? copyBounds(this.stableBounds) : null;
  }

  reset(): void {
    this.stableMode = null;
    this.stableBounds = null;
    this.lastObservation = null;
    this.transitionLastChangedAt = null;
  }
}
