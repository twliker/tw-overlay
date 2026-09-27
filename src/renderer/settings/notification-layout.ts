interface Window {
  settingsNotificationLayout?: {
    bind(config: Partial<BrowserAppConfig>): void;
    collect(): { settings: Record<string, unknown>; fieldIds: string[] };
  };
}

(() => {
  type Positions = import('../../shared/types').NotificationPositions;
  let currentPositions: Positions = { center: 'default', buff: 'default', hunting: 'default', toast: 'default' };

  window.settingsNotificationLayout = {
    bind(config) {
      if (config.notificationPositions) {
        currentPositions = config.notificationPositions;
      }
    },
    collect: () => ({ settings: { notificationPositions: currentPositions }, fieldIds: [] }),
  };
})();
