type RelicSide = 'right' | 'left';

interface RelicStage {
  id: string;
  family: 'sinjo' | 'lunaria';
  level: number;
  label: string;
  rightCap: number;
  leftCap: number;
  enhanceMaterial: string;
  enhanceMaterialCount: number;
  enhanceSeedMan: number;
  evolutionMaterial: string | null;
  evolutionMaterialCount: number;
  evolutionSeedMan: number;
}

interface RelicCalculationInput {
  side: RelicSide;
  currentStageIndex: number;
  targetStageIndex: number;
  difficulty: number;
  currentStatTotal: number;
}

interface RelicCostSummary {
  attempts: number;
  successes: number;
  seedMan: number;
  materials: Record<string, number>;
  evolutionMaterials: Record<string, number>;
  evolutions: number;
}

const sinjoCaps = [[25, 20], [50, 45], [55, 50], [60, 60], [65, 65], [70, 70], [75, 75], [80, 80], [90, 90], [100, 100]];
const sinjoPowder = [0, 5, 7, 10, 12, 14, 16, 17, 18, 19];
const sinjoEnhanceSeed = [0, 900, 1500, 1500, 1600, 1650, 1700, 1750, 1800, 1850];
const sinjoEssence = [0, 3, 6, 10, 15, 21, 28, 36, 45, 54];
const sinjoEvolutionSeed = [0, 14000, 16000, 18000, 20000, 22000, 24000, 26000, 28000, 30000];
const lunariaCaps = [110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
const lunariaFragments = [9, 11, 12, 14, 15, 18, 21, 24, 27, 30];
const lunariaEnhanceSeed = [2000, 2200, 2200, 2200, 2200, 2250, 2300, 2350, 2400, 2450];
const lunariaMoonstones = [1, 3, 6, 10, 15, 21, 28, 36, 45, 0];
const lunariaEvolutionSeed = [10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000, 26000, 0];

const RELIC_STAGES: readonly RelicStage[] = Object.freeze([
  ...sinjoCaps.map(([rightCap, leftCap], index) => ({
    id: `sinjo-${index + 1}`, family: 'sinjo' as const, level: index + 1,
    label: `신조의 렐릭 ${index + 1}강`, rightCap, leftCap,
    enhanceMaterial: '응축 가루', enhanceMaterialCount: sinjoPowder[index], enhanceSeedMan: sinjoEnhanceSeed[index],
    evolutionMaterial: index === 9 ? '신조의 정수' : (index === 0 ? null : '신조의 정수'),
    evolutionMaterialCount: sinjoEssence[index], evolutionSeedMan: sinjoEvolutionSeed[index],
  })),
  ...lunariaCaps.map((cap, index) => ({
    id: `lunaria-${index + 1}`, family: 'lunaria' as const, level: index + 1,
    label: `루나리아 렐릭 ${index + 1}강`, rightCap: cap, leftCap: cap,
    enhanceMaterial: '달의 파편', enhanceMaterialCount: lunariaFragments[index], enhanceSeedMan: lunariaEnhanceSeed[index],
    evolutionMaterial: index === 9 ? null : '월광석', evolutionMaterialCount: lunariaMoonstones[index], evolutionSeedMan: lunariaEvolutionSeed[index],
  })),
]);

function getStatCount(side: RelicSide): number { return side === 'right' ? 5 : 4; }
function getStageCap(stageIndex: number, side: RelicSide): number {
  const stage = RELIC_STAGES[stageIndex];
  return side === 'right' ? stage.rightCap : stage.leftCap;
}

/** 공식 표의 20x20 강화 확률 규칙. 반환값은 0~1입니다. */
function getEnhanceProbability(stageIndex: number, difficulty: number): number {
  const safeDifficulty = Math.max(1, Math.min(20, Math.trunc(difficulty)));
  if (stageIndex <= 2 && safeDifficulty <= stageIndex) return 0.1;
  const delta = safeDifficulty - stageIndex;
  if (delta < 0) return 0;
  if (delta === 0) return 0.1;
  if (delta <= 3) return 0.2;
  return Math.min(1, (20 + ((delta - 3) * 2)) / 100);
}

function addCost(target: RelicCostSummary, name: string | null, count: number, evolution = false): void {
  if (!name || count <= 0) return;
  const bucket = evolution ? target.evolutionMaterials : target.materials;
  bucket[name] = (bucket[name] || 0) + count;
}

function validateInput(input: RelicCalculationInput): RelicCalculationInput {
  const currentStageIndex = Math.max(0, Math.min(RELIC_STAGES.length - 1, Math.trunc(input.currentStageIndex)));
  const targetStageIndex = Math.max(currentStageIndex, Math.min(RELIC_STAGES.length - 1, Math.trunc(input.targetStageIndex)));
  const maxCurrentTotal = getStageCap(currentStageIndex, input.side) * getStatCount(input.side);
  return { ...input, currentStageIndex, targetStageIndex, difficulty: Math.max(1, Math.min(20, Math.trunc(input.difficulty))), currentStatTotal: Math.max(0, Math.min(maxCurrentTotal, Math.trunc(input.currentStatTotal))) };
}

function calculateExpectation(rawInput: RelicCalculationInput): RelicCostSummary | null {
  const input = validateInput(rawInput);
  const result: RelicCostSummary = { attempts: 0, successes: 0, seedMan: 0, materials: {}, evolutionMaterials: {}, evolutions: 0 };
  let inheritedTotal = input.currentStatTotal;
  const statCount = getStatCount(input.side);
  for (let index = input.currentStageIndex; index <= input.targetStageIndex; index += 1) {
    const stage = RELIC_STAGES[index];
    const needed = Math.max(0, (getStageCap(index, input.side) * statCount) - inheritedTotal);
    const probability = getEnhanceProbability(index, input.difficulty);
    if (needed > 0 && probability <= 0) return null;
    const attempts = needed / (probability || 1);
    result.successes += needed;
    result.attempts += attempts;
    result.seedMan += attempts * stage.enhanceSeedMan;
    addCost(result, stage.enhanceMaterial, attempts * stage.enhanceMaterialCount);
    inheritedTotal += needed;
    if (index < input.targetStageIndex) {
      result.evolutions += 1;
      result.seedMan += stage.evolutionSeedMan;
      addCost(result, stage.evolutionMaterial, stage.evolutionMaterialCount, true);
    }
  }
  return result;
}

function runSimulation(rawInput: RelicCalculationInput, random: () => number = Math.random): RelicCostSummary | null {
  const input = validateInput(rawInput);
  const result: RelicCostSummary = { attempts: 0, successes: 0, seedMan: 0, materials: {}, evolutionMaterials: {}, evolutions: 0 };
  let inheritedTotal = input.currentStatTotal;
  const statCount = getStatCount(input.side);
  for (let index = input.currentStageIndex; index <= input.targetStageIndex; index += 1) {
    const stage = RELIC_STAGES[index];
    let needed = Math.max(0, (getStageCap(index, input.side) * statCount) - inheritedTotal);
    const probability = getEnhanceProbability(index, input.difficulty);
    if (needed > 0 && probability <= 0) return null;
    while (needed > 0) {
      result.attempts += 1;
      result.seedMan += stage.enhanceSeedMan;
      addCost(result, stage.enhanceMaterial, stage.enhanceMaterialCount);
      if (random() < probability) { needed -= 1; inheritedTotal += 1; result.successes += 1; }
    }
    if (index < input.targetStageIndex) {
      result.evolutions += 1;
      result.seedMan += stage.evolutionSeedMan;
      addCost(result, stage.evolutionMaterial, stage.evolutionMaterialCount, true);
    }
  }
  return result;
}

const relicCalculator = Object.freeze({ RELIC_STAGES, getStatCount, getStageCap, getEnhanceProbability, calculateExpectation, runSimulation });
if (typeof module !== 'undefined' && module.exports) module.exports = relicCalculator;
if (typeof window !== 'undefined') (window as any).relicCalculator = relicCalculator;
