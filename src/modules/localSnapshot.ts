import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { RENDERER_STORAGE_FILE, RendererStorageSnapshot, validateRendererStorageSnapshot } from '../shared/rendererStorage';

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
  rendererStorage?: RendererStorageSnapshot;
  /** Disposable SQLite online backup on the same volume. Moved into the snapshot. */
  profileDatabaseSnapshot?: string;
  /** destinationRoot가 포함되어야 하는 신뢰 경계. 기본값은 sourceRoot. */
  allowedDestinationRoot?: string;
  /**
   * 일지 엘소/금화 복구 journal도 보관한다. 프로필 이전 전 스냅샷 전용이다(수동 되돌리기에서 DB에 아직
   * 반영되지 않은 금액을 잃지 않게 함). ZIP 백업/복원 허용 목록에는 넣지 않는다: 내보내기·복원 전에는
   * flush로 journal을 DB에 반영하므로 ZIP에 담을 필요가 없고, 복원 대상 파일을 넓히지 않는다.
   */
  includeRecoveryJournals?: boolean;
}

/** diaryDb.getElsoRecoveryJournalPath / getGoldPouchRecoveryJournalPath의 파일 이름(v3.2.2와 동일). */
export const DIARY_RECOVERY_JOURNAL_ENTRIES = ['elso-recovery.json', 'gold-pouch-seed-recovery.json'] as const;

const CORE_ENTRIES = [
  'config.json',
  'diary.db',
  'diary.db-wal',
  'diary.db-shm',
  'app-data.db',
  'app-data.db-wal',
  'app-data.db-shm',
  'app-data-config-write.json',
  'custom_sounds',
  'custom_fonts'
];

const CREDENTIAL_ENTRIES = ['google_auth.enc', 'google_user.json'];
const CACHE_ENTRIES = ['eta_ranking_cache.json', 'analytics.json'];
const RESTORABLE_FILES = new Set(['config.json', 'diary.db', 'diary.db-wal', 'diary.db-shm',
  'app-data.db','app-data.db-wal','app-data.db-shm','app-data-config-write.json',RENDERER_STORAGE_FILE]);

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
    || (normalized.startsWith('custom_sounds/') && normalized.length > 'custom_sounds/'.length)
    || /^custom_fonts\/[a-f0-9]{64}\.(font|json)$/.test(normalized);
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

function requestedSnapshotEntries(resolvedSource: string, options: SnapshotOptions): string[] {
  const hasProfiles=!!options.profileDatabaseSnapshot || fs.existsSync(path.join(resolvedSource,'app-data.db'));
  return [
    ...CORE_ENTRIES.filter(entry => (!hasProfiles || !entry.startsWith('diary.db'))
      && (!options.profileDatabaseSnapshot || !['app-data.db-wal','app-data.db-shm','app-data-config-write.json'].includes(entry))),
    ...(options.includeRecoveryJournals ? DIARY_RECOVERY_JOURNAL_ENTRIES : []),
    ...(options.includeCredentials ? CREDENTIAL_ENTRIES : []),
    ...(options.includeCaches ? CACHE_ENTRIES : [])
  ];
}

function serializeRendererStorage(snapshot: RendererStorageSnapshot): string {
  return JSON.stringify(validateRendererStorageSnapshot(snapshot));
}

/**
 * 기능 계약 — 같은 원본의 검증된 스냅샷 재사용.
 * candidates 중 manifest 무결성 검증을 통과하고, 같은 reason이며, 지금 createUserDataSnapshot(sourceRoot,
 * …, options)를 실행했을 때 담길 파일 집합(상대 경로·크기·SHA-256)과 렌더러 저장소 값이 정확히 같은 첫
 * 스냅샷을 반환한다. 없으면 undefined. 앱 버전·생성 시각·missing 목록은 내용이 아니므로 비교하지 않는다.
 * 실패가 반복되는 부팅(프로필 이전 전 스냅샷)이 같은 원본의 사본을 매번 늘리지 않게 하는 용도이며,
 * 원본이 조금이라도 다르면 새 스냅샷을 만들도록 undefined를 반환한다. 손상된 후보는 건너뛴다(삭제 안 함).
 * 회귀: check-profile-backup.ts(재사용 판정·반복 실패 부팅).
 */
export function findEquivalentUserDataSnapshot(
  sourceRoot: string,
  candidates: readonly string[],
  options: SnapshotOptions
): string | undefined {
  if (options.profileDatabaseSnapshot) throw new Error('임시 DB 사본을 옮기는 스냅샷은 재사용할 수 없습니다.');
  const resolvedSource = path.resolve(sourceRoot);
  const expected = new Map<string, { size: number; sha256: string }>();
  for (const relativeRoot of requestedSnapshotEntries(resolvedSource, options)) {
    if (!fs.existsSync(path.join(resolvedSource, ensureRelativePath(relativeRoot)))) continue;
    for (const relativeFile of listFilesRecursive(resolvedSource, relativeRoot)) {
      const sourcePath = path.join(resolvedSource, relativeFile);
      expected.set(relativeFile.split(path.sep).join('/'), { size: fs.statSync(sourcePath).size, sha256: hashFile(sourcePath) });
    }
  }
  const renderer = options.rendererStorage ? validateRendererStorageSnapshot(options.rendererStorage) : undefined;
  for (const candidate of candidates) {
    try {
      const manifest = verifyUserDataSnapshot(candidate);
      if (manifest.reason !== options.reason) continue;
      const files = manifest.entries.filter(entry => entry.relativePath !== RENDERER_STORAGE_FILE);
      if (files.length !== expected.size || files.some(entry => {
        const source = expected.get(entry.relativePath);
        return !source || source.size !== entry.size || source.sha256.toLowerCase() !== entry.sha256.toLowerCase();
      })) continue;
      const hasRenderer = manifest.entries.some(entry => entry.relativePath === RENDERER_STORAGE_FILE);
      if (hasRenderer !== !!renderer) continue;
      // 렌더러 값은 키 순서가 달라도 같은 내용이면 같은 백업이다.
      if (renderer && !isDeepStrictEqual(
        validateRendererStorageSnapshot(JSON.parse(fs.readFileSync(path.join(candidate, RENDERER_STORAGE_FILE), 'utf8'))), renderer)) continue;
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
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

  const requestedEntries = requestedSnapshotEntries(resolvedSource, options);
  const entries: SnapshotEntry[] = [];
  const missing: string[] = [];

  for (const relativeRoot of requestedEntries) {
    if (relativeRoot==='app-data.db' && options.profileDatabaseSnapshot) {
      const databasePath=path.join(resolvedDestination,relativeRoot);
      fs.renameSync(options.profileDatabaseSnapshot,databasePath);
      flushFile(databasePath);
      entries.push({relativePath:relativeRoot,kind:'file',size:fs.statSync(databasePath).size,sha256:hashFile(databasePath)});
      continue;
    }
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

  if (options.rendererStorage) {
    const serialized = serializeRendererStorage(options.rendererStorage);
    const filePath = path.join(resolvedDestination, RENDERER_STORAGE_FILE);
    fs.writeFileSync(filePath, serialized, { flag: 'wx', mode: 0o600 });
    flushFile(filePath);
    entries.push({ relativePath: RENDERER_STORAGE_FILE, kind: 'file', size: fs.statSync(filePath).size, sha256: hashFile(filePath) });
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
    if (safeRelativePath === RENDERER_STORAGE_FILE) validateRendererStorageSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }
  return parsed;
}
