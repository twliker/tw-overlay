import type { NotificationPositions } from './types';
export const NOTIFICATION_ANCHORS = ['default', 'top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export function isNotificationPositions(value: unknown): value is NotificationPositions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 4 && entries.every(([key, anchor]) => ['center', 'buff', 'hunting', 'toast'].includes(key)
    && (NOTIFICATION_ANCHORS as readonly unknown[]).includes(anchor));
}
