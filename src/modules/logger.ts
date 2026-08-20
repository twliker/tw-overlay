/**
 * 로깅 모듈 - 파일 로그 + 콘솔 출력
 * 로그 파일 크기 제한(1MB)과 자동 로테이션 포함
 * 성능: 비동기 I/O 사용 + 크기 체크 횟수 기반 최적화
 */
import * as fs from 'fs';
import { get_LOG_PATH, LOG_MAX_SIZE, IS_DEV } from './constants';

/** 로그 크기 체크 간격 (매번 체크하지 않고 N회마다) */
const SIZE_CHECK_INTERVAL = 100;
let writeCount = 0;
let isRotating = false;

export function log(message: string, forceInProd: boolean = false): void {
  const envString = IS_DEV ? 'DEV' : 'PROD';
  const timestamp = new Date().toISOString();

  // 개발 환경에서는 콘솔에 항상 출력
  if (IS_DEV) {
    console.log(`[${timestamp}][${envString}] ${message}`);
  }

  // 프로덕션 환경(실제 빌드)에서는 에러 및 예외 로그만 파일에 기록
  if (!IS_DEV && !forceInProd) {
    const isError = /(fail|error|err|실패|오류|critical|exception|fatal)/i.test(message);
    if (!isError) {
      return; // 에러가 아니면 파일에 쓰지 않음
    }
  }

  const logMessage = `[${timestamp}][${envString}] ${message}\n`;

  try {
    const logPath = get_LOG_PATH();

    // 매 SIZE_CHECK_INTERVAL 회마다만 크기 체크 (비동기로 통일)
    if (writeCount % SIZE_CHECK_INTERVAL === 0 && !isRotating) {
      isRotating = true;
      fs.stat(logPath, (err, stats) => {
        if (!err && stats.size > LOG_MAX_SIZE) {
          const backupPath = logPath.replace('.log', '.old.log');
          fs.unlink(backupPath, () => {
            fs.rename(logPath, backupPath, () => {
              isRotating = false;
            });
          });
        } else {
          isRotating = false;
        }
      });
    }
    writeCount++;

    // 비동기 쓰기로 메인 프로세스 블로킹 방지
    fs.appendFile(logPath, logMessage, () => { /* fire-and-forget */ });
  } catch { /* 로깅 실패는 조용히 무시 */ }
}
