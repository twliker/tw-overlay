import * as config from './config';
import * as diary from './diaryDb';
import * as contents from './contentsChecker';
import {ProfileService,type ProfileServiceHooks} from './profileService';
import {ProfileGameLifecycle,type ProfileGameState} from './profileGameLifecycle';
import {getProfileRuntime,setProfileRuntime,type ProfileRuntime} from './profileRuntime';
import {recoverLiveProgress,recoverProfileProgress,replayProfileParserEvent} from './profileParserEvents';
import {chatLogManager} from './chatLogManager';
import {collectRecordEffects} from './recordEffects';
import {xpTracker} from './xpTracker';
import {buffTimerManager} from './buffTimerManager';
import {abandonedTracker} from './abandonedTracker';
import {digsiteTracker} from './digsiteTracker';
import {getSupplyRun,restoreSupplyRun} from './supplyTracker';
import {log} from './logger';
import {diagEvent,diagTransition,shortId} from './profileDiagnostics';
import {broadcastToAllWindows,sendToAllWindowsByPage,sendToFirstWindowByPage} from './windowMessaging';
import type {ApplicationData} from './applicationData';
import {readLegacyPendingHomework} from '../shared/legacyHomework';
import {createProfileToolTransition} from './profileToolTransition';
import {createProfileSettingsTransition,trackProfileEditorWindows} from './profileSettingsTransition';
import {createProfileChecklistTransition} from './profileChecklistTransition';
import {isProfileSettingsPage} from './profileSettingsAccess';
import {isProfileChecklistPage} from './profileChecklistIpc';
import {isProfileToolPage} from './profileToolsIpc';
import {refreshProfileStopwatch,assertStopwatchProfileDeletable,clearProfileStopwatch} from './profileStopwatch';
import {publishEntryWindows} from './bossNotifier';
import {assertProfileName,isProfileServer} from '../shared/playProfiles';

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
export function installProfileRecording(store:ApplicationData,options:{openSelection:() => void;prepareTransition?:ProfileServiceHooks['prepareTransition'];isGameProcessCurrent?:(id:number)=>boolean}):ProfileRecordingController {
  if (getProfileRuntime()) throw new Error('프로필 기록 경로가 이미 연결되어 있습니다.');
  let active:string | null=null;
  let activeSession:string | null=null;
  const tools=createProfileToolTransition();
  const settings=createProfileSettingsTransition();
  const checklist=createProfileChecklistTransition();
  let editorWindows:ReturnType<typeof trackProfileEditorWindows> | undefined;
  const failedProgress=new Set<string>();
  let settingsSignature='';
  let paused=false;
  let deferredGameStates:Array<[ProfileGameState,number?]>=[];
  const checkpoint=() => {
    if (!active || failedProgress.has(active)) return;
    xpTracker.flushXpUpdate();
    // 미룬 경험치 구간을 먼저 쓴다(처리 구간 1분 계약). 그 구간의 HUD 복원 행은 아래 저장이 스냅샷과 함께 비운다.
    store.flushDeferredRange();
    const value:RuntimeSnapshot={version:1,sessionId:activeSession,xp:xpTracker.captureProfileState(),buffs:buffTimerManager.captureProfileState(),
      abandoned:abandonedTracker.captureProfileState(),digsite:digsiteTracker.getState(),supply:getSupplyRun(),detected:contents.captureDetectedHomework()};
    store.saveRuntimeState(active,value);
  };
  const suspend=() => {
    active=null;activeSession=null;
    // 선택된 상태인데 이 상태가 이어지면 경험치·버프 HUD가 기록을 받지 않는다(다음 전환의 restore가 다시 켠다).
    diagTransition('hud-runtime','suspended',undefined,0);
    xpTracker.restoreProfileState(null,false);buffTimerManager.restoreProfileState(null);
    abandonedTracker.restoreProfileState(null);digsiteTracker.restoreProfileState(null);restoreSupplyRun(null);contents.restoreDetectedHomework(null);
  };
  const service=new ProfileService(store,config,{
    assertCanDelete:assertStopwatchProfileDeletable,
    prepareTransition:async (id,operation) => {
      if (operation==='delete' || config.load().activePlayProfileId!==id) {
        editorWindows=trackProfileEditorWindows(url=>isProfileSettingsPage(url) || isProfileChecklistPage(url) || isProfileToolPage(url));
      }
      return await tools.prepare(id,operation) && await settings.prepare(id,operation)
        && await checklist.prepare(id,operation)
        && (await options.prepareTransition?.(id,operation) ?? true);
    },
    assertTransitionCurrent:()=>editorWindows?.assertCurrent(),
    transitionFinished:async committed => {
      editorWindows?.dispose();editorWindows=undefined;
      await checklist.finish(committed);await settings.finish(committed);await tools.finish(committed);
    },
    beforeTransition:() => {
      if (!diary.flushPendingElso() || !diary.flushPendingGoldPouchSeed()) throw new Error('이전 프로필 기록을 저장하지 못했습니다.');
      checkpoint();
    },
    flushPendingInput:kind=>chatLogManager.drainProfileBoundary(kind),
    commitInputBoundary:()=>chatLogManager.commitProfileInputBoundary(),
    pendingSelection:suspend,
    afterTransition:(previous,next) => {
      restore(next);
      try {publishEntryWindows();} catch (error) {log(`[PROFILE] 보스 입장 안내 갱신 실패: ${String(error)}`);}
      if (next.profileSelectionRequired) return;
      let effects:()=>void;
      try {
        effects=store.database.transaction(() => collectRecordEffects(() => config.withConfirmedWrites(() => contents.checkReset()),true))();
      } catch (error) {config.refreshFromPersistence();throw error;}
      effects();
      // 로컬 전환도 열린 오버레이의 프로필 설정을 확정된 값으로 갱신한다.
      try {
        const applied=config.load();
        sendToFirstWindowByPage('game-overlay.html','config-data',applied);
        sendToFirstWindowByPage('game-overlay.html','today-summary-config',applied);
        if (previous.userServer!==applied.userServer || previous.activePlayProfileId!==applied.activePlayProfileId) {
          sendToAllWindowsByPage('chat-overlay.html','config-data',applied);
        }
      } catch (error) {log(`[PROFILE] 오버레이 설정 전송 실패: ${String(error)}`);}
    },
    changed:status => {
      refreshProfileStopwatch(status);
      broadcastToAllWindows('play-profiles-changed',status);
      const profile=status.profiles.find(item => item.id===status.activeProfileId);
      const signature=JSON.stringify([status.activeProfileId,profile?.name,profile?.userServer,status.selectionRequired]);
      if (!status.busy && signature!==settingsSignature) {if (settings.refresh() && checklist.refresh()) settingsSignature=signature;}
    },
  });
  const restore=(next:ReturnType<typeof config.load>) => {
      const id=next.profileSelectionRequired ? null : next.activePlayProfileId || null;
      if (active===id && id && !failedProgress.has(id)) {buffTimerManager.refreshConfig();return;}
      suspend();
      if (!id) return;
      const saved=store.runtimeState(id) as RuntimeSnapshot | null;
      if (saved && saved.version!==1) throw new Error('지원하지 않는 프로필 진행 상태입니다.');
      active=id;
      activeSession=service.currentSessionId;
      const sameSession=saved?.sessionId===activeSession;
      const xp=saved?.xp;
      xpTracker.restoreProfileState(xp ? {...xp,quest:sameSession ? xp.quest : null} : null);
      buffTimerManager.restoreProfileState(saved?.buffs || null);
      abandonedTracker.restoreProfileState(saved?.abandoned ? {...saved.abandoned,suppressed:sameSession && saved.abandoned.suppressed} : null);
      digsiteTracker.restoreProfileState(sameSession ? saved?.digsite || null : null);
      restoreSupplyRun(sameSession ? saved?.supply || null : null);contents.restoreDetectedHomework(saved?.detected || null);
      const events=store.pendingRuntimeEvents(id);
      // 체크포인트 뒤 바로 반영한 실시간 줄(대기 원문 없음)만 원본 로그에서 HUD를 다시 재생한다(profile_runtime_ranges).
      // 복원·v3.3.5 원문 변환·이전 세션 배정이 만든 반영 구간은 이 표에 없으므로 재생하지 않는다.
      // 알려진 한계(계약): 재생 순서는 HUD 대기 행(대기 경로 줄) 전부 → 원본 구간이라 시간 순이 아니다. 체크포인트 뒤에
      // 대기 경로의 도전과제 시작 줄과 바로 반영한 경험치 줄이 섞여 있으면, 비정상 종료 뒤 복원에서만 퀘스트·경험치 순서가
      // 바뀔 수 있다(평상시 반영은 순서를 지킨다. applyOwnedLiveRecords). 최대 1분 구간이고 HUD에만 영향이 있다.
      const segments=store.runtimeRanges(id);
      if (events.length || segments.length) {
        failedProgress.add(id);
        for (const event of events) recoverProfileProgress(event,activeSession);
        if (segments.length) recoverLiveProgress(segments,saved?.sessionId ?? null,activeSession);
        // 이미 지난 버프와 경고를 제거하고 실제 사용 시각을 유지한다.
        buffTimerManager.restoreProfileState(buffTimerManager.captureProfileState());
        failedProgress.delete(id);
        checkpoint();
      } else failedProgress.delete(id);
      diagTransition('hud-runtime',`active:${shortId(id)}`,`session=${shortId(activeSession)}`,0);
  };
  const replay=(payload:unknown,eventId:string,pendingAssignment?:boolean):unknown => {
    const legacy=payload as {kind?:string;value?:unknown};
    if (legacy?.kind==='legacy-homework') {
      const item=readLegacyPendingHomework(legacy.value);
      if (!item) return '이전 숙제 기록의 필수 정보가 누락되어 배정할 수 없습니다.';
      let reason:string | undefined;
      const effects=collectRecordEffects(() => config.withConfirmedWrites(() => {
        // 대기 행 ID를 원본 ID로 넘겨 지난 주기 장부가 같은 기록을 한 번만 더하게 한다.
        reason=contents.queuePendingHomework(item.id,item.count,item.isIncrement,`legacy:${eventId}`,item.timestamp);
      }),false);
      return reason ?? effects;
    }
    return replayProfileParserEvent(payload,eventId,pendingAssignment);
  };
  /** 프로필이 하나뿐이고 이름·서버가 있으면 선택창 없이 그 프로필을 쓴다(신규·기존 사용자 모두). 선택 전 기록도 그 프로필에 배정된다. */
  const autoSelect=():Promise<boolean> | undefined => {
    const profiles=store.list();
    if (profiles.length!==1) return;
    const only=profiles[0];
    try {assertProfileName(only.name);} catch {return;}
    if (!isProfileServer(only.userServer)) return;
    return service.select(only.id,replay).then(result=>{
      if (!result.success) log(`[PROFILE] 하나뿐인 프로필 자동 선택 실패, 선택창을 엽니다: ${result.error}`);
      return result.success;
    });
  };
  const lifecycle=new ProfileGameLifecycle(service,options.openSelection,autoSelect);
  const observeGameState=(state:ProfileGameState,processId?:number):void | Promise<void> => {
    const ending=lifecycle.observe(state,processId);
    if (ending) return ending.then(()=>chatLogManager.resumeDeferredLiveRead());
    chatLogManager.resumeDeferredLiveRead();
  };
  /** 복원 중 보류한 게임 상태는 재개 시점에 받은 순서대로 동기 전달한다. 백업 복원은 이 재개 뒤에 채팅 로그
   * 감시와 대기 기록 재생을 재개하므로, 세션 시작·종료가 그보다 먼저 확정되어야 복원 중 새로 쓰인 로그가
   * 올바른 세션에 귀속된다(비동기로 미루면 이전 세션에 기록된다). 세션 종료 저장은 lifecycle이 자체적으로
   * 직렬화한다. 한 상태의 실패(동기 예외·거부된 Promise)는 기록하고 다음 상태를 계속 전달하며 처리되지 않은
   * 거부를 남기지 않는다. 세션 종료가 거부되면 lifecycle은 종료 중 받은 상태를 버리므로, 마지막 보류 상태를
   * 한 번만 다시 전달해 종료를 재시도한다(반복 실패는 다음 게임 상태 확인이 다시 시도한다).
   * 회귀: check-profile-recording.ts, check-profile-lifecycle.ts(복원 중 게임 재시작). */
  const logReplayFailure=(state:ProfileGameState,error:unknown)=>log(`[PROFILE] 보류한 게임 상태(${state}) 전달 실패: ${String(error)}`);
  const replayDeferredGameStates=():void => {
    const states=deferredGameStates;deferredGameStates=[];
    const endings:Promise<void>[]=[];
    for (const [state,processId] of states) {
      try {
        const pending=observeGameState(state,processId);
        if (pending) endings.push(pending);
      } catch (error) {logReplayFailure(state,error);}
    }
    const last=states.at(-1);
    if (!endings.length || !last) return;
    void Promise.allSettled(endings).then(results => {
      const rejected=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
      if (!rejected) return;
      logReplayFailure(last[0],rejected.reason);
      if (paused) return;
      try {
        const retry=observeGameState(last[0],last[1]);
        if (retry) void retry.catch(error=>logReplayFailure(last[0],error));
      } catch (error) {logReplayFailure(last[0],error);}
    });
  };
  const runtime:ProfileRuntime={service,replay,onGameState:(state,processId) => {
    if (!paused) return observeGameState(state,processId);
    const last=deferredGameStates.at(-1);
    if (last?.[0]!==state || last[1]!==processId) deferredGameStates.push([state,processId]);
    if (deferredGameStates.length>256) deferredGameStates=[['not-running'],[state,processId]];
  },canReadLiveLog:()=>{
    const id=lifecycle.currentProcessId;
    const current=id===undefined || options.isGameProcessCurrent?.(id)!==false;
    diagTransition('game-process',current ? 'current' : 'not-current',`pid=${id ?? '-'}`);
    return current;
  },checkpoint,progressFailed:id=>{
    failedProgress.add(id);
    diagTransition('hud-runtime',`progress-failed:${shortId(id)}`,undefined,0);
  },
    suspendForRestore:()=>{
      if (paused) throw new Error('프로필 실행 상태가 이미 중지되어 있습니다.');
      checkpoint();paused=true;suspend();
      // 재개는 한 번만 호출되고 다시 시도하는 경로가 없다. 실행 상태 복원이 실패해도 중지를 풀어 게임
      // 상태(세션 시작·종료)를 계속 받으며, 일부만 복원한 추적기는 비워 checkpoint가 저장된 상태를 덮지 않게 한다.
      // 다음 프로필 전환이 다시 복원한다. 실패는 호출자(백업 복원)가 기록하도록 다시 던진다.
      return ()=>{
        if (!paused) return;
        paused=false;
        let failed=false,failure:unknown;
        try {restore(config.load());}
        catch (error) {
          failed=true;failure=error;
          diagEvent('hud-runtime',`resume-failed error=${String(error)}`);
          try {suspend();} catch (cleanup) {log(`[PROFILE] 실행 상태 정리 실패: ${String(cleanup)}`);}
        }
        replayDeferredGameStates();
        if (failed) throw failure;
      };
    },
  };
  setProfileRuntime(runtime);
  return {runtime,checkpoint,dispose() {runtime.service.stopPendingReplay();checkpoint();suspend();if (getProfileRuntime()===runtime) {clearProfileStopwatch();setProfileRuntime(null);}}};
}
