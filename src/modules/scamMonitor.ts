/**
 * 사기꾼 탐지 모니터 — 퍼사드 (Facade)
 *
 * 실제 구현은 scam/ 하위 모듈에 분산되어 있습니다:
 * - scam/modelManager.ts — 모델/바이너리 다운로드, GPU 감지, 경로 관리
 * - scam/serverManager.ts — llama-server 프로세스 관리, LLM 호출
 * - scam/sessionManager.ts — 세션 생명주기, 폴더 감시, 분석 트리거
 * - scam/parser.ts — HTML 파싱, 프롬프트, 응답 파싱, 테스트 시나리오
 *
 * 이 파일은 기존 외부 import 호환성을 유지하기 위한 re-export 퍼사드입니다.
 */

// 모델/경로 관련
export {
  getModelPath,
  getCurrentMsgerLogPath,
  getModelStatus,
  detectGpu,
  downloadModel,
  downloadServerBinary,
  buildGpuResultForUserChoice,
} from './scam/modelManager';

// 서버 관련
export { stopServer } from './scam/serverManager';

// 세션/상태/API 관련
export {
  start,
  stop,
  getSessionStates,
  getQueueLength,
  triggerAnalyze,
  closeSession,
  injectTestSession,
  getConstants,
} from './scam/sessionManager';

// 서버 상태 (세션 수를 포함해야 하므로 래퍼)
import { getServerStatus as _getServerStatus } from './scam/serverManager';
import { getSessionCount } from './scam/sessionManager';

export function getServerStatus() {
  return _getServerStatus(getSessionCount());
}

// getMsgerLogPath re-export (getCurrentMsgerLogPath 이외에 직접 사용하는 곳 대비)
export { getMsgerLogPath } from './scam/modelManager';
