import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-companion-files-'));
const output = path.join(root, 'output/companion-replan-2026-09-20/phase4-screens');
app.setPath('userData', fixture); app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name));
const code = (name: string) => fs.readFileSync(path.join(root, 'dist', name), 'utf8');
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function until(win: BrowserWindow, condition: string): Promise<void> {
  for (let n = 0; n < 100; n++) { if (await win.webContents.executeJavaScript(condition)) return; await pause(); }
  throw new Error(`Timed out: ${condition}`);
}
async function capture(win: BrowserWindow, name: string): Promise<void> {
  await pause(200); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
}
async function main(): Promise<void> {
  await app.whenReady(); fs.mkdirSync(output, { recursive: true });
  const config = built('modules/config.js'), db = built('modules/diaryDb.js'), share = built('modules/settingsShare.js');
  const defaults = built('modules/constants.js').DEFAULT_CONFIG;
  const settings = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { preload: path.join(root, 'dist/preload.js'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  let selectedFile: string | undefined, saveFile: string | undefined, failSave = false, dragging = false, applied = 0;
  let releaseDialog: (() => void) | undefined, delayDialog = false;
  const broadcast = () => settings.webContents.send('config-data', config.load());
  // Real IPC, validation, SQLite, disk snapshot and renderer. Only native dialog selection and
  // runtime application boundary are controlled here; complete native WM is tested in window-visibility.
  built('modules/companionFiles.js').registerCompanionFiles({ settingsWindow: () => settings, isDragging: () => dragging,
    apply: (patch: unknown) => { if (failSave) return { success: false }; const success = config.saveConfirmed(patch); if (success) { applied++; broadcast(); } return { success }; },
    dialogs: {
      showOpenDialog: async () => ({ canceled: !selectedFile, filePaths: selectedFile ? [selectedFile] : [] }),
      showSaveDialog: async () => { if (delayDialog) await new Promise<void>(resolve => { releaseDialog = resolve; }); return { canceled: !saveFile, filePath: saveFile }; },
    },
  });
  ipcMain.on('get-default-config-sync', event => { event.returnValue = defaults; });
  ipcMain.handle('get-config', () => config.load());
  ipcMain.handle('check-chat-log-status', () => ({ isValid: true, isMonitoring: true }));
  ipcMain.handle('diary-get-by-date', (_e, date) => db.getDiaryByDate(date, config.load().lootKeywords));
  ipcMain.handle('diary-get-by-month', (_e, month) => db.getDiariesByMonth(month));
  ipcMain.handle('diary-get-monthly-summary', (_e, month) => db.getMonthlySummary(month, config.load().lootKeywords));
  ipcMain.handle('diary-get-statistics', (_e, month) => db.getMonthlyStatistics(month, config.load().lootKeywords));
  ipcMain.handle('diary-get-monthly-revenue', (_e, month) => db.getMonthlyRevenueData(month));
  config.saveConfirmed({ nicknameNotes: [{ server: 7, nickname: '개인', note: '내 메모' }], pinnedNoteText: '비공개', lootKeywords: ['테스트 득템'], chatCompactDisplay: false });
  const exported = share.captureSharedSettings(config.load(), ['layout', 'appearance', 'alerts']);
  assert.ok(exported.positions.chatOverlay.offsetX !== undefined);
  assert.equal(exported.nicknameNotes, undefined); assert.equal(exported.pinnedNoteText, undefined);
  assert.equal(exported.lootKeywords, undefined); assert.equal(exported.chatOverlayEnabled, undefined);
  const fileData = { format: 'tw-overlay-settings', version: 1, groups: ['layout', 'appearance', 'alerts'], settings: exported };
  assert.deepEqual(share.parseSettingsShare(JSON.stringify(fileData)).settings, exported);
  for (const settings of [{ nicknameNotes: [] }, { pinnedNoteText: 'private' }, { chatCompactDisplay: 'yes' }, { chatOverlayWidth: -1 }, { positions: { chatOverlay: { offsetX: 1, offsetY: 2, secret: 'x' } } }]) {
    assert.throws(() => share.parseSettingsShare(JSON.stringify({ ...fileData, settings })));
  }
  assert.throws(() => share.parseSettingsShare(JSON.stringify({ ...fileData, version: 2 })));
  assert.throws(() => share.parseSettingsShare(JSON.stringify({ ...fileData, settings: { xpWidgetPos: { left: 20, top: 20 } } })));
  assert.throws(() => share.parseSettingsShare(JSON.stringify({ ...fileData, settings: { todaySummaryHudPos: { left: 20, bottom: 20 } } })));
  const custom = share.captureSharedSettings({ chatOverlayFontFamily: `custom:${'a'.repeat(64)}` }, ['appearance']);
  assert.equal(custom.chatOverlayFontFamily, undefined);
  const source = path.join(root, 'dist/settings.html'), page = path.join(fixture, 'settings.html');
  fs.writeFileSync(page, fs.readFileSync(source, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('<head>', `<head><base href="${pathToFileURL(source).href}">`));
  await settings.loadFile(page);
  const js = (script: string) => settings.webContents.executeJavaScript(script);
  await js(code('assets/tailwind.min.js')); await js(code('assets/lucide.min.js'));
  await js(`const card=document.getElementById('settings-share-card'); document.body.replaceChildren(card);document.body.style.overflow='auto';card.style.margin='24px';lucide.createIcons();`);
  await js(code('renderer/settings/sharing.js'));
  saveFile = path.join(fixture, 'export.json');
  assert.equal((await js(`electronAPI.exportSettingsShare(['appearance'])`)).success, true);
  const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  assert.deepEqual(saved.groups, ['appearance']); assert.equal(saved.settings.positions, undefined);
  assert.equal(fs.readdirSync(fixture).some(name => name.endsWith('.tmp')), false);
  saveFile = undefined; assert.equal((await js(`electronAPI.exportSettingsShare(['appearance'])`)).canceled, true);
  assert.equal((await js(`electronAPI.openSettingsShare()`)).canceled, true);
  selectedFile = path.join(fixture, 'import.json');
  fs.writeFileSync(selectedFile, JSON.stringify({ ...fileData, groups: ['appearance'], settings: { chatCompactDisplay: true, chatOverlayFontSize: 18 } }));
  const opened = await js('electronAPI.openSettingsShare()'); assert.ok(opened.token);
  assert.equal((await js(`electronAPI.applySettingsShare(${JSON.stringify(opened.token)})`)).success, false);
  let review = await js(`electronAPI.previewSettingsShare(${JSON.stringify(opened.token)},['appearance'])`);
  assert.equal(review.changes.length, 2);
  config.saveConfirmed({ chatOverlayFontSize: 20 });
  assert.match((await js(`electronAPI.applySettingsShare(${JSON.stringify(opened.token)})`)).error, /다시 비교/);
  review = await js(`electronAPI.previewSettingsShare(${JSON.stringify(opened.token)},['appearance'])`);
  config.saveConfirmed({ pinnedNoteText: '다른 창에서 바꾼 개인 메모' });
  failSave = true; assert.equal((await js(`electronAPI.applySettingsShare(${JSON.stringify(opened.token)})`)).success, false); assert.equal(config.load().chatOverlayFontSize, 20);
  failSave = false; dragging = true; assert.equal((await js(`electronAPI.applySettingsShare(${JSON.stringify(opened.token)})`)).success, false); dragging = false;
  assert.equal((await js(`electronAPI.applySettingsShare(${JSON.stringify(opened.token)})`)).success, true);
  assert.equal(config.load().chatOverlayFontSize, 18); assert.equal(config.load().pinnedNoteText, '다른 창에서 바꾼 개인 메모'); assert.equal(applied, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'config.json'), 'utf8')).chatCompactDisplay, true);
  assert.equal((await js(`electronAPI.applySettingsShare(${JSON.stringify(opened.token)})`)).success, false, '토큰 재사용');
  config.saveConfirmed({ chatCompactDisplay: false, chatOverlayFontSize: 14 });
  await js(`document.getElementById('settings-share-open').click()`);
  await until(settings, `!document.getElementById('settings-share-review').hidden && !document.getElementById('settings-share-compare').disabled`);
  await js(`document.getElementById('settings-share-compare').click()`);
  await until(settings, `!document.getElementById('settings-share-apply').disabled`);
  await capture(settings, 'settings-share-review.png');
  await js(`document.getElementById('settings-share-import-groups').querySelector('input').click()`);
  assert.equal(await js(`document.getElementById('settings-share-apply').disabled`), true);
  await js(`document.getElementById('settings-share-cancel').click()`);
  assert.equal(config.load().chatCompactDisplay, false);
  await js(`document.getElementById('settings-share-open').click()`);
  await until(settings, `!document.getElementById('settings-share-review').hidden && !document.getElementById('settings-share-compare').disabled`);
  await js(`document.getElementById('settings-share-compare').click()`);
  await until(settings, `!document.getElementById('settings-share-apply').disabled`);
  await js(`document.getElementById('settings-share-apply').click()`);
  await until(settings, `document.getElementById('settings-share-status').textContent.startsWith('설정을 적용했습니다')`);
  assert.equal(config.load().chatCompactDisplay, true);
  assert.equal(applied, 2);
  // Real diary records, including pending pouch revenue, hidden auto loot and text needing escaping.
  db.initDb(); db.addManualActivityLog('2026-09-20', '12:00:00', 'calc', '수익', 5000);
  db.addActivityLog('2026-09-20', '12:01:00', 'loot', built('modules/itemAcquisition.js').formatLootDiaryContent('테스트 득템'), 2);
  db.addActivityLog('2026-09-20', '12:02:00', 'loot', '숨겨진 품목 9개', 9);
  db.addManualActivityLog('2026-09-20', '12:03:00', 'memo', '절대로 내보내지 않는 메모');
  db.addManualActivityLog('2026-09-20', '12:04:00', 'homework', '<script>alert(1)</script>', 0);
  db.addManualActivityLog('2026-09-19', '12:00:00', 'calc', '기간 밖', 9999);
  db.getStmt('INSERT INTO homework_logs (date,content_id,content_name,category,type,completed_at) VALUES (?,?,?,?,?,?)').run('2026-09-20', 'daily-test', '채굴장', 'test', 'daily', new Date('2026-09-20T12:00:00').getTime());
  const diary = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { preload: path.join(root, 'dist/preload.js'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await diary.loadFile(path.join(root, 'dist/diary.html'));
  const dj = (script: string) => diary.webContents.executeJavaScript(script);
  assert.equal((await dj(`electronAPI.openSettingsShare()`)).success, false, '다른 창에서 설정 가져오기 허용');
  assert.equal((await js(`electronAPI.previewDiaryExport('2026-09-20','2026-09-20')`)).success, false);
  assert.equal((await dj(`electronAPI.previewDiaryExport('2025-01-01','2025-01-01')`)).count, 0);
  assert.equal(db.getStmt('SELECT COUNT(*) AS count FROM diaries WHERE date=?').get('2025-01-01').count, 0, '빈 기간 조회가 기록을 생성함');
  for (const [start, end] of [['2026-02-30', '2026-03-01'], ['2026-09-21', '2026-09-20'], ['2020-01-01', '2026-09-20']]) assert.equal((await dj(`electronAPI.previewDiaryExport(${JSON.stringify(start)},${JSON.stringify(end)})`)).success, false);
  db.addGoldPouchSeed('2026-09-20', '12:10:00', 1000000);
  await dj(`document.getElementById('diary-export-open').click();document.getElementById('diary-export-start').value='2026-09-20';document.getElementById('diary-export-end').value='2026-09-20';document.getElementById('diary-export-preview').click();`);
  await until(diary, `!document.getElementById('diary-export-save').disabled`);
  assert.match(await dj(`document.getElementById('diary-export-status').textContent`), /5건 · 총수익 1,005,000 SEED/);
  await capture(diary, 'diary-export-preview.png');
  db.addManualActivityLog('2026-09-20', '13:00:00', 'calc', '확인 후 추가', 4000);
  saveFile = path.join(fixture, 'diary.html');
  await dj(`document.getElementById('diary-export-save').click()`);
  await until(diary, `document.getElementById('diary-export-status').textContent.startsWith('저장했습니다')`);
  const html = fs.readFileSync(saveFile, 'utf8');
  assert.ok(html.includes('<td>12:00:00</td><td>숙제</td><td>채굴장</td>'));
  assert.ok(html.includes('1,005,000 SEED')); assert.ok(html.includes('&lt;script&gt;'));
  for (const excluded of ['절대로 내보내지 않는 메모', '숨겨진 품목', '기간 밖', '확인 후 추가', '<script>']) assert.equal(html.includes(excluded), false, excluded);
  const report = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { offscreen: true } });
  await report.loadFile(saveFile); assert.equal(await report.webContents.executeJavaScript('document.querySelectorAll("tbody tr").length'), 5); await capture(report, 'diary-export-file.png');
  await dj(`document.getElementById('diary-export-start').value='2026-09-19';document.getElementById('diary-export-start').dispatchEvent(new Event('input'))`);
  assert.equal(await dj(`document.getElementById('diary-export-save').disabled`), true);
  saveFile = undefined; await dj(`document.getElementById('diary-export-preview').click()`); await until(diary, `!document.getElementById('diary-export-save').disabled`);
  await dj(`document.getElementById('diary-export-save').click()`); await until(diary, `document.getElementById('diary-export-status').textContent.includes('취소')`);
  saveFile = path.join(fixture, 'missing', 'file.html'); await dj(`document.getElementById('diary-export-save').click()`); await until(diary, `document.getElementById('diary-export-status').textContent.includes('처리하지 못')`);
  delayDialog = true; saveFile = undefined; await dj(`document.getElementById('diary-export-save').click()`);
  for (let n = 0; !releaseDialog && n < 100; n++) await pause();
  assert.ok(releaseDialog); assert.equal(await dj(`document.getElementById('diary-export-close').disabled`), true);
  releaseDialog(); await until(diary, `!document.getElementById('diary-export-close').disabled`);
  assert.equal(db.getDiaryByDate('2026-09-20').activityLogs.some((row: any) => row.type === 'memo'), true, '원본 기록 변경');
  // Production diary page, preload, IPC and SQLite statistics; do not replace the date calculation or renderer.
  await dj(`document.getElementById('diary-export-close').click(); currentTab = 'stats';`);
  for (const [month, days] of [['2026-09', 30], ['2026-08', 31], ['2026-02', 28], ['2024-02', 29]] as const) {
    await dj(`(async () => { currentDate = new Date(${JSON.stringify(`${month}-01T12:00:00`)}); await loadStatistics(); })()`);
    const rendered = await dj(`({
      month: document.getElementById('stats-month-label').innerText,
      totalDays: document.getElementById('stats-total-days').innerText,
      heatmapDays: document.getElementById('stats-heatmap').children.length,
    })`);
    assert.deepEqual(rendered, { month: month.replace('-', '. '), totalDays: `/ ${days}일`, heatmapDays: days },
      `${month}: 월간 성실도 분모와 활동 분포는 선택한 월의 실제 일수를 표시해야 합니다.`);
  }
  // Real unpadded game times and numeric pouch revenue without an amount in its display text.
  db.addGoldPouchSeed('2026-09-21', '0:2:20', 2_667_000_000);
  db.addHomeworkLog('2026-09-21', 'time-early', '이른 숙제', 'test', 'daily', new Date('2026-09-21T00:05:00').getTime());
  db.addActivityLog('2026-09-21', '0:10:10', 'elso', '앞선 엘소 획득', 1);
  db.addHomeworkLog('2026-09-21', 'time-middle', '같은 분 중간 숙제', 'test', 'daily', new Date('2026-09-21T00:10:30').getTime());
  db.addActivityLog('2026-09-21', '0:10:47', 'loot', built('modules/itemAcquisition.js').formatLootDiaryContent('테스트 득템'), 1);
  await dj(`(async () => { currentTab='log';currentDate=new Date('2026-09-01T12:00:00');await loadMonthData();await selectDate('2026-09-21'); })()`);
  const readTimeline = () => dj(`Array.from(document.querySelectorAll('#timeline-list > .timeline-item'), el => el.textContent.replace(/\\s+/g,' ').trim())`);
  const dailyTimeline: string[] = await readTimeline();
  assert.equal(dailyTimeline.length, 5);
  assert.match(dailyTimeline[0], /00:02.*26억\s*6700만.*금화 주머니 환산.*26억\s*6700만/,
    '일간 묶음 합계와 펼친 원본 모두 저장된 환산액을 표시해야 합니다.');
  for (const [index, content] of ['이른 숙제', '앞선 엘소 획득', '같은 분 중간 숙제', '테스트 득템'].entries()) {
    assert.ok(dailyTimeline[index + 1].includes(content), '일간 타임라인의 초 단위 실제 순서가 바뀌었습니다.');
  }
  const monthlyPouch = await dj(`Array.from(document.querySelectorAll('#monthly-seed-list > div')).find(el => el.textContent.includes('09-21')).textContent`);
  assert.match(monthlyPouch, /26억\s*6700만.*금화 주머니 환산.*26억\s*6700만/,
    '월간 수익 묶음과 원본 금액이 일간 합계와 다릅니다.');
  await dj(`selectWeek(4, ['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27'], null, 0, 0)`);
  const weeklyTimeline: string[] = await readTimeline();
  assert.equal(weeklyTimeline.length, dailyTimeline.length);
  assert.match(weeklyTimeline[0], /09-21 00:02.*26억\s*6700만/);
  for (const [index, content] of ['이른 숙제', '앞선 엘소 획득', '같은 분 중간 숙제', '테스트 득템'].entries()) {
    assert.ok(weeklyTimeline[index + 1].includes(content), '주간 타임라인이 원본 시각 문자열/숙제 timestamp를 서로 다른 기준으로 정렬합니다.');
  }
  db.closeDb(); for (const win of BrowserWindow.getAllWindows()) win.destroy();
  console.log('Companion files: real preload/IPC, file filtering, stale comparison, failed/canceled/delayed save, SQLite period snapshot, escaped HTML and actual UI passed.');
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
