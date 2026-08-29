/** 테일즈위버 영상에서 확인한 실전 QTE 한 바퀴 회전 시간. */
const QTE_ACTUAL_DURATION_MS = 1_200;
const QTE_BLUE_SWEEP_DEG = 46;
const QTE_YELLOW_SWEEP_DEG = 14;
const QTE_BLUE_SWEEP_VARIANCE_DEG = 12;
const QTE_YELLOW_SWEEP_VARIANCE_DEG = 6;
const QTE_START_END_GUARD_DEG = 10;

type QteHitResult = 'success' | 'great' | 'fail';

interface QteRoundDefinition {
  /** 12시를 0도로 삼아 시계 방향으로 측정한 파란색 판정 구간 시작점. */
  blueStartDeg: number;
  blueSweepDeg: number;
  /** 노란색 대성공 구간은 파란색과 별개 위치에 배치한다. */
  yellowStartDeg: number;
  yellowSweepDeg: number;
  durationMs: number;
}

interface QteDifficulty {
  durationMs: number;
  /** 무작위 폭의 중심값과 중심에서 양쪽으로 달라질 수 있는 최대 각도. */
  blueSweepDeg: number;
  blueSweepVarianceDeg: number;
  yellowSweepDeg: number;
  yellowSweepVarianceDeg: number;
}

interface QteRoundRandomness {
  /** 파란색 구간 위치. 이전 호출부와의 호환성을 위해 position 이름을 유지한다. */
  position: number;
  /** 노란색 구간 위치. 생략하면 position에서 별도의 결정값을 파생한다. */
  yellowPosition?: number;
  blueSweep: number;
  yellowSweep: number;
}

interface QteChallengeRecords {
  bestScore: number;
  bestCombo: number;
  bestStage: number;
  totalAttempts: number;
  totalSuccess: number;
  totalGreat: number;
  soundEnabled: boolean;
}

const DEFAULT_QTE_RECORDS: Readonly<QteChallengeRecords> = Object.freeze({
  bestScore: 0,
  bestCombo: 0,
  bestStage: 0,
  totalAttempts: 0,
  totalSuccess: 0,
  totalGreat: 0,
  soundEnabled: true,
});

function normalizeQteAngle(angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) return 0;
  return ((angleDeg % 360) + 360) % 360;
}

/** 0과 360을 걸치는 판정 구간도 동일하게 처리하는 시계 방향 각도 포함 검사. */
function isAngleInsideQteArc(angleDeg: number, startDeg: number, sweepDeg: number): boolean {
  if (!Number.isFinite(sweepDeg) || sweepDeg <= 0) return false;
  if (sweepDeg >= 360) return true;
  const distance = normalizeQteAngle(angleDeg) - normalizeQteAngle(startDeg);
  const clockwiseDistance = distance < 0 ? distance + 360 : distance;
  return clockwiseDistance <= sweepDeg;
}

/** 노란색을 먼저 검사해 경계가 겹치더라도 대성공 판정이 일반 성공에 가려지지 않게 한다. */
function classifyQteHit(angleDeg: number, round: QteRoundDefinition): QteHitResult {
  if (isAngleInsideQteArc(angleDeg, round.yellowStartDeg, round.yellowSweepDeg)) return 'great';
  if (isAngleInsideQteArc(angleDeg, round.blueStartDeg, round.blueSweepDeg)) return 'success';
  return 'fail';
}

function sanitizeRandomUnit(randomValue: number): number {
  if (!Number.isFinite(randomValue)) return 0;
  return Math.max(0, Math.min(0.999999999, randomValue));
}

/**
 * 테일즈위버처럼 매 라운드 두 구간의 크기와 위치를 각각 무작위로 정한다.
 * 크기가 달라져도 파란색은 항상 노란색보다 넓게 유지한다.
 * 두 구간은 서로 겹치지 않으며, 360도를 넘어 시작점으로 감겨 한 판정 영역이
 * 첫 순간과 마지막 순간으로 쪼개지지 않도록 시작·종료 반응 여유 안에 배치한다.
 * renderer와 테스트가 같은 라운드 생성 규칙을 사용하도록 순수 함수로 분리한다.
 */
function randomizeQteSweep(centerDeg: number, varianceDeg: number, randomValue: number): number {
  const safeVariance = Number.isFinite(varianceDeg) ? Math.max(0, varianceDeg) : 0;
  const randomized = centerDeg + (sanitizeRandomUnit(randomValue) * 2 - 1) * safeVariance;
  return Math.round(randomized * 10) / 10;
}

function createQteRound(randomness: QteRoundRandomness, difficulty: QteDifficulty): QteRoundDefinition {
  const durationMs = Math.max(400, Math.round(difficulty.durationMs));
  const yellowSweepDeg = Math.max(4, Math.min(90, randomizeQteSweep(
    difficulty.yellowSweepDeg,
    difficulty.yellowSweepVarianceDeg,
    randomness.yellowSweep,
  )));
  const blueSweepDeg = Math.max(yellowSweepDeg + 1, Math.min(180, randomizeQteSweep(
    difficulty.blueSweepDeg,
    difficulty.blueSweepVarianceDeg,
    randomness.blueSweep,
  )));
  const usableStartDeg = QTE_START_END_GUARD_DEG;
  const usableEndDeg = 360 - QTE_START_END_GUARD_DEG;
  const blueStartRange = Math.max(0, usableEndDeg - usableStartDeg - blueSweepDeg);
  const blueStartDeg = usableStartDeg + sanitizeRandomUnit(randomness.position) * blueStartRange;

  // 노란색은 파란색의 앞 또는 뒤에 독립적으로 놓는다. 가능한 두 구간의 길이를 합친 뒤
  // 하나의 무작위 값을 매핑하면 재시도 없이도 균등하게 위치를 고를 수 있고 겹침도 생기지 않는다.
  const yellowBeforeStart = usableStartDeg;
  const yellowBeforeEnd = blueStartDeg - yellowSweepDeg;
  const yellowAfterStart = blueStartDeg + blueSweepDeg;
  const yellowAfterEnd = usableEndDeg - yellowSweepDeg;
  const yellowBeforeRange = Math.max(0, yellowBeforeEnd - yellowBeforeStart);
  const yellowAfterRange = Math.max(0, yellowAfterEnd - yellowAfterStart);
  const yellowTotalRange = yellowBeforeRange + yellowAfterRange;
  const derivedYellowPosition = (sanitizeRandomUnit(randomness.position) + 0.61803398875) % 1;
  const yellowPosition = sanitizeRandomUnit(randomness.yellowPosition ?? derivedYellowPosition);
  const yellowOffset = yellowPosition * yellowTotalRange;
  const yellowStartDeg = yellowBeforeRange > 0 && yellowOffset < yellowBeforeRange
    ? yellowBeforeStart + yellowOffset
    : yellowAfterStart + (yellowOffset - yellowBeforeRange);
  return {
    blueStartDeg,
    blueSweepDeg,
    yellowStartDeg,
    yellowSweepDeg,
    durationMs,
  };
}

function getPracticeDifficulty(durationMs = QTE_ACTUAL_DURATION_MS): QteDifficulty {
  return {
    durationMs,
    blueSweepDeg: QTE_BLUE_SWEEP_DEG,
    blueSweepVarianceDeg: QTE_BLUE_SWEEP_VARIANCE_DEG,
    yellowSweepDeg: QTE_YELLOW_SWEEP_DEG,
    yellowSweepVarianceDeg: QTE_YELLOW_SWEEP_VARIANCE_DEG,
  };
}

/** 챌린지는 10라운드마다 속도와 판정 폭이 조금씩 어려워지되 파란색 우위를 유지한다. */
function getQteChallengeDifficulty(stage: number): QteDifficulty {
  const normalizedStage = Math.max(1, Math.floor(stage));
  const step = normalizedStage - 1;
  return {
    durationMs: Math.max(650, Math.round(QTE_ACTUAL_DURATION_MS * Math.pow(0.94, step))),
    blueSweepDeg: Math.max(26, QTE_BLUE_SWEEP_DEG - step * 2),
    blueSweepVarianceDeg: Math.max(5, QTE_BLUE_SWEEP_VARIANCE_DEG - step * 0.5),
    yellowSweepDeg: Math.max(8, QTE_YELLOW_SWEEP_DEG - step * 0.5),
    yellowSweepVarianceDeg: Math.max(2, QTE_YELLOW_SWEEP_VARIANCE_DEG - step * 0.25),
  };
}

function getQteComboMultiplier(combo: number): number {
  const normalizedCombo = Math.max(0, Math.floor(combo));
  return Math.min(3, 1 + Math.floor(normalizedCombo / 5) * 0.25);
}

function calculateQteScore(result: QteHitResult, comboAfterHit: number, feverActive: boolean): number {
  if (result === 'fail') return 0;
  const baseScore = result === 'great' ? 300 : 100;
  const feverMultiplier = feverActive ? 2 : 1;
  return Math.round(baseScore * getQteComboMultiplier(comboAfterHit) * feverMultiplier);
}

function safeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

/** 손상된 localStorage 값이 화면과 점수 계산에 NaN을 퍼뜨리지 않도록 필드별로 복구한다. */
function sanitizeQteChallengeRecords(value: unknown): QteChallengeRecords {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    bestScore: safeNonNegativeInteger(record.bestScore),
    bestCombo: safeNonNegativeInteger(record.bestCombo),
    bestStage: safeNonNegativeInteger(record.bestStage),
    totalAttempts: safeNonNegativeInteger(record.totalAttempts),
    totalSuccess: safeNonNegativeInteger(record.totalSuccess),
    totalGreat: safeNonNegativeInteger(record.totalGreat),
    soundEnabled: typeof record.soundEnabled === 'boolean' ? record.soundEnabled : true,
  };
}

interface QteChallengeApi {
  QTE_ACTUAL_DURATION_MS: number;
  QTE_BLUE_SWEEP_DEG: number;
  QTE_YELLOW_SWEEP_DEG: number;
  DEFAULT_QTE_RECORDS: Readonly<QteChallengeRecords>;
  normalizeQteAngle: typeof normalizeQteAngle;
  isAngleInsideQteArc: typeof isAngleInsideQteArc;
  classifyQteHit: typeof classifyQteHit;
  createQteRound: typeof createQteRound;
  getPracticeDifficulty: typeof getPracticeDifficulty;
  getQteChallengeDifficulty: typeof getQteChallengeDifficulty;
  getQteComboMultiplier: typeof getQteComboMultiplier;
  calculateQteScore: typeof calculateQteScore;
  sanitizeQteChallengeRecords: typeof sanitizeQteChallengeRecords;
}

interface Window {
  qteChallenge: QteChallengeApi;
}

const QTE_CHALLENGE_API: QteChallengeApi = Object.freeze({
  QTE_ACTUAL_DURATION_MS,
  QTE_BLUE_SWEEP_DEG,
  QTE_YELLOW_SWEEP_DEG,
  DEFAULT_QTE_RECORDS,
  normalizeQteAngle,
  isAngleInsideQteArc,
  classifyQteHit,
  createQteRound,
  getPracticeDifficulty,
  getQteChallengeDifficulty,
  getQteComboMultiplier,
  calculateQteScore,
  sanitizeQteChallengeRecords,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = QTE_CHALLENGE_API;
}
if (typeof window !== 'undefined') {
  window.qteChallenge = QTE_CHALLENGE_API;
}
