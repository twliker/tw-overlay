// @ts-nocheck
// 계수 및 명중 계산기 통합 렌더러 (빌드 오류 수정 완료본)

interface Equipment { name: string; series: string; part?: string; stab?: number; hack?: number; def?: number; mag_atk?: number; mag_def?: number; hit?: number; }
interface ProfileData { id: string; name: string; data: any; }

let gearData: any = { armors: {}, weapons: {}, defense: {}, wrists: {}, artifacts: {} };
let activeBuffs: any[] = [];
let profiles: Record<string, ProfileData> = {};
let currentProfileId = 'default';
let currentType = 'stab';

// loadProfileData가 장비 select에 change 이벤트를 디스패치하면 전역 input/change
// 리스너의 saveCurrentProfile이 로딩 중간의 불완전한 DOM을 저장해 프로필이 손상된다.
// 로딩 동안 저장을 억제하기 위한 플래그.
let isLoadingProfile = false;

let pendingItemFromDic: any = null;

let showBuffTooltip = true;
function updateBuffTooltipIcon(): void {
  const toggleBtn = document.getElementById('btn-toggle-buff-info');
  if (toggleBtn) {
    toggleBtn.textContent = showBuffTooltip ? '툴팁 ON' : '툴팁 OFF';
  }
}
function updateBuffTooltipVisibility(): void {
  const bInfo = document.getElementById('active-buff-info');
  const presetSelect = document.getElementById('buff-preset-select') as HTMLSelectElement;
  const toggleBtn = document.getElementById('btn-toggle-buff-info');

  if (presetSelect && presetSelect.value !== 'none') {
    if (toggleBtn) {
      toggleBtn.classList.remove('hidden');
      updateBuffTooltipIcon(); // 아이콘 갱신 및 lucide 그리기 강제 트리거
    }
    if (bInfo) {
      if (showBuffTooltip) {
        bInfo.classList.remove('hidden');
      } else {
        bInfo.classList.add('hidden');
      }
    }
  } else {
    if (toggleBtn) toggleBtn.classList.add('hidden');
    if (bInfo) bInfo.classList.add('hidden');
  }
}

if ((window as any).electronAPI && (window as any).electronAPI.onAutoSelectEquipment) {
  (window as any).electronAPI.onAutoSelectEquipment((item: any) => {
    if (!gearData || Object.keys(gearData.armors || {}).length === 0) {
      pendingItemFromDic = item;
    } else {
      applyEquipmentFromDic(item);
    }
  });
}

const categories = [
  { id: 'helm', source: 'defense', key: '투구' }, { id: 'armor', source: 'armors', isNested: true },
  { id: 'weapon', source: 'weapons', isNested: true }, { id: 'wrist', source: 'wrists', isNested: true },
  { id: 'amulet', source: 'defense', key: '머리' }, { id: 'wing', source: 'defense', key: '몸' },
  { id: 'gauntlet', source: 'defense', key: '손' }, { id: 'boots', source: 'defense', key: '다리' },
  { id: 'artifact', source: 'artifacts', isNested: true }
];

const statNames: Record<string, string[]> = {
  stab: ['찌르기', '베기'], hack: ['베기', '찌르기'], phycomp: ['찌르기', '베기'],
  magatk: ['마공', '마방'], maghack: ['베기', '마공'], magdef: ['마방', '마공']
};

const PROFILES_KEY = 'tw-coefficient-calculator-profiles-v1';
const SAVE_KEY = 'tw-coefficient-calculator-settings-v7final';

function parseMaxStat(val: string | undefined): number {
  if (!val) return 0;
  const cleaned = val.replace(/\([^)]*\)/g, '').trim();
  if (cleaned === '' || cleaned === '-') return 0;
  
  if (/^-?\d+$/.test(cleaned)) {
    return Number(cleaned) || 0;
  }

  // Range strings are "min-max" (e.g. "122-132"); the hyphen is a separator,
  // not a minus sign. Extract positive tokens and take the max (upper bound).
  const numbers = cleaned.match(/\d+/g);
  if (numbers) {
    return Math.max(...numbers.map(Number));
  }
  return 0;
}

function matchesCalcSearch(name: string, category: string, query: string): boolean {
  if (!(window as any).HangulUtils) {
    const q = query.toLowerCase().trim();
    return name.toLowerCase().includes(q) || category.toLowerCase().includes(q);
  }
  return (window as any).HangulUtils.matchesSearch(name, category, query);
}

function getSeries(name: string): string {
  if (name.includes('改-세크리드')) return '改-세크리드';
  if (name.includes('세크리드')) return '세크리드';
  if (name.includes('이클립스')) return '이클립스';
  if (name.includes('어비스')) return '어비스';
  if (name.includes('아퀼루스')) return '아퀼루스';
  if (name.includes('인퍼널')) return '인퍼널';
  if (name.includes('데모닉')) return '데모닉';
  if (name.includes('페어리 피타') || name.includes('페어리피타')) return '페어리피타';
  return '';
}

let isGlobalClickRegistered = false;

async function init() {
  try {
    const [eqDic, buffs] = await Promise.all([
      fetch('./assets/data/equipment_dic.json').then(r => r.json()),
      fetch('./assets/data/buffs.json').then(r => r.json())
    ]);

    const armors: Record<string, any[]> = {};
    const weapons: Record<string, any[]> = {};
    const wrists: Record<string, any[]> = {};
    const artifacts: Record<string, any[]> = {};
    const defense: Record<string, any[]> = {
      '투구': [], '머리': [], '몸': [], '손': [], '다리': []
    };

    eqDic.forEach((item: any) => {
      if (item.group === '어빌리티') return;

      const stats = item.stats || {};
      const parsedItem = {
        name: item.name,
        series: getSeries(item.name),
        part: item.part || '',
        image: item.image || '',
        stab: parseMaxStat(stats.stab),
        hack: parseMaxStat(stats.hack),
        def: parseMaxStat(stats.def),
        mag_atk: parseMaxStat(stats.mag_atk),
        mag_def: parseMaxStat(stats.mag_def),
        hit: parseMaxStat(stats.hit),
        eva: parseMaxStat(stats.eva),
        agi: parseMaxStat(stats.agi),
        cri: parseMaxStat(stats.cri),
        delay: item.delay || ''
      };

      if (item.group === '무기') {
        if (!weapons[item.category]) weapons[item.category] = [];
        weapons[item.category].push(parsedItem);
      } else if (item.group === '갑옷') {
        if (!armors[item.category]) armors[item.category] = [];
        armors[item.category].push(parsedItem);
      } else if (item.group === '손목') {
        if (!wrists[item.category]) wrists[item.category] = [];
        wrists[item.category].push(parsedItem);
      } else if (item.group === '아티팩트') {
        if (!artifacts[item.category]) artifacts[item.category] = [];
        artifacts[item.category].push(parsedItem);
      } else if (item.part) {
        const partMap: Record<string, string> = {
          'helm': '투구',
          'amulet': '머리',
          'wing': '몸',
          'gauntlet': '손',
          'boots': '다리'
        };
        const defKey = partMap[item.part];
        if (defKey && defense[defKey]) {
          defense[defKey].push(parsedItem);
        }
      }
    });

    gearData = { armors, weapons, defense, wrists, artifacts };
    activeBuffs = buffs;
    renderEquipmentOptions();
    initProfiles();
    initBuffPresets();
    updateLabels();
    calculate();
    if ((window as any).lucide) (window as any).lucide.createIcons();
  } catch (e) { console.error('Data Load Failed', e); }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      (e.currentTarget as HTMLElement).classList.add('active');
      currentType = (e.currentTarget as HTMLElement).dataset.type || 'stab';
      updateLabels(); calculate(); saveCurrentProfile();
    });
  });

  const handleInput = () => { if (isLoadingProfile) return; calculate(); saveCurrentProfile(); };
  document.addEventListener('input', (e) => { if (['INPUT', 'SELECT'].includes((e.target as HTMLElement).tagName)) handleInput(); });
  document.addEventListener('change', (e) => { if ((e.target as HTMLElement).tagName === 'SELECT') handleInput(); });
  document.getElementById('profile-select')?.addEventListener('change', (e) => switchProfile((e.target as HTMLSelectElement).value));
  document.getElementById('buff-preset-select')?.addEventListener('change', () => { calculate(); saveCurrentProfile(); });
  document.getElementById('btn-toggle-buff-info')?.addEventListener('click', () => {
    showBuffTooltip = !showBuffTooltip;
    updateBuffTooltipIcon();
    updateBuffTooltipVisibility();
  });
  document.getElementById('btn-add-profile')?.addEventListener('click', async () => { const n = await showPrompt('새 프로필', '이름 입력:'); if (n?.trim()) addProfile(n.trim()); });
  document.getElementById('btn-rename-profile')?.addEventListener('click', async () => { const p = profiles[currentProfileId]; if (p) { const n = await showPrompt('이름 변경', '새 이름:', p.name); if (n?.trim() && n !== p.name) renameProfile(currentProfileId, n.trim()); } });
  document.getElementById('btn-delete-profile')?.addEventListener('click', async () => { if (Object.keys(profiles).length > 1 && await showConfirm('삭제', '정말 삭제할까요?')) deleteProfile(currentProfileId); else if (Object.keys(profiles).length <= 1) showAlert('알림', '최소 1개는 유지해야 합니다.'); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const m = document.getElementById('modal-overlay'); if (m && !m.classList.contains('hidden')) document.getElementById('modal-cancel')?.click(); else window.close(); } });
  if (pendingItemFromDic) {
    applyEquipmentFromDic(pendingItemFromDic);
    pendingItemFromDic = null;
  }

  if ((window as any).electronAPI && (window as any).electronAPI.sendRendererReady) {
    (window as any).electronAPI.sendRendererReady('coefficientCalculator');
  }
}

function initBuffPresets() {
  const select = document.getElementById('buff-preset-select') as HTMLSelectElement;
  if (!select) return;
  const savedPresets = localStorage.getItem('buff_presets');
  if (savedPresets) {
    try {
      const presets = JSON.parse(savedPresets);
      if (Array.isArray(presets)) {
        presets.forEach((p: any) => { const opt = document.createElement('option'); opt.value = p.id.toString(); opt.innerText = p.name; select.appendChild(opt); });
      }
    } catch (e) {
      console.error('Failed to parse buff presets', e);
    }
  }
}

/**
 * 기능 계약: 계수 계산 결과와 주스탯 요약
 *
 * - 상단 `주스탯`은 테일즈위버 능력치 표기와 같은 `캐릭터 / 장비` 순서로 표시한다.
 * - 캐릭터 값은 현재 공격 계열의 주스탯에 선택한 도핑의 고정·비율 보너스를 적용한 값이다.
 * - 장비 값은 현재 공격 계열의 기본·강화·어빌리티 주스탯과 선택한 지역 코어 주스탯의 합이다.
 *   아바타 기본 세트 +15처럼 계산기가 자동 가산하는 장비 수치도 동일하게 포함한다.
 * - 공격 계열, 도핑, 장비 입력 또는 코어 선택이 바뀌면 계수·주스탯·명중을 한 번에 다시 계산한다.
 * - 이 기준을 바꿀 때는 시간 측정기의 스탯 스냅샷 계산과
 *   `scripts/check-renderer-behavior.ts`의 계수 계산기 검사를 함께 확인한다.
 */
function calculate() {
  try {
    const presetId = (document.getElementById('buff-preset-select') as HTMLSelectElement)?.value || 'none';
    let buffIds: string[] = [];
    if (presetId === 'standard') buffIds = (window as any).buffConstants.STANDARD_BUFFS;
    else if (presetId !== 'none') {
      const savedPresets = localStorage.getItem('buff_presets');
      if (savedPresets) {
        try {
          const presets = JSON.parse(savedPresets);
          if (Array.isArray(presets)) {
            const preset = presets.find((p: any) => p.id.toString() === presetId);
            if (preset) buffIds = preset.buffIds;
          }
        } catch (e) {
          console.error('Failed to parse buff presets in calculate', e);
        }
      }
    }

    let bFix = 0, bPct = 0;
    buffIds.forEach(id => {
      const b = activeBuffs.find(x => x.id === id);
      if (b && b.effects) {
        if (b.effects.stat) bFix += b.effects.stat;
        if (b.effects.statRate) bPct += b.effects.statRate;
      }
    });

    const getV = (id: string) => {
      const el = document.getElementById(id) as HTMLInputElement;
      if (!el) return 0;
      return Math.max(0, Number(el.value) || 0);
    };
    
    const [mainLabel, subLabel] = statNames[currentType] || ['STAB', 'HACK'];

    const calcBonus = (baseId: string) => {
      const base = getV(baseId);
      const bonusFromPct = Math.floor((base + bFix) * (bPct / 100));
      return { fixed: bFix, ratio: bPct, bonusFromPct };
    };

    const mainBonus = calcBonus(`stat-${mainLabel.toLowerCase()}`);
    const subBonus = calcBonus(`stat-${subLabel.toLowerCase()}`);
    const dexBonus = calcBonus('stat-dex');

    const bInfo = document.getElementById('active-buff-info');
    if (bInfo) {
      if (buffIds.length > 0) {
        const row = (label: string, bonus: any) => `
          <div class="flex justify-between items-center text-[10px]">
            <span class="text-slate-400 w-10 whitespace-nowrap font-black">${label}:</span>
            <span class="text-purple-300 font-bold">+${bonus.fixed}, +${bonus.ratio}% (+${bonus.bonusFromPct})</span>
          </div>
        `;
        bInfo.innerHTML = `
          <div class="flex justify-between items-center mb-1.5 border-b border-purple-500/20 pb-1">
            <span class="text-[10px] text-purple-200 font-black">도핑 상세보너스</span>
            <span class="text-[9px] bg-purple-500/30 text-purple-100 px-1.5 rounded">${buffIds.length}종</span>
          </div>
          <div class="flex flex-col gap-1">
            ${row(mainLabel, mainBonus)}
            ${row(subLabel, subBonus)}
            ${row('명중', dexBonus)}
          </div>
        `;
        updateBuffTooltipVisibility();
      } else { 
        bInfo.innerHTML = ''; 
        updateBuffTooltipVisibility();
      }
    }

    const applyB = (v: number) => Math.floor((v + bFix) * (1 + bPct / 100));
    const cStats = { 
      stab: applyB(getV('stat-stab')), 
      hack: applyB(getV('stat-hack')), 
      int: applyB(getV('stat-int')), 
      mr: applyB(getV('stat-mr')), 
      dex: applyB(getV('stat-dex')) 
    };

    // Helper: compute row-level coefficient contribution
    const rowCoeff = (bM: number, uM: number, bS: number, uS: number): number => {
      if (['stab', 'hack'].includes(currentType))    return bM*23.75 + uM*32.5  + bS*3.75  + uS*18.75;
      if (['phycomp','maghack'].includes(currentType)) return bM*14.5  + uM*28.75 + bS*14.5  + uS*28.75;
      if (currentType === 'magatk')                  return bM*23.75 + uM*32.5  + bS*2.5   + uS*18.25;
      if (currentType === 'magdef')                  return bM*20.5  + uM*32.5  + bS*2.5   + uS*16.75;
      return 0;
    };
    const fmtC = (v: number) => v > 0 ? v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';

    let gMain = 0, gSub = 0, gHit = 0, uMain = 0, uSub = 0;
    categories.forEach(cat => {
      const s = document.getElementById(`gear-${cat.id}`) as HTMLSelectElement;
      const rcEl = document.getElementById(`row-coeff-${cat.id}`);

      if (s && s.value) {
        const abilS = getV(`abil-${cat.id}-stat`), abilH = getV(`abil-${cat.id}-hit`);
        const iM = getV(`preview-${cat.id}-main`);
        const iS = getV(`preview-${cat.id}-sub`);
        const iH = getV(`preview-${cat.id}-dex`);

        gHit += iH + abilH;
        gMain += iM + abilS; gSub += iS;
        const upgM = getV(`upg-${cat.id}-main`); uMain += upgM;
        const upgS = getV(`upg-${cat.id}-sub`);  uSub  += upgS;

        if (rcEl) {
          const rc = rowCoeff(iM + abilS, upgM, iS, upgS);
          rcEl.textContent = fmtC(rc);
          rcEl.className = rc > 0 ? 'cc lit' : 'cc';
        }
      } else {
        if (rcEl) { rcEl.textContent = '—'; rcEl.className = 'cc'; }
      }
    });

    // Cuff, Relic, Title are purely basic stats
    ['cuff', 'relic'].forEach(k => { 
      gMain += getV(`bonus-${k}-main`); 
      gSub += getV(`bonus-${k}-sub`); 
      gHit += getV(`bonus-${k}-hit`); 
    });
    gMain += getV('bonus-title');
    gSub += getV('bonus-title-sub');
    gHit += getV('bonus-title-hit');

    // Avatar: base stats are fixed at +15 (main/sub/DEX), inputs are upgrade-only
    const avMain = getV('bonus-avatar-main');
    const avSub = getV('bonus-avatar-sub');
    const avHit = getV('bonus-avatar-hit');
    gMain += 15; gSub += 15; gHit += 15;
    uMain += avMain; uSub += avSub; gHit += avHit;

    // Effect: base stats go to gMain/gSub (basic weight), upgrade stats go to uMain/uSub (upgrade weight)
    const efBaseMain = getV('bonus-effect-base-main');
    const efBaseSub = getV('bonus-effect-base-sub');
    const efMain = getV('bonus-effect-main');
    const efSub = getV('bonus-effect-sub');
    const efHit = getV('bonus-effect-hit');
    gMain += efBaseMain; gSub += efBaseSub;
    uMain += efMain; uSub += efSub; gHit += efHit;

    const coreMerc = getV('bonus-core-mercurial');
    const coreAbyss = getV('bonus-core-abyss');
    const coreEclipse = getV('bonus-core-eclipse');
    const coreRubicona = getV('bonus-core-rubicona');
    const coreWeight = ['phycomp', 'maghack'].includes(currentType) ? 28.75 : 32.5;
    const coreCoeffs: Record<string, number> = {
      mercurial: coreMerc * coreWeight,
      abyss: coreAbyss * coreWeight,
      eclipse: coreEclipse * coreWeight,
      rubicona: coreRubicona * coreWeight,
      none: 0
    };

    const selectedCore = (document.getElementById('main-core-select') as HTMLSelectElement)?.value || 'eclipse';
    const selectedCoreVal = selectedCore === 'mercurial' ? coreMerc :
                            selectedCore === 'abyss' ? coreAbyss :
                            selectedCore === 'eclipse' ? coreEclipse :
                            selectedCore === 'rubicona' ? coreRubicona : 0;

    let cMain = 0, cSub = 0;
    if (['stab', 'phycomp'].includes(currentType)) { cMain = cStats.stab; cSub = cStats.hack; }
    else if (currentType === 'hack') { cMain = cStats.hack; cSub = cStats.stab; }
    else if (currentType === 'magatk') { cMain = cStats.int; cSub = cStats.mr; }
    else if (currentType === 'maghack') { cMain = cStats.hack; cSub = cStats.int; }
    else if (currentType === 'magdef') { cMain = cStats.mr; cSub = cStats.int; }

    const fHit = cStats.dex + gHit;

    const setT = (id: string, v: string) => { 
      const el = document.getElementById(id); 
      if (el) el.innerText = v; 
    };

    // Per-row bonus coefficients
    setT('row-coeff-avatar', fmtC(rowCoeff(15, avMain, 15, avSub)));
    setT('row-coeff-cuff', fmtC(rowCoeff(getV('bonus-cuff-main'), 0, getV('bonus-cuff-sub'), 0)));
    setT('row-coeff-effect', fmtC(rowCoeff(efBaseMain, efMain, efBaseSub, efSub)));
    setT('row-coeff-relic', fmtC(rowCoeff(getV('bonus-relic-main'), 0, getV('bonus-relic-sub'), 0)));
    setT('row-coeff-title', fmtC(rowCoeff(getV('bonus-title'), 0, getV('bonus-title-sub'), 0)));

    // Core row
    const selectedCoreCoeff = coreCoeffs[selectedCore] || 0;
    setT('row-coeff-core', selectedCoreCoeff > 0 ? selectedCoreCoeff.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) : '—');

    let coeff = 0;
    if (currentType === 'stab')    coeff = (gMain*23.75)+(uMain*32.5)+(gSub*3.75) +(uSub*18.75)+(cStats.stab*2.1)+(cStats.hack*1.08);
    else if (currentType === 'hack')    coeff = (gMain*23.75)+(uMain*32.5)+(gSub*3.75) +(uSub*18.75)+(cStats.hack*2.1)+(cStats.stab*1.08);
    else if (currentType === 'phycomp') coeff = (gMain*14.5) +(uMain*28.75)+(gSub*14.5)+(uSub*28.75)+(cStats.stab*1.8)+(cStats.hack*1.8);
    else if (currentType === 'magatk')  coeff = (gMain*23.75)+(uMain*32.5)+(gSub*2.5) +(uSub*18.25)+(cStats.int*2.4)+(cStats.mr*0.6);
    else if (currentType === 'maghack') coeff = (gMain*14.5) +(uMain*28.75)+(gSub*14.5)+(uSub*28.75)+(cStats.hack*1.8)+(cStats.int*1.8);
    else if (currentType === 'magdef')  coeff = (gMain*20.5) +(uMain*32.5)+(gSub*2.5) +(uSub*16.75)+(cStats.mr*2.55)+(cStats.int*0.45);

    const totalCoeff = coeff + selectedCoreCoeff;
    const coeffStr = totalCoeff.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const equipmentMain = gMain + uMain + selectedCoreVal;
    setT('total-coefficient', coeffStr);
    setT('total-coefficient-table', coeffStr);
    setT('character-main-stat-display', Math.floor(cMain).toLocaleString());
    setT('equipment-main-stat-display', Math.floor(equipmentMain).toLocaleString());
    setT('total-hit-display', Math.floor(fHit).toString());
    updateGuide(coeff, fHit, coreCoeffs);
  } catch (err) {
    console.error('Calculation Error:', err);
  }
}

function updateGuide(baseCoeff: number, hit: number, coreCoeffs: Record<string, number>) {
  const container = document.getElementById('content-guide'); if (!container) return;
  container.innerHTML = '';
  const contents = [
    { name: '최후의 결전', hit: 2500, target: 95000, coreType: 'eclipse', calc: (c: number) => c <= 90000 ? '불가능' : c <= 93000 ? '힘듬' : c <= 95000 ? '가능' : '원활' },
    { name: '골고다 부대장', hit: 2450, target: 0, coreType: 'eclipse', calc: (_c: number) => '원활' },
    { name: '아페테리아 (어려움)', hit: 2400, target: 72500, coreType: 'eclipse', calc: (c: number) => c <= 67500 ? '불가능' : c <= 70000 ? '힘듬' : c <= 72500 ? '가능' : '원활' },
    { name: '오딘 전면전', hit: 1350, target: 51000, coreType: 'none', calc: (c: number) => c <= 47000 ? '불가능' : c <= 49500 ? '힘듬' : c <= 51000 ? '가능' : '원활' },
    { name: '이클립스 토벌전', hit: 2300, target: 72500, coreType: 'eclipse', calc: (c: number) => c <= 67500 ? '불가능' : c <= 70000 ? '힘듬' : c <= 72500 ? '가능' : '원활' },
    { name: '오를리방어전 (지옥)', hit: 2200, target: 0, coreType: 'none', calc: (_c: number) => '원활' },
    { name: '아페테리아 (일반)', hit: 2200, target: 0, coreType: 'eclipse', calc: (_c: number) => '원활' },
    { name: '베스티지', hit: 1800, target: 0, coreType: 'none', calc: (_c: number) => '원활' },
    { name: '이클립스 6보스', hit: 1650, target: 55000, coreType: 'eclipse', calc: (c: number) => c <= 45000 ? '불가능' : c <= 52500 ? '힘듬' : c <= 55000 ? '가능' : '원활' },
    { name: '어비스 (지옥)', hit: 1350, target: 0, coreType: 'abyss', calc: (_c: number) => '원활' },
    { name: '신조 (어려움)', hit: 1300, target: 0, coreType: 'none', calc: (_c: number) => '원활' },
    { name: '어비스 (어려움)', hit: 800, target: 0, coreType: 'abyss', calc: (_c: number) => '원활' },
    { name: '어비스 (일반)', hit: 800, target: 0, coreType: 'abyss', calc: (_c: number) => '원활' },
    { name: '신조 (일반)', hit: 800, target: 0, coreType: 'none', calc: (_c: number) => '원활' },
    { name: '머큐리얼/루미너스', hit: 800, target: 0, coreType: 'mercurial', calc: (_c: number) => '원활' }
  ];
  contents.forEach(ct => {
    const coreCoeff = coreCoeffs[ct.coreType as keyof typeof coreCoeffs] || 0;
    const cur = baseCoeff + coreCoeff;
    const status = ct.target === 0 ? '정보부족' : ct.calc(cur), hitOk = hit >= ct.hit;
    const pct = ct.target > 0 ? Math.min(100, Math.floor((cur / ct.target) * 100)) : 0;
    
    let color = 'text-slate-400';
    let dotColor = 'bg-slate-500';
    let barColor = 'bg-slate-700';

    if (status === '원활') {
      color = 'text-emerald-400';
      dotColor = 'bg-emerald-400';
      barColor = 'bg-emerald-500';
    } else if (status === '가능') {
      color = 'text-yellow-400';
      dotColor = 'bg-yellow-400';
      barColor = 'bg-yellow-500';
    } else if (status === '힘듬') {
      color = 'text-orange-400';
      dotColor = 'bg-orange-400';
      barColor = 'bg-orange-500';
    } else if (status === '불가능') {
      color = 'text-red-400';
      dotColor = 'bg-red-400';
      barColor = 'bg-red-500';
    }

    const div = document.createElement('div');
    div.className = 'bg-slate-950/40 p-2.5 rounded-xl border border-slate-800/40 flex flex-col gap-1.5 transition-all hover:bg-slate-950/60 hover:border-slate-800/70';
    
    const targetText = ct.target > 0 ? ct.target.toLocaleString() : '미정';
    const curValText = cur.toLocaleString(undefined, { maximumFractionDigits: 0 });
    const pctText = ct.target > 0 ? `${pct}%` : '-';
    
    let progressSection = '';
    if (ct.target > 0) {
      progressSection = `
        <div class="space-y-1">
          <div class="flex justify-between items-center text-[10px] text-slate-400 font-bold leading-none">
            <span>계수: <span class="text-slate-200">${curValText}</span> / ${targetText}</span>
            <span class="${color}">${pctText}</span>
          </div>
          <div class="w-full bg-slate-900 rounded-full h-1 overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300 ${barColor}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    } else {
      progressSection = `
        <div class="flex justify-between items-center text-[10px] text-slate-500 font-bold leading-none">
          <span>계수: <span class="text-slate-300">${curValText}</span></span>
          <span class="text-slate-500/80">목표 정보 없음</span>
        </div>
      `;
    }

    div.innerHTML = `
      <div class="flex justify-between items-center leading-none">
        <span class="text-slate-200 text-[11.5px] font-black truncate max-w-[170px]" title="${ct.name}">${ct.name}</span>
        <div class="flex items-center gap-1.5">
          <span class="${hitOk ? 'text-green-400' : 'text-red-400'} text-[10px] font-black">명중 ${ct.hit} ${hitOk ? '✔' : '✘'}</span>
          <span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>
          <span class="${color} text-[10.5px] font-black">${status}</span>
        </div>
      </div>
      ${progressSection}
    `;
    container.appendChild(div);
  });
}

function showModal(t: string, m: string, i = false, d = ''): Promise<string | boolean> {
  return new Promise(res => {
    const o = document.getElementById('modal-overlay'), ti = document.getElementById('modal-title'), ms = document.getElementById('modal-message'), inp = document.getElementById('modal-input') as HTMLInputElement, c = document.getElementById('modal-confirm'), ca = document.getElementById('modal-cancel');
    if (!o || !ti || !ms || !inp || !c || !ca) return res(false);
    ti.innerText = t; ms.innerText = m; if (i) { inp.classList.remove('hidden'); inp.value = d; inp.focus(); } else inp.classList.add('hidden');
    o.classList.remove('hidden');
    const cl = () => { o.classList.add('hidden'); c.removeEventListener('click', ok); ca.removeEventListener('click', no); };
    const ok = () => { cl(); res(i ? inp.value : true); }; const no = () => { cl(); res(false); };
    c.addEventListener('click', ok); ca.addEventListener('click', no);
  });
}
const showPrompt = (t: string, m: string, d = '') => showModal(t, m, true, d).then(r => typeof r === 'string' ? r : null);
const showConfirm = (t: string, m: string) => showModal(t, m).then(r => !!r);
const showAlert = (t: string, m: string) => { const ca = document.getElementById('modal-cancel'); if (ca) ca.classList.add('hidden'); return showModal(t, m).then(() => ca?.classList.remove('hidden')); };

function initProfiles() {
  try {
    const s = localStorage.getItem(PROFILES_KEY), last = localStorage.getItem(PROFILES_KEY + '_last');
    let loaded = false;
    if (s) {
      try {
        profiles = JSON.parse(s);
        currentProfileId = last && profiles[last] ? last : Object.keys(profiles)[0];
        loaded = true;
      } catch (e) {
        console.error('Failed to parse profiles from storage', e);
      }
    }
    if (!loaded) {
      const d = localStorage.getItem(SAVE_KEY);
      let parsedData = null;
      if (d) {
        try {
          parsedData = JSON.parse(d);
        } catch (e) {
          console.error('Failed to parse legacy save data', e);
        }
      }
      profiles = { 'default': { id: 'default', name: '기본 프로필', data: parsedData } };
      currentProfileId = 'default';
    }
    renderProfileSelect(); 
    loadProfileData(currentProfileId);
  } catch (err) {
    console.error('Profile Init Failed:', err);
  }
}
function renderProfileSelect(): void {
  const select = document.getElementById('profile-select') as HTMLSelectElement | null;
  if (!select) return;
  const options = Object.values(profiles).map(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.selected = profile.id === currentProfileId;
    option.textContent = profile.name;
    return option;
  });
  select.replaceChildren(...options);
}
function addProfile(n: string) { const id = 'p' + Date.now(); profiles[id] = { id, name: n, data: captureCurrentData() }; saveProfilesToStorage(); switchProfile(id); }
function renameProfile(id: string, n: string) { if (profiles[id]) { profiles[id].name = n; saveProfilesToStorage(); renderProfileSelect(); } }
function deleteProfile(id: string) { delete profiles[id]; saveProfilesToStorage(); switchProfile(Object.keys(profiles)[0]); }
function switchProfile(id: string) { if (!profiles[id]) return; saveCurrentProfile(); currentProfileId = id; localStorage.setItem(PROFILES_KEY + '_last', id); loadProfileData(id); renderProfileSelect(); calculate(); }
function saveCurrentProfile() { if (profiles[currentProfileId]) { profiles[currentProfileId].data = captureCurrentData(); saveProfilesToStorage(); } }
function saveProfilesToStorage() { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); localStorage.setItem(PROFILES_KEY + '_last', currentProfileId); }

function captureCurrentData() {
  const d: any = { 
    stats: {}, bonuses: {}, gears: {}, upgradesMain: {}, upgradesSub: {}, 
    abilsStat: {}, abilsHit: {}, currentType, 
    buffPreset: (document.getElementById('buff-preset-select') as HTMLSelectElement)?.value, 
    mainCore: (document.getElementById('main-core-select') as HTMLSelectElement)?.value || 'eclipse' 
  };
  
  ['stab', 'hack', 'int', 'mr', 'dex'].forEach(k => {
    const el = document.getElementById(`stat-${k}`) as HTMLInputElement;
    if (el) d.stats[k] = el.value;
  });
  
  ['avatar', 'cuff', 'effect', 'relic'].forEach(k => { 
    d.bonuses[`${k}Main`] = (document.getElementById(`bonus-${k}-main`) as HTMLInputElement)?.value; 
    d.bonuses[`${k}Sub`] = (document.getElementById(`bonus-${k}-sub`) as HTMLInputElement)?.value; 
    d.bonuses[`${k}Hit`] = (document.getElementById(`bonus-${k}-hit`) as HTMLInputElement)?.value; 
  });
  
  d.bonuses.title = (document.getElementById('bonus-title') as HTMLInputElement)?.value;
  d.bonuses.titleSub = (document.getElementById('bonus-title-sub') as HTMLInputElement)?.value;
  d.bonuses.titleHit = (document.getElementById('bonus-title-hit') as HTMLInputElement)?.value;
  d.bonuses.effectBaseMain = (document.getElementById('bonus-effect-base-main') as HTMLInputElement)?.value;
  d.bonuses.effectBaseSub = (document.getElementById('bonus-effect-base-sub') as HTMLInputElement)?.value;
  d.bonuses.coreMercurial = (document.getElementById('bonus-core-mercurial') as HTMLInputElement)?.value;
  d.bonuses.coreAbyss = (document.getElementById('bonus-core-abyss') as HTMLInputElement)?.value;
  d.bonuses.coreEclipse = (document.getElementById('bonus-core-eclipse') as HTMLInputElement)?.value;
  d.bonuses.coreRubicona = (document.getElementById('bonus-core-rubicona') as HTMLInputElement)?.value;
  
  const d2 = d as any;
  d2.basesMain = {}; d2.basesSub = {}; d2.basesDex = {};
  categories.forEach(cat => {
    d.gears[cat.id] = (document.getElementById(`gear-${cat.id}`) as HTMLSelectElement)?.value;
    d.upgradesMain[cat.id] = (document.getElementById(`upg-${cat.id}-main`) as HTMLInputElement)?.value;
    d.upgradesSub[cat.id] = (document.getElementById(`upg-${cat.id}-sub`) as HTMLInputElement)?.value;
    d.abilsStat[cat.id] = (document.getElementById(`abil-${cat.id}-stat`) as HTMLInputElement)?.value;
    d.abilsHit[cat.id] = (document.getElementById(`abil-${cat.id}-hit`) as HTMLInputElement)?.value;
    d2.basesMain[cat.id] = (document.getElementById(`preview-${cat.id}-main`) as HTMLInputElement)?.value;
    d2.basesSub[cat.id] = (document.getElementById(`preview-${cat.id}-sub`) as HTMLInputElement)?.value;
    d2.basesDex[cat.id] = (document.getElementById(`preview-${cat.id}-dex`) as HTMLInputElement)?.value;
  });
  
  return d;
}

function loadProfileData(id: string) {
  isLoadingProfile = true;
  try {
    const p = profiles[id]; if (!p?.data) return; const d = p.data;
    
    if (d.stats) Object.keys(d.stats).forEach(k => { 
      const el = document.getElementById(`stat-${k}`) as HTMLInputElement; 
      if (el) el.value = d.stats[k] || ''; 
    });
    
    // Reset all bonus inputs to HTML defaults to prevent state leakage
    document.querySelectorAll('input[id^="bonus-"]').forEach(el => {
      const input = el as HTMLInputElement;
      input.value = input.getAttribute('value') || '';
    });

    if (d.bonuses) {
      Object.keys(d.bonuses).forEach(k => {
        let keyId = k;
        if (k === 'core') keyId = 'coreEclipse';
        const id = `bonus-${keyId.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`;
        const el = document.getElementById(id) as HTMLInputElement;
        if (el) el.value = d.bonuses[k] || '';
      });
    }
    
    categories.forEach(cat => {
      const selectEl = document.getElementById(`gear-${cat.id}`) as HTMLSelectElement;
      if (selectEl) {
        selectEl.querySelectorAll('option[data-dynamic="true"]').forEach(opt => opt.remove());

        let val = (d.gears && d.gears[cat.id]) || '';
        if (val) {
          let exists = false;
          let valName = '';
          try { valName = JSON.parse(val).name || ''; } catch (e) {}

          for (let i = 0; i < selectEl.options.length; i++) {
            const optVal = selectEl.options[i].value;
            if (optVal === val) { exists = true; break; }
            if (valName) {
              try {
                const optParsed = JSON.parse(optVal);
                if (optParsed && optParsed.name === valName) {
                  exists = true; val = optVal; break;
                }
              } catch (e) {}
            }
          }
          if (!exists) {
            try {
              const parsed = JSON.parse(val);
              if (parsed && parsed.name) {
                const opt = document.createElement('option');
                opt.value = val;
                opt.innerText = parsed.name;
                opt.setAttribute('data-dynamic', 'true');
                selectEl.appendChild(opt);
                addDynamicCustomOption(cat.id, parsed, val);
              }
            } catch (err) {}
          }
        }
        selectEl.value = val;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      
      const setInp = (id: string, val: any) => {
        const el = document.getElementById(id) as HTMLInputElement;
        if (el) el.value = val || '';
      };
      
      setInp(`upg-${cat.id}-main`, d.upgradesMain ? d.upgradesMain[cat.id] : '');
      setInp(`upg-${cat.id}-sub`, d.upgradesSub ? d.upgradesSub[cat.id] : '');
      setInp(`abil-${cat.id}-stat`, d.abilsStat ? d.abilsStat[cat.id] : '');
      setInp(`abil-${cat.id}-hit`, d.abilsHit ? d.abilsHit[cat.id] : '');
      const dd = d as any;
      if (dd.basesMain?.[cat.id]) setInp(`preview-${cat.id}-main`, dd.basesMain[cat.id]);
      if (dd.basesSub?.[cat.id]) setInp(`preview-${cat.id}-sub`, dd.basesSub[cat.id]);
      if (dd.basesDex?.[cat.id]) setInp(`preview-${cat.id}-dex`, dd.basesDex[cat.id]);
    });
    
    if (d.buffPreset) {
      const el = document.getElementById('buff-preset-select') as HTMLSelectElement;
      if (el) el.value = d.buffPreset;
    }
    
    const coreEl = document.getElementById('main-core-select') as HTMLSelectElement;
    if (coreEl) coreEl.value = d.mainCore || 'eclipse';
    
    if (d.currentType) { 
      currentType = d.currentType; 
      document.querySelectorAll('.tab-btn').forEach(b => { 
        if ((b as HTMLElement).dataset.type === currentType) b.classList.add('active'); 
        else b.classList.remove('active'); 
      }); 
      updateLabels(); 
    }
  } catch (err) {
    console.error('Load Profile Failed:', err);
  } finally {
    isLoadingProfile = false;
  }
}

function updateLabels() {
  const [m, s] = statNames[currentType] || ['STAB', 'HACK'];
  // Update all label spans (table column headers + any remaining)
  document.querySelectorAll('.bonus-label-main, .bonus-label-main2, .bonus-label-main3').forEach(el => (el as HTMLElement).innerText = m);
  document.querySelectorAll('.bonus-label-sub, .bonus-label-sub2').forEach(el => (el as HTMLElement).innerText = s);
  // Placeholders for gear inputs
  categories.forEach(cat => {
    const um = document.getElementById(`upg-${cat.id}-main`) as HTMLInputElement;
    const us = document.getElementById(`upg-${cat.id}-sub`)  as HTMLInputElement;
    const am = document.getElementById(`abil-${cat.id}-stat`) as HTMLInputElement;
    if (um) um.placeholder = m; if (us) us.placeholder = s; if (am) am.placeholder = m;
  });
  // Refresh gear preview inputs for the new mode
  categories.forEach(cat => {
    const s = document.getElementById(`gear-${cat.id}`) as HTMLSelectElement;
    if (!s || !s.value) return;
    let item: any = null;
    try { item = JSON.parse(s.value); } catch(e) {}
    if (!item) return;
    let iM = 0, iS = 0;
    if (['stab', 'phycomp'].includes(currentType)) { iM = item.stab || 0; iS = item.hack || 0; }
    else if (currentType === 'hack')   { iM = item.hack || 0;    iS = item.stab || 0; }
    else if (currentType === 'magatk') { iM = item.mag_atk || 0; iS = item.mag_def || 0; }
    else if (currentType === 'maghack'){ iM = item.hack || 0;    iS = item.mag_atk || 0; }
    else if (currentType === 'magdef') { iM = item.mag_def || 0; iS = item.mag_atk || 0; }
    const iH = item.hit || 0;
    const pmEl = document.getElementById(`preview-${cat.id}-main`) as HTMLInputElement;
    const psEl = document.getElementById(`preview-${cat.id}-sub`) as HTMLInputElement;
    const pdEl = document.getElementById(`preview-${cat.id}-dex`) as HTMLInputElement;
    if (pmEl) pmEl.value = iM > 0 ? String(iM) : '';
    if (psEl) psEl.value = iS > 0 ? String(iS) : '';
    if (pdEl) pdEl.value = iH > 0 ? String(iH) : '';
  });

  // Series badge
  const sn = document.getElementById('current-series-name');
  const ab = document.querySelector(`.tab-btn[data-type="${currentType}"]`);
  if (sn && ab) sn.innerText = (ab as HTMLElement).textContent || '';
  // Formula
  const f = document.getElementById('sum-formula');
  if (f) {
    let ft = '';
    if (['stab','hack'].includes(currentType))      ft = `장비(${m}×23.75+${s}×3.75)+강화(${m}×32.5+${s}×18.75)+캐릭터(${m}×2.1+${s}×1.08)+코어×32.5`;
    else if (['phycomp','maghack'].includes(currentType)) ft = `장비(${m}×14.5+${s}×14.5)+강화(${m}×28.75+${s}×28.75)+캐릭터(${m}×1.8+${s}×1.8)+코어×28.75`;
    else if (currentType === 'magatk')             ft = `장비(${m}×23.75+${s}×2.5)+강화(${m}×32.5+${s}×18.25)+캐릭터(${m}×2.4+${s}×0.6)+코어×32.5`;
    else if (currentType === 'magdef')             ft = `장비(${m}×20.5+${s}×2.5)+강화(${m}×32.5+${s}×16.75)+캐릭터(${m}×2.55+${s}×0.45)+코어×32.5`;
    f.innerText = ft; f.title = ft;
  }
}

function buildGearSelectHtml(cat: any): string {
  let html = '<option value="">장착 안함</option>';
  const d = gearData[cat.source];
  if (!d) return html;
  if (cat.isNested) {
    Object.keys(d).forEach(sc => {
      html += `<optgroup label="${sc}">`;
      (d[sc] as any[]).forEach(i => { html += `<option value='${JSON.stringify(i).replace(/'/g,"&apos;")}'>${i.name}</option>`; });
      html += '</optgroup>';
    });
  } else {
    (d[cat.key || ''] as any[] || []).forEach(i => { html += `<option value='${JSON.stringify(i).replace(/'/g,"&apos;")}'>${i.name}</option>`; });
  }
  return html;
}

const CAT_NAMES: Record<string,string> = {
  helm:'투구', armor:'갑옷', weapon:'무기', wrist:'손목',
  amulet:'머리', wing:'몸', gauntlet:'손', boots:'다리', artifact:'아티팩트'
};

function renderEquipmentOptions() {
  const tbody = document.getElementById('gear-tbody'); if (!tbody) return;
  tbody.innerHTML = '';
  categories.forEach(cat => {
    const isWeapon = cat.id === 'weapon';
    const tr = document.createElement('tr');
    tr.className = 'tr-gear';
    tr.innerHTML = `
      <td><span class="part-lbl${isWeapon?' weapon':''}">${CAT_NAMES[cat.id]||cat.id}</span></td>
      <td class="px-1 relative">
        <select id="gear-${cat.id}" class="gs hidden">${buildGearSelectHtml(cat)}</select>
        
        <!-- Custom Dropdown wrapper -->
        <div class="custom-dropdown" id="dropdown-wrapper-${cat.id}">
          <button type="button" class="custom-dropdown-trigger" id="dropdown-trigger-${cat.id}">
            <div class="flex items-center gap-1.5 truncate">
              <img class="selected-img w-5 h-5 object-contain hidden" id="dropdown-selected-img-${cat.id}" src="">
              <span class="selected-name truncate text-slate-100" id="dropdown-selected-name-${cat.id}">장착 안함</span>
            </div>
            <i data-lucide="chevron-down" class="w-3.5 h-3.5 opacity-60 flex-shrink-0"></i>
          </button>
          
          <div class="custom-dropdown-menu hidden" id="dropdown-menu-${cat.id}">
            <div class="custom-dropdown-search-wrapper">
              <input type="text" class="custom-dropdown-search no-drag" id="dropdown-search-${cat.id}" placeholder="검색 (초성 지원)...">
            </div>
            <div class="custom-dropdown-options custom-scroll" id="dropdown-options-${cat.id}">
              <!-- Dynamic options list -->
            </div>
          </div>
        </div>
      </td>
      <td class="px-1"><input type="number" id="preview-${cat.id}-main" class="ci bas" placeholder="0"></td>
      <td class="px-1"><input type="number" id="preview-${cat.id}-sub"  class="ci bas" placeholder="0"></td>
      <td class="px-1"><input type="number" id="preview-${cat.id}-dex"  class="ci dex" placeholder="0"></td>
      <td class="px-1"><input type="number" id="upg-${cat.id}-main"  class="ci upg"  placeholder="0"></td>
      <td class="px-1"><input type="number" id="upg-${cat.id}-sub"   class="ci upg"  placeholder="0"></td>
      <td class="px-1"><input type="number" id="abil-${cat.id}-stat" class="ci abil" placeholder="0"></td>
      <td class="px-1"><input type="number" id="abil-${cat.id}-hit"  class="ci dex"  placeholder="0"></td>
      <td class="cc" id="row-coeff-${cat.id}">—</td>
    `;
    tbody.appendChild(tr);
  });

  initCustomDropdowns();
  initGearPreviewFill();
}

function initGearPreviewFill() {
  categories.forEach(cat => {
    const selectEl = document.getElementById(`gear-${cat.id}`) as HTMLSelectElement;
    if (!selectEl) return;
    selectEl.addEventListener('change', () => {
      const val = selectEl.value;
      const pmEl = document.getElementById(`preview-${cat.id}-main`) as HTMLInputElement;
      const psEl = document.getElementById(`preview-${cat.id}-sub`) as HTMLInputElement;
      const pdEl = document.getElementById(`preview-${cat.id}-dex`) as HTMLInputElement;
      if (!val) {
        if (pmEl) pmEl.value = '';
        if (psEl) psEl.value = '';
        if (pdEl) pdEl.value = '';
        return;
      }
      let item: any = null;
      try { item = JSON.parse(val); } catch(e) {}
      if (!item) return;
      let iM = 0, iS = 0;
      if (['stab', 'phycomp'].includes(currentType)) { iM = item.stab || 0; iS = item.hack || 0; }
      else if (currentType === 'hack')   { iM = item.hack || 0;    iS = item.stab || 0; }
      else if (currentType === 'magatk') { iM = item.mag_atk || 0; iS = item.mag_def || 0; }
      else if (currentType === 'maghack'){ iM = item.hack || 0;    iS = item.mag_atk || 0; }
      else if (currentType === 'magdef') { iM = item.mag_def || 0; iS = item.mag_atk || 0; }
      const iH = item.hit || 0;
      if (pmEl) pmEl.value = iM > 0 ? String(iM) : '';
      if (psEl) psEl.value = iS > 0 ? String(iS) : '';
      if (pdEl) pdEl.value = iH > 0 ? String(iH) : '';
    });
  });
}

function applyEquipmentFromDic(item: any) {
  let partId = '';
  if (item.group === '무기') {
    partId = 'weapon';
  } else if (item.group === '갑옷') {
    partId = 'armor';
  } else if (item.group === '손목') {
    partId = 'wrist';
  } else if (item.group === '아티팩트') {
    partId = 'artifact';
  } else if (item.part) {
    partId = item.part;
  }

  if (!partId) return;

  const selectEl = document.getElementById(`gear-${partId}`) as HTMLSelectElement;
  if (!selectEl) return;

  let foundOptionValue = '';
  for (let i = 0; i < selectEl.options.length; i++) {
    const opt = selectEl.options[i];
    if (opt.text === item.name) {
      foundOptionValue = opt.value;
      break;
    }
  }

  if (!foundOptionValue) {
    // Dynamically insert missing equipment options
    const parsedItem = {
      name: item.name,
      series: getSeries(item.name),
      part: item.part || '',
      image: item.image || '',
      stab: parseMaxStat(item.stats?.stab),
      hack: parseMaxStat(item.stats?.hack),
      def: parseMaxStat(item.stats?.def),
      mag_atk: parseMaxStat(item.stats?.mag_atk),
      mag_def: parseMaxStat(item.stats?.mag_def),
      hit: parseMaxStat(item.stats?.hit),
      eva: parseMaxStat(item.stats?.eva),
      agi: parseMaxStat(item.stats?.agi),
      cri: parseMaxStat(item.stats?.cri),
      delay: item.delay || ''
    };

    const opt = document.createElement('option');
    opt.value = JSON.stringify(parsedItem);
    opt.innerText = parsedItem.name;
    selectEl.appendChild(opt);
    foundOptionValue = opt.value;

    // 커스텀 옵션 목록에도 동적 추가 반영
    addDynamicCustomOption(partId, parsedItem, foundOptionValue);
  }

  selectEl.value = foundOptionValue;
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildAllCustomOptionsHtml(cat: any): string {
  let html = '';
  
  // "장착 안함" option
  html += `
    <button type="button" class="custom-dropdown-option selected" data-value="" data-name="장착 안함" data-category="">
      <span class="w-5 h-5 flex items-center justify-center text-slate-600 font-bold">—</span>
      <span>장착 안함</span>
    </button>
  `;

  const d = gearData[cat.source];
  if (!d) return html;

  const getOptionHtml = (i: any, sc: string) => {
    const stringifiedVal = JSON.stringify(i).replace(/'/g, "&apos;");
    const imgHtml = i.image 
      ? `<img src="assets/img/equipment/${i.image}" class="w-5 h-5 object-contain flex-shrink-0" onerror="this.style.display='none'">`
      : `<span class="w-5 h-5 flex items-center justify-center text-slate-600 border border-slate-800 rounded bg-slate-950/50">?</span>`;
    return `
      <button type="button" class="custom-dropdown-option" data-value='${stringifiedVal}' data-name="${i.name.replace(/"/g, '&quot;')}" data-category="${sc.replace(/"/g, '&quot;')}">
        ${imgHtml}
        <span class="truncate">${i.name}</span>
      </button>
    `;
  };

  if (cat.isNested) {
    Object.keys(d).forEach(sc => {
      html += `<div class="custom-dropdown-optgroup" data-group="${sc.replace(/"/g, '&quot;')}">${sc}</div>`;
      (d[sc] as any[] || []).forEach(i => {
        html += getOptionHtml(i, sc);
      });
    });
  } else {
    const sc = cat.key || '';
    (d[sc] as any[] || []).forEach(i => {
      html += getOptionHtml(i, sc);
    });
  }
  return html;
}

function filterCustomOptions(cat: any, filterText: string) {
  const optionsContainer = document.getElementById(`dropdown-options-${cat.id}`);
  if (!optionsContainer) return;

  const query = filterText.trim();
  const options = optionsContainer.querySelectorAll('.custom-dropdown-option');
  const groups = optionsContainer.querySelectorAll('.custom-dropdown-optgroup');
  const groupMatchCounts: Record<string, number> = {};

  options.forEach(opt => {
    const btn = opt as HTMLElement;
    const name = btn.dataset.name || '';
    const category = btn.dataset.category || '';
    
    if (btn.dataset.value === '') {
      if (!query || name.includes(query)) {
        btn.classList.remove('hidden');
      } else {
        btn.classList.add('hidden');
      }
      return;
    }

    const isMatch = matchesCalcSearch(name, category, query);
    if (isMatch) {
      btn.classList.remove('hidden');
      if (category) {
        groupMatchCounts[category] = (groupMatchCounts[category] || 0) + 1;
      }
    } else {
      btn.classList.add('hidden');
    }
  });

  groups.forEach(grp => {
    const div = grp as HTMLElement;
    const groupName = div.dataset.group || '';
    const count = groupMatchCounts[groupName] || 0;
    if (count > 0) {
      div.classList.remove('hidden');
    } else {
      div.classList.add('hidden');
    }
  });
}

function syncSelectedOptionClass(cat: any, selectedValue: string) {
  const optionsContainer = document.getElementById(`dropdown-options-${cat.id}`);
  if (!optionsContainer) return;

  let selectedNameStr = '';
  if (selectedValue) {
    try {
      const parsed = JSON.parse(selectedValue);
      selectedNameStr = parsed.name || '';
    } catch (e) {}
  }

  const options = optionsContainer.querySelectorAll('.custom-dropdown-option');
  options.forEach(opt => {
    const btn = opt as HTMLElement;
    if (btn.dataset.value === '') {
      if (!selectedValue) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    } else {
      const name = btn.dataset.name || '';
      if (selectedNameStr && name === selectedNameStr) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    }
  });
}

function addDynamicCustomOption(partId: string, item: any, stringifiedVal: string) {
  const optionsContainer = document.getElementById(`dropdown-options-${partId}`);
  if (!optionsContainer) return;

  const options = optionsContainer.querySelectorAll('.custom-dropdown-option');
  const exists = Array.from(options).some(opt => (opt as HTMLElement).dataset.name === item.name);
  if (exists) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-dropdown-option';
  btn.dataset.value = stringifiedVal;
  btn.dataset.name = item.name;
  btn.dataset.category = '';
  
  const imgHtml = item.image 
    ? `<img src="assets/img/equipment/${item.image}" class="w-5 h-5 object-contain flex-shrink-0" onerror="this.style.display='none'">`
    : `<span class="w-5 h-5 flex items-center justify-center text-slate-600 border border-slate-800 rounded bg-slate-950/50">?</span>`;
  btn.innerHTML = `
    ${imgHtml}
    <span class="truncate">${item.name}</span>
  `;

  const selectEl = document.getElementById(`gear-${partId}`) as HTMLSelectElement;
  const menu = document.getElementById(`dropdown-menu-${partId}`);
  btn.addEventListener('click', () => {
    if (selectEl) {
      selectEl.value = stringifiedVal;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (menu) menu.classList.add('hidden');
  });

  optionsContainer.appendChild(btn);
}

function initCustomDropdowns() {
  categories.forEach(cat => {
    const selectEl = document.getElementById(`gear-${cat.id}`) as HTMLSelectElement;
    const wrapper = document.getElementById(`dropdown-wrapper-${cat.id}`);
    const trigger = document.getElementById(`dropdown-trigger-${cat.id}`);
    const menu = document.getElementById(`dropdown-menu-${cat.id}`);
    const search = document.getElementById(`dropdown-search-${cat.id}`) as HTMLInputElement;
    const optionsContainer = document.getElementById(`dropdown-options-${cat.id}`);

    if (!selectEl || !trigger || !menu || !search || !optionsContainer) return;

    // 1. 최초 전체 옵션 빌드 및 삽입
    optionsContainer.innerHTML = buildAllCustomOptionsHtml(cat);

    // Sync from native select to custom trigger UI
    const syncUI = () => {
      const val = selectEl.value;
      const selectedImg = document.getElementById(`dropdown-selected-img-${cat.id}`) as HTMLImageElement;
      const selectedName = document.getElementById(`dropdown-selected-name-${cat.id}`);

      if (!val) {
        if (selectedImg) selectedImg.classList.add('hidden');
        if (selectedName) selectedName.innerText = '장착 안함';
      } else {
        try {
          const item = JSON.parse(val);
          if (selectedImg) {
            if (item.image) {
              selectedImg.src = `assets/img/equipment/${item.image}`;
              selectedImg.classList.remove('hidden');
            } else {
              selectedImg.classList.add('hidden');
            }
          }
          if (selectedName) selectedName.innerText = item.name;
        } catch (e) {
          if (selectedImg) selectedImg.classList.add('hidden');
          if (selectedName) selectedName.innerText = '장착 안함';
        }
      }

      // 커스텀 옵션 목록의 selected 클래스 싱크
      syncSelectedOptionClass(cat, val);
    };

    // Bind option click events (최초 1회 등록)
    const bindOptionClicks = () => {
      optionsContainer.querySelectorAll('.custom-dropdown-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const val = (e.currentTarget as HTMLElement).dataset.value || '';
          selectEl.value = val;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          menu.classList.add('hidden');
        });
      });
    };
    bindOptionClicks();

    // Listen to native select value changes (e.g. profiles loaded, dic items sent)
    selectEl.addEventListener('change', () => {
      syncUI();
    });

    // Toggle menu
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = menu.classList.contains('hidden');
      
      // Close all other menus first
      document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
      
      if (isHidden) {
        menu.classList.remove('hidden');
        search.value = '';
        
        // 검색 필터 및 selected 상태 갱신
        filterCustomOptions(cat, '');
        syncSelectedOptionClass(cat, selectEl.value);
        
        setTimeout(() => search.focus(), 30);
      }
    });

    // Filter search input
    search.addEventListener('input', (e) => {
      const filter = (e.target as HTMLInputElement).value;
      filterCustomOptions(cat, filter);
    });

    // Initial sync
    syncUI();
  });

  // Global click to close (registered once)
  if (!isGlobalClickRegistered) {
    document.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.custom-dropdown')) {
        document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.add('hidden'));
      }
    });
    isGlobalClickRegistered = true;
  }

  // Re-generate Lucide icons for arrow chevrons
  if ((window as any).lucide) (window as any).lucide.createIcons();
}

window.addEventListener('DOMContentLoaded', init);
