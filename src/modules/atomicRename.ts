/** 임시 파일을 원본 경로로 바꿀 때 Windows의 잠깐 잠금을 기다리는 간격(합계 약 0.55초). 실패할 때만 기다린다. */
export const ATOMIC_RENAME_RETRY_DELAYS_MS = [0, 25, 75, 150, 300] as const;
const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function waitSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 기능 계약 — 설정 JSON·journal의 원자 교체(같은 폴더 임시 파일 → 원본 경로 rename).
 * Windows에서는 백신(Defender 등)·검색 색인·동기화 도구가 방금 쓴 임시 파일이나 원본을 잠깐 열어 두면 rename이
 * EPERM·EACCES·EBUSY로 실패한다. 그대로 실패하면 프로필 선택·설정 저장이 취소되므로(설정 적용 취소, 기존 설정 유지)
 * 이런 잠깐 잠금만 짧게 기다려 다시 시도한다. 다른 오류(경로 없음 등)는 바로 던진다. 메인 스레드에서 동기로 기다리므로
 * 정상 경로에는 지연이 없고, 끝내 잠겨 있으면 최대 약 0.55초 뒤 마지막 오류를 던진다.
 * rename은 호출하는 모듈이 자기 fs로 넘긴다(`() => fs.renameSync(from, to)`). 검사가 모듈별 fs를 바꿔 잠금을 흉내 낸다.
 * 쓰는 곳: config.writeJsonAtomicSync(프로필 저장소 전), ApplicationData.writeAtomicText(기기 설정·journal).
 * 회귀: check-profile-storage.ts(설정 rename 잠깐 잠금), check-audit-regressions.ts(계속 잠긴 설정 저장 취소).
 */
export function renameSyncWithRetry(rename: () => void): void {
  let lastError: unknown;
  for (const delay of ATOMIC_RENAME_RETRY_DELAYS_MS) {
    waitSync(delay);
    try {
      rename();
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_LOCK_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
