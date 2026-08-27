import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { spawn, type ChildProcess } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import koffi = require('koffi');

type FixtureMode = 'windowed' | 'borderless';

interface NativeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FixtureStatus {
  processId: number;
  hwnd: string;
  title: string;
  role: string;
  mode: FixtureMode;
  topMost: boolean;
  bounds: { X: number; Y: number; Width: number; Height: number };
  screenBounds: { X: number; Y: number; Width: number; Height: number };
  foregroundHwnd: string;
  commandSequence: number;
  lastCommand: string;
  lastActivationResult: boolean;
}

interface ScenarioResult {
  mode: FixtureMode;
  detectedHwnd: string;
  gameBounds: NativeRect;
  screenBounds: FixtureStatus['screenBounds'];
  gameTopmost: boolean;
  foregroundPreservedForGame: boolean;
  foregroundPreservedForExternal: boolean;
  overlayTopmostWhileGameActive: boolean;
  externalOverlapsGame: boolean;
  externalOrderingPolicyPreserved: boolean;
  overlayBandsMatchGame: boolean;
  overlayStackRepaired: boolean;
  appActivationRaisedGame: boolean;
}

interface Win32Runtime {
  GetForegroundWindow(): unknown;
  GetWindow(hwnd: bigint, command: number): unknown;
  GetWindowRect(hwnd: bigint, rect: NativeRect): boolean | number;
  GetWindowLongW(hwnd: bigint, index: number): number;
  IsWindowVisible(hwnd: bigint): boolean | number;
  SetForegroundWindow(hwnd: bigint): boolean | number;
  SetWindowPos(
    hwnd: bigint,
    insertAfter: bigint,
    x: number,
    y: number,
    width: number,
    height: number,
    flags: number,
  ): boolean | number;
  GW_HWNDPREV: number;
  GWL_EXSTYLE: number;
  WS_EX_TOPMOST: number;
  HWND_TOP: bigint;
  SWP_NOMOVE: number;
  SWP_NOSIZE: number;
  SWP_NOACTIVATE: number;
}

interface TrackerRuntime {
  start(): void;
  stop(): void;
  isGameRunning(): boolean;
  getGameHwnd(): string | undefined;
  reconcileGameZOrder(gameHwnd: string, overlayHwnds: string[]): { isGameOrAppFocused: boolean };
  focusGameForAppActivation(expectedAppHwnd: string): boolean;
}

const projectRoot = path.resolve(__dirname, '..');
const defaultFixturePath = path.join(
  projectRoot,
  'scripts',
  'fixtures',
  'FakeTalesWeaver',
  'bin',
  'Release',
  'net8.0-windows',
  'InphaseNXD-zorder-fixture.exe',
);
const allowUnelevated = process.argv.includes('--allow-unelevated');
const fixtureArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const fixturePath = fixtureArgument ? path.resolve(fixtureArgument) : defaultFixturePath;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'twoverlay-zorder-windows-'));
const windows: BrowserWindow[] = [];
const childProcesses = new Set<ChildProcess>();
const probeUser32 = koffi.load('user32.dll');
const probeKernel32 = koffi.load('kernel32.dll');
const getWindowThreadProcessId = probeUser32.func(
  '__stdcall',
  'GetWindowThreadProcessId',
  'uint32',
  ['intptr', 'void *'],
);
const attachThreadInput = probeUser32.func(
  '__stdcall',
  'AttachThreadInput',
  'bool',
  ['uint32', 'uint32', 'bool'],
);
const bringWindowToTop = probeUser32.func('__stdcall', 'BringWindowToTop', 'bool', ['intptr']);
const getCurrentThreadId = probeKernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(
  readValue: () => T | null | undefined | false,
  description: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = readValue();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(`${description} timeout${lastError ? `: ${String(lastError)}` : ''}`);
}

function parseNativeHwnd(value: unknown): bigint {
  if (!value) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'object') {
    try {
      return koffi.address(value);
    } catch {
      // 문자열 변환으로 계속한다.
    }
  }
  try {
    return BigInt(String(value).trim());
  } catch {
    return 0n;
  }
}

function rectsOverlap(first: NativeRect, second: NativeRect): boolean {
  return first.left < second.right
    && first.right > second.left
    && first.top < second.bottom
    && first.bottom > second.top;
}

function browserWindowHwnd(window: BrowserWindow): bigint {
  const handle = window.getNativeWindowHandle();
  if (handle.length >= 8) return handle.readBigUInt64LE();
  return BigInt(handle.readUInt32LE(0));
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeCommand(filePath: string, command: Record<string, unknown>): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(command), 'utf8');
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
  fs.renameSync(temporaryPath, filePath);
}

async function createTestWindow(
  title: string,
  color: string,
  x: number,
  y: number,
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 360,
    height: 240,
    x,
    y,
    show: false,
    frame: true,
    title,
    alwaysOnTop: false,
    skipTaskbar: true,
    backgroundColor: color,
    webPreferences: { sandbox: true },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
    `<body style="margin:0;background:${color};color:white;display:grid;place-items:center;font:700 24px Segoe UI">${title}</body>`,
  )}`);
  window.showInactive();
  windows.push(window);
  return window;
}

async function closeWindow(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return;
  window.destroy();
  await delay(10);
}

async function waitForForeground(win32: Win32Runtime, hwnd: bigint): Promise<void> {
  await waitFor(
    () => parseNativeHwnd(win32.GetForegroundWindow()) === hwnd,
    `foreground ${hwnd}`,
    3_000,
  );
}

async function waitForStableForeground(
  win32: Win32Runtime,
  hwnd: bigint,
  stableMs = 200,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (parseNativeHwnd(win32.GetForegroundWindow()) === hwnd) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      stableSince = 0;
    }
    await delay(25);
  }
  throw new Error(`foreground ${hwnd} did not remain stable for ${stableMs}ms`);
}

async function activateNativeWindowForTest(
  win32: Win32Runtime,
  hwnd: bigint,
): Promise<void> {
  const currentThreadId = getCurrentThreadId() as number;
  const foregroundThreadId = getWindowThreadProcessId(
    parseNativeHwnd(win32.GetForegroundWindow()),
    null,
  ) as number;
  const targetThreadId = getWindowThreadProcessId(hwnd, null) as number;
  const attachedForeground = foregroundThreadId !== 0
    && foregroundThreadId !== currentThreadId
    && !!attachThreadInput(currentThreadId, foregroundThreadId, true);
  const attachedTarget = targetThreadId !== 0
    && targetThreadId !== currentThreadId
    && targetThreadId !== foregroundThreadId
    && !!attachThreadInput(currentThreadId, targetThreadId, true);
  try {
    bringWindowToTop(hwnd);
    win32.SetForegroundWindow(hwnd);
  } finally {
    if (attachedTarget) attachThreadInput(currentThreadId, targetThreadId, false);
    if (attachedForeground) attachThreadInput(currentThreadId, foregroundThreadId, false);
  }
  await waitForForeground(win32, hwnd);
}

async function activateBrowserWindowForTest(
  win32: Win32Runtime,
  window: BrowserWindow,
  hwnd: bigint,
): Promise<void> {
  window.show();
  window.focus();
  await delay(50);
  if (parseNativeHwnd(win32.GetForegroundWindow()) === hwnd) return;

  // Windows의 foreground lock를 우회하기 위한 테스트 전용 입력 큐 연결이다.
  // 제품 코드는 외부 창 또는 게임에 이 API를 사용하지 않는다.
  await activateNativeWindowForTest(win32, hwnd);
}

function getWindowAbove(win32: Win32Runtime, hwnd: bigint): bigint {
  return parseNativeHwnd(win32.GetWindow(hwnd, win32.GW_HWNDPREV));
}

function getVisibleWindowAbove(win32: Win32Runtime, hwnd: bigint): bigint {
  let current = getWindowAbove(win32, hwnd);
  for (let depth = 0; current !== 0n && depth < 512; depth++) {
    if (!win32.IsWindowVisible(current)) {
      current = getWindowAbove(win32, current);
      continue;
    }
    return current;
  }
  return 0n;
}

function isAbove(
  win32: Win32Runtime,
  candidate: bigint,
  reference: bigint,
): boolean {
  let current = getWindowAbove(win32, reference);
  for (let depth = 0; current !== 0n && depth < 512; depth++) {
    if (current === candidate) return true;
    current = getWindowAbove(win32, current);
  }
  return false;
}

function readWindowRect(win32: Win32Runtime, hwnd: bigint): NativeRect {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  assert.equal(!!win32.GetWindowRect(hwnd, rect), true, `GetWindowRect failed for ${hwnd}`);
  return rect;
}

function isTopmost(win32: Win32Runtime, hwnd: bigint): boolean {
  return (win32.GetWindowLongW(hwnd, win32.GWL_EXSTYLE) & win32.WS_EX_TOPMOST) !== 0;
}

function isOverlayStackIntact(
  win32: Win32Runtime,
  firstOverlayHwnd: bigint,
  secondOverlayHwnd: bigint,
): boolean {
  return getVisibleWindowAbove(win32, secondOverlayHwnd) === firstOverlayHwnd;
}

function describeZOrderChain(
  win32: Win32Runtime,
  startHwnd: bigint,
  labels: Map<bigint, string>,
): string {
  const entries: string[] = [];
  let current = startHwnd;
  for (let depth = 0; current !== 0n && depth < 16; depth++) {
    entries.push(`${labels.get(current) ?? 'unknown'}:${current}`);
    current = getWindowAbove(win32, current);
  }
  return entries.join(' -> ');
}

async function activateFixture(
  win32: Win32Runtime,
  commandPath: string,
  statusPath: string,
  gameHwnd: bigint,
  sequence: number,
): Promise<FixtureStatus> {
  writeCommand(commandPath, { sequence, action: 'activate' });
  const status = await waitFor(
    () => {
      const current = readJsonFile<FixtureStatus>(statusPath);
      return current && current.commandSequence >= sequence ? current : null;
    },
    'fixture activate command',
  );
  // Foreground lock가 허용하는 현재 테스트 프로세스 경로도 함께 시도한다.
  if (parseNativeHwnd(win32.GetForegroundWindow()) !== gameHwnd) {
    await activateNativeWindowForTest(win32, gameHwnd);
  }
  await waitForForeground(win32, gameHwnd);
  await waitForStableForeground(win32, gameHwnd);
  return status;
}

async function runScenario(mode: FixtureMode, scenarioIndex: number): Promise<ScenarioResult> {
  const scenarioRoot = path.join(temporaryRoot, mode);
  fs.mkdirSync(scenarioRoot, { recursive: true });
  const statusPath = path.join(scenarioRoot, 'fixture-status.json');
  const commandPath = path.join(scenarioRoot, 'fixture-command.json');
  const fixture = spawn(fixturePath, [
    '--mode', mode,
    '--role', 'game',
    '--status-file', statusPath,
    '--command-file', commandPath,
    '--activate',
  ], { stdio: 'ignore', windowsHide: false });
  childProcesses.add(fixture);

  const status = await waitFor(
    () => readJsonFile<FixtureStatus>(statusPath),
    `${mode} fixture status`,
    10_000,
  );
  assert.equal(status.title.includes('Talesweaver'), true);
  assert.equal(status.mode, mode);
  assert.equal(status.topMost, false);

  const win32 = require(path.join(projectRoot, 'dist', 'modules', 'win32.js')) as Win32Runtime;
  const tracker = require(path.join(projectRoot, 'dist', 'modules', 'tracker.js')) as TrackerRuntime;
  tracker.start();
  await waitFor(() => tracker.isGameRunning() && tracker.getGameHwnd(), `${mode} tracker detection`);
  const detectedHwndText = tracker.getGameHwnd();
  assert.ok(detectedHwndText, `${mode} tracker did not expose a game HWND`);
  const gameHwnd = BigInt(detectedHwndText);
  assert.equal(gameHwnd, BigInt(status.hwnd), `${mode} tracker detected a different HWND`);

  if (mode === 'borderless') {
    await waitFor(
      () => {
        const rect = readWindowRect(win32, gameHwnd);
        return rect.left === status.screenBounds.X
          && rect.top === status.screenBounds.Y
          && rect.right === status.screenBounds.X + status.screenBounds.Width
          && rect.bottom === status.screenBounds.Y + status.screenBounds.Height
          ? rect
          : null;
      },
      `${mode} native fixture bounds`,
      5_000,
    );
  }
  const gameRectBefore = readWindowRect(win32, gameHwnd);
  const gameTopmostBefore = isTopmost(win32, gameHwnd);
  const gameStyle = win32.GetWindowLongW(gameHwnd, -16);
  const wsCaption = 0x00c00000;
  if (mode === 'borderless') {
    assert.equal(gameStyle & wsCaption, 0, 'borderless fixture still has a caption');
    assert.deepEqual(gameRectBefore, {
      left: status.screenBounds.X,
      top: status.screenBounds.Y,
      right: status.screenBounds.X + status.screenBounds.Width,
      bottom: status.screenBounds.Y + status.screenBounds.Height,
    });
  } else {
    assert.notEqual(gameStyle & wsCaption, 0, 'windowed fixture has no caption');
    assert.ok(
      gameRectBefore.right - gameRectBefore.left < status.screenBounds.Width
        || gameRectBefore.bottom - gameRectBefore.top < status.screenBounds.Height,
      'windowed fixture unexpectedly covers the complete display',
    );
  }

  const baseX = status.screenBounds.X + 80 + (scenarioIndex * 20);
  const baseY = status.screenBounds.Y + 80 + (scenarioIndex * 20);
  const [firstOverlay, secondOverlay, externalWindow] = await Promise.all([
    createTestWindow(`Twoverlay Overlay A (${mode})`, '#194b7a', baseX, baseY),
    createTestWindow(`Twoverlay Overlay B (${mode})`, '#5b2c83', baseX + 40, baseY + 40),
    createTestWindow(`External App (${mode})`, '#744210', baseX + 80, baseY + 80),
  ]);
  const firstOverlayHwnd = browserWindowHwnd(firstOverlay);
  const secondOverlayHwnd = browserWindowHwnd(secondOverlay);
  const externalHwnd = browserWindowHwnd(externalWindow);

  await activateFixture(win32, commandPath, statusPath, gameHwnd, 1);
  const gameRectBeforeReconcile = readWindowRect(win32, gameHwnd);
  const gameTopmostBeforeReconcile = isTopmost(win32, gameHwnd);
  const foregroundBeforeReconcile = parseNativeHwnd(win32.GetForegroundWindow());
  tracker.reconcileGameZOrder(detectedHwndText, [firstOverlayHwnd.toString(), secondOverlayHwnd.toString()]);
  const foregroundImmediatelyAfterReconcile = parseNativeHwnd(win32.GetForegroundWindow());
  await delay(100);
  if (!isOverlayStackIntact(win32, firstOverlayHwnd, secondOverlayHwnd)
      || !isAbove(win32, secondOverlayHwnd, gameHwnd)) {
    const labels = new Map([
      [gameHwnd, 'game'],
      [firstOverlayHwnd, 'overlay-a'],
      [secondOverlayHwnd, 'overlay-b'],
      [externalHwnd, 'external'],
    ]);
    console.warn('[Z_ORDER_WINDOWS_PROBE] handles:', {
      gameHwnd: gameHwnd.toString(),
      firstOverlayHwnd: firstOverlayHwnd.toString(),
      secondOverlayHwnd: secondOverlayHwnd.toString(),
      externalHwnd: externalHwnd.toString(),
      firstOverlayRect: readWindowRect(win32, firstOverlayHwnd),
      secondOverlayRect: readWindowRect(win32, secondOverlayHwnd),
    });
    console.warn('[Z_ORDER_WINDOWS_PROBE] game chain:', describeZOrderChain(win32, gameHwnd, labels));
    console.warn('[Z_ORDER_WINDOWS_PROBE] overlay A chain:', describeZOrderChain(win32, firstOverlayHwnd, labels));
    console.warn('[Z_ORDER_WINDOWS_PROBE] overlay B chain:', describeZOrderChain(win32, secondOverlayHwnd, labels));
  }
  await waitFor(
    () => isOverlayStackIntact(win32, firstOverlayHwnd, secondOverlayHwnd)
      && isAbove(win32, firstOverlayHwnd, gameHwnd)
      && isAbove(win32, secondOverlayHwnd, gameHwnd)
      && isTopmost(win32, firstOverlayHwnd)
      && isTopmost(win32, secondOverlayHwnd),
    `${mode} game overlay stack`,
  );
  const foregroundAfterReconcile = parseNativeHwnd(win32.GetForegroundWindow());
  const foregroundPreservedForGame = foregroundBeforeReconcile === gameHwnd
    && foregroundImmediatelyAfterReconcile === gameHwnd
    && foregroundAfterReconcile === gameHwnd;
  const foregroundLabels = new Map([
    [gameHwnd, 'game'],
    [firstOverlayHwnd, 'overlay-a'],
    [secondOverlayHwnd, 'overlay-b'],
    [externalHwnd, 'external'],
  ]);
  assert.equal(
    foregroundPreservedForGame,
    true,
    `${mode} reconcile foreground changed before=${foregroundLabels.get(foregroundBeforeReconcile) ?? foregroundBeforeReconcile} immediately=${foregroundLabels.get(foregroundImmediatelyAfterReconcile) ?? foregroundImmediatelyAfterReconcile} after100ms=${foregroundLabels.get(foregroundAfterReconcile) ?? foregroundAfterReconcile}`,
  );
  assert.deepEqual(readWindowRect(win32, gameHwnd), gameRectBeforeReconcile, `${mode} reconcile moved/resized game`);
  assert.equal(isTopmost(win32, gameHwnd), gameTopmostBeforeReconcile, `${mode} reconcile changed game Topmost`);
  const overlayTopmostWhileGameActive = isTopmost(win32, firstOverlayHwnd)
    && isTopmost(win32, secondOverlayHwnd);
  assert.equal(overlayTopmostWhileGameActive, true, `${mode} game-active overlays were not promoted`);

  await activateBrowserWindowForTest(win32, externalWindow, externalHwnd);
  // 실제 회귀처럼 우리 창 하나를 외부 전경 창보다 위로 흩뜨린 뒤 중앙 정책으로 복구한다.
  assert.equal(!!win32.SetWindowPos(
    firstOverlayHwnd,
    win32.HWND_TOP,
    0,
    0,
    0,
    0,
    win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE,
  ), true);
  assert.equal(isAbove(win32, firstOverlayHwnd, externalHwnd), true, `${mode} scatter setup failed`);
  tracker.reconcileGameZOrder(detectedHwndText, [firstOverlayHwnd.toString(), secondOverlayHwnd.toString()]);
  const externalOverlapsGame = rectsOverlap(readWindowRect(win32, externalHwnd), gameRectBefore);
  await waitFor(
    () => isTopmost(win32, firstOverlayHwnd) === gameTopmostBefore
      && isTopmost(win32, secondOverlayHwnd) === gameTopmostBefore
      && getVisibleWindowAbove(win32, gameHwnd) === secondOverlayHwnd
      && isOverlayStackIntact(win32, firstOverlayHwnd, secondOverlayHwnd)
      && isAbove(win32, externalHwnd, firstOverlayHwnd)
      && isAbove(win32, externalHwnd, secondOverlayHwnd)
      && isAbove(win32, externalHwnd, gameHwnd),
    `${mode} external order repair`,
  );
  // 이후의 명시적 앱 활성화 시나리오는 선택한 TW-Overlay 창을 foreground로
  // 올리므로 내부 창 순서가 달라질 수 있다. 외부 전경에서 흐트러진 스택을
  // 복구했는지는 바로 이 시점의 결과를 보존해 별도 정책의 결과와 섞지 않는다.
  const overlayStackRepaired = getVisibleWindowAbove(win32, gameHwnd) === secondOverlayHwnd
    && isOverlayStackIntact(win32, firstOverlayHwnd, secondOverlayHwnd);
  const foregroundPreservedForExternal = parseNativeHwnd(win32.GetForegroundWindow()) === externalHwnd;
  const overlayBandsMatchGame = isTopmost(win32, firstOverlayHwnd) === gameTopmostBefore
    && isTopmost(win32, secondOverlayHwnd) === gameTopmostBefore;
  const externalOrderingPolicyPreserved = isAbove(win32, externalHwnd, firstOverlayHwnd)
    && isAbove(win32, externalHwnd, secondOverlayHwnd)
    && isAbove(win32, externalHwnd, gameHwnd);
  assert.equal(foregroundPreservedForExternal, true, `${mode} reconcile stole external foreground`);
  assert.equal(externalOrderingPolicyPreserved, true, `${mode} external ordering policy was not preserved`);
  assert.equal(overlayBandsMatchGame, true, `${mode} overlay band diverged from the game`);
  assert.deepEqual(readWindowRect(win32, gameHwnd), gameRectBefore, `${mode} scenario changed game bounds`);
  assert.equal(isTopmost(win32, gameHwnd), gameTopmostBefore, `${mode} scenario changed game Topmost`);
  assert.equal(
    isTopmost(win32, firstOverlayHwnd),
    gameTopmostBefore,
    `${mode} overlay A band mismatch`,
  );
  assert.equal(
    isTopmost(win32, secondOverlayHwnd),
    gameTopmostBefore,
    `${mode} overlay B band mismatch`,
  );

  // 외부 앱이 게임과 TW-Overlay를 모두 가린 뒤 사용자가 작업표시줄의 우리 창을
  // 선택한 상황을 재현한다. 이 명시적 활성화에서만 게임을 먼저 올린 뒤 선택한
  // 우리 창을 다시 foreground로 돌려 `외부 < 게임 < TW-Overlay`를 만든다.
  const gameRaisedForAppActivation = tracker.focusGameForAppActivation(firstOverlayHwnd.toString());
  assert.equal(gameRaisedForAppActivation, false, `${mode} non-foreground app request was accepted`);
  await activateBrowserWindowForTest(win32, firstOverlay, firstOverlayHwnd);
  const explicitGameRaiseSucceeded = tracker.focusGameForAppActivation(firstOverlayHwnd.toString());
  assert.equal(explicitGameRaiseSucceeded, true, `${mode} explicit app activation did not raise the game`);
  await activateBrowserWindowForTest(win32, firstOverlay, firstOverlayHwnd);
  tracker.reconcileGameZOrder(detectedHwndText, [firstOverlayHwnd.toString(), secondOverlayHwnd.toString()]);
  await waitFor(
    () => parseNativeHwnd(win32.GetForegroundWindow()) === firstOverlayHwnd
      && isAbove(win32, firstOverlayHwnd, gameHwnd)
      && isAbove(win32, secondOverlayHwnd, gameHwnd)
      && isAbove(win32, gameHwnd, externalHwnd),
    `${mode} explicit app group activation`,
  );
  const appActivationRaisedGame = parseNativeHwnd(win32.GetForegroundWindow()) === firstOverlayHwnd
    && isAbove(win32, gameHwnd, externalHwnd)
    && isAbove(win32, firstOverlayHwnd, gameHwnd)
    && isAbove(win32, secondOverlayHwnd, gameHwnd);
  assert.deepEqual(readWindowRect(win32, gameHwnd), gameRectBefore, `${mode} app activation changed game bounds`);
  assert.equal(isTopmost(win32, gameHwnd), gameTopmostBefore, `${mode} app activation changed game Topmost`);

  const result: ScenarioResult = {
    mode,
    detectedHwnd: detectedHwndText,
    gameBounds: gameRectBefore,
    screenBounds: status.screenBounds,
    gameTopmost: gameTopmostBefore,
    foregroundPreservedForGame,
    foregroundPreservedForExternal,
    overlayTopmostWhileGameActive,
    externalOverlapsGame,
    externalOrderingPolicyPreserved,
    overlayBandsMatchGame,
    overlayStackRepaired,
    appActivationRaisedGame,
  };

  await Promise.all([firstOverlay, secondOverlay, externalWindow].map(closeWindow));
  tracker.stop();
  writeCommand(commandPath, { sequence: 2, action: 'close' });
  await Promise.race([
    new Promise<void>(resolve => fixture.once('exit', () => resolve())),
    delay(2_000),
  ]);
  if (fixture.exitCode === null) fixture.kill();
  childProcesses.delete(fixture);
  return result;
}

async function cleanup(): Promise<void> {
  for (const window of windows.splice(0)) {
    if (!window.isDestroyed()) window.destroy();
  }
  for (const child of childProcesses) {
    if (child.exitCode === null) child.kill();
  }
  childProcesses.clear();
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } catch {
    // 프로세스 해제 지연으로 임시 폴더가 남아도 제품 데이터에는 영향이 없다.
  }
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'test:zorder:windows is Windows-only');
  assert.equal(fs.existsSync(fixturePath), true, `fixture executable not found: ${fixturePath}`);
  const shell32 = koffi.load('shell32.dll');
  const isUserAnAdmin = shell32.func('__stdcall', 'IsUserAnAdmin', 'bool', []);
  const elevated = !!isUserAnAdmin();
  assert.equal(
    elevated || allowUnelevated,
    true,
    '관리자 PowerShell에서 npm run test:zorder:windows를 실행해야 합니다.',
  );
  const results: ScenarioResult[] = [];
  results.push(await runScenario('windowed', 0));
  results.push(await runScenario('borderless', 1));
  console.log(JSON.stringify({ passed: true, elevated, fixturePath, results }, null, 2));
}

// 두 시나리오 사이에 모든 BrowserWindow를 닫아도 명시적 app.exit까지 프로세스를 유지한다.
app.on('window-all-closed', () => undefined);
app.whenReady()
  .then(main)
  .then(async () => {
    await cleanup();
    app.exit(0);
  })
  .catch(async error => {
    console.error('[Z_ORDER_WINDOWS_PROBE] failed:', error);
    await cleanup();
    app.exit(1);
  });
