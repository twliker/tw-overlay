/** game-overlay의 단발성 알림 카드 렌더링을 담당합니다. */
(() => {
  const { replayAnimation } = window;

  function byId(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  function showAbandonedAlert(region: string): void {
    const flash = byId('abandoned-flash');
    const alert = byId('abandoned-alert');
    const regionLabel = byId('abandoned-alert-region');
    if (!alert || !regionLabel) return;

    regionLabel.innerText = region;
    replayAnimation(flash);
    replayAnimation(alert);
  }

  function showEssenceAlert(): void {
    replayAnimation(byId('essence-alert'));
  }

  function showPittaAlert(): void {
    replayAnimation(byId('pitta-alert'));
  }

  function showSpecialMonsterAlert(): void {
    replayAnimation(byId('special-monster-alert'));
  }

  function showQuestComplete({
    questName,
    target,
    iconName,
  }: {
    questName: string;
    target: number;
    iconName: string;
  }): void {
    const alert = byId('quest-alert');
    const icon = byId('quest-alert-icon');
    const title = byId('quest-alert-title');
    const badge = byId('quest-alert-badge');
    if (!alert) return;

    if (icon) {
      icon.setAttribute('data-lucide', iconName);
      if (window.lucide) window.lucide.createIcons();
    }
    if (title) title.textContent = `${questName} 도전과제 완료`;
    if (badge) badge.textContent = `몬스터 ${target.toLocaleString()}마리 처치 완료`;
    replayAnimation(alert);
  }

  function showContentComplete({
    title: titleText,
    badge: badgeText,
    iconName,
  }: {
    title: string;
    badge: string;
    iconName: string;
  }): void {
    const alert = byId('quest-alert');
    const icon = byId('quest-alert-icon');
    const title = byId('quest-alert-title');
    const badge = byId('quest-alert-badge');
    if (!alert) return;

    if (icon) {
      icon.setAttribute('data-lucide', iconName);
      if (window.lucide) window.lucide.createIcons();
    }
    if (title) title.textContent = titleText;
    if (badge) badge.textContent = badgeText;
    replayAnimation(alert);
  }

  window.gameOverlayAlerts = Object.freeze({
    showAbandonedAlert,
    showEssenceAlert,
    showPittaAlert,
    showSpecialMonsterAlert,
    showQuestComplete,
    showContentComplete
  });
})();
