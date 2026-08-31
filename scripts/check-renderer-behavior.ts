import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
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
      window.electronAPI = {
        DEFAULT_CONFIG: ${JSON.stringify(defaultConfig)},
        getTodaySummary: async () => ({
          date: '2026-08-15',
          totalSeed: 12345678,
          totalElso: 3500,
          totalEssence: 2,
          bossKills: 4,
          totalLootCount: 9,
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
      const initialTop = Number.parseFloat(summary.style.top);
      const defaultCollapsed = summary.classList.contains('collapsed');
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, todaySummaryCollapsed: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      const collapsedApplied = summary.classList.contains('collapsed');
      const compactVisible = getComputedStyle(document.getElementById('today-summary-compact')).display !== 'none';
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, showTodaySummaryHud: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      const hiddenApplied = summary.classList.contains('hidden');
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, todaySummaryCollapsed: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      const restoredVisible = !summary.classList.contains('hidden') && !summary.classList.contains('collapsed');
      configDataCallback({ ...${JSON.stringify(defaultConfig)}, todaySummaryCollapsed: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      const abandoned = document.getElementById('abandoned-widget');
      abandoned.style.left = '200px';
      abandoned.style.bottom = '63px';
      abandoned.classList.remove('hidden');
      abandoned.classList.add('active');
      await new Promise(resolve => setTimeout(resolve, 50));
      const finalTop = Number.parseFloat(summary.style.top);
      diaryUpdatedCallback?.();
      await new Promise(resolve => setTimeout(resolve, 50));

      return {
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
    /(function updateHudEditSaveUi\(editing\) \{[\s\S]*?\r?\n    \})\r?\n\r?\n    async function startHudEditMode/,
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
  assert.deepEqual(result.overlaySettings, {
    width: 512,
    height: 400,
    opacity: 0.75,
    color: '#123456',
    channels: ['general'],
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
    recordedDockInput: 'CommandOrControl+numadd',
    guideAfterRecording: 'Alt+F5',
    resetDockShortcut: 'CommandOrControl+Shift+D',
    resetDockGuide: 'Ctrl+Shift+D',
    defaultClickThrough: 'CommandOrControl+Shift+T',
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
        applySettings: settings => window.__hudPositionSettingWrites.push(settings),
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
    (() => {
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
        applySettings: settings => window.__hudPositionSettingWrites.push(settings),
        onGameOverlayEditMode: callback => { editModeCallback = callback; },
        onGameOverlayResetPositions: () => {},
      };
      eval(${JSON.stringify(editModeCode)});
      editModeCallback(true);
      const buff = document.getElementById('buff-hud');
      buff.style.left = '980px';
      buff.style.bottom = '80px';
      buff.classList.add('hidden');
      editModeCallback(false, true);
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
    .replace('<script src="chatOverlayRenderer.js"></script>', '');
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
          toggleChatOverlay() {},
          toggleChatOverlaySub() {},
          toggleSettings() {},
        };

        eval(${JSON.stringify(`${uiUtilsCode}\n${requestGenerationCode}\n${virtualListCode}\n${chatChannelsCode}\n${chatConstantsCode}\n${rendererCode}`)});

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

      return {
        basicRows,
        hasXss: xssAttempt !== null,
        clubRows,
        systemRows,
        liveSystemRows,
        searchContainerVisible,
        highlightElements,
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
}

function cleanHtmlForTest(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .replace(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*["'][^>]*><\/script>/gi, '');
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
  const html = cleanHtmlForTest(xpHudPath);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await window.webContents.executeJavaScript(`
    (() => {
      let _startTime = Date.now();
      let _accumulatedTime = 0;
      let _isActive = false;
      const xpChart = null;
      const lucide = { createIcons() {} };
      const formatStartTime = () => '테스트 시작';
      const formatXP = value => String(value);
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
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'thesis-core-calculator.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('테시스 코어'), '테시스 코어 계산기 창 타이틀이 일치하지 않습니다.');
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
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'siena-aura.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('시에나'), '시에나의 기운 강화 창 타이틀이 일치하지 않습니다.');
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
    console.log('[TEST] checkChatOverlayRenderer');
    await checkChatOverlayRenderer(window);
    console.log('[TEST] checkDiaryRenderer');
    await checkDiaryRenderer(window);
    console.log('[TEST] checkShoutHistoryRenderer');
    await checkShoutHistoryRenderer(window);
    console.log('[TEST] checkXpHudRenderer');
    await checkXpHudRenderer(window);
    console.log('[TEST] checkBuffTimerRenderer');
    await checkBuffTimerRenderer(window);
    console.log('[TEST] checkWordAlarmRenderer');
    await checkWordAlarmRenderer(window);
    console.log('[TEST] checkBossSettingsRenderer');
    await checkBossSettingsRenderer(window);
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
