import type { BrowserWindowConstructorOptions } from 'electron';
import * as path from 'path';

/** 모든 내부 BrowserWindow가 공유하는 기존 생성 옵션을 한곳에서 관리합니다. */
export function getStandardOptions(
  width: number,
  height: number,
  extraProps: BrowserWindowConstructorOptions = {},
): BrowserWindowConstructorOptions {
  return {
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      ...extraProps.webPreferences,
    },
    ...extraProps,
  };
}

export function isValidCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value);
}
