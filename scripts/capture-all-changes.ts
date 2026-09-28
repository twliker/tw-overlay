import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-notice-perfect-'));
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

  // =============================================================
  // 1. notice_1.png : 오늘의 요약 HUD - 현재 진행 중인 숙제 표시 (단독 집중)
  // =============================================================
  console.log('[1/12] Capturing notice_1.png (Today Summary HUD - In-progress Homework)...');
  const win1 = new BrowserWindow({
    width: 360,
    height: 530,
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

    // 경험치 HUD 및 타 위젯 숨김 처리하고 오직 오늘의 요약 HUD만 단독 노출
    await win1.webContents.executeJavaScript(`(() => {
      const xpHud = document.getElementById('xp-hud');
      if (xpHud) xpHud.style.setProperty('display', 'none', 'important');

      const noteHud = document.getElementById('pinned-note-hud');
      if (noteHud) noteHud.style.setProperty('display', 'none', 'important');

      const supplyAlert = document.getElementById('supply-pad-alert');
      if (supplyAlert) supplyAlert.style.setProperty('display', 'none', 'important');

      const summaryHud = document.getElementById('today-summary-hud');
      if (summaryHud) {
        summaryHud.classList.remove('hidden', 'collapsed');
        summaryHud.style.left = '20px';
        summaryHud.style.top = '16px';
        summaryHud.style.position = 'absolute';
      }

      const sampleSummary = {
        date: '2026-09-28',
        totalSeed: 245000000,
        totalElso: 4200,
        totalEssence: 18,
        bossKills: 4,
        lootItems: [
          { name: '고대 마정석', count: 6 },
          { name: '에테르 파편', count: 32 },
          { name: '연마 강화석', count: 2 }
        ],
        totalLootCount: 40,
        homework: {
          characterName: '본캐',
          totalCount: 6,
          remainingCount: 3,
          remainingItems: [
            { name: '어비스 심층', currentCount: 1, maxCount: 2 },
            { name: '머큐리얼 케이브', currentCount: 0, maxCount: 1 },
            { name: '골고다 부대장', currentCount: 0, maxCount: 1 }
          ],
        },
        detectedHomework: {
          name: '현재 진행 중: 어비스 심층',
          currentCount: 1,
          maxCount: 2,
        }
      };

      const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };

      setText('today-summary-date', '09.28');
      setText('today-summary-seed', '2.45억');
      setText('today-summary-elso', '4,200 P');
      setText('today-summary-loot-total', '3종');
      setText('today-summary-loot-meta', '40개');
      setText('today-summary-bosses', '4회');

      const detectedEl = document.getElementById('today-summary-detected-homework');
      if (detectedEl) {
        detectedEl.classList.remove('hidden');
        setText('today-summary-detected-name', sampleSummary.detectedHomework.name);
        setText('today-summary-detected-count', '1/2');
      }

      const lootContainer = document.getElementById('today-summary-loot-list');
      if (lootContainer) {
        lootContainer.innerHTML = '';
        sampleSummary.lootItems.forEach(item => {
          const row = document.createElement('div');
          row.className = 'today-summary-list-row';
          row.innerHTML = \`<span class="today-summary-list-name">\${item.name}</span><span class="today-summary-list-value">\${item.count}개</span>\`;
          lootContainer.appendChild(row);
        });
      }

      setText('today-summary-homework-character', '본캐 숙제');
      setText('today-summary-homework-progress', '3/6');
      const hwContainer = document.getElementById('today-summary-homework-list');
      if (hwContainer) {
        hwContainer.innerHTML = '';
        sampleSummary.homework.remainingItems.forEach(item => {
          const row = document.createElement('div');
          row.className = 'today-summary-list-row';
          const prog = item.maxCount > 1 ? \`\${item.currentCount}/\${item.maxCount}\` : '미완료';
          row.innerHTML = \`<span class="today-summary-list-name">\${item.name}</span><span class="today-summary-list-value">\${prog}</span>\`;
          hwContainer.appendChild(row);
        });
      }
    })()`);
    await pause(500);

    const img1 = await win1.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_1.png'), img1.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_1.png');
  } catch (err) {
    console.error('Failed 1:', err);
  } finally {
    win1.close();
  }

  await pause(200);

  // =============================================================
  // 2. notice_2.png : 게임 화면 고정 메모 HUD (단독 집중)
  // =============================================================
  console.log('[2/12] Capturing notice_2.png (Pinned Note HUD)...');
  const win2 = new BrowserWindow({
    width: 420,
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
    await win2.loadFile(path.join(root, 'dist', 'game-overlay.html'));
    await pause(300);

    await win2.webContents.executeJavaScript(`(() => {
      const xpHud = document.getElementById('xp-hud');
      if (xpHud) xpHud.style.setProperty('display', 'none', 'important');

      const summaryHud = document.getElementById('today-summary-hud');
      if (summaryHud) summaryHud.style.setProperty('display', 'none', 'important');

      const supplyAlert = document.getElementById('supply-pad-alert');
      if (supplyAlert) supplyAlert.style.setProperty('display', 'none', 'important');

      const noteHud = document.getElementById('pinned-note-hud');
      if (noteHud) {
        noteHud.classList.remove('hidden');
        noteHud.style.left = '16px';
        noteHud.style.top = '16px';
        noteHud.style.width = '388px';
        noteHud.style.maxHeight = 'none';
        noteHud.style.position = 'absolute';

        const content = document.getElementById('pinned-note-content');
        if (content) {
          content.style.maxHeight = 'none';
          content.style.fontSize = '14px';
          content.style.color = '#ffffff';
          content.style.lineHeight = '1.6';
          content.textContent = '📌 오늘의 모험 체크리스트\\n• 어비스 심층 2회 클리어\\n• 머큐리얼 코어 변환 작업\\n• 마정석 정산 및 거래소 등록\\n• 21:00 골고다 필드보스 파티 대기';
        }
      }
    })()`);
    await pause(500);

    const img2 = await win2.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_2.png'), img2.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_2.png');
  } catch (err) {
    console.error('Failed 2:', err);
  } finally {
    win2.close();
  }

  await pause(200);

  // =============================================================
  // 3. notice_3.png : 보급품 탈환 기믹 발판 순서 실시간 안내 (단독 집중)
  // =============================================================
  console.log('[3/12] Capturing notice_3.png (Supply Pads Gimmick Alert)...');
  const win3 = new BrowserWindow({
    width: 480,
    height: 230,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win3.loadFile(path.join(root, 'dist', 'game-overlay.html'));
    await pause(300);

    await win3.webContents.executeJavaScript(`(() => {
      const xpHud = document.getElementById('xp-hud');
      if (xpHud) xpHud.style.setProperty('display', 'none', 'important');

      const summaryHud = document.getElementById('today-summary-hud');
      if (summaryHud) summaryHud.style.setProperty('display', 'none', 'important');

      const noteHud = document.getElementById('pinned-note-hud');
      if (noteHud) noteHud.style.setProperty('display', 'none', 'important');

      const alertPanel = document.getElementById('supply-pad-alert');
      const orderContainer = document.getElementById('supply-pad-order');
      if (alertPanel && orderContainer) {
        alertPanel.classList.remove('hidden');
        alertPanel.style.left = '50%';
        alertPanel.style.top = '50%';
        alertPanel.style.position = 'absolute';
        alertPanel.style.transform = 'translate(-50%, -50%)';

        orderContainer.replaceChildren();
        const colors = [
          { name: '파랑', file: 'blue' },
          { name: '노랑', file: 'yellow' },
          { name: '빨강', file: 'red' },
        ];

        colors.forEach((c, idx) => {
          if (idx > 0) {
            const arrow = document.createElement('span');
            arrow.textContent = '→';
            arrow.style.fontSize = '24px';
            arrow.style.color = '#94a3b8';
            arrow.style.margin = '0 12px';
            orderContainer.appendChild(arrow);
          }
          const label = document.createElement('span');
          label.className = 'supply-pad';
          label.style.display = 'inline-flex';
          label.style.flexDirection = 'column';
          label.style.alignItems = 'center';
          label.style.gap = '6px';
          label.style.fontWeight = 'bold';
          label.style.fontSize = '14px';

          const img = document.createElement('img');
          img.src = \`assets/img/supply-pads/\${c.file}.png\`;
          img.width = 72;
          img.height = 48;
          img.draggable = false;

          label.append(img, document.createTextNode(c.name));
          orderContainer.appendChild(label);
        });
      }
    })()`);
    await pause(500);

    const img3 = await win3.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_3.png'), img3.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_3.png');
  } catch (err) {
    console.error('Failed 3:', err);
  } finally {
    win3.close();
  }

  await pause(200);

  // =============================================================
  // 4. notice_4.png : 인게임 알림 위치 마우스 드래그 편집 모드 (단독 집중)
  // =============================================================
  console.log('[4/12] Capturing notice_4.png (Notification Drag Edit Mode)...');
  const win4 = new BrowserWindow({
    width: 860,
    height: 380,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win4.loadFile(path.join(root, 'dist', 'game-overlay.html'));
    await pause(300);

    await win4.webContents.executeJavaScript(`(() => {
      const xpHud = document.getElementById('xp-hud');
      if (xpHud) xpHud.style.setProperty('display', 'none', 'important');

      const summaryHud = document.getElementById('today-summary-hud');
      if (summaryHud) summaryHud.style.setProperty('display', 'none', 'important');

      const noteHud = document.getElementById('pinned-note-hud');
      if (noteHud) noteHud.style.setProperty('display', 'none', 'important');
    })()`);

    win4.webContents.send('notification-edit-mode', true, true, 999);
    await pause(500);

    await win4.webContents.executeJavaScript(`(() => {
      const cards = document.querySelectorAll('.notification-edit-card');
      const positions = [
        { left: '40px', top: '100px' },
        { left: '40px', top: '230px' },
        { left: '450px', top: '100px' },
        { left: '450px', top: '230px' },
      ];
      cards.forEach((card, i) => {
        if (positions[i]) {
          card.style.left = positions[i].left;
          card.style.top = positions[i].top;
          card.style.bottom = 'auto';
          card.style.right = 'auto';
        }
      });
      const toolbar = document.getElementById('notification-edit-toolbar');
      if (toolbar) {
        toolbar.style.top = '16px';
        toolbar.style.left = '50%';
        toolbar.style.transform = 'translateX(-50%)';
      }
    })()`);
    await pause(300);

    const img4 = await win4.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_4.png'), img4.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_4.png');
  } catch (err) {
    console.error('Failed 4:', err);
  } finally {
    win4.close();
  }

  await pause(200);

  // =============================================================
  // 5. notice_5.png : 환경설정 - HUD 및 알림 마우스 드래그 설정 컨트롤 카드
  // =============================================================
  console.log('[5/12] Capturing notice_5.png (Settings HUD & Notification Drag Cards)...');
  const win5 = new BrowserWindow({
    width: 1100,
    height: 860,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win5.loadFile(path.join(root, 'dist', 'settings.html'));
    await pause(300);
    win5.webContents.send('config-data', fullConfig);
    await pause(300);

    await win5.webContents.executeJavaScript(`(() => {
      const loader = document.getElementById('loading-overlay');
      if (loader) loader.style.display = 'none';

      const navEl = document.querySelector('.nav-item[data-settings-group="game"]');
      if (navEl && typeof showSettingsGroup === 'function') {
        showSettingsGroup('game', navEl, 0);
      }

      const card = document.getElementById('notification-position-settings-card');
      if (card) {
        card.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
    })()`);
    await pause(600);

    const img5 = await win5.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_5.png'), img5.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_5.png');
  } catch (err) {
    console.error('Failed 5:', err);
  } finally {
    win5.close();
  }

  await pause(200);

  // =============================================================
  // 6. notice_6.png : 닉네임 정보 & 개인 메모 다이얼로그
  // =============================================================
  console.log('[6/12] Capturing notice_6.png (Nickname Info & Note Dialog)...');
  const win6 = new BrowserWindow({
    width: 620,
    height: 720,
    useContentSize: true,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win6.loadFile(path.join(root, 'dist', 'focused-chat.html'));
    await pause(300);

    await win6.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.nickname-note-dialog');
      if (dialog) {
        dialog.style.maxHeight = 'none';
        dialog.showModal();
        const nickInput = dialog.querySelector('#note-nickname');
        if (nickInput) nickInput.value = '테일즈매니아';

        const info = dialog.querySelector('#note-character-info');
        if (info) info.textContent = '보리스 진네만 · 에타 3,250';

        const date = dialog.querySelector('#note-info-date');
        if (date) date.textContent = '2026.09.28 기준 최신 에타 정보';

        const note = dialog.querySelector('#note-text');
        if (note) note.value = '어비스 심층 고정 파티원, 클럽 부마스터';
      }
    })()`);
    await pause(500);

    const img6 = await win6.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_6.png'), img6.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_6.png');
  } catch (err) {
    console.error('Failed 6:', err);
  } finally {
    win6.close();
  }

  await pause(200);

  // =============================================================
  // 7. notice_7.png : 퀵 도크 바 전역 음소거(Master Mute)
  // =============================================================
  console.log('[7/12] Capturing notice_7.png (Dock Master Mute)...');
  const win7 = new BrowserWindow({
    width: 680,
    height: 280,
    useContentSize: true,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win7.loadFile(path.join(root, 'dist', 'dock.html'));
    await pause(300);
    win7.webContents.send('config-data', fullConfig);
    await pause(300);

    await win7.webContents.executeJavaScript(`(() => {
      document.body.style.display = 'flex';
      document.body.style.justifyContent = 'center';
      document.body.style.alignItems = 'center';
      document.body.style.height = '100vh';

      const dockBar = document.getElementById('dock-bar');
      if (dockBar) {
        dockBar.style.position = 'relative';
        dockBar.style.margin = 'auto';
      }

      const qs = document.getElementById('quickslot-section');
      if (qs) qs.style.display = 'none';
      const div2 = document.getElementById('divider-2');
      if (div2) div2.style.display = 'none';

      const muteBtn = document.getElementById('dock-master-mute-btn');
      if (muteBtn) {
        const tooltip = muteBtn.querySelector('.dock-tooltip');
        if (tooltip) {
          tooltip.style.opacity = '1';
          tooltip.style.visibility = 'visible';
          tooltip.style.bottom = 'auto';
          tooltip.style.top = 'calc(100% + 10px)';
          tooltip.style.transform = 'translateX(-50%)';
        }
      }
    })()`);
    await pause(400);

    const img7 = await win7.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_7.png'), img7.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_7.png');
  } catch (err) {
    console.error('Failed 7:', err);
  } finally {
    win7.close();
  }

  await pause(200);

  // =============================================================
  // 8. notice_8.png : 경험치 HUD 미세 변동 200만 필터 & 알림 설정 탭
  // =============================================================
  console.log('[8/12] Capturing notice_8.png (XP HUD Filter & Minimum Threshold)...');
  const win8 = new BrowserWindow({
    width: 440,
    height: 760,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win8.loadFile(path.join(root, 'dist', 'xp-hud.html'));
    await pause(300);
    win8.webContents.send('config-data', fullConfig);
    await pause(300);

    await win8.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('div').forEach(d => {
        if (d.textContent && d.textContent.includes('채팅로그')) {
          d.style.display = 'none';
        }
      });

      const tabSettings = document.getElementById('tab-settings');
      if (tabSettings) tabSettings.click();

      const panel = document.getElementById('panel-settings');
      if (panel) panel.scrollTop = 0;
    })()`);
    await pause(500);

    const img8 = await win8.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_8.png'), img8.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_8.png');
  } catch (err) {
    console.error('Failed 8:', err);
  } finally {
    win8.close();
  }

  await pause(200);

  // =============================================================
  // 9. notice_9.png : 상황별 원클릭 '활동 프리셋' 관리
  // =============================================================
  console.log('[9/12] Capturing notice_9.png (Settings Activity Presets)...');
  const win9 = new BrowserWindow({
    width: 1100,
    height: 680,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win9.loadFile(path.join(root, 'dist', 'settings.html'));
    await pause(300);
    win9.webContents.send('config-data', fullConfig);
    await pause(300);

    await win9.webContents.executeJavaScript(`(() => {
      const loader = document.getElementById('loading-overlay');
      if (loader) loader.style.display = 'none';

      const navEl = document.querySelector('.nav-item[data-settings-group="app"]');
      if (navEl && typeof showSettingsGroup === 'function') {
        showSettingsGroup('app', navEl, 0);
      }

      const presetCard = document.getElementById('activity-presets-card');
      if (presetCard) {
        presetCard.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    })()`);
    await pause(600);

    const img9 = await win9.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_9.png'), img9.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_9.png');
  } catch (err) {
    console.error('Failed 9:', err);
  } finally {
    win9.close();
  }

  await pause(200);

  // =============================================================
  // 10. notice_10.png : 환경설정 직관적인 Ctrl 단축키 설정
  // =============================================================
  console.log('[10/12] Capturing notice_10.png (Settings Shortcuts Ctrl Display)...');
  const win10 = new BrowserWindow({
    width: 1100,
    height: 880,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win10.loadFile(path.join(root, 'dist', 'settings.html'));
    await pause(300);
    win10.webContents.send('config-data', fullConfig);
    await pause(300);

    await win10.webContents.executeJavaScript(`(() => {
      const loader = document.getElementById('loading-overlay');
      if (loader) loader.style.display = 'none';

      const target = typeof resolveSettingsRoute === 'function' ? resolveSettingsRoute('shortcuts') : null;
      if (target && typeof showSettingsGroup === 'function') {
        const navEl = document.querySelector(\`.nav-item[data-settings-group="\${target.groupId}"]\`);
        showSettingsGroup(target.groupId, navEl, target.routeIndex);
      }

      const shortcutsCard = document.getElementById('shortcuts-list-card');
      if (shortcutsCard) {
        shortcutsCard.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    })()`);
    await pause(500);

    const img10 = await win10.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_10.png'), img10.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_10.png');
  } catch (err) {
    console.error('Failed 10:', err);
  } finally {
    win10.close();
  }

  await pause(200);

  // =============================================================
  // 11. notice_11.png : 모험 일지 기간별 HTML 리포트 내보내기
  // =============================================================
  console.log('[11/12] Capturing notice_11.png (Adventure Diary HTML Export Dialog)...');
  const win11 = new BrowserWindow({
    width: 720,
    height: 640,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win11.loadFile(path.join(root, 'dist', 'diary.html'));
    await pause(400);

    await win11.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('div').forEach(d => {
        if (d.textContent && d.textContent.includes('채팅로그')) {
          d.style.display = 'none';
        }
      });

      const dialog = document.getElementById('diary-export-dialog');
      if (dialog) {
        dialog.showModal();
        const startInput = document.getElementById('diary-export-start');
        const endInput = document.getElementById('diary-export-end');
        if (startInput) startInput.value = '2026-09-01';
        if (endInput) endInput.value = '2026-09-28';

        const statusEl = document.getElementById('diary-export-status');
        if (statusEl) statusEl.textContent = '총 28일간의 활동 기록 (숙제 42회, 득템 15종, 누적 수익 3.8억 SEED)';
      }
    })()`);
    await pause(500);

    const img11 = await win11.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_11.png'), img11.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_11.png');
  } catch (err) {
    console.error('Failed 11:', err);
  } finally {
    win11.close();
  }

  await pause(200);

  // =============================================================
  // 12. notice_12.png : 사냥 경로 시뮬레이터(HPS) 동선 라벨 및 컨트롤
  // =============================================================
  console.log('[12/12] Capturing notice_12.png (Hunting Path Simulator Controls)...');
  const win12 = new BrowserWindow({
    width: 900,
    height: 840,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await win12.loadFile(path.join(root, 'dist', 'hunting-path-simulator.html'));
    await pause(500);

    await win12.webContents.executeJavaScript(`(() => {
      if (typeof window.pathNodes !== 'undefined' && Array.isArray(window.pathNodes)) {
        window.pathNodes = [
          { x: 300, y: 220 },
          { x: 450, y: 280 },
          { x: 600, y: 350 },
          { x: 420, y: 480 },
        ];
        if (typeof window.renderCanvas === 'function') window.renderCanvas();
      }
    })()`);
    await pause(400);

    const img12 = await win12.webContents.capturePage();
    fs.writeFileSync(path.join(noticeDir, 'notice_12.png'), img12.toPNG());
    console.log('  -> Saved: src/assets/notice/notice_12.png');
  } catch (err) {
    console.error('Failed 12:', err);
  } finally {
    win12.close();
  }

  console.log('ALL 12 NOTICE SCREENSHOTS CAPTURED SUCCESSFULLY!');
  app.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
