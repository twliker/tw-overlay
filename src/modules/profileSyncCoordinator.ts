import {PROFILE_SYNC_POLICY,type ProfileSyncConnectionChoice,type ProfileSyncDetails,type ProfileSyncEnvelope} from '../shared/profileSync';
import {ProfileSyncModel,localSyncProfileId} from './profileSyncModel';
import {ProfileDriveError,type ProfileSyncTransport,type ProfileDriveFile} from './profileSyncDrive';

interface CachedFile {file:ProfileDriveFile;envelope:ProfileSyncEnvelope}
export interface ProfileSyncHooks {
  account():string | null;
  enabled():boolean;
  auto():boolean;
  activeProfile():string | undefined;
  ready():boolean;
  beforeImport(choice:ProfileSyncConnectionChoice):Promise<((committed:boolean)=>Promise<void>) | void>;
  apply(action:()=>void,requireSelection?:boolean | string):Promise<void>;
  assertReview?(key:string):void;
  changed():void;
}
/** 앱 단위 single-flight 스케줄러. 저장 성공과 원격 성공은 독립이다.
 * PC별 파일만 쓰고 변경feed로 다른 PC의 변경을 확인한다. cursor/ACK는 성공 후에만 확정한다.
 * 실행 중 ID와 payload를 고정하므로 늦은 응답이 새 로컬 변경을 ACK/덮어쓰지 못한다.
 * 회귀: check-profile-sync.ts。 */
export class ProfileSyncCoordinator {
  private running:Promise<void> | null=null;
  private timer:ReturnType<typeof setTimeout> | undefined;
  private started=false;
  private suspended=false;
  private generation=0;
  private active=false;
  private failures=0;
  private retryAt=0;
  private lastError:string | undefined;
  private lastSuccess=0;
  private nextPull=0;
  private lastSelection:string | undefined;
  private uploading=false;
  private flushRequested=false;
  private commandRunning=false;
  private requestSerial=0;
  constructor(readonly model:ProfileSyncModel,readonly transport:ProfileSyncTransport,private readonly hooks:ProfileSyncHooks,
    private readonly now=Date.now,private readonly random=Math.random) {}
  get error():string | undefined {return this.lastError;}
  get retryCount():number {return this.failures;}
  get syncing():boolean {return !!this.running || this.commandRunning;}
  get activity():'upload' | 'checking' {return this.uploading ? 'upload' : 'checking';}
  get lastSyncedAt():number | undefined {return this.model.meta<number | undefined>('lastSuccess',undefined);}
  details():ProfileSyncDetails {
    const metrics=this.transport as ProfileSyncTransport & {requests?:number;uploadedBytes?:number;downloadedBytes?:number};
    const account=this.hooks.account();
    return {version:1,connection:!account || !this.hooks.enabled() ? 'disconnected' : this.model.meta('boundAccount','')===account
      ? 'ready' : this.model.meta<boolean>('awaitingChoice',false) ? 'choice' : 'checking',pending:this.model.pending(),
      reviews:this.model.reviews(this.hooks.activeProfile()),remoteProfiles:this.remoteProfiles(),
      backupAvailable:this.model.meta<boolean>('backupAvailable',false),requests:metrics.requests || 0,
      uploadedBytes:metrics.uploadedBytes || 0,downloadedBytes:metrics.downloadedBytes || 0};
  }
  private remoteProfiles():Array<{id:string;name:string;server:number | null}> {
    const files=this.model.meta<Record<string,CachedFile>>('files',{}),profiles=new Map<string,{id:string;name:string;server:number | null}>();
    for (const {envelope} of Object.values(files)) for (const [k,c] of Object.entries(envelope.cells)) {
      const p=JSON.parse(k) as string[];
      if (p[0]==='profile' && p[2]==='name' && typeof c.value==='string') profiles.set(p[1],{id:p[1],name:c.value,server:null});
    }
    for (const {envelope} of Object.values(files)) for (const [k,c] of Object.entries(envelope.cells)) {
      const p=JSON.parse(k) as string[],profile=profiles.get(p[1]);if (profile && p[0]==='setting' && p[2]==='userServer') profile.server=Number(c.value) || null;
      if (p[0]==='profile' && p[2]==='deleted' && c.value===true) profiles.delete(p[1]);
    }
    return [...profiles.values()];
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
  /** 자동 감지는 record context로 구분한다. 일반 채팅/일지/기기 변경은 pending을 만들지 않는다. */
  private dueUpload():number {
    if (!this.model.pending()) return Infinity;
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
    if (!this.started || this.suspended) return;
    // 화면을 거치지 않는 자동 기록도 같은 앱 타이머에서 확인한다. 이 확인은 API를 호출하지 않는다.
    const allowed=this.hooks.account() && this.hooks.enabled() && this.hooks.auto() && !this.model.meta('localOnly',false);
    const due=allowed ? Math.max(this.retryAt,Math.min(this.nextPull,this.dueUpload())) : this.now()+1000;
    const delay=Math.max(50,Math.min(1000,due-this.now()));
    this.timer=setTimeout(()=>{void this.runDueWork().catch(()=>undefined).finally(()=>this.schedule());},delay);this.timer.unref?.();
  }
  /** 실제 timer와 가상 시간 회귀 검사가 같은 예약 진입점을 사용한다. */
  async runDueWork():Promise<void> {
    const selection=this.hooks.activeProfile();if (selection!==this.lastSelection) {this.lastSelection=selection;this.request();}
    if (this.suspended || !this.hooks.account() || !this.hooks.enabled() || !this.hooks.auto() || this.model.meta('localOnly',false)) return;
    if (!this.hooks.ready()) {this.retryAt=Math.max(this.retryAt,this.now()+1000);return;}
    if (this.now()>=Math.max(this.retryAt,Math.min(this.nextPull,this.dueUpload()))) await this.sync();
  }
  async choose(choice:ProfileSyncConnectionChoice):Promise<void> {
    if (!['merge','remote','local'].includes(choice)) throw new Error('가져올 방법을 선택해 주세요.');
    if (this.running || this.commandRunning || this.suspended || !this.hooks.ready()) throw new Error('진행 중인 저장을 마친 뒤 다시 시도해 주세요.');
    const account=this.hooks.account();if (!account) throw new Error('Google에 로그인해 주세요.');
    if (!this.model.meta('awaitingChoice',false) || this.model.meta('stagedAccount','')!==account) throw new Error('최신 데이터를 다시 확인해 주세요.');
    if (choice==='local') {this.model.setMeta('localOnly',true);this.hooks.changed();return;}
    this.commandRunning=true;this.hooks.changed();
    let cleanup:((committed:boolean)=>Promise<void>) | void=undefined;let imported=false;
    try {
    const generation=this.generation;
    cleanup=await this.hooks.beforeImport(choice);if (generation!==this.generation || this.hooks.account()!==account) throw new Error('연결 상태가 바뀌었습니다. 다시 확인해 주세요.');
    const files=this.model.meta<Record<string,CachedFile>>('files',{});
    await this.hooks.apply(()=>this.model.db.transaction(()=>{
      if (generation!==this.generation || this.hooks.account()!==account) throw new Error('연결 상태가 바뀌었습니다. 다시 확인해 주세요.');
      if (choice==='remote' || this.model.meta('needsRebase',false)) this.model.rebaseOwn(choice==='merge');
      if (choice==='remote') this.model.prepareRemoteImport(Object.values(files).map(f=>f.envelope));
      for (const {envelope} of Object.values(files)) this.model.merge(envelope);
      this.model.apply(choice==='remote' ? undefined : this.hooks.activeProfile());
      this.model.setMeta('boundAccount',account);this.model.setMeta('awaitingChoice',false);this.model.setMeta('localOnly',false);
      this.model.setMeta('restoreAccountHint',null);
      this.model.setMeta('needsRebase',false);
    })(),choice==='remote');
    imported=true;
    this.hooks.changed();this.request();
    } finally {try {await cleanup?.(imported);} finally {this.commandRunning=false;this.hooks.changed();this.schedule();}}
  }
  async resolve(k:string,candidate:string):Promise<void> {
    if (this.running || this.commandRunning || this.suspended || !this.hooks.ready()) throw new Error('저장을 마친 뒤 다시 시도해 주세요.');
    const review=this.model.reviews(this.hooks.activeProfile()).find(r=>r.key===k);
    if (!review) throw new Error('변경 목록이 갱신되었습니다. 다시 확인해 주세요.');
    this.hooks.assertReview?.(k);
    this.commandRunning=true;
    try {
    await this.hooks.apply(()=>{
      this.model.db.transaction(()=>{this.model.resolve(k,candidate);this.model.apply(this.hooks.activeProfile(),[k]);})();
    },review.reason==='playing-profile' ? localSyncProfileId(this.model.db,(JSON.parse(k) as string[])[1]) : false);
    this.hooks.changed();this.request();
    } finally {this.commandRunning=false;this.hooks.changed();this.schedule();}
  }
  sync(manual=false):Promise<void> {
    if (this.running) return manual ? this.running.then(()=>this.sync(true)) : this.running;
    if (this.commandRunning) return manual ? Promise.reject(new Error('데이터 선택을 마친 뒤 다시 동기화해 주세요.')) : Promise.resolve();
    if (this.suspended || !this.hooks.enabled() || !this.hooks.account() || !manual && (!this.hooks.auto() || this.now()<this.retryAt)) return Promise.resolve();
    if (manual && this.now()<this.retryAt) return Promise.reject(new Error('Google 요청을 잠시 쉬고 있습니다. 대기 중인 변경은 자동으로 다시 전송합니다.'));
    if (!this.model.pending() && this.now()-this.lastSuccess<2_000 && this.model.meta('boundAccount','')===this.hooks.account()) return Promise.resolve();
    const uploadAllowed=manual || this.flushRequested || this.now()>=this.dueUpload();this.flushRequested=false;
    const generation=this.generation,account=this.hooks.account()!,requestSerial=this.requestSerial;
    const valid=()=>{if (generation!==this.generation || account!==this.hooks.account() || this.suspended) throw new Error('동기화 작업이 취소되었습니다. 로컬 변경은 보존됩니다.');};
    this.running=(async()=>{
      if (!this.hooks.ready()) throw new Error('프로필 저장 작업을 마친 뒤 동기화합니다.');
      if (this.model.meta('transportAccount','')!==account) {
        this.model.db.transaction(()=>{
          for (const k of ['cursor','files','ownFile','ownPublished','awaitingChoice','localOnly']) this.model.setMeta(k,k==='files' ? {} : null);
          this.model.setMeta('transportAccount',account);
        })();
      }
      const scan=await this.transport.scan(this.model.meta<string | undefined>('cursor',undefined));valid();
      const previous=this.model.meta<Record<string,CachedFile>>('files',{}),files=scan.full ? {} : {...previous};
      for (const removed of scan.removed) delete files[removed];
      for (const file of scan.files) {
        const cached=previous[file.id];
        if (cached && file.version && file.version===cached.file.version && file.md5Checksum===cached.file.md5Checksum) files[file.id]={file,envelope:cached.envelope};
        else {const envelope=await this.transport.download(file);valid();files[file.id]={file,envelope};}
      }
      if (!this.hooks.ready()) throw new Error('수신 중 로컬 저장이 시작되어 다음 확인 때 반영합니다.');
      const ownFile=this.model.meta<string | undefined>('ownFile',undefined);
      const missing=!!(this.model.meta('ownPublished',false) && ownFile && !files[ownFile]);
      if (missing || Object.values(files).some(f=>this.model.writerRolledBack(f.envelope))) {
        this.model.setMeta('needsRebase',true);this.model.setMeta('boundAccount','');
      }
      const bound=this.model.meta('boundAccount','')===account;
      if (!bound) {
        this.model.db.transaction(()=>{
          this.model.setMeta('files',files);this.model.setMeta('stagedAccount',account);
          const previousAccount=this.model.meta('boundAccount','') || this.model.meta('restoreAccountHint','');
          if (Object.keys(files).length || this.model.meta('needsRebase',false) || previousAccount && previousAccount!==account) this.model.setMeta('awaitingChoice',true);
          else {this.model.setMeta('boundAccount',account);this.model.setMeta('awaitingChoice',false);this.model.setMeta('restoreAccountHint',null);}
          this.model.setMeta('cursor',scan.cursor);
        })();
        if (this.model.meta('awaitingChoice',false)) return;
      } else {
        const changed=Object.values(files).filter(f=>!previous[f.file.id] || !isSameFile(f.file,previous[f.file.id].file));
        if (changed.length) await this.hooks.apply(()=>this.model.db.transaction(()=>{
          valid();for (const {envelope} of changed) {this.model.merge(envelope);if (envelope.device===this.model.device) this.model.acknowledge(envelope.sequence);}
          this.model.apply(this.hooks.activeProfile());this.model.setMeta('files',files);this.model.setMeta('cursor',scan.cursor);
        })());
        else {this.model.setMeta('files',files);this.model.setMeta('cursor',scan.cursor);}
        valid();
      }
      if (this.model.meta('localOnly',false)) return;
      if (this.model.pending() && uploadAllowed) {
        const envelope=this.model.envelope(),legacyBoundary=this.model.legacyBoundary();
        let fileId=this.model.meta<string | undefined>('ownFile',undefined);
        if (!fileId) {
          const remote=Object.values(files).find(f=>f.envelope.device===this.model.device);
          fileId=remote?.file.id || await this.transport.allocate();valid();this.model.setMeta('ownFile',fileId);
        }
        this.uploading=true;this.hooks.changed();
        await this.transport.upload(fileId,envelope,!!files[fileId],files[fileId]?.file.version);valid();
        this.model.db.transaction(()=>{
          this.model.acknowledge(envelope.sequence,legacyBoundary);this.model.setMeta('ownPublished',true);
          files[fileId!]={file:{id:fileId!,name:`tw_overlay_profiles_${envelope.device}.json`,appProperties:{twProfileSync:'1',device:envelope.device}},envelope};
          this.model.setMeta('files',files);
        })();
      }
      this.lastSuccess=this.now();this.model.setMeta('lastSuccess',this.lastSuccess);this.failures=0;this.retryAt=0;this.lastError=undefined;
    })().catch(error=>{
      if (generation===this.generation) {
        if (error instanceof ProfileDriveError && [404,412].includes(error.status)) this.model.setMeta('cursor',null);
        this.failures++;this.lastError=error instanceof Error ? error.message : String(error);
        this.retryAt=this.now()+Math.max(error instanceof ProfileDriveError ? error.retryAfterMs : 0,
          Math.min(PROFILE_SYNC_POLICY.retryMaxMs,1000*2**Math.min(10,this.failures))*(0.8+0.4*this.random()));
      }
      throw error;
    }).finally(()=>{
      this.running=null;this.uploading=false;this.nextPull=requestSerial!==this.requestSerial && this.now()-this.lastSuccess>2_000
        ? this.now() : this.now()+(this.active ? PROFILE_SYNC_POLICY.activeMs : PROFILE_SYNC_POLICY.idleMs)*(0.9+0.2*this.random());
      this.hooks.changed();this.schedule();
    });
    this.hooks.changed();return this.running;
  }
}
function isSameFile(a:ProfileDriveFile,b:ProfileDriveFile):boolean {return !!a.version && a.version===b.version && a.md5Checksum===b.md5Checksum;}
