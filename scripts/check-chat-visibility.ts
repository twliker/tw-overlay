import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tw-chat-visibility-')));
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name + '.js'));
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const raw = (message: string, color = '#ffffff') => `<font size="2" color="white"> [21시 37분 45초] </font> <font size="2" color="${color}">${message}</font></br>`;
async function until(win: BrowserWindow, condition: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript(condition)) return; await pause(); }
  throw new Error('Timed out: ' + condition);
}
async function main(): Promise<void> {
  await app.whenReady();
  const cfg = built('modules/config'), manager = built('modules/chatLogManager').chatLogManager;
  const processor = built('modules/chatLogProcessor').chatLogProcessor;
  const parser = built('modules/chatParser').chatParser;
  built('modules/ipcHandlers').register(); processor.start();
  const defaults = structuredClone(cfg.load());
  const reset = (patch: Record<string, unknown> = {}) => cfg.saveImmediate({ ...defaults, chatOverlayShowNpcChat: true,
    chatOverlayShowXpGain: true, chatOverlayShowElsoGain: true, chatOverlayBlacklistFilters: [],
    chatOverlayTab: 'Basic', chatOverlaySubTab: 'Basic', chatOverlaySub2Tab: 'Basic', ...patch });
  const feedFile = (lines: string[]) => {
    const file = path.join(app.getPath('userData'), 'chat.html'); fs.writeFileSync(file, lines.join('\n'));
    const snapshot = built('modules/chatLogFileReader').readInitialChatLogSnapshot(file);
    manager._todayLines = snapshot.lines; manager.replayTodayLog(snapshot.lines); return snapshot.lines;
  };
  const open = async (mode: string) => {
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
      preload: path.join(root, 'dist/preload.js'), sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false,
    } });
    await win.loadFile(path.join(root, 'dist/chat-overlay.html'));
    win.webContents.send('chat-overlay-mode', mode); win.webContents.send('config-data', cfg.load());
    await until(win, 'isInitialTabLoaded && !isChatViewLoading && !isLoadingMore'); return win;
  };
  const cases = [
    { name: 'NPC', hidden: raw('검의 사제, 셀리니아코스 : 검색대상'), patch: { chatOverlayShowNpcChat: false } },
    { name: 'NPC 발신자와 외치기 조합', hidden: raw('외치기 : 검색대상 From [마티아]', '#c896c8'), patch: { chatOverlayShowNpcChat: false } },
    { name: 'XP', hidden: raw('경험치가 1,000 올랐습니다. 검색대상', '#ff64ff'), patch: { chatOverlayShowXpGain: false } },
    { name: 'ELSO', hidden: raw('[엘소 1포인트]을(를) 획득하였습니다. 검색대상', '#ff64ff'), patch: { chatOverlayShowElsoGain: false } },
    { name: '제외 문구', hidden: raw('다른유저 : 제외문구 검색대상'), patch: { chatOverlayBlacklistFilters: ['제외문구'] } },
    { name: '제외 정규식', hidden: raw('다른유저 : 제외문구 검색대상'), patch: { chatOverlayBlacklistFilters: ['/제외문구/'] } },
    { name: '통합 채널', hidden: raw('검색대상 시스템 안내', '#ff6464'), patch: { chatOverlaySelectedChannels: ['general'] } },
    ...(['free', 'paid', 'notice'] as const).map(kind => ({ name: kind,
      hidden: raw('외치기 : 검색대상' + (kind === 'free' ? ' From [유저]' : kind === 'paid' ? ' Click [유저]' : ''), '#c896c8'),
      patch: { [kind === 'free' ? 'chatOverlayShowFreeShout' : kind === 'paid' ? 'chatOverlayShowPaidShout' : 'chatOverlayShowNoticeShout']: false } })),
  ];
  for (const test of cases) {
    reset(test.patch); feedFile([raw('일반유저 : 검색대상 오래된 정상 대화'), ...Array(501).fill(test.hidden)]);
    for (const mode of ['main', 'sub1', 'sub2']) {
      const win = await open(mode);
      assert.equal(await win.webContents.executeJavaScript('chatViewItems.length'), 1, test.name + '/' + mode + ' ordinary pages');
      const response = await win.webContents.executeJavaScript('electronAPI.searchChatLogs("검색대상",{category:"Basic",limit:500})');
      assert.equal(response.length, 1, test.name + '/' + mode + ': hidden rows consumed search limit');
      await win.webContents.executeJavaScript('executeSearch("검색대상")'); await until(win, 'isSearchMode && !isSearching');
      assert.equal(await win.webContents.executeJavaScript('chatViewItems[0]?.message'), '검색대상 오래된 정상 대화');
      win.destroy();
    }
  }
  // System and custom-color tabs use the same visibility predicate before the search limit.
  reset({ chatOverlayShowNpcChat: false, chatOverlayCustomTabs: [{ id: 'custom_progress', name: '진행', channels: ['system'], systemColorFilters: ['green'] }] });
  feedFile([raw('검색대상 진행 안내', '#64ff80'), ...Array(501).fill(raw('마티아 : 검색대상', '#ff64ff'))]);
  for (const category of ['System', 'custom_progress']) assert.equal((await manager.searchChatLogs('검색대상', { category, limit: 500 })).length, 1);
  // Real game dialogue names, counter/status messages, and the unindented purple punctuation tail.
  const samples = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/npc-dialogue-logs.json'), 'utf8'));
  const origin = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/origin-of-doom-logs.json'), 'utf8'));
  const colored: string[] = origin.started.lines;
  const ending: string[] = origin.endingDialogue.lines;
  const constants = built('shared/chatConstants');
  for (const row of samples.dialogues) assert.equal(constants.isNpcDialogueSender(row.sender), true);
  for (const row of samples.progress) assert.equal(constants.isNpcDialogueSender(row.sender), false);
  const lines = [...samples.dialogues.map((row: any) => row.raw), ...colored, ...ending, ...samples.progress.map((row: any) => row.raw), raw('일반유저 : 마티아 : 인용한 대사!')];
  reset({ chatOverlayShowNpcChat: false }); const normalized = feedFile(lines);
  for (const mode of ['main', 'sub1', 'sub2']) {
    const win = await open(mode);
    const messages: string[] = await win.webContents.executeJavaScript('chatViewItems.map(item=>item.message)');
    assert.equal(messages.length, samples.progress.length + 1, mode + ': system progress must survive NPC hiding');
    assert.ok(messages.some(message => message.startsWith('남은 공격 횟수 :')));
    assert.ok(messages.includes('마티아 : 인용한 대사!'));
    assert.equal(messages.includes('!'), false);
    assert.equal(messages.includes('니...'), false);
    await win.webContents.executeJavaScript('executeSearch("니...")'); await until(win, '!isSearching');
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.length'), 0, 'Hidden dialogue suffix must not appear in search');
    await win.webContents.executeJavaScript('executeSearch("남은 공격 횟수")'); await until(win, '!isSearching');
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.length'), 1);
    const badges = await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".channel-badge")).map(el=>el.textContent)');
    assert.deepEqual(badges, ['시스템'], 'Progress must retain its system badge');
    if (mode === 'main') {
      const output = path.join(root, 'output/fix-review'); fs.mkdirSync(output, { recursive: true });
      await pause(150); fs.writeFileSync(path.join(output, 'progress-visible.png'), (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript('closeSearchBar()'); await until(win, '!isChatViewLoading && !isLoadingMore');
    // Force the same data through the actual older-page reader.
    processor.clearHistoryStore(); manager._initialReadIndex = { Basic: normalized.length }; manager._lastReadIndex = {};
    processor.replayChat('Basic', { type: 'system', timestamp: '22시 00분 00초', sender: '시스템', message: '추가 페이지 기준', color: '#ff6464', serverCode: 7 });
    await win.webContents.executeJavaScript('selectTab("Basic")'); await until(win, '!isChatViewLoading && !isLoadingMore');
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.length'), samples.progress.length + 2);
    for (const flushBetween of [false, true]) {
      const stream = new (built('modules/chatLogNormalizer').ChatLogLineNormalizer)();
      for (const line of [...colored, ...ending]) { stream.push(line).forEach((row: string) => parser.parseLine(row)); if (flushBetween) stream.flush().forEach((row: string) => parser.parseLine(row)); }
      stream.flush().forEach((row: string) => parser.parseLine(row));
    }
    await pause(150); assert.equal(await win.webContents.executeJavaScript('chatViewItems.some(item=>item.message==="!")'), false);
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.some(item=>item.message==="니...")'), false);
    cfg.saveImmediate({ chatOverlayShowNpcChat: true }); win.webContents.send('config-data', cfg.load());
    await until(win, 'chatOverlayAppConfig.chatOverlayShowNpcChat && !isLoadingMore && !isChatViewLoading');
    await win.webContents.executeJavaScript('executeSearch("굴복하십시오")'); await until(win, '!isSearching');
    assert.ok(await win.webContents.executeJavaScript('chatViewItems.some(item=>item.message.endsWith("굴복하십시오!"))'));
    await win.webContents.executeJavaScript('executeSearch("돌아가다니...")'); await until(win, '!isSearching');
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.length'), 1);
    await until(win, 'document.querySelector(".chat-message-row")?.textContent.includes("돌아가다니...")');
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".chat-message-row .channel-badge").length'), 0);
    if (mode === 'main') {
      await pause(150); fs.writeFileSync(path.join(root, 'output/fix-review/npc-ending-shown.png'), (await win.webContents.capturePage()).toPNG());
    }
    win.destroy(); reset({ chatOverlayShowNpcChat: false }); feedFile(lines);
  }
  const { normalizeChatLogLines, ChatLogLineNormalizer } = built('modules/chatLogNormalizer');
  for (const other of [raw('!', '#ffffff'), colored[1].replace('7초', '8초'), raw('새 시스템 안내', '#ff64ff'), raw('30', '#ff64ff')]) {
    assert.equal(normalizeChatLogLines([colored[0], other]).length, 2, 'Unrelated lines must remain separate');
  }
  const stream = new ChatLogLineNormalizer(); stream.push(colored[0]); stream.reset();
  assert.deepEqual(stream.push(colored[1]).concat(stream.flush()), [colored[1]]);
  // Never hide an unrelated line just because it happens to follow a known speaker.
  for (const [first, second] of [
    [ending[0], ending[1].replace('#ff64ff', '#ffffff')],
    [ending[0], ending[1].replace('15초', '16초')],
    [ending[0], ending[1].replace('니...', '새 시스템 안내')],
    [ending[0], ending[1].replace('니...', '30')],
    [ending[0].replace('돌아가다', '돌아갔습니다.'), ending[1]],
    [ending[0].replace('마티아', '일반유저').replace('#ff64ff', '#c8ffc8'), ending[1].replace('#ff64ff', '#c8ffc8')],
  ]) {
    const normalizer = new ChatLogLineNormalizer();
    assert.deepEqual(normalizer.push(first).concat(normalizer.flush(), normalizer.push(second), normalizer.flush()), [first, second]);
  }
  const delayed = new ChatLogLineNormalizer(); delayed.push(ending[0]); delayed.flush();
  assert.ok(delayed.push(ending[1]).concat(delayed.flush())[0].includes('마티아 : 니...'), 'Late fragment keeps sender without replaying the first event');
  delayed.reset(); assert.deepEqual(delayed.push(ending[1]).concat(delayed.flush()), [ending[1]]);

  // A name accepted by the real settings UI must not shadow any built-in tab in any reader.
  reset({ chatOverlayCustomTabs: [] });
  const settings = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'dist/preload.js'),
    sandbox: true, contextIsolation: true, offscreen: true } });
  await settings.loadFile(path.join(root, 'dist/settings.html')); settings.webContents.send('config-data', cfg.load());
  await until(settings, 'typeof addCustomChatTab === "function" && lastConfig && Array.isArray(lastConfig.chatOverlayCustomTabs)');
  await settings.webContents.executeJavaScript('document.getElementById("custom-tab-name-input").value="System";document.querySelector(".custom-tab-ch-check[value=general]").checked=true;addCustomChatTab();');
  const systemCustom = cfg.load().chatOverlayCustomTabs[0]; assert.equal(systemCustom.name, 'System'); settings.destroy();
  const channels = built('shared/chatChannels');
  const tabs = channels.OVERLAY_BUILT_IN_TABS.map((name: string) => name === 'System' ? systemCustom
    : { id: 'custom_collision_' + name, name: name.toLowerCase(), channels: [name === 'General' ? 'system' : 'general'] });
  const channelLines = [raw('일반유저 : 검색대상 일반'), raw('귓속유저 : 검색대상 귓속말', '#64ff64'),
    raw('팀유저 : 검색대상 팀', '#f7b73c'), raw('클럽유저 : 검색대상 클럽', '#94ddfa'),
    raw('외치기 : 검색대상 외치기 From [외침유저]', '#c896c8'), raw('검색대상 진행 안내', '#64ff80')];
  for (const category of [...channels.OVERLAY_BUILT_IN_TABS, systemCustom.id]) {
    const expectedTypes = category === 'Basic' ? [...channels.OVERLAY_CHANNELS] : [category === systemCustom.id ? 'general' : category.toLowerCase()];
    const expected = expectedTypes.slice().sort();
    for (const mode of ['main', 'sub1', 'sub2']) {
      reset({ chatOverlayCustomTabs: tabs, chatOverlayTab: category, chatOverlaySubTab: category, chatOverlaySub2Tab: category });
      const normalized = feedFile(channelLines);
      const win = await open(mode), js = (code: string) => win.webContents.executeJavaScript(code);
      assert.deepEqual(await js('chatViewItems.map(x=>x.type).sort()'), expected, category + '/' + mode + ' history');
      assert.equal(await js('document.querySelectorAll(".tab-item.active").length'), 1, 'Only the selected tab is active');
      await js('executeSearch("검색대상")'); await until(win, '!isSearching');
      assert.deepEqual(await js('chatViewItems.map(x=>x.type).sort()'), expected, category + '/' + mode + ' search');
      await js('closeSearchBar()'); await until(win, '!isChatViewLoading && !isLoadingMore');
      processor.clearHistoryStore(); manager._initialReadIndex = { [category]: normalized.length }; manager._lastReadIndex = {};
      await js(`selectTab(${JSON.stringify(category)},false)`); await until(win, '!isChatViewLoading && !isLoadingMore');
      assert.deepEqual(await js('chatViewItems.map(x=>x.type).sort()'), expected, category + '/' + mode + ' pages');
      for (const line of channelLines) parser.parseLine(line.replace('검색대상', '실시간검증'));
      await pause(150);
      assert.deepEqual(await js('chatViewItems.filter(x=>x.message.includes("실시간검증")).map(x=>x.type).sort()'), expected, category + '/' + mode + ' live');
      win.destroy();
    }
  }
  assert.equal(channels.resolveOverlayCustomTab('system', tabs).id, systemCustom.id, 'Legacy name lookup remains available outside reserved IDs');
  assert.equal(channels.resolveOverlayCustomTab('choice', [{ id: 'other', name: 'choice', channels: ['system'] }, { id: 'choice', name: '선택', channels: ['general'] }]).id, 'choice');
  console.log(`Chat visibility: ${cases.length} filters × 3 windows, history/search/pages/live, real NPC/status fixtures and delayed colored continuation passed.`);
  console.log('Tab identity: real settings UI accepts duplicate names; all 7 built-in tabs and the custom ID stay independent across 3 windows and history/search/pages/live.');
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
