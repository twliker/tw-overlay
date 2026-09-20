/** 기능 계약: 같은 화면 위치에서 겹치는 알림은 행동 기믹 → 시간 안내 → 완료/획득 순으로 읽힌다.
 * 원래 타이머·소리·기록은 그대로 진행하고, 가려진 알림을 대기열에 쌓거나 뒤늦게 재생하지 않는다.
 * 서로 다른 위치에 배치한 알림과 편집/샘플에는 간섭하지 않는다.
 */
(() => {
  const definitions: Array<[string, number, (node: HTMLElement) => boolean]> = [
    ['abyss-apostle-alert', 3, node => node.classList.contains('warn') || node.classList.contains('safe')],
    ['lokagos-alert', 3, node => node.classList.contains('show')],
    ['ethos-arrow-container', 3, node => !!node.querySelector('.ethos-arrow-wrapper.show')],
    ['supply-pad-alert', 3, node => !node.classList.contains('hidden')],
    ['wave-warning-alert', 2, node => node.classList.contains('warn')],
    ...['quest-alert', 'abandoned-alert', 'pitta-alert', 'essence-alert', 'special-monster-alert'].map(id =>
      [id, 1, (node: HTMLElement) => node.getAnimations().some(animation => animation.playState === 'running')] as [string, number, (node: HTMLElement) => boolean]),
  ];
  const items = definitions.map(([id, priority, active]) => ({ node: document.getElementById(id), priority, active, serial: 0, wasActive: false }));
  let serial = 0, queued = false;
  function render(): void {
    queued = false;
    const active = items.filter(item => {
      if (!item.node) return false;
      const visible = item.active(item.node);
      if (visible && !item.wasActive) item.serial = ++serial;
      item.wasActive = visible;
      item.node.removeAttribute('data-notification-muted');
      return visible;
    }).sort((a, b) => b.priority - a.priority || b.serial - a.serial);
    const visible: DOMRect[] = [];
    for (const item of active) {
      const rect = item.node!.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (visible.some(other => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)) {
        item.node!.dataset.notificationMuted = 'true';
      } else visible.push(rect);
    }
  }
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(render); } };
  const observer = new MutationObserver(schedule);
  const resize = new ResizeObserver(schedule);
  for (const item of items) if (item.node) {
    observer.observe(item.node, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
    resize.observe(item.node);
  }
  document.addEventListener('animationstart', schedule, true);
  document.addEventListener('animationend', schedule, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('unload', () => { observer.disconnect(); resize.disconnect(); }, { once: true });
  schedule();
})();
