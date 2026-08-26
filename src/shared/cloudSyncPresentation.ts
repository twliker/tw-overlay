interface CloudSyncFileStatusLike {
  kind: 'settings' | 'checklist';
  retryCount?: number;
  lastError?: string;
}

interface CloudSyncStatusLike {
  isLinked?: boolean;
  reauthRequired?: boolean;
  isSyncing?: boolean;
  syncActivity?: 'upload' | 'download' | 'checking' | 'preview' | 'rollback';
  autoSync?: boolean;
  fileStatuses?: CloudSyncFileStatusLike[];
  pullRetryCount?: number;
  error?: string;
}

type CloudSyncDisplayState = 'normal' | 'checking' | 'uploading' | 'downloading' | 'error';

interface CloudSyncPresentation {
  visible: boolean;
  state: CloudSyncDisplayState;
  icon: string | null;
  label: string;
}

interface CloudSyncPresentationApi {
  get(status: CloudSyncStatusLike | null | undefined, kind?: 'settings' | 'checklist'): CloudSyncPresentation;
}

interface Window {
  cloudSyncPresentation: CloudSyncPresentationApi;
}

(function exposeCloudSyncPresentation(globalObject: Window | null): void {
  function get(
    status: CloudSyncStatusLike | null | undefined,
    kind?: 'settings' | 'checklist',
  ): CloudSyncPresentation {
    if (status?.reauthRequired) {
      return {
        visible: true,
        state: 'error',
        icon: 'circle-alert',
        label: 'Google 인증 만료 · 다시 로그인 필요',
      };
    }

    if (!status?.isLinked) {
      return { visible: false, state: 'normal', icon: null, label: '' };
    }

    if (status.isSyncing) {
      if (status.syncActivity === 'upload') {
        return { visible: true, state: 'uploading', icon: 'cloud-upload', label: '클라우드에 저장 중' };
      }
      if (status.syncActivity === 'download') {
        return { visible: true, state: 'downloading', icon: 'cloud-download', label: '클라우드에서 불러오는 중' };
      }
      return { visible: true, state: 'checking', icon: 'refresh-cw', label: '클라우드 변경 확인 중' };
    }

    const relevantFiles = kind
      ? (status.fileStatuses || []).filter(file => file.kind === kind)
      : (status.fileStatuses || []);
    const hasError = Boolean(status.error)
      || (status.pullRetryCount || 0) > 0
      || relevantFiles.some(file => Boolean(file.lastError) || (file.retryCount || 0) > 0);
    if (hasError) {
      return {
        visible: true,
        state: 'error',
        icon: 'circle-alert',
        label: kind === 'checklist'
          ? '숙제 체크리스트 동기화 오류 · 설정에서 확인'
          : '클라우드 동기화 오류 · 설정에서 확인',
      };
    }

    return {
      visible: true,
      state: 'normal',
      icon: null,
      label: status.autoSync === false
        ? 'Google Drive 연결됨 · 자동 동기화 꺼짐'
        : 'Google Drive 자동 동기화 정상',
    };
  }

  const api: CloudSyncPresentationApi = Object.freeze({ get });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { cloudSyncPresentation: api };
  }
  if (globalObject) globalObject.cloudSyncPresentation = api;
})(typeof window !== 'undefined' ? window : null);
