interface Point {
  x: number;
  y: number;
}

interface ProgrammaticMove extends Point {
  fromX: number;
  fromY: number;
  ignoreMismatchUntil: number;
}

/** 네이티브 setPosition/setBounds가 발생시키는 중간 move 이벤트를 사용자 드래그와 구분하고, 사용자 드래그 중인 창의 동기화 간섭을 방지합니다. */
export class ProgrammaticMoveTracker {
  private readonly moves: Record<string, ProgrammaticMove> = {};
  private readonly userDragUntil: Record<string, number> = {};

  constructor(
    private readonly positionThreshold: number,
    private readonly intermediateMoveWindowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(key: string, target: Point, current: Point): void {
    this.moves[key] = {
      x: target.x,
      y: target.y,
      fromX: current.x,
      fromY: current.y,
      ignoreMismatchUntil: this.now() + this.intermediateMoveWindowMs,
    };
  }

  consume(key: string, current?: Point): boolean {
    const pending = this.moves[key];
    if (!pending) return false;

    if (current) {
      const reachedTarget = Math.abs(current.x - pending.x) <= this.positionThreshold
        && Math.abs(current.y - pending.y) <= this.positionThreshold;
      if (reachedTarget) {
        delete this.moves[key];
        return true;
      }

      const isWithinMovePath = (value: number, from: number, to: number) =>
        value >= Math.min(from, to) - this.positionThreshold
        && value <= Math.max(from, to) + this.positionThreshold;
      const isNativeIntermediateMove = isWithinMovePath(current.x, pending.fromX, pending.x)
        && isWithinMovePath(current.y, pending.fromY, pending.y);
      if (this.now() <= pending.ignoreMismatchUntil && isNativeIntermediateMove) return true;
    }

    delete this.moves[key];
    return false;
  }

  /** 사용자가 마우스로 창을 직접 드래그 중임을 기록합니다. */
  markUserDrag(key: string, durationMs = 350): void {
    this.userDragUntil[key] = this.now() + durationMs;
  }

  /** 해당 창이 현재 사용자에 의해 마우스 드래그 중인지 확인합니다. */
  isUserDragging(key: string): boolean {
    const until = this.userDragUntil[key];
    if (!until) return false;
    if (this.now() > until) {
      delete this.userDragUntil[key];
      return false;
    }
    return true;
  }

  /** 현재 사용자가 어떤 창이든 마우스로 드래그 중인지 확인합니다. */
  isAnyUserDragging(): boolean {
    const now = this.now();
    for (const key of Object.keys(this.userDragUntil)) {
      if (this.userDragUntil[key] && now <= this.userDragUntil[key]) {
        return true;
      } else {
        delete this.userDragUntil[key];
      }
    }
    return false;
  }

  clear(): void {
    for (const key of Object.keys(this.moves)) delete this.moves[key];
    for (const key of Object.keys(this.userDragUntil)) delete this.userDragUntil[key];
  }
}

