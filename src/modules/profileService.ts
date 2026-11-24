import { randomUUID } from 'crypto';
import type { AppConfig } from '../shared/types';
import type { PlayProfileResult, PlayProfileStatus } from '../shared/playProfiles';
import { assertProfileName, isProfileServer } from '../shared/playProfiles';
import {log} from './logger';
import type { ApplicationData, UnassignedReplayScope } from './applicationData';

export interface ProfileConfiguration {
  load(): AppConfig;
  saveConfirmed(patch: Partial<AppConfig>): boolean;
  flushPending(): boolean;
  refreshFromPersistence(): void;
  acceptPersistentCommit(value:AppConfig): void;
}

export type ProfileInputBoundary='selection' | 'switch' | 'end' | 'replacement';
export type ProfileReplay=(payload:unknown,eventId:string,pendingAssignment?:boolean)=>unknown;
export interface LiveProfileRecord {
  payload:unknown;
  occurredAt:number;
  eventId:string;
  unassigned?:boolean;
}
const REPLAY_BATCH_SIZE=128;
const LIVE_RECORD_RETRY_MS=1000;

export interface ProfileServiceHooks {
  /** 미저장 초안은 저장/버리기/취소를 여기서 처리한다. false면 전환하지 않는다. */
  prepareTransition?: (nextProfileId:string,operation:'select' | 'delete') => Promise<boolean>;
  assertTransitionCurrent?: () => void;
  transitionFinished?: (committed:boolean) => void | Promise<void>;
  /** 비활성 프로필 삭제도 실행 중인 측정/작업을 확인한다. 변경 없이 오류로 취소할 수 있다. */
  assertCanDelete?: (profileId:string) => void;
  /** 이전 프로필에 속한 집계 버퍼를 flush한 뒤 호출을 완료해야 한다. */
  beforeTransition?: () => void;
  afterTransition?: (previous:AppConfig,next:AppConfig) => void;
  changed?: (status:PlayProfileStatus) => void;
  pendingSelection?:() => void;
  flushPendingInput?:(kind:ProfileInputBoundary)=>void | Promise<void>;
  commitInputBoundary?:()=>void;
}

/**
 * 기능 계약 — 프로필 선택과 플레이 세션
 * 선택 상태는 기기 전용이다. 새 게임 세션/실행 중 앱 시작은 명시적 선택이 필요하고
 * 최소화 복귀는 같은 세션을 유지한다. 미선택 이벤트는 DB에 대기하며 선택 후 현재 세션만
 * 귀속한다. 이미 선택된 상태에서는 전환 확인 중에도 현재 프로필에 기록하며, 저장 실패
 * 원본에는 소유자를 보존한다. 일지 반영에 실패한 원본은 같은 세션·프로필에서 자동으로
 * 재시도하고, 이전 세션은 명시적 assignSession으로만 처리한다.
 * 실제 렌더러/런타임 연결은 주입한 hooks와 IPC에서 담당한다. 회귀: check-profile-lifecycle.ts.
 */
export class ProfileService {
  private busy = false;
  private endingSession=false;
  private get transitionBusy():boolean {return this.busy || this.endingSession;}
  private historicalRestore:symbol | null=null;
  private storageMaintenance=false;
  private lastStatus:PlayProfileStatus | undefined;
  private sessionKey: string | null = null;
  private pendingSessionKey:string | null=null;
  private sessionId:string | null=null;
  private unassignedBatchId=randomUUID();
  // 이전 실행의 선택을 자동 재사용하지 않는다. 저장 실패 중에도 마지막 프로필로 쓰지 않는다.
  private selectionPending=true;
  private sessionRevision=0;
  private syncSelectionRevision=0;
  private replayProgress:PlayProfileStatus['pendingReplay'];
  private selectingReplaySession:string | null=null;
  /** 현재 세션의 선택 전(미배정) 기록 중 rowid가 (afterRowId, throughRowId]인 구간을 가져간 프로필.
   * 선택 대기 구간을 끝낸 선택만 그 구간을 가져가며, 같은 세션에서 다른 프로필로 전환해도 넘기지 않는다.
   * 그 프로필을 다시 선택하면 구간에 남은 기록(건너뜀·반영 실패분)을 다시 시도한다. 남은 기록은
   * 세션이 끝나면 이전 기록 목록에서 직접 배정하거나 무시할 수 있다. */
  private unassignedReplay:{sessionId:string;profileId:string;afterRowId:number;throughRowId:number} | null=null;
  private replayStopped=false;
  private liveRecordRetry?:NodeJS.Timeout;
  constructor(readonly store:ApplicationData,private readonly config:ProfileConfiguration,
    private readonly hooks:ProfileServiceHooks = {}) {}

  status(): PlayProfileStatus {
    if (this.storageMaintenance && !this.store.database.open && this.lastStatus) return {...this.lastStatus,busy:true};
    const config = this.config.load();
    const value={profiles:this.store.list(),activeProfileId:config.activePlayProfileId || '',
      selectionRequired:this.selectionPending || config.profileSelectionRequired !== false,sessionId:this.sessionId,
      busy:this.transitionBusy,pendingSessions:this.store.pendingSessions(),...(this.replayProgress && {pendingReplay:this.replayProgress})};
    this.lastStatus=value;return value;
  }

  get currentSessionId():string | null {return this.sessionId;}
  stopPendingReplay():void {
    this.replayStopped=true;
    clearTimeout(this.liveRecordRetry);
    this.liveRecordRetry=undefined;
  }
  get selectedProfileId():string | null {
    const config=this.config.load();
    return !this.selectionPending && config.profileSelectionRequired===false ? config.activePlayProfileId || null : null;
  }

  private queuedPendingUpdate?:NodeJS.Timeout;
  private notify(): void {
    if (this.queuedPendingUpdate) clearTimeout(this.queuedPendingUpdate);
    this.queuedPendingUpdate=undefined;
    if (this.store.database.open || this.storageMaintenance) this.hooks.changed?.(this.status());
  }

  private notifyPending():void {
    if (!this.hooks.changed || this.queuedPendingUpdate) return;
    this.queuedPendingUpdate=setTimeout(()=>{
      this.queuedPendingUpdate=undefined;
      if (this.store.database.open) this.notify();
    },100);
    this.queuedPendingUpdate.unref();
  }
  /** 원격 교체와 함께 선택 대기가 확정된 뒤 다음 자동 기록의 귀속을 해제한다. */
  acceptSyncSelection():void {
    ++this.syncSelectionRevision;
    this.selectionPending=true;
    this.store.setRecordContext(null,this.sessionId);
    this.hooks.commitInputBoundary?.();
  }
  getSyncSelectionRevision():number {return this.syncSelectionRevision;}

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

  beginStorageMaintenance():{
    flushSelectionInput(apply:ProfileReplay):void | Promise<void>;
    finish(apply:ProfileReplay):void;
  } {
    if (this.transitionBusy) throw this.busyError();
    this.busy=true;this.storageMaintenance=true;
    try {this.hooks.beforeTransition?.();if (!this.config.flushPending()) throw new Error('복구 전 설정을 저장하지 못했습니다.');this.notify();}
    catch (error) {this.busy=false;this.storageMaintenance=false;throw error;}
    const flushSelectionInput=(apply:ProfileReplay)=>{
      const owner=this.selectedProfileId,session=this.sessionId,revision=this.sessionRevision;
      const finish=()=>{
        if (revision!==this.sessionRevision || owner!==this.selectedProfileId || session!==this.sessionId) {
          throw new Error('플레이 세션이 바뀌었습니다. 데이터를 다시 확인해 주세요.');
        }
        if (owner && session) this.applyRecords(session,owner,apply)();
        this.hooks.beforeTransition?.();
        if (!this.config.flushPending()) throw new Error('이전 프로필 기록을 저장하지 못했습니다.');
      };
      const input=this.hooks.flushPendingInput?.('switch');
      return input ? input.then(finish) : finish();
    };
    return {flushSelectionInput,finish:apply=>{
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
    this.observeSession(key);
    return this.status();
  }

  get needsGameSelection():boolean {return !this.transitionBusy && this.selectionPending;}

  observeSession(key:string):void {
    if (this.sessionKey === key) return;
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
    this.unassignedBatchId=randomUUID();
    this.notify();
  }

  endSession(kind:'end' | 'replacement'='end'): void | Promise<void> {
    ++this.sessionRevision;
    const failed=(error:unknown)=>log(`[PROFILE] 세션 종료 시 마지막 로그 반영 실패: ${String(error)}`);
    let pending:void | Promise<void>=undefined;
    try {pending=this.hooks.flushPendingInput?.(kind);}
    catch (error) {failed(error);}
    if (pending) {
      this.endingSession=true;
      return pending.catch(failed).then(()=>this.finishSession()).finally(()=>{this.endingSession=false;this.notify();});
    }
    this.finishSession();
  }

  private finishSession():void {
    this.selectionPending=true;
    this.hooks.beforeTransition?.();
    this.hooks.pendingSelection?.();
    this.store.setRecordContext(null,null);
    if (!this.config.saveConfirmed({profileSelectionRequired:true})) throw new Error('게임 종료 기록을 저장하지 못했습니다.');
    this.sessionKey = null;
    this.pendingSessionKey=null;this.sessionId=null;
    this.unassignedBatchId=randomUUID();
    this.notify();
  }

  /** 파서 배급 전 gate. 순수 채팅은 호출자가 이 gate에 전달하지 않는다. */
  dispatch(payload:unknown,apply:ProfileReplay,occurredAt=Date.now(),eventId?:string,unassigned=false): void {
    const session=(!unassigned && this.sessionId) || this.unassignedSession(payload,occurredAt);
    const owner=!unassigned && this.sessionId ? this.selectedProfileId : null;
    if (!owner || this.storageMaintenance || this.historicalRestore || this.selectingReplaySession===session) {
      this.store.enqueue(session,payload,occurredAt,eventId,owner);
      this.notifyPending();
      return;
    }
    const ready=this.config.flushPending();
    let error:unknown,committed:() => void=() => {};
    // enqueue와 ACK를 한 번의 commit으로 저장한다. 소비자 실패는 savepoint만 취소해
    // 대기 원본은 남기고, 화면·소리는 바깥 commit까지 성공한 뒤 반영한다.
    try {
      this.store.database.transaction(() => {
        this.store.enqueue(session,payload,occurredAt,eventId,owner);
        try {
          if (!ready) throw new Error('자동 기록 전 대기 설정을 저장하지 못했습니다.');
          committed=this.applyRecords(session,owner,apply);
        } catch (failure) {error=failure;}
      })();
    } catch (failure) {this.config.refreshFromPersistence();this.notify();throw failure;}
    if (error) {this.notify();throw error;}
    committed();
  }

  /** A line is safe to advance once all its persistent events have been stored together.
   * Applying the line uses separate commits so a failed record does not rewind the tail. */
  acceptLiveLine(records:readonly LiveProfileRecord[],apply:ProfileReplay):void {
    if (!records.length) return;
    const session=this.sessionId,owner=this.selectedProfileId;
    let hasOwnedRecords=false;
    this.store.database.transaction(()=>{
      for (const record of records) {
        const {payload,occurredAt,eventId,unassigned}=record;
        const assigned=!unassigned && session ? owner : null;
        hasOwnedRecords ||= !!assigned;
        if (this.store.eventRecordState(eventId)) continue;
        this.store.enqueue((!unassigned && session) || this.unassignedSession(payload,occurredAt),payload,occurredAt,eventId,assigned);
      }
    })();
    if (hasOwnedRecords && session && owner && !this.storageMaintenance && !this.historicalRestore
      && this.selectingReplaySession!==session) this.applyOwnedLiveRecords(session,owner,apply);
    else this.notifyPending();
  }

  private applyOwnedLiveRecords(session:string,profileId:string,apply:ProfileReplay):boolean {
    try {
      let blocked=false;
      // Quest starts and XP share tracker state. Keep their order, independently of
      // standalone SEED records and other checklist/runtime callbacks.
      for (const group of ['profile','experience','seed'] as const) {
        let id:string | undefined;
        try {
          while ((id=this.store.nextOwnedLiveRecord(session,profileId,group))!==undefined) {
            const eventId=id;
            this.commitRecords(session,profileId,apply,write=>this.store.assignOwnedLiveRecord(session,profileId,eventId,write))();
          }
        } catch (error) {
          blocked=true;
          log(`[PROFILE] 저장된 실시간 기록 적용 보류 (${id ?? session}): ${String(error)}`);
        }
      }
      if (blocked) this.scheduleLiveRecordRetry(session,profileId,apply);
      return !blocked;
    } catch (error) {
      this.scheduleLiveRecordRetry(session,profileId,apply);
      log(`[PROFILE] 저장된 실시간 기록 적용 대기: ${String(error)}`);
      return false;
    }
  }

  private scheduleLiveRecordRetry(session:string,profileId:string,apply:ProfileReplay):void {
    this.notifyPending();
    if (this.replayStopped) return;
    clearTimeout(this.liveRecordRetry);
    const sessionRevision=this.sessionRevision;
    const selectionRevision=this.syncSelectionRevision;
    this.liveRecordRetry=setTimeout(()=>{
      this.liveRecordRetry=undefined;
      if (this.sessionId!==session || this.sessionRevision!==sessionRevision || this.syncSelectionRevision!==selectionRevision) return;
      if (this.storageMaintenance || this.historicalRestore || this.selectingReplaySession===session) {
        this.scheduleLiveRecordRetry(session,profileId,apply);
        return;
      }
      if (this.store.database.open && this.selectedProfileId===profileId && this.applyOwnedLiveRecords(session,profileId,apply)) this.notifyPending();
    },LIVE_RECORD_RETRY_MS);
    this.liveRecordRetry.unref();
  }

  private unassignedSession(payload:unknown,occurredAt:number):string {
    const event=payload as {data?:{date?:unknown};source?:{lineKey?:string;start:number}} | null;
    const logDate=event?.data?.date;
    const observed=new Date(occurredAt);
    const day=typeof logDate==='string' && /^\d{4}-\d{2}-\d{2}$/.test(logDate) ? logDate
      : Number.isFinite(observed.getTime()) ? observed.toISOString().slice(0,10) : 'unknown';
    const source=event?.source;
    const lineGroup=source?.lineKey || (source ? String(source.start) : '');
    return `unassigned:${day}:${this.unassignedBatchId}${lineGroup ? `:${lineGroup}` : ''}`;
  }

  retryLiveRecords(record:{sessionId:string;profileId:string | null;resolved:boolean},apply:ProfileReplay):void {
    // 재읽기는 새 선택으로 소유자를 바꾸거나 미선택 대기 기록을 자동 배정하지 않는다.
    if (record.resolved || !record.profileId || record.sessionId!==this.sessionId
      || record.profileId!==this.selectedProfileId || this.storageMaintenance || this.historicalRestore
      || this.selectingReplaySession===record.sessionId) return;
    this.applyRecords(record.sessionId,record.profileId,apply)();
  }

  private applyRecords(session:string,profileId:string,apply:ProfileReplay):() => void {
    return this.commitRecords(session,profileId,apply,record=>this.store.assignPending(session,profileId,record,undefined,false));
  }

  private commitRecords(session:string,profileId:string,apply:ProfileReplay,
    write:(record:(payload:unknown,eventId:string,unassigned:boolean)=>unknown)=>unknown,
    automatic=true,skipped?:Set<string>):() => void {
    if (!this.config.flushPending()) throw new Error('자동 기록 전 대기 설정을 저장하지 못했습니다.');
    const effects:Array<() => void>=[];
    try {
      this.store.withAutomaticSyncChange(()=>this.store.withRecordContext(profileId,session,() => write((payload,eventId,unassigned) => {
        const effect=apply(payload,eventId,unassigned || !automatic);
        if (effect && typeof (effect as Promise<unknown>).then==='function') throw new Error('자동 기록은 동기 transaction에서 처리해야 합니다.');
        if (typeof effect==='string') {
          if (!skipped) throw new Error(effect);
          skipped.add(effect);
          return false;
        }
        if (typeof effect==='function') effects.push(effect as () => void);
      })),automatic);
    } catch (error) {this.config.refreshFromPersistence();throw error;}
    return () => {for (const effect of effects) {try {effect();} catch (error) {log(`[PROFILE] 기록 저장 후 화면 반영 실패: ${String(error)}`);}}};
  }

  /** 프로필 선택과 수동 배정은 SQLite를 한 묶음씩 확정하고 이벤트 루프에 제어를 돌려준다.
   * 수동 배정은 확인한 마지막 행까지만 기록한다. 선택 도중 추가된 같은 세션의 입력은
   * 선택한 소유자로 먼저 보관한 뒤 처리한다. 중단/실패 뒤에는 ACK가 없는 행만 남는다. */
  private async replayBatches(session:string,profileId:string,apply:ProfileReplay,boundary:{lastRowId:number;count:number},
    automatic:boolean,includeUnassigned:UnassignedReplayScope,skipped:Set<string>,stillValid:()=>boolean):Promise<number> {
    let cursor:Parameters<ApplicationData['assignPendingBatch']>[4];
    let assigned=0,processed=0,lastNotification=0;
    try {
      while (boundary.count>0) {
        if (this.replayStopped || !stillValid() || !this.store.database.open) {
          throw new Error('기록 반영을 중단했습니다. 남은 기록은 대기 목록에 보관했습니다.');
        }
        let batch!:ReturnType<ApplicationData['assignPendingBatch']>;
        this.commitRecords(session,profileId,apply,record=>{
          batch=this.store.assignPendingBatch(session,profileId,record,boundary.lastRowId,cursor,includeUnassigned,REPLAY_BATCH_SIZE);
        },automatic,skipped)();
        assigned+=batch.assigned;processed+=batch.processed;
        if (!batch.more || processed>=boundary.count) break;
        cursor=batch.cursor;
        if (Date.now()-lastNotification>=250) {
          lastNotification=Date.now();
          this.replayProgress={processed,total:boundary.count};
          this.notify();
        }
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      return assigned;
    } finally {this.replayProgress=undefined;}
  }

  async select(id:string,applyPending:ProfileReplay): Promise<PlayProfileResult> {
    if (this.transitionBusy) return this.fail(this.busyError());
    this.busy=true; this.notify();
    let previous:AppConfig | undefined;
    let transitioned = false;
    let failure:unknown;
    let warning:string | undefined;
    const wasPending=this.selectionPending;
    const sessionRevision=this.sessionRevision;
    const skipped=new Set<string>();
    let reviewedUnassigned=false;
    const drainPending=async ():Promise<void>=>{
      const sessionId=this.sessionId,active=this.config.load();
      if (sessionRevision!==this.sessionRevision || !sessionId || this.selectionPending
        || active.profileSelectionRequired!==false || !active.activePlayProfileId) return;
      const owner=active.activePlayProfileId;
      const stillValid=()=>sessionRevision===this.sessionRevision && this.selectedProfileId===owner;
      this.selectingReplaySession=sessionId;
      try {
        // 선택 전 기록은 그 선택 대기 구간을 끝낸 프로필의 것이다. A에서 건너뛴 숙제(숨김·N/A)나 반영 실패분이
        // 같은 세션에서 전환한 B에 배정되면 B가 하지 않은 기록이 B의 체크리스트·일지에 남는다.
        // 회귀: check-profile-recording.ts(전환 뒤 남은 선택 전 기록은 새 프로필에 배정하지 않음)
        let includeUnassigned:UnassignedReplayScope=false;
        if (!failure && !reviewedUnassigned) {
          const previous=this.unassignedReplay?.sessionId===sessionId ? this.unassignedReplay : null;
          if (wasPending) {
            // 이번 선택 대기 구간의 기록(이전 구간 뒤)을 가져간다. 이전 구간도 같은 프로필이면 함께 다시 시도한다.
            const afterRowId=previous ? previous.profileId===owner ? previous.afterRowId : previous.throughRowId : 0;
            const throughRowId=this.store.pendingReplayBoundary(sessionId,owner,{afterRowId,throughRowId:Number.MAX_SAFE_INTEGER}).lastRowId;
            includeUnassigned={afterRowId,throughRowId};
            this.unassignedReplay={sessionId,profileId:owner,afterRowId,throughRowId};
          } else if (previous?.profileId===owner) {
            includeUnassigned={afterRowId:previous.afterRowId,throughRowId:previous.throughRowId};
          }
        }
        let boundary=this.store.pendingReplayBoundary(sessionId,owner,includeUnassigned);
        while (boundary.count) {
          await this.replayBatches(sessionId,owner,applyPending,boundary,true,includeUnassigned,skipped,stillValid);
          includeUnassigned=false;
          if (!stillValid()) break;
          const next=this.store.pendingReplayBoundary(sessionId,owner,false);
          if (next.lastRowId<=boundary.lastRowId) break;
          boundary=next;
        }
        reviewedUnassigned=true;
        warning=skipped.size ? `반영하지 못한 기록은 보관했습니다. ${[...skipped].join(' ')}` : undefined;
      } catch (error) {
        log('[PROFILE] 전환 후 대기 기록 반영 실패: '+String(error));
        if (!failure) warning='프로필은 선택됐지만 대기 기록을 반영하지 못했습니다. 기록은 보존되어 다시 시도할 수 있습니다.';
      } finally {this.selectingReplaySession=null;}
    };
    try {
      const profile = this.store.list().find(p => p.id===id);
      if (!profile) throw new Error('프로필을 찾을 수 없습니다.');
      assertProfileName(profile.name);
      if (!isProfileServer(profile.userServer)) throw new Error('서버를 선택하세요.');
      if (this.hooks.prepareTransition && !await this.hooks.prepareTransition(id,'select')) throw new Error('프로필 전환을 취소했습니다.');
      if (sessionRevision!==this.sessionRevision) throw new Error('게임 실행 상태가 바뀌었습니다. 프로필을 다시 선택해 주세요.');
      const active=this.selectedProfileId, switching=!!active && active!==id;
      const previousPendingRow=switching && this.sessionId
        ? this.store.pendingReplayBoundary(this.sessionId,active,false).lastRowId : 0;
      const input=this.hooks.flushPendingInput?.(switching ? 'switch' : 'selection');
      if (input) await input;
      if (sessionRevision!==this.sessionRevision) throw new Error('게임 실행 상태가 바뀌었습니다. 프로필을 다시 선택해 주세요.');
      if (switching && this.sessionId) {
        const applied=this.applyOwnedLiveRecords(this.sessionId,active,applyPending);
        // 기존 대기 기록은 원래 소유자에게 남긴다. 이번 경계에서 새로 읽은 기록은 저장 후 전환한다.
        if (!applied && this.store.pendingReplayBoundary(this.sessionId,active,false).lastRowId>previousPendingRow) {
          throw new Error('기존 프로필의 실시간 기록을 저장하지 못했습니다. 잠시 후 다시 선택해 주세요.');
        }
        this.commitRecords(this.sessionId,active,applyPending,
          record=>this.store.assignPending(this.sessionId!,active,record,undefined,false,false))();
      }
      this.hooks.beforeTransition?.();
      if (!this.config.flushPending()) throw new Error('기존 프로필을 저장하지 못했습니다.');
      previous = this.config.load();
      this.hooks.assertTransitionCurrent?.();
      if (!this.config.saveConfirmed({activePlayProfileId:id,profileSelectionRequired:false})) throw new Error('프로필 전환을 저장하지 못했습니다.');
      transitioned = true;
      const next = this.config.load();
      this.store.setRecordContext(id,this.sessionId);
      this.hooks.afterTransition?.(previous,next);
      this.selectionPending=false;
      if (switching) this.hooks.commitInputBoundary?.();
      await drainPending();
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
    } finally {
      try {
        try {await this.hooks.transitionFinished?.(!failure);} catch (error) {log('[PROFILE] 전환 창 정리 실패: '+String(error));}
        // 첫 선택 대기나 저장 실패로 남은 현재 세션 기록을 한 번 더 확인한다.
        await drainPending();
      } finally {this.busy=false;this.notify();}
    }
    return failure ? this.fail(failure) : {success:true,error:warning,status:this.status()};
  }

  create(name:string,userServer:number,copySettingsFrom?:string): PlayProfileResult {
    if (this.transitionBusy) return this.fail(this.busyError());
    try {
      if (!this.config.flushPending()) throw new Error('기존 설정을 저장하지 못했습니다.');
      const profile=this.store.create(name,userServer,copySettingsFrom);
      this.notify();
      return {success:true,profileId:profile.id,status:this.status()};
    } catch (error) { return this.fail(error); }
  }

  update(id:string,name?:string,userServer?:number): PlayProfileResult {
    if (this.transitionBusy) return this.fail(this.busyError());
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
    if(this.transitionBusy)return this.fail(this.busyError());
    try {this.store.setProfileOrder(ids);this.notify();return {success:true,status:this.status()};}
    catch(error) {return this.fail(error);}
  }

  /** 무시는 프로필 선택 전에도 가능하지만 현재 플레이 세션과 전환/복원 중인 기록은 건드리지 않는다. */
  releaseOrphanedSession(sessionId:string,snapshotToken:string):PlayProfileResult {
    if (this.transitionBusy) return this.fail(this.busyError());
    if (sessionId===this.sessionId) return this.fail(new Error('현재 플레이의 기록은 이동할 수 없습니다.'));
    try {
      if (!this.store.releaseOrphanedPendingSession(sessionId,snapshotToken)) throw new Error('삭제된 프로필에 연결된 기록이 없습니다.');
      this.notify();return {success:true,status:this.status()};
    } catch (error) {return this.fail(error);}
  }

  ignoreSession(sessionId:string,snapshotToken:string):PlayProfileResult {
    if(this.transitionBusy)return this.fail(this.busyError());
    if(sessionId===this.sessionId)return this.fail(new Error('현재 플레이의 기록은 무시할 수 없습니다.'));
    try {
      this.store.ignorePendingSession(sessionId,snapshotToken);this.notify();
      return {success:true,status:this.status()};
    } catch(error) {return this.fail(error);}
  }

  /** 확인 화면의 대상과 스냅샷을 고정한다. 새 플레이의 자동 배정은 별도 경로에서 처리한다. */
  async assignSession(sessionId:string,profileId:string,snapshotToken:string,apply:ProfileReplay): Promise<PlayProfileResult> {
    const status = this.status();
    if (this.transitionBusy || status.selectionRequired) return this.fail(new Error('기록을 배정할 프로필을 먼저 선택하세요.'));
    if (profileId!==status.activeProfileId) return this.fail(new Error('사용 중인 프로필이 변경되었습니다. 배정 대상을 다시 확인해 주세요.'));
    if (sessionId===this.sessionId || !/^[a-f0-9]{64}$/.test(snapshotToken)) return this.fail(new Error('배정할 이전 기록을 다시 확인해 주세요.'));
    this.busy=true;
    this.notify();
    let success=false,error:string | undefined;
    try {
      const snapshot=this.store.pendingSessionSnapshot(sessionId);
      if (snapshot?.token!==snapshotToken) throw new Error('대기 기록이 변경되었습니다. 내용을 다시 확인한 뒤 배정해 주세요.');
      const skipped=new Set<string>();
      const boundary=this.store.pendingReplayBoundary(sessionId,profileId,true);
      const applied=await this.replayBatches(sessionId,profileId,apply,boundary,false,true,skipped,()=>this.config.load().activePlayProfileId===profileId);
      const remaining=snapshot.count-applied;
      success=applied>0 || remaining===0;
      if (remaining) {
        if (!skipped.size) skipped.add('기록을 감지했을 때 사용하던 프로필을 선택해 반영해 주세요.');
        error=(applied ? '반영 '+applied+'건 · ' : '')+'미배정 '+remaining+'건을 보관했습니다. '+[...skipped].join(' ');
      }
    } catch (failure) {error=failure instanceof Error ? failure.message : String(failure);}
    finally {this.busy=false;this.notify();}
    return {success,error,status:this.status()};
  }

  async remove(id:string): Promise<PlayProfileResult> {
    if (this.transitionBusy) return this.fail(this.busyError());
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
      const removingActive=this.selectedProfileId===id;
      const input=this.hooks.flushPendingInput?.(removingActive ? 'switch' : 'selection');
      if (input) await input;
      if (sessionRevision!==this.sessionRevision) throw new Error('게임 실행 상태가 바뀌었습니다. 삭제할 프로필을 다시 확인해 주세요.');
      if (this.store.hasPendingForProfile(id)) throw new Error('이 프로필에 저장할 자동 기록이 남아 있습니다. 먼저 기록을 반영해 주세요.');
      this.hooks.beforeTransition?.();
      if (!this.config.flushPending()) throw new Error('기존 설정을 저장하지 못했습니다.');
      this.hooks.assertTransitionCurrent?.();
      const committed=this.store.removeAndCommitConfiguration(id,this.config.load());
      this.config.acceptPersistentCommit(committed);
      this.selectionPending=this.selectionPending || committed.profileSelectionRequired !== false;
      this.store.setRecordContext(committed.profileSelectionRequired ? null : committed.activePlayProfileId || null,
        this.sessionId);
      if (removingActive) this.hooks.commitInputBoundary?.();
      try {this.hooks.afterTransition?.(previous,committed);} catch { /* 다음 화면 수신에서 재반영 */ }
    } catch (error) {failure=error;}
    finally {
      try {await this.hooks.transitionFinished?.(!failure);} catch (error) {log(`[PROFILE] 전환 창 정리 실패: ${String(error)}`);}
      this.busy=false;this.notify();
    }
    return failure ? this.fail(failure) : {success:true,status:this.status()};
  }
}
