interface Window { notificationLayout: { updateConfig(config: Partial<BrowserAppConfig>): void }; }

/** 기능 계약: 알림 표시·소리·지속 시간은 원래 기능이 소유한다. 위치만 바꾸고 미리보기는 5초 뒤 최신 저장 위치로 되돌린다. */
(() => {
  type Positions = import('../../shared/types').NotificationPositions;
  type Group = keyof Positions;
  const api = window.electronAPI as typeof window.electronAPI & { onNotificationPreview?(callback: (positions: Positions) => void): void };
  const defaults: Positions = { center: 'default', buff: 'default', hunting: 'default', toast: 'default' };
  const selectors: Record<Group, string> = {
    center: '#abandoned-alert,#pitta-alert,#quest-alert,#special-monster-alert,#essence-alert,#ethos-arrow-container,#abyss-apostle-alert,#wave-warning-alert,#lokagos-alert,#supply-pad-alert',
    buff: '#buff-alert-container', hunting: '.hunting-assist-panel', toast: '#dock-toast-container',
  };
  const originals = new WeakMap<HTMLElement, { left: string; top: string; right: string }>();
  let saved = defaults;
  let preview: Positions | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sampleNodes: HTMLElement[] = [];
  function place(element: HTMLElement, group: Group, anchor: Positions[Group]): void {
    if (!originals.has(element)) originals.set(element, { left: element.style.left, top: element.style.top, right: element.style.right });
    if (anchor === 'default') { Object.assign(element.style, originals.get(element)); return; }
    const [vertical, horizontal] = anchor.split('-');
    if (!['top', 'middle', 'bottom'].includes(vertical) || !['left', 'center', 'right'].includes(horizontal)) return;
    const x = horizontal === 'left' ? 0 : horizontal === 'right' ? 1 : .5;
    const y = vertical === 'top' ? 0 : vertical === 'bottom' ? 1 : .5;
    const sample = element.dataset.notificationSample === 'true';
    const centeredX = sample || group === 'center' || group === 'buff';
    const centeredY = sample || group === 'center' || group === 'toast';
    const width = element.offsetWidth, height = element.offsetHeight;
    element.style.left = `${12 + Math.max(0, innerWidth - width - 24) * x + (centeredX ? width / 2 : 0)}px`;
    element.style.top = `${12 + Math.max(0, innerHeight - height - 24) * y + (centeredY ? height / 2 : 0)}px`;
    element.style.right = 'auto';
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
    const points: Record<Group, [number, number]> = { center: [50, 42], buff: [50, 28], hunting: [82, 15], toast: [82, 67] };
    for (const group of Object.keys(labels) as Group[]) {
      const node = document.createElement('div'); node.dataset.group = group; node.dataset.notificationSample = 'true';
      node.className = 'ui-hud-card ui-notification-sample';
      node.textContent = `${labels[group]} · 5초 미리보기`;
      node.style.left = `${points[group][0]}%`;
      node.style.top = `${points[group][1]}%`;
      document.body.appendChild(node); sampleNodes.push(node);
    }
    render(); timer = setTimeout(stopPreview, 5000);
  });
  window.notificationLayout = { updateConfig(config) { saved = config.notificationPositions || defaults; render(); } };
  const resize = new ResizeObserver(render);
  document.querySelectorAll<HTMLElement>(Object.values(selectors).join(',')).forEach(element => resize.observe(element));
  window.addEventListener('resize', render);
  window.addEventListener('unload', () => { if (timer) clearTimeout(timer); resize.disconnect(); }, { once: true });
})();
