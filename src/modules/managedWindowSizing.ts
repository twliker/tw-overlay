import type { AppConfig } from './constants';
import type { WindowPositionKey } from '../shared/types';

interface WindowSizeFields {
  width: keyof Pick<AppConfig,
    'chatOverlayWidth' | 'chatOverlaySubWidth' | 'chatOverlaySub2Width' | 'focusedChatWidth' | 'contentsCheckerWidth'>;
  height: keyof Pick<AppConfig,
    'chatOverlayHeight' | 'chatOverlaySubHeight' | 'chatOverlaySub2Height' | 'focusedChatHeight' | 'contentsCheckerHeight'>;
}

export type ManagedWindowSizePolicy = 'fit-work-area' | 'user-resizable' | 'game-fixed';

export interface WorkAreaSize {
  width: number;
  height: number;
}

const RESIZABLE_WINDOW_FIELDS: Partial<Record<WindowPositionKey, WindowSizeFields>> = {
  chatOverlay: { width: 'chatOverlayWidth', height: 'chatOverlayHeight' },
  chatOverlaySub: { width: 'chatOverlaySubWidth', height: 'chatOverlaySubHeight' },
  chatOverlaySub2: { width: 'chatOverlaySub2Width', height: 'chatOverlaySub2Height' },
  focusedChat: { width: 'focusedChatWidth', height: 'focusedChatHeight' },
  contentsChecker: { width: 'contentsCheckerWidth', height: 'contentsCheckerHeight' },
};

const USER_RESIZABLE_WINDOWS = new Set<WindowPositionKey>([
  ...Object.keys(RESIZABLE_WINDOW_FIELDS) as WindowPositionKey[],
  'diary',
  'uniformColor',
  'swordEnhance',
]);

const GAME_FIXED_WINDOWS = new Set<WindowPositionKey>(['gameOverlay', 'dock']);

export function getManagedWindowSizePolicy(key: WindowPositionKey): ManagedWindowSizePolicy {
  if (GAME_FIXED_WINDOWS.has(key)) return 'game-fixed';
  if (USER_RESIZABLE_WINDOWS.has(key)) return 'user-resizable';
  return 'fit-work-area';
}

export interface ManagedWindowSizing {
  width: number;
  height: number;
  isResizable: boolean;
  isTransparent: boolean;
  minWidth?: number;
  minHeight?: number;
  policy: ManagedWindowSizePolicy;
}

const WORK_AREA_MARGIN = 40;

function clampDimension(value: number, minimum: number | undefined, maximum: number): number {
  const effectiveMinimum = minimum === undefined ? 1 : Math.min(minimum, maximum);
  return Math.max(effectiveMinimum, Math.min(value, maximum));
}

/** 저장 설정과 현재 작업 영역을 반영한 일반 보조 창의 생성 크기·표시 정책을 계산합니다. */
export function resolveManagedWindowSizing(
  key: WindowPositionKey,
  defaultWidth: number,
  defaultHeight: number,
  config: AppConfig,
  workAreaSize: WorkAreaSize,
): ManagedWindowSizing {
  const fields = RESIZABLE_WINDOW_FIELDS[key];
  const storedWidth = fields ? config[fields.width] : undefined;
  const storedHeight = fields ? config[fields.height] : undefined;
  const policy = getManagedWindowSizePolicy(key);
  const isResizable = policy === 'user-resizable';
  const isChatOverlay = key === 'chatOverlay' || key === 'chatOverlaySub' || key === 'chatOverlaySub2';
  const requestedMinWidth = key === 'focusedChat' ? 360 : (key === 'diary' ? 900 : (isChatOverlay ? 300 : (fields ? 200 : undefined)));
  const requestedMinHeight = key === 'focusedChat' ? 360 : (key === 'diary' ? 650 : (isChatOverlay ? 80 : (fields ? 200 : undefined)));
  const requestedWidth = storedWidth ? storedWidth : defaultWidth;
  const requestedHeight = storedHeight ? storedHeight : defaultHeight;
  const maxWidth = Math.max(1, Math.floor(workAreaSize.width) - WORK_AREA_MARGIN);
  const maxHeight = Math.max(1, Math.floor(workAreaSize.height) - WORK_AREA_MARGIN);
  const shouldFitWorkArea = policy !== 'game-fixed';
  const minWidth = requestedMinWidth === undefined
    ? undefined
    : Math.min(requestedMinWidth, shouldFitWorkArea ? maxWidth : requestedMinWidth);
  const minHeight = requestedMinHeight === undefined
    ? undefined
    : Math.min(requestedMinHeight, shouldFitWorkArea ? maxHeight : requestedMinHeight);

  return {
    // 기존 설정 호환성: 0처럼 falsy인 저장값은 이전 구현과 동일하게 기본값으로 복구합니다.
    width: shouldFitWorkArea ? clampDimension(requestedWidth, requestedMinWidth, maxWidth) : requestedWidth,
    height: shouldFitWorkArea ? clampDimension(requestedHeight, requestedMinHeight, maxHeight) : requestedHeight,
    isResizable,
    isTransparent: key !== 'contentsChecker' && key !== 'diary',
    minWidth,
    minHeight,
    policy,
  };
}

/** 크기 저장 대상 창이면 기존 AppConfig 필드에 새 크기를 기록합니다. */
export function applyManagedWindowSize(
  key: WindowPositionKey,
  config: AppConfig,
  width: number,
  height: number,
): boolean {
  const fields = RESIZABLE_WINDOW_FIELDS[key];
  if (!fields) return false;
  config[fields.width] = width;
  config[fields.height] = height;
  return true;
}
