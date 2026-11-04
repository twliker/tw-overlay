/** Product HTML, preload, registered IPC handlers, SQLite and diary totals. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow, ipcMain } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-stone-revenue-'));
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const built = (name: string) => require(path.join(root, 'dist', name + '.js'));
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const js = (win: BrowserWindow, source: string) => win.webContents.executeJavaScript(source);
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
async function page(name: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { preload: path.join(root, 'dist/preload.js'), contextIsolation: true,
      sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(root, 'dist', name));
  return win;
}

async function main(): Promise<void> {
  await app.whenReady();
  const config = built('modules/config'), db = built('modules/diaryDb');
  config.saveConfirmed({ volumeCalculators: 0 });
  db.initDb();
  let responseCount = 0, release: (() => void) | undefined, gate: Promise<void> | undefined;
  // Delay delivery only; the production IPC validator and SQLite write still run unchanged.
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => register(channel, channel === 'diary-add-activity'
    ? async (event, ...args) => { if (gate) await gate; try { return await listener(event, ...args); } finally { responseCount++; } }
    : listener);
  built('modules/ipcHandlers').register();
  ipcMain.handle = register;
  const stone = await page('magic-stone-calculator.html');
  const failures: string[] = [];
  const expect = (condition: boolean, label: string) => { if (!condition) failures.push(label); };
  await js(stone, `for (const [id,value] of Object.entries({'direct-pouch-count':'2','lower-count':'3','middle-count':'4','upper-count':'5','highest-count':'1'})) {
    const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
  }`);
  assert.equal(await js(stone, `document.getElementById('total-seed').textContent`), '772,500,000');
  await js(stone, `document.getElementById('save-diary-btn').click()`);
  await until(() => responseCount === 1, 'first save response');
  await pause();
  let rows = db.getStmt("SELECT * FROM activity_logs WHERE type='calc'").all();
  assert.equal(rows.length, 1);
  const today: string = rows[0].date;
  const month = today.slice(0, 7);
  expect(rows[0].amount === 772_500_000, '계산기 기록의 실제 amount 누락');
  expect(db.getMonthlySummary(month).totalSeed === 772_500_000, '월간 요약 금액');
  expect(db.getMonthlyStatistics(month).totalSeed === 772_500_000, '월간 통계 금액');
  const diary = await page('diary.html');
  await js(diary, `(async()=>{currentDate=new Date(${JSON.stringify(`${month}-01T12:00:00`)});await loadMonthData();await selectDate(${JSON.stringify(today)});})()`);
  expect(/7\.7억/.test(await js(diary, `document.getElementById('daily-summary-area').textContent`)), '실제 일간 화면 획득 시드');
  await js(diary, `selectWeek(1,[${JSON.stringify(today)}],null,0,0)`);
  expect(/7\.7억/.test(await js(diary, `document.getElementById('daily-summary-area').textContent`)), '실제 주간 화면 획득 시드');
  expect((await js(diary, `electronAPI.previewDiaryExport(${JSON.stringify(today)},${JSON.stringify(today)})`)).totalSeed === 772_500_000, '실제 내보내기 IPC 합계');

  // Reopen to separate feedback timers from failure/delay cases.
  await stone.loadFile(path.join(root, 'dist/magic-stone-calculator.html'));
  await js(stone, `const input=document.getElementById('direct-pouch-count');input.value='2';input.dispatchEvent(new Event('input'));`);
  db.getStmt(`CREATE TRIGGER reject_stone_save BEFORE INSERT ON activity_logs BEGIN SELECT RAISE(ABORT, 'fixture stone save failure'); END`).run();
  await js(stone, `document.getElementById('save-diary-btn').click()`);
  await until(() => responseCount === 2, 'failed SQLite response');
  await pause();
  expect(/실패/.test(await js(stone, `document.getElementById('save-diary-btn').textContent`)), 'SQLite 실패를 완료로 표시');
  expect(await js(stone, `!document.getElementById('save-diary-btn').disabled && document.getElementById('direct-pouch-count').value==='2'`), '저장 실패 후 입력 보존·재시도');
  assert.equal(db.getStmt("SELECT COUNT(*) AS count FROM activity_logs WHERE type='calc'").get().count, 1);
  db.getStmt('DROP TRIGGER reject_stone_save').run();
  gate = new Promise(resolve => { release = resolve; });
  await js(stone, `document.getElementById('save-diary-btn').click(); document.getElementById('save-diary-btn').click();`);
  expect(await js(stone, `document.getElementById('save-diary-btn').disabled && !document.getElementById('save-diary-btn').textContent.includes('완료')`), '지연 중 완료 표시·중복 클릭 방지');
  assert.equal(db.getStmt("SELECT COUNT(*) AS count FROM activity_logs WHERE type='calc'").get().count, 1);
  release!(); gate = undefined;
  await until(() => responseCount >= 3, 'delayed save response');
  await pause(100);
  rows = db.getStmt("SELECT * FROM activity_logs WHERE type='calc'").all();
  expect(rows.length === 2 && rows[1].amount === 1_000_000, '재시도 성공·지연 중복 저장 방지');
  expect((await js(stone, `document.getElementById('save-diary-btn').textContent`)).includes('완료'), '저장 성공 후 완료 표시');

  // Actual diary form: expense sign, positive income, invalid input, and net totals.
  await js(diary, `(async()=>{await selectDate(${JSON.stringify(today)});})()`);
  await js(diary, `document.getElementById('manual-seed-mode').value='expense';
    document.getElementById('manual-seed-desc').value='아이템 구매';
    document.getElementById('manual-seed-amount').value='56800001';
    updateSeedPreview('56800001');`);
  expect((await js(diary, `document.getElementById('manual-seed-preview').textContent`)).startsWith('-'), '지출 미리보기 부호');
  await js(diary, `saveManualSeed(document.querySelector('button[onclick="saveManualSeed(this)"]'))`);
  expect(db.getStmt("SELECT amount FROM activity_logs WHERE content LIKE '%아이템 구매%'").get()?.amount === -56_800_001, '실제 수동 지출 저장');
  const beforeInvalid = db.getStmt('SELECT COUNT(*) AS count FROM activity_logs').get().count;
  await js(diary, `document.getElementById('manual-seed-amount').value='-1';saveManualSeed(document.querySelector('button[onclick="saveManualSeed(this)"]'))`);
  expect(db.getStmt('SELECT COUNT(*) AS count FROM activity_logs').get().count === beforeInvalid, '음수 직접 입력 차단');
  const parser = built('modules/chatParser').chatParser;
  config.saveConfirmed({ abandonedEnabled: false });
  built('modules/chatLogProcessor').chatLogProcessor.start();
  parser.setCurrentDate(today);
  parser.parseLine('<font color="white"> [13시 34분 27초] </font><font>입장료 5,680,001 Seed를 지불하였습니다.</font></br>');
  const fee = db.getStmt("SELECT * FROM activity_logs WHERE content LIKE '%어벤던로드 입장료%'").all();
  expect(fee.length === 1 && fee[0].amount === -5_680_001, 'HUD 비활성 상태에서도 실제 지불 로그 음수 기록');
  expect(db.getMonthlySummary(month).totalSeed === 773_500_000 - 56_800_001 - 5_680_001, '마정석 수익과 지출 순수익');
  const checklist = await page('contents-checker.html');
  checklist.webContents.send('config-data', config.load());
  await until(async () => await js(checklist, 'configData !== null'), '숙제 초기 설정 수신');
  await js(checklist, `collapsedSections.add('일일 숙제');collapsedCategories.add('일일 숙제-기타');document.getElementById('search-input').value='추가';document.getElementById('new-item-name').value='추가 피드백 검사';document.getElementById('btn-add-item').click();`);
  await until(() => config.load().contentsCheckerItems.some((item: { name: string }) => item.name === '추가 피드백 검사'), '실제 숙제 저장');
  checklist.webContents.send('config-data', config.load());
  await until(async () => (await js(checklist, `document.getElementById('custom-item-feedback').textContent`)).includes('추가되었습니다'), '실제 숙제 추가 성공 안내');
  expect(await js(checklist, `!document.getElementById('btn-add-item').disabled && document.getElementById('new-item-name').value === ''`), '추가 확인 후 입력 초기화');

  await pause(800);
  expect(await js(checklist, `document.getElementById('search-input').value === '추가' && !collapsedSections.has('일일 숙제') && !!document.querySelector('[data-item-id]')`), '추가 숙제 검색 보존·그룹 펼침·행 렌더링');
  const addedBounds = await js(checklist, `(()=>{const row=document.querySelector('[data-item-id]');const r=row.getBoundingClientRect();const w=document.querySelector('.matrix-wrapper').getBoundingClientRect();return {top:r.top,bottom:r.bottom,viewTop:w.top,viewBottom:w.bottom};})()`);
  expect(addedBounds.top >= addedBounds.viewTop && addedBounds.bottom <= addedBounds.viewBottom, '추가 숙제 자동 스크롤 후 목록 안에 표시');
  await js(checklist, `if (!isEditMode) toggleEditMode();`);
  const reviewDirectory = path.join(os.tmpdir(), 'tw-overlay-feature-review');
  fs.mkdirSync(reviewDirectory, { recursive: true });
  await js(checklist, `document.getElementById('custom-item-feedback').scrollIntoView({block:'center'});`);
  await pause(200);
  fs.writeFileSync(path.join(reviewDirectory, 'checklist.png'), (await checklist.webContents.capturePage()).toPNG());
  await js(diary, `document.getElementById('manual-seed-amount').value='56800000';updateSeedPreview('56800000');`);
  await pause(200);
  fs.writeFileSync(path.join(reviewDirectory, 'diary.png'), (await diary.webContents.capturePage()).toPNG());

  // Existing zero rows: repair only exact calculator output with matching quantity and money.
  const legacy = [
    ['calc', '💰 마정석 교환: 1,545개 (7억 7250만 시드)', 0, 'manual', 772_500_000],
    ['calc', '💰 마정석 교환: 2개 (100만 시드)', 0, 'legacy-unknown', 1_000_000],
    ['calc', '💰 마정석 교환: 2개 (100만 시드)', 17, 'manual', 17],
    ['calc', '💰 마정석 교환: 2개 (200만 시드)', 0, 'manual', 0],
    ['memo', '💰 마정석 교환: 2개 (100만 시드)', 0, 'manual', 0],
    ['calc', '💰 마정석 교환: -2개 (-100만 시드)', 0, 'manual', 0],
    ['calc', '💰 수익: 마정석 교환 (100만 시드)', 0, 'manual', 0],
  ] as const;
  db.getStmt('INSERT OR IGNORE INTO diaries(date) VALUES(?)').run('2099-12-29');
  const ids = legacy.map(([type, content, amount, source]) => Number(db.getStmt(
    'INSERT INTO activity_logs(date,type,content,time,amount,source) VALUES(?,?,?,?,?,?)')
    .run('2099-12-29', type, content, '12:00:00', amount, source).lastInsertRowid));
  db.getStmt('PRAGMA user_version = 7').run();
  db.closeDb(); db.initDb();
  for (const [index, row] of legacy.entries()) {
    expect(db.getStmt('SELECT amount FROM activity_logs WHERE id=?').get(ids[index]).amount === row[4], `과거 기록 보정 경계 ${index}`);
  }
  const amounts = ids.map(id => db.getStmt('SELECT amount FROM activity_logs WHERE id=?').get(id).amount);
  db.closeDb(); db.initDb();
  assert.deepEqual(ids.map(id => db.getStmt('SELECT amount FROM activity_logs WHERE id=?').get(id).amount), amounts, '과거 보정 반복 적용');
  db.closeDb();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('PASS magic stone: product calculation/save, real IPC/SQLite failure and delay, diary daily/weekly/monthly/export totals, conservative legacy repair.');
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
