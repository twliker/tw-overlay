/**
 * 창 관리 모듈 - WebContentsView + 동적 Z-Order 스택 버전
 */
import { BrowserWindow, WebContentsView, screen } from 'electron';
import type { WebContents } from 'electron';
import * as path from 'path';
import { MIN_W, MIN_H, IS_DEV, SHOULD_AUTO_OPEN_DEVTOOLS, WindowPosition, SIDEBAR_HEIGHT, SIDEBAR_WIDTH, OVERLAY_TOOLBAR_HEIGHT, GameRect, POSITION_THRESHOLD, AppConfig, appState, FOCUS_RESTORE_DELAY_MS } from './constants';
import * as config from './config';
import * as bossNotifier from './bossNotifier';
import * as gallery from './galleryMonitor';
import * as trade from './tradeMonitor';
import * as tracker from './tracker';
import { log } from './logger';
import { buffTimerManager } from './buffTimerManager';
import * as diaryDb from './diaryDb';
import type { EquipmentDictionaryItem, WindowPositionKey } from '../shared/types';
import { copyDefaultWindowPosition } from '../shared/windowPositions';
import { collectIncompleteContents } from './contentsSummary';
import { getStandardOptions, isValidCoordinate } from './windowOptions';
import { createManagedWindowRegistry } from './managedWindowRegistry';
import type { ManagedWindow } from './managedWindowRegistry';
import { centerWindowInWorkArea, isWindowVisibleOnDisplays } from './windowPlacement';
import { applyManagedWindowSize, resolveManagedWindowSizing } from './managedWindowSizing';
import { WindowFocusController } from './windowFocusController';
import { ProgrammaticMoveTracker } from './programmaticMoveTracker';
import { EmbeddedWebTool } from './embeddedWebTool';
import { OverlayToolbarController } from './overlayToolbarController';
import { createDisplayTopologySignature, DisplayTopologyStabilizer } from './displayTopologyStabilizer';
import {
  calculateAttachedWindowPosition,
  calculateBrowserOverlayPosition,
  calculateSidebarBounds,
  calculateSidebarResizeBounds,
  hasBoundsChanged,
  hasPositionChanged,
  isFullscreenBounds,
  resizeBounds,
  resolvePhysicalGameRect,
} from './windowLayout';


// --- 상태 관리 ---
let pendingCoefficientItem: EquipmentDictionaryItem | null = null;
let pendingEvolutionItem: EquipmentDictionaryItem | null = null;
let pendingSettingsTab: string | null = null;

/** 게임/TW-Overlay가 전경일 때 우리 창만 게임 바로 위에 샌드위치로 배치한다. */
function bringGameAndOverlaysToTop(): void {
  if (!gameRect || programmaticMoves.isAnyUserDragging()) return;
  const gameHwndStr = tracker.getGameHwnd();
  if (!gameHwndStr) return;
  tracker.reconcileGameZOrder(gameHwndStr, getAllWindowHwnds());
}

export const isAnyUserDragging = () => programmaticMoves.isAnyUserDragging();

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let view: WebContentsView | null = null;
let uniformColorTool: EmbeddedWebTool | null = null;
let swordEnhanceTool: EmbeddedWebTool | null = null;
let gameOverlayWindow: BrowserWindow | null = null;
let welcomeGuideWindow: BrowserWindow | null = null;
let updateNoticeWindow: BrowserWindow | null = null;

export function createGameOverlayWindow(): void {
  if (gameOverlayWindow) return;
  gameOverlayWindow = new BrowserWindow(getStandardOptions(0, 0, {
    skipTaskbar: true,
    alwaysOnTop: false,
    focusable: false,
    hasShadow: false
  }));
  gameOverlayWindow.setIgnoreMouseEvents(true);
  gameOverlayWindow.loadFile(path.join(__dirname, '..', 'game-overlay.html'));
  focusController.attach(gameOverlayWindow);

  // 개발 환경에서만 테스트 편의를 위해 개발자 도구 자동 활성화
  if (SHOULD_AUTO_OPEN_DEVTOOLS) {
    gameOverlayWindow.webContents.openDevTools({ mode: 'detach' });
  }

  gameOverlayWindow.once('ready-to-show', () => {
    if (gameOverlayWindow && !gameOverlayWindow.isDestroyed()) {
      gameOverlayWindow.showInactive();
      // 생성 직후 최신 설정 전송 (경험치 HUD 위치 등 반영용)
      const currentConfig = config.load();
      gameOverlayWindow.webContents.send('config-data', currentConfig);
      gameOverlayWindow.webContents.send('today-summary-config', currentConfig);
    }
  });

  // HTML 파싱 및 스크립트 로드 완료 후 확실하게 한 번 더 전송 (Race Condition 방지)
  gameOverlayWindow.webContents.on('did-finish-load', () => {
    if (gameOverlayWindow && !gameOverlayWindow.isDestroyed()) {
      const currentConfig = config.load();
      gameOverlayWindow.webContents.send('config-data', currentConfig);
      gameOverlayWindow.webContents.send('today-summary-config', currentConfig);
    }
  });

  gameOverlayWindow.on('closed', () => {
    gameOverlayWindow = null;
  });
}

function applyChatOverlayClickThrough(win: BrowserWindow): void {
  const cfg = config.load();
  if (cfg.chatOverlayClickThrough) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
}

const windowRegistry = createManagedWindowRegistry();

Object.assign(windowRegistry.chatOverlay, {
  onOpen: (win) => {
    applyChatOverlayClickThrough(win);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat-overlay-status', true);
    }
    win.webContents.send('chat-overlay-mode', 'main');
  },
  onClose: () => {
    // 게임 창 최소화/숨김 시 닫히는 경우와 사용자가 직접 닫은 경우를 구분하기 위해,
    // config 저장 및 isChatOverlayVisible 변수 갱신은 toggleChatOverlayWindow()에서만 수행합니다.
    // 여기서는 닫혔을 때 UI 상태 갱신 및 서브 창 닫기 동작만 수행합니다.
    const updated = config.load();

    const dockCfg = windowRegistry['dock'];
    [mainWindow, dockCfg?.ref].forEach(win => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('config-data', updated);
      }
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat-overlay-status', false);
    }

    // 서브 창들도 함께 닫아줌
    ['chatOverlaySub', 'chatOverlaySub2'].forEach(key => {
      const subWindow = windowRegistry[key].ref;
      if (subWindow && !subWindow.isDestroyed()) {
        subWindow.close();
      }
    });
  },
} satisfies Partial<ManagedWindow>);

Object.assign(windowRegistry.chatOverlaySub, {
  onOpen: (win) => {
    applyChatOverlayClickThrough(win);
    win.webContents.send('chat-overlay-mode', 'sub1');
  },
  onClose: () => {
    // 게임 창 최소화 등으로 인해 닫히는 동작에서는 설정 저장을 무시하기 위해,
    // config 저장 및 isChatOverlaySubVisible 변수 갱신은 toggleSubWindow()에서만 수행합니다.
    broadcastConfig();
  },
} satisfies Partial<ManagedWindow>);

Object.assign(windowRegistry.chatOverlaySub2, {
  onOpen: (win) => {
    applyChatOverlayClickThrough(win);
    win.webContents.send('chat-overlay-mode', 'sub2');
  },
  onClose: () => {
    // 게임 창 최소화 등으로 인해 닫히는 동작에서는 설정 저장을 무시하기 위해,
    // config 저장 및 isChatOverlaySub2Visible 변수 갱신은 toggleSubWindow()에서만 수행합니다.
    broadcastConfig();
  },
} satisfies Partial<ManagedWindow>);

Object.assign(windowRegistry.settings, {
  onClose: () => {
    if (gameOverlayWindow && !gameOverlayWindow.isDestroyed()) {
      gameOverlayWindow.setIgnoreMouseEvents(true);
      gameOverlayWindow.setFocusable(false);
      gameOverlayWindow.setAlwaysOnTop(false);
      gameOverlayWindow.webContents.send('game-overlay-edit-mode', false, true);
    }
    if (pendingFullscreenDockLayoutRestore) {
      setTimeout(() => {
        if (appState.isQuitting || !pendingFullscreenDockLayoutRestore) return;
        tracker.restoreGameAfterOwnedWindowClose('settings-dock-layout-change');
      }, FOCUS_RESTORE_DELAY_MS);
    }
  },
} satisfies Partial<ManagedWindow>);
Object.assign(windowRegistry.contentsChecker, {
  onClose: () => broadcastConfig(),
} satisfies Partial<ManagedWindow>);
Object.assign(windowRegistry.focusedChat, {
  onClose: () => { void import('./chatLogProcessor').then(mod => mod.chatLogProcessor.clearFocusedChatSession()); },
} satisfies Partial<ManagedWindow>);
Object.assign(windowRegistry.dock, {
  onOpen: (_win) => {
    sendActiveWindowsStatus();
  },
  onClose: () => {
    isDockVisible = false;
  },
  calcPosition: (gr, _pos) => {
    const cfg = config.load();
    const targetX = Math.round(gr.x + (gr.width - 800) / 2);
    const isTop = cfg.sidebarPosition === 'dock-top';
    const targetY = isTop
      ? Math.round(gr.y + 20)
      : Math.round(gr.y + gr.height - 380 - 20);
    return { x: targetX, y: targetY };
  },
} satisfies Partial<ManagedWindow>);

let gameRect: GameRect | null = null;
let lastKnownGameRect: GameRect | null = null;
let physicalGameRect: GameRect | null = null;
let lastForegroundSize: { width: number; height: number } | null = null;
let isGameFullscreen = false;
// 독 상/하단 전환은 표시 중인 투명 창을 곧바로 이동하면 Windows Shell의
// 전체화면 판정과 내부 Z-order가 흔들릴 수 있으므로 게임이 전경으로 돌아온 뒤 적용합니다.
let pendingDockLayoutChange = false;
let pendingFullscreenDockLayoutRestore = false;

/** 게임이 실행 중이거나, 최소화/종료 직전 마지막으로 감지되었던 게임창 모니터(주/서브)의 작업 영역 중앙 좌표를 계산합니다. */
function resolveFallbackWindowPosition(
  width: number,
  height: number,
): { x: number; y: number } {
  const targetRect = gameRect || lastKnownGameRect;
  if (targetRect) {
    const targetDisplay = screen.getDisplayNearestPoint({ x: targetRect.x, y: targetRect.y });
    return centerWindowInWorkArea(width, height, targetDisplay.workArea);
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  return centerWindowInWorkArea(width, height, primaryDisplay.workArea);
}

let overlayPos: WindowPosition = copyDefaultWindowPosition('overlay');
let isTracking = false;
const programmaticMoves = new ProgrammaticMoveTracker(POSITION_THRESHOLD, 1000);
let isClickThrough = false;
let isApplyingSize = false;
let isToolbarShown = true;
let isSidebarCollapsed = false;
let isOverlayVisible = false;
let isChatOverlayVisible = false;
let isChatOverlaySubVisible = false; // 신규 추가
let isChatOverlaySub2Visible = false; // 신규 추가
let isContentsCheckerVisible = false;
let onOverlayReady: (() => void) | null = null;
let mandatoryUpdateLock = false;

const focusController = new WindowFocusController({
  isDev: IS_DEV,
  focusDebounceMs: 50,
  focusRestoreDelayMs: FOCUS_RESTORE_DELAY_MS,
  onWindowFocused: bringGameAndOverlaysToTop,
  canScheduleRestore: () => !appState.isQuitting && gameRect !== null && tracker.canAutomaticallyRestoreGameFocus(),
  canRestoreFocus: () => gameRect !== null && tracker.canAutomaticallyRestoreGameFocus(),
  restoreFocus: () => tracker.focusGameWindow(),
});

function setProgrammaticMove(key: string, x?: number, y?: number): void {
  if (x === undefined || y === undefined) return;
  const win = key === 'main'
    ? mainWindow
    : key === 'overlay'
      ? overlayWindow
      : windowRegistry[key as WindowPositionKey]?.ref;
  const bounds = win && !win.isDestroyed() ? win.getBounds() : { x, y };
  programmaticMoves.record(key, { x, y }, bounds);
}

function consumeProgrammaticMove(key: string, win?: BrowserWindow | null): boolean {
  const bounds = win && !win.isDestroyed() ? win.getBounds() : undefined;
  return programmaticMoves.consume(key, bounds);
}

function init() {
  const cfg = config.load();
  isChatOverlayVisible = !!cfg.chatOverlayEnabled;
  isChatOverlaySubVisible = !!cfg.chatOverlaySubEnabled; // 신규 추가
  isChatOverlaySub2Visible = !!cfg.chatOverlaySub2Enabled; // 신규 추가
  isContentsCheckerVisible = !!cfg.contentsCheckerEnabled;
  if (cfg.positions) {
    if (cfg.positions.overlay) overlayPos = { ...cfg.positions.overlay };
    Object.keys(windowRegistry).forEach(key => {
      const pos = cfg.positions![key as keyof typeof cfg.positions];
      if (pos) windowRegistry[key].pos = { ...pos };
    });
  }
}
init();

function savePosition(winType: WindowPositionKey, pos: WindowPosition, immediate = false) {
  const currentCfg = config.load();
  const positions = { ...(currentCfg.positions || {}), [winType]: { ...pos } };
  config.markStoredPosition(winType);
  if (immediate) config.saveImmediate({ positions });
  else config.save({ positions });
}

export const getSplashWindow = () => splashWindow;
export const getOverlayWindow = () => overlayWindow;
export const getSettingsWindow = () => windowRegistry.settings.ref;
export const getGalleryWindow = () => windowRegistry.gallery.ref;
export const getAbbreviationWindow = () => windowRegistry.abbreviation.ref;
export const getEquipmentDicWindow = () => windowRegistry.equipmentDic.ref;
export const getBuffsWindow = () => windowRegistry.buffs.ref;
export const getBossSettingsWindow = () => windowRegistry.bossSettings.ref;
export const getEtaRankingWindow = () => windowRegistry.etaRanking.ref;
export const getTradeWindow = () => windowRegistry.trade.ref;
export const getCoefficientCalculatorWindow = () => windowRegistry.coefficientCalculator.ref;
export const getContentsCheckerWindow = () => windowRegistry.contentsChecker.ref;
export const getEvolutionCalculatorWindow = () => windowRegistry.evolutionCalculator.ref;
export const getCustomAlertWindow = () => windowRegistry.customAlert.ref;
export const getUniformColorWindow = () => windowRegistry.uniformColor.ref;
export const getScamDetectorWindow = () => windowRegistry.scamDetector.ref;
export const getView = () => { if (overlayWindow) return view; return null; };
export const getIsOverlayVisible = () => isOverlayVisible;
export const getGameRect = () => gameRect;
export const getDockWindow = () => windowRegistry.dock.ref;
export const getIsDockVisible = () => isDockVisible;
export const getGameOverlayWindow = () => gameOverlayWindow;

export function onOverlayWindowReady(callback: () => void): void { onOverlayReady = callback; }

export function createSplashWindow(): BrowserWindow {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.focus();
    return splashWindow;
  }
  splashWindow = new BrowserWindow(getStandardOptions(400, 500, {
    center: true, skipTaskbar: true, resizable: false, movable: false, focusable: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '..', 'splashPreload.js'), contextIsolation: true, nodeIntegration: false }
  }));
  splashWindow.setIgnoreMouseEvents(true);
  splashWindow.loadFile(path.join(__dirname, '..', 'splash.html'));
  splashWindow.once('ready-to-show', () => { splashWindow?.show(); });
  return splashWindow;
}

export const getWelcomeGuideWindow = () => welcomeGuideWindow;

export function createWelcomeGuideWindow(): void {
  if (welcomeGuideWindow && !welcomeGuideWindow.isDestroyed()) {
    welcomeGuideWindow.focus();
    return;
  }
  const width = 870;
  const height = 720;
  const { x, y } = resolveFallbackWindowPosition(width, height);

  welcomeGuideWindow = new BrowserWindow(getStandardOptions(width, height, {
    x,
    y,
    center: false,
    resizable: false,
    focusable: true
  }));
  welcomeGuideWindow.loadFile(path.join(__dirname, '..', 'welcome-guide.html'));
  focusController.attach(welcomeGuideWindow);
  welcomeGuideWindow.once('ready-to-show', () => {
    welcomeGuideWindow?.show();
  });
  welcomeGuideWindow.on('closed', () => {
    welcomeGuideWindow = null;
    config.save({ hasSeenWelcomeGuide: true, setupCompleted: true });
  });
}

export function toggleWelcomeGuideWindow(): boolean {
  if (welcomeGuideWindow && !welcomeGuideWindow.isDestroyed()) {
    welcomeGuideWindow.close();
    welcomeGuideWindow = null;
    return false;
  }
  createWelcomeGuideWindow();
  return true;
}

export const getUpdateNoticeWindow = () => updateNoticeWindow;

export function createUpdateNoticeWindow(): void {
  if (updateNoticeWindow && !updateNoticeWindow.isDestroyed()) {
    updateNoticeWindow.focus();
    return;
  }
  const width = 640;
  const height = 680;
  const { x, y } = resolveFallbackWindowPosition(width, height);
  const customOptions: Electron.BrowserWindowConstructorOptions = {
    x,
    y,
    center: false,
    resizable: false,
    alwaysOnTop: false,
    focusable: true
  };

  updateNoticeWindow = new BrowserWindow(getStandardOptions(width, height, customOptions));
  updateNoticeWindow.loadFile(path.join(__dirname, '..', 'update-notice.html'));
  focusController.attach(updateNoticeWindow);
  updateNoticeWindow.once('ready-to-show', () => {
    updateNoticeWindow?.show();
  });
  updateNoticeWindow.on('closed', () => {
    updateNoticeWindow = null;
  });
}

export function closeUpdateNoticeWindow(): void {
  if (updateNoticeWindow && !updateNoticeWindow.isDestroyed()) {
    updateNoticeWindow.close();
    updateNoticeWindow = null;
  }
}

export function toggleUpdateNoticeWindow(): boolean {
  if (updateNoticeWindow && !updateNoticeWindow.isDestroyed()) {
    updateNoticeWindow.close();
    updateNoticeWindow = null;
    return false;
  }
  createUpdateNoticeWindow();
  return true;
}

export function closeSplashWindow(): void {
  if (mandatoryUpdateLock) return; // 필수 업데이트 진행 중에는 스플래시 유지
  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;

    // 스플래시가 닫힌 후, 최초 실행(가이드/마법사를 한 번도 확인하지 않은 경우)에만 웰컴 가이드를 띄움
    const cfg = config.load();
    const hasSeen = cfg.hasSeenWelcomeGuide === true || cfg.setupCompleted === true;
    if (!hasSeen) {
      createWelcomeGuideWindow();
    } else {
      // 기존 사용자인 경우 새 버전 업데이트 공지 확인
      import('./noticeManager').then(nm => {
        if (nm.shouldShowUpdateNotice()) {
          createUpdateNoticeWindow();
        }
      });
    }
  }
}

/** 필수 업데이트 잠금 설정 — 잠금 중에는 스플래시만 표시 */
export function setMandatoryUpdateLock(lock: boolean): void {
  mandatoryUpdateLock = lock;
  if (lock) {
    if (!splashWindow || splashWindow.isDestroyed()) {
      createSplashWindow();
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.setIgnoreMouseEvents(false);
      splashWindow.setAlwaysOnTop(true);
      splashWindow.show();
      splashWindow.focus();
    }
    // 사이드바, 오버레이, 모든 독립 창 숨기기
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    Object.values(windowRegistry).forEach(winCfg => {
      if (winCfg.ref && !winCfg.ref.isDestroyed()) winCfg.ref.hide();
    });
  } else {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.setAlwaysOnTop(false);
    }
    closeSplashWindow();
  }
}

export function createMainWindow(): BrowserWindow {
  const cfg = config.load();
  isOverlayVisible = cfg.overlayVisible !== false;
  isClickThrough = !!cfg.chatOverlayClickThrough;
  // focusable: true로 변경하여 클릭 신호 수신 안정화
  mainWindow = new BrowserWindow(getStandardOptions(SIDEBAR_WIDTH, SIDEBAR_HEIGHT, { skipTaskbar: true, resizable: false, thickFrame: false, focusable: true, acceptFirstMouse: true }));
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  const sendUpdateInfo = () => {
    import('./updater').then(mod => {
      const info = mod.getCurrentStatus();
      if (info && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', info);
      }
    });
  };

  mainWindow.once('ready-to-show', () => {
    if (SHOULD_AUTO_OPEN_DEVTOOLS) mainWindow?.webContents.openDevTools({ mode: 'detach' });
    mainWindow?.webContents.send('config-data', config.load());
    mainWindow?.webContents.send('click-through-status', isClickThrough);
    sendUpdateInfo();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    sendUpdateInfo();
  });
  mainWindow.on('move', () => { consumeProgrammaticMove('main', mainWindow); });
  focusController.attach(mainWindow);
  return mainWindow;
}

function createOverlayWindow(targetUrl?: string): void {
  if (overlayWindow) return;
  const cfg = config.load();
  let isClosing = false;
  overlayWindow = new BrowserWindow(getStandardOptions(cfg.width, cfg.height, { minWidth: MIN_W, minHeight: MIN_H, skipTaskbar: true }));
  overlayWindow.setOpacity(cfg.opacity);
  overlayWindow.loadFile(path.join(__dirname, '..', 'overlay.html'));
  view = new WebContentsView({ webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, '..', 'overlay-view-preload.js') } });
  overlayWindow.contentView.addChildView(view);
  view.webContents.setWindowOpenHandler(({ url }) => { if (view) view.webContents.loadURL(url); return { action: 'deny' }; });
  view.webContents.loadURL(targetUrl || cfg.url || cfg.homeUrl);
  const updateUrl = () => {
    if (view && overlayWindow && !overlayWindow.isDestroyed()) {
      const currentUrl = view.webContents.getURL();
      overlayWindow.webContents.send('url-change', currentUrl);
      config.save({ url: currentUrl });
    }
  };
  view.webContents.on('did-navigate', updateUrl);
  view.webContents.on('did-navigate-in-page', updateUrl);
  overlayWindow.on('close', () => {
    isClosing = true;
  });
  overlayWindow.on('move', () => {
    // 전체화면(isGameFullscreen) 상태일 때는 사용자 이동 오프셋을 덮어쓰거나 저장하지 않음 (창모드 복귀 시 위치 유지를 위해)
    if (isClosing || consumeProgrammaticMove('overlay', overlayWindow) || isApplyingSize || !overlayWindow || isGameFullscreen) return;
    programmaticMoves.markUserDrag('overlay');
    const b = overlayWindow.getBounds();
    if (isTracking && gameRect) {
      overlayPos.offsetX = b.x - gameRect.x;
      overlayPos.offsetY = b.y - gameRect.y;
      savePosition('overlay', overlayPos);
    }
  });

  // 헤더 자동 숨김: 이벤트 기반 (mouseenter/mouseleave IPC)
  isToolbarShown = false;

  const toolbarController = new OverlayToolbarController({
    hideDelayMs: 300,
    canHide: () => !!overlayWindow && !overlayWindow.isDestroyed(),
    // bounds 변경으로 인한 허위 leave 이벤트 방어: 실제 커서 위치 1회 검증
    isCursorInsideWindow: () => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return false;
      const cursor = screen.getCursorScreenPoint();
      const b = overlayWindow.getBounds();
      return cursor.x >= b.x && cursor.x < b.x + b.width
        && cursor.y >= b.y && cursor.y < b.y + b.height;
    },
    show: () => {
      if (!isToolbarShown && !isClickThrough) {
        isToolbarShown = true;
        updateViewBounds();
      }
    },
    hide: () => {
      isToolbarShown = false;
      updateViewBounds();
    },
  });

  // WCV 영역 마우스 이벤트 (overlay-view-preload에서 전송)
  view.webContents.ipc.on('overlay-wcv-mouse-enter', () => toolbarController.enterContent());
  view.webContents.ipc.on('overlay-wcv-mouse-leave', () => toolbarController.leaveContent());

  // 툴바 영역 마우스 이벤트 (overlay.html에서 전송)
  overlayWindow.webContents.ipc.on('toolbar-mouse-enter', () => toolbarController.enterToolbar());
  overlayWindow.webContents.ipc.on('toolbar-mouse-leave', () => toolbarController.leaveToolbar());

  overlayWindow.once('ready-to-show', () => {
    updateViewBounds();
    if (isOverlayVisible) {
      overlayWindow?.showInactive();
      sendActiveWindowsStatus();
      if (physicalGameRect) { isTracking = false; syncOverlay(physicalGameRect); }
    }
    overlayWindow?.webContents.send('config-data', config.load());
    if (SHOULD_AUTO_OPEN_DEVTOOLS) { overlayWindow?.webContents.openDevTools({ mode: 'detach' }); view?.webContents.openDevTools({ mode: 'detach' }); }
    if (onOverlayReady) onOverlayReady();
  });
  overlayWindow.on('closed', () => {
    toolbarController.dispose();
    if (view) { try { view.webContents.close(); } catch (e) { } view = null; }
    overlayWindow = null; isTracking = false; isClickThrough = false;
    sendActiveWindowsStatus();
  });
  focusController.attach(overlayWindow);
}

let _displayListenersRegistered = false;
let displayChangeTimer: NodeJS.Timeout | null = null;
let displayChangeGeneration = 0;
const DISPLAY_CHANGE_DEBOUNCE_MS = 300;
const DISPLAY_STABILITY_CHECK_MS = 250;
const DISPLAY_STABILITY_MAX_WAIT_MS = 2000;
const displayTopologyStabilizer = new DisplayTopologyStabilizer(
  DISPLAY_STABILITY_CHECK_MS,
  DISPLAY_STABILITY_MAX_WAIT_MS,
);

function recoverVisibleWindowsWithoutGame(): void {
  const allDisplays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  Object.keys(windowRegistry).forEach((k) => {
    const key = k as WindowPositionKey;
    // 독은 게임 내부 고정 배치이므로 독립 창 복구 대상으로 취급하지 않습니다.
    if (key === 'dock' || programmaticMoves.isUserDragging(key)) return;
    const win = windowRegistry[key].ref;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const bounds = win.getBounds();
    if (isWindowVisibleOnDisplays(bounds, allDisplays)) return;

    const { x, y } = centerWindowInWorkArea(bounds.width, bounds.height, primary.workArea);
    log(`[WINDOW] 화면 밖으로 이탈된 창(${key})을 주 모니터 중앙으로 임시 복구: (${x}, ${y})`);
    // 게임 기준 좌표를 알 수 없는 동안에는 저장 오프셋을 변경하지 않습니다.
    setProgrammaticMove(key, x, y);
    win.setPosition(x, y);
  });

  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()
    || programmaticMoves.isUserDragging('overlay')) return;
  const bounds = overlayWindow.getBounds();
  if (isWindowVisibleOnDisplays(bounds, allDisplays)) return;
  const { x, y } = centerWindowInWorkArea(bounds.width, bounds.height, primary.workArea);
  log(`[WINDOW] 화면 밖으로 이탈된 브라우저 오버레이를 주 모니터 중앙으로 임시 복구: (${x}, ${y})`);
  setProgrammaticMove('overlay', x, y);
  overlayWindow.setPosition(x, y);
}

async function recoverWindowsAfterStableDisplayChange(generation: number): Promise<void> {
  if (appState.isQuitting || generation !== displayChangeGeneration) return;
  const currentRect = await tracker.queryGameRect();
  if (appState.isQuitting || generation !== displayChangeGeneration) return;

  if (currentRect && 'x' in currentRect) {
    // 최신 물리 게임 좌표를 다시 DIP로 변환하여 DPI 변경에 따른 모든 창 좌표를 한 번만 재계산합니다.
    syncOverlay(currentRect);
    return;
  }

  recoverVisibleWindowsWithoutGame();
}

function checkDisplayTopologyStability(generation: number): void {
  if (appState.isQuitting || generation !== displayChangeGeneration) return;
  const signature = createDisplayTopologySignature(screen.getAllDisplays());
  if (!displayTopologyStabilizer.observe(signature, Date.now())) {
    displayChangeTimer = setTimeout(
      () => checkDisplayTopologyStability(generation),
      DISPLAY_STABILITY_CHECK_MS,
    );
    return;
  }
  displayChangeTimer = null;
  void recoverWindowsAfterStableDisplayChange(generation).catch(error => {
    log(`[WINDOW] 디스플레이 변경 후 창 위치 복구 실패: ${error}`);
  });
}

function scheduleDisplayChangeRecovery(): void {
  displayChangeGeneration++;
  const generation = displayChangeGeneration;
  displayTopologyStabilizer.begin(Date.now());
  if (displayChangeTimer) clearTimeout(displayChangeTimer);
  displayChangeTimer = setTimeout(
    () => checkDisplayTopologyStability(generation),
    DISPLAY_CHANGE_DEBOUNCE_MS,
  );
}

export function setupDisplayChangeListeners(): void {
  if (_displayListenersRegistered) return;
  _displayListenersRegistered = true;

  const handleDisplayChange = () => {
    log('[WINDOW] 디스플레이 변경 감지, 안정화 후 창 위치 복구 예약');
    scheduleDisplayChangeRecovery();
  };

  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);
}

function isVisibleOnScreens(x: number, y: number, width: number, height: number): boolean {
  return isWindowVisibleOnDisplays({ x, y, width, height }, screen.getAllDisplays());
}

function recoverCompletelyOffscreenWindow(
  key: WindowPositionKey,
  anchorRect: GameRect,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; recovered: boolean } {
  // 독바는 게임 내부 고정 배치이며 사용자 저장 위치를 사용하지 않습니다.
  // 사용자가 마우스로 드래그 중일 때는 화면 이탈 복구가 오작동하여 창이 중앙으로 튕기지 않도록 보호합니다.
  if (key === 'dock' || programmaticMoves.isUserDragging(key) || isVisibleOnScreens(x, y, width, height)) return { x, y, recovered: false };

  const targetDisplay = screen.getDisplayNearestPoint({ x: anchorRect.x, y: anchorRect.y });
  const { x: recoveredX, y: recoveredY } = centerWindowInWorkArea(width, height, targetDisplay.workArea);

  log(`[WINDOW_POS] Window ${key} is completely outside all displays (x=${x}, y=${y}). Centering window.`);
  const winCfg = windowRegistry[key];
  winCfg.pos = {
    offsetX: recoveredX - (anchorRect.x + anchorRect.width),
    offsetY: recoveredY - anchorRect.y,
  };
  savePosition(key, winCfg.pos);
  return { x: recoveredX, y: recoveredY, recovered: true };
}

function recoverCompletelyOffscreenBrowserOverlay(
  anchorRect: GameRect,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; recovered: boolean } {
  if (programmaticMoves.isUserDragging('overlay') || isVisibleOnScreens(x, y, width, height)) return { x, y, recovered: false };

  const targetDisplay = screen.getDisplayNearestPoint({ x: anchorRect.x, y: anchorRect.y });
  const { x: recoveredX, y: recoveredY } = centerWindowInWorkArea(width, height, targetDisplay.workArea);

  log(`[WINDOW_POS] Browser overlay is completely outside all displays (x=${x}, y=${y}). Centering window.`);
  // 브라우저 오버레이는 다른 보조 창과 달리 게임 우측 끝이 아니라 좌측 상단을 기준으로 저장합니다.
  overlayPos = {
    offsetX: recoveredX - anchorRect.x,
    offsetY: recoveredY - anchorRect.y,
  };
  savePosition('overlay', overlayPos);
  return { x: recoveredX, y: recoveredY, recovered: true };
}

type ManagedWindowShowReason = 'user-open' | 'game-resync' | 'settings-apply' | 'preload';

function createToggleableWindow(key: WindowPositionKey, callbacks?: {
  onReady?: (win: BrowserWindow) => void,
  calcPosition?: (gr: GameRect, pos: WindowPosition) => { x: number, y: number }
}, showReason: ManagedWindowShowReason = 'user-open'): boolean {
  const winCfg = windowRegistry[key];
  if (!winCfg || (winCfg.ref && !winCfg.ref.isDestroyed())) {
    if (winCfg?.ref && !winCfg.ref.isDestroyed()) {
      winCfg.ref.close();
    }
    return false; // 닫힘
  }

  // 새 창이 열리므로 예약된 포커스 복구 취소 (레이스 컨디션 방지)
  focusController.cancelPendingRestore();

  // 현재 게임 창이 있는 모니터(없으면 주 모니터)의 작업 영역 확인
  const display = gameRect
    ? screen.getDisplayNearestPoint({ x: gameRect.x, y: gameRect.y })
    : screen.getPrimaryDisplay();

  const sizing = resolveManagedWindowSizing(key, winCfg.width, winCfg.height, config.load(), display.workAreaSize);
  const finalW = sizing.width;
  const finalH = sizing.height;
  // Electron frameless + transparent 창은 Windows에서 네이티브 테두리 리사이즈 핸들이 작동하지 않음
  // contentsChecker는 불투명 창이므로 transparent: false로 두어 네이티브 리사이즈 활성화
  // chatOverlay 계열은 HTML 내 자체 드래그 핸들러를 사용하므로 투명도(transparent: true)를 강제 유지
  const needsTransparent = sizing.isTransparent;
  const isPassiveOverlay = key === 'dock'
    || key === 'chatOverlay'
    || key === 'chatOverlaySub'
    || key === 'chatOverlaySub2';

  let isClosing = false;
  const win = new BrowserWindow(getStandardOptions(finalW, finalH, {
    skipTaskbar: !!winCfg.skipTaskbar,
    resizable: sizing.isResizable,
    thickFrame: sizing.isResizable,
    minWidth: sizing.minWidth,
    minHeight: sizing.minHeight,
    transparent: needsTransparent,
    backgroundColor: needsTransparent ? undefined : '#0f0e1a',
  }));
  if (sizing.isResizable) {
    win.setResizable(true);
  }
  // 독은 플라이아웃 배치 공간을 포함한 큰 투명 창이므로, 로딩 전부터 빈 영역의 입력을
  // 게임에 전달합니다. renderer가 실제 독 패널 위에서만 입력을 다시 활성화합니다.
  if (key === 'dock') {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
  winCfg.ref = win;
  // 창 생성 시 Windows가 기본 위치에 배치하면서 move 이벤트가 발생하므로,
  // ready-to-show에서 올바른 위치를 설정하기 전까지 위치 저장을 차단합니다.
  // 로딩 시간이 200ms를 넘을 수 있으므로 시간 기반 가드로 처리하면 안 됩니다.
  let isInitialPositionApplied = false;
  focusController.attach(win);
  win.loadFile(path.join(__dirname, '..', winCfg.html));
  win.on('close', () => {
    isClosing = true;
  });

  win.on('resize', () => {
    if (isClosing) return;
    const b = win.getBounds();
    const cfg = config.load();
    if (applyManagedWindowSize(key, cfg, b.width, b.height)) config.save(cfg);
  });

  // 최초 렌더링 뒤 한 번만 배치·표시합니다. reload/DevTools 연결 등으로
  // ready-to-show가 다시 발생해도 show/showInactive를 반복하지 않습니다.
  win.once('ready-to-show', () => {
    if (gameRect) {
      let { x, y } = (callbacks?.calcPosition || winCfg.calcPosition)
        ? (callbacks?.calcPosition || winCfg.calcPosition)!(gameRect, winCfg.pos)
        : calculateAttachedWindowPosition(gameRect, winCfg.pos);

      // 채팅 오버레이 창(Main/Sub1/Sub2)의 경우
      if (key === 'chatOverlay' || key === 'chatOverlaySub' || key === 'chatOverlaySub2') {
        const cfg = config.load();
        const hasSavedPos = config.hasStoredPosition(key as WindowPositionKey);

        // 사용자가 수동 드래그하여 저장한 위치가 없을 때(최초 오픈)만 게임창 내부 범위로 강제 클램핑 처리
        if (!hasSavedPos) {
          const minY = gameRect.y;
          const maxY = Math.max(minY, gameRect.y + gameRect.height - finalH);
          y = Math.max(minY, Math.min(y, maxY));

          const minX = gameRect.x;
          const maxX = Math.max(minX, gameRect.x + gameRect.width - finalW);
          x = Math.max(minX, Math.min(x, maxX));
        }
      }

      // 숙제 체크리스트를 포함한 모든 보조 창에 동일한 완전 이탈 복구 규칙을 적용합니다.
      // 일부만 화면에 걸친 상태라면 isVisibleOnScreens가 true이므로 사용자 위치를 유지합니다.
      ({ x, y } = recoverCompletelyOffscreenWindow(key, gameRect, x, y, finalW, finalH));

      setProgrammaticMove(key, x, y);
      win.setPosition(x, y);
    } else {
      const { x, y } = resolveFallbackWindowPosition(finalW, finalH);
      setProgrammaticMove(key, x, y);
      win.setPosition(x, y);
    }
    isInitialPositionApplied = true;
    win.webContents.send('config-data', config.load());
    if (callbacks?.onReady || winCfg.onOpen) (callbacks?.onReady || winCfg.onOpen)!(win);
    const shouldShowPreloadedDock = showReason === 'preload' && key === 'dock' && isDockVisible;
    let showMethod = 'preload-hidden';
    if (showReason === 'user-open' && !isPassiveOverlay) {
      win.show();
      showMethod = 'show';
    } else if (showReason !== 'preload' || shouldShowPreloadedDock) {
      win.showInactive();
      showMethod = 'showInactive';
    }
    log(`[WINDOW_SHOW] ${key} reason=${showReason} method=${showMethod}`);
    sendActiveWindowsStatus();
    if (SHOULD_AUTO_OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config-data', config.load());
    if (key === 'chatOverlay') {
      win.webContents.send('chat-overlay-mode', 'main');
    } else if (key === 'chatOverlaySub') {
      win.webContents.send('chat-overlay-mode', 'sub1');
    } else if (key === 'chatOverlaySub2') {
      win.webContents.send('chat-overlay-mode', 'sub2');
    } else if (key === 'settings') {
      import('./updater').then(mod => {
        const info = mod.getCurrentStatus();
        if (info && win && !win.isDestroyed()) {
          win.webContents.send('update-status', info);
        }
      });
    }
  });
  win.on('move', () => {
    // 전체화면(isGameFullscreen) 상태일 때는 사용자 이동 오프셋을 덮어쓰거나 저장하지 않음 (창모드 복귀 시 위치 유지를 위해)
    if (isClosing || !isInitialPositionApplied || consumeProgrammaticMove(key, winCfg.ref) || !winCfg.ref || !gameRect || isGameFullscreen) return;
    programmaticMoves.markUserDrag(key);
    const b = winCfg.ref.getBounds();
    winCfg.pos = { offsetX: b.x - (gameRect.x + gameRect.width), offsetY: b.y - gameRect.y };
    savePosition(key, winCfg.pos);
  });
  win.on('closed', () => {
    if (config.hasPending()) {
      config.saveImmediate();
    }
    if (winCfg.onClose) winCfg.onClose();
    winCfg.ref = null;
    sendActiveWindowsStatus();

    // 창이 renderer-ready를 보내기 전에 닫히면 pending 항목이 남아
    // 다음 오픈 시 잘못 자동 선택될 수 있으므로 정리한다.
    if (key === 'coefficientCalculator') pendingCoefficientItem = null;
    if (key === 'evolutionCalculator') pendingEvolutionItem = null;
    if (key === 'settings') pendingSettingsTab = null;

    // 창이 닫히면 앱 종료·hideAll·게임 미추적 상태를 확인한 뒤 게임 포커스를 복구합니다.
    focusController.scheduleRestore();
  });
  return true; // 열림
}

export function toggleSettingsWindow(tabId?: string): void {
  const winCfg = windowRegistry['settings'];
  if (winCfg && winCfg.ref && !winCfg.ref.isDestroyed()) {
    winCfg.ref.show();
    winCfg.ref.focus();
    import('./updater').then(mod => {
      const info = mod.getCurrentStatus();
      if (info && winCfg.ref && !winCfg.ref.isDestroyed()) {
        winCfg.ref.webContents.send('update-status', info);
      }
    });
    if (tabId) {
      if (winCfg.ref.webContents.isLoadingMainFrame()) {
        pendingSettingsTab = tabId;
      } else {
        winCfg.ref.webContents.send('open-settings-tab', tabId);
        pendingSettingsTab = null;
      }
    }
    return;
  }
  pendingSettingsTab = tabId || null;
  createToggleableWindow('settings', {
    onReady: (win) => {
      import('./updater').then(mod => {
        const info = mod.getCurrentStatus();
        if (info && win && !win.isDestroyed()) {
          win.webContents.send('update-status', info);
        }
      });
    }
  });
}
export function toggleGalleryWindow(): boolean {
  return createToggleableWindow('gallery', {
    onReady: (win) => { gallery.updateWindows(null, win, null); if (onOverlayReady) onOverlayReady(); }
  });
}
export function toggleHuntingPathSimulatorWindow(): boolean { return createToggleableWindow('huntingPathSimulator'); }
export function toggleAbbreviationWindow(): boolean { return createToggleableWindow('abbreviation'); }
export function toggleEquipmentDicWindow(): boolean { return createToggleableWindow('equipmentDic'); }
export function toggleBuffsWindow(): boolean { return createToggleableWindow('buffs'); }
export function toggleBossSettingsWindow(): boolean {
  return createToggleableWindow('bossSettings', {
    onReady: (win) => {
      const bossTimes: Record<string, string[]> = {};
      const bosses = ['골론', '파멸의 기원', '스페르첸드', '골모답', '아칸', '혼란한 대지'];
      bosses.forEach(name => { bossTimes[name] = bossNotifier.getBossTimes(name); });
      win.webContents.send('boss-times-data', bossTimes);
    }
  });
}
export function toggleEtaRankingWindow(): boolean { return createToggleableWindow('etaRanking'); }
export function toggleTradeWindow(): boolean {
  return createToggleableWindow('trade', {
    onReady: (win) => { trade.updateWindows(null, win); }
  });
}

/** 이미 열린 관리 창을 전면에 표시합니다. 열려 있지 않으면 false를 반환합니다. */
function showExistingManagedWindow(key: string): boolean {
  const win = windowRegistry[key]?.ref;
  if (!win || win.isDestroyed()) return false;
  win.show();
  win.focus();
  return true;
}

/** 이미 열린 관리 창으로 데이터를 전달하고 전면에 표시합니다. */
function sendToExistingManagedWindow(key: string, channel: string, payload: unknown): boolean {
  const win = windowRegistry[key]?.ref;
  if (!win || win.isDestroyed()) return false;
  win.webContents.send(channel, payload);
  win.show();
  win.focus();
  return true;
}

export function toggleCoefficientCalculatorWindow(): boolean { return createToggleableWindow('coefficientCalculator'); }
export function openCoefficientCalculatorWindow(): void {
  if (!showExistingManagedWindow('coefficientCalculator')) createToggleableWindow('coefficientCalculator');
}
export function sendEquipmentToCoefficient(item: EquipmentDictionaryItem): void {
  if (sendToExistingManagedWindow('coefficientCalculator', 'auto-select-equipment', item)) return;
  pendingCoefficientItem = item;
  openCoefficientCalculatorWindow();
}
export function sendEquipmentToEvolution(item: EquipmentDictionaryItem): void {
  if (sendToExistingManagedWindow('evolutionCalculator', 'auto-select-evolution', item)) return;
  pendingEvolutionItem = item;
  openEvolutionCalculatorWindow();
}
export function handleRendererReady(windowKey: string, webContents: WebContents): void {
  // ready 신호는 우리가 소유한 창(레지스트리 ref)에서 온 것만 신뢰한다.
  // 임의 렌더러가 windowKey를 위조해 pending payload를 가로채는 것을 방지.
  const winCfg = windowRegistry[windowKey];
  if (!winCfg || !winCfg.ref || winCfg.ref.isDestroyed() || winCfg.ref.webContents !== webContents) return;

  if (windowKey === 'coefficientCalculator' && pendingCoefficientItem) {
    winCfg.ref.webContents.send('auto-select-equipment', pendingCoefficientItem);
    pendingCoefficientItem = null;
  } else if (windowKey === 'evolutionCalculator' && pendingEvolutionItem) {
    winCfg.ref.webContents.send('auto-select-evolution', pendingEvolutionItem);
    pendingEvolutionItem = null;
  } else if (windowKey === 'settings') {
    import('./updater').then(mod => {
      const info = mod.getCurrentStatus();
      if (info && winCfg.ref && !winCfg.ref.isDestroyed()) {
        winCfg.ref.webContents.send('update-status', info);
      }
    });
  }
  if (windowKey === 'settings' && pendingSettingsTab) {
    winCfg.ref.webContents.send('open-settings-tab', pendingSettingsTab);
    pendingSettingsTab = null;
  }
}
export function toggleFocusedChatWindow(): boolean { return createToggleableWindow('focusedChat'); }
export function toggleEvolutionCalculatorWindow(): boolean { return createToggleableWindow('evolutionCalculator'); }
export function openEvolutionCalculatorWindow(): void {
  if (!showExistingManagedWindow('evolutionCalculator')) createToggleableWindow('evolutionCalculator');
}
export function toggleThesisCoreCalculatorWindow(): boolean { return createToggleableWindow('thesisCoreCalculator'); }
export function openThesisCoreCalculatorWindow(): void {
  if (!showExistingManagedWindow('thesisCoreCalculator')) createToggleableWindow('thesisCoreCalculator');
}
export function toggleMagicStoneCalculatorWindow(): boolean { return createToggleableWindow('magicStoneCalculator'); }
export function toggleHuntingExpCalculatorWindow(): boolean { return createToggleableWindow('huntingExpCalculator'); }
export function toggleRelicCalculatorWindow(): boolean { return createToggleableWindow('relicCalculator'); }
export function toggleEquipmentSimulatorWindow(): boolean { return createToggleableWindow('equipmentSimulator'); }
export function toggleCustomAlertWindow(): boolean { return createToggleableWindow('customAlert'); }
export function toggleUniformColorWindow(): void {
  const winCfg = windowRegistry['uniformColor'];
  if (winCfg && winCfg.ref && !winCfg.ref.isDestroyed()) {
    winCfg.ref.close();
    return;
  }

  // 1. 독립 창 생성 및 로드
  const display = gameRect
    ? screen.getDisplayNearestPoint({ x: gameRect.x, y: gameRect.y })
    : screen.getPrimaryDisplay();
  const sizing = resolveManagedWindowSizing('uniformColor', winCfg.width, winCfg.height, config.load(), display.workAreaSize);
  const win = new BrowserWindow(getStandardOptions(sizing.width, sizing.height, {
    resizable: sizing.isResizable,
    thickFrame: sizing.isResizable,
  }));
  winCfg.ref = win;
  focusController.attach(win);
  win.loadFile(path.join(__dirname, '..', winCfg.html));

  uniformColorTool = new EmbeddedWebTool(win, {
    url: 'https://twsnowflower.github.io/uniform_color/spin.html',
    preloadPath: path.join(__dirname, '..', 'overlay-view-preload.js'),
    headerHeight: 56,
    footerHeight: 28,
    followWindowResize: false,
    css: 'body { overflow: hidden !important; margin-top: -79px !important; margin-left: 0px !important; background: #0f121e !important; }',
  });

  let isInitialPositionApplied = false;
  let isClosing = false;
  win.on('close', () => { isClosing = true; });

  win.once('ready-to-show', () => {
    if (gameRect) {
      let { x, y } = winCfg.calcPosition
        ? winCfg.calcPosition(gameRect, winCfg.pos)
        : calculateAttachedWindowPosition(gameRect, winCfg.pos);
      ({ x, y } = recoverCompletelyOffscreenWindow('uniformColor', gameRect, x, y, sizing.width, sizing.height));
      setProgrammaticMove('uniformColor', x, y);
      win.setPosition(x, y);
    } else {
      const { x, y } = resolveFallbackWindowPosition(sizing.width, sizing.height);
      setProgrammaticMove('uniformColor', x, y);
      win.setPosition(x, y);
    }
    isInitialPositionApplied = true;
    if (SHOULD_AUTO_OPEN_DEVTOOLS) {
      win.webContents.openDevTools({ mode: 'detach' });
      uniformColorTool?.openDevTools();
    }
    win.show();
  });

  win.on('move', () => {
    // 전체화면(isGameFullscreen) 상태일 때는 사용자 이동 오프셋을 덮어쓰거나 저장하지 않음 (창모드 복귀 시 위치 유지를 위해)
    if (isClosing || !isInitialPositionApplied || consumeProgrammaticMove('uniformColor', winCfg.ref) || !winCfg.ref || !gameRect || isGameFullscreen) return;
    programmaticMoves.markUserDrag('uniformColor');
    const b = winCfg.ref.getBounds();
    winCfg.pos = { offsetX: b.x - (gameRect.x + gameRect.width), offsetY: b.y - gameRect.y };
    savePosition('uniformColor', winCfg.pos);
  });

  win.on('closed', () => {
    uniformColorTool?.dispose();
    uniformColorTool = null;
    winCfg.ref = null;

    focusController.scheduleRestore();
  });
}

export function toggleSwordEnhanceWindow(): void {
  const winCfg = windowRegistry.swordEnhance;
  if (winCfg.ref && !winCfg.ref.isDestroyed()) {
    winCfg.ref.close();
    return;
  }

  const display = gameRect
    ? screen.getDisplayNearestPoint({ x: gameRect.x, y: gameRect.y })
    : screen.getPrimaryDisplay();
  const sizing = resolveManagedWindowSizing('swordEnhance', winCfg.width, winCfg.height, config.load(), display.workAreaSize);
  const win = new BrowserWindow(getStandardOptions(sizing.width, sizing.height, {
    resizable: sizing.isResizable,
    thickFrame: sizing.isResizable,
    minWidth: sizing.minWidth,
    minHeight: sizing.minHeight,
  }));
  winCfg.ref = win;
  focusController.attach(win);
  win.loadFile(path.join(__dirname, '..', winCfg.html));

  swordEnhanceTool = new EmbeddedWebTool(win, {
    url: 'https://twliker.github.io/tw-sword-enhance/',
    preloadPath: path.join(__dirname, '..', 'overlay-view-preload.js'),
    headerHeight: 56,
    footerHeight: 28,
    followWindowResize: true,
  });

  let isInitialPositionApplied = false;
  let isClosing = false;
  win.on('close', () => { isClosing = true; });

  win.once('ready-to-show', () => {
    if (gameRect) {
      let { x, y } = calculateAttachedWindowPosition(gameRect, winCfg.pos);
      ({ x, y } = recoverCompletelyOffscreenWindow('swordEnhance', gameRect, x, y, sizing.width, sizing.height));
      setProgrammaticMove('swordEnhance', x, y);
      win.setPosition(x, y);
    } else {
      const { x, y } = resolveFallbackWindowPosition(sizing.width, sizing.height);
      setProgrammaticMove('swordEnhance', x, y);
      win.setPosition(x, y);
    }
    isInitialPositionApplied = true;
    if (SHOULD_AUTO_OPEN_DEVTOOLS) {
      win.webContents.openDevTools({ mode: 'detach' });
      swordEnhanceTool?.openDevTools();
    }
    win.show();
  });

  win.on('move', () => {
    if (isClosing || !isInitialPositionApplied || consumeProgrammaticMove('swordEnhance', winCfg.ref) || !winCfg.ref || !gameRect || isGameFullscreen) return;
    programmaticMoves.markUserDrag('swordEnhance');
    const bounds = winCfg.ref.getBounds();
    winCfg.pos = { offsetX: bounds.x - (gameRect.x + gameRect.width), offsetY: bounds.y - gameRect.y };
    savePosition('swordEnhance', winCfg.pos);
  });

  win.on('closed', () => {
    swordEnhanceTool?.dispose();
    swordEnhanceTool = null;
    winCfg.ref = null;

    focusController.scheduleRestore();
  });
}

export function toggleShoutHistoryWindow(): boolean { return createToggleableWindow('shoutHistory'); }
export function toggleDiaryWindow(): boolean { return createToggleableWindow('diary'); }
export function openScamDetectorWindow(): boolean {
  const winCfg = windowRegistry['scamDetector'];
  if (winCfg && winCfg.ref && !winCfg.ref.isDestroyed()) {
    winCfg.ref.show();
    winCfg.ref.focus();
    return true;
  }
  return createToggleableWindow('scamDetector');
}

export function toggleScamDetectorWindow(): boolean { return createToggleableWindow('scamDetector'); }
export function toggleBuffTimerWindow(): boolean { return createToggleableWindow('buffTimer'); }
export function toggleXpHudWindow(): boolean { return createToggleableWindow('xpHud'); }
export function toggleSienaAuraWindow(): boolean { return createToggleableWindow('sienaAura'); }
export function toggleWordAlarmWindow(): boolean { return createToggleableWindow('wordAlarm'); }
export function toggleDiscordAlarmWindow(): boolean { return createToggleableWindow('discordAlarm'); }
export function toggleChatOverlayWindow(): boolean {
  isChatOverlayVisible = !isChatOverlayVisible;
  config.save({ chatOverlayEnabled: isChatOverlayVisible });

  const updated = { ...config.load(), chatOverlayEnabled: isChatOverlayVisible };
  const dockCfg = windowRegistry['dock'];
  [mainWindow, dockCfg?.ref].forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('config-data', updated);
    }
  });

  const chatWinCfg = windowRegistry['chatOverlay'];
  const subWinCfg = windowRegistry['chatOverlaySub'];
  const sub2WinCfg = windowRegistry['chatOverlaySub2'];

  if (isChatOverlayVisible) {
    if (!chatWinCfg.ref || chatWinCfg.ref.isDestroyed()) {
      createToggleableWindow('chatOverlay');
    }

    // Main 창이 켜질 때, 설정에 저장되어 있던 활성화 상태에 따라 sub1, sub2도 복원
    const cfg = config.load();
    if (cfg.chatOverlaySubEnabled) {
      isChatOverlaySubVisible = true;
      if (!subWinCfg.ref || subWinCfg.ref.isDestroyed()) {
        createToggleableWindow('chatOverlaySub');
      }
    }
    if (cfg.chatOverlaySub2Enabled) {
      isChatOverlaySub2Visible = true;
      if (!sub2WinCfg.ref || sub2WinCfg.ref.isDestroyed()) {
        createToggleableWindow('chatOverlaySub2');
      }
    }
  } else {
    // 꺼질 때는 Main 및 모든 서브 창 닫기
    if (chatWinCfg.ref && !chatWinCfg.ref.isDestroyed()) {
      chatWinCfg.ref.close();
    }
    if (subWinCfg.ref && !subWinCfg.ref.isDestroyed()) {
      subWinCfg.ref.close();
    }
    if (sub2WinCfg.ref && !sub2WinCfg.ref.isDestroyed()) {
      sub2WinCfg.ref.close();
    }
  }
  return isChatOverlayVisible;
}

export function broadcastConfig(): void {
  const cfg = config.load();
  const dockCfg = windowRegistry['dock'];
  const chatWin = windowRegistry['chatOverlay'];
  const sub1Win = windowRegistry['chatOverlaySub'];
  const sub2Win = windowRegistry['chatOverlaySub2'];

  [mainWindow, dockCfg?.ref, chatWin?.ref, sub1Win?.ref, sub2Win?.ref].forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('config-data', cfg);
    }
  });
}

export function toggleSubWindow(subNum: 1 | 2): void {
  if (subNum === 1) {
    const winCfg = windowRegistry['chatOverlaySub'];
    if (!isChatOverlaySubVisible) {
      isChatOverlaySubVisible = true;
      config.saveImmediate({ chatOverlaySubEnabled: true });
      if (!winCfg.ref || winCfg.ref.isDestroyed()) {
        createToggleableWindow('chatOverlaySub');
      }
    } else {
      isChatOverlaySubVisible = false;
      config.saveImmediate({ chatOverlaySubEnabled: false });
      if (winCfg.ref && !winCfg.ref.isDestroyed()) {
        winCfg.ref.close();
      }
    }
    broadcastConfig();
  } else if (subNum === 2) {
    const winCfg = windowRegistry['chatOverlaySub2'];
    if (!isChatOverlaySub2Visible) {
      isChatOverlaySub2Visible = true;
      config.saveImmediate({ chatOverlaySub2Enabled: true });
      if (!winCfg.ref || winCfg.ref.isDestroyed()) {
        createToggleableWindow('chatOverlaySub2');
      }
    } else {
      isChatOverlaySub2Visible = false;
      config.saveImmediate({ chatOverlaySub2Enabled: false });
      if (winCfg.ref && !winCfg.ref.isDestroyed()) {
        winCfg.ref.close();
      }
    }
    broadcastConfig();
  }
}

let isDockVisible = false;
export function toggleDockWindow(): void {
  const cfg = config.load();
  if (cfg.sidebarPosition !== 'dock' && cfg.sidebarPosition !== 'dock-top') return;

  const winCfg = windowRegistry['dock'];
  if (winCfg.ref && !winCfg.ref.isDestroyed()) {
    const isPreloading = winCfg.ref.webContents.isLoadingMainFrame();
    if (winCfg.ref.isVisible() || (isPreloading && isDockVisible)) {
      isDockVisible = false;
      // 독은 단축키로 자주 토글되므로 renderer를 파괴하지 않고 숨겨 즉시 재사용합니다.
      if (winCfg.ref.isVisible()) winCfg.ref.hide();
    } else {
      isDockVisible = true;
      if (gameRect) {
        const { x, y } = winCfg.calcPosition!(gameRect, winCfg.pos);
        if (isValidCoordinate(x) && isValidCoordinate(y)) {
          setProgrammaticMove('dock', x, y);
          winCfg.ref.setPosition(x, y);
        }
      }
      // 위치를 먼저 확정한 뒤 기존 renderer를 표시해 재생성 지연과 화면 점프를 없앱니다.
      if (!isPreloading) {
        winCfg.ref.showInactive();
        bringGameAndOverlaysToTop();
        sendActiveWindowsStatus();
        log('[DOCK_TOGGLE] 기존 독 창 즉시 표시');
      } else {
        log('[DOCK_TOGGLE] 독 사전 로딩 완료 후 표시 예약');
      }
    }
  } else {
    isDockVisible = true;
    createToggleableWindow('dock');
  }
}
export function toggleContentsCheckerWindow(): boolean {
  isContentsCheckerVisible = !isContentsCheckerVisible;
  config.save({ contentsCheckerEnabled: isContentsCheckerVisible });

  const contentsWinCfg = windowRegistry['contentsChecker'];
  if (isContentsCheckerVisible) {
    if (!contentsWinCfg.ref || contentsWinCfg.ref.isDestroyed()) {
      createToggleableWindow('contentsChecker', {
        onReady: (win) => {
          import('./contentsChecker').then(mod => {
            mod.init();
            win.webContents.send('config-data', config.load());
          });
        }
      });
    }
  } else {
    if (contentsWinCfg.ref && !contentsWinCfg.ref.isDestroyed()) {
      contentsWinCfg.ref.close();
    }
  }
  broadcastConfig();
  return isContentsCheckerVisible;
}

export function toggleStopwatchWindow(): boolean {
  return createToggleableWindow('stopwatch');
}


export function getAllWindowHwnds(): string[] {
  const dockWin = windowRegistry.dock?.ref;
  return focusController.getOrderedWindowHandles(mainWindow, dockWin, gameOverlayWindow);
}
export function updateViewBounds(): void {
  if (!overlayWindow || !view) return;
  const b = overlayWindow.getBounds();
  if (isToolbarShown) {
    view.setBounds({ x: 0, y: OVERLAY_TOOLBAR_HEIGHT, width: b.width, height: b.height - OVERLAY_TOOLBAR_HEIGHT });
  } else {
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  }
}
export function setOverlayVisible(visible: boolean, targetUrl?: string): boolean {
  if (mandatoryUpdateLock) return isOverlayVisible; // 필수 업데이트 중에는 오버레이 조작 차단
  if (isOverlayVisible === visible && (visible ? !!overlayWindow : !overlayWindow)) { if (visible && targetUrl && view) view.webContents.loadURL(targetUrl); return isOverlayVisible; }
  isOverlayVisible = visible;
  if (isOverlayVisible) createOverlayWindow(targetUrl);
  else if (overlayWindow) {
    savePosition('overlay', overlayPos, true);
    if (view) { try { overlayWindow.contentView.removeChildView(view); view.webContents.close(); } catch (e) { } view = null; }
    overlayWindow.close(); overlayWindow = null; isTracking = false;
  }
  if (mainWindow) mainWindow.webContents.send('overlay-status', isOverlayVisible);
  config.save({ overlayVisible: isOverlayVisible });
  return isOverlayVisible;
}
export function toggleOverlay(): boolean { return setOverlayVisible(!isOverlayVisible); }

export function syncOverlay(currentRect: GameRect): void {
  if (!mainWindow || isApplyingSize) return;
  if (mandatoryUpdateLock) return; // 필수 업데이트 중에는 창 동기화 중지
  if (currentRect && currentRect.x > -10000) {
    const cfg = config.load();
    const sidebarPos = cfg.sidebarPosition || 'right';

    if (sidebarPos === 'dock' || sidebarPos === 'dock-top') {
      if (mainWindow.isVisible()) mainWindow.hide();
      const dockCfg = windowRegistry['dock'];
      if (!isDockVisible) {
        if (!dockCfg.ref || dockCfg.ref.isDestroyed()) {
          // 독 모드 진입 시 renderer를 숨은 상태로 준비해 첫 단축키 표시도 즉시 처리합니다.
          createToggleableWindow('dock', undefined, 'preload');
        } else if (dockCfg.ref.isVisible()) {
          // 독 모드에서는 숨긴 창을 유지해 다음 단축키 입력에서 즉시 재사용합니다.
          dockCfg.ref.hide();
        }
      }
    } else {
      if (!mainWindow.isVisible()) mainWindow.showInactive();
      const dockCfg = windowRegistry['dock'];
      if (dockCfg.ref && !dockCfg.ref.isDestroyed()) {
        dockCfg.ref.close();
      }
    }

    if (overlayWindow && isOverlayVisible && !overlayWindow.isVisible()) overlayWindow.showInactive();

    // 포커스 상태에 따른 게임 해상도 크기 보정 (비활성화 시 해상도 축소 방어)
    const resolvedPhysicalRect = resolvePhysicalGameRect(currentRect, lastForegroundSize);
    lastForegroundSize = resolvedPhysicalRect.foregroundSize;
    // 물리 좌표를 보존 — applySettings에서 syncOverlay 재호출 시 이중 DIP 변환 방지
    physicalGameRect = resolvedPhysicalRect.physicalRect;
    // Win32 물리 좌표를 Electron 논리 좌표(DIP)로 변환
    // null을 전달하면 rect에 가장 가까운 모니터(= 게임 창이 있는 모니터)의 DPI를 자동 적용함.
    // mainWindow(사이드바)를 전달하면 사이드바가 다른 모니터에 있을 때 잘못된 DPI가 적용되므로 부적합.
    const dipRect = screen.screenToDipRect(null, {
      x: currentRect.x,
      y: currentRect.y,
      width: physicalGameRect.width,
      height: physicalGameRect.height
    });
    const gX = dipRect.x, gY = dipRect.y, gW = dipRect.width, gH = dipRect.height;
    const scaledGameRect = { x: gX, y: gY, width: gW, height: gH, isForeground: currentRect.isForeground };

    // 최소화 중 hideAll()이 gameRect를 비운 뒤 복원되는 첫 동기화에서도
    // 자동 복원 창이 저장 오프셋을 기준으로 배치되도록 최신 좌표를 먼저 게시한다.
    gameRect = scaledGameRect;
    lastKnownGameRect = scaledGameRect;

    // 게임 창이 올라가 있는 디스플레이 전체을 차지하는지 확인 (전체 화면 / Alt + Enter 대응)
    const display = screen.getDisplayMatching(dipRect);
    const isFullscreen = isFullscreenBounds(dipRect, display.bounds);
    // 전체화면 진입/유지 중에는 사용자 오프셋 창을 움직이지 않습니다.
    // 전체화면에서 나온 첫 정상 rect는 즉시 반영해야 합니다. 이전 상태까지 조건에 넣으면
    // 폴링의 변경 감지가 한 번뿐인 경우 해당 위치가 영구히 복원되지 않습니다.
    const skipPositionSync = isFullscreen || (cfg.followGameWindow === false);
    isGameFullscreen = isFullscreen; // 전역 전체화면 플래그 동기화

    if (overlayWindow && isOverlayVisible) {
      const b = overlayWindow.getBounds();
      const newW = b.width, newH = b.height;
      if (!isTracking) isTracking = true;
      let { x: finalX, y: finalY } = calculateBrowserOverlayPosition(scaledGameRect, overlayPos);
      // 추적을 중단한 상태에서는 계산된 예정 좌표가 아니라 실제 창이 사라졌는지 검사해야 합니다.
      const recoveryBounds = skipPositionSync
        ? { x: b.x, y: b.y, width: b.width, height: b.height }
        : { x: finalX, y: finalY, width: newW, height: newH };
      const recoveredOverlay = recoverCompletelyOffscreenBrowserOverlay(
        scaledGameRect,
        recoveryBounds.x,
        recoveryBounds.y,
        recoveryBounds.width,
        recoveryBounds.height,
      );
      if (recoveredOverlay.recovered) {
        finalX = recoveredOverlay.x;
        finalY = recoveredOverlay.y;
      }
      // 전체화면 과도기 상태(skipPositionSync)일 때는 사용자 오버레이 창 위치 조정을 건너뜀
      // 단, 화면에서 완전히 사라진 창의 안전 복구는 전체화면/추적 해제 설정보다 우선합니다.
      const targetBounds = { x: finalX, y: finalY, width: newW, height: newH };
      if (!programmaticMoves.isUserDragging('overlay') && (!skipPositionSync || recoveredOverlay.recovered) && hasBoundsChanged(b, targetBounds, POSITION_THRESHOLD)) {
        if (isValidCoordinate(finalX) && isValidCoordinate(finalY) && isValidCoordinate(newW) && isValidCoordinate(newH)) {
          setProgrammaticMove('overlay', finalX, finalY); overlayWindow.setBounds(targetBounds);
        }
      }
    } else if (isOverlayVisible && !overlayWindow) createOverlayWindow();

    // --- 게임 전용 오버레이 동기화 ---
    // 게임 전용 오버레이는 게임 화면을 그대로 덮어야 하므로 전체화면 여부와 무관하게 항상 해상도를 맞춰야 합니다.
    if (!gameOverlayWindow) createGameOverlayWindow();
    if (gameOverlayWindow) {
      const b = gameOverlayWindow.getBounds();
      const targetBounds = { x: gX, y: gY, width: gW, height: gH };
      if (hasBoundsChanged(b, targetBounds, POSITION_THRESHOLD)) {
        if (isValidCoordinate(gX) && isValidCoordinate(gY) && isValidCoordinate(gW) && isValidCoordinate(gH)) {
          gameOverlayWindow.setBounds(targetBounds);
        }
      }
      // 게임 복귀 시 숨겨진 상태면 다시 표시 (isDestroyed 재확인 후 처리)
      if (!gameOverlayWindow.isDestroyed() && !gameOverlayWindow.isVisible()) gameOverlayWindow.showInactive();
    }

    // --- 채팅 오버레이 자동 동기화 및 띄우기 ---
    if (isChatOverlayVisible) {
      const chatWinCfg = windowRegistry['chatOverlay'];
      if (!chatWinCfg.ref || chatWinCfg.ref.isDestroyed()) {
        createToggleableWindow('chatOverlay', undefined, 'game-resync');
      } else {
        if (!chatWinCfg.ref.isVisible()) {
          chatWinCfg.ref.showInactive();
        }
      }
    } else {
      const chatWinCfg = windowRegistry['chatOverlay'];
      if (chatWinCfg.ref && !chatWinCfg.ref.isDestroyed()) {
        chatWinCfg.ref.close();
      }
    }

    // --- 채팅 오버레이 자동 동기화 및 띄우기 (Sub) ---
    if (isChatOverlayVisible && isChatOverlaySubVisible) {
      const subWinCfg = windowRegistry['chatOverlaySub'];
      if (!subWinCfg.ref || subWinCfg.ref.isDestroyed()) {
        createToggleableWindow('chatOverlaySub', undefined, 'game-resync');
      } else {
        if (!subWinCfg.ref.isVisible()) {
          subWinCfg.ref.showInactive();
        }
      }
    } else {
      const subWinCfg = windowRegistry['chatOverlaySub'];
      if (subWinCfg.ref && !subWinCfg.ref.isDestroyed()) {
        subWinCfg.ref.close();
      }
    }

    // --- 채팅 오버레이 자동 동기화 및 띄우기 (Sub 2) ---
    if (isChatOverlayVisible && isChatOverlaySub2Visible) {
      const sub2WinCfg = windowRegistry['chatOverlaySub2'];
      if (!sub2WinCfg.ref || sub2WinCfg.ref.isDestroyed()) {
        createToggleableWindow('chatOverlaySub2', undefined, 'game-resync');
      } else {
        if (!sub2WinCfg.ref.isVisible()) {
          sub2WinCfg.ref.showInactive();
        }
      }
    } else {
      const sub2WinCfg = windowRegistry['chatOverlaySub2'];
      if (sub2WinCfg.ref && !sub2WinCfg.ref.isDestroyed()) {
        sub2WinCfg.ref.close();
      }
    }

    // --- 숙제 체크리스트 자동 동기화 및 띄우기 ---
    if (cfg.autoOpenContentsChecker && isContentsCheckerVisible) {
      const contentsWinCfg = windowRegistry['contentsChecker'];
      if (!contentsWinCfg.ref || contentsWinCfg.ref.isDestroyed()) {
        createToggleableWindow('contentsChecker', {
          onReady: (win) => {
            import('./contentsChecker').then(mod => {
              mod.init();
              win.webContents.send('config-data', config.load());
            });
          }
        }, 'game-resync');
      } else {
        if (!contentsWinCfg.ref.isVisible()) {
          contentsWinCfg.ref.showInactive();
        }
      }
    }

    if (sidebarPos === 'dock' || sidebarPos === 'dock-top') {
      const dockCfg = windowRegistry['dock'];
      if (isDockVisible) {
        const { x, y } = dockCfg.calcPosition!(scaledGameRect, dockCfg.pos);
        // 설정창이 전경이면 닫히기 전에 독 이동·재표시를 모두 끝냅니다.
        // 게임 복귀 뒤 showInactive가 마지막 이벤트가 되면 Windows Shell이
        // 작업표시줄을 다시 노출할 수 있으므로 실제 외부 앱 전경일 때만 연기합니다.
        const deferDockLayout = pendingDockLayoutChange && !tracker.isGameOrAppForeground();
        if (deferDockLayout) {
          log(`[WINDOW_FOCUS] 게임이 전경으로 돌아올 때까지 독 재배치를 연기합니다. target=(${x},${y})`);
        } else {
          if (!dockCfg.ref || dockCfg.ref.isDestroyed()) {
            createToggleableWindow('dock', undefined, 'game-resync');
          } else {
            if (!dockCfg.ref.isVisible()) dockCfg.ref.showInactive();
            const b = dockCfg.ref.getBounds();
            // 독바는 전체화면 모드일 때도 게임 창 가장자리에 항상 도킹되어 보여야 함
            if (hasPositionChanged(b, { x, y }, POSITION_THRESHOLD)) {
              if (isValidCoordinate(x) && isValidCoordinate(y)) {
                const shouldRestoreVisibleDock = pendingDockLayoutChange
                  && isDockVisible
                  && dockCfg.ref.isVisible();
                if (shouldRestoreVisibleDock) {
                  // 표시 중인 투명 Electron 창의 화면 반대편 이동은 Windows Shell의
                  // 작업표시줄 판정을 깨뜨릴 수 있으므로 숨긴 상태에서만 이동합니다.
                  dockCfg.ref.hide();
                  log(`[DOCK_LAYOUT] 표시 중인 독을 숨긴 뒤 재배치합니다. target=(${x},${y})`);
                }
                setProgrammaticMove('dock', x, y);
                dockCfg.ref.setPosition(x, y);
                if (shouldRestoreVisibleDock && !dockCfg.ref.isDestroyed()) {
                  dockCfg.ref.showInactive();
                }
              }
            }
            if (pendingDockLayoutChange) {
              pendingDockLayoutChange = false;
              log(`[DOCK_LAYOUT] 독 재배치 완료 target=(${x},${y})`);
            }
          }
          if (pendingFullscreenDockLayoutRestore && currentRect.isForeground === true) {
            pendingFullscreenDockLayoutRestore = false;
            tracker.restoreGameAfterOwnedWindowClose('fullscreen-dock-layout-applied');
          }
          // hide/showInactive 또는 위치 변경으로 흔들릴 수 있는 TW-Overlay 내부 순서를
          // 독이 입력 가능한 층에 놓이도록 즉시 다시 확정합니다.
          if (tracker.isGameOrAppForeground()) bringGameAndOverlaysToTop();
        }
      }
    } else {
      const currentSidebarB = mainWindow.getBounds();
      const edgePhysX = sidebarPos === 'left'
        ? currentRect.x
        : currentRect.x + currentRect.width;
      const samplePhysX = sidebarPos === 'left' ? edgePhysX : Math.max(currentRect.x, edgePhysX - 1);
      const edgeDipX = sidebarPos === 'left'
        ? screen.screenToDipRect(null, { x: edgePhysX, y: currentRect.y, width: 1, height: 1 }).x
        : screen.screenToDipRect(null, { x: samplePhysX, y: currentRect.y, width: 1, height: 1 }).x + 1;
      const sidebarBounds = calculateSidebarBounds(sidebarPos, scaledGameRect, edgeDipX, currentSidebarB);

      // 사이드바는 전체화면 모드일 때도 게임 창 가장자리에 항상 도킹되어 보여야 함
      if (hasBoundsChanged(currentSidebarB, sidebarBounds, POSITION_THRESHOLD)) {
        if (isValidCoordinate(sidebarBounds.x) && isValidCoordinate(sidebarBounds.y) && isValidCoordinate(sidebarBounds.width) && isValidCoordinate(sidebarBounds.height)) {
          setProgrammaticMove('main', sidebarBounds.x, sidebarBounds.y);
          mainWindow.setBounds(sidebarBounds);
        }
      }
    }

    Object.keys(windowRegistry).forEach(key => {
      if (key === 'dock') return;
      const winCfg = windowRegistry[key];
      if (winCfg.ref && !winCfg.ref.isDestroyed() && winCfg.ref.isVisible()) {
        // 스케일링된 좌표(gX, y 등)를 기반으로 위치 계산
        let { x, y } = (winCfg.calcPosition)
          ? winCfg.calcPosition(scaledGameRect, winCfg.pos)
          : calculateAttachedWindowPosition(scaledGameRect, winCfg.pos);

        const b = winCfg.ref.getBounds();
        // 추적 중에는 예정 좌표를, 추적 중단/전체화면 상태에서는 실제 창 좌표를 검사합니다.
        // 어느 경우든 창이 모든 화면에서 완전히 사라진 경우에는 중앙 복구를 우선합니다.
        const recovery = recoverCompletelyOffscreenWindow(
          key as WindowPositionKey,
          scaledGameRect,
          skipPositionSync ? b.x : x,
          skipPositionSync ? b.y : y,
          b.width,
          b.height,
        );
        if (recovery.recovered) {
          x = recovery.x;
          y = recovery.y;
        }

        if (!programmaticMoves.isUserDragging(key) && (!skipPositionSync || recovery.recovered) && hasPositionChanged(b, { x, y }, POSITION_THRESHOLD)) {
          if (isValidCoordinate(x) && isValidCoordinate(y)) {
            setProgrammaticMove(key, x, y);
            winCfg.ref.setPosition(x, y);
          }
        }
      }
    });
    sendActiveWindowsStatus();
  } else {
    // 게임 창을 찾을 수 없는 경우: 사이드바/오버레이 숨김 및 추적 해제
    hideOverlayWindows();
    gameRect = null;
    physicalGameRect = null;
  }
}

export function applySettings(newSettings: Partial<AppConfig> & { isSidebarResize?: boolean }): void {
  if (newSettings.isSidebarResize && mainWindow) {
    const b = mainWindow.getBounds();
    const cfg = config.load();
    const sidebarPos = cfg.sidebarPosition || 'right';
    const resizedBounds = calculateSidebarResizeBounds(sidebarPos, b, newSettings.width!);
    // X(right 방향)와 Y/H는 syncOverlay가 관리 — stale gameRect 사용 금지
    setProgrammaticMove('main', Math.round(resizedBounds.x), resizedBounds.y);
    if (mainWindow.isVisible()) {
      if (isValidCoordinate(resizedBounds.x) && isValidCoordinate(resizedBounds.y) && isValidCoordinate(resizedBounds.width) && isValidCoordinate(resizedBounds.height)) {
        mainWindow.setBounds({ ...resizedBounds, x: Math.round(resizedBounds.x) });
      }
    }

    // 열려있는 자식 창들도 재배치 (사이드바 X 변경에 따른 오프셋 보정)
    // 전체화면(isGameFullscreen) 상태일 때는 개별 오버레이 창들의 위치 조정을 건너뜁니다.
    if (gameRect && !isGameFullscreen) {
      Object.keys(windowRegistry).forEach(key => {
        const winCfg = windowRegistry[key];
        if (winCfg.ref && !winCfg.ref.isDestroyed() && winCfg.ref.isVisible()) {
          const { x, y } = winCfg.calcPosition
            ? winCfg.calcPosition(gameRect!, winCfg.pos)
            : calculateAttachedWindowPosition(gameRect!, winCfg.pos);

          const b = winCfg.ref.getBounds();
          if (!programmaticMoves.isUserDragging(key) && hasPositionChanged(b, { x, y }, POSITION_THRESHOLD)) {
            if (isValidCoordinate(x) && isValidCoordinate(y)) {
              setProgrammaticMove(key, x, y);
              winCfg.ref.setPosition(x, y);
            }
          }
        }
      });
    }
    return;
  }
  const sanitizedSettings = { ...newSettings };
  const current = config.load(), updated = { ...current, ...sanitizedSettings };
  const isDockPositionChange = sanitizedSettings.sidebarPosition !== undefined
    && sanitizedSettings.sidebarPosition !== current.sidebarPosition
    && (sanitizedSettings.sidebarPosition === 'dock' || sanitizedSettings.sidebarPosition === 'dock-top')
    && (current.sidebarPosition === 'dock' || current.sidebarPosition === 'dock-top');
  if (isDockPositionChange) {
    pendingDockLayoutChange = true;
    pendingFullscreenDockLayoutRestore = isGameFullscreen;
    log(`[WINDOW_FOCUS] 독 배치 변경 대기: ${current.sidebarPosition} -> ${sanitizedSettings.sidebarPosition}, fullscreen=${isGameFullscreen}`);
  }
  const { isSidebarResize, ...saveSettings } = sanitizedSettings;
  config.saveImmediate(saveSettings);
  if (overlayWindow) {
    isApplyingSize = true;
    const b = overlayWindow.getBounds();
    overlayWindow.setBounds({ x: b.x, y: b.y, width: Math.max(MIN_W, updated.width), height: Math.max(MIN_H, updated.height) });
    overlayWindow.setOpacity(updated.opacity);
    updateViewBounds();
    setTimeout(() => { isApplyingSize = false; }, 300);
  }
  [mainWindow, overlayWindow, gameOverlayWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('config-data', updated);
    }
  });
  Object.values(windowRegistry).forEach(winCfg => {
    if (winCfg.ref && !winCfg.ref.isDestroyed()) {
      winCfg.ref.webContents.send('config-data', updated);
    }
  });

  if (gameOverlayWindow && !gameOverlayWindow.isDestroyed()) {
    gameOverlayWindow.webContents.send('today-summary-config', updated);
  }

  if (newSettings.chatOverlayClickThrough !== undefined) {
    const chatWin = windowRegistry.chatOverlay.ref;
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.setIgnoreMouseEvents(newSettings.chatOverlayClickThrough, { forward: true });
    }
    const subWin = windowRegistry.chatOverlaySub.ref;
    if (subWin && !subWin.isDestroyed()) {
      subWin.setIgnoreMouseEvents(newSettings.chatOverlayClickThrough, { forward: true });
    }
    const sub2Win = windowRegistry.chatOverlaySub2.ref;
    if (sub2Win && !sub2Win.isDestroyed()) {
      sub2Win.setIgnoreMouseEvents(newSettings.chatOverlayClickThrough, { forward: true });
    }
  }

  if (newSettings.chatOverlayEnabled !== undefined) {
    isChatOverlayVisible = newSettings.chatOverlayEnabled;
    const chatWinCfg = windowRegistry['chatOverlay'];
    if (isChatOverlayVisible) {
      if (gameRect && (!chatWinCfg.ref || chatWinCfg.ref.isDestroyed())) {
        createToggleableWindow('chatOverlay', undefined, 'settings-apply');
      }
    } else {
      if (chatWinCfg.ref && !chatWinCfg.ref.isDestroyed()) {
        chatWinCfg.ref.close();
      }
    }
  }

  if (newSettings.chatOverlayWidth !== undefined || newSettings.chatOverlayHeight !== undefined) {
    const chatWinCfg = windowRegistry['chatOverlay'];
    if (chatWinCfg.ref && !chatWinCfg.ref.isDestroyed()) {
      const b = chatWinCfg.ref.getBounds();
      chatWinCfg.ref.setBounds(resizeBounds(b, newSettings.chatOverlayWidth, newSettings.chatOverlayHeight));
    }
  }

  if (newSettings.chatOverlaySubWidth !== undefined || newSettings.chatOverlaySubHeight !== undefined) {
    const subWinCfg = windowRegistry['chatOverlaySub'];
    if (subWinCfg.ref && !subWinCfg.ref.isDestroyed()) {
      const b = subWinCfg.ref.getBounds();
      subWinCfg.ref.setBounds(resizeBounds(b, newSettings.chatOverlaySubWidth, newSettings.chatOverlaySubHeight));
    }
  }

  if (newSettings.chatOverlaySub2Width !== undefined || newSettings.chatOverlaySub2Height !== undefined) {
    const sub2WinCfg = windowRegistry['chatOverlaySub2'];
    if (sub2WinCfg.ref && !sub2WinCfg.ref.isDestroyed()) {
      const b = sub2WinCfg.ref.getBounds();
      sub2WinCfg.ref.setBounds(resizeBounds(b, newSettings.chatOverlaySub2Width, newSettings.chatOverlaySub2Height));
    }
  }

  if (newSettings.contentsCheckerEnabled !== undefined) {
    isContentsCheckerVisible = newSettings.contentsCheckerEnabled;
  }

  // buffTimerManager warnSeconds 캐시 갱신
  buffTimerManager.refreshConfig();

  // 설정 변경 즉시 반영 (물리 좌표 사용 — DIP 이중 변환 방지)
  if (physicalGameRect) syncOverlay(physicalGameRect);

  // 설정 저장 시 트레이 메뉴(숨김 메뉴 등) 즉시 동기화
  import('./tray').then(mod => {
    if (mod.updateTrayMenu) mod.updateTrayMenu();
  }).catch(e => log(`[WINDOW_MANAGER] 트레이 메뉴 업데이트 실패: ${e}`));
}

export function toggleClickThrough(): boolean {
  const chatWin = windowRegistry.chatOverlay.ref;
  const subWin = windowRegistry.chatOverlaySub.ref;
  const sub2Win = windowRegistry.chatOverlaySub2.ref;
  // 오버레이 창들이 모두 닫혀 있다면 작동 무시
  if (!overlayWindow && (!chatWin || chatWin.isDestroyed()) && (!subWin || subWin.isDestroyed()) && (!sub2Win || sub2Win.isDestroyed())) {
    return false;
  }

  isClickThrough = !isClickThrough;

  // 1. 웹 브라우저 오버레이 투과 제어
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(isClickThrough, isClickThrough ? { forward: true } : undefined);
    if (isClickThrough && isToolbarShown) { isToolbarShown = false; updateViewBounds(); }
    overlayWindow.webContents.send('click-through-status', isClickThrough);
  }

  // 2. 채팅 오버레이 투과 제어 및 설정 실시간 동기화/저장
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.setIgnoreMouseEvents(isClickThrough, { forward: true });
  }
  if (subWin && !subWin.isDestroyed()) {
    subWin.setIgnoreMouseEvents(isClickThrough, { forward: true });
  }
  if (sub2Win && !sub2Win.isDestroyed()) {
    sub2Win.setIgnoreMouseEvents(isClickThrough, { forward: true });
  }

  // Z-Order 재정렬 강제 적용 (비동기 스타일 갱신 딜레이 150ms 감안하여 지연 정렬 수행)
  setTimeout(() => {
    const gameHwndStr = tracker.getGameHwnd();
    if (gameHwndStr) {
      const hwnds = getAllWindowHwnds();
      if (hwnds.length > 0) {
        // 지연 시간 사이 외부 프로그램으로 전환했다면 그 창의 Z-order를 침범하지 않는다.
        tracker.reconcileGameZOrder(gameHwndStr, hwnds);
      }
    }
  }, 150);

  config.save({ chatOverlayClickThrough: isClickThrough });
  const updatedCfg = config.load();
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('config-data', updatedCfg);
  if (subWin && !subWin.isDestroyed()) subWin.webContents.send('config-data', updatedCfg);
  if (sub2Win && !sub2Win.isDestroyed()) sub2Win.webContents.send('config-data', updatedCfg);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('click-through-status', isClickThrough);
    mainWindow.webContents.send('config-data', config.load());
  }

  // 설정 화면이 켜져 있는 경우 UI 체크박스 실시간 반응을 위해 config 재송신
  const settingsWin = windowRegistry.settings.ref;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('config-data', config.load());
  }

  return isClickThrough;
}

export function toggleSidebar(): boolean {
  isSidebarCollapsed = !isSidebarCollapsed;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sidebar-status', isSidebarCollapsed);
  }
  return isSidebarCollapsed;
}

export function hideAll(): void {
  // 게임 종료/최소화 시 포커스 복구 억제 (closed 이벤트가 동기 발생하는 경우 방어)
  focusController.setRestoreSuppressed(true);

  // 오버레이 창 종료 (Close)
  if (overlayWindow) {
    savePosition('overlay', overlayPos, true);
    if (view) { try { overlayWindow.contentView.removeChildView(view); view.webContents.close(); } catch (e) { } view = null; }
    overlayWindow.close();
    overlayWindow = null;
  }

  // 사이드바는 숨김 (Hide) - 앱 실행 유지를 위함
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  }

  // 게임 전용 오버레이 숨김
  if (gameOverlayWindow && !gameOverlayWindow.isDestroyed() && gameOverlayWindow.isVisible()) {
    gameOverlayWindow.hide();
  }

  // 모든 유틸리티 창 종료 (Close)
  Object.values(windowRegistry).forEach(winCfg => {
    if (winCfg.ref && !winCfg.ref.isDestroyed()) {
      winCfg.ref.close(); // closed 이벤트에 의해 winCfg.ref = null 처리됨
    }
  });

  focusController.setRestoreSuppressed(false);

  // closed 이벤트가 비동기 발생하는 경우를 대비하여 gameRect를 먼저 null 처리
  // → 타이머 콜백의 gameRect 체크가 최종 방어선 역할
  isTracking = false;
  gameRect = null; // 게임 상태 초기화
  physicalGameRect = null;
  // 최소화 전 전체화면 상태가 복원 후 첫 위치 동기화를 막지 않도록 전환 상태를 끊습니다.
  isGameFullscreen = false;
  programmaticMoves.clear();

  // 동기 closed에서 설정된 타이머도 정리
  focusController.cancelPendingRestore();
}

/** 종료 flush를 기다리는 동안 사용자에게 앱이 남아 보이지 않도록 모든 Electron 창만 즉시 숨긴다. */
export function hideAllForShutdown(): void {
  focusController.setRestoreSuppressed(true);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.isVisible()) window.hide();
  }
}

export function getMainWindow(): BrowserWindow | null {
  return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
}

export function hideOverlayWindows(): void {
  // 오버레이 창 종료 (Close)
  if (overlayWindow) {
    savePosition('overlay', overlayPos, true);
    if (view) { try { overlayWindow.contentView.removeChildView(view); view.webContents.close(); } catch (e) { } view = null; }
    overlayWindow.close();
    overlayWindow = null;
  }

  // 사이드바 숨김 (Hide)
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  }

  // 게임 전용 오버레이 숨김 (게임 창 최소화/종료 시)
  if (gameOverlayWindow && !gameOverlayWindow.isDestroyed() && gameOverlayWindow.isVisible()) {
    gameOverlayWindow.hide();
  }

  // 독바 숨김
  const dockCfg = windowRegistry['dock'];
  if (dockCfg && dockCfg.ref && !dockCfg.ref.isDestroyed() && dockCfg.ref.isVisible()) {
    dockCfg.ref.hide();
  }

  // 채팅 오버레이 닫기
  const chatWinCfg = windowRegistry['chatOverlay'];
  if (chatWinCfg && chatWinCfg.ref && !chatWinCfg.ref.isDestroyed()) {
    chatWinCfg.ref.close();
  }
  const subWinCfg = windowRegistry['chatOverlaySub'];
  if (subWinCfg && subWinCfg.ref && !subWinCfg.ref.isDestroyed()) {
    subWinCfg.ref.close();
  }
  const sub2WinCfg = windowRegistry['chatOverlaySub2'];
  if (sub2WinCfg && sub2WinCfg.ref && !sub2WinCfg.ref.isDestroyed()) {
    sub2WinCfg.ref.close();
  }

  isTracking = false;
  gameRect = null; // 게임 상태 초기화
  physicalGameRect = null;
  isGameFullscreen = false;
  programmaticMoves.clear();
}

/** 게임 프로세스가 끝났을 때만 세션에 종속된 해상도 캐시를 폐기합니다. */
export function resetGameSessionState(): void {
  lastForegroundSize = null;
  lastKnownGameRect = null;
  isGameFullscreen = false;
}
export function showGameExitReminder(): void {
  const cfg = config.load();
  if (!cfg.gameExitReminderEnabled || !cfg.gameExitReminderMessage?.trim()) return;

  const incompleteItems = collectIncompleteContents(cfg);

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = 500, winHeight = 560;

  const reminderWin = new BrowserWindow(getStandardOptions(winWidth, winHeight, {
    center: true, resizable: false, skipTaskbar: false, alwaysOnTop: true,
    transparent: false, backgroundColor: '#0f121e',
    x: Math.round((screenWidth - winWidth) / 2),
    y: Math.round((screenHeight - winHeight) / 2),
  }));

  reminderWin.loadFile(path.join(__dirname, '..', 'game-exit-reminder.html'));
  reminderWin.once('ready-to-show', () => {
    reminderWin.webContents.send('reminder-message', cfg.gameExitReminderMessage);
    reminderWin.webContents.send('incomplete-contents', incompleteItems);
    reminderWin.show();
    reminderWin.focus();
  });
}

export function sendActiveWindowsStatus(): void {
  const activeKeys: string[] = [];
  Object.keys(windowRegistry).forEach(key => {
    if (key === 'dock') return;
    const winCfg = windowRegistry[key];
    if (winCfg.ref && !winCfg.ref.isDestroyed() && winCfg.ref.isVisible()) {
      activeKeys.push(key);
    }
  });
  const dockCfg = windowRegistry['dock'];
  if (dockCfg && dockCfg.ref && !dockCfg.ref.isDestroyed()) {
    dockCfg.ref.webContents.send('active-windows', activeKeys);
  }
}

export function setChatOverlaySize(mode: 'main' | 'sub1' | 'sub2', width: number, height: number): void {
  const key = mode === 'main' ? 'chatOverlay' : (mode === 'sub1' ? 'chatOverlaySub' : 'chatOverlaySub2');
  const winCfg = windowRegistry[key];
  if (winCfg.ref && !winCfg.ref.isDestroyed()) {
    const b = winCfg.ref.getBounds();
    winCfg.ref.setBounds({ x: b.x, y: b.y, width, height });
  }
}

export function setFocusedChatSize(width: number, height: number): void {
  const win = windowRegistry.focusedChat.ref;
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  win.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: Math.max(360, Math.round(width)),
    height: Math.max(360, Math.round(height))
  });
}

export function sendPlaySound(data: {
  label: string;
  soundFile: string;
  volume?: number;
  spawnTime?: string;
  offset?: number;
  isCustom?: boolean;
  isAlreadyRecorded?: boolean;
  isPreview?: boolean;
  logMessage?: string;
}): void {
  const cfg = config.load();
  const sidebarPos = cfg.sidebarPosition || 'right';
  const isDock = sidebarPos === 'dock' || sidebarPos === 'dock-top';
  const showOnOverlay = !!cfg.showSidebarToastOnOverlay;

  // 1. 알람 로그 데이터베이스에 기록 (테스트/미리보기가 아닐 때만)
  if (!data.isPreview) {
    let type: 'boss' | 'custom' | 'word' | 'wave' | 'buff' | 'etc' = 'etc';
    let title = '알림';
    let message = data.logMessage || data.label;

    if (data.logMessage) {
      if (data.logMessage.startsWith('[지정 단어]') || data.logMessage.startsWith('[단어]')) {
        type = 'word';
        title = '지정 단어 알림';
      } else if (data.logMessage.startsWith('[웨이브]') || data.logMessage.startsWith('[몬스터 웨이브]')) {
        type = 'wave';
        title = '몬스터 웨이브 알림';
      } else if (data.logMessage.startsWith('[버프]')) {
        type = 'buff';
        title = '버프 타이머 알림';
      }
    }

    if (type === 'etc') {
      const isBoss = (data.spawnTime && data.spawnTime !== 'undefined' && data.spawnTime !== 'null') && !data.isCustom;
      if (isBoss) {
        type = 'boss';
        title = '필드보스 출현 알림';
        const offsetMin = data.offset ?? 0;
        message = offsetMin === 0 
          ? `[${data.spawnTime}] [${data.label}] 출현!` 
          : `[${data.spawnTime}] [${data.label}] ${offsetMin}분 전`;
      } else if (data.isCustom) {
        if (data.label === '지정 단어 알림') {
          type = 'word';
          title = '지정 단어 알림';
        } else if (data.label === '몬스터 웨이브 종료 대기 알림') {
          type = 'wave';
          title = '몬스터 웨이브 알림';
        } else {
          type = 'custom';
          title = '커스텀 알림';
        }
      }
    }

    diaryDb.addAlarmLog(type, title, message);
  }

  // 2. 토스트 노출 규칙 설정 (미리보기와 실제 알람 동일 적용)
  const shouldShowToastOnIndex = !isDock && !showOnOverlay;
  const shouldShowToastOnOverlay = isDock || showOnOverlay;

  // 3. index.html (메인 창) 처리: 사운드는 여기서만 무조건 재생, 토스트는 조건 만족 시 노출
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('play-sound', {
      ...data,
      soundFile: data.soundFile, // 사운드는 무조건 재생
      showToast: shouldShowToastOnIndex
    });
  }

  // 4. gameOverlayWindow (오버레이 창) 처리: 사운드 파일은 제거(비움), 토스트는 조건 만족 시 노출
  if (gameOverlayWindow && !gameOverlayWindow.isDestroyed()) {
    gameOverlayWindow.webContents.send('play-sound', {
      ...data,
      soundFile: '', // 중복 재생 방지를 위해 사운드 정보 제거
      showToast: shouldShowToastOnOverlay
    });
  }
}

export function openAndHighlightWindow(key: string): void {
  const winCfg = windowRegistry[key];
  if (!winCfg) return;

  const sendHighlight = (win: BrowserWindow) => {
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('highlight-alarm-settings');
      }
    }, 350);
  };

  if (winCfg.ref && !winCfg.ref.isDestroyed()) {
    winCfg.ref.show();
    winCfg.ref.focus();
    sendHighlight(winCfg.ref);
  } else {
    let success = false;
    switch (key) {
      case 'bossSettings':
        success = toggleBossSettingsWindow();
        break;
      case 'wordAlarm':
        success = toggleWordAlarmWindow();
        break;
      case 'buffTimer':
        success = toggleBuffTimerWindow();
        break;
      case 'xpHud':
        success = toggleXpHudWindow();
        break;
    }

    if (success && winCfg.ref) {
      winCfg.ref.webContents.once('did-finish-load', () => {
        sendHighlight(winCfg.ref!);
      });
    }
  }
}


