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
    isVisible(hwnd: bigint): boolean;
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

/**
 * 테일즈위버의 자연스러운 Win32 z-order는 읽기만 하고, TW-Overlay 창 묶음만
 * 기존 내부 순서대로 게임 바로 위에 배치하는 단일 상태 관리자.
 */
export class GameOverlayZOrderController {
    private state: ZOrderPolicyState = 'inactive';
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
        const groupHwnds = overlayHwnds;

        try {
            this.reconcileOverlayGroup(groupHwnds, input.gameHwnd, foregroundHwnd, targetState);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeLog(`[Z_ORDER] Reconcile failed state=${targetState}: ${message}`);
        } finally {
            this.state = targetState;
            this.lastGroupHwnds = groupHwnds;
        }

        return { isGameOrAppFocused, state: targetState };
    }

    release(): void {
        const groupHwnds = [...new Set(this.lastGroupHwnds)];
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
            this.lastGroupHwnds = [];
        }
    }

    private reconcileOverlayGroup(
        groupHwnds: bigint[],
        gameHwnd: bigint,
        foregroundHwnd: bigint,
        targetState: ZOrderPolicyState,
    ): void {
        const gameIsTopmost = this.native.isTopmost(gameHwnd);
        const isGameOrAppFocused = targetState === 'game-active' || targetState === 'overlay-active';
        const desiredTopmost = isGameOrAppFocused || gameIsTopmost;
        const allWindowsMatchDesiredBand = groupHwnds.every(
            hwnd => this.native.isTopmost(hwnd) === desiredTopmost,
        );
        const isWindowStackIntact = this.isWindowStackIntact(
            groupHwnds,
            gameHwnd,
            isGameOrAppFocused,
        );
        if (allWindowsMatchDesiredBand && isWindowStackIntact) return;

        // 게임·TW-Overlay가 전경이면 우리 창만 Topmost로 올려 비활성 Electron 창도 게임 위에
        // 보이게 한다. 외부 프로그램이 전경을 얻는 즉시 게임의 원래 계층으로 복귀한다.
        // 어떤 상태에서도 테일즈위버 HWND에는 SetWindowPos를 호출하지 않는다.
        let bandChangeSucceeded = true;
        const bandAnchor = desiredTopmost ? this.native.topmost : this.native.notTopmost;
        for (const hwnd of groupHwnds) {
            if (this.native.isTopmost(hwnd) === desiredTopmost) continue;
            bandChangeSucceeded = this.native.setWindowAfter(hwnd, bandAnchor)
                && bandChangeSucceeded;
        }

        const placementAnchor = this.findOverlayPlacementAnchor(
            gameHwnd,
            groupHwnds,
            foregroundHwnd,
            desiredTopmost,
        );
        const placementSucceeded = this.placeWindowStack(placementAnchor, groupHwnds);
        const allWindowsMatchDesiredBandAfter = groupHwnds.every(
            hwnd => this.native.isTopmost(hwnd) === desiredTopmost,
        );
        const stackIntactAfter = this.isWindowStackIntact(
            groupHwnds,
            gameHwnd,
            isGameOrAppFocused,
        );
        this.writeLog(`[Z_ORDER] Overlay-only ${this.state}->${targetState} ${bandChangeSucceeded && placementSucceeded && allWindowsMatchDesiredBandAfter && stackIntactAfter ? 'succeeded' : 'failed'} foreground=${foregroundHwnd} anchor=${placementAnchor} game=${gameHwnd} gameTopmost=${gameIsTopmost} overlayTopmost=${desiredTopmost}`);
    }

    private findOverlayPlacementAnchor(
        gameHwnd: bigint,
        groupHwnds: bigint[],
        foregroundHwnd: bigint,
        desiredTopmost: boolean,
    ): bigint {
        const overlaySet = new Set(groupHwnds);

        // 사용자가 게임이나 TW-Overlay를 직접 선택한 경우에는 우리 내부 순서를 Topmost 영역
        // 맨 위에서 복원한다. SWP_NOACTIVATE이므로 foreground 소유권은 바꾸지 않는다.
        if (foregroundHwnd === gameHwnd || overlaySet.has(foregroundHwnd)) {
            return desiredTopmost ? this.native.topmost : this.native.top;
        }

        // 외부 프로그램 사용 중에는 게임보다 위에 있던 모든 외부 창을 그대로 둔다.
        // 게임 바로 위를 위에서부터 찾지 않고 게임에서 위로 올라가며 찾는 이유는,
        // foreground 하나만 anchor로 삼아 게임을 두 번째로 끌어올리던 회귀를 막기 위함이다.
        let current = this.native.getWindowAbove(gameHwnd);
        for (let depth = 0; current !== 0n && depth < 256; depth++) {
            if (!this.native.isVisible(current)) {
                current = this.native.getWindowAbove(current);
                continue;
            }
            if (!overlaySet.has(current)) {
                // 시작 메뉴·작업표시줄 같은 Topmost 창 뒤에 삽입하면 우리 창에도 Topmost가
                // 전염될 수 있다. 게임이 일반 창일 때만 일반 창 영역의 맨 위를 사용한다.
                // 게임 자체가 Topmost라면 같은 계층의 외부 창 아래, 게임 위에 그대로 둔다.
                return !desiredTopmost && this.native.isTopmost(current)
                    ? this.native.top
                    : current;
            }
            current = this.native.getWindowAbove(current);
        }
        return desiredTopmost ? this.native.topmost : this.native.top;
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

    private getVisibleWindowAbove(hwnd: bigint): bigint {
        let current = this.native.getWindowAbove(hwnd);
        for (let depth = 0; current !== 0n && depth < 256; depth++) {
            if (!this.native.isVisible(current)) {
                current = this.native.getWindowAbove(current);
                continue;
            }
            return current;
        }
        return 0n;
    }

    private isWindowAbove(candidateHwnd: bigint, referenceHwnd: bigint): boolean {
        let current = this.native.getWindowAbove(referenceHwnd);
        for (let depth = 0; current !== 0n && depth < 256; depth++) {
            if (current === candidateHwnd) return true;
            current = this.native.getWindowAbove(current);
        }
        return false;
    }

    private isWindowStackIntact(
        groupHwnds: bigint[],
        gameHwnd: bigint,
        isGameOrAppFocused: boolean,
    ): boolean {
        const overlayHwnds = groupHwnds;
        if (overlayHwnds.length === 0) return false;
        for (let i = overlayHwnds.length - 1; i > 0; i--) {
            if (this.getVisibleWindowAbove(overlayHwnds[i]) !== overlayHwnds[i - 1]) return false;
        }
        const lowestOverlayHwnd = overlayHwnds[overlayHwnds.length - 1];
        return isGameOrAppFocused
            ? this.isWindowAbove(lowestOverlayHwnd, gameHwnd)
            : this.getVisibleWindowAbove(gameHwnd) === lowestOverlayHwnd;
    }

}

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
    isVisible: (hwnd) => hwnd !== 0n && !!win32.IsWindowVisible(hwnd),
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
