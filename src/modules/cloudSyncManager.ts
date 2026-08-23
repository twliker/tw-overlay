/**
 * 구글 드라이브 동기화 오케스트레이터 및 백그라운드 스케줄러
 */
import { AppConfig, GoogleSyncResult, GoogleSyncStatus, GoogleSyncPayload } from '../shared/types';
import * as config from './config';
import * as googleAuth from './googleAuth';
import * as googleDriveSync from './googleDriveSync';
import * as syncDataHelper from './syncDataHelper';
import { log } from './logger';
import { broadcastToAllWindows } from './windowMessaging';

const DEBOUNCE_SYNC_MS = 5000;
let _debounceTimer: NodeJS.Timeout | null = null;
let _isSyncing = false;

/** 현재 구글 동기화 상태 반환 */
export function getSyncStatus(): GoogleSyncStatus {
  const isLinked = googleAuth.isLoggedIn();
  const profile = googleAuth.loadStoredProfile();
  const cfg = config.load();

  return {
    isLinked,
    email: profile?.email || cfg.googleSyncUserEmail,
    lastSyncedAt: cfg.googleSyncLastTime,
    isSyncing: _isSyncing,
    autoSync: cfg.googleSyncAutoSync !== false,
  };
}

/** 구글 로그인 및 초기 상태 동기화 */
export async function loginAndInit(): Promise<{ success: boolean; status: GoogleSyncStatus; error?: string }> {
  try {
    const loginResult = await googleAuth.startLogin();
    if (!loginResult.success || !loginResult.profile) {
      return {
        success: false,
        status: getSyncStatus(),
        error: loginResult.error || '로그인에 실패했습니다.',
      };
    }

    const cfg = config.load();
    cfg.googleSyncEnabled = true;
    cfg.googleSyncUserEmail = loginResult.profile.email;
    if (cfg.googleSyncAutoSync === undefined) {
      cfg.googleSyncAutoSync = true;
    }
    config.save(cfg);

    broadcastToAllWindows('google-sync-status-changed', getSyncStatus());

    // 로그인 직후 클라우드에 기존 데이터가 있는지 확인하고 가져오기
    try {
      await syncFromCloud(false);
    } catch (syncErr) {
      log(`[CloudSyncManager] 로그인 후 초기 다운로드 실패: ${syncErr}`);
    }

    return {
      success: true,
      status: getSyncStatus(),
    };
  } catch (err: any) {
    log(`[CloudSyncManager] loginAndInit 오류: ${err}`);
    return {
      success: false,
      status: getSyncStatus(),
      error: err.message || String(err),
    };
  }
}

/** 로그아웃 */
export function logout(): GoogleSyncStatus {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  googleAuth.logout();

  const cfg = config.load();
  cfg.googleSyncEnabled = false;
  config.save(cfg);

  const status = getSyncStatus();
  broadcastToAllWindows('google-sync-status-changed', status);
  return status;
}

/** 로컬 -> 클라우드 백업 (업로드) */
export async function syncToCloud(manual = false): Promise<GoogleSyncResult> {
  if (!googleAuth.isLoggedIn()) {
    return { success: false, error: 'Google 로그인이 필요합니다.' };
  }
  if (_isSyncing) {
    return { success: false, error: '현재 동기화가 진행 중입니다.' };
  }

  _isSyncing = true;
  broadcastToAllWindows('google-sync-status-changed', getSyncStatus());

  try {
    const cfg = config.load();
    const profile = googleAuth.loadStoredProfile();
    const userEmail = profile?.email || cfg.googleSyncUserEmail || 'user@gmail.com';

    const payload = syncDataHelper.buildSyncPayload(cfg, userEmail);

    // 1. 기존 파일 ID 조회
    const existingFile = await googleDriveSync.findSyncFile();
    const fileId = await googleDriveSync.uploadSyncPayload(payload, existingFile?.id);

    cfg.googleSyncLastTime = payload.lastSyncedAt;
    config.save(cfg);

    log(`[CloudSyncManager] 클라우드 백업 완료 (${fileId})`);
    return {
      success: true,
      message: '클라우드에 안전하게 백업되었습니다.',
      lastSyncedAt: payload.lastSyncedAt,
    };
  } catch (err: any) {
    log(`[CloudSyncManager] 클라우드 백업 실패: ${err}`);
    return {
      success: false,
      error: err.message || String(err),
    };
  } finally {
    _isSyncing = false;
    broadcastToAllWindows('google-sync-status-changed', getSyncStatus());
  }
}

/** 클라우드 -> 로컬 복원 (다운로드 및 병합) */
export async function syncFromCloud(manual = false): Promise<GoogleSyncResult> {
  if (!googleAuth.isLoggedIn()) {
    return { success: false, error: 'Google 로그인이 필요합니다.' };
  }
  if (_isSyncing) {
    return { success: false, error: '현재 동기화가 진행 중입니다.' };
  }

  _isSyncing = true;
  broadcastToAllWindows('google-sync-status-changed', getSyncStatus());

  try {
    // 1. 클라우드 파일 찾기
    const fileMeta = await googleDriveSync.findSyncFile();
    if (!fileMeta) {
      if (manual) {
        return { success: false, error: '구글 드라이브에 저장된 백업 데이터가 없습니다.' };
      }
      // 자동 동기화 시 클라우드 파일이 없으면 최초 로컬 상태를 클라우드에 업로드
      log('[CloudSyncManager] 클라우드 파일 없음 -> 최초 백업 수행');
      _isSyncing = false;
      return syncToCloud(false);
    }

    // 2. 다운로드
    const cloudPayload = await googleDriveSync.downloadSyncPayload(fileMeta.id);
    if (!cloudPayload || !cloudPayload.data) {
      return { success: false, error: '클라우드 데이터 형식이 올바르지 않습니다.' };
    }

    const currentCfg = config.load();

    // 3. 로컬 안전 백업
    syncDataHelper.createLocalBackupBeforeSync(currentCfg);

    // 4. 안전 병합
    _isApplyingCloudSync = true;
    try {
      const mergedCfg = syncDataHelper.mergeSyncData(currentCfg, cloudPayload);
      config.save(mergedCfg);
    } finally {
      _isApplyingCloudSync = false;
    }

    // 5. 각 창에 갱신 브로드캐스트
    broadcastToAllWindows('config-updated');
    broadcastToAllWindows('contents-updated');

    log(`[CloudSyncManager] 클라우드 데이터 병합 완료 (수정시간: ${new Date(cloudPayload.lastSyncedAt).toLocaleString()})`);

    return {
      success: true,
      message: '클라우드 데이터를 성공적으로 불러왔습니다.',
      lastSyncedAt: cloudPayload.lastSyncedAt,
    };
  } catch (err: any) {
    log(`[CloudSyncManager] 클라우드 복원 실패: ${err}`);
    return {
      success: false,
      error: err.message || String(err),
    };
  } finally {
    _isSyncing = false;
    broadcastToAllWindows('google-sync-status-changed', getSyncStatus());
  }
}

/** 현재 구글 드라이브에 저장된 원본 데이터 미리보기 조회 (로컬 변경 없음) */
export async function getCloudDataPreview(): Promise<{ success: boolean; payload?: GoogleSyncPayload; error?: string }> {
  if (!googleAuth.isLoggedIn()) {
    return { success: false, error: 'Google 로그인이 필요합니다.' };
  }

  try {
    const fileMeta = await googleDriveSync.findSyncFile();
    if (!fileMeta) {
      return { success: false, error: '구글 드라이브에 저장된 동기화 파일이 없습니다.' };
    }

    const cloudPayload = await googleDriveSync.downloadSyncPayload(fileMeta.id);
    if (!cloudPayload) {
      return { success: false, error: '데이터를 읽어올 수 없습니다.' };
    }

    return {
      success: true,
      payload: cloudPayload,
    };
  } catch (err: any) {
    log(`[CloudSyncManager] 데이터 미리보기 실패: ${err}`);
    return {
      success: false,
      error: err.message || String(err),
    };
  }
}

let _isApplyingCloudSync = false;

/** 숙제 체크 등 변경 시 5초 디바운스로 백그라운드 클라우드 업로드 */
export function requestDebouncedSync(): void {
  if (_isApplyingCloudSync) return;
  const cfg = config.load();
  if (!cfg.googleSyncEnabled || cfg.googleSyncAutoSync === false || !googleAuth.isLoggedIn()) {
    return;
  }

  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
  }

  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    syncToCloud(false).catch((err) => {
      log(`[CloudSyncManager] 디바운스 자동 동기화 에러: ${err}`);
    });
  }, DEBOUNCE_SYNC_MS);
}

/** 대기 중인 동기화 즉시 실행 (앱 종료 시 호출) */
export async function flushPendingSync(): Promise<void> {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    try {
      await syncToCloud(false);
    } catch (err) {
      log(`[CloudSyncManager] 종료 시 동기화 실패: ${err}`);
    }
  }
}

// 설정 변경 감지 시 자동 동기화 트리거
config.addConfigChangeListener((changed) => {
  if (_isApplyingCloudSync) return;
  const keys = Object.keys(changed) as Array<keyof AppConfig>;
  // 동기화 제외 대상만 변경된 경우(예: positions, storedPositionKeys만 변경)는 클라우드 업로드 스킵
  const isOnlyLocalKeys = keys.every((k) =>
    ['positions', 'storedPositionKeys', 'googleSyncLastTime', 'googleSyncUserEmail'].includes(k)
  );
  if (!isOnlyLocalKeys) {
    requestDebouncedSync();
  }
});
