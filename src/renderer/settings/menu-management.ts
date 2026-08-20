/** 설정 화면의 사이드바 메뉴 표시 항목과 구버전 설정 호환을 관리합니다. */
(() => {
  interface MenuDefinition {
    id?: string;
    category?: string;
    label?: string;
    icon?: string;
    image?: string;
    color?: string;
    isSystem?: boolean;
    isComment?: boolean;
  }

  interface MenuVisibilityConfig {
    hiddenMenuIds?: string[];
    visibleMenuIds?: string[];
  }

  const OLD_KNOWN_MENU_IDS = Object.freeze([
    'gallery-btn', 'abbreviation-btn', 'buffs-btn', 'boss-btn', 'custom-alert-btn',
    'eta-ranking-btn', 'trade-btn', 'contents-checker-btn', 'home-btn',
    'overlay-toggle-btn', 'click-through-btn',
  ]);

  let loadedMenus: MenuDefinition[] = [];

  function resolveHiddenMenuIds(config: MenuVisibilityConfig): string[] {
    if (config.hiddenMenuIds) return config.hiddenMenuIds;
    if (config.visibleMenuIds) {
      return OLD_KNOWN_MENU_IDS.filter(id => !config.visibleMenuIds?.includes(id));
    }
    return [];
  }

  function applyConfig(config: MenuVisibilityConfig | null | undefined): void {
    if (!config || loadedMenus.length === 0) return;
    const hiddenMenuIds = resolveHiddenMenuIds(config);
    document.querySelectorAll<HTMLInputElement>('.menu-visible-check').forEach(check => {
      check.checked = !hiddenMenuIds.includes(check.value);
    });
  }

  function render(menus: MenuDefinition[], config?: MenuVisibilityConfig | null): void {
    loadedMenus = menus;
    const grid = document.getElementById('menu-management-grid') as HTMLElement;
    grid.innerHTML = '';

    [...window.sidebarCategories]
      .sort((left, right) => left.trayOrder - right.trayOrder)
      .forEach(category => {
      const categoryMenus = loadedMenus.filter(menu => (
        menu.category === category.id && !menu.isSystem && !menu.isComment && menu.id
      ));
      if (categoryMenus.length === 0) return;

      const section = document.createElement('div');
      section.className = 'space-y-2';

      const header = document.createElement('div');
      header.className = 'flex items-center gap-2 pb-1 border-b border-white/5';
      header.innerHTML = `<i data-lucide="${category.icon}" class="w-3.5 h-3.5 text-${category.color}"></i><span class="text-xs font-black text-${category.color} uppercase tracking-widest">${category.settingsLabel || category.label}</span>`;
      section.appendChild(header);

      const menuGrid = document.createElement('div');
      menuGrid.className = 'grid grid-cols-2 gap-2 pl-1';
      categoryMenus.forEach(menu => {
        const label = document.createElement('label');
        label.className = 'flex items-center gap-3 cursor-pointer group';
        const menuIcon = menu.image
          ? `<img src="${menu.image}" class="w-3.5 h-3.5 object-contain" alt="">`
          : `<i data-lucide="${menu.icon}" class="w-3.5 h-3.5 text-${menu.color}"></i>`;
        label.innerHTML = `<input type="checkbox" value="${menu.id}" class="menu-visible-check w-4 h-4 accent-purple-600">${menuIcon}<span class="text-xs font-bold text-slate-400 group-hover:text-white">${menu.label}</span>`;
        menuGrid.appendChild(label);
      });
      section.appendChild(menuGrid);
      grid.appendChild(section);
    });

    window.refreshIcons();
    if (config) applyConfig(config);
  }

  async function initialize(config?: MenuVisibilityConfig | null): Promise<void> {
    try {
      const response = await fetch('assets/data/sidebar_menus.json');
      render(await response.json() as MenuDefinition[], config);
    } catch (error) {
      console.error('Failed to load menu management:', error);
    }
  }

  function collectHiddenMenuIds(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('.menu-visible-check:not(:checked)'),
      check => check.value,
    );
  }

  window.settingsMenuManagement = Object.freeze({
    initialize,
    render,
    applyConfig,
    collectHiddenMenuIds,
  });
})();
