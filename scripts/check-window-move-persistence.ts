import assert = require('node:assert/strict');
import path = require('node:path');
import { EventEmitter } from 'node:events';
import type { BrowserWindow, Rectangle } from 'electron';

const built = (name: string) => require(path.join(__dirname, '..', 'dist', 'modules', name));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class MovingWindow extends EventEmitter {
  bounds = { x: 100, y: 100, width: 500, height: 400 };
  destroyed = false;
  getBounds(): Rectangle { return { ...this.bounds }; }
  isDestroyed(): boolean { return this.destroyed; }
  move(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y };
    this.emit('move');
  }
}

/** 빠른 move 연속 입력·정지·종료 순서에 따른 설정 처리 횟수와 저장 좌표를 검증합니다. */
export async function checkWindowMovePersistence(): Promise<void> {
  const { ProgrammaticMoveTracker } = built('programmaticMoveTracker.js');
  const { attachWindowMovePersistence } = built('windowMovePersistence.js');
  let now = 1_000;
  const tracker = new ProgrammaticMoveTracker(2, 1_000, () => now);
  const cases = ['settings', 'chatOverlay', 'overlay', 'uniformColor', 'swordEnhance'].map(key => {
    const win = new MovingWindow();
    const saved: Rectangle[] = [];
    let allowed = true;
    let closing = false;
    win.on('close', () => { closing = true; });
    attachWindowMovePersistence(win as unknown as BrowserWindow, {
      key, tracker,
      canSave: () => allowed && !closing,
      savePosition: (bounds: Rectangle) => saved.push(bounds),
    });
    return { key, win, saved, allow: (value: boolean) => { allowed = value; } };
  });

  for (const { key, win, saved } of cases) {
    tracker.record(key, { x: 200, y: 200 }, win.bounds);
    win.emit('will-move');
    for (let i = 0; i < 120; i++) win.move(110 + i, 120 + i);
    assert.equal(saved.length, 0, `${key}: 드래그 중 설정을 저장했습니다.`);
  }
  now += 5_000;
  await wait(400);
  for (const { key, saved } of cases) {
    assert.equal(saved.length, 0, `${key}: 마우스를 잡고 멈췄을 때 저장했습니다.`);
    assert.equal(tracker.isUserDragging(key), true, `${key}: 정지 중 드래그 보호가 만료됐습니다.`);
  }
  assert.equal(tracker.isAnyUserDragging(), true);

  for (const { key, win, saved } of cases) {
    // Escape 취소처럼 마지막 move 좌표와 종료 시 실제 위치가 달라도 실제 위치를 저장한다.
    win.bounds = { ...win.bounds, x: 105, y: 106 };
    win.emit('moved');
    win.emit('moved');
    assert.deepEqual(saved, [win.bounds], `${key}: 최종 위치를 한 번만 저장해야 합니다.`);
    assert.equal(tracker.isUserDragging(key), false);
  }
  assert.equal(tracker.isAnyUserDragging(), false);

  const test = cases[0];
  test.saved.length = 0;
  tracker.record(test.key, { x: 300, y: 400 }, test.win.bounds);
  test.win.move(200, 250); // 네이티브 자동 이동 중간 이벤트
  test.win.move(300, 400);
  test.win.emit('moved');
  await wait(200);
  assert.equal(test.saved.length, 0, '자동 재배치를 사용자 위치로 저장했습니다.');
  assert.equal(tracker.isAnyUserDragging(), false);

  // renderer의 setPosition에는 will-move/moved가 없으므로 마지막 이벤트 이후에만 저장한다.
  for (let i = 0; i < 120; i++) test.win.move(400 + i, 300 + i);
  assert.equal(test.saved.length, 0);
  await wait(200);
  assert.deepEqual(test.saved, [test.win.bounds]);
  assert.equal(tracker.isUserDragging(test.key), false);

  test.saved.length = 0;
  test.allow(false); // 초기 배치·게임 미추적·화면 모드 전환
  test.win.emit('will-move');
  test.win.move(650, 500);
  test.allow(true);
  test.win.emit('moved');
  assert.equal(test.saved.length, 0, '저장 금지 구간의 좌표를 뒤늦게 저장했습니다.');
  test.win.emit('will-move');
  test.win.move(700, 550);
  test.allow(false);
  test.win.emit('moved');
  assert.equal(test.saved.length, 0, '이동 종료 때의 저장 정책을 재확인하지 않았습니다.');
  test.allow(true);

  for (const event of ['hide', 'close']) {
    test.win.emit('will-move');
    test.win.move(800, event === 'hide' ? 600 : 650);
    test.win.emit(event);
    assert.equal(tracker.isUserDragging(test.key), false);
  }
  assert.deepEqual(test.saved.map(({ x, y }) => ({ x, y })), [{ x: 800, y: 600 }, { x: 800, y: 650 }],
    '숨김·닫힘 직전의 위치가 누락됐습니다.');

  const destroyed = cases[1];
  destroyed.saved.length = 0;
  destroyed.win.move(800, 700);
  destroyed.win.destroyed = true;
  destroyed.win.emit('closed');
  await wait(200);
  assert.equal(destroyed.saved.length, 0, '폐기한 창의 타이머가 남았습니다.');
  assert.equal(tracker.isAnyUserDragging(), false);
  tracker.beginUserDrag('reset');
  tracker.clear();
  assert.equal(tracker.isAnyUserDragging(), false);

  console.log('Window move persistence: drag bursts, held pause, final coordinates, automatic moves, fallback and lifecycle passed.');
}
