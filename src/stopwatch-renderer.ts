// @ts-nocheck
// 시간 측정 및 기록 조회 렌더러 (전역 충돌 회피 버전)

interface TimerRecord {
  id?: number;
  date: string;
  duration: number;
  title: string;
  series: string;
  core_master: string;
  coefficient: number;
  char_main: number;
  char_sub: number;
  base_main: number;
  enchant_main: number;
  base_sub: number;
  enchant_sub: number;
  accuracy: number;
  raw_profile_data: string;
}

const STOPWATCH_PROFILES_KEY = 'tw-coefficient-calculator-profiles-v1';

const stopwatchStatNames: Record<string, string[]> = {
  stab: ['찌르기', '베기'], hack: ['베기', '찌르기'], phycomp: ['찌르기', '베기'],
  magatk: ['마공', '마방'], maghack: ['베기', '마공'], magdef: ['마방', '마공']
};

const stopwatchCategories = [
  { id: 'helm', source: 'defense', key: '투구' }, { id: 'armor', source: 'armors', isNested: true },
  { id: 'weapon', source: 'weapons', isNested: true }, { id: 'wrist', source: 'wrists', isNested: true },
  { id: 'amulet', source: 'defense', key: '머리' }, { id: 'wing', source: 'defense', key: '몸' },
  { id: 'gauntlet', source: 'defense', key: '손' }, { id: 'boots', source: 'defense', key: '다리' },
  { id: 'artifact', source: 'artifacts', isNested: true }
];

const activeDetailIds = new Set<number>();
let timerIsRunningLocal = false;
let stopwatchStartTime = 0;
let stopwatchActiveBuffs: any[] = [];

// 엘리먼트 참조
const btnToggleTimer = document.getElementById('btn-toggle-timer') as HTMLButtonElement;
const btnIcon = document.getElementById('btn-icon') as HTMLElement;
const btnText = document.getElementById('btn-text') as HTMLElement;
const btnOpenCalc = document.getElementById('btn-open-calc') as HTMLButtonElement;
const btnToggleGuide = document.getElementById('btn-toggle-guide') as HTMLButtonElement;
const guidePanel = document.getElementById('guide-panel') as HTMLElement;
const statusIconIdle = document.getElementById('status-icon-idle') as HTMLElement;
const statusIconRunning = document.getElementById('status-icon-running') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const recordTbody = document.getElementById('record-tbody') as HTMLTableSectionElement;
const recordCount = document.getElementById('record-count') as HTMLElement;

// 초기화
async function initStopwatch() {
  try {
    // 버프 정보 로드
    stopwatchActiveBuffs = await fetch('./assets/data/buffs.json').then(r => r.json());
  } catch (e) {
    console.error('Failed to load buffs data in stopwatch:', e);
  }

  // 이벤트 바인딩
  btnToggleTimer?.addEventListener('click', handleToggleTimerClick);
  btnOpenCalc?.addEventListener('click', () => {
    if ((window as any).electronAPI && (window as any).electronAPI.toggleCoefficientCalculator) {
      (window as any).electronAPI.toggleCoefficientCalculator();
    }
  });
  btnToggleGuide?.addEventListener('click', () => {
    guidePanel?.classList.toggle('hidden');
  });

  // IPC 바인딩
  if ((window as any).electronAPI) {
    (window as any).electronAPI.onTimerToggle((state: 'start' | 'stop' | 'toggle') => {
      if (state === 'start') {
        startTimerLocal();
      } else if (state === 'stop') {
        stopTimerLocal();
      } else if (state === 'toggle') {
        if (timerIsRunningLocal) {
          (window as any).electronAPI.timerToggleSession('stop');
          stopTimerLocal();
        } else {
          (window as any).electronAPI.timerToggleSession('start');
          startTimerLocal();
        }
      }
    });

    (window as any).electronAPI.onTimerUpdated(() => {
      fetchRecords();
    });
  }

  // 초기 기록 조회
  fetchRecords();
  if ((window as any).lucide) (window as any).lucide.createIcons();
}

// 기록 조회 및 렌더링
function fetchRecords() {
  if (!(window as any).electronAPI || !(window as any).electronAPI.timerGetRecords) return;
  
  (window as any).electronAPI.timerGetRecords().then((records: TimerRecord[]) => {
    renderTable(records);
  }).catch((err: any) => {
    console.error('Failed to fetch timer records:', err);
  });
}

function renderTable(records: TimerRecord[]) {
  if (!recordTbody) return;
  recordTbody.innerHTML = '';
  
  if (recordCount) {
    recordCount.innerText = `총 ${records.length}건`;
  }

  if (records.length === 0) {
    recordTbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-10 text-slate-500 font-medium">시간 측정 기록이 존재하지 않습니다.</td>
      </tr>
    `;
    return;
  }

  records.forEach(rec => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors group';
    
    // 시간 포맷
    const formattedDuration = formatDuration(rec.duration);
    
    // 계열 선택란
    const seriesOptions = Object.keys(stopwatchStatNames).map(k => {
      const label = k === 'stab' ? '찌르기' :
                    k === 'hack' ? '베기' :
                    k === 'phycomp' ? '물리복합' :
                    k === 'magatk' ? '마법공격' :
                    k === 'maghack' ? '마법베기' : '마법방어';
      return `<option value="${k}" ${rec.series === k ? 'selected' : ''}>${label}</option>`;
    }).join('');

    // 코어 마스터 선택란
    const coreOptions = [
      { val: 'mercurial', label: '머큐리얼' },
      { val: 'abyss', label: '어비스' },
      { val: 'eclipse', label: '이클립스' },
      { val: 'rubicona', label: '루비코나' },
      { val: 'none', label: '없음' }
    ].map(c => `<option value="${c.val}" ${rec.core_master === c.val ? 'selected' : ''}>${c.label}</option>`).join('');

    const mainLabel = stopwatchStatNames[rec.series]?.[0] || '주스텟';
    const subLabel = stopwatchStatNames[rec.series]?.[1] || '부스텟';

    const isExpanded = activeDetailIds.has(rec.id!);

    tr.innerHTML = `
      <td class="py-3 px-3 text-slate-400 font-mono whitespace-nowrap">${rec.date}</td>
      <td class="py-3 px-2 font-black text-indigo-300 font-mono">${formattedDuration}</td>
      <td class="py-3 px-2">
        <div class="flex items-center gap-1.5 no-drag w-full overflow-hidden">
          <span class="record-title truncate max-w-full font-semibold text-slate-200 cursor-pointer hover:text-indigo-400" data-id="${rec.id}">${window.escapeHtml(rec.title) || '<span class="text-slate-600 italic">제목 없음</span>'}</span>
          <i data-lucide="edit-2" class="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"></i>
        </div>
      </td>
      <td class="py-2.5 px-2 no-drag">
        <select class="series-select w-full bg-slate-900 border border-white/10 text-slate-300 rounded px-1 py-0.5 text-xs focus:border-indigo-500" data-id="${rec.id}">
          ${seriesOptions}
        </select>
      </td>
      <td class="py-2.5 px-2 no-drag">
        <select class="core-select w-full bg-slate-900 border border-white/10 text-slate-300 rounded px-1 py-0.5 text-xs focus:border-indigo-500" data-id="${rec.id}">
          ${coreOptions}
        </select>
      </td>
      <td class="py-3 px-2 text-right font-bold text-slate-200 font-mono">${rec.coefficient.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
      <td class="py-3 px-2 text-center no-drag">
        <button class="btn-toggle-detail w-6 h-6 rounded-lg bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center text-indigo-300 hover:bg-indigo-500 hover:text-white transition-all" data-id="${rec.id}" title="상세 스탯 정보 토글">
          <i data-lucide="eye" class="w-3.5 h-3.5"></i>
        </button>
      </td>
      <td class="py-3 px-3 text-center no-drag">
        <button class="btn-delete-record text-slate-500 hover:text-rose-400 transition-colors p-1 rounded hover:bg-white/5 active:scale-95" data-id="${rec.id}">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </td>
    `;
    
    // 한글 레이블 매핑
    const seriesKor: Record<string, string> = {
      stab: '찌르기', hack: '베기', phycomp: '물리복합',
      magatk: '마법공격', maghack: '마법베기', magdef: '마법방어'
    };
    const coreKor: Record<string, string> = {
      mercurial: '머큐리얼', abyss: '어비스', eclipse: '이클립스',
      rubicona: '루비코나', none: '없음'
    };
    const displaySeries = seriesKor[rec.series] || rec.series;
    const displayCore = coreKor[rec.core_master] || rec.core_master;

    // 상세 아코디언 행(Detail Row) 빌드
    const trDetail = document.createElement('tr');
    trDetail.className = `detail-row bg-slate-950/20 ${isExpanded ? '' : 'hidden'}`;
    trDetail.id = `detail-${rec.id}`;
    
    trDetail.innerHTML = `
      <td colspan="8" class="p-3 border-b border-white/[0.02]">
        <div class="grid grid-cols-3 gap-4 bg-slate-900/60 border border-white/[0.04] rounded-xl p-3.5 text-xs">
          <!-- 주스텟 카드 -->
          <div class="flex flex-col gap-1.5 bg-indigo-500/5 border border-indigo-500/10 rounded-lg p-2.5">
            <span class="font-bold text-indigo-300 border-b border-indigo-500/20 pb-1 mb-1 flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
              ${mainLabel} 세부 정보
            </span>
            <div class="flex justify-between text-slate-400"><span>캐릭터 ${mainLabel}:</span><span class="font-mono text-slate-200 font-bold">${rec.char_main}</span></div>
            <div class="flex justify-between text-slate-400"><span>장비 ${mainLabel}:</span><span class="font-mono text-slate-200 font-bold">${rec.base_main}</span></div>
            <div class="flex justify-between text-slate-400"><span>강화 ${mainLabel}:</span><span class="font-mono text-purple-300 font-bold">+${rec.enchant_main}</span></div>
            <div class="h-px bg-white/5 my-0.5"></div>
            <div class="flex justify-between text-slate-300 font-bold"><span class="text-indigo-300">최종 ${mainLabel}:</span><span class="font-mono text-white">${rec.char_main + rec.base_main + rec.enchant_main} <span class="text-[10px] text-slate-500 font-normal">(${rec.char_main}/${rec.base_main + rec.enchant_main})</span></span></div>
          </div>
          <!-- 부스텟 카드 -->
          <div class="flex flex-col gap-1.5 bg-purple-500/5 border border-purple-500/10 rounded-lg p-2.5">
            <span class="font-bold text-purple-300 border-b border-purple-500/20 pb-1 mb-1 flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-purple-400"></span>
              ${subLabel} 세부 정보
            </span>
            <div class="flex justify-between text-slate-400"><span>캐릭터 ${subLabel}:</span><span class="font-mono text-slate-200 font-bold">${rec.char_sub}</span></div>
            <div class="flex justify-between text-slate-400"><span>장비 ${subLabel}:</span><span class="font-mono text-slate-200 font-bold">${rec.base_sub}</span></div>
            <div class="flex justify-between text-slate-400"><span>강화 ${subLabel}:</span><span class="font-mono text-purple-300 font-bold">+${rec.enchant_sub}</span></div>
            <div class="h-px bg-white/5 my-0.5"></div>
            <div class="flex justify-between text-slate-300 font-bold"><span class="text-purple-300">최종 ${subLabel}:</span><span class="font-mono text-white">${rec.char_sub + rec.base_sub + rec.enchant_sub} <span class="text-[10px] text-slate-500 font-normal">(${rec.char_sub}/${rec.base_sub + rec.enchant_sub})</span></span></div>
          </div>
          <!-- 기타 정보 카드 -->
          <div class="flex flex-col gap-1.5 bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-2.5">
            <span class="font-bold text-emerald-300 border-b border-emerald-500/20 pb-1 mb-1 flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              기타 전투 정보
            </span>
            <div class="flex justify-between text-slate-400"><span>최종 명중(DEX):</span><span class="font-mono text-emerald-400 font-black">${rec.accuracy}</span></div>
            <div class="flex justify-between text-slate-400"><span>계열 정보:</span><span class="font-mono text-slate-200 font-bold">${displaySeries}</span></div>
            <div class="flex justify-between text-slate-400"><span>코어 상태:</span><span class="font-mono text-slate-200 font-bold">${displayCore}</span></div>
          </div>
        </div>
      </td>
    `;

    recordTbody.appendChild(tr);
    recordTbody.appendChild(trDetail);
  });

  if ((window as any).lucide) (window as any).lucide.createIcons();

  // 이벤트 핸들러 추가
  attachTableEvents();
}

function attachTableEvents() {
  // 제목 수정 (더블클릭 및 연필 아이콘)
  const titleSpans = recordTbody.querySelectorAll('.record-title');
  titleSpans.forEach(span => {
    const parent = span.parentElement;
    const triggerEdit = () => {
      const id = Number(span.getAttribute('data-id'));
      const oldTitle = span.textContent || '';
      
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'bg-slate-900 border border-indigo-500/50 text-white rounded px-1 py-0.5 text-xs w-full focus:outline-none';
      input.value = oldTitle === '제목 없음' ? '' : oldTitle;
      
      const saveTitle = () => {
        const newTitle = input.value.trim();
        if (newTitle !== oldTitle) {
          if ((window as any).electronAPI && (window as any).electronAPI.timerUpdateTitle) {
            (window as any).electronAPI.timerUpdateTitle(id, newTitle);
          }
        } else {
          // 값 변경이 없으면 원래 복구
          fetchRecords();
        }
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveTitle();
        if (e.key === 'Escape') fetchRecords();
      });
      input.addEventListener('blur', saveTitle);

      if (parent) {
        parent.innerHTML = '';
        parent.appendChild(input);
        input.focus();
      }
    };

    span.addEventListener('dblclick', triggerEdit);
    const editIcon = parent?.querySelector('[data-lucide="edit-2"]');
    if (editIcon) {
      editIcon.addEventListener('click', triggerEdit);
    }
  });

  // 계열 변경
  const seriesSelects = recordTbody.querySelectorAll('.series-select');
  seriesSelects.forEach(select => {
    select.addEventListener('change', (e) => {
      const id = Number(select.getAttribute('data-id'));
      const el = e.target as HTMLSelectElement;
      const newSeries = el.value;
      updateRecordSeriesAndCore(id, newSeries, null);
    });
  });

  // 코어 변경
  const coreSelects = recordTbody.querySelectorAll('.core-select');
  coreSelects.forEach(select => {
    select.addEventListener('change', (e) => {
      const id = Number(select.getAttribute('data-id'));
      const el = e.target as HTMLSelectElement;
      const newCore = el.value;
      updateRecordSeriesAndCore(id, null, newCore);
    });
  });

  // 삭제 버튼
  const deleteBtns = recordTbody.querySelectorAll('.btn-delete-record');
  deleteBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-id'));
      if (confirm('이 측정 기록을 삭제하시겠습니까?')) {
        if ((window as any).electronAPI && (window as any).electronAPI.timerDeleteRecord) {
          (window as any).electronAPI.timerDeleteRecord(id);
        }
      }
    });
  });

  // 스탯 상세 정보 아코디언 토글 제어
  const toggleBtns = recordTbody.querySelectorAll('.btn-toggle-detail');
  toggleBtns.forEach(btnEl => {
    const btn = btnEl as HTMLButtonElement;
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-id'));
      const detailRow = document.getElementById(`detail-${id}`);
      if (detailRow) {
        const isHidden = detailRow.classList.toggle('hidden');
        if (isHidden) {
          activeDetailIds.delete(id);
        } else {
          activeDetailIds.add(id);
        }
      }
    });
  });
}

// 계열/코어 변경 시 재계산 및 DB 갱신
function updateRecordSeriesAndCore(id: number, series: string | null, core: string | null) {
  if (!(window as any).electronAPI || !(window as any).electronAPI.timerGetRecords) return;

  (window as any).electronAPI.timerGetRecords().then((records: TimerRecord[]) => {
    const rec = records.find(r => r.id === id);
    if (!rec) return;

    const currentSeries = series || rec.series;
    const currentCore = core || rec.core_master;

    // 프로필 데이터 파싱
    let profileData: any = null;
    try {
      profileData = JSON.parse(rec.raw_profile_data);
    } catch (e) {
      console.error('Failed to parse raw profile data for recalculation:', e);
      return;
    }

    // 계수 재계산
    const calcResult = recalculateStatsAndCoefficient(profileData, currentSeries, currentCore);

    if ((window as any).electronAPI.timerUpdateSeriesCore) {
      (window as any).electronAPI.timerUpdateSeriesCore(
        id, 
        currentSeries, 
        currentCore, 
        calcResult.coefficient,
        calcResult.charMain,
        calcResult.charSub,
        calcResult.baseMain,
        calcResult.enchantMain,
        calcResult.baseSub,
        calcResult.enchantSub,
        calcResult.totalHit
      );
    }
  });
}

// 타이머 조작 버튼 클릭 핸들러
function handleToggleTimerClick() {
  if (timerIsRunningLocal) {
    if ((window as any).electronAPI && (window as any).electronAPI.timerToggleSession) {
      (window as any).electronAPI.timerToggleSession('stop');
    }
    stopTimerLocal();
  } else {
    if ((window as any).electronAPI && (window as any).electronAPI.timerToggleSession) {
      (window as any).electronAPI.timerToggleSession('start');
    }
    startTimerLocal();
  }
}

// 로컬 시작 처리
function startTimerLocal() {
  if (timerIsRunningLocal) return;
  timerIsRunningLocal = true;
  stopwatchStartTime = Date.now();

  // UI 변경
  if (statusIconIdle) statusIconIdle.classList.add('hidden');
  if (statusIconRunning) statusIconRunning.classList.remove('hidden');
  if (statusText) statusText.innerText = '시간 측정 중...';
  
  if (btnToggleTimer) {
    btnToggleTimer.classList.remove('bg-indigo-600', 'hover:bg-indigo-500');
    btnToggleTimer.classList.add('bg-rose-600', 'hover:bg-rose-500', 'shadow-rose-950/30');
  }
  if (btnText) btnText.innerText = '측정 종료';
  if (btnIcon) {
    btnIcon.setAttribute('data-lucide', 'square');
  }
  if ((window as any).lucide) (window as any).lucide.createIcons();
}

// 로컬 종료 및 DB 저장 처리
function stopTimerLocal() {
  if (!timerIsRunningLocal) return;
  timerIsRunningLocal = false;
  const duration = Date.now() - stopwatchStartTime;

  // UI 변경
  if (statusIconIdle) statusIconIdle.classList.remove('hidden');
  if (statusIconRunning) statusIconRunning.classList.add('hidden');
  if (statusText) statusText.innerText = '대기 중';
  
  if (btnToggleTimer) {
    btnToggleTimer.classList.remove('bg-rose-600', 'hover:bg-rose-500', 'shadow-rose-950/30');
    btnToggleTimer.classList.add('bg-indigo-600', 'hover:bg-indigo-500', 'shadow-indigo-900/30');
  }
  if (btnText) btnText.innerText = '측정 시작';
  if (btnIcon) {
    btnIcon.setAttribute('data-lucide', 'play');
  }
  if ((window as any).lucide) (window as any).lucide.createIcons();

  // 계수 계산기 프로필 데이터 캡처하여 스탯 및 계수 추출
  saveRecordToDb(duration);
}

function saveRecordToDb(duration: number) {
  // 계수 계산기 로컬스토리지에서 최신 설정 가져오기
  const profilesRaw = localStorage.getItem(STOPWATCH_PROFILES_KEY);
  const lastProfileId = localStorage.getItem(STOPWATCH_PROFILES_KEY + '_last') || 'default';
  
  let currentProfile: any = null;
  if (profilesRaw) {
    try {
      const profiles = JSON.parse(profilesRaw);
      currentProfile = profiles[lastProfileId];
    } catch (e) {
      console.error('Failed to parse profiles from localStorage', e);
    }
  }

  // 만약 저장된 프로필이 없으면 더미 데이터 구성
  if (!currentProfile) {
    currentProfile = {
      id: 'default',
      name: '기본 프로필',
      data: {
        stats: { stab: '0', hack: '0', int: '0', mr: '0', dex: '0' },
        bonuses: {},
        gears: {},
        upgradesMain: {},
        upgradesSub: {},
        abilsStat: {},
        abilsHit: {},
        currentType: 'stab',
        mainCore: 'none'
      }
    };
  }

  const pData = currentProfile.data;
  const currentSeries = pData.currentType || 'stab';
  const currentCore = pData.mainCore || 'none';

  // 스탯 및 계수 계산
  const calcResult = recalculateStatsAndCoefficient(pData, currentSeries, currentCore);

  const now = new Date();
  const dateStr = formatDate(now);

  const record: Omit<TimerRecord, 'id'> = {
    date: dateStr,
    duration: duration,
    title: '', // 기본은 빈값
    series: currentSeries,
    core_master: currentCore,
    coefficient: calcResult.coefficient,
    char_main: calcResult.charMain,
    char_sub: calcResult.charSub,
    base_main: calcResult.baseMain,
    enchant_main: calcResult.enchantMain,
    base_sub: calcResult.baseSub,
    enchant_sub: calcResult.enchantSub,
    accuracy: calcResult.totalHit,
    raw_profile_data: JSON.stringify(pData)
  };

  if ((window as any).electronAPI && (window as any).electronAPI.timerSaveRecord) {
    (window as any).electronAPI.timerSaveRecord(record);
  }
}

// 최종 스탯 및 계수 계산 공식 (이식)
function recalculateStatsAndCoefficient(pData: any, currentSeries: string, currentCore: string) {
  // 1. 도핑 보너스 계산 (bFix, bPct)
  const presetId = pData.buffPreset || 'none';
  let buffIds: string[] = [];
  if (presetId === 'standard') {
    buffIds = [...window.buffConstants.STANDARD_BUFFS];
  } else if (presetId !== 'none') {
    const savedPresets = localStorage.getItem('buff_presets');
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
    const b = stopwatchActiveBuffs.find(x => x.id === id);
    if (b && b.effects) {
      if (b.effects.stat) bFix += b.effects.stat;
      if (b.effects.statRate) bPct += b.effects.statRate;
    }
  });

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
    coefficient: totalCoeff
  };
}

// 유틸리티 포맷 함수
function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

window.addEventListener('DOMContentLoaded', initStopwatch);
