import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {isDeepStrictEqual} from 'util';
import {PROFILE_SETTING_KEYS,SHARED_SETTING_KEYS,isProfileServer,assertProfileName,type ProfileClockStamp} from '../shared/playProfiles';
import {isProfileToolKey} from '../shared/profileTools';
import {PROFILE_SYNC_POLICY,type SyncValue,type SyncVector,type ProfileSyncEnvelope,type ProfileSyncReview} from '../shared/profileSync';
import {sanitizeExternalConfigPatch} from './config';

type Snapshot=Record<string,unknown>;
// DB의 프로필 공통 저장과 Google 전송 허용은 별개다. 닉네임 메모의 기존 로컬 전용 정책을 유지한다.
const sharedSyncKeys=(SHARED_SETTING_KEYS as readonly string[]).filter(k=>k!=='nicknameNotes');
const key=(...parts:string[])=>JSON.stringify(parts);
const parse=(value:string):string[]=>JSON.parse(value);
const text=(value:unknown)=>JSON.stringify(value);
const read=<T>(db:Database.Database,k:string,fallback:T):T=>{
  const row=db.prepare('SELECT value FROM profile_sync_meta WHERE key=?').get(k) as {value:string} | undefined;
  return row ? JSON.parse(row.value) : fallback;
};
const write=(db:Database.Database,k:string,value:unknown)=>db.prepare('INSERT OR REPLACE INTO profile_sync_meta VALUES(?,?)').run(k,text(value));
function portableSetting(field:string,value:unknown):unknown {
  const fields:Record<string,string[]>={customAlerts:['id','enabled','type','time','minute','offsets','message'],
    huntingExpDopings:['id','name','percent','duration','enabled','note'],huntingExpGrounds:['id','name','baseXp'],
    nicknameNotes:['server','nickname','note'],discordRules:['keyword','targetNormal','targetClub','targetShout','targetSender']};
  const pick=(v:unknown,keys:string[])=>v && typeof v==='object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([k])=>keys.includes(k))) : v;
  if (Array.isArray(value) && fields[field]) return value.map(v=>pick(v,fields[field]));
  if (field==='fieldBossSettings' && value && typeof value==='object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,pick(v,['name','enabled'])]));
  return value;
}
function validPortableSetting(field:string,value:unknown):boolean {
  if (value===null) return true;
  if (!isDeepStrictEqual(value,portableSetting(field,value)) || !sanitizeExternalConfigPatch({[field]:value})) return false;
  const object=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
  const number=(v:unknown)=>typeof v==='number' && Number.isFinite(v);
  const string=(v:unknown)=>typeof v==='string';
  const every=(check:(v:any)=>boolean)=>Array.isArray(value) && value.every(v=>object(v) && check(v));
  if (['lootKeywords','tradeKeywords','wordAlarmKeywords','shoutKeywords','galleryKeywords','discordKeywords'].includes(field)) return Array.isArray(value) && value.every(string);
  if (field==='buffTimerBuffs') return object(value) && Object.values(value).every(v=>typeof v==='boolean');
  if (field==='fieldBossNotifyOffsets') return Array.isArray(value) && value.every(v=>number(v) && v>=0 && v<=1440);
  if (field==='fieldBossSettings') return object(value) && Object.values(value).every(v=>object(v) && string(v.name) && typeof v.enabled==='boolean');
  if (field==='customAlerts') return every(v=>string(v.id) && typeof v.enabled==='boolean' && ['daily','hourly'].includes(v.type) && string(v.message)
    && Array.isArray(v.offsets) && v.offsets.every((n:unknown)=>number(n) && Number(n)>=0 && Number(n)<=1440)
    && (v.type==='daily' ? string(v.time) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.time) : Number.isInteger(v.minute) && v.minute>=0 && v.minute<60));
  if (field==='huntingExpDopings') return every(v=>string(v.id) && string(v.name) && number(v.percent) && string(v.duration) && typeof v.enabled==='boolean' && (v.note===undefined || string(v.note)));
  if (field==='huntingExpGrounds') return every(v=>string(v.id) && string(v.name) && number(v.baseXp) && v.baseXp>=0);
  if (field==='discordRules') return every(v=>string(v.keyword) && ['targetNormal','targetClub','targetShout'].every(k=>typeof v[k]==='boolean') && (v.targetSender===undefined || string(v.targetSender)));
  return true;
}
function withLocalSounds(field:string,value:unknown,prior:unknown):unknown {
  if (!value || !['customAlerts','fieldBossSettings'].includes(field)) return value;
  const merge=(v:any,p:any)=>({...v,soundFile:p?.soundFile || 'orb.mp3',...(p?.volume!==undefined ? {volume:p.volume} : {})});
  if (Array.isArray(value)) return value.map(v=>merge(v,Array.isArray(prior) ? prior.find(p=>p.id===v.id) : undefined));
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,merge(v,(prior as Record<string,unknown> | null)?.[k])]));
}
const dominates=(a:SyncValue,b:SyncValue)=>a.device===b.device && a.sequence>=b.sequence || (a.context[b.device] || 0)>=b.sequence;
const id=(v:SyncValue)=>`${v.device}:${v.sequence}`;

/** 동일 필드의 인과 관계를 유지하고 불확실한 후보는 보존한다. 시각의 추정 오차도 비교한다. */
export function mergeSyncValues(values:SyncValue[]):SyncValue[] {
  const unique=new Map<string,SyncValue>();
  for (const value of values) {
    const previous=unique.get(id(value));
    if (previous && !isDeepStrictEqual(previous,value)) throw new Error('동일 변경 ID의 내용이 다릅니다. 원격 데이터를 보존하고 중지했습니다.');
    unique.set(id(value),value);
  }
  return [...unique.values()].filter(value=>![...unique.values()].some(other=>other!==value && dominates(other,value)))
    .sort((a,b)=>id(a).localeCompare(id(b)));
}
function winner(values:SyncValue[],k?:string):SyncValue | undefined {
  if (k && parse(k)[0]==='homework' && parse(k)[3]==='progress') {
    const cycles=values.map(v=>Number((v.value as {cycle?:number} | null)?.cycle || 0));
    const latest=Math.max(...cycles);values=values.filter((_,index)=>cycles[index]===latest);
  }
  if (values.length===1 || values.every(v=>isDeepStrictEqual(v.value,values[0]?.value))) return values[0];
  return values.find(v=>v.clock.source==='internet' && values.every(other=>other===v ||
    other.clock.source==='internet' && v.clock.utcMs-(v.clock.uncertaintyMs ?? Infinity)>
      other.clock.utcMs+(other.clock.uncertaintyMs ?? Infinity)));
}

export function prepareProfileSyncSchema(db:Database.Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS profile_sync_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_sync_ids(local_id TEXT PRIMARY KEY,remote_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS profile_sync_cells(key TEXT PRIMARY KEY,heads TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_sync_own(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_sync_tombstones(key TEXT PRIMARY KEY);`);
}
export function profileSyncResetCycle(rule:{type:string;hour?:number;dayOfWeek?:number},timestamp:number):number {
  // 게임의 리셋은 한국 시각 기준. PC의 표시 타임존은 변경 ID/리셋 주기를 바꾸지 않는다.
  const date=new Date(timestamp+9*60*60*1000);const hour=rule.hour ?? 0;
  const boundary=new Date(date);boundary.setUTCHours(hour,0,0,0);
  if (rule.type==='weekly') {const days=(date.getUTCDay()-(rule.dayOfWeek ?? 1)+7)%7;boundary.setUTCDate(boundary.getUTCDate()-days);}
  if (date<boundary) boundary.setUTCDate(boundary.getUTCDate()-(rule.type==='weekly' ? 7 : 1));
  return boundary.getTime()-9*60*60*1000;
}
function remoteId(db:Database.Database,local:string):string {
  const row=db.prepare('SELECT remote_id FROM profile_sync_ids WHERE local_id=?').get(local) as {remote_id:string} | undefined;
  if (row) return row.remote_id;
  const value=local==='profile-default' ? randomUUID() : local;
  db.prepare('INSERT INTO profile_sync_ids VALUES(?,?)').run(local,value);return value;
}
export function localSyncProfileId(db:Database.Database,remote:string):string | undefined {
  return (db.prepare('SELECT local_id FROM profile_sync_ids WHERE remote_id=?').get(remote) as {local_id:string} | undefined)?.local_id;
}

/** 허용된 원본만 읽는다. 일지/로그/HUD/현재 선택/인증/기기 경로는 조회하지 않는다. */
export function portableProfileSnapshot(db:Database.Database):Snapshot {
  const result:Snapshot={};
  let prior:Snapshot | undefined;
  const profiles=db.prepare('SELECT id,name,created_at,deleted_at FROM play_profiles').all() as {id:string;name:string;created_at:number;deleted_at:number | null}[];
  for (const p of profiles) {
    if (read<string[]>(db,'excludedProfiles',[]).includes(p.id)) continue;
    const server=db.prepare("SELECT value FROM profile_settings WHERE profile_id=? AND key='userServer'").get(p.id) as {value:string} | undefined;
    if (!p.name.trim() || !isProfileServer(server ? JSON.parse(server.value) : null)) {
      const mapping=db.prepare('SELECT remote_id FROM profile_sync_ids WHERE local_id=?').get(p.id) as {remote_id:string} | undefined;
      if (mapping) {
        prior ||= read<Snapshot>(db,'materialized',{});
        for(const [k,v] of Object.entries(prior)) if(parse(k)[0]!=='shared' && parse(k)[1]===mapping.remote_id) result[k]=v;
        if(p.deleted_at!==null && Object.keys(result).some(k=>parse(k)[1]===mapping.remote_id)) result[key('profile',mapping.remote_id,'deleted')]=true;
      }
      continue;
    }
    const rid=remoteId(db,p.id);
    result[key('profile',rid,'name')]=p.name;result[key('profile',rid,'created')]=p.created_at;
    result[key('profile',rid,'deleted')]=p.deleted_at!==null;
    for (const row of db.prepare('SELECT key,value FROM profile_settings WHERE profile_id=?').all(p.id) as {key:string;value:string}[]) {
      if ((PROFILE_SETTING_KEYS as readonly string[]).includes(row.key)) result[key('setting',rid,row.key)]=portableSetting(row.key,JSON.parse(row.value));
    }
    for (const row of db.prepare('SELECT key,value FROM profile_tools WHERE profile_id=?').all(p.id) as {key:string;value:string}[]) {
      if (isProfileToolKey(row.key)) result[key('tool',rid,row.key)]=row.value;
    }
    for (const row of db.prepare('SELECT item_id,definition,state,position FROM profile_homework WHERE profile_id=?').all(p.id) as {item_id:string;definition:string;state:string;position:number}[]) {
      result[key('homework',rid,row.item_id,'deleted')]=false;
      for (const [field,value] of Object.entries(JSON.parse(row.definition))) if (field!=='id') result[key('homework',rid,row.item_id,field)]=value;
      const {isExcluded,...progress}=JSON.parse(row.state),definition=JSON.parse(row.definition);
      result[key('homework',rid,row.item_id,'progress')]={cycle:profileSyncResetCycle(definition.resetRule,progress.lastCompletedAt || Date.now()),state:progress};
      result[key('homework',rid,row.item_id,'excluded')]=isExcluded===true;
      result[key('homework',rid,row.item_id,'position')]=row.position;
    }
  }
  for (const row of db.prepare('SELECT key,value FROM shared_settings').all() as {key:string;value:string}[]) {
    if (sharedSyncKeys.includes(row.key)) result[key('shared',row.key)]=portableSetting(row.key,JSON.parse(row.value));
  }
  for (const {key:k} of db.prepare('SELECT key FROM profile_sync_tombstones').all() as {key:string}[]) if (!(k in result)) result[k]=true;
  return result;
}

/** 원본과 같은 SQLite transaction에서 호출하며 실패 시 전송 대기도 함께 rollback한다.
 * 필드/기기별 최종 변경과 인과 vector로 압축하고 삭제 표식을 유지한다.
 * 재전송·구 PC·백업 복원을 전체 snapshot 덮어쓰기로 처리하지 않는다.
 * 회귀: check-profile-sync-model.ts. */
export function captureProfileSyncChanges(db:Database.Database,device:string,clock:ProfileClockStamp,automatic=false):void {
  device=read(db,`writer:${device}`,device);
  const now=portableProfileSnapshot(db),before=read<Snapshot>(db,'materialized',{});
  const changed=[...new Set([...Object.keys(before),...Object.keys(now)])].filter(k=>!isDeepStrictEqual(before[k],now[k]));
  if (!changed.length) return;
  const vector=read<SyncVector>(db,'vector',{}),sequence=(vector[device] || 0)+1;
  for (const k of changed) {
    const parts=parse(k);
    let value=now[k] ?? null;
    if (parts[0]==='homework' && parts[3]==='deleted' && now[k]===undefined) value=true;
    const cell:SyncValue={device,sequence,context:{...vector},clock,value};
    const existing=db.prepare('SELECT heads FROM profile_sync_cells WHERE key=?').get(k) as {heads:string} | undefined;
    const heads=mergeSyncValues([...(existing ? JSON.parse(existing.heads) : []),cell]);
    db.prepare('INSERT OR REPLACE INTO profile_sync_cells VALUES(?,?)').run(k,text(heads));
    db.prepare('INSERT OR REPLACE INTO profile_sync_own VALUES(?,?)').run(k,text(cell));
    if (value===true && (parts[0]==='profile' && parts[2]==='deleted' || parts[0]==='homework' && parts[3]==='deleted')) db.prepare('INSERT OR IGNORE INTO profile_sync_tombstones VALUES(?)').run(k);
  }
  write(db,'vector',{...vector,[device]:sequence});write(db,'materialized',now);
  write(db,'pendingSince',read<number | null>(db,'pendingSince',null) || Date.now());write(db,'lastChangeAt',Date.now());
  const category=automatic ? 'Automatic' : 'User';
  write(db,`pending${category}Since`,read<number | null>(db,`pending${category}Since`,null) || Date.now());
  write(db,`last${category}ChangeAt`,Date.now());write(db,'lastChangeAutomatic',automatic);
}

function validCellKey(k:string,value:unknown):boolean {
  let p:string[];try {p=parse(k);} catch {return false;}
  if (!Array.isArray(p) || p.some(v=>typeof v!=='string' || !v || v.length>200 || ['__proto__','prototype','constructor'].includes(v))) return false;
  if (p[0]==='shared' && p.length===2 && sharedSyncKeys.includes(p[1])) return validPortableSetting(p[1],value);
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(p[1] || '')) return false;
  if (p[0]==='setting' && p.length===3 && (PROFILE_SETTING_KEYS as readonly string[]).includes(p[2])) return value===null ||
    (p[2]==='userServer' ? isProfileServer(value) : validPortableSetting(p[2],value));
  if (p[0]==='profile' && p.length===3) {
    if (p[2]==='name') {try {assertProfileName(value);return true;} catch {return value===null;}}
    if (p[2]==='created') return typeof value==='number' && Number.isSafeInteger(value) && value>=0;
    return p[2]==='deleted' && typeof value==='boolean';
  }
  if (p[0]==='tool' && p.length===3 && isProfileToolKey(p[2])) return value===null || typeof value==='string' && value.length<=2*1024*1024;
  if (p[0]!=='homework' || p.length!==4) return false;
  if (value===null) return true;
  switch (p[3]) {
    case 'name':case 'category':case 'autoDescription':return typeof value==='string' && value.length<=4000;
    case 'autoType':return value==='semi';
    case 'deleted':case 'excluded':case 'isVisible':case 'isCustom':case 'auto':return typeof value==='boolean';
    case 'position':return Number.isSafeInteger(value) && Number(value)>=0 && Number(value)<100_000;
    case 'maxCount':return Number.isSafeInteger(value) && Number(value)>=1 && Number(value)<=1_000_000;
    case 'resetRule': {
      const v=value as Record<string,unknown>;
      return !!v && typeof v==='object' && Object.keys(v).every(k=>['type','hour','dayOfWeek'].includes(k)) && ['daily','weekly'].includes(String(v.type))
        && (v.hour===undefined || Number.isInteger(v.hour) && Number(v.hour)>=0 && Number(v.hour)<24)
        && (v.dayOfWeek===undefined || Number.isInteger(v.dayOfWeek) && Number(v.dayOfWeek)>=0 && Number(v.dayOfWeek)<=6);
    }
    case 'progress': {
      const v=value as Record<string,unknown>;
      return !!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===2 && Number.isSafeInteger(v.cycle)
        && !!v.state && typeof v.state==='object' && !Array.isArray(v.state) && Object.entries(v.state).every(([k,n])=>
        k==='isCompleted' ? typeof n==='boolean' : ['currentCount','lastCompletedAt'].includes(k) && typeof n==='number' && Number.isSafeInteger(n) && n>=0);
    }
    default:return false;
  }
}
export function validateProfileSyncEnvelope(value:unknown):asserts value is ProfileSyncEnvelope {
  if (!value || typeof value!=='object' || Buffer.byteLength(text(value))>PROFILE_SYNC_POLICY.maxFileBytes) throw new Error('동기화 파일이 너무 크거나 올바르지 않습니다.');
  const v=value as ProfileSyncEnvelope;
  const validId=(s:unknown)=>typeof s==='string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(s) && !['__proto__','prototype','constructor'].includes(s);
  if (v.format!=='tw-overlay-profiles' || v.version!==1 || !validId(v.device) || !Number.isSafeInteger(v.sequence) || v.sequence<0
    || !v.cells || Array.isArray(v.cells) || typeof v.cells!=='object' || Object.keys(v.cells).length>PROFILE_SYNC_POLICY.maxCells
    || Object.keys(v).some(k=>!['format','version','device','sequence','cells'].includes(k))) throw new Error('지원하지 않는 프로필 동기화 형식입니다.');
  for (const [k,c] of Object.entries(v.cells)) {
    if (!c || c.device!==v.device || !Number.isSafeInteger(c.sequence) || c.sequence<1 || c.sequence>v.sequence || !c.context || typeof c.context!=='object' || Array.isArray(c.context) || Object.keys(c.context).length>1000
      || Object.entries(c.context).some(([d,n])=>!validId(d) || !Number.isSafeInteger(n) || n<0 || d===c.device && n>=c.sequence)
      || !c.clock || !Number.isSafeInteger(c.clock.utcMs) || c.clock.utcMs<0 || !['internet','unverified'].includes(c.clock.source)
      || (c.clock.source==='internet' ? typeof c.clock.uncertaintyMs!=='number' || !Number.isFinite(c.clock.uncertaintyMs) || c.clock.uncertaintyMs<0 : c.clock.uncertaintyMs!==null)
      || !validCellKey(k,c.value) || Object.keys(c).some(f=>!['device','sequence','context','clock','value'].includes(f))) throw new Error(`동기화 파일의 항목 또는 변경 정보가 올바르지 않습니다 (${k}).`);
  }
}

export class ProfileSyncModel {
  constructor(private readonly connection:Database.Database | (()=>Database.Database),private readonly physicalDevice:string,readonly clock:()=>ProfileClockStamp) {
    this.bindLocalDevice();
  }
  /** 휴대용 DB의 데이터/인과 정보는 유지하되 전송 완료·파일 ID는 원래 PC의 상태다.
   * 다른 PC 복원은 원래 변경 시각을 승계한 새 writer로 대기를 재구성한다.
   * ApplicationData.reopen에서도 capture 전에 호출한다. 회귀: check-profile-sync-model.ts. */
  private bindLocalDevice():void {
    this.db.transaction(()=>{
      const owner=this.meta('localDevice','');
      const foreignOwn=!owner && (this.db.prepare('SELECT value FROM profile_sync_own').all() as {value:string}[])
        .some(row=>(JSON.parse(row.value) as SyncValue).device!==this.device);
      if (owner && owner!==this.physicalDevice || foreignOwn) {
        const account=this.meta('boundAccount','') || this.meta('restoreAccountHint','') || this.meta('transportAccount','');
        const remove=this.db.prepare('DELETE FROM profile_sync_meta WHERE key=?');
        for (const k of ['cursor','files','ownFile','ownPublished','boundAccount','transportAccount','stagedAccount','awaitingChoice',
          'localOnly','lastSuccess','acked','needsRebase','pendingSince','lastChangeAt','pendingUserSince','lastUserChangeAt',
          'pendingAutomaticSince','lastAutomaticChangeAt','lastChangeAutomatic','backupPath','backupAvailable','identityReviews']) remove.run(k);
        if (account) this.setMeta('restoreAccountHint',account);
        this.rebaseOwn(true);
      }
      this.setMeta('localDevice',this.physicalDevice);
    })();
  }
  get db():Database.Database {return typeof this.connection==='function' ? this.connection() : this.connection;}
  get device():string {return this.meta(`writer:${this.physicalDevice}`,this.physicalDevice);}
  writerRolledBack(envelope:ProfileSyncEnvelope):boolean {
    if (envelope.device!==this.physicalDevice && !envelope.device.startsWith(`${this.physicalDevice}:`)) return false;
    const vector=this.meta<SyncVector>('vector',{});
    if (envelope.sequence>(vector[envelope.device] || 0)) return true;
    const own=this.envelope();
    return envelope.device===own.device && Object.entries(envelope.cells).some(([k,v])=>own.cells[k]?.sequence===v.sequence && !isDeepStrictEqual(own.cells[k],v));
  }
  rebaseOwn(preserveLocal:boolean):void {
    const before=this.values(),snapshot=portableProfileSnapshot(this.db),nextDevice=`${this.physicalDevice.slice(0,150)}:${randomUUID()}`;
    this.setMeta(`writer:${this.physicalDevice}`,nextDevice);
    this.db.prepare('DELETE FROM profile_sync_own').run();this.setMeta('ownFile',null);this.setMeta('ownPublished',false);this.setMeta('acked',0);
    if (!preserveLocal) return;
    const vector=this.meta<SyncVector>('vector',{});
    for (const [k,value] of Object.entries(snapshot)) {
      const original=(before[k] || []).find(v=>isDeepStrictEqual(v.value,value));
      const context=original ? {...original.context,[original.device]:original.sequence} : {};
      // 복원된 과거 값에 업로드 시각을 부여하지 않는다. 원래 시각/불확실성을 승계한다.
      const cell:SyncValue={device:nextDevice,sequence:1,context,
        clock:original?.clock || {utcMs:this.clock().utcMs,source:'unverified',uncertaintyMs:null},value};
      const heads=mergeSyncValues([...(before[k] || []),cell]);
      this.db.prepare('INSERT OR REPLACE INTO profile_sync_cells VALUES(?,?)').run(k,text(heads));
      this.db.prepare('INSERT INTO profile_sync_own VALUES(?,?)').run(k,text(cell));
    }
    this.setMeta('vector',{...vector,[nextDevice]:Object.keys(snapshot).length ? 1 : 0});
    this.setMeta('pendingSince',Date.now());this.setMeta('lastChangeAt',Date.now());
  }
  meta<T>(key:string,fallback:T):T {return read(this.db,key,fallback);}
  setMeta(key:string,value:unknown):void {write(this.db,key,value);}
  capture():void {this.db.transaction(()=>captureProfileSyncChanges(this.db,this.device,this.clock()))();}
  pending():number {return Math.max(0,(this.meta<SyncVector>('vector',{})[this.device] || 0)-this.meta('acked',0));}
  envelope():ProfileSyncEnvelope {
    const rows=this.db.prepare('SELECT key,value FROM profile_sync_own ORDER BY key').all() as {key:string;value:string}[];
    return {format:'tw-overlay-profiles',version:1,device:this.device,sequence:this.meta<SyncVector>('vector',{})[this.device] || 0,
      cells:Object.fromEntries(rows.map(r=>[r.key,JSON.parse(r.value)]))};
  }
  legacyBoundary():number {return Number((this.db.prepare('SELECT MAX(sequence) n FROM profile_change_log WHERE device_id=?').get(this.physicalDevice) as {n:number | null}).n || 0);}
  acknowledge(sequence:number,legacyBoundary?:number):void {
    this.setMeta('acked',Math.max(sequence,this.meta('acked',0)));
    if (!this.pending()) {this.setMeta('pendingSince',null);this.setMeta('lastChangeAt',null);}
    if (!this.pending()) for (const category of ['Automatic','User']) {this.setMeta(`pending${category}Since`,null);this.setMeta(`last${category}ChangeAt`,null);}
    if (legacyBoundary!==undefined) this.db.prepare('DELETE FROM profile_change_log WHERE device_id=? AND sequence<=?').run(this.physicalDevice,legacyBoundary);
  }
  merge(envelope:ProfileSyncEnvelope):void {
    validateProfileSyncEnvelope(envelope);
    this.db.transaction(()=>{
      const vector=this.meta<SyncVector>('vector',{});
      for (const [k,c] of Object.entries(envelope.cells)) {
        const row=this.db.prepare('SELECT heads FROM profile_sync_cells WHERE key=?').get(k) as {heads:string} | undefined;
        const heads=mergeSyncValues([...(row ? JSON.parse(row.heads) : []),c]);
        this.db.prepare('INSERT OR REPLACE INTO profile_sync_cells VALUES(?,?)').run(k,text(heads));
        const parts=parse(k);
        if (c.value===true && (parts[0]==='profile' && parts[2]==='deleted' || parts[0]==='homework' && parts[3]==='deleted')) this.db.prepare('INSERT OR IGNORE INTO profile_sync_tombstones VALUES(?)').run(k);
      }
      vector[envelope.device]=Math.max(vector[envelope.device] || 0,envelope.sequence);this.setMeta('vector',vector);
    })();
  }
  values():Record<string,SyncValue[]> {return Object.fromEntries((this.db.prepare('SELECT key,heads FROM profile_sync_cells ORDER BY key').all() as {key:string;heads:string}[]).map(r=>[r.key,JSON.parse(r.heads)]));}
  private selected():Snapshot {
    const result={...this.meta<Snapshot>('materialized',{})};
    for (const [k,heads] of Object.entries(this.values())) {
      // 삭제는 영구 표식이다. 오프라인 PC의 오래된 편집으로 부활시키지 않는다.
      const p=parse(k),deleted=(p[0]==='profile' && p[2]==='deleted' || p[0]==='homework' && p[3]==='deleted') && heads.some(v=>v.value===true);
      const selected=deleted ? {value:true} : winner(heads,k);
      if (selected) result[k]=selected.value;
    }
    for (const {key:k} of this.db.prepare('SELECT key FROM profile_sync_tombstones').all() as {key:string}[]) result[k]=true;
    return result;
  }
  reviews(activeLocalId?:string):ProfileSyncReview[] {
    const current=this.meta<Snapshot>('materialized',{}),result:ProfileSyncReview[]=[],snapshot=this.selected();
    const protectedProfiles=new Set([...this.meta<string[]>('identityReviews',[]),...(activeLocalId ? [activeLocalId] : [])]);
    for (const [k,heads] of Object.entries(this.values())) {
      const p=parse(k),isDeletion=p[0]==='profile' && p[2]==='deleted' || p[0]==='homework' && p[3]==='deleted';
      const selected=isDeletion && snapshot[k]===true ? heads.find(h=>h.value===true) : winner(heads,k);
      const profileDeleted=snapshot[key('profile',p[1],'deleted')]===true;
      if (profileDeleted && !(p[0]==='profile' && p[2]==='deleted')) continue;
      if (p[0]==='homework' && snapshot[key('homework',p[1],p[2],'deleted')]===true) continue;
      const protectedField=protectedProfiles.has(localSyncProfileId(this.db,p[1]) || '') &&
        (p[0]==='profile' && ['name','deleted'].includes(p[2]) || p[0]==='setting' && p[2]==='userServer');
      if (!selected || protectedField && !isDeepStrictEqual(selected.value,current[k])) result.push({key:k,
        label:this.label(k),current:current[k] ?? null,reason:protectedField ? 'playing-profile' : 'conflict',
        candidates:heads.filter(v=>!isDeletion || snapshot[k]!==true || v.value===true).map(v=>({id:id(v),device:v.device,changedAt:v.clock.utcMs,value:v.value}))});
    }
    return result;
  }
  prepareRemoteImport(envelopes:ProfileSyncEnvelope[]=[]):void {
    const incoming=new Set(envelopes.flatMap(e=>Object.keys(e.cells).map(parse).filter(p=>p[0]==='profile').map(p=>p[1])));
    const ids=(this.db.prepare("SELECT id FROM play_profiles WHERE name<>'' AND deleted_at IS NULL").all() as {id:string}[]).map(p=>p.id);
    // 가져오기로 교체한 프로필의 일지 귀속은 삭제된 이름으로 그대로 보존한다.
    const archived=ids.filter(id=>!incoming.has(remoteId(this.db,id)));
    for (const id of archived) this.db.prepare('UPDATE play_profiles SET deleted_at=? WHERE id=?').run(Date.now(),id);
    for (const id of ids.filter(id=>!archived.includes(id))) {
      this.cacheImportSounds(id);
      this.db.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(id);this.db.prepare('DELETE FROM profile_settings WHERE profile_id=?').run(id);
      this.db.prepare('DELETE FROM profile_tools WHERE profile_id=?').run(id);
    }
    this.setMeta('excludedProfiles',[...new Set([...this.meta<string[]>('excludedProfiles',[]),...archived])]);
    this.db.prepare(`DELETE FROM shared_settings WHERE key IN (${sharedSyncKeys.map(()=>'?').join(',')})`).run(...sharedSyncKeys);
    this.db.prepare('DELETE FROM profile_sync_own').run();this.db.prepare('DELETE FROM profile_sync_cells').run();
    this.setMeta('materialized',{});this.setMeta('acked',0);
    this.setMeta('ownFile',null);this.setMeta('ownPublished',false);
  }
  private cacheImportSounds(local:string):void {
    const rows=this.db.prepare("SELECT key,value FROM profile_settings WHERE profile_id=? AND key IN ('customAlerts','fieldBossSettings')").all(local) as {key:string;value:string}[];
    if (rows.length) this.setMeta(`importSounds:${local}`,Object.fromEntries(rows.map(r=>[r.key,JSON.parse(r.value)])));
  }
  label(k:string):string {
    const p=parse(k),name=this.selected()[key('profile',p[1],'name')] || '프로필';
    const fields:Record<string,string>={name:'이름',userServer:'서버',deleted:'삭제',progress:'숙제 진행',excluded:'숙제 참여 제외',position:'숙제 순서',pinnedNoteText:'메모',buffTimerWarnSeconds:'버프 경고 시점',
      lootKeywords:'득템 키워드',customAlerts:'사용자 지정 알림',buffTimerEnabled:'버프 감지',buffTimerBuffs:'감지할 버프',buffTimerAudioAlert:'버프 소리 알림',buffTimerVisualAlert:'버프 시각 알림',buffTimerCenterAlert:'버프 중앙 알림',
      xpAutoStart:'경험치 자동 시작',xpAutoPauseEnabled:'경험치 자동 일시정지',xpAutoPauseSeconds:'경험치 일시정지 대기',xpEfficiencyAlertEnabled:'경험치 효율 경고',xpEfficiencyDropPercent:'효율 하락 기준',xpEfficiencyMinAmount:'효율 경고 최소량',ignoreNegativeXp:'음수 경험치 제외',
      huntingExpDopings:'경험치 계산 도핑',huntingExpGrounds:'경험치 계산 사냥터',huntingExpSelectedGroundId:'선택한 사냥터',huntingExpKillsPerHour:'시간당 처치 수',huntingExpHappyHour:'해피아워',fieldBossNotifyEnabled:'필드보스 알림',fieldBossNotifyOffsets:'필드보스 사전 알림',fieldBossSettings:'필드보스별 알림',bossEntryCountdownBosses:'보스 입장 안내',
      abandonedEnabled:'어벤던로드 감지',abandonedAutoHideMinutes:'어벤던로드 자동 숨김',digsiteHudEnabled:'발굴지 안내',essenceAlertEnabled:'경험의 정수 알림',specialMonsterAlertEnabled:'특수 몬스터 알림',golgothaAlertEnabled:'골고다 알림',abandonedAlertEnabled:'어벤던로드 알림',pittaHillAlertEnabled:'필멸의 땅 알림',questCompleteAlertEnabled:'도전과제 완료 알림',abyssTreasureAlertEnabled:'심연의 보물창고 알림',waveMonsterWarningEnabled:'몬스터 웨이브 안내',ethosAlertEnabled:'에토스 알림',abyssApostleAlertEnabled:'심연의 사도 알림',lokagosAlertEnabled:'로카고스 알림',supplyHelperEnabled:'보급품 안내',
      tradeServer:'거래 검색 서버',tradeKeywords:'거래 검색 키워드',tradeNotify:'거래 알림',wordAlarmEnabled:'지정 단어 알림',wordAlarmKeywords:'지정 단어',wordAlarmHistoryEnabled:'지정 단어 이력',shoutKeywords:'외치기 키워드',galleryKeywords:'갤러리 키워드',galleryNotify:'갤러리 알림',nicknameNotes:'닉네임 메모',discordKeywords:'디스코드 키워드',discordRules:'디스코드 알림 조건',
      category:'숙제 분류',isVisible:'숙제 표시',isCustom:'사용자 지정 숙제',resetRule:'초기화 주기',maxCount:'목표 횟수',auto:'자동 감지',autoType:'감지 방식',autoDescription:'자동 감지 설명',
      buff_presets:'도핑 프리셋',buff_current_selection:'선택한 도핑',buff_active_preset_id:'선택한 도핑 프리셋','tw-coefficient-calculator-profiles-v1':'계수 계산 프리셋','tw-coefficient-calculator-profiles-v1_last':'선택한 계산 프리셋','tw-coefficient-calculator-settings-v7final':'계수 계산 입력'};
    return p[0]==='shared' ? `공통 설정 · ${fields[p[1]] || '알림 설정'}` : `${name} · ${p[0]==='homework' ? `${this.selected()[key('homework',p[1],p[2],'name')] || '숙제'} · ` : ''}${fields[p.at(-1)!] || '프로필 설정'}`;
  }
  resolve(k:string,candidate:string):void {
    const heads=this.values()[k];if (!heads) throw new Error('변경 항목을 다시 확인해 주세요.');
    const current=this.meta<Snapshot>('materialized',{});
    const chosen=candidate==='local' ? current[k] ?? null : heads.find(v=>id(v)===candidate)?.value;
    if (chosen===undefined) throw new Error('선택한 값을 찾을 수 없습니다. 다시 확인해 주세요.');
    const p=parse(k);
    if ((p[0]==='profile' && p[2]==='deleted' || p[0]==='homework' && p[3]==='deleted') && heads.some(v=>v.value===true) && chosen!==true) throw new Error('삭제된 항목은 복구할 수 없습니다. 새 프로필/숙제로 복사해 주세요.');
    this.writeValue(k,chosen);
  }
  private writeValue(k:string,chosen:unknown,automatic=false):void {
    this.db.transaction(()=>{
      const vector=this.meta<SyncVector>('vector',{}),sequence=(vector[this.device] || 0)+1;
      const cell:SyncValue={device:this.device,sequence,context:vector,clock:this.clock(),value:chosen};
      this.db.prepare('INSERT OR REPLACE INTO profile_sync_cells VALUES(?,?)').run(k,text([cell]));
      this.db.prepare('INSERT OR REPLACE INTO profile_sync_own VALUES(?,?)').run(k,text(cell));
      this.setMeta('vector',{...vector,[this.device]:sequence});this.setMeta('pendingSince',this.meta('pendingSince',Date.now()) || Date.now());this.setMeta('lastChangeAt',Date.now());
      const category=automatic ? 'Automatic' : 'User';this.setMeta(`pending${category}Since`,this.meta(`pending${category}Since`,0) || Date.now());this.setMeta(`last${category}ChangeAt`,Date.now());
    })();
  }
  /** DB 원본만 반영한다. 화면/기록 재생/HUD는 호출자가 commit 후 갱신한다. */
  apply(activeLocalId?:string,acceptedKeys:readonly string[]=[]):void {
    this.db.transaction(()=>{
      const selected=this.selected(),reviews=this.reviews(activeLocalId);
      this.setMeta('identityReviews',[...new Set(reviews.filter(r=>r.reason==='playing-profile').map(r=>localSyncProfileId(this.db,parse(r.key)[1])).filter(Boolean))]);
      const blocked=new Set(reviews.filter(r=>!acceptedKeys.includes(r.key)).map(r=>r.key));
      const current=this.meta<Snapshot>('materialized',{});
      const next={...selected};for (const k of blocked) next[k]=current[k];
      const ids=new Set(Object.keys(next).map(parse).filter(p=>p[0]==='profile').map(p=>p[1]));
      for (const rid of ids) {
        const name=next[key('profile',rid,'name')],server=next[key('setting',rid,'userServer')];
        const deleted=next[key('profile',rid,'deleted')]===true;
        let local=localSyncProfileId(this.db,rid);
        if (!local) {
          if (typeof name!=='string' || !name.trim() || !isProfileServer(server)) continue;
          // 이름과 서버가 없는 초기 기본 프로필만 재사용한다. 기존 소유 ID는 교체하지 않는다.
          const blank=this.db.prepare("SELECT p.id FROM play_profiles p WHERE p.deleted_at IS NULL AND p.name='' AND NOT EXISTS(SELECT 1 FROM profile_sync_ids m WHERE m.local_id=p.id) LIMIT 1").get() as {id:string} | undefined;
          local=blank?.id || rid;
          if (!blank) this.db.prepare('INSERT INTO play_profiles(id,name,created_at) VALUES(?,?,?)').run(local,name,Number(next[key('profile',rid,'created')]) || Date.now());
          else this.db.prepare('UPDATE play_profiles SET name=?,created_at=? WHERE id=?').run(name,Number(next[key('profile',rid,'created')]) || Date.now(),local);
          this.db.prepare('INSERT INTO profile_sync_ids VALUES(?,?)').run(local,rid);
          if (blank) {this.cacheImportSounds(local);this.db.prepare('DELETE FROM profile_settings WHERE profile_id=?').run(local);this.db.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(local);}
        }
        const p=this.db.prepare('SELECT deleted_at FROM play_profiles WHERE id=?').get(local) as {deleted_at:number | null};
        if (p.deleted_at!==null) continue;
        if (deleted) {this.db.prepare('UPDATE play_profiles SET deleted_at=? WHERE id=?').run(Date.now(),local);this.db.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(local);continue;}
        if (typeof name==='string') this.db.prepare('UPDATE play_profiles SET name=? WHERE id=?').run(name,local);
        const items=new Map<string,Record<string,unknown>>();
        for (const [k,value] of Object.entries(next)) {
          const parts=parse(k);if (parts[1]!==rid) continue;
          if (parts[0]==='setting' || parts[0]==='tool') {
            const table=parts[0]==='setting' ? 'profile_settings' : 'profile_tools';
            if (value===null || value===undefined) this.db.prepare(`DELETE FROM ${table} WHERE profile_id=? AND key=?`).run(local,parts[2]);
            else {
              const previous=this.db.prepare(`SELECT value FROM ${table} WHERE profile_id=? AND key=?`).get(local,parts[2]) as {value:string} | undefined;
              const prior=parts[0]==='tool' ? null : previous ? JSON.parse(previous.value) : this.meta<Record<string,unknown>>(`importSounds:${local}`,{})[parts[2]];
              this.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?,?)`).run(local,parts[2],parts[0]==='tool' ? value : text(withLocalSounds(parts[2],value,prior)));
            }
          }
          if (parts[0]==='homework') {const item=items.get(parts[2]) || {};item[parts[3]]=value;items.set(parts[2],item);}
        }
        for (const [itemId,item] of items) {
          if (item.deleted===true) {this.db.prepare('DELETE FROM profile_homework WHERE profile_id=? AND item_id=?').run(local,itemId);continue;}
          const {progress,excluded,position,deleted:_deleted,...fields}=item;
          const definition={id:itemId,...Object.fromEntries(Object.entries(fields).filter(([,v])=>v!==null && v!==undefined))};
          if (!fields.name || !fields.resetRule) continue;
          let raw={...((progress as {state?:Record<string,unknown>} | null)?.state || {})};
          const currentCycle=profileSyncResetCycle(fields.resetRule as {type:string;hour?:number;dayOfWeek?:number},this.clock().utcMs);
          const oldCycle=Number((progress as {cycle?:number} | null)?.cycle ?? currentCycle);
          const unresolved=[...blocked].some(k=>{const p=parse(k);return p[0]==='homework' && p[1]===rid && p[2]===itemId;});
          if (!unresolved) {
            const max=Number(fields.maxCount) || 1,count=Number(raw.currentCount ?? (raw.isCompleted ? max : 0));
            const expired=oldCycle<currentCycle;
            const clamped=Math.max(0,Math.min(max,count));
            if (expired) raw={currentCount:0,isCompleted:false};
            else if (clamped!==count || typeof raw.isCompleted==='boolean' && raw.isCompleted!==(clamped>=max)) raw={...raw,currentCount:clamped,isCompleted:clamped>=max};
            if (!isDeepStrictEqual(raw,(progress as {state?:unknown} | null)?.state || {})) this.writeValue(key('homework',rid,itemId,'progress'),{cycle:currentCycle,state:raw},true);
          }
          const state={...raw,isExcluded:excluded===true};
          this.db.prepare('INSERT OR REPLACE INTO profile_homework VALUES(?,?,?,?,?)').run(local,itemId,text(definition),text(state),Number(position) || 0);
        }
        this.db.prepare('DELETE FROM profile_sync_meta WHERE key=?').run(`importSounds:${local}`);
      }
      for (const [k,value] of Object.entries(next)) {
        const p=parse(k);if (p[0]!=='shared') continue;
        if (value===null || value===undefined) this.db.prepare('DELETE FROM shared_settings WHERE key=?').run(p[1]);
        else this.db.prepare('INSERT OR REPLACE INTO shared_settings VALUES(?,?)').run(p[1],text(value));
      }
      // 실제로 반영된 원본을 기준으로 삼아 미해결/삭제 후보를 새 로컬 편집으로 재전송하지 않는다.
      this.setMeta('materialized',portableProfileSnapshot(this.db));
      this.setMeta('identityReviews',[...new Set(this.reviews(activeLocalId).filter(r=>r.reason==='playing-profile').map(r=>localSyncProfileId(this.db,parse(r.key)[1])).filter(Boolean))]);
    })();
  }
}
