import type {ApplicationData} from './applicationData';
import type {PlayProfileStatus,ProfilePendingSessionDetails} from '../shared/playProfiles';
import {readLegacyPendingHomework} from '../shared/legacyHomework';

const record=(value:unknown):Record<string,unknown>=>value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const excerpt=(value:string)=>value.length>180 ? `${value.slice(0,179)}…` : value;
function category(kind:unknown,event:unknown):string {
  if(kind==='legacy-homework')return '이전 버전 숙제';
  if(kind!=='parsed-profile-event' || typeof event!=='string')return '기타 기록';
  const labels:Record<string,string>={ABANDONED_FEE:'어벤던로드 입장료',SEED_GAINED:'SEED 수익',XP_CHANGED:'경험치 변동',
    ITEM_LOOTED:'아이템 획득',MAGIC_STONE_GAIN:'마정석 획득',MAGIC_STONE_LOSS:'마정석 사용',BUFF_USED:'버프 사용',
    ABANDONED_NU_ACQUISITION:'어벤던로드 누 발견',NORMAL_CHAT:'도전과제 시작',SUPPLY_RECAPTURE:'보급품 탈환'};
  if(Object.hasOwn(labels,event))return labels[event];
  if(/_(?:CLEAR|COMPLETE|GAIN)$/.test(event))return '숙제·콘텐츠 기록';
  if(/_ENTRY$/.test(event))return '콘텐츠 입장';
  return '게임 진행 알림';
}
function sample(payload:string,itemNames:ReadonlyMap<string,string>):string {
  try {
    const value=record(JSON.parse(payload)),data=record(value.data);
    // 파서가 감지한 원문을 짧게 보여준다. 임의 이벤트를 재생하거나 최종 일지 건수로 해석하지 않는다.
    if(typeof data.message==='string' && data.message.trim())return excerpt(data.message.trim());
    if(value.kind==='legacy-homework') {
      const homework=readLegacyPendingHomework(value.value);
      if(!homework) {
        const count=record(value.value).count;
        return `숙제 정보가 누락된 이전 기록${typeof count==='number' && Number.isFinite(count) ? ` (저장 수량: ${count.toLocaleString('ko-KR')})` : ''}`;
      }
      const name=itemNames.get(homework.id) || '현재 목록에서 찾을 수 없는 숙제';
      return excerpt(`${name} · ${homework.isIncrement ? '누적 보류 수량 +' : '완료 횟수 설정 '}${homework.count.toLocaleString('ko-KR')}회`);
    }
    const label=category(value.kind,value.event);
    if(typeof data.amount==='number' && Number.isFinite(data.amount)) {
      const amount=value.event==='ABANDONED_FEE' ? -Math.abs(data.amount) : data.amount;
      return excerpt(`${label} · ${amount>0 ? '+' : ''}${amount.toLocaleString('ko-KR')}${value.event==='ABANDONED_FEE' || value.event==='SEED_GAINED' ? ' SEED' : ''}`);
    }
    return label;
  } catch {return '내용을 확인할 수 없는 이전 기록';}
}

/** 미배정 기록은 감지 이벤트 수/종류와 최근 대표 원문 3개를 보여준다. 한 이벤트의 여러 소비 결과를
 * 별도 건수로 세지 않으며 지난 HUD/알림은 실제 배정에서도 재생하지 않는다. 읽기는 배정/ACK/원본을
 * 변경하지 않는다. 요청한 페이지의 세션만 집계하고 원문은 세션당 최근 3개를 요약한다.
 * 확인 토큰은 배정·무시 확인을 열 때 해당 세션의 최신 요약과 함께 별도 IPC에서 계산한다.
 * 구형 숙제는 합쳐 저장한 묶음 수와 보류 수량을 구분한다. ID/적용 방식이 없는 원본은 완료 횟수로
 * 해석하지 않고 배정 불가로 안내한다. 알 수 없는/손상된 payload도 보존한다. 회귀: check-profiles-ui.ts. */
export function readProfilePendingDetails(store:ApplicationData,sessions:PlayProfileStatus['pendingSessions'],itemNames:ReadonlyMap<string,string>):Record<string,ProfilePendingSessionDetails> {
  const result:Record<string,ProfilePendingSessionDetails>=Object.create(null);
  if(!sessions.length)return result;
  const ids=sessions.map(session=>session.sessionId);
  const placeholders=ids.map(()=>'?').join(',');
  for(const session of sessions)result[session.sessionId]={count:session.count,firstOccurredAt:session.firstOccurredAt,lastOccurredAt:session.lastOccurredAt,categories:[],samples:[]};
  const rows=store.database.prepare(`SELECT session_id,json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.kind') AS kind,
    json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.event') AS event,COUNT(*) AS count
    FROM pending_profile_events WHERE resolved_at IS NULL AND session_id IN (${placeholders}) GROUP BY session_id,kind,event`).all(...ids) as Array<{session_id:string;kind:unknown;event:unknown;count:number}>;
  for(const row of rows) {
    const target=result[row.session_id];if(!target)continue;
    const label=category(row.kind,row.event),existing=target.categories.find(item=>item.label===label);
    if(existing)existing.count+=row.count;else target.categories.push({label,count:row.count,...(row.kind==='legacy-homework' ? {unit:'묶음' as const} : {})});
  }
  const legacy=store.database.prepare(`SELECT session_id,payload FROM pending_profile_events WHERE resolved_at IS NULL
    AND session_id IN (${placeholders}) AND json_valid(payload) AND json_extract(payload,'$.kind')='legacy-homework'`).iterate(...ids) as Iterable<{session_id:string;payload:string}>;
  for(const row of legacy)if(result[row.session_id] && !readLegacyPendingHomework(record(JSON.parse(row.payload)).value)) {
    result[row.session_id].unassignableCount=(result[row.session_id].unassignableCount || 0)+1;
  }
  const orphaned=store.database.prepare(`SELECT e.session_id,COUNT(*) AS count FROM pending_profile_events e
    JOIN play_profiles p ON p.id=e.assigned_profile_id WHERE e.resolved_at IS NULL
    AND e.session_id IN (${placeholders}) AND p.deleted_at IS NOT NULL GROUP BY e.session_id`).all(...ids) as {session_id:string;count:number}[];
  for (const row of orphaned) if (result[row.session_id]) result[row.session_id].orphanedCount=row.count;
  const recent=store.database.prepare('SELECT payload,occurred_at FROM pending_profile_events WHERE resolved_at IS NULL AND session_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 3');
  for(const [id,target] of Object.entries(result)) {
    target.categories.sort((a,b)=>b.count-a.count || a.label.localeCompare(b.label,'ko'));
    target.samples=(recent.all(id) as Array<{payload:string;occurred_at:number}>).reverse().map(row=>({occurredAt:row.occurred_at,text:sample(row.payload,itemNames)}));
  }
  return result;
}
