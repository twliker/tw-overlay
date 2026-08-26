import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-eta-ranking-test-'));

async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

function checkSizingPolicy(): void {
  const registryModule = require(path.join(projectRoot, 'dist', 'modules', 'managedWindowRegistry.js')) as {
    createManagedWindowRegistry: () => Record<string, { width: number; height: number }>;
  };
  const sizing = require(path.join(projectRoot, 'dist', 'modules', 'managedWindowSizing.js')) as {
    resolveManagedWindowSizing: (
      key: string,
      width: number,
      height: number,
      config: Record<string, unknown>,
      workAreaSize: { width: number; height: number },
    ) => Record<string, unknown>;
    createManagedWindowSizePatch: (key: string, width: number, height: number) => Record<string, unknown> | null;
  };
  const eta = registryModule.createManagedWindowRegistry().etaRanking;
  assert.deepEqual({ width: eta.width, height: eta.height }, { width: 680, height: 720 },
    'ETA 랭킹의 새 기본 크기가 적용되지 않았습니다.');
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('etaRanking', eta.width, eta.height, { etaRankingWidth: 900, etaRankingHeight: 800 }, { width: 1920, height: 1080 }),
    { width: 900, height: 800, isResizable: true, isTransparent: true, minWidth: 520, minHeight: 560, policy: 'user-resizable' },
    '사용자가 저장한 더 큰 ETA 랭킹 창 크기를 보존하지 않습니다.',
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('etaRanking', eta.width, eta.height, { etaRankingWidth: 320, etaRankingHeight: 400 }, { width: 800, height: 600 }),
    { width: 520, height: 560, isResizable: true, isTransparent: true, minWidth: 520, minHeight: 560, policy: 'user-resizable' },
    '과소 저장된 ETA 랭킹 크기를 작업 영역 안의 최소 크기로 복구하지 않습니다.',
  );
  assert.deepEqual(sizing.createManagedWindowSizePatch('etaRanking', 760, 740), {
    etaRankingWidth: 760,
    etaRankingHeight: 740,
  }, 'ETA 랭킹 창 크기 저장 필드가 연결되지 않았습니다.');
}

function buildTestHtml(): string {
  const source = fs.readFileSync(path.join(projectRoot, 'dist', 'eta-ranking.html'), 'utf8');
  assert.match(source, /eta-content[^>]*min-h-0[^>]*overflow-hidden/,
    '작은 창에서 ETA 본문이 결과 스크롤 영역을 밀어냅니다.');
  assert.match(source, /flex-1 custom-scroll overflow-y-auto/,
    'ETA 결과 목록에 독립 세로 스크롤이 없습니다.');
  assert.match(source, /@media \(max-width: 600px\), \(max-height: 640px\)/,
    '작은 작업 영역용 ETA 여백 축소 규칙이 없습니다.');

  let html = source.replace(/<link[^>]+>/g, '');
  html = html.replace(/<script\s+src="[^"]+"><\/script>/g, '');
  const bootstrap = `<script>
    window.bindElectronListenerCleanup = () => {};
    window.bindEscapeClose = () => {};
    window.refreshIcons = () => {};
    window.electronAPI = {
      openExternal: () => {},
      getEtaRanking: async () => ({
        lastUpdate: '방금 전',
        entries: [{ rank: 1, nickname: '<img id="eta-xss" src=x>', character: '<b>캐릭터</b>', level: 310, point: 123456 }]
      })
    };
  </script>`;
  return html.replace('<head>', `<head>${bootstrap}`);
}

async function main(): Promise<void> {
  checkSizingPolicy();
  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();
  const testHtmlPath = path.join(testUserDataDirectory, 'eta-ranking-test.html');
  fs.writeFileSync(testHtmlPath, buildTestHtml(), 'utf8');
  const window = new BrowserWindow({ show: false, width: 520, height: 560 });

  try {
    await window.loadFile(testHtmlPath);
    await waitFor(window, "document.querySelectorAll('#ranking-list .post-item').length === 1", 'ETA 랭킹 결과가 준비되지 않았습니다.');
    const rendered = await window.webContents.executeJavaScript(`(() => ({
      injectedImage: Boolean(document.getElementById('eta-xss')),
      nicknameText: document.querySelector('.post-item .flex-1 span')?.textContent,
      characterText: document.querySelectorAll('.post-item .flex-1 span')[1]?.textContent,
      pointText: document.querySelector('.post-item > div:last-child > div:last-child')?.textContent.trim(),
    }))()`);
    assert.deepEqual(rendered, {
      injectedImage: false,
      nicknameText: '<img id="eta-xss" src=x>',
      characterText: '<b>캐릭터</b>',
      pointText: '123,456 정수',
    }, 'ETA API 문자열이 텍스트로 안전하게 렌더링되지 않습니다.');

    console.log('ETA ranking sizing and renderer checks passed.');
  } finally {
    if (!window.isDestroyed()) window.destroy();
    try {
      fs.rmSync(testUserDataDirectory, { recursive: true, force: true });
    } catch {
      // Electron 종료 직전 잠긴 임시 파일은 운영체제의 임시 폴더 정리에 맡깁니다.
    }
    app.quit();
  }
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
