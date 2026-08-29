/**
 * 기능 계약 — 로컬 ZIP 백업·복원
 *
 * - 백업은 앱이 소유한 사용자 데이터 스냅샷과 manifest를 만들고, 복원은 ZIP 항목 수·전체 해제 크기·
 *   경로 이탈·허용된 복원 대상·manifest 무결성을 검증한 뒤에만 실제 userData를 변경합니다.
 * - 사용자가 고른 ZIP 내부의 절대경로, `..`, 심볼릭 링크성 경로 또는 허용 목록 밖 파일을 userData에
 *   쓰지 않습니다. 임시 해제와 staging은 `userData/backups/staging` 아래에서만 정리합니다.
 * - 실제 교체 전에 현재 데이터를 rollback 스냅샷으로 보존하고 restore journal을 디스크에 동기화합니다.
 *   중간 실패나 앱 종료가 발생하면 다음 시작에서 복구할 수 있어야 하며, 성공한 뒤에만 journal을 지웁니다.
 * - 설정만 선택 복원할 때 일지 DB를 건드리지 않고, 일지 복원 시 열린 DB 연결과 WAL 상태를 안전하게
 *   조정합니다. 복원 완료 후 재시작이 필요하다는 사용자 흐름을 유지합니다.
 * - 레거시 백업은 명시된 기존 파일만 허용합니다. 호환성을 이유로 ZIP의 임의 파일까지 복원 범위를
 *   넓히지 않습니다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app, dialog, BrowserWindow } from 'electron';
import AdmZip = require('adm-zip');
import { log } from './logger';
import * as diaryDb from './diaryDb';
import * as cloudSyncState from './cloudSyncState';
import {
  createUserDataSnapshot,
  isRestorableSnapshotPath,
  SnapshotManifest,
  verifyUserDataSnapshot,
} from './localSnapshot';

const LEGACY_BACKUP_FILES = new Set(['config.json', 'diary.db', 'diary.db-wal', 'diary.db-shm']);
const RESTORE_JOURNAL_FILE = 'restore-journal.json';

interface RestoreJournal {
  formatVersion: 1;
  createdAt: string;
  rollbackPath: string;
  restorePaths: string[];
}

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

function getRestoreJournalPath(userDataPath: string): string {
  return path.join(userDataPath, 'backups', RESTORE_JOURNAL_FILE);
}

function writeRestoreJournal(
  userDataPath: string,
  rollbackPath: string,
  restorePaths: string[],
): void {
  const journalPath = getRestoreJournalPath(userDataPath);
  const tempPath = `${journalPath}.tmp`;
  const journal: RestoreJournal = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    rollbackPath,
    restorePaths,
  };
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(journal, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, journalPath);
}

function removeRestoreJournal(userDataPath: string): void {
  fs.rmSync(getRestoreJournalPath(userDataPath), { force: true });
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
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
    if (!isRestorableSnapshotPath(relativePath)) {
      throw new Error(`허용되지 않은 복원 경로입니다: ${entry.relativePath}`);
    }
    let current = destinationRoot;
    for (const segment of relativePath.split(path.sep).slice(0, -1)) {
      current = path.join(current, segment);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`복원 대상에 재분석 지점이 포함되어 있습니다: ${entry.relativePath}`);
      }
    }
    copyFileAtomic(path.join(sourceRoot, relativePath), path.join(destinationRoot, relativePath));
  }
}

function rollbackSnapshotFiles(
  rollbackRoot: string,
  destinationRoot: string,
  rollbackManifest: SnapshotManifest,
  restorePaths: string[],
): void {
  const rollbackPaths = new Set(rollbackManifest.entries.map(entry => path.normalize(entry.relativePath).toLowerCase()));
  for (const restorePath of restorePaths) {
    const normalized = path.normalize(restorePath);
    if (!isRestorableSnapshotPath(normalized) || rollbackPaths.has(normalized.toLowerCase())) continue;
    fs.rmSync(path.join(destinationRoot, normalized), { force: true });
  }
  applySnapshotFiles(rollbackRoot, destinationRoot, rollbackManifest);
}

/** 이전 실행이 복원 도중 종료됐으면 DB를 열기 전에 원본 스냅샷으로 롤백한다. */
export function recoverInterruptedRestore(): boolean {
  const userDataPath = app.getPath('userData');
  const journalPath = getRestoreJournalPath(userDataPath);
  if (!fs.existsSync(journalPath)) return true;
  try {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as RestoreJournal;
    const backupsRoot = path.join(userDataPath, 'backups');
    if (journal.formatVersion !== 1 || typeof journal.rollbackPath !== 'string'
      || !Array.isArray(journal.restorePaths)
      || journal.restorePaths.some(entry => typeof entry !== 'string' || !isRestorableSnapshotPath(entry))
      || !isPathInside(backupsRoot, journal.rollbackPath)) {
      throw new Error('복원 journal의 롤백 경로가 올바르지 않습니다.');
    }
    const manifest = verifyUserDataSnapshot(journal.rollbackPath, { enforceRestoreAllowlist: true });
    rollbackSnapshotFiles(journal.rollbackPath, userDataPath, manifest, journal.restorePaths);
    cloudSyncState.invalidateRemoteValidationAfterLocalRestore();
    removeRestoreJournal(userDataPath);
    log(`[BACKUP] 중단된 복원을 원본으로 롤백했습니다: ${journal.rollbackPath}`);
    return true;
  } catch (error) {
    log(`[BACKUP] 중단된 복원 롤백 실패: ${error instanceof Error ? error.message : String(error)}`);
    return false;
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

    if (!diaryDb.flushPendingElso()) throw new Error('대기 중인 엘소 기록을 저장하지 못했습니다.');
    if (!diaryDb.flushPendingGoldPouchSeed()) throw new Error('대기 중인 금화 주머니 환산 SEED 기록을 저장하지 못했습니다.');
    diaryDb.checkpointWal();
    stagingPath = createStagingDirectory(userDataPath, 'export-');
    const snapshotPath = path.join(stagingPath, 'snapshot');
    createUserDataSnapshot(userDataPath, snapshotPath, {
      reason: 'manual-export', appVersion: app.getVersion(), allowedDestinationRoot: stagingPath,
    });
    verifyUserDataSnapshot(snapshotPath, { enforceRestoreAllowlist: true });

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
  let restorePaths: string[] = [];
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
      ? verifyUserDataSnapshot(extractedPath, { enforceRestoreAllowlist: true })
      : legacyManifest(extractedPath);

    if (!diaryDb.flushPendingElso()) throw new Error('복원 전 엘소 기록을 저장하지 못했습니다.');
    if (!diaryDb.flushPendingGoldPouchSeed()) throw new Error('복원 전 금화 주머니 환산 SEED 기록을 저장하지 못했습니다.');
    diaryDb.checkpointWal();
    if (!diaryDb.closeDb()) throw new Error('복원 전 엘소 기록 정리를 완료하지 못했습니다.');
    const backupsRoot = path.join(userDataPath, 'backups');
    fs.mkdirSync(backupsRoot, { recursive: true });
    rollbackPath = path.join(backupsRoot, `pre-restore-${timestamp()}`);
    createUserDataSnapshot(userDataPath, rollbackPath, {
      reason: 'pre-manual-restore', appVersion: app.getVersion(), allowedDestinationRoot: backupsRoot,
    });
    verifyUserDataSnapshot(rollbackPath, { enforceRestoreAllowlist: true });

    restorePaths = manifest.entries.map(entry => entry.relativePath);
    writeRestoreJournal(userDataPath, rollbackPath, restorePaths);
    applySnapshotFiles(extractedPath, userDataPath, manifest);
    cloudSyncState.invalidateRemoteValidationAfterLocalRestore();
    removeRestoreJournal(userDataPath);
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
        const rollbackManifest = verifyUserDataSnapshot(rollbackPath, { enforceRestoreAllowlist: true });
        rollbackSnapshotFiles(rollbackPath, userDataPath, rollbackManifest, restorePaths);
        removeRestoreJournal(userDataPath);
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
