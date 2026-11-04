import {BrowserWindow} from 'electron';
import {isProfileToolPage} from './profileToolsIpc';

/** 전환 commit 전에 실제 도구 창의 입력을 원래 프로필에 저장한다.
 * 로딩·편집 대화상자·DB 실패는 전환을 막고 입력을 남긴다. 확인 중 새 입력도 잠근다.
 * 성공/취소/rollback 모두 finish를 호출해 잠금을 해제한다. 회귀: check-profile-tools.ts.
 */
export function createProfileToolTransition(options?:{showFailure?:boolean}):{prepare(nextProfileId:string,operation:'select' | 'delete'):Promise<boolean>;finish(committed:boolean):Promise<void>} {
  let locked:BrowserWindow[]=[];
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
        locked.push(win);
        try {
          const result=await run(win,`window.profileToolStorage?.profileId()===${JSON.stringify(nextProfileId)} && ${operation==='select'}
            ? {success:true} : window.profileToolStorage?.prepareTransition()`);
          if (!result?.success) throw new Error(result?.error || '계산기를 준비하고 있습니다. 잠시 후 다시 선택해 주세요.');
        } catch (error) {
          if (win.isDestroyed()) continue;
          if(options?.showFailure!==false) {win.show();win.focus();}throw error;
        }
      }
      return true;
    },
    async finish(committed) {
      const previous=locked;locked=[];
      for (const win of previous) {
        if (!win.isDestroyed()) try {await run(win,`window.profileToolStorage?.finishTransition(${committed})`);} catch { /* 닫힘/새 페이지는 잠금을 소유하지 않는다. */ }
      }
    },
  };
}
