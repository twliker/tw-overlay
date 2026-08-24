/**
 * 게임 창 추적 모듈 - Native Win32 API (Koffi) 버전
 * 
 * [주요 기능]
 * 1. WinEventHook을 통한 실시간 창 이동 및 포커스 감지
 * 2. 샌드위치 Z-Order 로직: 게임 위에 붙으면서도 다른 앱(브라우저 등) 뒤로 숨음
 * 3. 메모리 및 깜박임 최적화 (Buffer 재사용 및 포커스 캐싱)
 */
import { GAME_PROCESS_NAME, GameQueryResult, TITLE_BUFFER_LENGTH } from './constants';
import { log } from './logger';
import * as win32 from './win32';
import koffi from 'koffi';

let cachedHwnd: bigint | null = null;
let lastProcessId: number | null = null;
let hEventHook: bigint | null = null;
let onWindowEventCallback: (() => void) | null = null;
let onForegroundChangeCallback: ((isGameFocused: boolean, focusedHwnd: string) => void) | null = null;

// --- 메모리 최적화를 위한 재사용 버퍼 ---
const titleBuffer = Buffer.alloc(TITLE_BUFFER_LENGTH * 2);
const nameBuffer = Buffer.alloc(512);
const pidPtr = Buffer.alloc(4);
const sizePtr = Buffer.alloc(4);
const rectOut = { left: 0, top: 0, right: 0, bottom: 0 };

/** hwnd 값을 안전하게 bigint로 변환하는 헬퍼 함수 */
function parseHwnd(hwnd: any): bigint {
    if (hwnd === null || hwnd === undefined || !hwnd) return 0n;
    if (typeof hwnd === 'bigint') return hwnd;
    if (typeof hwnd === 'number') return BigInt(hwnd);
    if (hwnd && typeof hwnd === 'object') {
        try {
            return koffi.address(hwnd);
        } catch {
            return BigInt(hwnd);
        }
    }
    try {
        return BigInt(hwnd);
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

const winEventProcInstance = koffi.register((_hWinEventHook: bigint, event: number, hwnd: any, _idObject: number, _idChild: number, _dwEventThread: number, _dwmsEventTime: number) => {
    const safeHwnd = parseHwnd(hwnd);
    if (cachedHwnd && safeHwnd === cachedHwnd) {
        if (onWindowEventCallback) onWindowEventCallback();
    }
    // 포그라운드 변경 이벤트: 즉각적인 포커스 감지
    if (event === win32.EVENT_SYSTEM_FOREGROUND && onForegroundChangeCallback) {
        const isGameFocused = cachedHwnd !== null && safeHwnd === cachedHwnd;
        onForegroundChangeCallback(isGameFocused, safeHwnd.toString());
    }
}, WinEventProcPtr);


// --- 내부 함수 ---

function setupEventHook(): void {
    if (hEventHook) return;
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

export function isGameRunning(): boolean {
    if (!cachedHwnd || !isHwndValid(cachedHwnd)) {
        cachedHwnd = findGameWindow();
    }
    return cachedHwnd !== null;
}

export function restoreAndFocusGameWindow(): boolean {
    try {
        if (!cachedHwnd || !isHwndValid(cachedHwnd)) {
            cachedHwnd = findGameWindow();
        }
        if (!cachedHwnd) return false;

        if (win32.IsIconic && win32.IsIconic(cachedHwnd)) {
            if (win32.ShowWindow) {
                win32.ShowWindow(cachedHwnd, win32.SW_RESTORE);
            }
        }
        if (win32.BringWindowToTop) {
            win32.BringWindowToTop(cachedHwnd);
        }
        if (win32.SetForegroundWindow) {
            win32.SetForegroundWindow(cachedHwnd);
        }

        // 일반 포커스 실패 시에만 최후 수단으로 Alt 키 트릭 시도
        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        if (fgHwnd !== cachedHwnd && win32.keybd_event) {
            win32.keybd_event(win32.VK_MENU, 0, 0, 0);
            win32.keybd_event(win32.VK_MENU, 0, win32.KEYEVENTF_KEYUP, 0);
            if (win32.SetForegroundWindow) {
                win32.SetForegroundWindow(cachedHwnd);
            }
        }
        return true;
    } catch (e) {
        log(`[TRACKER] restoreAndFocusGameWindow Error: ${e}`);
        return false;
    }
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
            const isGameFocused = cachedHwnd !== null && fgHwnd === cachedHwnd;
            callback(isGameFocused, fgHwnd.toString());
        }
    } catch (e) {
        log(`[TRACKER] Initial foreground check error: ${e}`);
    }
}

export async function queryGameRect(): Promise<GameQueryResult> {
    try {
        if (!cachedHwnd || !isHwndValid(cachedHwnd)) {
            cachedHwnd = findGameWindow();
            if (!cachedHwnd) return { notRunning: true };
            log(`[TRACKER] Found game window: ${cachedHwnd} (PID: ${lastProcessId})`);

            // 최초 감지 또는 재감지 시, 현재 포커스 상태를 즉시 평가하여 단축키 상태를 업데이트합니다.
            if (onForegroundChangeCallback) {
                try {
                    const fgHwnd = parseHwnd(win32.GetForegroundWindow());
                    const isGameFocused = fgHwnd === cachedHwnd;
                    onForegroundChangeCallback(isGameFocused, fgHwnd.toString());
                } catch (e) {
                    log(`[TRACKER] Failed to trigger initial foreground callback: ${e}`);
                }
            }
        }

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
            gameHwnd: cachedHwnd.toString(),
            isForeground: parseHwnd(win32.GetForegroundWindow()) === cachedHwnd
        };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] queryGameRect Error: ${msg}`);
        return undefined;
    }
}

export function stop() {
    if (hEventHook) {
        win32.UnhookWinEvent(hEventHook);
        hEventHook = null;
    }
    cachedHwnd = null;
}

/** 
 * 오버레이 창들을 게임 바로 위로 올림 (Z-Order 샌드위치 최적화 로직)
 */
export function promoteWindows(gameHwndStr: string | undefined, electronHwnds: string[], force: boolean = false): { isGameOrAppFocused: boolean } {
    if (!gameHwndStr || electronHwnds.length === 0 || !win32.SetWindowPos) return { isGameOrAppFocused: false };

    let isFocused = false;
    try {
        const gameHwnd = BigInt(gameHwndStr);
        const flags = win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE |
            win32.SWP_NOOWNERZORDER | win32.SWP_NOSENDCHANGING |
            win32.SWP_DEFERERASE | win32.SWP_NOCOPYBITS | win32.SWP_NOREDRAW;

        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        const isGameFocused = (fgHwnd === gameHwnd);
        const electronHwndBigInts = electronHwnds
            .map(h => {
                try {
                    return BigInt(h);
                } catch {
                    return 0n;
                }
            })
            .filter(h => h !== 0n);
        // 사이드바를 포함한 모든 앱 윈도우 중 하나라도 포커스를 가졌는지 체크
        const isOurAppFocused = electronHwndBigInts.includes(fgHwnd);

        isFocused = isGameFocused || isOurAppFocused;

        // 다른 일반 앱(크롬, 디스코드 등)이 포커스를 가진 상태라면 오버레이가 외부 앱 위로 튀어나오지 않도록 절대 Z-Order를 승격하지 않음
        if (!isFocused && !force) {
            return { isGameOrAppFocused: false };
        }

        // 항상 샌드위치 배치: 게임 창 바로 앞(Z+1)에 오버레이 배치
        const prevHwnd = parseHwnd(win32.GetWindow(gameHwnd, win32.GW_HWNDPREV));
        const lastElectronHwnd = electronHwndBigInts[electronHwndBigInts.length - 1];

        // 스택의 가장 바닥 창(gameOverlay 등)이 이미 게임 창 바로 앞(prevHwnd)에 정렬되어 있는지 확인
        const isAlreadySandwiched = (prevHwnd !== 0n && prevHwnd === lastElectronHwnd);

        if (force || !isAlreadySandwiched) {
            // 기준점 탐색: prevHwnd가 우리 창 중 하나라면 외부 앱 또는 HWND_TOP(0n)이 나올 때까지 상위로 거슬러 올라감
            let baseHwnd = prevHwnd;
            let depth = 0;
            const maxDepth = electronHwndBigInts.length + 5;
            while (baseHwnd !== 0n && electronHwndBigInts.includes(baseHwnd) && depth < maxDepth) {
                baseHwnd = parseHwnd(win32.GetWindow(baseHwnd, win32.GW_HWNDPREV));
                depth++;
            }

            let hwndInsertAfter: bigint = baseHwnd;
            // 게임이 Non-Topmost 최상위여서 바로 앞 일반 창이 없는 경우(baseHwnd === 0n),
            // HWND_TOP(0n)을 기준점으로 오버레이들을 게임 창 위로 순차 배치
            for (let i = 0; i < electronHwndBigInts.length; i++) {
                const hBigInt = electronHwndBigInts[i];
                win32.SetWindowPos(hBigInt, hwndInsertAfter, 0, 0, 0, 0, flags);
                hwndInsertAfter = hBigInt;
            }
        }

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] Promote failed: ${msg}`);
    }
    return { isGameOrAppFocused: isFocused };
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

/** 게임 창을 지정된 창 바로 아래 Z-Order에 배치 (포커스 변경 없음) */
export function placeGameBelowWindow(insertAfterHwndStr: string): void {
    if (!cachedHwnd || !isHwndValid(cachedHwnd)) return;
    try {
        let insertAfterHwnd: bigint;
        try {
            insertAfterHwnd = BigInt(insertAfterHwndStr);
        } catch {
            return;
        }

        // 대상 창의 EXSTYLE을 확인하여 Topmost인지 검사
        let isTargetTopmost = false;
        if (win32.GetWindowLongW) {
            const exStyle = win32.GetWindowLongW(insertAfterHwnd, win32.GWL_EXSTYLE);
            isTargetTopmost = (exStyle & win32.WS_EX_TOPMOST) !== 0;
        }

        const flags = win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE |
            win32.SWP_NOOWNERZORDER | win32.SWP_NOSENDCHANGING | win32.SWP_NOREDRAW;

        // 대상 창이 Topmost인 경우 게임 창이 Topmost로 강제 승격(전염)되지 않도록 HWND_NOTOPMOST 적용
        if (isTargetTopmost) {
            win32.SetWindowPos(cachedHwnd, win32.HWND_NOTOPMOST, 0, 0, 0, 0, flags);
        } else {
            win32.SetWindowPos(cachedHwnd, insertAfterHwnd, 0, 0, 0, 0, flags);
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] placeGameBelowWindow failed: ${msg}`);
    }
}

export function focusGameWindow(): void {
    if (!cachedHwnd || !isHwndValid(cachedHwnd)) return;
    try {
        // 이미 게임 창이 활성화 상태라면 아무것도 하지 않습니다 (깜박임 방지)
        const fgHwnd = parseHwnd(win32.GetForegroundWindow());
        if (fgHwnd === cachedHwnd) return;

        if (win32.ShowWindow) {
            win32.ShowWindow(cachedHwnd, win32.SW_RESTORE);
        }
        if (win32.BringWindowToTop) {
            win32.BringWindowToTop(cachedHwnd);
        }
        if (win32.SetForegroundWindow) {
            win32.SetForegroundWindow(cachedHwnd);
        }

        // 일반 포커스 실패 시에만 최후 수단으로 Alt 키 트릭 시도
        const newFgHwnd = parseHwnd(win32.GetForegroundWindow());
        if (newFgHwnd !== cachedHwnd && win32.keybd_event) {
            win32.keybd_event(win32.VK_MENU, 0, 0, 0);
            win32.keybd_event(win32.VK_MENU, 0, win32.KEYEVENTF_KEYUP, 0);
            if (win32.SetForegroundWindow) {
                win32.SetForegroundWindow(cachedHwnd);
            }
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRACKER] Focus failed: ${msg}`);
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
