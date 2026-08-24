import assert = require('node:assert/strict');
import crypto = require('node:crypto');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import { app } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src');
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-regression-'));
app.setPath('userData', isolatedUserData);
process.once('exit', () => {
  fs.rmSync(isolatedUserData, { recursive: true, force: true });
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function createUiUtilsSandbox(): any {
  const registeredListeners: Record<string, Array<() => void>> = {};
  const window: any = {
    addEventListener(event: string, callback: () => void) {
      (registeredListeners[event] ||= []).push(callback);
    },
    __registeredListeners: registeredListeners,
  };
  const sandbox = {
    window,
    document: {},
    fetch: async () => ({ json: async () => [] }),
    setInterval,
    clearInterval,
    console,
  };
  vm.runInNewContext(read('dist/assets/ui-utils.js'), sandbox, {
    filename: 'dist/assets/ui-utils.js',
  });
  return window;
}

function checkCommonFormatters() {
  const ui = createUiUtilsSandbox();

  assert.equal(ui.formatElapsedTime(0), '00:00:00');
  assert.equal(ui.formatElapsedTime(3_661_000), '01:01:01');
  assert.equal(ui.formatSeedAmount(0), '0 시드');
  assert.equal(ui.formatSeedAmount(9_999), '9,999 시드');
  assert.equal(ui.formatSeedAmount(123_456_789), '1억 2345만 시드');
  assert.equal(
    ui.normalizeChatDisplayText('앞&nbsp;중간&nbsp뒤\u00a0끝'),
    '앞 중간 뒤 끝',
  );
  assert.equal(
    ui.normalizeChatDisplayText('&nbsp &nbsp &nbsp &nbsp &nbsp 을 것이오!'),
    '을 것이오!',
  );
  assert.deepEqual(
    ['하늘2', '가람', '하늘10', '나래'].sort(ui.compareKoreanText),
    ['가람', '나래', '하늘2', '하늘10'],
  );
  assert.equal(ui.escapeHtml('<a "b">&'), '&lt;a &quot;b&quot;&gt;&amp;');
  assert.equal(ui.escapeHtmlText('<a "b">&'), '&lt;a "b"&gt;&amp;');
  assert.equal(ui.escapeHtmlAttribute(`'"><&`), '&#039;&quot;&gt;&lt;&amp;');

  assert.deepEqual(
    { ...ui.getBossToastPresentation('골론', false, '12:30', 5) },
    {
      isRealBoss: true,
      validSpawnTime: '12:30',
      displayName: '[12:30] 골론 <span class="text-xs text-slate-500 font-medium ml-1">5분 전</span>',
      iconName: 'skull',
      iconColor: 'text-[#a855f7]',
    },
  );
  assert.deepEqual(
    { ...ui.getScamToastPresentation({
      verdict: 'SCAM',
      analysisReason: '<송금> & 요구\n둘째 줄',
    }) },
    {
      isScam: true,
      title: '🚨 사기 위험 감지!',
      colorClass: 'text-red-400',
      reason: '&lt;송금&gt; &amp; 요구',
    },
  );

  let cleanupCount = 0;
  ui.electronAPI = { cleanupAllListeners: () => cleanupCount++ };
  ui.bindElectronListenerCleanup();
  ui.bindElectronListenerCleanup();
  assert.equal(ui.__registeredListeners.beforeunload.length, 1);
  ui.__registeredListeners.beforeunload[0]();
  assert.equal(cleanupCount, 1);
}

function checkAnalyticsProtocol(): void {
  const analyticsProtocol = require(path.join(
    projectRoot,
    'dist',
    'modules',
    'analyticsProtocol.js',
  )) as {
    createGaClientId(now?: number, randomPart?: number): string;
    isValidGaClientId(value: unknown): boolean;
    normalizeGaEventName(eventName: string): string;
    normalizeGaEventParams(
      params: Record<string, unknown>,
    ): Record<string, unknown>;
    normalizeGaClientId(
      value: unknown,
      now?: number,
      randomPart?: number,
    ): { clientId: string; migrated: boolean };
  };

  assert.equal(analyticsProtocol.isValidGaClientId('123456789.1722150000'), true);
  assert.equal(analyticsProtocol.isValidGaClientId('123456789'), false);
  assert.equal(analyticsProtocol.isValidGaClientId(crypto.randomUUID()), false);
  assert.equal(
    analyticsProtocol.createGaClientId(1_722_150_000_000, 123_456_789),
    '123456789.1722150000',
  );
  assert.deepEqual(
    analyticsProtocol.normalizeGaClientId('123456789.1722150000'),
    {
      clientId: '123456789.1722150000',
      migrated: false,
    },
  );
  assert.deepEqual(
    analyticsProtocol.normalizeGaClientId(
      '2cca639a-ef75-4087-8317-595539727182',
      1_722_150_000_000,
      987_654_321,
    ),
    {
      clientId: '987654321.1722150000',
      migrated: true,
    },
  );
  assert.equal(
    analyticsProtocol.normalizeGaEventName('toggle_settings_chatlog:sub-tab-overlay'),
    'toggle_settings_chatlog_sub_tab_overlay',
  );
  assert.equal(
    analyticsProtocol.normalizeGaEventName('123 invalid event name'),
    'event_123_invalid_event_name',
  );
  assert.equal(
    Array.from(analyticsProtocol.normalizeGaEventName(`event_${'가'.repeat(50)}`)).length,
    40,
  );
  assert.deepEqual(
    analyticsProtocol.normalizeGaEventParams({
      error_message: '오'.repeat(101),
      ga_session_number: 3,
      enabled: true,
    }),
    {
      error_message: '오'.repeat(100),
      ga_session_number: 3,
      enabled: true,
    },
  );
}

function checkDevtoolsInitializationIsIdempotent() {
  const messages: unknown[][] = [];
  const window: any = {};
  const sandbox = {
    window,
    document: { getElementById: () => ({}) },
    gameOverlayAlerts: {
      showEssenceAlert() {},
      showSpecialMonsterAlert() {},
    },
    triggerLokagosAlert() {},
    showEthosAlert: () => 'N',
    showAbyssApostleAlert: () => true,
    ETHOS_PASSWORD_BY_DIRECTION: { N: '번개' },
    currentConfig: null,
    console: {
      log: (...args: unknown[]) => messages.push(['log', ...args]),
      error: (...args: unknown[]) => messages.push(['error', ...args]),
    },
  };
  const code = read('dist/renderer/game-overlay/devtools.js');
  vm.runInNewContext(code, sandbox, { filename: 'devtools.js' });
  const firstRunCount = messages.length;
  vm.runInNewContext(code, sandbox, { filename: 'devtools.js' });

  assert.equal(messages.length, firstRunCount, 'DevTools 가이드가 중복 출력되었습니다.');
  assert.equal(typeof window.testSpecialMonsterAlert, 'function');
  assert.equal(typeof window.testEthos, 'function');
}

function checkInlineScriptSyntax() {
  const htmlFiles = fs.readdirSync(sourceRoot).filter(file => file.endsWith('.html'));
  const inlineScriptPattern = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let checkedBlockCount = 0;
  const checkedPages = new Set<string>();

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    let match;
    let index = 0;
    while ((match = inlineScriptPattern.exec(html)) !== null) {
      index++;
      new vm.Script(match[1], { filename: `${file}:inline-script-${index}` });
      checkedBlockCount++;
      checkedPages.add(file);
    }
  }

  assert.ok(checkedBlockCount > 0, '검사된 HTML 인라인 스크립트가 없습니다.');
  assert.ok(checkedPages.size > 0, '인라인 스크립트 검사 대상 페이지가 없습니다.');
}

function checkPageScriptNamespaceCollisions() {
  const htmlFiles = fs.readdirSync(sourceRoot).filter(file => file.endsWith('.html'));
  const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    const scripts = [];
    let match;

    while ((match = scriptPattern.exec(html)) !== null) {
      const sourceMatch = match[1].match(/\bsrc=["']([^"']+)["']/i);
      if (!sourceMatch) {
        scripts.push(match[2]);
        continue;
      }

      const relativeScriptPath = sourceMatch[1].split(/[?#]/, 1)[0];
      if (/\.min\.js$/i.test(relativeScriptPath)) continue;

      const sourcePath = path.join(sourceRoot, relativeScriptPath);
      const builtPath = path.join(projectRoot, 'dist', relativeScriptPath);
      const resolvedPath = fs.existsSync(sourcePath)
        ? sourcePath
        : fs.existsSync(builtPath)
          ? builtPath
          : null;
      if (resolvedPath) scripts.push(fs.readFileSync(resolvedPath, 'utf8'));
    }

    new vm.Script(scripts.join('\n;\n'), {
      filename: `${file}:combined-page-scripts`,
    });
  }
}

function checkHtmlScriptResourcesAndHandlers(): void {
  const htmlFiles = fs.readdirSync(sourceRoot).filter(file => file.endsWith('.html'));
  const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  const inlineHandlerPattern = /\bon(?:click|change|input|submit|keydown|keyup|blur|focus)=["']([^"']+)["']/gi;
  const ignoredCalls = new Set([
    'Boolean', 'Number', 'String', 'clearInterval', 'clearTimeout', 'if',
    'parseFloat', 'parseInt', 'setInterval', 'setTimeout',
  ]);

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    const externalReferences: string[] = [];
    const pageScripts: string[] = [];
    let scriptMatch: RegExpExecArray | null;

    while ((scriptMatch = scriptPattern.exec(html)) !== null) {
      const sourceMatch = scriptMatch[1].match(/\bsrc=["']([^"']+)["']/i);
      if (!sourceMatch) {
        pageScripts.push(scriptMatch[2]);
        continue;
      }

      const relativePath = sourceMatch[1].split(/[?#]/, 1)[0];
      if (/^https?:\/\//i.test(relativePath)) continue;
      externalReferences.push(relativePath);

      const sourceJavaScriptPath = path.join(sourceRoot, relativePath);
      const builtJavaScriptPath = path.join(projectRoot, 'dist', relativePath);
      assert.ok(
        fs.existsSync(sourceJavaScriptPath) || fs.existsSync(builtJavaScriptPath),
        `${file}의 스크립트 경로가 존재하지 않습니다: ${relativePath}`,
      );
      assert.ok(
        fs.existsSync(builtJavaScriptPath),
        `${file}의 빌드 스크립트가 존재하지 않습니다: ${relativePath}`,
      );

      if (!relativePath.endsWith('.min.js')) {
        const sourceTypeScriptPath = path.join(
          sourceRoot,
          relativePath.replace(/\.js$/i, '.ts'),
        );
        assert.ok(
          fs.existsSync(sourceTypeScriptPath),
          `${file}의 직접 작성 스크립트에 대응하는 TS 원본이 없습니다: ${relativePath}`,
        );
        pageScripts.push(fs.readFileSync(builtJavaScriptPath, 'utf8'));
      }
    }

    assert.equal(
      new Set(externalReferences).size,
      externalReferences.length,
      `${file}에 중복 로드되는 외부 스크립트가 있습니다.`,
    );

    const combinedCode = pageScripts.join('\n;\n');
    let handlerMatch: RegExpExecArray | null;
    while ((handlerMatch = inlineHandlerPattern.exec(html)) !== null) {
      const calledNames = Array.from(
        handlerMatch[1].matchAll(/(?:^|[^.\w])([A-Za-z_$][\w$]*)\s*\(/g),
        match => match[1],
      ).filter(name => !ignoredCalls.has(name));

      for (const functionName of calledNames) {
        const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declarationPattern = new RegExp(
          `(?:function\\s+${escapedName}\\s*\\(|(?:window\\.)?${escapedName}\\s*=|(?:const|let|var)\\s+${escapedName}\\s*=|class\\s+${escapedName}\\b)`,
        );
        assert.match(
          combinedCode,
          declarationPattern,
          `${file}의 인라인 이벤트 핸들러 ${functionName} 정의를 찾지 못했습니다.`,
        );
      }
    }
  }
}

function checkRendererResources() {
  const requiredSourceResources = [
    'src/renderer/game-overlay/alerts.ts',
    'src/renderer/game-overlay/devtools.ts',
    'src/renderer/game-overlay/edit-mode.ts',
    'src/renderer/game-overlay/today-summary.ts',
    'src/renderer/hunting-exp-calculator.ts',
    'src/renderer/settings/sound-preview.ts',
    'src/renderer/settings/list-rendering.ts',
    'src/renderer/settings/form-collection.ts',
    'src/renderer/settings/shortcuts.ts',
    'src/renderer/settings/menu-management.ts',
    'src/renderer/settings/audio-controls.ts',
    'src/renderer/settings/config-binding.ts',
    'src/renderer/contents-checker/audio-feedback.ts',
    'src/renderer/contents-checker/dom-rendering.ts',
    'src/renderer/diary/log-utils.ts',
  ];
  const requiredBuiltResources = requiredSourceResources.map(resource => (
    resource.replace(/^src/, 'dist').replace(/\.ts$/, '.js')
  ));
  [...requiredSourceResources, ...requiredBuiltResources].forEach(resource => {
    assert.equal(fs.existsSync(path.join(projectRoot, resource)), true, `${resource} 파일이 없습니다.`);
  });

  const copyScript = read('scripts/copy-resources.ts');
  assert.match(
    copyScript,
    /dirsToCopy\s*=\s*\[[^\]]*['"]renderer['"]/,
    'renderer 리소스 복사 규칙이 없습니다.',
  );

  const gameOverlay = read('src/game-overlay.html');
  const settingsPage = read('src/settings.html');
  assert.deepEqual(
    [...settingsPage.matchAll(/class="nav-item(?: active| relative| active relative)?" data-settings-group="[^"]+"[^>]*>[\s\S]*?<\/i>\s*([^<]+)/g)].map(match => match[1].trim()),
    ['앱 & 런처', '게임 HUD & 알림', '채팅 & 로그', '외부 알림 & 소리', '시스템 & 관리', '앱 정보'],
  );
  assert.equal(
    [...settingsPage.matchAll(/data-settings-group="[^"]+" onclick="showSettingsGroup/g)].length,
    6,
    '좌측 설정 메뉴는 6개의 1depth 항목만 표시해야 합니다.',
  );
  const settingsRouteBlock = settingsPage.match(/const SETTINGS_NAV_GROUPS = \{([\s\S]*?)\n    \};/)?.[1] || '';
  const settingsRoutes = [...settingsRouteBlock.matchAll(
    /\{ label: '([^']+)', icon: '[^']+', section: '([^']+)'(?:, subTab: '([^']+)')?(?:, view: '([^']+)')? \}/g,
  )].map(([, label, section, subTab, view]) => ({ label, section, subTab, view }));
  assert.deepEqual(
    settingsRoutes.map(route => route.label),
    [
      '앱 동작', '사이드바 & 독', '웹 브라우저 창', '퀵슬롯 관리',
      'HUD 위젯 관리', '게임 상황 & 기믹 알림',
      '채팅 로그 연동', '채팅 오버레이', '득템 & 외치기',
      '외부 모니터링', '소리 & 볼륨 믹서', '알림 기록',
      '단축키 설정', '데이터 관리', '네트워크 최적화', '앱 정보 & 업데이트',
    ],
    '설정 2depth 메뉴 16개가 의도한 순서와 구성으로 연결되어야 합니다.',
  );
  settingsRoutes.forEach(route => {
    assert.match(settingsPage, new RegExp(`id="section-${route.section}"`),
      `${route.label} 메뉴의 설정 섹션이 없습니다.`);
    if (route.subTab) {
      assert.match(settingsPage, new RegExp(`id="${route.subTab}"`),
        `${route.label} 메뉴의 내부 탭이 없습니다.`);
    }
    if (route.view) {
      assert.match(settingsPage, new RegExp(`data-settings-view="${route.view}"`),
        `${route.label} 메뉴의 독립 콘텐츠가 없습니다.`);
    }
  });
  assert.match(settingsPage, /id="settings-context-tabs" class="settings-context-tabs"/,
    '설정 화면의 가로 2depth 메뉴 영역이 없습니다.');
  assert.match(settingsPage, /id="settings-quick-search"/,
    '설정 화면의 빠른 검색 입력창이 없습니다.');
  assert.match(settingsPage, /id="settings-search-results"/,
    '설정 화면의 빠른 검색 드롭다운이 없습니다.');
  assert.match(settingsPage, /function showSettingsGroup\(/,
    '설정 1depth와 가로 2depth 메뉴 연결 함수가 없습니다.');
  assert.match(settingsPage, /'display:sidebar': \{ groupId: 'app', routeIndex: 1 \}/,
    '사이드바/독 설정 바로가기 경로가 없습니다.');
  assert.match(settingsPage, /'display:game-overlay': \{ groupId: 'game', routeIndex: 0 \}/,
    '게임 오버레이 설정 바로가기 경로가 없습니다.');
  assert.match(settingsPage, /'data:retention': \{ groupId: 'system', routeIndex: 1 \}/,
    '모험일지 보관 설정 바로가기 경로가 없습니다.');
  const settingsShortcutTargets: Array<[string, string]> = [
    ['src/welcome-guide.html', 'chatlog'],
    ['src/welcome-guide.html', 'display:sidebar'],
    ['src/welcome-guide.html', 'display:game-overlay'],
    ['src/welcome-guide.html', 'sound'],
    ['src/welcome-guide.html', 'shortcuts'],
    ['src/welcome-guide.html', 'chatlog:sub-tab-today-summary'],
    ['src/diary.html', 'chatlog:sub-tab-loot'],
    ['src/diary.html', 'data:retention'],
    ['src/gallery.html', 'gallery'],
    ['src/trade.html', 'trade'],
    ['src/word-alarm.html', 'chatlog'],
    ['src/chatOverlayRenderer.ts', 'chatlog:sub-tab-overlay'],
    ['src/assets/ui-utils.ts', 'chatlog'],
    ['src/xp-hud.html', 'display:game-overlay'],
    ['src/magic-stone-calculator.html', 'display:game-overlay'],
    ['src/buff-timer.html', 'display:game-overlay'],
  ];
  settingsShortcutTargets.forEach(([resource, target]) => {
    assert.match(read(resource), new RegExp(`toggleSettings\\(['"]${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\)`),
      `${resource}의 설정 바로가기(${target})가 올바르게 연결되지 않았습니다.`);
  });
  assert.match(settingsPage, /applySettingsRouteView\(route\);\s*scrollSettingsToTop\(\);/,
    '설정 2depth 메뉴 전환 완료 후 최상단 스크롤이 보장되지 않습니다.');
  ['sidebar-settings-section', 'game-exit-reminder-section'].forEach(id => {
    assert.doesNotMatch(settingsPage, new RegExp(`id="${id}" class="[^"]*(?:pt-6|border-t)`),
      `${id} 독립 화면 상단에 이전 구분용 여백이 남아 있습니다.`);
  });
  assert.doesNotMatch(settingsPage, /class="[^"]*(?:pt-6|border-t)[^"]*" data-settings-view="data-retention"/,
    '데이터 보관 독립 화면 상단에 이전 구분용 여백이 남아 있습니다.');
  assert.match(settingsPage, /\.sub-tab-bar\s*\{\s*display:\s*none/,
    '동적 가로 2depth 메뉴와 기존 서브탭이 중복 표시됩니다.');
  assert.match(settingsPage, /\.nav-container\s*\{[\s\S]*?overflow-y:\s*hidden/,
    '좌측 1depth 메뉴에 스크롤이 생길 수 있습니다.');
  assert.ok(
    settingsPage.indexOf('renderer/settings/form-collection.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 폼 수집 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/shortcuts.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 단축키 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/menu-management.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 메뉴 관리 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/audio-controls.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 사운드 제어 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/config-binding.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 입력 바인딩 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.doesNotMatch(settingsPage, /function collectChatOverlayDisplaySettings|function collectChatAlertSettings/,
    '설정 폼 수집 로직이 settings.html에 다시 중복되었습니다.');
  assert.doesNotMatch(
    settingsPage,
    /recordingShortcutKey|currentShortcuts|function recordShortcut|function resetShortcut|function handleShortcutKeyDown/,
    '설정 단축키 상태 또는 녹화 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.doesNotMatch(
    settingsPage,
    /loadedMenus|function initDynamicMenuManagement|function applyMenuCheckboxes/,
    '설정 메뉴 관리 상태 또는 렌더링 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.doesNotMatch(
    settingsPage,
    /prevVolumes|ALERT_SOUND_SELECT_IDS|function buildAlertSoundOptionsHtml|function toggleMute|function updateMuteButtonState|function refreshAllSoundSelects/,
    '설정 사운드 상태 또는 제어 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.doesNotMatch(
    settingsPage,
    /ethosVolumeEl|abyssVolumeEl|lokagosVolumeEl|waveVolumeEl|overlayFontSizeEl|overlayOpacityEl|selectedChannels|forgeHudPos/,
    '독립 설정 입력 바인딩 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.match(settingsPage, /settingsFormCollection\.collectChatOverlayDisplaySettings\(chatOverlayFilterList(?:,\s*customTabsList)?\)/);
  assert.match(settingsPage, /settingsFormCollection\.collectChatAlertSettings\(lootKeywordsList, shoutKeywordsList\)/);
  assert.match(settingsPage, /settingsShortcuts\.mergeShortcuts\(config\.shortcuts\)/);
  assert.match(settingsPage, /shortcuts:\s*window\.settingsShortcuts\.getShortcuts\(\)/);
  assert.match(settingsPage, /settingsShortcuts\.handleKeyDown\(e\)/);
  assert.match(
    settingsPage,
    /await window\.settingsMenuManagement\.initialize\(\);\s*if \(lastConfig\) window\.settingsMenuManagement\.applyConfig\(lastConfig\);/,
    '메뉴 로드 도중 도착한 최신 설정을 로드 완료 후 다시 적용하지 않습니다.',
  );
  assert.match(settingsPage, /settingsMenuManagement\.applyConfig\(config\)/);
  assert.match(settingsPage, /settingsMenuManagement\.collectHiddenMenuIds\(\)/);
  assert.match(
    settingsPage,
    /await window\.settingsAudioControls\.initializeAlertSoundSelects\(\);\s*if \(lastConfig\) window\.settingsAudioControls\.applyAlertSoundConfig\(lastConfig\);/,
    '사운드 목록 로드 도중 도착한 최신 설정을 로드 완료 후 다시 적용하지 않습니다.',
  );
  assert.match(settingsPage, /settingsAudioControls\.bindVolumeControl\('contents-checker', volContents\)/);
  assert.match(settingsPage, /settingsAudioControls\.bindVolumeControl\('calculators', volCalc\)/);
  assert.equal(
    (settingsPage.match(/settingsAudioControls\.refreshAlertSoundSelects\(\)/g) || []).length,
    3,
    '커스텀 사운드 추가·이름 변경·삭제 후 선택 목록 갱신 연결이 누락되었습니다.',
  );
  assert.match(settingsPage, /settingsConfigBinding\.applyGeneralSettings\(config, window\.electronAPI\.DEFAULT_CONFIG\)/);
  assert.match(settingsPage, /settingsConfigBinding\.applyChatAndAlertSettings\(/);
  assert.match(settingsPage, /settingsConfigBinding\.applyOverlayDisplayOptions\(/);
  assert.match(settingsPage, /settingsConfigBinding\.applyRadioSettings\(config, window\.electronAPI\.DEFAULT_CONFIG\)/);
  const guideCount = (
    read('src/renderer/game-overlay/devtools.ts').match(/\[TW-Overlay 테스트 가이드\]/g)
    || []
  ).length;
  assert.equal(guideCount, 1, 'DevTools 테스트 가이드 정의가 하나가 아닙니다.');
  assert.match(gameOverlay, /renderer\/game-overlay\/devtools\.js/);

  requiredBuiltResources
    .concat([
      'dist/assets/ui-utils.js',
      'dist/shared/chatConstants.js',
      'dist/shared/chatChannels.js',
      'dist/shared/buffConstants.js',
      'dist/shared/sidebarCategories.js',
      'dist/shared/huntingExpCalculator.js',
      'dist/shared/relicCalculator.js',
      'dist/shared/equipmentSimulator.js',
    ])
    .forEach(resource => {
      new vm.Script(read(resource), { filename: resource });
    });

  const chatOverlayBundle = read('dist/chatOverlayRenderer.js');
  assert.doesNotMatch(
    chatOverlayBundle,
    /Object\.defineProperty\(exports|\brequire\(/,
    '브라우저에서 직접 로드하는 채팅 오버레이 번들에 CommonJS 런타임 코드가 포함되었습니다.',
  );
}

function checkCoefficientCalculatorVisibilityContract(): void {
  const html = read('src/coefficient-calculator.html');

  assert.match(
    html,
    /\.custom-dropdown-menu\.hidden\s*\{\s*display:\s*none;\s*\}/,
    '계수 계산기에서 닫힌 장비 드롭다운이 표시될 수 있습니다.',
  );
  assert.match(
    html,
    /<script src="assets\/tailwind\.min\.js"><\/script>/,
    '계수 계산기의 기존 Tailwind 런타임 로드 방식이 변경되었습니다.',
  );
  assert.doesNotMatch(
    html,
    /assets\/tailwind\.css/,
    '계수 계산기에 기존 스타일 우선순위를 깨뜨리는 정적 Tailwind CSS가 연결되었습니다.',
  );
}

function checkHuntingPathArrowSizing(): void {
  const html = read('src/hunting-path-simulator.html');
  assert.match(html, /const PATH_STROKE_WIDTH = 3\.0;/);
  assert.match(html, /const ARROW_MARKER_SIZE = 4\.3;/);
  assert.match(
    html,
    /line\.style\.strokeWidth = \(PATH_STROKE_WIDTH \* currentScale\) \+ 'px';/,
  );
  assert.match(
    html,
    /const mWidth = \(ARROW_MARKER_SIZE \* currentScale\)\.toFixed\(2\);/,
  );
  assert.match(html, /const refY = '5';/);
  assert.match(
    html,
    /orient="auto-start-reverse" overflow="visible"/,
    '사냥터 동선 화살촉이 SVG 마커 경계에서 잘릴 수 있습니다.',
  );
}

function checkContentsChecklistOrdering(): void {
  const html = read('src/contents-checker.html');

  assert.doesNotMatch(
    html,
    /\.sort\(\(a,\s*b\)\s*=>\s*window\.compareKoreanText\(a\.name,\s*b\.name\)\)/,
    '숙제 체크리스트가 저장된 사용자 순서 대신 이름순으로 다시 정렬됩니다.',
  );
  assert.match(
    html,
    /visibleItems\.forEach\(item\s*=>/,
    '숙제 체크리스트가 저장 배열 순서로 렌더링되지 않습니다.',
  );
  assert.match(
    html,
    /contentsReorderCategory\(drop\.resetType, drop\.sourceName, drop\.targetName, drop\.position\)/,
    '숙제 체크리스트의 카테고리 드래그 재배치 연결이 누락되었습니다.',
  );
  assert.match(
    html,
    /contentsReorderItem\(drop\.sourceId, drop\.targetId, drop\.position\)/,
    '숙제 체크리스트의 항목 드래그 재배치 연결이 누락되었습니다.',
  );
  assert.match(
    html,
    /table\.ondrop = event => commitDragPreview\(event\)/,
    '숙제 체크리스트의 테이블 드롭 커밋 연결이 누락되었습니다.',
  );
  assert.match(
    html,
    /title = '드래그하여 숙제 순서 변경'/,
    '숙제 체크리스트의 드래그 핸들이 누락되었습니다.',
  );
  assert.match(
    html,
    /const isCustomItem = item\.isCustom === true \|\| item\.id\.startsWith\('custom-'\);/,
    '구버전 커스텀 숙제 판별 호환성이 누락되었습니다.',
  );
  assert.match(
    html,
    /createBadge\(\s*'CUSTOM'/,
    '커스텀 숙제의 CUSTOM 딱지가 누락되었습니다.',
  );
}

function checkPhaseOneSafetyContracts(): void {
  const contents = JSON.parse(read('src/assets/data/contents.json')) as Array<{ id: string }>;
  const contentsMeta = JSON.parse(read('src/assets/data/contents.meta.json')) as {
    expectedItemCount: number;
    sentinelIds: string[];
  };
  const ids = contents.map(item => item.id);
  assert.equal(contents.length, contentsMeta.expectedItemCount,
    'contents 리소스 개수와 companion metadata가 다릅니다.');
  assert.equal(new Set(ids).size, ids.length, 'contents 리소스 ID가 중복되었습니다.');
  assert.ok(contentsMeta.sentinelIds.length >= 3, 'contents sentinel이 충분하지 않습니다.');
  contentsMeta.sentinelIds.forEach(id => assert.ok(ids.includes(id), `contents sentinel이 없습니다: ${id}`));

  const contentsChecker = read('src/modules/contentsChecker.ts');
  assert.match(contentsChecker, /validateResourceMeta/);
  assert.match(contentsChecker, /if \(!defaultItems\) \{[\s\S]*?return;/,
    'contents 검증 실패 후 파괴적 초기화를 중단하지 않습니다.');

  const preload = read('src/preload.ts');
  assert.match(preload, /defaultApp === true[\s\S]*?process\.argv\.includes\('--dev'\)/,
    '프로덕션 preload 테스트 API 차단 조건이 없습니다.');
  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(ipcHandlers, /if \(IS_DEV\) \{[\s\S]*?inject-test-chat/,
    '프로덕션 테스트 채팅 IPC 차단 조건이 없습니다.');

  const audioControls = read('src/renderer/settings/audio-controls.ts');
  assert.doesNotMatch(audioControls, /soundFiles\.map\([\s\S]*?<option/,
    '커스텀 사운드가 option innerHTML로 삽입됩니다.');
  assert.match(audioControls, /option\.textContent = String\(sound\.name\)/);
  const gallery = read('src/gallery.html');
  assert.doesNotMatch(gallery, /removeWatch\(\$\{no\}\)/,
    '갤러리 감시 키가 inline onclick에 삽입됩니다.');
  const diary = read('src/diary.html');
  assert.doesNotMatch(diary, /deleteTimelineItem\('\$\{log\.type\}/,
    '일지 문자열이 inline 삭제 핸들러에 삽입됩니다.');

  const configSource = read('src/modules/config.ts');
  assert.match(configSource, /fs\.fsyncSync\(fd\)[\s\S]*?fs\.renameSync\(tempPath, filePath\)/,
    '설정 원자 저장의 flush/rename 계약이 없습니다.');
  assert.match(configSource, /설정 원자 저장 실패, pending 유지/,
    '설정 저장 실패 후 pending 보존 계약이 없습니다.');
  assert.match(configSource, /if \(_cachedConfig\) return deepClone\(_cachedConfig\)/,
    '설정 읽기 경계가 독립 스냅샷을 반환하지 않습니다.');
  assert.match(configSource, /mergeConfigPatch/,
    '부분 설정 저장의 중첩 필드 병합이 없습니다.');

  const backupManager = read('src/modules/backupManager.ts');
  assert.match(backupManager, /createUserDataSnapshot/);
  assert.match(backupManager, /verifyUserDataSnapshot/);
  assert.doesNotMatch(backupManager, /\.old['"]/,
    '수동 복원이 검증 스냅샷 대신 취약한 .old 교체를 사용합니다.');

  const snapshotModule = require(path.join(projectRoot, 'dist', 'modules', 'localSnapshot.js')) as {
    createUserDataSnapshot: (source: string, destination: string, options: Record<string, unknown>) => unknown;
    verifyUserDataSnapshot: (snapshot: string) => unknown;
  };
  const source = path.join(isolatedUserData, 'snapshot-source');
  const destinationRoot = path.join(isolatedUserData, 'snapshot-output');
  const destination = path.join(destinationRoot, 'verified');
  fs.mkdirSync(path.join(source, 'custom_sounds'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config.json'), '{"width":400}', 'utf8');
  fs.writeFileSync(path.join(source, 'diary.db'), 'sqlite-fixture', 'utf8');
  fs.writeFileSync(path.join(source, 'custom_sounds', 'safe.mp3'), 'sound-fixture', 'utf8');
  snapshotModule.createUserDataSnapshot(source, destination, {
    reason: 'regression-test', appVersion: '3.0.0', allowedDestinationRoot: destinationRoot,
  });
  assert.doesNotThrow(() => snapshotModule.verifyUserDataSnapshot(destination));
  fs.appendFileSync(path.join(destination, 'config.json'), 'tampered', 'utf8');
  assert.throws(() => snapshotModule.verifyUserDataSnapshot(destination), /무결성 검증 실패/);
}

function checkWindowRestoreAndSettingsNavigationContracts(): void {
  const manager = read('src/modules/windowManager.ts');
  const placementSource = read('src/modules/windowPlacement.ts');
  const registrySource = read('src/modules/managedWindowRegistry.ts');
  const moveTrackerSource = read('src/modules/programmaticMoveTracker.ts');
  const layoutSource = read('src/modules/windowLayout.ts');
  const settings = read('src/settings.html');
  const configSource = read('src/modules/config.ts');
  const sharedTypes = read('src/shared/types.ts');

  assert.match(
    manager,
    /let pendingSettingsTab: string \| null = null;/,
    '설정창 초기 탭 요청을 보존하는 상태가 없습니다.',
  );
  assert.match(
    manager,
    /windowKey === 'settings' && pendingSettingsTab[\s\S]*?send\('open-settings-tab', pendingSettingsTab\)/,
    '설정 렌더러 준비 후 초기 탭을 전달하는 연결이 없습니다.',
  );
  assert.match(
    settings,
    /onOpenSettingsTab\([\s\S]*?sendRendererReady\('settings'\)/,
    '설정 탭 리스너 등록 후 renderer-ready 신호를 보내지 않습니다.',
  );

  const currentRectPublish = manager.indexOf('gameRect = scaledGameRect;');
  const contentsRestore = manager.indexOf('// --- 숙제 체크리스트 자동 동기화 및 띄우기 ---');
  assert.ok(currentRectPublish >= 0 && currentRectPublish < contentsRestore,
    '게임 복원 좌표가 숙제 체크리스트 자동 생성보다 먼저 게시되어야 합니다.');

  assert.doesNotMatch(
    manager,
    /programmaticMoveTimeMap|Date\.now\(\) - lastTime/,
    '프로그램 이동 판별이 다시 고정 시간 추정에 의존하고 있습니다.',
  );
  assert.match(
    moveTrackerSource,
    /reachedTarget[\s\S]*?delete this\.moves\[key\]/,
    '프로그램이 명령한 목표 좌표를 실제 move 좌표와 대조하는 방어가 없습니다.',
  );
  assert.match(
    moveTrackerSource,
    /fromX: current\.x[\s\S]*?fromY: current\.y[\s\S]*?isNativeIntermediateMove[\s\S]*?&& isNativeIntermediateMove/,
    '프로그램 이동 경로 밖의 빠른 사용자 드래그까지 시간 기준으로 무시할 수 있습니다.',
  );
  assert.doesNotMatch(
    moveTrackerSource,
    /if \(Date\.now\(\) <= pending\.ignoreMismatchUntil\) return true;/,
    '목표와 다른 모든 이동을 일정 시간 무조건 무시하는 판별이 남아 있습니다.',
  );
  assert.match(
    manager,
    /let isInitialPositionApplied = false;[\s\S]*?!isInitialPositionApplied/,
    '창 초기 위치가 적용되기 전 발생하는 move 이벤트의 저장 방어가 없습니다.',
  );
  assert.match(
    manager,
    /export function resetGameSessionState\(\)[\s\S]*?lastForegroundSize = null;/,
    '게임 재실행 시 이전 세션의 해상도 캐시를 폐기하지 않습니다.',
  );
  assert.match(
    read('src/modules/pollingLoop.ts'),
    /'notRunning' in currentRect[\s\S]*?resetGameSessionState\(\)/,
    '게임 종료 감지와 세션 좌표 상태 초기화가 연결되어 있지 않습니다.',
  );
  assert.doesNotMatch(
    manager,
    /minOverlapArea|totalOverlap\s*>=/,
    '화면에 일부 걸친 창을 화면 밖으로 오인하는 최소 노출 면적 기준이 다시 추가되었습니다.',
  );
  assert.match(
    placementSource,
    /isWindowVisibleOnDisplays[\s\S]*?getOverlapArea\(bounds, display\.bounds\) > 0/,
    '창이 모든 화면에서 완전히 사라진 경우만 감지하는 교차 면적 검사가 없습니다.',
  );
  assert.match(
    manager,
    /function recoverCompletelyOffscreenWindow[\s\S]*?savePosition\(key, winCfg\.pos\)/,
    '완전히 화면을 이탈한 보조 창의 위치 복구 및 저장 로직이 없습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenWindow\(key, gameRect, x, y, finalW, finalH\)/,
    '숙제 체크리스트를 포함한 공통 보조 창 생성 경로에 화면 이탈 복구가 적용되지 않았습니다.',
  );
  assert.match(
    manager,
    /function recoverCompletelyOffscreenBrowserOverlay[\s\S]*?savePosition\('overlay', overlayPos\)/,
    '브라우저 오버레이의 완전 화면 이탈 복구 및 위치 저장 로직이 없습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenBrowserOverlay\(\s*scaledGameRect,[\s\S]*?recoveredOverlay\.recovered/,
    '브라우저 오버레이 동기화 경로에 완전 화면 이탈 복구가 연결되지 않았습니다.',
  );
  assert.match(
    manager,
    /const recoveryBounds = skipPositionSync\s*\? \{ x: b\.x, y: b\.y, width: b\.width, height: b\.height \}[\s\S]*?recoverCompletelyOffscreenBrowserOverlay/,
    '게임 추적 중단 시 브라우저 오버레이의 실제 현재 위치를 기준으로 복구하지 않습니다.',
  );
  assert.match(
    manager,
    /const recovery = recoverCompletelyOffscreenWindow\([\s\S]*?skipPositionSync \? b\.x : x[\s\S]*?skipPositionSync \? b\.y : y[\s\S]*?\(!skipPositionSync \|\| recovery\.recovered\)/,
    '실행 중인 일반 보조 창의 현재/예정 위치별 완전 이탈 복구가 없습니다.',
  );
  assert.doesNotMatch(
    manager,
    /settings:\s*\{[\s\S]{0,400}?getPrimaryDisplay\(\)/,
    '설정 창 위치가 다시 주 모니터 좌표로 강제 제한되고 있습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenWindow\('uniformColor'/,
    '의상 염색 창의 완전 화면 이탈 복구가 없습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenWindow\('swordEnhance'/,
    '검 강화 창의 완전 화면 이탈 복구가 없습니다.',
  );
  assert.match(
    manager,
    /config\.hasStoredPosition\(key as WindowPositionKey\)/,
    '기본 위치와 사용자가 실제 저장한 위치를 구분하지 않습니다.',
  );
  assert.match(
    configSource,
    /storedPositionKeys\s*=\s*\[\.\.\._storedPositionKeys\]/,
    '실제 저장 위치 키가 설정 파일에 보존되지 않습니다.',
  );
  assert.match(
    configSource,
    /copyFileSync\((?:configPath|candidatePath), backupPath\)[\s\S]*?_loadWarning/,
    '손상된 설정 파일의 원본 보존 또는 사용자 경고가 없습니다.',
  );
  assert.match(
    sharedTypes,
    /positions\?: Partial<Record<WindowPositionKey, WindowPosition>>;/,
    '창 위치 타입이 전체 레지스트리 키를 포괄하지 않습니다.',
  );

  const sharedPositionSource = read('src/shared/windowPositions.ts');
  assert.match(sharedPositionSource, /export const DEFAULT_WINDOW_POSITIONS/);
  assert.match(registrySource, /copyDefaultWindowPosition\(definition\.key\)/);
  assert.match(read('src/modules/constants.ts'), /positions: \{ \.\.\.DEFAULT_WINDOW_POSITIONS \}/);

  const placement = require(path.join(projectRoot, 'dist', 'modules', 'windowPlacement.js')) as {
    isWindowVisibleOnDisplays: (bounds: object, displays: object[]) => boolean;
    centerWindowInWorkArea: (width: number, height: number, workArea: object) => { x: number; y: number };
  };
  const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.equal(placement.isWindowVisibleOnDisplays({ x: 1919, y: 1079, width: 20, height: 20 }, displays), true);
  assert.equal(placement.isWindowVisibleOnDisplays({ x: 1920, y: 0, width: 20, height: 20 }, displays), false);
  assert.deepEqual(placement.centerWindowInWorkArea(400, 300, { x: 100, y: 50, width: 1200, height: 800 }), {
    x: 500,
    y: 300,
  });

  const registryModule = require(path.join(projectRoot, 'dist', 'modules', 'managedWindowRegistry.js')) as {
    createManagedWindowRegistry: () => Record<string, { key: string; html: string; width: number; height: number; ref: unknown }>;
    MANAGED_WINDOW_COUNT: number;
  };
  const registry = registryModule.createManagedWindowRegistry();
  assert.equal(Object.keys(registry).length, registryModule.MANAGED_WINDOW_COUNT);
  const defaultPositions = require(path.join(projectRoot, 'dist', 'shared', 'windowPositions.js')) as {
    DEFAULT_WINDOW_POSITIONS: Record<string, object>;
  };
  assert.deepEqual(
    Object.keys(registry).sort(),
    Object.keys(defaultPositions.DEFAULT_WINDOW_POSITIONS).filter(key => key !== 'overlay').sort(),
    '관리 창 레지스트리와 공통 기본 위치 키가 일치하지 않습니다.',
  );
  assert.deepEqual(
    { key: registry.settings.key, html: registry.settings.html, width: registry.settings.width, height: registry.settings.height, ref: registry.settings.ref },
    { key: 'settings', html: 'settings.html', width: 1100, height: 720, ref: null },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(registry).map(([key, value]) => [key, [value.html, value.width, value.height, !!(value as { skipTaskbar?: boolean }).skipTaskbar]])),
    {
      settings: ['settings.html', 1100, 720, false], gallery: ['gallery.html', 450, 600, false],
      abbreviation: ['abbreviation.html', 540, 720, false], equipmentDic: ['equipment-dic.html', 1120, 800, false],
      buffs: ['buffs.html', 1080, 740, false], bossSettings: ['boss-settings.html', 460, 780, false],
      etaRanking: ['eta-ranking.html', 400, 600, false], trade: ['trade.html', 450, 600, false],
      coefficientCalculator: ['coefficient-calculator.html', 1420, 860, false], contentsChecker: ['contents-checker.html', 400, 1200, false],
      focusedChat: ['focused-chat.html', 460, 720, false], evolutionCalculator: ['evolution-calculator.html', 600, 720, false],
      thesisCoreCalculator: ['thesis-core-calculator.html', 850, 880, false], magicStoneCalculator: ['magic-stone-calculator.html', 400, 800, false],
      customAlert: ['custom-alert.html', 580, 640, false], diary: ['diary.html', 1400, 920, false],
      uniformColor: ['uniform-color.html', 360, 800, false], swordEnhance: ['sword-enhance.html', 1300, 850, false],
      shoutHistory: ['shout-history.html', 450, 600, false], gameOverlay: ['game-overlay.html', 0, 0, false],
      buffTimer: ['buff-timer.html', 900, 850, false], xpHud: ['xp-hud.html', 420, 1050, false],
      scamDetector: ['scam-detector.html', 480, 780, false], sienaAura: ['siena-aura.html', 1230, 930, false],
      wordAlarm: ['word-alarm.html', 450, 950, false], discordAlarm: ['discord-alarm.html', 450, 950, false],
      huntingPathSimulator: ['hunting-path-simulator.html', 860, 800, false],
      huntingExpCalculator: ['hunting-exp-calculator.html', 940, 780, false], relicCalculator: ['relic-calculator.html', 920, 760, false],
      equipmentSimulator: ['equipment-simulator.html', 960, 820, false],
      stopwatch: ['stopwatch.html', 870, 750, false],
      chatOverlay: ['chat-overlay.html', 450, 400, true], chatOverlaySub: ['chat-overlay.html', 450, 400, true],
      chatOverlaySub2: ['chat-overlay.html', 450, 400, true], dock: ['dock.html', 800, 380, true],
    },
    '관리 창의 HTML·기본 크기·작업 표시줄 정책이 변경되었습니다.',
  );

  const sizing = require(path.join(projectRoot, 'dist', 'modules', 'managedWindowSizing.js')) as {
    resolveManagedWindowSizing: (key: string, width: number, height: number, config: Record<string, unknown>, workAreaHeight: number) => Record<string, unknown>;
    applyManagedWindowSize: (key: string, config: Record<string, unknown>, width: number, height: number) => boolean;
  };
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('focusedChat', 460, 720, { focusedChatWidth: 520, focusedChatHeight: 760 }, 700),
    { width: 520, height: 660, isResizable: true, isTransparent: true, minWidth: 360, minHeight: 360 },
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('contentsChecker', 400, 1200, {}, 1080),
    { width: 400, height: 1040, isResizable: true, isTransparent: false, minWidth: 200, minHeight: 200 },
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('chatOverlay', 450, 400, { chatOverlayWidth: 400, chatOverlayHeight: 120 }, 1080),
    { width: 400, height: 120, isResizable: true, isTransparent: true, minWidth: 300, minHeight: 80 },
  );
  const sizeConfig: Record<string, unknown> = {};
  assert.equal(sizing.applyManagedWindowSize('chatOverlaySub2', sizeConfig, 510, 430), true);
  assert.deepEqual(sizeConfig, { chatOverlaySub2Width: 510, chatOverlaySub2Height: 430 });
  assert.equal(sizing.applyManagedWindowSize('settings', sizeConfig, 800, 600), false);

  const moveModule = require(path.join(projectRoot, 'dist', 'modules', 'programmaticMoveTracker.js')) as {
    ProgrammaticMoveTracker: new (threshold: number, windowMs: number, now: () => number) => {
      record: (key: string, target: { x: number; y: number }, current: { x: number; y: number }) => void;
      consume: (key: string, current?: { x: number; y: number }) => boolean;
      markUserDrag: (key: string, durationMs?: number) => void;
      isUserDragging: (key: string) => boolean;
      isAnyUserDragging: () => boolean;
      clear: () => void;
    };
  };
  let moveNow = 1_000;
  const moveTracker = new moveModule.ProgrammaticMoveTracker(2, 1_000, () => moveNow);
  moveTracker.record('window', { x: 100, y: 100 }, { x: 0, y: 0 });
  assert.equal(moveTracker.consume('window', { x: 50, y: 100 }), true, '네이티브 중간 move 이벤트를 보존하지 않습니다.');
  assert.equal(moveTracker.consume('window', { x: 180, y: 100 }), false, '이동 경로 밖의 사용자 드래그를 무시합니다.');
  moveTracker.record('window', { x: 100, y: 100 }, { x: 0, y: 0 });
  moveNow = 2_001;
  assert.equal(moveTracker.consume('window', { x: 50, y: 100 }), false, '중간 move 허용 시간이 지난 이벤트를 무시합니다.');
  moveTracker.record('window', { x: 100, y: 100 }, { x: 0, y: 0 });
  moveNow = 5_000;
  assert.equal(moveTracker.consume('window', { x: 100, y: 100 }), true, '최종 목표 좌표 도달을 시간과 무관하게 소비하지 않습니다.');

  // 사용자 마우스 드래그 추적 및 만료 검증
  assert.equal(moveTracker.isAnyUserDragging(), false, '초기에는 어떤 창도 드래그 상태가 아니어야 합니다.');
  moveTracker.markUserDrag('chatOverlay', 350);
  assert.equal(moveTracker.isUserDragging('chatOverlay'), true, '드래그 마킹 후 활성 상태여야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), true, '드래그 중인 창이 있으면 isAnyUserDragging이 true여야 합니다.');
  assert.equal(moveTracker.isUserDragging('otherWindow'), false, '다른 창은 드래그 상태가 아니어야 합니다.');
  moveNow = 5_300;
  assert.equal(moveTracker.isUserDragging('chatOverlay'), true, '350ms 만료 전에는 드래그 상태를 유지해야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), true, '만료 전에는 isAnyUserDragging이 true여야 합니다.');
  moveNow = 5_351;
  assert.equal(moveTracker.isUserDragging('chatOverlay'), false, '350ms 경과 후에는 드래그 상태가 해제되어야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), false, '만료 후에는 isAnyUserDragging이 false여야 합니다.');
  moveTracker.markUserDrag('chatOverlay', 350);
  moveTracker.clear();
  assert.equal(moveTracker.isUserDragging('chatOverlay'), false, 'clear() 호출 시 드래그 상태도 초기화되어야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), false, 'clear() 호출 시 isAnyUserDragging도 false여야 합니다.');

  const layout = require(path.join(projectRoot, 'dist', 'modules', 'windowLayout.js')) as {
    resolvePhysicalGameRect: (current: Record<string, unknown>, last: { width: number; height: number } | null) => any;
    isFullscreenBounds: (game: object, display: object) => boolean;
    calculateAttachedWindowPosition: (game: any, position: any) => { x: number; y: number };
    calculateBrowserOverlayPosition: (game: any, position: any) => { x: number; y: number };
    calculateSidebarBounds: (position: string, game: any, edgeX: number, current: any) => any;
    calculateSidebarResizeBounds: (position: string, current: any, width: number) => any;
    resizeBounds: (current: any, width?: number, height?: number) => any;
    hasBoundsChanged: (current: any, target: any, threshold: number) => boolean;
    hasPositionChanged: (current: any, target: any, threshold: number) => boolean;
  };
  const foregroundRect = { x: 100, y: 200, width: 1920, height: 1080, isForeground: true };
  assert.deepEqual(layout.resolvePhysicalGameRect(foregroundRect, { width: 800, height: 600 }), {
    physicalRect: foregroundRect,
    foregroundSize: { width: 1920, height: 1080 },
  });
  assert.deepEqual(
    layout.resolvePhysicalGameRect({ x: 100, y: 200, width: 1280, height: 720, isForeground: false }, { width: 1920, height: 1080 }).physicalRect,
    { x: 100, y: 200, width: 1920, height: 1080, isForeground: false },
    '비활성 게임 창의 축소된 해상도가 포그라운드 캐시를 덮어씁니다.',
  );
  assert.equal(layout.isFullscreenBounds({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }), true);
  assert.equal(layout.isFullscreenBounds({ x: 0, y: 0, width: 1919, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }), false);
  const gameRect = { x: 100, y: 50, width: 1200, height: 800, isForeground: true };
  assert.deepEqual(layout.calculateAttachedWindowPosition(gameRect, { offsetX: -450, offsetY: 40 }), { x: 850, y: 90 });
  assert.deepEqual(layout.calculateBrowserOverlayPosition(gameRect, { offsetX: 10, offsetY: 20 }), { x: 110, y: 70 });
  assert.deepEqual(layout.calculateSidebarBounds('left', gameRect, 100, { x: 0, y: 0, width: 400, height: 700 }), {
    x: -300, y: 80, width: 400, height: 770,
  });
  assert.deepEqual(layout.calculateSidebarBounds('right', gameRect, 1300, { x: 0, y: 0, width: 400, height: 700 }), {
    x: 1300, y: 80, width: 400, height: 770,
  });
  assert.deepEqual(layout.calculateSidebarResizeBounds('left', { x: -300, y: 80, width: 400, height: 770 }, 500), {
    x: -400, y: 80, width: 500, height: 770,
  });
  assert.deepEqual(layout.resizeBounds({ x: 10, y: 20, width: 450, height: 400 }, undefined, 500), {
    x: 10, y: 20, width: 450, height: 500,
  });
  assert.equal(layout.hasBoundsChanged({ x: 0, y: 0, width: 100, height: 100 }, { x: 2, y: 0, width: 100, height: 100 }, 2), false);
  assert.equal(layout.hasPositionChanged({ x: 0, y: 0 }, { x: 3, y: 0 }, 2), true);
  assert.match(manager, /resolvePhysicalGameRect\(currentRect, lastForegroundSize\)/,
    '게임 해상도 캐시 계산이 공통 레이아웃 모듈과 연결되지 않았습니다.');
  assert.match(manager, /calculateSidebarBounds\(sidebarPos, scaledGameRect, edgeDipX, currentSidebarB\)/,
    '사이드바 좌우 배치가 공통 레이아웃 모듈과 연결되지 않았습니다.');
  assert.match(layoutSource, /Math\.abs\(current\.x - target\.x\) > threshold/,
    '좌표 변경 임계값 비교가 제거되었습니다.');

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(
    ipcHandlers,
    /const trackedGameRect = wm\.getGameRect\(\);[\s\S]*?getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)\.bounds/,
    '게임 오버레이 임시 복구가 게임/현재 디스플레이 대신 주 모니터 원점에 의존합니다.',
  );

  const gameOverlay = read('src/game-overlay.html');
  assert.match(gameOverlay, /function recoverHudPosition\(element, position\)/);
  assert.match(gameOverlay, /left \+ width > 0[\s\S]*?top < window\.innerHeight/);
  assert.match(gameOverlay, /window\.addEventListener\('resize',[\s\S]*?applySafeHudPositions/);
  assert.doesNotMatch(gameOverlay, /config\.questHudPos/,
    '구형 퀘스트 HUD 위치가 새 위치 설정보다 우선할 수 있습니다.');
  assert.match(
    configSource,
    /isPlainObject\(parsed\.questHudPos\)[\s\S]*?parsed\.forgeQuestHudPos = sanitizeJsonValue\(parsed\.questHudPos\);[\s\S]*?delete parsed\.questHudPos;/,
    '구형 퀘스트 HUD 위치를 새 필드로 이전하는 마이그레이션이 없습니다.',
  );
}

function checkDependencyOverrideContracts(): void {
  const packageSource = read('package.json');
  const packageData = JSON.parse(packageSource);

  assert.equal(
    (packageSource.match(/"overrides"\s*:/g) || []).length,
    1,
    'package.json에 overrides 키가 중복되어 앞쪽 보안 고정값이 무시될 수 있습니다.',
  );
  assert.match(packageData.overrides?.['js-yaml'] || '', /^\^4\.3\.1$/,
    '취약한 js-yaml 버전이 다시 설치될 수 있습니다.');
  assert.equal(packageData.scripts?.postinstall, 'electron-builder install-app-deps',
    'npm ci 후 Electron용 네이티브 모듈 ABI 재빌드가 실행되지 않습니다.');
}

function checkSidebarMenuRegistryContracts(): void {
  const registry = require(path.join(projectRoot, 'dist', 'shared', 'sidebarMenus.js')) as {
    SIDEBAR_MENUS: Array<{ id: string; api?: string; action?: string; category?: string; icon: string; isOneDepth?: boolean }>;
    SIDEBAR_MENU_ACTIONS: readonly string[];
  };
  const menuIds = registry.SIDEBAR_MENUS.map(menu => menu.id);
  assert.equal(new Set(menuIds).size, menuIds.length, '사이드바 메뉴 ID가 중복되었습니다.');
  assert.ok(
    registry.SIDEBAR_MENUS.every(menu => registry.SIDEBAR_MENU_ACTIONS.includes(menu.api ?? menu.action ?? '')),
    '사이드바 메뉴에 등록되지 않은 동작이 연결되었습니다.',
  );
  const menuById = (id: string) => registry.SIDEBAR_MENUS.find(menu => menu.id === id);
  assert.deepEqual(
    ['scam-detector-btn', 'eta-ranking-btn', 'hunting-path-simulator-btn'].map(id => menuById(id)?.category),
    ['monitoring', 'information', 'calculators'],
  );
  assert.deepEqual(
    ['contents-checker-btn', 'sword-enhance-btn'].map(id => ({
      category: menuById(id)?.category,
      isOneDepth: menuById(id)?.isOneDepth,
    })),
    [
      { category: 'homework', isOneDepth: undefined },
      { category: 'minigame', isOneDepth: true },
    ],
  );

  const traySource = read('src/modules/tray.ts');
  const actionSource = read('src/modules/trayMenuActions.ts');
  assert.match(traySource, /SIDEBAR_MENUS, getSidebarMenuAction/,
    '트레이가 공통 사이드바 메뉴 레지스트리를 사용하지 않습니다.');
  assert.doesNotMatch(traySource, /apiMapping|sidebar_menus\.json/,
    '트레이에 메뉴 메타데이터 또는 동작 매핑이 다시 중복 선언되었습니다.');
  assert.match(actionSource, /satisfies Record<TrayMenuAction, TrayMenuHandler>/,
    '트레이 동작 구현의 타입 완전성 검사가 없습니다.');
}

function checkWindowFocusControllerContracts(): void {
  const focusModule = require(path.join(projectRoot, 'dist', 'modules', 'windowFocusController.js')) as {
    WindowFocusController: new (options: Record<string, unknown>) => {
      attach: (win: any) => void;
      getOrderedWindowHandles: (main: any, dock: any, overlay: any) => string[];
      setRestoreSuppressed: (suppressed: boolean) => void;
      cancelPendingRestore: () => void;
      scheduleRestore: () => void;
    };
  };

  function createFakeWindow(handleId: number) {
    const listeners: Record<string, Array<() => void>> = {};
    const webListeners: Record<string, Array<() => void>> = {};
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(handleId));
    let destroyed = false;
    let visible = true;
    let devtoolsCloseCount = 0;
    return {
      on(event: string, callback: () => void) { (listeners[event] ||= []).push(callback); },
      emit(event: string) { listeners[event]?.forEach(callback => callback()); },
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      getNativeWindowHandle: () => handle,
      webContents: {
        on(event: string, callback: () => void) { (webListeners[event] ||= []).push(callback); },
        closeDevTools() { devtoolsCloseCount += 1; },
      },
      emitWeb(event: string) { webListeners[event]?.forEach(callback => callback()); },
      setDestroyed(value: boolean) { destroyed = value; },
      setVisible(value: boolean) { visible = value; },
      getDevtoolsCloseCount: () => devtoolsCloseCount,
    };
  }

  const controller = new focusModule.WindowFocusController({
    isDev: false,
    focusDebounceMs: 50,
    focusRestoreDelayMs: 50,
    onWindowFocused: () => {},
    canScheduleRestore: () => true,
    canRestoreFocus: () => true,
    restoreFocus: () => {},
  });
  const olderSub = createFakeWindow(11);
  const newerSub = createFakeWindow(12);
  const main = createFakeWindow(21);
  const dock = createFakeWindow(22);
  const overlay = createFakeWindow(23);
  controller.attach(olderSub);
  controller.attach(newerSub);
  assert.deepEqual(controller.getOrderedWindowHandles(main, dock, overlay), ['12', '11', '21', '22', '23']);

  olderSub.emitWeb('devtools-opened');
  assert.equal(olderSub.getDevtoolsCloseCount(), 1, '프로덕션 창의 개발자 도구 방어가 연결되지 않았습니다.');
  newerSub.emit('closed');
  assert.deepEqual(controller.getOrderedWindowHandles(main, dock, overlay), ['11', '21', '22', '23']);

  const manager = read('src/modules/windowManager.ts');
  const controllerSource = read('src/modules/windowFocusController.ts');
  assert.doesNotMatch(manager, /activeWindowsStack|focusRestoreTimer|suppressFocusRestore/,
    'windowManager에 포커스 스택 또는 복구 타이머 상태가 다시 중복되었습니다.');
  assert.match(manager, /focusController\.scheduleRestore\(\)/,
    '창 종료와 공통 게임 포커스 복구 정책이 연결되지 않았습니다.');
  assert.match(controllerSource, /restoreSuppressed \|\| !this\.options\.canScheduleRestore\(\)/,
    '앱 종료 또는 일괄 숨김 중 포커스 복구를 차단하지 않습니다.');
  controller.cancelPendingRestore();
}

function checkEmbeddedWebWindowContracts(): void {
  const embeddedModule = require(path.join(projectRoot, 'dist', 'modules', 'embeddedWebTool.js')) as {
    calculateEmbeddedWebToolBounds: (
      bounds: { x: number; y: number; width: number; height: number },
      headerHeight: number,
      footerHeight: number,
    ) => { x: number; y: number; width: number; height: number };
  };
  assert.deepEqual(
    embeddedModule.calculateEmbeddedWebToolBounds({ x: 50, y: 80, width: 900, height: 700 }, 56, 28),
    { x: 0, y: 56, width: 900, height: 616 },
    '외부 웹 도구의 헤더·푸터 제외 영역이 변경되었습니다.',
  );

  const manager = read('src/modules/windowManager.ts');
  const embeddedSource = read('src/modules/embeddedWebTool.ts');
  const toolbarSource = read('src/modules/overlayToolbarController.ts');
  assert.match(manager, /uniformColorTool = new EmbeddedWebTool[\s\S]*?followWindowResize: false/,
    '제복 색상 도구의 기존 고정 view 배치 정책이 변경되었습니다.');
  assert.match(manager, /swordEnhanceTool = new EmbeddedWebTool[\s\S]*?followWindowResize: true/,
    '검 강화 도구의 창 리사이즈 연동이 없습니다.');
  assert.match(manager, /https:\/\/twsnowflower\.github\.io\/uniform_color\/spin\.html/);
  assert.match(manager, /https:\/\/twliker\.github\.io\/tw-sword-enhance\//);
  assert.match(embeddedSource, /backgroundThrottling: false/,
    '외부 웹 도구가 비활성 상태에서 제한될 수 있습니다.');
  assert.match(embeddedSource, /if \(options\.followWindowResize\) window\.on\('resize', this\.updateBounds\)/,
    '도구별 리사이즈 정책이 공통 생명주기에 반영되지 않습니다.');
  assert.match(embeddedSource, /insertCSS\(options\.css!, \{ cssOrigin: 'user' \}\)/,
    '제복 색상 외부 페이지 CSS 보정 경로가 없습니다.');

  assert.match(manager, /hideDelayMs: 300/,
    '브라우저 오버레이 툴바 자동 숨김 지연 시간이 변경되었습니다.');
  assert.match(manager, /getCursorScreenPoint\(\)[\s\S]*?cursor\.x >= b\.x[\s\S]*?cursor\.y >= b\.y/,
    '브라우저 오버레이 bounds 변경 시 실제 커서 위치 방어가 없습니다.');
  assert.match(toolbarSource, /mouseInToolbar \|\| this\.mouseInContent/,
    '툴바 또는 콘텐츠 위에 마우스가 있을 때 자동 숨김을 차단하지 않습니다.');
  assert.match(manager, /overlay-wcv-mouse-enter[\s\S]*?enterContent\(\)[\s\S]*?toolbar-mouse-enter[\s\S]*?enterToolbar\(\)/,
    '브라우저와 툴바 IPC가 공통 상태 컨트롤러에 연결되지 않았습니다.');
}

function checkFocusedChatContracts(): void {
  const menuData = JSON.parse(read('src/assets/data/sidebar_menus.json'));
  const focusedMenu = menuData.find((item: { id?: string }) => item.id === 'focused-chat-btn');
  assert.ok(focusedMenu, '집중 대화방 런처 메뉴가 없습니다.');
  assert.equal(focusedMenu.api, 'toggleFocusedChat');

  const processor = read('src/modules/chatLogProcessor.ts');
  assert.match(processor, /sendToAllWindowsByPage\('focused-chat\.html', 'chat-updated', chatItem\)/,
    '새 채팅이 집중 대화방으로 전달되지 않습니다.');
  assert.match(processor, /isSelf: options\.color === CHAT_COLORS\.selfGeneral/,
    '본인 일반 채팅 판별 정보가 채팅 항목에 보존되지 않습니다.');
  assert.match(processor, /config\.save\(\{ focusedChatSelfNickname: normalized \}\)/,
    '집중 대화방의 내 닉네임이 설정에 저장되지 않습니다.');
  assert.match(processor, /clearFocusedChatSession\(\)[\s\S]*?this\._focusedChatTargets = \[\];[\s\S]*?this\._knownNicknames\.clear\(\)/,
    '집중 대화방을 닫을 때 상대 및 자동완성 닉네임이 메모리에서 제거되지 않습니다.');

  const renderer = read('src/focusedChatRenderer.ts');
  assert.match(renderer, /visibleChannels = new Set\(\['general', 'team', 'club', 'whisper'\]\)/,
    '집중 대화방의 대화 채널 필터가 변경되었습니다.');
  assert.match(renderer, /targets\.some\(target => normalizeNickname\(target\) === sender\)/,
    '집중 대화방이 닉네임 정확 일치 방식으로 필터링되지 않습니다.');
  assert.doesNotMatch(renderer, /innerHTML\s*=/,
    '집중 대화방의 사용자 닉네임 또는 메시지가 innerHTML로 렌더링될 수 있습니다.');
  assert.match(renderer, /etaBadge\.textContent = `에타 \$\{item\.level\}`/,
    '집중 대화방 메시지에 에타 배지가 표시되지 않습니다.');
  assert.match(renderer, /setFocusedChatSize\(width, height\)/,
    '집중 대화방의 드래그 리사이즈 연결이 없습니다.');

  const windowManager = read('src/modules/windowManager.ts');
  const sizingSource = read('src/modules/managedWindowSizing.ts');
  assert.match(sizingSource, /focusedChat: \{ width: 'focusedChatWidth', height: 'focusedChatHeight' \}/,
    '집중 대화방에서 조절한 창 크기가 저장되지 않습니다.');
  assert.match(sizingSource, /key === 'focusedChat' \? 360/,
    '집중 대화방의 최소 너비 제한이 없습니다.');
  assert.match(windowManager, /applyManagedWindowSize\(key, cfg, b\.width, b\.height\)/,
    '일반 창 리사이즈 이벤트가 공통 크기 저장 정책과 연결되지 않았습니다.');
  assert.match(renderer, /setFocusedChatTargets\(\[\.\.\.targets\]\)/,
    '집중 대화방의 상대 닉네임이 임시 세션 상태로 전달되지 않습니다.');
  assert.doesNotMatch(renderer, /applySettings|onConfigData/,
    '집중 대화방의 임시 상대 또는 자동완성 데이터가 앱 설정과 연결될 수 있습니다.');

  const appConfig = read('src/shared/types.ts');
  const defaults = `${read('src/modules/constants.ts')}\n${read('src/preload.ts')}`;
  assert.doesNotMatch(appConfig, /focusedChat(?:Nicknames|KnownNicknames)/,
    '임시 상대 또는 자동완성 닉네임이 AppConfig에 선언되어 있습니다.');
  assert.doesNotMatch(defaults, /focusedChat(?:Nicknames|KnownNicknames)/,
    '임시 상대 또는 자동완성 닉네임이 기본 설정에 포함되어 있습니다.');

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(ipcHandlers, /focused-chat-get-history[\s\S]*?getChatHistory\('Basic'\)/,
    '집중 대화방의 최근 기록 조회 IPC가 없습니다.');
  assert.doesNotMatch(
    ipcHandlers.match(/ipcMain\.handle\('focused-chat-get-history'[\s\S]*?\n  \}\);/)?.[0] || '',
    /resetLastReadIndex/,
    '집중 대화방을 열 때 기존 채팅 오버레이의 페이지 읽기 상태가 초기화될 수 있습니다.',
  );
}

function checkLifecycleAndIpcSafetyContracts(): void {
  const frameSafeMessaging = read('src/modules/windowMessaging.ts');
  assert.match(frameSafeMessaging, /mainFrame[\s\S]*?frame\.isDestroyed\(\) \|\| frame\.detached/,
    '닫히는 렌더 프레임으로 IPC를 보내는 경쟁 상태 방어가 없습니다.');

  [
    'src/modules/chatLogProcessor.ts',
    'src/modules/xpTracker.ts',
    'src/modules/abandonedTracker.ts',
  ].forEach(file => {
    const source = read(file);
    assert.match(source, /private _started = false;/, `${file}에 시작 상태 가드가 없습니다.`);
    assert.match(
      source,
      /public start\(\): void \{\s*if \(this\._started\)/,
      `${file}의 start()가 중복 실행을 차단하지 않습니다.`,
    );
    assert.match(
      source,
      /this\._started = true;/,
      `${file}이 시작 상태를 기록하지 않습니다.`,
    );
  });

  const preload = read('src/preload.ts');
  assert.doesNotMatch(
    preload,
    /\binvoke:\s*\(channel:\s*string/,
    'preload에 임의 IPC 채널을 호출하는 범용 invoke가 남아 있습니다.',
  );
  assert.match(preload, /getXpStats:\s*\(\): Promise<XpStats>/);
  assert.doesNotMatch(read('src/game-overlay.html'), /electronAPI\.invoke\(/);
  assert.doesNotMatch(read('src/xp-hud.html'), /electronAPI\.invoke\(/);

  const windowMessaging = read('src/modules/windowMessaging.ts');
  assert.match(
    windowMessaging,
    /function safeSend\(window: BrowserWindow,[\s\S]*window\.webContents\.isDestroyed\(\)/,
    '공용 IPC 전송에 폐기된 webContents 차단이 없습니다.',
  );
  assert.match(
    windowMessaging,
    /catch \(error\) \{[\s\S]*error\.message\.includes\('Render frame was disposed'\)/,
    '렌더 프레임 폐기 경쟁 상태의 전송 예외 처리가 없습니다.',
  );
  assert.match(
    windowMessaging,
    /throw error;/,
    '예상하지 못한 IPC 전송 오류를 다시 발생시키지 않습니다.',
  );
  assert.ok(
    (windowMessaging.match(/safeSend\(window, channel, \.\.\.args\)/g) || []).length >= 3,
    '전체 창 IPC 전송 경로가 안전 전송 함수를 사용하지 않습니다.',
  );

  const { resolveSafeChildFile } = require(
    path.join(projectRoot, 'dist/modules/safePath.js'),
  ) as {
    resolveSafeChildFile(parent: string, filename: string): string | null;
  };
  const base = path.join(projectRoot, 'test-sounds');
  assert.equal(resolveSafeChildFile(base, 'custom_safe.wav'), path.join(base, 'custom_safe.wav'));
  assert.equal(resolveSafeChildFile(base, '../outside.wav'), null);
  assert.equal(resolveSafeChildFile(base, '..\\outside.wav'), null);
  assert.equal(resolveSafeChildFile(base, 'nested/file.wav'), null);

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(
    ipcHandlers,
    /resolveSafeChildFile\(customSoundsDir, filename\)/,
    '커스텀 사운드 삭제 경로 검증이 누락되었습니다.',
  );
}

function checkExtractedPureModules(): void {
  const { collectIncompleteContents } = require(
    path.join(projectRoot, 'dist/modules/contentsSummary.js'),
  ) as {
    collectIncompleteContents(config: {
      characterPresets: Array<{ id: string; name: string }>;
      contentsCheckerItems: Array<{
        id: string;
        name: string;
        category: string;
        isVisible: boolean;
        resetRule: { type: 'daily' | 'weekly'; hour: number };
        completedState: Record<string, { isCompleted: boolean; isExcluded?: boolean }>;
      }>;
    }): Array<{ charName: string; name: string }>;
  };

  const result = collectIncompleteContents({
    characterPresets: [
      { id: 'a', name: '가람' },
      { id: 'b', name: '나래' },
    ],
    contentsCheckerItems: [
      {
        id: 'visible',
        name: '표시 숙제',
        category: '테스트',
        isVisible: true,
        resetRule: { type: 'weekly', hour: 0 },
        completedState: {
          a: { isCompleted: false },
          b: { isCompleted: true },
        },
      },
      {
        id: 'excluded',
        name: '제외 숙제',
        category: '테스트',
        isVisible: true,
        resetRule: { type: 'daily', hour: 0 },
        completedState: {
          a: { isCompleted: false, isExcluded: true },
          b: { isCompleted: false, isExcluded: true },
        },
      },
    ],
  });
  assert.deepEqual(result, [{
    charName: '가람',
    name: '표시 숙제',
    category: '테스트',
    type: 'weekly',
  }]);
}

function checkCoreInternalTypesStayStrict(): void {
  [
    'src/preload.ts',
    'src/modules/windowManager.ts',
    'src/modules/contentsChecker.ts',
    'src/modules/chatLogProcessor.ts',
    'src/chatOverlayRenderer.ts',
    'src/shared/types.ts',
  ].forEach(file => {
    assert.doesNotMatch(
      read(file),
      /\bany\b/,
      `${file}의 핵심 내부 데이터에 any가 다시 추가되었습니다.`,
    );
  });
}

function checkLegacyContentsOrderingRemoved(): void {
  const sources = [
    'src/modules/contentsChecker.ts',
    'src/modules/ipcHandlers.ts',
    'src/preload.ts',
    'src/shared/types.ts',
  ].map(read).join('\n');

  [
    'sortOrder',
    'contentsReorderList',
    'contents-reorder-list',
    'reorderList',
  ].forEach(legacyName => {
    assert.equal(
      sources.includes(legacyName),
      false,
      `숙제 수동 정렬 레거시 코드가 남아 있습니다: ${legacyName}`,
    );
  });
}

function checkSharedUiDependencies() {
  const pagesUsingSharedUi = [];
  const sharedCallPattern = /window\.(?:bindEscapeClose|bindElectronListenerCleanup|bindChatLogStatusWarning|highlightElement|formatElapsedTime|formatLocaleNumber|formatSeedAmount|escapeHtml(?:Text|Attribute)?)\s*\(/;

  for (const file of fs.readdirSync(sourceRoot).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    if (!sharedCallPattern.test(html)) continue;
    pagesUsingSharedUi.push(file);
    const dependencyIndex = html.indexOf('assets/ui-utils.js');
    const firstCallIndex = html.search(sharedCallPattern);
    assert.notEqual(dependencyIndex, -1, `${file}에 ui-utils.js 참조가 없습니다.`);
    assert.ok(dependencyIndex < firstCallIndex, `${file}에서 ui-utils.js보다 공통 함수가 먼저 실행됩니다.`);
  }

  assert.ok(pagesUsingSharedUi.length > 0);
}

function loadBrowserConstantModule(relativePath: string, exposedProperty: string): any {
  const window: Record<string, any> = {};
  vm.runInNewContext(read(relativePath), { window }, { filename: relativePath });
  return window[exposedProperty];
}

function checkSharedConstants() {
  const chatConstants = loadBrowserConstantModule(
    'dist/shared/chatConstants.js',
    'chatConstants',
  );
  assert.deepEqual(
    Array.from(chatConstants.NPC_SENDER_BLACKLIST),
    [
      '데스포이나', '신조', '키시니크', '에레오스', '로카고스',
      '마티아', '티로로스', '라이코스', '체리아', '실반',
      '샐리온', '실라이론', '샐레아나', '루미너스', '크라모르',
    ],
  );
  assert.equal(chatConstants.isNpcSender('크라모르'), true);
  assert.equal(chatConstants.isLegacyNpcSender('크라모르'), false);
  assert.equal(chatConstants.isNpcSender('일반유저'), false);

  const chatParser = read('src/modules/chatParser.ts');
  const chatLogManager = read('src/modules/chatLogManager.ts');
  const chatOverlayRenderer = read('src/chatOverlayRenderer.ts');
  assert.match(chatParser, /require\('\.\.\/shared\/chatConstants'\)/);
  assert.match(chatLogManager, /require\('\.\.\/shared\/chatConstants'\)/);
  assert.doesNotMatch(
    chatOverlayRenderer,
    /\bconst\s*\{\s*NPC_SENDER_BLACKLIST\s*\}/,
    '채팅 오버레이가 공통 NPC 상수를 같은 이름으로 다시 선언합니다.',
  );
  assert.match(chatOverlayRenderer, /window\.chatConstants\.isNpcSender\(/);

  const buffConstants = loadBrowserConstantModule(
    'dist/shared/buffConstants.js',
    'buffConstants',
  );
  assert.equal(buffConstants.STANDARD_BUFFS.length, 9);
  assert.equal(buffConstants.STANDARD_BUFFS[0], 'util_snowman');
  assert.equal(buffConstants.STANDARD_BUFFS[8], 'util_haste');

  const sidebarCategories: any[] = loadBrowserConstantModule(
    'dist/shared/sidebarCategories.js',
    'sidebarCategories',
  );
  assert.deepEqual(
    Array.from(sidebarCategories, category => category.id),
    ['records', 'monitoring', 'alarms', 'calculators', 'information', 'homework', 'minigame'],
  );
  assert.deepEqual(
    Array.from([...sidebarCategories].sort((a, b) => a.trayOrder - b.trayOrder), category => category.id),
    ['records', 'monitoring', 'alarms', 'calculators', 'information', 'homework', 'minigame'],
  );
  assert.deepEqual(
    Array.from(sidebarCategories.slice(0, 5), category => ({
      label: category.label,
      icon: category.icon,
      color: category.color,
    })),
    [
      { label: '플레이 관리 & 기록', icon: 'clipboard-check', color: 'emerald-400' },
      { label: '커뮤니티 & 채팅', icon: 'messages-square', color: 'sky-400' },
      { label: '알림 설정', icon: 'bell-ring', color: 'pink-400' },
      { label: '계산기 & 시뮬레이터', icon: 'calculator', color: 'indigo-400' },
      { label: '정보 & 도감', icon: 'book-open', color: 'blue-400' },
    ],
  );
  assert.equal(sidebarCategories.find(category => category.id === 'homework')?.settingsLabel, '숙제 관리');

  const chatChannels = loadBrowserConstantModule(
    'dist/shared/chatChannels.js',
    'chatChannels',
  );
  assert.deepEqual(
    Array.from(chatChannels.OVERLAY_CHANNELS),
    ['general', 'whisper', 'team', 'club', 'shout', 'system'],
  );
  assert.deepEqual(
    { ...chatChannels.COLORS },
    {
      general: '#ffffff', selfGeneral: '#c8ffc8', whisper: '#64ff64',
      team: '#f7b73c', club: '#94ddfa', shout: '#c896c8',
      system: '#a8a8a8', nickname: '#94a3b8',
    },
  );
  assert.equal(chatChannels.formatTimestamp('오전 12시 03분 22초'), '00:03');
  assert.equal(chatChannels.formatTimestamp('오후 1시 09분 11초'), '13:09');
  assert.equal(chatChannels.formatTimestamp('12시 30분 00초'), '00:30');

  const focusedChatRenderer = read('src/focusedChatRenderer.ts');
  const wordAlarmPage = read('src/word-alarm.html');
  const scamParser = read('src/modules/scam/parser.ts');
  assert.match(focusedChatRenderer, /window\.chatChannels\.COLORS\.selfGeneral/);
  assert.doesNotMatch(focusedChatRenderer, /=== '#c8ffc8'/,
    '집중 대화방에 본인 채팅 색상이 다시 중복 선언되었습니다.');
  assert.match(scamParser, /require\('\.\.\/\.\.\/shared\/chatChannels'\)/);
  assert.match(scamParser, /color === CHAT_COLORS\.selfGeneral/);
  assert.ok(
    wordAlarmPage.indexOf('shared/chatChannels.js') < wordAlarmPage.indexOf('<script>'),
    '단어 알림이 채팅 채널 공통 모듈보다 먼저 실행됩니다.',
  );
  assert.match(wordAlarmPage, /window\.chatChannels\.COLORS\.club/);

  const chatOverlay = read('src/chat-overlay.html');
  assert.ok(
    chatOverlay.indexOf('shared/chatConstants.js')
      < chatOverlay.indexOf('chatOverlayRenderer.js'),
    'chat-overlay 상수 모듈이 렌더러보다 늦게 로드됩니다.',
  );
  assert.ok(
    chatOverlay.indexOf('shared/chatChannels.js') < chatOverlay.indexOf('chatOverlayRenderer.js'),
    '채팅 채널 공통 모듈이 채팅 오버레이 렌더러보다 늦게 로드됩니다.',
  );
  const settingsPage = read('src/settings.html');
  assert.ok(
    settingsPage.indexOf('shared/sidebarCategories.js') < settingsPage.indexOf('renderer/settings/menu-management.js'),
    '사이드바 카테고리 공통 모듈이 설정 메뉴 관리 모듈보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('shared/chatChannels.js') < settingsPage.indexOf('renderer/settings/form-collection.js'),
    '채팅 채널 공통 모듈이 설정 렌더러 모듈보다 늦게 로드됩니다.',
  );
  assert.doesNotMatch(read('src/renderer/settings/menu-management.ts'), /MENU_CATEGORIES/);
  assert.doesNotMatch(read('src/renderer/settings/shortcuts.ts'), /CommandOrControl\+Shift/,
    '설정 단축키 모듈에 기본 단축키가 다시 중복 선언되었습니다.');
  assert.doesNotMatch(read('src/renderer/settings/audio-controls.ts'), /(?:ethos|orb|default)-alert\.mp3/,
    '설정 오디오 모듈에 기본 알림음이 다시 중복 선언되었습니다.');
  const coefficientCalculator = read('src/coefficient-calculator.html');
  assert.ok(
    coefficientCalculator.indexOf('shared/buffConstants.js')
      < coefficientCalculator.indexOf('coefficient-calculator-renderer.js'),
    '버프 상수 모듈이 계수 계산기 렌더러보다 늦게 로드됩니다.',
  );
}

function checkPreloadDefaultConfigCompatibility() {
  const preloadSource = read('src/preload.ts');
  assert.match(
    preloadSource,
    /const MAIN_DEFAULT_CONFIG = ipcRenderer\.sendSync\('get-default-config-sync'\)/,
    'preload이 메인 프로세스의 단일 기본 설정 원본을 조회하지 않습니다.',
  );
  assert.match(
    preloadSource,
    /const DEFAULT_CONFIG: AppConfig = MAIN_DEFAULT_CONFIG;/,
    'preload이 메인 프로세스에서 받은 기본 설정 대신 별도 객체를 사용합니다.',
  );
  assert.doesNotMatch(
    preloadSource,
    /const DEFAULT_CONFIG: AppConfig = \{|CommandOrControl\+Shift|ethosAlertSound:/,
    'preload에 기본 설정 값이 다시 중복 선언되었습니다.',
  );
  const mainDefaultConfig = {
    width: 800,
    customSounds: [],
    showSidebarToastOnOverlay: false,
    shortcuts: { toggleClickThrough: 'CommandOrControl+Shift+T', toggleTimer: 'CommandOrControl+Shift+S' },
  };

  const runtimeImports = Array.from(
    preloadSource.matchAll(/^import(?!\s+type\b)[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm),
    match => match[1],
  );
  assert.deepEqual(
    runtimeImports,
    ['electron'],
    'sandbox preload에 로컬 런타임 import가 추가되었습니다.',
  );

  const builtPreloadPath = path.join(projectRoot, 'dist/preload.js');
  if (fs.existsSync(builtPreloadPath)) {
    const builtPreload = fs.readFileSync(builtPreloadPath, 'utf8');
    assert.doesNotMatch(
      builtPreload,
      /require\(["']\.{1,2}\//,
      '빌드된 sandbox preload에 상대경로 require가 포함되었습니다.',
    );

    const exposedGlobals: Record<string, any> = {};
    const ipcRenderer = {
      send() {},
      sendSync(channel: string) {
        assert.equal(channel, 'get-default-config-sync');
        return mainDefaultConfig;
      },
      invoke() {},
      removeAllListeners() {},
      on() {},
    };
    vm.runInNewContext(builtPreload, {
      exports: {},
      module: { exports: {} },
      require(moduleName: string) {
        assert.equal(moduleName, 'electron', `sandbox preload가 허용되지 않은 모듈을 요청했습니다: ${moduleName}`);
        return {
          contextBridge: {
            exposeInMainWorld(name: string, api: unknown) {
              exposedGlobals[name] = api;
            },
          },
          ipcRenderer,
        };
      },
    }, { filename: 'dist/preload.js' });
    const exposedApi = exposedGlobals.electronAPI;
    assert.ok(exposedApi);
    assert.equal(exposedApi.DEFAULT_CONFIG, mainDefaultConfig);
    assert.equal(exposedApi.DEFAULT_CONFIG.shortcuts.toggleTimer, 'CommandOrControl+Shift+S');
    assert.equal(typeof exposedApi.onPlaySound, 'function');
    assert.equal(typeof exposedApi.onSpecialMonsterAlert, 'function');
  }

  const directListenerCount = (preloadSource.match(/ipcRenderer\.on\(/g) || []).length;
  assert.equal(directListenerCount, 1, 'IPC 이벤트 구독이 공통 바인더 밖에 남아 있습니다.');

  const listenerChannels = Array.from(
    preloadSource.matchAll(/bindIpcListener(?:<[^>]*>)?\(\s*'([^']+)'/g),
    match => match[1],
  );
  assert.deepEqual(listenerChannels, [
    'trigger-jellyppy-rain', 'trigger-firework', 'sidebar-status', 'overlay-status',
    'chat-overlay-status', 'click-through-status', 'active-windows', 'config-data',
    'chat-log-sync-progress', 'today-summary-config',
    'url-change', 'load-status', 'gallery-posts', 'gallery-new-activity',
    'gallery-watched-update', 'gallery-connection-status', 'update-status',
    'boss-times-data', 'play-sound', 'trade-posts', 'trade-new-activity',
    'trade-connection-status', 'open-settings-tab', 'highlight-alarm-settings',
    'toolbar-hover', 'reminder-message', 'incomplete-contents', 'diary-updated',
    'xp-update', 'shout-history-updated', 'buff-timer-update', 'buff-timer-warning',
    'xp-reset-done', 'essence-alert', 'pitta-alert', 'special-monster-alert',
    'ethos-alert', 'abyss-apostle-alert', 'wave-warning-alert', 'lokagos-alert',
    'quest-started', 'quest-update', 'quest-complete', 'quest-cancelled',
    'scam-alert', 'scam-analysis-result', 'scam-progress', 'scam-session-update',
    'scam-analysis-token', 'auto-select-equipment', 'auto-select-evolution',
    'abandoned-update', 'abandoned-alert', 'abandoned-hide-now', 'chat-updated',
    'chat-history-cleared', 'chat-overlay-mode', 'chat-log-status-changed',
    'alarm-logs-updated', 'timer-toggle', 'timer-updated',
    'game-overlay-edit-mode', 'game-overlay-reset-positions',
    'google-sync-status-changed',
  ]);
}

function checkRequestedFeatureContracts() {
  const contents: any[] = JSON.parse(read('src/assets/data/contents.json'));
  const eternalFloor = contents.find(item => item.id === 'weekly-eternal-floor');
  assert.ok(eternalFloor, '이터널 플로어 숙제가 없습니다.');
  assert.equal(eternalFloor.category, '재화');
  assert.equal(eternalFloor.maxCount, 10);
  assert.equal(eternalFloor.resetRule.type, 'weekly');
  [
    ['weekly-orly-defense', 7],
    ['weekly-shinjo-nest', 7],
    ['weekly-vestige', 7],
  ].forEach(([id, maxCount]) => {
    const item = contents.find(candidate => candidate.id === id);
    assert.ok(item, `${id} 숙제가 없습니다.`);
    assert.equal(item.maxCount, maxCount, `${id}의 주간 횟수가 변경되었습니다.`);
  });

  const parser = read('src/modules/chatParser.ts');
  [
    'SPECIAL_MONSTER_SPAWN',
    'ETERNAL_FLOOR_CLEAR',
    'ORLY_DEFENSE_CLEAR',
    'CONTENT_SHINJO_NEST_CLEAR',
    'VESTIGE_CLEAR',
    '성난\\s*빅테디의\\s*별사탕',
    '이번\\s*주\\s*신조\\s*보상을',
    '남은\\s*공격\\s*횟수',
  ].forEach(contract => assert.ok(parser.includes(contract), `채팅 파서 계약 누락: ${contract}`));

  const processor = read('src/modules/chatLogProcessor.ts');
  assert.match(processor, /queueFixedHomework\('ETERNAL_FLOOR_CLEAR', 'weekly-eternal-floor'\)/);
  assert.match(
    processor,
    /queueCountHomework\('CONTENT_SHINJO_NEST_CLEAR', 'weekly-shinjo-nest'\)/,
  );
  [
    "['ORLY_DEFENSE_CLEAR', 'weekly-orly-defense']",
    "['VESTIGE_CLEAR', 'weekly-vestige']",
  ].forEach(mapping => {
    assert.ok(processor.includes(mapping), `숙제 카운팅 매핑 누락: ${mapping}`);
  });
  assert.match(processor, /sendGameOverlayEvent\('special-monster-alert', data\)/);

  const gameOverlay = read('src/game-overlay.html');
  assert.match(gameOverlay, /onSpecialMonsterAlert/);
  assert.match(read('src/renderer/game-overlay/devtools.ts'), /testSpecialMonsterAlert/);
}

function checkRequestedChatSamples(): void {
  const { chatParser } = require(path.join(projectRoot, 'dist/modules/chatParser.js')) as {
    chatParser: {
      on(event: string, listener: (data: { count?: number }) => void): void;
      once(event: string, listener: (data: { count?: number }) => void): void;
      removeListener(event: string, listener: (data: { count?: number }) => void): void;
      parseLine(line: string): void;
    };
  };
  const samples: Array<[event: string, line: string, expectedCount?: number]> = [
    [
      'SPECIAL_MONSTER_SPAWN',
      '<font size="2" color="white"> [17시 11분  8초] </font><font>맵 어딘가에 특별 몬스터가 출현하였습니다.</font></br>',
    ],
    [
      'ETERNAL_FLOOR_CLEAR',
      '<font size="2" color="white"> [17시 11분  8초] </font><font>[이터널 플로어 보상 상자] 아이템을 획득하였습니다.</font></br>',
    ],
    [
      'ORLY_DEFENSE_CLEAR',
      '<font size="2" color="white"> [21시 33분 22초] </font><font>남은 공격 횟수 : 1</font></br>',
    ],
    [
      'VESTIGE_CLEAR',
      '<font size="2" color="white"> [21시 42분 59초] </font><font>[성난 빅테디의 별사탕] 아이템을 획득하였습니다.</font></br>',
    ],
    [
      'CONTENT_SHINJO_NEST_CLEAR',
      '<font size="2" color="white"> [12시 18분 38초] </font><font>이번 주 신조 보상을 5회 획득 하셨습니다. 한 주에 7회까지 획득 할 수 있습니다.</font></br>',
      5,
    ],
    [
      'MAGIC_STONE_GAIN',
      '<font size="2" color="white"> [22시 39분 34초] </font> <font size="2" color="#ff64ff">하급 마정석 1개를 획득 하였습니다.</font></br>',
      1,
    ],
    [
      'MAGIC_STONE_GAIN',
      '<font size="2" color="white"> [22시 40분 10초] </font><font>펫이 [중급 마정석]을(를) 주웠습니다.</font></br>',
      1,
    ],
    [
      'MAGIC_STONE_GAIN',
      '<font size="2" color="white"> [22시 40분 15초] </font><font>[상급 마정석] 2개를 획득하였습니다.</font></br>',
      2,
    ],
    [
      'MAGIC_STONE_LOSS',
      '<font size="2" color="white"> [22시 41분 00초] </font><font>누에게 [하급 마정석] 20개를 빼앗겼습니다.</font></br>',
      20,
    ],
    [
      'ABANDONED_ENTRY',
      '<font size="2" color="white"> [22시 38분 01초] </font><font>이번 주 어벤던로드 카디프 지역의 도전 횟수는 5번 입니다.</font></br>',
      5,
    ],
  ];

  for (const [event, line, expectedCount] of samples) {
    let emittedCount = 0;
    let parsedCount: number | undefined;
    chatParser.once(event, data => {
      emittedCount++;
      parsedCount = data.count;
    });
    chatParser.parseLine(line);
    assert.equal(emittedCount, 1, `${event} 이벤트가 정확히 한 번 발생하지 않았습니다.`);
    if (expectedCount !== undefined) {
      assert.equal(parsedCount, expectedCount, `${event} 횟수 파싱에 실패했습니다.`);
    }
  }

  // 타인 마정석 획득 공지 메시지는 MAGIC_STONE_GAIN을 발생시키지 않아야 함
  let otherStoneGained = false;
  const stoneListener = () => { otherStoneGained = true; };
  chatParser.on('MAGIC_STONE_GAIN', stoneListener);
  chatParser.parseLine('<font size="2" color="white"> [19시 38분 42초] </font> <font size="2" color="#ff64ff">누군가 어밴던로드에서 주문을 통해 하급 마정석 1000개를 획득 하였습니다.</font></br>');
  chatParser.removeListener('MAGIC_STONE_GAIN', stoneListener);
  assert.equal(otherStoneGained, false, '타인의 마정석 획득 공지 메시지가 MAGIC_STONE_GAIN 이벤트를 발생시켰습니다.');
}

function checkNoAuthoredJavaScriptSources(): void {
  const authoredJavaScriptFiles: string[] = [];

  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
        authoredJavaScriptFiles.push(path.relative(projectRoot, absolutePath));
      }
    }
  }

  walk(path.join(projectRoot, 'src'));
  walk(path.join(projectRoot, 'scripts'));
  assert.deepEqual(
    authoredJavaScriptFiles,
    [],
    `직접 작성한 JavaScript 원본이 남아 있습니다: ${authoredJavaScriptFiles.join(', ')}`,
  );
}

function checkAgentDocumentationLocations(): void {
  [
    '.agents/AGENTS.md',
    '.agents/PROJECT_GUIDE.md',
    '.agents/DESIGN_TOKENS.md',
    '.agents/release_workflow.md',
  ].forEach(file => {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), true, `${file} 파일이 없습니다.`);
  });
  [
    '.gemini/DESIGN_TOKENS.md',
    '.gemini/release_workflow.md',
  ].forEach(file => {
    assert.equal(
      fs.existsSync(path.join(projectRoot, file)),
      false,
      `사용 중단된 Gemini 문서 경로가 다시 추가되었습니다: ${file}`,
    );
  });

  const agentRules = read('.agents/AGENTS.md');
  assert.match(agentRules, /\[PROJECT_GUIDE\.md\]\(\.\/PROJECT_GUIDE\.md\)/);
  assert.match(agentRules, /\[DESIGN_TOKENS\.md\]\(\.\/DESIGN_TOKENS\.md\)/);
  assert.match(agentRules, /\[release_workflow\.md\]\(\.\/release_workflow\.md\)/);

  const projectGuide = read('.agents/PROJECT_GUIDE.md');
  [
    'src/main.ts',
    'src/modules',
    'src/shared',
    'src/renderer',
    'ChatLogManager',
    'ChatParser',
    'ChatLogProcessor',
    'npm run typecheck',
    'npm test',
  ].forEach(requiredText => assert.ok(
    projectGuide.includes(requiredText),
    `프로젝트 가이드에 필수 설명이 없습니다: ${requiredText}`,
  ));

  const releaseWorkflow = read('.agents/release_workflow.md');
  ['npm run typecheck', 'npm test', 'npm audit --omit=dev', 'npm run dist', 'npm run build-tools']
    .forEach(command => assert.ok(
      releaseWorkflow.includes(command),
      `릴리즈 워크플로우에 필수 명령이 없습니다: ${command}`,
    ));

  const buildWorkflow = read('.github/workflows/build.yml');
  [
    'actions/checkout@v6',
    'actions/setup-node@v6',
    'node-version: 24',
    'npm ci',
    'npm run typecheck',
    'npm test',
    'npm audit --omit=dev',
    'npm exec electron-builder -- --win --publish never',
    'softprops/action-gh-release@v3',
    'draft: true',
    'fail_on_unmatched_files: true',
    'dist_electron/twOverlay-Setup-*.exe',
    'dist_electron/twOverlay-Setup-*.exe.blockmap',
    'dist_electron/latest.yml',
  ]
    .forEach(command => assert.ok(
      buildWorkflow.includes(command),
      `GitHub Actions 배포 검증에 필수 명령이 없습니다: ${command}`,
    ));
  assert.equal(
    (buildWorkflow.match(/softprops\/action-gh-release@v3/g) || []).length,
    1,
    'GitHub Draft Release 생성 단계는 정확히 하나여야 합니다.',
  );
  assert.doesNotMatch(
    buildWorkflow,
    /action-electron-builder|--publish\s+(?:always|onTag|onTagOrDraft)/,
    'Electron Builder가 GitHub Release를 직접 게시하면 Draft가 중복 생성될 수 있습니다.',
  );
}

function checkBuffTimerChatTriggers(): void {
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js'));

  const detected: Array<{ buffId: string; usedBy: string }> = [];
  const listener = (data: { buffId: string; usedBy: string }) => {
    detected.push({ buffId: data.buffId, usedBy: data.usedBy });
  };

  chatParser.on('BUFF_USED', listener);

  try {
    // 실제 게임 로그 형식: 시간 태그 + 색상 태그가 한 줄에 존재
    chatParser.parseLine('<font size="2" color="white"> [21시 35분 5초] </font><font size="2" color="#ff64ff">[전기세비싸]님이 [통찰의 비약(대)] 아이템을 사용하셨습니다</font>');
    chatParser.parseLine('<font size="2" color="white"> [21시 35분 59초] </font><font size="2" color="#ff64ff">[전기세비싸]님이 [통찰의 비약(특대)] 아이템을 사용하셨습니다</font>');
    chatParser.parseLine('<font size="2" color="white"> [21시 00분 00초] </font>[경험의 심장]을(를) 사용하였습니다.');
    chatParser.parseLine('<font size="2" color="white"> [21시 00분 01초] </font>[홍길동]님이 [로토의 부적] 아이템을 사용하셨습니다.');
    chatParser.parseLine('<font size="2" color="white"> [12시  3분 20초] </font> <font size="2" color="#ff64ff">친구들이 주는 신뢰가 힘을 주고 있다. 모든 능력치 31 증가.</font></br>');

    assert.equal(detected.length, 4, `타이머 표시 대상 4개만 감지되어야 합니다. (실제: ${detected.length}개, buffIds: ${detected.map(d => d.buffId).join(', ')})`);
    assert.deepEqual(detected[0], { buffId: 'insight_elixir_large', usedBy: '전기세비싸' });
    assert.deepEqual(detected[1], { buffId: 'insight_elixir_special', usedBy: '전기세비싸' });
    assert.deepEqual(detected[2], { buffId: 'exp_heart', usedBy: 'self' });
    assert.deepEqual(detected[3], { buffId: 'rare_loto', usedBy: '홍길동' });
  } finally {
    chatParser.removeListener('BUFF_USED', listener);
  }
}

function checkChatLogNormalizationAndItemAcquisition(): void {
  const {
    ChatLogLineNormalizer,
    decodeChatLogBuffer,
    normalizeChatLogLines,
  } = require(path.join(projectRoot, 'dist/modules/chatLogNormalizer.js')) as {
    ChatLogLineNormalizer: new () => {
      push(line: string): string[];
      flush(): string[];
    };
    decodeChatLogBuffer(buffer: Buffer): { content: string; encoding: string; damaged: boolean };
    normalizeChatLogLines(lines: string[]): string[];
  };
  const { parseItemAcquisition, formatLootDiaryContent } = require(path.join(projectRoot, 'dist/modules/itemAcquisition.js')) as {
    parseItemAcquisition(message: string, context?: { isSelfChat?: boolean }): {
      itemName: string;
      count: number;
      source: string;
      isOwn: boolean;
    } | null;
    formatLootDiaryContent(itemName: string): string;
  };
  assert.equal(formatLootDiaryContent(' 경험의\u200B  정수 '), '[득템] 경험의 정수');

  const prefix = '<font size="2" color="white"> [ 0시 25분 12초] </font> <font size="2" color="#ff64ff">';
  const first = `${prefix}피버 효과 : [공격 피해량 +10%] 적용되었습</font></br>`;
  const continuation = `${prefix}니다</font></br>`;
  const merged = normalizeChatLogLines([first, continuation]);
  assert.equal(merged.length, 1);
  assert.match(merged[0], /적용되었습니다<\/font>/);

  const elsoSplitFirst = `${prefix}콘텐츠 클리어 기본 보상으로 [엘소 스크롤 (50 포인트)] 아이템을 15개 획득하였습니</font></br>`;
  const elsoSplitSecond = `${prefix}다.</font></br>`;
  const elsoMerged = normalizeChatLogLines([elsoSplitFirst, elsoSplitSecond]);
  assert.equal(elsoMerged.length, 1);
  assert.match(elsoMerged[0], /15개 획득하였습니다\.<\/font>/);

  const distinct = normalizeChatLogLines([
    `${prefix}[머큐리얼 케이브 코어] 효과가 발동되었습니다.</font></br>`,
    `${prefix}[어비스 코어] 효과가 발동되었습니다.</font></br>`,
  ]);
  assert.equal(distinct.length, 2, '같은 시각의 독립 시스템 메시지가 합쳐졌습니다.');

  const completeRewards = normalizeChatLogLines([
    `${prefix}풍요로운 발굴 지원 보상을 획득했습니다. (하급 조합 조각 1개)</font></br>`,
    `${prefix}경험치가 1,234 증가했습니다.</font></br>`,
    `${prefix}참을 수 없는 힘에 의해 상태이상 [버서크]</font></br>`,
    `${prefix}스탯 자동 분배 완료</font></br>`,
  ]);
  assert.equal(completeRewards.length, 4, '완결된 괄호 메시지가 다음 이벤트와 합쳐졌습니다.');

  const stream = new ChatLogLineNormalizer();
  assert.deepEqual(stream.push(first), []);
  assert.equal(stream.push(continuation).length, 1);
  assert.deepEqual(stream.flush(), []);

  const utf8Decoded = decodeChatLogBuffer(Buffer.from(
    '<font color="white"> [13시 47분 0초] </font> Date : 2026년 8월 14일',
    'utf8',
  ));
  assert.equal(utf8Decoded.encoding, 'utf8');
  assert.equal(utf8Decoded.damaged, false);
  const iconv = require('iconv-lite') as typeof import('iconv-lite');
  const eucKrDecoded = decodeChatLogBuffer(iconv.encode(
    '<font color="white"> [13시 47분 0초] </font> Date : 2026년 8월 14일',
    'euc-kr',
  ));
  assert.equal(eucKrDecoded.encoding, 'euc-kr');
  assert.equal(eucKrDecoded.damaged, false);

  assert.deepEqual(parseItemAcquisition('펫이 [장비 강화석]을(를) 주웠습니다.'), {
    itemName: '장비 강화석', count: 1, source: 'pet', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[참 잘했어요]을(를) 5개 습득했습니다.'), {
    itemName: '참 잘했어요', count: 5, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[장비 강화석] 10개를 입수했습니다.'), {
    itemName: '장비 강화석', count: 10, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('하급 마정석 3개를 획득 하였습니다.'), {
    itemName: '하급 마정석', count: 3, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('오케스트라 룸 보상으로 경험의 정수 2개를 획득했습니다.'), {
    itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[[+12] 일회용 베기 인챈트 주문서]을(를) [1]개 획득하였습니다.'), {
    itemName: '[+12] 일회용 베기 인챈트 주문서', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('누군가 프시키의 문양을 획득 하였습니다.'), {
    itemName: '프시키의 문양', count: 1, source: 'other', isOwn: false,
  });
  assert.deepEqual(parseItemAcquisition('누군가 어밴던로드에서 주문을 통해 하급 마정석 1000개를 획득 하였습니다.'), {
    itemName: '하급 마정석', count: 1000, source: 'other', isOwn: false,
  });
  assert.deepEqual(parseItemAcquisition('테일즈 패스 보상을 획득하였습니다 : [테일즈 패스] 보급 상자'), {
    itemName: '보급 상자', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[엘소 50포인트]을(를) [2]개 획득하였습니다.'), {
    itemName: 'ELSO', count: 100, source: 'direct', isOwn: true,
  });

  const { parseElsoMessage } = require(path.join(projectRoot, 'dist/modules/itemAcquisition.js')) as {
    parseElsoMessage(msg: string): number;
  };
  assert.equal(parseElsoMessage('콘텐츠 클리어 기본 보상으로 [엘소 스크롤 (50 포인트)] 아이템을 15개 획득하였습니다.'), 750);
  assert.equal(parseElsoMessage('[엘소 스크롤 (50 포인트)] 15개를 획득했습니다.'), 750);
  assert.equal(parseElsoMessage('[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.'), 10);
  assert.equal(parseElsoMessage('[엘소 스크롤 (10 포인트)]을(를) 획득하였습니다.'), 10);
  assert.equal(parseElsoMessage('[엘소 50포인트]을(를) [2]개 획득하였습니다.'), 100);
  assert.equal(parseElsoMessage('일일 보상으로 1,000 Elso 포인트를 획득하였습니다.'), 1000);
  assert.equal(parseElsoMessage('루미나의 회랑 ELSO 획득량 증가 효과로 [500] ELSO 포인트를 추가로 획득했습니다.'), 500);
  assert.equal(parseElsoMessage('[50]ELSO를 습득했습니다.'), 50);
  assert.deepEqual(parseItemAcquisition('테스터 : 금화 주머니를 획득했습니다.', { isSelfChat: true }), {
    itemName: '금화 주머니', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 1개 획득하였습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 획득하였습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('보급품 탈환 성공 보상으로 경험의 정수 1개를 획득했습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('보급품 탈환 성공 보상으로 경험의 정수 1개와 3000만 Seed를 획득했습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 10개 획득하였습니다.'), {
    itemName: '경험의 정수', count: 10, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('달여왕 군대 훈련소 클리어 보상으로 경험의 정수 2개를 획득했습니다.'), {
    itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 추가로 획득하였습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  [
    '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.',
    '탐험 포인트를 10만큼 획득하였습니다.',
    '수호의 가호(피해 저항 +15%) 효과를 획득했습니다.',
    '경험치 100억이 차감되고, 경험의 정수 1개를 획득 하였습니다.',
  ].forEach(message => assert.equal(
    parseItemAcquisition(message),
    null,
    `아이템이 아닌 획득 문구를 잘못 분류했습니다: ${message}`,
  ));

  const { chatParser } = require(path.join(projectRoot, 'dist/modules/chatParser.js')) as {
    chatParser: {
      on(event: string, listener: (data: any) => void): void;
      off(event: string, listener: (data: any) => void): void;
      once(event: string, listener: (data: { itemName: string; count: number; source: string; isOwn: boolean }) => void): void;
      parseLine(line: string): void;
    };
  };
  const acquisitions: Array<{ itemName: string; count: number; source: string; isOwn: boolean }> = [];
  chatParser.once('ITEM_LOOTED', data => { acquisitions.push(data); });
  chatParser.parseLine(`${prefix}펫이 [머큐리얼 케이브 코어]을(를) 주웠습니다.</font></br>`);
  assert.deepEqual(
    acquisitions[0] && {
      itemName: acquisitions[0].itemName,
      count: acquisitions[0].count,
      source: acquisitions[0].source,
    },
    { itemName: '머큐리얼 케이브 코어', count: 1, source: 'pet' },
  );
  const userLogLines = [
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">콘텐츠 클리어 기본 보상으로 [엘소 스크롤 (50 포인트)] 아이템을 15개 획득하였습니</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[이클립스 코어 상자] 아이템을 20개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[셀리니아코스의 보관 주머니] 아이템을 1개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">앞서 획득한 달여왕 군단 훈장 훈장은 [1+1] 이벤트를 통해 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (50 포인트)] 15개를 획득했습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">앞서 획득한 엘소 스크롤 (50 포인트) 아이템은 [1+1] 이벤트를 통해 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[셀리니아코스의 보관 주머니] 1개를 획득했습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">앞서 획득한 셀리니아코스의 보관 주머니 아이템은 [1+1] 이벤트를 통해 획득하였습니</font></br>',
    '<font size="2" color="white"> [13시 34분 24초] </font> <font size="2" color="#ff64ff">전기세비싸님이 팀을 탈퇴하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 25초] </font> <font size="2" color="#ff64ff">[스매쉬]님이 [5000]의 HP를 회복시켜 주었습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 26초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#ff64ff">[스매쉬]님이 [5000]의 HP를 회복시켜 주었습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#c896c8">외치기 : 베한계 이클리스트 500베 효과 삽니다 Click [소온]</font></br>',
    '<font size="2" color="white"> [13시 34분 28초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 28초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">[스매쉬]님이 [5000]의 HP를 회복시켜 주었습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">피버 효과가 종료되었습니다</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 30초] </font> <font size="2" color="#94ddfa">슈테리히트 : 흠</font></br>',
  ];
  const normalizedUserLogs = normalizeChatLogLines(userLogLines);
  let totalParsedElso = 0;
  const userLootListener = (data: { message: string }) => {
    totalParsedElso += parseElsoMessage(data.message);
  };
  chatParser.on('ITEM_LOOTED', userLootListener);

  let totalParsedSeed = 0;
  const userSeedListener = (data: { amount: number }) => {
    totalParsedSeed += data.amount;
  };
  chatParser.on('SEED_GAINED', userSeedListener);

  normalizedUserLogs.forEach(l => chatParser.parseLine(l));
  chatParser.off('ITEM_LOOTED', userLootListener);
  chatParser.off('SEED_GAINED', userSeedListener);

  assert.equal(totalParsedSeed, 35000000, '3500만 SEED 획득 문구가 정상 파싱되지 않았습니다.');
  assert.equal(totalParsedElso, 1560, `사용자 로그에서 총 1560 엘소가 감지되어야 하나 ${totalParsedElso}가 감지되었습니다.`);

  const rewardAcquisitions: Array<{ itemName: string; count: number; source: string; isOwn: boolean }> = [];
  chatParser.once('ITEM_LOOTED', data => { rewardAcquisitions.push(data); });
  chatParser.parseLine(`${prefix}오케스트라 룸 보상으로 경험의 정수 2개를 획득했습니다.</font></br>`);
  assert.deepEqual(
    rewardAcquisitions[0] && {
      itemName: rewardAcquisitions[0].itemName,
      count: rewardAcquisitions[0].count,
      source: rewardAcquisitions[0].source,
      isOwn: rewardAcquisitions[0].isOwn,
    },
    { itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true },
  );

  // ── 신규 숙제 및 로그 파싱 검증 (혼란한 대지, 색을 잃은 땅, 설계자의 채굴장) ──
  const contents = JSON.parse(read('src/assets/data/contents.json')) as Array<{ id: string; name: string; resetRule: { type: string } }>;
  assert.ok(contents.some(c => c.id === 'daily-confused-land' && c.name === '혼란한 대지' && c.resetRule.type === 'daily'), '혼란한 대지 숙제 정의가 누락되었습니다.');
  assert.ok(contents.some(c => c.id === 'daily-colorless-land' && c.name === '색을 잃은 땅' && c.resetRule.type === 'daily'), '색을 잃은 땅 숙제 정의가 누락되었습니다.');
  assert.ok(contents.some(c => c.id === 'daily-architect-mine' && c.name === '설계자의 채굴장' && c.resetRule.type === 'daily'), '설계자의 채굴장 숙제 정의가 누락되었습니다.');

  // 1. 혼란한 대지 ELSO 및 완료 이벤트 검증
  assert.equal(parseElsoMessage('감정 균형 장치 방어 보상으로 5000 ELSO를 획득했습니다.'), 5000);
  assert.equal(parseElsoMessage('혼란한 대지 미션에 성공하여 10000 ELSO를 획득했습니다.'), 10000);

  let confusedClearCalled = false;
  const onConfusedClear = () => { confusedClearCalled = true; };
  chatParser.once('CONFUSED_LAND_CLEAR', onConfusedClear);
  chatParser.parseLine('<font size="2" color="white"> [ 0시  6분 37초] </font> <font size="2" color="#ff64ff">감정 균형 장치 방어 보상으로 5000 ELSO를 획득했습니다.</font></br>');
  assert.ok(confusedClearCalled, '혼란한 대지 완료 이벤트(CONFUSED_LAND_CLEAR)가 발생하지 않았습니다.');

  // 2. 색을 잃은 땅 줄바꿈 병합, 경험의 정수 추출, ELSO 및 완료 이벤트 검증
  const colorlessSplitLogs = [
    '<font size="2" color="white"> [18시 22분 45초] </font> <font size="2" color="#ff64ff">색을 잃은 땅 미션에 성공하여 경험의 정수 2개, 레이티아의 시든 꽃 1개, 루비코나 코</font></br>',
    '<font size="2" color="white"> [18시 22분 45초] </font> <font size="2" color="#ff64ff">어 상자 10개를 획득했습니다.</font></br>',
  ];
  const mergedColorless = normalizeChatLogLines(colorlessSplitLogs);
  assert.equal(mergedColorless.length, 1, '색을 잃은 땅 줄바꿈 로그가 하나로 병합되지 않았습니다.');
  assert.match(mergedColorless[0], /루비코나 코어 상자 10개를 획득했습니다\./);

  const colorlessLootItems: Array<{ itemName: string; count: number }> = [];
  const onColorlessLoot = (data: { itemName: string; count: number }) => {
    colorlessLootItems.push({ itemName: data.itemName, count: data.count });
  };
  chatParser.on('ITEM_LOOTED', onColorlessLoot);
  chatParser.parseLine(mergedColorless[0]);
  chatParser.off('ITEM_LOOTED', onColorlessLoot);
  const essenceItem = colorlessLootItems.find(item => item.itemName === '경험의 정수');
  assert.ok(essenceItem, '색을 잃은 땅 보상에서 경험의 정수가 감지되지 않았습니다.');
  assert.equal(essenceItem?.count, 2, '경험의 정수 획득 수량이 일치하지 않습니다.');

  assert.equal(parseElsoMessage('색을 잃은 땅 미션에 성공하여 10000 ELSO를 획득했습니다.'), 10000);
  assert.equal(parseElsoMessage('미션 효과 미적용 보상으로 10000 ELSO를 추가로 획득했습니다.'), 10000);

  let colorlessClearCalled = false;
  const onColorlessClear = () => { colorlessClearCalled = true; };
  chatParser.once('COLORLESS_LAND_CLEAR', onColorlessClear);
  chatParser.parseLine('<font size="2" color="white"> [18시 22분 45초] </font> <font size="2" color="#ff64ff">색을 잃은 땅 미션에 성공하여 10000 ELSO를 획득했습니다.</font></br>');
  assert.ok(colorlessClearCalled, '색을 잃은 땅 완료 이벤트(COLORLESS_LAND_CLEAR)가 발생하지 않았습니다.');

  // 3. 설계자의 채굴장 하급 조합 조각 획득 및 입장 감지 검증
  let architectEntryCount = 0;
  const onArchitectEntry = (data: { count?: number }) => { architectEntryCount = data.count || 0; };
  chatParser.once('ARCHITECT_MINE_ENTRY', onArchitectEntry);
  chatParser.parseLine('<font size="2" color="white"> [18시 29분 58초] </font> <font size="2" color="#ff64ff">하급 조합 조각 5개를 획득했습니다.</font></br>');
  assert.equal(architectEntryCount, 5, '설계자의 채굴장 입장 이벤트(ARCHITECT_MINE_ENTRY) 수량이 일치하지 않습니다.');

  // 4. 실제 유저 로그 파일(.agents/plan/혼대_색땅_채굴장/TWChatLog_2026_08_17.html) 종합 파싱 검증
  const actualLogPath = path.join(projectRoot, '.agents/plan/혼대_색땅_채굴장/TWChatLog_2026_08_17.html');
  if (fs.existsSync(actualLogPath)) {
    const rawBuf = fs.readFileSync(actualLogPath);
    const decodedLog = decodeChatLogBuffer(rawBuf);
    const normalizedLines = normalizeChatLogLines(decodedLog.content.split('\n'));

    let fileConfusedClears = 0;
    let fileColorlessClears = 0;
    let fileArchitectEntries = 0;
    let fileColorlessEssenceCount = 0;
    let fileConfusedElso = 0;
    let fileColorlessElso = 0;

    const actualParser = new (chatParser.constructor as any)();
    actualParser.on('CONFUSED_LAND_CLEAR', () => { fileConfusedClears++; });
    actualParser.on('COLORLESS_LAND_CLEAR', () => { fileColorlessClears++; });
    actualParser.on('ARCHITECT_MINE_ENTRY', () => { fileArchitectEntries++; });
    actualParser.on('ITEM_LOOTED', (data: { itemName: string; count: number; timestamp: string; message: string }) => {
      if (data.itemName === '경험의 정수' && data.timestamp.includes('18시 22분 45초')) {
        fileColorlessEssenceCount += data.count;
      }
      if (data.timestamp.includes('0시  6분 37초')) {
        fileConfusedElso += parseElsoMessage(data.message);
      }
      if (data.timestamp.includes('18시 22분 45초')) {
        fileColorlessElso += parseElsoMessage(data.message);
      }
    });

    for (const l of normalizedLines) {
      if (l && !l.includes('회복되었습니다')) {
        actualParser.parseLine(l);
      }
    }

    assert.equal(fileConfusedClears, 1, '실제 로그 파일에서 혼란한 대지 완료가 1회 감지되어야 합니다.');
    assert.equal(fileConfusedElso, 15000, '실제 로그 파일에서 혼란한 대지 ELSO 획득 총합(10000+5000)이 15000이어야 합니다.');
    assert.equal(fileColorlessClears, 1, '실제 로그 파일에서 색을 잃은 땅 완료가 1회 감지되어야 합니다.');
    assert.equal(fileColorlessElso, 20000, '실제 로그 파일에서 색을 잃은 땅 ELSO 획득 총합(10000+10000)이 20000이어야 합니다.');
    assert.equal(fileColorlessEssenceCount, 2, '실제 로그 파일에서 색을 잃은 땅 경험의 정수 획득이 2개여야 합니다.');
    assert.ok(fileArchitectEntries > 0, '실제 로그 파일에서 설계자의 채굴장(하급 조합 조각)이 감지되어야 합니다.');
  }

  // ── 과거 채팅 히스토리 분류 및 색상 보정 회귀 검증 ──
  const { classifyHistoryMessage } = require(
    path.join(projectRoot, 'dist/modules/chatLogManager.js'),
  ) as {
    classifyHistoryMessage(color: string, message: string): {
      category: string;
      type: string;
      sender: string;
      message: string;
      color: string;
    };
  };

  // 1. 클럽 채팅에서 "시드" 단어가 포함되어 있어도 클럽 채널 및 색상이 유지되어야 함
  const clubChatResult = classifyHistoryMessage(
    '#94ddfa',
    '니요 : 근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?',
  );
  assert.deepEqual(clubChatResult, {
    category: 'Club',
    type: 'club',
    sender: '니요',
    message: '근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?',
    color: '#94ddfa',
  });

  // 2. 일반 채팅에서 "시드" 단어가 포함되어 있어도 일반 채널 및 색상이 유지되어야 함
  const generalChatResult = classifyHistoryMessage(
    '#ffffff',
    '홍길동 : 시드 얼마 있어?',
  );
  assert.deepEqual(generalChatResult, {
    category: 'General',
    type: 'general',
    sender: '홍길동',
    message: '시드 얼마 있어?',
    color: '#ffffff',
  });

  // 3. 실제 SEED 획득 시스템 메시지는 시스템 채널로 분류되고 시스템 색상으로 보정되어야 함
  const seedGainResult = classifyHistoryMessage(
    '#ffffff',
    '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.',
  );
  assert.deepEqual(seedGainResult, {
    category: 'System',
    type: 'system',
    sender: '시스템',
    message: '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.',
    color: '#a8a8a8',
  });

  // 4. 실제 아이템 획득 시스템 메시지는 노란색(#ffd700) 시스템 채널로 분류되어야 함
  const itemGainResult = classifyHistoryMessage(
    '#ffffff',
    '[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.',
  );
  assert.deepEqual(itemGainResult, {
    category: 'System',
    type: 'system',
    sender: '시스템',
    message: '[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.',
    color: '#ffd700',
  });
}

function checkTodaySummary(): void {
  const { resolveLootCount } = require(
    path.join(projectRoot, 'dist/renderer/diary/log-utils.js'),
  ) as { resolveLootCount(content: string, storedAmount: unknown): number };
  assert.equal(resolveLootCount('[득템] 경험의 정수', 2), 2);
  assert.equal(resolveLootCount('[득템] 경험의 정수 3개', 0), 3);
  assert.equal(resolveLootCount('[득템] 경험의 정수', 0), 1);

  const { buildTodaySummary, getLocalDateKey } = require(
    path.join(projectRoot, 'dist/modules/todaySummary.js'),
  ) as {
    buildTodaySummary(config: any, diaryData: any, date: string): any;
    getLocalDateKey(date: Date): string;
  };
  assert.equal(getLocalDateKey(new Date(2026, 7, 15, 0, 0, 0)), '2026-08-15');

  const makeHomework = (id: string, name: string, state: Record<string, unknown>, isVisible = true) => ({
    id, name, category: '레이드', isVisible,
    resetRule: { type: 'weekly' }, maxCount: 7,
    completedState: { selected: state },
  });
  const config = {
    characterPresets: [{ id: 'other', name: '부캐' }, { id: 'selected', name: '본캐' }],
    selectedCharacterId: 'selected',
    contentsCheckerItems: [
      makeHomework('done', '완료 숙제', { isCompleted: true, currentCount: 7 }),
      makeHomework('one', '남은 숙제 1', { isCompleted: false, currentCount: 2 }),
      makeHomework('two', '남은 숙제 2', { isCompleted: false }),
      makeHomework('excluded', '제외 숙제', { isCompleted: false, isExcluded: true }),
      makeHomework('hidden', '숨김 숙제', { isCompleted: false }, false),
    ],
  };
  const summary = buildTodaySummary(config, {
    diary: null,
    homeworkLogs: [],
    activityLogs: [
      { type: 'calc', amount: 12_000_000, content: '[자동] SEED', time: '10:00:00' },
      { type: 'elso', amount: 3500, content: '엘소 포인트 획득', time: '10:01:00' },
      { type: 'boss', amount: 0, content: '[보스 처치] 테스트', time: '10:02:00' },
      { type: 'loot', amount: 2, content: '[득템] [장비 강화석]을(를) [2]개 획득하였습니다.', time: '10:03:00' },
      { type: 'loot', amount: 1, content: '[득템] 펫이 [장비 강화석]을(를) 주웠습니다.', time: '10:04:00' },
      { type: 'loot', amount: 2, content: '[득템] 경험의 정수', time: '10:05:00' },
      { type: 'loot', amount: 1, content: '[득템] 경험의\u200B 정수', time: '10:06:00' },
    ],
  }, '2026-08-15');

  assert.equal(summary.totalSeed, 12_000_000);
  assert.equal(summary.totalElso, 3500);
  assert.equal(summary.totalEssence, 3);
  assert.equal(summary.bossKills, 1);
  assert.equal(summary.totalLootCount, 6);
  assert.deepEqual(summary.lootItems, [
    { name: '경험의 정수', count: 3 },
    { name: '장비 강화석', count: 3 },
  ]);
  assert.deepEqual(summary.homework, {
    characterName: '본캐',
    completedCount: 1,
    totalCount: 3,
    remainingCount: 2,
    remainingItems: [
      { name: '남은 숙제 1', category: '레이드', type: 'weekly', currentCount: 2, maxCount: 7 },
      { name: '남은 숙제 2', category: '레이드', type: 'weekly', currentCount: 0, maxCount: 7 },
    ],
  });

  assert.match(read('src/modules/chatLogProcessor.ts'),
    /isAlwaysTrackedItem = data\.itemName === '경험의 정수'[\s\S]*?if \(data\.isOwn && \(matchedKeyword \|\| isAlwaysTrackedItem\)\)/,
    '경험의 정수가 사용자 득템 키워드와 관계없이 기록되지 않습니다.');
  assert.match(read('src/modules/chatLogProcessor.ts'), /data\.isOwn/,
    '타인의 획득 알림이 모험일지에 기록될 수 있습니다.');
  assert.match(read('src/modules/chatLogProcessor.ts'),
    /isAlwaysTrackedItem[\s\S]*?formatLootDiaryContent\(data\.itemName\)[\s\S]*?: `\[득템\] \$\{data\.message\}`/,
    '경험의 정수 외 아이템까지 저장 형식이 변경될 수 있습니다.');
  assert.match(read('src/modules/diaryDb.ts'),
    /normalizeExistingLootContent\(\)[\s\S]*?if \(!condensed\.includes\('경험의정수'\)\) continue/,
    '기존 비정규 득템 기록을 정리하는 마이그레이션이 누락되었습니다.');
  assert.match(read('src/modules/diaryDb.ts'),
    /lootList\.push\(\{ date: log\.date, content: log\.content, amount: log\.amount \|\| 1 \}\)/,
    '월간 득템 상세 목록에서 실제 수량이 누락될 수 있습니다.');
  const diaryPage = read('src/diary.html');
  assert.match(diaryPage, /parseLootItem\(item\.content, item\.amount\)/,
    '월간 득템 목록이 별도 수량 필드를 사용하지 않습니다.');
  assert.match(diaryPage, /formatTimelineLogContent\(log\)/,
    '모험일지 타임라인에서 별도 수량 필드가 표시되지 않습니다.');
  assert.doesNotMatch(read('src/modules/xpTracker.ts'), /ESSENCE_GAINED/,
    '경험의 정수 전용 감지가 공통 아이템 감지와 중복 실행될 수 있습니다.');
  assert.match(read('src/game-overlay.html'), /id="today-summary-hud"/);
  assert.doesNotMatch(read('src/game-overlay.html'), /id="today-summary-toggle"/,
    '오늘 요약 HUD 타이틀에 클릭 영역이 남아 있습니다.');
  assert.match(read('src/game-overlay.html'), /renderer\/game-overlay\/today-summary\.js/);
  assert.match(read('src/modules/ipcHandlers.ts'), /ipcMain\.handle\('today-summary-get'/);
  assert.match(read('src/renderer/game-overlay/today-summary.ts'), /new MutationObserver\(positionSummary\)/,
    '활성 HUD와 오늘 요약의 겹침을 다시 계산하지 않습니다.');
  const settings = read('src/settings.html');
  assert.match(settings, /id="today-summary-hud-settings-card"/);
  assert.match(settings, /id="today-summary-show-input"/);
  assert.match(settings, /id="today-summary-collapsed-input"/);
  assert.match(settings, /id="today-summary-pos-left"/);
  assert.match(settings, /id="today-summary-pos-top"/);
  assert.match(settings, /id="shortcut-toggleTodaySummaryHud"/);
  const shortcutManager = read('src/modules/shortcutManager.ts');
  assert.match(shortcutManager,
    /showTodaySummaryHud === false[\s\S]*?showTodaySummaryHud:\s*true,\s*todaySummaryCollapsed:\s*true/,
    '숨겨진 오늘 요약 HUD가 접힌 상태로 다시 표시되지 않습니다.');
  assert.match(shortcutManager,
    /todaySummaryCollapsed \?\? true[\s\S]*?todaySummaryCollapsed:\s*false[\s\S]*?showTodaySummaryHud:\s*false/,
    '오늘 요약 HUD가 접힘 → 펼침 → 숨김 순서로 순환하지 않습니다.');
  assert.match(read('src/modules/constants.ts'), /toggleTodaySummaryHud:\s*'CommandOrControl\+Shift\+Y'/);
  assert.doesNotMatch(settings, /shortcut-toggleTodaySummaryCollapsed/);
  assert.match(read('src/modules/constants.ts'), /todaySummaryCollapsed:\s*true/);
  assert.match(read('src/modules/windowManager.ts'), /gameOverlayWindow\.setIgnoreMouseEvents\(true\)/);
  assert.match(read('src/preload.ts'), /onTodaySummaryConfig:[\s\S]*?today-summary-config/);
  assert.match(read('src/modules/windowManager.ts'), /webContents\.send\('today-summary-config', updated\)/);
  assert.match(read('src/renderer/game-overlay/today-summary.ts'), /api\.onTodaySummaryConfig\(config =>/);
  assert.match(read('src/modules/config.ts'), /todaySummaryHudPos[\s\S]*?top/);
}

function checkHuntingExpCalculator(): void {
  const calculator = require(path.join(projectRoot, 'dist/shared/huntingExpCalculator.js')) as {
    EXPERIENCE_ESSENCE_XP: number;
    DEFAULT_DOPINGS: Array<{ id: string; name: string; percent: number; duration: string; enabled: boolean }>;
    DEFAULT_GROUNDS: Array<{ id: string; name: string; baseXp: number }>;
    calculate(input: {
      dopings: Array<{ percent: number; enabled: boolean }>;
      baseXp: number;
      killsPerHour: number;
      happyHour: boolean;
    }): { appliedPercent: number; experiencePerKill: number; experiencePerHour: number; experienceEssencePerHour: number };
  };
  assert.equal(calculator.EXPERIENCE_ESSENCE_XP, 10_000_000_000);
  const result = calculator.calculate({
    dopings: calculator.DEFAULT_DOPINGS,
    baseXp: 200_000,
    killsPerHour: 40_000,
    happyHour: true,
  });
  assert.deepEqual(result, {
    appliedPercent: 4825,
    experiencePerKill: 14_775_000,
    experiencePerHour: 591_000_000_000,
    experienceEssencePerHour: 59.1,
  });
  assert.deepEqual(calculator.calculate({
    dopings: calculator.DEFAULT_DOPINGS,
    baseXp: 200_000,
    killsPerHour: 40_000,
    happyHour: false,
  }), {
    appliedPercent: 4825,
    experiencePerKill: 9_850_000,
    experiencePerHour: 394_000_000_000,
    experienceEssencePerHour: 39.4,
  });
  assert.deepEqual(calculator.DEFAULT_GROUNDS, [
    { id: 'forge', name: '대장간', baseXp: 200_000 },
    { id: 'golgotha', name: '골고다', baseXp: 720_000 },
    { id: 'void', name: '공허', baseXp: 980_000 },
  ]);
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'exp-heart')?.duration, '20분');
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'supreme-eos')?.percent, 500);
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'earlybird-exp')?.percent, 300);
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'stray-cat-1-exp')?.percent, 30);

  const buffs = JSON.parse(read('src/assets/data/buffs.json')) as Array<{
    id: string; category: string; effect: string; duration: string; description: string; effects?: { exp?: number; rare?: number };
  }>;
  assert.equal(buffs.find(item => item.id === 'exp_heart')?.duration, '20분');
  assert.equal(buffs.find(item => item.id === 'exp_eos_supreme')?.effects?.exp, 500);
  assert.equal(buffs.find(item => item.id === 'exp_earlybird')?.effects?.exp, 300);
  assert.equal(buffs.find(item => item.id === 'exp_stamp')?.description.includes('500개'), true);
  assert.equal(buffs.find(item => item.id === 'exp_club_e2')?.effects?.exp, 200);
  assert.deepEqual(buffs.find(item => item.id === 'rare_lucky')?.effects, { rare: 30 });

  const html = read('src/hunting-exp-calculator.html');
  const renderer = read('src/renderer/hunting-exp-calculator.ts');
  assert.match(html, /id="doping-list"/);
  assert.match(html, /id="ground-select"/);
  assert.match(html, /id="happy-hour-input"/);
  assert.match(html, /id="essence-per-hour"/);
  assert.match(html, /assets\/img\/경험의정수\.png/);
  assert.match(renderer, /assets\/img\/buffs\/경험의심장\.png/);
  assert.match(html, /shared\/huntingExpCalculator\.js/);
  assert.match(html, /renderer\/hunting-exp-calculator\.js/);
  assert.doesNotMatch(renderer, /innerHTML\s*=/,
    '사용자 도핑 또는 사냥터 이름이 innerHTML로 렌더링될 수 있습니다.');
  assert.match(renderer, /huntingExpDopings:\s*cloneDopings\(dopings\)/,
    '사용자 도핑 목록이 설정에 저장되지 않습니다.');
  assert.match(renderer, /huntingExpGrounds:\s*cloneGrounds\(grounds\)/,
    '사용자 사냥터 목록이 설정에 저장되지 않습니다.');

  const menuData = JSON.parse(read('src/assets/data/sidebar_menus.json')) as Array<{ id: string; api?: string; category?: string }>;
  assert.deepEqual(
    menuData.find(item => item.id === 'hunting-exp-calculator-btn'),
    {
      id: 'hunting-exp-calculator-btn', label: '사냥 경험치 계산기', icon: 'chart-no-axes-combined',
      tooltip: '사냥 도핑 및 예상 경험치 계산기', color: 'teal-400',
      api: 'toggleHuntingExpCalculator', category: 'calculators',
    },
  );
  assert.match(read('src/modules/ipcHandlers.ts'), /toggle-hunting-exp-calculator/);
  assert.match(read('src/preload.ts'), /toggleHuntingExpCalculator/);
  assert.match(read('src/modules/windowManager.ts'), /toggleHuntingExpCalculatorWindow/);
}

function checkRelicCalculator(): void {
  const calculator = require(path.join(projectRoot, 'dist/shared/relicCalculator.js')) as {
    RELIC_STAGES: Array<{ label: string }>;
    getEnhanceProbability(stage: number, difficulty: number): number;
    calculateExpectation(input: Record<string, unknown>): { attempts: number; seedMan: number; materials: Record<string, number>; evolutionMaterials: Record<string, number>; evolutions: number } | null;
    runSimulation(input: Record<string, unknown>, random: () => number): { attempts: number; seedMan: number; materials: Record<string, number>; evolutionMaterials: Record<string, number>; evolutions: number } | null;
  };
  assert.equal(calculator.RELIC_STAGES.length, 20);
  assert.equal(calculator.RELIC_STAGES[0].label, '신조의 렐릭 1강');
  assert.equal(calculator.RELIC_STAGES[19].label, '루나리아 렐릭 10강');
  assert.equal(calculator.getEnhanceProbability(0, 1), 0.2);
  assert.equal(calculator.getEnhanceProbability(0, 20), 0.54);
  assert.equal(calculator.getEnhanceProbability(2, 1), 0.1);
  assert.equal(calculator.getEnhanceProbability(3, 2), 0);
  assert.equal(calculator.getEnhanceProbability(19, 20), 0.2);
  const input = { side: 'right', currentStageIndex: 19, targetStageIndex: 19, difficulty: 20, currentStatTotal: 995 };
  assert.deepEqual(calculator.calculateExpectation(input), {
    attempts: 25, successes: 5, seedMan: 61250, materials: { '달의 파편': 750 }, evolutionMaterials: {}, evolutions: 0,
  });
  assert.deepEqual(calculator.runSimulation(input, () => 0), {
    attempts: 5, successes: 5, seedMan: 12250, materials: { '달의 파편': 150 }, evolutionMaterials: {}, evolutions: 0,
  });
  const evolution = calculator.calculateExpectation({ side: 'right', currentStageIndex: 9, targetStageIndex: 10, difficulty: 20, currentStatTotal: 500 });
  assert.equal(evolution?.evolutions, 1);
  assert.deepEqual(evolution?.evolutionMaterials, { '신조의 정수': 54 });
  assert.ok(Math.abs((evolution?.attempts || 0) - (50 / 0.34)) < 1e-9);
  assert.ok(Math.abs((evolution?.seedMan || 0) - (30000 + ((50 / 0.34) * 2000))) < 1e-6);
  const html = read('src/relic-calculator.html');
  const renderer = read('src/relic-calculator-renderer.ts');
  assert.match(html, /data-tab="simulation"/);
  assert.match(html, /data-tab="expectation"/);
  assert.match(html, /id="stat-inputs"/);
  assert.match(html, /펜던트 \(렐릭 오른쪽\)[\s\S]*?브라이슬릿 \(렐릭 왼쪽\)/,
    '렐릭 장비 종류가 게임 내 명칭으로 표시되지 않습니다.');
  assert.match(html, /shared\/relicCalculator\.js/);
  assert.match(renderer, /Math\.round\(seedMan \* 10_000\)/,
    'TSV의 만 단위 강화 비용을 실제 SEED로 환산하지 않습니다.');
  assert.match(renderer, /찌르기 공격력[\s\S]*?베기 공격력[\s\S]*?마법 공격력[\s\S]*?명중률 보정[\s\S]*?크리티컬/,
    '오른쪽 렐릭의 상세 능력치 입력이 없습니다.');
  assert.match(renderer, /물리 방어력[\s\S]*?마법 방어력[\s\S]*?회피율 보정[\s\S]*?민첩성 보정/,
    '왼쪽 렐릭의 상세 능력치 입력이 없습니다.');
  const menus = JSON.parse(read('src/assets/data/sidebar_menus.json')) as Array<{ id: string; api?: string; category?: string }>;
  assert.deepEqual(menus.find(item => item.id === 'relic-calculator-btn'), {
    id: 'relic-calculator-btn', label: '렐릭 강화', icon: 'gem', tooltip: '렐릭 강화 시뮬레이션 및 기댓값 조회',
    color: 'indigo-400', api: 'toggleRelicCalculator', category: 'calculators',
  });
  assert.match(read('src/modules/ipcHandlers.ts'), /toggle-relic-calculator/);
  assert.match(read('src/preload.ts'), /toggleRelicCalculator/);
  assert.match(read('src/modules/windowManager.ts'), /toggleRelicCalculatorWindow/);
}

function checkEquipmentSimulator(): void {
  const sim = require(path.join(projectRoot, 'dist/shared/equipmentSimulator.js')) as {
    ENHANCE_RATES: readonly any[];
    FIXED_ENCHANT_SCROLL_PRESETS: readonly any[];
    INCRYPT_SCROLLS: Record<string, any>;
    calculateEnhanceExpectation: (opts: any) => any;
    calculateEnchantExpectation: (opts: any) => any;
    calculateIncryptExpectation: (opts: any, target: number) => any;
  };
  assert.equal(sim.ENHANCE_RATES.length, 20);
  assert.equal(sim.ENHANCE_RATES[0].baseSuccessRate, 1.0);
  assert.equal(sim.ENHANCE_RATES[6].baseSuccessRate, 0.07);
  assert.equal(sim.ENHANCE_RATES[7].penaltyType, 'minus1');
  assert.ok(sim.FIXED_ENCHANT_SCROLL_PRESETS.length >= 10);
  assert.equal(sim.INCRYPT_SCROLLS.lord.successRate, 0.21);
  assert.equal(sim.INCRYPT_SCROLLS.royal.successRate, 0.36);

  const enhanceExp = sim.calculateEnhanceExpectation({ startStage: 0, targetStage: 2, luckyStoneCount: 0, talismanCount: 0, costPerStage: [1000, 2000] });
  assert.equal(enhanceExp.expectedAttempts, 1 + 1 / 0.7);
  assert.equal(enhanceExp.stageStats[0].stepExpectedAttempts, 1);
  assert.equal(enhanceExp.stageStats[0].stepFeeCost, 1000);
  assert.equal(enhanceExp.stageStats[1].stepFeeCost, (1 / 0.7) * 2000);
  assert.equal(enhanceExp.stageStats[0].cumulativeAttempts, 1);
  assert.ok(enhanceExp.stageStats[1].stepExpectedAttempts > 1);

  const enchantExp = sim.calculateEnchantExpectation({ statType: 'stab', enhanceScrollCount: 5 });
  assert.ok(enchantExp.expectedAttemptsPerSuccess > 0);
  assert.ok(enchantExp.expectedStatGainPerSuccess >= 4);

  // [+8] 축복치 없음 고정 주문서 (2% 확률, 축복치 0% -> 기댓값 50회)
  const noBlessExp = sim.calculateEnchantExpectation({ statType: 'stab', enhanceScrollCount: 0, baseSuccessRate: 0.02, blessingGainOnFail: 0.0, fixedStatGain: 8 });
  assert.equal(noBlessExp.expectedAttemptsPerSuccess, 50);
  assert.equal(noBlessExp.expectedStatGainPerSuccess, 8);

  const incryptExp = sim.calculateIncryptExpectation({ scrollType: 'lord', protectionScrollCount: 60 }, 1);
  assert.ok(incryptExp.expectedAttemptsPerSuccess > 0);

  const html = read('src/equipment-simulator.html');
  const renderer = read('src/renderer/equipment-simulator.ts');
  assert.match(html, /data-main-tab="enhance"/);
  assert.match(html, /data-main-tab="enchant"/);
  assert.match(html, /data-main-tab="incrypt"/);
  assert.match(html, /id="enchant-preset-select"/);
  assert.match(html, /shared\/equipmentSimulator\.js/);
  assert.match(html, /renderer\/equipment-simulator\.js/);

  const menus = JSON.parse(read('src/assets/data/sidebar_menus.json')) as Array<{ id: string; api?: string; category?: string }>;
  assert.ok(menus.find(item => item.id === 'equipment-simulator-btn'));
  assert.match(read('src/modules/ipcHandlers.ts'), /toggle-equipment-simulator/);
  assert.match(read('src/preload.ts'), /toggleEquipmentSimulator/);
  assert.match(read('src/modules/windowManager.ts'), /toggleEquipmentSimulatorWindow/);
}

function checkResponsiveDockFlyouts(): void {
  const dock = read('src/dock.html');
  assert.match(dock, /\.dock-flyout-submenu\s*\{[\s\S]*?max-width:\s*calc\(100vw - 24px\)/,
    '독 펼침 메뉴의 최대 너비가 독 창 영역으로 제한되지 않습니다.');
  assert.match(dock, /\.dock-flyout-submenu\s*\{[\s\S]*?flex-wrap:\s*wrap/,
    '독 펼침 메뉴가 공간 부족 시 여러 줄로 배치되지 않습니다.');
  assert.match(dock, /function fitFlyoutToViewport\(flyout\)[\s\S]*?getBoundingClientRect\(\)[\s\S]*?--dock-flyout-shift/,
    '독 펼침 메뉴의 좌우 경계 보정이 없습니다.');
  assert.match(dock, /catItem\.addEventListener\('mouseenter', \(\) => fitFlyoutToViewport\(flyout\)\)/,
    '독 펼침 메뉴를 열 때 경계 보정이 실행되지 않습니다.');
}

function checkUpdateNoticeFeature(): void {
  const noticePath = path.join(projectRoot, 'src', 'assets', 'notice', 'notice.json');
  assert.ok(fs.existsSync(noticePath), 'src/assets/notice/notice.json 파일이 존재하지 않습니다.');
  const noticeData = JSON.parse(fs.readFileSync(noticePath, 'utf-8'));
  assert.ok(typeof noticeData.version === 'string' && noticeData.version.length > 0, 'notice.json에 유효한 version이 없습니다.');
  assert.ok(typeof noticeData.title === 'string' && noticeData.title.length > 0, 'notice.json에 유효한 title이 없습니다.');
  assert.ok(Array.isArray(noticeData.sections) && noticeData.sections.length > 0, 'notice.json에 유효한 sections가 없습니다.');

  const updateNoticeHtml = read('src/update-notice.html');
  assert.match(updateNoticeHtml, /getUpdateNoticeData/, 'update-notice.html에서 공지 데이터를 조회하는 코드가 없습니다.');
  assert.match(updateNoticeHtml, /updateNoticeClose/, 'update-notice.html에서 닫기 이벤트 핸들러가 연결되지 않았습니다.');
  assert.match(updateNoticeHtml, /confirm-btn/, 'update-notice.html에 확인 버튼이 없습니다.');

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(ipcHandlers, /get-update-notice-data/, 'ipcHandlers에 get-update-notice-data 채널이 없습니다.');
  assert.match(ipcHandlers, /update-notice-close/, 'ipcHandlers에 update-notice-close 채널이 없습니다.');
  assert.match(ipcHandlers, /update-notice-open/, 'ipcHandlers에 update-notice-open 채널이 없습니다.');

  const preload = read('src/preload.ts');
  assert.match(preload, /getUpdateNoticeData/, 'preload에 getUpdateNoticeData API가 없습니다.');
  assert.match(preload, /updateNoticeClose/, 'preload에 updateNoticeClose API가 없습니다.');
  assert.match(preload, /updateNoticeOpen/, 'preload에 updateNoticeOpen API가 없습니다.');

  const settings = read('src/settings.html');
  assert.match(settings, /openUpdateNotice\(\)/, 'settings.html에 공지 열기 버튼 함수가 없습니다.');

  const workflow = read('.agents/release_workflow.md');
  assert.match(workflow, /src\/assets\/notice\/notice\.json/, 'release_workflow.md에 공지 갱신 절차가 누락되었습니다.');
}

checkCommonFormatters();
checkAnalyticsProtocol();
checkDevtoolsInitializationIsIdempotent();
checkInlineScriptSyntax();
checkPageScriptNamespaceCollisions();
checkHtmlScriptResourcesAndHandlers();
function checkChatLogSyncManagerContracts() {
  const { getRecentMonday } = require('../dist/modules/chatLogSyncManager');
  const diaryDb = require('../dist/modules/diaryDb');

  // 1. 월요일 날짜 계산 검증
  // 2026-08-16은 일요일 -> 2026-08-10(월)
  const sunday = new Date(2026, 7, 16, 15, 30, 0);
  const monFromSun = getRecentMonday(sunday);
  assert.equal(monFromSun.getFullYear(), 2026);
  assert.equal(monFromSun.getMonth(), 7);
  assert.equal(monFromSun.getDate(), 10);
  assert.equal(monFromSun.getHours(), 0);

  // 2026-08-17은 월요일 -> 2026-08-17(월)
  const monday = new Date(2026, 7, 17, 10, 0, 0);
  const monFromMon = getRecentMonday(monday);
  assert.equal(monFromMon.getDate(), 17);

  // 2026-08-19는 수요일 -> 2026-08-17(월)
  const wednesday = new Date(2026, 7, 19, 23, 59, 0);
  const monFromWed = getRecentMonday(wednesday);
  assert.equal(monFromWed.getDate(), 17);

  // 2. diaryDb 중복 방지 멱등성 검증
  try {
    diaryDb.initDb();
    const testDate = '2099-12-31';
    const testTime = '23:59:59';
    const testContent = '[득템] 테스트 동기화 아이템 획득';

    const firstAdd = diaryDb.addActivityLogIfAbsent(testDate, testTime, 'loot', testContent, 1, false);
    assert.equal(firstAdd, true, '최초 활동 기록 추가는 true여야 합니다.');

    const secondAdd = diaryDb.addActivityLogIfAbsent(testDate, testTime, 'loot', testContent, 1, false);
    assert.equal(secondAdd, false, '중복 활동 기록 추가는 false(스킵)여야 합니다.');

    const exists = diaryDb.hasActivityLog(testDate, testTime, testContent);
    assert.equal(exists, true, 'hasActivityLog가 true를 반환해야 합니다.');

    // 테스트 후 데이터 정리 및 DB 파일 닫기
    diaryDb.removeActivityLog(testDate, 'loot', testContent);
    if (typeof diaryDb.closeDb === 'function') {
      diaryDb.closeDb();
    }
  } finally {
    const rootDbPath = path.join(projectRoot, 'diary.db');
    if (fs.existsSync(rootDbPath)) {
      try {
        fs.unlinkSync(rootDbPath);
      } catch {
        // 파일 잠금 등으로 즉시 삭제되지 않을 경우 무시
      }
    }
  }
}

checkRendererResources();
checkCoefficientCalculatorVisibilityContract();
checkHuntingPathArrowSizing();
checkContentsChecklistOrdering();
checkWindowRestoreAndSettingsNavigationContracts();
checkDependencyOverrideContracts();
checkSidebarMenuRegistryContracts();
checkWindowFocusControllerContracts();
checkEmbeddedWebWindowContracts();
checkFocusedChatContracts();
checkLifecycleAndIpcSafetyContracts();
checkExtractedPureModules();
checkCoreInternalTypesStayStrict();
checkLegacyContentsOrderingRemoved();
checkSharedUiDependencies();
checkSharedConstants();
checkPreloadDefaultConfigCompatibility();
checkRequestedFeatureContracts();
checkRequestedChatSamples();
checkChatLogNormalizationAndItemAcquisition();
checkTodaySummary();
checkHuntingExpCalculator();
checkRelicCalculator();
checkEquipmentSimulator();
checkNoAuthoredJavaScriptSources();
checkAgentDocumentationLocations();
checkBuffTimerChatTriggers();
checkResponsiveDockFlyouts();
checkUpdateNoticeFeature();
checkChatLogSyncManagerContracts();
checkPhaseOneSafetyContracts();

function checkDiscordNotifierContracts(): void {
  const { discordNotifier } = require('../dist/modules/discordNotifier');
  assert.ok(discordNotifier && typeof discordNotifier.sendWord === 'function', 'discordNotifier.sendWord 함수가 누락되었습니다.');
  assert.ok(typeof discordNotifier.sendTest === 'function', 'discordNotifier.sendTest 함수가 누락되었습니다.');
}

function checkBossNotifierContracts(): void {
  const bossNotifier = require('../dist/modules/bossNotifier');
  assert.ok(bossNotifier && typeof bossNotifier.start === 'function', 'bossNotifier.start 함수가 누락되었습니다.');
  assert.ok(typeof bossNotifier.stop === 'function', 'bossNotifier.stop 함수가 누락되었습니다.');
  assert.ok(Array.isArray(bossNotifier.BOSS_SCHEDULE), 'bossNotifier.BOSS_SCHEDULE 배열이 누락되었습니다.');
}

function checkBackendServiceContracts(): void {
  const backupManager = require('../dist/modules/backupManager');
  assert.ok(typeof backupManager.exportBackup === 'function', 'backupManager.exportBackup 함수가 누락되었습니다.');
  assert.ok(typeof backupManager.importBackup === 'function', 'backupManager.importBackup 함수가 누락되었습니다.');

  const shortcutManager = require('../dist/modules/shortcutManager');
  assert.ok(typeof shortcutManager.registerAll === 'function', 'shortcutManager.registerAll 함수가 누락되었습니다.');
  assert.ok(typeof shortcutManager.unregisterAll === 'function', 'shortcutManager.unregisterAll 함수가 누락되었습니다.');

  const customNotifier = require('../dist/modules/customNotifier');
  assert.ok(typeof customNotifier.start === 'function', 'customNotifier.start 함수가 누락되었습니다.');
  assert.ok(typeof customNotifier.stop === 'function', 'customNotifier.stop 함수가 누락되었습니다.');

  const noticeManager = require('../dist/modules/noticeManager');
  assert.ok(typeof noticeManager.getNoticeData === 'function', 'noticeManager.getNoticeData 함수가 누락되었습니다.');
  assert.ok(typeof noticeManager.shouldShowUpdateNotice === 'function', 'noticeManager.shouldShowUpdateNotice 함수가 누락되었습니다.');
}

function checkIpcChannelContracts(): void {
  const preloadSource = fs.readFileSync(path.join(projectRoot, 'src', 'preload.ts'), 'utf8');
  
  // src/ 및 src/modules/ 내의 모든 .ts 파일 소스를 통합
  const mainDir = path.join(projectRoot, 'src');
  const modulesDir = path.join(projectRoot, 'src', 'modules');
  let combinedBackendSource = '';
  
  for (const file of fs.readdirSync(mainDir)) {
    if (file.endsWith('.ts')) combinedBackendSource += fs.readFileSync(path.join(mainDir, file), 'utf8') + '\n';
  }
  if (fs.existsSync(modulesDir)) {
    for (const file of fs.readdirSync(modulesDir)) {
      if (file.endsWith('.ts')) combinedBackendSource += fs.readFileSync(path.join(modulesDir, file), 'utf8') + '\n';
    }
  }

  // preload에서 호출하는 채널들 추출 (ipcRenderer.send, ipcRenderer.invoke, ipcRenderer.sendSync)
  const sendChannels = Array.from(preloadSource.matchAll(/ipcRenderer\.(?:send|invoke|sendSync)\(\s*['"]([^'"]+)['"]/g), m => m[1]);
  assert.ok(sendChannels.length > 30, 'preload에서 IPC 채널이 충분히 추출되지 않았습니다.');

  // 백엔드 모듈 및 main.ts에서 리스너가 존재하는지 확인
  for (const ch of sendChannels) {
    const hasHandler = combinedBackendSource.includes(`'${ch}'`) || combinedBackendSource.includes(`"${ch}"`);
    assert.ok(hasHandler, `Preload에서 호출하는 IPC 채널 '${ch}'의 핸들러가 메인/모듈에 등록되어 있지 않습니다.`);
  }
}

function checkRendererBundleCleanliness(): void {
  const assetsDir = path.join(projectRoot, 'dist', 'assets');
  if (fs.existsSync(assetsDir)) {
    const jsFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
    for (const file of jsFiles) {
      const content = fs.readFileSync(path.join(assetsDir, file), 'utf8');
      assert.ok(!content.includes('exports.__esModule'), `렌더러 에셋 번들 '${file}'에 CommonJS exports가 포함되어 있습니다.`);
    }
  }
}

function checkCorruptedConfigResilience(): void {
  const configModule = require('../dist/modules/config');
  const loaded = configModule.load();
  assert.ok(loaded && typeof loaded === 'object', '기본 설정 로드 시 유효한 객체가 반환되지 않았습니다.');
  assert.ok(loaded.shortcuts && typeof loaded.shortcuts === 'object', '설정 내 shortcuts 객체가 누락되었습니다.');
  const secondLoad = configModule.load();
  assert.notEqual(secondLoad, loaded, '설정 load 호출이 같은 최상위 객체를 노출합니다.');
  assert.notEqual(secondLoad.shortcuts, loaded.shortcuts, '설정 load 호출이 같은 중첩 객체를 노출합니다.');
}

function checkShoutSuffixStripping(): void {
  const { stripShoutSuffix } = require('../dist/shared/chatChannels');
  assert.equal(typeof stripShoutSuffix, 'function', 'stripShoutSuffix 함수가 누락되었습니다.');

  // 1. 단어 끝 Click, From 제거 검증
  assert.equal(stripShoutSuffix('오늘의 마지막 외치기!! 삼?급처템 Click'), '오늘의 마지막 외치기!! 삼?급처템');
  assert.equal(stripShoutSuffix('드레스업하복상자400억팜 From'), '드레스업하복상자400억팜');
  assert.equal(stripShoutSuffix('시벨린도 1등이있어요? 신기하네 from'), '시벨린도 1등이있어요? 신기하네');
  assert.equal(stripShoutSuffix('12강 이블테오 14강뻑삭 삽니다....1:1주세용 CLICK'), '12강 이블테오 14강뻑삭 삽니다....1:1주세용');
  assert.equal(stripShoutSuffix('아이템 팝니다 From Click'), '아이템 팝니다');

  // 2. 문구 중간/앞 단어 보존 검증 (절대 지워지지 않아야 함)
  assert.equal(stripShoutSuffix('From 서울 to 부산 Click 이벤트 From'), 'From 서울 to 부산 Click 이벤트');
  assert.equal(stripShoutSuffix('Click & Buy From Me Click'), 'Click & Buy From Me');
  assert.equal(stripShoutSuffix('클릭(Click) 해주세요 From Me'), '클릭(Click) 해주세요 From Me');
  assert.equal(stripShoutSuffix('일반 외치기 메시지입니다'), '일반 외치기 메시지입니다');

  // 3. chatParser 연동 검증
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js'));
  let receivedMessage = '';
  const shoutListener = (data: { sender: string; message: string }) => {
    receivedMessage = data.message;
  };
  chatParser.on('TRADE_SHOUT', shoutListener);

  chatParser.parseLine('<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#c896c8">외치기 : 베한계 이클리스트 500베 효과 삽니다 Click [소온]</font></br>');
  assert.equal(receivedMessage, '베한계 이클리스트 500베 효과 삽니다', '외치기 Click 접미사가 제거되지 않았습니다.');

  chatParser.parseLine('<font size="2" color="white"> [13시 34분 28초] </font> <font size="2" color="#c896c8">외치기 : From 서울 to 부산 Click 이벤트 From [유저1]</font></br>');
  assert.equal(receivedMessage, 'From 서울 to 부산 Click 이벤트', '중간 단어가 훼손되었거나 끝 접미사가 제거되지 않았습니다.');

  chatParser.off('TRADE_SHOUT', shoutListener);
}

function checkMandatoryUpdateLogic(): void {
  const updaterModule = require(path.join(projectRoot, 'dist', 'modules', 'updater.js')) as {
    hasMandatoryTag: (text: unknown) => boolean;
    findLatestMandatoryRelease: (info: any, currentVersion?: string) => { version: string; tag: string; note?: string } | null;
    checkMandatory: (info: any, currentVersion?: string) => boolean;
    formatReleaseNotes: (releaseNotes: any) => string | undefined;
    isBetaVersion: (version?: string) => boolean;
  };

  const { hasMandatoryTag, findLatestMandatoryRelease, checkMandatory, formatReleaseNotes, isBetaVersion } = updaterModule;

  // 1. 태그 판별 대소문자/공백 무시 검증
  assert.equal(hasMandatoryTag('[Mandatory Update]'), true);
  assert.equal(hasMandatoryTag('[mandatory update]'), true);
  assert.equal(hasMandatoryTag('[  MANDATORY   UPDATE  ]'), true);
  assert.equal(hasMandatoryTag('긴급 패치 [Mandatory Update] 안내'), true);
  assert.equal(hasMandatoryTag('일반 업데이트 버전'), false);
  assert.equal(hasMandatoryTag(null), false);
  assert.equal(hasMandatoryTag(undefined), false);

  // 2. 다중 릴리즈 시나리오 검증:
  // 사용자 v1 환경에서 배포 이력: v6(일반), v5(강제), v4(일반), v3(강제), v2(강제)
  // 최신 강제 버전인 v5가 선별되어야 함
  const multiReleaseInfoScenario = {
    version: '6.0.0',
    releaseName: 'v6.0.0 일반 업데이트',
    releaseNotes: [
      { version: '6.0.0', note: 'v6 일반 기능 추가 및 개선' },
      { version: '5.0.0', note: '<h2>[Mandatory Update] v5.0.0 긴급 보안 패치</h2>' },
      { version: '4.0.0', note: 'v4 일반 UI 업데이트' },
      { version: '3.0.0', note: '<h1>[Mandatory Update] v3.0.0 데이터 마이그레이션</h1>' },
      { version: '2.0.0', note: '[Mandatory Update] v2.0.0 릴리즈' }
    ]
  };

  const targetRelease = findLatestMandatoryRelease(multiReleaseInfoScenario, '1.0.0');
  assert.ok(targetRelease !== null, '다중 릴리즈 히스토리에서 강제 업데이트 타겟을 찾지 못했습니다.');
  assert.equal(targetRelease.version, '5.0.0', '상위 버전 중 가장 최신 강제 업데이트 버전인 v5가 선택되지 않았습니다.');
  assert.equal(targetRelease.tag, 'v5.0.0', '타겟 태그명이 올바르지 않습니다.');
  assert.equal(checkMandatory(multiReleaseInfoScenario, '1.0.0'), true);

  // 3. 상위 버전 중 강제 업데이트가 하나도 없는 시나리오: v3(일반), v2(일반)
  const noMandatoryInfoScenario = {
    version: '3.0.0',
    releaseName: 'v3.0.0 일반 릴리즈',
    releaseNotes: [
      { version: '3.0.0', note: 'v3 일반 기능 개선' },
      { version: '2.0.0', note: 'v2 일반 버그 수정' }
    ]
  };
  assert.equal(findLatestMandatoryRelease(noMandatoryInfoScenario, '1.0.0'), null, '강제 업데이트가 없는데 타겟이 반환되었습니다.');
  assert.equal(checkMandatory(noMandatoryInfoScenario, '1.0.0'), false);

  // 4. 단일 릴리즈 (문자열) 시나리오 검증
  const singleMandatoryTitle = {
    version: '2.6.7',
    releaseName: '[Mandatory Update] v2.6.7 긴급 배포',
    releaseNotes: '단일 릴리즈 노트 내용'
  };
  const singleTarget1 = findLatestMandatoryRelease(singleMandatoryTitle, '2.6.0');
  assert.ok(singleTarget1 !== null);
  assert.equal(singleTarget1.version, '2.6.7');
  assert.equal(singleTarget1.tag, 'v2.6.7');

  const singleMandatoryBody = {
    version: '2.6.7',
    releaseName: 'v2.6.7 긴급 배포',
    releaseNotes: '<h1>[Mandatory Update]</h1> 버그 수정'
  };
  const singleTarget2 = findLatestMandatoryRelease(singleMandatoryBody, '2.6.0');
  assert.ok(singleTarget2 !== null);
  assert.equal(singleTarget2.version, '2.6.7');

  const singleRegular = {
    version: '2.6.8',
    releaseName: 'v2.6.8 일반 배포',
    releaseNotes: '일반 패치'
  };
  assert.equal(findLatestMandatoryRelease(singleRegular, '2.6.0'), null);
  assert.equal(checkMandatory(singleRegular, '2.6.0'), false);

  // 5. formatReleaseNotes 포매팅 검증
  const formatted = formatReleaseNotes(multiReleaseInfoScenario.releaseNotes);
  assert.ok(typeof formatted === 'string');
  assert.ok(formatted.includes('<h3>v6.0.0</h3>'));
  assert.ok(formatted.includes('<h3>v5.0.0</h3>'));
  assert.ok(formatted.includes('<hr class="border-white/10 my-3" />'));

  // 6. 베타 버전 판별 및 강제 업데이트 무시 검증
  assert.equal(isBetaVersion('2.7.0-beta.1'), true);
  assert.equal(isBetaVersion('2.7.0-beta'), true);
  assert.equal(isBetaVersion('2.7.0-rc.1'), true);
  assert.equal(isBetaVersion('2.7.0-alpha'), true);
  assert.equal(isBetaVersion('2.7.0-preview'), true);
  assert.equal(isBetaVersion('2.7.0'), false);
  assert.equal(isBetaVersion('2.6.8'), false);

  // 베타 버전 환경에서는 강제 릴리즈가 존재해도 null 반환 (강제 업데이트 무시)
  assert.equal(findLatestMandatoryRelease(multiReleaseInfoScenario, '2.7.0-beta.1'), null);
  assert.equal(checkMandatory(multiReleaseInfoScenario, '2.7.0-beta.1'), false);
  assert.equal(findLatestMandatoryRelease(singleMandatoryTitle, '2.7.0-beta.1'), null);
  assert.equal(checkMandatory(singleMandatoryTitle, '2.7.0-beta.1'), false);
}

function checkCustomTabHistoryContracts(): void {
  const { chatLogManager } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogManager.js'));
  assert.equal(typeof chatLogManager.resetLastReadIndex, 'function', 'chatLogManager.resetLastReadIndex가 누락되었습니다.');
  assert.equal(typeof chatLogManager.getMoreHistory, 'function', 'chatLogManager.getMoreHistory가 누락되었습니다.');

  // 커스텀 탭 ID로 리셋 및 더 불러오기 호출 시 예외 없이 동작하는지 검증
  assert.doesNotThrow(() => {
    chatLogManager.resetLastReadIndex('custom_123456789');
  }, '커스텀 탭 ID resetLastReadIndex 호출 시 예외가 발생했습니다.');
}

function checkGoogleSyncDataContracts(): void {
  const syncDataHelper = require(path.join(projectRoot, 'dist', 'modules', 'syncDataHelper.js'));

  // 1. extractSyncData: 동기화 대상 필드만 추출하고 로컬 전용 필드(positions, chatLogPath 등)는 제외
  const sampleLocalConfig = {
    userServer: 16,
    lootKeywords: ['샤를란', '엔키라'],
    positions: { overlay: { x: 100, y: 100, width: 400, height: 300 } },
    chatLogPath: 'C:\\Nexon\\TalesWeaver\\ChatLog',
    googleSyncLastTime: 123456789,
    googleSyncUserEmail: 'test@gmail.com',
    contentsCheckerItems: [
      {
        id: 'daily-abyss',
        name: '어비스 심층',
        category: '일일 숙제',
        isVisible: true,
        resetRule: { type: 'daily' },
        completedState: {
          'char-1': { isCompleted: true, lastCompletedAt: 1000 },
          'char-2': { isCompleted: false, lastCompletedAt: 500 }
        }
      }
    ],
    characterPresets: [
      { id: 'char-1', name: '보리스' },
      { id: 'char-2', name: '루시안' }
    ]
  };

  const extracted = syncDataHelper.extractSyncData(sampleLocalConfig);
  assert.equal(extracted.userServer, 16);
  assert.deepEqual(extracted.lootKeywords, ['샤를란', '엔키라']);
  assert.equal(extracted.positions, undefined, 'positions 필드가 동기화 데이터에 포함되었습니다.');
  assert.equal(extracted.chatLogPath, undefined, 'chatLogPath 필드가 동기화 데이터에 포함되었습니다.');

  // 2. buildSyncPayload: 메타데이터 및 스키마 검증
  const payload = syncDataHelper.buildSyncPayload(sampleLocalConfig, 'tester@gmail.com');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.updatedBy, 'tester@gmail.com');
  assert.ok(payload.lastSyncedAt > 0);
  assert.equal(payload.data.userServer, 16);

  // 3. mergeSyncData: 숙제 타임스탬프 기반 병합 및 설정 병합 검증
  const cloudPayload = {
    schemaVersion: 1,
    appVersion: '2.7.0',
    lastSyncedAt: 2000,
    updatedBy: 'tester@gmail.com',
    data: {
      userServer: 7, // 하이아칸으로 변경됨
      lootKeywords: ['샤를란', '엔키라', '아퀼루스'],
      contentsCheckerItems: [
        {
          id: 'daily-abyss',
          name: '어비스 심층',
          category: '일일 숙제',
          isVisible: true,
          resetRule: { type: 'daily' },
          completedState: {
            'char-1': { isCompleted: false, lastCompletedAt: 800 }, // 로컬(1000)이 더 최신이므로 로컬 유지되어야 함
            'char-2': { isCompleted: true, lastCompletedAt: 1500 }   // 클라우드(1500)가 더 최신이므로 클라우드 반영되어야 함
          }
        },
        {
          id: 'custom-homework-1',
          name: '신규 커스텀 숙제',
          category: '커스텀',
          isVisible: true,
          isCustom: true,
          resetRule: { type: 'weekly' },
          completedState: {}
        }
      ],
      characterPresets: [
        { id: 'char-1', name: '보리스(수정)' },
        { id: 'char-3', name: '티치엘' } // 신규 캐릭터 추가
      ]
    }
  };

  const merged = syncDataHelper.mergeSyncData(sampleLocalConfig, cloudPayload);

  // 일반 설정 병합 확인
  assert.equal(merged.userServer, 7);
  assert.deepEqual(merged.lootKeywords, ['샤를란', '엔키라', '아퀼루스']);
  // 로컬 전용 설정 유지 확인
  assert.equal(merged.chatLogPath, 'C:\\Nexon\\TalesWeaver\\ChatLog');
  assert.ok(merged.positions?.overlay);

  // 숙제 체크리스트 타임스탬프 기반 병합 검증
  const mergedAbyss = merged.contentsCheckerItems?.find((i: any) => i.id === 'daily-abyss');
  assert.ok(mergedAbyss);
  assert.equal(mergedAbyss.completedState['char-1'].isCompleted, true, '로컬의 최신 완료 기록(1000)이 보존되지 않았습니다.');
  assert.equal(mergedAbyss.completedState['char-1'].lastCompletedAt, 1000);
  assert.equal(mergedAbyss.completedState['char-2'].isCompleted, true, '클라우드의 최신 완료 기록(1500)이 반영되지 않았습니다.');
  assert.equal(mergedAbyss.completedState['char-2'].lastCompletedAt, 1500);

  // 클라우드의 신규 커스텀 숙제 추가 확인
  const customItem = merged.contentsCheckerItems?.find((i: any) => i.id === 'custom-homework-1');
  assert.ok(customItem, '클라우드의 신규 커스텀 숙제가 병합되지 않았습니다.');

  // 캐릭터 프리셋 병합 확인
  assert.equal(merged.characterPresets?.length, 3); // char-1, char-2, char-3
  assert.ok(merged.characterPresets?.some((c: any) => c.id === 'char-3'));
}

checkDiscordNotifierContracts();
checkBossNotifierContracts();
checkBackendServiceContracts();
checkIpcChannelContracts();
checkRendererBundleCleanliness();
checkCorruptedConfigResilience();
checkShoutSuffixStripping();
checkMandatoryUpdateLogic();
checkCustomTabHistoryContracts();
checkGoogleSyncDataContracts();

console.log('Refactor regression checks passed.');
process.exit(0);

