/**
 * 기능 계약 — 시간 측정 세션
 * - 버튼과 게임/앱 전경 단축키는 같은 메인 세션을 조작한다. 관리 창/HUD의 닫힘·재생성은
 *   측정을 끝내거나 초기화하지 않으며, 종료할 때 로컬 DB에 한 번만 저장한다.
 * - 시작 때 계수 계산기 프로필과 도핑 효과를 캡처한다. 종료 전 설정 변경이나 이후 기록의
 *   계열·코어 변경은 당시 스탯을 덮어쓰지 않는다. 기존 기록에는 종전 도핑 해석을 유지한다.
 * - 비동기 저장소 조회 중 입력도 순서대로 처리하되 시간은 입력 수신 시각을 사용한다.
 *   조회/DB 저장 실패는 상태를 확정하지 않는다. 앱 자체 종료 시 미종료 세션은 저장하지 않는다.
 * - scripts/check-stopwatch-session.ts: 실제 Electron 저장소·preload·IPC·SQLite·두 화면 회귀.
 *   제목 Enter/blur 저장과 Escape 취소는 실제 포커스가 있는 관리 창에서 검증한다.
 */
import { ipcMain } from 'electron';
import type { StopwatchState, TimerRecord } from '../shared/types';
import { formatLocalDateKey } from '../shared/localDate';
import * as diaryDb from './diaryDb';
import { readRendererStorage } from './rendererStorageBackup';
import { recalculateStatsAndCoefficient } from './stopwatchCalculation';
import { broadcastToAllWindows } from './windowMessaging';
import { log } from './logger';

const PROFILES_KEY = 'tw-coefficient-calculator-profiles-v1';
const seriesValues = ['stab', 'hack', 'phycomp', 'magatk', 'maghack', 'magdef'];
const coreValues = ['none', 'mercurial', 'abyss', 'eclipse', 'rubicona'];
let state: StopwatchState = { revision: 0, running: false, startedAt: null, stoppedAt: null, duration: 0 };
let snapshot: Omit<TimerRecord, 'id'> | null = null;
let pending: Promise<unknown> = Promise.resolve();
let registered = false;

export function getStopwatchState(): StopwatchState { return { ...state }; }

async function captureRecord(): Promise<Omit<TimerRecord, 'id'>> {
  const values = await readRendererStorage([PROFILES_KEY, `${PROFILES_KEY}_last`, 'buff_presets']);
  const profiles = JSON.parse(values[PROFILES_KEY] || '{}');
  const pData = profiles?.[values[`${PROFILES_KEY}_last`] || 'default']?.data || {};
  const series = seriesValues.includes(pData.currentType) ? pData.currentType : 'stab';
  const core = coreValues.includes(pData.mainCore) ? pData.mainCore : 'none';
  const calc = recalculateStatsAndCoefficient(pData, series, core, values.buff_presets);
  return {
    date: '', duration: 0, title: '', series, core_master: core,
    coefficient: calc.coefficient, char_main: calc.charMain, char_sub: calc.charSub,
    base_main: calc.baseMain, enchant_main: calc.enchantMain,
    base_sub: calc.baseSub, enchant_sub: calc.enchantSub, accuracy: calc.totalHit,
    raw_profile_data: JSON.stringify({ ...pData, stopwatchBuffEffects: calc.buffEffects }),
  };
}

export function controlStopwatch(command: 'start' | 'stop' | 'toggle'): Promise<StopwatchState> {
  const receivedAt = Date.now();
  const operation = pending.then(async () => {
    const start = command === 'toggle' ? !state.running : command === 'start';
    if (start === state.running) return getStopwatchState();
    if (start) {
      const captured = await captureRecord();
      snapshot = captured;
      state = { revision: state.revision + 1, running: true, startedAt: receivedAt, stoppedAt: null, duration: 0 };
    } else {
      if (!snapshot || state.startedAt === null) throw new Error('Missing stopwatch snapshot');
      const duration = Math.max(0, receivedAt - state.startedAt);
      if (!diaryDb.addTimerRecord({ ...snapshot, date: formatLocalDateKey(new Date(receivedAt)), duration })) {
        throw new Error('Failed to save stopwatch record');
      }
      snapshot = null;
      state = { ...state, revision: state.revision + 1, running: false, stoppedAt: receivedAt, duration };
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
  ipcMain.handle('timer-get-state', async () => { await pending; return getStopwatchState(); });
  ipcMain.handle('timer-toggle-session', (_event, command: unknown) => {
    if (command !== 'start' && command !== 'stop') throw new Error('Invalid stopwatch command');
    return controlStopwatch(command);
  });
  ipcMain.handle('timer-get-records', () => diaryDb.getTimerRecords());
  ipcMain.on('timer-update-title', (_event, id: unknown, title: unknown) => {
    if (!validId(id) || typeof title !== 'string' || title.length > 300) return;
    diaryDb.updateTimerRecordTitle(id, title);
  });
  ipcMain.on('timer-delete-record', (_event, id: unknown) => {
    if (validId(id)) diaryDb.deleteTimerRecord(id);
  });
  ipcMain.on('timer-update-series-core', (_event, id: unknown, series: unknown, core: unknown) => {
    if (!validId(id) || (series !== null && !seriesValues.includes(series as string))
      || (core !== null && !coreValues.includes(core as string))) return;
    void updateRecord(id, series as string | null, core as string | null)
      .catch(error => log(`[Stopwatch] Record recalculation failed: ${error}`));
  });
}

function validId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

async function updateRecord(id: number, series: string | null, core: string | null): Promise<void> {
  const record = diaryDb.getTimerRecords().find(item => item.id === id);
  if (!record) return;
  const pData = JSON.parse(record.raw_profile_data);
  const presets = pData.stopwatchBuffEffects ? null : (await readRendererStorage(['buff_presets'])).buff_presets;
  // 구형 기록의 저장소 조회 중 들어온 다른 필드 편집도 보존한다.
  const latest = diaryDb.getTimerRecords().find(item => item.id === id);
  if (!latest) return;
  const nextSeries = series ?? latest.series;
  const nextCore = core ?? latest.core_master;
  const calc = recalculateStatsAndCoefficient(pData, nextSeries, nextCore, presets);
  diaryDb.updateTimerRecordSeriesAndCore(id, nextSeries, nextCore, calc.coefficient,
    calc.charMain, calc.charSub, calc.baseMain, calc.enchantMain, calc.baseSub, calc.enchantSub, calc.totalHit);
}
