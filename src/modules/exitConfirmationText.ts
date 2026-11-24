/** 앱 종료·업데이트 재시작 전 초안 확인의 목적.
 * - quit: 사용자의 일반 종료(트레이·창 닫기 등). 취소하면 앱을 계속 사용한다.
 * - update: 사용자가 고르거나 다운로드 완료 뒤 자동으로 시작하는 일반 업데이트 설치 재시작.
 *   취소하면 설치를 미루고 입력을 유지한다(설정의 [재시작 및 설치] 또는 다음 종료 때 설치).
 * - mandatory-update: 필수 업데이트. 저장할 기회를 한 번 안내한 뒤 취소 없이 진행한다.
 * profileEditorWindows.confirmProfileEditorsShutdown과 windowManager.confirmProfileWindowShutdown이
 * 같은 문구를 공유한다. 회귀: check-profile-windows.ts(종료), check-updater-network.ts(업데이트). */
export type ExitPurpose = 'quit' | 'update' | 'mandatory-update';

export interface ExitDialogText {
  title:string;
  /** "{창 이름} 창의 …" 뒤에 붙는 작업 중 안내 */
  busySuffix:string;
  dirtyMessage:string;
  dirtyHint:string;
  discardButton:string;
  proceedButton:string;
  unresponsiveDetail:string;
}

const QUIT_TEXT:ExitDialogText = {
  title:'TW-Overlay 종료',
  busySuffix:'작업을 마친 뒤 다시 종료해 주세요.',
  dirtyMessage:'작성 중인 내용을 버리고 종료할까요?',
  dirtyHint:'',
  discardButton:'버리고 종료',
  proceedButton:'종료',
  unresponsiveDetail:'지금 종료하면 저장하지 않은 입력을 잃을 수 있습니다.',
};

const UPDATE_TEXT:ExitDialogText = {
  title:'TW-Overlay 업데이트',
  busySuffix:'작업을 마친 뒤 업데이트를 다시 설치해 주세요.',
  dirtyMessage:'작성 중인 내용을 버리고 업데이트를 설치할까요?',
  dirtyHint:'계속 사용하면 입력을 그대로 두고 업데이트는 나중에 설치할 수 있습니다.',
  discardButton:'버리고 설치',
  proceedButton:'설치',
  unresponsiveDetail:'지금 앱을 다시 시작하면 저장하지 않은 입력을 잃을 수 있습니다.',
};

export function exitDialogText(purpose:ExitPurpose):ExitDialogText {
  return purpose==='quit' ? QUIT_TEXT : UPDATE_TEXT;
}

/** 필수 업데이트는 취소할 수 없으므로 저장할 시간을 준 뒤 진행한다는 안내만 표시한다. */
export const MANDATORY_UPDATE_RESTART_MESSAGE='필수 업데이트를 설치하기 위해 앱을 다시 시작합니다.';
export const MANDATORY_UPDATE_RESTART_BUTTON='다시 시작';
export const mandatoryUpdateSaveDetail=(labels:string):string =>
  `${labels} 창에 저장하지 않은 변경이나 진행 중인 작업이 있습니다. 필요한 내용을 저장한 뒤 [${MANDATORY_UPDATE_RESTART_BUTTON}]을 눌러 주세요.`;
