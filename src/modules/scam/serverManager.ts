/**
 * llama-server 프로세스 관리 — 서버 시작/중지, 헬스체크, LLM 호출, 직렬화 큐
 * 동시 시작 요청은 같은 준비 Promise를 공유하며 중지 시 준비·GPU 폴백도 취소한다.
 * 각 자식의 종료 이벤트는 자신이 소유한 서버 상태만 정리한다. 회귀: check-audit-regressions.ts.
 */
import * as fs from 'fs';
import * as http from 'http';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import * as config from '../config';
import * as wm from '../windowManager';
import { log } from '../logger';
import {
  getModelPath,
  getServerBinaryPath,
  recoverInterruptedServerInstall,
  verifyInstalledModel,
  verifyInstalledServerBinary,
} from './modelManager';

// ── 상수 ──
const LLAMA_SERVER_PORT = 18765;
const LLAMA_SERVER_HEALTH_TIMEOUT_MS = 60_000;
const LLAMA_SERVER_HEALTH_POLL_MS = 1_000;

// ── 상태 ──
let _serverProcess: ChildProcess | null = null;
let _serverReady = false;
let _startPromise: Promise<void> | null = null;
let _startAbort: AbortController | null = null;
let _llmQueue: Promise<void> = Promise.resolve();

// ── 프롬프트 (parser.ts에서 가져옴) ──
import { SCAM_SYSTEM_PROMPT } from './parser';

// ── 헬스체크 ──
async function waitForServerReady(signal: AbortSignal): Promise<void> {
  const url = `http://127.0.0.1:${LLAMA_SERVER_PORT}/health`;
  const deadline = Date.now() + LLAMA_SERVER_HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get(url, { signal, timeout: 2_000 }, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`));
        }).on('error', reject);
        request.on('timeout', () => request.destroy(new Error('llama-server health 요청 시간 초과')));
      });
      return;
    } catch (_) {
      signal.throwIfAborted();
      await delay(LLAMA_SERVER_HEALTH_POLL_MS, undefined, { signal });
    }
  }
  throw new Error('llama-server 준비 시간 초과');
}

// ── 프로세스 관리 ──
async function spawnServer(gpuLayers: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const binaryPath = getServerBinaryPath();
  const modelPath = getModelPath();

  log(`[SCAM] llama-server 시작 중... (GPU 레이어: ${gpuLayers})`);

  const child = spawn(binaryPath, [
    '--model', modelPath,
    '--port', String(LLAMA_SERVER_PORT),
    '--host', '127.0.0.1',
    '--ctx-size', '4096',
    '--n-gpu-layers', String(gpuLayers),
    '--threads', '4',
    '--log-disable',
  ], { stdio: 'ignore', detached: false });
  _serverProcess = child;
  const attempt = new AbortController();
  const cancelAttempt = () => attempt.abort();
  signal.addEventListener('abort', cancelAttempt, { once: true });
  const clearOwnedProcess = () => {
    attempt.abort();
    if (_serverProcess !== child) return;
    _serverReady = false;
    _serverProcess = null;
  };

  child.on('error', (err) => {
    log(`[SCAM] llama-server 오류: ${err}`);
    clearOwnedProcess();
  });

  child.on('exit', (code) => {
    log(`[SCAM] llama-server 종료 (코드: ${code})`);
    clearOwnedProcess();
  });

  try {
    await waitForServerReady(attempt.signal);
    signal.throwIfAborted();
    if (_serverProcess !== child) throw new Error('llama-server 시작이 취소되었습니다.');
  } catch (error) {
    try { child.kill(); } catch { /* 종료된 자식은 다시 종료할 필요가 없다. */ }
    clearOwnedProcess();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelAttempt);
  }
  _serverReady = true;
  log(`[SCAM] llama-server 준비 완료 (port ${LLAMA_SERVER_PORT}, GPU 레이어: ${gpuLayers})`);
}

/** 모든 세션은 동일한 시작 Promise를 기다린다. 중지된 시작 작업은 CPU 재시도를 만들지 않는다. */
export function startServer(): Promise<void> {
  if (_serverReady) return Promise.resolve();
  if (_startPromise) return _startPromise;
  const controller = new AbortController();
  _startAbort = controller;
  const pending = startServerAttempt(controller.signal).finally(() => {
    if (_startPromise !== pending) return;
    _startPromise = null;
    _startAbort = null;
  });
  _startPromise = pending;
  return pending;
}

async function startServerAttempt(signal: AbortSignal): Promise<void> {

  if (!recoverInterruptedServerInstall()) {
    throw new Error('중단된 llama-server 설치를 복구하지 못했습니다.');
  }

  const binaryPath = getServerBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error('llama-server.exe 가 없습니다. 다운로드 후 다시 시도해주세요.');
  }
  const modelPath = getModelPath();
  if (!fs.existsSync(modelPath)) {
    throw new Error('모델 파일이 없습니다. 먼저 모델을 다운로드해주세요.');
  }
  verifyInstalledServerBinary();
  verifyInstalledModel();

  const variant = config.load().scamGpuVariant ?? 'vulkan';
  if (variant === 'cpu') {
    await spawnServer(0, signal);
  } else {
    try {
      await spawnServer(99, signal);
    } catch (gpuErr) {
      signal.throwIfAborted();
      log(`[SCAM] GPU 모드 실패 (${gpuErr}), CPU 모드로 재시도...`);
      await delay(1500, undefined, { signal });
      await spawnServer(0, signal);
    }
  }
}

export function stopServer(): void {
  _startAbort?.abort();
  _startAbort = null;
  _startPromise = null;
  if (_serverProcess) {
    try { _serverProcess.kill(); } catch (_) { }
    _serverProcess = null;
  }
  _serverReady = false;
}

export function getServerStatus(sessionCount: number) {
  return {
    running: _serverProcess !== null,
    ready: _serverReady,
    pid: _serverProcess?.pid ?? null,
    activeSessions: sessionCount,
  };
}

// ── LLM 호출 ──
export async function callLlm(userMessage: string, filePath: string): Promise<string> {
  const bodyStr = JSON.stringify({
    model: 'gemma4',
    messages: [
      { role: 'system', content: SCAM_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 2048,
    temperature: 0.1,
    stream: true,
  });

  return new Promise((resolve, reject) => {
    let accumulated = '';
    let sseBuffer = '';

    const req = http.request({
      hostname: '127.0.0.1',
      port: LLAMA_SERVER_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`llama-server HTTP ${res.statusCode}`));
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const token: string = json.choices?.[0]?.delta?.content ?? '';
            if (token) {
              accumulated += token;
              wm.getScamDetectorWindow()?.webContents.send('scam-analysis-token', { filePath, token });
            }
          } catch (_) { }
        }
      });
      res.on('end', () => resolve(accumulated));
      res.on('error', reject);
    });

    req.setTimeout(120_000, () => req.destroy(new Error('llama-server 응답 시간 초과')));
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/** LLM 호출 직렬화 래퍼 */
export async function callLlmQueued(filePath: string, userMessage: string, isClosed: () => boolean): Promise<string> {
  let raw = '';
  const slot = _llmQueue.then(async () => {
    if (isClosed()) throw new Error('세션 종료됨 - LLM 건너뜀');
    raw = await callLlm(userMessage, filePath);
  });
  _llmQueue = slot.catch(() => {});
  await slot;
  return raw;
}
