interface SidebarCategory {
  id: string;
  label: string;
  trayLabel?: string;
  settingsLabel?: string;
  icon: string;
  color: string;
  trayOrder: number;
}

interface Window {
  sidebarCategories: readonly SidebarCategory[];
}

(function exposeSidebarCategories(globalObject: Window | null): void {
  const SIDEBAR_CATEGORIES: readonly SidebarCategory[] = Object.freeze([
    { id: 'records', label: '플레이 관리 & 기록', icon: 'clipboard-check', color: 'emerald-400', trayOrder: 0 },
    { id: 'monitoring', label: '커뮤니티 & 채팅', icon: 'messages-square', color: 'sky-400', trayOrder: 1 },
    { id: 'alarms', label: '알림 설정', icon: 'bell-ring', color: 'pink-400', trayOrder: 2 },
    { id: 'calculators', label: '계산기 & 시뮬레이터', icon: 'calculator', color: 'indigo-400', trayOrder: 3 },
    { id: 'information', label: '정보 & 도감', icon: 'book-open', color: 'blue-400', trayOrder: 4 },
    {
      id: 'homework',
      label: '숙제 체크 리스트',
      trayLabel: '숙제 체크',
      settingsLabel: '숙제 관리',
      icon: 'check-square',
      color: 'violet-400',
      trayOrder: 5,
    },
    {
      id: 'minigame',
      label: '미니게임',
      icon: 'gamepad-2',
      color: 'amber-400',
      trayOrder: 6,
    },
  ]);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SIDEBAR_CATEGORIES };
  }
  if (globalObject) {
    globalObject.sidebarCategories = SIDEBAR_CATEGORIES;
  }
})(typeof window !== 'undefined' ? window : null);
