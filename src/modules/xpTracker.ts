import { chatParser } from './chatParser';
import * as config from './config';
import { log } from './logger';
import * as wm from './windowManager';
import {
  sendToFirstWindowByPage,
} from './windowMessaging';
import type { AppConfig, XpStats } from '../shared/types';

export const QUEST_DEFINITIONS = {
  forge: { name: '대장간', target: 1500, icon: 'hammer' },
  golgotha: { name: '골고다', target: 1000, icon: 'shield' },
  void: { name: '공허', target: 800, icon: 'orbit' }
};

export const XP_PER_ESSENCE = 10_000_000_000;

/** 정확히 경험의 정수 교환 단위로 설명되는 음수 XP만 교환으로 인정한다. */
export function getEssenceExchangeCount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount >= 0) return 0;
  const loss = Math.abs(amount);
  if (loss < XP_PER_ESSENCE || loss % XP_PER_ESSENCE !== 0) return 0;
  return loss / XP_PER_ESSENCE;
}

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
  private static readonly ESSENCE_XP = XP_PER_ESSENCE;
  private static readonly ESSENCE_BUFFER = 1_000_000_000;
  private static readonly DEBUG_XP_MULTIPLIER = 1;
  private _xpSinceLastExchange = 0;
  private _sessionEssenceCount = 0;
  private _lastAlertTier = 0;

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
      if (!this._isActive) return;

      // 정수 교환 감지 (정수 1개당 정확히 100억 XP, 세션 총 획득 경험치는 유지)
      const exchangedCount = getEssenceExchangeCount(data.amount);
      if (exchangedCount > 0) {
        this._sessionEssenceCount += exchangedCount;
        // 잔여 경험치 보존: 110억 중 100억 교환 시 10억 보존
        this._xpSinceLastExchange = Math.max(0, this._xpSinceLastExchange + data.amount);
        this._lastAlertTier = Math.floor(Math.max(0, this._xpSinceLastExchange - XpTracker.ESSENCE_BUFFER) / XpTracker.ESSENCE_XP);
        this.scheduleXpUpdate(0);
        return;
      }

      // 테일즈위버의 정상적인 XP 감소는 정수 교환뿐이므로 설명되지 않는 음수는 합계에서 제외한다.
      if (data.amount < 0) {
        log(`[XP_TRACKER] 경험의 정수 교환 단위가 아닌 음수 XP 무시: ${data.amount}`);
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
        this._xpSinceLastExchange += amount;

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

        const currentTier = Math.floor(Math.max(0, this._xpSinceLastExchange - XpTracker.ESSENCE_BUFFER) / XpTracker.ESSENCE_XP);
        if (currentTier > this._lastAlertTier) {
          this._fireEssenceAlert();
          this._lastAlertTier = currentTier;
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
      xpSinceLastExchange: this._xpSinceLastExchange,
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
      const soundFile = cfg.essenceAlertSound || 'orb.mp3';
      const volume = cfg.essenceAlertVolume ?? 70;
      wm.sendPlaySound({
        label: `${questName} 도전과제 완료`,
        soundFile,
        volume,
        isCustom: true
      });
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
    this._xpSinceLastExchange = 0;
    this._sessionEssenceCount = 0;
    this._lastAlertTier = 0;

    log('[XP_TRACKER] XP 세션 초기화됨');

    this.sendToWindow('game-overlay.html', 'xp-update', {
      total: 0, epm: 0, movingEpm: 0, lastGain: 0, history: [], kills: 0,
      startTime: this._startTime, accumulatedTime: 0, isActive: this._isActive
    });
    this.sendToWindow('xp-hud.html', 'xp-reset-done', {
      startTime: this._startTime,
      accumulatedTime: 0,
      isActive: this._isActive
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
      xpSinceLastExchange: this._xpSinceLastExchange,
      accumulatedTime: this._accumulatedTime,
      isActive: this._isActive
    };
  }

  public startSession(): void {
    if (this._isActive) return;
    this._isActive = true;
    this._startTime = Date.now();
    this._lastMinuteTimestamp = Math.floor(Date.now() / 60000);
    this._currentMinuteXP = 0;
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
    const volume = cfg.essenceAlertVolume ?? 70;
    wm.sendPlaySound({
      label: '경험의 정수 버프 확인',
      soundFile,
      volume,
      isCustom: true
    });
  }
}

export const xpTracker = new XpTracker();
