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
let isFeedSwitched = false;

import type { UpdateStatusInfo } from '../shared/types';

let currentUpdateInfo: UpdateStatusInfo | null = null;

/** 릴리즈 노트 및 텍스트에서 [Mandatory Update] 태그 확인 (대소문자/공백 무시) */
export function hasMandatoryTag(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return /\[\s*mandatory\s+update\s*\]/i.test(text);
}

/** 릴리즈 정보에서 특정 릴리즈 항목의 태그 확인 */
function isReleaseMandatory(item: any): boolean {
  if (!item) return false;
  if (typeof item === 'string') return hasMandatoryTag(item);
  if (typeof item === 'object') {
    return hasMandatoryTag(item.note) || hasMandatoryTag(item.title) || hasMandatoryTag(item.name) || hasMandatoryTag(item.releaseName);
  }
  return false;
}

export interface MandatoryReleaseTarget {
  version: string;
  tag: string;
  note?: string;
}

/** 
 * 현재 버전보다 상위 버전 목록 중 가장 최신의 강제 업데이트 릴리즈를 탐색
 * (v1 사용자 환경에서 v2강제, v3강제, v4일반, v5강제, v6일반인 경우 -> v5 반환)
 */
export function findLatestMandatoryRelease(info: any, currentVersion?: string): MandatoryReleaseTarget | null {
  if (!info) return null;

  // 1. releaseNotes가 배열인 경우 (fullChangelog=true 상태로 최신 버전부터 역순 정렬됨)
  if (Array.isArray(info.releaseNotes) && info.releaseNotes.length > 0) {
    for (const item of info.releaseNotes) {
      if (isReleaseMandatory(item)) {
        const ver = (item.version || (item.tag ? String(item.tag).replace(/^v/i, '') : '') || info.version || '').trim();
        const tag = item.tag || (ver ? (ver.startsWith('v') ? ver : `v${ver}`) : (info.version ? `v${info.version}` : ''));
        return {
          version: ver || info.version,
          tag,
          note: item.note || undefined
        };
      }
    }
  }

  // 2. 단일 릴리즈 정보인 경우 (최신 릴리즈의 releaseName 또는 releaseNotes 검사)
  if (hasMandatoryTag(info.releaseName) || (typeof info.releaseNotes === 'string' && hasMandatoryTag(info.releaseNotes))) {
    const ver = String(info.version || '').trim();
    const tag = info.tag || (ver ? (ver.startsWith('v') ? ver : `v${ver}`) : '');
    return {
      version: ver,
      tag,
      note: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    };
  }

  return null;
}

/** 릴리즈 노트에서 [Mandatory Update] 태그 존재 여부 확인 */
export function checkMandatory(info: any): boolean {
  if (!info) return false;
  return findLatestMandatoryRelease(info) !== null;
}

/** 릴리즈 노트(문자열 또는 배열)를 HTML UI 표시용 문자열로 안전하게 변환 */
export function formatReleaseNotes(releaseNotes: any): string | undefined {
  if (!releaseNotes) return undefined;
  if (typeof releaseNotes === 'string') return releaseNotes;
  if (Array.isArray(releaseNotes)) {
    const formatted = releaseNotes
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const title = item.version ? `<h3>v${item.version}</h3>` : '';
          const note = item.note || '';
          return title ? `${title}\n${note}` : note;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n<hr class="border-white/10 my-3" />\n\n');
    return formatted || undefined;
  }
  return String(releaseNotes);
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

function resetDefaultFeed() {
  if (isFeedSwitched) {
    isFeedSwitched = false;
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'twliker',
      repo: 'tw-overlay'
    });
  }
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

  if (!app.isPackaged || process.windowsStore) {
    log(`[UPDATER] ${process.windowsStore ? 'Windows Store (AppX)' : 'Development'} mode: skipping internal GitHub update check`);
    setTimeout(() => {
      notifyReady();
    }, 1200);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.fullChangelog = true; // 현재 버전부터 최신 버전 사이의 모든 릴리즈 노트 수집 활성화

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

    const latestMandatory = findLatestMandatoryRelease(info);
    isMandatory = latestMandatory !== null;

    const cfg = config.load();
    const isAutoUpdateEnabled = cfg.autoUpdateEnabled !== false;

    // CASE 1: 자동 업데이트 활성화 상태 -> 최신 버전으로 스플래시 창에서 다운로드 및 설치
    if (isAutoUpdateEnabled) {
      log(`[AUTO_UPDATE] Auto update enabled. Starting download on splash for latest v${info.version} (mandatory=${isMandatory})`);

      import('./windowManager').then(wm => wm.setMandatoryUpdateLock(true));

      broadcastStatus({
        state: isMandatory ? 'mandatory' : 'available',
        version: info.version,
        isMandatory,
        releaseNotes: formatReleaseNotes(info.releaseNotes)
      });

      autoUpdater.downloadUpdate();
      return;
    }

    // CASE 2: 자동 업데이트 비활성화 상태이지만, 상위 버전 중 강제 업데이트가 존재하는 경우
    if (isMandatory && latestMandatory) {
      log(`[AUTO_UPDATE] Auto update disabled, but mandatory release detected: v${latestMandatory.version} (latest is v${info.version})`);

      // 강제 업데이트 타겟이 최신 버전과 다르고 아직 피드가 전환되지 않은 경우 -> 해당 강제 버전 피드로 전환 후 다운로드
      if (latestMandatory.version !== info.version && !isFeedSwitched && latestMandatory.tag) {
        log(`[AUTO_UPDATE] Switching update feed to target mandatory release ${latestMandatory.tag}`);
        isFeedSwitched = true;

        import('./windowManager').then(wm => wm.setMandatoryUpdateLock(true));

        broadcastStatus({
          state: 'mandatory',
          version: latestMandatory.version,
          isMandatory: true,
          releaseNotes: formatReleaseNotes(latestMandatory.note || info.releaseNotes)
        });

        autoUpdater.setFeedURL({
          provider: 'generic',
          url: `https://github.com/twliker/tw-overlay/releases/download/${latestMandatory.tag}/`
        });

        autoUpdater.checkForUpdates();
        return;
      }

      // 강제 업데이트 타겟이 현재 info 버전과 일치하거나 이미 피드가 전환된 경우 -> 바로 다운로드
      log(`[AUTO_UPDATE] Starting mandatory download on splash for targeted v${info.version}`);
      import('./windowManager').then(wm => wm.setMandatoryUpdateLock(true));

      broadcastStatus({
        state: 'mandatory',
        version: info.version,
        isMandatory: true,
        releaseNotes: formatReleaseNotes(info.releaseNotes)
      });

      autoUpdater.downloadUpdate();
      return;
    }

    // CASE 3: 자동 업데이트 비활성화 상태이며 강제 업데이트도 없음 -> 스플래시 닫고 메인 앱 기동, 사이드바/설정에 레드닷만 표시
    log(`[AUTO_UPDATE] Auto update disabled and no mandatory update required. Launching main app for v${info.version}`);

    currentUpdateInfo = {
      state: 'available',
      version: info.version,
      isMandatory: false,
      releaseNotes: formatReleaseNotes(info.releaseNotes)
    };

    // 메인 앱 기동 (스플래시 창 닫힘)
    notifyReady();

    // 메인 앱 기동 후 상태 브로드캐스트 (사이드바 레드닷)
    const sendUpdateBadge = () => {
      broadcastStatus({
        state: 'available',
        version: info.version,
        isMandatory: false,
        releaseNotes: formatReleaseNotes(info.releaseNotes)
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
    resetDefaultFeed();
    log('[UPDATER] Update not available. Current version is latest.');
    broadcastStatus({ state: 'latest' });
    setTimeout(() => {
      notifyReady();
    }, 600);
  });

  autoUpdater.on('error', (err) => {
    clearTimer();
    resetDefaultFeed();
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
      releaseNotes: formatReleaseNotes(info.releaseNotes)
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

  if (process.windowsStore) {
    log('[UPDATER] Manual check requested in Windows Store mode. Reporting latest.');
    broadcastStatus({ state: 'latest' });
    return;
  }

  try {
    resetDefaultFeed();
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
  resetDefaultFeed();
  autoUpdater.downloadUpdate();
}

/** 재시작 및 설치 */
export function quitAndInstall() {
  autoUpdater.quitAndInstall();
}
