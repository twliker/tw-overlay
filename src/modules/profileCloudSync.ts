import {app,BrowserWindow,shell} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {randomUUID} from 'crypto';
import AdmZip from 'adm-zip';
import type {ApplicationData} from './applicationData';
import {ProfileSyncModel,localSyncProfileId} from './profileSyncModel';
import {assertStopwatchProfileDeletable} from './profileStopwatch';
import {ProfileSyncCoordinator} from './profileSyncCoordinator';
import {GoogleProfileDrive} from './profileSyncDrive';
import * as config from './config';
import * as auth from './googleAuth';
import {getProfileRuntime} from './profileRuntime';
import {applyRuntimeSettings} from './runtimeSettings';
import {broadcastToAllWindows} from './windowMessaging';
import {createUserDataSnapshot,verifyUserDataSnapshot} from './localSnapshot';
import {createProfileToolTransition} from './profileToolTransition';
import {isProfileSettingsPage} from './profileSettingsAccess';
import {isProfileChecklistPage} from './profileChecklistIpc';
import type {GoogleSyncStatus,GoogleSyncResult} from '../shared/types';
import type {ProfileSyncConnectionChoice} from '../shared/profileSync';
import type {ProfileClock} from './profileClock';

let current:ProfileCloudSync | undefined;
export const getProfileCloudSync=()=>current;

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
  private importOwner:{profileId:string;sessionId:string | null} | null=null;
  constructor(readonly store:ApplicationData,clock?:ProfileClock) {
    this.drive=new GoogleProfileDrive(fetch,()=>auth.getValidAccessToken(),()=>auth.refreshAfterUnauthorized(),()=>auth.invalidateAuth(),'1',sample=>clock?.observeInternetTime(sample));
    const model=new ProfileSyncModel(()=>store.database,store.syncDeviceId,()=>store.syncClock());
    this.coordinator=new ProfileSyncCoordinator(model,this.drive,{
      account:()=>auth.isLoggedIn() ? auth.loadStoredProfile()?.email.toLowerCase() || null : null,
      enabled:()=>config.load().googleSyncEnabled===true,
      auto:()=>config.load().googleSyncAutoSync!==false,
      activeProfile:()=>{
        const status=getProfileRuntime()?.service.status();return status && !status.selectionRequired ? status.activeProfileId : undefined;
      },
      ready:()=>{const service=getProfileRuntime()?.service;return !!service && !service.status().busy && !service.isStorageMaintenanceActive() && config.flushPending();},
      assertReview:key=>{const p=JSON.parse(key) as string[];if(p[0]==='profile' && p[2]==='deleted') {const local=localSyncProfileId(store.database,p[1]);if(local) assertStopwatchProfileDeletable(local);}},
      beforeImport:async(choice)=>{
        const runtime=getProfileRuntime();if (!runtime) throw new Error('프로필을 준비하고 있습니다.');
        const owner=runtime.service.status(),tools=createProfileToolTransition({showFailure:false});
        const locked:Array<{win:BrowserWindow;finish:string}>=[];
        const cleanup=async(committed:boolean)=>{
          this.importOwner=null;
          for(const {win,finish} of locked) if(!win.isDestroyed()) try {await win.webContents.executeJavaScript(finish);} catch { /* 닫힌 화면은 잠금을 소유하지 않는다. */ }
          await tools.finish(committed);
        };
        try {
          // 교체로 다른 소유자에 넘어갈 수 있는 편집 입력은 먼저 저장/취소하게 한다.
          // 병합은 같은 소유자의 초안을 그대로 보존한다. 계산기는 두 모드 모두 먼저 flush한다.
          if(choice==='remote') for(const win of BrowserWindow.getAllWindows()) {
            if(win.isDestroyed())continue;const url=win.webContents.getURL();
            const settings=isProfileSettingsPage(url),checklist=isProfileChecklistPage(url);if(!settings && !checklist)continue;
            const object=settings ? 'window.settingsProfileTransition' : 'window.profileChecklist';
            locked.push({win,finish:`${object}?.finish()`});
            const state=await win.webContents.executeJavaScript(`${object}?.lock();${object}?.status()`);
            if(!state?.ready || state.dirty || state.busy || state.editing || state.prompt || state.uncertain) throw new Error(`${settings ? '환경설정' : '숙제'}의 작성 중인 내용을 먼저 저장하거나 취소한 뒤 Google 데이터를 가져와 주세요. 입력은 그대로 유지했습니다.`);
          }
          await tools.prepare('__google_import__','select');
          const current=runtime.service.status();if(current.activeProfileId!==owner.activeProfileId || current.sessionId!==owner.sessionId || current.busy) throw new Error('프로필 상태가 바뀌었습니다. 데이터를 다시 확인해 주세요.');
          this.importOwner={profileId:owner.activeProfileId,sessionId:owner.sessionId};
          return cleanup;
        } catch(error) {await cleanup(false);throw error;}
      },
      apply:async(action,requireSelection=false)=>{
        const runtime=getProfileRuntime();if (!runtime || runtime.service.status().busy) throw new Error('프로필 저장을 마친 뒤 반영합니다.');
        const tools=createProfileToolTransition({showFailure:false});let committed=false;
        try {
        // 모든 계산기 입력을 원래 소유자에 저장하고 commit까지 함께 잠근다. 자동 수신은 포커스를 바꾸지 않는다.
        if(!this.importOwner) await tools.prepare('__google_sync__','select');
        const status=runtime.service.status();
        if(this.importOwner && (this.importOwner.profileId!==status.activeProfileId || this.importOwner.sessionId!==status.sessionId)) throw new Error('프로필 상태가 바뀌었습니다. 데이터를 다시 확인해 주세요.');
        if (!status.selectionRequired && (requireSelection===true || requireSelection===status.activeProfileId)) runtime.service.requireSyncSelection();
        const previous=config.load(),lease=runtime.service.beginStorageMaintenance(),oldTools=previous.activePlayProfileId ? store.toolValues(previous.activePlayProfileId) : {};
        try {
          if(this.importOwner) {
            // UI flush 뒤 같은 저장 잠금 안에서 백업과 교체를 잇는다. 사이에 자동 숙제를 잃지 않는다.
            store.database.pragma('wal_checkpoint(FULL)');
            const directory=app.getPath('userData'),root=path.join(directory,'backups'),target=path.join(root,`before-google-profile-sync-${randomUUID()}`);
            createUserDataSnapshot(directory,target,{reason:'before-google-profile-sync',appVersion:app.getVersion(),allowedDestinationRoot:root});verifyUserDataSnapshot(target);
            const zip=new AdmZip();zip.addLocalFolder(target);zip.writeZip(`${target}.zip`);
            const fd=fs.openSync(`${target}.zip`,'r+');try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
            if(!new AdmZip(`${target}.zip`).test()) throw new Error('적용 전 백업 ZIP 검증에 실패했습니다. 기존 데이터는 유지했습니다.');
            model.setMeta('backupPath',`${target}.zip`);model.setMeta('backupAvailable',true);
          }
          const value=store.commitConfiguration(previous,previous,requested=>{
            const previousProfiles=store.list();
            const pinned=previousProfiles.filter(p=>{try {assertStopwatchProfileDeletable(p.id);return false;} catch {return true;}}).map(p=>p.id);
            model.setMeta('identityReviews',[...new Set([...model.meta<string[]>('identityReviews',[]),...pinned])]);
            action();
            const remaining=new Set(store.list().map(p=>p.id));
            for(const p of previousProfiles) if(!remaining.has(p.id)) assertStopwatchProfileDeletable(p.id);
            store.ensureEmptyProfile();
            store.ensureDefaultHomework();
            if (!store.list().some(p=>p.id===requested.activePlayProfileId)) {requested.activePlayProfileId=store.list()[0].id;requested.profileSelectionRequired=true;}
          },{externalProjection:true});
          config.acceptPersistentCommit(value);committed=true;
        } finally {lease.finish(runtime.replay);}
        runtime.service.refreshAfterSync(previous);
        const next=config.load();applyRuntimeSettings(previous,next);
        broadcastToAllWindows('config-data',next);
        if (next.activePlayProfileId) {
          const values=store.toolValues(next.activePlayProfileId);
          for (const key of new Set([...Object.keys(oldTools),...Object.keys(values)])) if (values[key]!==oldTools[key]) broadcastToAllWindows('profile-tools-changed',{profileId:next.activePlayProfileId,key,value:values[key] ?? null});
        }
        } finally {await tools.finish(committed);}
      },
      changed:()=>this.broadcast(),
    });
  }
  status():GoogleSyncStatus {
    const linked=auth.isLoggedIn(),profile=auth.loadStoredProfile(),cfg=config.load(),sync=this.coordinator;
    let details,lastSyncedAt;try {details=sync.details();lastSyncedAt=sync.lastSyncedAt;} catch {details=undefined;}
    return {profileSync:details,isLinked:linked,email:profile?.email || cfg.googleSyncUserEmail,
      reauthRequired:!linked && cfg.googleSyncEnabled===true && !!(profile?.email || cfg.googleSyncUserEmail),
      autoSync:cfg.googleSyncAutoSync!==false,lastSyncedAt,isSyncing:sync.syncing,syncActivity:sync.activity,
      fileName:'프로필 · 숙제 · 환경설정 (PC별 저장)',error:sync.error,pullRetryCount:sync.retryCount};
  }
  private broadcast():void {broadcastToAllWindows('google-sync-status-changed',this.status());}
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
  logout():GoogleSyncStatus {
    this.stop();this.cancel();auth.logout();config.saveConfirmed({googleSyncEnabled:false});this.broadcast();return this.status();
  }
  async sync():Promise<GoogleSyncResult> {
    if (!auth.isLoggedIn() || !config.load().googleSyncEnabled) return {success:false,error:'Google 계정으로 동기화를 먼저 연결해 주세요.'};
    try {await this.coordinator.sync(true);return {success:true,lastSyncedAt:this.coordinator.lastSyncedAt,
      message:this.coordinator.details().connection==='choice' ? '처음 연결할 데이터를 선택해 주세요.' : '동기화를 완료했습니다.'};}
    catch(error) {return {success:false,error:error instanceof Error ? error.message : String(error)};}
  }
  async choose(choice:ProfileSyncConnectionChoice):Promise<{success:boolean;error?:string}> {
    try {await this.coordinator.choose(choice);if (choice==='local') config.saveConfirmed({googleSyncEnabled:false});this.broadcast();return {success:true};}
    catch(error) {return {success:false,error:error instanceof Error ? error.message : String(error)};}
  }
  async resolve(key:string,candidate:string):Promise<{success:boolean;error?:string}> {
    try {await this.coordinator.resolve(key,candidate);return {success:true};}
    catch(error) {return {success:false,error:error instanceof Error ? error.message : String(error)};}
  }
  showBackup():void {
    const file=this.coordinator.model.meta('backupPath','');
    if (file && path.dirname(file)===path.join(app.getPath('userData'),'backups') && fs.existsSync(file)) shell.showItemInFolder(file);
  }
}
