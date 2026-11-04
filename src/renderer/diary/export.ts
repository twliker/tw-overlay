(() => {
  const api = window.electronAPI as typeof window.electronAPI & import('../../shared/companionFiles').CompanionFilesApi;
  const dialog = document.getElementById('diary-export-dialog') as HTMLDialogElement;
  if (!dialog) return;
  const start = document.getElementById('diary-export-start') as HTMLInputElement;
  const end = document.getElementById('diary-export-end') as HTMLInputElement;
  const status = document.getElementById('diary-export-status')!;
  const save = document.getElementById('diary-export-save') as HTMLButtonElement;
  const profile=document.getElementById('diary-export-profile');
  const view=window.diaryProfileView;
  let token = '', generation = 0, busy = false;
  let previewFilter:import('../../shared/diaryProfiles').DiaryProfileFilter | undefined,previewLabel='';
  const filterKey=() => JSON.stringify(view?.filter() || {kind:'all'});
  let scopeKey=filterKey();
  const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function invalidate(): void {
    generation++;token='';previewFilter=undefined;previewLabel='';save.disabled=true;
    if (profile) profile.textContent=`조회 범위: ${view?.label() || '전체 기록'}`;
    status.textContent='기간을 정한 뒤 기록을 확인해 주세요.';
  }
  start.addEventListener('input', invalidate); end.addEventListener('input', invalidate);
  document.getElementById('diary-export-open')?.addEventListener('click', () => {
    const now = new Date(); start.value = dateKey(new Date(now.getFullYear(), now.getMonth(), 1)); end.value = dateKey(now);
    scopeKey=filterKey();invalidate();if (!dialog.open) dialog.showModal();
  });
  window.addEventListener('diary-profile-filter-changed',() => {
    if (scopeKey===filterKey()) return;
    scopeKey=filterKey();invalidate();
    if (dialog.open) status.textContent='조회 범위가 변경됐습니다. 기록을 다시 확인해 주세요.';
  });
  const close = () => { invalidate(); dialog.close(); };
  document.getElementById('diary-export-close')?.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(); });
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true; dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(node => { node.disabled = true; });
    try { await action(); }
    catch { status.textContent = '파일을 처리하지 못했습니다. 다시 시도해 주세요.'; }
    finally { busy = false; dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(node => { node.disabled = false; }); save.disabled = !token; }
  }
  document.getElementById('diary-export-preview')?.addEventListener('click', () => void run(async () => {
    invalidate(); const revision = generation;
    const filter=view?.filter();
    const result = await api.previewDiaryExport(start.value,end.value,filter);
    if (revision !== generation || !dialog.open) return;
    token = result.success ? result.token || '' : '';
    previewFilter=filter;previewLabel=result.profileLabel || '';
    status.textContent = result.success ? `${previewLabel ? previewLabel+' · ' : ''}${result.count!.toLocaleString('ko-KR')}건 · 총수익 ${result.totalSeed!.toLocaleString('ko-KR')} SEED. 확인한 기록을 파일로 저장합니다.` : result.error || '기록을 읽지 못했습니다.';
  }));
  save.addEventListener('click', () => void run(async () => {
    const savedLabel=previewLabel;
    const result = await api.saveDiaryExport(token,previewFilter);
    status.textContent = result.success ? `${savedLabel ? savedLabel+' 기록을 ' : ''}저장했습니다. 파일을 열면 브라우저에서 읽을 수 있습니다.` : result.canceled ? '파일 저장을 취소했습니다.' : result.error || '저장하지 못했습니다.';
  }));
})();
