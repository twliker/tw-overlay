import { app, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import * as config from './config';

interface EtaRankingItem {
  ServerCode: number;
  CharacterCode: number;
  UserId: string;
  Level: number;
  Essence: number;
}

interface EtaPayload {
  CollectDate?: string;
  Rankings?: EtaRankingItem[];
}

class EtaCacheManager {
  // Key: "ServerCode_Nickname" (e.g. "16_본캐닉네임") -> Value: { level, characterCode }
  private _cacheMap = new Map<string, { level: number; characterCode: number }>();
  private _cacheFilePath = '';
  private _refreshTimer: NodeJS.Timeout | null = null;
  private _isFetching = false;

  constructor() {
    try {
      this._cacheFilePath = path.join(app.getPath('userData'), 'eta_ranking_cache.json');
    } catch (e) {
      log(`[ETA_CACHE] Path init error (dev-mode?): ${e}`);
    }
  }

  /**
   * 에타 캐시 매니저 초기화 및 갱신 주기 작동
   */
  public init(): void {
    this.loadFromLocalCache();
    
    // 앱 시작 시 원격 데이터 다운로드 (로컬 캐시가 오늘 것이면 스킵)
    if (!this.isCacheFreshToday()) {
      this.fetchRemoteData().catch(e => log(`[ETA_CACHE] Initial fetch failed: ${e}`));
    } else {
      log('[ETA_CACHE] 오늘 캐시가 이미 최신 상태입니다. 원격 다운로드를 건너뜁니다.');
    }

    // 매일 낮 12시 정각에 자동 갱신 스케줄
    this.scheduleNoonRefresh();
  }

  /**
   * 로컬 캐시 파일이 오늘 날짜로 저장된 것인지 확인
   */
  private isCacheFreshToday(): boolean {
    if (!this._cacheFilePath || !fs.existsSync(this._cacheFilePath)) return false;
    try {
      const raw = fs.readFileSync(this._cacheFilePath, 'utf-8');
      const payload: EtaPayload = JSON.parse(raw);
      if (!payload.CollectDate) return false;
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      // CollectDate 형식: "2026-06-04 08:17:18"
      return payload.CollectDate.startsWith(today);
    } catch {
      return false;
    }
  }

  /**
   * 다음 낮 12시까지 남은 밀리초 계산
   */
  private getMsUntilNextNoon(): number {
    const now = new Date();
    const noon = new Date(now);
    noon.setHours(12, 0, 0, 0);

    // 이미 오늘 12시가 지났으면 내일 12시로 설정
    if (now >= noon) {
      noon.setDate(noon.getDate() + 1);
    }

    const ms = noon.getTime() - now.getTime();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    log(`[ETA_CACHE] 다음 자동 갱신 예정: ${noon.toLocaleString('ko-KR')} (${h}시간 ${m}분 후)`);
    return ms;
  }

  /**
   * 매일 낮 12시 정각에 자동 갱신 (setTimeout 체이닝 방식)
   */
  private scheduleNoonRefresh(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer as NodeJS.Timeout);
    }
    this._refreshTimer = setTimeout(() => {
      log('[ETA_CACHE] 낮 12시 자동 갱신 시작...');
      this.fetchRemoteData(true).catch(e => log(`[ETA_CACHE] Noon refresh failed: ${e}`));
      // 갱신 후 다음 12시 재스케줄
      this.scheduleNoonRefresh();
    }, this.getMsUntilNextNoon());
  }

  /**
   * 캐시 데이터 O(1) 조회
   * @param serverCode 16: 네냐플, 7: 하이아칸
   * @param nickname 유저 닉네임
   */
  public getRankInfo(serverCode: number, nickname: string): { level: number; characterCode: number } | null {
    if (!nickname) return null;
    
    const key = `${serverCode}_${nickname.trim()}`;
    return this._cacheMap.get(key) || null;
  }

  /**
   * 로컬 파일 캐시에서 데이터 로드
   */
  private loadFromLocalCache(): void {
    if (!this._cacheFilePath || !fs.existsSync(this._cacheFilePath)) {
      log('[ETA_CACHE] 로컬 캐시 파일이 존재하지 않습니다.');
      return;
    }

    try {
      const raw = fs.readFileSync(this._cacheFilePath, 'utf-8');
      const payload: EtaPayload = JSON.parse(raw);
      
      if (payload && Array.isArray(payload.Rankings)) {
        this.buildIndexMap(payload.Rankings);
        log(`[ETA_CACHE] 로컬 캐시 로드 완료: ${this._cacheMap.size}명 인덱싱됨 (수집일: ${payload.CollectDate || '알 수 없음'})`);
      }
    } catch (e) {
      log(`[ETA_CACHE] 로컬 캐시 로드 오류: ${e}`);
    }
  }

  /**
   * 원격 저장소 URL로부터 최신 eta_ranking.json 다운로드
   */
  public async fetchRemoteData(force = false): Promise<boolean> {
    if (this._isFetching) return false;
    
    const url = 'https://raw.githubusercontent.com/twliker/tw-overlay-data/main/eta_ranking.json';
    
    this._isFetching = true;
    log(`[ETA_CACHE] 최신 에타 데이터 갱신 시도 중: ${url}`);

    try {
      const response = await net.fetch(url, {
        method: 'GET',
        headers: {
          'pragma': 'no-cache',
          'cache-control': 'no-cache'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const text = await response.text();
      const payload: EtaPayload = JSON.parse(text);

      if (payload && Array.isArray(payload.Rankings)) {
        // 인덱스 재생성
        this.buildIndexMap(payload.Rankings);
        log(`[ETA_CACHE] 원격 다운로드 및 맵핑 완료: ${this._cacheMap.size}명 (수집일: ${payload.CollectDate || '알 수 없음'})`);

        // 로컬에 파일 캐싱 (비동기 및 공백 제거로 I/O 지연 방지)
        if (this._cacheFilePath) {
          try {
            await fs.promises.writeFile(this._cacheFilePath, JSON.stringify(payload), 'utf-8');
          } catch (writeErr) {
            log(`[ETA_CACHE] 로컬 캐시 파일 저장 실패: ${writeErr}`);
          }
        }
        
        return true;
      } else {
        throw new Error('유효하지 않은 rankings 데이터 형식입니다.');
      }
    } catch (err) {
      log(`[ETA_CACHE] 에타 데이터 갱신 실패: ${(err as any).message}`);
      return false;
    } finally {
      this._isFetching = false;
    }
  }

  /**
   * Rankings 리스트를 맵 객체로 고속 인덱싱
   */
  private buildIndexMap(rankings: EtaRankingItem[]): void {
    const newMap = new Map<string, { level: number; characterCode: number }>();
    
    for (const item of rankings) {
      if (!item.UserId || item.ServerCode === undefined) continue;
      
      const key = `${item.ServerCode}_${item.UserId.trim()}`;
      // 중복 닉네임이 있을 경우 더 높은 에타 레벨의 데이터를 우선 적용
      const existing = newMap.get(key);
      if (!existing || item.Level > existing.level) {
        newMap.set(key, {
          level: item.Level,
          characterCode: item.CharacterCode
        });
      }
    }
    
    this._cacheMap = newMap;
  }
  
  /**
   * 로컬 캐시 파일 존재 여부 및 수집일 조회
   */
  public getCacheStatus(): { exists: boolean; collectDate?: string } {
    if (!this._cacheFilePath || !fs.existsSync(this._cacheFilePath)) {
      return { exists: false };
    }
    try {
      const raw = fs.readFileSync(this._cacheFilePath, 'utf-8');
      const payload: EtaPayload = JSON.parse(raw);
      return { exists: true, collectDate: payload.CollectDate };
    } catch {
      return { exists: true };
    }
  }

  /**
   * 메모리 캐시 비우기
   */
  public clear(): void {
    this._cacheMap.clear();
    if (this._cacheFilePath && fs.existsSync(this._cacheFilePath)) {
      try {
        fs.unlinkSync(this._cacheFilePath);
      } catch (e) {
        log(`[ETA_CACHE] 캐시 파일 삭제 실패: ${e}`);
      }
    }
  }
}

export const etaCacheManager = new EtaCacheManager();
