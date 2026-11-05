import {ipcMain} from 'electron';
import {fileURLToPath} from 'url';
import * as path from 'path';
import {getProfileRuntime} from './profileRuntime';
import {reclassifyArchivedDiaryProfile} from './diaryArchivedProfiles';
import {getDiaryProfileState} from './diaryProfileAccess';
import {broadcastToAllWindows} from './windowMessaging';
import {log} from './logger';

export function registerDiaryArchiveIpc():void {
  const expected=path.resolve(__dirname,'..','diary.html').toLowerCase();
  ipcMain.handle('diary-archive-ignore',(event,id:unknown)=>{
    let allowed=false;
    try {allowed=event.senderFrame===event.sender.mainFrame && path.resolve(fileURLToPath(event.senderFrame!.url)).toLowerCase()===expected;} catch {}
    if(!allowed)throw new Error('모험일지에서 이전 프로필 기록을 정리해 주세요.');
    const runtime=getProfileRuntime();
    if(!runtime || !runtime.service.store.database.open || runtime.service.status().busy || runtime.service.isStorageMaintenanceActive())throw new Error('다른 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    if(typeof id!=='string')throw new Error('정리할 이전 프로필을 다시 선택하세요.');
    let result:ReturnType<typeof getDiaryProfileState>;
    try {
      // 결과 snapshot을 읽지 못하면 분류 변경도 함께 rollback한다.
      result=runtime.service.store.database.transaction(()=>{
        reclassifyArchivedDiaryProfile(runtime.service.store,id);
        return getDiaryProfileState();
      }).immediate();
    }
    catch(error) {
      if(error && typeof error==='object' && 'code' in error && String(error.code).startsWith('SQLITE_')) {
        log(`[Diary] 이전 프로필 정리 실패, 원본 보존: ${String(error)}`);
        throw new Error('기록을 정리하지 못했습니다. 기존 기록은 유지됩니다. 잠시 후 다시 시도해 주세요.');
      }
      throw error;
    }
    // 저장 뒤 다른 창의 전송 실패는 성공한 transaction을 실패로 바꾸지 않는다.
    try {broadcastToAllWindows('play-profiles-changed',runtime.service.status());}
    catch(error) {log(`[Diary] 정리 완료 후 프로필 알림 전송 실패: ${String(error)}`);}
    try {broadcastToAllWindows('diary-updated');}
    catch(error) {log(`[Diary] 정리 완료 후 일지 알림 전송 실패: ${String(error)}`);}
    return result;
  });
}
