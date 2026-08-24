import * as fs from 'fs';
import * as path from 'path';
import { app, dialog, BrowserWindow } from 'electron';
import AdmZip = require('adm-zip');
import { log } from './logger';
import * as diaryDb from './diaryDb';
import {
  createUserDataSnapshot,
  SnapshotManifest,
  verifyUserDataSnapshot,
} from './localSnapshot';

const LEGACY_BACKUP_FILES = new Set(['config.json', 'diary.db', 'diary.db-wal', 'diary.db-shm']);

function timestamp(): string {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'), '_', String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'), String(now.getSeconds()).padStart(2, '0')].join('');
}

function createStagingDirectory(userDataPath: string, prefix: string): string {
  const stagingRoot = path.join(userDataPath, 'backups', 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  return fs.mkdtempSync(path.join(stagingRoot, prefix));
}

function removeStagingDirectory(stagingPath: string, userDataPath: string): void {
  const allowedRoot = path.resolve(userDataPath, 'backups', 'staging');
  const resolved = path.resolve(stagingPath);
  if (resolved.startsWith(`${allowedRoot}${path.sep}`)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function ensureSafeZipEntries(zip: AdmZip): void {
  const entries = zip.getEntries();
  if (entries.length > 20_000) throw new Error('백업 ZIP 항목 수가 허용 범위를 초과했습니다.');
  let totalUncompressedSize = 0;
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry.entryName.replace(/\\/g, '/'));
    if (entry.entryName.length > 1_024 || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`백업 ZIP 경로 이탈이 감지되었습니다: ${entry.entryName}`);
    }
    const entrySize = Number(entry.header.size);
    if (!Number.isSafeInteger(entrySize) || entrySize < 0 || entrySize > 5 * 1024 * 1024 * 1024) {
      throw new Error(`백업 ZIP 항목 크기가 유효하지 않습니다: ${entry.entryName}`);
    }
    totalUncompressedSize += entrySize;
    if (totalUncompressedSize > 10 * 1024 * 1024 * 1024) {
      throw new Error('백업 ZIP 압축 해제 크기가 허용 범위를 초과했습니다.');
    }
  }
}

function legacyManifest(extractedRoot: string): SnapshotManifest {
  const entries = fs.readdirSync(extractedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'snapshot.manifest.json') continue;
    if (!entry.isFile() || !LEGACY_BACKUP_FILES.has(entry.name)) {
      throw new Error(`지원하지 않는 구형 백업 항목입니다: ${entry.name}`);
    }
  }
  const present = [...LEGACY_BACKUP_FILES].filter(name => fs.existsSync(path.join(extractedRoot, name)));
  if (!present.includes('config.json') && !present.includes('diary.db')) {
    throw new Error('복원 가능한 설정 또는 일지 DB가 백업에 없습니다.');
  }
  return {
    formatVersion: 1,
    reason: 'legacy-import',
    appVersion: 'legacy',
    createdAt: new Date().toISOString(),
    sourcePath: extractedRoot,
    entries: present.map(relativePath => ({
      relativePath,
      kind: 'file' as const,
      size: fs.statSync(path.join(extractedRoot, relativePath)).size,
      sha256: '',
    })),
    missing: [],
  };
}

function copyFileAtomic(sourcePath: string, destinationPath: string): void {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.restore-tmp`;
  fs.copyFileSync(sourcePath, tempPath);
  const fd = fs.openSync(tempPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, destinationPath);
}

function applySnapshotFiles(sourceRoot: string, destinationRoot: string, manifest: SnapshotManifest): void {
  for (const entry of manifest.entries) {
    const relativePath = path.normalize(entry.relativePath);
    if (path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
      throw new Error(`복원 경로 이탈이 감지되었습니다: ${entry.relativePath}`);
    }
    copyFileAtomic(path.join(sourceRoot, relativePath), path.join(destinationRoot, relativePath));
  }
}

/** 설정, SQLite 파일 집합, 커스텀 사운드를 검증 스냅샷으로 묶어 내보냅니다. */
export async function exportBackup(parentWindow: BrowserWindow): Promise<boolean> {
  const userDataPath = app.getPath('userData');
  let stagingPath: string | null = null;
  try {
    const dateStr = timestamp();
    const { filePath } = await dialog.showSaveDialog(parentWindow, {
      title: '데이터 백업 저장',
      defaultPath: path.join(app.getPath('downloads'), `tw_overlay_backup_${dateStr}.zip`),
      filters: [{ name: 'ZIP Files', extensions: ['zip'] }],
    });
    if (!filePath) return false;

    diaryDb.flushPendingElso();
    diaryDb.checkpointWal();
    stagingPath = createStagingDirectory(userDataPath, 'export-');
    const snapshotPath = path.join(stagingPath, 'snapshot');
    createUserDataSnapshot(userDataPath, snapshotPath, {
      reason: 'manual-export', appVersion: app.getVersion(), allowedDestinationRoot: stagingPath,
    });
    verifyUserDataSnapshot(snapshotPath);

    const zip = new AdmZip();
    zip.addLocalFolder(snapshotPath);
    zip.writeZip(filePath);
    log(`[BACKUP] 검증된 백업 생성 완료: ${filePath}`);
    return true;
  } catch (error) {
    log(`[BACKUP] 내보내기 실패: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (stagingPath) removeStagingDirectory(stagingPath, userDataPath);
  }
}

/** 압축을 격리 디렉터리에서 검증하고, 복원 직전 원본 스냅샷을 남긴 뒤 적용합니다. */
export async function importBackup(parentWindow: BrowserWindow): Promise<boolean> {
  const userDataPath = app.getPath('userData');
  let stagingPath: string | null = null;
  let rollbackPath: string | null = null;
  try {
    const { filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: '백업 파일 선택', properties: ['openFile'],
      filters: [{ name: 'ZIP Files', extensions: ['zip'] }],
    });
    if (!filePaths || filePaths.length === 0) return false;

    const zipPath = filePaths[0];
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size > 5 * 1024 * 1024 * 1024) {
      throw new Error('백업 파일이 없거나 허용 크기를 초과했습니다.');
    }
    const zip = new AdmZip(zipPath);
    ensureSafeZipEntries(zip);
    stagingPath = createStagingDirectory(userDataPath, 'import-');
    const extractedPath = path.join(stagingPath, 'extracted');
    fs.mkdirSync(extractedPath, { recursive: true });
    zip.extractAllTo(extractedPath, false);

    const manifestPath = path.join(extractedPath, 'snapshot.manifest.json');
    const manifest = fs.existsSync(manifestPath)
      ? verifyUserDataSnapshot(extractedPath)
      : legacyManifest(extractedPath);

    diaryDb.flushPendingElso();
    diaryDb.checkpointWal();
    diaryDb.closeDb();
    const backupsRoot = path.join(userDataPath, 'backups');
    fs.mkdirSync(backupsRoot, { recursive: true });
    rollbackPath = path.join(backupsRoot, `pre-restore-${timestamp()}`);
    createUserDataSnapshot(userDataPath, rollbackPath, {
      reason: 'pre-manual-restore', appVersion: app.getVersion(), allowedDestinationRoot: backupsRoot,
    });
    verifyUserDataSnapshot(rollbackPath);

    applySnapshotFiles(extractedPath, userDataPath, manifest);
    log(`[BACKUP] 데이터 복원 완료: ${zipPath} (복원 전 스냅샷: ${rollbackPath})`);

    await dialog.showMessageBox(parentWindow, {
      type: 'info', title: '복구 완료',
      message: '데이터 복구가 완료되었습니다. 변경사항을 적용하기 위해 앱을 재시작합니다.',
      buttons: ['확인'],
    });
    app.relaunch();
    app.exit(0);
    return true;
  } catch (error) {
    log(`[BACKUP] 복원 실패: ${error instanceof Error ? error.message : String(error)}`);
    if (rollbackPath) {
      try {
        const rollbackManifest = verifyUserDataSnapshot(rollbackPath);
        applySnapshotFiles(rollbackPath, userDataPath, rollbackManifest);
        log(`[BACKUP] 복원 실패 후 원본 롤백 완료: ${rollbackPath}`);
      } catch (rollbackError) {
        log(`[BACKUP] 치명적 오류: 롤백도 실패했습니다. ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    return false;
  } finally {
    if (stagingPath) removeStagingDirectory(stagingPath, userDataPath);
  }
}
