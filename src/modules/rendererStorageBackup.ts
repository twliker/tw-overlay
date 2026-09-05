/**
 * 기능 계약 — 도구 저장소 백업
 * - 기본 file origin의 앱 소유 localStorage 키만 JSON으로 내보낸다. 인증·외부 페이지 저장소는 제외한다.
 * - 복원 JSON을 검증한 뒤 일반 창을 만들기 전에 적용하고, 쓰기 실패 시 기존 키를 되돌린다.
 * - 복원 적용 중단 시 JSON이 남아 다음 시작에서 재적용한다. 구형 ZIP에 JSON이 없으면 기존 값을 유지한다.
 * - scripts/check-audit-regressions.ts에서 실제 Electron 저장소와 복원 실패/성공을 확인한다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow, session } from 'electron';
import {
  RENDERER_STORAGE_FILE, RENDERER_STORAGE_KEYS, RENDERER_STORAGE_PREFIXES,
  RendererStorageSnapshot, validateRendererStorageSnapshot,
} from '../shared/rendererStorage';

async function withStorage<T>(script: string): Promise<T> {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'storage-bridge.html'));
    return await window.webContents.executeJavaScript(script) as T;
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

const storagePrelude = `
  const keys = ${JSON.stringify(RENDERER_STORAGE_KEYS)};
  const prefixes = ${JSON.stringify(RENDERER_STORAGE_PREFIXES)};
  const owned = key => keys.includes(key) || prefixes.some(prefix => key.startsWith(prefix));
  const capture = () => Object.fromEntries(Object.keys(localStorage).filter(owned).map(key => [key, localStorage.getItem(key)]));
`;

export async function captureRendererStorage(): Promise<RendererStorageSnapshot> {
  return validateRendererStorageSnapshot(await withStorage(`(() => { ${storagePrelude}
    return { schemaVersion: 1, values: capture() };
  })()`));
}

/** 재시작 때 도구 창보다 먼저 적용해 열린 구형 렌더러의 재저장 경합을 피한다. */
export async function restoreRendererStorageOnStartup(): Promise<void> {
  const pendingFile = path.join(app.getPath('userData'), RENDERER_STORAGE_FILE);
  if (!fs.existsSync(pendingFile)) return;
  const snapshot = validateRendererStorageSnapshot(JSON.parse(fs.readFileSync(pendingFile, 'utf8')));
  await withStorage(`(() => { ${storagePrelude}
    const original = capture();
    const replace = values => {
      Object.keys(localStorage).filter(owned).forEach(key => localStorage.removeItem(key));
      Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
    };
    try { replace(${JSON.stringify(snapshot.values)}); }
    catch (error) { replace(original); throw error; }
  })()`);
  session.defaultSession.flushStorageData();
  fs.unlinkSync(pendingFile);
}
