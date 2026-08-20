import * as fs from 'fs';
import * as path from 'path';
import { app, dialog, BrowserWindow } from 'electron';
import AdmZip = require('adm-zip');
import { log } from './logger';
import * as diaryDb from './diaryDb';

/**
 * 데이터 전체 백업 (config.json + diary.db)
 */
export async function exportBackup(parentWindow: BrowserWindow): Promise<boolean> {
  try {
    diaryDb.flushPendingElso();
    const userDataPath = app.getPath('userData');
    const configPath = path.join(userDataPath, 'config.json');
    const dbPath = path.join(userDataPath, 'diary.db');

    const now = new Date();
    const dateStr = now.getFullYear() + 
                    String(now.getMonth() + 1).padStart(2, '0') + 
                    String(now.getDate()).padStart(2, '0') + '_' + 
                    String(now.getHours()).padStart(2, '0') + 
                    String(now.getMinutes()).padStart(2, '0');
    
    const { filePath } = await dialog.showSaveDialog(parentWindow, {
      title: '데이터 백업 저장',
      defaultPath: path.join(app.getPath('downloads'), `tw_overlay_backup_${dateStr}.zip`),
      filters: [{ name: 'ZIP Files', extensions: ['zip'] }]
    });

    if (!filePath) return false;

    const zip = new AdmZip();
    
    // 파일 존재 여부 확인 후 추가
    if (fs.existsSync(configPath)) {
      zip.addLocalFile(configPath);
    }
    if (fs.existsSync(dbPath)) {
      // DB 파일은 열려있을 수 있으므로 복사본을 만들어 압축하거나 직접 추가
      // better-sqlite3는 읽기 중 압축이 가능하므로 직접 추가 시도
      zip.addLocalFile(dbPath);
    }

    zip.writeZip(filePath);
    log(`[BACKUP] Backup created successfully at: ${filePath}`);
    return true;
  } catch (error) {
    log(`[BACKUP] Export failed: ${error}`);
    return false;
  }
}

/**
 * 데이터 복구 (ZIP 파일로부터 가져오기)
 */
export async function importBackup(parentWindow: BrowserWindow): Promise<boolean> {
  try {
    const { filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: '백업 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'ZIP Files', extensions: ['zip'] }]
    });

    if (!filePaths || filePaths.length === 0) return false;

    const zipPath = filePaths[0];
    const zip = new AdmZip(zipPath);
    const userDataPath = app.getPath('userData');

    // 1. DB 연결 안전하게 종료
    diaryDb.closeDb();

    // 2. 기존 파일 안전을 위해 이름 변경 (임시 백업)
    const configPath = path.join(userDataPath, 'config.json');
    const dbPath = path.join(userDataPath, 'diary.db');
    
    if (fs.existsSync(configPath)) fs.renameSync(configPath, configPath + '.old');
    if (fs.existsSync(dbPath)) fs.renameSync(dbPath, dbPath + '.old');

    // 3. 압축 해제
    zip.extractAllTo(userDataPath, true);

    // 4. 성공 시 .old 임시 파일 삭제
    try {
      if (fs.existsSync(configPath + '.old')) fs.unlinkSync(configPath + '.old');
      if (fs.existsSync(dbPath + '.old')) fs.unlinkSync(dbPath + '.old');
    } catch (cleanupErr) {
      log(`[BACKUP] .old cleanup warning: ${cleanupErr}`);
    }

    log(`[BACKUP] Data restored from: ${zipPath}`);

    // 4. 앱 재시작 안내 및 실행
    const result = await dialog.showMessageBox(parentWindow, {
      type: 'info',
      title: '복구 완료',
      message: '데이터 복구가 완료되었습니다. 변경사항을 적용하기 위해 앱을 재시작합니다.',
      buttons: ['확인']
    });

    app.relaunch();
    app.exit(0);
    
    return true;
  } catch (error) {
    log(`[BACKUP] Restore failed: ${error}`);
    // 실패 시 .old 파일로부터 원본 복구 (데이터 유실 방지)
    const userDataPath = app.getPath('userData');
    const configPath = path.join(userDataPath, 'config.json');
    const dbPath = path.join(userDataPath, 'diary.db');
    try {
      if (fs.existsSync(configPath + '.old')) fs.renameSync(configPath + '.old', configPath);
      if (fs.existsSync(dbPath + '.old')) fs.renameSync(dbPath + '.old', dbPath);
      log('[BACKUP] Rollback successful — original files restored.');
    } catch (rollbackError) {
      log(`[BACKUP] CRITICAL: Rollback also failed: ${rollbackError}`);
    }
    return false;
  }
}
