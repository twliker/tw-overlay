/**
 * Google Drive REST API v3 AppData 동기화 모듈
 */
import { log } from './logger';
import { GoogleSyncPayload } from '../shared/types';
import * as googleAuth from './googleAuth';

const SYNC_FILE_NAME = 'tw_overlay_sync.json';
const BOUNDARY = '-------tw_overlay_sync_boundary_314159265';

interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
}

/** Google Drive appDataFolder에서 동기화 파일 검색 */
export async function findSyncFile(): Promise<DriveFileMeta | null> {
  const token = await googleAuth.getValidAccessToken();
  if (!token) {
    throw new Error('Google 로그인 상태가 아닙니다.');
  }

  const query = encodeURIComponent(`name = '${SYNC_FILE_NAME}' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime,size)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
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

/** Google Drive에서 동기화 데이터 다운로드 */
export async function downloadSyncPayload(fileId: string): Promise<GoogleSyncPayload | null> {
  const token = await googleAuth.getValidAccessToken();
  if (!token) {
    throw new Error('Google 로그인 상태가 아닙니다.');
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`동기화 데이터 다운로드 실패 (HTTP ${res.status}): ${errText}`);
  }

  try {
    const payload = (await res.json()) as GoogleSyncPayload;
    return payload;
  } catch (err) {
    log(`[GoogleDriveSync] JSON 파싱 오류: ${err}`);
    return null;
  }
}

/** Google Drive에 동기화 데이터 업로드 (신규 생성 또는 기존 파일 갱신) */
export async function uploadSyncPayload(payload: GoogleSyncPayload, existingFileId?: string): Promise<string> {
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
    });

    if (!res.ok) {
      const errText = await res.text();
      // 만약 기존 파일이 드라이브에서 삭제된 경우 신규 생성으로 폴백
      if (res.status === 404) {
        log('[GoogleDriveSync] 기존 파일 404 발생 -> 신규 생성 시도');
        return uploadSyncPayload(payload);
      }
      throw new Error(`동기화 파일 갱신 실패 (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { id: string };
    log(`[GoogleDriveSync] 동기화 파일 갱신 완료: ${data.id}`);
    return data.id;
  }

  // 2. 파일이 없으면 appDataFolder에 Multipart 업로드로 신규 생성
  const meta = {
    name: SYNC_FILE_NAME,
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
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`동기화 파일 생성 실패 (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { id: string };
  log(`[GoogleDriveSync] 동기화 파일 신규 생성 완료: ${data.id}`);
  return data.id;
}
