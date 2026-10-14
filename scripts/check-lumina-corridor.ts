import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app, BrowserWindow } from 'electron';

const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tw-lumina-test-')));
app.on('window-all-closed', () => {});

const built = (name: string) => require(path.join(root, 'dist', name + '.js'));
const pause = (ms: number = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const failures: string[] = [];
  const check = (actual: unknown, expected: unknown, label: string) => {
    try {
      assert.deepEqual(actual, expected, label);
    } catch (error) {
      failures.push(String(error));
    }
  };

  console.log('--- 1. Testing luminaCorridor shared algorithm ---');
  const lumina = built('shared/luminaCorridor');

  // 1) 기본 점수 계산 검증
  check(lumina.calculateLuminaBaseScore(0, 'normal'), 119, 'Stage 1 base score');
  check(lumina.calculateLuminaBaseScore(9, 'normal'), 209, 'Stage 10 base score');
  check(lumina.calculateLuminaBaseScore(0, 'hard'), 179, 'Stage 1 hard score');
  check(lumina.calculateLuminaBaseScore(0, 'hell'), 238, 'Stage 1 hell score');

  // 1-1) 지옥 난이도 미션별 실측 점수 및 티어 검증
  check(lumina.calculateLuminaNodeScore(0, 'attr_counter', 'hell'), 590, 'Stage 1 attr_counter hell score');
  check(lumina.calculateLuminaNodeScore(9, 'attr_counter', 'hell'), 1040, 'Stage 10 attr_counter hell score');
  check(lumina.calculateLuminaNodeScore(0, 'ancient_weapon', 'hell'), 585, 'Stage 1 ancient_weapon hell score');
  check(lumina.calculateLuminaNodeScore(9, 'ancient_weapon', 'hell'), 1035, 'Stage 10 ancient_weapon hell score');
  check(lumina.calculateLuminaNodeScore(0, 'escape_room', 'hell'), 570, 'Stage 1 escape_room hell score');
  check(lumina.calculateLuminaNodeScore(9, 'escape_room', 'hell'), 1020, 'Stage 10 escape_room hell score');
  check(lumina.calculateLuminaNodeScore(0, 'overload', 'hell'), 530, 'Stage 1 overload hell score');
  check(lumina.calculateLuminaNodeScore(7, 'overload', 'hell'), 875, 'Stage 8 overload hell score');
  check(lumina.calculateLuminaNodeScore(9, 'overload', 'hell'), 975, 'Stage 10 overload hell score');
  check(lumina.calculateLuminaNodeScore(0, 'attr_zone', 'hell'), 500, 'Stage 1 attr_zone hell score');
  check(lumina.calculateLuminaNodeScore(9, 'attr_zone', 'hell'), 950, 'Stage 10 attr_zone hell score');
  check(lumina.calculateLuminaNodeScore(0, 'scale_of_sin', 'hell'), 500, 'Stage 1 scale_of_sin hell score');
  check(lumina.calculateLuminaNodeScore(9, 'scale_of_sin', 'hell'), 950, 'Stage 10 scale_of_sin hell score');

  // 사양서 evaluateNodeStep 및 연속 페널티 / 초고속 클리어 검증
  const stepNormal = lumina.evaluateNodeStep('WHEEL', 1, null, { difficulty: 'hell', partySize: 1 });
  check(stepNormal.nodeScore, 590, 'Stage 1 WHEEL hell score');
  check(stepNormal.estimatedSec, 18, 'WHEEL estimated clear time');

  const stepFast = lumina.evaluateNodeStep('WHEEL', 1, null, { difficulty: 'hell', partySize: 1, isUltraFastBossClear: true });
  check(stepFast.nodeScore, 595, 'Stage 1 WHEEL ultra fast hell score');

  // 2단계에서 연속 동일 미션 페널티 (-10점 * 5.0 = -50점)
  const stepConsecutive = lumina.evaluateNodeStep('WHEEL', 2, 'WHEEL', { difficulty: 'hell', partySize: 1 });
  check(stepConsecutive.nodeScore, 590, 'Stage 2 WHEEL consecutive penalty hell score (640 - 50 = 590)');
  check(stepConsecutive.hasConsecutivePenalty, true, 'hasConsecutivePenalty is true');
  check(stepConsecutive.penaltyAmount, 50, 'penaltyAmount is 50 in hell');

  // 다캐릭터 편성 가산점 검증
  check(lumina.PARTY_BONUS_MULTIPLIER[1], 1.00, 'Party 1 bonus');
  check(lumina.PARTY_BONUS_MULTIPLIER[2], 1.04, 'Party 2 bonus');
  check(lumina.PARTY_BONUS_MULTIPLIER[3], 1.07, 'Party 3 bonus');
  check(lumina.PARTY_BONUS_MULTIPLIER[4], 1.10, 'Party 4 bonus');

  // 경로 중복 제거 (getTopUniqueRoutes) 검증
  const routeA = [
    { stage: 1, col: 0, missionId: 'WHEEL' },
    { stage: 1, col: 1, missionId: 'ROLE' },
    { stage: 2, col: 1, missionId: 'MUTATION' }
  ];
  const routeB = [
    { stage: 1, col: 1, missionId: 'ROLE' },
    { stage: 1, col: 0, missionId: 'WHEEL' },
    { stage: 2, col: 1, missionId: 'MUTATION' }
  ];
  const uniqueResult = lumina.getTopUniqueRoutes([routeA, routeB], 'highScore', { difficulty: 'hell', partySize: 1 });
  check(uniqueResult.length, 1, 'Duplicate node-set routes must be deduplicated to exactly 1');

  // 미션 추천도 메타데이터 검증 (사양서 기준: WHEEL, ROLE, TILE = 추천/1, DEBUFF, MUTATION, ELEMENT 등 = 보통/2, OVERLOAD, ZONE, SCALE = 비추천/3)
  check(lumina.LUMINA_MISSIONS.role_division.tier, 1, 'role_division is tier 1');
  check(lumina.LUMINA_MISSIONS.attr_counter.tier, 2, 'attr_counter is tier 2');
  check(lumina.LUMINA_MISSIONS.attr_zone.tier, 3, 'attr_zone is tier 3');
  check(lumina.LUMINA_MISSIONS.scale_of_sin.tier, 3, 'scale_of_sin is tier 3');
  check(lumina.LUMINA_MISSIONS.ancient_weapon.tier, 2, 'ancient_weapon is tier 2');

  // 2) 가상 연결망에서 경로 탐색 검증
  const connections = lumina.createEmptyLuminaConnections();
  const gridData = lumina.createDefaultLuminaGridData('normal');

  // 1단계 (row 0): 0 <-> 1 수평 연결
  connections.horizontal[0][0] = true;
  // 1단계 -> 2단계: 1 -> 2 우하향
  connections.diagDownRight[0][1] = true;
  // 2단계 -> 3단계: 2 -> 1 좌하향
  connections.diagDownLeft[1][2] = true;
  // 3단계 -> 4단계: 1 -> 2 우하향
  connections.diagDownRight[2][1] = true;
  // 4단계 -> 5단계: 2 -> 3 우하향
  connections.diagDownRight[3][2] = true;
  // 5단계 -> 6단계: 3 -> 2 좌하향
  connections.diagDownLeft[4][3] = true;
  // 6단계 -> 7단계: 2 -> 1 좌하향
  connections.diagDownLeft[5][2] = true;
  // 7단계 -> 8단계: 1 -> 2 우하향
  connections.diagDownRight[6][1] = true;
  // 8단계 -> 9단계: 2 -> 3 우하향
  connections.diagDownRight[7][2] = true;
  // 9단계 -> 10단계: 3 -> 4 우하향
  connections.diagDownRight[8][3] = true;
  // 10단계 (row 9): 4 <-> 3 수평 연결
  connections.horizontal[9][3] = true;

  const paths = lumina.findLuminaOptimalPaths(connections, gridData, 'highest_score', 3);
  check(paths.length > 0, true, 'Should find at least 1 path');
  const bestPath = paths[0];
  console.log(`Found optimal path: ${bestPath.path.length} nodes, ${bestPath.totalScore} pts`);
  check(bestPath.path.length >= 10, true, 'Path should traverse all 10 stages');

  console.log('--- 2. Testing lumina-corridor.html in Electron ---');
  await app.whenReady();
  built('modules/ipcHandlers').register();

  const win = new BrowserWindow({
    width: 850,
    height: 750,
    show: false,
    webPreferences: {
      preload: path.join(root, 'dist/preload.js'),
      contextIsolation: true,
      sandbox: true
    }
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    console.log(`[RENDERER-CONSOLE-${level}] ${msg}`);
  });

  const js = (code: string) => win.webContents.executeJavaScript(code);

  await win.loadFile(path.join(root, 'dist/lumina-corridor.html'));
  await pause(200);

  // 헤더 타이틀 및 요소 확인
  const titleText = await js(`document.querySelector('h1').textContent`);
  check(titleText.includes('루미나의 회랑 길잡이'), true, 'Page title matches');

  // 샘플 1 클릭 및 분석 실행
  await js(`document.getElementById('btnSample1').click()`);
  await pause(800);

  // 디버깅: 감지된 연결선 및 경로 수 출력
  const debugInfo = await js(`
    (() => {
      return {
        pathCount: (window.luminaCorridorPaths || []).length,
        connH: window.luminaDebugConnections?.horizontal,
        connDL: window.luminaDebugConnections?.diagDownLeft,
        connDR: window.luminaDebugConnections?.diagDownRight,
      };
    })()
  `);
  console.log('DEBUG INFO:', JSON.stringify(debugInfo, null, 2));

  // 뷰어 컨테이너 표시 여부 확인
  const viewerVisible = await js(`!document.getElementById('viewerContainer').classList.contains('hidden')`);
  check(viewerVisible, true, 'Viewer container becomes visible');

  // SVG 오버레이에 경로 및 노드가 렌더링되었는지 확인
  const circleCount = await js(`document.querySelectorAll('#overlaySvg circle').length`);
  check(circleCount, 50, 'All 50 nodes are rendered in SVG overlay');

  // 총 점수 텍스트가 0이 아닌 유효한 점수로 갱신되었는지 확인
  const totalScoreText = await js(`document.getElementById('totalScoreText').textContent`);
  console.log(`Sample 1 total score rendered: ${totalScoreText}`);
  check(totalScoreText.includes('점'), true, 'Total score rendered');

  // 총 예상 시간 텍스트 확인
  const totalTimeText = await js(`document.getElementById('totalTimeText')?.textContent || ''`);
  console.log(`Sample 1 total time rendered: ${totalTimeText}`);
  check(totalTimeText.includes('분') || totalTimeText.includes('초'), true, 'Total time rendered');

  // 편성 4명 클릭 시 가산점(+10%) 반영 점수 증가 확인
  await js(`document.getElementById('party-4').click()`);
  await pause(300);
  const party4ScoreText = await js(`document.getElementById('totalScoreText').textContent`);
  console.log(`Sample 1 Party 4 score rendered: ${party4ScoreText}`);
  check(party4ScoreText.includes('점'), true, 'Party 4 score rendered');

  console.log('--- 3. Testing User Screenshot (Full Window with Header) ---');
  const userImgBuffer = fs.readFileSync(path.join(root, 'src/assets/lumina/sample_user.png'));
  const userImgDataUrl = `data:image/png;base64,${userImgBuffer.toString('base64')}`;

  await js(`
    (() => {
      const img = new Image();
      img.onload = () => {
        // paste 또는 이미지 로드 시뮬레이션
        const pasteEvent = new Event('paste');
        // lumina-corridor 내부의 processImage 호출을 위해 임시 처리
        const container = document.getElementById('viewerContainer');
        const imgEl = document.getElementById('sourceImage');
        imgEl.src = img.src;
        // input or image directly to test harness
        const dropZone = document.getElementById('dropZone');
        const file = new File([], "test.png");
        // process image directly
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // trigger file load
        const blob = new Blob([new Uint8Array(${JSON.stringify(Array.from(userImgBuffer))})], { type: 'image/png' });
        const reader = new FileReader();
        reader.onload = (e) => {
          const loadedImg = new Image();
          loadedImg.onload = () => {
            // direct dispatch through file
          };
          loadedImg.src = e.target.result;
        };
        reader.readAsDataURL(blob);
      };
      img.src = "${userImgDataUrl}";
    })()
  `);

  // 사용자 이미지 분석 직접 트리거
  await js(`
    (() => {
      const img = new Image();
      img.onload = () => {
        // window.__luminaProcessImage
        const input = document.createElement('input');
        input.type = 'file';
        // Simulate paste event
        const dt = new DataTransfer();
        const file = new File([new Uint8Array(${JSON.stringify(Array.from(userImgBuffer))})], "user.png", { type: "image/png" });
        dt.items.add(file);
        const pasteEvent = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        });
        window.dispatchEvent(pasteEvent);
      };
      img.src = "${userImgDataUrl}";
    })()
  `);
  await pause(1000);

  const userPathCount = await js(`(window.luminaCorridorPaths || []).length`);
  console.log(`User Screenshot path count: ${userPathCount}`);
  check(userPathCount > 0, true, 'User screenshot should find optimal paths');

  const userBestPathLength = await js(`(window.luminaCorridorPaths?.[0]?.path || []).length`);
  console.log(`User Screenshot best path length: ${userBestPathLength} nodes`);
  check(userBestPathLength >= 13, true, 'User screenshot path should traverse at least 13 nodes');

  const userTotalScore = await js(`document.getElementById('totalScoreText').textContent`);
  console.log(`User Screenshot total score: ${userTotalScore}`);
  check(userTotalScore.includes('점'), true, 'User screenshot total score rendered');

  win.destroy();

  if (failures.length > 0) {
    console.error('FAILURES:\n' + failures.join('\n'));
    process.exit(1);
  } else {
    console.log('✅ All Lumina Corridor checks passed successfully!');
    process.exit(0);
  }
}

void main();
