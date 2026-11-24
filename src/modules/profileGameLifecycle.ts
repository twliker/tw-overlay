import { randomUUID } from 'crypto';
import type { ProfileService } from './profileService';

export type ProfileGameState='running' | 'minimized' | 'not-running';

/** 기능 계약 — 게임이 보일 때 한 번 선택창을 연다. 최소화/숨김 시작은 세션만 준비하고 표시를 보류한다.
 * 같은 프로세스의 running↔minimized나 HWND 변경은 같은 세션이다. PID 교체는 새 세션이다.
 * 사용자가 이미 선택했다면 복귀 때 다시 열지 않는다. Google 적용으로 선택이 해제되면
 * 같은 세션에서도 새 요청으로 취급하여 게임이 보이는 시점에 다시 연다.
 * 추적 오류/일시적 샘플은 호출자가 확정 후 전달한다. 회귀: profile-storage/lifecycle/windows.
 * 저장/창 표시 실패는 같은 세션 키로 재시도하며 이전 프로필로 기록하지 않는다.
 */
export class ProfileGameLifecycle {
  private sessionKey:string | null=null;
  private openedRevision:number | undefined;
  private pendingEnd:'end' | 'replacement' | null=null;
  private processId:number | undefined;
  private ending?:Promise<void>;
  private latestDuringEnd?:[ProfileGameState,number | undefined];
  constructor(private readonly service:ProfileService,private readonly openSelection:() => void) {}

  get currentProcessId():number | undefined {return this.processId;}

  observe(state:ProfileGameState,processId?:number):void | Promise<void> {
    if (this.ending) {this.latestDuringEnd=[state,processId];return this.ending;}
    const replaced=processId!==undefined && this.processId!==undefined && processId!==this.processId;
    if (this.sessionKey && (replaced || state==='not-running')) {
      this.pendingEnd=replaced ? 'replacement' : 'end';
      this.sessionKey=null;this.openedRevision=undefined;this.processId=undefined;
    }
    if (this.pendingEnd) {
      const ending=this.service.endSession(this.pendingEnd);
      if (ending) {
        this.latestDuringEnd=[state,processId];
        this.ending=ending.then(()=>{this.pendingEnd=null;}).finally(()=>{this.ending=undefined;}).then(()=>{
          const latest=this.latestDuringEnd;this.latestDuringEnd=undefined;
          if (latest) return this.observe(...latest);
        });
        return this.ending;
      }
      this.pendingEnd=null;
    }
    if (state==='not-running') return;
    if (processId!==undefined) this.processId=processId;
    this.sessionKey ||= randomUUID();
    this.service.observeSession(this.sessionKey);
    const revision=this.service.getSyncSelectionRevision();
    if (state==='minimized' || !this.service.needsGameSelection || this.openedRevision===revision) return;
    this.openSelection();
    this.openedRevision=revision;
  }
}
