import type Database = require('better-sqlite3');
import {getProfileRuntime} from './profileRuntime';
import {createDurableFileState,getChatLogSyncStateKey,inspectChatLogFile,normalizeChatLogSyncState} from './chatLogSyncState';

export interface ProfileLogSource {fingerprint:string;start:number;end:number}
let current:ProfileLogSource | undefined;
let sequence=0;

/** 실시간 파서의 원본 byte 위치를 대기 이벤트/ACK와 함께 보관한다. 선택 전 원본은
 * 배정 전까지 과거 복원에서 제외하고, 배정 후에는 원래 프로필의 구간으로 유지한다.
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

export function withProfileLogSource<T>(source:ProfileLogSource | undefined,work:()=>T):T {
  const before=current,priorSequence=sequence;current=source;sequence=0;
  try {return work();} finally {current=before;sequence=priorSequence;}
}
export function nextProfileLogSource(event:string):{source?:ProfileLogSource;eventId?:string} {
  return current ? {source:{...current},eventId:`live:${current.fingerprint}:${current.start}:${event}:${sequence++}`} : {};
}

export function claimProfileLogRange(db:Database.Database,source:ProfileLogSource,profileId:string | null):boolean {
  if (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start<0 || source.end<source.start) throw new Error('로그 원본 위치가 올바르지 않습니다.');
  const rows=db.prepare('SELECT start_offset AS start,end_offset AS end,profile_id AS owner FROM profile_log_source_ranges WHERE fingerprint=? AND end_offset>? AND start_offset<? ORDER BY start_offset').all(source.fingerprint,source.start,source.end) as {start:number;end:number;owner:string | null}[];
  if (rows.some(row=>row.owner!==profileId)) return false;
  let cursor=source.start;
  const write=db.prepare('INSERT INTO profile_log_source_ranges VALUES(?,?,?,?)');
  for (const row of rows) {if (row.start>cursor) write.run(source.fingerprint,cursor,Math.min(row.start,source.end),profileId);cursor=Math.max(cursor,row.end);}
  if (cursor<source.end) write.run(source.fingerprint,cursor,source.end,profileId);
  return true;
}
