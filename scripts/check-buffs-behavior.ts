import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-buffs-test-'));

async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

function buildTestHtml(): string {
  const fixtureBuffs = [
    { id: 'exp-a', name: '경험 버프 A', category: 'Experience', effect: '경험치 +100%', duration: '30분', group: 'potato', description: '첫 경험 버프' },
    { id: 'exp-b', name: '경험 버프 B', category: 'Experience', effect: '경험치 +200%', duration: '20분', group: 'potato', description: '선택하면 A를 교체' },
    { id: 'utility-a', name: '이동 버프', category: 'Utility', effect: '이속 +5', duration: '10분', group: 'none', description: '이동 속도 증가' },
  ];
  let html = fs.readFileSync(path.join(projectRoot, 'dist', 'buffs.html'), 'utf8');
  html = html.replace(/<link[^>]+>/g, '');
  html = html.replace(/<script\s+src="[^"]+"><\/script>/g, '');
  const bootstrap = `<script>
    window.bindElectronListenerCleanup = () => {};
    window.bindEscapeClose = () => {};
    window.bindChatLogStatusWarning = () => {};
    window.electronAPI = { openExternal: () => {} };
    window.buffConstants = { STANDARD_BUFFS: ['exp-a'] };
    window.lucide = { createIcons: () => {} };
    window.alert = () => {};
    window.confirm = () => true;
    window.fetch = async () => ({ ok: true, json: async () => ${JSON.stringify(fixtureBuffs)} });
  </script>`;
  return html.replace('<head>', `<head>${bootstrap}`);
}

async function main(): Promise<void> {
  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();
  const testHtmlPath = path.join(testUserDataDirectory, 'buffs-test.html');
  fs.writeFileSync(testHtmlPath, buildTestHtml(), 'utf8');
  const window = new BrowserWindow({ show: false, width: 1080, height: 740 });

  try {
    await window.loadFile(testHtmlPath);
    await waitFor(window, "document.querySelectorAll('#buff-list .buff-card').length === 3", '버프 카드가 준비되지 않았습니다.');

    const initial = await window.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#buff-list .buff-card');
      return {
        cardTag: first.tagName,
        cardType: first.type,
        ariaPressed: first.getAttribute('aria-pressed'),
        summaryInFlow: document.querySelector('.summary-panel').classList.contains('absolute') === false,
        listHasPaddingHack: document.getElementById('buff-list').classList.contains('pb-40'),
        resultCount: document.getElementById('result-count').textContent,
        selectionCount: document.getElementById('selection-count').textContent,
      };
    })()`);
    assert.deepEqual(initial, {
      cardTag: 'BUTTON',
      cardType: 'button',
      ariaPressed: 'false',
      summaryInFlow: true,
      listHasPaddingHack: false,
      resultCount: '3개 버프',
      selectionCount: '0개 선택',
    }, '버프 선택 흐름의 초기 UI가 올바르지 않습니다.');

    const replacement = await window.webContents.executeJavaScript(`(() => {
      const cards = Array.from(document.querySelectorAll('#buff-list .buff-card'));
      cards[0].click();
      const afterFirst = Array.from(document.querySelectorAll('#buff-list .buff-card'));
      const secondWasClickable = afterFirst[1].classList.contains('conflicting') && !afterFirst[1].classList.contains('disabled');
      afterFirst[1].click();
      const afterSecond = Array.from(document.querySelectorAll('#buff-list .buff-card'));
      return {
        secondWasClickable,
        firstSelected: afterSecond[0].getAttribute('aria-pressed'),
        secondSelected: afterSecond[1].getAttribute('aria-pressed'),
        selectionCount: document.getElementById('selection-count').textContent,
        summary: document.getElementById('total-stats').textContent.replace(/\\s+/g, ' ').trim(),
      };
    })()`);
    assert.deepEqual(replacement, {
      secondWasClickable: true,
      firstSelected: 'false',
      secondSelected: 'true',
      selectionCount: '1개 선택',
      summary: 'EXP +200%',
    }, '같은 종류의 버프를 직접 교체하거나 합산 결과를 읽을 수 없습니다.');

    const category = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-category="Utility"]').click();
      return {
        resultCount: document.getElementById('result-count').textContent,
        utilityPressed: document.querySelector('[data-category="Utility"]').getAttribute('aria-pressed'),
        allPressed: document.querySelector('[data-category="ALL"]').getAttribute('aria-pressed'),
      };
    })()`);
    assert.deepEqual(category, { resultCount: '1개 버프', utilityPressed: 'true', allPressed: 'false' },
      '카테고리 필터 상태와 결과 개수가 함께 갱신되지 않습니다.');

    const escapedPreset = await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('buff_presets', JSON.stringify([{ id: 7, name: '<img id="preset-xss" src=x>', buffIds: [] }]));
      renderPresets();
      return {
        injected: Boolean(document.getElementById('preset-xss')),
        text: document.getElementById('user-preset-list').textContent.includes('<img id="preset-xss" src=x>'),
      };
    })()`);
    assert.deepEqual(escapedPreset, { injected: false, text: true }, '사용자 프리셋 이름이 HTML로 실행됩니다.');

    console.log('Buff encyclopedia behavior checks passed.');
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
