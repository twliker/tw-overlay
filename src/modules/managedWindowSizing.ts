import type { AppConfig } from './constants';
import type { WindowPositionKey } from '../shared/types';

interface WindowSizeFields {
  width: keyof Pick<AppConfig,
    'chatOverlayWidth' | 'chatOverlaySubWidth' | 'chatOverlaySub2Width' | 'focusedChatWidth' | 'contentsCheckerWidth'>;
  height: keyof Pick<AppConfig,
    'chatOverlayHeight' | 'chatOverlaySubHeight' | 'chatOverlaySub2Height' | 'focusedChatHeight' | 'contentsCheckerHeight'>;
}

const RESIZABLE_WINDOW_FIELDS: Partial<Record<WindowPositionKey, WindowSizeFields>> = {
  chatOverlay: { width: 'chatOverlayWidth', height: 'chatOverlayHeight' },
  chatOverlaySub: { width: 'chatOverlaySubWidth', height: 'chatOverlaySubHeight' },
  chatOverlaySub2: { width: 'chatOverlaySub2Width', height: 'chatOverlaySub2Height' },
  focusedChat: { width: 'focusedChatWidth', height: 'focusedChatHeight' },
  contentsChecker: { width: 'contentsCheckerWidth', height: 'contentsCheckerHeight' },
};

export interface ManagedWindowSizing {
  width: number;
  height: number;
  isResizable: boolean;
  isTransparent: boolean;
  minWidth?: number;
  minHeight?: number;
}

/** 저장 설정과 화면 높이를 반영한 일반 보조 창의 생성 크기·표시 정책을 계산합니다. */
export function resolveManagedWindowSizing(
  key: WindowPositionKey,
  defaultWidth: number,
  defaultHeight: number,
  config: AppConfig,
  workAreaHeight: number,
): ManagedWindowSizing {
  const fields = RESIZABLE_WINDOW_FIELDS[key];
  const storedWidth = fields ? config[fields.width] : undefined;
  const storedHeight = fields ? config[fields.height] : undefined;
  const isResizable = fields !== undefined || key === 'diary';
  const isChatOverlay = key === 'chatOverlay' || key === 'chatOverlaySub' || key === 'chatOverlaySub2';
  const minWidth = key === 'focusedChat' ? 360 : (key === 'diary' ? 900 : (isChatOverlay ? 300 : (isResizable ? 200 : undefined)));
  const minHeight = key === 'focusedChat' ? 360 : (key === 'diary' ? 650 : (isChatOverlay ? 80 : (isResizable ? 200 : undefined)));

  return {
    // 기존 설정 호환성: 0처럼 falsy인 저장값은 이전 구현과 동일하게 기본값으로 복구합니다.
    width: storedWidth ? storedWidth : defaultWidth,
    height: Math.min(storedHeight ? storedHeight : defaultHeight, workAreaHeight - 40),
    isResizable,
    isTransparent: key !== 'contentsChecker' && key !== 'diary',
    minWidth,
    minHeight,
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
