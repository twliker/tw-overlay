import type {ApplicationData} from './applicationData';
import type {DiaryProfileState} from '../shared/diaryProfiles';

const prefix='unassigned-profile:';
export function isReclassifiedDiaryOwner(store:ApplicationData,id:string | null):boolean {
  return id!==null && !store.list().some(profile=>profile.id===id) && !!store.database.prepare('SELECT 1 FROM diary_profile_meta WHERE key=?').get(prefix+id);
}
/** 삭제/구형 프로필의 기록만 관리 대상으로 제공한다. 현재 살아 있는 프로필이나 미배정 자료는 포함하지 않는다. */
export function readArchivedDiaryProfiles(store:ApplicationData):NonNullable<DiaryProfileState['archivedProfiles']> {
  const profiles=store.list(true),live=new Set(profiles.filter(profile=>!profile.deletedAt).map(profile=>profile.id));
  const rows=store.database.prepare(`SELECT profile_id,COUNT(*) AS count,MIN(date) AS first,MAX(date) AS last FROM (
    SELECT profile_id,date FROM activity_logs UNION ALL SELECT profile_id,date FROM homework_logs
    UNION ALL SELECT profile_id,date FROM timer_records
    UNION ALL SELECT profile_id,date(timestamp/1000,'unixepoch','localtime') AS date FROM alarm_logs
  ) WHERE profile_id IS NOT NULL GROUP BY profile_id ORDER BY first,profile_id`).all() as Array<{profile_id:string;count:number;first:string;last:string}>;
  return rows.filter(row=>!live.has(row.profile_id) && !isReclassifiedDiaryOwner(store,row.profile_id)).map((row,index)=>({
    id:row.profile_id,name:profiles.find(profile=>profile.id===row.profile_id)?.name || `이전 프로필 ${index+1}`,recordCount:row.count,firstDate:row.first,lastDate:row.last,
  }));
}
/** '삭제 프로필 무시'는 기록을 미배정으로 분류한다. 원래 행/UUID/완료 중복 키는 보존한다.
 * 여러 캐릭터가 같은 날 같은 숙제를 한 원문도 합치거나 삭제하지 않는다. 일/월/통계/내보내기는
 * 동일한 유효 귀속 predicate를 사용한다. 현재 프로필로 추측 배정하지 않으며 Google 프로필 tombstone도 유지한다. */
export function reclassifyArchivedDiaryProfile(store:ApplicationData,id:string):void {
  if(typeof id!=='string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id))throw new Error('정리할 이전 프로필을 다시 선택하세요.');
  store.database.transaction(()=>{
    if(store.list().some(profile=>profile.id===id))throw new Error('사용 중인 프로필의 기록은 이 기능으로 옮길 수 없습니다.');
    if(isReclassifiedDiaryOwner(store,id))return;
    if(!readArchivedDiaryProfiles(store).some(profile=>profile.id===id))throw new Error('정리할 이전 프로필 기록을 찾을 수 없습니다.');
    store.database.prepare('INSERT INTO diary_profile_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(prefix+id,JSON.stringify({reclassifiedAt:Date.now()}));
  }).immediate();
}
