import type { XpEfficiencyState, XpEfficiencyWarning } from './types';

const WINDOW_MS = 5 * 60_000;
const WARMUP_MS = 60_000;
const MIN_SAMPLES = 30;
const COOLDOWN_MS = 60_000;
interface Bucket { at: number; sum: number; count: number }

/** 1회 획득량의 최근 5분 평균. 초별 합계로 보관해 채팅 속도와 무관하게 메모리를 제한한다. */
export class XpEfficiencyMonitor {
  private buckets: Bucket[] = [];
  private seed: { amount: number; at: number }[] = [];
  private startedAt: number | null = null;
  private lastObservedAt: number | null = null;
  private lowCount = 0;
  private lastAlertAt = -Infinity;
  private warning: XpEfficiencyWarning | null = null;

  reset(): void {
    this.buckets = [];
    this.seed = [];
    this.startedAt = null;
    this.lastObservedAt = null;
    this.lowCount = 0;
    this.lastAlertAt = -Infinity;
    this.warning = null;
  }

  private totals(now: number): { sum: number; count: number } {
    this.buckets = this.buckets.filter(bucket => bucket.at > now - WINDOW_MS && bucket.at <= now);
    return this.buckets.reduce((total, bucket) => ({ sum: total.sum + bucket.sum, count: total.count + bucket.count }), { sum: 0, count: 0 });
  }

  observe(amount: number, now: number, dropPercent: number): XpEfficiencyWarning | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (this.lastObservedAt !== null && (now < this.lastObservedAt || now - this.lastObservedAt > WINDOW_MS)) this.reset();
    this.lastObservedAt = now;
    this.startedAt ??= now;
    const total = this.totals(now);

    // 초기 표본의 중앙값으로 큰 일회성 보상을 걸러낸 뒤 산술평균을 시작한다.
    if (this.seed.length < MIN_SAMPLES) {
      this.seed.push({ amount, at: now });
      if (this.seed.length === MIN_SAMPLES) {
        const sorted = this.seed.map(sample => sample.amount).sort((a, b) => a - b);
        const median = (sorted[14] + sorted[15]) / 2;
        for (const sample of this.seed.filter(sample => sample.amount <= median * 3 && sample.at > now - WINDOW_MS)) {
          this.append(sample.amount, sample.at);
        }
      }
      return null;
    }

    const average = total.count ? total.sum / total.count : amount;
    // 퀘스트 보상 등의 큰 획득은 통계 합계에는 남기되 감소 감지의 기준에서는 제외한다.
    if (amount > average * 3) return null;
    const ready = total.count >= MIN_SAMPLES && now - this.startedAt >= WARMUP_MS;
    const low = ready && amount < average * (1 - dropPercent / 100);
    this.lowCount = low ? this.lowCount + 1 : 0;
    if (!low) this.warning = null;
    let alert: XpEfficiencyWarning | null = null;
    if (this.lowCount >= 3 && now - this.lastAlertAt >= COOLDOWN_MS) {
      alert = { at: now, average: Math.round(average), current: amount, dropPercent: Math.round((1 - amount / average) * 100) };
      this.warning = alert;
      this.lastAlertAt = now;
    }

    this.append(amount, now);
    return alert;
  }

  private append(amount: number, now: number): void {
    const second = Math.floor(now / 1000) * 1000;
    const last = this.buckets[this.buckets.length - 1];
    if (last && Math.floor(last.at / 1000) * 1000 === second) {
      last.sum += amount;
      last.count++;
    } else this.buckets.push({ at: now, sum: amount, count: 1 });
  }

  state(now: number, enabled: boolean, active: boolean): XpEfficiencyState {
    const { sum, count } = this.totals(now);
    const warmupSeconds = this.startedAt === null ? 60 : Math.max(0, Math.ceil((WARMUP_MS - (now - this.startedAt)) / 1000));
    const status = !enabled ? 'disabled' : !active ? 'paused' : warmupSeconds > 0 || count < MIN_SAMPLES ? 'warming' : this.warning ? 'low' : 'ready';
    return { status, average: count ? Math.round(sum / count) : 0, sampleCount: this.seed.length < MIN_SAMPLES ? this.seed.length : count, warmupSeconds, warning: this.warning };
  }
}
