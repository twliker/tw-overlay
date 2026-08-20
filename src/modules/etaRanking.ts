import { net } from 'electron';
import type { EtaRankingResult, EtaRankingParams } from '../shared/types';

export async function fetchEtaRanking({
    sc = 16,     // 16: 네냐플, 7: 하이아칸
    cc = 99,     // 99: 전체
    page = 1,
    search = ''
}: EtaRankingParams = {}): Promise<EtaRankingResult> {
    const url = new URL('https://tales.nexon.com/Community/Ranking/EtaRank');
    url.searchParams.append('sc', sc.toString());
    url.searchParams.append('cc', cc.toString());
    url.searchParams.append('page', page.toString());
    if (search) {
        url.searchParams.append('search', search);
    }

    // Use net.fetch provided by Electron for stable network requests with headers
    const response = await net.fetch(url.toString(), {
        method: 'GET',
        headers: {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'accept-encoding': 'gzip, deflate, br, zstd',
            'accept-language': 'ko,ja;q=0.9,en-US;q=0.8,en;q=0.7',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            // 'referer': 'https://tales.nexon.com/Community/Ranking/EtaRank?page=1&cc=99&sc=16' 
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Eta Ranking: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    // Parse HTML
    const result: EtaRankingResult = {
        lastUpdate: '',
        entries: []
    };

    // Last Update 추출
    const dateMatch = html.match(/<dt>Last Update\s*:<\/dt>\s*<dd>([^<]+)<\/dd>/i);
    if (dateMatch) {
        result.lastUpdate = dateMatch[1].trim();
    }

    // 랭킹 추출
    const rowRegex = /<td[^>]*class="col_rank"[^>]*>.*?<span[^>]*class="number"[^>]*>(\d+)<\/span>.*?<td[^>]*class="col_char"[^>]*>.*?<span[^>]*class="charname"[^>]*>([^<]+)<\/span>.*?<span[^>]*class="nickname"[^>]*>([^<]+)<\/span>.*?<\/td>.*?<td[^>]*class="number col_level"[^>]*>(\d+)<\/td>.*?<td[^>]*class="number col_point"[^>]*>([\d,]+)<\/td>/gs;

    let match;
    while ((match = rowRegex.exec(html)) !== null) {
        result.entries.push({
            rank: parseInt(match[1], 10),
            character: match[2].trim(),
            nickname: match[3].trim(),
            level: parseInt(match[4], 10),
            point: parseInt(match[5].replace(/,/g, ''), 10)
        });
    }

    return result;
}
