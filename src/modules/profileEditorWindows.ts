import {BrowserWindow,dialog} from 'electron';
import {isProfileSettingsPage,profileSettingsPageLabel} from './profileSettingsAccess';
import {isProfileChecklistPage} from './profileChecklistIpc';
import {PROFILE_WINDOW_TIMEOUT_MS,runProfileWindowScript} from './profileSettingsTransition';
import {log} from './logger';
import {exitDialogText,MANDATORY_UPDATE_RESTART_BUTTON,MANDATORY_UPDATE_RESTART_MESSAGE,mandatoryUpdateSaveDetail,type ExitPurpose} from './exitConfirmationText';

/** 저장하지 않은 입력(초안)을 가질 수 있는 프로필 편집 창. object는 렌더러가 노출한
 * 상태 API(status/lock/finish)의 전역 이름이다. 프로필 전환·Google 변경 적용·앱 종료가
 * 모두 이 목록 하나로 초안을 확인한다. 새 편집 화면을 추가하면 여기와 해당 렌더러 API만 맞춘다. */
export interface ProfileEditorWindow {win:BrowserWindow;url:string;object:string;label:string}
export interface ProfileEditorStatus {
  ready?:boolean;dirty?:boolean;busy?:boolean;editing?:boolean;prompt?:boolean;uncertain?:boolean;
}

export function profileEditorWindows():ProfileEditorWindow[] {
  return BrowserWindow.getAllWindows().flatMap(win=>{
    if (win.isDestroyed()) return [];
    const url=win.webContents.getURL();
    if (isProfileSettingsPage(url)) return [{win,url,object:'window.settingsProfileTransition',label:profileSettingsPageLabel(url)}];
    if (isProfileChecklistPage(url)) return [{win,url,object:'window.profileChecklist',label:'숙제'}];
    return [];
  });
}

const blockingWork=(state:ProfileEditorStatus) => !!(state.busy || state.editing || state.prompt || state.uncertain);
const joinLabels=(editors:ProfileEditorWindow[]) => [...new Set(editors.map(editor=>`‘${editor.label}’`))].join(', ');

interface EditorInspection {locked:ProfileEditorWindow[];dirty:ProfileEditorWindow[];busy:ProfileEditorWindow[];unresponsive:ProfileEditorWindow[]}

/** 모든 편집 창에 동시에 상태를 묻고 입력을 잠근다. 모든 창이 같은 기한을 쓰므로 창 수와 무관하게
 * 최대 PROFILE_WINDOW_TIMEOUT_MS만 기다린다(창마다 차례로 기다리면 종료 요청이 수십 초 무응답이 된다). */
async function inspectProfileEditors():Promise<EditorInspection> {
  const result:EditorInspection={locked:[],dirty:[],busy:[],unresponsive:[]};
  const deadline=Date.now()+PROFILE_WINDOW_TIMEOUT_MS;
  const targets=profileEditorWindows().filter(editor=>!editor.win.isDestroyed() && !editor.win.webContents.isCrashed());
  result.locked.push(...targets);
  const states=await Promise.all(targets.map(async editor => {
    try {
      // 기한을 넘겨 실행된 응답은 입력 상태를 믿을 수 없으므로 응답 없음으로 본다.
      // 상태 API가 아직 없는(로딩 중) 화면에는 저장할 입력이 없다.
      return await runProfileWindowScript(editor.win,
        `(() => {if (Date.now()>=${deadline}) return 'expired'; if (!${editor.object}) return null; ${editor.object}.lock(); return ${editor.object}.status();})()`) as ProfileEditorStatus | 'expired' | null;
    } catch (error) {
      if (editor.win.isDestroyed()) return null;
      log(`[SHUTDOWN] ${editor.label} 창의 입력 상태를 확인하지 못했습니다: ${String(error)}`);
      return 'expired' as const;
    }
  }));
  // 분류는 창 목록 순서를 유지해 안내 문구의 창 이름 순서가 응답 순서에 따라 바뀌지 않게 한다.
  targets.forEach((editor,index) => {
    const state=states[index];
    if (editor.win.isDestroyed() || !state) return;
    if (state==='expired') result.unresponsive.push(editor);
    else if (blockingWork(state)) result.busy.push(editor);
    else if (state.dirty) result.dirty.push(editor);
  });
  return result;
}

async function unlockEditors(editors:ProfileEditorWindow[]):Promise<void> {
  await Promise.allSettled(editors.filter(editor=>!editor.win.isDestroyed())
    .map(editor=>runProfileWindowScript(editor.win,`${editor.object}?.finish()`)));
}

function revealEditor(editors:ProfileEditorWindow[]):void {
  const first=editors.find(editor=>!editor.win.isDestroyed());
  if (first) {first.win.show();first.win.focus();}
}

/** 앱 종료·업데이트 재시작 전 프로필 편집 창의 초안 확인 계약.
 * - 모든 편집 창(환경 설정 계열·고정 메모·숙제)에 동시에 묻고, 모든 창에 같은 제한 시간을 둔다.
 * - 저장 중·위치 편집·확인 대기처럼 끝나지 않은 작업이 있으면 종료를 취소하고 안내한다.
 * - 저장하지 않은 입력이 있으면 창 이름을 모아 한 번 묻고, "계속 사용"이면 입력을 그대로 둔다.
 * - 응답하지 않는 창은 입력을 잃을 수 있음을 알리고 사용자가 고른 경우에만 종료한다.
 * - 확인하는 동안 창 입력을 잠그며(lock), 종료하지 않으면 잠금을 풀어(finish) 이어서 편집할 수 있다.
 *   종료를 승인하면 잠금을 유지한 채 창이 닫힌다. 창의 beforeunload 초안 차단은 종료 승인 뒤
 *   appState.isQuitting으로만 해제되므로, 종료 승인은 반드시 이 확인을 거친다.
 * - purpose='update'는 같은 판단을 업데이트 문구로 묻는다(취소하면 설치를 미룬다).
 *   'mandatory-update'는 잠금을 풀고 해당 창을 보여 준 뒤 저장할 기회를 한 번 안내하고 취소 없이 진행한다.
 * next는 이 확인을 통과한 뒤 이어서 실행할 확인(프로필 관리 창)이며 false면 잠금을 풀고 취소한다.
 * 대화상자 오류 등 예외는 잠금을 푼 뒤 호출자에게 전파하며, 호출자가 종료 게이트를 되돌려야 한다.
 * 회귀: check-profile-windows.ts(실제 종료), check-audit-regressions.ts(동시 조회·업데이트 문구). */
export async function confirmProfileEditorsShutdown(next:()=>Promise<boolean>,purpose:ExitPurpose='quit'):Promise<boolean> {
  let locked:ProfileEditorWindow[]=[];
  let approved=false;
  try {
    const inspection=await inspectProfileEditors();
    const {dirty,busy,unresponsive}=inspection;
    locked=inspection.locked;
    if (purpose==='mandatory-update') {
      const pending=[...busy,...dirty,...unresponsive];
      if (pending.length) {
        // 필수 업데이트는 취소할 수 없으므로 입력 잠금을 풀어 저장할 수 있게 한 뒤 한 번만 안내한다.
        await unlockEditors(locked);locked=[];
        revealEditor(pending);
        await dialog.showMessageBox({type:'warning',title:exitDialogText(purpose).title,
          message:MANDATORY_UPDATE_RESTART_MESSAGE,detail:mandatoryUpdateSaveDetail(joinLabels(pending)),
          buttons:[MANDATORY_UPDATE_RESTART_BUTTON],defaultId:0,cancelId:0});
      }
      await next();
      approved=true;
      return true;
    }
    const text=exitDialogText(purpose);
    if (busy.length) {
      // 업데이트 재시작은 잠금 화면이 다른 창을 숨긴 상태일 수 있어 작업 중인 창을 다시 보여 준다.
      if (purpose!=='quit') revealEditor(busy);
      await dialog.showMessageBox({type:'info',title:text.title,
        message:`${joinLabels(busy)} 창의 ${text.busySuffix}`,
        detail:'저장 중이거나 위치 편집·확인 중인 작업이 있습니다. 입력은 그대로 유지했습니다.',
        buttons:['확인'],defaultId:0,cancelId:0});
      return false;
    }
    if (dirty.length) {
      const answer=await dialog.showMessageBox({type:'question',title:text.title,
        message:text.dirtyMessage,
        detail:[`${joinLabels(dirty)} 창에 저장하지 않은 변경이 있습니다.`,text.dirtyHint].filter(Boolean).join('\n'),
        buttons:['계속 사용',text.discardButton],defaultId:0,cancelId:0});
      if (answer.response!==1) {
        revealEditor(dirty);
        return false;
      }
    }
    if (unresponsive.length) {
      const answer=await dialog.showMessageBox({type:'warning',title:text.title,
        message:`${joinLabels(unresponsive)} 창이 응답하지 않습니다.`,
        detail:text.unresponsiveDetail,
        buttons:['계속 사용',text.proceedButton],defaultId:0,cancelId:0});
      if (answer.response!==1) return false;
    }
    approved=await next();
    return approved;
  } finally {
    if (!approved) await unlockEditors(locked);
  }
}

/** 승인한 종료·업데이트가 실제로 진행되지 않았을 때(설치 실패 등) 확인 중 걸어 둔 입력 잠금을 푼다. */
export async function releaseProfileEditorsAfterCancelledExit():Promise<void> {
  await unlockEditors(profileEditorWindows());
}
