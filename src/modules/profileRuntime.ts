import type { ProfileService } from './profileService';
import type {ProfileGameState} from './profileGameLifecycle';
import {getProfileCloudSync} from './profileCloudSync';
import {log} from './logger';

export interface ProfileRuntime {
  service:ProfileService;
  replay:(payload:unknown,eventId:string) => unknown;
  onGameState?:(state:ProfileGameState,processId?:number) => void | Promise<void>;
  canReadLiveLog?:()=>boolean;
  checkpoint?:() => void;
  progressFailed?:(profileId:string)=>void;
  suspendForRestore?:()=>()=>void;
}

// 부팅에서 저장소와 기록 경로를 준비한 뒤 한 번 연결한다. UI 자체는 이전을 시작하지 않는다.
let runtime:ProfileRuntime | null = null;
export function setProfileRuntime(value:ProfileRuntime | null): void { runtime=value; }
export function getProfileRuntime(): ProfileRuntime | null { return runtime; }
/** XP commands are scoped to the selection the user saw when issuing them. */
export function canControlProfileXp(expectedId?:unknown,fromRenderer=false):boolean {
  if (!runtime) return true;
  if (runtime.service.isStorageMaintenanceActive() || !runtime.service.store.database.open) return false;
  const status=runtime.service.status();
  return !status.selectionRequired && !status.busy && !!status.activeProfileId
    && (!fromRenderer || expectedId===status.activeProfileId);
}
/** 수동 초기화·중지 뒤에는 다음 실행이 이전 자동 이벤트를 되살리지 않게 한다. */
export function checkpointManualProgress():void {
  if (!runtime || runtime.service.isStorageMaintenanceActive()) return;
  try {runtime.checkpoint?.();}
  catch (error) {log(`[PROFILE] 수동 진행 상태 저장 실패: ${String(error)}`);}
}
export function observeProfileGameState(state:ProfileGameState,processId?:number):void | Promise<void> {
  const pending=runtime?.onGameState?.(state,processId);
  getProfileCloudSync()?.activityChanged(state);
  return pending;
}
