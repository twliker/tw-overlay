import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface SnapshotEntry {
  relativePath: string;
  kind: 'file';
  size: number;
  sha256: string;
}

export interface SnapshotManifest {
  formatVersion: 1;
  reason: string;
  appVersion: string;
  createdAt: string;
  sourcePath: string;
  entries: SnapshotEntry[];
  missing: string[];
}

export interface SnapshotOptions {
  reason: string;
  appVersion: string;
  includeCredentials?: boolean;
  includeCaches?: boolean;
  /** destinationRoot가 포함되어야 하는 신뢰 경계. 기본값은 sourceRoot. */
  allowedDestinationRoot?: string;
}

const CORE_ENTRIES = [
  'config.json',
  'diary.db',
  'diary.db-wal',
  'diary.db-shm',
  'custom_sounds'
];

const CREDENTIAL_ENTRIES = ['google_auth.enc', 'google_user.json'];
const CACHE_ENTRIES = ['eta_ranking_cache.json', 'analytics.json'];
const RESTORABLE_FILES = new Set(['config.json', 'diary.db', 'diary.db-wal', 'diary.db-shm']);

function ensureRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (!relativePath || normalized === '.' || path.isAbsolute(normalized)
    || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`스냅샷 경로 이탈이 감지되었습니다: ${relativePath}`);
  }
  return normalized;
}

export function isRestorableSnapshotPath(relativePath: string): boolean {
  const normalized = ensureRelativePath(relativePath).split(path.sep).join('/');
  return RESTORABLE_FILES.has(normalized)
    || (normalized.startsWith('custom_sounds/') && normalized.length > 'custom_sounds/'.length);
}

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

function flushFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function copyVerifiedFile(sourceRoot: string, destinationRoot: string, relativePath: string): SnapshotEntry {
  const safeRelativePath = ensureRelativePath(relativePath);
  const sourcePath = path.join(sourceRoot, safeRelativePath);
  const destinationPath = path.join(destinationRoot, safeRelativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  flushFile(destinationPath);

  const sourceStat = fs.statSync(sourcePath);
  const destinationStat = fs.statSync(destinationPath);
  const sourceHash = hashFile(sourcePath);
  const destinationHash = hashFile(destinationPath);
  if (sourceStat.size !== destinationStat.size || sourceHash !== destinationHash) {
    throw new Error(`스냅샷 복사 검증 실패: ${safeRelativePath}`);
  }

  return {
    relativePath: safeRelativePath.split(path.sep).join('/'),
    kind: 'file',
    size: destinationStat.size,
    sha256: destinationHash
  };
}

function listFilesRecursive(rootPath: string, relativeRoot: string): string[] {
  const safeRelativeRoot = ensureRelativePath(relativeRoot);
  const absoluteRoot = path.join(rootPath, safeRelativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const stat = fs.statSync(absoluteRoot);
  if (stat.isFile()) return [safeRelativeRoot];
  if (!stat.isDirectory()) return [];

  const result: string[] = [];
  const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
    for (const dirent of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absoluteChild = path.join(absoluteDirectory, dirent.name);
      const relativeChild = path.join(relativeDirectory, dirent.name);
      if (dirent.isDirectory()) walk(absoluteChild, relativeChild);
      else if (dirent.isFile()) result.push(relativeChild);
    }
  };
  walk(absoluteRoot, safeRelativeRoot);
  return result.sort();
}

function writeManifestAtomic(destinationRoot: string, manifest: SnapshotManifest): void {
  const manifestPath = path.join(destinationRoot, 'snapshot.manifest.json');
  const tempPath = `${manifestPath}.tmp`;
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, manifestPath);
}

/**
 * config와 SQLite DB(+WAL/SHM)를 같은 시점의 검증 가능한 파일 집합으로 복사한다.
 * 호출자는 DB가 열려 있으면 먼저 메모리 flush와 WAL checkpoint를 수행해야 한다.
 */
export function createUserDataSnapshot(
  sourceRoot: string,
  destinationRoot: string,
  options: SnapshotOptions
): SnapshotManifest {
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedDestination = path.resolve(destinationRoot);
  const resolvedAllowedDestinationRoot = path.resolve(options.allowedDestinationRoot || sourceRoot);
  if (
    resolvedSource === resolvedDestination
    || (
      resolvedDestination !== resolvedAllowedDestinationRoot
      && !resolvedDestination.startsWith(`${resolvedAllowedDestinationRoot}${path.sep}`)
    )
  ) {
    // 백업은 호출자가 지정한 신뢰 경계의 명시적인 하위 경로에만 생성한다.
    throw new Error(`허용되지 않은 스냅샷 대상 경로입니다: ${resolvedDestination}`);
  }
  if (fs.existsSync(resolvedDestination)) {
    throw new Error(`스냅샷 대상이 이미 존재합니다: ${resolvedDestination}`);
  }
  fs.mkdirSync(resolvedDestination, { recursive: true });

  const requestedEntries = [
    ...CORE_ENTRIES,
    ...(options.includeCredentials ? CREDENTIAL_ENTRIES : []),
    ...(options.includeCaches ? CACHE_ENTRIES : [])
  ];
  const entries: SnapshotEntry[] = [];
  const missing: string[] = [];

  for (const relativeRoot of requestedEntries) {
    const sourcePath = path.join(resolvedSource, ensureRelativePath(relativeRoot));
    if (!fs.existsSync(sourcePath)) {
      missing.push(relativeRoot);
      continue;
    }
    const files = listFilesRecursive(resolvedSource, relativeRoot);
    if (files.length === 0 && fs.statSync(sourcePath).isDirectory()) continue;
    for (const relativeFile of files) {
      entries.push(copyVerifiedFile(resolvedSource, resolvedDestination, relativeFile));
    }
  }

  const manifest: SnapshotManifest = {
    formatVersion: 1,
    reason: options.reason,
    appVersion: options.appVersion,
    createdAt: new Date().toISOString(),
    // 외부로 내보내는 수동 백업에도 사용자명/절대 경로가 노출되지 않도록 basename만 기록한다.
    sourcePath: path.basename(resolvedSource),
    entries,
    missing
  };
  writeManifestAtomic(resolvedDestination, manifest);
  return manifest;
}

export function verifyUserDataSnapshot(
  snapshotRoot: string,
  options: { enforceRestoreAllowlist?: boolean } = {},
): SnapshotManifest {
  const manifestPath = path.join(snapshotRoot, 'snapshot.manifest.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SnapshotManifest;
  if (parsed.formatVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('지원하지 않는 스냅샷 매니페스트입니다.');
  }
  const destinations = new Set<string>();
  for (const entry of parsed.entries) {
    if (!entry || entry.kind !== 'file' || typeof entry.relativePath !== 'string'
      || entry.relativePath.length > 1_024
      || (options.enforceRestoreAllowlist && !isRestorableSnapshotPath(entry.relativePath))
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`허용되지 않은 스냅샷 항목입니다: ${entry?.relativePath || '(알 수 없음)'}`);
    }
    const safeRelativePath = ensureRelativePath(entry.relativePath);
    const destinationKey = safeRelativePath.split(path.sep).join('/').toLowerCase();
    if (destinations.has(destinationKey)) {
      throw new Error(`스냅샷 대상 경로가 중복되었습니다: ${entry.relativePath}`);
    }
    destinations.add(destinationKey);
    const filePath = path.join(snapshotRoot, safeRelativePath);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`스냅샷 항목이 일반 파일이 아닙니다: ${entry.relativePath}`);
    }
    if (stat.size !== entry.size || hashFile(filePath) !== entry.sha256) {
      throw new Error(`스냅샷 무결성 검증 실패: ${entry.relativePath}`);
    }
  }
  return parsed;
}
