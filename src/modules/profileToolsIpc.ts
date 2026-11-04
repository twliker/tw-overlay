import {ipcMain,type WebContents,type IpcMainInvokeEvent,type IpcMainEvent} from 'electron';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {getProfileRuntime} from './profileRuntime';
import type {ProfileToolContext} from '../shared/profileTools';
import {broadcastToAllWindows} from './windowMessaging';
import {pathToFileURL} from 'url';

let registered=false;
const bindings=new WeakMap<WebContents,{token:string;profileId:string;url:string}>();
const allowed=new Set(['buffs.html','coefficient-calculator.html'].map(name => pathToFileURL(path.resolve(__dirname,'..',name)).href));
export const isProfileToolPage=(url:string):boolean => allowed.has(url.split(/[?#]/)[0]);
const page=(event:IpcMainEvent | IpcMainInvokeEvent) => event.senderFrame===event.sender.mainFrame ? event.senderFrame?.url.split(/[?#]/)[0] || '' : '';
/** 각 창의 저장 대상은 페이지가 열린 때 고정한다. 현재 선택이 바뀌거나 늦은 입력이 와도
 * ID를 추정하지 않고 같은 창의 token/허용 키를 검사한다. 회귀: check-profile-tools.ts. */
export function registerProfileToolsIpc():void {
  if (registered) return;registered=true;
  ipcMain.handle('profile-tool-context',(event):ProfileToolContext => {
    const url=page(event);if (!allowed.has(url)) throw new Error('지원하지 않는 계산기 화면입니다.');
    const runtime=getProfileRuntime();
    if (!runtime) return {enabled:false,profileId:null,name:'',token:'',values:{}};
    const status=runtime.service.status(),profile=runtime.service.store.list().find(item => item.id===status.activeProfileId);
    if (!profile) throw new Error('계산할 프로필을 선택해 주세요.');
    const token=randomUUID();bindings.set(event.sender,{token,profileId:profile.id,url});
    return {enabled:true,profileId:profile.id,name:profile.name || '기본 프로필',token,values:runtime.service.store.toolValues(profile.id)};
  });
  ipcMain.on('profile-tool-write',(event,token:unknown,key:unknown,value:unknown) => {
    try {
      const binding=bindings.get(event.sender),runtime=getProfileRuntime();
      if (!runtime || !binding || binding.token!==token || binding.url!==page(event)) throw new Error('계산기 저장 대상을 다시 확인해 주세요.');
      runtime.service.store.saveToolValue(binding.profileId,key,value);
      event.returnValue={success:true};
      // DB 저장 후 닫히는 다른 창의 표시 실패를 저장 실패로 되돌리지 않는다.
      try {broadcastToAllWindows('profile-tools-changed',{profileId:binding.profileId,key,value});} catch { /* 다음 열기 때 DB에서 복구 */ }
    } catch (error) {event.returnValue={success:false,error:error instanceof Error ? error.message : String(error)};}
  });
}
