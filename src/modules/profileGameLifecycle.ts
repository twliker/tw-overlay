import { randomUUID } from 'crypto';
import type { ProfileService } from './profileService';

/** 기능 계약 — 게임이 보일 때 한 번 선택창을 연다. 최소화/숨김 시작은 세션만 준비하고 표시를 보류한다.
 * running↔minimized는 같은 플레이 세션이다. 숨김 중 감지한 기록은 선택 전 대기로 보존한다.
 * 사용자가 시스템 메뉴에서 이미 선택했다면 복귀 때 선택창을 다시 열지 않는다.
 * 추적 오류/일시적 샘플은 호출자가 확정 후 전달한다. 회귀: profile-storage/lifecycle/windows.
 * 저장/창 표시 실패는 같은 세션 키로 재시도하며 이전 프로필로 기록하지 않는다.
 */
export class ProfileGameLifecycle {
  private sessionKey:string | null=null;
  private opened=false;
  private needsEnd=false;
  constructor(private readonly service:ProfileService,private readonly openSelection:() => void) {}

  observe(state:'running' | 'minimized' | 'not-running'):void {
    if (state==='not-running') {
      if (this.sessionKey || this.needsEnd) {
        this.sessionKey=null;this.opened=false;this.needsEnd=true;
        this.service.endSession();this.needsEnd=false;
      }
      return;
    }
    if (this.needsEnd) {this.service.endSession();this.needsEnd=false;}
    this.sessionKey ||= randomUUID();
    this.service.beginSession(this.sessionKey);
    if (state==='minimized' || this.opened) return;
    if (this.service.status().selectionRequired) this.openSelection();
    this.opened=true;
  }
}
