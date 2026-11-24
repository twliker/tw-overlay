import * as config from './config';
import * as contentsChecker from './contentsChecker';
import {getProfileRuntime} from './profileRuntime';
import {parseDiaryProfileFilter,type DiaryProfileFilter,type DiaryProfileState} from '../shared/diaryProfiles';
import {isProfileServer} from '../shared/playProfiles';
import {MAIN_CHAR_ID} from '../shared/types';

/** 조회·수동 저장 선택에는 활성 프로필만 전달한다. 보관 기록 정리는 archivedProfiles를 사용한다. */
export function getDiaryProfileState():DiaryProfileState {
  const runtime=getProfileRuntime();
  if (!runtime) return {enabled:false,profiles:[],activeProfileId:null,selectionRequired:true,busy:false};
  const status=runtime.service.status();
  return {enabled:true,profiles:status.profiles,activeProfileId:status.activeProfileId || null,
    selectionRequired:status.selectionRequired,busy:status.busy};
}

export function resolveDiaryProfileFilter(value:unknown):DiaryProfileFilter {
  const filter=parseDiaryProfileFilter(value);
  if (filter.kind==='profile') {
    const runtime=getProfileRuntime();
    if (!runtime || !runtime.service.store.list().some(profile => profile.id===filter.profileId)) throw new Error('조회할 프로필을 찾을 수 없습니다.');
  }
  return filter;
}

/** 기능 계약 — 수동 저장은 조회 필터/늦은 현재 선택과 독립적인 명시적 대상이다.
 * 프로필 모드에서 ID 생략·삭제/미완성 대상은 거부한다. 실제 기록은 동기 callback 안에서만 쓰고
 * 원래 record context를 finally로 복원한다. 프로필 기능을 켜기 전의 기존 호출 형식은 유지한다.
 */
export function withManualDiaryProfile<T>(id:unknown,write:() => T):T {
  const runtime=getProfileRuntime();
  if (!runtime) {
    if (id!==undefined) throw new Error('프로필 기능을 준비하고 있습니다.');
    return write();
  }
  if (typeof id!=='string') throw new Error('기록할 프로필을 선택하세요.');
  const profile=runtime.service.store.list().find(item => item.id===id);
  if (!profile || !profile.name.trim() || !isProfileServer(profile.userServer)) throw new Error('기록할 프로필의 이름과 서버를 확인해 주세요.');
  return runtime.service.store.withRecordContext(id,null,write);
}

export function getDiaryWeeklyTotals(filter:DiaryProfileFilter):number | ReadonlyMap<string,number> {
  const runtime=getProfileRuntime();
  if (!runtime) {
    const legacy=config.loadFields(['contentsCheckerItems','characterPresets'] as const);
    return contentsChecker.calculateDiaryHomeworkStats(legacy.contentsCheckerItems || [],legacy.characterPresets?.length ? legacy.characterPresets : [{id:MAIN_CHAR_ID}]).weeklyTotal;
  }
  const {store}=runtime.service;
  const profiles=store.list().filter(profile => filter.kind==='all' || filter.kind==='profile' && profile.id===filter.profileId);
  return new Map(profiles.map(profile => [profile.id,contentsChecker.calculateDiaryHomeworkStats(store.homework(profile.id),[profile]).weeklyTotal]));
}

export function diaryFilterLabel(filter:DiaryProfileFilter):string | undefined {
  const state=getDiaryProfileState();
  if (!state.enabled) return undefined;
  if (filter.kind==='all') return '모든 프로필';
  if (filter.kind==='unassigned') return '미배정 기록';
  const profile=state.profiles.find(item => item.id===filter.profileId);
  if (!profile) throw new Error('조회할 프로필을 찾을 수 없습니다.');
  const server=profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '서버 미설정';
  return `${profile.name || '기본 프로필'} · ${server}`;
}
