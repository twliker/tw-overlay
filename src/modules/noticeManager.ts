/**
 * 기능 계약 — 버전 업데이트 공지
 *
 * - 패키지의 `assets/notice/notice.json`이 공지 내용과 공지 버전의 원본입니다. JSON에 이미지 목록이
 *   없을 때만 같은 폴더의 `notice_<번호>.*` 파일을 자연수 순서로 자동 탐색합니다.
 * - `lastNoticeVersion`과 공지 버전이 다를 때 한 번 보여 주며, 사용자가 공지를 실제로 확인한 뒤
 *   `markNoticeAsRead`를 호출해 읽음 상태를 저장합니다. 앱 버전만 올렸다고 자동 읽음 처리하지 않습니다.
 * - 리소스 누락·손상은 앱 시작을 막지 않고 공지만 생략하며 오류를 로그에 남깁니다.
 * - 릴리즈 시 package 버전과 공지 버전을 따로 확인해야 하며, 이전 사용자의 읽음 상태를 무효화하려는
 *   경우에만 공지 버전을 변경합니다.
 */
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
