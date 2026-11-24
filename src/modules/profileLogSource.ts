import type Database = require('better-sqlite3');
import {getProfileRuntime} from './profileRuntime';
import {createChatLogLineKey} from './chatLogSyncProtocol';
import {createDurableFileState,getChatLogSyncStateKey,inspectChatLogFile,normalizeChatLogSyncState} from './chatLogSyncState';

export interface ProfileLogSource {fingerprint:string;start:number;end:number;lineKey?:string;unassigned?:boolean}
let current:ProfileLogSource | undefined;
let currentLine:string | undefined;
let sequence=0;
let eventOccurrences=new Map<string,number>();
const publishedLines=new Set<string>();

/** 기록 없이 화면·소리만 내는 효과(보상 채팅, 기믹·출현 알림)는 같은 원본 줄에서 종류별로
 * 한 번만 발행한다. 실시간 파일 재읽기·tail 재시도에서 같은 줄을 다시 파싱해도 반복하지 않으며,
 * 원본 위치가 다른 동일 메시지는 별개 줄로 허용한다. 원본 위치가 없는 호출(프로필 기능 이전 경로,
 * 직접 emit)은 호출자의 최신성 검사에 맡긴다. 회귀: check-profile-recording.ts. */
export function claimProfileLogPublication(kind:string,date:string,timestamp:string):boolean {
  if (!current || currentLine===undefined) return true;
  const lineKey=current.lineKey ??=createChatLogLineKey(date,timestamp,currentLine,current.start);
  const key=`${kind}\0${lineKey}`;
  if (publishedLines.has(key)) return false;
  if (publishedLines.size>=1024) publishedLines.delete(publishedLines.values().next().value!);
  publishedLines.add(key);
  return true;
}

/** 재파싱 중 이미 표시한 보상 채팅을 다시 발행하지 않는다. */
export function shouldPublishProfileLogReward(date:string,timestamp:string):boolean {
  return claimProfileLogPublication('reward',date,timestamp);
}

/** 실시간 파서의 원본 byte 위치를 대기 이벤트/ACK와 함께 보관한다. 선택 전 원본은
 * 배정 전까지 과거 복원에서 제외하고, 배정 후에는 원래 프로필의 구간으로 유지한다.
 * 파일 경로가 달라도 날짜·시각·원문·시작 byte가 같은 줄은 기존 귀속을 유지한다.
 * 순수 채팅은 저장하지 않는다. 회귀: check-profile-lifecycle.ts, check-profile-log-restore.ts. */
export function prepareProfileLogSource(filePath:string,date:string):string | undefined {
  const namedDate=filePath.match(/TWChatLog_(\d{4})_(\d{2})_(\d{2})\.html$/i);
  if (namedDate) date=namedDate.slice(1).join('-');
  const runtime=getProfileRuntime();if (!runtime) return;
  const db=runtime.service.store.database,key=getChatLogSyncStateKey(filePath);
  const row=db.prepare('SELECT state_json FROM profile_log_sources WHERE file_key=?').get(key) as {state_json:string} | undefined;
  const legacy=JSON.parse((db.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get() as {value:string}).value);
  const previous=row ? normalizeChatLogSyncState({...legacy,files:{[key]:JSON.parse(row.state_json)}}).files[key] : legacy.files[key];
  if (row && !previous) throw new Error('저장된 원본 로그 정보를 확인하지 못했습니다.');
  const info=inspectChatLogFile(filePath,date,previous);
  if (!info.snapshotSize) return;
  const value=createDurableFileState(filePath,filePath,date,info.fingerprint,'live',info.fingerprintBytes,info.snapshotSize);
  db.prepare('INSERT INTO profile_log_sources VALUES(?,?) ON CONFLICT(file_key) DO UPDATE SET state_json=excluded.state_json').run(key,JSON.stringify(value));
  return info.fingerprint;
}

export function withProfileLogSource<T>(source:ProfileLogSource | undefined,work:()=>T,line?:string):T {
  const before=current,priorLine=currentLine,priorSequence=sequence,priorOccurrences=eventOccurrences;
  current=source;currentLine=line;sequence=0;eventOccurrences=new Map();
  try {return work();} finally {current=before;currentLine=priorLine;sequence=priorSequence;eventOccurrences=priorOccurrences;}
}

export function nextProfileLogSource(event:string,date:string,timestamp:string):{source?:ProfileLogSource;eventId?:string;legacyId?:string} {
  if (!current) return {};
  if (currentLine!==undefined && !current.lineKey) current.lineKey=createChatLogLineKey(date,timestamp,currentLine,current.start);
  const legacyId=`live:${current.fingerprint}:${current.start}:${event}:${sequence++}`;
  // 각 파서 이벤트마다 순번을 따로 세므로 관련 없는 이벤트 구성이 달라져도 ACK를 재사용한다.
  const occurrence=eventOccurrences.get(event) ?? 0;
  eventOccurrences.set(event,occurrence+1);
  return {source:{...current},eventId:current.lineKey ? `live-line:${current.lineKey}:${event}:${occurrence}` : legacyId,legacyId};
}

/** persist=false(일지·숙제에 남지 않는 줄)는 기존 귀속만 확인하고 새 귀속 행을 만들지 않는다. */
export function claimProfileLogLine(db:Database.Database,key:string,date:string,profileId:string | null,persist=true):boolean {
  const digest=Buffer.from(key,'hex');
  const owner=db.prepare('SELECT profile_id,live FROM profile_log_line_owners WHERE line_key=?').get(digest) as {profile_id:string | null;live:number} | undefined;
  if (owner) return owner.live===1 && owner.profile_id===profileId;
  if (persist) db.prepare('INSERT INTO profile_log_line_owners VALUES(?,?,?,1)').run(digest,date,profileId);
  return true;
}

/**
 * 기능 계약 — 원본 줄 귀속·완료 영수증의 보관 범위.
 * profile_log_line_owners와 profile_event_receipts는 같은 원본 줄이 실시간 재파싱(영수증)이나 과거 로그
 * 복원(knownLines의 줄 귀속)에서 다시 기록되지 않게 하는 증거다. 일지·숙제에 아무것도 남기지 않는 줄
 * (경험의 정수 교환이 아닌 경험치, 다른 사람의 획득, HUD 진행만 쓰는 이벤트)은 복원이 다시 읽어도 기록이
 * 생기지 않으므로 줄 귀속을 만들지 않고, 30일 대기 원문 압축 때 영수증도 남기지 않는다. 판단은 파서 이벤트를
 * 아는 profileParserEvents가 등록하며, 등록 전이거나 판단할 수 없으면 항상 보존한다(중복 방지 우선).
 * 회귀: check-profile-storage.ts, check-profile-log-restore.ts.
 */
type ProfileEventDurability=(event:string,data:unknown)=>boolean | undefined;
/** 순환 import 중(profileRuntime ↔ profileParserEvents) 등록돼도 TDZ가 없도록 호이스팅된 함수에 보관한다. */
function durabilityState():{policy?:ProfileEventDurability} {
  const holder=durabilityState as typeof durabilityState & {state?:{policy?:ProfileEventDurability}};
  return holder.state ??= {};
}
export function setProfileEventDurability(policy:ProfileEventDurability | undefined):void {durabilityState().policy=policy;}
/** 이벤트 이름만으로 판단한다(데이터가 필요한 이벤트는 undefined). 영수증 정리 backfill이 쓴다. */
export function profileEventDurabilityByName(event:string):boolean | undefined {return durabilityState().policy?.(event,undefined);}
export function hasProfileEventDurability():boolean {return !!durabilityState().policy;}
export function isDurableProfileEvent(payload:unknown):boolean {
  const value=payload as {kind?:unknown;event?:unknown;data?:unknown} | null;
  if (!value || typeof value!=='object' || value.kind!=='parsed-profile-event' || typeof value.event!=='string') return true;
  return durabilityState().policy?.(value.event,value.data) ?? true;
}

/** 명시적으로 무시한 줄은 어느 프로필의 복원으로도 기록되지 않는다. 기존 귀속은 보존한다. */
export function excludeIgnoredProfileLog(db:Database.Database,date:string,source:ProfileLogSource):void {
  if (source.lineKey && /^[a-f0-9]{64}$/.test(source.lineKey) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    db.prepare('INSERT OR IGNORE INTO profile_log_line_owners VALUES(?,?,NULL,0)').run(Buffer.from(source.lineKey,'hex'),date);
  }
  if (typeof source.fingerprint==='string' && source.fingerprint && Number.isSafeInteger(source.start)
    && Number.isSafeInteger(source.end) && source.start>=0 && source.end>source.start) {
    db.prepare('INSERT OR IGNORE INTO profile_ignored_log_ranges VALUES(?,?,?)').run(source.fingerprint,source.start,source.end);
    fillProfileLogRange(db,source,null,true);
  }
}

export function claimProfileLogRange(db:Database.Database,source:ProfileLogSource,profileId:string | null):boolean {
  return fillProfileLogRange(db,source,profileId,false);
}

function fillProfileLogRange(db:Database.Database,source:ProfileLogSource,profileId:string | null,keepExisting:boolean):boolean {
  if (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start<0 || source.end<source.start) throw new Error('로그 원본 위치가 올바르지 않습니다.');
  const rows=db.prepare('SELECT start_offset AS start,end_offset AS end,profile_id AS owner FROM profile_log_source_ranges WHERE fingerprint=? AND end_offset>? AND start_offset<? ORDER BY start_offset').all(source.fingerprint,source.start,source.end) as {start:number;end:number;owner:string | null}[];
  if (!keepExisting && rows.some(row=>row.owner!==profileId)) return false;
  let cursor=source.start;
  const write=db.prepare('INSERT INTO profile_log_source_ranges VALUES(?,?,?,?)');
  for (const row of rows) {if (row.start>cursor) write.run(source.fingerprint,cursor,Math.min(row.start,source.end),profileId);cursor=Math.max(cursor,row.end);}
  if (cursor<source.end) write.run(source.fingerprint,cursor,source.end,profileId);
  return true;
}
