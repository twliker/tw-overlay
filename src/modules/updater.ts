/**
 * 업데이트 관리 모듈 - 필수 업데이트(Mandatory Update) 지원
 */
import { autoUpdater } from 'electron-updater';
import { BrowserWindow, app, Notification, shell } from 'electron';
import { log } from './logger';
import { appState } from './constants';
import * as config from './config';
import * as path from 'path';
import { checkForStoreUpdates, installStoreUpdates, StoreUpdateHelperEvent } from './storeUpdater';
import { normalizeStorePackageVersion, resolveStoreUpdateStartupAction } from './storeUpdatePolicy';
import { registerApplicationRestartForStoreUpdate } from './win32';

let isSetup = false;
let isMandatory = false;
let isFeedSwitched = false;
let storeInstallInProgress = false;
let pendingStoreReadyToLaunch: (() => void) | null = null;

interface PendingStoreUpdate {
  version?: string;
  mandatory: boolean;
}

let pendingStoreUpdate: PendingStoreUpdate | null = null;

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

let _isUpdaterQuitting = false;

/** 업데이트 설치로 인한 종료 여부 반환.
 * 이 값은 사용자가 저장하지 않은 입력 확인(UpdateRestartHooks.confirm)을 통과한 뒤에만 true가 되며,
 * main의 종료 경로는 이 값이 true면 같은 확인을 다시 묻지 않는다. */
export function getIsUpdaterQuitting(): boolean {
  return _isUpdaterQuitting;
}

/** main이 연결하는 업데이트 재시작 전 초안 확인. updater는 편집 창 구성을 알지 못한다.
 * confirm: 일반 업데이트는 취소할 수 있고(false), 필수 업데이트는 저장 안내 뒤 true를 반환한다.
 * release: 승인 뒤 설치가 시작되지 않았을 때 확인 중 걸어 둔 입력 잠금을 푼다. */
export interface UpdateRestartHooks {
  confirm(purpose: 'update' | 'mandatory-update'): Promise<boolean>;
  release(): Promise<void>;
}
let restartHooks: UpdateRestartHooks | null = null;
export function setUpdateRestartConfirmation(hooks: UpdateRestartHooks | null): void {
  restartHooks = hooks;
}

type UpdateRestartDecision = 'approved' | 'declined' | 'app-quitting';

/** 설치 재시작 승인. 필수 업데이트는 확인 결과와 무관하게 진행한다. 승인하면 _isUpdaterQuitting을 세운다.
 * 확인하는 사이 사용자가 승인한 일반 종료가 시작됐다면('app-quitting') 재시작하지 않는다.
 * 그 종료가 autoInstallOnAppQuit으로 업데이트를 설치하며, 사용자가 원한 것은 재실행이 아니라 종료다. */
async function confirmUpdateRestart(mandatory: boolean): Promise<UpdateRestartDecision> {
  if (_isUpdaterQuitting) return 'approved';
  if (appState.isQuitting) return 'app-quitting';
  let approved = true;
  if (restartHooks) {
    try {
      approved = await restartHooks.confirm(mandatory ? 'mandatory-update' : 'update');
    } catch (error) {
      log(`[UPDATER] 재시작 전 입력 확인 실패: ${error instanceof Error ? error.message : String(error)}`);
      approved = false;
    }
  }
  if (appState.isQuitting) return 'app-quitting';
  if (!approved && !mandatory) return 'declined';
  _isUpdaterQuitting = true;
  return 'approved';
}

/** 승인했지만 설치가 시작되지 않은 경우 종료 플래그와 편집 창 잠금을 되돌린다. */
function cancelApprovedUpdateRestart(reason: string): void {
  if (!_isUpdaterQuitting) return;
  _isUpdaterQuitting = false;
  log(`[UPDATER] 업데이트 재시작을 진행하지 못해 앱을 계속 사용합니다: ${reason}`);
  void restartHooks?.release().catch(error => log(`[UPDATER] 입력 잠금 해제 실패: ${String(error)}`));
}

let lastReadyStatus: UpdateStatusInfo | null = null;
let launchAfterDeclinedRestart: (() => void) | null = null;
let restartRequest: Promise<void> | null = null;

/** 다운로드한 업데이트의 설치 재시작 계약.
 * - 다운로드 완료 뒤 자동 재시작과 설정의 [재시작 및 설치]가 같은 경로를 사용한다.
 * - 저장하지 않은 입력·진행 중 작업이 있으면 먼저 묻는다. 일반 업데이트에서 "계속 사용"을 고르면
 *   설치를 미루고 'ready' 상태를 다시 알려 설정 화면의 [재시작 및 설치]를 복구한다. 미룬 설치는
 *   electron-updater의 autoInstallOnAppQuit으로 다음 일반 종료 때 자동 설치된다.
 * - 필수 업데이트는 저장할 기회를 한 번 안내한 뒤 진행한다.
 * - 확인 중 다시 요청해도 대화상자를 겹쳐 띄우지 않는다.
 * 회귀: check-updater-network.ts. */
function requestUpdateRestart(): Promise<void> {
  if (restartRequest) return restartRequest;
  restartRequest = (async () => {
    try {
      const mandatory = isMandatory;
      const decision = await confirmUpdateRestart(mandatory);
      if (decision === 'app-quitting') {
        log('[UPDATER] 앱 종료가 이미 진행 중이어서 재시작 대신 종료할 때 업데이트를 설치합니다.');
        return;
      }
      if (decision === 'declined') {
        log('[UPDATER] 저장하지 않은 입력이 있어 업데이트 설치를 미룹니다. 앱을 종료하면 설치됩니다.');
        const wm = await import('./windowManager');
        // 다운로드 동안 걸어 둔 스플래시 잠금을 풀어 기존 창을 다시 사용할 수 있게 한다.
        wm.setMandatoryUpdateLock(false);
        if (lastReadyStatus) broadcastStatus(lastReadyStatus);
        const launch = launchAfterDeclinedRestart;
        launchAfterDeclinedRestart = null;
        launch?.();
        return;
      }
      if (process.windowsStore) {
        app.quit();
        return;
      }
      autoUpdater.quitAndInstall();
    } catch (error) {
      cancelApprovedUpdateRestart(error instanceof Error ? error.message : String(error));
    } finally {
      restartRequest = null;
    }
  })();
  return restartRequest;
}

/** 현재 버전 또는 전달된 버전이 베타/프리릴리즈 버전인지 확인 */
export function isBetaVersion(version?: string): boolean {
  const ver = typeof version === 'string' ? version : (app ? app.getVersion() : '');
  return /beta|alpha|rc|preview/i.test(ver);
}

/** 
 * 현재 버전보다 상위 버전 목록 중 가장 최신의 강제 업데이트 릴리즈를 탐색
 * (v1 사용자 환경에서 v2강제, v3강제, v4일반, v5강제, v6일반인 경우 -> v5 반환)
 * *현재 버전이 베타이고 대상도 베타인 경우 강제 업데이트를 무시(null 반환)합니다.
 */
export function findLatestMandatoryRelease(info: any, currentVersion?: string): MandatoryReleaseTarget | null {
  if (!info) return null;

  const currentVer = currentVersion ?? (app ? app.getVersion() : '');
  const isCurrentBeta = currentVer ? isBetaVersion(currentVer) : false;

  // 베타 버전 사용자 환경에서는 강제 업데이트 타겟을 탐색하지 않음 (일반 업데이트로 안내)
  if (isCurrentBeta) {
    return null;
  }

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
export function checkMandatory(info: any, currentVersion?: string): boolean {
  if (!info) return false;
  return findLatestMandatoryRelease(info, currentVersion) !== null;
}

/** 릴리즈 노트(문자열 또는 배열)를 renderer가 textContent로 표시할 평문으로 변환 */
export function formatReleaseNotes(releaseNotes: any): string | undefined {
  if (!releaseNotes) return undefined;
  if (typeof releaseNotes === 'string') return releaseNotes;
  if (Array.isArray(releaseNotes)) {
    const formatted = releaseNotes
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const title = item.version ? `v${String(item.version)}` : '';
          const note = typeof item.note === 'string' ? item.note : '';
          return title ? `${title}\n${note}` : note;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n────────────────────\n\n');
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

// electron-updater emits 'error' before rejecting the check. The event handler
// already publishes the status and releases startup, so consume the rejection
// here for startup, manual checks and checks after switching to a mandatory tag.
// Regression: scripts/check-updater-network.ts.
async function checkGitHubForUpdates(): Promise<void> {
  await autoUpdater.checkForUpdates().catch(() => undefined);
}

function showUpdateNotification(version?: string) {
  try {
    const notification = new Notification({
      title: 'TW-Overlay 업데이트 알림',
      body: version
        ? `새로운 버전 v${version}이(가) 출시되었습니다.`
        : '새로운 버전이 Microsoft Store에 출시되었습니다.',
      icon: path.join(__dirname, '..', 'icons', 'icon.ico')
    });
    notification.show();
    notification.on('click', () => {
      import('./windowManager').then(wm => wm.toggleSettingsWindow());
    });
  } catch (error) {
    log(`Notification error: ${error}`);
  }
}

/**
 * 필수 업데이트 실패 후 스플래시의 재시도 버튼은 최초 setupUpdater 호출의 콜백을 직접
 * 전달받지 못한다. 앱 진입 콜백을 모듈에 보관했다가 업데이트가 없어졌거나 일반 오류로
 * 우회할 때 정확히 한 번만 실행한다.
 */
function releaseStoreReadyToLaunch(explicitCallback?: () => void): boolean {
  const callback = explicitCallback || pendingStoreReadyToLaunch;
  pendingStoreReadyToLaunch = null;
  callback?.();
  return !!callback;
}

/** 설정 화면에서 시작한 수동 Store 업데이트가 실패하면 잠금 전에 보던 설정 창을 복구한다. */
function restoreSettingsAfterManualStoreAttempt(wm: typeof import('./windowManager')): void {
  wm.toggleSettingsWindow();
}

/** Store 설치 실패 시 강제 여부에 따라 스플래시 잠금 또는 앱 정상 진입으로 분기한다. */
async function handleStoreInstallFailure(
  message: string,
  mandatory: boolean,
  notifyReady?: () => void,
) {
  cancelApprovedUpdateRestart(message);
  storeInstallInProgress = false;
  const wm = await import('./windowManager');

  if (mandatory) {
    isMandatory = true;
    wm.setMandatoryUpdateLock(true);
    broadcastStatus({
      state: 'error',
      source: 'store',
      version: pendingStoreUpdate?.version,
      isMandatory: true,
      actionRequired: true,
      message,
    });
    return;
  }

  isMandatory = false;
  wm.setMandatoryUpdateLock(false);
  broadcastStatus({
    state: 'error',
    source: 'store',
    version: pendingStoreUpdate?.version,
    isMandatory: false,
    actionRequired: true,
    message,
  });
  if (!releaseStoreReadyToLaunch(notifyReady)) {
    restoreSettingsAfterManualStoreAttempt(wm);
  }
}

/**
 * Store 패키지 다운로드·설치는 별도 도우미가 수행한다. Store가 패키지 프로세스를 직접
 * 종료하는 경로와 결과를 반환하는 경로가 모두 있으므로, 설치 전 재시작 등록과 종료 플래그를
 * 먼저 설정하고 완료 이벤트가 돌아온 경우에만 Electron의 안전 종료 절차를 시작한다.
 */
async function startStoreUpdateInstallation(notifyReady?: () => void) {
  if (storeInstallInProgress) return;
  if (!pendingStoreUpdate) {
    await checkStoreUpdatePolicy(notifyReady);
    return;
  }

  storeInstallInProgress = true;
  // Store 도우미는 설치 중 패키지 프로세스를 직접 끝낼 수 있으므로 설치를 시작하기 전에 초안을 확인한다.
  // 승인해야만 _isUpdaterQuitting이 세워지고, 미루면 설치 전 상태로 돌아간다.
  const requestedUpdate = pendingStoreUpdate;
  const decision = await confirmUpdateRestart(requestedUpdate.mandatory);
  if (decision === 'app-quitting') {
    // Store 설치는 도우미가 수행하므로 종료 중에는 시작하지 않는다. 다음 실행의 정책 확인이 다시 안내한다.
    storeInstallInProgress = false;
    log('[STORE_UPDATE] 앱 종료가 이미 진행 중이어서 Store 업데이트 설치를 다음 실행으로 미룹니다.');
    return;
  }
  if (decision === 'declined') {
    storeInstallInProgress = false;
    log('[STORE_UPDATE] 저장하지 않은 입력이 있어 Store 업데이트 설치를 미룹니다.');
    broadcastStatus({
      state: 'available',
      source: 'store',
      version: requestedUpdate.version,
      isMandatory: false,
    });
    releaseStoreReadyToLaunch(notifyReady);
    return;
  }
  const restartRegistered = registerApplicationRestartForStoreUpdate();
  log(`[STORE_UPDATE] RegisterApplicationRestart=${restartRegistered}`);

  const wm = await import('./windowManager');
  const ownerWindow = wm.getSplashWindow() || wm.getSettingsWindow() || wm.getMainWindow();
  wm.setMandatoryUpdateLock(true);
  broadcastStatus({
    state: pendingStoreUpdate.mandatory ? 'mandatory' : 'available',
    source: 'store',
    version: pendingStoreUpdate.version,
    isMandatory: pendingStoreUpdate.mandatory,
  });

  try {
    const outcome = await installStoreUpdates(ownerWindow, {
      onEvent: (event: StoreUpdateHelperEvent) => {
        if (event.type !== 'progress') return;
        broadcastStatus({
          state: 'downloading',
          source: 'store',
          version: pendingStoreUpdate?.version,
          percent: event.percent,
          isMandatory: pendingStoreUpdate?.mandatory === true,
        });
      },
    });

    if (outcome.type === 'permission-required') {
      await handleStoreInstallFailure(
        'Microsoft Store의 업데이트 설치 승인이 필요합니다.',
        outcome.mandatory || pendingStoreUpdate.mandatory,
        notifyReady,
      );
      return;
    }

    if (!outcome.completed) {
      await handleStoreInstallFailure(
        `Microsoft Store 업데이트가 완료되지 않았습니다. (${outcome.state})`,
        outcome.mandatory || pendingStoreUpdate.mandatory,
        notifyReady,
      );
      return;
    }

    if (outcome.noUpdate) {
      pendingStoreUpdate = null;
      isMandatory = false;
      cancelApprovedUpdateRestart('no Store update to install');
      storeInstallInProgress = false;
      wm.setMandatoryUpdateLock(false);
      broadcastStatus({ state: 'latest', source: 'store' });
      if (!releaseStoreReadyToLaunch(notifyReady)) {
        restoreSettingsAfterManualStoreAttempt(wm);
      }
      return;
    }

    broadcastStatus({
      state: 'ready',
      source: 'store',
      version: pendingStoreUpdate.version,
      percent: 100,
      isMandatory: pendingStoreUpdate.mandatory,
    });
    log('[STORE_UPDATE] Store package deployment completed. Quitting for package activation.');
    setTimeout(() => app.quit(), 500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[STORE_UPDATE] Installation failed: ${message}`);
    await handleStoreInstallFailure(message, pendingStoreUpdate?.mandatory === true, notifyReady);
  }
}

/** GitHub updater와 동일한 자동/강제 조건으로 Store 업데이트의 시작 시점을 결정한다. */
async function checkStoreUpdatePolicy(notifyReady?: () => void) {
  if (notifyReady) pendingStoreReadyToLaunch = notifyReady;
  broadcastStatus({ state: 'checking', source: 'store' });
  try {
    const result = await checkForStoreUpdates();
    if (!result.updateAvailable) {
      pendingStoreUpdate = null;
      isMandatory = false;
      broadcastStatus({ state: 'latest', source: 'store' });
      setTimeout(() => releaseStoreReadyToLaunch(notifyReady), 600);
      return;
    }

    const version = normalizeStorePackageVersion(result.version);
    pendingStoreUpdate = { version, mandatory: result.mandatory };
    isMandatory = result.mandatory;
    const autoUpdateEnabled = config.load().autoUpdateEnabled !== false;
    const action = resolveStoreUpdateStartupAction(result.mandatory, autoUpdateEnabled);
    log(`[STORE_UPDATE] Update available: version=${version || 'unknown'}, mandatory=${result.mandatory}, auto=${autoUpdateEnabled}, silent=${result.canSilentlyInstall}, action=${action}`);

    if (action === 'notify-only') {
      broadcastStatus({
        state: 'available',
        source: 'store',
        version,
        isMandatory: false,
      });
      releaseStoreReadyToLaunch(notifyReady);
      showUpdateNotification(version);
      return;
    }

    await startStoreUpdateInstallation(notifyReady);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pendingStoreUpdate = null;
    isMandatory = false;
    cancelApprovedUpdateRestart(message);
    log(`[STORE_UPDATE] Check failed: ${message}`);
    broadcastStatus({ state: 'error', source: 'store', message });
    setTimeout(() => releaseStoreReadyToLaunch(notifyReady), 600);
  }
}

/** Store 설치가 막혔을 때 사용자가 Windows의 업데이트·다운로드 화면에서 직접 재시도할 수 있다. */
export function openMicrosoftStoreUpdatesPage() {
  shell.openExternal('ms-windows-store://downloadsandupdates').catch(error => {
    log(`[STORE_UPDATE] Failed to open Microsoft Store updates page: ${error}`);
  });
}

/** 시작 실패 뒤 업데이트 확인 모드. 확인·다운로드가 이 시간 동안 진행되지 않으면 종료한다(트레이가 없어 사용자가 끌 수 없다). */
let startupFailureRecovery = false;
const STARTUP_FAILURE_CHECK_TIMEOUT_MS = 20_000;
const STARTUP_FAILURE_DOWNLOAD_STALL_MS = 120_000;

/** 이 설치본이 앱 안에서 GitHub 업데이트를 받을 수 있는지. Store 설치본은 Store가 패키지를 갱신하므로
 * electron-updater를 쓰지 않고, 개발 실행은 업데이트를 확인하지 않는다. */
export function canCheckUpdateAfterStartupFailure(): boolean {
  return app.isPackaged && !process.windowsStore;
}

/** 시작 실패(프로필 데이터 준비 실패 등) 뒤 업데이트 확인 계약.
 * - 앱을 시작할 수 없어도 고친 새 버전은 받을 수 있어야 한다. 메인 창·트레이 없이 스플래시에서만 확인한다.
 * - 사용자가 확인을 고른 뒤 호출하므로, 새 버전이 있으면 자동 업데이트 설정·베타 여부와 관계없이
 *   일반 자동 업데이트와 같은 스플래시 잠금 흐름으로 받아 설치·재시작한다(설치 전 초안 확인도 같다).
 * - 새 버전이 없거나, 확인·다운로드·설치 시작이 실패하거나, 제한 시간 동안 진행이 없으면 잠금을 풀고
 *   onFinishedWithoutUpdate를 정확히 한 번 호출한다(호출자는 앱을 종료한다). 앱 진입(launchMainApp)은 하지 않는다.
 * - 이 확인을 할 수 없는 설치본(Store·개발 실행)이면 바로 onFinishedWithoutUpdate를 호출한다.
 * 회귀: check-updater-network.ts(시작 실패 뒤 업데이트 확인). */
export function checkUpdateAfterStartupFailure(onFinishedWithoutUpdate: () => void): void {
  if (!canCheckUpdateAfterStartupFailure() || isSetup) {
    if (isSetup) log('[UPDATER] 업데이트 확인이 이미 시작되어 시작 실패 뒤 확인을 건너뜁니다.');
    onFinishedWithoutUpdate();
    return;
  }
  startupFailureRecovery = true;
  setupUpdater(onFinishedWithoutUpdate);
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
  // 스플래시에서 다운로드를 마쳤지만 사용자가 재시작을 미루면 앱 진입을 이어서 진행한다(이미 진입했으면 무시).
  launchAfterDeclinedRestart = () => notifyReady();

  if (!app.isPackaged) {
    log('[UPDATER] Development mode: skipping update check');
    setTimeout(() => {
      notifyReady();
    }, 1200);
    return;
  }

  if (process.windowsStore) {
    log('[UPDATER] Windows Store mode: checking Store package updates');
    void checkStoreUpdatePolicy(notifyReady);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.fullChangelog = true; // 현재 버전부터 최신 버전 사이의 모든 릴리즈 노트 수집 활성화

  // 시작 실패 뒤 확인(checkUpdateAfterStartupFailure)이면 notifyReady는 앱 진입이 아니라 종료다.
  const recovery = startupFailureRecovery;
  let updateCheckTimeout: NodeJS.Timeout | null = null;

  function clearTimer() {
    if (updateCheckTimeout) {
      clearTimeout(updateCheckTimeout);
      updateCheckTimeout = null;
    }
  }

  function onUpdateTimeout() {
    updateCheckTimeout = null;
    if (recovery) {
      log('[UPDATER] 시작 실패 뒤 업데이트 확인·다운로드가 진행되지 않아 앱을 종료합니다.');
      void import('./windowManager').then(wm => wm.setMandatoryUpdateLock(false)).finally(() => notifyReady());
      return;
    }
    log('[UPDATER] Update check timeout (5s). Launching main app.');
    notifyReady();
  }

  function armTimer(ms: number) {
    clearTimer();
    updateCheckTimeout = setTimeout(onUpdateTimeout, ms);
  }

  armTimer(recovery ? STARTUP_FAILURE_CHECK_TIMEOUT_MS : 5000);

  autoUpdater.on('checking-for-update', () => {
    broadcastStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    clearTimer();
    log(`Update available: ${info.version}`);

    const currentVer = app ? app.getVersion() : '';
    const isCurrentBeta = isBetaVersion(currentVer);

    const latestMandatory = isCurrentBeta ? null : findLatestMandatoryRelease(info, currentVer);
    isMandatory = latestMandatory !== null;

    const cfg = config.load();
    const isAutoUpdateEnabled = cfg.autoUpdateEnabled !== false;

    const isTargetBeta = isBetaVersion(info.version);

    // 시작 실패 뒤 확인: 사용자가 새 버전 확인을 골랐고 앱을 시작할 수 없으므로 설정과 무관하게 받아서 설치한다.
    if (recovery) {
      if (!onReadyToLaunch) return; // 이미 종료하기로 한 뒤 늦게 도착한 결과
      log(`[AUTO_UPDATE] Startup failed. Downloading v${info.version} on splash to recover (mandatory=${isMandatory})`);
      armTimer(STARTUP_FAILURE_DOWNLOAD_STALL_MS);
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

    // CASE 0: 현재 실행 중인 버전이 베타이고, 대상 버전도 베타인 경우
    // -> 강제 업데이트 잠금 및 스플래시 자동 다운로드를 무시하고 메인 앱을 즉시 실행하여 사용자가 베타를 계속 사용할 수 있도록 함
    // (단, 정식 릴리즈(Non-beta)가 나온 경우 일반 업데이트 흐름을 정상 진행)
    if (isCurrentBeta && isTargetBeta) {
      log(`[UPDATER] Running beta version (v${currentVer}) and target is also beta (v${info.version}). Skipping splash auto-download.`);

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
      return;
    }

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

        void checkGitHubForUpdates();
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
    // quitAndInstall의 설치 시작 실패도 이 이벤트로 온다. 승인한 재시작을 되돌려 앱을 계속 쓸 수 있게 한다.
    cancelApprovedUpdateRestart('installer did not start');
    const message = 'code' in err && err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      ? '업데이트 정보를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.'
      : err.message;
    broadcastStatus({ state: 'error', message });

    // 스플래시 다운로드 잠금은 필수 업데이트뿐 아니라 자동 업데이트(CASE 1)의 일반 업데이트에도 걸린다.
    // 실패하면 어느 경우든 잠금을 풀어 창 표시·오버레이 동기화를 되살린다. 잠그지 않았던 확인 실패라면
    // 해제는 아무것도 하지 않고, 시작 단계의 스플래시는 notifyReady → launchMainApp이 메인 창을 만든 뒤 닫는다.
    // 회귀: check-updater-network.ts(일반 자동 업데이트 다운로드 실패 후 잠금 해제),
    // check-window-visibility.ts(잠그지 않은 해제의 스플래시 유지)
    import('./windowManager').then(wm => wm.setMandatoryUpdateLock(false));
    isMandatory = false;
    setTimeout(() => {
      notifyReady();
    }, 600);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    // 시작 실패 뒤 다운로드는 진행이 이어지는 동안만 기다린다.
    if (recovery && onReadyToLaunch) armTimer(STARTUP_FAILURE_DOWNLOAD_STALL_MS);
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
    // 설치 전 확인 대화상자에 사용자가 답하는 동안에는 정체 감시를 멈춘다(답하는 중에 종료하지 않는다).
    clearTimer();
    log(`Update downloaded: v${info.version} (isMandatory=${isMandatory})`);
    lastReadyStatus = {
      state: 'ready',
      version: info.version,
      isMandatory,
      releaseNotes: formatReleaseNotes(info.releaseNotes)
    };
    broadcastStatus(lastReadyStatus);
    import('./windowManager').then(wm => {
      wm.getMainWindow()?.setProgressBar(-1);
    });

    // 다운로드 완료 시 자동 설치 및 재시작. 저장하지 않은 입력이 있으면 requestUpdateRestart가 먼저 묻는다.
    log('[UPDATER] Download complete. Installing and restarting in 1.5s...');
    setTimeout(() => {
      void requestUpdateRestart().finally(() => {
        // 시작 실패 뒤에는 확인이 끝났는데도 설치 재시작이 시작되지 않고 멈춘 경우에만 정체 감시로 종료한다.
        // 재시작을 미루면 launchAfterDeclinedRestart가 이미 종료(notifyReady)했으므로 onReadyToLaunch가 비어 있다.
        if (recovery && onReadyToLaunch) armTimer(STARTUP_FAILURE_DOWNLOAD_STALL_MS);
      });
    }, 1500);
  });

  // 초기 체크 실행
  log('Starting auto update check on splash...');
  void checkGitHubForUpdates();
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
    log('[UPDATER] Manual check requested in Windows Store mode.');
    await checkStoreUpdatePolicy();
    return;
  }

  try {
    resetDefaultFeed();
    broadcastStatus({ state: 'checking' });
    await checkGitHubForUpdates();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Manual update check error: ${msg}`);
    broadcastStatus({ state: 'error', message: msg });
  }
}

/** 업데이트 다운로드 시작 */
export function startDownload() {
  if (process.windowsStore) {
    log('[STORE_UPDATE] User requested Store update installation.');
    void startStoreUpdateInstallation();
    return;
  }
  log('Starting update download...');
  resetDefaultFeed();
  autoUpdater.downloadUpdate();
}

/** 재시작 및 설치(설정 화면의 버튼). 자동 재시작과 같은 초안 확인을 거친다. */
export function quitAndInstall(): Promise<void> {
  return requestUpdateRestart();
}
