/**
 * 기능 계약 — 거래 검색 진행 상태
 * 키워드별 성공한 조회만 확인 위치를 전진시킨다. 다른 키워드에서 이미 알린 글은 구간으로 기억하고,
 * 모든 활성 키워드가 지난 구간은 지운다. 실패 중 앱을 다시 시작해도 이 상태를 config에서 이어받는다.
 * 구버전 tradeLastSeen은 키워드별 초기값이며, 서버 변경은 모두 초기화한다.
 * 회귀: scripts/check-audit-regressions.ts. 사용자 문서: docs/trade.md.
 */
import type { TradeSearchState } from './types';
import { MAX_NOTIFICATION_KEYWORDS, normalizeNotificationKeyword } from './keywordSanitizer';

const postNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isTradeSearchState(value: unknown): value is TradeSearchState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const state = value as TradeSearchState;
    if (state.version !== 1 || !['RyXp', 'Siwv'].includes(state.server)
        || !Array.isArray(state.cursors) || state.cursors.length > MAX_NOTIFICATION_KEYWORDS
        || !Array.isArray(state.notifiedRanges)) return false;
    const keywords = new Set<string>();
    for (const cursor of state.cursors) {
        if (!cursor || typeof cursor !== 'object' || !normalizeNotificationKeyword(cursor.keyword)
            || cursor.keyword !== normalizeNotificationKeyword(cursor.keyword)
            || keywords.has(cursor.keyword) || !postNumber(cursor.postNo) || typeof cursor.initialized !== 'boolean') return false;
        keywords.add(cursor.keyword);
    }
    let end = 0;
    for (const range of state.notifiedRanges) {
        if (!Array.isArray(range) || range.length !== 2 || !postNumber(range[0]) || !postNumber(range[1])
            || range[0] <= end || range[1] < range[0]) return false;
        end = range[1];
    }
    return true;
}

export function createTradeSearchState(saved: unknown, server: string, keywords: string[], legacyLastSeen: number): TradeSearchState {
    const previous = isTradeSearchState(saved) && saved.server === server ? saved : undefined;
    const baseline = postNumber(legacyLastSeen) ? legacyLastSeen : 0;
    const byKeyword = new Map(previous?.cursors.map(cursor => [cursor.keyword, cursor]));
    const state: TradeSearchState = {
        version: 1, server,
        cursors: keywords.map(keyword => {
            const cursor = byKeyword.get(keyword);
            // 첫 회차 일부 실패 시 다른 검색이 정한 최초 기준점을 승계한다. 이후 실패는 각자의 기준을 유지한다.
            return cursor?.initialized ? { ...cursor } : { keyword, postNo: baseline, initialized: baseline > 0 };
        }),
        notifiedRanges: previous ? previous.notifiedRanges.map(range => [...range]) : [],
    };
    pruneTradeNotifications(state);
    return state;
}

/** 성공한 키워드만 갱신하고, 최초 기준점·다른 키워드와의 중복을 제외한 글 번호를 반환한다. */
export function applyTradeSearchResult(state: TradeSearchState, keyword: string, postNos: number[], cycleBaseline: number): number[] {
    const cursor = state.cursors.find(entry => entry.keyword === keyword);
    if (!cursor) return [];
    const validNos = [...new Set(postNos.filter(postNumber))].filter(no => no > 0);
    const fresh = cursor.initialized ? validNos.filter(no => no > cursor.postNo
        && !state.notifiedRanges.some(([start, end]) => start <= no && no <= end)) : [];
    // 빈 조회도 성공한 확인이다. 실패한 조회는 이 함수를 호출하지 않아 기준을 그대로 남긴다.
    cursor.postNo = Math.max(cursor.postNo, ...(validNos.length ? validNos : [cycleBaseline]));
    cursor.initialized = true;
    const ranges: Array<[number, number]> = [...state.notifiedRanges, ...fresh.map(no => [no, no] as [number, number])]
        .sort((left, right) => left[0] - right[0]);
    state.notifiedRanges = [];
    for (const range of ranges) {
        const last = state.notifiedRanges.at(-1);
        if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
        else state.notifiedRanges.push([...range]);
    }
    return fresh;
}

export function pruneTradeNotifications(state: TradeSearchState): void {
    // 아직 최초 조회조차 성공하지 못한 키워드는 첫 성공에서 과거 글을 알리지 않는다.
    const initialized = state.cursors.filter(cursor => cursor.initialized);
    const floor = initialized.length ? Math.min(...initialized.map(cursor => cursor.postNo)) : Infinity;
    state.notifiedRanges = state.notifiedRanges.filter(([, end]) => end > floor)
        .map(([start, end]) => [Math.max(start, floor + 1), end]);
}
