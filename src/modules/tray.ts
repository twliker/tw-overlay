/**
 * 시스템 트레이 관리 모듈
 */
import { app, Tray, Menu, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as wm from './windowManager';
const { SIDEBAR_CATEGORIES } = require('../shared/sidebarCategories') as {
  SIDEBAR_CATEGORIES: readonly SidebarCategory[];
};
import * as config from './config';
import { log } from './logger';
import { appState } from './constants';
import { SIDEBAR_MENUS, getSidebarMenuAction } from '../shared/sidebarMenus';
import { getTrayMenuHandler } from './trayMenuActions';
import { analytics } from './analytics';

let tray: Tray | null = null;

function buildMenuTemplate(): MenuItemConstructorOptions[] {
  const menuTemplate: MenuItemConstructorOptions[] = [];
  try {
    const menus = SIDEBAR_MENUS;
    const cfg = config.load();
    let hiddenMenuIds = cfg.hiddenMenuIds;
    if (!hiddenMenuIds && cfg.visibleMenuIds) {
      const oldKnownMenuIds = ['gallery-btn', 'abbreviation-btn', 'buffs-btn', 'boss-btn', 'custom-alert-btn', 'eta-ranking-btn', 'trade-btn', 'contents-checker-btn', 'home-btn', 'overlay-toggle-btn', 'click-through-btn'];
      hiddenMenuIds = oldKnownMenuIds.filter(id => !cfg.visibleMenuIds!.includes(id));
    } else if (!hiddenMenuIds) {
      hiddenMenuIds = [];
    }

    // 1. 카테고리 정의
    const trayCategories = [...SIDEBAR_CATEGORIES]
      .sort((left, right) => left.trayOrder - right.trayOrder)
      .map(category => ({
        id: category.id,
        label: category.trayLabel || category.label,
      }));

    // 2. 카테고리별 서브메뉴 빌드
    trayCategories.forEach(cat => {
      const catMenus = menus.filter(m => m.category === cat.id && !m.isSystem);

      if (cat.id === 'homework') {
        catMenus.forEach(m => {
          if (hiddenMenuIds.includes(m.id)) return;
          const handler = getTrayMenuHandler(getSidebarMenuAction(m));
          if (handler) menuTemplate.push({ label: m.label, click: handler });
        });
        return;
      }

      const subItems: MenuItemConstructorOptions[] = [];

      catMenus.forEach(m => {
        if (hiddenMenuIds.includes(m.id)) return;
        const handler = getTrayMenuHandler(getSidebarMenuAction(m));
        if (handler) subItems.push({ label: m.label, click: handler });
      });

      if (subItems.length > 0) {
        menuTemplate.push({
          label: cat.label,
          submenu: Menu.buildFromTemplate(subItems)
        });
      }
    });

    // 3. 시스템 관련 독립 제어 메뉴 추가
    const systemMenus = menus.filter(m => m.isSystem);
    if (systemMenus.length > 0) {
      menuTemplate.push({ type: 'separator' });
      systemMenus.forEach(m => {
        if (hiddenMenuIds.includes(m.id)) return;
        const handler = getTrayMenuHandler(getSidebarMenuAction(m));
        if (handler) menuTemplate.push({ label: m.label, click: handler });
      });
    }

    if (menuTemplate.length > 0) {
      menuTemplate.push({ type: 'separator' });
    }
  } catch (e) {
    log(`[TRAY] 메뉴 데이터 로드 실패: ${e}`);
  }

  // 4. 기본 관리 메뉴 추가 (설정, 종료)
  menuTemplate.push({
    label: '환경 설정',
    click: () => {
      analytics.trackEvent('toggle_settings');
      wm.toggleSettingsWindow();
    }
  });
  menuTemplate.push({
    label: '앱 종료',
    click: () => {
      appState.isQuitting = true;
      app.quit();
    }
  });

  return menuTemplate;
}

export function createTray(): Tray {
  let iconPath = path.join(__dirname, '..', 'icons', 'icon.ico');

  // 아이콘 파일이 없는 경우를 대비한 방어 로직
  if (!fs.existsSync(iconPath)) {
    log(`[TRAY] 아이콘 파일을 찾을 수 없음: ${iconPath}`);
  }

  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate(buildMenuTemplate());

  tray.setToolTip('TW-Overlay');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    // 게임이 실행 중이고 추적 중일 때만 사이드바 노출
    if (!wm.getGameRect()) return;

    const sidebar = wm.getMainWindow();
    if (sidebar) {
      analytics.trackEvent('toggle_sidebar');
      if (sidebar.isMinimized()) sidebar.restore();
      sidebar.show();
      sidebar.focus();
    }
  });

  return tray;
}

export function updateTrayMenu(): void {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate(buildMenuTemplate());
  tray.setContextMenu(contextMenu);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
