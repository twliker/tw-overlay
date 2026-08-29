import fs = require('node:fs');
import path = require('node:path');
import { app, BrowserWindow, ipcMain } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'docs', 'screenshot');
const preloadPath = path.join(projectRoot, 'dist', 'preload.js');
const DEFAULT_CONFIG = (require(path.join(projectRoot, 'dist', 'modules', 'constants.js')) as {
  DEFAULT_CONFIG: Record<string, unknown>;
}).DEFAULT_CONFIG;

const characters = [
  { id: 'guide-main', name: '본캐' },
  { id: 'guide-sub', name: '부캐' },
];

const checklistItems = [
  {
    id: 'guide-daily', name: '심연의 보물창고', category: '일일', isVisible: true,
    resetRule: { type: 'daily', hour: 0 }, maxCount: 1,
    completedState: {
      'guide-main': { isCompleted: true, currentCount: 1, lastCompletedAt: Date.now() - 3_600_000 },
      'guide-sub': { isCompleted: false, currentCount: 0 },
    },
  },
  {
    id: 'guide-weekly', name: '이클립스 보스', category: '주간', isVisible: true,
    resetRule: { type: 'weekly', dayOfWeek: 1, hour: 0 }, maxCount: 7,
    completedState: {
      'guide-main': { isCompleted: false, currentCount: 4 },
      'guide-sub': { isCompleted: false, currentCount: 2 },
    },
  },
  {
    id: 'guide-quest', name: '프시키의 미궁', category: '주간', isVisible: true,
    resetRule: { type: 'weekly', dayOfWeek: 1, hour: 0 }, maxCount: 1,
    completedState: {
      'guide-main': { isCompleted: true, currentCount: 1, lastCompletedAt: Date.now() - 7_200_000 },
      'guide-sub': { isCompleted: false, currentCount: 0 },
    },
  },
];

const guideConfig = {
  ...DEFAULT_CONFIG,
  setupCompleted: true,
  hasSeenWelcomeGuide: true,
  chatLogPath: 'C:\\TalesWeaver\\ChatLog',
  characterPresets: characters,
  selectedCharacterId: 'guide-main',
  contentsCheckerItems: checklistItems,
  pendingHomeworks: [],
  sidebarPosition: 'right',
  hiddenMenuIds: [],
  googleSyncEnabled: true,
  googleSyncAutoSync: true,
  googleSyncLastTime: '2026-08-27T08:30:00.000Z',
  googleSyncUserEmail: 'twoverlay.user@example.com',
  focusedChatSelfNickname: '내 캐릭터',
  focusedChatNicknames: ['파티원A', '파티원B'],
  wordAlarmEnabled: true,
  wordAlarmKeywords: ['융합된 기운', '신조의 눈물'],
  discordAlertEnabled: true,
  discordKeywords: ['융합된 기운', '금화 주머니'],
  showXpWidget: true,
  showTodaySummaryHud: true,
  showBuffHud: true,
  showHudShortcuts: true,
  abandonedEnabled: true,
};

const sampleChats = [
  { id: 'guide-chat-1', type: 'club', timestamp: '20시 14분 08초', sender: '파티원A', message: '오늘 숙제 같이 가실 분?', color: '#94ddfa', level: 2, characterCode: null },
  { id: 'guide-chat-2', type: 'system', timestamp: '20시 14분 15초', sender: '시스템', message: '심연의 보물창고를 완료했습니다.', color: '#a8a8a8', level: null, characterCode: null },
  { id: 'guide-chat-3', type: 'whisper', timestamp: '20시 14분 33초', sender: '파티원B', message: '보스방 앞에서 만나요!', color: '#f9a8d4', level: null, characterCode: null },
  { id: 'guide-chat-4', type: 'shout', timestamp: '20시 15분 02초', sender: '거래유저', message: '아퀼루스 장비 판매합니다.', color: '#c896c8', level: 4, characterCode: null },
];

const linkedSyncStatus = {
  isLinked: true,
  isSyncing: false,
  autoSync: true,
  userEmail: 'twoverlay.user@example.com',
  lastSyncAt: '2026-08-27T08:30:00.000Z',
  fileStatuses: [
    { kind: 'settings', localRevision: 'b51ce4a1', remoteRevision: 'b51ce4a1', dirty: false },
    { kind: 'checklist', localRevision: '98fd30c2', remoteRevision: '98fd30c2', dirty: false },
  ],
};

type CaptureDefinition = {
  name: string;
  html?: string;
  url?: string;
  width: number;
  height: number;
  setup?: string;
  events?: Array<[string, unknown]>;
};

const captures: CaptureDefinition[] = [
  { name: 'quickstart-setup.png', html: 'welcome-guide.html', width: 980, height: 760, setup: 'switchTab(0)' },
  { name: 'quickstart-features.png', html: 'welcome-guide.html', width: 980, height: 760, setup: 'switchTab(3)' },
  { name: 'main-sidebar.png', html: 'index.html', width: 320, height: 900, events: [['active-windows', ['contentsChecker']]] },
  { name: 'main-dock.png', html: 'dock.html', width: 900, height: 380, events: [['active-windows', ['contentsChecker', 'swordEnhance']], ['google-sync-status-changed', linkedSyncStatus]] },
  { name: 'contents-checker-overview.png', html: 'contents-checker.html', width: 620, height: 900 },
  { name: 'contents-checker-characters.png', html: 'contents-checker.html', width: 620, height: 900, setup: `document.getElementById('btn-char-mgmt')?.click()` },
  { name: 'contents-checker-pending.png', html: 'contents-checker.html', width: 620, height: 900, setup: `checkAndRenderPendingModal({ pendingHomeworks: [{ id: 'guide-weekly', count: 1, isIncrement: true }], characterPresets: ${JSON.stringify(characters)}, contentsCheckerItems: ${JSON.stringify(checklistItems)} })` },
  { name: 'google-sync-login.png', html: 'settings.html', width: 1100, height: 720, setup: `document.getElementById('loading-overlay')?.remove(); showSection('data', document.querySelector('[data-settings-group="system"]')); updateGoogleSyncUI(${JSON.stringify({ isLinked: false, autoSync: false })})` },
  { name: 'google-sync-connected.png', html: 'settings.html', width: 1100, height: 720, setup: `document.getElementById('loading-overlay')?.remove(); showSection('data', document.querySelector('[data-settings-group="system"]')); updateGoogleSyncUI(${JSON.stringify(linkedSyncStatus)})` },
  { name: 'chat-overlay.png', html: 'chat-overlay.html', width: 620, height: 520, events: [['chat-overlay-mode', 'main']] },
  { name: 'focused-chat.png', html: 'focused-chat.html', width: 540, height: 760 },
  { name: 'experience-hud.png', html: 'xp-hud.html', width: 460, height: 780, events: [['xp-update', { total: 1284500000, epm: 24500000, movingEpm: 23100000, lastGain: 3580000, history: [10, 18, 31, 45, 54, 68, 81, 94], kills: 127, essenceCount: 3, xpSinceLastExchange: 284000000 }]] },
  { name: 'buff-timer-settings.png', html: 'buff-timer.html', width: 900, height: 850 },
  { name: 'boss-settings.png', html: 'boss-settings.html', width: 520, height: 820, events: [['boss-times-data', { '루미너스': ['20:30', '23:30'], '카타콤': ['21:00'] }]] },
  { name: 'game-overlay.png', html: 'game-overlay.html', width: 1000, height: 650, events: [['xp-update', { total: 1284500000, epm: 24500000, movingEpm: 23100000, lastGain: 3580000, history: [18, 31, 45, 54, 68, 81], kills: 127, essenceCount: 3 }], ['buff-timer-update', [{ id: 'exp_heart', name: '경험의 심장', remainingMs: 720000, durationMs: 1200000, active: true }]], ['today-summary-config', guideConfig]] },
  { name: 'diary-calendar.png', html: 'diary.html', width: 1400, height: 920 },
  { name: 'diary-statistics.png', html: 'diary.html', width: 1400, height: 920, setup: `switchTab('stats')` },
  { name: 'stopwatch.png', html: 'stopwatch.html', width: 900, height: 760 },
  { name: 'shout-history.png', html: 'shout-history.html', width: 520, height: 680 },
  { name: 'coefficient-calculator.png', html: 'coefficient-calculator.html', width: 1420, height: 860 },
  { name: 'thesis-core-calculator.png', html: 'thesis-core-calculator.html', width: 900, height: 880 },
  { name: 'hunting-exp-calculator.png', html: 'hunting-exp-calculator.html', width: 980, height: 800 },
  { name: 'relic-calculator.png', html: 'relic-calculator.html', width: 920, height: 760 },
  { name: 'equipment-simulator.png', html: 'equipment-simulator.html', width: 980, height: 840 },
  { name: 'magic-stone-calculator.png', html: 'magic-stone-calculator.html', width: 460, height: 820 },
  { name: 'evolution-calculator.png', html: 'evolution-calculator.html', width: 680, height: 760 },
  { name: 'equipment-dictionary.png', html: 'equipment-dic.html', width: 1120, height: 800 },
  { name: 'equipment-dictionary-detail.png', html: 'equipment-dic.html', width: 1120, height: 800, setup: `document.querySelector('.item-card')?.click()` },
  { name: 'buffs-overview.png', html: 'buffs.html', width: 1080, height: 740, setup: `selectPreset('standard')` },
  { name: 'buffs-tooltip.png', html: 'buffs.html', width: 1080, height: 740, setup: `selectPreset('standard'); document.querySelector('#buff-list .buff-card')?.dispatchEvent(new MouseEvent('mouseenter'))` },
  { name: 'eta-ranking.png', html: 'eta-ranking.html', width: 720, height: 760 },
  { name: 'uniform-color.png', html: 'uniform-color.html', width: 420, height: 820 },
  { name: 'siena-aura.png', html: 'siena-aura.html', width: 1230, height: 930 },
  { name: 'abbreviation.png', html: 'abbreviation.html', width: 620, height: 760 },
  { name: 'sword-enhance.png', url: 'https://twliker.github.io/tw-sword-enhance/', width: 1300, height: 850 },
  { name: 'qte-challenge.png', html: 'qte-challenge.html', width: 980, height: 780, setup: `document.getElementById('challenge-tab')?.click(); document.getElementById('start-button')?.click(); await new Promise(resolve => setTimeout(resolve, 620))` },
  { name: 'hunting-path-simulator.png', html: 'hunting-path-simulator.html', width: 900, height: 820 },
  { name: 'word-alarm.png', html: 'word-alarm.html', width: 520, height: 900 },
  { name: 'discord-alarm.png', html: 'discord-alarm.html', width: 520, height: 900 },
  { name: 'custom-alert.png', html: 'custom-alert.html', width: 640, height: 700 },
  { name: 'scam-detector.png', html: 'scam-detector.html', width: 560, height: 820 },
  { name: 'gallery.png', html: 'gallery.html', width: 520, height: 680, events: [['gallery-connection-status', true], ['gallery-posts', [{ no: 123456, title: '오늘 업데이트 핵심 정리', author: 'TW유저', date: '방금 전', views: 321, commentCount: 12 }]]] },
  { name: 'trade.png', html: 'trade.html', width: 520, height: 680, events: [['trade-connection-status', true], ['trade-posts', [{ id: 'guide-trade-1', title: '아퀼루스 장비 판매합니다', author: '거래유저', date: '방금 전', url: 'https://example.invalid' }]]] },
  { name: 'settings-general.png', html: 'settings.html', width: 1100, height: 720, setup: `document.getElementById('loading-overlay')?.remove(); showSettingsGroup('app', document.querySelector('[data-settings-group="app"]'))` },
  { name: 'settings-game.png', html: 'settings.html', width: 1100, height: 720, setup: `document.getElementById('loading-overlay')?.remove(); showSettingsGroup('game', document.querySelector('[data-settings-group="game"]'))` },
  { name: 'settings-chat-overlay.png', html: 'settings.html', width: 1100, height: 720, setup: `document.getElementById('loading-overlay')?.remove(); showSettingsGroup('chat', document.querySelector('[data-settings-group="chat"]'), 1)` },
  { name: 'settings-data.png', html: 'settings.html', width: 1100, height: 720, setup: `document.getElementById('loading-overlay')?.remove(); showSection('data', document.querySelector('[data-settings-group="system"]')); updateGoogleSyncUI(${JSON.stringify(linkedSyncStatus)})` },
];

function mockInvoke(channel: string): unknown {
  switch (channel) {
    case 'get-config': return guideConfig;
    case 'check-chat-log-status': return true;
    case 'validate-chat-log-path': return { valid: true, path: guideConfig.chatLogPath, reason: '' };
    case 'get-app-version': return '3.0.0';
    case 'get-game-status': return { running: true };
    case 'get-optimization-status': return { enabled: true, isAdmin: true };
    case 'google-sync-get-status': return linkedSyncStatus;
    case 'google-sync-is-logging-in': return false;
    case 'chat-get-history':
    case 'chat-get-more-history':
    case 'focused-chat-get-history': return sampleChats;
    case 'focused-chat-get-state': return { selfNickname: '내 캐릭터', targets: ['파티원A', '파티원B'], knownNicknames: ['파티원A', '파티원B', '클럽원C'] };
    case 'diary-get-shout-history': return [
      { id: 1, timestamp: Date.now() - 60_000, sender: '거래유저', message: '아퀼루스 장비 판매합니다', server: '하이아칸' },
      { id: 2, timestamp: Date.now() - 180_000, sender: '파티모집', message: '이클립스 1팀 구합니다', server: '하이아칸' },
    ];
    case 'word-alarm-get-history': return [
      { id: 1, createdAt: Date.now() - 60_000, keyword: '융합된 기운', sender: '시스템', message: '융합된 기운을 획득했습니다.' },
    ];
    case 'timer-get-records': return [
      { id: 1, title: '이클립스 보스', durationMs: 742_000, startedAt: Date.now() - 900_000, endedAt: Date.now() - 158_000 },
    ];
    case 'xp-get-stats': return { total: 1284500000, epm: 24500000, movingEpm: 23100000, lastGain: 3580000, history: [10, 18, 31, 45, 54, 68, 81, 94], kills: 127, essenceCount: 3 };
    case 'gallery-get-watched': return {};
    case 'gallery-force-check': return { success: true };
    case 'gallery-get-notify': return true;
    case 'trade-force-check': return { success: true };
    case 'trade-get-notify': return true;
    case 'trade-get-server': return '하이아칸';
    case 'trade-get-servers': return [{ id: '하이아칸', name: '하이아칸' }, { id: '네냐플', name: '네냐플' }];
    case 'scam-get-model-status': return { downloaded: true, ready: true, variant: 'cpu' };
    case 'scam-get-constants': return { analysisIntervalSec: 10 };
    case 'scam-get-msger-log-path': return 'C:\\TalesWeaver\\ChatLog\\1to1';
    case 'scam-detect-gpu': return { available: false, recommendedVariant: 'cpu' };
    case 'scam-get-server-status': return { running: true, ready: true };
    case 'scam-get-session-states': return [{ filePath: 'guide-chat.txt', nickname: '거래상대', status: 'safe', riskScore: 8, summary: '의심 표현이 발견되지 않았습니다.' }];
    case 'scam-get-queue-length': return 0;
    case 'get-alarm-logs':
    case 'alarm-get-logs': return [];
    case 'get-hunting-grounds': return [];
    case 'get-hunting-path': return [];
    case 'today-summary-get': return { seed: 78500000, lootCount: 4, homeworkCount: 3, playTimeMs: 7_200_000 };
    case 'diary-get-by-date': return [];
    case 'diary-get-by-month': return [
      { date: '2026-08-04', total_score: 42, daily_done: 5, daily_total: 6, weekly_done: 12, weekly_total: 18 },
      { date: '2026-08-11', total_score: 78, daily_done: 6, daily_total: 6, weekly_done: 15, weekly_total: 18 },
      { date: '2026-08-18', total_score: 115, daily_done: 6, daily_total: 6, weekly_done: 17, weekly_total: 18 },
      { date: '2026-08-24', total_score: 63, daily_done: 4, daily_total: 6, weekly_done: 13, weekly_total: 18 },
      { date: '2026-08-27', total_score: 91, daily_done: 6, daily_total: 6, weekly_done: 16, weekly_total: 18 },
    ];
    case 'diary-get-monthly-summary': return {
      totalSeed: 428500000,
      totalLoots: 19,
      lootList: [
        { date: '2026-08-27', content: '융합된 기운', amount: 2 },
        { date: '2026-08-24', content: '신조의 눈물', amount: 1 },
      ],
      seedList: [
        { date: '2026-08-27', content: '[자동] 금화 주머니 (35,000,000 시드)', amount: 35000000 },
        { date: '2026-08-24', content: '거래 수익 (120,000,000 시드)', amount: 120000000 },
      ],
    };
    case 'diary-get-statistics': return {
      attendanceDays: 18,
      totalBosses: 32,
      totalLoots: 19,
      totalEssences: 7,
      totalElso: 286,
      totalSeed: 428500000,
      grade: 'A',
      heatmap: [
        { date: '2026-08-04', count: 5 }, { date: '2026-08-11', count: 11 },
        { date: '2026-08-18', count: 18 }, { date: '2026-08-24', count: 8 },
        { date: '2026-08-27', count: 14 },
      ],
      topBosses: [{ name: '이클립스', count: 12 }, { name: '어비스', count: 9 }, { name: '루미너스', count: 6 }],
      weeklyActivity: [18, 12, 24, 17, 31, 22, 15],
      weeklySeedList: [62500000, 81000000, 104000000, 126000000, 55000000, 0],
      hourlyActivity: [18, 29, 44, 9],
    };
    case 'diary-get-monthly-revenue': return [
      { date: '2026-08-04', amount: 48500000 },
      { date: '2026-08-11', amount: 72000000 },
      { date: '2026-08-18', amount: 138000000 },
      { date: '2026-08-24', amount: 95000000 },
      { date: '2026-08-27', amount: 75000000 },
    ];
    case 'abandoned-get-state': return { enabled: true, visible: true, totalProfit: 68000000, entryFee: 5000000, stones: { lower: 12, middle: 4, upper: 1, highest: 0 } };
    default: return null;
  }
}

function registerMockIpc(): void {
  ipcMain.on('get-default-config-sync', event => { event.returnValue = guideConfig; });
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'preload.ts'), 'utf8');
  const channels = new Set(Array.from(source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g), match => match[1]));
  channels.forEach(channel => ipcMain.handle(channel, () => mockInvoke(channel)));
}

async function capture(definition: CaptureDefinition): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    width: definition.width,
    height: definition.height,
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    if (definition.url) await window.loadURL(definition.url);
    else if (definition.html) await window.loadFile(path.join(projectRoot, 'dist', definition.html));
    else throw new Error(`Capture source is missing for ${definition.name}`);
    await new Promise(resolve => setTimeout(resolve, 350));
    window.webContents.send('config-data', guideConfig);
    window.webContents.send('google-sync-status-changed', linkedSyncStatus);
    for (const [channel, payload] of definition.events || []) window.webContents.send(channel, payload);
    await new Promise(resolve => setTimeout(resolve, 250));
    if (definition.setup) {
      await window.webContents.executeJavaScript(`(async () => { ${definition.setup} })()`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    window.showInactive();
    window.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 180));
    const image = await window.capturePage();
    fs.writeFileSync(path.join(outputDirectory, definition.name), image.toPNG());
    window.hide();
    console.log(`[GUIDE_CAPTURE] ${definition.name}`);
  } finally {
    window.destroy();
  }
}

async function main(): Promise<void> {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  await app.whenReady();
  const keeperWindow = new BrowserWindow({ show: false, width: 1, height: 1 });
  fs.mkdirSync(outputDirectory, { recursive: true });
  registerMockIpc();
  try {
    const requestedNames = new Set(process.argv.slice(2));
    const selectedCaptures = requestedNames.size > 0
      ? captures.filter(definition => requestedNames.has(definition.name))
      : captures;
    if (requestedNames.size > 0 && selectedCaptures.length !== requestedNames.size) {
      const knownNames = new Set(captures.map(definition => definition.name));
      const unknownNames = Array.from(requestedNames).filter(name => !knownNames.has(name));
      throw new Error(`Unknown guide capture: ${unknownNames.join(', ')}`);
    }
    for (const definition of selectedCaptures) await capture(definition);
  } finally {
    keeperWindow.destroy();
  }
  app.quit();
}

main().catch(error => {
  console.error('[GUIDE_CAPTURE] failed', error);
  app.exit(1);
});
