/**
 * 기능 계약 — 시간 측정 세션
 * - 버튼과 게임/앱 전경 단축키는 같은 메인 세션을 조작한다. 관리 창/HUD의 닫힘·재생성은
 *   측정을 끝내거나 초기화하지 않으며, 종료할 때 로컬 DB에 한 번만 저장한다.
 * - 프로필 모드는 profileStopwatch의 프로필별 메모리 세션을 사용한다. 전환해도 원래 측정은
 *   계속되며 원래 프로필에서 종료한다. 선택 대기에는 시작/종료를 거부한다. 측정 중 삭제도 거부한다.
 * - 시작 입력 때 원래 프로필의 DB 도구 값/세션 ID와 도핑 효과를 캡처한다. 일반 모드는
 *   기존 file-origin 저장소를 사용한다. 이후 다른 프로필의 설정으로 당시 기록을 바꾸지 않는다.
 *   구형 기록의 도핑만 원래 소유자를 참조하고 삭제된 소유자의 정보 부족은 재계산을 거부한다.
 * - 비동기 저장소 조회 중 입력도 순서대로 처리하되 시간은 입력 수신 시각을 사용한다.
 *   조회/DB 저장 실패는 상태를 확정하지 않는다. 앱 자체 종료 시 미종료 세션은 저장하지 않는다.
 * - scripts/check-stopwatch-session.ts: 실제 Electron 저장소·preload·IPC·SQLite·두 화면 회귀.
 *   제목 Enter/blur 저장과 Escape 취소는 실제 포커스가 있는 관리 창에서 검증한다.
 * - scripts/check-profile-stopwatch.ts: 실제 두 화면·SQLite로 소유권/병행 측정·실패 재시도,
 *   전체/프로필/미배정/삭제 기록·늦은 조회·편집 초안 및 최소 창을 검사한다. 일지는 동기화하지 않는다.
 */
import { ipcMain } from 'electron';
import type { StopwatchState, TimerRecord, StopwatchRecordMutation, StopwatchRecordResult } from '../shared/types';
import * as path from 'path';
import {pathToFileURL} from 'url';
import { formatLocalDateKey } from '../shared/localDate';
import * as diaryDb from './diaryDb';
import { readRendererStorage } from './rendererStorageBackup';
import { recalculateStatsAndCoefficient,captureStopwatchSnapshot,STOPWATCH_SERIES,STOPWATCH_CORES,STOPWATCH_TOOL_KEYS } from './stopwatchCalculation';
import { broadcastToAllWindows } from './windowMessaging';
import { log } from './logger';
import {getProfileRuntime} from './profileRuntime';
import {controlProfileStopwatch,getProfileStopwatchState,waitForProfileStopwatch} from './profileStopwatch';
import {nextStopwatchRevision,stopwatchRevision} from './stopwatchRevision';
import {resolveDiaryProfileFilter} from './diaryProfileAccess';

const seriesValues = STOPWATCH_SERIES;
const coreValues = STOPWATCH_CORES;
let state: StopwatchState = { revision: 0, running: false, startedAt: null, stoppedAt: null, duration: 0 };
let snapshot: Omit<TimerRecord, 'id'> | null = null;
let pending: Promise<unknown> = Promise.resolve();
let registered = false;
const recordWrites=new Map<number,Promise<unknown>>();
const stopwatchPage=pathToFileURL(path.resolve(__dirname,'..','stopwatch.html')).href;

export function getStopwatchState(): StopwatchState { return getProfileRuntime() ? getProfileStopwatchState() : { ...state,revision:stopwatchRevision() }; }

async function captureRecord(): Promise<Omit<TimerRecord, 'id'>> {
  return captureStopwatchSnapshot(await readRendererStorage(STOPWATCH_TOOL_KEYS));
}

export function controlStopwatch(command: 'start' | 'stop' | 'toggle',expectedProfileId?:unknown): Promise<StopwatchState> {
  if (getProfileRuntime()) return controlProfileStopwatch(command,expectedProfileId);
  if (expectedProfileId!==undefined) return Promise.reject(new Error('프로필 기능을 준비하고 있습니다.'));
  const receivedAt = Date.now();
  const operation = pending.then(async () => {
    const start = command === 'toggle' ? !state.running : command === 'start';
    if (start === state.running) return getStopwatchState();
    if (start) {
      const captured = await captureRecord();
      snapshot = captured;
      state = { revision: nextStopwatchRevision(), running: true, startedAt: receivedAt, stoppedAt: null, duration: 0 };
    } else {
      if (!snapshot || state.startedAt === null) throw new Error('Missing stopwatch snapshot');
      const duration = Math.max(0, receivedAt - state.startedAt);
      if (!diaryDb.addTimerRecord({ ...snapshot, date: formatLocalDateKey(new Date(receivedAt)), duration })) {
        throw new Error('Failed to save stopwatch record');
      }
      snapshot = null;
      state = { ...state, revision: nextStopwatchRevision(), running: false, stoppedAt: receivedAt, duration };
    }
    broadcastToAllWindows('timer-toggle', state);
    return getStopwatchState();
  });
  // A failed capture/save must not poison later user actions.
  pending = operation.catch(() => {});
  return operation;
}

export function registerStopwatchIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('timer-get-state', async () => { await pending;await waitForProfileStopwatch();return getStopwatchState(); });
  ipcMain.handle('timer-toggle-session', (_event, command: unknown, expectedProfileId?:unknown) => {
    if (command !== 'start' && command !== 'stop') throw new Error('Invalid stopwatch command');
    if (getProfileRuntime() && (typeof expectedProfileId!=='string' || _event.senderFrame!==_event.sender.mainFrame || _event.senderFrame?.url.split(/[?#]/)[0]!==stopwatchPage)) throw new Error('측정할 프로필을 확인해 주세요.');
    return controlStopwatch(command,expectedProfileId);
  });
  ipcMain.handle('timer-get-records', (_event,filter?:unknown) => {
    const runtime=getProfileRuntime();
    if (filter!==undefined) return diaryDb.getTimerRecords(resolveDiaryProfileFilter(filter));
    if (!runtime) return diaryDb.getTimerRecords();
    const status=runtime.service.status();
    return status.selectionRequired ? [] : diaryDb.getTimerRecords({kind:'profile',profileId:status.activeProfileId});
  });
  ipcMain.handle('timer-mutate-record',async (event,value:unknown):Promise<StopwatchRecordResult> => {
    try {
      if (!getProfileRuntime() || event.senderFrame!==event.sender.mainFrame || event.senderFrame?.url.split(/[?#]/)[0]!==stopwatchPage) throw new Error('시간 측정 기록 화면을 다시 열어 주세요.');
      await mutateRecord(parseMutation(value));
      return {success:true};
    } catch (error) {return {success:false,error:error instanceof Error ? error.message : '측정 기록을 저장하지 못했습니다.'};}
  });
  ipcMain.on('timer-update-title', (_event, id: unknown, title: unknown) => {
    if (getProfileRuntime() || !validId(id) || typeof title !== 'string' || title.length > 300) return;
    void mutateRecord({kind:'title',id,title}).catch(error => log(`[Stopwatch] Title update failed: ${error}`));
  });
  ipcMain.on('timer-delete-record', (_event, id: unknown) => {
    if (!getProfileRuntime() && validId(id)) void mutateRecord({kind:'delete',id}).catch(error => log(`[Stopwatch] Delete failed: ${error}`));
  });
  ipcMain.on('timer-update-series-core', (_event, id: unknown, series: unknown, core: unknown) => {
    if (getProfileRuntime() || !validId(id) || (series !== null && !seriesValues.includes(series as string))
      || (core !== null && !coreValues.includes(core as string))) return;
    void mutateRecord({kind:'recalculate',id,series:series as string | null,core:core as string | null})
      .catch(error => log(`[Stopwatch] Record recalculation failed: ${error}`));
  });
}

function validId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

function parseMutation(value:unknown):StopwatchRecordMutation {
  if (!value || typeof value!=='object') throw new Error('수정할 기록을 확인해 주세요.');
  const v=value as Record<string,unknown>;
  if (validId(v.id)) {
    if (v.kind==='title' && typeof v.title==='string' && v.title.length<=300) return {kind:'title',id:v.id,title:v.title};
    if (v.kind==='delete') return {kind:'delete',id:v.id};
    if (v.kind==='recalculate' && (v.series===null || seriesValues.includes(v.series as string)) && (v.core===null || coreValues.includes(v.core as string))) return {kind:'recalculate',id:v.id,series:v.series as string | null,core:v.core as string | null};
  }
  throw new Error('수정할 기록의 입력값을 확인해 주세요.');
}

/** 기록 ID의 소유자는 현재 조회/플레이 프로필과 독립적이다. 한 행의 비동기 편집은 순서대로
 * 처리하고 복원/삭제로 행이 교체되면 늦은 편집을 거부한다. 구형 기록만 원래 소유자의 도핑을
 * 읽으며 NULL 기록은 이전 브라우저 저장소를 사용한다. 새 기록은 시작 때의 효과로만 계산한다. */
async function mutateRecord(change:StopwatchRecordMutation):Promise<void> {
  const runtime=getProfileRuntime(),original=diaryDb.getTimerRecord(change.id);
  if (!original) throw new Error('측정 기록을 찾을 수 없습니다. 목록을 새로 확인해 주세요.');
  const identity=(record:TimerRecord) => JSON.stringify([record.record_uuid,record.profile_id,record.date,record.duration,record.raw_profile_data]);
  const latest=() => {
    if (getProfileRuntime()!==runtime || runtime && !runtime.service.store.database.open) throw new Error('기록 저장소가 바뀌었습니다. 화면을 다시 열어 주세요.');
    const record=diaryDb.getTimerRecord(change.id);
    if (!record || identity(record)!==identity(original)) throw new Error('측정 기록이 변경되거나 삭제되었습니다. 목록을 새로 확인해 주세요.');
    return record;
  };
  const work=(recordWrites.get(change.id) || Promise.resolve()).catch(() => {}).then(async () => {
    latest();
    let saved=false;
    if (change.kind==='title') saved=diaryDb.updateTimerRecordTitle(change.id,change.title);
    else if (change.kind==='delete') saved=diaryDb.deleteTimerRecord(change.id);
    else {
      const pData=JSON.parse(original.raw_profile_data);
      let presets:string | null=null;
      if (!pData.stopwatchBuffEffects && pData.buffPreset && !['none','standard'].includes(pData.buffPreset)) {
        if (runtime && original.profile_id) {
          const owner=runtime.service.store.list().find(profile => profile.id===original.profile_id);
          if (!owner) throw new Error('당시 도핑 정보가 없어 다시 계산할 수 없습니다.');
          presets=runtime.service.store.toolValues(owner.id).buff_presets || null;
        } else presets=(await readRendererStorage(['buff_presets'])).buff_presets;
      }
      const record=latest(),series=change.series ?? record.series,core=change.core ?? record.core_master;
      const calc=recalculateStatsAndCoefficient(pData,series,core,presets);
      saved=diaryDb.updateTimerRecordSeriesAndCore(change.id,series,core,calc.coefficient,calc.charMain,calc.charSub,calc.baseMain,calc.enchantMain,calc.baseSub,calc.enchantSub,calc.totalHit);
    }
    if (!saved) throw new Error('측정 기록을 저장하지 못했습니다. 다시 시도해 주세요.');
  });
  recordWrites.set(change.id,work);
  try {await work;} finally {if (recordWrites.get(change.id)===work) recordWrites.delete(change.id);}
}
