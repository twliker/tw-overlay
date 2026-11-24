import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { HttpError } from 'builder-util-runtime';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-updater-network-'));
app.setPath('userData', fixture);
Object.defineProperty(app, 'getVersion', { value: () => '3.3.5-beta.1' });
Object.defineProperty(app, 'isPackaged', { value: true });

async function check(): Promise<void> {
  await app.whenReady();
  const updater = require(path.resolve(__dirname, '../dist/modules/updater')) as {
    setupUpdater(onReady: () => void): void;
    manualCheckForUpdate(window: null): Promise<void>;
    getCurrentStatus(): { state: string; message?: string } | null;
    setUpdateRestartConfirmation(hooks: { confirm(purpose: string): Promise<boolean>; release(): Promise<void> }): void;
    quitAndInstall(): Promise<void>;
    getIsUpdaterQuitting(): boolean;
  };
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const release = '/twliker/tw-overlay/releases';
  const metadata = `${release}/download/v3.3.5-beta.1`;
  const requests: string[] = [];
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => unhandled.push(reason);
  let metadataAvailable = false;
  const { httpExecutor } = autoUpdater as unknown as {
    httpExecutor: { request(options: { path?: string }): Promise<string> };
  };
  autoUpdater.logger = null;
  httpExecutor.request = async options => {
    const pathname = options.path || '';
    requests.push(pathname);
    if (pathname === `${release}.atom`) {
      return '<feed><entry><title>Beta</title><link href="https://github.com/twliker/tw-overlay/releases/tag/v3.3.5-beta.1"/><content>Beta</content></entry></feed>';
    }
    if (pathname === `${metadata}/beta.yml` && metadataAvailable) {
      return 'version: 3.3.5-beta.1\npath: installer.exe\nsha512: fixture\n';
    }
    if (pathname === `${metadata}/beta.yml` || pathname === `${metadata}/latest.yml`) {
      throw new HttpError(404);
    }
    throw new Error(`Unexpected update request: ${pathname}`);
  };
  autoUpdater.setFeedURL({ provider: 'github', owner: 'twliker', repo: 'tw-overlay', channel: 'beta' });
  process.on('unhandledRejection', recordUnhandled);
  try {
    let appLaunches = 0;
    await new Promise<void>(resolve => updater.setupUpdater(() => {
      appLaunches++;
      resolve();
    }));
    assert.deepEqual(requests, [`${release}.atom`, `${metadata}/beta.yml`, `${metadata}/latest.yml`]);
    assert.deepEqual(unhandled, [], 'The update lookup failed twice: as an updater error and an unhandled rejection.');
    assert.equal(updater.getCurrentStatus()?.state, 'error');
    assert.match(updater.getCurrentStatus()?.message || '', /업데이트 정보를 가져오지 못했습니다/);

    await updater.manualCheckForUpdate(null);
    assert.match(updater.getCurrentStatus()?.message || '', /업데이트 정보를 가져오지 못했습니다/);
    metadataAvailable = true;
    requests.length = 0;
    await updater.manualCheckForUpdate(null);
    assert.deepEqual(requests, [`${release}.atom`, `${metadata}/beta.yml`]);
    assert.equal(updater.getCurrentStatus()?.state, 'latest');
    assert.equal(appLaunches, 1);

    // 다운로드 완료 뒤 자동 재시작과 설정의 [재시작 및 설치]는 설치 전에 저장하지 않은 입력을 확인한다.
    // 사용자가 미루면 설치·종료 플래그 없이 'ready'를 유지하고(다음 종료 때 autoInstallOnAppQuit),
    // 승인한 경우에만 종료 플래그를 세운 뒤 설치한다. 설치 시작 실패는 플래그와 입력 잠금을 되돌린다.
    let installs = 0, releases = 0, answer = false;
    const purposes: string[] = [];
    (autoUpdater as unknown as { quitAndInstall(): void }).quitAndInstall = () => { installs++; };
    updater.setUpdateRestartConfirmation({
      confirm: async purpose => { purposes.push(purpose); await delay(50); return answer; },
      release: async () => { releases++; },
    });
    (autoUpdater as unknown as NodeJS.EventEmitter).emit('update-downloaded', { version: '3.3.6', releaseNotes: 'fixture notes' });
    assert.equal(updater.getCurrentStatus()?.state, 'ready');
    await delay(1500);
    void updater.quitAndInstall(); // 자동 재시작 확인 중 누른 버튼은 대화상자를 겹쳐 띄우지 않는다.
    await delay(400);
    assert.deepEqual(purposes, ['update'], '자동 재시작과 버튼이 한 번만 물어야 합니다.');
    assert.equal(installs, 0, '저장하지 않은 입력을 확인하지 않고 자동 설치하면 안 됩니다.');
    assert.equal(updater.getIsUpdaterQuitting(), false, '미룬 설치는 종료 확인 우회 플래그를 세우면 안 됩니다.');
    assert.equal(updater.getCurrentStatus()?.state, 'ready', '미룬 뒤에도 [재시작 및 설치]를 다시 제공해야 합니다.');
    assert.equal(appLaunches, 1);

    // 확인하는 사이 사용자가 승인한 일반 종료가 시작되면 재시작 설치로 바꾸지 않는다(종료 시 autoInstallOnAppQuit).
    const { appState } = require(path.resolve(__dirname, '../dist/modules/constants')) as { appState: { isQuitting: boolean } };
    updater.setUpdateRestartConfirmation({
      confirm: async purpose => { purposes.push(purpose); await delay(50); appState.isQuitting = true; return true; },
      release: async () => { releases++; },
    });
    try {
      await updater.quitAndInstall();
      assert.equal(installs, 0, '진행 중인 일반 종료를 업데이트 재시작으로 바꾸면 안 됩니다.');
      assert.equal(updater.getIsUpdaterQuitting(), false);
    } finally { appState.isQuitting = false; }
    updater.setUpdateRestartConfirmation({
      confirm: async purpose => { purposes.push(purpose); await delay(50); return answer; },
      release: async () => { releases++; },
    });
    purposes.splice(1); // 이 검사에서 추가된 확인 기록을 지워 아래 순서 검사를 원래 기준으로 유지한다.

    answer = true;
    await Promise.all([updater.quitAndInstall(), updater.quitAndInstall()]);
    assert.deepEqual(purposes, ['update', 'update']);
    assert.equal(installs, 1);
    assert.equal(updater.getIsUpdaterQuitting(), true);
    // 일반 자동 업데이트(CASE 1)도 스플래시 잠금을 건다. 오류 뒤에는 필수 여부와 관계없이 잠금을 풀어야 한다.
    const windowManager = require(path.resolve(__dirname, '../dist/modules/windowManager')) as { setMandatoryUpdateLock(lock: boolean): void };
    const lockCalls: boolean[] = [];
    windowManager.setMandatoryUpdateLock = lock => { lockCalls.push(lock); };
    autoUpdater.emit('error', new Error('fixture installer did not start'));
    await delay(50);
    assert.deepEqual(lockCalls, [false], '일반 업데이트 다운로드·설치 실패 뒤 스플래시 잠금을 풀어야 합니다.');
    assert.equal(updater.getIsUpdaterQuitting(), false, '설치가 시작되지 않으면 종료 플래그를 되돌려야 합니다.');
    assert.equal(releases, 1, '승인 중 걸어 둔 편집 창 잠금을 풀어야 합니다.');
    await delay(700); // error 처리의 앱 진입 예약(이미 진입한 상태)을 소비한다.
    assert.equal(appLaunches, 1);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
  await checkUpdateAfterStartupFailure();
}

/** 업데이트 모듈을 새 상태로 한 번 더 불러온다. electron-updater와 창 관리는 기록용 가짜로 바꾼다. */
function freshUpdater(fakes: Record<string, unknown>): any {
  const filename = path.resolve(__dirname, '../dist/modules/updater.js');
  const local = { exports: {} }, originalRequire = createRequire(filename);
  const run = vm.runInThisContext(`(function(exports,require,module,__dirname,__filename){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  run(local.exports, (key: string) => key in fakes ? fakes[key] : originalRequire(key), local, path.dirname(filename), filename);
  return local.exports;
}

/** 프로필 데이터 준비 실패 뒤에도 고친 새 버전을 받을 수 있어야 한다(데이터 이전 결함 복구 경로).
 * 시작 실패 확인은 앱 진입 없이 스플래시에서만 동작하고, 새 버전이 없거나 실패하면 종료 콜백을 한 번 부른다. */
async function checkUpdateAfterStartupFailure(): Promise<void> {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
  assert.match(mainSource, /await startProfileApplication\([\s\S]*?catch \(error\) \{[\s\S]*?await handleProfileStartupFailure\(error\);\s*return;/,
    '프로필 준비 실패 경로가 업데이트 확인 없이 종료하면 안 됩니다.');
  assert.match(mainSource, /async function handleProfileStartupFailure[\s\S]*?canCheckUpdateAfterStartupFailure\(\)[\s\S]*?whileSplashYieldsToPrompt[\s\S]*?checkUpdateAfterStartupFailure\(/,
    '시작 실패 안내는 스플래시를 양보시킨 뒤 묻고, 고른 경우 업데이트를 확인해야 합니다.');

  // 자동 업데이트를 끈 베타 설치본이어도, 사용자가 확인을 고른 시작 실패 뒤에는 새 버전을 받아 설치한다.
  const config = require(path.resolve(__dirname, '../dist/modules/config')) as { saveImmediate(patch?: object): void };
  config.saveImmediate({ autoUpdateEnabled: false });
  function scenario(events: (fake: NodeJS.EventEmitter) => void) {
    const fake = new EventEmitter() as EventEmitter & { checks: number; downloads: number; installs: number };
    Object.assign(fake, {
      checks: 0, downloads: 0, installs: 0,
      setFeedURL() {},
      checkForUpdates() { fake.checks++; setTimeout(() => events(fake), 10); return Promise.resolve(); },
      downloadUpdate() { fake.downloads++; return Promise.resolve([]); },
      quitAndInstall() { fake.installs++; },
    });
    const lockCalls: boolean[] = [];
    const wm = { setMandatoryUpdateLock: (lock: boolean) => { lockCalls.push(lock); }, getMainWindow: () => null,
      getSettingsWindow: () => null, getSplashWindow: () => null };
    const updater = freshUpdater({ 'electron-updater': { autoUpdater: fake }, './windowManager': wm });
    const confirms: string[] = [];
    updater.setUpdateRestartConfirmation({ confirm: async (purpose: string) => { confirms.push(purpose); return true; }, release: async () => {} });
    let finished = 0;
    updater.checkUpdateAfterStartupFailure(() => { finished++; });
    return { fake, lockCalls, confirms, updater, finished: () => finished };
  }

  const recovered = scenario(fake => fake.emit('update-available', { version: '3.3.6-beta.2', releaseNotes: 'fix' }));
  await delay(100);
  assert.equal(recovered.fake.checks, 1, '시작 실패 뒤에도 업데이트를 확인해야 합니다.');
  assert.deepEqual(recovered.lockCalls, [true], '새 버전은 스플래시 잠금 흐름으로 받아야 합니다.');
  assert.equal(recovered.fake.downloads, 1, '자동 업데이트 설정·베타 여부와 관계없이 고친 버전을 받아야 합니다.');
  assert.equal(recovered.finished(), 0, '다운로드 중에는 종료하면 안 됩니다.');
  recovered.fake.emit('update-downloaded', { version: '3.3.6-beta.2', releaseNotes: 'fix' });
  await delay(1700);
  assert.deepEqual(recovered.confirms, ['update'], '설치 전 초안 확인은 일반 업데이트와 같습니다.');
  assert.equal(recovered.fake.installs, 1, '받은 새 버전을 설치·재시작해야 합니다.');
  assert.equal(recovered.updater.getIsUpdaterQuitting(), true);
  assert.equal(recovered.finished(), 0);

  const latest = scenario(fake => fake.emit('update-not-available', {}));
  await delay(800);
  assert.equal(latest.fake.downloads, 0);
  assert.deepEqual(latest.lockCalls, []);
  assert.equal(latest.finished(), 1, '새 버전이 없으면 종료 콜백을 한 번 불러야 합니다.');

  const failed = scenario(fake => fake.emit('update-available', { version: '3.3.6', releaseNotes: 'fix' }));
  await delay(100);
  failed.fake.emit('error', new Error('fixture download failed'));
  await delay(800);
  assert.deepEqual(failed.lockCalls, [true, false], '다운로드가 실패하면 잠금을 풀어야 합니다.');
  assert.equal(failed.finished(), 1, '다운로드가 실패하면 종료 콜백을 한 번 불러야 합니다.');
  config.saveImmediate({ autoUpdateEnabled: true });
}

void check().then(() => {
  console.log('Beta update metadata failure, app launch and retry verified.');
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
