import { log } from './logger';
import * as win32 from './win32';
import koffi from 'koffi';

export type ZOrderPolicyState =
    | 'inactive'
    | 'game-active'
    | 'overlay-active'
    | 'external-other-monitor'
    | 'external-game-monitor';

export interface WindowRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface ZOrderNativeAdapter {
    readonly top: bigint;
    readonly topmost: bigint;
    readonly notTopmost: bigint;
    getForegroundWindow(): bigint;
    getWindowRect(hwnd: bigint): WindowRect | null;
    getWindowAbove(hwnd: bigint): bigint;
    isTopmost(hwnd: bigint): boolean;
    isTaskbarWindow(hwnd: bigint): boolean;
    setWindowAfter(hwnd: bigint, insertAfter: bigint): boolean;
}

export interface ZOrderReconcileInput {
    gameHwnd: bigint;
    overlayHwnds: bigint[];
}

export interface ZOrderReconcileResult {
    isGameOrAppFocused: boolean;
    state: ZOrderPolicyState;
}

export interface ZOrderPolicyInput {
    gameHwnd: bigint;
    overlayHwnds: bigint[];
    foregroundHwnd: bigint;
    gameRect: WindowRect | null;
    foregroundRect: WindowRect | null;
}

function rectsOverlap(first: WindowRect, second: WindowRect): boolean {
    return first.left < second.right
        && first.right > second.left
        && first.top < second.bottom
        && first.bottom > second.top;
}

function nativeHwnd(value: unknown): bigint {
    if (!value) return 0n;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'object') {
        try {
            return koffi.address(value);
        } catch {
            // 문자열 변환 경로로 계속 진행한다.
        }
    }
    try {
        return BigInt(String(value).trim());
    } catch {
        return 0n;
    }
}

/** Win32 쓰기 없이 현재 창 관계를 제품 정책 상태 하나로 분류한다. */
export function resolveZOrderPolicyState(input: ZOrderPolicyInput): ZOrderPolicyState {
    if (input.foregroundHwnd === input.gameHwnd) return 'game-active';
    if (input.overlayHwnds.includes(input.foregroundHwnd)) return 'overlay-active';

    // 좌표를 읽지 못한 시스템 창과 foreground 공백은 같은 모니터로 보수 처리해
    // 외부 UI를 Topmost 게임이 가리지 않게 한다.
    if (input.foregroundHwnd === 0n || !input.gameRect || !input.foregroundRect) {
        return 'external-game-monitor';
    }
    return rectsOverlap(input.foregroundRect, input.gameRect)
        ? 'external-game-monitor'
        : 'external-other-monitor';
}

function isPromotedState(state: ZOrderPolicyState): boolean {
    return state === 'game-active'
        || state === 'overlay-active'
        || state === 'external-other-monitor';
}

/**
 * 게임과 TW-Overlay 창 묶음의 Win32 z-order를 소유하는 단일 상태 관리자.
 * 호출자는 포커스·위치·폴링 사건마다 현재 HWND만 전달하며 정책을 직접 결정하지 않는다.
 */
export class GameOverlayZOrderController {
    private state: ZOrderPolicyState = 'inactive';
    private lastTopology = '';
    private lastForegroundHwnd = 0n;
    private lastGroupHwnds: bigint[] = [];

    constructor(
        private readonly native: ZOrderNativeAdapter,
        private readonly writeLog: (message: string) => void = log,
    ) {}

    getState(): ZOrderPolicyState {
        return this.state;
    }

    reconcile(input: ZOrderReconcileInput): ZOrderReconcileResult {
        const overlayHwnds = input.overlayHwnds.filter(hwnd => hwnd !== 0n);
        if (input.gameHwnd === 0n || overlayHwnds.length === 0) {
            return { isGameOrAppFocused: false, state: this.state };
        }

        const foregroundHwnd = this.native.getForegroundWindow();
        const targetState = resolveZOrderPolicyState({
            gameHwnd: input.gameHwnd,
            overlayHwnds,
            foregroundHwnd,
            gameRect: this.native.getWindowRect(input.gameHwnd),
            foregroundRect: foregroundHwnd === 0n ? null : this.native.getWindowRect(foregroundHwnd),
        });
        const isGameOrAppFocused = targetState === 'game-active' || targetState === 'overlay-active';
        const groupHwnds = [...overlayHwnds, input.gameHwnd];
        const topology = groupHwnds.join(',');

        try {
            if (targetState === 'external-game-monitor') {
                this.reconcileDemotedGroup(groupHwnds, foregroundHwnd, topology, targetState);
            } else {
                this.reconcilePromotedGroup(groupHwnds, input.gameHwnd, foregroundHwnd, targetState);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeLog(`[Z_ORDER] Reconcile failed state=${targetState}: ${message}`);
        } finally {
            this.state = targetState;
            this.lastTopology = topology;
            this.lastForegroundHwnd = foregroundHwnd;
            this.lastGroupHwnds = groupHwnds;
        }

        return { isGameOrAppFocused, state: targetState };
    }

    release(gameHwnd: bigint = 0n): void {
        const groupHwnds = [...new Set([
            ...this.lastGroupHwnds,
            ...(gameHwnd === 0n ? [] : [gameHwnd]),
        ])];
        try {
            for (const hwnd of groupHwnds) {
                if (this.native.isTopmost(hwnd)) {
                    this.native.setWindowAfter(hwnd, this.native.notTopmost);
                }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeLog(`[Z_ORDER] Release failed: ${message}`);
        } finally {
            this.state = 'inactive';
            this.lastTopology = '';
            this.lastForegroundHwnd = 0n;
            this.lastGroupHwnds = [];
        }
    }

    private reconcileDemotedGroup(
        groupHwnds: bigint[],
        foregroundHwnd: bigint,
        topology: string,
        targetState: ZOrderPolicyState,
    ): void {
        const hasTopmostWindow = groupHwnds.some(hwnd => this.native.isTopmost(hwnd));
        const contextChanged = this.state !== targetState
            || this.lastTopology !== topology
            || this.lastForegroundHwnd !== foregroundHwnd;
        if (!hasTopmostWindow && !contextChanged) return;

        let demotionSucceeded = true;
        for (const hwnd of groupHwnds) {
            demotionSucceeded = this.native.setWindowAfter(hwnd, this.native.notTopmost)
                && demotionSucceeded;
        }

        // 시작 메뉴·작업표시줄처럼 foreground 자체가 Topmost이면 해당 HWND 뒤에
        // 삽입하지 않는다. 일반 창 영역의 맨 위를 기준으로 내부 순서만 복원한다.
        const externalIsTopmost = this.native.isTopmost(foregroundHwnd);
        const placementAnchor = externalIsTopmost ? this.native.top : foregroundHwnd;
        const placementSucceeded = this.placeWindowStack(placementAnchor, groupHwnds);
        const stillTopmost = groupHwnds.some(hwnd => this.native.isTopmost(hwnd));
        this.writeLog(`[Z_ORDER] Transition ${this.state}->${targetState} ${demotionSucceeded && placementSucceeded && !stillTopmost ? 'succeeded' : 'failed'} foreground=${foregroundHwnd} externalTopmost=${externalIsTopmost}`);
    }

    private reconcilePromotedGroup(
        groupHwnds: bigint[],
        gameHwnd: bigint,
        foregroundHwnd: bigint,
        targetState: ZOrderPolicyState,
    ): void {
        const isAlreadySandwiched = this.isWindowStackIntact(groupHwnds, gameHwnd);
        const allWindowsTopmost = groupHwnds.every(hwnd => this.native.isTopmost(hwnd));
        const taskbarAboveGroup = this.isTaskbarAboveWindow(groupHwnds[0], gameHwnd);
        if (isAlreadySandwiched && allWindowsTopmost && !taskbarAboveGroup) return;

        const placementSucceeded = this.placeWindowStack(this.native.topmost, groupHwnds);
        const topmostAfter = groupHwnds.every(hwnd => this.native.isTopmost(hwnd));
        this.writeLog(`[Z_ORDER] Transition ${this.state}->${targetState} ${placementSucceeded && topmostAfter ? 'succeeded' : 'failed'} foreground=${foregroundHwnd} taskbarWasAbove=${taskbarAboveGroup}`);
    }

    private placeWindowStack(insertAfter: bigint, hwnds: bigint[]): boolean {
        let currentInsertAfter = insertAfter;
        let succeeded = true;
        for (const hwnd of hwnds) {
            succeeded = this.native.setWindowAfter(hwnd, currentInsertAfter) && succeeded;
            currentInsertAfter = hwnd;
        }
        return succeeded;
    }

    private isWindowStackIntact(groupHwnds: bigint[], gameHwnd: bigint): boolean {
        const overlayHwnds = groupHwnds.slice(0, -1);
        if (overlayHwnds.length === 0) return false;
        if (this.native.getWindowAbove(gameHwnd) !== overlayHwnds[overlayHwnds.length - 1]) return false;
        for (let i = overlayHwnds.length - 1; i > 0; i--) {
            if (this.native.getWindowAbove(overlayHwnds[i]) !== overlayHwnds[i - 1]) return false;
        }
        return true;
    }

    private isTaskbarAboveWindow(hwnd: bigint, gameHwnd: bigint): boolean {
        const gameRect = this.native.getWindowRect(gameHwnd);
        if (!gameRect) return false;
        let current = this.native.getWindowAbove(hwnd);
        for (let depth = 0; current !== 0n && depth < 128; depth++) {
            const currentRect = this.native.getWindowRect(current);
            if (this.native.isTaskbarWindow(current)
                && currentRect
                && rectsOverlap(currentRect, gameRect)) {
                return true;
            }
            current = this.native.getWindowAbove(current);
        }
        return false;
    }
}

const classNameBuffer = Buffer.alloc(256 * 2);
const setWindowFlags = win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE
    | win32.SWP_NOOWNERZORDER | win32.SWP_NOSENDCHANGING
    | win32.SWP_DEFERERASE | win32.SWP_NOCOPYBITS | win32.SWP_NOREDRAW;

const nativeAdapter: ZOrderNativeAdapter = {
    top: win32.HWND_TOP,
    topmost: win32.HWND_TOPMOST,
    notTopmost: win32.HWND_NOTOPMOST,
    getForegroundWindow: () => nativeHwnd(win32.GetForegroundWindow()),
    getWindowRect: (hwnd) => {
        const rect = { left: 0, top: 0, right: 0, bottom: 0 };
        return win32.GetWindowRect(hwnd, rect) ? rect : null;
    },
    getWindowAbove: (hwnd) => nativeHwnd(win32.GetWindow(hwnd, win32.GW_HWNDPREV)),
    isTopmost: (hwnd) => hwnd !== 0n
        && (win32.GetWindowLongW(hwnd, win32.GWL_EXSTYLE) & win32.WS_EX_TOPMOST) !== 0,
    isTaskbarWindow: (hwnd) => {
        if (hwnd === 0n) return false;
        classNameBuffer.fill(0);
        const length = win32.GetClassNameW(hwnd, classNameBuffer, 256);
        if (length <= 0) return false;
        const className = classNameBuffer.toString('utf16le', 0, length * 2);
        return className === 'Shell_TrayWnd' || className === 'Shell_SecondaryTrayWnd';
    },
    setWindowAfter: (hwnd, insertAfter) => !!win32.SetWindowPos(
        hwnd,
        insertAfter,
        0,
        0,
        0,
        0,
        setWindowFlags,
    ),
};

export const gameOverlayZOrderController = new GameOverlayZOrderController(nativeAdapter);
