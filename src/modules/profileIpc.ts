import { ipcMain } from 'electron';
import { fileURLToPath } from 'url';
import * as path from 'path';
import type { PlayProfileResult } from '../shared/playProfiles';
import { assertProfileName, isProfileServer } from '../shared/playProfiles';
import { getProfileRuntime } from './profileRuntime';
import type { ProfileRuntime } from './profileRuntime';
import {readProfileHomeworkProgress} from './profileHomeworkProgress';
import {readProfilePendingDetails} from './profilePendingPreview';
import * as config from './config';
import {log} from './logger';

/** 기능 계약 — 관리 IPC는 제품의 로컬 프로필 화면에서만 변경을 허용한다.
 * 이름/서버/ID를 메인에서도 검증하며 임의 경로·설정 객체는 받지 않는다.
 * 준비 전 조회는 null, 변경은 명시적 오류다. 실패를 성공으로 닫지 않는다.
 */
export function registerProfileIpc(options:{getRuntime?:() => ProfileRuntime | null;close:() => void}): void {
  const getRuntime=options.getRuntime || getProfileRuntime;
  const expected=path.resolve(__dirname,'..','profiles.html');
  const isProfilePage=(url:string):boolean => {
    try {return path.resolve(fileURLToPath(url)).toLowerCase()===expected.toLowerCase();} catch {return false;}
  };
  ipcMain.handle('play-profiles-get',event => {
    const runtime=getRuntime();if(!runtime)return null;
    const status=runtime.service.status();
    if(event.senderFrame!==event.sender.mainFrame || !isProfilePage(event.senderFrame?.url || ''))return status;
    if(runtime.service.isStorageMaintenanceActive() || !runtime.service.store.database.open)return {...status,homeworkProgress:null,pendingDetails:null};
    let homeworkProgress:import('../shared/playProfiles').PlayProfileStatus['homeworkProgress']=null;
    let pendingDetails:import('../shared/playProfiles').PlayProfileStatus['pendingDetails']=null;
    try {homeworkProgress=readProfileHomeworkProgress(runtime.service.store,status.profiles);}
    catch(error) {log(`[PROFILE] 숙제 현황 조회 실패, 프로필 선택 유지: ${String(error)}`);}
    try {pendingDetails=readProfilePendingDetails(runtime.service.store,status.pendingSessions.filter(session=>session.sessionId!==status.sessionId),new Map((config.load().contentsCheckerItems || []).map(item=>[item.id,item.name])));}
    catch(error) {log(`[PROFILE] 미배정 기록 요약 조회 실패: ${String(error)}`);}
    return {...status,homeworkProgress,pendingDetails};
  });
  const register=(channel:string,action:(runtime:ProfileRuntime,args:unknown[]) => PlayProfileResult | Promise<PlayProfileResult>) => {
    ipcMain.handle(channel,async (event,...args:unknown[]) => {
      const runtime=getRuntime();
      if (!runtime) throw new Error('프로필 기능을 준비하고 있습니다. 잠시 후 다시 열어 주세요.');
      try {
        if (!isProfilePage(event.senderFrame?.url || '')) throw new Error('프로필 관리 화면에서 실행해 주세요.');
        return await action(runtime,args);
      } catch (error) {return {success:false,error:error instanceof Error ? error.message : String(error),status:runtime.service.status()};}
    });
  };
  const id=(value:unknown):string => {
    if (typeof value!=='string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(value)) throw new Error('프로필을 다시 선택하세요.');
    return value;
  };
  const input=(name:unknown,server:unknown):[string,number] => {
    assertProfileName(name);
    if (!isProfileServer(server)) throw new Error('서버를 선택하세요.');
    return [name.normalize('NFC').trim(),server];
  };
  register('play-profiles-create',({service},[name,server,copy]) => service.create(...input(name,server),copy===undefined ? undefined : id(copy)));
  register('play-profiles-update',({service},[profileId,name,server]) => service.update(id(profileId),...input(name,server)));
  register('play-profiles-select',({service,replay},[profileId]) => service.select(id(profileId),replay));
  register('play-profiles-delete',({service},[profileId]) => service.remove(id(profileId)));
  register('play-profiles-reorder',({service},[ids])=>{
    if(!Array.isArray(ids) || !ids.length || ids.length>10000)throw new Error('프로필 순서가 올바르지 않습니다.');
    return service.reorder(ids.map(value=>id(value)));
  });
  register('play-profiles-assign',({service,replay},[session]) => service.assignSession(id(session),replay));
  register('play-profiles-ignore',({service},[session,token])=>{
    if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token))throw new Error('대기 기록을 다시 확인해 주세요.');
    return service.ignoreSession(id(session),token);
  });
  ipcMain.on('play-profiles-close',event => {if (isProfilePage(event.senderFrame?.url || '')) options.close();});
}
