import {log} from './logger';

/** 기능 계약 — 프로필 기록 진단 로그(배포판에서도 debug.log에 남는다).
 * 선택은 됐는데 일지·HUD가 오류 없이 멈추는 경우(대기 경로로 빠짐, 로그 읽기 보류, 처리 구간으로 거름)를 나중에
 * debug.log만으로 가려내려고 남긴다. 사냥 중 줄마다 쓰지 않도록 같은 key의 상태가 바뀔 때만 남긴다.
 * 상태가 자주 오가면 key마다 최소 간격(기본 60초) 안의 변화는 세어 두고, 간격이 지난 뒤 그때의 상태가
 * 마지막으로 남긴 상태와 다르면 그 상태를 남긴다(멈춘 상태가 간격에 막혀 영영 안 남는 일이 없게).
 * 회귀: check-profile-diagnostics.ts. */
interface Entry {logged:string;loggedAt:number;current:string;detail?:string;suppressed:number;timer?:NodeJS.Timeout}
const entries=new Map<string,Entry>();
const DEFAULT_INTERVAL_MS=60_000;

export const shortId=(id:string | null | undefined):string => id ? id.slice(0,8) : '-';

function write(key:string,entry:Entry,now:number):void {
  const {current,detail,suppressed}=entry;
  log(`[PROFILE_DIAG] ${key}=${current}${detail ? ` ${detail}` : ''}${suppressed ? ` (그 사이 ${suppressed}회 변화)` : ''}`,true);
  entry.logged=current;entry.loggedAt=now;entry.suppressed=0;
}

/** key의 상태가 바뀌면 남긴다. 같은 상태가 이어지면 남기지 않는다. */
export function diagTransition(key:string,state:string,detail?:string,intervalMs=DEFAULT_INTERVAL_MS):void {
  const now=Date.now();
  let entry=entries.get(key);
  if (!entry) {
    entry={logged:state,loggedAt:now,current:state,detail,suppressed:0};
    entries.set(key,entry);
    write(key,entry,now);
    return;
  }
  if (entry.current===state) return;
  entry.current=state;entry.detail=detail;
  if (now-entry.loggedAt>=intervalMs && !entry.timer) {write(key,entry,now);return;}
  entry.suppressed++;
  if (entry.timer) return;
  const target=entry;
  target.timer=setTimeout(()=>{
    target.timer=undefined;
    if (target.current!==target.logged) write(key,target,Date.now());
    else target.suppressed=0;
  },Math.max(0,target.loggedAt+intervalMs-now));
  target.timer.unref?.();
}

/** 상태와 무관하게 드문 사건(사용자 선택·세션 시작 등)을 남긴다. */
export function diagEvent(key:string,detail:string):void {
  log(`[PROFILE_DIAG] ${key} ${detail}`,true);
}

/** 테스트용: 기억한 상태와 예약을 비운다. */
export function resetProfileDiagnostics():void {
  for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
  entries.clear();
}
