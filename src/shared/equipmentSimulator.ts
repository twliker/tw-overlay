/**
 * 테일즈위버 장비 강화 / 인챈트 / 인크립트 공식 확률 기반 시뮬레이터 및 기댓값 계산 모듈
 * 출처:
 * - 장비 강화: https://static.tales.nexon.com/Probability/Game/1
 * - 인챈트: https://static.tales.nexon.com/Probability/Game/2
 * - 인크립트: https://static.tales.nexon.com/Probability/Game/3
 */

// ==========================================
// 1. 장비 강화 (Equipment Enhancement)
// ==========================================

interface EnhanceRateInfo {
  stage: number; // 0 -> 1이면 0
  label: string;
  baseSuccessRate: number; // 0 ~ 1
  baseFailPenaltyRate: number; // 실패 시 페널티 확률 (0 ~ 1)
  penaltyType: 'none' | 'minus1' | 'minus2' | 'minus3' | 'reset';
  penaltyDrop: number; // 하락 단계 수치 (reset의 경우 현재 단계 전부)
}

const ENHANCE_RATES: readonly EnhanceRateInfo[] = Object.freeze([
  { stage: 0, label: '0 → 1강', baseSuccessRate: 1.0, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 1, label: '1 → 2강', baseSuccessRate: 0.7, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 2, label: '2 → 3강', baseSuccessRate: 0.5, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 3, label: '3 → 4강', baseSuccessRate: 0.3, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 4, label: '4 → 5강', baseSuccessRate: 0.2, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 5, label: '5 → 6강', baseSuccessRate: 0.1, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 6, label: '6 → 7강', baseSuccessRate: 0.07, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 7, label: '7 → 8강', baseSuccessRate: 0.07, baseFailPenaltyRate: 1.0, penaltyType: 'minus1', penaltyDrop: 1 },
  { stage: 8, label: '8 → 9강', baseSuccessRate: 0.05, baseFailPenaltyRate: 1.0, penaltyType: 'minus2', penaltyDrop: 2 },
  { stage: 9, label: '9 → 10강', baseSuccessRate: 0.05, baseFailPenaltyRate: 1.0, penaltyType: 'minus3', penaltyDrop: 3 },
  { stage: 10, label: '10 → 11강', baseSuccessRate: 0.05, baseFailPenaltyRate: 1.0, penaltyType: 'reset', penaltyDrop: 10 },
  { stage: 11, label: '11 → 12강', baseSuccessRate: 0.0001, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 12, label: '12 → 13강', baseSuccessRate: 0.0001, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 13, label: '13 → 14강', baseSuccessRate: 0.00009, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 14, label: '14 → 15강', baseSuccessRate: 0.00008, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 15, label: '15 → 16강', baseSuccessRate: 0.00007, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 16, label: '16 → 17강', baseSuccessRate: 0.00006, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 17, label: '17 → 18강', baseSuccessRate: 0.00005, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 18, label: '18 → 19강', baseSuccessRate: 0.00004, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
  { stage: 19, label: '19 → 20강', baseSuccessRate: 0.00003, baseFailPenaltyRate: 0.0, penaltyType: 'none', penaltyDrop: 0 },
]);

interface EnhanceSimulationOptions {
  startStage: number; // 0 ~ 20
  targetStage: number; // 1 ~ 20
  luckyStoneCount: number; // 0 ~ 5 (개당 +1%p)
  talismanCount: number; // 0 ~ 5 (7강 이상에서 개당 실패 패널티 10%p 감소)
  isNoPenaltyScroll?: boolean; // 노패널티 강화권 여부
  noPenaltyScrollRate?: number; // 노패널티 성공 확률 (예: 0.05, 0.1, 1.0 등)
  currencyType?: 'seed' | 'elso'; // 수수료 지불 재화 (시드 또는 엘소)
  costPerAttempt?: number; // 1회 시도시 소모 시드/엘소 기본 수수료
  costPerStage?: number[]; // 단계별 1회 수수료 배열 (0~19강, 미지정 시 costPerAttempt 사용)
  stonePrice?: number; // 행운석 1개당 가격 (시드)
  talismanPrice?: number; // 부적 1개당 가격 (시드)
  scrollPrice?: number; // 강화권/주문서 가격 (시드)
}

interface EnhanceStepResult {
  attemptIndex: number;
  fromStage: number;
  toStage: number;
  success: boolean;
  penaltyApplied: boolean;
  luckyStonesUsed: number;
  talismansUsed: number;
}

interface EnhanceSimulationSummary {
  success: boolean;
  totalAttempts: number;
  successCount: number;
  failCount: number;
  dropCount: number; // 단계 하락 횟수
  resetCount: number; // 0강 초기화 횟수
  luckyStonesTotal: number;
  talismansTotal: number;
  currencyType: 'seed' | 'elso';
  totalFeeCost: number; // 총 소모 수수료 (시드 또는 엘소)
  totalItemCostSeed: number; // 총 소모 재료비 (시드)
  finalStage: number;
  history: EnhanceStepResult[];
}

interface EnhanceExpectationResult {
  startStage: number;
  targetStage: number;
  expectedAttempts: number;
  expectedDrops: number;
  expectedLuckyStones: number;
  expectedTalismans: number;
  currencyType: 'seed' | 'elso';
  expectedFeeCost: number; // 수수료 기댓값
  expectedItemCostSeed: number; // 재료비 기댓값 (시드)
  stageStats: {
    stage: number;
    successRate: number;
    effectivePenaltyRate: number;
    stepExpectedAttempts: number; // 해당 구간 1단계 돌파 기댓값
    stepFeeCost: number; // 해당 구간 수수료 기댓값
    stepItemCostSeed: number; // 해당 구간 재료비 기댓값 (시드)
    cumulativeAttempts: number; // 시작 단계부터 해당 단계 도달까지의 누적 시도 기댓값
    cumulativeFeeCost: number; // 누적 수수료
    cumulativeItemCostSeed: number; // 누적 재료비 (시드)
    expectedVisits: number; // 목표 전체 과정에서의 해당 단계 방문 횟수
  }[];
}

/** 1회 강화 시도 계산 */
function simulateEnhanceSingleStep(
  currentStage: number,
  options: EnhanceSimulationOptions,
  random: () => number = Math.random
): EnhanceStepResult {
  if (currentStage >= 20) {
    return {
      attemptIndex: 1,
      fromStage: currentStage,
      toStage: currentStage,
      success: true,
      penaltyApplied: false,
      luckyStonesUsed: 0,
      talismansUsed: 0,
    };
  }

  const rateInfo = ENHANCE_RATES[currentStage] || ENHANCE_RATES[ENHANCE_RATES.length - 1];
  let successProb = rateInfo.baseSuccessRate;

  if (options.isNoPenaltyScroll && options.noPenaltyScrollRate !== undefined) {
    successProb = options.noPenaltyScrollRate;
  } else {
    // 행운석 적용 (+1%p per stone, 최대 +5%p)
    const stones = Math.max(0, Math.min(5, options.luckyStoneCount || 0));
    successProb = Math.min(1.0, successProb + stones * 0.01);
  }

  const isSuccess = random() < successProb;
  let nextStage = currentStage;
  let penaltyApplied = false;

  const stonesUsed = options.isNoPenaltyScroll ? 0 : Math.max(0, Math.min(5, options.luckyStoneCount || 0));
  let talismansUsed = 0;

  if (isSuccess) {
    nextStage = currentStage + 1;
  } else {
    if (!options.isNoPenaltyScroll && rateInfo.penaltyType !== 'none') {
      talismansUsed = Math.max(0, Math.min(5, options.talismanCount || 0));
      // 부적 1개당 실패 패널티 발생 확률 10%p 감소 (기본 100% -> 부적 5개 시 50%)
      const penaltyProb = Math.max(0, rateInfo.baseFailPenaltyRate - talismansUsed * 0.1);
      if (random() < penaltyProb) {
        penaltyApplied = true;
        if (rateInfo.penaltyType === 'minus1') nextStage = Math.max(0, currentStage - 1);
        else if (rateInfo.penaltyType === 'minus2') nextStage = Math.max(0, currentStage - 2);
        else if (rateInfo.penaltyType === 'minus3') nextStage = Math.max(0, currentStage - 3);
        else if (rateInfo.penaltyType === 'reset') nextStage = 0;
      }
    }
  }

  return {
    attemptIndex: 1,
    fromStage: currentStage,
    toStage: nextStage,
    success: isSuccess,
    penaltyApplied,
    luckyStonesUsed: stonesUsed,
    talismansUsed,
  };
}

/** 목표 단계까지 연속 시뮬레이션 */
function runEnhanceSimulation(
  options: EnhanceSimulationOptions,
  maxAttempts: number = 20000,
  random: () => number = Math.random
): EnhanceSimulationSummary {
  const start = Math.max(0, Math.min(20, Math.trunc(options.startStage)));
  const target = Math.max(start, Math.min(20, Math.trunc(options.targetStage)));

  let current = start;
  let attempts = 0;
  let successCount = 0;
  let failCount = 0;
  let dropCount = 0;
  let resetCount = 0;
  let luckyStonesTotal = 0;
  let talismansTotal = 0;
  const history: EnhanceStepResult[] = [];

  let totalFeeCost = 0;
  while (current < target && attempts < maxAttempts) {
    attempts += 1;
    const stageBefore = current;
    const step = simulateEnhanceSingleStep(current, options, random);
    step.attemptIndex = attempts;
    luckyStonesTotal += step.luckyStonesUsed;
    talismansTotal += step.talismansUsed;

    const feeForThisStep = (options.costPerStage && options.costPerStage[stageBefore] !== undefined)
      ? options.costPerStage[stageBefore]
      : (options.costPerAttempt || 0);
    totalFeeCost += feeForThisStep;

    if (step.success) {
      successCount += 1;
    } else {
      failCount += 1;
      if (step.penaltyApplied) {
        if (step.toStage === 0 && step.fromStage > 0) resetCount += 1;
        else dropCount += 1;
      }
    }

    current = step.toStage;
    if (history.length < 500) {
      history.push(step);
    }
  }

  const currencyType = options.currencyType || 'seed';
  const itemCostSeed =
    luckyStonesTotal * (options.stonePrice || 0) +
    talismansTotal * (options.talismanPrice || 0) +
    attempts * (options.scrollPrice || 0);

  return {
    success: current >= target,
    totalAttempts: attempts,
    successCount,
    failCount,
    dropCount,
    resetCount,
    luckyStonesTotal,
    talismansTotal,
    currencyType,
    totalFeeCost,
    totalItemCostSeed: itemCostSeed,
    finalStage: current,
    history,
  };
}

/**
 * 마르코프 흡수 연쇄 (Markov Absorbing Chain) 상태 전이 행렬을 이용한 수학적 정밀 기댓값 계산
 */
function calculateEnhanceExpectation(options: EnhanceSimulationOptions): EnhanceExpectationResult {
  const start = Math.max(0, Math.min(20, Math.trunc(options.startStage)));
  const target = Math.max(start, Math.min(20, Math.trunc(options.targetStage)));
  const currencyType = options.currencyType || 'seed';

  if (start >= target) {
    return {
      startStage: start,
      targetStage: target,
      expectedAttempts: 0,
      expectedDrops: 0,
      expectedLuckyStones: 0,
      expectedTalismans: 0,
      currencyType,
      expectedFeeCost: 0,
      expectedItemCostSeed: 0,
      stageStats: [],
    };
  }

  const N = target; // 0부터 target-1 까지 N개의 비흡수 상태
  // Q 매트릭스: N x N
  const Q: number[][] = Array.from({ length: N }, () => Array(N).fill(0));
  const stonesPerStage: number[] = Array(N).fill(0);
  const talismansPerStage: number[] = Array(N).fill(0);
  const dropProbPerStage: number[] = Array(N).fill(0);
  const stageStats: EnhanceExpectationResult['stageStats'] = [];

  for (let s = 0; s < N; s += 1) {
    const rateInfo = ENHANCE_RATES[s] || ENHANCE_RATES[ENHANCE_RATES.length - 1];
    let pSucc = rateInfo.baseSuccessRate;
    if (options.isNoPenaltyScroll && options.noPenaltyScrollRate !== undefined) {
      pSucc = options.noPenaltyScrollRate;
    } else {
      const stones = Math.max(0, Math.min(5, options.luckyStoneCount || 0));
      pSucc = Math.min(1.0, pSucc + stones * 0.01);
      stonesPerStage[s] = stones;
    }

    let effectivePenaltyRate = 0;
    let talismans = 0;
    if (!options.isNoPenaltyScroll && rateInfo.penaltyType !== 'none') {
      talismans = Math.max(0, Math.min(5, options.talismanCount || 0));
      talismansPerStage[s] = talismans;
      effectivePenaltyRate = Math.max(0, rateInfo.baseFailPenaltyRate - talismans * 0.1);
    }

    const pFail = 1.0 - pSucc;
    const pDrop = pFail * effectivePenaltyRate;
    const pStay = pFail * (1.0 - effectivePenaltyRate);

    dropProbPerStage[s] = pDrop;

    // 전이 확률 기록
    // 1) 성공: s -> s + 1 (만약 s+1 == target이면 흡수 상태로 전이되므로 Q에는 안 들어감)
    if (s + 1 < target) {
      Q[s][s + 1] += pSucc;
    }

    // 2) 실패 & 유지: s -> s
    Q[s][s] += pStay;

    // 3) 실패 & 하락/초기화
    if (pDrop > 0) {
      let dest = s;
      if (rateInfo.penaltyType === 'minus1') dest = Math.max(0, s - 1);
      else if (rateInfo.penaltyType === 'minus2') dest = Math.max(0, s - 2);
      else if (rateInfo.penaltyType === 'minus3') dest = Math.max(0, s - 3);
      else if (rateInfo.penaltyType === 'reset') dest = 0;

      if (dest < target) {
        Q[s][dest] += pDrop;
      }
    }

    stageStats.push({
      stage: s,
      successRate: pSucc,
      effectivePenaltyRate,
      stepExpectedAttempts: 0,
      stepFeeCost: 0,
      stepItemCostSeed: 0,
      cumulativeAttempts: 0,
      cumulativeFeeCost: 0,
      cumulativeItemCostSeed: 0,
      expectedVisits: 0,
    });
  }

  // M = I - Q
  const M: number[][] = Array.from({ length: N }, (_, r) =>
    Array.from({ length: N }, (_, c) => (r === c ? 1.0 - Q[r][c] : -Q[r][c]))
  );

  // M의 역행렬 N_fund = (I - Q)^(-1) 구하기 (가우스-조던 소거법)
  const inv = invertMatrix(M);
  if (!inv) {
    return {
      startStage: start,
      targetStage: target,
      expectedAttempts: 0,
      expectedDrops: 0,
      expectedLuckyStones: 0,
      expectedTalismans: 0,
      currencyType,
      expectedFeeCost: 0,
      expectedItemCostSeed: 0,
      stageStats,
    };
  }

  // 서브 계산 헬퍼: fromStage -> toStage 도달 기댓값
  function solveMarkov(subStart: number, subTarget: number) {
    const subN = subTarget;
    const subQ: number[][] = Array.from({ length: subN }, () => Array(subN).fill(0));
    const subStones: number[] = Array(subN).fill(0);
    const subTalismans: number[] = Array(subN).fill(0);

    for (let st = 0; st < subN; st += 1) {
      const rate = ENHANCE_RATES[st] || ENHANCE_RATES[ENHANCE_RATES.length - 1];
      let pSucc = rate.baseSuccessRate;
      if (options.isNoPenaltyScroll && options.noPenaltyScrollRate !== undefined) {
        pSucc = options.noPenaltyScrollRate;
      } else {
        const stones = Math.max(0, Math.min(5, options.luckyStoneCount || 0));
        pSucc = Math.min(1.0, pSucc + stones * 0.01);
        subStones[st] = stones;
      }

      let penaltyRate = 0;
      let talismans = 0;
      if (!options.isNoPenaltyScroll && rate.penaltyType !== 'none') {
        talismans = Math.max(0, Math.min(5, options.talismanCount || 0));
        subTalismans[st] = talismans;
        penaltyRate = Math.max(0, rate.baseFailPenaltyRate - talismans * 0.1);
      }

      const pFail = 1.0 - pSucc;
      const pDrop = pFail * penaltyRate;
      const pStay = pFail * (1.0 - penaltyRate);

      if (st + 1 < subTarget) subQ[st][st + 1] += pSucc;
      subQ[st][st] += pStay;

      if (pDrop > 0) {
        let dest = st;
        if (rate.penaltyType === 'minus1') dest = Math.max(0, st - 1);
        else if (rate.penaltyType === 'minus2') dest = Math.max(0, st - 2);
        else if (rate.penaltyType === 'minus3') dest = Math.max(0, st - 3);
        else if (rate.penaltyType === 'reset') dest = 0;

        if (dest < subTarget) subQ[st][dest] += pDrop;
      }
    }

    const subM: number[][] = Array.from({ length: subN }, (_, r) =>
      Array.from({ length: subN }, (_, c) => (r === c ? 1.0 - subQ[r][c] : -subQ[r][c]))
    );

    const subInv = invertMatrix(subM);
    if (!subInv) return { attempts: 0, stones: 0, talismans: 0, feeCost: 0 };

    function getStageFee(st: number): number {
      return (options.costPerStage && options.costPerStage[st] !== undefined)
        ? options.costPerStage[st]
        : (options.costPerAttempt || 0);
    }

    let att = 0;
    let stn = 0;
    let tlm = 0;
    let fee = 0;
    for (let st = 0; st < subN; st += 1) {
      const v = subInv[subStart][st];
      att += v;
      stn += v * subStones[st];
      tlm += v * subTalismans[st];
      fee += v * getStageFee(st);
    }

    return { attempts: att, stones: stn, talismans: tlm, feeCost: fee };
  }

  function getGlobalStageFee(st: number): number {
    return (options.costPerStage && options.costPerStage[st] !== undefined)
      ? options.costPerStage[st]
      : (options.costPerAttempt || 0);
  }

  let expectedAttempts = 0;
  let expectedDrops = 0;
  let expectedLuckyStones = 0;
  let expectedTalismans = 0;
  let expectedFeeCost = 0;

  for (let s = 0; s < N; s += 1) {
    const visits = inv[start][s];
    if (stageStats[s]) {
      stageStats[s].expectedVisits = visits;

      // 1) s -> s+1 구간 단독 1단계 돌파 기댓값
      const stepRes = solveMarkov(s, s + 1);
      stageStats[s].stepExpectedAttempts = stepRes.attempts;
      stageStats[s].stepFeeCost = stepRes.feeCost;
      stageStats[s].stepItemCostSeed =
        stepRes.stones * (options.stonePrice || 0) +
        stepRes.talismans * (options.talismanPrice || 0) +
        stepRes.attempts * (options.scrollPrice || 0);

      // 2) start -> s+1 누적 기댓값
      const cumRes = solveMarkov(start, s + 1);
      stageStats[s].cumulativeAttempts = cumRes.attempts;
      stageStats[s].cumulativeFeeCost = cumRes.feeCost;
      stageStats[s].cumulativeItemCostSeed =
        cumRes.stones * (options.stonePrice || 0) +
        cumRes.talismans * (options.talismanPrice || 0) +
        cumRes.attempts * (options.scrollPrice || 0);
    }
    expectedAttempts += visits;
    expectedDrops += visits * dropProbPerStage[s];
    expectedLuckyStones += visits * stonesPerStage[s];
    expectedTalismans += visits * talismansPerStage[s];
    expectedFeeCost += visits * getGlobalStageFee(s);
  }

  const expectedItemCostSeed =
    expectedLuckyStones * (options.stonePrice || 0) +
    expectedTalismans * (options.talismanPrice || 0) +
    expectedAttempts * (options.scrollPrice || 0);

  return {
    startStage: start,
    targetStage: target,
    expectedAttempts,
    expectedDrops,
    expectedLuckyStones,
    expectedTalismans,
    currencyType,
    expectedFeeCost,
    expectedItemCostSeed,
    stageStats,
  };
}

// ==========================================
// 2. 인챈트 (Enchant)
// ==========================================

type EnchantStatType =
  | 'stab' // 찌르기 (4~6)
  | 'hack' // 베기 (4~6)
  | 'def' // 물리 방어력 (4~6)
  | 'mr' // 마법 방어력 (4~6)
  | 'int' // 마법 공격력 (4~6)
  | 'hit' // 명중률 보정 (2~3)
  | 'crit' // 크리티컬 (2~3)
  | 'eva' // 회피율 보정 (2~3)
  | 'agi'; // 민첩성 보정 (2~3)

/** 인챈트 강화 주문서(0~5장)에 따른 스탯 상승폭 확률 테이블 */
const ENCHANT_ENHANCE_SCROLL_TABLE = Object.freeze({
  // 공격/방어 계열 (4, 5, 6)
  primary: [
    { scrolls: 0, p4: 0.7, p5: 0.2, p6: 0.1 },
    { scrolls: 1, p4: 0.5, p5: 0.3, p6: 0.2 },
    { scrolls: 2, p4: 0.3, p5: 0.4, p6: 0.3 },
    { scrolls: 3, p4: 0.1, p5: 0.5, p6: 0.4 },
    { scrolls: 4, p4: 0.0, p5: 0.5, p6: 0.5 },
    { scrolls: 5, p4: 0.0, p5: 0.4, p6: 0.6 },
  ],
  // 명중/크리/회피/민첩 계열 (2, 3)
  secondary: [
    { scrolls: 0, p2: 0.8, p3: 0.2 },
    { scrolls: 1, p2: 0.65, p3: 0.35 },
    { scrolls: 2, p2: 0.5, p3: 0.5 },
    { scrolls: 3, p2: 0.35, p3: 0.65 },
    { scrolls: 4, p2: 0.2, p3: 0.8 },
    { scrolls: 5, p2: 0.05, p3: 0.95 },
  ],
});

/** 공식 문서 Table 9의 고정 수치 및 특수 인챈트 주문서 프리셋 목록 */
interface FixedEnchantScrollPreset {
  id: string;
  name: string;
  category: 'primary' | 'secondary';
  statGain: number;
  successRate: number; // 0.02 또는 0.3
  blessingGain: number; // 0.02, 0.01 또는 0.0 (축복치 없음)
}

const FIXED_ENCHANT_SCROLL_PRESETS: readonly FixedEnchantScrollPreset[] = Object.freeze([
  { id: 'custom_var', name: '일반 인챈트 (강화 주문서 사용: 4~6 또는 2~3)', category: 'primary', statGain: 0, successRate: 0.02, blessingGain: 0.02 },
  // 주요 스탯 고정형
  { id: 'p_4', name: '[+4] 인챈트 주문서 (성공률 2%, 축복치 +2%p)', category: 'primary', statGain: 4, successRate: 0.02, blessingGain: 0.02 },
  { id: 'p_5', name: '[+5] 인챈트 주문서 (성공률 2%, 축복치 +2%p)', category: 'primary', statGain: 5, successRate: 0.02, blessingGain: 0.02 },
  { id: 'p_6', name: '[+6] 인챈트 주문서 (성공률 2%, 축복치 +2%p)', category: 'primary', statGain: 6, successRate: 0.02, blessingGain: 0.02 },
  { id: 'p_6_30', name: '[+6] 인챈트 주문서 (성공률 30%, 축복치 +2%p)', category: 'primary', statGain: 6, successRate: 0.30, blessingGain: 0.02 },
  { id: 'p_7', name: '[+7] 인챈트 주문서 (성공률 2%, 축복치 +2%p)', category: 'primary', statGain: 7, successRate: 0.02, blessingGain: 0.02 },
  { id: 'p_8_nobless', name: '[+8] 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'primary', statGain: 8, successRate: 0.02, blessingGain: 0.0 },
  { id: 'p_9_nobless', name: '[+9] 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'primary', statGain: 9, successRate: 0.02, blessingGain: 0.0 },
  { id: 'p_10_nobless', name: '[+10] 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'primary', statGain: 10, successRate: 0.02, blessingGain: 0.0 },
  { id: 'p_12_nobless', name: '[+12] 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'primary', statGain: 12, successRate: 0.02, blessingGain: 0.0 },
  { id: 'p_14_nobless', name: '[+14] 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'primary', statGain: 14, successRate: 0.02, blessingGain: 0.0 },
  { id: 'p_15_nobless', name: '[+15] 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'primary', statGain: 15, successRate: 0.02, blessingGain: 0.0 },
  { id: 'p_16_nobless', name: '[+16] 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'primary', statGain: 16, successRate: 0.02, blessingGain: 0.0 },
  // 보조 스탯 고정형
  { id: 's_2', name: '[+2] 보조 인챈트 주문서 (성공률 2%, 축복치 +1%p)', category: 'secondary', statGain: 2, successRate: 0.02, blessingGain: 0.01 },
  { id: 's_3', name: '[+3] 보조 인챈트 주문서 (성공률 2%, 축복치 +1%p)', category: 'secondary', statGain: 3, successRate: 0.02, blessingGain: 0.01 },
  { id: 's_4', name: '[+4] 보조 인챈트 주문서 (성공률 2%, 축복치 +1%p)', category: 'secondary', statGain: 4, successRate: 0.02, blessingGain: 0.01 },
  { id: 's_5', name: '[+5] 보조 인챈트 주문서 (성공률 2%, 축복치 +1%p)', category: 'secondary', statGain: 5, successRate: 0.02, blessingGain: 0.01 },
  { id: 's_6', name: '[+6] 보조 인챈트 주문서 (성공률 2%, 축복치 +1%p)', category: 'secondary', statGain: 6, successRate: 0.02, blessingGain: 0.01 },
  { id: 's_7', name: '[+7] 보조 인챈트 주문서 (성공률 2%, 축복치 +1%p)', category: 'secondary', statGain: 7, successRate: 0.02, blessingGain: 0.01 },
  { id: 's_10_nobless', name: '[+10] 보조 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'secondary', statGain: 10, successRate: 0.02, blessingGain: 0.0 },
  { id: 's_12_nobless', name: '[+12] 보조 인챈트 주문서 (성공률 2%, 축복치 없음)', category: 'secondary', statGain: 12, successRate: 0.02, blessingGain: 0.0 },
]);

interface EnchantSimulationOptions {
  statType: EnchantStatType;
  presetId?: string; // FIXED_ENCHANT_SCROLL_PRESETS 아이디
  fixedStatGain?: number; // 고정 상승치 (설정 시 주사위 굴리지 않고 이 값 적용)
  enhanceScrollCount: number; // 0 ~ 5 (인챈트 강화 주문서)
  baseSuccessRate?: number; // 기본 성공 확률 (기본 0.02 = 2%)
  blessingGainOnFail?: number; // 실패 시 축복치 증가량 (기본: 주요스탯 0.02, 보조스탯 0.01, 축복치없음 0.0)
  initialBlessing?: number; // 현재 축복치 (0 ~ 1.0)
  targetStatValue?: number; // 목표 총 누적 스탯 (선택)
  targetMaxAttempts?: number; // 최대 시도 횟수
  currencyType?: 'seed' | 'elso'; // 수수료 지불 재화
  costPerAttempt?: number; // 1회 시도 수수료 (시드 또는 엘소)
  scrollPrice?: number; // 인챈트 주문서 가격 (시드)
  enhanceScrollPrice?: number; // 인챈트 강화 주문서 가격 (시드)
}

interface EnchantStepResult {
  attemptIndex: number;
  currentBlessingBefore: number;
  successRate: number;
  success: boolean;
  statGained: number;
  currentBlessingAfter: number;
}

interface EnchantSimulationSummary {
  totalAttempts: number;
  successCount: number;
  failCount: number;
  totalStatGained: number;
  enhanceScrollsUsed: number;
  currencyType: 'seed' | 'elso';
  totalFeeCost: number; // 총 수수료 (시드 또는 엘소)
  totalItemCostSeed: number; // 총 주문서 비용 (시드)
  finalBlessing: number;
  history: EnchantStepResult[];
}

interface EnchantExpectationResult {
  statType: EnchantStatType;
  enhanceScrollCount: number;
  expectedAttemptsPerSuccess: number; // 1회 성공까지 평균 시도 횟수
  expectedStatGainPerSuccess: number; // 1회 성공 시 평균 스탯 상승량
  statDistribution: { value: number; probability: number }[];
  expectedScrollsPerSuccess: number;
  expectedEnhanceScrollsPerSuccess: number;
  currencyType: 'seed' | 'elso';
  expectedFeeCostPerSuccess: number;
  expectedItemCostSeedPerSuccess: number;
}

function isPrimaryStat(type: EnchantStatType): boolean {
  return ['stab', 'hack', 'def', 'mr', 'int'].includes(type);
}

/** 인챈트 1회 성공할 때 스탯 상승치 샘플링 */
function rollStatGain(options: EnchantSimulationOptions, random: () => number = Math.random): number {
  if (options.fixedStatGain && options.fixedStatGain > 0) {
    return options.fixedStatGain;
  }
  const scrolls = Math.max(0, Math.min(5, Math.trunc(options.enhanceScrollCount)));
  const isPrim = isPrimaryStat(options.statType);

  if (isPrim) {
    const table = ENCHANT_ENHANCE_SCROLL_TABLE.primary[scrolls];
    const r = random();
    if (r < table.p4) return 4;
    if (r < table.p4 + table.p5) return 5;
    return 6;
  } else {
    const table = ENCHANT_ENHANCE_SCROLL_TABLE.secondary[scrolls];
    const r = random();
    if (r < table.p2) return 2;
    return 3;
  }
}

/** 인챈트 1회 시도 시뮬레이션 */
function simulateEnchantSingleStep(
  currentBlessing: number,
  options: EnchantSimulationOptions,
  random: () => number = Math.random
): EnchantStepResult {
  const isPrim = isPrimaryStat(options.statType);
  const baseRate = options.baseSuccessRate !== undefined ? options.baseSuccessRate : 0.02;
  const blessingGain = options.blessingGainOnFail !== undefined ? options.blessingGainOnFail : (isPrim ? 0.02 : 0.01);

  const effectiveRate = Math.min(1.0, baseRate + currentBlessing);
  const isSuccess = random() < effectiveRate;

  let statGained = 0;
  let nextBlessing = currentBlessing;

  if (isSuccess) {
    statGained = rollStatGain(options, random);
    nextBlessing = 0.0; // 성공 시 축복치 리셋
  } else {
    nextBlessing = Math.min(1.0, currentBlessing + blessingGain);
  }

  return {
    attemptIndex: 1,
    currentBlessingBefore: currentBlessing,
    successRate: effectiveRate,
    success: isSuccess,
    statGained,
    currentBlessingAfter: nextBlessing,
  };
}

/** 인챈트 연속 시뮬레이션 (목표 성공 횟수 또는 최대 횟수까지) */
function runEnchantSimulation(
  options: EnchantSimulationOptions,
  targetSuccesses: number = 1,
  random: () => number = Math.random
): EnchantSimulationSummary {
  let blessing = Math.max(0, Math.min(1.0, options.initialBlessing || 0));
  let attempts = 0;
  let successes = 0;
  let fails = 0;
  let totalStat = 0;
  const maxAttempts = options.targetMaxAttempts || 20000;
  const history: EnchantStepResult[] = [];

  while (successes < targetSuccesses && attempts < maxAttempts) {
    attempts += 1;
    const step = simulateEnchantSingleStep(blessing, options, random);
    step.attemptIndex = attempts;
    blessing = step.currentBlessingAfter;

    if (step.success) {
      successes += 1;
      totalStat += step.statGained;
    } else {
      fails += 1;
    }

    if (history.length < 500) {
      history.push(step);
    }
  }

  const currencyType = options.currencyType || 'seed';
  const isFixedScroll = Boolean(options.fixedStatGain && options.fixedStatGain > 0);
  const enhanceScrollsUsed = isFixedScroll ? 0 : attempts * Math.max(0, Math.min(5, options.enhanceScrollCount));
  const totalFeeCost = attempts * (options.costPerAttempt || 0);
  const totalItemCostSeed =
    attempts * (options.scrollPrice || 0) +
    enhanceScrollsUsed * (options.enhanceScrollPrice || 0);

  return {
    totalAttempts: attempts,
    successCount: successes,
    failCount: fails,
    totalStatGained: totalStat,
    enhanceScrollsUsed,
    currencyType,
    totalFeeCost,
    totalItemCostSeed,
    finalBlessing: blessing,
    history,
  };
}

/** 인챈트 기댓값 정밀 계산 (축복치 누적 모델 해석적 계산) */
function calculateEnchantExpectation(options: EnchantSimulationOptions): EnchantExpectationResult {
  const isPrim = isPrimaryStat(options.statType);
  const baseRate = options.baseSuccessRate !== undefined ? options.baseSuccessRate : 0.02;
  const blessingGain = options.blessingGainOnFail !== undefined ? options.blessingGainOnFail : (isPrim ? 0.02 : 0.01);
  const isFixedScroll = Boolean(options.fixedStatGain && options.fixedStatGain > 0);
  const scrolls = isFixedScroll ? 0 : Math.max(0, Math.min(5, options.enhanceScrollCount));
  const currencyType = options.currencyType || 'seed';

  let expectedAttemptsPerSuccess = 0;

  if (blessingGain <= 0) {
    // 축복치 없는 독립 시행 기하분포 기댓값 E = 1 / p
    expectedAttemptsPerSuccess = baseRate > 0 ? 1.0 / baseRate : 0;
  } else {
    let probFailAccum = 1.0;
    const maxK = Math.ceil((1.0 - baseRate) / blessingGain) + 1;

    for (let k = 1; k <= maxK + 10; k += 1) {
      const blessing = (k - 1) * blessingGain;
      const succProb = Math.min(1.0, baseRate + blessing);
      const probSuccessAtK = probFailAccum * succProb;
      expectedAttemptsPerSuccess += k * probSuccessAtK;
      probFailAccum *= (1.0 - succProb);
      if (succProb >= 1.0 || probFailAccum <= 1e-12) break;
    }
  }

  let expectedStatGain = 0;
  const statDistribution: { value: number; probability: number }[] = [];

  if (isFixedScroll) {
    expectedStatGain = options.fixedStatGain || 0;
    statDistribution.push({ value: expectedStatGain, probability: 1.0 });
  } else if (isPrim) {
    const table = ENCHANT_ENHANCE_SCROLL_TABLE.primary[scrolls];
    expectedStatGain = 4 * table.p4 + 5 * table.p5 + 6 * table.p6;
    if (table.p4 > 0) statDistribution.push({ value: 4, probability: table.p4 });
    if (table.p5 > 0) statDistribution.push({ value: 5, probability: table.p5 });
    if (table.p6 > 0) statDistribution.push({ value: 6, probability: table.p6 });
  } else {
    const table = ENCHANT_ENHANCE_SCROLL_TABLE.secondary[scrolls];
    expectedStatGain = 2 * table.p2 + 3 * table.p3;
    statDistribution.push({ value: 2, probability: table.p2 });
    statDistribution.push({ value: 3, probability: table.p3 });
  }

  const expectedScrolls = expectedAttemptsPerSuccess;
  const expectedEnhanceScrolls = isFixedScroll ? 0 : expectedAttemptsPerSuccess * scrolls;
  const expectedFeeCostPerSuccess = expectedAttemptsPerSuccess * (options.costPerAttempt || 0);
  const expectedItemCostSeedPerSuccess =
    expectedScrolls * (options.scrollPrice || 0) +
    expectedEnhanceScrolls * (options.enhanceScrollPrice || 0);

  return {
    statType: options.statType,
    enhanceScrollCount: scrolls,
    expectedAttemptsPerSuccess,
    expectedStatGainPerSuccess: expectedStatGain,
    statDistribution,
    expectedScrollsPerSuccess: expectedScrolls,
    expectedEnhanceScrollsPerSuccess: expectedEnhanceScrolls,
    currencyType,
    expectedFeeCostPerSuccess,
    expectedItemCostSeedPerSuccess,
  };
}

// ==========================================
// 3. 인크립트 (Incrypt)
// ==========================================

type IncryptScrollType =
  | 'lord' // 로드 인크립트 (21% 성공, 79% 파괴, 장파보 0~60)
  | 'guardian' // 가호의 인크립트 (26% 성공, 74% 파괴, 장파보 0~50)
  | 'blessed' // 축복받은 인크립트 (31% 성공, 69% 파괴, 장파보 0~40)
  | 'royal' // 왕실 인크립트 (36% 성공, 64% 파괴, 장파보 0~30)
  | 'vianu' // 비아누의 인크립트 (0.07% ~ 0.01%, 노패널티)
  | 'eta' // 에타 인크립트 (1% 성공, 노패널티)
  | 'nopenalty_1pct' // 1% 노패널티 인크립트 스크롤
  | 'nopenalty_001pct'; // 0.01% 노패널티 인크립트 스크롤

interface IncryptScrollInfo {
  id: IncryptScrollType;
  name: string;
  successRate: number; // 0 ~ 1
  failRate: number;
  baseDestroyRate: number; // 실패 시 파괴 확률 (0 ~ 1)
  maxProtectionScrolls: number; // 등록 가능한 장비 파괴 보호 주문서(장파보) 최대 개수
}

const INCRYPT_SCROLLS: Record<IncryptScrollType, IncryptScrollInfo> = Object.freeze({
  lord: { id: 'lord', name: '로드 인크립트', successRate: 0.21, failRate: 0.79, baseDestroyRate: 1.0, maxProtectionScrolls: 60 },
  guardian: { id: 'guardian', name: '가호의 인크립트', successRate: 0.26, failRate: 0.74, baseDestroyRate: 1.0, maxProtectionScrolls: 50 },
  blessed: { id: 'blessed', name: '축복받은 인크립트', successRate: 0.31, failRate: 0.69, baseDestroyRate: 1.0, maxProtectionScrolls: 40 },
  royal: { id: 'royal', name: '왕실 인크립트', successRate: 0.36, failRate: 0.64, baseDestroyRate: 1.0, maxProtectionScrolls: 30 },
  vianu: { id: 'vianu', name: '비아누의 인크립트', successRate: 0.0007, failRate: 0.9993, baseDestroyRate: 0.0, maxProtectionScrolls: 0 },
  eta: { id: 'eta', name: '에타 인크립트', successRate: 0.01, failRate: 0.99, baseDestroyRate: 0.0, maxProtectionScrolls: 0 },
  nopenalty_1pct: { id: 'nopenalty_1pct', name: '1% 노패널티 인크립트 스크롤', successRate: 0.01, failRate: 0.99, baseDestroyRate: 0.0, maxProtectionScrolls: 0 },
  nopenalty_001pct: { id: 'nopenalty_001pct', name: '0.01% 노패널티 인크립트 스크롤', successRate: 0.0001, failRate: 0.9999, baseDestroyRate: 0.0, maxProtectionScrolls: 0 },
});

const VIANU_RATES_BY_COUNT: readonly number[] = Object.freeze([
  0.0007, // 0회
  0.00065, // 1회
  0.0006, // 2회
  0.00055, // 3회
  0.0005, // 4회
  0.00045, // 5회
  0.0004, // 6회
  0.00035, // 7회
  0.0003, // 8회
  0.00025, // 9회
  0.0002, // 10회
  0.00015, // 11회
  0.0001, // 12회 이상
]);

interface IncryptSimulationOptions {
  scrollType: IncryptScrollType;
  protectionScrollCount: number; // 장비 파괴 보호 주문서 (장파보) 개수
  currentIncryptCount?: number; // 현재 인크립트 성공 횟수 (비아누 확률용)
  currencyType?: 'seed' | 'elso'; // 수수료 지불 재화
  costPerAttempt?: number; // 1회 시도시 소모 수수료 (시드 또는 엘소)
  scrollPrice?: number; // 인크립트 스크롤 가격 (시드)
  protectionScrollPrice?: number; // 장파보 1장 가격 (시드)
  equipmentPrice?: number; // 장비 본체 가격 (파괴 시 손실액, 시드)
}

interface IncryptStepResult {
  attemptIndex: number;
  outcome: 'success' | 'fail_survived' | 'fail_destroyed';
  protectionScrollsUsed: number;
}

interface IncryptSimulationSummary {
  totalAttempts: number;
  successCount: number;
  failSurvivedCount: number;
  failDestroyedCount: number;
  protectionScrollsTotal: number;
  currencyType: 'seed' | 'elso';
  totalFeeCost: number; // 총 수수료 (시드 또는 엘소)
  totalItemCostSeed: number; // 총 주문서/장파보 비용 (시드)
  totalEquipmentLossSeed: number; // 총 장비 손실 비용 (시드)
  finalEquipDestroyed: boolean;
  history: IncryptStepResult[];
}

interface IncryptExpectationResult {
  scrollType: IncryptScrollType;
  successRate: number;
  effectiveDestroyRateOnFail: number;
  overallDestroyRatePerAttempt: number;
  overallSurvivalRatePerAttempt: number;
  protectionScrollCount: number;
  expectedAttemptsPerSuccess: number;
  expectedDestroyedEquipsPerSuccess: number; // 1회 성공당 평균 장비 파괴 기댓값
  survivalProbabilityUntilTarget: number; // 장비 1개로 N회 연속 인크립트 성공할 확률
  currencyType: 'seed' | 'elso';
  expectedCostPerSuccess: {
    scrollCount: number;
    protectionScrollCount: number;
    feeCost: number; // 수수료 (시드 또는 엘소)
    itemCostSeed: number; // 재료비 (시드)
    equipLossSeed: number; // 장비 손실액 (시드)
    totalSeedCostWithEquipLoss: number; // 수수료가 시드일 경우 총 시드 (재료+수수료+장비)
  };
}

/** 1회 인크립트 시도 */
function simulateIncryptSingleStep(
  options: IncryptSimulationOptions,
  random: () => number = Math.random
): IncryptStepResult {
  const info = INCRYPT_SCROLLS[options.scrollType] || INCRYPT_SCROLLS.lord;
  let pSucc = info.successRate;

  if (options.scrollType === 'vianu') {
    const cnt = Math.max(0, Math.min(12, Math.trunc(options.currentIncryptCount || 0)));
    pSucc = VIANU_RATES_BY_COUNT[cnt];
  }

  const maxProtects = info.maxProtectionScrolls;
  const protectsUsed = Math.max(0, Math.min(maxProtects, Math.trunc(options.protectionScrollCount || 0)));

  const r = random();
  if (r < pSucc) {
    return {
      attemptIndex: 1,
      outcome: 'success',
      protectionScrollsUsed: protectsUsed,
    };
  }

  // 실패 시 파괴 여부 (장파보 1장당 1%p 감소)
  const destroyProb = Math.max(0, info.baseDestroyRate - protectsUsed * 0.01);
  const rDestroy = random();
  const outcome = rDestroy < destroyProb ? 'fail_destroyed' : 'fail_survived';

  return {
    attemptIndex: 1,
    outcome,
    protectionScrollsUsed: protectsUsed,
  };
}

/** 인크립트 시뮬레이션 (단일 장비로 성공할 때까지 또는 파괴될 때까지, 혹은 장비 파괴 시 새 장비로 계속) */
function runIncryptSimulation(
  options: IncryptSimulationOptions,
  targetSuccesses: number = 1,
  allowEquipReplacement: boolean = true,
  maxAttempts: number = 20000,
  random: () => number = Math.random
): IncryptSimulationSummary {
  let attempts = 0;
  let successes = 0;
  let survivedFails = 0;
  let destroyedFails = 0;
  let protectionTotal = 0;
  let equipDestroyed = false;
  const history: IncryptStepResult[] = [];

  while (successes < targetSuccesses && attempts < maxAttempts) {
    attempts += 1;
    const step = simulateIncryptSingleStep(
      { ...options, currentIncryptCount: successes },
      random
    );
    step.attemptIndex = attempts;
    protectionTotal += step.protectionScrollsUsed;

    if (step.outcome === 'success') {
      successes += 1;
    } else if (step.outcome === 'fail_survived') {
      survivedFails += 1;
    } else {
      destroyedFails += 1;
      if (!allowEquipReplacement) {
        equipDestroyed = true;
        if (history.length < 500) history.push(step);
        break;
      }
    }

    if (history.length < 500) {
      history.push(step);
    }
  }

  const currencyType = options.currencyType || 'seed';
  const totalFeeCost = attempts * (options.costPerAttempt || 0);
  const totalItemCostSeed =
    attempts * (options.scrollPrice || 0) +
    protectionTotal * (options.protectionScrollPrice || 0);
  const totalEquipmentLossSeed = destroyedFails * (options.equipmentPrice || 0);

  return {
    totalAttempts: attempts,
    successCount: successes,
    failSurvivedCount: survivedFails,
    failDestroyedCount: destroyedFails,
    protectionScrollsTotal: protectionTotal,
    currencyType,
    totalFeeCost,
    totalItemCostSeed,
    totalEquipmentLossSeed,
    finalEquipDestroyed: equipDestroyed,
    history,
  };
}

/** 인크립트 기댓값 계산 */
function calculateIncryptExpectation(
  options: IncryptSimulationOptions,
  targetSuccesses: number = 1
): IncryptExpectationResult {
  const info = INCRYPT_SCROLLS[options.scrollType] || INCRYPT_SCROLLS.lord;
  let pSucc = info.successRate;

  if (options.scrollType === 'vianu') {
    const cnt = Math.max(0, Math.min(12, Math.trunc(options.currentIncryptCount || 0)));
    pSucc = VIANU_RATES_BY_COUNT[cnt];
  }

  const protects = Math.max(0, Math.min(info.maxProtectionScrolls, Math.trunc(options.protectionScrollCount || 0)));
  const pFail = 1.0 - pSucc;
  const effectiveDestroyRateOnFail = Math.max(0, info.baseDestroyRate - protects * 0.01);
  const overallDestroyRate = pFail * effectiveDestroyRateOnFail;
  const overallSurvivalRate = 1.0 - overallDestroyRate;

  const expectedAttemptsPerSuccess = 1.0 / pSucc;
  const expectedDestroyedEquips = overallDestroyRate / pSucc;

  const singleSuccessSurviveProb = pSucc + overallDestroyRate > 0 ? pSucc / (pSucc + overallDestroyRate) : 1.0;
  const survivalProbabilityUntilTarget = Math.pow(singleSuccessSurviveProb, targetSuccesses);

  const currencyType = options.currencyType || 'seed';
  const scrollCount = expectedAttemptsPerSuccess * targetSuccesses;
  const totalProtectionCount = scrollCount * protects;
  const feeCost = scrollCount * (options.costPerAttempt || 0);
  const itemCostSeed =
    scrollCount * (options.scrollPrice || 0) +
    totalProtectionCount * (options.protectionScrollPrice || 0);
  const equipLossSeed = expectedDestroyedEquips * targetSuccesses * (options.equipmentPrice || 0);
  const totalSeedCostWithEquipLoss =
    itemCostSeed + (currencyType === 'seed' ? feeCost : 0) + equipLossSeed;

  return {
    scrollType: options.scrollType,
    successRate: pSucc,
    effectiveDestroyRateOnFail,
    overallDestroyRatePerAttempt: overallDestroyRate,
    overallSurvivalRatePerAttempt: overallSurvivalRate,
    protectionScrollCount: protects,
    expectedAttemptsPerSuccess,
    expectedDestroyedEquipsPerSuccess: expectedDestroyedEquips,
    survivalProbabilityUntilTarget,
    currencyType,
    expectedCostPerSuccess: {
      scrollCount,
      protectionScrollCount: totalProtectionCount,
      feeCost,
      itemCostSeed,
      equipLossSeed,
      totalSeedCostWithEquipLoss,
    },
  };
}

// ==========================================
// 유틸: N x N 행렬 역행렬 (가우스-조던 소거법)
// ==========================================
function invertMatrix(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const A = matrix.map((row) => [...row]);
  const I: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );

  for (let i = 0; i < n; i += 1) {
    let pivot = A[i][i];
    let pivotRow = i;
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(A[r][i]) > Math.abs(pivot)) {
        pivot = A[r][i];
        pivotRow = r;
      }
    }

    if (Math.abs(pivot) < 1e-15) return null; // 특이행렬

    if (pivotRow !== i) {
      [A[i], A[pivotRow]] = [A[pivotRow], A[i]];
      [I[i], I[pivotRow]] = [I[pivotRow], I[i]];
    }

    const denom = A[i][i];
    for (let c = 0; c < n; c += 1) {
      A[i][c] /= denom;
      I[i][c] /= denom;
    }

    for (let r = 0; r < n; r += 1) {
      if (r !== i) {
        const factor = A[r][i];
        for (let c = 0; c < n; c += 1) {
          A[r][c] -= factor * A[i][c];
          I[r][c] -= factor * I[i][c];
        }
      }
    }
  }

  return I;
}

const equipmentSimulator = Object.freeze({
  ENHANCE_RATES,
  ENCHANT_ENHANCE_SCROLL_TABLE,
  FIXED_ENCHANT_SCROLL_PRESETS,
  INCRYPT_SCROLLS,
  VIANU_RATES_BY_COUNT,
  simulateEnhanceSingleStep,
  runEnhanceSimulation,
  calculateEnhanceExpectation,
  rollStatGain,
  simulateEnchantSingleStep,
  runEnchantSimulation,
  calculateEnchantExpectation,
  simulateIncryptSingleStep,
  runIncryptSimulation,
  calculateIncryptExpectation,
});

if (typeof module !== 'undefined' && module.exports) module.exports = equipmentSimulator;
if (typeof window !== 'undefined') (window as any).equipmentSimulator = equipmentSimulator;
