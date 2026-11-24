(() => {
  const opener = document.querySelector<HTMLButtonElement>('[data-monitor-preferences]');
  const api = window.electronAPI as typeof window.electronAPI & {
    getConfig(): Promise<Partial<BrowserAppConfig>>;
    saveMonitorPreferences(added:string[],removed:string[],serverChange?:[string,string]):Promise<{success:boolean;error?:string}>;
    onOpenMonitorSettings(callback: () => void): void;
  };
  if (!opener || !api) return;

  const trade = opener.dataset.monitorPreferences === 'trade';
  const dialog = document.createElement('dialog');
  dialog.className = 'nickname-note-dialog monitor-preferences ui-card';
  dialog.innerHTML = `<form class="ui-stack"><h2 class="ui-heading"></h2>
    <fieldset class="ui-stack" disabled>
      <label class="ui-field monitor-server">모니터링 서버<select class="ui-input">
        <option value="RyXp">하이아칸</option><option value="Siwv">네냐플</option>
      </select></label>
      <label class="ui-field">알림 키워드<input class="ui-input" maxlength="500" placeholder="키워드 입력"></label>
      <button class="ui-button" type="button" data-add>추가</button>
      <ul class="ui-actions" aria-label="등록한 키워드"></ul>
    </fieldset>
    <p class="ui-description" role="status" aria-live="polite"></p>
    <div class="ui-actions"><button class="ui-button" type="button" data-close>닫기</button>
      <button class="ui-button ui-button-primary" type="submit">저장</button></div></form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form')!;
  const fields = dialog.querySelector('fieldset')!;
  const serverLabel = dialog.querySelector<HTMLElement>('.monitor-server')!;
  const server = dialog.querySelector('select')!;
  const input = dialog.querySelector('input')!;
  const list = dialog.querySelector('ul')!;
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const close = dialog.querySelector<HTMLButtonElement>('[data-close]')!;
  const save = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  let keywords: string[] = [];
  let baselineKeywords: string[] = [];
  let baselineServer: BrowserAppConfig['tradeServer'];
  let saving = false;
  let loadRevision = 0;
  dialog.querySelector('h2')!.textContent = trade ? '거래 게시판 설정' : '갤러리 알림 설정';
  serverLabel.hidden = !trade;
  serverLabel.classList.toggle('hidden', !trade);

  function render(): void {
    list.replaceChildren();
    for (const keyword of keywords) {
      const row = document.createElement('li');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ui-chip';
      remove.textContent = keyword + ' ×';
      remove.setAttribute('aria-label', keyword + ' 삭제');
      remove.addEventListener('click', () => {
        keywords = keywords.filter(value => value !== keyword);
        render();
      });
      row.appendChild(remove);
      list.appendChild(row);
    }
  }

  function addKeyword(): void {
    const value = input.value.trim();
    if (value && !keywords.includes(value)) keywords.push(value);
    input.value = '';
    render();
  }

  async function open(): Promise<void> {
    if (dialog.open) return;
    const revision = ++loadRevision;
    fields.disabled = save.disabled = true;
    status.textContent = '설정을 불러오는 중…';
    input.value = '';
    keywords = [];
    render();
    dialog.showModal();
    try {
      const config = await api.getConfig();
      if (!dialog.open || revision !== loadRevision) return;
      keywords = [...(trade ? config.tradeKeywords ?? [] : config.galleryKeywords ?? [])];
      baselineKeywords = [...keywords];
      baselineServer = config.tradeServer ?? 'RyXp';
      server.value = baselineServer;
      render();
      fields.disabled = save.disabled = false;
      status.textContent = '';
      input.focus();
    } catch {
      if (dialog.open && revision === loadRevision) status.textContent = '설정을 불러오지 못했습니다. 다시 열어 주세요.';
    }
  }

  opener.addEventListener('click', open);
  api.onOpenMonitorSettings?.(open);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => {
    if (!dialog.open || event.key !== 'Escape') return;
    event.stopPropagation();
    if (document.querySelector('select:open')) return;
    event.preventDefault();
    if (!saving) dialog.close();
  });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.querySelector('[data-add]')!.addEventListener('click', addKeyword);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    addKeyword();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || save.disabled) return;
    addKeyword();
    const added=keywords.filter(value=>!baselineKeywords.includes(value));
    const removed=baselineKeywords.filter(value=>!keywords.includes(value));
    const serverChange:[string,string] | undefined=trade && baselineServer && server.value!==baselineServer
      ? [baselineServer,server.value] : undefined;
    if (!added.length && !removed.length && !serverChange) { dialog.close(); return; }
    saving = fields.disabled = close.disabled = save.disabled = true;
    status.textContent = '저장 중…';
    try {
      const result=await api.saveMonitorPreferences(added,removed,serverChange);
      if (result?.error==='server-changed') {
        status.textContent='다른 곳에서 서버를 변경했습니다. 창을 다시 열어 최신 설정을 확인해 주세요.';
        return;
      }
      if (!result?.success) throw new Error('save failed');
      dialog.close();
    } catch {
      status.textContent = '저장하지 못했습니다. 입력을 유지했습니다.';
    } finally {
      saving = fields.disabled = close.disabled = save.disabled = false;
    }
  });
})();
