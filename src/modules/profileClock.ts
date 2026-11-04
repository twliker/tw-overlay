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

/**
 * 기능 계약: 인터넷 기준 UTC + 단조 경과시간. 저장마다 조회하지 않고 실패 시 로컬 저장을 유지한다.
 * 조회 실패/오래된 기준은 unverified로 표시하며 뒤늦은 업로드 시각으로 과거 변경을 바꾸지 않는다.
 */
export class ProfileClock {
  private reference = { utcMs:Date.now(),monotonic:monotonicMs(),uncertaintyMs:null as number | null };
  private refreshing: Promise<boolean> | null = null;
  constructor(private readonly query = queryInternetTime,private readonly elapsed = monotonicMs) {
    this.reference.monotonic = this.elapsed();
  }
  now(): ProfileClockStamp {
    const age = Math.max(0,this.elapsed()-this.reference.monotonic);
    const trusted = this.reference.uncertaintyMs !== null && age < 60*60*1000;
    return {utcMs:Math.round(this.reference.utcMs+age),source:trusted ? 'internet' : 'unverified',
      uncertaintyMs:trusted ? this.reference.uncertaintyMs!+age*0.0005 : null};
  }
  /** 절전 복귀 직후에는 갱신 성공 전까지 이전 기준을 신뢰한 시간으로 표시하지 않는다. */
  invalidate():void {this.reference.uncertaintyMs=null;}
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
    this.refreshing = Promise.resolve().then(() => this.query()).then(sample => {
        if (!Number.isFinite(sample.utcMs) || !Number.isFinite(sample.uncertaintyMs) || sample.uncertaintyMs < 0) return false;
        this.reference = {...sample,monotonic:this.elapsed()};
        return true;
    },() => false).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
