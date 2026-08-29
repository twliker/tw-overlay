/** game-overlay의 HUD 위치 편집 모드(드래그 앤 드롭 이동)를 담당합니다. */
(() => {
  interface HudDragItem {
    id: string;
    settingKey: 'xpWidgetPos' | 'buffTimerHudPos' | 'abandonedWidgetPos' | 'digsiteWidgetPos' | 'forgeQuestHudPos' | 'todaySummaryHudPos';
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
    onGameOverlayEditMode?(callback: (enabled: boolean, saveOnExit?: boolean) => void): void;
    onGameOverlayResetPositions?(callback: () => void): void;
    applySettings?(settings: Record<string, unknown>): void;
  };

  const HUD_ITEMS: HudDragItem[] = [
    { id: 'today-summary-hud', settingKey: 'todaySummaryHudPos', label: '📋 오늘의 요약 HUD', useTop: true },
    { id: 'xp-hud', settingKey: 'xpWidgetPos', label: '📈 경험치 HUD', useTop: false },
    { id: 'abandoned-widget', settingKey: 'abandonedWidgetPos', label: '💎 어벤던로드 HUD', useTop: false },
    { id: 'digsite-widget', settingKey: 'digsiteWidgetPos', label: '⛏️ 발굴지 현황 HUD', useTop: false },
    { id: 'buff-hud', settingKey: 'buffTimerHudPos', label: '🧪 버프 HUD', useTop: false },
  ];

  let isEditMode = false;
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
    if (!isEditMode) return;
    if (e.button !== 0) return; // 좌클릭만 처리

    const target = (e.target as HTMLElement).closest('.hud-draggable') as HTMLElement | null;
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();

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
    if (!isEditMode || !activeDragTarget) return;

    e.preventDefault();
    e.stopPropagation();

    const target = activeDragTarget;
    const itemId = target.id;
    const itemSpec = HUD_ITEMS.find(i => i.id === itemId);

    const width = target.offsetWidth;
    const height = target.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);

    const newLeft = Math.max(0, Math.min(e.clientX - dragOffsetX, maxLeft));
    const newTop = Math.max(0, Math.min(e.clientY - dragOffsetY, maxTop));

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

  function onPointerUp(e: PointerEvent): void {
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
  }

  function exitEditMode(save: boolean = true): void {
    if (!isEditMode) return;
    isEditMode = false;
    document.body.classList.remove('hud-edit-mode');

    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);

    if (activeDragTarget) {
      activeDragTarget.classList.remove('is-dragging');
      if (activePointerId !== null) {
        try {
          activeDragTarget.releasePointerCapture(activePointerId);
        } catch (_e) {}
        activePointerId = null;
      }
      activeDragTarget = null;
    }

    if (save) {
      saveCurrentPositions();
    } else {
      rollbackPositions();
    }

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

  function saveCurrentPositions(): void {
    const updates: Record<string, { left: number; top?: number; bottom?: number }> = {};

    HUD_ITEMS.forEach(item => {
      const el = byId(item.id);
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const left = Math.round(rect.left);

      if (item.useTop) {
        updates[item.settingKey] = { left, top: Math.round(rect.top) };
      } else {
        const bottom = Math.round(Math.max(0, window.innerHeight - rect.bottom));
        updates[item.settingKey] = { left, bottom };
      }
    });

    if (api && api.applySettings) {
      api.applySettings(updates);
    }
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
    api.onGameOverlayEditMode((enabled: boolean, saveOnExit: boolean = true) => {
      if (enabled) enterEditMode();
      else exitEditMode(saveOnExit);
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
