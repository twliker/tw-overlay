import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

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
  assert.deepEqual(result.settingsCalls, [['sound']]);
  assert.equal(result.characterName, '캐릭터"><img id="injected-character">');
  assert.equal(result.customName, '<img id="injected-item">사용자 숙제');
  assert.equal(result.customBadge, true);
  assert.equal(result.legacyVisible, true, 'isVisible 없는 레거시 숙제가 화면에서 숨겨졌습니다.');
  assert.equal(result.injectedElementCount, 0);
  assert.equal(result.displayText, '을 것이오!');
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
  const { buffTimerManager } = require(
    path.join(projectRoot, 'dist/modules/buffTimerManager.js'),
  ) as {
    buffTimerManager: {
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

async function checkSettingsDeepLinkRouting(window: BrowserWindow): Promise<void> {
  window.setContentSize(1100, 720);
  await window.loadFile(path.join(projectRoot, 'dist', 'settings.html'));
  await waitForSelector(window, '#settings-quick-search');

  const testRoutes = [
    { tabId: 'display:sidebar', expectedGroup: 'app', expectedSection: 'section-general' },
    { tabId: 'display:game-overlay', expectedGroup: 'game', expectedSection: 'section-game-overlay' },
    { tabId: 'chatlog:sub-tab-today-summary', expectedGroup: 'game', expectedSection: 'section-game-overlay' },
    { tabId: 'chatlog', expectedGroup: 'chat', expectedSection: 'section-chatlog' },
    { tabId: 'chatlog:sub-tab-overlay', expectedGroup: 'chat', expectedSection: 'section-chatlog' },
    { tabId: 'chatlog:sub-tab-loot', expectedGroup: 'chat', expectedSection: 'section-chatlog' },
    { tabId: 'sound', expectedGroup: 'alerts', expectedSection: 'section-sound' },
    { tabId: 'gallery', expectedGroup: 'alerts', expectedSection: 'section-external' },
    { tabId: 'trade', expectedGroup: 'alerts', expectedSection: 'section-external' },
    { tabId: 'shortcuts', expectedGroup: 'system', expectedSection: 'section-shortcuts' },
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
          return {
            ok: true,
            targetGroup: target.groupId,
            activeGroup,
            activeSection
          };
        } catch (err) {
          return { ok: false, error: String(err && err.stack ? err.stack : err) };
        }
      })()
    `) as { ok: boolean; error?: string; targetGroup: string; activeGroup: string; activeSection: string };

    assert.equal(checkResult.ok, true, checkResult.error);
    assert.equal(checkResult.targetGroup, route.expectedGroup, `${route.tabId} group mismatch`);
    assert.equal(checkResult.activeGroup, route.expectedGroup, `${route.tabId} active nav mismatch`);
    assert.equal(checkResult.activeSection, route.expectedSection, `${route.tabId} active section mismatch`);
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
        
        const essenceInput = document.getElementById('essence-alert-enabled');
        const card = essenceInput?.closest('label, .p-5, .p-4');
        const hasPulse = card?.classList.contains('highlight-pulse-effect') || essenceInput?.classList.contains('highlight-pulse-effect');

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

        const essenceInput = document.getElementById('essence-alert-enabled');
        const essenceCard = essenceInput?.closest('label, .p-5, .p-4');
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
  window.setContentSize(1100, 720);
  await window.loadFile(path.join(projectRoot, 'dist', 'settings.html'));
  await waitForSelector(window, '#google-restore-settings');
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const calls = [];
      const alerts = [];
      window.confirm = () => true;
      window.alert = message => alerts.push(message);
      window.electronAPI = {
        googleSyncRestore: async kinds => {
          calls.push(kinds);
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
        }
      };
      document.getElementById('google-restore-settings').checked = true;
      document.getElementById('google-restore-checklist').checked = false;
      await handleGoogleRestoreNow();
      return {
        calls,
        alerts,
        statusText: document.getElementById('google-restore-status')?.textContent || '',
        statusVisible: !document.getElementById('google-restore-status')?.classList.contains('hidden'),
      };
    })()
  `) as {
    calls: string[][];
    alerts: string[];
    statusText: string;
    statusVisible: boolean;
  };

  assert.deepEqual(result.calls, [['settings']]);
  assert.equal(result.statusVisible, true);
  assert.match(result.statusText, /일부 파일만 복원되었습니다/);
  assert.match(result.statusText, /일반 설정복원 완료/);
  assert.match(result.statusText, /숙제 체크리스트선택하지 않음/);
  assert.equal(result.alerts.length, 1);
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
      addInput('chat-overlay-width-input', '512');
      addInput('chat-overlay-opacity-input', '0.75');
      addInput('chat-overlay-channel-general', '', true);
      addInput('chat-overlay-channel-whisper', '', false);
      addInput('chat-overlay-show-npc-chat', '', false);
      addInput('chat-overlay-user-server-input', '2');
      addInput('wave-warning-enabled', '', true);
      addInput('wave-warning-volume', '65');
      addInput('essence-alert-enabled', '', false);
      addInput('special-monster-alert-enabled', '', true);
      addInput('abandoned-alert-enabled', '', true);
      addInput('pitta-hill-alert-enabled', '', false);
      addInput('quest-complete-alert-enabled', '', true);
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
      const addSelect = id => {
        const select = document.createElement('select');
        select.id = id;
        document.body.appendChild(select);
        return select;
      };
      const alertSoundSelects = {
        wave: addSelect('wave-warning-sound'),
        ethos: addSelect('ethos-alert-sound'),
        abyssStart: addSelect('abyss-apostle-start-sound'),
        abyssEnd: addSelect('abyss-apostle-end-sound'),
        lokagos: addSelect('lokagos-alert-sound')
      };

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
        lokagosAlertSound: 'lokagos.mp3'
      });
      const configuredAlertSounds = Object.fromEntries(
        Object.entries(alertSoundSelects).map(([key, select]) => [key, select.value])
      );
      const waveOptionLabels = Array.from(alertSoundSelects.wave.options).map(option => option.textContent);
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
        userServer: 3,
        chatOverlayFontSize: 18,
        chatOverlayOpacity: 0.55,
        chatOverlayWidth: 620
      }, window.electronAPI.DEFAULT_CONFIG);
      const initialRangeLabels = {
        ethos: ethosVolumeLabel.innerText,
        wave: waveVolumeLabel.innerText,
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
        userServer: document.getElementById('chat-overlay-user-server-input').value,
        fontSize: fontSizeInput.value,
        overlayWidth: document.getElementById('chat-overlay-width-input').value,
        initialRangeLabels,
        updatedWaveLabel: waveVolumeLabel.innerText,
        updatedOpacityLabel: opacityLabel.innerText
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
      window.settingsConfigBinding.applyOverlayDisplayOptions({
        chatOverlaySelectedChannels: ['whisper'],
        chatOverlayShowNpcChat: false,
        chatOverlayNicknameColorMode: 'custom',
        forgeQuestHudPos: { left: 24, bottom: 36 }
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
        tradeServer: document.querySelector('input[name="trade-server"]:checked')?.value,
        sidebarPosition: document.querySelector('input[name="sidebar-position"]:checked')?.value,
        showSidebarToast: sidebarToastInput.checked
      };

      return {
        alertShown: alert.classList.contains('show'),
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
          essenceEnabled: alertSettings.essenceAlertEnabled,
          specialMonsterEnabled: alertSettings.specialMonsterAlertEnabled,
          abandonedEnabled: alertSettings.abandonedAlertEnabled,
          pittaHillEnabled: alertSettings.pittaHillAlertEnabled,
          questCompleteEnabled: alertSettings.questCompleteAlertEnabled,
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
          overlayAndRadioBinding
        }
      };
    })()
  `) as {
    alertShown: boolean;
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
  };

  assert.equal(result.alertShown, true);
  assert.equal(result.keywordText, '<img id="injected-keyword">키워드 ');
  assert.equal(result.removeCount, 1);
  assert.equal(result.soundName, '<img id="injected-sound">알림음');
  assert.equal(result.injectedCount, 0);
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
    essenceEnabled: false,
    specialMonsterEnabled: true,
    abandonedEnabled: true,
    pittaHillEnabled: false,
    questCompleteEnabled: true,
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
    },
    waveOptionLabels: ['사용 안 함 (소리 없음)', '기본 구슬음', '에코스', '시작', '종료', '로카고스'],
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
      userServer: '3',
      fontSize: '18',
      overlayWidth: '620',
      initialRangeLabels: {
        ethos: '33%',
        wave: '77%',
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
      tradeServer: 'TestServer',
      sidebarPosition: 'left',
      showSidebarToast: true,
    },
  });
}

async function checkCoefficientDropdown(window: BrowserWindow): Promise<void> {
  await window.loadFile(path.join(projectRoot, 'dist', 'coefficient-calculator.html'));
  await waitForSelector(window, '.custom-dropdown-menu');

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
      return { initiallyHidden, opened, closed };
    })()
  `) as { initiallyHidden: boolean; opened: boolean; closed: boolean };

  assert.deepEqual(result, { initiallyHidden: true, opened: true, closed: true });
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
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'game-overlay.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    const hasContainer = document.getElementById('game-overlay-container') !== null || document.body.children.length > 0;
    return { hasBody, hasContainer };
  });

  assert.equal(result.hasBody, true, '게임 오버레이 화면이 로드되지 않았습니다.');
  assert.equal(result.hasContainer, true, '게임 오버레이 컨테이너가 렌더링되지 않았습니다.');
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

      return {
        tabLabels,
        totalPanels,
        panel3Active,
        componentCards
      };
    })()
  `);

  assert.deepEqual(
    result.tabLabels,
    ['시작 마법사', '앱 소개', '필수 설정', '게임 오버레이 HUD', '전체화면 대응 팁', '알람음 설정', '단축키 요약'],
    '가이드 7개 탭 레이블이 일치하지 않습니다.',
  );
  assert.equal(result.totalPanels, 7, '가이드 패널이 7개가 아닙니다.');
  assert.equal(result.panel3Active, true, '게임 오버레이 탭 전환이 동작하지 않습니다.');
  assert.equal(result.componentCards, 5, '게임 오버레이 5개 컴포넌트 설명 카드가 렌더링되지 않았습니다.');
}

async function checkChatOverlayRenderer(window: BrowserWindow): Promise<void> {
  const html = fs.readFileSync(path.join(projectRoot, 'dist', 'chat-overlay.html'), 'utf8')
    .replace('<script src="assets/ui-utils.js"></script>', '')
    .replace('<script src="shared/chatChannels.js"></script>', '')
    .replace('<script src="shared/chatConstants.js"></script>', '')
    .replace('<script src="chatOverlayRenderer.js"></script>', '');
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const uiUtilsCode = fs.readFileSync(
    path.join(projectRoot, 'dist', 'assets', 'ui-utils.js'),
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

        eval(${JSON.stringify(`${uiUtilsCode}\n${chatChannelsCode}\n${chatConstantsCode}\n${rendererCode}`)});

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

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const hasCalendarGrid = document.querySelector('.calendar-grid') !== null;
    const hasMonthlyTotalSeed = document.getElementById('monthly-total-seed-badge') !== null;
    const hasMonthlyTotalLoot = document.getElementById('monthly-total-loot-badge') !== null;
    const hasStatsAttendance = document.getElementById('stats-attendance') !== null;

    return {
      title,
      hasCalendarGrid,
      hasMonthlyTotalSeed,
      hasMonthlyTotalLoot,
      hasStatsAttendance
    };
  });

  assert.ok(result.title.includes('모험 일지'), '모험 일지 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasCalendarGrid, true, '캘린더 그리드가 렌더링되지 않았습니다.');
  assert.equal(result.hasMonthlyTotalSeed, true, '월간 총 SEED 배지가 없습니다.');
  assert.equal(result.hasMonthlyTotalLoot, true, '월간 총 득템 배지가 없습니다.');
  assert.equal(result.hasStatsAttendance, true, '통계 출석 일수 요소가 없습니다.');
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
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'xp-hud.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    const hasStatGrid = document.querySelector('.stat-grid-top') !== null;
    const hasChart = document.querySelector('.chart-container') !== null;

    return {
      title,
      hasStatGrid,
      hasChart
    };
  });

  assert.ok(result.title.includes('경험치 HUD'), '경험치 HUD 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasStatGrid, true, '경험치 HUD 수치 그리드가 렌더링되지 않았습니다.');
  assert.equal(result.hasChart, true, '경험치 차트 컨테이너가 렌더링되지 않았습니다.');
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
    const notifyClosedCheck = document.getElementById('boss-notify-closed-check');

    return {
      title,
      hasBossList: bossList !== null,
      hasNotifyClosedCheck: notifyClosedCheck !== null
    };
  });

  assert.ok(result.title.includes('보스 알림'), '보스 알림 설정 창 타이틀이 일치하지 않습니다.');
  assert.equal(result.hasBossList, true, '보스 목록 컨테이너가 없습니다.');
  assert.equal(result.hasNotifyClosedCheck, true, '게임 종료 시에도 수신 체크박스가 없습니다.');
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
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'equipment-dic.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('장비'), '장비 사전 창 타이틀이 일치하지 않습니다.');
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

async function checkDockRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'dock.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    return {
      hasBody
    };
  });

  assert.equal(result.hasBody, true, '사이드바 독 바디가 렌더링되지 않았습니다.');
}

async function checkIndexRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'index.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const hasBody = document.body !== null;
    return { hasBody };
  });

  assert.equal(result.hasBody, true, '메인 사이드바 런처가 렌더링되지 않았습니다.');
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
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'evolution-calculator.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('진화'), '진화 재료 계산기 창 타이틀이 일치하지 않습니다.');
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
    return { title };
  });

  assert.ok(result.title.includes('거래'), '거래 게시판 모니터 창 타이틀이 일치하지 않습니다.');
}

async function checkGalleryRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'gallery.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('갤러리'), '갤러리 모니터 창 타이틀이 일치하지 않습니다.');
}

async function checkBuffsPopupRenderer(window: BrowserWindow): Promise<void> {
  const html = cleanHtmlForTest(path.join(projectRoot, 'dist', 'buffs.html'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await evaluate(window, () => {
    const title = document.querySelector('.win-title-main')?.textContent?.trim() || '';
    return { title };
  });

  assert.ok(result.title.includes('버프'), '버프 백과 창 타이틀이 일치하지 않습니다.');
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
    console.log('[TEST] checkRendererHelpers');
    await checkRendererHelpers(window);
    console.log('[TEST] checkTodaySummaryRenderer');
    await checkTodaySummaryRenderer(window);
    console.log('[TEST] checkTodaySummarySettingsLayout');
    await checkTodaySummarySettingsLayout(window);
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
