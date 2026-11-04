import * as config from './config';
import * as diary from './diaryDb';
import * as contents from './contentsChecker';
import {ProfileService,type ProfileServiceHooks} from './profileService';
import {ProfileGameLifecycle} from './profileGameLifecycle';
import {getProfileRuntime,setProfileRuntime,type ProfileRuntime} from './profileRuntime';
import {replayProfileParserEvent} from './profileParserEvents';
import {collectRecordEffects} from './recordEffects';
import {xpTracker} from './xpTracker';
import {buffTimerManager} from './buffTimerManager';
import {abandonedTracker} from './abandonedTracker';
import {digsiteTracker} from './digsiteTracker';
import {getSupplyRun,restoreSupplyRun} from './supplyTracker';
import {broadcastToAllWindows} from './windowMessaging';
import type {ApplicationData} from './applicationData';
import {createProfileToolTransition} from './profileToolTransition';
import {createProfileSettingsTransition} from './profileSettingsTransition';
import {createProfileChecklistTransition} from './profileChecklistTransition';
import {refreshProfileStopwatch,assertStopwatchProfileDeletable,clearProfileStopwatch} from './profileStopwatch';

interface RuntimeSnapshot {
  version:1;
  sessionId:string | null;
  xp:ReturnType<typeof xpTracker.captureProfileState>;
  buffs:ReturnType<typeof buffTimerManager.captureProfileState>;
  abandoned:ReturnType<typeof abandonedTracker.captureProfileState>;
  digsite:ReturnType<typeof digsiteTracker.getState>;
  supply:ReturnType<typeof getSupplyRun>;
  detected:ReturnType<typeof contents.captureDetectedHomework>;
}
export interface ProfileRecordingController {runtime:ProfileRuntime;checkpoint():void;dispose():void}

/** 부팅 준비 뒤, 파서 소비자/버프 정의 준비와 함께 profileApplication에서 설치한다.
 * 전환 전에 원래 프로필의 실행 상태를 로컬 DB에 보존하고 새 프로필만 복원한다.
 * XP 측정 시간은 비활성 시간을 제외하고 버프·현황판·도전과제는 원래 만료 시각을 유지한다.
 * 이전 세션 배정은 DB 기록만 복원하며 현재 HUD/소리를 재생하지 않는다.
 * 선택한 프로필의 지난 리셋 주기 숙제는 화면을 열기 전에도 초기화한다. 상태/일지 집계는
 * 같은 transaction으로 확정하고 실패 시 선택을 되돌려 자동 감지가 옛 횟수에 누적되지 않게 한다.
 * checkpoint는 종료 전 DB를 닫기 전에 호출해야 한다. 회귀: check-profile-recording.ts.
 */
export function installProfileRecording(store:ApplicationData,options:{openSelection:() => void;prepareTransition?:ProfileServiceHooks['prepareTransition']}):ProfileRecordingController {
  if (getProfileRuntime()) throw new Error('프로필 기록 경로가 이미 연결되어 있습니다.');
  let active:string | null=null;
  let activeSession:string | null=null;
  const tools=createProfileToolTransition();
  const settings=createProfileSettingsTransition();
  const checklist=createProfileChecklistTransition();
  let settingsSignature='';
  let paused=false;
  let deferredGameStates:Array<'running' | 'minimized' | 'not-running'>=[];
  const checkpoint=() => {
    if (!active) return;
    xpTracker.flushXpUpdate();
    const value:RuntimeSnapshot={version:1,sessionId:activeSession,xp:xpTracker.captureProfileState(),buffs:buffTimerManager.captureProfileState(),
      abandoned:abandonedTracker.captureProfileState(),digsite:digsiteTracker.getState(),supply:getSupplyRun(),detected:contents.captureDetectedHomework()};
    store.saveRuntimeState(active,value);
  };
  const suspend=() => {
    active=null;activeSession=null;
    xpTracker.restoreProfileState(null,false);buffTimerManager.restoreProfileState(null);
    abandonedTracker.restoreProfileState(null);digsiteTracker.restoreProfileState(null);restoreSupplyRun(null);contents.restoreDetectedHomework(null);
  };
  const service=new ProfileService(store,config,{
    assertCanDelete:assertStopwatchProfileDeletable,
    prepareTransition:async (id,operation) => await tools.prepare(id,operation) && await settings.prepare(id,operation)
      && await checklist.prepare(id,operation)
      && (await options.prepareTransition?.(id,operation) ?? true),
    transitionFinished:async committed => {await checklist.finish(committed);await settings.finish(committed);await tools.finish(committed);},
    beforeTransition:() => {
      if (!diary.flushPendingElso() || !diary.flushPendingGoldPouchSeed()) throw new Error('이전 프로필 기록을 저장하지 못했습니다.');
      checkpoint();
    },
    pendingSelection:suspend,
    afterTransition:(_previous,next) => {
      restore(next);
      if (next.profileSelectionRequired) return;
      let effects:()=>void;
      try {
        effects=store.database.transaction(() => collectRecordEffects(() => config.withConfirmedWrites(() => contents.checkReset()),true))();
      } catch (error) {config.refreshFromPersistence();throw error;}
      effects();
    },
    changed:status => {
      refreshProfileStopwatch();
      broadcastToAllWindows('play-profiles-changed',status);
      const profile=status.profiles.find(item => item.id===status.activeProfileId);
      const signature=JSON.stringify([status.activeProfileId,profile?.name,profile?.userServer,status.selectionRequired]);
      if (!status.busy && signature!==settingsSignature) {if (settings.refresh() && checklist.refresh()) settingsSignature=signature;}
    },
  });
  const restore=(next:ReturnType<typeof config.load>) => {
      const id=next.profileSelectionRequired ? null : next.activePlayProfileId || null;
      if (active===id && id) {buffTimerManager.refreshConfig();return;}
      suspend();
      if (!id) return;
      const saved=store.runtimeState(id) as RuntimeSnapshot | null;
      if (saved && saved.version!==1) throw new Error('지원하지 않는 프로필 진행 상태입니다.');
      active=id;
      activeSession=service.status().sessionId;
      const sameSession=saved?.sessionId===activeSession;
      xpTracker.restoreProfileState(saved?.xp || null);buffTimerManager.restoreProfileState(saved?.buffs || null);
      abandonedTracker.restoreProfileState(saved?.abandoned ? {...saved.abandoned,suppressed:sameSession && saved.abandoned.suppressed} : null);
      digsiteTracker.restoreProfileState(sameSession ? saved?.digsite || null : null);
      restoreSupplyRun(sameSession ? saved?.supply || null : null);contents.restoreDetectedHomework(saved?.detected || null);
  };
  const replay=(payload:unknown):unknown => {
    const legacy=payload as {kind?:string;value?:import('../shared/types').PendingHomework};
    if (legacy?.kind==='legacy-homework' && legacy.value) {
      const item=legacy.value;
      return collectRecordEffects(() => config.withConfirmedWrites(() => contents.queuePendingHomework(item.id,item.count,item.isIncrement,undefined,item.timestamp)),false);
    }
    return replayProfileParserEvent(payload);
  };
  const lifecycle=new ProfileGameLifecycle(service,options.openSelection);
  const runtime:ProfileRuntime={service,replay,onGameState:state => {
    if (!paused) {lifecycle.observe(state);return;}
    if (deferredGameStates.at(-1)!==state) deferredGameStates.push(state);
    if (deferredGameStates.length>256) deferredGameStates=['not-running',state];
  },checkpoint,
    suspendForRestore:()=>{
      if (paused) throw new Error('프로필 실행 상태가 이미 중지되어 있습니다.');
      checkpoint();paused=true;suspend();
      return ()=>{if (!paused) return;paused=false;restore(config.load());const states=deferredGameStates;deferredGameStates=[];for (const state of states) lifecycle.observe(state);};
    },
  };
  setProfileRuntime(runtime);
  return {runtime,checkpoint,dispose() {checkpoint();suspend();if (getProfileRuntime()===runtime) {clearProfileStopwatch();setProfileRuntime(null);}}};
}
