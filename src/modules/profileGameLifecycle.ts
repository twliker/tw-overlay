import { randomUUID } from 'crypto';
import type { ProfileService } from './profileService';

export type ProfileGameState='running' | 'minimized' | 'not-running';

/** 기능 계약 — 게임이 보일 때 한 번 선택창을 연다. 최소화/숨김 시작은 세션만 준비하고 표시를 보류한다.
 * 같은 프로세스의 running↔minimized나 HWND 변경은 같은 세션이다. PID 교체는 새 세션이다.
 * 사용자가 이미 선택했다면 복귀 때 다시 열지 않는다. Google 적용으로 선택이 해제되면
 * 같은 세션에서도 새 요청으로 취급하여 게임이 보이는 시점에 다시 연다.
 * 추적 오류/일시적 샘플은 호출자가 확정 후 전달한다. 회귀: profile-storage/lifecycle/windows.
 * 저장/창 표시 실패는 같은 세션 키로 재시도하며 이전 프로필로 기록하지 않는다.
 * 프로필이 하나뿐이고 이름·서버가 있으면(autoSelect) 선택창 없이 그 프로필을 바로 고른다(최소화 시작 포함).
 * 이름·서버가 비었거나(신규 설치 첫 실행) 프로필이 둘 이상이면 지금처럼 선택창을 연다. 자동 선택이 실패하면
 * 게임이 보일 때 선택창을 연다. 자동 선택은 게임이 켜질 때(새 세션)의 선택 요청에만 한다. 플레이 중 Google 적용으로 생긴
 * 다시 선택 요청(이름·서버 변경 확인, 원격 교체)은 사용자가 확인하도록 선택창을 연다.
 * 회귀: check-profile-auto-select.ts, check-profile-upgrade*.ts.
 */
export class ProfileGameLifecycle {
  private sessionKey:string | null=null;
  private openedRevision:number | undefined;
  private pendingEnd:'end' | 'replacement' | null=null;
  private processId:number | undefined;
  private ending?:Promise<void>;
  private latestDuringEnd?:[ProfileGameState,number | undefined];
  private lastState:ProfileGameState='not-running';
  /** 자동 선택을 시도할 선택 요청(revision): 게임이 켜져 세션이 생길 때의 요청. 실패하면 비워 같은 요청에서는 선택창으로 넘어간다. */
  private autoSelectRevision:number | undefined;
  /** autoSelect: 자동으로 쓸 프로필이 있으면 선택을 시작하고 그 결과(성공 여부)를, 없으면 undefined를 돌려준다. */
  constructor(private readonly service:ProfileService,private readonly openSelection:() => void,
    private readonly autoSelect?:() => Promise<boolean> | undefined) {}

  get currentProcessId():number | undefined {return this.processId;}

  observe(state:ProfileGameState,processId?:number):void | Promise<void> {
    if (this.ending) {this.latestDuringEnd=[state,processId];return this.ending;}
    const replaced=processId!==undefined && this.processId!==undefined && processId!==this.processId;
    if (this.sessionKey && (replaced || state==='not-running')) {
      this.pendingEnd=replaced ? 'replacement' : 'end';
      this.sessionKey=null;this.openedRevision=undefined;this.processId=undefined;this.autoSelectRevision=undefined;
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
    this.lastState=state;
    if (state==='not-running') return;
    if (processId!==undefined) this.processId=processId;
    const starting=!this.sessionKey;
    this.sessionKey ||= randomUUID();
    this.service.observeSession(this.sessionKey);
    const revision=this.service.getSyncSelectionRevision();
    if (starting) this.autoSelectRevision=revision;
    if (!this.service.needsGameSelection || this.openedRevision===revision) return;
    // 게임이 켜질 때의 요청에서만 자동 선택한다. 이미 실패했으면 다시 시도하지 않는다(최소화 동안 폴링마다 재시도하지 않게).
    const automatic=this.autoSelectRevision===revision ? this.autoSelect?.() : undefined;
    if (automatic) {
      this.openedRevision=revision;
      automatic.catch(()=>false).then(selected=>{
        if (selected || this.openedRevision!==revision || !this.service.needsGameSelection) return;
        // 자동 선택 실패: 게임이 보이면 바로, 아니면 다음에 보일 때 선택창을 연다.
        if (this.autoSelectRevision===revision) this.autoSelectRevision=undefined;
        this.openedRevision=undefined;
        if (this.lastState==='running') {this.openSelection();this.openedRevision=revision;}
      });
      return;
    }
    if (state==='minimized') return;
    this.openSelection();
    this.openedRevision=revision;
  }
}
