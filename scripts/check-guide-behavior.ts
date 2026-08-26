import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-guide-test-'));

async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

function buildTestHtml(): string {
  const guidePath = path.join(projectRoot, 'docs', 'guide', 'index.html');
  let html = fs.readFileSync(guidePath, 'utf8');
  const firstImage = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="800" height="400"%3E%3Crect width="800" height="400" fill="navy"/%3E%3C/svg%3E';
  const secondImage = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="600" height="600"%3E%3Crect width="600" height="600" fill="purple"/%3E%3C/svg%3E';
  const bootstrap = `<script>
    window.fetch = async url => ({
      ok: true,
      status: 200,
      text: async () => String(url).includes('single') ? 'SINGLE' : 'MULTIPLE'
    });
    window.marked = {
      parse: value => value === 'SINGLE'
        ? '<h1>단일 이미지</h1><img src="${firstImage}" alt="단일 화면">'
        : '<h1>복수 이미지</h1><img src="${firstImage}" alt="첫 화면"><img src="${secondImage}" alt="두 번째 화면">'
    };
  </script>`;
  html = html.replace('<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>', bootstrap);
  html = html.replace("window.history.pushState({ doc: docName }, '', newUrl);", 'void newUrl;');
  return html;
}

async function main(): Promise<void> {
  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1200, height: 800 });
  try {
    const html = buildTestHtml();
    await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await waitFor(window, "document.querySelectorAll('#doc-content img').length === 2", '초기 가이드 이미지가 준비되지 않았습니다.');

    const opened = await window.webContents.executeJavaScript(`(() => {
      const image = document.querySelector('#doc-content img');
      image.focus();
      image.click();
      return {
        hidden: document.getElementById('image-viewer').hidden,
        focusId: document.activeElement.id,
        previousHidden: document.getElementById('image-viewer-prev').hidden,
        nextHidden: document.getElementById('image-viewer-next').hidden,
        position: document.getElementById('image-viewer-position').textContent,
        viewerLeft: getComputedStyle(document.getElementById('image-viewer')).left,
      };
    })()`);
    assert.deepEqual(opened, {
      hidden: false,
      focusId: 'image-viewer-close',
      previousHidden: false,
      nextHidden: false,
      position: '1 / 2',
      viewerLeft: '280px',
    }, '복수 이미지 뷰어가 문서 영역 안에서 올바른 초기 상태로 열리지 않습니다.');

    const nextState = await window.webContents.executeJavaScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const viewerImage = document.getElementById('image-viewer-image');
      viewerImage.click();
      return {
        position: document.getElementById('image-viewer-position').textContent,
        alt: viewerImage.alt,
        zoomed: viewerImage.classList.contains('is-zoomed'),
      };
    })()`);
    assert.deepEqual(nextState, { position: '2 / 2', alt: '두 번째 화면', zoomed: true },
      '키보드 다음 이동 또는 원본 비율 확대 상태가 반영되지 않습니다.');

    const focusRestored = await window.webContents.executeJavaScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return document.activeElement === document.querySelector('#doc-content img');
    })()`);
    assert.equal(focusRestored, true, 'Esc로 이미지 뷰어를 닫은 뒤 원래 이미지로 포커스가 돌아오지 않습니다.');

    const switchedState = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#doc-content img').click();
      await window.loadDoc('single');
      const image = document.querySelector('#doc-content img');
      image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return {
        imageCount: document.querySelectorAll('#doc-content img').length,
        previousHidden: document.getElementById('image-viewer-prev').hidden,
        nextHidden: document.getElementById('image-viewer-next').hidden,
        position: document.getElementById('image-viewer-position').textContent,
      };
    })()`);
    assert.deepEqual(switchedState, {
      imageCount: 1,
      previousHidden: true,
      nextHidden: true,
      position: '1 / 1',
    }, '문서 전환 후 이전 갤러리 상태가 남거나 단일 이미지 이동 버튼이 노출됩니다.');

    const backdropClosed = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('image-viewer-stage').click();
      return document.getElementById('image-viewer').hidden;
    })()`);
    assert.equal(backdropClosed, true, '이미지 주변 배경 클릭으로 뷰어가 닫히지 않습니다.');

    console.log('Guide image viewer behavior checks passed.');
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
