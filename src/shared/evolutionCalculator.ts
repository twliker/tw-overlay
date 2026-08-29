const EVOLUTION_MOON_HERB_FIXED_COST_SEED = 650_000_000;
const EVOLUTION_HISTORY_SCHEMA_VERSION = 1;

type EvolutionEclipseBaseType = 'fake-armament' | 'abyss-equipment';
type EvolutionSealMethod = 'self' | 'proxy';

interface EvolutionMaterialCostInput {
  name: string;
  quantity: number;
  unitPriceMan: number;
  payment: 'seed' | 'elso';
  elsoUnitPrice?: number;
}

interface EvolutionExtraCosts {
  enchantScrollCount: number;
  enchantScrollUnitPriceMan: number;
  enchantAttemptCostMan: number;
  magicReformCostMan: number;
  additionalOptionCostMan: number;
}

interface EvolutionEclipseOptions {
  enabled: boolean;
  baseType: EvolutionEclipseBaseType;
  baseEquipmentCostMan: number;
  sealMethod: EvolutionSealMethod;
  proxyFeeMan: number;
  moonMineralCostMan: number;
  runeStoneCostMan: number;
}

interface EvolutionCostCalculationInput {
  materials: EvolutionMaterialCostInput[];
  extras: EvolutionExtraCosts;
  eclipse: EvolutionEclipseOptions;
}

interface EvolutionCostResult {
  materialSeed: number;
  enchantScrollSeed: number;
  otherEnhancementSeed: number;
  eclipseBaseSeed: number;
  eclipseSealSeed: number;
  totalSeed: number;
  totalElso: number;
}

interface EvolutionHistorySelection {
  category: 'weapon' | 'equipment';
  part: string;
  fromIndex: number;
  toIndex: number;
  fromLabel: string;
  toLabel: string;
  preferredItemName: string;
}

interface EvolutionHistoryRecord {
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  selection: EvolutionHistorySelection;
  materials: EvolutionMaterialCostInput[];
  extras: EvolutionExtraCosts;
  eclipse: EvolutionEclipseOptions;
  result: EvolutionCostResult;
}

const DEFAULT_EVOLUTION_EXTRA_COSTS: Readonly<EvolutionExtraCosts> = Object.freeze({
  enchantScrollCount: 0,
  enchantScrollUnitPriceMan: 0,
  enchantAttemptCostMan: 0,
  magicReformCostMan: 0,
  additionalOptionCostMan: 0,
});

const DEFAULT_EVOLUTION_ECLIPSE_OPTIONS: Readonly<EvolutionEclipseOptions> = Object.freeze({
  enabled: false,
  baseType: 'fake-armament',
  baseEquipmentCostMan: 0,
  sealMethod: 'self',
  proxyFeeMan: 0,
  moonMineralCostMan: 0,
  runeStoneCostMan: 0,
});

function safeEvolutionNumber(value: unknown, integer = false): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const safe = Math.min(parsed, Number.MAX_SAFE_INTEGER);
  return integer ? Math.floor(safe) : safe;
}

function evolutionManToSeed(value: unknown): number {
  return Math.round(safeEvolutionNumber(value) * 10_000);
}

function sanitizeEvolutionExtraCosts(value: unknown): EvolutionExtraCosts {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    enchantScrollCount: safeEvolutionNumber(source.enchantScrollCount, true),
    enchantScrollUnitPriceMan: safeEvolutionNumber(source.enchantScrollUnitPriceMan),
    enchantAttemptCostMan: safeEvolutionNumber(source.enchantAttemptCostMan),
    magicReformCostMan: safeEvolutionNumber(source.magicReformCostMan),
    additionalOptionCostMan: safeEvolutionNumber(source.additionalOptionCostMan),
  };
}

function sanitizeEvolutionEclipseOptions(value: unknown): EvolutionEclipseOptions {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    enabled: source.enabled === true,
    baseType: source.baseType === 'abyss-equipment' ? 'abyss-equipment' : 'fake-armament',
    baseEquipmentCostMan: safeEvolutionNumber(source.baseEquipmentCostMan),
    sealMethod: source.sealMethod === 'proxy' ? 'proxy' : 'self',
    proxyFeeMan: safeEvolutionNumber(source.proxyFeeMan),
    moonMineralCostMan: safeEvolutionNumber(source.moonMineralCostMan),
    runeStoneCostMan: safeEvolutionNumber(source.runeStoneCostMan),
  };
}

function sanitizeEvolutionMaterialInputs(value: unknown): EvolutionMaterialCostInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const name = typeof source.name === 'string' ? source.name.trim().slice(0, 120) : '';
    if (!name) return [];
    return [{
      name,
      quantity: safeEvolutionNumber(source.quantity, true),
      unitPriceMan: safeEvolutionNumber(source.unitPriceMan),
      payment: source.payment === 'elso' ? 'elso' as const : 'seed' as const,
      elsoUnitPrice: safeEvolutionNumber(source.elsoUnitPrice),
    }];
  });
}

/**
 * 일반 재료, 장비 후처리, 이클립스 전용 선택 비용을 서로 분리해 합산한다.
 * 이클립스 인장은 직접 제작과 대리 제작 중 하나만 비용에 포함하여 중복 계산하지 않는다.
 */
function calculateEvolutionCost(input: EvolutionCostCalculationInput): EvolutionCostResult {
  const materials = sanitizeEvolutionMaterialInputs(input?.materials);
  const extras = sanitizeEvolutionExtraCosts(input?.extras);
  const eclipse = sanitizeEvolutionEclipseOptions(input?.eclipse);
  let materialSeed = 0;
  let totalElso = 0;
  for (const material of materials) {
    if (material.payment === 'elso') {
      totalElso += Math.round(material.quantity * safeEvolutionNumber(material.elsoUnitPrice));
    } else {
      materialSeed += Math.round(material.quantity * evolutionManToSeed(material.unitPriceMan));
    }
  }

  const enchantScrollSeed = Math.round(
    extras.enchantScrollCount * evolutionManToSeed(extras.enchantScrollUnitPriceMan),
  );
  const otherEnhancementSeed = evolutionManToSeed(extras.enchantAttemptCostMan)
    + evolutionManToSeed(extras.magicReformCostMan)
    + evolutionManToSeed(extras.additionalOptionCostMan);

  const eclipseBaseSeed = eclipse.enabled ? evolutionManToSeed(eclipse.baseEquipmentCostMan) : 0;
  let eclipseSealSeed = 0;
  if (eclipse.enabled) {
    eclipseSealSeed = eclipse.sealMethod === 'proxy'
      ? evolutionManToSeed(eclipse.proxyFeeMan)
      : evolutionManToSeed(eclipse.moonMineralCostMan)
        + evolutionManToSeed(eclipse.runeStoneCostMan)
        + EVOLUTION_MOON_HERB_FIXED_COST_SEED;
  }

  return {
    materialSeed,
    enchantScrollSeed,
    otherEnhancementSeed,
    eclipseBaseSeed,
    eclipseSealSeed,
    totalSeed: materialSeed + enchantScrollSeed + otherEnhancementSeed + eclipseBaseSeed + eclipseSealSeed,
    totalElso,
  };
}

function sanitizeEvolutionCostResult(value: unknown): EvolutionCostResult {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    materialSeed: safeEvolutionNumber(source.materialSeed, true),
    enchantScrollSeed: safeEvolutionNumber(source.enchantScrollSeed, true),
    otherEnhancementSeed: safeEvolutionNumber(source.otherEnhancementSeed, true),
    eclipseBaseSeed: safeEvolutionNumber(source.eclipseBaseSeed, true),
    eclipseSealSeed: safeEvolutionNumber(source.eclipseSealSeed, true),
    totalSeed: safeEvolutionNumber(source.totalSeed, true),
    totalElso: safeEvolutionNumber(source.totalElso, true),
  };
}

function sanitizeEvolutionHistory(value: unknown): EvolutionHistoryRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const selectionSource = source.selection && typeof source.selection === 'object' && !Array.isArray(source.selection)
      ? source.selection as Record<string, unknown>
      : {};
    const id = typeof source.id === 'string' ? source.id.slice(0, 100) : '';
    const fromLabel = typeof selectionSource.fromLabel === 'string' ? selectionSource.fromLabel.slice(0, 50) : '';
    const toLabel = typeof selectionSource.toLabel === 'string' ? selectionSource.toLabel.slice(0, 50) : '';
    if (!id || !fromLabel || !toLabel) return [];
    const createdAt = safeEvolutionNumber(source.createdAt, true) || Date.now();
    const updatedAt = safeEvolutionNumber(source.updatedAt, true) || createdAt;
    const title = typeof source.title === 'string' && source.title.trim()
      ? source.title.trim().slice(0, 80)
      : `${fromLabel} → ${toLabel}`;
    return [{
      schemaVersion: EVOLUTION_HISTORY_SCHEMA_VERSION,
      id,
      title,
      createdAt,
      updatedAt,
      selection: {
        category: selectionSource.category === 'equipment' ? 'equipment' : 'weapon',
        part: typeof selectionSource.part === 'string' ? selectionSource.part.slice(0, 30) : '',
        fromIndex: safeEvolutionNumber(selectionSource.fromIndex, true),
        toIndex: safeEvolutionNumber(selectionSource.toIndex, true),
        fromLabel,
        toLabel,
        preferredItemName: typeof selectionSource.preferredItemName === 'string'
          ? selectionSource.preferredItemName.slice(0, 120)
          : '',
      },
      materials: sanitizeEvolutionMaterialInputs(source.materials),
      extras: sanitizeEvolutionExtraCosts(source.extras),
      eclipse: sanitizeEvolutionEclipseOptions(source.eclipse),
      result: sanitizeEvolutionCostResult(source.result),
    }];
  });
}

function formatEvolutionSeed(value: unknown): string {
  const safeValue = safeEvolutionNumber(value, true);
  if (safeValue <= 0) return '0';
  const units = [
    { value: 1_000_000_000_000, name: '조' },
    { value: 100_000_000, name: '억' },
    { value: 10_000, name: '만' },
  ];
  let remain = safeValue;
  const parts: string[] = [];
  for (const unit of units) {
    const quotient = Math.floor(remain / unit.value);
    if (quotient > 0) {
      parts.push(`${quotient.toLocaleString('ko-KR')}${unit.name}`);
      remain %= unit.value;
    }
  }
  if (remain > 0) parts.push(remain.toLocaleString('ko-KR'));
  return parts.join(' ');
}

const EVOLUTION_ITEM_IMAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  고대기사의건틀릿파편: '고대기사의건틀렛파편.png',
  수르트의무기파편: '수르트무기파편.png',
  용암거인의건틀릿파편: '용암거긴의건틀렛파편.png',
});

function getEvolutionItemImagePath(materialName: string): string {
  const normalized = String(materialName || '').replace(/[\s\-]/g, '');
  const fileName = EVOLUTION_ITEM_IMAGE_ALIASES[normalized] || `${normalized}.png`;
  return `assets/items/${encodeURIComponent(fileName)}`;
}

interface EvolutionCalculatorApi {
  EVOLUTION_MOON_HERB_FIXED_COST_SEED: number;
  EVOLUTION_HISTORY_SCHEMA_VERSION: number;
  DEFAULT_EVOLUTION_EXTRA_COSTS: Readonly<EvolutionExtraCosts>;
  DEFAULT_EVOLUTION_ECLIPSE_OPTIONS: Readonly<EvolutionEclipseOptions>;
  calculateEvolutionCost: typeof calculateEvolutionCost;
  sanitizeEvolutionExtraCosts: typeof sanitizeEvolutionExtraCosts;
  sanitizeEvolutionEclipseOptions: typeof sanitizeEvolutionEclipseOptions;
  sanitizeEvolutionMaterialInputs: typeof sanitizeEvolutionMaterialInputs;
  sanitizeEvolutionHistory: typeof sanitizeEvolutionHistory;
  formatEvolutionSeed: typeof formatEvolutionSeed;
  getEvolutionItemImagePath: typeof getEvolutionItemImagePath;
}

interface Window {
  evolutionCalculator: EvolutionCalculatorApi;
}

const EVOLUTION_CALCULATOR_API: EvolutionCalculatorApi = Object.freeze({
  EVOLUTION_MOON_HERB_FIXED_COST_SEED,
  EVOLUTION_HISTORY_SCHEMA_VERSION,
  DEFAULT_EVOLUTION_EXTRA_COSTS,
  DEFAULT_EVOLUTION_ECLIPSE_OPTIONS,
  calculateEvolutionCost,
  sanitizeEvolutionExtraCosts,
  sanitizeEvolutionEclipseOptions,
  sanitizeEvolutionMaterialInputs,
  sanitizeEvolutionHistory,
  formatEvolutionSeed,
  getEvolutionItemImagePath,
});

if (typeof module !== 'undefined' && module.exports) module.exports = EVOLUTION_CALCULATOR_API;
if (typeof window !== 'undefined') window.evolutionCalculator = EVOLUTION_CALCULATOR_API;
