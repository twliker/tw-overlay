import {BrowserWindow,dialog} from 'electron';
import * as config from './config';
import {isProfileSettingsPage} from './profileSettingsAccess';

/** 미저장 설정은 저장/버리기/취소를 선택한다. 버리기는 새 소유자 config-data를 받은 뒤에만
 * 실행하므로 뒤이은 DB 실패/취소는 기존 초안을 보존한다. 진행 중 저장/위치 편집은 먼저 마친다.
 * 각 저장은 입력 시점 ID를 전달하며 메인에서도 확인한다. 독립 설정 5개 창도 같은 상태
 * 인터페이스로 처리한다. 회귀: check-profile-settings.ts, check-profile-settings-pages.ts. */
export function createProfileSettingsTransition() {
  let locked:BrowserWindow[]=[];
  const windows=() => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && isProfileSettingsPage(win.webContents.getURL()));
  const refresh=() => {
    let value;try {value=config.load();} catch {return false;}
    for (const win of windows()) try {win.webContents.send('config-data',value);} catch { /* 다음 열기 때 다시 읽는다. */ }
    return true;
  };
  const run=async (win:BrowserWindow,code:string):Promise<any> => {
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([win.webContents.executeJavaScript(code),new Promise((_,reject) => {
        timer=setTimeout(() => reject(new Error('설정 화면의 응답을 확인하지 못했습니다. 입력은 유지됩니다. 다시 시도해 주세요.')),10000);
      })]);
    } finally {if (timer) clearTimeout(timer);}
  };
  return {
    refresh,
    async prepare(nextId:string,operation:'select' | 'delete'):Promise<boolean> {
      for (const win of windows()) {
        try {
          const state=await run(win,'window.settingsProfileTransition?.status()');
          if (!state?.ready) throw new Error('설정 화면을 준비하고 있습니다. 잠시 후 다시 선택해 주세요.');
          if (state.profileId===nextId && operation==='select') continue;
          locked.push(win);
          const lockedState=await run(win,'window.settingsProfileTransition.lock();window.settingsProfileTransition.status()');
          if (lockedState.busy) throw new Error('설정을 저장 중입니다. 저장이 끝난 뒤 프로필을 전환해 주세요.');
          if (lockedState.editing) throw new Error('위치 편집을 저장하거나 취소한 뒤 프로필을 전환해 주세요.');
          if (!lockedState.dirty) continue;
          win.show();win.focus();
          const result=await dialog.showMessageBox(win,{type:'question',title:'프로필 전환',
            message:`‘${lockedState.name}’의 변경한 설정을 저장할까요?`,
            detail:'저장하면 현재 프로필에 반영합니다. 공통 설정은 모든 프로필에 적용됩니다.',
            buttons:['저장 후 전환','저장하지 않고 전환','취소'],defaultId:0,cancelId:2,noLink:true});
          if (result.response!==0 && result.response!==1) return false;
          if (result.response===0 && !await run(win,'window.settingsProfileTransition.save()')) {
            throw new Error('설정을 저장하지 못해 프로필을 전환하지 않았습니다. 설정 화면의 안내를 확인해 주세요.');
          }
        } catch (error) {if (win.isDestroyed()) continue;win.show();win.focus();throw error;}
      }
      return true;
    },
    async finish(_committed:boolean):Promise<void> {
      const previous=locked;locked=[];
      try {refresh();} catch { /* DB 실패와 창 잠금 해제는 별개다. */ }
      for (const win of previous) {
        if (win.isDestroyed()) continue;
        // 성공뿐 아니라 실패 중 실제로 저장된 설정도 수신한다. 같은 소유자는 기존 초안 merge를 유지한다.
        try {await run(win,'window.settingsProfileTransition?.finish()');}
        catch { /* 닫힌 창은 전환 잠금을 유지하지 않는다. */ }
      }
    },
  };
}
