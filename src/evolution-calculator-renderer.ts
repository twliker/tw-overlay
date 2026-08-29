namespace EvolutionCalculatorRenderer {
type EvolutionCategory = 'weapon' | 'equipment';

interface EvolutionMaterialDefinition { name: string; quantity: number }
interface EvolutionRecipe { materials: EvolutionMaterialDefinition[] }
interface EvolutionSystemData {
  evolutionSystem: {
    weapon: { evolutionChain: string[]; recipes: Record<string, EvolutionRecipe> };
    equipment: {
      evolutionChain: string[];
      parts: Record<string, Record<string, EvolutionRecipe>>;
    };
  };
}
interface EvolutionEquipmentImageItem {
  name: string;
  group: string;
  part?: string;
  image?: string;
}
interface AggregatedMaterial { quantity: number; steps: string[] }
interface EvolutionAutoSelection {
  category: 'weapon' | 'equipment';
  part: string;
  itemName: string;
}

const api = window.evolutionCalculator;
const HISTORY_STORAGE_KEY = 'tw-overlay:evolution-history:v1';
const DRAFT_STORAGE_KEY = 'tw-overlay:evolution-draft:v1';
const PRICE_UNIT_KEY = 'evo_price_unit';
const ELSO_OPTION_KEY = 'evo_elso_enabled';
const ECLIPSE_SPECIAL_MATERIALS = new Set([
  '가공된 달의 광물', '룬의 원석', '달의 약초', '가짜 달여왕 군단의 인장',
]);
const STEP_ORDER_EQUIPMENT = [
  'EnkiriaToShinEnkiria', 'ShinEnkiriaToInfernal', 'InfernalToAquilus',
  'AquilusToAbyss', 'AbyssToEclipse',
];
const STEP_ORDER_WEAPON = [
  'AcadToInfernal', 'InfernalToAquilus', 'AquilusToAbyss', 'AbyssToEclipse',
];
const STEP_LABELS: Record<string, string> = {
  EnkiriaToShinEnkiria: '엔키라→칼라그',
  ShinEnkiriaToInfernal: '칼라그→인퍼널',
  AcadToInfernal: '아카드→인퍼널',
  InfernalToAquilus: '인퍼널→아퀼루스',
  AquilusToAbyss: '아퀼루스→어비스',
  AbyssToEclipse: '어비스→이클립스',
};
const PART_TO_DICTIONARY_PART: Record<string, string> = {
  helm: 'helm', armor: 'armor', gloves: 'gauntlet', boots: 'boots',
  wings: 'wing', amulet: 'amulet', shield: 'wrist',
};

let evolutionData: EvolutionSystemData | null = null;
let equipmentImages: EvolutionEquipmentImageItem[] = [];
let currentCategory: EvolutionCategory = 'weapon';
let currentPart = 'helm';
let preferredEquipmentName = '';
let currentMaterials: Record<string, AggregatedMaterial> = {};
let currentResult: EvolutionCostResult = emptyResult();
let records: EvolutionHistoryRecord[] = loadHistory();
let editingRecordId: string | null = null;

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Evolution calculator element not found: ${id}`);
  return found as unknown as T;
}

const stepFrom = element<HTMLSelectElement>('step-from');
const stepTo = element<HTMLSelectElement>('step-to');
const materialList = element<HTMLElement>('material-list');
const partSelector = element<HTMLElement>('part-selector');
const startTierName = element<HTMLElement>('start-tier-name');
const endTierName = element<HTMLElement>('end-tier-name');
const startItemImage = element<HTMLImageElement>('start-item-image');
const endItemImage = element<HTMLImageElement>('end-item-image');
const eclipseCard = element<HTMLElement>('eclipse-cost-card');
const historyList = element<HTMLElement>('history-list');
const historyTitle = element<HTMLInputElement>('history-title');
const saveHistoryButton = element<HTMLButtonElement>('save-history-button');
const cancelEditButton = element<HTMLButtonElement>('cancel-edit-button');

function emptyResult(): EvolutionCostResult {
  return {
    materialSeed: 0, enchantScrollSeed: 0, otherEnhancementSeed: 0,
    eclipseBaseSeed: 0, eclipseSealSeed: 0, totalSeed: 0, totalElso: 0,
  };
}

function numericInput(id: string): number {
  const value = Number(element<HTMLInputElement>(id).value.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function setNumericInput(id: string, value: number): void {
  element<HTMLInputElement>(id).value = value > 0 ? String(value) : '';
}

function escape(value: unknown): string {
  return window.escapeHtml(String(value ?? ''));
}

function getPriceKey(materialName: string): string {
  return `evo_price_${materialName}`;
}

function loadPrice(materialName: string): number {
  const value = Number(localStorage.getItem(getPriceKey(materialName)) || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function savePrice(materialName: string, value: number): void {
  if (value > 0) localStorage.setItem(getPriceKey(materialName), String(value));
  else localStorage.removeItem(getPriceKey(materialName));
}

function loadElsoOption(): boolean {
  return localStorage.getItem(ELSO_OPTION_KEY) === 'true';
}

function saveElsoOption(enabled: boolean): void {
  localStorage.setItem(ELSO_OPTION_KEY, enabled ? 'true' : 'false');
}

function migratePriceUnit(): void {
  if (localStorage.getItem(PRICE_UNIT_KEY) === 'man') return;
  Object.keys(localStorage).filter(key => key.startsWith('evo_price_') && key !== PRICE_UNIT_KEY)
    .forEach(key => localStorage.removeItem(key));
  localStorage.setItem(PRICE_UNIT_KEY, 'man');
}

function getChain(): string[] {
  if (!evolutionData) return [];
  return currentCategory === 'weapon'
    ? evolutionData.evolutionSystem.weapon.evolutionChain
    : evolutionData.evolutionSystem.equipment.evolutionChain;
}

function getStepOrder(): string[] {
  return currentCategory === 'weapon' ? STEP_ORDER_WEAPON : STEP_ORDER_EQUIPMENT;
}

function getSelectedSteps(): string[] {
  const fromIndex = Number(stepFrom.value);
  const toIndex = Number(stepTo.value);
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex >= toIndex) return [];
  return getStepOrder().slice(fromIndex, toIndex);
}

function rebuildStepSelectors(preferredFrom?: number, preferredTo?: number): void {
  const chain = getChain();
  if (chain.length < 2) return;
  const previousFrom = Number.isInteger(preferredFrom) ? preferredFrom! : Number(stepFrom.value || 0);
  const previousTo = Number.isInteger(preferredTo) ? preferredTo! : Number(stepTo.value || chain.length - 1);
  stepFrom.innerHTML = chain.slice(0, -1).map((name, index) => `<option value="${index}">${escape(name)}</option>`).join('');
  stepTo.innerHTML = chain.slice(1).map((name, index) => `<option value="${index + 1}">${escape(name)}</option>`).join('');
  stepFrom.value = String(Math.max(0, Math.min(chain.length - 2, Number.isFinite(previousFrom) ? previousFrom : 0)));
  const safeTo = Math.max(Number(stepFrom.value) + 1, Math.min(chain.length - 1, Number.isFinite(previousTo) ? previousTo : chain.length - 1));
  stepTo.value = String(safeTo);
}

function aggregateMaterials(steps: string[]): Record<string, AggregatedMaterial> {
  if (!evolutionData) return {};
  const recipes = currentCategory === 'weapon'
    ? evolutionData.evolutionSystem.weapon.recipes
    : evolutionData.evolutionSystem.equipment.parts[currentPart];
  const aggregated: Record<string, AggregatedMaterial> = {};
  for (const step of steps) {
    for (const material of recipes?.[step]?.materials || []) {
      // 인장 획득 방식에 따라 달라지는 네 항목은 이클립스 전용 카드에서 한 번만 계산한다.
      if (step === 'AbyssToEclipse' && ECLIPSE_SPECIAL_MATERIALS.has(material.name)) continue;
      const current = aggregated[material.name] || { quantity: 0, steps: [] };
      current.quantity += material.quantity;
      if (!current.steps.includes(step)) current.steps.push(step);
      aggregated[material.name] = current;
    }
  }
  return aggregated;
}

function materialInputs(): EvolutionMaterialCostInput[] {
  const useElso = loadElsoOption();
  return Object.entries(currentMaterials).map(([name, data]) => ({
    name,
    quantity: data.quantity,
    unitPriceMan: loadPrice(name),
    payment: name === '태청금액신단' && useElso ? 'elso' : 'seed',
    elsoUnitPrice: name === '태청금액신단' ? 23_000 : 0,
  }));
}

function collectExtras(): EvolutionExtraCosts {
  return api.sanitizeEvolutionExtraCosts({
    enchantScrollCount: numericInput('enchant-scroll-count'),
    enchantScrollUnitPriceMan: numericInput('enchant-scroll-unit-price'),
    enchantAttemptCostMan: numericInput('enchant-attempt-cost'),
    magicReformCostMan: numericInput('magic-reform-cost'),
    additionalOptionCostMan: numericInput('additional-option-cost'),
  });
}

function isEclipseIncluded(): boolean {
  return getSelectedSteps().includes('AbyssToEclipse');
}

function collectEclipseOptions(): EvolutionEclipseOptions {
  const sealMethod = document.querySelector<HTMLInputElement>('input[name="seal-method"]:checked')?.value;
  return api.sanitizeEvolutionEclipseOptions({
    enabled: isEclipseIncluded(),
    baseType: element<HTMLSelectElement>('eclipse-base-type').value,
    baseEquipmentCostMan: numericInput('eclipse-base-cost'),
    sealMethod,
    proxyFeeMan: numericInput('seal-proxy-fee'),
    moonMineralCostMan: numericInput('moon-mineral-cost'),
    runeStoneCostMan: numericInput('rune-stone-cost'),
  });
}

function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ extras: collectExtras(), eclipse: collectEclipseOptions() }));
  } catch {
    // 초과·차단된 저장소 때문에 계산 자체를 중단하지 않는다.
  }
}

function loadDraft(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}');
    applyExtras(api.sanitizeEvolutionExtraCosts(parsed.extras));
    applyEclipse(api.sanitizeEvolutionEclipseOptions(parsed.eclipse));
  } catch {
    applyExtras({ ...api.DEFAULT_EVOLUTION_EXTRA_COSTS });
    applyEclipse({ ...api.DEFAULT_EVOLUTION_ECLIPSE_OPTIONS });
  }
}

function applyExtras(extras: EvolutionExtraCosts): void {
  setNumericInput('enchant-scroll-count', extras.enchantScrollCount);
  setNumericInput('enchant-scroll-unit-price', extras.enchantScrollUnitPriceMan);
  setNumericInput('enchant-attempt-cost', extras.enchantAttemptCostMan);
  setNumericInput('magic-reform-cost', extras.magicReformCostMan);
  setNumericInput('additional-option-cost', extras.additionalOptionCostMan);
}

function applyEclipse(eclipse: EvolutionEclipseOptions): void {
  element<HTMLSelectElement>('eclipse-base-type').value = eclipse.baseType;
  setNumericInput('eclipse-base-cost', eclipse.baseEquipmentCostMan);
  const radio = document.querySelector<HTMLInputElement>(`input[name="seal-method"][value="${eclipse.sealMethod}"]`);
  if (radio) radio.checked = true;
  setNumericInput('seal-proxy-fee', eclipse.proxyFeeMan);
  setNumericInput('moon-mineral-cost', eclipse.moonMineralCostMan);
  setNumericInput('rune-stone-cost', eclipse.runeStoneCostMan);
  renderSealMethod();
}

function renderSealMethod(): void {
  const proxy = document.querySelector<HTMLInputElement>('input[name="seal-method"]:checked')?.value === 'proxy';
  element<HTMLElement>('seal-self-fields').classList.toggle('hidden', proxy);
  element<HTMLElement>('seal-proxy-fields').classList.toggle('hidden', !proxy);
}

function updateTotalCost(): void {
  currentResult = api.calculateEvolutionCost({ materials: materialInputs(), extras: collectExtras(), eclipse: collectEclipseOptions() });
  element<HTMLElement>('total-cost').textContent = `${api.formatEvolutionSeed(currentResult.totalSeed)} 시드`;
  const elso = element<HTMLElement>('total-elso');
  elso.textContent = `+ ${currentResult.totalElso.toLocaleString('ko-KR')} 엘소`;
  elso.classList.toggle('hidden', currentResult.totalElso <= 0);
  const eclipseTotal = currentResult.eclipseBaseSeed + currentResult.eclipseSealSeed;
  element<HTMLElement>('cost-breakdown').textContent = [
    `필수 재료 ${api.formatEvolutionSeed(currentResult.materialSeed)}`,
    `후처리 ${api.formatEvolutionSeed(currentResult.enchantScrollSeed + currentResult.otherEnhancementSeed)}`,
    eclipseTotal > 0 ? `이클립스 ${api.formatEvolutionSeed(eclipseTotal)}` : '',
  ].filter(Boolean).join(' · ');
  document.querySelectorAll<HTMLInputElement>('.material-price-input').forEach(input => {
    const row = input.closest<HTMLElement>('.material-row');
    const quantity = Number(input.dataset.quantity || 0);
    const isElso = input.dataset.name === '태청금액신단' && loadElsoOption();
    const subtotal = row?.querySelector<HTMLElement>('.material-subtotal');
    if (!subtotal) return;
    subtotal.textContent = isElso
      ? `${(quantity * 23_000).toLocaleString('ko-KR')} 엘소`
      : api.formatEvolutionSeed(quantity * loadPrice(input.dataset.name || '') * 10_000);
    subtotal.classList.toggle('muted', !isElso && loadPrice(input.dataset.name || '') <= 0);
  });
}

function attachImageFallback(image: HTMLImageElement): void {
  image.addEventListener('error', () => {
    image.classList.add('hidden');
    image.parentElement?.querySelector('svg, i')?.classList.remove('hidden');
  }, { once: true });
}

function renderMaterials(): void {
  const steps = getSelectedSteps();
  currentMaterials = aggregateMaterials(steps);
  const entries = Object.entries(currentMaterials);
  element<HTMLElement>('step-summary').textContent = steps.map(step => STEP_LABELS[step] || step).join(' + ') || 'MATERIALS';
  eclipseCard.classList.toggle('hidden', !steps.includes('AbyssToEclipse'));
  if (entries.length === 0) {
    materialList.innerHTML = '<div class="empty-state">올바른 진화 범위를 선택해 주세요.</div>';
    updateTotalCost();
    return;
  }
  const elsoSelected = loadElsoOption();
  materialList.innerHTML = entries.map(([name, data]) => {
    const imagePath = api.getEvolutionItemImagePath(name);
    const taecheong = name === '태청금액신단';
    const price = loadPrice(name);
    const disabled = taecheong && elsoSelected;
    return `<div class="material-row">
      <div class="material-info"><div class="material-image"><i class="hidden" data-lucide="package"></i><img src="${imagePath}" alt="${escape(name)}"></div><div style="min-width:0"><div class="material-name">${escape(name)}</div>${taecheong ? `<label style="display:flex;align-items:center;gap:4px;margin-top:3px;color:#c084fc;font-size:8px;font-weight:900"><input class="elso-checkbox" type="checkbox" ${elsoSelected ? 'checked' : ''}> 엘소 구입 (개당 23,000)</label>` : ''}<div class="step-tags">${data.steps.map(step => `<span class="step-tag">${escape(STEP_LABELS[step] || step)}</span>`).join('')}</div></div></div>
      <div style="text-align:right;color:#cbd5e1;font-size:11px;font-weight:900">×${data.quantity.toLocaleString('ko-KR')}</div>
      <input class="number-input material-price-input" type="number" min="0" data-name="${escape(name)}" data-quantity="${data.quantity}" value="${price || ''}" placeholder="단가" ${disabled ? 'disabled' : ''}>
      <div class="material-subtotal money ${price > 0 || disabled ? '' : 'muted'}">0</div>
    </div>`;
  }).join('');
  materialList.querySelectorAll<HTMLImageElement>('.material-image img').forEach(attachImageFallback);
  materialList.querySelectorAll<HTMLInputElement>('.material-price-input').forEach(input => {
    input.addEventListener('input', () => {
      savePrice(input.dataset.name || '', Number(input.value));
      updateTotalCost();
    });
  });
  materialList.querySelectorAll<HTMLInputElement>('.elso-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      saveElsoOption(checkbox.checked);
      renderMaterials();
    });
  });
  lucide.createIcons();
  updateTotalCost();
}

function equipmentForTier(tier: string): EvolutionEquipmentImageItem | undefined {
  const chain = getChain();
  const sourceTier = chain.find(name => preferredEquipmentName.includes(name));
  const desiredName = sourceTier ? preferredEquipmentName.replace(sourceTier, tier) : '';
  const expectedPart = currentCategory === 'weapon' ? 'weapon' : PART_TO_DICTIONARY_PART[currentPart];
  const candidates = equipmentImages.filter(item => item.name.includes(tier) && item.part === expectedPart && item.image);
  return candidates.find(item => item.name === desiredName) || candidates[0];
}

function renderTierImage(image: HTMLImageElement, tier: string): void {
  const equipment = equipmentForTier(tier);
  image.classList.toggle('hidden', !equipment?.image);
  image.parentElement?.querySelector('.tier-fallback')?.classList.toggle('hidden', Boolean(equipment?.image));
  if (equipment?.image) image.src = `assets/img/equipment/${encodeURIComponent(equipment.image)}`;
}

function updateRoute(): void {
  const chain = getChain();
  const fromIndex = Number(stepFrom.value);
  const toIndex = Number(stepTo.value);
  const fromTier = chain[fromIndex] || '-';
  const toTier = chain[toIndex] || '-';
  startTierName.textContent = fromTier;
  endTierName.textContent = toTier;
  renderTierImage(startItemImage, fromTier);
  renderTierImage(endItemImage, toTier);
  renderMaterials();
}

function selectCategory(category: EvolutionCategory, fromIndex?: number, toIndex?: number): void {
  currentCategory = category;
  document.querySelectorAll<HTMLElement>('[data-category]').forEach(button => button.classList.toggle('active', button.dataset.category === category));
  partSelector.classList.toggle('hidden', category !== 'equipment');
  rebuildStepSelectors(fromIndex, toIndex);
  updateRoute();
}

function selectPart(part: string, fromIndex?: number, toIndex?: number): void {
  currentPart = part || 'helm';
  document.querySelectorAll<HTMLElement>('[data-part]').forEach(button => button.classList.toggle('active', button.dataset.part === currentPart));
  rebuildStepSelectors(fromIndex, toIndex);
  updateRoute();
}

function loadHistory(): EvolutionHistoryRecord[] {
  try {
    return api.sanitizeEvolutionHistory(JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function persistHistory(): void {
  try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(records)); } catch { /* keep current calculation usable */ }
}

function renderHistory(): void {
  const ordered = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  if (ordered.length === 0) {
    historyList.innerHTML = '<div class="empty-state">저장된 계산 이력이 없습니다.<br>제목과 함께 현재 계산값을 저장해 보세요.</div>';
    return;
  }
  historyList.innerHTML = ordered.map(record => `<article class="history-card" data-history-id="${escape(record.id)}">
    <div class="history-title">${escape(record.title)}</div>
    <div class="history-route">${escape(record.selection.fromLabel)} → ${escape(record.selection.toLabel)}</div>
    <div class="history-total">${api.formatEvolutionSeed(record.result.totalSeed)} 시드</div>
    ${record.result.totalElso > 0 ? `<div style="margin-top:2px;color:#c084fc;font-size:9px;font-weight:900">+ ${record.result.totalElso.toLocaleString('ko-KR')} 엘소</div>` : ''}
    <div class="history-meta"><span>${new Date(record.updatedAt).toLocaleString('ko-KR')}</span><div class="history-actions"><button data-action="edit">수정</button><button data-action="delete">삭제</button></div></div>
  </article>`).join('');
}

function currentSelection(): EvolutionHistorySelection {
  const chain = getChain();
  const fromIndex = Number(stepFrom.value);
  const toIndex = Number(stepTo.value);
  return {
    category: currentCategory,
    part: currentCategory === 'equipment' ? currentPart : '',
    fromIndex,
    toIndex,
    fromLabel: chain[fromIndex] || '',
    toLabel: chain[toIndex] || '',
    preferredItemName: preferredEquipmentName,
  };
}

function saveHistory(): void {
  const selection = currentSelection();
  if (!selection.fromLabel || !selection.toLabel) return;
  const now = Date.now();
  const existing = editingRecordId ? records.find(record => record.id === editingRecordId) : undefined;
  const record: EvolutionHistoryRecord = {
    schemaVersion: api.EVOLUTION_HISTORY_SCHEMA_VERSION,
    id: existing?.id || (crypto.randomUUID?.() || `evolution-${now}-${Math.random().toString(16).slice(2)}`),
    title: historyTitle.value.trim() || `${selection.fromLabel} → ${selection.toLabel}`,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    selection,
    materials: materialInputs(),
    extras: collectExtras(),
    eclipse: collectEclipseOptions(),
    result: currentResult,
  };
  records = existing ? records.map(entry => entry.id === existing.id ? record : entry) : [record, ...records];
  persistHistory();
  renderHistory();
  cancelEditing();
}

function applyHistory(record: EvolutionHistoryRecord): void {
  preferredEquipmentName = record.selection.preferredItemName;
  currentCategory = record.selection.category;
  currentPart = record.selection.part || 'helm';
  record.materials.forEach(material => savePrice(material.name, material.unitPriceMan));
  saveElsoOption(record.materials.some(material => material.payment === 'elso'));
  applyExtras(record.extras);
  applyEclipse(record.eclipse);
  selectCategory(currentCategory, record.selection.fromIndex, record.selection.toIndex);
  if (currentCategory === 'equipment') selectPart(currentPart, record.selection.fromIndex, record.selection.toIndex);
  historyTitle.value = record.title;
  editingRecordId = record.id;
  saveHistoryButton.textContent = '계산 이력 변경 저장';
  cancelEditButton.classList.remove('hidden');
  updateTotalCost();
}

function cancelEditing(): void {
  editingRecordId = null;
  historyTitle.value = '';
  saveHistoryButton.textContent = '계산 이력 저장';
  cancelEditButton.classList.add('hidden');
}

function deleteHistory(recordId: string): void {
  const record = records.find(entry => entry.id === recordId);
  if (!record) return;
  if (!window.confirm(`'${record.title}' 계산 이력을 삭제할까요?`)) return;
  records = records.filter(entry => entry.id !== recordId);
  persistHistory();
  if (editingRecordId === recordId) cancelEditing();
  renderHistory();
}

function resetPrices(): void {
  if (!window.confirm('저장된 재료 단가를 모두 초기화할까요? 계산 이력은 삭제되지 않습니다.')) return;
  Object.keys(localStorage).filter(key => key.startsWith('evo_price_') && key !== PRICE_UNIT_KEY)
    .forEach(key => localStorage.removeItem(key));
  localStorage.setItem(PRICE_UNIT_KEY, 'man');
  renderMaterials();
}

function handleAutoSelect(data: Partial<EvolutionAutoSelection>): void {
  if (!data || !evolutionData) return;
  preferredEquipmentName = typeof data.itemName === 'string' ? data.itemName : '';
  const category: EvolutionCategory = data.category === 'equipment' ? 'equipment' : 'weapon';
  currentPart = typeof data.part === 'string' && data.part ? data.part : 'helm';
  currentCategory = category;
  const chain = getChain();
  const fromIndex = chain.findIndex(tier => preferredEquipmentName.includes(tier));
  selectCategory(category, fromIndex >= 0 ? fromIndex : 0, chain.length - 1);
  if (category === 'equipment') selectPart(currentPart, fromIndex >= 0 ? fromIndex : 0, chain.length - 1);
}

function bindEvents(): void {
  element<HTMLButtonElement>('close-button').addEventListener('click', () => window.close());
  document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(button => button.addEventListener('click', () => selectCategory(button.dataset.category === 'equipment' ? 'equipment' : 'weapon')));
  document.querySelectorAll<HTMLButtonElement>('[data-part]').forEach(button => button.addEventListener('click', () => selectPart(button.dataset.part || 'helm')));
  stepFrom.addEventListener('change', () => {
    if (Number(stepFrom.value) >= Number(stepTo.value)) stepTo.value = String(Math.min(getChain().length - 1, Number(stepFrom.value) + 1));
    updateRoute();
  });
  stepTo.addEventListener('change', () => updateRoute());
  document.querySelectorAll<HTMLInputElement>('.number-input').forEach(input => input.addEventListener('input', () => { saveDraft(); updateTotalCost(); }));
  element<HTMLSelectElement>('eclipse-base-type').addEventListener('change', () => { saveDraft(); updateTotalCost(); });
  document.querySelectorAll<HTMLInputElement>('input[name="seal-method"]').forEach(radio => radio.addEventListener('change', () => { renderSealMethod(); saveDraft(); updateTotalCost(); }));
  saveHistoryButton.addEventListener('click', saveHistory);
  cancelEditButton.addEventListener('click', cancelEditing);
  element<HTMLButtonElement>('reset-prices-button').addEventListener('click', resetPrices);
  historyList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    const card = button?.closest<HTMLElement>('[data-history-id]');
    if (!button || !card) return;
    const id = card.dataset.historyId || '';
    if (button.dataset.action === 'edit') {
      const record = records.find(entry => entry.id === id);
      if (record) applyHistory(record);
    } else if (button.dataset.action === 'delete') deleteHistory(id);
  });
  attachImageFallback(startItemImage);
  attachImageFallback(endItemImage);
}

let pendingAutoSelection: Partial<EvolutionAutoSelection> | null = null;

async function init(): Promise<void> {
  migratePriceUnit();
  bindEvents();
  loadDraft();
  renderHistory();
  const [evolutionResponse, equipmentResponse] = await Promise.all([
    fetch('assets/data/evolution_data.json'),
    fetch('assets/data/equipment_dic.json'),
  ]);
  if (!evolutionResponse.ok) throw new Error(`진화 데이터 HTTP ${evolutionResponse.status}`);
  evolutionData = await evolutionResponse.json() as EvolutionSystemData;
  if (equipmentResponse.ok) equipmentImages = await equipmentResponse.json() as EvolutionEquipmentImageItem[];
  selectCategory('weapon', 0, getChain().length - 1);
  if (pendingAutoSelection) {
    handleAutoSelect(pendingAutoSelection);
    pendingAutoSelection = null;
  }
  lucide.createIcons();
  (window as unknown as { bindEscapeClose?: () => void }).bindEscapeClose?.();
  (window as unknown as { electronAPI?: { sendRendererReady?: (key: string) => void } }).electronAPI?.sendRendererReady?.('evolutionCalculator');
}

const electronApi = (window as unknown as {
  electronAPI?: { onAutoSelectEvolution?: (callback: (data: Partial<EvolutionAutoSelection>) => void) => void };
}).electronAPI;
electronApi?.onAutoSelectEvolution?.(data => {
  if (!evolutionData) pendingAutoSelection = data;
  else handleAutoSelect(data);
});

init().catch(error => {
  console.error('Failed to initialize evolution calculator:', error);
  materialList.innerHTML = `<div class="empty-state" style="color:#fb7185">데이터를 불러오지 못했습니다.<br>${escape(error instanceof Error ? error.message : error)}</div>`;
});
}
