import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import ts = require('typescript');
import { createRequire } from 'node:module';
import { app, BrowserWindow } from 'electron';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-companion-'));
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const root = path.resolve(__dirname, '..');
const built = (file: string) => require(path.join(root, 'dist', file));

function isolatedModule(name: string, mocks: Record<string, any>): any {
  const filename = path.join(root, 'dist/modules', `${name}.js`);
  const local = { exports: {} }, nativeRequire = createRequire(filename);
  const wrapper = vm.runInThisContext(`(function(exports,require,module,__dirname,__filename){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  wrapper(local.exports, (key: string) => Object.prototype.hasOwnProperty.call(mocks, key) ? mocks[key] : nativeRequire(key), local, path.dirname(filename), filename);
  return local.exports;
}

function checkDetectedHomeworkSummary(cfg: any): void {
  const original = cfg.load();
  const checker = isolatedModule('contentsChecker', {
    './windowManager': { applySettings() {} },
    './diaryDb': { addHomeworkLog: () => true, removeHomeworkLog: () => true, updateHomeworkStats: () => true },
  });
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const timestamp = today.getTime();
  const daily = { id: 'detected-daily', name: '설계자의 채굴장', category: '내실', isVisible: true,
    resetRule: { type: 'daily', hour: 0 }, maxCount: 1, completedState: {} };
  const weekly = { ...daily, id: 'detected-weekly', name: '주간 숙제', maxCount: 7,
    resetRule: { type: 'weekly', dayOfWeek: today.getDay(), hour: 0 },
    completedState: { A: { currentCount: 0, isCompleted: false }, B: { currentCount: 3, isCompleted: false } } };
  const read = (at = timestamp + 10_000) => checker.getLatestDetectedHomework(cfg.load(), at);
  try {
    cfg.saveImmediate({ characterPresets: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
      contentsCheckerItems: [daily, weekly], pendingHomeworks: [], contentsAutoAssignSingleCandidate: false });
    assert.equal(read(), null);
    checker.updateItemCount(daily.id, 'A', 1);
    assert.equal(read(), null, '수동 체크가 자동 감지 한 줄을 생성하면 안 됩니다.');
    checker.queuePendingHomework(weekly.id, 1, true, 'summary-one', timestamp);
    checker.queuePendingHomework(weekly.id, 1, true, 'summary-two', timestamp + 1000);
    checker.queuePendingHomework(weekly.id, 1, true, 'summary-two', timestamp + 1000);
    assert.deepEqual(read(), { name: weekly.name, currentCount: 2, maxCount: 7 }, '보류 증분과 동일 이벤트 중복을 구분합니다.');
    checker.applyPendingHomeworks('B');
    assert.deepEqual(read(), { name: weekly.name, currentCount: 5, maxCount: 7 }, '선택한 캐릭터의 기존 진행도에 반영한 횟수를 보여야 합니다.');
    checker.updateItemCount(daily.id, 'B', 1);
    assert.equal(read().name, weekly.name, '수동으로 다른 숙제를 바꿔도 최근 감지 제목은 유지합니다.');
    checker.queuePendingHomework(daily.id, 1, true, 'older-summary', timestamp - 1000);
    assert.equal(read().name, weekly.name, '늦게 도착한 오래된 이벤트가 최신 감지를 덮어쓰면 안 됩니다.');
    checker.clearPendingHomeworks();
    cfg.saveImmediate({ characterPresets: [{ id: 'B', name: 'B' }] });
    checker.queuePendingHomework(weekly.id, 1, true, 'single-summary', timestamp + 2000);
    assert.deepEqual(read(), { name: weekly.name, currentCount: 6, maxCount: 7 }, '단일 캐릭터 즉시 반영도 누락하면 안 됩니다.');
    checker.queuePendingHomework(weekly.id, 7, false, 'absolute-summary', timestamp + 3000);
    assert.equal(read().currentCount, 7, '절대 횟수 감지는 기존 진행도에 다시 더하지 않습니다.');
    checker.queuePendingHomework(daily.id, 1, true, 'daily-summary', timestamp + 4000);
    assert.deepEqual(read(), { name: daily.name, currentCount: 1, maxCount: 1 }, '이미 완료된 단일 캐릭터의 새 감지도 표시합니다.');
    const hidden = cfg.load(); hidden.contentsCheckerItems.find((item: any) => item.id === daily.id).isVisible = false;
    assert.equal(checker.getLatestDetectedHomework(hidden, timestamp + 5000), null);
    assert.equal(checker.getLatestDetectedHomework({ contentsCheckerItems: [] }, timestamp + 5000), null);
    assert.equal(read(timestamp + 86_400_000), null, '다음 날짜에 어제의 감지 한 줄이 남으면 안 됩니다.');
    const reset = cfg.load(); reset.contentsCheckerItems.find((item: any) => item.id === daily.id).resetRule.hour = 13;
    assert.equal(checker.getLatestDetectedHomework(reset, timestamp + 3_600_000), null, '같은 날짜의 숙제 리셋도 반영합니다.');
    cfg.saveImmediate({ characterPresets: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] });
    checker.queuePendingHomework(weekly.id, 2, false, 'clear-summary', timestamp + 5000);
    assert.equal(read().currentCount, 2);
    checker.clearPendingHomeworks();
    assert.equal(read(), null, '보류 내역을 삭제하면 해당 감지 표시도 제거합니다.');
  } finally { cfg.saveImmediate(original); }
}

function checkActivityBuffRestoration(cfg: any, activity: any): void {
  const original = cfg.load();
  const defaults = built('modules/constants').DEFAULT_CONFIG;
  const ids: string[] = JSON.parse(fs.readFileSync(path.join(root, 'dist/assets/data/buffs.json'), 'utf8')).map((buff: any) => buff.id);
  const buffId = 'exp_potato_900';
  assert.ok(ids.includes(buffId));
  assert.equal(defaults.buffTimerBuffs[buffId], undefined, '기본 ON이지만 명시적 설정 키가 없는 실제 버프를 검사합니다.');
  const { buffTimerManager: manager } = isolatedModule('buffTimerManager', {
    './config': cfg, './windowMessaging': { findFirstWindowByPage: () => null, sendToFirstWindowByPage() {} },
  });
  manager.loadBuffDefs();
  const save = (patch: any) => {
    const sanitized = cfg.sanitizeExternalConfigPatch(patch);
    assert.ok(sanitized);
    assert.equal(cfg.saveConfirmed(sanitized), true);
  };
  const apply = (settings: any) => {
    // 기존 sparse 프리셋을 실제 파일에 보관하고 다시 읽어, IPC와 같은 검증·확정 저장 경로로 적용한다.
    save({ activityPresets: [{ id: 'buff-round-trip', name: '버프 복원', updatedAt: 1, openWindows: [], settings }] });
    const disk = JSON.parse(fs.readFileSync(built('modules/constants').get_CONFIG_PATH(), 'utf8'));
    const before = cfg.load();
    const snapshot = structuredClone(disk.activityPresets[0].settings);
    const patch = activity.mergeActivitySettings(before, disk.activityPresets[0].settings);
    assert.deepEqual(disk.activityPresets[0].settings, snapshot, '복원 중 저장 프리셋을 변경하면 안 됩니다.');
    assert.deepEqual(cfg.load(), before, '복원 패치 계산 중 현재 설정을 변경하면 안 됩니다.');
    save(patch);
    manager.refreshConfig();
    return JSON.parse(fs.readFileSync(built('modules/constants').get_CONFIG_PATH(), 'utf8'));
  };
  try {
    const on = Object.fromEntries(ids.map(id => [id, true]));
    const off = Object.fromEntries(ids.map(id => [id, false]));
    const sparse = { buffTimerBuffs: activity.captureActivitySettings(defaults).buffTimerBuffs };
    save({ buffTimerEnabled: true, buffTimerBuffs: off, pinnedNoteText: '보존할 개인 메모' });
    manager.activateBuff(buffId);
    assert.equal(manager.getActiveBuffs().length, 0);
    let restored = apply(sparse);
    for (const id of ids) assert.equal(restored.buffTimerBuffs[id], true, `${id}: 기본 ON 프리셋 복원 누락`);
    manager.activateBuff(buffId);
    assert.ok(manager.getActiveBuffs().some((buff: any) => buff.buffId === buffId), '실제 버프 감지도 다시 켜져야 합니다.');
    manager.deactivateBuff(buffId);

    save({ buffTimerBuffs: on });
    restored = apply({ buffTimerBuffs: off });
    for (const id of ids) assert.equal(restored.buffTimerBuffs[id], false, `${id}: 명시적 OFF 복원 누락`);
    manager.activateBuff(buffId);
    assert.equal(manager.getActiveBuffs().length, 0, 'OFF 프리셋은 실제 버프 감지도 끕니다.');

    const mixed = Object.fromEntries(ids.map((id, index) => [id, index % 2 === 0]));
    restored = apply({ buffTimerBuffs: mixed });
    for (const id of ids) assert.equal(restored.buffTimerBuffs[id], mixed[id]);
    assert.equal(restored.pinnedNoteText, '보존할 개인 메모');
    assert.equal(restored.selectedCharacterId, original.selectedCharacterId);

    save({ buffTimerBuffs: { future_buff_fixture: false, [buffId]: false } });
    restored = apply({ buffTimerBuffs: {} });
    assert.equal(restored.buffTimerBuffs.future_buff_fixture, true, '저장 후 추가된 ID도 생략의 기본 ON 의미를 복원합니다.');
    assert.equal(restored.buffTimerBuffs[buffId], true);
    save({ buffTimerBuffs: { [buffId]: false } });
    restored = apply({ xpAutoPauseEnabled: true });
    assert.equal(restored.buffTimerBuffs[buffId], false, '버프 맵 자체가 없는 부분 프리셋은 기존 버프 설정을 유지합니다.');
    save({ buffTimerBuffs: { [ids[0]]: false, [ids[1]]: false } });
    save({ buffTimerBuffs: { [ids[0]]: true } });
    assert.equal(cfg.load().buffTimerBuffs[ids[1]], false, '일반 부분 저장의 병합 규칙은 그대로 유지해야 합니다.');
  } finally {
    manager.stop();
    cfg.saveConfirmed(original);
  }
}

/** 실제 창 bounds → 프로덕션 캡처 → 디스크 저장 → 프로덕션 복원 → 네이티브 bounds를 비교한다.
 * 게임/디스플레이 조회만 격리하며 캡처·크기 정책·복원은 모의 함수로 대체하지 않는다.
 */
function checkActivityWindowSizes(cfg: any, activity: any): void {
  const sizing = built('modules/managedWindowSizing');
  const registry = built('modules/managedWindowRegistry').createManagedWindowRegistry();
  const original = cfg.load();
  const windows: BrowserWindow[] = [];
  let workAreaSize = { width: 1920, height: 1080 };
  try {
    const requested = structuredClone(original);
    Object.assign(requested, { chatOverlayEnabled: true, chatOverlaySubEnabled: true,
      chatOverlaySub2Enabled: true, contentsCheckerEnabled: true });
    for (const key of activity.ACTIVITY_WINDOWS) {
      Object.assign(requested, sizing.createManagedWindowSizePatch(key, 1600, 900, requested.managedWindowSizes));
    }
    assert.equal(cfg.saveConfirmed(requested), true);
    const expected = new Map<string, { width: number; height: number }>();
    for (const key of activity.ACTIVITY_WINDOWS) {
      const entry = registry[key];
      const size = sizing.resolveManagedWindowSizing(key, entry.width, entry.height, cfg.load(), { width: 1280, height: 800 });
      entry.ref = new BrowserWindow({ show: false, frame: false, width: size.width, height: size.height,
        minWidth: size.minWidth, minHeight: size.minHeight });
      windows.push(entry.ref);
      const { width, height } = entry.ref.getBounds();
      expected.set(key, { width, height });
    }
    const source = fs.readFileSync(path.join(root, 'src/modules/windowManager.ts'), 'utf8');
    const resizeHelpers = source.slice(source.indexOf('const WINDOWS_WITH_OWN_RESIZE_HANDLE ='), source.indexOf('/** 전환 도중 새 창이 열리면'));
    const functions = source.slice(source.indexOf('export function captureActivityLayout('), source.indexOf('export function sendActiveWindowsStatus('));
    const context = vm.createContext({ config: cfg, windowRegistry: registry, contentsWindowCollapse: new (built('modules/contentsWindowCollapse').ContentsWindowCollapse)(),
      ACTIVITY_WINDOWS: activity.ACTIVITY_WINDOWS, captureActivitySettings: activity.captureActivitySettings,
      copyDefaultWindowPosition: built('shared/windowPositions').copyDefaultWindowPosition,
      ...sizing, getStablePlacementAnchorRect: () => null, pendingManagedWindowLayouts: new WeakMap(),
      screen: { getDisplayMatching: () => ({ workAreaSize, workArea: { x: 0, y: 0, ...workAreaSize } }),
        getAllDisplays: () => [{ bounds: { x: 0, y: 0, ...workAreaSize } }] },
      ...built('modules/windowPlacement'),
      getActiveMode: () => 'windowed', getModePositions: (config: any) => config.positions,
      applyRuntimeModePositions() {}, setProgrammaticMove() {}, sendActiveWindowsStatus() {},
    });
    vm.runInContext(ts.transpileModule(resizeHelpers + functions.replace(/export function /g, 'function '), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    const beforeCapture = cfg.load();
    const captured = JSON.parse(JSON.stringify(context.captureActivityLayout()));
    assert.deepEqual(cfg.load(), beforeCapture, '캡처가 실행 중 설정을 변경하면 안 됩니다.');
    assert.deepEqual(captured.openWindows, Array.from(activity.ACTIVITY_WINDOWS));
    assert.equal(cfg.saveConfirmed({ activityPresets: [{ id: 'actual-sizes', name: '실제 크기', updatedAt: 1, ...captured }] }), true);
    const disk = JSON.parse(fs.readFileSync(built('modules/constants').get_CONFIG_PATH(), 'utf8'));
    const preset = disk.activityPresets[0];
    const snapshot = JSON.stringify(preset);
    // 저장 이후 사용자가 창 크기와 설정을 바꾼 상태에서 복원한다.
    assert.equal(cfg.saveConfirmed(requested), true);
    for (const window of windows) window.setBounds({ width: 500, height: 400 });
    const patch = activity.mergeActivitySettings(cfg.load(), preset.settings);
    assert.ok(cfg.sanitizeExternalConfigPatch(patch));
    assert.equal(cfg.saveConfirmed(patch), true);
    context.restoreActivityLayout(preset.openWindows);
    for (const [key, size] of expected) {
      const { width, height } = registry[key].ref.getBounds();
      assert.deepEqual({ width, height }, size, `${key}: 실제 캡처 크기를 복원해야 합니다.`);
    }
    // 이미 열린 창의 네이티브 minimum도 현재 화면에 맞춰 줄고, 큰 화면에서는 다시 커져야 한다.
    for (workAreaSize of [{ width: 800, height: 600 }, { width: 1920, height: 1080 }]) {
      context.restoreActivityLayout(preset.openWindows);
      for (const key of activity.ACTIVITY_WINDOWS) {
        const entry = registry[key];
        const size = sizing.resolveManagedWindowSizing(key, entry.width, entry.height, cfg.load(), workAreaSize);
        const { width, height } = entry.ref.getBounds();
        assert.deepEqual({ width, height }, { width: size.width, height: size.height },
          `${key}: 작업 영역 ${workAreaSize.width}×${workAreaSize.height}에 맞게 열린 창도 복원해야 합니다.`);
        assert.deepEqual(entry.ref.getMinimumSize(), [size.minWidth, size.minHeight],
          `${key}: 이전 화면의 네이티브 최소 크기를 남기면 안 됩니다.`);
      }
    }
    assert.equal(JSON.stringify(preset), snapshot, '적용 중 저장 프리셋을 바꾸면 안 됩니다.');
    assert.equal(cfg.load().pinnedNoteText, original.pinnedNoteText);
    assert.equal(cfg.load().selectedCharacterId, original.selectedCharacterId);
    for (const key of ['chatOverlaySub', 'trade']) {
      registry[key].ref.destroy();
      const sizePatch = sizing.createManagedWindowSizePatch(key, 640, 420, cfg.load().managedWindowSizes);
      assert.equal(cfg.saveConfirmed(sizePatch), true);
      const closed = context.captureActivityLayout();
      const size = sizing.resolveManagedWindowSizing(key, 1000, 800, closed.settings, { width: 1920, height: 1080 });
      assert.equal(size.width, 640, `${key}: 닫힌 창의 저장 크기를 보존해야 합니다.`);
      assert.equal(size.height, 420);
    }
    console.log('Activity window sizes: all 10 real windows captured, persisted and restored across smaller/larger work areas with native minimums; closed sizes preserved.');
  } finally {
    windows.forEach(window => { if (!window.isDestroyed()) window.destroy(); });
    cfg.saveConfirmed(original);
  }
}

async function main(): Promise<void> {
  await app.whenReady();
  const channels = built('shared/chatChannels');
  const eta = { chatEtaColorsEnabled: true, chatEtaColors: ['#000001', '#000002', '#000003', '#000004', '#000005'] };
  assert.deepEqual([1, 20, 21, 40, 41, 60, 61, 80, 81, 500].map(level => channels.getEtaColor(level, eta)), ['#000001', '#000001', '#000002', '#000002', '#000003', '#000003', '#000004', '#000004', '#000005', '#000005']);
  assert.equal(channels.getEtaColor(0, eta), null);
  assert.equal(channels.getEtaColor(80, { ...eta, chatEtaColorsEnabled: false }), null);
  const { updateNicknameNote, isNicknameNotes } = built('shared/nicknameNotes');
  let notes = updateNicknameNote([], 7, 'Tester', '거래했던 분');
  notes = updateNicknameNote(notes, 16, 'Tester', '부캐');
  notes = updateNicknameNote(notes, 7, ' tester ', '<img onerror=alert(1)>');
  assert.equal(notes.length, 2);
  assert.equal(notes.find((note: any) => note.server === 7).note, '<img onerror=alert(1)>');
  notes = updateNicknameNote(notes, 7, 'Tester', '');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].server, 16);
  assert.equal(updateNicknameNote(notes, 8, 'Tester', '메모'), null);
  assert.equal(updateNicknameNote(notes, 7, 'Tester', 'x'.repeat(201)), null);
  assert.equal(isNicknameNotes([notes[0], notes[0]]), false);
  const { ChatParser } = built('modules/chatParser');
  const { SupplyRun, parseSupplyInstruction } = built('shared/supplyRecapture');
  const run = new SupplyRun();
  const order = parseSupplyInstruction('파란 하늘 아래 개나리 한 송이와 붉은 장미');
  assert.deepEqual(order.colors, ['파랑', '노랑', '빨강']);
  assert.deepEqual(parseSupplyInstruction('붉은 노을이 지고 칠흑 같은 어둠이 내려앉은 바다').colors, ['빨강', '검정', '파랑']);
  assert.deepEqual(parseSupplyInstruction('하얀 종이 위에 펼쳐져 있는 푸른 바다와 달콤한 꿀 내음').colors, ['흰색', '파랑', '노랑']);
  assert.equal(parseSupplyInstruction('유저 : 파란 하늘 아래 개나리 한 송이와 붉은 장미'), null);
  assert.equal(parseSupplyInstruction('외치기 : 보급품 탈환에 성공하였습니다.'), null);
  assert.equal(run.observe(order, 1000), false);
  run.observe(parseSupplyInstruction('경보 장치 4개를 모두 해제하고 보급품이 보관 되어 있는 막사를 찾으시오.'), 1000);
  assert.equal(run.observe(order, 2000), true);
  assert.equal(run.snapshot().orderExpiresAt, 12000);
  assert.equal(run.observe(order, 1_801_000), false);
  run.observe({ phase: 'start' }, 2_000_000);
  run.observe(parseSupplyInstruction('보급품 탈환에 실패하였습니다.'), 2_001_000);
  assert.equal(run.snapshot().expiresAt, 0);
  const parser = new ChatParser();
  const events: any[] = [];
  parser.on('TRADE_SHOUT', (event: unknown) => events.push(event));
  for (const text of ['From 서울 to 부산 Click 이벤트 From [유저1]', '물건 삽니다 Click [유저2]', '모험가님이 룬 마스터를 달성했습니다.']) {
    parser.parseLine(`<font color="white"> [13시 34분 27초] </font><font color="#c896c8">외치기 : ${text}</font></br>`);
  }
  assert.deepEqual(events.map(event => event.shoutKind), ['free', 'paid', 'notice']);
  assert.equal(events[0].message, 'From 서울 to 부산 Click 이벤트');
  assert.equal(events[2].sender, '시스템 공지');
  assert.equal(channels.isShoutVisible(events[0], { chatOverlayShowFreeShout: false }), false);
  assert.equal(channels.isShoutVisible({}, { chatOverlayShowFreeShout: false, chatOverlayShowPaidShout: false, chatOverlayShowNoticeShout: false }), true);

  // 기존 버전 DB를 그대로 열어 컬럼만 보충하고 이전 행을 보존한다.
  const diary = built('modules/diaryDb');
  diary.initDb();
  diary.addShoutLog('기존 사용자', '이전 기록');
  assert.equal(diary.closeDb(), true);
  const Database = require('better-sqlite3');
  const legacy = new Database(path.join(fixture, 'diary.db'));
  legacy.exec('ALTER TABLE shout_history DROP COLUMN shout_kind; PRAGMA user_version = 6;');
  legacy.close();
  diary.initDb();
  diary.addShoutLog(events[0].sender, events[0].message, undefined, events[0].shoutKind);
  diary.addShoutLog(events[1].sender, events[1].message, undefined, events[1].shoutKind);
  const rows = diary.getShoutHistory();
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row: any) => row.sender === '기존 사용자').shout_kind, null);
  assert.equal(rows.find((row: any) => row.sender === '유저1').shout_kind, 'free');
  diary.closeDb();
  const cfg = built('modules/config');
  checkDetectedHomeworkSummary(cfg);
  const activity = built('shared/activityPresets');
  checkActivityWindowSizes(cfg, activity);
  checkActivityBuffRestoration(cfg, activity);
  const captured = activity.captureActivitySettings({ xpAutoPauseEnabled: true, positions: { xpHud: { offsetX: 20, offsetY: 40 }, settings: { offsetX: 99, offsetY: 88 } }, nicknameNotes: notes, pinnedNoteText: '개인 메모', discordWebhookUrl: '비공개', selectedCharacterId: '부캐', activityPresets: [] });
  assert.deepEqual(captured, { positions: { xpHud: { offsetX: 20, offsetY: 40 } }, xpAutoPauseEnabled: true });
  const profile = { id: 'hunting', name: '사냥', updatedAt: 1, settings: captured, openWindows: ['xpHud'] };
  assert.ok(cfg.sanitizeExternalConfigPatch({ activityPresets: [profile] }));
  assert.equal(cfg.sanitizeExternalConfigPatch({ activityPresets: [{ ...profile, settings: { xpAutoPauseSeconds: -1 } }] }), null);
  assert.equal(cfg.sanitizeExternalConfigPatch({ activityPresets: [{ ...profile, settings: { activityPresets: [] } }] }), null);
  assert.equal(cfg.sanitizeExternalConfigPatch({ activityPresets: [{ ...profile, openWindows: ['settings'] }] }), null);
  assert.equal(cfg.sanitizeExternalConfigPatch({ activityPresets: [profile, profile] }), null);
  const restored = activity.mergeActivitySettings({ positions: { settings: { offsetX: 99, offsetY: 88 } }, selectedCharacterId: '부캐' }, captured);
  assert.deepEqual(restored.positions, { settings: { offsetX: 99, offsetY: 88 }, xpHud: { offsetX: 20, offsetY: 40 } });
  assert.equal(restored.selectedCharacterId, undefined);
  // 실제 IPC 구현을 격리해 저장 실패·갱신·전환 시 기록 보존을 검증한다.
  const ipcSource = fs.readFileSync(path.join(root, 'src/modules/ipcHandlers.ts'), 'utf8');
  const ipcStart = ipcSource.indexOf('  type ApplySettingsResult =');
  const handlers = new Map<string, (...args: any[]) => any>();
  const state: any = { ...built('modules/constants').DEFAULT_CONFIG, activityPresets: [], selectedCharacterId: 'keep-character', pinnedNoteText: 'keep-note', xpAutoPauseEnabled: true, abandonedEnabled: true, chatOverlayClickThrough: true };
  let saveFails = false;
  let automaticSaves = 0;
  const layouts: string[][] = [];
  const fixtureConfig = {
    load: () => structuredClone(state), loadFields: () => structuredClone(state),
    sanitizeExternalConfigPatch: (patch: unknown) => cfg.sanitizeExternalConfigPatch(structuredClone(patch)), getLastSaveError: () => 'fixture',
    save: (patch: any) => { automaticSaves++; Object.assign(state, patch); },
    saveConfirmed: (patch: any) => { if (saveFails) return false; Object.assign(state, patch); return true; },
  };
  const { abandonedTracker: abandoned } = isolatedModule('abandonedTracker', {
    './config': fixtureConfig, './chatParser': { chatParser: parser }, './windowMessaging': { broadcastToAllWindows() {} },
  });
  abandoned.start();
  const runtime = isolatedModule('runtimeSettings', {
    './abandonedTracker': { abandonedTracker: abandoned }, './shortcutManager': { reloadShortcuts() {} },
    './galleryMonitor': { updateWindows() {} }, './tradeMonitor': { updateWindows() {} },
    './analytics': { analytics: { refreshEnabledState() {}, trackEvent() {} } }, './autoStart': { setupAutoStart() {} },
    './diaryDb': { cleanOldDiaryData() {} }, './windowMessaging': { broadcastToAllWindows() {} },
  });
  const nativeWindow = () => ({
    mouse: [] as boolean[], sent: [] as any[], isDestroyed: () => false,
    setIgnoreMouseEvents(ignore: boolean) { this.mouse.push(ignore); },
    getBounds: () => ({ x: 0, y: 0, width: 600, height: 300 }), setBounds() {}, setOpacity() {}, close() {},
    webContents: { send: (...args: any[]) => {} },
  });
  const windows = Object.fromEntries(['chatOverlay', 'chatOverlaySub', 'chatOverlaySub2', 'dock', 'settings', 'contentsChecker'].map(key => [key, nativeWindow()]));
  const browser = nativeWindow(), sidebar = nativeWindow();
  for (const win of [browser, sidebar, ...Object.values(windows)]) win.webContents.send = (...args) => { win.sent.push(args); };
  const wmSource = fs.readFileSync(path.join(root, 'src/modules/windowManager.ts'), 'utf8');
  const wmContext = vm.createContext({
    contentsWindowCollapse: new (built('modules/contentsWindowCollapse').ContentsWindowCollapse)(),
    config: fixtureConfig, overlayWindow: browser, mainWindow: sidebar, gameOverlayWindow: null,
    windowRegistry: Object.fromEntries(Object.entries(windows).map(([key, ref]) => [key, { ref }])),
    buffTimerManager: { refreshConfig() {} }, physicalGameRect: null, gameRect: null, isClickThrough: true,
    isChatOverlayVisible: false, isChatOverlaySubVisible: false, isChatOverlaySub2Visible: false, isContentsCheckerVisible: false,
    isGameFullscreen: false, isApplyingSize: false, isToolbarShown: true, MIN_W: 200, MIN_H: 120, updateViewBounds() {},
    log() {}, require: () => ({ updateTrayMenu() {} }), setTimeout() {}, tracker: { getGameHwnd: () => null },
    applyRuntimeModePositions() {}, getModePositions: () => ({}), getActiveMode: () => 'windowed', resizeBounds: (bounds: unknown) => bounds,
  });
  vm.runInContext(ts.transpileModule(wmSource.slice(wmSource.indexOf('export function applySettings('), wmSource.indexOf('export function toggleSidebar(')).replace(/export /g, ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, wmContext);
  vm.runInNewContext(ts.transpileModule(ipcSource.slice(ipcStart, ipcSource.indexOf('  function broadcastChatLogStatus()', ipcStart)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMain: { on() {}, handle: (name: string, handler: any) => handlers.set(name, handler) },
    config: fixtureConfig,
    isActivityPresets: activity.isActivityPresets, mergeActivitySettings: activity.mergeActivitySettings,
    randomUUID: () => 'new-preset', isBoolean: (value: unknown) => typeof value === 'boolean', log() {}, applyRuntimeSettings: runtime.applyRuntimeSettings, broadcastChatLogStatus() {},
    wm: { getSettingsWindow: () => null, isAnyUserDragging: () => false,
      captureActivityLayout: () => ({ settings: activity.captureActivitySettings(state), openWindows: ['xpHud'] }),
      restoreActivityLayout: (windows: string[]) => layouts.push(Array.from(windows)),
      applySettings: wmContext.applySettings },
  });
  assert.equal(handlers.get('activity-preset-save')!({}, '사냥').success, true);
  state.xpAutoPauseEnabled = false;
  assert.equal(handlers.get('activity-preset-save')!({}, '사냥 이름 변경', 'new-preset', true).success, true);
  assert.equal(state.activityPresets[0].settings.xpAutoPauseEnabled, true, '이름 변경이 저장된 프리셋 내용을 덮어쓰면 안 됩니다.');
  const entry = (count: number) => parser.parseLine(`<font size="2" color="white"> [22시 38분 01초] </font><font>이번 주 어벤던로드 카디프 지역의 도전 횟수는 ${count}번 입니다.</font></br>`);
  entry(1);
  abandoned.setEnabled(false);
  assert.equal(wmContext.toggleClickThrough(), false);
  const writesBeforePreset = automaticSaves;
  const mouseCallsBeforeFailure = browser.mouse.length;
  saveFails = true;
  assert.equal(handlers.get('activity-preset-apply')!({}, 'new-preset').success, false);
  assert.equal(layouts.length, 0);
  assert.equal(state.xpAutoPauseEnabled, false);
  assert.equal(abandoned.getState().isEnabled, false);
  assert.equal(wmContext.isClickThrough, false);
  assert.equal(browser.mouse.length, mouseCallsBeforeFailure, '저장 실패 시 실제 창의 입력 상태도 그대로 유지해야 합니다.');
  entry(2);
  assert.equal(abandoned.getState().regions['카디프'], 1);
  saveFails = false;
  assert.equal(handlers.get('activity-preset-apply')!({}, 'new-preset').success, true);
  assert.deepEqual(layouts, [['xpHud']]);
  assert.equal(state.xpAutoPauseEnabled, true);
  assert.equal(state.selectedCharacterId, 'keep-character');
  assert.equal(state.pinnedNoteText, 'keep-note');
  assert.equal(abandoned.getState().isEnabled, true);
  assert.equal(abandoned.getState().regions['카디프'], 1, '프리셋 적용은 기존 측정 기록을 초기화하지 않습니다.');
  assert.equal(automaticSaves, writesBeforePreset, '저장이 확정된 프리셋은 런타임 적용 중 다시 저장하지 않습니다.');
  entry(3);
  assert.equal(abandoned.getState().regions['카디프'], 3);
  for (const win of [browser, windows.chatOverlay, windows.chatOverlaySub, windows.chatOverlaySub2]) assert.equal(win.mouse.at(-1), true);
  for (const win of [browser, sidebar, windows.dock]) assert.equal(win.sent.filter(args => args[0] === 'click-through-status').at(-1)[1], true);
  assert.equal(wmContext.isToolbarShown, false);
  assert.equal(wmContext.toggleClickThrough(), false, '프리셋 직후 첫 단축키로 투과를 해제해야 합니다.');
  abandoned.setEnabled(false);
  assert.equal(handlers.get('activity-preset-save')!({}, '꺼짐', 'new-preset').success, true);
  abandoned.setEnabled(true);
  assert.equal(wmContext.toggleClickThrough(), true);
  assert.equal(handlers.get('activity-preset-apply')!({}, 'new-preset').success, true);
  assert.equal(abandoned.getState().isEnabled, false);
  assert.equal(abandoned.getState().isActive, false);
  entry(4);
  assert.equal(abandoned.getState().regions['카디프'], 3, '꺼짐 프리셋은 새 로그 수집을 멈추되 기존 기록을 유지합니다.');
  for (const win of [browser, windows.chatOverlay, windows.chatOverlaySub, windows.chatOverlaySub2]) assert.equal(win.mouse.at(-1), false);
  assert.equal(wmContext.toggleClickThrough(), true, '꺼짐 프리셋 직후 첫 단축키로 투과를 켜야 합니다.');
  assert.equal(handlers.get('activity-preset-delete')!({}, 'new-preset').success, true);
  assert.equal(state.activityPresets.length, 0);
  assert.ok(cfg.sanitizeExternalConfigPatch({ notificationPositions: { center: 'top-right', buff: 'default', hunting: 'top-left', toast: 'bottom-right' } }));
  assert.equal(cfg.sanitizeExternalConfigPatch({ notificationPositions: { center: 'offscreen', buff: 'default', hunting: 'top-left', toast: 'bottom-right' } }), null);
  assert.equal(cfg.sanitizeExternalConfigPatch({ notificationPositions: { center: 'top-right' } }), null);
  // 실제 오늘 로그에서 숨긴 종류 500건 뒤의 표시 대상도 검색할 수 있어야 한다.
  const { chatLogManager } = built('modules/chatLogManager');
  const previousLines = chatLogManager._todayLines;
  const previousConfig = cfg.load();
  const shoutLine = (kind: string, label: string) => `<font color="white"> [12시 00분 00초] </font><font color="#c896c8">외치기 : 매물 ${label}${kind === 'free' ? ' From [무료유저]' : kind === 'paid' ? ' Click [유료유저]' : ''}</font></br>`;
  try {
    for (const visibleKind of ['free', 'paid', 'notice']) {
      const hiddenKinds = ['free', 'paid', 'notice'].filter(kind => kind !== visibleKind);
      const lines = [shoutLine(visibleKind, '이전1'), shoutLine(visibleKind, '이전2'),
        ...Array.from({ length: 500 }, (_, index) => shoutLine(hiddenKinds[index % 2], `숨김${index}`))];
      chatLogManager._todayLines = lines;
      cfg.saveConfirmed({ chatOverlayShowFreeShout: visibleKind === 'free', chatOverlayShowPaidShout: visibleKind === 'paid',
        chatOverlayShowNoticeShout: visibleKind === 'notice', chatOverlayCustomTabs: [{ id: 'search-shout', name: '외치기 검색', channels: ['shout'] }] });
      for (const category of ['Basic', 'Shout', 'search-shout']) {
        const found = await chatLogManager.searchChatLogs('매물', { category, limit: 500 });
        assert.deepEqual(found.map((row: any) => row.message), ['매물 이전1', '매물 이전2']);
        assert.ok(found.every((row: any) => row.shoutKind === visibleKind));
        assert.equal((await chatLogManager.searchChatLogs('매물', { category, limit: 1 }))[0].message, '매물 이전2');
      }
      assert.deepEqual(chatLogManager._todayLines, lines, '종류 필터는 수집된 원본을 삭제하지 않습니다.');
    }
    cfg.saveConfirmed({ chatOverlayShowFreeShout: true, chatOverlayShowPaidShout: true, chatOverlayShowNoticeShout: true });
    assert.equal((await chatLogManager.searchChatLogs('매물', { category: 'Shout', limit: 500 })).length, 500);
    cfg.saveConfirmed({ chatOverlayShowFreeShout: false, chatOverlayShowPaidShout: false, chatOverlayShowNoticeShout: false });
    assert.equal((await chatLogManager.searchChatLogs('매물', { category: 'Shout', limit: 500 })).length, 0);
    // 최초 150건과 추가 페이지 경계마다 원본 한 줄도 빠지면 안 된다.
    const processor = built('modules/chatLogProcessor').chatLogProcessor;
    const lines = [shoutLine('free', '가장 오래된 무료'),
      ...Array.from({ length: 450 }, (_, index) => shoutLine('paid', `유료${index}`))];
    chatLogManager._todayLines = lines;
    processor.clearHistoryStore();
    chatLogManager.replayTodayLog(lines);
    for (const category of ['Basic', 'Shout', 'search-shout']) {
      chatLogManager.resetLastReadIndex(category);
      let rows = processor.getChatHistory(category);
      const pageSizes: number[] = [];
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        const page = await chatLogManager.getMoreHistory(category);
        pageSizes.push(page.length);
        rows = [...page, ...rows];
        if (page.length < 150) break;
      }
      assert.deepEqual(pageSizes, [150, 150, 1]);
      assert.deepEqual(rows.map((row: any) => row.message), ['매물 가장 오래된 무료',
        ...Array.from({ length: 450 }, (_, index) => `매물 유료${index}`)], `${category} 페이지 경계에서 로그가 누락/중복됐습니다.`);
      assert.equal((await chatLogManager.getMoreHistory(category)).length, 0);
    }
    assert.deepEqual(chatLogManager._todayLines, lines);
    // 실제 IPC 핸들러를 통과해 메인/보조 창이 같은 탭을 번갈아 읽고 재설정한다.
    const historyHandlers = new Map<string, any>();
    const moreIpcStart = ipcSource.indexOf("  ipcMain.handle('chat-get-more-history'");
    const historyIpcSource = ipcSource.slice(ipcSource.indexOf('  // --- Chat Overlay IPC ---'), ipcSource.indexOf("  ipcMain.handle('today-summary-get'"))
      + ipcSource.slice(moreIpcStart, ipcSource.indexOf('  });', moreIpcStart) + '  });'.length);
    vm.runInNewContext(ts.transpileModule(historyIpcSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
      ipcMain: { handle: (name: string, handler: any) => historyHandlers.set(name, handler) }, chatLogManager,
      isLimitedString: (value: unknown) => typeof value === 'string',
      require: (name: string) => name === './chatLogProcessor' ? { chatLogProcessor: processor } : { chatLogManager },
    });
    const readers = [101, 102, 103].map(id => {
      let destroyed = false;
      const callbacks: Array<() => void> = [];
      return { id, isDestroyed: () => destroyed, once: (_event: string, callback: () => void) => callbacks.push(callback),
        close: () => { destroyed = true; callbacks.forEach(callback => callback()); }, callbacks };
    });
    const history = (sender: typeof readers[number]) => historyHandlers.get('chat-get-history')({ sender }, 'Shout');
    const older = (sender: typeof readers[number]) => historyHandlers.get('chat-get-more-history')({ sender }, 'Shout');
    for (const reader of readers) assert.equal((await history(reader)).length, 150);
    for (const reader of readers) assert.equal((await older(reader))[0].message, '매물 유료150');
    // 한 창의 필터/탭 재조회가 다른 두 창의 진행 위치를 되돌리면 안 된다.
    await history(readers[0]);
    assert.equal((await older(readers[0]))[0].message, '매물 유료150');
    for (const reader of readers) assert.equal((await older(reader))[0].message, '매물 유료0');
    for (const reader of readers) {
      assert.deepEqual((await older(reader)).map((row: any) => row.message), ['매물 가장 오래된 무료']);
      assert.equal(reader.callbacks.length, 1, '재조회 때마다 창 종료 리스너가 늘면 안 됩니다.');
      reader.close();
      assert.equal((await older(reader)).length, 0, '닫힌 창은 더 이상 읽지 않습니다.');
      assert.equal((await chatLogManager.getMoreHistory('Shout', reader.id)).length, 150, '종료한 창의 읽기 위치를 정리해야 합니다.');
      chatLogManager.releaseHistoryReader(reader.id);
    }
    processor.clearHistoryStore();
  } finally {
    chatLogManager._todayLines = previousLines;
    cfg.saveConfirmed(previousConfig);
  }
  console.log('Companion features: shout filters, ETA colors, memos, supply guide and activity presets passed.');
  app.exit(0);
}
void main().catch(error => { console.error(error); app.exit(1); });
