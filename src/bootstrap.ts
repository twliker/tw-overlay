/**
 * 애플리케이션 초기 부트스트랩
 * 1. app.name을 'twOverlay'로 조기 통일
 * 2. 표준 userData 경로(%APPDATA%\twOverlay) 설정 및 레거시 데이터 마이그레이션
 */
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

function initUserData(): void {
  if (!app) return;
  try {
    app.name = 'twOverlay';
    const appData = app.getPath('appData');
    const standardUserDataPath = path.join(appData, 'twOverlay');

    if (!fs.existsSync(standardUserDataPath)) {
      fs.mkdirSync(standardUserDataPath, { recursive: true });
    }

    // userData 경로를 먼저 안전하게 설정
    app.setPath('userData', standardUserDataPath);

    // 레거시 데이터 마이그레이션은 독립적으로 수행
    try {
      migrateLegacyUserData(appData, standardUserDataPath);
    } catch {
      // 마이그레이션 실패 시 조용히 무시
    }

    // v3.0.0 메이저 업데이트 1회성 사전 안전 스냅샷 백업
    try {
      backupPreV3UserData(standardUserDataPath);
    } catch {
      // 백업 실패 시에도 메인 부트스트랩 진행
    }
  } catch (e) {
    // 초기화 중 오류 시 조용히 무시
  }
}

/** v3.0.0 메이저 업데이트 전 데이터 1회성 자동 스냅샷 */
function backupPreV3UserData(standardUserDataPath: string): void {
  const backupDir = path.join(standardUserDataPath, 'backups', 'pre-v3.0.0');
  const flagFile = path.join(backupDir, 'backup.done');
  if (fs.existsSync(flagFile)) return;

  const targetFiles = ['config.json', 'diary.db', 'google_user.json'];
  let backedUpAny = false;

  for (const file of targetFiles) {
    const src = path.join(standardUserDataPath, file);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    try {
      fs.copyFileSync(src, path.join(backupDir, file));
      backedUpAny = true;
    } catch {}
  }

  if (backedUpAny && fs.existsSync(backupDir)) {
    try {
      fs.writeFileSync(flagFile, new Date().toISOString(), 'utf-8');
    } catch {}
  }
}

function migrateLegacyUserData(appData: string, standardUserDataPath: string): void {
  const legacyPath = path.join(appData, 'tw-overlay');
  if (!fs.existsSync(legacyPath)) return;

  const migrateFiles = [
    'config.json',
    'diary.db',
    'custom_sounds',
    'google_auth.enc',
    'google_user.json',
    'eta_ranking_cache.json',
    'analytics.json'
  ];

  for (const item of migrateFiles) {
    const srcItem = path.join(legacyPath, item);
    const dstItem = path.join(standardUserDataPath, item);
    if (!fs.existsSync(srcItem)) continue;

    // GA4 애널리틱스 config.json 분리 이관
    if (item === 'config.json') {
      try {
        const raw = fs.readFileSync(srcItem, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && ('ga_client_id' in parsed || 'ga_session_id' in parsed) && !('volumeMaster' in parsed || 'positions' in parsed)) {
          const analyticsDst = path.join(standardUserDataPath, 'analytics.json');
          if (!fs.existsSync(analyticsDst)) {
            fs.cpSync(srcItem, analyticsDst);
          }
          try { fs.rmSync(srcItem, { force: true }); } catch {}
          continue;
        }
      } catch {}
    }

    // 커스텀 사운드 폴더 병합 복사
    if (item === 'custom_sounds') {
      try {
        fs.cpSync(srcItem, dstItem, { recursive: true });
        fs.rmSync(srcItem, { recursive: true, force: true });
      } catch {}
      continue;
    }

    // 일반 파일 이관
    if (!fs.existsSync(dstItem)) {
      try {
        fs.cpSync(srcItem, dstItem, { recursive: true });
        fs.rmSync(srcItem, { recursive: true, force: true });
      } catch {}
    } else {
      try { fs.rmSync(srcItem, { recursive: true, force: true }); } catch {}
    }
  }

  // 마이그레이션 완료 후 남은 임시 캐시(GPUCache 등) 및 tw-overlay 디렉터리 정리
  try {
    fs.rmSync(legacyPath, { recursive: true, force: true });
  } catch {}
}

initUserData();
