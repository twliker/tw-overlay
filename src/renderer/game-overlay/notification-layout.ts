interface Window { notificationLayout: { updateConfig(config: Partial<BrowserAppConfig>): void }; }

/** 기능 계약: 알림 표시·소리·지속 시간은 원래 기능이 소유한다. 위치만 바꾸고 미리보기는 5초 뒤 최신 저장 위치로 되돌린다. */
(() => {
  type Positions = import('../../shared/types').NotificationPositions;
  type Group = keyof Positions;
  type Anchor = import('../../shared/types').NotificationAnchor;

  const api = window.electronAPI as typeof window.electronAPI & {
    onNotificationPreview?(callback: (positions: Positions) => void): void;
    onNotificationEditMode?(callback: (enabled: boolean, saveOnExit?: boolean, requestId?: number) => void): void;
    onNotificationResetPositions?(callback: () => void): void;
    saveNotificationPositions?(positions: Positions): Promise<{ success: boolean; error?: string }>;
    finishNotificationEditMode?(requestId: number, success: boolean): Promise<boolean>;
    setNotificationEditMode?(enabled: boolean, saveOnExit?: boolean): Promise<boolean>;
  };

  const defaults: Positions = { center: 'default', buff: 'default', hunting: 'default', toast: 'default' };
  const selectors: Record<Group, string> = {
    center: '#abandoned-alert,#pitta-alert,#quest-alert,#special-monster-alert,#essence-alert,#ethos-arrow-container,#abyss-apostle-alert,#wave-warning-alert,#lokagos-alert,#supply-pad-alert',
    buff: '#buff-alert-container', hunting: '.hunting-assist-panel', toast: '#dock-toast-container',
  };

  const groupLabels: Record<Group, string> = {
    center: '🔔 게임 진행 알림',
    buff: '🔔 버프 만료 알림',
    hunting: '🔔 입장·사냥 안내',
    toast: '🔔 독 알림',
  };

  const ANCHOR_LABELS: Record<string, string> = {
    default: '기존 위치',
    'top-left': '상단 왼쪽', 'top-center': '상단 가운데', 'top-right': '상단 오른쪽',
    'middle-left': '중앙 왼쪽', 'middle-center': '정가운데', 'middle-right': '중앙 오른쪽',
    'bottom-left': '하단 왼쪽', 'bottom-center': '하단 가운데', 'bottom-right': '하단 오른쪽',
  };

  function getDefaultCardPixelPos(group: Group): { left: number; top: number } {
    const cardWidth = 290;
    const cardHeight = 64;
    const w = window.innerWidth || 1920;
    const h = window.innerHeight || 1080;
    switch (group) {
      case 'center':
        return { left: Math.round(w / 2 - cardWidth / 2), top: Math.round(h * 0.42 - cardHeight / 2) };
      case 'buff':
        return { left: Math.round(w / 2 - cardWidth / 2), top: Math.round(h * 0.28 - cardHeight / 2) };
      case 'hunting':
        return { left: Math.max(12, Math.round(w - cardWidth - 24)), top: 90 };
      case 'toast':
        return { left: Math.max(12, Math.round(w - cardWidth - 31)), top: Math.round(h * 0.666 - cardHeight / 2) };
    }
  }

  const originals = new WeakMap<HTMLElement, { left: string; top: string; right: string; bottom: string }>();
  let saved = defaults;
  let preview: Positions | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sampleNodes: HTMLElement[] = [];

  function place(element: HTMLElement, group: Group, anchor: Positions[Group]): void {
    if (!originals.has(element)) originals.set(element, { left: element.style.left, top: element.style.top, right: element.style.right, bottom: element.style.bottom });
    const isCustomCard = element.classList.contains('notification-edit-card');
    const sample = isCustomCard || element.dataset.notificationSample === 'true';

    if (anchor === 'default') {
      if (sample) {
        const def = getDefaultCardPixelPos(group);
        element.style.left = `${def.left}px`;
        element.style.top = `${def.top}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
      } else {
        Object.assign(element.style, originals.get(element));
      }
      return;
    }

    // 1) 자유 좌표 객체 { left, top } 인 경우 (HUD와 동일한 픽셀 배치)
    if (typeof anchor === 'object' && anchor !== null && 'left' in anchor && 'top' in anchor) {
      if (sample) {
        element.style.left = `${Math.round(anchor.left)}px`;
        element.style.top = `${Math.round(anchor.top)}px`;
      } else {
        const width = 240;
        const height = 64;
        const centeredX = group === 'center' || group === 'buff';
        const centeredY = group === 'center' || group === 'toast';
        element.style.left = `${Math.round(anchor.left + (centeredX ? width / 2 : 0))}px`;
        element.style.top = `${Math.round(anchor.top + (centeredY ? height / 2 : 0))}px`;
      }
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      return;
    }

    // 2) 9개 구역 문자열 앵커인 경우 (하위 호환)
    const [vertical, horizontal] = anchor.split('-');
    if (!['top', 'middle', 'bottom'].includes(vertical) || !['left', 'center', 'right'].includes(horizontal)) return;
    const x = horizontal === 'left' ? 0 : horizontal === 'right' ? 1 : .5;
    const y = vertical === 'top' ? 0 : vertical === 'bottom' ? 1 : .5;
    const centeredX = sample || group === 'center' || group === 'buff';
    const centeredY = sample || group === 'center' || group === 'toast';
    const width = element.offsetWidth || 200, height = element.offsetHeight || 60;
    element.style.left = `${12 + Math.max(0, innerWidth - width - 24) * x + (centeredX ? width / 2 : 0)}px`;
    element.style.top = `${12 + Math.max(0, innerHeight - height - 24) * y + (centeredY ? height / 2 : 0)}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }

  function render(): void {
    const positions = preview || saved;
    for (const group of Object.keys(selectors) as Group[]) {
      document.querySelectorAll<HTMLElement>(selectors[group]).forEach(element => place(element, group, positions[group] || 'default'));
    }
    for (const node of sampleNodes) place(node, node.dataset.group as Group, positions[node.dataset.group as Group]);
  }

  function stopPreview(): void {
    if (timer) clearTimeout(timer);
    timer = undefined; preview = undefined;
    sampleNodes.splice(0).forEach(node => node.remove()); render();
  }

  api?.onNotificationPreview?.(positions => {
    stopPreview(); preview = positions;
    const labels: Record<Group, string> = { center: '게임 진행 알림', buff: '버프 만료 알림', hunting: '입장·사냥 안내', toast: '독 알림' };
    for (const group of Object.keys(labels) as Group[]) {
      const node = document.createElement('div'); node.dataset.group = group; node.dataset.notificationSample = 'true';
      node.className = 'ui-hud-card ui-notification-sample';
      node.textContent = `${labels[group]} · 5초 미리보기`;
      const def = getDefaultCardPixelPos(group);
      node.style.left = `${def.left}px`;
      node.style.top = `${def.top}px`;
      document.body.appendChild(node); sampleNodes.push(node);
    }
    render(); timer = setTimeout(stopPreview, 5000);
  });

  // ── 알림 위치 편집 모드 (HUD와 동일한 자유 좌표 드래그 앤 드롭) ──
  let isEditMode = false;
  let saving = false;
  let editGeneration = 0;
  let editingPositions: Positions = { ...defaults };
  let initialBeforeEdit: Positions = { ...defaults };
  const editCards = new Map<Group, HTMLElement>();
  let activeCard: HTMLElement | null = null;
  let activeGroup: Group | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let activePointerId: number | null = null;

  // 툴바 엘리먼트 생성
  const toolbar = document.createElement('div');
  toolbar.id = 'notification-edit-toolbar';
  toolbar.hidden = true;
  toolbar.setAttribute('aria-label', '알림 위치 설정');
  toolbar.innerHTML = `
    <span id="notif-edit-selection">이동할 알림 영역을 드래그하세요</span>
    <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input id="notif-edit-snap" type="checkbox" checked> 모서리 맞춤</label>
    <button type="button" class="ui-button ui-button-small" id="notif-edit-reset">기본 위치로 초기화</button>
    <button type="button" class="ui-button ui-button-small ui-button-primary" id="notif-edit-save">저장</button>
    <button type="button" class="ui-button ui-button-small" id="notif-edit-cancel">취소</button>
    <span id="notif-edit-error" role="status"></span>
  `;
  document.body.appendChild(toolbar);

  const snapCheckbox = toolbar.querySelector<HTMLInputElement>('#notif-edit-snap')!;
  const selectionSpan = toolbar.querySelector<HTMLElement>('#notif-edit-selection')!;
  const statusSpan = toolbar.querySelector<HTMLElement>('#notif-edit-error')!;

  // 스냅 가이드라인 엘리먼트
  const guideX = document.createElement('div');
  const guideY = document.createElement('div');
  guideX.className = 'hud-snap-guide vertical';
  guideY.className = 'hud-snap-guide horizontal';
  guideX.hidden = guideY.hidden = true;
  document.body.append(guideX, guideY);

  let activeRequestId: number | undefined;

  function requestExit(save: boolean): void {
    if (saving) return;
    if (api.setNotificationEditMode) {
      void api.setNotificationEditMode(false, save).catch(() => {
        statusSpan.textContent = '편집을 종료하지 못했습니다. 다시 시도하세요.';
      });
    } else {
      void exitNotificationEditMode(save, activeRequestId);
    }
  }

  toolbar.querySelector('#notif-edit-save')?.addEventListener('click', () => requestExit(true));
  toolbar.querySelector('#notif-edit-cancel')?.addEventListener('click', () => requestExit(false));

  function updateBadge(card: HTMLElement, pos: Positions[Group]): void {
    const badge = card.querySelector('.notification-edit-card-badge');
    if (!badge) return;
    if (pos === 'default') {
      badge.textContent = '📍 기본 위치';
    } else if (typeof pos === 'object' && pos !== null) {
      badge.textContent = `📍 X: ${Math.round(pos.left)}, Y: ${Math.round(pos.top)}`;
    } else {
      badge.textContent = `📍 ${ANCHOR_LABELS[pos] || '기본 위치'}`;
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!isEditMode || saving || e.button !== 0) return;
    const card = (e.target as HTMLElement).closest('.notification-edit-card') as HTMLElement | null;
    if (!card) return;
    if ((e.target as HTMLElement).closest('.notification-edit-card-reset')) return;

    e.preventDefault();
    e.stopPropagation();

    activeCard = card;
    activeGroup = card.dataset.group as Group;
    activePointerId = e.pointerId;
    card.classList.add('is-dragging');
    selectionSpan.textContent = groupLabels[activeGroup];

    const rect = card.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    try { card.setPointerCapture(e.pointerId); } catch {}
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isEditMode || saving || !activeCard || !activeGroup) return;
    e.preventDefault();
    e.stopPropagation();

    const target = activeCard;
    const width = target.offsetWidth;
    const height = target.offsetHeight;
    const margin = 12;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    let newLeft = Math.max(margin, Math.min(e.clientX - dragOffsetX, maxLeft));
    let newTop = Math.max(margin, Math.min(e.clientY - dragOffsetY, maxTop));

    const peers = Array.from(editCards.entries())
      .filter(([grp, el]) => grp !== activeGroup && !el.hidden)
      .map(([, el]) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      });

    const windowSnap = (window as unknown as { windowSnap?: { snap(rect: { x: number; y: number; width: number; height: number }, peers: Array<{ x: number; y: number; width: number; height: number }>, bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number; guideX?: number; guideY?: number } } }).windowSnap;
    const aligned = snapCheckbox.checked && windowSnap?.snap(
      { x: newLeft, y: newTop, width, height },
      peers,
      { x: margin, y: margin, width: innerWidth - margin * 2, height: innerHeight - margin * 2 }
    );

    guideX.hidden = !aligned || aligned.guideX === undefined;
    guideY.hidden = !aligned || aligned.guideY === undefined;
    if (aligned) {
      newLeft = aligned.x;
      newTop = aligned.y;
      if (aligned.guideX !== undefined) guideX.style.left = `${aligned.guideX}px`;
      if (aligned.guideY !== undefined) guideY.style.top = `${aligned.guideY}px`;
    }

    target.style.left = `${Math.round(newLeft)}px`;
    target.style.top = `${Math.round(newTop)}px`;
    target.style.right = 'auto';
    target.style.bottom = 'auto';

    updateBadge(target, { left: Math.round(newLeft), top: Math.round(newTop) });
  }

  function onPointerUp(_e?: PointerEvent): void {
    guideX.hidden = guideY.hidden = true;
    if (!activeCard || !activeGroup) return;

    const target = activeCard;
    const group = activeGroup;
    target.classList.remove('is-dragging');

    const rect = target.getBoundingClientRect();
    const finalPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
    editingPositions[group] = finalPos;
    updateBadge(target, finalPos);
    selectionSpan.textContent = `${groupLabels[group]} 위치를 이동했습니다`;

    if (activePointerId !== null) {
      try { target.releasePointerCapture(activePointerId); } catch {}
      activePointerId = null;
    }
    activeCard = null;
    activeGroup = null;
  }

  function enterNotificationEditMode(reqId?: number): void {
    if (isEditMode) return;
    activeRequestId = reqId;
    isEditMode = true;
    saving = false;
    editGeneration++;
    stopPreview();
    initialBeforeEdit = { ...(saved || defaults) };
    editingPositions = { ...initialBeforeEdit };

    document.body.classList.add('notification-edit-mode');
    toolbar.hidden = false;
    selectionSpan.textContent = '이동할 알림 영역을 드래그하세요';
    statusSpan.textContent = '';
    toolbar.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = false);

    // 4개 알림 드래그 카드 생성 및 배치
    for (const group of Object.keys(selectors) as Group[]) {
      let card = editCards.get(group);
      if (!card) {
        card = document.createElement('div');
        card.className = 'notification-edit-card';
        card.dataset.group = group;
        card.innerHTML = `
          <div class="notification-edit-card-header">
            <span>${groupLabels[group]}</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="notification-edit-card-badge">📍 기본 위치</span>
              <button type="button" class="notification-edit-card-reset" title="이 알림을 기본 위치로 되돌리기">↺ 기본 위치</button>
            </div>
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:6px;">마우스로 드래그하여 원하는 위치에 놓으세요</div>
        `;

        const resetBtn = card.querySelector('.notification-edit-card-reset');
        resetBtn?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          editingPositions[group] = 'default';
          place(card!, group, 'default');
          updateBadge(card!, 'default');
          selectionSpan.textContent = `${groupLabels[group]}을(를) 기본 위치로 되돌렸습니다`;
        });

        document.body.appendChild(card);
        editCards.set(group, card);
      }
      card.hidden = false;
      place(card, group, editingPositions[group]);
      updateBadge(card, editingPositions[group]);
    }

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && isEditMode) {
      e.preventDefault();
      requestExit(false);
    }
  }

  function rollbackPositions(): void {
    for (const group of Object.keys(selectors) as Group[]) {
      const orig = initialBeforeEdit[group];
      editingPositions[group] = orig;
      const card = editCards.get(group);
      if (card) {
        place(card, group, orig);
        updateBadge(card, orig);
      }
    }
  }

  async function exitNotificationEditMode(save: boolean, requestId?: number): Promise<void> {
    if (!isEditMode) {
      if (requestId !== undefined) await api.finishNotificationEditMode?.(requestId, true);
      return;
    }
    if (saving && (save || requestId !== undefined)) return;
    const generation = editGeneration;

    if (save) {
      saving = true;
      onPointerUp();
      toolbar.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = true);
      statusSpan.textContent = '저장 중…';
      let success = false;
      try {
        const res = await api.saveNotificationPositions?.(editingPositions);
        success = res?.success === true;
      } catch (err) {
        console.error('Failed to save notification positions:', err);
      }
      if (generation !== editGeneration || !isEditMode) return;
      saving = false;
      toolbar.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = false);
      if (!success) {
        statusSpan.textContent = '저장하지 못했습니다. 위치를 유지했습니다. 다시 저장해 주세요.';
        if (requestId !== undefined) await api.finishNotificationEditMode?.(requestId, false);
        return;
      }
      saved = { ...editingPositions };
    }

    if (generation !== editGeneration || !isEditMode) return;
    isEditMode = false;
    editGeneration++;
    saving = false;
    toolbar.hidden = true;
    guideX.hidden = guideY.hidden = true;
    document.body.classList.remove('notification-edit-mode');
    for (const card of editCards.values()) card.hidden = true;

    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);
    window.removeEventListener('keydown', onKeyDown);

    if (!save) rollbackPositions();

    render();
    if (requestId !== undefined) await api.finishNotificationEditMode?.(requestId, true);
  }

  // 툴바 버튼 이벤트: 기본 위치로 초기화
  toolbar.querySelector('#notif-edit-reset')?.addEventListener('click', () => {
    for (const group of Object.keys(selectors) as Group[]) {
      editingPositions[group] = 'default';
      const card = editCards.get(group);
      if (card) {
        place(card, group, 'default');
        updateBadge(card, 'default');
      }
    }
    selectionSpan.textContent = '모든 알림을 기본 위치로 초기화했습니다';
  });

  api?.onNotificationResetPositions?.(() => {
    for (const group of Object.keys(selectors) as Group[]) {
      editingPositions[group] = 'default';
      const card = editCards.get(group);
      if (card) {
        place(card, group, 'default');
        updateBadge(card, 'default');
      }
    }
    saved = { ...defaults };
    render();
    if (isEditMode) selectionSpan.textContent = '모든 알림을 기본 위치로 초기화했습니다';
  });

  api?.onNotificationEditMode?.((enabled, save = true, reqId) => {
    if (enabled) enterNotificationEditMode(reqId);
    else void exitNotificationEditMode(save, reqId ?? activeRequestId);
  });

  window.notificationLayout = {
    updateConfig(config) {
      saved = config.notificationPositions || defaults;
      if (!isEditMode) render();
    }
  };

  const resize = new ResizeObserver(render);
  document.querySelectorAll<HTMLElement>(Object.values(selectors).join(',')).forEach(element => resize.observe(element));
  window.addEventListener('resize', render);
  window.addEventListener('unload', () => {
    if (timer) clearTimeout(timer);
    resize.disconnect();
  }, { once: true });
})();
