import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STORE_HELPER_PROTOCOL_VERSION = 1;
const STORE_HELPER_EXE = 'TWOverlay.StoreUpdateHelper.exe';
const MAX_HELPER_OUTPUT_CHARS = 64 * 1024;

export interface StoreUpdateCheckResult {
  updateAvailable: boolean;
  mandatory: boolean;
  canSilentlyInstall: boolean;
  version?: string;
}

export interface StoreUpdateProgressEvent {
  type: 'progress';
  phase: 'downloading' | 'downloaded' | 'deploying';
  percent: number;
}

export interface StoreUpdateInstallResult {
  type: 'install-result';
  state: string;
  completed: boolean;
  mandatory: boolean;
  noUpdate: boolean;
}

export interface StoreUpdatePermissionRequired {
  type: 'permission-required';
  mandatory: boolean;
  message?: string;
}

interface StoreUpdateCheckEvent extends StoreUpdateCheckResult {
  type: 'check-result';
}

interface StoreUpdateHelperError {
  type: 'error';
  code: string;
  message: string;
}

interface StoreUpdateSelfTestEvent {
  type: 'self-test';
  protocolVersion: number;
  runtime?: string;
}

export type StoreUpdateHelperEvent = StoreUpdateCheckEvent
  | StoreUpdateProgressEvent
  | StoreUpdateInstallResult
  | StoreUpdatePermissionRequired
  | StoreUpdateHelperError
  | StoreUpdateSelfTestEvent;

export type StoreUpdateInstallOutcome = StoreUpdateInstallResult | StoreUpdatePermissionRequired;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 도우미의 JSONL 출력을 신뢰 경계에서 검증해 예상한 필드만 앱에 전달한다. */
export function parseStoreUpdateHelperEvent(line: string): StoreUpdateHelperEvent {
  if (line.length === 0 || line.length > MAX_HELPER_OUTPUT_CHARS) {
    throw new Error('Microsoft Store 업데이트 도우미 출력 길이가 올바르지 않습니다.');
  }

  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new Error('Microsoft Store 업데이트 도우미 출력 형식이 올바르지 않습니다.');
  }

  switch (parsed.type) {
    case 'self-test':
      if (parsed.protocolVersion !== STORE_HELPER_PROTOCOL_VERSION) {
        throw new Error(`Store 업데이트 도우미 프로토콜 불일치: ${String(parsed.protocolVersion)}`);
      }
      return {
        type: 'self-test',
        protocolVersion: STORE_HELPER_PROTOCOL_VERSION,
        runtime: typeof parsed.runtime === 'string' ? parsed.runtime : undefined,
      };
    case 'check-result':
      if (typeof parsed.updateAvailable !== 'boolean'
        || typeof parsed.mandatory !== 'boolean'
        || typeof parsed.canSilentlyInstall !== 'boolean') {
        throw new Error('Store 업데이트 확인 결과가 올바르지 않습니다.');
      }
      return {
        type: 'check-result',
        updateAvailable: parsed.updateAvailable,
        mandatory: parsed.mandatory,
        canSilentlyInstall: parsed.canSilentlyInstall,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
      };
    case 'progress': {
      const phase = parsed.phase;
      if ((phase !== 'downloading' && phase !== 'downloaded' && phase !== 'deploying')
        || typeof parsed.percent !== 'number' || !Number.isFinite(parsed.percent)) {
        throw new Error('Store 업데이트 진행 상태가 올바르지 않습니다.');
      }
      return {
        type: 'progress',
        phase,
        percent: Math.max(0, Math.min(100, Math.round(parsed.percent))),
      };
    }
    case 'install-result':
      if (typeof parsed.state !== 'string'
        || typeof parsed.completed !== 'boolean'
        || typeof parsed.mandatory !== 'boolean'
        || typeof parsed.noUpdate !== 'boolean') {
        throw new Error('Store 업데이트 설치 결과가 올바르지 않습니다.');
      }
      return {
        type: 'install-result',
        state: parsed.state,
        completed: parsed.completed,
        mandatory: parsed.mandatory,
        noUpdate: parsed.noUpdate,
      };
    case 'permission-required':
      if (typeof parsed.mandatory !== 'boolean') {
        throw new Error('Store 업데이트 권한 결과가 올바르지 않습니다.');
      }
      return {
        type: 'permission-required',
        mandatory: parsed.mandatory,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
      };
    case 'error':
      if (typeof parsed.code !== 'string' || typeof parsed.message !== 'string') {
        throw new Error('Store 업데이트 오류 결과가 올바르지 않습니다.');
      }
      return { type: 'error', code: parsed.code, message: parsed.message };
    default:
      throw new Error(`알 수 없는 Store 업데이트 도우미 이벤트: ${parsed.type}`);
  }
}

/** ASAR에서 실행 파일을 직접 시작할 수 없으므로 AppX에서 unpack된 절대 경로를 사용한다. */
export function resolveStoreUpdateHelperPath(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist',
      'store-update-helper',
      STORE_HELPER_EXE,
    );
  }
  return path.join(app.getAppPath(), 'dist', 'store-update-helper', STORE_HELPER_EXE);
}

/** Electron의 네이티브 HWND 버퍼를 도우미 명령행에 안전하게 전달할 10진 문자열로 변환한다. */
export function getWindowHandleArgument(window: BrowserWindow | null): string {
  if (!window || window.isDestroyed()) return '0';
  const handle = window.getNativeWindowHandle();
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString(10);
  if (handle.length >= 4) return BigInt(handle.readUInt32LE(0)).toString(10);
  return '0';
}

interface RunHelperOptions {
  helperPath?: string;
  timeoutMs?: number;
  detachAfterCompletedInstall?: boolean;
  onEvent?: (event: StoreUpdateHelperEvent) => void;
}

function runStoreUpdateHelper(
  args: string[],
  terminalTypes: ReadonlySet<StoreUpdateHelperEvent['type']>,
  options: RunHelperOptions = {},
): Promise<StoreUpdateHelperEvent> {
  const helperPath = options.helperPath || resolveStoreUpdateHelperPath();
  if (!fs.existsSync(helperPath)) {
    return Promise.reject(new Error(`Microsoft Store 업데이트 도우미가 없습니다: ${helperPath}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, {
      cwd: path.dirname(helperPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: options.detachAfterCompletedInstall === true,
    });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let terminalEvent: StoreUpdateHelperEvent | null = null;
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    const settleResolve = (event: StoreUpdateHelperEvent, detach = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (detach) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolve(event);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill();
        settleReject(new Error('Microsoft Store 업데이트 확인 시간이 초과되었습니다.'));
      }, options.timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_HELPER_OUTPUT_CHARS * 2) {
        child.kill();
        settleReject(new Error('Microsoft Store 업데이트 도우미 출력이 너무 큽니다.'));
        return;
      }

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const event = parseStoreUpdateHelperEvent(line);
          options.onEvent?.(event);
          if (event.type === 'error') {
            settleReject(new Error(`[${event.code}] ${event.message}`));
            return;
          }
          if (terminalTypes.has(event.type)) {
            terminalEvent = event;
            if (options.detachAfterCompletedInstall
              && event.type === 'install-result'
              && event.completed
              && !event.noUpdate) {
              settleResolve(event, true);
              return;
            }
          }
        } catch (error) {
          child.kill();
          settleReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderrBuffer.length < MAX_HELPER_OUTPUT_CHARS) stderrBuffer += chunk;
    });
    child.on('error', error => settleReject(error));
    child.on('close', code => {
      if (settled) return;
      if (terminalEvent) {
        settleResolve(terminalEvent);
        return;
      }
      settleReject(new Error(
        `Microsoft Store 업데이트 도우미가 결과 없이 종료되었습니다. (code=${String(code)}) ${stderrBuffer.trim()}`.trim(),
      ));
    });
  });
}

export async function checkForStoreUpdates(options: RunHelperOptions = {}): Promise<StoreUpdateCheckResult> {
  const event = await runStoreUpdateHelper(
    ['check'],
    new Set<StoreUpdateHelperEvent['type']>(['check-result']),
    { ...options, timeoutMs: options.timeoutMs ?? 15_000 },
  );
  if (event.type !== 'check-result') throw new Error('Microsoft Store 업데이트 확인 결과가 없습니다.');
  return event;
}

export async function installStoreUpdates(
  ownerWindow: BrowserWindow | null,
  options: RunHelperOptions = {},
): Promise<StoreUpdateInstallOutcome> {
  const event = await runStoreUpdateHelper([
    'install',
    '--window-handle', getWindowHandleArgument(ownerWindow),
    '--parent-pid', String(process.pid),
    '--application-id', 'twOverlay',
  ], new Set<StoreUpdateHelperEvent['type']>(['install-result', 'permission-required']), {
    ...options,
    detachAfterCompletedInstall: true,
  });
  if (event.type !== 'install-result' && event.type !== 'permission-required') {
    throw new Error('Microsoft Store 업데이트 설치 결과가 없습니다.');
  }
  return event;
}

