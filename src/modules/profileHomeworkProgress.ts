import type {ApplicationData} from './applicationData';
import type {ContentsCheckerItem} from '../shared/types';
import type {PlayProfile,ProfileHomeworkSnapshot} from '../shared/playProfiles';
import {calculateDiaryHomeworkStats,getNextHomeworkResetAt,resetExpiredHomeworkItems} from './contentsChecker';

/** 프로필 목록의 일일/주간 현황은 체크리스트와 같은 완료한 항목 수 기준이다.
 * 숨김/N/A는 제외하고 반복 숙제는 최대 횟수를 채워야 완료 1개다. 비활성 프로필의 만료는
 * 기존 초기화 규칙으로 메모리에서만 정규화한다. 선택/원본/일지/변경 이력은 수정하지 않는다.
 * 일반 service.status/로그 경로에서 계산하지 않고 프로필 화면과 종료 안내의 조회에서만 일괄 읽는다.
 * 회귀: check-profile-homework-progress.ts, check-profiles-ui.ts, check-game-exit-reminder.ts. */
export function readCurrentProfileHomework(store:ApplicationData,profiles:readonly PlayProfile[],now=Date.now()):Array<{profile:PlayProfile;items:ContentsCheckerItem[]}> {
  const byProfile=new Map(profiles.map(profile=>[profile.id,[] as ContentsCheckerItem[]]));
  const rows=store.database.prepare(`SELECT h.profile_id,h.item_id,h.definition,h.state FROM profile_homework h
    JOIN play_profiles p ON p.id=h.profile_id WHERE p.deleted_at IS NULL ORDER BY h.profile_id,h.position,h.item_id`).all() as
    Array<{profile_id:string;item_id:string;definition:string;state:string}>;
  for(const row of rows)byProfile.get(row.profile_id)?.push({...JSON.parse(row.definition),id:row.item_id,completedState:{[row.profile_id]:JSON.parse(row.state)}});
  return profiles.map(profile=>({profile,items:resetExpiredHomeworkItems(byProfile.get(profile.id),now).items}));
}

export function readProfileHomeworkProgress(store:ApplicationData,profiles:readonly PlayProfile[],now=Date.now()):ProfileHomeworkSnapshot {
  const snapshot:ProfileHomeworkSnapshot={generatedAt:now,nextResetAt:null,profiles:Object.create(null)};
  for(const {profile,items} of readCurrentProfileHomework(store,profiles,now)) {
    const stats=calculateDiaryHomeworkStats(items,[{id:profile.id}]);
    snapshot.profiles[profile.id]={daily:{done:stats.dailyDone,total:stats.dailyTotal},weekly:{done:stats.weeklyDone,total:stats.weeklyTotal}};
    const reset=getNextHomeworkResetAt(items,now);
    if(reset!==undefined && (snapshot.nextResetAt===null || reset<snapshot.nextResetAt))snapshot.nextResetAt=reset;
  }
  return snapshot;
}
