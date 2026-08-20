/**
 * 모델 및 바이너리 관리 — 모델/서버 다운로드, GPU 감지, 경로 관리
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import { app } from 'electron';
import * as config from '../config';
import { log } from '../logger';
import type { GpuDetectionResult } from '../../shared/types';

const execAsync = promisify(exec);

// ── 상수 ──
export const MODEL_FILE_NAME = 'gemma-4-E2B-it-Q4_K_M.gguf';
export const MODEL_URL =
  'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf?download=true';

const LLAMA_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download/b8969';
export const BINARY_URLS: Record<string, { binary: string; cudart?: string }> = {
  'cuda-13.1': {
    binary: `${LLAMA_BASE}/llama-b8969-bin-win-cuda-13.1-x64.zip`,
    cudart: `${LLAMA_BASE}/cudart-llama-bin-win-cuda-13.1-x64.zip`,
  },
  'cuda-12.4': {
    binary: `${LLAMA_BASE}/llama-b8969-bin-win-cuda-12.4-x64.zip`,
    cudart: `${LLAMA_BASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
  },
  'vulkan': {
    binary: `${LLAMA_BASE}/llama-b8969-bin-win-vulkan-x64.zip`,
  },
  'cpu': {
    binary: `${LLAMA_BASE}/llama-b8969-bin-win-cpu-x64.zip`,
  },
};
export const LLAMA_SERVER_EXE_NAME = 'llama-server.exe';

// ── 상태 ──
let _modelDownloading = false;
let _modelProgress = 0;
let _binaryDownloading = false;

// ── 경로 ──
export function getModelPath(): string {
  return path.join(app.getPath('userData'), 'models', MODEL_FILE_NAME);
}

export function getServerBinDir(): string {
  return path.join(app.getPath('userData'), 'bin');
}

export function getServerBinaryPath(): string {
  return path.join(getServerBinDir(), LLAMA_SERVER_EXE_NAME);
}

export function getMsgerLogPath(): string | null {
  const cfg = config.load();
  if (cfg.msgerLogPath) return cfg.msgerLogPath;
  if (!cfg.chatLogPath) return null;
  return path.join(path.dirname(cfg.chatLogPath), 'MsgerLog');
}

export function getCurrentMsgerLogPath(): string {
  return getMsgerLogPath() ?? '';
}

// ── 모델 상태 ──
export function getModelStatus() {
  const modelPath = getModelPath();
  return {
    downloaded: fs.existsSync(modelPath) && fs.existsSync(getServerBinaryPath()),
    downloading: _modelDownloading || _binaryDownloading,
    progress: _modelProgress,
    modelPath,
    serverBinaryReady: fs.existsSync(getServerBinaryPath()),
  };
}

// ── 다운로드 유틸 ──
export function httpsDownload(url: string, onProgress: (pct: number, label?: string) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const doGet = (u: string, redirectsLeft = 5) => {
      if (redirectsLeft <= 0) {
        reject(new Error('Max redirects exceeded'));
        return;
      }
      https.get(u, { headers: { 'User-Agent': 'tw-overlay/1.0' } }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 307, 308].includes(status) && res.headers.location) {
          doGet(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (status !== 200) { reject(new Error(`HTTP ${status}`)); return; }

        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let received = 0;

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          received += chunk.length;
          if (total > 0) onProgress(Math.round((received / total) * 100));
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };

    doGet(url);
  });
}

export function extractZip(zipPath: string, destDir: string): Promise<void> {
  const safeZipPath = zipPath.replace(/'/g, "''");
  const safeDestDir = destDir.replace(/'/g, "''");
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${safeZipPath}' -DestinationPath '${safeDestDir}' -Force`,
    ], { stdio: 'ignore' });
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive 실패 (exit ${code})`)));
    proc.on('error', reject);
  });
}

// ── GPU 감지 ──
export async function detectGpu(): Promise<GpuDetectionResult> {
  try {
    const { stdout } = await execAsync('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"');
    const gpuNames = stdout.split('\n').map(l => l.trim()).filter(l => l && l !== 'Name');

    const nvidiaName = gpuNames.find(n => /nvidia/i.test(n));
    const amdName = gpuNames.find(n => /amd|radeon/i.test(n));
    const intelName = gpuNames.find(n => /intel/i.test(n));

    if (nvidiaName) {
      return {
        gpuType: 'nvidia', gpuName: nvidiaName,
        binaryVariant: 'cuda-12.4',
        binaryUrl: BINARY_URLS['cuda-12.4'].binary,
        cudartUrl: BINARY_URLS['cuda-12.4'].cudart,
      };
    }
    if (amdName) {
      return { gpuType: 'amd', gpuName: amdName, binaryVariant: 'vulkan', binaryUrl: BINARY_URLS['vulkan'].binary };
    }
    if (intelName) {
      return { gpuType: 'intel', gpuName: intelName, binaryVariant: 'vulkan', binaryUrl: BINARY_URLS['vulkan'].binary };
    }
  } catch (_) { }

  return { gpuType: 'none', gpuName: 'GPU 없음', binaryVariant: 'cpu', binaryUrl: BINARY_URLS['cpu'].binary };
}

// ── 모델 다운로드 ──
export async function downloadModel(onProgress: (pct: number) => void): Promise<void> {
  const modelPath = getModelPath();
  const modelDir = path.dirname(modelPath);
  if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

  _modelDownloading = true;
  _modelProgress = 0;

  try {
    if (fs.existsSync(modelPath)) {
      log('[SCAM] 모델 파일 이미 존재, 다운로드 건너뜀');
    } else {
      const tmpPath = modelPath + '.tmp';
      await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(tmpPath);
        const doGet = (url: string) => {
          https.get(url, { headers: { 'User-Agent': 'tw-overlay/1.0' } }, (res) => {
            const status = res.statusCode ?? 0;
            if ([301, 302, 307, 308].includes(status) && res.headers.location) {
              doGet(res.headers.location); return;
            }
            if (status !== 200) {
              file.close(); fs.unlink(tmpPath, () => { });
              _modelDownloading = false;
              reject(new Error(`HTTP ${status}`)); return;
            }
            const total = parseInt(res.headers['content-length'] ?? '0', 10);
            let received = 0;
            res.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (total > 0) {
                _modelProgress = Math.round((received / total) * 100);
                onProgress(_modelProgress);
              }
            });
            res.pipe(file);
            file.on('finish', () => {
              file.close(() => {
                try {
                  if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
                  fs.renameSync(tmpPath, modelPath);
                  _modelDownloading = false;
                  _modelProgress = 100;
                  resolve();
                } catch (e) { _modelDownloading = false; reject(e); }
              });
            });
            file.on('error', (err) => {
              file.close(); fs.unlink(tmpPath, () => { });
              _modelDownloading = false; reject(err);
            });
          }).on('error', (err) => {
            file.close(); fs.unlink(tmpPath, () => { });
            _modelDownloading = false; reject(err);
          });
        };
        doGet(MODEL_URL);
      });
    }

    if (!fs.existsSync(getServerBinaryPath())) {
      log('[SCAM] GPU 감지 중...');
      const gpuResult = await detectGpu();
      log(`[SCAM] GPU 감지 결과: ${gpuResult.gpuName} → ${gpuResult.binaryVariant}`);
      await downloadServerBinary(gpuResult, onProgress);
    } else {
      log('[SCAM] llama-server 바이너리 이미 존재, 다운로드 건너뜀');
    }
  } catch (e) {
    _modelDownloading = false;
    throw e;
  }
}

export async function downloadServerBinary(
  gpuResult: GpuDetectionResult,
  onProgress: (pct: number) => void,
): Promise<void> {
  const binDir = getServerBinDir();
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  _binaryDownloading = true;
  const zipPath = path.join(binDir, 'llama-server.zip');

  try {
    log(`[SCAM] llama-server 다운로드 중... (${gpuResult.binaryVariant})`);
    const buf = await httpsDownload(gpuResult.binaryUrl, onProgress);
    await fs.promises.writeFile(zipPath, buf);
    log('[SCAM] llama-server ZIP 압축 해제 중...');
    await extractZip(zipPath, binDir);
    await fs.promises.unlink(zipPath);

    if (gpuResult.cudartUrl) {
      log('[SCAM] CUDA 런타임 DLL 다운로드 중...');
      const cudartBuf = await httpsDownload(gpuResult.cudartUrl, onProgress);
      const cudartZipPath = path.join(binDir, 'cudart.zip');
      await fs.promises.writeFile(cudartZipPath, cudartBuf);
      log('[SCAM] CUDA 런타임 ZIP 압축 해제 중...');
      await extractZip(cudartZipPath, binDir);
      await fs.promises.unlink(cudartZipPath);
    }

    config.save({ scamGpuVariant: gpuResult.binaryVariant });
    log(`[SCAM] llama-server 준비 완료 (${gpuResult.binaryVariant})`);
  } finally {
    _binaryDownloading = false;
  }
}

export async function buildGpuResultForUserChoice(choice: string): Promise<GpuDetectionResult> {
  if (choice === 'nvidia') {
    return {
      gpuType: 'nvidia', gpuName: 'NVIDIA GPU',
      binaryVariant: 'cuda-12.4',
      binaryUrl: BINARY_URLS['cuda-12.4'].binary,
      cudartUrl: BINARY_URLS['cuda-12.4'].cudart,
    };
  }
  if (choice === 'amd') {
    return { gpuType: 'amd', gpuName: 'AMD GPU', binaryVariant: 'vulkan', binaryUrl: BINARY_URLS['vulkan'].binary };
  }
  if (choice === 'intel') {
    return { gpuType: 'intel', gpuName: 'Intel GPU', binaryVariant: 'vulkan', binaryUrl: BINARY_URLS['vulkan'].binary };
  }
  return { gpuType: 'none', gpuName: 'GPU 없음', binaryVariant: 'cpu', binaryUrl: BINARY_URLS['cpu'].binary };
}
