/**
 * 필드보스 알림 모듈
 */
import * as config from './config';
import * as wm from './windowManager';
import * as contents from './contentsChecker';
import { log } from './logger';
import { analytics } from './analytics';
import { getGameStatus } from './pollingLoop';
import * as diaryDb from './diaryDb';
import { MinuteAlignedScheduler } from './minuteAlignedScheduler';
import { showDesktopNotification } from './desktopNotification';

interface BossTime {
  time: string; // HH:mm
  name: string;
}

export const BOSS_SCHEDULE: BossTime[] = [
  { time: '00:00', name: '골론' },
  { time: '00:00', name: '혼란한 대지' },
  { time: '00:30', name: '파멸의 기원' },
  { time: '01:00', name: '스페르첸드' },
  { time: '04:00', name: '스페르첸드' },
  { time: '05:00', name: '골모답' },
  { time: '06:00', name: '골론' },
  { time: '07:00', name: '혼란한 대지' },
  { time: '08:00', name: '스페르첸드' },
  { time: '11:00', name: '파멸의 기원' },
  { time: '12:00', name: '골론' },
  { time: '13:00', name: '골모답' },
  { time: '13:00', name: '혼란한 대지' },
  { time: '14:30', name: '아칸' },
  { time: '16:00', name: '스페르첸드' },
  { time: '18:00', name: '골론' },
  { time: '18:00', name: '혼란한 대지' },
  { time: '19:00', name: '스페르첸드' },
  { time: '20:00', name: '파멸의 기원' },
  { time: '21:00', name: '골모답' },
  { time: '21:00', name: '혼란한 대지' },
  { time: '21:30', name: '아칸' },
  { time: '23:00', name: '스페르첸드' }
];

interface DueBossAlert extends BossTime {
  offset: number;
  firedKey: string;
  notifyKey: string;
  soundFile: string;
}

export function formatBossDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatBossMinuteKey(date: Date): string {
  return `${formatBossDateKey(date)}`
    + ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function getScheduledBossAnalyticsAt(now: Date): Array<{ eventName: string; analyticsKey: string }> {
  const minuteKey = formatBossMinuteKey(now);
  const HHmmNow = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return BOSS_SCHEDULE
    .filter(boss => boss.time === HHmmNow)
    .map(boss => ({
      eventName: `boss_time_${boss.name.replace(/\s+/g, '_')}`,
      analyticsKey: `${minuteKey}_${boss.name}`,
    }));
}

export function takeUntrackedBossAnalytics(
  now: Date,
  trackedKeys: Set<string>
): Array<{ eventName: string; analyticsKey: string }> {
  const untracked = getScheduledBossAnalyticsAt(now)
    .filter(scheduled => !trackedKeys.has(scheduled.analyticsKey));
  for (const scheduled of untracked) trackedKeys.add(scheduled.analyticsKey);
  return untracked;
}

/** 실제 보스 알림과 절전 중 놓친 이력이 같은 오프셋/개별 보스 설정을 사용한다. */
export function getDueBossAlertsAt(cfg: ReturnType<typeof config.load>, now: Date): DueBossAlert[] {
  if (!cfg.fieldBossNotifyEnabled) return [];
  const offsets = cfg.fieldBossNotifyOffsets || [0];
  const firedKey = formatBossMinuteKey(now);
  const due: DueBossAlert[] = [];

  for (const offset of offsets) {
    const targetTime = new Date(now.getTime() + offset * 60_000);
    const targetHHmm = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
    for (const boss of BOSS_SCHEDULE.filter(entry => entry.time === targetHHmm)) {
      const bossSetting = cfg.fieldBossSettings?.[boss.name];
      if (!bossSetting?.enabled) continue;
      due.push({
        ...boss,
        offset,
        firedKey,
        notifyKey: `${firedKey}_${boss.name}_${offset}`,
        soundFile: bossSetting.soundFile
      });
    }
  }
  return due;
}

/** 보스별 출현 시간 문자열 반환 */
export function getBossTimes(bossName: string): string[] {
  return BOSS_SCHEDULE.filter(b => b.name === bossName).map(b => b.time);
}

const minuteScheduler = new MinuteAlignedScheduler();
const _notifiedBossKeys = new Set<string>();
const _trackedBossAnalyticsKeys = new Set<string>();
let _lastCleanupDate = formatBossDateKey(new Date());

/** 알림 루프 시작 */
export function start(): void {
  if (!minuteScheduler.start(checkBossTime, recordMissedBossAlerts)) return;
  log('[BOSS] 보스 알림 감시 시작 (정밀 동기화 모드)');
}

/** 알림 루프 중지 */
export function stop(): void {
  minuteScheduler.stop();
}

function checkBossTime(): void {
  // 날짜 변경 시 알림 디듀플 셋 정리
  const now = new Date();
  const currentDate = formatBossDateKey(now);
  if (currentDate !== _lastCleanupDate
    || _notifiedBossKeys.size + _trackedBossAnalyticsKeys.size > 500) {
    _notifiedBossKeys.clear();
    _trackedBossAnalyticsKeys.clear();
    _lastCleanupDate = currentDate;
  }

  // 컨텐츠 체크 리스트 초기화 여부 확인 (백그라운드)
  const isReset = contents.checkReset();
  if (isReset) {
    // 초기화된 경우 모든 창에 업데이트된 데이터 전송
    wm.applySettings({});
  }

  for (const scheduled of takeUntrackedBossAnalytics(now, _trackedBossAnalyticsKeys)) {
    analytics.trackEvent(scheduled.eventName);
  }

  const cfg = config.load();
  for (const due of getDueBossAlertsAt(cfg, now)) {
    if (_notifiedBossKeys.has(due.notifyKey)) continue;
    _notifiedBossKeys.add(due.notifyKey);
    const message = due.offset === 0 ? due.name : `${due.name} ${due.offset}분 전`;
    log(`[BOSS] 알림 조건 충족: ${message} (사운드: ${due.soundFile})`);
    notify(due.name, due.soundFile, due.time, due.offset);
  }
}

/** 절전 중 지난 필드보스 알림은 재생하지 않고 알람 이력에만 남긴다. */
function recordMissedBossAlerts(timestamps: number[]): void {
  const cfg = config.load();
  for (const timestamp of timestamps) {
    for (const due of getDueBossAlertsAt(cfg, new Date(timestamp))) {
      if (_notifiedBossKeys.has(due.notifyKey)) continue;
      const message = due.offset === 0 ? `[${due.name}] 출현` : `[${due.name}] ${due.offset}분 전`;
      if (diaryDb.addAlarmLog('boss', '절전 중 놓친 알람', `[${due.firedKey}] ${message}`)) {
        _notifiedBossKeys.add(due.notifyKey);
        log(`[BOSS] 절전 중 놓친 알람 이력 기록: ${due.firedKey} ${message}`);
      } else {
        log(`[BOSS] 절전 중 놓친 알람 이력 기록 실패: ${due.firedKey} ${message}`);
      }
    }
  }
}

function notify(bossName: string, soundFile: string, spawnTime: string, offset: number): void {
  log(`[BOSS] 필드보스 출현 알림: ${bossName} (스폰: ${spawnTime}, 오프셋: ${offset})`);

  // 오늘 날짜 및 콘텐츠 확인용 데이터 생성
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const content = `[${bossName}] ${spawnTime} 스폰 처치 완료`;
  const isAlreadyRecorded = diaryDb.isActivityLogged(dateStr, content);

  // 게임창이 최소화되어 있거나 게임 종료 시 알림 받기 옵션 활성화 상태일 때 Windows 알림 발송
  const cfg = config.load();
  const gameStatus = getGameStatus();
  if (gameStatus === 'minimized' || (cfg.notifyWhenGameClosed && gameStatus === 'not-running')) {
    const title = '🕒 필드보스 출현 알림';
    const body = offset === 0
      ? `지금 [${bossName}]이(가) 출현했습니다!`
      : `약 ${offset}분 후 [${bossName}]이(가) 출현합니다. (${spawnTime})`;

    showDesktopNotification({
      enabled: true,
      title,
      body,
      onShow: () => log(`[BOSS] Windows 네이티브 알림 발송 (상태: ${gameStatus}, 제목: ${title})`),
      onError: error => log(`[BOSS] 네이티브 알림 발송 실패: ${error}`),
    });
  }

  wm.sendPlaySound({
    label: bossName,
    soundFile,
    spawnTime,
    offset,
    isCustom: false,
    isAlreadyRecorded
  });
}
