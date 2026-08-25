/**
 * 가변 높이 목록을 메모리 데이터와 제한된 DOM 창으로 분리합니다.
 * 행 높이 실측 뒤에도 현재 보이는 앵커 행을 같은 위치에 유지합니다.
 */

(() => {
  const DEFAULT_ESTIMATED_HEIGHT = 24;
  const DEFAULT_OVERSCAN_PX = 500;

  class VirtualListControllerImpl<T> implements VirtualListController<T> {
    private readonly container: HTMLElement;
    private readonly content: HTMLDivElement;
    private readonly renderRow: (item: T, index: number) => HTMLElement;
    private readonly getBaseKey: (item: T, index: number) => string;
    private readonly estimatedHeight: number;
    private readonly gap: number;
    private readonly overscanPx: number;
    private readonly paddingStart: number;
    private readonly paddingEnd: number;
    private readonly insetStart: number;
    private readonly insetEnd: number;
    private entries: Array<{ item: T; key: string }> = [];
    private heights: number[] = [];
    private offsets: number[] = [0];
    private keyToIndex = new Map<string, number>();
    private keyCounts = new Map<string, number>();
    private heightCache = new Map<string, number>();
    private renderedNodes = new Map<string, HTMLElement>();
    private renderFrame: number | null = null;
    private renderTimer: ReturnType<typeof setTimeout> | null = null;
    private measureFrame: number | null = null;
    private measureTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    private lastWidth = -1;
    private readonly resizeObserver: ResizeObserver | null;

    constructor(options: VirtualListOptions<T>) {
      this.container = options.container;
      this.renderRow = options.renderRow;
      this.getBaseKey = options.getKey;
      this.estimatedHeight = Math.max(1, options.estimatedHeight ?? DEFAULT_ESTIMATED_HEIGHT);
      this.gap = Math.max(0, options.gap ?? 0);
      this.overscanPx = Math.max(0, options.overscanPx ?? DEFAULT_OVERSCAN_PX);
      this.paddingStart = Math.max(0, options.paddingStart ?? 0);
      this.paddingEnd = Math.max(0, options.paddingEnd ?? 0);
      this.insetStart = Math.max(0, options.insetStart ?? 0);
      this.insetEnd = Math.max(0, options.insetEnd ?? 0);

      this.content = document.createElement('div');
      this.content.className = 'virtual-list-content';
      this.content.style.position = 'relative';
      this.content.style.width = '100%';
      this.content.style.minHeight = '0px';
      this.container.replaceChildren(this.content);
      this.container.addEventListener('scroll', this.handleScroll, { passive: true });

      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(entries => {
          const width = entries[0]?.contentRect.width ?? this.container.clientWidth;
          if (Math.abs(width - this.lastWidth) >= 1) {
            this.lastWidth = width;
            this.resetMeasurements(true);
          } else {
            this.scheduleRender();
          }
        });
        this.resizeObserver.observe(this.container);
      } else {
        this.resizeObserver = null;
      }
    }

    setItems(items: readonly T[], options: VirtualListSetOptions = {}): void {
      if (this.destroyed) return;
      const keepBottom = options.scrollToEnd === true;
      const anchor = !keepBottom && options.preserveAnchor ? this.captureAnchor() : null;
      if (options.resetMeasurements !== false) this.heightCache.clear();

      this.entries = this.makeEntries(items, true);
      this.keyToIndex = new Map(this.entries.map((entry, index) => [entry.key, index]));
      this.heights = this.entries.map(entry => this.heightCache.get(entry.key) ?? this.estimatedHeight);
      this.rebuildOffsets();
      this.clearRenderedNodes();
      this.updateContentHeight();

      if (keepBottom) {
        this.scrollToEnd();
      } else {
        this.restoreAnchor(anchor);
        this.renderNow();
      }
    }

    appendItems(items: readonly T[], options: VirtualListAppendOptions = {}): void {
      if (this.destroyed || items.length === 0) return;
      const keepBottom = options.followEnd ?? this.isAtEnd(50);
      const anchor = keepBottom ? null : this.captureAnchor();
      const startIndex = this.entries.length;
      const appended = this.makeEntries(items, false, startIndex);
      for (let offset = 0; offset < appended.length; offset += 1) {
        const index = startIndex + offset;
        const entry = appended[offset];
        this.entries.push(entry);
        this.keyToIndex.set(entry.key, index);
        this.heights.push(this.heightCache.get(entry.key) ?? this.estimatedHeight);
        this.offsets[index + 1] = this.offsets[index] + this.heights[index] + this.gap;
      }
      this.updateContentHeight();
      if (keepBottom) this.scrollToEnd();
      else {
        this.restoreAnchor(anchor);
        this.renderNow();
      }
    }

    prependItems(items: readonly T[]): void {
      if (this.destroyed || items.length === 0) return;
      const anchor = this.captureAnchor();
      const allItems = (items as T[]).concat(this.entries.map(entry => entry.item));
      this.entries = this.makeEntries(allItems, true);
      this.keyToIndex = new Map(this.entries.map((entry, index) => [entry.key, index]));
      this.heights = this.entries.map(entry => this.heightCache.get(entry.key) ?? this.estimatedHeight);
      this.rebuildOffsets();
      this.clearRenderedNodes();
      this.updateContentHeight();
      this.restoreAnchor(anchor);
      this.renderNow();
    }

    resetMeasurements(preserveAnchor = true): void {
      if (this.destroyed || this.entries.length === 0) return;
      const keepBottom = this.isAtEnd(2);
      const anchor = !keepBottom && preserveAnchor ? this.captureAnchor() : null;
      this.heightCache.clear();
      this.heights = this.entries.map(() => this.estimatedHeight);
      this.rebuildOffsets();
      this.updateContentHeight();
      if (keepBottom) this.scrollToEnd();
      else {
        this.restoreAnchor(anchor);
        this.renderNow();
      }
    }

    scrollToEnd(): void {
      if (this.destroyed) return;
      this.container.scrollTop = Math.max(0, this.getContentHeight() - this.container.clientHeight);
      this.renderNow();
    }

    isAtEnd(threshold = 50): boolean {
      const remaining = this.getContentHeight() - this.container.scrollTop - this.container.clientHeight;
      return remaining <= Math.max(0, threshold);
    }

    getItems(): readonly T[] {
      return this.entries.map(entry => entry.item);
    }

    getState(): VirtualListState {
      const range = this.getRenderRange();
      return {
        totalCount: this.entries.length,
        renderedCount: this.renderedNodes.size,
        startIndex: range.start,
        endIndex: range.end,
        totalHeight: this.getContentHeight(),
      };
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.container.removeEventListener('scroll', this.handleScroll);
      this.resizeObserver?.disconnect();
      this.cancelScheduledRender();
      this.cancelScheduledMeasurement();
      this.clearRenderedNodes();
      this.content.remove();
    }

    private readonly handleScroll = (): void => {
      this.scheduleRender();
    };

    private makeEntries(
      items: readonly T[],
      resetCounts: boolean,
      indexOffset = 0,
    ): Array<{ item: T; key: string }> {
      if (resetCounts) this.keyCounts.clear();
      return items.map((item, index) => {
        const baseKey = String(this.getBaseKey(item, index + indexOffset));
        const occurrence = this.keyCounts.get(baseKey) ?? 0;
        this.keyCounts.set(baseKey, occurrence + 1);
        return { item, key: occurrence === 0 ? baseKey : `${baseKey}#${occurrence}` };
      });
    }

    private rebuildOffsets(startIndex = 0): void {
      const safeStart = Math.max(0, Math.min(startIndex, this.heights.length));
      if (safeStart === 0 || this.offsets.length !== this.heights.length + 1) {
        this.offsets = new Array(this.heights.length + 1).fill(0);
      }
      for (let index = safeStart; index < this.heights.length; index += 1) {
        this.offsets[index + 1] = this.offsets[index] + this.heights[index] + this.gap;
      }
    }

    private getItemsHeight(): number {
      if (this.entries.length === 0) return 0;
      return Math.max(0, this.offsets[this.entries.length] - this.gap);
    }

    private getContentHeight(): number {
      return this.paddingStart + this.getItemsHeight() + this.paddingEnd;
    }

    private updateContentHeight(): void {
      this.content.style.height = `${this.getContentHeight()}px`;
    }

    private findIndexAtOffset(offset: number): number {
      if (this.entries.length === 0) return 0;
      const target = Math.max(0, offset);
      let low = 0;
      let high = this.entries.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.offsets[middle + 1] <= target) low = middle + 1;
        else high = middle;
      }
      return Math.min(low, this.entries.length - 1);
    }

    private getRenderRange(): { start: number; end: number } {
      if (this.entries.length === 0) return { start: 0, end: 0 };
      const viewportStart = Math.max(0, this.container.scrollTop - this.paddingStart);
      const viewportEnd = viewportStart + Math.max(1, this.container.clientHeight);
      const start = this.findIndexAtOffset(Math.max(0, viewportStart - this.overscanPx));
      const last = this.findIndexAtOffset(viewportEnd + this.overscanPx);
      return { start, end: Math.min(this.entries.length, last + 1) };
    }

    private scheduleRender(): void {
      if (this.destroyed || this.renderFrame !== null || this.renderTimer !== null) return;
      const run = (): void => {
        this.cancelScheduledRender();
        this.renderNow();
      };
      this.renderFrame = requestAnimationFrame(run);
      this.renderTimer = setTimeout(run, 40);
    }

    private renderNow(): void {
      if (this.destroyed) return;
      this.cancelScheduledRender();
      const { start, end } = this.getRenderRange();
      const nextNodes = new Map<string, HTMLElement>();
      const fragment = document.createDocumentFragment();

      for (let index = start; index < end; index += 1) {
        const entry = this.entries[index];
        let node = this.renderedNodes.get(entry.key);
        if (!node) node = this.renderRow(entry.item, index);
        node.dataset.virtualKey = entry.key;
        node.style.position = 'absolute';
        node.style.top = `${this.paddingStart + this.offsets[index]}px`;
        node.style.left = `${this.insetStart}px`;
        node.style.right = `${this.insetEnd}px`;
        node.style.width = 'auto';
        nextNodes.set(entry.key, node);
        fragment.appendChild(node);
      }

      this.content.replaceChildren(fragment);
      this.renderedNodes = nextNodes;
      this.scheduleMeasurement();
    }

    private scheduleMeasurement(): void {
      if (this.destroyed || this.measureFrame !== null || this.measureTimer !== null
        || this.renderedNodes.size === 0) return;
      const run = (): void => {
        this.cancelScheduledMeasurement();
        this.measureRenderedRows();
      };
      this.measureFrame = requestAnimationFrame(run);
      this.measureTimer = setTimeout(run, 40);
    }

    private measureRenderedRows(): void {
      if (this.destroyed || this.renderedNodes.size === 0) return;
      const keepBottom = this.isAtEnd(2);
      const anchor = keepBottom ? null : this.captureAnchor();
      let firstChanged = this.heights.length;

      for (const [key, node] of this.renderedNodes) {
        const index = this.keyToIndex.get(key);
        if (index === undefined) continue;
        const measured = node.getBoundingClientRect().height || node.offsetHeight;
        if (!Number.isFinite(measured) || measured <= 0) continue;
        if (Math.abs(this.heights[index] - measured) < 0.5) continue;
        this.heights[index] = measured;
        this.heightCache.set(key, measured);
        firstChanged = Math.min(firstChanged, index);
      }

      if (firstChanged >= this.heights.length) return;
      this.rebuildOffsets(firstChanged);
      this.updateContentHeight();
      if (keepBottom) this.scrollToEnd();
      else {
        this.restoreAnchor(anchor);
        this.renderNow();
      }
    }

    private captureAnchor(): { key: string; offset: number } | null {
      if (this.entries.length === 0) return null;
      const listOffset = Math.max(0, this.container.scrollTop - this.paddingStart);
      const index = this.findIndexAtOffset(listOffset);
      return {
        key: this.entries[index].key,
        offset: this.container.scrollTop - (this.paddingStart + this.offsets[index]),
      };
    }

    private restoreAnchor(anchor: { key: string; offset: number } | null): void {
      if (!anchor) return;
      const index = this.keyToIndex.get(anchor.key);
      if (index === undefined) return;
      this.container.scrollTop = Math.max(0, this.paddingStart + this.offsets[index] + anchor.offset);
    }

    private clearRenderedNodes(): void {
      this.renderedNodes.clear();
      this.content.replaceChildren();
    }

    private cancelScheduledRender(): void {
      if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
      if (this.renderTimer !== null) clearTimeout(this.renderTimer);
      this.renderFrame = null;
      this.renderTimer = null;
    }

    private cancelScheduledMeasurement(): void {
      if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame);
      if (this.measureTimer !== null) clearTimeout(this.measureTimer);
      this.measureFrame = null;
      this.measureTimer = null;
    }
  }

  window.createVirtualList = function <T>(options: VirtualListOptions<T>): VirtualListController<T> {
    return new VirtualListControllerImpl(options);
  };
})();
