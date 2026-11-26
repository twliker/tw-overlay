import {getProfileRuntime} from './profileRuntime';
import {normalizeChatLogSyncState,type ChatLogSyncLocalState} from './chatLogSyncState';
import type {DurableChatLogFileState} from './chatLogSyncProtocol';
import {log} from './logger';

/** 프로필 복원 위치는 로컬 DB에 분리한다. 기존 JSON은 fingerprint 확인/기존 미배정 구간의
 * 증거로만 사용하며 offset/집계를 새 프로필의 완료 상태로 복사하지 않는다. 한 원본의 이미
 * 귀속된 이전 구간과 새 줄 키는 다른 프로필에 복제하지 않으며 추가 구간은 새 선택으로 복원한다.
 * 활동 기록·줄 귀속·확정 위치는 같은 DB transaction이다. 회귀: check-profile-log-restore.ts. */
export function beginProfileLogRestore(expectedId:unknown) {
  const runtime=getProfileRuntime();
  if (!runtime) {if (expectedId!==undefined) throw new Error('프로필 기능을 준비하고 있습니다.');return null;}
  const store=runtime.service.store,connection=store.database;
  let legacy:ChatLogSyncLocalState;
  try {
    const legacyRow=connection.prepare("SELECT value FROM app_meta WHERE key='legacy_chat_log_sync_state'").get() as {value:string};
    const value=JSON.parse(legacyRow.value);legacy=normalizeChatLogSyncState(value);
    if (value.schemaVersion!==legacy.schemaVersion || !value.files || typeof value.files!=='object' || Array.isArray(value.files) || Object.keys(value.files).length!==Object.keys(legacy.files).length) throw new Error('invalid legacy evidence');
  } catch {throw new Error('보존한 이전 로그 복원 정보가 올바르지 않아 복원하지 않았습니다. 백업과 저장소를 확인해 주세요.');}
  const lease=runtime.service.beginHistoricalRestore(expectedId);
  const assertCurrent=() => {
    if (getProfileRuntime()!==runtime || !connection.open || store.database!==connection || runtime.service.status().activeProfileId!==lease.profileId) throw new Error('복원 대상 저장소가 바뀌어 복원을 중단했습니다. 다시 확인해 주세요.');
  };
  const decode=(value:string | undefined):DurableChatLogFileState | undefined => {
    if (value===undefined) return;
    try {const result=Object.values(normalizeChatLogSyncState({...legacy,files:{value:JSON.parse(value)}}).files)[0];if (result) return result;} catch { /* 아래 오류로 기존 기록을 보존 */ }
    throw new Error('저장된 로그 복원 진행 정보가 올바르지 않아 복원하지 않았습니다. 백업과 저장소를 확인해 주세요.');
  };
  const load=():ChatLogSyncLocalState => {
    assertCurrent();
    return normalizeChatLogSyncState({...legacy,files:Object.fromEntries((connection.prepare('SELECT file_key,state_json FROM profile_log_sync_state WHERE profile_id=?').all(lease.profileId) as {file_key:string;state_json:string}[])
      .flatMap(row=>{const value=decode(row.state_json);return value ? [[row.file_key,value]] : [];}))});
  };
  const probe=(key:string):DurableChatLogFileState | undefined => {
    assertCurrent();
    const row=connection.prepare('SELECT state_json FROM profile_log_sources WHERE file_key=?').get(key) as {state_json:string} | undefined;
    return decode(row?.state_json) || legacy.files[key];
  };
  const claim=(fingerprint:string,start:number,end:number,owner:string | null) => {
    let cursor=start;
    const rows=connection.prepare('SELECT start_offset AS start,end_offset AS end FROM profile_log_source_ranges WHERE fingerprint=? AND end_offset>? AND start_offset<? ORDER BY start_offset').all(fingerprint,start,end) as {start:number;end:number}[];
    const insert=connection.prepare('INSERT INTO profile_log_source_ranges VALUES(?,?,?,?)');
    for (const row of rows) {if (row.start>cursor) insert.run(fingerprint,cursor,Math.min(row.start,end),owner);cursor=Math.max(cursor,row.end);}
    if (cursor<end) insert.run(fingerprint,cursor,end,owner);
  };
  const exclusions=(key:string,inspected:{fingerprint:string;fingerprintBytes:number;snapshotSize:number},filePath?:string,dateStr?:string) => {
    assertCurrent();
    // 다른 폴더의 복사본도 같은 원본 파일(내용 키)로 연결해 처리 구간·일지 원본 위치를 그대로 쓴다.
    if (filePath && dateStr) connection.transaction(()=>{
      store.registerLogFile(inspected.fingerprint,filePath,dateStr,false);
      store.validateLogRanges(inspected.fingerprint,filePath);
    })();
    const previous=legacy.files[key];
    if (previous && previous.fingerprint===inspected.fingerprint && previous.confirmedOffset<=inspected.snapshotSize) connection.transaction(()=>claim(inspected.fingerprint,0,previous.confirmedOffset,null))();
    const assigned=connection.prepare('SELECT start_offset AS start,end_offset AS end FROM profile_log_source_ranges WHERE fingerprint=? AND profile_id IS NOT ?').all(inspected.fingerprint,lease.profileId) as {start:number;end:number}[];
    const pending=connection.prepare("SELECT DISTINCT json_extract(payload,'$.source.start') AS start,json_extract(payload,'$.source.end') AS end FROM pending_profile_events WHERE resolved_at IS NULL AND json_extract(payload,'$.source.fingerprint')=?").all(inspected.fingerprint) as {start:number;end:number}[];
    const ignored=connection.prepare('SELECT start_offset AS start,end_offset AS end FROM profile_ignored_log_ranges WHERE fingerprint=?')
      .all(inspected.fingerprint) as {start:number;end:number}[];
    // 다른 프로필이 실시간으로 바로 반영한 구간(대기·줄 귀속 행 없음)도 그 프로필의 것이다.
    const otherLive=store.appliedRanges({fingerprint:inspected.fingerprint,notProfileId:lease.profileId}).map(({start,end})=>({start,end}));
    const merged:{start:number;end:number}[]=[];
    for (const range of [...assigned,...pending,...ignored,...otherLive].sort((a,b)=>a.start-b.start)) {
      const last=merged.at(-1);if (last && range.start<=last.end) last.end=Math.max(last.end,range.end);else merged.push({...range});
    }
    return merged;
  };
  const knownLines=(date:string):Record<string,string | null> => {
    assertCurrent();
    const rows=connection.prepare('SELECT lower(hex(line_key)) AS line_key,profile_id FROM profile_log_line_owners WHERE log_date=?').all(date) as {line_key:string;profile_id:string | null}[];
    const pending=connection.prepare(`SELECT DISTINCT json_extract(payload,'$.source.lineKey') AS line_key
      FROM pending_profile_events WHERE resolved_at IS NULL AND json_extract(payload,'$.data.date')=?
      AND json_type(payload,'$.source.lineKey')='text'`).all(date) as {line_key:string}[];
    return Object.fromEntries([...pending.map(row=>[row.line_key,null] as const),...rows.map(row=>[row.line_key,row.profile_id] as const)]);
  };
  const appliedRanges=(fingerprint:string) => {
    assertCurrent();
    return store.appliedRanges({fingerprint,profileId:lease.profileId}).map(({start,end})=>({start,end}));
  };
  const legacyOwnedRanges=(fingerprint:string) => connection.prepare('SELECT start_offset AS start,end_offset AS end FROM profile_log_source_ranges WHERE fingerprint=? AND profile_id IS ? ORDER BY start_offset').all(fingerprint,lease.profileId) as {start:number;end:number}[];
  const save=(state:ChatLogSyncLocalState) => {
    assertCurrent();
    const write=connection.prepare('INSERT INTO profile_log_sync_state VALUES(?,?,?) ON CONFLICT(profile_id,file_key) DO UPDATE SET state_json=excluded.state_json');
    for (const [key,value] of Object.entries(state.files)) write.run(lease.profileId,key,JSON.stringify(value));
  };
  return {profileId:lease.profileId,sessionId:lease.sessionId,config:lease.config,load,probe,exclusions,knownLines,appliedRanges,legacyOwnedRanges,save,assertCurrent,
    commit<T>(key:string,state:DurableChatLogFileState,lineKeys:string[],apply:()=>T,ownedSpans?:ReadonlyArray<{start:number;end:number}>):T {
      assertCurrent();
      // 복원 구간은 반영 구간(log_ranges)만 남기고 HUD 복원 구간(profile_runtime_ranges)에는 넣지 않는다(HUD에 재생하지 않는 줄).
      return store.withRecordContext(lease.profileId,lease.sessionId,()=>connection.transaction(()=>{
        const result=apply();
        // 줄 귀속(줄 키 = 원문·위치 해시)은 복원에서 계속 남긴다. 같은 날짜 파일을 일부만 같은 내용으로 다시 쓴 경우에도
        // 그대로 남은 줄의 소유를 줄 단위로 지키기 위해서다(위치만 보는 처리 구간은 바뀐 구간을 통째로 지운다).
        const insert=connection.prepare('INSERT OR IGNORE INTO profile_log_line_owners VALUES(?,?,?,0)');
        for (const lineKey of lineKeys) insert.run(Buffer.from(lineKey,'hex'),state.dateStr,lease.profileId);
        // 처리 구간(log_ranges applied)도 남겨 실시간 재읽기·다른 프로필 복원이 같은 기준으로 본다.
        for (const span of ownedSpans ?? []) store.extendAppliedRange(lease.profileId,state.fingerprint,state.dateStr,span.start,span.end,state.filePath);
        connection.prepare('INSERT INTO profile_log_sources VALUES(?,?) ON CONFLICT(file_key) DO UPDATE SET state_json=excluded.state_json').run(key,JSON.stringify(state));
        save({...legacy,files:{[key]:state}});return result;
      })());
    },
    withRecords<T>(apply:()=>T):T {assertCurrent();return store.withRecordContext(lease.profileId,lease.sessionId,()=>connection.transaction(apply)());},
    catchUp<T>(apply:()=>T):T {
      assertCurrent();
      return connection.transaction(apply)();
    },
    finish():string | undefined {
      let valid=true;try {assertCurrent();} catch {valid=false;}
      try {return lease.finish(runtime.replay,valid);} catch (error) {log(`[PROFILE] 복원 종료 후 대기 재생 실패: ${String(error)}`);return '복원 중 감지한 자동 기록은 대기열에 보존했습니다.';}
    },
  };
}
