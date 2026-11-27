import {randomUUID} from 'crypto';
import {diagTransition,shortId} from './profileDiagnostics';
import * as fs from 'fs';
import iconv = require('iconv-lite');
import {ChatLogLineNormalizer,detectChatLogEncoding} from './chatLogNormalizer';
import {ChatParser,chatParser} from './chatParser';
import {getProfileRuntime} from './profileRuntime';
import type {ChatParserEventMap} from '../shared/types';
import {collectRecordEffects,deferRecordEffect} from './recordEffects';
import * as config from './config';
import {withDiaryActivitySource} from './diaryDb';
import {nextProfileLogSource,claimProfileLogRange,claimProfileLogLine,setProfileEventDurability,type ProfileLogSource} from './profileLogSource';
import type {LiveProfileRecord,LiveReadSpan} from './profileService';
import {getEssenceExchangeCount} from '../shared/experienceEssence';
import {parseElsoMessage,recordsLootLine} from './itemAcquisition';
import {normalizeNotificationKeywords} from '../shared/keywordSanitizer';

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
export function persistLiveProfileRecords(records:readonly LiveProfileRecord[],span?:LiveReadSpan):void {
  persistLiveProfileBatch([records],span);
}

/** 한 번의 읽기에서 모은 여러 줄의 기록을 한 commit으로 저장한다(ProfileService.acceptLiveLines 계약).
 * 실패하면 예외를 던지며 어느 줄의 기록도 저장되지 않는다. */
export function persistLiveProfileBatch(lines:readonly (readonly LiveProfileRecord[])[],span?:LiveReadSpan):void {
  const runtime=getProfileRuntime();
  if (!runtime || !lines.some(records=>records.length)) return;
  runtime.service.acceptLiveLines(lines,runtime.replay,span);
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
      // 대기 행 없이 바로 반영한 줄은 프로필별 읽은 범위로 거른다(이벤트 행이 있으면 위에서 그 상태를 따른다).
      const source=origin.source,store=runtime.service.store;
      // 진단: 아래 거름·미배정은 오류 없이 HUD·일지에서 빠진다. 선택된 상태에서 새 줄이 계속 여기로 빠지면 멈춘 것처럼 보인다.
      const note=(state:string)=>diagTransition('live-source',state,`event=${event} profile=${shortId(runtime.service.selectedProfileId)}`);
      if (source?.fingerprint && Number.isSafeInteger(source.start) && store.appliedRangeCovers(source.fingerprint,source.start)) {note('skipped:range-already-applied');return;}
      // 처리 구간이 지워진 줄(파일 교체·절단 뒤 처음부터 다시 읽음)도 일지·숙제에 남는 줄이면 줄 귀속(live=1)으로 거른다.
      if (source?.lineKey && store.lineAppliedLive(source.lineKey)) {note('skipped:line-already-applied');return;}
      note(origin.source?.unassigned ? 'unassigned-source' : 'owned');
      // 경험치 줄(정수 교환 아님)은 HUD에만 쓰인다. 이런 줄만 있는 읽기는 처리 구간을 DB에 바로 쓰지 않는다(acceptLiveLines).
      // 버프 등 다른 진행 줄은 드물고, 비정상 종료 뒤 빠지면 남은 시간 내내 HUD가 비므로 지금처럼 바로 쓴다.
      const hudOnly=event==='XP_CHANGED' && isDurableProfileEventData(event,data)===false;
      // 소유자를 확정할 수 없는 줄(재시작 복구 읽기·세션 경계)의 경험치는 배정해도 HUD에 재생하지 않고 기록도 없다(이전 세션 계약).
      // 대기 행으로 남기면 강제 종료 뒤 미룬 구간(최대 1분)의 경험치 줄이 줄마다 미배정 기록으로 쌓이므로 남기지 않는다.
      if (hudOnly && source?.unassigned) return;
      const payload:ParsedProfileEvent={kind:'parsed-profile-event',version:1,event,data:structuredClone(data),observedAt,sessionId,...(origin.source ? {source:origin.source} : {})};
      if (liveLine && origin.eventId) liveLine.push({
        payload,eventId:origin.eventId,occurredAt:observedAt,unassigned:origin.source?.unassigned,...(hudOnly ? {hudOnly} : {}),
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

/** 실시간 줄 귀속(profile_log_line_owners live=1)을 지금 남길지. 기본은 보관 범위(isDurableProfileEventData)를 따르고,
 * 획득 줄은 지금 설정으로 일지에 실제 남는 줄만 남긴다(recordsLootLine 계약). 보관 범위 자체는 바꾸지 않는다:
 * 30일 대기 원문 압축은 그 판단으로 영수증을 버리고 귀속을 놓는데(compactResolvedEvents), 등록 아이템 설정은 나중에
 * 바뀔 수 있어 그때 기록된 줄의 증거를 지우면 안 되기 때문이다. 회귀: check-profile-durability.ts(획득 줄 귀속 수). */
function persistsLineOwner(event:string,data:unknown):boolean {
  if (event==='ITEM_LOOTED' && data && typeof data==='object') {
    const value=data as {itemName?:unknown;count?:unknown;isOwn?:unknown;message?:unknown};
    if (typeof value.itemName==='string' && typeof value.message==='string' && typeof value.isOwn==='boolean' && typeof value.count==='number') {
      return recordsLootLine({itemName:value.itemName,count:value.count,isOwn:value.isOwn,message:value.message},
        normalizeNotificationKeywords(config.loadFields(['lootKeywords']).lootKeywords));
    }
  }
  return isDurableProfileEventData(event,data) ?? true;
}

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
      // 처리 구간이 먼저다: 무시했거나 다른 프로필이 반영(복원 포함)한 줄은 이 프로필에 기록하지 않는다.
      // 같은 프로필의 반영 구간은 같은 줄의 다른 기록이 먼저 완료된 경우라 이어서 기록한다.
      const range=event.source.fingerprint && Number.isSafeInteger(event.source.start) ? store.rangeAt(event.source.fingerprint,event.source.start) : undefined;
      if (range && (range.state!=='applied' || range.profileId!==(owner ?? null))) {
        diagTransition('record-range',`skipped:${range.state}`,`range-profile=${shortId(range.profileId)} profile=${shortId(owner)}`);
        return pendingAssignment ? '원본 로그가 이미 다른 기록 대상에 연결되어 있습니다.' : ()=>{};
      }
      // 일지·숙제에 남는 줄은 바로 반영에서도 줄 귀속(live=1)을 남긴다. 처리 구간은 위치 기준이라 파일 교체로 지워질 수 있고,
      // 귀속은 내용(줄 키) 기준이라 같은 줄을 다시 읽어도 걸러 준다(onProfileEvent, 재분석 knownLines). 기록 없는 줄은 만들지 않는다.
      const accepted=lineKey ? claimProfileLogLine(store.database,lineKey,event.data.date,owner ?? null,persistsLineOwner(event.event,event.data))
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
          const result=withDiaryActivitySource(event.source,()=>item.callback(event.data));
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

/** 기능 계약 — 체크포인트 뒤 바로 반영한 실시간 줄의 HUD 복원(대기 원문 없이 원본 로그에서).
 * - 바로 반영한 줄은 HUD 복원 대기(profile_runtime_events) 대신 체크포인트 뒤 HUD 복원 구간(ApplicationData.runtimeRanges)을
 *   남기고, 체크포인트가 그 행을 비운다. 비정상 종료 뒤 선택 때 남은 구간만 원본에서 다시 읽어 진행(HUD) 구독자만 재생한다
 *   (recoverProfileProgress와 같은 규칙: 다른 세션이면 이어 갈 수 있는 진행만). 기록은 만들지 않는다.
 *   복원·v3.3.5 원문 변환·이전 세션 배정이 만든 반영 구간은 이 표에 없어 재생하지 않는다.
 * - 원본 파일이 없거나 읽지 못하면 그 구간의 HUD만 잃는다(기록은 이미 확정). 반환값은 재생한 이벤트 수.
 * 회귀: check-profile-durability.ts(정전 뒤 HUD 경험치), check-profile-recording.ts. */
export function recoverLiveProgress(segments:readonly {filePath:string;date:string;start:number;end:number}[],recordedSession:string | null,currentSession:string | null):number {
  let replayed=0;
  for (const segment of segments) {
    let bytes:Buffer,head:Buffer;
    try {
      const fd=fs.openSync(segment.filePath,'r');
      try {
        const size=fs.fstatSync(fd).size,end=Math.min(segment.end,size);
        if (end<=segment.start) continue;
        bytes=Buffer.alloc(end-segment.start);fs.readSync(fd,bytes,0,bytes.length,segment.start);
        head=Buffer.alloc(Math.min(size,64*1024));fs.readSync(fd,head,0,head.length,0);
      } finally {fs.closeSync(fd);}
    } catch {continue;}
    const encoding=detectChatLogEncoding(head),parser=new ChatParser(),normalizer=new ChatLogLineNormalizer();
    parser.setCurrentDate(segment.date);
    for (const event of subscriptions.keys()) {
      parser.on(event,(data:any)=>{
        if (event==='NORMAL_CHAT' && !isQuestCommand(data)) return;
        recoverProfileProgress({kind:'parsed-profile-event',version:1,event,data,sessionId:recordedSession,observedAt:Date.now()},currentSession);
        replayed++;
      });
    }
    const lines:string[]=[];
    let from=0;
    for (let index=bytes.indexOf(10);index!==-1;index=bytes.indexOf(10,from)) {lines.push(iconv.decode(bytes.subarray(from,index),encoding).replace(/\r$/,''));from=index+1;}
    if (from<bytes.length) lines.push(iconv.decode(bytes.subarray(from),encoding).replace(/\r$/,''));
    for (const line of [...lines.flatMap(item=>normalizer.push(item)),...normalizer.flush()]) {
      if (line && !line.includes('회복되었습니다')) parser.parseLine(line);
    }
  }
  return replayed;
}
