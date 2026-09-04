/**
 * 기능 계약 — TalesWeaver 창 탐지와 Win32 z-order 입력
 *
 * - 창 제목만 믿지 않고 제목에 `Talesweaver`가 있으며 실제 프로세스 경로가
 *   `GAME_PROCESS_NAME`인 최상위 창만 게임으로 인정합니다. 찾은 HWND/PID는 재검증 가능한 캐시입니다.
 * - WinEventHook으로 게임의 위치·크기와 전경 변경을 즉시 전달하고, 폴링은 hook 누락과 프로세스
 *   재시작을 복구하는 보조 경로입니다. hook과 폴링 콜백은 같은 창 상태 계약을 따라야 합니다.
 * - z-order의 목표는 게임이 활성일 때 TW-Overlay만 게임 위에 두고, 브라우저 등 다른 앱이 활성일
 *   때 게임과 오버레이가 그 앱을 덮지 않는 샌드위치 구조입니다. 게임만 강제 topmost로 두지 않습니다.
 * - 실제 게임과 앱은 관리자 권한으로 실행되는 전제입니다. `requestedExecutionLevel=requireAdministrator`
 *   또는 Win32 z-order 호출을 바꿀 때는 관리자 PowerShell의 실제 fixture 검증을 먼저 통과해야 합니다.
 * - Koffi 콜백과 native handle은 앱 종료까지 수명이 유지되어야 하며, 재시작 시 이전 hook/handle을
 *   해제해 중복 콜백과 메모리 누수를 만들지 않습니다.
 */
import { GAME_PROCESS_NAME, GameQueryResult, TITLE_BUFFER_LENGTH } from './constants';
import { log } from './logger';
import * as win32 from './win32';
import { gameOverlayZOrderController } from './zOrderController';
import koffi from 'koffi';

let cachedHwnd: bigint | null = null;
let lastProcessId: number | null = null;
let hEventHook: bigint | null = null;
let hLocationEventHook: bigint | null = null;
let hMinimizeEventHook: bigint | null = null;
let onWindowEventCallback: (() => void) | null = null;
let onForegroundChangeCallback: ((isGameFocused: boolean, focusedHwnd: string) => void) | null = null;
let lastNotifiedForegroundHwnd: bigint | null = null;

// --- 메모리 최적화를 위한 재사용 버퍼 ---
const titleBuffer = Buffer.alloc(TITLE_BUFFER_LENGTH * 2);
const classNameBuffer = Buffer.alloc(256 * 2);
const nameBuffer = Buffer.alloc(512);
const pidPtr = Buffer.alloc(4);
const sizePtr = Buffer.alloc(4);
const rectOut = { left: 0, top: 0, right: 0, bottom: 0 };

/** hwnd 값을 안전하게 bigint로 변환하는 헬퍼 함수 */
function parseHwnd(hwnd: any): bigint {
    if (hwnd === null || hwnd === undefined || !hwnd) return 0n;
    if (typeof hwnd === 'bigint') return hwnd;
    if (typeof hwnd === 'number') {
        try {
            return BigInt(Math.trunc(hwnd));
        } catch {
            return 0n;
        }
    }
    if (hwnd && typeof hwnd === 'object') {
        try {
            return koffi.address(hwnd);
        } catch {
            try {
                return BigInt(String(hwnd));
            } catch {
                return 0n;
            }
        }
    }
    try {
        const str = String(hwnd).trim();
        return str ? BigInt(str) : 0n;
    } catch {
        return 0n;
    }
}

// --- 콜백 등록 ---

// 1. 창 열거(EnumWindows) 콜백
const EnumWindowsProc = koffi.proto('__stdcall', 'bool', ['intptr', 'intptr']);
const EnumWindowsProcPtr = koffi.pointer(EnumWindowsProc);

let _tempFoundHwnd: bigint | null = null;
let _tempFoundPid: number | null = null;

const enumCallback = koffi.register((hwnd: any, _lParam: bigint) => {
    const safeHwnd = parseHwnd(hwnd);
    const titleLen = win32.GetWindowTextW(safeHwnd, titleBuffer, TITLE_BUFFER_LENGTH);
    if (titleLen === 0) return true;

    const title = titleBuffer.toString('utf16le', 0, titleLen * 2);
    if (title.includes('Talesweaver')) {
        win32.GetWindowThreadProcessId(safeHwnd, pidPtr);
        const pid = pidPtr.readUInt32LE(0);

        let hProcess = 0n;
        try {
            hProcess = win32.OpenProcess(win32.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProcess !== 0n) {
                sizePtr.writeUInt32LE(TITLE_BUFFER_LENGTH, 0);
                if (win32.QueryFullProcessImageNameW(hProcess, 0, nameBuffer, sizePtr)) {
                    const nameLen = sizePtr.readUInt32LE(0);
                    const fullPath = nameBuffer.toString('utf16le', 0, nameLen * 2);
                    if (fullPath.toLowerCase().includes(GAME_PROCESS_NAME.toLowerCase())) {
                        _tempFoundHwnd = safeHwnd;
                        _tempFoundPid = pid;
                        return false;
                    }
                }
            }
        } catch {
            // 프로세스 접근 실패 시 무시
        } finally {
            if (hProcess !== 0n) win32.CloseHandle(hProcess);
        }
    }
    return true;
}, EnumWindowsProcPtr);

// 2. 윈도우 이벤트(WinEvent) 콜백
const WinEventProcProto = koffi.proto('__stdcall', 'void', ['intptr', 'uint32', 'intptr', 'int32', 'int32', 'uint32', 'uint32']);
const WinEventProcPtr = koffi.pointer(WinEventProcProto);

const winEventProcInstance = koffi.register((_hWinEventHook: bigint, event: number, hwnd: any, idObject: number, idChild: number, _dwEventThread: number, _dwmsEventTime: number) => {
    const safeHwnd = parseHwnd(hwnd);
    if (cachedHwnd && safeHwnd === cachedHwnd) {
        if (onWindowEventCallback) onWindowEventCallback();
    }
    // 포그라운드 변경 이벤트: 즉각적인 포커스 감지
    if (event === win32.EVENT_SYSTEM_FOREGROUND && onForegroundChangeCallback) {
        notifyForegroundChange(safeHwnd);
    }

    // 반대편 모니터의 전경 창을 게임 모니터로 끌어오는 동안에는 foreground가
    // 바뀌지 않는다. 해당 전경 창의 이동도 즉시 다시 판정해야 Topmost인 게임이
    // 최대 1초 동안 외부 창을 가리는 현상이 생기지 않는다.
    if (event === win32.EVENT_OBJECT_LOCATIONCHANGE
        && idObject === win32.OBJID_WINDOW
        && idChild === 0
        && onForegroundChangeCallback
        && win32.GetForegroundWindow) {
        const foregroundHwnd = parseHwnd(win32.GetForegroundWindow());
        if (safeHwnd !== 0n && safeHwnd === foregroundHwnd) {
            notifyForegroundChange(safeHwnd);
        }
    }
}, WinEventProcPtr);


// --- 내부 함수 ---

/**
 * WinEventHook 누락과 앱 시작 시점의 스플래시/UAC 포커스 경쟁을 폴링이 보완할 수 있도록
 * 모든 포커스 통지는 이 경로에서 중복 제거합니다. 게임이 먼저 실행된 경우에도 첫 안정 폴링에서
 * 현재 foreground를 다시 평가해야 전역 단축키가 등록됩니다.
 */
function notifyForegroundChange(foregroundHwnd: bigint, force = false): void {
    if (!onForegroundChangeCallback) return;
    if (!force && lastNotifiedForegroundHwnd === foregroundHwnd) return;
    lastNotifiedForegroundHwnd = foregroundHwnd;
    const isGameFocused = cachedHwnd !== null && foregroundHwnd === cachedHwnd;
    onForegroundChangeCallback(isGameFocused, foregroundHwnd.toString());
}

function notifyCurrentForeground(force = false): bigint {
    const foregroundHwnd = win32.GetForegroundWindow
        ? parseHwnd(win32.GetForegroundWindow())
        : 0n;
    notifyForegroundChange(foregroundHwnd, force);
    return foregroundHwnd;
}

function setupEventHook(): void {
    if (!hEventHook) {
        hEventHook = win32.SetWinEventHook(
            win32.EVENT_SYSTEM_FOREGROUND,
            win32.EVENT_SYSTEM_FOREGROUND,
            0n,
            winEventProcInstance,
            0,
            0,
            win32.WINEVENT_OUTOFCONTEXT
        );
    }
    if (!hLocationEventHook) {
        hLocationEventHook = win32.SetWinEventHook(
            win32.EVENT_OBJECT_LOCATIONCHANGE,
            win32.EVENT_OBJECT_LOCATIONCHANGE,
            0n,
            winEventProcInstance,
            0,
            0,
            win32.WINEVENT_OUTOFCONTEXT
        );
    }
    if (!hMinimizeEventHook) {
        hMinimizeEventHook = win32.SetWinEventHook(
            win32.EVENT_SYSTEM_MINIMIZESTART,
            win32.EVENT_SYSTEM_MINIMIZEEND,
            0n,
            winEventProcInstance,
            0,
            0,
            win32.WINEVENT_OUTOFCONTEXT
        );
    }
}

function findGameWindow(): bigint | null {
    _tempFoundHwnd = null;
    _tempFoundPid = null;
    try {
        win32.EnumWindows(enumCallback, 0);
    } catch (e) {
        log(`[TRACKER] EnumWindows Error: ${e}`);
    }

    if (_tempFoundHwnd) {
        lastProcessId = _tempFoundPid;
        setupEventHook();
        return _tempFoundHwnd;
    }
    return null;
}

function isHwndValid(hwnd: any): boolean {
    if (!hwnd) return false;
    const safeHwnd = parseHwnd(hwnd);
    const threadId = win32.GetWindowThreadProcessId(safeHwnd, pidPtr);
    if (threadId === 0) return false;
    return pidPtr.readUInt32LE(0) === lastProcessId;
}

// --- 외부 API ---

export function getGameHwnd(): string | undefined {
    return cachedHwnd ? cachedHwnd.toString() : undefined;
}

export function getGameProcessId(): number | null {
    return lastProcessId;
}

export function isGameRunning(): boolean {
    if (!cachedHwnd || !isHwndValid(cachedHwnd)) {
        cachedHwnd = findGameWindow();
    }
    return cachedHwnd !== null;
}

export function start(): void {
    log('[TRACKER] Native tracker initialized.');
}

export function setWindowEventListener(callback: () => void): void {
    onWindowEventCallback = callback;
}

export function setForegroundChangeListener(callback: (isGameFocused: boolean, focusedHwnd: string) => void): void {
    onForegroundChangeCallback = callback;
    
    // 리스너가 등록되는 즉시 현재 활성화된 창(Foreground Window)의 포커스 상태를 1회 평가하여 호출합니다.
    try {
        if (!win32.GetForegroundWindow) return;
        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        if (fgHwnd !== 0n) {
            // 게임 창이 아직 감지되지 않았다면 미리 찾아둡니다.
            if (!cachedHwnd) {
                cachedHwnd = findGameWindow();
            }
            notifyForegroundChange(fgHwnd, true);
        }
    } catch (e) {
        log(`[TRACKER] Initial foreground check error: ${e}`);
    }
}

export async function queryGameRect(): Promise<GameQueryResult> {
    try {
        let gameWindowRedetected = false;
        if (!cachedHwnd || !isHwndValid(cachedHwnd)) {
            cachedHwnd = findGameWindow();
            if (!cachedHwnd) {
                notifyCurrentForeground();
                return { notRunning: true };
            }
            gameWindowRedetected = true;
            log(`[TRACKER] Found game window: ${cachedHwnd} (PID: ${lastProcessId})`);
        }

        // 게임 HWND가 리스너 등록 단계에서 이미 캐시된 경우에도 매 폴링의 실제 foreground를 비교합니다.
        // 값이 바뀐 경우에만 콜백하므로 안정 상태에서는 중복 등록/Win32 작업을 만들지 않습니다.
        const foregroundHwnd = notifyCurrentForeground(gameWindowRedetected);

        if (win32.IsIconic(cachedHwnd)) return null;

        let res = win32.DwmGetWindowAttribute(cachedHwnd, win32.DWMWA_EXTENDED_FRAME_BOUNDS, rectOut, 16);
        if (res !== 0 && !win32.GetWindowRect(cachedHwnd, rectOut)) {
            return { error: 'Failed to get rect' };
        }

        return {
            x: rectOut.left,
            y: rectOut.top,
            width: rectOut.right - rectOut.left,
            height: rectOut.bottom - rectOut.top,
            windowStyle: win32.GetWindowLongW(cachedHwnd, win32.GWL_STYLE),
            gameHwnd: cachedHwnd.toString(),
            isForeground: foregroundHwnd === cachedHwnd
        };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] queryGameRect Error: ${msg}`);
        return undefined;
    }
}

export function stop() {
    releaseGameZOrder();
    if (hEventHook) {
        win32.UnhookWinEvent(hEventHook);
        hEventHook = null;
    }
    if (hLocationEventHook) {
        win32.UnhookWinEvent(hLocationEventHook);
        hLocationEventHook = null;
    }
    if (hMinimizeEventHook) {
        win32.UnhookWinEvent(hMinimizeEventHook);
        hMinimizeEventHook = null;
    }
    cachedHwnd = null;
    lastNotifiedForegroundHwnd = null;
}

/**
 * 포커스·창 이동·안정 폴링 사건을 단일 z-order 상태 관리자에 전달한다.
 * 이 함수 밖에서는 게임/TW-Overlay 묶음의 Win32 순서를 결정하지 않는다.
 */
export function reconcileGameZOrder(gameHwndStr: string | undefined, electronHwnds: string[]): { isGameOrAppFocused: boolean } {
    if (!gameHwndStr || electronHwnds.length === 0) return { isGameOrAppFocused: false };
    try {
        const gameHwnd = BigInt(gameHwndStr);
        const electronHwndBigInts = electronHwnds
            .map(h => {
                try {
                    return BigInt(h);
                } catch {
                    return 0n;
                }
            })
            .filter(h => h !== 0n);
        if (electronHwndBigInts.length === 0) return { isGameOrAppFocused: false };
        const result = gameOverlayZOrderController.reconcile({
            gameHwnd,
            overlayHwnds: electronHwndBigInts,
        });
        return { isGameOrAppFocused: result.isGameOrAppFocused };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] Z-order event forwarding failed: ${msg}`);
        return { isGameOrAppFocused: false };
    }
}

export async function boostGameProcess(): Promise<string | undefined> {
    if (!lastProcessId) return 'BOOST_FAIL';
    let hProcess = 0n;
    try {
        hProcess = win32.OpenProcess(win32.PROCESS_SET_INFORMATION, false, lastProcessId);
        if (hProcess === 0n) return 'BOOST_FAIL';
        return win32.SetPriorityClass(hProcess, win32.HIGH_PRIORITY_CLASS) ? 'BOOSTED' : 'BOOST_FAIL';
    } catch (e) {
        return 'BOOST_FAIL';
    } finally {
        if (hProcess !== 0n) win32.CloseHandle(hProcess);
    }
}

export function focusGameWindow(): boolean {
    if (!cachedHwnd || !isHwndValid(cachedHwnd)) return false;
    try {
        // 이미 게임 창이 활성화 상태라면 아무것도 하지 않습니다 (깜박임 방지)
        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        if (fgHwnd === cachedHwnd) return true;

        // 실제 최소화된 경우에만 show state를 복원한다. 창모드 전체화면의 정상 show state는 건드리지 않는다.
        if (win32.IsIconic && win32.IsIconic(cachedHwnd) && win32.ShowWindow) {
            win32.ShowWindow(cachedHwnd, win32.SW_RESTORE);
        }
        const requested = win32.SetForegroundWindow
            ? !!win32.SetForegroundWindow(cachedHwnd)
            : false;
        const newFgHwnd = parseHwnd(win32.GetForegroundWindow());
        const focused = newFgHwnd === cachedHwnd;
        log(`[TRACKER] Automatic focus restore ${focused ? 'succeeded' : 'skipped/failed'} (requested=${requested}, previous=${fgHwnd}, current=${newFgHwnd})`);
        return focused;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] Focus failed: ${msg}`);
        return false;
    }
}

/**
 * 외부 앱에 가려진 상태에서 사용자가 TW-Overlay 창을 명시적으로 활성화했을 때만
 * 게임을 같은 작업 묶음으로 한 번 올린다. 자동 복구와 달리 호출 원인이 명확한 경로이며,
 * 사용자가 최소화한 게임의 show state와 Topmost 스타일은 절대 변경하지 않는다.
 */
export function focusGameForAppActivation(expectedAppHwndText: string): boolean {
    if (!cachedHwnd || !isHwndValid(cachedHwnd) || !win32.GetForegroundWindow) return false;
    try {
        const expectedAppHwnd = parseHwnd(expectedAppHwndText);
        const foregroundBefore = parseHwnd(win32.GetForegroundWindow());
        if (expectedAppHwnd === 0n || foregroundBefore !== expectedAppHwnd) {
            log(`[TRACKER] Explicit app activation skipped: foreground changed expected=${expectedAppHwnd} current=${foregroundBefore}`);
            return false;
        }
        if (win32.IsIconic && win32.IsIconic(cachedHwnd)) {
            log('[TRACKER] Explicit app activation skipped: game is minimized');
            return false;
        }

        const requested = win32.SetForegroundWindow
            ? !!win32.SetForegroundWindow(cachedHwnd)
            : false;
        const foregroundAfter = parseHwnd(win32.GetForegroundWindow());
        const focused = foregroundAfter === cachedHwnd;
        log(`[TRACKER] Explicit app activation game raise ${focused ? 'succeeded' : 'failed'} requested=${requested} app=${expectedAppHwnd} game=${cachedHwnd} current=${foregroundAfter}`);
        return focused;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[TRACKER] Explicit app activation game raise failed: ${message}`);
        return false;
    }
}

/** 앱 종료·게임 숨김 시 TW-Overlay 창에 남은 일시 Topmost 상태만 정리한다. */
export function releaseGameZOrder(): void {
    try {
        gameOverlayZOrderController.release();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] Z-Order release failed: ${msg}`);
    }
}

function getWindowClassName(hwnd: bigint): string {
    if (hwnd === 0n || !win32.GetClassNameW) return '';
    classNameBuffer.fill(0);
    const length = win32.GetClassNameW(hwnd, classNameBuffer, 256);
    return length > 0 ? classNameBuffer.toString('utf16le', 0, length * 2) : '';
}

function isTaskbarWindow(hwnd: bigint): boolean {
    const className = getWindowClassName(hwnd);
    return className === 'Shell_TrayWnd' || className === 'Shell_SecondaryTrayWnd';
}

/**
 * TW-Overlay 설정창 종료로 Windows 작업표시줄이 잠시 foreground를 가져간 경우만
 * 게임 포커스를 복원한다. 실제 외부 앱이 foreground면 반드시 거부한다.
 */
export function restoreGameAfterOwnedWindowClose(reason: string): boolean {
    if (!cachedHwnd || !isHwndValid(cachedHwnd) || !win32.GetForegroundWindow) return false;
    try {
        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        const wm = require('./windowManager');
        const appHwnds = wm.getAllWindowHwnds().map((h: string) => BigInt(h));
        const foregroundClass = getWindowClassName(fgHwnd);
        const allowed = fgHwnd === 0n
            || fgHwnd === cachedHwnd
            || appHwnds.includes(fgHwnd)
            || isTaskbarWindow(fgHwnd);
        log(`[TRACKER] Owned-window restore check reason=${reason} allowed=${allowed} foreground=${fgHwnd} class=${foregroundClass || 'unknown'} game=${cachedHwnd}`);
        if (!allowed) return false;

        // 게임이 이미 foreground여도 설정창 종료 후 Shell의 전체화면 판정을 재평가하도록
        // SetForegroundWindow를 한 번 명시적으로 호출한다. show state·TOPMOST·가상 키는 변경하지 않는다.
        const requested = win32.SetForegroundWindow ? !!win32.SetForegroundWindow(cachedHwnd) : false;
        const currentHwnd = parseHwnd(win32.GetForegroundWindow());
        const focused = currentHwnd === cachedHwnd;
        log(`[TRACKER] Owned-window restore ${focused ? 'succeeded' : 'failed'} reason=${reason} requested=${requested} current=${currentHwnd}`);
        return focused;
    } catch (error) {
        log(`[TRACKER] Owned-window restore failed reason=${reason}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

export function isGameOrAppForeground(): boolean {
    try {
        if (!win32.GetForegroundWindow) return false;
        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        if (fgHwnd === 0n) return false;

        // 1. 게임 창 포커스 체크
        if (cachedHwnd && fgHwnd === cachedHwnd) return true;

        // 2. 우리 앱 창 포커스 체크 (순환 참조 방지를 위해 함수 내에서 require)
        const wm = require('./windowManager');
        const electronHwndBigInts = wm.getAllWindowHwnds().map((h: string) => BigInt(h));
        if (electronHwndBigInts.includes(fgHwnd)) return true;
    } catch (e) {
        // 에러 시 안전하게 false 반환
    }
    return false;
}

/** 자동 포커스 복구가 외부 프로그램의 포커스를 빼앗지 않는 상태인지 확인한다. */
export function canAutomaticallyRestoreGameFocus(): boolean {
    try {
        if (!win32.GetForegroundWindow) return false;
        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        // 창 닫힘 직후 Windows가 잠시 foreground를 비운 과도기는 복구를 허용하되,
        // 실제 외부 HWND가 전경이면 반드시 거부한다.
        if (fgHwnd === 0n) return true;
        if (cachedHwnd && fgHwnd === cachedHwnd) return true;
        const wm = require('./windowManager');
        const electronHwndBigInts = wm.getAllWindowHwnds().map((h: string) => BigInt(h));
        return electronHwndBigInts.includes(fgHwnd);
    } catch {
        return false;
    }
}
