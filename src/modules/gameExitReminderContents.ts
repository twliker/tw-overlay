import type {AppConfig,GameExitReminderContents} from '../shared/types';
import {DEFAULT_CHAR_NAME,MAIN_CHAR_ID} from '../shared/types';
import type {ProfileRuntime} from './profileRuntime';
import {collectIncompleteContents} from './contentsSummary';
import {readCurrentProfileHomework} from './profileHomeworkProgress';
import {log} from './logger';

/** 종료 안내는 삭제되지 않은 모든 프로필의 현재 주기 미완료 숙제를 읽는다.
 * 숨김/N/A/완료 제외와 초기화는 체크리스트와 공유하며, 비활성 프로필도 메모리에서만 정규화한다.
 * 마지막 사용 프로필을 기본 탭으로 전달하고 선택/세션/일지/동기화 이력은 쓰지 않는다.
 * 복구 중/읽기 실패를 전체 완료로 표시하지 않는다. 프로필 런타임이 없는 구형 경로만 기존 설정을 읽는다.
 * 회귀: check-game-exit-reminder.ts, check-profile-homework-progress.ts, check-profile-windows.ts --with-reminder. */
export function collectProfileIncompleteContents(config:AppConfig,runtime:ProfileRuntime | null,now=Date.now()):GameExitReminderContents {
  const activeProfileId=config.activePlayProfileId;
  try {
    if(runtime) {
      const {service}=runtime;
      if(service.isStorageMaintenanceActive() || !service.store.database.open)return {profiles:[],activeProfileId,unavailable:true};
      const profiles=readCurrentProfileHomework(service.store,service.store.list(),now).map(({profile,items})=>({
        profileId:profile.id,profileName:profile.name || '기본 프로필',userServer:profile.userServer,
        items:collectIncompleteContents({...config,characterPresets:[{id:profile.id,name:profile.name}],contentsCheckerItems:items}),
      }));
      return {profiles,activeProfileId};
    }
    const profiles=(config.characterPresets || [{id:MAIN_CHAR_ID,name:DEFAULT_CHAR_NAME}]).map(profile=>({profileId:profile.id,profileName:profile.name,
      userServer:config.userServer ?? null,items:collectIncompleteContents({...config,characterPresets:[profile]})}));
    return {profiles,activeProfileId:activeProfileId || config.selectedCharacterId};
  } catch(error) {
    log(`종료 안내의 프로필 숙제 조회 오류: ${String(error)}`);
    return {profiles:[],activeProfileId,unavailable:true};
  }
}
