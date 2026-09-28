import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-notice-verify-'));
app.setPath('userData', fixture);

const outputDir = 'C:/Users/drt_0/.gemini/antigravity/brain/8227ca49-64dc-4f4f-88a3-847713548f90/scratch';
fs.mkdirSync(outputDir, { recursive: true });

const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

async function run(): Promise<void> {
  await app.whenReady();

  const built = (name: string) => require(path.join(root, 'dist', `${name}.js`));
  built('modules/ipcHandlers').register();

  // 리소스 경로 해석을 위해 dist 및 dist-tools/dist에 notice 파일 복사
  const distNoticeDir = path.join(root, 'dist', 'assets', 'notice');
  const distToolsNoticeDir = path.join(root, 'dist-tools', 'dist', 'assets', 'notice');
  fs.mkdirSync(distNoticeDir, { recursive: true });
  fs.mkdirSync(distToolsNoticeDir, { recursive: true });
  fs.cpSync(path.join(root, 'src', 'assets', 'notice'), distNoticeDir, { recursive: true });
  fs.cpSync(path.join(root, 'src', 'assets', 'notice'), distToolsNoticeDir, { recursive: true });

  const win = new BrowserWindow({
    width: 640,
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
    await win.loadFile(path.join(root, 'dist', 'update-notice.html'));
    await pause(600);

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outputDir, 'update_notice_popup_test.png'), img.toPNG());
    console.log('Saved: update_notice_popup_test.png');
  } catch (err) {
    console.error('Failed to capture notice view:', err);
  } finally {
    win.close();
    app.quit();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
