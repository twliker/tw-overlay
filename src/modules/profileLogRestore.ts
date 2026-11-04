import {getProfileRuntime} from './profileRuntime';
import {normalizeChatLogSyncState,type ChatLogSyncLocalState} from './chatLogSyncState';
import type {DurableChatLogFileState} from './chatLogSyncProtocol';
import {log} from './logger';
import {GOLD_POUCH_DAILY_CONTENT} from './diaryDb';

/** 프로필 복원 위치는 로컬 DB에 분리한다. 기존 JSON은 fingerprint 확인/기존 미배정 구간의
 * 증거로만 사용하며 offset/집계를 새 프로필의 완료 상태로 복사하지 않는다. 한 원본의 이미
 * 귀속된 바이트 구간은 다른 프로필에 복제하지 않으며 이후 추가 구간은 새 선택으로 복원한다.
 * 기록·구간 귀속·확정 위치는 같은 DB transaction이다. 회귀: check-profile-log-restore.ts. */
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
  const excludedBySource=new Map<string,{start:number;end:number}[]>();
  const exclusions=(key:string,inspected:{fingerprint:string;fingerprintBytes:number;snapshotSize:number}) => {
    assertCurrent();
    const previous=legacy.files[key];
    if (previous && previous.fingerprint===inspected.fingerprint && previous.confirmedOffset<=inspected.snapshotSize) connection.transaction(()=>claim(inspected.fingerprint,0,previous.confirmedOffset,null))();
    const assigned=connection.prepare('SELECT start_offset AS start,end_offset AS end FROM profile_log_source_ranges WHERE fingerprint=? AND profile_id IS NOT ?').all(inspected.fingerprint,lease.profileId) as {start:number;end:number}[];
    const pending=connection.prepare("SELECT DISTINCT json_extract(payload,'$.source.start') AS start,json_extract(payload,'$.source.end') AS end FROM pending_profile_events WHERE resolved_at IS NULL AND json_extract(payload,'$.source.fingerprint')=?").all(inspected.fingerprint) as {start:number;end:number}[];
    const merged:{start:number;end:number}[]=[];
    for (const range of [...assigned,...pending].sort((a,b)=>a.start-b.start)) {
      const last=merged.at(-1);if (last && range.start<=last.end) last.end=Math.max(last.end,range.end);else merged.push({...range});
    }
    excludedBySource.set(inspected.fingerprint,merged);return merged;
  };
  const deductions=(date:string,fingerprint:string) => {
    assertCurrent();
    const row=connection.prepare('SELECT profile_id,value FROM profile_log_legacy_aggregates WHERE fingerprint=?').get(fingerprint) as {profile_id:string;value:string} | undefined;
    if (row) {
      if (row.profile_id!==lease.profileId && !connection.prepare('SELECT 1 FROM profile_log_source_ranges WHERE fingerprint=? LIMIT 1').get(fingerprint)) connection.prepare('UPDATE profile_log_legacy_aggregates SET profile_id=? WHERE fingerprint=?').run(lease.profileId,fingerprint);
      else if (row.profile_id!==lease.profileId) return;
      return JSON.parse(row.value) as NonNullable<import('./chatLogSyncProtocol').WorkerSyncTargetFile['legacyAggregateDeductions']>;
    }
    if (connection.prepare('SELECT 1 FROM profile_log_source_ranges WHERE fingerprint=? AND profile_id IS NULL LIMIT 1').get(fingerprint)
      || connection.prepare("SELECT 1 FROM profile_log_sync_state WHERE json_extract(state_json,'$.fingerprint')=? AND json_extract(state_json,'$.confirmedOffset')>0 LIMIT 1").get(fingerprint)) return;
    const value={stones:{} as Record<string,number>,elso:0,gold:0};
    // 원본 offset이 없는 구형 일 합계는 NULL 행을 유지한다. 첫 완전 분석의 합계에서만
    // 보존한 수량을 빼 새 프로필에 기존 합계가 복제되지 않게 한다. 이후 추가분은 정상 기록한다.
    const rows=connection.prepare("SELECT type,content,amount FROM activity_logs WHERE date=? AND profile_id IS NULL AND source='automatic'").all(date) as {type:string;content:string;amount:number}[];
    for (const item of rows) {
      if (item.type==='calc' && item.content===GOLD_POUCH_DAILY_CONTENT) value.gold+=Math.max(0,item.amount || 0);
      else if (item.type==='elso' && item.content==='엘소 포인트 획득') value.elso+=Math.max(0,item.amount || 0);
      else if (item.type==='loot') {const grade=item.content.match(/\[(최상급|상급|중급|하급) 마정석\]/)?.[1];if (grade) value.stones[grade]=(value.stones[grade] || 0)+Math.max(0,item.amount || 0);}
    }
    connection.prepare('INSERT INTO profile_log_legacy_aggregates VALUES(?,?,?)').run(fingerprint,lease.profileId,JSON.stringify(value));
    return value;
  };
  const save=(state:ChatLogSyncLocalState) => {
    assertCurrent();
    const write=connection.prepare('INSERT INTO profile_log_sync_state VALUES(?,?,?) ON CONFLICT(profile_id,file_key) DO UPDATE SET state_json=excluded.state_json');
    for (const [key,value] of Object.entries(state.files)) write.run(lease.profileId,key,JSON.stringify(value));
  };
  return {profileId:lease.profileId,sessionId:lease.sessionId,config:lease.config,load,probe,exclusions,deductions,save,assertCurrent,
    commit<T>(key:string,state:DurableChatLogFileState,start:number,apply:()=>T):T {
      assertCurrent();
      return store.withRecordContext(lease.profileId,lease.sessionId,()=>connection.transaction(()=>{
        const result=apply();
        let cursor=start;
        for (const range of excludedBySource.get(state.fingerprint) || []) {
          if (range.start>cursor) claim(state.fingerprint,cursor,Math.min(range.start,state.confirmedOffset),lease.profileId);
          cursor=Math.max(cursor,range.end);if (cursor>=state.confirmedOffset) break;
        }
        if (cursor<state.confirmedOffset) claim(state.fingerprint,cursor,state.confirmedOffset,lease.profileId);
        connection.prepare('INSERT INTO profile_log_sources VALUES(?,?) ON CONFLICT(file_key) DO UPDATE SET state_json=excluded.state_json').run(key,JSON.stringify(state));
        save({...legacy,files:{[key]:state}});return result;
      })());
    },
    withRecords<T>(apply:()=>T):T {assertCurrent();return store.withRecordContext(lease.profileId,lease.sessionId,()=>connection.transaction(apply)());},
    catchUp<T extends {startOffset:number;completedOffset:number}>(fingerprint:string | undefined,apply:()=>T):T {
      assertCurrent();
      return connection.transaction(()=>{
        const result=apply(),status=runtime.service.status();
        // 실시간 이어받기의 대기 원본과 처리한 완전한 구간도 함께 보존한다. 다음 복원에서
        // 다른 프로필에 같은 추가분이 복제되지 않게 하며 새 미선택 세션은 배정하지 않는다.
        if (fingerprint && lease.sessionId && status.sessionId===lease.sessionId && !status.selectionRequired) claim(fingerprint,result.startOffset,result.completedOffset,lease.profileId);
        return result;
      })();
    },
    finish():string | undefined {
      let valid=true;try {assertCurrent();} catch {valid=false;}
      try {return lease.finish(runtime.replay,valid);} catch (error) {log(`[PROFILE] 복원 종료 후 대기 재생 실패: ${String(error)}`);return '복원 중 감지한 자동 기록은 대기열에 보존했습니다.';}
    },
  };
}
