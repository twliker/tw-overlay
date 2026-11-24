import * as bootstrap from './bootstrap';
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
import { attachRendererHealthGuard } from './modules/rendererHealthGuard';
import * as ipcHandlers from './modules/ipcHandlers';
import * as gallery from './modules/galleryMonitor';
import * as tray from './modules/tray';
import * as bossNotifier from './modules/bossNotifier';
import * as customNotifier from './modules/customNotifier';
import { setupUpdater, getIsUpdaterQuitting, setUpdateRestartConfirmation, canCheckUpdateAfterStartupFailure, checkUpdateAfterStartupFailure } from './modules/updater';
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
import * as backupManager from './modules/backupManager';
import { createShutdownGate, drainShutdownTask } from './modules/shutdownCoordinator';
import {startProfileApplication,checkpointProfileApplication,stopProfileApplication,refreshProfileClock} from './modules/profileApplication';
import {stopHistoricalChatLogSync} from './modules/chatLogSyncManager';
import {confirmProfileEditorsShutdown,releaseProfileEditorsAfterCancelledExit} from './modules/profileEditorWindows';
import type {ExitPurpose} from './modules/exitConfirmationText';

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

function runShutdownStep(name:string,work:()=>void):void {
  try {work();}
  catch (error) {log(`[SHUTDOWN] ${name} 실패: ${String(error)}`);}
}

const stopChatLogForShutdown=(drainPaused=true)=>runShutdownStep('채팅 로그 감시 종료',()=>chatLogManager.stop(true,drainPaused));
const persistProfileForShutdown=()=>runShutdownStep('프로필 저장 종료',stopProfileApplication);

/** 내구 상태만 디스크에 확정한다. 실행 중인 감시·타이머·기록은 멈추지 않으므로 반복 호출해도 안전하다. */
function persistDurableStateForSessionEnd(): void {
  runShutdownStep('프로필 실행 상태 저장',()=>checkpointProfileApplication());
  runShutdownStep('설정 저장',()=>{if (config.hasPending()) config.saveImmediate();});
  runShutdownStep('클라우드 변경 보존',()=>cloudSync.prepareShutdownRecovery());
  savePendingDiaryForShutdown();
  runShutdownStep('모험일지 DB 체크포인트',()=>diaryDb.checkpointWal());
}

/** Windows 로그오프·시스템 종료 계약.
 * - query-session-end(WM_QUERYENDSESSION)는 Windows나 다른 앱이 취소할 수 있고, 취소 통지는 오지 않는다.
 *   따라서 이 단계는 되돌릴 필요가 없는 저장(프로필 checkpoint·설정·클라우드 복구 표식·일지 대기분·WAL)만
 *   하고, 종료 플래그·채팅 로그 감시·프로필 시계/숙제 리셋·백그라운드 동기화는 그대로 둔다.
 *   취소된 뒤 앱을 계속 쓰다가 다시 로그오프해도 같은 저장을 다시 수행한다(창마다 오는 같은 질의는 짧게 합친다).
 * - session-end(WM_ENDSESSION, 실제 종료 확정)에서만 되돌릴 수 없는 정지를 한 번 수행한다.
 *   이 이벤트 뒤에는 Windows가 언제든 프로세스를 끝낼 수 있어 비동기 대기 없이 동기 저장만 한다.
 * - 어느 단계도 종료를 막지 않는다(preventDefault 금지).
 * 회귀: check-refactor-regressions.ts(runtime-main-quit-recovery-probe 'session-end'). */
const SESSION_QUERY_COALESCE_MS = 1000;
let lastSessionQueryAt = -Infinity;
let sessionEnded = false;
function persistForSessionEndQuery(): void {
  if (sessionEnded) return;
  const now = Date.now();
  if (now - lastSessionQueryAt < SESSION_QUERY_COALESCE_MS) return;
  lastSessionQueryAt = now;
  persistDurableStateForSessionEnd();
}

function stopForSessionEnd(): void {
  if (sessionEnded) return;
  sessionEnded = true;
  appState.isQuitting = true;
  runShutdownStep('백그라운드 동기화 종료',()=>cloudSync.stopBackgroundSync());
  runShutdownStep('일지 재시도 중지',()=>contentsChecker.cancelPendingDiaryWriteRetries());
  void stopHistoricalChatLogSync().catch(error=>log(`[SHUTDOWN] 과거 로그 작업 종료 실패: ${String(error)}`));
  stopChatLogForShutdown(false);
  persistProfileForShutdown();
  persistDurableStateForSessionEnd();
}

app.on('browser-window-created', (_event, window) => {
  attachRendererHealthGuard(window,()=>wm.restoreWindowAfterRendererRecovery(window));
  window.on('query-session-end', () => persistForSessionEndQuery());
  window.on('session-end', () => stopForSessionEnd());
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

let startupWindowsCreated = false;
app.whenReady().then(async () => {
  if (!gotTheLock) return;
  const bootstrapError = bootstrap.getFatalBootstrapError();
  if (bootstrapError) {
    dialog.showErrorBox(
      '안전 스냅샷 생성 실패',
      `${bootstrapError}\n\n데이터 변경을 막기 위해 실행을 중단합니다. 디스크 공간과 폴더 권한을 확인한 뒤 다시 실행해 주세요.`,
    );
    app.quit();
    return;
  }
  if (!backupManager.recoverInterruptedRestore()) {
    dialog.showErrorBox(
      '데이터 복원 복구 실패',
      '이전 데이터 복원이 중단되었고 자동 롤백에도 실패했습니다. backups 폴더의 복원 전 스냅샷을 확인해 주세요.',
    );
    app.quit();
    return;
  }
  try {
    const { restoreRendererStorageOnStartup } = await import('./modules/rendererStorageBackup');
    await restoreRendererStorageOnStartup();
  } catch (error) {
    dialog.showErrorBox('도구 데이터 복원 실패', String(error));
    app.quit();
    return;
  }
  if (!scamMonitor.recoverInterruptedServerInstall()) {
    log('[BOOT] 중단된 AI 바이너리 설치를 복구하지 못했습니다. AI 기능은 재설치 전까지 시작하지 않습니다.');
  }
  powerMonitor.on('resume',()=>refreshProfileClock(true));
  powerMonitor.on('unlock-screen',()=>refreshProfileClock());
  powerMonitor.on('resume',()=>cloudSync.requestImmediatePull('resume'));
  powerMonitor.on('unlock-screen',()=>cloudSync.requestImmediatePull('unlock'));
  let wasOnline=net.isOnline();
  const networkTimer=setInterval(()=>{
    const online=net.isOnline();
    if (!wasOnline && online) cloudSync.onNetworkReconnected();
    wasOnline=online;
  },10_000);
  networkTimer.unref();
  app.once('will-quit',()=>clearInterval(networkTimer));

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
  startupWindowsCreated = true;

  try {await startProfileApplication(()=>wm.openProfilesWindow('game-resync'),undefined,tracker.isGameProcessCurrent);}
  catch (error) {
    log(`[BOOT] 프로필 준비 실패: ${String(error)}`);
    await handleProfileStartupFailure(error);
    return;
  }

  // 기본 리소스 준비
  tray.createTray();
  diaryDb.initDb(); // 준비된 app-data.db의 공유 연결만 사용한다.

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
        title: '일부 설정을 별도 보관했습니다',
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

    if (process.windowsStore || currentAppConfig.autoLaunch !== undefined) {
      setupAutoStart(currentAppConfig.autoLaunch === true);
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
    buffTimerManager.start();
    chatLogManager.start();

    // 사기꾼 탐지 모니터 (활성화된 경우에만)
    if (config.load().scamDetectorEnabled) {
      scamMonitor.start();
    }

    wm.onOverlayWindowReady(() => {
      gallery.updateWindows(wm.getOverlayWindow(), wm.getMainWindow(), wm.getGalleryWindow());
      trade.updateWindows(wm.getMainWindow(), wm.getTradeWindow());
    });

    // 구형 전송은 중지한 채 새 프로필 전용 스케줄러만 시작한다.
    cloudSync.startBackgroundSync();

    // 스플래시 창 닫기 (웰컴 가이드 / 공지 창 연동)
    wm.closeSplashWindow();
  }

  // 스플래시 화면에서 업데이트 확인 및 자동 업데이트 진행
  setupUpdater(launchMainApp);
});

/** 프로필 데이터 준비 실패 계약.
 * - 메인 창·트레이·감시를 시작하지 않고(데이터를 더 바꾸지 않고) 종료한다. 원본과 backups 폴더는 보존된다.
 * - 데이터 이전 결함이라면 고친 새 버전을 받아야만 다시 실행할 수 있으므로, 앱이 업데이트를 받을 수 있는
 *   설치본이면 종료하기 전에 새 버전을 확인할지 묻는다. [새 버전 확인]이면 스플래시에서 확인해 새 버전을
 *   받아 설치·재시작하고, 없거나 실패하면 종료한다. Store 설치본(Store가 갱신)·개발 실행은 묻지 않고 종료한다.
 * - 항상 위인 시작 스플래시가 대화상자를 가리지 않게 양보시킨 뒤 묻는다.
 * - 곧 종료하므로 최초 실행 가이드·업데이트 공지 같은 후속 창은 열지 않는다.
 * 회귀: check-updater-network.ts(시작 실패 뒤 업데이트 확인), check-window-visibility.ts(후속 창 생략). */
async function handleProfileStartupFailure(error: unknown): Promise<void> {
  const title = '프로필 데이터 준비 실패';
  const reason = `${String(error)}\n\n원본과 backups 폴더는 보존됩니다.`;
  const quitWithoutFollowUp = () => { wm.closeSplashWindow({showFollowUpWindows:false});app.quit(); };
  if (!canCheckUpdateAfterStartupFailure()) {
    await wm.whileSplashYieldsToPrompt(async () => dialog.showErrorBox(title,
      `${reason} 앱을 종료한 뒤 저장 공간과 폴더 권한을 확인해 주세요.`));
    quitWithoutFollowUp();
    return;
  }
  const answer = await wm.whileSplashYieldsToPrompt(() => dialog.showMessageBox({
    type: 'error', title, noLink: true,
    message: '프로필 데이터를 준비하지 못해 앱을 시작할 수 없습니다.',
    detail: `${reason}\n\n이 문제를 고친 새 버전이 나왔을 수 있습니다. [새 버전 확인]을 누르면 업데이트를 확인해, `
      + '새 버전이 있으면 받아서 설치한 뒤 다시 시작하고 없으면 앱을 종료합니다.\n'
      + '새 버전으로도 계속 실패하면 저장 공간과 폴더 권한을 확인해 주세요.',
    buttons: ['새 버전 확인', '종료'], defaultId: 0, cancelId: 1,
  })).catch(dialogError => {
    log(`[BOOT] 프로필 준비 실패 안내를 표시하지 못했습니다: ${String(dialogError)}`);
    return null;
  });
  if (answer?.response !== 0) { quitWithoutFollowUp(); return; }
  log('[BOOT] 프로필 준비 실패 뒤 새 버전을 확인합니다.');
  checkUpdateAfterStartupFailure(() => {
    log('[BOOT] 새 버전을 설치하지 않고 앱을 종료합니다.');
    quitWithoutFollowUp();
  });
}

const shutdownGate = createShutdownGate();

function savePendingDiaryForShutdown():void {
  runShutdownStep('엘소 기록 저장',()=>{
    if (!diaryDb.flushPendingElso()) log('[SHUTDOWN] 엘소 DB flush 실패 — 디스크 복구 기록을 다음 실행에 재생합니다.');
  });
  runShutdownStep('금화 주머니 기록 저장',()=>{
    if (!diaryDb.flushPendingGoldPouchSeed()) log('[SHUTDOWN] 금화 주머니 DB flush 실패 — 디스크 복구 기록을 다음 실행에 재생합니다.');
  });
}

/** 일반 종료와 업데이트 재시작이 공유하는 초안 확인.
 * 초안이 있는 모든 편집 창(환경 설정·고정 메모·숙제 등)과 프로필 관리 창을 확인한다.
 * 같은 목적의 확인이 진행 중이면 새 대화상자를 겹쳐 띄우지 않고 그 결과를 함께 사용한다.
 * 목적이 다르면 결과를 공유하지 않는다(종료 확인의 "계속 사용"이 필수 업데이트 승인으로 바뀌지 않게).
 * 앞선 확인이 끝나기를 기다렸다가, 그 사이 종료가 시작됐으면 묻지 않고 종료 쪽 결과를 따른다.
 * 대화상자 표시 실패 등 예외는 종료 게이트가 'wait'에 갇히지 않도록 여기서 기록하고 결과로 바꾼다:
 * 일반 종료·업데이트는 취소(입력 보존), 필수 업데이트는 진행한다.
 * 확인하는 동안 항상 위인 스플래시(업데이트 잠금 포함)를 내려 대화상자·편집 창이 가려지지 않게 한다.
 * 회귀: check-refactor-regressions.ts(runtime-main-quit-recovery-probe 'confirm-failure'),
 * check-audit-regressions.ts(checkExitConfirmation), check-updater-network.ts, check-profile-windows.ts,
 * check-window-visibility.ts(스플래시 양보). */
let exitConfirmation: {purpose: ExitPurpose; promise: Promise<boolean>} | null = null;
function confirmUnsavedWorkBeforeExit(purpose: ExitPurpose): Promise<boolean> {
  const inFlight = exitConfirmation;
  if (inFlight?.purpose === purpose) return inFlight.promise;
  const confirmation = (async () => {
    if (inFlight) {
      await inFlight.promise.catch(() => false);
      // 앞선 확인으로 종료(일반 종료 또는 업데이트 재시작)가 승인됐다면 다시 묻지 않는다.
      // 일반 종료 요청은 그 종료를 따르고, 업데이트 요청은 updater가 'app-quitting'으로 물러난다.
      if (appState.isQuitting || getIsUpdaterQuitting()) return purpose === 'quit';
    }
    try {
      // 업데이트 잠금·시작 스플래시는 항상 위라서 확인 대화상자와 저장하라고 보여 준 편집 창을 가린다.
      // 모든 확인 경로가 이 진입점을 지나므로 여기서 한 번 스플래시를 내려 두고, 끝나면 잠금 상태를 되돌린다.
      return await wm.whileSplashYieldsToPrompt(
        () => confirmProfileEditorsShutdown(() => wm.confirmProfileWindowShutdown(purpose), purpose));
    } catch (error) {
      log(`[SHUTDOWN] 저장하지 않은 입력을 확인하지 못했습니다 (${purpose}): ${error instanceof Error ? error.stack || error.message : String(error)}`);
      return purpose === 'mandatory-update';
    }
  })();
  const entry = {purpose, promise: confirmation};
  exitConfirmation = entry;
  void confirmation.finally(() => { if (exitConfirmation === entry) exitConfirmation = null; });
  return confirmation;
}

setUpdateRestartConfirmation({
  confirm: purpose => confirmUnsavedWorkBeforeExit(purpose),
  release: async () => {
    await Promise.allSettled([releaseProfileEditorsAfterCancelledExit(), wm.releaseProfileWindowAfterCancelledExit()]);
  },
});

app.on('before-quit', (event) => {
  const decision = shutdownGate.requestQuit();
  if (decision === 'allow') return;
  event.preventDefault();
  if (decision === 'wait') return;
  void finishQuitRequest().catch(error => {
    // 확인 전 단계의 예외는 종료를 취소해 다음 종료 요청이 다시 시작되게 하고,
    // 승인 뒤의 예외는 저장 단계를 건너뛰더라도 종료를 마친다.
    log(`[SHUTDOWN] 종료 처리 실패: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    if (!appState.isQuitting) { shutdownGate.cancelQuit(); return; }
    shutdownGate.allowFinalQuit();
    app.quit();
  });
});

async function finishQuitRequest():Promise<void> {
  // 업데이트 재시작은 updater가 설치 전에 같은 확인을 이미 받았다.
  if (!getIsUpdaterQuitting() && !await confirmUnsavedWorkBeforeExit('quit')) {
    shutdownGate.cancelQuit();
    return;
  }
  appState.isQuitting = true;
  runShutdownStep('백그라운드 동기화 종료',()=>cloudSync.stopBackgroundSync());
  runShutdownStep('일지 재시도 중지',()=>contentsChecker.cancelPendingDiaryWriteRetries());
  const historicalShutdown=stopHistoricalChatLogSync();
  stopChatLogForShutdown();
  persistProfileForShutdown();
  runShutdownStep('게임 감지 종료',()=>pollingLoop.stop());
  runShutdownStep('보스 알림 종료',()=>bossNotifier.stop());
  runShutdownStep('지정 알림 종료',()=>customNotifier.stop());
  runShutdownStep('갤러리 감시 종료',()=>gallery.stop());
  runShutdownStep('거래 감시 종료',()=>trade.stop());
  runShutdownStep('앱 창 숨기기',()=>wm.hideAllForShutdown());
  runShutdownStep('트레이 종료',()=>tray.destroyTray());
  runShutdownStep('게임 창 감시 종료',()=>tracker.stop());
  runShutdownStep('사기 감시 종료',()=>scamMonitor.stop());

  runShutdownStep('설정 저장',()=>{if (config.hasPending()) config.saveImmediate();});
  savePendingDiaryForShutdown();
  runShutdownStep('클라우드 변경 보존',()=>cloudSync.prepareShutdownRecovery());

  const isUpdating = getIsUpdaterQuitting();
  const flushTimeoutMs = isUpdating ? 500 : 3000;

  // 창은 이미 숨긴 상태에서 클라우드 큐를 제한 시간만 drain하고, 시간초과 시 요청을 취소한다.
  void (async () => {
    try {
      await drainShutdownTask(historicalShutdown,flushTimeoutMs);
      // 과거 로그 작업의 마지막 반영까지 저장한 뒤 활성 버프를 비운다.
      checkpointProfileApplication();
      config.flushPending();
      const outcome = await drainShutdownTask(cloudSync.flushPendingSync(), flushTimeoutMs);
      if (outcome !== 'flushed') {
        log(`[SHUTDOWN] 클라우드 flush ${outcome}, 진행 요청을 취소하고 다음 실행에서 재확인합니다.`);
        cloudSync.cancelPendingShutdownRequests();
      }
    } catch (error) {
      log(`[SHUTDOWN] 종료 중 저장 실패: ${String(error)}`);
    } finally {
      runShutdownStep('버프 타이머 종료',()=>buffTimerManager.stop());
      runShutdownStep('모험일지 DB 체크포인트',()=>diaryDb.checkpointWal());
      runShutdownStep('설정 쓰기 차단',()=>config.beginExternalRestore());
      runShutdownStep('모험일지 DB 닫기',()=>diaryDb.suspendForRestore());
      shutdownGate.allowFinalQuit();
      app.quit();
    }
  })();
}

// 시작 전 저장소 복원용 숨김 창을 닫는 것은 앱 종료 요청이 아니다.
app.on('window-all-closed', () => { if (startupWindowsCreated) app.quit(); });
