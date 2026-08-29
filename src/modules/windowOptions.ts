import type { BrowserWindowConstructorOptions } from 'electron';
import * as path from 'path';

/**
 * [기능 계약: Windows 실행 창 아이콘]
 *
 * electron-builder의 `build.win.icon`은 설치된 실행 파일과 시작 메뉴 바로가기
 * 아이콘을 지정하지만, 실행 중 작업표시줄에 표시되는 각 BrowserWindow의 아이콘까지
 * 항상 보장하지는 않는다. 따라서 모든 내부 창이 사용하는 공통 옵션에서 제품 아이콘을
 * 명시해야 하며, 컴파일 뒤에도 함께 복사되는 `dist/icons/icon.ico`를 가리켜야 한다.
 *
 * 이 기본값은 `windowProps`보다 먼저 선언한다. 특별한 창에서 별도 아이콘이 필요한 경우만
 * 호출부의 명시적 `icon` 값으로 덮어쓸 수 있고, 일반 창은 Electron 기본 아이콘으로
 * 되돌아가지 않는다.
 */
const applicationIconPath = path.join(__dirname, '..', 'icons', 'icon.ico');

/** 모든 내부 BrowserWindow가 공유하는 기존 생성 옵션을 한곳에서 관리합니다. */
export function getStandardOptions(
  width: number,
  height: number,
  extraProps: BrowserWindowConstructorOptions = {},
): BrowserWindowConstructorOptions {
  const { webPreferences: extraWebPreferences, ...windowProps } = extraProps;
  return {
    width,
    height,
    icon: applicationIconPath,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      ...extraWebPreferences,
    },
    ...windowProps,
  };
}

export function isValidCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value);
}
