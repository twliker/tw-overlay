/**
 * Electron 데스크톱 알림 생성의 공통 수명주기.
 * 활성화 여부, 클릭 동작, 오류 기록은 각 기능이 주입한다.
 */
import { Notification } from 'electron';

export interface DesktopNotificationOptions {
  enabled: boolean;
  title: string;
  body: string;
  onClick?: () => void;
  onShow?: () => void;
  onError: (error: unknown) => void;
}

export function showDesktopNotification(options: DesktopNotificationOptions): void {
  if (!options.enabled) return;

  try {
    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: false,
    });
    if (options.onClick) {
      notification.on('click', options.onClick);
    }
    notification.show();
    options.onShow?.();
  } catch (error: unknown) {
    options.onError(error);
  }
}

const lootBatches = new Map<string, { title: string; name: string; count: number; timer: NodeJS.Timeout }>();
/** 등록 득템의 짧은 연속 획득만 750ms 동안 합친다. 기록은 호출 전에 매 로그마다 저장된다.
 * 다른 아이템/일반 채팅 알림은 서로 합치지 않는다. OS 토스트만 묶고 게임 경고·소리는 변경하지 않는다.
 */
export function showSupportedDesktopNotification(title: string, body: string, loot?: { itemName: string; count: number }): void {
  if (loot && Number.isSafeInteger(loot.count) && loot.count > 0) {
    const existing = lootBatches.get(loot.itemName);
    if (existing) { existing.count += loot.count; return; }
    const batch = { title, name: loot.itemName, count: loot.count, timer: setTimeout(() => {
      lootBatches.delete(loot.itemName);
      showSupportedDesktopNotification(batch.title, `${batch.name} × ${batch.count.toLocaleString()}`);
    }, 750) };
    batch.timer.unref();
    lootBatches.set(loot.itemName, batch);
    return;
  }
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
}
