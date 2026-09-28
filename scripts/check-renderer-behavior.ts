import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-renderer-test-'));

function checkNativeModuleCompatibility(): void {
  const Database = require('better-sqlite3') as new (path: string) => {
    exec(sql: string): void;
    close(): void;
  };
  const database = new Database(':memory:');
  database.exec('CREATE TABLE native_abi_check (id INTEGER PRIMARY KEY)');
  database.close();

  const koffi = require('koffi') as { version?: string };
  assert.ok(koffi && typeof koffi === 'object', 'koffi 네이티브 모듈을 불러오지 못했습니다.');
}

async function waitForSelector(
  window: BrowserWindow,
  selector: string,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const exists = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    ) as boolean;
    if (exists) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`렌더러 요소 대기 시간 초과: ${selector}`);
}

async function waitForRendererCondition(
  window: BrowserWindow,
  expression: string,
  errorMessage: string,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matched = await window.webContents.executeJavaScript(`Boolean(${expression})`) as boolean;
    if (matched) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(errorMessage);
}

async function checkContentsChecklist(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'contents-checker.html'));
  const result = await window.webContents.executeJavaScript(`
    (() => {
      const characterName = '캐릭터"><img id="injected-character">';
      const makeItem = (id, name, category, isCustom = false) => ({
        id,
        name,
        category,
        isVisible: true,
        isCustom,
        resetRule: { type: 'weekly', dayOfWeek: 1, hour: 0 },
        maxCount: 7,
        completedState: {
          'char-main': { isCompleted: false, currentCount: 0 }
        }
      });
      configData = {
        characterPresets: [{ id: 'char-main', name: characterName }],
        contentsCheckerItems: [
          makeItem('normal-10', '하늘10', '테스트'),
          makeItem('normal-ga', '가람', '테스트'),
          makeItem('normal-2', '하늘2', '테스트'),
          makeItem('normal-na', '나래', '테스트'),
          { ...makeItem('legacy-visible', '레거시 보임', '레거시'), isVisible: undefined },
          makeItem('custom-safe', '<img id="injected-item">사용자 숙제', '사용자"><img id="injected-category">', true)
        ],
        pendingHomeworks: []
      };
      render();

      const orderedNames = Array.from(document.querySelectorAll('.item-info'))
        .filter(cell => cell.title.startsWith('[테스트]'))
        .map(cell => cell.querySelector('.text-xs')?.textContent);
      const customCell = Array.from(document.querySelectorAll('.item-info'))
        .find(cell => cell.title.includes('사용자 숙제'));
      const legacyVisibleCell = Array.from(document.querySelectorAll('.item-info'))
        .find(cell => cell.title.includes('레거시 보임'));
      const displayText = window.normalizeChatDisplayText('&nbsp &nbsp &nbsp 을 것이오!');
      const displayNode = document.createElement('span');
      displayNode.textContent = displayText;

      const moveCalls = [];
      const settingsCalls = [];
      window.electronAPI = {
        contentsReorderItem: (...args) => moveCalls.push(['item', ...args]),
        contentsReorderCategory: (...args) => moveCalls.push(['category', ...args]),
        toggleSettings: (...args) => settingsCalls.push(args)
      };
      isEditMode = true;
      configData.contentsCheckerItems = [
        makeItem('category-b-1', 'B 첫째', 'B 카테고리'),
        makeItem('category-a-1', 'A 첫째', 'A 카테고리'),
        makeItem('category-b-2', 'B 둘째', 'B 카테고리')
      ];
      render();
      const soundBtn = document.getElementById('btn-sound-settings');
      soundBtn?.click();
      const syncButton = document.getElementById('checklist-cloud-sync-status');
      const syncHiddenWhenUnlinked = syncButton?.classList.contains('hidden');
      updateChecklistCloudSyncStatus({ isLinked: true, fileStatuses: [] });
      const syncNormalState = syncButton?.dataset.syncState;
      const syncNormalHasDot = syncButton?.querySelector('.checklist-sync-normal-dot') !== null;
      updateChecklistCloudSyncStatus({ isLinked: true, isSyncing: true, syncActivity: 'checking' });
      const syncCheckingState = syncButton?.dataset.syncState;
      updateChecklistCloudSyncStatus({ isLinked: true, isSyncing: true, syncActivity: 'upload' });
      const syncUploadState = syncButton?.dataset.syncState;
      updateChecklistCloudSyncStatus({ isLinked: true, isSyncing: true, syncActivity: 'download' });
      const syncDownloadState = syncButton?.dataset.syncState;
      updateChecklistCloudSyncStatus({
        isLinked: true,
        fileStatuses: [{ kind: 'checklist', retryCount: 1, lastError: 'failed' }]
      });
      const syncErrorState = syncButton?.dataset.syncState;
      const syncErrorTooltip = document.getElementById('checklist-cloud-sync-tooltip')?.textContent;
      updateChecklistCloudSyncStatus({ isLinked: false, reauthRequired: true });
      const syncReauthState = syncButton?.dataset.syncState;
      const syncReauthVisible = !syncButton?.classList.contains('hidden');
      const syncReauthTooltip = document.getElementById('checklist-cloud-sync-tooltip')?.textContent;
      syncButton?.click();
      updateChecklistCloudSyncStatus({ isLinked: false });
      const syncHiddenAfterLogout = syncButton?.classList.contains('hidden');

      const orderedCategories = Array.from(document.querySelectorAll('.category-row > span'))
        .map(span => span.textContent);
      const categoryHandles = document.querySelectorAll('[title="드래그하여 카테고리 순서 변경"]');
      categoryHandles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }));
      document.querySelectorAll('.category-row')[1]?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: 9999 }));
      const previewCategories = Array.from(document.querySelectorAll('.category-row > span')).map(span => span.textContent);
      categoryHandles[0]?.dispatchEvent(new Event('dragend', { bubbles: true }));
      const restoredCategories = Array.from(document.querySelectorAll('.category-row > span')).map(span => span.textContent);
      categoryHandles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }));
      document.querySelectorAll('.category-row')[1]?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: 9999 }));
      document.getElementById('matrix-table')?.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientY: 9999 }));
      categoryHandles[0]?.dispatchEvent(new Event('dragend', { bubbles: true }));
      const committedCategories = Array.from(document.querySelectorAll('.category-row > span')).map(span => span.textContent);
      render();
      const itemHandles = document.querySelectorAll('[title="드래그하여 숙제 순서 변경"]');
      itemHandles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }));
      document.querySelectorAll('.item-info')[1]?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: 9999 }));
      const previewItems = Array.from(document.querySelectorAll('.item-info')).map(cell => cell.querySelector('.text-xs')?.textContent);
      itemHandles[0]?.dispatchEvent(new Event('dragend', { bubbles: true }));
      const restoredItems = Array.from(document.querySelectorAll('.item-info')).map(cell => cell.querySelector('.text-xs')?.textContent);
      itemHandles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }));
      document.querySelectorAll('.item-info')[1]?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: 9999 }));
      document.getElementById('matrix-table')?.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientY: 9999 }));
      itemHandles[0]?.dispatchEvent(new Event('dragend', { bubbles: true }));
      const committedItems = Array.from(document.querySelectorAll('.item-info')).map(cell => cell.querySelector('.text-xs')?.textContent);

      // 다른 카테고리(A 첫째)로 드래그 앤 드롭
      itemHandles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }));
      document.querySelectorAll('.item-info')[2]?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: 9999 }));
      document.getElementById('matrix-table')?.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientY: 9999 }));
      itemHandles[0]?.dispatchEvent(new Event('dragend', { bubbles: true }));

      return {
        orderedNames,
        orderedCategories,
        previewCategories,
        restoredCategories,
        committedCategories,
        previewItems,
        restoredItems,
        committedItems,
        moveCalls,
        settingsCalls,
        soundButtonPresent: soundBtn !== null,
        syncHiddenWhenUnlinked,
        syncNormalState,
        syncNormalHasDot,
        syncCheckingState,
        syncUploadState,
        syncDownloadState,
        syncErrorState,
        syncErrorTooltip,
        syncReauthState,
        syncReauthVisible,
        syncReauthTooltip,
        syncHiddenAfterLogout,
        characterName: document.querySelector('.char-name')?.textContent,
        customName: customCell?.querySelector('.text-xs')?.textContent,
        customBadge: Array.from(customCell?.querySelectorAll('span') || [])
          .some(span => span.textContent === 'CUSTOM'),
        legacyVisible: Boolean(legacyVisibleCell) && !legacyVisibleCell.classList.contains('hidden-row'),
        injectedElementCount: document.querySelectorAll(
          '#injected-character, #injected-item, #injected-category'
        ).length,
        displayText: displayNode.textContent
      };
    })()
  `) as {
    orderedNames: string[];
    orderedCategories: string[];
    previewCategories: string[];
    restoredCategories: string[];
    committedCategories: string[];
    previewItems: Array<string | undefined>;
    restoredItems: Array<string | undefined>;
    committedItems: Array<string | undefined>;
    moveCalls: unknown[][];
    settingsCalls: unknown[][];
    soundButtonPresent: boolean;
    syncHiddenWhenUnlinked?: boolean;
    syncNormalState?: string;
    syncNormalHasDot?: boolean;
    syncCheckingState?: string;
    syncUploadState?: string;
    syncDownloadState?: string;
    syncErrorState?: string;
    syncErrorTooltip?: string;
    syncReauthState?: string;
    syncReauthVisible?: boolean;
    syncReauthTooltip?: string;
    syncHiddenAfterLogout?: boolean;
    characterName: string;
    customName: string;
    customBadge: boolean;
    legacyVisible: boolean;
    injectedElementCount: number;
    displayText: string;
  };

  assert.deepEqual(result.orderedNames, ['하늘10', '가람', '하늘2', '나래']);
  assert.deepEqual(result.orderedCategories, ['B 카테고리 (2)', 'A 카테고리 (1)']);
  assert.deepEqual(result.previewCategories, ['A 카테고리 (1)', 'B 카테고리 (2)']);
  assert.deepEqual(result.restoredCategories, result.orderedCategories);
  assert.deepEqual(result.committedCategories, result.previewCategories);
  assert.deepEqual(result.previewItems, ['B 둘째', 'B 첫째', 'A 첫째']);
  assert.deepEqual(result.restoredItems, ['B 첫째', 'B 둘째', 'A 첫째']);
  assert.deepEqual(result.committedItems, result.previewItems);
  assert.deepEqual(result.moveCalls, [
    ['category', 'weekly', 'B 카테고리', 'A 카테고리', 'after'],
    ['item', 'category-b-1', 'category-b-2', 'after'],
    ['item', 'category-b-1', 'category-a-1', 'after']
  ]);
  assert.equal(result.soundButtonPresent, true);
  assert.deepEqual(result.settingsCalls, [['sound'], ['data:google-sync']]);
  assert.equal(result.syncHiddenWhenUnlinked, true, '미연결 상태에서 숙제 동기화 아이콘이 보입니다.');
  assert.equal(result.syncNormalState, 'normal');
  assert.equal(result.syncNormalHasDot, true, '숙제 정상 상태가 초록색 점으로 표시되지 않았습니다.');
  assert.equal(result.syncCheckingState, 'checking');
  assert.equal(result.syncUploadState, 'uploading');
  assert.equal(result.syncDownloadState, 'downloading');
  assert.equal(result.syncErrorState, 'error');
  assert.match(result.syncErrorTooltip || '', /숙제 체크리스트 동기화 오류/);
  assert.equal(result.syncReauthState, 'error');
  assert.equal(result.syncReauthVisible, true, '재로그인 필요 상태에서 숙제 동기화 아이콘이 숨겨집니다.');
  assert.match(result.syncReauthTooltip || '', /다시 로그인/);
  assert.equal(result.syncHiddenAfterLogout, true, '로그아웃 뒤 숙제 동기화 아이콘이 숨겨지지 않았습니다.');
  assert.equal(result.characterName, '캐릭터"><img id="injected-character">');
  assert.equal(result.customName, '<img id="injected-item">사용자 숙제');
  assert.equal(result.customBadge, true);
  assert.equal(result.legacyVisible, true, 'isVisible 없는 레거시 숙제가 화면에서 숨겨졌습니다.');
  assert.equal(result.injectedElementCount, 0);
  assert.equal(result.displayText, '을 것이오!');
}

async function checkPendingHomeworkCloudUi(): Promise<void> {
  const pendingWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(projectRoot, 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const applyCalls: string[] = [];
  const autoAssignCalls: boolean[] = [];
  let clearCalls = 0;
  const onApplyPending = (_event: Electron.IpcMainEvent, characterId: string) => {
    applyCalls.push(characterId);
  };
  const onClearPending = () => {
    clearCalls++;
  };
  const onSetAutoAssign = (_event: Electron.IpcMainEvent, enabled: boolean) => {
    autoAssignCalls.push(enabled);
  };
  const onDefaultConfig = (event: Electron.IpcMainEvent) => {
    event.returnValue = {};
  };
  ipcMain.on('get-default-config-sync', onDefaultConfig);
  ipcMain.handle('check-chat-log-status', async () => false);
  ipcMain.handle('google-sync-get-status', async () => ({ isLinked: false }));
  ipcMain.on('contents-apply-pending', onApplyPending);
  ipcMain.on('contents-clear-pending', onClearPending);
  ipcMain.on('contents-set-auto-assign-single-candidate', onSetAutoAssign);

  const makeConfig = (characterCount: number, hasPending: boolean) => ({
    characterPresets: [
      { id: 'char-company', name: '회사 캐릭터' },
      { id: 'char-home', name: '집 캐릭터' },
    ].slice(0, characterCount),
    selectedCharacterId: 'char-company',
    contentsCheckerItems: [{
      id: 'weekly-cloud-pending',
      name: '클라우드 보류 숙제',
      category: '주간 숙제',
      isVisible: true,
      resetRule: { type: 'weekly', dayOfWeek: 1, hour: 0 },
      maxCount: 1,
      completedState: {
        'char-company': { isCompleted: false, currentCount: 0 },
        'char-home': { isCompleted: false, currentCount: 0 },
      },
    }],
    pendingHomeworks: hasPending ? [{
      id: 'weekly-cloud-pending',
      count: 1,
      isIncrement: true,
      timestamp: Date.now(),
      sourceEventIds: ['cloud-pending-event'],
      resetCycleKey: 'weekly:2026-08-24',
    }] : [],
    contentsAutoAssignSingleCandidate: true,
  });

  try {
    await pendingWindow.loadFile(path.join(projectRoot, 'dist', 'contents-checker.html'));
    await waitForSelector(pendingWindow, '#pending-modal');

    // 닫혀 있던 체크리스트를 나중에 연 경우와 동일하게, 첫 config-data에 원격 pending을 전달한다.
    pendingWindow.webContents.send('config-data', makeConfig(2, true));
    await waitForRendererCondition(
      pendingWindow,
      "!document.getElementById('pending-modal').classList.contains('hidden')",
      '클라우드 pending을 받은 체크리스트에 캐릭터 선택 팝업이 표시되지 않았습니다.',
    );
    const firstRender = await pendingWindow.webContents.executeJavaScript(`({
      itemText: document.getElementById('pending-items-list').textContent,
      characterButtons: Array.from(document.querySelectorAll('#pending-chars-list button'))
        .map(button => button.textContent),
    })`) as { itemText: string; characterButtons: string[] };
    assert.match(firstRender.itemText, /클라우드 보류 숙제/);
    assert.match(firstRender.itemText, /\+1회/);
    assert.equal(firstRender.characterButtons.length, 2);
    assert.match(firstRender.characterButtons[0], /회사 캐릭터/);
    assert.match(firstRender.characterButtons[1], /집 캐릭터/);

    // 캐릭터 관리 화면에서 단일 후보 자동 반영 여부를 직접 바꿀 수 있다.
    const characterPolicy = await pendingWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('btn-char-mgmt').click();
      const input = document.getElementById('auto-assign-single-candidate-input');
      const label = input.closest('label');
      const initiallyChecked = input.checked;
      input.click();
      return {
        initiallyChecked,
        checkedAfterClick: input.checked,
        labelText: label.textContent,
        modalVisible: !document.getElementById('char-modal').classList.contains('hidden'),
      };
    })()`);
    const policyStartedAt = Date.now();
    while (autoAssignCalls.length === 0 && Date.now() - policyStartedAt < 2_000) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(characterPolicy.initiallyChecked, true);
    assert.equal(characterPolicy.checkedAfterClick, false);
    assert.equal(characterPolicy.modalVisible, true);
    assert.match(characterPolicy.labelText, /남은 캐릭터가 한 명이면 자동 체크/);
    assert.match(characterPolicy.labelText, /차감권/);
    assert.deepEqual(autoAssignCalls, [false]);
    await pendingWindow.webContents.executeJavaScript(
      "document.getElementById('char-modal').classList.add('hidden')",
    );

    // 나중에 하기는 로컬 모달만 닫으므로 동일 pending을 다시 수신하면 팝업이 재표시된다.
    await pendingWindow.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('#pending-modal button'))
        .find(button => button.textContent.includes('나중에 하기'))?.click()
    `);
    assert.equal(await pendingWindow.webContents.executeJavaScript(
      "document.getElementById('pending-modal').classList.contains('hidden')",
    ), true);
    pendingWindow.webContents.send('config-data', makeConfig(2, true));
    await waitForRendererCondition(
      pendingWindow,
      "!document.getElementById('pending-modal').classList.contains('hidden')",
      '나중에 하기로 닫은 pending 팝업이 다음 config-data에서 다시 표시되지 않았습니다.',
    );

    // 캐릭터 선택은 해당 ID를 메인 프로세스에 보내고 즉시 모달을 닫는다.
    await pendingWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#pending-chars-list button')[1].click()",
    );
    const applyStartedAt = Date.now();
    while (applyCalls.length === 0 && Date.now() - applyStartedAt < 2_000) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(applyCalls, ['char-home']);
    assert.equal(await pendingWindow.webContents.executeJavaScript(
      "document.getElementById('pending-modal').classList.contains('hidden')",
    ), true);

    // 캐릭터가 한 명뿐이거나 pending이 비어 있으면 선택 팝업을 표시하지 않는다.
    pendingWindow.webContents.send('config-data', makeConfig(1, true));
    await waitForRendererCondition(
      pendingWindow,
      "document.getElementById('pending-modal').classList.contains('hidden')",
      '캐릭터가 한 명인데 pending 선택 팝업이 표시됐습니다.',
    );
    pendingWindow.webContents.send('config-data', makeConfig(2, false));
    await waitForRendererCondition(
      pendingWindow,
      "document.getElementById('pending-modal').classList.contains('hidden')",
      'pending이 비어 있는데 캐릭터 선택 팝업이 표시됐습니다.',
    );

    // 보류 내역 삭제는 확인 뒤 삭제 IPC를 보내고 모달을 닫는다.
    pendingWindow.webContents.send('config-data', makeConfig(2, true));
    await waitForRendererCondition(
      pendingWindow,
      "!document.getElementById('pending-modal').classList.contains('hidden')",
      '삭제 검증을 위한 pending 팝업이 표시되지 않았습니다.',
    );
    await pendingWindow.webContents.executeJavaScript(`
      window.confirm = () => true;
      document.getElementById('btn-clear-pending').click();
    `);
    const clearStartedAt = Date.now();
    while (clearCalls === 0 && Date.now() - clearStartedAt < 2_000) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(clearCalls, 1);
    assert.equal(await pendingWindow.webContents.executeJavaScript(
      "document.getElementById('pending-modal').classList.contains('hidden')",
    ), true);
  } finally {
    ipcMain.removeListener('get-default-config-sync', onDefaultConfig);
    ipcMain.removeHandler('check-chat-log-status');
    ipcMain.removeHandler('google-sync-get-status');
    ipcMain.removeListener('contents-apply-pending', onApplyPending);
    ipcMain.removeListener('contents-clear-pending', onClearPending);
    ipcMain.removeListener('contents-set-auto-assign-single-candidate', onSetAutoAssign);
    if (!pendingWindow.isDestroyed()) pendingWindow.destroy();
  }
}

async function checkLifecycleStartIsIdempotent(): Promise<void> {
  const { chatParser } = require(path.join(projectRoot, 'dist/modules/chatParser.js')) as {
    chatParser: {
      eventNames(): Array<string | symbol>;
      listenerCount(event: string | symbol): number;
    };
  };
  const { chatLogProcessor } = require(
    path.join(projectRoot, 'dist/modules/chatLogProcessor.js'),
  ) as {
    chatLogProcessor: { start(): void };
  };

  chatLogProcessor.start();
  const afterFirstStart = Object.fromEntries(
    chatParser.eventNames().map(event => [String(event), chatParser.listenerCount(event)]),
  );
  chatLogProcessor.start();
  const afterSecondStart = Object.fromEntries(
    chatParser.eventNames().map(event => [String(event), chatParser.listenerCount(event)]),
  );

  assert.deepEqual(afterSecondStart, afterFirstStart);
  assert.equal(afterFirstStart.SPECIAL_MONSTER_SPAWN, 1);
  assert.equal(afterFirstStart.ETERNAL_FLOOR_CLEAR, 1);
}

async function checkBuffRefreshPolicy(): Promise<void> {
  const { buffTimerManager, getMissedBuffWarnings } = require(
    path.join(projectRoot, 'dist/modules/buffTimerManager.js'),
  ) as {
    getMissedBuffWarnings(
      buffs: Iterable<{
        buffId: string;
        name: string;
        durationMs: number;
        startTime: number;
        usedBy: string;
        warnedAt: Set<number>;
      }>,
      fromTimestamp: number,
      toTimestamp: number,
      warnSeconds: readonly number[],
    ): Array<{ warnSec: number; scheduledAt: number; dedupeKey: string }>;
    buffTimerManager: {
      start(): void;
      stop(): void;
      loadBuffDefs(): void;
      activateBuff(buffId: string, usedBy?: string, customDurationMs?: number, startTime?: number): void;
      getActiveBuffs(): Array<{ buffId: string; startTime: number; warnedAt: Set<number> }>;
      clearAllBuffs(): void;
    };
  };

  buffTimerManager.loadBuffDefs();
  buffTimerManager.clearAllBuffs();

  const initialStartTime = Date.now() - 10_000;
  buffTimerManager.activateBuff('exp_potato_900', 'self', undefined, initialStartTime);
  const initialBuff = buffTimerManager.getActiveBuffs().find(buff => buff.buffId === 'exp_potato_900');
  assert.ok(initialBuff);
  initialBuff.warnedAt.add(60);

  const refreshedStartTime = initialStartTime + 1_000;
  buffTimerManager.activateBuff('exp_potato_900', 'self', undefined, refreshedStartTime);
  const refreshedBuff = buffTimerManager.getActiveBuffs().find(buff => buff.buffId === 'exp_potato_900');
  assert.ok(refreshedBuff);
  assert.equal(refreshedBuff.startTime, refreshedStartTime);
  assert.equal(refreshedBuff.warnedAt.size, 0);

  buffTimerManager.activateBuff('exp_potato_900', 'self', undefined, initialStartTime);
  assert.equal(
    buffTimerManager.getActiveBuffs().find(buff => buff.buffId === 'exp_potato_900')?.startTime,
    refreshedStartTime,
  );

  const izabelInitialStartTime = Date.now() - 10_000;
  buffTimerManager.activateBuff('dmg_izabel', 'self', undefined, izabelInitialStartTime);
  const izabelInitialBuff = buffTimerManager.getActiveBuffs().find(buff => buff.buffId === 'dmg_izabel');
  assert.ok(izabelInitialBuff);

  buffTimerManager.activateBuff('dmg_izabel', 'self', undefined, izabelInitialStartTime + 1_000);
  assert.equal(
    buffTimerManager.getActiveBuffs().find(buff => buff.buffId === 'dmg_izabel')?.startTime,
    izabelInitialStartTime,
    '이자벨 대미지는 활성 중 효과 재감지로 타이머가 갱신되면 안 됩니다.',
  );

  buffTimerManager.clearAllBuffs();

  const missedWarnings = getMissedBuffWarnings([
    {
      buffId: 'fixture-buff',
      name: '테스트 버프',
      durationMs: 120_000,
      startTime: 1_000,
      usedBy: 'self',
      warnedAt: new Set<number>(),
    },
  ], 20_000, 116_000, [60, 10]);
  assert.deepEqual(
    missedWarnings.map(warning => ({
      warnSec: warning.warnSec,
      scheduledAt: warning.scheduledAt,
      dedupeKey: warning.dedupeKey,
    })),
    [
      { warnSec: 60, scheduledAt: 61_000, dedupeKey: 'buff:fixture-buff:1000:60' },
      { warnSec: 10, scheduledAt: 111_000, dedupeKey: 'buff:fixture-buff:1000:10' },
      { warnSec: 5, scheduledAt: 116_000, dedupeKey: 'buff:fixture-buff:1000:5' },
    ],
    '절전 구간을 통과한 복수 버프 경고 임계값이 모두 복원되지 않았습니다.',
  );

  const { chatParser } = require(path.join(projectRoot, 'dist/modules/chatParser.js')) as {
    chatParser: { listenerCount(event: string): number };
  };
  buffTimerManager.stop();
  const listenerBaseline = chatParser.listenerCount('BUFF_USED');
  const suspendListenerBaseline = powerMonitor.listenerCount('suspend');
  const resumeListenerBaseline = powerMonitor.listenerCount('resume');
  const unlockListenerBaseline = powerMonitor.listenerCount('unlock-screen');
  buffTimerManager.start();
  assert.equal(chatParser.listenerCount('BUFF_USED'), listenerBaseline + 1);
  assert.equal(powerMonitor.listenerCount('suspend'), suspendListenerBaseline + 1);
  assert.equal(powerMonitor.listenerCount('resume'), resumeListenerBaseline + 1);
  assert.equal(powerMonitor.listenerCount('unlock-screen'), unlockListenerBaseline + 1);

  const diaryDb = require(path.join(projectRoot, 'dist/modules/diaryDb.js')) as {
    getAlarmLogs(limit?: number): Array<{
      dedupeKey?: string;
      scheduledAt: number;
      recordedAt: number;
      deliveryStatus: string;
    }>;
    clearAlarmLogs(): boolean;
  };
  const originalDateNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  try {
    buffTimerManager.activateBuff('exp_potato_900', 'self', 7_000, fakeNow - 1_000);
    powerMonitor.emit('suspend');
    fakeNow += 2_000;
    powerMonitor.emit('resume');
    powerMonitor.emit('unlock-screen');
  } finally {
    Date.now = originalDateNow;
  }
  const recoveredBuffLogs = diaryDb.getAlarmLogs(50)
    .filter(row => row.dedupeKey === 'buff:exp_potato_900:999000:5');
  assert.equal(recoveredBuffLogs.length, 1,
    'resume+unlock 연속 이벤트가 같은 놓친 버프 임계값을 중복 기록했습니다.');
  assert.deepEqual(
    {
      scheduledAt: recoveredBuffLogs[0].scheduledAt,
      recordedAt: recoveredBuffLogs[0].recordedAt,
      deliveryStatus: recoveredBuffLogs[0].deliveryStatus,
    },
    { scheduledAt: 1_001_000, recordedAt: 1_002_000, deliveryStatus: 'missed-sleep' },
  );
  assert.ok(buffTimerManager.getActiveBuffs()
    .find(buff => buff.buffId === 'exp_potato_900')?.warnedAt.has(5),
  '놓친 버프 임계값이 live 경고 재생 방지 상태에 반영되지 않았습니다.');
  diaryDb.clearAlarmLogs();
  buffTimerManager.start();
  assert.equal(chatParser.listenerCount('BUFF_USED'), listenerBaseline + 1,
    'buff timer 중복 start가 BUFF_USED 리스너를 추가 등록했습니다.');
  buffTimerManager.stop();
  assert.equal(chatParser.listenerCount('BUFF_USED'), listenerBaseline,
    'buff timer stop이 BUFF_USED 리스너를 제거하지 않았습니다.');
  assert.equal(powerMonitor.listenerCount('suspend'), suspendListenerBaseline);
  assert.equal(powerMonitor.listenerCount('resume'), resumeListenerBaseline);
  assert.equal(powerMonitor.listenerCount('unlock-screen'), unlockListenerBaseline);
  buffTimerManager.start();
  assert.equal(chatParser.listenerCount('BUFF_USED'), listenerBaseline + 1,
    'buff timer stop 뒤 start가 리스너를 다시 등록하지 못했습니다.');
  buffTimerManager.stop();
  assert.equal(chatParser.listenerCount('BUFF_USED'), listenerBaseline);
}

async function checkTodaySummaryRenderer(window: BrowserWindow): Promise<void> {
  const defaultConfig = (require(path.join(projectRoot, 'dist', 'modules', 'constants.js')) as {
    DEFAULT_CONFIG: Record<string, unknown>;
  }).DEFAULT_CONFIG;
  const gameOverlayHtml = fs.readFileSync(
    path.join(projectRoot, 'dist', 'game-overlay.html'),
    'utf8',
  ).replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '');
  const todaySummaryCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'game-overlay', 'today-summary.js'),
    'utf8',
  );
  await window.loadURL(`data:text/html;base64,${Buffer.from(gameOverlayHtml).toString('base64')}`);

  const result = await window.webContents.executeJavaScript(`
    (async () => {
      window.formatSeedAmount = value => Number(value).toLocaleString('ko-KR');
      let diaryUpdatedCallback = null;
      let configDataCallback = null;
      let detectedHomework = null;
      window.electronAPI = {
        DEFAULT_CONFIG: ${JSON.stringify(defaultConfig)},
        getTodaySummary: async () => ({
          date: '2026-08-15',
          totalSeed: 12345678,
          totalElso: 3500,
          totalEssence: 2,
          bossKills: 4,
          totalLootCount: 9,
          detectedHomework,
          lootItems: [
            { name: '<img id="injected-summary">장비 강화석', count: 5 },
            { name: '융합된 기운', count: 3 },
            { name: '스페셜 스킬 조각', count: 1 }
          ],
          homework: {
            characterName: '본캐', completedCount: 8, totalCount: 12, remainingCount: 4,
            remainingItems: [
              { name: '어비스 심층', category: '주간', type: 'weekly', currentCount: 2, maxCount: 5 },
              { name: '거인족 섬멸전', category: '주간', type: 'weekly', currentCount: 0, maxCount: 1 },
              { name: '신조의 둥지', category: '주간', type: 'weekly', currentCount: 0, maxCount: 1 },
              { name: '외전 콘텐츠', category: '주간', type: 'weekly', currentCount: 0, maxCount: 1 }
            ]
          }
        }),
        onDiaryUpdated: callback => { diaryUpdatedCallback = callback; },
        onTodaySummaryConfig: callback => {
          configDataCallback = callback;
          callback(${JSON.stringify(defaultConfig)});
        }
      };
      ${todaySummaryCode}
      await new Promise(resolve => setTimeout(resolve, 50));

      const summary = document.getElementById('today-summary-hud');
      const detectedRow = document.getElementById('today-summary-detected-homework');
      const noDetectionHidden = getComputedStyle(detectedRow).display === 'none';
      detectedHomework = { name: '설계자의 채굴장', currentCount: 1, maxCount: 1 };
      const initialTop = Number.parseFloat(summary.style.top);
      const defaultCollapsed = summary.classList.contains('collapsed');
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, todaySummaryCollapsed: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      const collapsedApplied = summary.classList.contains('collapsed');
      const compactVisible = getComputedStyle(document.getElementById('today-summary-compact')).display !== 'none';
      const detectedCollapsedVisible = getComputedStyle(detectedRow).display !== 'none';
      const detectedTitle = document.getElementById('today-summary-detected-name').textContent;
      const detectedCount = document.getElementById('today-summary-detected-count').textContent;
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, showTodaySummaryHud: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      const hiddenApplied = summary.classList.contains('hidden');
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, todaySummaryCollapsed: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      const restoredVisible = !summary.classList.contains('hidden') && !summary.classList.contains('collapsed');
      const detectedExpandedVisible = getComputedStyle(detectedRow).display !== 'none';
      detectedHomework = { name: '<img id="injected-detected">아주 긴 숙제 제목 '.repeat(12), currentCount: 4, maxCount: 7 };
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, todaySummaryCollapsed: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      const abandoned = document.getElementById('abandoned-widget');
      abandoned.style.left = '200px';
      abandoned.style.bottom = '63px';
      abandoned.classList.remove('hidden');
      abandoned.classList.add('active');
      await new Promise(resolve => setTimeout(resolve, 50));
      const finalTop = Number.parseFloat(summary.style.top);
      const detectedName = document.getElementById('today-summary-detected-name');
      const longDetectionTruncated = detectedName.scrollWidth > detectedName.clientWidth;
      const detectedCountInside = document.getElementById('today-summary-detected-count').getBoundingClientRect().right <= summary.getBoundingClientRect().right;
      const detectedWeeklyCount = document.getElementById('today-summary-detected-count').textContent;
      const detectedInjectionCount = document.querySelectorAll('#injected-detected').length;
      detectedHomework = null;
      diaryUpdatedCallback?.();
      await new Promise(resolve => setTimeout(resolve, 50));

      return {
        noDetectionHidden, detectedCollapsedVisible, detectedExpandedVisible, detectedTitle, detectedCount,
        longDetectionTruncated, detectedCountInside, detectedWeeklyCount, detectedInjectionCount,
        clearedDetectionHidden: getComputedStyle(detectedRow).display === 'none',
        date: document.getElementById('today-summary-date')?.textContent,
        seed: document.getElementById('today-summary-seed')?.textContent,
        elso: document.getElementById('today-summary-elso')?.textContent,
        compact: document.getElementById('today-summary-compact')?.textContent,
        lootRows: Array.from(document.querySelectorAll('#today-summary-loot-list .today-summary-list-name'))
          .map(node => node.textContent),
        homeworkTitle: document.getElementById('today-summary-homework-character')?.textContent,
        homeworkProgress: document.getElementById('today-summary-homework-progress')?.textContent,
        homeworkRows: Array.from(document.querySelectorAll('#today-summary-homework-list .today-summary-list-name'))
          .map(node => node.textContent),
        homeworkOverflow: document.querySelector('#today-summary-homework-list .today-summary-empty')?.textContent,
        injectedCount: document.querySelectorAll('#injected-summary').length,
        initialTop,
        finalTop,
        collapsedApplied,
        defaultCollapsed,
        compactVisible,
        hiddenApplied,
        restoredVisible,
        interactiveTogglePresent: document.getElementById('today-summary-toggle') !== null,
        summaryPointerEvents: getComputedStyle(summary).pointerEvents
      };
    })()
  `) as {
    noDetectionHidden: boolean; detectedCollapsedVisible: boolean; detectedExpandedVisible: boolean;
    detectedTitle: string; detectedCount: string; longDetectionTruncated: boolean;
    detectedCountInside: boolean; detectedWeeklyCount: string; detectedInjectionCount: number; clearedDetectionHidden: boolean;
    date: string;
    seed: string;
    elso: string;
    compact: string;
    lootRows: string[];
    homeworkTitle: string;
    homeworkProgress: string;
    homeworkRows: string[];
    homeworkOverflow: string;
    injectedCount: number;
    initialTop: number;
    finalTop: number;
    collapsedApplied: boolean;
    defaultCollapsed: boolean;
    compactVisible: boolean;
    hiddenApplied: boolean;
    restoredVisible: boolean;
    interactiveTogglePresent: boolean;
    summaryPointerEvents: string;
  };

  assert.equal(result.date, '08.15');
  assert.equal(result.noDetectionHidden, true);
  assert.equal(result.detectedCollapsedVisible, true);
  assert.equal(result.detectedExpandedVisible, true);
  assert.equal(result.detectedTitle, '설계자의 채굴장');
  assert.equal(result.detectedCount, '1/1');
  assert.equal(result.detectedWeeklyCount, '4/7');
  assert.equal(result.longDetectionTruncated, true);
  assert.equal(result.detectedCountInside, true);
  assert.equal(result.detectedInjectionCount, 0);
  assert.equal(result.clearedDetectionHidden, true);
  assert.equal(result.seed, '1234만');
  assert.equal(result.elso, '3,500 P');
  assert.equal(result.compact, 'SEED 1234만\nELSO 3,500 P\n경험의 정수 2개 · 남은 숙제 4개');
  assert.deepEqual(result.lootRows, [
    '<img id="injected-summary">장비 강화석', '융합된 기운', '스페셜 스킬 조각',
  ]);
  assert.equal(result.homeworkTitle, '본캐 숙제');
  assert.equal(result.homeworkProgress, '8/12 · 4개 남음');
  assert.deepEqual(result.homeworkRows, ['어비스 심층', '거인족 섬멸전', '신조의 둥지']);
  assert.equal(result.homeworkOverflow, '외 1개 미완료');
  assert.equal(result.injectedCount, 0);
  assert.ok(result.initialTop >= 0);
  assert.equal(result.collapsedApplied, true);
  assert.equal(result.defaultCollapsed, true);
  assert.equal(result.compactVisible, true);
  assert.equal(result.hiddenApplied, true);
  assert.equal(result.restoredVisible, true);
  assert.equal(result.interactiveTogglePresent, false);
  assert.equal(result.summaryPointerEvents, 'none');

}

async function checkTodaySummarySettingsLayout(window: BrowserWindow): Promise<void> {
  window.setContentSize(1100, 720);
  await window.loadFile(path.join(projectRoot, 'dist', 'settings.html'));
  await waitForSelector(window, '#today-summary-hud-settings-card');
  const result = await window.webContents.executeJavaScript(`
    (() => {
      document.getElementById('loading-overlay')?.remove();
      document.querySelectorAll('.settings-section').forEach(section => section.classList.add('hidden'));
      const gameSection = document.getElementById('section-game-overlay');
      gameSection?.classList.remove('hidden');
      document.querySelector('.content-area').scrollTop = 0;
      const card = document.getElementById('today-summary-hud-settings-card');
      const cardRect = card?.getBoundingClientRect();
      return {
        cardVisible: cardRect ? cardRect.width > 0 && cardRect.height > 0 : false,
        cardInViewport: cardRect ? cardRect.top >= 0 && cardRect.left >= 0 : false,
        controlsVisible: [
          'today-summary-show-input', 'today-summary-collapsed-input',
          'today-summary-pos-left', 'today-summary-pos-top'
        ].every(id => {
          const el = document.getElementById(id);
          return el && el.getBoundingClientRect().width > 0;
        })
      };
    })()
  `) as {
    cardVisible: boolean;
    cardInViewport: boolean;
    controlsVisible: boolean;
  };
  assert.equal(result.cardVisible, true);
  assert.equal(result.cardInViewport, true);
  assert.equal(result.controlsVisible, true);
}

async function checkCustomChatTabSettings(window: BrowserWindow): Promise<void> {
  const defaultConfig = require(path.join(projectRoot, 'dist', 'modules', 'constants.js')).DEFAULT_CONFIG;
  const shortcutsSource = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'settings', 'shortcuts.js'), 'utf8');
  window.setContentSize(1100, 720);
  await window.loadFile(path.join(projectRoot, 'dist', 'settings.html'));
  await waitForSelector(window, '#custom-tab-name-input');

  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const alerts = [];
      const saveCalls = [];
      window.alert = message => alerts.push(message);
      window.confirm = () => true;
      window.refreshIcons = () => {};
      window.electronAPI = {
        DEFAULT_CONFIG: ${JSON.stringify(defaultConfig)},
        applySettingsConfirmed: async payload => {
          const tab = payload.chatOverlayCustomTabs?.at(-1);
          saveCalls.push({
            payload,
            lastTabHasSystemFilters: tab
              ? Object.prototype.hasOwnProperty.call(tab, 'systemColorFilters')
              : false,
          });
          return { success: true };
        },
        getConfig: async () => ({}),
      };
      // preload 없이 여는 fixture에서도 저장 초안이 읽는 실제 단축키 모듈을 초기화한다.
      ${shortcutsSource}
      customTabsList = [];

      const setChannels = values => {
        document.querySelectorAll('.custom-tab-ch-check').forEach(input => {
          input.checked = values.includes(input.value);
        });
      };
      const nameInput = document.getElementById('custom-tab-name-input');

      nameInput.value = '파티용';
      setChannels(['general', 'team', 'club', 'shout']);
      await addCustomChatTab();
      const standardTab = customTabsList[0];
      const standardDraftCleared = nameInput.value === ''
        && document.querySelector('.custom-tab-ch-check:checked') === null;

      nameInput.value = '시스템';
      setChannels(['system']);
      document.querySelectorAll('.custom-tab-sys-check').forEach(input => {
        input.checked = input.value === 'purple' || input.value === 'red';
      });
      await addCustomChatTab();
      const systemTab = customTabsList[1];

      window.electronAPI.applySettingsConfirmed = async payload => {
        const tab = payload.chatOverlayCustomTabs?.at(-1);
        saveCalls.push({
          payload,
          lastTabHasSystemFilters: tab
            ? Object.prototype.hasOwnProperty.call(tab, 'systemColorFilters')
            : false,
        });
        return { success: false, error: 'invalid-settings' };
      };
      nameInput.value = '실패탭';
      setChannels(['general']);
      await addCustomChatTab();
      const failedDraftPreserved = nameInput.value === '실패탭'
        && document.getElementById('custom-tab-ch-general').checked;
      const tabCountAfterFailedSave = customTabsList.length;

      const saveCountBeforeDraftApply = saveCalls.length;
      await applyChatOverlaySettingsOnly();

      if (saveCalls.length !== 3) throw new Error('커스텀 탭 저장 경로 실패: ' + JSON.stringify(alerts));

      return {
        standardTab,
        standardDraftCleared,
        standardHasSystemFilters: saveCalls[0].lastTabHasSystemFilters,
        systemTab,
        systemHasSystemFilters: saveCalls[1].lastTabHasSystemFilters,
        failedDraftPreserved,
        tabCountAfterFailedSave,
        draftApplyWasBlocked: saveCalls.length === saveCountBeforeDraftApply,
        alerts,
      };
    })()
  `) as {
    standardTab: { name: string; channels: string[]; systemColorFilters?: string[] };
    standardDraftCleared: boolean;
    standardHasSystemFilters: boolean;
    systemTab: { name: string; channels: string[]; systemColorFilters?: string[] };
    systemHasSystemFilters: boolean;
    failedDraftPreserved: boolean;
    tabCountAfterFailedSave: number;
    draftApplyWasBlocked: boolean;
    alerts: string[];
  };

  assert.equal(result.standardTab.name, '파티용');
  assert.deepEqual(result.standardTab.channels, ['general', 'team', 'club', 'shout']);
  assert.equal(result.standardHasSystemFilters, false,
    '시스템 채널이 없는 사용자 정의 탭에 systemColorFilters 필드가 포함되었습니다.');
  assert.equal(result.standardDraftCleared, true, '저장 성공 후 사용자 정의 탭 입력값이 정리되지 않았습니다.');
  assert.deepEqual(result.systemTab.systemColorFilters, ['purple', 'red']);
  assert.equal(result.systemHasSystemFilters, true, '시스템 탭의 색상 필터가 저장 요청에서 누락되었습니다.');
  assert.equal(result.failedDraftPreserved, true, '저장 실패 후 사용자 정의 탭 초안이 사라졌습니다.');
  assert.equal(result.tabCountAfterFailedSave, 2, '저장 실패한 사용자 정의 탭이 목록에 추가되었습니다.');
  assert.equal(result.draftApplyWasBlocked, true, '등록 전 사용자 정의 탭 초안이 즉시 적용 요청에 포함되었습니다.');
  assert.ok(result.alerts.some(message => message.includes('작성 중인 사용자 정의 탭')),
    '등록 전 사용자 정의 탭 초안 안내가 표시되지 않았습니다.');
}

async function checkHudPositionEditSettingsSafety(window: BrowserWindow): Promise<void> {
  window.setContentSize(1100, 720);
  const settingsPath = path.join(projectRoot, 'dist', 'settings.html');
  const fullHtml = fs.readFileSync(settingsPath, 'utf8');
  const saveUiFunctionMatch = fullHtml.match(
    /(function updateHudEditSaveUi\(editing\) \{[\s\S]*?\r?\n    \})\r?\n\r?\n    function renderHudEditState/,
  );
  assert.ok(saveUiFunctionMatch, 'HUD 위치 편집 저장 UI 함수를 추출하지 못했습니다.');
  const html = cleanHtmlForTest(settingsPath);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await window.webContents.executeJavaScript(`
    (() => {
      ${saveUiFunctionMatch[1]}
      updateHudEditSaveUi(true);
      const saveButton = document.getElementById('btn-save-all-settings');
      const guidance = document.getElementById('hud-edit-save-guidance');
      const editingState = {
        disabled: saveButton?.disabled,
        ariaDisabled: saveButton?.getAttribute('aria-disabled'),
        label: document.getElementById('btn-save-all-settings-label')?.textContent?.trim(),
        guidanceVisible: !guidance?.classList.contains('hidden'),
      };
      updateHudEditSaveUi(false);

      return {
        editingState,
        restoredDisabled: saveButton?.disabled,
        restoredLabel: document.getElementById('btn-save-all-settings-label')?.textContent?.trim(),
      };
    })()
  `) as {
    editingState: { disabled: boolean; ariaDisabled: string | null; label: string; guidanceVisible: boolean };
    restoredDisabled: boolean;
    restoredLabel: string;
  };

  assert.deepEqual(result.editingState, {
    disabled: true,
    ariaDisabled: 'true',
    label: '위치 편집 중 · 저장 잠김',
    guidanceVisible: true,
  }, 'HUD 위치 편집 중 전체 저장 차단 안내가 표시되지 않습니다.');
  assert.equal(result.restoredDisabled, false, 'HUD 위치 편집 종료 후 전체 저장 버튼이 복원되지 않습니다.');
  assert.equal(result.restoredLabel, '저장 및 적용', 'HUD 위치 편집 종료 후 저장 버튼 문구가 복원되지 않습니다.');
}

async function checkSettingsDeepLinkRouting(window: BrowserWindow): Promise<void> {
  window.setContentSize(1100, 720);
  await window.loadFile(path.join(projectRoot, 'dist', 'settings.html'));
  await waitForSelector(window, '#settings-quick-search');

  const testRoutes = [
    { tabId: 'display:sidebar', expectedGroup: 'app', expectedSection: 'section-general' },
    { tabId: 'display:game-overlay', expectedGroup: 'game', expectedSection: 'section-game-overlay' },
    { tabId: 'chatlog:sub-tab-today-summary', expectedGroup: 'game', expectedSection: 'section-game-overlay' },
    { tabId: 'game:gimmick', expectedGroup: 'game', expectedSection: 'section-chatlog', expectedSubTab: 'sub-tab-gimmick' },
    { tabId: 'chatlog', expectedGroup: 'chat', expectedSection: 'section-chatlog', expectedSubTab: 'sub-tab-general' },
    { tabId: 'chatlog:history-sync', expectedGroup: 'chat', expectedSection: 'section-chatlog' },
    { tabId: 'chatlog:sub-tab-overlay', expectedGroup: 'chat', expectedSection: 'section-chatlog', expectedSubTab: 'sub-tab-overlay' },
    { tabId: 'chatlog:sub-tab-loot', expectedGroup: 'chat', expectedSection: 'section-chatlog', expectedSubTab: 'sub-tab-loot' },
    { tabId: 'sound', expectedGroup: 'alerts', expectedSection: 'section-sound', expectedSubTab: 'sub-tab-sound-settings' },
    { tabId: 'sound:custom', expectedGroup: 'alerts', expectedSection: 'section-sound', expectedSubTab: 'sub-tab-custom-sounds' },
    { tabId: 'sound:log', expectedGroup: 'alerts', expectedSection: 'section-sound', expectedSubTab: 'sub-tab-alarm-log' },
    { tabId: 'gallery', expectedGroup: 'alerts', expectedSection: 'section-external' },
    { tabId: 'trade', expectedGroup: 'alerts', expectedSection: 'section-external' },
    { tabId: 'shortcuts', expectedGroup: 'system', expectedSection: 'section-shortcuts' },
    { tabId: 'data:google-sync', expectedGroup: 'system', expectedSection: 'section-data' },
    { tabId: 'data:retention', expectedGroup: 'system', expectedSection: 'section-data' },
    { tabId: 'about', expectedGroup: 'about', expectedSection: 'section-about' },
  ];

  for (const route of testRoutes) {
    const checkResult = await window.webContents.executeJavaScript(`
      (() => {
        try {
          const target = resolveSettingsRoute('${route.tabId}');
          if (!target) return { ok: false, error: 'resolveSettingsRoute returned null for ${route.tabId}' };
          const navEl = document.querySelector('.nav-item[data-settings-group="' + target.groupId + '"]');
          showSettingsGroup(target.groupId, navEl, target.routeIndex);
          triggerSectionHighlight('${route.tabId}');
          const activeGroup = document.querySelector('.nav-item.active')?.getAttribute('data-settings-group');
          const activeSection = Array.from(document.querySelectorAll('.settings-section')).find(s => !s.classList.contains('hidden'))?.id;
          const activeSubTab = activeSection
            ? document.querySelector('#' + activeSection + ' .sub-tab-content.active')?.id
            : undefined;
          return {
            ok: true,
            targetGroup: target.groupId,
            activeGroup,
            activeSection,
            activeSubTab
          };
        } catch (err) {
          return { ok: false, error: String(err && err.stack ? err.stack : err) };
        }
      })()
    `) as { ok: boolean; error?: string; targetGroup: string; activeGroup: string; activeSection: string; activeSubTab?: string };

    assert.equal(checkResult.ok, true, checkResult.error);
    assert.equal(checkResult.targetGroup, route.expectedGroup, `${route.tabId} group mismatch`);
    assert.equal(checkResult.activeGroup, route.expectedGroup, `${route.tabId} active nav mismatch`);
    assert.equal(checkResult.activeSection, route.expectedSection, `${route.tabId} active section mismatch`);
    if (route.expectedSubTab) {
      assert.equal(checkResult.activeSubTab, route.expectedSubTab, `${route.tabId} active sub-tab mismatch`);
    }
  }

  // 빠른 검색 실사용 DOM 인터랙션 테스트
  const searchTestResult = await window.webContents.executeJavaScript(`
    (() => {
      try {
        const searchInput = document.getElementById('settings-quick-search');
        const resultsDropdown = document.getElementById('settings-search-results');
        if (!searchInput || !resultsDropdown) return { ok: false, error: '검색 요소 미발견' };

        // 1. 사용자 키보드 입력 시뮬레이션
        searchInput.value = '단축키';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        
        const items = resultsDropdown.querySelectorAll('.search-result-item');
        const hasResults = items.length > 0;
        const dropdownVisible = !resultsDropdown.classList.contains('hidden');

        if (!hasResults) return { ok: false, error: '검색어 단축키에 대한 결과 아이템이 없습니다.' };

        // 2. 검색 결과 클릭 시뮬레이션
        items[0].click();
        const activeSectionAfterSelect = Array.from(document.querySelectorAll('.settings-section')).find(s => !s.classList.contains('hidden'))?.id;
        const dropdownHiddenAfterSelect = resultsDropdown.classList.contains('hidden');
        const inputClearedAfterSelect = searchInput.value === '';

        return {
          ok: true,
          hasResults,
          dropdownVisible,
          activeSectionAfterSelect,
          dropdownHiddenAfterSelect,
          inputClearedAfterSelect
        };
      } catch (err) {
        return { ok: false, error: String(err && err.stack ? err.stack : err) };
      }
    })()
  `) as {
    ok: boolean;
    error?: string;
    hasResults: boolean;
    dropdownVisible: boolean;
    activeSectionAfterSelect: string;
    dropdownHiddenAfterSelect: boolean;
    inputClearedAfterSelect: boolean;
  };

  assert.equal(searchTestResult.ok, true, searchTestResult.error);
  assert.equal(searchTestResult.hasResults, true, '빠른 검색 결과가 렌더링되지 않았습니다.');
  assert.equal(searchTestResult.dropdownVisible, true, '검색 드롭다운이 열리지 않았습니다.');
  assert.equal(searchTestResult.activeSectionAfterSelect, 'section-shortcuts', '빠른 검색 선택 후 해당 섹션으로 이동하지 않았습니다.');
  assert.equal(searchTestResult.dropdownHiddenAfterSelect, true, '검색 선택 후 드롭다운이 닫히지 않았습니다.');
  assert.equal(searchTestResult.inputClearedAfterSelect, true, '검색 선택 후 입력창이 초기화되지 않았습니다.');

  // '경험의 정수' 검색 시 HUD 위젯 관리(section-game-overlay)로 이동하고 카드에 하이라이트가 적용되는지 검증
  const essenceSearchTest = await window.webContents.executeJavaScript(`
    (() => {
      try {
        const searchInput = document.getElementById('settings-quick-search');
        const resultsDropdown = document.getElementById('settings-search-results');
        searchInput.value = '경험의 정수';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));

        const items = resultsDropdown.querySelectorAll('.search-result-item');
        if (items.length === 0) return { ok: false, error: '경험의 정수 검색 결과 없음' };

        items[0].click();
        const activeSection = Array.from(document.querySelectorAll('.settings-section')).find(s => !s.classList.contains('hidden'))?.id;
        const activeNavGroup = document.querySelector('.nav-item.active')?.getAttribute('data-settings-group');
        
        const card = document.getElementById('xp-feature-settings-card');
        const hasPulse = card?.classList.contains('highlight-pulse-effect');

        return {
          ok: true,
          activeSection,
          activeNavGroup,
          hasPulse: Boolean(hasPulse)
        };
      } catch (err) {
        return { ok: false, error: String(err && err.stack ? err.stack : err) };
      }
    })()
  `) as { ok: boolean; error?: string; activeSection: string; activeNavGroup: string; hasPulse: boolean };

  assert.equal(essenceSearchTest.ok, true, essenceSearchTest.error);
  assert.equal(essenceSearchTest.activeNavGroup, 'game', '경험의 정수 선택 시 game 그룹이어야 합니다.');
  assert.equal(essenceSearchTest.activeSection, 'section-game-overlay', '경험의 정수 선택 시 section-game-overlay로 이동해야 합니다.');

  // 가이드창 바로가기(display:game-overlay) 연계 호출 시 이전 하이라이트가 제거되고 HUD 편집 카드만 단독 하이라이트되는지 검증
  const guideDeepLinkTest = await window.webContents.executeJavaScript(`
    (() => {
      try {
        const target = resolveSettingsRoute('display:game-overlay');
        const navEl = document.querySelector('.nav-item[data-settings-group="' + target.groupId + '"]');
        showSettingsGroup(target.groupId, navEl, target.routeIndex);
        triggerSectionHighlight('display:game-overlay');

        const essenceCard = document.getElementById('xp-feature-settings-card');
        const essenceHasPulse = essenceCard?.classList.contains('highlight-pulse-effect');

        const hudPosCard = document.getElementById('hud-position-settings-card');
        const hudCardHasPulse = hudPosCard?.classList.contains('highlight-pulse-effect');
        const totalPulseCount = document.querySelectorAll('.highlight-pulse-effect').length;

        return {
          ok: true,
          essenceHasPulse: Boolean(essenceHasPulse),
          hudCardHasPulse: Boolean(hudCardHasPulse),
          totalPulseCount
        };
      } catch (err) {
        return { ok: false, error: String(err && err.stack ? err.stack : err) };
      }
    })()
  `) as { ok: boolean; error?: string; essenceHasPulse: boolean; hudCardHasPulse: boolean; totalPulseCount: number };

  assert.equal(guideDeepLinkTest.ok, true, guideDeepLinkTest.error);
  assert.equal(guideDeepLinkTest.essenceHasPulse, false, '이전 경험의 정수 카드의 펄스 하이라이트가 제거되지 않았습니다.');
}

async function checkGoogleRestoreSelection(window: BrowserWindow): Promise<void> {
  window.setContentSize(800, 600);
  await window.loadFile(path.join(projectRoot, 'dist', 'settings.html'));
  await waitForSelector(window, '#google-restore-settings');
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const restoreCalls = [];
      const confirms = [];
      const alerts = [];
      const previewKinds = [];
      let previewCalls = 0;
      let rollbackCalls = 0;
      window.confirm = message => { confirms.push(message); return true; };
      window.alert = message => alerts.push(message);
      window.electronAPI = {
        googleSyncPreview: async kind => {
          previewCalls++;
          previewKinds.push(kind);
          return {
            success: true,
            partial: false,
            payload: {
              schemaVersion: 1,
              appVersion: '3.0.0-test',
              lastSyncedAt: 1_722_150_000_000,
              updatedBy: '',
              data: kind === 'checklist'
                ? {
                    characterPresets: [{ id: 'char-main', name: '숙제 캐릭터' }],
                    testRows: Array.from({ length: 80 }, (_, index) => ({ index }))
                  }
                : {
                    userServer: 16,
                    testRows: Array.from({ length: 80 }, (_, index) => ({ index }))
                  }
            },
            fileMeta: {
              id: kind === 'checklist' ? 'checklist-file' : 'settings-file',
              name: kind === 'checklist' ? 'tw_overlay_checklist.json' : 'tw_overlay_settings.json'
            },
            fileCount: kind ? 1 : 3,
            files: kind
              ? [{ id: kind + '-file', name: kind === 'checklist' ? 'tw_overlay_checklist.json' : 'tw_overlay_settings.json' }]
              : [
                  { id: 'settings-file', name: 'tw_overlay_settings.json' },
                  { id: 'checklist-file', name: 'tw_overlay_checklist.json' },
                  { id: 'meta-file', name: 'tw_overlay_sync_meta.json' }
                ],
            restoreResults: [
              { kind: 'settings', selected: true, status: 'available' },
              { kind: 'checklist', selected: true, status: 'available' }
            ],
            changeSummaries: [
              {
                kind: 'settings',
                changedKeys: ['userServer'],
                addedKeys: [],
                preservedLocalKeys: ['showTodaySummaryHud'],
                unchangedCount: 4
              }
            ]
          };
        },
        googleSyncRestore: async kinds => {
          restoreCalls.push(kinds);
          return {
            success: true,
            partial: true,
            profileState: 'needs-confirmation',
            fileName: 'tw_overlay_settings.json, tw_overlay_checklist.json',
            restoreResults: [
              { kind: 'settings', selected: true, status: 'restored' },
              { kind: 'checklist', selected: false, status: 'skipped' }
            ]
          };
        },
        googleSyncRollback: async () => {
          rollbackCalls++;
          return { success: true };
        },
        googleSyncGetStatus: async () => ({
          isLinked: true,
          localBackupAvailable: true,
          localBackupCreatedAt: 1000,
          fileStatuses: [
            { kind: 'settings', localChecksum: 'abcdef0123456789', cloudRevision: 'remote-settings-1', pendingChanges: 2, retryCount: 1, lastError: 'mock failure' },
            { kind: 'checklist', localChecksum: '1234567890abcdef', cloudRevision: 'remote-checklist-1', pendingChanges: 0, retryCount: 0 }
          ],
          pullRetryCount: 1
        })
      };
      const advanced = document.getElementById('google-sync-advanced');
      const advancedDefaultClosed = advanced instanceof HTMLDetailsElement && !advanced.open;
      const basicActionLabels = [
        document.getElementById('btn-google-backup')?.textContent?.trim(),
        document.getElementById('btn-google-restore')?.textContent?.trim(),
      ];
      const simpleGuideText = document.getElementById('google-sync-linked-view')?.textContent || '';
      const technicalControlsInsideAdvanced = [
        document.getElementById('google-file-sync-status'),
        document.getElementById('google-restore-settings'),
        document.getElementById('btn-google-preview'),
        document.getElementById('google-sync-file-name'),
      ].every(element => element?.closest('#google-sync-advanced') === advanced);
      if (advanced instanceof HTMLDetailsElement) advanced.open = true;
      document.getElementById('google-restore-settings').checked = true;
      document.getElementById('google-restore-checklist').checked = false;
      await handleGoogleRestoreNow();
      const statusText = document.getElementById('google-restore-status')?.textContent || '';
      const statusVisible = !document.getElementById('google-restore-status')?.classList.contains('hidden');
      const summaryText = document.getElementById('google-change-summary')?.textContent || '';
      const summaryVisible = !document.getElementById('google-change-summary')?.classList.contains('hidden');
      renderGoogleRestoreStatus([{
        kind: 'settings',
        selected: true,
        status: 'incompatible',
        error: '현재 버전에서 동기화할 수 없습니다. TW-Overlay를 최신 버전으로 업데이트해 주세요.'
      }], true, 'needs-confirmation');
      const incompatibleStatusText = document.getElementById('google-restore-status')?.textContent || '';
      updateGoogleSyncUI({
        isLinked: true,
        localBackupAvailable: true,
        localBackupCreatedAt: 1000,
        fileStatuses: [
          { kind: 'settings', localChecksum: 'abcdef0123456789', cloudRevision: 'remote-settings-1', pendingChanges: 2, retryCount: 1, lastError: 'mock failure' },
          { kind: 'checklist', localChecksum: '1234567890abcdef', cloudRevision: 'remote-checklist-1', pendingChanges: 0, retryCount: 0 }
        ],
        pullRetryCount: 1
      });
      const rollbackVisible = !document.getElementById('btn-google-rollback')?.classList.contains('hidden');
      const rollbackTooltip = document.getElementById('btn-google-rollback')?.getAttribute('data-settings-tooltip') || '';
      const fileStatusText = document.getElementById('google-file-sync-status')?.textContent || '';
      const fileNameText = document.getElementById('google-sync-file-name')?.textContent || '';
      const syncBadgeText = document.getElementById('google-sync-badge')?.textContent || '';
      const logoutButton = document.getElementById('btn-google-logout');
      const logoutOutsideAdvanced = logoutButton?.closest('#google-sync-advanced') === null;
      const actionTooltips = {
        backup: document.getElementById('btn-google-backup')?.getAttribute('data-settings-tooltip') || '',
        restore: document.getElementById('btn-google-restore')?.getAttribute('data-settings-tooltip') || '',
        logout: document.getElementById('btn-google-logout')?.getAttribute('data-settings-tooltip') || '',
      };
      const backupButton = document.getElementById('btn-google-backup');
      backupButton?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const customTooltip = document.getElementById('settings-custom-tooltip');
      const customTooltipShown = customTooltip?.style.display === 'block'
        && customTooltip?.getAttribute('aria-hidden') === 'false'
        && /Google Drive에 바로 저장/.test(customTooltip?.textContent || '');
      backupButton?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      const customTooltipHidden = customTooltip?.style.display === 'none'
        && customTooltip?.getAttribute('aria-hidden') === 'true';
      const nativeTitlesRemoved = ['btn-google-backup', 'btn-google-restore', 'btn-google-logout']
        .every(id => !document.getElementById(id)?.hasAttribute('title'));
      const cloudTooltipElements = Array.from(document.querySelectorAll(
        '#google-sync-advanced [data-settings-tooltip], #btn-google-logout, #btn-google-backup, #btn-google-restore'
      ));
      const cloudTooltipsUnified = cloudTooltipElements.length >= 10
        && cloudTooltipElements.every(element => !element.hasAttribute('title')
          && element.getAttribute('aria-describedby') === 'settings-custom-tooltip');
      const previewButtons = Array.from(document.querySelectorAll('[data-google-preview-kind]'));
      previewButtons[0]?.click();
      await new Promise(resolve => setTimeout(resolve, 20));
      const settingsPreviewTitle = document.getElementById('google-sync-preview-title')?.textContent || '';
      const settingsPreviewJson = document.getElementById('google-sync-preview-code')?.textContent || '';
      const previewCodeScroll = document.getElementById('google-sync-preview-code-scroll');
      if (previewCodeScroll) previewCodeScroll.scrollTop = 120;
      const previewScrollMoved = (previewCodeScroll?.scrollTop || 0) > 0;
      previewButtons[1]?.click();
      await new Promise(resolve => setTimeout(resolve, 20));
      const checklistPreviewTitle = document.getElementById('google-sync-preview-title')?.textContent || '';
      const checklistPreviewJson = document.getElementById('google-sync-preview-code')?.textContent || '';
      const previewButtonKinds = previewButtons.map(button => button.dataset.googlePreviewKind);
      const previewButtonLabels = previewButtons.map(button => button.textContent?.trim());
      updateGoogleSyncUI({ isLinked: false, reauthRequired: true, email: 'expired@example.com' });
      const reauthUi = {
        title: document.getElementById('google-sync-unlinked-title')?.textContent || '',
        description: document.getElementById('google-sync-unlinked-description')?.textContent || '',
        loginLabel: document.getElementById('google-sync-login-label')?.textContent || '',
        badge: document.getElementById('google-sync-badge')?.textContent || '',
        unlinkedVisible: !document.getElementById('google-sync-unlinked-view')?.classList.contains('hidden'),
        linkedHidden: document.getElementById('google-sync-linked-view')?.classList.contains('hidden') === true,
      };
      const syncActivityTexts = {};
      for (const activity of ['upload', 'download', 'checking', 'preview', 'rollback']) {
        updateGoogleSyncUI({ isLinked: true, isSyncing: true, syncActivity: activity });
        syncActivityTexts[activity] = document.getElementById('google-sync-badge')?.textContent || '';
      }
      const copyButton = document.getElementById('btn-google-preview-copy');
      const closeButton = document.getElementById('btn-google-preview-close');
      const copyButtonNoWrap = copyButton ? getComputedStyle(copyButton).whiteSpace === 'nowrap' : false;
      const closeButtonNoWrap = closeButton ? getComputedStyle(closeButton).whiteSpace === 'nowrap' : false;
      const globalPreviewLabel = document.getElementById('btn-google-preview')?.textContent?.trim() || '';
      const previewSummary = document.getElementById('google-sync-preview-summary');
      const previewCode = document.getElementById('google-sync-preview-code');
      const summaryRect = previewSummary?.getBoundingClientRect();
      const codeScrollRect = previewCodeScroll?.getBoundingClientRect();
      const previewLayout = {
        codeNestedInScrollViewport: previewCode?.parentElement === previewCodeScroll,
        summaryDoesNotShrink: previewSummary ? getComputedStyle(previewSummary).flexShrink === '0' : false,
        summaryEndsBeforeCode: Boolean(summaryRect && codeScrollRect && summaryRect.bottom <= codeScrollRect.top),
        scrollMovedBeforeFileChange: previewScrollMoved,
        scrollResetAfterFileChange: (previewCodeScroll?.scrollTop || 0) === 0
      };
      await handleGoogleRollback();
      return {
        restoreCalls,
        previewCalls,
        previewKinds,
        rollbackCalls,
        confirms,
        alerts,
        advancedDefaultClosed,
        basicActionLabels,
        simpleGuideText,
        technicalControlsInsideAdvanced,
        statusText,
        statusVisible,
        incompatibleStatusText,
        summaryText,
        summaryVisible,
        rollbackVisible,
        rollbackTooltip,
        fileStatusText,
        fileNameText,
        syncBadgeText,
        logoutOutsideAdvanced,
        actionTooltips,
        customTooltipShown,
        customTooltipHidden,
        nativeTitlesRemoved,
        cloudTooltipsUnified,
        syncActivityTexts,
        reauthUi,
        previewButtonKinds,
        previewButtonLabels,
        settingsPreviewTitle,
        settingsPreviewJson,
        checklistPreviewTitle,
        checklistPreviewJson,
        copyButtonNoWrap,
        closeButtonNoWrap,
        globalPreviewLabel,
        previewLayout,
      };
    })()
  `) as {
    restoreCalls: string[][];
    previewCalls: number;
    previewKinds: Array<string | undefined>;
    rollbackCalls: number;
    confirms: string[];
    alerts: string[];
    advancedDefaultClosed: boolean;
    basicActionLabels: Array<string | undefined>;
    simpleGuideText: string;
    technicalControlsInsideAdvanced: boolean;
    statusText: string;
    statusVisible: boolean;
    incompatibleStatusText: string;
    summaryText: string;
    summaryVisible: boolean;
    rollbackVisible: boolean;
    rollbackTooltip: string;
    fileStatusText: string;
    fileNameText: string;
    syncBadgeText: string;
    logoutOutsideAdvanced: boolean;
    actionTooltips: Record<string, string>;
    customTooltipShown: boolean;
    customTooltipHidden: boolean;
    nativeTitlesRemoved: boolean;
    cloudTooltipsUnified: boolean;
    syncActivityTexts: Record<string, string>;
    reauthUi: Record<string, string | boolean>;
    previewButtonKinds: string[];
    previewButtonLabels: string[];
    settingsPreviewTitle: string;
    settingsPreviewJson: string;
    checklistPreviewTitle: string;
    checklistPreviewJson: string;
    copyButtonNoWrap: boolean;
    closeButtonNoWrap: boolean;
    globalPreviewLabel: string;
    previewLayout: Record<string, boolean>;
  };

  assert.deepEqual(result.restoreCalls, [['settings']]);
  assert.equal(result.previewCalls, 3);
  assert.deepEqual(result.previewKinds, [undefined, 'settings', 'checklist']);
  assert.equal(result.rollbackCalls, 1);
  assert.equal(result.advancedDefaultClosed, true, '고급 동기화 정보가 기본 화면에 펼쳐져 있습니다.');
  assert.deepEqual(result.basicActionLabels, ['지금 저장', '불러오기']);
  assert.match(result.simpleGuideText, /설정이나 숙제가 바뀌면 자동으로 저장하고, 다른 PC의 변경 내용도 가져옵니다/);
  assert.equal(result.technicalControlsInsideAdvanced, true, '파일·복원 진단 제어가 기본 화면에 노출됩니다.');
  assert.equal(result.statusVisible, true);
  assert.match(result.statusText, /일부 파일만 복원되었습니다/);
  assert.match(result.statusText, /일반 설정복원 완료/);
  assert.match(result.statusText, /숙제 체크리스트선택하지 않음/);
  assert.match(result.incompatibleStatusText, /일반 설정현재 버전에서 동기화할 수 없음/);
  assert.equal(result.summaryVisible, true);
  assert.match(result.summaryText, /userServer/);
  assert.match(result.summaryText, /showTodaySummaryHud/);
  assert.match(result.confirms[0], /변경 1개, 현재 PC 유지 1개/);
  assert.equal(result.rollbackVisible, true);
  assert.match(result.rollbackTooltip, /마지막 불러오기 전.*백업 시각/);
  assert.match(result.fileStatusText, /일반 설정대기 2개/);
  assert.match(result.fileStatusText, /업로드 재시도 1회/);
  assert.match(result.fileStatusText, /숙제 체크리스트전송 완료/);
  assert.match(result.fileStatusText, /원격 확인 재시도 1회/);
  assert.match(result.fileNameText, /tw_overlay_settings\.json, tw_overlay_checklist\.json \(Drive AppData\)/);
  assert.match(result.syncBadgeText, /자동 동기화 켜짐/);
  assert.equal(result.logoutOutsideAdvanced, true, 'Google 계정 연결 해제가 고급 설정 안에 숨겨졌습니다.');
  assert.match(result.actionTooltips.backup, /Google Drive에 바로 저장/);
  assert.match(result.actionTooltips.restore, /Google Drive에 저장된.*이 PC로 불러옵니다/);
  assert.match(result.actionTooltips.logout, /로컬 데이터는 유지/);
  assert.equal(result.customTooltipShown, true, 'Google 동기화 버튼의 커스텀 툴팁이 표시되지 않습니다.');
  assert.equal(result.customTooltipHidden, true, 'Google 동기화 버튼에서 벗어난 뒤 커스텀 툴팁이 닫히지 않습니다.');
  assert.equal(result.nativeTitlesRemoved, true, 'Google 동기화 버튼에 브라우저 기본 title 툴팁이 남아 있습니다.');
  assert.equal(result.cloudTooltipsUnified, true, 'Google 동기화 영역에 기본 title 또는 비통일 툴팁이 남아 있습니다.');
  assert.match(result.syncActivityTexts.upload, /클라우드에 저장 중/);
  assert.match(result.syncActivityTexts.download, /클라우드에서 불러오는 중/);
  assert.match(result.syncActivityTexts.checking, /새 변경 확인 중/);
  assert.match(result.syncActivityTexts.preview, /저장 데이터 확인 중/);
  assert.match(result.syncActivityTexts.rollback, /이전 상태로 되돌리는 중/);
  assert.equal(result.reauthUi.unlinkedVisible, true);
  assert.equal(result.reauthUi.linkedHidden, true);
  assert.match(String(result.reauthUi.title), /다시 로그인/);
  assert.match(String(result.reauthUi.description), /대기 중인 변경 내용부터 이어서 동기화/);
  assert.equal(result.reauthUi.loginLabel, '다시 로그인');
  assert.match(String(result.reauthUi.badge), /다시 로그인 필요/);
  assert.deepEqual(result.previewButtonKinds, ['settings', 'checklist']);
  assert.deepEqual(result.previewButtonLabels, ['데이터 확인', '데이터 확인']);
  assert.match(result.settingsPreviewTitle, /일반 설정 데이터 확인/);
  assert.match(result.settingsPreviewJson, /"userServer": 16/);
  assert.doesNotMatch(result.settingsPreviewJson, /characterPresets/);
  assert.match(result.checklistPreviewTitle, /숙제 체크리스트 데이터 확인/);
  assert.match(result.checklistPreviewJson, /characterPresets/);
  assert.doesNotMatch(result.checklistPreviewJson, /userServer/);
  assert.equal(result.copyButtonNoWrap, true);
  assert.equal(result.closeButtonNoWrap, true);
  assert.match(result.globalPreviewLabel, /전체 데이터 확인/);
  assert.deepEqual(result.previewLayout, {
    codeNestedInScrollViewport: true,
    summaryDoesNotShrink: true,
    summaryEndsBeforeCode: true,
    scrollMovedBeforeFileChange: true,
    scrollResetAfterFileChange: true,
  });
  assert.equal(result.alerts.length, 2);
}

async function checkHuntingExpCalculator(window: BrowserWindow): Promise<void> {
  const defaultConfig = (require(path.join(projectRoot, 'dist', 'modules', 'constants.js')) as {
    DEFAULT_CONFIG: Record<string, unknown>;
  }).DEFAULT_CONFIG;
  const html = fs.readFileSync(
    path.join(projectRoot, 'dist', 'hunting-exp-calculator.html'),
    'utf8',
  ).replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '');
  const calculatorCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'huntingExpCalculator.js'),
    'utf8',
  );
  const rendererCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'hunting-exp-calculator.js'),
    'utf8',
  );
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);

  const result = await window.webContents.executeJavaScript(`
    (() => {
      const saved = [];
      window.lucide = { createIcons() {} };
      window.electronAPI = {
        DEFAULT_CONFIG: ${JSON.stringify(defaultConfig)},
        onConfigData(callback) { callback(${JSON.stringify(defaultConfig)}); },
        applySettings(settings) { saved.push(settings); }
      };
      ${calculatorCode}
      ${rendererCode}

      const initial = {
        applied: document.getElementById('applied-percent').textContent,
        perKill: document.getElementById('xp-per-kill').textContent,
        perHour: document.getElementById('xp-per-hour').textContent,
        eok: document.getElementById('xp-per-hour-eok').textContent,
        essence: document.getElementById('essence-per-hour').textContent,
        essenceImage: document.querySelector('.essence-icon')?.getAttribute('src'),
        dopingImages: Array.from(document.querySelectorAll('.doping-icon img')).map(image => image.getAttribute('src')),
        count: document.getElementById('doping-count').textContent
      };
      const dopingList = document.getElementById('doping-list');
      const scrollMetrics = {
        clientHeight: dopingList.clientHeight,
        scrollHeight: dopingList.scrollHeight,
        initialTop: dopingList.scrollTop
      };
      dopingList.scrollTop = 120;
      scrollMetrics.scrolledTop = dopingList.scrollTop;
      const firstToggle = document.querySelector('[data-action="toggle-doping"]');
      firstToggle.checked = false;
      firstToggle.dispatchEvent(new Event('change', { bubbles: true }));
      scrollMetrics.afterToggleTop = dopingList.scrollTop;
      const afterToggle = document.getElementById('applied-percent').textContent;

      const ground = document.getElementById('ground-select');
      ground.value = 'void';
      ground.dispatchEvent(new Event('change', { bubbles: true }));
      const kills = document.getElementById('kills-per-hour');
      kills.value = '1000';
      kills.dispatchEvent(new Event('input', { bubbles: true }));
      kills.dispatchEvent(new Event('change', { bubbles: true }));
      const happy = document.getElementById('happy-hour-input');
      happy.checked = false;
      happy.dispatchEvent(new Event('change', { bubbles: true }));

      const siokanInput = document.querySelector('[data-action="percent-input"][data-id="core-siokan"]');
      const siokanInitialValue = siokanInput ? siokanInput.value : '';
      if (siokanInput) {
        siokanInput.value = '400';
        siokanInput.dispatchEvent(new Event('input', { bubbles: true }));
        siokanInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const afterSiokanChange = document.getElementById('applied-percent').textContent;

      document.getElementById('add-doping-btn').click();
      document.getElementById('editor-name').value = '<img id="injected-hunting">테스트 도핑';
      document.getElementById('editor-value').value = '25';
      document.getElementById('editor-duration').value = '15분';
      document.getElementById('editor-note').value = '사용자 추가';
      document.getElementById('editor-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      return {
        initial,
        scrollMetrics,
        afterToggle,
        siokanInitialValue,
        afterSiokanChange,
        finalPerKill: document.getElementById('xp-per-kill').textContent,
        finalPerHour: document.getElementById('xp-per-hour').textContent,
        finalEssence: document.getElementById('essence-per-hour').textContent,
        injectedCount: document.querySelectorAll('#injected-hunting').length,
        customName: Array.from(document.querySelectorAll('.doping-name')).at(-1)?.textContent,
        savedCount: saved.length,
        lastSaved: saved.at(-1)
      };
    })()
  `) as {
    initial: { applied: string; perKill: string; perHour: string; eok: string; essence: string; essenceImage: string; dopingImages: string[]; count: string };
    scrollMetrics: { clientHeight: number; scrollHeight: number; initialTop: number; scrolledTop: number; afterToggleTop: number };
    afterToggle: string;
    siokanInitialValue: string;
    afterSiokanChange: string;
    finalPerKill: string;
    finalPerHour: string;
    finalEssence: string;
    injectedCount: number;
    customName: string;
    savedCount: number;
    lastSaved: { huntingExpDopings: Array<{ name: string; percent: number }> };
  };

  assert.deepEqual(result.initial, {
    applied: '4,825%',
    perKill: '14,775,000',
    perHour: '591,000,000,000',
    eok: '5,910억',
    essence: '약 59.1개',
    essenceImage: 'assets/img/경험의정수.png',
    dopingImages: [
      'assets/img/buffs/경험의심장.png',
      'assets/img/buffs/최상급_에오스의_파편.png',
      'assets/img/buffs/얼리버드_경험치_부스터.png',
      'assets/img/buffs/전설의_군고구마.png',
      'assets/img/buffs/일루미네이션축체음료.png',
    ],
    count: '21/28개 적용',
  });
  assert.ok(result.scrollMetrics.clientHeight > 0);
  assert.ok(result.scrollMetrics.scrollHeight > result.scrollMetrics.clientHeight,
    '도핑 목록이 창 높이를 넘을 때 내부 스크롤 영역이 생성되지 않습니다.');
  assert.equal(result.scrollMetrics.initialTop, 0);
  assert.ok(result.scrollMetrics.scrolledTop > 0,
    '도핑 목록의 스크롤 위치가 변경되지 않습니다.');
  assert.equal(result.scrollMetrics.afterToggleTop, result.scrollMetrics.scrolledTop,
    '체크박스 토글 시 스크롤 위치가 최상단으로 초기화되지 않아야 합니다.');
  assert.equal(result.afterToggle, '4,795%');
  assert.equal(result.siokanInitialValue, '380');
  assert.equal(result.afterSiokanChange, '4,815%');
  assert.equal(result.finalPerKill, '48,167,000');
  assert.equal(result.finalPerHour, '48,167,000,000');
  assert.equal(result.finalEssence, '약 4.82개');
  assert.equal(result.injectedCount, 0);
  assert.equal(result.customName, '<img id="injected-hunting">테스트 도핑');
  assert.ok(result.savedCount >= 5);
  assert.equal(result.lastSaved.huntingExpDopings.at(-1)?.percent, 25);
}

async function checkRelicCalculator(window: BrowserWindow): Promise<void> {
  window.setContentSize(920, 760);
  await window.loadFile(path.join(projectRoot, 'dist', 'relic-calculator.html'));
  await waitForSelector(window, '#expectation-result .metric');
  const result = await window.webContents.executeJavaScript(`
    (() => {
      const current = document.getElementById('current-stage');
      current.value = '19';
      current.dispatchEvent(new Event('change'));
      document.getElementById('target-stage').value = '19';
      document.getElementById('difficulty').value = '20';
      document.querySelectorAll('[data-relic-stat]').forEach(input => {
        input.value = '199';
        input.dispatchEvent(new Event('input'));
      });
      document.getElementById('expectation-btn').click();
      const expectationText = document.getElementById('expectation-result').textContent;
      document.querySelector('[data-tab="simulation"]').click();
      const originalRandom = Math.random;
      Math.random = () => 0;
      document.getElementById('simulate-btn').click();
      let closedByEscape = false;
      const originalClose = window.close;
      window.close = () => { closedByEscape = true; };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.close = originalClose;

      return {
        expectationText,
        simulationVisible: !document.getElementById('simulation-panel').classList.contains('hidden'),
        simulationText: document.getElementById('simulation-result').textContent,
        currentGuide: document.getElementById('current-guide').textContent,
        statLabels: Array.from(document.querySelectorAll('#stat-inputs label')).map(label => label.textContent.trim()),
        statValues: Array.from(document.querySelectorAll('[data-relic-stat]')).map(input => input.value),
        closedByEscape,
      };
    })()
  `) as { expectationText: string; simulationVisible: boolean; simulationText: string; currentGuide: string; statLabels: string[]; statValues: string[]; closedByEscape: boolean };
  assert.match(result.expectationText, /25회/);
  assert.match(result.expectationText, /달의 파편 750개/);
  assert.match(result.expectationText, /6억 1,250만 SEED/);
  assert.equal(result.simulationVisible, true);
  assert.match(result.simulationText, /달의 파편/);
  assert.match(result.currentGuide, /합계 MAX 1,000/);
  assert.deepEqual(result.statLabels, ['찌르기 공격력', '베기 공격력', '마법 공격력', '명중률 보정', '크리티컬']);
  assert.deepEqual(result.statValues, ['199', '199', '199', '199', '199']);
  assert.equal(result.closedByEscape, true);
}

async function checkEquipmentSimulator(window: BrowserWindow): Promise<void> {
  window.setContentSize(960, 820);
  await window.loadFile(path.join(projectRoot, 'dist', 'equipment-simulator.html'));
  await waitForSelector(window, '#enhance-exp-metrics .metric');
  const result = await window.webContents.executeJavaScript(`
    (() => {
      // 1. 강화 탭 테스트
      const enhanceExpText = document.getElementById('enhance-exp-metrics').textContent;
      const stageFeeInput = document.querySelector('input[data-stage-fee="0"]');
      if (stageFeeInput) {
        stageFeeInput.value = '50000';
        stageFeeInput.dispatchEvent(new Event('change'));
      }
      const tableText = document.getElementById('enhance-exp-stage-table').textContent;

      // 2. 인챈트 탭 전환 및 테스트
      document.querySelector('[data-main-tab="enchant"]').click();
      const enchantVisible = !document.getElementById('panel-enchant').classList.contains('hidden');
      const presetSelect = document.getElementById('enchant-preset-select');
      presetSelect.value = 'p_8_nobless';
      presetSelect.dispatchEvent(new Event('change'));
      const badgeText = document.getElementById('enchant-rate-summary-badge').textContent;
      const enchantExpText = document.getElementById('enchant-exp-metrics').textContent;

      // 3. 인크립트 탭 전환 및 테스트
      document.querySelector('[data-main-tab="incrypt"]').click();
      const incryptVisible = !document.getElementById('panel-incrypt').classList.contains('hidden');
      const incryptExpText = document.getElementById('incrypt-exp-metrics').textContent;

      let closedByEscape = false;
      const originalClose = window.close;
      window.close = () => { closedByEscape = true; };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.close = originalClose;

      return {
        enhanceExpText,
        tableText,
        enchantVisible,
        badgeText,
        enchantExpText,
        incryptVisible,
        incryptExpText,
        closedByEscape,
      };
    })()
  `) as {
    enhanceExpText: string;
    tableText: string;
    enchantVisible: boolean;
    badgeText: string;
    enchantExpText: string;
    incryptVisible: boolean;
    incryptExpText: string;
    closedByEscape: boolean;
  };

  assert.ok(result.enhanceExpText.includes('평균 총 시도 횟수'));
  assert.ok(result.tableText.includes('구간 돌파 기댓값'));
  assert.equal(result.enchantVisible, true);
  assert.ok(result.badgeText.includes('축복치 없음'));
  assert.ok(result.enchantExpText.includes('1회 성공당 평균 시도'));
  assert.equal(result.incryptVisible, true);
  assert.ok(result.incryptExpText.includes('목표 성공당 평균 시도'));
  assert.equal(result.closedByEscape, true);

  // 실제 HTML의 입력 이벤트와 계산 모듈을 그대로 사용해 0/미입력 및 횟수 경계를 검증한다.
  const boundaries = await evaluate(window, () => {
    const set = (id: string, value: string, event = 'input') => {
      const field = document.getElementById(id) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event(event, { bubbles: true }));
    };
    const fee = (value: string) => {
      const field = document.querySelector<HTMLInputElement>('[data-stage-fee="0"]')!;
      field.value = value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const feeSnapshot = () => ({
      value: document.querySelector<HTMLInputElement>('[data-stage-fee="0"]')!.value,
      metric: document.querySelector('#enhance-exp-metrics .metric:last-child strong')!.textContent,
      row: document.querySelector('#enhance-exp-stage-table tbody tr')!.textContent,
    });
    document.querySelector<HTMLButtonElement>('[data-main-tab="enhance"]')!.click();
    set('enhance-current-stage', '0', 'change');
    set('enhance-target-stage', '1', 'change');
    const fees = [];
    for (const currency of ['seed', 'elso']) {
      for (const noPenalty of [false, true]) {
        const toggle = document.getElementById('enhance-nopenalty-toggle') as HTMLInputElement;
        toggle.checked = noPenalty;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        set('enhance-nopenalty-rate', '1', 'change');
        set('enhance-currency-type', currency, 'change');
        set('enhance-price-fee', '1000000');
        fee('0');
        const zero = feeSnapshot();
        fee('500000');
        const positive = feeSnapshot();
        set('enhance-price-fee', '2000000');
        const retained = feeSnapshot();
        fee('');
        const inherited = feeSnapshot();
        fees.push({ currency, noPenalty, zero, positive, retained, inherited });
      }
    }
    document.querySelector<HTMLButtonElement>('[data-main-tab="enchant"]')!.click();
    set('enchant-preset-select', 'custom_var', 'change');
    set('enchant-initial-blessing', '98');
    set('enchant-price-fee', '1000000');
    const targets = ['-1', '0', '2.9', '101', '', '2'].map(value => {
      set('enchant-target-success', value);
      return {
        input: value,
        value: (document.getElementById('enchant-target-success') as HTMLInputElement).value,
        metrics: document.getElementById('enchant-exp-metrics')!.textContent,
      };
    });
    const prices = [];
    for (const [panel, ids] of [
      ['enhance', ['enhance-price-fee', 'enhance-price-stone', 'enhance-price-talisman', 'enhance-price-scroll']],
      ['enchant', ['enchant-price-fee', 'enchant-price-scroll', 'enchant-price-enhance-scroll']],
      ['incrypt', ['incrypt-price-fee', 'incrypt-price-scroll', 'incrypt-price-protect', 'incrypt-price-equip']],
    ] as const) {
      document.querySelector<HTMLButtonElement>('[data-main-tab="' + panel + '"]')!.click();
      for (const id of ids) {
        set(id, '-1000000');
        prices.push({ id, value: (document.getElementById(id) as HTMLInputElement).value });
      }
    }
    const protections = ['-1', '0.5', '99', '3.5'].map(value => {
      set('incrypt-protect-count', value);
      return {
        input: value,
        value: (document.getElementById('incrypt-protect-count') as HTMLInputElement).value,
        guide: document.getElementById('incrypt-rates-guide')!.textContent,
      };
    });
    const blessings = ['-1', '101'].map(value => {
      set('enchant-initial-blessing', value);
      return (document.getElementById('enchant-initial-blessing') as HTMLInputElement).value;
    });
    return { fees, targets, prices, protections, blessings };
  });
  const failures: string[] = [];
  const verify = (label: string, check: () => void) => { try { check(); } catch (error) { failures.push(`${label}: ${String(error)}`); } };
  for (const row of boundaries.fees) {
    const unit = row.currency === 'elso' ? '엘소' : 'SEED';
    const label = `${row.currency}/${row.noPenalty ? 'scroll' : 'normal'}`;
    verify(`${label} explicit zero`, () => { assert.equal(row.zero.value, '0'); assert.equal(row.zero.metric, `0 ${unit}`); });
    verify(`${label} positive`, () => assert.equal(row.positive.metric, `50만 ${unit}`));
    verify(`${label} retained`, () => assert.equal(row.retained.metric, `50만 ${unit}`));
    verify(`${label} empty inherits`, () => assert.equal(row.inherited.metric, `200만 ${unit}`));
  }
  for (const [index, value] of ['1', '1', '2', '100', '', '2'].entries()) {
    const row = boundaries.targets[index];
    verify(`enchant ${JSON.stringify(row.input)}`, () => {
      assert.equal(row.value, value);
      assert.ok(row.metrics?.includes(`(${value || '1'}회 성공 시:`));
      assert.doesNotMatch(row.metrics || '', /-\d|NaN|Infinity/);
      if (value === '2') assert.ok(row.metrics?.includes('약 9.5회'));
    });
  }
  for (const row of boundaries.prices) verify(row.id, () => assert.equal(row.value, '0'));
  for (const [index, value] of ['0', '0', '60', '3'].entries()) {
    const row = boundaries.protections[index];
    verify(`protection ${row.input}`, () => {
      assert.equal(row.value, value);
      assert.ok(row.guide?.includes(`파괴 확률: ${100 - Number(value)}%`));
    });
  }
  verify('blessing input matches calculation', () => assert.deepEqual(boundaries.blessings, ['0', '100']));
  assert.deepEqual(failures, [], '장비 계산기 실제 입력 경계 처리 실패');
}

async function checkContentsOrderingPersistence(): Promise<void> {
  const configModule = require(path.join(projectRoot, 'dist/modules/config.js')) as {
    load(): { contentsCheckerItems?: Array<{ id: string; category?: string; completedState: Record<string, unknown> }> };
    saveImmediate(value: Record<string, unknown>): void;
  };
  const contentsChecker = require(path.join(projectRoot, 'dist/modules/contentsChecker.js')) as {
    moveItem(id: string, direction: 'up' | 'down'): void;
    moveCategory(resetType: 'daily' | 'weekly', category: string, direction: 'up' | 'down'): void;
    reorderItem(sourceId: string, targetId: string, position: 'before' | 'after'): void;
    reorderCategory(resetType: 'daily' | 'weekly', sourceCategory: string, targetCategory: string, position: 'before' | 'after'): void;
  };
  const makeItem = (id: string, category: string, type: 'daily' | 'weekly') => ({
    id,
    name: id,
    category,
    isVisible: true,
    resetRule: { type },
    completedState: { 'char-main': { isCompleted: id === 'daily-a-1' } },
  });

  configModule.saveImmediate({
    contentsCheckerItems: [
      makeItem('daily-a-1', 'A', 'daily'),
      makeItem('weekly-x-1', 'X', 'weekly'),
      makeItem('daily-b-1', 'B', 'daily'),
      makeItem('daily-a-2', 'A', 'daily'),
    ],
  });

  contentsChecker.moveItem('daily-a-2', 'up');
  assert.deepEqual(
    configModule.load().contentsCheckerItems?.map(item => item.id),
    ['daily-a-2', 'weekly-x-1', 'daily-b-1', 'daily-a-1'],
  );

  contentsChecker.moveCategory('daily', 'B', 'up');
  const reorderedItems = configModule.load().contentsCheckerItems ?? [];
  assert.deepEqual(
    reorderedItems.map(item => item.id),
    ['daily-b-1', 'weekly-x-1', 'daily-a-2', 'daily-a-1'],
  );
  assert.deepEqual(reorderedItems.find(item => item.id === 'daily-a-1')?.completedState, {
    'char-main': { isCompleted: true },
  });

  contentsChecker.moveCategory('daily', 'B', 'up');
  assert.deepEqual(
    configModule.load().contentsCheckerItems?.map(item => item.id),
    ['daily-b-1', 'weekly-x-1', 'daily-a-2', 'daily-a-1'],
  );

  contentsChecker.reorderItem('daily-a-2', 'daily-a-1', 'after');
  assert.deepEqual(
    configModule.load().contentsCheckerItems?.map(item => item.id),
    ['daily-b-1', 'weekly-x-1', 'daily-a-1', 'daily-a-2'],
  );

  contentsChecker.reorderCategory('daily', 'B', 'A', 'after');
  assert.deepEqual(
    configModule.load().contentsCheckerItems?.map(item => item.id),
    ['daily-a-1', 'weekly-x-1', 'daily-a-2', 'daily-b-1'],
  );

  contentsChecker.reorderItem('daily-a-1', 'daily-b-1', 'after');
  const movedAcrossCatItems = configModule.load().contentsCheckerItems ?? [];
  assert.deepEqual(
    movedAcrossCatItems.map(item => item.id),
    ['weekly-x-1', 'daily-a-2', 'daily-b-1', 'daily-a-1'],
  );
  assert.equal(
    movedAcrossCatItems.find(item => item.id === 'daily-a-1')?.category,
    'B',
  );
}

async function checkRendererHelpers(window: BrowserWindow): Promise<void> {
  const defaultConfig = (require(path.join(projectRoot, 'dist', 'modules', 'constants.js')) as {
    DEFAULT_CONFIG: Record<string, unknown>;
  }).DEFAULT_CONFIG;
  const chatChannelsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'chatChannels.js'),
    'utf8',
  );
  const uiUtilsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'assets', 'ui-utils.js'),
    'utf8',
  );
  const sidebarCategoriesCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'sidebarCategories.js'),
    'utf8',
  );
  const alertsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'game-overlay', 'alerts.js'),
    'utf8',
  );
  const settingsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'settings', 'list-rendering.js'),
    'utf8',
  );
  const settingsFormCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'settings', 'form-collection.js'),
    'utf8',
  );
  const settingsShortcutsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'settings', 'shortcuts.js'),
    'utf8',
  );
  const settingsMenuManagementCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'settings', 'menu-management.js'),
    'utf8',
  );
  const settingsAudioControlsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'settings', 'audio-controls.js'),
    'utf8',
  );
  const settingsConfigBindingCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'settings', 'config-binding.js'),
    'utf8',
  );

  const result = await window.webContents.executeJavaScript(`
    (async () => {
      ${uiUtilsCode}
      ${chatChannelsCode}
      ${sidebarCategoriesCode}
      ${alertsCode}
      ${settingsCode}
      let shortcutUnregisterCount = 0;
      let shortcutRegisterCount = 0;
      window.electronAPI = {
        DEFAULT_CONFIG: ${JSON.stringify(defaultConfig)},
        shortcutsUnregister: () => shortcutUnregisterCount++,
        shortcutsRegister: () => shortcutRegisterCount++
      };
      ${settingsFormCode}
      ${settingsShortcutsCode}
      ${settingsMenuManagementCode}
      ${settingsAudioControlsCode}
      ${settingsConfigBindingCode}

      const alert = document.createElement('div');
      alert.id = 'special-monster-alert';
      document.body.appendChild(alert);
      window.gameOverlayAlerts.showSpecialMonsterAlert();

      const questAlert = document.createElement('div');
      questAlert.id = 'quest-alert';
      const questIcon = document.createElement('i');
      questIcon.id = 'quest-alert-icon';
      const questTitle = document.createElement('div');
      questTitle.id = 'quest-alert-title';
      const questBadge = document.createElement('div');
      questBadge.id = 'quest-alert-badge';
      questAlert.append(questIcon, questTitle, questBadge);
      document.body.appendChild(questAlert);
      window.gameOverlayAlerts.showContentComplete({
        title: '심연의 보물창고 완료',
        badge: '3분 후 보물창고 밖으로 이동합니다',
        iconName: 'gem'
      });

      let removeCount = 0;
      const tag = window.settingsListRendering.createKeywordTag(
        '<img id="injected-keyword">키워드',
        'keyword-tag',
        () => removeCount++
      );
      document.body.appendChild(tag);
      tag.querySelector('button').click();

      const soundRow = window.settingsListRendering.createCustomSoundRow({
        sound: { name: '<img id="injected-sound">알림음', file: 'safe.wav' },
        onPreview: () => {},
        onRename: () => {},
        onDelete: () => {}
      });
      document.body.appendChild(soundRow);

      const addInput = (id, value = '', checked = false) => {
        const element = document.createElement('input');
        element.id = id;
        element.value = value;
        element.checked = checked;
        document.body.appendChild(element);
        return element;
      };
      const addSelect = (id, value = '') => {
        const select = document.createElement('select');
        select.id = id;
        if (value) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          select.appendChild(option);
          select.value = value;
        }
        document.body.appendChild(select);
        return select;
      };
      const alertSoundSelects = {
        wave: addSelect('wave-warning-sound', 'orb.mp3'),
        ethos: addSelect('ethos-alert-sound', 'echo.mp3'),
        abyssStart: addSelect('abyss-apostle-start-sound', 'start.mp3'),
        abyssEnd: addSelect('abyss-apostle-end-sound', 'end.mp3'),
        lokagos: addSelect('lokagos-alert-sound', 'lokagos.mp3'),
        questComplete: addSelect('quest-complete-alert-sound', 'start.mp3'),
        abyssTreasure: addSelect('abyss-treasure-alert-sound', 'end.mp3')
      };
      addInput('chat-overlay-width-input', '512');
      addInput('chat-overlay-height-input', '400');
      addInput('chat-overlay-sub-width-input', '450');
      addInput('chat-overlay-sub-height-input', '400');
      addInput('chat-overlay-sub2-width-input', '450');
      addInput('chat-overlay-sub2-height-input', '400');
      addInput('chat-overlay-opacity-input', '0.75');
      addInput('chat-overlay-channel-general', '', true);
      addInput('chat-overlay-channel-whisper', '', false);
      for (const tab of ['Basic', 'General', 'Whisper', 'Team', 'Club', 'Shout', 'System']) {
        addInput('chat-overlay-visible-tab-' + tab, '', ['General', 'Team', 'Club', 'Shout'].includes(tab));
      }
      addInput('chat-overlay-show-npc-chat', '', false);
      addInput('chat-overlay-user-server-input', '2');
      addInput('wave-warning-enabled', '', true);
      addInput('wave-warning-volume', '65');
      addInput('special-monster-alert-enabled', '', true);
      addInput('abandoned-alert-enabled', '', true);
      addInput('pitta-hill-alert-enabled', '', false);
      addInput('quest-complete-alert-enabled', '', true);
      addInput('quest-complete-alert-volume', '32');
      addInput('abyss-treasure-alert-enabled', '', false);
      addInput('abyss-treasure-alert-volume', '33');
      addInput('today-summary-show-input', '', false);
      addInput('today-summary-collapsed-input', '', true);
      addInput('today-summary-pos-left', '315');
      addInput('today-summary-pos-top', '140');
      addInput('show-hud-shortcuts-input', '', true);
      const dockShortcutInput = addInput('shortcut-toggleDock');
      const clickThroughShortcutInput = addInput('shortcut-toggleClickThrough');
      const dockShortcutGuide = document.createElement('span');
      dockShortcutGuide.id = 'dock-shortcut-guide';
      document.body.appendChild(dockShortcutGuide);
      const menuGrid = document.createElement('div');
      menuGrid.id = 'menu-management-grid';
      document.body.appendChild(menuGrid);
      window.chatPickers = {
        general: { getColor: () => ({ toHEXA: () => ({ toString: () => '#123456' }) }) }
      };
      const overlaySettings = window.settingsFormCollection.collectChatOverlayDisplaySettings(['필터테스트123']);
      const lootKeywords = ['득템'];
      const shoutKeywords = ['구매'];
      const alertSettings = window.settingsFormCollection.collectChatAlertSettings(lootKeywords, shoutKeywords);
      const todaySummarySettings = window.settingsFormCollection.collectTodaySummaryHudSettings();
      window.settingsShortcuts.mergeShortcuts({ toggleDock: 'Alt+F5' });
      window.settingsShortcuts.renderInputs();
      const mergedDockShortcut = dockShortcutInput.value;
      const mergedDockGuide = dockShortcutGuide.innerText;
      window.recordShortcut('toggleDock');
      const modifierEvent = new KeyboardEvent('keydown', {
        key: 'Control', code: 'ControlLeft', ctrlKey: true, cancelable: true
      });
      const modifierHandled = window.settingsShortcuts.handleKeyDown(modifierEvent);
      const remainedRecordingAfterModifier = dockShortcutInput.value === '키를 입력하세요...';
      const numpadEvent = new KeyboardEvent('keydown', {
        key: '+', code: 'NumpadAdd', ctrlKey: true, cancelable: true
      });
      const numpadHandled = window.settingsShortcuts.handleKeyDown(numpadEvent);
      const recordedDockShortcut = window.settingsShortcuts.getShortcuts().toggleDock;
      const recordedDockInput = dockShortcutInput.value;
      const guideAfterRecording = dockShortcutGuide.innerText;
      window.resetShortcut('toggleDock');
      const resetDockShortcut = dockShortcutInput.value;
      const resetDockGuide = dockShortcutGuide.innerText;
      const idleEventHandled = window.settingsShortcuts.handleKeyDown(
        new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', cancelable: true })
      );

      let menuRefreshCount = 0;
      window.refreshIcons = () => menuRefreshCount++;
      window.settingsMenuManagement.render([
        { id: 'gallery-btn', category: 'information', label: '갤러리', icon: 'image', color: 'blue-400' },
        { id: 'buffs-btn', category: 'information', label: '버프 도감', image: 'assets/items/buff.png' },
        { id: 'system-btn', category: 'information', label: '시스템', icon: 'lock', isSystem: true },
        { category: 'information', label: '주석', isComment: true }
      ], { visibleMenuIds: ['gallery-btn'] });
      const legacyMenuState = Array.from(menuGrid.querySelectorAll('input')).map(input => ({
        value: input.value,
        checked: input.checked
      }));
      const legacyHiddenMenuIds = window.settingsMenuManagement.collectHiddenMenuIds();
      window.settingsMenuManagement.applyConfig({ hiddenMenuIds: ['gallery-btn'] });
      const currentMenuState = Array.from(menuGrid.querySelectorAll('input')).map(input => ({
        value: input.value,
        checked: input.checked
      }));

      let soundListLoadCount = 0;
      window.loadSoundList = async () => {
        soundListLoadCount++;
        return [
          { file: 'bad"><img id="injected-sound-option-file">.mp3', name: '<img id="injected-sound-option-name">악성 알림음' },
          { file: 'orb.mp3', name: '기본 구슬음' },
          { file: 'echo.mp3', name: '에코스' },
          { file: 'start.mp3', name: '시작' },
          { file: 'end.mp3', name: '종료' },
          { file: 'lokagos.mp3', name: '로카고스' }
        ];
      };
      await window.settingsAudioControls.initializeAlertSoundSelects();
      window.settingsAudioControls.applyAlertSoundConfig({
        waveMonsterWarningSound: 'orb.mp3',
        ethosAlertSound: 'echo.mp3',
        abyssApostleStartSound: 'start.mp3',
        abyssApostleEndSound: 'end.mp3',
        lokagosAlertSound: 'lokagos.mp3',
        questCompleteAlertSound: 'start.mp3',
        abyssTreasureAlertSound: 'end.mp3'
      });
      const configuredAlertSounds = Object.fromEntries(
        Object.entries(alertSoundSelects).map(([key, select]) => [key, select.value])
      );
      const waveOptionLabels = Array.from(alertSoundSelects.wave.options).map(option => option.textContent);
      const maliciousSoundOption = Array.from(alertSoundSelects.wave.options)
        .find(option => option.textContent.includes('악성 알림음'));
      const soundOptionSafety = {
        value: maliciousSoundOption?.value,
        label: maliciousSoundOption?.textContent,
        injectedCount: document.querySelectorAll(
          '#injected-sound-option-file, #injected-sound-option-name'
        ).length
      };
      await window.settingsAudioControls.refreshAlertSoundSelects();
      const waveSoundAfterRefresh = alertSoundSelects.wave.value;

      const volumeSlider = addInput('volume-contents-checker');
      const volumeLabel = document.createElement('span');
      volumeLabel.id = 'volume-contents-checker-val';
      document.body.appendChild(volumeLabel);
      const muteButton = document.createElement('button');
      muteButton.id = 'mute-contents-checker';
      document.body.appendChild(muteButton);
      let audioRefreshCount = 0;
      window.refreshIcons = () => audioRefreshCount++;
      window.settingsAudioControls.bindVolumeControl('contents-checker', 35);
      const initialVolume = { value: volumeSlider.value, label: volumeLabel.innerText };
      volumeSlider.value = '22';
      volumeSlider.dispatchEvent(new Event('input'));
      window.toggleMute('contents-checker');
      const mutedVolume = {
        value: volumeSlider.value,
        label: volumeLabel.innerText,
        buttonText: muteButton.textContent.trim(),
        hasMutedStyle: muteButton.classList.contains('text-red-400')
      };
      window.settingsAudioControls.toggleMute('contents-checker');
      const restoredVolume = {
        value: volumeSlider.value,
        label: volumeLabel.innerText,
        buttonText: muteButton.textContent.trim(),
        hasNormalStyle: muteButton.classList.contains('text-slate-400')
      };

      const addLabel = id => {
        const label = document.createElement('span');
        label.id = id;
        document.body.appendChild(label);
        return label;
      };
      const homeUrlInput = addInput('home-url-input');
      const widthInput = addInput('width-input');
      const autoUpdateInput = addInput('auto-update-input');
      const reminderInput = addInput('game-exit-reminder-input');
      const diaryKeepDaysInput = addInput('diary-keep-days-input');
      window.settingsConfigBinding.applyGeneralSettings({
        homeUrl: 'https://example.test',
        width: 0,
        autoUpdateEnabled: false,
        gameExitReminderEnabled: true,
        diaryKeepDays: 90
      }, window.electronAPI.DEFAULT_CONFIG);
      const generalBinding = {
        homeUrl: homeUrlInput.value,
        width: widthInput.value,
        autoUpdate: autoUpdateInput.checked,
        reminder: reminderInput.checked,
        diaryKeepDays: diaryKeepDaysInput.value
      };

      const chatLogPathInput = addInput('chat-log-path-input');
      const ethosEnabledInput = addInput('ethos-alert-enabled');
      const ethosVolumeInput = addInput('ethos-alert-volume');
      const notifyClosedInput = addInput('notify-when-game-closed-input');
      const ethosVolumeLabel = addLabel('ethos-alert-volume-val');
      const waveVolumeLabel = addLabel('wave-warning-volume-val');
      const questCompleteVolumeLabel = addLabel('quest-complete-alert-volume-val');
      const abyssTreasureVolumeLabel = addLabel('abyss-treasure-alert-volume-val');
      const fontSizeInput = addInput('chat-overlay-fontsize-input');
      const fontSizeLabel = addLabel('chat-overlay-fontsize-val');
      const opacityLabel = addLabel('chat-overlay-opacity-val');
      window.settingsConfigBinding.applyChatAndAlertSettings({
        chatLogPath: 'C:/TalesWeaver/ChatLog',
        ethosAlertEnabled: true,
        ethosAlertSound: 'echo.mp3',
        ethosAlertVolume: 33,
        notifyWhenGameClosed: true,
        waveMonsterWarningEnabled: true,
        waveMonsterWarningSound: 'orb.mp3',
        waveMonsterWarningVolume: 77,
        questCompleteAlertEnabled: false,
        questCompleteAlertSound: 'start.mp3',
        questCompleteAlertVolume: 35,
        abyssTreasureAlertEnabled: true,
        abyssTreasureAlertSound: 'end.mp3',
        abyssTreasureAlertVolume: 36,
        userServer: 3,
        chatOverlayFontSize: 18,
        chatOverlayOpacity: 0.55,
        chatOverlayWidth: 620
      }, window.electronAPI.DEFAULT_CONFIG);
      const initialRangeLabels = {
        ethos: ethosVolumeLabel.innerText,
        wave: waveVolumeLabel.innerText,
        questComplete: questCompleteVolumeLabel.innerText,
        abyssTreasure: abyssTreasureVolumeLabel.innerText,
        fontSize: fontSizeLabel.innerText,
        opacity: opacityLabel.innerText
      };
      document.getElementById('wave-warning-volume').value = '66';
      document.getElementById('wave-warning-volume').dispatchEvent(new Event('input'));
      document.getElementById('chat-overlay-opacity-input').value = '0.42';
      document.getElementById('chat-overlay-opacity-input').dispatchEvent(new Event('input'));
      const chatAndAlertBinding = {
        chatLogPath: chatLogPathInput.value,
        ethosEnabled: ethosEnabledInput.checked,
        notifyWhenGameClosed: notifyClosedInput.checked,
        ethosSound: alertSoundSelects.ethos.value,
        ethosVolume: ethosVolumeInput.value,
        waveEnabled: document.getElementById('wave-warning-enabled').checked,
        waveSound: alertSoundSelects.wave.value,
        questCompleteEnabled: document.getElementById('quest-complete-alert-enabled').checked,
        questCompleteSound: alertSoundSelects.questComplete.value,
        questCompleteVolume: document.getElementById('quest-complete-alert-volume').value,
        abyssTreasureEnabled: document.getElementById('abyss-treasure-alert-enabled').checked,
        abyssTreasureSound: alertSoundSelects.abyssTreasure.value,
        abyssTreasureVolume: document.getElementById('abyss-treasure-alert-volume').value,
        userServer: document.getElementById('chat-overlay-user-server-input').value,
        fontSize: fontSizeInput.value,
        overlayWidth: document.getElementById('chat-overlay-width-input').value,
        initialRangeLabels,
        updatedWaveLabel: waveVolumeLabel.innerText,
        updatedOpacityLabel: opacityLabel.innerText
      };
      window.settingsConfigBinding.trackChatOverlaySizeInputs();
      window.settingsConfigBinding.refreshUntouchedChatOverlaySizes({
        chatOverlayWidth: 700,
        chatOverlayHeight: 500,
        chatOverlaySubWidth: 460,
        chatOverlaySubHeight: 410,
        chatOverlaySub2Width: 470,
        chatOverlaySub2Height: 420
      });
      const refreshedUntouchedWidth = document.getElementById('chat-overlay-width-input').value;
      const refreshedUntouchedHeight = document.getElementById('chat-overlay-height-input').value;
      document.getElementById('chat-overlay-width-input').value = '777';
      document.getElementById('chat-overlay-width-input').dispatchEvent(new Event('input'));
      window.settingsConfigBinding.refreshUntouchedChatOverlaySizes({
        chatOverlayWidth: 888,
        chatOverlayHeight: 555
      });
      const liveSizeRefresh = {
        untouchedWidth: refreshedUntouchedWidth,
        untouchedHeight: refreshedUntouchedHeight,
        editedWidth: document.getElementById('chat-overlay-width-input').value,
        latestUntouchedHeight: document.getElementById('chat-overlay-height-input').value
      };

      addInput('chat-overlay-channel-team');
      addInput('chat-overlay-channel-club');
      addInput('chat-overlay-channel-shout');
      addInput('chat-overlay-channel-system');
      const xpGainInput = addInput('chat-overlay-show-xp-gain');
      const nicknameModeInput = addSelect('chat-overlay-nickname-color-mode-input');
      nicknameModeInput.innerHTML = '<option value="same">same</option><option value="custom">custom</option>';
      const forgeLeftInput = addInput('forge-hud-pos-left');
      const forgeBottomInput = addInput('forge-hud-pos-bottom');
      const digsiteHudInput = addInput('digsite-hud-enabled-input');
      window.settingsConfigBinding.applyOverlayDisplayOptions({
        chatOverlaySelectedChannels: ['whisper'],
        chatOverlayVisibleTabs: ['General', 'Team', 'Club', 'Shout'],
        chatOverlayShowNpcChat: false,
        chatOverlayNicknameColorMode: 'custom',
        forgeQuestHudPos: { left: 24, bottom: 36 },
        digsiteHudEnabled: false
      }, window.electronAPI.DEFAULT_CONFIG);

      const tradeDefaultRadio = addInput('trade-default');
      tradeDefaultRadio.type = 'radio';
      tradeDefaultRadio.name = 'trade-server';
      tradeDefaultRadio.value = 'RyXp';
      const tradeSelectedRadio = addInput('trade-selected');
      tradeSelectedRadio.type = 'radio';
      tradeSelectedRadio.name = 'trade-server';
      tradeSelectedRadio.value = 'TestServer';
      const sidebarRightRadio = addInput('sidebar-right');
      sidebarRightRadio.type = 'radio';
      sidebarRightRadio.name = 'sidebar-position';
      sidebarRightRadio.value = 'right';
      const sidebarLeftRadio = addInput('sidebar-left');
      sidebarLeftRadio.type = 'radio';
      sidebarLeftRadio.name = 'sidebar-position';
      sidebarLeftRadio.value = 'left';
      const sidebarToastInput = addInput('show-sidebar-toast-on-overlay-input');
      window.settingsConfigBinding.applyRadioSettings({
        tradeServer: 'TestServer',
        sidebarPosition: 'left',
        showSidebarToastOnOverlay: true
      }, window.electronAPI.DEFAULT_CONFIG);
      const overlayAndRadioBinding = {
        generalChannel: document.getElementById('chat-overlay-channel-general').checked,
        whisperChannel: document.getElementById('chat-overlay-channel-whisper').checked,
        visibleTabs: ['Basic', 'General', 'Whisper', 'Team', 'Club', 'Shout', 'System']
          .filter(tab => document.getElementById('chat-overlay-visible-tab-' + tab).checked),
        showNpc: document.getElementById('chat-overlay-show-npc-chat').checked,
        showXp: xpGainInput.checked,
        nicknameMode: nicknameModeInput.value,
        forgeLeft: forgeLeftInput.value,
        forgeBottom: forgeBottomInput.value,
        digsiteHud: digsiteHudInput.checked,
        tradeServer: document.querySelector('input[name="trade-server"]:checked')?.value,
        sidebarPosition: document.querySelector('input[name="sidebar-position"]:checked')?.value,
        showSidebarToast: sidebarToastInput.checked
      };

      const toastInteractionCounts = [];
      const toastRegistry = window.createInteractiveToastRegistry(count => toastInteractionCounts.push(count));
      toastRegistry.add('boss-toast');
      toastRegistry.add('scam-toast');
      toastRegistry.remove('boss-toast');
      toastRegistry.remove('boss-toast');
      toastRegistry.remove('scam-toast');

      const originalWindowClose = window.close;
      let escapeCloseCount = 0;
      window.close = () => { escapeCloseCount++; };
      window.bindEscapeClose();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      await Promise.resolve();
      const unhandledEscapeCloseCount = escapeCloseCount;
      const preventEscapeClose = event => {
        if (event.key === 'Escape') event.preventDefault();
      };
      window.addEventListener('keydown', preventEscapeClose);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      await Promise.resolve();
      window.removeEventListener('keydown', preventEscapeClose);
      const preventedEscapeCloseCount = escapeCloseCount;
      window.close = originalWindowClose;

      return {
        alertShown: alert.classList.contains('show'),
        contentCompleteAlert: {
          shown: questAlert.classList.contains('show'),
          title: questTitle.textContent,
          badge: questBadge.textContent,
          icon: questIcon.getAttribute('data-lucide')
        },
        keywordText: tag.firstChild?.textContent,
        removeCount,
        soundName: soundRow.querySelector('input')?.value,
        injectedCount: document.querySelectorAll('#injected-keyword, #injected-sound').length,
        overlaySettings: {
          width: overlaySettings.chatOverlayWidth,
          height: overlaySettings.chatOverlayHeight,
          opacity: overlaySettings.chatOverlayOpacity,
          color: overlaySettings.chatOverlayColorGeneral,
          channels: overlaySettings.chatOverlaySelectedChannels,
          visibleTabs: overlaySettings.chatOverlayVisibleTabs,
          showNpc: overlaySettings.chatOverlayShowNpcChat,
          blacklistFilters: overlaySettings.chatOverlayBlacklistFilters,
          userServer: overlaySettings.userServer,
        },
        alertSettings: {
          lootKeywordsSame: alertSettings.lootKeywords === lootKeywords,
          shoutKeywordsSame: alertSettings.shoutKeywords === shoutKeywords,
          waveEnabled: alertSettings.waveMonsterWarningEnabled,
          waveSound: alertSettings.waveMonsterWarningSound,
          waveVolume: alertSettings.waveMonsterWarningVolume,
          ethosVolume: alertSettings.ethosAlertVolume,
          specialMonsterEnabled: alertSettings.specialMonsterAlertEnabled,
          abandonedEnabled: alertSettings.abandonedAlertEnabled,
          pittaHillEnabled: alertSettings.pittaHillAlertEnabled,
          questCompleteEnabled: alertSettings.questCompleteAlertEnabled,
          questCompleteSound: alertSettings.questCompleteAlertSound,
          questCompleteVolume: alertSettings.questCompleteAlertVolume,
          abyssTreasureEnabled: alertSettings.abyssTreasureAlertEnabled,
          abyssTreasureSound: alertSettings.abyssTreasureAlertSound,
          abyssTreasureVolume: alertSettings.abyssTreasureAlertVolume,
        },
        todaySummarySettings: {
          showTodaySummaryHud: todaySummarySettings.showTodaySummaryHud,
          todaySummaryCollapsed: todaySummarySettings.todaySummaryCollapsed,
          todaySummaryHudPos: todaySummarySettings.todaySummaryHudPos,
        },
        shortcuts: {
          mergedDockShortcut,
          mergedDockGuide,
          modifierHandled: modifierEvent.defaultPrevented,
          modifierPrevented: modifierEvent.defaultPrevented,
          remainedRecordingAfterModifier,
          numpadHandled: numpadEvent.defaultPrevented,
          numpadPrevented: numpadEvent.defaultPrevented,
          recordedDockShortcut,
          recordedDockInput,
          guideAfterRecording,
          resetDockShortcut,
          resetDockGuide,
          defaultClickThrough: clickThroughShortcutInput.value,
          idleEventHandled,
          shortcutUnregisterCount,
          shortcutRegisterCount
        },
        menuManagement: {
          sectionCount: menuGrid.children.length,
          headerText: menuGrid.querySelector('.border-b span')?.textContent,
          legacyMenuState,
          legacyHiddenMenuIds,
          currentMenuState,
          imageSource: menuGrid.querySelector('img')?.getAttribute('src'),
          menuRefreshCount
        },
        audioControls: {
          configuredAlertSounds,
          waveOptionLabels,
          soundOptionSafety,
          waveSoundAfterRefresh,
          soundListLoadCount,
          initialVolume,
          mutedVolume,
          restoredVolume,
          audioRefreshCount
        },
        configBinding: {
          generalBinding,
          chatAndAlertBinding,
          overlayAndRadioBinding,
          liveSizeRefresh
        },
        toastRegistry: {
          counts: toastInteractionCounts,
          finalCount: toastRegistry.count()
        },
        escapeClose: {
          unhandledEscapeCloseCount,
          preventedEscapeCloseCount
        }
      };
    })()
  `) as {
    alertShown: boolean;
    contentCompleteAlert: { shown: boolean; title: string; badge: string; icon: string };
    keywordText: string;
    removeCount: number;
    soundName: string;
    injectedCount: number;
    overlaySettings: Record<string, unknown>;
    alertSettings: Record<string, unknown>;
    todaySummarySettings: Record<string, unknown>;
    shortcuts: Record<string, unknown>;
    menuManagement: Record<string, unknown>;
    audioControls: Record<string, unknown>;
    configBinding: Record<string, unknown>;
    toastRegistry: { counts: number[]; finalCount: number };
    escapeClose: { unhandledEscapeCloseCount: number; preventedEscapeCloseCount: number };
  };

  assert.equal(result.alertShown, true);
  assert.deepEqual(result.contentCompleteAlert, {
    shown: true,
    title: '심연의 보물창고 완료',
    badge: '3분 후 보물창고 밖으로 이동합니다',
    icon: 'gem',
  });
  assert.equal(result.keywordText, '<img id="injected-keyword">키워드 ');
  assert.equal(result.removeCount, 1);
  assert.equal(result.soundName, '<img id="injected-sound">알림음');
  assert.equal(result.injectedCount, 0);
  assert.deepEqual(result.toastRegistry, {
    counts: [1, 2, 1, 0],
    finalCount: 0,
  }, '동시 토스트 중 하나만 종료했을 때 click-through 참조가 조기 해제됩니다.');
  assert.deepEqual(result.escapeClose, {
    unhandledEscapeCloseCount: 1,
    preventedEscapeCloseCount: 1,
  }, '화면이 처리한 Escape까지 공통 닫기 동작으로 이어집니다.');
  assert.deepEqual(result.overlaySettings, {
    width: 512,
    height: 400,
    opacity: 0.75,
    color: '#123456',
    channels: ['general'],
    visibleTabs: ['General', 'Team', 'Club', 'Shout'],
    showNpc: false,
    blacklistFilters: ['필터테스트123'],
    userServer: 2,
  });
  assert.deepEqual(result.alertSettings, {
    lootKeywordsSame: true,
    shoutKeywordsSame: true,
    waveEnabled: true,
    waveSound: 'orb.mp3',
    waveVolume: 65,
    ethosVolume: 40,
    specialMonsterEnabled: true,
    abandonedEnabled: true,
    pittaHillEnabled: false,
    questCompleteEnabled: true,
    questCompleteSound: 'start.mp3',
    questCompleteVolume: 32,
    abyssTreasureEnabled: false,
    abyssTreasureSound: 'end.mp3',
    abyssTreasureVolume: 33,
  });
  assert.deepEqual(result.todaySummarySettings, {
    showTodaySummaryHud: false,
    todaySummaryCollapsed: true,
    todaySummaryHudPos: { left: 315, top: 140 },
  });
  assert.deepEqual(result.shortcuts, {
    mergedDockShortcut: 'Alt+F5',
    mergedDockGuide: 'Alt+F5',
    modifierHandled: true,
    modifierPrevented: true,
    remainedRecordingAfterModifier: true,
    numpadHandled: true,
    numpadPrevented: true,
    recordedDockShortcut: 'CommandOrControl+numadd',
    recordedDockInput: 'Ctrl+numadd',
    guideAfterRecording: 'Alt+F5',
    resetDockShortcut: 'Ctrl+Shift+D',
    resetDockGuide: 'Ctrl+Shift+D',
    defaultClickThrough: 'Ctrl+Shift+T',
    idleEventHandled: false,
    shortcutUnregisterCount: 1,
    shortcutRegisterCount: 1,
  });
  assert.deepEqual(result.menuManagement, {
    sectionCount: 1,
    headerText: '정보 & 도감',
    legacyMenuState: [
      { value: 'gallery-btn', checked: true },
      { value: 'buffs-btn', checked: false },
    ],
    legacyHiddenMenuIds: ['buffs-btn'],
    currentMenuState: [
      { value: 'gallery-btn', checked: false },
      { value: 'buffs-btn', checked: true },
    ],
    imageSource: 'assets/items/buff.png',
    menuRefreshCount: 1,
  });
  assert.deepEqual(result.audioControls, {
    configuredAlertSounds: {
      wave: 'orb.mp3',
      ethos: 'echo.mp3',
      abyssStart: 'start.mp3',
      abyssEnd: 'end.mp3',
      lokagos: 'lokagos.mp3',
      questComplete: 'start.mp3',
      abyssTreasure: 'end.mp3',
    },
    waveOptionLabels: [
      '사용 안 함 (소리 없음)',
      '<img id="injected-sound-option-name">악성 알림음',
      '기본 구슬음',
      '에코스',
      '시작',
      '종료',
      '로카고스',
    ],
    soundOptionSafety: {
      value: 'bad"><img id="injected-sound-option-file">.mp3',
      label: '<img id="injected-sound-option-name">악성 알림음',
      injectedCount: 0,
    },
    waveSoundAfterRefresh: 'orb.mp3',
    soundListLoadCount: 2,
    initialVolume: { value: '35', label: '35%' },
    mutedVolume: {
      value: '0',
      label: '0%',
      buttonText: '음소거 해제',
      hasMutedStyle: true,
    },
    restoredVolume: {
      value: '22',
      label: '22%',
      buttonText: '음소거',
      hasNormalStyle: true,
    },
    audioRefreshCount: 4,
  });
  assert.deepEqual(result.configBinding, {
    generalBinding: {
      homeUrl: 'https://example.test',
      width: '800',
      autoUpdate: false,
      reminder: true,
      diaryKeepDays: '90',
    },
    chatAndAlertBinding: {
      chatLogPath: 'C:/TalesWeaver/ChatLog',
      ethosEnabled: true,
      notifyWhenGameClosed: true,
      ethosSound: 'echo.mp3',
      ethosVolume: '33',
      waveEnabled: true,
      waveSound: 'orb.mp3',
      questCompleteEnabled: false,
      questCompleteSound: 'start.mp3',
      questCompleteVolume: '35',
      abyssTreasureEnabled: true,
      abyssTreasureSound: 'end.mp3',
      abyssTreasureVolume: '36',
      userServer: '3',
      fontSize: '18',
      overlayWidth: '620',
      initialRangeLabels: {
        ethos: '33%',
        wave: '77%',
        questComplete: '35%',
        abyssTreasure: '36%',
        fontSize: '18px',
        opacity: '55%',
      },
      updatedWaveLabel: '66%',
      updatedOpacityLabel: '42%',
    },
    overlayAndRadioBinding: {
      generalChannel: false,
      whisperChannel: true,
      visibleTabs: ['General', 'Team', 'Club', 'Shout'],
      showNpc: false,
      showXp: false,
      nicknameMode: 'custom',
      forgeLeft: '24',
      forgeBottom: '36',
      digsiteHud: false,
      tradeServer: 'TestServer',
      sidebarPosition: 'left',
      showSidebarToast: true,
    },
    liveSizeRefresh: {
      untouchedWidth: '700',
      untouchedHeight: '500',
      editedWidth: '777',
      latestUntouchedHeight: '555',
    },
  });
}

async function checkCoefficientDropdown(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'coefficient-calculator.html'));
  await waitForSelector(window, '.custom-dropdown-menu');
  window.setContentSize(816, 424);
  await new Promise(resolve => setTimeout(resolve, 50));

  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const menu = document.querySelector('.custom-dropdown-menu');
      const trigger = document.querySelector('.custom-dropdown-trigger');
      const initiallyHidden = menu.classList.contains('hidden')
        && getComputedStyle(menu).display === 'none';
      trigger.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const opened = !menu.classList.contains('hidden')
        && getComputedStyle(menu).display !== 'none';
      document.body.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const closed = menu.classList.contains('hidden')
        && getComputedStyle(menu).display === 'none';

      // 주스탯 표시는 계산에 실제 사용하는 캐릭터 / 장비 합계를 같은 순서로 보여야 한다.
      document.querySelectorAll('input[type="number"]').forEach(input => { input.value = '0'; });
      document.querySelectorAll('select[id^="gear-"]').forEach(select => { select.value = ''; });
      document.querySelector('#stat-stab').value = '1234';
      document.querySelector('#bonus-cuff-main').value = '200';
      document.querySelector('#bonus-core-eclipse').value = '300';
      document.querySelector('#main-core-select').value = 'eclipse';
      document.querySelector('#buff-preset-select').value = 'none';
      document.querySelector('#stat-stab').dispatchEvent(new Event('input', { bubbles: true }));

      const tablePane = document.querySelector('.calculator-table-pane');
      const guidePane = document.querySelector('.calculator-guide-pane');
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      return {
        initiallyHidden,
        opened,
        closed,
        mainStat: {
          label: document.querySelector('#character-main-stat-display')?.parentElement?.previousElementSibling?.textContent?.replace(/\s+/g, ' ').trim(),
          character: document.querySelector('#character-main-stat-display')?.textContent,
          equipment: document.querySelector('#equipment-main-stat-display')?.textContent,
          tooltip: document.querySelector('#character-main-stat-display')?.closest('[title]')?.getAttribute('title'),
        },
        layout: {
          innerWidth: window.innerWidth,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          mainDirection: getComputedStyle(document.querySelector('.calculator-main')).flexDirection,
          bodyOverflowY: getComputedStyle(document.body).overflowY,
          tableOverflowX: getComputedStyle(tablePane).overflowX,
          guideWidth: guidePane.getBoundingClientRect().width,
          guideBelowTable: guidePane.getBoundingClientRect().top >= tablePane.getBoundingClientRect().bottom - 1,
          scrollY: window.scrollY,
        },
      };
    })()
  `) as {
    initiallyHidden: boolean;
    opened: boolean;
    closed: boolean;
    mainStat: {
      label?: string;
      character?: string;
      equipment?: string;
      tooltip?: string;
    };
    layout: {
      innerWidth: number;
      documentClientWidth: number;
      documentScrollWidth: number;
      mainDirection: string;
      bodyOverflowY: string;
      tableOverflowX: string;
      guideWidth: number;
      guideBelowTable: boolean;
      scrollY: number;
    };
  };

  assert.deepEqual({
    initiallyHidden: result.initiallyHidden,
    opened: result.opened,
    closed: result.closed,
  }, { initiallyHidden: true, opened: true, closed: true });
  assert.deepEqual(result.mainStat, {
    label: '주스탯 (캐릭터 / 장비)',
    character: '1,234',
    equipment: '515',
    tooltip: '캐릭터 주스탯 / 장비 주스탯',
  }, '계수 계산기의 주스탯 캐릭터/장비 합계가 잘못 표시됩니다.');
  assert.ok(result.layout.innerWidth <= 816,
    `소형 계수 계산기 회귀 창이 축소되지 않았습니다: ${result.layout.innerWidth}px`);
  assert.equal(result.layout.documentScrollWidth, result.layout.documentClientWidth,
    '소형 계수 계산기에서 문서 전체가 가로로 잘립니다.');
  assert.equal(result.layout.mainDirection, 'column');
  assert.equal(result.layout.bodyOverflowY, 'auto');
  assert.equal(result.layout.tableOverflowX, 'auto');
  assert.ok(result.layout.guideWidth <= result.layout.documentClientWidth,
    '소형 계수 계산기의 콘텐츠 가이드가 작업영역 폭을 넘습니다.');
  assert.equal(result.layout.guideBelowTable, true,
    '소형 계수 계산기의 콘텐츠 가이드가 테이블 아래로 재배치되지 않았습니다.');
  assert.ok(result.layout.scrollY > 0,
    '소형 계수 계산기의 세로 문서를 실제로 스크롤할 수 없습니다.');
  window.setContentSize(1100, 720);
  await new Promise(resolve => setTimeout(resolve, 50));
  const standardLayout = await window.webContents.executeJavaScript(`({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    mainDirection: getComputedStyle(document.querySelector('.calculator-main')).flexDirection,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    guideWidth: document.querySelector('.calculator-guide-pane').getBoundingClientRect().width,
  })`) as {
    documentClientWidth: number;
    documentScrollWidth: number;
    mainDirection: string;
    bodyOverflowY: string;
    guideWidth: number;
  };
  assert.deepEqual(standardLayout, {
    documentClientWidth: 1100,
    documentScrollWidth: 1100,
    mainDirection: 'row',
    bodyOverflowY: 'hidden',
    guideWidth: 360,
  }, '일반 폭 계수 계산기의 기존 2열 레이아웃이 바뀌었습니다.');

  window.setContentSize(1420, 860);
  await new Promise(resolve => setTimeout(resolve, 50));
  const defaultResultLayout = await window.webContents.executeJavaScript(`(() => {
    const coefficient = document.querySelector('#total-coefficient').closest('[class*="bg-indigo"]');
    const mainStat = document.querySelector('#character-main-stat-display').closest('[title]');
    const hit = document.querySelector('#total-hit-display').parentElement;
    const coefficientRect = coefficient.getBoundingClientRect();
    const mainStatRect = mainStat.getBoundingClientRect();
    const hitRect = hit.getBoundingClientRect();
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      statBarHeight: document.querySelector('.calculator-stat-bar').getBoundingClientRect().height,
      orderedWithoutOverlap: coefficientRect.right <= mainStatRect.left
        && mainStatRect.right <= hitRect.left,
      alignedInOneRow: Math.abs((coefficientRect.top + coefficientRect.height / 2)
        - (mainStatRect.top + mainStatRect.height / 2)) < 1
        && Math.abs((mainStatRect.top + mainStatRect.height / 2)
          - (hitRect.top + hitRect.height / 2)) < 1,
    };
  })()`) as {
    documentClientWidth: number;
    documentScrollWidth: number;
    statBarHeight: number;
    orderedWithoutOverlap: boolean;
    alignedInOneRow: boolean;
  };
  assert.deepEqual(defaultResultLayout, {
    documentClientWidth: 1420,
    documentScrollWidth: 1420,
    statBarHeight: 50,
    orderedWithoutOverlap: true,
    alignedInOneRow: true,
  }, '기본 폭에서 총합 계수 / 주스탯 / 명중 결과 카드 배치가 잘못됐습니다.');
}

async function checkFocusedChat(window: BrowserWindow): Promise<void> {
  const html = fs.readFileSync(path.join(projectRoot, 'dist', 'focused-chat.html'), 'utf8')
    .replace('<script src="shared/chatChannels.js"></script>', '')
    .replace('<script src="focusedChatRenderer.js"></script>', '');
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const rendererCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'focusedChatRenderer.js'),
    'utf8',
  );
  const chatChannelsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'chatChannels.js'),
    'utf8',
  );
  const target = '친구"><img id="injected-focused-target">';
  const initialState = {
    selfNickname: '내캐릭터',
    targets: [target],
    knownNicknames: ['내캐릭터', target, '자동완성친구']
  };
  const initialHistory = [
    { id: 'remote', type: 'general', timestamp: '오후 3시 04분', sender: target, message: '<img id="injected-focused-message">안녕', color: '#ffffff', level: 310, characterCode: null },
    { id: 'self', type: 'club', timestamp: '오후 3시 05분', sender: '내캐릭터', message: '반가워', color: '#94ddfa', level: null, characterCode: null },
    { id: 'other', type: 'general', timestamp: '오후 3시 06분', sender: '다른사람', message: '제외', color: '#ffffff', level: null, characterCode: null },
    { id: 'system', type: 'system', timestamp: '오후 3시 07분', sender: '시스템', message: '제외', color: '#a8a8a8', level: null, characterCode: null },
  ];

  const script = `
    (() => {
      try {
      window.lucide = { createIcons() {} };
      window.__focusedSavedTargets = [];
      window.__focusedSavedSelf = [];
      window.__focusedResizeCalls = [];
      window.electronAPI = {
        getFocusedChatState: async () => (${JSON.stringify(initialState)}),
        getFocusedChatHistory: async () => ${JSON.stringify(initialHistory)},
        setFocusedChatSelfNickname: value => window.__focusedSavedSelf.push(value),
        setFocusedChatTargets: value => window.__focusedSavedTargets.push(value),
        setFocusedChatSize: (width, height) => window.__focusedResizeCalls.push([width, height]),
        onChatUpdated: callback => { window.__focusedChatCallback = callback; },
        onChatHistoryCleared: callback => { window.__focusedClearCallback = callback; },
        cleanupAllListeners() {}
      };
      eval(${JSON.stringify(`${chatChannelsCode}\n${rendererCode}`)});
      return { ok: true };
      } catch (error) {
        return { ok: false, error: error && (error.stack || error.message || String(error)) };
      }
    })()
  `;
  const setupResult = await window.webContents.executeJavaScript(script) as { ok: boolean; error?: string };
  assert.equal(setupResult.ok, true, setupResult.error);
  await waitForSelector(window, '.message-row.self');

  const result = await window.webContents.executeJavaScript(`
    (() => {
      const selfInput = document.getElementById('selfNicknameInput');
      selfInput.focus();
      selfInput.value = '자동';
      selfInput.dispatchEvent(new Event('input', { bubbles: true }));
      selfInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const activeOption = document.querySelector('#selfNicknameSuggestions .autocomplete-option.active');
      const keyboardSelection = {
        text: activeOption?.textContent,
        background: activeOption ? getComputedStyle(activeOption).backgroundColor : ''
      };
      selfInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const keyboardSelectedValue = selfInput.value;
      selfInput.value = '내캐릭터';
      document.getElementById('selfForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const directInput = document.getElementById('nicknameInput');
      directInput.value = '직접입력친구';
      document.getElementById('targetForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const expectedResize = [Math.max(360, window.outerWidth + 40), Math.max(360, window.outerHeight + 50)];
      document.getElementById('resizeHandle').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, screenX: 100, screenY: 100 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 140, screenY: 150 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, screenX: 140, screenY: 150 }));
      const panelToggle = document.getElementById('panelToggleButton');
      panelToggle.click();
      const collapsedPanel = {
        hidden: getComputedStyle(document.getElementById('nicknameSettingsPanel')).display === 'none',
        expanded: panelToggle.getAttribute('aria-expanded'),
        label: panelToggle.getAttribute('aria-label')
      };
      panelToggle.click();
      return {
      messages: Array.from(document.querySelectorAll('.bubble')).map(node => node.textContent),
      senders: Array.from(document.querySelectorAll('.sender')).map(node => node.textContent),
      selfCount: document.querySelectorAll('.message-row.self').length,
      injectedCount: document.querySelectorAll('#injected-focused-target, #injected-focused-message').length,
      status: document.getElementById('roomStatus')?.textContent,
      selfNickname: document.getElementById('selfNicknameInput')?.value,
      suggestions: Array.from(document.querySelectorAll('#targetNicknameSuggestions .autocomplete-option')).map(option => option.textContent),
      savedTargets: window.__focusedSavedTargets,
      savedSelf: window.__focusedSavedSelf,
      etaBadges: Array.from(document.querySelectorAll('.eta-badge')).map(node => node.textContent),
      resizeCalls: window.__focusedResizeCalls,
      expectedResize,
      collapsedPanel,
      keyboardSelection,
      keyboardSelectedValue,
      windowBounds: (() => {
        const rect = document.querySelector('.chat-window').getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          rightGap: window.innerWidth - rect.right,
          bottomGap: window.innerHeight - rect.bottom
        };
      })()
      };
    })()
  `) as {
    messages: string[];
    senders: string[];
    selfCount: number;
    injectedCount: number;
    status: string;
    selfNickname: string;
    suggestions: string[];
    savedTargets: string[][];
    savedSelf: string[];
    etaBadges: string[];
    resizeCalls: number[][];
    expectedResize: number[];
    collapsedPanel: { hidden: boolean; expanded: string | null; label: string | null };
    keyboardSelection: { text?: string; background: string };
    keyboardSelectedValue: string;
    windowBounds: { left: number; top: number; rightGap: number; bottomGap: number };
  };

  assert.deepEqual(result.messages, ['<img id="injected-focused-message">안녕', '반가워']);
  assert.deepEqual(result.senders, [target, '내캐릭터']);
  assert.equal(result.selfCount, 1);
  assert.equal(result.injectedCount, 0);
  assert.equal(result.status, '내캐릭터 기준 · 상대 2명');
  assert.equal(result.selfNickname, '내캐릭터');
  assert.ok(result.suggestions.includes('자동완성친구'));
  assert.deepEqual(result.savedTargets.at(-1), [target, '직접입력친구']);
  assert.deepEqual(result.savedSelf, ['내캐릭터']);
  assert.deepEqual(result.etaBadges, ['에타 310']);
  assert.deepEqual(result.resizeCalls.at(-1), result.expectedResize);
  assert.deepEqual(result.collapsedPanel, {
    hidden: true,
    expanded: 'false',
    label: '닉네임 설정 펼치기'
  });
  assert.deepEqual(result.keyboardSelection, {
    text: '자동완성친구',
    background: 'rgb(124, 58, 237)'
  });
  assert.equal(result.keyboardSelectedValue, '자동완성친구');
  assert.deepEqual(result.windowBounds, { left: 0, top: 0, rightGap: 0, bottomGap: 0 });
}

/** 실제 preload/IPC와 임시 config 파일을 연결해 표시 설정 변경이 대화 이력을 소모하지 않는지 확인한다. */
async function checkFocusedChatSettings(): Promise<void> {
  const config = require(path.join(projectRoot, 'dist/modules/config.js'));
  const defaults = require(path.join(projectRoot, 'dist/modules/constants.js')).DEFAULT_CONFIG;
  const nicknameNotes = require(path.join(projectRoot, 'dist/shared/nicknameNotes.js'));
  const original = config.load();
  const message = (n: number, sender = '친구', type = 'general') => ({ id: `focused-${n}`, type, sender,
    message: `읽던 대화 ${n}`, timestamp: '12시 00분 00초', color: '#ffffff', level: 10 });
  let history = Array.from({ length: 30 }, (_, n) => message(n));
  let historyCalls = 0;
  let initialConfigReply: (() => void) | undefined;
  let failSave = false;
  let releaseSave: (() => void) | undefined;
  let holdSave = false;
  const targetWindow = new BrowserWindow({ show: false, width: 460, height: 720, webPreferences: {
    preload: path.join(projectRoot, 'dist/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const onDefaults = (event: Electron.IpcMainEvent) => { event.returnValue = defaults; };
  const commit = (patch: unknown) => {
    const sanitized = config.sanitizeExternalConfigPatch(patch);
    assert.ok(sanitized);
    assert.equal(config.saveConfirmed(sanitized), true);
    targetWindow.webContents.send('config-data', config.load());
  };
  const settle = () => targetWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))');
  const state = () => targetWindow.webContents.executeJavaScript(`(() => {
    const list = document.getElementById('messageList'), rows = Array.from(list.querySelectorAll('.message-row'));
    const top = list.getBoundingClientRect().top, anchor = rows.find(row => row.getBoundingClientRect().bottom > top);
    return { messages: rows.map(row => row.querySelector('.bubble').textContent),
      anchor: anchor?.querySelector('.bubble').textContent, offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      notes: rows.map(row => row.querySelector('.nickname-note-badge')?.textContent || ''),
      colors: rows.map(row => row.querySelector('.eta-badge')?.style.color || ''),
      bottom: list.scrollHeight - list.scrollTop - list.clientHeight };
  })()`);
  const preserve = async (before: any, label: string) => {
    await settle();
    const after = await state();
    assert.deepEqual(after.messages, before.messages, `${label}: 표시 대화가 달라졌습니다.`);
    assert.equal(after.anchor, before.anchor, `${label}: 읽던 행이 달라졌습니다.`);
    assert.ok(Math.abs(after.offset - before.offset) <= 2, `${label}: 읽던 행의 화면 내 위치가 달라졌습니다.`);
    return after;
  };
  const openNote = async (text: string) => targetWindow.webContents.executeJavaScript(`(() => {
    const list = document.getElementById('messageList'), top = list.getBoundingClientRect().top;
    const row = Array.from(list.querySelectorAll('.message-row')).find(row => row.getBoundingClientRect().bottom > top);
    row.querySelector('.sender').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }));
    document.getElementById('note-text').value = ${JSON.stringify(text)};
  })()`);
  const submitNote = () => targetWindow.webContents.executeJavaScript(`document.querySelector('.nickname-note-form').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));`);
  const waitNote = () => waitForRendererCondition(targetWindow, `!document.querySelector('.nickname-note-dialog').open`, '메모 저장 완료를 받지 못했습니다.');
  ipcMain.on('get-default-config-sync', onDefaults);
  ipcMain.handle('focused-chat-get-state', () => ({ selfNickname: '나', targets: ['친구'], knownNicknames: ['친구'] }));
  ipcMain.handle('focused-chat-get-history', () => { historyCalls++; return history; });
  ipcMain.handle('get-config', () => {
    const snapshot = config.load();
    return new Promise(resolve => { initialConfigReply = () => resolve(snapshot); });
  });
  // 실제 저장 핸들러를 사용하고 창 배치 부수 효과만 격리한다. 저장 검증을 테스트에 다시 구현하지 않는다.
  const ipcSource = fs.readFileSync(path.join(projectRoot, 'src/modules/ipcHandlers.ts'), 'utf8');
  const saveStart = ipcSource.indexOf("  ipcMain.handle('nickname-note-save'");
  const saveEnd = ipcSource.indexOf('  // 기능 계약: 현재 저장 설정만', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  let saveHandler: (...args: any[]) => any;
  const ts = require('typescript');
  require('node:vm').runInNewContext(ts.transpileModule(ipcSource.slice(saveStart, saveEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMain: { handle: (_channel: string, handler: typeof saveHandler) => { saveHandler = handler; } }, config,
    require: (name: string) => { assert.equal(name, '../shared/nicknameNotes'); return nicknameNotes; },
    wm: { applySettings: (patch: unknown) => {
      if (failSave) { targetWindow.webContents.send('config-data', config.load()); return false; }
      // VM에서 읽은 핸들러의 객체를 실제 메인 프로세스와 같은 realm으로 옮긴다.
      commit(structuredClone(patch)); return true;
    } },
  });
  ipcMain.handle('nickname-note-save', async (...args) => {
    if (holdSave) await new Promise<void>(resolve => { releaseSave = resolve; });
    return saveHandler(...args);
  });
  try {
    assert.equal(config.saveConfirmed({ userServer: 7, nicknameNotes: [], chatEtaColorsEnabled: false }), true);
    await targetWindow.loadFile(path.join(projectRoot, 'dist/focused-chat.html'));
    await waitForRendererCondition(targetWindow, `document.querySelectorAll('.message-row').length === 30`, '집중 채팅 초기 이력 누락');
    for (let n = 0; n < 151; n++) targetWindow.webContents.send('chat-updated', message(1000 + n, '다른 사용자', n % 2 ? 'system' : 'general'));
    await settle();
    await targetWindow.webContents.executeJavaScript(`document.getElementById('messageList').scrollTop = 400; window.__firstFocusedRow = document.querySelector('.message-row');`);
    const before = await state();
    initialConfigReply!();
    await preserve(before, '늦게 도착한 최초 설정');
    commit({ showXpWidget: !config.load().showXpWidget });
    await preserve(before, '무관한 HUD 설정');
    assert.equal(await targetWindow.webContents.executeJavaScript('window.__firstFocusedRow === document.querySelector(".message-row")'), true);

    const longNote = '거래 내역과 캐릭터 메모 '.repeat(12).trim();
    await openNote(longNote);
    await submitNote();
    await waitNote();
    let after = await preserve(before, '메모 저장과 config-data');
    assert.deepEqual([...new Set(after.notes)], [longNote]);
    assert.equal(config.load().nicknameNotes[0].note, longNote, '화면의 메모 저장이 실제 설정 파일에 반영되어야 합니다.');
    const savedOnDisk = JSON.parse(fs.readFileSync(path.join(testUserDataDirectory, 'config.json'), 'utf8'));
    assert.equal(savedOnDisk.nicknameNotes[0].note, longNote);

    commit({ nicknameNotes: [{ server: 7, nickname: '친구', note: longNote }, { server: 16, nickname: '친구', note: '다른 서버 메모' }],
      userServer: 16, chatEtaColorsEnabled: true, chatEtaColors: ['#aabbcc', '#000002', '#000003', '#000004', '#000005'] });
    after = await preserve(before, '외부 서버·메모·에타 변경');
    assert.ok(after.notes.every((note: string) => note === '다른 서버 메모'));
    assert.ok(after.colors.every((color: string) => color === 'rgb(170, 187, 204)'));
    commit({ chatNicknameNotesCompact: true });
    after = await preserve(before, '메모 간단 표시');
    assert.ok(after.notes.every((note: string) => note === '메모'));
    commit({ chatCompactDisplay: true });
    await preserve(before, '집중 채팅 시간·배지 간단 표시');
    assert.equal(await targetWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.time,.eta-badge')).every(node=>getComputedStyle(node).display==='none')`), true);
    commit({ chatCompactDisplay: false });
    await preserve(before, '집중 채팅 기본 표시 복원');
    commit({ chatNicknameNotesCompact: false, chatEtaColorsEnabled: false });
    after = await preserve(before, '에타 색상 해제');
    assert.ok(after.colors.every((color: string) => color === ''));

    failSave = true;
    await openNote('저장되지 않을 초안');
    await submitNote();
    await waitForRendererCondition(targetWindow, `document.getElementById('note-save-error').textContent === '메모를 저장하지 못했습니다.'`, '메모 저장 실패 안내 누락');
    after = await preserve(before, '메모 저장 실패');
    assert.ok(after.notes.every((note: string) => note === '다른 서버 메모'));
    assert.equal(await targetWindow.webContents.executeJavaScript(`document.getElementById('note-text').value`), '저장되지 않을 초안');
    await targetWindow.webContents.executeJavaScript(`document.getElementById('note-cancel').click()`);
    failSave = false;
    await openNote('');
    await targetWindow.webContents.executeJavaScript(`document.getElementById('note-remove').click()`);
    await waitNote();
    after = await preserve(before, '메모 삭제');
    assert.ok(after.notes.every((note: string) => note === ''));

    holdSave = true;
    await openNote('대기 중 수신도 보존');
    await submitNote();
    for (let attempt = 0; !releaseSave && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseSave);
    targetWindow.webContents.send('chat-updated', message(30));
    await waitForRendererCondition(targetWindow, `document.querySelectorAll('.message-row').length === 31`, '메모 저장 중 실시간 메시지 누락');
    releaseSave();
    await waitNote();
    after = await state();
    assert.deepEqual(after.messages, [...before.messages, '읽던 대화 30']);
    assert.equal(after.anchor, before.anchor);
    assert.ok(Math.abs(after.offset - before.offset) <= 2);
    holdSave = false;
    await targetWindow.webContents.executeJavaScript(`const list = document.getElementById('messageList'); list.scrollTop = list.scrollHeight;`);
    commit({ nicknameNotes: [] });
    await settle();
    assert.ok((await state()).bottom <= 2, '맨 아래에서 메모 높이가 바뀌어도 하단을 유지해야 합니다.');
    targetWindow.webContents.send('chat-updated', message(31));
    await waitForRendererCondition(targetWindow, `document.querySelectorAll('.message-row').length === 32`, '설정 갱신 후 새 대화 누락');
    assert.ok((await state()).bottom <= 2, '새 메시지 하단 따라가기를 유지해야 합니다.');
    assert.equal(historyCalls, 1, '외형 갱신 중 원본 이력을 다시 조회하면 안 됩니다.');

    // 대상 변경과 명시적인 이력 초기화는 기존 필터 의미를 유지한다. 외형 갱신으로 지운 행을 부활시키지 않는다.
    await targetWindow.webContents.executeJavaScript(`document.querySelector('.remove-target').click()`);
    assert.equal((await state()).messages.length, 0);
    targetWindow.webContents.send('chat-updated', message(32, '나', 'whisper'));
    await waitForSelector(targetWindow, '.message-row.self');
    history = [];
    targetWindow.webContents.send('chat-history-cleared');
    await waitForSelector(targetWindow, '.empty-state');
    commit({ chatEtaColorsEnabled: true });
    await settle();
    assert.equal((await state()).messages.length, 0);
    await targetWindow.webContents.executeJavaScript(`document.getElementById('nicknameInput').value='친구'; document.getElementById('targetForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    for (let n = 0; n < 171; n++) targetWindow.webContents.send('chat-updated', message(2000 + n));
    await waitForRendererCondition(targetWindow, `Array.from(document.querySelectorAll('.bubble')).some(node => node.textContent === '읽던 대화 2170')`, '연속 실시간 대화 수신 누락');
    commit({ nicknameNotes: [{ server: 16, nickname: '친구', note: '상한 검사' }] });
    await settle();
    assert.deepEqual((await state()).messages, Array.from({ length: 150 }, (_, n) => `읽던 대화 ${2021 + n}`));
    assert.equal(await targetWindow.webContents.executeJavaScript(`document.querySelectorAll('.nickname-note-badge').length`), 150);

    // 초기 설정 응답보다 먼저 받은 최신 서버/메모 설정을 과거 응답이 되돌리지 않아야 한다.
    history = Array.from({ length: 30 }, (_, n) => message(n));
    await targetWindow.reload();
    await waitForRendererCondition(targetWindow, `document.querySelectorAll('.message-row').length === 30`, '재시작 이력 누락');
    commit({ userServer: 7, nicknameNotes: [{ server: 7, nickname: '친구', note: '최신 메모' }] });
    await waitForSelector(targetWindow, '.nickname-note-badge');
    initialConfigReply!();
    await settle();
    assert.ok((await state()).notes.every((note: string) => note === '최신 메모'), '늦은 최초 응답이 최신 설정을 되돌리면 안 됩니다.');
  } finally {
    initialConfigReply?.();
    releaseSave?.();
    targetWindow.destroy();
    ipcMain.removeListener('get-default-config-sync', onDefaults);
    for (const channel of ['focused-chat-get-state', 'focused-chat-get-history', 'get-config', 'nickname-note-save']) ipcMain.removeHandler(channel);
    config.saveConfirmed(original);
  }
}

async function checkActivityPresetsRenderer(window: BrowserWindow): Promise<void> {
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cleanStyledHtmlForTest(path.join(projectRoot, 'dist', 'settings.html')))}`);
  const code = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'settings', 'activity-presets.js'), 'utf8');
  await window.webContents.executeJavaScript(`window.__presetCalls = []; window.electronAPI = {
    saveActivityPreset: async (...args) => { window.__presetCalls.push(['save', ...args]); return { success: true }; },
    applyActivityPreset: async id => { window.__presetCalls.push(['apply', id]); return { success: false, error: '저장 오류' }; },
    deleteActivityPreset: async id => { window.__presetCalls.push(['delete', id]); return { success: true }; }
  }; ${code}; window.settingsActivityPresets.bind({ activityPresets: [{ id: 'hunt', name: '<img id="preset-xss">', openWindows: ['xpHud'] }] });`);
  assert.equal(await window.webContents.executeJavaScript('!!document.getElementById("preset-xss")'), false);
  await window.webContents.executeJavaScript(`document.querySelector('#activity-preset-list button').click()`);
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('activity-preset-status').textContent`), '저장 오류');
  await window.webContents.executeJavaScript(`document.getElementById('activity-preset-name').value = '거래'; document.getElementById('activity-preset-save').click()`);
  assert.deepEqual(await window.webContents.executeJavaScript('window.__presetCalls'), [['apply', 'hunt'], ['save', '거래']]);
  const draftCode = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'settings', 'draft.js'), 'utf8');
  await window.webContents.executeJavaScript(`${draftCode}
    window.__refreshPreset = name => {
      const draft = window.settingsDraft.beforeRefresh({});
      window.settingsActivityPresets.bind({ activityPresets: [{ id: 'hunt', name, openWindows: ['xpHud'] }] });
      draft.restore({});
    };
    window.__refreshPreset('사냥');
    Array.from(document.querySelectorAll('#activity-preset-list button')).find(button => button.textContent === '상세').click();
    window.__renameInput = () => document.querySelector('#activity-preset-list input');
    window.__renameInput().value = '보스 사냥 수정 중'; window.__renameInput().focus(); window.__renameInput().setSelectionRange(3, 5);
    window.__refreshPreset('사냥');
  `);
  assert.deepEqual(await window.webContents.executeJavaScript(`({ value:__renameInput().value, focused:document.activeElement === __renameInput(), start:__renameInput().selectionStart, end:__renameInput().selectionEnd })`),
    { value:'보스 사냥 수정 중', focused:true, start:3, end:5 }, '외부 설정 갱신 후 프리셋 이름 초안·포커스·선택 영역을 보존해야 합니다.');
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#activity-preset-list button')).find(button => button.textContent === '이름 변경').click();`);
  await waitForRendererCondition(window, `document.getElementById('activity-preset-status').textContent === '이름을 변경했습니다.'`, '프리셋 이름 저장이 끝나지 않았습니다.');
  await window.webContents.executeJavaScript(`window.__refreshPreset('외부에서 변경한 이름');`);
  assert.equal(await window.webContents.executeJavaScript('__renameInput().value'), '외부에서 변경한 이름', '저장 완료한 이름을 계속 미저장 초안으로 취급하면 안 됩니다.');
  await window.webContents.executeJavaScript(`
    window.electronAPI.saveActivityPreset = () => new Promise(resolve => window.__resolvePresetSave = resolve);
    __renameInput().value = '저장 요청'; Array.from(document.querySelectorAll('#activity-preset-list button')).find(button => button.textContent === '이름 변경').click();
    __renameInput().value = '저장 중 추가 편집'; __refreshPreset('저장 요청');
    __resolvePresetSave({success:true});
  `);
  await window.webContents.executeJavaScript(`__refreshPreset('저장 요청');`);
  assert.equal(await window.webContents.executeJavaScript('__renameInput().value'), '저장 중 추가 편집', '늦은 저장 성공으로 이후 입력한 이름을 버리면 안 됩니다.');
  await window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('#activity-preset-list button')).find(button => button.textContent === '이름 변경').click();
    __resolvePresetSave({success:false,error:'이름 저장 실패'});
  `);
  await waitForRendererCondition(window, `document.getElementById('activity-preset-status').textContent === '이름 저장 실패'`, '이름 저장 실패가 표시되지 않았습니다.');
  await window.webContents.executeJavaScript(`__refreshPreset('저장 요청');`);
  assert.equal(await window.webContents.executeJavaScript('__renameInput().value'), '저장 중 추가 편집');
  const layout = await window.webContents.executeJavaScript(`(() => {
    const card = document.getElementById('chat-font-settings');
    document.body.replaceChildren(card);
    card.style.width = '720px';
    const grid = card.querySelector('.ui-font-grid');
    const wide = Array.from(grid.children).map(node => node.getBoundingClientRect());
    card.style.width = '300px';
    const narrow = Array.from(grid.children).map(node => node.getBoundingClientRect());
    const inputsFit = Array.from(card.querySelectorAll('select')).every(node => node.scrollWidth <= node.clientWidth + 1);
    return { wideColumns: new Set(wide.map(rect => Math.round(rect.left))).size,
      wideRows: new Set(wide.map(rect => Math.round(rect.top))).size,
      narrowColumns: new Set(narrow.map(rect => Math.round(rect.left))).size, inputsFit };
  })()`);
  assert.deepEqual(layout, { wideColumns: 3, wideRows: 1, narrowColumns: 1, inputsFit: true },
    '창별 글꼴 설정은 넓은 창에서 3열, 좁은 창에서 잘림 없이 1열이어야 합니다.');
  const defaultConfig = require(path.join(projectRoot, 'dist', 'modules', 'constants.js')).DEFAULT_CONFIG;
  const fontCode = ['shared/chatChannels.js', 'renderer/settings/config-binding.js', 'renderer/settings/form-collection.js']
    .map(file => fs.readFileSync(path.join(projectRoot, 'dist', file), 'utf8')).join('\n');
  const fontRoundTrips = await window.webContents.executeJavaScript(`(() => {
    window.electronAPI.DEFAULT_CONFIG = ${JSON.stringify(defaultConfig)};
    ${fontCode}
    return [10, 11, 12, 14, 28].map(size => {
      const config = { ...window.electronAPI.DEFAULT_CONFIG, chatOverlayFontSize: size };
      window.settingsConfigBinding.applyChatAndAlertSettings(config, window.electronAPI.DEFAULT_CONFIG);
      const saved = window.settingsFormCollection.collectChatOverlayDisplaySettings([], []);
      return { size, input: Number(document.getElementById('chat-overlay-fontsize-input').value),
        label: document.getElementById('chat-overlay-fontsize-val').textContent, saved: saved.chatOverlayFontSize,
        inherited: window.chatChannels.resolveChatFont(saved, 'sub1').size };
    });
  })()`);
  for (const row of fontRoundTrips) {
    assert.deepEqual(row, { size: row.size, input: row.size, label: row.size + 'px', saved: row.size, inherited: row.size },
      '기존 채팅 글꼴은 설정 화면을 열고 저장해도 표시값·저장값·보조 창 상속값을 보존해야 합니다.');
  }
}

async function checkManagedWindowResizeLimits(window: BrowserWindow): Promise<void> {
  const utils = fs.readFileSync(path.join(projectRoot, 'dist', 'assets', 'ui-utils.js'), 'utf8');
  await window.loadURL('data:text/html;charset=utf-8,<title>Resize limits</title>');
  await window.webContents.executeJavaScript(`
    window.__resizeRequests = [];
    window.electronAPI = {
      setWindowSize: (width, height) => __resizeRequests.push([width, height]),
      onManagedWindowResizeEnabled: callback => { window.__resizeLimits = callback; }
    };
    ${utils}
    window.__resizeLimits({ minWidth:900, minHeight:650 });
    window.__originalHandle = document.getElementById('tw-managed-window-resize-handle');
  `);
  for (const [minWidth, minHeight] of [[900, 650], [760, 560], [900, 650], [760, 560]]) {
    const result = await window.webContents.executeJavaScript(`(() => {
      __resizeLimits({ minWidth:${minWidth}, minHeight:${minHeight} });
      __resizeLimits({ minWidth:${minWidth}, minHeight:${minHeight} });
      __resizeRequests.length = 0;
      const handle = document.getElementById('tw-managed-window-resize-handle');
      handle.dispatchEvent(new MouseEvent('mousedown', { screenX:2000, screenY:2000, bubbles:true }));
      window.dispatchEvent(new MouseEvent('mousemove', { screenX:0, screenY:0 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      return { requests:__resizeRequests, sameHandle:handle === __originalHandle,
        count:document.querySelectorAll('#tw-managed-window-resize-handle').length };
    })()`);
    assert.deepEqual(result, { requests: [[minWidth, minHeight]], sameHandle: true, count: 1 },
      '반복 프리셋 적용 후 기존 손잡이를 드래그해도 최신 최소 크기를 사용하며 리스너를 중복 등록하면 안 됩니다.');
  }
}

async function checkNicknameNoteEscape(window: BrowserWindow): Promise<void> {
  const notes = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'nickname-notes.js'), 'utf8');
  const utils = fs.readFileSync(path.join(projectRoot, 'dist', 'assets', 'ui-utils.js'), 'utf8');
  const settings = fs.readFileSync(path.join(projectRoot, 'dist', 'settings.html'), 'utf8');
  const handler = settings.match(/window.addEventListener\('keydown', \(e\) => \{\r?\n      if \(window.settingsShortcuts.handleKeyDown\(e\)\) return;[\s\S]*?\r?\n    \}\);/);
  assert.ok(handler, '설정 화면의 실제 Escape 처리기를 찾지 못했습니다.');
  for (const parent of ['focused-chat', 'settings']) {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<button id="nickname-note-add">메모 추가</button><input id="other-draft" value="아직 저장하지 않은 설정">'));
    await window.webContents.executeJavaScript(`window.__closeCalls = 0; window.close = () => window.__closeCalls++;
      window.electronAPI = {}; window.settingsShortcuts = { handleKeyDown: () => false };
      ${utils} ${notes} ${parent === 'settings' ? handler[0] : 'window.bindEscapeClose();'}
      document.getElementById('nickname-note-add').focus(); document.getElementById('nickname-note-add').click();
    `);
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitForRendererCondition(window, `!document.querySelector('dialog').open`, `${parent}의 메모 창을 Escape로 닫지 못했습니다.`);
    assert.deepEqual(await window.webContents.executeJavaScript(`({ closeCalls:__closeCalls, draft:document.getElementById('other-draft').value })`),
      { closeCalls:0, draft:'아직 저장하지 않은 설정' }, '메모 취소가 부모 창이나 다른 입력을 닫으면 안 됩니다.');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitForRendererCondition(window, `window.__closeCalls === 1`, `${parent}: 메모가 없을 때 기존 부모 창 Escape 닫기는 유지해야 합니다.`);
  }
}

async function checkNicknameNoteSaveOrdering(window: BrowserWindow): Promise<void> {
  const code = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'nickname-notes.js'), 'utf8');
  async function setup(): Promise<void> {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<button id="nickname-note-add">메모 추가</button><div id="nickname-note-list"></div>'));
    await window.webContents.executeJavaScript(`
      window.__requests = [];
      window.electronAPI = { saveNicknameNote: (...args) => new Promise((resolve, reject) => __requests.push({args,resolve,reject})) };
      ${code}
      window.nicknameNotes.updateConfig({userServer:7,nicknameNotes:[]});
      window.__open = (nickname, note) => {
        document.getElementById('nickname-note-add').click();
        document.getElementById('note-nickname').value = nickname;
        document.getElementById('note-text').value = note;
      };
      window.__submit = () => document.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
      window.__escape = () => document.querySelector('dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true,bubbles:true}));
      window.__state = () => ({ open:document.querySelector('dialog').open, nickname:document.getElementById('note-nickname').value,
        note:document.getElementById('note-text').value, error:document.getElementById('note-save-error').textContent,
        disabled:document.getElementById('note-save').disabled,
        list:Array.from(document.querySelectorAll('.nickname-note-list-item')).map(node=>node.textContent) });
      void 0;
    `);
  }
  await setup();
  await window.webContents.executeJavaScript(`
    __open('Alice','A 메모'); __submit(); __escape();
    window.nicknameNotes.updateConfig({userServer:16,nicknameNotes:[{server:7,nickname:'Alice',note:'A 메모'}]});
    __open('Bob','B 초안'); __submit(); __submit();
    __requests[0].resolve({success:true});
  `);
  assert.deepEqual(await window.webContents.executeJavaScript('__requests.map(request=>request.args)'), [[7,'Alice','A 메모'],[16,'Bob','B 초안']], '서버·닉네임을 요청 시 고정하고 중복 제출을 막아야 합니다.');
  assert.deepEqual(await window.webContents.executeJavaScript('__state()'),
    { open:true,nickname:'Bob',note:'B 초안',error:'',disabled:true,list:[] }, '이전 저장 응답이 새 편집을 닫거나 새 요청의 버튼을 활성화하면 안 됩니다.');
  await window.webContents.executeJavaScript('__requests[1].resolve({success:true});');
  assert.deepEqual(await window.webContents.executeJavaScript('({open:__state().open,list:__state().list})'),
    {open:false,list:['BobB 초안']});

  for (const rejection of [false,true]) {
    await setup();
    await window.webContents.executeJavaScript(`
      __open('Alice','옛 편집'); __submit(); __escape(); __open('Bob','새 편집'); __submit();
      ${rejection ? "__requests[0].reject(new Error('이전 요청 오류'))" : "__requests[0].resolve({success:false,error:'이전 요청 실패'})"};
    `);
    assert.deepEqual(await window.webContents.executeJavaScript('__state()'),
      {open:true,nickname:'Bob',note:'새 편집',error:'',disabled:true,list:[]});
    await window.webContents.executeJavaScript("__requests[1].resolve({success:false,error:'현재 요청 실패'});");
    assert.deepEqual(await window.webContents.executeJavaScript('({open:__state().open,error:__state().error,disabled:__state().disabled})'),
      {open:true,error:'현재 요청 실패',disabled:false});
  }

  await setup();
  await window.webContents.executeJavaScript(`
    __open('Charlie','저장한 내용'); __submit();
    document.getElementById('note-nickname').value = 'CharlieNew';
    document.getElementById('note-text').value = '대기 중 추가 입력';
    __requests[0].resolve({success:true});
  `);
  assert.deepEqual(await window.webContents.executeJavaScript('__state()'),
    {open:true,nickname:'CharlieNew',note:'대기 중 추가 입력',error:'',disabled:false,list:['Charlie저장한 내용']}, '같은 편집창의 대기 중 입력도 보존해야 합니다.');
  await window.webContents.executeJavaScript('__submit(); __requests[1].resolve({success:true});');
  assert.equal(await window.webContents.executeJavaScript('__state().open'),false);

  await setup();
  await window.webContents.executeJavaScript(`
    __open('Same','오래된 내용'); __submit(); __escape(); __open('Same','최신 내용'); __submit();
    __requests[1].resolve({success:true});
  `);
  await window.webContents.executeJavaScript('__requests[0].resolve({success:true});');
  assert.deepEqual(await window.webContents.executeJavaScript('__state().list'),['Same최신 내용'], '같은 닉네임의 응답 완료 순서가 뒤집혀도 최신 저장을 보존해야 합니다.');
  await window.webContents.executeJavaScript(`
    __open('Same','내 요청'); __submit();
    window.nicknameNotes.updateConfig({userServer:7,nicknameNotes:[{server:7,nickname:'Same',note:'다른 창의 최신 저장'}]});
    __requests[2].resolve({success:true});
  `);
  assert.deepEqual(await window.webContents.executeJavaScript('__state().list'),['Same다른 창의 최신 저장']);
  await window.webContents.executeJavaScript(`
    __open('Same','삭제할 메모'); document.getElementById('note-remove').click();
    document.getElementById('note-text').value = '삭제 요청 후 추가 입력'; __requests[3].resolve({success:true});
  `);
  assert.deepEqual(await window.webContents.executeJavaScript('({open:__state().open,note:__state().note,list:__state().list})'),
    {open:true,note:'삭제 요청 후 추가 입력',list:[]});
}

async function checkNotificationLayout(window: BrowserWindow): Promise<void> {
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cleanHtmlForTest(path.join(projectRoot, 'dist', 'game-overlay.html')))}`);
  window.setContentSize(1200, 800);
  const code = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'game-overlay', 'notification-layout.js'), 'utf8');
  await window.webContents.executeJavaScript(`window.__notificationTimers = []; window.electronAPI = { onNotificationPreview: callback => window.__notificationPreview = callback, onNotificationEditMode: callback => window.__notificationEditCallback = callback }; const realTimeout = window.setTimeout; window.setTimeout = (callback, ms) => { if (ms === 5000) { window.__notificationTimers.push(callback); return 0; } return realTimeout(callback, ms); }; ${code}`);
  const result = await window.webContents.executeJavaScript(`(() => {
    const original = { center: 'default', buff: 'default', hunting: 'default', toast: 'default' };
    const layout = { center: 'top-right', buff: 'bottom-center', hunting: 'top-left', toast: 'bottom-right' };
    const card = document.getElementById('quest-alert');
    window.notificationLayout.updateConfig({ notificationPositions: layout });
    const adjusted = parseFloat(card.style.left) > innerWidth / 2 && parseFloat(card.style.top) < innerHeight / 2;
    window.__notificationPreview(layout);
    const count = document.querySelectorAll('[data-notification-sample]').length;
    window.notificationLayout.updateConfig({ notificationPositions: original });
    window.__notificationTimers.at(-1)();
    return { adjusted, count, restored: card.style.left === '' && card.style.top === '', removed: !document.querySelector('[data-notification-sample]'), realAlertUntouched: !card.classList.contains('show') };
  })()`);
  assert.deepEqual(result, { adjusted: true, count: 4, restored: true, removed: true, realAlertUntouched: true });

  const editResult = await window.webContents.executeJavaScript(`(async () => {
    let savedPositions = null;
    let editModeEnded = false;
    window.electronAPI.saveNotificationPositions = async (positions) => { savedPositions = positions; return { success: true }; };
    window.electronAPI.finishNotificationEditMode = async () => { editModeEnded = true; return true; };

    // 편집 모드 시작
    window.__notificationEditCallback(true, true, 101);
    const cardCount = document.querySelectorAll('.notification-edit-card').length;
    const toolbarVisible = !document.getElementById('notification-edit-toolbar').hidden;
    const isBodyClassSet = document.body.classList.contains('notification-edit-mode');

    // 센터 카드 드래그 시뮬레이션 (자유 좌표로 이동)
    const centerCard = document.querySelector('.notification-edit-card[data-group="center"]');
    centerCard.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 500, clientY: 300, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700, clientY: 250, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 700, clientY: 250, bubbles: true }));

    // 개별 리셋 버튼 테스트 (버프 알림 리셋 클릭)
    const buffResetBtn = document.querySelector('.notification-edit-card[data-group="buff"] .notification-edit-card-reset');
    buffResetBtn.click();

    // 저장 버튼 클릭
    document.getElementById('notif-edit-save').click();
    await new Promise(r => setTimeout(r, 50));

    const centerSaved = savedPositions?.center;
    const isCenterCustom = centerSaved && typeof centerSaved === 'object' && typeof centerSaved.left === 'number' && typeof centerSaved.top === 'number';

    return {
      cardCount,
      toolbarVisible,
      isBodyClassSet,
      isCenterCustom,
      buffDefault: savedPositions?.buff === 'default',
      editModeEnded,
      cleanedUp: document.getElementById('notification-edit-toolbar').hidden && !document.body.classList.contains('notification-edit-mode')
    };
  })()`);
  assert.deepEqual(editResult, {
    cardCount: 4,
    toolbarVisible: true,
    isBodyClassSet: true,
    isCenterCustom: true,
    buffDefault: true,
    editModeEnded: true,
    cleanedUp: true
  });
}

async function checkPinnedNoteReading(window: BrowserWindow): Promise<void> {
  const page = path.join(projectRoot, 'dist', 'game-overlay.html');
  const fixture = path.join(testUserDataDirectory, 'pinned-note-reading.html');
  fs.writeFileSync(fixture, cleanStyledHtmlForTest(page).replace('<head>', `<head><base href="${pathToFileURL(page).href}">`));
  await window.loadFile(fixture);
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(projectRoot, 'dist/assets/tailwind.min.js'), 'utf8'));
  const code = fs.readFileSync(path.join(projectRoot, 'dist/shared/windowSnap.js'), 'utf8') + '\n' + ['companion-hud', 'edit-mode'].map(name => fs.readFileSync(path.join(projectRoot, 'dist/renderer/game-overlay', name + '.js'), 'utf8')).join('\n');
  await window.webContents.executeJavaScript(`window.__noteWrites = [];
    window.electronAPI = { applySettingsConfirmed: async patch => { window.__noteWrites.push(patch); return { success:true }; } };
    ${code}
    window.__readNote = () => {
      const note = document.getElementById('pinned-note-hud'), text = document.getElementById('pinned-note-content');
      const rect = note.getBoundingClientRect();
      return { text: text.textContent, overflow: text.scrollHeight > text.clientHeight + 1,
        hint: !document.getElementById('pinned-note-overflow').classList.contains('hidden'),
        pointerEvents: getComputedStyle(text).pointerEvents, scrollTop: text.scrollTop,
        fits: rect.left >= 11 && rect.top >= 11 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight - 11,
        left: note.style.left, top: note.style.top };
    }; true;`);
  const samples = ['오늘 목표\n도핑 확인', Array.from({ length: 25 }, (_, i) => `${i + 1}. 도핑과 장비 확인`).join('\n'), '가'.repeat(1000), '체크\n'.repeat(333) + '끝'];
  for (const [width, height] of [[800, 600], [1000, 700], [1920, 1080]]) {
    window.setContentSize(width, height);
    await waitForRendererCondition(window, `innerWidth === ${width} && innerHeight === ${height}`, '메모 화면 크기가 반영되지 않았습니다.');
    for (const text of samples) {
      const result = await window.webContents.executeJavaScript(`(() => {
        window.__noteConfig = { pinnedNoteEnabled: true, pinnedNoteText: ${JSON.stringify(text)}, pinnedNotePos: { left: 1800, top: 900 } };
        companionHud.updateConfig(window.__noteConfig); return window.__readNote();
      })()`);
      assert.equal(result.text, text);
      assert.equal(result.fits, true, `${width}×${height}: 메모 패널이 화면을 벗어났습니다.`);
      assert.equal(result.pointerEvents, 'none', '평상시 게임 입력 투과를 유지해야 합니다.');
      assert.equal(result.hint, result.overflow, '넘치는 메모에만 전체 보기 안내를 표시해야 합니다.');
      assert.equal(result.overflow, text !== samples[0]);
      if (!result.overflow) continue;
      const edited = await window.webContents.executeJavaScript(`(() => {
        gameOverlayEditMode.enterEditMode();
        const text = document.getElementById('pinned-note-content');
        text.scrollTop = text.scrollHeight;
        const end = document.createRange(); end.setStart(text.firstChild, text.textContent.length - 1); end.setEnd(text.firstChild, text.textContent.length);
        const tail = end.getBoundingClientRect(), viewport = text.getBoundingClientRect();
        const before = text.scrollTop;
        companionHud.updateConfig({ ...window.__noteConfig, supplyHelperEnabled: false });
        return { overflowY: getComputedStyle(text).overflowY, pointerEvents: getComputedStyle(text).pointerEvents,
          tailVisible: tail.top >= viewport.top - 1 && tail.bottom <= viewport.bottom + 1,
          scrollPreserved: text.scrollTop === before, fits: window.__readNote().fits };
      })()`);
      assert.deepEqual(edited, { overflowY: 'auto', pointerEvents: 'auto', tailVisible: true, scrollPreserved: true, fits: true });
      const cancelled = await window.webContents.executeJavaScript(`gameOverlayEditMode.exitEditMode(false); window.__readNote()`);
      assert.equal(cancelled.pointerEvents, 'none');
      assert.equal(cancelled.fits, true);
    }
  }
  // 실제 입력으로 본문 스크롤과 제목 드래그를 구분한다.
  window.setContentSize(1000, 700);
  await waitForRendererCondition(window, 'innerWidth === 1000 && innerHeight === 700', '입력 검사 화면 크기 변경 실패');
  await waitForRendererCondition(window, 'window.__readNote().fits', '크기 변경 후 메모가 화면 안으로 보정되지 않았습니다.');
  const resized = await window.webContents.executeJavaScript(`({ fits:window.__readNote().fits, position:window.__noteConfig.pinnedNotePos })`);
  assert.deepEqual(resized, { fits:true, position:{left:1800, top:900} }, '화면 보정은 저장된 좌표를 덮지 않습니다.');
  const input = await window.webContents.executeJavaScript(`(() => {
    window.__noteConfig = { pinnedNoteEnabled: true, pinnedNoteText: ${JSON.stringify(samples[1])}, pinnedNotePos: { left: 120, top: 120 } };
    companionHud.updateConfig(window.__noteConfig); gameOverlayEditMode.enterEditMode();
    // 다른 HUD는 이 본문 입력 검사의 대상이 아니다.
    document.querySelectorAll('.hud-draggable:not(#pinned-note-hud)').forEach(el => el.style.display = 'none');
    const note = document.getElementById('pinned-note-hud'), text = document.getElementById('pinned-note-content');
    text.scrollTop = 0;
    const bodyDown = new PointerEvent('pointerdown', { bubbles:true, cancelable:true, button:0, pointerId:5 });
    text.dispatchEvent(bodyDown);
    const bodyDrags = note.classList.contains('is-dragging');
    const titleDown = new PointerEvent('pointerdown', { bubbles:true, cancelable:true, button:0, pointerId:6 });
    note.querySelector('.ui-hud-heading').dispatchEvent(titleDown);
    const titleDrags = note.classList.contains('is-dragging');
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId:6 }));
    const rect = text.getBoundingClientRect();
    return { bodyDrags, bodyPrevented:bodyDown.defaultPrevented, titleDrags, titlePrevented:titleDown.defaultPrevented,
      x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2) };
  })()`);
  assert.equal(input.bodyDrags, false);
  assert.equal(input.bodyPrevented, false);
  assert.equal(input.titleDrags, true);
  assert.equal(input.titlePrevented, true);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  assert.equal(await window.webContents.executeJavaScript(`document.elementFromPoint(${input.x}, ${input.y})?.id`), 'pinned-note-content');
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: 'mouseMove', x: input.x, y: input.y });
  window.webContents.sendInputEvent({ type: 'mouseWheel', x: input.x, y: input.y, deltaY: -1000, canScroll: true });
  await waitForRendererCondition(window, "document.getElementById('pinned-note-content').scrollTop > 0", '실제 휠 입력으로 긴 메모를 스크롤할 수 없습니다.');
  const final = await window.webContents.executeJavaScript(`(() => {
    const note = document.getElementById('pinned-note-hud');
    note.style.left = '200px'; note.style.top = '200px';
    companionHud.updateConfig({ ...window.__noteConfig, pinnedNoteText:'편집 중 받은 짧은 메모', pinnedNotePos:{left:1, top:1} });
    const editing = window.__readNote();
    const draftPreserved = editing.left === '200px' && editing.top === '200px' && !editing.hint;
    companionHud.updateConfig(window.__noteConfig);
    gameOverlayEditMode.exitEditMode(false);
    const noWrites = window.__noteWrites.length === 0;
    const storedPosition = { ...window.__noteConfig.pinnedNotePos };
    companionHud.updateConfig({ ...window.__noteConfig, pinnedNoteText: '짧은 메모' });
    const short = window.__readNote();
    companionHud.updateConfig({ ...window.__noteConfig, pinnedNoteEnabled: false });
    const disabled = document.getElementById('pinned-note-hud').classList.contains('hidden');
    companionHud.updateConfig({ ...window.__noteConfig, pinnedNoteText: '  ' });
    return { noWrites, draftPreserved, storedPosition, shortHint:short.hint, shortScroll:short.scrollTop, disabled,
      empty:document.getElementById('pinned-note-hud').classList.contains('hidden') };
  })()`);
  assert.deepEqual(final, { noWrites:true, draftPreserved:true, storedPosition:{left:120, top:120}, shortHint:false, shortScroll:0, disabled:true, empty:true });
  const saved = await window.webContents.executeJavaScript(`(async () => {
    companionHud.updateConfig({ ...window.__noteConfig, pinnedNoteText:'저장 위치 확인' });
    gameOverlayEditMode.enterEditMode();
    const note = document.getElementById('pinned-note-hud');
    note.style.left = '250px'; note.style.top = '220px';
    await gameOverlayEditMode.exitEditMode(true);
    const beforeReply = [note.style.left, note.style.top];
    const position = window.__noteWrites.at(-1).pinnedNotePos;
    companionHud.updateConfig({ ...window.__noteConfig, pinnedNotePos:position, pinnedNoteText:'저장 위치 확인' });
    return { beforeReply, position, afterReply:[note.style.left, note.style.top], writes:window.__noteWrites.length };
  })()`);
  assert.deepEqual(saved, { beforeReply:['250px', '220px'], position:{left:250, top:220}, afterReply:['250px', '220px'], writes:1 });
}

async function checkCompanionHud(window: BrowserWindow): Promise<void> {
  const gameOverlayPath = path.join(projectRoot, 'dist', 'game-overlay.html');
  const fixturePath = path.join(testUserDataDirectory, 'supply-hud.html');
  fs.writeFileSync(fixturePath, cleanStyledHtmlForTest(gameOverlayPath).replace('<head>', `<head><base href="${pathToFileURL(gameOverlayPath).href}">`));
  await window.loadFile(fixturePath);
  window.setContentSize(800, 600);
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(projectRoot, 'dist', 'assets', 'tailwind.min.js'), 'utf8'));
  const code = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'game-overlay', 'companion-hud.js'), 'utf8');
  await window.webContents.executeJavaScript(`window.electronAPI = { onSupplyRunUpdate: callback => window.__supply = callback }; window.gameOverlayEditMode = { isEditMode: () => false };
    window.__supplyClock = 100000; Date.now = () => window.__supplyClock;
    window.__supplyTimers = new Map(); let supplyTimerId = 0;
    window.setTimeout = (callback, ms) => { const id = ++supplyTimerId; window.__supplyTimers.set(id, { callback, ms }); return id; };
    window.clearTimeout = id => window.__supplyTimers.delete(id);
    ${code}`);
  const result = await window.webContents.executeJavaScript(`(() => {
    window.companionHud.updateConfig({ pinnedNoteEnabled: true, pinnedNoteText: '<img id="pinned-xss">목표\\n도핑 확인', pinnedNotePos: { left: 120, top: 250 } });
    const element = document.getElementById('pinned-note-hud');
    const visible = !element.classList.contains('hidden');
    const position = [element.style.left, element.style.top];
    const safe = !document.getElementById('pinned-xss');
    window.gameOverlayEditMode.isEditMode = () => true;
    window.companionHud.updateConfig({ pinnedNoteEnabled: false, pinnedNotePos: { left: 1, top: 1 } });
    const preserved = [element.style.left, element.style.top];
    window.gameOverlayEditMode.isEditMode = () => false;
    window.companionHud.updateConfig({ pinnedNoteEnabled: false });
    return { visible, safe, position, preserved, hidden: element.classList.contains('hidden') };
  })()`);
  assert.deepEqual(result, { visible: true, safe: true, position: ['120px', '250px'], preserved: ['120px', '250px'], hidden: true });
  const supplyResult = await window.webContents.executeJavaScript(`(() => {
    window.companionHud.updateConfig({ supplyHelperEnabled: true, supplyMapEnabled: true, supplyMapLarge: true, supplyHudPos: { left: 360, top: 90 } });
    const panel = document.getElementById('supply-pad-alert');
    window.__supply({ expiresAt: Date.now() + 60000, orderExpiresAt: 0, colors: [] });
    const waitingHidden = panel.classList.contains('hidden');
    window.__supply({ expiresAt: Date.now() + 60000, orderExpiresAt: Date.now() + 10000, colors: ['파랑', '노랑', '빨강'] });
    const shown = !panel.classList.contains('hidden');
    const colors = document.getElementById('supply-pad-order').textContent;
    const rect = panel.getBoundingClientRect();
    const fits = rect.left >= 12 && rect.right <= innerWidth - 12 && rect.height <= 120;
    const noMapOrCard = !document.getElementById('supply-map') && !document.getElementById('supply-helper-hud') && !panel.classList.contains('ui-hud-card');
    window.__supplyClock += 5000;
    window.__supply({ expiresAt: Date.now() + 60000, orderExpiresAt: Date.now() + 10000, colors: ['빨강', '검정', '파랑'] });
    const replacement = document.getElementById('supply-pad-order').textContent;
    const timer = [...window.__supplyTimers.values()][0];
    const renewed = window.__supplyTimers.size === 1 && timer.ms === 10000;
    window.__supplyClock += 10000; timer.callback();
    const expired = panel.classList.contains('hidden') && document.getElementById('supply-pad-order').textContent === '';
    window.__supply({ expiresAt: Date.now() + 60000, orderExpiresAt: Date.now() + 10000, colors: ['흰색', '파랑', '노랑'] });
    window.companionHud.updateConfig({ supplyHelperEnabled: false });
    const disabled = panel.classList.contains('hidden');
    window.companionHud.updateConfig({ supplyHelperEnabled: true });
    window.__supply({ expiresAt: 0, orderExpiresAt: 0, colors: [] });
    return { waitingHidden, shown, colors, fits, noMapOrCard, replacement, renewed, expired, disabled, ended: panel.classList.contains('hidden') };
  })()`);
  assert.deepEqual(supplyResult, { waitingHidden: true, shown: true, colors: '파랑→노랑→빨강', fits: true, noMapOrCard: true,
    replacement: '빨강→검정→파랑', renewed: true, expired: true, disabled: true, ended: true });
  for (const [colors, files] of [
    [['파랑', '노랑', '빨강'], ['blue.png', 'yellow.png', 'red.png']],
    [['빨강', '검정', '파랑'], ['red.png', 'black.png', 'blue.png']],
    [['흰색', '파랑', '노랑'], ['white.png', 'blue.png', 'yellow.png']],
  ]) {
    const images = await window.webContents.executeJavaScript(`(async () => {
      window.__supply({expiresAt:Date.now()+60000,orderExpiresAt:Date.now()+10000,colors:${JSON.stringify(colors)}});
      const images = Array.from(document.querySelectorAll('#supply-pad-order img'));
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => ({file:image.getAttribute('src').split('/').at(-1),width:image.naturalWidth,height:image.naturalHeight,
        displayWidth:image.getBoundingClientRect().width,displayHeight:image.getBoundingClientRect().height}));
    })()`);
    assert.deepEqual(images, files.map(file => ({file,width:136,height:88,displayWidth:68,displayHeight:44})),
      '암호 순서에 맞는 실제 발판 PNG가 빌드 결과에서 로드되어야 합니다.');
  }
  const layoutCode = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'game-overlay', 'notification-layout.js'), 'utf8');
  await window.webContents.executeJavaScript(`${layoutCode}
    window.__supply({expiresAt:Date.now()+60000,orderExpiresAt:Date.now()+10000,colors:['파랑','노랑','빨강']});
  `);
  for (const [width, height] of [[800, 600], [400, 300]]) {
    window.setContentSize(width, height);
    await waitForRendererCondition(window, `innerWidth === ${width} && innerHeight === ${height}`, '발판 안내 화면 크기가 변경되지 않았습니다.');
    for (const anchor of ['default', 'top-right', 'bottom-left']) {
      const fits = await window.webContents.executeJavaScript(`(() => {
        window.notificationLayout.updateConfig({notificationPositions:{center:${JSON.stringify(anchor)}}});
        const r = document.getElementById('supply-pad-alert').getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.height <= 120;
      })()`);
      assert.equal(fits, true, `${width}×${height} ${anchor}: 발판 안내가 화면 밖으로 잘리거나 위치 변경으로 줄바꿈되면 안 됩니다.`);
    }
  }
}

async function checkGameOverlayEditMode(window: BrowserWindow): Promise<void> {
  const gameOverlayPath = path.join(projectRoot, 'dist', 'game-overlay.html');
  const fullHtml = fs.readFileSync(gameOverlayPath, 'utf8');
  const editModeCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'game-overlay', 'edit-mode.js'),
    'utf8',
  );
  const positionFunctionMatch = fullHtml.match(
    /(function applyConfiguredHudPositions\(config\) \{[\s\S]*?\r?\n    \})\r?\n\r?\n    window\.__isTimerRunning/,
  );
  assert.ok(positionFunctionMatch, '게임 오버레이 HUD 위치 적용 함수를 추출하지 못했습니다.');
  const digsiteFunctionMatch = fullHtml.match(
    /(function updateDigsiteRemaining\(\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function updateDigsiteUI\(state\) \{[\s\S]*?\r?\n    \})\r?\n\r?\n    setInterval\(updateDigsiteRemaining/,
  );
  assert.ok(digsiteFunctionMatch, '발굴지 현황판 렌더링 함수를 추출하지 못했습니다.');
  const html = cleanHtmlForTest(gameOverlayPath);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.setContentSize(1200, 800);
  const rendererPositionFunction = positionFunctionMatch[1].replace(
    'function applyConfiguredHudPositions(config)',
    'window.applyConfiguredHudPositions = function applyConfiguredHudPositions(config)',
  );
  await window.webContents.executeJavaScript(`${rendererPositionFunction}; true`);

  const initialResult = await window.webContents.executeJavaScript(`
    (() => {
      try {
      window.__hudPositionSettingWrites = [];
      window.gameOverlayEditMode = { isEditMode: () => false };
      window.electronAPI = {
        DEFAULT_CONFIG: {
          xpWidgetPos: { left: 200, bottom: 0 },
          abandonedWidgetPos: { left: 200, bottom: 0 },
          digsiteWidgetPos: { left: 0, bottom: 326 },
          buffTimerHudPos: { left: 350, bottom: 0 },
          forgeQuestHudPos: { left: 200, bottom: 0 },
          todaySummaryHudPos: { left: 0, top: 200 },
        },
        applySettingsConfirmed: async settings => { window.__hudPositionSettingWrites.push(settings); return { success:true }; },
      };
      window.__hudPositionConfig = {
        xpWidgetPos: { left: 910, bottom: 70 },
        abandonedWidgetPos: { left: 820, bottom: 60 },
        digsiteWidgetPos: { left: 760, bottom: 120 },
        buffTimerHudPos: { left: 980, bottom: 80 },
        forgeQuestHudPos: { left: 870, bottom: 90 },
      };
      window.applyConfiguredHudPositions(window.__hudPositionConfig);
      return {
        ok: true,
        hasBody: document.body !== null,
        hasContainer: document.getElementById('game-overlay-container') !== null || document.body.children.length > 0,
        buffLeft: document.getElementById('buff-hud')?.style.left,
        buffBottom: document.getElementById('buff-hud')?.style.bottom,
        digsiteLeft: document.getElementById('digsite-widget')?.style.left,
        digsiteBottom: document.getElementById('digsite-widget')?.style.bottom,
        settingWrites: window.__hudPositionSettingWrites.length,
      };
      } catch (error) {
        return { ok: false, error: error && (error.stack || error.message || String(error)) };
      }
    })()
  `) as {
    ok: boolean;
    error?: string;
    hasBody: boolean;
    hasContainer: boolean;
    buffLeft?: string;
    buffBottom?: string;
    digsiteLeft?: string;
    digsiteBottom?: string;
    settingWrites: number;
  };

  assert.equal(initialResult.ok, true, initialResult.error);
  assert.equal(initialResult.hasBody, true, '게임 오버레이 화면이 로드되지 않았습니다.');
  assert.equal(initialResult.hasContainer, true, '게임 오버레이 컨테이너가 렌더링되지 않았습니다.');
  assert.deepEqual({
    buffLeft: initialResult.buffLeft,
    buffBottom: initialResult.buffBottom,
    digsiteLeft: initialResult.digsiteLeft,
    digsiteBottom: initialResult.digsiteBottom,
    settingWrites: initialResult.settingWrites,
  }, {
    buffLeft: '980px',
    buffBottom: '80px',
    digsiteLeft: '760px',
    digsiteBottom: '120px',
    settingWrites: 0,
  }, '게임 오버레이 버프 HUD의 저장 좌표가 그대로 적용되지 않았습니다.');

  const hiddenSaveResult = await window.webContents.executeJavaScript(`
    (async () => {
      let editModeCallback = null;
      window.__hudPositionSettingWrites = [];
      window.electronAPI = {
        DEFAULT_CONFIG: {
          xpWidgetPos: { left: 200, bottom: 0 },
          abandonedWidgetPos: { left: 200, bottom: 63 },
          digsiteWidgetPos: { left: 0, bottom: 326 },
          buffTimerHudPos: { left: 350, bottom: 0 },
          forgeQuestHudPos: { left: 50, bottom: 215 },
          todaySummaryHudPos: { left: 0, top: 200 },
        },
        applySettingsConfirmed: async settings => { window.__hudPositionSettingWrites.push(settings); return { success:true }; },
        onGameOverlayEditMode: callback => { editModeCallback = callback; },
        onGameOverlayResetPositions: () => {},
      };
      eval(${JSON.stringify(editModeCode)});
      editModeCallback(true);
      const buff = document.getElementById('buff-hud');
      buff.style.left = '980px';
      buff.style.bottom = '80px';
      buff.classList.add('hidden');
      await editModeCallback(false, true);
      return window.__hudPositionSettingWrites.at(-1)?.buffTimerHudPos;
    })()
  `) as { left: number; bottom: number };
  assert.deepEqual(hiddenSaveResult, { left: 980, bottom: 80 },
    '편집 중 다시 숨겨진 HUD가 실제 CSS 위치 대신 0 rect로 저장되었습니다.');
  await window.webContents.executeJavaScript('window.__hudPositionSettingWrites = []; true;');

  await window.webContents.executeJavaScript(`
    let currentConfig = { digsiteHudEnabled: true };
    let currentDigsiteState = null;
    ${digsiteFunctionMatch[1]}
    window.__testUpdateDigsiteUI = updateDigsiteUI;
    true;
  `);
  const digsiteResult = await window.webContents.executeJavaScript(`
    (() => {
      window.__testUpdateDigsiteUI({
        isActive: true,
        normalRewards: 3,
        portalRewards: 2,
        portalVisits: { 1: true, 2: false, 3: true, 4: false },
        alternateRewards: 1,
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const portal1 = document.getElementById('digsite-portal-1');
      const portal2 = document.getElementById('digsite-portal-2');
      const initiallyHidden = document.getElementById('digsite-widget')?.classList.contains('hidden');
      const portalOrder = Array.from(document.querySelectorAll('.digsite-portals .digsite-portal'))
        .map(item => item.id.replace('digsite-portal-', ''));
      currentConfig = { digsiteHudEnabled: false };
      window.__testUpdateDigsiteUI({
        isActive: true,
        normalRewards: 3,
        portalRewards: 2,
        portalVisits: { 1: true, 2: false, 3: true, 4: false },
        alternateRewards: 1,
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const hiddenWhenDisabled = document.getElementById('digsite-widget')?.classList.contains('hidden');
      currentConfig = { digsiteHudEnabled: true };
      window.__testUpdateDigsiteUI(currentDigsiteState);
      const visibleWhenReenabled = !document.getElementById('digsite-widget')?.classList.contains('hidden');
      return {
        hidden: initiallyHidden,
        hiddenWhenDisabled,
        visibleWhenReenabled,
        portalOrder,
        normal: document.getElementById('digsite-normal-count')?.textContent,
        portal: document.getElementById('digsite-portal-count')?.textContent,
        alternate: document.getElementById('digsite-alternate-count')?.textContent,
        portal1Visited: portal1?.classList.contains('visited'),
        portal1Text: portal1?.lastElementChild?.textContent,
        portal2Visited: portal2?.classList.contains('visited'),
        portal2Text: portal2?.lastElementChild?.textContent,
      };
    })()
  `);
  assert.deepEqual(digsiteResult, {
    hidden: false,
    hiddenWhenDisabled: true,
    visibleWhenReenabled: true,
    portalOrder: ['2', '4', '1', '3'],
    normal: '3/8',
    portal: '2/4',
    alternate: '1/1',
    portal1Visited: true,
    portal1Text: '방문',
    portal2Visited: false,
    portal2Text: '미방문',
  }, '발굴지 현황판이 실시간 상태를 올바르게 표시하지 않습니다.');

  // 재접속·해상도 전환 중 game-overlay viewport가 잠시 작아지는 상황을 실제 renderer resize로 재현합니다.
  window.setContentSize(500, 350);
  await new Promise(resolve => setTimeout(resolve, 50));
  const transientResult = await window.webContents.executeJavaScript(`
    (() => {
      window.applyConfiguredHudPositions(window.__hudPositionConfig);
      const buff = document.getElementById('buff-hud');
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        buffLeft: buff?.style.left,
        buffBottom: buff?.style.bottom,
        settingWrites: window.__hudPositionSettingWrites.length,
      };
    })()
  `) as {
    innerWidth: number;
    innerHeight: number;
    buffLeft?: string;
    buffBottom?: string;
    settingWrites: number;
  };
  assert.ok(transientResult.innerWidth <= 500 && transientResult.innerHeight <= 350,
    '게임 오버레이 과도기 축소 viewport가 실제 renderer에 적용되지 않았습니다.');
  assert.deepEqual({
    buffLeft: transientResult.buffLeft,
    buffBottom: transientResult.buffBottom,
    settingWrites: transientResult.settingWrites,
  }, {
    buffLeft: '980px',
    buffBottom: '80px',
    settingWrites: 0,
  }, '축소된 게임 오버레이가 버프 HUD를 중앙 이동하거나 좌표를 설정에 저장했습니다.');

  window.setContentSize(1200, 800);
  await new Promise(resolve => setTimeout(resolve, 50));
  const restoredPosition = await window.webContents.executeJavaScript(`({
    left: document.getElementById('buff-hud')?.style.left,
    bottom: document.getElementById('buff-hud')?.style.bottom,
    settingWrites: window.__hudPositionSettingWrites.length,
  })`) as { left?: string; bottom?: string; settingWrites: number };
  assert.deepEqual(restoredPosition, { left: '980px', bottom: '80px', settingWrites: 0 },
    '게임 화면 크기 복원 뒤 버프 HUD의 사용자 저장 위치가 유지되지 않았습니다.');
}

async function checkWelcomeGuideTabs(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'welcome-guide.html'));
  const result = await window.webContents.executeJavaScript(`
    (() => {
      const tabLabels = Array.from(document.querySelectorAll('.tab-btn')).map(btn => btn.textContent?.trim());
      const totalPanels = document.querySelectorAll('.content-panel').length;
      
      // Tab 3 (게임 오버레이 HUD) 전환
      switchTab(3);
      const panel3Active = document.getElementById('panel-3')?.classList.contains('active');
      const componentCards = document.querySelectorAll('#panel-3 .feature-bullet').length;

      const settingsRoutes = [];
      window.electronAPI = {
        toggleSettings: (route) => settingsRoutes.push(route)
      };
      switchTab(6);
      openHistoricalChatSyncSettingsDirectly();
      const panel6Active = document.getElementById('panel-6')?.classList.contains('active');
      const historyGuideText = document.getElementById('panel-6')?.textContent || '';

      switchTab(7);
      const panel7Active = document.getElementById('panel-7')?.classList.contains('active');
      const mousePassThroughGuideText = document.getElementById('mouse-pass-through-guide')?.textContent || '';
      const sidebarOverlayControlsImage = document.getElementById('sidebar-overlay-controls-guide-image');
      const tabsOverflowX = getComputedStyle(document.querySelector('.guide-tabs')).overflowX;

      return {
        tabLabels,
        totalPanels,
        panel3Active,
        componentCards,
        panel6Active,
        panel7Active,
        historyGuideText,
        settingsRoutes,
        mousePassThroughGuideText,
        sidebarOverlayControlsImage: {
          src: sidebarOverlayControlsImage?.getAttribute('src'),
          loaded: Boolean(sidebarOverlayControlsImage?.complete && sidebarOverlayControlsImage?.naturalWidth > 0),
          alt: sidebarOverlayControlsImage?.getAttribute('alt'),
        },
        tabsOverflowX
      };
    })()
  `);

  assert.deepEqual(
    result.tabLabels,
    ['시작 마법사', '앱 소개', '필수 설정', '게임 오버레이 HUD', '전체화면 대응 팁', '알람음 설정', '과거 로그 복원', '단축키 요약'],
    '가이드 8개 탭 레이블이 일치하지 않습니다.',
  );
  assert.equal(result.totalPanels, 8, '가이드 패널이 8개가 아닙니다.');
  assert.equal(result.panel3Active, true, '게임 오버레이 탭 전환이 동작하지 않습니다.');
  assert.equal(result.componentCards, 6, '게임 오버레이 6개 컴포넌트 설명 카드가 렌더링되지 않았습니다.');
  assert.equal(result.panel6Active, true, '과거 채팅 로그 복원 탭 전환이 동작하지 않습니다.');
  assert.match(result.historyGuideText, /과거 채팅 로그에서 누락 기록 복원/,
    '과거 채팅 로그 동기화 안내가 렌더링되지 않았습니다.');
  assert.match(result.historyGuideText, /로그 파일이 많으면 분석 중 프로그램이 일시적으로 느려질 수 있습니다/,
    '과거 채팅 로그 대량 분석 중 성능 안내가 렌더링되지 않았습니다.');
  assert.deepEqual(result.settingsRoutes, ['chatlog:history-sync'],
    '과거 채팅 로그 동기화 설정 바로가기가 올바르게 연결되지 않았습니다.');
  assert.equal(result.panel7Active, true, '마지막 단축키 탭 전환이 동작하지 않습니다.');
  assert.match(result.mousePassThroughGuideText, /웹 브라우저 오버레이[\s\S]*채팅 오버레이 메인·보조 1·보조 2/,
    '프로그램 내부 가이드에 마우스 투과 대상 창 안내가 없습니다.');
  assert.match(result.mousePassThroughGuideText, /초록색이면 투과가 켜진 상태[\s\S]*클릭·휠 스크롤·드래그가 게임으로 전달/,
    '프로그램 내부 가이드에 마우스 투과 상태별 동작 안내가 없습니다.');
  assert.match(result.mousePassThroughGuideText, /상단 이동 영역을 드래그[\s\S]*보이기\/숨기기[\s\S]*서로 다른 기능/,
    '프로그램 내부 가이드에 채팅창 이동과 표시 상태 구분 안내가 없습니다.');
  assert.deepEqual(result.sidebarOverlayControlsImage, {
    src: 'assets/img/guide_overlay.png',
    loaded: true,
    alt: '사이드바의 홈, 브라우저 오버레이, 채팅 오버레이, 마우스 투과 버튼 설명',
  }, '프로그램 내부 가이드의 사이드바 버튼 설명 이미지가 올바르게 로드되지 않았습니다.');
  assert.equal(result.tabsOverflowX, 'auto', '가이드 탭이 늘어날 때 가로 스크롤로 접근할 수 없습니다.');
}

async function checkChatOverlayRenderer(window: BrowserWindow): Promise<void> {
  const html = fs.readFileSync(path.join(projectRoot, 'dist', 'chat-overlay.html'), 'utf8')
    .replace('<script src="assets/ui-utils.js"></script>', '')
    .replace('<script src="assets/request-generation.js"></script>', '')
    .replace('<script src="assets/virtual-list.js"></script>', '')
    .replace('<script src="shared/chatChannels.js"></script>', '')
    .replace('<script src="shared/chatConstants.js"></script>', '')
    .replace('<script src="chatOverlayRenderer.js"></script>', '')
    .replace('<script src="renderer/nickname-notes.js"></script>', '');
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const uiUtilsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'assets', 'ui-utils.js'),
    'utf8',
  );
  const requestGenerationCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'assets', 'request-generation.js'),
    'utf8',
  );
  const virtualListCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'assets', 'virtual-list.js'),
    'utf8',
  );
  const rendererCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'chatOverlayRenderer.js'),
    'utf8',
  );
  const chatChannelsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'chatChannels.js'),
    'utf8',
  );
  const chatConstantsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'chatConstants.js'),
    'utf8',
  );

  const testHistory: Record<string, any[]> = {
    Basic: [
      { id: 'c1', type: 'club', timestamp: '23시 25분 42초', sender: '니요', message: '근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?', color: '#94ddfa', level: 1 },
      { id: 's1', type: 'system', timestamp: '23시 25분 43초', sender: '시스템', message: '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.', color: '#a8a8a8', level: null },
      { id: 'g1', type: 'general', timestamp: '23시 25분 44초', sender: '유저1', message: '<img id="injected-chat-xss">안녕하세요', color: '#ffffff', level: null },
      { id: 'sh1', type: 'shout', timestamp: '23시 25분 45초', sender: '소온', message: '베한계 삽니다', color: '#c896c8', level: 5 },
    ],
    Club: [
      { id: 'c1', type: 'club', timestamp: '23시 25분 42초', sender: '니요', message: '근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?', color: '#94ddfa', level: 1 },
    ],
    System: [
      { id: 's1', type: 'system', timestamp: '23시 25분 43초', sender: '시스템', message: '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.', color: '#a8a8a8', level: null },
    ],
    General: [
      { id: 'g1', type: 'general', timestamp: '23시 25분 44초', sender: '유저1', message: '<img id="injected-chat-xss">안녕하세요', color: '#ffffff', level: null },
    ],
    Shout: [
      { id: 'sh1', type: 'shout', timestamp: '23시 25분 45초', sender: '소온', message: '베한계 삽니다', color: '#c896c8', level: 5 },
    ]
  };

  const notesCode = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'nickname-notes.js'), 'utf8');
  const script = `
    (() => {
      try {
        window.lucide = { createIcons() {} };
        window.__chatHistoryRequests = [];
        window.__appliedSettings = [];
        window.__chatSizeCalls = [];
        window.electronAPI = {
          getConfig: async () => ({
            chatOverlayTab: 'Basic',
            chatOverlayOpacity: 100,
            chatOverlayShowNpcChat: true,
            chatOverlaySelectedChannels: ['general', 'whisper', 'team', 'club', 'shout', 'system'],
          }),
          getChatHistory: async (category) => {
            window.__chatHistoryRequests.push(category);
            return (${JSON.stringify(testHistory)})[category] || [];
          },
          getMoreChatHistory: async () => [],
          searchChatLogs: async (query) => [
            { id: 'search-1', type: 'club', timestamp: '23시 25분 42초', sender: '니요', message: '근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?', color: '#94ddfa', level: 1 }
          ],
          onChatUpdated: callback => { window.__chatUpdatedCallback = callback; },
          onChatHistoryCleared: callback => { window.__chatClearedCallback = callback; },
          onConfigData: callback => { window.__configCallback = callback; },
          onChatOverlayMode: callback => { window.__modeCallback = callback; },
          cleanupAllListeners() {},
          setChatOverlaySize: (...args) => window.__chatSizeCalls.push(args),
          applySettings: settings => window.__appliedSettings.push(settings),
          saveNicknameNote: async (...args) => { window.__noteSaved = args; return { success: true }; },
          toggleChatOverlay() {},
          toggleChatOverlaySub() {},
          toggleSettings() {},
        };

        eval(${JSON.stringify(`${uiUtilsCode}\n${requestGenerationCode}\n${virtualListCode}\n${chatChannelsCode}\n${chatConstantsCode}\n${notesCode}\n
          const createChatTestList = window.createVirtualList;
          window.createVirtualList = options => (window.__chatTestList = createChatTestList(options));
          ${rendererCode}`)});

        window.__modeCallback('main');
        window.__configCallback({
          chatOverlayTab: 'Basic',
          chatOverlayOpacity: 100,
          chatOverlayShowNpcChat: true,
          chatOverlaySelectedChannels: ['general', 'whisper', 'team', 'club', 'shout', 'system'],
        });

        return {
          ok: true,
          hasChannels: typeof window.chatChannels !== 'undefined',
          hasConstants: typeof window.chatConstants !== 'undefined',
          historyRequests: window.__chatHistoryRequests,
          initialLoaded: typeof isInitialTabLoaded !== 'undefined' ? isInitialTabLoaded : null,
          currentTab: typeof chatOverlayCurrentTab !== 'undefined' ? chatOverlayCurrentTab : null,
        };
      } catch (error) {
        return { ok: false, error: error && (error.stack || error.message || String(error)) };
      }
    })()
  `;

  const setupResult = await window.webContents.executeJavaScript(script) as {
    ok: boolean;
    error?: string;
    hasChannels?: boolean;
    hasConstants?: boolean;
    historyRequests?: string[];
    initialLoaded?: boolean;
    currentTab?: string;
  };
  assert.equal(setupResult.ok, true, setupResult.error);
  await waitForSelector(window, '.chat-message-row');

  const result = await window.webContents.executeJavaScript(`
    (async () => {
      // 1. Basic 탭 렌더링 상태 추출
      const basicRows = Array.from(document.querySelectorAll('.chat-message-row')).map(row => ({
        badge: row.querySelector('.channel-badge')?.textContent?.trim(),
        badgeClass: row.querySelector('.channel-badge')?.className,
        eta: row.querySelector('.eta-badge')?.textContent?.trim() || null,
        sender: row.querySelector('.chat-sender')?.textContent?.trim(),
        message: row.querySelector('.chat-text')?.textContent?.trim(),
      }));

      const xssAttempt = document.getElementById('injected-chat-xss');

      // 2. Club 탭 전환
      const clubTabBtn = document.querySelector('[data-tab="Club"]');
      clubTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      const clubRows = Array.from(document.querySelectorAll('.chat-message-row')).map(row => ({
        badge: row.querySelector('.channel-badge')?.textContent?.trim(),
        sender: row.querySelector('.chat-sender')?.textContent?.trim(),
        message: row.querySelector('.chat-text')?.textContent?.trim(),
      }));

      // 3. System 탭 전환
      const systemTabBtn = document.querySelector('[data-tab="System"]');
      systemTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      const systemRows = Array.from(document.querySelectorAll('.chat-message-row')).map(row => ({
        badge: row.querySelector('.channel-badge')?.textContent?.trim(),
        sender: row.querySelector('.chat-sender')?.textContent?.trim(),
        message: row.querySelector('.chat-text')?.textContent?.trim(),
      }));

      // 4. 실시간 채팅 수신 (onChatUpdated)
      window.__chatUpdatedCallback({
        id: 'live-sys-1',
        type: 'system',
        timestamp: '23시 30분 00초',
        sender: '시스템',
        message: '실시간 시스템 알림 수신',
        color: '#a8a8a8',
        level: null
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      const liveSystemRows = Array.from(document.querySelectorAll('.chat-message-row')).map(row => ({
        badge: row.querySelector('.channel-badge')?.textContent?.trim(),
        sender: row.querySelector('.chat-sender')?.textContent?.trim(),
        message: row.querySelector('.chat-text')?.textContent?.trim(),
      }));

      // 5. Basic 탭 복귀 후 검색 실행 및 하이라이트 검증
      const basicTabBtn = document.querySelector('[data-tab="Basic"]');
      basicTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));

      const btnToggleSearch = document.getElementById('btnToggleSearch');
      btnToggleSearch?.click();
      const searchContainerVisible = !document.getElementById('searchContainer')?.classList.contains('hidden');
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.value = '시드';
      const btnExecuteSearch = document.getElementById('btnExecuteSearch');
      btnExecuteSearch?.click();
      await new Promise(resolve => setTimeout(resolve, 50));

      const highlightElements = Array.from(document.querySelectorAll('.search-highlight')).map(el => el.textContent);

      // 6. 기본 탭 표시 설정과 숨겨진 저장 탭의 안전 전환
      window.__configCallback({
        chatOverlayTab: 'Basic',
        chatOverlayOpacity: 100,
        chatOverlayClickThrough: true,
        chatOverlayVisibleTabs: ['General', 'Team', 'Club', 'Shout'],
        chatOverlayShowNpcChat: true,
        chatOverlaySelectedChannels: ['general', 'whisper', 'team', 'club', 'shout', 'system'],
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      const visibleBuiltInTabs = Array.from(document.querySelectorAll('.tabs-bar > .tab-item:not(.custom-tab-item)'))
        .filter(tab => !tab.classList.contains('tab-hidden'))
        .map(tab => tab.getAttribute('data-tab'));
      const hiddenSavedTabFallback = document.querySelector('.tab-item.active')?.getAttribute('data-tab');
      const clickThroughClassApplied = document.body.classList.contains('click-through');

      window.__configCallback({
        chatOverlayTab: 'Basic',
        chatOverlayOpacity: 100,
        chatOverlayClickThrough: false,
        chatOverlayVisibleTabs: ['Basic', 'General', 'Whisper', 'Team', 'Club', 'Shout', 'System'],
        chatOverlayShowNpcChat: true,
        chatOverlaySelectedChannels: ['general', 'whisper', 'team', 'club', 'shout', 'system'],
      });
      await new Promise(resolve => setTimeout(resolve, 50));

      return {
        basicRows,
        hasXss: xssAttempt !== null,
        clubRows,
        systemRows,
        liveSystemRows,
        searchContainerVisible,
        highlightElements,
        visibleBuiltInTabs,
        hiddenSavedTabFallback,
        clickThroughClassApplied,
        historyRequests: window.__chatHistoryRequests,
      };
    })()
  `) as {
    basicRows: Array<{ badge: string; badgeClass: string; eta: string | null; sender: string; message: string }>;
    hasXss: boolean;
    clubRows: Array<{ badge: string; sender: string; message: string }>;
    systemRows: Array<{ badge: string; sender: string; message: string }>;
    liveSystemRows: Array<{ badge: string; sender: string; message: string }>;
    searchContainerVisible: boolean;
    highlightElements: string[];
    visibleBuiltInTabs: string[];
    hiddenSavedTabFallback: string;
    clickThroughClassApplied: boolean;
    historyRequests: string[];
  };

  assert.equal(result.hasXss, false, 'HTML/스크립트 인젝션(XSS)이 방어되지 않았습니다.');
  assert.equal(result.basicRows.length, 4, 'Basic 탭에 4개의 채팅이 렌더링되어야 합니다.');

  const clubItem = result.basicRows.find(r => r.sender === '니요');
  assert.ok(clubItem, '클럽 채팅 행이 렌더링되지 않았습니다.');
  assert.equal(clubItem.badge, '클럽', '클럽 배지 텍스트가 일치하지 않습니다.');
  assert.ok(clubItem.badgeClass.includes('badge-club'), '클럽 배지 클래스(badge-club)가 적용되지 않았습니다.');
  assert.equal(clubItem.eta, '에타 1', '에타 레벨 뱃지가 일치하지 않습니다.');
  assert.equal(clubItem.message, '근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?');

  const systemItem = result.basicRows.find(r => r.message.includes('3500만 SEED'));
  assert.ok(systemItem, '시스템 메시지 행이 렌더링되지 않았습니다.');
  assert.equal(systemItem.badge, '시스템');
  assert.equal(systemItem.sender, '시스템');

  assert.equal(result.clubRows.length, 1, 'Club 탭에는 클럽 메시지 1개만 표시되어야 합니다.');
  assert.equal(result.clubRows[0].sender, '니요');
  assert.equal(result.systemRows.length, 1, 'System 탭에는 시스템 메시지 1개만 표시되어야 합니다.');
  assert.equal(result.systemRows[0].sender, '시스템');

  assert.equal(result.liveSystemRows.length, 2, '실시간 시스템 메시지 추가 후 System 탭에 2개 행이 있어야 합니다.');
  assert.equal(result.liveSystemRows[1].message, '실시간 시스템 알림 수신');

  assert.equal(result.searchContainerVisible, true, '검색창이 열리지 않았습니다.');
  assert.ok(result.highlightElements.includes('시드'), '검색어 하이라이트(search-highlight)가 생성되지 않았습니다.');
  assert.deepEqual(result.visibleBuiltInTabs, ['General', 'Team', 'Club', 'Shout'],
    '선택한 기본 채팅 탭만 오버레이 상단에 표시되지 않습니다.');
  assert.equal(result.hiddenSavedTabFallback, 'General',
    '숨긴 탭이 저장 탭일 때 첫 표시 탭으로 안전하게 전환되지 않습니다.');
  assert.equal(result.clickThroughClassApplied, true,
    '마우스 투과 상태를 스크롤 UI에 반영하지 않습니다.');

  const generationResult = await window.webContents.executeJavaScript(`
    (async () => {
      const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
      const rowMessages = () => Array.from(document.querySelectorAll('.chat-message-row'))
        .map(row => row.querySelector('.chat-text')?.textContent?.trim());
      document.getElementById('btnExitSearchMode')?.click();
      await tick();

      window.__pendingHistory = [];
      window.__pendingSearch = [];
      window.electronAPI.getChatHistory = category => new Promise((resolve, reject) => {
        window.__pendingHistory.push({ category, resolve, reject });
      });
      window.electronAPI.searchChatLogs = (query, options) => new Promise((resolve, reject) => {
        window.__pendingSearch.push({ query, options, resolve, reject });
      });

      const historyItem = (id, type, message) => ({
        id, type, timestamp: '23시 40분 00초', sender: type === 'system' ? '시스템' : '테스터',
        message, color: '#ffffff', level: null,
      });
      const requestedHistoryCategories = [];

      document.querySelector('[data-tab="Club"]')?.click();
      const clubHistory = window.__pendingHistory.at(-1);
      requestedHistoryCategories.push(clubHistory?.category);
      document.querySelector('[data-tab="System"]')?.click();
      const systemHistory = window.__pendingHistory.at(-1);
      requestedHistoryCategories.push(systemHistory?.category);
      systemHistory.resolve([historyItem('system-new', 'system', '최신 시스템 이력')]);
      await tick();
      clubHistory.resolve([historyItem('club-old', 'club', '늦은 클럽 이력')]);
      await tick();
      const tabRaceMessages = rowMessages();

      document.querySelector('[data-tab="Club"]')?.click();
      const staleHistory = window.__pendingHistory.at(-1);
      requestedHistoryCategories.push(staleHistory?.category);
      document.getElementById('btnToggleSearch')?.click();
      const searchInput = document.getElementById('searchInput');
      searchInput.value = 'needle';
      document.getElementById('btnExecuteSearch')?.click();
      const searchAfterHistory = window.__pendingSearch.at(-1);
      staleHistory.resolve([historyItem('stale-history', 'club', '검색을 덮으면 안 되는 이력')]);
      await tick();
      const searchStatusAfterStaleHistory = document.getElementById('searchResultText')?.textContent;
      searchAfterHistory.resolve([historyItem('search-new', 'club', 'needle 최신 검색')]);
      await tick();
      const searchRaceMessages = rowMessages();

      searchInput.value = 'old-query';
      document.getElementById('btnExecuteSearch')?.click();
      const oldSearch = window.__pendingSearch.at(-1);
      searchInput.value = 'new-query';
      document.getElementById('btnExecuteSearch')?.click();
      const newSearch = window.__pendingSearch.at(-1);
      oldSearch.reject(new Error('stale search rejection'));
      await tick();
      const statusAfterStaleReject = document.getElementById('searchResultText')?.textContent;
      newSearch.resolve([historyItem('new-search', 'club', 'new-query 최신 결과')]);
      await tick();
      const latestSearchMessages = rowMessages();

      searchInput.value = 'closing';
      document.getElementById('btnExecuteSearch')?.click();
      const closingSearch = window.__pendingSearch.at(-1);
      document.getElementById('btnExitSearchMode')?.click();
      const historyAfterClose = window.__pendingHistory.at(-1);
      requestedHistoryCategories.push(historyAfterClose?.category);
      closingSearch.reject(new Error('closed search rejection'));
      await tick();
      const statusHiddenAfterClose = document.getElementById('searchStatusBar')?.classList.contains('hidden');
      historyAfterClose.resolve([historyItem('close-history', 'club', '검색 닫은 뒤 이력')]);
      await tick();
      const closeRaceMessages = rowMessages();
      const highlightCountAfterClose = document.querySelectorAll('.search-highlight').length;

      document.querySelector('[data-tab="System"]')?.click();
      const historyWithLive = window.__pendingHistory.at(-1);
      requestedHistoryCategories.push(historyWithLive?.category);
      window.__chatUpdatedCallback(historyItem('live-during-history', 'system', '요청 중 실시간 이벤트'));
      await tick(50);
      historyWithLive.resolve([historyItem('history-after-live', 'system', '실시간 뒤 정상 이력 응답')]);
      await tick();
      const liveDoesNotInvalidateMessages = rowMessages();

      return {
        pendingHistoryCategories: requestedHistoryCategories,
        tabRaceMessages,
        searchStatusAfterStaleHistory,
        searchRaceMessages,
        statusAfterStaleReject,
        latestSearchMessages,
        statusHiddenAfterClose,
        closeRaceMessages,
        highlightCountAfterClose,
        liveDoesNotInvalidateMessages,
      };
    })()
  `) as {
    pendingHistoryCategories: string[];
    tabRaceMessages: string[];
    searchStatusAfterStaleHistory: string;
    searchRaceMessages: string[];
    statusAfterStaleReject: string;
    latestSearchMessages: string[];
    statusHiddenAfterClose: boolean;
    closeRaceMessages: string[];
    highlightCountAfterClose: number;
    liveDoesNotInvalidateMessages: string[];
  };

  assert.deepEqual(generationResult.pendingHistoryCategories, ['Club', 'System', 'Club', 'Club', 'System']);
  assert.deepEqual(generationResult.tabRaceMessages, ['최신 시스템 이력'],
    '늦은 이전 탭 history가 최신 탭 화면을 덮었습니다.');
  assert.equal(generationResult.searchStatusAfterStaleHistory, '"needle" 검색 중...',
    '이전 history 응답이 진행 중인 검색 상태를 덮었습니다.');
  assert.deepEqual(generationResult.searchRaceMessages, ['needle 최신 검색']);
  assert.equal(generationResult.statusAfterStaleReject, '"new-query" 검색 중...',
    '이전 검색 reject/finally가 최신 검색 상태를 덮었습니다.');
  assert.deepEqual(generationResult.latestSearchMessages, ['new-query 최신 결과']);
  assert.equal(generationResult.statusHiddenAfterClose, true,
    '닫힌 검색의 늦은 reject가 검색 상태 표시를 다시 노출했습니다.');
  assert.deepEqual(generationResult.closeRaceMessages, ['검색 닫은 뒤 이력']);
  assert.equal(generationResult.highlightCountAfterClose, 0,
    '검색 종료 후 새 history DOM에 이전 검색 강조 클래스가 남았습니다.');
  assert.ok(generationResult.liveDoesNotInvalidateMessages.includes('실시간 뒤 정상 이력 응답'),
    '실시간 이벤트가 정상 history 요청을 무효화했습니다.');

  const virtualizationResult = await window.webContents.executeJavaScript(`
    (async () => {
      const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
      const waitForTopToSettle = async selector => {
        let previous;
        let stableSamples = 0;
        let current;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await tick(50);
          current = document.querySelector(selector)?.getBoundingClientRect().top;
          if (typeof current === 'number' && typeof previous === 'number'
            && Math.abs(current - previous) <= 0.1) {
            stableSamples += 1;
          } else {
            stableSamples = 0;
          }
          previous = current;
          if (attempt >= 4 && stableSamples >= 4) return current;
        }
        return current;
      };
      const chatArea = document.getElementById('chatArea');
      const makeItem = (prefix, index, type = 'general') => ({
        id: prefix + '-' + index,
        type,
        timestamp: '23시 ' + String(index % 60).padStart(2, '0') + '분 00초',
        sender: '가상화테스터' + (index % 7),
        message: index % 9 === 0
          ? '가변 높이 메시지 '.repeat(18) + index
          : '일반 메시지 ' + index,
        color: '#ffffff',
        level: null,
      });

      window.__pendingMore = [];
      window.electronAPI.getMoreChatHistory = category => new Promise((resolve, reject) => {
        window.__pendingMore.push({ category, resolve, reject });
      });

      document.querySelector('[data-tab="Basic"]')?.click();
      const largeHistoryRequest = window.__pendingHistory.at(-1);
      const largeItems = Array.from({ length: 20000 }, (_, index) => makeItem('large', index));
      largeHistoryRequest.resolve(largeItems);
      await tick(180);

      const initialDomCount = chatArea.querySelectorAll('.chat-message-row').length;
      const initialHeight = Number.parseFloat(document.querySelector('.virtual-list-content')?.style.height || '0');
      const latestVisibleInitially = document.querySelector('[data-chat-id="large-19999"]') !== null;

      chatArea.scrollTop = 0;
      chatArea.dispatchEvent(new Event('scroll'));
      await tick(100);
      const areaTop = chatArea.getBoundingClientRect().top;
      const anchorElement = Array.from(chatArea.querySelectorAll('.chat-message-row'))
        .map(row => ({ row, rect: row.getBoundingClientRect() }))
        .filter(entry => entry.rect.bottom > areaTop)
        .sort((a, b) => a.rect.top - b.rect.top)[0];
      const anchorId = anchorElement?.row.dataset.chatId;
      const anchorBefore = anchorElement?.rect.top;
      const olderRequest = window.__pendingMore[0];
      const olderItems = Array.from({ length: 150 }, (_, index) => makeItem('older', index));
      olderRequest.resolve(olderItems);
      await tick(180);

      const anchorAfter = anchorId
        ? document.querySelector('[data-chat-id="' + CSS.escape(anchorId) + '"]')?.getBoundingClientRect().top
        : undefined;
      const prependedDomCount = chatArea.querySelectorAll('.chat-message-row').length;
      const heightAfterPrepend = Number.parseFloat(document.querySelector('.virtual-list-content')?.style.height || '0');

      window.electronAPI.getMoreChatHistory = async () => [];
      chatArea.scrollTop = chatArea.scrollHeight;
      chatArea.dispatchEvent(new Event('scroll'));
      await tick(100);
      const latestVisibleAfterPrepend = document.querySelector('[data-chat-id="large-19999"]') !== null;
      const bottomDomCount = chatArea.querySelectorAll('.chat-message-row').length;

      chatArea.scrollTop = 0;
      chatArea.dispatchEvent(new Event('scroll'));
      await tick(100);
      const oldestVisibleAfterReturn = document.querySelector('[data-chat-id="older-0"]') !== null;
      const topDomCount = chatArea.querySelectorAll('.chat-message-row').length;
      const resizeAnchorBefore = await waitForTopToSettle('[data-chat-id="older-0"]');
      chatArea.style.width = '320px';
      const resizeAnchorNarrow = await waitForTopToSettle('[data-chat-id="older-0"]');
      chatArea.style.width = '';
      const resizeAnchorRestored = await waitForTopToSettle('[data-chat-id="older-0"]');
      const oldestTopBeforeLive = resizeAnchorRestored;

      for (let index = 0; index < 1000; index += 1) {
        window.__chatUpdatedCallback(makeItem('live-bulk', index));
      }
      const oldestTopAfterLive = await waitForTopToSettle('[data-chat-id="older-0"]');
      const heightAfterLive = Number.parseFloat(document.querySelector('.virtual-list-content')?.style.height || '0');
      const liveAtTopDomCount = chatArea.querySelectorAll('.chat-message-row').length;

      chatArea.scrollTop = chatArea.scrollHeight;
      chatArea.dispatchEvent(new Event('scroll'));
      await tick(100);
      const newestLiveVisible = document.querySelector('[data-chat-id="live-bulk-999"]') !== null;
      const liveBottomDomCount = chatArea.querySelectorAll('.chat-message-row').length;

      return {
        initialDomCount,
        initialHeight,
        latestVisibleInitially,
        anchorId,
        anchorBefore,
        anchorAfter,
        prependedDomCount,
        heightAfterPrepend,
        latestVisibleAfterPrepend,
        oldestVisibleAfterReturn,
        bottomDomCount,
        topDomCount,
        oldestTopBeforeLive,
        oldestTopAfterLive,
        resizeAnchorBefore,
        resizeAnchorNarrow,
        resizeAnchorRestored,
        heightAfterLive,
        liveAtTopDomCount,
        newestLiveVisible,
        liveBottomDomCount,
      };
    })()
  `) as {
    initialDomCount: number;
    initialHeight: number;
    latestVisibleInitially: boolean;
    anchorId?: string;
    anchorBefore?: number;
    anchorAfter?: number;
    prependedDomCount: number;
    heightAfterPrepend: number;
    latestVisibleAfterPrepend: boolean;
    oldestVisibleAfterReturn: boolean;
    bottomDomCount: number;
    topDomCount: number;
    oldestTopBeforeLive?: number;
    oldestTopAfterLive?: number;
    resizeAnchorBefore?: number;
    resizeAnchorNarrow?: number;
    resizeAnchorRestored?: number;
    heightAfterLive: number;
    liveAtTopDomCount: number;
    newestLiveVisible: boolean;
    liveBottomDomCount: number;
  };

  assert.ok(virtualizationResult.initialDomCount > 0 && virtualizationResult.initialDomCount < 300,
    `20,000개 데이터의 실제 DOM 행 수가 제한되지 않았습니다: ${virtualizationResult.initialDomCount}`);
  assert.ok(virtualizationResult.initialHeight > 400_000,
    '가상 목록 전체 스크롤 높이가 메모리 데이터 수를 반영하지 않았습니다.');
  assert.equal(virtualizationResult.latestVisibleInitially, true,
    '초기 history 로드 뒤 최신 행으로 이동하지 않았습니다.');
  assert.equal(virtualizationResult.anchorId, 'large-0',
    '최상단 이동 뒤 첫 메모리 행을 렌더링하지 않았습니다.');
  assert.equal(typeof virtualizationResult.anchorBefore, 'number', 'prepend 전 앵커 위치를 측정하지 못했습니다.');
  assert.equal(typeof virtualizationResult.anchorAfter, 'number', 'prepend 후 같은 앵커 행을 찾지 못했습니다.');
  assert.ok(Math.abs(virtualizationResult.anchorAfter! - virtualizationResult.anchorBefore!) <= 2,
    `과거 150개 prepend 뒤 앵커 행이 이동했습니다: ${virtualizationResult.anchorBefore} → ${virtualizationResult.anchorAfter}`);
  assert.ok(virtualizationResult.heightAfterPrepend > virtualizationResult.initialHeight,
    '과거 탐색 결과가 가상 목록의 전체 데이터 높이에 추가되지 않았습니다.');
  assert.ok(virtualizationResult.prependedDomCount < 300
    && virtualizationResult.bottomDomCount < 300
    && virtualizationResult.topDomCount < 300,
  '스크롤/과거 탐색 중 실제 DOM 행 수가 overscan 상한을 벗어났습니다.');
  assert.equal(virtualizationResult.latestVisibleAfterPrepend, true,
    '과거 탐색 후 최신 구간으로 돌아왔을 때 최신 메모리 데이터가 누락됐습니다.');
  assert.equal(virtualizationResult.oldestVisibleAfterReturn, true,
    '최신 구간 복귀 뒤 다시 위로 이동했을 때 prepend 데이터가 누락됐습니다.');
  assert.equal(typeof virtualizationResult.oldestTopBeforeLive, 'number');
  assert.equal(typeof virtualizationResult.oldestTopAfterLive, 'number');
  assert.ok(Math.abs(virtualizationResult.oldestTopAfterLive! - virtualizationResult.oldestTopBeforeLive!) <= 2,
    `과거 탐색 중 live append가 현재 스크롤 앵커를 이동시켰습니다: ${virtualizationResult.oldestTopBeforeLive} → ${virtualizationResult.oldestTopAfterLive}`);
  assert.equal(typeof virtualizationResult.resizeAnchorBefore, 'number');
  assert.equal(typeof virtualizationResult.resizeAnchorNarrow, 'number');
  assert.equal(typeof virtualizationResult.resizeAnchorRestored, 'number');
  assert.ok(Math.abs(virtualizationResult.resizeAnchorNarrow! - virtualizationResult.resizeAnchorBefore!) <= 2
    && Math.abs(virtualizationResult.resizeAnchorRestored! - virtualizationResult.resizeAnchorBefore!) <= 2,
  `채팅 폭 변경과 높이 재측정 중 현재 앵커 행이 이동했습니다: ${virtualizationResult.resizeAnchorBefore} → ${virtualizationResult.resizeAnchorNarrow} → ${virtualizationResult.resizeAnchorRestored}`);
  assert.ok(virtualizationResult.heightAfterLive > virtualizationResult.heightAfterPrepend,
    'live 1,000건이 메모리 가상 목록에 보존되지 않았습니다.');
  assert.equal(virtualizationResult.newestLiveVisible, true,
    '과거 탐색 후 최신 구간으로 돌아왔을 때 새 live 데이터가 누락됐습니다.');
  assert.ok(virtualizationResult.liveAtTopDomCount < 300 && virtualizationResult.liveBottomDomCount < 300,
    'live 1,000건 추가 후 실제 DOM 행 수가 overscan 상한을 벗어났습니다.');
  const typography = await window.webContents.executeJavaScript(`
    (() => {
      const config = { chatOverlayTab: 'Basic', chatOverlayFontSize: 15, chatOverlayFontFamily: 'malgun', chatOverlaySubFontSize: 22, chatOverlaySubFontFamily: 'gulim', chatOverlaySub2FontSize: 0, chatOverlaySub2FontFamily: '' };
      window.__configCallback(config);
      const read = () => ({ size: document.documentElement.style.getPropertyValue('--font-size-base'), family: document.body.style.fontFamily });
      window.__modeCallback('main'); const main = read();
      window.__modeCallback('sub1'); const sub1 = read();
      window.__modeCallback('sub2'); const sub2 = read();
      return { main, sub1, sub2 };
    })()
  `);
  assert.equal(typography.main.size, '15px');
  assert.equal(typography.sub1.size, '22px');
  assert.match(typography.sub1.family, /Gulim/);
  assert.deepEqual(typography.sub2, typography.main, '보조 창의 미설정 글꼴은 메인 설정을 상속해야 합니다.');

  const shoutFiltering = await window.webContents.executeJavaScript(`
    (async () => {
      const rows = ['free', 'paid', 'notice'].map(kind => ({ id: 'kind-' + kind, type: 'shout', shoutKind: kind, sender: kind, message: kind, timestamp: '12시 00분 00초', color: '#c896c8', level: null }));
      window.electronAPI.getChatHistory = async () => rows;
      window.__modeCallback('main');
      window.__configCallback({ chatOverlayTab: 'Basic', chatOverlayShowFreeShout: false, chatOverlayShowPaidShout: true, chatOverlayShowNoticeShout: false });
      await new Promise(resolve => setTimeout(resolve, 160));
      const filtered = Array.from(document.querySelectorAll('.chat-message-row'), row => row.dataset.chatId);
      window.__configCallback({ chatOverlayTab: 'Basic', chatOverlayShowFreeShout: true, chatOverlayShowPaidShout: true, chatOverlayShowNoticeShout: true });
      await new Promise(resolve => setTimeout(resolve, 160));
      return { filtered, restored: document.querySelectorAll('.chat-message-row').length };
    })()
  `);
  assert.deepEqual(shoutFiltering.filtered, ['kind-paid']);
  assert.equal(shoutFiltering.restored, 3, '필터를 다시 켜면 기존 외치기가 복원되어야 합니다.');

  const noteResult = await window.webContents.executeJavaScript(`
    (async () => {
      const row = { id: 'note-user', type: 'general', sender: 'Tester', message: '안녕하세요', timestamp: '12시 00분 00초', color: '#ffffff', level: 10 };
      window.electronAPI.getChatHistory = async () => [row];
      const notes = [{ server: 7, nickname: 'Tester', note: '<img id="note-xss">거래했던 분' }, { server: 16, nickname: 'Tester', note: '네냐플 메모' }];
      window.__configCallback({ userServer: 7, chatOverlayTab: 'Basic', nicknameNotes: notes });
      await new Promise(resolve => setTimeout(resolve, 180));
      const first = document.querySelector('.nickname-note-badge')?.textContent;
      const injected = Boolean(document.getElementById('note-xss'));
      const sender = document.querySelector('[data-note-nickname="Tester"]');
      sender.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const opened = document.querySelector('.nickname-note-dialog').open;
      document.getElementById('note-text').value = '새 메모';
      document.querySelector('.nickname-note-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 30));
      window.__configCallback({ userServer: 16, chatOverlayTab: 'Basic', nicknameNotes: notes.map(note => ({ ...note })) });
      await new Promise(resolve => setTimeout(resolve, 180));
      return { first, injected, opened, saved: window.__noteSaved, second: document.querySelector('.nickname-note-badge')?.textContent };
    })()
  `);
  assert.equal(noteResult.first, '<img id="note-xss">거래했던 분');
  assert.equal(noteResult.injected, false);
  assert.equal(noteResult.opened, true);
  assert.deepEqual(noteResult.saved, [7, 'Tester', '새 메모']);
  assert.equal(noteResult.second, '네냐플 메모');

  const searchRefresh = await window.webContents.executeJavaScript(`
    (async () => {
      const pause = () => new Promise(resolve => setTimeout(resolve, 160));
      const rows = ['free', 'paid'].map(kind => ({ id: 'search-' + kind, type: 'shout', shoutKind: kind,
        sender: kind, message: '매물 ' + kind, timestamp: '12시 00분 00초', color: '#c896c8', level: null }));
      let config = { userServer: 7, chatOverlayTab: 'Basic', nicknameNotes: [], chatOverlayShowFreeShout: true, chatOverlayShowPaidShout: true };
      let historyCalls = 0;
      const queries = [];
      window.electronAPI.getChatHistory = async () => { historyCalls++; return [{ ...rows[0], id: 'unrelated', message: '다른 물건' }]; };
      window.electronAPI.searchChatLogs = async query => { queries.push(query); return rows; };
      window.electronAPI.saveNicknameNote = async (server, nickname, note) => {
        config = { ...config, nicknameNotes: [{ server, nickname, note }] };
        window.__configCallback(config);
        return { success: true };
      };
      window.__configCallback(config);
      await pause();
      document.getElementById('btnToggleSearch').click();
      document.getElementById('searchInput').value = '매물';
      document.getElementById('btnExecuteSearch').click();
      await pause();
      const historyBeforeSave = historyCalls;
      // 입력창만 고친 미실행 검색어가 아닌 현재 실행 중인 검색어를 유지한다.
      document.getElementById('searchInput').value = '아직 실행하지 않은 검색어';
      document.querySelector('[data-note-nickname="free"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      document.getElementById('note-text').value = '거래 메모';
      document.querySelector('.nickname-note-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await pause();
      const read = () => ({ ids: Array.from(document.querySelectorAll('.chat-message-row'), row => row.dataset.chatId),
        status: document.getElementById('searchResultText').textContent, note: document.querySelector('.nickname-note-badge')?.textContent });
      const afterSave = read();
      config = { ...config, chatOverlayShowPaidShout: false };
      window.__configCallback(config);
      await pause();
      const afterFilter = read();
      const pending = [];
      window.electronAPI.searchChatLogs = query => new Promise(resolve => pending.push({ query, resolve }));
      config = { ...config, chatOverlayShowPaidShout: true };
      window.__configCallback(config);
      config = { ...config, chatOverlayShowFreeShout: false };
      window.__configCallback(config);
      pending[1].resolve([rows[1]]);
      await pause();
      pending[0].resolve([{ ...rows[1], id: 'stale', message: '오래된 응답' }]);
      await pause();
      const afterRace = read();
      const historyAfterRefresh = historyCalls;
      document.getElementById('btnExitSearchMode').click();
      await pause();
      return { afterSave, afterFilter, afterRace, historyBeforeSave, historyAfterRefresh, historyAfterExit: historyCalls, queries,
        pendingQueries: pending.map(request => request.query), searchHidden: document.getElementById('searchStatusBar').classList.contains('hidden') };
    })()
  `);
  assert.deepEqual(searchRefresh.afterSave.ids, ['search-free', 'search-paid']);
  assert.equal(searchRefresh.afterSave.note, '거래 메모');
  assert.equal(searchRefresh.afterSave.status, '검색 결과: 2건 ("매물")');
  assert.deepEqual(searchRefresh.afterFilter.ids, ['search-free']);
  assert.equal(searchRefresh.afterFilter.status, '검색 결과: 1건 ("매물")');
  assert.deepEqual(searchRefresh.afterRace.ids, ['search-paid'], '이전 설정으로 시작한 검색 응답이 최신 결과를 덮으면 안 됩니다.');
  assert.equal(searchRefresh.afterRace.status, '검색 결과: 1건 ("매물")');
  assert.deepEqual(searchRefresh.queries, ['매물', '매물'], '메모 표시는 검색을 다시 실행하지 않습니다.');
  assert.deepEqual(searchRefresh.pendingQueries, ['매물', '매물']);
  assert.equal(searchRefresh.historyBeforeSave, searchRefresh.historyAfterRefresh, '검색 중 메모/필터 갱신은 일반 이력을 요청하지 않습니다.');
  assert.equal(searchRefresh.historyAfterExit, searchRefresh.historyBeforeSave + 1);
  assert.equal(searchRefresh.searchHidden, true);

  // 자정/로그 재연결 이벤트는 세 채팅창 모두 실행한 검색 조건을 유지한다.
  // 이벤트 처리와 렌더링은 실제 코드, 조회 응답만 지연시켜 이전 요청과의 경합을 검사한다.
  const resetSearch = await window.webContents.executeJavaScript(`
    (async () => {
      const pause = () => new Promise(resolve => setTimeout(resolve, 80));
      const results = [];
      const row = (id, message) => ({ id, type: 'general', sender: '모험가', message,
        timestamp: '00시 01분 00초', color: '#ffffff' });
      for (const mode of ['main', 'sub1', 'sub2']) {
        const pending = [];
        let historyCalls = 0;
        window.electronAPI.getChatHistory = async () => { historyCalls++; return [row('unrelated', '일반 이력')]; };
        window.electronAPI.getMoreChatHistory = async () => [];
        window.electronAPI.searchChatLogs = query => new Promise(resolve => pending.push({ query, resolve }));
        window.__modeCallback(mode);
        window.__configCallback({ chatOverlayTab: 'Basic', chatOverlaySubTab: 'Basic', chatOverlaySub2Tab: 'Basic' });
        await pause();
        document.getElementById('btnToggleSearch').click();
        document.getElementById('searchInput').value = '갱신 대상';
        document.getElementById('btnExecuteSearch').click();
        const beforeReset = historyCalls;
        document.getElementById('searchInput').value = '아직 실행하지 않은 입력';
        window.__chatUpdatedCallback(row('queued-old', '갱신 대상 이전 파일의 대기 행'));
        window.__chatClearedCallback();
        if (pending.length !== 2) throw new Error(mode + ': 초기화가 검색을 다시 요청하지 않음');
        pending[1].resolve([row('current', '갱신 대상 새 파일')]);
        await pause();
        pending[0].resolve([row('stale', '갱신 대상 이전 응답')]);
        await pause();
        results.push({ mode, queries: pending.map(request => request.query),
          historyUnchanged: beforeReset === historyCalls,
          ids: Array.from(document.querySelectorAll('.chat-message-row'), row => row.dataset.chatId),
          status: document.getElementById('searchResultText').textContent,
          draft: document.getElementById('searchInput').value });
        document.getElementById('btnExitSearchMode').click();
        await pause();
      }
      return results;
    })()
  `);
  for (const result of resetSearch) {
    assert.deepEqual(result.queries, ['갱신 대상', '갱신 대상'], result.mode);
    assert.equal(result.historyUnchanged, true, result.mode);
    assert.deepEqual(result.ids, ['current'], result.mode);
    assert.equal(result.status, '검색 결과: 1건 ("갱신 대상")', result.mode);
    assert.equal(result.draft, '아직 실행하지 않은 입력', result.mode);
  }

  const filteredPagination = await window.webContents.executeJavaScript(`
    (async () => {
      const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
      const until = async (condition, label) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (condition()) return;
          await pause();
        }
        throw new Error('필터 페이지 대기 실패: ' + label);
      };
      const area = document.getElementById('chatArea');
      area.style.height = '240px';
      area.style.flex = 'none';
      const make = (id, kind = 'free', type = 'shout') => ({ id, type, shoutKind: kind,
        sender: '페이지 검사', message: id, timestamp: '12시 00분 00초', color: '#c896c8', level: null });
      const batch = (prefix, kind = 'paid') => Array.from({ length: 150 }, (_, index) => make(prefix + index, kind));
      const hidden = batch('숨김-');
      const config = { userServer: 7, chatOverlayTab: 'Basic', nicknameNotes: [],
        chatOverlayVisibleTabs: ['Basic', 'General', 'Shout'], chatOverlaySelectedChannels: ['general', 'shout'],
        chatOverlayShowFreeShout: true, chatOverlayShowPaidShout: false, chatOverlayShowNoticeShout: false };
      const ids = () => Array.from(area.querySelectorAll('.chat-message-row'), row => row.dataset.chatId);
      let calls = 0;
      let pages = [batch('숨김1-'), batch('숨김2-'), [make('가장 오래된 무료')]];
      window.electronAPI.getChatHistory = async () => hidden;
      window.electronAPI.getMoreChatHistory = async () => { calls++; return pages.shift() || []; };
      window.__configCallback(config);
      document.querySelector('[data-tab="Basic"]').click();
      await until(() => ids().includes('가장 오래된 무료'), '빈 첫 화면 자동 채우기');
      await pause(100);
      const emptyInitial = { ids: ids(), calls, scrollable: area.scrollHeight > area.clientHeight };
      // 표시 설정을 다시 켜면 최초 원본 페이지도 복원한다.
      window.__configCallback({ ...config, chatOverlayShowPaidShout: true });
      await until(() => ids().some(id => id.startsWith('숨김-')), '필터 해제');
      const restoredPaid = ids().some(id => id.startsWith('숨김-'));

      calls = 0;
      pages = [[make('중간 무료'), ...hidden.slice(1)], batch('오래된 무료-', 'free')];
      window.electronAPI.getChatHistory = async () => [make('최신 무료')];
      window.__configCallback(config);
      await until(() => calls === 2 && area.scrollHeight > area.clientHeight, '짧은 첫 화면 채우기');
      await pause(100);
      const shortInitial = { calls, ids: ids(), scrollable: area.scrollHeight > area.clientHeight };

      // 스크롤 가능한 화면의 위쪽에서 숨긴 페이지를 만나도 추가 휠 입력 없이 넘긴다.
      calls = 0;
      pages = [batch('위 숨김1-'), batch('위 숨김2-'), [make('위쪽 무료')]];
      window.electronAPI.getChatHistory = async () => batch('현재-', 'free');
      document.querySelector('[data-tab="Basic"]').click();
      await until(() => ids().includes('현재-149'), '스크롤 초기 이력');
      await pause(100);
      const callsBeforeScroll = calls;
      let releaseScrollPage;
      const nextPage = window.electronAPI.getMoreChatHistory;
      window.electronAPI.getMoreChatHistory = async () => {
        await new Promise(resolve => { releaseScrollPage = resolve; });
        window.electronAPI.getMoreChatHistory = nextPage;
        return nextPage();
      };
      area.scrollTop = 0;
      area.dispatchEvent(new Event('scroll'));
      await until(() => releaseScrollPage && area.querySelector('[data-chat-id="현재-0"]'), '가상 목록의 위쪽 앵커');
      await pause(150);
      const anchorBefore = area.querySelector('[data-chat-id="현재-0"]')?.getBoundingClientRect().top;
      releaseScrollPage();
      await until(() => ids().includes('위쪽 무료'), '스크롤 중 숨긴 페이지');
      await pause(150);
      const scrolled = { calls, anchorBefore,
        anchorAfter: area.querySelector('[data-chat-id="현재-0"]')?.getBoundingClientRect().top };

      // 전부 숨겨진 경우에도 원본 끝에서 멈추고 중복 스크롤로 재조회하지 않는다.
      calls = 0;
      pages = [hidden, hidden, []];
      window.electronAPI.getChatHistory = async () => hidden;
      document.querySelector('[data-tab="Basic"]').click();
      await until(() => calls === 3, '모든 기록 숨김');
      await pause(100);
      area.dispatchEvent(new Event('scroll'));
      await pause(100);
      const allHidden = { ids: ids(), calls };

      const cancelled = [];
      for (const change of ['config', 'tab', 'search']) {
        window.__configCallback(config);
        let resolveOld;
        let oldCalls = 0;
        window.electronAPI.getChatHistory = async category => category === 'General'
          ? [make('새 탭', 'free', 'general')] : hidden;
        window.electronAPI.getMoreChatHistory = () => { oldCalls++; return new Promise(resolve => { resolveOld = resolve; }); };
        document.querySelector('[data-tab="Basic"]').click();
        await until(() => resolveOld, change + ' 전환 전 요청');
        window.electronAPI.getMoreChatHistory = async () => [];
        if (change === 'config') window.__configCallback({ ...config, chatOverlayShowPaidShout: true });
        if (change === 'tab') document.querySelector('[data-tab="General"]').click();
        if (change === 'search') {
          window.electronAPI.searchChatLogs = async () => [make('검색 결과')];
          document.getElementById('searchInput').value = '검색';
          document.getElementById('btnExecuteSearch').click();
        }
        await pause(100);
        resolveOld(batch('오래된 응답-', 'free'));
        await pause(100);
        cancelled.push({ change, oldCalls, ids: ids() });
        if (change === 'search') { document.getElementById('btnExitSearchMode').click(); await pause(100); }
      }

      // 채우는 도중 도착한 실시간 기록도 과거 응답과 함께 유지한다.
      let resolveLivePage;
      window.electronAPI.getChatHistory = async () => hidden;
      window.electronAPI.getMoreChatHistory = () => new Promise(resolve => { resolveLivePage = resolve; });
      document.querySelector('[data-tab="Basic"]').click();
      await until(() => resolveLivePage, '실시간 수신 전 요청');
      window.__chatUpdatedCallback(make('실시간 무료'));
      await pause(100);
      resolveLivePage([make('과거 무료')]);
      await until(() => ids().includes('과거 무료') && ids().includes('실시간 무료'), '실시간 기록 보존');
      return { emptyInitial, restoredPaid, shortInitial, callsBeforeScroll, scrolled, allHidden, cancelled, liveIds: ids() };
    })()
  `);
  assert.deepEqual(filteredPagination.emptyInitial, { ids: ['가장 오래된 무료'], calls: 3, scrollable: false });
  assert.equal(filteredPagination.restoredPaid, true);
  assert.equal(filteredPagination.shortInitial.calls, 2);
  assert.equal(filteredPagination.shortInitial.scrollable, true);
  assert.ok(filteredPagination.shortInitial.ids.includes('최신 무료'));
  assert.equal(filteredPagination.callsBeforeScroll, 0);
  assert.equal(filteredPagination.scrolled.calls, 3);
  assert.equal(typeof filteredPagination.scrolled.anchorBefore, 'number');
  assert.ok(Math.abs(filteredPagination.scrolled.anchorAfter - filteredPagination.scrolled.anchorBefore) <= 2,
    `숨긴 페이지를 넘기는 동안 기존 채팅 행의 화면 위치가 바뀌었습니다: ${JSON.stringify(filteredPagination.scrolled)}`);
  assert.deepEqual(filteredPagination.allHidden, { ids: [], calls: 3 });
  for (const result of filteredPagination.cancelled) {
    assert.equal(result.oldCalls, 1);
    assert.ok(!result.ids.some((id: string) => id.startsWith('오래된 응답-')), `${result.change} 변경 후 이전 추가 이력이 섞였습니다.`);
    assert.ok(result.ids.length > 0);
  }
  assert.deepEqual(filteredPagination.liveIds, ['과거 무료', '실시간 무료']);

  await window.webContents.insertCSS(fs.readFileSync(path.join(projectRoot, 'dist', 'style.css'), 'utf8'));
  const appearanceState = await window.webContents.executeJavaScript(`
    (async () => {
      const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
      const until = async (condition, label) => {
        for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await pause(30); }
        throw new Error('표시 설정 검사 대기 실패: ' + label);
      };
      const area = document.getElementById('chatArea');
      area.style.height = '240px';
      area.style.flex = 'none';
      const list = window.__chatTestList;
      const make = n => ({ id: 'memo-' + n, type: 'shout', shoutKind: 'free', sender: '거래상대',
        message: '매물 확인 ' + n, timestamp: '12시 00분 00초', color: '#c896c8', level: 10 });
      const batch = start => Array.from({ length: 150 }, (_, i) => make(start + i));
      const anchor = () => {
        const top = area.getBoundingClientRect().top;
        const row = Array.from(area.querySelectorAll('.chat-message-row')).find(el => el.getBoundingClientRect().bottom > top + 1);
        return { id: row?.dataset.chatId, top: row?.getBoundingClientRect().top };
      };
      const savedAnchor = reference => ({ id: reference.id,
        top: area.querySelector('[data-chat-id="' + reference.id + '"]')?.getBoundingClientRect().top });
      const snapshots = [];
      let config;
      for (const mode of ['main', 'sub1', 'sub2']) {
        config = { userServer: 7, nicknameNotes: [], chatOverlayTab: 'Shout', chatOverlaySubTab: 'Shout', chatOverlaySub2Tab: 'Shout',
          chatOverlayVisibleTabs: ['Basic', 'Shout'], chatOverlaySelectedChannels: ['shout'], chatOverlayCustomTabs: [],
          chatOverlayShowFreeShout: true, chatOverlayShowPaidShout: true, chatOverlayShowNoticeShout: true, chatOverlayClickThrough: false };
        let historyCalls = 0;
        let moreCalls = 0;
        let resolvePage;
        window.electronAPI.getChatHistory = async () => { historyCalls++; return batch(300); };
        window.electronAPI.getMoreChatHistory = async () => {
          moreCalls++;
          if (moreCalls === 1) return batch(150);
          if (moreCalls === 2) return new Promise(resolve => { resolvePage = resolve; });
          return [];
        };
        window.electronAPI.saveNicknameNote = async (server, nickname, note) => {
          config = { ...config, nicknameNotes: note ? [{ server, nickname, note }] : [] };
          window.__configCallback(config);
          return { success: true };
        };
        window.__modeCallback(mode);
        window.__configCallback(config);
        document.querySelector('[data-tab="Shout"]').click();
        await until(() => list.getItems().length === 150, mode + ' 최초 이력');
        await pause();
        area.scrollTop = 0;
        area.dispatchEvent(new Event('scroll'));
        await until(() => list.getItems().length === 300, mode + ' 과거 페이지');
        area.scrollTop = 700;
        area.dispatchEvent(new Event('scroll'));
        await pause(180);
        // 숨긴 Electron 창에서는 native scroll 통지가 늦을 수 있다. 화면 밖의 오래된
        // 가상 행을 기준으로 잡지 않고 실제 표시 행이 준비된 뒤 동일한 위치 단언을 적용한다.
        await until(() => {
          const candidate = anchor(), bounds = area.getBoundingClientRect();
          return candidate.id && Number.isFinite(candidate.top) && candidate.top < bounds.bottom;
        }, mode + ' 스크롤 후 표시 행');
        const before = { count: list.getItems().length, historyCalls, moreCalls, anchor: anchor() };
        const edit = text => {
          document.querySelector('[data-note-nickname="거래상대"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          document.getElementById('note-text').value = text;
          document.querySelector('.nickname-note-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        };
        edit('거래 기록과 다음 약속 '.repeat(12));
        await pause(220);
        const afterSave = { count: list.getItems().length, historyCalls, moreCalls, anchor: savedAnchor(before.anchor),
          note: document.querySelector('.nickname-note-badge')?.textContent };
        // 다른 창의 변경과 서버별 메모/색상도 기존 페이지와 읽던 행을 보존한다.
        config = { ...config, userServer: 16, nicknameNotes: [{ server: 16, nickname: '거래상대', note: '다른 창의 메모' }],
          chatOverlayColorShout: '#123456', chatEtaColorsEnabled: true, chatEtaColors: ['#abcdef', '#abcdef', '#abcdef', '#abcdef', '#abcdef'] };
        window.__configCallback(config);
        await pause(180);
        const afterExternal = { count: list.getItems().length, historyCalls, moreCalls, anchor: savedAnchor(before.anchor),
          note: document.querySelector('.nickname-note-badge')?.textContent,
          nicknameColor: document.querySelector('.chat-sender')?.style.color, etaColor: document.querySelector('.eta-badge')?.style.color };
        window.__configCallback({ ...config, chatNicknameNotesCompact: true });
        await until(() => document.querySelector('.nickname-note-badge')?.textContent === '메모', mode + ' 메모 텍스트 갱신');
        await pause(180);
        const currentAnchor = savedAnchor(before.anchor);
        if (document.querySelector('.nickname-note-badge')?.textContent !== '메모'
          || list.getItems().length !== before.count || historyCalls !== before.historyCalls || moreCalls !== before.moreCalls
          || currentAnchor.id !== afterExternal.anchor.id
          || Math.abs((currentAnchor.top ?? 0) - (afterExternal.anchor.top ?? 0)) > 2) throw new Error(mode + ' 간단 표시가 과거 이력/스크롤을 변경했습니다.');
        window.__configCallback({ ...config, chatNicknameNotesCompact: false });
        await until(() => document.querySelector('.nickname-note-badge')?.textContent !== '메모', mode + ' 메모 복원');
        await pause(180);
        window.__configCallback({ ...config, chatCompactDisplay: true });
        await pause(180);
        if (list.getItems().length !== before.count || historyCalls !== before.historyCalls || moreCalls !== before.moreCalls
          || Math.abs(savedAnchor(before.anchor).top - before.anchor.top) > 2
          || !Array.from(document.querySelectorAll('.chat-timestamp,.eta-badge')).every(node=>getComputedStyle(node).display==='none')
          || !document.querySelector('.channel-badge')) throw new Error(mode + ' 채팅 간단 표시가 이력/위치/채널을 변경했습니다.');
        window.__configCallback({ ...config, chatCompactDisplay: false });
        await pause(180);
        // 실패는 config-data를 발생시키지 않고 현재 메모·목록·편집 초안을 유지한다.
        const successfulSave = window.electronAPI.saveNicknameNote;
        window.electronAPI.saveNicknameNote = async () => ({ success: false, error: '저장 실패 검사' });
        edit('저장 실패 초안');
        await pause();
        const failure = { count: list.getItems().length, historyCalls, anchor: savedAnchor(before.anchor),
          text: document.getElementById('note-text').value, error: document.getElementById('note-save-error').textContent,
          note: document.querySelector('.nickname-note-badge')?.textContent };
        document.getElementById('note-cancel').click();
        window.electronAPI.saveNicknameNote = successfulSave;
        // 진행 중인 과거 페이지 요청은 메모 삭제로 무효화하지 않는다. 같은 프레임의 실시간 수신도 유지한다.
        area.scrollTop = 0;
        area.dispatchEvent(new Event('scroll'));
        await until(() => resolvePage, '두 번째 페이지 요청');
        await pause(180);
        const pageAnchor = anchor();
        document.querySelector('[data-note-nickname="거래상대"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        document.getElementById('note-remove').click();
        window.__chatUpdatedCallback(make(450));
        await pause();
        resolvePage(batch(0));
        await until(() => list.getItems().length === 451, '대기 페이지와 실시간 수신');
        await pause(150);
        const afterPage = { count: list.getItems().length, first: list.getItems()[0].id, last: list.getItems().at(-1).id,
          historyCalls, moreCalls, anchor: savedAnchor(pageAnchor), noteCount: area.querySelectorAll('.nickname-note-badge').length };
        list.scrollToEnd();
        await pause();
        edit('맨 아래의 메모');
        window.__chatUpdatedCallback(make(451));
        await until(() => list.getItems().length === 452, '맨 아래 실시간 수신');
        await pause(150);
        snapshots.push({ mode, before, afterSave, afterExternal, failure, pageAnchor, afterPage, atEnd: list.isAtEnd(2) });
      }
      // 검색 결과에서 긴 목록을 읽다가 메모를 바꾸어도 재검색·강조·스크롤 변화가 없다.
      let searches = 0;
      let resolveSearch;
      window.electronAPI.searchChatLogs = () => { searches++; return new Promise(resolve => { resolveSearch = resolve; }); };
      document.getElementById('searchInput').value = '매물';
      document.getElementById('btnExecuteSearch').click();
      await until(() => resolveSearch, '검색 요청');
      window.__configCallback({ userServer: 16, nicknameNotes: [{server:16,nickname:'거래상대',note:'검색 대기 중 변경'}],
        chatOverlayTab:'Shout', chatOverlaySubTab:'Shout', chatOverlaySub2Tab:'Shout', chatOverlayVisibleTabs:['Basic','Shout'],
        chatOverlaySelectedChannels:['shout'],chatOverlayCustomTabs:[],chatOverlayShowFreeShout:true,
        chatOverlayShowPaidShout:true,chatOverlayShowNoticeShout:true,chatOverlayClickThrough:false });
      resolveSearch(batch(0));
      await until(() => list.getItems().length === 150, '검색 결과');
      area.scrollTop = 700;
      await pause(180);
      const searchAnchor = anchor();
      document.querySelector('[data-note-nickname="거래상대"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      document.getElementById('note-text').value = '검색 저장';
      document.querySelector('.nickname-note-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await pause(180);
      const search = { searches, count: list.getItems().length, anchorBefore: searchAnchor, anchorAfter: savedAnchor(searchAnchor),
        status: document.getElementById('searchResultText').textContent,
        highlight: document.querySelector('.search-highlight')?.textContent, note: document.querySelector('.nickname-note-badge')?.textContent };
      window.__configCallback({ ...config, chatCompactDisplay: true });
      await pause(180);
      if (searches !== search.searches || list.getItems().length !== search.count || !document.querySelector('.search-highlight')
        || Math.abs(savedAnchor(searchAnchor).top - search.anchorAfter.top) > 2) throw new Error('채팅 간단 표시가 검색 결과/강조/위치를 변경했습니다.');
      return { snapshots, search };
    })()
  `);
  const assertAnchor = (before: { id: string; top: number }, after: { id: string; top: number }, label: string): void => {
    assert.equal(after.id, before.id, label);
    assert.ok(Number.isFinite(after.top) && Math.abs(after.top - before.top) <= 2,
      `${label}: ${JSON.stringify({ before, after })}`);
  };
  for (const row of appearanceState.snapshots) {
    for (const state of [row.afterSave, row.afterExternal, row.failure]) {
      assert.equal(state.count, 300, `${row.mode}: 표시 설정은 불러온 과거 페이지를 보존해야 합니다.`);
      assert.equal(state.historyCalls, row.before.historyCalls, `${row.mode}: 메모 갱신이 최초 이력을 다시 조회했습니다.`);
      assertAnchor(row.before.anchor, state.anchor, `${row.mode}: 메모 변경 후 읽던 위치`);
    }
    assert.equal(row.afterSave.moreCalls, row.before.moreCalls);
    assert.equal(row.afterExternal.moreCalls, row.before.moreCalls);
    assert.equal(row.afterSave.note, '거래 기록과 다음 약속 '.repeat(12));
    assert.equal(row.afterExternal.note, '다른 창의 메모');
    assert.equal(row.afterExternal.nicknameColor, 'rgb(18, 52, 86)');
    assert.equal(row.afterExternal.etaColor, 'rgb(171, 205, 239)');
    assert.equal(row.failure.note, '다른 창의 메모');
    assert.equal(row.failure.text, '저장 실패 초안');
    assert.equal(row.failure.error, '저장 실패 검사');
    assert.equal(row.afterPage.count, 451);
    assert.equal(row.afterPage.first, 'memo-0');
    assert.equal(row.afterPage.last, 'memo-450');
    assert.equal(row.afterPage.historyCalls, row.before.historyCalls);
    assert.equal(row.afterPage.moreCalls, 2);
    assert.equal(row.afterPage.noteCount, 0);
    assertAnchor(row.pageAnchor, row.afterPage.anchor, `${row.mode}: 메모 삭제 중 과거 응답`);
    assert.equal(row.atEnd, true, `${row.mode}: 맨 아래를 보던 창은 계속 끝을 따라가야 합니다.`);
  }
  assert.equal(appearanceState.search.searches, 1, '메모 갱신은 진행 중이거나 완료된 검색을 재실행하지 않습니다.');
  assert.equal(appearanceState.search.count, 150);
  assert.equal(appearanceState.search.status, '검색 결과: 150건 ("매물")');
  assert.equal(appearanceState.search.highlight, '매물');
  assert.equal(appearanceState.search.note, '검색 저장');
  assertAnchor(appearanceState.search.anchorBefore, appearanceState.search.anchorAfter, '검색 중 메모 저장 위치');

}

function cleanHtmlForTest(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .replace(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*["'][^>]*><\/script>/gi, '');

}

/** 공통 CSS를 실제로 적용해 토큰·컨트롤 크기를 검사한다. data URL의 상대 경로에 의존하지 않는다. */
function cleanStyledHtmlForTest(filePath: string): string {
  return cleanHtmlForTest(filePath).replace(/<link[^>]*href="style.css"[^>]*>/,
    () => `<style>${fs.readFileSync(path.join(projectRoot, 'dist', 'style.css'), 'utf8')}</style>`);
}

async function evaluate<T>(
  window: BrowserWindow,
  fn: () => T | Promise<T>
): Promise<T> {
  const code = `(${fn.toString()})()`;
  return window.webContents.executeJavaScript(code);
}

async function checkDiaryRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'diary.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const diaryLogUtilsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'diary', 'log-utils.js'),
    'utf8',
  );
  const lootSplitPaneCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'diary', 'loot-split-pane.js'),
    'utf8',
  );
  const safetyResult = await window.webContents.executeJavaScript(`
    (() => {
      eval(${JSON.stringify(diaryLogUtilsCode)});
      const payload = '<img id="injected-diary-xss">[</span><svg id="injected-diary-tag">]';
      const container = document.createElement('div');
      container.innerHTML = window.diaryLogUtils.formatLogContent(payload);
      return {
        text: container.textContent,
        injectedCount: container.querySelectorAll(
          '#injected-diary-xss, #injected-diary-tag'
        ).length,
        badgeCount: container.querySelectorAll('.char-badge').length,
      };
    })()
  `) as { text: string; injectedCount: number; badgeCount: number };

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const hasCalendarGrid = document.querySelector('.calendar-grid') !== null;
    const hasMonthlyTotalSeed = document.getElementById('monthly-total-seed-badge') !== null;
    const hasMonthlyTotalLoot = document.getElementById('monthly-total-loot-badge') !== null;
    const hasStatsAttendance = document.getElementById('stats-attendance') !== null;
    const hasLootHistoryTab = document.getElementById('tab-btn-loot') !== null;
    const hasLootHistoryList = document.getElementById('loot-history-list') !== null;
    const hasLootItemSummaryList = document.getElementById('loot-item-summary-list') !== null;
    const hasLootItemSummaryTypes = document.getElementById('loot-item-summary-types') !== null;
    const lootSplitContainer = document.getElementById('loot-split-container');
    const lootPaneResizer = document.getElementById('loot-pane-resizer');
    const lootDailyPane = document.getElementById('loot-daily-pane');
    const badge = document.createElement('div');
    badge.className = 'loot-badge';
    document.body.appendChild(badge);
    const badgeStyle = getComputedStyle(badge);

    return {
      title,
      hasCalendarGrid,
      hasMonthlyTotalSeed,
      hasMonthlyTotalLoot,
      hasStatsAttendance,
      hasLootHistoryTab,
      hasLootHistoryList,
      hasLootItemSummaryList,
      hasLootItemSummaryTypes,
      hasLootSplitContainer: lootSplitContainer !== null,
      hasLootDailyPane: lootDailyPane !== null,
      lootPaneResizerRole: lootPaneResizer?.getAttribute('role') || '',
      lootPaneResizerOrientation: lootPaneResizer?.getAttribute('aria-orientation') || '',
      lootPaneResizerTabIndex: lootPaneResizer?.tabIndex ?? -1,
      lootBadgeFlexShrink: badgeStyle.flexShrink,
      lootBadgeMinHeight: badgeStyle.minHeight,
    };
  });

  const splitPaneResult = await window.webContents.executeJavaScript(`
    (() => {
      const container = document.getElementById('loot-split-container');
      const summary = document.getElementById('loot-summary-pane');
      const resizer = document.getElementById('loot-pane-resizer');
      const daily = document.getElementById('loot-daily-pane');
      container.style.height = '600px';
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      summary.style.flex = '0 0 auto';
      resizer.style.height = '20px';
      daily.style.flex = '1 1 auto';
      daily.style.minHeight = '210px';

      eval(${JSON.stringify(lootSplitPaneCode)});
      window.diaryLootSplitPane.refresh();
      const initialHeight = window.diaryLootSplitPane.getHeight();
      resizer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 7,
        clientY: 100,
      }));
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 7,
        clientY: 180,
      }));
      window.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 7,
        clientY: 180,
      }));
      const draggedHeight = window.diaryLootSplitPane.getHeight();
      resizer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));

      return {
        initialHeight,
        draggedHeight,
        keyboardHeight: window.diaryLootSplitPane.getHeight(),
        summaryStyleHeight: summary.style.height,
        ariaValueNow: resizer.getAttribute('aria-valuenow'),
        isDragging: resizer.classList.contains('is-dragging'),
        bodyUserSelect: document.body.style.userSelect,
        bodyCursor: document.body.style.cursor,
      };
    })()
  `) as {
    initialHeight: number;
    draggedHeight: number;
    keyboardHeight: number;
    summaryStyleHeight: string;
    ariaValueNow: string | null;
    isDragging: boolean;
    bodyUserSelect: string;
    bodyCursor: string;
  };

  assert.ok(result.title.includes('모험 일지'), '모험 일지 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasCalendarGrid, true, '캘린더 그리드가 렌더링되지 않았습니다.');
  assert.equal(result.hasMonthlyTotalSeed, true, '월간 총 SEED 배지가 없습니다.');
  assert.equal(result.hasMonthlyTotalLoot, true, '월간 총 득템 배지가 없습니다.');
  assert.equal(result.hasStatsAttendance, true, '통계 출석 일수 요소가 없습니다.');
  assert.equal(result.hasLootHistoryTab, true, '주간/월간 득템 기록 탭이 없습니다.');
  assert.equal(result.hasLootHistoryList, true, '득템 기록 목록 컨테이너가 없습니다.');
  assert.equal(result.hasLootItemSummaryList, true, '득템 기록의 품목별 합계 목록이 없습니다.');
  assert.equal(result.hasLootItemSummaryTypes, true, '득템 기록의 품목 종류 합계가 없습니다.');
  assert.equal(result.hasLootSplitContainer, true, '득템 기록의 분할 영역 컨테이너가 없습니다.');
  assert.equal(result.hasLootDailyPane, true, '득템 기록의 일자별 기록 영역이 없습니다.');
  assert.equal(result.lootPaneResizerRole, 'separator', '득템 기록 구분선의 접근성 역할이 없습니다.');
  assert.equal(result.lootPaneResizerOrientation, 'horizontal', '득템 기록 구분선 방향이 올바르지 않습니다.');
  assert.equal(result.lootPaneResizerTabIndex, 0, '득템 기록 구분선을 키보드로 조절할 수 없습니다.');
  assert.equal(result.lootBadgeFlexShrink, '0', '달력 득템 행이 항목 수에 따라 찌그러질 수 있습니다.');
  assert.equal(result.lootBadgeMinHeight, '18px', '달력 득템 행의 최소 높이가 보장되지 않습니다.');
  assert.deepEqual(splitPaneResult, {
    initialHeight: 158,
    draggedHeight: 238,
    keyboardHeight: 222,
    summaryStyleHeight: '222px',
    ariaValueNow: '222',
    isDragging: false,
    bodyUserSelect: '',
    bodyCursor: '',
  }, '득템 기록 구분선의 마우스 드래그·키보드 조절 또는 드래그 종료 복원이 깨졌습니다.');
  assert.deepEqual(safetyResult, {
    text: '<img id="injected-diary-xss"></span><svg id="injected-diary-tag">',
    injectedCount: 0,
    badgeCount: 1,
  }, '모험일지 로그 문자열이 HTML 요소나 inline handler로 해석됐습니다.');
}

async function checkShoutHistoryRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'shout-history.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const hasHistoryList = document.getElementById('history-list') !== null;
    const hasCopyToast = document.getElementById('copy-toast') !== null;
    const hasSearchInput = document.getElementById('search-input') !== null || document.querySelector('input') !== null;

    return {
      title,
      hasHistoryList,
      hasCopyToast,
      hasSearchInput
    };
  });

  assert.ok(result.title.includes('외치기'), '외치기 히스토리 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasHistoryList, true, '외치기 목록 컨테이너가 없습니다.');
  assert.equal(result.hasCopyToast, true, '복사 토스트 요소가 없습니다.');
  assert.equal(result.hasSearchInput, true, '검색 입력창이 없습니다.');
}

async function checkXpHudRenderer(window: BrowserWindow): Promise<void> {
  const xpHudPath = path.join(projectRoot, 'dist', 'xp-hud.html');
  const fullHtml = fs.readFileSync(xpHudPath, 'utf8');
  const updateStatsMatch = fullHtml.match(
    /(function updateStats\(data, isInitial = false\) \{[\s\S]*?\r?\n    \})\r?\n    \/\/ ── 이벤트 리스너/,
  );
  assert.ok(updateStatsMatch, '경험치 HUD 갱신 함수를 추출하지 못했습니다.');
  const efficiencyMatch = fullHtml.match(/(function updateEfficiency\(state\) \{[\s\S]*?\r?\n    \})/);
  assert.ok(efficiencyMatch, '경험치 감소 상태 함수를 추출하지 못했습니다.');
  const html = cleanHtmlForTest(xpHudPath);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await window.webContents.executeJavaScript(`
    (() => {
      let _startTime = Date.now();
      let _accumulatedTime = 0;
      let _isActive = false;
      let _pauseReason = 'manual';
      const xpChart = null;
      const lucide = { createIcons() {} };
      const formatStartTime = () => '테스트 시작';
      const formatXP = value => String(value);
      ${efficiencyMatch[1]}
      ${updateStatsMatch[1]}
      updateStats({
        total: 10000000000,
        epm: 1000000000,
        movingEpm: 1000000000,
        history: [],
        kills: 1,
        essenceCount: 0,
        xpSinceLastExchange: 10000000000,
        isActive: true,
        startTime: Date.now(),
        accumulatedTime: 0,
      }, true);
      return {
        title: document.querySelector('.win-title-main')?.textContent?.trim() || '',
        hasStatGrid: document.querySelector('.stat-grid-top') !== null,
        hasChart: document.querySelector('.chart-container') !== null,
        essenceEta: document.getElementById('stat-essence-eta')?.textContent?.trim() || '',
        essenceProgressWidth: document.getElementById('essence-progress')?.style.width || '',
      };
    })()
  `) as {
    title: string;
    hasStatGrid: boolean;
    hasChart: boolean;
    essenceEta: string;
    essenceProgressWidth: string;
  };

  assert.ok(result.title.includes('경험치 HUD'), '경험치 HUD 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasStatGrid, true, '경험치 HUD 수치 그리드가 렌더링되지 않았습니다.');
  assert.equal(result.hasChart, true, '경험치 차트 컨테이너가 렌더링되지 않았습니다.');
  assert.equal(result.essenceEta, '교환 확인 필요',
    '100억 경고 경계에서 HUD가 음수 남은 시간 또는 잘못된 상태를 표시합니다.');
  assert.equal(result.essenceProgressWidth, '100%',
    '100억 경고 경계에서 경험의 정수 진행도가 가득 차지 않았습니다.');
}

async function checkHuntingAssistRenderer(window: BrowserWindow): Promise<void> {
  const overlayPath = path.join(projectRoot, 'dist', 'game-overlay.html');
  const script = fs.readFileSync(path.join(projectRoot, 'dist', 'renderer', 'game-overlay', 'hunting-assist.js'), 'utf8');
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cleanStyledHtmlForTest(overlayPath))}`);
  window.setContentSize(1200, 800);
  await window.webContents.executeJavaScript(`
    window.__clock = 1000000;
    Date.now = () => window.__clock;
    window.electronAPI = {
      getBossEntryWindows: async () => [],
      onBossEntryUpdate: callback => window.__entryUpdate = callback,
      onXpEfficiencyAlert: callback => window.__xpWarning = callback,
    };
    ${script}
    true;
  `);
  const result = await window.webContents.executeJavaScript(`(() => {
    __entryUpdate([{ id:'first', name:'혼란한 대지', opensAt:800000, closesAt:1040000 }, { id:'second', name:'파멸의 기원', opensAt:900000, closesAt:1260000 }]);
    __xpWarning({ at:__clock, average:5000000, current:3800000, dropPercent:24 });
    window.huntingAssist.updateXp({ isActive:false, pauseReason:'idle', efficiency:{ status:'low' } });
    return {
      cards: document.querySelectorAll('#boss-entry-list > section').length,
      urgent: document.querySelectorAll('#boss-entry-list > .urgent').length,
      time: document.querySelector('.boss-entry-time').textContent,
      warningVisible: !document.getElementById('xp-efficiency-alert').hidden,
      comparison: document.getElementById('xp-efficiency-alert-comparison').textContent,
      idle: document.getElementById('xp-activity-label').textContent,
      bossColor: getComputedStyle(document.querySelector('.hunting-assist-label')).color,
      xpColor: getComputedStyle(document.querySelector('#xp-efficiency-alert .hunting-assist-label')).color,
      radius: getComputedStyle(document.querySelector('.hunting-assist-card')).borderRadius,
      background: getComputedStyle(document.querySelector('.hunting-assist-card')).backgroundColor,
    };
  })()`);
  assert.equal(result.cards, 2);
  assert.equal(result.urgent, 1);
  assert.match(result.time, /0:40/);
  assert.equal(result.warningVisible, true);
  assert.match(result.comparison, /5,000,000.*3,800,000.*24%/);
  assert.match(result.idle, /자동 휴식/);
  assert.equal(result.bossColor, 'rgb(248, 113, 113)', '보스 안내는 디자인 토큰의 빨강을 사용해야 합니다.');
  assert.equal(result.xpColor, 'rgb(96, 165, 250)', '경험치 안내는 디자인 토큰의 파랑을 사용해야 합니다.');
  assert.equal(result.radius, '12px');
  assert.equal(result.background, 'rgba(15, 18, 30, 0.96)');
  if (process.env.TW_HUNTING_CAPTURE_DIR) {
    fs.mkdirSync(process.env.TW_HUNTING_CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.TW_HUNTING_CAPTURE_DIR, 'hunting-overlay.png'), (await window.webContents.capturePage()).toPNG());
  }
  const afterDismissal = await window.webContents.executeJavaScript(`(() => {
    // 종료 시각 전 메인에서 해당 회차를 제거했을 때 다른 카드와 경험치 경고는 유지한다.
    __entryUpdate([{ id:'first', name:'혼란한 대지', opensAt:800000, closesAt:1040000 }]);
    return {
      names: Array.from(document.querySelectorAll('#boss-entry-list .hunting-assist-label')).map(node => node.textContent),
      warningVisible: !document.getElementById('xp-efficiency-alert').hidden,
    };
  })()`);
  assert.deepEqual(afterDismissal.names, ['혼란한 대지']);
  assert.equal(afterDismissal.warningVisible, true);
  if (process.env.TW_HUNTING_CAPTURE_DIR) {
    fs.writeFileSync(path.join(process.env.TW_HUNTING_CAPTURE_DIR, 'origin-dismissed.png'), (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(`__entryUpdate([]); true`);
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('boss-entry-list').children.length`), 0,
    '마감 전에도 마지막 안내가 즉시 제거되어야 합니다.');
  await window.webContents.executeJavaScript(`window.__clock = 1300000; window.huntingAssist.updateConfig({ xpEfficiencyAlertEnabled:false }); true`);
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('boss-entry-list').children.length`), 0);
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('xp-efficiency-alert').hidden`), true);

  // 상세 창의 실제 인라인 코드와 버튼을 실행해 수동 정지·설정 저장·기준 재설정을 확인한다.
  const xpPath = path.join(projectRoot, 'dist', 'xp-hud.html');
  const source = fs.readFileSync(xpPath, 'utf8');
  const inline = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).at(-1)!;
  let html = cleanHtmlForTest(xpPath);
  html = html.replace(/<link[^>]*href="style.css"[^>]*>/, `<style>${fs.readFileSync(path.join(projectRoot, 'dist', 'style.css'), 'utf8')}</style>`);
  const essenceIcon = fs.readFileSync(path.join(projectRoot, 'dist', 'assets', 'img', '경험의정수.png')).toString('base64');
  html = html.split('src="assets/img/경험의정수.png"').join(`src="data:image/png;base64,${essenceIcon}"`);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.setContentSize(420, 940);
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(projectRoot, 'dist', 'assets', 'tailwind.min.js'), 'utf8'));
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(projectRoot, 'dist', 'assets', 'lucide.min.js'), 'utf8'));
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(projectRoot, 'dist', 'assets', 'chart.umd.min.js'), 'utf8'));
  await window.webContents.executeJavaScript(`
    window.__calls = [];
    window.electronAPI = {
      onXpUpdate: callback => window.__xpUpdate = callback,
      onXpResetDone: callback => window.__xpReset = callback,
      onConfigData: callback => window.__config = callback,
      onHighlightAlarmSettings: callback => window.__highlightAlarm = callback,
      applySettings: patch => window.__calls.push(patch),
      stopXpSession: () => window.__calls.push('stop'),
      startXpSession: () => window.__calls.push('start'),
      resetXpEfficiencyBaseline: () => window.__calls.push('baseline'),
      resetXp: () => window.__calls.push('reset'),
    };
    window.loadSoundList = async () => [{ name:'기본 알림', file:'orb.mp3' }, { name:'소리 없음', file:'none' }];
    window.refreshIcons = () => lucide.createIcons();
    window.highlightElement = element => window.__highlighted = element.id;
    ${inline}
    true;
  `);
  await window.webContents.executeJavaScript(`window.__config({ xpAutoPauseEnabled:true, xpAutoPauseSeconds:60, xpEfficiencyAlertEnabled:true, xpEfficiencyDropPercent:20, xpEfficiencyAlertVolume:0, xpEfficiencyAlertSound:'none' })`);
  const overview = await window.webContents.executeJavaScript(`(() => {
    refreshIcons();
    initChart();
    window.__exampleStats = { total:4860000000, epm:135000000, movingEpm:150000000, kills:972, essenceCount:0, xpSinceLastExchange:4860000000, accumulatedTime:1944000, startTime:Date.now(), history:Array.from({length:30}, (_,i) => i === 29 ? 150000000 : 135000000 + Math.round(Math.sin(i * .6) * 25000000)), isActive:true, pauseReason:null, efficiency:{ status:'ready', average:5000000, sampleCount:240, warmupSeconds:0, warning:null } };
    __xpUpdate(__exampleStats);
    document.getElementById('elapsed-timer').textContent = '00:32:24';
    const alwaysVisible = ['stat-total','stat-epm','stat-moving-epm','stat-essence-per-hour','stat-essence-eta','stat-essence-count','stat-kills','stat-xp-per-kill','stat-start-time','elapsed-timer','xpChart','btn-reset','xp-reset-baseline','xp-efficiency-comparison'];
    return { settingsHidden:document.getElementById('view-settings').hidden, visible:alwaysVisible.filter(id => document.getElementById(id).getBoundingClientRect().height > 0).length, control:document.getElementById('session-control-label').textContent, lastChartValue:xpChart.data.datasets[0].data.at(-1) };
  })()`);
  assert.deepEqual(overview, { settingsHidden:true, visible:14, control:'일시정지', lastChartValue:150000000 }, '기존 수치·그래프·초기화·사냥 기준이 처음부터 보여야 합니다.');
  await waitForRendererCondition(window, `xpChart.getDatasetMeta(0).data.every(point => point.y < xpChart.chartArea.bottom - 20)`, '경험치 데이터가 실제 그래프 선의 위치에 반영되지 않았습니다.');
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  assert.equal(await window.webContents.executeJavaScript(`(() => { const scroller = document.querySelector('.scroll-area'); return scroller.scrollWidth <= scroller.clientWidth + 1 && document.getElementById('xpChart').getBoundingClientRect().bottom < innerHeight; })()`), true, '기본 창에서 그래프를 바로 볼 수 있어야 합니다.');
  if (process.env.TW_HUNTING_CAPTURE_DIR) fs.writeFileSync(path.join(process.env.TW_HUNTING_CAPTURE_DIR, 'xp-restored.png'), (await window.webContents.capturePage()).toPNG());
  const settings = await window.webContents.executeJavaScript(`(() => {
    __xpUpdate({ isActive:false, pauseReason:'idle', efficiency:{ status:'warming', warmupSeconds:60, sampleCount:0, average:0, warning:null } });
    document.getElementById('btn-session-control').click();
    __xpUpdate({ isActive:false, pauseReason:'manual' });
    document.getElementById('btn-session-control').click();
    document.getElementById('xp-reset-baseline').click();
    document.getElementById('btn-reset').click();
    document.getElementById('tab-settings').click();
    const threshold = document.getElementById('xp-efficiency-percent');
    threshold.value = '10'; threshold.dispatchEvent(new Event('change'));
    __xpUpdate({ isActive:true, pauseReason:null, efficiency:{ status:'low', average:5000000, sampleCount:240, warmupSeconds:0, warning:{ average:5000000, current:3800000, dropPercent:24 } } });
    document.getElementById('hunting-activity-settings').scrollIntoView();
    return { calls:__calls, sound:document.getElementById('xp-efficiency-sound').value, volume:document.getElementById('xp-efficiency-volume').value, comparison:document.getElementById('xp-efficiency-comparison').textContent };
  })()`);
  assert.deepEqual(settings.calls, ['stop', 'start', 'baseline', 'reset', { xpEfficiencyDropPercent:10 }]);
  assert.equal(settings.sound, 'none');
  assert.equal(settings.volume, '0');
  assert.match(settings.comparison, /5,000,000.*3,800,000.*24%/);
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('view-measure').hidden`), true, '측정 갱신이나 경고가 설정 탭을 강제로 바꾸면 안 됩니다.');
  assert.equal(await window.webContents.executeJavaScript(`['toggle-xp-auto-start','xp-auto-pause','xp-idle-seconds','xp-efficiency-enabled','xp-efficiency-percent','xp-efficiency-sound','xp-efficiency-preview','xp-efficiency-volume','toggle-essence-alert','essence-alert-sound','btn-essence-preview','essence-alert-volume','toggle-show','toggle-ignore-negative','pos-left','pos-bottom','btn-apply-pos'].every(id => { const element = document.getElementById(id); return element && element.getBoundingClientRect().height > 0 && !element.closest('details'); })`), true, '설정 탭의 기존 항목과 알림음·음량을 중첩된 접기 안에 숨기면 안 됩니다.');
  if (process.env.TW_HUNTING_CAPTURE_DIR) {
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
      document.getElementById('hunting-activity-settings').scrollIntoView();
      requestAnimationFrame(() => resolve(true));
    }))`);
    fs.writeFileSync(path.join(process.env.TW_HUNTING_CAPTURE_DIR, 'xp-restored-settings.png'), (await window.webContents.capturePage()).toPNG());
  }
  const navigation = await window.webContents.executeJavaScript(`(() => {
    document.getElementById('tab-settings').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}));
    const measureFocused = document.activeElement.id === 'tab-measure';
    const warningVisible = !document.getElementById('xp-efficiency-comparison').hidden;
    __highlightAlarm();
    return { measureFocused, warningVisible, settingsSelected:document.getElementById('tab-settings').getAttribute('aria-selected'), highlighted:window.__highlighted };
  })()`);
  assert.deepEqual(navigation, { measureFocused:true, warningVisible:true, settingsSelected:'true', highlighted:'essence-alert-settings-section' });
  await window.webContents.executeJavaScript(`showXpView('measure'); true;`);
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('xpChart').getBoundingClientRect().width > 100`), true, '설정에서 측정으로 돌아와도 차트 크기가 유지되어야 합니다.');
  if (process.env.TW_HUNTING_CAPTURE_DIR) {
    await window.webContents.executeJavaScript(`__xpUpdate({...__exampleStats, efficiency:{ status:'low', average:5000000, sampleCount:240, warmupSeconds:0, warning:{ average:5000000, current:3800000, dropPercent:24 } }}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    fs.writeFileSync(path.join(process.env.TW_HUNTING_CAPTURE_DIR, 'xp-restored-warning.png'), (await window.webContents.capturePage()).toPNG());
  }
  window.setContentSize(360, 620);
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.scroll-area').scrollWidth <= document.querySelector('.scroll-area').clientWidth + 1`), true, '작은 창에서도 가로 스크롤이 생기면 안 됩니다.');
  const soundRace = await window.webContents.executeJavaScript(`(async () => {
    const pending = [];
    window.loadSoundList = () => new Promise(resolve => pending.push(resolve));
    const sounds = [{name:'기본',file:'orb.mp3'}, {name:'새 경고음',file:'echo.mp3'}, {name:'소리 없음',file:'none'}];
    const oldRequest = window.__config({xpEfficiencyAlertSound:'orb.mp3', essenceAlertVolume:20});
    const newRequest = window.__config({xpEfficiencyAlertSound:'echo.mp3', essenceAlertVolume:70});
    pending[1](sounds); await newRequest; pending[0](sounds); await oldRequest;
    const selected = document.getElementById('xp-efficiency-sound').value;
    window.playPreview = sound => window.__previewSound = sound;
    document.getElementById('xp-efficiency-preview').click();
    const preview = window.__previewSound;
    const editingRequest = window.__config({xpEfficiencyAlertSound:'echo.mp3'});
    const input = document.getElementById('xp-efficiency-sound'); input.value = 'none'; input.dispatchEvent(new Event('change'));
    pending[2](sounds); await editingRequest;
    return {selected, preview, essenceVolume:document.getElementById('essence-alert-volume').value, edited:input.value};
  })()`);
  assert.deepEqual(soundRace, {selected:'echo.mp3', preview:'echo.mp3', essenceVolume:'70', edited:'none'},
    '오래된 목록 응답으로 최신 경고음/설정을 되돌리거나 응답 대기 중 사용자의 선택을 덮으면 안 됩니다.');
}

async function checkBuffTimerRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'buff-timer.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const masterToggle = document.getElementById('master-toggle');
    const showHudToggle = document.getElementById('show-hud-toggle');

    return {
      title,
      hasMasterToggle: masterToggle !== null,
      hasShowHudToggle: showHudToggle !== null
    };
  });

  assert.ok(result.title.includes('버프 타이머'), '버프 타이머 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasMasterToggle, true, '버프 타이머 마스터 토글이 없습니다.');
  assert.equal(result.hasShowHudToggle, true, 'HUD 표시 토글이 없습니다.');
}

async function checkWordAlarmRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'word-alarm.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const hasHistoryList = document.getElementById('history-list') !== null;
    const hasKeywordList = document.getElementById('keyword-list') !== null;

    return {
      title,
      hasHistoryList,
      hasKeywordList
    };
  });

  assert.ok(result.title.includes('단어 알림'), '지정 단어 알림 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasHistoryList, true, '단어 알림 히스토리 컨테이너가 없습니다.');
  assert.equal(result.hasKeywordList, true, '키워드 목록 컨테이너가 없습니다.');
}

async function checkAlarmVolumeBoundaries(): Promise<void> {
  // Full product pages, helpers and preload. Capture IPC at the main-process boundary:
  // game state/config replies are fixtures; volume parsing and preview dispatch are not replaced.
  const defaults = require(path.join(projectRoot, 'dist/modules/constants.js')).DEFAULT_CONFIG;
  let config = { ...defaults, fieldBossNotifyVolume: 30, essenceAlertVolume: 30 };
  const saves: any[] = [];
  const previews: Array<{ sound: string; volume: number }> = [];
  const onDefaults = (event: Electron.IpcMainEvent) => { event.returnValue = defaults; };
  const onSave = (event: Electron.IpcMainEvent, patch: any) => {
    saves.push(patch);
    config = { ...config, ...patch };
    event.sender.send('config-data', config);
  };
  const onPreview = (_event: Electron.IpcMainEvent, sound: string, volume: number) => previews.push({ sound, volume });
  ipcMain.on('get-default-config-sync', onDefaults);
  ipcMain.on('apply-settings', onSave);
  ipcMain.on('preview-boss-sound', onPreview);
  ipcMain.handle('get-config', () => config);
  ipcMain.handle('diary-get-by-date', () => ({ activityLogs: [] }));
  ipcMain.handle('xp-get-stats', () => null);
  ipcMain.handle('check-chat-log-status', () => true);
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(projectRoot, 'dist/preload.js'), contextIsolation: true, sandbox: true,
    backgroundThrottling: false,
  } });
  const failures: string[] = [];
  const check = (actual: unknown, expected: unknown, label: string) => {
    try { assert.deepEqual(actual, expected, label); } catch (error) { failures.push(String(error)); }
  };
  const waitForCall = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Alarm IPC was not received');
  };
  const load = async (file: string) => {
    await window.loadFile(path.join(projectRoot, 'dist', file));
    window.webContents.send('config-data', config);
    window.webContents.send('boss-times-data', { '골론': ['12:00'] });
    await waitForRendererCondition(window, file === 'boss-settings.html'
      ? `document.querySelectorAll('#boss-list select option').length > 0`
      : `document.querySelectorAll('#essence-alert-sound option').length > 0`, 'sound options');
  };
  try {
    await load('boss-settings.html');
    for (const volume of [35, 100, 0]) {
      const before = saves.length;
      await window.webContents.executeJavaScript(`{const slider=document.getElementById('boss-volume-input');slider.value='${volume}';slider.dispatchEvent(new Event('input'));slider.dispatchEvent(new Event('change'));}`);
      await waitForCall(() => saves.length > before);
      await waitForRendererCondition(window, `document.getElementById('boss-volume-input').value === '${config.fieldBossNotifyVolume}'`, 'boss config reply');
      check(saves.at(-1).fieldBossNotifyVolume, volume, `boss save ${volume}%`);
    }
    await load('boss-settings.html');
    check(await window.webContents.executeJavaScript(`document.getElementById('boss-volume-input').value`), '0', 'boss reload mute');
    await window.webContents.executeJavaScript(`document.querySelector('.boss-offset-check[value="5"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    check(saves.at(-1).fieldBossNotifyVolume, 0, 'offset edit retains mute');
    await window.webContents.executeJavaScript(`document.querySelector('#boss-list button[title="미리듣기"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    check(previews.at(-1)?.volume, 0, 'boss preview mute');
    await load('xp-hud.html');
    for (const volume of [35, 100, 0]) {
      const before = previews.length;
      await window.webContents.executeJavaScript(`{const slider=document.getElementById('essence-alert-volume');slider.value='${volume}';slider.dispatchEvent(new Event('input'));document.getElementById('btn-essence-preview').click();}`);
      await waitForCall(() => previews.length > before);
      check(saves.at(-1)?.essenceAlertVolume, volume, `essence save ${volume}%`);
      check(previews.at(-1)?.volume, volume, `essence preview ${volume}%`);
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  } finally {
    window.destroy();
    ipcMain.removeListener('get-default-config-sync', onDefaults);
    ipcMain.removeListener('apply-settings', onSave);
    ipcMain.removeListener('preview-boss-sound', onPreview);
    for (const channel of ['get-config', 'diary-get-by-date', 'xp-get-stats', 'check-chat-log-status']) ipcMain.removeHandler(channel);
  }
}

async function checkBossSettingsRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'boss-settings.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const bossList = document.getElementById('boss-list');
    const globalNotificationLink = document.getElementById('boss-global-notification-link');

    return {
      title,
      hasBossList: bossList !== null,
      hasGlobalNotificationLink: globalNotificationLink !== null
    };
  });

  assert.ok(result.title.includes('보스 알림'), '보스 알림 설정 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasBossList, true, '보스 목록 컨테이너가 없습니다.');
  assert.equal(result.hasGlobalNotificationLink, true, '공통 알림 정책 바로가기가 없습니다.');
}

async function checkMagicStoneCalculator(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'magic-stone-calculator.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const inputLower = document.getElementById('lower-count');
    const inputMiddle = document.getElementById('middle-count');

    return {
      title,
      hasInputLower: inputLower !== null,
      hasInputMiddle: inputMiddle !== null
    };
  });

  assert.ok(result.title.includes('마정석'), '마정석 계산기 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasInputLower, true, '하급 마정석 입력 필드가 없습니다.');
  assert.equal(result.hasInputMiddle, true, '중급 마정석 입력 필드가 없습니다.');
}

async function checkThesisCoreCalculator(window: BrowserWindow): Promise<void> {
  // Load the product HTML and its real scripts; only this test's temporary storage is reset.
  const file = path.join(projectRoot, 'dist', 'thesis-core-calculator.html');
  await window.loadFile(file);
  await evaluate(window, () => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('tc_')) localStorage.removeItem(key);
  });
  await window.loadFile(file);
  const failures: string[] = [];
  const snapshot = () => evaluate(window, () => ({
    active: Array.from(document.querySelectorAll('.active[id]')).map(element => element.id),
    inputs: Object.fromEntries(Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id],select[id]'))
      .map(element => [element.id, element.value])),
    results: ['res-powder', 'res-crystal', 'res-currency', 'total-box-cost', 'total-reinforce-cost',
      'final-total-cost', 'final-total-unit', 'final-total-korean'].map(id => document.getElementById(id)?.textContent),
    stored: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('tc_')).sort()
      .map(key => [key, localStorage.getItem(key)])),
    warning: !document.getElementById('warning-box')!.classList.contains('hidden'),
    icons: document.querySelectorAll('svg[data-lucide]').length,
  }));
  await evaluate(window, () => {
    const input = (id: string, value: string, event = 'input') => {
      (document.getElementById(id) as HTMLInputElement).value = value;
      document.getElementById(id)!.dispatchEvent(new Event(event, { bubbles: true }));
    };
    for (const id of ['tab-eclipse', 'stat-sub', 'curr-elso', 'qty-6']) document.getElementById(id)!.click();
    input('discount-input', '20');
    input('step-from', '23', 'change');
    input('step-to', '24', 'change');
    input('box-qty', '3');
    input('box-price', '50');
  });
  const saved = await snapshot();
  assert.equal(saved.icons, 6, '계산기 아이콘 초기화');
  assert.deepEqual(saved.results.slice(0, 5), ['87,000', '1,500', '561,600', '150 만 시드', '561,600 엘소']);
  for (let reopening = 1; reopening <= 2; reopening++) {
    await window.loadFile(file);
    if (JSON.stringify(await snapshot()) !== JSON.stringify(saved)) failures.push(`재실행 ${reopening}: 선택·입력·계산 결과·저장값이 달라짐`);
  }

  failures.push(...await evaluate(window, () => {
    const errors: string[] = [];
    const input = (id: string, value: string, event = 'input') => {
      (document.getElementById(id) as HTMLInputElement).value = value;
      document.getElementById(id)!.dispatchEvent(new Event(event, { bubbles: true }));
    };
    const text = (id: string) => document.getElementById(id)!.textContent;
    const expect = (condition: boolean, message: string) => { if (!condition) errors.push(message); };
    for (const currency of ['seed', 'elso']) {
      for (const from of ['1', '2']) {
        const label = `${currency}/${from === '1' ? '동일 단계' : '역순 단계'}`;
        for (const id of ['tab-eclipse', 'stat-sub', `curr-${currency}`, 'qty-6']) document.getElementById(id)!.click();
        input('discount-input', '20');
        input('step-from', '0', 'change');
        input('step-to', '1', 'change');
        input('box-qty', '3');
        input('box-price', '50');
        const cost = currency === 'seed' ? '960' : '1,440';
        expect(text('res-currency') === cost, `${label}: 정상 범위 비용`);
        input('step-from', from, 'change');
        expect(!document.getElementById('warning-box')!.classList.contains('hidden'), `${label}: 오류 안내`);
        expect(text('total-reinforce-cost') === '계산 불가' && text('final-total-cost') === '계산 불가'
          && text('final-total-unit') === '' && text('final-total-korean') === '', `${label}: 이전 합계 제거`);
        input('box-qty', '4');
        input('box-price', '60');
        expect(text('total-box-cost') === '240 만 시드', `${label}: 상자 소계 갱신`);
        expect(localStorage.getItem('tc_box_qty') === '4' && localStorage.getItem('tc_box_price') === '60', `${label}: 상자 입력 저장`);
        input('step-from', '0', 'change');
        expect(document.getElementById('warning-box')!.classList.contains('hidden') && text('res-currency') === cost, `${label}: 정상 범위 복귀`);
        expect(currency === 'seed'
          ? text('final-total-cost') === '1,200' && text('final-total-unit') === '만 시드'
          : text('final-total-cost') === '240만 시드 + 1,440' && text('final-total-unit') === '엘소', `${label}: 최종 비용 복구`);
      }
    }
    input('step-from', '2', 'change');
    input('box-qty', '5');
    return errors;
  }));
  const invalidSaved = await snapshot();
  await window.loadFile(file);
  if (JSON.stringify(await snapshot()) !== JSON.stringify(invalidSaved)) failures.push('오류 범위 재실행: 범위·상자 입력·오류 표시 보존 실패');
  assert.deepEqual(failures, [], failures.join('\n'));
}

async function checkAbbreviationRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'abbreviation.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const searchInput = document.getElementById('search-input') || document.querySelector('input');
    return {
      title,
      hasSearchInput: searchInput !== null
    };
  });

  assert.ok(result.title.includes('약어'), '약어 사전 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasSearchInput, true, '약어 검색 입력창이 없습니다.');
}

async function checkEquipmentDicRenderer(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'equipment-dic.html'));
  await waitForSelector(window, '.item-card');

  const result = await evaluate(window, async () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const sentSelections: unknown[] = [];
    (window as any).electronAPI = {
      sendEquipmentToEvolution(selection: unknown) {
        sentSelections.push(selection);
      },
    };

    const evolutionItem = Array.from(document.querySelectorAll<HTMLElement>('.item-card'))
      .find(card => card.textContent?.includes('인퍼널 대거'));
    evolutionItem?.click();
    document.getElementById('btn-calc-evolution')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      title,
      evolutionButtonVisible: !document.getElementById('btn-calc-evolution')?.classList.contains('hidden'),
      sentSelection: sentSelections[0],
    };
  });

  assert.ok(result.title.includes('장비'), '장비 사전 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.evolutionButtonVisible, true, '진화 가능한 장비에서 진화 비용 계산 버튼이 표시되지 않습니다.');
  assert.deepEqual(result.sentSelection, {
    category: 'weapon',
    part: '',
    itemName: '인퍼널 대거',
  }, '장비 사전의 진화 비용 계산 버튼이 계산기 선택 정보를 전달하지 않습니다.');
}

async function checkEtaRankingRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'eta-ranking.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('에타 랭킹'), '에타 랭킹 창 타이틀이 일치하지 않습니다.');
}

async function checkQteChallengeRenderer(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'qte-challenge.html'));
  await waitForSelector(window, '#qte-stage');

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const practiceTab = document.getElementById('practice-tab') as HTMLButtonElement | null;
    const challengeTab = document.getElementById('challenge-tab') as HTMLButtonElement | null;
    const speed = document.getElementById('practice-speed') as HTMLSelectElement | null;
    const start = document.getElementById('start-button') as HTMLButtonElement | null;
    const stop = document.getElementById('stop-button') as HTMLButtonElement | null;
    const blueArc = document.getElementById('blue-arc');
    const yellowArc = document.getElementById('yellow-arc');

    challengeTab?.click();
    const challengeStartLabel = start?.textContent?.trim();
    const challengeModeActive = challengeTab?.classList.contains('active');
    const speedHiddenInChallenge = speed?.classList.contains('hidden');
    start?.click();
    const stopVisibleWhileRunning = stop ? !stop.classList.contains('hidden') : false;
    stop?.click();
    practiceTab?.click();

    return {
      title,
      challengeStartLabel,
      challengeModeActive,
      speedHiddenInChallenge,
      stopVisibleWhileRunning,
      practiceModeRestored: practiceTab?.classList.contains('active'),
      hasSeparateArcs: blueArc !== null && yellowArc !== null,
      qteApiReady: typeof (globalThis as any).qteChallenge?.classifyQteHit === 'function',
    };
  });

  assert.ok(result.title.includes('QTE 챌린지'), '신규 QTE 별도 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasSeparateArcs, true, 'QTE 일반 성공·대성공 판정 영역이 분리되어 있지 않습니다.');
  assert.equal(result.qteApiReady, true, 'QTE 순수 판정 엔진이 전용 렌더러에 연결되지 않았습니다.');
  assert.equal(result.challengeModeActive, true, 'QTE 챌린지 모드 전환이 동작하지 않습니다.');
  assert.match(result.challengeStartLabel || '', /챌린지 시작/);
  assert.equal(result.speedHiddenInChallenge, true, '챌린지에서 실전 연습 속도 선택이 노출됩니다.');
  assert.equal(result.stopVisibleWhileRunning, true, 'QTE 세션 시작 후 중지 제어가 표시되지 않습니다.');
  assert.equal(result.practiceModeRestored, true, 'QTE 실전 연습 모드로 돌아오지 못합니다.');

  // Drive the complete renderer through its buttons, pointer handler and scheduled callbacks.
  // Only time/randomness are controlled; scoring, round advancement and persistence are real.
  const boundaries = await evaluate(window, () => {
    const failures: string[] = [];
    const expect = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
    const text = (id: string) => document.getElementById(id)!.textContent!.trim();
    const click = (id: string) => (document.getElementById(id) as HTMLElement).click();
    const stage = document.getElementById('qte-stage')!;
    const native = {
      timeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      raf: globalThis.requestAnimationFrame, cancelRaf: globalThis.cancelAnimationFrame,
      random: Math.random, now: Object.getOwnPropertyDescriptor(performance, 'now'),
    };
    let now = 1_000;
    let sequence = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    const frames = new Map<number, FrameRequestCallback>();
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      const id = ++sequence;
      timers.set(id, { at: now + delay, run: callback });
      return id;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: number) => timers.delete(id)) as typeof globalThis.clearTimeout;
    globalThis.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
    globalThis.cancelAnimationFrame = id => { frames.delete(id); };
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    Math.random = () => 0;
    const runTimer = () => {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error('QTE scheduled callback missing');
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].run();
    };
    const advanceUntil = (condition: () => boolean) => {
      for (let i = 0; !condition() && i < 8; i++) runTimer();
      if (!condition()) throw new Error('QTE phase did not advance');
    };
    const start = () => { click('start-button'); advanceUntil(() => stage.classList.contains('active')); };
    const hit = (success: boolean) => {
      const duration = (globalThis as any).qteChallenge.getQteChallengeDifficulty(Number(text('stage-value'))).durationMs;
      if (success) {
        const arc = document.getElementById('blue-arc') as unknown as SVGCircleElement;
        const angle = -Number.parseFloat(arc.style.strokeDashoffset) + Number.parseFloat(arc.style.strokeDasharray) / 2;
        now += duration * angle / 360;
        stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      } else {
        now += duration;
        const frame = [...frames.entries()][0];
        if (!frame) throw new Error('QTE animation callback missing');
        frames.delete(frame[0]);
        frame[1](now);
      }
    };
    const record = () => JSON.parse(localStorage.getItem('tw-overlay:qte-challenge:v1')!);
    const finishAt = (rounds: number) => {
      start();
      for (let index = 0; index < rounds; index++) {
        // Two early misses, then genuine blue-arc clicks until the terminal miss.
        hit(index >= 2 && index < rounds - 1);
        if (index < rounds - 1) advanceUntil(() => stage.classList.contains('active'));
      }
      advanceUntil(() => text('round-overlay') === 'GAME OVER');
    };
    try {
      click('sound-toggle'); // Default test profile is enabled; avoid actual audio during clock control.
      click('challenge-tab');
      finishAt(3);
      expect(text('life-value') === '0' && text('round-value') === '3/10', '3회 실패 종료에 4라운드 표시');
      expect(record().totalAttempts === 3, '3회 실패 시 기록 횟수 불일치');
      finishAt(10);
      expect(text('stage-value') === '1' && text('round-value') === '10/10', '10라운드 탈락에 다음 스테이지 표시');
      expect(record().bestStage === 1, '입장하지 않은 2스테이지가 최고 기록에 저장됨');
      finishAt(40);
      expect(text('stage-value') === '4' && text('round-value') === '10/10', '40라운드 탈락에 5스테이지 표시');
      expect(record().bestStage === 4, '입장하지 않은 5스테이지가 최고 기록에 저장됨');
      expect(!document.querySelector('[data-achievement="stage-five"]')!.classList.contains('unlocked'), '5스테이지 진입 전 도전과제 해금');
      start();
      for (let index = 0; index < 40; index++) {
        hit(true);
        if (index < 39) advanceUntil(() => stage.classList.contains('active'));
      }
      expect(record().bestStage === 4, '40라운드 성공 결과 표시 중 다음 스테이지를 미리 기록함');
      advanceUntil(() => stage.classList.contains('active'));
      expect(text('stage-value') === '5' && text('round-value') === '1/10', '41번째 라운드 시작에 스테이지 미전환');
      expect(record().bestStage === 5 && document.querySelector('[data-achievement="stage-five"]')!.classList.contains('unlocked'), '실제 5스테이지 진입 기록·해금 실패');
      const attempts = record().totalAttempts;
      click('stop-button');
      expect(timers.size === 0 && frames.size === 0 && record().totalAttempts === attempts, '중지 후 타이머/추가 판정이 남음');
      click('practice-tab');
    } finally {
      globalThis.setTimeout = native.timeout; globalThis.clearTimeout = native.clearTimeout;
      globalThis.requestAnimationFrame = native.raf; globalThis.cancelAnimationFrame = native.cancelRaf;
      Math.random = native.random;
      if (native.now) Object.defineProperty(performance, 'now', native.now);
      else Reflect.deleteProperty(performance, 'now');
    }
    return failures;
  });
  assert.deepEqual(boundaries, [], 'QTE 최종 라운드·스테이지 기록 경계가 일치하지 않습니다.');
}

async function checkDockRenderer(window: BrowserWindow): Promise<void> {
  const dockPath = path.join(projectRoot, 'dist', 'dock.html');
  const dockSource = fs.readFileSync(dockPath, 'utf8');
  const inlineScripts = Array.from(
    dockSource.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
    match => match[1],
  );
  const dockScript = inlineScripts.at(-1);
  assert.ok(dockScript, '독 렌더러 inline script를 찾지 못했습니다.');
  const html = cleanHtmlForTest(dockPath);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const menuData = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'dist', 'assets', 'data', 'sidebar_menus.json'),
    'utf8',
  ));
  const categoryRegistry = require(path.join(projectRoot, 'dist', 'shared', 'sidebarCategories.js')) as {
    SIDEBAR_CATEGORIES: unknown[];
  };
  const cloudSyncPresentationCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'cloudSyncPresentation.js'),
    'utf8',
  );
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const calls = [];
      const mousePassThroughCalls = [];
      const configCallbacks = [];
      const activeCallbacks = [];
      const syncCallbacks = [];
      const clickThroughCallbacks = [];
      window.sidebarCategories = ${JSON.stringify(categoryRegistry.SIDEBAR_CATEGORIES)};
      window.lucide = { createIcons: () => {} };
      window.bindEscapeClose = () => {};
      window.fetch = async () => ({ json: async () => ${JSON.stringify(menuData)} });
      window.electronAPI = {
        toggleContentsChecker: () => calls.push('contentsChecker'),
        toggleSwordEnhance: () => calls.push('swordEnhance'),
        toggleQteChallenge: () => calls.push('qteChallenge'),
        toggleSettings: (...args) => calls.push(['settings', ...args]),
        setIgnoreMouseEvents: (ignore, options) => mousePassThroughCalls.push({
          ignore,
          forward: options?.forward === true,
        }),
        onConfigData: callback => configCallbacks.push(callback),
        onActiveWindows: callback => activeCallbacks.push(callback),
        onGoogleSyncStatusChanged: callback => syncCallbacks.push(callback),
        onClickThroughStatus: callback => clickThroughCallbacks.push(callback),
        googleSyncGetStatus: async () => ({ isLinked: false }),
      };
      ${cloudSyncPresentationCode}
      eval(${JSON.stringify(dockScript)});
      await new Promise(resolve => setTimeout(resolve, 0));

      configCallbacks[0]({ sidebarPosition: 'dock', hiddenMenuIds: [], chatOverlayClickThrough: false });
      const homework = document.getElementById('dock-contents-checker-btn');
      const swordEnhance = document.getElementById('dock-chip-sword-enhance-btn');
      const qteChallenge = document.getElementById('dock-chip-qte-challenge-btn');
      const clickThroughItem = document.getElementById('dock-click-through-btn');
      if (clickThroughItem) clickThroughItem.style.transition = 'none';
      clickThroughCallbacks[0](true);
      const clickThroughOn = {
        active: clickThroughItem?.classList.contains('click-through-active'),
        icon: clickThroughItem?.querySelector('[data-lucide]')?.getAttribute('data-lucide'),
        tooltip: clickThroughItem?.querySelector('.dock-tooltip')?.textContent,
        color: clickThroughItem ? getComputedStyle(clickThroughItem).color : undefined,
      };
      clickThroughCallbacks[0](false);
      const clickThroughOff = {
        active: clickThroughItem?.classList.contains('click-through-active'),
        icon: clickThroughItem?.querySelector('[data-lucide]')?.getAttribute('data-lucide'),
        color: clickThroughItem ? getComputedStyle(clickThroughItem).color : undefined,
      };
      homework?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      homework?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      homework?.click();
      swordEnhance?.click();
      qteChallenge?.click();
      activeCallbacks[0](['contentsChecker', 'swordEnhance', 'qteChallenge']);
      document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

      const syncItem = document.getElementById('dock-cloud-sync-status');
      const hiddenWhenUnlinked = syncItem ? getComputedStyle(syncItem).display === 'none' : false;
      syncCallbacks[0]({ isLinked: true, isSyncing: false, fileStatuses: [] });
      const normalState = syncItem?.dataset.syncState;
      const normalDot = syncItem?.querySelector('.cloud-sync-normal-dot');
      const normalDotRect = normalDot?.getBoundingClientRect();
      const normalHasVisibleDot = Boolean(normalDotRect && normalDotRect.width >= 9 && normalDotRect.height >= 9);
      syncCallbacks[0]({ isLinked: true, isSyncing: true, syncActivity: 'upload' });
      const uploadState = syncItem?.dataset.syncState;
      const uploadIcon = syncItem?.querySelector('[data-lucide]')?.getAttribute('data-lucide');
      syncCallbacks[0]({ isLinked: true, isSyncing: true, syncActivity: 'download' });
      const downloadState = syncItem?.dataset.syncState;
      syncCallbacks[0]({ isLinked: true, isSyncing: true, syncActivity: 'checking' });
      const checkingState = syncItem?.dataset.syncState;
      syncCallbacks[0]({ isLinked: true, pullRetryCount: 1 });
      const errorState = syncItem?.dataset.syncState;
      const errorTooltip = syncItem?.querySelector('.dock-tooltip')?.textContent;
      syncCallbacks[0]({ isLinked: false, reauthRequired: true });
      const reauthState = syncItem?.dataset.syncState;
      const reauthVisible = syncItem ? getComputedStyle(syncItem).display !== 'none' : false;
      const reauthTooltip = syncItem?.querySelector('.dock-tooltip')?.textContent;
      syncItem?.click();
      syncCallbacks[0]({ isLinked: false });
      const hiddenAfterLogout = syncItem ? getComputedStyle(syncItem).display === 'none' : false;

      const visibleResult = {
        homeworkLabel: homework?.querySelector('.dock-tooltip')?.textContent,
        swordEnhanceLabel: swordEnhance?.querySelector('span')?.textContent,
        qteChallengeLabel: qteChallenge?.querySelector('span')?.textContent,
        homeworkIcon: homework?.querySelector('[data-lucide]')?.getAttribute('data-lucide'),
        swordEnhanceImage: swordEnhance?.querySelector('img')?.getAttribute('src'),
        qteChallengeIcon: qteChallenge?.querySelector('[data-lucide]')?.getAttribute('data-lucide'),
        homeworkActive: homework?.classList.contains('active'),
        swordEnhanceActive: swordEnhance?.classList.contains('active'),
        qteChallengeActive: qteChallenge?.classList.contains('active'),
        minigameActive: document.querySelector('#dock-cat-minigame > .dock-item')?.classList.contains('active'),
        hiddenWhenUnlinked,
        normalState,
        normalHasVisibleDot,
        uploadState,
        uploadIcon,
        downloadState,
        checkingState,
        errorState,
        errorTooltip,
        reauthState,
        reauthVisible,
        reauthTooltip,
        hiddenAfterLogout,
        clickThroughOn,
        clickThroughOff,
      };

      configCallbacks[0]({
        sidebarPosition: 'dock-top',
        hiddenMenuIds: ['sword-enhance-btn'],
      });

      return {
        hasBody: document.body !== null,
        ...visibleResult,
        calls,
        mousePassThroughCalls,
        topDockClass: document.body.classList.contains('dock-pos-top'),
        homeworkStillVisible: document.getElementById('dock-contents-checker-btn') !== null,
        hiddenSwordHidden: getComputedStyle(document.getElementById('dock-chip-sword-enhance-btn')).display === 'none',
        qteStillVisible: getComputedStyle(document.getElementById('dock-chip-qte-challenge-btn')).display !== 'none',
      };
    })()
  `) as {
    hasBody: boolean;
    homeworkLabel?: string;
    swordEnhanceLabel?: string;
    qteChallengeLabel?: string;
    homeworkIcon?: string;
    swordEnhanceImage?: string;
    qteChallengeIcon?: string;
    homeworkActive?: boolean;
    swordEnhanceActive?: boolean;
    qteChallengeActive?: boolean;
    minigameActive?: boolean;
    hiddenWhenUnlinked?: boolean;
    normalState?: string;
    normalHasVisibleDot?: boolean;
    uploadState?: string;
    uploadIcon?: string;
    downloadState?: string;
    checkingState?: string;
    errorState?: string;
    errorTooltip?: string;
    reauthState?: string;
    reauthVisible?: boolean;
    reauthTooltip?: string;
    hiddenAfterLogout?: boolean;
    clickThroughOn: { active?: boolean; icon?: string; tooltip?: string; color?: string };
    clickThroughOff: { active?: boolean; icon?: string; color?: string };
    calls: unknown[];
    mousePassThroughCalls: Array<{ ignore: boolean; forward: boolean }>;
    topDockClass: boolean;
    homeworkStillVisible: boolean;
    hiddenSwordHidden: boolean;
    qteStillVisible: boolean;
  };

  assert.equal(result.hasBody, true, '사이드바 독 바디가 렌더링되지 않았습니다.');
  assert.equal(result.homeworkLabel, '숙제 체크 리스트', '독에 숙제 체크리스트 메뉴가 표시되지 않았습니다.');
  assert.equal(result.swordEnhanceLabel, '테일즈위버 무기 강화하기', '독에 검 강화하기 메뉴가 표시되지 않았습니다.');
  assert.equal(result.qteChallengeLabel, 'QTE 챌린지', '독 미니게임 서브메뉴에 QTE 챌린지가 표시되지 않았습니다.');
  assert.equal(result.homeworkIcon, 'check-square', '독 숙제 아이콘이 사이드바 카테고리 아이콘과 다릅니다.');
  assert.equal(result.swordEnhanceImage, 'assets/img/검강화하기.png',
    '독 미니게임 서브메뉴가 기존 검 강화하기 이미지 아이콘을 유지하지 않습니다.');
  assert.equal(result.qteChallengeIcon, 'crosshair', '독 미니게임 서브메뉴의 QTE 아이콘이 다릅니다.');
  assert.deepEqual(result.calls.slice(0, 3), ['contentsChecker', 'swordEnhance', 'qteChallenge'],
    '독의 숙제 직접 메뉴 또는 미니게임 2depth 동작이 연결되지 않았습니다.');
  assert.equal(result.hiddenWhenUnlinked, true, '미연결 상태에서 독 동기화 아이콘이 보입니다.');
  assert.equal(result.normalState, 'normal');
  assert.equal(result.normalHasVisibleDot, true, '정상 상태가 실제 크기를 가진 초록색 점으로 표시되지 않았습니다.');
  assert.equal(result.uploadState, 'uploading');
  assert.equal(result.uploadIcon, 'cloud-upload');
  assert.equal(result.downloadState, 'downloading');
  assert.equal(result.checkingState, 'checking');
  assert.equal(result.errorState, 'error');
  assert.match(result.errorTooltip || '', /오류/);
  assert.equal(result.reauthState, 'error');
  assert.equal(result.reauthVisible, true, '재로그인 필요 상태에서 독 동기화 아이콘이 숨겨집니다.');
  assert.match(result.reauthTooltip || '', /다시 로그인/);
  assert.equal(result.hiddenAfterLogout, true, '로그아웃 뒤 독 동기화 아이콘이 숨겨지지 않았습니다.');
  assert.deepEqual(result.clickThroughOn, {
    active: true,
    icon: 'mouse-pointer-off',
    tooltip: '마우스 투과 켜짐 · 웹 브라우저와 채팅 오버레이 입력이 게임으로 전달됩니다',
    color: 'rgb(74, 222, 128)',
  }, '독의 마우스 투과 켜짐 상태가 초록색 상태와 안내 문구로 표시되지 않았습니다.');
  assert.deepEqual(result.clickThroughOff, {
    active: false,
    icon: 'mouse-pointer-2',
    color: 'rgb(148, 163, 184)',
  }, '독의 마우스 투과 꺼짐 상태가 복원되지 않았습니다.');
  assert.deepEqual(result.calls.at(-1), ['settings', 'data:google-sync'],
    '독 동기화 아이콘이 Google Drive 설정 카드로 이동하지 않습니다.');
  assert.deepEqual(result.mousePassThroughCalls, [
    { ignore: true, forward: true },
    { ignore: false, forward: false },
    { ignore: true, forward: true },
  ], '독의 투명 여백과 실제 UI 사이 마우스 투과 전환이 올바르지 않습니다.');
  assert.equal(result.homeworkActive, true, '숙제 체크리스트 독 활성 상태가 표시되지 않았습니다.');
  assert.equal(result.swordEnhanceActive, true, '검 강화하기 독 활성 상태가 표시되지 않았습니다.');
  assert.equal(result.qteChallengeActive, true, 'QTE 챌린지 독 활성 상태가 표시되지 않았습니다.');
  assert.equal(result.minigameActive, true, '미니게임 자식 창 활성 상태가 부모 1depth에 표시되지 않았습니다.');
  assert.equal(result.topDockClass, true, '상단 독 설정이 메뉴 재렌더링 뒤 유지되지 않았습니다.');
  assert.equal(result.homeworkStillVisible, true, '다른 메뉴 숨김 설정이 숙제 체크리스트까지 숨겼습니다.');
  assert.equal(result.hiddenSwordHidden, true, '검 강화하기 숨김 설정이 독 미니게임 서브메뉴에 반영되지 않았습니다.');
  assert.equal(result.qteStillVisible, true, '검 강화하기 숨김 설정이 QTE 챌린지까지 숨겼습니다.');
}

async function checkIndexRenderer(window: BrowserWindow): Promise<void> {
  const indexSource = fs.readFileSync(path.join(projectRoot, 'dist', 'index.html'), 'utf8');
  const activationCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'shared', 'sidebarMenuActivation.js'),
    'utf8',
  );
  assert.match(indexSource, /shared\/sidebarMenuActivation\.js/,
    '사이드바가 포커스 전환 안전 메뉴 입력 모듈을 로드하지 않습니다.');
  assert.match(indexSource, /window\.sidebarMenuActivation\.bind\(chip, activateMenu\)/,
    '플라이아웃 항목이 첫 입력 보존 경로에 연결되지 않았습니다.');

  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'index.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await window.webContents.executeJavaScript(`
    (() => {
      ${activationCode}
      const button = document.createElement('button');
      let activationCount = 0;
      window.sidebarMenuActivation.bind(button, () => { activationCount += 1; });
      document.body.appendChild(button);

      // 외부 창에서 돌아오는 실제 마우스 경로: mousedown에서 실행하고 후속 click은 중복 금지.
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
      const pointerActivationCount = activationCount;

      // 우클릭은 실행하지 않고, 키보드/프로그램 click(detail=0)은 기존처럼 실행한다.
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      const countAfterSecondaryButton = activationCount;
      button.click();

      return {
        hasBody: document.body !== null,
        pointerActivationCount,
        countAfterSecondaryButton,
        keyboardActivationCount: activationCount,
      };
    })()
  `) as {
    hasBody: boolean;
    pointerActivationCount: number;
    countAfterSecondaryButton: number;
    keyboardActivationCount: number;
  };

  assert.equal(result.hasBody, true, '메인 사이드바 런처가 렌더링되지 않았습니다.');
  assert.equal(result.pointerActivationCount, 1,
    '외부 창 활성 상태의 첫 마우스 입력이 실행되지 않거나 후속 click에서 중복 실행됩니다.');
  assert.equal(result.countAfterSecondaryButton, 1, '보조 마우스 버튼이 사이드바 메뉴를 실행합니다.');
  assert.equal(result.keyboardActivationCount, 2, '키보드/프로그램 클릭 경로가 사이드바 메뉴를 실행하지 않습니다.');
}

async function checkCustomAlertRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'custom-alert.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('커스텀 알림'), '커스텀 알림 창 타이틀이 일치하지 않습니다.');
}

async function checkDiscordAlarmRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'discord-alarm.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('디스코드'), '디스코드 알림 설정 창 타이틀이 일치하지 않습니다.');
}

async function checkScamDetectorRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'scam-detector.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    return { hasBody };
  });

  assert.equal(result.hasBody, true, '사기 탐지기 화면이 로드되지 않았습니다.');
}

async function checkEvolutionCalculatorRenderer(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'evolution-calculator.html'));
  await window.webContents.executeJavaScript('localStorage.clear()');
  await window.reload();
  await waitForSelector(window, '.material-row');

  const result = await evaluate(window, async () => {
    const setInput = (id: string, value: string) => {
      const input = document.getElementById(id) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const from = document.getElementById('step-from') as HTMLSelectElement;
    const to = document.getElementById('step-to') as HTMLSelectElement;
    const evolutionOptionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-evolution-option]'));
    const evolutionOptionLabels = evolutionOptionButtons.map(button => button.textContent?.trim());
    evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'helm')?.click();
    const helmSelectedDirectly = evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'helm')?.classList.contains('active');
    const equipmentStartLabel = from.options[0]?.textContent?.trim();
    evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'weapon')?.click();
    const weaponReselectedDirectly = evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'weapon')?.classList.contains('active');
    await new Promise(resolve => setTimeout(resolve, 50));
    const citrineFit = document.querySelector<HTMLImageElement>('.material-image img[alt="시트린"]')?.className || '';
    const ancientWeaponFit = document.querySelector<HTMLImageElement>('.material-image img[alt="고대 기사의 무기 파편"]')?.className || '';
    from.value = '3';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    const targetOptionsAfterStartChange = Array.from(to.options, option => Number(option.value));
    to.value = '4';
    to.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 80));
    const baseTypeRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="eclipse-base-type"]'));
    const baseTypeValues = baseTypeRadios.map(radio => radio.value);
    const customRadioStyles = baseTypeRadios.map(radio => {
      const style = getComputedStyle(radio);
      return {
        appearance: style.appearance,
        width: parseFloat(style.width),
        height: parseFloat(style.height),
        borderStyle: style.borderStyle,
        borderColor: style.borderColor,
      };
    });
    const baseChoiceTextAlignments = Array.from(document.querySelectorAll<HTMLElement>('.eclipse-base-method .choice-copy'),
      choice => getComputedStyle(choice).textAlign);
    const baseCostHiddenForDirect = document.getElementById('eclipse-base-cost-field')?.classList.contains('hidden');
    const fakeArmamentRadio = baseTypeRadios.find(radio => radio.value === 'fake-armament');
    if (fakeArmamentRadio) {
      fakeArmamentRadio.checked = true;
      fakeArmamentRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const baseCostVisibleForPurchase = !document.getElementById('eclipse-base-cost-field')?.classList.contains('hidden');

    setInput('enchant-scroll-count', '2');
    setInput('enchant-scroll-unit-price', '100');
    setInput('enchant-attempt-cost', '200');
    setInput('magic-reform-cost', '300');
    setInput('additional-option-cost', '400');
    setInput('ability-mount-cost', '500');
    setInput('attribute-grant-cost', '600');
    setInput('enhancement-cost', '700');
    setInput('eclipse-base-cost', '500');
    setInput('moon-mineral-cost', '600');
    setInput('rune-stone-cost', '700');
    setInput('seal-proxy-fee', '800');
    await new Promise(resolve => setTimeout(resolve, 0));

    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const eclipseVisible = !document.getElementById('eclipse-cost-card')?.classList.contains('hidden');
    const materialNames = Array.from(document.querySelectorAll('.material-name'), element => element.textContent?.trim());
    const visibleMaterialImages = Array.from(document.querySelectorAll<HTMLImageElement>('.material-image img'))
      .filter(image => !image.classList.contains('hidden')).length;
    const specialMaterialImageNames = Array.from(new Set(
      Array.from(document.querySelectorAll<HTMLImageElement>('.eclipse-item-image img'))
        .filter(image => image.complete && image.naturalWidth > 0 && !image.classList.contains('hidden'))
        .map(image => image.alt),
    )).sort();
    const equipmentImageCount = document.querySelectorAll('.tier-image, #start-item-image, #end-item-image').length;
    const styledTierSelectCount = document.querySelectorAll('.tier-select-wrap > select.tier-select').length;
    const inputSubtotals = {
      enchantScroll: document.getElementById('enchant-scroll-subtotal')?.textContent?.trim(),
      enchantAttempt: document.getElementById('enchant-attempt-subtotal')?.textContent?.trim(),
      magicReform: document.getElementById('magic-reform-subtotal')?.textContent?.trim(),
      additionalOption: document.getElementById('additional-option-subtotal')?.textContent?.trim(),
      abilityMount: document.getElementById('ability-mount-subtotal')?.textContent?.trim(),
      attributeGrant: document.getElementById('attribute-grant-subtotal')?.textContent?.trim(),
      enhancement: document.getElementById('enhancement-subtotal')?.textContent?.trim(),
      eclipseBase: document.getElementById('eclipse-base-subtotal')?.textContent?.trim(),
      moonMineral: document.getElementById('moon-mineral-subtotal')?.textContent?.trim(),
      runeStone: document.getElementById('rune-stone-subtotal')?.textContent?.trim(),
      sealProxy: document.getElementById('seal-proxy-subtotal')?.textContent?.trim(),
    };
    const materialNameFontSize = parseFloat(getComputedStyle(document.querySelector('.material-name') as Element).fontSize);
    const numberInputFontSize = parseFloat(getComputedStyle(document.querySelector('.number-input') as Element).fontSize);
    const historyTitleFontSize = parseFloat(getComputedStyle(document.querySelector('.history-head h2') as Element).fontSize);
    const totalBeforeSave = document.getElementById('total-cost')?.textContent?.trim();

    const historyTitle = document.getElementById('history-title') as HTMLInputElement;
    historyTitle.value = '이클립스 무기 제작안';
    (document.getElementById('save-history-button') as HTMLButtonElement).click();
    const firstCard = document.querySelector<HTMLElement>('.history-card');
    const weaponHistoryPart = firstCard?.querySelector('.history-part')?.textContent?.trim();
    from.value = '0';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    to.value = '1';
    to.dispatchEvent(new Event('change', { bubbles: true }));
    setInput('enchant-attempt-cost', '1234');
    historyTitle.value = '저장 후 돌아올 계산 초안';
    firstCard?.querySelector<HTMLButtonElement>('[data-action="edit"]')?.click();
    const editLoadedTitle = historyTitle.value;
    const editingCardHighlighted = document.querySelector('.history-card')?.classList.contains('editing');
    const editingBadgeText = document.querySelector('.history-editing-badge')?.textContent?.trim();
    const editingStatusText = document.getElementById('editing-status')?.textContent?.replace(/\s+/g, ' ').trim();
    const editingStatusVisible = !document.getElementById('editing-status')?.classList.contains('hidden');
    historyTitle.value = '이클립스 무기 수정안';
    (document.getElementById('save-history-button') as HTMLButtonElement).click();
    const editingClearedAfterSave = document.getElementById('editing-status')?.classList.contains('hidden')
      && !document.querySelector('.history-card')?.classList.contains('editing');
    const previousStateRestoredAfterSave = historyTitle.value === '저장 후 돌아올 계산 초안'
      && from.value === '0'
      && to.value === '1'
      && (document.getElementById('enchant-attempt-cost') as HTMLInputElement).value === '1234'
      && evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'weapon')?.classList.contains('active');
    const cardsAfterEdit = document.querySelectorAll('.history-card').length;
    const editedTitle = document.querySelector('.history-title')?.textContent?.trim();
    const historyShowsBaseType = document.querySelector('.history-card')?.textContent?.includes('가짜 달여왕 군단의 무구 구매');
    (globalThis as any).confirm = () => true;
    document.querySelector<HTMLButtonElement>('.history-card [data-action="delete"]')?.click();
    const cardsAfterDelete = document.querySelectorAll('.history-card').length;
    evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'helm')?.click();
    historyTitle.value = '이클립스 투구 제작안';
    (document.getElementById('save-history-button') as HTMLButtonElement).click();
    const equipmentHistoryPart = document.querySelector('.history-part')?.textContent?.trim();
    evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'weapon')?.click();
    from.value = '1';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    to.value = '2';
    to.dispatchEvent(new Event('change', { bubbles: true }));
    setInput('enchant-attempt-cost', '2345');
    historyTitle.value = '취소 후 돌아올 계산 초안';
    document.querySelector<HTMLButtonElement>('.history-card [data-action="edit"]')?.click();
    (document.getElementById('cancel-edit-button') as HTMLButtonElement).click();
    const editingClearedAfterCancel = document.getElementById('editing-status')?.classList.contains('hidden')
      && !document.querySelector('.history-card')?.classList.contains('editing');
    const previousStateRestoredAfterCancel = historyTitle.value === '취소 후 돌아올 계산 초안'
      && from.value === '1'
      && to.value === '2'
      && (document.getElementById('enchant-attempt-cost') as HTMLInputElement).value === '2345'
      && evolutionOptionButtons.find(button => button.dataset.evolutionOption === 'weapon')?.classList.contains('active');
    document.querySelector<HTMLButtonElement>('.history-card [data-action="delete"]')?.click();
    const cardsAfterEquipmentDelete = document.querySelectorAll('.history-card').length;
    const scrollArea = document.querySelector<HTMLElement>('.scroll-area');
    if (scrollArea) scrollArea.scrollTop = 120;
    await new Promise(resolve => requestAnimationFrame(resolve));

    return {
      title,
      evolutionOptionLabels,
      helmSelectedDirectly,
      equipmentStartLabel,
      weaponReselectedDirectly,
      citrineFit,
      ancientWeaponFit,
      eclipseVisible,
      materialNames,
      visibleMaterialImages,
      specialMaterialImageNames,
      equipmentImageCount,
      styledTierSelectCount,
      inputSubtotals,
      materialNameFontSize,
      numberInputFontSize,
      historyTitleFontSize,
      targetOptionsAfterStartChange,
      baseTypeValues,
      customRadioStyles,
      baseChoiceTextAlignments,
      baseCostHiddenForDirect,
      baseCostVisibleForPurchase,
      historyShowsBaseType,
      calculatorScrollWorks: Boolean(scrollArea
        && scrollArea.scrollHeight > scrollArea.clientHeight
        && scrollArea.scrollTop > 0
        && ['auto', 'scroll'].includes(getComputedStyle(scrollArea).overflowY)),
      totalBeforeSave,
      editLoadedTitle,
      editingCardHighlighted,
      editingBadgeText,
      editingStatusText,
      editingStatusVisible,
      editingClearedAfterSave,
      editingClearedAfterCancel,
      previousStateRestoredAfterSave,
      previousStateRestoredAfterCancel,
      weaponHistoryPart,
      equipmentHistoryPart,
      cardsAfterEdit,
      editedTitle,
      cardsAfterDelete,
      cardsAfterEquipmentDelete,
      fixedHerbLabel: document.getElementById('seal-self-fields')?.textContent?.includes('6억 5,000만 시드'),
    };
  });

  assert.ok(result.title.includes('진화'), '진화 재료 계산기 창 타이틀이 일치하지 않습니다.');
  assert.deepEqual(result.evolutionOptionLabels, ['무기', '투구', '갑옷', '손', '다리', '몸', '머리', '손목'],
    '무기와 일곱 장비 부위가 한 줄 선택 항목으로 표시되지 않습니다.');
  assert.equal(result.helmSelectedDirectly, true, '장비 탭을 거치지 않고 투구를 바로 선택할 수 없습니다.');
  assert.equal(result.equipmentStartLabel, '엔키라', '투구 직접 선택이 장비 진화 단계로 전환되지 않습니다.');
  assert.equal(result.weaponReselectedDirectly, true, '무기 선택으로 바로 돌아오지 못합니다.');
  assert.match(result.citrineFit, /fit-portrait/, '세로가 긴 시트린 이미지가 높이 기준으로 표시되지 않습니다.');
  assert.match(result.ancientWeaponFit, /fit-landscape/, '가로가 긴 재료 이미지가 너비 기준으로 표시되지 않습니다.');
  assert.equal(result.eclipseVisible, true, '어비스→이클립스 선택에서 전용 비용 입력이 표시되지 않습니다.');
  assert.deepEqual(result.baseTypeValues.sort(), ['abyss-equipment', 'direct-evolution', 'fake-armament'],
    '직접 진화·어비스 장비 구매·가짜 달여왕 군단의 무구 구매 선택이 모두 제공되지 않습니다.');
  assert.ok(result.customRadioStyles.every(style => style.appearance === 'none'
    && style.width >= 16 && style.height >= 16 && style.borderStyle === 'solid'),
  '이클립스 선택 라디오 버튼에 계산기 전용 디자인이 적용되지 않았습니다.');
  assert.equal(result.customRadioStyles.find((_, index) => index === 0)?.borderColor, 'rgb(163, 230, 53)',
    '선택한 라디오 버튼에 진화 재료 비용 계산기의 녹색 강조색이 적용되지 않았습니다.');
  assert.ok(result.baseChoiceTextAlignments.every(alignment => alignment === 'left' || alignment === 'start'),
    '베이스 장비 확보 방식의 제목과 설명이 왼쪽 정렬되지 않습니다.');
  assert.equal(result.baseCostHiddenForDirect, true, '직접 진화 방식에서 불필요한 장비 구매비 입력이 표시됩니다.');
  assert.equal(result.baseCostVisibleForPurchase, true, '완성 장비 구매 방식에서 구매비 입력이 표시되지 않습니다.');
  assert.equal(result.historyShowsBaseType, true, '계산 이력에 선택한 베이스 장비 확보 방식이 표시되지 않습니다.');
  assert.equal(result.fixedHerbLabel, true, '직접 제작 달의 약초 6.5억 고정 비용이 표시되지 않습니다.');
  assert.equal(result.materialNames.includes('달의 약초'), false,
    '직접·대리 제작 분기 재료가 일반 재료에도 중복 표시됩니다.');
  assert.ok(result.visibleMaterialImages >= 1, '기존 소스의 진화 재료 이미지가 계산기에 표시되지 않습니다.');
  assert.deepEqual(result.specialMaterialImageNames, [
    '가공된 달의 광물', '가짜 달여왕 군단의 무구', '가짜 달여왕 군단의 인장', '달의 약초', '룬의 원석',
  ].sort(), '이클립스 전용 무구·인장·재료 이미지가 모두 표시되지 않습니다.');
  assert.equal(result.equipmentImageCount, 0, '진화 단계 선택 영역에 불필요한 장비 이미지가 남아 있습니다.');
  assert.equal(result.styledTierSelectCount, 2, '시작·목표 단계 드롭다운에 전용 디자인이 적용되지 않았습니다.');
  assert.deepEqual(result.inputSubtotals, {
    enchantScroll: '소계 200만 시드',
    enchantAttempt: '소계 200만 시드',
    magicReform: '소계 300만 시드',
    additionalOption: '소계 400만 시드',
    abilityMount: '소계 500만 시드',
    attributeGrant: '소계 600만 시드',
    enhancement: '소계 700만 시드',
    eclipseBase: '소계 500만 시드',
    moonMineral: '소계 600만 시드',
    runeStone: '소계 700만 시드',
    sealProxy: '소계 800만 시드',
  }, '장비 후처리와 이클립스 전용 비용의 입력별 시드 소계가 올바르지 않습니다.');
  assert.ok(result.materialNameFontSize >= 13 && result.numberInputFontSize >= 13 && result.historyTitleFontSize >= 16,
    '진화 재료 계산기의 주요 글자 크기가 읽기 편한 기준보다 작습니다.');
  assert.ok(result.targetOptionsAfterStartChange.every(value => value > 3),
    '목표 단계 드롭다운에서 시작 단계 이전 항목을 다시 선택할 수 있습니다.');
  assert.equal(result.calculatorScrollWorks, true, '진화 재료와 추가 비용 영역을 스크롤할 수 없습니다.');
  assert.equal(result.totalBeforeSave, '6억 9,700만 시드', '추가 비용을 포함한 화면 최종 계산값이 다릅니다.');
  assert.equal(result.editLoadedTitle, '이클립스 무기 제작안', '계산 이력 수정 시 저장값을 불러오지 못합니다.');
  assert.equal(result.editingCardHighlighted, true, '현재 수정 중인 계산 이력 카드가 강조되지 않습니다.');
  assert.equal(result.editingBadgeText, '수정 중', '현재 수정 중인 계산 이력 카드에 상태 배지가 표시되지 않습니다.');
  assert.equal(result.editingStatusVisible, true, '계산 영역에 수정 중인 이력 안내가 표시되지 않습니다.');
  assert.match(result.editingStatusText || '', /이클립스 무기 제작안.*수정 중/, '수정 중 안내에 이력 제목이 표시되지 않습니다.');
  assert.equal(result.editingClearedAfterSave, true, '변경 저장 후 수정 중 표시가 남아 있습니다.');
  assert.equal(result.editingClearedAfterCancel, true, '수정 취소 후 수정 중 표시가 남아 있습니다.');
  assert.equal(result.previousStateRestoredAfterSave, true, '변경 저장 후 수정 진입 전 계산 상태가 복원되지 않습니다.');
  assert.equal(result.previousStateRestoredAfterCancel, true, '수정 취소 후 수정 진입 전 계산 상태가 복원되지 않습니다.');
  assert.equal(result.weaponHistoryPart, '무기', '무기 계산 이력에 선택 부위가 표시되지 않습니다.');
  assert.equal(result.equipmentHistoryPart, '투구', '장비 계산 이력에 선택 부위가 표시되지 않습니다.');
  assert.equal(result.cardsAfterEdit, 1, '계산 이력 수정이 새 이력을 중복 생성합니다.');
  assert.equal(result.editedTitle, '이클립스 무기 수정안', '계산 이력 제목 수정이 저장되지 않습니다.');
  assert.equal(result.cardsAfterDelete, 0, '계산 이력 삭제가 동작하지 않습니다.');
  assert.equal(result.cardsAfterEquipmentDelete, 0, '부위 표시 검사용 계산 이력이 삭제되지 않습니다.');
}

async function checkSienaAuraRenderer(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'siena-aura.html'));
  await waitForRendererCondition(window, `document.querySelectorAll('#auto-stat-name option').length > 0`, '시에나 초기화');
  const failures = await window.webContents.executeJavaScript(`(() => {
    const failures=[];
    const click=id=>document.getElementById(id).click();
    const read=label=>Array.from(document.querySelectorAll('#expectation-view .justify-between'))
      .find(row=>row.firstElementChild?.textContent===label)?.lastElementChild?.textContent;
    const check=(actual,expected,label)=>{if(actual!==expected) failures.push(label+': '+actual+' !== '+expected);};
    // Only the random draw is fixed so every rank is reached through actual amplification.
    // Rendering, slot creation, locking, probability and cost calculations remain production code.
    const random=Math.random;
    Math.random=()=>0;
    try {
      for(const [kind,probabilities] of [['weapon',[0.167,0.005]],['armor',[0.056,0.006]]]) {
        click('btn-'+kind);
        click('tab-stats');
        const target=document.getElementById('auto-stat-name');
        target.value=kind==='weapon'?'찌르기':'물리 피해 저항';target.dispatchEvent(new Event('change'));
        check(document.getElementById('expectation-view').textContent.includes('증폭'),true,kind+' zero rank guidance');
        check(read('1회 시도 시 획득률'),undefined,kind+' zero rank no false probability');
        for(let rank=1;rank<=10;rank++) {
          // Unlock the preceding rank through the same cards a user clicks.
          for(const row of Array.from(document.querySelectorAll('#stat-slots .locked-stat'))) row.click();
          click('tab-amplify'); click('btn-amplify'); click('tab-stats');
          check(document.getElementById('stat-count').textContent,rank+' / 10',kind+' rank');
          for(let locks=0;locks<rank;locks++) {
            if(locks) document.querySelectorAll('#stat-slots .stat-row')[locks-1].click();
            for(const [index,grade] of ['하','상'].entries()) {
              const select=document.getElementById('auto-stat-grade');
              select.value=grade;select.dispatchEvent(new Event('change'));
              const probability=1-Math.pow(1-probabilities[index],rank-locks);
              const label=kind+' rank='+rank+' locks='+locks+' grade='+grade;
              check(read('1회 시도 시 획득률'),(100*probability).toFixed(2)+'%',label+' probability');
              check(read('예상 시도 횟수'),Math.round(1/probability).toLocaleString()+'회',label+' attempts');
              if(kind==='weapon'&&rank===1&&grade==='하') {
                check(read('예상 SEED'),'598만',label+' seed');
                check(read('예상 ELSO'),'898',label+' elso');
                check(read('예상 에이라의 망치'),'5개',label+' hammers');
              }
            }
          }
        }
      }
    } finally {Math.random=random;}
    return failures;
  })()`);
  const extraFailures = await window.webContents.executeJavaScript(`(() => {
    const failures=[];
    const click=id=>document.getElementById(id).click();
    const set=(id,value)=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change'));};
    const read=label=>Array.from(document.querySelectorAll('#expectation-view .justify-between'))
      .find(row=>row.firstElementChild?.textContent===label)?.lastElementChild?.textContent;
    const check=(actual,expected,label)=>{if(actual!==expected) failures.push(label+': '+actual+' !== '+expected);};
    // Independent reference: enumerate every ordered group selection with no repeats,
    // then weight whether the target group is present. Conditional grade shares are fixed.
    const weights=[.0137,.0857,.085,.0053,.0053,.24,.24,.24,.085];
    const reference=(count,target)=>{
      let success=0;
      const visit=(selected,probability)=>{
        if(selected.length===count) {if(selected.includes(target))success+=probability;return;}
        const remaining=weights.reduce((sum,w,i)=>sum+(selected.includes(i)?0:w),0);
        for(let i=0;i<weights.length;i++)if(!selected.includes(i)) visit([...selected,i],probability*weights[i]/remaining);
      };
      visit([],1);return success;
    };
    const targets=[['공격력',0,[.0137,.0047,.0005]],['방어력',1,[.0857,.0357,.0057]],
      ['스탯',2,[.085,.035,.005]],['중딜',3,[.0053,.0013,.0003]],['방무',4,[.0053,.0013,.0003]],
      ['HP',5,[.24,.14,.06]],['MP',6,[.24,.14,.06]],['SP',7,[.24,.14,.06]],['크리',8,[.085,.035,.005]]];
    for(const [rank,count] of [[3,1],[7,2],[10,3]]) {
      click('btn-reset-all');set('instant-rank-select',String(rank));click('btn-instant-rank');click('tab-extra');
      document.querySelector('input[name="item-type"][value="all"]').click();
      for(const [group,index,grades] of targets)for(const [gradeIndex,grade] of ['하','중','상'].entries()) {
        set('auto-extra-name',group);set('auto-extra-grade',grade);
        const probability=reference(count,index)*grades[gradeIndex]/weights[index];
        check(read('1회(슬롯'+count+'개) 시 획득률'),(100*probability).toFixed(2)+'%',group+'/'+rank+'/'+grade);
        check(read('환류의 서 예상 시도'),Math.round(1/probability).toLocaleString()+'회',group+'/'+rank+'/'+grade+' attempts');
      }
    }
    document.querySelector('input[name="item-type"][value="single"]').click();
    check(document.getElementById('expectation-view').textContent.includes('선택해주세요'),true,'single needs selected slot');
    document.querySelector('#extra-slots .extra-row').click();
    const otherGroups=extraOptions.slice(1).map(option=>option.group);
    set('auto-extra-name',otherGroups[0]);
    check(document.getElementById('expectation-view').textContent.includes('중복 등장할 수 없습니다'),true,'single duplicate excluded');
    const available=EXTRA_OPTION_POOL.filter(option=>!otherGroups.includes(option.group));
    const target=available[0];set('auto-extra-name',target.group);set('auto-extra-grade','상');
    const singleProbability=target.grades[2].chance/available.reduce((sum,option)=>sum+option.grades.reduce((s,g)=>s+g.chance,0),0);
    check(read('1회 시도 시 획득률'),(singleProbability*100).toFixed(2)+'%','single unchanged probability');
    // Exercise the actual production draw, with a reproducible random stream only.
    const random=Math.random;let seed=0x09232026,hp=0,attack=0;
    Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    try {
      for(let trial=0;trial<20000;trial++) {
        const used=[];
        for(let slot=0;slot<3;slot++) {const result=drawExtraOption(used);used.push(result.group);}
        if(new Set(used).size!==3)throw new Error('production draw repeated a group');
        if(used.includes('HP'))hp++;
        if(used.includes('공격력'))attack++;
      }
    } finally {Math.random=random;}
    check(Math.abs(hp/20000-.6656989566209397)<.015,true,'production HP sampling');
    check(Math.abs(attack/20000-.05283453207763038)<.005,true,'production attack sampling');
    return failures;
  })()`);
  failures.push(...extraFailures);
  assert.deepEqual(failures, [], failures.join('\n'));
}

async function checkStopwatchRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'stopwatch.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    return { hasBody };
  });

  assert.equal(result.hasBody, true, '스톱워치 화면이 로드되지 않았습니다.');
}

async function checkHuntingPathSimulatorRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'hunting-path-simulator.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('사냥터 동선'), '사냥터 동선 시뮬레이션 창 타이틀이 일치하지 않습니다.');
}

async function checkTradeRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'trade.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const notifyToggle = document.getElementById('notify-toggle');
    return { title, hasNotifyToggle: notifyToggle !== null };
  });

  assert.ok(result.title.includes('거래'), '거래 게시판 모니터 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasNotifyToggle, true, '거래 게시판 알림 빠른 토글이 없습니다.');
}

async function checkGalleryRenderer(window: BrowserWindow): Promise<void> {
  const galleryPath = path.join(projectRoot, 'dist', 'gallery.html');
  const gallerySource = fs.readFileSync(galleryPath, 'utf8');
  const inlineScripts = Array.from(
    gallerySource.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
    match => match[1],
  );
  const galleryScript = inlineScripts.at(-1);
  assert.ok(galleryScript, '갤러리 렌더러 inline script를 찾지 못했습니다.');
  const html = cleanHtmlForTest(galleryPath);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const safetyResult = await window.webContents.executeJavaScript(`
    (async () => {
      const calls = { opened: [], removed: [] };
      window.refreshIcons = () => {};
      window.bindEscapeClose = () => {};
      window.electronAPI = {
        galleryForceCheck: async () => ({}),
        galleryGetWatched: async () => ({}),
        galleryRemoveWatch: no => calls.removed.push(no),
        galleryOpenPost: no => calls.opened.push(no),
        galleryGetNotify: async () => false,
        gallerySetNotify: () => {},
        toggleSettings: () => {},
        onGalleryPosts: callback => { window.__galleryPostsCallback = callback; },
        onGalleryWatchedUpdate: callback => { window.__galleryWatchedCallback = callback; },
        onConfigData: callback => { window.__galleryConfigCallback = callback; },
        onGalleryConnectionStatus: callback => { window.__galleryConnectionCallback = callback; },
      };
      eval(${JSON.stringify(galleryScript)});

      renderWatchList({
        '123': {
          title: '<img id="injected-gallery-watch-title">감시 제목',
          commentCount: 7,
        },
        '12"><img id="injected-gallery-watch-key">': {
          title: '잘못된 키',
          commentCount: 1,
        },
      });
      const watchList = document.getElementById('watch-list');
      const initialWatchRows = watchList.children.length;
      const watchTitle = watchList.querySelector('.watched-card span.truncate')?.textContent;
      watchList.querySelector('.watched-card')?.click();
      watchList.querySelector('button')?.click();

      window.__galleryPostsCallback([
        { no: 456, title: '<svg id="injected-gallery-post-title">게시글', replyCount: 2 },
        { no: '12"><img id="injected-gallery-post-key">', title: '잘못된 게시글', replyCount: 1 },
      ]);
      const postList = document.getElementById('post-list');
      return {
        initialWatchRows,
        watchTitle,
        postRows: postList.children.length,
        postTitle: postList.querySelector('.flex-1')?.textContent,
        injectedCount: document.querySelectorAll(
          '#injected-gallery-watch-title, #injected-gallery-watch-key, '
          + '#injected-gallery-post-title, #injected-gallery-post-key'
        ).length,
        opened: calls.opened,
        removed: calls.removed,
      };
    })()
  `) as {
    initialWatchRows: number;
    watchTitle: string;
    postRows: number;
    postTitle: string;
    injectedCount: number;
    opened: string[];
    removed: number[];
  };

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('갤러리'), '갤러리 모니터 창 타이틀이 일치하지 않습니다.');
  assert.deepEqual(safetyResult, {
    initialWatchRows: 1,
    watchTitle: '<img id="injected-gallery-watch-title">감시 제목',
    postRows: 1,
    postTitle: '<svg id="injected-gallery-post-title">게시글',
    injectedCount: 0,
    opened: ['123'],
    removed: [123],
  }, '갤러리 감시 키·제목이 HTML로 해석되거나 안전한 숫자 ID 경계를 벗어났습니다.');
}

async function checkBuffsPopupRenderer(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'buffs.html'));
  await window.webContents.executeJavaScript('localStorage.clear()');
  await window.reload();
  await waitForSelector(window, '.buff-card');

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const workspacePaneCount = document.querySelectorAll('.buff-workspace > .workspace-pane').length;
    const hasLegacyStepGuide = document.body.textContent?.includes('1. 조합 불러오기') || false;
    const firstCard = document.querySelector<HTMLElement>('.buff-card');
    const detailButton = firstCard?.querySelector<HTMLButtonElement>('.buff-card-main');
    const selectButton = firstCard?.querySelector<HTMLButtonElement>('.buff-select-action');
    const buffList = document.getElementById('buff-list');
    if (buffList) buffList.scrollTop = Math.min(160, buffList.scrollHeight - buffList.clientHeight);
    const scrollBeforeDetail = buffList?.scrollTop || 0;
    detailButton?.click();
    const scrollAfterDetail = buffList?.scrollTop || 0;
    const detailVisible = Boolean(document.querySelector('.buff-card.inspected .buff-card-detail'));
    const selectionCountAfterDetail = document.getElementById('selection-count')?.textContent?.trim();
    selectButton?.click();
    const selectionCountAfterSelect = document.getElementById('selection-count')?.textContent?.trim();
    const duplicateSelectedListRemoved = document.getElementById('selected-buff-list') === null;
    const hasStandardPreset = Boolean(document.querySelector('[data-preset-id="standard"]'));
    const selectedCreationButton = document.getElementById('begin-selected-preset-button') as HTMLButtonElement;
    const selectedCreationEnabled = !selectedCreationButton.disabled;
    selectedCreationButton.click();
    const presetName = document.getElementById('preset-name') as HTMLInputElement;
    const createModeTitle = document.getElementById('preset-save-title')?.textContent?.trim();
    const createModeButton = document.getElementById('save-preset-button')?.textContent?.trim();
    const draftPresetVisible = Boolean(document.querySelector('[data-preset-id="new"].creating.active'));
    presetName.value = '테스트 조합';
    document.getElementById('save-preset-button')?.click();
    const customPresetCard = Array.from(document.querySelectorAll<HTMLElement>('.preset-card'))
      .find(card => !['direct', 'standard', 'new'].includes(card.dataset.presetId || ''));
    const savedPresetVisible = customPresetCard?.textContent?.includes('테스트 조합') || false;
    customPresetCard?.querySelector<HTMLButtonElement>('[data-action="edit-preset"]')?.click();
    const presetEditStatusVisible = !document.getElementById('preset-editing-status')?.classList.contains('hidden');
    const presetEditStatusText = document.getElementById('preset-editing-status')?.textContent?.replace(/\s+/g, ' ').trim();
    const presetEditButtonText = document.getElementById('save-preset-button')?.textContent?.trim();
    presetName.value = '테스트 조합 수정';
    document.getElementById('save-preset-button')?.click();
    const savedPresets = JSON.parse(localStorage.getItem('buff_presets') || '[]');
    const presetEditingClearedAfterSave = document.getElementById('preset-editing-status')?.classList.contains('hidden');
    const currentCombinationContainsPresetControls = Boolean(document.querySelector('.combination-pane #preset-list')
      && document.querySelector('.combination-pane #save-preset-button'));
    const presetListOverflow = getComputedStyle(document.getElementById('preset-list') as Element).overflowY;
    const summaryFooterFixed = getComputedStyle(document.querySelector('.buff-summary-footer') as Element).flexShrink === '0';
    const presetSaveFooterFixed = getComputedStyle(document.querySelector('.preset-save-footer') as Element).flexShrink === '0';
    const names = Array.from(document.querySelectorAll('.buff-name'), element => element.textContent || '');
    const sortedNames = [...names].sort((left, right) => left.localeCompare(right, 'ko-KR', { sensitivity: 'base', numeric: true }));
    return {
      title,
      workspacePaneCount,
      hasLegacyStepGuide,
      hasSeparateDetailButton: Boolean(detailButton),
      hasSeparateSelectButton: Boolean(selectButton),
      scrollBeforeDetail,
      scrollAfterDetail,
      detailVisible,
      selectionCountAfterDetail,
      selectionCountAfterSelect,
      duplicateSelectedListRemoved,
      hasStandardPreset,
      selectedCreationEnabled,
      createModeTitle,
      createModeButton,
      draftPresetVisible,
      savedPresetVisible,
      presetEditStatusVisible,
      presetEditStatusText,
      presetEditButtonText,
      savedPresetCount: savedPresets.length,
      savedPresetName: savedPresets[0]?.name,
      presetEditingClearedAfterSave,
      currentCombinationContainsPresetControls,
      presetListOverflow,
      summaryFooterFixed,
      presetSaveFooterFixed,
      namesSorted: JSON.stringify(names) === JSON.stringify(sortedNames),
    };
  });

  assert.ok(result.title.includes('버프'), '버프 백과 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.workspacePaneCount, 2, '버프 백과와 현재 조합 중심의 2열 화면으로 구성되지 않았습니다.');
  assert.equal(result.hasLegacyStepGuide, false, '선택 사항인 프리셋이 필수 단계처럼 보이는 기존 안내가 남아 있습니다.');
  assert.equal(result.hasSeparateDetailButton, true, '버프 카드의 상세 보기 동작이 제공되지 않습니다.');
  assert.equal(result.hasSeparateSelectButton, true, '버프 카드의 조합 선택 버튼이 별도로 제공되지 않습니다.');
  assert.ok(result.scrollBeforeDetail > 0, '버프 상세 펼치기의 스크롤 유지 검사를 수행하지 못했습니다.');
  assert.ok(Math.abs(result.scrollAfterDetail - result.scrollBeforeDetail) <= 1,
    `버프 상세 펼치기 후 스크롤 위치가 변경됩니다: ${result.scrollBeforeDetail} -> ${result.scrollAfterDetail}`);
  assert.equal(result.detailVisible, true, '버프 카드를 눌러도 상세 설명이 펼쳐지지 않습니다.');
  assert.equal(result.selectionCountAfterDetail, '0개', '버프 상세 보기만 했는데 현재 조합이 변경됩니다.');
  assert.equal(result.selectionCountAfterSelect, '1개', '버프 선택 버튼이 현재 조합에 반영되지 않습니다.');
  assert.equal(result.duplicateSelectedListRemoved, true, '선택한 버프 목록이 오른쪽 영역에 중복으로 표시됩니다.');
  assert.equal(result.hasStandardPreset, true, '기본 도핑 세트 카드가 프리셋 목록에 없습니다.');
  assert.equal(result.selectedCreationEnabled, true, '버프 선택 후 선택값으로 프리셋 만들기 버튼이 활성화되지 않습니다.');
  assert.equal(result.createModeTitle, '선택된 버프로 프리셋 생성', '선택값 기반 프리셋 생성 상태의 제목이 명확하지 않습니다.');
  assert.equal(result.createModeButton, '새 프리셋 저장', '새 프리셋 저장 버튼의 동작이 명확하지 않습니다.');
  assert.equal(result.draftPresetVisible, true, '생성 중인 새 프리셋 카드가 목록에 강조 표시되지 않습니다.');
  assert.equal(result.savedPresetVisible, true, '현재 조합을 새 프리셋으로 저장하지 못합니다.');
  assert.equal(result.presetEditStatusVisible, true, '저장된 프리셋의 수정 상태가 표시되지 않습니다.');
  assert.match(result.presetEditStatusText || '', /테스트 조합.*프리셋 수정 중/, '수정 중인 프리셋 이름이 안내에 표시되지 않습니다.');
  assert.equal(result.presetEditButtonText, '변경 저장', '프리셋 수정 저장 버튼이 생성 동작과 구분되지 않습니다.');
  assert.equal(result.savedPresetCount, 1, '프리셋 수정 저장이 중복 프리셋을 생성합니다.');
  assert.equal(result.savedPresetName, '테스트 조합 수정', '수정한 프리셋 이름이 기존 항목에 저장되지 않습니다.');
  assert.equal(result.presetEditingClearedAfterSave, true, '프리셋 변경 저장 후 수정 상태가 남아 있습니다.');
  assert.equal(result.currentCombinationContainsPresetControls, true, '프리셋 선택과 저장이 계산 조합 영역에 모이지 않았습니다.');
  assert.ok(['auto', 'scroll'].includes(result.presetListOverflow), '프리셋 목록을 독립적으로 스크롤할 수 없습니다.');
  assert.equal(result.summaryFooterFixed, true, '합산 결과가 버프 목록 아래에 고정되지 않습니다.');
  assert.equal(result.presetSaveFooterFixed, true, '현재 조합 저장 영역이 오른쪽 하단에 고정되지 않습니다.');
  assert.equal(result.namesSorted, true, '버프 이름이 가나다순으로 표시되지 않습니다.');
}

async function checkGameExitReminderRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'game-exit-reminder.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    return { hasBody };
  });

  assert.equal(result.hasBody, true, '게임 종료 리마인더 화면이 로드되지 않았습니다.');
}

async function checkOverlayContainerRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'overlay.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    return { hasBody };
  });

  assert.equal(result.hasBody, true, '오버레이 컨테이너 화면이 로드되지 않았습니다.');
}

async function checkSplashRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'splash.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    return { hasBody };
  });

  assert.equal(result.hasBody, true, '스플래시 화면이 로드되지 않았습니다.');
}

async function main(): Promise<void> {
  app.commandLine.appendSwitch('disable-gpu');
  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();
  if (process.argv.includes('--qte')) {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
    try {
      await checkQteChallengeRenderer(window);
      console.log('QTE terminal round and stage checks passed.');
    } finally { window.destroy(); }
    app.exit(0);
    return;
  }
  if (process.argv.includes('--siena-aura')) {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
    try {
      await checkSienaAuraRenderer(window);
      console.log('Siena aura slot expectation checks passed.');
    } finally { window.destroy(); }
    app.exit(0);
    return;
  }
  if (process.argv.includes('--equipment-simulator')) {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
    try {
      await checkEquipmentSimulator(window);
      console.log('Equipment simulator behavior checks passed.');
    } finally {
      window.destroy();
    }
    app.exit(0);
    return;
  }
  if (process.argv.includes('--thesis-core')) {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
    try {
      await checkThesisCoreCalculator(window);
      console.log('Thesis core behavior checks passed.');
    } finally {
      window.destroy();
    }
    app.exit(0);
    return;
  }
  if (process.argv.includes('--alarm-volume')) {
    await checkAlarmVolumeBoundaries();
    console.log('Alarm volume boundary checks passed.');
    app.exit(0);
    return;
  }
  ipcMain.handle('nickname-info-get', () => ({level:null,characterName:null,collectDate:null,stale:true}));
  checkNativeModuleCompatibility();
  await checkLifecycleStartIsIdempotent();
  await checkBuffRefreshPolicy();
  await checkContentsOrderingPersistence();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  try {
    console.log('[TEST] checkContentsChecklist');
    await checkContentsChecklist(window);
    console.log('[TEST] checkPendingHomeworkCloudUi');
    await checkPendingHomeworkCloudUi();
    console.log('[TEST] checkRendererHelpers');
    await checkRendererHelpers(window);
    console.log('[TEST] checkTodaySummaryRenderer');
    await checkTodaySummaryRenderer(window);
    console.log('[TEST] checkTodaySummarySettingsLayout');
    await checkTodaySummarySettingsLayout(window);
    console.log('[TEST] checkCustomChatTabSettings');
    await checkCustomChatTabSettings(window);
    console.log('[TEST] checkHudPositionEditSettingsSafety');
    await checkHudPositionEditSettingsSafety(window);
    console.log('[TEST] checkSettingsDeepLinkRouting');
    await checkSettingsDeepLinkRouting(window);
    console.log('[TEST] checkGoogleRestoreSelection');
    await checkGoogleRestoreSelection(window);
    console.log('[TEST] checkHuntingExpCalculator');
    await checkHuntingExpCalculator(window);
    console.log('[TEST] checkRelicCalculator');
    await checkRelicCalculator(window);
    console.log('[TEST] checkEquipmentSimulator');
    await checkEquipmentSimulator(window);
    console.log('[TEST] checkCoefficientDropdown');
    await checkCoefficientDropdown(window);
    console.log('[TEST] checkFocusedChat');
    await checkFocusedChat(window);
    console.log('[TEST] checkFocusedChatSettings');
    await checkFocusedChatSettings();
    console.log('[TEST] checkChatOverlayRenderer');
    await checkChatOverlayRenderer(window);
    console.log('[TEST] checkDiaryRenderer');
    await checkDiaryRenderer(window);
    console.log('[TEST] checkShoutHistoryRenderer');
    await checkShoutHistoryRenderer(window);
    console.log('[TEST] checkXpHudRenderer');
    await checkXpHudRenderer(window);
    console.log('[TEST] checkHuntingAssistRenderer');
    await checkHuntingAssistRenderer(window);
    console.log('[TEST] checkBuffTimerRenderer');
    await checkBuffTimerRenderer(window);
    console.log('[TEST] checkWordAlarmRenderer');
    await checkWordAlarmRenderer(window);
    console.log('[TEST] checkBossSettingsRenderer');
    await checkBossSettingsRenderer(window);
    await checkAlarmVolumeBoundaries();
    console.log('[TEST] checkMagicStoneCalculator');
    await checkMagicStoneCalculator(window);
    console.log('[TEST] checkThesisCoreCalculator');
    await checkThesisCoreCalculator(window);
    console.log('[TEST] checkAbbreviationRenderer');
    await checkAbbreviationRenderer(window);
    console.log('[TEST] checkEquipmentDicRenderer');
    await checkEquipmentDicRenderer(window);
    console.log('[TEST] checkEtaRankingRenderer');
    await checkEtaRankingRenderer(window);
    console.log('[TEST] checkQteChallengeRenderer');
    await checkQteChallengeRenderer(window);
    console.log('[TEST] checkDockRenderer');
    await checkDockRenderer(window);
    console.log('[TEST] checkIndexRenderer');
    await checkIndexRenderer(window);
    console.log('[TEST] checkCustomAlertRenderer');
    await checkCustomAlertRenderer(window);
    console.log('[TEST] checkDiscordAlarmRenderer');
    await checkDiscordAlarmRenderer(window);
    console.log('[TEST] checkScamDetectorRenderer');
    await checkScamDetectorRenderer(window);
    console.log('[TEST] checkEvolutionCalculatorRenderer');
    await checkEvolutionCalculatorRenderer(window);
    console.log('[TEST] checkSienaAuraRenderer');
    await checkSienaAuraRenderer(window);
    console.log('[TEST] checkStopwatchRenderer');
    await checkStopwatchRenderer(window);
    console.log('[TEST] checkHuntingPathSimulatorRenderer');
    await checkHuntingPathSimulatorRenderer(window);
    console.log('[TEST] checkTradeRenderer');
    await checkTradeRenderer(window);
    console.log('[TEST] checkGalleryRenderer');
    await checkGalleryRenderer(window);
    console.log('[TEST] checkBuffsPopupRenderer');
    await checkBuffsPopupRenderer(window);
    console.log('[TEST] checkGameExitReminderRenderer');
    await checkGameExitReminderRenderer(window);
    console.log('[TEST] checkOverlayContainerRenderer');
    await checkOverlayContainerRenderer(window);
    console.log('[TEST] checkSplashRenderer');
    await checkSplashRenderer(window);
    console.log('[TEST] checkGameOverlayEditMode');
    await checkGameOverlayEditMode(window);
    await checkCompanionHud(window);
    console.log('[TEST] checkPinnedNoteReading');
    await checkPinnedNoteReading(window);
    await checkActivityPresetsRenderer(window);
    await checkManagedWindowResizeLimits(window);
    await checkNicknameNoteEscape(window);
    await checkNicknameNoteSaveOrdering(window);
    await checkNotificationLayout(window);
    console.log('[TEST] checkWelcomeGuideTabs');
    await checkWelcomeGuideTabs(window);
    console.log('Renderer behavior checks passed.');
  } finally {
    if (!window.isDestroyed()) window.destroy();
    try {
      fs.rmSync(testUserDataDirectory, { recursive: true, force: true });
    } catch {
      // Windows에서 SQLite 핸들이 종료 직전까지 유지되는 경우는 다음 임시 폴더 정리에 맡깁니다.
    }
    app.quit();
  }
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
