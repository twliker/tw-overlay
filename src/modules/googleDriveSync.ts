/**
 * Google Drive REST API v3 AppData 동기화 모듈
 */
import { log } from './logger';
import { GoogleSyncPayload } from '../shared/types';
import * as googleAuth from './googleAuth';

export const LEGACY_SYNC_FILE_NAME = 'tw_overlay_sync.json';
export const SETTINGS_SYNC_FILE_NAME = 'tw_overlay_settings.json';
export const CHECKLIST_SYNC_FILE_NAME = 'tw_overlay_checklist.json';
export const META_SYNC_FILE_NAME = 'tw_overlay_sync_meta.json';
/** 기존 UI·단일 파일 마이그레이션 호환용 별칭. */
export const SYNC_FILE_NAME = LEGACY_SYNC_FILE_NAME;
const BOUNDARY = '-------tw_overlay_sync_boundary_314159265';

export interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
}

/** Google Drive appDataFolder의 모든 파일 목록 조회 (최신 수정순) */
export async function listSyncFiles(): Promise<DriveFileMeta[]> {
  const token = await googleAuth.getValidAccessToken();
  if (!token) {
    throw new Error('Google 로그인 상태가 아닙니다.');
  }

  const query = encodeURIComponent(`trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,size)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`구글 드라이브 파일 목록 조회 실패 (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { files?: DriveFileMeta[] };
  return data.files || [];
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

/** Google Drive appDataFolder에서 지정한 파일 검색 (최신 수정순) */
export async function findSyncFileByName(fileName: string): Promise<DriveFileMeta | null> {
  const token = await googleAuth.getValidAccessToken();
  if (!token) {
    throw new Error('Google 로그인 상태가 아닙니다.');
  }

  const query = encodeURIComponent(`name = '${escapeDriveQueryLiteral(fileName)}' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,size)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });

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

/** 기존 단일 동기화 파일 검색. */
export async function findSyncFile(): Promise<DriveFileMeta | null> {
  return findSyncFileByName(LEGACY_SYNC_FILE_NAME);
}

/** Google Drive에서 JSON 파일 다운로드. */
export async function downloadJsonPayload<T>(fileId: string): Promise<T | null> {
  const token = await googleAuth.getValidAccessToken();
  if (!token) {
    throw new Error('Google 로그인 상태가 아닙니다.');
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });

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

/** 기존 단일 동기화 페이로드 다운로드. */
export async function downloadSyncPayload(fileId: string): Promise<GoogleSyncPayload | null> {
  return downloadJsonPayload<GoogleSyncPayload>(fileId);
}

/** Google Drive에 지정한 JSON 파일 업로드 (신규 생성 또는 기존 파일 갱신). */
export async function uploadJsonPayload(
  fileName: string,
  payload: unknown,
  existingFileId?: string,
): Promise<string> {
  const token = await googleAuth.getValidAccessToken();
  if (!token) {
    throw new Error('Google 로그인 상태가 아닙니다.');
  }

  const payloadString = JSON.stringify(payload, null, 2);

  // 1. 기존 파일이 있으면 PATCH로 업데이트
  if (existingFileId) {
    const patchUrl = `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`;
    const res = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: payloadString,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text();
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
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${BOUNDARY}`,
    },
    body: multipartBody,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`동기화 파일 생성 실패 (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { id: string };
  log(`[GoogleDriveSync] JSON 파일 신규 생성 완료 (${fileName}): ${data.id}`);
  return data.id;
}

/** 기존 단일 동기화 페이로드 업로드. */
export async function uploadSyncPayload(payload: GoogleSyncPayload, existingFileId?: string): Promise<string> {
  return uploadJsonPayload(LEGACY_SYNC_FILE_NAME, payload, existingFileId);
}
