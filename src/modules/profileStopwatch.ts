import type {StopwatchState,TimerRecord} from '../shared/types';
import {getProfileRuntime} from './profileRuntime';
import {captureStopwatchSnapshot} from './stopwatchCalculation';
import {stopwatchRevision,nextStopwatchRevision} from './stopwatchRevision';
import {broadcastToAllWindows} from './windowMessaging';
import {formatLocalDateKey} from '../shared/localDate';
import {isProfileServer} from '../shared/playProfiles';
import * as diary from './diaryDb';

type Session={state:Omit<StopwatchState,'revision'>;snapshot:Omit<TimerRecord,'id'> | null;sessionId?:string | null};
const idle=():Session => ({state:{running:false,startedAt:null,stoppedAt:null,duration:0},snapshot:null});
const sessions=new Map<string,Session>(),operations=new Map<string,number>();
let pending:Promise<unknown>=Promise.resolve(),signature='';

/** 프로필별 수동 시계는 메모리에만 보존한다. 전환/창 닫기는 중지하지 않고 앱 종료는 버린다.
 * 소유자/세션/계산 입력은 입력 수신 때 고정한다. 늦은 A 작업이 완료돼도 B 화면에는 B 상태만 보낸다.
 * 실제 종료 기록은 원래 프로필에 한 번 저장하며 실패는 측정을 유지한다. 회귀: check-profile-stopwatch.ts. */
export function getProfileStopwatchState():StopwatchState {
  const runtime=getProfileRuntime();
  if (!runtime) throw new Error('프로필 기능을 준비하고 있습니다.');
  try {
    const status=runtime.service.status(),profiles=runtime.service.store.list(true);
    const profile=status.profiles.find(item => item.id===status.activeProfileId);
    const selected=!status.selectionRequired && !!profile?.name.trim() && isProfileServer(profile?.userServer);
    const value=selected ? sessions.get(profile!.id) || idle() : idle();
    return {...value.state,revision:stopwatchRevision(),profileMode:true,profileId:selected ? profile!.id : null,
      profileName:selected ? profile!.name : '',selectionRequired:!selected,busy:status.busy || !!(selected && operations.get(profile!.id)),profiles};
  } catch {return {...idle().state,revision:stopwatchRevision(),profileMode:true,profileId:null,profileName:'',selectionRequired:true,busy:true,profiles:[]};}
}

export function refreshProfileStopwatch():void {
  if (!getProfileRuntime()) return;
  const value=getProfileStopwatchState(),{revision:_ignored,...body}=value,next=JSON.stringify(body);
  if (signature===next) return;
  signature=next;value.revision=nextStopwatchRevision();
  // 닫히는 창의 표시 실패로 이미 시작/저장한 측정을 실패 처리하지 않는다.
  try {broadcastToAllWindows('timer-toggle',value);} catch { /* 다음 상태 조회로 복구 */ }
}

export function controlProfileStopwatch(command:'start' | 'stop' | 'toggle',expectedId?:unknown):Promise<StopwatchState> {
  const receivedAt=Date.now(),runtime=getProfileRuntime();
  if (!runtime) return Promise.reject(new Error('프로필 기능을 준비하고 있습니다.'));
  try {
    const status=runtime.service.status(),id=status.activeProfileId,profile=status.profiles.find(item => item.id===id);
    if (status.selectionRequired || status.busy || !profile?.name.trim() || !isProfileServer(profile.userServer)) throw new Error('측정할 프로필을 먼저 선택해 주세요.');
    if (expectedId!==undefined && expectedId!==id) throw new Error('프로필이 바뀌었습니다. 측정할 프로필을 확인한 뒤 다시 눌러 주세요.');
    const store=runtime.service.store,sessionId=status.sessionId;
    const values=command==='stop' ? null : store.toolValues(id);
    operations.set(id,(operations.get(id) || 0)+1);refreshProfileStopwatch();
    const work=pending.then(() => {
      if (getProfileRuntime()!==runtime || !store.database.open || !store.list().some(item => item.id===id)) throw new Error('측정할 프로필의 상태가 바뀌었습니다. 다시 확인해 주세요.');
      const session=sessions.get(id) || idle(),start=command==='toggle' ? !session.state.running : command==='start';
      if (start===session.state.running) return;
      if (start) {
        const snapshot=captureStopwatchSnapshot(values || {});
        session.snapshot={...snapshot,raw_profile_data:JSON.stringify({...JSON.parse(snapshot.raw_profile_data),stopwatchPlayProfileId:id,stopwatchPlayProfileName:profile.name})};
        session.sessionId=sessionId;
        session.state={running:true,startedAt:receivedAt,stoppedAt:null,duration:0};
      } else {
        if (!session.snapshot || session.state.startedAt===null) throw new Error('측정 시작 정보를 찾을 수 없습니다.');
        const duration=Math.max(0,receivedAt-session.state.startedAt);
        const saved=store.withRecordContext(id,session.sessionId || null,() => diary.addTimerRecord({...session.snapshot!,date:formatLocalDateKey(new Date(receivedAt)),duration}));
        if (!saved) throw new Error('측정 기록을 저장하지 못했습니다. 측정은 유지됩니다. 다시 종료해 주세요.');
        session.snapshot=null;session.state={...session.state,running:false,stoppedAt:receivedAt,duration};
      }
      sessions.set(id,session);
    });
    const settled=work.finally(() => {operations.set(id,Math.max(0,(operations.get(id) || 1)-1));refreshProfileStopwatch();});
    pending=settled.catch(() => {});
    return settled.then(() => getProfileStopwatchState());
  } catch (error) {return Promise.reject(error);}
}
export async function waitForProfileStopwatch():Promise<void> {await pending;}
export function assertStopwatchProfileDeletable(id:string):void {
  if (sessions.get(id)?.state.running || operations.get(id)) throw new Error('이 프로필에서 시간을 측정하거나 저장 중입니다. 해당 프로필로 전환해 측정 종료 후 삭제해 주세요.');
}
export function clearProfileStopwatch():void {sessions.clear();signature='';}
