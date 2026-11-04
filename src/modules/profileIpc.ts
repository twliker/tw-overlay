import { ipcMain } from 'electron';
import { fileURLToPath } from 'url';
import * as path from 'path';
import type { PlayProfileResult } from '../shared/playProfiles';
import { assertProfileName, isProfileServer } from '../shared/playProfiles';
import { getProfileRuntime } from './profileRuntime';
import type { ProfileRuntime } from './profileRuntime';

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
  ipcMain.handle('play-profiles-get',() => getRuntime()?.service.status() || null);
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
  register('play-profiles-assign',({service,replay},[session]) => service.assignSession(id(session),replay));
  ipcMain.on('play-profiles-close',event => {if (isProfilePage(event.senderFrame?.url || '')) options.close();});
}
