/**
 * 버프 타이머 매니저 — 채팅 로그 기반 버프 남은시간 계산 및 경고 알림
 */
import * as fs from 'fs';
import * as path from 'path';
import { powerMonitor } from 'electron';
import * as config from './config';
import { log } from './logger';
import { chatParser } from './chatParser';
import type { BuffDefinition, BuffTimerState } from '../shared/types';
import * as diaryDb from './diaryDb';
import {
  findFirstWindowByPage,
  sendToFirstWindowByPage,
} from './windowMessaging';

export interface ActiveBuff {
  buffId: string;
  name: string;
  durationMs: number;
  startTime: number;      // Date.now() 기준
  usedBy: string;         // 'self' 또는 닉네임
  warnedAt: Set<number>;  // 이미 경고를 보낸 임계값(초) 집합
}

export interface MissedBuffWarning {
  buffId: string;
  name: string;
  startTime: number;
  warnSec: number;
  scheduledAt: number;
  dedupeKey: string;
}

export function getMissedBuffWarnings(
  activeBuffs: Iterable<ActiveBuff>,
  fromTimestamp: number,
  toTimestamp: number,
  warnSeconds: readonly number[]
): MissedBuffWarning[] {
  if (!Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp) || toTimestamp <= fromTimestamp) return [];
  const thresholds = Array.from(new Set([...warnSeconds, 5]))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((left, right) => right - left);
  const missed: MissedBuffWarning[] = [];
  for (const buff of activeBuffs) {
    for (const warnSec of thresholds) {
      if (buff.durationMs <= warnSec * 1000 || buff.warnedAt.has(warnSec)) continue;
      const scheduledAt = buff.startTime + buff.durationMs - warnSec * 1000;
      if (scheduledAt < fromTimestamp || scheduledAt > toTimestamp) continue;
      missed.push({
        buffId: buff.buffId,
        name: buff.name,
        startTime: buff.startTime,
        warnSec,
        scheduledAt,
        dedupeKey: `buff:${buff.buffId}:${buff.startTime}:${warnSec}`,
      });
    }
  }
  return missed.sort((left, right) => left.scheduledAt - right.scheduledAt || right.warnSec - left.warnSec);
}

class BuffTimerManager {
  private _started = false;
  private _activeBuffs: Map<string, ActiveBuff> = new Map();
  private _tickInterval: NodeJS.Timeout | null = null;
  private _buffDefs: Map<string, BuffDefinition> = new Map();
  /** config.load() I/O 최소화를 위한 warnSeconds 캐시 */
  private _cachedWarnSeconds: number[] = [60, 10];
  private _lastTickAt = Date.now();
  private _suspendedAt: number | null = null;
  private _suspendedBuffs: ActiveBuff[] | null = null;
  private readonly _buffUsedHandler = (data: {
    date: string;
    timestamp: string;
    buffId: string;
    usedBy: string;
  }): void => {
    const startTime = this._parseLogTimestamp(data.date, data.timestamp);
    this.activateBuff(data.buffId, data.usedBy, undefined, startTime);
  };
  private readonly _suspendHandler = (): void => {
    this._suspendedAt = Date.now();
    this._suspendedBuffs = this._snapshotActiveBuffs();
  };
  private readonly _resumeHandler = (): void => {
    this._recordMissedSleepWarnings(Date.now());
  };

  public start(): void {
    this.loadBuffDefs();
    this._refreshWarnSecondsCache();

    if (!this._started) {
      this._started = true;
      chatParser.on('BUFF_USED', this._buffUsedHandler);
      powerMonitor.on('suspend', this._suspendHandler);
      powerMonitor.on('resume', this._resumeHandler);
      powerMonitor.on('unlock-screen', this._resumeHandler);
    }

    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = setInterval(() => this._tick(), 1000);
    log('[BUFF_TIMER] 매니저 시작됨');
  }

  private _parseLogTimestamp(dateStr: string, timestampStr: string): number {
    try {
      const [y, m, d] = dateStr.split('-').map(Number);
      const timeMatch = timestampStr.match(/(\d{1,2})[:시]\s*(\d{1,2})[:분]?\s*(\d{1,2})?초?/);
      if (timeMatch) {
        const hh = parseInt(timeMatch[1], 10) || 0;
        const mm = parseInt(timeMatch[2], 10) || 0;
        const ss = parseInt(timeMatch[3] || '0', 10) || 0;
        const result = new Date(y, m - 1, d, hh, mm, ss).getTime();
        return isNaN(result) ? Date.now() : result;
      }
      return Date.now();
    } catch (e) {
      log(`[BUFF_TIMER] 시간 파싱 실패: ${e}`);
      return Date.now();
    }
  }

  public refreshConfig(): void {
    this._refreshWarnSecondsCache();
  }

  private _refreshWarnSecondsCache(): void {
    const cfg = config.load();
    this._cachedWarnSeconds = cfg.buffTimerWarnSeconds ?? [60, 10];
  }

  public stop(): void {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._started) {
      chatParser.removeListener('BUFF_USED', this._buffUsedHandler);
      powerMonitor.removeListener('suspend', this._suspendHandler);
      powerMonitor.removeListener('resume', this._resumeHandler);
      powerMonitor.removeListener('unlock-screen', this._resumeHandler);
      this._started = false;
    }
    this._activeBuffs.clear();
    this._suspendedAt = null;
    this._suspendedBuffs = null;
    log('[BUFF_TIMER] 매니저 중지됨');
  }

  public loadBuffDefs(): void {
    try {
      const buffsPath = path.join(__dirname, '..', 'assets', 'data', 'buffs.json');
      const raw = fs.readFileSync(buffsPath, 'utf-8');
      const buffs: BuffDefinition[] = JSON.parse(raw);
      this._buffDefs.clear();
      for (const buff of buffs) {
        this._buffDefs.set(buff.id, buff);
      }
      log(`[BUFF_TIMER] 버프 정의 로드 완료: ${this._buffDefs.size}개`);
    } catch (e) {
      log(`[BUFF_TIMER] 버프 정의 로드 실패: ${e}`);
    }
  }

  /**
   * 버프 타이머 활성화 (이미 활성화된 경우 리셋)
   */
  public activateBuff(buffId: string, usedBy: string = 'self', customDurationMs?: number, startTime?: number): void {
    const cfg = config.load();

    // 전체 기능 비활성화 체크
    if (cfg.buffTimerEnabled === false) return;

    // 버프별 활성화 여부 체크
    const buffTimerBuffs = cfg.buffTimerBuffs ?? {};
    if (buffTimerBuffs[buffId] === false) return;

    // 테스트 활성화 시: 이미 실제 버프가 활성화 중이면 덮어쓰지 않고 스킵
    if (usedBy === 'test') {
      const existing = this._activeBuffs.get(buffId);
      if (existing && existing.usedBy !== 'test') {
        log(`[BUFF_TIMER] 테스트 스킵: ${buffId}는 실제 버프로 이미 활성화 중 (usedBy: ${existing.usedBy})`);
        return;
      }
    }

    const existing = this._activeBuffs.get(buffId);
    // 이자벨 대미지는 아이템 사용 로그가 아닌 효과 적용 문구를 감지한다.
    // 마을 이동 등으로 같은 문구가 다시 기록될 수 있으므로, 활성 중에는
    // 최초 감지 시각을 유지해 타이머가 잘못 연장되지 않게 한다.
    if (buffId === 'dmg_izabel' && existing && usedBy !== 'test' && existing.usedBy !== 'test') {
      log(`[BUFF_TIMER] 이자벨 대미지 재감지 무시: ${existing.name}`);
      return;
    }
    if (existing && usedBy !== 'test' && existing.usedBy !== 'test') {
      const refreshedStartTime = startTime ?? Date.now();
      if (refreshedStartTime <= existing.startTime) {
        log(`[BUFF_TIMER] 이전 또는 동일 시각 재감지 무시: ${existing.name}`);
        return;
      }
    }

    const def = this._buffDefs.get(buffId);
    if (!def || def.durationMs <= 0) {
      log(`[BUFF_TIMER] 알 수 없는 버프 또는 지속시간 없음: ${buffId}`);
      return;
    }

    // 동일한 group에 속한 기존 활성 버프 제거 (none 제외)
    // 단, 테스트 모드(usedBy === 'test') 일 때는 중복 제거를 우회하여 모든 버프를 동시에 테스트할 수 있게 합니다.
    if (usedBy !== 'test' && def.group && def.group !== 'none') {
      for (const [activeBuffId, activeBuff] of this._activeBuffs) {
        if (activeBuffId === buffId) continue;
        const activeDef = this._buffDefs.get(activeBuffId);
        if (activeDef && activeDef.group === def.group) {
          log(`[BUFF_TIMER] 동일 그룹 중복 버프 제거: ${activeBuff.name} (그룹: ${def.group}) -> 새 버프: ${def.name}`);
          this._activeBuffs.delete(activeBuffId);
        }
      }
    }

    const durationMs = customDurationMs ?? def.durationMs;
    const finalStartTime = startTime ?? Date.now();

    const activeBuff: ActiveBuff = {
      buffId,
      name: def.name,
      durationMs: durationMs,
      startTime: finalStartTime,
      usedBy,
      warnedAt: new Set(),
    };

    this._activeBuffs.set(buffId, activeBuff);
    const startStr = new Date(finalStartTime).toLocaleTimeString();
    const action = existing && existing.usedBy !== 'test' ? '버프 시간 갱신' : '버프 활성화';
    log(`[BUFF_TIMER] ${action}: ${def.name} (${durationMs / 60000}분), 시작시각: ${startStr}, 사용자: ${usedBy}`);

    // 즉시 HUD 갱신
    this._sendHudUpdate();
  }

  /**
   * 버프 타이머 강제 비활성화
   */
  public deactivateBuff(buffId: string): void {
    if (this._activeBuffs.has(buffId)) {
      const buff = this._activeBuffs.get(buffId);
      this._activeBuffs.delete(buffId);
      log(`[BUFF_TIMER] 버프 수동 비활성화: ${buff?.name}`);
      this._sendHudUpdate();
    }
  }

  /**
   * 1초마다 실행 — 남은시간 계산 및 경고 트리거
   */
  private _tick(): void {
    const warnSeconds = this._cachedWarnSeconds;
    const now = Date.now();
    this._lastTickAt = now;
    let changed = false;

    for (const [buffId, buff] of this._activeBuffs) {
      const elapsedMs = now - buff.startTime;
      const remainingMs = buff.durationMs - elapsedMs;

      // 만료 처리
      if (remainingMs <= 0) {
        this._activeBuffs.delete(buffId);
        log(`[BUFF_TIMER] 버프 만료: ${buff.name}`);
        changed = true;
        continue;
      }

      const remainingSec = Math.ceil(remainingMs / 1000);

      // 경고 임계값 체크 (5초 고정 알림 포함, 내림차순 정렬)
      const mergedWarnSecs = Array.from(new Set([...warnSeconds, 5])).sort((a, b) => b - a);
      for (const warnSec of mergedWarnSecs) {
        // 전체 지속시간이 경고 임계값보다 큰 경우에만 사전 경고 발동
        if (buff.durationMs > warnSec * 1000 && remainingSec <= warnSec && !buff.warnedAt.has(warnSec)) {
          buff.warnedAt.add(warnSec);
          this._triggerWarning(buff, warnSec);
          changed = true;
        }
      }
    }

    if (changed || this._activeBuffs.size > 0) {
      this._sendHudUpdate();
    }
  }

  /**
   * 경고 트리거 — 시각/청각 알림
   */
  private _triggerWarning(buff: ActiveBuff, warnSec: number): void {
    const cfg = config.load();
    const phase = warnSec <= 5 ? 'warn2' : 'warn1';
    const label = warnSec >= 60 ? `${Math.floor(warnSec / 60)}분` : `${warnSec}초`;

    log(`[BUFF_TIMER] 경고! ${buff.name} — ${label} 남음 (${phase})`);

    const def = this._buffDefs.get(buff.buffId);
    const buffName = buff.name;
    const image = def?.image ?? '';

    // game-overlay에 경고 이벤트 전송 (시각적 알림)
    if (cfg.buffTimerVisualAlert !== false) {
      this._sendToGameOverlay('buff-timer-warning', {
        buffId: buff.buffId,
        buffName,
        image,
        phase,
        warnSec,
        buffTimerCenterAlert: cfg.buffTimerCenterAlert !== false
      });
    }

    // 청각적 알림 — 범용 play-sound 채널로 전송
    if (cfg.buffTimerAudioAlert !== false) {
      const soundFile = cfg.buffTimerSound || 'orb.mp3';
      const volume = cfg.buffTimerVolume ?? 70;
      const label2 = phase === 'warn2' ? `[임박] ${buff.name} 5초 전!` : `[경고] ${buff.name} ${label} 남음`;
      diaryDb.addAlarmLog('buff', '버프 타이머 알림', label2);
      this._sendToMainWindow('play-sound', { label: label2, soundFile, volume, isCustom: true });
    }
  }

  private _snapshotActiveBuffs(): ActiveBuff[] {
    return Array.from(this._activeBuffs.values(), buff => ({
      ...buff,
      warnedAt: new Set(buff.warnedAt),
    }));
  }

  private _recordMissedSleepWarnings(resumedAt: number): void {
    const recoveryStart = Math.max(
      this._suspendedAt ?? this._lastTickAt,
      resumedAt - 24 * 60 * 60 * 1000
    );
    const sourceBuffs = this._suspendedBuffs ?? this._snapshotActiveBuffs();
    const missed = getMissedBuffWarnings(
      sourceBuffs,
      recoveryStart,
      resumedAt,
      this._cachedWarnSeconds
    );
    let allRecorded = true;
    for (const warning of missed) {
      const label = warning.warnSec >= 60
        ? `${Math.floor(warning.warnSec / 60)}분`
        : `${warning.warnSec}초`;
      const recorded = diaryDb.addAlarmLog(
        'buff',
        '절전 중 놓친 알람',
        `[${warning.name}] ${label} 남음`,
        {
          scheduledAt: warning.scheduledAt,
          recordedAt: resumedAt,
          deliveryStatus: 'missed-sleep',
          dedupeKey: warning.dedupeKey,
        }
      );
      if (!recorded) {
        allRecorded = false;
        continue;
      }
      const active = this._activeBuffs.get(warning.buffId);
      if (active?.startTime === warning.startTime) active.warnedAt.add(warning.warnSec);
      log(`[BUFF_TIMER] 절전 중 놓친 알람 이력 기록: ${warning.name} ${label} 남음`);
    }
    if (allRecorded) {
      this._suspendedAt = null;
      this._suspendedBuffs = null;
      this._lastTickAt = resumedAt;
    }
  }

  /**
   * 현재 활성 버프 목록을 HUD에 전송
   */
  private _sendHudUpdate(): void {
    const warnSeconds = [...this._cachedWarnSeconds].sort((a, b) => b - a);
    const now = Date.now();

    const states: BuffTimerState[] = [];
    for (const buff of this._activeBuffs.values()) {
      const remainingMs = Math.max(0, buff.durationMs - (now - buff.startTime));
      const remainingSec = Math.ceil(remainingMs / 1000);

      // phase 계산: 5초 이하이면 무조건 warn2, 아니면 설정된 사전 경고 이하일 때 warn1
      let phase: BuffTimerState['phase'] = 'normal';
      if (remainingSec <= 5) {
        phase = 'warn2';
      } else if (warnSeconds.length > 0 && remainingSec <= warnSeconds[0]) {
        phase = 'warn1';
      }

      const def = this._buffDefs.get(buff.buffId);
      states.push({
        buffId: buff.buffId,
        name: buff.name,
        image: def?.image ?? '',
        durationMs: buff.durationMs,
        remainingMs,
        usedBy: buff.usedBy,
        phase,
      });
    }

    // 남은시간 오름차순 정렬 (곧 만료되는 것이 위)
    states.sort((a, b) => a.remainingMs - b.remainingMs);

    this._sendToGameOverlay('buff-timer-update', states);
    this._sendToBuffTimerWindow('buff-timer-update', states);
  }

  /**
   * game-overlay.html 창에 IPC 전송
   */
  private _sendToGameOverlay(channel: string, data: any): void {
    sendToFirstWindowByPage('game-overlay.html', channel, data);
  }

  /**
   * buff-timer.html 창에 IPC 전송
   */
  private _sendToBuffTimerWindow(channel: string, data: any): void {
    sendToFirstWindowByPage('buff-timer.html', channel, data);
  }

  /**
   * mainWindow에 IPC 전송
   */
  private _sendToMainWindow(channel: string, data: any): void {
    const cfg = config.load();
    const sidebarPos = cfg.sidebarPosition || 'right';
    const isDock = sidebarPos === 'dock' || sidebarPos === 'dock-top';
    const showOnOverlay = !!cfg.showSidebarToastOnOverlay;

    const main = findFirstWindowByPage('index.html');

    if (main) {
      if (channel === 'play-sound') {
        const shouldShowToastOnIndex = !isDock && !showOnOverlay;
        main.webContents.send(channel, {
          ...data,
          soundFile: data.soundFile, // 사운드는 무조건 재생
          showToast: shouldShowToastOnIndex
        });
      } else {
        main.webContents.send(channel, data);
      }
    }

    if (isDock || (channel === 'play-sound' && showOnOverlay)) {
      const overlay = findFirstWindowByPage('game-overlay.html');
      if (overlay) {
        if (channel === 'play-sound') {
          overlay.webContents.send(channel, {
            ...data,
            soundFile: '', // 중복 재생 방지를 위해 사운드 정보 제거
            showToast: true // 토스트 표시
          });
        } else {
          overlay.webContents.send(channel, data);
        }
      }
    }
  }

  public getActiveBuffs(): ActiveBuff[] {
    return Array.from(this._activeBuffs.values());
  }

  /**
   * 테스트로 강제 활성화된 버프만 제거 (usedBy === 'test')
   */
  public clearTestBuffs(): void {
    let changed = false;
    for (const [buffId, buff] of this._activeBuffs) {
      if (buff.usedBy === 'test') {
        this._activeBuffs.delete(buffId);
        changed = true;
      }
    }
    if (changed) {
      this._sendHudUpdate();
      log('[BUFF_TIMER] 테스트 버프 제거 완료');
    }
  }

  /**
   * 활성화된 모든 버프 제거
   */
  public clearAllBuffs(): void {
    if (this._activeBuffs.size > 0) {
      this._activeBuffs.clear();
      log('[BUFF_TIMER] 모든 버프 제거 완료');
      this._sendHudUpdate();
    }
  }
}

export const buffTimerManager = new BuffTimerManager();
