import {initializePlayProfileStorage,type PreparedPlayProfileStorage} from './profileStartup';
import {installProfileRecording,type ProfileRecordingController} from './profileRecording';
import {buffTimerManager} from './buffTimerManager';
import * as contents from './contentsChecker';
import {log} from './logger';
import type {ProfileClock} from './profileClock';
import {getLegacyUserServer,load as loadConfiguration,flushPending,withConfirmedWrites} from './config';
import {pauseForPlayProfiles} from './cloudSyncManager';
import {app} from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {createUserDataSnapshot,verifyUserDataSnapshot} from './localSnapshot';
import {initializeProfileCloudSync} from './profileCloudSync';

let prepared:PreparedPlayProfileStorage | undefined;
let recording:ProfileRecordingController | undefined;
let checkpointTimer:NodeJS.Timeout | undefined;
let starting:Promise<ProfileRecordingController> | undefined;

/** 앱 시작은 기존 숙제를 먼저 정규화하고, 이전/Google 중지/선택 대기/기록 gate를 UI와
 * 게임 폴링·실시간 입력보다 먼저 준비한다. 실패 시 기존 모드로 폴백하지 않는다.
 * 종료·Windows 세션 종료는 DB를 닫기 전에 checkpoint하며 1분마다 실행 상태를 보존한다.
 * 회귀: check-profile-lifecycle.ts, check-profile-recording.ts, check-profile-backup.ts. */
export function startProfileApplication(openSelection:()=>void,clock?:ProfileClock):Promise<ProfileRecordingController> {
  if (starting) return starting;
  starting=(async()=>{
    await pauseForPlayProfiles();
    const directory=app.getPath('userData');
    if (!fs.existsSync(path.join(directory,'app-data.db'))) {
      const backupRoot=path.join(directory,'backups'),snapshot=path.join(backupRoot,`before-profile-preparation-${randomUUID()}`);
      createUserDataSnapshot(directory,snapshot,{reason:'before-profile-preparation',appVersion:app.getVersion(),allowedDestinationRoot:backupRoot});
      verifyUserDataSnapshot(snapshot);
    }
    getLegacyUserServer();
    const freshInstall=!loadConfiguration().characterPresets?.length;
    if (!contents.init({deferRuntime:true})) throw new Error('프로필 이전 전 숙제 정보를 준비하지 못했습니다.');
    prepared=await initializePlayProfileStorage(clock,{freshInstall});
    buffTimerManager.loadBuffDefs();
    recording=installProfileRecording(prepared.store,{openSelection});
    initializeProfileCloudSync(prepared.store,prepared.clock);
    // 이전 전에는 기존 일지를 열지 않는다. 새 DB와 기록 귀속을 연결한 뒤 집계/타이머를 시작한다.
    withConfirmedWrites(() => contents.checkReset());
    checkpointTimer=setInterval(()=>checkpointProfileApplication(true),60_000);checkpointTimer.unref();
    return recording;
  })();
  return starting;
}

export function checkpointProfileApplication(compact=false):void {
  if (!recording || recording.runtime.service.isStorageMaintenanceActive()) return;
  try {
    recording.checkpoint();
    if (compact && !recording.runtime.service.status().busy) prepared?.store.compactResolvedEvents();
  } catch (error) {log(`[PROFILE] 실행 상태 저장 실패, 기존 데이터 유지: ${String(error)}`);}
}
export function stopProfileApplication():void {
  if (checkpointTimer) clearInterval(checkpointTimer);checkpointTimer=undefined;
  checkpointProfileApplication();flushPending();prepared?.stopClock();contents.stopResetChecks();
}
export function refreshProfileClock(invalidate=false):void {if(invalidate)prepared?.clock.invalidate();void prepared?.clock.refresh();}
