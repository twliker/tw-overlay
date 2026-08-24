/**
 * 커스텀 알림 모듈
 * 사용자가 설정한 시각 + offset으로 매일 반복 알림을 발송합니다.
 */
import * as config from './config';
import * as wm from './windowManager';
import { log } from './logger';
import { getGameStatus } from './pollingLoop';
import { MinuteAlignedScheduler } from './minuteAlignedScheduler';
import { showDesktopNotification } from './desktopNotification';
import * as diaryDb from './diaryDb';
import type { CustomAlert } from '../shared/types';

const minuteScheduler = new MinuteAlignedScheduler();

// Map<alertId, lastFiredKey> — "YYYY-MM-DD HH:mm" 형식으로 중복 방지
const _fired = new Map<string, string>();

interface DueCustomAlert {
  dedupeId: string;
  firedKey: string;
  message: string;
  soundFile: string;
  volume?: number;
}

function formatMinuteKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    + ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 특정 분에 실행 대상인 커스텀 알림을 계산한다. 실제 재생과 이력 기록이 같은 규칙을 공유한다. */
export function getDueCustomAlertsAt(alerts: CustomAlert[] | undefined, now: Date): DueCustomAlert[] {
  if (!alerts || alerts.length === 0) return [];
  const currentHH = now.getHours();
  const currentMM = now.getMinutes();
  const firedKey = formatMinuteKey(now);
  const due: DueCustomAlert[] = [];

  for (const alert of alerts) {
    if (!alert.enabled) continue;
    const offsets = alert.offsets ?? [0];
    for (const offset of offsets) {
      let matches = false;
      if (alert.type === 'hourly') {
        const targetMM = alert.minute ?? 0;
        const triggerMM = ((targetMM - offset) % 60 + 60) % 60;
        matches = currentMM === triggerMM;
      } else if (alert.time) {
        const [targetHH, targetMM] = alert.time.split(':').map(Number);
        if (!Number.isInteger(targetHH) || !Number.isInteger(targetMM)) continue;
        const triggerDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHH, targetMM);
        const triggerMinusOffset = new Date(triggerDate.getTime() - offset * 60_000);
        matches = currentHH === triggerMinusOffset.getHours() && currentMM === triggerMinusOffset.getMinutes();
      }
      if (!matches) continue;

      due.push({
        dedupeId: `${alert.id}-${offset}`,
        firedKey,
        message: offset === 0 ? alert.message : `[${offset}분 전] ${alert.message}`,
        soundFile: alert.soundFile,
        volume: alert.volume
      });
    }
  }
  return due;
}

/** 알림 루프 시작 */
export function start(): void {
  if (!minuteScheduler.start(checkAlerts, recordMissedAlerts)) return;
  log('[CUSTOM_ALERT] 커스텀 알림 감시 시작');
}

/** 알림 루프 중지 */
export function stop(): void {
  minuteScheduler.stop();
}

function checkAlerts(): void {
  const cfg = config.load();
  const now = new Date();
  for (const due of getDueCustomAlertsAt(cfg.customAlerts, now)) {
    if (_fired.get(due.dedupeId) === due.firedKey) continue;
    _fired.set(due.dedupeId, due.firedKey);
    log(`[CUSTOM_ALERT] 알림: "${due.message}"`);
    notify(due.message, due.soundFile, due.volume);
  }
}

/** 절전 중 지난 알림은 재생하지 않고 알람 이력에만 남긴다. */
function recordMissedAlerts(timestamps: number[]): void {
  const alerts = config.load().customAlerts;
  for (const timestamp of timestamps) {
    const scheduledAt = new Date(timestamp);
    for (const due of getDueCustomAlertsAt(alerts, scheduledAt)) {
      if (_fired.get(due.dedupeId) === due.firedKey) continue;
      const recorded = diaryDb.addAlarmLog(
        'custom',
        '절전 중 놓친 알람',
        `[${due.firedKey}] ${due.message}`
      );
      if (recorded) {
        _fired.set(due.dedupeId, due.firedKey);
        log(`[CUSTOM_ALERT] 절전 중 놓친 알람 이력 기록: ${due.firedKey} ${due.message}`);
      } else {
        log(`[CUSTOM_ALERT] 절전 중 놓친 알람 이력 기록 실패: ${due.firedKey} ${due.message}`);
      }
    }
  }
}

function notify(message: string, soundFile: string, volume?: number): void {
  // 게임창이 최소화되어 있거나 게임 종료 시 알림 받기 옵션 활성화 상태일 때 Windows 알림 발송
  const cfg = config.load();
  const gameStatus = getGameStatus();
  if (gameStatus === 'minimized' || (cfg.notifyWhenGameClosed && gameStatus === 'not-running')) {
    showDesktopNotification({
      enabled: true,
      title: '🔔 커스텀 알림',
      body: message,
      onShow: () => log(`[CUSTOM_ALERT] Windows 네이티브 알림 발송 (상태: ${gameStatus}, 메시지: ${message})`),
      onError: error => log(`[CUSTOM_ALERT] 네이티브 알림 발송 실패: ${error}`),
    });
  }

  wm.sendPlaySound({
    label: message,
    soundFile,
    volume,
    isCustom: true
  });
}
