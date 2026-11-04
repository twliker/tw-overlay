import { randomUUID } from 'crypto';
import type { ProfileService } from './profileService';

/** 기능 계약 — 창이 처음 발견될 때 한 번 선택한다. 앱 시작 때 이미 최소화된 게임도 포함한다.
 * running↔minimized는 같은 플레이 세션이다. 추적 오류/일시적 샘플은 호출자가 확정 후 전달한다.
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
    if (this.opened) return;
    this.sessionKey ||= randomUUID();
    this.service.beginSession(this.sessionKey);
    this.openSelection();
    this.opened=true;
  }
}
