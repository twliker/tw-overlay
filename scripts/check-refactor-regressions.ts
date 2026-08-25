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

function checkWindowedFullscreenFocusContracts(): void {
  const manager = read('src/modules/windowManager.ts');
  const polling = read('src/modules/pollingLoop.ts');
  const tracker = read('src/modules/tracker.ts');
  const zOrderController = read('src/modules/zOrderController.ts');

  assert.match(polling, /const TRANSIENT_STATE_CONFIRM_SAMPLES = 2/,
    '순간적인 게임 창 탐지 실패를 재확인하는 방어가 없습니다.');
  assert.match(polling, /tracker\.reconcileGameZOrder\(currentRect\.gameHwnd, windowHwnds\)/,
    '폴링 Z-order 정책이 게임·TW-Overlay·실제 외부 창 포커스를 공통 판별하는 샌드위치 경계를 사용하지 않습니다.');
  assert.match(polling, /tracker\.releaseGameZOrder\(\);[\s\S]*?wm\.resetGameSessionState\(\)/,
    '게임 종료 시 동적 Topmost 상태를 해제하지 않습니다.');
  assert.match(polling, /tracker\.releaseGameZOrder\(\);[\s\S]*?wm\.hideAll\(\)/,
    '게임 최소화 시 동적 Topmost 상태를 해제하지 않습니다.');

  const focusStart = tracker.indexOf('export function focusGameWindow(): boolean');
  const focusEnd = tracker.indexOf('export function isGameOrAppForeground', focusStart);
  assert.ok(focusStart >= 0 && focusEnd > focusStart, '자동 게임 포커스 복구 함수를 찾지 못했습니다.');
  const focusGameWindow = tracker.slice(focusStart, focusEnd);
  assert.match(focusGameWindow, /win32\.IsIconic && win32\.IsIconic\(cachedHwnd\)/,
    '실제 최소화 여부를 확인하지 않고 게임 창 상태를 복원합니다.');
  assert.doesNotMatch(focusGameWindow, /BringWindowToTop|keybd_event/,
    '자동 포커스 복구가 강제 Z-order 변경 또는 Alt 키 입력을 사용합니다.');
  assert.match(tracker, /export function canAutomaticallyRestoreGameFocus\(\): boolean/,
    '외부 창 포커스를 보호하는 자동 복구 허용 검사가 없습니다.');
  assert.match(manager, /canScheduleRestore:[^\n]*tracker\.canAutomaticallyRestoreGameFocus\(\)/,
    '지연 포커스 복구 예약 시점에 외부 창 포커스를 확인하지 않습니다.');
  assert.match(manager, /canRestoreFocus:[^\n]*tracker\.canAutomaticallyRestoreGameFocus\(\)/,
    '지연 포커스 복구 실행 직전에 외부 창 포커스를 재확인하지 않습니다.');

  const sandwichStart = manager.indexOf('function bringGameAndOverlaysToTop(): void');
  const sandwichEnd = manager.indexOf('export const isAnyUserDragging', sandwichStart);
  assert.ok(sandwichStart >= 0 && sandwichEnd > sandwichStart, '샌드위치 Z-order 함수를 찾지 못했습니다.');
  const sandwichSource = manager.slice(sandwichStart, sandwichEnd);
  assert.match(sandwichSource, /tracker\.reconcileGameZOrder\(gameHwndStr, getAllWindowHwnds\(\)\)/,
    'TW-Overlay 포커스 시 오버레이를 게임 바로 위로 정렬하지 않습니다.');
  assert.doesNotMatch(sandwichSource, /placeGameBelowWindow|reconcileGameZOrder\([^\n]*true\)/,
    '샌드위치 정책이 게임 창 자체를 이동하거나 외부 포커스 보호를 우회합니다.');
  assert.doesNotMatch(tracker, /export function placeGameBelowWindow/,
    '샌드위치 정책 외부에서 게임 창 Z-order를 직접 이동하는 API가 남아 있습니다.');
  assert.match(tracker, /gameOverlayZOrderController\.reconcile\(/,
    'tracker가 포커스·위치 사건을 단일 Z-order 상태 관리자에 전달하지 않습니다.');
  assert.doesNotMatch(tracker, /SetWindowPos\(/,
    'tracker에 상태 관리자 밖의 직접 Z-order 쓰기가 남아 있습니다.');
  assert.match(zOrderController, /targetState === 'external-game-monitor'[\s\S]*?this\.native\.notTopmost[\s\S]*?externalIsTopmost \? this\.native\.top : foregroundHwnd[\s\S]*?placeWindowStack\(placementAnchor, groupHwnds\)/,
    '외부 프로그램 전경에서 게임 묶음을 강등하고 외부 창 아래로 배치하지 않습니다.');
  assert.match(zOrderController, /const externalIsTopmost = this\.native\.isTopmost\(foregroundHwnd\)/,
    '시작 메뉴·작업표시줄 Topmost HWND 뒤에 삽입해 게임 묶음을 다시 Topmost로 전염시킬 수 있습니다.');
  assert.match(zOrderController, /return rectsOverlap\(input\.foregroundRect, input\.gameRect\)[\s\S]*?'external-game-monitor'[\s\S]*?'external-other-monitor'/,
    '외부 창이 게임 화면과 실제로 겹칠 때만 게임 묶음을 강등하는 경계가 없습니다.');
  assert.match(zOrderController, /first\.left < second\.right[\s\S]*?first\.bottom > second\.top/,
    '듀얼 모니터 창 겹침 판정이 네 방향 경계를 모두 검사하지 않습니다.');
  assert.match(tracker, /SetWinEventHook\([\s\S]*?EVENT_OBJECT_LOCATIONCHANGE,[\s\S]*?EVENT_OBJECT_LOCATIONCHANGE/,
    '반대편 모니터의 전경 창 이동을 실시간 감지하는 위치 이벤트 훅이 없습니다.');
  assert.match(tracker, /event === win32\.EVENT_OBJECT_LOCATIONCHANGE[\s\S]*?safeHwnd === foregroundHwnd[\s\S]*?onForegroundChangeCallback/,
    '전경 외부 창의 모니터 진입을 폴링 전에 즉시 Z-order 재판정하지 않습니다.');
  assert.match(tracker, /if \(hLocationEventHook\)[\s\S]*?UnhookWinEvent\(hLocationEventHook\)/,
    '앱 종료 시 위치 이벤트 훅을 해제하지 않습니다.');
  assert.match(zOrderController, /isTaskbarAboveWindow\(groupHwnds\[0\], gameHwnd\)[\s\S]*?placeWindowStack\(this\.native\.topmost, groupHwnds\)/,
    '게임/TW-Overlay 전경에서 작업표시줄 위로 묶음을 복구하는 정책이 없습니다.');
  assert.match(zOrderController, /this\.native\.isTaskbarWindow\(current\)[\s\S]*?rectsOverlap\(currentRect, gameRect\)/,
    '듀얼 모니터의 다른 화면 작업표시줄까지 게임 위 작업표시줄로 오인합니다.');
  assert.match(tracker, /export function releaseGameZOrder\(\): void[\s\S]*?gameOverlayZOrderController\.release/,
    '앱 종료 시 게임 창의 동적 Topmost 상태를 해제하는 경로가 없습니다.');
  assert.match(tracker, /className === 'Shell_TrayWnd' \|\| className === 'Shell_SecondaryTrayWnd'/,
    '우리 설정창 종료 후 작업표시줄이 foreground를 가져간 경우를 구분하지 않습니다.');
  assert.match(manager, /const deferDockLayout = pendingDockLayoutChange && !tracker\.isGameOrAppForeground\(\)/,
    '설정창이 전경인 동안 독 재배치를 끝내지 않고 게임 복귀 뒤 독을 다시 표시합니다.');
  assert.match(manager, /if \(isDockPositionChange\)[\s\S]*?pendingDockLayoutChange = true/,
    '일반 창모드와 전체화면에서 동일한 독 재배치 경계를 사용하지 않습니다.');
  assert.match(manager, /dockCfg\.ref\.hide\(\);[\s\S]*?dockCfg\.ref\.setPosition\(x, y\);[\s\S]*?dockCfg\.ref\.showInactive\(\);/,
    '표시 중인 투명 독을 숨기지 않은 채 화면 반대편으로 이동합니다.');
  assert.match(manager, /win\.once\('ready-to-show'/,
    '관리 창 ready-to-show 재발생 시 show/showInactive가 반복될 수 있습니다.');
  assert.match(manager, /SHOULD_AUTO_OPEN_DEVTOOLS/,
    '개발 실행이 분리형 DevTools 창을 항상 열어 전체화면 실기 검증을 오염시킵니다.');
  assert.doesNotMatch(manager, /if \(IS_DEV\)[^{\n]*\{?[^\n]*openDevTools/,
    '명시적 --devtools 옵션 없이 분리형 DevTools 창을 자동으로 엽니다.');
  assert.match(zOrderController, /for \(let i = overlayHwnds\.length - 1; i > 0; i--\)/,
    '게임 바로 위 한 창만 확인하고 TW-Overlay 내부 Z-order가 갈라진 상태를 정상으로 오판합니다.');
  assert.match(manager, /overlayWindow\?\.showInactive\(\)/,
    '브라우저 오버레이 자동 생성이 포커스를 획득할 수 있습니다.');
  assert.match(manager, /type ManagedWindowShowReason = 'user-open' \| 'game-resync' \| 'settings-apply' \| 'preload'/,
    '사용자가 연 창과 자동 재생성을 구분하는 표시 정책이 없습니다.');
  assert.match(manager, /showReason === 'user-open' && !isPassiveOverlay[\s\S]*?win\.show\(\);[\s\S]*?win\.showInactive\(\);/,
    '자동 재생성된 관리 창이 비활성 상태로 표시되지 않습니다.');
  assert.doesNotMatch(manager, /key === 'dock'[^\n]*focusable: false/,
    '독 창이 no-activate로 생성되어 hover만 되고 클릭이 전달되지 않을 수 있습니다.');
  assert.ok((manager.match(/'game-resync'/g) ?? []).length >= 6,
    '게임 동기화 중 생성되는 창의 비활성 표시 사유가 누락되었습니다.');
  const clickThroughStart = manager.indexOf('export function toggleClickThrough(): boolean');
  const clickThroughEnd = manager.indexOf('export function toggleSidebar(): boolean', clickThroughStart);
  assert.ok(clickThroughStart >= 0 && clickThroughEnd > clickThroughStart,
    '클릭 투과 전환 함수를 찾지 못했습니다.');
  assert.doesNotMatch(manager.slice(clickThroughStart, clickThroughEnd), /reconcileGameZOrder\([^\n]*true\)/,
    '클릭 투과 전환이 외부 프로그램 전환 후에도 Z-order를 강제 변경할 수 있습니다.');

  const dockToggleStart = manager.indexOf('export function toggleDockWindow(): void');
  const dockToggleEnd = manager.indexOf('export function toggleContentsCheckerWindow', dockToggleStart);
  assert.ok(dockToggleStart >= 0 && dockToggleEnd > dockToggleStart, '독 토글 함수를 찾지 못했습니다.');
  const dockToggleSource = manager.slice(dockToggleStart, dockToggleEnd);
  assert.match(dockToggleSource, /if \(winCfg\.ref\.isVisible\(\)\)[\s\S]*?winCfg\.ref\.hide\(\)/,
    '독을 숨길 때 창을 유지하지 않아 다음 표시에 renderer 재생성 지연이 발생합니다.');
  assert.doesNotMatch(dockToggleSource, /winCfg\.ref\.close\(\)/,
    '단축키 독 숨김이 창을 파괴해 다음 표시를 지연시킵니다.');
  assert.match(dockToggleSource, /winCfg\.ref\.setPosition\(x, y\);[\s\S]*?winCfg\.ref\.showInactive\(\)/,
    '숨긴 독의 위치를 먼저 확정하지 않아 표시 직후 화면 점프가 발생할 수 있습니다.');
  assert.match(manager, /if \(!isDockVisible\)[\s\S]*?dockCfg\.ref\.hide\(\)/,
    '안정 폴링이 숨긴 독 창을 닫아 재사용 최적화를 무효화합니다.');
  assert.match(manager, /createToggleableWindow\('dock', undefined, 'preload'\)/,
    '독 모드 진입 시 숨은 renderer를 미리 준비하지 않아 첫 단축키 표시가 지연됩니다.');
  assert.match(manager, /showReason === 'preload'[\s\S]*?showMethod = 'preload-hidden'/,
    '사전 로딩한 독이 준비 과정에서 화면에 노출될 수 있습니다.');
  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(ipcHandlers, /ipcMain\.on\('save-quick-slots'[\s\S]*?config\.saveImmediate\(\{ quickSlots: slots \}\);[\s\S]*?wm\.broadcastConfig\(\)/,
    '퀵링크 저장 후 재사용 중인 독 renderer에 최신 설정을 즉시 전달하지 않습니다.');
  assert.match(read('src/dock.html'), /onConfigData\(\(config\) => \{[\s\S]*?appConfig = config;[\s\S]*?renderDock\(\)/,
    '독 renderer가 퀵링크·위치 설정 변경을 수신해 즉시 다시 그리지 않습니다.');

  const zOrderRuntime = require(path.join(projectRoot, 'dist', 'modules', 'zOrderController.js')) as {
    GameOverlayZOrderController: new (
      native: {
        top: bigint;
        topmost: bigint;
        notTopmost: bigint;
        getForegroundWindow(): bigint;
        getWindowRect(hwnd: bigint): { left: number; top: number; right: number; bottom: number } | null;
        getWindowAbove(hwnd: bigint): bigint;
        isTopmost(hwnd: bigint): boolean;
        isTaskbarWindow(hwnd: bigint): boolean;
        setWindowAfter(hwnd: bigint, insertAfter: bigint): boolean;
      },
      writeLog?: (message: string) => void,
    ) => {
      getState(): string;
      reconcile(input: { gameHwnd: bigint; overlayHwnds: bigint[] }): { state: string };
      release(gameHwnd?: bigint): void;
    };
  };
  const gameHwnd = 10n;
  const firstOverlayHwnd = 20n;
  const secondOverlayHwnd = 21n;
  const externalHwnd = 30n;
  let foregroundHwnd = gameHwnd;
  let setWindowCallCount = 0;
  const topmostHwnds = new Set<bigint>([gameHwnd, firstOverlayHwnd, secondOverlayHwnd]);
  const windowAbove = new Map<bigint, bigint>([
    [firstOverlayHwnd, 0n],
    [secondOverlayHwnd, firstOverlayHwnd],
    [gameHwnd, secondOverlayHwnd],
  ]);
  const rects = new Map<bigint, { left: number; top: number; right: number; bottom: number }>([
    [gameHwnd, { left: 0, top: 0, right: 100, bottom: 100 }],
    [externalHwnd, { left: 200, top: 0, right: 300, bottom: 100 }],
  ]);
  const fakeNative = {
    top: 0n,
    topmost: -1n,
    notTopmost: -2n,
    getForegroundWindow: (): bigint => foregroundHwnd,
    getWindowRect: (hwnd: bigint) => rects.get(hwnd) ?? null,
    getWindowAbove: (hwnd: bigint): bigint => windowAbove.get(hwnd) ?? 0n,
    isTopmost: (hwnd: bigint): boolean => topmostHwnds.has(hwnd),
    isTaskbarWindow: (_hwnd: bigint): boolean => false,
    setWindowAfter: (hwnd: bigint, insertAfter: bigint): boolean => {
      setWindowCallCount++;
      if (insertAfter === -2n) {
        topmostHwnds.delete(hwnd);
      } else if (insertAfter === -1n || topmostHwnds.has(insertAfter)) {
        topmostHwnds.add(hwnd);
      }
      windowAbove.set(hwnd, insertAfter > 0n ? insertAfter : 0n);
      return true;
    },
  };
  const zOrder = new zOrderRuntime.GameOverlayZOrderController(fakeNative, () => undefined);
  const zOrderInput = { gameHwnd, overlayHwnds: [firstOverlayHwnd, secondOverlayHwnd] };

  assert.equal(zOrder.reconcile(zOrderInput).state, 'game-active');
  assert.equal(setWindowCallCount, 0, '정상인 동일 z-order 상태에서도 Win32 쓰기를 수행합니다.');
  assert.equal(zOrder.reconcile(zOrderInput).state, 'game-active');
  assert.equal(setWindowCallCount, 0, '동일 상태 재평가가 멱등적이지 않습니다.');

  foregroundHwnd = firstOverlayHwnd;
  assert.equal(zOrder.reconcile(zOrderInput).state, 'overlay-active');
  assert.equal(setWindowCallCount, 0,
    '정상적인 TW-Overlay 내부 포커스 전환만으로 불필요한 z-order 쓰기를 수행합니다.');

  foregroundHwnd = externalHwnd;
  assert.equal(zOrder.reconcile(zOrderInput).state, 'external-other-monitor');
  assert.equal(setWindowCallCount, 0, '다른 모니터 외부 창만 활성화됐는데 게임 묶음을 강등합니다.');

  rects.set(externalHwnd, { left: 50, top: 0, right: 150, bottom: 100 });
  assert.equal(zOrder.reconcile(zOrderInput).state, 'external-game-monitor');
  const callsAfterDemotion = setWindowCallCount;
  assert.ok(callsAfterDemotion > 0, '외부 창이 게임 모니터에 진입했는데 게임 묶음을 강등하지 않습니다.');
  zOrder.reconcile(zOrderInput);
  assert.equal(setWindowCallCount, callsAfterDemotion,
    '게임 모니터의 동일 외부 창 상태에서 강등 쓰기를 반복합니다.');

  rects.set(externalHwnd, { left: 200, top: 0, right: 300, bottom: 100 });
  assert.equal(zOrder.reconcile(zOrderInput).state, 'external-other-monitor');
  const callsAfterPromotion = setWindowCallCount;
  assert.ok(callsAfterPromotion > callsAfterDemotion,
    '외부 창이 다른 모니터로 돌아갔는데 게임 묶음을 복원하지 않습니다.');
  zOrder.reconcile(zOrderInput);
  assert.equal(setWindowCallCount, callsAfterPromotion,
    '복원된 동일 상태에서 승격 쓰기를 반복합니다.');

  zOrder.release(gameHwnd);
  assert.equal(zOrder.getState(), 'inactive');
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
  const { parseItemAcquisition, parseItemAcquisitions, formatLootDiaryContent } = require(path.join(projectRoot, 'dist/modules/itemAcquisition.js')) as {
    parseItemAcquisition(message: string, context?: { isSelfChat?: boolean }): {
      itemName: string;
      count: number;
      source: string;
      isOwn: boolean;
    } | null;
    parseItemAcquisitions(message: string, context?: { isSelfChat?: boolean }): Array<{
      itemName: string;
      count: number;
      source: string;
      isOwn: boolean;
    }>;
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
  assert.deepEqual(
    parseItemAcquisitions('미션 보상으로 [장비 강화석] 1,000개, [경험의 정수] 2개를 획득했습니다.'),
    [
      { itemName: '장비 강화석', count: 1000, source: 'direct', isOwn: true },
      { itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true },
    ],
    '복수 아이템 파서가 천 단위 쉼표를 아이템 구분자로 잘못 분리했습니다.',
  );
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
  const { parseAutoLogAmount, resolveLootCount } = require(
    path.join(projectRoot, 'dist/renderer/diary/log-utils.js'),
  ) as {
    parseAutoLogAmount(content: string): number;
    resolveLootCount(content: string, storedAmount: unknown): number;
  };
  assert.equal(parseAutoLogAmount('[자동] 보상 (1조)'), 1_000_000_000_000);
  assert.equal(parseAutoLogAmount('[자동] 보상 (1조 2억 3만)'), 1_000_200_030_000);
  assert.equal(parseAutoLogAmount('[자동] 보상 (1,234)'), 1_234);
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
    /normalizeExistingLootContent\((?:true)?\)[\s\S]*?if \(!condensed\.includes\('경험의정수'\)\) continue/,
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

    const manualContent = '수동 중복 아이템';
    const firstManualId = diaryDb.addManualActivityLog(testDate, '23:58:00', 'loot', manualContent, 1);
    const secondManualId = diaryDb.addManualActivityLog(testDate, '23:58:01', 'loot', manualContent, 2);
    assert.ok(Number.isSafeInteger(firstManualId) && Number.isSafeInteger(secondManualId));
    assert.equal(diaryDb.removeManualActivityLogById(firstManualId), true,
      '수동 기록을 row ID로 삭제하지 못했습니다.');
    const remainingManual = diaryDb.getDiaryByDate(testDate).activityLogs
      .filter((log: { content: string }) => log.content === manualContent);
    assert.equal(remainingManual.length, 1, '동일 내용의 다른 수동 기록까지 함께 삭제되었습니다.');
    assert.equal(remainingManual[0].id, secondManualId);
    assert.equal(remainingManual[0].source, 'manual');
    assert.equal(diaryDb.removeManualActivityLogById(secondManualId), true);

    const automaticLog = diaryDb.getDiaryByDate(testDate).activityLogs
      .find((log: { content: string }) => log.content === testContent);
    assert.equal(automaticLog?.source, 'automatic');
    assert.equal(diaryDb.removeManualActivityLogById(automaticLog.id), false,
      '자동 감지 기록이 수동 삭제 API로 삭제되었습니다.');

    assert.equal(diaryDb.addHomeworkLog(testDate, 'test-homework', '이전 이름', '이전 분류', 'daily', 1_000), true);
    assert.equal(diaryDb.addHomeworkLog(testDate, 'test-homework', '최신 이름', '최신 분류', 'weekly', 2_000), true);
    const updatedHomework = diaryDb.getDiaryByDate(testDate).homeworkLogs
      .filter((log: { content_id: string }) => log.content_id === 'test-homework');
    assert.equal(updatedHomework.length, 1, '초기화권 재완료가 별도 숙제 행으로 중복 저장되었습니다.');
    assert.deepEqual(
      {
        name: updatedHomework[0].content_name,
        category: updatedHomework[0].category,
        type: updatedHomework[0].type,
        completedAt: updatedHomework[0].completed_at,
      },
      { name: '최신 이름', category: '최신 분류', type: 'weekly', completedAt: 2_000 },
      '숙제 재완료 시 최신 완료 시각과 메타데이터가 함께 갱신되지 않았습니다.',
    );
    assert.equal(diaryDb.removeHomeworkLog(testDate, 'test-homework'), true);

    // 공개 DB 쓰기 API는 트랜잭션 실패를 성공처럼 보고하거나 예외로 앱까지 전파하지 않아야 한다.
    const BoundaryDatabase = require('better-sqlite3');
    const boundaryDb = new BoundaryDatabase(path.join(isolatedUserData, 'diary.db'));
    boundaryDb.exec(`
      CREATE TRIGGER regression_fail_homework_insert
      BEFORE INSERT ON homework_logs
      WHEN NEW.content_id = 'failure-homework'
      BEGIN SELECT RAISE(ABORT, 'forced homework write failure'); END;

      CREATE TRIGGER regression_fail_homework_stats
      BEFORE UPDATE ON diaries
      WHEN NEW.date = '2099-12-26'
      BEGIN SELECT RAISE(ABORT, 'forced homework stats failure'); END;

      CREATE TRIGGER regression_fail_alarm_log
      BEFORE INSERT ON alarm_logs
      WHEN NEW.title = 'failure-alarm'
      BEGIN SELECT RAISE(ABORT, 'forced alarm write failure'); END;

      CREATE TRIGGER regression_fail_word_alarm
      BEFORE INSERT ON word_alarm_history
      WHEN NEW.keyword = 'failure-keyword'
      BEGIN SELECT RAISE(ABORT, 'forced word alarm failure'); END;

      CREATE TRIGGER regression_fail_shout
      BEFORE INSERT ON shout_history
      WHEN NEW.sender = 'failure-sender'
      BEGIN SELECT RAISE(ABORT, 'forced shout write failure'); END;
    `);
    assert.equal(
      diaryDb.addHomeworkLog('2099-12-26', 'failure-homework', '실패 숙제', '테스트', 'daily', 3_000),
      false,
      '실패한 숙제 로그 쓰기가 성공으로 보고되었습니다.',
    );
    assert.equal(
      diaryDb.updateHomeworkStats('2099-12-26', 1, 2, 3, 4),
      false,
      '실패한 숙제 통계 쓰기가 성공으로 보고되었습니다.',
    );
    assert.equal(diaryDb.addAlarmLog('etc', 'failure-alarm', '실패 검증'), false,
      '실패한 알람 이력 쓰기가 성공으로 보고되었습니다.');
    assert.equal(diaryDb.addWordAlarmHistory('failure-keyword', '테스터', '실패 검증', []), -1,
      '실패한 지정 단어 이력이 유효한 row ID를 반환했습니다.');
    assert.equal(diaryDb.addShoutLog('failure-sender', '실패 검증'), false,
      '실패한 외치기 이력 쓰기가 성공으로 보고되었습니다.');
    boundaryDb.exec(`
      DROP TRIGGER regression_fail_homework_insert;
      DROP TRIGGER regression_fail_homework_stats;
      DROP TRIGGER regression_fail_alarm_log;
      DROP TRIGGER regression_fail_word_alarm;
      DROP TRIGGER regression_fail_shout;
    `);

    // 5초 버킷이 아니라 실시간 삽입과 같은 실제 시간 차로 레거시 외치기를 정리해야 한다.
    const shoutBaseTimestamp = 4_102_444_000;
    const insertLegacyShout = boundaryDb.prepare(
      'INSERT INTO shout_history (timestamp, sender, message) VALUES (?, ?, ?)',
    );
    insertLegacyShout.run(shoutBaseTimestamp, 'dedupe-sender', 'dedupe-message');
    insertLegacyShout.run(shoutBaseTimestamp + 4, 'dedupe-sender', 'dedupe-message');
    insertLegacyShout.run(shoutBaseTimestamp + 8, 'dedupe-sender', 'dedupe-message');
    diaryDb.deduplicateShoutHistory();
    const deduplicatedShouts = diaryDb.getShoutHistory(24 * 365 * 100)
      .filter((row: { sender: string }) => row.sender === 'dedupe-sender')
      .map((row: { timestamp: number }) => row.timestamp)
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(deduplicatedShouts, [shoutBaseTimestamp, shoutBaseTimestamp + 8],
      '레거시 외치기 정리가 실제 마지막 보존 행 기준 ±5초 계약과 다릅니다.');

    boundaryDb.close();

    const contentsSource = read('src/modules/contentsChecker.ts');
    assert.match(contentsSource, /runDiaryWriteWithRetry\(`homework-log:/,
      '숙제 일지 쓰기 실패의 제한 재시도 경계가 없습니다.');
    assert.match(contentsSource, /pendingDiaryWriteRetries\.get\(key\) !== state/,
      '이전 숙제 쓰기 재시도가 최신 완료·해제 상태를 덮을 수 있습니다.');
    assert.match(read('src/main.ts'), /contentsChecker\.cancelPendingDiaryWriteRetries\(\)/,
      '종료 중 숙제 일지 재시도 타이머를 취소하지 않습니다.');

    const grounds = diaryDb.getHuntingGrounds() as Array<{ id: string; name: string; image_path: string }>;
    assert.deepEqual(
      grounds.filter(ground => ['forge', 'golgotha', 'void'].includes(ground.id))
        .map(ground => ground.id).sort(),
      ['forge', 'golgotha', 'void'],
      '신규 DB에 사냥터 동선 기본 지도 3개가 생성되지 않았습니다.',
    );
    assert.equal(grounds.find(ground => ground.id === 'forge')?.name, '시오칸하임 대장간');
    assert.equal(grounds.find(ground => ground.id === 'golgotha')?.image_path, 'assets/img/field-map/골고다의협곡.png');

    const diaryDbSource = read('src/modules/diaryDb.ts');
    assert.match(diaryDbSource, /INSERT OR IGNORE INTO hunting_grounds/,
      '기본 지도가 기존 사용자 행을 덮어쓸 수 있습니다.');
    assert.match(diaryDbSource, /Version 2 migration completed/);

    assert.equal(diaryDb.parseMigrationNumber('1조'), 1_000_000_000_000);
    assert.equal(diaryDb.parseMigrationNumber('1조 2억 3만'), 1_000_200_030_000);
    assert.equal(diaryDb.parseMigrationNumber('1,234'), 1_234);

    // 배치 중 후반부 쓰기가 실패하면 앞서 증가한 성공 카운터와 DB 변경이 모두 롤백되어야 한다.
    const rollbackDate = '2099-12-30';
    const rollbackContent = '[득템] 롤백 검증 아이템';
    const failedBatch = diaryDb.batchInsertSyncResults({
      loots: [{ date: rollbackDate, timeOnly: '23:59:58', diaryContent: rollbackContent, count: 1 }],
      essences: [],
      seeds: [],
      elsoPoints: [],
      shouts: [{ fullTimestamp: 4_102_444_798, sender: null, message: 'NOT NULL 실패 유도' }],
    });
    assert.equal(failedBatch.success, false, '롤백된 배치가 성공으로 보고되었습니다.');
    assert.deepEqual(
      {
        lootsAdded: failedBatch.lootsAdded,
        essencesAdded: failedBatch.essencesAdded,
        seedsAdded: failedBatch.seedsAdded,
        elsoPointsAdded: failedBatch.elsoPointsAdded,
        shoutsAdded: failedBatch.shoutsAdded,
      },
      { lootsAdded: 0, essencesAdded: 0, seedsAdded: 0, elsoPointsAdded: 0, shoutsAdded: 0 },
      '롤백된 배치가 중간 성공 건수를 반환했습니다.',
    );
    assert.equal(diaryDb.hasActivityLog(rollbackDate, '23:59:58', rollbackContent), false,
      '배치 실패 전에 삽입된 활동 기록이 롤백되지 않았습니다.');

    // 동일한 엘소 recovery operation을 재생해도 DB에는 정확히 한 번만 반영되어야 한다.
    const elsoRecoveryDate = '2099-12-27';
    const elsoJournalPath = diaryDb.getElsoRecoveryJournalPath();
    const elsoJournal = {
      schemaVersion: 1,
      operationId: 'regression-elso-operation-001',
      createdAt: Date.now(),
      entries: [{ date: elsoRecoveryDate, latestTime: '23:59:56', totalAmount: 321 }],
    };
    fs.writeFileSync(elsoJournalPath, JSON.stringify(elsoJournal), 'utf8');
    assert.equal(diaryDb.replayElsoRecoveryJournal(), true);
    let recoveredElso = diaryDb.getDiaryByDate(elsoRecoveryDate).activityLogs
      .find((log: { type: string }) => log.type === 'elso');
    assert.equal(recoveredElso?.amount, 321);

    fs.writeFileSync(elsoJournalPath, JSON.stringify(elsoJournal), 'utf8');
    assert.equal(diaryDb.replayElsoRecoveryJournal(), true);
    recoveredElso = diaryDb.getDiaryByDate(elsoRecoveryDate).activityLogs
      .find((log: { type: string }) => log.type === 'elso');
    assert.equal(recoveredElso?.amount, 321,
      '이미 커밋된 엘소 recovery operation이 중복 반영되었습니다.');
    assert.equal(fs.existsSync(elsoJournalPath), false);
    diaryDb.removeActivityLog(elsoRecoveryDate, 'elso', '엘소 포인트 획득');

    // 테스트 후 데이터 정리 및 DB 파일 닫기
    diaryDb.removeActivityLog(testDate, 'loot', testContent);
    if (typeof diaryDb.closeDb === 'function') {
      diaryDb.closeDb();
    }

    // v2 DB에서 잘못 저장된 단위 금액만 v3 마이그레이션이 원문 기준으로 복구하는지 검증한다.
    const migrationDate = '2099-12-29';
    const migrationDbPath = path.join(isolatedUserData, 'diary.db');
    const MigrationDatabase = require('better-sqlite3');
    const migrationDb = new MigrationDatabase(migrationDbPath);
    migrationDb.prepare('INSERT OR IGNORE INTO diaries (date) VALUES (?)').run(migrationDate);
    migrationDb.prepare(`
      INSERT INTO activity_logs (date, type, content, time, amount, source)
      VALUES (?, 'calc', ?, '23:59:57', 1, 'legacy-unknown')
    `).run(migrationDate, '[자동] 복구 검증 (1조 2억 3만)');
    migrationDb.pragma('user_version = 2');
    migrationDb.close();

    diaryDb.initDb();
    const repairedLog = diaryDb.getDiaryByDate(migrationDate).activityLogs
      .find((log: { content: string }) => log.content.includes('복구 검증'));
    assert.equal(repairedLog?.amount, 1_000_200_030_000,
      'v2 DB의 조/억/만 단위 금액이 원문 기준으로 복구되지 않았습니다.');
    diaryDb.removeActivityLog(migrationDate, 'calc', '[자동] 복구 검증 (1조 2억 3만)');
    diaryDb.closeDb();

    // v1 중간 단계에서 강제 실패시 앞선 지도 변경과 user_version 상승이 함께 롤백되어야 한다.
    const atomicDate = '2099-12-28';
    const atomicDb = new MigrationDatabase(migrationDbPath);
    atomicDb.prepare('INSERT OR IGNORE INTO diaries (date) VALUES (?)').run(atomicDate);
    atomicDb.prepare(`
      INSERT OR REPLACE INTO hunting_grounds
        (id, name, image_path, zoom, s, ox, oy, fx, fy, is_swap)
      VALUES ('forge', '롤백 전 이름', 'old.png', 1, 1, 0, 0, 1, 1, 0)
    `).run();
    atomicDb.prepare(`
      INSERT INTO homework_logs
        (date, content_id, content_name, category, type, completed_at)
      VALUES (?, 'weekly-eclipse-boss-selfina', '이클립스 (셀피나)', '주간', 'weekly', 1)
    `).run(atomicDate);
    atomicDb.exec(`
      CREATE TRIGGER force_v1_migration_failure
      BEFORE UPDATE OF content_id ON homework_logs
      WHEN OLD.content_id LIKE 'weekly-eclipse-boss-selfina%'
      BEGIN
        SELECT RAISE(ABORT, 'forced v1 migration failure');
      END;
    `);
    atomicDb.pragma('user_version = 0');
    atomicDb.close();

    diaryDb.initDb();
    assert.throws(
      () => diaryDb.getStmt('SELECT 1'),
      /DiaryDB가 초기화되지 않아 prepared statement를 만들 수 없습니다/,
      'DB 초기화 실패 뒤 getStmt가 null 연결을 강제 참조했습니다.',
    );
    const inspectAtomicDb = new MigrationDatabase(migrationDbPath);
    assert.equal(inspectAtomicDb.pragma('user_version', { simple: true }), 0,
      '실패한 v1 마이그레이션이 user_version을 올렸습니다.');
    assert.equal(
      inspectAtomicDb.prepare("SELECT name FROM hunting_grounds WHERE id = 'forge'").pluck().get(),
      '롤백 전 이름',
      'v1 후반 실패 전에 수행한 지도 변경이 롤백되지 않았습니다.',
    );
    assert.equal(
      inspectAtomicDb.prepare('SELECT content_id FROM homework_logs WHERE date = ?').pluck().get(atomicDate),
      'weekly-eclipse-boss-selfina',
      '실패한 v1 숙제 ID 변환이 일부 반영되었습니다.',
    );
    inspectAtomicDb.exec('DROP TRIGGER force_v1_migration_failure');
    inspectAtomicDb.prepare('DELETE FROM homework_logs WHERE date = ?').run(atomicDate);
    inspectAtomicDb.prepare('DELETE FROM diaries WHERE date = ?').run(atomicDate);
    inspectAtomicDb.prepare(`
      UPDATE hunting_grounds
      SET name = '시오칸하임 대장간', image_path = 'assets/img/field-map/대장간.png',
          zoom = 2, s = 1, ox = -340, oy = 300, fx = -1, fy = 1, is_swap = 1
      WHERE id = 'forge'
    `).run();
    inspectAtomicDb.pragma('user_version = 3');
    inspectAtomicDb.close();
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
checkWindowedFullscreenFocusContracts();
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
  const constantsModule = require('../dist/modules/constants');
  assert.equal(
    path.resolve(constantsModule.get_CONFIG_PATH()),
    path.join(isolatedUserData, 'config.json'),
    '회귀 테스트의 설정 파일이 격리된 userData 경로를 사용하지 않습니다.',
  );
  assert.equal(
    path.resolve(constantsModule.get_LOG_PATH()),
    path.join(isolatedUserData, 'debug.log'),
    '회귀 테스트의 로그 파일이 격리된 userData 경로를 사용하지 않습니다.',
  );

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

function checkPendingHomeworkOrdering(): void {
  const {
    mergePendingHomeworkEvent,
    resolvePendingHomeworkCount,
    isPendingHomeworkExpired,
    getHomeworkResetCycleKey,
  } = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as {
    mergePendingHomeworkEvent(
      existing: { id: string; count: number; isIncrement: boolean; timestamp: number } | undefined,
      id: string,
      count: number,
      isIncrement: boolean,
      timestamp: number,
      sourceEventId?: string,
      resetCycleKey?: string,
    ): {
      id: string;
      count: number;
      isIncrement: boolean;
      timestamp: number;
      sourceEventIds?: string[];
      resetCycleKey?: string;
    };
    resolvePendingHomeworkCount(
      current: number,
      pending: { id: string; count: number; isIncrement: boolean; timestamp: number },
      max: number,
    ): number;
    isPendingHomeworkExpired(
      pending: { id: string; count: number; isIncrement: boolean; timestamp: number },
      rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number },
      nowTimestamp: number,
    ): boolean;
    getHomeworkResetCycleKey(
      rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number },
      timestamp: number,
    ): string;
  };

  const incrementFirst = mergePendingHomeworkEvent(undefined, 'weekly-test', 1, true, 100);
  const incrementThenAbsolute = mergePendingHomeworkEvent(incrementFirst, 'weekly-test', 3, false, 200);
  assert.equal(incrementThenAbsolute.isIncrement, false);
  assert.equal(incrementThenAbsolute.count, 3);
  assert.equal(resolvePendingHomeworkCount(2, incrementThenAbsolute, 10), 3,
    '증분 뒤 절대값은 감지된 절대 횟수로 설정되어야 합니다.');

  const absoluteFirst = mergePendingHomeworkEvent(undefined, 'weekly-test', 3, false, 100);
  const absoluteThenIncrement = mergePendingHomeworkEvent(absoluteFirst, 'weekly-test', 1, true, 200);
  assert.equal(absoluteThenIncrement.isIncrement, false);
  assert.equal(absoluteThenIncrement.count, 4);
  assert.equal(resolvePendingHomeworkCount(2, absoluteThenIncrement, 10), 4,
    '절대값 뒤 증분은 현재 캐릭터 횟수를 이중 가산하지 않아야 합니다.');

  const increments = mergePendingHomeworkEvent(
    mergePendingHomeworkEvent(undefined, 'weekly-test', 1, true, 100),
    'weekly-test',
    2,
    true,
    200,
  );
  assert.equal(increments.isIncrement, true);
  assert.equal(resolvePendingHomeworkCount(2, increments, 10), 5,
    '증분 이벤트만 있으면 기존 캐릭터 횟수에 누적되어야 합니다.');

  const beforeReset = new Date(2026, 7, 24, 5, 59, 0).getTime();
  const afterReset = new Date(2026, 7, 24, 6, 1, 0).getTime();
  const afterCurrentReset = new Date(2026, 7, 24, 6, 0, 30).getTime();
  const stalePending = mergePendingHomeworkEvent(undefined, 'daily-test', 1, true, beforeReset);
  const currentPending = mergePendingHomeworkEvent(undefined, 'daily-test', 1, true, afterCurrentReset);
  assert.equal(isPendingHomeworkExpired(stalePending, { type: 'daily', hour: 6 }, afterReset), true);
  assert.equal(isPendingHomeworkExpired(currentPending, { type: 'daily', hour: 6 }, afterReset), false);

  const cycleKey = getHomeworkResetCycleKey({ type: 'daily', hour: 6 }, afterCurrentReset);
  const deduplicatedOnce = mergePendingHomeworkEvent(
    undefined, 'daily-test', 1, true, afterCurrentReset, 'stable-event-1', cycleKey,
  );
  const deduplicatedTwice = mergePendingHomeworkEvent(
    deduplicatedOnce, 'daily-test', 1, true, afterCurrentReset + 1000, 'stable-event-1', cycleKey,
  );
  assert.strictEqual(deduplicatedTwice, deduplicatedOnce,
    '같은 채팅 이벤트 ID를 다시 처리하면 보류 횟수가 변경되지 않아야 합니다.');
  assert.equal(deduplicatedTwice.count, 1);

  const nextCycleTimestamp = new Date(2026, 7, 25, 6, 1, 0).getTime();
  const nextCycleKey = getHomeworkResetCycleKey({ type: 'daily', hour: 6 }, nextCycleTimestamp);
  const nextCyclePending = mergePendingHomeworkEvent(
    deduplicatedOnce, 'daily-test', 2, true, nextCycleTimestamp, 'stable-event-2', nextCycleKey,
  );
  assert.equal(nextCyclePending.count, 2,
    '리셋 주기가 바뀌면 이전 주기의 압축 횟수를 이어받지 않아야 합니다.');
  assert.deepEqual(nextCyclePending.sourceEventIds, ['stable-event-2']);
}

function checkLegacyHomeworkMergeContracts(): void {
  const { mergeHomeworkCompletedState } = require(
    path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js'),
  ) as {
    mergeHomeworkCompletedState(
      existing: Record<string, unknown> | undefined,
      incoming: Record<string, unknown> | undefined,
      rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number },
      max: number,
      nowTimestamp: number,
    ): { currentCount?: number; isCompleted: boolean; lastCompletedAt?: number; isExcluded?: boolean };
  };

  const now = new Date(2026, 7, 25, 12, 0, 0).getTime();
  const staleCompleted = new Date(2026, 7, 24, 5, 30, 0).getTime();
  const currentProgress = new Date(2026, 7, 25, 7, 0, 0).getTime();
  const currentWins = mergeHomeworkCompletedState(
    { isCompleted: true, currentCount: 7, lastCompletedAt: staleCompleted },
    { isCompleted: false, currentCount: 1, lastCompletedAt: currentProgress },
    { type: 'daily', hour: 6 },
    7,
    now,
  );
  assert.equal(currentWins.currentCount, 1,
    '과거 리셋 주기의 큰 완료 횟수가 현재 주기 진행도를 덮어쓰면 안 됩니다.');
  assert.equal(currentWins.isCompleted, false);

  const currentHigherProgress = new Date(2026, 7, 25, 8, 0, 0).getTime();
  const sameCycleMerged = mergeHomeworkCompletedState(
    { isCompleted: false, currentCount: 4, lastCompletedAt: currentProgress, isExcluded: true },
    { isCompleted: false, currentCount: 2, lastCompletedAt: currentHigherProgress },
    { type: 'daily', hour: 6 },
    7,
    now,
  );
  assert.equal(sameCycleMerged.currentCount, 4,
    '같은 리셋 주기의 중복 데이터에서는 더 큰 진행도를 보존해야 합니다.');
  assert.equal(sameCycleMerged.lastCompletedAt, currentHigherProgress,
    '같은 리셋 주기의 중복 데이터에서는 가장 최근 감지 시각을 보존해야 합니다.');
  assert.equal(sameCycleMerged.isExcluded, true,
    '레거시 중복 병합 중 사용자가 설정한 N/A가 사라지면 안 됩니다.');

  const checkerSource = read('src/modules/contentsChecker.ts');
  assert.ok(
    checkerSource.indexOf('const newId = ID_MIGRATION_MAP[previousId]')
      < checkerSource.indexOf('// 0-A. 고대 렐릭의 성소'),
    '일일형 고대 렐릭 ID 정규화가 렐릭 통합보다 늦게 실행되어 상태가 유실될 수 있습니다.',
  );
}

function checkHomeworkSourceEventIdContracts(): void {
  const { createHomeworkSourceEventId, parseHomeworkSourceTimestamp } = require(
    path.join(projectRoot, 'dist', 'modules', 'chatLogProcessor.js'),
  ) as {
    createHomeworkSourceEventId(eventName: string, homeworkId: string, data: Record<string, string>): string;
    parseHomeworkSourceTimestamp(data: Record<string, string>): number;
  };
  const event = {
    date: '2026-08-25',
    timestamp: '12시 34분 56초',
    message: '콘텐츠를 1회 완료했습니다.',
  };
  const first = createHomeworkSourceEventId('TEST_CLEAR', 'daily-test', event);
  assert.equal(createHomeworkSourceEventId('TEST_CLEAR', 'daily-test', event), first,
    '동일한 채팅 로그는 항상 같은 숙제 이벤트 ID를 생성해야 합니다.');
  assert.notEqual(createHomeworkSourceEventId('TEST_CLEAR', 'daily-other', event), first,
    '같은 채팅 줄에서 서로 다른 숙제 ID는 별개의 이벤트 ID여야 합니다.');
  assert.equal(
    parseHomeworkSourceTimestamp(event),
    new Date(2026, 7, 25, 12, 34, 56).getTime(),
    '숙제 리셋 주기는 처리 시각이 아니라 실제 채팅 로그 시각을 사용해야 합니다.',
  );
}

function checkContentsVisibilityContracts(): void {
  const checkerSource = read('src/modules/contentsChecker.ts');
  const checkerHtml = read('src/contents-checker.html');
  assert.doesNotMatch(checkerSource, /return i\.isVisible && !state\?\.isExcluded/,
    '모듈 통계가 isVisible 없는 레거시 숙제를 숨김 처리합니다.');
  assert.match(checkerSource, /item\.isVisible = item\.isVisible === false/,
    'isVisible 없는 레거시 숙제의 첫 토글이 숨김으로 전환되지 않습니다.');
  assert.doesNotMatch(checkerHtml, /filter\(i => i\.isVisible\)/,
    '화면에 isVisible 없는 레거시 숙제를 제외하는 truthy 필터가 남아 있습니다.');
  assert.match(checkerHtml, /filter\(i => i\.isVisible !== false\)/,
    '화면 가시성의 기본 보임 계약이 없습니다.');
}

function checkContentsInitializationContracts(): void {
  const contentsChecker = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as {
    init(): boolean;
  };
  const appConfig = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as {
    load(): Record<string, unknown>;
  };

  assert.equal(contentsChecker.init(), true, '숙제 체크리스트 최초 초기화가 실패했습니다.');
  const firstSnapshot = JSON.stringify(appConfig.load());
  assert.equal(contentsChecker.init(), true, '숙제 체크리스트 중복 초기화가 실패로 보고되었습니다.');
  assert.equal(JSON.stringify(appConfig.load()), firstSnapshot,
    '숙제 체크리스트 두 번째 초기화가 설정을 다시 변경했습니다.');

  const mainSource = read('src/main.ts');
  const initPosition = mainSource.indexOf('contentsChecker.init()');
  const processorStartPosition = mainSource.indexOf('chatLogProcessor.start()');
  assert.ok(initPosition >= 0 && processorStartPosition > initPosition,
    '숙제 체크리스트가 채팅 자동 감지보다 먼저 초기화되지 않습니다.');
}

function checkXpExchangeContracts(): void {
  const { XP_PER_ESSENCE, getEssenceExchangeCount } = require(
    path.join(projectRoot, 'dist', 'modules', 'xpTracker.js'),
  ) as {
    XP_PER_ESSENCE: number;
    getEssenceExchangeCount(amount: number): number;
  };

  assert.equal(XP_PER_ESSENCE, 10_000_000_000);
  assert.equal(getEssenceExchangeCount(-10_000_000_000), 1);
  assert.equal(getEssenceExchangeCount(-20_000_000_000), 2);
  assert.equal(getEssenceExchangeCount(-9_000_000_000), 0,
    '100억 미만의 음수 XP를 경험의 정수 교환으로 오인했습니다.');
  assert.equal(getEssenceExchangeCount(-10_000_000_001), 0,
    '정확한 100억 배수가 아닌 음수 XP를 경험의 정수 교환으로 오인했습니다.');
  assert.equal(getEssenceExchangeCount(10_000_000_000), 0);

  const processorSource = read('src/modules/chatLogProcessor.ts');
  assert.match(processorSource, /const essenceCount = getEssenceExchangeCount\(data\.amount\)/,
    'XP HUD와 모험일지가 서로 다른 경험의 정수 교환 판정을 사용합니다.');
  assert.doesNotMatch(processorSource, /data\.amount <= -9_000_000_000/,
    '모험일지 경로에 기존 90억 교환 판정이 남아 있습니다.');
}

function checkAbandonedFeeMatchingContracts(): void {
  const {
    ABANDONED_FEE_MATCH_WINDOW_MS,
    isAbandonedFeeMatchWithinWindow,
  } = require(path.join(projectRoot, 'dist', 'modules', 'abandonedTracker.js')) as {
    ABANDONED_FEE_MATCH_WINDOW_MS: number;
    isAbandonedFeeMatchWithinWindow(firstDetectedAt: number, secondDetectedAt: number): boolean;
  };

  assert.equal(ABANDONED_FEE_MATCH_WINDOW_MS, 15_000);
  assert.equal(isAbandonedFeeMatchWithinWindow(1_000, 15_999), true);
  assert.equal(isAbandonedFeeMatchWithinWindow(1_000, 16_000), false);
  assert.equal(isAbandonedFeeMatchWithinWindow(2_000, 1_000), false);

  const trackerSource = read('src/modules/abandonedTracker.ts');
  assert.match(trackerSource,
    /profit -= data\.amount;[\s\S]*?totalFee \+= data\.amount;[\s\S]*?unassignedFee/,
    '선도착 입장료가 감지 즉시 전체 수익에서 차감되지 않습니다.');
  assert.match(trackerSource, /시간 범위를 지난 입장료는 미귀속으로 유지/,
    '만료된 입장료를 다음 지역에 넘기지 않는 계약이 없습니다.');

  const { abandonedTracker } = require(path.join(projectRoot, 'dist', 'modules', 'abandonedTracker.js'));
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js'));
  abandonedTracker.start();
  abandonedTracker.reset();
  chatParser.emit('ABANDONED_FEE', {
    date: '2099-12-31', timestamp: '23시 59분 00초', amount: 100, message: '입장료',
  });
  let state = abandonedTracker.getState();
  assert.equal(state.profit, -100, '선도착 입장료가 즉시 수익에서 차감되지 않았습니다.');
  assert.equal(state.totalFee, 100);
  assert.equal(state.unassignedFee, 100);

  chatParser.emit('ABANDONED_ENTRY', {
    date: '2099-12-31', timestamp: '23시 59분 01초', region: '테스트 지역', count: 1, message: '입장',
  });
  state = abandonedTracker.getState();
  assert.equal(state.profit, -100, '지역 귀속 과정에서 입장료가 이중 차감되었습니다.');
  assert.equal(state.unassignedFee, 0);
  assert.equal(state.regionDetails['테스트 지역'].totalFee, 100);
  abandonedTracker.reset();

  chatParser.emit('ABANDONED_ENTRY', {
    date: '2099-12-31', timestamp: '23시 59분 02초', region: '후도착 지역', count: 2, message: '입장',
  });
  chatParser.emit('ABANDONED_FEE', {
    date: '2099-12-31', timestamp: '23시 59분 03초', amount: 200, message: '입장료',
  });
  state = abandonedTracker.getState();
  assert.equal(state.profit, -200);
  assert.equal(state.totalFee, 200);
  assert.equal(state.unassignedFee, 0);
  assert.equal(state.regionDetails['후도착 지역'].totalFee, 200,
    '도전 횟수 뒤에 도착한 입장료가 가까운 지역에 귀속되지 않았습니다.');
  abandonedTracker.reset();
}

function checkMissedMinuteSchedulerContracts(): void {
  const { getMissedMinuteTimestamps } = require(
    path.join(projectRoot, 'dist', 'modules', 'minuteAlignedScheduler.js'),
  ) as {
    getMissedMinuteTimestamps(lastCheckedAt: number, resumedAt: number, maxLookbackMs?: number): number[];
  };

  const at = (hour: number, minute: number, second = 0) =>
    new Date(2026, 7, 25, hour, minute, second).getTime();
  assert.deepEqual(
    getMissedMinuteTimestamps(at(10, 0, 10), at(10, 5, 30)),
    [at(10, 1), at(10, 2), at(10, 3), at(10, 4)],
    '절전 중 완전히 지나간 분 목록이 정확하지 않습니다.',
  );
  assert.deepEqual(getMissedMinuteTimestamps(at(10, 5), at(10, 5, 30)), [],
    '복귀한 현재 분을 놓친 알림으로 소급했습니다.');
  assert.deepEqual(getMissedMinuteTimestamps(at(10, 5), at(10, 4)), []);

  const schedulerSource = read('src/modules/minuteAlignedScheduler.ts');
  assert.match(schedulerSource, /if \(this\.resumeDelayTimer\)[\s\S]*?clearTimeout\(this\.resumeDelayTimer\)/,
    'resume/unlock 중복 지연 타이머를 취소하지 않습니다.');
}

function checkMissedCustomAlertContracts(): void {
  const { getDueCustomAlertsAt } = require(
    path.join(projectRoot, 'dist', 'modules', 'customNotifier.js'),
  ) as {
    getDueCustomAlertsAt(alerts: any[], now: Date): Array<{ message: string; firedKey: string }>;
  };
  const daily = {
    id: 'daily-test', enabled: true, type: 'daily', time: '10:00', offsets: [5, 0],
    message: '일일 테스트', soundFile: 'orb.mp3',
  };
  assert.deepEqual(
    getDueCustomAlertsAt([daily], new Date(2026, 7, 25, 9, 55)).map(due => due.message),
    ['[5분 전] 일일 테스트'],
  );
  assert.deepEqual(
    getDueCustomAlertsAt([daily], new Date(2026, 7, 25, 10, 0)).map(due => due.message),
    ['일일 테스트'],
  );
  const hourly = {
    id: 'hourly-test', enabled: true, type: 'hourly', minute: 10, offsets: [5],
    message: '매시 테스트', soundFile: 'orb.mp3',
  };
  assert.deepEqual(
    getDueCustomAlertsAt([hourly], new Date(2026, 7, 25, 11, 5)).map(due => due.message),
    ['[5분 전] 매시 테스트'],
  );

  const customNotifierSource = read('src/modules/customNotifier.ts');
  assert.match(customNotifierSource,
    /minuteScheduler\.start\(checkAlerts, recordMissedAlerts\)/,
    '커스텀 알림이 절전 중 놓친 분 기록 콜백을 등록하지 않습니다.');
  assert.match(customNotifierSource,
    /'절전 중 놓친 알람'[\s\S]*?diaryDb\.addAlarmLog|diaryDb\.addAlarmLog\([\s\S]*?'절전 중 놓친 알람'/,
    '절전 중 놓친 커스텀 알림을 이력에 기록하지 않습니다.');
}

function checkMissedBossAlertContracts(): void {
  const { getDueBossAlertsAt } = require(
    path.join(projectRoot, 'dist', 'modules', 'bossNotifier.js'),
  ) as {
    getDueBossAlertsAt(config: Record<string, unknown>, now: Date): Array<{ name: string; offset: number }>;
  };
  const bossConfig = {
    fieldBossNotifyEnabled: true,
    fieldBossNotifyOffsets: [5, 0],
    fieldBossSettings: {
      골론: { name: '골론', enabled: true, soundFile: 'boss.mp3' },
    },
  };
  assert.deepEqual(
    getDueBossAlertsAt(bossConfig, new Date(2026, 7, 25, 5, 55))
      .map(due => ({ name: due.name, offset: due.offset })),
    [{ name: '골론', offset: 5 }],
  );
  assert.deepEqual(
    getDueBossAlertsAt(bossConfig, new Date(2026, 7, 25, 6, 0))
      .map(due => ({ name: due.name, offset: due.offset })),
    [{ name: '골론', offset: 0 }],
  );

  const bossSource = read('src/modules/bossNotifier.ts');
  assert.match(bossSource, /minuteScheduler\.start\(checkBossTime, recordMissedBossAlerts\)/,
    '필드보스 알림이 절전 중 놓친 분 기록 콜백을 등록하지 않습니다.');
  assert.match(bossSource, /diaryDb\.addAlarmLog\('boss', '절전 중 놓친 알람'/,
    '절전 중 놓친 필드보스 알림을 이력에 기록하지 않습니다.');
}

async function checkGoogleSyncDataContracts(): Promise<void> {
  const syncDataHelper = require(path.join(projectRoot, 'dist', 'modules', 'syncDataHelper.js'));

  // 1. extractSyncData: 동기화 대상 필드만 추출하고 로컬 전용 필드(positions, chatLogPath 등)는 제외
  const sampleLocalConfig = {
    userServer: 16,
    lootKeywords: ['샤를란', '엔키라'],
    discordWebhookUrl: 'https://discord.com/api/webhooks/secret-token',
    customSounds: [{ name: '로컬 알림음', file: 'custom_123_local.mp3' }],
    wordAlarmSound: 'custom_123_local.mp3',
    buffTimerSound: 'orb.mp3',
    fieldBossSettings: {
      '골론': { name: '골론', enabled: true, soundFile: 'custom_123_local.mp3' },
      '아칸': { name: '아칸', enabled: true, soundFile: 'orb.mp3' },
    },
    customAlerts: [
      { id: 'custom-alert-1', enabled: true, type: 'daily', time: '12:30', offsets: [0], message: '테스트', soundFile: 'custom_123_local.mp3' },
    ],
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
    ],
    pendingHomeworks: [
      { id: 'pending-1', contentId: 'daily-abyss', detectedAt: 900 },
    ],
  };

  const extracted = syncDataHelper.extractSyncData(sampleLocalConfig);
  assert.equal(extracted.userServer, 16);
  assert.deepEqual(extracted.lootKeywords, ['샤를란', '엔키라']);
  assert.equal(extracted.positions, undefined, 'positions 필드가 동기화 데이터에 포함되었습니다.');
  assert.equal(extracted.chatLogPath, undefined, 'chatLogPath 필드가 동기화 데이터에 포함되었습니다.');
  assert.deepEqual(extracted.pendingHomeworks, sampleLocalConfig.pendingHomeworks);
  assert.equal(extracted.discordWebhookUrl, undefined, 'Discord Webhook URL이 동기화 데이터에 포함되었습니다.');
  assert.equal(extracted.wordAlarmSound, undefined, '로컬 커스텀 사운드 ID가 동기화 데이터에 포함되었습니다.');
  assert.equal(extracted.buffTimerSound, 'orb.mp3', '내장 사운드 ID가 동기화 데이터에서 누락되었습니다.');
  assert.equal(extracted.fieldBossSettings['골론'].soundFile, undefined,
    '필드보스 설정의 로컬 커스텀 사운드가 포함되었습니다.');
  assert.equal(extracted.fieldBossSettings['아칸'].soundFile, 'orb.mp3');
  assert.equal(extracted.customAlerts[0].soundFile, undefined,
    '커스텀 알림의 로컬 커스텀 사운드가 포함되었습니다.');

  const settingsData = syncDataHelper.extractSettingsSyncData(sampleLocalConfig);
  const checklistData = syncDataHelper.extractChecklistSyncData(sampleLocalConfig);
  assert.equal(settingsData.contentsCheckerItems, undefined, '설정 파일에 숙제 상태가 섞였습니다.');
  assert.equal(settingsData.characterPresets, undefined, '설정 파일에 캐릭터 프리셋이 섞였습니다.');
  assert.equal(checklistData.userServer, undefined, '숙제 파일에 일반 설정이 섞였습니다.');
  assert.deepEqual(checklistData.contentsCheckerItems, sampleLocalConfig.contentsCheckerItems);
  assert.deepEqual(checklistData.characterPresets, sampleLocalConfig.characterPresets);
  assert.deepEqual(checklistData.pendingHomeworks, sampleLocalConfig.pendingHomeworks);

  // 2. buildSyncPayload: 메타데이터 및 스키마 검증
  const payload = syncDataHelper.buildSyncPayload(sampleLocalConfig, 'tester@gmail.com');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.updatedBy, 'tester@gmail.com');
  assert.ok(payload.lastSyncedAt > 0);
  assert.equal(payload.data.userServer, 16);
  assert.equal(syncDataHelper.buildSettingsSyncPayload(sampleLocalConfig, 'tester@gmail.com').data.contentsCheckerItems, undefined);
  assert.equal(syncDataHelper.buildChecklistSyncPayload(sampleLocalConfig, 'tester@gmail.com').data.userServer, undefined);
  const settingsPayload = syncDataHelper.buildSettingsSyncPayload(sampleLocalConfig, 'device-1', 'generation-1');
  assert.equal(settingsPayload.kind, 'settings');
  assert.equal(settingsPayload.generationId, 'generation-1');
  assert.equal(typeof settingsPayload.revision, 'string');
  assert.equal(syncDataHelper.validateSyncPayload(settingsPayload, 'settings'), true);
  assert.equal(syncDataHelper.validateSyncPayload({
    ...settingsPayload,
    data: { ...settingsPayload.data, userServer: 99 },
  }, 'settings'), false, '내용이 바뀐 클라우드 payload의 checksum 검증이 실패하지 않았습니다.');
  assert.equal(syncDataHelper.validateSyncPayload(settingsPayload, 'checklist'), false,
    '설정 파일을 숙제 파일로 잘못 허용했습니다.');

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

  const secretCloudPayload = {
    ...cloudPayload,
    data: {
      discordWebhookUrl: 'https://discord.com/api/webhooks/remote-secret',
      wordAlarmSound: 'C:\\Users\\remote\\secret.mp3',
      fieldBossSettings: {
        '골론': { name: '골론', enabled: false, soundFile: 'custom_remote.mp3' },
      },
      customAlerts: [
        { id: 'custom-alert-1', enabled: false, type: 'daily', time: '13:30', offsets: [0], message: '원격 변경', soundFile: 'custom_remote.mp3' },
      ],
    },
  };
  const secretMerged = syncDataHelper.mergeSyncData(sampleLocalConfig, secretCloudPayload);
  assert.equal(secretMerged.discordWebhookUrl, sampleLocalConfig.discordWebhookUrl,
    '비정상 클라우드 payload가 로컬 Webhook URL을 덮었습니다.');
  assert.equal(secretMerged.wordAlarmSound, sampleLocalConfig.wordAlarmSound,
    '원격 로컬 사운드 경로가 현재 PC 설정을 덮었습니다.');
  assert.equal(secretMerged.fieldBossSettings['골론'].soundFile, 'custom_123_local.mp3');
  assert.equal(secretMerged.fieldBossSettings['골론'].enabled, false);
  assert.equal(secretMerged.customAlerts[0].soundFile, 'custom_123_local.mp3');
  assert.equal(secretMerged.customAlerts[0].message, '원격 변경');

  const baseChecklist = {
    contentsCheckerItems: [
      {
        id: 'daily-abyss', name: '어비스 심층', category: '일일 숙제', isVisible: true,
        resetRule: { type: 'daily' },
        completedState: {
          'char-1': { isCompleted: false, currentCount: 0 },
          'char-2': { isCompleted: false, currentCount: 0 },
          'char-3': { isCompleted: false, currentCount: 0 },
        },
      },
      {
        id: 'custom-deleted-remotely', name: '원격 삭제', category: '커스텀', isVisible: true,
        isCustom: true, resetRule: { type: 'weekly' }, completedState: {},
      },
    ],
    characterPresets: [
      { id: 'char-1', name: '보리스' }, { id: 'char-2', name: '루시안' }, { id: 'char-3', name: '티치엘' },
    ],
    pendingHomeworks: [],
  };
  const threeWayLocal = {
    ...sampleLocalConfig,
    contentsCheckerItems: JSON.parse(JSON.stringify(baseChecklist.contentsCheckerItems)),
    characterPresets: JSON.parse(JSON.stringify(baseChecklist.characterPresets)),
    pendingHomeworks: [],
  };
  threeWayLocal.contentsCheckerItems[0].completedState['char-2'] = { isCompleted: true, currentCount: 1, lastCompletedAt: 2000 };
  threeWayLocal.contentsCheckerItems[0].completedState['char-3'] = { isCompleted: true, currentCount: 1, lastCompletedAt: 2100 };
  const remoteChecklist = JSON.parse(JSON.stringify(baseChecklist));
  remoteChecklist.contentsCheckerItems = remoteChecklist.contentsCheckerItems.filter((item: any) => item.id !== 'custom-deleted-remotely');
  remoteChecklist.contentsCheckerItems[0].completedState['char-1'] = { isCompleted: true, currentCount: 1, lastCompletedAt: 1900 };
  remoteChecklist.contentsCheckerItems[0].completedState['char-3'] = { isCompleted: true, currentCount: 2, lastCompletedAt: 2200 };
  const threeWay = syncDataHelper.mergeChecklistThreeWay(baseChecklist, threeWayLocal, remoteChecklist);
  const threeWayItem = threeWay.contentsCheckerItems.find((item: any) => item.id === 'daily-abyss');
  assert.equal(threeWayItem.completedState['char-1'].currentCount, 1,
    '원격 PC에서만 바뀐 숙제 완료가 로컬에 반영되지 않았습니다.');
  assert.equal(threeWayItem.completedState['char-2'].currentCount, 1,
    '로컬 PC에서만 바뀐 숙제 완료가 보존되지 않았습니다.');
  assert.equal(threeWayItem.completedState['char-3'].currentCount, 1,
    '양쪽에서 같은 숙제 필드를 바꾼 충돌에서 로컬 우선 정책이 지켜지지 않았습니다.');
  assert.equal(threeWay.contentsCheckerItems.some((item: any) => item.id === 'custom-deleted-remotely'), false,
    '원격에서만 삭제한 커스텀 숙제가 다시 살아났습니다.');

  // 교차 업로드에서 먼저 확인된 payload가 직후 다른 PC에 의해 덮인 경우를 재현한다.
  // 회사 PC의 base/local은 이미 자신의 완료를 확인한 상태이고, 원격에는 집 PC의
  // 서로 다른 완료만 남아 있다. operation 재게시 전에 두 변경을 모두 복구해야 한다.
  const crossedCompanyBase = JSON.parse(JSON.stringify(baseChecklist));
  crossedCompanyBase.contentsCheckerItems[0].completedState['char-1'] = {
    isCompleted: true, currentCount: 1, lastCompletedAt: 3000,
  };
  const crossedCompanyLocal = {
    ...sampleLocalConfig,
    ...JSON.parse(JSON.stringify(crossedCompanyBase)),
  };
  const crossedHomeRemote = JSON.parse(JSON.stringify(baseChecklist));
  crossedHomeRemote.contentsCheckerItems[0].completedState['char-2'] = {
    isCompleted: true, currentCount: 1, lastCompletedAt: 3100,
  };
  const companyOperation = {
    id: 'operation-company-complete',
    deviceId: 'company-pc',
    createdAt: 3000,
    keys: ['contentsCheckerItems'],
    mutations: syncDataHelper.createChecklistOperationMutations(baseChecklist, crossedCompanyBase),
  };
  const crossedRemoteWithReplay = syncDataHelper.replayChecklistOperations(
    crossedHomeRemote,
    [companyOperation],
  );
  const crossedMerged = syncDataHelper.mergeChecklistThreeWay(
    crossedCompanyBase,
    crossedCompanyLocal,
    crossedRemoteWithReplay,
  );
  const crossedItem = crossedMerged.contentsCheckerItems.find((item: any) => item.id === 'daily-abyss');
  assert.equal(crossedItem.completedState['char-1'].isCompleted, true,
    '업로드 확인 직후 다른 PC가 덮어쓰면 먼저 확인된 회사 PC 완료가 사라집니다.');
  assert.equal(crossedItem.completedState['char-2'].isCompleted, true,
    '교차 업로드 복구 중 집 PC의 서로 다른 완료가 사라집니다.');

  const crossConflictCases = [
    {
      name: '완료/횟수 충돌',
      base: { isCompleted: false, currentCount: 0 },
      company: { isCompleted: true, currentCount: 1, lastCompletedAt: 4000 },
      home: { isCompleted: false, currentCount: 2, lastCompletedAt: 4100 },
    },
    {
      name: '완료 해제/재완료 충돌',
      base: { isCompleted: true, currentCount: 1, lastCompletedAt: 4200 },
      company: { isCompleted: false, currentCount: 0, lastCompletedAt: 4200 },
      home: { isCompleted: true, currentCount: 2, lastCompletedAt: 4300 },
    },
    {
      name: '횟수 감소/증가 충돌',
      base: { isCompleted: false, currentCount: 2, lastCompletedAt: 4400 },
      company: { isCompleted: false, currentCount: 1, lastCompletedAt: 4400 },
      home: { isCompleted: true, currentCount: 3, lastCompletedAt: 4500 },
    },
  ];
  for (const [index, fixture] of crossConflictCases.entries()) {
    const conflictBase = JSON.parse(JSON.stringify(baseChecklist));
    conflictBase.contentsCheckerItems[0].completedState['char-1'] = fixture.base;
    const conflictCompany = JSON.parse(JSON.stringify(conflictBase));
    conflictCompany.contentsCheckerItems[0].completedState['char-1'] = fixture.company;
    const conflictHome = JSON.parse(JSON.stringify(conflictBase));
    conflictHome.contentsCheckerItems[0].completedState['char-1'] = fixture.home;
    const homeOperation = {
      id: `operation-home-${index}`,
      deviceId: 'home-pc',
      createdAt: 5000 + index,
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(conflictBase, conflictHome),
    };
    const replayedCompanyOperation = JSON.parse(JSON.stringify({
      id: `operation-company-${index}`,
      deviceId: 'company-pc',
      createdAt: 5100 + index,
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(conflictBase, conflictCompany),
    }));
    const convergedRemote = syncDataHelper.replayChecklistOperations(conflictHome, [replayedCompanyOperation]);
    const companyLocal = syncDataHelper.mergeChecklistThreeWay(conflictCompany, {
      ...sampleLocalConfig,
      ...conflictCompany,
    }, convergedRemote);
    const homeLocal = syncDataHelper.mergeChecklistThreeWay(conflictHome, {
      ...sampleLocalConfig,
      ...conflictHome,
    }, convergedRemote);
    assert.deepEqual(companyLocal, homeLocal, `${fixture.name}에서 회사/집 상태가 수렴하지 않았습니다.`);
    const finalPayload = syncDataHelper.buildChecklistSyncPayload({
      ...sampleLocalConfig,
      ...convergedRemote,
    }, 'company-pc', 'generation-cross', [homeOperation, replayedCompanyOperation]);
    assert.equal(syncDataHelper.validateSyncPayload(finalPayload, 'checklist'), true,
      `${fixture.name}의 재수렴 payload가 검증을 통과하지 못했습니다.`);
    assert.deepEqual(finalPayload.operations.map((operation: any) => operation.id),
      [homeOperation.id, replayedCompanyOperation.id],
      `${fixture.name}의 최종 원격 payload에 두 operation ID가 남지 않았습니다.`);
  }

  const dirtySettingsMerged = syncDataHelper.mergeSettingsSnapshot(sampleLocalConfig, settingsPayload, ['userServer']);
  assert.equal(dirtySettingsMerged.userServer, sampleLocalConfig.userServer,
    '아직 업로드하지 않은 로컬 설정이 원격 pull에 의해 사라졌습니다.');

  const driveSource = read('src/modules/googleDriveSync.ts');
  assert.match(driveSource, /SETTINGS_SYNC_FILE_NAME = 'tw_overlay_settings\.json'/);
  assert.match(driveSource, /CHECKLIST_SYNC_FILE_NAME = 'tw_overlay_checklist\.json'/);
  assert.match(driveSource, /META_SYNC_FILE_NAME = 'tw_overlay_sync_meta\.json'/);
  assert.match(driveSource, /export async function findSyncFileByName\(fileName: string\)/,
    '파일 분리를 위한 이름별 Drive 검색 경계가 없습니다.');
  assert.match(driveSource, /export async function uploadJsonPayload\(/,
    '파일 분리를 위한 범용 JSON 업로드 경계가 없습니다.');

  const managerSource = read('src/modules/cloudSyncManager.ts');
  assert.doesNotMatch(managerSource, /findSyncFile\(|uploadSyncPayload\(|downloadSyncPayload\(/,
    '클라우드 매니저가 개발 중 단일 파일 경로를 계속 사용합니다.');
  assert.match(managerSource, /SETTINGS_DEBOUNCE_MS = 1_500/);
  assert.match(managerSource, /CHECKLIST_DEBOUNCE_MS = 500/);
  assert.match(managerSource, /GAME_RUNNING_PULL_MS = 30_000/,
    '게임 실행 중 다른 PC 변경을 받아오는 30초 pull 주기가 없습니다.');
  assert.match(managerSource, /mergeChecklistThreeWay/,
    '마지막 정상 동기화본 기준 숙제 3방향 병합이 실제 전송 경로에 연결되지 않았습니다.');
  assert.match(managerSource, /checklistOutbox/,
    '숙제 변경의 내구 outbox가 실제 전송 경로에 연결되지 않았습니다.');
  assert.match(managerSource, /verifiedIds[\s\S]*?outboxIds\.some/,
    '숙제 operation이 원격에서 확인되기 전에 outbox를 제거할 수 있습니다.');

  const authSource = read('src/modules/googleAuth.ts');
  assert.match(authSource, /const loginGeneration = \+\+_loginGeneration/,
    '취소된 OAuth 콜백의 늦은 토큰 저장을 막는 로그인 세대가 없습니다.');
  assert.match(authSource, /tokens\.access_token && tokens\.expiry_date[\s\S]*?if \(!tokens\.refresh_token\) return null/,
    '유효 access token만 있는 세션을 refresh token 검사보다 먼저 허용하지 않습니다.');
  const driveRequestSource = read('src/modules/googleDriveSync.ts');
  assert.match(driveRequestSource, /cancelPendingRequests/);
  assert.match(driveRequestSource, /response\.status !== 401[\s\S]*?refreshAfterUnauthorized/,
    'Drive 401의 1회 refresh/retry 경계가 없습니다.');

  const cloudSyncDocs = read('docs/google-drive-sync.md');
  for (const key of syncDataHelper.SETTINGS_SYNCABLE_KEYS) {
    assert.ok(cloudSyncDocs.includes(`\`${String(key)}\``),
      `Google Drive 문서에 설정 동기화 키가 누락되었습니다: ${String(key)}`);
  }
  for (const key of syncDataHelper.CHECKLIST_SYNCABLE_KEYS) {
    assert.ok(cloudSyncDocs.includes(`\`${String(key)}\``) || cloudSyncDocs.includes(String(key)),
      `Google Drive 문서에 숙제 동기화 키가 누락되었습니다: ${String(key)}`);
  }
  for (const excluded of ['discordWebhookUrl', 'chatLogPath', 'msgerLogPath', 'customSounds', 'positions']) {
    assert.ok(cloudSyncDocs.includes(`\`${excluded}\``),
      `Google Drive 문서에 중요 제외 키가 누락되었습니다: ${excluded}`);
  }

  const cloudSyncState = require(path.join(projectRoot, 'dist', 'modules', 'cloudSyncState.js'));
  const profileFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-profile-state-'));
  try {
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'fresh');
    fs.writeFileSync(path.join(profileFixture, 'config.json.tmp'), '{}', 'utf8');
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'needs-confirmation');
    fs.rmSync(path.join(profileFixture, 'config.json.tmp'));
    fs.writeFileSync(path.join(profileFixture, 'config.json'), '{}', 'utf8');
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'established');
    fs.rmSync(path.join(profileFixture, 'config.json'));
    fs.writeFileSync(path.join(profileFixture, 'diary.db'), '', 'utf8');
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'needs-confirmation');
    fs.writeFileSync(path.join(profileFixture, 'diary.db'), Buffer.from('SQLite format 3\0', 'utf8'));
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'established');
  } finally {
    fs.rmSync(profileFixture, { recursive: true, force: true });
  }
  cloudSyncState.resetCacheForTests();
  const initialState = cloudSyncState.load();
  assert.equal(typeof initialState.deviceId, 'string');
  cloudSyncState.update((state: any) => {
    state.settingsDirtyKeys = ['userServer'];
    state.checklistOutbox.push({
      id: 'operation-1', deviceId: state.deviceId, createdAt: 1000,
      keys: ['contentsCheckerItems'], mutations: [],
    });
  });
  cloudSyncState.resetCacheForTests();
  const persistedState = cloudSyncState.load();
  assert.deepEqual(persistedState.settingsDirtyKeys, ['userServer']);
  assert.equal(persistedState.checklistOutbox[0].id, 'operation-1');

  // 실제 cloudSyncManager가 분리 파일을 사용하고 다른 PC의 숙제 변경을 echo 없이 받는지 모의 Drive로 검증
  const configModule = require(path.join(projectRoot, 'dist', 'modules', 'config.js'));
  configModule.saveImmediate({
    googleSyncEnabled: true,
    googleSyncAutoSync: true,
    userServer: 16,
    contentsCheckerItems: sampleLocalConfig.contentsCheckerItems,
    characterPresets: sampleLocalConfig.characterPresets,
    pendingHomeworks: [],
  });

  const googleAuth = require(path.join(projectRoot, 'dist', 'modules', 'googleAuth.js'));
  googleAuth.isLoggedIn = () => true;
  googleAuth.loadStoredProfile = () => ({ email: 'integration@example.com' });

  const googleDrive = require(path.join(projectRoot, 'dist', 'modules', 'googleDriveSync.js'));
  const memoryFiles = new Map<string, { id: string; name: string; modifiedTime: string; payload: any }>();
  const downloadedFileIds: string[] = [];
  let nextFileId = 1;
  let uploadCount = 0;
  let loseNextChecklistResponse = false;
  googleDrive.listSyncFiles = async () => Array.from(memoryFiles.values()).map(file => ({
    id: file.id,
    name: file.name,
    modifiedTime: file.modifiedTime,
    size: String(Buffer.byteLength(JSON.stringify(file.payload), 'utf-8')),
  }));
  googleDrive.downloadJsonPayload = async (fileId: string) => {
    downloadedFileIds.push(fileId);
    const file = memoryFiles.get(fileId);
    return file ? structuredClone(file.payload) : null;
  };
  googleDrive.uploadJsonPayload = async (fileName: string, payloadValue: any, existingFileId?: string) => {
    uploadCount++;
    const id = existingFileId || `mock-file-${nextFileId++}`;
    memoryFiles.set(id, {
      id,
      name: fileName,
      modifiedTime: new Date(Date.now() + uploadCount).toISOString(),
      payload: structuredClone(payloadValue),
    });
    if (fileName === 'tw_overlay_checklist.json' && loseNextChecklistResponse) {
      loseNextChecklistResponse = false;
      throw new Error('mock checklist response lost after commit');
    }
    return id;
  };
  googleDrive.cancelPendingRequests = () => undefined;

  cloudSyncState.resetCacheForTests();
  const cloudManager = require(path.join(projectRoot, 'dist', 'modules', 'cloudSyncManager.js'));
  const legacyPayload = { schemaVersion: 1, data: { userServer: 99 }, marker: 'legacy-single-file' };
  memoryFiles.set('legacy-single-file', {
    id: 'legacy-single-file',
    name: 'tw_overlay_sync.json',
    modifiedTime: '2026-08-25T09:00:00.000Z',
    payload: structuredClone(legacyPayload),
  });
  const backupResult = await cloudManager.syncToCloud(true);
  assert.equal(backupResult.success, true);
  const names = Array.from(memoryFiles.values()).map(file => file.name).sort();
  assert.deepEqual(names, [
    'tw_overlay_checklist.json',
    'tw_overlay_settings.json',
    'tw_overlay_sync.json',
    'tw_overlay_sync_meta.json',
  ]);
  assert.equal(downloadedFileIds.includes('legacy-single-file'), false,
    '개발 중 단일 동기화 파일을 정식 입력으로 읽었습니다.');
  assert.deepEqual(memoryFiles.get('legacy-single-file')?.payload, legacyPayload,
    '개발 중 단일 동기화 파일을 분할하거나 다시 업로드했습니다.');
  const uploadedSettings = Array.from(memoryFiles.values()).find(file => file.name === 'tw_overlay_settings.json')!;
  const uploadedChecklist = Array.from(memoryFiles.values()).find(file => file.name === 'tw_overlay_checklist.json')!;
  const currentChecklistFile = () => Array.from(memoryFiles.values())
    .find(file => file.name === 'tw_overlay_checklist.json')!;
  assert.equal(uploadedSettings.payload.data.contentsCheckerItems, undefined,
    '실제 설정 업로드 파일에 숙제 상태가 섞였습니다.');
  assert.equal(uploadedChecklist.payload.data.userServer, undefined,
    '실제 숙제 업로드 파일에 일반 설정이 섞였습니다.');

  const remoteChecklistPayload = structuredClone(uploadedChecklist.payload);
  const remoteItem = remoteChecklistPayload.data.contentsCheckerItems.find((item: any) => item.id === 'daily-abyss');
  remoteItem.completedState['char-2'] = { isCompleted: true, currentCount: 1, lastCompletedAt: 5000 };
  remoteChecklistPayload.lastSyncedAt += 1000;
  remoteChecklistPayload.revision = `${remoteChecklistPayload.lastSyncedAt}-remote-office`;
  remoteChecklistPayload.checksum = syncDataHelper.calculateSyncChecksum(remoteChecklistPayload.data);
  uploadedChecklist.payload = remoteChecklistPayload;
  uploadedChecklist.modifiedTime = new Date(Date.now() + 10_000).toISOString();
  const uploadsBeforePull = uploadCount;

  const pullResult = await cloudManager.syncFromCloud(false);
  assert.equal(pullResult.success, true);
  const received = configModule.load().contentsCheckerItems
    .find((item: any) => item.id === 'daily-abyss').completedState['char-2'];
  assert.equal(received.isCompleted, true,
    '회사 PC의 원격 숙제 완료가 집 PC 자동 pull에 반영되지 않았습니다.');
  assert.equal(received.lastCompletedAt, 5000);
  assert.equal(uploadCount, uploadsBeforePull,
    '원격 숙제 변경을 적용한 직후 불필요한 echo upload가 발생했습니다.');
  assert.equal(cloudSyncState.load().checklistOutbox.length, 0,
    '원격 숙제 적용 직후 파생 설정 저장이 echo outbox를 만들었습니다.');

  // 실제 매니저 흐름: 회사 PC 업로드가 확인된 직후 집 PC payload가 덮어쓴다.
  const beforeCompanyPayload = structuredClone(uploadedChecklist.payload);
  const baselineOperationIds = new Set((beforeCompanyPayload.operations || []).map((operation: any) => operation.id));
  const companyItems = structuredClone(configModule.load().contentsCheckerItems);
  const companyState = companyItems.find((item: any) => item.id === 'daily-abyss').completedState['char-1'];
  companyState.isCompleted = false;
  companyState.currentCount = 0;
  companyState.lastCompletedAt = 6000;
  configModule.saveImmediate({ contentsCheckerItems: companyItems });
  const companyUpload = await cloudManager.syncToCloud(true);
  assert.equal(companyUpload.success, true);
  const companyPayload = structuredClone(currentChecklistFile().payload);
  const companyOperationIds = (companyPayload.operations || [])
    .map((operation: any) => operation.id)
    .filter((id: string) => !baselineOperationIds.has(id));
  assert.ok(companyOperationIds.length >= 1, '회사 PC의 로컬 operation이 payload에 기록되지 않았습니다.');

  const homeData = structuredClone(beforeCompanyPayload.data);
  const homeState = homeData.contentsCheckerItems
    .find((item: any) => item.id === 'daily-abyss').completedState['char-2'];
  homeState.isCompleted = true;
  homeState.currentCount = 2;
  homeState.lastCompletedAt = 6100;
  const homeOperation = {
    id: 'operation-home-overwrite',
    deviceId: 'home-pc',
    createdAt: 6100,
    keys: ['contentsCheckerItems'],
    mutations: syncDataHelper.createChecklistOperationMutations(beforeCompanyPayload.data, homeData),
  };
  const homePayload = syncDataHelper.buildChecklistSyncPayload({
    ...configModule.load(),
    ...homeData,
  }, 'home-pc', companyPayload.generationId, [
    ...(beforeCompanyPayload.operations || []),
    homeOperation,
  ]);
  currentChecklistFile().payload = structuredClone(homePayload);
  currentChecklistFile().modifiedTime = new Date(Date.now() + 20_000).toISOString();

  const crossPull = await cloudManager.syncFromCloud(false);
  assert.equal(crossPull.success, true);
  await cloudManager.flushPendingSync();
  const convergedItem = configModule.load().contentsCheckerItems
    .find((item: any) => item.id === 'daily-abyss');
  assert.equal(convergedItem.completedState['char-1'].isCompleted, false,
    '집 PC overwrite 뒤 회사 PC의 완료 해제가 복원되지 않았습니다.');
  assert.equal(convergedItem.completedState['char-2'].currentCount, 2,
    '회사 PC operation 재게시 중 집 PC의 횟수 변경이 사라졌습니다.');
  const convergedRemoteIds = new Set((currentChecklistFile().payload.operations || [])
    .map((operation: any) => operation.id));
  assert.equal(convergedRemoteIds.has(homeOperation.id), true,
    '최종 원격 payload에서 집 PC operation ID가 사라졌습니다.');
  for (const id of companyOperationIds) {
    assert.equal(convergedRemoteIds.has(id), true,
      `최종 원격 payload에서 회사 PC operation ID가 사라졌습니다: ${id}`);
  }
  let convergedLocalState = cloudSyncState.load();
  assert.equal(convergedLocalState.checklistOutbox.length, 0,
    '재수렴 확인 뒤에도 회사 PC outbox가 남았습니다.');
  assert.equal(convergedLocalState.confirmedChecklistOperations.some((operation: any) => operation.id === homeOperation.id), true,
    '회사 PC 로컬 상태에 집 PC operation ID가 확인 이력으로 남지 않았습니다.');

  // 상태 파일 재로드(앱 재시작 상당) 뒤 같은 overwrite가 다시 발생해도 조용히 재수렴한다.
  cloudSyncState.resetCacheForTests();
  const restartedState = cloudSyncState.load();
  assert.equal(restartedState.confirmedChecklistOperations.some((operation: any) =>
    companyOperationIds.includes(operation.id)), true,
    '재시작 후 회사 PC의 확인 operation 이력이 사라졌습니다.');
  const restartOverwrite = structuredClone(homePayload);
  restartOverwrite.lastSyncedAt += 10_000;
  restartOverwrite.revision = `${restartOverwrite.lastSyncedAt}-restart-overwrite`;
  restartOverwrite.checksum = syncDataHelper.calculateSyncChecksum(restartOverwrite.data);
  currentChecklistFile().payload = restartOverwrite;
  currentChecklistFile().modifiedTime = new Date(Date.now() + 30_000).toISOString();
  await cloudManager.syncFromCloud(false);
  await cloudManager.flushPendingSync();
  const restartedRemoteIds = new Set((currentChecklistFile().payload.operations || [])
    .map((operation: any) => operation.id));
  for (const id of companyOperationIds) {
    assert.equal(restartedRemoteIds.has(id), true,
      `재시작 후 재수렴한 payload에서 회사 PC operation ID가 사라졌습니다: ${id}`);
  }

  // 서버 commit 뒤 응답만 유실되면 outbox를 유지하고, 재시작 시 원격 operation을 확인해 제거한다.
  const responseLossItems = structuredClone(configModule.load().contentsCheckerItems);
  const responseLossState = responseLossItems
    .find((item: any) => item.id === 'daily-abyss').completedState['char-1'];
  responseLossState.isCompleted = true;
  responseLossState.currentCount = 1;
  responseLossState.lastCompletedAt = 7000;
  configModule.saveImmediate({ contentsCheckerItems: responseLossItems });
  loseNextChecklistResponse = true;
  await assert.rejects(cloudManager.syncToCloud(true), /response lost after commit/,
    '업로드 응답 유실 fixture가 실패로 관측되지 않았습니다.');
  assert.ok(cloudSyncState.load().checklistOutbox.length > 0,
    '응답 유실 직후 확인되지 않은 outbox가 제거되었습니다.');
  const uploadsAfterLostResponse = uploadCount;
  cloudSyncState.resetCacheForTests();
  await cloudManager.flushPendingSync();
  assert.equal(uploadCount, uploadsAfterLostResponse,
    '재시작 reconciliation이 이미 commit된 payload를 중복 업로드했습니다.');
  convergedLocalState = cloudSyncState.load();
  assert.equal(convergedLocalState.checklistOutbox.length, 0,
    '재시작 reconciliation 뒤 원격에서 확인된 outbox가 제거되지 않았습니다.');

  // fresh 프로필의 파일별 독립 복원: 손상된 설정 때문에 정상 숙제 복원이 막히지 않아야 한다.
  memoryFiles.clear();
  const partialGeneration = 'generation-partial-restore';
  const remoteFreshChecklist = syncDataHelper.buildChecklistSyncPayload({
    ...configModule.load(),
    characterPresets: [{ id: 'remote-character', name: '원격 캐릭터' }],
    contentsCheckerItems: sampleLocalConfig.contentsCheckerItems,
    pendingHomeworks: sampleLocalConfig.pendingHomeworks,
  }, 'remote-pc', partialGeneration, []);
  memoryFiles.set('corrupt-settings', {
    id: 'corrupt-settings',
    name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T10:00:00.000Z',
    payload: { schemaVersion: 1, kind: 'settings', data: { userServer: 16 } },
  });
  memoryFiles.set('valid-checklist', {
    id: 'valid-checklist',
    name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T10:00:01.000Z',
    payload: remoteFreshChecklist,
  });
  memoryFiles.set('corrupt-meta', {
    id: 'corrupt-meta',
    name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T10:00:02.000Z',
    payload: { schemaVersion: 999 },
  });
  configModule.saveImmediate({
    characterPresets: [{ id: 'local-default', name: '로컬 기본 캐릭터' }],
    contentsCheckerItems: [],
    pendingHomeworks: [],
  });
  cloudSyncState.update((state: any) => {
    state.profileState = 'fresh';
    state.baseChecklist = undefined;
    state.remoteRevisions = {};
    state.checklistOutbox = [];
    state.confirmedChecklistOperations = [];
    state.settingsDirtyKeys = [];
    state.settingsDirtyAt = {};
    state.restoreResults = undefined;
    state.restorePartial = undefined;
  });
  const partialRestore = await cloudManager.syncFromCloud(false);
  assert.equal(partialRestore.success, true);
  assert.equal(partialRestore.partial, true);
  assert.equal(partialRestore.restoreResults.find((result: any) => result.kind === 'settings').status, 'invalid');
  assert.equal(partialRestore.restoreResults.find((result: any) => result.kind === 'checklist').status, 'restored');
  assert.deepEqual(configModule.load().characterPresets, [{ id: 'remote-character', name: '원격 캐릭터' }],
    'fresh 복원이 로컬 기본 캐릭터를 원격 체크리스트에 합쳐 남겼습니다.');
  assert.equal(cloudSyncState.load().profileState, 'needs-confirmation');
  configModule.saveImmediate({ userServer: 7 });
  memoryFiles.get('corrupt-settings')!.payload = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 16,
  }, 'remote-pc', partialGeneration);
  const blockedAutomaticRestore = await cloudManager.syncFromCloud(false);
  assert.equal(blockedAutomaticRestore.profileState, 'needs-confirmation');
  assert.equal(configModule.load().userServer, 7,
    'needs-confirmation 프로필에 클라우드 설정이 자동 적용되었습니다.');

  // 최신 메타가 손상되어도 이전의 유효 메타가 가리키는 중복 파일을 선택한다.
  memoryFiles.clear();
  const duplicateGeneration = 'generation-duplicate-fallback';
  const validSettings = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 13,
  }, 'remote-pc', duplicateGeneration);
  const validChecklist = syncDataHelper.buildChecklistSyncPayload(configModule.load(), 'remote-pc', duplicateGeneration, []);
  memoryFiles.set('valid-settings-older', {
    id: 'valid-settings-older', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T11:00:00.000Z', payload: validSettings,
  });
  memoryFiles.set('corrupt-settings-newer', {
    id: 'corrupt-settings-newer', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T11:00:03.000Z', payload: { invalid: true },
  });
  memoryFiles.set('valid-checklist-duplicate', {
    id: 'valid-checklist-duplicate', name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T11:00:01.000Z', payload: validChecklist,
  });
  memoryFiles.set('valid-meta-older', {
    id: 'valid-meta-older', name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T11:00:02.000Z',
    payload: {
      schemaVersion: 1,
      generationId: duplicateGeneration,
      updatedAt: Date.now(),
      files: {
        settings: { id: 'valid-settings-older', name: 'tw_overlay_settings.json' },
        checklist: { id: 'valid-checklist-duplicate', name: 'tw_overlay_checklist.json' },
      },
    },
  });
  memoryFiles.set('corrupt-meta-newer', {
    id: 'corrupt-meta-newer', name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T11:00:04.000Z', payload: { schemaVersion: 1, generationId: 123 },
  });
  const duplicateRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(duplicateRestore.success, true);
  assert.equal(duplicateRestore.partial, false);
  assert.equal(configModule.load().userServer, 13,
    '손상된 최신 중복 파일 대신 메타가 가리키는 유효 설정 파일을 복원하지 않았습니다.');

  // 메타가 없을 때 최신 세대와 다른 유효 파일은 독립적으로 제외한다.
  memoryFiles.clear();
  const mismatchedSettings = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 5,
  }, 'remote-pc', 'generation-old');
  const newestChecklist = syncDataHelper.buildChecklistSyncPayload(configModule.load(), 'remote-pc', 'generation-new', []);
  memoryFiles.set('mismatch-settings', {
    id: 'mismatch-settings', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T12:00:00.000Z', payload: mismatchedSettings,
  });
  memoryFiles.set('newest-checklist', {
    id: 'newest-checklist', name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T12:00:01.000Z', payload: newestChecklist,
  });
  const mismatchPreview = await cloudManager.getCloudDataPreview();
  assert.equal(mismatchPreview.success, true);
  assert.equal(mismatchPreview.partial, true);
  assert.equal(mismatchPreview.payload.data.characterPresets !== undefined, true,
    'generation 불일치 설정 때문에 정상 숙제 미리보기가 누락되었습니다.');
  assert.equal(mismatchPreview.restoreResults.find((result: any) => result.kind === 'settings').status,
    'generation-mismatch');
  const mismatchRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(mismatchRestore.success, true);
  assert.equal(mismatchRestore.partial, true);
  assert.equal(mismatchRestore.restoreResults.find((result: any) => result.kind === 'settings').status,
    'generation-mismatch');
  assert.equal(mismatchRestore.restoreResults.find((result: any) => result.kind === 'checklist').status,
    'restored');

  // 설정 파일만 존재해도 설정은 복원하고 숙제는 missing으로 분리 보고한다.
  memoryFiles.clear();
  const settingsOnlyPayload = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 21,
  }, 'remote-pc', 'generation-settings-only');
  memoryFiles.set('settings-only', {
    id: 'settings-only', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T13:00:00.000Z', payload: settingsOnlyPayload,
  });
  const settingsOnlyRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(settingsOnlyRestore.success, true);
  assert.equal(settingsOnlyRestore.partial, true);
  assert.equal(settingsOnlyRestore.restoreResults.find((result: any) => result.kind === 'checklist').status, 'missing');
  assert.equal(configModule.load().userServer, 21);

  // 숙제 파일만 존재해도 숙제는 복원하고 설정은 missing으로 분리 보고한다.
  memoryFiles.clear();
  const checklistOnlyPayload = syncDataHelper.buildChecklistSyncPayload({
    ...configModule.load(),
    characterPresets: [{ id: 'checklist-only-character', name: '숙제 전용 캐릭터' }],
  }, 'remote-pc', 'generation-checklist-only', []);
  memoryFiles.set('checklist-only', {
    id: 'checklist-only', name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T13:10:00.000Z', payload: checklistOnlyPayload,
  });
  const checklistOnlyRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(checklistOnlyRestore.success, true);
  assert.equal(checklistOnlyRestore.partial, true);
  assert.equal(checklistOnlyRestore.restoreResults.find((result: any) => result.kind === 'settings').status, 'missing');
  assert.equal(configModule.load().characterPresets.some((character: any) =>
    character.id === 'checklist-only-character'), true);

  // 실제 설정 복원 경로에서도 누락된 신규 기본값과 PC 종속·민감 값은 현재 PC 값을 보존한다.
  memoryFiles.clear();
  configModule.saveImmediate({
    userServer: 3,
    showTodaySummaryHud: false,
    discordWebhookUrl: 'https://discord.com/api/webhooks/local-secret',
    chatLogPath: 'C:\\local\\TalesWeaver\\ChatLog',
    positions: { overlay: { x: 321, y: 654, width: 400, height: 300 } },
    customSounds: [{ name: '로컬 알림음', file: 'custom_local_only.mp3' }],
    wordAlarmSound: 'custom_local_only.mp3',
  });
  const settingsPreservationPayload = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(),
    userServer: 22,
  }, 'remote-pc', 'generation-settings-preservation');
  delete settingsPreservationPayload.data.showTodaySummaryHud;
  settingsPreservationPayload.checksum = syncDataHelper.calculateSyncChecksum(settingsPreservationPayload.data);
  memoryFiles.set('settings-preservation', {
    id: 'settings-preservation',
    name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T13:20:00.000Z',
    payload: settingsPreservationPayload,
  });
  const preservationRestore = await cloudManager.syncFromCloud(true, ['settings']);
  assert.equal(preservationRestore.success, true);
  const preservedConfig = configModule.load();
  assert.equal(preservedConfig.userServer, 22);
  assert.equal(preservedConfig.showTodaySummaryHud, false,
    '클라우드에 없는 설정 키의 기존 false 값이 기본값으로 덮였습니다.');
  assert.equal(preservedConfig.discordWebhookUrl, 'https://discord.com/api/webhooks/local-secret');
  assert.equal(preservedConfig.chatLogPath, 'C:\\local\\TalesWeaver\\ChatLog');
  assert.equal(preservedConfig.positions?.overlay?.x, 321);
  assert.equal(preservedConfig.positions?.overlay?.y, 654);
  assert.equal(preservedConfig.positions?.overlay?.width, 400);
  assert.equal(preservedConfig.positions?.overlay?.height, 300);
  assert.deepEqual(preservedConfig.customSounds, [{ name: '로컬 알림음', file: 'custom_local_only.mp3' }]);
  assert.equal(preservedConfig.wordAlarmSound, 'custom_local_only.mp3');
  const preRestoreBackup = JSON.parse(fs.readFileSync(
    path.join(isolatedUserData, 'config.backup-sync.json'),
    'utf8',
  ));
  assert.equal(preRestoreBackup.userServer, 3,
    '설정 복원 전 로컬 상태가 백업 파일에 보존되지 않았습니다.');
  assert.equal(preRestoreBackup.discordWebhookUrl, 'https://discord.com/api/webhooks/local-secret');
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
checkPendingHomeworkOrdering();
checkLegacyHomeworkMergeContracts();
checkHomeworkSourceEventIdContracts();
checkContentsVisibilityContracts();
checkContentsInitializationContracts();
checkXpExchangeContracts();
checkAbandonedFeeMatchingContracts();
checkMissedMinuteSchedulerContracts();
checkMissedCustomAlertContracts();
checkMissedBossAlertContracts();
void checkGoogleSyncDataContracts().then(() => {
  console.log('Refactor regression checks passed.');
  process.exit(0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});

