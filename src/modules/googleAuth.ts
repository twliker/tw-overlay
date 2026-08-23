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

let _cachedTokens: GoogleAuthTokens | null = null;
let _cachedProfile: GoogleUserProfile | null = null;
let _isLoggingIn = false;

/** env.json에서 구글 OAuth 클라이언트 키 로드 */
function getGoogleCredentials(): { clientId: string; clientSecret: string } {
  try {
    let envPath = path.join(__dirname, '..', 'env.json');
    if (!fs.existsSync(envPath)) {
      envPath = path.join(app.getAppPath(), 'dist', 'env.json');
    }
    if (!fs.existsSync(envPath)) {
      envPath = path.join(app.getAppPath(), 'src', 'env.json');
    }

    if (fs.existsSync(envPath)) {
      const data = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
      return {
        clientId: (data.GOOGLE_CLIENT_ID || '').trim(),
        clientSecret: (data.GOOGLE_CLIENT_SECRET || '').trim(),
      };
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
    log('[GoogleAuth] 토큰이 안전하게 저장되었습니다.');
  } catch (err) {
    log(`[GoogleAuth] 토큰 저장 실패: ${err}`);
  }
}

/** 토큰 로드 */
function loadStoredTokens(): GoogleAuthTokens | null {
  if (_cachedTokens) return _cachedTokens;
  try {
    const filePath = getTokenStoragePath();
    if (!fs.existsSync(filePath)) return null;

    const data = fs.readFileSync(filePath);
    let raw = '';
    if (safeStorage.isEncryptionAvailable()) {
      try {
        raw = safeStorage.decryptString(data);
      } catch {
        // 복호화 실패 시 평문/Base64 시도
        raw = Buffer.from(data.toString('utf-8'), 'base64').toString('utf-8');
      }
    } else {
      raw = Buffer.from(data.toString('utf-8'), 'base64').toString('utf-8');
    }

    if (raw) {
      _cachedTokens = JSON.parse(raw) as GoogleAuthTokens;
      return _cachedTokens;
    }
  } catch (err) {
    log(`[GoogleAuth] 토큰 로드 실패: ${err}`);
  }
  return null;
}

/** 프로필 저장 */
function saveUserProfile(profile: GoogleUserProfile): void {
  _cachedProfile = { ...profile };
  try {
    fs.writeFileSync(getUserProfilePath(), JSON.stringify(profile, null, 2), 'utf-8');
  } catch (err) {
    log(`[GoogleAuth] 프로필 저장 실패: ${err}`);
  }
}

/** 프로필 로드 */
export function loadStoredProfile(): GoogleUserProfile | null {
  if (_cachedProfile) return _cachedProfile;
  try {
    const filePath = getUserProfilePath();
    if (fs.existsSync(filePath)) {
      _cachedProfile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return _cachedProfile;
    }
  } catch (err) {
    log(`[GoogleAuth] 프로필 로드 실패: ${err}`);
  }
  return null;
}

/** 토큰 및 프로필 삭제 (로그아웃) */
export function logout(): void {
  _cachedTokens = null;
  _cachedProfile = null;
  try {
    const tokenPath = getTokenStoragePath();
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    const profilePath = getUserProfilePath();
    if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
    log('[GoogleAuth] 구글 로그아웃 완료.');
  } catch (err) {
    log(`[GoogleAuth] 로그아웃 파일 삭제 오류: ${err}`);
  }
}

/** 로그인 상태 확인 */
export function isLoggedIn(): boolean {
  const tokens = loadStoredTokens();
  return !!(tokens && (tokens.refresh_token || tokens.access_token));
}

/** 구글 유저 정보 조회 API */
async function fetchUserProfile(accessToken: string): Promise<GoogleUserProfile | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Userinfo HTTP error ${res.status}`);
    }
    const data = (await res.json()) as { email: string; name?: string; picture?: string };
    const profile: GoogleUserProfile = {
      email: data.email || '',
      name: data.name,
      picture: data.picture,
    };
    saveUserProfile(profile);
    return profile;
  } catch (err) {
    log(`[GoogleAuth] 유저 프로필 조회 실패: ${err}`);
    return null;
  }
}

/** 토큰 갱신 */
export async function refreshAccessTokenIfNeeded(): Promise<string | null> {
  const tokens = loadStoredTokens();
  if (!tokens || !tokens.refresh_token) {
    return null;
  }

  // 만료 시간 5분 이상 남았으면 기존 access_token 사용
  const now = Date.now();
  if (tokens.access_token && tokens.expiry_date && tokens.expiry_date - now > 5 * 60 * 1000) {
    return tokens.access_token;
  }

  const { clientId, clientSecret } = getGoogleCredentials();
  if (!clientId) {
    log('[GoogleAuth] GOOGLE_CLIENT_ID가 설정되지 않았습니다.');
    return null;
  }

  try {
    log('[GoogleAuth] Access Token 갱신 요청 중...');
    const bodyParams: Record<string, string> = {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    };
    if (clientSecret) {
      bodyParams.client_secret = clientSecret;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(bodyParams).toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      log(`[GoogleAuth] 토큰 갱신 실패 (HTTP ${res.status}): ${errText}`);
      // Refresh token이 만료되었거나 무효화된 경우
      if (res.status === 400 || res.status === 401) {
        logout();
      }
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type?: string;
      scope?: string;
    };

    const newTokens: GoogleAuthTokens = {
      ...tokens,
      access_token: data.access_token,
      expiry_date: Date.now() + (data.expires_in || 3600) * 1000,
      token_type: data.token_type || 'Bearer',
      scope: data.scope || tokens.scope,
    };

    saveTokens(newTokens);
    log('[GoogleAuth] Access Token 갱신 성공!');
    return newTokens.access_token;
  } catch (err) {
    log(`[GoogleAuth] 토큰 갱신 네트워크 에러: ${err}`);
    return null;
  }
}

/** 유효한 Access Token 반환 */
export async function getValidAccessToken(): Promise<string | null> {
  const token = await refreshAccessTokenIfNeeded();
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

  return new Promise((resolve) => {
    let server: http.Server | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      _isLoggingIn = false;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    // 1. 임시 로컬 루프백 서버 생성
    server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', `http://${req.headers.host}`);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        const authCode = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');

        if (error) {
          log(`[GoogleAuth] 인증 에러 수신: ${error}`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: #f87171;">
                <h2>❌ Google 연동이 취소되었거나 실패했습니다.</h2>
                <p>오류 내용: ${error}</p>
                <p>이 창을 닫고 TW-Overlay에서 다시 시도해 주세요.</p>
              </body>
            </html>
          `);
          cleanup();
          resolve({ success: false, error: `인증 취소 또는 오류: ${error}` });
          return;
        }

        if (!authCode) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Missing code parameter');
          cleanup();
          resolve({ success: false, error: '인증 코드가 누락되었습니다.' });
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

        const tokens: GoogleAuthTokens = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expiry_date: Date.now() + (tokenData.expires_in || 3600) * 1000,
          token_type: tokenData.token_type || 'Bearer',
          scope: tokenData.scope,
        };

        saveTokens(tokens);

        // 3. 유저 프로필 조회
        const profile = await fetchUserProfile(tokens.access_token);

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
                <p><span class="email">${profile?.email || '계정'}</span> 연동이 성공적으로 완료되었습니다.</p>
                <p>이제 이 브라우저 창을 닫고 <strong>TW-Overlay</strong>로 돌아가시면 됩니다.</p>
              </div>
            </body>
          </html>
        `);

        cleanup();
        resolve({ success: true, profile: profile || undefined });
      } catch (err: any) {
        log(`[GoogleAuth] 인증 처리 실패: ${err.message || err}`);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: #f87171;">
              <h2>❌ 인증 처리 중 오류가 발생했습니다.</h2>
              <p>${err.message || err}</p>
            </body>
          </html>
        `);
        cleanup();
        resolve({ success: false, error: err.message || String(err) });
      }
    });

    // 2분 타임아웃
    timeoutTimer = setTimeout(() => {
      log('[GoogleAuth] 로그인 타임아웃 발생 (2분 초과)');
      cleanup();
      resolve({ success: false, error: '로그인 시간이 초과되었습니다 (2분).' });
    }, 120000);

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    let redirectUri = '';

    // OS에 의해 임의 빈 포트 자동 할당
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address === 'string') {
        cleanup();
        resolve({ success: false, error: '로컬 루프백 서버 포트 할당 실패' });
        return;
      }

      const port = address.port;
      redirectUri = `http://127.0.0.1:${port}/callback`;

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPES);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      log(`[GoogleAuth] 기본 브라우저에서 인증 URL 오픈: ${redirectUri}`);
      shell.openExternal(authUrl.toString());
    });

    server.on('error', (err) => {
      log(`[GoogleAuth] 서버 에러: ${err}`);
      cleanup();
      resolve({ success: false, error: `로컬 서버 에러: ${err.message}` });
    });
  });
}
