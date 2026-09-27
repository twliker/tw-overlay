import type { NotificationAnchor, NotificationPoint, NotificationPositions } from './types';
export const NOTIFICATION_ANCHORS = ['default', 'top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;

export function isNotificationPoint(value: unknown): value is NotificationPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return typeof p.left === 'number' && Number.isFinite(p.left)
      && typeof p.top === 'number' && Number.isFinite(p.top);
}

export function isNotificationAnchor(value: unknown): value is NotificationAnchor {
  return (NOTIFICATION_ANCHORS as readonly unknown[]).includes(value) || isNotificationPoint(value);
}

export function isNotificationPositions(value: unknown): value is NotificationPositions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 4 && entries.every(([key, anchor]) => ['center', 'buff', 'hunting', 'toast'].includes(key)
    && isNotificationAnchor(anchor));
}

