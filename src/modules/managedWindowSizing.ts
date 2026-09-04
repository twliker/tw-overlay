import type { AppConfig } from './constants';
import type { WindowPositionKey } from '../shared/types';

interface WindowSizeFields {
  width: keyof Pick<AppConfig,
    'chatOverlayWidth' | 'chatOverlaySubWidth' | 'chatOverlaySub2Width' | 'focusedChatWidth' | 'etaRankingWidth' | 'contentsCheckerWidth'>;
  height: keyof Pick<AppConfig,
    'chatOverlayHeight' | 'chatOverlaySubHeight' | 'chatOverlaySub2Height' | 'focusedChatHeight' | 'etaRankingHeight' | 'contentsCheckerHeight'>;
}

export type ManagedWindowSizePolicy = 'fit-work-area' | 'user-resizable' | 'game-fixed';
export const CHAT_OVERLAY_MIN_WIDTH = 300;
export const CHAT_OVERLAY_MIN_HEIGHT = 80;

export interface WorkAreaSize {
  width: number;
  height: number;
}

const RESIZABLE_WINDOW_FIELDS: Partial<Record<WindowPositionKey, WindowSizeFields>> = {
  chatOverlay: { width: 'chatOverlayWidth', height: 'chatOverlayHeight' },
  chatOverlaySub: { width: 'chatOverlaySubWidth', height: 'chatOverlaySubHeight' },
  chatOverlaySub2: { width: 'chatOverlaySub2Width', height: 'chatOverlaySub2Height' },
  focusedChat: { width: 'focusedChatWidth', height: 'focusedChatHeight' },
  etaRanking: { width: 'etaRankingWidth', height: 'etaRankingHeight' },
  contentsChecker: { width: 'contentsCheckerWidth', height: 'contentsCheckerHeight' },
};

const GAME_FIXED_WINDOWS = new Set<WindowPositionKey>(['gameOverlay', 'dock']);

export function getManagedWindowSizePolicy(key: WindowPositionKey): ManagedWindowSizePolicy {
  if (GAME_FIXED_WINDOWS.has(key)) return 'game-fixed';
  return 'user-resizable';
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
  const genericStoredSize = config.managedWindowSizes?.[key];
  const storedWidth = fields ? config[fields.width] : genericStoredSize?.width;
  const storedHeight = fields ? config[fields.height] : genericStoredSize?.height;
  const policy = getManagedWindowSizePolicy(key);
  const isResizable = policy === 'user-resizable';
  const isChatOverlay = key === 'chatOverlay' || key === 'chatOverlaySub' || key === 'chatOverlaySub2';
  const requestedMinWidth = policy === 'game-fixed' ? undefined : (key === 'settings' ? 800
    : (key === 'focusedChat' ? 360
      : (key === 'etaRanking' ? 520
        : (key === 'diary' ? 900
          : (isChatOverlay ? CHAT_OVERLAY_MIN_WIDTH : (fields ? 200 : Math.min(defaultWidth, 400)))))));
  const requestedMinHeight = policy === 'game-fixed' ? undefined : (key === 'settings' ? 600
    : (key === 'focusedChat' ? 360
      : (key === 'etaRanking' ? 560
        : (key === 'diary' ? 650
          : (isChatOverlay ? CHAT_OVERLAY_MIN_HEIGHT : (fields ? 200 : Math.min(defaultHeight, 300)))))));
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
  const patch = createManagedWindowSizePatch(key, width, height, config.managedWindowSizes);
  if (!patch) return false;
  Object.assign(config, patch);
  return true;
}

/** 크기 저장 대상 창의 변경 필드만 반환해 다른 설정을 변경으로 오인하지 않게 합니다. */
export function createManagedWindowSizePatch(
  key: WindowPositionKey,
  width: number,
  height: number,
  managedWindowSizes: AppConfig['managedWindowSizes'] = {},
): Partial<AppConfig> | null {
  const fields = RESIZABLE_WINDOW_FIELDS[key];
  if (fields) {
    return {
      [fields.width]: width,
      [fields.height]: height,
    } as Partial<AppConfig>;
  }
  if (getManagedWindowSizePolicy(key) !== 'user-resizable') return null;
  return {
    managedWindowSizes: {
      ...managedWindowSizes,
      [key]: { width, height },
    },
  };
}
