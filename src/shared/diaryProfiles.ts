/** 기록 귀속은 표시 이름과 독립적이다. 기존/판별 불가 기록은 null로 유지한다. */
export interface DiaryRecordContext {
  profileId:string | null;
  deviceId:string | null;
  sessionId:string | null;
}

export interface DiaryRecordAttribution {
  profile_id?:string | null;
  record_uuid?:string | null;
  record_device_id?:string | null;
  record_session_id?:string | null;
}

export type DiaryProfileFilter = {kind:'all'} | {kind:'unassigned'} | {kind:'profile';profileId:string};

export interface DiaryProfileState {
  enabled:boolean;
  profiles:import('./playProfiles').PlayProfile[];
  activeProfileId:string | null;
  selectionRequired:boolean;
  busy:boolean;
}

export interface DiaryManualRecordsApi {
  diaryAddActivity(date:string,time:string,type:'boss' | 'calc' | 'memo' | 'loot' | 'homework',content:string,amount?:number,profileId?:string):Promise<number | null>;
  diaryGetByDate(date:string,filter?:DiaryProfileFilter):Promise<import('./types').DiaryData | null>;
}

/** IPC 입력은 잘못된 범위를 전체 조회로 바꾸지 않는다. */
export function parseDiaryProfileFilter(value:unknown):DiaryProfileFilter {
  if (value===undefined) return {kind:'all'};
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('조회할 프로필을 다시 선택하세요.');
  const candidate=value as Record<string,unknown>;
  if ((candidate.kind==='all' || candidate.kind==='unassigned') && Object.keys(candidate).length===1) return {kind:candidate.kind};
  if (candidate.kind==='profile' && Object.keys(candidate).length===2
    && typeof candidate.profileId==='string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(candidate.profileId)) return {kind:'profile',profileId:candidate.profileId};
  throw new Error('조회할 프로필을 다시 선택하세요.');
}

export const ALL_DIARY_PROFILES:DiaryProfileFilter=Object.freeze({kind:'all'});

export function diaryProfilePredicate(filter:DiaryProfileFilter): {sql:string;params:Array<string | null>} {
  const column='profile_id';
  if (filter.kind==='all') return {sql:'',params:[]};
  if (filter.kind==='unassigned') return {sql:` AND ${column} IS NULL`,params:[]};
  if (filter.kind!=='profile' || typeof filter.profileId!=='string' || !filter.profileId || filter.profileId.length>128) {
    throw new Error('조회할 프로필을 다시 선택하세요.');
  }
  return {sql:` AND ${column} = ?`,params:[filter.profileId]};
}
