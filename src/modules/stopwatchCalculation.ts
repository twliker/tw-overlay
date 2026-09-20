/** 시간 측정의 시작 스냅샷과 과거 기록의 계열·코어 변경에 같은 기존 계산식을 사용한다. */
import activeBuffs from '../assets/data/buffs.json';
const standardBuffs: readonly string[] = require('../shared/buffConstants').STANDARD_BUFFS;

const stopwatchCategories = [
  { id: 'helm', source: 'defense', key: '투구' }, { id: 'armor', source: 'armors', isNested: true },
  { id: 'weapon', source: 'weapons', isNested: true }, { id: 'wrist', source: 'wrists', isNested: true },
  { id: 'amulet', source: 'defense', key: '머리' }, { id: 'wing', source: 'defense', key: '몸' },
  { id: 'gauntlet', source: 'defense', key: '손' }, { id: 'boots', source: 'defense', key: '다리' },
  { id: 'artifact', source: 'artifacts', isNested: true }
];

// 최종 스탯 및 계수 계산 공식 (이식)
export function recalculateStatsAndCoefficient(pData: any, currentSeries: string, currentCore: string, savedPresets: string | null = null) {
  // 1. 도핑 보너스 계산 (bFix, bPct)
  const presetId = pData.buffPreset || 'none';
  let buffIds: string[] = [];
  if (presetId === 'standard') {
    buffIds = [...standardBuffs];
  } else if (presetId !== 'none') {
    if (savedPresets) {
      try {
        const presets = JSON.parse(savedPresets);
        if (Array.isArray(presets)) {
          const preset = presets.find((p: any) => p.id.toString() === presetId);
          if (preset) buffIds = preset.buffIds;
        }
      } catch (e) {}
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

  // 새 기록은 시작 때의 도핑 효과도 보관한다. 구형 기록은 기존 프리셋 해석을 유지한다.
  if (pData.stopwatchBuffEffects) {
    bFix = Number(pData.stopwatchBuffEffects.fixed) || 0;
    bPct = Number(pData.stopwatchBuffEffects.percent) || 0;
  }

  const getV = (val: any) => {
    if (val === undefined || val === null || val === '') return 0;
    return Math.max(0, Number(val) || 0);
  };

  const applyB = (v: number) => Math.floor((v + bFix) * (1 + bPct / 100));

  // cStats (캐릭터 순수 + 도핑)
  const cStats = {
    stab: applyB(getV(pData.stats?.stab)),
    hack: applyB(getV(pData.stats?.hack)),
    int: applyB(getV(pData.stats?.int)),
    mr: applyB(getV(pData.stats?.mr)),
    dex: applyB(getV(pData.stats?.dex))
  };

  // 주/부 매핑
  const statMap: Record<string, { main: keyof typeof cStats; sub: keyof typeof cStats }> = {
    stab: { main: 'stab', sub: 'hack' },
    hack: { main: 'hack', sub: 'stab' },
    phycomp: { main: 'stab', sub: 'hack' },
    magatk: { main: 'int', sub: 'mr' },
    maghack: { main: 'hack', sub: 'int' },
    magdef: { main: 'mr', sub: 'int' }
  };
  const keys = statMap[currentSeries] || { main: 'stab', sub: 'hack' };

  // 장비 및 보너스 값들 루프
  let gMain = 0, gSub = 0, gHit = 0, uMain = 0, uSub = 0, uHit = 0;
  
  stopwatchCategories.forEach(cat => {
    const gearVal = pData.gears?.[cat.id];
    if (gearVal) {
      let gearObj: any = null;
      try {
        gearObj = JSON.parse(gearVal);
      } catch (e) {}

      let bM = 0;
      let bS = 0;
      let bH = 0;

      if (gearObj) {
        bM = getV(gearObj[keys.main]);
        bS = getV(gearObj[keys.sub]);
        bH = getV(gearObj.hit);
      } else {
        bM = getV(pData.basesMain?.[cat.id]);
        bS = getV(pData.basesSub?.[cat.id]);
        bH = getV(pData.basesDex?.[cat.id]);
      }

      const abilS = getV(pData.abilsStat?.[cat.id]);
      const abilH = getV(pData.abilsHit?.[cat.id]);

      gMain += bM + abilS;
      gSub += bS;
      gHit += bH + abilH;

      const upgM = getV(pData.upgradesMain?.[cat.id]);
      const upgS = getV(pData.upgradesSub?.[cat.id]);

      uMain += upgM;
      uSub += upgS;
    }
  });

  // cuff, relic, title 보너스
  const bonuses = pData.bonuses || {};
  ['cuff', 'relic'].forEach(k => {
    gMain += getV(bonuses[`${k}Main`]);
    gSub += getV(bonuses[`${k}Sub`]);
    gHit += getV(bonuses[`${k}Hit`]);
  });
  gMain += getV(bonuses.title);
  gSub += getV(bonuses.titleSub);
  gHit += getV(bonuses.titleHit);

  // Avatar
  gMain += 15; gSub += 15; gHit += 15; // 기본 15
  uMain += getV(bonuses.avatarMain);
  uSub += getV(bonuses.avatarSub);
  uHit += getV(bonuses.avatarHit);

  // Effect
  gMain += getV(bonuses.effectBaseMain);
  gSub += getV(bonuses.effectBaseSub);
  uMain += getV(bonuses.effectMain);
  uSub += getV(bonuses.effectSub);
  uHit += getV(bonuses.effectHit);

  // Core contribution
  const coreMerc = getV(bonuses.coreMercurial);
  const coreAbyss = getV(bonuses.coreAbyss);
  const coreEclipse = getV(bonuses.coreEclipse);
  const coreRubicona = getV(bonuses.coreRubicona);
  const coreWeight = ['phycomp', 'maghack'].includes(currentSeries) ? 28.75 : 32.5;
  const coreCoeffs: Record<string, number> = {
    mercurial: coreMerc * coreWeight,
    abyss: coreAbyss * coreWeight,
    eclipse: coreEclipse * coreWeight,
    rubicona: coreRubicona * coreWeight,
    none: 0
  };

  const selectedCoreCoeff = coreCoeffs[currentCore] || 0;

  // 코어 마스터 실제 스탯 수치 획득
  const selectedCoreVal = currentCore === 'mercurial' ? coreMerc :
                          currentCore === 'abyss' ? coreAbyss :
                          currentCore === 'eclipse' ? coreEclipse :
                          currentCore === 'rubicona' ? coreRubicona : 0;

  // 최종 스탯 값 계산
  const charMain = cStats[keys.main];
  const charSub = cStats[keys.sub];
  const baseMain = gMain;
  const enchantMain = uMain + selectedCoreVal; // 코어 마스터 스탯을 강화 주스텟에 합산
  const baseSub = gSub;
  const enchantSub = uSub;
  const totalHit = cStats.dex + gHit + uHit;

  // 계수 계산 공식
  let coeff = 0;
  if (currentSeries === 'stab') {
    coeff = (gMain * 23.75) + (uMain * 32.5) + (gSub * 3.75) + (uSub * 18.75) + (cStats.stab * 2.1) + (cStats.hack * 1.08);
  } else if (currentSeries === 'hack') {
    coeff = (gMain * 23.75) + (uMain * 32.5) + (gSub * 3.75) + (uSub * 18.75) + (cStats.hack * 2.1) + (cStats.stab * 1.08);
  } else if (currentSeries === 'phycomp') {
    coeff = (gMain * 14.5) + (uMain * 28.75) + (gSub * 14.5) + (uSub * 28.75) + (cStats.stab * 1.8) + (cStats.hack * 1.8);
  } else if (currentSeries === 'magatk') {
    coeff = (gMain * 23.75) + (uMain * 32.5) + (gSub * 2.5) + (uSub * 18.25) + (cStats.int * 2.4) + (cStats.mr * 0.6);
  } else if (currentSeries === 'maghack') {
    coeff = (gMain * 14.5) + (uMain * 28.75) + (gSub * 14.5) + (uSub * 28.75) + (cStats.hack * 1.8) + (cStats.int * 1.8);
  } else if (currentSeries === 'magdef') {
    coeff = (gMain * 20.5) + (uMain * 32.5) + (gSub * 2.5) + (uSub * 16.75) + (cStats.mr * 2.55) + (cStats.int * 0.45);
  }

  const totalCoeff = coeff + selectedCoreCoeff;

  return {
    charMain,
    charSub,
    baseMain,
    enchantMain,
    baseSub,
    enchantSub,
    totalHit,
    buffEffects: { fixed: bFix, percent: bPct },
    coefficient: totalCoeff
  };
}

