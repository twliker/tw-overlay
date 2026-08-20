type CalculatorApi = {
  RELIC_STAGES: Array<{ label: string; enhanceMaterial: string }>;
  getStatCount(side: 'right' | 'left'): number;
  getStageCap(index: number, side: 'right' | 'left'): number;
  getEnhanceProbability(index: number, difficulty: number): number;
  calculateExpectation(input: Input): Summary | null;
  runSimulation(input: Input): Summary | null;
};
type Input = { side: 'right' | 'left'; currentStageIndex: number; targetStageIndex: number; difficulty: number; currentStatTotal: number };
type Summary = { attempts: number; successes: number; seedMan: number; materials: Record<string, number>; evolutionMaterials: Record<string, number>; evolutions: number };
const api = (window as any).relicCalculator as CalculatorApi;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const side = $('side') as HTMLSelectElement, currentStage = $('current-stage') as HTMLSelectElement, targetStage = $('target-stage') as HTMLSelectElement;
const difficulty = $('difficulty') as HTMLSelectElement, currentTotal = $('current-total') as HTMLInputElement;
const STAT_DEFINITIONS = {
  right: [['stab', '찌르기 공격력'], ['slash', '베기 공격력'], ['magic', '마법 공격력'], ['hit', '명중률 보정'], ['critical', '크리티컬']],
  left: [['physical-defense', '물리 방어력'], ['magic-defense', '마법 방어력'], ['dodge', '회피율 보정'], ['agility', '민첩성 보정']],
} as const;
const fmt = (value: number, digits = 0): string => value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
function formatSeed(seedMan: number): string {
  let remaining = Math.max(0, Math.round(seedMan * 10_000));
  if (remaining === 0) return '0 SEED';
  const parts: string[] = [];
  for (const unit of [{ value: 1_000_000_000_000, label: '조' }, { value: 100_000_000, label: '억' }, { value: 10_000, label: '만' }]) {
    if (remaining >= unit.value) {
      parts.push(`${Math.floor(remaining / unit.value).toLocaleString('ko-KR')}${unit.label}`);
      remaining %= unit.value;
    }
  }
  if (remaining > 0) parts.push(remaining.toLocaleString('ko-KR'));
  return `${parts.join(' ')} SEED`;
}

function input(): Input { return { side: side.value as Input['side'], currentStageIndex: Number(currentStage.value), targetStageIndex: Number(targetStage.value), difficulty: Number(difficulty.value), currentStatTotal: Number(currentTotal.value) || 0 }; }
function syncStatTotal(): void {
  const total = Array.from(document.querySelectorAll<HTMLInputElement>('[data-relic-stat]')).reduce((sum, element) => sum + (Number(element.value) || 0), 0);
  currentTotal.value = String(total);
  $('current-total-display').textContent = fmt(total);
  refreshGuide();
}
function renderStatInputs(): void {
  const previous = new Map(Array.from(document.querySelectorAll<HTMLInputElement>('[data-relic-stat]')).map(element => [element.dataset.relicStat || '', Number(element.value) || 0]));
  const selectedSide = side.value as Input['side'];
  const cap = api.getStageCap(Number(currentStage.value) || 0, selectedSide);
  $('stat-inputs').innerHTML = STAT_DEFINITIONS[selectedSide].map(([id, label]) => `<label class="text-xs font-bold text-slate-400">${label}<input type="number" min="0" max="${cap}" value="${Math.min(cap, previous.get(id) || 0)}" data-relic-stat="${id}" class="field mt-2 text-center"></label>`).join('');
  document.querySelectorAll<HTMLInputElement>('[data-relic-stat]').forEach(element => element.addEventListener('input', () => {
    element.value = String(Math.max(0, Math.min(cap, Number(element.value) || 0)));
    syncStatTotal();
  }));
  syncStatTotal();
}
function refreshTargets(): void {
  const current = Number(currentStage.value) || 0;
  const previous = Math.max(current, Number(targetStage.value) || current);
  targetStage.innerHTML = api.RELIC_STAGES.map((stage, index) => index >= current ? `<option value="${index}">${stage.label} MAX</option>` : '').join('');
  targetStage.value = String(Math.min(api.RELIC_STAGES.length - 1, previous));
  refreshGuide();
}
function refreshGuide(): void {
  const value = input(), count = api.getStatCount(value.side), cap = api.getStageCap(value.currentStageIndex, value.side), max = cap * count;
  $('current-guide').textContent = `능력치당 MAX ${cap} · 합계 MAX ${fmt(max)} · 강화 성공 ${fmt(Math.max(0, max - value.currentStatTotal))}회 남음`;
  $('probability-guide').textContent = `강화 성공 확률 ${(api.getEnhanceProbability(value.currentStageIndex, value.difficulty) * 100).toFixed(2)}%`;
}
function costs(summary: Summary): string {
  const rows = [...Object.entries(summary.materials), ...Object.entries(summary.evolutionMaterials)];
  return rows.length ? rows.map(([name, count]) => `${name} ${fmt(count, 2)}개`).join('<br>') : '재료 없음';
}
function render(target: string, summary: Summary | null, simulated: boolean): void {
  const el = $(target); if (!summary) { el.innerHTML = '<div class="col-span-4 metric text-rose-300 font-bold">선택한 난이도에서는 강화 성공 확률이 0%인 단계가 포함됩니다.</div>'; return; }
  el.innerHTML = `
    <div class="metric"><p class="text-xs text-slate-500">${simulated ? '실제 시도' : '평균 시도'}</p><strong class="text-xl text-indigo-300">${fmt(summary.attempts, simulated ? 0 : 2)}회</strong></div>
    <div class="metric"><p class="text-xs text-slate-500">필요 성공</p><strong class="text-xl">${fmt(summary.successes)}회</strong></div>
    <div class="metric"><p class="text-xs text-slate-500">진화</p><strong class="text-xl text-violet-300">${fmt(summary.evolutions)}회</strong></div>
    <div class="metric"><p class="text-xs text-slate-500">총 SEED</p><strong class="text-xl text-amber-300">${formatSeed(summary.seedMan)}</strong></div>
    <div class="metric col-span-4"><p class="text-xs text-slate-500 mb-2">소모 재료</p><div class="font-bold leading-6">${costs(summary)}</div></div>`;
}
api.RELIC_STAGES.forEach((stage, index) => currentStage.add(new Option(stage.label, String(index))));
for (let level = 1; level <= 20; level += 1) difficulty.add(new Option(`${level}단계`, String(level)));
difficulty.value = '20'; renderStatInputs(); refreshTargets();
side.addEventListener('change', renderStatInputs); difficulty.addEventListener('change', refreshGuide); currentStage.addEventListener('change', () => { refreshTargets(); renderStatInputs(); });
document.querySelectorAll<HTMLButtonElement>('.tab').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active')); button.classList.add('active'); const simulation = button.dataset.tab === 'simulation'; $('simulation-panel').classList.toggle('hidden', !simulation); $('expectation-panel').classList.toggle('hidden', simulation); }));
$('simulate-btn').addEventListener('click', () => render('simulation-result', api.runSimulation(input()), true));
$('expectation-btn').addEventListener('click', () => render('expectation-result', api.calculateExpectation(input()), false));
render('expectation-result', api.calculateExpectation(input()), false);
(window as any).lucide?.createIcons();
if ((window as any).bindEscapeClose) (window as any).bindEscapeClose();
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') window.close();
});

