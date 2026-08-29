/**
 * 기능 계약 — 사기 탐지 모델·llama-server 설치
 *
 * - 모델과 실행 바이너리는 고정된 릴리즈 URL, 예상 파일 크기, SHA-256을 모두 통과한 경우에만
 *   사용합니다. 파일이 존재한다는 이유만으로 신뢰하거나 userData의 임의 EXE를 실행하지 않습니다.
 * - 다운로드는 staging에 완성한 뒤 검증된 묶음만 대상 디렉터리로 교체합니다. 교체 전 install journal과
 *   이전 버전을 보존해 중단·충돌 후 다음 시작에서 복구할 수 있어야 합니다.
 * - GPU 감지는 사용자 PC에 맞는 CUDA/Vulkan/CPU 후보를 제안할 뿐이며 최종 선택을 강제로 바꾸지
 *   않습니다. 선택 variant의 manifest와 실제 설치 파일 목록이 일치해야 서버를 실행할 수 있습니다.
 * - 모델과 바이너리는 앱 코드가 아닌 다운로드 데이터이므로 업데이트 시 기존 정상 설치를 먼저 삭제하지
 *   않습니다. 검증 실패는 설치 실패로 보고 이전 정상 버전을 계속 사용할 수 있게 합니다.
 * - 메신저 로그 원문은 이 다운로드/설치 경로에 포함되지 않으며 외부 서버로 업로드하지 않습니다.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { exec, spawn } from 'child_process';
import { app } from 'electron';
import * as config from '../config';
import { log } from '../logger';
import type { GpuDetectionResult } from '../../shared/types';

const execAsync = promisify(exec);

// ── 상수 ──
export const MODEL_FILE_NAME = 'gemma-4-E2B-it-Q4_K_M.gguf';
export const MODEL_URL =
  'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf?download=true';
const MODEL_SHA256 = '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8';
const MODEL_SIZE = 3_106_738_272;

const LLAMA_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download/b8969';
interface DownloadAsset {
  url: string;
  fileName: string;
  sha256: string;
  size: number;
}

interface BinaryAssetSet {
  binary: DownloadAsset;
  cudart?: DownloadAsset;
}

const asset = (fileName: string, sha256: string, size: number): DownloadAsset => ({
  url: `${LLAMA_BASE}/${fileName}`,
  fileName,
  sha256,
  size,
});

export const BINARY_ASSETS: Record<string, BinaryAssetSet> = {
  'cuda-13.1': {
    binary: asset('llama-b8969-bin-win-cuda-13.1-x64.zip', 'b346f07c2b46df1ce600f33d631f22bafca773ad1f9098836a8e65e652c3b12d', 134_984_815),
    cudart: asset('cudart-llama-bin-win-cuda-13.1-x64.zip', 'f96935e7e385e3b2d0189239077c10fe8fd7e95690fea4afec455b1b6c7e3f18', 402_582_216),
  },
  'cuda-12.4': {
    binary: asset('llama-b8969-bin-win-cuda-12.4-x64.zip', '6dc6a422121fdea08a096d43a9323f817bb6234d9f92ba93d8e137b525760d91', 214_546_901),
    cudart: asset('cudart-llama-bin-win-cuda-12.4-x64.zip', '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6', 391_443_627),
  },
  'vulkan': {
    binary: asset('llama-b8969-bin-win-vulkan-x64.zip', 'dc696e0808a5f6c5593acefeb384b6b90098124c7b696ebcc4527b8b598db059', 34_055_381),
  },
  'cpu': {
    binary: asset('llama-b8969-bin-win-cpu-x64.zip', 'c2b9a2d7f21fe57d6691b3dcc66d24b2762f74676ed37a0814ab7a810f54cb8f', 15_918_693),
  },
};
export const BINARY_URLS: Record<string, { binary: string; cudart?: string }> = Object.fromEntries(
  Object.entries(BINARY_ASSETS).map(([variant, assets]) => [variant, {
    binary: assets.binary.url,
    cudart: assets.cudart?.url,
  }]),
);
export const LLAMA_SERVER_EXE_NAME = 'llama-server.exe';
const SERVER_MANIFEST_FILE = 'server-install.manifest.json';
const SERVER_INSTALL_JOURNAL_FILE = 'bin-install-journal.json';
const MODEL_VERIFICATION_FILE = 'model-verification.json';

interface InstalledBinaryFile {
  name: string;
  size: number;
  sha256: string;
}

interface ServerInstallManifest {
  formatVersion: 1;
  variant: GpuDetectionResult['binaryVariant'];
  createdAt: string;
  assets: Array<Pick<DownloadAsset, 'fileName' | 'size' | 'sha256'>>;
  files: InstalledBinaryFile[];
}

interface ServerInstallJournal {
  formatVersion: 1;
  variant: GpuDetectionResult['binaryVariant'];
  hadPrevious: boolean;
  previousVariant?: GpuDetectionResult['binaryVariant'];
  stagingDir: string;
  previousDir: string;
  targetDir: string;
}

interface ModelVerificationStamp {
  formatVersion: 1;
  fileName: string;
  size: number;
  sha256: string;
  mtimeMs: number;
}

// ── 상태 ──
let _modelDownloading = false;
let _modelProgress = 0;
let _modelDownloadPromise: Promise<void> | null = null;
let _binaryDownloading = false;
let _binaryInstallPromise: Promise<void> | null = null;
let _binaryInstallVariant: GpuDetectionResult['binaryVariant'] | null = null;

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
  const modelReady = isModelFilePlausible(modelPath);
  const serverBinaryReady = isServerInstallPlausible();
  return {
    downloaded: modelReady && serverBinaryReady,
    downloading: _modelDownloading || _binaryDownloading,
    progress: _modelProgress,
    modelPath,
    serverBinaryReady,
    serverBinaryPresent: fs.existsSync(getServerBinaryPath()),
  };
}

// ── 다운로드/설치 검증 유틸 ──
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  'huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co',
]);

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function assertVerifiedFile(filePath: string, expectedSize: number, expectedHash: string): void {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size !== expectedSize || hashFile(filePath) !== expectedHash) {
    throw new Error(`다운로드 파일 무결성 검증 실패: ${path.basename(filePath)}`);
  }
}

function isModelFilePlausible(modelPath: string): boolean {
  try {
    const stat = fs.statSync(modelPath);
    return stat.isFile() && stat.size === MODEL_SIZE;
  } catch {
    return false;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

function expectedAssets(variant: string): DownloadAsset[] {
  const assetSet = BINARY_ASSETS[variant];
  if (!assetSet) throw new Error(`지원하지 않는 llama-server 변형입니다: ${variant}`);
  return [assetSet.binary, assetSet.cudart].filter((entry): entry is DownloadAsset => !!entry);
}

function isSafeBinaryName(name: string): boolean {
  return name.length > 0
    && name.length <= 255
    && path.basename(name) === name
    && ['.exe', '.dll'].includes(path.extname(name).toLowerCase());
}

function buildServerManifest(binDir: string, variant: GpuDetectionResult['binaryVariant']): ServerInstallManifest {
  const files = fs.readdirSync(binDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && isSafeBinaryName(entry.name))
    .map(entry => {
      const filePath = path.join(binDir, entry.name);
      const stat = fs.statSync(filePath);
      return { name: entry.name, size: stat.size, sha256: hashFile(filePath) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!files.some(file => file.name.toLowerCase() === LLAMA_SERVER_EXE_NAME)) {
    throw new Error('공식 ZIP에 llama-server.exe가 없습니다.');
  }
  return {
    formatVersion: 1,
    variant,
    createdAt: new Date().toISOString(),
    assets: expectedAssets(variant).map(({ fileName, size, sha256 }) => ({ fileName, size, sha256 })),
    files,
  };
}

function readServerManifest(binDir: string, variant: GpuDetectionResult['binaryVariant']): ServerInstallManifest {
  const manifestPath = path.join(binDir, SERVER_MANIFEST_FILE);
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('llama-server 설치 manifest가 유효하지 않습니다.');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<ServerInstallManifest>;
  if (parsed.formatVersion !== 1 || parsed.variant !== variant || !Array.isArray(parsed.assets) || !Array.isArray(parsed.files)) {
    throw new Error('llama-server 설치 manifest 형식이 올바르지 않습니다.');
  }
  const assets = expectedAssets(variant);
  if (parsed.assets.length !== assets.length || parsed.assets.some((entry, index) => {
    const expected = assets[index];
    return !entry || entry.fileName !== expected.fileName || entry.size !== expected.size || entry.sha256 !== expected.sha256;
  })) {
    throw new Error('llama-server 설치 manifest의 공식 자산 정보가 일치하지 않습니다.');
  }
  const names = new Set<string>();
  for (const file of parsed.files) {
    if (!file || !isSafeBinaryName(file.name) || !Number.isSafeInteger(file.size) || file.size < 0
      || !/^[a-f0-9]{64}$/i.test(file.sha256) || names.has(file.name.toLowerCase())) {
      throw new Error('llama-server 설치 manifest의 파일 정보가 올바르지 않습니다.');
    }
    names.add(file.name.toLowerCase());
  }
  if (!names.has(LLAMA_SERVER_EXE_NAME)) throw new Error('설치 manifest에 llama-server.exe가 없습니다.');
  return parsed as ServerInstallManifest;
}

function writeModelVerificationStamp(modelPath: string): void {
  const stat = fs.statSync(modelPath);
  const stamp: ModelVerificationStamp = {
    formatVersion: 1,
    fileName: MODEL_FILE_NAME,
    size: MODEL_SIZE,
    sha256: MODEL_SHA256,
    mtimeMs: stat.mtimeMs,
  };
  writeJsonAtomic(path.join(path.dirname(modelPath), MODEL_VERIFICATION_FILE), stamp);
}

/** 크기·수정시각이 바뀌면 3GB 모델을 다시 해시하고, 정상 결과만 캐시한다. */
export function verifyInstalledModel(): void {
  const modelPath = getModelPath();
  const stat = fs.statSync(modelPath);
  if (!stat.isFile() || stat.size !== MODEL_SIZE) throw new Error('AI 모델 파일 크기가 공식 manifest와 다릅니다.');
  const stampPath = path.join(path.dirname(modelPath), MODEL_VERIFICATION_FILE);
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf-8')) as Partial<ModelVerificationStamp>;
    if (stamp.formatVersion === 1 && stamp.fileName === MODEL_FILE_NAME && stamp.size === MODEL_SIZE
      && stamp.sha256 === MODEL_SHA256 && stamp.mtimeMs === stat.mtimeMs) return;
  } catch {}
  assertVerifiedFile(modelPath, MODEL_SIZE, MODEL_SHA256);
  writeModelVerificationStamp(modelPath);
  log('[SCAM] AI 모델 실행 전 무결성 확인 완료');
}

function downloadVerifiedFile(
  url: string,
  destinationPath: string,
  expectedSize: number,
  expectedHash: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tempPath = `${destinationPath}.download`;
    const fail = (error: unknown) => {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      reject(error);
    };
    const doGet = (candidate: string, redirectsLeft: number) => {
      let parsed: URL;
      try { parsed = new URL(candidate); } catch { fail(new Error('다운로드 URL이 올바르지 않습니다.')); return; }
      if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
        fail(new Error(`허용되지 않은 다운로드 호스트입니다: ${parsed.hostname}`));
        return;
      }
      const request = https.get(parsed, { headers: { 'User-Agent': 'tw-overlay/3.0' } }, response => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) { fail(new Error('다운로드 redirect 한도를 초과했습니다.')); return; }
          doGet(new URL(response.headers.location, parsed).href, redirectsLeft - 1);
          return;
        }
        if (status !== 200) { response.resume(); fail(new Error(`HTTP ${status}`)); return; }
        const contentLength = Number(response.headers['content-length'] || 0);
        if (contentLength > 0 && contentLength !== expectedSize) {
          response.destroy();
          fail(new Error('다운로드 파일 크기가 공식 manifest와 다릅니다.'));
          return;
        }
        const file = fs.createWriteStream(tempPath, { flags: 'w', mode: 0o600 });
        const hash = crypto.createHash('sha256');
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > expectedSize) response.destroy(new Error('다운로드 최대 크기를 초과했습니다.'));
          hash.update(chunk);
          onProgress(Math.min(100, Math.round((received / expectedSize) * 100)));
        });
        response.pipe(file);
        response.on('error', fail);
        file.on('error', fail);
        file.on('finish', () => {
          file.close(() => {
            try {
              if (received !== expectedSize || hash.digest('hex') !== expectedHash) {
                throw new Error('다운로드 SHA-256 검증에 실패했습니다.');
              }
              const fd = fs.openSync(tempPath, 'r+');
              try {
                fs.fsyncSync(fd);
              } finally {
                fs.closeSync(fd);
              }
              fs.renameSync(tempPath, destinationPath);
              resolve();
            } catch (error) { fail(error); }
          });
        });
      });
      request.setTimeout(120_000, () => request.destroy(new Error('다운로드 요청 시간이 초과되었습니다.')));
      request.on('error', fail);
    };
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    doGet(url, 5);
  });
}

function runTarExtract(archivePath: string, destinationPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar.exe', ['-xf', archivePath, '-C', destinationPath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk.slice(0, 8_192 - stderr.length);
    });
    child.once('error', error => reject(new Error(`Windows tar 실행 실패: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`공식 ZIP 압축 해제 실패 (exit=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`));
    });
  });
}

function inspectExtractedTree(rootPath: string): void {
  let entryCount = 0;
  let totalSize = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entryCount++;
      if (entryCount > 20_000) throw new Error('공식 ZIP 항목 수가 허용 범위를 초과했습니다.');
      const childPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(childPath);
      if (stat.isSymbolicLink()) throw new Error(`공식 ZIP에 재분석 지점이 포함되어 있습니다: ${entry.name}`);
      if (stat.isDirectory()) walk(childPath);
      else if (stat.isFile()) {
        totalSize += stat.size;
        if (totalSize > 4 * 1024 * 1024 * 1024) throw new Error('공식 ZIP 압축 해제 크기가 허용 범위를 초과했습니다.');
      } else {
        throw new Error(`공식 ZIP에 일반 파일이 아닌 항목이 있습니다: ${entry.name}`);
      }
    }
  };
  walk(rootPath);
}

/** tar 별도 프로세스로 스트리밍 해제하여 Electron 메인 프로세스에 대용량 Buffer를 만들지 않는다. */
async function extractArchiveBinaries(archivePath: string, stagingDir: string): Promise<void> {
  const extractRoot = fs.mkdtempSync(path.join(stagingDir, '.extract-'));
  try {
    await runTarExtract(archivePath, extractRoot);
    inspectExtractedTree(extractRoot);
    for (const entry of fs.readdirSync(extractRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !isSafeBinaryName(entry.name)) continue;
      const sourcePath = path.join(extractRoot, entry.name);
      const destinationPath = path.join(stagingDir, entry.name);
      if (fs.existsSync(destinationPath)) {
        if (fs.statSync(sourcePath).size !== fs.statSync(destinationPath).size
          || hashFile(sourcePath) !== hashFile(destinationPath)) {
          throw new Error(`공식 ZIP 사이에 이름이 같은 다른 바이너리가 있습니다: ${entry.name}`);
        }
        continue;
      }
      fs.renameSync(sourcePath, destinationPath);
    }
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
}

function verifyServerDirectory(binDir: string, variant: GpuDetectionResult['binaryVariant']): void {
  const manifest = readServerManifest(binDir, variant);
  const expected = new Map(manifest.files.map(file => [file.name.toLowerCase(), file]));
  for (const file of manifest.files) {
    const installedPath = path.join(binDir, file.name);
    const stat = fs.lstatSync(installedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || hashFile(installedPath) !== file.sha256) {
      throw new Error(`설치된 llama-server 파일 검증 실패: ${file.name}`);
    }
  }
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`설치 디렉터리에 재분석 지점이 있습니다: ${entry.name}`);
    if (entry.isFile() && isSafeBinaryName(entry.name) && !expected.has(entry.name.toLowerCase())) {
      throw new Error(`설치 디렉터리에 허용되지 않은 실행 파일이 있습니다: ${entry.name}`);
    }
  }
}

function isServerInstallPlausible(): boolean {
  try {
    const binDir = getServerBinDir();
    const manifest = readServerManifest(binDir, config.load().scamGpuVariant ?? 'vulkan');
    return manifest.files.every(file => {
      const stat = fs.lstatSync(path.join(binDir, file.name));
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === file.size;
    });
  } catch {
    return false;
  }
}

export function verifyInstalledServerBinary(): void {
  verifyServerDirectory(getServerBinDir(), config.load().scamGpuVariant ?? 'vulkan');
}

function isDirectChildWithPrefix(rootPath: string, candidatePath: string, prefix: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return path.dirname(candidate) === root && path.basename(candidate).startsWith(prefix);
}

function removeInstallDirectory(directoryPath: string, userDataPath: string, prefix: string): void {
  if (fs.existsSync(directoryPath) && isDirectChildWithPrefix(userDataPath, directoryPath, prefix)) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
}

function getServerInstallJournalPath(): string {
  return path.join(app.getPath('userData'), SERVER_INSTALL_JOURNAL_FILE);
}

function readServerInstallJournal(): ServerInstallJournal | null {
  const journalPath = getServerInstallJournalPath();
  if (!fs.existsSync(journalPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as Partial<ServerInstallJournal>;
  const userDataPath = app.getPath('userData');
  if (parsed.formatVersion !== 1 || typeof parsed.variant !== 'string' || !BINARY_ASSETS[parsed.variant]
    || typeof parsed.hadPrevious !== 'boolean'
    || typeof parsed.stagingDir !== 'string' || typeof parsed.previousDir !== 'string'
    || typeof parsed.targetDir !== 'string' || path.resolve(parsed.targetDir) !== path.resolve(getServerBinDir())
    || !isDirectChildWithPrefix(userDataPath, parsed.stagingDir, 'bin-install-')
    || !isDirectChildWithPrefix(userDataPath, parsed.previousDir, 'bin-previous-')
    || (parsed.previousVariant !== undefined && !BINARY_ASSETS[parsed.previousVariant])) {
    throw new Error('AI 바이너리 설치 journal 경로가 올바르지 않습니다.');
  }
  return parsed as ServerInstallJournal;
}

/** 설치 중 강제 종료가 발생했으면 검증된 새 설치를 완료하거나 기존 bin을 복원한다. */
export function recoverInterruptedServerInstall(): boolean {
  const journalPath = getServerInstallJournalPath();
  if (!fs.existsSync(journalPath)) return true;
  const userDataPath = app.getPath('userData');
  let journal: ServerInstallJournal;
  try {
    const parsed = readServerInstallJournal();
    if (!parsed) return true;
    journal = parsed;
  } catch (error) {
    log(`[SCAM] 중단된 AI 설치 journal 검증 실패: ${error instanceof Error ? error.message : String(error)}`);
    try {
      fs.renameSync(journalPath, `${journalPath}.corrupt-${Date.now()}`);
      return true;
    } catch {
      return false;
    }
  }

  try {
    if (fs.existsSync(journal.targetDir)) {
      let newInstallCommitted = false;
      try {
        verifyServerDirectory(journal.targetDir, journal.variant);
        if (config.load().scamGpuVariant !== journal.variant
          && !config.saveImmediate({ scamGpuVariant: journal.variant })) {
          throw new Error('복구한 GPU 변형 설정을 저장하지 못했습니다.');
        }
        newInstallCommitted = true;
      } catch (error) {
        log(`[SCAM] 중단된 새 AI 설치를 폐기하고 이전 설치를 복원합니다: ${error}`);
      }
      if (newInstallCommitted) {
        let cleanupComplete = true;
        try {
          removeInstallDirectory(journal.previousDir, userDataPath, 'bin-previous-');
          removeInstallDirectory(journal.stagingDir, userDataPath, 'bin-install-');
        } catch (cleanupError) {
          cleanupComplete = false;
          log(`[SCAM] 완료된 AI 설치의 이전 파일 정리를 다음 실행으로 미룹니다: ${cleanupError}`);
        }
        if (cleanupComplete) {
          try {
            fs.rmSync(journalPath, { force: true });
          } catch (cleanupError) {
            log(`[SCAM] 완료된 AI 설치 journal 정리를 다음 실행으로 미룹니다: ${cleanupError}`);
          }
        }
        log(`[SCAM] 중단된 AI 설치를 완료했습니다. (${journal.variant})`);
        return true;
      }
      if (fs.existsSync(journal.previousDir) || !journal.hadPrevious) {
        fs.rmSync(journal.targetDir, { recursive: true, force: true });
      } else {
        // journal 기록 직후, 기존 bin 이동 전에 종료된 경우에는 기존 설치를 보존한다.
        if (journal.previousVariant !== undefined
          && config.load().scamGpuVariant !== journal.previousVariant
          && !config.saveImmediate({ scamGpuVariant: journal.previousVariant })) {
          throw new Error('보존한 이전 GPU 변형 설정을 복원하지 못했습니다.');
        }
        removeInstallDirectory(journal.stagingDir, userDataPath, 'bin-install-');
        fs.rmSync(journalPath, { force: true });
        return true;
      }
    }

    if (fs.existsSync(journal.previousDir)) {
      fs.renameSync(journal.previousDir, journal.targetDir);
      if (journal.previousVariant !== undefined
        && config.load().scamGpuVariant !== journal.previousVariant
        && !config.saveImmediate({ scamGpuVariant: journal.previousVariant })) {
        throw new Error('이전 GPU 변형 설정을 복원하지 못했습니다.');
      }
      log('[SCAM] 중단된 AI 설치에서 이전 바이너리를 복원했습니다.');
    }
    removeInstallDirectory(journal.stagingDir, userDataPath, 'bin-install-');
    fs.rmSync(journalPath, { force: true });
    return true;
  } catch (error) {
    log(`[SCAM] 중단된 AI 설치 복구 실패: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
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
  if (_modelDownloadPromise) return _modelDownloadPromise;
  const download = async () => {
    if (!recoverInterruptedServerInstall()) throw new Error('중단된 AI 바이너리 설치를 복구하지 못했습니다.');
    const modelPath = getModelPath();
    const modelDir = path.dirname(modelPath);
    if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

    _modelDownloading = true;
    _modelProgress = 0;

    try {
      if (fs.existsSync(modelPath)) {
        try {
          assertVerifiedFile(modelPath, MODEL_SIZE, MODEL_SHA256);
          writeModelVerificationStamp(modelPath);
          log('[SCAM] 모델 파일 무결성 확인 완료');
        } catch {
          fs.rmSync(modelPath, { force: true });
          fs.rmSync(path.join(modelDir, MODEL_VERIFICATION_FILE), { force: true });
        }
      }
      if (!fs.existsSync(modelPath)) {
        const tmpPath = `${modelPath}.verified`;
        fs.rmSync(tmpPath, { force: true });
        await downloadVerifiedFile(MODEL_URL, tmpPath, MODEL_SIZE, MODEL_SHA256, pct => {
          _modelProgress = pct;
          onProgress(pct);
        });
        fs.renameSync(tmpPath, modelPath);
        writeModelVerificationStamp(modelPath);
        _modelProgress = 100;
        log('[SCAM] 모델 파일 SHA-256 검증 완료');
      }

      let serverNeedsInstall = !fs.existsSync(getServerBinaryPath());
      if (!serverNeedsInstall) {
        try {
          verifyInstalledServerBinary();
        } catch (error) {
          serverNeedsInstall = true;
          log(`[SCAM] 기존 llama-server 재검증 실패, 공식 바이너리로 교체합니다: ${error}`);
        }
      }
      if (serverNeedsInstall) {
        log('[SCAM] GPU 감지 중...');
        const gpuResult = await detectGpu();
        log(`[SCAM] GPU 감지 결과: ${gpuResult.gpuName} → ${gpuResult.binaryVariant}`);
        await downloadServerBinary(gpuResult, onProgress);
      } else {
        log('[SCAM] llama-server 바이너리 이미 존재, 다운로드 건너뜀');
      }
    } finally {
      _modelDownloading = false;
    }
  };
  _modelDownloadPromise = download().finally(() => { _modelDownloadPromise = null; });
  return _modelDownloadPromise;
}

export async function downloadServerBinary(
  gpuResult: GpuDetectionResult,
  onProgress: (pct: number) => void,
): Promise<void> {
  const requestedVariant = gpuResult.binaryVariant;
  if (_binaryInstallPromise) {
    if (_binaryInstallVariant !== requestedVariant) {
      throw new Error(`다른 GPU용 llama-server 설치가 진행 중입니다: ${String(_binaryInstallVariant)}`);
    }
    return _binaryInstallPromise;
  }
  _binaryInstallVariant = requestedVariant;
  const install = async () => {
    if (!recoverInterruptedServerInstall()) throw new Error('중단된 AI 바이너리 설치를 복구하지 못했습니다.');
    const variant = requestedVariant;
    const assetSet = BINARY_ASSETS[variant];
    if (!assetSet) throw new Error(`지원하지 않는 llama-server 변형입니다: ${variant}`);
    const userDataPath = app.getPath('userData');
    const binDir = getServerBinDir();
    const stagingDir = path.join(userDataPath, `bin-install-${process.pid}-${Date.now()}`);
    const archiveDir = path.join(stagingDir, '.downloads');
    const previousDir = path.join(userDataPath, `bin-previous-${process.pid}-${Date.now()}`);
    const journalPath = getServerInstallJournalPath();
    const hadPrevious = fs.existsSync(binDir);
    const previousVariant = hadPrevious ? config.load().scamGpuVariant : undefined;
    let journalWritten = false;
    let promoted = false;
    _binaryDownloading = true;
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const downloadAsset of expectedAssets(variant)) {
        log(`[SCAM] 공식 바이너리 다운로드 및 검증 중: ${downloadAsset.fileName}`);
        const archivePath = path.join(archiveDir, downloadAsset.fileName);
        await downloadVerifiedFile(
          downloadAsset.url,
          archivePath,
          downloadAsset.size,
          downloadAsset.sha256,
          onProgress,
        );
        await extractArchiveBinaries(archivePath, stagingDir);
      }
      fs.rmSync(archiveDir, { recursive: true, force: true });
      writeJsonAtomic(path.join(stagingDir, SERVER_MANIFEST_FILE), buildServerManifest(stagingDir, variant));
      verifyServerDirectory(stagingDir, variant);

      const journal: ServerInstallJournal = {
        formatVersion: 1,
        variant,
        hadPrevious,
        ...(previousVariant ? { previousVariant } : {}),
        stagingDir,
        previousDir,
        targetDir: binDir,
      };
      writeJsonAtomic(journalPath, journal);
      journalWritten = true;
      if (hadPrevious) fs.renameSync(binDir, previousDir);
      try {
        fs.renameSync(stagingDir, binDir);
        promoted = true;
        if (!config.saveImmediate({ scamGpuVariant: variant })) {
          throw new Error('설치된 GPU 변형 설정을 저장하지 못했습니다.');
        }
        let previousCleanupComplete = true;
        try {
          removeInstallDirectory(previousDir, userDataPath, 'bin-previous-');
        } catch (cleanupError) {
          previousCleanupComplete = false;
          log(`[SCAM] 이전 AI 바이너리 정리를 다음 실행으로 미룹니다: ${cleanupError}`);
        }
        if (previousCleanupComplete) {
          try {
            fs.rmSync(journalPath, { force: true });
          } catch (cleanupError) {
            log(`[SCAM] AI 설치 journal 정리를 다음 실행으로 미룹니다: ${cleanupError}`);
          }
        }
        journalWritten = fs.existsSync(journalPath);
      } catch (error) {
        try {
          if (promoted && fs.existsSync(binDir)) fs.rmSync(binDir, { recursive: true, force: true });
          if (fs.existsSync(previousDir) && !fs.existsSync(binDir)) fs.renameSync(previousDir, binDir);
          if (previousVariant !== undefined && config.load().scamGpuVariant !== previousVariant
            && !config.saveImmediate({ scamGpuVariant: previousVariant })) {
            throw new Error('이전 GPU 변형 설정 롤백에 실패했습니다.');
          }
          fs.rmSync(journalPath, { force: true });
          journalWritten = false;
        } catch (rollbackError) {
          log(`[SCAM] AI 바이너리 설치 롤백 실패, 다음 실행에서 재시도합니다: ${rollbackError}`);
        }
        throw error;
      }
      log(`[SCAM] llama-server 검증·원자 설치 완료 (${variant})`);
    } finally {
      _binaryDownloading = false;
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      // journal이 남아 있으면 previous/bin 상태를 보존하여 다음 시작에서 복구한다.
      if (!journalWritten) removeInstallDirectory(previousDir, userDataPath, 'bin-previous-');
    }
  };
  _binaryInstallPromise = install().finally(() => {
    _binaryInstallPromise = null;
    _binaryInstallVariant = null;
  });
  return _binaryInstallPromise;
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
