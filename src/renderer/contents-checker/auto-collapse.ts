/**
 * 기능 계약 — 선택적 숙제창 자동 접기
 * 기본 꺼짐. 마지막 조작 후 15초가 지나고 포인터가 창 밖에 있을 때만 제목줄로 접는다.
 * 관리·캐릭터 선택·입력·설정 저장 중에는 접지 않는다. 감지로 선택창이 열리면 펼친다.
 * 제목 영역 호버 또는 펼치기 버튼 클릭으로 기존 DOM/스크롤/입력을 보존하며 펼친다.
 * 접힌 제목줄의 버튼에서는 호버로 레이아웃을 바꾸지 않는다. 펼치기 클릭이 같은 위치에
 * 새로 나타나는 관리 버튼으로 전달되거나, 닫기를 누르기 전에 창이 펼쳐지는 것을 막는다.
 * 설정은 숙제 화면의 단일 config-data 수신기가 전달한다. preload의 같은 채널 재등록은
 * 이전 수신기를 교체하므로 여기서 별도 등록하면 재개방·다른 창의 설정 변경을 놓친다.
 */
(() => {
  const input = document.getElementById('contents-auto-collapse') as HTMLInputElement | null;
  if (!input) return;
  const status = document.getElementById('contents-auto-collapse-status');
  let enabled = false, inside = document.documentElement.matches(':hover'), saving = false, collapsed = false;
  let configRevision = 0;
  let lastActivity = Date.now(), wanted = false, updating = false;
  const api = window.electronAPI as typeof window.electronAPI & {
    setContentsCollapsed(value: boolean): Promise<boolean>;
    onContentsCollapseState(callback: (value: boolean) => void): void;
    applySettingsConfirmed(patch: Partial<BrowserAppConfig>): Promise<{ success: boolean }>;
  };

  function protectedState(): boolean {
    return saving || document.getElementById('add-form')?.classList.contains('show') === true
      || ['pending-modal', 'char-modal', 'custom-prompt', 'help-modal'].some(id => {
        const element = document.getElementById(id);
        return element && !element.classList.contains('hidden');
      }) || !!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');
  }
  function showState(value: boolean): void {
    collapsed = value;
    document.body.classList.toggle('contents-collapsed', value);
  }
  async function request(value: boolean): Promise<void> {
    wanted = value;
    if (updating) return;
    updating = true;
    try {
      while (collapsed !== wanted) {
        const target = wanted;
        const accepted = await api.setContentsCollapsed(target);
        if (!accepted) { wanted = collapsed; break; }
        showState(target);
        if (target && (!enabled || inside || protectedState())) wanted = false;
      }
    } catch { wanted = collapsed; }
    finally { updating = false; }
  }
  function activity(): void { lastActivity = Date.now(); }
  api.onContentsCollapseState(value => {
    showState(value);
    if (!value) { wanted = false; activity(); }
  });
  window.contentsAutoCollapse = { applyConfig(config) {
    configRevision++;
    enabled = config.contentsAutoCollapse === true;
    if (!saving) input.checked = enabled;
    if (!enabled) void request(false);
  } };
  input.addEventListener('change', async () => {
    const chosen = input.checked;
    const requestedAtRevision = configRevision;
    saving = true; input.disabled = true;
    if (status) status.textContent = '저장 중…';
    try {
      const result = await api.applySettingsConfirmed({ contentsAutoCollapse: chosen });
      if (!result?.success) throw new Error('save failed');
      // 저장 응답보다 뒤의 다른 창/클라우드 변경을 오래된 선택값으로 덮지 않는다.
      if (configRevision === requestedAtRevision) enabled = chosen;
      if (status) status.textContent = '';
    } catch {
      input.checked = enabled;
      if (status) status.textContent = '저장하지 못했습니다. 다시 시도해 주세요.';
    } finally {
      saving = false; input.disabled = false; input.checked = enabled; activity();
      if (!enabled) void request(false);
    }
  });
  function expandFromPointer(event: PointerEvent): void {
    inside = true;
    const overControls = document.elementFromPoint(event.clientX, event.clientY)?.closest('.win-controls');
    if (collapsed && overControls) return;
    void request(false);
  }
  document.documentElement.addEventListener('pointerenter', event => { activity(); expandFromPointer(event); });
  document.documentElement.addEventListener('pointerleave', () => { inside = false; activity(); });
  document.documentElement.addEventListener('pointermove', expandFromPointer);
  document.addEventListener('visibilitychange', () => {
    inside = document.documentElement.matches(':hover');
    activity();
  });
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'input', 'wheel', 'focusin']) {
    document.addEventListener(event, activity, { passive: true });
  }
  document.getElementById('contents-expand')?.addEventListener('click', () => { activity(); void request(false); });
  const observer = new MutationObserver(() => { if (protectedState()) { activity(); void request(false); } });
  for (const id of ['add-form', 'pending-modal', 'char-modal', 'custom-prompt', 'help-modal']) {
    const element = document.getElementById(id);
    if (element) observer.observe(element, { attributes: true, attributeFilter: ['class'] });
  }
  const timer = window.setInterval(() => {
    if (!enabled || inside || protectedState() || document.hidden) return;
    if (Date.now() - lastActivity >= 15_000) void request(true);
  }, 500);
  window.addEventListener('beforeunload', () => { clearInterval(timer); observer.disconnect(); });
})();
