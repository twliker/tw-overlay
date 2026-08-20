(() => {
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element #${id} not found`);
    return el;
  };

  const api = (window as any).equipmentSimulator;
  if (!api) {
    console.error('equipmentSimulator module not loaded.');
    return;
  }

  function fmt(val: number, decimals: number = 0): string {
    return val.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function formatSeed(seed: number): string {
    if (seed >= 100000000) {
      const eok = Math.floor(seed / 100000000);
      const man = Math.floor((seed % 100000000) / 10000);
      return man > 0 ? `${fmt(eok)}억 ${fmt(man)}만 SEED` : `${fmt(eok)}억 SEED`;
    }
    if (seed >= 10000) {
      return `${fmt(Math.floor(seed / 10000))}만 SEED`;
    }
    return `${fmt(seed)} SEED`;
  }

  function formatElso(elso: number): string {
    if (elso >= 100000000) {
      const eok = Math.floor(elso / 100000000);
      const man = Math.floor((elso % 100000000) / 10000);
      return man > 0 ? `${fmt(eok)}억 ${fmt(man)}만 엘소` : `${fmt(eok)}억 엘소`;
    }
    if (elso >= 10000) {
      return `${fmt(Math.floor(elso / 10000))}만 엘소`;
    }
    return `${fmt(elso)} 엘소`;
  }

  function formatFeeCost(type: 'seed' | 'elso', amount: number): string {
    return type === 'elso' ? formatElso(amount) : formatSeed(amount);
  }

  // ==========================================
  // 1. 메인 3개 탭 전환
  // ==========================================
  function setupTabNavigation(): void {
    const tabs = document.querySelectorAll<HTMLButtonElement>('[data-main-tab]');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.mainTab;

        $('panel-enhance').classList.toggle('hidden', target !== 'enhance');
        $('panel-enchant').classList.toggle('hidden', target !== 'enchant');
        $('panel-incrypt').classList.toggle('hidden', target !== 'incrypt');
        (window as any).lucide?.createIcons();
      });
    });
  }

  // ==========================================
  // 2. 장비 강화 로직 & UI
  // ==========================================
  let stageFeeOverrides: number[] = Array(20).fill(0);

  function setupEnhancePanel(): void {
    const currentSel = $('enhance-current-stage') as HTMLSelectElement;
    const targetSel = $('enhance-target-stage') as HTMLSelectElement;
    const noPenaltyToggle = $('enhance-nopenalty-toggle') as HTMLInputElement;

    for (let i = 0; i <= 19; i += 1) {
      currentSel.add(new Option(`${i}강`, String(i)));
    }
    for (let i = 1; i <= 20; i += 1) {
      targetSel.add(new Option(`${i}강`, String(i)));
    }
    currentSel.value = '0';
    targetSel.value = '10';

    function refreshEnhanceUI(): void {
      const isNoPenalty = noPenaltyToggle.checked;
      $('enhance-lucky-box').classList.toggle('hidden', isNoPenalty);
      $('enhance-talisman-box').classList.toggle('hidden', isNoPenalty);
      $('enhance-nopenalty-rate-box').classList.toggle('hidden', !isNoPenalty);
      renderEnhanceExpectation();
    }

    noPenaltyToggle.addEventListener('change', refreshEnhanceUI);
    currentSel.addEventListener('change', () => {
      const cur = Number(currentSel.value);
      if (Number(targetSel.value) <= cur) {
        targetSel.value = String(Math.min(20, cur + 1));
      }
      renderEnhanceExpectation();
    });
    targetSel.addEventListener('change', renderEnhanceExpectation);
    $('enhance-lucky-stone').addEventListener('change', renderEnhanceExpectation);
    $('enhance-talisman').addEventListener('change', renderEnhanceExpectation);
    $('enhance-nopenalty-rate').addEventListener('change', renderEnhanceExpectation);
    $('enhance-currency-type').addEventListener('change', () => {
      const type = ($('enhance-currency-type') as HTMLSelectElement).value;
      $('enhance-fee-label').textContent = `1회 수수료 (${type === 'elso' ? '엘소' : 'SEED'})`;
      renderEnhanceExpectation();
    });

    // 가격 변경 시 재계산
    ['enhance-price-fee', 'enhance-price-stone', 'enhance-price-talisman', 'enhance-price-scroll'].forEach((id) => {
      $(id).addEventListener('input', renderEnhanceExpectation);
    });

    renderEnhanceExpectation();
  }

  function getEnhanceOptions(): any {
    const baseFee = Number(($('enhance-price-fee') as HTMLInputElement).value) || 0;
    const costPerStage = stageFeeOverrides.map((f) => (f > 0 ? f : baseFee));

    return {
      startStage: Number(($('enhance-current-stage') as HTMLSelectElement).value) || 0,
      targetStage: Number(($('enhance-target-stage') as HTMLSelectElement).value) || 10,
      luckyStoneCount: Number(($('enhance-lucky-stone') as HTMLSelectElement).value) || 0,
      talismanCount: Number(($('enhance-talisman') as HTMLSelectElement).value) || 0,
      isNoPenaltyScroll: ($('enhance-nopenalty-toggle') as HTMLInputElement).checked,
      noPenaltyScrollRate: Number(($('enhance-nopenalty-rate') as HTMLSelectElement).value) || 1.0,
      currencyType: ($('enhance-currency-type') as HTMLSelectElement).value || 'seed',
      costPerAttempt: baseFee,
      costPerStage,
      stonePrice: Number(($('enhance-price-stone') as HTMLInputElement).value) || 0,
      talismanPrice: Number(($('enhance-price-talisman') as HTMLInputElement).value) || 0,
      scrollPrice: Number(($('enhance-price-scroll') as HTMLInputElement).value) || 0,
    };
  }

  function renderEnhanceExpectation(): void {
    const opts = getEnhanceOptions();
    const res = api.calculateEnhanceExpectation(opts);
    const container = $('enhance-exp-metrics');
    const feeText = formatFeeCost(res.currencyType, res.expectedFeeCost);
    const itemText = formatSeed(res.expectedItemCostSeed);

    container.innerHTML = `
      <div class="metric"><p class="text-xs text-slate-400">평균 총 시도 횟수</p><strong class="text-lg text-amber-300">${fmt(res.expectedAttempts, 1)}회</strong></div>
      <div class="metric"><p class="text-xs text-slate-400">평균 단계 하락 횟수</p><strong class="text-lg text-rose-400">${fmt(res.expectedDrops, 1)}회</strong></div>
      <div class="metric"><p class="text-xs text-slate-400">보조 아이템 소모 기댓값</p><div class="text-xs font-bold text-slate-200">행운석: ${fmt(res.expectedLuckyStones, 1)}개<br>부적: ${fmt(res.expectedTalismans, 1)}개</div></div>
      <div class="metric"><p class="text-xs text-slate-400">총 비용 기댓값</p><strong class="text-base text-indigo-300">${feeText}</strong><div class="text-[11px] text-slate-400">재료비: ${itemText}</div></div>
    `;

    // 단계별 테이블
    const tableContainer = $('enhance-exp-stage-table');
    if (!res.stageStats.length) {
      tableContainer.innerHTML = '';
      return;
    }

    const baseFee = Number(($('enhance-price-fee') as HTMLInputElement).value) || 0;

    let tableHtml = `
      <table class="w-full text-xs text-left border-collapse border border-white/10 rounded-lg overflow-hidden">
        <thead>
          <tr class="bg-white/5 text-slate-400">
            <th class="p-2 border-b border-white/10">강화 구간</th>
            <th class="p-2 border-b border-white/10 text-right">성공률 / 페널티</th>
            <th class="p-2 border-b border-white/10 text-right">1회 수수료 (직접입력)</th>
            <th class="p-2 border-b border-white/10 text-right">구간 돌파 기댓값</th>
            <th class="p-2 border-b border-white/10 text-right">구간 예상 비용</th>
            <th class="p-2 border-b border-white/10 text-right">누적 평균 시도</th>
            <th class="p-2 border-b border-white/10 text-right">누적 예상 총비용</th>
          </tr>
        </thead>
        <tbody>
    `;

    res.stageStats.forEach((st: any) => {
      const curFee = stageFeeOverrides[st.stage] > 0 ? stageFeeOverrides[st.stage] : baseFee;
      tableHtml += `
        <tr class="border-b border-white/5 hover:bg-white/[0.02]">
          <td class="p-2 font-bold text-slate-200">${st.stage}강 → ${st.stage + 1}강</td>
          <td class="p-2 text-right">
            <span class="text-emerald-400 font-bold">${(st.successRate * 100).toFixed(3)}%</span>
            ${st.effectivePenaltyRate > 0 ? `<span class="text-[11px] text-rose-400 block font-normal">(하락 ${(st.effectivePenaltyRate * 100).toFixed(1)}%)</span>` : ''}
          </td>
          <td class="p-2 text-right">
            <input type="number" data-stage-fee="${st.stage}" class="w-24 px-1.5 py-1 text-right bg-slate-900 border border-white/15 rounded text-xs text-amber-200 focus:border-amber-400 focus:outline-none" value="${curFee || ''}" placeholder="${baseFee || '0'}" step="10000" min="0">
          </td>
          <td class="p-2 text-right text-indigo-300 font-bold">${fmt(st.stepExpectedAttempts || 0, 1)}회</td>
          <td class="p-2 text-right text-slate-300">
            <div class="font-bold text-xs text-indigo-300">${formatFeeCost(res.currencyType, st.stepFeeCost || 0)}</div>
            ${st.stepItemCostSeed > 0 ? `<div class="text-[10px] text-slate-400">재료: ${formatSeed(st.stepItemCostSeed)}</div>` : ''}
          </td>
          <td class="p-2 text-right text-amber-300 font-bold">${fmt(st.cumulativeAttempts || 0, 1)}회</td>
          <td class="p-2 text-right text-slate-300">
            <div class="font-bold text-xs text-amber-200">${formatFeeCost(res.currencyType, st.cumulativeFeeCost || 0)}</div>
            ${st.cumulativeItemCostSeed > 0 ? `<div class="text-[10px] text-slate-400">재료: ${formatSeed(st.cumulativeItemCostSeed)}</div>` : ''}
          </td>
        </tr>
      `;
    });

    tableHtml += `</tbody></table>`;
    tableContainer.innerHTML = tableHtml;

    // 단계별 1회 수수료 개별 입력 이벤트 바인딩
    tableContainer.querySelectorAll<HTMLInputElement>('input[data-stage-fee]').forEach((input) => {
      input.addEventListener('change', () => {
        const stage = Number(input.dataset.stageFee);
        const val = Number(input.value) || 0;
        stageFeeOverrides[stage] = val;
        renderEnhanceExpectation();
      });
    });
  }

  // ==========================================
  // 3. 인챈트 로직 & UI
  // ==========================================
  function setupEnchantPanel(): void {
    const presetSelect = $('enchant-preset-select') as HTMLSelectElement;
    const statSelect = $('enchant-stat-type') as HTMLSelectElement;
    const scrollSelect = $('enchant-scroll-count') as HTMLSelectElement;

    // 프리셋 셀렉트 박스 채우기
    presetSelect.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = 'custom_var';
    defOpt.textContent = '일반 인챈트 (+4~6 또는 +2~3 변동 상승)';
    presetSelect.appendChild(defOpt);

    const presets = api.FIXED_ENCHANT_SCROLL_PRESETS || [];
    presets.forEach((p: any) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (+${p.statGain} 확정, 성공률 ${(p.successRate * 100).toFixed(0)}%${p.blessingGain === 0 ? ', 축복치 없음' : ''})`;
      presetSelect.appendChild(opt);
    });

    function refreshEnchantUI(): void {
      const presetId = presetSelect.value;
      const isCustom = presetId === 'custom_var';
      const preset = presets.find((p: any) => p.id === presetId);
      const stat = statSelect.value;
      const isPrim = ['stab', 'hack', 'int', 'def', 'mr'].includes(stat);
      const scrollCount = Number(scrollSelect.value) || 0;

      // 일반 인챈트일 때만 보조 주문서 투입 박스 활성화
      $('enchant-scroll-count-box').classList.toggle('opacity-50', !isCustom);
      scrollSelect.disabled = !isCustom;
      $('enchant-price-enhance-box').classList.toggle('opacity-50', !isCustom);
      ($('enchant-price-enhance-scroll') as HTMLInputElement).disabled = !isCustom;

      if (isCustom) {
        $('enchant-rate-summary-badge').textContent = '기본 성공률 2% · 실패 시 축복치 누적';
        if (isPrim) {
          const row = api.ENCHANT_ENHANCE_SCROLL_TABLE.primary[scrollCount];
          $('enchant-prob-distribution-guide').textContent =
            `현재 설정 성공 시 스탯 상승 확률: +4 (${(row.p4 * 100).toFixed(0)}%), +5 (${(row.p5 * 100).toFixed(0)}%), +6 (${(row.p6 * 100).toFixed(0)}%)`;
        } else {
          const row = api.ENCHANT_ENHANCE_SCROLL_TABLE.secondary[scrollCount];
          $('enchant-prob-distribution-guide').textContent =
            `현재 설정 성공 시 스탯 상승 확률: +2 (${(row.p2 * 100).toFixed(0)}%), +3 (${(row.p3 * 100).toFixed(0)}%)`;
        }
      } else if (preset) {
        if (preset.blessingGain === 0) {
          $('enchant-rate-summary-badge').textContent = `성공률 ${(preset.successRate * 100).toFixed(0)}% · 축복치 없음 (독립 시행)`;
        } else {
          $('enchant-rate-summary-badge').textContent = `성공률 ${(preset.successRate * 100).toFixed(0)}% · 실패 시 축복치 +${(preset.blessingGain * 100).toFixed(0)}%p`;
        }
        $('enchant-prob-distribution-guide').textContent =
          `공식 프리셋 적용: 성공 시 스탯 +${preset.statGain} 확정 상승 | 성공률 ${(preset.successRate * 100).toFixed(0)}%`;
      }

      renderEnchantExpectation();
    }

    presetSelect.addEventListener('change', refreshEnchantUI);
    statSelect.addEventListener('change', refreshEnchantUI);
    scrollSelect.addEventListener('change', refreshEnchantUI);
    $('enchant-initial-blessing').addEventListener('input', renderEnchantExpectation);
    $('enchant-target-success').addEventListener('input', renderEnchantExpectation);
    $('enchant-currency-type').addEventListener('change', () => {
      const type = ($('enchant-currency-type') as HTMLSelectElement).value;
      $('enchant-fee-label').textContent = `1회 수수료 (${type === 'elso' ? '엘소' : 'SEED'})`;
      renderEnchantExpectation();
    });

    ['enchant-price-fee', 'enchant-price-scroll', 'enchant-price-enhance-scroll'].forEach((id) => {
      $(id).addEventListener('input', renderEnchantExpectation);
    });

    refreshEnchantUI();
  }

  function getEnchantOptions(): any {
    const presetId = ($('enchant-preset-select') as HTMLSelectElement).value || 'custom_var';
    const preset = api.FIXED_ENCHANT_SCROLL_PRESETS?.find((p: any) => p.id === presetId);
    const isCustom = presetId === 'custom_var';

    return {
      statType: ($('enchant-stat-type') as HTMLSelectElement).value,
      presetId,
      fixedStatGain: isCustom ? undefined : preset?.statGain,
      baseSuccessRate: isCustom ? 0.02 : preset?.successRate,
      blessingGainOnFail: isCustom ? undefined : preset?.blessingGain,
      enhanceScrollCount: Number(($('enchant-scroll-count') as HTMLSelectElement).value) || 0,
      initialBlessing: Math.min(1.0, Math.max(0, (Number(($('enchant-initial-blessing') as HTMLInputElement).value) || 0) / 100)),
      currencyType: ($('enchant-currency-type') as HTMLSelectElement).value || 'seed',
      costPerAttempt: Number(($('enchant-price-fee') as HTMLInputElement).value) || 0,
      scrollPrice: Number(($('enchant-price-scroll') as HTMLInputElement).value) || 0,
      enhanceScrollPrice: Number(($('enchant-price-enhance-scroll') as HTMLInputElement).value) || 0,
    };
  }

  function renderEnchantExpectation(): void {
    const opts = getEnchantOptions();
    const targetSucc = Number(($('enchant-target-success') as HTMLInputElement).value) || 1;
    const res = api.calculateEnchantExpectation(opts);
    const container = $('enchant-exp-metrics');

    const totalAttempts = res.expectedAttemptsPerSuccess * targetSucc;
    const totalFeeCost = res.expectedFeeCostPerSuccess * targetSucc;
    const totalItemCost = res.expectedItemCostSeedPerSuccess * targetSucc;
    const totalStat = res.expectedStatGainPerSuccess * targetSucc;

    const feeText = formatFeeCost(res.currencyType, totalFeeCost);
    const itemText = formatSeed(totalItemCost);

    container.innerHTML = `
      <div class="metric"><p class="text-xs text-slate-400">1회 성공당 평균 시도</p><strong class="text-lg text-cyan-300">${fmt(res.expectedAttemptsPerSuccess, 1)}회</strong><div class="text-[11px] text-slate-400">(${targetSucc}회 성공 시: 약 ${fmt(totalAttempts, 1)}회)</div></div>
      <div class="metric"><p class="text-xs text-slate-400">1회 성공 시 스탯 기댓값</p><strong class="text-lg text-amber-300">+${fmt(res.expectedStatGainPerSuccess, 2)}</strong><div class="text-[11px] text-slate-400">(총 기댓값: +${fmt(totalStat, 1)})</div></div>
      <div class="metric"><p class="text-xs text-slate-400">주문서 소모 기댓값</p><div class="text-xs font-bold text-slate-200">인챈트: ${fmt(totalAttempts, 1)}장<br>보조제: ${fmt(res.expectedEnhanceScrollsPerSuccess * targetSucc, 1)}장</div></div>
      <div class="metric"><p class="text-xs text-slate-400">총 비용 기댓값</p><strong class="text-base text-indigo-300">${feeText}</strong><div class="text-[11px] text-slate-400">주문서: ${itemText}</div></div>
    `;
  }

  // ==========================================
  // 4. 인크립트 로직 & UI
  // ==========================================
  function setupIncryptPanel(): void {
    const scrollSelect = $('incrypt-scroll-type') as HTMLSelectElement;
    const protectInput = $('incrypt-protect-count') as HTMLInputElement;

    function refreshIncryptUI(): void {
      const scrollType = scrollSelect.value;
      const info = api.INCRYPT_SCROLLS[scrollType] || api.INCRYPT_SCROLLS.lord;
      const maxProtect = info.maxProtectionScrolls;

      protectInput.max = String(maxProtect);
      if (Number(protectInput.value) > maxProtect) {
        protectInput.value = String(maxProtect);
      }
      $('incrypt-protect-max-label').textContent = `/ ${maxProtect}장`;
      $('incrypt-protect-box').classList.toggle('opacity-50', maxProtect === 0);

      const protects = Number(protectInput.value) || 0;
      const destroyRate = Math.max(0, info.baseDestroyRate - protects * 0.01);

      $('incrypt-scroll-rate-badge').textContent = `기본 성공률 ${(info.successRate * 100).toFixed(2)}%`;
      $('incrypt-rates-guide').innerHTML = `
        <span>실패 시 파괴 확률: <b class="${destroyRate > 0 ? 'text-rose-400' : 'text-emerald-400'}">${(destroyRate * 100).toFixed(0)}%</b> (장파보 -${protects}%p)</span>
        <span>1회 시도당 생존 확률: <b class="text-indigo-300">${((1.0 - (1.0 - info.successRate) * destroyRate) * 100).toFixed(2)}%</b></span>
      `;

      renderIncryptExpectation();
    }

    scrollSelect.addEventListener('change', refreshIncryptUI);
    protectInput.addEventListener('input', refreshIncryptUI);
    $('incrypt-target-success').addEventListener('input', renderIncryptExpectation);
    $('incrypt-currency-type').addEventListener('change', () => {
      const type = ($('incrypt-currency-type') as HTMLSelectElement).value;
      $('incrypt-fee-label').textContent = `1회 수수료 (${type === 'elso' ? '엘소' : 'SEED'})`;
      renderIncryptExpectation();
    });

    ['incrypt-price-fee', 'incrypt-price-scroll', 'incrypt-price-protect', 'incrypt-price-equip'].forEach((id) => {
      $(id).addEventListener('input', renderIncryptExpectation);
    });

    refreshIncryptUI();
  }

  function getIncryptOptions(): any {
    return {
      scrollType: ($('incrypt-scroll-type') as HTMLSelectElement).value,
      protectionScrollCount: Number(($('incrypt-protect-count') as HTMLInputElement).value) || 0,
      currencyType: ($('incrypt-currency-type') as HTMLSelectElement).value || 'seed',
      costPerAttempt: Number(($('incrypt-price-fee') as HTMLInputElement).value) || 0,
      scrollPrice: Number(($('incrypt-price-scroll') as HTMLInputElement).value) || 0,
      protectionScrollPrice: Number(($('incrypt-price-protect') as HTMLInputElement).value) || 0,
      equipmentPrice: Number(($('incrypt-price-equip') as HTMLInputElement).value) || 0,
    };
  }

  function renderIncryptExpectation(): void {
    const opts = getIncryptOptions();
    const targetSucc = Number(($('incrypt-target-success') as HTMLInputElement).value) || 1;
    const res = api.calculateIncryptExpectation(opts, targetSucc);
    const container = $('incrypt-exp-metrics');

    const feeText = formatFeeCost(res.currencyType, res.expectedCostPerSuccess.feeCost);
    const itemText = formatSeed(res.expectedCostPerSuccess.itemCostSeed);
    const equipLossText = formatSeed(res.expectedCostPerSuccess.equipLossSeed);

    container.innerHTML = `
      <div class="metric"><p class="text-xs text-slate-400">목표 성공당 평균 시도</p><strong class="text-lg text-rose-300">${fmt(res.expectedCostPerSuccess.scrollCount, 1)}회</strong></div>
      <div class="metric"><p class="text-xs text-slate-400">장비 1개로 ${targetSucc}회 달성 확률</p><strong class="text-lg text-emerald-400">${(res.survivalProbabilityUntilTarget * 100).toFixed(2)}%</strong><div class="text-[11px] text-slate-400">(파괴 없이 완주할 확률)</div></div>
      <div class="metric"><p class="text-xs text-slate-400">평균 장비 파괴 기댓값</p><strong class="text-lg text-amber-300">${fmt(res.expectedDestroyedEquipsPerSuccess * targetSucc, 2)}개</strong></div>
      <div class="metric"><p class="text-xs text-slate-400">총 비용 기댓값</p><strong class="text-base text-indigo-300">${feeText}</strong><div class="text-[11px] text-slate-400">재료: ${itemText}<br>장비손실: ${equipLossText}</div></div>
    `;
  }

  // ==========================================
  // 초기화
  // ==========================================
  window.addEventListener('DOMContentLoaded', () => {
    setupTabNavigation();
    setupEnhancePanel();
    setupEnchantPanel();
    setupIncryptPanel();
    (window as any).lucide?.createIcons();
  });

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') window.close();
  });
})();
