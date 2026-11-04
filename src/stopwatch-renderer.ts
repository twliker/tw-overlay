// @ts-nocheck
// 시간 측정 및 기록 조회 렌더러 (전역 충돌 회피 버전)

type TimerRecord = import('./shared/types').TimerRecord;

const stopwatchStatNames: Record<string, string[]> = {
  stab: ['찌르기', '베기'], hack: ['베기', '찌르기'], phycomp: ['찌르기', '베기'],
  magatk: ['마공', '마방'], maghack: ['베기', '마공'], magdef: ['마방', '마공']
};

const activeDetailIds = new Set<number>();
let timerIsRunningLocal = false;
let stopwatchRevision = -1;
let stopwatchContext: import('./shared/types').StopwatchState | null=null;
let recordFilter='current',recordGeneration=0,controlPending=false,filterChosen=false;
let activeTitleEdit: {id:number;input:HTMLInputElement;done:boolean;saving:boolean} | null=null;
const recordTitles=new Map<number,string>();
const profileFilter=document.getElementById('stopwatch-record-filter') as HTMLSelectElement;

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
  // 이벤트 바인딩
  btnToggleTimer?.addEventListener('click', handleToggleTimerClick);
  document.getElementById('btn-select-profile')?.addEventListener('click',() => window.electronAPI.toggleProfiles());
  profileFilter?.addEventListener('change',() => {recordFilter=profileFilter.value;filterChosen=true;fetchRecords();});
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
    window.electronAPI.onTimerToggle(applyStopwatchState);
    window.electronAPI.timerGetState().then(applyStopwatchState).catch(showStopwatchError);

    (window as any).electronAPI.onTimerUpdated(() => {
      fetchRecords();
    });
  }

  // 초기 기록 조회
  if (!window.electronAPI?.timerGetState) fetchRecords();
  if ((window as any).lucide) (window as any).lucide.createIcons();
}

// 기록 조회 및 렌더링
function fetchRecords() {
  if (!(window as any).electronAPI || !(window as any).electronAPI.timerGetRecords) return;
  if (!stopwatchContext && window.electronAPI.timerGetState || activeTitleEdit) return;
  const generation=++recordGeneration;
  let request;
  if (!stopwatchContext?.profileMode) request=window.electronAPI.timerGetRecords();
  else {
    const filter=recordFilter==='all' ? {kind:'all'} : recordFilter==='unassigned' ? {kind:'unassigned'} : {kind:'profile',profileId:recordFilter==='current' ? stopwatchContext.profileId : recordFilter};
    request=filter.kind==='profile' && !filter.profileId ? Promise.resolve([]) : window.electronAPI.timerGetRecords(filter);
  }
  request.then((records: TimerRecord[]) => {
    if (generation!==recordGeneration || activeTitleEdit) return;
    renderTable(records);
  }).catch((err: any) => {
    if (generation===recordGeneration) showStopwatchError(err,'기록을 불러오지 못했습니다. 기록 보기를 다시 선택해 주세요.');
  });
}

function renderTable(records: TimerRecord[]) {
  if (!recordTbody) return;
  recordTbody.innerHTML = '';
  recordTitles.clear();
  
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
    recordTitles.set(rec.id,rec.title || '');
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
      <td class="py-3 px-3 text-slate-400 font-mono whitespace-nowrap"><span>${window.escapeHtml(rec.date)}</span>${stopwatchContext?.profileMode ? `<span class="block truncate text-xs text-indigo-300" title="${window.escapeHtml(recordOwnerLabel(rec))}">${window.escapeHtml(recordOwnerLabel(rec))}</span>` : ''}</td>
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
      if (activeTitleEdit) {activeTitleEdit.input.focus();return;}
      const id = Number(span.getAttribute('data-id'));
      const oldTitle = recordTitles.get(id) || '';
      
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'bg-slate-900 border border-indigo-500/50 text-white rounded px-1 py-0.5 text-xs w-full focus:outline-none';
      input.value = oldTitle;
      input.maxLength=300;input.setAttribute('aria-label','기록 제목');
      const edit={id,input,done:false,saving:false};activeTitleEdit=edit;
      ++recordGeneration;if (profileFilter) profileFilter.disabled=true;
      const finish=() => {
        edit.done=true;
        if (activeTitleEdit===edit) activeTitleEdit=null;
        if (profileFilter) profileFilter.disabled=false;
        fetchRecords();
      };
      const saveTitle = async () => {
        if (edit.done || edit.saving) return;
        const newTitle = input.value.trim();
        if (newTitle===oldTitle) {finish();return;}
        edit.saving=true;input.readOnly=true;
        try {
          if (stopwatchContext?.profileMode) {
            const result=await window.electronAPI.timerMutateRecord({kind:'title',id,title:newTitle});
            if (!result.success) throw new Error(result.error || '기록 제목을 저장하지 못했습니다.');
          } else window.electronAPI.timerUpdateTitle(id,newTitle);
          clearStopwatchError();finish();
        } catch (error) {
          showStopwatchError(error,'기록 제목을 저장하지 못했습니다. 입력은 유지됩니다. 다시 저장해 주세요.');
          input.readOnly=false;input.focus();
        } finally {edit.saving=false;}
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveTitle();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          // 실제 포커스 창에서는 재렌더로 입력란이 제거될 때 blur가 발생할 수 있다.
          if (!edit.saving) {clearStopwatchError();finish();}
        }
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
        if (stopwatchContext?.profileMode) void saveRecordChange({kind:'delete',id});
        else window.electronAPI.timerDeleteRecord(id);
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

// 재계산도 기록에 보관된 시작 시점의 프로필을 사용한다.
function updateRecordSeriesAndCore(id: number, series: string | null, core: string | null) {
  if (stopwatchContext?.profileMode) void saveRecordChange({kind:'recalculate',id,series,core});
  else window.electronAPI.timerUpdateSeriesCore(id, series, core);
}

async function saveRecordChange(change:import('./shared/types').StopwatchRecordMutation) {
  try {
    const result=await window.electronAPI.timerMutateRecord(change);
    if (!result.success) throw new Error(result.error || '측정 기록을 저장하지 못했습니다.');
    clearStopwatchError();
  } catch (error) {showStopwatchError(error,'측정 기록을 저장하지 못했습니다. 다시 시도해 주세요.');}
  finally {fetchRecords();}
}

function recordOwnerLabel(record:TimerRecord):string {
  if (!record.profile_id) return '미배정 기록';
  const owner=stopwatchContext?.profiles?.find(profile => profile.id===record.profile_id);
  return `${owner?.name || '기본 프로필'}${owner?.deletedAt ? ' (삭제됨)' : ''}`;
}

function updateRecordFilter() {
  if (!profileFilter) return;
  const choices=[['current','현재 프로필'],['all','모든 프로필'],['unassigned','미배정 기록'],
    ...(stopwatchContext?.profiles || []).map(profile => [profile.id,`${profile.name || '기본 프로필'} · ${profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '서버 미설정'}${profile.deletedAt ? ' (삭제됨)' : ''}`])];
  profileFilter.replaceChildren(...choices.map(([value,label]) => {const option=document.createElement('option');option.value=value;option.textContent=label;return option;}));
  profileFilter.value=recordFilter;profileFilter.disabled=!!activeTitleEdit;
}

function applyStopwatchState(state: import('./shared/types').StopwatchState) {
  if (state.revision <= stopwatchRevision) return;
  const previous=stopwatchContext;
  stopwatchRevision = state.revision;
  // 현재 프로필을 따라 보다가 A 제목을 편집했다면 전환 중에도 A 기록을 유지한다.
  if (activeTitleEdit && recordFilter==='current' && previous?.profileId && previous.profileId!==state.profileId) {recordFilter=previous.profileId;filterChosen=true;}
  if (!previous && state.profileMode && !state.profileId) recordFilter='all';
  if (state.profileId && !previous?.profileId && !filterChosen) recordFilter='current';
  stopwatchContext=state;
  if (state.running) startTimerLocal();
  else stopTimerLocal();
  document.getElementById('stopwatch-profile-bar')?.classList.toggle('hidden',!state.profileMode);
  document.getElementById('stopwatch-filter-bar')?.classList.toggle('hidden',!state.profileMode);
  document.getElementById('stopwatch-profile-guide')?.classList.toggle('hidden',!state.profileMode);
  const label=document.getElementById('stopwatch-profile-name');
  if (label) {label.textContent=state.profileId ? `측정 프로필 · ${state.profileName}` : '측정할 프로필을 선택해 주세요';label.title=label.textContent;}
  if (state.selectionRequired && statusText) statusText.innerText='프로필 선택 대기';
  updateControlAvailability();updateRecordFilter();
  if (!previous || previous.profileId!==state.profileId || JSON.stringify(previous.profiles)!==JSON.stringify(state.profiles)) {
    ++recordGeneration;fetchRecords();
  }
}

function showStopwatchError(error?:unknown,fallback='측정 상태를 변경하지 못했습니다. 다시 시도해 주세요.') {
  const el=document.getElementById('stopwatch-error');
  if (el) {el.textContent=error instanceof Error && !error.message.startsWith('Error invoking remote method') ? error.message : fallback;el.classList.remove('hidden');}
}
function clearStopwatchError() {document.getElementById('stopwatch-error')?.classList.add('hidden');}
function updateControlAvailability() {
  if (btnToggleTimer) btnToggleTimer.disabled=controlPending || !!(stopwatchContext?.profileMode && (!stopwatchContext.profileId || stopwatchContext.selectionRequired || stopwatchContext.busy));
}

async function handleToggleTimerClick() {
  if (btnToggleTimer.disabled) return;
  controlPending=true;updateControlAvailability();clearStopwatchError();
  try {
    const command=timerIsRunningLocal ? 'stop' : 'start';
    applyStopwatchState(await (stopwatchContext?.profileMode ? window.electronAPI.timerToggleSession(command,stopwatchContext.profileId) : window.electronAPI.timerToggleSession(command)));
  } catch (error) {showStopwatchError(error);}
  finally {controlPending=false;updateControlAvailability();}
}

// 로컬 시작 처리
function startTimerLocal() {
  if (timerIsRunningLocal) return;
  timerIsRunningLocal = true;

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

// 메인 프로세스가 확정한 종료 상태 표시
function stopTimerLocal() {
  timerIsRunningLocal = false;

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

}

// 유틸리티 포맷 함수
function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

window.addEventListener('DOMContentLoaded', initStopwatch);
