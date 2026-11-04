import {ipcMain,type IpcMainInvokeEvent} from 'electron';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {getProfileCloudSync} from './profileCloudSync';
import {refreshProfileClock} from './profileApplication';
const settings=pathToFileURL(path.resolve(__dirname,'..','settings.html')).href;
export function assertProfileSyncSettingsSender(event:IpcMainInvokeEvent):void {
  if (event.senderFrame!==event.sender.mainFrame || event.senderFrame?.url.split(/[?#]/)[0]!==settings) throw new Error('환경설정의 Google 동기화에서 실행해 주세요.');
}

/** 쓰기/선택은 실제 로컬 환경설정의 main frame만 허용한다. 원격 overlay나 iframe은 거부한다. */
export function registerProfileSyncIpc():void {
  const register=(channel:string,action:(...args:unknown[])=>unknown)=>ipcMain.handle(channel,(event,...args:unknown[])=>{
    assertProfileSyncSettingsSender(event);
    if (!getProfileCloudSync()) throw new Error('프로필 동기화를 준비하고 있습니다.');
    return action(...args);
  });
  register('profile-sync-connect-choice',choice=>{
    if (!['merge','remote','local'].includes(String(choice))) throw new Error('연결 방법을 다시 선택해 주세요.');
    return getProfileCloudSync()!.choose(choice as 'merge' | 'remote' | 'local');
  });
  register('profile-sync-resolve',(key,candidate)=>{
    if (typeof key!=='string' || key.length>2000 || typeof candidate!=='string' || candidate.length>300) throw new Error('변경 값을 다시 선택해 주세요.');
    return getProfileCloudSync()!.resolve(key,candidate);
  });
  register('profile-sync-show-backup',()=>getProfileCloudSync()!.showBackup());
  ipcMain.on('profile-sync-online',event=>{
    const url=event.senderFrame?.url || '';
    if (event.senderFrame!==event.sender.mainFrame || !url.startsWith(pathToFileURL(path.resolve(__dirname,'..')+path.sep).href)) return;
    refreshProfileClock();getProfileCloudSync()?.request();
  });
}
