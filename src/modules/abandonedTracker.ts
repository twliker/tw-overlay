/**
 * 기능 계약 — 어벤던로드 세션 추적
 *
 * - `ABANDONED_ENTRY`, `ABANDONED_FEE`, `MAGIC_STONE_GAIN/LOSS` 로그를 한 세션의 지역별 도전,
 *   입장료, 마정석 증감과 추정 수익으로 조립합니다. 일반 득템 키워드와는 독립된 전용 로그입니다.
 * - 입장료와 지역 진입 로그의 순서는 일정하지 않으므로 15초 범위에서 앞/뒤 도착을 모두 매칭합니다.
 *   매칭되지 않은 입장료도 전체 수익에서 즉시 빼고 `unassignedFee`로 보존해 금액을 잃지 않습니다.
 * - 10회 도달 알림은 설정이 켜졌을 때만 Windows/HUD에 보내며, 통계 상태는 모든 관련 창에
 *   브로드캐스트합니다. 자동 숨김은 통계 수집을 중단하지 않습니다.
 * - 사용자가 직접 숨긴 상태는 활동으로 자동 해제하지 않고 명시적 표시 또는 다음 게임 세션에서만
 *   해제합니다. `reset()`은 통계를 초기화하되 기능 활성 설정은 유지합니다.
 */
import { chatParser } from './chatParser';
import * as config from './config';
import { log } from './logger';
import type { AbandonedRoadState } from '../shared/types';
import { broadcastToAllWindows } from './windowMessaging';
import { showSupportedDesktopNotification } from './desktopNotification';

export const ABANDONED_FEE_MATCH_WINDOW_MS = 15_000;

export function isAbandonedFeeMatchWithinWindow(firstDetectedAt: number, secondDetectedAt: number): boolean {
  const elapsed = secondDetectedAt - firstDetectedAt;
  return elapsed >= 0 && elapsed < ABANDONED_FEE_MATCH_WINDOW_MS;
}

class AbandonedTracker {
  private _started = false;
  private _abandonedState: AbandonedRoadState = {
    regions: {},
    profit: 0,
    isActive: false,
    isEnabled: true,
    stoneGains: {},
    stoneLosses: {},
    totalFee: 0,
    unassignedFee: 0,
    currentRegion: '',
    regionDetails: {},
  };

  private _abandonedHideTimer: NodeJS.Timeout | null = null;
  // 사용자가 단축키/UI로 숨긴 상태는 자동 숨김과 다르다. 활동 이벤트는 통계를 계속
  // 갱신하지만 이 억제를 해제할 수 없으며, 명시적 표시 또는 다음 게임 세션만 해제한다.
  private _manualVisibilitySuppressed = false;
  private _pendingAbandonedFee: { amount: number; detectedAt: number } | null = null;

  private _lastEntryRegion: string | null = null;
  private _lastEntryTime = 0;

  // 마정석 가치 (금화 주머니 50만 Seed 기준)
  private readonly MAGIC_STONE_VALUES: Record<string, number> = {
    '하급': 500000,
    '중급': 5000000,
    '상급': 50000000,
    '최상급': 500000000,
  };

  public start(): void {
    if (this._started) {
      log('[ABANDONED] 이미 시작되어 중복 이벤트 리스너 등록을 건너뜁니다.');
      return;
    }
    this._started = true;
    const currentConfig = config.load();
    this._abandonedState.isEnabled = currentConfig.abandonedEnabled ?? true;

    // 입장료 감지 (도전 횟수보다 먼저 오거나 나중에 오는 모든 경우 대응)
    chatParser.on('ABANDONED_FEE', (data) => {
      if (!this._abandonedState.isEnabled) return;

      const now = Date.now();
      // 직전 15초 이내에 도전 횟수가 먼저 들어온 경우 해당 지역에 즉시 귀속
      if (this._lastEntryRegion && isAbandonedFeeMatchWithinWindow(this._lastEntryTime, now)) {
        const region = this._lastEntryRegion;
        this._lastEntryRegion = null;

        const rd = this._abandonedState.regionDetails;
        if (!rd[region]) rd[region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {} };
        rd[region].totalFee += data.amount;

        // 입장료는 감지 즉시 전체 수익에 반영하고, 지역 귀속만 시간 범위로 결정한다.
        this._abandonedState.profit -= data.amount;
        this._abandonedState.totalFee += data.amount;
        log(`[ABANDONED] 입장료(후도착 귀속): ${region} -${data.amount}, 총입장료: ${this._abandonedState.totalFee}, 현재 수익: ${this._abandonedState.profit}`);
        this.activateFromActivity();
        return;
      }

      // 매칭되지 않은 입장료도 전체 수익에서는 즉시 차감하고 미귀속으로 보존한다.
      this._lastEntryRegion = null;
      this._abandonedState.profit -= data.amount;
      this._abandonedState.totalFee += data.amount;
      this._abandonedState.unassignedFee = (this._abandonedState.unassignedFee || 0) + data.amount;
      this._pendingAbandonedFee = { amount: data.amount, detectedAt: now };
      log(`[ABANDONED] 입장료(미귀속 대기): -${data.amount}, 미귀속: ${this._abandonedState.unassignedFee}`);
      this.activateFromActivity();
    });

    // 도전 횟수 감지
    chatParser.on('ABANDONED_ENTRY', (data) => {
      if (!this._abandonedState.isEnabled) return;

      const now = Date.now();
      const pendingFee = this._pendingAbandonedFee;
      const fee = pendingFee && isAbandonedFeeMatchWithinWindow(pendingFee.detectedAt, now)
        ? pendingFee.amount
        : 0;
      this._pendingAbandonedFee = null;
      if (fee > 0) {
        // 전체 수익/총 입장료에는 선도착 시 이미 반영했으므로 지역 귀속만 이동한다.
        this._abandonedState.unassignedFee = Math.max(0, (this._abandonedState.unassignedFee || 0) - fee);
        this._lastEntryRegion = null;
        log(`[ABANDONED] 입장료(선도착 정산): ${data.region} ${data.count}회 -${fee}, 총입장료: ${this._abandonedState.totalFee}, 현재 수익: ${this._abandonedState.profit}`);
      } else {
        if (pendingFee) {
          log(`[ABANDONED] 시간 범위를 지난 입장료는 미귀속으로 유지: ${pendingFee.amount}`);
        }
        // 입장료가 뒤따라올 수 있으므로 기록
        this._lastEntryRegion = data.region;
        this._lastEntryTime = now;
      }

      this._abandonedState.regions[data.region] = data.count;
      this._abandonedState.currentRegion = data.region;

      const rd = this._abandonedState.regionDetails;
      if (!rd[data.region]) rd[data.region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {} };
      rd[data.region].count = data.count;
      rd[data.region].totalFee += fee;

      if (data.count === 10) {
        const cfg = config.load();
        if (cfg.abandonedAlertEnabled !== false) {
          showSupportedDesktopNotification('어벤던로드 알림', `${data.region} 지역 10회 도달! 최고 효율 구간입니다.`);
          broadcastToAllWindows('abandoned-alert', { region: data.region, count: data.count });
        }
      }
      this.activateFromActivity();
    });

    // 마정석 획득
    chatParser.on('MAGIC_STONE_GAIN', (data) => {
      if (!this._abandonedState.isEnabled) return;

      const gradeKey = data.grade.trim();
      const unitValue = this.MAGIC_STONE_VALUES[gradeKey] || 0;
      this._abandonedState.profit += (unitValue * data.count);
      this._abandonedState.stoneGains[gradeKey] = (this._abandonedState.stoneGains[gradeKey] ?? 0) + data.count;
      const region = this._abandonedState.currentRegion;
      if (region) {
        if (!this._abandonedState.regionDetails[region]) {
          this._abandonedState.regionDetails[region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {} };
        }
        const rds = this._abandonedState.regionDetails[region].stoneGains;
        rds[gradeKey] = (rds[gradeKey] ?? 0) + data.count;
      }
      this.activateFromActivity();
      log(`[ABANDONED] 마정석 획득: ${gradeKey} x${data.count}, 수익 추가: +${unitValue * data.count}, 현재 수익: ${this._abandonedState.profit}`);
    });

    // 마정석 소실
    chatParser.on('MAGIC_STONE_LOSS', (data) => {
      if (!this._abandonedState.isEnabled) return;

      const gradeKey = data.grade.trim();
      const unitValue = this.MAGIC_STONE_VALUES[gradeKey] || 0;
      this._abandonedState.profit -= (unitValue * data.count);
      this._abandonedState.stoneLosses[gradeKey] = (this._abandonedState.stoneLosses[gradeKey] ?? 0) + data.count;
      const region = this._abandonedState.currentRegion;
      if (region) {
        if (!this._abandonedState.regionDetails[region]) {
          this._abandonedState.regionDetails[region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {} };
        }
        const rdl = this._abandonedState.regionDetails[region].stoneLosses;
        rdl[gradeKey] = (rdl[gradeKey] ?? 0) + data.count;
      }
      this.activateFromActivity();
      log(`[ABANDONED] 마정석 소실: ${gradeKey} x${data.count}, 수익 차감: -${unitValue * data.count}, 현재 수익: ${this._abandonedState.profit}`);
    });
  }

  private activateFromActivity(): void {
    this._abandonedState.isActive = !this._manualVisibilitySuppressed;
    this.refreshAbandonedActivity();
  }

  private refreshAbandonedActivity(): void {
    if (this._abandonedHideTimer) clearTimeout(this._abandonedHideTimer);

    if (this._abandonedState.isActive) {
      const minutes = config.load().abandonedAutoHideMinutes ?? 10;
      this._abandonedHideTimer = setTimeout(() => {
        this._abandonedState.isActive = false;
        this.notifyAbandonedUpdate();
      }, minutes * 60 * 1000);
    }
    this.notifyAbandonedUpdate();
  }

  private notifyAbandonedUpdate(): void {
    broadcastToAllWindows('abandoned-update', this._abandonedState);
  }

  public getState(): AbandonedRoadState {
    return this._abandonedState;
  }

  public forceVisible(visible: boolean): void {
    this._manualVisibilitySuppressed = !visible;
    this._abandonedState.isActive = visible;
    if (visible) {
      this.refreshAbandonedActivity();
      return;
    }
    if (this._abandonedHideTimer) clearTimeout(this._abandonedHideTimer);
    this._abandonedHideTimer = null;
    this.notifyAbandonedUpdate();
  }

  public toggleVisibility(): void {
    this.forceVisible(!this._abandonedState.isActive);
  }

  public setEnabled(enabled: boolean): void {
    this._abandonedState.isEnabled = enabled;
    config.save({ abandonedEnabled: enabled });
    if (!enabled) {
      this._manualVisibilitySuppressed = false;
      this._abandonedState.isActive = false;
      if (this._abandonedHideTimer) clearTimeout(this._abandonedHideTimer);
      this._abandonedHideTimer = null;
      this._pendingAbandonedFee = null;
      this._lastEntryRegion = null;
      this._lastEntryTime = 0;
    }
    this.notifyAbandonedUpdate();
  }

  /** 새 게임 프로세스 세션은 이전 세션의 사용자 숨김 의도를 상속하지 않는다. */
  public beginGameSession(): void {
    this._manualVisibilitySuppressed = false;
  }

  public reset(): void {
    this._abandonedState = {
      regions: {}, profit: 0, isActive: false,
      isEnabled: this._abandonedState.isEnabled,
      stoneGains: {}, stoneLosses: {}, totalFee: 0, unassignedFee: 0,
      currentRegion: '', regionDetails: {},
    };
    this._pendingAbandonedFee = null;
    this._manualVisibilitySuppressed = false;
    this._lastEntryRegion = null;
    this._lastEntryTime = 0;
    if (this._abandonedHideTimer) clearTimeout(this._abandonedHideTimer);
    this.notifyAbandonedUpdate();
  }
}

export const abandonedTracker = new AbandonedTracker();
