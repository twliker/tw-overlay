interface Window {
  nicknameNotes: {
    updateConfig(config: Partial<BrowserAppConfig>): void;
    appendBadge(container: HTMLElement, nickname: string): void;
  };
}

(() => {
  type Note = import('../shared/types').NicknameNote;
  const api = window.electronAPI as typeof window.electronAPI & {
    getNicknameInfo?(server: number, nickname: string): Promise<import('../shared/types').NicknameInfo>;
    saveNicknameNote(server: number, nickname: string, note: string): Promise<{ success: boolean; error?: string }>;
  };
  let server = 7;
  let notes: Note[] = [];
  let compact = false;
  const key = (value: string) => value.normalize('NFC').trim().toLocaleLowerCase('ko-KR');
  const find = (nickname: string) => notes.find(note => note.server === server && key(note.nickname) === key(nickname));
  const dialog = document.createElement('dialog');
  dialog.className = 'nickname-note-dialog';
  dialog.setAttribute('aria-label', '닉네임 정보·메모');
  dialog.innerHTML = `<form class="nickname-note-form"><div class="ui-card-header"><h2>닉네임 정보·메모</h2><span class="ui-chip">개인 메모</span></div><p id="note-server-label"></p>
    <label>닉네임<input id="note-nickname" class="ui-input" maxlength="40" required autocomplete="off"></label>
    <div class="ui-inset" aria-live="polite"><p id="note-character-info"></p><p id="note-info-date" class="note-help"></p></div>
    <label>메모<textarea id="note-text" class="ui-input" maxlength="200" rows="3" placeholder="거래했던 분, 클럽원 부캐 등"></textarea></label>
    <p class="note-help">닉네임 옆에는 짧게 표시하고, 마우스를 올리면 전체 내용을 보여 줍니다.</p>
    <p id="note-save-error" role="status"></p><div class="note-actions"><button type="button" id="note-remove" class="ui-button ui-button-danger">삭제</button><button type="button" id="note-cancel" class="ui-button">취소</button><button type="submit" id="note-save" class="ui-button ui-button-primary">저장</button></div></form>`;
  document.body.appendChild(dialog);
  const nicknameInput = dialog.querySelector<HTMLInputElement>('#note-nickname')!;
  const noteInput = dialog.querySelector<HTMLTextAreaElement>('#note-text')!;
  const error = dialog.querySelector<HTMLElement>('#note-save-error')!;
  const buttons = Array.from(dialog.querySelectorAll('button'));
  let editing: { server: number; saving: boolean } | undefined;
  let configRevision = 0;
  let nextSaveId = 0;
  const latestSaves = new Map<string, number>();
  let lookupId = 0;
  async function loadInfo(): Promise<void> {
    const requestedEdit = editing;
    const nickname = nicknameInput.value.trim();
    const request = ++lookupId;
    const info = dialog.querySelector<HTMLElement>('#note-character-info')!;
    const date = dialog.querySelector<HTMLElement>('#note-info-date')!;
    info.textContent = nickname ? '정보를 확인하고 있습니다.' : '닉네임을 입력하면 저장된 에타 자료에서 정보를 확인합니다.';
    date.textContent = '';
    if (!requestedEdit || !nickname) return;
    try {
      const result = await api.getNicknameInfo?.(requestedEdit.server, nickname);
      if (editing !== requestedEdit || request !== lookupId || nicknameInput.value.trim() !== nickname) return;
      const parts = [result?.characterName, result?.level != null ? `에타 ${result.level.toLocaleString()}` : null].filter(Boolean);
      info.textContent = parts.length ? parts.join(' · ') : '확인된 정보가 없습니다.';
      date.textContent = result?.collectDate
        ? `${result.collectDate} 기준${result.stale ? ' · 이전 자료입니다.' : ''}`
        : '저장된 에타 자료가 없습니다.';
    } catch {
      if (editing !== requestedEdit || request !== lookupId) return;
      info.textContent = '정보를 확인하지 못했습니다. 메모는 저장할 수 있습니다.';
    }
  }
  function close(): void { editing = undefined; dialog.close(); }
  function open(nickname = ''): void {
    editing = { server, saving: false };
    buttons.forEach(button => button.disabled = false);
    nicknameInput.value = nickname;
    nicknameInput.readOnly = Boolean(nickname);
    noteInput.value = find(nickname)?.note || '';
    dialog.querySelector('#note-server-label')!.textContent = server === 7 ? '하이아칸 · 내 개인 메모' : '네냐플 · 내 개인 메모';
    error.textContent = '';
    if (!dialog.open) dialog.showModal();
    (nickname ? noteInput : nicknameInput).focus();
    void loadInfo();
  }
  nicknameInput.addEventListener('input', () => { void loadInfo(); });
  /** 저장 요청은 당시 서버·닉네임·편집 세션에 고정한다. Escape 후 재열기나 대기 중 입력은
   * 이전 응답으로 닫거나 덮지 않는다. 최신 config-data/동일 닉네임의 새 저장을 지난 응답보다
   * 우선하고, 중복 제출은 현재 편집 세션 안에서만 막는다. 회귀: check-renderer-behavior.ts.
   */
  async function save(note: string): Promise<void> {
    const requestedEdit = editing;
    if (!requestedEdit || requestedEdit.saving) return;
    requestedEdit.saving = true;
    const requestedNickname = nicknameInput.value;
    const requestedText = noteInput.value;
    const requestedConfig = configRevision;
    const noteKey = `${requestedEdit.server}:${key(requestedNickname)}`;
    const saveId = ++nextSaveId;
    latestSaves.set(noteKey, saveId);
    error.textContent = '';
    buttons.forEach(button => button.disabled = true);
    try {
      const result = await api.saveNicknameNote(requestedEdit.server, requestedNickname, note);
      if (!result.success) {
        if (editing === requestedEdit) error.textContent = result.error || '저장하지 못했습니다.';
        return;
      }
      // 권위 있는 설정 갱신이 아직 없을 때만 요청 당시의 메모를 로컬 목록에 반영한다.
      if (configRevision === requestedConfig && latestSaves.get(noteKey) === saveId) {
        const nickname = requestedNickname.normalize('NFC').trim();
        notes = notes.filter(item => item.server !== requestedEdit.server || key(item.nickname) !== key(nickname));
        if (note.trim()) notes.push({ server: requestedEdit.server, nickname, note: note.trim() });
        refreshList();
      }
      if (editing === requestedEdit && nicknameInput.value === requestedNickname && noteInput.value === requestedText) close();
    } catch { if (editing === requestedEdit) error.textContent = '저장하지 못했습니다. 다시 시도하세요.'; }
    finally {
      if (latestSaves.get(noteKey) === saveId) latestSaves.delete(noteKey);
      if (editing === requestedEdit) {
        requestedEdit.saving = false;
        buttons.forEach(button => button.disabled = false);
      }
    }
  }
  dialog.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void save(noteInput.value); });
  // 메모 취소는 부모 설정/채팅 창의 Escape 닫기로 전파하지 않는다.
  dialog.addEventListener('keydown', event => {
    if (!dialog.open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  dialog.querySelector('#note-cancel')!.addEventListener('click', close);
  dialog.querySelector('#note-remove')!.addEventListener('click', () => { if (nicknameInput.value.trim()) void save(''); });
  document.addEventListener('contextmenu', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-note-nickname]');
    if (!target?.dataset.noteNickname) return;
    event.preventDefault();
    open(target.dataset.noteNickname);
  });
  document.getElementById('nickname-note-add')?.addEventListener('click', () => open());
  function refreshList(): void {
    const list = document.getElementById('nickname-note-list');
    if (!list) return;
    list.replaceChildren();
    const current = notes.filter(note => note.server === server).sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
    list.classList.toggle('ui-empty', !current.length);
    if (!current.length) list.textContent = '이 서버에 저장한 메모가 없습니다. 채팅 닉네임을 우클릭하거나 메모 추가를 눌러 보세요.';
    for (const item of current) {
      const button = document.createElement('button');
      button.className = 'nickname-note-list-item';
      const title = document.createElement('strong'); title.textContent = item.nickname;
      const summary = document.createElement('span'); summary.textContent = item.note;
      button.append(title, summary);
      button.addEventListener('click', () => open(item.nickname));
      list.appendChild(button);
    }
    const label = document.getElementById('nickname-note-server');
    if (label) label.textContent = `${server === 7 ? '하이아칸' : '네냐플'} · ${current.length}개`;
  }
  window.nicknameNotes = {
    updateConfig(config) {
      configRevision++;
      server = config.userServer === 16 ? 16 : 7;
      notes = config.nicknameNotes || [];
      compact = config.chatNicknameNotesCompact === true;
      refreshList();
    },
    appendBadge(container, nickname) {
      const text = find(nickname)?.note;
      if (!text) return;
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'nickname-note-badge';
      badge.textContent = compact ? '메모' : text;
      badge.title = text;
      badge.setAttribute('aria-label', `${nickname} 정보·메모 열기`);
      badge.dataset.noteNickname = nickname;
      badge.addEventListener('click', event => { event.stopPropagation(); open(nickname); });
      container.appendChild(badge);
    },
  };
})();
