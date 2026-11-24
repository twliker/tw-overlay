import { createSocket } from 'dgram';
import { randomBytes } from 'crypto';
import type { ProfileClockStamp } from '../shared/playProfiles';

export interface InternetTimeSample { utcMs: number; uncertaintyMs: number }
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);

/** Google Public NTP의 응답을 검증하며 OS 시계/설정은 변경하지 않는다. */
export function queryInternetTime(timeoutMs = 2000): Promise<InternetTimeSample> {
  return new Promise((resolve,reject) => {
    const socket = createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x23; // LI=0, version=4, client.
    const nonce = randomBytes(8);
    nonce.copy(packet,40);
    const start = monotonicMs();
    let finished = false;
    const complete = (error?: Error, sample?: InternetTimeSample) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try { socket.close(); } catch { /* DNS/바인딩 전에 실패한 소켓 */ }
      if (error) reject(error); else resolve(sample!);
    };
    const timer = setTimeout(() => complete(new Error('인터넷 시간 조회 시간 초과')),timeoutMs);
    socket.once('error',error => complete(error));
    socket.on('message',message => {
      if (message.length < 48 || (message[0]&7) !== 4 || (message[0]>>6) === 3
        || message[1] === 0 || message[1] > 15 || !message.subarray(24,32).equals(nonce)) return;
      const readTime = (offset: number) => {
        let seconds = message.readUInt32BE(offset);
        if (seconds < 2_208_988_800) seconds += 4_294_967_296; // NTP era rollover in 2036.
        return (seconds-2_208_988_800)*1000 + message.readUInt32BE(offset+4)*1000/4_294_967_296;
      };
      const receive = readTime(32), transmit = readTime(40), elapsed = monotonicMs()-start;
      const processing = transmit-receive;
      if (!Number.isFinite(transmit) || processing < 0 || processing > elapsed+10) return;
      const network = Math.max(0,elapsed-processing);
      complete(undefined,{utcMs:transmit+network/2,
        uncertaintyMs:network/2+message.readUInt32BE(8)*1000/65_536+1});
    });
    socket.send(packet,123,'time.google.com',error => { if (error) complete(error); });
  });
}

/** 게임 로그(PC 시계)로 적힌 시각을 보정 시계(인터넷 기준) 시간축으로 옮긴다. 보정량은 지금의
 * 보정 시각 − PC 시계다. 인터넷 기준이 없으면(unverified) 보정 시계가 곧 PC 시계이므로 그대로 둔다.
 * 과거 로그도 현재 보정량을 쓴다(PC 시계 오차는 짧은 기간 동안 거의 일정하다고 본다). */
export function toCorrectedTime(localMs:number,stamp:ProfileClockStamp | null | undefined,wallNow:number=Date.now()):number {
  if (!stamp || stamp.source!=='internet' || !Number.isFinite(localMs) || !Number.isFinite(stamp.utcMs)) return localMs;
  return localMs+(stamp.utcMs-wallNow);
}

/** 리셋 주기 판정용 시간축 — 기능 계약.
 * 숙제 체크리스트(contentsChecker)와 어벤던로드 주간 HUD(abandonedTracker)는 "지금"을 보정 시계로 판정한다.
 * 채팅 로그 시각은 PC 시계로 적히므로 그대로 비교하면 PC 시계가 빠를 때 리셋 직전 기록이 다음 주기로
 * 저장되어 초기화를 피하고, 느릴 때 리셋 직후 기록이 지난 주기로 빠진다. 두 모듈은 이 함수 하나로
 * now()와 fromLocal(로그 시각)을 같은 보정 시간축에서 얻는다. 프로필 런타임이 없으면 PC 시계다.
 * 기록 원본 ID(중복 방지 키)는 보정량이 바뀌어도 같아야 하므로 원래 로그 시각으로 만든다.
 * 회귀: check-abandoned-visibility-policy.ts, check-profile-recording.ts. */
export function createCorrectedTimeline(read:() => ProfileClockStamp | null | undefined,wall:() => number) {
  return {
    now:():number => read()?.utcMs ?? wall(),
    fromLocal:(localMs:number):number => toCorrectedTime(localMs,read(),wall()),
  };
}

/**
 * 기능 계약: 인터넷 기준 UTC + 단조 경과시간. 저장마다 조회하지 않고 실패 시 로컬 저장을 유지한다.
 * 조회 실패/오래된 기준은 현재 Windows 시계로 돌아가 unverified로 표시한다. 이미 저장한 시각은 바꾸지 않는다.
 */
export class ProfileClock {
  private reference:(InternetTimeSample & {monotonic:number}) | null=null;
  private refreshing: Promise<boolean> | null = null;
  private generation=0;
  constructor(private readonly query = queryInternetTime,private readonly elapsed = monotonicMs,private readonly wall = Date.now) {}
  now(): ProfileClockStamp {
    const reference=this.reference;
    if (reference) {
      const age=Math.max(0,this.elapsed()-reference.monotonic);
      if (age<60*60*1000) return {utcMs:Math.round(reference.utcMs+age),source:'internet',
        uncertaintyMs:reference.uncertaintyMs+age*0.0005};
    }
    return {utcMs:this.wall(),source:'unverified',uncertaintyMs:null};
  }
  /** 절전 복귀 직후에는 갱신 성공 전까지 이전 기준을 신뢰한 시간으로 표시하지 않는다. */
  invalidate():void {this.reference=null;this.refreshing=null;++this.generation;}
  /** 이미 수행한 Google HTTPS 응답의 Date도 사용할 수 있다. NTP보다 부정확한 표본으로
   * 더 정확한 현재 기준을 낮추지 않으며 과거 변경에 저장된 stamp는 수정하지 않는다. */
  observeInternetTime(sample:InternetTimeSample):void {
    if (!Number.isFinite(sample.utcMs) || !Number.isFinite(sample.uncertaintyMs) || sample.uncertaintyMs<0) return;
    const current=this.now();
    if (current.source==='internet' && current.uncertaintyMs!==null && current.uncertaintyMs<sample.uncertaintyMs) return;
    this.reference={...sample,monotonic:this.elapsed()};
  }
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const generation=this.generation;
    this.refreshing = Promise.resolve().then(() => this.query()).then(sample => {
        if (generation!==this.generation) return false;
        if (!Number.isFinite(sample.utcMs) || !Number.isFinite(sample.uncertaintyMs) || sample.uncertaintyMs < 0) return false;
        this.observeInternetTime(sample);
        return true;
    },() => false).finally(() => { if (generation===this.generation) this.refreshing=null; });
    return this.refreshing;
  }
}
