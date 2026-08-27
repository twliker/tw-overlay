import './bootstrap';
import { app, protocol, net, dialog, powerMonitor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import {
  FOCUS_DELAY_MS,
  appState,
  get_RESOURCE_PATH
} from './modules/constants';
import { log } from './modules/logger';
import * as config from './modules/config';

// tw-sound 프로토콜 스키마 등록 (앱 준비 단계 이전 필수 호출)
protocol.registerSchemesAsPrivileged([
  { scheme: 'tw-sound', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } }
]);
import * as tracker from './modules/tracker';
import * as wm from './modules/windowManager';
import * as ipcHandlers from './modules/ipcHandlers';
import * as gallery from './modules/galleryMonitor';
import * as tray from './modules/tray';
import * as bossNotifier from './modules/bossNotifier';
import * as customNotifier from './modules/customNotifier';
import { setupUpdater, getIsUpdaterQuitting } from './modules/updater';
import * as pollingLoop from './modules/pollingLoop';
import { setupAutoStart } from './modules/autoStart';
import * as trade from './modules/tradeMonitor';
import * as sm from './modules/shortcutManager';
import { analytics } from './modules/analytics';
import * as diaryDb from './modules/diaryDb';
import { findChatLogPath } from './modules/chatLogPathFinder';
import { chatLogManager } from './modules/chatLogManager';
import { chatLogProcessor } from './modules/chatLogProcessor';
import * as contentsChecker from './modules/contentsChecker';
import { buffTimerManager } from './modules/buffTimerManager';
import * as scamMonitor from './modules/scamMonitor';
import { etaCacheManager } from './modules/etaCacheManager';
import * as cloudSync from './modules/cloudSyncManager';
import { createShutdownGate, drainShutdownTask } from './modules/shutdownCoordinator';

// ── 에러 트래킹 세팅 ──
process.on('uncaughtException', (error) => {
  log(`[MAIN] Uncaught Exception: ${error.message}\n${error.stack}`);
  analytics.trackError('uncaughtException', error.message);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log(`[MAIN] Unhandled Rejection: ${message}`);
  analytics.trackError('unhandledRejection', message);
});

log(`[BOOT] Application process started at ${new Date().toISOString()}`);
log(`[BOOT] UserData path: ${app.getPath('userData')}`);

app.setAppUserModelId('com.filbertlab.twoverlay');

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-gpu-sandbox');

appState.isQuitting = false;

let sessionEndPrepared = false;
function prepareFastSessionEnd(): void {
  if (sessionEndPrepared) return;
  sessionEndPrepared = true;
  appState.isQuitting = true;
  cloudSync.stopBackgroundSync();
  contentsChecker.cancelPendingDiaryWriteRetries();
  if (config.hasPending()) config.saveImmediate();
  cloudSync.prepareShutdownRecovery();
  if (!diaryDb.flushPendingElso()) {
    log('[SHUTDOWN] Windows 세션 종료 중 엘소 recovery 기록을 유지합니다.');
  }
  if (!diaryDb.flushPendingGoldPouchSeed()) {
    log('[SHUTDOWN] Windows 세션 종료 중 금화 주머니 recovery 기록을 유지합니다.');
  }
  diaryDb.checkpointWal();
}

// Windows 로그오프·시스템 종료는 긴 비동기 대기를 막지 않고 내구 상태만 즉시 기록한다.
app.on('browser-window-created', (_event, window) => {
  window.on('query-session-end', () => prepareFastSessionEnd());
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const mainWin = wm.getMainWindow();
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
}

app.whenReady().then(() => {
  cloudSync.initializeLocalProfileState();
  powerMonitor.on('resume', () => cloudSync.requestImmediatePull('system-resume'));
  powerMonitor.on('unlock-screen', () => cloudSync.requestImmediatePull('screen-unlock'));
  let wasNetworkOnline = net.isOnline();
  setInterval(() => {
    const isNetworkOnline = net.isOnline();
    if (!wasNetworkOnline && isNetworkOnline) cloudSync.requestImmediatePull('network-reconnected');
    wasNetworkOnline = isNetworkOnline;
  }, 10_000);
  if (!gotTheLock) return;

  // 모니터/DPI 변경은 특정 오버레이 사용 여부와 무관하게 앱 수명 동안 한 번만 감시합니다.
  wm.setupDisplayChangeListeners();

  // preload가 시작 시 단일 기본 설정 원본을 동기 조회하므로 창 생성보다 먼저 등록해야 합니다.
  ipcHandlers.register();

  // tw-sound://custom/<file> 또는 tw-sound://default/<file> 형식의 리소스 처리
  protocol.handle('tw-sound', (request) => {
    try {
      const url = new URL(request.url);
      const type = url.host; // 'custom' 또는 'default'
      const filename = path.basename(decodeURIComponent(url.pathname.substring(1)));
      
      let filePath = '';
      if (type === 'custom') {
        filePath = path.join(app.getPath('userData'), 'custom_sounds', filename);
        // 다른 PC로 설정을 가져오는 등으로 물리 파일이 부재 시 기본음(orb.mp3)으로 폴백
        if (!fs.existsSync(filePath)) {
          log(`[PROTOCOL] 커스텀 사운드 파일이 존재하지 않음: ${filename}. 기본 알림음(orb.mp3)으로 대체합니다.`);
          filePath = get_RESOURCE_PATH('assets', 'sound', 'orb.mp3');
        }
      } else {
        filePath = get_RESOURCE_PATH('assets', 'sound', filename);
        if (!fs.existsSync(filePath)) {
          filePath = get_RESOURCE_PATH('assets', 'sound', 'orb.mp3');
        }
      }
      
      return net.fetch(pathToFileURL(filePath).href);
    } catch (err) {
      log(`[PROTOCOL] tw-sound 프로토콜 핸들링 중 에러 발생: ${err}`);
      try {
        const fallbackPath = get_RESOURCE_PATH('assets', 'sound', 'orb.mp3');
        return net.fetch(pathToFileURL(fallbackPath).href);
      } catch (fallbackErr) {
        return new Response('Not Found', { status: 404 });
      }
    }
  });

  // 스플래시 창 생성
  wm.createSplashWindow();

  // 기본 리소스 준비
  tray.createTray();
  diaryDb.initDb();

  let isAppLaunched = false;
  function launchMainApp() {
    if (isAppLaunched) return;
    isAppLaunched = true;

    log('[APP] Launching main application components...');

    const sidebar = wm.createMainWindow();

    const configWarning = config.consumeLoadWarning();
    if (configWarning) {
      void dialog.showMessageBox(sidebar, {
        type: 'warning',
        title: '설정 복구 안내',
        message: configWarning,
        buttons: ['확인'],
      });
    }

    try {
      const cfg = config.load();
      const keepDays = cfg.diaryKeepDays !== undefined ? cfg.diaryKeepDays : 180;
      if (keepDays > 0) {
        analytics.trackEvent('diary_data_cleanup', { keepDays, trigger: 'boot' });
        diaryDb.cleanOldDiaryData(keepDays);
      }
    } catch (err) {
      log(`[BOOT] 모험 일지 Cleanup 실행 실패: ${err}`);
    }

    // 24시간마다 오래된 모험 일지 데이터 자동 정리
    setInterval(() => {
      try {
        const cfg = config.load();
        const keepDays = cfg.diaryKeepDays !== undefined ? cfg.diaryKeepDays : 180;
        if (keepDays > 0) {
          analytics.trackEvent('diary_data_cleanup', { keepDays, trigger: 'interval_timer' });
          diaryDb.cleanOldDiaryData(keepDays);
        }
      } catch (err) {
        log(`[TIMER] 모험 일지 Cleanup 주기적 실행 실패: ${err}`);
      }
    }, 24 * 60 * 60 * 1000);

    analytics.trackEvent('app_open');
    tracker.start();
    type ForegroundOwner = 'game' | 'app' | 'external';
    let previousForegroundOwner: ForegroundOwner | null = null;
    tracker.setForegroundChangeListener((isGameFocused, focusedHwndStr) => {
      const electronHwnds = wm.getAllWindowHwnds();
      const isAppFocused = electronHwnds.includes(focusedHwndStr);
      const foregroundOwner: ForegroundOwner = isGameFocused
        ? 'game'
        : isAppFocused
          ? 'app'
          : 'external';
      const shouldActivateGameGroup = previousForegroundOwner === 'external'
        && foregroundOwner === 'app';
      previousForegroundOwner = foregroundOwner;

      // 작업표시줄/Alt+Tab으로 우리 창을 명시적으로 선택한 경우에만 게임을 함께 올린다.
      // 외부 앱이 계속 foreground인 자동 폴링·창 생성 경로에서는 절대 실행하지 않는다.
      if (shouldActivateGameGroup) {
        setImmediate(() => wm.activateGameBehindAppWindow(focusedHwndStr));
      }
      sm.updateFocusState(isGameFocused || isAppFocused);
      const isExternalFocused = !isGameFocused && !isAppFocused;
      const gameHwnd = tracker.getGameHwnd();
      // 외부 프로그램 전환은 드래그 상태와 무관하게 즉시 강등해야 한다.
      // 게임/TW-Overlay 내부 재정렬만 사용자 드래그 중에는 건너뛴다.
      if (gameHwnd && electronHwnds.length > 0 && (isExternalFocused || !wm.isAnyUserDragging())) {
        tracker.reconcileGameZOrder(gameHwnd, electronHwnds);
      }
    });

    pollingLoop.start();
    bossNotifier.start();
    customNotifier.start();

    const currentAppConfig = config.load();

    // 채팅 로그 경로 자동 탐색 및 설정 (비어있을 경우에만)
    if (!currentAppConfig.chatLogPath) {
      const foundPath = findChatLogPath();
      if (foundPath) {
        config.save({ chatLogPath: foundPath });
        log(`[CHAT_LOG] 로그 경로 자동 설정 완료: ${foundPath}`);
      }
    }

    if (currentAppConfig.overlayVisible !== false) wm.setOverlayVisible(true);

    if (currentAppConfig.autoLaunch !== undefined) {
      setupAutoStart(currentAppConfig.autoLaunch);
    }

    gallery.start(null, sidebar);
    trade.start(sidebar);

    // 에타 캐시 먼저 초기화 (로컬 캐시 로드) → chatLogManager replay 시 에타 레벨 표시 가능
    etaCacheManager.init();

    // 기본 숙제 병합·레거시 마이그레이션을 채팅 자동 감지보다 먼저 한 번 완료한다.
    if (!contentsChecker.init()) {
      log('[BOOT] 숙제 체크리스트 초기화 실패 — 기존 설정을 보존한 채 자동 감지를 계속합니다.');
    }

    // 채팅 로그 감시 시스템 시작
    chatLogProcessor.start();
    chatLogManager.start();
    buffTimerManager.start();

    // 사기꾼 탐지 모니터 (활성화된 경우에만)
    if (config.load().scamDetectorEnabled) {
      scamMonitor.start();
    }

    wm.onOverlayWindowReady(() => {
      gallery.updateWindows(wm.getOverlayWindow(), wm.getMainWindow(), wm.getGalleryWindow());
      trade.updateWindows(wm.getMainWindow(), wm.getTradeWindow());
    });

    // 구글 드라이브 자동 동기화 (로그인 상태일 때 백그라운드 다운로드)
    const syncStatus = cloudSync.getSyncStatus();
    if (syncStatus.isLinked && syncStatus.autoSync !== false && config.load().googleSyncEnabled === true) {
      cloudSync.startBackgroundSync();
      cloudSync.syncFromCloud(false).catch((err) => {
        log(`[BOOT] 구글 드라이브 시작 동기화 실패: ${err}`);
      });
    }

    // 스플래시 창 닫기 (웰컴 가이드 / 공지 창 연동)
    wm.closeSplashWindow();
  }

  // 스플래시 화면에서 업데이트 확인 및 자동 업데이트 진행
  setupUpdater(launchMainApp);
});

const shutdownGate = createShutdownGate();

app.on('before-quit', (event) => {
  const decision = shutdownGate.requestQuit();
  if (decision === 'allow') return;
  event.preventDefault();
  if (decision === 'wait') return;

  appState.isQuitting = true;
  cloudSync.stopBackgroundSync();
  contentsChecker.cancelPendingDiaryWriteRetries();
  chatLogManager.stop();
  pollingLoop.stop();
  bossNotifier.stop();
  customNotifier.stop();
  gallery.stop();
  trade.stop();
  wm.hideAllForShutdown();
  tray.destroyTray();
  tracker.stop();
  buffTimerManager.stop();
  scamMonitor.stop();

  if (config.hasPending()) config.saveImmediate();
  if (!diaryDb.flushPendingElso()) {
    log('[SHUTDOWN] 엘소 DB flush 실패 — 디스크 복구 기록을 다음 실행에 재생합니다.');
  }
  if (!diaryDb.flushPendingGoldPouchSeed()) {
    log('[SHUTDOWN] 금화 주머니 DB flush 실패 — 디스크 복구 기록을 다음 실행에 재생합니다.');
  }
  cloudSync.prepareShutdownRecovery();

  const isUpdating = getIsUpdaterQuitting();
  const flushTimeoutMs = isUpdating ? 500 : 3000;

  // 창은 이미 숨긴 상태에서 클라우드 큐를 제한 시간만 drain하고, 시간초과 시 요청을 취소한다.
  void (async () => {
    const outcome = await drainShutdownTask(cloudSync.flushPendingSync(), flushTimeoutMs);
    if (outcome !== 'flushed') {
      log(`[SHUTDOWN] 클라우드 flush ${outcome}, 진행 요청을 취소하고 다음 실행에서 재확인합니다.`);
      cloudSync.cancelPendingShutdownRequests();
    }
    try {
      diaryDb.checkpointWal();
      if (!diaryDb.closeDb()) {
        log('[SHUTDOWN] 엘소 flush 미완료 상태로 DB를 닫았습니다. 복구 기록은 유지됩니다.');
      }
    } catch (err) {
      log(`[SHUTDOWN] DB close error: ${err}`);
    }
    shutdownGate.allowFinalQuit();
    app.quit();
  })();
});

app.on('window-all-closed', () => app.quit());
