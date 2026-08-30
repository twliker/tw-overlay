/**
 * 기능 계약 — 발굴지 한 판 현황판
 *
 * - 기존 `DIGSITE_ENTRY` 로그를 세션 시작 신호로 사용하고 일반 지역 8개, 포탈 보상 4개,
 *   포탈 1~4 방문 여부, 이공간 1개를 각각 독립적으로 집계합니다.
 * - 발굴지에는 명시적인 종료 채팅이 없으므로 통상 3분 이내에 끝나는 한 판에 여유를 더해
 *   입장 시각부터 5분 동안만 HUD를 표시합니다.
 *   상자나 포탈 로그가 들어와도 만료 시각은 연장하지 않아 지난 세션 현황이 남지 않게 합니다.
 * - 보상 로그가 중복으로 들어오더라도 각 콘텐츠 최대치에서 멈추며, 입장 전에 들어온 로그나
 *   만료 뒤 로그는 다음 세션에 섞이지 않도록 무시합니다.
 * - 과거 채팅 로그 강제 동기화는 별도의 ChatParser 인스턴스를 사용하므로 이 실시간 추적기를
 *   활성화하지 않습니다. 게임 프로세스가 새로 시작되면 남아 있던 상태도 즉시 초기화합니다.
 */
import { chatParser } from './chatParser';
import { log } from './logger';
import { broadcastToAllWindows } from './windowMessaging';
import type { DigsiteBoardState } from '../shared/types';

export const DIGSITE_BOARD_VISIBLE_MS = 5 * 60 * 1_000;
export const DIGSITE_NORMAL_REWARD_MAX = 8;
export const DIGSITE_PORTAL_REWARD_MAX = 4;
export const DIGSITE_ALTERNATE_REWARD_MAX = 1;

export type DigsiteBoardEvent =
  | { type: 'entry' }
  | { type: 'normal-reward' }
  | { type: 'portal-visit'; portal: 1 | 2 | 3 | 4 }
  | { type: 'portal-reward' }
  | { type: 'alternate-reward' }
  | { type: 'expire' };

export function createDigsiteBoardState(): DigsiteBoardState {
  return {
    isActive: false,
    normalRewards: 0,
    portalRewards: 0,
    portalVisits: { 1: false, 2: false, 3: false, 4: false },
    alternateRewards: 0,
    startedAt: null,
    expiresAt: null,
  };
}

/** 테스트와 실제 추적기가 같은 상한·만료 규칙을 사용하도록 상태 전이를 순수 함수로 유지합니다. */
export function applyDigsiteBoardEvent(
  state: DigsiteBoardState,
  event: DigsiteBoardEvent,
  now: number,
): DigsiteBoardState {
  const safeNow = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
  if (event.type === 'entry') {
    return {
      ...createDigsiteBoardState(),
      isActive: true,
      startedAt: safeNow,
      expiresAt: safeNow + DIGSITE_BOARD_VISIBLE_MS,
    };
  }

  if (event.type === 'expire' || !state.isActive || state.expiresAt === null || safeNow >= state.expiresAt) {
    return { ...state, portalVisits: { ...state.portalVisits }, isActive: false };
  }

  if (event.type === 'normal-reward') {
    return {
      ...state,
      portalVisits: { ...state.portalVisits },
      normalRewards: Math.min(DIGSITE_NORMAL_REWARD_MAX, state.normalRewards + 1),
    };
  }
  if (event.type === 'portal-reward') {
    return {
      ...state,
      portalVisits: { ...state.portalVisits },
      portalRewards: Math.min(DIGSITE_PORTAL_REWARD_MAX, state.portalRewards + 1),
    };
  }
  if (event.type === 'alternate-reward') {
    return {
      ...state,
      portalVisits: { ...state.portalVisits },
      alternateRewards: Math.min(DIGSITE_ALTERNATE_REWARD_MAX, state.alternateRewards + 1),
    };
  }
  return {
    ...state,
    portalVisits: { ...state.portalVisits, [event.portal]: true },
  };
}

class DigsiteTracker {
  private _started = false;
  private _state = createDigsiteBoardState();
  private _hideTimer: NodeJS.Timeout | null = null;

  public start(): void {
    if (this._started) {
      log('[DIGSITE] 이미 시작되어 중복 이벤트 리스너 등록을 건너뜁니다.');
      return;
    }
    this._started = true;

    chatParser.on('DIGSITE_ENTRY', () => this.applyEvent({ type: 'entry' }));
    chatParser.on('DIGSITE_NORMAL_REWARD', () => this.applyEvent({ type: 'normal-reward' }));
    chatParser.on('DIGSITE_PORTAL_VISIT', data => this.applyEvent({ type: 'portal-visit', portal: data.portal }));
    chatParser.on('DIGSITE_PORTAL_REWARD', () => this.applyEvent({ type: 'portal-reward' }));
    chatParser.on('DIGSITE_ALTERNATE_REWARD', () => this.applyEvent({ type: 'alternate-reward' }));
  }

  private applyEvent(event: DigsiteBoardEvent): void {
    const wasActive = this._state.isActive;
    this._state = applyDigsiteBoardEvent(this._state, event, Date.now());

    if (event.type === 'entry') {
      this.scheduleFixedHide();
      log('[DIGSITE] 입장 감지: 현황판을 초기화하고 5분 표시를 시작합니다.');
    } else if (wasActive && !this._state.isActive) {
      if (this._hideTimer) clearTimeout(this._hideTimer);
      this._hideTimer = null;
      this.notify();
      return;
    } else if (!wasActive) {
      return;
    }
    this.notify();
  }

  private scheduleFixedHide(): void {
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      this._state = applyDigsiteBoardEvent(this._state, { type: 'expire' }, Date.now());
      this.notify();
      log('[DIGSITE] 종료 로그가 없어 입장 5분 뒤 현황판을 자동으로 숨겼습니다.');
    }, DIGSITE_BOARD_VISIBLE_MS);
    this._hideTimer.unref?.();
  }

  private notify(): void {
    broadcastToAllWindows('digsite-update', this.getState());
  }

  public getState(): DigsiteBoardState {
    return { ...this._state, portalVisits: { ...this._state.portalVisits } };
  }

  /** 새 게임 프로세스에는 이전 실행의 발굴지 진행 상태를 넘기지 않습니다. */
  public beginGameSession(): void {
    this.reset();
  }

  public reset(): void {
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = null;
    this._state = createDigsiteBoardState();
    this.notify();
  }
}

export const digsiteTracker = new DigsiteTracker();
