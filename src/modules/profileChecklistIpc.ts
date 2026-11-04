import {ipcMain} from 'electron';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {getProfileRuntime} from './profileRuntime';
import * as config from './config';
import * as contents from './contentsChecker';
import {collectRecordEffects} from './recordEffects';
import {isProfileChecklistRequest,type ProfileChecklistResult} from '../shared/profileChecklist';
import {log} from './logger';

const page=pathToFileURL(path.resolve(__dirname,'..','contents-checker.html')).href;
export const isProfileChecklistPage=(url:string) => url.split(/[?#]/)[0]===page;
let registered=false;
/** 수동 숙제는 입력 당시 프로필과 결과를 확인한다. 설정·일지·요약·요청 ACK를 같은 DB commit에
 * 확정하고 실패는 모두 rollback한다. 확인 중 전환은 UI에서 막고 늦은 이전 ID도 메인에서 거부한다.
 * 완료된 요청 ID는 재적용하지 않는다. manual 세션은 enqueue+ACK가 원자적이므로 선택 대기에 남지 않는다.
 * 기존 캐릭터 CRUD는 프로필 관리로 대체한다. 회귀: check-profile-checklist.ts.
 */
export function registerProfileChecklistIpc():void {
  if (registered) return;registered=true;
  ipcMain.handle('profile-checklist-mutate',(event,input:unknown):ProfileChecklistResult => {
    const runtime=getProfileRuntime();if (!runtime) return {success:false,error:'프로필 기능을 준비하고 있습니다.'};
    if (event.senderFrame!==event.sender.mainFrame || !isProfileChecklistPage(event.senderFrame?.url || '') || !isProfileChecklistRequest(input)) {
      return {success:false,error:'숙제 입력 내용을 확인해 주세요.'};
    }
    const request=input,store=runtime.service.store;
    try {
      const status=runtime.service.status();
      if (runtime.service.isHistoricalRestoreActive()) throw new Error('과거 로그 복원 중입니다. 완료 후 숙제를 수정해 주세요.');
      if (runtime.service.isStorageMaintenanceActive()) throw new Error('데이터를 복구 중입니다. 완료 후 숙제를 수정해 주세요.');
      if (request.profileId!==status.activeProfileId) throw new Error('프로필이 바뀌어 저장하지 않았습니다. 입력 프로필을 확인해 주세요.');
      const characterIndex=request.kind==='toggleItem' || request.kind==='updateItemCount' || request.kind==='toggleExcludeItem' ? 1 : request.kind==='applyPendingHomeworks' ? 0 : -1;
      const character=(request.args as readonly unknown[])[characterIndex];
      if (characterIndex>=0 && character!==undefined && character!==request.profileId) throw new Error('현재 프로필의 숙제만 변경할 수 있습니다.');
      if (!config.flushPending()) throw new Error('대기 중인 설정을 저장하지 못했습니다.');
      let effects:() => void=() => {};
      store.database.transaction(() => {
        const session=`manual-checklist:${request.requestId}`;
        store.enqueue(session,{kind:'profile-checklist-mutation',version:1,request},request.createdAt,request.requestId);
        effects=collectRecordEffects(() => config.withConfirmedWrites(() => store.withRecordContext(request.profileId,status.sessionId,() => {
          store.assignPending(session,request.profileId,() => {
            if (request.kind==='addCustomItem') {contents.addCustomItem(request.args[0],request.args[1],request.args[2],request.args[3],`custom-${request.requestId}`);return;}
            const existingItemActions=['toggleItem','updateItemCount','toggleExcludeItem','toggleVisibility','updateCategory','updateName','updateItem','moveItem','reorderItem'];
            if(existingItemActions.includes(request.kind)) {
              const items=config.load().contentsCheckerItems || [],ids=request.kind==='reorderItem' ? request.args.slice(0,2) : request.args.slice(0,1);
              if(ids.some(id=>!items.some(item=>item.id===id))) throw new Error('다른 화면이나 PC에서 이 숙제가 삭제되었습니다. 입력은 유지했습니다. 새 숙제로 추가하거나 편집을 취소해 주세요.');
            }
            const action=contents[request.kind] as (...args:any[]) => unknown;
            action(...request.args);
          });
        })),true);
      })();
      try {effects();} catch (error) {log(`[PROFILE] 숙제 저장 후 화면 갱신 실패: ${String(error)}`);}
      const value=config.load();
      return {success:true,config:value,itemId:request.kind==='addCustomItem' ? `custom-${request.requestId}` : undefined};
    } catch (error) {
      try {config.refreshFromPersistence();} catch { /* 기존 선택/쓰기 실패는 그대로 전달한다. */ }
      return {success:false,error:error instanceof Error ? error.message : String(error)};
    }
  });
}
