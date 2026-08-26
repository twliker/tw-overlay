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
    { id: 'exp-a', name: '경험 버프 A', category: 'Experience', effect: '경험치 +100%', duration: '30분', group: 'potato', description: '첫 경험 버프', image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', removeOnExit: true },
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
  let previewWindow: BrowserWindow | null = null;

  try {
    await window.loadFile(testHtmlPath);
    await waitFor(window, "document.querySelectorAll('#buff-list .buff-card').length === 3", '버프 카드가 준비되지 않았습니다.');

    const initial = await window.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#buff-list .buff-card');
      return {
        cardTag: first.tagName,
        cardType: first.type,
        ariaPressed: first.getAttribute('aria-pressed'),
        cardText: first.textContent.replace(/\\s+/g, ' ').trim(),
        imageShells: first.querySelectorAll('.buff-image-shell').length,
        images: first.querySelectorAll('.buff-image').length,
        names: first.querySelectorAll('.buff-name').length,
        effects: first.querySelectorAll('.buff-effect').length,
        durations: first.querySelectorAll('.buff-duration').length,
        legacyDetails: first.querySelectorAll('.buff-tag, .selection-check, p').length,
        nativeTitle: first.getAttribute('title'),
        workspacePanes: document.querySelectorAll('.buff-workspace > .workspace-pane').length,
        selectedPanelVisible: Boolean(document.getElementById('selected-buff-list')),
        emptySelectionMessage: document.getElementById('selected-buff-list').textContent.replace(/\\s+/g, ' ').trim(),
        resultCount: document.getElementById('result-count').textContent,
        selectionCount: document.getElementById('selection-count').textContent,
      };
    })()`);
    assert.deepEqual(initial, {
      cardTag: 'BUTTON',
      cardType: 'button',
      ariaPressed: 'false',
      cardText: '경험 버프 A 경험치 +100% 30분',
      imageShells: 1,
      images: 1,
      names: 1,
      effects: 1,
      durations: 1,
      legacyDetails: 0,
      nativeTitle: null,
      workspacePanes: 3,
      selectedPanelVisible: true,
      emptySelectionMessage: '아직 고른 버프가 없습니다.가운데 카드나 왼쪽 프리셋을 선택해 주세요.',
      resultCount: '3개 표시 · 전체 3개',
      selectionCount: '0개',
    }, '버프 선택 흐름의 초기 UI가 올바르지 않습니다.');

    const customTooltip = await window.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#buff-list .buff-card');
      first.dispatchEvent(new MouseEvent('mouseenter'));
      const tooltip = document.getElementById('buff-detail-tooltip');
      const rect = tooltip.getBoundingClientRect();
      const shown = {
        visible: tooltip.classList.contains('visible'),
        ariaHidden: tooltip.getAttribute('aria-hidden'),
        text: tooltip.textContent.replace(/\\s+/g, ' ').trim(),
        insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
      first.dispatchEvent(new MouseEvent('mouseleave'));
      return { ...shown, hiddenAfterLeave: tooltip.getAttribute('aria-hidden') };
    })()`);
    assert.equal(customTooltip.visible, true, '버프 상세 정보가 커스텀 툴팁으로 열리지 않습니다.');
    assert.equal(customTooltip.ariaHidden, 'false', '열린 버프 툴팁의 접근성 상태가 올바르지 않습니다.');
    assert.match(customTooltip.text, /첫 경험 버프/);
    assert.match(customTooltip.text, /분류 경험치/);
    assert.match(customTooltip.text, /중첩 같은 종류의 다른 버프와 동시에 적용되지 않습니다/);
    assert.match(customTooltip.text, /주의 재접속 시 삭제/);
    assert.equal(customTooltip.insideViewport, true, '버프 툴팁이 창 영역을 벗어납니다.');
    assert.equal(customTooltip.hiddenAfterLeave, 'true', '버프에서 벗어난 뒤 툴팁이 닫히지 않습니다.');

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
        selectedItems: document.querySelectorAll('#selected-buff-list .selected-item').length,
        selectedItemText: document.getElementById('selected-buff-list').textContent.replace(/\\s+/g, ' ').trim(),
      };
    })()`);
    assert.deepEqual(replacement, {
      secondWasClickable: true,
      firstSelected: 'false',
      secondSelected: 'true',
      selectionCount: '1개',
      summary: '경험치+200%',
      selectedItems: 1,
      selectedItemText: '경험 버프 B경험치 +200%',
    }, '같은 종류의 버프를 직접 교체하거나 합산 결과를 읽을 수 없습니다.');

    const standardPreset = await window.webContents.executeJavaScript(`(() => {
      selectPreset('standard');
      const beforeEdit = document.getElementById('selection-count').textContent;
      document.querySelectorAll('#buff-list .buff-card')[1].click();
      return {
        beforeEdit,
        afterEdit: document.getElementById('selection-count').textContent,
        state: document.getElementById('standard-preset-state').textContent,
        firstSelected: document.querySelectorAll('#buff-list .buff-card')[0].getAttribute('aria-pressed'),
        secondSelected: document.querySelectorAll('#buff-list .buff-card')[1].getAttribute('aria-pressed'),
      };
    })()`);
    assert.deepEqual(standardPreset, {
      beforeEdit: '1개',
      afterEdit: '1개',
      state: '수정됨',
      firstSelected: 'false',
      secondSelected: 'true',
    }, '기본 도핑 세트를 적용한 뒤 자유롭게 수정할 수 없습니다.');

    const category = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-category="Utility"]').click();
      return {
        resultCount: document.getElementById('result-count').textContent,
        utilityPressed: document.querySelector('[data-category="Utility"]').getAttribute('aria-pressed'),
        allPressed: document.querySelector('[data-category="ALL"]').getAttribute('aria-pressed'),
      };
    })()`);
    assert.deepEqual(category, { resultCount: '1개 표시 · 전체 3개', utilityPressed: 'true', allPressed: 'false' },
      '카테고리 필터 상태와 결과 개수가 함께 갱신되지 않습니다.');

    const selectedOnly = await window.webContents.executeJavaScript(`(() => {
      filterCategory('ALL');
      document.getElementById('selected-only-toggle').click();
      const visibleCards = Array.from(document.querySelectorAll('#buff-list .buff-card'));
      return {
        pressed: document.getElementById('selected-only-toggle').getAttribute('aria-pressed'),
        visibleCount: visibleCards.length,
        visibleName: visibleCards[0]?.textContent.includes('경험 버프 B'),
        resultCount: document.getElementById('result-count').textContent,
      };
    })()`);
    assert.deepEqual(selectedOnly, {
      pressed: 'true',
      visibleCount: 1,
      visibleName: true,
      resultCount: '1개 표시 · 전체 3개',
    }, '선택한 버프만 빠르게 확인하는 필터가 동작하지 않습니다.');

    const escapedPreset = await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('buff_presets', JSON.stringify([{ id: 7, name: '<img id="preset-xss" src=x>', buffIds: [] }]));
      renderPresets();
      return {
        injected: Boolean(document.getElementById('preset-xss')),
        text: document.getElementById('user-preset-list').textContent.includes('<img id="preset-xss" src=x>'),
      };
    })()`);
    assert.deepEqual(escapedPreset, { injected: false, text: true }, '사용자 프리셋 이름이 HTML로 실행됩니다.');

    const previewPath = process.env.TW_OVERLAY_BUFFS_PREVIEW_PATH;
    previewWindow = new BrowserWindow({ show: false, width: 1080, height: 740 });
    await previewWindow.loadFile(path.join(projectRoot, 'dist', 'buffs.html'));
    await waitFor(previewWindow, "document.querySelectorAll('#buff-list .buff-card').length > 10", '실제 버프 화면이 준비되지 않았습니다.');
    const visualLayout = await previewWindow.webContents.executeJavaScript(`(() => {
      const panes = Array.from(document.querySelectorAll('.buff-workspace > .workspace-pane'));
      const rects = panes.map(pane => pane.getBoundingClientRect());
      return {
        paneCount: panes.length,
        paneWidths: rects.map(rect => Math.round(rect.width)),
        paneBottoms: rects.map(rect => Math.round(rect.bottom)),
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        viewportHeight: document.documentElement.clientHeight,
        descriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.pane-description')).fontSize),
        selectedPanelVisible: document.getElementById('selected-buff-list').getBoundingClientRect().width > 0,
        cardCount: document.querySelectorAll('#buff-list .buff-card').length,
        listLayout: getComputedStyle(document.getElementById('buff-list')).display,
        cardLayout: getComputedStyle(document.querySelector('#buff-list .buff-card')).display,
        imageShellCount: document.querySelectorAll('#buff-list .buff-card .buff-image-shell').length,
        compactFieldCount: document.querySelectorAll('#buff-list .buff-card:first-child .buff-name, #buff-list .buff-card:first-child .buff-effect, #buff-list .buff-card:first-child .buff-duration').length,
        exposedDetailCount: document.querySelectorAll('#buff-list .buff-card .buff-tag, #buff-list .buff-card .selection-check, #buff-list .buff-card p').length,
        effectFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.buff-effect')).fontSize),
        resultCount: document.getElementById('result-count').textContent,
      };
    })()`);
    assert.equal(visualLayout.paneCount, 3, '실제 화면이 프리셋·백과·현재 조합의 세 영역으로 나뉘지 않습니다.');
    assert.ok(visualLayout.paneWidths[0] >= 200 && visualLayout.paneWidths[1] >= 350 && visualLayout.paneWidths[2] >= 240,
      `세 영역의 실제 너비가 사용 가능하지 않습니다: ${visualLayout.paneWidths.join(', ')}`);
    assert.ok(visualLayout.paneBottoms.every((bottom: number) => bottom <= visualLayout.viewportHeight + 1),
      `버프 화면 영역이 창 높이를 벗어납니다: ${visualLayout.paneBottoms.join(', ')}/${visualLayout.viewportHeight}`);
    assert.equal(visualLayout.scrollWidth, visualLayout.viewportWidth, '버프 화면 전체에 가로 잘림이 발생합니다.');
    assert.ok(visualLayout.descriptionFontSize >= 12, '버프 화면 설명 글자가 디자인 최소 크기보다 작습니다.');
    assert.equal(visualLayout.selectedPanelVisible, true, '현재 조합 패널이 실제 화면에서 보이지 않습니다.');
    assert.equal(visualLayout.listLayout, 'flex', '버프가 세로 목록 형태로 표시되지 않습니다.');
    assert.equal(visualLayout.cardLayout, 'grid', '버프 행의 이미지·텍스트·지속시간 정렬이 깨졌습니다.');
    assert.equal(visualLayout.imageShellCount, visualLayout.cardCount, '모든 버프 행에 이미지 영역이 표시되지 않습니다.');
    assert.equal(visualLayout.compactFieldCount, 3, '버프 행에 이름·효과·지속시간이 모두 표시되지 않습니다.');
    assert.equal(visualLayout.exposedDetailCount, 0, '상세 설명이 간결한 버프 목록에 노출됩니다.');
    assert.ok(visualLayout.effectFontSize >= 12, '버프 효과 글자가 디자인 최소 크기보다 작습니다.');
    assert.ok(visualLayout.cardCount > 10 && /전체 \d+개/.test(visualLayout.resultCount),
      `실제 버프 목록이 화면에 렌더링되지 않습니다: ${visualLayout.cardCount}/${visualLayout.resultCount}`);

    if (previewPath) {
      await previewWindow.webContents.executeJavaScript(`(() => {
        localStorage.removeItem('buff_presets');
        selectPreset('standard');
        if (${JSON.stringify(process.env.TW_OVERLAY_BUFFS_PREVIEW_TOOLTIP === '1')}) {
          document.querySelector('#buff-list .buff-card')?.dispatchEvent(new MouseEvent('mouseenter'));
        }
      })()`);
      previewWindow.showInactive();
      await new Promise(resolve => setTimeout(resolve, 300));
      const image = await previewWindow.capturePage();
      fs.writeFileSync(previewPath, image.toPNG());
      previewWindow.hide();
    }

    console.log('Buff encyclopedia behavior checks passed.');
  } finally {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
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
