import {randomUUID} from 'crypto';
import {ChatParser,chatParser} from './chatParser';
import {getProfileRuntime} from './profileRuntime';
import type {ChatParserEventMap} from '../shared/types';
import {collectRecordEffects,deferRecordEffect} from './recordEffects';
import * as config from './config';
import {withDiaryActivitySource} from './diaryDb';
import {nextProfileLogSource,claimProfileLogRange,claimProfileLogLine,setProfileEventDurability,type ProfileLogSource} from './profileLogSource';
import type {LiveProfileRecord} from './profileService';
import {getEssenceExchangeCount} from '../shared/experienceEssence';
import {parseElsoMessage} from './itemAcquisition';

type EventName=keyof ChatParserEventMap;
type Subscription={callback:(data:any) => void | false | string;progress:boolean};
const subscriptions=new Map<EventName,Subscription[]>();
const bridges=new Map<EventName,(data:any) => void>();
let liveLine:LiveProfileRecord[] | undefined;

/** 한 줄을 해석하며 그 줄의 영구 기록만 모은다. 원시 채팅·순간 알림은 해석하는 동안 그대로 전달된다.
 * 저장은 persistLiveProfileRecords로 따로 한다. 저장이 실패해도 줄을 다시 해석하지 않고
 * 모은 기록만 재시도하면 화면·알림이 중복되거나 저장 실패 동안 멈추지 않는다.
 * 프로필 런타임이 없거나 일괄 복구 transaction 안이면 기존 경로로 해석만 하고 undefined를 반환한다. */
export function collectLiveProfileLine(parse:()=>void):LiveProfileRecord[] | undefined {
  const runtime=getProfileRuntime();
  if (!runtime || liveLine || runtime.service.store.database.inTransaction) {parse();return;}
  const events:LiveProfileRecord[]=[];
  liveLine=events;
  try {parse();} finally {liveLine=undefined;}
  return events;
}

/** collectLiveProfileLine이 모은 한 줄의 기록을 함께 저장한다. 실패하면 예외를 던지며 기록은 저장되지 않는다. */
export function persistLiveProfileRecords(records:readonly LiveProfileRecord[]):void {
  const runtime=getProfileRuntime();
  if (!runtime || !records.length) return;
  runtime.service.acceptLiveLine(records,runtime.replay);
}

/** Replay only the profile subscribers, without publishing old chat and notifications. */
export function createProfileRecoveryParser(date:string):ChatParser {
  const parser=new ChatParser();
  parser.setCurrentDate(date);
  for (const [event,bridge] of bridges) parser.on(event,bridge);
  return parser;
}
/** 기록 없이 화면·소리만 내는 순간 알림 이벤트. 프로필 대기/저장 흐름을 타지 않고
 * chatLogProcessor의 onMechanicAlert로만 즉시 처리한다. 대기열에 넣으면 앞선 기록의 저장 실패나
 * 대기 재시도 동안 알림이 막히고, 늦게 처리될 때는 최신성 범위를 벗어나 사라진다.
 * 이전 버전이 대기에 저장한 항목은 혼합 배정 배치에서 알림·줄 배정 없이 완료해 나머지 기록을 처리한다.
 * 회귀: check-profile-recording.ts. */
export const MECHANIC_ALERT_EVENTS:ReadonlySet<EventName>=new Set<EventName>([
  'ETHOS_PASSWORD','ABYSS_APOSTLE_PATTERN','WAVE_MONSTER_WARNING','LOKAGOS_PATTERN','ABYSS_TREASURE_COMPLETE',
  'SPECIAL_MONSTER_SPAWN','GOLGOTHA_SPECIAL_MONSTER_SPAWN',
]);
const resumableProgress=new Set<EventName>(['XP_CHANGED','BUFF_USED','ABANDONED_FEE','ABANDONED_ENTRY',
  'MAGIC_STONE_GAIN','MAGIC_STONE_LOSS','ABANDONED_NU_ACQUISITION']);
interface ParsedProfileEvent {kind:'parsed-profile-event';version:1;event:EventName;data:ChatParserEventMap[EventName];sessionId:string | null;observedAt:number;source?:ProfileLogSource}

export function profileEventTimestamp(data:{date:string;timestamp:string}):number {
  const time=data.timestamp.match(/^(\d{1,2})[:시]\s*(\d{1,2})[:분]\s*(\d{1,2})(?:초)?$/);
  return time ? new Date(`${data.date}T${time.slice(1).map(part => part.padStart(2,'0')).join(':')}`).getTime() : NaN;
}
function isQuestCommand(data:ChatParserEventMap['NORMAL_CHAT']):boolean {
  return /\[twOverlay\] (?:대장간|골고다|공허) 도전과제 시작/.test(data.message);
}

/** 기능 계약 — 원시 채팅 표시는 raw parser에 남기고 프로필 소유 처리만 이 허브에 등록한다.
 * 같은 파서 이벤트의 여러 소비자를 한 건으로 보관한다. 순수 일반/외치기는 대기 DB에 넣지 않는다.
 * DB/숙제는 replay transaction에서 처리한다. HUD 입력은 완료 표시와 함께 DB에 기록한 뒤
 * 현재 세션 메모리에 반영하며, 체크포인트 전에 종료되면 HUD만 복원한다.
 * 진입점은 runtime registry에 연결되기 전에는 기존 동작을 유지한다. 회귀: check-profile-recording.ts.
 */
export function onProfileEvent<K extends EventName>(event:K,callback:(data:ChatParserEventMap[K]) => void | false | string,
  progress=false):() => void {
  if (MECHANIC_ALERT_EVENTS.has(event)) throw new Error(`${event}는 순간 알림 이벤트라 프로필 기록 대기에 등록할 수 없습니다.`);
  const entry:Subscription={callback,progress};
  const list=subscriptions.get(event) || [];list.push(entry);subscriptions.set(event,list);
  if (!bridges.has(event)) {
    const bridge=(data:ChatParserEventMap[K]) => {
      if (event==='NORMAL_CHAT' && !isQuestCommand(data as ChatParserEventMap['NORMAL_CHAT'])) return;
      const runtime=getProfileRuntime();
      if (!runtime) {for (const item of [...(subscriptions.get(event) || [])]) item.callback(data);return;}
      const observedAt=Date.now(),origin=nextProfileLogSource(event,data.date,data.timestamp);
      const sessionId=origin.source?.unassigned ? null : runtime.service.currentSessionId;
      const primary=origin.eventId ? runtime.service.store.eventRecordState(origin.eventId) : undefined;
      const state=primary ?? (origin.legacyId && origin.legacyId!==origin.eventId ? runtime.service.store.eventRecordState(origin.legacyId) : undefined);
      if (state) {
        if (liveLine && !state.resolved) liveLine.push({
          eventId:(primary ? origin.eventId : origin.legacyId)!,occurredAt:observedAt,payload:undefined,
          unassigned:origin.source?.unassigned,
        });
        else if (!liveLine) runtime.service.retryLiveRecords(state,runtime.replay);
        return;
      }
      const payload:ParsedProfileEvent={kind:'parsed-profile-event',version:1,event,data:structuredClone(data),observedAt,sessionId,...(origin.source ? {source:origin.source} : {})};
      if (liveLine && origin.eventId) liveLine.push({
        payload,eventId:origin.eventId,occurredAt:observedAt,unassigned:origin.source?.unassigned,
      });
      else runtime.service.dispatch(payload,runtime.replay,observedAt,origin.eventId || randomUUID(),origin.source?.unassigned);
    };
    bridges.set(event,bridge);chatParser.on(event,bridge);
  }
  return () => {
    const index=list.indexOf(entry);if (index!==-1) list.splice(index,1);
    if (!list.length) {chatParser.removeListener(event,bridges.get(event)!);bridges.delete(event);subscriptions.delete(event);}
  };
}
export function onProfileProgress<K extends EventName>(event:K,callback:(data:ChatParserEventMap[K]) => void):() => void {
  return onProfileEvent(event,callback,true);
}

/** 일지·숙제에 남을 수 있는 이벤트인지(profileLogSource의 보관 범위 계약). 경험치는 정수 교환(100억 단위 감소)만,
 * 획득은 자기 획득·엘소 문구만 기록된다(chatLogProcessor·chatLogSyncWorker와 같은 조건). 진행(HUD)
 * 구독자만 있는 이벤트는 기록하지 않는다. 그 밖에는 판단하지 않고(undefined) 보존한다. */
function isDurableProfileEventData(event:string,data:unknown):boolean | undefined {
  const value=data as {amount?:unknown;isOwn?:unknown;message?:unknown} | undefined;
  if (event==='XP_CHANGED') return value ? getEssenceExchangeCount(Number(value.amount))>0 : undefined;
  if (event==='ITEM_LOOTED') return value ? value.isOwn!==false || parseElsoMessage(String(value.message ?? ''))>0 : undefined;
  const list=subscriptions.get(event as EventName);
  return list?.length && list.every(item=>item.progress) ? false : undefined;
}
setProfileEventDurability(isDurableProfileEventData);

function readProfileParserEvent(value:unknown):ParsedProfileEvent {
  const event=value as ParsedProfileEvent;
  if (!event || event.kind!=='parsed-profile-event' || event.version!==1 || !(subscriptions.has(event.event) || MECHANIC_ALERT_EVENTS.has(event.event))
    || !event.data || typeof event.data.date!=='string' || typeof event.data.timestamp!=='string'
    || !Number.isFinite(event.observedAt)) throw new Error('지원하지 않는 프로필 대기 기록입니다.');
  return event;
}

const noRecordedEffect=Symbol('no-recorded-effect');
class SkippedProfileEvent extends Error {}

export function replayProfileParserEvent(value:unknown,eventId:string,pendingAssignment=false):(() => void) | string {
  const event=readProfileParserEvent(value);
  if (MECHANIC_ALERT_EVENTS.has(event.event)) return ()=>{};
  const runtime=getProfileRuntime();
  const store=runtime?.service.store,owner=store?.getRecordContext().profileId;
  const current=!!event.sessionId && event.sessionId===runtime?.service.currentSessionId;
  const listeners=[...subscriptions.get(event.event)!];
  const timestamp=profileEventTimestamp(event.data),age=Date.now()-timestamp;
  const record=() => {
    if (event.source && store) {
      const {lineKey}=event.source;
      const accepted=lineKey ? claimProfileLogLine(store.database,lineKey,event.data.date,owner ?? null,isDurableProfileEventData(event.event,event.data) ?? true)
        : claimProfileLogRange(store.database,event.source,owner ?? null);
      if (!accepted) {
        const existing=lineKey ? store.database.prepare('SELECT profile_id FROM profile_log_line_owners WHERE line_key=?')
          .get(Buffer.from(lineKey,'hex')) as {profile_id:string | null} | undefined : undefined;
        if (pendingAssignment && (!existing || existing.profile_id!==owner)) {
          return '원본 로그가 이미 다른 기록 대상에 연결되어 있습니다.';
        }
        return ()=>{};
      }
    }
    const hasProgress=current && listeners.some(item=>item.progress);
    if (hasProgress && owner) store?.stageRuntimeEvent(owner,eventId);
    return collectRecordEffects(() => config.withConfirmedWrites(() => {
      let recorded=hasProgress;
      for (const item of listeners) {
        if (!item.progress) {
          const result=withDiaryActivitySource(event.source?.lineKey,()=>item.callback(event.data));
          if (pendingAssignment && typeof result==='string') throw new SkippedProfileEvent(result);
          recorded ||= result!==false;
        } else if (current) deferRecordEffect(() => {
          try {item.callback(event.data);}
          catch (error) {
            if (owner) runtime?.progressFailed?.(owner);
            throw error;
          }
        });
      }
      if (pendingAssignment && !recorded) throw noRecordedEffect;
    }),current && age>=-5000 && age<10000,Number.isFinite(timestamp) ? timestamp : event.observedAt,pendingAssignment);
  };
  if (!pendingAssignment || !store) return record();
  // 대기 배정에서 거부되거나 기록할 내용이 없는 이벤트는 원본 귀속과 화면 효과를 남기지 않는다.
  try {return store.database.transaction(record)();}
  catch (error) {
    if (error===noRecordedEffect) return ()=>{};
    if (error instanceof SkippedProfileEvent) return error.message;
    throw error;
  }
}

/** 확정된 기록의 HUD만 재생한다. 새 게임에서 지난 도전과제·발굴지·보급 현황을 시작하지 않는다. */
export function recoverProfileProgress(value:unknown,sessionId:string | null):void {
  const event=readProfileParserEvent(value);
  if (event.sessionId!==sessionId && !resumableProgress.has(event.event)) return;
  const timestamp=profileEventTimestamp(event.data);
  collectRecordEffects(() => {
    for (const item of subscriptions.get(event.event) ?? []) {
      if (item.progress) deferRecordEffect(()=>item.callback(event.data));
    }
  },false,Number.isFinite(timestamp) ? timestamp : event.observedAt,true)();
}
