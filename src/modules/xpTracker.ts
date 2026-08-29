/**
 * 기능 계약 — 경험치 세션 HUD와 경험의 정수 교환 추적
 *
 * - 사용자가 시작한 세션 동안 양수 `XP_CHANGED` 한 건을 처치 1회로 보아 총 경험치, EPM, 처치 수,
 *   분별 히스토리를 계산합니다. HUD 표시 여부와 세션 측정 상태는 별도이며 `xpAutoStart=true`일 때만
 *   앱 시작 시 측정을 자동 시작합니다.
 * - 경험의 정수 교환은 수동·자동 모두 공통으로 남는 정확한 100억 경험치 감소 배수만 인정합니다.
 *   자동 교환 뒤의 별도 획득 안내를 다시 더하지 않으며, 일반 사망/이동 감소를 정수로 환산하지 않습니다.
 * - 직접 획득한 `[경험의 정수]` 로그는 일지·오늘 요약 경로가 담당하며 이 tracker의 교환 카운트에는
 *   더하지 않습니다. `룬 경험의 심장`을 경험의 정수 별칭으로 감지하지 않습니다.
 * - 정수 임박 알림용 경험치는 세션과 독립적으로 항상 누적합니다. 정확한 100억 감소 교환을 보면
 *   경고 누적만 0으로 초기화하고, 정상 자동 교환 직전 오경고를 피하기 위한 10억 여유를 둬
 *   교환이 없을 때 110억·210억·310억 경계마다 한 번 경고합니다.
 *   세션 시작·중지·초기화는 이 경고 누적에 영향을 주지 않습니다.
 *   `essenceAlertEnabled/sound/volume`은 XP HUD 설정 창이 소유합니다.
 * - 경험치 UI 전송은 150ms로 묶어 고빈도 로그에서 renderer를 압박하지 않되, 중지·리셋 전에는 pending
 *   값을 flush해 마지막 획득량을 잃지 않습니다. `start()`는 리스너/타이머를 중복 등록하지 않습니다.
 */
import { chatParser } from './chatParser';
import * as config from './config';
import { log } from './logger';
import * as wm from './windowManager';
import {
  broadcastToAllWindows,
  sendToFirstWindowByPage,
} from './windowMessaging';
import type { AppConfig, XpStats } from '../shared/types';
import { updateEssenceWarningAccumulator } from '../shared/experienceEssence';

export { getEssenceExchangeCount, XP_PER_ESSENCE } from '../shared/experienceEssence';

export const QUEST_DEFINITIONS = {
  forge: { name: '대장간', target: 1500, icon: 'hammer' },
  golgotha: { name: '골고다', target: 1000, icon: 'shield' },
  void: { name: '공허', target: 800, icon: 'orbit' }
};

export function shouldAutoStartXpSession(configValue: Pick<AppConfig, 'xpAutoStart'>): boolean {
  return configValue.xpAutoStart === true;
}

/**
 * XP 추적 모듈 — 경험치 세션 통계, 분당 히스토리, 경험의 정수 알림, 팔색조 언덕 추적
 */
class XpTracker {
  private _started = false;
  private _sessionXP = 0;
  private _sessionKills = 0;
  private _startTime = Date.now();
  private _minuteHistory: number[] = [];
  private _lastMinuteTimestamp = Math.floor(Date.now() / 60000);
  private _currentMinuteXP = 0;
  private _historyTimer: NodeJS.Timeout | null = null;
  private _isActive = false;
  private _accumulatedTime = 0;

  // 경험의 정수 자동 교환 버프 미감지 알람
  private static readonly DEBUG_XP_MULTIPLIER = 1;
  private _essenceWarningXp = 0;
  private _sessionEssenceCount = 0;

  // 도전과제 추적 상태
  private _questActive = false;
  private _questType: 'forge' | 'golgotha' | 'void' | null = null;
  private _questStartKills = 0;
  private _questStartTime = 0;
  private _questTimer: NodeJS.Timeout | null = null;

  // 경험치 IPC 쓰로틀링 상태
  private _xpUpdateTimer: NodeJS.Timeout | null = null;
  private _lastGainForThrottledUpdate = 0;

  private sendToWindow(pageName: string, channel: string, ...args: unknown[]): void {
    sendToFirstWindowByPage(pageName, channel, ...args);
  }

  private sendToXpWindows(channel: string, ...args: unknown[]): void {
    this.sendToWindow('game-overlay.html', channel, ...args);
    this.sendToWindow('xp-hud.html', channel, ...args);
  }

  private scheduleXpUpdate(lastGain: number): void {
    this._lastGainForThrottledUpdate = lastGain;
    if (!this._xpUpdateTimer) {
      this._xpUpdateTimer = setTimeout(() => {
        this._xpUpdateTimer = null;
        this.flushXpUpdate();
      }, 150);
    }
  }

  public flushXpUpdate(): void {
    if (this._xpUpdateTimer) {
      clearTimeout(this._xpUpdateTimer);
      this._xpUpdateTimer = null;
    }
    const payload = this.buildXpPayload(this._lastGainForThrottledUpdate);
    this.sendToXpWindows('xp-update', payload);
  }

  public start(): void {
    if (this._started) {
      log('[XP_TRACKER] 이미 시작되어 중복 이벤트 리스너 등록을 건너뜁니다.');
      return;
    }
    this._started = true;
    const cfg = config.load();
    // 세션 추적과 HUD 표시는 서로 독립된 사용자 선택이다.
    // 기존 명시값은 config missing-only 병합으로 보존하고, true일 때만 자동 시작한다.
    this._isActive = shouldAutoStartXpSession(cfg);

    // 히스토리 갱신 타이머 (10초마다 분 롤오버 체크)
    if (this._historyTimer) clearInterval(this._historyTimer);
    this._historyTimer = setInterval(() => {
      if (this._isActive) this.checkMinuteRollover();
    }, 10000);

    // 도전과제 매크로 감지
    chatParser.on('NORMAL_CHAT', (data) => {
      if (data.message.includes('[twOverlay] 대장간 도전과제 시작')) {
        this.startQuest('forge');
      } else if (data.message.includes('[twOverlay] 골고다 도전과제 시작')) {
        this.startQuest('golgotha');
      } else if (data.message.includes('[twOverlay] 공허 도전과제 시작')) {
        this.startQuest('void');
      }
    });

    // 경험치 변동
    chatParser.on('XP_CHANGED', (data) => {
      // 경고용 누적은 세션 통계보다 먼저, 세션 활성 여부와 무관하게 처리합니다.
      // 세션을 일시정지하거나 초기화해도 자동 교환 버프 감시는 이어져야 합니다.
      const warningUpdate = updateEssenceWarningAccumulator(this._essenceWarningXp, data.amount);
      this._essenceWarningXp = warningUpdate.accumulatedXp;

      // 정수 교환 감지 (정수 1개당 정확히 100억 XP, 세션 총 획득 경험치는 유지)
      const exchangedCount = warningUpdate.exchangeCount;
      if (exchangedCount > 0) {
        // 세션 정수 횟수는 세션 통계이므로 측정 중인 교환만 더합니다.
        // 경고용 누적은 위 공통 처리에서 세션 상태와 무관하게 이미 0으로 초기화됐습니다.
        if (this._isActive) this._sessionEssenceCount += exchangedCount;
        this.scheduleXpUpdate(0);
        return;
      }

      if (warningUpdate.shouldAlert) {
        this._fireEssenceAlert();
      }

      // 테일즈위버의 정상적인 XP 감소는 정수 교환뿐이므로 설명되지 않는 음수는 합계에서 제외한다.
      if (data.amount < 0) {
        log(`[XP_TRACKER] 경험의 정수 교환 단위가 아닌 음수 XP 무시: ${data.amount}`);
        return;
      }

      if (!this._isActive) {
        // 경고 진행도는 HUD에 반영하되 세션 총 경험치·킬·분당 경험치는 변경하지 않습니다.
        this.scheduleXpUpdate(0);
        return;
      }

      const amount = data.amount > 0
        ? data.amount * XpTracker.DEBUG_XP_MULTIPLIER
        : data.amount;

      this.checkMinuteRollover();
      this._sessionXP = Math.max(0, this._sessionXP + amount);
      this._currentMinuteXP = Math.max(0, this._currentMinuteXP + amount);
      if (amount > 0) {
        this._sessionKills++;

        // 도전과제 킬 카운트 갱신 및 완료 검사
        if (this._questActive && this._questType) {
          const currentKills = this._sessionKills - this._questStartKills;
          const target = QUEST_DEFINITIONS[this._questType].target;
          if (currentKills >= target) {
            this.finishQuest();
          } else {
            this.sendToWindow('game-overlay.html', 'quest-update', { currentKills });
          }
        }

      }

      this.scheduleXpUpdate(amount);
    });
  }

  private getElapsedMs(): number {
    if (!this._isActive) {
      return this._accumulatedTime;
    }
    return this._accumulatedTime + (Date.now() - this._startTime);
  }

  private buildXpPayload(lastGain: number): XpStats {
    const elapsedMins = this.getElapsedMs() / 60000;
    const epm = Math.floor(this._sessionXP / Math.max(1, elapsedMins));
    const recentMins = Math.min(5, this._minuteHistory.length);
    let movingEpm = epm;
    if (recentMins > 0) {
      const recentSum = this._minuteHistory.slice(-recentMins).reduce((a, b) => a + b, 0) + this._currentMinuteXP;
      const denominator = recentMins + (Date.now() % 60000 / 60000);
      movingEpm = Math.floor(recentSum / Math.max(0.001, denominator));
    }
    return {
      total: this._sessionXP, epm, movingEpm, lastGain,
      history: [...this._minuteHistory, this._currentMinuteXP],
      kills: this._sessionKills,
      essenceCount: this._sessionEssenceCount,
      xpSinceLastExchange: this._essenceWarningXp,
      startTime: this._startTime,
      accumulatedTime: this._accumulatedTime,
      isActive: this._isActive
    };
  }

  public checkMinuteRollover(): void {
    const nowMinute = Math.floor(Date.now() / 60000);
    if (nowMinute > this._lastMinuteTimestamp) {
      const diff = nowMinute - this._lastMinuteTimestamp;
      for (let i = 0; i < diff; i++) {
        this._minuteHistory.push(i === 0 ? this._currentMinuteXP : 0);
        if (this._minuteHistory.length > 30) this._minuteHistory.shift();
      }
      this._currentMinuteXP = 0;
      this._lastMinuteTimestamp = nowMinute;
    }
  }

  private startQuest(type: 'forge' | 'golgotha' | 'void'): void {
    if (this._questTimer) clearTimeout(this._questTimer);
    
    this._questActive = true;
    this._questType = type;
    this._questStartKills = this._sessionKills;
    this._questStartTime = Date.now();
    
    const questName = QUEST_DEFINITIONS[type].name;
    const targetKills = QUEST_DEFINITIONS[type].target;
    log(`[XP_TRACKER] ${questName} 도전과제 추적 시작: 현재 킬수 ${this._questStartKills}, 목표 ${targetKills}`);
    
    // 20분 제한 시간 타이머 등록 (20분 = 1200000 ms)
    this._questTimer = setTimeout(() => {
      log(`[XP_TRACKER] ${questName} 도전과제 시간 초과 (20분 경과) - 취소 처리`);
      this.cancelQuest();
    }, 1200000);

    this.sendToWindow('game-overlay.html', 'quest-started', {
      questType: type,
      startTime: this._questStartTime,
      duration: 1200000,
      startKills: this._questStartKills,
      targetKills: targetKills
    });
  }

  private cancelQuest(): void {
    if (this._questTimer) {
      clearTimeout(this._questTimer);
      this._questTimer = null;
    }
    const questName = this._questType ? QUEST_DEFINITIONS[this._questType].name : '도전과제';
    this._questActive = false;
    this._questType = null;
    log(`[XP_TRACKER] ${questName} 도전과제 추적 취소됨`);
    
    this.sendToWindow('game-overlay.html', 'quest-cancelled');
  }

  private finishQuest(): void {
    if (this._questTimer) {
      clearTimeout(this._questTimer);
      this._questTimer = null;
    }
    const type = this._questType;
    const questName = type ? QUEST_DEFINITIONS[type].name : '도전과제';
    const targetKills = type ? QUEST_DEFINITIONS[type].target : 1500;
    this._questActive = false;
    this._questType = null;
    log(`[XP_TRACKER] ${questName} 도전과제 추적 완료! (${targetKills}마리 처치 달성)`);

    this.sendToWindow('game-overlay.html', 'quest-complete', { questType: type });

    // 완료 알림 사운드 재생
    const cfg = config.load();
    if (cfg.questCompleteAlertEnabled !== false) {
      const soundFile = cfg.questCompleteAlertSound || 'orb.mp3';
      const volume = cfg.questCompleteAlertVolume ?? 40;
      if (soundFile !== 'none') {
        wm.sendPlaySound({
          label: `${questName} 도전과제 완료`,
          soundFile,
          volume,
          isCustom: true
        });
      }
    }
  }

  public resetXp(): void {
    if (this._xpUpdateTimer) {
      clearTimeout(this._xpUpdateTimer);
      this._xpUpdateTimer = null;
    }
    if (this._questActive) {
      this.cancelQuest();
    }
    this._sessionXP = 0;
    this._sessionKills = 0;
    this._startTime = Date.now();
    this._accumulatedTime = 0;
    this._minuteHistory = [];
    this._currentMinuteXP = 0;
    this._lastMinuteTimestamp = Math.floor(Date.now() / 60000);
    this._sessionEssenceCount = 0;
    this._lastGainForThrottledUpdate = 0;

    log('[XP_TRACKER] XP 세션 초기화됨');

    this.sendToWindow('game-overlay.html', 'xp-update', this.buildXpPayload(0));
    this.sendToWindow('xp-hud.html', 'xp-reset-done', {
      startTime: this._startTime,
      accumulatedTime: 0,
      isActive: this._isActive,
      xpSinceLastExchange: this._essenceWarningXp,
    });
  }

  public getStats(): XpStats {
    if (this._isActive) {
      this.checkMinuteRollover();
    }
    const elapsedMins = this.getElapsedMs() / 60000;
    const epm = Math.floor(this._sessionXP / Math.max(1, elapsedMins));
    const recentMins = Math.min(5, this._minuteHistory.length);
    let movingEpm = epm;
    if (recentMins > 0) {
      const recentSum = this._minuteHistory.slice(-recentMins).reduce((a, b) => a + b, 0) + this._currentMinuteXP;
      const denominator = recentMins + (Date.now() % 60000 / 60000);
      movingEpm = Math.floor(recentSum / Math.max(0.001, denominator));
    }
    return {
      total: this._sessionXP, epm, movingEpm, startTime: this._startTime,
      history: [...this._minuteHistory, this._currentMinuteXP],
      kills: this._sessionKills,
      essenceCount: this._sessionEssenceCount,
      xpSinceLastExchange: this._essenceWarningXp,
      accumulatedTime: this._accumulatedTime,
      isActive: this._isActive
    };
  }

  public startSession(): void {
    if (this._isActive) return;
    const nowMinute = Math.floor(Date.now() / 60000);
    if (nowMinute > this._lastMinuteTimestamp) {
      // 일시정지 시간은 EPM 분모에 포함하지 않으므로 빈 wall-clock 분도 히스토리에 추가하지 않는다.
      this._minuteHistory.push(this._currentMinuteXP);
      if (this._minuteHistory.length > 30) this._minuteHistory.shift();
      this._currentMinuteXP = 0;
    }
    this._isActive = true;
    this._startTime = Date.now();
    this._lastMinuteTimestamp = nowMinute;
    log('[XP_TRACKER] XP 세션 측정 시작');
    
    this.broadcastUpdate();
  }

  public stopSession(): void {
    if (!this._isActive) return;
    this._isActive = false;
    this._accumulatedTime += Date.now() - this._startTime;
    log('[XP_TRACKER] XP 세션 측정 중지');
    
    this.broadcastUpdate();
  }

  public toggleSession(): void {
    if (this._isActive) {
      this.stopSession();
    } else {
      this.startSession();
    }

    // Ctrl+Shift+Z의 기존 사용자 계약: 측정 시작 시 HUD를 표시하고,
    // 일시정지 시 game-overlay에서 HUD도 함께 숨긴다.
    // 상세 창의 개별 시작/정지는 표시 설정과 독립이므로 이 토글에서만 동기화한다.
    config.saveImmediate({ showXpWidget: this._isActive });
    broadcastToAllWindows('config-data', config.load());
  }

  private broadcastUpdate(): void {
    if (this._xpUpdateTimer) {
      clearTimeout(this._xpUpdateTimer);
      this._xpUpdateTimer = null;
    }
    const payload = this.buildXpPayload(0);
    this.sendToXpWindows('xp-update', payload);
  }

  private _fireEssenceAlert(): void {
    const cfg = config.load();
    if (cfg.essenceAlertEnabled === false) return;

    log('[XP_TRACKER] 경험의 정수 교환 미감지 — 버프 알람 발생');
    this.sendToWindow('game-overlay.html', 'essence-alert');

    const soundFile = cfg.essenceAlertSound || 'orb.mp3';
    const volume = cfg.essenceAlertVolume ?? 40;
    if (soundFile !== 'none') {
      wm.sendPlaySound({
        label: '경험의 정수 버프 확인',
        soundFile,
        volume,
        isCustom: true
      });
    }
  }

}

export const xpTracker = new XpTracker();
