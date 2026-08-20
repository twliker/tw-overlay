import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { get_RESOURCE_PATH } from './constants';
import * as config from './config';
import { log } from './logger';
import type { UpdateNoticeData } from '../shared/types';

/**
 * 단일 관리되는 최신 업데이트 공지 데이터를 로드합니다.
 */
export function getNoticeData(): UpdateNoticeData | null {
  try {
    const noticeJsonPath = get_RESOURCE_PATH('assets', 'notice', 'notice.json');
    if (!fs.existsSync(noticeJsonPath)) {
      log(`[NOTICE] 공지 데이터 파일이 존재하지 않음: ${noticeJsonPath}`);
      return null;
    }

    const rawData = fs.readFileSync(noticeJsonPath, 'utf-8');
    const parsed = JSON.parse(rawData) as UpdateNoticeData;

    // notice 폴더 내의 notice_*.png, notice_*.jpg 등의 이미지 자동 탐색 및 자연 정렬
    if (!parsed.images || parsed.images.length === 0) {
      const noticeDir = path.dirname(noticeJsonPath);
      if (fs.existsSync(noticeDir)) {
        const imageRegex = /^notice_\d+\.(png|jpg|jpeg|webp|gif)$/i;
        const foundImages = fs.readdirSync(noticeDir)
          .filter(filename => imageRegex.test(filename))
          .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
            const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
            return numA - numB;
          });
        parsed.images = foundImages;
      }
    }

    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[NOTICE] 공지 데이터 로드 실패: ${msg}`);
    return null;
  }
}

/**
 * 새 업데이트 후 1회성 공지 팝업을 표시해야 하는지 확인합니다.
 */
export function shouldShowUpdateNotice(): boolean {
  try {
    const notice = getNoticeData();
    if (!notice || !notice.version) {
      return false;
    }

    const cfg = config.load();
    const lastSeenVersion = cfg.lastNoticeVersion || '';

    // 마지막으로 확인한 공지 버전과 현재 공지 버전이 다르면 1회 노출
    return lastSeenVersion !== notice.version;
  } catch (err) {
    log(`[NOTICE] shouldShowUpdateNotice 검사 중 에러: ${err}`);
    return false;
  }
}

/**
 * 현재 공지를 읽음 처리합니다.
 */
export function markNoticeAsRead(): void {
  try {
    const notice = getNoticeData();
    const currentVersion = notice?.version || app.getVersion();
    config.save({ lastNoticeVersion: currentVersion });
    log(`[NOTICE] 공지 읽음 처리 완료: v${currentVersion}`);
  } catch (err) {
    log(`[NOTICE] 공지 읽음 처리 실패: ${err}`);
  }
}
