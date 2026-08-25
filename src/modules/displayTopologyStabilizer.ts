import type { Display } from 'electron';

export interface DisplayTopologySnapshot {
  id: number;
  bounds: Display['bounds'];
  workArea: Display['workArea'];
  scaleFactor: number;
  rotation: number;
}

/** Electron 디스플레이 이벤트의 순서와 무관하게 비교할 수 있는 화면 구성 서명을 만듭니다. */
export function createDisplayTopologySignature(displays: readonly DisplayTopologySnapshot[]): string {
  return JSON.stringify(
    [...displays]
      .sort((left, right) => left.id - right.id)
      .map(display => ({
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
      })),
  );
}

/**
 * 모니터 연결·해제와 RDP 전환 중 잠시 나타나는 중간 화면 구성을 건너뛰고,
 * 같은 화면 구성이 일정 시간 유지된 뒤에만 복구 작업을 허용합니다.
 */
export class DisplayTopologyStabilizer {
  private startedAt: number | null = null;
  private candidateSignature: string | null = null;
  private candidateSince = 0;

  constructor(
    private readonly stableDurationMs: number,
    private readonly maxWaitMs: number,
  ) {}

  begin(now: number): void {
    this.startedAt = now;
    this.candidateSignature = null;
    this.candidateSince = now;
  }

  observe(signature: string, now: number): boolean {
    if (this.startedAt === null) this.begin(now);

    if (this.candidateSignature !== signature) {
      this.candidateSignature = signature;
      this.candidateSince = now;
      return now - this.startedAt! >= this.maxWaitMs;
    }

    return now - this.candidateSince >= this.stableDurationMs
      || now - this.startedAt! >= this.maxWaitMs;
  }
}
