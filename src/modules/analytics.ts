import { net, app } from 'electron';
import Store from 'electron-store';

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { load as loadConfig } from './config';
import {
  normalizeGaClientId,
  normalizeGaEventName,
  normalizeGaEventParams,
} from './analyticsProtocol';

// ========== GA4 SETTINGS ==========
let MEASUREMENT_ID = '';
let API_SECRET = '';

try {
  const envPath = path.join(__dirname, '..', 'env.json');
  if (fs.existsSync(envPath)) {
    const envData = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
    MEASUREMENT_ID = envData.MEASUREMENT_ID || '';
    API_SECRET = envData.API_SECRET || '';
  }
} catch (e) {
  console.warn('[Analytics] Failed to parse env.json');
}
// ==================================

interface AnalyticsStoreSchema {
  ga_client_id: string;
  ga_session_id: number;
  ga_session_number: number;
  ga_last_active_time: number;
}

const store = new Store() as unknown as {
  get<K extends keyof AnalyticsStoreSchema>(key: K): AnalyticsStoreSchema[K] | undefined;
  set<K extends keyof AnalyticsStoreSchema>(key: K, value: AnalyticsStoreSchema[K]): void;
};

export class Analytics {
  private clientId: string;
  private sessionId: number = 0;
  private sessionNumber: number = 1;
  
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastEngagementTime: number = Date.now();

  constructor() {
    // 1. Client ID persistence
    const savedClientId = store.get('ga_client_id');
    const normalizedClientId = normalizeGaClientId(savedClientId);
    if (normalizedClientId.clientId !== savedClientId) {
      store.set('ga_client_id', normalizedClientId.clientId);
    }
    if (normalizedClientId.migrated) {
      log('[Analytics] 기존 Client ID를 GA4 호환 형식으로 마이그레이션했습니다.');
    }
    this.clientId = normalizedClientId.clientId;

    // 2. Session ID & Number (Start new session on every restart)
    const now = Date.now();
    const savedSessionNumber = store.get('ga_session_number');

    this.sessionId = Math.floor(now / 1000);
    this.sessionNumber = (savedSessionNumber || 0) + 1;

    store.set('ga_session_id', this.sessionId);
    store.set('ga_session_number', this.sessionNumber);
    store.set('ga_last_active_time', now);
    
    this.lastEngagementTime = now;

    log(`[Analytics] 시작됨 (ClientID: ${this.clientId.split('-')[0]}..., Session#: ${this.sessionNumber})`, true);

    // 시작 시 하트비트 타이머 등록 (10분 주기)
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // 10분 = 600,000 ms
    this.heartbeatTimer = setInterval(() => {
      this.trackEvent('app_heartbeat');
    }, 600 * 1000);
  }

  public trackEvent(eventName: string, params: Record<string, unknown> = {}): void {
    if (!MEASUREMENT_ID || !API_SECRET || MEASUREMENT_ID === 'G-XXXXXXXXXX' || API_SECRET === 'XXXXXXXXXXXXXXXXXXX') {
      return; // 설정되지 않은 경우 조용히 무시
    }

    if (!net.isOnline()) {
      return; // 오프라인인 경우 조용히 무시 (게임 컴패니언 앱 특성상 재시도 큐 생략)
    }

    const now = Date.now();
    const engagementTimeMsec = now - this.lastEngagementTime;
    this.lastEngagementTime = now;

    // 1-depth 보장을 위해 params 복사 후 기본값 덮어쓰기
    const flatParams = normalizeGaEventParams(params);
    
    // GA4 필수 예약 파라미터 추가
    flatParams.app_version = app.getVersion();
    flatParams.ga_session_id = this.sessionId;
    flatParams.ga_session_number = this.sessionNumber;
    // 1ms 이상이어야 GA4가 유효한 체류 시간으로 인식
    flatParams.engagement_time_msec = Math.max(1, engagementTimeMsec);

    // 현재 사용 중인 런처 모드(사이드바 위치 / 독 모드) 파라미터 자동 삽입
    try {
      const cfg = loadConfig();
      flatParams.launcher_mode = cfg.sidebarPosition || 'right';
    } catch {}

    const payload = {
      client_id: this.clientId,
      events: [
        {
          name: normalizeGaEventName(eventName),
          params: flatParams,
        }
      ],
    };

    try {
      const request = net.request({
        method: 'POST',
        url: `https://www.google-analytics.com/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`,
      });

      request.on('error', (err) => {
        log(`[Analytics] 전송 에러(Request error): ${err.message}`);
      });
      
      request.on('response', (response) => {
        if (response.statusCode === 200 || response.statusCode === 204) {
          log(`[Analytics] 이벤트 '${eventName}' 전송 완료`);
        } else {
          log(`[Analytics] 전송 실패 (상태 코드: ${response.statusCode})`);
        }
      });

      request.setHeader('Content-Type', 'application/json');
      request.write(JSON.stringify(payload));
      request.end();
    } catch (error) {
      log(`[Analytics] Error sending events: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public trackError(errorName: string, errorMessage: string): void {
    this.trackEvent('app_error', {
      error_name: errorName.substring(0, 100),
      error_message: errorMessage.substring(0, 100),
    });
  }
}

export const analytics = new Analytics();
