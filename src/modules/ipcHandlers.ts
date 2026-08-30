/**
 * IPC 이벤트 핸들러 모듈
 */
import { ipcMain, shell, app, BrowserWindow, dialog, screen } from 'electron';
import * as path from 'path';
import * as config from './config';
import { log } from './logger';
import { AppConfig, QuickSlotItem, DEFAULT_CONFIG, IS_DEV } from './constants';
import { DEFAULT_HUD_POSITIONS } from '../shared/windowPositions';
import * as fs from 'fs';
import { resolveSafeChildFile } from './safePath';
import { chatLogManager } from './chatLogManager';
import * as wm from './windowManager';
import * as gallery from './galleryMonitor';
import * as trade from './tradeMonitor';
import * as optimizer from './optimizer';
import { fetchEtaRanking } from './etaRanking';
import { MAIN_CHAR_ID } from '../shared/types';
import type { EtaRankingParams, EvolutionCalculatorSelection, TimerRecord } from '../shared/types';
import { setupAutoStart } from './autoStart';
import * as sm from './shortcutManager';
import { analytics } from './analytics';
import * as tracker from './tracker';
import { FOCUS_RESTORE_DELAY_MS } from './constants';
import * as diaryDb from './diaryDb';
import * as contentsChecker from './contentsChecker';
import * as backup from './backupManager';
import * as cloudSync from './cloudSyncManager';
import { buffTimerManager } from './buffTimerManager';
import * as scam from './scamMonitor';
import * as noticeManager from './noticeManager';
import { discordNotifier } from './discordNotifier';
import { chatParser } from './chatParser';
import { abandonedTracker } from './abandonedTracker';
import { CHAT_OVERLAY_MIN_HEIGHT, CHAT_OVERLAY_MIN_WIDTH } from './managedWindowSizing';
import { buildTodaySummary, getLocalDateKey } from './todaySummary';
import {
  broadcastToAllWindows,
  broadcastToAllWindowsExcept,
} from './windowMessaging';
import {
  syncWeeklyChatLogs,
  getRecentMonday,
  getDiaryRetentionStartDate,
  getSyncTargetLogFiles
} from './chatLogSyncManager';

let _registered = false;

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isFiniteInRange = (value: unknown, min: number, max: number): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
);
const isLimitedString = (value: unknown, maxLength: number, allowEmpty = true): value is string => (
  typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0)
);
const getDiaryLootKeywords = (): string[] => {
  const { lootKeywords } = config.loadFields(['lootKeywords'] as const);
  return Array.isArray(lootKeywords) ? lootKeywords : [];
};
const isSafeId = (value: unknown): value is string => (
  isLimitedString(value, 128, false) && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value)
);

/** 게임과 외부 창은 건드리지 않고 현재 가시 TW-Overlay 창만 게임 위로 복원한다. */
function reconcileGameAttachedWindows(): void {
  const gameHwnd = tracker.getGameHwnd();
  if (!gameHwnd) return;
  tracker.reconcileGameZOrder(gameHwnd, wm.getAllWindowHwnds());
}
const isStringArray = (value: unknown, maxItems = 1_000, maxLength = 500): value is string[] => (
  Array.isArray(value)
  && value.length <= maxItems
  && value.every(item => isLimitedString(item, maxLength))
);
const isValidResetRule = (value: unknown): value is { type: 'daily' | 'weekly'; dayOfWeek?: number; hour?: number } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  if (rule.type !== 'daily' && rule.type !== 'weekly') return false;
  if (rule.hour !== undefined && (!Number.isInteger(rule.hour) || !isFiniteInRange(rule.hour, 0, 23))) return false;
  if (rule.type === 'weekly' && (!Number.isInteger(rule.dayOfWeek) || !isFiniteInRange(rule.dayOfWeek, 0, 6))) return false;
  return true;
};
const isValidDateKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};
const isValidYearMonthKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
};
const isHttpUrl = (value: unknown, maxLength = 4_096): value is string => {
  if (!isLimitedString(value, maxLength, false)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

function isValidQuickSlot(value: unknown): value is QuickSlotItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const slot = value as unknown as Record<string, unknown>;
  return isLimitedString(slot.label, 100, false)
    && isLimitedString(slot.icon, 200)
    && isHttpUrl(slot.url, 4_096)
    && (slot.external === undefined || isBoolean(slot.external))
    && (slot.iconType === undefined || slot.iconType === 'icon' || slot.iconType === 'text')
    && (slot.textChar === undefined || isLimitedString(slot.textChar, 10));
}

const isPositiveInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => (
  Number.isInteger(value) && isFiniteInRange(value, 1, max)
);

function isValidEtaRankingParams(value: unknown): value is EtaRankingParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const params = value as Record<string, unknown>;
  return (params.sc === undefined || isFiniteInRange(params.sc, 0, 100_000))
    && (params.cc === undefined || isFiniteInRange(params.cc, 0, 100_000))
    && (params.page === undefined || isPositiveInteger(params.page, 10_000))
    && (params.search === undefined || isLimitedString(params.search, 200));
}

function isValidTimerRecord(value: unknown): value is Omit<TimerRecord, 'id'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const numericKeys = [
    'duration', 'coefficient', 'char_main', 'char_sub', 'base_main',
    'enchant_main', 'base_sub', 'enchant_sub', 'accuracy',
  ];
  return isLimitedString(record.date, 32, false)
    && isLimitedString(record.title, 300)
    && isLimitedString(record.series, 300)
    && isLimitedString(record.core_master, 300)
    && isLimitedString(record.raw_profile_data, 2_000_000)
    && numericKeys.every(key => isFiniteInRange(record[key], -1_000_000_000_000, 1_000_000_000_000))
    && isFiniteInRange(record.duration, 0, 365 * 24 * 60 * 60 * 1_000);
}

function isValidEquipmentItem(value: unknown): value is Record<string, unknown> & { name: string } {
  if (!isPlainObjectForIpc(value) || !isLimitedString(value.name, 300, false) || !isSafeExternalJsonValueForIpc(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1_000_000;
  } catch {
    return false;
  }
}

/** 장비 사전 → 진화 계산기 전용 IPC 계약을 엄격히 검증한다. */
function isValidEvolutionCalculatorSelection(value: unknown): value is EvolutionCalculatorSelection {
  if (!isPlainObjectForIpc(value)) return false;
  const allowedParts: EvolutionCalculatorSelection['part'][] = [
    '', 'helm', 'armor', 'gloves', 'boots', 'wings', 'amulet', 'shield',
  ];
  const hasValidCategoryAndPart = value.category === 'weapon'
    ? value.part === ''
    : value.category === 'equipment' && allowedParts.includes(value.part as EvolutionCalculatorSelection['part']) && value.part !== '';
  return Object.keys(value).length === 3
    && hasValidCategoryAndPart
    && isLimitedString(value.itemName, 300, false);
}

function isPlainObjectForIpc(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isSafeExternalJsonValueForIpc(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 20_000;
  if (Array.isArray(value)) return value.length <= 2_000 && value.every(child => isSafeExternalJsonValueForIpc(child, depth + 1));
  return isPlainObjectForIpc(value) && Object.keys(value).length <= 1_000
    && Object.entries(value).every(([key, child]) => key.length <= 200
      && !['__proto__', 'prototype', 'constructor'].includes(key)
      && isSafeExternalJsonValueForIpc(child, depth + 1));
}

/** 전체 화면 효과를 표시할 게임 오버레이를 준비하고 렌더러 이벤트를 전달합니다. */
function triggerGameOverlayEffect(
  channel: 'trigger-jellyppy-rain' | 'trigger-firework',
  logLifecycle = false,
): boolean {
  let overlayWin = wm.getGameOverlayWindow();
  let isNew = false;

  if (!overlayWin || overlayWin.isDestroyed()) {
    if (logLifecycle) log('[IPC] gameOverlayWindow not active. Creating window...');
    wm.createGameOverlayWindow();
    overlayWin = wm.getGameOverlayWindow();
    isNew = true;
  }
  if (!overlayWin || overlayWin.isDestroyed()) return false;

  const bounds = overlayWin.getBounds();
  if (bounds.width === 0 || bounds.height === 0 || !overlayWin.isVisible()) {
    if (logLifecycle) log('[IPC] gameOverlayWindow size is 0 or hidden. Restoring safe display bounds...');
    const trackedGameRect = wm.getGameRect();
    const safeBounds = trackedGameRect || screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
    overlayWin.setBounds({
      x: safeBounds.x,
      y: safeBounds.y,
      width: safeBounds.width,
      height: safeBounds.height,
    });
    overlayWin.showInactive();
  }

  overlayWin.setAlwaysOnTop(false);
  reconcileGameAttachedWindows();

  const sendEffect = () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send(channel);
    }
  };
  if (logLifecycle) log('[IPC] Forwarding trigger-firework to gameOverlayWindow webContents.');
  if (isNew) overlayWin.webContents.once('did-finish-load', sendEffect);
  else sendEffect();

  return true;
}

export function register(): void {
  if (_registered) return;
  _registered = true;

  ipcMain.on('get-default-config-sync', event => {
    event.returnValue = DEFAULT_CONFIG;
  });

  ipcMain.on('set-ignore-mouse-events', (event, ignore: boolean, options: { forward?: boolean }) => {
    if (!isBoolean(ignore) || (options !== undefined && (typeof options !== 'object' || options === null || (options.forward !== undefined && !isBoolean(options.forward))))) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setIgnoreMouseEvents(ignore, options || {});
  });

  ipcMain.on('set-always-on-top', (event, flag: boolean) => {
    if (!isBoolean(flag)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      // 사냥 동선 오버레이 모드도 외부 앱 위로 올라가지 않는다.
      // IPC 계약은 유지하되 실제 순서는 중앙 관리자에 위임한다.
      win.setAlwaysOnTop(false);
      reconcileGameAttachedWindows();
      // 오버레이 해제(flag === false) 시, 게임창 뒤로 창이 숨겨지지 않도록 포커스를 다시 줌
      if (!flag) {
        win.show();
        win.focus();
      }
    }
  });

  ipcMain.on('set-window-size', (event, width: number, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isFiniteInRange(width, 100, 16_384) && isFiniteInRange(height, 100, 16_384)) {
      const isResizable = win.isResizable();
      win.setResizable(true);
      win.setSize(Math.round(width), Math.round(height));
      win.setResizable(isResizable);
    }
  });

  ipcMain.on('set-window-position', (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isFiniteInRange(x, -100_000, 100_000) && isFiniteInRange(y, -100_000, 100_000)) {
      win.setPosition(Math.round(x), Math.round(y));
    }
  });

  ipcMain.on('welcome-guide-close', () => {
    config.save({ hasSeenWelcomeGuide: true, setupCompleted: true });
    const guideWin = wm.getWelcomeGuideWindow();
    if (guideWin && !guideWin.isDestroyed()) {
      guideWin.close();
    }
  });

  ipcMain.on('welcome-guide-open', () => {
    analytics.trackEvent('toggle_welcome_guide');
    wm.createWelcomeGuideWindow();
  });

  // ── 과거 채팅 로그 동기화 & 온보딩 마법사 IPC ──
  ipcMain.handle('start-chat-log-sync', async (_event, includeCompletedLogs: unknown = false) => {
    try {
      if (!isBoolean(includeCompletedLogs)) {
        throw new Error('완료된 로그 재분석 옵션이 올바르지 않습니다.');
      }
      return await syncWeeklyChatLogs({ reanalyzeCompletedLogs: includeCompletedLogs });
    } catch (e) {
      log(`[IPC] start-chat-log-sync error: ${e}`);
      return {
        success: false,
        startDate: '',
        endDate: '',
        totalFiles: 0,
        totalLines: 0,
        lootsAdded: 0,
        shoutsAdded: 0,
        homeworkUpdated: 0,
        seedsAdded: 0,
        elsoPointsAdded: 0,
        error: String(e)
      };
    }
  });

  ipcMain.handle('get-recent-monday-date', () => {
    const monday = getRecentMonday();
    const yyyy = monday.getFullYear();
    const mm = String(monday.getMonth() + 1).padStart(2, '0');
    const dd = String(monday.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });

  ipcMain.handle('get-sync-target-files', async () => {
    const cfg = config.load();
    if (!cfg.chatLogPath) return [];
    return await getSyncTargetLogFiles(
      cfg.chatLogPath,
      getDiaryRetentionStartDate(cfg.diaryKeepDays ?? 180),
    );
  });

  ipcMain.on('complete-setup-wizard', (_e, wizardConfig?: { chatLogPath?: string; userServer?: number; chatLogAutoDeleteDays?: number; diaryKeepDays?: number; lootKeywords?: string[] }) => {
    if (wizardConfig !== undefined && (!wizardConfig || typeof wizardConfig !== 'object' || Array.isArray(wizardConfig))) return;
    const updates: Record<string, unknown> = {
      setupCompleted: true,
      hasSeenWelcomeGuide: true
    };
    if (wizardConfig?.chatLogPath && isLimitedString(wizardConfig.chatLogPath, 32_767)) {
      updates.chatLogPath = wizardConfig.chatLogPath;
    }
    if (wizardConfig?.userServer !== undefined && Number.isInteger(wizardConfig.userServer) && isFiniteInRange(wizardConfig.userServer, 1, 10_000)) {
      updates.userServer = wizardConfig.userServer;
    }
    if (wizardConfig?.chatLogAutoDeleteDays !== undefined && Number.isInteger(wizardConfig.chatLogAutoDeleteDays) && isFiniteInRange(wizardConfig.chatLogAutoDeleteDays, 0, 3_650)) {
      updates.chatLogAutoDeleteDays = wizardConfig.chatLogAutoDeleteDays;
    }
    if (wizardConfig?.diaryKeepDays !== undefined && Number.isInteger(wizardConfig.diaryKeepDays) && isFiniteInRange(wizardConfig.diaryKeepDays, 1, 3_650)) {
      updates.diaryKeepDays = wizardConfig.diaryKeepDays;
    }
    if (wizardConfig?.lootKeywords !== undefined && isStringArray(wizardConfig.lootKeywords)) {
      updates.lootKeywords = wizardConfig.lootKeywords;
      updates.lootKeywordsMigratedV2 = true;
    }
    config.saveImmediate(updates);
    log('[SETUP_WIZARD] 초기 설정 마법사 완료 처리');

    // 가이드 창 닫기
    const guideWin = wm.getWelcomeGuideWindow();
    if (guideWin && !guideWin.isDestroyed()) {
      guideWin.close();
    }

    if (config.load().overlayVisible !== false) {
      wm.setOverlayVisible(true);
    }
  });

  ipcMain.handle('get-update-notice-data', () => {
    return noticeManager.getNoticeData();
  });

  ipcMain.on('update-notice-close', () => {
    noticeManager.markNoticeAsRead();
    wm.closeUpdateNoticeWindow();
  });

  ipcMain.on('update-notice-open', () => {
    analytics.trackEvent('toggle_update_notice');
    wm.createUpdateNoticeWindow();
  });

  ipcMain.handle('set-game-overlay-edit-mode', (_e, enabled: boolean, saveOnExit: boolean = true) => {
    if (!isBoolean(enabled) || !isBoolean(saveOnExit)) return false;
    if (enabled) {
      // 편집 가능 여부는 실제 게임 창의 존재로만 판단한다. Windows는 정상적으로 실행 중인
      // 게임이라도 foreground 강제 전환을 거부할 수 있으므로 포커스 성공 여부를 실행 감지와
      // 혼용하면 설정창에서 "게임을 실행해 주세요"라는 잘못된 안내가 표시된다.
      if (!tracker.isGameRunning()) return false;

      // 최소화 복원과 게임 전환은 사용자가 버튼을 누른 시점에 한 번 시도하되, 실패해도
      // 게임 창이 유효하다면 HUD 편집 모드는 계속 연다. 사용자가 게임/HUD를 직접 클릭할 수 있다.
      tracker.focusGameWindow();
    }

    let overlayWin = wm.getGameOverlayWindow();
    if (!overlayWin || overlayWin.isDestroyed()) {
      wm.createGameOverlayWindow();
      overlayWin = wm.getGameOverlayWindow();
    }
    if (overlayWin && !overlayWin.isDestroyed()) {
      if (enabled) {
        overlayWin.setFocusable(true);
        overlayWin.setIgnoreMouseEvents(false);
        overlayWin.setAlwaysOnTop(false);
        overlayWin.show();
        reconcileGameAttachedWindows();
      } else {
        overlayWin.setIgnoreMouseEvents(true);
        overlayWin.setFocusable(false);
        overlayWin.setAlwaysOnTop(false);
        reconcileGameAttachedWindows();
      }
      overlayWin.webContents.send('game-overlay-edit-mode', enabled, saveOnExit);
    }
    return true;
  });

  ipcMain.on('reset-game-overlay-positions', () => {
    const defaultHudPositions = {
      xpWidgetPos: { ...DEFAULT_HUD_POSITIONS.xp },
      buffTimerHudPos: { ...DEFAULT_HUD_POSITIONS.buffTimer },
      abandonedWidgetPos: { ...DEFAULT_HUD_POSITIONS.abandoned },
      digsiteWidgetPos: { ...DEFAULT_HUD_POSITIONS.digsite },
      forgeQuestHudPos: { ...DEFAULT_HUD_POSITIONS.quest },
      todaySummaryHudPos: { ...DEFAULT_HUD_POSITIONS.todaySummary },
    };
    config.save(defaultHudPositions);
    const overlayWin = wm.getGameOverlayWindow();
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('config-updated', config.load());
      overlayWin.webContents.send('game-overlay-reset-positions');
    }
  });

  ipcMain.on('trigger-jellyppy-rain-global', () => {
    analytics.trackEvent('trigger_jellyppy_rain_global');
    triggerGameOverlayEffect('trigger-jellyppy-rain');
  });

  ipcMain.on('trigger-firework-global', () => {
    log('[IPC] trigger-firework-global event received from renderer in Main Process.');
    analytics.trackEvent('trigger_firework_global');
    if (!triggerGameOverlayEffect('trigger-firework', true)) {
      console.warn('[IPC] Failed to forward event: gameOverlayWindow is null or destroyed.');
    }
  });

  ipcMain.on('set-opacity', (_e, opacity: number) => {
    if (!isFiniteInRange(opacity, 0.2, 1)) return;
    const win = wm.getOverlayWindow();
    if (win) win.setOpacity(opacity);
    config.save({ opacity });
  });

  ipcMain.on('set-chat-overlay-size', (_e, mode: 'main' | 'sub1' | 'sub2', width: number, height: number) => {
    if (!['main', 'sub1', 'sub2'].includes(mode)
      || !isFiniteInRange(width, CHAT_OVERLAY_MIN_WIDTH, 8_192)
      || !isFiniteInRange(height, CHAT_OVERLAY_MIN_HEIGHT, 8_192)) return;
    wm.setChatOverlaySize(mode, width, height);
  });

  ipcMain.on('set-focused-chat-size', (_e, width: number, height: number) => {
    if (!isFiniteInRange(width, 200, 8_192) || !isFiniteInRange(height, 120, 8_192)) return;
    wm.setFocusedChatSize(width, height);
  });

  ipcMain.on('navigate', (_e, url: string) => {
    if (!isLimitedString(url, 4_096, false)) return;
    let t = url.trim();
    if (!t.startsWith('http://') && !t.startsWith('https://')) t = 'https://' + t;
    try {
      const parsedUrl = new URL(t);
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
        wm.setOverlayVisible(true, parsedUrl.href);
      }
    } catch (e) {
      console.warn('[IPC] Invalid URL in navigate:', url);
    }
  });

  ipcMain.on('go-home', () => {
    analytics.trackEvent('go_home');
    const cfg = config.load();
    wm.setOverlayVisible(true, cfg.homeUrl);
  });

  ipcMain.on('apply-settings', (_e, newSettings: Partial<AppConfig> & { isSidebarResize?: boolean }) => {
    if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) return;
    const isSidebarResize = newSettings.isSidebarResize;
    if (isSidebarResize !== undefined && !isBoolean(isSidebarResize)) return;
    const { isSidebarResize: _ignoredResizeFlag, ...configPatch } = newSettings;
    const sanitizedPatch = config.sanitizeExternalConfigPatch(configPatch);
    if (!sanitizedPatch) {
      log('[IPC] 유효하지 않은 apply-settings payload 차단');
      return;
    }
    const sanitizedSettings = { ...sanitizedPatch, ...(isSidebarResize !== undefined ? { isSidebarResize } : {}) };
    wm.applySettings(sanitizedSettings);
    if (sanitizedPatch.analyticsEnabled !== undefined) {
      analytics.refreshEnabledState();
    }
    if (sanitizedPatch.autoLaunch !== undefined) {
      setupAutoStart(sanitizedPatch.autoLaunch);
    }
    if (sanitizedPatch.shortcuts) {
      sm.reloadShortcuts();
    }
    // 설정 변경 후 모니터러 상태 갱신 (윈도우 참조 없이 설정 재로드만)
    gallery.updateWindows(null, null, null);
    trade.updateWindows(null, null);
    
    // 챗로그 상태 변경 여부를 모든 창에 브로드캐스트
    broadcastChatLogStatus();

    // 모험 일지 보관 설정 변경 시 즉시 오래된 데이터 정리 실행
    if (sanitizedPatch.diaryKeepDays !== undefined) {
      const keepDays = sanitizedPatch.diaryKeepDays;
      if (keepDays > 0) {
        analytics.trackEvent('diary_data_cleanup', { keepDays, trigger: 'settings_change' });
        diaryDb.cleanOldDiaryData(keepDays);
      }
    }
    if (sanitizedPatch.lootKeywords !== undefined) {
      broadcastToAllWindows('diary-updated');
    }
  });

  function broadcastChatLogStatus(): void {
    const cfg = config.load();
    const chatLogPath = cfg.chatLogPath;
    let isValid = false;
    try {
      if (chatLogPath && fs.existsSync(chatLogPath)) {
        const files = fs.readdirSync(chatLogPath);
        isValid = files.some(file => file.startsWith('TWChatLog_') && file.endsWith('.html'));
      }
    } catch {}

    broadcastToAllWindows('chat-log-status-changed', isValid);
  }

  // 창 토글 핸들러 일괄 등록
  const toggleHandlers: Record<string, () => void> = {
    'toggle-scam-detector': wm.toggleScamDetectorWindow,
    'toggle-gallery': wm.toggleGalleryWindow,
    'toggle-abbreviation': wm.toggleAbbreviationWindow,
    'toggle-equipment-dic': wm.toggleEquipmentDicWindow,
    'toggle-buffs': wm.toggleBuffsWindow,
    'toggle-boss-settings': wm.toggleBossSettingsWindow,
    'toggle-eta-ranking': wm.toggleEtaRankingWindow,
    'toggle-sidebar': wm.toggleSidebar,
    'toggle-dock': wm.toggleDockWindow,
    'toggle-overlay': wm.toggleOverlay,
    'toggle-click-through': wm.toggleClickThrough,
    'toggle-trade': wm.toggleTradeWindow,
    'toggle-coefficient-calculator': wm.toggleCoefficientCalculatorWindow,
    'toggle-contents-checker': wm.toggleContentsCheckerWindow,
    'toggle-evolution-calculator': wm.toggleEvolutionCalculatorWindow,
    'toggle-thesis-core-calculator': wm.toggleThesisCoreCalculatorWindow,
    'toggle-magic-stone-calculator': wm.toggleMagicStoneCalculatorWindow,
    'toggle-hunting-exp-calculator': wm.toggleHuntingExpCalculatorWindow,
    'toggle-relic-calculator': wm.toggleRelicCalculatorWindow,
    'toggle-equipment-simulator': wm.toggleEquipmentSimulatorWindow,
    'toggle-custom-alert': wm.toggleCustomAlertWindow,
    'toggle-uniform-color': wm.toggleUniformColorWindow,
    'toggle-sword-enhance': wm.toggleSwordEnhanceWindow,
    'toggle-qte-challenge': wm.toggleQteChallengeWindow,
    'toggle-diary': wm.toggleDiaryWindow,
    'toggle-buff-timer': wm.toggleBuffTimerWindow,
    'toggle-xp-hud': wm.toggleXpHudWindow,
    'toggle-siena-aura': wm.toggleSienaAuraWindow,
    'toggle-word-alarm': wm.toggleWordAlarmWindow,
    'toggle-discord-alarm': wm.toggleDiscordAlarmWindow,
    'toggle-chat-overlay': wm.toggleChatOverlayWindow,
    'toggle-focused-chat': wm.toggleFocusedChatWindow,
    'toggle-hunting-path-simulator': wm.toggleHuntingPathSimulatorWindow,
    'toggle-welcome-guide': wm.toggleWelcomeGuideWindow,
    'toggle-update-notice': wm.toggleUpdateNoticeWindow,
    'toggle-shout-history': wm.toggleShoutHistoryWindow,
    'toggle-stopwatch': wm.toggleStopwatchWindow,
  };

  Object.entries(toggleHandlers).forEach(([event, handler]) => {
    ipcMain.on(event, () => {
      analytics.trackEvent(event.replace(/-/g, '_'));
      handler();
    });
  });

  ipcMain.on('open-and-highlight', (_e, key: string) => {
    if (!isLimitedString(key, 128, false)) return;
    const analyticsEvents: Record<string, string> = {
      bossSettings: 'toggle_boss_settings',
      wordAlarm: 'toggle_word_alarm',
      buffTimer: 'toggle_buff_timer',
      xpHud: 'toggle_xp_hud',
    };
    const eventName = analyticsEvents[key];
    if (eventName) analytics.trackEvent(eventName);
    wm.openAndHighlightWindow(key);
  });

  // 컨텐츠 체크 리스트 조작 핸들러
  ipcMain.on('contents-toggle-item', (_e, id: string, characterId?: string) => {
    if (!isSafeId(id) || (characterId !== undefined && !isSafeId(characterId))) return;
    import('./contentsChecker').then(mod => mod.toggleItem(id, characterId));
  });
  ipcMain.on('contents-apply-pending', (_e, characterId: string) => {
    if (!isSafeId(characterId)) return;
    import('./contentsChecker').then(mod => mod.applyPendingHomeworks(characterId));
  });
  ipcMain.on('contents-clear-pending', () => {
    import('./contentsChecker').then(mod => mod.clearPendingHomeworks());
  });
  ipcMain.on('contents-update-count', (_e, id: string, characterId: string, count: number) => {
    if (!isSafeId(id) || !isSafeId(characterId) || !Number.isInteger(count) || !isFiniteInRange(count, 0, 10_000)) return;
    import('./contentsChecker').then(mod => mod.updateItemCount(id, characterId, count));
  });
  ipcMain.on('contents-toggle-exclude', (_e, id: string, characterId: string) => {
    if (!isSafeId(id) || !isSafeId(characterId)) return;
    import('./contentsChecker').then(mod => mod.toggleExcludeItem(id, characterId));
  });
  ipcMain.on('contents-toggle-visibility', (_e, id: string) => {
    if (!isSafeId(id)) return;
    import('./contentsChecker').then(mod => mod.toggleVisibility(id));
  });
  ipcMain.on('contents-update-category', (_e, id: string, category: string) => {
    if (!isSafeId(id) || !isLimitedString(category, 100, false)) return;
    import('./contentsChecker').then(mod => mod.updateCategory(id, category));
  });
  ipcMain.on('contents-update-name', (_e, id: string, name: string) => {
    if (!isSafeId(id) || !isLimitedString(name, 200, false)) return;
    import('./contentsChecker').then(mod => mod.updateName(id, name));
  });
  ipcMain.on('contents-update-item', (_e, id: string, name: string, category: string, rule: any, maxCount?: number) => {
    if (!isSafeId(id) || !isLimitedString(name, 200, false) || !isLimitedString(category, 100, false) || !isValidResetRule(rule)) return;
    if (maxCount !== undefined && (!Number.isInteger(maxCount) || !isFiniteInRange(maxCount, 1, 10_000))) return;
    import('./contentsChecker').then(mod => mod.updateItem(id, name, category, rule, maxCount));
  });
  ipcMain.on('contents-add-custom', (_e, name: string, category: string, rule: any, maxCount?: number) => {
    if (!isLimitedString(name, 200, false) || !isLimitedString(category, 100, false) || !isValidResetRule(rule)) return;
    if (maxCount !== undefined && (!Number.isInteger(maxCount) || !isFiniteInRange(maxCount, 1, 10_000))) return;
    import('./contentsChecker').then(mod => mod.addCustomItem(name, category, rule, maxCount));
  });
  ipcMain.on('contents-remove-item', (_e, id: string) => {
    if (!isSafeId(id)) return;
    import('./contentsChecker').then(mod => mod.removeItem(id));
  });
  ipcMain.on('contents-move-item', (_e, id: string, direction: 'up' | 'down') => {
    if (!isSafeId(id) || (direction !== 'up' && direction !== 'down')) return;
    import('./contentsChecker').then(mod => mod.moveItem(id, direction));
  });
  ipcMain.on('contents-move-category', (_e, resetType: 'daily' | 'weekly', category: string, direction: 'up' | 'down') => {
    if ((resetType !== 'daily' && resetType !== 'weekly') || !isLimitedString(category, 100, false) || (direction !== 'up' && direction !== 'down')) return;
    import('./contentsChecker').then(mod => mod.moveCategory(resetType, category, direction));
  });
  ipcMain.on('contents-reorder-item', (_e, sourceId: string, targetId: string, position: 'before' | 'after') => {
    if (!isSafeId(sourceId) || !isSafeId(targetId) || (position !== 'before' && position !== 'after')) return;
    import('./contentsChecker').then(mod => mod.reorderItem(sourceId, targetId, position));
  });
  ipcMain.on('contents-reorder-category', (_e, resetType: 'daily' | 'weekly', sourceCategory: string, targetCategory: string, position: 'before' | 'after') => {
    if ((resetType !== 'daily' && resetType !== 'weekly') || !isLimitedString(sourceCategory, 100, false) || !isLimitedString(targetCategory, 100, false) || (position !== 'before' && position !== 'after')) return;
    import('./contentsChecker').then(mod => mod.reorderCategory(resetType, sourceCategory, targetCategory, position));
  });
  ipcMain.on('contents-manual-reset', () => {
    import('./contentsChecker').then(mod => mod.checkReset());
  });
  ipcMain.on('contents-add-character', (_e, name: string) => {
    if (!isLimitedString(name, 100, false)) return;
    import('./contentsChecker').then(mod => mod.addCharacter(name));
  });
  ipcMain.on('contents-remove-character', (_e, id: string) => {
    if (!isSafeId(id)) return;
    import('./contentsChecker').then(mod => mod.removeCharacter(id));
  });
  ipcMain.on('contents-rename-character', (_e, id: string, name: string) => {
    if (!isSafeId(id) || !isLimitedString(name, 100, false)) return;
    import('./contentsChecker').then(mod => mod.renameCharacter(id, name));
  });
  ipcMain.on('contents-select-character', (_e, id: string) => {
    if (!isSafeId(id)) return;
    import('./contentsChecker').then(mod => mod.selectCharacter(id));
  });
  ipcMain.on('contents-set-auto-assign-single-candidate', (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') return;
    import('./contentsChecker').then(mod => mod.setAutoAssignSingleCandidate(enabled));
  });

  // 특별 인수가 필요한 토글 핸들러 개별 등록
  ipcMain.on('toggle-settings', (_event, tabId?: string) => {
    if (tabId !== undefined && !isLimitedString(tabId, 128, false)) return;
    const eventName = tabId ? `toggle_settings_${tabId}` : 'toggle_settings';
    analytics.trackEvent(eventName, { tabId });
    wm.toggleSettingsWindow(tabId);
  });

  ipcMain.on('open-coefficient-calculator', () => {
    analytics.trackEvent('toggle_coefficient_calculator');
    wm.openCoefficientCalculatorWindow();
  });

  ipcMain.on('send-to-coefficient', (_event, item) => {
    if (!isValidEquipmentItem(item)) return;
    wm.sendEquipmentToCoefficient(item);
  });

  ipcMain.on('send-to-evolution', (_event, item) => {
    if (!isValidEvolutionCalculatorSelection(item)) return;
    wm.sendEquipmentToEvolution(item);
  });

  ipcMain.on('renderer-ready', (_event, windowKey) => {
    if (!isSafeId(windowKey)) return;
    wm.handleRendererReady(windowKey, _event.sender);
  });

  // 네트워크 최적화 (Fast Ping) 핸들러
  ipcMain.handle('get-optimization-status', async () => {
    return await optimizer.getOptimizationStatus();
  });
  ipcMain.handle('set-optimization', async (_e, enable: boolean) => {
    if (!isBoolean(enable)) return false;
    const eventName = `set_optimization_${enable ? 'on' : 'off'}`;
    analytics.trackEvent(eventName, { enable });
    return await optimizer.setOptimization(enable);
  });
  ipcMain.on('check-for-updates', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    import('./updater').then(mod => mod.manualCheckForUpdate(win));
  });
  ipcMain.on('start-update-download', () => {
    import('./updater').then(mod => mod.startDownload());
  });
  ipcMain.on('open-store-updates-page', () => {
    import('./updater').then(mod => mod.openMicrosoftStoreUpdatesPage());
  });
  ipcMain.on('quit-and-install', () => {
    import('./updater').then(mod => mod.quitAndInstall());
  });
  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.on('open-external', (_e, url: string) => {
    if (!isHttpUrl(url)) return;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
        shell.openExternal(parsedUrl.href);
      }
    } catch (e) {
      console.warn('[IPC] Invalid URL in open-external:', url);
    }
  });

  ipcMain.handle('get-game-status', async () => {
    const { getGameStatus } = await import('./pollingLoop');
    return getGameStatus();
  });

  ipcMain.on('preview-boss-sound', (_e, soundFile: string, volume: number | null, bossName: string = '미리보기') => {
    if (!isLimitedString(soundFile, 500, false)
      || (volume !== null && !isFiniteInRange(volume, 0, 100))
      || !isLimitedString(bossName, 200)) return;
    wm.sendPlaySound({ label: bossName, soundFile, volume: volume !== null ? volume : undefined, isPreview: true });
  });

  ipcMain.on('save-quick-slots', (_e, slots: QuickSlotItem[]) => {
    if (!Array.isArray(slots) || slots.length > 100 || !slots.every(isValidQuickSlot)) return;
    config.saveImmediate({ quickSlots: slots });
    // 독 renderer를 hide/show로 재사용하므로 사이드바뿐 아니라 숨겨진 독에도
    // 최신 퀵링크 설정을 즉시 전달해 다음 표시와 현재 UI를 모두 갱신합니다.
    wm.broadcastConfig();
  });

  // 갤러리 모니터 핸들러
  ipcMain.handle('gallery-add-watch', async (_e, postNo: number) => {
    if (!isPositiveInteger(postNo, 1_000_000_000)) return false;
    return await gallery.addWatch(postNo);
  });
  ipcMain.on('gallery-remove-watch', (_e, postNo: number) => {
    if (isPositiveInteger(postNo, 1_000_000_000)) gallery.removeWatch(postNo);
  });
  ipcMain.handle('gallery-get-watched', async () => { return gallery.getWatchedPosts(); });
  ipcMain.handle('gallery-force-check', async () => { await gallery.forceCheck(); return gallery.getWatchedPosts(); });
  ipcMain.handle('gallery-get-notify', () => { return gallery.getNotifyEnabled(); });
  ipcMain.on('gallery-set-notify', (_e, enabled: boolean) => {
    if (isBoolean(enabled)) gallery.setNotifyEnabled(enabled);
  });
  ipcMain.on('gallery-open-post', (_e, postNo: number | string) => {
    const safePostNo = String(postNo).replace(/[^0-9]/g, '');
    if (safePostNo && safePostNo.length <= 10) {
      shell.openExternal(`https://gall.dcinside.com/mini/board/view/?id=talesweaver&no=${safePostNo}`);
    }
  });

  // 에타 랭킹 모듈 핸들러
  ipcMain.handle('get-eta-ranking', async (_e, params: EtaRankingParams) => {
    if (!isValidEtaRankingParams(params)) return null;
    return await fetchEtaRanking(params);
  });

  // 거래 게시판 모니터 핸들러
  ipcMain.handle('trade-force-check', async () => { return await trade.forceCheck(); });
  ipcMain.handle('trade-get-notify', () => { return trade.getNotifyEnabled(); });
  ipcMain.on('trade-set-notify', (_e, enabled: boolean) => {
    if (isBoolean(enabled)) trade.setNotifyEnabled(enabled);
  });
  ipcMain.on('trade-open-post', (_e, url: string) => {
    if (!isHttpUrl(url)) return;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
        shell.openExternal(parsedUrl.href);
      }
    } catch (e) {
      console.warn('[IPC] Invalid URL in trade-open-post:', url);
    }
  });
  ipcMain.on('trade-set-server', (_e, serverId: string) => {
    if (isLimitedString(serverId, 100, false)) trade.setServer(serverId);
  });
  ipcMain.handle('trade-get-server', () => { return trade.getServer(); });
  ipcMain.handle('trade-get-servers', () => { return trade.getServers(); });

  // --- Diary (Adventure Log) System ---
  const validActivityTypes = ['boss', 'calc', 'memo', 'loot', 'homework'] as const;

  ipcMain.handle('diary-get-by-date', (_e, date: string) => {
    if (!isValidDateKey(date)) return { diary: null, homeworkLogs: [], activityLogs: [] };
    return diaryDb.getDiaryByDate(date, getDiaryLootKeywords());
  });
  ipcMain.handle('diary-get-by-month', (_e, yearMonth: string) => {
    if (!isValidYearMonthKey(yearMonth)) return [];
    const cfg = config.loadFields(['contentsCheckerItems', 'characterPresets'] as const);
    const presets = cfg.characterPresets?.length ? cfg.characterPresets : [{ id: MAIN_CHAR_ID }];
    const currentWeeklyTotal = contentsChecker.calculateDiaryHomeworkStats(
      cfg.contentsCheckerItems || [],
      presets,
    ).weeklyTotal;
    return diaryDb.getDiariesByMonth(yearMonth, currentWeeklyTotal);
  });
  ipcMain.handle('diary-get-monthly-summary', (_e, yearMonth: string) => {
    if (!isValidYearMonthKey(yearMonth)) return { totalLoots: 0, totalSeed: 0, lootList: [], seedList: [] };
    return diaryDb.getMonthlySummary(yearMonth, getDiaryLootKeywords());
  });
  ipcMain.handle('diary-get-statistics', (_e, yearMonth: string) => {
    if (!isValidYearMonthKey(yearMonth)) return null;
    return diaryDb.getMonthlyStatistics(yearMonth, getDiaryLootKeywords());
  });
  ipcMain.handle('diary-get-loot-history', (_e, startDate: string, endDate: string) => {
    if (!isValidDateKey(startDate) || !isValidDateKey(endDate) || startDate > endDate) return [];
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    const rangeDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    if (!Number.isFinite(rangeDays) || rangeDays > 366) return [];
    return diaryDb.getLootHistory(startDate, endDate, getDiaryLootKeywords());
  });
  ipcMain.handle('diary-get-monthly-revenue', (_e, yearMonth: string) => {
    if (!isValidYearMonthKey(yearMonth)) return [];
    return diaryDb.getMonthlyRevenueData(yearMonth);
  });
  ipcMain.handle('diary-get-shout-history', (_e, hours: number, searchQuery: string) => {
    if (!isPositiveInteger(hours, 24 * 365) || !isLimitedString(searchQuery, 1_000)) return [];
    return diaryDb.getShoutHistory(hours, searchQuery);
  });
  ipcMain.handle('word-alarm-get-history', (_e, hours: number) => {
    if (!isPositiveInteger(hours, 24 * 365)) return [];
    return diaryDb.getWordAlarmHistory(hours);
  });
  ipcMain.handle('word-alarm-get-context', (_e, alarmId: number) => {
    if (!isPositiveInteger(alarmId)) return [];
    return diaryDb.getWordAlarmContext(alarmId);
  });
  ipcMain.on('word-alarm-delete-item', (_e, id: number) => {
    if (isPositiveInteger(id)) diaryDb.deleteWordAlarmHistoryItem(id);
  });
  ipcMain.on('word-alarm-clear-history', () => {
    diaryDb.clearWordAlarmHistory();
  });
  ipcMain.on('play-sound', (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { file, volume } = payload as Record<string, unknown>;
    if (!isLimitedString(file, 500, false) || !isFiniteInRange(volume, 0, 100)) return;
    wm.sendPlaySound({ label: '미리보기', soundFile: file, volume, isPreview: true });
  });
  ipcMain.handle('diary-add-activity', (_e, date: string, time: string, type: 'boss' | 'calc' | 'memo' | 'loot' | 'homework', content: string, amount: number = 0) => {
    if (!isValidDateKey(date) || !isLimitedString(time, 16, false)
      || !validActivityTypes.includes(type) || !isLimitedString(content, 20_000)
      || !isFiniteInRange(amount, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) return null;
    return diaryDb.addManualActivityLog(date, time, type, content, amount);
  });
  ipcMain.handle('diary-remove-activity', (_e, id: number) => {
    if (!isPositiveInteger(id)) return false;
    return diaryDb.removeManualActivityLogById(id);
  });
  ipcMain.on('diary-update-monster', (_e, date: string, monsterId: string) => {
    if (!isValidDateKey(date) || !isLimitedString(monsterId, 128, false)) return;
    diaryDb.updateDiaryMonster(date, monsterId);
  });

  // --- Hunting Path Simulator System ---
  ipcMain.handle('get-hunting-grounds', () => {
    return diaryDb.getHuntingGrounds();
  });
  ipcMain.handle('get-hunting-path', (_e, groundId: string) => {
    if (!isSafeId(groundId)) return [];
    return diaryDb.getHuntingPath(groundId);
  });
  ipcMain.on('save-hunting-path', (_e, groundId: string, points: Array<[number, number, string?]>) => {
    if (!isSafeId(groundId) || !Array.isArray(points) || points.length > 100_000
      || !points.every(point => Array.isArray(point)
        && (point.length === 2 || point.length === 3)
        && isFiniteInRange(point[0], -1_000_000, 1_000_000)
        && isFiniteInRange(point[1], -1_000_000, 1_000_000)
        && (point[2] === undefined || isLimitedString(point[2], 200)))) return;
    diaryDb.saveHuntingPath(groundId, points);
  });

  // --- Shortcut Control ---
  ipcMain.on('shortcuts-unregister', () => sm.unregisterAll());
  ipcMain.on('shortcuts-register', () => sm.registerAll());

  // --- Backup & Restore ---
  ipcMain.handle('backup-export', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? await backup.exportBackup(win) : false;
  });
  ipcMain.handle('backup-import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? await backup.importBackup(win) : false;
  });

  // --- Google Drive Sync ---
  ipcMain.handle('google-sync-login', async () => cloudSync.loginAndInit());
  ipcMain.handle('google-sync-cancel-login', async () => cloudSync.cancelLogin());
  ipcMain.handle('google-sync-is-logging-in', async () => cloudSync.isLoggingIn());
  ipcMain.handle('google-sync-logout', async () => cloudSync.logout());
  ipcMain.handle('google-sync-get-status', async () => cloudSync.getSyncStatus());
  ipcMain.handle('google-sync-backup', async () => cloudSync.syncToCloud(true));
  ipcMain.handle('google-sync-restore', async (_event, selectedKinds: unknown) => {
    const normalizedKinds = Array.isArray(selectedKinds)
      ? (['settings', 'checklist'] as const).filter(kind => selectedKinds.includes(kind))
      : ['settings', 'checklist'] as const;
    return cloudSync.syncFromCloud(true, [...normalizedKinds]);
  });
  ipcMain.handle('google-sync-rollback', async () => cloudSync.rollbackLastRestore());
  ipcMain.handle('google-sync-preview', async (_event, kind: unknown) => {
    const normalizedKind = kind === 'settings' || kind === 'checklist' ? kind : undefined;
    return cloudSync.getCloudDataPreview(normalizedKind);
  });
  ipcMain.handle('google-sync-toggle-auto', async (_event, enabled: boolean) => {
    if (!isBoolean(enabled)) return cloudSync.getSyncStatus();
    config.saveImmediate({ googleSyncAutoSync: enabled });
    cloudSync.refreshBackgroundSchedule();
    if (enabled) cloudSync.requestImmediatePull('auto-sync-enabled');
    const status = cloudSync.getSyncStatus();
    broadcastToAllWindows('google-sync-status-changed', status);
    return status;
  });

  // 채팅 로그 폴더 선택 다이얼로그
  ipcMain.handle('dialog:openChatLogFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '테일즈위버 ChatLog 폴더 선택'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // 어벤던로드 상태 요청
  ipcMain.handle('abandoned-get-state', async () => {
    const { chatLogProcessor } = await import('./chatLogProcessor');
    return chatLogProcessor.getAbandonedState();
  });

  // 발굴지 현황판 상태 요청 — renderer 재로드 시에도 진행 중인 한 판을 복원합니다.
  ipcMain.handle('digsite-get-state', async () => {
    const { chatLogProcessor } = await import('./chatLogProcessor');
    return chatLogProcessor.getDigsiteState();
  });

  // 어벤던로드 오버레이 강제 표시/숨김
  ipcMain.on('abandoned-force-visible', async (_e, visible: boolean) => {
    if (!isBoolean(visible)) return;
    const { chatLogProcessor } = await import('./chatLogProcessor');
    chatLogProcessor.forceAbandonedVisible(visible);
  });

  // 어벤던로드 추적기능 활성/비활성
  ipcMain.on('abandoned-set-enabled', async (_e, enabled: boolean) => {
    if (!isBoolean(enabled)) return;
    const { abandonedTracker } = await import('./abandonedTracker');
    abandonedTracker.setEnabled(enabled);
  });

  // 어벤던로드 수동 숨김: 현재 게임 세션 동안 자동 활동으로 다시 표시하지 않는다.
  ipcMain.on('abandoned-hide-now', () => {
    abandonedTracker.forceVisible(false);
    broadcastToAllWindows('abandoned-hide-now');
  });

  // 어벤던로드 자동 숨김 시간 설정
  ipcMain.on('set-abandoned-autohide', (_e, minutes: number) => {
    if (!isFiniteInRange(minutes, 0, 24 * 60)) return;
    config.save({ abandonedAutoHideMinutes: minutes });
  });

  ipcMain.on('close-app', () => { app.quit(); });

  // --- 사기꾼 탐지 ---
  ipcMain.on('scam-set-enabled', (_e, enabled: boolean) => {
    if (!isBoolean(enabled)) return;
    config.save({ scamDetectorEnabled: enabled });
    if (enabled) scam.start();
    else scam.stop();
  });
  ipcMain.handle('scam-get-model-status', () => scam.getModelStatus());
  ipcMain.handle('scam-get-constants', () => scam.getConstants());
  ipcMain.handle('scam-get-msger-log-path', () => scam.getCurrentMsgerLogPath());
  ipcMain.handle('dialog:openMsgerLogFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '테일즈위버 MsgerLog 폴더 선택'
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  ipcMain.handle('scam-detect-gpu', () => scam.detectGpu());
  ipcMain.handle('scam-get-server-status', () => scam.getServerStatus());
  ipcMain.handle('scam-get-session-states', () => scam.getSessionStates());
  ipcMain.handle('scam-get-queue-length', () => scam.getQueueLength());
  ipcMain.on('scam-close-session', (_e, filePath: string) => {
    if (isLimitedString(filePath, 4_096, false)) scam.closeSession(filePath);
  });
  ipcMain.on('scam-trigger-analyze', (_e, filePath: string) => {
    if (isLimitedString(filePath, 4_096, false)) scam.triggerAnalyze(filePath);
  });
  ipcMain.on('scam-stop-server', () => scam.stopServer());
  if (IS_DEV) {
    ipcMain.handle('scam-inject-test', (_e, scenario?: string) => {
      if (scenario !== undefined && !isLimitedString(scenario, 100)) return null;
      return scam.injectTestSession(scenario);
    });
  }
  ipcMain.handle('scam-download-binary-variant', async (event, gpuChoice: string) => {
    if (!['nvidia', 'amd', 'intel', 'none'].includes(gpuChoice)) {
      return { success: false, error: '지원하지 않는 GPU 선택입니다.' };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      scam.stopServer();
      const gpuResult = await scam.buildGpuResultForUserChoice(gpuChoice);
      await scam.downloadServerBinary(gpuResult, (pct) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('scam-progress', pct);
        }
      });
      return { success: true, binaryVariant: gpuResult.binaryVariant };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  ipcMain.handle('scam-download-model', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      await scam.downloadModel((pct) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('scam-progress', pct);
        }
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

  // 버프 타이머 테스트 — 모든 감지 대상 버프 강제 활성화
  if (IS_DEV) ipcMain.on('buff-timer-test', (event, seconds?: number) => {
   if (seconds !== undefined && !isFiniteInRange(seconds, 1, 24 * 60 * 60)) return;
   const TEST_BUFFS = [
     'exp_heart', 'rare_heart', 'stat_exorcist', 'stat_sami_sunryeong',
     'rare_loto', 'util_ampoule', 'dmg_izabel', 'util_illumination',
     'insight_elixir_large', 'insight_elixir_special',
     'exp_eos_supreme', 'exp_sweetpotato_legend', 'exp_earlybird'
   ];
   const durationMs = (seconds && seconds > 0) ? seconds * 1000 : undefined;
   TEST_BUFFS.forEach(buffId => buffTimerManager.activateBuff(buffId, 'test', durationMs));
  });
  // 버프 타이머 테스트 종료 — 테스트 버프 제거
  if (IS_DEV) ipcMain.on('buff-timer-clear-test', () => {
    buffTimerManager.clearTestBuffs();
  });
  // 버프 타이머 모든 버프 삭제
  ipcMain.on('buff-timer-clear-all', () => {
    buffTimerManager.clearAllBuffs();
  });
  // 버프 타이머 강제 비활성화
  ipcMain.on('buff-timer-deactivate', (_e, buffId: string) => {
    if (!isSafeId(buffId)) return;
    buffTimerManager.deactivateBuff(buffId);
  });
  // XP 세션 제어
  ipcMain.handle('xp-get-stats', async () => {
    const mod = await import('./chatLogProcessor');
    return mod.chatLogProcessor.getStats();
  });
  ipcMain.on('xp-reset', () => {
    import('./chatLogProcessor').then(mod => mod.chatLogProcessor.resetXp());
  });
  ipcMain.on('xp-start-session', () => {
    import('./xpTracker').then(mod => mod.xpTracker.startSession());
  });
  ipcMain.on('xp-stop-session', () => {
    import('./xpTracker').then(mod => mod.xpTracker.stopSession());
  });

  // 어벤던로드 세션 제어
  ipcMain.on('abandoned-reset', () => {
    import('./chatLogProcessor').then(mod => mod.chatLogProcessor.resetAbandoned());
  });

  // 챗로그 감시 재기동
  ipcMain.on('start-chat-log-watch', () => {
    chatLogManager.start();
    broadcastChatLogStatus();
  });

  // 챗로그 경로 유효성 검사 (단순 호환)
  ipcMain.handle('check-chat-log-status', () => {
    const cfg = config.load();
    const chatLogPath = cfg.chatLogPath;
    if (!chatLogPath) return false;
    
    try {
      if (!fs.existsSync(chatLogPath)) return false;
      const stat = fs.statSync(chatLogPath);
      if (!stat.isDirectory()) return false;
      
      const files = fs.readdirSync(chatLogPath);
      const hasChatLog = files.some(file => file.startsWith('TWChatLog_') && file.endsWith('.html'));
      return hasChatLog;
    } catch (e) {
      return false;
    }
  });

  // 챗로그 경로 정밀 유효성 및 파일 검사
  ipcMain.handle('validate-chat-log-path', (_e, customPath?: string) => {
    if (customPath !== undefined && !isLimitedString(customPath, 4_096)) {
      return { valid: false, exists: false, isDirectory: false, fileCount: 0, message: '경로가 너무 깁니다.' };
    }
    const cfg = config.load();
    const targetPath = (customPath && typeof customPath === 'string') ? customPath.trim() : (cfg.chatLogPath || '');
    if (!targetPath) {
      return {
        valid: false,
        exists: false,
        isDirectory: false,
        fileCount: 0,
        message: '로그 폴더 경로가 지정되지 않았습니다.'
      };
    }

    try {
      if (!fs.existsSync(targetPath)) {
        return {
          valid: false,
          exists: false,
          isDirectory: false,
          fileCount: 0,
          message: '지정된 폴더를 찾을 수 없습니다.'
        };
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        return {
          valid: false,
          exists: true,
          isDirectory: false,
          fileCount: 0,
          message: '선택한 경로가 폴더(디렉토리)가 아닙니다.'
        };
      }

      const allFiles = fs.readdirSync(targetPath);
      const logFiles = allFiles.filter(f => f.startsWith('TWChatLog_') && f.endsWith('.html')).sort();

      if (logFiles.length > 0) {
        const latest = logFiles[logFiles.length - 1];
        return {
          valid: true,
          exists: true,
          isDirectory: true,
          fileCount: logFiles.length,
          latestFile: latest,
          message: `테일즈위버 로그 파일이 정상 연동되었습니다. (로그 ${logFiles.length}개 발견)`
        };
      }

      // 사용자가 TalesWeaver 게임 루트 폴더를 선택했을 경우 ChatLog 하위 폴더 자동 감지 및 추천
      const subChatLog = path.join(targetPath, 'ChatLog');
      if (fs.existsSync(subChatLog) && fs.statSync(subChatLog).isDirectory()) {
        const subFiles = fs.readdirSync(subChatLog).filter(f => f.startsWith('TWChatLog_') && f.endsWith('.html'));
        if (subFiles.length > 0) {
          return {
            valid: false,
            exists: true,
            isDirectory: true,
            fileCount: 0,
            suggestedPath: subChatLog,
            message: `하위의 ChatLog 폴더(${subChatLog})를 선택해주세요.`
          };
        }
      }

      return {
        valid: false,
        exists: true,
        isDirectory: true,
        fileCount: 0,
        message: '선택한 폴더에 TWChatLog_*.html 파일이 없습니다.'
      };
    } catch (err) {
      return {
        valid: false,
        exists: false,
        isDirectory: false,
        fileCount: 0,
        message: `폴더 확인 중 오류 발생: ${err}`
      };
    }
  });

  ipcMain.on('request-game-focus', () => {
    setTimeout(() => {
      tracker.focusGameWindow();
    }, FOCUS_RESTORE_DELAY_MS);
  });

  ipcMain.handle('test-discord-webhook', async (_e, webhookUrl: string) => {
    if (!isHttpUrl(webhookUrl, 2_048) || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) return false;
    try {
      await discordNotifier.sendTest(webhookUrl);
      return true;
    } catch (e) {
      console.error('[DISCORD TEST ERROR]', e);
      return false;
    }
  });

  // --- Chat Overlay IPC ---
  ipcMain.handle('chat-get-history', async (_e, category: string) => {
    if (!isLimitedString(category, 100, false)) return [];
    const { chatLogProcessor } = await import('./chatLogProcessor');
    const { chatLogManager } = await import('./chatLogManager');
    chatLogManager.resetLastReadIndex(category);
    return chatLogProcessor.getChatHistory(category);
  });
  ipcMain.handle('today-summary-get', () => {
    const date = getLocalDateKey();
    const cfg = config.load();
    return buildTodaySummary(cfg, diaryDb.getDiaryByDate(date, cfg.lootKeywords || []), date);
  });

  ipcMain.handle('focused-chat-get-history', async () => {
    const { chatLogProcessor } = await import('./chatLogProcessor');
    return chatLogProcessor.getChatHistory('Basic');
  });

  ipcMain.handle('focused-chat-get-state', async () => {
    const { chatLogProcessor } = await import('./chatLogProcessor');
    chatLogProcessor.startFocusedChatSession();
    return chatLogProcessor.getFocusedChatState();
  });

  ipcMain.on('focused-chat-set-self', async (_event, nickname: string) => {
    if (!isLimitedString(nickname, 100)) return;
    const { chatLogProcessor } = await import('./chatLogProcessor');
    chatLogProcessor.setFocusedChatSelfNickname(nickname);
  });

  ipcMain.on('focused-chat-set-targets', async (_event, nicknames: string[]) => {
    if (!isStringArray(nicknames, 100, 100)) return;
    const { chatLogProcessor } = await import('./chatLogProcessor');
    chatLogProcessor.setFocusedChatTargets(nicknames);
  });

  ipcMain.handle('chat-get-more-history', async (_e, category: string) => {
    if (!isLimitedString(category, 100, false)) return [];
    const { chatLogManager } = await import('./chatLogManager');
    return await chatLogManager.getMoreHistory(category);
  });

  ipcMain.handle(
    'chat-search-logs',
    async (_e, query: string, options?: { category?: string; limit?: number }) => {
      if (!isLimitedString(query, 1_000, false)) return [];
      if (options !== undefined && (!options || typeof options !== 'object'
        || (options.category !== undefined && !isLimitedString(options.category, 100, false))
        || (options.limit !== undefined && !isPositiveInteger(options.limit, 10_000)))) return [];
      const { chatLogManager } = await import('./chatLogManager');
      return await chatLogManager.searchChatLogs(query, options);
    }
  );

  ipcMain.on('chat-open-today-log', async () => {
    const { chatLogManager } = await import('./chatLogManager');
    const fs = await import('fs');
    const filePath = chatLogManager.getTodayFilePath();
    if (filePath && fs.existsSync(filePath)) {
      shell.openPath(filePath);
    }
  });

  ipcMain.on('toggle-chat-overlay-sub', (_e, subNum: number) => {
    if (subNum !== 1 && subNum !== 2) return;
    analytics.trackEvent('toggle_chat_overlay_sub', { subNum });
    wm.toggleSubWindow(subNum as 1 | 2);
  });
  ipcMain.handle('chat-fetch-eta-rankings', async () => {
    const { etaCacheManager } = await import('./etaCacheManager');
    return await etaCacheManager.fetchRemoteData(true);
  });
  ipcMain.handle('chat-get-eta-cache-status', async () => {
    const { etaCacheManager } = await import('./etaCacheManager');
    return etaCacheManager.getCacheStatus();
  });

  if (IS_DEV) {
    ipcMain.on('inject-test-chat', (_e, rawLine: string) => {
      if (typeof rawLine !== 'string' || rawLine.length === 0 || rawLine.length > 20_000) return;
      chatParser.parseLine(rawLine);
    });
  }

  // --- Alarm Logs IPC ---
  ipcMain.handle('alarm-get-logs', (_e, limit?: number) => {
    if (limit !== undefined && !isPositiveInteger(limit, 10_000)) return [];
    return diaryDb.getAlarmLogs(limit);
  });
  ipcMain.on('alarm-clear-logs', () => {
    diaryDb.clearAlarmLogs();
  });

  // --- Timer IPC ---
  ipcMain.on('timer-save-record', (_e, record: unknown) => {
    if (!isValidTimerRecord(record)) return;
    diaryDb.addTimerRecord(record);
  });
  ipcMain.handle('timer-get-records', () => {
    return diaryDb.getTimerRecords();
  });
  ipcMain.on('timer-update-title', (_e, id: number, title: string) => {
    if (!isPositiveInteger(id) || !isLimitedString(title, 300)) return;
    diaryDb.updateTimerRecordTitle(id, title);
  });
  ipcMain.on('timer-update-series-core', (
    _e, 
    id: number, 
    series: string, 
    core_master: string, 
    coefficient: number,
    char_main: number,
    char_sub: number,
    base_main: number,
    enchant_main: number,
    base_sub: number,
    enchant_sub: number,
    accuracy: number
  ) => {
    if (!isPositiveInteger(id)
      || !isLimitedString(series, 300)
      || !isLimitedString(core_master, 300)
      || ![coefficient, char_main, char_sub, base_main, enchant_main, base_sub, enchant_sub, accuracy]
        .every(value => isFiniteInRange(value, -1_000_000_000_000, 1_000_000_000_000))) return;
    diaryDb.updateTimerRecordSeriesAndCore(
      id, 
      series, 
      core_master, 
      coefficient,
      char_main,
      char_sub,
      base_main,
      enchant_main,
      base_sub,
      enchant_sub,
      accuracy
    );
  });
  ipcMain.on('timer-delete-record', (_e, id: number) => {
    if (!isPositiveInteger(id)) return;
    diaryDb.deleteTimerRecord(id);
  });
  ipcMain.on('timer-toggle-session', (event, state: 'start' | 'stop') => {
    if (state !== 'start' && state !== 'stop') return;
    broadcastToAllWindowsExcept(event.sender, 'timer-toggle', state);
  });

  // --- Custom Sound IPC ---
  ipcMain.handle('get-config', () => {
    return config.load();
  });

  ipcMain.handle('select-custom-sound', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      title: '알림 사운드 파일 추가',
      filters: [
        { name: '오디오 파일', extensions: ['mp3', 'wav', 'ogg', 'webm', 'm4a'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const srcPath = result.filePaths[0];
    const originalExt = path.extname(srcPath).toLowerCase();
    const allowedExtensions = new Set(['.mp3', '.wav', '.ogg', '.webm', '.m4a']);
    if (!allowedExtensions.has(originalExt)) return null;
    const sourceStat = fs.statSync(srcPath);
    if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > 50 * 1024 * 1024) return null;
    const originalName = path.basename(srcPath, originalExt);
    
    // 파일명 인코딩 안전화 (영어, 숫자, 한글, 언더바, 하이픈만 허용)
    const sanitizedName = originalName.replace(/[^a-zA-Z0-9ㄱ-ㅎㅏ-ㅣ가-힣-_]/g, '');
    const filename = `custom_${Date.now()}_${sanitizedName || 'sound'}${originalExt}`;
    
    const customSoundsDir = path.join(app.getPath('userData'), 'custom_sounds');
    if (!fs.existsSync(customSoundsDir)) {
      fs.mkdirSync(customSoundsDir, { recursive: true });
    }

    const destPath = path.join(customSoundsDir, filename);
    fs.copyFileSync(srcPath, destPath);

    return {
      name: originalName,
      file: filename
    };
  });

  ipcMain.on('sidebar-ready', (event) => {
    import('./updater').then(mod => {
      const info = mod.getCurrentStatus();
      if (info && !event.sender.isDestroyed()) {
        event.sender.send('update-status', info);
      }
    });
  });

  ipcMain.handle('delete-custom-sound', (_e, filename: string) => {
    if (!isLimitedString(filename, 500, false)) return false;
    try {
      const customSoundsDir = path.join(app.getPath('userData'), 'custom_sounds');
      const filePath = resolveSafeChildFile(customSoundsDir, filename);
      if (!filePath) {
        console.warn(`[IPC] Unsafe custom sound filename rejected: ${filename}`);
        return false;
      }
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        // config.customSounds 목록에서도 파일 제거
        const currentCfg = config.load();
        if (Array.isArray(currentCfg.customSounds)) {
          const updatedSounds = currentCfg.customSounds.filter(s => s.file !== filename);
          config.save({ customSounds: updatedSounds });
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[IPC] Failed to delete custom sound: ${err}`);
      return false;
    }
  });
}
