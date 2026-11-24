import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'crypto';
import {isDeepStrictEqual} from 'util';
import {PROFILE_SETTING_KEYS,SHARED_SETTING_KEYS,isProfileServer,assertProfileName,type ProfileClockStamp} from '../shared/playProfiles';
import {isProfileToolKey,isSyncableProfileToolValue,MAX_PROFILE_TOOL_VALUE_LENGTH} from '../shared/profileTools';
import {PROFILE_SYNC_POLICY,type SyncValue,type SyncVector,type ProfileSyncEnvelope,type ProfileSyncReview} from '../shared/profileSync';
import {sanitizeExternalConfigPatch} from './config';
import type {ResetRule} from '../shared/types';
import {getHomeworkCycleStart,getHomeworkCycleEnd,homeworkDayMs} from '../shared/homeworkResetCycle';

export {getHomeworkCycleStart as profileSyncResetCycle} from '../shared/homeworkResetCycle';

type Snapshot=Record<string,unknown>;
type UploadSizing=NonNullable<import('../shared/profileSync').ProfileSyncDetails['uploadSizing']>;
// DB의 프로필 공통 저장과 Google 전송 허용은 별개다. 닉네임 메모의 기존 로컬 전용 정책을 유지한다.
const sharedSyncKeys=(SHARED_SETTING_KEYS as readonly string[]).filter(k=>k!=='nicknameNotes');
const key=(...parts:string[])=>JSON.stringify(parts);
const parse=(value:string):string[]=>JSON.parse(value);
const text=(value:unknown)=>JSON.stringify(value);
const SNAPSHOT_KEY='materialized';
const SHARED_PARTITION='';
function readMaterialized(db:Database.Database,remote?:string):Snapshot {
  const rows=(remote===undefined
    ? db.prepare('SELECT value FROM profile_sync_materialized').all()
    : db.prepare('SELECT value FROM profile_sync_materialized WHERE profile IN (?,?)').all(SHARED_PARTITION,remote)) as {value:string}[];
  return Object.assign({},...rows.map(row=>JSON.parse(row.value)));
}
function writeMaterialized(db:Database.Database,snapshot:Snapshot,remote?:string):void {
  const partitions=new Map<string,Snapshot>();
  for (const [k,value] of Object.entries(snapshot)) {
    const parts=parse(k),partition=parts[0]==='shared' ? SHARED_PARTITION : parts[1];
    if (!partitions.has(partition)) partitions.set(partition,{});
    partitions.get(partition)![k]=value;
  }
  db.transaction(()=>{
    if (remote===undefined) db.prepare('DELETE FROM profile_sync_materialized').run();
    else for (const partition of [SHARED_PARTITION,remote]) {
      if (!partitions.has(partition)) db.prepare('DELETE FROM profile_sync_materialized WHERE profile=?').run(partition);
    }
    const write=db.prepare(`INSERT INTO profile_sync_materialized VALUES(?,?) ON CONFLICT(profile) DO UPDATE
      SET value=excluded.value WHERE value<>excluded.value`);
    for (const [partition,fields] of partitions) write.run(partition,text(fields));
  })();
}
const read=<T>(db:Database.Database,k:string,fallback:T):T=>{
  if (k===SNAPSHOT_KEY) return readMaterialized(db) as T;
  const row=db.prepare('SELECT value FROM profile_sync_meta WHERE key=?').get(k) as {value:string} | undefined;
  return row ? JSON.parse(row.value) : fallback;
};
const write=(db:Database.Database,k:string,value:unknown):void=>{
  if (k===SNAPSHOT_KEY) writeMaterialized(db,value as Snapshot);
  else db.prepare('INSERT OR REPLACE INTO profile_sync_meta VALUES(?,?)').run(k,text(value));
};
function portableSetting(field:string,value:unknown):unknown {
  const fields:Record<string,string[]>={customAlerts:['id','enabled','type','time','minute','offsets','message'],
    huntingExpDopings:['id','name','percent','duration','enabled','note'],huntingExpGrounds:['id','name','baseXp'],
    nicknameNotes:['server','nickname','note'],discordRules:['keyword','targetNormal','targetClub','targetShout','targetSender']};
  const pick=(v:unknown,keys:string[])=>v && typeof v==='object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([k])=>keys.includes(k))) : v;
  // 구버전 알림은 offsets/hourly minute 없이 저장될 수 있다. 실행(customNotifier)과 편집 화면이 쓰는
  // 기본값(offsets ?? [0], minute ?? 0)으로 맞춰 보내 한 항목 때문에 이 PC의 전송 전체가 막히지 않게 한다.
  // 회귀: check-profile-sync-model.ts (구버전 사용자 지정 알림).
  if (field==='customAlerts' && Array.isArray(value)) return value.map(v=>{
    const alert=pick(v,fields[field]);
    if (!alert || typeof alert!=='object' || Array.isArray(alert)) return alert;
    const {offsets,minute,...rest}=alert as Record<string,unknown>;
    return {...rest,offsets:offsets ?? [0],...(rest.type==='hourly' ? {minute:minute ?? 0} : minute===undefined ? {} : {minute})};
  });
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
type HomeworkProgress={cycle:number;state:{isCompleted?:boolean;currentCount?:number;lastCompletedAt?:number};expiresAt?:number};
const isProgressKey=(parts:string[])=>parts[0]==='homework' && parts[3]==='progress';
const isRuleKey=(parts:string[])=>parts[0]==='homework' && parts[3]==='resetRule';
function hasProgressEdit(state:HomeworkProgress['state'] | undefined):boolean {
  return state?.isCompleted===true || (state?.currentCount || 0)>0 || (state?.lastCompletedAt || 0)>0;
}
function comparableValues(k:string | undefined,values:SyncValue[]):SyncValue[] {
  if (!k || !isProgressKey(parse(k))) return values;
  const edits=values.filter(v=>hasProgressEdit((v.value as HomeworkProgress | null)?.state));
  // 구버전은 자동 리셋과 수동 해제를 같은 모양으로 기록했다. 같은 주기의 실제
  // 진행을 이미 본 0회만 해제로 인정하며, 다른 주기나 동시 진행에는 적용하지 않는다.
  return values.filter(v=>{
    const progress=v.value as HomeworkProgress | null;
    return hasProgressEdit(progress?.state) || !!progress && edits.some(previous=>
      previous!==v && (previous.value as HomeworkProgress).cycle===progress.cycle && dominates(v,previous));
  });
}

function causalHeads(values:SyncValue[],k?:string,legacyChecked=false):SyncValue[] {
  const unique=new Map<string,SyncValue>();
  for (const value of values) {
    const previous=unique.get(id(value));
    if (previous && !isDeepStrictEqual(previous,value)) throw new Error('동일 변경 ID의 내용이 다릅니다. 원격 데이터를 보존하고 중지했습니다.');
    unique.set(id(value),value);
  }
  const candidates=legacyChecked ? [...unique.values()] : comparableValues(k,[...unique.values()]);
  return candidates.filter(value=>!candidates.some(other=>{
    if (other===value || !dominates(other,value)) return false;
    if (!k || !isProgressKey(parse(k))) return true;
    const next=other.value as HomeworkProgress,prior=value.value as HomeworkProgress;
    // 확인된 구버전 해제의 인과 범위도 해당 주기에 한정한다.
    return hasProgressEdit(next.state) || next.cycle===prior.cycle;
  })).sort((a,b)=>id(a).localeCompare(id(b)));
}
export function mergeSyncValues(values:SyncValue[],k?:string):SyncValue[] {return causalHeads(values,k);}

function headsAt(db:Database.Database,k:string):SyncValue[] {
  const row=db.prepare('SELECT heads FROM profile_sync_cells WHERE key=?').get(k) as {heads:string} | undefined;
  return row ? JSON.parse(row.heads) : [];
}

/** 기기별 마지막 원본은 후보가 아니어도 보관한다. 늦게 도착한 조상과 구버전 해제의 근거가 된다. */
function recordSyncSource(db:Database.Database,k:string,cell:SyncValue):void {
  const save=db.prepare('INSERT INTO profile_sync_sources VALUES(?,?,?,?) ON CONFLICT(key,device) DO UPDATE SET sequence=excluded.sequence,value=excluded.value WHERE excluded.sequence>sequence');
  const load=()=>db.prepare('SELECT value FROM profile_sync_sources WHERE key=?').all(k) as {value:string}[];
  let rows=load();
  if (!rows.length) {
    for (const head of headsAt(db,k)) save.run(k,head.device,head.sequence,text(head));
    rows=load();
  }
  const sources=rows.map(row=>JSON.parse(row.value) as SyncValue);
  const same=sources.find(source=>source.device===cell.device);
  if (same?.sequence===cell.sequence && !isDeepStrictEqual(same,cell)) throw new Error('동일 변경 ID의 내용이 다릅니다. 원격 데이터를 보존하고 중지했습니다.');
  if (isProgressKey(parse(k))) {
    const positive=hasProgressEdit((cell.value as HomeworkProgress | null)?.state);
    const priorPositive=hasProgressEdit((same?.value as HomeworkProgress | null)?.state);
    const changedCycle=(cell.value as HomeworkProgress | null)?.cycle!==(same?.value as HomeworkProgress | null)?.cycle;
    const basis=positive && same && same.sequence>cell.sequence && (!priorPositive || changedCycle) ? cell
      : same && same.sequence<cell.sequence && priorPositive && (!positive || changedCycle) ? same : undefined;
    if (basis) db.prepare('INSERT INTO profile_sync_progress_evidence VALUES(?,?,?,?) ON CONFLICT(key,device) DO UPDATE SET sequence=excluded.sequence,value=excluded.value WHERE excluded.sequence>sequence').run(k,basis.device,basis.sequence,text(basis));
  }
  if (!same || same.sequence<cell.sequence) {
    save.run(k,cell.device,cell.sequence,text(cell));
    if (same) sources.splice(sources.indexOf(same),1);
    sources.push(cell);
  }
  if (isProgressKey(parse(k))) {
    const evidence=db.prepare('SELECT value FROM profile_sync_progress_evidence WHERE key=?').all(k) as {value:string}[];
    sources.push(...evidence.map(row=>JSON.parse(row.value)));
  }
  const heads=mergeSyncValues(sources,k);
  if (heads.length) db.prepare('INSERT OR REPLACE INTO profile_sync_cells VALUES(?,?)').run(k,text(heads));
  else db.prepare('DELETE FROM profile_sync_cells WHERE key=?').run(k);
}

function fieldContext(db:Database.Database,k:string,device:string,sequence:number):SyncVector {
  const context:SyncVector=Object.create(null);
  for (const head of headsAt(db,k)) {
    for (const [writer,seen] of [...Object.entries(head.context),[head.device,head.sequence] as const]) {
      if (writer!==device) context[writer]=Math.max(context[writer] || 0,seen);
    }
  }
  if (sequence>1) context[device]=sequence-1;
  return context;
}

function ruleClock(db:Database.Database,k:string,before:unknown,value:unknown,clock:ProfileClockStamp):SyncValue['clock'] {
  if (!isRuleKey(parse(k)) || !before || !value) return clock;
  const cutoff=Math.max(getHomeworkCycleStart(before as ResetRule,clock.utcMs),getHomeworkCycleStart(value as ResetRule,clock.utcMs),
    ...headsAt(db,k).map(head=>head.clock.homeworkCutoffAt ?? 0));
  return {...clock,homeworkCutoffAt:cutoff};
}

export function selectSyncWinner(values:SyncValue[],comparable:(a:SyncValue,b:SyncValue)=>boolean=(a,b)=>isDeepStrictEqual(a.value,b.value)):SyncValue | undefined {
  if (!values.length) return undefined;
  if (values.every(v=>comparable(v,values[0]))) return values[0];
  return values.find(v=>v.clock.source==='internet' && values.every(other=>comparable(v,other) ||
    other.clock.source==='internet' && v.clock.utcMs-(v.clock.uncertaintyMs ?? Infinity)>
      other.clock.utcMs+(other.clock.uncertaintyMs ?? Infinity)));
}

/** 프로필 생성 시각은 PC마다 이전·생성한 시각이라 값이 달라도 사용자가 고를 의미가 없다(v3.2.2 두 PC 업그레이드).
 * 확인할 변경으로 남기지 않고 가장 이른 시각을 고른다. 수신 순서와 무관하게 같은 값으로 수렴한다.
 * 회귀: check-profile-sync-scenarios.ts(v3.2.2 두 PC 업그레이드 병합). */
const isProfileCreatedKey=(p:string[]):boolean=>p[0]==='profile' && p[2]==='created';
function selectEarliestCreated(values:SyncValue[]):SyncValue | undefined {
  return values.reduce<SyncValue | undefined>((best,value)=>!best || Number(value.value)<Number(best.value)
    || Number(value.value)===Number(best.value) && value.device<best.device ? value : best,undefined);
}

/** 기능 계약 — v3.2.2에서 PC마다 따로 보관하던 설정의 이전 값 병합.
 * - v3.2.2는 고정 메모(pinnedNoteText)와 발굴지 안내(digsiteHudEnabled)를 동기화하지 않아 PC마다 값이 다를 수 있다.
 *   이전은 그 PC의 값을 모든 캐릭터 프로필에 복사하고, 같은 캐릭터는 두 PC에서 같은 프로필로 이어진다(legacyCharacterSyncId).
 *   이전 직후 기록은 시계가 미검증이라 순서를 정할 수 없어, 그대로 두면 캐릭터마다 확인할 변경이 생긴다.
 * - 이전 직후 처음 기록한 이 두 설정의 셀에만 clock.legacyMigration을 붙인다(capture의 첫 기록·v3.2.2 캐릭터 프로필).
 *   이전·구형 설정 복원 때 남긴 v3.2.2 원래 값(app_meta legacy_device_local_settings, 키별 값 목록) 중 하나와 같을 때만
 *   붙인다. 서버를 정하지 않아 첫 기록이
 *   늦어진 캐릭터에서 그 사이 사용자가 고친 값은 이전 값이 아니므로 기존 충돌 규칙을 따른다. 원래 값 기록이 없는
 *   이전(이 계약 이전 빌드)은 첫 기록만으로 판단한다.
 * - 자동 병합한 값을 복원 등으로 다시 기록하면(rebaseOwn) 병합에 쓴 모든 후보를 인과적으로 덮는 셀로 만든다.
 *   그래서 다른 PC에서 확인할 변경이 다시 생기지 않고 같은 값으로 수렴한다. 이 셀도 이전 값 표식을 유지해, 늦게 도착한
 *   다른 PC(셋째 PC 등)의 이전 값과도 확인 없이 이어 붙인다.
 * - 한 필드의 후보가 모두 이전 값이면 확인 없이 정한다. 메모는 기기 ID 순서로 서로 다른 내용을 구분선으로 이어 붙이고
 *   (같은 내용은 하나), 발굴지 안내는 한쪽이라도 켰으면 켠다. 어느 PC에서 받아도 같은 값으로 수렴하고 어느 메모도 버리지 않는다.
 * - 이어 붙인 메모가 저장 한도(1000자)를 넘으면 자동으로 정하지 않고 지금처럼 확인할 변경으로 남긴다.
 * - 이전 뒤 사용자가 고친 값(표식 없음)이 하나라도 후보에 있으면 기존 충돌 규칙을 그대로 쓴다.
 * 회귀: check-profile-sync-model.ts(v3.2.2 두 PC의 서로 다른 메모). */
export const LEGACY_DEVICE_LOCAL_SETTING_KEYS=['pinnedNoteText','digsiteHudEnabled'] as const;
const LEGACY_DEVICE_LOCAL_SETTINGS:readonly string[]=LEGACY_DEVICE_LOCAL_SETTING_KEYS;
const LEGACY_MEMO_SEPARATOR='\n---\n';
const isLegacyDeviceLocalSetting=(p:string[]):boolean=>p[0]==='setting' && p.length===3 && LEGACY_DEVICE_LOCAL_SETTINGS.includes(p[2]);
/** 키별 v3.2.2 원래 값 목록. 이 계약 이전 형식(키별 단일 값)도 목록으로 읽는다. */
function legacyDeviceLocalOriginals(db:Database.Database):Record<string,unknown[]> | undefined {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
  const row=exists ? db.prepare("SELECT value FROM app_meta WHERE key='legacy_device_local_settings'").get() as {value:string} | undefined : undefined;
  if (!row) return;
  let value:unknown;
  try {value=JSON.parse(row.value);} catch {return;}
  if (!value || typeof value!=='object' || Array.isArray(value)) return;
  return Object.fromEntries(Object.entries(value).map(([field,entry])=>[field,Array.isArray(entry) ? entry : [entry]]));
}
/** 이전·구형 설정 복원에서 그 v3.2.2 설정의 원래 값을 기존 목록에 더한다(같은 값은 한 번). 같은 transaction에서 호출한다. */
export function rememberLegacyDeviceLocalOriginals(db:Database.Database,legacy:Partial<Record<(typeof LEGACY_DEVICE_LOCAL_SETTING_KEYS)[number],unknown>>):void {
  const originals=legacyDeviceLocalOriginals(db) ?? {};
  for (const field of LEGACY_DEVICE_LOCAL_SETTING_KEYS) {
    const value=legacy[field];
    if (value===undefined) continue;
    const list=originals[field] ?? [];
    if (!list.some(entry=>isDeepStrictEqual(entry,value))) list.push(value);
    originals[field]=list;
  }
  db.prepare("INSERT INTO app_meta VALUES('legacy_device_local_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(originals));
}
function legacyMigrationClock(db:Database.Database,k:string,before:Snapshot,value:unknown,clock:SyncValue['clock']):SyncValue['clock'] {
  const p=parse(k);
  if (!isLegacyDeviceLocalSetting(p) || !p[1].startsWith(LEGACY_SYNC_ID_PREFIX) || before[key('profile',p[1],'name')]!==undefined) return clock;
  const originals=legacyDeviceLocalOriginals(db);
  if (originals && Object.hasOwn(originals,p[2]) && !originals[p[2]].some(original=>isDeepStrictEqual(value,original))) return clock;
  return {...clock,legacyMigration:true};
}
function selectLegacyDeviceLocalSetting(k:string,heads:SyncValue[]):SyncValue | undefined {
  const p=parse(k);
  if (!isLegacyDeviceLocalSetting(p) || heads.length<2 || heads.some(head=>head.clock.legacyMigration!==true)
    || heads.every(head=>isDeepStrictEqual(head.value,heads[0].value))) return undefined;
  const ordered=[...heads].sort((a,b)=>a.device.localeCompare(b.device) || a.sequence-b.sequence);
  if (p[2]==='digsiteHudEnabled') return {...ordered[0],value:ordered.some(head=>head.value===true)};
  const texts:string[]=[];
  for (const head of ordered) {
    if (typeof head.value==='string' && head.value.trim() && !texts.some(text=>text.trim()===(head.value as string).trim())) texts.push(head.value);
  }
  const value=texts.join(LEGACY_MEMO_SEPARATOR);
  return validPortableSetting(p[2],value) ? {...ordered[0],value} : undefined;
}

function effectiveProgress(progress:HomeworkProgress,max:number) {
  const count=progress.state.currentCount ?? (progress.state.isCompleted ? max : 0);
  return {count:Math.min(max,count),completed:count>=max};
}

function progressCell(k:string,value:unknown,clock:SyncValue['clock']):{value:unknown;clock:SyncValue['clock']} {
  if (!isProgressKey(parse(k)) || !value || typeof value!=='object' || !('expiresAt' in value)) return {value,clock};
  const {expiresAt,...wire}=value as HomeworkProgress;
  // 기존 v1 검증기는 clock의 부가 메타데이터를 허용한다. progress 값의 형식은 그대로 유지한다.
  return {value:wire,clock:expiresAt===undefined ? clock : {...clock,homeworkExpiresAt:expiresAt}};
}

export function prepareProfileSyncSchema(db:Database.Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS profile_sync_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_sync_materialized(profile TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_sync_ids(local_id TEXT PRIMARY KEY,remote_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS profile_sync_cells(key TEXT PRIMARY KEY,heads TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_sync_own(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_sync_sources(key TEXT NOT NULL,device TEXT NOT NULL,sequence INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(key,device));
    CREATE TABLE IF NOT EXISTS profile_sync_progress_evidence(key TEXT NOT NULL,device TEXT NOT NULL,sequence INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(key,device));
    CREATE TABLE IF NOT EXISTS profile_homework_expiry(profile_id TEXT NOT NULL,item_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,item_id),FOREIGN KEY(profile_id,item_id) REFERENCES profile_homework(profile_id,item_id) ON DELETE CASCADE);
    CREATE VIEW IF NOT EXISTS profile_homework_progress AS SELECT h.*,e.expires_at FROM profile_homework h
      LEFT JOIN profile_homework_expiry e ON e.profile_id=h.profile_id AND e.item_id=h.item_id AND e.recorded_at=json_extract(h.state,'$.lastCompletedAt');
    CREATE TABLE IF NOT EXISTS profile_sync_tombstones(key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS profile_homework_deleted_items(profile_id TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(profile_id,item_id));`);
  const legacy=db.prepare('SELECT value FROM profile_sync_meta WHERE key=?').get(SNAPSHOT_KEY) as {value:string} | undefined;
  if (legacy) db.transaction(()=>{
    writeMaterialized(db,JSON.parse(legacy.value));
    db.prepare('DELETE FROM profile_sync_meta WHERE key=?').run(SNAPSHOT_KEY);
  })();
  if (!read(db,'separateHomeworkExpiry',false)) db.transaction(()=>{
    db.exec(`INSERT OR IGNORE INTO profile_homework_expiry
      SELECT profile_id,item_id,json_extract(state,'$.lastCompletedAt'),json_extract(state,'$.progressExpiresAt') FROM profile_homework
      WHERE json_type(state,'$.lastCompletedAt')='integer' AND json_type(state,'$.progressExpiresAt')='integer';
      UPDATE profile_homework SET state=json_remove(state,'$.progressExpiresAt') WHERE json_type(state,'$.progressExpiresAt') IS NOT NULL;`);
    write(db,'separateHomeworkExpiry',true);
  })();
}

export function saveHomeworkExpiry(db:Database.Database,profile:string,item:string,at:number | undefined,expires:number | undefined):void {
  if (at!==undefined && expires!==undefined) db.prepare('INSERT OR REPLACE INTO profile_homework_expiry VALUES(?,?,?,?)').run(profile,item,at,expires);
}

function snapshotForStorage(snapshot:Snapshot):Snapshot {
  return Object.fromEntries(Object.entries(snapshot).map(([k,value])=>{
    if (!isProgressKey(parse(k)) || !value) return [k,value];
    const {cycle,state}=value as HomeworkProgress;
    return [k,{cycle,state}];
  }));
}
function mappedRemoteId(db:Database.Database,local:string):string | undefined {
  return (db.prepare('SELECT remote_id FROM profile_sync_ids WHERE local_id=?').get(local) as {remote_id:string} | undefined)?.remote_id;
}
const LEGACY_SYNC_ID_PREFIX='legacy-character-';
/** v3.2.2 캐릭터에서 이전한 프로필의 동기화 ID 계약.
 * - v3.2.2는 캐릭터 목록을 동기화했으므로 같은 캐릭터는 PC마다 같은 캐릭터 ID를 갖는다.
 *   이전할 때 프로필 ID는 PC마다 새로 정해지므로, 그 ID로 동기화하면 같은 캐릭터가 Google에서 두 프로필이 된다.
 * - 캐릭터 ID에서 동기화 ID를 정해 두 PC의 같은 캐릭터를 한 프로필로 잇는다. 원본 ID는 해시로만 쓴다.
 * - 이미 동기화 ID가 있는 프로필(이전 버전에서 동기화함)은 바꾸지 않는다.
 * 회귀: check-profile-sync-model.ts(v3.2.2 두 PC 업그레이드 뒤 병합). */
function legacyCharacterSyncId(characterId:string):string {
  return LEGACY_SYNC_ID_PREFIX+createHash('sha256').update(characterId,'utf8').digest('hex').slice(0,32);
}
function hasLegacyCharacterTable(db:Database.Database):boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_character_profiles'").get();
}
function legacySyncIdForProfile(db:Database.Database,local:string):string | undefined {
  if (!hasLegacyCharacterTable(db)) return;
  const row=db.prepare('SELECT character_id FROM legacy_character_profiles WHERE profile_id=?').get(local) as {character_id:string} | undefined;
  return row ? legacyCharacterSyncId(row.character_id) : undefined;
}
/** 원격 동기화 ID와 같은 v3.2.2 캐릭터에서 이전했지만 아직 동기화 ID가 없는 이 PC의 프로필. */
function unmappedLegacyProfileForSyncId(db:Database.Database,remote:string):string | undefined {
  if (!remote.startsWith(LEGACY_SYNC_ID_PREFIX) || !hasLegacyCharacterTable(db)) return;
  const rows=db.prepare(`SELECT l.character_id,l.profile_id FROM legacy_character_profiles l JOIN play_profiles p ON p.id=l.profile_id
    WHERE p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM profile_sync_ids m WHERE m.local_id=l.profile_id)`)
    .all() as {character_id:string;profile_id:string}[];
  return rows.find(row=>legacyCharacterSyncId(row.character_id)===remote)?.profile_id;
}
function remoteId(db:Database.Database,local:string):string {
  const mapped=mappedRemoteId(db,local);
  if (mapped) return mapped;
  const legacy=legacySyncIdForProfile(db,local);
  // 같은 ID를 이미 다른 로컬 프로필이 쓰고 있으면(동일 캐릭터를 따로 받은 경우) 기존 규칙으로 새 ID를 쓴다.
  const value=legacy && !localSyncProfileId(db,legacy) ? legacy : local==='profile-default' ? randomUUID() : local;
  db.prepare('INSERT INTO profile_sync_ids VALUES(?,?)').run(local,value);return value;
}
/** 새 프로필의 설정 복사에서도 제외한 기본 숙제는 재시작/다른 PC에서 되살리지 않는다.
 * 새 프로필에 원래 행이 없으면 snapshot 차이만으로 삭제를 감지할 수 없어 명시적으로 보존한다.
 * 호출자는 프로필 생성/원본·outbox와 같은 transaction 안에서 사용한다. */
export function rememberProfileHomeworkDeletion(db:Database.Database,local:string,item:string):void {
  db.prepare('INSERT OR IGNORE INTO profile_sync_tombstones VALUES(?)').run(key('homework',remoteId(db,local),item,'deleted'));
}
/** 이 PC에서 삭제했거나 원격 삭제를 반영한 숙제를 로컬 프로필 ID로 영구 기록한다.
 * 변경 이력은 전송 확인(acknowledge) 뒤, 동기화 삭제 표식은 계정 분리(rebaseOwn) 때 정리되지만
 * 이 표식은 어느 쪽에서도 지우지 않는다. 기본 숙제 보충(fillMissingDefaultHomework)만 읽는다.
 * 회귀: check-profile-sync-model.ts (계정 전환 뒤 기본 숙제 부활 방지). */
export function rememberDeletedHomework(db:Database.Database,local:string,item:string):void {
  db.prepare('INSERT OR IGNORE INTO profile_homework_deleted_items VALUES(?,?)').run(local,item);
}
export function localSyncProfileId(db:Database.Database,remote:string):string | undefined {
  return (db.prepare('SELECT local_id FROM profile_sync_ids WHERE remote_id=?').get(remote) as {local_id:string} | undefined)?.local_id;
}

/** 허용된 원본만 읽는다. 일지/로그/HUD/현재 선택/인증/기기 경로는 조회하지 않는다. */
export function portableProfileSnapshot(db:Database.Database,profileId?:string):Snapshot {
  const result:Snapshot={};
  let prior:Snapshot | undefined;
  const priorSnapshot=()=>prior ??= readMaterialized(db,profileId ? mappedRemoteId(db,profileId) ?? SHARED_PARTITION : undefined);
  const profiles=db.prepare('SELECT id,name,created_at,deleted_at FROM play_profiles'+(profileId ? ' WHERE id=?' : ''))
    .all(...(profileId ? [profileId] : [])) as {id:string;name:string;created_at:number;deleted_at:number | null}[];
  const excluded=new Set(read<string[]>(db,'excludedProfiles',[]));
  const foreignDeleted=new Set(read<string[]>(db,'foreignDeletedProfileIds',[]));
  for (const p of profiles) {
    if (excluded.has(p.id) || p.deleted_at!==null && foreignDeleted.has(p.id)) continue;
    const server=db.prepare("SELECT value FROM profile_settings WHERE profile_id=? AND key='userServer'").get(p.id) as {value:string} | undefined;
    if (!p.name.trim() || !isProfileServer(server ? JSON.parse(server.value) : null)) {
      const mapping=db.prepare('SELECT remote_id FROM profile_sync_ids WHERE local_id=?').get(p.id) as {remote_id:string} | undefined;
      if (mapping) {
        for(const [k,v] of Object.entries(priorSnapshot())) if(parse(k)[0]!=='shared' && parse(k)[1]===mapping.remote_id) result[k]=v;
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
      if (!isProfileToolKey(row.key)) continue;
      const toolKey=key('tool',rid,row.key);
      if (isSyncableProfileToolValue(row.value)) result[toolKey]=row.value;
      else {
        const previous=priorSnapshot()[toolKey];
        if (isSyncableProfileToolValue(previous)) result[toolKey]=previous;
      }
    }
    for (const row of db.prepare('SELECT item_id,definition,state,position,expires_at FROM profile_homework_progress WHERE profile_id=?').all(p.id) as {item_id:string;definition:string;state:string;position:number;expires_at:number | null}[]) {
      result[key('homework',rid,row.item_id,'deleted')]=false;
      for (const [field,value] of Object.entries(JSON.parse(row.definition))) if (field!=='id') result[key('homework',rid,row.item_id,field)]=value;
      const {isExcluded,...progress}=JSON.parse(row.state),definition=JSON.parse(row.definition);
      if (hasProgressEdit(progress)) {
        const progressKey=key('homework',rid,row.item_id,'progress');
        const at=progress.lastCompletedAt || ((priorSnapshot()[progressKey] as HomeworkProgress | undefined)?.cycle ?? Date.now());
        result[progressKey]={cycle:getHomeworkCycleStart(definition.resetRule,at),state:progress,
          expiresAt:row.expires_at ?? getHomeworkCycleEnd(definition.resetRule,at)};
      }
      result[key('homework',rid,row.item_id,'excluded')]=isExcluded===true;
      result[key('homework',rid,row.item_id,'position')]=row.position;
    }
  }
  for (const row of db.prepare('SELECT key,value FROM shared_settings').all() as {key:string;value:string}[]) {
    if (sharedSyncKeys.includes(row.key)) result[key('shared',row.key)]=portableSetting(row.key,JSON.parse(row.value));
  }
  const scopedRemote=profileId ? mappedRemoteId(db,profileId) : undefined;
  for (const {key:k} of db.prepare('SELECT key FROM profile_sync_tombstones').all() as {key:string}[]) {
    if (!(k in result) && (!profileId || parse(k)[1]===scopedRemote)) result[k]=true;
  }
  return result;
}

/** 원본과 같은 SQLite transaction에서 호출하며 실패 시 전송 대기도 함께 rollback한다.
 * 필드/기기별 최종 변경과 인과 vector로 압축하고 삭제 표식을 유지한다.
 * 주기 경과로 원본에 빈 진행이 저장되어도 새 변경을 전송하지 않는다. 수동 0회에는 수정 시각이 있다.
 * 재전송·구 PC·백업 복원을 전체 snapshot 덮어쓰기로 처리하지 않는다.
 * 회귀: check-profile-sync-model.ts. */
export function captureProfileSyncChanges(db:Database.Database,device:string,clock:ProfileClockStamp,automatic=false,profileId?:string):void {
  device=read(db,`writer:${device}`,device);
  const now=portableProfileSnapshot(db,profileId),remote=profileId ? mappedRemoteId(db,profileId) ?? SHARED_PARTITION : undefined;
  const before=readMaterialized(db,remote),stored=snapshotForStorage(now);
  const changed=[...new Set([...Object.keys(before),...Object.keys(stored)])].filter(k=>!isDeepStrictEqual(before[k],stored[k]));
  if (!changed.length) return;
  writeMaterialized(db,stored,remote);
  if (changed.some(k=>isProgressKey(parse(k)) && now[k]===undefined)) write(db,'homeworkProjectedAt',clock.utcMs);
  const outbound=changed.filter(k=>{
    if (!isProgressKey(parse(k))) {
      return !(parse(k)[0]==='tool' && now[k]===undefined && typeof before[k]==='string' && !isSyncableProfileToolValue(before[k]));
    }
    const current=now[k] as HomeworkProgress | undefined,previous=before[k] as HomeworkProgress | undefined;
    return !!current && (!previous || !isDeepStrictEqual(current.state,previous.state));
  });
  if (!outbound.length) return;
  const vector=read<SyncVector>(db,'vector',{}),sequence=(vector[device] || 0)+1;
  for (const k of outbound) {
    const parts=parse(k);
    let value=now[k] ?? null;
    if (parts[0]==='homework' && parts[3]==='deleted' && now[k]===undefined) value=true;
    const cell:SyncValue={device,sequence,context:fieldContext(db,k,device,sequence),
      ...progressCell(k,value,legacyMigrationClock(db,k,before,value,ruleClock(db,k,before[k],value,clock)))};
    recordSyncSource(db,k,cell);
    db.prepare('INSERT OR REPLACE INTO profile_sync_own VALUES(?,?)').run(k,text(cell));
    if (value===true && (parts[0]==='profile' && parts[2]==='deleted' || parts[0]==='homework' && parts[3]==='deleted')) db.prepare('INSERT OR IGNORE INTO profile_sync_tombstones VALUES(?)').run(k);
  }
  write(db,'vector',{...vector,[device]:sequence});
  write(db,'pendingSince',read<number | null>(db,'pendingSince',null) || Date.now());write(db,'lastChangeAt',Date.now());
  const category=automatic ? 'Automatic' : 'User';
  write(db,`pending${category}Since`,read<number | null>(db,`pending${category}Since`,null) || Date.now());
  write(db,`last${category}ChangeAt`,Date.now());write(db,'lastChangeAutomatic',automatic);
}

type SyncCellStatus='valid' | 'unknown' | 'invalid';
/** 셀 키와 값을 확인한다. 이 버전이 모르는 범위·설정·필드는 'unknown'으로 구분해 반영하지 않고 건너뛴다.
 * 새 버전 PC가 키 하나를 추가해도 구버전 PC가 그 PC의 파일 전체를 무시하지 않게 한다.
 * 아는 키의 잘못된 값과 구조가 손상된 키는 'invalid'로 거부한다. */
function syncCellStatus(k:string,value:unknown):SyncCellStatus {
  let p:string[];try {p=parse(k);} catch {return 'invalid';}
  if (!Array.isArray(p) || !p.length || p.some(v=>typeof v!=='string' || !v || v.length>200 || ['__proto__','prototype','constructor'].includes(v))) return 'invalid';
  const check=(valid:boolean):SyncCellStatus=>valid ? 'valid' : 'invalid';
  if (p[0]==='shared') return p.length===2 && sharedSyncKeys.includes(p[1]) ? check(validPortableSetting(p[1],value)) : 'unknown';
  if (!['setting','profile','tool','homework'].includes(p[0])) return 'unknown';
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(p[1] || '')) return 'invalid';
  if (p[0]==='setting') return p.length===3 && (PROFILE_SETTING_KEYS as readonly string[]).includes(p[2])
    ? check(value===null || (p[2]==='userServer' ? isProfileServer(value) : validPortableSetting(p[2],value))) : 'unknown';
  if (p[0]==='profile') {
    if (p.length!==3) return 'unknown';
    if (p[2]==='name') {try {assertProfileName(value);return 'valid';} catch {return check(value===null);}}
    if (p[2]==='created') return check(typeof value==='number' && Number.isSafeInteger(value) && value>=0);
    return p[2]==='deleted' ? check(typeof value==='boolean') : 'unknown';
  }
  if (p[0]==='tool') return p.length===3 && isProfileToolKey(p[2]) ? check(value===null || isSyncableProfileToolValue(value)) : 'unknown';
  if (p.length!==4) return 'unknown';
  if (!HOMEWORK_SYNC_FIELDS.includes(p[3])) return 'unknown';
  if (value===null) return 'valid';
  switch (p[3]) {
    case 'name':case 'category':case 'autoDescription':return check(typeof value==='string' && value.length<=4000);
    case 'autoType':return check(value==='semi');
    case 'deleted':case 'excluded':case 'isVisible':case 'isCustom':case 'auto':return check(typeof value==='boolean');
    case 'position':return check(Number.isSafeInteger(value) && Number(value)>=0 && Number(value)<100_000);
    case 'maxCount':return check(Number.isSafeInteger(value) && Number(value)>=1 && Number(value)<=1_000_000);
    case 'resetRule': {
      const v=value as Record<string,unknown>;
      return check(!!v && typeof v==='object' && Object.keys(v).every(k=>['type','hour','dayOfWeek'].includes(k)) && ['daily','weekly'].includes(String(v.type))
        && (v.hour===undefined || Number.isInteger(v.hour) && Number(v.hour)>=0 && Number(v.hour)<24)
        && (v.dayOfWeek===undefined || Number.isInteger(v.dayOfWeek) && Number(v.dayOfWeek)>=0 && Number(v.dayOfWeek)<=6));
    }
    case 'progress':default: {
      const v=value as Record<string,unknown>;
      return check(!!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===2 && Number.isSafeInteger(v.cycle)
        && !!v.state && typeof v.state==='object' && !Array.isArray(v.state) && Object.entries(v.state).every(([k,n])=>
        k==='isCompleted' ? typeof n==='boolean' : ['currentCount','lastCompletedAt'].includes(k) && typeof n==='number' && Number.isSafeInteger(n) && n>=0));
    }
  }
}
const HOMEWORK_SYNC_FIELDS=['name','category','autoDescription','autoType','deleted','excluded','isVisible','isCustom','auto','position','maxCount','resetRule','progress'];
const validSyncId=(s:unknown)=>typeof s==='string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(s) && !['__proto__','prototype','constructor'].includes(s);
/** 한 셀의 변경 정보(기기·순번·인과·시각)와 키·값을 확인한다. 수신 검증과 송신 보류가 같은 규칙을 쓴다. */
function validateSyncCell(k:string,c:SyncValue,device:string,sequence:number):SyncCellStatus {
  if (!c || typeof c!=='object' || c.device!==device || !Number.isSafeInteger(c.sequence) || c.sequence<1 || c.sequence>sequence || !c.context || typeof c.context!=='object' || Array.isArray(c.context) || Object.keys(c.context).length>1000
    || Object.entries(c.context).some(([d,n])=>!validSyncId(d) || !Number.isSafeInteger(n) || n<0 || d===c.device && n>=c.sequence)
    || !c.clock || !Number.isSafeInteger(c.clock.utcMs) || c.clock.utcMs<0 || !['internet','unverified'].includes(c.clock.source)
    || (c.clock.source==='internet' ? typeof c.clock.uncertaintyMs!=='number' || !Number.isFinite(c.clock.uncertaintyMs) || c.clock.uncertaintyMs<0 : c.clock.uncertaintyMs!==null)
    || Object.keys(c).some(f=>!['device','sequence','context','clock','value'].includes(f))) return 'invalid';
  const status=syncCellStatus(k,c.value);
  if (status==='invalid') return status;
  const parts=parse(k);
  if (c.clock.homeworkExpiresAt!==undefined && (!isProgressKey(parts) || !Number.isSafeInteger(c.clock.homeworkExpiresAt) || c.clock.homeworkExpiresAt<0)
    || c.clock.homeworkCutoffAt!==undefined && (!isRuleKey(parts) || !Number.isSafeInteger(c.clock.homeworkCutoffAt) || c.clock.homeworkCutoffAt<0)
    || c.clock.legacyMigration!==undefined && (c.clock.legacyMigration!==true || !isLegacyDeviceLocalSetting(parts))) return 'invalid';
  return status;
}
/** 다른 PC 파일의 형식 검증. 모르는 키는 허용하되(merge에서 건너뜀) 아는 키의 잘못된 값은 파일을 보류한다.
 * 회귀: check-profile-sync-model.ts / check-profile-sync-drive.ts. */
export function validateProfileSyncEnvelope(value:unknown):asserts value is ProfileSyncEnvelope {
  if (!value || typeof value!=='object' || Buffer.byteLength(text(value))>PROFILE_SYNC_POLICY.maxDecodedBytes) throw new Error('동기화 파일이 너무 크거나 올바르지 않습니다.');
  const v=value as ProfileSyncEnvelope;
  if (v.format!=='tw-overlay-profiles' || v.version!==1 || !validSyncId(v.device) || !Number.isSafeInteger(v.sequence) || v.sequence<0
    || !v.cells || Array.isArray(v.cells) || typeof v.cells!=='object' || Object.keys(v.cells).length>PROFILE_SYNC_POLICY.maxCells
    || Object.keys(v).some(k=>!['format','version','device','sequence','cells'].includes(k))) throw new Error('지원하지 않는 프로필 동기화 형식입니다.');
  for (const [k,c] of Object.entries(v.cells)) {
    if (validateSyncCell(k,c,v.device,v.sequence)==='invalid') throw new Error(`동기화 파일의 항목 또는 변경 정보가 올바르지 않습니다 (${k}).`);
  }
}

export class ProfileSyncModel {
  constructor(private readonly connection:Database.Database | (()=>Database.Database),private readonly physicalDevice:string,readonly clock:()=>ProfileClockStamp,
    private readonly settingsProfile?:()=>string | undefined,
    private readonly canReusePlaceholder:(id:string)=>boolean=()=>false) {
    this.bindLocalDevice();
  }
  /** 휴대용 DB의 데이터/인과 정보는 유지하되 전송 완료·파일 ID는 원래 PC의 상태다.
   * 다른 PC 복원은 원래 변경 시각을 승계한 새 writer로 대기를 재구성한다.
   * ApplicationData.reopen에서도 capture 전에 호출한다. 회귀: check-profile-sync-model.ts. */
  private bindLocalDevice():void {
    this.db.transaction(()=>{
      // 구버전이 허용한 큰 로컬 프리셋만 송수신 큐에서 격리한다. 원본 도구 값은 유지한다.
      for (const table of ['profile_sync_own','profile_sync_sources']) {
        const rows=this.db.prepare(`SELECT rowid,value FROM ${table} WHERE key LIKE '["tool",%' AND length(CAST(value AS BLOB))>?`)
          .all(MAX_PROFILE_TOOL_VALUE_LENGTH) as {rowid:number;value:string}[];
        const remove=this.db.prepare(`DELETE FROM ${table} WHERE rowid=?`);
        for (const row of rows) {
          const {value}=JSON.parse(row.value) as SyncValue;
          if (value!==null && !isSyncableProfileToolValue(value)) remove.run(row.rowid);
        }
      }
      const owner=this.meta('localDevice','');
      const restore=this.db.prepare("SELECT value FROM app_meta WHERE key='restore_generation'").get() as {value:string} | undefined;
      const restored=!!restore && restore.value!==this.meta('appliedRestoreGeneration','');
      const foreignOwn=!owner && (this.db.prepare('SELECT value FROM profile_sync_own').all() as {value:string}[])
        .some(row=>(JSON.parse(row.value) as SyncValue).device!==this.device);
      if (restored || owner && owner!==this.physicalDevice || foreignOwn) {
        const account=this.meta('boundAccount','') || this.meta('restoreAccountHint','') || this.meta('transportAccount','');
        const remove=this.db.prepare('DELETE FROM profile_sync_meta WHERE key=?');
        for (const k of ['cursor','files','damagedFiles','ownFile','ownPublished','boundAccount','transportAccount','stagedAccount','awaitingChoice',
          'localOnly','lastSuccess','acked','needsRebase','pendingSince','lastChangeAt','pendingUserSince','lastUserChangeAt',
          'pendingAutomaticSince','lastAutomaticChangeAt','lastChangeAutomatic','backupPath','backupAvailable','identityReviews',
          'lastCheckedAt','lastUploadedAt']) remove.run(k);
        if (account) this.setMeta('restoreAccountHint',account);
        this.rebaseOwn(true);
        if (restore) this.setMeta('appliedRestoreGeneration',restore.value);
      } else {
        // 구버전 앱은 송신 원본만 쓴다. 다시 열 때 파일로 아직 전송하지 않은 로컬 수정도 병합 원본에 되살린다.
        const own=this.db.prepare(`SELECT o.key,o.value FROM profile_sync_own o LEFT JOIN profile_sync_sources s
          ON s.key=o.key AND s.device=json_extract(o.value,'$.device')
          WHERE s.sequence IS NULL OR s.sequence<json_extract(o.value,'$.sequence')`).all() as {key:string;value:string}[];
        for (const row of own) recordSyncSource(this.db,row.key,JSON.parse(row.value));
      }
      this.setMeta('localDevice',this.physicalDevice);
    })();
  }
  oversizedToolCount():number {
    const values=this.db.prepare(`SELECT t.value FROM profile_tools t JOIN play_profiles p ON p.id=t.profile_id
      WHERE p.deleted_at IS NULL AND length(CAST(t.value AS BLOB))>?`).all(MAX_PROFILE_TOOL_VALUE_LENGTH) as {value:string}[];
    return values.filter(row=>!isSyncableProfileToolValue(row.value)).length;
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
  rebaseOwn(preserveLocal:boolean,isolateAccount=false):void {
    const before=preserveLocal ? this.values() : {},snapshot=preserveLocal ? portableProfileSnapshot(this.db) : {};
    const nextDevice=`${this.physicalDevice.slice(0,150)}:${randomUUID()}`;
    if (isolateAccount) {
      const live=new Set((this.db.prepare(`SELECT i.remote_id FROM profile_sync_ids i JOIN play_profiles p ON p.id=i.local_id
        WHERE p.deleted_at IS NULL`).all() as {remote_id:string}[]).map(row=>row.remote_id));
      for (const k of Object.keys(snapshot)) {
        const [scope,id,,field]=parse(k);
        if (scope!=='shared' && !live.has(id) || scope==='homework' && field==='deleted' && snapshot[k]===true) delete snapshot[k];
      }
      const archived=this.db.prepare('SELECT id FROM play_profiles WHERE deleted_at IS NOT NULL').all() as {id:string}[];
      const archivedByImport=new Set(this.meta<string[]>('excludedProfiles',[]));
      this.setMeta('foreignDeletedProfileIds',[...new Set([...this.meta<string[]>('foreignDeletedProfileIds',[]),
        ...archived.filter(profile=>!archivedByImport.has(profile.id)).map(profile=>profile.id)])]);
      this.db.exec('DELETE FROM profile_sync_cells;DELETE FROM profile_sync_sources;DELETE FROM profile_sync_progress_evidence;DELETE FROM profile_sync_tombstones;');
      const clear=this.db.prepare('DELETE FROM profile_sync_meta WHERE key=?');
      for (const k of ['identityReviews','pendingProfileDeletions','nextHomeworkProjectionAt','homeworkProjectedAt']) clear.run(k);
      this.setMeta('materialized',snapshotForStorage(snapshot));
      this.setMeta('vector',{});
    }
    this.setMeta(`writer:${this.physicalDevice}`,nextDevice);
    this.db.prepare('DELETE FROM profile_sync_own').run();this.setMeta('uploadSizing',null);this.setMeta('ownFile',null);this.setMeta('ownPublished',false);this.setMeta('acked',0);
    if (!preserveLocal) return;
    const vector=this.meta<SyncVector>('vector',{});
    for (const [k,value] of Object.entries(snapshot)) {
      const wire=progressCell(k,value,this.clock());
      const original=(before[k] || []).find(v=>isDeepStrictEqual(v.value,wire.value));
      // 자동 병합한 v3.2.2 설정 값은 어느 후보와도 같지 않다. 병합에 쓴 모든 후보를 덮는 문맥으로 다시 기록한다.
      const merged=!original && !isolateAccount && isDeepStrictEqual(selectLegacyDeviceLocalSetting(k,before[k] || [])?.value,wire.value)
        ? (before[k] || []).reduce<SyncVector>((all,head)=>({...all,...head.context,[head.device]:Math.max(all[head.device] || 0,head.sequence)}),{}) : undefined;
      const context=merged ?? (original && !isolateAccount ? {...original.context,[original.device]:original.sequence} : {});
      // 복원 시 전송 시각으로 과거 값의 우선순위를 바꾸지 않는다.
      const restoredClock:SyncValue['clock']=original?.clock || {utcMs:this.clock().utcMs,source:'unverified',uncertaintyMs:null};
      const cell:SyncValue={device:nextDevice,sequence:1,context,
        ...progressCell(k,value,merged ? {...restoredClock,legacyMigration:true} : restoredClock)};
      recordSyncSource(this.db,k,cell);
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
  /** JSON의 UTF-8 실제 크기를 계산하고, 일반 변경을 먼저 넣은 뒤 계산기 값을 넣는다. */
  planUpload(previous?:ProfileSyncEnvelope):{envelope:ProfileSyncEnvelope;sizing:UploadSizing;held:string[]} {
    const own=this.envelope();
    const prior=previous?.device===own.device ? previous.cells : {};
    // 검증을 통과하지 못한 이 PC의 셀은 원본 큐에 남기고 이번 파일에서만 뺀다. 한 값 때문에 전송 전체를 실패로
    // 반복하지 않으며, 이전에 올린 정상 값이 있으면 그대로 유지한다. 다른 PC의 수신 검증은 완화하지 않는다.
    // 회귀: check-profile-sync-model.ts (전송 보류 셀).
    const held=Object.keys(own.cells).filter(k=>validateSyncCell(k,own.cells[k],own.device,own.sequence)==='invalid').sort();
    const full=held.length ? {...own,cells:{...own.cells}} : own;
    for (const k of held) {
      delete full.cells[k];
      if (prior[k] && validateSyncCell(k,prior[k],own.device,own.sequence)!=='invalid') full.cells[k]=prior[k];
    }
    const heldSizing=held.length ? {heldCells:held.length,heldLabels:held.slice(0,5).map(k=>{
      const nameKey=key('profile',parse(k)[1],'name');
      return this.label(k,{[nameKey]:own.cells[nameKey]?.value});
    })} : {};
    const fullBytes=Buffer.byteLength(text(full));
    const retainsPublishedTool=(k:string)=> {
      const [scope,profile]=parse(k);
      return scope==='tool' && full.cells[key('profile',profile,'deleted')]?.value!==true;
    };
    const hasPublishedToolMissing=Object.keys(prior).some(k=>retainsPublishedTool(k) && !Object.hasOwn(full.cells,k));
    if (!hasPublishedToolMissing && fullBytes<=PROFILE_SYNC_POLICY.maxFileBytes && Object.keys(full.cells).length<=PROFILE_SYNC_POLICY.maxCells) {
      return {envelope:full,sizing:{fullBytes,uploadBytes:fullBytes,deferredTools:0,...heldSizing},held};
    }
    const entries=Object.entries(full.cells).filter(([k])=>{
      const [scope,profile,item,field]=parse(k);
      // Tombstones prevent resurrection even when obsolete payload fields are omitted.
      if (scope==='shared') return true;
      if (full.cells[key('profile',profile,'deleted')]?.value===true) return scope==='profile' && item==='deleted';
      return scope!=='homework' || field==='deleted' || full.cells[key('homework',profile,item,'deleted')]?.value!==true;
    });
    const isTool=([k]:[string,SyncValue])=>parse(k)[0]==='tool';
    const required=entries.filter(entry=>!isTool(entry) || entry[1].value===null);
    const tools=entries.filter(entry=>isTool(entry) && entry[1].value!==null);
    const envelope={...full,cells:Object.fromEntries(required)};
    // Reserve every published tool before attempting larger replacements. An explicit
    // tombstone in required takes precedence over the previously published value.
    for (const [k,cell] of Object.entries(prior)) {
      if (retainsPublishedTool(k) && !Object.hasOwn(envelope.cells,k)) envelope.cells[k]=cell;
    }
    let uploadBytes=Buffer.byteLength(text(envelope)),count=Object.keys(envelope.cells).length;
    const optionalBudget=Math.max(PROFILE_SYNC_POLICY.maxFileBytes,uploadBytes);
    const deferred:string[]=[];
    const add=(k:string,cell:SyncValue)=>{
      const existing=envelope.cells[k];
      const bytes=existing
        ? Buffer.byteLength(text(cell))-Buffer.byteLength(text(existing))
        : Buffer.byteLength(text(k))+1+Buffer.byteLength(text(cell))+(count ? 1 : 0);
      if (uploadBytes+bytes>optionalBudget || (!existing && count>=PROFILE_SYNC_POLICY.maxCells)) return false;
      envelope.cells[k]=cell;
      uploadBytes+=bytes;if (!existing) count++;
      return true;
    };
    // 먼저 이전 파일의 필드를 보존한다. 더 큰 새 값이 들어가지 않으면 그 필드의 이전 전송값을 유지한다.
    const published=tools.filter(([k])=>Object.hasOwn(prior,k));
    // Apply reductions first so capacity freed by one tool is available to the rest.
    const reductions=published.filter(([k,cell])=>Buffer.byteLength(text(cell))<=Buffer.byteLength(text(prior[k])));
    const reduced=new Set(reductions.map(([k])=>k));
    for (const [k,cell] of [...reductions,...published.filter(([k])=>!reduced.has(k)),
      ...tools.filter(([k])=>!Object.hasOwn(prior,k))]) {
      if (!add(k,cell)) deferred.push(k);
    }
    return {envelope,sizing:{fullBytes,uploadBytes,...this.describeDeferredTools(full,deferred),...heldSizing},held};
  }

  private describeDeferredTools(full:ProfileSyncEnvelope,keys:string[]):Pick<UploadSizing,'deferredTools'|'deferredLabels'> {
    const deferredLabels=keys.slice(0,5).map(k=>{
      const nameKey=key('profile',parse(k)[1],'name');
      return this.label(k,{[nameKey]:full.cells[nameKey]?.value});
    });
    return {deferredTools:keys.length,...(deferredLabels.length ? {deferredLabels} : {})};
  }

  /** 응답 유실 뒤 Drive에서 자기 파일을 다시 읽어도 실제 수신 확인한 도구만 완료로 본다. */
  acknowledgeEnvelope(envelope:ProfileSyncEnvelope,legacyBoundary?:number,sizing?:UploadSizing):void {
    if (envelope.sequence<this.meta('acked',0)) return;
    if (!sizing) {
      const full=this.envelope();
      const keys=Object.entries(full.cells).filter(([k,cell])=>parse(k)[0]==='tool'
        && cell.value!==null && cell.sequence<=envelope.sequence && cell.sequence!==(envelope.cells[k]?.sequence ?? -1)).map(([k])=>k);
      sizing={fullBytes:Buffer.byteLength(text(full)),uploadBytes:Buffer.byteLength(text(envelope)),...this.describeDeferredTools(full,keys)};
    }
    this.setMeta('uploadSizing',sizing);
    // 보류한 값은 원본 큐 및 상세 변경 이력에 보존한다. 새 저장이 있으면 다음 파일에 다시 포함할 수 있다.
    this.acknowledge(envelope.sequence,sizing.deferredTools ? undefined : legacyBoundary);
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
      const known=new Map((this.db.prepare(`SELECT s.key,s.value FROM profile_sync_sources s
        JOIN profile_sync_cells c ON c.key=s.key WHERE s.device=?`).all(envelope.device) as {key:string;value:string}[])
        .map(row=>[row.key,row.value]));
      for (const [k,c] of Object.entries(envelope.cells)) {
        // 새 버전이 추가한 키는 이 버전이 해석할 수 없으므로 보관·반영하지 않는다. 같은 파일의 나머지 셀은 반영한다.
        if (syncCellStatus(k,c.value)==='unknown') continue;
        // Drive files repeat the writer's full state. Keep the existing validation of
        // changed cells and still process older progress evidence and tombstones.
        if (known.get(k)!==text(c)) recordSyncSource(this.db,k,c);
        const parts=parse(k);
        if (c.value===true && (parts[0]==='profile' && parts[2]==='deleted' || parts[0]==='homework' && parts[3]==='deleted')) this.db.prepare('INSERT OR IGNORE INTO profile_sync_tombstones VALUES(?)').run(k);
      }
      vector[envelope.device]=Math.max(vector[envelope.device] || 0,envelope.sequence);this.setMeta('vector',vector);
    })();
  }
  values():Record<string,SyncValue[]> {return Object.fromEntries((this.db.prepare('SELECT key,heads FROM profile_sync_cells ORDER BY key').all() as {key:string;heads:string}[]).map(r=>[r.key,JSON.parse(r.heads)]));}
  private localProgressExpiry(profile:string,item:string):number | undefined {
    const row=this.db.prepare('SELECT expires_at FROM profile_homework_progress WHERE profile_id=? AND item_id=?').get(profile,item) as {expires_at:number | null} | undefined;
    return row?.expires_at ?? undefined;
  }
  private activeProgress(k:string,heads:SyncValue[],rule:ResetRule,now:number,cutoff:number):SyncValue[] {
    const ruleKey=key(...parse(k).slice(0,3),'resetRule');
    const rows=this.db.prepare('SELECT value FROM profile_sync_sources WHERE key=? UNION ALL SELECT value FROM profile_sync_progress_evidence WHERE key=?').all(k,k) as {value:string}[];
    const candidates=comparableValues(k,rows.length ? rows.map(row=>JSON.parse(row.value)) : heads);
    const definitions=candidates.some(cell=>cell.clock.homeworkExpiresAt===undefined)
      ? (this.db.prepare('SELECT value FROM profile_sync_sources WHERE key=?').all(ruleKey) as {value:string}[]).map(row=>JSON.parse(row.value) as SyncValue)
      : [];
    const projected=new Map<string,HomeworkProgress>();
    const active=candidates.filter(cell=>{
      const progress=cell.value as HomeworkProgress;
      const at=progress.state.lastCompletedAt || progress.cycle;
      const origin=definitions.find(v=>v.device===cell.device && v.sequence<=cell.sequence && v.value
        && getHomeworkCycleStart(v.value as ResetRule,at)===progress.cycle)?.value as ResetRule | undefined;
      const inferredDays=at-progress.cycle>=homeworkDayMs || (origin?.type ?? (getHomeworkCycleStart(rule,at)===progress.cycle ? rule.type : 'daily'))==='weekly' ? 7 : 1;
      const originalExpiry=cell.clock.homeworkExpiresAt ?? progress.cycle+inferredDays*homeworkDayMs;
      const expiresAt=Math.min(originalExpiry,getHomeworkCycleEnd(rule,at));
      if (at<cutoff || now>=expiresAt || at>=getHomeworkCycleEnd(rule,now)) return false;
      projected.set(id(cell),{...progress,cycle:getHomeworkCycleStart(rule,at),expiresAt});
      return true;
    });
    return causalHeads(active,k,true).map(cell=>({...cell,value:projected.get(id(cell))!}));
  }
  private view() {
    const snapshot={...this.meta<Snapshot>('materialized',{})};
    const values=this.values(),progress=new Map<string,SyncValue[]>(),ruleCutoffs=new Map<string,number>();
    const now=this.clock().utcMs;
    let nextProjectionAt=Infinity;
    for (const [k,heads] of Object.entries(values)) {
      const p=parse(k);
      if (isProgressKey(p)) continue;
      const deletion=(p[0]==='profile' && p[2]==='deleted' || p[0]==='homework' && p[3]==='deleted') && heads.some(v=>v.value===true);
      const selected=deletion ? {value:true} : isProfileCreatedKey(p) ? selectEarliestCreated(heads)
        : selectLegacyDeviceLocalSetting(k,heads) ?? selectSyncWinner(heads);
      if (selected) {
        snapshot[k]=selected.value;
        if (isRuleKey(p)) ruleCutoffs.set(k,Math.max(0,...heads.filter(head=>isDeepStrictEqual(head.value,selected.value)).map(head=>head.clock.homeworkCutoffAt ?? 0)));
      }
    }
    for (const {key:k} of this.db.prepare('SELECT key FROM profile_sync_tombstones').all() as {key:string}[]) snapshot[k]=true;
    for (const [k,heads] of Object.entries(values)) {
      const p=parse(k);
      if (!isProgressKey(p)) continue;
      const ruleKey=key(...p.slice(0,3),'resetRule'),rule=snapshot[ruleKey] as ResetRule | undefined;
      if (!rule) continue;
      nextProjectionAt=Math.min(nextProjectionAt,getHomeworkCycleEnd(rule,now));
      const max=Number(snapshot[key(...p.slice(0,3),'maxCount')]) || 1;
      const candidates=this.activeProgress(k,heads,rule,now,ruleCutoffs.get(ruleKey) ?? 0);
      for (const candidate of candidates) nextProjectionAt=Math.min(nextProjectionAt,(candidate.value as HomeworkProgress).expiresAt ?? Infinity);
      progress.set(k,candidates);
      const selected=selectSyncWinner(candidates,(a,b)=>isDeepStrictEqual(effectiveProgress(a.value as HomeworkProgress,max),effectiveProgress(b.value as HomeworkProgress,max)));
      if (selected || !candidates.length) snapshot[k]=selected?.value;
    }
    return {snapshot,values,progress,now,ruleCutoffs,nextProjectionAt:Number.isFinite(nextProjectionAt) ? nextProjectionAt : null};
  }
  private hasPendingDeletion(local:string | undefined):boolean {
    return !!local && !!this.db.prepare(`SELECT 1 FROM pending_profile_events e JOIN play_profiles p ON p.id=e.assigned_profile_id
      WHERE e.assigned_profile_id=? AND e.resolved_at IS NULL AND p.deleted_at IS NULL LIMIT 1`).get(local);
  }
  deferredDeletionReady():boolean {
    return this.meta<string[]>('pendingProfileDeletions',[]).some(local=>!this.hasPendingDeletion(local));
  }
  reviews(activeLocalId?:string,view=this.view(),protectSettings=true):ProfileSyncReview[] {
    const current=this.meta<Snapshot>('materialized',{}),result:ProfileSyncReview[]=[],{snapshot,values,progress}=view;
    const localIds=new Map((this.db.prepare('SELECT remote_id,local_id FROM profile_sync_ids').all() as {remote_id:string;local_id:string}[])
      .map(row=>[row.remote_id,row.local_id]));
    const protectedProfiles=new Set([...this.meta<string[]>('identityReviews',[]),...(activeLocalId ? [activeLocalId] : [])]);
    const settingsId=protectSettings ? this.settingsProfile?.() : undefined;
    const settingsDeletions=new Set(protectSettings ? this.meta<string[]>('settingsProfileDeletionReviews',[]) : []);
    if (settingsId) settingsDeletions.add(settingsId);
    for (const [k,heads] of Object.entries(values)) {
      const p=parse(k),isDeletion=p[0]==='profile' && p[2]==='deleted' || p[0]==='homework' && p[3]==='deleted';
      const candidates=progress.get(k) ?? heads;
      if (!candidates.length) continue;
      const progressKey=isProgressKey(p);
      const max=progressKey ? Number(snapshot[key(...p.slice(0,3),'maxCount')]) || 1 : 1;
      const selected=isDeletion && snapshot[k]===true ? candidates.find(h=>h.value===true)
        : progressKey ? selectSyncWinner(candidates,(a,b)=>isDeepStrictEqual(effectiveProgress(a.value as HomeworkProgress,max),effectiveProgress(b.value as HomeworkProgress,max)))
        : isProfileCreatedKey(p) ? selectEarliestCreated(candidates)
        : selectLegacyDeviceLocalSetting(k,candidates) ?? selectSyncWinner(candidates);
      if (snapshot[key('profile',p[1],'deleted')]===true && !(p[0]==='profile' && p[2]==='deleted')) continue;
      if (p[0]==='homework' && snapshot[key('homework',p[1],p[2],'deleted')]===true) continue;
      const local=p[0]==='shared' ? undefined : localIds.get(p[1]);
      const pendingDeletion=p[0]==='profile' && p[2]==='deleted' && snapshot[k]===true && this.hasPendingDeletion(local);
      const settingsDeletion=!!local && settingsDeletions.has(local) && p[0]==='profile' && p[2]==='deleted' && snapshot[k]===true;
      const protectedField=protectedProfiles.has(local || '') &&
        (p[0]==='profile' && ['name','deleted'].includes(p[2]) || p[0]==='setting' && p[2]==='userServer');
      if (pendingDeletion || !selected || (protectedField || settingsDeletion) && !isDeepStrictEqual(selected.value,current[k])) result.push({key:k,
        label:this.label(k,snapshot),current:current[k] ?? null,reason:pendingDeletion ? 'pending-records' : protectedField ? 'playing-profile' : settingsDeletion ? 'settings-profile' : 'conflict',
        candidates:candidates.filter(v=>!isDeletion || snapshot[k]!==true || v.value===true).map(v=>({id:id(v),device:v.device,changedAt:v.clock.utcMs,value:v.value}))});
    }
    return result;
  }
  /** 원격에서 활성으로 확인된 가져오기 보관 프로필만 원래 ID로 다시 사용한다. */
  prepareRemoteImport(envelopes:ProfileSyncEnvelope[]=[],activeRemoteIds:readonly string[]=[]):void {
    const incoming=new Set(envelopes.flatMap(e=>Object.keys(e.cells).map(parse).filter(p=>p[0]==='profile').map(p=>p[1])));
    const excluded=new Set(this.meta<string[]>('excludedProfiles',[]));
    const restore=this.db.prepare('UPDATE play_profiles SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL');
    for (const rid of activeRemoteIds) {
      const local=localSyncProfileId(this.db,rid);
      if (local && incoming.has(rid) && excluded.has(local) && restore.run(local).changes) excluded.delete(local);
    }
    const ids=(this.db.prepare("SELECT id FROM play_profiles WHERE name<>'' AND deleted_at IS NULL").all() as {id:string}[]).map(p=>p.id);
    // 가져오기로 교체한 프로필의 일지 귀속은 삭제된 이름으로 그대로 보존한다.
    const archived=ids.filter(id=>!incoming.has(remoteId(this.db,id)));
    for (const id of archived) this.db.prepare('UPDATE play_profiles SET deleted_at=? WHERE id=?').run(Date.now(),id);
    for (const id of ids.filter(id=>!archived.includes(id))) {
      this.cacheImportSounds(id);
      this.db.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(id);this.db.prepare('DELETE FROM profile_settings WHERE profile_id=?').run(id);
      const clearTool=this.db.prepare('DELETE FROM profile_tools WHERE profile_id=? AND key=?');
      for (const row of this.db.prepare('SELECT key,value FROM profile_tools WHERE profile_id=?').all(id) as {key:string;value:string}[]) {
        if (isSyncableProfileToolValue(row.value)) clearTool.run(id,row.key);
      }
    }
    this.setMeta('excludedProfiles',[...new Set([...excluded,...archived])]);
    this.db.prepare(`DELETE FROM shared_settings WHERE key IN (${sharedSyncKeys.map(()=>'?').join(',')})`).run(...sharedSyncKeys);
    this.db.prepare('DELETE FROM profile_sync_own').run();this.db.prepare('DELETE FROM profile_sync_cells').run();
    this.db.prepare('DELETE FROM profile_sync_sources').run();this.db.prepare('DELETE FROM profile_sync_progress_evidence').run();
    this.setMeta('materialized',{});this.setMeta('acked',0);
    this.setMeta('ownFile',null);this.setMeta('ownPublished',false);
  }
  private cacheImportSounds(local:string):void {
    const rows=this.db.prepare("SELECT key,value FROM profile_settings WHERE profile_id=? AND key IN ('customAlerts','fieldBossSettings')").all(local) as {key:string;value:string}[];
    if (rows.length) this.setMeta(`importSounds:${local}`,Object.fromEntries(rows.map(r=>[r.key,JSON.parse(r.value)])));
  }
  label(k:string,snapshot=this.view().snapshot):string {
    const p=parse(k),name=snapshot[key('profile',p[1],'name')] || '프로필';
    const fields:Record<string,string>={name:'이름',userServer:'서버',deleted:'삭제',progress:'숙제 진행',excluded:'숙제 참여 제외',position:'숙제 순서',pinnedNoteText:'메모',buffTimerWarnSeconds:'버프 경고 시점',
      lootKeywords:'득템 키워드',customAlerts:'사용자 지정 알림',buffTimerEnabled:'버프 감지',buffTimerBuffs:'감지할 버프',buffTimerAudioAlert:'버프 소리 알림',buffTimerVisualAlert:'버프 시각 알림',buffTimerCenterAlert:'버프 중앙 알림',
      xpAutoStart:'경험치 자동 시작',xpAutoPauseEnabled:'경험치 자동 일시정지',xpAutoPauseSeconds:'경험치 일시정지 대기',xpEfficiencyAlertEnabled:'경험치 효율 경고',xpEfficiencyDropPercent:'효율 하락 기준',xpEfficiencyMinAmount:'효율 경고 최소량',ignoreNegativeXp:'음수 경험치 제외',
      huntingExpDopings:'경험치 계산 도핑',huntingExpGrounds:'경험치 계산 사냥터',huntingExpSelectedGroundId:'선택한 사냥터',huntingExpKillsPerHour:'시간당 처치 수',huntingExpHappyHour:'해피아워',fieldBossNotifyEnabled:'필드보스 알림',fieldBossNotifyOffsets:'필드보스 사전 알림',fieldBossSettings:'필드보스별 알림',bossEntryCountdownBosses:'보스 입장 안내',
      abandonedEnabled:'어벤던로드 감지',abandonedAutoHideMinutes:'어벤던로드 자동 숨김',digsiteHudEnabled:'발굴지 안내',essenceAlertEnabled:'경험의 정수 알림',specialMonsterAlertEnabled:'특수 몬스터 알림',golgothaAlertEnabled:'골고다 알림',abandonedAlertEnabled:'어벤던로드 알림',pittaHillAlertEnabled:'필멸의 땅 알림',questCompleteAlertEnabled:'도전과제 완료 알림',abyssTreasureAlertEnabled:'심연의 보물창고 알림',waveMonsterWarningEnabled:'몬스터 웨이브 안내',ethosAlertEnabled:'에토스 알림',abyssApostleAlertEnabled:'심연의 사도 알림',lokagosAlertEnabled:'로카고스 알림',supplyHelperEnabled:'보급품 안내',
      tradeServer:'거래 검색 서버',tradeKeywords:'거래 검색 키워드',tradeNotify:'거래 알림',wordAlarmEnabled:'지정 단어 알림',wordAlarmKeywords:'지정 단어',wordAlarmHistoryEnabled:'지정 단어 이력',shoutKeywords:'외치기 키워드',galleryKeywords:'갤러리 키워드',galleryNotify:'갤러리 알림',nicknameNotes:'닉네임 메모',discordKeywords:'디스코드 키워드',discordRules:'디스코드 알림 조건',
      category:'숙제 분류',isVisible:'숙제 표시',isCustom:'사용자 지정 숙제',resetRule:'초기화 주기',maxCount:'목표 횟수',auto:'자동 감지',autoType:'감지 방식',autoDescription:'자동 감지 설명',
      buff_presets:'도핑 프리셋',buff_current_selection:'선택한 도핑',buff_active_preset_id:'선택한 도핑 프리셋','tw-coefficient-calculator-profiles-v1':'계수 계산 프리셋','tw-coefficient-calculator-profiles-v1_last':'선택한 계산 프리셋','tw-coefficient-calculator-settings-v7final':'계수 계산 입력'};
    return p[0]==='shared' ? `공통 설정 · ${fields[p[1]] || '알림 설정'}` : `${name} · ${p[0]==='homework' ? `${snapshot[key('homework',p[1],p[2],'name')] || '숙제'} · ` : ''}${fields[p.at(-1)!] || '프로필 설정'}`;
  }
  resolve(k:string,candidate:string):void {
    const view=this.view(),p=parse(k),heads=view.progress.get(k) ?? view.values[k];
    if (!heads?.length) throw new Error('변경 항목을 다시 확인해 주세요.');
    const current=this.meta<Snapshot>('materialized',{});
    let chosen=candidate==='local' ? current[k] ?? null : heads.find(v=>id(v)===candidate)?.value;
    if (chosen===undefined) throw new Error('선택한 값을 찾을 수 없습니다. 다시 확인해 주세요.');
    if (isProgressKey(p)) {
      const rule=view.snapshot[key(...p.slice(0,3),'resetRule')] as ResetRule | undefined;
      if (!rule) throw new Error('숙제 초기화 주기를 먼저 확인해 주세요.');
      const now=view.now,at=(chosen as HomeworkProgress | null)?.state.lastCompletedAt;
      const local=localSyncProfileId(this.db,p[1]),localExpiry=local ? this.localProgressExpiry(local,p[2]) : undefined;
      if (candidate==='local' && (!at || at<getHomeworkCycleStart(rule,now) || (localExpiry ?? Infinity)<=now)
        || !hasProgressEdit((chosen as HomeworkProgress | null)?.state)) {
        chosen={cycle:getHomeworkCycleStart(rule,now),state:{currentCount:0,isCompleted:false,lastCompletedAt:now},expiresAt:getHomeworkCycleEnd(rule,now)};
      } else if (candidate==='local' && localExpiry!==undefined) {
        chosen={...(chosen as HomeworkProgress),expiresAt:localExpiry};
      }
    }
    if ((p[0]==='profile' && p[2]==='deleted' || p[0]==='homework' && p[3]==='deleted') && heads.some(v=>v.value===true) && chosen!==true) throw new Error('삭제된 항목은 복구할 수 없습니다. 새 프로필/숙제로 복사해 주세요.');
    this.writeValue(k,chosen);
  }
  private writeValue(k:string,chosen:unknown,normalizing?:SyncValue):void {
    this.db.transaction(()=>{
      const vector=this.meta<SyncVector>('vector',{}),sequence=(vector[this.device] || 0)+1;
      const context=normalizing ? {...normalizing.context,[normalizing.device]:normalizing.sequence} : fieldContext(this.db,k,this.device,sequence);
      if (sequence>1) context[this.device]=sequence-1;
      else delete context[this.device];
      const clock=normalizing?.clock ?? ruleClock(this.db,k,this.meta<Snapshot>('materialized',{})[k],chosen,this.clock());
      const cell:SyncValue={device:this.device,sequence,context,...progressCell(k,chosen,clock)};
      recordSyncSource(this.db,k,cell);
      this.db.prepare('INSERT OR REPLACE INTO profile_sync_own VALUES(?,?)').run(k,text(cell));
      this.setMeta('vector',{...vector,[this.device]:sequence});this.setMeta('pendingSince',this.meta('pendingSince',Date.now()) || Date.now());this.setMeta('lastChangeAt',Date.now());
      const category=normalizing ? 'Automatic' : 'User';this.setMeta(`pending${category}Since`,this.meta(`pending${category}Since`,0) || Date.now());this.setMeta(`last${category}ChangeAt`,Date.now());
    })();
  }
  /** DB 원본만 반영한다. 화면/기록 재생/HUD는 호출자가 commit 후 갱신한다. */
  apply(activeLocalId?:string,acceptedKeys:readonly string[]=[],protectSettings=true,reusePlaceholder=true):void {
    this.db.transaction(()=>{
      const view=this.view(),selected=view.snapshot,reviews=this.reviews(activeLocalId,view,protectSettings);
      this.setMeta('identityReviews',[...new Set(reviews.filter(r=>r.reason==='playing-profile').map(r=>localSyncProfileId(this.db,parse(r.key)[1])).filter(Boolean))]);
      this.setMeta('pendingProfileDeletions',reviews.filter(r=>r.reason==='pending-records').map(r=>localSyncProfileId(this.db,parse(r.key)[1])));
      const blocked=new Set(reviews.filter(r=>r.reason==='pending-records' || !acceptedKeys.includes(r.key)).map(r=>r.key));
      const current=this.meta<Snapshot>('materialized',{});
      const next={...selected};for (const k of blocked) next[k]=current[k];
      const ids=new Set<string>();
      const profileFields=new Map<string,Array<[string[],unknown]>>();
      const sharedFields:Array<[string,unknown]>=[];
      for (const [k,value] of Object.entries(next)) {
        const parts=parse(k),[scope,rid]=parts;
        if (scope==='profile') ids.add(rid);
        else if (scope==='shared') sharedFields.push([rid,value]);
        else {
          const fields=profileFields.get(rid) ?? [];
          fields.push([parts,value]);profileFields.set(rid,fields);
        }
      }
      const blockedItems=new Set<string>();
      for (const k of blocked) {
        const [scope,rid,itemId]=parse(k);
        if (scope==='homework') blockedItems.add(key(rid,itemId));
      }
      const updateName=this.db.prepare('UPDATE play_profiles SET name=? WHERE id=? AND name IS NOT ?');
      const updateCreated=this.db.prepare('UPDATE play_profiles SET created_at=? WHERE id=? AND created_at IS NOT ?');
      const settings=this.db.prepare('SELECT key,value FROM profile_settings WHERE profile_id=?');
      const tools=this.db.prepare('SELECT key,value FROM profile_tools WHERE profile_id=?');
      const upsertSetting=this.db.prepare('INSERT OR REPLACE INTO profile_settings VALUES(?,?,?)');
      const upsertTool=this.db.prepare('INSERT OR REPLACE INTO profile_tools VALUES(?,?,?)');
      const removeSetting=this.db.prepare('DELETE FROM profile_settings WHERE profile_id=? AND key=?');
      const removeTool=this.db.prepare('DELETE FROM profile_tools WHERE profile_id=? AND key=?');
      const removeHomework=this.db.prepare('DELETE FROM profile_homework WHERE profile_id=? AND item_id=?');
      const upsertHomework=this.db.prepare(`INSERT INTO profile_homework VALUES(?,?,?,?,?) ON CONFLICT(profile_id,item_id) DO UPDATE
        SET definition=excluded.definition,state=excluded.state,position=excluded.position
        WHERE definition IS NOT excluded.definition OR state IS NOT excluded.state OR position IS NOT excluded.position`);
      const fieldValues=(statement:Database.Statement,local:string)=>new Map(
        (statement.all(local) as {key:string;value:string}[]).map(row=>[row.key,row.value]));
      const placeholders=reusePlaceholder ? (this.db.prepare(`SELECT p.id FROM play_profiles p
        WHERE p.deleted_at IS NULL AND p.name='' AND NOT EXISTS(SELECT 1 FROM profile_sync_ids m WHERE m.local_id=p.id)`)
        .all() as {id:string}[]).filter(({id})=>this.canReusePlaceholder(id)) : [];
      for (const rid of ids) {
        const name=next[key('profile',rid,'name')],server=next[key('setting',rid,'userServer')];
        const deleted=next[key('profile',rid,'deleted')]===true;
        let local=localSyncProfileId(this.db,rid);
        if (!local) {
          // 같은 v3.2.2 캐릭터에서 이전한 이 PC의 프로필을 이어 쓴다. 새로 만들면 같은 캐릭터가 둘이 된다.
          local=unmappedLegacyProfileForSyncId(this.db,rid);
          if (local) this.db.prepare('INSERT INTO profile_sync_ids VALUES(?,?)').run(local,rid);
        }
        if (!local) {
          if (typeof name!=='string' || !name.trim() || !isProfileServer(server)) continue;
          // 이름과 서버가 없는 초기 기본 프로필만 재사용한다. 기존 소유 ID는 교체하지 않는다.
          const blank=deleted ? undefined : placeholders.shift();
          local=blank?.id || rid;
          if (!blank) this.db.prepare('INSERT INTO play_profiles(id,name,created_at) VALUES(?,?,?)').run(local,name,Number(next[key('profile',rid,'created')]) || Date.now());
          else this.db.prepare('UPDATE play_profiles SET name=?,created_at=? WHERE id=?').run(name,Number(next[key('profile',rid,'created')]) || Date.now(),local);
          this.db.prepare('INSERT INTO profile_sync_ids VALUES(?,?)').run(local,rid);
          if (blank) {this.cacheImportSounds(local);this.db.prepare('DELETE FROM profile_settings WHERE profile_id=?').run(local);this.db.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(local);}
        }
        const p=this.db.prepare('SELECT deleted_at FROM play_profiles WHERE id=?').get(local) as {deleted_at:number | null};
        if (p.deleted_at!==null) continue;
        if (deleted) {this.db.prepare('UPDATE play_profiles SET deleted_at=? WHERE id=?').run(Date.now(),local);this.db.prepare('DELETE FROM profile_homework WHERE profile_id=?').run(local);continue;}
        if (typeof name==='string') updateName.run(name,local,name);
        const created=next[key('profile',rid,'created')];
        if (Number.isSafeInteger(created) && Number(created)>0) updateCreated.run(created,local,created);
        const savedSettings=fieldValues(settings,local),savedTools=fieldValues(tools,local);
        const importSounds=this.meta<Record<string,unknown>>(`importSounds:${local}`,{});
        const items=new Map<string,Record<string,unknown>>();
        for (const [parts,value] of profileFields.get(rid) ?? []) {
          if (parts[0]==='setting' || parts[0]==='tool') {
            const tool=parts[0]==='tool',field=parts[2];
            const previous=(tool ? savedTools : savedSettings).get(field);
            if (tool && previous!==undefined && !isSyncableProfileToolValue(previous)) continue;
            if (value===null || value===undefined) {
              if (previous!==undefined) (tool ? removeTool : removeSetting).run(local,field);
            }
            else {
              const encoded=tool ? value : text(withLocalSounds(field,value,previous===undefined ? importSounds[field] : JSON.parse(previous)));
              if (encoded!==previous) (tool ? upsertTool : upsertSetting).run(local,field,encoded);
            }
          }
          if (parts[0]==='homework') {const item=items.get(parts[2]) || {};item[parts[3]]=value;items.set(parts[2],item);}
        }
        for (const [itemId,item] of items) {
          if (item.deleted===true) {removeHomework.run(local,itemId);rememberDeletedHomework(this.db,local,itemId);continue;}
          const {progress,excluded,position,deleted:_deleted,...fields}=item;
          const definition={id:itemId,...Object.fromEntries(Object.entries(fields).filter(([,v])=>v!==null && v!==undefined))};
          if (!fields.name || !fields.resetRule) continue;
          const progressKey=key('homework',rid,itemId,'progress'),rule=fields.resetRule as ResetRule;
          const saved=progress as HomeworkProgress | undefined;
          const at=saved?.state.lastCompletedAt || saved?.cycle || 0;
          const expiresAt=saved ? Math.min(saved.expiresAt ?? this.localProgressExpiry(local,itemId) ?? Infinity,getHomeworkCycleEnd(rule,at)) : 0;
          const cutoff=view.ruleCutoffs.get(key('homework',rid,itemId,'resetRule')) ?? 0;
          const active=!!saved && at>=cutoff && expiresAt>view.now && at<getHomeworkCycleEnd(rule,view.now);
          let state:Record<string,unknown>={currentCount:0,isCompleted:false,isExcluded:excluded===true};
          if (active) {
            const max=Number(fields.maxCount) || 1,effective=effectiveProgress(saved,max);
            const source=view.progress.get(progressKey)?.find(cell=>cell.value===saved);
            const normalized={...saved.state,currentCount:effective.count,isCompleted:effective.completed};
            const unresolved=blockedItems.has(key(rid,itemId));
            if (!unresolved && source && saved.state.currentCount!==undefined && saved.state.currentCount>max) {
              this.writeValue(progressKey,{cycle:saved.cycle,state:normalized,expiresAt},source);
            }
            state={...normalized,isExcluded:excluded===true};
          }
          upsertHomework.run(local,itemId,text(definition),text(state),Number(position) || 0);
          if (active) saveHomeworkExpiry(this.db,local,itemId,saved.state.lastCompletedAt,expiresAt);
        }
        this.db.prepare('DELETE FROM profile_sync_meta WHERE key=?').run(`importSounds:${local}`);
      }
      const upsertShared=this.db.prepare(`INSERT INTO shared_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE
        SET value=excluded.value WHERE value IS NOT excluded.value`);
      const removeShared=this.db.prepare('DELETE FROM shared_settings WHERE key=?');
      for (const [field,value] of sharedFields) {
        if (value===null || value===undefined) removeShared.run(field);
        else upsertShared.run(field,text(value));
      }
      // 실제로 반영된 원본을 기준으로 삼아 미해결/삭제 후보를 새 로컬 편집으로 재전송하지 않는다.
      this.setMeta('materialized',snapshotForStorage(portableProfileSnapshot(this.db)));
      this.setMeta('homeworkProjectedAt',view.now);
      this.setMeta('nextHomeworkProjectionAt',view.nextProjectionAt);
      const remaining=this.reviews(activeLocalId,undefined,protectSettings);
      this.setMeta('identityReviews',[...new Set(remaining.filter(r=>r.reason==='playing-profile').map(r=>localSyncProfileId(this.db,parse(r.key)[1])).filter(Boolean))]);
      this.setMeta('settingsProfileDeletionReviews',remaining.filter(r=>r.reason==='settings-profile').map(r=>localSyncProfileId(this.db,parse(r.key)[1])).filter(Boolean));
    })();
  }
}
