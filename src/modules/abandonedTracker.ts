/**
 * 기능 계약 — 어벤던로드 세션 추적
 *
 * - `ABANDONED_ENTRY`, `ABANDONED_FEE`, `MAGIC_STONE_GAIN/LOSS` 로그를 한 세션의 지역별 도전,
 *   입장료, 마정석 증감, 누(Nu) 조우 횟수와 추정 수익으로 조립합니다. 일반 득템 키워드와는 독립된 전용 로그입니다.
 * - 입장료와 지역 진입 로그의 순서는 일정하지 않으므로 15초 범위에서 앞/뒤 도착을 모두 매칭합니다.
 *   매칭되지 않은 입장료도 전체 수익에서 즉시 빼고 `unassignedFee`로 보존해 금액을 잃지 않습니다.
 * - 마정석 소실(`MAGIC_STONE_LOSS`) 감지 시 전체 및 해당 지역의 누 조우 횟수(`nuEncounters`)와
 *   등급별 소실량(`stoneLosses`)을 동시에 누적합니다.
 * - 누(Nu) 마정석 대량 획득 서버 전체 공지(`ABANDONED_NU_ACQUISITION`) 감지 시 마지막 발생 시각
 *   (`lastNuBroadcastTime`, `lastNuBroadcastText`)을 상태에 기록합니다.
 *   서버 전체 공지는 개인 던전 플레이 활동이 아니므로 숨김 상태의 HUD를 강제로 띄우지 않고 상태만 보존하며,
 *   HUD가 이미 활성화된 경우에만 화면을 실시간 갱신합니다. `reset()` 시에도 이 서버 공지 기록은 유지됩니다.
 * - 10회 도달 알림은 설정이 켜졌을 때만 Windows/HUD에 보내고 알림음(`abandonedAlertSound`,
 *   'none'이면 생략)을 재생하며, 통계 상태는 모든 관련 창에
 *   브로드캐스트합니다. 자동 숨김은 통계 수집을 중단하지 않습니다.
 * - 사용자가 직접 숨긴 상태는 활동으로 자동 해제하지 않고 명시적 표시 또는 다음 게임 세션에서만
 *   해제합니다. `reset()`은 통계를 초기화하되 기능 활성 설정은 유지합니다.
 * - HUD 통계는 한국 시각 월요일 06시마다 만료한다. 프로필 복원·조회·활동 전에도 검사해
 *   앱 종료/절전/미선택 중 지난 주 수치가 되살아나지 않게 한다. 일지 원본은 삭제하지 않는다.
 *   주기를 저장하지 않던 구형 HUD snapshot은 최초 복원 때 초기화한다. 누 서버 공지는 유지한다.
 *   리셋 판정은 인터넷 보정 시각이므로 기록의 주기 분류도 로그 시각(PC 시계)을 같은 보정 시간축으로 옮겨 한다.
 *   회귀: check-abandoned-visibility-policy.ts, check-profile-recording.ts.
 */
import {onProfileProgress} from './profileParserEvents';
import {deferTransientEffect,recordEventTime,transientEffectsAllowed} from './recordEffects';
import * as config from './config';
import { log } from './logger';
import type { AbandonedRoadState } from '../shared/types';
import { broadcastToAllWindows } from './windowMessaging';
import { showSupportedDesktopNotification } from './desktopNotification';
import * as wm from './windowManager';
import { getHomeworkCycleStart, getHomeworkCycleEnd } from '../shared/homeworkResetCycle';
import { getProfileRuntime } from './profileRuntime';
import { createCorrectedTimeline } from './profileClock';

const resetRule = { type: 'weekly' as const, dayOfWeek: 1, hour: 6 };
// 주간 리셋과 기록의 주기 분류는 같은 보정 시간축을 쓴다(profileClock.createCorrectedTimeline 계약).
// 입장료 매칭·자동 숨김처럼 로그 시각끼리 또는 PC 타이머와 비교하는 값은 그대로 PC 시계를 쓴다.
// PC 시계는 이 모듈의 Date.now로 명시한다(시간을 고정하는 검사와 같은 시계를 쓰도록).
const weeklyTimeline = createCorrectedTimeline(() => getProfileRuntime()?.service.store.syncClock(), () => Date.now());
const currentTime = () => weeklyTimeline.now();

export const ABANDONED_FEE_MATCH_WINDOW_MS = 15_000;

export function isAbandonedFeeMatchWithinWindow(firstDetectedAt: number, secondDetectedAt: number): boolean {
  const elapsed = secondDetectedAt - firstDetectedAt;
  return elapsed >= 0 && elapsed < ABANDONED_FEE_MATCH_WINDOW_MS;
}

class AbandonedTracker {
  private _started = false;
  // 모듈 로딩 중에는 profileRuntime 순환 의존성을 읽지 않는다. start/restore에서 기준 시각을 확인한다.
  private _cycleStart = getHomeworkCycleStart(resetRule, Date.now());
  private _resetTimer: NodeJS.Timeout | null = null;
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
    nuEncounters: 0,
    regionDetails: {},
  };

  private _abandonedHideTimer: NodeJS.Timeout | null = null;
  private _hideDeadline=0;
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
    this.checkReset();
    this.scheduleResetCheck();

    // 입장료 감지 (도전 횟수보다 먼저 오거나 나중에 오는 모든 경우 대응)
    onProfileProgress('ABANDONED_FEE', (data) => {
      if (!this.acceptCurrentCycleActivity()) return;
      if (!this._abandonedState.isEnabled) return;

      const now = recordEventTime();
      // 직전 15초 이내에 도전 횟수가 먼저 들어온 경우 해당 지역에 즉시 귀속
      if (this._lastEntryRegion && isAbandonedFeeMatchWithinWindow(this._lastEntryTime, now)) {
        const region = this._lastEntryRegion;
        this._lastEntryRegion = null;

        const rd = this._abandonedState.regionDetails;
        if (!rd[region]) rd[region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {}, nuEncounters: 0 };
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
    onProfileProgress('ABANDONED_ENTRY', (data) => {
      if (!this.acceptCurrentCycleActivity()) return;
      if (!this._abandonedState.isEnabled) return;

      const now = recordEventTime();
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
      if (!rd[data.region]) rd[data.region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {}, nuEncounters: 0 };
      rd[data.region].count = data.count;
      rd[data.region].totalFee += fee;

      if (data.count === 10 && transientEffectsAllowed()) {
        const cfg = config.load();
        if (cfg.abandonedAlertEnabled !== false) {
          // 기록 transaction 안에서 불리므로 알림·소리는 commit 뒤에 낸다. 취소되면 소리만 나고
          // sendPlaySound가 쓴 알람 로그는 함께 취소되는 어긋남을 막는다(다른 알림음과 같은 규칙).
          const region = data.region, count = data.count;
          const soundFile = cfg.abandonedAlertSound || 'orb.mp3';
          const volume = cfg.abandonedAlertVolume ?? 40;
          deferTransientEffect(() => {
            showSupportedDesktopNotification('어벤던로드 알림', `${region} 지역 10회 도달! 최고 효율 구간입니다.`);
            broadcastToAllWindows('abandoned-alert', { region, count });
            if (soundFile !== 'none') {
              wm.sendPlaySound({
                label: '어벤던로드 10회 완료',
                soundFile,
                volume,
                isCustom: true,
                logMessage: `[어벤던로드] ${region} 지역 10회 도달`
              });
            }
          });
        }
      }
      this.activateFromActivity();
    });

    // 마정석 획득
    onProfileProgress('MAGIC_STONE_GAIN', (data) => {
      if (!this.acceptCurrentCycleActivity()) return;
      if (!this._abandonedState.isEnabled) return;

      const gradeKey = data.grade.trim();
      const unitValue = this.MAGIC_STONE_VALUES[gradeKey] || 0;
      this._abandonedState.profit += (unitValue * data.count);
      this._abandonedState.stoneGains[gradeKey] = (this._abandonedState.stoneGains[gradeKey] ?? 0) + data.count;
      const region = this._abandonedState.currentRegion;
      if (region) {
        if (!this._abandonedState.regionDetails[region]) {
          this._abandonedState.regionDetails[region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {}, nuEncounters: 0 };
        }
        const rds = this._abandonedState.regionDetails[region].stoneGains;
        rds[gradeKey] = (rds[gradeKey] ?? 0) + data.count;
      }
      this.activateFromActivity();
      log(`[ABANDONED] 마정석 획득: ${gradeKey} x${data.count}, 수익 추가: +${unitValue * data.count}, 현재 수익: ${this._abandonedState.profit}`);
    });

    // 마정석 소실 (누 조우)
    onProfileProgress('MAGIC_STONE_LOSS', (data) => {
      if (!this.acceptCurrentCycleActivity()) return;
      if (!this._abandonedState.isEnabled) return;

      const gradeKey = data.grade.trim();
      const unitValue = this.MAGIC_STONE_VALUES[gradeKey] || 0;
      this._abandonedState.profit -= (unitValue * data.count);
      this._abandonedState.stoneLosses[gradeKey] = (this._abandonedState.stoneLosses[gradeKey] ?? 0) + data.count;
      this._abandonedState.nuEncounters = (this._abandonedState.nuEncounters ?? 0) + 1;
      const region = this._abandonedState.currentRegion;
      if (region) {
        if (!this._abandonedState.regionDetails[region]) {
          this._abandonedState.regionDetails[region] = { count: 0, totalFee: 0, stoneGains: {}, stoneLosses: {}, nuEncounters: 0 };
        }
        const rdl = this._abandonedState.regionDetails[region].stoneLosses;
        rdl[gradeKey] = (rdl[gradeKey] ?? 0) + data.count;
        this._abandonedState.regionDetails[region].nuEncounters = (this._abandonedState.regionDetails[region].nuEncounters ?? 0) + 1;
      }
      this.activateFromActivity();
      log(`[ABANDONED] 마정석 소실: ${gradeKey} x${data.count}, 수익 차감: -${unitValue * data.count}, 누 조우 횟수: ${this._abandonedState.nuEncounters}, 현재 수익: ${this._abandonedState.profit}`);
    });

    // 누(Nu) 마정석 대량 획득 서버 전체 공지 (숨김 상태 HUD를 강제로 열지 않고 상태 보존)
    onProfileProgress('ABANDONED_NU_ACQUISITION', (data) => {
      const now = recordEventTime();
      this._abandonedState.lastNuBroadcastTime = now;
      this._abandonedState.lastNuBroadcastText = data.timestamp;
      log(`[ABANDONED] 누 마정석 대량 획득 전체 공지 감지: ${data.timestamp} (${data.grade ?? '마정석'}) - ${data.message}`);
      if (this._abandonedState.isActive) {
        this.notifyAbandonedUpdate();
      }
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
      this._hideDeadline=recordEventTime()+minutes*60*1000;
      const remaining=this._hideDeadline-Date.now();
      this._abandonedHideTimer = setTimeout(() => {
        this._abandonedState.isActive = false;
        this.notifyAbandonedUpdate();
      }, Math.max(0,remaining));
      if (remaining<=0) this._abandonedState.isActive=false;
    }
    this.notifyAbandonedUpdate();
  }

  private notifyAbandonedUpdate(): void {
    broadcastToAllWindows('abandoned-update', this._abandonedState);
  }

  public getState(): AbandonedRoadState {
    this.checkReset();
    return this._abandonedState;
  }

  public forceVisible(visible: boolean): void {
    this.checkReset();
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
    config.save({ abandonedEnabled: enabled });
    this.applyEnabled(enabled);
  }

  /** 저장이 확정된 설정을 재저장·통계 초기화 없이 런타임에 반영한다. */
  public applyEnabled(enabled: boolean): void {
    this._abandonedState.isEnabled = enabled;
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
    this.checkReset();
    this._manualVisibilitySuppressed = false;
  }

  public checkReset(): void {
    const cycle = getHomeworkCycleStart(resetRule, currentTime());
    if (this._cycleStart === cycle) return;
    const suppressed = this._manualVisibilitySuppressed;
    this.reset();
    this._manualVisibilitySuppressed = suppressed;
  }

  private acceptCurrentCycleActivity(): boolean {
    this.checkReset();
    // 선택 대기 중 주간 경계를 넘긴 기록은 일지에 보관하되 이번 주 HUD에 합산하지 않는다.
    return getHomeworkCycleStart(resetRule, weeklyTimeline.fromLocal(recordEventTime())) === this._cycleStart;
  }

  private scheduleResetCheck(): void {
    if (this._resetTimer) clearTimeout(this._resetTimer);
    const now = currentTime();
    // 경계에 맞춰 실행하며 절전 복귀와 인터넷 시간 보정도 최대 1분 안에 재확인한다.
    this._resetTimer = setTimeout(() => {
      this._resetTimer = null;
      this.checkReset();
      this.scheduleResetCheck();
    }, Math.max(1, Math.min(60_000, getHomeworkCycleEnd(resetRule, now) - now)));
    this._resetTimer.unref?.();
  }

  public reset(): void {
    this._cycleStart = getHomeworkCycleStart(resetRule, currentTime());
    const lastNuBroadcastTime = this._abandonedState.lastNuBroadcastTime;
    const lastNuBroadcastText = this._abandonedState.lastNuBroadcastText;
    this._abandonedState = {
      regions: {}, profit: 0, isActive: false,
      isEnabled: this._abandonedState.isEnabled,
      stoneGains: {}, stoneLosses: {}, totalFee: 0, unassignedFee: 0,
      currentRegion: '', regionDetails: {},
      nuEncounters: 0,
      lastNuBroadcastTime,
      lastNuBroadcastText,
    };
    this._pendingAbandonedFee = null;
    this._manualVisibilitySuppressed = false;
    this._lastEntryRegion = null;
    this._lastEntryTime = 0;
    if (this._abandonedHideTimer) clearTimeout(this._abandonedHideTimer);
    this._abandonedHideTimer = null;
    this._hideDeadline = 0;
    this.notifyAbandonedUpdate();
  }

  public captureProfileState() {
    this.checkReset();
    return structuredClone({cycleStart:this._cycleStart,state:this._abandonedState,suppressed:this._manualVisibilitySuppressed,pendingFee:this._pendingAbandonedFee,
      lastRegion:this._lastEntryRegion,lastEntryTime:this._lastEntryTime,hideDeadline:this._hideDeadline});
  }
  public restoreProfileState(snapshot:ReturnType<AbandonedTracker['captureProfileState']> | null):void {
    if (this._abandonedHideTimer) clearTimeout(this._abandonedHideTimer);this._abandonedHideTimer=null;
    this._abandonedState=snapshot ? structuredClone(snapshot.state) : {regions:{},profit:0,isActive:false,isEnabled:true,stoneGains:{},stoneLosses:{},totalFee:0,unassignedFee:0,currentRegion:'',regionDetails:{},nuEncounters:0};
    this._manualVisibilitySuppressed=snapshot?.suppressed || false;this._pendingAbandonedFee=snapshot?.pendingFee || null;
    this._lastEntryRegion=snapshot?.lastRegion || null;this._lastEntryTime=snapshot?.lastEntryTime || 0;this._hideDeadline=snapshot?.hideDeadline || 0;
    this._abandonedState.isEnabled=config.load().abandonedEnabled!==false;
    this._cycleStart = snapshot?.cycleStart ?? NaN;
    this.checkReset();
    if (!this._abandonedState.isEnabled) this._abandonedState.isActive=false;
    const remaining=this._hideDeadline-Date.now();
    if (this._abandonedState.isActive && remaining>0) this._abandonedHideTimer=setTimeout(() => {this._abandonedState.isActive=false;this.notifyAbandonedUpdate();},remaining);
    else this._abandonedState.isActive=false;
    this.notifyAbandonedUpdate();
  }
}

export const abandonedTracker = new AbandonedTracker();
