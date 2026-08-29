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
  resolveDistributionSource,
  shouldTransmitAnalytics,
} from './analyticsProtocol';

// ========== GA4 SETTINGS ==========
const ANALYTICS_RUNTIME_ALLOWED = shouldTransmitAnalytics(
  app.isPackaged,
  process.env.TW_OVERLAY_DISABLE_ANALYTICS === '1',
);
let MEASUREMENT_ID = '';
let API_SECRET = '';

try {
  if (ANALYTICS_RUNTIME_ALLOWED) {
    const candidatePaths = [
      path.join(app.getAppPath(), 'env.json'),
      path.join(__dirname, '..', 'env.json'),
      path.join(__dirname, '..', '..', 'env.json'),
      path.join(app.getAppPath(), 'dist', 'env.json'),
      path.join(app.getAppPath(), 'src', 'env.json'),
    ];
    for (const envPath of candidatePaths) {
      if (fs.existsSync(envPath)) {
        const envData = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
        if (envData.MEASUREMENT_ID || envData.API_SECRET) {
          MEASUREMENT_ID = envData.MEASUREMENT_ID || '';
          API_SECRET = envData.API_SECRET || '';
          break;
        }
      }
    }
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

const store = new Store({ name: 'analytics' }) as unknown as {
  get<K extends keyof AnalyticsStoreSchema>(key: K): AnalyticsStoreSchema[K] | undefined;
  set<K extends keyof AnalyticsStoreSchema>(key: K, value: AnalyticsStoreSchema[K]): void;
};

function getStoredClientId(): string | undefined {
  let clientId = store.get('ga_client_id');
  if (!clientId) {
    try {
      const appData = app ? app.getPath('appData') : (process.env.APPDATA || '');
      const legacyPaths = [
        path.join(appData, 'tw-overlay', 'config.json'),
        path.join(appData, 'twOverlay', 'config.json'),
      ];
      for (const legacyPath of legacyPaths) {
        if (fs.existsSync(legacyPath)) {
          const content = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
          if (content && typeof content.ga_client_id === 'string' && content.ga_client_id) {
            clientId = content.ga_client_id;
            break;
          }
        }
      }
    } catch {}
  }
  return clientId;
}

/**
 * GA4 사용 통계 전송 계약입니다.
 *
 * - 패키지 앱에서만 동작하며 개발 실행과 명시적 환경 변수 비활성화에서는 전송하지 않습니다.
 * - `analyticsEnabled=false`이면 즉시 하트비트와 이후 이벤트 전송을 중지합니다.
 * - client_id는 임의 생성한 익명 식별자로 로컬 analytics 저장소에 유지되며 앱을 다시 켜도
 *   같은 값을 사용합니다. 세션 ID와 세션 번호는 재실행마다 갱신됩니다.
 * - 이벤트 이름과 파라미터는 analyticsProtocol allowlist/정규화 경계를 통과해야 하며,
 *   채팅 내용·Google 토큰·사용자 파일 원문 같은 개인정보를 파라미터로 추가하지 않습니다.
 * - 모든 이벤트에는 배포 채널(`ms_store` 또는 `github`)이 공통 파라미터로 포함됩니다.
 * - 데이터는 앱 운영자의 자체 수집 서버가 아니라 Google Analytics로 직접 전송됩니다.
 */
export class Analytics {
  private clientId: string = '';
  private sessionId: number = 0;
  private sessionNumber: number = 1;
  private initialized = false;
  
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastEngagementTime: number = Date.now();

  constructor() {
    if (!this.isTransmissionEnabled()) return;
    this.initializeSession();
  }

  /** 런타임 허용 조건과 사용자의 현재 전송 설정을 매 이벤트 직전에 함께 확인합니다. */
  private isTransmissionEnabled(): boolean {
    if (!ANALYTICS_RUNTIME_ALLOWED) return false;
    try {
      return loadConfig().analyticsEnabled !== false;
    } catch {
      return true;
    }
  }

  private initializeSession(): void {
    if (this.initialized || !this.isTransmissionEnabled()) return;

    // 1. Client ID persistence
    const savedClientId = getStoredClientId();
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
    this.initialized = true;

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

  /** 설정 변경 직후 전송/중지 상태를 반영한다. */
  public refreshEnabledState(): void {
    if (this.isTransmissionEnabled()) {
      this.initializeSession();
      this.startHeartbeat();
      return;
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  public trackEvent(eventName: string, params: Record<string, unknown> = {}): void {
    if (!this.isTransmissionEnabled()) return;
    this.initializeSession();

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
    flatParams.distribution_source = resolveDistributionSource(Boolean(process.windowsStore));
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
      // 로컬 경로·파일명 등 환경 정보가 포함될 수 있는 원문은 전송하지 않는다.
      error_kind: errorMessage ? 'runtime_error' : 'unknown_error',
    });
  }
}

export const analytics = new Analytics();
