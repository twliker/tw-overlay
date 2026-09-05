/**
 * Google Drive AppData 동기화. 목록·신규 파일은 v3, ETag 조건부 갱신은 v2 리소스를 사용한다.
 */
import { log } from './logger';
import * as googleAuth from './googleAuth';

export const SETTINGS_SYNC_FILE_NAME = 'tw_overlay_settings.json';
export const CHECKLIST_SYNC_FILE_NAME = 'tw_overlay_checklist.json';
export const META_SYNC_FILE_NAME = 'tw_overlay_sync_meta.json';
const BOUNDARY = '-------tw_overlay_sync_boundary_314159265';
let requestController = new AbortController();

export function cancelPendingRequests(): void {
  requestController.abort();
  requestController = new AbortController();
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await googleAuth.getValidAccessToken();
  if (!token) throw new Error('Google 로그인 상태가 아닙니다.');

  const execute = (accessToken: string) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(15000)]),
    });
  };

  let response = await execute(token);
  if (response.status !== 401) return response;
  await response.body?.cancel().catch(() => undefined);
  token = await googleAuth.refreshAfterUnauthorized();
  if (!token) {
    googleAuth.invalidateAuth();
    throw new Error('Google 인증이 만료되었습니다. 다시 로그인해 주세요.');
  }
  response = await execute(token);
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    googleAuth.invalidateAuth();
    throw new Error('Google 인증이 만료되었습니다. 다시 로그인해 주세요.');
  }
  return response;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
  version?: string;
  md5Checksum?: string;
  etag?: string;
}

export class DriveWriteConflictError extends Error {
  constructor() {
    super('다른 PC가 동기화 파일을 변경했습니다. 최신 데이터를 다시 병합합니다.');
    this.name = 'DriveWriteConflictError';
  }
}

/** v2 File의 명시적 ETag를 읽는다. 반드시 병합할 본문을 읽기 전에 캡처한다. */
export async function getFileEtag(fileId: string): Promise<string> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v2/files/${encodeURIComponent(fileId)}?fields=etag`);
  if (response.status === 404) throw new DriveWriteConflictError();
  if (!response.ok) throw new Error(`동기화 파일 버전 조회 실패 (HTTP ${response.status})`);
  const data = await response.json() as { etag?: unknown };
  if (typeof data.etag !== 'string' || !data.etag) throw new Error('동기화 파일의 ETag가 없어 안전하게 저장할 수 없습니다.');
  return data.etag;
}

/** Google Drive appDataFolder의 모든 파일 목록 조회 (최신 수정순) */
export async function listSyncFiles(): Promise<DriveFileMeta[]> {
  const files: DriveFileMeta[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: 'trashed = false',
      orderBy: 'modifiedTime desc',
      fields: 'nextPageToken,files(id,name,modifiedTime,size,version,md5Checksum)',
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const res = await driveFetch(url);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`구글 드라이브 파일 목록 조회 실패 (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { files?: DriveFileMeta[]; nextPageToken?: string };
    files.push(...(data.files || []));
    const nextPageToken = typeof data.nextPageToken === 'string' && data.nextPageToken.length > 0
      ? data.nextPageToken : undefined;
    if (nextPageToken && seenPageTokens.has(nextPageToken)) {
      throw new Error('구글 드라이브 파일 목록이 같은 페이지 토큰을 반복했습니다.');
    }
    if (nextPageToken) seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  } while (pageToken);

  return files;
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

/** Google Drive appDataFolder에서 지정한 파일 검색 (최신 수정순) */
export async function findSyncFileByName(fileName: string): Promise<DriveFileMeta | null> {
  const query = encodeURIComponent(`name = '${escapeDriveQueryLiteral(fileName)}' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,size,version,md5Checksum)`;

  const res = await driveFetch(url);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`구글 드라이브 파일 검색 실패 (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { files?: DriveFileMeta[] };
  if (data.files && data.files.length > 0) {
    return data.files[0];
  }
  return null;
}

/** Google Drive에서 JSON 파일 다운로드. */
export async function downloadJsonPayload<T>(fileId: string): Promise<T | null> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await driveFetch(url);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`동기화 데이터 다운로드 실패 (HTTP ${res.status}): ${errText}`);
  }

  try {
    const payload = (await res.json()) as T;
    return payload;
  } catch (err) {
    log(`[GoogleDriveSync] JSON 파싱 오류: ${err}`);
    return null;
  }
}

/** Google Drive에 지정한 JSON 파일 업로드 (신규 생성 또는 기존 파일 갱신). */
export async function uploadJsonPayload(
  fileName: string,
  payload: unknown,
  existingFileId?: string,
  expectedEtag?: string,
): Promise<string> {
  const payloadString = JSON.stringify(payload, null, 2);

  // 1. 기존 파일이 있으면 PATCH로 업데이트
  if (existingFileId) {
    // ETag를 얻은 v2 리소스에 조건부 갱신한다. 충돌/삭제 시 무조건 덮어쓰기나 신규 생성으로 우회하지 않는다.
    const patchUrl = expectedEtag
      ? `https://www.googleapis.com/upload/drive/v2/files/${existingFileId}?uploadType=media`
      : `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`;
    const res = await driveFetch(patchUrl, {
      method: expectedEtag ? 'PUT' : 'PATCH',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        ...(expectedEtag ? { 'If-Match': expectedEtag } : {}),
      },
      body: payloadString,
    });

    if (!res.ok) {
      const errText = await res.text();
      if (expectedEtag && (res.status === 412 || res.status === 404)) throw new DriveWriteConflictError();
      // 만약 기존 파일이 드라이브에서 삭제된 경우 신규 생성으로 폴백
      if (res.status === 404) {
        log(`[GoogleDriveSync] 기존 파일 404 발생 (${fileName}) -> 신규 생성 시도`);
        return uploadJsonPayload(fileName, payload);
      }
      throw new Error(`동기화 파일 갱신 실패 (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { id: string };
    log(`[GoogleDriveSync] JSON 파일 갱신 완료 (${fileName}): ${data.id}`);
    return data.id;
  }

  // 2. 파일이 없으면 appDataFolder에 Multipart 업로드로 신규 생성
  const meta = {
    name: fileName,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  };

  const multipartBody = [
    `--${BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(meta),
    `--${BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    payloadString,
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');

  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const res = await driveFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${BOUNDARY}`,
    },
    body: multipartBody,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`동기화 파일 생성 실패 (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { id: string };
  log(`[GoogleDriveSync] JSON 파일 신규 생성 완료 (${fileName}): ${data.id}`);
  return data.id;
}
