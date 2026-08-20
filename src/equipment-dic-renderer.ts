// @ts-nocheck
// Declare lucide externally since it is loaded via script tag in HTML
declare const lucide: any;

interface EquipmentItem {
  name: string;
  category: string;
  subCategory?: string;
  group: string;
  part?: string;
  image: string;
  stats: Record<string, string>;
  maxStats?: Record<string, string>;
  delay?: string;
  synth?: string;
  levelReq?: string;
  statReq?: string;
  slots?: string;
  effects?: string;
}

let allEquipment: EquipmentItem[] = [];
let filteredEquipment: EquipmentItem[] = [];
let currentGroup = '전체';
let currentSubCategory = '전체';
let selectedItem: EquipmentItem | null = null;
let compareBasket: EquipmentItem[] = [];

const statNameMap: Record<string, string> = {
  stab: '찌르기 (STAB)',
  hack: '베기 (HACK)',
  def: '물리방어 (DEF)',
  mag_atk: '마법공격 (INT)',
  mag_def: '마법방어 (MR)',
  hit: '명중률 (DEX)',
  eva: '회피율 (AGI)',
  agi: '민첩성 (AGI)',
  cri: '크리티컬 (CRI)',
  damage_pct: '공격력',
  dmg_red_pct: '피해 저항'
};

const escapeHtml = window.escapeHtml;

function matchesSearch(name: string, category: string, query: string): boolean {
  if (!(window as any).HangulUtils) {
    const q = query.toLowerCase().trim();
    return name.toLowerCase().includes(q) || category.toLowerCase().includes(q);
  }
  return (window as any).HangulUtils.matchesSearch(name, category, query);
}

/** Get slot type to restrict comparisons to similar equipment parts */
function getSlotType(item: EquipmentItem): string {
  if (item.group === '무기') return 'weapon-' + item.category.toLowerCase();
  const part = item.part ? item.part.toLowerCase() : '';
  return part || (item.group + '-' + item.category.toLowerCase());
}

// Fetch the equipment dictionary JSON
async function initEquipmentDic() {
  try {
    const response = await fetch('assets/data/equipment_dic.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allEquipment = await response.json();
    filteredEquipment = [...allEquipment];

    setupEventListeners();
    updateItemCount();
    renderList();
    
    // Auto-focus search input on load
    const searchInput = document.getElementById('search-input') as HTMLInputElement;
    if (searchInput) searchInput.focus();

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  } catch (error) {
    console.error('Failed to load equipment dictionary:', error);
    const listEl = document.getElementById('result-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 text-slate-600 gap-2">
          <i data-lucide="alert-triangle" class="w-8 h-8 opacity-40"></i>
          <span class="text-[11px] font-bold tracking-widest uppercase">장비 데이터를 불러오지 못했습니다</span>
        </div>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

function setupEventListeners() {
  // Search input change
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterItems();
    });
  }

  // Main Group category tabs
  const groupChips = document.querySelectorAll('.cat-chip');
  groupChips.forEach(chip => {
    chip.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const group = target.getAttribute('data-group') || '전체';
      
      // Update active style
      groupChips.forEach(c => c.classList.remove('active'));
      target.classList.add('active');

      currentGroup = group;
      currentSubCategory = '전체'; // Reset subcategory when main group changes

      const triggerText = document.getElementById('sub-category-trigger-text');
      if (triggerText) triggerText.innerText = '전체';

      setupSubCategoryDropdown();
      filterItems();
    });
  });

  // Dropdown Toggle Event
  const trigger = document.getElementById('sub-category-trigger');
  const layer = document.getElementById('sub-category-layer');
  if (trigger && layer) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.classList.toggle('hidden');
      if (!layer.classList.contains('hidden')) {
        const subSearch = document.getElementById('sub-category-search') as HTMLInputElement;
        if (subSearch) {
          subSearch.value = '';
          subSearch.focus();
          filterSubDropdownOptions('');
        }
      }
    });
  }

  // Mini Search input inside Dropdown
  const subSearchInput = document.getElementById('sub-category-search') as HTMLInputElement;
  if (subSearchInput) {
    subSearchInput.addEventListener('input', () => {
      filterSubDropdownOptions(subSearchInput.value);
    });
    subSearchInput.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent dropdown closing when typing
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (layer && !layer.classList.contains('hidden')) {
      const target = e.target as HTMLElement;
      if (!trigger?.contains(target) && !layer.contains(target)) {
        layer.classList.add('hidden');
      }
    }
  });

  // ESC to close window
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.close();
    }
  });

  // Calculate Evolution Cost Button click
  const btnCalcEvolution = document.getElementById('btn-calc-evolution');
  if (btnCalcEvolution) {
    btnCalcEvolution.addEventListener('click', () => {
      if (!selectedItem) return;
      const evoParams = mapEquipmentToEvoParams(selectedItem);
      if (evoParams) {
        if ((window as any).electronAPI && (window as any).electronAPI.sendEquipmentToEvolution) {
          (window as any).electronAPI.sendEquipmentToEvolution({
            category: evoParams.category,
            part: evoParams.part,
            itemName: selectedItem.name
          });
        }
      }
    });
  }

  // Send to Coefficient Calculator Button click
  const btnSendToCoefficient = document.getElementById('btn-send-to-coefficient');
  if (btnSendToCoefficient) {
    btnSendToCoefficient.addEventListener('click', () => {
      if (!selectedItem) return;
      if ((window as any).electronAPI && (window as any).electronAPI.sendEquipmentToCoefficient) {
        (window as any).electronAPI.sendEquipmentToCoefficient(selectedItem);
      }
    });
  }

  // Add to Compare Button click
  const btnAddToCompare = document.getElementById('btn-add-to-compare');
  if (btnAddToCompare) {
    btnAddToCompare.addEventListener('click', () => {
      if (!selectedItem) return;

      const alreadyExists = compareBasket.some(item => item === selectedItem);
      if (alreadyExists) {
        alert('이미 비교함에 추가된 아이템입니다.');
        return;
      }

      if (compareBasket.length >= 4) {
        alert('최대 4개까지만 비교할 수 있습니다.');
        return;
      }

      compareBasket.push(selectedItem);
      renderCompareBasketBar();
    });
  }

  // Clear Compare Button click
  const btnClearCompare = document.getElementById('btn-clear-compare');
  if (btnClearCompare) {
    btnClearCompare.addEventListener('click', () => {
      compareBasket = [];
      renderCompareBasketBar();
      
      // If table view is open, switch back
      const compareTableView = document.getElementById('compare-table-view');
      if (compareTableView && !compareTableView.classList.contains('hidden')) {
        compareTableView.classList.add('hidden');
        const selectedContent = document.getElementById('detail-content');
        const emptyState = document.getElementById('empty-state');
        if (selectedItem) {
          if (selectedContent) selectedContent.classList.remove('hidden');
        } else {
          if (emptyState) emptyState.classList.remove('hidden');
        }
      }
    });
  }

  // Show Compare Table Button click
  const btnShowCompare = document.getElementById('btn-show-compare');
  if (btnShowCompare) {
    btnShowCompare.addEventListener('click', () => {
      const detailContent = document.getElementById('detail-content');
      const emptyState = document.getElementById('empty-state');
      const compareTableView = document.getElementById('compare-table-view');

      if (detailContent) detailContent.classList.add('hidden');
      if (emptyState) emptyState.classList.add('hidden');
      if (compareTableView) {
        compareTableView.classList.remove('hidden');
        renderCompareTable();
      }
    });
  }

  // Close Compare Table Button click
  const btnCloseCompare = document.getElementById('btn-close-compare');
  if (btnCloseCompare) {
    btnCloseCompare.addEventListener('click', () => {
      const compareTableView = document.getElementById('compare-table-view');
      const detailContent = document.getElementById('detail-content');
      const emptyState = document.getElementById('empty-state');

      if (compareTableView) compareTableView.classList.add('hidden');
      if (selectedItem) {
        if (detailContent) detailContent.classList.remove('hidden');
      } else {
        if (emptyState) emptyState.classList.remove('hidden');
      }
    });
  }

  // Event delegation for compare basket badges
  const compareItemsList = document.getElementById('compare-items-list');
  if (compareItemsList) {
    compareItemsList.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('.btn-remove-compare') as HTMLElement;
      if (btn) {
        const index = parseInt(btn.getAttribute('data-index') || '0', 10);
        removeFromCompare(index);
      }
    });
  }

  // Event delegation for compare table headers
  const compareTableThead = document.getElementById('compare-table-thead');
  if (compareTableThead) {
    compareTableThead.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('.btn-remove-compare') as HTMLElement;
      if (btn) {
        const index = parseInt(btn.getAttribute('data-index') || '0', 10);
        removeFromCompare(index);
      }
    });
  }
}

/** Filter subcategory list elements inside the custom dropdown layer */
function filterSubDropdownOptions(query: string) {
  const optionsContainer = document.getElementById('sub-category-options');
  if (!optionsContainer) return;
  const normalizedQuery = query.toLowerCase().trim();
  const buttons = optionsContainer.querySelectorAll('.sub-opt-item');
  buttons.forEach(btn => {
    const text = btn.textContent?.toLowerCase() || '';
    if (text.includes(normalizedQuery) || text === '전체') {
      (btn as HTMLElement).style.display = 'block';
    } else {
      (btn as HTMLElement).style.display = 'none';
    }
  });
}

/** Populate subcategory custom searchable dropdown options dynamically */
function setupSubCategoryDropdown() {
  const container = document.getElementById('sub-category-dropdown-container') as HTMLElement;
  const optionsContainer = document.getElementById('sub-category-options') as HTMLElement;
  const layer = document.getElementById('sub-category-layer') as HTMLElement;
  if (!container || !optionsContainer || !layer) return;

  layer.classList.add('hidden');

  if (currentGroup === '전체') {
    container.classList.add('hidden');
    optionsContainer.innerHTML = '';
    return;
  }

  // Find all unique categories within the active main group
  const groupItems = allEquipment.filter(item => item.group === currentGroup);
  const categories = Array.from(new Set(groupItems.map(item => item.category))).filter(Boolean);

  if (categories.length <= 1) {
    container.classList.add('hidden');
    optionsContainer.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  
  // Render dropdown item options
  let html = `<button class="sub-opt-item ${currentSubCategory === '전체' ? 'active' : ''}" data-sub="전체">전체</button>`;
  categories.forEach(cat => {
    html += `<button class="sub-opt-item ${currentSubCategory === cat ? 'active' : ''}" data-sub="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`;
  });

  optionsContainer.innerHTML = html;

  // Add click handlers for dropdown options
  const subOptions = optionsContainer.querySelectorAll('.sub-opt-item');
  subOptions.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      const sub = target.getAttribute('data-sub') || '전체';

      subOptions.forEach(c => c.classList.remove('active'));
      target.classList.add('active');

      currentSubCategory = sub;

      const triggerText = document.getElementById('sub-category-trigger-text');
      if (triggerText) triggerText.innerText = sub;

      layer.classList.add('hidden'); // Close dropdown
      filterItems();
    });
  });
}

function filterItems() {
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const query = searchInput ? searchInput.value : '';

  filteredEquipment = allEquipment.filter(item => {
    // 1. Group check
    if (currentGroup !== '전체' && item.group !== currentGroup) return false;

    // 2. Subcategory check
    if (currentSubCategory !== '전체' && item.category !== currentSubCategory) return false;

    // 3. Search query check
    return matchesSearch(item.name, item.category, query);
  });

  updateItemCount();
  renderList();
}

function updateItemCount() {
  const countEl = document.getElementById('item-count');
  if (countEl) {
    countEl.innerText = `${filteredEquipment.length}개`;
  }
}

function renderList() {
  const listEl = document.getElementById('result-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (filteredEquipment.length === 0) {
    listEl.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 text-slate-700 gap-2">
        <i data-lucide="search-x" class="w-8 h-8 opacity-25"></i>
        <span class="text-[11px] font-bold tracking-widest uppercase">검색 결과 없음</span>
      </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  filteredEquipment.forEach(item => {
    const card = document.createElement('div');
    // Identity by object reference — filteredEquipment holds the same objects as
    // allEquipment, so reference equality is robust even for duplicate name+category.
    const isActive = selectedItem === item;
    card.className = `item-card ${isActive ? 'active' : ''}`;

    // Safe image display
    const imgPath = item.image ? `assets/img/equipment/${escapeHtml(item.image)}` : '';

    card.innerHTML = `
      <div class="w-10 h-10 bg-black/40 border border-white/5 rounded-lg flex items-center justify-center overflow-hidden shrink-0">
        ${imgPath ? `<img src="${imgPath}" alt="" class="max-w-[85%] max-h-[85%] object-contain" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">` : ''}
        <i data-lucide="${item.group === '어빌리티' ? 'zap' : 'shield'}" class="w-4 h-4 text-slate-500" style="${imgPath ? 'display: none;' : ''}"></i>
      </div>
      <div class="flex-1 min-w-0 space-y-0.5">
        <h4 class="text-xs font-bold text-slate-200 truncate group-hover:text-white">${escapeHtml(item.name)}</h4>
        <p class="text-[9px] font-extrabold text-slate-500 uppercase truncate tracking-wider">${escapeHtml(item.category)}</p>
      </div>
      <div class="shrink-0 text-[9px] font-bold bg-white/5 border border-white/5 text-slate-400 px-1.5 py-0.5 rounded uppercase">
        ${escapeHtml(item.group)}
      </div>
    `;

    card.addEventListener('click', () => {
      // Toggle active states in list
      const activeCards = listEl.querySelectorAll('.item-card.active');
      activeCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      selectItem(item);
    });

    listEl.appendChild(card);
  });

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function selectItem(item: EquipmentItem) {
  selectedItem = item;

  const emptyState = document.getElementById('empty-state');
  const detailContent = document.getElementById('detail-content');

  if (!emptyState || !detailContent) return;

  emptyState.classList.add('hidden');
  detailContent.classList.remove('hidden');

  // Load basic elements
  const nameEl = document.getElementById('detail-name');
  const catBadge = document.getElementById('detail-category-badge');
  const grBadge = document.getElementById('detail-group-badge');
  const subCatEl = document.getElementById('detail-subcategory');
  const imgEl = document.getElementById('detail-image') as HTMLImageElement;

  if (nameEl) nameEl.innerText = item.name;
  if (catBadge) catBadge.innerText = item.category;
  if (grBadge) grBadge.innerText = item.group;
  
  if (item.subCategory) {
    if (subCatEl) {
      subCatEl.innerText = `분류: ${item.subCategory}`;
      subCatEl.classList.remove('hidden');
    }
  } else {
    if (subCatEl) subCatEl.classList.add('hidden');
  }

  if (imgEl) {
    imgEl.src = item.image ? `assets/img/equipment/${item.image}` : '';
  }

  // Show/Hide Evolution Calc button
  const btnCalcEvolution = document.getElementById('btn-calc-evolution');
  if (btnCalcEvolution) {
    const evoParams = mapEquipmentToEvoParams(item);
    const hasEvoRecipe = evoParams && (
      item.name.includes('아카드') ||
      item.name.includes('엔키라') ||
      item.name.includes('인퍼널') ||
      item.name.includes('아퀼루스') ||
      item.name.includes('어비스') ||
      item.name.includes('이클립스')
    );
    if (hasEvoRecipe) {
      btnCalcEvolution.classList.remove('hidden');
    } else {
      btnCalcEvolution.classList.add('hidden');
    }
  }

  // Show/Hide Coefficient Calc button
  const btnSendToCoefficient = document.getElementById('btn-send-to-coefficient');
  if (btnSendToCoefficient) {
    if (item.group !== '어빌리티') {
      btnSendToCoefficient.classList.remove('hidden');
    } else {
      btnSendToCoefficient.classList.add('hidden');
    }
  }

  // Metadata requirements
  const metaLevel = document.getElementById('meta-level');
  const metaStat = document.getElementById('meta-stat');
  const metaSynth = document.getElementById('meta-synth');
  const metaDelay = document.getElementById('meta-delay');

  if (metaLevel) metaLevel.innerText = item.levelReq && item.levelReq.trim() ? item.levelReq : '-';
  if (metaStat) metaStat.innerText = item.statReq && item.statReq.trim() ? item.statReq : '-';
  if (metaSynth) metaSynth.innerText = item.synth && item.synth.trim() ? item.synth : '-';
  if (metaDelay) metaDelay.innerText = item.delay && item.delay.trim() ? item.delay : '-';

  // Stats table vs Ability block
  const statsTableContainer = document.getElementById('equipment-stats-table-container');
  const abilityContainer = document.getElementById('ability-stats-container');
  const statsTbody = document.getElementById('detail-stats-tbody');

  if (!statsTableContainer || !abilityContainer || !statsTbody) return;

  if (item.group === '어빌리티') {
    statsTableContainer.classList.add('hidden');
    abilityContainer.classList.remove('hidden');

    // Bind Ability details
    const abilSlots = document.getElementById('ability-slots');
    const abilMain = document.getElementById('ability-main-effect');
    const abilEffects = document.getElementById('ability-effects');

    if (abilSlots) abilSlots.innerText = item.slots && item.slots.trim() ? `${item.slots}개` : '-';
    
    // Primary effect
    const primaryEffect = item.stats['기본효과'] || '';
    if (abilMain) abilMain.innerText = primaryEffect.trim() ? primaryEffect : '없음';

    // Sub/Additional effects
    if (abilEffects) abilEffects.innerText = item.effects && item.effects.trim() ? item.effects : '없음';

  } else {
    abilityContainer.classList.add('hidden');
    statsTableContainer.classList.remove('hidden');

    // Populate Equipment Stats Table
    statsTbody.innerHTML = '';
    
    // We combine keys from stats and maxStats to render all active parameters
    const allStatKeys = Array.from(
      new Set([
        ...Object.keys(item.stats || {}),
        ...Object.keys(item.maxStats || {})
      ])
    ).filter(key => key !== '기본효과');

    if (allStatKeys.length === 0) {
      statsTbody.innerHTML = `
        <tr>
          <td colspan="3" class="py-6 text-center text-xs text-slate-500 font-bold">
            활성화된 능력치 정보가 없습니다.
          </td>
        </tr>
      `;
    } else {
      allStatKeys.forEach(key => {
        const statLabel = statNameMap[key] || key.toUpperCase();
        const baseVal = item.stats?.[key] || '-';
        const maxVal = item.maxStats?.[key] || '-';

        const isSpecial = key === 'damage_pct' || key === 'dmg_red_pct';
        const rowClass = isSpecial ? 'stat-row bg-blue-500/5' : 'stat-row';
        const labelClass = isSpecial ? 'py-2.5 px-4 stat-label-col text-blue-400 font-bold' : 'py-2.5 px-4 stat-label-col';
        const valClass = isSpecial ? 'py-2.5 px-4 text-center stat-val-col text-blue-300 font-black' : 'py-2.5 px-4 text-center stat-val-col text-slate-300';

        const row = document.createElement('tr');
        row.className = rowClass;
        row.innerHTML = `
          <td class="${labelClass}">${escapeHtml(statLabel)}</td>
          <td class="${valClass}">${escapeHtml(baseVal)}</td>
          <td class="py-2.5 px-4 text-center stat-val-col text-emerald-400 font-black">${escapeHtml(maxVal)}</td>
        `;
        statsTbody.appendChild(row);
      });
    }
  }

  // Refresh Lucide icons in the detail pane
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

/** Parse max value of the base stat range string */
function getMaxBaseStatValue(statStr: string | undefined): number {
  if (!statStr) return -1;
  const cleaned = statStr.replace(/\([^)]*\)/g, '').trim();
  // Range strings are "min-max" (e.g. "122-132"); the hyphen is a separator,
  // not a minus sign. Extract positive tokens and take the max (upper bound).
  const numbers = cleaned.match(/\d+/g);
  if (!numbers) return -1;
  return Math.max(...numbers.map(Number));
}

/** Render compare basket UI elements in the comparison bar */
function renderCompareBasketBar() {
  const compareBar = document.getElementById('compare-bar');
  const compareCount = document.getElementById('compare-count');
  const compareItemsList = document.getElementById('compare-items-list');

  if (!compareBar || !compareCount || !compareItemsList) return;

  if (compareBasket.length === 0) {
    compareBar.classList.add('hidden');
    return;
  }

  compareBar.classList.remove('hidden');
  compareCount.innerText = compareBasket.length.toString();

  compareItemsList.innerHTML = '';
  compareBasket.forEach((item, index) => {
    const badge = document.createElement('div');
    badge.className = 'flex items-center gap-1 bg-white/5 border border-white/10 rounded-lg px-2 py-0.5 text-[11px] font-bold text-slate-300';
    badge.innerHTML = `
      <span class="truncate max-w-[80px]">${escapeHtml(item.name)}</span>
      <button class="btn-remove-compare text-slate-500 hover:text-red-400 transition-colors p-0.5" data-index="${index}">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
    `;
    compareItemsList.appendChild(badge);
  });

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

function removeFromCompare(index: number) {
  compareBasket.splice(index, 1);
  renderCompareBasketBar();
  if (compareBasket.length === 0) {
    const compareTableView = document.getElementById('compare-table-view');
    if (compareTableView) compareTableView.classList.add('hidden');
    
    const selectedContent = document.getElementById('detail-content');
    const emptyState = document.getElementById('empty-state');
    if (selectedItem) {
      if (selectedContent) selectedContent.classList.remove('hidden');
    } else {
      if (emptyState) emptyState.classList.remove('hidden');
    }
  } else {
    renderCompareTable();
  }
}

/** Render comparison grid comparing stats side-by-side with highlighting */
function renderCompareTable() {
  const thead = document.getElementById('compare-table-thead');
  const tbody = document.getElementById('compare-table-tbody');

  if (!thead || !tbody) return;

  // Header row
  let headHtml = `
    <tr>
      <th class="py-3 px-5 font-black text-xs text-slate-400 w-[130px]">비교 항목</th>
  `;

  compareBasket.forEach((item, index) => {
    const imgPath = item.image ? `assets/img/equipment/${escapeHtml(item.image)}` : '';
    headHtml += `
      <th class="py-4 px-5 text-center border-l border-white/5 relative group w-[110px]">
        <button class="btn-remove-compare absolute top-2 right-2 text-slate-500 hover:text-red-400 transition-colors p-1" data-index="${index}">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
        <div class="flex flex-col items-center gap-2 pt-2">
          <div class="w-12 h-12 bg-black/30 border border-white/10 rounded-lg flex items-center justify-center overflow-hidden">
            ${imgPath ? `<img src="${imgPath}" alt="" class="max-w-[85%] max-h-[85%] object-contain" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23475569%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22 class=%22lucide lucide-shield%22><path d=%22M20 13c0 5-3.5 7.5-7.66 9.7a1 1 0 0 1-.68 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 .76-.97l8-2a1 1 0 0 1 .48 0l8 2A1 1 0 0 1 20 6z%22/></svg>'">` : `<i data-lucide="shield" class="w-5 h-5 text-slate-500"></i>`}
          </div>
          <div class="text-xs font-black text-slate-200 text-center max-w-[95px] truncate" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        </div>
      </th>
    `;
  });

  headHtml += `</tr>`;
  thead.innerHTML = headHtml;

  // Gather unique stat keys across all items in basket
  const allStatKeys = Array.from(
    new Set(
      compareBasket.flatMap(item => [
        ...Object.keys(item.stats || {}),
        ...Object.keys(item.maxStats || {})
      ])
    )
  ).filter(key => key !== '기본효과');

  let bodyHtml = '';

  // Render combat stats rows
  allStatKeys.forEach(key => {
    const label = statNameMap[key] || key.toUpperCase();
    // Highlight by the max-limit (맥스) value that's prominently displayed, falling
    // back to the base range max when no limit exists. Keeps the highlighted value
    // consistent with what the user sees.
    const cmpVals = compareBasket.map(item => {
      const limit = getMaxBaseStatValue(item.maxStats?.[key]);
      return limit > 0 ? limit : getMaxBaseStatValue(item.stats?.[key]);
    });
    const highestVal = Math.max(...cmpVals);

    bodyHtml += `
      <tr class="stat-row">
        <td class="py-3 px-5 stat-label-col text-slate-400 font-bold">${escapeHtml(label)}</td>
    `;

    compareBasket.forEach((item, index) => {
      const baseVal = item.stats?.[key] || '-';
      const limitVal = item.maxStats?.[key];
      const currentValParsed = cmpVals[index];

      const isWinner = highestVal > 0 && currentValParsed === highestVal;
      const highlightClass = isWinner ? 'bg-blue-500/10 text-yellow-400 font-black border-x border-blue-500/20' : 'text-slate-300';

      bodyHtml += `
        <td class="py-3 px-5 text-center stat-val-col border-l border-white/5 ${highlightClass}">
          <div>${escapeHtml(baseVal)}</div>
          ${limitVal ? `<span class="text-[10px] text-emerald-400 font-black block mt-0.5">(맥스 ${escapeHtml(limitVal)})</span>` : ''}
        </td>
      `;
    });

    bodyHtml += `</tr>`;
  });

  // Render generic requirement metadata rows
  const metaRows = [
    { label: '장착 레벨', key: 'levelReq' },
    { label: '요구 능력치', key: 'statReq' },
    { label: '합성 횟수 (Synth)', key: 'synth' },
    { label: '딜레이', key: 'delay' }
  ];

  metaRows.forEach(meta => {
    bodyHtml += `
      <tr class="stat-row border-t border-white/10 bg-slate-900/20">
        <td class="py-3 px-5 stat-label-col text-slate-500 font-extrabold uppercase tracking-wider">${meta.label}</td>
    `;

    compareBasket.forEach(item => {
      const val = (item as any)[meta.key] || '-';
      bodyHtml += `
        <td class="py-3 px-5 text-center text-xs font-bold text-slate-400 border-l border-white/5">${escapeHtml(val)}</td>
      `;
    });

    bodyHtml += `</tr>`;
  });

  tbody.innerHTML = bodyHtml;

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

/** Map dictionary item category/group to evolution calculator parameters */
function mapEquipmentToEvoParams(item: EquipmentItem): { category: string; part: string } | null {
  if (item.group === '무기') {
    return { category: 'weapon', part: '' };
  }
  if (item.group === '손목') {
    return { category: 'equipment', part: 'shield' };
  }
  if (item.part) {
    const partMap: Record<string, string> = {
      'helm': 'helm',
      'amulet': 'amulet',
      'armor': 'armor',
      'gauntlet': 'gloves',
      'boots': 'boots',
      'wing': 'wings'
    };
    const part = partMap[item.part];
    if (part) {
      return { category: 'equipment', part };
    }
  }
  return null;
}

// Kickstart
window.onload = initEquipmentDic;
