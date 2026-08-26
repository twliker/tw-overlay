/**
 * Google OAuth 2.0 PKCE 인증 및 안전한 토큰 관리 모듈
 */
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app, shell, safeStorage } from 'electron';
import { log } from './logger';
import { GoogleAuthTokens, GoogleUserProfile } from '../shared/types';

// Scope: 앱 전용 숨김 폴더 접근 + 유저 이메일 조회
const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const TOKEN_STORAGE_FILE = 'google_auth.enc';
const USER_PROFILE_FILE = 'google_user.json';
const MAX_LOOPBACK_BIND_ATTEMPTS = 10;
const BLOCKED_BROWSER_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6679, 6697, 10_080,
]);

let _cachedTokens: GoogleAuthTokens | null = null;
let _cachedProfile: GoogleUserProfile | null = null;
let _isLoggingIn = false;
let _cancelCurrentLogin: (() => void) | null = null;
let _onAuthInvalidated: (() => void) | null = null;
let _loginGeneration = 0;

/** Chromium/WHATWG가 네트워크 요청에서 차단하는 포트를 OAuth 루프백에 사용하지 않는다. */
export function isSafeOAuthLoopbackPort(port: number): boolean {
  return Number.isInteger(port)
    && port >= 1
    && port <= 65_535
    && !BLOCKED_BROWSER_PORTS.has(port)
    && (port < 6665 || port > 6669);
}

/** OAuth callback 페이지에 외부 문자열을 표시할 때 HTML 요소로 해석되지 않게 한다. */
export function escapeOAuthHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 토큰 무효화(만료/철회) 시 실행될 콜백 등록 */
export function setOnAuthInvalidated(callback: () => void): void {
  _onAuthInvalidated = callback;
}

/** 현재 로그인 진행 여부 */
export function isLoggingIn(): boolean {
  return _isLoggingIn;
}

/** 진행 중인 로그인 절차 취소 */
export function cancelLogin(): boolean {
  if (!_isLoggingIn || !_cancelCurrentLogin) {
    return false;
  }
  log('[GoogleAuth] 사용자에 의해 로그인이 취소되었습니다.');
  _cancelCurrentLogin();
  return true;
}

/** env.json에서 구글 OAuth 클라이언트 키 로드 */
function getGoogleCredentials(): { clientId: string; clientSecret: string } {
  try {
    const candidatePaths = [
      path.join(app.getAppPath(), 'env.json'),
      path.join(__dirname, '..', 'env.json'),
      path.join(__dirname, '..', '..', 'env.json'),
      path.join(app.getAppPath(), 'dist', 'env.json'),
      path.join(app.getAppPath(), 'src', 'env.json'),
    ];

    for (const envPath of candidatePaths) {
      if (fs.existsSync(envPath)) {
        const data = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
        const clientId = (data.GOOGLE_CLIENT_ID || data.google_client_id || data.clientId || '').trim();
        const clientSecret = (data.GOOGLE_CLIENT_SECRET || data.google_client_secret || data.clientSecret || '').trim();
        if (clientId) {
          return { clientId, clientSecret };
        }
      }
    }
  } catch (err) {
    log(`[GoogleAuth] env.json 로드 실패: ${err}`);
  }
  return { clientId: '', clientSecret: '' };
}

/** PKCE용 Code Verifier 생성 */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** PKCE용 Code Challenge 생성 (S256) */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** 토큰 저장 파일 경로 */
function getTokenStoragePath(): string {
  return path.join(app.getPath('userData'), TOKEN_STORAGE_FILE);
}

/** 프로필 캐시 파일 경로 */
function getUserProfilePath(): string {
  return path.join(app.getPath('userData'), USER_PROFILE_FILE);
}

/** 암호화 토큰 저장 */
function saveTokens(tokens: GoogleAuthTokens): void {
  _cachedTokens = { ...tokens };
  try {
    const raw = JSON.stringify(tokens);
    const filePath = getTokenStoragePath();
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(raw);
      fs.writeFileSync(filePath, encrypted);
    } else {
      // safeStorage 사용 불가 환경 폴백
      fs.writeFileSync(filePath, Buffer.from(raw, 'utf-8').toString('base64'), 'utf-8');
    }
    log('[GoogleAuth] 토큰 안전 저장 완료');
  } catch (err) {
    log(`[GoogleAuth] 토큰 저장 실패: ${err}`);
  }
}

/** 저장된 암호화 토큰 로드 */
export function loadStoredTokens(): GoogleAuthTokens | null {
  if (_cachedTokens) return _cachedTokens;

  const filePath = getTokenStoragePath();
  if (!fs.existsSync(filePath)) return null;

  try {
    const data = fs.readFileSync(filePath);
    let raw = '';
    if (safeStorage.isEncryptionAvailable()) {
      raw = safeStorage.decryptString(data);
    } else {
      raw = Buffer.from(data.toString('utf-8'), 'base64').toString('utf-8');
    }
    _cachedTokens = JSON.parse(raw);
    return _cachedTokens;
  } catch (err) {
    log(`[GoogleAuth] 토큰 로드/복호화 실패: ${err}`);
    return null;
  }
}

/** 유저 프로필 저장 */
function saveUserProfile(profile: GoogleUserProfile): void {
  _cachedProfile = { ...profile };
  try {
    fs.writeFileSync(getUserProfilePath(), JSON.stringify(profile, null, 2), 'utf-8');
  } catch (err) {
    log(`[GoogleAuth] 프로필 캐시 저장 실패: ${err}`);
  }
}

/** 유저 프로필 로드 */
export function loadStoredProfile(): GoogleUserProfile | null {
  if (_cachedProfile) return _cachedProfile;

  const filePath = getUserProfilePath();
  if (!fs.existsSync(filePath)) return null;

  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    _cachedProfile = JSON.parse(data);
    return _cachedProfile;
  } catch (err) {
    log(`[GoogleAuth] 프로필 캐시 로드 실패: ${err}`);
    return null;
  }
}

/** 로그아웃 (토큰 및 프로필 삭제) */
export function logout(): void {
  _loginGeneration++;
  if (_isLoggingIn && _cancelCurrentLogin) _cancelCurrentLogin();
  _cachedTokens = null;
  _cachedProfile = null;

  const tokenPath = getTokenStoragePath();
  if (fs.existsSync(tokenPath)) {
    try {
      fs.unlinkSync(tokenPath);
    } catch (err) {
      log(`[GoogleAuth] 토큰 파일 삭제 실패: ${err}`);
    }
  }

  const profilePath = getUserProfilePath();
  if (fs.existsSync(profilePath)) {
    try {
      fs.unlinkSync(profilePath);
    } catch (err) {
      log(`[GoogleAuth] 프로필 파일 삭제 실패: ${err}`);
    }
  }

  log('[GoogleAuth] 로그아웃 완료');
}

/** Drive 401 응답 후 refresh token을 보존한 채 access token만 강제로 갱신한다. */
export async function refreshAfterUnauthorized(): Promise<string | null> {
  const tokens = loadStoredTokens();
  if (!tokens?.refresh_token) return null;
  saveTokens({ ...tokens, access_token: '', expiry_date: 0 });
  return getValidAccessToken();
}

/** 재인증으로도 401이 지속될 때 로컬 인증과 UI 상태를 함께 무효화한다. */
export function invalidateAuth(): void {
  logout();
  if (_onAuthInvalidated) {
    try {
      _onAuthInvalidated();
    } catch (error) {
      log(`[GoogleAuth] 인증 무효화 알림 실패: ${error}`);
    }
  }
}

/** 로그인 여부 확인 */
export function isLoggedIn(): boolean {
  const tokens = loadStoredTokens();
  return !!(tokens && (tokens.access_token || tokens.refresh_token));
}

/** Access Token으로 사용자 프로필(이메일 등) 조회 */
export async function fetchUserProfile(
  accessToken: string,
  shouldAccept: () => boolean = () => true,
): Promise<GoogleUserProfile | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log(`[GoogleAuth] 프로필 조회 실패 HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { id: string; email: string; name?: string; picture?: string };
    const profile: GoogleUserProfile = {
      email: data.email,
      name: data.name,
      picture: data.picture,
    };
    if (!shouldAccept()) return null;
    saveUserProfile(profile);
    return profile;
  } catch (err) {
    log(`[GoogleAuth] 프로필 조회 에러: ${err}`);
    return null;
  }
}

let _refreshPromise: Promise<string | null> | null = null;

/** 유효한 Access Token 가져오기 (만료 시 자동 Refresh, 중복 요청 방지 락 적용) */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = loadStoredTokens();
  if (!tokens) return null;

  const now = Date.now();
  if (tokens.access_token && tokens.expiry_date && tokens.expiry_date - now > 5 * 60 * 1000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) return null;

  // 이미 다른 비동기 흐름에서 갱신 중인 경우 동일 Promise를 대기
  if (_refreshPromise) {
    return _refreshPromise;
  }

  const refreshGeneration = _loginGeneration;
  _refreshPromise = (async () => {
    try {
      const { clientId, clientSecret } = getGoogleCredentials();
      if (!clientId) {
        log('[GoogleAuth] GOOGLE_CLIENT_ID가 설정되지 않았습니다.');
        return null;
      }

      log('[GoogleAuth] Access Token 갱신 요청 중...');
      const bodyParams: Record<string, string> = {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
      };
      if (clientSecret) {
        bodyParams.client_secret = clientSecret;
      }

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(bodyParams).toString(),
        signal: AbortSignal.timeout(15000),
      });

      if (_loginGeneration !== refreshGeneration) {
        await res.body?.cancel().catch(() => undefined);
        log('[GoogleAuth] 로그아웃 또는 새 로그인 뒤 도착한 토큰 갱신 응답을 폐기합니다.');
        return null;
      }

      if (!res.ok) {
        const errText = await res.text();
        if (_loginGeneration !== refreshGeneration) {
          log('[GoogleAuth] 로그아웃 또는 새 로그인 뒤 도착한 토큰 갱신 오류를 폐기합니다.');
          return null;
        }
        log(`[GoogleAuth] 토큰 갱신 실패 (HTTP ${res.status}): ${errText}`);
        if (res.status === 400 || res.status === 401) {
          logout();
          if (_onAuthInvalidated) {
            try {
              _onAuthInvalidated();
            } catch (notifyErr) {
              log(`[GoogleAuth] _onAuthInvalidated error: ${notifyErr}`);
            }
          }
        }
        return null;
      }

      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
        token_type?: string;
        scope?: string;
      };

      if (_loginGeneration !== refreshGeneration) {
        log('[GoogleAuth] 로그아웃 또는 새 로그인 뒤 도착한 토큰 갱신 응답을 폐기합니다.');
        return null;
      }

      const updatedTokens: GoogleAuthTokens = {
        ...tokens,
        access_token: data.access_token,
        expiry_date: Date.now() + (data.expires_in || 3600) * 1000,
        token_type: data.token_type || 'Bearer',
        scope: data.scope || tokens.scope,
      };

      saveTokens(updatedTokens);
      log('[GoogleAuth] Access Token 갱신 성공');
      return updatedTokens.access_token;
    } catch (err) {
      log(`[GoogleAuth] 토큰 갱신 에러: ${err}`);
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

/** 현재 Access Token이 유효한지 확인하고 반환 */
export async function getAccessToken(): Promise<string | null> {
  const token = await getValidAccessToken();
  if (token) return token;

  const tokens = loadStoredTokens();
  return tokens?.access_token || null;
}

/** OAuth 2.0 PKCE 로그인 시작 (브라우저 오픈 및 로컬 서버 수신) */
export async function startLogin(): Promise<{ success: boolean; profile?: GoogleUserProfile; error?: string }> {
  if (_isLoggingIn) {
    return { success: false, error: '이미 로그인 절차가 진행 중입니다.' };
  }

  const { clientId, clientSecret } = getGoogleCredentials();
  if (!clientId) {
    return {
      success: false,
      error: 'Google Client ID가 설정되지 않았습니다. env.json을 확인해주세요.',
    };
  }

  _isLoggingIn = true;
  const loginGeneration = ++_loginGeneration;

  return new Promise((resolve) => {
    let server: http.Server | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let isResolved = false;

    const cleanup = () => {
      _isLoggingIn = false;
      _cancelCurrentLogin = null;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (server) {
        try {
          server.close();
        } catch {
          // ignore
        }
        server = null;
      }
    };

    const safeResolve = (res: { success: boolean; profile?: GoogleUserProfile; error?: string }) => {
      if (isResolved) return;
      isResolved = true;
      cleanup();
      resolve(res);
    };

    _cancelCurrentLogin = () => {
      if (_loginGeneration === loginGeneration) _loginGeneration++;
      safeResolve({ success: false, error: '사용자에 의해 인증이 취소되었습니다.' });
    };

    // 1. 임시 로컬 루프백 서버 생성
    server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://127.0.0.1');
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        const authCode = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');
        const callbackState = reqUrl.searchParams.get('state');

        if (callbackState !== oauthState) {
          log('[GoogleAuth] state가 일치하지 않는 OAuth 콜백을 거부합니다.');
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invalid OAuth state');
          safeResolve({ success: false, error: '유효하지 않은 Google 로그인 응답입니다.' });
          return;
        }

        if (error) {
          log(`[GoogleAuth] 인증 에러 수신: ${error}`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: #f87171;">
                <h2>❌ Google 연동이 취소되었거나 실패했습니다.</h2>
                <p>오류 내용: ${escapeOAuthHtml(error)}</p>
                <p>이 창을 닫고 TW-Overlay에서 다시 시도해 주세요.</p>
              </body>
            </html>
          `);
          safeResolve({ success: false, error: `인증 취소 또는 오류: ${error}` });
          return;
        }

        if (!authCode) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Missing code parameter');
          safeResolve({ success: false, error: '인증 코드가 누락되었습니다.' });
          return;
        }

        // 2. Auth Code -> Token 교환
        log('[GoogleAuth] Auth Code 수신, 토큰 교환 요청...');
        const tokenParams: Record<string, string> = {
          client_id: clientId,
          code: authCode,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        };
        if (clientSecret) {
          tokenParams.client_secret = clientSecret;
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(tokenParams).toString(),
          signal: AbortSignal.timeout(15000),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${errBody}`);
        }

        const tokenData = (await tokenRes.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
          token_type?: string;
          scope?: string;
        };

        const grantedScope = tokenData.scope || '';
        if (!grantedScope.includes('drive.appdata')) {
          log('[GoogleAuth] 사용자가 Google Drive(drive.appdata) 권한 체크박스를 선택하지 않았습니다.');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: #f87171;">
                <h2>⚠️ Google Drive 권한이 선택되지 않았습니다.</h2>
                <p>데이터 동기화를 위해 로그인 화면에서 <strong>Google Drive 권한 체크박스를 반드시 체크</strong>해 주셔야 합니다.</p>
                <p>이 창을 닫고 TW-Overlay에서 다시 시도해 주세요.</p>
              </body>
            </html>
          `);
          safeResolve({
            success: false,
            error: 'Google Drive 권한 체크박스가 선택되지 않았습니다. 로그인 시 권한을 체크해주세요.',
          });
          return;
        }

        const tokens: GoogleAuthTokens = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expiry_date: Date.now() + (tokenData.expires_in || 3600) * 1000,
          token_type: tokenData.token_type || 'Bearer',
          scope: tokenData.scope,
        };

        // 3. 유저 프로필 조회
        const isCurrentLogin = () => !isResolved && _loginGeneration === loginGeneration;
        if (!isCurrentLogin()) throw new Error('취소되었거나 만료된 로그인 응답입니다.');
        const profile = await fetchUserProfile(tokens.access_token, isCurrentLogin);
        if (!isCurrentLogin()) throw new Error('취소되었거나 만료된 로그인 응답입니다.');
        if (!profile) throw new Error('Google 계정 정보를 확인하지 못했습니다. 다시 시도해 주세요.');
        saveTokens(tokens);

        // 4. 브라우저 성공 화면 응답
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>TW-Overlay 구글 연동 완료</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  background: #0b0f19;
                  color: #f8fafc;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                }
                .card {
                  background: rgba(30, 41, 59, 0.7);
                  border: 1px solid rgba(255, 255, 255, 0.1);
                  padding: 40px;
                  border-radius: 16px;
                  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
                  text-align: center;
                  max-width: 420px;
                }
                h2 { color: #60a5fa; margin-top: 0; }
                p { color: #94a3b8; font-size: 15px; line-height: 1.5; }
                .email { color: #38bdf8; font-weight: bold; }
              </style>
            </head>
            <body>
              <div class="card">
                <h2>🎉 구글 계정 연동 완료!</h2>
                <p><span class="email">${escapeOAuthHtml(profile.email)}</span> 연동이 성공적으로 완료되었습니다.</p>
                <p>이제 이 브라우저 창을 닫고 <strong>TW-Overlay</strong>로 돌아가시면 됩니다.</p>
              </div>
            </body>
          </html>
        `);

        safeResolve({ success: true, profile });
      } catch (err: any) {
        const errorMessage = err?.message || String(err);
        log(`[GoogleAuth] 인증 처리 실패: ${errorMessage}`);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: #f87171;">
              <h2>❌ 인증 처리 중 오류가 발생했습니다.</h2>
              <p>${escapeOAuthHtml(errorMessage)}</p>
            </body>
          </html>
        `);
        safeResolve({ success: false, error: errorMessage });
      }
    });

    // 60초 타임아웃
    timeoutTimer = setTimeout(() => {
      log('[GoogleAuth] 로그인 타임아웃 발생 (60초 초과)');
      safeResolve({ success: false, error: '로그인 시간이 초과되었습니다 (60초).' });
    }, 60000);

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const oauthState = crypto.randomBytes(32).toString('base64url');
    let redirectUri = '';
    let bindAttempts = 0;

    // OS에 의해 임의 빈 포트를 할당하되 브라우저가 차단하는 낮은 포트는 다시 배정받는다.
    const listenForSafeLoopbackPort = () => {
      if (!server || isResolved) return;
      bindAttempts++;
      server.listen(0, '127.0.0.1', () => {
        const listeningServer = server;
        const address = listeningServer?.address();
        if (!listeningServer || !address || typeof address === 'string') {
          safeResolve({ success: false, error: '로컬 루프백 서버 포트 할당 실패' });
          return;
        }

        const port = address.port;
        if (!isSafeOAuthLoopbackPort(port)) {
          log(`[GoogleAuth] 브라우저 제한 포트 ${port}를 피해 루프백 포트를 다시 할당합니다.`);
          if (bindAttempts >= MAX_LOOPBACK_BIND_ATTEMPTS) {
            safeResolve({ success: false, error: '안전한 로컬 루프백 서버 포트를 할당하지 못했습니다.' });
            return;
          }
          listeningServer.close(() => {
            if (server === listeningServer && !isResolved) listenForSafeLoopbackPort();
          });
          return;
        }
        redirectUri = `http://127.0.0.1:${port}/callback`;

        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', SCOPES);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('state', oauthState);
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');

        log(`[GoogleAuth] 기본 브라우저에서 인증 URL 오픈: ${redirectUri}`);
        void shell.openExternal(authUrl.toString()).catch((err) => {
          log(`[GoogleAuth] 기본 브라우저 열기 실패: ${err}`);
          safeResolve({ success: false, error: 'Google 로그인 브라우저를 열지 못했습니다.' });
        });
      });
    };
    listenForSafeLoopbackPort();

    server.on('error', (err) => {
      log(`[GoogleAuth] 서버 에러: ${err}`);
      safeResolve({ success: false, error: `로컬 서버 에러: ${err.message}` });
    });
  });
}
