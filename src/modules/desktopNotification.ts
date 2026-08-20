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

export function showSupportedDesktopNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
}
