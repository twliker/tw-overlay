import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  };
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
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
}

void check().then(() => {
  console.log('Beta update metadata failure, app launch and retry verified.');
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
