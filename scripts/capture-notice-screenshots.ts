import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-notice-capture-'));
app.setPath('userData', fixture);

const noticeDir = path.join(root, 'src', 'assets', 'notice');
fs.mkdirSync(noticeDir, { recursive: true });

const built = (name: string) => require(path.join(root, 'dist', `${name}.js`));
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

async function run(): Promise<void> {
  await app.whenReady();

  app.on('window-all-closed', () => {
    // no-op
  });

  built('modules/ipcHandlers').register();
  const config = built('modules/config');
  const fullConfig = config.load();

  // 1. notice_1.png : 인게임 알림 드래그 편집 모드
  console.log('[1/3] Capturing notice_1.png (Game Overlay Notification Drag Edit Mode)...');
  const win1 = new BrowserWindow({
    width: 1280,
    height: 720,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win1.loadFile(path.join(root, 'dist', 'game-overlay.html'));
    await pause(300);
    // 알림 편집 모드 활성화
    win1.webContents.send('notification-edit-mode', true, true, 999);
    await pause(600);

    const img1 = await win1.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_1.png'), img1.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_1.png');
  } catch (err) {
    console.error('Failed to capture notice_1:', err);
  } finally {
    win1.close();
  }

  await pause(300);

  // 2. notice_2.png : 환경설정 알림 마우스 드래그 위치 설정 섹션
  console.log('[2/3] Capturing notice_2.png (Settings Notification Layout Card)...');
  const win2 = new BrowserWindow({
    width: 1100,
    height: 780,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win2.loadFile(path.join(root, 'dist', 'settings.html'));
    await pause(300);
    win2.webContents.send('config-data', fullConfig);
    await pause(300);

    // 로딩 오버레이 끄고 알림/HUD 위치 설정 카드로 스크롤
    await win2.webContents.executeJavaScript(`(() => {
      const loader = document.getElementById('loading-overlay');
      if (loader) loader.style.display = 'none';

      // 게임 플레이 탭으로 전환
      if (typeof switchCategory === 'function') {
        switchCategory('gameplay');
      }

      // notification-position-settings-card로 부드럽게 스크롤
      const target = document.getElementById('notification-position-settings-card');
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
    })()`);
    await pause(500);

    const img2 = await win2.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_2.png'), img2.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_2.png');
  } catch (err) {
    console.error('Failed to capture notice_2:', err);
  } finally {
    win2.close();
  }

  await pause(300);

  // 3. notice_3.png : 도크 바의 전역 음소거(Master Mute) 토글
  console.log('[3/3] Capturing notice_3.png (Dock Master Mute Control)...');
  const win3 = new BrowserWindow({
    width: 820,
    height: 240,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win3.loadFile(path.join(root, 'dist', 'dock.html'));
    await pause(300);
    win3.webContents.send('config-data', fullConfig);
    await pause(300);

    await win3.webContents.executeJavaScript(`(() => {
      document.body.style.display = 'flex';
      document.body.style.justifyContent = 'center';
      document.body.style.alignItems = 'center';
      document.body.style.height = '100vh';

      // master-mute-btn 호버 툴팁 시각적 강조
      const muteBtn = document.getElementById('dock-master-mute-btn');
      if (muteBtn) {
        const tooltip = muteBtn.querySelector('.dock-tooltip');
        if (tooltip) {
          tooltip.style.opacity = '1';
          tooltip.style.visibility = 'visible';
          tooltip.style.transform = 'translateX(-50%) translateY(-6px)';
        }
      }
    })()`);
    await pause(400);

    const img3 = await win3.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_3.png'), img3.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_3.png');
  } catch (err) {
    console.error('Failed to capture notice_3:', err);
  } finally {
    win3.close();
  }

  console.log('NOTICE SCREENSHOTS CAPTURED SUCCESSFULLY!');
  app.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
