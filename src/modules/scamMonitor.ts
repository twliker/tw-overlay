/**
 * 기능 계약 — 로컬 사기 탐지 AI 퍼사드 (Facade)
 *
 * 실제 구현은 scam/ 하위 모듈에 분산되어 있습니다:
 * - scam/modelManager.ts — 모델/바이너리 다운로드, GPU 감지, 경로 관리
 * - scam/serverManager.ts — llama-server 프로세스 관리, LLM 호출
 * - scam/sessionManager.ts — 세션 생명주기, 폴더 감시, 분석 트리거
 * - scam/parser.ts — HTML 파싱, 프롬프트, 응답 파싱, 테스트 시나리오
 *
 * 이 파일은 기존 외부 import 호환성을 유지하기 위한 re-export 퍼사드입니다.
 *
 * - 사용자가 기능을 켜고 메신저 로그 경로를 지정한 경우에만 새 대화 세션을 로컬 분석 큐에 넣습니다.
 *   대화 원문과 모델 추론은 PC 안의 llama-server에서 처리하며 외부 분석 API나 GA로 보내지 않습니다.
 * - 모델/서버 파일 준비, 서버 프로세스, 대화 세션 감시는 서로 다른 생명주기입니다. facade의 공개 API를
 *   유지해 UI가 하위 구현을 직접 결합하거나 중복 서버를 실행하지 않게 합니다.
 * - AI 판정은 보조 경고이며 확정적인 사기 판정으로 저장하거나 자동 차단하지 않습니다. 실패·모델 없음·
 *   LLM 비활성 상태는 사용자에게 상태로 보여 주되 원본 대화 파일을 수정하지 않습니다.
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
  recoverInterruptedServerInstall,
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
