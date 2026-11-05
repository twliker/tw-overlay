import { randomUUID } from 'crypto';
import type { AppConfig } from '../shared/types';
import type { PlayProfileResult, PlayProfileStatus } from '../shared/playProfiles';
import { assertProfileName, isProfileServer } from '../shared/playProfiles';
import {log} from './logger';
import type { ApplicationData } from './applicationData';

export interface ProfileConfiguration {
  load(): AppConfig;
  saveConfirmed(patch: Partial<AppConfig>): boolean;
  flushPending(): boolean;
  refreshFromPersistence(): void;
  acceptPersistentCommit(value:AppConfig): void;
}

export interface ProfileServiceHooks {
  /** 미저장 초안은 저장/버리기/취소를 여기서 처리한다. false면 전환하지 않는다. */
  prepareTransition?: (nextProfileId:string,operation:'select' | 'delete') => Promise<boolean>;
  transitionFinished?: (committed:boolean) => void | Promise<void>;
  /** 비활성 프로필 삭제도 실행 중인 측정/작업을 확인한다. 변경 없이 오류로 취소할 수 있다. */
  assertCanDelete?: (profileId:string) => void;
  /** 이전 프로필에 속한 집계 버퍼를 flush한 뒤 호출을 완료해야 한다. */
  beforeTransition?: () => void;
  afterTransition?: (previous:AppConfig,next:AppConfig) => void;
  changed?: (status:PlayProfileStatus) => void;
  pendingSelection?:() => void;
}

/**
 * 기능 계약 — 프로필 선택과 플레이 세션
 * 선택 상태는 기기 전용이다. 새 게임 세션/실행 중 앱 시작은 명시적 선택이 필요하고
 * 최소화 복귀는 같은 세션을 유지한다. 미선택 이벤트는 DB에 대기하며 선택 후 현재 세션만
 * 귀속한다. 이전 세션은 명시적 assignSession으로만 처리한다. 네트워크 성공은 요구하지 않는다.
 * 실제 렌더러/런타임 연결은 주입한 hooks와 IPC에서 담당한다.
 */
export class ProfileService {
  private busy = false;
  private historicalRestore:symbol | null=null;
  private storageMaintenance=false;
  private lastStatus:PlayProfileStatus | undefined;
  private sessionKey: string | null = null;
  private pendingSessionKey:string | null=null;
  private sessionId:string | null=null;
  // 이전 실행의 선택을 자동 재사용하지 않는다. 저장 실패 중에도 마지막 프로필로 쓰지 않는다.
  private selectionPending=true;
  private sessionRevision=0;
  constructor(readonly store:ApplicationData,private readonly config:ProfileConfiguration,
    private readonly hooks:ProfileServiceHooks = {}) {}

  status(): PlayProfileStatus {
    if (this.storageMaintenance && !this.store.database.open && this.lastStatus) return {...this.lastStatus,busy:true};
    const config = this.config.load();
    const value={profiles:this.store.list(),activeProfileId:config.activePlayProfileId || '',
      selectionRequired:this.selectionPending || config.profileSelectionRequired !== false,sessionId:this.sessionId,
      busy:this.busy,pendingSessions:this.store.pendingSessions()};
    this.lastStatus=value;return value;
  }

  private notify(): void { this.hooks.changed?.(this.status()); }
  /** 원격 이름/서버/삭제의 명시적 수락 전 기록을 선택 대기로 돌린다. 세션 ID는 유지한다. */
  requireSyncSelection():void {
    if (this.busy) throw this.busyError();
    this.hooks.beforeTransition?.();
    this.selectionPending=true;this.hooks.pendingSelection?.();
    if (!this.config.saveConfirmed({profileSelectionRequired:true})) throw new Error('프로필 선택 대기를 저장하지 못했습니다.');
    this.store.setRecordContext(null,this.sessionId);this.notify();
  }
  refreshAfterSync(previous:AppConfig):void {
    this.config.refreshFromPersistence();
    this.hooks.afterTransition?.(previous,this.config.load());this.notify();
  }
  private fail(error:unknown): PlayProfileResult {
    return {success:false,error:error instanceof Error ? error.message : String(error),status:this.status()};
  }

  isHistoricalRestoreActive():boolean {return this.historicalRestore!==null;}
  isStorageMaintenanceActive():boolean {return this.storageMaintenance;}
  private busyError():Error {return new Error(this.storageMaintenance ? '데이터를 복구 중입니다. 완료 후 다시 시도해 주세요.' : this.historicalRestore ? '과거 로그를 복원 중입니다. 완료 후 다시 시도해 주세요.' : '프로필 전환 중입니다.');}

  beginStorageMaintenance():{finish(apply:(payload:unknown,eventId:string)=>unknown):void} {
    if (this.busy) throw this.busyError();
    this.busy=true;this.storageMaintenance=true;
    try {this.hooks.beforeTransition?.();if (!this.config.flushPending()) throw new Error('복구 전 설정을 저장하지 못했습니다.');this.notify();}
    catch (error) {this.busy=false;this.storageMaintenance=false;throw error;}
    return {finish:apply=>{
      if (!this.storageMaintenance) return;
      try {const status=this.status();if (!status.selectionRequired && status.sessionId) this.applyRecords(status.sessionId,status.activeProfileId,apply)();}
      finally {this.busy=false;this.storageMaintenance=false;this.notify();}
    }};
  }

  /** 복원은 시작 당시 프로필/세션에 고정한다. 전환/삭제는 직렬화하고 그동안 수신한
   * 원래 세션의 기록은 종료 시 재생한다. 게임 재시작으로 생긴 새 미선택 세션은 배정하지 않는다. */
  beginHistoricalRestore(expectedId:unknown):{profileId:string;sessionId:string | null;config:AppConfig;finish(apply:(payload:unknown,eventId:string)=>unknown,allowReplay?:boolean):string | undefined} {
    const status=this.status(),profile=status.profiles.find(item=>item.id===status.activeProfileId);
    if (status.busy) throw new Error('진행 중인 프로필 작업을 마친 뒤 복원해 주세요.');
    if (status.selectionRequired || typeof expectedId!=='string' || expectedId!==status.activeProfileId || !profile?.name.trim() || !isProfileServer(profile.userServer)) throw new Error('복원할 프로필을 먼저 선택해 주세요.');
    const token=Symbol('historical-restore');this.historicalRestore=token;this.busy=true;
    let snapshot:AppConfig;
    try {this.hooks.beforeTransition?.();if (!this.config.flushPending()) throw new Error('복원 전 설정을 저장하지 못했습니다.');snapshot=structuredClone(this.config.load());this.notify();}
    catch (error) {this.historicalRestore=null;this.busy=false;this.notify();throw error;}
    return {profileId:profile.id,sessionId:status.sessionId,config:snapshot,finish:(apply,allowReplay=true)=>{
      if (this.historicalRestore!==token) return;
      let warning:string | undefined;
      try {
        if (allowReplay && status.sessionId && this.config.load().activePlayProfileId===profile.id && this.store.database.open) this.applyRecords(status.sessionId,profile.id,apply)();
      } catch {warning='복원 중 감지한 자동 기록은 대기열에 보존했습니다. 프로필을 다시 선택해 반영해 주세요.';}
      finally {this.historicalRestore=null;this.busy=false;if (allowReplay) this.notify();}
      return warning;
    }};
  }

  beginSession(key:string): PlayProfileStatus {
    if (this.sessionKey === key) return this.status();
    this.selectionPending=true;
    if (this.pendingSessionKey!==key) {this.sessionId=randomUUID();this.pendingSessionKey=key;++this.sessionRevision;}
    this.hooks.beforeTransition?.();
    this.hooks.pendingSelection?.();
    if (!this.config.saveConfirmed({profileSessionId:this.sessionId || undefined,profileSelectionRequired:true})) {
      throw new Error('프로필 선택 대기 상태를 저장하지 못했습니다.');
    }
    this.sessionKey = key;
    this.pendingSessionKey=null;
    this.store.setRecordContext(null,this.sessionId);
    this.notify();
    return this.status();
  }

  endSession(): void {
    ++this.sessionRevision;
    this.selectionPending=true;
    this.hooks.beforeTransition?.();
    this.hooks.pendingSelection?.();
    this.store.setRecordContext(null,null);
    if (!this.config.saveConfirmed({profileSelectionRequired:true})) throw new Error('게임 종료 기록을 저장하지 못했습니다.');
    this.sessionKey = null;
    this.pendingSessionKey=null;this.sessionId=null;
    this.notify();
  }

  /** 파서 배급 전 gate. 순수 채팅은 호출자가 이 gate에 전달하지 않는다. */
  dispatch(payload:unknown,apply:(payload:unknown,eventId:string) => unknown,occurredAt=Date.now(),eventId?:string): void {
    const config=this.config.load();
    const session=this.sessionId || 'outside-game-unassigned';
    if (!this.sessionId || this.selectionPending || config.profileSelectionRequired !== false || this.busy) {
      this.store.enqueue(session,payload,occurredAt,eventId);
      this.notify();
      return;
    }
    const ready=this.config.flushPending();
    let error:unknown,committed:() => void=() => {};
    // enqueue와 ACK를 한 번의 commit으로 저장한다. 소비자 실패는 savepoint만 취소해
    // 대기 원본은 남기고, 화면·소리는 바깥 commit까지 성공한 뒤 반영한다.
    try {
      this.store.database.transaction(() => {
        this.store.enqueue(session,payload,occurredAt,eventId);
        try {
          if (!ready) throw new Error('자동 기록 전 대기 설정을 저장하지 못했습니다.');
          committed=this.applyRecords(session,config.activePlayProfileId!,apply);
        } catch (failure) {error=failure;}
      })();
    } catch (failure) {this.config.refreshFromPersistence();this.notify();throw failure;}
    if (error) {this.notify();throw error;}
    committed();
  }

  private applyRecords(session:string,profileId:string,apply:(payload:unknown,eventId:string) => unknown,automatic=true):() => void {
    if (!this.config.flushPending()) throw new Error('자동 기록 전 대기 설정을 저장하지 못했습니다.');
    const effects:Array<() => void>=[];
    try {
      this.store.withAutomaticSyncChange(()=>this.store.withRecordContext(profileId,session,() => this.store.assignPending(session,profileId,(payload,eventId) => {
        const effect=apply(payload,eventId);
        if (effect && typeof (effect as Promise<unknown>).then==='function') throw new Error('자동 기록은 동기 transaction에서 처리해야 합니다.');
        if (typeof effect==='function') effects.push(effect as () => void);
      })),automatic);
    } catch (error) {this.config.refreshFromPersistence();throw error;}
    return () => {for (const effect of effects) {try {effect();} catch (error) {log(`[PROFILE] 기록 저장 후 화면 반영 실패: ${String(error)}`);}}};
  }

  async select(id:string,applyPending:(payload:unknown,eventId:string) => unknown): Promise<PlayProfileResult> {
    if (this.busy) return this.fail(this.busyError());
    this.busy=true; this.notify();
    let previous:AppConfig | undefined;
    let transitioned = false;
    let failure:unknown;
    let warning:string | undefined;
    const wasPending=this.selectionPending;
    const sessionRevision=this.sessionRevision;
    try {
      const profile = this.store.list().find(p => p.id===id);
      if (!profile) throw new Error('프로필을 찾을 수 없습니다.');
      assertProfileName(profile.name);
      if (!isProfileServer(profile.userServer)) throw new Error('서버를 선택하세요.');
      if (this.hooks.prepareTransition && !await this.hooks.prepareTransition(id,'select')) throw new Error('프로필 전환을 취소했습니다.');
      if (sessionRevision!==this.sessionRevision) throw new Error('게임 실행 상태가 바뀌었습니다. 프로필을 다시 선택해 주세요.');
      this.hooks.beforeTransition?.();
      if (!this.config.flushPending()) throw new Error('기존 프로필을 저장하지 못했습니다.');
      previous = this.config.load();
      if (!this.config.saveConfirmed({activePlayProfileId:id,profileSelectionRequired:false})) throw new Error('프로필 전환을 저장하지 못했습니다.');
      transitioned = true;
      const next = this.config.load();
      this.store.setRecordContext(id,this.sessionId);
      this.hooks.afterTransition?.(previous,next);
      this.selectionPending=false;
      if (this.sessionId) {
        try {
          this.applyRecords(this.sessionId,id,applyPending)();
        } catch {
          this.config.refreshFromPersistence();
          warning = '프로필은 선택됐지만 대기 기록을 반영하지 못했습니다. 기록은 보존되어 다시 시도할 수 있습니다.';
        }
      }
    } catch (error) {
      failure = error;
      if (transitioned && previous) {
        if (this.config.saveConfirmed({activePlayProfileId:previous.activePlayProfileId,
          profileSelectionRequired:previous.profileSelectionRequired})) {
          this.store.setRecordContext(wasPending || previous.profileSelectionRequired ? null : previous.activePlayProfileId || null,
            this.sessionId);
          this.selectionPending=wasPending;
          try { this.hooks.afterTransition?.(this.config.load(),previous); } catch { /* 기존 값은 디스크에 복구됨 */ }
        } else {this.selectionPending=true;failure = new Error('프로필 전환 실패 후 이전 선택을 복구하지 못했습니다. 앱을 다시 실행해 주세요.');}
      }
      // 선택이 유지된 전환 취소 중 들어온 기록은 기존 프로필에 반영한다.
      if (!this.selectionPending && this.sessionId && this.config.load().profileSelectionRequired===false) {
        const current=this.config.load();
        try {this.applyRecords(this.sessionId,current.activePlayProfileId!,applyPending)();}
        catch {this.config.refreshFromPersistence();}
      }
    }
    finally {
      try {await this.hooks.transitionFinished?.(!failure);} catch (error) {log(`[PROFILE] 전환 창 정리 실패: ${String(error)}`);}
      this.busy=false;this.notify();
    }
    return failure ? this.fail(failure) : {success:true,error:warning,status:this.status()};
  }

  create(name:string,userServer:number,copySettingsFrom?:string): PlayProfileResult {
    if (this.busy) return this.fail(this.busyError());
    try {
      if (!this.config.flushPending()) throw new Error('기존 설정을 저장하지 못했습니다.');
      const profile=this.store.create(name,userServer,copySettingsFrom);
      this.notify();
      return {success:true,profileId:profile.id,status:this.status()};
    } catch (error) { return this.fail(error); }
  }

  update(id:string,name:string,userServer:number): PlayProfileResult {
    if (this.busy) return this.fail(this.busyError());
    try {
      if (!this.config.flushPending()) throw new Error('기존 설정을 저장하지 못했습니다.');
      const previous = this.config.load();
      this.store.update(id,name,userServer);
      this.config.refreshFromPersistence();
      if (previous.activePlayProfileId===id) this.hooks.afterTransition?.(previous,this.config.load());
      this.notify();
      return {success:true,status:this.status()};
    } catch (error) { return this.fail(error); }
  }

  reorder(ids:readonly string[]):PlayProfileResult {
    if(this.busy)return this.fail(this.busyError());
    try {this.store.setProfileOrder(ids);this.notify();return {success:true,status:this.status()};}
    catch(error) {return this.fail(error);}
  }

  /** 무시는 프로필 선택 전에도 가능하지만 현재 플레이 세션과 전환/복원 중인 기록은 건드리지 않는다. */
  ignoreSession(sessionId:string,snapshotToken:string):PlayProfileResult {
    if(this.busy)return this.fail(this.busyError());
    if(sessionId===this.sessionId)return this.fail(new Error('현재 플레이의 기록은 무시할 수 없습니다.'));
    try {
      this.store.ignorePendingSession(sessionId,snapshotToken);this.notify();
      return {success:true,status:this.status()};
    } catch(error) {return this.fail(error);}
  }

  assignSession(sessionId:string,apply:(payload:unknown,eventId:string) => unknown): PlayProfileResult {
    const status = this.status();
    if (this.busy || status.selectionRequired) return this.fail(new Error('기록을 배정할 프로필을 먼저 선택하세요.'));
    try {
      this.applyRecords(sessionId,status.activeProfileId,apply,false)();
      this.notify();
      return {success:true,status:this.status()};
    } catch (error) { return this.fail(error); }
  }

  async remove(id:string): Promise<PlayProfileResult> {
    if (this.busy) return this.fail(this.busyError());
    this.busy=true;this.notify();
    let failure:unknown;
    const sessionRevision=this.sessionRevision;
    try {
      this.hooks.assertCanDelete?.(id);
      const previous=this.config.load();
      if (previous.activePlayProfileId===id && this.hooks.prepareTransition && !await this.hooks.prepareTransition(id,'delete')) {
        throw new Error('프로필 삭제를 취소했습니다.');
      }
      if (sessionRevision!==this.sessionRevision) throw new Error('게임 실행 상태가 바뀌었습니다. 삭제할 프로필을 다시 확인해 주세요.');
      this.hooks.beforeTransition?.();
      if (!this.config.flushPending()) throw new Error('기존 설정을 저장하지 못했습니다.');
      const committed=this.store.removeAndCommitConfiguration(id,this.config.load());
      this.config.acceptPersistentCommit(committed);
      this.selectionPending=this.selectionPending || committed.profileSelectionRequired !== false;
      this.store.setRecordContext(committed.profileSelectionRequired ? null : committed.activePlayProfileId || null,
        this.sessionId);
      try {this.hooks.afterTransition?.(previous,committed);} catch { /* 다음 화면 수신에서 재반영 */ }
    } catch (error) {failure=error;}
    finally {
      try {await this.hooks.transitionFinished?.(!failure);} catch (error) {log(`[PROFILE] 전환 창 정리 실패: ${String(error)}`);}
      this.busy=false;this.notify();
    }
    return failure ? this.fail(failure) : {success:true,status:this.status()};
  }
}
