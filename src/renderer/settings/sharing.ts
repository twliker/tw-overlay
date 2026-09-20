/** 기존 저장 설정을 파일로 교환한다. 가져오기는 최신 저장값과 비교하며 설정 화면의 초안은 유지한다. */
(() => {
  const api = window.electronAPI as typeof window.electronAPI & import('../../shared/companionFiles').CompanionFilesApi;
  const root = document.getElementById('settings-share-card');
  if (!root) return;
  const status = document.getElementById('settings-share-status')!;
  const panel = document.getElementById('settings-share-review')!;
  const choices = document.getElementById('settings-share-import-groups')!;
  const changes = document.getElementById('settings-share-changes')!;
  const apply = document.getElementById('settings-share-apply') as HTMLButtonElement;
  const names = { layout: '배치', appearance: '외관', alerts: '알림' };
  let token = '', busy = false, reviewed = false;
  const selected = (selector: string) => Array.from(root.querySelectorAll<HTMLInputElement>(selector)).filter(input => input.checked).map(input => input.value as import('../../shared/companionFiles').ShareGroup);
  function reset(): void { token = ''; reviewed = false; panel.hidden = true; changes.replaceChildren(); apply.disabled = true; }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    root!.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button, input').forEach(element => { element.disabled = true; });
    try { await action(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : '처리하지 못했습니다. 다시 시도해 주세요.'; }
    finally {
      busy = false;
      root!.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button, input').forEach(element => { element.disabled = false; });
      apply.disabled = !reviewed;
    }
  }
  document.getElementById('settings-share-export')?.addEventListener('click', () => void run(async () => {
    const result = await api.exportSettingsShare(selected('[data-share-export]'));
    status.textContent = result.success ? '선택한 저장 설정을 파일로 저장했습니다.' : result.canceled ? '파일 저장을 취소했습니다.' : result.error || '저장하지 못했습니다.';
  }));
  document.getElementById('settings-share-open')?.addEventListener('click', () => void run(async () => {
    const result = await api.openSettingsShare();
    if (!result.success || !result.token || !result.groups) { status.textContent = result.canceled ? '파일 선택을 취소했습니다.' : result.error || '파일을 읽지 못했습니다.'; return; }
    reset(); token = result.token; panel.hidden = false; choices.replaceChildren();
    for (const group of result.groups) {
      const label = document.createElement('label'); label.className = 'ui-filter-choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = group; input.checked = true; input.dataset.shareImport = '';
      input.addEventListener('change', () => { reviewed = false; apply.disabled = true; changes.replaceChildren(); });
      label.append(input, names[group]); choices.append(label);
    }
    status.textContent = '가져올 항목을 선택하고 변경 내용을 비교해 주세요.';
  }));
  document.getElementById('settings-share-compare')?.addEventListener('click', () => void run(async () => {
    reviewed = false; changes.replaceChildren();
    const result = await api.previewSettingsShare(token, selected('[data-share-import]'));
    if (!result.success) { status.textContent = result.error || '비교하지 못했습니다.'; return; }
    for (const change of result.changes || []) {
      const row = document.createElement('div'); row.className = 'ui-inset ui-stack';
      const title = document.createElement('strong'); title.className = 'ui-heading'; title.textContent = `${names[change.group]} · ${change.label}`;
      const before = document.createElement('p'); before.className = 'ui-description'; before.textContent = `현재: ${change.before}`;
      const after = document.createElement('p'); after.className = 'ui-description'; after.textContent = `변경: ${change.after}`;
      row.append(title, before, after); changes.append(row);
    }
    reviewed = !!result.changes?.length;
    status.textContent = reviewed ? `${result.changes!.length}개 항목이 바뀝니다. 내용을 확인한 뒤 적용해 주세요.` : '선택한 설정이 현재와 같습니다.';
  }));
  apply.addEventListener('click', () => void run(async () => {
    const result = await api.applySettingsShare(token);
    if (result.success) { reset(); status.textContent = '설정을 적용했습니다. 입력 중이던 미저장 설정은 유지됩니다.'; }
    else { reviewed = false; status.textContent = result.error || '적용하지 못했습니다. 다시 비교해 주세요.'; }
  }));
  document.getElementById('settings-share-cancel')?.addEventListener('click', () => { reset(); status.textContent = '가져오기를 취소했습니다.'; });
})();
