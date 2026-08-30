/**
 * 기능 계약: 모험일지 득템 기록의 품목별 합계/일자별 기록 높이 조절
 *
 * - 두 영역 사이의 구분선을 세로로 드래그하면 위쪽 품목별 합계 높이가 바뀌고 아래쪽
 *   일자별 기록은 남은 공간을 사용합니다.
 * - 위쪽에는 최소 한 줄, 아래쪽에는 목록과 안내를 확인할 최소 높이를 항상 남깁니다.
 * - 사용자가 정한 높이는 이 PC의 화면 전용 값으로 localStorage에 저장합니다. 모험일지
 *   데이터나 일반 설정/클라우드 동기화 대상에는 포함하지 않습니다.
 * - 숨겨진 탭의 높이 0은 유효한 레이아웃으로 간주하지 않으며, 탭이 표시되거나 창 크기가
 *   바뀌면 현재 높이를 새 가용 영역에 맞춰 다시 제한합니다.
 */
(() => {
  const STORAGE_KEY = 'tw-overlay:diary-loot-summary-height:v1';
  const DEFAULT_SUMMARY_HEIGHT = 158;
  const MIN_SUMMARY_HEIGHT = 92;
  const MIN_DAILY_HEIGHT = 210;
  const KEYBOARD_STEP = 16;

  function clampSummaryHeight(requested: number, containerHeight: number, resizerHeight: number): number {
    const normalized = Number.isFinite(requested) ? Math.round(requested) : DEFAULT_SUMMARY_HEIGHT;
    if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
      return Math.max(MIN_SUMMARY_HEIGHT, normalized);
    }
    const maximum = Math.max(
      MIN_SUMMARY_HEIGHT,
      Math.floor(containerHeight - Math.max(0, resizerHeight) - MIN_DAILY_HEIGHT),
    );
    return Math.min(maximum, Math.max(MIN_SUMMARY_HEIGHT, normalized));
  }

  let initialized = false;
  let currentHeight = DEFAULT_SUMMARY_HEIGHT;
  let resizeObserver: ResizeObserver | null = null;

  function readSavedHeight(): number {
    try {
      const saved = Number.parseFloat(window.localStorage.getItem(STORAGE_KEY) || '');
      return Number.isFinite(saved) ? saved : DEFAULT_SUMMARY_HEIGHT;
    } catch (_error) {
      return DEFAULT_SUMMARY_HEIGHT;
    }
  }

  function saveHeight(height: number): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(height)));
    } catch (_error) {
      // localStorage가 제한된 실행 환경에서도 현재 세션의 드래그 기능은 유지합니다.
    }
  }

  function getElements(): {
    container: HTMLElement;
    summary: HTMLElement;
    resizer: HTMLElement;
  } | null {
    const container = document.getElementById('loot-split-container');
    const summary = document.getElementById('loot-summary-pane');
    const resizer = document.getElementById('loot-pane-resizer');
    return container && summary && resizer ? { container, summary, resizer } : null;
  }

  function applyHeight(requested: number, persist = false): number {
    const elements = getElements();
    if (!elements) return currentHeight;
    currentHeight = clampSummaryHeight(
      requested,
      elements.container.clientHeight,
      elements.resizer.offsetHeight,
    );
    elements.summary.style.height = `${currentHeight}px`;
    elements.resizer.setAttribute('aria-valuemin', String(MIN_SUMMARY_HEIGHT));
    elements.resizer.setAttribute('aria-valuemax', String(Math.max(
      MIN_SUMMARY_HEIGHT,
      elements.container.clientHeight - elements.resizer.offsetHeight - MIN_DAILY_HEIGHT,
    )));
    elements.resizer.setAttribute('aria-valuenow', String(currentHeight));
    if (persist) saveHeight(currentHeight);
    return currentHeight;
  }

  function refresh(): void {
    const elements = getElements();
    if (!elements || elements.container.clientHeight <= 0) return;
    applyHeight(currentHeight);
  }

  function initialize(): void {
    if (initialized) return;
    const elements = getElements();
    if (!elements) return;
    initialized = true;
    currentHeight = readSavedHeight();
    applyHeight(currentHeight);

    let activePointerId: number | null = null;
    let startClientY = 0;
    let startHeight = currentHeight;
    let previousUserSelect = '';
    let previousCursor = '';

    const finishDrag = (event: PointerEvent): void => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      try {
        elements.resizer.releasePointerCapture(activePointerId);
      } catch (_error) {}
      activePointerId = null;
      elements.resizer.classList.remove('is-dragging');
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      saveHeight(currentHeight);
    };

    elements.resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      activePointerId = event.pointerId;
      startClientY = event.clientY;
      startHeight = elements.summary.getBoundingClientRect().height || currentHeight;
      previousUserSelect = document.body.style.userSelect;
      previousCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
      elements.resizer.classList.add('is-dragging');
      try {
        elements.resizer.setPointerCapture(event.pointerId);
      } catch (_error) {}
    });

    window.addEventListener('pointermove', event => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      event.preventDefault();
      applyHeight(startHeight + (event.clientY - startClientY));
    });
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);

    elements.resizer.addEventListener('keydown', event => {
      let requested: number | null = null;
      if (event.key === 'ArrowUp') requested = currentHeight - KEYBOARD_STEP;
      else if (event.key === 'ArrowDown') requested = currentHeight + KEYBOARD_STEP;
      else if (event.key === 'PageUp') requested = currentHeight - (KEYBOARD_STEP * 4);
      else if (event.key === 'PageDown') requested = currentHeight + (KEYBOARD_STEP * 4);
      else if (event.key === 'Home') requested = MIN_SUMMARY_HEIGHT;
      else if (event.key === 'End') requested = Number.MAX_SAFE_INTEGER;
      if (requested === null) return;
      event.preventDefault();
      applyHeight(requested, true);
    });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => refresh());
      resizeObserver.observe(elements.container);
    } else {
      window.addEventListener('resize', refresh);
    }
  }

  const api = Object.freeze({
    storageKey: STORAGE_KEY,
    defaultHeight: DEFAULT_SUMMARY_HEIGHT,
    minimumSummaryHeight: MIN_SUMMARY_HEIGHT,
    minimumDailyHeight: MIN_DAILY_HEIGHT,
    clampSummaryHeight,
    initialize,
    refresh,
    getHeight: () => currentHeight,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.diaryLootSplitPane = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
  }
})();

interface Window {
  diaryLootSplitPane: {
    storageKey: string;
    defaultHeight: number;
    minimumSummaryHeight: number;
    minimumDailyHeight: number;
    clampSummaryHeight(requested: number, containerHeight: number, resizerHeight: number): number;
    initialize(): void;
    refresh(): void;
    getHeight(): number;
  };
}
