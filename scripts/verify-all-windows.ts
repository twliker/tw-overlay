import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-verify-all-full-'));
app.setPath('userData', fixture);

const outputDir = 'C:/Users/drt_0/.gemini/antigravity/brain/8227ca49-64dc-4f4f-88a3-847713548f90/scratch/verification_full';
fs.mkdirSync(outputDir, { recursive: true });

const built = (name: string) => require(path.join(root, 'dist', `${name}.js`));
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

interface TargetWindow {
  id: string;
  file: string;
  w: number;
  h: number;
  setup?: (win: BrowserWindow, config: any) => Promise<void>;
}

const targets: TargetWindow[] = [
  // 런처 및 프레임
  { id: '01_sidebar', file: 'index.html', w: 360, h: 720 },
  { id: '02_dock', file: 'dock.html', w: 800, h: 220, setup: async (win, config) => {
    win.webContents.send('config-data', config);
    await pause(300);
    await win.webContents.executeJavaScript(`(() => { document.body.style.alignItems = 'center'; })()`);
  }},
  { id: '03_game_overlay', file: 'game-overlay.html', w: 1280, h: 720, setup: async (win) => {
    win.webContents.send('notification-edit-mode', true, true, 999);
    await pause(500);
  }},
  { id: '04_splash', file: 'splash.html', w: 500, h: 320 },
  { id: '05_settings', file: 'settings.html', w: 1100, h: 850, setup: async (win, config) => {
    win.webContents.send('config-data', config);
    await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('loading-overlay');
      if (el) el.style.display = 'none';
    })()`);
  }},
  { id: '06_welcome_guide', file: 'welcome-guide.html', w: 900, h: 650 },
  { id: '07_update_notice', file: 'update-notice.html', w: 700, h: 550 },
  { id: '08_game_exit_reminder', file: 'game-exit-reminder.html', w: 450, h: 280 },

  // 플레이 핵심 도구
  { id: '09_xp_hud', file: 'xp-hud.html', w: 420, h: 940, setup: async (win, config) => {
    win.webContents.send('config-data', config);
  }},
  { id: '10_contents_checker', file: 'contents-checker.html', w: 400, h: 950, setup: async (win, config) => {
    win.webContents.send('config-data', config);
  }},
  { id: '11_diary', file: 'diary.html', w: 1400, h: 920 },
  { id: '12_stopwatch', file: 'stopwatch.html', w: 870, h: 750 },
  { id: '13_buff_timer', file: 'buff-timer.html', w: 900, h: 850 },
  { id: '14_magic_stone_calculator', file: 'magic-stone-calculator.html', w: 400, h: 800 },
  { id: '15_hunting_path_simulator', file: 'hunting-path-simulator.html', w: 860, h: 800 },

  // 계산기 및 시뮬레이터
  { id: '16_coefficient_calculator', file: 'coefficient-calculator.html', w: 1420, h: 860 },
  { id: '17_equipment_simulator', file: 'equipment-simulator.html', w: 960, h: 820 },
  { id: '18_relic_calculator', file: 'relic-calculator.html', w: 920, h: 760 },
  { id: '19_evolution_calculator', file: 'evolution-calculator.html', w: 1040, h: 820 },
  { id: '20_hunting_exp_calculator', file: 'hunting-exp-calculator.html', w: 940, h: 780 },
  { id: '21_thesis_core_calculator', file: 'thesis-core-calculator.html', w: 850, h: 880 },
  { id: '22_sword_enhance', file: 'sword-enhance.html', w: 1300, h: 850 },
  { id: '23_qte_challenge', file: 'qte-challenge.html', w: 980, h: 780 },

  // 백과사전류
  { id: '24_buffs', file: 'buffs.html', w: 1080, h: 740 },
  { id: '25_equipment_dic', file: 'equipment-dic.html', w: 1120, h: 800 },
  { id: '26_abbreviation', file: 'abbreviation.html', w: 540, h: 720 },
  { id: '27_eta_ranking', file: 'eta-ranking.html', w: 680, h: 720 },
  { id: '28_siena_aura', file: 'siena-aura.html', w: 1230, h: 930 },

  // 채팅 및 알림 유틸
  { id: '29_chat_overlay', file: 'chat-overlay.html', w: 450, h: 400 },
  { id: '30_focused_chat', file: 'focused-chat.html', w: 460, h: 720 },
  { id: '31_shout_history', file: 'shout-history.html', w: 450, h: 600 },
  { id: '32_boss_settings', file: 'boss-settings.html', w: 460, h: 780 },
  { id: '33_word_alarm', file: 'word-alarm.html', w: 450, h: 950 },
  { id: '34_discord_alarm', file: 'discord-alarm.html', w: 450, h: 950 },
  { id: '35_custom_alert', file: 'custom-alert.html', w: 580, h: 640 },
  { id: '36_trade', file: 'trade.html', w: 450, h: 600 },
  { id: '37_scam_detector', file: 'scam-detector.html', w: 480, h: 780 },
  { id: '38_uniform_color', file: 'uniform-color.html', w: 360, h: 800 },
  { id: '39_gallery', file: 'gallery.html', w: 450, h: 600 },
  { id: '40_overlay', file: 'overlay.html', w: 800, h: 600 }
];

async function run(): Promise<void> {
  await app.whenReady();

  // 모든 창이 닫혀도 루프 진행 중에는 프로세스가 종료되지 않도록 방지
  app.on('window-all-closed', () => {
    // no-op: do not quit
  });

  built('modules/ipcHandlers').register();
  const config = built('modules/config');
  const fullConfig = config.load();

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    console.log(`[${i + 1}/${targets.length}] Capturing ${t.id} (${t.file})...`);

    const win = new BrowserWindow({
      width: t.w,
      height: t.h,
      show: true,
      backgroundColor: '#0f172a',
      webPreferences: {
        preload: path.join(root, 'dist', 'preload.js'),
        sandbox: true,
        contextIsolation: true,
      },
    });

    try {
      await win.loadFile(path.join(root, 'dist', t.file));
      await pause(350);

      if (t.setup) {
        await t.setup(win, fullConfig);
      }

      await pause(350);
      const img = await win.webContents.capturePage();
      const filePath = path.join(outputDir, `${t.id}.png`);
      fs.writeFileSync(filePath, img.toPNG());
      console.log(`  -> Saved: ${t.id}.png`);
    } catch (err) {
      console.error(`  -> Failed ${t.id}:`, err);
    } finally {
      win.close();
    }
    await pause(100);
  }

  console.log('ALL 40 WINDOWS CAPTURED SUCCESSFULLY!');
  app.quit();
}

run().catch(err => {
  console.error(err);
  app.exit(1);
});
