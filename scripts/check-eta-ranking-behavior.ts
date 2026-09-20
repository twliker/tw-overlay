import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow, ipcMain, session } from 'electron';

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

async function checkHtmlSourceToScreen(): Promise<void> {
  // Only the HTTP response is replaced. The production fetch/parser, preload and
  // complete ranking page run, so returning already-decoded mock entries cannot hide this defect.
  const encodedNames = ['리사&#208;', '이름&#x1F600;', 'A&amp;B&apos;&quot;&ETH;', '&amp;#208;', '&lt;img id=&quot;eta-parser-xss&quot; src=x&gt;'];
  const expectedNames = ['리사Ð', '이름😀', 'A&B\'"Ð', '&#208;', '<img id="eta-parser-xss" src=x>'];
  const requests: URL[] = [];
  const rows = encodedNames.map((name, index) => `<tr><td class="col_rank"><span class="number">${index + 1}</span></td>
    <td class="col_char"><span class="charname">티치엘&amp;보리스</span><span class="nickname">${name}</span></td>
    <td class="number col_level">90</td><td class="number col_point">1,234</td></tr>`).join('');
  session.defaultSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'tales.nexon.com') return new Response('', { status: 404 });
    requests.push(url);
    return new Response(`<dl><dt>Last Update :</dt><dd>2026-09-23 08:17:53</dd></dl><table>${rows}</table>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const { fetchEtaRanking } = require(path.join(projectRoot, 'dist/modules/etaRanking.js')) as {
    fetchEtaRanking: (params: { sc?: number; cc?: number; page?: number; search?: string }) => Promise<unknown>;
  };
  ipcMain.handle('get-eta-ranking', (_event, params) => fetchEtaRanking(params));
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(projectRoot, 'dist/preload.js'), contextIsolation: true, sandbox: false,
  } });
  try {
    await window.loadFile(path.join(projectRoot, 'dist/eta-ranking.html'));
    await waitFor(window, "document.querySelectorAll('#ranking-list .post-item').length === 5", '실제 ETA 파서 결과가 화면에 도착하지 않았습니다.');
    const readRows = () => window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.post-item .flex-1 span:first-child')).map(el=>el.textContent)`);
    assert.deepEqual(await readRows(), expectedNames, '공홈 HTML 문자 참조를 원래 이름으로 한 번만 복원해야 합니다.');
    assert.equal(await window.webContents.executeJavaScript("!!document.getElementById('eta-parser-xss')"), false,
      '복원된 이름은 HTML로 실행하지 않고 문자 그대로 표시해야 합니다.');
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.post-item .flex-1 span')[1].textContent"), '티치엘&보리스');
    await window.webContents.executeJavaScript("document.getElementById('search-input').value='리사Ð'; document.getElementById('search-btn').click()");
    await waitFor(window, "!document.getElementById('search-input').disabled", '검색이 완료되지 않았습니다.');
    assert.equal(requests.at(-1)?.searchParams.get('search'), '리사Ð', '검색 이름을 다시 HTML 인코딩해서 요청했습니다.');
    assert.deepEqual(await readRows(), expectedNames, '검색 응답의 문자 복원 경로가 다릅니다.');
    await window.webContents.executeJavaScript(`document.querySelector('input[name="server"][value="16"]').click()`);
    await waitFor(window, "!document.getElementById('search-input').disabled", '서버 변경이 완료되지 않았습니다.');
    assert.equal(requests.at(-1)?.searchParams.get('sc'), '16');
    assert.equal(requests.at(-1)?.searchParams.has('search'), false, '서버 전환 시 검색어를 지우는 기존 동작이 바뀌었습니다.');
    assert.deepEqual(await readRows(), expectedNames, '서버 목록의 문자 복원 경로가 다릅니다.');
  } finally {
    window.destroy();
    ipcMain.removeHandler('get-eta-ranking');
    session.defaultSession.protocol.unhandle('https');
  }
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

    await checkHtmlSourceToScreen();
    console.log('ETA ranking sizing, real fetch/parser/preload/page, list/search/server and safe entity rendering checks passed.');
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
