import {BrowserWindow} from 'electron';
import {randomUUID} from 'node:crypto';
import {isProfileToolPage} from './profileToolsIpc';

/** 동기화 반영(purpose 'sync') 준비 중 계산기 창에 작성 중인 입력이 있거나 창이 응답하지 않을 때.
 * 프로필 전환 실패와 구분해 호출자가 반영만 미루거나 동기화에 맞는 안내를 쓰게 한다. editor: 사용자에게 보일 창 이름. */
export class ProfileToolBusyError extends Error {
  constructor(readonly editor:string) {
    super(`${editor}에서 작성 중인 내용을 저장하거나 취소한 뒤 다시 시도해 주세요. 입력은 그대로 유지했습니다.`);
    this.name='ProfileToolBusyError';
  }
}
const toolLabel=(url:string):string=>/\/buffs\.html$/.test(url.split(/[?#]/)[0]) ? '버프 백과' : '계수 계산기';

/** 전환 commit 전에 실제 도구 창의 입력을 원래 프로필에 저장한다.
 * 로딩·편집 대화상자·DB 실패는 전환을 막고 입력을 남긴다. 확인 중 새 입력도 잠근다.
 * 성공/취소/rollback 모두 finish를 호출해 잠금을 해제한다. 회귀: check-profile-tools.ts.
 * purpose 'sync'(Google 변경 반영)는 같은 잠금·저장을 쓰되 계산기 창에 "프로필을 전환해 주세요" 안내를 남기지 않고
 * 실패를 ProfileToolBusyError로 알린다. 사용자가 프로필을 전환한 것이 아니기 때문이다.
 */
export function createProfileToolTransition(options?:{showFailure?:boolean;purpose?:'switch' | 'sync'}):{prepare(nextProfileId:string,operation:'select' | 'delete'):Promise<boolean>;finish(committed:boolean):Promise<void>} {
  let locked:Array<{win:BrowserWindow;token:string}>=[];
  const purpose=options?.purpose ?? 'switch';
  const run=async (win:BrowserWindow,code:string):Promise<any> => {
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([win.webContents.executeJavaScript(code),new Promise((_,reject) => {
        timer=setTimeout(() => reject(new Error('계산기 입력을 확인하지 못했습니다. 창을 확인한 뒤 다시 선택해 주세요.')),5000);
      })]);
    } finally {if (timer) clearTimeout(timer);}
  };
  return {
    async prepare(nextProfileId,operation) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || !isProfileToolPage(win.webContents.getURL())) continue;
        const token=JSON.stringify(randomUUID());
        const expiresAt=Date.now()+5000;
        locked.push({win,token});
        try {
          const result=await run(win,`window.profileToolStorage?.profileId()===${JSON.stringify(nextProfileId)} && ${operation==='select'}
            ? {success:true} : window.profileToolStorage?.prepareTransition(${token},${expiresAt},${JSON.stringify(purpose)})`);
          if (!result?.success) throw new Error(result?.error || '계산기를 준비하고 있습니다. 잠시 후 다시 선택해 주세요.');
        } catch (error) {
          if (win.isDestroyed()) continue;
          if(options?.showFailure!==false) {win.show();win.focus();}
          throw purpose==='sync' ? new ProfileToolBusyError(toolLabel(win.webContents.getURL())) : error;
        }
      }
      return true;
    },
    async finish(committed) {
      const previous=locked;locked=[];
      for (const {win,token} of previous) {
        if (!win.isDestroyed()) try {await run(win,`window.profileToolStorage?.finishTransition(${token},${committed})`);} catch { /* 닫힘/새 페이지는 잠금을 소유하지 않는다. */ }
      }
    },
  };
}
