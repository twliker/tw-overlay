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
 *
 * [변경 금지 Z-order 불변식]
 * 1. 게임 또는 TW-Overlay가 foreground일 때만 TW-Overlay HWND만 임시 Topmost로 올린다.
 * 2. 외부 HWND가 foreground이면 모니터·화면 겹침과 무관하게 모든 TW-Overlay를
 *    게임의 원래 band로 즉시 내리고 `게임 < TW-Overlay < 기존 외부 창`을 복원한다.
 * 3. 강등 전에 게임 위의 첫 보이는 외부 HWND를 anchor로 읽어 외부 창 순서를 보존한다.
 * 4. 게임·외부 HWND에는 절대 SetWindowPos/Topmost/NotTopmost 쓰기를 수행하지 않는다.
 * 5. 외부 앱에서 사용자가 TW-Overlay 작업표시줄 창을 명시적으로 선택할 때만,
 *    이 관리자 밖의 전용 경로가 최소화되지 않은 게임을 SetForegroundWindow로 한 번
 *    올린 뒤 선택한 우리 창에 포커스를 돌린다. 자동 폴링에는 이 예외를 적용하지 않는다.
 *
 * 이 정책은 창모드·창모드 전체화면 및 다중 모니터 실게임에서 확정됐다.
 * 새 증상에 대응한다는 이유로 모니터별/창 rect별 Topmost 예외를 다시 추가하지 말고,
 * 반드시 두 모드의 자동 회귀와 실기 검증을 거쳐 이 불변식 안에서 수정한다.
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
        const gameRect = this.native.getWindowRect(input.gameHwnd);
        const foregroundRect = foregroundHwnd === 0n
            ? null
            : this.native.getWindowRect(foregroundHwnd);
        const targetState = resolveZOrderPolicyState({
            gameHwnd: input.gameHwnd,
            overlayHwnds,
            foregroundHwnd,
            gameRect,
            foregroundRect,
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

        // 비활성 Electron 창은 일반 HWND_TOP 배치만으로 foreground 게임 위에 남지 못한다.
        // 따라서 게임·TW-Overlay가 전경인 동안에만 우리 창을 임시 Topmost로 올리고,
        // 외부 프로그램이 전경을 얻으면 모니터 위치와 무관하게 즉시 게임 계층으로 내린다.
        // 외부 상태의 실제 순서는 `게임 < TW-Overlay < 기존 외부 창`이 된다.
        // 어떤 상태에서도 테일즈위버 HWND에는 SetWindowPos를 호출하지 않는다.
        // Topmost 계층을 내리기 전에 현재 외부 창 순서를 읽어 둬야 band 변경으로 anchor가
        // 사라져 우리 창이 외부 프로그램 앞으로 튀는 전환 회귀를 막을 수 있다.
        const placementAnchor = this.findOverlayPlacementAnchor(
            gameHwnd,
            groupHwnds,
            foregroundHwnd,
            desiredTopmost,
            isGameOrAppFocused,
        );
        let bandChangeSucceeded = true;
        const bandAnchor = desiredTopmost ? this.native.topmost : this.native.notTopmost;
        for (const hwnd of groupHwnds) {
            if (this.native.isTopmost(hwnd) === desiredTopmost) continue;
            bandChangeSucceeded = this.native.setWindowAfter(hwnd, bandAnchor)
                && bandChangeSucceeded;
        }

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
        allOverlayHwnds: bigint[],
        foregroundHwnd: bigint,
        desiredTopmost: boolean,
        isGameOrAppFocused: boolean,
    ): bigint {
        const overlaySet = new Set(allOverlayHwnds);

        // 사용자가 게임이나 TW-Overlay를 직접 선택한 경우에는 같은 계층의 맨 위에서
        // 내부 순서를 복원한다. SWP_NOACTIVATE이므로 foreground 소유권은 바꾸지 않는다.
        if (isGameOrAppFocused || foregroundHwnd === gameHwnd || overlaySet.has(foregroundHwnd)) {
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

    private isWindowAbove(candidateHwnd: bigint, referenceHwnd: bigint): boolean {
        let current = this.native.getWindowAbove(referenceHwnd);
        for (let depth = 0; current !== 0n && depth < 256; depth++) {
            if (current === candidateHwnd) return true;
            current = this.native.getWindowAbove(current);
        }
        return false;
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
