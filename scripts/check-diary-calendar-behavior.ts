import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const testUserDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-diary-calendar-test-'));

async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

function buildTestHtml(): string {
  const diaryHtml = fs.readFileSync(path.join(projectRoot, 'src', 'diary.html'), 'utf8');
  const style = diaryHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(style, '모험일지 달력 스타일을 찾을 수 없습니다.');

  const expansionScript = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'diary', 'calendar-cell-expansion.js'),
    'utf8',
  );
  const groupingScript = fs.readFileSync(
    path.join(projectRoot, 'dist', 'renderer', 'diary', 'calendar-loot-grouping.js'),
    'utf8',
  );
  const badges = Array.from({ length: 8 }, (_, index) => `<div class="loot-badge">아이템 ${index + 1}</div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${style}
    * { box-sizing: border-box; }
    body { margin: 0; }
    .calendar-grid { width: 960px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .loot-badge { box-sizing: border-box; height: 18px; flex: 0 0 18px; }
  </style></head><body>
    <div id="calendar-grid" class="calendar-grid">
      <div id="overflow-cell" class="calendar-cell" data-calendar-day="2026-08-27" data-calendar-row="1">
        <div class="date-num">27</div>
        <div class="loot-stack">${badges}</div>
        <button id="overflow-toggle" type="button" class="calendar-cell-toggle" hidden aria-expanded="false" aria-label="득템 목록 더보기"><span class="calendar-cell-toggle-label">더보기</span></button>
      </div>
      <div id="short-cell" class="calendar-cell" data-calendar-day="2026-08-28" data-calendar-row="1">
        <div class="date-num">28</div>
        <div class="loot-stack"><div class="loot-badge">아이템 하나</div></div>
        <button id="short-toggle" type="button" class="calendar-cell-toggle" hidden aria-expanded="false" aria-label="득템 목록 더보기"><span class="calendar-cell-toggle-label">더보기</span></button>
      </div>
      <div id="week-cell" class="calendar-cell week" data-calendar-row="1">주간 상세</div>
      <div id="other-row-cell" class="calendar-cell" data-calendar-day="2026-09-03" data-calendar-row="2">
        <div class="date-num">3</div>
        <div class="loot-stack"><div class="loot-badge">다른 주 아이템</div></div>
        <button type="button" class="calendar-cell-toggle" hidden aria-expanded="false" aria-label="득템 목록 더보기"><span class="calendar-cell-toggle-label">더보기</span></button>
      </div>
    </div>
    <script>${groupingScript}</script>
    <script>${expansionScript}</script>
    <script>window.diaryCalendarExpansion.refresh(document.getElementById('calendar-grid'));</script>
  </body></html>`;
}

async function main(): Promise<void> {
  app.setPath('userData', testUserDataDirectory);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1100, height: 700 });

  try {
    await window.loadURL(`data:text/html;base64,${Buffer.from(buildTestHtml()).toString('base64')}`);
    await waitFor(window, '!document.getElementById("overflow-toggle").hidden', '넘치는 날짜의 더보기 버튼이 표시되지 않았습니다.');

    const groupedLoot = await window.webContents.executeJavaScript(`(() => {
      const source = [
        ['[경험의 심장]을(를) 10개 습득했습니다.', 'heart.png'],
        ['[룬 경험의 심장]을(를) 10개 습득했습니다.', 'rune-heart.png'],
        ['[경험의 심장]을(를) 3개 습득했습니다.', 'heart.png'],
        ['[경험의 심장]을(를) 3개 습득했습니다.', 'heart.png']
      ];
      return window.diaryCalendarLootGrouping.group(source.map(([content, img]) => {
        const parsed = window.diaryCalendarLootGrouping.parseAcquisition(content);
        return { name: parsed.name, count: Number(parsed.countText), img };
      }));
    })()`);
    assert.deepEqual(groupedLoot, [
      { name: '경험의 심장', count: 16, img: 'heart.png' },
      { name: '룬 경험의 심장', count: 10, img: 'rune-heart.png' },
    ], '달력에서 같은 경험의 심장은 합산하고 룬 경험의 심장은 별도로 유지하지 못했습니다.');

    const initial = await window.webContents.executeJavaScript(`(() => {
      const overflowCell = document.getElementById('overflow-cell');
      const shortCell = document.getElementById('short-cell');
      const button = document.getElementById('overflow-toggle');
      return {
        buttonTag: button.tagName,
        buttonType: button.type,
        expanded: button.getAttribute('aria-expanded'),
        label: button.textContent.trim(),
        shortButtonHidden: document.getElementById('short-toggle').hidden,
        overflowHeight: Math.round(overflowCell.getBoundingClientRect().height),
        shortHeight: Math.round(shortCell.getBoundingClientRect().height),
        weekHeight: Math.round(document.getElementById('week-cell').getBoundingClientRect().height),
        otherRowHeight: Math.round(document.getElementById('other-row-cell').getBoundingClientRect().height),
      };
    })()`);
    assert.deepEqual(initial, {
      buttonTag: 'BUTTON',
      buttonType: 'button',
      expanded: 'false',
      label: '더보기',
      shortButtonHidden: true,
      overflowHeight: 120,
      shortHeight: 120,
      weekHeight: 120,
      otherRowHeight: 120,
    }, '초기 접힘 상태 또는 실제 overflow 판정이 올바르지 않습니다.');

    await window.webContents.executeJavaScript(`document.getElementById('overflow-toggle').click()`);
    await waitFor(window, 'document.getElementById("overflow-cell").classList.contains("expanded")', '날짜를 펼치지 못했습니다.');

    const expanded = await window.webContents.executeJavaScript(`(() => {
      const overflowCell = document.getElementById('overflow-cell');
      const shortCell = document.getElementById('short-cell');
      const button = document.getElementById('overflow-toggle');
      return {
        expanded: button.getAttribute('aria-expanded'),
        label: button.textContent.trim(),
        overflowHeight: Math.round(overflowCell.getBoundingClientRect().height),
        shortHeight: Math.round(shortCell.getBoundingClientRect().height),
        shortExpanded: shortCell.classList.contains('expanded'),
        weekExpanded: document.getElementById('week-cell').classList.contains('expanded'),
        weekHeight: Math.round(document.getElementById('week-cell').getBoundingClientRect().height),
        otherRowExpanded: document.getElementById('other-row-cell').classList.contains('expanded'),
        otherRowHeight: Math.round(document.getElementById('other-row-cell').getBoundingClientRect().height),
      };
    })()`);
    assert.equal(expanded.expanded, 'true', '펼친 버튼의 aria-expanded가 갱신되지 않았습니다.');
    assert.equal(expanded.label, '접기', '펼친 버튼이 접기로 바뀌지 않았습니다.');
    assert.ok(expanded.overflowHeight > 120, '펼친 날짜에 모든 득템이 표시되지 않습니다.');
    assert.equal(expanded.shortExpanded, true, '같은 행의 다른 날짜가 함께 펼쳐지지 않았습니다.');
    assert.equal(expanded.weekExpanded, true, '같은 행의 주간 셀이 함께 펼쳐지지 않았습니다.');
    assert.equal(expanded.shortHeight, expanded.overflowHeight, '같은 행의 날짜 높이가 일치하지 않습니다.');
    assert.equal(expanded.weekHeight, expanded.overflowHeight, '같은 행의 주간 셀 높이가 일치하지 않습니다.');
    assert.equal(expanded.otherRowExpanded, false, '다른 주의 날짜까지 함께 펼쳐졌습니다.');
    assert.equal(expanded.otherRowHeight, 120, '다른 주의 날짜 높이가 변경됐습니다.');

    await window.webContents.executeJavaScript(`(() => {
      const stack = document.querySelector('#overflow-cell .loot-stack');
      Array.from(stack.children).slice(1).forEach(child => child.remove());
    })()`);
    await window.setSize(1090, 700);
    await waitFor(window, 'document.getElementById("overflow-toggle").hidden', 'resize 후 사라진 overflow가 다시 판정되지 않았습니다.');

    const resized = await window.webContents.executeJavaScript(`(() => ({
      expanded: document.getElementById('overflow-cell').classList.contains('expanded'),
      shortExpanded: document.getElementById('short-cell').classList.contains('expanded'),
      weekExpanded: document.getElementById('week-cell').classList.contains('expanded'),
      ariaExpanded: document.getElementById('overflow-toggle').getAttribute('aria-expanded'),
      height: Math.round(document.getElementById('overflow-cell').getBoundingClientRect().height),
    }))()`);
    assert.deepEqual(resized, {
      expanded: false,
      shortExpanded: false,
      weekExpanded: false,
      ariaExpanded: 'false',
      height: 120,
    },
      'resize 재판정 뒤 불필요한 펼침 상태가 남았습니다.');

    console.log('Diary calendar collapse behavior checks passed.');
  } finally {
    if (!window.isDestroyed()) window.destroy();
    try {
      fs.rmSync(testUserDataDirectory, { recursive: true, force: true });
    } catch {
      // Electron 종료 직전 잠긴 임시 파일은 운영체제의 임시 폴더 정리에 맡깁니다.
    }
    app.quit();
  }
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
