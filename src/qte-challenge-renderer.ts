namespace QteChallengeRenderer {
type QteMode = 'practice' | 'challenge';
type QtePhase = 'idle' | 'ready' | 'active' | 'result' | 'game-over';

interface QteHistoryEntry {
  result: QteHitResult;
  label: string;
}

const QTE_RECORD_STORAGE_KEY = 'tw-overlay:qte-challenge:v1';
const qteApi = window.qteChallenge;

function qteElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`QTE element not found: ${id}`);
  return element as unknown as T;
}

const shell = qteElement<HTMLElement>('qte-shell');
const practiceTab = qteElement<HTMLButtonElement>('practice-tab');
const challengeTab = qteElement<HTMLButtonElement>('challenge-tab');
const soundToggle = qteElement<HTMLButtonElement>('sound-toggle');
const scoreValue = qteElement<HTMLElement>('score-value');
const comboValue = qteElement<HTMLElement>('combo-value');
const lifeValue = qteElement<HTMLElement>('life-value');
const stageValue = qteElement<HTMLElement>('stage-value');
const roundValue = qteElement<HTMLElement>('round-value');
const feverFill = qteElement<HTMLElement>('fever-fill');
const feverRoundsText = qteElement<HTMLElement>('fever-rounds');
const qteStage = qteElement<HTMLButtonElement>('qte-stage');
const blueArc = qteElement<SVGCircleElement>('blue-arc');
const yellowArc = qteElement<SVGCircleElement>('yellow-arc');
const needle = qteElement<HTMLElement>('needle');
const roundOverlay = qteElement<HTMLElement>('round-overlay');
const roundCaption = qteElement<HTMLElement>('round-caption');
const practiceSpeed = qteElement<HTMLSelectElement>('practice-speed');
const startButton = qteElement<HTMLButtonElement>('start-button');
const stopButton = qteElement<HTMLButtonElement>('stop-button');
const recentHistory = qteElement<HTMLElement>('recent-history');
const bestScore = qteElement<HTMLElement>('best-score');
const bestCombo = qteElement<HTMLElement>('best-combo');
const bestStage = qteElement<HTMLElement>('best-stage');
const greatRate = qteElement<HTMLElement>('great-rate');
const modeGuideTitle = qteElement<HTMLElement>('mode-guide-title');
const modeDescription = qteElement<HTMLElement>('mode-description');

let mode: QteMode = 'practice';
let phase: QtePhase = 'idle';
let sessionActive = false;
let currentRound: QteRoundDefinition | null = null;
let currentRoundStartedAt = 0;
let currentRoundFeverActive = false;
let animationFrameId: number | null = null;
let nextRoundTimer: number | null = null;
let pressedTimer: number | null = null;
let audioContext: AudioContext | null = null;

let practiceScore = 0;
let practiceCombo = 0;
let practiceAttempts = 0;
let practiceSuccess = 0;
let practiceGreat = 0;

let challengeScore = 0;
let challengeCombo = 0;
let challengeLives = 3;
let challengeRoundIndex = 0;
let challengeFeverMeter = 0;
let challengeFeverRounds = 0;

let history: QteHistoryEntry[] = [];
let records = loadQteRecords();

function loadQteRecords(): QteChallengeRecords {
  try {
    const raw = localStorage.getItem(QTE_RECORD_STORAGE_KEY);
    return qteApi.sanitizeQteChallengeRecords(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...qteApi.DEFAULT_QTE_RECORDS };
  }
}

function saveQteRecords(): void {
  try {
    localStorage.setItem(QTE_RECORD_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // 기록 저장 실패가 현재 게임 진행을 중단하지 않게 한다.
  }
}

function updateSoundButton(): void {
  soundToggle.classList.toggle('enabled', records.soundEnabled);
  soundToggle.innerHTML = `<i data-lucide="${records.soundEnabled ? 'volume-2' : 'volume-x'}" class="w-4 h-4"></i>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function ensureAudioContext(): AudioContext | null {
  if (!records.soundEnabled) return null;
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
  }
  if (audioContext.state === 'suspended') void audioContext.resume();
  return audioContext;
}

function playTone(frequency: number, delaySeconds: number, durationSeconds: number, volume: number): void {
  const context = ensureAudioContext();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const startAt = context.currentTime + delaySeconds;
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSeconds + 0.02);
}

function playResultSound(result: QteHitResult): void {
  if (result === 'great') {
    playTone(880, 0, 0.18, 0.12);
    playTone(1320, 0.07, 0.24, 0.1);
  } else if (result === 'success') {
    playTone(660, 0, 0.18, 0.09);
    playTone(880, 0.08, 0.18, 0.07);
  } else {
    playTone(190, 0, 0.24, 0.1);
  }
}

function setRoundOverlay(text: string, style: QteHitResult | 'ready' | null): void {
  roundOverlay.textContent = text;
  roundOverlay.className = 'round-overlay';
  if (style) roundOverlay.classList.add(style, 'show');
}

function setRoundCaption(title: string, detail: string): void {
  roundCaption.innerHTML = `<strong>${title}</strong>${detail}`;
}

function setArc(circle: SVGCircleElement, startDeg: number, sweepDeg: number): void {
  circle.style.strokeDasharray = `${sweepDeg} ${360 - sweepDeg}`;
  circle.style.strokeDashoffset = `${-qteApi.normalizeQteAngle(startDeg)}`;
}

function clearScheduledWork(): void {
  if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
  if (nextRoundTimer !== null) window.clearTimeout(nextRoundTimer);
  if (pressedTimer !== null) window.clearTimeout(pressedTimer);
  animationFrameId = null;
  nextRoundTimer = null;
  pressedTimer = null;
}

function currentStage(): number {
  return Math.floor(challengeRoundIndex / 10) + 1;
}

function renderHud(): void {
  if (mode === 'practice') {
    scoreValue.textContent = practiceScore.toLocaleString('ko-KR');
    comboValue.textContent = String(practiceCombo);
    lifeValue.textContent = '∞';
    stageValue.textContent = '연습';
    roundValue.textContent = String(practiceAttempts);
    feverFill.style.width = '0%';
    feverRoundsText.textContent = 'OFF';
    shell.classList.remove('fever-active');
    return;
  }

  scoreValue.textContent = challengeScore.toLocaleString('ko-KR');
  comboValue.textContent = String(challengeCombo);
  lifeValue.textContent = String(challengeLives);
  stageValue.textContent = String(currentStage());
  roundValue.textContent = `${challengeRoundIndex % 10 + 1}/10`;
  if (challengeFeverRounds > 0) {
    feverFill.style.width = '100%';
    feverRoundsText.textContent = `${challengeFeverRounds}R ×2`;
    shell.classList.add('fever-active');
  } else {
    feverFill.style.width = `${Math.min(100, challengeFeverMeter)}%`;
    feverRoundsText.textContent = `${Math.round(challengeFeverMeter)}%`;
    shell.classList.remove('fever-active');
  }
}

function renderRecords(): void {
  bestScore.textContent = records.bestScore.toLocaleString('ko-KR');
  bestCombo.textContent = String(records.bestCombo);
  bestStage.textContent = String(records.bestStage);
  const rate = records.totalSuccess > 0 ? Math.round(records.totalGreat / records.totalSuccess * 100) : 0;
  greatRate.textContent = `${rate}%`;

  const unlocked: Record<string, boolean> = {
    'first-success': records.totalSuccess >= 1,
    'combo-ten': records.bestCombo >= 10,
    'great-fifty': records.totalGreat >= 50,
    'stage-five': records.bestStage >= 5,
  };
  document.querySelectorAll<HTMLElement>('[data-achievement]').forEach(element => {
    element.classList.toggle('unlocked', unlocked[element.dataset.achievement || ''] === true);
  });
}

function renderHistory(): void {
  recentHistory.innerHTML = '';
  history.slice(-10).forEach(entry => {
    const chip = document.createElement('span');
    chip.className = `history-chip ${entry.result}`;
    chip.textContent = entry.label;
    recentHistory.appendChild(chip);
  });
  if (history.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'text-[10px] text-slate-600 font-bold';
    empty.textContent = '아직 판정 기록이 없습니다.';
    recentHistory.appendChild(empty);
  }
}

function addHistory(result: QteHitResult): void {
  history.push({ result, label: result === 'great' ? '대성공' : result === 'success' ? '성공' : '실패' });
  if (history.length > 10) history = history.slice(-10);
  renderHistory();
}

function updateSessionControls(running: boolean): void {
  startButton.classList.toggle('hidden', running);
  stopButton.classList.toggle('hidden', !running);
  practiceSpeed.disabled = running || mode === 'challenge';
}

function stopSession(showMessage = true): void {
  clearScheduledWork();
  sessionActive = false;
  phase = 'idle';
  currentRound = null;
  currentRoundFeverActive = false;
  qteStage.classList.remove('active', 'pressed', 'failed');
  needle.style.transform = 'rotate(0deg)';
  updateSessionControls(false);
  shell.classList.remove('fever-active');
  if (showMessage) {
    setRoundOverlay('시작 대기', 'ready');
    setRoundCaption('한 바퀴 안에 좌클릭!', '파란색은 성공, 노란색은 대성공입니다.');
  }
  renderHud();
}

function switchMode(nextMode: QteMode): void {
  if (mode === nextMode) return;
  stopSession(false);
  mode = nextMode;
  history = [];
  practiceTab.classList.toggle('active', mode === 'practice');
  challengeTab.classList.toggle('active', mode === 'challenge');
  practiceSpeed.classList.toggle('hidden', mode === 'challenge');
  startButton.querySelector('span')!.textContent = mode === 'practice' ? '연습 시작' : '챌린지 시작';
  modeGuideTitle.textContent = mode === 'practice' ? '실전 연습 규칙' : '챌린지 규칙';
  modeDescription.innerHTML = mode === 'practice'
    ? '<strong>색상 영역의 위치와 크기는 매번 바뀝니다.</strong><br>실전 속도는 영상 기준 약 1.2초이며 횟수 제한 없이 연습할 수 있습니다.'
    : '<strong>목숨 3개로 최고 점수에 도전합니다.</strong><br>영역은 매번 무작위로 바뀌고 10라운드마다 더 어려워집니다. 피버 중에는 5라운드 동안 점수가 2배입니다.';
  setRoundOverlay(mode === 'practice' ? '연습 대기' : '도전 대기', 'ready');
  renderHistory();
  renderHud();
}

function prepareNextRound(delayMs: number): void {
  if (!sessionActive) return;
  phase = 'ready';
  qteStage.classList.remove('active', 'pressed', 'failed');
  setRoundOverlay('READY', 'ready');
  setRoundCaption(
    mode === 'practice' ? '판정 영역을 확인하세요' : `STAGE ${currentStage()} · ROUND ${challengeRoundIndex % 10 + 1}`,
    '바늘이 색상 영역에 들어왔을 때 좌클릭하세요.',
  );
  nextRoundTimer = window.setTimeout(beginRound, delayMs);
}

function beginRound(): void {
  if (!sessionActive) return;
  nextRoundTimer = null;
  const difficulty = mode === 'practice'
    ? qteApi.getPracticeDifficulty(Number(practiceSpeed.value) || qteApi.QTE_ACTUAL_DURATION_MS)
    : qteApi.getQteChallengeDifficulty(currentStage());
  currentRound = qteApi.createQteRound({
    position: Math.random(),
    blueSweep: Math.random(),
    yellowSweep: Math.random(),
  }, difficulty);
  setArc(blueArc, currentRound.blueStartDeg, currentRound.blueSweepDeg);
  setArc(yellowArc, currentRound.yellowStartDeg, currentRound.yellowSweepDeg);
  needle.style.transform = 'rotate(0deg)';
  currentRoundFeverActive = mode === 'challenge' && challengeFeverRounds > 0;
  phase = 'active';
  qteStage.classList.add('active');
  qteStage.classList.remove('failed');
  setRoundOverlay('', null);
  setRoundCaption('NOW!', '한 바퀴가 끝나기 전에 좌클릭하세요.');
  currentRoundStartedAt = performance.now();

  if (mode === 'challenge') {
    records.bestStage = Math.max(records.bestStage, currentStage());
    saveQteRecords();
    renderRecords();
  }
  renderHud();
  animationFrameId = requestAnimationFrame(animateRound);
}

function animateRound(now: number): void {
  if (phase !== 'active' || !currentRound) return;
  const progress = Math.max(0, (now - currentRoundStartedAt) / currentRound.durationMs);
  const angle = Math.min(1, progress) * 360;
  needle.style.transform = `rotate(${angle}deg)`;
  if (progress >= 1) {
    finishRound('fail', angle, true);
    return;
  }
  animationFrameId = requestAnimationFrame(animateRound);
}

function circularSignedDistance(angleDeg: number, centerDeg: number): number {
  const normalized = qteApi.normalizeQteAngle(angleDeg - centerDeg + 180) - 180;
  return normalized === -180 ? 180 : normalized;
}

function describeHitTiming(result: QteHitResult, angleDeg: number, round: QteRoundDefinition): string {
  if (result === 'fail') return '판정 구간 밖에서 클릭했습니다.';
  const start = result === 'great' ? round.yellowStartDeg : round.blueStartDeg;
  const sweep = result === 'great' ? round.yellowSweepDeg : round.blueSweepDeg;
  const center = qteApi.normalizeQteAngle(start + sweep / 2);
  const offsetMs = Math.round(circularSignedDistance(angleDeg, center) / 360 * round.durationMs);
  if (Math.abs(offsetMs) <= 8) return '판정 영역의 정중앙입니다.';
  return `중앙보다 ${Math.abs(offsetMs)}ms ${offsetMs < 0 ? '빠릅니다' : '늦습니다'}.`;
}

function updateChallengeState(result: QteHitResult): number {
  records.totalAttempts++;
  let gainedScore = 0;
  if (result === 'fail') {
    challengeLives = Math.max(0, challengeLives - 1);
    challengeCombo = 0;
    if (challengeFeverRounds === 0) challengeFeverMeter = Math.max(0, challengeFeverMeter - 25);
  } else {
    challengeCombo++;
    gainedScore = qteApi.calculateQteScore(result, challengeCombo, currentRoundFeverActive);
    challengeScore += gainedScore;
    records.totalSuccess++;
    if (result === 'great') records.totalGreat++;
    records.bestCombo = Math.max(records.bestCombo, challengeCombo);
    if (!currentRoundFeverActive) {
      challengeFeverMeter += result === 'great' ? 35 : 10;
      if (challengeFeverMeter >= 100) {
        challengeFeverMeter = 0;
        challengeFeverRounds = 5;
      }
    }
  }
  if (currentRoundFeverActive) challengeFeverRounds = Math.max(0, challengeFeverRounds - 1);
  challengeRoundIndex++;
  records.bestScore = Math.max(records.bestScore, challengeScore);
  records.bestStage = Math.max(records.bestStage, currentStage());
  saveQteRecords();
  renderRecords();
  return gainedScore;
}

function updatePracticeState(result: QteHitResult): number {
  practiceAttempts++;
  if (result === 'fail') {
    practiceCombo = 0;
    return 0;
  }
  practiceCombo++;
  practiceSuccess++;
  if (result === 'great') practiceGreat++;
  const gainedScore = qteApi.calculateQteScore(result, practiceCombo, false);
  practiceScore += gainedScore;
  return gainedScore;
}

function finishRound(result: QteHitResult, angleDeg: number, timedOut: boolean): void {
  if (phase !== 'active' || !currentRound) return;
  if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
  phase = 'result';
  qteStage.classList.remove('active');
  qteStage.classList.toggle('failed', result === 'fail');
  needle.style.transform = `rotate(${Math.min(360, Math.max(0, angleDeg))}deg)`;

  const gainedScore = mode === 'practice'
    ? updatePracticeState(result)
    : updateChallengeState(result);
  addHistory(result);
  playResultSound(result);

  if (result === 'great') {
    setRoundOverlay('GREAT!', 'great');
    setRoundCaption('대성공!', `${describeHitTiming(result, angleDeg, currentRound)}${gainedScore ? ` +${gainedScore.toLocaleString('ko-KR')}점` : ''}`);
  } else if (result === 'success') {
    setRoundOverlay('SUCCESS', 'success');
    setRoundCaption('성공!', `${describeHitTiming(result, angleDeg, currentRound)}${gainedScore ? ` +${gainedScore.toLocaleString('ko-KR')}점` : ''}`);
  } else {
    setRoundOverlay('FAIL', 'fail');
    setRoundCaption('실패', timedOut ? '한 바퀴 동안 클릭하지 못했습니다.' : '판정 구간 밖에서 클릭했습니다.');
  }
  renderHud();

  if (mode === 'challenge' && challengeLives <= 0) {
    nextRoundTimer = window.setTimeout(endChallenge, 1_050);
    return;
  }
  nextRoundTimer = window.setTimeout(() => prepareNextRound(520), 720);
}

function endChallenge(): void {
  nextRoundTimer = null;
  sessionActive = false;
  phase = 'game-over';
  updateSessionControls(false);
  setRoundOverlay('GAME OVER', 'fail');
  const successRate = records.totalAttempts > 0
    ? Math.round((records.totalSuccess / records.totalAttempts) * 100)
    : 0;
  setRoundCaption(
    `${challengeScore.toLocaleString('ko-KR')}점 · STAGE ${currentStage()}`,
    `최대 콤보 ${records.bestCombo} · 누적 성공률 ${successRate}%`,
  );
  shell.classList.remove('fever-active');
}

function startSession(): void {
  stopSession(false);
  ensureAudioContext();
  sessionActive = true;
  phase = 'ready';
  history = [];
  if (mode === 'practice') {
    practiceScore = 0;
    practiceCombo = 0;
    practiceAttempts = 0;
    practiceSuccess = 0;
    practiceGreat = 0;
  } else {
    challengeScore = 0;
    challengeCombo = 0;
    challengeLives = 3;
    challengeRoundIndex = 0;
    challengeFeverMeter = 0;
    challengeFeverRounds = 0;
  }
  renderHistory();
  renderHud();
  updateSessionControls(true);
  prepareNextRound(650);
}

function handleQtePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || phase !== 'active' || !currentRound) return;
  event.preventDefault();
  qteStage.classList.add('pressed');
  if (pressedTimer !== null) window.clearTimeout(pressedTimer);
  pressedTimer = window.setTimeout(() => qteStage.classList.remove('pressed'), 120);
  const elapsed = performance.now() - currentRoundStartedAt;
  if (elapsed >= currentRound.durationMs) {
    finishRound('fail', 360, true);
    return;
  }
  const angle = Math.max(0, elapsed / currentRound.durationMs * 360);
  needle.style.transform = `rotate(${angle}deg)`;
  finishRound(qteApi.classifyQteHit(angle, currentRound), angle, false);
}

practiceTab.addEventListener('click', () => switchMode('practice'));
challengeTab.addEventListener('click', () => switchMode('challenge'));
startButton.addEventListener('click', startSession);
stopButton.addEventListener('click', () => stopSession());
qteStage.addEventListener('pointerdown', handleQtePointerDown);
qteStage.addEventListener('contextmenu', event => event.preventDefault());
soundToggle.addEventListener('click', () => {
  records.soundEnabled = !records.soundEnabled;
  saveQteRecords();
  updateSoundButton();
  if (records.soundEnabled) playTone(660, 0, 0.12, 0.07);
});

window.addEventListener('beforeunload', () => clearScheduledWork());

updateSoundButton();
renderHistory();
renderRecords();
renderHud();
if (typeof lucide !== 'undefined') lucide.createIcons();
if (window.bindEscapeClose) window.bindEscapeClose();
}
