/**
 * 게임 창 추적 폴링 루프
 * main.ts에서 분리된 모듈 — 게임 창 위치/상태를 주기적으로 확인하고 오버레이를 동기화합니다.
 */
import {
    POLLING_FAST_MS,
    POLLING_STABLE_MS,
    POLLING_MINIMIZED_MS,
    POLLING_IDLE_MS,
    STABLE_THRESHOLD_COUNT,
    WINDOW_MINIMIZED_THRESHOLD,
    EVENT_DEBOUNCE_MS,
    IS_DEV,
    GameRect,
    GameQueryResult,
    appState
} from './constants';
import { log } from './logger';
import * as tracker from './tracker';
import * as wm from './windowManager';
import * as config from './config';

let pollingTimer: NodeJS.Timeout | null = null;
let gameWasEverFound = false;
const TRANSIENT_STATE_CONFIRM_SAMPLES = 2;

export type GameStatus = 'running' | 'minimized' | 'not-running' | null;
let _currentStatus: GameStatus = null;

export function getGameStatus(): GameStatus {
    return _currentStatus;
}

export function start(): void {
    let lastRect: GameQueryResult = null;
    let stableCount = 0;
    let isBoosted = false;
    let consecutiveNotRunning = 0;
    let consecutiveMinimized = 0;
    // lastStatus 대신 _currentStatus 사용
    _currentStatus = null;

    const rectEquals = (a: GameQueryResult, b: GameQueryResult): boolean => {
        if (!a || !b) return a === b;
        if ('x' in a && 'x' in b) {
            return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.isForeground === b.isForeground;
        }
        return false;
    };

    // 윈도우 이벤트(이동, 활성화 등) 발생 시 즉시 폴링 함수 실행
    let isProcessingEvent = false;
    tracker.setWindowEventListener(() => {
        if (isProcessingEvent) return;

        if (pollingTimer) {
            clearTimeout(pollingTimer);
            isProcessingEvent = true;
            setTimeout(() => {
                isProcessingEvent = false;
                poll();
            }, EVENT_DEBOUNCE_MS);
        }
    });

    async function poll(): Promise<void> {
        if (appState.isQuitting) return;

        const currentRect = await tracker.queryGameRect();
        let nextDelay = POLLING_FAST_MS;

        if (currentRect === undefined || (currentRect !== null && 'error' in currentRect)) {
            pollingTimer = setTimeout(poll, POLLING_FAST_MS);
            return;
        }

        // 1. 게임 미실행 상태
        if (currentRect && 'notRunning' in currentRect) {
            consecutiveNotRunning++;
            consecutiveMinimized = 0;
            if (gameWasEverFound && consecutiveNotRunning < TRANSIENT_STATE_CONFIRM_SAMPLES) {
                log(`[POLL] 게임 미실행 판정 재확인 대기 (${consecutiveNotRunning}/${TRANSIENT_STATE_CONFIRM_SAMPLES})`);
                pollingTimer = setTimeout(poll, POLLING_FAST_MS);
                return;
            }
            if (_currentStatus !== 'not-running') {
                tracker.releaseGameZOrder();
                wm.resetGameSessionState();
                if (gameWasEverFound) {
                    gameWasEverFound = false;
                    wm.hideAll(); // 종료 리마인더를 위해 한 번만 hideAll
                    wm.showGameExitReminder();
                } else {
                    wm.hideOverlayWindows();
                }
                _currentStatus = 'not-running';
                lastRect = null;
            }
            stableCount = 0;
            isBoosted = false;
            pollingTimer = setTimeout(poll, POLLING_IDLE_MS);
            return;
        }

        // 2. 게임 최소화/숨김 상태
        if (!currentRect || (currentRect && 'x' in currentRect && currentRect.x <= WINDOW_MINIMIZED_THRESHOLD)) {
            consecutiveMinimized++;
            consecutiveNotRunning = 0;
            if (_currentStatus === 'running' && consecutiveMinimized < TRANSIENT_STATE_CONFIRM_SAMPLES) {
                log(`[POLL] 게임 최소화 판정 재확인 대기 (${consecutiveMinimized}/${TRANSIENT_STATE_CONFIRM_SAMPLES})`);
                pollingTimer = setTimeout(poll, POLLING_FAST_MS);
                return;
            }
            if (_currentStatus !== 'minimized') {
                tracker.releaseGameZOrder();
                wm.hideAll(); // 최소화되는 순간 모든 창 종료 (운명 공동체)
                _currentStatus = 'minimized';
                lastRect = null;
            }
            stableCount = 0;
            pollingTimer = setTimeout(poll, POLLING_MINIMIZED_MS);
            return;
        }

        // 3. 게임 실행 중 (보이는 상태)
        consecutiveNotRunning = 0;
        consecutiveMinimized = 0;
        gameWasEverFound = true;
        if (!isBoosted) {
            tracker.boostGameProcess().then(res => {
                if (res === 'BOOSTED' || res === 'ALREADY_HIGH') {
                    log(`[POLL] Game process priority elevated: ${res}`);
                    isBoosted = true;
                }
            }).catch(e => log(`[POLL] boostGameProcess failed: ${e}`));
        }

        const isStateChanged = _currentStatus !== 'running' || !rectEquals(currentRect, lastRect);

        if (isStateChanged) {
            const gameJustStarted = _currentStatus !== 'running';
            wm.syncOverlay(currentRect as GameRect);
            lastRect = currentRect;
            _currentStatus = 'running';
            stableCount = 0;
            nextDelay = POLLING_FAST_MS;
            if (gameJustStarted) {
                void import('./cloudSyncManager').then(cloudSync => {
                    cloudSync.requestImmediatePull('game-started');
                }).catch(error => log(`[POLL] 게임 시작 클라우드 확인 예약 실패: ${error}`));
            }

        } else {
            stableCount++;
            nextDelay = (stableCount >= STABLE_THRESHOLD_COUNT) ? POLLING_STABLE_MS : POLLING_FAST_MS;
        }

        // 상태 변화가 없어도 Shell 작업표시줄이 Topmost 묶음 위로 다시 올라올 수 있다.
        // 상태 관리자 내부에서 순서가 정상일 때는 Win32 쓰기를 하지 않으므로,
        // 폴링마다 가볍게 검사해 무조작 재현도 자동 복구한다.
        if (currentRect && 'gameHwnd' in currentRect && !wm.isAnyUserDragging()) {
            const windowHwnds = wm.getAllWindowHwnds();
            tracker.reconcileGameZOrder(currentRect.gameHwnd, windowHwnds);
        }

        pollingTimer = setTimeout(poll, nextDelay);
    }
    poll();
}

export function stop(): void {
    if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
    }
}
