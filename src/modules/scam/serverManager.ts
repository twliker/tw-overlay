/**
 * llama-server 프로세스 관리 — 서버 시작/중지, 헬스체크, LLM 호출, 직렬화 큐
 */
import * as fs from 'fs';
import * as http from 'http';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as config from '../config';
import * as wm from '../windowManager';
import { log } from '../logger';
import { getModelPath, getServerBinaryPath } from './modelManager';

// ── 상수 ──
const LLAMA_SERVER_PORT = 18765;
const LLAMA_SERVER_HEALTH_TIMEOUT_MS = 60_000;
const LLAMA_SERVER_HEALTH_POLL_MS = 1_000;

// ── 상태 ──
let _serverProcess: ChildProcess | null = null;
let _serverReady = false;
let _llmQueue: Promise<void> = Promise.resolve();

// ── 프롬프트 (parser.ts에서 가져옴) ──
import { SCAM_SYSTEM_PROMPT } from './parser';

// ── 헬스체크 ──
async function waitForServerReady(): Promise<void> {
  const url = `http://127.0.0.1:${LLAMA_SERVER_PORT}/health`;
  const deadline = Date.now() + LLAMA_SERVER_HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        http.get(url, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`));
        }).on('error', reject);
      });
      return;
    } catch (_) {
      await new Promise(r => setTimeout(r, LLAMA_SERVER_HEALTH_POLL_MS));
    }
  }
  throw new Error('llama-server 준비 시간 초과');
}

// ── 프로세스 관리 ──
async function spawnServer(gpuLayers: number): Promise<void> {
  const binaryPath = getServerBinaryPath();
  const modelPath = getModelPath();

  log(`[SCAM] llama-server 시작 중... (GPU 레이어: ${gpuLayers})`);

  _serverProcess = spawn(binaryPath, [
    '--model', modelPath,
    '--port', String(LLAMA_SERVER_PORT),
    '--host', '127.0.0.1',
    '--ctx-size', '4096',
    '--n-gpu-layers', String(gpuLayers),
    '--threads', '4',
    '--log-disable',
  ], { stdio: 'ignore', detached: false });

  _serverProcess.on('error', (err) => {
    log(`[SCAM] llama-server 오류: ${err}`);
    _serverReady = false;
    _serverProcess = null;
  });

  _serverProcess.on('exit', (code) => {
    log(`[SCAM] llama-server 종료 (코드: ${code})`);
    _serverReady = false;
    _serverProcess = null;
  });

  await waitForServerReady();
  _serverReady = true;
  log(`[SCAM] llama-server 준비 완료 (port ${LLAMA_SERVER_PORT}, GPU 레이어: ${gpuLayers})`);
}

export async function startServer(): Promise<void> {
  if (_serverReady) return;

  const binaryPath = getServerBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error('llama-server.exe 가 없습니다. 다운로드 후 다시 시도해주세요.');
  }
  const modelPath = getModelPath();
  if (!fs.existsSync(modelPath)) {
    throw new Error('모델 파일이 없습니다. 먼저 모델을 다운로드해주세요.');
  }

  const variant = config.load().scamGpuVariant ?? 'vulkan';
  if (variant === 'cpu') {
    await spawnServer(0);
  } else {
    try {
      await spawnServer(99);
    } catch (gpuErr) {
      log(`[SCAM] GPU 모드 실패 (${gpuErr}), CPU 모드로 재시도...`);
      stopServer();
      await new Promise(r => setTimeout(r, 1500));
      await spawnServer(0);
    }
  }
}

export function stopServer(): void {
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
