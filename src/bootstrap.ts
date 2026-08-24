/**
 * 애플리케이션 초기 부트스트랩
 * 1. app.name을 'twOverlay'로 조기 통일
 * 2. 표준 userData 경로 설정
 * 3. 비파괴 레거시 마이그레이션 및 v3 진입 전 검증 스냅샷
 */
import { app } from 'electron';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { createUserDataSnapshot, verifyUserDataSnapshot } from './modules/localSnapshot';

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function atomicWriteText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyFileVerified(sourcePath: string, destinationPath: string): void {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  if (fs.statSync(sourcePath).size !== fs.statSync(destinationPath).size || hashFile(sourcePath) !== hashFile(destinationPath)) {
    throw new Error(`복사 검증 실패: ${sourcePath}`);
  }
}

function isV3OrLater(version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] || '', 10);
  return Number.isFinite(major) && major >= 3;
}

function markSnapshotComplete(backupDirectory: string, appVersion: string): void {
  atomicWriteText(path.join(backupDirectory, 'backup.done'), JSON.stringify({
    completedAt: new Date().toISOString(),
    appVersion
  }, null, 2));
}

/** 실제 v3 이상 실행에서만 1회 생성하며 manifest 검증이 끝난 뒤 완료 표식을 쓴다. */
function backupPreV3UserData(standardUserDataPath: string, appVersion: string): void {
  if (!isV3OrLater(appVersion)) return;

  const backupsRoot = path.join(standardUserDataPath, 'backups');
  const backupDirectory = path.join(backupsRoot, 'pre-v3.0.0');
  const completionFile = path.join(backupDirectory, 'backup.done');

  if (fs.existsSync(backupDirectory)) {
    try {
      verifyUserDataSnapshot(backupDirectory);
      if (!fs.existsSync(completionFile)) markSnapshotComplete(backupDirectory, appVersion);
      return;
    } catch {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-');
      const incompleteDirectory = path.join(backupsRoot, `pre-v3.0.0.incomplete-${suffix}`);
      if (!isPathInside(backupsRoot, backupDirectory) || !isPathInside(backupsRoot, incompleteDirectory)) {
        throw new Error('v3 백업 경로 검증에 실패했습니다.');
      }
      fs.renameSync(backupDirectory, incompleteDirectory);
    }
  }

  const stagingDirectory = path.join(backupsRoot, `pre-v3.0.0.staging-${process.pid}-${Date.now()}`);
  createUserDataSnapshot(standardUserDataPath, stagingDirectory, {
    reason: 'pre-v3.0.0',
    appVersion,
    includeCredentials: true
  });
  verifyUserDataSnapshot(stagingDirectory);
  fs.renameSync(stagingDirectory, backupDirectory);
  markSnapshotComplete(backupDirectory, appVersion);
}

interface LegacyMigrationResult {
  completedAt: string;
  sourcePath: string;
  sourceSnapshot: string;
  copied: string[];
  identical: string[];
  conflicts: string[];
}

function listFilesRecursive(rootPath: string): string[] {
  const result: string[] = [];
  const walk = (directory: string, relativeDirectory: string): void => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      const absoluteChild = path.join(directory, dirent.name);
      const relativeChild = path.join(relativeDirectory, dirent.name);
      if (dirent.isDirectory()) walk(absoluteChild, relativeChild);
      else if (dirent.isFile()) result.push(relativeChild);
    }
  };
  walk(rootPath, '');
  return result.sort();
}

function copyLegacyDirectoryWithoutOverwrite(
  sourceDirectory: string,
  destinationDirectory: string,
  result: LegacyMigrationResult,
  label: string
): void {
  fs.mkdirSync(destinationDirectory, { recursive: true });
  for (const relativePath of listFilesRecursive(sourceDirectory)) {
    const sourcePath = path.join(sourceDirectory, relativePath);
    const destinationPath = path.join(destinationDirectory, relativePath);
    const entryLabel = `${label}/${relativePath.split(path.sep).join('/')}`;
    if (!fs.existsSync(destinationPath)) {
      copyFileVerified(sourcePath, destinationPath);
      result.copied.push(entryLabel);
    } else if (fs.statSync(destinationPath).isFile() && hashFile(sourcePath) === hashFile(destinationPath)) {
      result.identical.push(entryLabel);
    } else {
      result.conflicts.push(entryLabel);
    }
  }
}

/**
 * 레거시 원본을 먼저 검증 스냅샷으로 보존한 뒤 없는 파일만 복사한다.
 * 충돌 원본은 스냅샷에 남기고 표준 경로를 덮지 않으며 레거시 원본도 삭제하지 않는다.
 */
function migrateLegacyUserData(appData: string, standardUserDataPath: string, appVersion: string): void {
  const legacyPath = path.join(appData, 'tw-overlay');
  if (!fs.existsSync(legacyPath)) return;

  const markerPath = path.join(standardUserDataPath, 'backups', 'legacy-migration.done.json');
  if (fs.existsSync(markerPath)) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDirectory = path.join(standardUserDataPath, 'backups', 'legacy-migration', timestamp);
  createUserDataSnapshot(legacyPath, snapshotDirectory, {
    reason: 'legacy-user-data-migration',
    appVersion,
    includeCredentials: true,
    includeCaches: true,
    allowedDestinationRoot: appData
  });
  verifyUserDataSnapshot(snapshotDirectory);

  const result: LegacyMigrationResult = {
    completedAt: new Date().toISOString(),
    sourcePath: legacyPath,
    sourceSnapshot: snapshotDirectory,
    copied: [],
    identical: [],
    conflicts: []
  };

  const migrateFiles = [
    'config.json',
    'diary.db',
    'diary.db-wal',
    'diary.db-shm',
    'google_auth.enc',
    'google_user.json',
    'eta_ranking_cache.json',
    'analytics.json'
  ];

  for (const item of migrateFiles) {
    const sourcePath = path.join(legacyPath, item);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;

    let destinationName = item;
    if (item === 'config.json') {
      try {
        const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
        if (
          parsed
          && ('ga_client_id' in parsed || 'ga_session_id' in parsed)
          && !('volumeMaster' in parsed || 'positions' in parsed)
        ) {
          destinationName = 'analytics.json';
        }
      } catch {
        // 손상된 config는 스냅샷에만 보존하고 표준 설정을 덮지 않는다.
        result.conflicts.push(item);
        continue;
      }
    }

    const destinationPath = path.join(standardUserDataPath, destinationName);
    if (!fs.existsSync(destinationPath)) {
      copyFileVerified(sourcePath, destinationPath);
      result.copied.push(`${item} -> ${destinationName}`);
    } else if (fs.statSync(destinationPath).isFile() && hashFile(sourcePath) === hashFile(destinationPath)) {
      result.identical.push(`${item} -> ${destinationName}`);
    } else {
      result.conflicts.push(`${item} -> ${destinationName}`);
    }
  }

  const legacySounds = path.join(legacyPath, 'custom_sounds');
  if (fs.existsSync(legacySounds) && fs.statSync(legacySounds).isDirectory()) {
    copyLegacyDirectoryWithoutOverwrite(
      legacySounds,
      path.join(standardUserDataPath, 'custom_sounds'),
      result,
      'custom_sounds'
    );
  }

  atomicWriteText(markerPath, JSON.stringify(result, null, 2));
}

function initUserData(): void {
  if (!app) return;
  try {
    app.name = 'twOverlay';
    const appData = app.getPath('appData');
    const standardUserDataPath = path.join(appData, 'twOverlay');
    fs.mkdirSync(standardUserDataPath, { recursive: true });
    app.setPath('userData', standardUserDataPath);

    const appVersion = app.getVersion();
    try {
      migrateLegacyUserData(appData, standardUserDataPath, appVersion);
    } catch (error) {
      console.error(`[BOOTSTRAP] 레거시 데이터 마이그레이션 실패: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      backupPreV3UserData(standardUserDataPath, appVersion);
    } catch (error) {
      console.error(`[BOOTSTRAP] v3 사전 스냅샷 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    console.error(`[BOOTSTRAP] userData 초기화 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

initUserData();
