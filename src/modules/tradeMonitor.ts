/**
 * 매직위버 거래 게시판 모니터 모듈
 * - 다음 카페 매직위버 거래 게시판(하이아칸/네냐플)을 키워드 기반으로 모니터링
 * - 키워드가 등록된 경우에만 5분 간격으로 폴링
 * - 블락 방지: 랜덤 딜레이, 지수 백오프
 */
import { BrowserWindow, shell } from 'electron';
import { log } from './logger';
import * as config from './config';
import { showDesktopNotification } from './desktopNotification';
import {
    calculateBackoffMs,
    fetchTextWithSslRetry,
    MONITOR_CHECK_INTERVAL_MS,
    MONITOR_RATE_LIMIT,
    waitRandomDelay,
} from './webMonitorUtils';

interface TradePost {
    no: number;
    title: string;
    writer: string;
    date: string;
    url: string;
}

// ─── 서버 설정 ───
const GRPID = 'R4uk';
const SERVERS: Record<string, { fldid: string; name: string }> = {
    'RyXp': { fldid: 'RyXp', name: '하이아칸' },
    'Siwv': { fldid: 'Siwv', name: '네냐플' },
};

const BASE_URL = (fldid: string) =>
    `https://cafe.daum.net/_c21_/bbs_list?grpid=${GRPID}&fldid=${fldid}`;

// 카페 검색 URL (키워드 기반 알림용)
const SEARCH_URL = (fldid: string, keyword: string) =>
    `https://cafe.daum.net/_c21_/cafesearch?grpid=${GRPID}&fldid=${fldid}&pagenum=1&item=subject&searchPeriod=aMonth&listnum=20&sorttype=0&query=${encodeURIComponent(keyword)}`;

const POST_URL = (fldid: string, datanum: number) =>
    `https://cafe.daum.net/MagicWeaver/${fldid}/${datanum}`;

const HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'identity',
    'Referer': 'https://cafe.daum.net/MagicWeaver',
};

let consecutiveErrors = 0;

// ─── 상태 ───
let currentServer = 'RyXp';
let tradeKeywords: string[] = [];
let lastSeenPostNo = 0;
let checkTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let notifyEnabled = true;
let sidebarWindowRef: BrowserWindow | null = null;
let tradeWindowRef: BrowserWindow | null = null;

// ─── HTTP 요청 ───
function fetchPage(url: string, skipSSLVerify = false, maxRedirects = 5): Promise<string> {
    return fetchTextWithSslRetry(url, {
        headers: HEADERS,
        timeoutMs: 15000,
        onSslRetry: message => log(`[TRADE] SSL 검증 실패, 재시도: ${message}`),
    }, skipSSLVerify, maxRedirects);
}

function decodeArticleField(value: string): string {
    try {
        return decodeURIComponent(JSON.parse(`"${value}"`));
    } catch {
        return value;
    }
}

function appendScriptArticles(source: string, fldid: string, posts: TradePost[]): void {
    const pushRegex = /articles\.push\(\s*({[\s\S]*?})\s*\);/g;
    let pushMatch: RegExpExecArray | null;

    while ((pushMatch = pushRegex.exec(source)) !== null) {
        try {
            const objectSource = pushMatch[1];
            const dataidMatch = /dataid:\s*'(\d+)'/i.exec(objectSource) || /dataid:\s*"?(\d+)"?/i.exec(objectSource);
            const titleMatch = /title:\s*'([^']+)'/i.exec(objectSource) || /title:\s*"([^"]+)"/i.exec(objectSource);
            const authorMatch = /author:\s*'([^']+)'/i.exec(objectSource) || /author:\s*"([^"]+)"/i.exec(objectSource);
            const createdMatch = /created:\s*'([^']+)'/i.exec(objectSource) || /created:\s*"([^"]+)"/i.exec(objectSource);

            if (!dataidMatch || !titleMatch) continue;

            const no = parseInt(dataidMatch[1], 10);
            posts.push({
                no,
                title: decodeArticleField(titleMatch[1]),
                writer: decodeArticleField(authorMatch ? authorMatch[1] : ''),
                date: createdMatch ? createdMatch[1] : '',
                url: POST_URL(fldid, no),
            });
        } catch {
            // 기존 파서는 손상된 단일 article 항목만 건너뜁니다.
        }
    }
}

// ─── HTML 파싱 ───
function parsePostList(html: string, fldid: string, isSearch: boolean = false): TradePost[] {
    const posts: TradePost[] = [];

    // 1. 카페 게시판(bbs_list)일 경우 <script> var articles = [...]; </script> 파싱 시도
    // 중간에 다른 코드가 섞여있을 수 있으므로 너무 길게 매칭하지 않도록 함
    if (!isSearch) {
        const scriptRegex = /var\s+articles\s*=\s*\[\];([\s\S]*?)var\s+\w+\s*=/i;
        const scriptMatch = scriptRegex.exec(html);

        if (scriptMatch && scriptMatch[1]) {
            appendScriptArticles(scriptMatch[1], fldid, posts);
        } else {
            // 정규식이 너무 길어서 터지는 경우를 대비한 대안 파싱 (문자열 indexOf 기반)
            const startIndex = html.indexOf('var articles = [];');
            if (startIndex !== -1) {
                const endIndex = html.indexOf('});\n', startIndex);
                if (endIndex !== -1) {
                    // 대략적인 articles 선언부 추출
                    const chunk = html.substring(startIndex, startIndex + 50000);
                    appendScriptArticles(chunk, fldid, posts);
                    if (posts.length > 0) return posts;
                }
            }
        }
    }

    // 2. 검색 결과(cafesearch) 또는 HTML 태그 기반의 Fallback
    // a 태그 속성이름 상관없이 datanum 속성을 가지고 있는 a 태그 매칭
    const rowRegex = /<a\s+href="[^"]*datanum=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
        let no = parseInt(match[1], 10);
        let rawTitle = match[2].replace(/<[^>]+>/g, '').trim();

        // <a>태그 내부에 글 제목이 아닌 요소들이 매칭될 수 있으므로 전처리
        if (isNaN(no) || no <= 0 || !rawTitle || rawTitle.length < 2) continue;
        if (rawTitle.includes('새글') || rawTitle.includes('첨부파일')) continue;

        posts.push({
            no,
            title: rawTitle,
            writer: '',
            date: '',
            url: POST_URL(fldid, no),
        });
    }

    const writerRegex = /class="[^"]*nick[^"]*"[^>]*>([^<]+)</gi;
    const dateRegex = /class="[^"]*date[^"]*"[^>]*>([^<]+)</gi;

    // 카페검색의 작성자는 구조가 다름
    const searchWriterRegex = /class="[^"]*search_nick[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi;
    const searchDateRegex = /class="[^"]*date[^"]*"[^>]*>([^<]+)</gi;

    const writers: string[] = [];
    const dates: string[] = [];
    let wm;

    // 목록 파싱
    while ((wm = writerRegex.exec(html)) !== null) { writers.push(wm[1].trim()); }
    if (writers.length === 0) {
        // 검색 파싱
        while ((wm = searchWriterRegex.exec(html)) !== null) { writers.push(wm[1].trim()); }
    }

    while ((wm = dateRegex.exec(html)) !== null) { dates.push(wm[1].trim()); }
    if (dates.length === 0) {
        while ((wm = searchDateRegex.exec(html)) !== null) { dates.push(wm[1].trim()); }
    }

    // 공지사항 등 상단 고정글을 제외하기 위해 writers/dates와 posts를 역순 매칭 시도
    // 일반적으로 게시판 글과 작성자/날짜 수가 동일하지 않을 수 있으므로
    // 안전하게 최소 수만큼 매칭
    // 중복 제거 (검색 결과의 경우 본문 미리보기도 <a> 속성을 가져 중복이 생길 수 있음)
    const uniquePosts: TradePost[] = [];
    const seenNos = new Set<number>();
    for (const p of posts) {
        if (!seenNos.has(p.no)) {
            seenNos.add(p.no);
            uniquePosts.push(p);
        }
    }

    const offset = Math.max(0, writers.length - uniquePosts.length);
    for (let i = 0; i < uniquePosts.length; i++) {
        if (i + offset < writers.length) uniquePosts[i].writer = writers[i + offset];
        if (i + offset < dates.length) uniquePosts[i].date = dates[i + offset];
    }

    return uniquePosts;
}

// ─── 알림 ───
function notify(title: string, body: string, url?: string): void {
    showDesktopNotification({
        enabled: notifyEnabled,
        title,
        body,
        onClick: url ? () => shell.openExternal(url) : undefined,
        onError: error => {
            const message = error instanceof Error ? error.message : String(error);
            log(`[TRADE] 알림 실패: ${message}`);
        },
    });
}

// ─── 새 글 알림용 카페 검색 감지 ───
async function checkKeywordsSearch(): Promise<boolean> {
    const server = SERVERS[currentServer];
    if (!server) return false;

    // 키워드가 없으면 검색하지 않음
    if (tradeKeywords.length === 0) return true;

    try {
        let maxNo = lastSeenPostNo;
        const toNotify: TradePost[] = [];
        let hasError = false;

        // 알림 기능 시에는 각각의 검색 API를 쏜다
        for (const kw of tradeKeywords) {
            try {
                await waitRandomDelay(MONITOR_RATE_LIMIT.MIN_DELAY_MS, MONITOR_RATE_LIMIT.MAX_DELAY_MS); // 키워드당 딜레이 (블락 방지)
                const html = await fetchPage(SEARCH_URL(server.fldid, kw));
                const posts = parsePostList(html, server.fldid, true);

                if (posts.length === 0) continue;

                const latestNo = Math.max(...posts.map(p => p.no));

                if (lastSeenPostNo === 0) {
                    maxNo = Math.max(maxNo, latestNo);
                    continue; // 초기 상태면 알림 없이 최신 글 번호만 기록
                }

                const newPosts = posts.filter(p => p.no > lastSeenPostNo);
                if (newPosts.length > 0) {
                    maxNo = Math.max(maxNo, latestNo);
                    // 중복방지 (서로 다른 키워드에서 같은 글이 검색될 수 있음)
                    for (const p of newPosts) {
                        if (!toNotify.some(n => n.no === p.no)) {
                            toNotify.push(p);
                        }
                    }
                }
            } catch (err) {
                log(`[TRADE] '${kw}' 검색 실패: ${err instanceof Error ? err.message : String(err)}`);
                hasError = true;
            }
        }

        if (hasError && toNotify.length === 0) return false;

        if (lastSeenPostNo === 0) {
            lastSeenPostNo = maxNo;
            config.save({ tradeLastSeen: maxNo });
            // 검색 후 forceCheck를 호출하여 UI 목록을 갱신
            await checkNewPostsUI();
            return true;
        }

        if (toNotify.length > 0) {
            sendNewActivity(toNotify.length);

            const notifyItems = toNotify.sort((a, b) => b.no - a.no).slice(0, 3);
            for (const p of notifyItems) {
                notify(`🛒 ${server.name} 거래 (${p.writer || '작성자'})`, p.title, p.url);
            }
            if (toNotify.length > 3) {
                notify(`🛒 ${server.name} 거래`, `외 ${toNotify.length - 3}개의 키워드 일치 새 글이 있습니다.`);
            }

            lastSeenPostNo = Math.max(lastSeenPostNo, maxNo);
            config.save({ tradeLastSeen: lastSeenPostNo });

            // 새 글이 있을 때는 bbs_list도 한 번 갱신해서 UI에 뿌려줌
            await checkNewPostsUI();
        }

        return true;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRADE] 검색 체크 (알림루프) 실패: ${msg}`);
        return false;
    }
}

// ─── UI 갱신용 최신글 20개 가져오기 ───
async function checkNewPostsUI(): Promise<boolean> {
    const server = SERVERS[currentServer];
    if (!server) return false;

    try {
        const html = await fetchPage(BASE_URL(server.fldid));
        const posts = parsePostList(html, server.fldid, false);

        // UI가 열려있을 때만 데이터를 보냄 (성능 최적화)
        if (tradeWindowRef && !tradeWindowRef.isDestroyed() && tradeWindowRef.isVisible()) {
            sendPostListToWindow(posts);
        }
        return true;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRADE] UI 목록 체크 실패: ${msg}`);
        return false;
    }
}

// ─── 주기 체크 루프 ───
async function doCheck(): Promise<void> {
    if (!isRunning) return;

    // 키워드가 없으면 폴링 안 함
    if (tradeKeywords.length === 0) {
        checkTimer = setTimeout(doCheck, MONITOR_CHECK_INTERVAL_MS);
        return;
    }

    if (!notifyEnabled) {
        checkTimer = setTimeout(doCheck, MONITOR_CHECK_INTERVAL_MS);
        return;
    }

    const backoff = calculateBackoffMs(
        consecutiveErrors,
        MONITOR_RATE_LIMIT.BACKOFF_BASE_MS,
        MONITOR_RATE_LIMIT.MAX_BACKOFF_MS,
    );
    if (backoff > 0) {
        consecutiveErrors = Math.max(0, consecutiveErrors - 1);
        checkTimer = setTimeout(doCheck, backoff);
        return;
    }

    // bbs_list가 아닌, 알림용으로 등록된 모든 키워드를 순회하며 각각 cafesearch
    const success = await checkKeywordsSearch();

    if (success) {
        if (consecutiveErrors > 0) {
            if (tradeWindowRef && !tradeWindowRef.isDestroyed()) {
                tradeWindowRef.webContents.send('trade-connection-status', true);
            }
        }
        consecutiveErrors = 0;
    } else {
        consecutiveErrors++;
        log(`[TRADE Error] 목록 체크 실패 (연속 ${consecutiveErrors}회)`);
        if (tradeWindowRef && !tradeWindowRef.isDestroyed()) {
            tradeWindowRef.webContents.send('trade-connection-status', false);
        }
    }

    checkTimer = setTimeout(doCheck, MONITOR_CHECK_INTERVAL_MS);
}

// ─── 내부 유틸 ───
function sendPostListToWindow(posts: TradePost[]): void {
    if (tradeWindowRef && !tradeWindowRef.isDestroyed()) {
        tradeWindowRef.webContents.send('trade-posts', posts);
    }
}

function sendNewActivity(count: number): void {
    if (tradeWindowRef && !tradeWindowRef.isDestroyed() && tradeWindowRef.isVisible()) return;
    if (sidebarWindowRef && !sidebarWindowRef.isDestroyed()) {
        sidebarWindowRef.webContents.send('trade-new-activity', { type: 'post', count });
    }
}

// ─── 공개 API ───
export function start(sidebarWin: BrowserWindow): void {
    sidebarWindowRef = sidebarWin;

    const cfg = config.load();
    currentServer = cfg.tradeServer || 'RyXp';
    tradeKeywords = cfg.tradeKeywords || [];
    lastSeenPostNo = cfg.tradeLastSeen || 0;
    notifyEnabled = cfg.tradeNotify !== false;

    isRunning = true;
    log(`[TRADE] 거래 게시판 모니터 시작 (서버: ${SERVERS[currentServer]?.name || currentServer}, 키워드: ${tradeKeywords.length}개)`);
    doCheck();
}

export function stop(): void {
    isRunning = false;
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    log('[TRADE] 거래 게시판 모니터 중지');
}

export function updateWindows(sidebarWin: BrowserWindow | null, tradeWin: BrowserWindow | null = null): void {
    sidebarWindowRef = sidebarWin;
    tradeWindowRef = tradeWin;

    const cfg = config.load();
    tradeKeywords = cfg.tradeKeywords || [];
    currentServer = cfg.tradeServer || 'RyXp';
}

export async function forceCheck(): Promise<TradePost[]> {
    const server = SERVERS[currentServer];
    if (!server) return [];

    try {
        if (tradeKeywords.length > 0 && isRunning && notifyEnabled) {
            // 강제 체크 시 백그라운드 카페 검색 로직 수행 (알림 포함)
            await checkKeywordsSearch().catch(e => log(`[TRADE] 강제(검색) 에러: ${e.message}`));
        }

        // 백그라운드 구동 중이 아니어도 UI 목록은 무조건 갱신
        const html = await fetchPage(BASE_URL(server.fldid));
        const posts = parsePostList(html, server.fldid, false);
        sendPostListToWindow(posts);

        if (posts.length > 0) {
            const latestNo = Math.max(...posts.map(p => p.no));
            if (latestNo > lastSeenPostNo) {
                lastSeenPostNo = latestNo;
                config.save({ tradeLastSeen: latestNo });
            }
        }
        return posts;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[TRADE] 강제 체크 실패: ${msg}`);
        return [];
    }
}

export function setNotifyEnabled(enabled: boolean): void {
    notifyEnabled = !!enabled;
    config.save({ tradeNotify: notifyEnabled });
}

export function getNotifyEnabled(): boolean {
    return notifyEnabled;
}

export function setServer(serverId: string): void {
    if (SERVERS[serverId]) {
        currentServer = serverId;
        lastSeenPostNo = 0;
        config.save({ tradeServer: serverId, tradeLastSeen: 0 });
        log(`[TRADE] 서버 변경: ${SERVERS[serverId].name}`);
    }
}

export function getServer(): string {
    return currentServer;
}

export function getServerName(): string {
    return SERVERS[currentServer]?.name || currentServer;
}

export function getServers(): Record<string, { fldid: string; name: string }> {
    return { ...SERVERS };
}
