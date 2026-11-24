import type {PendingHomework} from './types';

/** 과거 보류 수량은 누적/절대값 의미가 다르다. 숙제 ID나 적용 방식이 없으면 추측해서 배정하지 않는다. */
export function readLegacyPendingHomework(value:unknown):PendingHomework | null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const item=value as Record<string,unknown>;
  if(typeof item.id!=='string' || !item.id.trim() || typeof item.isIncrement!=='boolean'
    || typeof item.count!=='number' || !Number.isSafeInteger(item.count) || item.count<0
    || !isLegacyTimestamp(item.timestamp))return null;
  return value as PendingHomework;
}

function isLegacyTimestamp(value:unknown):value is number {
  return typeof value==='number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

/** 시각을 알 수 없는 구형 보류 숙제의 대기 행 발생 시각. 값 자체는 배정 근거가 아니다. */
export const UNKNOWN_LEGACY_PENDING_OCCURRED_AT=0;

export interface LegacyPendingHomeworkEvent {occurredAt:number;payload:{kind:'legacy-homework';value:unknown}}

/**
 * 기능 계약 — v3.2.2 `config.pendingHomeworks` 한 항목을 프로필 대기 행으로 옮기는 유일한 변환.
 * DB 최초 이전(ApplicationData.initialize)과 구형 설정 ZIP 복원(restoreLegacyConfiguration)이 함께 쓴다.
 * 원본 항목은 손상·누락 여부와 관계없이 payload.value에 그대로 보존하고, 배정 가능 여부는 재생/요약 때
 * readLegacyPendingHomework가 판정한다(배정 불가 안내 → 무시하기). 이 함수는 대기 행의 NOT NULL
 * occurred_at만 결정한다: 유효한 timestamp는 그대로, 누락/비유한/날짜 범위 밖 값은 고정값 0을 쓴다.
 * 고정값이어야 같은 백업을 다시 복원할 때 event ID/영수증 비교가 일치한다. 항목 하나의 손상으로
 * 전체 이전이나 복원을 중단하지 않는다. 회귀: check-profile-storage.ts, check-profile-backup.ts.
 */
export function toLegacyPendingHomeworkEvent(value:unknown):LegacyPendingHomeworkEvent {
  const timestamp=value && typeof value==='object' && !Array.isArray(value) ? (value as Record<string,unknown>).timestamp : undefined;
  return {
    occurredAt:isLegacyTimestamp(timestamp) ? timestamp : UNKNOWN_LEGACY_PENDING_OCCURRED_AT,
    payload:{kind:'legacy-homework',value},
  };
}

/** 설정 파일의 보류 목록이 배열이 아니면 옮길 항목이 없는 것으로 본다(설정 검증과 같은 기준). */
export function legacyPendingHomeworkEvents(list:unknown):LegacyPendingHomeworkEvent[] {
  return Array.isArray(list) ? list.map(toLegacyPendingHomeworkEvent) : [];
}
