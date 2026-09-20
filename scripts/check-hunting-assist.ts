import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-hunting-assist-'));
app.setPath('userData', fixture);
const shared = (name: string) => require(path.join(root, 'dist', 'shared', name + '.js'));
const moduleFile = (name: string) => path.join(root, 'dist', 'modules', name + '.js');

function checkOriginOfDoomDismissal(): void {
  const samples: Record<string, { lines: string[] }> = JSON.parse(fs.readFileSync(
    path.join(root, 'scripts', 'fixtures', 'origin-of-doom-logs.json'), 'utf8'));
  const { chatParser, ChatParser } = require(moduleFile('chatParser'));
  const { ChatLogLineNormalizer } = require(moduleFile('chatLogNormalizer'));
  const iconv = require('iconv-lite');
  const broadcasts: Array<{ channel: string; entries: Array<{ name: string }> }> = [];
  let tick = () => {};
  let schedulerRunning = false;
  require.cache[moduleFile('minuteAlignedScheduler')] = { exports: { MinuteAlignedScheduler: class {
    start(callback: () => void) {
      if (schedulerRunning) return false;
      schedulerRunning = true;
      tick = callback;
      return true;
    }
    stop() { schedulerRunning = false; }
  } } } as NodeModule;
  for (const [name, exports] of Object.entries({
    contentsChecker: { checkReset: () => false },
    analytics: { analytics: { trackEvent() {} } },
    pollingLoop: { getGameStatus: () => 'running' },
    diaryDb: {},
    desktopNotification: { showDesktopNotification() {} },
    windowMessaging: { broadcastToAllWindows: (channel: string, entries: Array<{ name: string }>) => broadcasts.push({ channel, entries }) },
  })) require.cache[moduleFile(name)] = { exports } as NodeModule;
  const config = require(moduleFile('config'));
  config.saveImmediate({ fieldBossNotifyEnabled: true, fieldBossNotifyOffsets: [], bossEntryCountdownBosses: ['파멸의 기원', '혼란한 대지'] });
  const boss = require(moduleFile('bossNotifier'));
  const originalNow = Date.now;
  let now = new Date(2026, 8, 5, 20, 0, 7).getTime();
  Date.now = () => now;
  const feed = (lines: string[], parser = chatParser, encoding = 'euc-kr') => {
    const normalizer = new ChatLogLineNormalizer();
    for (const raw of lines) {
      const decoded = iconv.decode(iconv.encode(raw, encoding), encoding);
      for (const line of normalizer.push(decoded)) parser.parseLine(line);
    }
    for (const line of normalizer.flush()) parser.parseLine(line);
  };
  const visible = () => boss.getBossEntryWindows().map((entry: { name: string }) => entry.name);
  try {
    chatParser.setCurrentDate('2026-09-05');
    boss.start();
    boss.start();
    assert.equal(chatParser.listenerCount('ORIGIN_OF_DOOM_ACTIVITY'), 1, '중복 시작으로 로그 리스너가 늘면 안 됩니다.');
    assert.deepEqual(visible(), ['파멸의 기원']);
    feed(samples.portal.lines);
    feed(samples.exit.lines);
    feed(samples.started.lines.map(line => line.replace('마티아 :', '서클릿의 사제, 마티아 :')));
    feed(samples.started.lines.map(line => line.replace('마티아 :', '테스터 : 마티아 :')));
    for (const color of ['#ffffff', '#c8ffc8', '#64ff64', '#f7b73c', '#94ddfa', '#c896c8']) {
      feed(samples.started.lines.map(line => line.replace('#ff64ff', color)));
      feed(samples.finished.lines.map(line => line.replace('#ff64ff', color)));
    }
    assert.deepEqual(visible(), ['파멸의 기원'], '공지·퇴장·다른 던전·유저 채팅에 반응하면 안 됩니다.');
    chatParser.setCurrentDate('2026-09-04');
    feed(samples.started.lines);
    chatParser.setCurrentDate('2026-09-05');
    feed(samples.started.lines.map(line => line.replace('20시', '11시')));
    feed(samples.started.lines.map(line => line.replace(' 7초', ' 8초')));
    assert.deepEqual(visible(), ['파멸의 기원'], '지난 날짜·이전 회차·미래 시각을 현재 참여로 처리하면 안 됩니다.');
    const historicalParser = new ChatParser();
    historicalParser.setCurrentDate('2026-09-05');
    feed(samples.started.lines, historicalParser);
    assert.deepEqual(visible(), ['파멸의 기원'], '과거 복원용 별도 파서는 현재 HUD에 영향을 주면 안 됩니다.');

    feed(samples.started.lines);
    assert.deepEqual(visible(), []);
    assert.deepEqual(broadcasts.at(-1), { channel: 'boss-entry-update', entries: [] }, '시작 대사를 받자마자 HUD에 제거를 전달해야 합니다.');
    const sent = broadcasts.length;
    feed(samples.started.lines);
    now += 8_000;
    feed(samples.finished.lines);
    assert.equal(broadcasts.length, sent, '중복/종료 로그로 이미 숨긴 회차를 다시 갱신하면 안 됩니다.');
    now += 60_000;
    tick();
    assert.deepEqual(broadcasts.at(-1)?.entries, [], '분 갱신으로 안내가 재등장하면 안 됩니다.');
    config.saveImmediate({ fieldBossNotifyEnabled: false });
    config.saveImmediate({ fieldBossNotifyEnabled: true });
    assert.deepEqual(visible(), []);
    boss.stop();
    assert.equal(chatParser.listenerCount('ORIGIN_OF_DOOM_ACTIVITY'), 0);
    boss.start();
    assert.deepEqual(visible(), [], '알림 서비스 재시작으로 이번 회차가 되살아나면 안 됩니다.');

    now = new Date(2026, 8, 5, 21, 0, 15).getTime();
    assert.deepEqual(visible(), ['혼란한 대지']);
    feed(samples.finished.lines.map(line => line.replace('20시', '21시')));
    chatParser.emit('CONFUSED_LAND_CLEAR', { date: '2026-09-05', timestamp: '21시 0분 15초', message: '감정 균형 장치 방어 보상으로 10000 ELSO를 획득했습니다.' });
    assert.deepEqual(visible(), ['혼란한 대지'], '혼란한 대지 안내는 기존 동작을 유지해야 합니다.');
    now = new Date(2026, 8, 6, 0, 30, 15).getTime();
    chatParser.setCurrentDate('2026-09-06');
    assert.deepEqual(visible(), ['파멸의 기원'], '다음 회차에는 다시 표시해야 합니다.');
    feed(samples.finished.lines.map(line => line.replace('20시  0분', '0시 30분')), chatParser, 'utf8');
    assert.deepEqual(visible(), [], '시작 대사 없이 종료 결과만 받은 경우에도 숨겨야 합니다.');

    now = new Date(2026, 8, 9, 20, 0, 9).getTime();
    chatParser.setCurrentDate('2026-09-09');
    assert.deepEqual(visible(), ['파멸의 기원']);
    config.saveImmediate({ bossEntryCountdownBosses: [] });
    feed(samples.insufficient.lines);
    config.saveImmediate({ bossEntryCountdownBosses: ['파멸의 기원', '혼란한 대지'] });
    assert.deepEqual(visible(), [], '표시를 끈 동안 받은 보상 부족 결과도 회차에 기록해야 합니다.');
    now = new Date(2026, 8, 10, 20, 0, 7).getTime();
    chatParser.setCurrentDate('2026-09-10');
    assert.deepEqual(visible(), ['파멸의 기원']);
    feed([samples.started.lines[0].replace('굴복하십시오</font>', '굴복하십시오!</font>')]);
    assert.deepEqual(visible(), [], '느낌표가 같은 줄에 있는 시작 대사도 감지해야 합니다.');
  } finally {
    boss.stop();
    Date.now = originalNow;
  }
}

async function main(): Promise<void> {
  await app.whenReady();
  const { XpEfficiencyMonitor } = shared('xpEfficiency');
  const monitor = new XpEfficiencyMonitor();
  const warm = (from = 0) => {
    monitor.reset();
    for (let i = 0; i <= 60; i++) assert.equal(monitor.observe(500, from + i * 1000, 20), null);
  };
  warm();
  assert.equal(monitor.state(60_000, true, true).status, 'ready');
  assert.equal(monitor.observe(400, 61_000, 20), null, '정확히 20% 감소한 한 건을 경고하면 안 됩니다.');
  monitor.observe(350, 62_000, 20);
  monitor.observe(500, 63_000, 20);
  assert.equal(monitor.observe(350, 64_000, 20), null, '정상 획득이 끼면 연속 조건이 초기화되어야 합니다.');
  assert.equal(monitor.observe(350, 65_000, 20), null);
  const warning = monitor.observe(350, 66_000, 20);
  assert.ok(warning && warning.dropPercent >= 20 && warning.average > warning.current);
  for (let t = 67_000; t < 126_000; t += 1000) assert.equal(monitor.observe(100, t, 20), null, '60초 쿨타임이 지켜져야 합니다.');
  assert.ok(monitor.observe(100, 126_000, 20), '60초 이후의 지속 감소는 다시 알릴 수 있어야 합니다.');
  warm();
  const before = monitor.state(60_000, true, true);
  monitor.observe(50_000, 61_000, 20);
  const after = monitor.state(61_000, true, true);
  assert.equal(after.average, before.average, '큰 일회성 보상이 기준 평균을 높이면 안 됩니다.');
  assert.equal(after.sampleCount, before.sampleCount);
  assert.equal(monitor.observe(-10_000_000_000, 62_000, 20), null);
  assert.equal(monitor.observe(0, 62_000, 20), null);
  for (let t = 62_000; t <= 370_000; t += 1000) monitor.observe(700, t, 20);
  assert.equal(monitor.state(370_000, true, true).average, 700, '5분보다 오래된 표본이 평균에 남아 있습니다.');
  monitor.state(900_000, true, true); // UI 조회로 모든 버킷이 비워진 경우도 준비 시간을 새로 확보한다.
  monitor.observe(100, 900_001, 20);
  assert.equal(monitor.state(900_001, true, true).warmupSeconds, 60);
  monitor.reset();
  monitor.observe(50_000, 0, 20);
  for (let i = 1; i <= 60; i++) monitor.observe(500, i * 1000, 20);
  assert.equal(monitor.state(60_000, true, true).average, 500, '첫 획득이 큰 보상이어도 기준이 오염되면 안 됩니다.');
  assert.equal(monitor.state(60_000, false, true).status, 'disabled');
  assert.equal(monitor.state(60_000, true, false).status, 'paused');

  const { getActiveBossEntryWindows } = shared('bossEntry');
  const schedule = [{ name: '혼란한 대지', time: '23:59' }, { name: '파멸의 기원', time: '00:00' }];
  const bossConfig = { fieldBossNotifyEnabled: true, bossEntryCountdownBosses: ['혼란한 대지', '파멸의 기원'], fieldBossSettings: { '혼란한 대지': { enabled: true }, '파멸의 기원': { enabled: true } } };
  assert.equal(getActiveBossEntryWindows(schedule, bossConfig, new Date(2026, 8, 12, 23, 58, 59)).length, 0);
  assert.equal(getActiveBossEntryWindows(schedule, bossConfig, new Date(2026, 8, 12, 23, 59)).length, 1);
  assert.equal(getActiveBossEntryWindows(schedule, bossConfig, new Date(2026, 8, 13, 0, 2, 59)).length, 2, '자정을 넘긴 창과 동시 입장 창을 모두 표시해야 합니다.');
  assert.equal(getActiveBossEntryWindows(schedule, bossConfig, new Date(2026, 8, 13, 0, 3)).length, 1);
  assert.equal(getActiveBossEntryWindows(schedule, bossConfig, new Date(2026, 8, 13, 0, 6)).length, 0, '종료 시각에는 안내를 닫아야 합니다.');
  assert.equal(getActiveBossEntryWindows(schedule, { ...bossConfig, bossEntryCountdownBosses: [] }, new Date(2026, 8, 13, 0, 1)).length, 0);
  assert.equal(getActiveBossEntryWindows(schedule, { ...bossConfig, fieldBossNotifyEnabled: false }, new Date(2026, 8, 13, 0, 1)).length, 0);

  // 실제 tracker와 설정 저장 경계를 통과시키되 창과 사운드는 테스트에서 관찰만 한다.
  const sounds: unknown[] = [];
  const messages: Array<{ channel: string; payload: any }> = [];
  require.cache[moduleFile('windowManager')] = { exports: { sendPlaySound: (sound: unknown) => sounds.push(sound) } } as NodeModule;
  require.cache[moduleFile('windowMessaging')] = { exports: {
    broadcastToAllWindows() {},
    sendToFirstWindowByPage(_page: string, channel: string, payload: unknown) { messages.push({ channel, payload }); },
  } } as NodeModule;
  const config = require(moduleFile('config'));
  config.saveImmediate({ xpAutoStart: false, xpAutoPauseEnabled: true, xpAutoPauseSeconds: 60, xpEfficiencyAlertEnabled: true, essenceAlertEnabled: false });
  assert.ok(config.sanitizeExternalConfigPatch({ xpAutoPauseSeconds: 60, xpEfficiencyDropPercent: 20, bossEntryCountdownBosses: [] }));
  assert.equal(config.sanitizeExternalConfigPatch({ xpAutoPauseSeconds: 0 }), null);
  assert.equal(config.sanitizeExternalConfigPatch({ xpEfficiencyDropPercent: 101 }), null);
  assert.equal(config.sanitizeExternalConfigPatch({ bossEntryCountdownBosses: ['없는 보스'] }), null);
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const { xpTracker: tracker } = require(moduleFile('xpTracker'));
    const { chatParser } = require(moduleFile('chatParser'));
    const gain = (amount: number) => chatParser.emit('XP_CHANGED', { amount, message: '테스트', timestamp: '00시 00분 00초' });
    tracker.start();
    tracker.startSession();
    gain(500);
    now += 20_000;
    gain(500);
    now += 59_000;
    tracker.checkMinuteRollover();
    assert.equal(tracker.getStats().isActive, true);
    now += 1_000;
    tracker.checkInactivity();
    let stats = tracker.getStats();
    assert.equal(stats.pauseReason, 'idle');
    assert.equal(stats.accumulatedTime, 20_000, '휴식 감지에 기다린 60초도 측정에서 제외해야 합니다.');
    assert.equal(stats.history.reduce((sum: number, value: number) => sum + value, 0), stats.total, '휴식 시 분 히스토리 보정으로 경험치가 손실됐습니다.');
    const oldEpm = stats.epm;
    now += 120_000;
    assert.equal(tracker.getStats().epm, oldEpm);
    gain(500);
    stats = tracker.getStats();
    assert.equal(stats.isActive, true);
    assert.equal(stats.total, 1500);
    assert.equal(stats.kills, 3);
    assert.equal(stats.accumulatedTime, 20_000);
    assert.equal(stats.efficiency.status, 'warming');
    gain(-10_000_000_000);
    assert.equal(tracker.getStats().essenceCount, 1);
    now += 60_000;
    tracker.checkInactivity();
    tracker.stopSession();
    gain(500);
    assert.equal(tracker.getStats().isActive, false, '수동 정지 후 자동 재개하면 안 됩니다.');
    assert.equal(tracker.getStats().total, 1500);
    assert.equal(tracker.getStats().xpSinceLastExchange, 500, '수동 정지 중에도 정수 경고 누적은 유지해야 합니다.');
    tracker.startSession();
    for (let i = 0; i <= 60; i++) { now += 1000; gain(500); }
    for (let i = 0; i < 3; i++) { now += 1000; gain(350); }
    assert.equal(sounds.length, 1);
    assert.equal(messages.filter(message => message.channel === 'xp-efficiency-alert').length, 2, '게임 HUD와 상세 창에 모두 경고를 보내야 합니다.');
    const beforeReset = tracker.getStats();
    tracker.resetEfficiencyBaseline();
    stats = tracker.getStats();
    assert.equal(stats.total, beforeReset.total);
    assert.equal(stats.kills, beforeReset.kills);
    assert.equal(stats.essenceCount, 1);
    assert.equal(stats.efficiency.warning, null);
    assert.equal(stats.efficiency.status, 'warming');
    config.saveImmediate({ xpAutoPauseEnabled: false });
    now += 120_000;
    tracker.checkInactivity();
    assert.equal(tracker.getStats().isActive, true);
    config.saveImmediate({ xpAutoPauseEnabled: true });
    tracker.checkInactivity();
    tracker.toggleSession();
    gain(500);
    assert.equal(tracker.getStats().pauseReason, 'manual', '자동 휴식 중 정지 단축키도 자동 재개를 해제해야 합니다.');

    // 30분 창이 꽉 찬 뒤의 휴식도 대기 중 밀려난 버킷까지 정확히 복원해야 한다.
    for (const seconds of [30, 60, 300]) {
      config.saveImmediate({ xpAutoPauseSeconds: seconds, xpAutoPauseEnabled: true, xpEfficiencyAlertEnabled: false });
      tracker.resetXp();
      tracker.startSession();
      for (let index = 0; index < 241; index++) { now += 10_000; gain(1000 + index); }
      const beforeIdle = tracker.getStats();
      assert.equal(beforeIdle.history.length, 31);
      for (let second = 0; second < seconds; second++) { now += 1000; tracker.getStats(); }
      const paused = tracker.getStats();
      assert.equal(paused.pauseReason, 'idle');
      assert.deepEqual(paused.history, beforeIdle.history, `${seconds}초 휴식 감지 전후의 실제 사냥 히스토리가 달라졌습니다.`);
      assert.equal(paused.movingEpm, beforeIdle.movingEpm);
      assert.equal(paused.total, beforeIdle.total);
      assert.equal(paused.kills, beforeIdle.kills);
      assert.equal(paused.accumulatedTime, 2_410_000);
      now += 20_000;
      gain(777);
      const resumed = tracker.getStats();
      assert.equal(resumed.isActive, true);
      assert.deepEqual(resumed.history, [...beforeIdle.history.slice(0, -1), beforeIdle.history.at(-1) + 777]);

      // 자동 감지를 오래 껐다 켜도 마지막 획득 이후 시간을 되돌릴 수 있어야 한다.
      config.saveImmediate({ xpAutoPauseEnabled: false });
      now += 3_600_000;
      tracker.getStats();
      config.saveImmediate({ xpAutoPauseEnabled: true });
      assert.deepEqual(tracker.getStats().history, resumed.history);
      tracker.stopSession();
    }
    tracker.startSession();
    gain(999);
    now += 61_000;
    tracker.getStats();
    tracker.resetXp();
    gain(123);
    now += 300_000;
    assert.deepEqual(tracker.getStats().history, [123], '초기화 전에 보관한 휴식 히스토리가 다시 나타나면 안 됩니다.');
    tracker.stopSession();
  } finally { Date.now = originalNow; }
  checkOriginOfDoomDismissal();
  console.log('Hunting assist: rolling average, idle/resume, manual stop, preserved records, warning cooldown, boss deadlines and log-driven dismissal passed.');
  app.exit(0);
}

main().catch(error => { console.error(error); app.exit(1); });
