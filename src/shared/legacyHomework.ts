import type {PendingHomework} from './types';

/** 과거 보류 수량은 누적/절대값 의미가 다르다. 숙제 ID나 적용 방식이 없으면 추측해서 배정하지 않는다. */
export function readLegacyPendingHomework(value:unknown):PendingHomework | null {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const item=value as Record<string,unknown>;
  if(typeof item.id!=='string' || !item.id.trim() || typeof item.isIncrement!=='boolean'
    || typeof item.count!=='number' || !Number.isSafeInteger(item.count) || item.count<0
    || typeof item.timestamp!=='number' || !Number.isFinite(item.timestamp) || !Number.isFinite(new Date(item.timestamp).getTime()))return null;
  return value as PendingHomework;
}
