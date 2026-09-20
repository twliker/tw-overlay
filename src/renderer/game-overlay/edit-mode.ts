/** game-overlay의 HUD 위치 편집 모드(드래그 앤 드롭 이동)를 담당합니다. */
(() => {
  interface HudDragItem {
    id: string;
    settingKey: 'xpWidgetPos' | 'buffTimerHudPos' | 'abandonedWidgetPos' | 'digsiteWidgetPos' | 'forgeQuestHudPos' | 'todaySummaryHudPos' | 'pinnedNotePos';
    label: string;
    useTop?: boolean; // top/left 기준 (true) vs bottom/left 기준 (false)
  }

  interface SavedElementStyle {
    left: string;
    top: string;
    bottom: string;
    right: string;
  }

  const api = window.electronAPI as typeof window.electronAPI & {
    onGameOverlayEditMode?(callback: (enabled: boolean, saveOnExit?: boolean, requestId?: number) => void): void;
    onGameOverlayResetPositions?(callback: () => void): void;
    applySettingsConfirmed?(settings: Record<string, unknown>): Promise<{ success: boolean }>;
    saveGameOverlayPositions?(requestId: number, settings: Record<string, unknown>): Promise<{ success: boolean }>;
    finishGameOverlayEditMode?(requestId: number, success: boolean): Promise<boolean>;
    setGameOverlayEditMode?(enabled: boolean, saveOnExit?: boolean): Promise<boolean>;
    DEFAULT_CONFIG?: Record<string, { left?: number; top?: number; bottom?: number }>;
  };

  const HUD_ITEMS: HudDragItem[] = [
    { id: 'pinned-note-hud', settingKey: 'pinnedNotePos', label: '📝 고정 메모', useTop: true },
    { id: 'today-summary-hud', settingKey: 'todaySummaryHudPos', label: '📋 오늘의 요약 HUD', useTop: true },
    { id: 'xp-hud', settingKey: 'xpWidgetPos', label: '📈 경험치 HUD', useTop: false },
    { id: 'abandoned-widget', settingKey: 'abandonedWidgetPos', label: '💎 어벤던로드 HUD', useTop: false },
    { id: 'digsite-widget', settingKey: 'digsiteWidgetPos', label: '⛏️ 발굴지 현황 HUD', useTop: false },
    { id: 'buff-hud', settingKey: 'buffTimerHudPos', label: '🧪 버프 HUD', useTop: false },
  ];

  let isEditMode = false;
  let saving = false;
  let editGeneration = 0;
  const toolbar = document.createElement('div');
  toolbar.id = 'hud-edit-toolbar';
  toolbar.hidden = true;
  toolbar.setAttribute('aria-label', 'HUD 위치 설정');
  toolbar.innerHTML = `<span id="hud-edit-selection">이동할 HUD를 선택하세요</span><label><input id="hud-edit-snap" type="checkbox" checked> 모서리 맞춤</label><button type="button" class="ui-button ui-button-small ui-button-primary" id="hud-edit-save">저장</button><button type="button" class="ui-button ui-button-small" id="hud-edit-cancel">취소</button><span id="hud-edit-error" role="status"></span>`;
  document.body.appendChild(toolbar);
  const selection = toolbar.querySelector<HTMLElement>('#hud-edit-selection')!;
  const status = toolbar.querySelector<HTMLElement>('#hud-edit-error')!;
  const snap = toolbar.querySelector<HTMLInputElement>('#hud-edit-snap')!;
  const guideX = document.createElement('div'), guideY = document.createElement('div');
  guideX.className = 'hud-snap-guide vertical'; guideY.className = 'hud-snap-guide horizontal';
  guideX.hidden = guideY.hidden = true;
  document.body.append(guideX, guideY);
  function requestExit(save: boolean): void {
    if (saving) return;
    if (api.setGameOverlayEditMode) void api.setGameOverlayEditMode(false, save).catch(() => { status.textContent = '편집을 종료하지 못했습니다. 다시 시도하세요.'; });
    else void exitEditMode(save);
  }
  toolbar.querySelector('#hud-edit-save')!.addEventListener('click', () => requestExit(true));
  toolbar.querySelector('#hud-edit-cancel')!.addEventListener('click', () => requestExit(false));
  let activeDragTarget: HTMLElement | null = null;
  let activePointerId: number | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const previousHiddenStates = new Map<string, boolean>();
  const initialPositions = new Map<string, SavedElementStyle>();

  function byId(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  function initDragBadge(item: HudDragItem, el: HTMLElement): void {
    let badge = el.querySelector('.hud-edit-badge') as HTMLElement | null;
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'hud-edit-badge';
      badge.textContent = item.label;
      el.insertBefore(badge, el.firstChild);
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!isEditMode || saving) return;
    if (e.button !== 0) return; // 좌클릭만 처리

    const target = (e.target as HTMLElement).closest('.hud-draggable') as HTMLElement | null;
    if (!target) return;
    // 메모 본문은 스크롤 영역이다. 제목과 편집 배지는 기존 드래그 경로를 사용한다.
    if (target.id === 'pinned-note-hud' && (e.target as HTMLElement).closest('#pinned-note-content')) return;

    e.preventDefault();
    e.stopPropagation();

    selection.textContent = HUD_ITEMS.find(item => item.id === target.id)?.label || 'HUD';
    activeDragTarget = target;
    activePointerId = e.pointerId;
    target.classList.add('is-dragging');

    try {
      target.setPointerCapture(e.pointerId);
    } catch (_e) {}

    const rect = target.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isEditMode || saving || !activeDragTarget) return;

    e.preventDefault();
    e.stopPropagation();

    const target = activeDragTarget;
    const itemId = target.id;
    const itemSpec = HUD_ITEMS.find(i => i.id === itemId);

    const width = target.offsetWidth;
    const height = target.offsetHeight;
    // 고정 메모는 일반 표시에서도 12px 여백을 유지하므로 같은 경계에 맞춘다.
    const margin = itemId === 'pinned-note-hud' ? 12 : 0;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    let newLeft = Math.max(margin, Math.min(e.clientX - dragOffsetX, maxLeft));
    let newTop = Math.max(margin, Math.min(e.clientY - dragOffsetY, maxTop));

    const peers = HUD_ITEMS.filter(item => item.id !== itemId).map(item => byId(item.id))
      .filter((node): node is HTMLElement => !!node && !node.classList.contains('hidden'))
      .map(node => { const rect = node.getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; });
    const aligned = snap.checked && window.windowSnap?.snap({ x: newLeft, y: newTop, width, height }, peers,
      { x: margin, y: margin, width: innerWidth - margin * 2, height: innerHeight - margin * 2 });
    guideX.hidden = !aligned || aligned.guideX === undefined;
    guideY.hidden = !aligned || aligned.guideY === undefined;
    if (aligned) {
      newLeft = aligned.x; newTop = aligned.y;
      if (aligned.guideX !== undefined) guideX.style.left = `${aligned.guideX}px`;
      if (aligned.guideY !== undefined) guideY.style.top = `${aligned.guideY}px`;
    }
    target.style.left = `${Math.round(newLeft)}px`;
    target.style.right = 'auto';

    if (itemSpec?.useTop) {
      target.style.top = `${Math.round(newTop)}px`;
      target.style.bottom = 'auto';
    } else {
      const bottom = Math.max(0, window.innerHeight - newTop - height);
      target.style.bottom = `${Math.round(bottom)}px`;
      target.style.top = 'auto';
    }
  }

  function onPointerUp(e?: PointerEvent): void {
    guideX.hidden = guideY.hidden = true;
    if (!activeDragTarget) return;
    const target = activeDragTarget;
    target.classList.remove('is-dragging');
    if (activePointerId !== null) {
      try {
        target.releasePointerCapture(activePointerId);
      } catch (_e) {}
      activePointerId = null;
    }
    activeDragTarget = null;
  }

  function enterEditMode(): void {
    if (isEditMode) return;
    isEditMode = true;
    editGeneration++;
    saving = false;
    toolbar.hidden = false;
    status.textContent = '';
    selection.textContent = '이동할 HUD를 선택하세요';
    toolbar.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = false);
    document.body.classList.add('hud-edit-mode');

    // 이전 상태 및 시작 위치 백업
    initialPositions.clear();
    previousHiddenStates.clear();

    ensureDummyContent();

    HUD_ITEMS.forEach(item => {
      const el = byId(item.id);
      if (!el) return;

      initialPositions.set(item.id, {
        left: el.style.left,
        top: el.style.top,
        bottom: el.style.bottom,
        right: el.style.right,
      });

      previousHiddenStates.set(item.id, el.classList.contains('hidden'));
      el.classList.remove('hidden');
      el.classList.add('hud-draggable', 'show');
      initDragBadge(item, el);
    });

    // 리스너 멱등성 보장
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    window.companionHud?.refreshNoteLayout();
  }

  async function exitEditMode(save: boolean = true, requestId?: number): Promise<void> {
    if (!isEditMode) {
      if (requestId !== undefined) await api.finishGameOverlayEditMode?.(requestId, true);
      return;
    }
    // 요청 ID 없는 취소는 설정 창 닫기·위치 초기화의 강제 취소다.
    if (saving && (save || requestId !== undefined)) return;
    const generation = editGeneration;
    if (save) {
      saving = true;
      onPointerUp();
      toolbar.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = true);
      status.textContent = '저장 중…';
      let success = false;
      try {
        const positions = collectCurrentPositions();
        const result = requestId !== undefined
          ? await api.saveGameOverlayPositions?.(requestId, positions)
          : await api.applySettingsConfirmed?.(positions);
        success = result?.success === true;
      }
      catch { /* 입력과 위치를 유지하고 재시도 안내 */ }
      if (generation !== editGeneration || !isEditMode) return;
      saving = false;
      toolbar.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = false);
      if (!success) {
        status.textContent = '저장하지 못했습니다. 위치를 유지했습니다. 다시 저장해 주세요.';
        if (requestId !== undefined) await api.finishGameOverlayEditMode?.(requestId, false);
        return;
      }
    }
    if (generation !== editGeneration || !isEditMode) return;
    isEditMode = false;
    editGeneration++;
    saving = false;
    toolbar.hidden = true;
    document.body.classList.remove('hud-edit-mode');
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);
    onPointerUp();
    // 로컬 드래그 초안을 먼저 정리한다. 메인의 종료 확인/강제 취소 뒤에는 최신 config가
    // 다시 도착하므로, 편집 중 별도로 확정한 프리셋·공유·다른 창의 설정이 최종 기준이다.
    if (!save) rollbackPositions();

    // 뱃지 및 드래그 클래스 정리
    HUD_ITEMS.forEach(item => {
      const el = byId(item.id);
      if (!el) return;

      el.classList.remove('hud-draggable', 'is-dragging');
      const badge = el.querySelector('.hud-edit-badge');
      if (badge) badge.remove();

      // 원래 숨김 상태였던 경우 복원
      const wasHidden = previousHiddenStates.get(item.id);
      if (wasHidden) {
        el.classList.add('hidden');
        el.classList.remove('show');
      }
    });

    cleanupDummyContent();
    // 저장 응답의 config-data가 오기 전에 새 위치를 이전 저장 좌표로 되돌리지 않는다.
    window.companionHud?.refreshNoteLayout(save);
    // 종료 상태를 먼저 정리해야 설정 창에서 즉시 다시 시작해도 이전 저장 응답이
    // 새 편집을 닫지 않는다. 이 확인 뒤 메인이 입력 투과와 설정 UI를 복원한다.
    if (requestId !== undefined) await api.finishGameOverlayEditMode?.(requestId, true);
  }

  function rollbackPositions(): void {
    HUD_ITEMS.forEach(item => {
      const el = byId(item.id);
      if (!el) return;
      const initial = initialPositions.get(item.id);
      if (initial) {
        el.style.left = initial.left;
        el.style.top = initial.top;
        el.style.bottom = initial.bottom;
        el.style.right = initial.right;
      }
    });
  }

  function collectCurrentPositions(): Record<string, { left: number; top?: number; bottom?: number }> {
    const updates: Record<string, { left: number; top?: number; bottom?: number }> = {};

    const readPixelPosition = (el: HTMLElement, property: 'left' | 'top' | 'bottom'): number | null => {
      const inlineValue = Number.parseFloat(el.style[property]);
      if (Number.isFinite(inlineValue)) return Math.round(inlineValue);
      const computedValue = Number.parseFloat(window.getComputedStyle(el)[property]);
      return Number.isFinite(computedValue) ? Math.round(computedValue) : null;
    };
    const firstFinite = (...values: Array<number | null | undefined>): number => {
      const value = values.find(candidate => typeof candidate === 'number' && Number.isFinite(candidate));
      return value ?? 0;
    };

    HUD_ITEMS.forEach(item => {
      const el = byId(item.id);
      if (!el) return;

      // 기능 계약: 편집 도중 다른 설정이 반영되어 HUD가 display:none이 되더라도 rect(0,0)를
      // 좌표로 저장하지 않는다. 드래그가 기록한 inline 좌표를 우선하고, CSS 좌표와 편집 시작
      // 위치, 공통 기본값 순으로 보완한다. 이 규칙을 바꾸면 설정 저장 경로와 마이그레이션을
      // 함께 검증해야 한다.
      const initial = initialPositions.get(item.id);
      const defaultPosition = api?.DEFAULT_CONFIG?.[item.settingKey] as { left?: number; top?: number; bottom?: number } | undefined;
      const left = firstFinite(
        readPixelPosition(el, 'left'),
        Number.parseFloat(initial?.left || ''),
        defaultPosition?.left,
      );

      if (item.useTop) {
        const top = firstFinite(
          readPixelPosition(el, 'top'),
          Number.parseFloat(initial?.top || ''),
          defaultPosition?.top,
        );
        updates[item.settingKey] = { left: Math.round(left), top: Math.round(top) };
      } else {
        const bottom = firstFinite(
          readPixelPosition(el, 'bottom'),
          Number.parseFloat(initial?.bottom || ''),
          defaultPosition?.bottom,
        );
        updates[item.settingKey] = { left: Math.round(left), bottom: Math.max(0, Math.round(bottom)) };
      }
    });

    return updates;
  }

  function ensureDummyContent(): void {
    const buffItems = byId('buff-hud-items');
    if (buffItems && buffItems.children.length === 0) {
      buffItems.setAttribute('data-dummy-active', 'true');
      buffItems.innerHTML = `
        <div class="buff-badge phase-normal dummy-badge" style="width:36px;height:36px;">
          <div class="buff-badge-icon cat-exp"><i data-lucide="sparkles" class="w-4 h-4 text-purple-300"></i></div>
          <div class="buff-badge-scrim"><span class="buff-badge-time">10:00</span></div>
        </div>
        <div class="buff-badge phase-warn1 dummy-badge" style="width:36px;height:36px;">
          <div class="buff-badge-icon cat-stats"><i data-lucide="zap" class="w-4 h-4 text-blue-300"></i></div>
          <div class="buff-badge-scrim"><span class="buff-badge-time">00:45</span></div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  function cleanupDummyContent(): void {
    const buffItems = byId('buff-hud-items');
    if (buffItems && buffItems.getAttribute('data-dummy-active') === 'true') {
      buffItems.removeAttribute('data-dummy-active');
      buffItems.querySelectorAll('.dummy-badge').forEach(el => el.remove());
    }
  }

  // IPC 리스너 등록
  if (api && api.onGameOverlayEditMode) {
    api.onGameOverlayEditMode((enabled: boolean, saveOnExit: boolean = true, requestId?: number) => {
      if (enabled) enterEditMode();
      else return exitEditMode(saveOnExit, requestId);
    });
  }

  if (api && api.onGameOverlayResetPositions) {
    api.onGameOverlayResetPositions(() => {
      if (isEditMode) {
        exitEditMode(false);
      }
    });
  }

  window.gameOverlayEditMode = {
    enterEditMode,
    exitEditMode,
    isEditMode: () => isEditMode,
  };
})();
