import {PROFILE_SYNC_POLICY,type ProfileSyncConnectionChoice,type ProfileSyncDetails,type ProfileSyncEnvelope,type SyncValue} from '../shared/profileSync';
import {ProfileSyncModel,localSyncProfileId,mergeSyncValues,selectSyncWinner} from './profileSyncModel';
import {InvalidProfileDriveFile,ProfileDriveError,ProfileDriveNetworkError,type ProfileSyncTransport,type ProfileDriveFile} from './profileSyncDrive';
import {isProfileServer} from '../shared/playProfiles';
import {isDeepStrictEqual} from 'util';

interface CachedFile {file:ProfileDriveFile;envelope:ProfileSyncEnvelope}
/** serverBackoff: 서버가 대기를 지시한 실패(429·Retry-After). 종료 전송도 이 대기는 지킨다. */
interface AccountRetry {at:number;failures:number;networkFailure:boolean;serverBackoff?:boolean;error?:string}
export interface ProfileSyncHooks {
  account():string | null;
  enabled():boolean;
  auto():boolean;
  activeProfile():string | undefined;
  ready():boolean;
  beforeImport(choice:ProfileSyncConnectionChoice):Promise<((committed:boolean)=>Promise<void>) | void>;
  apply(action:()=>void,requireSelection?:boolean | string,deletingProfileId?:string):Promise<void | string>;
  assertReview?(key:string):void;
  changed():void;
  /** 자동 실행에서도 사용자가 확인해야 할 전송 보류 사실을 기록한다. */
  report?(message:string):void;
}
/** 기능 계약 — 편집 중인 계산기 창 때문에 원격 반영만 미룬다.
 * apply hook이 계산기 창의 작성 중인 입력(프리셋 이름·편집, 저장 실패한 선택)을 확인하지 못하면 이 오류를 던진다.
 * coordinator는 종료 전송과 같은 방식으로 다른 PC의 변경 반영을 미루고(cursor·파일 캐시를 확정하지 않아 다시 받음)
 * 이 PC의 변경은 그대로 전송한다. 실패로 세지 않아 재시도 대기가 늘지 않으며, editorRetryMs 뒤 또는
 * 계산기 저장으로 생긴 전송 예약 때 다시 반영을 시도한다. 안내는 details().remoteDeferred(오류 아님)로 표시한다.
 * 회귀: check-profile-sync.ts(편집 중 원격 반영 보류), check-profile-tools.ts(동기화용 계산기 확인 문구). */
export class ProfileSyncApplyDeferred extends Error {
  constructor(readonly editor:string) {super(`${editor}에서 작성 중인 내용이 있어 Google 동기화 반영을 미뤘습니다.`);this.name='ProfileSyncApplyDeferred';}
}
const deferredNotice=(editor:string)=>`${editor}에서 작성 중인 내용이 있어 Google 동기화 반영(다른 PC 변경·숙제 초기화)을 잠시 미뤘습니다. 이 PC의 변경은 계속 전송하며, 편집을 마치면 다시 반영합니다.`;
/** 앱 단위 single-flight 스케줄러. 저장 성공과 원격 성공은 독립이다.
 * PC별 파일만 쓰고 변경feed로 다른 PC의 변경을 확인한다. cursor/ACK는 성공 후에만 확정한다.
 * 실행 중 ID와 payload를 고정하므로 늦은 응답이 새 로컬 변경을 ACK/덮어쓰지 못한다.
 * 회귀: check-profile-sync.ts。 */
export class ProfileSyncCoordinator {
  private running:Promise<void | string> | null=null;
  private runningAccount:string | null=null;
  private timer:ReturnType<typeof setTimeout> | undefined;
  private started=false;
  private suspended=false;
  private generation=0;
  private active=false;
  private readonly retries=new Map<string,AccountRetry>();
  private networkRevision=0;
  private lastSuccess=0;
  private nextPull=0;
  private lastSelection:string | undefined;
  private uploading=false;
  private flushRequested=false;
  private commandRunning=false;
  private requestSerial=0;
  /** 편집 중인 창 때문에 반영을 미룬 계정·창. 반영하거나 확인 결과를 확정하면 지운다. */
  private remoteDeferral:{account:string;editor:string} | undefined;
  /** 반영을 미룬 원격 파일 본문. 같은 revision을 다시 확인할 때 내려받지 않는다(메모리에만 보관). */
  private readonly heldDownloads=new Map<string,CachedFile>();
  constructor(readonly model:ProfileSyncModel,readonly transport:ProfileSyncTransport,private readonly hooks:ProfileSyncHooks,
    private readonly now=Date.now,private readonly random=Math.random) {}
  private currentRetry():AccountRetry | undefined {
    const account=this.hooks.account();return account ? this.retries.get(account) : undefined;
  }
  get error():string | undefined {return this.currentRetry()?.error;}
  get retryCount():number {return this.currentRetry()?.failures ?? 0;}
  get syncing():boolean {return !!this.running || this.commandRunning;}
  get activity():'upload' | 'checking' {return this.uploading ? 'upload' : 'checking';}
  get lastSyncedAt():number | undefined {return this.model.meta<number | null>('lastSuccess',null) ?? undefined;}
  details():ProfileSyncDetails {
    const metrics=this.transport as ProfileSyncTransport & {requests?:number;uploadedBytes?:number;downloadedBytes?:number};
    const account=this.hooks.account();
    const choice=this.awaitingChoice(account);
    const preview=choice ? this.remotePreview() : undefined;
    const damagedFiles=this.model.meta<ProfileDriveFile[]>('damagedFiles',[]);
    const sameAccount=!!account && this.model.meta('transportAccount','')===account;
    return {version:1,connection:!account || !this.hooks.enabled() ? 'disconnected' : this.model.meta('boundAccount','')===account
      ? 'ready' : choice ? 'choice' : 'checking',pending:this.model.pending(),
      reviews:this.model.reviews(this.hooks.activeProfile()),remoteProfiles:preview?.profiles ?? [],
      remoteIdentityConflicts:preview?.conflicts,damagedFiles:damagedFiles.length,oversizedToolValues:this.model.oversizedToolCount(),
      uploadSizing:sameAccount ? this.model.meta<ProfileSyncDetails['uploadSizing']>('uploadSizing',undefined) ?? undefined : undefined,
      uploadBlocked:sameAccount && this.ownFileIsDamaged(damagedFiles),
      lastCheckedAt:sameAccount ? this.model.meta<number | null>('lastCheckedAt',null) ?? this.lastSyncedAt : undefined,
      lastUploadedAt:sameAccount ? this.model.meta<number | null>('lastUploadedAt',null) ?? undefined : undefined,
      remoteDeferred:sameAccount && this.remoteDeferral?.account===account ? deferredNotice(this.remoteDeferral.editor) : undefined,
      backupAvailable:this.model.meta<boolean>('backupAvailable',false),requests:metrics.requests || 0,
      uploadedBytes:metrics.uploadedBytes || 0,downloadedBytes:metrics.downloadedBytes || 0};
  }
  /** 교체 전에 클라우드 원본만 병합한다. 순서가 불확실한 이름/서버는 임의로 표시하거나 교체하지 않는다. */
  private remotePreview():{profiles:NonNullable<ProfileSyncDetails['remoteProfiles']>;conflicts:number} {
    const files=this.model.meta<Record<string,CachedFile>>('files',{});
    const identities=new Map<string,{name:SyncValue[];server:SyncValue[];deleted:boolean}>();
    for (const {envelope} of Object.values(files)) for (const [key,cell] of Object.entries(envelope.cells)) {
      const [kind,id,field]=JSON.parse(key) as string[];
      if (!(kind==='profile' && (field==='name' || field==='deleted') || kind==='setting' && field==='userServer')) continue;
      const identity=identities.get(id) ?? {name:[],server:[],deleted:false};
      if (field==='deleted') identity.deleted ||= cell.value===true;
      else (field==='name' ? identity.name : identity.server).push(cell);
      identities.set(id,identity);
    }
    const profiles:NonNullable<ProfileSyncDetails['remoteProfiles']>=[];
    let conflicts=0;
    for (const [id,identity] of identities) {
      if (identity.deleted) continue;
      const name=selectSyncWinner(mergeSyncValues(identity.name))?.value;
      const server=selectSyncWinner(mergeSyncValues(identity.server))?.value;
      if (typeof name==='string' && name.trim() && isProfileServer(server)) profiles.push({id,name,server});
      else conflicts++;
    }
    return {profiles:profiles.sort((a,b)=>a.id.localeCompare(b.id)),conflicts};
  }
  private awaitingChoice(account=this.hooks.account()):boolean {
    return !!account && this.model.meta('stagedAccount','')===account && this.model.meta('awaitingChoice',false);
  }
  private ownFileIsDamaged(files:readonly ProfileDriveFile[]):boolean {
    const ownFile=this.model.meta<string | undefined>('ownFile',undefined);
    return files.some(file=>file.id===ownFile || file.appProperties?.device===this.model.device);
  }
  start():void {if (this.started) return;this.started=true;this.nextPull=this.now();this.schedule();}
  stop():void {this.started=false;clearTimeout(this.timer);this.timer=undefined;}
  cancel():void {++this.generation;this.transport.cancel();}
  async suspend():Promise<()=>void> {
    if (this.suspended || this.commandRunning) throw new Error('진행 중인 동기화 데이터 선택을 마친 뒤 복원해 주세요.');this.suspended=true;this.cancel();
    await this.running?.catch(()=>undefined);
    return ()=>{this.suspended=false;this.nextPull=this.now();this.schedule();};
  }
  activityChanged(active:boolean):void {
    if (active===this.active) return;
    this.active=active;
    if (active || this.model.pending()) this.request();else {this.nextPull=this.now()+PROFILE_SYNC_POLICY.idleMs;this.schedule();}
  }
  request():void {
    if (this.now()-this.lastSuccess<2_000 && !this.model.pending()) return;
    ++this.requestSerial;this.nextPull=this.now();this.flushRequested=true;this.schedule();
  }
  networkReconnected():void {
    this.networkRevision++;
    for (const [account,retry] of this.retries) if (retry.networkFailure) this.retries.delete(account);
    this.request();
  }
  /** 자동 감지는 record context로 구분한다. 일반 채팅/일지/기기 변경은 pending을 만들지 않는다. */
  private dueUpload():number {
    if (!this.model.pending() || this.ownFileIsDamaged(this.model.meta<ProfileDriveFile[]>('damagedFiles',[]))) return Infinity;
    const due=(automatic:boolean)=>{
      const kind=automatic ? 'Automatic' : 'User';
      const first=this.model.meta<number | null>(`pending${kind}Since`,null),last=this.model.meta<number | null>(`last${kind}ChangeAt`,null);
      if (!first || !last) return Infinity;
      const idleAutomatic=automatic && !this.active;
      return Math.min(last+(idleAutomatic ? PROFILE_SYNC_POLICY.idleAutoDebounceMs : PROFILE_SYNC_POLICY.userDebounceMs),
        first+(idleAutomatic ? PROFILE_SYNC_POLICY.idleAutoMaxMs : PROFILE_SYNC_POLICY.userMaxMs));
    };
    const planned=Math.min(due(false),due(true));
    return planned===Infinity ? (this.model.meta<number>('pendingSince',this.now()) || this.now())+PROFILE_SYNC_POLICY.userDebounceMs : planned;
  }
  private schedule():void {
    clearTimeout(this.timer);this.timer=undefined;
    if (!this.started || this.suspended || this.awaitingChoice()) return;
    // 화면을 거치지 않는 자동 기록도 같은 앱 타이머에서 확인한다. 이 확인은 API를 호출하지 않는다.
    const allowed=this.hooks.account() && this.hooks.enabled() && this.autoSyncAllowed(this.hooks.account()) && !this.model.meta('localOnly',false);
    const due=allowed ? Math.max(this.currentRetry()?.at ?? 0,Math.min(this.nextPull,this.dueUpload())) : this.now()+1000;
    const delay=Math.max(50,Math.min(1000,due-this.now()));
    this.timer=setTimeout(()=>{void this.runDueWork().catch(()=>undefined).finally(()=>this.schedule());},delay);this.timer.unref?.();
  }
  /** 예약 실행 허용 정책. 자동 동기화가 꺼져 있어도 사용자가 시작한 동기화에서 계산기 편집 때문에 미룬 반영
   * (remoteDeferral)은 편집이 끝나면 마저 반영한다. 그렇지 않으면 반영도 안내도 다음 수동 동기화까지 남는다.
   * 회귀: check-profile-sync.ts(자동 동기화 꺼짐에서 미룬 반영 마무리). */
  private autoSyncAllowed(account:string | null | undefined):boolean {
    return this.hooks.auto() || !!account && this.remoteDeferral?.account===account;
  }
  /** 실제 timer와 가상 시간 회귀 검사가 같은 예약 진입점을 사용한다. */
  async runDueWork():Promise<void> {
    const account=this.hooks.account();
    if (this.suspended || !account || !this.hooks.enabled() || !this.autoSyncAllowed(account) || this.awaitingChoice(account) || this.model.meta('localOnly',false)) return;
    const selection=this.hooks.activeProfile();if (selection!==this.lastSelection) {this.lastSelection=selection;this.request();}
    const retry=this.retries.get(account);
    if (this.now()<Math.max(retry?.at ?? 0,Math.min(this.nextPull,this.dueUpload()))) return;
    if (!this.hooks.ready()) {
      this.retries.set(account,{failures:0,networkFailure:false,...retry,at:Math.max(retry?.at ?? 0,this.now()+1000)});
      return;
    }
    await this.sync();
  }
  /** shutdown: 종료 전송은 원격 변경을 반영하지 않으므로 다른 PC 파일을 내려받지 않는다(제한 시간 안에 업로드하기 위해).
   * 받지 않은 변경이 있으면 skippedRemote로 알려 cursor·캐시를 확정하지 않고 다음 실행에서 다시 받는다. */
  private async readDrive(manual:boolean,valid:()=>void,shutdown=false) {
    const scan=await this.transport.scan(this.model.meta<string | undefined>('cursor',undefined) || undefined);valid();
    const ownFileId=this.model.meta<string | undefined>('ownFile',undefined);
    let skippedRemote=false;
    const previous=this.model.meta<Record<string,CachedFile>>('files',{}),files=scan.full ? {} : {...previous};
    const previousDamage=new Map(this.model.meta<ProfileDriveFile[]>('damagedFiles',[]).map(file=>[file.id,file]));
    const damaged=scan.full ? new Map<string,ProfileDriveFile>() : new Map(previousDamage);
    for (const removed of scan.removed) {delete files[removed];damaged.delete(removed);}
    const changedFiles=new Map(scan.files.map(file=>[file.id,file]));
    if (manual && !scan.full) for (const [id,file] of damaged) {
      if (!changedFiles.has(id)) changedFiles.set(id,file);
    }
    for (const file of changedFiles.values()) {
      const cached=previous[file.id];
      // 자기 파일 ID를 아직 모르면(첫 업로드 전·계정 변경 직후) 자기 파일을 찾기 위해 기존처럼 모두 받는다.
      if (shutdown && ownFileId && file.id!==ownFileId && !(cached && isSameFile(file,cached.file))) {
        skippedRemote=true;
        continue;
      }
      const invalid=previousDamage.get(file.id);
      if (invalid && isSameFile(file,invalid) && !manual) {
        damaged.set(file.id,file);
        if (cached) files[file.id]=cached;
        continue;
      }
      try {
        const held=this.heldDownloads.get(file.id);
        const envelope=cached && isSameFile(file,cached.file) ? cached.envelope
          : held && isSameFile(file,held.file) ? held.envelope : await this.transport.download(file);
        valid();files[file.id]={file,envelope};damaged.delete(file.id);
      } catch (error) {
        valid();
        // 한 파일의 형식 오류는 해당 파일만 보류한다. 인증·네트워크 오류는 기존 재시도를 따른다.
        if (!(error instanceof InvalidProfileDriveFile)) throw error;
        damaged.set(file.id,file);
        if (cached) files[file.id]=cached;
      }
    }
    return {scan,previous,files,damaged,skippedRemote};
  }

  private saveDrive(cursor:string,files:Record<string,CachedFile>,damaged:ProfileDriveFile[]):void {
    // 확인 결과를 확정하면 미뤄 둔 반영도 끝난 것이다(반영했거나 받을 변경이 없음).
    this.heldDownloads.clear();this.remoteDeferral=undefined;
    this.model.setMeta('files',files);
    this.model.setMeta('cursor',cursor);
    this.model.setMeta('damagedFiles',damaged);
    this.model.setMeta('lastCheckedAt',this.now());
  }

  async choose(choice:ProfileSyncConnectionChoice):Promise<void | string> {
    if (!['merge','remote','local'].includes(choice)) throw new Error('가져올 방법을 선택해 주세요.');
    if (this.running || this.commandRunning || this.suspended || !this.hooks.ready()) throw new Error('진행 중인 저장을 마친 뒤 다시 시도해 주세요.');
    const account=this.hooks.account();if (!account || !this.hooks.enabled()) throw new Error('Google 동기화를 다시 연결해 주세요.');
    if (!this.awaitingChoice(account)) throw new Error('최신 데이터를 다시 확인해 주세요.');
    const replacement=choice==='remote' ? this.remotePreview() : null;
    if (replacement) {
      if (this.model.meta<ProfileDriveFile[]>('damagedFiles',[]).length) throw new Error('읽을 수 없는 Google 데이터가 있어 이 PC의 데이터를 교체할 수 없습니다.');
      if (replacement.conflicts) throw new Error('이름 또는 서버를 확인해야 하는 Google 프로필이 있습니다. 양쪽을 병합한 뒤 확인할 변경에서 값을 선택해 주세요.');
      if (!replacement.profiles.length) throw new Error('Google에 가져올 프로필이 없습니다.');
    }
    if (choice==='local') {this.model.setMeta('localOnly',true);this.hooks.changed();return;}
    this.commandRunning=true;this.hooks.changed();
    let cleanup:((committed:boolean)=>Promise<void>) | void=undefined;let imported=false;
    try {
    const generation=this.generation;
    const valid=()=>{
      if (generation!==this.generation || this.hooks.account()!==account || !this.hooks.enabled()) {
        throw new Error('연결 상태가 바뀌었습니다. 다시 확인해 주세요.');
      }
    };
    cleanup=await this.hooks.beforeImport(choice);valid();
    if (replacement) {
      const previousDamage=this.model.meta<ProfileDriveFile[]>('damagedFiles',[]);
      const {scan,previous,files,damaged}=await this.readDrive(true,valid);
      const changed=previousDamage.length!==damaged.size || Object.keys(previous).length!==Object.keys(files).length
        || Object.entries(files).some(([id,{envelope}])=>JSON.stringify(envelope)!==JSON.stringify(previous[id]?.envelope));
      this.model.db.transaction(()=>this.saveDrive(scan.cursor,files,[...damaged.values()]))();
      if (changed || damaged.size) throw new Error('Google 데이터가 바뀌었습니다. 갱신된 내용을 확인한 뒤 다시 선택해 주세요.');
      const retained=new Set(replacement.profiles.map(profile=>localSyncProfileId(this.model.db,profile.id)));
      const pendingOwners=this.model.db.prepare(`SELECT DISTINCT p.id FROM play_profiles p JOIN pending_profile_events e ON e.assigned_profile_id=p.id
        WHERE p.deleted_at IS NULL AND e.resolved_at IS NULL`).all() as {id:string}[];
      if (pendingOwners.some(owner=>!retained.has(owner.id))) throw new Error('교체 대상 프로필에 저장할 자동 기록이 남아 있습니다. 프로필 관리에서 대기 기록을 먼저 처리해 주세요.');
    }
    const files=this.model.meta<Record<string,CachedFile>>('files',{});
    const warning=await this.hooks.apply(()=>this.model.db.transaction(()=>{
      valid();
      const previousAccount=this.model.meta('profileDataAccount','') || this.model.meta('boundAccount','') || this.model.meta('restoreAccountHint','');
      const changingAccount=!!previousAccount && previousAccount!==account;
      if (choice==='remote' || changingAccount || this.model.meta('needsRebase',false)) this.model.rebaseOwn(choice==='merge',changingAccount);
      if (replacement) this.model.prepareRemoteImport(Object.values(files).map(f=>f.envelope),replacement.profiles.map(profile=>profile.id));
      for (const {envelope} of Object.values(files)) this.model.merge(envelope);
      this.model.apply(choice==='remote' ? undefined : this.hooks.activeProfile(),[],choice!=='remote');
      if (replacement) {
        const live=this.model.db.prepare('SELECT id FROM play_profiles WHERE deleted_at IS NULL AND name<>\'\'');
        const active=new Set((live.all() as {id:string}[]).map(profile=>profile.id));
        if (replacement.profiles.some(profile=>!active.has(localSyncProfileId(this.model.db,profile.id) ?? ''))) {
          throw new Error('가져올 프로필을 모두 복원하지 못해 이 PC의 데이터를 유지했습니다. 양쪽 병합으로 다시 시도해 주세요.');
        }
      }
      this.model.setMeta('homeworkProgressReconciled',2);
      this.model.setMeta('profileDataAccount',account);
      this.model.setMeta('boundAccount',account);this.model.setMeta('awaitingChoice',false);this.model.setMeta('localOnly',false);
      this.model.setMeta('restoreAccountHint',null);
      this.model.setMeta('needsRebase',false);
    })(),choice==='remote');
    imported=true;
    this.hooks.changed();this.request();return warning;
    } finally {try {await cleanup?.(imported);} finally {this.commandRunning=false;this.hooks.changed();this.schedule();}}
  }
  async resolve(k:string,candidate:string):Promise<void | string> {
    if (this.running || this.commandRunning || this.suspended || !this.hooks.ready()) throw new Error('저장을 마친 뒤 다시 시도해 주세요.');
    const review=this.model.reviews(this.hooks.activeProfile()).find(r=>r.key===k);
    if (!review) throw new Error('변경 목록이 갱신되었습니다. 다시 확인해 주세요.');
    if (review.reason==='pending-records') throw new Error('프로필 관리에서 대기 기록을 먼저 처리해 주세요.');
    this.hooks.assertReview?.(k);
    const [scope,profile,field]=JSON.parse(k) as string[];
    const deleting=scope==='profile' && field==='deleted' && review.candidates.some(value=>value.id===candidate && value.value===true);
    // 사용 중인 프로필의 이름·서버는 실제로 값이 바뀔 때만 다시 선택하게 한다. "이 PC 값 유지"나 현재 값과 같은 후보는
    // 로컬 값을 바꾸지 않으므로 선택을 해제하거나 자동 기록을 대기시키지 않는다. 회귀: check-profile-sync-ui.ts(이 PC 값 유지).
    const chosen=candidate==='local' ? undefined : review.candidates.find(value=>value.id===candidate);
    const changesLocal=!!chosen && !isDeepStrictEqual(chosen.value,review.current);
    const generation=this.generation,account=this.hooks.account();
    this.commandRunning=true;
    try {
    const warning=await this.hooks.apply(()=>{
      if (generation!==this.generation || account!==this.hooks.account() || !this.hooks.enabled()) throw new Error('Google 연결이 바뀌었습니다. 다시 확인해 주세요.');
      this.model.db.transaction(()=>{this.model.resolve(k,candidate);this.model.apply(this.hooks.activeProfile(),[k],true,false);})();
    },review.reason==='playing-profile' && changesLocal ? localSyncProfileId(this.model.db,profile) : false,
    deleting ? localSyncProfileId(this.model.db,profile) : undefined).catch(error=>{
      if (error instanceof ProfileSyncApplyDeferred) throw new Error(`${error.editor}에서 작성 중인 내용을 저장하거나 취소한 뒤 다시 적용해 주세요. 입력은 그대로 유지했습니다.`);
      throw error;
    });
    this.hooks.changed();this.request();return warning;
    } finally {this.commandRunning=false;this.hooks.changed();this.schedule();}
  }
  /** "나중에 설정"(localOnly)으로 멈춘 연결을 다시 시작한다. 인증은 호출자가 확인하며 브라우저 로그인을 다시 하지 않는다.
   * 첫 연결 선택을 처음부터 다시 받도록 대기 상태만 지운다. 다음 수동 확인이 Google 데이터를 다시 읽어 선택 화면을 만든다.
   * 회귀: check-profile-sync-ui.ts(나중에 설정 뒤 동기화 다시 켜기). */
  resumeConnection():void {
    if (this.running || this.commandRunning || this.suspended) throw new Error('진행 중인 작업을 마친 뒤 다시 시도해 주세요.');
    this.model.db.transaction(()=>{this.model.setMeta('localOnly',false);this.model.setMeta('awaitingChoice',false);})();
  }
  /** 종료 전에는 자동 동기화 정책·재시도 제한 안에서 전송 대기 시간만 생략한다.
   * 종료 중에는 프로필 runtime·설정 창을 바꾸는 원격 반영을 하지 않고 이 PC의 변경만 전송한다.
   * 받은 원격 변경이 있으면 cursor·파일 캐시·ACK를 확정하지 않아 다음 실행에서 다시 받는다.
   * 회귀: check-profile-sync.ts (종료 flush 중 원격 변경). */
  async flushForShutdown():Promise<void> {
    const generation=this.generation,account=this.hooks.account();
    const retryBefore=account ? this.retries.get(account) : undefined;
    await this.running?.catch(()=>undefined);
    // 종료 직전 진행 중이던 자동 확인이 종료 때문에(원격 반영 거부 등) 실패하며 남긴 재시도 대기는
    // 이 전송을 막지 않는다. 종료 전에 이미 있던 대기와 서버가 지시한 대기(429·Retry-After)는 지킨다.
    // 회귀: check-profile-sync.ts(종료 중 자동 확인 실패 뒤에도 종료 전송)
    const retryAfter=account ? this.retries.get(account) : undefined;
    const ignoreRetry=!!retryAfter && retryAfter!==retryBefore && !retryAfter.serverBackoff;
    if (generation===this.generation && this.model.pending() && this.hooks.ready()) await this.runSync(false,true,ignoreRetry);
  }
  sync(manual=false):Promise<void | string> {return this.runSync(manual,false);}
  private runSync(manual:boolean,shutdown:boolean,ignoreRetry=false):Promise<void | string> {
    const account=this.hooks.account();
    if (this.running) {
      if (!manual) return this.running;
      const previous=this.runningAccount===account ? this.running : this.running.catch(()=>undefined);
      return previous.then(()=>this.hooks.account()===account ? this.sync(true) : undefined);
    }
    if (this.commandRunning) return manual ? Promise.reject(new Error('데이터 선택을 마친 뒤 다시 동기화해 주세요.')) : Promise.resolve();
    const retryAt=account && !ignoreRetry ? this.retries.get(account)?.at ?? 0 : 0;
    if (this.suspended || !this.hooks.enabled() || !account || !manual && (this.awaitingChoice() || !this.autoSyncAllowed(account) || this.now()<retryAt)) return Promise.resolve();
    if (manual && this.now()<retryAt) return Promise.reject(new Error(this.hooks.auto()
      ? 'Google 요청을 잠시 쉬고 있습니다. 대기 시간이 지나면 자동으로 다시 시도합니다.'
      : 'Google 요청을 잠시 쉬고 있습니다. 잠시 후 지금 동기화를 다시 눌러 주세요.'));
    if (!this.model.pending() && this.now()-this.lastSuccess<2_000 && this.model.meta('boundAccount','')===this.hooks.account()
      && !this.model.deferredDeletionReady()
      && !(manual && this.model.meta<ProfileDriveFile[]>('damagedFiles',[]).length)) return Promise.resolve();
    const uploadAllowed=manual || shutdown || this.flushRequested || this.now()>=this.dueUpload();this.flushRequested=false;
    const generation=this.generation,requestSerial=this.requestSerial,networkRevision=this.networkRevision;
    const stoppedByPolicy=Symbol('sync disabled');
    // 미룬 반영을 마치려고 시작한 실행인지는 시작 시점에 고정한다(반영을 마치면 remoteDeferral이 지워진다).
    // 자동 동기화 자체는 실행 중에도 계속 확인해, 도중에 끄면 멈춘다.
    const finishingDeferral=!!account && this.remoteDeferral?.account===account;
    const checkConnection=()=>{
      if (generation!==this.generation || account!==this.hooks.account() || this.suspended) throw new Error('동기화 작업이 취소되었습니다. 로컬 변경은 보존됩니다.');
    };
    const valid=()=>{
      checkConnection();
      if (!this.hooks.enabled() || (!manual && !this.hooks.auto() && !finishingDeferral)) throw stoppedByPolicy;
    };
    this.runningAccount=account;
    this.running=(async()=>{
      let warning:void | string=undefined;
      if (!this.hooks.ready()) throw new Error('프로필 저장 작업을 마친 뒤 동기화합니다.');
      if (this.model.meta('transportAccount','')!==account) {
        this.lastSuccess=0;this.heldDownloads.clear();this.remoteDeferral=undefined;
        this.model.db.transaction(()=>{
          for (const k of ['cursor','files','ownFile','ownPublished','awaitingChoice','localOnly','lastSuccess','lastCheckedAt','lastUploadedAt','uploadSizing']) this.model.setMeta(k,k==='files' ? {} : null);
          this.model.setMeta('damagedFiles',[]);
          this.model.setMeta('transportAccount',account);
        })();
      }
      const {scan,previous,files,damaged,skippedRemote}=await this.readDrive(manual,valid,shutdown);
      valid();
      if (!this.hooks.ready()) throw new Error('수신 중 로컬 저장이 시작되어 다음 확인 때 반영합니다.');
      const saveScan=()=>this.saveDrive(scan.cursor,files,[...damaged.values()]);
      const ownFile=this.model.meta<string | undefined>('ownFile',undefined);
      const ownDamaged=this.ownFileIsDamaged([...damaged.values()]);
      const missing=!!(this.model.meta('ownPublished',false) && ownFile && !files[ownFile] && !damaged.has(ownFile));
      if (missing || Object.values(files).some(f=>this.model.writerRolledBack(f.envelope))) {
        const boundAccount=this.model.meta('boundAccount','');
        if (boundAccount && !this.model.meta('profileDataAccount','')) this.model.setMeta('profileDataAccount',boundAccount);
        this.model.setMeta('needsRebase',true);this.model.setMeta('boundAccount','');
      }
      const bound=this.model.meta('boundAccount','')===account;
      let deferredRemote=false;
      if (!bound) {
        // 종료 중 받지 않은 파일이 있으면 확인 결과를 보관하지 않는다(다음 실행에서 처음부터 받는다).
        if (skippedRemote) return;
        // 첫 연결에서는 Google에 프로필이 없어도 사용자가 시작하기 전까지
        // 확인한 파일만 보관한다. 선택 중 자동 조회와 업로드도 중지한다.
        this.model.db.transaction(()=>{
          saveScan();this.model.setMeta('stagedAccount',account);
          this.model.setMeta('awaitingChoice',true);
        })();
        this.retries.delete(account);
        return;
      } else {
        // 이전 버전에서 자동 0회에 가려진 숙제 후보를 이미 받은 파일에서도 한 번 복구한다.
        const reconcileHomework=this.model.meta<number | boolean>('homeworkProgressReconciled',0)!==2;
        // 캐시된 본문은 이미 병합한 내용이다. revision만 바뀌고 본문이 같으면(자기 업로드 재수신 등) 다시 반영하지 않는다.
        const changed=Object.values(files).filter(f=>reconcileHomework || !previous[f.file.id]
          || !isSameFile(f.file,previous[f.file.id].file) && !isDeepStrictEqual(f.envelope,previous[f.file.id].envelope));
        // 시계 보정이나 리셋 경계에 도달하면 같은 파일의 보존된 진행도 다시 계산한다.
        const now=this.model.clock().utcMs,nextProjection=this.model.meta<number | null>('nextHomeworkProjectionAt',null);
        const projectHomework=this.model.meta('homeworkProjectedAt',0)>now || nextProjection!==null && nextProjection<=now;
        if (shutdown) {
          deferredRemote=changed.length>0 || skippedRemote;
          if (!deferredRemote) this.model.db.transaction(saveScan)();
        } else if (changed.length || projectHomework || this.model.deferredDeletionReady()) {
          try {
            warning=await this.hooks.apply(()=>this.model.db.transaction(()=>{
              valid();for (const {envelope} of changed) {this.model.merge(envelope);if (envelope.device===this.model.device) this.model.acknowledgeEnvelope(envelope);}
              this.model.apply(this.hooks.activeProfile(),[],true,false);saveScan();
              this.model.setMeta('homeworkProgressReconciled',2);
            })());
          } catch (error) {
            // 편집 중인 계산기 창: 종료 전송처럼 원격 반영만 미루고 이 PC의 변경은 아래에서 전송한다.
            if (!(error instanceof ProfileSyncApplyDeferred)) throw error;
            valid();deferredRemote=true;
            for (const file of changed) this.heldDownloads.set(file.file.id,file);
            if (this.remoteDeferral?.account!==account || this.remoteDeferral.editor!==error.editor) this.hooks.report?.(deferredNotice(error.editor));
            this.remoteDeferral={account,editor:error.editor};
          }
        } else this.model.db.transaction(saveScan)();
        valid();
      }
      if (this.model.meta('localOnly',false)) return;
      if (this.model.pending() && uploadAllowed && !ownDamaged) {
        const legacyBoundary=this.model.legacyBoundary();
        let fileId=this.model.meta<string | undefined>('ownFile',undefined);
        const remote=fileId ? files[fileId] : Object.values(files).find(f=>f.envelope.device===this.model.device);
        const {envelope,sizing,held}=this.model.planUpload(remote?.envelope);
        this.model.setMeta('uploadSizing',sizing);
        if (sizing.uploadBytes>PROFILE_SYNC_POLICY.maxDecodedBytes || Object.keys(envelope.cells).length>PROFILE_SYNC_POLICY.maxCells) {
          throw new Error('계산기 값을 보류한 뒤에도 전송 한도를 초과했습니다. 이 PC의 데이터는 보존됩니다.');
        }
        if (!fileId) {
          fileId=remote?.file.id || await this.transport.allocate();valid();this.model.setMeta('ownFile',fileId);
        }
        this.uploading=true;this.hooks.changed();
        valid();
        const uploaded=await this.transport.upload(fileId,envelope,!!files[fileId],files[fileId]?.file.version,valid);checkConnection();
        this.model.db.transaction(()=>{
          this.model.acknowledgeEnvelope(envelope,legacyBoundary,sizing);this.model.setMeta('ownPublished',true);
          this.model.setMeta('lastUploadedAt',this.now());
          // 확정 revision을 함께 보관해 변경 feed의 자기 파일을 다시 받거나 반영하지 않는다.
          // 반영을 미룬 종료 전송은 확인한 캐시에 자기 파일만 갱신하고 다른 PC 파일은 다음 실행에서 다시 받는다.
          const cache=deferredRemote ? this.model.meta<Record<string,CachedFile>>('files',{}) : files;
          cache[fileId!]={file:{id:fileId!,name:`tw_overlay_profiles_${envelope.device}.json`,appProperties:{twProfileSync:'1',device:envelope.device},
            ...(uploaded?.version ? {version:uploaded.version,md5Checksum:uploaded.md5Checksum} : {})},envelope};
          this.model.setMeta('files',cache);
        })();
        const reported=this.model.meta<string[]>('heldCells',[]);
        if (!isDeepStrictEqual(reported,held)) {
          this.model.setMeta('heldCells',held);
          if (held.length) {
            const message=`형식을 확인할 수 없는 설정 ${held.length}개(${sizing.heldLabels?.join(', ') || '설정'})는 이 PC에만 보관하고 나머지를 동기화했습니다.`;
            this.hooks.report?.(message);
            warning=warning ? `${warning} ${message}` : message;
          }
        }
      }
      this.lastSuccess=this.now();this.model.setMeta('lastSuccess',this.lastSuccess);this.retries.delete(account);
      return warning;
    })().catch(error=>{
      if (error===stoppedByPolicy) return;
      if (generation===this.generation && account===this.hooks.account()) {
        if (error instanceof ProfileDriveError && [404,412].includes(error.status)) this.model.setMeta('cursor',null);
        const failures=(this.retries.get(account)?.failures ?? 0)+1;
        const networkFailure=error instanceof ProfileDriveNetworkError;
        const reconnected=networkFailure && networkRevision!==this.networkRevision;
        const at=reconnected ? 0 : this.now()+Math.max(error instanceof ProfileDriveError && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0,
          Math.min(PROFILE_SYNC_POLICY.retryMaxMs,1000*2**Math.min(10,failures))*(0.8+0.4*this.random()));
        const serverBackoff=error instanceof ProfileDriveError && (error.status===429 || error.retryAfterMs>0);
        this.retries.set(account,{at,failures,networkFailure,serverBackoff,error:error instanceof Error ? error.message : String(error)});
      }
      throw error;
    }).finally(()=>{
      this.running=null;this.runningAccount=null;this.uploading=false;this.nextPull=requestSerial!==this.requestSerial && this.now()-this.lastSuccess>2_000
        ? this.now() : this.now()+(this.active ? PROFILE_SYNC_POLICY.activeMs : PROFILE_SYNC_POLICY.idleMs)*(0.9+0.2*this.random());
      // 편집 때문에 미룬 반영은 휴식 간격(5분)을 기다리지 않고 짧게 다시 확인한다. 받은 본문은 다시 내려받지 않는다.
      if (this.remoteDeferral?.account===account) this.nextPull=Math.min(this.nextPull,this.now()+PROFILE_SYNC_POLICY.editorRetryMs);
      this.hooks.changed();this.schedule();
    });
    this.hooks.changed();return this.running;
  }
}
function isSameFile(a:ProfileDriveFile,b:ProfileDriveFile):boolean {return !!a.version && a.version===b.version && a.md5Checksum===b.md5Checksum;}
