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
  const svgImage = (width: number, height: number): string =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`)}`;
  const fixtureBuffs = [
    { id: 'exp-a', name: '경험 버프 A', category: 'Experience', effect: '경험치 +100%', duration: '30분', group: 'potato', description: '첫 경험 버프', image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', removeOnDeath: true, removeOnExit: true },
    { id: 'exp-b', name: '경험 버프 B', category: 'Experience', effect: '경험치 +200%', duration: '20분', group: 'potato', description: '선택하면 A를 교체', image: svgImage(10, 30) },
    { id: 'utility-a', name: '이동 버프', category: 'Utility', effect: '이속 +5', duration: '10분', group: 'none', description: '이동 속도 증가', image: svgImage(30, 10) },
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
  const realBuffs = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src', 'assets', 'data', 'buffs.json'), 'utf8'));
  const removedNames = [
    '레어의 밤고구마',
    '숙성된 밤 고구마',
    '얼리버드 레어 부스터',
    '신뢰의 물약',
    '축복의 물약',
    '각성의 비약',
    '괴력의 물약',
  ];
  assert.equal(realBuffs.some((buff: any) => removedNames.includes(buff.name)), false,
    '더 이상 사용하지 않는 버프가 버프 백과 데이터에 남아 있습니다.');
  assert.equal(realBuffs.find((buff: any) => buff.id === 'exp_club_e2')?.name, '클럽 상점 버프 (E-2)',
    'E-2 클럽 버프 명칭이 변경되지 않았습니다.');
  const clubBuffs = realBuffs.filter((buff: any) => String(buff.name).startsWith('클럽 상점 버프'));
  assert.ok(clubBuffs.length >= 5 && clubBuffs.every((buff: any) => buff.image === 'assets/img/buffs/클럽상점버프.png'),
    '클럽 상점 버프가 공통 이미지를 사용하지 않습니다.');
  for (const [id, image] of [
    ['exp_stamp', 'assets/img/buffs/참잘했어요경험치.png'],
    ['dmg_potion_plus', 'assets/img/buffs/개각성의비약.png'],
    ['stat_trust_plus', 'assets/img/buffs/개신뢰의물약.png'],
  ]) {
    assert.equal(realBuffs.find((buff: any) => buff.id === id)?.image, image, `${id} 버프 이미지 연결이 올바르지 않습니다.`);
  }
  for (const ids of [
    ['exp_izabel_secret', 'exp_izabel_special'],
    ['stat_izabel_fixed', 'stat_izabel_special_fixed'],
    ['stat_izabel_ratio', 'stat_izabel_special_ratio'],
    ['dmg_izabel', 'dmg_izabel_special'],
  ]) {
    const images = ids.map(id => realBuffs.find((buff: any) => buff.id === id)?.image);
    assert.ok(images[0] && images[0] === images[1], `${ids.join('/')} 버프가 같은 이미지를 사용하지 않습니다.`);
  }
  realBuffs.filter((buff: any) => buff.image).forEach((buff: any) => {
    assert.ok(fs.existsSync(path.join(projectRoot, 'src', buff.image)), `${buff.name} 이미지 파일을 찾을 수 없습니다: ${buff.image}`);
  });

  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();
  const testHtmlPath = path.join(testUserDataDirectory, 'buffs-test.html');
  fs.writeFileSync(testHtmlPath, buildTestHtml(), 'utf8');
  const window = new BrowserWindow({ show: false, width: 1080, height: 740 });
  let previewWindow: BrowserWindow | null = null;

  try {
    await window.loadFile(testHtmlPath);
    await waitFor(window, "document.querySelectorAll('#buff-list .buff-card').length === 3", '버프 카드가 준비되지 않았습니다.');
    await waitFor(window, "document.querySelectorAll('.buff-image.fit-square, .buff-image.fit-portrait, .buff-image.fit-landscape').length === 3",
      '버프 이미지 비율에 맞는 표시 방식이 적용되지 않았습니다.');

    const initial = await window.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#buff-list .buff-card');
      const detailButton = first.querySelector('.buff-card-main');
      const selectButton = first.querySelector('.buff-select-action');
      return {
        cardTag: first.tagName,
        detailButtonType: detailButton.type,
        selectButtonType: selectButton.type,
        selectAriaPressed: selectButton.getAttribute('aria-pressed'),
        cardText: first.textContent.replace(/\\s+/g, ' ').trim(),
        imageShells: first.querySelectorAll('.buff-image-shell').length,
        images: first.querySelectorAll('.buff-image').length,
        names: first.querySelectorAll('.buff-name').length,
        effects: first.querySelectorAll('.buff-effect').length,
        durations: first.querySelectorAll('.buff-duration').length,
        legacyDetails: first.querySelectorAll('.buff-tag, .selection-check, p').length,
        nativeTitle: first.getAttribute('title'),
        workspacePanes: document.querySelectorAll('.buff-workspace > .workspace-pane').length,
        directPresetVisible: Boolean(document.querySelector('[data-preset-id="direct"]')),
        directPresetActive: document.querySelector('[data-preset-id="direct"]')?.classList.contains('active'),
        directPresetBadge: document.querySelector('[data-preset-id="direct"] .preset-card-badge')?.textContent,
        duplicateSelectedListRemoved: document.getElementById('selected-buff-list') === null,
        presetFormHidden: document.getElementById('preset-save-fields').classList.contains('hidden'),
        emptyPresetEnabled: !document.getElementById('begin-empty-preset-button').disabled,
        selectedPresetDisabled: document.getElementById('begin-selected-preset-button').disabled,
        resultCount: document.getElementById('result-count').textContent,
        selectionCount: document.getElementById('selection-count').textContent,
      };
    })()`);
    assert.deepEqual(initial, {
      cardTag: 'ARTICLE',
      detailButtonType: 'button',
      selectButtonType: 'button',
      selectAriaPressed: 'false',
      cardText: '경험 버프 A 경험치 +100% 30분 추가',
      imageShells: 1,
      images: 1,
      names: 1,
      effects: 1,
      durations: 1,
      legacyDetails: 0,
      nativeTitle: null,
      workspacePanes: 2,
      directPresetVisible: true,
      directPresetActive: true,
      directPresetBadge: '직접 계산 중',
      duplicateSelectedListRemoved: true,
      presetFormHidden: true,
      emptyPresetEnabled: true,
      selectedPresetDisabled: true,
      resultCount: '3개 표시 · 전체 3개',
      selectionCount: '0개',
    }, '버프 선택 흐름의 초기 UI가 올바르지 않습니다.');

    const stalePresetCleanup = await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('buff_presets', JSON.stringify([{ id: 1, name: '이전 버프 포함', buffIds: ['exp-a', 'removed-buff'] }]));
      const sanitized = getPresets();
      const stored = JSON.parse(localStorage.getItem('buff_presets'));
      localStorage.removeItem('buff_presets');
      return { returnedIds: sanitized[0].buffIds, storedIds: stored[0].buffIds };
    })()`);
    assert.deepEqual(stalePresetCleanup, { returnedIds: ['exp-a'], storedIds: ['exp-a'] },
      '삭제된 버프 ID가 기존 사용자 프리셋에서 정리되지 않습니다.');

    const imageFits = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#buff-list .buff-image')).map(image => image.className)`);
    assert.match(imageFits[0], /fit-square/, '정사각형 버프 이미지의 표시 기준이 올바르지 않습니다.');
    assert.match(imageFits[1], /fit-portrait/, '세로로 긴 버프 이미지가 높이 기준으로 표시되지 않습니다.');
    assert.match(imageFits[2], /fit-landscape/, '가로로 긴 버프 이미지가 너비 기준으로 표시되지 않습니다.');

    const inlineDetail = await window.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#buff-list .buff-card');
      first.querySelector('.buff-card-main').click();
      const expanded = document.querySelector('#buff-list .buff-card');
      const detail = expanded.querySelector('.buff-card-detail');
      const nextCard = expanded.nextElementSibling;
      const expandedRect = expanded.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();
      return {
        expanded: expanded.classList.contains('inspected'),
        ariaExpanded: expanded.querySelector('.buff-card-main').getAttribute('aria-expanded'),
        text: detail?.textContent.replace(/\\s+/g, ' ').trim(),
        selectionCount: document.getElementById('selection-count').textContent,
        detailInsideCard: detailRect.bottom <= expandedRect.bottom + 1,
        nextCardBelow: !nextCard || nextCard.getBoundingClientRect().top >= expandedRect.bottom,
        deathNoticeVisible: detail?.textContent.includes('사망 시 삭제'),
        exitNoticeVisible: detail?.textContent.includes('재접속 시 삭제'),
      };
    })()`);
    assert.equal(inlineDetail.expanded, true, '버프 상세 정보가 카드 안에서 펼쳐지지 않습니다.');
    assert.equal(inlineDetail.ariaExpanded, 'true', '열린 버프 상세 영역의 접근성 상태가 올바르지 않습니다.');
    assert.match(inlineDetail.text, /첫 경험 버프/);
    assert.match(inlineDetail.text, /분류 · 경험치/);
    assert.match(inlineDetail.text, /같은 종류와 중복 불가/);
    assert.equal(inlineDetail.deathNoticeVisible, false, '숨기기로 한 사망 시 삭제 옵션이 상세 정보에 표시됩니다.');
    assert.equal(inlineDetail.exitNoticeVisible, false, '숨기기로 한 재접속 시 삭제 옵션이 상세 정보에 표시됩니다.');
    assert.equal(inlineDetail.selectionCount, '0개', '상세 설명만 열었는데 버프가 선택됩니다.');
    assert.equal(inlineDetail.detailInsideCard, true, '펼친 상세 설명이 버프 카드 밖으로 넘칩니다.');
    assert.equal(inlineDetail.nextCardBelow, true, '펼친 상세 설명과 다음 버프 카드가 겹칩니다.');

    const replacement = await window.webContents.executeJavaScript(`(() => {
      const cards = Array.from(document.querySelectorAll('#buff-list .buff-card'));
      cards[0].querySelector('.buff-select-action').click();
      const afterFirst = Array.from(document.querySelectorAll('#buff-list .buff-card'));
      const secondWasClickable = afterFirst[1].classList.contains('conflicting') && !afterFirst[1].classList.contains('disabled');
      afterFirst[1].querySelector('.buff-select-action').click();
      const afterSecond = Array.from(document.querySelectorAll('#buff-list .buff-card'));
      return {
        exitWarningRemoved: document.getElementById('warnings') === null,
        secondWasClickable,
        firstSelected: afterSecond[0].querySelector('.buff-select-action').getAttribute('aria-pressed'),
        secondSelected: afterSecond[1].querySelector('.buff-select-action').getAttribute('aria-pressed'),
        selectionCount: document.getElementById('selection-count').textContent,
        summary: document.getElementById('total-stats').textContent.replace(/\\s+/g, ' ').trim(),
        selectedPresetButtonEnabled: !document.getElementById('begin-selected-preset-button').disabled,
        selectedPresetSourceCount: document.getElementById('selected-preset-source-count').textContent,
        directPresetActive: document.querySelector('[data-preset-id="direct"]').classList.contains('active'),
        currentLabel: document.getElementById('selected-preset-label').textContent,
      };
    })()`);
    assert.deepEqual(replacement, {
      exitWarningRemoved: true,
      secondWasClickable: true,
      firstSelected: 'false',
      secondSelected: 'true',
      selectionCount: '1개',
      summary: '경험치+200%',
      selectedPresetButtonEnabled: true,
      selectedPresetSourceCount: '(1)',
      directPresetActive: true,
      currentLabel: '프리셋 없이 직접 선택 중',
    }, '같은 종류의 버프를 직접 교체하거나 합산 결과를 읽을 수 없습니다.');

    const standardPreset = await window.webContents.executeJavaScript(`(() => {
      selectPreset('standard');
      const beforeEdit = document.getElementById('selection-count').textContent;
      document.querySelectorAll('#buff-list .buff-card')[1].querySelector('.buff-select-action').click();
      const standardCard = document.querySelector('[data-preset-id="standard"]');
      return {
        beforeEdit,
        afterEdit: document.getElementById('selection-count').textContent,
        cardActive: standardCard.classList.contains('active'),
        cardModified: standardCard.classList.contains('modified'),
        badge: standardCard.querySelector('.preset-card-badge')?.textContent,
        cardPressed: standardCard.querySelector('[data-action="apply-preset"]').getAttribute('aria-pressed'),
        firstSelected: document.querySelectorAll('#buff-list .buff-card')[0].querySelector('.buff-select-action').getAttribute('aria-pressed'),
        secondSelected: document.querySelectorAll('#buff-list .buff-card')[1].querySelector('.buff-select-action').getAttribute('aria-pressed'),
      };
    })()`);
    assert.deepEqual(standardPreset, {
      beforeEdit: '1개',
      afterEdit: '1개',
      cardActive: true,
      cardModified: true,
      badge: '변경됨',
      cardPressed: 'true',
      firstSelected: 'false',
      secondSelected: 'true',
    }, '기본 도핑 세트를 적용한 뒤 자유롭게 수정할 수 없습니다.');

    const directMode = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-preset-id="direct"] [data-action="apply-preset"]').click();
      return {
        selectionCount: selectedBuffIds.size,
        savedSelectionCount: JSON.parse(localStorage.getItem('buff_current_selection')).length,
        directActive: document.querySelector('[data-preset-id="direct"]').classList.contains('active'),
        standardActive: document.querySelector('[data-preset-id="standard"]').classList.contains('active'),
        label: document.getElementById('selected-preset-label').textContent,
      };
    })()`);
    assert.deepEqual(directMode, {
      selectionCount: 0,
      savedSelectionCount: 0,
      directActive: true,
      standardActive: false,
      label: '프리셋 없이 직접 선택 중',
    }, '프리셋 없이 직접 선택할 때 기존 버프 조합이 초기화되지 않습니다.');

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
      toggleSelection('exp-b');
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

    const presetEditing = await window.webContents.executeJavaScript(`(() => {
      if (document.getElementById('selected-only-toggle').getAttribute('aria-pressed') === 'true') toggleSelectedOnly();
      filterCategory('ALL');
      const nameInput = document.getElementById('preset-name');
      beginPresetCreation('selected');
      nameInput.value = '원본 조합';
      saveCurrentPreset();
      document.getElementById('begin-selected-preset-button').click();
      const draftCard = document.querySelector('[data-preset-id="new"]');
      const createState = {
        footerCreating: document.getElementById('preset-save-footer').classList.contains('creating'),
        title: document.getElementById('preset-save-title').textContent,
        description: document.getElementById('preset-save-description').textContent,
        status: document.getElementById('preset-editing-status').textContent.replace(/\\s+/g, ' ').trim(),
        button: document.getElementById('save-preset-button').textContent,
        cancelButton: document.getElementById('cancel-preset-edit-button').textContent,
        presetCount: JSON.parse(localStorage.getItem('buff_presets')).length,
        presetCards: document.querySelectorAll('#preset-list .preset-card').length,
        actionText: document.querySelector('#preset-list .preset-card:not([data-preset-id="standard"]):not([data-preset-id="direct"]):not([data-preset-id="new"]) .preset-card-actions').textContent.replace(/\\s+/g, ' ').trim(),
        draftName: draftCard?.querySelector('.preset-card-name').textContent,
        draftBadge: draftCard?.querySelector('.preset-card-badge').textContent,
        draftActive: draftCard?.classList.contains('active'),
        draftCreating: draftCard?.classList.contains('creating'),
        currentLabel: document.getElementById('selected-preset-label').textContent,
        newPresetFocusTarget: document.activeElement?.id,
      };
      document.querySelector('#preset-list .preset-card:not([data-preset-id="standard"]):not([data-preset-id="direct"]):not([data-preset-id="new"]) [data-action="edit-preset"]').click();
      const editingCard = document.querySelector('#preset-list .preset-card:not([data-preset-id="standard"]):not([data-preset-id="direct"]):not([data-preset-id="new"])');
      const editState = {
        footerEditing: document.getElementById('preset-save-footer').classList.contains('editing'),
        title: document.getElementById('preset-save-title').textContent,
        description: document.getElementById('preset-save-description').textContent,
        status: document.getElementById('preset-editing-status').textContent.replace(/\\s+/g, ' ').trim(),
        statusVisible: !document.getElementById('preset-editing-status').classList.contains('hidden'),
        currentLabel: document.getElementById('selected-preset-label').textContent,
        cardActive: editingCard.classList.contains('active'),
        cardEditing: editingCard.classList.contains('editing'),
        cardBadge: editingCard.querySelector('.preset-card-badge')?.textContent,
        inputValue: nameInput.value,
        cancelVisible: !document.getElementById('cancel-preset-edit-button').classList.contains('hidden'),
        saveButton: document.getElementById('save-preset-button').textContent,
        draftRemoved: document.querySelector('[data-preset-id="new"]') === null,
      };
      toggleSelection('utility-a');
      nameInput.value = '수정 조합';
      saveCurrentPreset();
      const saved = JSON.parse(localStorage.getItem('buff_presets'));
      const saveState = {
        presetCount: saved.length,
        name: saved[0].name,
        buffCount: saved[0].buffIds.length,
        title: document.getElementById('preset-save-title').textContent,
        statusHidden: document.getElementById('preset-editing-status').classList.contains('hidden'),
        saveButton: document.getElementById('save-preset-button').textContent,
      };
      document.querySelector('#preset-list .preset-card:not([data-preset-id="standard"]):not([data-preset-id="direct"]):not([data-preset-id="new"]) [data-action="edit-preset"]').click();
      toggleSelection('utility-a');
      const selectionDuringSecondEdit = document.getElementById('selection-count').textContent;
      cancelPresetEditing();
      const cancelState = {
        selectionDuringSecondEdit,
        selectionAfterCancel: document.getElementById('selection-count').textContent,
        title: document.getElementById('preset-save-title').textContent,
        statusHidden: document.getElementById('preset-editing-status').classList.contains('hidden'),
        cancelHidden: document.getElementById('cancel-preset-edit-button').classList.contains('hidden'),
      };
      return { createState, editState, saveState, cancelState };
    })()`);
    assert.deepEqual(presetEditing.createState, {
      footerCreating: true,
      title: '선택된 버프로 프리셋 생성',
      description: '선택 버프 1개에 이름을 붙인 뒤 새 프리셋 저장을 누르세요.',
      status: "'새 프리셋' 생성 중",
      button: '새 프리셋 저장',
      cancelButton: '생성 취소',
      presetCount: 1,
      presetCards: 4,
      actionText: '수정삭제',
      draftName: '새 프리셋',
      draftBadge: '생성 중',
      draftActive: true,
      draftCreating: true,
      currentLabel: '새 프리셋 생성 중',
      newPresetFocusTarget: 'preset-name',
    }, '새 프리셋 생성 상태가 명확하게 표시되지 않습니다.');
    assert.deepEqual(presetEditing.editState, {
      footerEditing: true,
      title: "'원본 조합' 수정",
      description: '이름과 선택 버프 1개를 바꾼 뒤 변경 저장을 누르세요.',
      status: "'원본 조합' 프리셋 수정 중",
      statusVisible: true,
      currentLabel: '원본 조합 수정 중',
      cardActive: true,
      cardEditing: true,
      cardBadge: '수정 중',
      inputValue: '원본 조합',
      cancelVisible: true,
      saveButton: '변경 저장',
      draftRemoved: true,
    }, '기존 프리셋 수정 상태와 대상이 명확하게 표시되지 않습니다.');
    assert.deepEqual(presetEditing.saveState, {
      presetCount: 1,
      name: '수정 조합',
      buffCount: 2,
      title: '프리셋을 선택하거나 새로 만드세요',
      statusHidden: true,
      saveButton: '새 프리셋 저장',
    }, '프리셋 변경 저장이 기존 항목을 수정하지 않고 새 항목을 만들거나 수정 상태를 남깁니다.');
    assert.deepEqual(presetEditing.cancelState, {
      selectionDuringSecondEdit: '1개',
      selectionAfterCancel: '2개',
      title: '프리셋을 선택하거나 새로 만드세요',
      statusHidden: true,
      cancelHidden: true,
    }, '프리셋 수정 취소 후 진입 전 조합과 생성 상태가 복원되지 않습니다.');

    const presetCreationCancel = await window.webContents.executeJavaScript(`(() => {
      const selectionBefore = JSON.stringify(Array.from(selectedBuffIds).sort());
      const activeBefore = activePresetId;
      beginPresetCreation('empty');
      const selectionAfterStart = selectedBuffIds.size;
      toggleSelection('utility-a');
      document.getElementById('preset-name').value = '저장하지 않을 조합';
      cancelPresetEditing();
      return {
        selectionRestored: JSON.stringify(Array.from(selectedBuffIds).sort()) === selectionBefore,
        selectionAfterStart,
        activeRestored: Number(activePresetId) === Number(activeBefore),
        draftRemoved: document.querySelector('[data-preset-id="new"]') === null,
        formHidden: document.getElementById('preset-save-fields').classList.contains('hidden'),
        inputCleared: document.getElementById('preset-name').value === '',
      };
    })()`);
    assert.deepEqual(presetCreationCancel, {
      selectionRestored: true,
      selectionAfterStart: 0,
      activeRestored: true,
      draftRemoved: true,
      formHidden: true,
      inputCleared: true,
    }, '새 프리셋 생성을 취소했을 때 임시 카드와 변경 조합이 남습니다.');

    const presetDeletion = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#preset-list .preset-card:not([data-preset-id="standard"]):not([data-preset-id="direct"]):not([data-preset-id="new"]) [data-action="delete-preset"]').click();
      return {
        storedCount: JSON.parse(localStorage.getItem('buff_presets')).length,
        customCardCount: document.querySelectorAll('#preset-list .preset-card:not([data-preset-id="standard"]):not([data-preset-id="direct"]):not([data-preset-id="new"])').length,
        selectionCount: document.getElementById('selection-count').textContent,
        currentLabel: document.getElementById('selected-preset-label').textContent,
      };
    })()`);
    assert.deepEqual(presetDeletion, {
      storedCount: 0,
      customCardCount: 0,
      selectionCount: '2개',
      currentLabel: '프리셋 없이 직접 선택 중',
    }, '프리셋 카드의 삭제 버튼이 저장 항목만 안전하게 제거하지 못합니다.');

    const escapedPreset = await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('buff_presets', JSON.stringify([{ id: 7, name: '<img id="preset-xss" src=x>', buffIds: [] }]));
      renderPresets();
      return {
        injected: Boolean(document.getElementById('preset-xss')),
        text: document.getElementById('preset-list').textContent.includes('<img id="preset-xss" src=x>'),
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
        duplicateSelectedListRemoved: document.getElementById('selected-buff-list') === null,
        cardCount: document.querySelectorAll('#buff-list .buff-card').length,
        listLayout: getComputedStyle(document.getElementById('buff-list')).display,
        cardLayout: getComputedStyle(document.querySelector('#buff-list .buff-card')).display,
        imageShellCount: document.querySelectorAll('#buff-list .buff-card .buff-image-shell').length,
        compactFieldCount: document.querySelectorAll('#buff-list .buff-card:first-child .buff-name, #buff-list .buff-card:first-child .buff-effect, #buff-list .buff-card:first-child .buff-duration').length,
        exposedDetailCount: document.querySelectorAll('#buff-list .buff-card .buff-tag, #buff-list .buff-card .selection-check, #buff-list .buff-card p').length,
        effectFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.buff-effect')).fontSize),
        resultCount: document.getElementById('result-count').textContent,
        summaryFooterBottom: Math.round(document.querySelector('.buff-summary-footer').getBoundingClientRect().bottom),
        presetSaveFooterBottom: Math.round(document.querySelector('.preset-save-footer').getBoundingClientRect().bottom),
        presetListOverflow: getComputedStyle(document.getElementById('preset-list')).overflowY,
        directPresetVisible: document.querySelector('[data-preset-id="direct"]')?.getBoundingClientRect().height > 0,
        standardPresetVisible: document.querySelector('[data-preset-id="standard"]')?.getBoundingClientRect().height > 0,
        emptyPresetButtonVisible: document.getElementById('begin-empty-preset-button')?.getBoundingClientRect().height > 0,
        selectedPresetButtonVisible: document.getElementById('begin-selected-preset-button')?.getBoundingClientRect().height > 0,
        namesSorted: (() => {
          const names = Array.from(document.querySelectorAll('#buff-list .buff-name'), element => element.textContent);
          const sorted = [...names].sort((left, right) => left.localeCompare(right, 'ko-KR', { sensitivity: 'base', numeric: true }));
          return JSON.stringify(names) === JSON.stringify(sorted);
        })(),
      };
    })()`);
    assert.equal(visualLayout.paneCount, 2, '실제 화면이 버프 백과와 프리셋 관리의 두 영역으로 나뉘지 않습니다.');
    assert.ok(visualLayout.paneWidths[0] >= 650 && visualLayout.paneWidths[1] >= 320,
      `버프 백과와 프리셋 관리의 실제 너비가 사용 가능하지 않습니다: ${visualLayout.paneWidths.join(', ')}`);
    assert.ok(visualLayout.paneBottoms.every((bottom: number) => bottom <= visualLayout.viewportHeight + 1),
      `버프 화면 영역이 창 높이를 벗어납니다: ${visualLayout.paneBottoms.join(', ')}/${visualLayout.viewportHeight}`);
    assert.equal(visualLayout.scrollWidth, visualLayout.viewportWidth, '버프 화면 전체에 가로 잘림이 발생합니다.');
    assert.ok(visualLayout.descriptionFontSize >= 12, '버프 화면 설명 글자가 디자인 최소 크기보다 작습니다.');
    assert.equal(visualLayout.duplicateSelectedListRemoved, true, '선택 버프 목록이 오른쪽 영역에 중복으로 표시됩니다.');
    assert.equal(visualLayout.listLayout, 'flex', '버프가 세로 목록 형태로 표시되지 않습니다.');
    assert.equal(visualLayout.cardLayout, 'grid', '버프 행의 이미지·텍스트·지속시간 정렬이 깨졌습니다.');
    assert.equal(visualLayout.imageShellCount, visualLayout.cardCount, '모든 버프 행에 이미지 영역이 표시되지 않습니다.');
    assert.equal(visualLayout.compactFieldCount, 3, '버프 행에 이름·효과·지속시간이 모두 표시되지 않습니다.');
    assert.equal(visualLayout.exposedDetailCount, 0, '상세 설명이 간결한 버프 목록에 노출됩니다.');
    assert.ok(visualLayout.effectFontSize >= 12, '버프 효과 글자가 디자인 최소 크기보다 작습니다.');
    assert.ok(Math.abs(visualLayout.summaryFooterBottom - visualLayout.paneBottoms[0]) <= 1,
      '합산 효과가 왼쪽 계산 영역 하단에 고정되지 않습니다.');
    assert.ok(Math.abs(visualLayout.presetSaveFooterBottom - visualLayout.paneBottoms[1]) <= 1,
      '프리셋 저장이 오른쪽 프리셋 관리 영역 하단에 고정되지 않습니다.');
    assert.ok(['auto', 'scroll'].includes(visualLayout.presetListOverflow),
      '저장된 프리셋이 많을 때 프리셋 목록만 독립적으로 스크롤할 수 없습니다.');
    assert.equal(visualLayout.directPresetVisible, true, '프리셋 없이 직접 선택 카드가 화면에 표시되지 않습니다.');
    assert.equal(visualLayout.standardPresetVisible, true, '기본 도핑 세트 카드가 화면에 표시되지 않습니다.');
    assert.equal(visualLayout.emptyPresetButtonVisible, true, '빈 프리셋 만들기 버튼이 화면에 표시되지 않습니다.');
    assert.equal(visualLayout.selectedPresetButtonVisible, true, '선택값으로 프리셋 만들기 버튼이 화면에 표시되지 않습니다.');
    assert.equal(visualLayout.namesSorted, true, '버프 이름이 가나다순으로 표시되지 않습니다.');
    assert.ok(visualLayout.cardCount > 10 && /전체 \d+개/.test(visualLayout.resultCount),
      `실제 버프 목록이 화면에 렌더링되지 않습니다: ${visualLayout.cardCount}/${visualLayout.resultCount}`);

    const scrollPreservation = await previewWindow.webContents.executeJavaScript(`(() => {
      const list = document.getElementById('buff-list');
      list.scrollTop = Math.min(180, list.scrollHeight - list.clientHeight);
      const detailBefore = list.scrollTop;
      document.querySelectorAll('#buff-list .buff-card-main')[6]?.click();
      const detailAfter = list.scrollTop;
      const addBefore = list.scrollTop;
      document.querySelectorAll('#buff-list .buff-select-action')[6]?.click();
      return { detailBefore, detailAfter, addBefore, addAfter: list.scrollTop };
    })()`);
    assert.ok(scrollPreservation.detailBefore > 0, '스크롤 유지 검사를 수행할 만큼 실제 버프 목록이 길지 않습니다.');
    assert.ok(Math.abs(scrollPreservation.detailAfter - scrollPreservation.detailBefore) <= 1,
      `상세 펼치기 후 버프 목록 스크롤이 이동합니다: ${scrollPreservation.detailBefore} -> ${scrollPreservation.detailAfter}`);
    assert.ok(Math.abs(scrollPreservation.addAfter - scrollPreservation.addBefore) <= 1,
      `버프 추가 후 버프 목록 스크롤이 이동합니다: ${scrollPreservation.addBefore} -> ${scrollPreservation.addAfter}`);

    if (previewPath) {
      await previewWindow.webContents.executeJavaScript(`(() => {
        localStorage.removeItem('buff_presets');
        selectPreset('standard');
        if (${JSON.stringify(process.env.TW_OVERLAY_BUFFS_PREVIEW_TOOLTIP === '1')}) {
          document.querySelector('#buff-list .buff-card-main')?.click();
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
