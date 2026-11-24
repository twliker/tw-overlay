import {PROFILE_WINDOW_TIMEOUT_MS,runProfileWindowScript,trackProfileEditorWindows} from './profileSettingsTransition';
import {app,BrowserWindow,shell} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {randomUUID} from 'crypto';
import type {ApplicationData} from './applicationData';
import {ProfileSyncModel,localSyncProfileId} from './profileSyncModel';
import {assertStopwatchProfileDeletable} from './profileStopwatch';
import {ProfileSyncApplyDeferred,ProfileSyncCoordinator} from './profileSyncCoordinator';
import {GoogleProfileDrive} from './profileSyncDrive';
import * as config from './config';
import * as auth from './googleAuth';
import {getProfileRuntime} from './profileRuntime';
import {applyRuntimeSettings} from './runtimeSettings';
import {log} from './logger';
import {appState} from './constants';
import {broadcastToAllWindows} from './windowMessaging';
import {createProfileSyncBackup,pruneProfileSyncBackups,removeStaleProfileSyncBackupStages} from './profileSyncBackup';
import {ProfileToolBusyError,createProfileToolTransition} from './profileToolTransition';
import {isProfileToolPage} from './profileToolsIpc';
import {profileEditorWindows} from './profileEditorWindows';
import type {GoogleSyncStatus,GoogleSyncResult} from '../shared/types';
import type {ProfileSyncConnectionChoice} from '../shared/profileSync';
import type {PlayProfileStatus} from '../shared/playProfiles';
import type {ProfileClock} from './profileClock';

let current:ProfileCloudSync | undefined;
export const getProfileCloudSync=()=>current;

/** 편집기가 승인 없이 다른 프로필로 넘어가는 작업 동안 입력과 초안을 보호한다. */
async function lockProfileEditors() {
  const locked=new Map<BrowserWindow,{url:string;finish:string;navigated:boolean;removeListener:()=>void}>();
  const release=async()=>{
    for (const details of locked.values()) details.removeListener();
    await Promise.allSettled([...locked].filter(([win])=>!win.isDestroyed())
      .map(([win,{finish}])=>runProfileWindowScript(win,finish)));
  };
  try {
    for (const {win,url,object,label} of profileEditorWindows()) {
      if (win.isDestroyed()) continue;
      const key=JSON.stringify(randomUUID()),deadline=Date.now()+PROFILE_WINDOW_TIMEOUT_MS;
      const contents=win.webContents;
      const details={url,finish:`if (window.__twGoogleImportLock===${key}) {delete window.__twGoogleImportLock;${object}?.finish();}`,
        navigated:false,removeListener:()=>{if (!contents.isDestroyed()) contents.removeListener('did-start-navigation',onNavigation);}};
      const onNavigation=({isMainFrame}:{isMainFrame:boolean})=>{if (isMainFrame) details.navigated=true;};
      contents.on('did-start-navigation',onNavigation);
      locked.set(win,details);
      const state=await runProfileWindowScript(win,`(() => {if (Date.now()>=${deadline}) return null; window.__twGoogleImportLock=${key}; ${object}?.lock(); return ${object}?.status();})()`);
      if (!state?.ready || state.dirty || state.busy || state.editing || state.prompt || state.uncertain) {
        throw new Error(`${label}의 작성 중인 내용을 먼저 저장하거나 취소한 뒤 Google 변경을 적용해 주세요. 입력은 그대로 유지했습니다.`);
      }
    }
  } catch (error) {await release();throw error;}
  const assertCurrent=()=>{
    if (profileEditorWindows().some(({win,url})=>{
      const details=locked.get(win);
      return details?.url!==url || details.navigated;
    })) {
      throw new Error('프로필 설정 창이 바뀌었습니다. 작성 중인 내용을 확인한 뒤 다시 시도해 주세요.');
    }
  };
  return {release,assertCurrent};
}

/** 기존 인증만 재사용하며 이전 파일/병합/operation/스케줄러는 실행하지 않는다.
 * 새 원격 데이터 반영은 기존 프로필 기록 잠금과 설정 runtime 경계를 공유한다.
 * 처음 연결에는 로컬 안전 ZIP을 보관하고 빈 기본 프로필만 재사용한다.
 * 회귀: check-profile-sync.ts / check-profile-sync-ui.ts / check-profile-lifecycle.ts。 */
export function initializeProfileCloudSync(store:ApplicationData,clock?:ProfileClock):ProfileCloudSync {
  if (current) return current;
  current=new ProfileCloudSync(store,clock);return current;
}
export class ProfileCloudSync {
  readonly coordinator:ProfileSyncCoordinator;
  private readonly drive:GoogleProfileDrive;
  private importOwner:{profileId:string;sessionId:string | null;editors?:Awaited<ReturnType<typeof lockProfileEditors>>;
    toolWindows:ReturnType<typeof trackProfileEditorWindows>} | null=null;
  constructor(readonly store:ApplicationData,clock?:ProfileClock) {
    this.drive=new GoogleProfileDrive(fetch,()=>auth.getSyncAccessToken(),()=>auth.refreshAfterUnauthorized(),()=>auth.invalidateAuth(),'1',sample=>clock?.observeInternetTime(sample));
    const model=new ProfileSyncModel(()=>store.database,store.syncDeviceId,()=>store.syncClock(),
      ()=>config.loadFields(['activePlayProfileId']).activePlayProfileId,
      id=>!!this.importOwner?.editors && store.isPristineProfilePlaceholder(id));
    this.coordinator=new ProfileSyncCoordinator(model,this.drive,{
      account:()=>auth.isLoggedIn() ? auth.loadStoredProfile()?.email.toLowerCase() || null : null,
      enabled:()=>config.load().googleSyncEnabled===true,
      auto:()=>config.load().googleSyncAutoSync!==false,
      activeProfile:()=>getProfileRuntime()?.service.selectedProfileId ?? undefined,
      ready:()=>{const service=getProfileRuntime()?.service;return !!service && !service.status().busy && !service.isStorageMaintenanceActive() && config.flushPending();},
      assertReview:key=>{const p=JSON.parse(key) as string[];if(p[0]==='profile' && p[2]==='deleted') {const local=localSyncProfileId(store.database,p[1]);if(local) this.assertDeletable(local);}},
      beforeImport:async(choice)=>{
        const runtime=getProfileRuntime();if (!runtime) throw new Error('프로필을 준비하고 있습니다.');
        const owner=runtime.service.status(),tools=createProfileToolTransition({showFailure:false,purpose:'sync'});
        const toolWindows=trackProfileEditorWindows(isProfileToolPage);
        let editors:Awaited<ReturnType<typeof lockProfileEditors>> | undefined;
        const cleanup=async(committed:boolean)=>{
          this.importOwner=null;
          toolWindows.dispose();
          await editors?.release();
          await tools.finish(committed);
        };
        try {
          // 교체로 다른 소유자에 넘어갈 수 있는 편집 입력은 먼저 저장/취소하게 한다.
          // 병합에서 기본 슬롯을 원격 프로필로 바꾸는 경우에도 미저장 입력을 먼저 확인한다.
          if (choice==='remote' || this.coordinator.details().remoteProfiles?.length
            && store.isPristineProfilePlaceholder(owner.activeProfileId)) editors=await lockProfileEditors();
          await tools.prepare('__google_import__','select');
          const current=runtime.service.status();if(current.activeProfileId!==owner.activeProfileId || current.sessionId!==owner.sessionId || current.busy) throw new Error('프로필 상태가 바뀌었습니다. 데이터를 다시 확인해 주세요.');
          this.importOwner={profileId:owner.activeProfileId,sessionId:owner.sessionId,editors,toolWindows};
          return cleanup;
        } catch(error) {await cleanup(false);throw error;}
      },
      apply:async(action,requireSelection=false,deletingProfileId)=>{
        const runtime=getProfileRuntime();if (!runtime || runtime.service.status().busy) throw new Error('프로필 저장을 마친 뒤 반영합니다.');
        const tools=createProfileToolTransition({showFailure:false,purpose:'sync'});let committed=false;
        const ownsToolWindows=!this.importOwner;
        const toolWindows=this.importOwner?.toolWindows ?? trackProfileEditorWindows(isProfileToolPage);
        let editors:Awaited<ReturnType<typeof lockProfileEditors>> | undefined;
        let backupPath:string | undefined;
        const warnings:string[]=[];
        const followUp=(work:()=>void,message:string)=>{
          try {work();} catch (error) {
            log(`[PROFILE_SYNC] ${message} ${String(error)}`);
            if (committed) warnings.push(message);
          }
        };
        try {
        // 모든 계산기 입력을 원래 소유자에 저장하고 commit까지 함께 잠근다. 자동 수신은 포커스를 바꾸지 않는다.
        // 계산기에 작성 중인 입력이 있으면 반영만 미룬다(coordinator가 이 PC의 변경은 전송하고 다시 받음).
        if(!this.importOwner) await tools.prepare('__google_sync__','select').catch(error=>{
          throw error instanceof ProfileToolBusyError ? new ProfileSyncApplyDeferred(error.editor) : error;
        });
        const status=runtime.service.status();
        if (deletingProfileId && deletingProfileId===status.activeProfileId) editors=await lockProfileEditors();
        if(this.importOwner && (this.importOwner.profileId!==status.activeProfileId || this.importOwner.sessionId!==status.sessionId)) throw new Error('프로필 상태가 바뀌었습니다. 데이터를 다시 확인해 주세요.');
        const reselect=!status.selectionRequired && (requireSelection===true || requireSelection===status.activeProfileId);
        let previous:ReturnType<typeof config.load>,oldTools:ReturnType<typeof store.toolValues>;
        const lease=runtime.service.beginStorageMaintenance();
        try {
          if (this.importOwner) {
            backupPath=await createProfileSyncBackup(store.database,app.getPath('userData'),app.getVersion(),
              error=>log('[PROFILE_SYNC] 임시 백업 정리 실패: '+String(error)));
          }
          if (reselect && runtime.service.selectedProfileId===status.activeProfileId
            && runtime.service.currentSessionId===status.sessionId && !appState.isQuitting) {
            const input=lease.flushSelectionInput(runtime.replay);
            if (input) await input;
          }
          const latest=runtime.service.status();
          if (appState.isQuitting || latest.activeProfileId!==status.activeProfileId || latest.sessionId!==status.sessionId
            || latest.selectionRequired!==status.selectionRequired) {
            throw new Error('프로필 상태가 바뀌었습니다. 다시 시도해 주세요.');
          }
          (editors ?? this.importOwner?.editors)?.assertCurrent();
          toolWindows.assertCurrent();
          // ready()의 저장 뒤 위 대기 중에 생긴 설정 저장(창 위치·마지막 확인 시각 등)을 원격 반영 전에 확정한다.
          // 여기부터 commit까지는 await가 없어 새 대기 저장이 끼어들지 못한다. 대기 저장을 남긴 채 반영하면
          // 이후 저장이 반영 전 projection으로 DB를 되돌리고 그 값을 다시 전송한다.
          // 회귀: check-profile-sync-ui.ts (원격 반영 중 설정 저장).
          if (!config.flushPending()) throw new Error('설정 저장을 마친 뒤 반영합니다.');
          previous=config.load();
          oldTools=previous.activePlayProfileId ? store.toolValues(previous.activePlayProfileId) : {};
          const value=store.commitConfiguration(previous,previous,requested=>{
            const previousProfiles=store.list();
            const pinned=previousProfiles.filter(p=>{try {assertStopwatchProfileDeletable(p.id);return false;} catch {return true;}}).map(p=>p.id);
            model.setMeta('identityReviews',[...new Set([...model.meta<string[]>('identityReviews',[]),...pinned])]);
            action();
            if (backupPath) {model.setMeta('backupPath',backupPath);model.setMeta('backupAvailable',true);}
            const remaining=new Set(store.list().map(p=>p.id));
            for(const p of previousProfiles) if(!remaining.has(p.id)) this.assertDeletable(p.id);
            store.ensureEmptyProfile();
            store.ensureDefaultHomework();
            if (reselect) requested.profileSelectionRequired=true;
            if (!store.list().some(p=>p.id===requested.activePlayProfileId)) {
              if (!status.selectionRequired && !reselect) throw new Error('사용 중인 프로필의 변경은 먼저 확인해 주세요.');
              requested.activePlayProfileId=store.list()[0].id;requested.profileSelectionRequired=true;
            }
          },{externalProjection:true});
          committed=true;
          // 연결 전 ZIP은 최근 몇 개만 남긴다. 방금 기록한(설정 화면이 가리키는) 백업은 지우지 않는다.
          if (backupPath) void pruneProfileSyncBackups(app.getPath('userData'),[backupPath])
            .catch(error=>log('[PROFILE_SYNC] 이전 연결 전 백업 정리 실패: '+String(error)));
          followUp(()=>{
            config.acceptPersistentCommit(value);
            if (value.profileSelectionRequired && !status.selectionRequired) runtime.service.acceptSyncSelection();
          },'설정을 다시 불러오려면 앱을 다시 실행해 주세요.');
        } finally {
          followUp(()=>lease.finish(runtime.replay),'일부 대기 기록은 프로필 관리에서 다시 확인해 주세요.');
        }
        const refreshWarning='화면에 적용된 설정을 확인하려면 창을 다시 열어 주세요.';
        followUp(()=>runtime.service.refreshAfterSync(previous),refreshWarning);
        followUp(()=>applyRuntimeSettings(previous,config.load()),refreshWarning);
        followUp(()=>{
          const next=config.load();
          broadcastToAllWindows('config-data',next);
          if (next.activePlayProfileId) {
            const values=store.toolValues(next.activePlayProfileId);
            for (const key of new Set([...Object.keys(oldTools),...Object.keys(values)])) if (values[key]!==oldTools[key]) broadcastToAllWindows('profile-tools-changed',{profileId:next.activePlayProfileId,key,value:values[key] ?? null});
          }
        },refreshWarning);
        return warnings.length ? [...new Set(warnings)].join(' ') : undefined;
        } finally {
          if (backupPath && !committed) await fs.promises.rm(backupPath,{force:true})
            .catch(error=>log('[PROFILE_SYNC] 적용 실패 백업 정리 실패: '+String(error)));
          await editors?.release();
          await tools.finish(committed);
          // 계산기 창 감시는 모든 종료 경로에서 해제한다. 반영을 미뤄 prepare에서 끝나는 경우도 15초마다 반복되므로
          // 여기서 풀지 않으면 실행마다 창에 리스너가 쌓인다. 가져오기 소유 감시는 그쪽 정리가 해제한다.
          if (ownsToolWindows) toolWindows.dispose();
        }
      },
      changed:()=>this.broadcast(),
      report:message=>log(`[PROFILE_SYNC] ${message}`),
    });
    // 강제 종료로 남은 연결 전 백업 작업 폴더를 정리한다. 이 시점에는 진행 중인 백업이 없다.
    void removeStaleProfileSyncBackupStages(app.getPath('userData'))
      .catch(error=>log('[PROFILE_SYNC] 남은 백업 작업 폴더 정리 실패: '+String(error)));
  }
  private assertDeletable(id:string):void {
    assertStopwatchProfileDeletable(id);
    if (this.store.hasPendingForProfile(id)) throw new Error('이 프로필에 저장할 자동 기록이 남아 있습니다. 프로필 관리에서 기록을 먼저 처리해 주세요.');
  }
  status():GoogleSyncStatus {
    const linked=auth.isLoggedIn(),profile=auth.loadStoredProfile(),cfg=config.load(),sync=this.coordinator;
    let details,lastSyncedAt;try {
      details=sync.details();lastSyncedAt=sync.lastSyncedAt;
      if (details.connection==='choice') details.localProfileCount=this.store.list().filter(profile=>profile.name.trim()).length;
    } catch {details=undefined;}
    return {profileSync:details,isLinked:linked,email:profile?.email || cfg.googleSyncUserEmail,
      reauthRequired:!linked && cfg.googleSyncEnabled===true && !!(profile?.email || cfg.googleSyncUserEmail),
      autoSync:cfg.googleSyncAutoSync!==false,lastSyncedAt,isSyncing:sync.syncing,syncActivity:sync.activity,
      fileName:'프로필 · 숙제 · 환경설정 (PC별 저장)',error:sync.error,pullRetryCount:sync.retryCount};
  }
  private broadcast():void {
    try {broadcastToAllWindows('google-sync-status-changed',this.status());}
    catch (error) {log(`[PROFILE_SYNC] 동기화 화면 상태 갱신 실패: ${String(error)}`);}
  }
  start():void {this.coordinator.start();}
  stop():void {this.coordinator.stop();}
  cancel():void {this.coordinator.cancel();}
  request():void {this.coordinator.request();}
  activityChanged(state:'running' | 'minimized' | 'not-running'):void {this.coordinator.activityChanged(state==='running');}
  async login():Promise<{success:boolean;status:GoogleSyncStatus;error?:string}> {
    try {
      const result=await auth.startLogin();if (!result.success || !result.profile) throw new Error(result.error || '로그인을 완료하지 못했습니다.');
      if (!config.saveConfirmed({googleSyncEnabled:true,googleSyncUserEmail:result.profile.email})) throw new Error('Google 연결 설정을 저장하지 못했습니다.');
      this.start();await this.coordinator.sync(true);return {success:true,status:this.status()};
    } catch (error) {return {success:false,status:this.status(),error:error instanceof Error ? error.message : String(error)};}
  }
  /** 기능 계약 — "나중에 설정" 뒤 동기화 다시 켜기.
   * 나중에 설정은 googleSyncEnabled만 끄고 Google 로그인(토큰)은 유지한다. 다시 켤 때 브라우저 OAuth(prompt=consent)를
   * 반복하지 않고 유지 중인 로그인으로 동기화를 켠 뒤 Google 데이터를 다시 읽어 첫 연결 선택(병합/가져오기)을 보여 준다.
   * 로그인이 만료됐으면 실패를 돌려주고 화면은 다시 로그인을 안내한다.
   * 회귀: check-profile-sync-ui.ts(나중에 설정 뒤 동기화 다시 켜기). */
  async resume():Promise<{success:boolean;status:GoogleSyncStatus;error?:string;message?:string}> {
    try {
      const email=auth.isLoggedIn() ? auth.loadStoredProfile()?.email : undefined;
      if (!email) throw new Error('Google 로그인이 만료되었습니다. 다시 로그인해 주세요.');
      this.coordinator.resumeConnection();
      if (!config.saveConfirmed({googleSyncEnabled:true,googleSyncUserEmail:email})) throw new Error('Google 동기화 설정을 저장하지 못했습니다. 다시 시도해 주세요.');
      this.start();this.broadcast();await this.coordinator.sync(true);
      const connection=this.coordinator.details().connection;
      return {success:true,status:this.status(),message:connection==='choice' ? '사용할 데이터를 선택한 뒤 동기화 시작을 눌러 주세요.' : 'Google 동기화를 다시 켰습니다.'};
    } catch (error) {return {success:false,status:this.status(),error:error instanceof Error ? error.message : String(error)};}
    finally {this.broadcast();}
  }
  logout():GoogleSyncStatus {
    this.stop();this.cancel();auth.logout();
    config.saveConfirmed({googleSyncEnabled:false,googleSyncUserEmail:''});this.broadcast();return this.status();
  }
  async sync():Promise<GoogleSyncResult> {
    if (!auth.isLoggedIn() || !config.load().googleSyncEnabled) return {success:false,error:'Google 계정으로 동기화를 먼저 연결해 주세요.'};
    try {
      const warning=await this.coordinator.sync(true);
      const details=this.coordinator.details();
      const message=details.connection==='choice' ? '처음 연결할 데이터를 선택해 주세요.'
          : details.uploadBlocked ? '이 PC의 Google 파일을 읽을 수 없어 전송을 보류했습니다. 변경은 이 PC에 보관됩니다.'
            : details.remoteDeferred ? details.remoteDeferred
            : details.damagedFiles ? `읽을 수 없는 Google 파일 ${details.damagedFiles}개를 보류했습니다.`
            : '동기화를 완료했습니다.';
      return {success:true,lastSyncedAt:this.coordinator.lastSyncedAt,message:warning ? `${message} ${warning}` : message};
    }
    catch(error) {return {success:false,error:error instanceof Error ? error.message : String(error)};}
  }
  async choose(choice:ProfileSyncConnectionChoice):Promise<{success:boolean;error?:string;message?:string}> {
    try {
      const warning=await this.coordinator.choose(choice);
      if (choice==='local' && !config.saveConfirmed({googleSyncEnabled:false})) throw new Error('Google 동기화를 끄는 설정을 저장하지 못했습니다.');
      this.broadcast();
      let status:PlayProfileStatus | undefined;
      try {status=getProfileRuntime()?.service.status();}
      catch (error) {log(`[PROFILE_SYNC] 가져오기 후 프로필 상태 조회 실패: ${String(error)}`);}
      const selectHint=status?.selectionRequired && status.profiles.some(profile=>profile.name.trim())
        ? ' 프로필 관리에서 사용할 프로필을 선택해 주세요.' : '';
      const message=choice==='local' ? '이 PC에 계속 저장합니다. 나중에 Google 동기화를 설정할 수 있습니다.'
        : choice==='remote' ? `Google 데이터를 가져왔습니다.${selectHint}`
        : `Google 동기화를 설정했습니다.${selectHint}`;
      return {success:true,message:warning ? `${message} ${warning}` : message};
    }
    catch(error) {return {success:false,error:error instanceof Error ? error.message : String(error)};}
  }
  async resolve(key:string,candidate:string):Promise<{success:boolean;error?:string;message?:string}> {
    try {
      const warning=await this.coordinator.resolve(key,candidate);
      return {success:true,message:warning ? `변경을 적용했습니다. ${warning}` : undefined};
    }
    catch(error) {return {success:false,error:error instanceof Error ? error.message : String(error)};}
  }
  showBackup():void {
    const file=this.coordinator.model.meta('backupPath','');
    if (file && path.dirname(file)===path.join(app.getPath('userData'),'backups') && fs.existsSync(file)) shell.showItemInFolder(file);
  }
}
