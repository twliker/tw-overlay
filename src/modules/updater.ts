/**
 * 업데이트 관리 모듈 - 필수 업데이트(Mandatory Update) 지원
 */
import { autoUpdater } from 'electron-updater';
import { BrowserWindow, app, Notification } from 'electron';
import { log } from './logger';
import * as config from './config';
import * as path from 'path';

let isSetup = false;
let isMandatory = false;

import type { UpdateStatusInfo } from '../shared/types';

let currentUpdateInfo: UpdateStatusInfo | null = null;

/** 릴리즈 노트에서 [Mandatory Update] 태그 확인 */
function checkMandatory(info: any): boolean {
  const tag = '[Mandatory Update]';
  // releaseName (릴리즈 제목) 확인
  if (typeof info.releaseName === 'string' && info.releaseName.includes(tag)) {
    return true;
  }
  // releaseNotes가 문자열인 경우 (단일 릴리즈 노트)
  if (typeof info.releaseNotes === 'string' && info.releaseNotes.includes(tag)) {
    return true;
  }
  // releaseNotes가 배열인 경우 (다중 릴리즈 노트 형식)
  if (Array.isArray(info.releaseNotes)) {
    return info.releaseNotes.some((n: any) => (n.note || '').includes(tag));
  }
  return false;
}

/** 모든 관련 창에 업데이트 상태 전송 */
function broadcastStatus(data: UpdateStatusInfo) {
  currentUpdateInfo = data;
  import('./windowManager').then(wm => {
    const mainWin = wm.getMainWindow();
    const settingsWin = wm.getSettingsWindow();
    const splashWin = wm.getSplashWindow();

    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('update-status', data);
    }
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('update-status', data);
    }
    // 스플래시 창에도 전송 (필수 업데이트 진행 UI 용)
    if (splashWin && !splashWin.isDestroyed()) {
      splashWin.webContents.send('update-status', data);
    }
  });
}

export function setupUpdater(onReadyToLaunch?: () => void) {
  if (isSetup) {
    if (currentUpdateInfo) {
      import('./windowManager').then(wm => {
        const mainWin = wm.getMainWindow();
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('update-status', currentUpdateInfo);
        }
      });
    }
    return;
  }
  isSetup = true;

  let notifyReady = () => {
    if (onReadyToLaunch) {
      const fn = onReadyToLaunch;
      onReadyToLaunch = undefined;
      fn();
    }
  };

  if (!app.isPackaged) {
    log('Development mode: skipping update check');
    setTimeout(() => {
      notifyReady();
    }, 1200);
    return;
  }

  autoUpdater.autoDownload = false;

  let updateCheckTimeout: NodeJS.Timeout | null = setTimeout(() => {
    log('[UPDATER] Update check timeout (5s). Launching main app.');
    notifyReady();
  }, 5000);

  function clearTimer() {
    if (updateCheckTimeout) {
      clearTimeout(updateCheckTimeout);
      updateCheckTimeout = null;
    }
  }

  autoUpdater.on('checking-for-update', () => {
    broadcastStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    clearTimer();
    log(`Update available: ${info.version}`);
    isMandatory = checkMandatory(info);

    const cfg = config.load();
    const isAutoUpdateEnabled = cfg.autoUpdateEnabled !== false;

    // CASE 1: 필수 업데이트 또는 자동 업데이트 활성화 상태 -> 스플래시 창에서 다운로드 진행 및 자동 설치
    if (isMandatory || isAutoUpdateEnabled) {
      log(`[AUTO_UPDATE] Starting download on splash for v${info.version} (mandatory=${isMandatory}, autoUpdate=${isAutoUpdateEnabled})`);

      // 스플래시 창 유지 및 잠금
      import('./windowManager').then(wm => wm.setMandatoryUpdateLock(true));

      broadcastStatus({
        state: isMandatory ? 'mandatory' : 'available',
        version: info.version,
        isMandatory,
        releaseNotes: info.releaseNotes?.toString()
      });

      autoUpdater.downloadUpdate();
      return;
    }

    // CASE 2: 자동 업데이트 비활성화 상태 -> 스플래시 닫고 메인 앱 기동, 사이드바/설정에 레드닷만 표시
    log(`[AUTO_UPDATE] Auto update disabled. Launching main app and displaying update badge for v${info.version}`);

    currentUpdateInfo = {
      state: 'available',
      version: info.version,
      isMandatory: false,
      releaseNotes: info.releaseNotes?.toString()
    };

    // 메인 앱 기동 (스플래시 창 닫힘)
    notifyReady();

    // 메인 앱 기동 후 상태 브로드캐스트 (사이드바 레드닷)
    const sendUpdateBadge = () => {
      broadcastStatus({
        state: 'available',
        version: info.version,
        isMandatory: false,
        releaseNotes: info.releaseNotes?.toString()
      });
    };
    setTimeout(sendUpdateBadge, 600);
    setTimeout(sendUpdateBadge, 1500);

    // 네이티브 알림 표시
    try {
      const notification = new Notification({
        title: 'TW-Overlay 업데이트 알림',
        body: `새로운 버전 v${info.version}이(가) 출시되었습니다.`,
        icon: path.join(__dirname, '..', 'icons', 'icon.ico')
      });
      notification.show();
      notification.on('click', () => {
        import('./windowManager').then(wm => wm.toggleSettingsWindow());
      });
    } catch (e) {
      log(`Notification error: ${e}`);
    }
  });

  autoUpdater.on('update-not-available', () => {
    clearTimer();
    log('[UPDATER] Update not available. Current version is latest.');
    broadcastStatus({ state: 'latest' });
    setTimeout(() => {
      notifyReady();
    }, 600);
  });

  autoUpdater.on('error', (err) => {
    clearTimer();
    log(`Error in auto-updater: ${err}`);
    broadcastStatus({ state: 'error', message: err.message });

    if (isMandatory) {
      import('./windowManager').then(wm => wm.setMandatoryUpdateLock(false));
      isMandatory = false;
    }
    setTimeout(() => {
      notifyReady();
    }, 600);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    broadcastStatus({
      state: 'downloading',
      percent: Math.round(progressObj.percent),
      isMandatory
    });

    import('./windowManager').then(wm => {
      wm.getMainWindow()?.setProgressBar(progressObj.percent / 100);
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log(`Update downloaded: v${info.version} (isMandatory=${isMandatory})`);
    broadcastStatus({
      state: 'ready',
      version: info.version,
      isMandatory,
      releaseNotes: info.releaseNotes?.toString()
    });
    import('./windowManager').then(wm => {
      wm.getMainWindow()?.setProgressBar(-1);
    });

    // 다운로드 완료 시 자동 설치 및 재시작
    log('[UPDATER] Download complete. Installing and restarting in 1.5s...');
    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 1500);
  });

  // 초기 체크 실행
  log('Starting auto update check on splash...');
  autoUpdater.checkForUpdates();
}

/** 현재 업데이트 상태 반환 */
export function getCurrentStatus() {
  return currentUpdateInfo;
}

/** 수동 업데이트 확인 */
export async function manualCheckForUpdate(mainWindow: BrowserWindow | null) {
  if (!app.isPackaged) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { state: 'dev-mode' });
    }
    return;
  }

  try {
    broadcastStatus({ state: 'checking' });
    await autoUpdater.checkForUpdates();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Manual update check error: ${msg}`);
    broadcastStatus({ state: 'error', message: msg });
  }
}

/** 업데이트 다운로드 시작 */
export function startDownload() {
  log('Starting update download...');
  autoUpdater.downloadUpdate();
}

/** 재시작 및 설치 */
export function quitAndInstall() {
  autoUpdater.quitAndInstall();
}
