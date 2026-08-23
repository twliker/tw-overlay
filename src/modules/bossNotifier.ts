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

/** 보스별 출현 시간 문자열 반환 */
export function getBossTimes(bossName: string): string[] {
  return BOSS_SCHEDULE.filter(b => b.name === bossName).map(b => b.time);
}

const minuteScheduler = new MinuteAlignedScheduler();
let _lastNotifiedTime: string | null = null;

/** 알림 루프 시작 */
export function start(): void {
  if (!minuteScheduler.start(checkBossTime)) return;
  log('[BOSS] 보스 알림 감시 시작 (정밀 동기화 모드)');
}

/** 알림 루프 중지 */
export function stop(): void {
  minuteScheduler.stop();
}

function checkBossTime(): void {
  // 컨텐츠 체크 리스트 초기화 여부 확인 (백그라운드)
  const isReset = contents.checkReset();
  if (isReset) {
    // 초기화된 경우 모든 창에 업데이트된 데이터 전송
    wm.applySettings({});
  }

  const now = new Date();
  const HHmmNow = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const scheduledBosses = BOSS_SCHEDULE.filter(b => b.time === HHmmNow);
  scheduledBosses.forEach(scheduledBoss => {
    const eventName = 'boss_time_' + scheduledBoss.name.replace(/\s+/g, '_');
    analytics.trackEvent(eventName);
  });

  const cfg = config.load();
  if (!cfg.fieldBossNotifyEnabled) return;

  const currentTimeKey = `${now.getHours()}:${now.getMinutes()}`;
  if (_lastNotifiedTime === currentTimeKey) return;

  const offsets = cfg.fieldBossNotifyOffsets || [0];

  offsets.forEach(offset => {
    // 현재 시간에 오프셋을 더해 '곧 출현할 보스'를 찾음
    const targetTime = new Date(now.getTime() + offset * 60000);
    const HHmm = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
    const bosses = BOSS_SCHEDULE.filter(b => b.time === HHmm);
    bosses.forEach(boss => {
      const bossSetting = cfg.fieldBossSettings?.[boss.name];
      if (bossSetting && bossSetting.enabled) {
        const message = offset === 0 ? boss.name : `${boss.name} ${offset}분 전`;
        log(`[BOSS] 알림 조건 충족: ${message} (사운드: ${bossSetting.soundFile})`);
        notify(boss.name, bossSetting.soundFile, boss.time, offset);
        _lastNotifiedTime = currentTimeKey;
      }
    });
  });
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
