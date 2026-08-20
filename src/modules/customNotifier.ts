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

const minuteScheduler = new MinuteAlignedScheduler();

// Map<alertId, lastFiredKey> — "YYYY-MM-DD HH:mm" 형식으로 중복 방지
const _fired = new Map<string, string>();

/** 알림 루프 시작 */
export function start(): void {
  if (!minuteScheduler.start(checkAlerts)) return;
  log('[CUSTOM_ALERT] 커스텀 알림 감시 시작');
}

/** 알림 루프 중지 */
export function stop(): void {
  minuteScheduler.stop();
}

function checkAlerts(): void {
  const cfg = config.load();
  const alerts = cfg.customAlerts;
  if (!alerts || alerts.length === 0) return;

  const now = new Date();
  const currentHH = now.getHours();
  const currentMM = now.getMinutes();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  for (const alert of alerts) {
    if (!alert.enabled) continue;
    const offsets = alert.offsets ?? [0];

    if (alert.type === 'hourly') {
      // 매시 ?분: alert.minute 기준 offset 계산
      const targetMM = alert.minute ?? 0;
      for (const offset of offsets) {
        // 트리거 분 = (targetMM - offset + 60) % 60
        const triggerMM = ((targetMM - offset) % 60 + 60) % 60;
        if (currentMM !== triggerMM) continue;

        const firedKey = `${dateStr} ${String(currentHH).padStart(2, '0')}:${String(triggerMM).padStart(2, '0')}`;
        if (_fired.get(alert.id + `-${offset}`) === firedKey) continue;
        _fired.set(alert.id + `-${offset}`, firedKey);

        const message = offset === 0
          ? alert.message
          : `[${offset}분 전] ${alert.message}`;
        log(`[CUSTOM_ALERT] hourly 알림: "${message}"`);
        notify(message, alert.soundFile, alert.volume);
      }
    } else {
      // daily: alert.time(HH:mm) 기준 offset 계산
      if (!alert.time) continue;
      const [targetHH, targetMM] = alert.time.split(':').map(Number);

      for (const offset of offsets) {
        const triggerDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHH, targetMM);
        const triggerMinusOffset = new Date(triggerDate.getTime() - offset * 60000);
        const triggerHH = triggerMinusOffset.getHours();
        const triggerMM = triggerMinusOffset.getMinutes();

        if (currentHH !== triggerHH || currentMM !== triggerMM) continue;

        const firedKey = `${dateStr} ${String(triggerHH).padStart(2, '0')}:${String(triggerMM).padStart(2, '0')}`;
        if (_fired.get(alert.id + `-${offset}`) === firedKey) continue;
        _fired.set(alert.id + `-${offset}`, firedKey);

        const message = offset === 0
          ? alert.message
          : `[${offset}분 전] ${alert.message}`;
        log(`[CUSTOM_ALERT] daily 알림: "${message}"`);
        notify(message, alert.soundFile, alert.volume);
      }
    }
  }
}

function notify(message: string, soundFile: string, volume?: number): void {
  // 게임창이 최소화되어 있는 상태일 때 Windows 알림 발송
  const gameStatus = getGameStatus();
  if (gameStatus === 'minimized') {
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
