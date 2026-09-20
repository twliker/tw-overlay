interface Window { companionHud: { updateConfig(config: BrowserAppConfig): void; refreshNoteLayout(preservePosition?: boolean): void }; }

/** 고정 메모는 설정 문자열만 표시한다. 편집 중 수신된 설정으로 드래그 위치를 덮지 않는다.
 * 긴 메모는 생략 안내를 표시하고 HUD 위치 편집에서 본문을 스크롤해 끝까지 읽는다.
 * 평상시에는 게임 입력을 투과한다. 화면에 맞춘 위치 보정은 저장된 좌표를 변경하지 않는다.
 * 회귀: check-renderer-behavior의 긴 메모·창 크기 변경·편집/취소·입력 검사.
 */
(() => {
  const api = window.electronAPI as typeof window.electronAPI & {
    getSupplyRun?(): Promise<import('../../shared/types').SupplyRunState>;
    onSupplyRunUpdate?(callback: (state: import('../../shared/types').SupplyRunState) => void): void;
  };
  let currentConfig: Partial<BrowserAppConfig> = {};
  let supply = { expiresAt: 0, orderExpiresAt: 0, colors: [] } as import('../../shared/types').SupplyRunState;
  let generation = 0;
  let configReady = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  function refreshNoteLayout(preservePosition = false): void {
    const note = document.getElementById('pinned-note-hud');
    const text = document.getElementById('pinned-note-content');
    const hint = document.getElementById('pinned-note-overflow');
    if (!note || !text || !hint) return;
    const editing = window.gameOverlayEditMode?.isEditMode() === true;
    if (!editing) {
      note.classList.toggle('hidden', !currentConfig.pinnedNoteEnabled || !currentConfig.pinnedNoteText?.trim());
      const position = currentConfig.pinnedNotePos;
      if (position && !preservePosition) { note.style.left = `${position.left}px`; note.style.top = `${position.top}px`; }
    }
    if (note.classList.contains('hidden')) return;
    // 먼저 안내 영역을 제외하고 측정해 짧아진 메모에 안내가 계속 남지 않게 한다.
    const scrollTop = text.scrollTop;
    hint.classList.add('hidden');
    const overflow = text.scrollHeight > text.clientHeight + 1;
    hint.textContent = editing ? '본문을 스크롤해 전체 보기\n제목을 끌어 위치 이동' : '내용이 더 있습니다\nHUD 위치 설정에서 스크롤';
    hint.classList.toggle('hidden', !overflow);
    text.scrollTop = scrollTop;
    const rect = note.getBoundingClientRect();
    const margin = 12;
    note.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - rect.width - margin))}px`;
    note.style.top = `${Math.max(margin, Math.min(rect.top, innerHeight - rect.height - margin))}px`;
  }
  const padImages: Record<import('../../shared/types').SupplyPadColor, string> = {
    파랑: 'blue', 노랑: 'yellow', 빨강: 'red', 검정: 'black', 흰색: 'white',
  };
  /** 입장 상태에서 감지한 암호만 10초간 기믹 알림으로 표시한다. 대기/종료/비활성은 즉시 숨긴다.
   * 지도와 HUD 편집 좌표는 사용하지 않으며 위치는 다른 기믹과 같은 notificationPositions.center가 소유한다.
   */
  function renderSupply(): void {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const panel = document.getElementById('supply-pad-alert');
    const order = document.getElementById('supply-pad-order');
    if (!panel || !order) return;
    const now = Date.now();
    const active = now < supply.expiresAt && supply.expiresAt - now <= 30 * 60_000;
    const selected = active && now < supply.orderExpiresAt && supply.orderExpiresAt - now <= 10_000 ? supply.colors : [];
    const visible = configReady && currentConfig.supplyHelperEnabled !== false && selected.length > 0;
    panel.classList.toggle('hidden', !visible);
    const signature = selected.join(',');
    if (order.dataset.order !== signature) {
      order.dataset.order = signature;
      order.replaceChildren();
      selected.forEach((color, index) => {
        if (index) order.appendChild(document.createTextNode('→'));
        const label = document.createElement('span'); label.className = 'supply-pad';
        const image = document.createElement('img'); image.className = 'supply-pad-image';
        image.src = `assets/img/supply-pads/${padImages[color]}.png`;
        image.alt = ''; image.width = 68; image.height = 44; image.draggable = false;
        label.append(image, document.createTextNode(color)); order.appendChild(label);
      });
    }
    if (visible) expiryTimer = setTimeout(renderSupply, Math.min(supply.expiresAt, supply.orderExpiresAt) - now);
  }
  api?.onSupplyRunUpdate?.(state => { generation++; supply = state; renderSupply(); });
  const requested = generation;
  void api?.getSupplyRun?.().then(state => { if (requested === generation) { supply = state; renderSupply(); } }).catch(error => console.error('보급품 안내를 불러오지 못했습니다.', error));
  window.addEventListener('unload', () => { if (expiryTimer) clearTimeout(expiryTimer); }, { once: true });
  window.addEventListener('resize', () => refreshNoteLayout());
  window.companionHud = {
    refreshNoteLayout,
    updateConfig(config) {
      currentConfig = config;
      configReady = true;
      renderSupply();
      const text = document.getElementById('pinned-note-content');
      const note = document.getElementById('pinned-note-hud');
      note?.classList.toggle('note-text-only', config.pinnedNoteBackground === false);
      if (text) {
        text.style.fontSize = `${Math.max(12, Math.min(28, config.pinnedNoteFontSize || 14))}px`;
        text.style.color = /^#[0-9a-f]{6}$/i.test(config.pinnedNoteColor || '') ? config.pinnedNoteColor! : '#ffffff';
      }
      const value = config.pinnedNoteText?.trim() || '고정 메모를 적어 보세요.';
      if (text && text.textContent !== value) { text.textContent = value; text.scrollTop = 0; }
      refreshNoteLayout();
    },
  };
})();
