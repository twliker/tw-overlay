import type { ProfileService } from './profileService';
import {getProfileCloudSync} from './profileCloudSync';

export interface ProfileRuntime {
  service:ProfileService;
  replay:(payload:unknown,eventId:string) => unknown;
  onGameState?:(state:'running' | 'minimized' | 'not-running') => void;
  checkpoint?:() => void;
  suspendForRestore?:()=>()=>void;
}

// 부팅에서 저장소와 기록 경로를 준비한 뒤 한 번 연결한다. UI 자체는 이전을 시작하지 않는다.
let runtime:ProfileRuntime | null = null;
export function setProfileRuntime(value:ProfileRuntime | null): void { runtime=value; }
export function getProfileRuntime(): ProfileRuntime | null { return runtime; }
export function observeProfileGameState(state:'running' | 'minimized' | 'not-running'):void {
  runtime?.onGameState?.(state);
  getProfileCloudSync()?.activityChanged(state);
}
