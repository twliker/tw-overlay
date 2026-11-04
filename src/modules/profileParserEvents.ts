import {randomUUID} from 'crypto';
import {chatParser} from './chatParser';
import {getProfileRuntime} from './profileRuntime';
import type {ChatParserEventMap} from '../shared/types';
import {collectRecordEffects,deferRecordEffect} from './recordEffects';
import * as config from './config';
import {nextProfileLogSource,claimProfileLogRange,type ProfileLogSource} from './profileLogSource';

type EventName=keyof ChatParserEventMap;
type Subscription={callback:(data:any) => void;progress:boolean};
const subscriptions=new Map<EventName,Subscription[]>();
const bridges=new Map<EventName,(data:any) => void>();
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
 * DB/숙제는 replay transaction에서, 타이머/진행 상태는 commit 후 현재 세션에만 적용한다.
 * 진입점은 runtime registry에 연결되기 전에는 기존 동작을 유지한다. 회귀: check-profile-recording.ts.
 */
export function onProfileEvent<K extends EventName>(event:K,callback:(data:ChatParserEventMap[K]) => void,progress=false):() => void {
  const entry:Subscription={callback,progress};
  const list=subscriptions.get(event) || [];list.push(entry);subscriptions.set(event,list);
  if (!bridges.has(event)) {
    const bridge=(data:ChatParserEventMap[K]) => {
      if (event==='NORMAL_CHAT' && !isQuestCommand(data as ChatParserEventMap['NORMAL_CHAT'])) return;
      const runtime=getProfileRuntime();
      if (!runtime) {for (const item of [...(subscriptions.get(event) || [])]) item.callback(data);return;}
      const observedAt=Date.now(),sessionId=runtime.service.status().sessionId;
      const origin=nextProfileLogSource(event);
      if (origin.eventId && runtime.service.store.hasEvent(origin.eventId)) return;
      const payload:ParsedProfileEvent={kind:'parsed-profile-event',version:1,event,data:structuredClone(data),observedAt,sessionId,...(origin.source ? {source:origin.source} : {})};
      runtime.service.dispatch(payload,runtime.replay,observedAt,origin.eventId || randomUUID());
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

export function replayProfileParserEvent(value:unknown):() => void {
  const event=value as ParsedProfileEvent;
  if (!event || event.kind!=='parsed-profile-event' || event.version!==1 || !subscriptions.has(event.event)
    || !event.data || typeof event.data.date!=='string' || typeof event.data.timestamp!=='string'
    || !Number.isFinite(event.observedAt)) throw new Error('지원하지 않는 프로필 대기 기록입니다.');
  const runtime=getProfileRuntime();
  if (event.source && runtime) {
    const store=runtime.service.store;
    if (!claimProfileLogRange(store.database,event.source,store.getRecordContext().profileId)) return ()=>{};
  }
  const current=!!event.sessionId && event.sessionId===runtime?.service.status().sessionId;
  const timestamp=profileEventTimestamp(event.data),age=Date.now()-timestamp;
  return collectRecordEffects(() => config.withConfirmedWrites(() => {
    for (const item of [...subscriptions.get(event.event)!]) {
      if (item.progress) {if (current) deferRecordEffect(() => item.callback(event.data));}
      else item.callback(event.data);
    }
  }),current && age>=-5000 && age<10000,Number.isFinite(timestamp) ? timestamp : event.observedAt);
}
