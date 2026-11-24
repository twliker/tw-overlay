import {BrowserWindow,dialog} from 'electron';
import * as config from './config';
import {isProfileChecklistPage} from './profileChecklistIpc';

/** 편집 초안의 버리기는 실제 새 소유자 수신 뒤에만 수행한다. 실패/취소는 원래 입력을 남긴다.
 * 완료 체크/추가 저장 중 또는 응답 미확인 상태는 먼저 끝내야 하며 횟수 입력창도 보존한다.
 * 회귀: check-profile-checklist.ts의 실제 제품 창/IPC/DB. */
export function createProfileChecklistTransition() {
  let locked:BrowserWindow[]=[];
  const windows=() => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && isProfileChecklistPage(win.webContents.getURL()));
  const refresh=() => {
    let value;try {value=config.load();} catch {return false;}
    for (const win of windows()) try {win.webContents.send('config-data',value);} catch { /* 닫힌 창은 다음 열기 때 읽는다. */ }
    return true;
  };
  const run=async (win:BrowserWindow,code:string):Promise<any> => {
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {return await Promise.race([win.webContents.executeJavaScript(code),new Promise((_,reject) => {
      timer=setTimeout(() => reject(new Error('숙제 화면의 응답을 확인하지 못했습니다. 입력은 유지됩니다. 다시 시도해 주세요.')),10000);
    })]);} finally {if (timer) clearTimeout(timer);}
  };
  return {refresh,
    async prepare(nextId:string,operation:'select' | 'delete'):Promise<boolean> {
      for (const win of windows()) try {
        const state=await run(win,'window.profileChecklist?.status()');
        if (!state?.ready) throw new Error('숙제 화면을 준비하고 있습니다. 잠시 후 다시 선택해 주세요.');
        if (state.profileId===nextId && operation==='select') continue;
        locked.push(win);
        const current=await run(win,'window.profileChecklist.lock();window.profileChecklist.status()');
        if (current.busy) throw new Error('숙제를 저장 중입니다. 저장이 끝난 뒤 프로필을 전환해 주세요.');
        if (current.uncertain) throw new Error('숙제 저장 결과를 먼저 다시 확인해 주세요. 입력은 유지됩니다.');
        if (current.prompt) throw new Error('숙제의 횟수나 이름 입력을 완료하거나 취소한 뒤 프로필을 전환해 주세요.');
        if (!current.dirty) continue;
        win.show();win.focus();
        const result=await dialog.showMessageBox(win,{type:'question',title:'프로필 전환',message:`‘${current.name}’의 편집 중인 숙제를 저장할까요?`,
          detail:'저장하면 현재 프로필의 숙제에 반영합니다.',buttons:['저장 후 전환','저장하지 않고 전환','취소'],defaultId:0,cancelId:2,noLink:true});
        if (result.response!==0 && result.response!==1) return false;
        if (result.response===0 && !await run(win,'window.profileChecklist.submitEditor(true)')) throw new Error('숙제를 저장하지 못해 프로필을 전환하지 않았습니다. 입력 내용을 확인해 주세요.');
      } catch (error) {if (win.isDestroyed()) continue;win.show();win.focus();throw error;}
      return true;
    },
    async finish(_committed:boolean):Promise<void> {
      const previous=locked;locked=[];refresh();
      for (const win of previous) if (!win.isDestroyed()) try {await run(win,'window.profileChecklist?.finish()');} catch { /* 닫힌 페이지 */ }
    },
  };
}
