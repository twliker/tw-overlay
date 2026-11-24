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
import { observeProfileGameState } from './profileRuntime';

let pollingTimer: NodeJS.Timeout | null = null;
let gameWasEverFound = false;

export function isNewDisplayedGameSession(wasFound:boolean,previousPid?:number,currentPid?:number):boolean {
    return !wasFound || currentPid!==undefined && previousPid!==undefined && currentPid!==previousPid;
}
const TRANSIENT_STATE_CONFIRM_SAMPLES = 2;

export type GameStatus = 'running' | 'minimized' | 'not-running' | null;
let _currentStatus: GameStatus = null;

export function getGameStatus(): GameStatus {
    return _currentStatus;
}

export function start(): void {
    let lastRect: GameQueryResult = null;
    let stableCount = 0;
    let consecutiveNotRunning = 0;
    let consecutiveMinimized = 0;
    let lastDisplayedProcessId:number | undefined;
    let exitRevision=0;
    const updateProfile=(state:Exclude<GameStatus,null>,processId?:number):void | Promise<void>=>{
        const onError=(error:unknown)=>log(`[PROFILE] 게임 상태 저장 실패 (${state}): ${String(error)}`);
        try {return observeProfileGameState(state,processId)?.catch(onError);}
        catch (error) {onError(error);}
    };
    // lastStatus 대신 _currentStatus 사용
    _currentStatus = null;

    const rectEquals = (a: GameQueryResult, b: GameQueryResult): boolean => {
        if (!a || !b) return a === b;
        if ('x' in a && 'x' in b) {
            return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
                && a.windowStyle === b.windowStyle && a.gameHwnd === b.gameHwnd && a.isForeground === b.isForeground;
        }
        return false;
    };

    // 윈도우 이벤트(이동, 활성화 등) 발생 시 즉시 폴링 함수 실행
    let isProcessingEvent = false;
    let pollRunning=false;
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

    /** 폴링 루프 생존 계약: 한 번의 확인에서 창 동기화·Z-order·세션 시작 처리 등이 예외를 던져도
     * 루프를 끝내지 않는다. 오류는 기록하고, 다음 예약이 없으면 안정 주기(POLLING_STABLE_MS)로 다시
     * 예약해 반복 오류가 빠른 주기로 폭주하지 않게 한다. 예약이 끊기면 창 이벤트 리스너도
     * pollingTimer가 없어 깨우지 못하므로 게임 추적이 앱 재시작 전까지 멈춘다.
     * 회귀: check-audit-regressions.ts(checkPollingLoopRecovery). */
    async function poll(): Promise<void> {
        if (appState.isQuitting || pollRunning) return;
        pollRunning=true;pollingTimer=null;
        try {await pollGame();}
        catch (error) {
            log(`[POLL] 게임 상태 확인 실패, 다음 주기에 다시 확인합니다: ${error instanceof Error ? error.stack || error.message : String(error)}`);
            if (!appState.isQuitting && !pollingTimer) pollingTimer = setTimeout(poll, POLLING_STABLE_MS);
        }
        finally {pollRunning=false;}
    }
    const showExitReminder=():void=>{
        try {wm.showGameExitReminder();}
        catch (error) {log(`[POLL] 게임 종료 안내 표시 실패: ${String(error)}`);}
    };

    async function pollGame():Promise<void> {
        const currentRect = await tracker.queryGameRect();
        let nextDelay = POLLING_FAST_MS;

        if (currentRect === undefined || (currentRect !== null && 'error' in currentRect)) {
            pollingTimer = setTimeout(poll, POLLING_FAST_MS);
            return;
        }

        // 1. 게임 미실행 상태
        if (currentRect && 'notRunning' in currentRect) {
            // 최소화로 시작해도 세션은 실제로 열렸다. 창 표시 이력은 배치에만 사용한다.
            const hadGameSession=gameWasEverFound || _currentStatus==='minimized';
            consecutiveNotRunning++;
            consecutiveMinimized = 0;
            if (hadGameSession && consecutiveNotRunning < TRANSIENT_STATE_CONFIRM_SAMPLES) {
                log(`[POLL] 게임 미실행 판정 재확인 대기 (${consecutiveNotRunning}/${TRANSIENT_STATE_CONFIRM_SAMPLES})`);
                pollingTimer = setTimeout(poll, POLLING_FAST_MS);
                return;
            }
            lastDisplayedProcessId=undefined;
            const completingSession=updateProfile('not-running');
            if (_currentStatus !== 'not-running') {
                log('[OVERLAY_VISIBILITY] game=not-running action=hide reason=game-window-not-detected');
                tracker.releaseGameZOrder();
                wm.resetGameSessionState();
                if (hadGameSession) {
                    gameWasEverFound = false;
                    wm.hideAll(); // 종료 리마인더를 위해 한 번만 hideAll
                    const revision=++exitRevision;
                    // 안내 표시 실패가 종료 처리(_currentStatus 갱신)를 막아 매 주기 hideAll을 반복하지 않게 격리한다.
                    if (completingSession) {
                        void completingSession.then(()=>{
                            if (!appState.isQuitting && _currentStatus==='not-running' && revision===exitRevision) showExitReminder();
                        }).catch(error=>log(`[POLL] 게임 종료 안내 예약 실패: ${String(error)}`));
                    } else showExitReminder();
                } else {
                    wm.hideOverlayWindows();
                }
                _currentStatus = 'not-running';
                lastRect = null;
            }
            stableCount = 0;
            pollingTimer = setTimeout(poll, POLLING_IDLE_MS);
            return;
        }

        const processId=tracker.getDetectedGameProcessId?.();

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
                log('[OVERLAY_VISIBILITY] game=minimized action=hide reason=game-window-minimized');
                tracker.releaseGameZOrder();
                // 자주 사용하는 오버레이는 숨겨 둔 채 renderer를 재사용해 복원 지연을 줄입니다.
                wm.hideAll({ preserveForResume: true });
                _currentStatus = 'minimized';
                lastRect = null;
            }
            // 최소화/숨김 시작은 선택 전 기록 세션만 준비한다. 자동 선택창은 보이는 상태까지 보류한다.
            void updateProfile('minimized',processId);
            stableCount = 0;
            pollingTimer = setTimeout(poll, POLLING_MINIMIZED_MS);
            return;
        }

        // 3. 게임 실행 중 (보이는 상태)
        consecutiveNotRunning = 0;
        consecutiveMinimized = 0;
        const isNewGameSession=isNewDisplayedGameSession(gameWasEverFound,lastDisplayedProcessId,processId);
        if (processId!==undefined) lastDisplayedProcessId=processId;
        void updateProfile('running',processId);
        gameWasEverFound = true;

        // 창모드 전환 안정화 시간 동안에는 rect가 더 이상 바뀌지 않아도 한 번 더 동기화해야
        // 새 모드를 확정하고 그 모드 전용 위치를 복원할 수 있습니다.
        const isStateChanged = isNewGameSession || _currentStatus !== 'running'
            || !rectEquals(currentRect, lastRect)
            || wm.isGameWindowModeTransitioning();

        if (isStateChanged) {
            const gameJustStarted = _currentStatus !== 'running';
            if (gameJustStarted) {
                const visibility = config.loadFields([
                    'sidebarPosition',
                    'chatOverlayEnabled',
                    'chatOverlaySubEnabled',
                    'chatOverlaySub2Enabled',
                ] as const);
                log(`[OVERLAY_VISIBILITY] game=running action=restore sidebar=${visibility.sidebarPosition || 'right'} chat=${!!visibility.chatOverlayEnabled} sub1=${!!visibility.chatOverlaySubEnabled} sub2=${!!visibility.chatOverlaySub2Enabled}`);
            }
            if (isNewGameSession) {
                const { abandonedTracker } = await import('./abandonedTracker');
                const { digsiteTracker } = await import('./digsiteTracker');
                abandonedTracker.beginGameSession();
                digsiteTracker.beginGameSession();
            }
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
    void poll();
}

export function stop(): void {
    if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
    }
}
