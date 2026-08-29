/** Microsoft Store 업데이트를 실행 시 처리할지, 앱 진입 후 알림만 표시할지 결정한 결과. */
export type StoreUpdateStartupAction = 'install-on-splash' | 'notify-only';

/**
 * GitHub 설치본과 Store 설치본이 같은 사용자 설정을 따르도록 정책을 한곳에 고정한다.
 * Partner Center에서 강제로 지정한 업데이트는 로컬 자동 업데이트 설정에 항상 우선한다.
 */
export function resolveStoreUpdateStartupAction(
  mandatory: boolean,
  autoUpdateEnabled: boolean,
): StoreUpdateStartupAction {
  return mandatory || autoUpdateEnabled ? 'install-on-splash' : 'notify-only';
}

/** Windows 패키지의 4자리 버전에서 표시용 마지막 .0만 제거한다. */
export function normalizeStorePackageVersion(version: string | undefined): string | undefined {
  if (!version) return undefined;
  const normalized = version.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+\.0$/.test(normalized)
    ? normalized.slice(0, -2)
    : normalized;
}

