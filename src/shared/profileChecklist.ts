import type {AppConfig,ResetRule} from './types';

export interface ProfileChecklistArguments {
  toggleItem:[id:string,characterId?:string];updateItemCount:[id:string,characterId:string,count:number];
  toggleExcludeItem:[id:string,characterId:string];toggleVisibility:[id:string];
  updateCategory:[id:string,category:string];updateName:[id:string,name:string];
  updateItem:[id:string,name:string,category:string,rule:ResetRule,maxCount?:number];
  addCustomItem:[name:string,category:string,rule:ResetRule,maxCount?:number];removeItem:[id:string];
  moveItem:[id:string,direction:'up' | 'down'];moveCategory:[type:ResetRule['type'],category:string,direction:'up' | 'down'];
  reorderItem:[source:string,target:string,position:'before' | 'after'];
  reorderCategory:[type:ResetRule['type'],source:string,target:string,position:'before' | 'after'];
  checkReset:[];applyPendingHomeworks:[characterId:string];clearPendingHomeworks:[];
}
export type ProfileChecklistAction=keyof ProfileChecklistArguments;
export type ProfileChecklistRequest={requestId:string;createdAt:number;profileId:string} & {
  [K in ProfileChecklistAction]:{kind:K;args:ProfileChecklistArguments[K]}
}[ProfileChecklistAction];
export interface ProfileChecklistResult {success:boolean;error?:string;config?:AppConfig;itemId?:string}
export interface ProfileChecklistApi {mutateProfileChecklist(request:ProfileChecklistRequest):Promise<ProfileChecklistResult>}

/** 로컬 제품 IPC에서도 동일한 길이·횟수·주기 범위를 확인한다. 임의 함수명/설정 객체는 받지 않는다. */
export function isProfileChecklistRequest(value:unknown):value is ProfileChecklistRequest {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const r=value as Record<string,unknown>,a=r.args;
  const id=(x:unknown) => typeof x==='string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(x);
  const text=(x:unknown,max:number) => typeof x==='string' && !!x.trim() && x.length<=max;
  const count=(x:unknown,min=0) => Number.isInteger(x) && (x as number)>=min && (x as number)<=10000;
  const type=(x:unknown) => x==='daily' || x==='weekly';
  const direction=(x:unknown) => x==='up' || x==='down';
  const position=(x:unknown) => x==='before' || x==='after';
  const rule=(x:unknown) => {
    if (!x || typeof x!=='object' || Array.isArray(x)) return false;
    const v=x as Record<string,unknown>;
    return type(v.type) && (v.hour===undefined || Number.isInteger(v.hour) && (v.hour as number)>=0 && (v.hour as number)<=23)
      && (v.type!=='weekly' || Number.isInteger(v.dayOfWeek) && (v.dayOfWeek as number)>=0 && (v.dayOfWeek as number)<=6);
  };
  if (!id(r.requestId) || (r.requestId as string).length>96 || !id(r.profileId) || !Number.isSafeInteger(r.createdAt) || (r.createdAt as number)<0 || !Array.isArray(a)) return false;
  if (!Object.keys(r).every(key => ['requestId','createdAt','profileId','kind','args'].includes(key))) return false;
  switch(r.kind) {
    case 'toggleItem':return a.length>=1 && a.length<=2 && id(a[0]) && (a[1]===undefined || id(a[1]));
    case 'updateItemCount':return a.length===3 && id(a[0]) && id(a[1]) && count(a[2]);
    case 'toggleExcludeItem':return a.length===2 && id(a[0]) && id(a[1]);
    case 'toggleVisibility':case 'removeItem':return a.length===1 && id(a[0]);
    case 'updateCategory':case 'updateName':return a.length===2 && id(a[0]) && text(a[1],r.kind==='updateName' ? 200 : 100);
    case 'updateItem':return a.length>=4 && a.length<=5 && id(a[0]) && text(a[1],200) && text(a[2],100) && rule(a[3]) && (a[4]===undefined || count(a[4],1));
    case 'addCustomItem':return a.length>=3 && a.length<=4 && text(a[0],200) && text(a[1],100) && rule(a[2]) && (a[3]===undefined || count(a[3],1));
    case 'moveItem':return a.length===2 && id(a[0]) && direction(a[1]);
    case 'moveCategory':return a.length===3 && type(a[0]) && text(a[1],100) && direction(a[2]);
    case 'reorderItem':return a.length===3 && id(a[0]) && id(a[1]) && position(a[2]);
    case 'reorderCategory':return a.length===4 && type(a[0]) && text(a[1],100) && text(a[2],100) && position(a[3]);
    case 'applyPendingHomeworks':return a.length===1 && id(a[0]);
    case 'checkReset':case 'clearPendingHomeworks':return a.length===0;
    default:return false;
  }
}
