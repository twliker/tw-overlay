import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-npc-chat-'));
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name + '.js'));
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const raw = (message: string, time = '21시 37분 45초', color = '#ffffff') =>
  `<font size="2" color="white"> [${time}] </font> <font size="2" color="${color}">${message}</font></br>`;
// 2026-09-21 game log: one NPC sentence is physically wrapped with 13 &nbsp tokens.
const first = raw('궤의 사제, 프로에드로스 : 저들을 사형에 처하겠소! 셀리니아코스여 집행을 시작해주');
const continuation = raw('&nbsp '.repeat(13) + '시오!');
const npcLines = [
  raw('검의 사제, 셀리니아코스 : 집행을 시작하겠소.'), first, continuation,
  raw('궤의 사제, 프로에드로스 : 파문이다!!!', '21시 37분 56초'),
  raw('궤의 사제, 프로에드로스 : 네 놈들의 죄는 죽음으로만 씻을 수 있으리라!', '21시 37분 58초'),
];
const normal = raw('일반 시스템 안내는 유지됩니다.', '21시 38분 00초', '#ff6464');
const user = raw('일반유저 : 시오!', '21시 38분 01초');
async function until(win: BrowserWindow, condition: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await win.webContents.executeJavaScript(condition)) return;
    await pause();
  }
  throw new Error(`Timed out: ${condition}`);
}
async function assertNpcDisplay(win: BrowserWindow, context: string): Promise<void> {
  const rows = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.chat-message-row'))
    .filter(row => /^(검의 사제, 셀리니아코스|궤의 사제, 프로에드로스) :/.test(row.querySelector('.chat-text')?.textContent.trim() || '')
      && !row.querySelector('[data-sender-copy]'))
    .map(row => ({ text: row.querySelector('.chat-text').textContent.trim(),
      badge: row.querySelector('.channel-badge')?.textContent ?? null,
      sender: row.querySelector('.chat-sender')?.textContent ?? null,
      separator: row.querySelector('.chat-sender-separator')?.textContent ?? null }))`);
  assert.ok(rows.length > 0, `${context}: 검증할 NPC 대사가 없습니다.`);
  for (const row of rows) {
    assert.equal(row.badge, null, `${context}: NPC 대사에 채널 배지가 붙었습니다.`);
    assert.equal(row.sender, null, `${context}: 원문 앞에 가짜 발신자가 붙었습니다.`);
    assert.equal(row.separator, null, `${context}: 원문 앞에 구분자가 붙었습니다.`);
  }
}
async function main(): Promise<void> {
  await app.whenReady();
  const config = built('modules/config');
  config.saveImmediate({ chatOverlayShowNpcChat: false, chatOverlayOpacity: 100,
    chatOverlayCustomTabs: [{ id: 'custom_npc_test', name: '진행 기록', channels: ['system'], systemColorFilters: [] }],
    chatOverlayTab: 'Basic', chatOverlaySubTab: 'Basic', chatOverlaySub2Tab: 'Basic' });
  built('modules/ipcHandlers').register();
  const manager = built('modules/chatLogManager').chatLogManager;
  const processor = built('modules/chatLogProcessor').chatLogProcessor;
  processor.start();
  const log = path.join(fixture, 'npc.html');
  fs.writeFileSync(log, [normal, user, ...npcLines].join('\n'), 'utf8');
  const snapshot = built('modules/chatLogFileReader').readInitialChatLogSnapshot(log);
  manager._todayLines = snapshot.lines;
  manager.replayTodayLog(snapshot.lines);
  const windows: BrowserWindow[] = [];
  for (const mode of ['main', 'sub1', 'sub2']) {
    const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: {
      preload: path.join(root, 'dist/preload.js'), sandbox: true, contextIsolation: true,
      offscreen: true, backgroundThrottling: false,
    } });
    windows.push(win);
    await win.loadFile(path.join(root, 'dist/chat-overlay.html'));
    win.webContents.send('chat-overlay-mode', mode);
    win.webContents.send('config-data', config.load());
    await until(win, 'isInitialTabLoaded && chatViewItems.length > 0 && !isLoadingMore');
    const visible = await win.webContents.executeJavaScript('chatViewItems.map(item => item.message)');
    assert.equal(visible.some((text: string) => text.includes('프로에드로스') || text.includes('&nbsp')), false,
      `${mode}: 이름이 붙은 NPC 대사 또는 들여쓰기 조각이 노출됐습니다.`);
    assert.deepEqual(visible, ['일반 시스템 안내는 유지됩니다.', '시오!'],
      `${mode}: NPC 표시를 껐는데 잘린 뒷부분이 남았습니다. 유저의 같은 문구는 유지해야 합니다.`);
  }
  const sendConfig = (show: boolean) => {
    config.saveImmediate({ chatOverlayShowNpcChat: show });
    windows.forEach(win => win.webContents.send('config-data', config.load()));
  };
  sendConfig(true);
  for (const [index, win] of windows.entries()) {
    await until(win, 'chatOverlayAppConfig.chatOverlayShowNpcChat === true && !isLoadingMore && chatViewItems.length > 2');
    const messages: string[] = await win.webContents.executeJavaScript('chatViewItems.map(item => item.message)');
    assert.ok(messages.some(text => text.includes('집행을 시작해주시오!')));
    await assertNpcDisplay(win, `window ${index}: 일반 이력`);
    const control = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.chat-message-row'))
      .filter(row => /일반 시스템 안내|일반유저/.test(row.textContent))
      .map(row => [row.querySelector('.channel-badge')?.textContent, row.querySelector('.chat-sender')?.textContent])`);
    assert.deepEqual(control, [['시스템', '시스템'], ['일반', '일반유저']]);
    for (const tab of ['System', 'custom_npc_test']) {
      await win.webContents.executeJavaScript(`selectTab('${tab}')`);
      await until(win, `chatOverlayCurrentTab === '${tab}' && !isLoadingMore && chatViewItems.length >= 4`);
      const tabKey = ['chatOverlayTab', 'chatOverlaySubTab', 'chatOverlaySub2Tab'][index];
      for (let i = 0; i < 100 && config.load()[tabKey] !== tab; i++) await pause();
      assert.equal(config.load()[tabKey], tab);
      sendConfig(false);
      await until(win, 'chatOverlayAppConfig.chatOverlayShowNpcChat === false && !isLoadingMore && chatViewItems.length === 1');
      assert.equal(await win.webContents.executeJavaScript('chatViewItems[0].message'), '일반 시스템 안내는 유지됩니다.');
      sendConfig(true);
      await until(win, '!isLoadingMore && chatViewItems.length >= 4');
      await assertNpcDisplay(win, `window ${index}: ${tab}`);
    }
    await win.webContents.executeJavaScript('executeSearch("시오")');
    await until(win, 'isSearchMode && !isSearching');
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.length'), 1);
    await assertNpcDisplay(win, `window ${index}: 본문 검색`);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".chat-text .search-highlight")?.textContent'), '시오');
    sendConfig(false);
    await until(win, '!isSearching && chatOverlayAppConfig.chatOverlayShowNpcChat === false && chatViewItems.length === 0');
    sendConfig(true);
    await until(win, '!isSearching && chatViewItems.length === 1');
    await assertNpcDisplay(win, `window ${index}: 검색 중 표시 재설정`);
    await win.webContents.executeJavaScript('executeSearch("검의 사제")');
    await until(win, '!isSearching && chatViewItems.length === 1 && chatViewItems[0].message.startsWith("검의 사제")');
    await assertNpcDisplay(win, `window ${index}: NPC 이름 검색`);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".chat-text .search-highlight")?.textContent'), '검의 사제');
    await win.webContents.executeJavaScript('closeSearchBar()');
  }
  // An older page uses the production getMoreHistory reader and the same renderer filter.
  processor.clearHistoryStore();
  manager._todayLines = snapshot.lines;
  manager._initialReadIndex = { Basic: snapshot.lines.length };
  manager._lastReadIndex = {};
  processor.replayChat('Basic', { type: 'system', timestamp: '22시 00분 00초', sender: '시스템', message: '추가 페이지 기준', color: '#ff6464', serverCode: 1 });
  sendConfig(false);
  for (const win of windows) {
    await win.webContents.executeJavaScript('selectTab("Basic")');
    await until(win, '!isLoadingMore && chatViewItems.length === 3');
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.filter(item => item.message.includes("시오")).length'), 1);
  }
  sendConfig(true);
  for (const win of windows) {
    await until(win, '!isLoadingMore && chatViewItems.length === 7');
    await assertNpcDisplay(win, '추가 페이지');
  }
  sendConfig(false);
  for (const win of windows) await until(win, '!isLoadingMore && chatViewItems.length === 3');
  // Live input and a continuation arriving after the normalizer's timer has flushed the first line.
  const parser = built('modules/chatParser').chatParser;
  const { ChatLogLineNormalizer, normalizeChatLogLines } = built('modules/chatLogNormalizer');
  const feed = (lines: string[], flushBetween = false) => {
    const stream = new ChatLogLineNormalizer();
    for (const line of lines) {
      stream.push(line).forEach((value: string) => parser.parseLine(value));
      if (flushBetween) stream.flush().forEach((value: string) => parser.parseLine(value));
    }
    stream.flush().forEach((value: string) => parser.parseLine(value));
  };
  feed([first, continuation]);
  feed([first, continuation], true);
  await pause(150);
  for (const win of windows) {
    assert.equal(await win.webContents.executeJavaScript('chatViewItems.length'), 3, '실시간 NPC 조각이 숨김을 통과했습니다.');
  }
  for (const lines of [
    [first, continuation.replace('21시 37분 45초', '21시 37분 46초')],
    [first, continuation.replace('#ffffff', '#ff6464')],
    [first, raw('다른유저 : 시오!')],
    [first, raw('새 시스템 안내')],
    [first, normal, continuation],
  ]) assert.equal(normalizeChatLogLines(lines).length, lines.length, '서로 다른 로그가 합쳐졌습니다.');
  const stream = new ChatLogLineNormalizer();
  stream.push(first); stream.reset();
  assert.deepEqual(stream.push(continuation).concat(stream.flush()), [continuation], 'reset 이후 이전 NPC가 이어졌습니다.');
  sendConfig(true);
  for (const win of windows) await until(win, 'chatOverlayAppConfig.chatOverlayShowNpcChat === true && !isLoadingMore && chatViewItems.length > 3');
  feed([raw('검의 사제, 셀리니아코스 : 새로 도착한 대사입니다.', '22시 01분 00초')]);
  feed([raw('일반유저 : 검의 사제, 셀리니아코스 : 유저가 인용한 대사', '22시 01분 01초')]);
  for (const win of windows) {
    await until(win, 'chatViewItems.some(item => item.message.includes("유저가 인용한 대사"))');
    await assertNpcDisplay(win, '실시간 수신');
    const quoted = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.chat-message-row'))
      .filter(row => row.textContent.includes('유저가 인용한 대사'))
      .map(row => [row.querySelector('.channel-badge')?.textContent, row.querySelector('.chat-sender')?.textContent])`);
    assert.deepEqual(quoted, [['일반', '일반유저']], 'NPC 이름을 인용한 유저 채팅 표시가 바뀌었습니다.');
  }
  const compact = windows[0];
  config.saveImmediate({ chatCompactDisplay: true });
  sendConfig(true);
  compact.setSize(400, 300);
  await until(compact, 'chatOverlayAppConfig.chatCompactDisplay === true');
  await assertNpcDisplay(compact, '작은 창·간단 표시');
  const compactTexts: string[] = await compact.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.chat-message-row'))
    .filter(row => row.textContent.includes('집행을 시작해주시오!'))
    .map(row => row.innerText.trim())`);
  assert.ok(compactTexts.length > 0);
  assert.ok(compactTexts.every(text => text === '궤의 사제, 프로에드로스 : 저들을 사형에 처하겠소! 셀리니아코스여 집행을 시작해주시오!'));
  compact.setSize(800, 600);
  config.saveImmediate({ chatCompactDisplay: false });
  const output = path.join(root, 'output/npc-chat-filter'); fs.mkdirSync(output, { recursive: true });
  for (const show of [true, false]) {
    sendConfig(show);
    const win = windows[0];
    await until(win, `chatOverlayAppConfig.chatOverlayShowNpcChat === ${show} && !isLoadingMore`);
    for (let i = 0; i < 3; i++) { await pause(150); fs.writeFileSync(path.join(output, show ? 'shown.png' : 'hidden.png'), (await win.webContents.capturePage()).toPNG()); }
  }
  windows.forEach(win => win.destroy());
  console.log('NPC chat: real log normalization, preload/IPC, main/sub1/sub2 history/search/pages/live, plain NPC display, compact view and delayed continuation passed.');
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
