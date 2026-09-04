import assert = require('node:assert/strict');
import crypto = require('node:crypto');
import childProcess = require('node:child_process');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import { app } from 'electron';

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src');
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-regression-'));
app.setPath('userData', isolatedUserData);
function cleanupIsolatedUserData(): void {
  try {
    fs.rmSync(isolatedUserData, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  } catch {
    // Windows의 종료 중 파일 핸들이 늦게 풀려도 테스트 결과를 가리지 않는다.
  }
}
process.once('exit', cleanupIsolatedUserData);

function finishRegressionChecks(exitCode: number): never {
  try {
    const diaryDb = require(path.join(projectRoot, 'dist', 'modules', 'diaryDb.js')) as { closeDb(): boolean };
    diaryDb.closeDb();
  } catch {
    // 실패 결과에서도 테스트 프로세스 종료를 보장한다.
  }
  cleanupIsolatedUserData();
  return (process as NodeJS.Process & { reallyExit(code: number): never }).reallyExit(exitCode);
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function spawnElectronProbe(
  args: string[],
  timeout: number,
  retryAccessViolation = false,
): childProcess.SpawnSyncReturns<string> {
  let lastResult: childProcess.SpawnSyncReturns<string> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    lastResult = childProcess.spawnSync(process.execPath, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    });
    if (!lastResult.error && lastResult.status === 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      return lastResult;
    }
    if (!retryAccessViolation || lastResult.status !== 0xC0000005 || attempt >= 2) return lastResult;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return lastResult!;
}

function spawnElectronProbeAsync(args: string[], timeout: number): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}> {
  return new Promise(resolve => {
    const child = childProcess.spawn(process.execPath, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ status: null, stdout, stderr, error: new Error(`probe timed out after ${timeout}ms`) });
    }, timeout);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.once('exit', status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function checkManualEvidenceCollector(): void {
  const fixtureRoot = path.join(isolatedUserData, 'manual-evidence-collector');
  const statePath = path.join(fixtureRoot, 'cloud-sync-state.json');
  const installerPath = path.join(fixtureRoot, 'twOverlay-test-installer.exe');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(installerPath, 'installer-fixture', 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    deviceId: 'secret-device-id',
    generationId: 'shared-generation-id',
    profileState: 'established',
    fileIds: { settings: 'secret-drive-file-id' },
    remoteRevisions: { settings: 'settings-revision', checklist: 'checklist-revision' },
    baseSettings: { discordWebhookUrl: 'secret-webhook-value' },
    baseChecklist: { characterPresets: [{ id: 'char-1', name: 'secret-character-name' }] },
    settingsDirtyKeys: ['userServer'],
    checklistOutbox: [{ id: 'outbox-operation-id' }],
    confirmedChecklistOperations: [{ id: 'confirmed-operation-id' }],
    restoreResults: [{
      kind: 'settings', selected: true, status: 'restored', revision: 'restore-revision',
      lastSyncedAt: 1234, error: 'secret-error-path C:\\Users\\secret',
    }],
    restorePartial: false,
    shutdownRecovery: {
      createdAt: 2000,
      settings: {
        dirtyKeys: ['userServer'], checksum: 'a'.repeat(64), remoteRevision: 'recovery-settings-revision',
      },
      checklist: {
        operationIds: ['outbox-operation-id'], checksum: 'b'.repeat(64),
        remoteRevision: 'recovery-checklist-revision',
      },
    },
    lastPullAt: 3000,
  }), 'utf8');

  const collectorPath = path.join(projectRoot, 'scripts', 'collect-v3-manual-evidence.ps1');
  const result = childProcess.spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', collectorPath,
    '-StatePath', statePath,
    '-InstallerPath', installerPath,
    '-DeviceLabel', 'PC-A',
  ], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(result.error, undefined, `실기 증거 수집기 실행 실패: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `실기 증거 수집기 비정상 종료:\n${result.stdout}\n${result.stderr}`);
  const evidence = JSON.parse(result.stdout) as any;
  assert.equal(evidence.deviceLabel, 'PC-A');
  assert.equal(evidence.installerSha256,
    crypto.createHash('sha256').update('installer-fixture').digest('hex').toUpperCase());
  assert.equal(evidence.profileState, 'established');
  assert.equal(evidence.generationId, 'shared-generation-id');
  assert.deepEqual(evidence.remoteRevisions,
    { settings: 'settings-revision', checklist: 'checklist-revision' });
  assert.deepEqual(evidence.settingsDirtyKeys, ['userServer']);
  assert.deepEqual(evidence.checklistOutboxIds, ['outbox-operation-id']);
  assert.deepEqual(evidence.confirmedOperationIds, ['confirmed-operation-id']);
  assert.equal(evidence.restoreResults[0].status, 'restored');
  assert.deepEqual(evidence.shutdownRecovery.checklist.operationIds, ['outbox-operation-id']);
  const serializedEvidence = JSON.stringify(evidence);
  for (const secret of [
    'secret-device-id', 'secret-drive-file-id', 'secret-webhook-value',
    'secret-character-name', 'secret-error-path', statePath, installerPath,
  ]) {
    assert.equal(serializedEvidence.includes(secret), false,
      `실기 증거 수집 결과에 제외 대상 값이 노출되었습니다: ${secret}`);
  }
}

function checkManualEvidenceComparator(): void {
  const fixtureRoot = path.join(isolatedUserData, 'manual-evidence-comparator');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const comparatorPath = path.join(projectRoot, 'scripts', 'compare-v3-manual-evidence.ps1');
  const makeEvidence = (deviceLabel: 'PC-A' | 'PC-B', overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    collectedAtUtc: '2026-08-26T00:00:00.000Z',
    deviceLabel,
    installerSha256: 'A'.repeat(64),
    profileState: 'established',
    generationId: 'shared-generation',
    remoteRevisions: { settings: 'settings-r10', checklist: 'checklist-r20' },
    settingsDirtyKeys: [],
    checklistOutboxIds: [],
    confirmedOperationIds: ['operation-a', 'operation-b'],
    restoreResults: [],
    restorePartial: false,
    shutdownRecovery: null,
    lastPullAt: 1000,
    ...overrides,
  });
  const writeEvidence = (name: string, evidence: unknown): string => {
    const target = path.join(fixtureRoot, name);
    fs.writeFileSync(target, JSON.stringify(evidence), 'utf8');
    return target;
  };
  const pcAPath = writeEvidence('pc-a.json', makeEvidence('PC-A'));
  const pcBPath = path.join(fixtureRoot, 'pc-b.json');
  fs.writeFileSync(pcBPath, Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(JSON.stringify(makeEvidence('PC-B')), 'utf16le'),
  ]));
  const laterAPath = writeEvidence('later-pc-a.json', makeEvidence('PC-A', { lastPullAt: 2000 }));
  const laterBPath = writeEvidence('later-pc-b.json', makeEvidence('PC-B', { lastPullAt: 2000 }));
  const runComparator = (args: string[]) => childProcess.spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', comparatorPath,
    ...args,
  ], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000, windowsHide: true });

  const success = runComparator([
    '-PcAPath', pcAPath,
    '-PcBPath', pcBPath,
    '-LaterPcAPath', laterAPath,
    '-LaterPcBPath', laterBPath,
    '-ExpectedOperationIds', 'operation-a,operation-b',
  ]);
  assert.equal(success.error, undefined, `실기 증거 비교기 실행 실패: ${success.error?.message || ''}`);
  assert.equal(success.status, 0, `실기 증거 비교기 비정상 종료:\n${success.stdout}\n${success.stderr}`);
  const passed = JSON.parse(success.stdout) as any;
  assert.equal(passed.passed, true);
  assert.equal(passed.laterSnapshotChecked, true);
  assert.deepEqual(passed.expectedOperationIds, ['operation-a', 'operation-b']);
  assert.deepEqual(passed.issues, []);

  const badBPath = writeEvidence('bad-pc-b.json', makeEvidence('PC-B', {
    generationId: 'different-generation',
    remoteRevisions: { settings: 'settings-r10', checklist: 'checklist-r21' },
    checklistOutboxIds: ['operation-b'],
    confirmedOperationIds: ['operation-a'],
  }));
  const failure = runComparator([
    '-PcAPath', pcAPath,
    '-PcBPath', badBPath,
    '-ExpectedOperationIds', 'operation-a,operation-b',
  ]);
  assert.equal(failure.error, undefined, `실패 증거 비교기 실행 실패: ${failure.error?.message || ''}`);
  assert.equal(failure.status, 1, `불일치 증거가 성공 처리됐습니다:\n${failure.stdout}\n${failure.stderr}`);
  const failed = JSON.parse(failure.stdout) as any;
  assert.equal(failed.passed, false);
  const issueCodes = failed.issues.map((issue: any) => issue.code);
  assert.ok(issueCodes.includes('generation-mismatch'));
  assert.ok(issueCodes.includes('checklist-revision-mismatch'));
  assert.ok(issueCodes.includes('checklist-outbox-pending'));
  assert.ok(issueCodes.includes('operation-not-confirmed'));

  const echoAPath = writeEvidence('echo-pc-a.json', makeEvidence('PC-A', {
    remoteRevisions: { settings: 'settings-r11', checklist: 'checklist-r20' },
  }));
  const echoBPath = writeEvidence('echo-pc-b.json', makeEvidence('PC-B', {
    remoteRevisions: { settings: 'settings-r11', checklist: 'checklist-r20' },
  }));
  const echoFailure = runComparator([
    '-PcAPath', pcAPath,
    '-PcBPath', pcBPath,
    '-LaterPcAPath', echoAPath,
    '-LaterPcBPath', echoBPath,
  ]);
  assert.equal(echoFailure.status, 1, '대기 중 revision 변화가 성공 처리됐습니다.');
  const echoResult = JSON.parse(echoFailure.stdout) as any;
  assert.ok(echoResult.issues.some((issue: any) => issue.code === 'unexpected-revision-change'));
}

function checkShutdownRecoveryAcrossProcessRestarts(): void {
  const probePath = path.join(projectRoot, 'dist-tools', 'runtime-shutdown-recovery-probe.js');
  const scenarios = ['settings', 'checklist', 'both'] as const;

  for (const scenario of scenarios) {
    const scenarioRoot = path.join(isolatedUserData, `shutdown-recovery-${scenario}`);
    fs.mkdirSync(scenarioRoot, { recursive: true });

    const run = (mode: 'write' | 'read') => {
      const resultPath = path.join(scenarioRoot, `${mode}-result.json`);
      const result = spawnElectronProbe([
        probePath,
        mode,
        scenario,
        scenarioRoot,
        resultPath,
      ], 20_000, true);
      assert.equal(result.error, undefined,
        `${scenario} ${mode} 종료 복구 프로세스 실행 실패: ${result.error?.message || ''}`);
      assert.equal(result.status, 0,
        `${scenario} ${mode} 종료 복구 프로세스 비정상 종료:\n${result.stdout}\n${result.stderr}`);
      assert.equal(fs.existsSync(resultPath), true,
        `${scenario} ${mode} 종료 복구 결과 파일이 없습니다.`);
      const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
        ok: boolean;
        error?: string;
        summary?: {
          profileState: string;
          settingsDirtyKeys: string[];
          checklistOperationIds: string[];
          recoverySettingsDirtyKeys: string[];
          recoveryChecklistOperationIds: string[];
        };
      };
      assert.equal(parsed.ok, true, parsed.error || `${scenario} ${mode} 종료 복구 probe 실패`);
      assert.ok(parsed.summary);
      return parsed.summary!;
    };

    const beforeRestart = run('write');
    const afterRestart = run('read');
    assert.deepEqual(afterRestart, beforeRestart,
      `${scenario} dirty/outbox/recovery marker가 프로세스 재시작 뒤 달라졌습니다.`);
    assert.equal(afterRestart.profileState, 'established');

    const expectsSettings = scenario === 'settings' || scenario === 'both';
    const expectsChecklist = scenario === 'checklist' || scenario === 'both';
    assert.deepEqual(afterRestart.settingsDirtyKeys, expectsSettings ? ['userServer'] : []);
    assert.deepEqual(afterRestart.recoverySettingsDirtyKeys, expectsSettings ? ['userServer'] : []);
    assert.equal(afterRestart.checklistOperationIds.length, expectsChecklist ? 1 : 0);
    assert.deepEqual(afterRestart.recoveryChecklistOperationIds, afterRestart.checklistOperationIds);
  }
}

/**
 * 제품의 일반 종료 대기 정책은 소스에서 정확히 3초로 고정하고, 실제 프로세스 종료 시각은
 * 바쁜 GitHub runner가 Electron의 최종 quit 이벤트를 늦게 전달할 수 있는 범위만 허용한다.
 * timeout 로그·요청 취소·복구 marker 검증을 함께 수행하므로 상한 완화가 정책 회귀를 숨기지 않는다.
 */
function assertShutdownTimeoutElapsed(elapsedMs: number | null, label: string): void {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.ts'), 'utf8');
  assert.match(
    mainSource,
    /const\s+flushTimeoutMs\s*=\s*isUpdating\s*\?\s*500\s*:\s*3000\s*;/,
    '일반 종료의 클라우드 flush 제한이 3초 정책에서 달라졌습니다.',
  );
  const upperBoundMs = process.env.CI ? 10_000 : 3_500;
  assert.ok(
    elapsedMs !== null && elapsedMs >= 2_900 && elapsedMs <= upperBoundMs,
    `${label}가 3초 제한 경계에서 끝나지 않았습니다: ${elapsedMs}ms (허용 상한 ${upperBoundMs}ms)`,
  );
}

function checkMainQuitRecoveryScenarios(): void {
  const probePath = path.join(projectRoot, 'dist-tools', 'runtime-main-quit-recovery-probe.js');
  const scenarios = ['settings', 'checklist', 'both', 'timeout', 'session-end'] as const;

  for (const scenario of scenarios) {
    const probeRoot = path.join(isolatedUserData, `main-quit-recovery-${scenario}`);
    const resultPath = path.join(probeRoot, 'result.json');
    fs.mkdirSync(probeRoot, { recursive: true });
    const result = spawnElectronProbe([
      probePath,
      scenario,
      probeRoot,
      resultPath,
      '--dev',
    ], 20_000);
    assert.equal(result.error, undefined,
      `${scenario} main quit probe 실행 실패: ${result.error?.message || ''}`);
    assert.equal(result.status, 0,
      `${scenario} main quit probe 비정상 종료:\n${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(resultPath), true, `${scenario} main quit 결과 파일이 없습니다.`);

    const summary = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      quitElapsedMs: number | null;
      firstVisibleWindowCount: number;
      hideLatencyMs: number | null;
      settingsDirtyKeys: string[];
      checklistOperationIds: string[];
      recoverySettingsDirtyKeys: string[];
      recoveryChecklistOperationIds: string[];
      walCheckpointLogged: boolean;
      databaseCloseLogged: boolean;
      cancelledRequestCount: number;
      shutdownTimeoutLogged: boolean;
      beforeQuitCount: number;
      sessionEndObservation: null | {
        prevented: boolean;
        recoverySettingsDirtyKeys: string[];
        recoveryChecklistOperationIds: string[];
        walCheckpointLogged: boolean;
      };
    };
    const expectsSettings = scenario === 'settings' || scenario === 'both'
      || scenario === 'timeout' || scenario === 'session-end';
    const expectsChecklist = scenario === 'checklist' || scenario === 'both'
      || scenario === 'timeout' || scenario === 'session-end';
    const expectedOperationIds = expectsChecklist ? [`main-quit-${scenario}-operation`] : [];
    if (scenario === 'timeout') {
      assertShutdownTimeoutElapsed(summary.quitElapsedMs, 'timeout main quit');
    } else {
      assert.ok(summary.quitElapsedMs !== null && summary.quitElapsedMs <= 3_000,
        `${scenario} main quit가 3초 제한을 넘었습니다: ${summary.quitElapsedMs}`);
    }
    assert.ok(summary.firstVisibleWindowCount > 0, `${scenario} main quit 전에 표시 창이 없었습니다.`);
    assert.ok(summary.hideLatencyMs !== null && summary.hideLatencyMs <= 100,
      `${scenario} main quit 창 숨김이 늦었습니다: ${summary.hideLatencyMs}`);
    if (scenario === 'timeout') {
      assert.ok(summary.settingsDirtyKeys.includes('userServer'));
      assert.deepEqual(
        [...summary.recoverySettingsDirtyKeys].sort(),
        [...summary.settingsDirtyKeys].sort(),
        'timeout main quit recovery marker가 종료 시점의 settings dirty 집합을 모두 보존하지 않았습니다.',
      );
    } else {
      assert.deepEqual(summary.settingsDirtyKeys, expectsSettings ? ['userServer'] : []);
      assert.deepEqual(summary.recoverySettingsDirtyKeys, expectsSettings ? ['userServer'] : []);
    }
    assert.deepEqual(summary.checklistOperationIds, expectedOperationIds);
    assert.deepEqual(summary.recoveryChecklistOperationIds, expectedOperationIds);
    assert.equal(summary.walCheckpointLogged, true, `${scenario} main quit WAL checkpoint 로그가 없습니다.`);
    assert.equal(summary.databaseCloseLogged, true, `${scenario} main quit DB close 로그가 없습니다.`);
    assert.equal(summary.cancelledRequestCount, scenario === 'timeout' ? 1 : 0,
      `${scenario} main quit Drive 요청 취소 횟수가 다릅니다.`);
    assert.equal(summary.shutdownTimeoutLogged, scenario === 'timeout',
      `${scenario} main quit timeout 로그 상태가 다릅니다.`);
    assert.equal(summary.beforeQuitCount, scenario === 'timeout' ? 3 : 2,
      `${scenario} main quit의 외부 요청/finalizer 경계 횟수가 다릅니다.`);
    if (scenario === 'session-end') {
      assert.ok(summary.sessionEndObservation);
      assert.equal(summary.sessionEndObservation.prevented, false,
        'query-session-end fast path가 Windows 세션 종료를 취소했습니다.');
      assert.deepEqual(summary.sessionEndObservation.recoverySettingsDirtyKeys, ['userServer']);
      assert.deepEqual(summary.sessionEndObservation.recoveryChecklistOperationIds, expectedOperationIds);
      assert.equal(summary.sessionEndObservation.walCheckpointLogged, true,
        'query-session-end fast path가 WAL checkpoint를 동기식으로 끝내지 않았습니다.');
    } else {
      assert.equal(summary.sessionEndObservation, null);
    }
  }
}

function checkMainResponseLossRestartReconciliation(): void {
  const probePath = path.join(projectRoot, 'dist-tools', 'runtime-main-response-loss-probe.js');
  for (const responseLossKind of ['settings', 'checklist'] as const) {
    const probeRoot = path.join(isolatedUserData, `main-response-loss-restart-${responseLossKind}`);
    fs.mkdirSync(probeRoot, { recursive: true });

    const run = (mode: 'loss' | 'restart') => {
      const resultPath = path.join(probeRoot, `${mode}-result.json`);
      const result = spawnElectronProbe([
        probePath,
        mode,
        probeRoot,
        resultPath,
        responseLossKind,
        '--dev',
      ], 20_000);
      assert.equal(result.error, undefined,
        `${responseLossKind} ${mode} response loss main probe 실행 실패: ${result.error?.message || ''}`);
      assert.equal(result.status, 0,
        `${responseLossKind} ${mode} response loss main probe 비정상 종료:\n${result.stdout}\n${result.stderr}`);
      assert.equal(fs.existsSync(resultPath), true,
        `${responseLossKind} ${mode} response loss 결과 파일이 없습니다.`);
      const summary = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as any;
      assert.equal(summary.probeError, null,
        summary.probeError || `${responseLossKind} ${mode} response loss probe 실패`);
      return summary;
    };

    const lostResponse = run('loss');
    assertShutdownTimeoutElapsed(lostResponse.quitElapsedMs, `${responseLossKind} response loss main quit`);
    assert.equal(lostResponse.cancelledRequestCount, 1);
    assert.equal(lostResponse.shutdownTimeoutLogged, true);
    assert.equal(lostResponse.checklistOperationIds.includes('response-loss-checklist-operation'), true,
      '응답 유실 뒤 로컬 outbox에서 검증 대상 숙제 operation이 사라졌습니다.');
    assert.deepEqual(
      [...lostResponse.recoveryChecklistOperationIds].sort(),
      [...lostResponse.checklistOperationIds].sort(),
      `${responseLossKind} 응답 유실 marker가 로컬 outbox operation을 모두 보존하지 않았습니다.`,
    );

    if (responseLossKind === 'settings') {
      assert.ok(lostResponse.settingsDirtyKeys.includes('userServer'));
      assert.deepEqual(
        [...lostResponse.recoverySettingsDirtyKeys].sort(),
        [...lostResponse.settingsDirtyKeys].sort(),
        '설정 응답 유실 marker가 settings dirty key를 모두 보존하지 않았습니다.',
      );
      const remoteSettings = lostResponse.remoteStore.files['tw_overlay_settings.json'];
      assert.equal(remoteSettings.payload.data.userServer, 1,
        '응답 유실 전에 commit된 원격 설정 payload가 없습니다.');
      assert.equal(lostResponse.remoteStore.uploadCounts['tw_overlay_settings.json'], 1);
      assert.equal(lostResponse.remoteStore.uploadCounts['tw_overlay_checklist.json'], undefined);
    } else {
      const remoteChecklist = lostResponse.remoteStore.files['tw_overlay_checklist.json'];
      const remoteChecklistOperationIds = remoteChecklist.payload.operations
        .map((operation: any) => operation.id);
      for (const operationId of lostResponse.checklistOperationIds) {
        assert.equal(remoteChecklistOperationIds.includes(operationId), true,
          `응답 유실 전에 commit된 원격 payload에 숙제 operation ${operationId}이(가) 없습니다.`);
      }
      assert.equal(lostResponse.remoteStore.uploadCounts['tw_overlay_checklist.json'], 1);
    }

    const restarted = run('restart');
    assert.ok(restarted.convergenceObservation);
    assert.deepEqual(restarted.convergenceObservation.settingsDirtyKeys, []);
    assert.deepEqual(restarted.convergenceObservation.checklistOperationIds, []);
    assert.deepEqual(restarted.convergenceObservation.recoverySettingsDirtyKeys, []);
    assert.deepEqual(restarted.convergenceObservation.recoveryChecklistOperationIds, []);
    assert.equal(restarted.convergenceObservation.confirmedChecklistOperationIds
      .includes('response-loss-checklist-operation'), true);
    if (responseLossKind === 'settings') {
      assert.equal(restarted.convergenceObservation.settingsUploadCount, 1,
        '설정 응답 유실 재확인이 이미 commit된 설정 payload를 중복 업로드했습니다.');
      assert.ok(restarted.convergenceObservation.checklistUploadCount >= 1,
        '설정 응답 유실 뒤 미전송 숙제 outbox가 처리되지 않았습니다.');
    } else {
      assert.equal(restarted.convergenceObservation.checklistUploadCount, 1,
        '숙제 응답 유실 재확인이 이미 commit된 숙제 payload를 중복 업로드했습니다.');
      assert.ok(restarted.convergenceObservation.settingsUploadCount >= 1,
        '숙제 응답 유실 뒤 설정 dirty가 처리되지 않았습니다.');
    }
  }
}

function checkMainPartialRestoreConfirmationGate(): void {
  const probePath = path.join(projectRoot, 'dist-tools', 'runtime-main-partial-restore-probe.js');
  const probeRoot = path.join(isolatedUserData, 'main-partial-restore');
  const reverseProbeRoot = path.join(isolatedUserData, 'main-reverse-partial-restore');
  const rollbackProbeRoot = path.join(isolatedUserData, 'main-rollback-restore');
  fs.mkdirSync(probeRoot, { recursive: true });
  fs.mkdirSync(reverseProbeRoot, { recursive: true });
  fs.mkdirSync(rollbackProbeRoot, { recursive: true });

  const run = (mode: 'partial' | 'reverse-partial' | 'blocked' | 'confirmed' | 'rollback', root = probeRoot) => {
    const resultPath = path.join(root, `${mode}-result.json`);
    const result = spawnElectronProbe([
      probePath,
      mode,
      root,
      resultPath,
      '--dev',
    ], 20_000);
    assert.equal(result.error, undefined,
      `${mode} partial restore main probe 실행 실패: ${result.error?.message || ''}`);
    assert.equal(result.status, 0,
      `${mode} partial restore main probe 비정상 종료:\n${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(resultPath), true, `${mode} partial restore 결과 파일이 없습니다.`);
    const summary = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as any;
    assert.equal(summary.probeError, null, summary.probeError || `${mode} partial restore probe 실패`);
    return summary;
  };

  const partial = run('partial');
  assert.equal(partial.observation.profileState, 'needs-confirmation');
  assert.equal(partial.observation.settingsStatus, 'invalid');
  assert.equal(partial.observation.checklistStatus, 'restored');
  assert.deepEqual(partial.observation.characterPresetIds, ['remote-character']);
  assert.deepEqual(partial.remoteStore.uploadCounts, {},
    '부분 복원 후 사용자 확인 전에 시작/종료 파생 변경이 원격 파일을 덮어썼습니다.');

  const reversePartial = run('reverse-partial', reverseProbeRoot);
  assert.equal(reversePartial.observation.profileState, 'needs-confirmation');
  assert.equal(reversePartial.observation.settingsStatus, 'restored');
  assert.equal(reversePartial.observation.checklistStatus, 'invalid');
  assert.equal(reversePartial.observation.userServer, 16,
    '정상 설정 파일이 손상된 숙제 파일과 독립적으로 복원되지 않았습니다.');
  assert.deepEqual(reversePartial.observation.characterPresetIds, ['local-default'],
    '손상된 숙제 파일 때문에 기존 로컬 숙제/캐릭터 설정이 변경되었습니다.');
  assert.deepEqual(reversePartial.remoteStore.uploadCounts, {},
    '역방향 부분 복원 후 사용자 확인 전에 시작/종료 파생 변경이 원격 파일을 덮어썼습니다.');

  run('partial', rollbackProbeRoot);
  const rollback = run('rollback', rollbackProbeRoot);
  assert.equal(rollback.observation.profileState, 'established');
  assert.equal(rollback.observation.restoredObservation.userServer, 16);
  assert.deepEqual(rollback.observation.restoredObservation.characterPresetIds,
    ['rollback-remote-character']);
  assert.equal(rollback.observation.rolledBackUserServer, 7);
  assert.deepEqual(rollback.observation.rolledBackCharacterPresetIds, ['remote-character']);
  assert.equal(rollback.observation.remoteServer, 7,
    '되돌린 로컬 설정이 후속 자동 동기화로 원격에 반영되지 않았습니다.');
  assert.deepEqual(rollback.observation.remoteCharacterIds, ['remote-character'],
    '되돌린 로컬 숙제/캐릭터가 후속 자동 동기화로 원격에 반영되지 않았습니다.');
  assert.deepEqual(rollback.observation.settingsDirtyKeys, []);
  assert.deepEqual(rollback.observation.checklistOperationIds, []);
  assert.equal(rollback.observation.uploadCounts['tw_overlay_settings.json'], 1);
  assert.equal(rollback.observation.uploadCounts['tw_overlay_checklist.json'], 1);

  const blocked = run('blocked');
  assert.equal(blocked.observation.profileState, 'needs-confirmation');
  assert.equal(blocked.observation.userServer, 7,
    'needs-confirmation 재시작에서 원격 설정이 자동 적용되었습니다.');
  assert.equal(blocked.observation.downloadCount, 0,
    'needs-confirmation 재시작에서 사용자 선택 전에 원격 파일을 다운로드했습니다.');
  assert.deepEqual(blocked.remoteStore.uploadCounts, blocked.phaseStartUploadCounts,
    'needs-confirmation 재시작에서 사용자 선택 전에 원격 파일을 업로드했습니다.');
  assert.equal(blocked.remoteStore.files['corrupt-settings'].payload.data.userServer, 16,
    'needs-confirmation 재시작에서 원격 설정을 로컬 값으로 덮어썼습니다.');

  const confirmed = run('confirmed');
  assert.equal(confirmed.observation.profileState, 'established');
  assert.equal(confirmed.observation.userServer, 17);
  assert.deepEqual(confirmed.observation.characterPresetIds, ['remote-character'],
    '설정만 선택한 복원이 원격 숙제/캐릭터 파일까지 적용했습니다.');
  assert.equal(confirmed.observation.remoteServer, 17,
    '수동 복원 확인 뒤 설정 자동 업로드가 재개되지 않았습니다.');
  assert.equal(confirmed.remoteStore.uploadCounts['tw_overlay_settings.json'], 1);
  assert.equal(confirmed.observation.uploadCounts['tw_overlay_checklist.json'], undefined,
    '설정 선택 복원 직후 변경하지 않은 숙제 파일이 함께 업로드되었습니다.');
}

async function checkMainConcurrentCrossUploadConvergence(): Promise<void> {
  const probePath = path.join(projectRoot, 'dist-tools', 'runtime-main-cross-upload-probe.js');
  for (const scenario of ['nonconflict', 'same-field'] as const) {
    const probeRoot = path.join(isolatedUserData, `main-cross-upload-${scenario}`);
    fs.mkdirSync(probeRoot, { recursive: true });

    for (const device of ['company', 'home'] as const) {
      const resultPath = path.join(probeRoot, `${device}-prepare-result.json`);
      const result = spawnElectronProbe([
        probePath, 'prepare', device, probeRoot, resultPath, scenario, '--dev',
      ], 20_000);
      assert.equal(result.error, undefined,
        `${scenario} ${device} cross upload prepare 실행 실패: ${result.error?.message || ''}`);
      assert.equal(result.status, 0,
        `${scenario} ${device} cross upload prepare 비정상 종료:\n${result.stdout}\n${result.stderr}`);
    }

    const runDevice = async (device: 'company' | 'home') => {
      const resultPath = path.join(probeRoot, `${device}-run-result.json`);
      const result = await spawnElectronProbeAsync([
        probePath, 'run', device, probeRoot, resultPath, scenario, '--dev',
      ], 35_000);
      assert.equal(result.error, undefined,
        `${scenario} ${device} concurrent main probe 실행 실패: ${result.error?.message || ''}`);
      assert.equal(result.status, 0,
        `${scenario} ${device} concurrent main probe 비정상 종료:\n${result.stdout}\n${result.stderr}`);
      assert.equal(fs.existsSync(resultPath), true,
        `${scenario} ${device} concurrent main 결과 파일이 없습니다.`);
      const summary = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as any;
      assert.equal(summary.probeError, null,
        summary.probeError || `${scenario} ${device} concurrent main probe 실패`);
      return summary;
    };

    const [company, home] = await Promise.all([runDevice('company'), runDevice('home')]);
    const expectedOperationIds = [
      `cross-upload-${scenario}-company-operation`,
      `cross-upload-${scenario}-home-operation`,
    ];
    assert.equal(company.observation.firstChecklistRevision, home.observation.firstChecklistRevision,
      `${scenario} 두 main 프로세스의 첫 숙제 다운로드가 같은 원격 revision에서 교차하지 않았습니다.`);
    for (const [device, summary] of [['company', company], ['home', home]] as const) {
      assert.deepEqual(summary.observation.remoteOperationIds, expectedOperationIds,
        `${scenario} ${device}가 확인한 최종 원격 payload에 두 operation ID가 남지 않았습니다.`);
      assert.deepEqual(summary.observation.confirmedOperationIds, expectedOperationIds,
        `${scenario} ${device} 로컬 확인 이력에 두 operation ID가 남지 않았습니다.`);
      assert.deepEqual(summary.observation.checklistOutboxIds, []);
    }
    if (scenario === 'nonconflict') {
      assert.equal(company.observation.companyState.currentCount, 1);
      assert.equal(company.observation.homeState.currentCount, 2);
      assert.equal(home.observation.companyState.currentCount, 1);
      assert.equal(home.observation.homeState.currentCount, 2);
    } else {
      const expectedHomeCompletedAt = Number(fs.readFileSync(
        path.join(probeRoot, 'completion-time-base.txt'),
        'utf8',
      )) + 2_000;
      assert.deepEqual(company.observation.companyState, home.observation.companyState,
        '동일 숙제·캐릭터 충돌에서 회사/집 로컬 상태가 수렴하지 않았습니다.');
      assert.deepEqual(company.observation.companyState, company.observation.remoteCompanyState,
        '동일 숙제·캐릭터 충돌에서 최종 원격과 회사 로컬 상태가 다릅니다.');
      assert.equal(company.observation.companyState.isCompleted, true,
        '회사 PC의 완료 변경이 집 PC의 횟수 변경과 결합되지 않았습니다.');
      assert.equal(company.observation.companyState.currentCount, 2,
        '동일 횟수 필드 충돌에서 더 늦은 집 PC operation 값이 보존되지 않았습니다.');
      assert.equal(company.observation.companyState.lastCompletedAt, expectedHomeCompletedAt,
        '동일 완료 시각 필드 충돌에서 더 늦은 집 PC operation 값이 보존되지 않았습니다.');
    }
    assert.ok(company.remoteStore.checklistUploadOrder.filter((device: string) => device === 'company').length >= 1);
    assert.ok(company.remoteStore.checklistUploadOrder.filter((device: string) => device === 'home').length >= 1);
    assert.ok(company.remoteStore.checklistUploadOrder.length >= 3,
      `${scenario} 교차 overwrite 뒤 누락 operation 재게시가 발생하지 않았습니다.`);
    assert.deepEqual(new Set(company.remoteStore.checklistUploadOrder.slice(0, 2)), new Set(['company', 'home']),
      `${scenario} 최초 교차 업로드가 서로 다른 두 main 프로세스에서 발생하지 않았습니다.`);
    assert.equal(fs.existsSync(path.join(probeRoot, 'company-first-download.ready')), true);
    assert.equal(fs.existsSync(path.join(probeRoot, 'home-first-download.ready')), true);
    assert.equal(fs.existsSync(path.join(probeRoot, 'company-first-checklist-upload.ready')), true);
    assert.equal(fs.existsSync(path.join(probeRoot, 'home-first-checklist-upload.ready')), true);

    const storePath = path.join(probeRoot, 'remote-store.json');
    const uploadsBeforeRestart = JSON.parse(fs.readFileSync(storePath, 'utf8')).uploadOrder;
    for (const device of ['company', 'home'] as const) {
      const restarted = await runDevice(device);
      assert.deepEqual(restarted.observation.remoteOperationIds, expectedOperationIds,
        `${scenario} ${device} 재시작 후 원격 operation 확인 결과가 달라졌습니다.`);
      assert.deepEqual(restarted.observation.confirmedOperationIds, expectedOperationIds,
        `${scenario} ${device} 재시작 후 로컬 확인 operation 이력이 사라졌습니다.`);
      assert.deepEqual(restarted.observation.checklistOutboxIds, []);
      if (scenario === 'same-field') {
        assert.deepEqual(restarted.observation.companyState, company.observation.companyState,
          `${device} 재시작 후 동일 필드 충돌 결과가 달라졌습니다.`);
      }
      const uploadsAfterRestart = JSON.parse(fs.readFileSync(storePath, 'utf8')).uploadOrder;
      assert.deepEqual(uploadsAfterRestart, uploadsBeforeRestart,
        `${scenario} ${device} 재시작이 변경 없는 숙제 echo upload를 만들었습니다.`);
    }
  }
}

function createUiUtilsSandbox(): any {
  const registeredListeners: Record<string, Array<() => void>> = {};
  const window: any = {
    addEventListener(event: string, callback: () => void) {
      (registeredListeners[event] ||= []).push(callback);
    },
    __registeredListeners: registeredListeners,
  };
  const sandbox = {
    window,
    document: {},
    fetch: async () => ({ json: async () => [] }),
    setInterval,
    clearInterval,
    console,
  };
  vm.runInNewContext(read('dist/assets/ui-utils.js'), sandbox, {
    filename: 'dist/assets/ui-utils.js',
  });
  return window;
}

function checkCommonFormatters() {
  const ui = createUiUtilsSandbox();

  assert.equal(ui.formatElapsedTime(0), '00:00:00');
  assert.equal(ui.formatElapsedTime(3_661_000), '01:01:01');
  assert.equal(ui.formatSeedAmount(0), '0 시드');
  assert.equal(ui.formatSeedAmount(9_999), '9,999 시드');
  assert.equal(ui.formatSeedAmount(123_456_789), '1억 2345만 시드');
  assert.equal(
    ui.normalizeChatDisplayText('앞&nbsp;중간&nbsp뒤\u00a0끝'),
    '앞 중간 뒤 끝',
  );
  assert.equal(
    ui.normalizeChatDisplayText('&nbsp &nbsp &nbsp &nbsp &nbsp 을 것이오!'),
    '을 것이오!',
  );
  assert.deepEqual(
    ['하늘2', '가람', '하늘10', '나래'].sort(ui.compareKoreanText),
    ['가람', '나래', '하늘2', '하늘10'],
  );
  assert.equal(ui.escapeHtml('<a "b">&'), '&lt;a &quot;b&quot;&gt;&amp;');
  assert.equal(ui.escapeHtmlText('<a "b">&'), '&lt;a "b"&gt;&amp;');
  assert.equal(ui.escapeHtmlAttribute(`'"><&`), '&#039;&quot;&gt;&lt;&amp;');

  assert.deepEqual(
    { ...ui.getBossToastPresentation('골론', false, '12:30', 5) },
    {
      isRealBoss: true,
      validSpawnTime: '12:30',
      displayName: '[12:30] 골론 <span class="text-xs text-slate-500 font-medium ml-1">5분 전</span>',
      iconName: 'skull',
      iconColor: 'text-[#a855f7]',
    },
  );
  assert.deepEqual(
    { ...ui.getScamToastPresentation({
      verdict: 'SCAM',
      analysisReason: '<송금> & 요구\n둘째 줄',
    }) },
    {
      isScam: true,
      title: '🚨 사기 위험 감지!',
      colorClass: 'text-red-400',
      reason: '&lt;송금&gt; &amp; 요구',
    },
  );

  let cleanupCount = 0;
  ui.electronAPI = { cleanupAllListeners: () => cleanupCount++ };
  ui.bindElectronListenerCleanup();
  ui.bindElectronListenerCleanup();
  assert.equal(ui.__registeredListeners.beforeunload.length, 1);
  ui.__registeredListeners.beforeunload[0]();
  assert.equal(cleanupCount, 1);
}

function checkAnalyticsProtocol(): void {
  const analyticsProtocol = require(path.join(
    projectRoot,
    'dist',
    'modules',
    'analyticsProtocol.js',
  )) as {
    createGaClientId(now?: number, randomPart?: number): string;
    isValidGaClientId(value: unknown): boolean;
    normalizeGaEventName(eventName: string): string;
    normalizeGaEventParams(
      params: Record<string, unknown>,
    ): Record<string, unknown>;
    resolveDistributionSource(isWindowsStore: boolean): 'ms_store' | 'github';
    shouldTransmitAnalytics(
      isPackaged: boolean,
      explicitlyDisabled?: boolean,
      userEnabled?: boolean,
    ): boolean;
    normalizeGaClientId(
      value: unknown,
      now?: number,
      randomPart?: number,
    ): { clientId: string; migrated: boolean };
  };

  assert.equal(analyticsProtocol.isValidGaClientId('123456789.1722150000'), true);
  assert.equal(analyticsProtocol.isValidGaClientId('123456789'), false);
  assert.equal(analyticsProtocol.isValidGaClientId(crypto.randomUUID()), false);
  assert.equal(analyticsProtocol.resolveDistributionSource(true), 'ms_store');
  assert.equal(analyticsProtocol.resolveDistributionSource(false), 'github');
  assert.equal(
    analyticsProtocol.shouldTransmitAnalytics(true),
    true,
    '정식 패키지의 기본 사용 통계 전송이 비활성화되었습니다.',
  );
  assert.equal(
    analyticsProtocol.shouldTransmitAnalytics(false),
    false,
    '개발·자동 테스트 실행에서 GA 전송이 허용되었습니다.',
  );
  assert.equal(
    analyticsProtocol.shouldTransmitAnalytics(true, true),
    false,
    '명시적으로 비활성화한 패키지 테스트에서 GA 전송이 허용되었습니다.',
  );
  assert.equal(
    analyticsProtocol.shouldTransmitAnalytics(true, false, false),
    false,
    '사용자가 비활성화한 패키지에서 GA 전송이 허용되었습니다.',
  );
  assert.equal(
    analyticsProtocol.createGaClientId(1_722_150_000_000, 123_456_789),
    '123456789.1722150000',
  );
  assert.deepEqual(
    analyticsProtocol.normalizeGaClientId('123456789.1722150000'),
    {
      clientId: '123456789.1722150000',
      migrated: false,
    },
  );
  assert.deepEqual(
    analyticsProtocol.normalizeGaClientId(
      '2cca639a-ef75-4087-8317-595539727182',
      1_722_150_000_000,
      987_654_321,
    ),
    {
      clientId: '987654321.1722150000',
      migrated: true,
    },
  );
  assert.equal(
    analyticsProtocol.normalizeGaEventName('toggle_settings_chatlog:sub-tab-overlay'),
    'toggle_settings_chatlog_sub_tab_overlay',
  );
  assert.equal(
    analyticsProtocol.normalizeGaEventName('123 invalid event name'),
    'event_123_invalid_event_name',
  );
  assert.equal(
    Array.from(analyticsProtocol.normalizeGaEventName(`event_${'가'.repeat(50)}`)).length,
    40,
  );
  assert.deepEqual(
    analyticsProtocol.normalizeGaEventParams({
      error_message: '오'.repeat(101),
      ga_session_number: 3,
      enabled: true,
    }),
    {
      error_message: '오'.repeat(100),
      ga_session_number: 3,
      enabled: true,
    },
  );

  const analyticsSource = read('src/modules/analytics.ts');
  assert.match(
    analyticsSource,
    /flatParams\.distribution_source\s*=\s*resolveDistributionSource\(Boolean\(process\.windowsStore\)\)/,
    '모든 GA 이벤트에 패키지 배포 채널이 공통 파라미터로 추가되지 않습니다.',
  );

  const ipcSource = read('src/modules/ipcHandlers.ts');
  for (const eventName of [
    'go_home', 'toggle_welcome_guide', 'toggle_update_notice',
    'trigger_jellyppy_rain_global', 'toggle_chat_overlay_sub',
  ]) {
    assert.ok(ipcSource.includes(`analytics.trackEvent('${eventName}'`),
      `직접 IPC 기능 경로의 GA 이벤트가 누락되었습니다: ${eventName}`);
  }

  const trayActionSource = read('src/modules/trayMenuActions.ts');
  assert.match(trayActionSource, /analytics\.trackEvent[\s\S]*?handler\(\)/,
    '트레이 메뉴의 기능 실행이 GA 이벤트를 우회합니다.');

  const shortcutSource = read('src/modules/shortcutManager.ts');
  for (const eventName of [
    'toggle_click_through', 'toggle_contents_checker', 'toggle_buff_hud',
    'cycle_today_summary_hud', 'toggle_abandoned_hud', 'toggle_dock',
    'toggle_chat_overlay', 'reset_xp_session', 'toggle_xp_session',
    'clear_all_buffs', 'toggle_stopwatch',
  ]) {
    assert.ok(shortcutSource.includes(`analytics.trackEvent('${eventName}'`),
      `전역 단축키 기능 경로의 GA 이벤트가 누락되었습니다: ${eventName}`);
  }
}

function checkDevtoolsInitializationIsIdempotent() {
  const messages: unknown[][] = [];
  const window: any = {};
  const sandbox = {
    window,
    document: { getElementById: () => ({}) },
    gameOverlayAlerts: {
      showEssenceAlert() {},
      showSpecialMonsterAlert() {},
    },
    triggerLokagosAlert() {},
    showEthosAlert: () => 'N',
    showAbyssApostleAlert: () => true,
    ETHOS_PASSWORD_BY_DIRECTION: { N: '번개' },
    currentConfig: null,
    console: {
      log: (...args: unknown[]) => messages.push(['log', ...args]),
      error: (...args: unknown[]) => messages.push(['error', ...args]),
    },
  };
  const code = read('dist/renderer/game-overlay/devtools.js');
  vm.runInNewContext(code, sandbox, { filename: 'devtools.js' });
  const firstRunCount = messages.length;
  vm.runInNewContext(code, sandbox, { filename: 'devtools.js' });

  assert.equal(messages.length, firstRunCount, 'DevTools 가이드가 중복 출력되었습니다.');
  assert.equal(typeof window.testSpecialMonsterAlert, 'function');
  assert.equal(typeof window.testEthos, 'function');
}

function checkInlineScriptSyntax() {
  const htmlFiles = fs.readdirSync(sourceRoot).filter(file => file.endsWith('.html'));
  const inlineScriptPattern = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let checkedBlockCount = 0;
  const checkedPages = new Set<string>();

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    let match;
    let index = 0;
    while ((match = inlineScriptPattern.exec(html)) !== null) {
      index++;
      new vm.Script(match[1], { filename: `${file}:inline-script-${index}` });
      checkedBlockCount++;
      checkedPages.add(file);
    }
  }

  assert.ok(checkedBlockCount > 0, '검사된 HTML 인라인 스크립트가 없습니다.');
  assert.ok(checkedPages.size > 0, '인라인 스크립트 검사 대상 페이지가 없습니다.');
}

function checkPageScriptNamespaceCollisions() {
  const htmlFiles = fs.readdirSync(sourceRoot).filter(file => file.endsWith('.html'));
  const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    const scripts = [];
    let match;

    while ((match = scriptPattern.exec(html)) !== null) {
      const sourceMatch = match[1].match(/\bsrc=["']([^"']+)["']/i);
      if (!sourceMatch) {
        scripts.push(match[2]);
        continue;
      }

      const relativeScriptPath = sourceMatch[1].split(/[?#]/, 1)[0];
      if (/\.min\.js$/i.test(relativeScriptPath)) continue;

      const sourcePath = path.join(sourceRoot, relativeScriptPath);
      const builtPath = path.join(projectRoot, 'dist', relativeScriptPath);
      const resolvedPath = fs.existsSync(sourcePath)
        ? sourcePath
        : fs.existsSync(builtPath)
          ? builtPath
          : null;
      if (resolvedPath) scripts.push(fs.readFileSync(resolvedPath, 'utf8'));
    }

    new vm.Script(scripts.join('\n;\n'), {
      filename: `${file}:combined-page-scripts`,
    });
  }
}

function checkHtmlScriptResourcesAndHandlers(): void {
  const htmlFiles = fs.readdirSync(sourceRoot).filter(file => file.endsWith('.html'));
  const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  const inlineHandlerPattern = /\bon(?:click|change|input|submit|keydown|keyup|blur|focus)=["']([^"']+)["']/gi;
  const ignoredCalls = new Set([
    'Boolean', 'Number', 'String', 'clearInterval', 'clearTimeout', 'if',
    'parseFloat', 'parseInt', 'setInterval', 'setTimeout',
  ]);

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    const externalReferences: string[] = [];
    const pageScripts: string[] = [];
    let scriptMatch: RegExpExecArray | null;

    while ((scriptMatch = scriptPattern.exec(html)) !== null) {
      const sourceMatch = scriptMatch[1].match(/\bsrc=["']([^"']+)["']/i);
      if (!sourceMatch) {
        pageScripts.push(scriptMatch[2]);
        continue;
      }

      const relativePath = sourceMatch[1].split(/[?#]/, 1)[0];
      if (/^https?:\/\//i.test(relativePath)) continue;
      externalReferences.push(relativePath);

      const sourceJavaScriptPath = path.join(sourceRoot, relativePath);
      const builtJavaScriptPath = path.join(projectRoot, 'dist', relativePath);
      assert.ok(
        fs.existsSync(sourceJavaScriptPath) || fs.existsSync(builtJavaScriptPath),
        `${file}의 스크립트 경로가 존재하지 않습니다: ${relativePath}`,
      );
      assert.ok(
        fs.existsSync(builtJavaScriptPath),
        `${file}의 빌드 스크립트가 존재하지 않습니다: ${relativePath}`,
      );

      if (!relativePath.endsWith('.min.js')) {
        const sourceTypeScriptPath = path.join(
          sourceRoot,
          relativePath.replace(/\.js$/i, '.ts'),
        );
        assert.ok(
          fs.existsSync(sourceTypeScriptPath),
          `${file}의 직접 작성 스크립트에 대응하는 TS 원본이 없습니다: ${relativePath}`,
        );
        pageScripts.push(fs.readFileSync(builtJavaScriptPath, 'utf8'));
      }
    }

    assert.equal(
      new Set(externalReferences).size,
      externalReferences.length,
      `${file}에 중복 로드되는 외부 스크립트가 있습니다.`,
    );

    const combinedCode = pageScripts.join('\n;\n');
    let handlerMatch: RegExpExecArray | null;
    while ((handlerMatch = inlineHandlerPattern.exec(html)) !== null) {
      const calledNames = Array.from(
        handlerMatch[1].matchAll(/(?:^|[^.\w])([A-Za-z_$][\w$]*)\s*\(/g),
        match => match[1],
      ).filter(name => !ignoredCalls.has(name));

      for (const functionName of calledNames) {
        const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declarationPattern = new RegExp(
          `(?:function\\s+${escapedName}\\s*\\(|(?:window\\.)?${escapedName}\\s*=|(?:const|let|var)\\s+${escapedName}\\s*=|class\\s+${escapedName}\\b)`,
        );
        assert.match(
          combinedCode,
          declarationPattern,
          `${file}의 인라인 이벤트 핸들러 ${functionName} 정의를 찾지 못했습니다.`,
        );
      }
    }
  }
}

function checkRendererResources() {
  const requiredSourceResources = [
    'src/renderer/game-overlay/alerts.ts',
    'src/renderer/game-overlay/devtools.ts',
    'src/renderer/game-overlay/edit-mode.ts',
    'src/renderer/game-overlay/today-summary.ts',
    'src/renderer/hunting-exp-calculator.ts',
    'src/renderer/settings/sound-preview.ts',
    'src/renderer/settings/list-rendering.ts',
    'src/renderer/settings/form-collection.ts',
    'src/renderer/settings/shortcuts.ts',
    'src/renderer/settings/menu-management.ts',
    'src/renderer/settings/audio-controls.ts',
    'src/renderer/settings/config-binding.ts',
    'src/renderer/contents-checker/audio-feedback.ts',
    'src/renderer/contents-checker/dom-rendering.ts',
    'src/renderer/diary/log-utils.ts',
  ];
  const requiredBuiltResources = requiredSourceResources.map(resource => (
    resource.replace(/^src/, 'dist').replace(/\.ts$/, '.js')
  ));
  [...requiredSourceResources, ...requiredBuiltResources].forEach(resource => {
    assert.equal(fs.existsSync(path.join(projectRoot, resource)), true, `${resource} 파일이 없습니다.`);
  });

  const copyScript = read('scripts/copy-resources.ts');
  assert.match(
    copyScript,
    /dirsToCopy\s*=\s*\[[^\]]*['"]renderer['"]/,
    'renderer 리소스 복사 규칙이 없습니다.',
  );

  const gameOverlay = read('src/game-overlay.html');
  const settingsPage = read('src/settings.html');
  assert.match(settingsPage, /applySettingsConfirmed\(\{ chatOverlayCustomTabs: nextTabs \}\)/,
    '사용자 정의 채팅 탭 저장이 결과 확인 가능한 설정 IPC를 사용하지 않습니다.');
  assert.match(settingsPage, /\.\.\.\(checkedChannels\.includes\('system'\) \? \{ systemColorFilters: systemColors \} : \{\}\)/,
    '시스템 채널이 없는 사용자 정의 탭에 선택적 시스템 색상 필드가 포함될 수 있습니다.');
  assert.match(settingsPage, /hasPendingCustomChatTabDraft\(\)[\s\S]*?먼저 “탭 추가”/,
    '등록 전 사용자 정의 탭 초안을 즉시 적용할 때 보존 안내가 없습니다.');
  assert.match(read('src/preload.ts'), /applySettingsConfirmed:[\s\S]*?invoke\('apply-settings-confirmed'/,
    '설정 적용 결과를 확인하는 preload API가 없습니다.');
  assert.match(read('src/modules/ipcHandlers.ts'), /handle\('apply-settings-confirmed'[\s\S]*?applyExternalSettings/,
    '설정 적용 결과를 반환하는 IPC 핸들러가 없습니다.');
  assert.match(read('src/modules/ipcHandlers.ts'), /applyExternalSettings\(newSettings, event\.sender\)/,
    '설정 저장 요청을 보낸 창이 전체 설정 재전파 대상에서 제외되지 않았습니다.');
  assert.match(read('src/modules/ipcHandlers.ts'), /settingsWindow\.webContents === sourceWebContents[\s\S]*?excludedSettingsWebContents/,
    '설정 창 이외의 기능 창까지 자신의 설정 갱신 응답에서 제외될 수 있습니다.');
  const windowManagerSource = read('src/modules/windowManager.ts');
  assert.match(windowManagerSource, /win\.webContents === excludedWebContents/,
    '설정 저장 요청을 보낸 창으로 config-data가 되돌아갈 수 있습니다.');
  assert.match(windowManagerSource, /if \(!closingSplashWindow\.isDestroyed\(\)\) closingSplashWindow\.close\(\)/,
    '이미 파괴된 스플래시 창을 시작 완료 시 다시 닫을 수 있습니다.');
  assert.match(read('src/dock.html'), /\.dock-item\.click-through-active svg[\s\S]*?color:\s*#4ade80/,
    'Lucide가 SVG로 교체한 독 마우스 투과 아이콘에 초록색 상태가 적용되지 않습니다.');
  const clickThroughMenu = JSON.parse(read('src/assets/data/sidebar_menus.json'))
    .find((item: { id?: string }) => item.id === 'click-through-btn');
  assert.match(clickThroughMenu?.tooltip || '', /웹 브라우저.*채팅.*메인\/보조 1·2.*\n초록색/,
    '사이드바 마우스 투과 툴팁에 적용 대상 창과 활성 상태 안내가 없습니다.');
  assert.match(read('src/index.html'), /\.tw-tooltip\s*\{[\s\S]*?max-width:[\s\S]*?white-space:\s*pre-line/,
    '사이드바의 긴 마우스 투과 안내가 창 안에서 줄바꿈되지 않습니다.');
  assert.deepEqual(
    [...settingsPage.matchAll(/<(?:button|div)[^>]*class="[^"]*\bnav-item\b[^"]*"[^>]*data-settings-group="[^"]+"[^>]*>[\s\S]*?<\/i>\s*([^<]+)/g)].map(match => match[1].trim()),
    ['앱 & 런처', '게임 HUD & 알림', '채팅 & 로그', '모니터링 & 소리', '시스템 & 관리', '앱 정보'],
  );
  assert.equal(
    [...settingsPage.matchAll(/<(?:button|div)[^>]*data-settings-group="[^"]+"[^>]*onclick="showSettingsGroup/g)].length,
    6,
    '좌측 설정 메뉴는 6개의 1depth 항목만 표시해야 합니다.',
  );
  const settingsRouteBlock = settingsPage.match(/const SETTINGS_NAV_GROUPS = \{([\s\S]*?)\n    \};/)?.[1] || '';
  const settingsRoutes = [...settingsRouteBlock.matchAll(
    /\{ label: '([^']+)', icon: '[^']+', section: '([^']+)'(?:, subTab: '([^']+)')?(?:, view: '([^']+)')? \}/g,
  )].map(([, label, section, subTab, view]) => ({ label, section, subTab, view }));
  assert.deepEqual(
    settingsRoutes.map(route => route.label),
    [
      '앱 동작', '사이드바 & 독', '웹 브라우저 창', '퀵슬롯 관리',
      'HUD 위젯 관리', '게임 진행 알림',
      '채팅 로그 연동', '채팅 오버레이', '득템 & 외치기',
      '외부 모니터링', '공통 알림 & 소리', '커스텀 알림음', '알림 기록',
      '단축키 설정', '데이터 관리', '네트워크 최적화', '앱 정보 & 업데이트',
    ],
    '설정 2depth 메뉴 17개가 의도한 순서와 구성으로 연결되어야 합니다.',
  );
  settingsRoutes.forEach(route => {
    assert.match(settingsPage, new RegExp(`id="section-${route.section}"`),
      `${route.label} 메뉴의 설정 섹션이 없습니다.`);
    if (route.subTab) {
      assert.match(settingsPage, new RegExp(`id="${route.subTab}"`),
        `${route.label} 메뉴의 내부 탭이 없습니다.`);
    }
    if (route.view) {
      assert.match(settingsPage, new RegExp(`data-settings-view="${route.view}"`),
        `${route.label} 메뉴의 독립 콘텐츠가 없습니다.`);
    }
  });
  assert.match(settingsPage, /id="settings-context-tabs" class="settings-context-tabs"/,
    '설정 화면의 가로 2depth 메뉴 영역이 없습니다.');
  assert.match(settingsPage, /id="settings-quick-search"/,
    '설정 화면의 빠른 검색 입력창이 없습니다.');
  assert.match(settingsPage, /id="settings-search-results"/,
    '설정 화면의 빠른 검색 드롭다운이 없습니다.');
  const settingsElementIds = Array.from(settingsPage.matchAll(/\sid="([^"]+)"/g), match => match[1]);
  const duplicateSettingsIds = settingsElementIds.filter((id, index) => settingsElementIds.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicateSettingsIds)], [],
    '설정 화면에 중복 DOM ID가 있어 다른 설정값을 읽거나 저장할 수 있습니다.');
  const settingsSearchTargets = Array.from(
    settingsPage.matchAll(/\btargetId:\s*'([^']+)'/g),
    match => match[1],
  );
  for (const targetId of settingsSearchTargets) {
    assert.ok(settingsElementIds.includes(targetId),
      `설정 검색 결과가 존재하지 않는 화면 요소를 가리킵니다: ${targetId}`);
  }
  assert.match(settingsPage, /function showSettingsGroup\(/,
    '설정 1depth와 가로 2depth 메뉴 연결 함수가 없습니다.');
  assert.match(settingsPage, /'display:sidebar': \{ groupId: 'app', routeIndex: 1 \}/,
    '사이드바/독 설정 바로가기 경로가 없습니다.');
  assert.match(settingsPage, /'display:game-overlay': \{ groupId: 'game', routeIndex: 0 \}/,
    '게임 오버레이 설정 바로가기 경로가 없습니다.');
  assert.match(settingsPage, /'chatlog:history-sync': \{ groupId: 'chat', routeIndex: 0 \}/,
    '과거 채팅 로그 동기화 설정 바로가기 경로가 없습니다.');
  assert.match(settingsPage, /tabId === 'chatlog:history-sync'[\s\S]*?targetId = 'btn-manual-sync'/,
    '과거 채팅 로그 동기화 바로가기가 실행 버튼을 강조하지 않습니다.');
  assert.match(settingsPage, /모험일지 보관 기간 안에서 아직 분석하지 않았거나 이후 내용이 추가된 채팅 로그/,
    '과거 채팅 로그 동기화 범위가 사용자에게 올바르게 안내되지 않습니다.');
  assert.match(settingsPage, /이미 동기화 완료된 로그도 다시 분석하여 자동 기록 재구성/,
    '완료된 채팅 로그 전체 재분석 옵션이 사용자에게 안내되지 않습니다.');
  assert.match(settingsPage, /로그가 많으면 분석 중 프로그램이 일시적으로 느려질 수 있습니다/,
    '과거 채팅 로그 대량 분석 중 성능 안내가 설정 화면에 없습니다.');
  assert.match(settingsPage, /onChatLogSyncProgress\(renderManualChatLogSyncProgress\)/,
    '과거 채팅 로그 동기화 진행률을 설정 화면에 연결하지 않았습니다.');
  assert.match(settingsPage, /info\.failedFiles[\s\S]*?읽기 실패/,
    '과거 채팅 로그 동기화 중 실패한 파일을 계속 표시하지 않습니다.');
  assert.match(settingsPage, /'data:retention': \{ groupId: 'system', routeIndex: 1 \}/,
    '모험일지 보관 설정 바로가기 경로가 없습니다.');
  const settingsShortcutTargets: Array<[string, string]> = [
    ['src/welcome-guide.html', 'chatlog'],
    ['src/welcome-guide.html', 'chatlog:history-sync'],
    ['src/welcome-guide.html', 'display:sidebar'],
    ['src/welcome-guide.html', 'display:game-overlay'],
    ['src/welcome-guide.html', 'sound'],
    ['src/welcome-guide.html', 'shortcuts'],
    ['src/welcome-guide.html', 'chatlog:sub-tab-today-summary'],
    ['src/diary.html', 'chatlog:sub-tab-loot'],
    ['src/diary.html', 'data:retention'],
    ['src/gallery.html', 'gallery'],
    ['src/trade.html', 'trade'],
    ['src/word-alarm.html', 'chatlog'],
    ['src/chatOverlayRenderer.ts', 'chatlog:sub-tab-overlay'],
    ['src/assets/ui-utils.ts', 'chatlog'],
    ['src/xp-hud.html', 'display:game-overlay'],
    ['src/magic-stone-calculator.html', 'display:game-overlay'],
    ['src/buff-timer.html', 'display:game-overlay'],
  ];
  settingsShortcutTargets.forEach(([resource, target]) => {
    assert.match(read(resource), new RegExp(`toggleSettings\\(['"]${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\)`),
      `${resource}의 설정 바로가기(${target})가 올바르게 연결되지 않았습니다.`);
  });
  assert.match(settingsPage, /applySettingsRouteView\(route\);\s*scrollSettingsToTop\(\);/,
    '설정 2depth 메뉴 전환 완료 후 최상단 스크롤이 보장되지 않습니다.');
  ['sidebar-settings-section', 'game-exit-reminder-section'].forEach(id => {
    assert.doesNotMatch(settingsPage, new RegExp(`id="${id}" class="[^"]*(?:pt-6|border-t)`),
      `${id} 독립 화면 상단에 이전 구분용 여백이 남아 있습니다.`);
  });
  assert.doesNotMatch(settingsPage, /class="[^"]*(?:pt-6|border-t)[^"]*" data-settings-view="data-retention"/,
    '데이터 보관 독립 화면 상단에 이전 구분용 여백이 남아 있습니다.');
  assert.doesNotMatch(settingsPage, /class="sub-tab-bar"|class="sub-tab-item/,
    '동적 가로 2depth 메뉴와 기존 내부 서브탭이 중복 표시됩니다.');
  assert.doesNotMatch(settingsPage, /onclick="showSubSection\('sub-tab-today-summary'/,
    '연결된 콘텐츠가 없는 오늘 요약 HUD 내부 탭이 다시 노출되었습니다.');
  assert.doesNotMatch(settingsPage, /id="essence-alert-(?:enabled|sound|volume)"/,
    '경험의 정수 상세 설정은 경험치 HUD 창만 담당해야 합니다.');
  assert.match(read('src/xp-hud.html'), /id="toggle-essence-alert"[\s\S]*id="essence-alert-sound"[\s\S]*id="essence-alert-volume"/,
    '경험치 HUD 창에 경험의 정수 상세 설정이 없습니다.');
  assert.doesNotMatch(read('src/boss-settings.html'), /id="boss-notify-closed-check"/,
    '공통 게임 종료 알림 정책이 필드보스 창에 중복 노출됩니다.');
  assert.match(read('src/boss-settings.html'), /id="boss-global-notification-link"[\s\S]*toggleSettings\('sound'\)/,
    '필드보스 창에서 공통 알림 정책으로 이동할 수 없습니다.');
  assert.match(read('src/trade.html'), /id="notify-toggle"[\s\S]*tradeGetNotify\(\)[\s\S]*tradeSetNotify\(enabled\)/,
    '거래 게시판 창에 알림 빠른 토글이 없습니다.');
  assert.match(settingsPage, /\.nav-container\s*\{[\s\S]*?overflow-y:\s*hidden/,
    '좌측 1depth 메뉴에 스크롤이 생길 수 있습니다.');
  assert.ok(
    settingsPage.indexOf('renderer/settings/form-collection.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 폼 수집 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/shortcuts.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 단축키 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/menu-management.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 메뉴 관리 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/audio-controls.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 사운드 제어 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('renderer/settings/config-binding.js') < settingsPage.indexOf('let currentSlots = []'),
    '설정 입력 바인딩 모듈이 인라인 설정 초기화보다 늦게 로드됩니다.',
  );
  assert.doesNotMatch(settingsPage, /function collectChatOverlayDisplaySettings|function collectChatAlertSettings/,
    '설정 폼 수집 로직이 settings.html에 다시 중복되었습니다.');
  assert.doesNotMatch(
    settingsPage,
    /recordingShortcutKey|currentShortcuts|function recordShortcut|function resetShortcut|function handleShortcutKeyDown/,
    '설정 단축키 상태 또는 녹화 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.doesNotMatch(
    settingsPage,
    /loadedMenus|function initDynamicMenuManagement|function applyMenuCheckboxes/,
    '설정 메뉴 관리 상태 또는 렌더링 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.doesNotMatch(
    settingsPage,
    /prevVolumes|ALERT_SOUND_SELECT_IDS|function buildAlertSoundOptionsHtml|function toggleMute|function updateMuteButtonState|function refreshAllSoundSelects/,
    '설정 사운드 상태 또는 제어 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.doesNotMatch(
    settingsPage,
    /ethosVolumeEl|abyssVolumeEl|lokagosVolumeEl|waveVolumeEl|overlayFontSizeEl|overlayOpacityEl|selectedChannels|forgeHudPos/,
    '독립 설정 입력 바인딩 로직이 settings.html에 다시 중복되었습니다.',
  );
  assert.match(settingsPage, /settingsFormCollection\.collectChatOverlayDisplaySettings\(chatOverlayFilterList(?:,\s*customTabsList)?\)/);
  assert.match(settingsPage, /settingsFormCollection\.collectChatAlertSettings\(lootKeywordsList, shoutKeywordsList\)/);
  assert.match(settingsPage, /settingsShortcuts\.mergeShortcuts\(config\.shortcuts\)/);
  assert.match(settingsPage, /shortcuts:\s*window\.settingsShortcuts\.getShortcuts\(\)/);
  assert.match(settingsPage, /settingsShortcuts\.handleKeyDown\(e\)/);
  assert.match(
    settingsPage,
    /await window\.settingsMenuManagement\.initialize\(\);\s*if \(lastConfig\) window\.settingsMenuManagement\.applyConfig\(lastConfig\);/,
    '메뉴 로드 도중 도착한 최신 설정을 로드 완료 후 다시 적용하지 않습니다.',
  );
  assert.match(settingsPage, /settingsMenuManagement\.applyConfig\(config\)/);
  assert.match(settingsPage, /settingsMenuManagement\.collectHiddenMenuIds\(\)/);
  assert.match(
    settingsPage,
    /await window\.settingsAudioControls\.initializeAlertSoundSelects\(\);\s*if \(lastConfig\) window\.settingsAudioControls\.applyAlertSoundConfig\(lastConfig\);/,
    '사운드 목록 로드 도중 도착한 최신 설정을 로드 완료 후 다시 적용하지 않습니다.',
  );
  assert.match(settingsPage, /settingsAudioControls\.bindVolumeControl\('contents-checker', volContents\)/);
  assert.match(settingsPage, /settingsAudioControls\.bindVolumeControl\('calculators', volCalc\)/);
  assert.match(settingsPage,
    /alerts:\s*\[[\s\S]*?label: '커스텀 알림음'[\s\S]*?subTab: 'sub-tab-custom-sounds'/,
    '커스텀 알림음 관리가 외부 알림 & 소리 상단 메뉴에서 누락되었습니다.');
  assert.match(settingsPage, /'sound:custom': \{ groupId: 'alerts', routeIndex: 2 \}/,
    '커스텀 알림음 딥링크가 전용 상단 메뉴로 연결되지 않습니다.');
  assert.equal(
    (settingsPage.match(/settingsAudioControls\.refreshAlertSoundSelects\(\)/g) || []).length,
    3,
    '커스텀 사운드 추가·이름 변경·삭제 후 선택 목록 갱신 연결이 누락되었습니다.',
  );
  assert.match(settingsPage, /settingsConfigBinding\.applyGeneralSettings\(config, window\.electronAPI\.DEFAULT_CONFIG\)/);
  assert.match(settingsPage, /settingsConfigBinding\.applyChatAndAlertSettings\(/);
  assert.match(settingsPage, /settingsConfigBinding\.applyOverlayDisplayOptions\(/);
  assert.match(settingsPage, /settingsConfigBinding\.applyRadioSettings\(config, window\.electronAPI\.DEFAULT_CONFIG\)/);
  assert.equal(
    (settingsPage.match(/settingsConfigBinding\.refreshUntouchedChatOverlaySizes\(latestConfig\)/g) || []).length,
    2,
    '설정 저장 또는 채팅 오버레이 즉시 적용이 열린 뒤 변경된 실제 창 크기를 보존하지 않습니다.',
  );
  const guideCount = (
    read('src/renderer/game-overlay/devtools.ts').match(/\[TW-Overlay 테스트 가이드\]/g)
    || []
  ).length;
  assert.equal(guideCount, 1, 'DevTools 테스트 가이드 정의가 하나가 아닙니다.');
  assert.match(gameOverlay, /renderer\/game-overlay\/devtools\.js/);

  requiredBuiltResources
    .concat([
      'dist/assets/ui-utils.js',
      'dist/shared/chatConstants.js',
      'dist/shared/chatChannels.js',
      'dist/shared/buffConstants.js',
      'dist/shared/sidebarCategories.js',
      'dist/shared/sidebarMenuActivation.js',
      'dist/shared/huntingExpCalculator.js',
      'dist/shared/relicCalculator.js',
      'dist/shared/equipmentSimulator.js',
    ])
    .forEach(resource => {
      new vm.Script(read(resource), { filename: resource });
    });

  const chatOverlayBundle = read('dist/chatOverlayRenderer.js');
  assert.doesNotMatch(
    chatOverlayBundle,
    /Object\.defineProperty\(exports|\brequire\(/,
    '브라우저에서 직접 로드하는 채팅 오버레이 번들에 CommonJS 런타임 코드가 포함되었습니다.',
  );
}

function checkCoefficientCalculatorVisibilityContract(): void {
  const html = read('src/coefficient-calculator.html');

  assert.match(
    html,
    /\.custom-dropdown-menu\.hidden\s*\{\s*display:\s*none;\s*\}/,
    '계수 계산기에서 닫힌 장비 드롭다운이 표시될 수 있습니다.',
  );
  assert.match(
    html,
    /<script src="assets\/tailwind\.min\.js"><\/script>/,
    '계수 계산기의 기존 Tailwind 런타임 로드 방식이 변경되었습니다.',
  );
  assert.doesNotMatch(
    html,
    /assets\/tailwind\.css/,
    '계수 계산기에 기존 스타일 우선순위를 깨뜨리는 정적 Tailwind CSS가 연결되었습니다.',
  );
}

function checkHuntingPathArrowSizing(): void {
  const html = read('src/hunting-path-simulator.html');
  assert.match(html, /const PATH_STROKE_WIDTH = 3\.0;/);
  assert.match(html, /const ARROW_MARKER_SIZE = 4\.3;/);
  assert.match(
    html,
    /line\.style\.strokeWidth = \(PATH_STROKE_WIDTH \* currentScale\) \+ 'px';/,
  );
  assert.match(
    html,
    /const mWidth = \(ARROW_MARKER_SIZE \* currentScale\)\.toFixed\(2\);/,
  );
  assert.match(html, /const refY = '5';/);
  assert.match(
    html,
    /orient="auto-start-reverse" overflow="visible"/,
    '사냥터 동선 화살촉이 SVG 마커 경계에서 잘릴 수 있습니다.',
  );
}

function checkContentsChecklistOrdering(): void {
  const html = read('src/contents-checker.html');

  assert.doesNotMatch(
    html,
    /\.sort\(\(a,\s*b\)\s*=>\s*window\.compareKoreanText\(a\.name,\s*b\.name\)\)/,
    '숙제 체크리스트가 저장된 사용자 순서 대신 이름순으로 다시 정렬됩니다.',
  );
  assert.match(
    html,
    /visibleItems\.forEach\(item\s*=>/,
    '숙제 체크리스트가 저장 배열 순서로 렌더링되지 않습니다.',
  );
  assert.match(
    html,
    /contentsReorderCategory\(drop\.resetType, drop\.sourceName, drop\.targetName, drop\.position\)/,
    '숙제 체크리스트의 카테고리 드래그 재배치 연결이 누락되었습니다.',
  );
  assert.match(
    html,
    /contentsReorderItem\(drop\.sourceId, drop\.targetId, drop\.position\)/,
    '숙제 체크리스트의 항목 드래그 재배치 연결이 누락되었습니다.',
  );
  assert.match(
    html,
    /table\.ondrop = event => commitDragPreview\(event\)/,
    '숙제 체크리스트의 테이블 드롭 커밋 연결이 누락되었습니다.',
  );
  assert.match(
    html,
    /title = '드래그하여 숙제 순서 변경'/,
    '숙제 체크리스트의 드래그 핸들이 누락되었습니다.',
  );
  assert.match(
    html,
    /const isCustomItem = item\.isCustom === true \|\| item\.id\.startsWith\('custom-'\);/,
    '구버전 커스텀 숙제 판별 호환성이 누락되었습니다.',
  );
  assert.match(
    html,
    /createBadge\(\s*'CUSTOM'/,
    '커스텀 숙제의 CUSTOM 딱지가 누락되었습니다.',
  );
}

function checkPhaseOneSafetyContracts(): void {
  const contents = JSON.parse(read('src/assets/data/contents.json')) as Array<{ id: string }>;
  const contentsMeta = JSON.parse(read('src/assets/data/contents.meta.json')) as {
    expectedItemCount: number;
    sentinelIds: string[];
  };
  const ids = contents.map(item => item.id);
  assert.equal(contents.length, contentsMeta.expectedItemCount,
    'contents 리소스 개수와 companion metadata가 다릅니다.');
  assert.equal(new Set(ids).size, ids.length, 'contents 리소스 ID가 중복되었습니다.');
  assert.ok(contentsMeta.sentinelIds.length >= 3, 'contents sentinel이 충분하지 않습니다.');
  contentsMeta.sentinelIds.forEach(id => assert.ok(ids.includes(id), `contents sentinel이 없습니다: ${id}`));

  const contentsChecker = read('src/modules/contentsChecker.ts');
  assert.match(contentsChecker, /validateResourceMeta/);
  assert.match(contentsChecker, /if \(!defaultItems\) \{[\s\S]*?return;/,
    'contents 검증 실패 후 파괴적 초기화를 중단하지 않습니다.');

  const preload = read('src/preload.ts');
  assert.match(preload, /defaultApp === true[\s\S]*?process\.argv\.includes\('--dev'\)/,
    '프로덕션 preload 테스트 API 차단 조건이 없습니다.');
  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(ipcHandlers, /if \(IS_DEV\) \{[\s\S]*?inject-test-chat/,
    '프로덕션 테스트 채팅 IPC 차단 조건이 없습니다.');

  const audioControls = read('src/renderer/settings/audio-controls.ts');
  assert.doesNotMatch(audioControls, /soundFiles\.map\([\s\S]*?<option/,
    '커스텀 사운드가 option innerHTML로 삽입됩니다.');
  assert.match(audioControls, /option\.textContent = String\(sound\.name\)/);
  const gallery = read('src/gallery.html');
  assert.doesNotMatch(gallery, /removeWatch\(\$\{no\}\)/,
    '갤러리 감시 키가 inline onclick에 삽입됩니다.');
  const diary = read('src/diary.html');
  assert.doesNotMatch(diary, /deleteTimelineItem\('\$\{log\.type\}/,
    '일지 문자열이 inline 삭제 핸들러에 삽입됩니다.');

  const configSource = read('src/modules/config.ts');
  assert.match(configSource, /fs\.fsyncSync\(fd\)[\s\S]*?fs\.renameSync\(tempPath, filePath\)/,
    '설정 원자 저장의 flush/rename 계약이 없습니다.');
  assert.match(configSource, /설정 원자 저장 실패, pending 유지/,
    '설정 저장 실패 후 pending 보존 계약이 없습니다.');
  assert.match(configSource, /if \(_cachedConfig\) return deepClone\(_cachedConfig\)/,
    '설정 읽기 경계가 독립 스냅샷을 반환하지 않습니다.');
  assert.match(configSource, /mergeConfigPatch/,
    '부분 설정 저장의 중첩 필드 병합이 없습니다.');

  const backupManager = read('src/modules/backupManager.ts');
  assert.match(backupManager, /createUserDataSnapshot/);
  assert.match(backupManager, /verifyUserDataSnapshot/);
  assert.doesNotMatch(backupManager, /\.old['"]/,
    '수동 복원이 검증 스냅샷 대신 취약한 .old 교체를 사용합니다.');

  const snapshotModule = require(path.join(projectRoot, 'dist', 'modules', 'localSnapshot.js')) as {
    createUserDataSnapshot: (source: string, destination: string, options: Record<string, unknown>) => unknown;
    verifyUserDataSnapshot: (snapshot: string, options?: { enforceRestoreAllowlist?: boolean }) => unknown;
  };
  const source = path.join(isolatedUserData, 'snapshot-source');
  const destinationRoot = path.join(isolatedUserData, 'snapshot-output');
  const destination = path.join(destinationRoot, 'verified');
  fs.mkdirSync(path.join(source, 'custom_sounds'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config.json'), '{"width":400}', 'utf8');
  fs.writeFileSync(path.join(source, 'diary.db'), 'sqlite-fixture', 'utf8');
  fs.writeFileSync(path.join(source, 'custom_sounds', 'safe.mp3'), 'sound-fixture', 'utf8');
  snapshotModule.createUserDataSnapshot(source, destination, {
    reason: 'regression-test', appVersion: '3.0.0', allowedDestinationRoot: destinationRoot,
  });
  assert.doesNotThrow(() => snapshotModule.verifyUserDataSnapshot(destination));

  const disallowedDestination = path.join(destinationRoot, 'disallowed-restore-entry');
  fs.cpSync(destination, disallowedDestination, { recursive: true });
  const disallowedManifestPath = path.join(disallowedDestination, 'snapshot.manifest.json');
  const disallowedManifest = JSON.parse(fs.readFileSync(disallowedManifestPath, 'utf8'));
  const originalRelativePath = disallowedManifest.entries[0].relativePath as string;
  const disallowedRelativePath = 'bin/llama-server.exe';
  fs.mkdirSync(path.join(disallowedDestination, 'bin'), { recursive: true });
  fs.renameSync(
    path.join(disallowedDestination, originalRelativePath),
    path.join(disallowedDestination, disallowedRelativePath),
  );
  disallowedManifest.entries[0].relativePath = disallowedRelativePath;
  fs.writeFileSync(disallowedManifestPath, JSON.stringify(disallowedManifest, null, 2), 'utf8');
  assert.doesNotThrow(() => snapshotModule.verifyUserDataSnapshot(disallowedDestination),
    '구버전 스냅샷의 구조 검증 호환성이 깨졌습니다.');
  assert.throws(
    () => snapshotModule.verifyUserDataSnapshot(disallowedDestination, { enforceRestoreAllowlist: true }),
    /허용되지 않은 스냅샷 항목/,
    '복원 허용 목록 밖 실행 파일이 사용자 데이터 복원 대상으로 허용되었습니다.',
  );

  fs.appendFileSync(path.join(destination, 'config.json'), 'tampered', 'utf8');
  assert.throws(() => snapshotModule.verifyUserDataSnapshot(destination), /무결성 검증 실패/);

  const scamModelManager = read('src/modules/scam/modelManager.ts');
  const scamServerManager = read('src/modules/scam/serverManager.ts');
  assert.match(scamModelManager, /spawn\('tar\.exe', \['-xf', archivePath, '-C', destinationPath\]/,
    'AI 공식 ZIP이 별도 스트리밍 압축 해제 프로세스를 사용하지 않습니다.');
  assert.doesNotMatch(scamModelManager, /function binaryEntries|entry\.getData\(\)/,
    'AI ZIP의 모든 바이너리를 메인 프로세스 Buffer 배열에 적재하는 경로가 남아 있습니다.');
  assert.match(scamModelManager, /SERVER_MANIFEST_FILE[\s\S]*?buildServerManifest[\s\S]*?verifyServerDirectory/,
    '검증된 AI 바이너리 설치 manifest 계약이 없습니다.');
  assert.match(scamModelManager, /SERVER_INSTALL_JOURNAL_FILE[\s\S]*?recoverInterruptedServerInstall/,
    '중단된 AI 바이너리 교체를 복구하는 journal 계약이 없습니다.');
  assert.match(scamModelManager, /if \(_modelDownloadPromise\) return _modelDownloadPromise/,
    'AI 모델 다운로드의 single-flight 보호가 없습니다.');
  assert.match(scamModelManager, /const tmpPath = `\$\{modelPath\}\.verified`;[\s\S]*?fs\.rmSync\(tmpPath, \{ force: true \}\)/,
    '중단된 AI 모델 다운로드의 검증 임시 파일을 정리하지 않습니다.');
  assert.match(scamModelManager, /if \(_binaryInstallVariant !== requestedVariant\)[\s\S]*?다른 GPU용 llama-server 설치가 진행 중입니다/,
    '서로 다른 GPU 바이너리의 동시 설치 요청이 같은 Promise로 잘못 합쳐질 수 있습니다.');
  assert.match(scamServerManager, /verifyInstalledServerBinary\(\);[\s\S]*?verifyInstalledModel\(\);/,
    'AI 서버 실행 전에 바이너리와 모델을 모두 검증하지 않습니다.');

  const scamModelModule = require(path.join(projectRoot, 'dist', 'modules', 'scam', 'modelManager.js')) as {
    getServerBinDir(): string;
    recoverInterruptedServerInstall(): boolean;
  };
  const configModule = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as {
    load(): { scamGpuVariant?: 'cpu' | 'vulkan' | 'cuda-12.4' | 'cuda-13.1' };
    saveImmediate(patch: Record<string, unknown>): boolean;
  };
  const originalVariant = configModule.load().scamGpuVariant;
  const binDir = scamModelModule.getServerBinDir();
  const installJournal = path.join(isolatedUserData, 'bin-install-journal.json');
  const stagingBeforeMove = path.join(isolatedUserData, 'bin-install-regression-before-move');
  const previousBeforeMove = path.join(isolatedUserData, 'bin-previous-regression-before-move');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'existing-install.marker'), 'preserve-me');
  fs.mkdirSync(stagingBeforeMove);
  fs.writeFileSync(installJournal, JSON.stringify({
    formatVersion: 1,
    variant: 'cpu',
    hadPrevious: true,
    previousVariant: originalVariant || 'vulkan',
    stagingDir: stagingBeforeMove,
    previousDir: previousBeforeMove,
    targetDir: binDir,
  }));
  assert.equal(scamModelModule.recoverInterruptedServerInstall(), true,
    '기존 bin 이동 전 중단된 AI 설치를 복구하지 못했습니다.');
  assert.equal(fs.readFileSync(path.join(binDir, 'existing-install.marker'), 'utf8'), 'preserve-me',
    'AI 설치 journal 기록 직후의 기존 bin이 새 설치로 오인되어 삭제되었습니다.');
  assert.equal(fs.existsSync(stagingBeforeMove), false,
    '중단된 AI 설치 staging 디렉터리가 정리되지 않았습니다.');

  fs.rmSync(binDir, { recursive: true, force: true });
  const stagingAfterMove = path.join(isolatedUserData, 'bin-install-regression-after-move');
  const previousAfterMove = path.join(isolatedUserData, 'bin-previous-regression-after-move');
  fs.mkdirSync(stagingAfterMove);
  fs.mkdirSync(previousAfterMove);
  fs.writeFileSync(path.join(previousAfterMove, 'previous-install.marker'), 'restore-me');
  fs.writeFileSync(installJournal, JSON.stringify({
    formatVersion: 1,
    variant: 'cpu',
    hadPrevious: true,
    previousVariant: originalVariant || 'vulkan',
    stagingDir: stagingAfterMove,
    previousDir: previousAfterMove,
    targetDir: binDir,
  }));
  assert.equal(scamModelModule.recoverInterruptedServerInstall(), true,
    '기존 bin 이동 후 중단된 AI 설치를 복구하지 못했습니다.');
  assert.equal(fs.readFileSync(path.join(binDir, 'previous-install.marker'), 'utf8'), 'restore-me',
    '중단된 AI 설치에서 previous bin이 복원되지 않았습니다.');
  fs.rmSync(binDir, { recursive: true, force: true });
  configModule.saveImmediate({ scamGpuVariant: originalVariant || 'vulkan' });
}

function checkWindowRestoreAndSettingsNavigationContracts(): void {
  const manager = read('src/modules/windowManager.ts');
  const windowOptionsSource = read('src/modules/windowOptions.ts');
  const mainSource = read('src/main.ts');
  const placementSource = read('src/modules/windowPlacement.ts');
  const displayStabilizerSource = read('src/modules/displayTopologyStabilizer.ts');
  const processBoostSource = read('src/modules/processBoostRetryPolicy.ts');
  const indexSource = read('src/index.html');
  const registrySource = read('src/modules/managedWindowRegistry.ts');
  const moveTrackerSource = read('src/modules/programmaticMoveTracker.ts');
  const layoutSource = read('src/modules/windowLayout.ts');
  const positionPolicySource = read('src/modules/windowPositionPolicy.ts');
  const gameWindowModeSource = read('src/modules/gameWindowModePolicy.ts');
  const settings = read('src/settings.html');
  const configSource = read('src/modules/config.ts');
  const sharedTypes = read('src/shared/types.ts');

  assert.match(
    windowOptionsSource,
    /const applicationIconPath = path\.join\(__dirname, '\.\.', 'icons', 'icon\.ico'\);[\s\S]*?icon: applicationIconPath,[\s\S]*?\.\.\.windowProps,/,
    '작업표시줄에 표시되는 공통 BrowserWindow가 TW-Overlay 제품 아이콘을 사용하지 않습니다.',
  );
  assert.ok(
    fs.existsSync(path.join(sourceRoot, 'icons', 'icon.ico')),
    '공통 BrowserWindow가 참조하는 TW-Overlay Windows 아이콘 파일이 없습니다.',
  );

  assert.match(
    manager,
    /let pendingSettingsTab: string \| null = null;/,
    '설정창 초기 탭 요청을 보존하는 상태가 없습니다.',
  );
  assert.match(
    manager,
    /windowKey === 'settings' && pendingSettingsTab[\s\S]*?send\('open-settings-tab', pendingSettingsTab\)/,
    '설정 렌더러 준비 후 초기 탭을 전달하는 연결이 없습니다.',
  );
  assert.match(
    settings,
    /onOpenSettingsTab\([\s\S]*?sendRendererReady\('settings'\)/,
    '설정 탭 리스너 등록 후 renderer-ready 신호를 보내지 않습니다.',
  );

  const currentRectPublish = manager.indexOf('gameRect = scaledGameRect;');
  const contentsRestore = manager.indexOf('// --- 숙제 체크리스트 자동 동기화 및 띄우기 ---');
  assert.ok(currentRectPublish >= 0 && currentRectPublish < contentsRestore,
    '게임 복원 좌표가 숙제 체크리스트 자동 생성보다 먼저 게시되어야 합니다.');

  assert.doesNotMatch(
    manager,
    /programmaticMoveTimeMap|Date\.now\(\) - lastTime/,
    '프로그램 이동 판별이 다시 고정 시간 추정에 의존하고 있습니다.',
  );
  assert.match(
    moveTrackerSource,
    /reachedTarget[\s\S]*?delete this\.moves\[key\]/,
    '프로그램이 명령한 목표 좌표를 실제 move 좌표와 대조하는 방어가 없습니다.',
  );
  assert.match(
    moveTrackerSource,
    /fromX: current\.x[\s\S]*?fromY: current\.y[\s\S]*?isNativeIntermediateMove[\s\S]*?&& isNativeIntermediateMove/,
    '프로그램 이동 경로 밖의 빠른 사용자 드래그까지 시간 기준으로 무시할 수 있습니다.',
  );
  assert.doesNotMatch(
    moveTrackerSource,
    /if \(Date\.now\(\) <= pending\.ignoreMismatchUntil\) return true;/,
    '목표와 다른 모든 이동을 일정 시간 무조건 무시하는 판별이 남아 있습니다.',
  );
  assert.match(
    manager,
    /let isInitialPositionApplied = false;[\s\S]*?!isInitialPositionApplied/,
    '창 초기 위치가 적용되기 전 발생하는 move 이벤트의 저장 방어가 없습니다.',
  );
  assert.ok(
    mainSource.indexOf('wm.setupDisplayChangeListeners();') >= 0
      && mainSource.indexOf('wm.setupDisplayChangeListeners();') < mainSource.indexOf('wm.createSplashWindow();'),
    '디스플레이 리스너가 앱 초기화 시점에 한 번 등록되지 않습니다.',
  );
  assert.match(manager, /screen\.on\('display-added', handleDisplayChange\)/,
    '모니터 연결 이벤트가 창 복구 흐름에 연결되지 않았습니다.');
  assert.match(manager, /screen\.on\('display-removed', handleDisplayChange\)/,
    '모니터 해제 이벤트가 창 복구 흐름에 연결되지 않았습니다.');
  assert.match(manager, /screen\.on\('display-metrics-changed', handleDisplayChange\)/,
    'DPI 또는 작업 영역 변경 이벤트가 창 복구 흐름에 연결되지 않았습니다.');
  assert.match(manager, /tracker\.queryGameRect\(\)[\s\S]*?syncOverlay\(currentRect\)/,
    '디스플레이 변경 뒤 최신 게임 좌표로 전체 창을 재동기화하지 않습니다.');
  assert.match(manager, /recoverVisibleWindowsWithoutGame[\s\S]*?setProgrammaticMove\(key, x, y\);[\s\S]*?win\.setPosition\(x, y\)/,
    '게임 좌표가 없을 때의 화면 이탈 복구가 사용자 이동으로 저장될 수 있습니다.');
  assert.match(manager, /setProgrammaticMove\('overlay', x, y\);[\s\S]*?overlayWindow\.setPosition\(x, y\)/,
    '브라우저 오버레이의 디스플레이 복구 이동이 사용자 이동으로 저장될 수 있습니다.');
  assert.match(manager, /const fallbackPosition = gameRect \? \{\} : resolveFallbackWindowPosition\(cfg\.width, cfg\.height\)/,
    '게임이 없거나 최소화된 상태에서 브라우저 오버레이를 화면 중앙에 임시 표시하지 않습니다.');
  assert.match(manager, /if \(isTracking && gameRect\) \{[\s\S]*?saveUserWindowPosition\('overlay'/,
    '게임 좌표가 없는 임시 브라우저 오버레이 이동이 게임용 위치로 저장될 수 있습니다.');
  assert.match(displayStabilizerSource, /candidateSignature[\s\S]*?stableDurationMs[\s\S]*?maxWaitMs/,
    'RDP 전환 중 임시 화면 구성을 건너뛰는 안정화 판정이 없습니다.');
  assert.match(processBoostSource, /inFlight[\s\S]*?nextAttemptAt[\s\S]*?maximumDelayMs/,
    '프로세스 우선순위 상승 실패의 single-flight 지수 백오프가 없습니다.');
  assert.match(read('src/modules/pollingLoop.ts'), /getGameProcessId\(\)[\s\S]*?processBoostRetry\.tryStart[\s\S]*?processBoostRetry\.finish/,
    '게임 PID별 우선순위 상승 재시도 정책이 폴링 루프에 연결되지 않았습니다.');
  assert.match(indexSource, /const interactiveToasts = window\.createInteractiveToastRegistry[\s\S]*?updateIgnoreMouseEvents\(!hasInteractiveToast\)/,
    'interactive 토스트 참조 수와 사이드바 click-through 상태가 연결되지 않았습니다.');
  assert.match(indexSource, /scam-toast-[\s\S]*?onclick="removeToast\('\$\{toastId\}', event\)"/,
    '사기 탐지 토스트 닫기 버튼이 공통 제거 경로를 사용하지 않습니다.');
  assert.match(indexSource, /appendInteractiveToast\(toast\);[\s\S]*?setTimeout\(\(\) => \{ removeToast\(toastId\); \}, 30000\)/,
    '사기 탐지 토스트 자동 만료가 공통 제거 경로를 사용하지 않습니다.');
  assert.doesNotMatch(indexSource, /onclick="document\.getElementById\('\$\{toastId\}'\)\?\.remove\(\)"/,
    'click-through 복구를 우회하는 토스트 직접 제거가 남아 있습니다.');
  assert.match(
    manager,
    /export function resetGameSessionState\(\)[\s\S]*?lastForegroundSize = null;/,
    '게임 재실행 시 이전 세션의 해상도 캐시를 폐기하지 않습니다.',
  );
  assert.match(
    read('src/modules/pollingLoop.ts'),
    /'notRunning' in currentRect[\s\S]*?resetGameSessionState\(\)/,
    '게임 종료 감지와 세션 좌표 상태 초기화가 연결되어 있지 않습니다.',
  );
  assert.doesNotMatch(
    manager,
    /minOverlapArea|totalOverlap\s*>=/,
    '화면에 일부 걸친 창을 화면 밖으로 오인하는 최소 노출 면적 기준이 다시 추가되었습니다.',
  );
  assert.match(
    placementSource,
    /isWindowVisibleOnDisplays[\s\S]*?getOverlapArea\(bounds, display\.bounds\) > 0/,
    '창이 모든 화면에서 완전히 사라진 경우만 감지하는 교차 면적 검사가 없습니다.',
  );
  assert.match(
    manager,
    /function recoverCompletelyOffscreenWindow[\s\S]*?saveUserWindowPosition\(key, \{ x: recoveredX, y: recoveredY \}, anchorRect\)/,
    '완전히 화면을 이탈한 보조 창의 위치 복구 및 저장 로직이 없습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenWindow\(key, placementAnchor, x, y, finalW, finalH\)/,
    '숙제 체크리스트를 포함한 공통 보조 창 생성 경로에 화면 이탈 복구가 적용되지 않았습니다.',
  );
  assert.match(
    manager,
    /function recoverCompletelyOffscreenBrowserOverlay[\s\S]*?saveUserWindowPosition\('overlay', \{ x: recoveredX, y: recoveredY \}, anchorRect\)/,
    '브라우저 오버레이의 완전 화면 이탈 복구 및 위치 저장 로직이 없습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenBrowserOverlay\(\s*scaledGameRect,[\s\S]*?recoveredOverlay\.recovered/,
    '브라우저 오버레이 동기화 경로에 완전 화면 이탈 복구가 연결되지 않았습니다.',
  );
  assert.match(
    manager,
    /const recoveryBounds = skipPositionSync\s*\? \{ x: b\.x, y: b\.y, width: b\.width, height: b\.height \}[\s\S]*?recoverCompletelyOffscreenBrowserOverlay/,
    '게임 추적 중단 시 브라우저 오버레이의 실제 현재 위치를 기준으로 복구하지 않습니다.',
  );
  assert.match(
    manager,
    /const recovery = recoverCompletelyOffscreenWindow\([\s\S]*?skipPositionSync \? b\.x : x[\s\S]*?skipPositionSync \? b\.y : y[\s\S]*?\(!skipPositionSync \|\| recovery\.recovered\)/,
    '실행 중인 일반 보조 창의 현재/예정 위치별 완전 이탈 복구가 없습니다.',
  );
  assert.doesNotMatch(
    manager,
    /settings:\s*\{[\s\S]{0,400}?getPrimaryDisplay\(\)/,
    '설정 창 위치가 다시 주 모니터 좌표로 강제 제한되고 있습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenWindow\('uniformColor'/,
    '의상 염색 창의 완전 화면 이탈 복구가 없습니다.',
  );
  assert.match(
    manager,
    /recoverCompletelyOffscreenWindow\('swordEnhance'/,
    '검 강화 창의 완전 화면 이탈 복구가 없습니다.',
  );
  assert.match(
    manager,
    /config\.hasStoredPosition\(key as WindowPositionKey\)/,
    '기본 위치와 사용자가 실제 저장한 위치를 구분하지 않습니다.',
  );
  assert.match(
    configSource,
    /storedPositionKeys\s*=\s*\[\.\.\._storedPositionKeys\]/,
    '실제 저장 위치 키가 설정 파일에 보존되지 않습니다.',
  );
  assert.match(
    manager,
    /saveUserWindowPosition[\s\S]*?positions[\s\S]*?fixedWindowPositions/,
    '사용자 창 이동 시 게임 상대 오프셋과 화면 절대 좌표를 함께 저장하지 않습니다.',
  );
  assert.match(
    manager,
    /gameWindowModeController\.observe\([\s\S]*?synchronizeWindowPositionMode\(scaledGameRect, modeResult\.mode\)[\s\S]*?const skipPositionSync = gameWindowModeTransitioning/,
    '게임 화면 모드 안정화와 Follow 위치 복원이 같은 배치 경계에 연결되지 않았습니다.',
  );
  assert.match(manager, /gameWindowModeTransitioning \|\| key === 'dock'[\s\S]*?recovered: false/,
    '게임 화면 모드 전환 중 화면 이탈 중앙 복구를 차단하지 않습니다.');
  assert.match(manager, /gameWindowModeTransitioning\) return;[\s\S]*?saveUserWindowPosition/,
    '게임 화면 모드 전환 중 move 이벤트가 사용자 위치를 저장할 수 있습니다.');
  assert.match(manager, /windowedFullscreenPositions[\s\S]*?activateGameWindowMode/,
    '창모드 전체화면 전용 위치 프로필이 실제 모드 전환에 연결되지 않았습니다.');
  const modeActivationStart = manager.indexOf('function activateGameWindowMode(');
  const modeActivationEnd = manager.indexOf('function savePosition(', modeActivationStart);
  assert.ok(modeActivationStart >= 0 && modeActivationEnd > modeActivationStart,
    '게임 화면 모드별 위치 적용 함수를 찾지 못했습니다.');
  assert.doesNotMatch(manager.slice(modeActivationStart, modeActivationEnd), /getBounds\(/,
    '게임 없음·최소화 상태의 임시 중앙 창 좌표가 화면 모드 프로필 생성에 사용될 수 있습니다.');
  assert.match(read('src/modules/pollingLoop.ts'), /wm\.isGameWindowModeTransitioning\(\)/,
    '좌표가 멈춘 뒤 게임 화면 모드 안정화를 확정하는 후속 폴링이 없습니다.');
  assert.match(read('src/modules/tracker.ts'), /GetWindowLongW\(cachedHwnd, win32\.GWL_STYLE\)/,
    '게임 창 테두리 스타일이 화면 모드 전환 판정에 전달되지 않습니다.');
  assert.match(gameWindowModeSource, /FULLSCREEN_EDGE_TOLERANCE = 12/,
    'DWM·DPI 오차를 허용하는 창모드 전체화면 판정이 없습니다.');
  assert.match(
    manager,
    /!fixedWasActive \|\| !fixedWindowPositions\.overlay[\s\S]*?resolveFixedScreenPosition/,
    'Follow ON에서 게임을 이동한 뒤 OFF로 전환할 때 현재 화면 위치를 다시 저장하지 않습니다.',
  );
  assert.match(
    settings,
    /켜면 게임창 기준 위치를 유지하고, 끄면 현재 화면 위치에 고정합니다/,
    '게임창 따라가기 ON/OFF의 위치 기준이 설정 화면에 안내되지 않습니다.',
  );
  assert.match(positionPolicySource, /key === 'overlay'[\s\S]*?gameRect\.x \+ position\.offsetX/,
    '브라우저 오버레이의 좌측 상단 기준 좌표 변환이 없습니다.');
  assert.match(positionPolicySource, /gameRect\.x \+ gameRect\.width \+ position\.offsetX/,
    '일반 보조 창의 게임 우측 기준 좌표 변환이 없습니다.');
  assert.match(
    configSource,
    /copyFileSync\((?:configPath|candidatePath), backupPath\)[\s\S]*?_loadWarning/,
    '손상된 설정 파일의 원본 보존 또는 사용자 경고가 없습니다.',
  );
  assert.match(
    sharedTypes,
    /positions\?: Partial<Record<WindowPositionKey, WindowPosition>>;/,
    '창 위치 타입이 전체 레지스트리 키를 포괄하지 않습니다.',
  );
  assert.match(
    sharedTypes,
    /windowedFullscreenPositions\?: Partial<Record<WindowPositionKey, WindowPosition>>;/,
    '창모드 전체화면 전용 창 위치 타입이 없습니다.',
  );

  const sharedPositionSource = read('src/shared/windowPositions.ts');
  assert.match(sharedPositionSource, /export const DEFAULT_WINDOW_POSITIONS/);
  assert.match(registrySource, /copyDefaultWindowPosition\(definition\.key\)/);
  assert.match(read('src/modules/constants.ts'), /positions: \{ \.\.\.DEFAULT_WINDOW_POSITIONS \}/);
  assert.match(read('src/modules/constants.ts'), /windowedFullscreenPositions: \{\}/);

  const placement = require(path.join(projectRoot, 'dist', 'modules', 'windowPlacement.js')) as {
    isWindowVisibleOnDisplays: (bounds: object, displays: object[]) => boolean;
    centerWindowInWorkArea: (width: number, height: number, workArea: object) => { x: number; y: number };
  };
  const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.equal(placement.isWindowVisibleOnDisplays({ x: 1919, y: 1079, width: 20, height: 20 }, displays), true);
  assert.equal(placement.isWindowVisibleOnDisplays({ x: 1920, y: 0, width: 20, height: 20 }, displays), false);
  assert.deepEqual(placement.centerWindowInWorkArea(400, 300, { x: 100, y: 50, width: 1200, height: 800 }), {
    x: 500,
    y: 300,
  });

  const displayTopology = require(path.join(projectRoot, 'dist', 'modules', 'displayTopologyStabilizer.js')) as {
    createDisplayTopologySignature: (displays: object[]) => string;
    DisplayTopologyStabilizer: new (stableDurationMs: number, maxWaitMs: number) => {
      begin: (now: number) => void;
      observe: (signature: string, now: number) => boolean;
    };
  };
  const primaryDisplay = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    rotation: 0,
  };
  const secondaryDisplay = {
    id: 2,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
    scaleFactor: 1.25,
    rotation: 0,
  };
  assert.equal(
    displayTopology.createDisplayTopologySignature([primaryDisplay, secondaryDisplay]),
    displayTopology.createDisplayTopologySignature([secondaryDisplay, primaryDisplay]),
    'Electron이 모니터 목록 순서를 바꾸기만 해도 화면 변경으로 오인합니다.',
  );
  assert.notEqual(
    displayTopology.createDisplayTopologySignature([primaryDisplay]),
    displayTopology.createDisplayTopologySignature([{ ...primaryDisplay, scaleFactor: 1.5 }]),
    '100/125/150% DPI 변경을 화면 구성 변화로 감지하지 못합니다.',
  );

  const topologyStabilizer = new displayTopology.DisplayTopologyStabilizer(250, 2_000);
  topologyStabilizer.begin(0);
  assert.equal(topologyStabilizer.observe('transient', 300), false);
  assert.equal(topologyStabilizer.observe('transient', 549), false);
  assert.equal(topologyStabilizer.observe('transient', 550), true,
    '동일한 화면 구성이 안정화 시간 동안 유지된 뒤 복구를 허용하지 않습니다.');
  topologyStabilizer.begin(1_000);
  assert.equal(topologyStabilizer.observe('rdp-transient', 1_300), false);
  assert.equal(topologyStabilizer.observe('rdp-final', 1_550), false,
    'RDP 중간 화면 구성 직후 위치 복구를 실행합니다.');
  assert.equal(topologyStabilizer.observe('rdp-final', 1_800), true,
    'RDP 최종 화면 구성이 안정화된 뒤에도 위치 복구를 실행하지 않습니다.');

  const modePolicy = require(path.join(projectRoot, 'dist', 'modules', 'gameWindowModePolicy.js')) as {
    isNearFullscreenBounds(game: object, display: object): boolean;
    GameWindowModeController: new (stableDurationMs: number) => {
      observe(observation: object, now: number): {
        phase: string;
        mode: string;
        targetMode: string;
        modeChanged: boolean;
        previousStableBounds: object | null;
      };
      isTransitioning(): boolean;
    };
  };
  const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(modePolicy.isNearFullscreenBounds(
    { x: 0, y: 0, width: 1910, height: 1072 }, displayBounds,
  ), true, 'DWM 경계 오차가 있는 창모드 전체화면을 일반 창모드로 오인합니다.');
  assert.equal(modePolicy.isNearFullscreenBounds(
    { x: 0, y: 0, width: 1907, height: 1080 }, displayBounds,
  ), false, '허용 오차 밖의 일반 창을 창모드 전체화면으로 오인합니다.');

  const windowedBounds = { x: 200, y: 100, width: 1280, height: 720 };
  const controller = new modePolicy.GameWindowModeController(250);
  let mode = controller.observe({
    bounds: windowedBounds, displayBounds, windowStyle: 0x00c00000,
  }, 0);
  assert.equal(mode.phase, 'stable');
  assert.equal(mode.mode, 'windowed');
  mode = controller.observe({
    bounds: { x: 20, y: 10, width: 1800, height: 1000 }, displayBounds, windowStyle: 0,
  }, 100);
  assert.equal(mode.phase, 'transitioning', '전체화면 전환의 중간 rect를 안정 위치로 적용합니다.');
  mode = controller.observe({ bounds: displayBounds, displayBounds, windowStyle: 0 }, 150);
  assert.equal(mode.phase, 'transitioning');
  mode = controller.observe({ bounds: displayBounds, displayBounds, windowStyle: 0 }, 399);
  assert.equal(mode.phase, 'transitioning');
  mode = controller.observe({ bounds: displayBounds, displayBounds, windowStyle: 0 }, 400);
  assert.equal(mode.phase, 'stable');
  assert.equal(mode.mode, 'windowed-fullscreen');
  assert.equal(mode.modeChanged, true);
  assert.deepEqual(mode.previousStableBounds, windowedBounds,
    '전체화면 위치 변환에 사용할 직전 창모드 좌표가 보존되지 않았습니다.');
  mode = controller.observe({
    bounds: { x: 100, y: 70, width: 1600, height: 900 }, displayBounds, windowStyle: 0x00c00000,
  }, 500);
  assert.equal(mode.phase, 'transitioning');
  mode = controller.observe({
    bounds: { x: 120, y: 80, width: 1280, height: 720 }, displayBounds, windowStyle: 0x00c00000,
  }, 550);
  assert.equal(mode.phase, 'transitioning');
  mode = controller.observe({
    bounds: { x: 120, y: 80, width: 1280, height: 720 }, displayBounds, windowStyle: 0x00c00000,
  }, 800);
  assert.equal(mode.phase, 'stable');
  assert.equal(mode.mode, 'windowed');

  const ordinaryMoveController = new modePolicy.GameWindowModeController(250);
  ordinaryMoveController.observe({ bounds: windowedBounds, displayBounds, windowStyle: 0x00c00000 }, 0);
  assert.equal(ordinaryMoveController.observe({
    bounds: { ...windowedBounds, x: 260, y: 140 }, displayBounds, windowStyle: 0x00c00000,
  }, 10).phase, 'stable', '일반 창 이동을 화면 모드 전환으로 오인합니다.');

  const boostPolicyModule = require(path.join(projectRoot, 'dist', 'modules', 'processBoostRetryPolicy.js')) as {
    ProcessBoostRetryPolicy: new (initialDelayMs: number, maximumDelayMs: number) => {
      tryStart: (processId: number, now: number) => boolean;
      finish: (processId: number, success: boolean, now: number) => number | null;
      reset: () => void;
    };
  };
  const boostPolicy = new boostPolicyModule.ProcessBoostRetryPolicy(1_000, 60_000);
  assert.equal(boostPolicy.tryStart(10, 0), true);
  assert.equal(boostPolicy.tryStart(10, 0), false, '우선순위 상승 요청이 완료 전 중복 실행됩니다.');
  assert.equal(boostPolicy.finish(10, false, 100), 1_000);
  assert.equal(boostPolicy.tryStart(10, 1_099), false);
  assert.equal(boostPolicy.tryStart(10, 1_100), true);
  assert.equal(boostPolicy.finish(10, false, 1_200), 2_000);
  assert.equal(boostPolicy.tryStart(10, 3_199), false);
  assert.equal(boostPolicy.tryStart(10, 3_200), true);
  assert.equal(boostPolicy.finish(10, false, 3_300), 4_000);
  assert.equal(boostPolicy.tryStart(20, 3_301), true, '게임 PID 변경 시 이전 PID의 백오프가 유지됩니다.');
  assert.equal(boostPolicy.finish(10, true, 3_302), null, '이전 PID의 늦은 응답이 새 PID 상태를 변경합니다.');
  assert.equal(boostPolicy.finish(20, true, 3_303), null);
  assert.equal(boostPolicy.tryStart(20, 100_000), false, '우선순위 상승 성공 후 같은 PID를 다시 시도합니다.');
  boostPolicy.reset();
  assert.equal(boostPolicy.tryStart(20, 100_001), true, '게임 종료 후 재시도 상태가 초기화되지 않습니다.');
  const cappedBoostPolicy = new boostPolicyModule.ProcessBoostRetryPolicy(40_000, 60_000);
  assert.equal(cappedBoostPolicy.tryStart(30, 0), true);
  assert.equal(cappedBoostPolicy.finish(30, false, 0), 40_000);
  assert.equal(cappedBoostPolicy.tryStart(30, 40_000), true);
  assert.equal(cappedBoostPolicy.finish(30, false, 40_000), 60_000);
  assert.equal(cappedBoostPolicy.tryStart(30, 100_000), true);
  assert.equal(cappedBoostPolicy.finish(30, false, 100_000), 60_000,
    '프로세스 우선순위 재시도 간격이 60초 상한을 초과합니다.');

  const registryModule = require(path.join(projectRoot, 'dist', 'modules', 'managedWindowRegistry.js')) as {
    createManagedWindowRegistry: () => Record<string, { key: string; html: string; width: number; height: number; ref: unknown }>;
    MANAGED_WINDOW_COUNT: number;
  };
  const registry = registryModule.createManagedWindowRegistry();
  assert.equal(Object.keys(registry).length, registryModule.MANAGED_WINDOW_COUNT);
  const defaultPositions = require(path.join(projectRoot, 'dist', 'shared', 'windowPositions.js')) as {
    DEFAULT_WINDOW_POSITIONS: Record<string, object>;
    DEFAULT_HUD_POSITIONS: Record<string, object>;
    repairLegacyHiddenHudPositions(config: Record<string, unknown>): string[];
  };
  assert.deepEqual(defaultPositions.DEFAULT_HUD_POSITIONS.digsite, { left: 0, bottom: 326 },
    '발굴지 현황 HUD 기본 위치가 기준 좌표와 다릅니다.');
  const hiddenHudFixture: Record<string, unknown> = {
    xpWidgetPos: { left: 200, bottom: 0 },
    buffTimerHudPos: { left: 0, bottom: 720 },
    abandonedWidgetPos: { left: 351, bottom: 134 },
    digsiteWidgetPos: { left: 0, bottom: 1232 },
    forgeQuestHudPos: { left: 0, bottom: 326 },
    todaySummaryHudPos: { left: 0, top: 641 },
  };
  assert.deepEqual(
    defaultPositions.repairLegacyHiddenHudPositions(hiddenHudFixture),
    ['buffTimerHudPos', 'digsiteWidgetPos'],
    '숨김 HUD의 0 rect 저장 형태를 선별하지 못합니다.',
  );
  assert.deepEqual(hiddenHudFixture, {
    xpWidgetPos: { left: 200, bottom: 0 },
    buffTimerHudPos: { left: 350, bottom: 0 },
    abandonedWidgetPos: { left: 351, bottom: 134 },
    digsiteWidgetPos: { left: 0, bottom: 326 },
    forgeQuestHudPos: { left: 0, bottom: 326 },
    todaySummaryHudPos: { left: 0, top: 641 },
  }, '손상된 HUD 외의 정상 사용자 위치까지 초기화합니다.');
  assert.deepEqual(
    Object.keys(registry).sort(),
    Object.keys(defaultPositions.DEFAULT_WINDOW_POSITIONS).filter(key => key !== 'overlay').sort(),
    '관리 창 레지스트리와 공통 기본 위치 키가 일치하지 않습니다.',
  );
  assert.deepEqual(
    { key: registry.settings.key, html: registry.settings.html, width: registry.settings.width, height: registry.settings.height, ref: registry.settings.ref },
    { key: 'settings', html: 'settings.html', width: 1100, height: 720, ref: null },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(registry).map(([key, value]) => [key, [value.html, value.width, value.height, !!(value as { skipTaskbar?: boolean }).skipTaskbar]])),
    {
      settings: ['settings.html', 1100, 720, false], gallery: ['gallery.html', 450, 600, false],
      abbreviation: ['abbreviation.html', 540, 720, false], equipmentDic: ['equipment-dic.html', 1120, 800, false],
      buffs: ['buffs.html', 1080, 740, false], bossSettings: ['boss-settings.html', 460, 780, false],
      etaRanking: ['eta-ranking.html', 680, 720, false], trade: ['trade.html', 450, 600, false],
      coefficientCalculator: ['coefficient-calculator.html', 1420, 860, false], contentsChecker: ['contents-checker.html', 400, 1200, false],
      focusedChat: ['focused-chat.html', 460, 720, false], evolutionCalculator: ['evolution-calculator.html', 1040, 820, false],
      thesisCoreCalculator: ['thesis-core-calculator.html', 850, 880, false], magicStoneCalculator: ['magic-stone-calculator.html', 400, 800, false],
      customAlert: ['custom-alert.html', 580, 640, false], diary: ['diary.html', 1400, 920, false],
      uniformColor: ['uniform-color.html', 360, 800, false], swordEnhance: ['sword-enhance.html', 1300, 850, false],
      qteChallenge: ['qte-challenge.html', 980, 780, false],
      shoutHistory: ['shout-history.html', 450, 600, false], gameOverlay: ['game-overlay.html', 0, 0, false],
      buffTimer: ['buff-timer.html', 900, 850, false], xpHud: ['xp-hud.html', 420, 1050, false],
      scamDetector: ['scam-detector.html', 480, 780, false], sienaAura: ['siena-aura.html', 1230, 930, false],
      wordAlarm: ['word-alarm.html', 450, 950, false], discordAlarm: ['discord-alarm.html', 450, 950, false],
      huntingPathSimulator: ['hunting-path-simulator.html', 860, 800, false],
      huntingExpCalculator: ['hunting-exp-calculator.html', 940, 780, false], relicCalculator: ['relic-calculator.html', 920, 760, false],
      equipmentSimulator: ['equipment-simulator.html', 960, 820, false],
      stopwatch: ['stopwatch.html', 870, 750, false],
      chatOverlay: ['chat-overlay.html', 450, 400, true], chatOverlaySub: ['chat-overlay.html', 450, 400, true],
      chatOverlaySub2: ['chat-overlay.html', 450, 400, true], dock: ['dock.html', 800, 380, true],
    },
    '관리 창의 HTML·기본 크기·작업 표시줄 정책이 변경되었습니다.',
  );

  const sizing = require(path.join(projectRoot, 'dist', 'modules', 'managedWindowSizing.js')) as {
    resolveManagedWindowSizing: (key: string, width: number, height: number, config: Record<string, unknown>, workAreaSize: { width: number; height: number }) => Record<string, unknown>;
    getManagedWindowSizePolicy: (key: string) => string;
    applyManagedWindowSize: (key: string, config: Record<string, unknown>, width: number, height: number) => boolean;
    createManagedWindowSizePatch: (key: string, width: number, height: number, existingSizes?: Record<string, { width: number; height: number }>) => Record<string, unknown> | null;
  };
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('focusedChat', 460, 720, { focusedChatWidth: 520, focusedChatHeight: 760 }, { width: 1280, height: 700 }),
    { width: 520, height: 660, isResizable: true, isTransparent: true, minWidth: 360, minHeight: 360, policy: 'user-resizable' },
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('contentsChecker', 400, 1200, {}, { width: 1920, height: 1080 }),
    { width: 400, height: 1040, isResizable: true, isTransparent: false, minWidth: 200, minHeight: 200, policy: 'user-resizable' },
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('chatOverlay', 450, 400, { chatOverlayWidth: 400, chatOverlayHeight: 120 }, { width: 1920, height: 1080 }),
    { width: 400, height: 120, isResizable: true, isTransparent: true, minWidth: 300, minHeight: 80, policy: 'user-resizable' },
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('coefficientCalculator', 1420, 860, {}, { width: 1280, height: 720 }),
    { width: 1240, height: 680, isResizable: true, isTransparent: true, minWidth: 400, minHeight: 300, policy: 'user-resizable' },
    '대형 관리 창이 작업 영역에 맞춰 축소되거나 사용자 크기 조절을 허용하지 않습니다.',
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('diary', 1400, 920, {}, { width: 800, height: 600 }),
    { width: 760, height: 560, isResizable: true, isTransparent: false, minWidth: 760, minHeight: 560, policy: 'user-resizable' },
    '축소된 작업 영역에서 초기 크기보다 큰 최소 크기를 설정합니다.',
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('focusedChat', 460, 720, { focusedChatWidth: 100, focusedChatHeight: 100 }, { width: 1920, height: 1080 }),
    { width: 360, height: 360, isResizable: true, isTransparent: true, minWidth: 360, minHeight: 360, policy: 'user-resizable' },
    '손상되거나 오래된 과소 저장 크기를 창별 최소 크기로 복구하지 않습니다.',
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('dock', 800, 380, {}, { width: 640, height: 480 }),
    { width: 800, height: 380, isResizable: false, isTransparent: true, minWidth: undefined, minHeight: undefined, policy: 'game-fixed' },
    '게임 내부 배치용 독 크기를 작업 영역 기준으로 임의 변경합니다.',
  );
  assert.equal(
    Object.keys(registry).every(key => ['fit-work-area', 'user-resizable', 'game-fixed'].includes(sizing.getManagedWindowSizePolicy(key))),
    true,
    '관리 창 레지스트리에 크기 정책이 없는 창이 있습니다.',
  );
  assert.match(manager, /resolveManagedWindowSizing\('uniformColor'[\s\S]*?display\.workAreaSize/,
    '의상 염색 도구의 초기 크기가 현재 작업 영역 정책을 사용하지 않습니다.');
  assert.match(manager, /resolveManagedWindowSizing\('swordEnhance'[\s\S]*?display\.workAreaSize/,
    '검 강화 도구의 초기 크기가 현재 작업 영역 정책을 사용하지 않습니다.');
  const sizeConfig: Record<string, unknown> = {};
  assert.equal(sizing.applyManagedWindowSize('chatOverlaySub2', sizeConfig, 510, 430), true);
  assert.deepEqual(sizeConfig, { chatOverlaySub2Width: 510, chatOverlaySub2Height: 430 });
  assert.equal(sizing.applyManagedWindowSize('settings', sizeConfig, 800, 600), true);
  assert.deepEqual(sizeConfig, {
    chatOverlaySub2Width: 510,
    chatOverlaySub2Height: 430,
    managedWindowSizes: { settings: { width: 800, height: 600 } },
  });
  assert.deepEqual(
    sizing.createManagedWindowSizePatch('chatOverlay', 640, 480),
    { chatOverlayWidth: 640, chatOverlayHeight: 480 },
    '창 크기 저장이 변경된 크기 필드 외의 설정까지 포함합니다.',
  );
  assert.deepEqual(
    sizing.createManagedWindowSizePatch('settings', 840, 640, { gallery: { width: 500, height: 650 } }),
    { managedWindowSizes: { gallery: { width: 500, height: 650 }, settings: { width: 840, height: 640 } } },
    '기존 보조 창 크기를 보존하면서 새 크기를 저장하지 않습니다.',
  );
  assert.deepEqual(
    sizing.resolveManagedWindowSizing('settings', 1100, 720, { managedWindowSizes: { settings: { width: 900, height: 650 } } }, { width: 1920, height: 1080 }),
    { width: 900, height: 650, isResizable: true, isTransparent: true, minWidth: 800, minHeight: 600, policy: 'user-resizable' },
    '일반 보조 창의 저장 크기가 재실행 시 복원되지 않습니다.',
  );

  const moveModule = require(path.join(projectRoot, 'dist', 'modules', 'programmaticMoveTracker.js')) as {
    ProgrammaticMoveTracker: new (threshold: number, windowMs: number, now: () => number) => {
      record: (key: string, target: { x: number; y: number }, current: { x: number; y: number }) => void;
      consume: (key: string, current?: { x: number; y: number }) => boolean;
      markUserDrag: (key: string, durationMs?: number) => void;
      isUserDragging: (key: string) => boolean;
      isAnyUserDragging: () => boolean;
      clear: () => void;
    };
  };
  let moveNow = 1_000;
  const moveTracker = new moveModule.ProgrammaticMoveTracker(2, 1_000, () => moveNow);
  moveTracker.record('window', { x: 100, y: 100 }, { x: 0, y: 0 });
  assert.equal(moveTracker.consume('window', { x: 50, y: 100 }), true, '네이티브 중간 move 이벤트를 보존하지 않습니다.');
  assert.equal(moveTracker.consume('window', { x: 180, y: 100 }), false, '이동 경로 밖의 사용자 드래그를 무시합니다.');
  moveTracker.record('window', { x: 100, y: 100 }, { x: 0, y: 0 });
  moveNow = 2_001;
  assert.equal(moveTracker.consume('window', { x: 50, y: 100 }), false, '중간 move 허용 시간이 지난 이벤트를 무시합니다.');
  moveTracker.record('window', { x: 100, y: 100 }, { x: 0, y: 0 });
  moveNow = 5_000;
  assert.equal(moveTracker.consume('window', { x: 100, y: 100 }), true, '최종 목표 좌표 도달을 시간과 무관하게 소비하지 않습니다.');

  // 사용자 마우스 드래그 추적 및 만료 검증
  assert.equal(moveTracker.isAnyUserDragging(), false, '초기에는 어떤 창도 드래그 상태가 아니어야 합니다.');
  moveTracker.markUserDrag('chatOverlay', 350);
  assert.equal(moveTracker.isUserDragging('chatOverlay'), true, '드래그 마킹 후 활성 상태여야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), true, '드래그 중인 창이 있으면 isAnyUserDragging이 true여야 합니다.');
  assert.equal(moveTracker.isUserDragging('otherWindow'), false, '다른 창은 드래그 상태가 아니어야 합니다.');
  moveNow = 5_300;
  assert.equal(moveTracker.isUserDragging('chatOverlay'), true, '350ms 만료 전에는 드래그 상태를 유지해야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), true, '만료 전에는 isAnyUserDragging이 true여야 합니다.');
  moveNow = 5_351;
  assert.equal(moveTracker.isUserDragging('chatOverlay'), false, '350ms 경과 후에는 드래그 상태가 해제되어야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), false, '만료 후에는 isAnyUserDragging이 false여야 합니다.');
  moveTracker.markUserDrag('chatOverlay', 350);
  moveTracker.clear();
  assert.equal(moveTracker.isUserDragging('chatOverlay'), false, 'clear() 호출 시 드래그 상태도 초기화되어야 합니다.');
  assert.equal(moveTracker.isAnyUserDragging(), false, 'clear() 호출 시 isAnyUserDragging도 false여야 합니다.');

  const layout = require(path.join(projectRoot, 'dist', 'modules', 'windowLayout.js')) as {
    resolvePhysicalGameRect: (current: Record<string, unknown>, last: { width: number; height: number } | null) => any;
    isFullscreenBounds: (game: object, display: object) => boolean;
    calculateAttachedWindowPosition: (game: any, position: any) => { x: number; y: number };
    calculateBrowserOverlayPosition: (game: any, position: any) => { x: number; y: number };
    calculateSidebarBounds: (position: string, game: any, edgeX: number, current: any) => any;
    calculateSidebarResizeBounds: (position: string, current: any, width: number) => any;
    resizeBounds: (current: any, width?: number, height?: number) => any;
    hasBoundsChanged: (current: any, target: any, threshold: number) => boolean;
    hasPositionChanged: (current: any, target: any, threshold: number) => boolean;
  };
  const foregroundRect = { x: 100, y: 200, width: 1920, height: 1080, isForeground: true };
  assert.deepEqual(layout.resolvePhysicalGameRect(foregroundRect, { width: 800, height: 600 }), {
    physicalRect: foregroundRect,
    foregroundSize: { width: 1920, height: 1080 },
  });
  assert.deepEqual(
    layout.resolvePhysicalGameRect({ x: 100, y: 200, width: 1280, height: 720, isForeground: false }, { width: 1920, height: 1080 }).physicalRect,
    { x: 100, y: 200, width: 1920, height: 1080, isForeground: false },
    '비활성 게임 창의 축소된 해상도가 포그라운드 캐시를 덮어씁니다.',
  );
  assert.equal(layout.isFullscreenBounds({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }), true);
  assert.equal(layout.isFullscreenBounds({ x: 0, y: 0, width: 1919, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }), false);
  const gameRect = { x: 100, y: 50, width: 1200, height: 800, isForeground: true };
  assert.deepEqual(layout.calculateAttachedWindowPosition(gameRect, { offsetX: -450, offsetY: 40 }), { x: 850, y: 90 });
  assert.deepEqual(layout.calculateBrowserOverlayPosition(gameRect, { offsetX: 10, offsetY: 20 }), { x: 110, y: 70 });
  assert.deepEqual(layout.calculateSidebarBounds('left', gameRect, 100, { x: 0, y: 0, width: 400, height: 700 }), {
    x: -300, y: 80, width: 400, height: 770,
  });
  assert.deepEqual(layout.calculateSidebarBounds('right', gameRect, 1300, { x: 0, y: 0, width: 400, height: 700 }), {
    x: 1300, y: 80, width: 400, height: 770,
  });
  assert.deepEqual(layout.calculateSidebarResizeBounds('left', { x: -300, y: 80, width: 400, height: 770 }, 500), {
    x: -400, y: 80, width: 500, height: 770,
  });
  assert.deepEqual(layout.resizeBounds({ x: 10, y: 20, width: 450, height: 400 }, undefined, 500), {
    x: 10, y: 20, width: 450, height: 500,
  });
  assert.equal(layout.hasBoundsChanged({ x: 0, y: 0, width: 100, height: 100 }, { x: 2, y: 0, width: 100, height: 100 }, 2), false);
  assert.equal(layout.hasPositionChanged({ x: 0, y: 0 }, { x: 3, y: 0 }, 2), true);
  assert.match(manager, /resolvePhysicalGameRect\(currentRect, lastForegroundSize\)/,
    '게임 해상도 캐시 계산이 공통 레이아웃 모듈과 연결되지 않았습니다.');
  assert.match(manager, /calculateSidebarBounds\(sidebarPos, scaledGameRect, edgeDipX, currentSidebarB\)/,
    '사이드바 좌우 배치가 공통 레이아웃 모듈과 연결되지 않았습니다.');
  assert.match(layoutSource, /Math\.abs\(current\.x - target\.x\) > threshold/,
    '좌표 변경 임계값 비교가 제거되었습니다.');

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(
    ipcHandlers,
    /const trackedGameRect = wm\.getGameRect\(\);[\s\S]*?getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)\.bounds/,
    '게임 오버레이 임시 복구가 게임/현재 디스플레이 대신 주 모니터 원점에 의존합니다.',
  );

  const gameOverlay = read('src/game-overlay.html');
  assert.match(gameOverlay, /function applyConfiguredHudPositions\(config\)/,
    '게임 오버레이 내부 HUD에 저장 좌표를 적용하는 경로가 없습니다.');
  assert.doesNotMatch(gameOverlay, /recoverHudPosition|applySafeHudPositions|recoveredSettings/,
    '게임 오버레이 내부 HUD가 일시적인 viewport 크기를 근거로 위치를 자동 복구합니다.');
  assert.doesNotMatch(gameOverlay,
    /applyConfiguredHudPositions[\s\S]*?window\.electronAPI\.applySettings/,
    '게임 오버레이의 자동 위치 적용이 사용자 HUD 좌표를 설정에 다시 저장합니다.');
  assert.doesNotMatch(gameOverlay, /window\.addEventListener\('resize',[\s\S]*?HudPositions/,
    '게임 오버레이 resize가 사용자 HUD 위치를 자동 변경합니다.');
  assert.doesNotMatch(gameOverlay, /config\.questHudPos/,
    '구형 퀘스트 HUD 위치가 새 위치 설정보다 우선할 수 있습니다.');
  assert.match(
    configSource,
    /isPlainObject\(parsed\.questHudPos\)[\s\S]*?parsed\.forgeQuestHudPos = sanitizeJsonValue\(parsed\.questHudPos\);[\s\S]*?delete parsed\.questHudPos;/,
    '구형 퀘스트 HUD 위치를 새 필드로 이전하는 마이그레이션이 없습니다.',
  );
  assert.match(
    configSource,
    /parsed\.hudHiddenPositionRepairV1 !== true[\s\S]*?repairLegacyHiddenHudPositions\(parsed\)[\s\S]*?parsed\.hudHiddenPositionRepairV1 = true/,
    '3.1.0에서 화면 밖으로 저장된 HUD 위치를 1회 복구하는 마이그레이션이 없습니다.',
  );

  const settingsSource = read('src/settings.html');
  const editModeSource = read('src/renderer/game-overlay/edit-mode.ts');
  assert.match(settingsSource, /if \(isHudEditing\)[\s\S]*?scrollIntoView[\s\S]*?return;/,
    'HUD 위치 편집 중 일반 저장을 차단하는 안전장치가 없습니다.');
  assert.match(settingsSource, /saveAllBtn\.disabled = editing/,
    'HUD 위치 편집 중 일반 저장 버튼을 비활성화하지 않습니다.');
  assert.match(settingsSource, /beforeunload[\s\S]*?stopHudEditMode\(false\)/,
    '설정 창을 닫을 때 미완료 HUD 위치를 저장합니다.');
  assert.match(editModeSource, /readPixelPosition\(el, 'left'\)[\s\S]*?initial\?\.left[\s\S]*?defaultPosition\?\.left/,
    '숨겨진 HUD의 0 rect 대신 실제 CSS 좌표를 보존하는 저장 경로가 없습니다.');
}

function checkDependencyOverrideContracts(): void {
  const packageSource = read('package.json');
  const packageData = JSON.parse(packageSource);

  assert.equal(
    (packageSource.match(/"overrides"\s*:/g) || []).length,
    1,
    'package.json에 overrides 키가 중복되어 앞쪽 보안 고정값이 무시될 수 있습니다.',
  );
  assert.match(packageData.overrides?.['js-yaml'] || '', /^\^4\.3\.1$/,
    '취약한 js-yaml 버전이 다시 설치될 수 있습니다.');
  assert.equal(packageData.scripts?.postinstall, 'electron-builder install-app-deps',
    'npm ci 후 Electron용 네이티브 모듈 ABI 재빌드가 실행되지 않습니다.');
  assert.match(packageData.scripts?.['dist:appx'] || '', /verify-appx-package\.js/,
    'AppX 생성 뒤 실제 패키지 내부를 검증하지 않습니다.');
  assert.equal(packageData.scripts?.['verify:appx'], 'npm run build-tools && node dist-tools/verify-appx-package.js',
    '기존 AppX 제출 파일을 독립 검증하는 명령이 유지되지 않습니다.');
  assert.equal(
    packageData.scripts?.['test:stress'],
    'npm run build && electron dist-tools/stress-test-high-throughput.js && electron dist-tools/stress-test-sustained.js',
    '고처리량·지속 부하 검사가 릴리즈 게이트에서 빠질 수 있습니다.',
  );
  assert.equal(packageData.build?.win?.requestedExecutionLevel, 'requireAdministrator',
    'Windows 실행 파일의 관리자 권한 요청이 제거되었습니다.');
  assert.deepEqual(packageData.build?.appx?.capabilities, ['runFullTrust', 'allowElevation'],
    'Microsoft Store 패키지의 전체 신뢰 및 승격 capability가 유지되지 않습니다.');
  assert.equal(packageData.build?.appx?.minVersion, '10.0.17763.0',
    'allowElevation을 지원하는 Windows 10 1809 이상으로 AppX 최소 버전을 제한해야 합니다.');
  assert.equal(packageData.build?.appx?.customManifestPath, 'appx/appxmanifest.xml',
    'Microsoft Store용 Visual C++ 런타임 의존성을 선언한 AppX manifest를 사용하지 않습니다.');

  const appxManifestPath = path.join(projectRoot, 'build', 'appx', 'appxmanifest.xml');
  assert.ok(fs.existsSync(appxManifestPath), 'Microsoft Store AppX manifest 원본이 누락되었습니다.');
  const appxManifest = fs.readFileSync(appxManifestPath, 'utf8');
  assert.match(appxManifest,
    /<PackageDependency\s[^>]*Name="Microsoft\.VCLibs\.140\.00\.UWPDesktop"[^>]*MinVersion="14\.0\.24217\.0"[^>]*Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"[^>]*\/>/i,
    'Koffi의 MSVCP140/VCRUNTIME140 종속성을 제공할 Store VCLibs framework 선언이 없습니다.');

  const appxAssets: Array<[string, number, number]> = [
    ['StoreLogo.png', 50, 50],
    ['Square44x44Logo.png', 44, 44],
    ['Square150x150Logo.png', 150, 150],
    ['Wide310x150Logo.png', 310, 150],
  ];
  for (const [fileName, width, height] of appxAssets) {
    const assetPath = path.join(projectRoot, 'build', 'appx', fileName);
    assert.ok(fs.existsSync(assetPath), `Microsoft Store 아이콘 누락: ${fileName}`);
    const png = fs.readFileSync(assetPath);
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${fileName}이 PNG 파일이 아닙니다.`);
    assert.equal(png.readUInt32BE(16), width, `${fileName} 너비가 ${width}px이 아닙니다.`);
    assert.equal(png.readUInt32BE(20), height, `${fileName} 높이가 ${height}px이 아닙니다.`);
  }
}

function checkSidebarMenuRegistryContracts(): void {
  const registry = require(path.join(projectRoot, 'dist', 'shared', 'sidebarMenus.js')) as {
    SIDEBAR_MENUS: Array<{ id: string; api?: string; action?: string; category?: string; icon: string; isOneDepth?: boolean }>;
    SIDEBAR_MENU_ACTIONS: readonly string[];
  };
  const menuIds = registry.SIDEBAR_MENUS.map(menu => menu.id);
  assert.equal(new Set(menuIds).size, menuIds.length, '사이드바 메뉴 ID가 중복되었습니다.');
  assert.ok(
    registry.SIDEBAR_MENUS.every(menu => registry.SIDEBAR_MENU_ACTIONS.includes(menu.api ?? menu.action ?? '')),
    '사이드바 메뉴에 등록되지 않은 동작이 연결되었습니다.',
  );
  const menuById = (id: string) => registry.SIDEBAR_MENUS.find(menu => menu.id === id);
  assert.deepEqual(
    ['scam-detector-btn', 'eta-ranking-btn', 'hunting-path-simulator-btn'].map(id => menuById(id)?.category),
    ['monitoring', 'information', 'calculators'],
  );
  assert.deepEqual(
    ['contents-checker-btn', 'sword-enhance-btn', 'qte-challenge-btn'].map(id => ({
      category: menuById(id)?.category,
      isOneDepth: menuById(id)?.isOneDepth,
    })),
    [
      { category: 'homework', isOneDepth: undefined },
      { category: 'minigame', isOneDepth: undefined },
      { category: 'minigame', isOneDepth: undefined },
    ],
  );

  const qte = require(path.join(projectRoot, 'dist', 'shared', 'qteChallenge.js')) as {
    createQteRound: (randomness: { position: number; blueSweep: number; yellowSweep: number }, difficulty: {
      durationMs: number;
      blueSweepDeg: number;
      blueSweepVarianceDeg: number;
      yellowSweepDeg: number;
      yellowSweepVarianceDeg: number;
    }) => {
      blueStartDeg: number; blueSweepDeg: number; yellowStartDeg: number; yellowSweepDeg: number; durationMs: number;
    };
    getPracticeDifficulty: () => {
      durationMs: number; blueSweepDeg: number; blueSweepVarianceDeg: number;
      yellowSweepDeg: number; yellowSweepVarianceDeg: number;
    };
    getQteChallengeDifficulty: (stage: number) => {
      durationMs: number; blueSweepDeg: number; blueSweepVarianceDeg: number;
      yellowSweepDeg: number; yellowSweepVarianceDeg: number;
    };
    classifyQteHit: (angle: number, round: object) => string;
    calculateQteScore: (result: string, combo: number, fever: boolean) => number;
    sanitizeQteChallengeRecords: (value: unknown) => Record<string, unknown>;
  };
  const practiceRound = qte.createQteRound({ position: 0.98, blueSweep: 0.1, yellowSweep: 0.9 }, qte.getPracticeDifficulty());
  assert.equal(practiceRound.durationMs, 1200, '실전 QTE 한 바퀴 시간이 영상 기준값과 다릅니다.');
  assert.ok(practiceRound.blueSweepDeg > practiceRound.yellowSweepDeg,
    'QTE 파란색 일반 성공 영역이 노란색 대성공 영역보다 넓지 않습니다.');
  assert.ok(practiceRound.blueStartDeg >= 10
    && practiceRound.blueStartDeg + practiceRound.blueSweepDeg <= 350
    && practiceRound.yellowStartDeg >= 10
    && practiceRound.yellowStartDeg + practiceRound.yellowSweepDeg <= 350,
  'QTE 색상 판정 영역이 한 바퀴 시작·종료 경계를 벗어납니다.');
  const generatedBlueSweeps = new Set<number>();
  const generatedYellowSweeps = new Set<number>();
  const generatedBlueStarts = new Set<number>();
  const generatedYellowStarts = new Set<number>();
  for (let sample = 0; sample <= 1_000; sample += 1) {
    const generatedRound = qte.createQteRound({
      position: sample / 1_000,
      blueSweep: ((sample * 37) % 1_001) / 1_000,
      yellowSweep: ((sample * 73) % 1_001) / 1_000,
    }, qte.getPracticeDifficulty());
    generatedBlueSweeps.add(generatedRound.blueSweepDeg);
    generatedYellowSweeps.add(generatedRound.yellowSweepDeg);
    generatedBlueStarts.add(Math.round(generatedRound.blueStartDeg));
    generatedYellowStarts.add(Math.round(generatedRound.yellowStartDeg));
    assert.ok(generatedRound.blueSweepDeg > generatedRound.yellowSweepDeg,
      '무작위 QTE 파란색 영역이 노란색 영역보다 넓지 않습니다.');
    assert.ok(generatedRound.blueStartDeg >= 10,
      `QTE 색상 영역이 시작 경계를 벗어났습니다: ${generatedRound.blueStartDeg}`);
    assert.ok(generatedRound.blueStartDeg + generatedRound.blueSweepDeg <= 350,
      `QTE 파란색 영역이 종료 경계를 벗어났습니다: ${generatedRound.blueStartDeg + generatedRound.blueSweepDeg}`);
    assert.ok(Math.abs(generatedRound.yellowStartDeg
      - (generatedRound.blueStartDeg + generatedRound.blueSweepDeg)) < 1e-9,
    'QTE 노란색 영역이 파란색 바로 뒤에 붙어 있지 않습니다.');
    assert.ok(generatedRound.yellowStartDeg > generatedRound.blueStartDeg,
      'QTE 노란색 영역이 회전 방향 기준 파란색 뒤에 배치되지 않습니다.');
    assert.ok(generatedRound.yellowStartDeg + generatedRound.yellowSweepDeg <= 350,
      `QTE 색상 영역이 종료 경계를 벗어났습니다: ${generatedRound.yellowStartDeg + generatedRound.yellowSweepDeg}`);
  }
  assert.ok(generatedBlueSweeps.size > 10 && generatedYellowSweeps.size > 10,
    'QTE 파란색·노란색 영역 크기가 매 라운드 무작위로 바뀌지 않습니다.');
  assert.ok(generatedBlueStarts.size > 10 && generatedYellowStarts.size > 10,
    'QTE 파란색·노란색 영역 위치가 매 라운드 무작위로 바뀌지 않습니다.');
  assert.equal(
    qte.classifyQteHit(practiceRound.blueStartDeg + practiceRound.blueSweepDeg / 2, practiceRound),
    'success',
    '파란색 판정 영역이 일반 성공으로 처리되지 않습니다.',
  );
  assert.equal(
    qte.classifyQteHit(practiceRound.yellowStartDeg + practiceRound.yellowSweepDeg / 2, practiceRound),
    'great',
    '노란색 판정 영역이 대성공으로 처리되지 않습니다.',
  );
  assert.equal(qte.classifyQteHit(180, practiceRound), 'fail', '색상 영역 밖 클릭이 실패로 처리되지 않습니다.');
  assert.equal(qte.calculateQteScore('great', 1, false), 300);
  assert.equal(qte.calculateQteScore('great', 10, true), 900,
    '대성공·콤보·피버 점수 배율이 올바르지 않습니다.');
  const hardDifficulty = qte.getQteChallengeDifficulty(50);
  assert.ok(hardDifficulty.durationMs >= 650 && hardDifficulty.blueSweepDeg > hardDifficulty.yellowSweepDeg,
    '고단계 챌린지에서 속도 하한 또는 파란색 영역 우위가 깨집니다.');
  assert.deepEqual(qte.sanitizeQteChallengeRecords({ bestScore: -1, bestCombo: 4.9, soundEnabled: false }), {
    bestScore: 0, bestCombo: 4, bestStage: 0, totalAttempts: 0, totalSuccess: 0, totalGreat: 0, soundEnabled: false,
  }, '손상된 QTE 로컬 기록을 안전하게 복구하지 못합니다.');

  const evolution = require(path.join(projectRoot, 'dist', 'shared', 'evolutionCalculator.js')) as {
    EVOLUTION_MOON_HERB_FIXED_COST_SEED: number;
    calculateEvolutionCost: (input: unknown) => {
      materialSeed: number; enchantScrollSeed: number; otherEnhancementSeed: number;
      eclipseBaseSeed: number; eclipseSealSeed: number; totalSeed: number; totalElso: number;
    };
    sanitizeEvolutionHistory: (value: unknown) => unknown[];
    getEvolutionItemImagePath: (name: string) => string;
  };
  assert.equal(evolution.EVOLUTION_MOON_HERB_FIXED_COST_SEED, 650_000_000,
    '직접 제작 달의 약초 고정 비용이 6.5억 시드가 아닙니다.');
  const selfCraftEvolutionCost = evolution.calculateEvolutionCost({
    materials: [
      { name: '테스트 재료', quantity: 2, unitPriceMan: 100, payment: 'seed' },
      { name: '태청금액신단', quantity: 6, unitPriceMan: 0, payment: 'elso', elsoUnitPrice: 23_000 },
    ],
    extras: {
      enchantScrollCount: 3, enchantScrollUnitPriceMan: 200,
      enchantAttemptCostMan: 300, magicReformCostMan: 400, additionalOptionCostMan: 500,
    },
    eclipse: {
      enabled: true, baseType: 'fake-armament', baseEquipmentCostMan: 1_000,
      sealMethod: 'self', proxyFeeMan: 2_000, moonMineralCostMan: 600, runeStoneCostMan: 700,
    },
  });
  assert.deepEqual(selfCraftEvolutionCost, {
    materialSeed: 2_000_000,
    enchantScrollSeed: 6_000_000,
    otherEnhancementSeed: 12_000_000,
    eclipseBaseSeed: 10_000_000,
    eclipseSealSeed: 663_000_000,
    totalSeed: 693_000_000,
    totalElso: 138_000,
  }, '진화 재료·후처리·직접 제작 비용 합산이 올바르지 않습니다.');
  const proxyEvolutionCost = evolution.calculateEvolutionCost({
    materials: [{ name: '테스트 재료', quantity: 2, unitPriceMan: 100, payment: 'seed' }],
    extras: {
      enchantScrollCount: 3, enchantScrollUnitPriceMan: 200,
      enchantAttemptCostMan: 300, magicReformCostMan: 400, additionalOptionCostMan: 500,
    },
    eclipse: {
      enabled: true, baseType: 'abyss-equipment', baseEquipmentCostMan: 1_000,
      sealMethod: 'proxy', proxyFeeMan: 2_000, moonMineralCostMan: 600, runeStoneCostMan: 700,
    },
  });
  assert.equal(proxyEvolutionCost.totalSeed, 50_000_000,
    '인장 대리 제작에서 직접 제작 재료비가 중복 합산됩니다.');
  const directEvolutionCost = evolution.calculateEvolutionCost({
    materials: [{ name: '어비스까지 직접 진화 재료', quantity: 2, unitPriceMan: 100, payment: 'seed' }],
    extras: {},
    eclipse: {
      enabled: true, baseType: 'direct-evolution', baseEquipmentCostMan: 9_999,
      sealMethod: 'proxy', proxyFeeMan: 0,
    },
  });
  assert.equal(directEvolutionCost.materialSeed, 2_000_000,
    '직접 어비스까지 진화하는 구간의 일반 재료비가 누락됩니다.');
  assert.equal(directEvolutionCost.eclipseBaseSeed, 0,
    '직접 어비스까지 진화하는 방식에 완성 장비 구매비가 중복 합산됩니다.');
  const expandedPostProcessCost = evolution.calculateEvolutionCost({
    materials: [],
    extras: {
      abilityMountCostMan: 100,
      attributeGrantCostMan: 200,
      enhancementCostMan: 300,
    },
    eclipse: { enabled: false },
  });
  assert.equal(expandedPostProcessCost.otherEnhancementSeed, 6_000_000,
    '어빌리티 장착·속성 부여·강화 비용이 장비 후처리 합계에 반영되지 않습니다.');
  assert.deepEqual(evolution.sanitizeEvolutionHistory([{ id: '', title: '손상', selection: {} }, null]), [],
    '손상된 진화 계산 이력이 안전하게 제외되지 않습니다.');
  assert.equal(
    decodeURIComponent(evolution.getEvolutionItemImagePath('고대 기사의 건틀렛 파편')),
    'assets/items/고대기사의건틀렛파편.png',
    '수정된 건틀렛 재료명이 실제 이미지 경로와 일치하지 않습니다.',
  );
  assert.equal(
    decodeURIComponent(evolution.getEvolutionItemImagePath('고대 기사의 건틀릿 파편')),
    'assets/items/고대기사의건틀렛파편.png',
    '기존 계산 이력의 건틀릿 표기 호환 alias가 제거되었습니다.',
  );

  const managerSource = read('src/modules/windowManager.ts');
  const indexSource = read('src/index.html');
  const dockSource = read('src/dock.html');
  const qteHtml = read('src/qte-challenge.html');
  assert.match(managerSource, /toggleQteChallengeWindow\(\)[\s\S]*?createToggleableWindow\('qteChallenge'\)/,
    'QTE 챌린지가 별도 관리 창으로 연결되지 않았습니다.');
  assert.match(managerSource, /toggleSwordEnhanceWindow\(\)[\s\S]*?new EmbeddedWebTool/,
    '메뉴 depth 변경 과정에서 기존 검 강화 별도 창 구현이 제거되었습니다.');
  assert.match(indexSource, /menu\.image[\s\S]*?<img src="\$\{menu\.image\}"/,
    '사이드바 2depth에서 기존 검 강화 이미지 아이콘을 표시하지 않습니다.');
  assert.match(dockSource, /menu\.image[\s\S]*?<img src="\$\{menu\.image\}"/,
    '독 2depth에서 기존 검 강화 이미지 아이콘을 표시하지 않습니다.');
  assert.match(qteHtml, /shared\/qteChallenge\.js[\s\S]*?qte-challenge-renderer\.js/,
    'QTE 판정 엔진과 전용 렌더러가 신규 창에 연결되지 않았습니다.');
  const evolutionHtml = read('src/evolution-calculator.html');
  assert.match(evolutionHtml, /shared\/evolutionCalculator\.js[\s\S]*?evolution-calculator-renderer\.js/,
    '진화 비용 순수 계산 엔진과 이력 렌더러가 계산기 창에 연결되지 않았습니다.');
  for (const requiredEvolutionLabel of [
    '인챈트 주문서', '인챈트 시도 비용', '매직리폼 비용', '부가옵션 비용',
    '가짜 달여왕 군단의 무구', '어비스 장비', '인장 6개 직접 제작', '인장 6개 대리 제작',
    '달의 광물 비용', '룬의 원석 비용', '6억 5,000만 시드', '계산 이력',
  ]) {
    assert.ok(evolutionHtml.includes(requiredEvolutionLabel),
      `진화 재료 계산기 고도화 항목이 누락되었습니다: ${requiredEvolutionLabel}`);
  }

  const traySource = read('src/modules/tray.ts');
  const actionSource = read('src/modules/trayMenuActions.ts');
  assert.match(traySource, /SIDEBAR_MENUS, getSidebarMenuAction/,
    '트레이가 공통 사이드바 메뉴 레지스트리를 사용하지 않습니다.');
  assert.doesNotMatch(traySource, /apiMapping|sidebar_menus\.json/,
    '트레이에 메뉴 메타데이터 또는 동작 매핑이 다시 중복 선언되었습니다.');
  assert.match(actionSource, /satisfies Record<TrayMenuAction, TrayMenuHandler>/,
    '트레이 동작 구현의 타입 완전성 검사가 없습니다.');
}

function checkWindowFocusControllerContracts(): void {
  const focusModule = require(path.join(projectRoot, 'dist', 'modules', 'windowFocusController.js')) as {
    WindowFocusController: new (options: Record<string, unknown>) => {
      attach: (win: any) => void;
      getOrderedWindowHandles: (main: any, dock: any, overlay: any) => string[];
      setRestoreSuppressed: (suppressed: boolean) => void;
      cancelPendingRestore: () => void;
      scheduleRestore: () => void;
    };
  };

  function createFakeWindow(handleId: number) {
    const listeners: Record<string, Array<() => void>> = {};
    const webListeners: Record<string, Array<() => void>> = {};
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(handleId));
    let destroyed = false;
    let visible = true;
    let devtoolsCloseCount = 0;
    return {
      on(event: string, callback: () => void) { (listeners[event] ||= []).push(callback); },
      emit(event: string) { listeners[event]?.forEach(callback => callback()); },
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      getNativeWindowHandle: () => handle,
      webContents: {
        on(event: string, callback: () => void) { (webListeners[event] ||= []).push(callback); },
        closeDevTools() { devtoolsCloseCount += 1; },
      },
      emitWeb(event: string) { webListeners[event]?.forEach(callback => callback()); },
      setDestroyed(value: boolean) { destroyed = value; },
      setVisible(value: boolean) { visible = value; },
      getDevtoolsCloseCount: () => devtoolsCloseCount,
    };
  }

  const controller = new focusModule.WindowFocusController({
    isDev: false,
    focusDebounceMs: 50,
    focusRestoreDelayMs: 50,
    onWindowFocused: () => {},
    canScheduleRestore: () => true,
    canRestoreFocus: () => true,
    restoreFocus: () => {},
  });
  const olderSub = createFakeWindow(11);
  const newerSub = createFakeWindow(12);
  const main = createFakeWindow(21);
  const dock = createFakeWindow(22);
  const overlay = createFakeWindow(23);
  controller.attach(olderSub);
  controller.attach(newerSub);
  assert.deepEqual(controller.getOrderedWindowHandles(main, dock, overlay), ['12', '11', '21', '22', '23']);

  olderSub.emitWeb('devtools-opened');
  assert.equal(olderSub.getDevtoolsCloseCount(), 1, '프로덕션 창의 개발자 도구 방어가 연결되지 않았습니다.');
  newerSub.emit('closed');
  assert.deepEqual(controller.getOrderedWindowHandles(main, dock, overlay), ['11', '21', '22', '23']);

  const manager = read('src/modules/windowManager.ts');
  const controllerSource = read('src/modules/windowFocusController.ts');
  assert.doesNotMatch(manager, /activeWindowsStack|focusRestoreTimer|suppressFocusRestore/,
    'windowManager에 포커스 스택 또는 복구 타이머 상태가 다시 중복되었습니다.');
  assert.match(manager, /focusController\.scheduleRestore\(\)/,
    '창 종료와 공통 게임 포커스 복구 정책이 연결되지 않았습니다.');
  assert.match(controllerSource, /restoreSuppressed \|\| !this\.options\.canScheduleRestore\(\)/,
    '앱 종료 또는 일괄 숨김 중 포커스 복구를 차단하지 않습니다.');
  controller.cancelPendingRestore();
}

function checkWindowedFullscreenFocusContracts(): void {
  const packageJson = read('package.json');
  const manager = read('src/modules/windowManager.ts');
  const polling = read('src/modules/pollingLoop.ts');
  const tracker = read('src/modules/tracker.ts');
  const zOrderController = read('src/modules/zOrderController.ts');
  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  const fixtureProject = read('scripts/fixtures/FakeTalesWeaver/FakeTalesWeaver.csproj');
  const fixtureManifest = read('scripts/fixtures/FakeTalesWeaver/app.manifest');
  const fixtureSource = read('scripts/fixtures/FakeTalesWeaver/Program.cs');
  const windowsProbe = read('scripts/runtime-zorder-windows-probe.ts');

  assert.match(packageJson, /"build:zorder-fixture":[^\n]*dotnet build[^\n]*FakeTalesWeaver\.csproj/,
    '가짜 테일즈위버 Windows fixture 빌드 명령이 없습니다.');
  assert.match(packageJson, /"test:zorder:windows":[^\n]*runtime-zorder-windows-probe\.js/,
    '실제 HWND Z-order 통합 검사 명령이 없습니다.');
  assert.match(fixtureProject, /<AssemblyName>InphaseNXD-zorder-fixture<\/AssemblyName>/,
    '제품 tracker가 우회 없이 탐지할 수 있는 fixture 실행 파일 이름이 아닙니다.');
  assert.match(fixtureProject, /FixtureRequireAdministrator[^\n]*true[\s\S]*?ApplicationManifest[^\n]*FixtureRequireAdministrator[^\n]*true/,
    '가짜 테일즈위버가 기본적으로 관리자 권한 매니페스트를 사용하지 않습니다.');
  assert.match(fixtureManifest, /requestedExecutionLevel level="requireAdministrator"/,
    '가짜 테일즈위버가 실제 게임과 같은 관리자 권한을 요구하지 않습니다.');
  assert.match(fixtureSource, /Talesweaver Z-Order Fixture/,
    '가짜 테일즈위버 창 제목 계약이 없습니다.');
  assert.match(fixtureSource, /"windowed" => FixtureMode\.Windowed[\s\S]*?"borderless" => FixtureMode\.Borderless/,
    '가짜 테일즈위버가 창모드와 창모드 전체화면을 모두 제공하지 않습니다.');
  assert.match(fixtureSource, /--status-file[\s\S]*?--command-file[\s\S]*?Keys\.F11/,
    '가짜 테일즈위버의 자동화 상태·명령 채널 또는 수동 모드 전환이 없습니다.');
  assert.match(windowsProbe, /IsUserAnAdmin[\s\S]*?관리자 PowerShell에서 npm run test:zorder:windows/,
    'Windows 통합 검사가 동일 권한 레벨을 강제하지 않습니다.');
  assert.match(windowsProbe, /runScenario\('windowed'[\s\S]*?runScenario\('borderless'/,
    'Windows 통합 검사가 두 게임 창 모드를 모두 실행하지 않습니다.');

  assert.match(polling, /const TRANSIENT_STATE_CONFIRM_SAMPLES = 2/,
    '순간적인 게임 창 탐지 실패를 재확인하는 방어가 없습니다.');
  assert.match(polling, /tracker\.reconcileGameZOrder\(currentRect\.gameHwnd, windowHwnds\)/,
    '폴링 Z-order 정책이 게임·TW-Overlay·실제 외부 창 포커스를 공통 판별하는 샌드위치 경계를 사용하지 않습니다.');
  assert.match(polling, /tracker\.releaseGameZOrder\(\);[\s\S]*?wm\.resetGameSessionState\(\)/,
    '게임 종료 시 동적 Topmost 상태를 해제하지 않습니다.');
  assert.match(polling, /tracker\.releaseGameZOrder\(\);[\s\S]*?wm\.hideAll\(\{ preserveForResume: true \}\)/,
    '게임 최소화 시 Topmost를 해제한 뒤 자동 복원 창을 재사용하지 않습니다.');
  assert.match(manager, /preserveForResume[\s\S]*?key === 'chatOverlay'[\s\S]*?winCfg\.ref\.hide\(\)/,
    '게임 최소화 때 채팅 오버레이 renderer를 숨겨 재사용하지 않습니다.');

  const focusStart = tracker.indexOf('export function focusGameWindow(): boolean');
  const focusEnd = tracker.indexOf('export function isGameOrAppForeground', focusStart);
  assert.ok(focusStart >= 0 && focusEnd > focusStart, '자동 게임 포커스 복구 함수를 찾지 못했습니다.');
  const focusGameWindow = tracker.slice(focusStart, focusEnd);
  assert.match(focusGameWindow, /win32\.IsIconic && win32\.IsIconic\(cachedHwnd\)/,
    '실제 최소화 여부를 확인하지 않고 게임 창 상태를 복원합니다.');
  assert.doesNotMatch(focusGameWindow, /BringWindowToTop|keybd_event/,
    '자동 포커스 복구가 강제 Z-order 변경 또는 Alt 키 입력을 사용합니다.');
  assert.doesNotMatch(read('src/modules/win32.ts'), /keybd_event|VK_MENU|KEYEVENTF_KEYUP/,
    '미사용 가상 키 입력 바인딩이 Win32 모듈에 남아 있습니다.');
  assert.match(tracker, /export function canAutomaticallyRestoreGameFocus\(\): boolean/,
    '외부 창 포커스를 보호하는 자동 복구 허용 검사가 없습니다.');
  assert.match(manager, /canScheduleRestore:[^\n]*tracker\.canAutomaticallyRestoreGameFocus\(\)/,
    '지연 포커스 복구 예약 시점에 외부 창 포커스를 확인하지 않습니다.');
  assert.match(manager, /canRestoreFocus:[^\n]*tracker\.canAutomaticallyRestoreGameFocus\(\)/,
    '지연 포커스 복구 실행 직전에 외부 창 포커스를 재확인하지 않습니다.');
  assert.match(read('src/main.ts'), /previousForegroundOwner === 'external'[\s\S]*?foregroundOwner === 'app'[\s\S]*?activateGameBehindAppWindow\(focusedHwndStr\)/,
    '외부 앱에서 TW-Overlay 작업표시줄 창을 명시적으로 선택했을 때 게임 묶음을 활성화하지 않습니다.');
  assert.match(manager, /export function activateGameBehindAppWindow\(focusedAppHwnd: string\)[\s\S]*?focusGameForAppActivation\(focusedAppHwnd\)[\s\S]*?refocusVisibleWindowByHandle\(focusedAppHwnd\)/,
    '명시적 앱 활성화가 게임을 먼저 올린 뒤 사용자가 선택한 TW-Overlay 창으로 포커스를 돌리지 않습니다.');
  const explicitActivationStart = tracker.indexOf('export function focusGameForAppActivation');
  const explicitActivationEnd = tracker.indexOf('export function releaseGameZOrder', explicitActivationStart);
  assert.ok(explicitActivationStart >= 0 && explicitActivationEnd > explicitActivationStart,
    '명시적 TW-Overlay 활성화용 게임 포커스 함수를 찾지 못했습니다.');
  const explicitActivationSource = tracker.slice(explicitActivationStart, explicitActivationEnd);
  assert.match(explicitActivationSource, /foregroundBefore !== expectedAppHwnd/,
    '예약 뒤 foreground가 바뀐 요청을 폐기하지 않습니다.');
  assert.match(explicitActivationSource, /win32\.IsIconic && win32\.IsIconic\(cachedHwnd\)[\s\S]*?return false/,
    '사용자가 최소화한 게임을 TW-Overlay 작업표시줄 활성화로 복원할 수 있습니다.');
  assert.match(explicitActivationSource, /SetForegroundWindow\(cachedHwnd\)/,
    '명시적 사용자 활성화에서 게임을 같은 작업 묶음으로 올리지 않습니다.');
  assert.doesNotMatch(explicitActivationSource, /ShowWindow|BringWindowToTop|keybd_event|SetWindowPos/,
    '명시적 사용자 활성화가 게임 show state·Topmost 또는 가상 키를 변경합니다.');
  assert.match(windowsProbe, /appActivationRaisedGame[\s\S]*?explicit app group activation/,
    'Windows 실제 HWND probe가 작업표시줄 TW-Overlay 활성화 시 게임 동반 상승을 검사하지 않습니다.');

  const sandwichStart = manager.indexOf('function bringGameAndOverlaysToTop(): void');
  const sandwichEnd = manager.indexOf('export const isAnyUserDragging', sandwichStart);
  assert.ok(sandwichStart >= 0 && sandwichEnd > sandwichStart, '샌드위치 Z-order 함수를 찾지 못했습니다.');
  const sandwichSource = manager.slice(sandwichStart, sandwichEnd);
  assert.match(sandwichSource, /tracker\.reconcileGameZOrder\(gameHwndStr, getAllWindowHwnds\(\)\)/,
    'TW-Overlay 포커스 시 오버레이를 게임 바로 위로 정렬하지 않습니다.');
  assert.doesNotMatch(sandwichSource, /placeGameBelowWindow|reconcileGameZOrder\([^\n]*true\)/,
    '샌드위치 정책이 게임 창 자체를 이동하거나 외부 포커스 보호를 우회합니다.');
  assert.doesNotMatch(ipcHandlers, /setAlwaysOnTop\(true, 'screen-saver'\)/,
    'HUD 효과·편집·게임 부착 창이 중앙 Z-order 정책 밖에서 외부 앱 위로 올라갑니다.');
  assert.match(ipcHandlers, /function reconcileGameAttachedWindows\(\)[\s\S]*?tracker\.reconcileGameZOrder\(gameHwnd, wm\.getAllWindowHwnds\(\)\)/,
    'HUD 효과·편집·사냥 동선 오버레이를 중앙 Z-order 정책으로 복귀하는 경로가 없습니다.');
  const hudEditHandler = ipcHandlers.match(
    /ipcMain\.handle\('set-game-overlay-edit-mode'[\s\S]*?\n  \}\);/,
  )?.[0] || '';
  assert.match(hudEditHandler, /if \(!tracker\.isGameRunning\(\)\) return false;/,
    'HUD 위치 편집 시작이 실제 게임 창 존재 여부를 확인하지 않습니다.');
  assert.match(hudEditHandler, /tracker\.focusGameWindow\(\);/,
    'HUD 위치 편집 시작 시 최소화된 게임 복원과 전환을 시도하지 않습니다.');
  assert.doesNotMatch(hudEditHandler, /if \([^\n]*(?:focus|restor)[^\n]*\)[^\n]*return false/i,
    'HUD 위치 편집이 Windows 포커스 전환 실패를 게임 미실행으로 잘못 판정합니다.');
  assert.doesNotMatch(tracker, /restoreAndFocusGameWindow|BringWindowToTop|keybd_event/,
    'HUD 위치 편집용 강제 Z-order/가상 키 포커스 우회가 tracker에 남아 있습니다.');
  const noticeStart = manager.indexOf('export function createUpdateNoticeWindow(): void');
  const noticeEnd = manager.indexOf('export function closeUpdateNoticeWindow(): void', noticeStart);
  assert.ok(noticeStart >= 0 && noticeEnd > noticeStart, '업데이트 공지 창 생성 경로를 찾지 못했습니다.');
  assert.doesNotMatch(manager.slice(noticeStart, noticeEnd), /alwaysOnTop:\s*true/,
    '업데이트 공지 창이 외부 앱의 자연스러운 Z-order를 침범합니다.');
  assert.doesNotMatch(tracker, /export function placeGameBelowWindow/,
    '샌드위치 정책 외부에서 게임 창 Z-order를 직접 이동하는 API가 남아 있습니다.');
  assert.match(tracker, /gameOverlayZOrderController\.reconcile\(/,
    'tracker가 포커스·위치 사건을 단일 Z-order 상태 관리자에 전달하지 않습니다.');
  assert.doesNotMatch(tracker, /SetWindowPos\(/,
    'tracker에 상태 관리자 밖의 직접 Z-order 쓰기가 남아 있습니다.');
  assert.match(zOrderController, /const groupHwnds = overlayHwnds/,
    'TW-Overlay Z-order 묶음이 우리 프로그램 창만 포함하지 않습니다.');
  assert.doesNotMatch(zOrderController, /groupHwnds\s*=\s*\[\.\.\.overlayHwnds,\s*input\.gameHwnd\]/,
    '테일즈위버 HWND가 TW-Overlay 쓰기 대상 묶음에 포함되어 있습니다.');
  assert.match(zOrderController, /findOverlayPlacementAnchor\([\s\S]*?placeWindowStack\(placementAnchor, groupHwnds\)/,
    '외부 창의 자연스러운 순서를 보존한 채 TW-Overlay를 게임 바로 위에 배치하지 않습니다.');
  assert.doesNotMatch(zOrderController, /setWindowAfter\((?:input\.)?gameHwnd|setWindowAfter\(gameHwnd/,
    '중앙 Z-order 관리자가 테일즈위버 창을 직접 이동합니다.');
  assert.match(zOrderController, /return rectsOverlap\(input\.foregroundRect, input\.gameRect\)[\s\S]*?'external-game-monitor'[\s\S]*?'external-other-monitor'/,
    '진단과 실기 증거를 위한 외부 창의 게임 영역 겹침 상태 분류가 없습니다.');
  assert.match(zOrderController, /first\.left < second\.right[\s\S]*?first\.bottom > second\.top/,
    '듀얼 모니터 창 겹침 판정이 네 방향 경계를 모두 검사하지 않습니다.');
  assert.match(tracker, /SetWinEventHook\([\s\S]*?EVENT_OBJECT_LOCATIONCHANGE,[\s\S]*?EVENT_OBJECT_LOCATIONCHANGE/,
    '반대편 모니터의 전경 창 이동을 실시간 감지하는 위치 이벤트 훅이 없습니다.');
  assert.match(tracker, /event === win32\.EVENT_OBJECT_LOCATIONCHANGE[\s\S]*?safeHwnd === foregroundHwnd[\s\S]*?onForegroundChangeCallback/,
    '전경 외부 창의 모니터 진입을 폴링 전에 즉시 Z-order 재판정하지 않습니다.');
  assert.match(tracker, /if \(hLocationEventHook\)[\s\S]*?UnhookWinEvent\(hLocationEventHook\)/,
    '앱 종료 시 위치 이벤트 훅을 해제하지 않습니다.');
  assert.match(tracker, /EVENT_SYSTEM_MINIMIZESTART[\s\S]*?EVENT_SYSTEM_MINIMIZEEND/,
    '게임 최소화 종료 이벤트를 즉시 감지하는 WinEvent hook이 없습니다.');
  assert.match(tracker, /if \(hMinimizeEventHook\)[\s\S]*?UnhookWinEvent\(hMinimizeEventHook\)/,
    '앱 종료 시 최소화 이벤트 훅을 해제하지 않습니다.');
  assert.match(zOrderController, /desiredTopmost\s*=\s*isGameOrAppFocused \|\| gameIsTopmost[\s\S]*?allWindowsMatchDesiredBand[\s\S]*?isWindowStackIntact/,
    '게임 foreground에서는 우리 창만 승격하고 외부 foreground에서는 샌드위치로 복귀하는 검사가 없습니다.');
  assert.doesNotMatch(zOrderController, /keepElevatedForSeparateMonitor|splitForSeparateExternal/,
    '외부 창의 모니터 위치 또는 우리 창의 rect에 따라 Topmost를 유지하는 정책이 남아 있습니다.');
  assert.match(zOrderController, /const placementAnchor = this\.findOverlayPlacementAnchor\([\s\S]*?const bandAnchor = desiredTopmost/,
    'Topmost 강등 전에 기존 외부 창 anchor를 보존하지 않습니다.');
  assert.match(zOrderController, /if \(!this\.native\.isVisible\(current\)\)[\s\S]*?continue/,
    '숨은 Electron·시스템 보조 HWND를 보이는 외부 창으로 오인합니다.');
  assert.match(tracker, /export function releaseGameZOrder\(\): void[\s\S]*?gameOverlayZOrderController\.release\(\)/,
    '앱 종료 시 TW-Overlay Z-order 상태만 정리하는 경로가 없습니다.');
  assert.match(tracker, /className === 'Shell_TrayWnd' \|\| className === 'Shell_SecondaryTrayWnd'/,
    '우리 설정창 종료 후 작업표시줄이 foreground를 가져간 경우를 구분하지 않습니다.');
  assert.match(manager, /const deferDockLayout = pendingDockLayoutChange && !tracker\.isGameOrAppForeground\(\)/,
    '설정창이 전경인 동안 독 재배치를 끝내지 않고 게임 복귀 뒤 독을 다시 표시합니다.');
  assert.match(manager, /if \(isDockPositionChange\)[\s\S]*?pendingDockLayoutChange = true/,
    '일반 창모드와 전체화면에서 동일한 독 재배치 경계를 사용하지 않습니다.');
  assert.match(manager, /dockCfg\.ref\.hide\(\);[\s\S]*?dockCfg\.ref\.setPosition\(x, y\);[\s\S]*?dockCfg\.ref\.showInactive\(\);/,
    '표시 중인 투명 독을 숨기지 않은 채 화면 반대편으로 이동합니다.');
  assert.match(manager, /win\.once\('ready-to-show'/,
    '관리 창 ready-to-show 재발생 시 show/showInactive가 반복될 수 있습니다.');
  assert.match(manager, /SHOULD_AUTO_OPEN_DEVTOOLS/,
    '개발 실행이 분리형 DevTools 창을 항상 열어 전체화면 실기 검증을 오염시킵니다.');
  assert.doesNotMatch(manager, /if \(IS_DEV\)[^{\n]*\{?[^\n]*openDevTools/,
    '명시적 --devtools 옵션 없이 분리형 DevTools 창을 자동으로 엽니다.');
  assert.match(zOrderController, /for \(let i = overlayHwnds\.length - 1; i > 0; i--\)/,
    '게임 바로 위 한 창만 확인하고 TW-Overlay 내부 Z-order가 갈라진 상태를 정상으로 오판합니다.');
  assert.match(manager, /overlayWindow\?\.showInactive\(\)/,
    '브라우저 오버레이 자동 생성이 포커스를 획득할 수 있습니다.');
  assert.match(manager, /type ManagedWindowShowReason = 'user-open' \| 'game-resync' \| 'settings-apply' \| 'preload'/,
    '사용자가 연 창과 자동 재생성을 구분하는 표시 정책이 없습니다.');
  assert.match(manager, /showReason === 'user-open' && !isPassiveOverlay[\s\S]*?win\.show\(\);[\s\S]*?win\.showInactive\(\);/,
    '자동 재생성된 관리 창이 비활성 상태로 표시되지 않습니다.');
  assert.doesNotMatch(manager, /key === 'dock'[^\n]*focusable: false/,
    '독 창이 no-activate로 생성되어 hover만 되고 클릭이 전달되지 않을 수 있습니다.');
  assert.match(manager, /if \(key === 'dock'\)[\s\S]*?setIgnoreMouseEvents\(true, \{ forward: true \}\)/,
    '독 renderer가 준비되기 전 투명 여백이 게임 입력을 가로챌 수 있습니다.');
  assert.ok((manager.match(/'game-resync'/g) ?? []).length >= 6,
    '게임 동기화 중 생성되는 창의 비활성 표시 사유가 누락되었습니다.');
  const clickThroughStart = manager.indexOf('export function toggleClickThrough(): boolean');
  const clickThroughEnd = manager.indexOf('export function toggleSidebar(): boolean', clickThroughStart);
  assert.ok(clickThroughStart >= 0 && clickThroughEnd > clickThroughStart,
    '클릭 투과 전환 함수를 찾지 못했습니다.');
  assert.doesNotMatch(manager.slice(clickThroughStart, clickThroughEnd), /reconcileGameZOrder\([^\n]*true\)/,
    '클릭 투과 전환이 외부 프로그램 전환 후에도 Z-order를 강제 변경할 수 있습니다.');

  const dockToggleStart = manager.indexOf('export function toggleDockWindow(): void');
  const dockToggleEnd = manager.indexOf('export function toggleContentsCheckerWindow', dockToggleStart);
  assert.ok(dockToggleStart >= 0 && dockToggleEnd > dockToggleStart, '독 토글 함수를 찾지 못했습니다.');
  const dockToggleSource = manager.slice(dockToggleStart, dockToggleEnd);
  assert.match(dockToggleSource, /if \(winCfg\.ref\.isVisible\(\)\)[\s\S]*?winCfg\.ref\.hide\(\)/,
    '독을 숨길 때 창을 유지하지 않아 다음 표시에 renderer 재생성 지연이 발생합니다.');
  assert.doesNotMatch(dockToggleSource, /winCfg\.ref\.close\(\)/,
    '단축키 독 숨김이 창을 파괴해 다음 표시를 지연시킵니다.');
  assert.match(dockToggleSource, /winCfg\.ref\.setPosition\(x, y\);[\s\S]*?winCfg\.ref\.showInactive\(\)/,
    '숨긴 독의 위치를 먼저 확정하지 않아 표시 직후 화면 점프가 발생할 수 있습니다.');
  assert.match(manager, /if \(!isDockVisible\)[\s\S]*?dockCfg\.ref\.hide\(\)/,
    '안정 폴링이 숨긴 독 창을 닫아 재사용 최적화를 무효화합니다.');
  assert.match(manager, /createToggleableWindow\('dock', undefined, 'preload'\)/,
    '독 모드 진입 시 숨은 renderer를 미리 준비하지 않아 첫 단축키 표시가 지연됩니다.');
  assert.match(manager, /showReason === 'preload'[\s\S]*?showMethod = 'preload-hidden'/,
    '사전 로딩한 독이 준비 과정에서 화면에 노출될 수 있습니다.');
  assert.match(ipcHandlers, /ipcMain\.on\('save-quick-slots'[\s\S]*?config\.saveImmediate\(\{ quickSlots: slots \}\);[\s\S]*?wm\.broadcastConfig\(\)/,
    '퀵링크 저장 후 재사용 중인 독 renderer에 최신 설정을 즉시 전달하지 않습니다.');
  assert.match(read('src/dock.html'), /onConfigData\(\(config\) => \{[\s\S]*?appConfig = config;[\s\S]*?renderDock\(\)/,
    '독 renderer가 퀵링크·위치 설정 변경을 수신해 즉시 다시 그리지 않습니다.');
  assert.match(read('src/dock.html'), /target\.closest\('\.dock-container'\)[\s\S]*?setDockMousePassThrough\(!isInteractive\)/,
    '독의 실제 UI와 투명 여백을 구분하는 마우스 투과 처리가 없습니다.');

  const zOrderRuntime = require(path.join(projectRoot, 'dist', 'modules', 'zOrderController.js')) as {
    GameOverlayZOrderController: new (
      native: {
        top: bigint;
        topmost: bigint;
        notTopmost: bigint;
        getForegroundWindow(): bigint;
        getWindowRect(hwnd: bigint): { left: number; top: number; right: number; bottom: number } | null;
        getWindowAbove(hwnd: bigint): bigint;
        isTopmost(hwnd: bigint): boolean;
        isVisible(hwnd: bigint): boolean;
        setWindowAfter(hwnd: bigint, insertAfter: bigint): boolean;
      },
      writeLog?: (message: string) => void,
    ) => {
      getState(): string;
      reconcile(input: { gameHwnd: bigint; overlayHwnds: bigint[] }): { state: string };
      release(): void;
    };
  };
  for (const mode of ['windowed', 'borderless'] as const) {
    const base = mode === 'windowed' ? 100n : 200n;
    const gameHwnd = base;
    const firstOverlayHwnd = base + 1n;
    const secondOverlayHwnd = base + 2n;
    const hiddenHelperHwnd = base + 3n;
    const externalAHwnd = base + 4n;
    const externalBHwnd = base + 5n;
    const taskbarHwnd = base + 6n;
    let foregroundHwnd = gameHwnd;
    const topmostHwnds = new Set<bigint>();
    const setWindowCalls: Array<{ hwnd: bigint; insertAfter: bigint }> = [];
    const windowAbove = new Map<bigint, bigint>([
      [gameHwnd, hiddenHelperHwnd],
      [hiddenHelperHwnd, secondOverlayHwnd],
      [secondOverlayHwnd, firstOverlayHwnd],
      [firstOverlayHwnd, 0n],
    ]);
    const rects = new Map<bigint, { left: number; top: number; right: number; bottom: number }>([
      [gameHwnd, { left: 0, top: 0, right: 100, bottom: 100 }],
      [externalAHwnd, { left: 10, top: 0, right: 90, bottom: 100 }],
      [externalBHwnd, { left: 20, top: 0, right: 80, bottom: 100 }],
      [taskbarHwnd, { left: 0, top: 90, right: 100, bottom: 100 }],
    ]);
    const fakeNative = {
      top: 0n,
      topmost: -1n,
      notTopmost: -2n,
      getForegroundWindow: (): bigint => foregroundHwnd,
      getWindowRect: (hwnd: bigint) => rects.get(hwnd) ?? null,
      getWindowAbove: (hwnd: bigint): bigint => windowAbove.get(hwnd) ?? 0n,
      isTopmost: (hwnd: bigint): boolean => topmostHwnds.has(hwnd),
      isVisible: (hwnd: bigint): boolean => hwnd !== hiddenHelperHwnd,
      setWindowAfter: (hwnd: bigint, insertAfter: bigint): boolean => {
        setWindowCalls.push({ hwnd, insertAfter });
        if (insertAfter === -2n) topmostHwnds.delete(hwnd);
        else if (insertAfter === -1n || topmostHwnds.has(insertAfter)) topmostHwnds.add(hwnd);
        windowAbove.set(hwnd, insertAfter > 0n ? insertAfter : 0n);
        return true;
      },
    };
    const zOrder = new zOrderRuntime.GameOverlayZOrderController(fakeNative, () => undefined);
    const zOrderInput = { gameHwnd, overlayHwnds: [firstOverlayHwnd, secondOverlayHwnd] };

    // 일반 HWND_TOP만으로 foreground 게임 위에 남지 못하므로 게임 활성 동안 우리 창만 승격한다.
    assert.equal(zOrder.reconcile(zOrderInput).state, 'game-active');
    assert.equal(topmostHwnds.has(firstOverlayHwnd) && topmostHwnds.has(secondOverlayHwnd), true,
      `${mode}: foreground 게임 위로 TW-Overlay만 승격하지 않습니다.`);
    assert.ok(setWindowCalls.some(call => call.hwnd === firstOverlayHwnd && call.insertAfter === -1n),
      `${mode}: 게임 foreground에서 TW-Overlay를 Topmost 계층에 배치하지 않습니다.`);
    assert.equal(setWindowCalls.some(call => call.hwnd === gameHwnd), false,
      `${mode}: 게임 활성 복구 중 테일즈위버 HWND를 직접 변경합니다.`);

    // A와 B가 게임보다 위인 상태에서 우리 창 하나가 A를 뚫고 올라온 실제 회귀를 재현한다.
    // B의 모니터 위치와 무관하게 A 바로 아래, 게임 바로 위로 우리 묶음만 복원해야 한다.
    foregroundHwnd = externalBHwnd;
    windowAbove.set(gameHwnd, secondOverlayHwnd);
    windowAbove.set(secondOverlayHwnd, hiddenHelperHwnd);
    windowAbove.set(hiddenHelperHwnd, externalAHwnd);
    windowAbove.set(externalAHwnd, firstOverlayHwnd);
    windowAbove.set(firstOverlayHwnd, externalBHwnd);
    windowAbove.set(externalBHwnd, 0n);
    const callsBeforeSameMonitorRepair = setWindowCalls.length;
    assert.equal(zOrder.reconcile(zOrderInput).state, 'external-game-monitor');
    const sameMonitorRepairCalls = setWindowCalls.slice(callsBeforeSameMonitorRepair);
    assert.ok(sameMonitorRepairCalls.some(
      call => call.hwnd === firstOverlayHwnd && call.insertAfter === externalAHwnd,
    ), `${mode}: TW-Overlay를 기존 외부 A 아래와 게임 위 사이에 삽입하지 않습니다.`);
    assert.ok(sameMonitorRepairCalls.some(
      call => call.hwnd === secondOverlayHwnd && call.insertAfter === firstOverlayHwnd,
    ), `${mode}: TW-Overlay 내부 순서를 복원하지 않습니다.`);
    assert.equal(sameMonitorRepairCalls.some(
      call => call.hwnd === gameHwnd || call.hwnd === externalAHwnd || call.hwnd === externalBHwnd,
    ), false, `${mode}: 샌드위치 복구 중 게임 또는 외부 HWND를 직접 변경합니다.`);

    // 복구된 순서를 반영한 뒤 B를 다른 모니터로 이동하거나 C를 선택해도 순서는 바뀌지 않는다.
    windowAbove.set(gameHwnd, secondOverlayHwnd);
    windowAbove.set(secondOverlayHwnd, firstOverlayHwnd);
    windowAbove.set(firstOverlayHwnd, externalAHwnd);
    windowAbove.set(externalAHwnd, externalBHwnd);
    windowAbove.set(externalBHwnd, 0n);
    rects.set(externalBHwnd, { left: 200, top: 0, right: 300, bottom: 100 });
    const callsBeforeOtherMonitor = setWindowCalls.length;
    assert.equal(zOrder.reconcile(zOrderInput).state, 'external-other-monitor');
    assert.equal(setWindowCalls.length, callsBeforeOtherMonitor,
      `${mode}: 외부 B의 모니터 이동만으로 정상 샌드위치 순서를 변경합니다.`);
    assert.equal(topmostHwnds.has(firstOverlayHwnd) || topmostHwnds.has(secondOverlayHwnd), false,
      `${mode}: 다른 모니터 외부 전경에서 TW-Overlay를 Topmost로 승격합니다.`);

    // Topmost Shell은 anchor로 삼지 않고 우리 창을 일반 계층에 유지한다.
    foregroundHwnd = taskbarHwnd;
    topmostHwnds.add(taskbarHwnd);
    topmostHwnds.add(firstOverlayHwnd);
    windowAbove.set(gameHwnd, taskbarHwnd);
    windowAbove.set(taskbarHwnd, firstOverlayHwnd);
    const callsBeforeTaskbarRepair = setWindowCalls.length;
    zOrder.reconcile(zOrderInput);
    const taskbarRepairCalls = setWindowCalls.slice(callsBeforeTaskbarRepair);
    assert.ok(taskbarRepairCalls.some(call => call.hwnd === firstOverlayHwnd && call.insertAfter === -2n),
      `${mode}: Topmost Shell 전경에서 오버레이를 Non-Topmost로 복구하지 않습니다.`);
    assert.ok(taskbarRepairCalls.some(call => call.hwnd === firstOverlayHwnd && call.insertAfter === 0n),
      `${mode}: Topmost Shell HWND를 anchor로 삼아 오버레이에 Topmost를 전염시킵니다.`);

    // 게임 자체가 Topmost인 특수 상태에서만 우리 창을 같은 계층에 둔다.
    foregroundHwnd = gameHwnd;
    topmostHwnds.add(gameHwnd);
    topmostHwnds.delete(firstOverlayHwnd);
    topmostHwnds.delete(secondOverlayHwnd);
    windowAbove.set(gameHwnd, 0n);
    const callsBeforeTopmostGameRepair = setWindowCalls.length;
    zOrder.reconcile(zOrderInput);
    const topmostGameRepairCalls = setWindowCalls.slice(callsBeforeTopmostGameRepair);
    assert.ok(topmostGameRepairCalls.some(call => call.hwnd === firstOverlayHwnd && call.insertAfter === -1n),
      `${mode}: Topmost 게임 위로 TW-Overlay 계층을 맞추지 않습니다.`);
    assert.equal(topmostGameRepairCalls.some(call => call.hwnd === gameHwnd), false,
      `${mode}: Topmost 게임 처리 중 게임 HWND를 직접 변경합니다.`);

    zOrder.release();
    assert.equal(zOrder.getState(), 'inactive');
  }
}

function checkEmbeddedWebWindowContracts(): void {
  const embeddedModule = require(path.join(projectRoot, 'dist', 'modules', 'embeddedWebTool.js')) as {
    calculateEmbeddedWebToolBounds: (
      bounds: { x: number; y: number; width: number; height: number },
      headerHeight: number,
      footerHeight: number,
    ) => { x: number; y: number; width: number; height: number };
  };
  assert.deepEqual(
    embeddedModule.calculateEmbeddedWebToolBounds({ x: 50, y: 80, width: 900, height: 700 }, 56, 28),
    { x: 0, y: 56, width: 900, height: 616 },
    '외부 웹 도구의 헤더·푸터 제외 영역이 변경되었습니다.',
  );

  const manager = read('src/modules/windowManager.ts');
  const embeddedSource = read('src/modules/embeddedWebTool.ts');
  const toolbarSource = read('src/modules/overlayToolbarController.ts');
  assert.match(manager, /uniformColorTool = new EmbeddedWebTool[\s\S]*?followWindowResize: false/,
    '제복 색상 도구의 기존 고정 view 배치 정책이 변경되었습니다.');
  assert.match(manager, /swordEnhanceTool = new EmbeddedWebTool[\s\S]*?followWindowResize: true/,
    '검 강화 도구의 창 리사이즈 연동이 없습니다.');
  assert.match(manager, /https:\/\/twsnowflower\.github\.io\/uniform_color\/spin\.html/);
  assert.match(manager, /https:\/\/twliker\.github\.io\/tw-sword-enhance\//);
  assert.match(embeddedSource, /backgroundThrottling: false/,
    '외부 웹 도구가 비활성 상태에서 제한될 수 있습니다.');
  assert.match(embeddedSource, /if \(options\.followWindowResize\) window\.on\('resize', this\.updateBounds\)/,
    '도구별 리사이즈 정책이 공통 생명주기에 반영되지 않습니다.');
  assert.match(embeddedSource, /insertCSS\(options\.css!, \{ cssOrigin: 'user' \}\)/,
    '제복 색상 외부 페이지 CSS 보정 경로가 없습니다.');

  assert.match(manager, /hideDelayMs: 300/,
    '브라우저 오버레이 툴바 자동 숨김 지연 시간이 변경되었습니다.');
  assert.match(manager, /getCursorScreenPoint\(\)[\s\S]*?cursor\.x >= b\.x[\s\S]*?cursor\.y >= b\.y/,
    '브라우저 오버레이 bounds 변경 시 실제 커서 위치 방어가 없습니다.');
  assert.match(toolbarSource, /mouseInToolbar \|\| this\.mouseInContent/,
    '툴바 또는 콘텐츠 위에 마우스가 있을 때 자동 숨김을 차단하지 않습니다.');
  assert.match(manager, /overlay-wcv-mouse-enter[\s\S]*?enterContent\(\)[\s\S]*?toolbar-mouse-enter[\s\S]*?enterToolbar\(\)/,
    '브라우저와 툴바 IPC가 공통 상태 컨트롤러에 연결되지 않았습니다.');
}

function checkFocusedChatContracts(): void {
  const menuData = JSON.parse(read('src/assets/data/sidebar_menus.json'));
  const focusedMenu = menuData.find((item: { id?: string }) => item.id === 'focused-chat-btn');
  assert.ok(focusedMenu, '집중 대화방 런처 메뉴가 없습니다.');
  assert.equal(focusedMenu.api, 'toggleFocusedChat');

  const processor = read('src/modules/chatLogProcessor.ts');
  assert.match(processor, /sendToAllWindowsByPage\('focused-chat\.html', 'chat-updated', chatItem\)/,
    '새 채팅이 집중 대화방으로 전달되지 않습니다.');
  assert.match(processor, /isSelf: options\.color === CHAT_COLORS\.selfGeneral/,
    '본인 일반 채팅 판별 정보가 채팅 항목에 보존되지 않습니다.');
  assert.match(processor, /config\.save\(\{ focusedChatSelfNickname: normalized \}\)/,
    '집중 대화방의 내 닉네임이 설정에 저장되지 않습니다.');
  assert.match(processor, /clearFocusedChatSession\(\)[\s\S]*?this\._focusedChatTargets = \[\];[\s\S]*?this\._knownNicknames\.clear\(\)/,
    '집중 대화방을 닫을 때 상대 및 자동완성 닉네임이 메모리에서 제거되지 않습니다.');

  const renderer = read('src/focusedChatRenderer.ts');
  assert.match(renderer, /visibleChannels = new Set\(\['general', 'team', 'club', 'whisper'\]\)/,
    '집중 대화방의 대화 채널 필터가 변경되었습니다.');
  assert.match(renderer, /targets\.some\(target => normalizeNickname\(target\) === sender\)/,
    '집중 대화방이 닉네임 정확 일치 방식으로 필터링되지 않습니다.');
  assert.doesNotMatch(renderer, /innerHTML\s*=/,
    '집중 대화방의 사용자 닉네임 또는 메시지가 innerHTML로 렌더링될 수 있습니다.');
  assert.match(renderer, /etaBadge\.textContent = `에타 \$\{item\.level\}`/,
    '집중 대화방 메시지에 에타 배지가 표시되지 않습니다.');
  assert.match(renderer, /requestAnimationFrame[\s\S]*?setFocusedChatSize\(pendingResize\.width, pendingResize\.height\)/,
    '집중 대화방의 드래그 리사이즈 연결이 없습니다.');

  const windowManager = read('src/modules/windowManager.ts');
  const sizingSource = read('src/modules/managedWindowSizing.ts');
  assert.match(sizingSource, /focusedChat: \{ width: 'focusedChatWidth', height: 'focusedChatHeight' \}/,
    '집중 대화방에서 조절한 창 크기가 저장되지 않습니다.');
  assert.match(sizingSource, /key === 'focusedChat' \? 360/,
    '집중 대화방의 최소 너비 제한이 없습니다.');
  assert.match(windowManager, /const sizePatch = createManagedWindowSizePatch\(key, b\.width, b\.height, config\.load\(\)\.managedWindowSizes\);[\s\S]*?config\.save\(sizePatch\)/,
    '일반 창 리사이즈가 변경된 크기 필드만 저장하지 않습니다.');
  assert.match(renderer, /setFocusedChatTargets\(\[\.\.\.targets\]\)/,
    '집중 대화방의 상대 닉네임이 임시 세션 상태로 전달되지 않습니다.');
  assert.doesNotMatch(renderer, /applySettings|onConfigData/,
    '집중 대화방의 임시 상대 또는 자동완성 데이터가 앱 설정과 연결될 수 있습니다.');

  const appConfig = read('src/shared/types.ts');
  const defaults = `${read('src/modules/constants.ts')}\n${read('src/preload.ts')}`;
  assert.doesNotMatch(appConfig, /focusedChat(?:Nicknames|KnownNicknames)/,
    '임시 상대 또는 자동완성 닉네임이 AppConfig에 선언되어 있습니다.');
  assert.doesNotMatch(defaults, /focusedChat(?:Nicknames|KnownNicknames)/,
    '임시 상대 또는 자동완성 닉네임이 기본 설정에 포함되어 있습니다.');

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(ipcHandlers, /focused-chat-get-history[\s\S]*?getChatHistory\('Basic'\)/,
    '집중 대화방의 최근 기록 조회 IPC가 없습니다.');
  assert.doesNotMatch(
    ipcHandlers.match(/ipcMain\.handle\('focused-chat-get-history'[\s\S]*?\n  \}\);/)?.[0] || '',
    /resetLastReadIndex/,
    '집중 대화방을 열 때 기존 채팅 오버레이의 페이지 읽기 상태가 초기화될 수 있습니다.',
  );
}

function checkLifecycleAndIpcSafetyContracts(): void {
  const frameSafeMessaging = read('src/modules/windowMessaging.ts');
  assert.match(frameSafeMessaging, /mainFrame[\s\S]*?frame\.isDestroyed\(\) \|\| frame\.detached/,
    '닫히는 렌더 프레임으로 IPC를 보내는 경쟁 상태 방어가 없습니다.');

  [
    'src/modules/chatLogProcessor.ts',
    'src/modules/xpTracker.ts',
    'src/modules/abandonedTracker.ts',
  ].forEach(file => {
    const source = read(file);
    assert.match(source, /private _started = false;/, `${file}에 시작 상태 가드가 없습니다.`);
    assert.match(
      source,
      /public start\(\): void \{\s*if \(this\._started\)/,
      `${file}의 start()가 중복 실행을 차단하지 않습니다.`,
    );
    assert.match(
      source,
      /this\._started = true;/,
      `${file}이 시작 상태를 기록하지 않습니다.`,
    );
  });

  const preload = read('src/preload.ts');
  assert.doesNotMatch(
    preload,
    /\binvoke:\s*\(channel:\s*string/,
    'preload에 임의 IPC 채널을 호출하는 범용 invoke가 남아 있습니다.',
  );
  assert.match(preload, /getXpStats:\s*\(\): Promise<XpStats>/);
  assert.doesNotMatch(read('src/game-overlay.html'), /electronAPI\.invoke\(/);
  assert.doesNotMatch(read('src/xp-hud.html'), /electronAPI\.invoke\(/);

  const windowMessaging = read('src/modules/windowMessaging.ts');
  assert.match(
    windowMessaging,
    /function safeSend\(window: BrowserWindow,[\s\S]*window\.webContents\.isDestroyed\(\)/,
    '공용 IPC 전송에 폐기된 webContents 차단이 없습니다.',
  );
  assert.match(
    windowMessaging,
    /catch \(error\) \{[\s\S]*error\.message\.includes\('Render frame was disposed'\)/,
    '렌더 프레임 폐기 경쟁 상태의 전송 예외 처리가 없습니다.',
  );
  assert.match(
    windowMessaging,
    /throw error;/,
    '예상하지 못한 IPC 전송 오류를 다시 발생시키지 않습니다.',
  );
  assert.ok(
    (windowMessaging.match(/safeSend\(window, channel, \.\.\.args\)/g) || []).length >= 3,
    '전체 창 IPC 전송 경로가 안전 전송 함수를 사용하지 않습니다.',
  );

  const { resolveSafeChildFile } = require(
    path.join(projectRoot, 'dist/modules/safePath.js'),
  ) as {
    resolveSafeChildFile(parent: string, filename: string): string | null;
  };
  const base = path.join(projectRoot, 'test-sounds');
  assert.equal(resolveSafeChildFile(base, 'custom_safe.wav'), path.join(base, 'custom_safe.wav'));
  assert.equal(resolveSafeChildFile(base, '../outside.wav'), null);
  assert.equal(resolveSafeChildFile(base, '..\\outside.wav'), null);
  assert.equal(resolveSafeChildFile(base, 'nested/file.wav'), null);

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(
    ipcHandlers,
    /resolveSafeChildFile\(customSoundsDir, filename\)/,
    '커스텀 사운드 삭제 경로 검증이 누락되었습니다.',
  );
}

function checkExtractedPureModules(): void {
  const { collectIncompleteContents } = require(
    path.join(projectRoot, 'dist/modules/contentsSummary.js'),
  ) as {
    collectIncompleteContents(config: {
      characterPresets: Array<{ id: string; name: string }>;
      contentsCheckerItems: Array<{
        id: string;
        name: string;
        category: string;
        isVisible: boolean;
        resetRule: { type: 'daily' | 'weekly'; hour: number };
        completedState: Record<string, { isCompleted: boolean; isExcluded?: boolean }>;
      }>;
    }): Array<{ charName: string; name: string }>;
  };

  const result = collectIncompleteContents({
    characterPresets: [
      { id: 'a', name: '가람' },
      { id: 'b', name: '나래' },
    ],
    contentsCheckerItems: [
      {
        id: 'visible',
        name: '표시 숙제',
        category: '테스트',
        isVisible: true,
        resetRule: { type: 'weekly', hour: 0 },
        completedState: {
          a: { isCompleted: false },
          b: { isCompleted: true },
        },
      },
      {
        id: 'excluded',
        name: '제외 숙제',
        category: '테스트',
        isVisible: true,
        resetRule: { type: 'daily', hour: 0 },
        completedState: {
          a: { isCompleted: false, isExcluded: true },
          b: { isCompleted: false, isExcluded: true },
        },
      },
    ],
  });
  assert.deepEqual(result, [{
    charName: '가람',
    name: '표시 숙제',
    category: '테스트',
    type: 'weekly',
  }]);
}

function checkCoreInternalTypesStayStrict(): void {
  [
    'src/preload.ts',
    'src/modules/windowManager.ts',
    'src/modules/contentsChecker.ts',
    'src/modules/chatLogProcessor.ts',
    'src/chatOverlayRenderer.ts',
    'src/shared/types.ts',
  ].forEach(file => {
    assert.doesNotMatch(
      read(file),
      /\bany\b/,
      `${file}의 핵심 내부 데이터에 any가 다시 추가되었습니다.`,
    );
  });
}

function checkLegacyContentsOrderingRemoved(): void {
  const sources = [
    'src/modules/contentsChecker.ts',
    'src/modules/ipcHandlers.ts',
    'src/preload.ts',
    'src/shared/types.ts',
  ].map(read).join('\n');

  [
    'sortOrder',
    'contentsReorderList',
    'contents-reorder-list',
    'reorderList',
  ].forEach(legacyName => {
    assert.equal(
      sources.includes(legacyName),
      false,
      `숙제 수동 정렬 레거시 코드가 남아 있습니다: ${legacyName}`,
    );
  });
}

function checkSharedUiDependencies() {
  const pagesUsingSharedUi = [];
  const sharedCallPattern = /window\.(?:bindEscapeClose|bindElectronListenerCleanup|bindChatLogStatusWarning|highlightElement|formatElapsedTime|formatLocaleNumber|formatSeedAmount|escapeHtml(?:Text|Attribute)?)\s*\(/;

  for (const file of fs.readdirSync(sourceRoot).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
    if (!sharedCallPattern.test(html)) continue;
    pagesUsingSharedUi.push(file);
    const dependencyIndex = html.indexOf('assets/ui-utils.js');
    const firstCallIndex = html.search(sharedCallPattern);
    assert.notEqual(dependencyIndex, -1, `${file}에 ui-utils.js 참조가 없습니다.`);
    assert.ok(dependencyIndex < firstCallIndex, `${file}에서 ui-utils.js보다 공통 함수가 먼저 실행됩니다.`);
  }

  assert.ok(pagesUsingSharedUi.length > 0);
}

function readPageWithRendererSources(htmlFile: string): string {
  const html = read(`src/${htmlFile}`);
  const sources = [html];
  for (const match of html.matchAll(/<script\s+src=["']([^"']+\.js)["']/g)) {
    const scriptPath = match[1];
    if (scriptPath.startsWith('assets/') || scriptPath.startsWith('shared/')) continue;
    const sourcePath = path.join(sourceRoot, scriptPath.replace(/\.js$/, '.ts'));
    if (fs.existsSync(sourcePath)) sources.push(fs.readFileSync(sourcePath, 'utf8'));
  }
  return sources.join('\n');
}

function checkEscapeCloseContracts(): void {
  const escapeHandlerPattern = /bindEscapeClose(?:\?\.)?\s*\(|\.key\s*[!=]==?\s*['"]Escape['"]/;
  const managedDefinitions = Array.from(
    read('src/modules/managedWindowRegistry.ts').matchAll(/\{ key: '([^']+)', html: '([^']+)'/g),
    match => ({ key: match[1], html: match[2] }),
  );
  const escapeCloseExclusions = new Set(['gameOverlay', 'chatOverlay', 'chatOverlaySub', 'chatOverlaySub2', 'dock']);

  for (const definition of managedDefinitions) {
    if (escapeCloseExclusions.has(definition.key)) continue;
    assert.match(
      readPageWithRendererSources(definition.html),
      escapeHandlerPattern,
      `${definition.key} 창에 Escape 닫기 처리가 없습니다.`,
    );
  }

  for (const htmlFile of ['welcome-guide.html', 'update-notice.html', 'game-exit-reminder.html']) {
    assert.match(readPageWithRendererSources(htmlFile), escapeHandlerPattern, `${htmlFile}에 Escape 닫기 처리가 없습니다.`);
  }

  const uiUtils = read('src/assets/ui-utils.ts');
  assert.match(uiUtils, /const closeWindow = window\.close\.bind\(window\)[\s\S]*?queueMicrotask[\s\S]*?!e\.defaultPrevented[\s\S]*?closeWindow\(\)/,
    '화면 내부 Escape 처리가 끝나기 전에 공통 창 닫기가 실행될 수 있습니다.');
  assert.match(read('src/chatOverlayRenderer.ts'), /e\.key === 'Escape' && isSearchMode/,
    '채팅 오버레이 Escape가 검색 화면 이외의 창 닫기로 확장되었습니다.');
  assert.doesNotMatch(read('src/dock.html'), /bindEscapeClose\s*\(|\.key\s*[!=]==?\s*['"]Escape['"]/,
    '독이 Escape로 닫히도록 다시 연결되었습니다.');
  assert.doesNotMatch(read('src/overlay.html'), /\.key\s*[!=]==?\s*['"]Escape['"]/,
    '웹 브라우저 오버레이 툴바가 Escape로 닫히도록 다시 연결되었습니다.');
  assert.doesNotMatch(read('src/modules/windowManager.ts'), /view\.webContents\.ipc\.on\('embedded-view-escape'/,
    '웹 브라우저 오버레이 콘텐츠가 Escape로 닫히도록 다시 연결되었습니다.');
  assert.match(read('src/modules/embeddedWebTool.ts'), /embedded-view-escape[\s\S]*?window\.close\(\)/,
    '외부 웹 콘텐츠에 포커스가 있을 때 도구 창을 닫는 Escape 경로가 없습니다.');
}

function loadBrowserConstantModule(relativePath: string, exposedProperty: string): any {
  const window: Record<string, any> = {};
  vm.runInNewContext(read(relativePath), { window }, { filename: relativePath });
  return window[exposedProperty];
}

function checkSharedConstants() {
  const chatConstants = loadBrowserConstantModule(
    'dist/shared/chatConstants.js',
    'chatConstants',
  );
  assert.deepEqual(
    Array.from(chatConstants.NPC_SENDER_BLACKLIST),
    [
      '데스포이나', '신조', '키시니크', '에레오스', '로카고스',
      '마티아', '티로로스', '라이코스', '체리아', '실반',
      '샐리온', '실라이론', '샐레아나', '루미너스', '크라모르',
    ],
  );
  assert.equal(chatConstants.isNpcSender('크라모르'), true);
  assert.equal(chatConstants.isLegacyNpcSender('크라모르'), false);
  assert.equal(chatConstants.isNpcSender('일반유저'), false);

  const chatParser = read('src/modules/chatParser.ts');
  const chatLogManager = read('src/modules/chatLogManager.ts');
  const chatOverlayRenderer = read('src/chatOverlayRenderer.ts');
  assert.match(chatParser, /require\('\.\.\/shared\/chatConstants'\)/);
  assert.match(chatLogManager, /require\('\.\.\/shared\/chatConstants'\)/);
  assert.doesNotMatch(
    chatOverlayRenderer,
    /\bconst\s*\{\s*NPC_SENDER_BLACKLIST\s*\}/,
    '채팅 오버레이가 공통 NPC 상수를 같은 이름으로 다시 선언합니다.',
  );
  assert.match(chatOverlayRenderer, /window\.chatConstants\.isNpcSender\(/);

  const buffConstants = loadBrowserConstantModule(
    'dist/shared/buffConstants.js',
    'buffConstants',
  );
  assert.equal(buffConstants.STANDARD_BUFFS.length, 9);
  assert.equal(buffConstants.STANDARD_BUFFS[0], 'util_snowman');
  assert.equal(buffConstants.STANDARD_BUFFS[8], 'util_haste');

  const sidebarCategories: any[] = loadBrowserConstantModule(
    'dist/shared/sidebarCategories.js',
    'sidebarCategories',
  );
  assert.deepEqual(
    Array.from(sidebarCategories, category => category.id),
    ['records', 'monitoring', 'alarms', 'calculators', 'information', 'homework', 'minigame'],
  );
  assert.deepEqual(
    Array.from([...sidebarCategories].sort((a, b) => a.trayOrder - b.trayOrder), category => category.id),
    ['records', 'monitoring', 'alarms', 'calculators', 'information', 'homework', 'minigame'],
  );
  assert.deepEqual(
    Array.from(sidebarCategories.slice(0, 5), category => ({
      label: category.label,
      icon: category.icon,
      color: category.color,
    })),
    [
      { label: '플레이 관리 & 기록', icon: 'clipboard-check', color: 'emerald-400' },
      { label: '커뮤니티 & 채팅', icon: 'messages-square', color: 'sky-400' },
      { label: '알림 설정', icon: 'bell-ring', color: 'pink-400' },
      { label: '계산기 & 시뮬레이터', icon: 'calculator', color: 'indigo-400' },
      { label: '정보 & 도감', icon: 'book-open', color: 'blue-400' },
    ],
  );
  assert.equal(sidebarCategories.find(category => category.id === 'homework')?.settingsLabel, '숙제 관리');

  const cloudSyncPresentation = loadBrowserConstantModule(
    'dist/shared/cloudSyncPresentation.js',
    'cloudSyncPresentation',
  ) as {
    get(status: unknown, kind?: 'settings' | 'checklist'): {
      visible: boolean;
      state: string;
      icon: string | null;
      label: string;
    };
  };
  assert.equal(cloudSyncPresentation.get({ isLinked: false }).visible, false,
    'Google 계정 미연결 상태에서 동기화 아이콘이 노출됩니다.');
  const reauthPresentation = cloudSyncPresentation.get({
    isLinked: false,
    reauthRequired: true,
  });
  assert.equal(reauthPresentation.visible, true,
    '인증 만료 상태가 일반 미연결처럼 숨겨집니다.');
  assert.equal(reauthPresentation.state, 'error');
  assert.match(reauthPresentation.label, /다시 로그인/);
  assert.deepEqual(
    ['checking', 'upload', 'download'].map(syncActivity => cloudSyncPresentation.get({
      isLinked: true,
      isSyncing: true,
      syncActivity,
    }).state),
    ['checking', 'uploading', 'downloading'],
    '클라우드 진행 상태가 사용자용 확인/업로드/다운로드 상태로 변환되지 않습니다.',
  );
  assert.equal(cloudSyncPresentation.get({
    isLinked: true,
    fileStatuses: [{ kind: 'settings', retryCount: 1, lastError: 'settings failed' }],
  }, 'checklist').state, 'normal', '설정 파일 오류가 숙제 전용 상태를 오류로 오염시킵니다.');
  assert.equal(cloudSyncPresentation.get({
    isLinked: true,
    fileStatuses: [{ kind: 'checklist', retryCount: 1, lastError: 'checklist failed' }],
  }, 'checklist').state, 'error', '숙제 파일 오류가 숙제 전용 상태에 표시되지 않습니다.');
  assert.equal(cloudSyncPresentation.get({ isLinked: true, pullRetryCount: 1 }).state, 'error',
    '클라우드 수신 오류가 상태 아이콘에 표시되지 않습니다.');

  const sidebarSource = read('src/index.html');
  const dockSource = read('src/dock.html');
  const checklistSource = read('src/contents-checker.html');
  for (const [name, source] of [
    ['사이드바', sidebarSource],
    ['독', dockSource],
    ['숙제 체크리스트', checklistSource],
  ] as const) {
    assert.match(source, /shared\/cloudSyncPresentation\.js/,
      `${name}가 공통 동기화 상태 정책을 사용하지 않습니다.`);
    assert.match(source, /data:google-sync/,
      `${name} 동기화 아이콘이 Google Drive 설정 화면으로 연결되지 않았습니다.`);
  }

  const cloudSyncManagerSource = read('src/modules/cloudSyncManager.ts');
  assert.match(cloudSyncManagerSource,
    /uploadFailureCount\[kind\]\+\+;[\s\S]*?uploadLastError\[kind\][\s\S]*?broadcastStatus\(\)/,
    '자동 업로드 실패 상태가 창들에 즉시 전달되지 않습니다.');
  assert.match(cloudSyncManagerSource,
    /if \(!manual\) \{\s*pullFailureCount\+\+;\s*broadcastStatus\(\)/,
    '자동 수신 예외 상태가 창들에 즉시 전달되지 않습니다.');

  const chatChannels = loadBrowserConstantModule(
    'dist/shared/chatChannels.js',
    'chatChannels',
  );
  assert.deepEqual(
    Array.from(chatChannels.OVERLAY_CHANNELS),
    ['general', 'whisper', 'team', 'club', 'shout', 'system'],
  );
  assert.deepEqual(
    { ...chatChannels.COLORS },
    {
      general: '#ffffff', selfGeneral: '#c8ffc8', whisper: '#64ff64',
      team: '#f7b73c', club: '#94ddfa', shout: '#c896c8',
      system: '#a8a8a8', nickname: '#94a3b8',
    },
  );
  assert.equal(chatChannels.formatTimestamp('오전 12시 03분 22초'), '00:03');
  assert.equal(chatChannels.formatTimestamp('오후 1시 09분 11초'), '13:09');
  assert.equal(chatChannels.formatTimestamp('12시 30분 00초'), '00:30');

  const focusedChatRenderer = read('src/focusedChatRenderer.ts');
  const wordAlarmPage = read('src/word-alarm.html');
  const scamParser = read('src/modules/scam/parser.ts');
  assert.match(focusedChatRenderer, /window\.chatChannels\.COLORS\.selfGeneral/);
  assert.doesNotMatch(focusedChatRenderer, /=== '#c8ffc8'/,
    '집중 대화방에 본인 채팅 색상이 다시 중복 선언되었습니다.');
  assert.match(scamParser, /require\('\.\.\/\.\.\/shared\/chatChannels'\)/);
  assert.match(scamParser, /color === CHAT_COLORS\.selfGeneral/);
  assert.ok(
    wordAlarmPage.indexOf('shared/chatChannels.js') < wordAlarmPage.indexOf('<script>'),
    '단어 알림이 채팅 채널 공통 모듈보다 먼저 실행됩니다.',
  );
  assert.match(wordAlarmPage, /window\.chatChannels\.COLORS\.club/);

  const chatOverlay = read('src/chat-overlay.html');
  assert.ok(
    chatOverlay.indexOf('shared/chatConstants.js')
      < chatOverlay.indexOf('chatOverlayRenderer.js'),
    'chat-overlay 상수 모듈이 렌더러보다 늦게 로드됩니다.',
  );
  assert.ok(
    chatOverlay.indexOf('shared/chatChannels.js') < chatOverlay.indexOf('chatOverlayRenderer.js'),
    '채팅 채널 공통 모듈이 채팅 오버레이 렌더러보다 늦게 로드됩니다.',
  );
  const settingsPage = read('src/settings.html');
  assert.ok(
    settingsPage.indexOf('shared/sidebarCategories.js') < settingsPage.indexOf('renderer/settings/menu-management.js'),
    '사이드바 카테고리 공통 모듈이 설정 메뉴 관리 모듈보다 늦게 로드됩니다.',
  );
  assert.ok(
    settingsPage.indexOf('shared/chatChannels.js') < settingsPage.indexOf('renderer/settings/form-collection.js'),
    '채팅 채널 공통 모듈이 설정 렌더러 모듈보다 늦게 로드됩니다.',
  );
  assert.doesNotMatch(read('src/renderer/settings/menu-management.ts'), /MENU_CATEGORIES/);
  assert.doesNotMatch(read('src/renderer/settings/shortcuts.ts'), /CommandOrControl\+Shift/,
    '설정 단축키 모듈에 기본 단축키가 다시 중복 선언되었습니다.');
  assert.doesNotMatch(read('src/renderer/settings/audio-controls.ts'), /(?:ethos|orb|default)-alert\.mp3/,
    '설정 오디오 모듈에 기본 알림음이 다시 중복 선언되었습니다.');
  const coefficientCalculator = read('src/coefficient-calculator.html');
  assert.ok(
    coefficientCalculator.indexOf('shared/buffConstants.js')
      < coefficientCalculator.indexOf('coefficient-calculator-renderer.js'),
    '버프 상수 모듈이 계수 계산기 렌더러보다 늦게 로드됩니다.',
  );
}

function checkPreloadDefaultConfigCompatibility() {
  const preloadSource = read('src/preload.ts');
  assert.match(
    preloadSource,
    /const MAIN_DEFAULT_CONFIG = ipcRenderer\.sendSync\('get-default-config-sync'\)/,
    'preload이 메인 프로세스의 단일 기본 설정 원본을 조회하지 않습니다.',
  );
  assert.match(
    preloadSource,
    /const DEFAULT_CONFIG: AppConfig = MAIN_DEFAULT_CONFIG;/,
    'preload이 메인 프로세스에서 받은 기본 설정 대신 별도 객체를 사용합니다.',
  );
  assert.doesNotMatch(
    preloadSource,
    /const DEFAULT_CONFIG: AppConfig = \{|CommandOrControl\+Shift|ethosAlertSound:/,
    'preload에 기본 설정 값이 다시 중복 선언되었습니다.',
  );
  const mainDefaultConfig = {
    width: 800,
    customSounds: [],
    showSidebarToastOnOverlay: false,
    shortcuts: { toggleClickThrough: 'CommandOrControl+Shift+T', toggleTimer: 'CommandOrControl+Shift+S' },
  };

  const runtimeImports = Array.from(
    preloadSource.matchAll(/^import(?!\s+type\b)[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm),
    match => match[1],
  );
  assert.deepEqual(
    runtimeImports,
    ['electron'],
    'sandbox preload에 로컬 런타임 import가 추가되었습니다.',
  );

  const builtPreloadPath = path.join(projectRoot, 'dist/preload.js');
  if (fs.existsSync(builtPreloadPath)) {
    const builtPreload = fs.readFileSync(builtPreloadPath, 'utf8');
    assert.doesNotMatch(
      builtPreload,
      /require\(["']\.{1,2}\//,
      '빌드된 sandbox preload에 상대경로 require가 포함되었습니다.',
    );

    const exposedGlobals: Record<string, any> = {};
    const sentIpc: Array<{ channel: string; args: unknown[] }> = [];
    const ipcRenderer = {
      send(channel: string, ...args: unknown[]) {
        sentIpc.push({ channel, args });
      },
      sendSync(channel: string) {
        assert.equal(channel, 'get-default-config-sync');
        return mainDefaultConfig;
      },
      invoke() {},
      removeAllListeners() {},
      on() {},
    };
    vm.runInNewContext(builtPreload, {
      exports: {},
      module: { exports: {} },
      require(moduleName: string) {
        assert.equal(moduleName, 'electron', `sandbox preload가 허용되지 않은 모듈을 요청했습니다: ${moduleName}`);
        return {
          contextBridge: {
            exposeInMainWorld(name: string, api: unknown) {
              exposedGlobals[name] = api;
            },
          },
          ipcRenderer,
        };
      },
    }, { filename: 'dist/preload.js' });
    const exposedApi = exposedGlobals.electronAPI;
    assert.ok(exposedApi);
    assert.equal(exposedApi.DEFAULT_CONFIG, mainDefaultConfig);
    assert.equal(exposedApi.DEFAULT_CONFIG.shortcuts.toggleTimer, 'CommandOrControl+Shift+S');
    assert.equal(typeof exposedApi.onPlaySound, 'function');
    assert.equal(typeof exposedApi.onSpecialMonsterAlert, 'function');
    assert.equal(typeof exposedApi.onAbyssTreasureCompleteAlert, 'function');
    const evolutionSelection = { category: 'weapon', part: '', itemName: '인퍼널 대거' };
    exposedApi.sendEquipmentToEvolution(evolutionSelection);
    assert.deepEqual(sentIpc.at(-1), {
      channel: 'send-to-evolution',
      args: [evolutionSelection],
    }, 'preload이 장비 사전의 진화 계산기 선택 정보를 IPC로 전달하지 않습니다.');
  }

  const directListenerCount = (preloadSource.match(/ipcRenderer\.on\(/g) || []).length;
  assert.equal(directListenerCount, 1, 'IPC 이벤트 구독이 공통 바인더 밖에 남아 있습니다.');

  const ipcHandlersSource = read('src/modules/ipcHandlers.ts');
  assert.match(
    ipcHandlersSource,
    /ipcMain\.on\('send-to-evolution',[\s\S]*?isValidEvolutionCalculatorSelection\(item\)[\s\S]*?wm\.sendEquipmentToEvolution\(item\)/,
    '진화 계산기 선택 정보가 공용 장비 검증기에 막히거나 창 관리자에 전달되지 않습니다.',
  );

  const listenerChannels = Array.from(
    preloadSource.matchAll(/bindIpcListener(?:<[^>]*>)?\(\s*'([^']+)'/g),
    match => match[1],
  );
  assert.deepEqual(listenerChannels, [
    'trigger-jellyppy-rain', 'trigger-firework', 'sidebar-status', 'overlay-status',
    'chat-overlay-status', 'click-through-status', 'active-windows', 'managed-window-resize-enabled', 'config-data',
    'chat-log-sync-progress', 'today-summary-config',
    'url-change', 'load-status', 'gallery-posts', 'gallery-new-activity',
    'gallery-watched-update', 'gallery-connection-status', 'update-status',
    'boss-times-data', 'play-sound', 'trade-posts', 'trade-new-activity',
    'trade-connection-status', 'open-settings-tab', 'highlight-alarm-settings',
    'toolbar-hover', 'reminder-message', 'incomplete-contents', 'diary-updated',
    'xp-update', 'shout-history-updated', 'buff-timer-update', 'buff-timer-warning', 'buff-hud-toggle-feedback',
    'xp-reset-done', 'essence-alert', 'pitta-alert', 'special-monster-alert', 'abyss-treasure-complete-alert',
    'ethos-alert', 'abyss-apostle-alert', 'wave-warning-alert', 'lokagos-alert',
    'quest-started', 'quest-update', 'quest-complete', 'quest-cancelled',
    'scam-alert', 'scam-analysis-result', 'scam-progress', 'scam-session-update',
    'scam-analysis-token', 'auto-select-equipment', 'auto-select-evolution',
    'abandoned-update', 'abandoned-alert', 'abandoned-hide-now', 'digsite-update', 'chat-updated',
    'chat-history-cleared', 'chat-overlay-mode', 'chat-log-status-changed',
    'alarm-logs-updated', 'timer-toggle', 'timer-updated',
    'game-overlay-edit-mode', 'game-overlay-reset-positions',
    'google-sync-status-changed',
  ]);
}

function checkRequestedFeatureContracts() {
  const contents: any[] = JSON.parse(read('src/assets/data/contents.json'));
  const eternalFloor = contents.find(item => item.id === 'weekly-eternal-floor');
  assert.ok(eternalFloor, '이터널 플로어 숙제가 없습니다.');
  assert.equal(eternalFloor.category, '재화');
  assert.equal(eternalFloor.maxCount, 10);
  assert.equal(eternalFloor.resetRule.type, 'weekly');
  [
    ['weekly-orly-defense', 7],
    ['weekly-shinjo-nest', 7],
    ['weekly-vestige', 7],
  ].forEach(([id, maxCount]) => {
    const item = contents.find(candidate => candidate.id === id);
    assert.ok(item, `${id} 숙제가 없습니다.`);
    assert.equal(item.maxCount, maxCount, `${id}의 주간 횟수가 변경되었습니다.`);
  });

  const parser = read('src/modules/chatParser.ts');
  [
    'SPECIAL_MONSTER_SPAWN',
    'ETERNAL_FLOOR_CLEAR',
    'ORLY_DEFENSE_CLEAR',
    'CONTENT_SHINJO_NEST_CLEAR',
    'VESTIGE_CLEAR',
    'ABYSS_TREASURE_COMPLETE',
    '성난\\s*빅테디의\\s*별사탕',
    '이번\\s*주\\s*신조\\s*보상을',
    '남은\\s*공격\\s*횟수',
  ].forEach(contract => assert.ok(parser.includes(contract), `채팅 파서 계약 누락: ${contract}`));

  const processor = read('src/modules/chatLogProcessor.ts');
  assert.match(processor, /queueFixedHomework\('ETERNAL_FLOOR_CLEAR', 'weekly-eternal-floor'\)/);
  assert.match(
    processor,
    /queueCountHomework\('CONTENT_SHINJO_NEST_CLEAR', 'weekly-shinjo-nest'\)/,
  );
  [
    "['ORLY_DEFENSE_CLEAR', 'weekly-orly-defense']",
    "['VESTIGE_CLEAR', 'weekly-vestige']",
  ].forEach(mapping => {
    assert.ok(processor.includes(mapping), `숙제 카운팅 매핑 누락: ${mapping}`);
  });
  assert.match(processor, /sendGameOverlayEvent\('special-monster-alert', data\)/);
  assert.match(processor, /ABYSS_TREASURE_COMPLETE[\s\S]*?sendGameOverlayEvent\('abyss-treasure-complete-alert', data\)/);
  const abyssTreasureKeyBlock = processor.match(
    /ABYSS_TREASURE_CONFIG_KEYS = \[([\s\S]*?)\] as const/,
  )?.[1] || '';
  for (const key of ['abyssTreasureAlertEnabled', 'abyssTreasureAlertSound', 'abyssTreasureAlertVolume']) {
    assert.ok(abyssTreasureKeyBlock.includes(`'${key}'`),
      `심연의 보물창고 완료 알림 전용 설정 키 누락: ${key}`);
  }
  for (const sharedKey of ['questCompleteAlertEnabled', 'essenceAlertSound', 'essenceAlertVolume']) {
    assert.equal(abyssTreasureKeyBlock.includes(sharedKey), false,
      `심연의 보물창고 완료 알림이 다른 콘텐츠의 설정을 공유합니다: ${sharedKey}`);
  }
  assert.doesNotMatch(processor, /queue(?:Count|Fixed)Homework\('ABYSS_TREASURE_COMPLETE'/,
    '심연의 보물창고 완료 알림이 기존 숙제 횟수를 중복 반영합니다.');

  const xpTracker = read('src/modules/xpTracker.ts');
  assert.match(xpTracker,
    /questCompleteAlertEnabled[\s\S]*?questCompleteAlertSound[\s\S]*?questCompleteAlertVolume/,
    '도전과제 완료 알림이 전용 사운드와 음량을 사용하지 않습니다.');

  const configSource = read('src/modules/config.ts');
  for (const key of [
    'questCompleteAlertSound',
    'questCompleteAlertVolume',
    'abyssTreasureAlertEnabled',
    'abyssTreasureAlertSound',
    'abyssTreasureAlertVolume',
  ]) {
    assert.match(configSource, new RegExp(`!hasOwn\\('${key}'\\)`),
      `기존 사용자 설정 승계 마이그레이션 누락: ${key}`);
  }

  const syncDataHelper = read('src/modules/syncDataHelper.ts');
  for (const key of [
    'questCompleteAlertSound',
    'questCompleteAlertVolume',
    'abyssTreasureAlertEnabled',
    'abyssTreasureAlertSound',
    'abyssTreasureAlertVolume',
  ]) {
    assert.ok(syncDataHelper.includes(`'${key}'`), `클라우드 설정 동기화 키 누락: ${key}`);
  }

  const gameOverlay = read('src/game-overlay.html');
  assert.match(gameOverlay, /onSpecialMonsterAlert/);
  assert.match(gameOverlay, /onAbyssTreasureCompleteAlert[\s\S]*?showContentComplete/);
  assert.match(read('src/renderer/game-overlay/devtools.ts'), /testSpecialMonsterAlert/);

  const settingsHtml = read('src/settings.html');
  for (const tab of ['Basic', 'General', 'Whisper', 'Team', 'Club', 'Shout', 'System']) {
    assert.ok(settingsHtml.includes(`chat-overlay-visible-tab-${tab}`),
      `채팅 오버레이 기본 탭 표시 설정 누락: ${tab}`);
  }
  assert.match(read('src/renderer/settings/form-collection.ts'), /chatOverlayVisibleTabs:[\s\S]*?visibleTabs/,
    '채팅 오버레이 기본 탭 표시 설정을 저장하지 않습니다.');
  assert.match(read('src/renderer/settings/config-binding.ts'), /chatOverlayVisibleTabs[\s\S]*?chat-overlay-visible-tab-/,
    '저장된 채팅 오버레이 기본 탭 설정을 화면에 복원하지 않습니다.');
  const chatOverlayRenderer = read('src/chatOverlayRenderer.ts');
  assert.match(chatOverlayRenderer, /resolveAvailableTab[\s\S]*?renderBuiltInTabs/,
    '숨긴 채팅 탭의 표시 및 안전한 대체 탭 선택 계약이 없습니다.');
  assert.match(read('src/chat-overlay.html'), /body\.click-through[\s\S]*?scrollbar/,
    '마우스 투과 중 조작할 수 없는 채팅 스크롤바를 숨기지 않습니다.');

  const healthGuard = read('src/modules/rendererHealthGuard.ts');
  assert.match(healthGuard, /did-fail-load[\s\S]*?render-process-gone[\s\S]*?unresponsive/,
    'renderer 표시 실패 감지 계약이 불완전합니다.');
  assert.match(healthGuard, /setIgnoreMouseEvents\(true,[\s\S]*?window\.hide\(\)/,
    '보이지 않는 실패 창이 게임 입력을 막지 않도록 해제하지 않습니다.');
  assert.match(read('src/main.ts'), /browser-window-created[\s\S]*?attachRendererHealthGuard/,
    '모든 창에 renderer 표시 실패 안전장치를 연결하지 않습니다.');
  assert.match(read('src/modules/windowManager.ts'), /isMainWindowRendererReady[\s\S]*?ready-to-show[\s\S]*?isMainWindowRendererReady = true/,
    '사이드바 renderer 준비 전에 투명 창을 표시할 수 있습니다.');

  const uiUtils = read('src/assets/ui-utils.ts');
  assert.match(uiUtils, /installManagedWindowResizeHandle[\s\S]*?setWindowSize/,
    '투명·무테 일반 창의 크기 조절 손잡이가 없습니다.');
  assert.match(read('src/modules/windowManager.ts'), /managed-window-resize-enabled/,
    '크기 조절 가능한 일반 창에 손잡이 활성화 이벤트를 보내지 않습니다.');

  const shortcutManager = read('src/modules/shortcutManager.ts');
  assert.match(shortcutManager, /Toggle Buff HUD[\s\S]*?buff-hud-toggle-feedback/,
    '버프 HUD 단축키 실행 결과를 사용자에게 표시하지 않습니다.');
  assert.match(gameOverlay, /createHudStatusToast[\s\S]*?onBuffHudToggleFeedback/,
    '게임 오버레이가 버프 HUD 단축키 결과를 표시하지 않습니다.');
}

function checkRequestedChatSamples(): void {
  const { chatParser } = require(path.join(projectRoot, 'dist/modules/chatParser.js')) as {
    chatParser: {
      on(event: string, listener: (data: { count?: number }) => void): void;
      once(event: string, listener: (data: { count?: number }) => void): void;
      removeListener(event: string, listener: (data: { count?: number }) => void): void;
      parseLine(line: string): void;
    };
  };
  const samples: Array<[event: string, line: string, expectedCount?: number]> = [
    [
      'SPECIAL_MONSTER_SPAWN',
      '<font size="2" color="white"> [17시 11분  8초] </font><font>맵 어딘가에 특별 몬스터가 출현하였습니다.</font></br>',
    ],
    [
      'ABYSS_TREASURE_COMPLETE',
      '<font size="2" color="white"> [ 0시 38분 23초] </font> <font size="2" color="#ff64ff">3분 후 심연의 보물창고 밖으로 자동 이동합니다.</font></br>',
    ],
    [
      'ETERNAL_FLOOR_CLEAR',
      '<font size="2" color="white"> [17시 11분  8초] </font><font>[이터널 플로어 보상 상자] 아이템을 획득하였습니다.</font></br>',
    ],
    [
      'ORLY_DEFENSE_CLEAR',
      '<font size="2" color="white"> [21시 33분 22초] </font><font>남은 공격 횟수 : 1</font></br>',
    ],
    [
      'VESTIGE_CLEAR',
      '<font size="2" color="white"> [21시 42분 59초] </font><font>[성난 빅테디의 별사탕] 아이템을 획득하였습니다.</font></br>',
    ],
    [
      'CONTENT_SHINJO_NEST_CLEAR',
      '<font size="2" color="white"> [12시 18분 38초] </font><font>이번 주 신조 보상을 5회 획득 하셨습니다. 한 주에 7회까지 획득 할 수 있습니다.</font></br>',
      5,
    ],
    [
      'MAGIC_STONE_GAIN',
      '<font size="2" color="white"> [22시 39분 34초] </font> <font size="2" color="#ff64ff">하급 마정석 1개를 획득 하였습니다.</font></br>',
      1,
    ],
    [
      'MAGIC_STONE_GAIN',
      '<font size="2" color="white"> [22시 40분 10초] </font><font>펫이 [중급 마정석]을(를) 주웠습니다.</font></br>',
      1,
    ],
    [
      'MAGIC_STONE_GAIN',
      '<font size="2" color="white"> [22시 40분 15초] </font><font>[상급 마정석] 2개를 획득하였습니다.</font></br>',
      2,
    ],
    [
      'MAGIC_STONE_LOSS',
      '<font size="2" color="white"> [22시 41분 00초] </font><font>누에게 [하급 마정석] 20개를 빼앗겼습니다.</font></br>',
      20,
    ],
    [
      'ABANDONED_ENTRY',
      '<font size="2" color="white"> [22시 38분 01초] </font><font>이번 주 어벤던로드 카디프 지역의 도전 횟수는 5번 입니다.</font></br>',
      5,
    ],
  ];

  for (const [event, line, expectedCount] of samples) {
    let emittedCount = 0;
    let parsedCount: number | undefined;
    chatParser.once(event, data => {
      emittedCount++;
      parsedCount = data.count;
    });
    chatParser.parseLine(line);
    assert.equal(emittedCount, 1, `${event} 이벤트가 정확히 한 번 발생하지 않았습니다.`);
    if (expectedCount !== undefined) {
      assert.equal(parsedCount, expectedCount, `${event} 횟수 파싱에 실패했습니다.`);
    }
  }

  // 타인 마정석 획득 공지 메시지는 MAGIC_STONE_GAIN을 발생시키지 않아야 함
  let otherStoneGained = false;
  const stoneListener = () => { otherStoneGained = true; };
  chatParser.on('MAGIC_STONE_GAIN', stoneListener);
  chatParser.parseLine('<font size="2" color="white"> [19시 38분 42초] </font> <font size="2" color="#ff64ff">누군가 어밴던로드에서 주문을 통해 하급 마정석 1000개를 획득 하였습니다.</font></br>');
  chatParser.removeListener('MAGIC_STONE_GAIN', stoneListener);
  assert.equal(otherStoneGained, false, '타인의 마정석 획득 공지 메시지가 MAGIC_STONE_GAIN 이벤트를 발생시켰습니다.');
}

function checkNoAuthoredJavaScriptSources(): void {
  const authoredJavaScriptFiles: string[] = [];

  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
        authoredJavaScriptFiles.push(path.relative(projectRoot, absolutePath));
      }
    }
  }

  walk(path.join(projectRoot, 'src'));
  walk(path.join(projectRoot, 'scripts'));
  assert.deepEqual(
    authoredJavaScriptFiles,
    [],
    `직접 작성한 JavaScript 원본이 남아 있습니다: ${authoredJavaScriptFiles.join(', ')}`,
  );
}

function checkAgentDocumentationLocations(): void {
  [
    '.agents/AGENTS.md',
    '.agents/PROJECT_GUIDE.md',
    '.agents/DESIGN_TOKENS.md',
    '.agents/release_workflow.md',
  ].forEach(file => {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), true, `${file} 파일이 없습니다.`);
  });
  [
    '.gemini/DESIGN_TOKENS.md',
    '.gemini/release_workflow.md',
  ].forEach(file => {
    assert.equal(
      fs.existsSync(path.join(projectRoot, file)),
      false,
      `사용 중단된 Gemini 문서 경로가 다시 추가되었습니다: ${file}`,
    );
  });

  const agentRules = read('.agents/AGENTS.md');
  assert.match(agentRules, /\[PROJECT_GUIDE\.md\]\(\.\/PROJECT_GUIDE\.md\)/);
  assert.match(agentRules, /\[DESIGN_TOKENS\.md\]\(\.\/DESIGN_TOKENS\.md\)/);
  assert.match(agentRules, /\[release_workflow\.md\]\(\.\/release_workflow\.md\)/);

  const projectGuide = read('.agents/PROJECT_GUIDE.md');
  [
    'src/main.ts',
    'src/modules',
    'src/shared',
    'src/renderer',
    'ChatLogManager',
    'ChatParser',
    'ChatLogProcessor',
    'npm run typecheck',
    'npm test',
  ].forEach(requiredText => assert.ok(
    projectGuide.includes(requiredText),
    `프로젝트 가이드에 필수 설명이 없습니다: ${requiredText}`,
  ));

  const releaseWorkflow = read('.agents/release_workflow.md');
  ['npm run typecheck', 'npm test', 'npm run test:stress', 'npm audit --omit=dev', 'npm run dist', 'npm run build-tools']
    .forEach(command => assert.ok(
      releaseWorkflow.includes(command),
      `릴리즈 워크플로우에 필수 명령이 없습니다: ${command}`,
    ));

  const buildWorkflow = read('.github/workflows/build.yml');
  [
    'actions/checkout@v6',
    'actions/setup-node@v6',
    'node-version: 24',
    'npm ci',
    'npm run typecheck',
    'npm test',
    'npm run test:stress',
    'npm audit --omit=dev',
    'npm exec electron-builder -- --win --publish never',
    'softprops/action-gh-release@v3',
    'draft: true',
    'fail_on_unmatched_files: true',
    'dist_electron/twOverlay-Setup-*.exe',
    'dist_electron/twOverlay-Setup-*.exe.blockmap',
    'dist_electron/latest.yml',
  ]
    .forEach(command => assert.ok(
      buildWorkflow.includes(command),
      `GitHub Actions 배포 검증에 필수 명령이 없습니다: ${command}`,
    ));
  assert.equal(
    (buildWorkflow.match(/softprops\/action-gh-release@v3/g) || []).length,
    1,
    'GitHub Draft Release 생성 단계는 정확히 하나여야 합니다.',
  );
  assert.doesNotMatch(
    buildWorkflow,
    /action-electron-builder|--publish\s+(?:always|onTag|onTagOrDraft)/,
    'Electron Builder가 GitHub Release를 직접 게시하면 Draft가 중복 생성될 수 있습니다.',
  );
}

function checkBuffTimerChatTriggers(): void {
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js'));

  const detected: Array<{ buffId: string; usedBy: string }> = [];
  const listener = (data: { buffId: string; usedBy: string }) => {
    detected.push({ buffId: data.buffId, usedBy: data.usedBy });
  };

  chatParser.on('BUFF_USED', listener);

  try {
    // 실제 게임 로그 형식: 시간 태그 + 색상 태그가 한 줄에 존재
    chatParser.parseLine('<font size="2" color="white"> [21시 35분 5초] </font><font size="2" color="#ff64ff">[전기세비싸]님이 [통찰의 비약(대)] 아이템을 사용하셨습니다</font>');
    chatParser.parseLine('<font size="2" color="white"> [21시 35분 59초] </font><font size="2" color="#ff64ff">[전기세비싸]님이 [통찰의 비약(특대)] 아이템을 사용하셨습니다</font>');
    chatParser.parseLine('<font size="2" color="white"> [21시 00분 00초] </font>[경험의 심장]을(를) 사용하였습니다.');
    chatParser.parseLine('<font size="2" color="white"> [21시 00분 01초] </font>[홍길동]님이 [로토의 부적] 아이템을 사용하셨습니다.');
    chatParser.parseLine('<font size="2" color="white"> [12시  3분 20초] </font> <font size="2" color="#ff64ff">친구들이 주는 신뢰가 힘을 주고 있다. 모든 능력치 31 증가.</font></br>');

    assert.equal(detected.length, 4, `타이머 표시 대상 4개만 감지되어야 합니다. (실제: ${detected.length}개, buffIds: ${detected.map(d => d.buffId).join(', ')})`);
    assert.deepEqual(detected[0], { buffId: 'insight_elixir_large', usedBy: '전기세비싸' });
    assert.deepEqual(detected[1], { buffId: 'insight_elixir_special', usedBy: '전기세비싸' });
    assert.deepEqual(detected[2], { buffId: 'exp_heart', usedBy: 'self' });
    assert.deepEqual(detected[3], { buffId: 'rare_loto', usedBy: '홍길동' });
  } finally {
    chatParser.removeListener('BUFF_USED', listener);
  }
}

function checkChatLogNormalizationAndItemAcquisition(): void {
  const {
    ChatLogLineNormalizer,
    decodeChatLogBuffer,
    normalizeChatLogLines,
  } = require(path.join(projectRoot, 'dist/modules/chatLogNormalizer.js')) as {
    ChatLogLineNormalizer: new () => {
      push(line: string): string[];
      flush(): string[];
    };
    decodeChatLogBuffer(buffer: Buffer): { content: string; encoding: string; damaged: boolean };
    normalizeChatLogLines(lines: string[]): string[];
  };
  const { parseItemAcquisition, parseItemAcquisitions, formatLootDiaryContent, getGoldPouchSeedAmount } = require(path.join(projectRoot, 'dist/modules/itemAcquisition.js')) as {
    parseItemAcquisition(message: string, context?: { isSelfChat?: boolean }): {
      itemName: string;
      count: number;
      source: string;
      isOwn: boolean;
    } | null;
    parseItemAcquisitions(message: string, context?: { isSelfChat?: boolean }): Array<{
      itemName: string;
      count: number;
      source: string;
      isOwn: boolean;
    }>;
    formatLootDiaryContent(itemName: string): string;
    getGoldPouchSeedAmount(acquisition: { itemName: string; count: number; source: string; isOwn: boolean }): number;
  };
  assert.equal(formatLootDiaryContent(' 경험의\u200B  정수 '), '[득템] 경험의 정수');

  const prefix = '<font size="2" color="white"> [ 0시 25분 12초] </font> <font size="2" color="#ff64ff">';
  const first = `${prefix}피버 효과 : [공격 피해량 +10%] 적용되었습</font></br>`;
  const continuation = `${prefix}니다</font></br>`;
  const merged = normalizeChatLogLines([first, continuation]);
  assert.equal(merged.length, 1);
  assert.match(merged[0], /적용되었습니다<\/font>/);

  const elsoSplitFirst = `${prefix}콘텐츠 클리어 기본 보상으로 [엘소 스크롤 (50 포인트)] 아이템을 15개 획득하였습니</font></br>`;
  const elsoSplitSecond = `${prefix}다.</font></br>`;
  const elsoMerged = normalizeChatLogLines([elsoSplitFirst, elsoSplitSecond]);
  assert.equal(elsoMerged.length, 1);
  assert.match(elsoMerged[0], /15개 획득하였습니다\.<\/font>/);

  const distinct = normalizeChatLogLines([
    `${prefix}[머큐리얼 케이브 코어] 효과가 발동되었습니다.</font></br>`,
    `${prefix}[어비스 코어] 효과가 발동되었습니다.</font></br>`,
  ]);
  assert.equal(distinct.length, 2, '같은 시각의 독립 시스템 메시지가 합쳐졌습니다.');

  const completeRewards = normalizeChatLogLines([
    `${prefix}풍요로운 발굴 지원 보상을 획득했습니다. (하급 조합 조각 1개)</font></br>`,
    `${prefix}경험치가 1,234 증가했습니다.</font></br>`,
    `${prefix}참을 수 없는 힘에 의해 상태이상 [버서크]</font></br>`,
    `${prefix}스탯 자동 분배 완료</font></br>`,
  ]);
  assert.equal(completeRewards.length, 4, '완결된 괄호 메시지가 다음 이벤트와 합쳐졌습니다.');

  const stream = new ChatLogLineNormalizer();
  assert.deepEqual(stream.push(first), []);
  assert.equal(stream.push(continuation).length, 1);
  assert.deepEqual(stream.flush(), []);

  const utf8Decoded = decodeChatLogBuffer(Buffer.from(
    '<font color="white"> [13시 47분 0초] </font> Date : 2026년 8월 14일',
    'utf8',
  ));
  assert.equal(utf8Decoded.encoding, 'utf8');
  assert.equal(utf8Decoded.damaged, false);
  const iconv = require('iconv-lite') as typeof import('iconv-lite');
  const eucKrDecoded = decodeChatLogBuffer(iconv.encode(
    '<font color="white"> [13시 47분 0초] </font> Date : 2026년 8월 14일',
    'euc-kr',
  ));
  assert.equal(eucKrDecoded.encoding, 'euc-kr');
  assert.equal(eucKrDecoded.damaged, false);
  const longAsciiPrefix = Buffer.from('A'.repeat(80 * 1024), 'ascii');
  const utf8Tail = Buffer.from('\n<font color="white"> [13시 47분 0초] </font> 한글 메시지', 'utf8');
  const multiSampleUtf8 = decodeChatLogBuffer(Buffer.concat([longAsciiPrefix, utf8Tail]));
  assert.equal(multiSampleUtf8.encoding, 'utf8');
  assert.match(multiSampleUtf8.content, /한글 메시지/);
  assert.equal(decodeChatLogBuffer(Buffer.from(
    '<meta charset="utf-8">' + 'ASCII only',
    'ascii',
  )).encoding, 'utf8');
  assert.equal(decodeChatLogBuffer(Buffer.concat([
    Buffer.from('<meta charset="euc-kr">', 'ascii'),
    iconv.encode('한글', 'euc-kr'),
  ])).encoding, 'euc-kr');

  assert.deepEqual(parseItemAcquisition('펫이 [장비 강화석]을(를) 주웠습니다.'), {
    itemName: '장비 강화석', count: 1, source: 'pet', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[참 잘했어요]을(를) 5개 습득했습니다.'), {
    itemName: '참 잘했어요', count: 5, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[장비 강화석] 10개를 입수했습니다.'), {
    itemName: '장비 강화석', count: 10, source: 'direct', isOwn: true,
  });
  assert.deepEqual(
    parseItemAcquisition('더블 리워드 추가 보상으로 [장비 강화석] 아이템을 [2]개 추가 획득하였습니다.'),
    { itemName: '장비 강화석', count: 2, source: 'direct', isOwn: true },
    '더블 리워드 추가 보상 수량을 독립 득템으로 감지하지 못했습니다.',
  );
  assert.deepEqual(
    parseItemAcquisition('더블리워드추가보상으로 [스페셜 스킬 (ⓟ 연마)] 아이템을 [1,000]개 추가획득했습니다.'),
    { itemName: '스페셜 스킬 (ⓟ 연마)', count: 1000, source: 'direct', isOwn: true },
    '더블 리워드 문구의 유동 공백과 천 단위 수량을 처리하지 못했습니다.',
  );
  assert.deepEqual(
    parseItemAcquisitions('미션 보상으로 [장비 강화석] 1,000개, [경험의 정수] 2개를 획득했습니다.'),
    [
      { itemName: '장비 강화석', count: 1000, source: 'direct', isOwn: true },
      { itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true },
    ],
    '복수 아이템 파서가 천 단위 쉼표를 아이템 구분자로 잘못 분리했습니다.',
  );
  assert.deepEqual(parseItemAcquisition('하급 마정석 3개를 획득 하였습니다.'), {
    itemName: '하급 마정석', count: 3, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('오케스트라 룸 보상으로 경험의 정수 2개를 획득했습니다.'), {
    itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[[+12] 일회용 베기 인챈트 주문서]을(를) [1]개 획득하였습니다.'), {
    itemName: '[+12] 일회용 베기 인챈트 주문서', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('누군가 프시키의 문양을 획득 하였습니다.'), {
    itemName: '프시키의 문양', count: 1, source: 'other', isOwn: false,
  });
  assert.deepEqual(parseItemAcquisition('누군가 어밴던로드에서 주문을 통해 하급 마정석 1000개를 획득 하였습니다.'), {
    itemName: '하급 마정석', count: 1000, source: 'other', isOwn: false,
  });
  assert.deepEqual(parseItemAcquisition('테일즈 패스 보상을 획득하였습니다 : [테일즈 패스] 보급 상자'), {
    itemName: '보급 상자', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[엘소 50포인트]을(를) [2]개 획득하였습니다.'), {
    itemName: 'ELSO', count: 100, source: 'direct', isOwn: true,
  });

  const { parseElsoMessage } = require(path.join(projectRoot, 'dist/modules/itemAcquisition.js')) as {
    parseElsoMessage(msg: string): number;
  };
  assert.equal(parseElsoMessage('콘텐츠 클리어 기본 보상으로 [엘소 스크롤 (50 포인트)] 아이템을 15개 획득하였습니다.'), 750);
  assert.equal(parseElsoMessage('[엘소 스크롤 (50 포인트)] 15개를 획득했습니다.'), 750);
  assert.equal(parseElsoMessage('[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.'), 10);
  assert.equal(parseElsoMessage('[엘소 스크롤 (10 포인트)]을(를) 획득하였습니다.'), 10);
  assert.equal(parseElsoMessage('[엘소 50포인트]을(를) [2]개 획득하였습니다.'), 100);
  assert.equal(parseElsoMessage('일일 보상으로 1,000 Elso 포인트를 획득하였습니다.'), 1000);
  assert.equal(parseElsoMessage('루미나의 회랑 ELSO 획득량 증가 효과로 [500] ELSO 포인트를 추가로 획득했습니다.'), 500);
  assert.equal(parseElsoMessage('[50]ELSO를 습득했습니다.'), 50);
  assert.deepEqual(parseItemAcquisition('테스터 : 금화 주머니를 획득했습니다.', { isSelfChat: true }), {
    itemName: '금화 주머니', count: 1, source: 'direct', isOwn: true,
  });
  const moonQueenGoldPouches = parseItemAcquisition('가짜 달여왕 군단의 군자금 [ 금화 주머니 80개 ]를 획득했습니다.');
  assert.deepEqual(moonQueenGoldPouches, {
    itemName: '금화 주머니', count: 80, source: 'direct', isOwn: true,
  });
  assert.equal(getGoldPouchSeedAmount(moonQueenGoldPouches!), 40_000_000);
  const exchangedGoldPouches = parseItemAcquisition('금화 주머니 6217개를 획득 하였습니다.');
  assert.deepEqual(exchangedGoldPouches, {
    itemName: '금화 주머니', count: 6217, source: 'direct', isOwn: true,
  });
  assert.equal(getGoldPouchSeedAmount(exchangedGoldPouches!), 3_108_500_000);
  const petGoldPouch = parseItemAcquisition('펫이 [금화 주머니]을(를) 주웠습니다.');
  assert.equal(getGoldPouchSeedAmount(petGoldPouch!), 500_000);
  const otherGoldPouches = parseItemAcquisition('누군가 달여왕 군단의 군자금 [ 금화 주머니 80개 ]를 획득했습니다.');
  assert.equal(otherGoldPouches?.isOwn, false);
  assert.equal(getGoldPouchSeedAmount(otherGoldPouches!), 0,
    '타인의 금화 주머니 공지가 내 SEED 수익으로 환산되었습니다.');
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 1개 획득하였습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 획득하였습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('보급품 탈환 성공 보상으로 경험의 정수 1개를 획득했습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('보급품 탈환 성공 보상으로 경험의 정수 1개와 3000만 Seed를 획득했습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 10개 획득하였습니다.'), {
    itemName: '경험의 정수', count: 10, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('달여왕 군대 훈련소 클리어 보상으로 경험의 정수 2개를 획득했습니다.'), {
    itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true,
  });
  assert.deepEqual(parseItemAcquisition('[경험의 정수] 아이템을 추가로 획득하였습니다.'), {
    itemName: '경험의 정수', count: 1, source: 'direct', isOwn: true,
  });
  [
    '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.',
    '탐험 포인트를 10만큼 획득하였습니다.',
    '수호의 가호(피해 저항 +15%) 효과를 획득했습니다.',
    '경험치 100억이 차감되고, 경험의 정수 1개를 획득 하였습니다.',
  ].forEach(message => assert.equal(
    parseItemAcquisition(message),
    null,
    `아이템이 아닌 획득 문구를 잘못 분류했습니다: ${message}`,
  ));

  const { chatParser } = require(path.join(projectRoot, 'dist/modules/chatParser.js')) as {
    chatParser: {
      on(event: string, listener: (data: any) => void): void;
      off(event: string, listener: (data: any) => void): void;
      once(event: string, listener: (data: { itemName: string; count: number; source: string; isOwn: boolean }) => void): void;
      parseLine(line: string): void;
    };
  };
  let autoExchangeAmount = 0;
  const onAutoExchange = (data: { amount: number }) => { autoExchangeAmount = data.amount; };
  chatParser.on('XP_CHANGED', onAutoExchange);
  chatParser.parseLine(`${prefix}경험치 100억이 차감되고, 경험의 정수 1개를 획득 하였습니다.</font></br>`);
  chatParser.off('XP_CHANGED', onAutoExchange);
  assert.equal(autoExchangeAmount, 0,
    '복합 경험의 정수 획득 안내를 100억 감소 로그와 중복 집계했습니다.');

  const { ChatParser } = require(path.join(projectRoot, 'dist/modules/chatParser.js')) as {
    ChatParser: new () => {
      on(event: string, listener: (data: any) => void): void;
      parseLine(line: string): void;
    };
  };
  const pairedExchangeParser = new ChatParser();
  let pairedExchangeEvents = 0;
  pairedExchangeParser.on('XP_CHANGED', (data: { amount: number }) => {
    if (data.amount === -10_000_000_000) pairedExchangeEvents++;
  });

  const positionPolicy = require(path.join(projectRoot, 'dist', 'modules', 'windowPositionPolicy.js')) as {
    supportsFixedScreenPosition(key: string): boolean;
    toScreenPosition(key: string, rect: object, position: object): { x: number; y: number };
    toRelativePosition(key: string, rect: object, position: object): { offsetX: number; offsetY: number };
    resolveFixedScreenPosition(
      key: string,
      rect: object,
      relativePosition: object,
      storedScreenPosition: object | undefined,
      fixedModeWasActive: boolean,
    ): { x: number; y: number };
  };
  const gameRect = { x: 120, y: 80, width: 1280, height: 720 };
  const chatOffset = { offsetX: -500, offsetY: 130 };
  const chatScreenPosition = positionPolicy.toScreenPosition('chatOverlay', gameRect, chatOffset);
  assert.deepEqual(chatScreenPosition, { x: 900, y: 210 },
    '채팅 오버레이 상대 오프셋이 화면 절대 좌표로 올바르게 변환되지 않았습니다.');
  assert.deepEqual(positionPolicy.toRelativePosition('chatOverlay', gameRect, chatScreenPosition), chatOffset,
    '채팅 오버레이의 절대 좌표 왕복 변환이 위치를 바꿉니다.');
  const movedGameRect = { x: 420, y: 260, width: 1024, height: 768 };
  const fixedChatOffsetAfterGameMove = positionPolicy.toRelativePosition(
    'chatOverlay',
    movedGameRect,
    chatScreenPosition,
  );
  assert.deepEqual(
    positionPolicy.toScreenPosition('chatOverlay', movedGameRect, fixedChatOffsetAfterGameMove),
    chatScreenPosition,
    '게임창 따라가기 OFF에서 게임 창 이동이 채팅 오버레이의 화면 고정 위치를 바꿉니다.',
  );
  const movedWithFollowPosition = positionPolicy.toScreenPosition('chatOverlay', movedGameRect, chatOffset);
  assert.deepEqual(
    positionPolicy.resolveFixedScreenPosition(
      'chatOverlay',
      movedGameRect,
      chatOffset,
      chatScreenPosition,
      false,
    ),
    movedWithFollowPosition,
    '게임창을 이동한 뒤 Follow OFF로 전환할 때 이전 절대 좌표로 창이 튑니다.',
  );
  assert.deepEqual(
    positionPolicy.resolveFixedScreenPosition(
      'chatOverlay',
      movedGameRect,
      chatOffset,
      chatScreenPosition,
      true,
    ),
    chatScreenPosition,
    'Follow OFF 상태에서 게임 창 이동이 저장된 화면 고정 위치를 덮어씁니다.',
  );
  const browserOffset = { offsetX: 30, offsetY: 45 };
  const browserScreenPosition = positionPolicy.toScreenPosition('overlay', gameRect, browserOffset);
  assert.deepEqual(browserScreenPosition, { x: 150, y: 125 },
    '브라우저 오버레이가 게임 우측 기준으로 잘못 변환되었습니다.');
  assert.deepEqual(positionPolicy.toRelativePosition('overlay', gameRect, browserScreenPosition), browserOffset,
    '브라우저 오버레이의 절대 좌표 왕복 변환이 위치를 바꿉니다.');
  assert.equal(positionPolicy.supportsFixedScreenPosition('chatOverlay'), true);
  assert.equal(positionPolicy.supportsFixedScreenPosition('dock'), false);
  assert.equal(positionPolicy.supportsFixedScreenPosition('gameOverlay'), false);
  const fullscreenRect = { x: 0, y: 0, width: 1920, height: 1080 };
  const fullscreenOffset = positionPolicy.toRelativePosition('chatOverlay', fullscreenRect, chatScreenPosition);
  assert.deepEqual(
    positionPolicy.toScreenPosition('chatOverlay', fullscreenRect, fullscreenOffset),
    chatScreenPosition,
    '창모드 위치를 창모드 전체화면 프로필로 변환할 때 실제 화면 위치가 바뀝니다.',
  );
  pairedExchangeParser.parseLine(`${prefix}경험치가 10000000000 감소했습니다.</font></br>`);
  pairedExchangeParser.parseLine(`${prefix}경험치 100억이 차감되고, 경험의 정수 1개를 획득 하였습니다.</font></br>`);
  assert.equal(pairedExchangeEvents, 1,
    '한 번의 경험의 정수 자동 전환이 감소·획득 두 로그 때문에 두 번 집계됩니다.');

  const acquisitions: Array<{ itemName: string; count: number; source: string; isOwn: boolean }> = [];
  chatParser.once('ITEM_LOOTED', data => { acquisitions.push(data); });
  chatParser.parseLine(`${prefix}펫이 [머큐리얼 케이브 코어]을(를) 주웠습니다.</font></br>`);
  assert.deepEqual(
    acquisitions[0] && {
      itemName: acquisitions[0].itemName,
      count: acquisitions[0].count,
      source: acquisitions[0].source,
    },
    { itemName: '머큐리얼 케이브 코어', count: 1, source: 'pet' },
  );
  const userLogLines = [
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">콘텐츠 클리어 기본 보상으로 [엘소 스크롤 (50 포인트)] 아이템을 15개 획득하였습니</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[이클립스 코어 상자] 아이템을 20개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[셀리니아코스의 보관 주머니] 아이템을 1개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">앞서 획득한 달여왕 군단 훈장 훈장은 [1+1] 이벤트를 통해 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (50 포인트)] 15개를 획득했습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">앞서 획득한 엘소 스크롤 (50 포인트) 아이템은 [1+1] 이벤트를 통해 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">[셀리니아코스의 보관 주머니] 1개를 획득했습니다.</font></br>',
    '<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">앞서 획득한 셀리니아코스의 보관 주머니 아이템은 [1+1] 이벤트를 통해 획득하였습니</font></br>',
    '<font size="2" color="white"> [13시 34분 24초] </font> <font size="2" color="#ff64ff">전기세비싸님이 팀을 탈퇴하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 25초] </font> <font size="2" color="#ff64ff">[스매쉬]님이 [5000]의 HP를 회복시켜 주었습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 26초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#ff64ff">[스매쉬]님이 [5000]의 HP를 회복시켜 주었습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#c896c8">외치기 : 베한계 이클리스트 500베 효과 삽니다 Click [소온]</font></br>',
    '<font size="2" color="white"> [13시 34분 28초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 28초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">[스매쉬]님이 [5000]의 HP를 회복시켜 주었습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">피버 효과가 종료되었습니다</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 29초] </font> <font size="2" color="#ff64ff">[엘소 스크롤 (10 포인트)] 아이템을 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [13시 34분 30초] </font> <font size="2" color="#94ddfa">슈테리히트 : 흠</font></br>',
    '<font size="2" color="white"> [21시 19분 57초] </font> <font size="2" color="#94ddfa">연어한입 : 나 주간획득시드 63억/66억인데 왜 콘텐츠 한도 도달해서 못얻는다고 나올</font></br>',
    '<font size="2" color="white"> [21시 19분 58초] </font> <font size="2" color="#ffffff">일반채팅 : 50억 SEED를 획득한 사람?</font></br>',
    '<font size="2" color="white"> [21시 19분 59초] </font> <font size="2" color="#c8ffc8">내캐릭터 : 40억 SEED를 획득했다고 들었음</font></br>',
    '<font size="2" color="white"> [21시 20분  0초] </font> <font size="2" color="#f7b73c">팀원 : 30억 SEED를 획득했어?</font></br>',
    '<font size="2" color="white"> [21시 20분  1초] </font> <font size="2" color="#64ff64">상대님의 귓속말 : 20억 SEED를 획득했음</font></br>',
    '<font size="2" color="white"> [21시 20분  2초] </font> <font size="2" color="#c896c8">외치기 : 10억 SEED를 획득한 분 From [테스터]</font></br>',
  ];
  const normalizedUserLogs = normalizeChatLogLines(userLogLines);
  let totalParsedElso = 0;
  const userLootListener = (data: { message: string }) => {
    totalParsedElso += parseElsoMessage(data.message);
  };
  chatParser.on('ITEM_LOOTED', userLootListener);

  let totalParsedSeed = 0;
  const userSeedListener = (data: { amount: number }) => {
    totalParsedSeed += data.amount;
  };
  chatParser.on('SEED_GAINED', userSeedListener);

  normalizedUserLogs.forEach(l => chatParser.parseLine(l));
  chatParser.off('ITEM_LOOTED', userLootListener);
  chatParser.off('SEED_GAINED', userSeedListener);

  assert.equal(
    totalParsedSeed,
    35000000,
    '플레이어 채팅의 SEED 언급은 제외하고 실제 3500만 SEED 획득만 파싱해야 합니다.',
  );
  assert.equal(totalParsedElso, 1560, `사용자 로그에서 총 1560 엘소가 감지되어야 하나 ${totalParsedElso}가 감지되었습니다.`);

  const rewardAcquisitions: Array<{ itemName: string; count: number; source: string; isOwn: boolean }> = [];
  chatParser.once('ITEM_LOOTED', data => { rewardAcquisitions.push(data); });
  chatParser.parseLine(`${prefix}오케스트라 룸 보상으로 경험의 정수 2개를 획득했습니다.</font></br>`);
  assert.deepEqual(
    rewardAcquisitions[0] && {
      itemName: rewardAcquisitions[0].itemName,
      count: rewardAcquisitions[0].count,
      source: rewardAcquisitions[0].source,
      isOwn: rewardAcquisitions[0].isOwn,
    },
    { itemName: '경험의 정수', count: 2, source: 'direct', isOwn: true },
  );

  // ── 신규 숙제 및 로그 파싱 검증 (혼란한 대지, 색을 잃은 땅, 설계자의 채굴장) ──
  const contents = JSON.parse(read('src/assets/data/contents.json')) as Array<{ id: string; name: string; resetRule: { type: string } }>;
  assert.ok(contents.some(c => c.id === 'daily-confused-land' && c.name === '혼란한 대지' && c.resetRule.type === 'daily'), '혼란한 대지 숙제 정의가 누락되었습니다.');
  assert.ok(contents.some(c => c.id === 'daily-colorless-land' && c.name === '색을 잃은 땅' && c.resetRule.type === 'daily'), '색을 잃은 땅 숙제 정의가 누락되었습니다.');
  assert.ok(contents.some(c => c.id === 'daily-architect-mine' && c.name === '설계자의 채굴장' && c.resetRule.type === 'daily'), '설계자의 채굴장 숙제 정의가 누락되었습니다.');

  // 1. 혼란한 대지 ELSO 및 완료 이벤트 검증
  assert.equal(parseElsoMessage('감정 균형 장치 방어 보상으로 5000 ELSO를 획득했습니다.'), 5000);
  assert.equal(parseElsoMessage('혼란한 대지 미션에 성공하여 10000 ELSO를 획득했습니다.'), 10000);

  let confusedClearCalled = false;
  const onConfusedClear = () => { confusedClearCalled = true; };
  chatParser.once('CONFUSED_LAND_CLEAR', onConfusedClear);
  chatParser.parseLine('<font size="2" color="white"> [ 0시  6분 37초] </font> <font size="2" color="#ff64ff">감정 균형 장치 방어 보상으로 5000 ELSO를 획득했습니다.</font></br>');
  assert.ok(confusedClearCalled, '혼란한 대지 완료 이벤트(CONFUSED_LAND_CLEAR)가 발생하지 않았습니다.');

  // 2. 색을 잃은 땅 줄바꿈 병합, 경험의 정수 추출, ELSO 및 완료 이벤트 검증
  const colorlessSplitLogs = [
    '<font size="2" color="white"> [18시 22분 45초] </font> <font size="2" color="#ff64ff">색을 잃은 땅 미션에 성공하여 경험의 정수 2개, 레이티아의 시든 꽃 1개, 루비코나 코</font></br>',
    '<font size="2" color="white"> [18시 22분 45초] </font> <font size="2" color="#ff64ff">어 상자 10개를 획득했습니다.</font></br>',
  ];
  const mergedColorless = normalizeChatLogLines(colorlessSplitLogs);
  assert.equal(mergedColorless.length, 1, '색을 잃은 땅 줄바꿈 로그가 하나로 병합되지 않았습니다.');
  assert.match(mergedColorless[0], /루비코나 코어 상자 10개를 획득했습니다\./);

  const colorlessLootItems: Array<{ itemName: string; count: number }> = [];
  const onColorlessLoot = (data: { itemName: string; count: number }) => {
    colorlessLootItems.push({ itemName: data.itemName, count: data.count });
  };
  chatParser.on('ITEM_LOOTED', onColorlessLoot);
  chatParser.parseLine(mergedColorless[0]);
  chatParser.off('ITEM_LOOTED', onColorlessLoot);
  const essenceItem = colorlessLootItems.find(item => item.itemName === '경험의 정수');
  assert.ok(essenceItem, '색을 잃은 땅 보상에서 경험의 정수가 감지되지 않았습니다.');
  assert.equal(essenceItem?.count, 2, '경험의 정수 획득 수량이 일치하지 않습니다.');

  assert.equal(parseElsoMessage('색을 잃은 땅 미션에 성공하여 10000 ELSO를 획득했습니다.'), 10000);
  assert.equal(parseElsoMessage('미션 효과 미적용 보상으로 10000 ELSO를 추가로 획득했습니다.'), 10000);

  let colorlessClearCalled = false;
  const onColorlessClear = () => { colorlessClearCalled = true; };
  chatParser.once('COLORLESS_LAND_CLEAR', onColorlessClear);
  chatParser.parseLine('<font size="2" color="white"> [18시 22분 45초] </font> <font size="2" color="#ff64ff">색을 잃은 땅 미션에 성공하여 10000 ELSO를 획득했습니다.</font></br>');
  assert.ok(colorlessClearCalled, '색을 잃은 땅 완료 이벤트(COLORLESS_LAND_CLEAR)가 발생하지 않았습니다.');

  // 3. 설계자의 채굴장 하급 조합 조각 획득 및 입장 감지 검증
  let architectEntryCount = 0;
  const onArchitectEntry = (data: { count?: number }) => { architectEntryCount = data.count || 0; };
  chatParser.once('ARCHITECT_MINE_ENTRY', onArchitectEntry);
  chatParser.parseLine('<font size="2" color="white"> [18시 29분 58초] </font> <font size="2" color="#ff64ff">하급 조합 조각 5개를 획득했습니다.</font></br>');
  assert.equal(architectEntryCount, 5, '설계자의 채굴장 입장 이벤트(ARCHITECT_MINE_ENTRY) 수량이 일치하지 않습니다.');

  // 4. 실제 유저 로그 파일(.agents/plan/혼대_색땅_채굴장/TWChatLog_2026_08_17.html) 종합 파싱 검증
  const actualLogPath = path.join(projectRoot, '.agents/plan/혼대_색땅_채굴장/TWChatLog_2026_08_17.html');
  if (fs.existsSync(actualLogPath)) {
    const rawBuf = fs.readFileSync(actualLogPath);
    const decodedLog = decodeChatLogBuffer(rawBuf);
    const normalizedLines = normalizeChatLogLines(decodedLog.content.split('\n'));

    let fileConfusedClears = 0;
    let fileColorlessClears = 0;
    let fileArchitectEntries = 0;
    let fileColorlessEssenceCount = 0;
    let fileConfusedElso = 0;
    let fileColorlessElso = 0;

    const actualParser = new (chatParser.constructor as any)();
    actualParser.on('CONFUSED_LAND_CLEAR', () => { fileConfusedClears++; });
    actualParser.on('COLORLESS_LAND_CLEAR', () => { fileColorlessClears++; });
    actualParser.on('ARCHITECT_MINE_ENTRY', () => { fileArchitectEntries++; });
    actualParser.on('ITEM_LOOTED', (data: { itemName: string; count: number; timestamp: string; message: string }) => {
      if (data.itemName === '경험의 정수' && data.timestamp.includes('18시 22분 45초')) {
        fileColorlessEssenceCount += data.count;
      }
      if (data.timestamp.includes('0시  6분 37초')) {
        fileConfusedElso += parseElsoMessage(data.message);
      }
      if (data.timestamp.includes('18시 22분 45초')) {
        fileColorlessElso += parseElsoMessage(data.message);
      }
    });

    for (const l of normalizedLines) {
      if (l && !l.includes('회복되었습니다')) {
        actualParser.parseLine(l);
      }
    }

    assert.equal(fileConfusedClears, 1, '실제 로그 파일에서 혼란한 대지 완료가 1회 감지되어야 합니다.');
    assert.equal(fileConfusedElso, 15000, '실제 로그 파일에서 혼란한 대지 ELSO 획득 총합(10000+5000)이 15000이어야 합니다.');
    assert.equal(fileColorlessClears, 1, '실제 로그 파일에서 색을 잃은 땅 완료가 1회 감지되어야 합니다.');
    assert.equal(fileColorlessElso, 20000, '실제 로그 파일에서 색을 잃은 땅 ELSO 획득 총합(10000+10000)이 20000이어야 합니다.');
    assert.equal(fileColorlessEssenceCount, 2, '실제 로그 파일에서 색을 잃은 땅 경험의 정수 획득이 2개여야 합니다.');
    assert.ok(fileArchitectEntries > 0, '실제 로그 파일에서 설계자의 채굴장(하급 조합 조각)이 감지되어야 합니다.');
  }

  // ── 과거 채팅 히스토리 분류 및 색상 보정 회귀 검증 ──
  const { classifyHistoryMessage } = require(
    path.join(projectRoot, 'dist/modules/chatLogManager.js'),
  ) as {
    classifyHistoryMessage(color: string, message: string): {
      category: string;
      type: string;
      sender: string;
      message: string;
      color: string;
    };
  };

  // 1. 클럽 채팅에서 "시드" 단어가 포함되어 있어도 클럽 채널 및 색상이 유지되어야 함
  const clubChatResult = classifyHistoryMessage(
    '#94ddfa',
    '니요 : 근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?',
  );
  assert.deepEqual(clubChatResult, {
    category: 'Club',
    type: 'club',
    sender: '니요',
    message: '근데 5각하면 전투력말고 시드를 더 벌어준다던가 그런게 있음?',
    color: '#94ddfa',
  });

  // 2. 일반 채팅에서 "시드" 단어가 포함되어 있어도 일반 채널 및 색상이 유지되어야 함
  const generalChatResult = classifyHistoryMessage(
    '#ffffff',
    '홍길동 : 시드 얼마 있어?',
  );
  assert.deepEqual(generalChatResult, {
    category: 'General',
    type: 'general',
    sender: '홍길동',
    message: '시드 얼마 있어?',
    color: '#ffffff',
  });

  // 3. 실제 SEED 획득 시스템 메시지는 시스템 채널로 분류되고 시스템 색상으로 보정되어야 함
  const seedGainResult = classifyHistoryMessage(
    '#ffffff',
    '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.',
  );
  assert.deepEqual(seedGainResult, {
    category: 'System',
    type: 'system',
    sender: '시스템',
    message: '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.',
    color: '#a8a8a8',
  });

  // 4. 실제 아이템 획득 시스템 메시지는 노란색(#ffd700) 시스템 채널로 분류되어야 함
  const itemGainResult = classifyHistoryMessage(
    '#ffffff',
    '[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.',
  );
  assert.deepEqual(itemGainResult, {
    category: 'System',
    type: 'system',
    sender: '시스템',
    message: '[달여왕 군단 훈장] 을(를) 1개 획득하였습니다.',
    color: '#ffd700',
  });
}

function checkTodaySummary(): void {
  const { parseAutoLogAmount, resolveLootCount } = require(
    path.join(projectRoot, 'dist/renderer/diary/log-utils.js'),
  ) as {
    parseAutoLogAmount(content: string): number;
    resolveLootCount(content: string, storedAmount: unknown): number;
  };
  assert.equal(parseAutoLogAmount('[자동] 보상 (1조)'), 1_000_000_000_000);
  assert.equal(parseAutoLogAmount('[자동] 보상 (1조 2억 3만)'), 1_000_200_030_000);
  assert.equal(parseAutoLogAmount('[자동] 보상 (1,234)'), 1_234);
  assert.equal(resolveLootCount('[득템] 경험의 정수', 2), 2);
  assert.equal(resolveLootCount('[득템] 경험의 정수 3개', 0), 3);
  assert.equal(resolveLootCount('[득템] 경험의 정수', 0), 1);

  const { buildTodaySummary, getLocalDateKey } = require(
    path.join(projectRoot, 'dist/modules/todaySummary.js'),
  ) as {
    buildTodaySummary(config: any, diaryData: any, date: string): any;
    getLocalDateKey(date: Date): string;
  };
  assert.equal(getLocalDateKey(new Date(2026, 7, 15, 0, 0, 0)), '2026-08-15');

  const makeHomework = (id: string, name: string, state: Record<string, unknown>, isVisible = true) => ({
    id, name, category: '레이드', isVisible,
    resetRule: { type: 'weekly' }, maxCount: 7,
    completedState: { selected: state },
  });
  const config = {
    characterPresets: [{ id: 'other', name: '부캐' }, { id: 'selected', name: '본캐' }],
    selectedCharacterId: 'selected',
    contentsCheckerItems: [
      makeHomework('done', '완료 숙제', { isCompleted: true, currentCount: 7 }),
      makeHomework('one', '남은 숙제 1', { isCompleted: false, currentCount: 2 }),
      makeHomework('two', '남은 숙제 2', { isCompleted: false }),
      makeHomework('excluded', '제외 숙제', { isCompleted: false, isExcluded: true }),
      makeHomework('hidden', '숨김 숙제', { isCompleted: false }, false),
    ],
  };
  const summary = buildTodaySummary(config, {
    diary: null,
    homeworkLogs: [],
    activityLogs: [
      { type: 'calc', amount: 12_000_000, content: '[자동] SEED', time: '10:00:00' },
      { type: 'elso', amount: 3500, content: '엘소 포인트 획득', time: '10:01:00' },
      { type: 'boss', amount: 0, content: '[보스 처치] 테스트', time: '10:02:00' },
      { type: 'loot', amount: 2, content: '[득템] [장비 강화석]을(를) [2]개 획득하였습니다.', time: '10:03:00' },
      { type: 'loot', amount: 1, content: '[득템] 펫이 [장비 강화석]을(를) 주웠습니다.', time: '10:04:00' },
      { type: 'loot', amount: 2, content: '[득템] 경험의 정수', time: '10:05:00' },
      { type: 'loot', amount: 1, content: '[득템] 경험의\u200B 정수', time: '10:06:00' },
    ],
  }, '2026-08-15');

  assert.equal(summary.totalSeed, 12_000_000);
  assert.equal(summary.totalElso, 3500);
  assert.equal(summary.totalEssence, 3);
  assert.equal(summary.bossKills, 1);
  assert.equal(summary.totalLootCount, 3);
  assert.deepEqual(summary.lootItems, [
    { name: '장비 강화석', count: 3 },
  ], '오늘 요약의 경험의 정수 전용 합계가 일반 득템 목록에 중복 표시됩니다.');
  assert.deepEqual(summary.homework, {
    characterName: '본캐',
    completedCount: 1,
    totalCount: 3,
    remainingCount: 2,
    remainingItems: [
      { name: '남은 숙제 1', category: '레이드', type: 'weekly', currentCount: 2, maxCount: 7 },
      { name: '남은 숙제 2', category: '레이드', type: 'weekly', currentCount: 0, maxCount: 7 },
    ],
  });

  assert.match(read('src/modules/chatLogProcessor.ts'),
    /isAlwaysTrackedItem = isAlwaysTrackedLoot\(data\.itemName\)[\s\S]*?shouldRecordItem = isAlwaysTrackedItem \|\| matchesRegisteredLoot\(keywords, data\.itemName\)/,
    '경험의 정수 상시 기록과 일반 등록 아이템 필터가 함께 유지되지 않습니다.');
  assert.match(read('src/modules/chatLogProcessor.ts'), /data\.isOwn/,
    '타인의 획득 알림이 모험일지에 기록될 수 있습니다.');
  assert.match(read('src/modules/chatLogProcessor.ts'),
    /const diaryContent = formatLootDiaryContent\(data\.itemName\)/,
    '실시간 득템 기록이 정확한 파싱 아이템명으로 저장되지 않습니다.');
  const lootPolicy = require(path.join(projectRoot, 'dist/shared/lootPolicy.js')) as {
    matchesRegisteredLoot(keywords: string[], ...candidates: string[]): boolean;
    isAlwaysTrackedLoot(...candidates: string[]): boolean;
    countsTowardLootTotal(value: string): boolean;
  };
  assert.equal(lootPolicy.matchesRegisteredLoot(['하급 마정석'], '[득템] [하급 마정석]'), true);
  assert.equal(lootPolicy.matchesRegisteredLoot(['경험의 심장'], '경험의 심장'), true);
  assert.equal(lootPolicy.matchesRegisteredLoot(['경험의 심장'], '룬 경험의 심장'), false,
    '등록되지 않은 룬 경험의 심장이 경험의 심장 부분 문자열로 오탐되었습니다.');
  assert.equal(lootPolicy.matchesRegisteredLoot(
    ['경험의 심장'],
    '[득템] [룬 경험의 심장]을(를) 10개 습득했습니다.',
  ), false, '구버전 원문 형식의 룬 경험의 심장이 등록 아이템으로 오탐되었습니다.');
  assert.equal(lootPolicy.matchesRegisteredLoot(
    ['경험의 심장'],
    '[득템] [경험의 심장]을(를) 3개 습득했습니다.',
  ), true, '구버전 원문 형식의 경험의 심장을 식별하지 못했습니다.');
  assert.equal(lootPolicy.matchesRegisteredLoot([], '[득템] [하급 마정석]'), false);
  assert.equal(lootPolicy.isAlwaysTrackedLoot('경험의 정수'), true);
  assert.equal(lootPolicy.isAlwaysTrackedLoot('[득템] 경험의 정수'), true);
  assert.equal(lootPolicy.isAlwaysTrackedLoot('경험의 정수 상자'), false);
  assert.equal(lootPolicy.countsTowardLootTotal('하급 마정석'), false);
  assert.equal(lootPolicy.countsTowardLootTotal('경험의 정수'), false);
  assert.equal(lootPolicy.countsTowardLootTotal('스페셜 스킬'), true);
  assert.match(read('src/modules/diaryDb.ts'),
    /normalizeExistingLootContent\((?:true)?\)[\s\S]*?if \(!condensed\.includes\('경험의정수'\)\) continue/,
    '기존 비정규 득템 기록을 정리하는 마이그레이션이 누락되었습니다.');
  assert.match(read('src/modules/diaryDb.ts'),
    /const item = \{ date: log\.date, content: log\.content, amount: log\.amount \|\| 1 \};[\s\S]*?calendarLootList\.push\(item\);[\s\S]*?if \(!isAlwaysTrackedLoot\(log\.content\)\) lootList\.push\(item\);/,
    '월간 득템 목록 분리 과정에서 실제 수량 또는 경험의 정수 제외 정책이 누락될 수 있습니다.');
  const diaryPage = read('src/diary.html');
  assert.match(diaryPage, /parseLootItem\(item\.content, item\.amount\)/,
    '월간 득템 목록이 별도 수량 필드를 사용하지 않습니다.');
  assert.match(diaryPage, /currentSummary\.calendarLootList\.filter\(l => l\.date === dStr\)/,
    '통계 탭 득템 목록 분리 후 활동 달력의 별도 목록을 사용하지 않습니다.');
  assert.doesNotMatch(diaryPage, /경험의 정수는 목록에는 표시되지만/,
    '득템 기록 탭에 경험의 정수가 표시된다는 오래된 안내가 남아 있습니다.');
  assert.match(diaryPage, /formatTimelineLogContent\(log\)/,
    '모험일지 타임라인에서 별도 수량 필드가 표시되지 않습니다.');
  assert.match(diaryPage,
    /diaryAddActivity\([\s\S]*?'calc'[\s\S]*?formatSeedAmount\(amount\)[\s\S]*?amount,[\s\S]*?\);/,
    '수동 수익의 실제 금액이 calc amount로 저장되지 않습니다.');
  assert.match(diaryPage,
    /id="loot-item-summary-list"[\s\S]*?const itemTotals = new Map\(\)[\s\S]*?current\.count \+= item\.count/,
    '득템 기록의 기간별 품목 합계 UI 또는 집계가 누락되었습니다.');
  assert.match(diaryPage,
    /id="loot-summary-pane"[\s\S]*?id="loot-pane-resizer"[\s\S]*?role="separator"[\s\S]*?id="loot-daily-pane"/,
    '득템 기록의 품목별 합계/일자별 기록 구분선 구조가 누락되었습니다.');
  assert.match(diaryPage,
    /requestAnimationFrame\(\(\) => window\.diaryLootSplitPane\.refresh\(\)\)/,
    '숨겨진 득템 탭을 표시한 뒤 분할 영역 높이를 다시 계산하지 않습니다.');
  const lootSplitPane = require(
    path.join(projectRoot, 'dist/renderer/diary/loot-split-pane.js'),
  ) as {
    storageKey: string;
    defaultHeight: number;
    minimumSummaryHeight: number;
    minimumDailyHeight: number;
    clampSummaryHeight(requested: number, containerHeight: number, resizerHeight: number): number;
  };
  assert.equal(lootSplitPane.storageKey, 'tw-overlay:diary-loot-summary-height:v1');
  assert.equal(lootSplitPane.defaultHeight, 158);
  assert.equal(lootSplitPane.minimumSummaryHeight, 92);
  assert.equal(lootSplitPane.minimumDailyHeight, 210);
  assert.equal(lootSplitPane.clampSummaryHeight(40, 700, 20), 92,
    '품목별 합계 영역의 최소 높이가 보장되지 않습니다.');
  assert.equal(lootSplitPane.clampSummaryHeight(700, 700, 20), 470,
    '일자별 기록 영역의 최소 높이가 보장되지 않습니다.');
  assert.equal(lootSplitPane.clampSummaryHeight(158, 700, 20), 158);
  assert.equal(lootSplitPane.clampSummaryHeight(200, 0, 20), 200,
    '숨겨진 탭의 높이 0으로 저장 높이가 잘못 축소됩니다.');
  const lootSplitPaneSource = read('src/renderer/diary/loot-split-pane.ts');
  assert.match(lootSplitPaneSource, /window\.localStorage\.setItem\(STORAGE_KEY/,
    '사용자가 조절한 득템 기록 분할 높이가 이 PC에 저장되지 않습니다.');
  assert.match(lootSplitPaneSource, /pointerdown[\s\S]*?pointermove[\s\S]*?pointerup/,
    '득템 기록 구분선의 포인터 드래그 계약이 누락되었습니다.');
  assert.match(lootSplitPaneSource, /ArrowUp[\s\S]*?ArrowDown[\s\S]*?Home[\s\S]*?End/,
    '득템 기록 구분선의 키보드 조절 계약이 누락되었습니다.');
  assert.doesNotMatch(read('src/modules/xpTracker.ts'), /ESSENCE_GAINED/,
    '경험의 정수 전용 감지가 공통 아이템 감지와 중복 실행될 수 있습니다.');
  assert.match(read('src/game-overlay.html'), /id="today-summary-hud"/);
  assert.doesNotMatch(read('src/game-overlay.html'), /id="today-summary-toggle"/,
    '오늘 요약 HUD 타이틀에 클릭 영역이 남아 있습니다.');
  assert.match(read('src/game-overlay.html'), /renderer\/game-overlay\/today-summary\.js/);
  assert.match(read('src/modules/ipcHandlers.ts'), /ipcMain\.handle\('today-summary-get'/);
  assert.match(read('src/renderer/game-overlay/today-summary.ts'), /new MutationObserver\(positionSummary\)/,
    '활성 HUD와 오늘 요약의 겹침을 다시 계산하지 않습니다.');
  const settings = read('src/settings.html');
  assert.match(settings, /id="today-summary-hud-settings-card"/);
  assert.match(settings, /id="today-summary-show-input"/);
  assert.match(settings, /id="today-summary-collapsed-input"/);
  assert.match(settings, /id="today-summary-pos-left"/);
  assert.match(settings, /id="today-summary-pos-top"/);
  assert.match(settings, /id="shortcut-toggleTodaySummaryHud"/);
  const shortcutManager = read('src/modules/shortcutManager.ts');
  assert.match(shortcutManager,
    /showTodaySummaryHud === false[\s\S]*?showTodaySummaryHud:\s*true,\s*todaySummaryCollapsed:\s*true/,
    '숨겨진 오늘 요약 HUD가 접힌 상태로 다시 표시되지 않습니다.');
  assert.match(shortcutManager,
    /todaySummaryCollapsed \?\? true[\s\S]*?todaySummaryCollapsed:\s*false[\s\S]*?showTodaySummaryHud:\s*false/,
    '오늘 요약 HUD가 접힘 → 펼침 → 숨김 순서로 순환하지 않습니다.');
  assert.match(read('src/modules/constants.ts'), /toggleTodaySummaryHud:\s*'CommandOrControl\+Shift\+Y'/);
  assert.doesNotMatch(settings, /shortcut-toggleTodaySummaryCollapsed/);
  assert.match(read('src/modules/constants.ts'), /todaySummaryCollapsed:\s*true/);
  assert.match(read('src/modules/windowManager.ts'), /gameOverlayWindow\.setIgnoreMouseEvents\(true\)/);
  assert.match(read('src/preload.ts'), /onTodaySummaryConfig:[\s\S]*?today-summary-config/);
  assert.match(read('src/modules/windowManager.ts'), /webContents\.send\('today-summary-config', updated\)/);
  assert.match(read('src/renderer/game-overlay/today-summary.ts'), /api\.onTodaySummaryConfig\(config =>/);
  assert.match(read('src/modules/config.ts'), /todaySummaryHudPos[\s\S]*?top/);
}

function checkHuntingExpCalculator(): void {
  const calculator = require(path.join(projectRoot, 'dist/shared/huntingExpCalculator.js')) as {
    EXPERIENCE_ESSENCE_XP: number;
    DEFAULT_DOPINGS: Array<{ id: string; name: string; percent: number; duration: string; enabled: boolean }>;
    DEFAULT_GROUNDS: Array<{ id: string; name: string; baseXp: number }>;
    calculate(input: {
      dopings: Array<{ percent: number; enabled: boolean }>;
      baseXp: number;
      killsPerHour: number;
      happyHour: boolean;
    }): { appliedPercent: number; experiencePerKill: number; experiencePerHour: number; experienceEssencePerHour: number };
  };
  assert.equal(calculator.EXPERIENCE_ESSENCE_XP, 10_000_000_000);
  const result = calculator.calculate({
    dopings: calculator.DEFAULT_DOPINGS,
    baseXp: 200_000,
    killsPerHour: 40_000,
    happyHour: true,
  });
  assert.deepEqual(result, {
    appliedPercent: 4825,
    experiencePerKill: 14_775_000,
    experiencePerHour: 591_000_000_000,
    experienceEssencePerHour: 59.1,
  });
  assert.deepEqual(calculator.calculate({
    dopings: calculator.DEFAULT_DOPINGS,
    baseXp: 200_000,
    killsPerHour: 40_000,
    happyHour: false,
  }), {
    appliedPercent: 4825,
    experiencePerKill: 9_850_000,
    experiencePerHour: 394_000_000_000,
    experienceEssencePerHour: 39.4,
  });
  assert.deepEqual(calculator.DEFAULT_GROUNDS, [
    { id: 'forge', name: '대장간', baseXp: 200_000 },
    { id: 'golgotha', name: '골고다', baseXp: 720_000 },
    { id: 'void', name: '공허', baseXp: 980_000 },
  ]);
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'exp-heart')?.duration, '20분');
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'supreme-eos')?.percent, 500);
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'earlybird-exp')?.percent, 300);
  assert.equal(calculator.DEFAULT_DOPINGS.find(item => item.id === 'stray-cat-1-exp')?.percent, 30);

  const buffs = JSON.parse(read('src/assets/data/buffs.json')) as Array<{
    id: string; category: string; effect: string; duration: string; description: string; effects?: { exp?: number; rare?: number };
  }>;
  assert.equal(buffs.find(item => item.id === 'exp_heart')?.duration, '20분');
  assert.equal(buffs.find(item => item.id === 'exp_eos_supreme')?.effects?.exp, 500);
  assert.equal(buffs.find(item => item.id === 'exp_earlybird')?.effects?.exp, 300);
  assert.equal(buffs.find(item => item.id === 'exp_stamp')?.description.includes('500개'), true);
  assert.equal(buffs.find(item => item.id === 'exp_club_e2')?.effects?.exp, 200);
  assert.deepEqual(buffs.find(item => item.id === 'rare_lucky')?.effects, { rare: 30 });
  const buffPreviewIpc = read('src/modules/ipcHandlers.ts');
  assert.match(buffPreviewIpc, /ipcMain\.on\('buff-timer-test'/,
    '배포 빌드에서 버프 타이머 미리보기 IPC가 등록되지 않습니다.');
  assert.match(buffPreviewIpc, /ipcMain\.on\('buff-timer-clear-test'/,
    '배포 빌드에서 버프 타이머 미리보기 정리 IPC가 등록되지 않습니다.');
  assert.doesNotMatch(buffPreviewIpc, /if \(IS_DEV\) ipcMain\.on\('buff-timer-(?:test|clear-test)'/,
    '버프 타이머 미리보기가 개발 모드로 제한되어 있습니다.');

  const html = read('src/hunting-exp-calculator.html');
  const renderer = read('src/renderer/hunting-exp-calculator.ts');
  assert.match(html, /id="doping-list"/);
  assert.match(html, /id="ground-select"/);
  assert.match(html, /id="happy-hour-input"/);
  assert.match(html, /id="essence-per-hour"/);
  assert.match(html, /assets\/img\/경험의정수\.png/);
  assert.match(renderer, /assets\/img\/buffs\/경험의심장\.png/);
  assert.match(html, /shared\/huntingExpCalculator\.js/);
  assert.match(html, /renderer\/hunting-exp-calculator\.js/);
  assert.doesNotMatch(renderer, /innerHTML\s*=/,
    '사용자 도핑 또는 사냥터 이름이 innerHTML로 렌더링될 수 있습니다.');
  assert.match(renderer, /huntingExpDopings:\s*cloneDopings\(dopings\)/,
    '사용자 도핑 목록이 설정에 저장되지 않습니다.');
  assert.match(renderer, /huntingExpGrounds:\s*cloneGrounds\(grounds\)/,
    '사용자 사냥터 목록이 설정에 저장되지 않습니다.');

  const menuData = JSON.parse(read('src/assets/data/sidebar_menus.json')) as Array<{ id: string; api?: string; category?: string }>;
  assert.deepEqual(
    menuData.find(item => item.id === 'hunting-exp-calculator-btn'),
    {
      id: 'hunting-exp-calculator-btn', label: '사냥 경험치 계산기', icon: 'chart-no-axes-combined',
      tooltip: '사냥 도핑 및 예상 경험치 계산기', color: 'teal-400',
      api: 'toggleHuntingExpCalculator', category: 'calculators',
    },
  );
  assert.match(read('src/modules/ipcHandlers.ts'), /toggle-hunting-exp-calculator/);
  assert.match(read('src/preload.ts'), /toggleHuntingExpCalculator/);
  assert.match(read('src/modules/windowManager.ts'), /toggleHuntingExpCalculatorWindow/);
}

function checkRelicCalculator(): void {
  const calculator = require(path.join(projectRoot, 'dist/shared/relicCalculator.js')) as {
    RELIC_STAGES: Array<{ label: string }>;
    getEnhanceProbability(stage: number, difficulty: number): number;
    calculateExpectation(input: Record<string, unknown>): { attempts: number; seedMan: number; materials: Record<string, number>; evolutionMaterials: Record<string, number>; evolutions: number } | null;
    runSimulation(input: Record<string, unknown>, random: () => number): { attempts: number; seedMan: number; materials: Record<string, number>; evolutionMaterials: Record<string, number>; evolutions: number } | null;
  };
  assert.equal(calculator.RELIC_STAGES.length, 20);
  assert.equal(calculator.RELIC_STAGES[0].label, '신조의 렐릭 1강');
  assert.equal(calculator.RELIC_STAGES[19].label, '루나리아 렐릭 10강');
  assert.equal(calculator.getEnhanceProbability(0, 1), 0.2);
  assert.equal(calculator.getEnhanceProbability(0, 20), 0.54);
  assert.equal(calculator.getEnhanceProbability(2, 1), 0.1);
  assert.equal(calculator.getEnhanceProbability(3, 2), 0);
  assert.equal(calculator.getEnhanceProbability(19, 20), 0.2);
  const input = { side: 'right', currentStageIndex: 19, targetStageIndex: 19, difficulty: 20, currentStatTotal: 995 };
  assert.deepEqual(calculator.calculateExpectation(input), {
    attempts: 25, successes: 5, seedMan: 61250, materials: { '달의 파편': 750 }, evolutionMaterials: {}, evolutions: 0,
  });
  assert.deepEqual(calculator.runSimulation(input, () => 0), {
    attempts: 5, successes: 5, seedMan: 12250, materials: { '달의 파편': 150 }, evolutionMaterials: {}, evolutions: 0,
  });
  const evolution = calculator.calculateExpectation({ side: 'right', currentStageIndex: 9, targetStageIndex: 10, difficulty: 20, currentStatTotal: 500 });
  assert.equal(evolution?.evolutions, 1);
  assert.deepEqual(evolution?.evolutionMaterials, { '신조의 정수': 54 });
  assert.ok(Math.abs((evolution?.attempts || 0) - (50 / 0.34)) < 1e-9);
  assert.ok(Math.abs((evolution?.seedMan || 0) - (30000 + ((50 / 0.34) * 2000))) < 1e-6);
  const html = read('src/relic-calculator.html');
  const renderer = read('src/relic-calculator-renderer.ts');
  assert.match(html, /data-tab="simulation"/);
  assert.match(html, /data-tab="expectation"/);
  assert.match(html, /id="stat-inputs"/);
  assert.match(html, /펜던트 \(렐릭 오른쪽\)[\s\S]*?브라이슬릿 \(렐릭 왼쪽\)/,
    '렐릭 장비 종류가 게임 내 명칭으로 표시되지 않습니다.');
  assert.match(html, /shared\/relicCalculator\.js/);
  assert.match(renderer, /Math\.round\(seedMan \* 10_000\)/,
    'TSV의 만 단위 강화 비용을 실제 SEED로 환산하지 않습니다.');
  assert.match(renderer, /찌르기 공격력[\s\S]*?베기 공격력[\s\S]*?마법 공격력[\s\S]*?명중률 보정[\s\S]*?크리티컬/,
    '오른쪽 렐릭의 상세 능력치 입력이 없습니다.');
  assert.match(renderer, /물리 방어력[\s\S]*?마법 방어력[\s\S]*?회피율 보정[\s\S]*?민첩성 보정/,
    '왼쪽 렐릭의 상세 능력치 입력이 없습니다.');
  const menus = JSON.parse(read('src/assets/data/sidebar_menus.json')) as Array<{ id: string; api?: string; category?: string }>;
  assert.deepEqual(menus.find(item => item.id === 'relic-calculator-btn'), {
    id: 'relic-calculator-btn', label: '렐릭 강화', icon: 'gem', tooltip: '렐릭 강화 시뮬레이션 및 기댓값 조회',
    color: 'indigo-400', api: 'toggleRelicCalculator', category: 'calculators',
  });
  assert.match(read('src/modules/ipcHandlers.ts'), /toggle-relic-calculator/);
  assert.match(read('src/preload.ts'), /toggleRelicCalculator/);
  assert.match(read('src/modules/windowManager.ts'), /toggleRelicCalculatorWindow/);
}

function checkEquipmentSimulator(): void {
  const sim = require(path.join(projectRoot, 'dist/shared/equipmentSimulator.js')) as {
    ENHANCE_RATES: readonly any[];
    FIXED_ENCHANT_SCROLL_PRESETS: readonly any[];
    INCRYPT_SCROLLS: Record<string, any>;
    calculateEnhanceExpectation: (opts: any) => any;
    calculateEnchantExpectation: (opts: any) => any;
    calculateIncryptExpectation: (opts: any, target: number) => any;
  };
  assert.equal(sim.ENHANCE_RATES.length, 20);
  assert.equal(sim.ENHANCE_RATES[0].baseSuccessRate, 1.0);
  assert.equal(sim.ENHANCE_RATES[6].baseSuccessRate, 0.07);
  assert.equal(sim.ENHANCE_RATES[7].penaltyType, 'minus1');
  assert.ok(sim.FIXED_ENCHANT_SCROLL_PRESETS.length >= 10);
  assert.equal(sim.INCRYPT_SCROLLS.lord.successRate, 0.21);
  assert.equal(sim.INCRYPT_SCROLLS.royal.successRate, 0.36);

  const enhanceExp = sim.calculateEnhanceExpectation({ startStage: 0, targetStage: 2, luckyStoneCount: 0, talismanCount: 0, costPerStage: [1000, 2000] });
  assert.equal(enhanceExp.expectedAttempts, 1 + 1 / 0.7);
  assert.equal(enhanceExp.stageStats[0].stepExpectedAttempts, 1);
  assert.equal(enhanceExp.stageStats[0].stepFeeCost, 1000);
  assert.equal(enhanceExp.stageStats[1].stepFeeCost, (1 / 0.7) * 2000);
  assert.equal(enhanceExp.stageStats[0].cumulativeAttempts, 1);
  assert.ok(enhanceExp.stageStats[1].stepExpectedAttempts > 1);

  const enchantExp = sim.calculateEnchantExpectation({ statType: 'stab', enhanceScrollCount: 5 });
  assert.ok(enchantExp.expectedAttemptsPerSuccess > 0);
  assert.ok(enchantExp.expectedStatGainPerSuccess >= 4);

  // [+8] 축복치 없음 고정 주문서 (2% 확률, 축복치 0% -> 기댓값 50회)
  const noBlessExp = sim.calculateEnchantExpectation({ statType: 'stab', enhanceScrollCount: 0, baseSuccessRate: 0.02, blessingGainOnFail: 0.0, fixedStatGain: 8 });
  assert.equal(noBlessExp.expectedAttemptsPerSuccess, 50);
  assert.equal(noBlessExp.expectedStatGainPerSuccess, 8);

  const incryptExp = sim.calculateIncryptExpectation({ scrollType: 'lord', protectionScrollCount: 60 }, 1);
  assert.ok(incryptExp.expectedAttemptsPerSuccess > 0);

  const html = read('src/equipment-simulator.html');
  const renderer = read('src/renderer/equipment-simulator.ts');
  assert.match(html, /data-main-tab="enhance"/);
  assert.match(html, /data-main-tab="enchant"/);
  assert.match(html, /data-main-tab="incrypt"/);
  assert.match(html, /id="enchant-preset-select"/);
  assert.match(html, /shared\/equipmentSimulator\.js/);
  assert.match(html, /renderer\/equipment-simulator\.js/);

  const menus = JSON.parse(read('src/assets/data/sidebar_menus.json')) as Array<{ id: string; api?: string; category?: string }>;
  assert.ok(menus.find(item => item.id === 'equipment-simulator-btn'));
  assert.match(read('src/modules/ipcHandlers.ts'), /toggle-equipment-simulator/);
  assert.match(read('src/preload.ts'), /toggleEquipmentSimulator/);
  assert.match(read('src/modules/windowManager.ts'), /toggleEquipmentSimulatorWindow/);
}

function checkResponsiveDockFlyouts(): void {
  const dock = read('src/dock.html');
  assert.match(dock, /\.dock-flyout-submenu\s*\{[\s\S]*?max-width:\s*calc\(100vw - 24px\)/,
    '독 펼침 메뉴의 최대 너비가 독 창 영역으로 제한되지 않습니다.');
  assert.match(dock, /\.dock-flyout-submenu\s*\{[\s\S]*?flex-wrap:\s*wrap/,
    '독 펼침 메뉴가 공간 부족 시 여러 줄로 배치되지 않습니다.');
  assert.match(dock, /function fitFlyoutToViewport\(flyout\)[\s\S]*?getBoundingClientRect\(\)[\s\S]*?--dock-flyout-shift/,
    '독 펼침 메뉴의 좌우 경계 보정이 없습니다.');
  assert.match(dock, /catItem\.addEventListener\('mouseenter', \(\) => fitFlyoutToViewport\(flyout\)\)/,
    '독 펼침 메뉴를 열 때 경계 보정이 실행되지 않습니다.');
}

function checkUpdateNoticeFeature(): void {
  const noticePath = path.join(projectRoot, 'src', 'assets', 'notice', 'notice.json');
  const packagePath = path.join(projectRoot, 'package.json');
  assert.ok(fs.existsSync(noticePath), 'src/assets/notice/notice.json 파일이 존재하지 않습니다.');
  const noticeData = JSON.parse(fs.readFileSync(noticePath, 'utf-8'));
  const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
  assert.ok(typeof noticeData.version === 'string' && noticeData.version.length > 0, 'notice.json에 유효한 version이 없습니다.');
  assert.equal(noticeData.version, packageData.version, 'notice.json과 package.json의 배포 버전이 일치하지 않습니다.');
  assert.ok(typeof noticeData.title === 'string' && noticeData.title.length > 0, 'notice.json에 유효한 title이 없습니다.');
  assert.ok(Array.isArray(noticeData.sections) && noticeData.sections.length > 0, 'notice.json에 유효한 sections가 없습니다.');
  assert.ok(Array.isArray(noticeData.images), 'notice.json의 images는 배열이어야 합니다.');
  assert.equal(new Set(noticeData.images).size, noticeData.images.length, 'notice.json에 중복된 이미지가 있습니다.');
  for (const imageName of noticeData.images) {
    assert.match(imageName, /^notice_\d+\.(png|jpe?g|webp|gif)$/i, `공지 이미지 파일명이 허용 형식이 아닙니다: ${imageName}`);
    const imagePath = path.join(path.dirname(noticePath), imageName);
    assert.ok(fs.existsSync(imagePath), `notice.json이 존재하지 않는 이미지를 참조합니다: ${imageName}`);
    assert.ok(fs.statSync(imagePath).size > 0, `공지 이미지 파일이 비어 있습니다: ${imageName}`);
  }

  const updateNoticeHtml = read('src/update-notice.html');
  assert.match(updateNoticeHtml, /getUpdateNoticeData/, 'update-notice.html에서 공지 데이터를 조회하는 코드가 없습니다.');
  assert.match(updateNoticeHtml, /updateNoticeClose/, 'update-notice.html에서 닫기 이벤트 핸들러가 연결되지 않았습니다.');
  assert.match(updateNoticeHtml, /confirm-btn/, 'update-notice.html에 확인 버튼이 없습니다.');

  const ipcHandlers = read('src/modules/ipcHandlers.ts');
  assert.match(ipcHandlers, /get-update-notice-data/, 'ipcHandlers에 get-update-notice-data 채널이 없습니다.');
  assert.match(ipcHandlers, /update-notice-close/, 'ipcHandlers에 update-notice-close 채널이 없습니다.');
  assert.match(ipcHandlers, /update-notice-open/, 'ipcHandlers에 update-notice-open 채널이 없습니다.');

  const preload = read('src/preload.ts');
  assert.match(preload, /getUpdateNoticeData/, 'preload에 getUpdateNoticeData API가 없습니다.');
  assert.match(preload, /updateNoticeClose/, 'preload에 updateNoticeClose API가 없습니다.');
  assert.match(preload, /updateNoticeOpen/, 'preload에 updateNoticeOpen API가 없습니다.');

  const settings = read('src/settings.html');
  assert.match(settings, /openUpdateNotice\(\)/, 'settings.html에 공지 열기 버튼 함수가 없습니다.');

  const workflow = read('.agents/release_workflow.md');
  assert.match(workflow, /src\/assets\/notice\/notice\.json/, 'release_workflow.md에 공지 갱신 절차가 누락되었습니다.');
}

checkCommonFormatters();
checkAnalyticsProtocol();
checkDevtoolsInitializationIsIdempotent();
checkInlineScriptSyntax();
checkPageScriptNamespaceCollisions();
checkHtmlScriptResourcesAndHandlers();
function checkChatLogSyncManagerContracts() {
  const { getRecentMonday, parseChatLogFileDate } = require('../dist/modules/chatLogSyncManager');
  const diaryDb = require('../dist/modules/diaryDb');

  // 1. 월요일 날짜 계산 검증
  // 2026-08-16은 일요일 -> 2026-08-10(월)
  const sunday = new Date(2026, 7, 16, 15, 30, 0);
  const monFromSun = getRecentMonday(sunday);
  assert.equal(monFromSun.getFullYear(), 2026);
  assert.equal(monFromSun.getMonth(), 7);
  assert.equal(monFromSun.getDate(), 10);
  assert.equal(monFromSun.getHours(), 0);

  // 2026-08-17은 월요일 -> 2026-08-17(월)
  const monday = new Date(2026, 7, 17, 10, 0, 0);
  const monFromMon = getRecentMonday(monday);
  assert.equal(monFromMon.getDate(), 17);

  // 2026-08-19는 수요일 -> 2026-08-17(월)
  const wednesday = new Date(2026, 7, 19, 23, 59, 0);
  const monFromWed = getRecentMonday(wednesday);
  assert.equal(monFromWed.getDate(), 17);

  assert.equal(parseChatLogFileDate('TWChatLog_2026_08_25.html')?.dateStr, '2026-08-25');
  assert.equal(parseChatLogFileDate('TWChatLog_2024_02_29.html')?.dateStr, '2024-02-29');
  assert.equal(parseChatLogFileDate('TWChatLog_2026_02_29.html'), null);
  assert.equal(parseChatLogFileDate('TWChatLog_2026_08_32.html'), null);
  assert.equal(parseChatLogFileDate('TWChatLog_2026_13_01.html'), null);

  // 2. diaryDb 중복 방지 멱등성 검증
  try {
    diaryDb.initDb();
    const testDate = '2099-12-31';
    const testTime = '23:59:59';
    const testContent = '[득템] 테스트 동기화 아이템';

    const firstAdd = diaryDb.addActivityLogIfAbsent(testDate, testTime, 'loot', testContent, 1, false);
    assert.equal(firstAdd, true, '최초 활동 기록 추가는 true여야 합니다.');

    const secondAdd = diaryDb.addActivityLogIfAbsent(testDate, testTime, 'loot', testContent, 1, false);
    assert.equal(secondAdd, false, '중복 활동 기록 추가는 false(스킵)여야 합니다.');

    const exists = diaryDb.hasActivityLog(testDate, testTime, testContent);
    assert.equal(exists, true, 'hasActivityLog가 true를 반환해야 합니다.');

    const manualContent = '수동 중복 아이템';
    const firstManualId = diaryDb.addManualActivityLog(testDate, '23:58:00', 'loot', manualContent, 1);
    const secondManualId = diaryDb.addManualActivityLog(testDate, '23:58:01', 'loot', manualContent, 2);
    assert.ok(Number.isSafeInteger(firstManualId) && Number.isSafeInteger(secondManualId));
    assert.equal(diaryDb.getDiaryByDate(testDate, []).activityLogs
      .filter((log: { type: string }) => log.type === 'loot').length, 2,
    '등록 아이템이 없어도 사용자가 직접 추가한 득템은 표시되어야 합니다.');
    assert.equal(diaryDb.getDiaryByDate(testDate, ['테스트 동기화 아이템']).activityLogs
      .filter((log: { type: string }) => log.type === 'loot').length, 3,
    '등록된 자동 득템과 수동 득템이 함께 표시되지 않습니다.');
    assert.equal(diaryDb.removeManualActivityLogById(firstManualId), true,
      '수동 기록을 row ID로 삭제하지 못했습니다.');
    const remainingManual = diaryDb.getDiaryByDate(testDate).activityLogs
      .filter((log: { content: string }) => log.content === manualContent);
    assert.equal(remainingManual.length, 1, '동일 내용의 다른 수동 기록까지 함께 삭제되었습니다.');
    assert.equal(remainingManual[0].id, secondManualId);
    assert.equal(remainingManual[0].source, 'manual');
    assert.equal(diaryDb.removeManualActivityLogById(secondManualId), true);

    const magicContent = '[득템] [하급 마정석]';
    assert.equal(diaryDb.addActivityLogIfAbsent(testDate, '23:57:00', 'loot', magicContent, 5_000, false), true);
    assert.equal(diaryDb.getDiaryByDate(testDate, ['테스트 동기화 아이템']).activityLogs
      .some((log: { content: string }) => log.content === magicContent), false,
    '등록 해제한 과거 마정석 기록이 모험일지에 표시됩니다.');
    const visibleSummary = diaryDb.getMonthlySummary('2099-12', ['테스트 동기화 아이템', '하급 마정석']);
    assert.equal(visibleSummary.lootList.some((log: { content: string }) => log.content === magicContent), true,
      '등록한 마정석 과거 기록이 다시 표시되지 않습니다.');
    assert.equal(visibleSummary.totalLoots, 1,
      '마정석 수량이 일반 득템 합계를 오염시킵니다.');
    assert.equal(diaryDb.getLootHistory(testDate, testDate, ['테스트 동기화 아이템']).length, 1,
      '득템 전용 목록이 등록 해제한 기록을 제외하지 않습니다.');
    diaryDb.removeActivityLog(testDate, 'loot', magicContent);
    assert.equal(diaryDb.getDiaryByDate(testDate).activityLogs
      .some((log: { content: string }) => log.content === magicContent), false);

    const essenceContent = '[득템] 경험의 정수';
    assert.equal(diaryDb.addActivityLogIfAbsent(testDate, '23:56:00', 'loot', essenceContent, 2, false), true);
    assert.equal(diaryDb.getDiaryByDate(testDate, []).activityLogs
      .some((log: { content: string; amount: number }) => log.content === essenceContent && log.amount === 2), true,
    '경험의 정수가 일반 득템 등록 목록에서 빠졌다는 이유로 모험일지에서 숨겨집니다.');
    assert.equal(diaryDb.getMonthlyStatistics('2099-12', []).totalEssences, 2,
      '등록 목록과 무관한 경험의 정수 월간 집계가 누락됩니다.');
    const essenceMonthlySummary = diaryDb.getMonthlySummary('2099-12', []);
    assert.equal(essenceMonthlySummary.lootList.some(
      (log: { content: string }) => log.content === essenceContent), false,
    '경험의 정수가 통계 탭의 이번 달 누적 득템 리스트에 표시됩니다.');
    assert.equal(essenceMonthlySummary.calendarLootList.some(
      (log: { content: string; amount: number }) => log.content === essenceContent && log.amount === 2), true,
    '누적 득템 리스트를 분리하면서 활동 달력의 경험의 정수 기록까지 사라졌습니다.');
    assert.equal(diaryDb.getLootHistory(testDate, testDate, [])
      .some((log: { content: string; amount: number }) => log.content === essenceContent && log.amount === 2), false,
    '일반 득템 설정 대상이 아닌 경험의 정수가 득템 전용 탭에 표시됩니다.');
    assert.equal(diaryDb.getLootHistory(testDate, testDate, ['경험의 정수'])
      .some((log: { content: string }) => log.content === essenceContent), false,
    '비정상 설정에 경험의 정수가 들어가도 득템 전용 탭에서는 숨겨야 합니다.');
    diaryDb.removeActivityLog(testDate, 'loot', essenceContent);

    const sameSecondEssenceDate = '2099-12-29';
    const sameSecondEssenceBatch = {
      loots: [],
      essences: [
        { eventId: 'same-second-essence-1', date: sameSecondEssenceDate, timeOnly: '12:34:56', diaryContent: essenceContent, count: 1 },
        { eventId: 'same-second-essence-2', date: sameSecondEssenceDate, timeOnly: '12:34:56', diaryContent: essenceContent, count: 1 },
      ],
      seeds: [], elsoPoints: [], shouts: [],
    };
    const sameSecondFirst = diaryDb.batchInsertSyncResults(sameSecondEssenceBatch);
    assert.equal(sameSecondFirst.success, true);
    assert.equal(sameSecondFirst.essencesAdded, 2,
      '같은 초에 연속 지급된 경험의 정수 두 건이 과거 로그 복원에서 한 건으로 합쳐졌습니다.');
    assert.equal(diaryDb.getDiaryByDate(sameSecondEssenceDate, []).activityLogs
      .filter((log: { content: string }) => log.content === essenceContent)
      .reduce((sum: number, log: { amount: number }) => sum + log.amount, 0), 2);
    const sameSecondReplay = diaryDb.batchInsertSyncResults(sameSecondEssenceBatch);
    assert.equal(sameSecondReplay.essencesAdded, 0,
      '같은 과거 로그 배치를 다시 처리했을 때 경험의 정수가 중복 기록되었습니다.');
    assert.equal(diaryDb.getDiaryByDate(sameSecondEssenceDate, []).activityLogs
      .filter((log: { content: string }) => log.content === essenceContent)
      .reduce((sum: number, log: { amount: number }) => sum + log.amount, 0), 2);
    diaryDb.removeActivityLog(sameSecondEssenceDate, 'loot', essenceContent);

    const automaticLog = diaryDb.getDiaryByDate(testDate).activityLogs
      .find((log: { content: string }) => log.content === testContent);
    assert.equal(automaticLog?.source, 'automatic');
    assert.equal(diaryDb.removeManualActivityLogById(automaticLog.id), false,
      '자동 감지 기록이 수동 삭제 API로 삭제되었습니다.');

    assert.equal(diaryDb.addHomeworkLog(testDate, 'test-homework', '이전 이름', '이전 분류', 'daily', 1_000), true);
    assert.equal(diaryDb.addHomeworkLog(testDate, 'test-homework', '최신 이름', '최신 분류', 'weekly', 2_000), true);
    const updatedHomework = diaryDb.getDiaryByDate(testDate).homeworkLogs
      .filter((log: { content_id: string }) => log.content_id === 'test-homework');
    assert.equal(updatedHomework.length, 1, '초기화권 재완료가 별도 숙제 행으로 중복 저장되었습니다.');
    assert.deepEqual(
      {
        name: updatedHomework[0].content_name,
        category: updatedHomework[0].category,
        type: updatedHomework[0].type,
        completedAt: updatedHomework[0].completed_at,
      },
      { name: '최신 이름', category: '최신 분류', type: 'weekly', completedAt: 2_000 },
      '숙제 재완료 시 최신 완료 시각과 메타데이터가 함께 갱신되지 않았습니다.',
    );
    assert.equal(diaryDb.removeHomeworkLog(testDate, 'test-homework'), true);

    // 공개 DB 쓰기 API는 트랜잭션 실패를 성공처럼 보고하거나 예외로 앱까지 전파하지 않아야 한다.
    const BoundaryDatabase = require('better-sqlite3');
    const boundaryDb = new BoundaryDatabase(path.join(isolatedUserData, 'diary.db'));
    boundaryDb.exec(`
      CREATE TRIGGER regression_fail_homework_insert
      BEFORE INSERT ON homework_logs
      WHEN NEW.content_id = 'failure-homework'
      BEGIN SELECT RAISE(ABORT, 'forced homework write failure'); END;

      CREATE TRIGGER regression_fail_homework_stats
      BEFORE UPDATE ON diaries
      WHEN NEW.date = '2099-12-26'
      BEGIN SELECT RAISE(ABORT, 'forced homework stats failure'); END;

      CREATE TRIGGER regression_fail_alarm_log
      BEFORE INSERT ON alarm_logs
      WHEN NEW.title = 'failure-alarm'
      BEGIN SELECT RAISE(ABORT, 'forced alarm write failure'); END;

      CREATE TRIGGER regression_fail_word_alarm
      BEFORE INSERT ON word_alarm_history
      WHEN NEW.keyword = 'failure-keyword'
      BEGIN SELECT RAISE(ABORT, 'forced word alarm failure'); END;

      CREATE TRIGGER regression_fail_shout
      BEFORE INSERT ON shout_history
      WHEN NEW.sender = 'failure-sender'
      BEGIN SELECT RAISE(ABORT, 'forced shout write failure'); END;
    `);
    assert.equal(
      diaryDb.addHomeworkLog('2099-12-26', 'failure-homework', '실패 숙제', '테스트', 'daily', 3_000),
      false,
      '실패한 숙제 로그 쓰기가 성공으로 보고되었습니다.',
    );
    assert.equal(
      diaryDb.updateHomeworkStats('2099-12-26', 1, 2, 3, 4),
      false,
      '실패한 숙제 통계 쓰기가 성공으로 보고되었습니다.',
    );
    assert.equal(diaryDb.addAlarmLog('etc', 'failure-alarm', '실패 검증'), false,
      '실패한 알람 이력 쓰기가 성공으로 보고되었습니다.');
    assert.equal(diaryDb.addWordAlarmHistory('failure-keyword', '테스터', '실패 검증', []), -1,
      '실패한 지정 단어 이력이 유효한 row ID를 반환했습니다.');
    assert.equal(diaryDb.addShoutLog('failure-sender', '실패 검증'), false,
      '실패한 외치기 이력 쓰기가 성공으로 보고되었습니다.');
    boundaryDb.exec(`
      DROP TRIGGER regression_fail_homework_insert;
      DROP TRIGGER regression_fail_homework_stats;
      DROP TRIGGER regression_fail_alarm_log;
      DROP TRIGGER regression_fail_word_alarm;
      DROP TRIGGER regression_fail_shout;
    `);

    const missedScheduledAt = Date.now() - 60_000;
    const missedRecordedAt = Date.now();
    const missedDedupeKey = 'regression:missed-sleep:boss';
    const missedMetadata = {
      scheduledAt: missedScheduledAt,
      recordedAt: missedRecordedAt,
      deliveryStatus: 'missed-sleep' as const,
      dedupeKey: missedDedupeKey,
    };
    assert.equal(diaryDb.addAlarmLog('boss', '절전 중 놓친 알람', '멱등 기록', missedMetadata), true);
    assert.equal(diaryDb.addAlarmLog('boss', '절전 중 놓친 알람', '멱등 기록', missedMetadata), true,
      '동일 missed-sleep 안정 키 재기록이 실패로 보고되었습니다.');
    const missedRows = diaryDb.getAlarmLogs(200)
      .filter((row: { dedupeKey?: string }) => row.dedupeKey === missedDedupeKey);
    assert.equal(missedRows.length, 1, '동일 missed-sleep 안정 키가 중복 저장되었습니다.');
    assert.deepEqual(
      {
        scheduledAt: missedRows[0].scheduledAt,
        recordedAt: missedRows[0].recordedAt,
        deliveryStatus: missedRows[0].deliveryStatus,
      },
      { scheduledAt: missedScheduledAt, recordedAt: missedRecordedAt, deliveryStatus: 'missed-sleep' },
    );
    boundaryDb.prepare('DELETE FROM alarm_logs WHERE dedupe_key = ?').run(missedDedupeKey);

    const legacyAlarmDb = new BoundaryDatabase(':memory:');
    legacyAlarmDb.exec(`
      CREATE TABLE alarm_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL
      );
      INSERT INTO alarm_logs (timestamp, type, title, message)
      VALUES (123456, 'etc', '레거시', '레거시 알람');
    `);
    diaryDb.migrateAlarmLogsV4(legacyAlarmDb);
    diaryDb.migrateAlarmLogsV4(legacyAlarmDb);
    const migratedAlarm = legacyAlarmDb.prepare(`
      SELECT scheduled_at, recorded_at, delivery_status, dedupe_key
      FROM alarm_logs
    `).get();
    assert.deepEqual(
      { ...migratedAlarm },
      { scheduled_at: 123456, recorded_at: 123456, delivery_status: 'fired', dedupe_key: null },
      '레거시 알람 이력의 구조화 메타데이터 backfill이 정확하지 않습니다.',
    );
    const migratedColumns = legacyAlarmDb.prepare('PRAGMA table_info(alarm_logs)').all()
      .map((column: { name: string }) => column.name);
    assert.ok(['scheduled_at', 'recorded_at', 'delivery_status', 'dedupe_key']
      .every(column => migratedColumns.includes(column)));
    legacyAlarmDb.close();

    // 5초 버킷이 아니라 실시간 삽입과 같은 실제 시간 차로 레거시 외치기를 정리해야 한다.
    const shoutBaseTimestamp = 4_102_444_000;
    const insertLegacyShout = boundaryDb.prepare(
      'INSERT INTO shout_history (timestamp, sender, message) VALUES (?, ?, ?)',
    );
    insertLegacyShout.run(shoutBaseTimestamp, 'dedupe-sender', 'dedupe-message');
    insertLegacyShout.run(shoutBaseTimestamp + 4, 'dedupe-sender', 'dedupe-message');
    insertLegacyShout.run(shoutBaseTimestamp + 8, 'dedupe-sender', 'dedupe-message');
    diaryDb.deduplicateShoutHistory();
    const deduplicatedShouts = diaryDb.getShoutHistory(24 * 365 * 100)
      .filter((row: { sender: string }) => row.sender === 'dedupe-sender')
      .map((row: { timestamp: number }) => row.timestamp)
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(deduplicatedShouts, [shoutBaseTimestamp, shoutBaseTimestamp + 8],
      '레거시 외치기 정리가 실제 마지막 보존 행 기준 ±5초 계약과 다릅니다.');

    boundaryDb.close();

    const contentsSource = read('src/modules/contentsChecker.ts');
    assert.match(contentsSource, /runDiaryWriteWithRetry\(`homework-log:/,
      '숙제 일지 쓰기 실패의 제한 재시도 경계가 없습니다.');
    assert.match(contentsSource, /pendingDiaryWriteRetries\.get\(key\) !== state/,
      '이전 숙제 쓰기 재시도가 최신 완료·해제 상태를 덮을 수 있습니다.');
    assert.match(read('src/main.ts'), /contentsChecker\.cancelPendingDiaryWriteRetries\(\)/,
      '종료 중 숙제 일지 재시도 타이머를 취소하지 않습니다.');

    const grounds = diaryDb.getHuntingGrounds() as Array<{ id: string; name: string; image_path: string }>;
    assert.deepEqual(
      grounds.filter(ground => ['forge', 'golgotha', 'void'].includes(ground.id))
        .map(ground => ground.id).sort(),
      ['forge', 'golgotha', 'void'],
      '신규 DB에 사냥터 동선 기본 지도 3개가 생성되지 않았습니다.',
    );
    assert.equal(grounds.find(ground => ground.id === 'forge')?.name, '시오칸하임 대장간');
    assert.equal(grounds.find(ground => ground.id === 'golgotha')?.image_path, 'assets/img/field-map/골고다의협곡.png');

    const diaryDbSource = read('src/modules/diaryDb.ts');
    assert.match(diaryDbSource, /INSERT OR IGNORE INTO hunting_grounds/,
      '기본 지도가 기존 사용자 행을 덮어쓸 수 있습니다.');
    assert.match(diaryDbSource, /Version 2 migration completed/);

    assert.equal(diaryDb.parseMigrationNumber('1조'), 1_000_000_000_000);
    assert.equal(diaryDb.parseMigrationNumber('1조 2억 3만'), 1_000_200_030_000);
    assert.equal(diaryDb.parseMigrationNumber('1,234'), 1_234);

    // 배치 중 후반부 쓰기가 실패하면 앞서 증가한 성공 카운터와 DB 변경이 모두 롤백되어야 한다.
    const rollbackDate = '2099-12-30';
    const rollbackContent = '[득템] 롤백 검증 아이템';
    const failedBatch = diaryDb.batchInsertSyncResults({
      loots: [{ date: rollbackDate, timeOnly: '23:59:58', diaryContent: rollbackContent, count: 1 }],
      essences: [],
      seeds: [],
      elsoPoints: [],
      shouts: [{ fullTimestamp: 4_102_444_798, sender: null, message: 'NOT NULL 실패 유도' }],
    });
    assert.equal(failedBatch.success, false, '롤백된 배치가 성공으로 보고되었습니다.');
    assert.deepEqual(
      {
        lootsAdded: failedBatch.lootsAdded,
        essencesAdded: failedBatch.essencesAdded,
        seedsAdded: failedBatch.seedsAdded,
        elsoPointsAdded: failedBatch.elsoPointsAdded,
        shoutsAdded: failedBatch.shoutsAdded,
      },
      { lootsAdded: 0, essencesAdded: 0, seedsAdded: 0, elsoPointsAdded: 0, shoutsAdded: 0 },
      '롤백된 배치가 중간 성공 건수를 반환했습니다.',
    );
    assert.equal(diaryDb.hasActivityLog(rollbackDate, '23:59:58', rollbackContent), false,
      '배치 실패 전에 삽입된 활동 기록이 롤백되지 않았습니다.');

    // 동일한 엘소 recovery operation을 재생해도 DB에는 정확히 한 번만 반영되어야 한다.
    const elsoRecoveryDate = '2099-12-27';
    const elsoJournalPath = diaryDb.getElsoRecoveryJournalPath();
    const elsoJournal = {
      schemaVersion: 1,
      operationId: 'regression-elso-operation-001',
      createdAt: Date.now(),
      entries: [{ date: elsoRecoveryDate, latestTime: '23:59:56', totalAmount: 321 }],
    };
    fs.writeFileSync(elsoJournalPath, JSON.stringify(elsoJournal), 'utf8');
    assert.equal(diaryDb.replayElsoRecoveryJournal(), true);
    let recoveredElso = diaryDb.getDiaryByDate(elsoRecoveryDate).activityLogs
      .find((log: { type: string }) => log.type === 'elso');
    assert.equal(recoveredElso?.amount, 321);

    fs.writeFileSync(elsoJournalPath, JSON.stringify(elsoJournal), 'utf8');
    assert.equal(diaryDb.replayElsoRecoveryJournal(), true);
    recoveredElso = diaryDb.getDiaryByDate(elsoRecoveryDate).activityLogs
      .find((log: { type: string }) => log.type === 'elso');
    assert.equal(recoveredElso?.amount, 321,
      '이미 커밋된 엘소 recovery operation이 중복 반영되었습니다.');
    assert.equal(fs.existsSync(elsoJournalPath), false);
    diaryDb.removeActivityLog(elsoRecoveryDate, 'elso', '엘소 포인트 획득');

    // 동일 시각의 금화 주머니 여러 건도 빠짐없이 날짜별 단일 SEED 행으로 누적되어야 한다.
    const goldPouchDate = '2099-12-26';
    diaryDb.addGoldPouchSeed(goldPouchDate, '12:34:56', 500_000);
    diaryDb.addGoldPouchSeed(goldPouchDate, '12:34:56', 500_000);
    assert.equal(diaryDb.flushPendingGoldPouchSeed(), true);
    let goldPouchRows = diaryDb.getDiaryByDate(goldPouchDate).activityLogs
      .filter((log: { type: string; content: string }) => log.type === 'calc' && log.content === diaryDb.GOLD_POUCH_DAILY_CONTENT);
    assert.equal(goldPouchRows.length, 1);
    assert.equal(goldPouchRows[0].amount, 1_000_000,
      '동일 시각의 금화 주머니 두 건이 하나의 이벤트로 합쳐졌습니다.');

    // 과거 로그 재탐색은 DB보다 작거나 같은 값으로 덮지 않고, 더 큰 전체 합계만 채택한다.
    diaryDb.batchInsertSyncResults({
      loots: [], essences: [], seeds: [], elsoPoints: [], shouts: [],
      goldPouchSeeds: [{ date: goldPouchDate, timeOnly: '12:35:00', amount: 500_000 }],
    });
    assert.equal(diaryDb.getDiaryByDate(goldPouchDate).activityLogs
      .find((log: { content: string }) => log.content === diaryDb.GOLD_POUCH_DAILY_CONTENT)?.amount, 1_000_000);
    diaryDb.batchInsertSyncResults({
      loots: [], essences: [], seeds: [], elsoPoints: [], shouts: [],
      goldPouchSeeds: [{ date: goldPouchDate, timeOnly: '12:36:00', amount: 1_500_000 }],
    });
    goldPouchRows = diaryDb.getDiaryByDate(goldPouchDate).activityLogs
      .filter((log: { type: string; content: string }) => log.type === 'calc' && log.content === diaryDb.GOLD_POUCH_DAILY_CONTENT);
    assert.equal(goldPouchRows.length, 1);
    assert.equal(goldPouchRows[0].amount, 1_500_000);

    // 응답 유실 뒤 같은 recovery operation이 재생돼도 금액은 정확히 한 번만 증가한다.
    const goldPouchJournalPath = diaryDb.getGoldPouchRecoveryJournalPath();
    const goldPouchJournal = {
      schemaVersion: 1,
      operationId: 'regression-gold-pouch-operation-001',
      createdAt: Date.now(),
      entries: [{ date: goldPouchDate, latestTime: '12:37:00', totalAmount: 500_000 }],
    };
    fs.writeFileSync(goldPouchJournalPath, JSON.stringify(goldPouchJournal), 'utf8');
    assert.equal(diaryDb.replayGoldPouchRecoveryJournal(), true);
    fs.writeFileSync(goldPouchJournalPath, JSON.stringify(goldPouchJournal), 'utf8');
    assert.equal(diaryDb.replayGoldPouchRecoveryJournal(), true);
    assert.equal(diaryDb.getDiaryByDate(goldPouchDate).activityLogs
      .find((log: { content: string }) => log.content === diaryDb.GOLD_POUCH_DAILY_CONTENT)?.amount, 2_000_000);
    assert.equal(fs.existsSync(goldPouchJournalPath), false);
    diaryDb.removeActivityLog(goldPouchDate, 'calc', diaryDb.GOLD_POUCH_DAILY_CONTENT);

    // 테스트 후 데이터 정리 및 DB 파일 닫기
    diaryDb.removeActivityLog(testDate, 'loot', testContent);
    if (typeof diaryDb.closeDb === 'function') {
      diaryDb.closeDb();
    }

    // v2 DB에서 잘못 저장된 단위 금액만 v3 마이그레이션이 원문 기준으로 복구하는지 검증한다.
    const migrationDate = '2099-12-29';
    const migrationDbPath = path.join(isolatedUserData, 'diary.db');
    const MigrationDatabase = require('better-sqlite3');
    const migrationDb = new MigrationDatabase(migrationDbPath);
    migrationDb.prepare('INSERT OR IGNORE INTO diaries (date) VALUES (?)').run(migrationDate);
    migrationDb.prepare(`
      INSERT INTO activity_logs (date, type, content, time, amount, source)
      VALUES (?, 'calc', ?, '23:59:57', 1, 'legacy-unknown')
    `).run(migrationDate, '[자동] 복구 검증 (1조 2억 3만)');
    migrationDb.pragma('user_version = 2');
    migrationDb.close();

    diaryDb.initDb();
    const repairedLog = diaryDb.getDiaryByDate(migrationDate).activityLogs
      .find((log: { content: string }) => log.content.includes('복구 검증'));
    assert.equal(repairedLog?.amount, 1_000_200_030_000,
      'v2 DB의 조/억/만 단위 금액이 원문 기준으로 복구되지 않았습니다.');
    diaryDb.removeActivityLog(migrationDate, 'calc', '[자동] 복구 검증 (1조 2억 3만)');
    diaryDb.closeDb();

    // v5 사용자가 기존 UI로 저장한 amount=0 수동 수익은 v6에서만 정확히 1회 복구되어야 한다.
    const manualRevenueDb = new MigrationDatabase(migrationDbPath);
    manualRevenueDb.prepare(`
      INSERT INTO activity_logs (date, type, content, time, amount, source)
      VALUES (?, 'calc', ?, '23:59:58', 0, 'manual')
    `).run(migrationDate, '💰 수익: 장사 수익 (12억 3,456만 시드)');
    manualRevenueDb.pragma('user_version = 5');
    manualRevenueDb.close();

    diaryDb.initDb();
    const repairedManualRevenue = diaryDb.getDiaryByDate(migrationDate).activityLogs
      .find((log: { content: string }) => log.content.includes('장사 수익'));
    assert.equal(repairedManualRevenue?.amount, 1_234_560_000,
      'v5 DB의 기존 수동 장사 수익 amount가 표시 문구에서 복구되지 않았습니다.');
    diaryDb.removeActivityLog(migrationDate, 'calc', '💰 수익: 장사 수익 (12억 3,456만 시드)');
    diaryDb.closeDb();

    // v1 중간 단계에서 강제 실패시 앞선 지도 변경과 user_version 상승이 함께 롤백되어야 한다.
    const atomicDate = '2099-12-28';
    const atomicDb = new MigrationDatabase(migrationDbPath);
    atomicDb.prepare('INSERT OR IGNORE INTO diaries (date) VALUES (?)').run(atomicDate);
    atomicDb.prepare(`
      INSERT OR REPLACE INTO hunting_grounds
        (id, name, image_path, zoom, s, ox, oy, fx, fy, is_swap)
      VALUES ('forge', '롤백 전 이름', 'old.png', 1, 1, 0, 0, 1, 1, 0)
    `).run();
    atomicDb.prepare(`
      INSERT INTO homework_logs
        (date, content_id, content_name, category, type, completed_at)
      VALUES (?, 'weekly-eclipse-boss-selfina', '이클립스 (셀피나)', '주간', 'weekly', 1)
    `).run(atomicDate);
    atomicDb.exec(`
      CREATE TRIGGER force_v1_migration_failure
      BEFORE UPDATE OF content_id ON homework_logs
      WHEN OLD.content_id LIKE 'weekly-eclipse-boss-selfina%'
      BEGIN
        SELECT RAISE(ABORT, 'forced v1 migration failure');
      END;
    `);
    atomicDb.pragma('user_version = 0');
    atomicDb.close();

    diaryDb.initDb();
    assert.throws(
      () => diaryDb.getStmt('SELECT 1'),
      /DiaryDB가 초기화되지 않아 prepared statement를 만들 수 없습니다/,
      'DB 초기화 실패 뒤 getStmt가 null 연결을 강제 참조했습니다.',
    );
    const inspectAtomicDb = new MigrationDatabase(migrationDbPath);
    assert.equal(inspectAtomicDb.pragma('user_version', { simple: true }), 0,
      '실패한 v1 마이그레이션이 user_version을 올렸습니다.');
    assert.equal(
      inspectAtomicDb.prepare("SELECT name FROM hunting_grounds WHERE id = 'forge'").pluck().get(),
      '롤백 전 이름',
      'v1 후반 실패 전에 수행한 지도 변경이 롤백되지 않았습니다.',
    );
    assert.equal(
      inspectAtomicDb.prepare('SELECT content_id FROM homework_logs WHERE date = ?').pluck().get(atomicDate),
      'weekly-eclipse-boss-selfina',
      '실패한 v1 숙제 ID 변환이 일부 반영되었습니다.',
    );
    inspectAtomicDb.exec('DROP TRIGGER force_v1_migration_failure');
    inspectAtomicDb.prepare('DELETE FROM homework_logs WHERE date = ?').run(atomicDate);
    inspectAtomicDb.prepare('DELETE FROM diaries WHERE date = ?').run(atomicDate);
    inspectAtomicDb.prepare(`
      UPDATE hunting_grounds
      SET name = '시오칸하임 대장간', image_path = 'assets/img/field-map/대장간.png',
          zoom = 2, s = 1, ox = -340, oy = 300, fx = -1, fy = 1, is_swap = 1
      WHERE id = 'forge'
    `).run();
    inspectAtomicDb.pragma('user_version = 3');
    inspectAtomicDb.close();
  } finally {
    const rootDbPath = path.join(projectRoot, 'diary.db');
    if (fs.existsSync(rootDbPath)) {
      try {
        fs.unlinkSync(rootDbPath);
      } catch {
        // 파일 잠금 등으로 즉시 삭제되지 않을 경우 무시
      }
    }
  }
}

checkRendererResources();
checkCoefficientCalculatorVisibilityContract();
checkHuntingPathArrowSizing();
checkContentsChecklistOrdering();
checkWindowRestoreAndSettingsNavigationContracts();
checkDependencyOverrideContracts();
checkSidebarMenuRegistryContracts();
checkWindowFocusControllerContracts();
checkWindowedFullscreenFocusContracts();
checkEmbeddedWebWindowContracts();
checkFocusedChatContracts();
checkLifecycleAndIpcSafetyContracts();
checkExtractedPureModules();
checkCoreInternalTypesStayStrict();
checkLegacyContentsOrderingRemoved();
checkSharedUiDependencies();
checkEscapeCloseContracts();
checkSharedConstants();
checkPreloadDefaultConfigCompatibility();
checkRequestedFeatureContracts();
checkRequestedChatSamples();
checkChatLogNormalizationAndItemAcquisition();
checkTodaySummary();
checkHuntingExpCalculator();
checkRelicCalculator();
checkEquipmentSimulator();
checkNoAuthoredJavaScriptSources();
checkAgentDocumentationLocations();
checkBuffTimerChatTriggers();
checkResponsiveDockFlyouts();
checkUpdateNoticeFeature();
checkChatLogSyncManagerContracts();
checkPhaseOneSafetyContracts();

function checkDiscordNotifierContracts(): void {
  const { discordNotifier } = require('../dist/modules/discordNotifier');
  assert.ok(discordNotifier && typeof discordNotifier.sendWord === 'function', 'discordNotifier.sendWord 함수가 누락되었습니다.');
  assert.ok(typeof discordNotifier.sendTest === 'function', 'discordNotifier.sendTest 함수가 누락되었습니다.');
}

function checkBossNotifierContracts(): void {
  const bossNotifier = require('../dist/modules/bossNotifier');
  assert.ok(bossNotifier && typeof bossNotifier.start === 'function', 'bossNotifier.start 함수가 누락되었습니다.');
  assert.ok(typeof bossNotifier.stop === 'function', 'bossNotifier.stop 함수가 누락되었습니다.');
  assert.ok(Array.isArray(bossNotifier.BOSS_SCHEDULE), 'bossNotifier.BOSS_SCHEDULE 배열이 누락되었습니다.');
}

function checkBackendServiceContracts(): void {
  const backupManager = require('../dist/modules/backupManager');
  assert.ok(typeof backupManager.exportBackup === 'function', 'backupManager.exportBackup 함수가 누락되었습니다.');
  assert.ok(typeof backupManager.importBackup === 'function', 'backupManager.importBackup 함수가 누락되었습니다.');

  const shortcutManager = require('../dist/modules/shortcutManager');
  assert.ok(typeof shortcutManager.registerAll === 'function', 'shortcutManager.registerAll 함수가 누락되었습니다.');
  assert.ok(typeof shortcutManager.unregisterAll === 'function', 'shortcutManager.unregisterAll 함수가 누락되었습니다.');
  const shortcutSource = read('src/modules/shortcutManager.ts');
  const trackerSource = read('src/modules/tracker.ts');
  assert.match(shortcutSource,
    /export function registerAll\(\)[\s\S]*?globalShortcut\.unregisterAll\(\)[\s\S]*?globalShortcut\.isRegistered/,
    '중복 등록 경로가 기존 단축키와 충돌하지 않도록 만드는 멱등 등록 검사가 없습니다.');
  assert.match(shortcutSource,
    /_isFocused === isFocused && \(!isFocused \|\| _registrationActive\)/,
    '포커스 상태는 같지만 단축키가 해제된 경우 재등록하는 복구 경로가 없습니다.');
  assert.match(trackerSource,
    /function notifyForegroundChange[\s\S]*?lastNotifiedForegroundHwnd[\s\S]*?notifyCurrentForeground/,
    'hook과 폴링의 foreground 통지를 중복 제거하는 공통 경로가 없습니다.');
  assert.match(trackerSource,
    /queryGameRect\(\)[\s\S]*?notifyCurrentForeground\(gameWindowRedetected\)/,
    '게임이 앱보다 먼저 실행된 시작 순서에서 첫 폴링이 단축키 포커스를 재평가하지 않습니다.');

  const customNotifier = require('../dist/modules/customNotifier');
  assert.ok(typeof customNotifier.start === 'function', 'customNotifier.start 함수가 누락되었습니다.');
  assert.ok(typeof customNotifier.stop === 'function', 'customNotifier.stop 함수가 누락되었습니다.');

  const noticeManager = require('../dist/modules/noticeManager');
  assert.ok(typeof noticeManager.getNoticeData === 'function', 'noticeManager.getNoticeData 함수가 누락되었습니다.');
  assert.ok(typeof noticeManager.shouldShowUpdateNotice === 'function', 'noticeManager.shouldShowUpdateNotice 함수가 누락되었습니다.');
}

function checkIpcChannelContracts(): void {
  const preloadSource = fs.readFileSync(path.join(projectRoot, 'src', 'preload.ts'), 'utf8');
  
  // src/ 및 src/modules/ 내의 모든 .ts 파일 소스를 통합
  const mainDir = path.join(projectRoot, 'src');
  const modulesDir = path.join(projectRoot, 'src', 'modules');
  let combinedBackendSource = '';
  
  for (const file of fs.readdirSync(mainDir)) {
    if (file.endsWith('.ts')) combinedBackendSource += fs.readFileSync(path.join(mainDir, file), 'utf8') + '\n';
  }
  if (fs.existsSync(modulesDir)) {
    for (const file of fs.readdirSync(modulesDir)) {
      if (file.endsWith('.ts')) combinedBackendSource += fs.readFileSync(path.join(modulesDir, file), 'utf8') + '\n';
    }
  }

  // preload에서 호출하는 채널들 추출 (ipcRenderer.send, ipcRenderer.invoke, ipcRenderer.sendSync)
  const sendChannels = Array.from(preloadSource.matchAll(/ipcRenderer\.(?:send|invoke|sendSync)\(\s*['"]([^'"]+)['"]/g), m => m[1]);
  assert.ok(sendChannels.length > 30, 'preload에서 IPC 채널이 충분히 추출되지 않았습니다.');

  // 백엔드 모듈 및 main.ts에서 리스너가 존재하는지 확인
  for (const ch of sendChannels) {
    const hasHandler = combinedBackendSource.includes(`'${ch}'`) || combinedBackendSource.includes(`"${ch}"`);
    assert.ok(hasHandler, `Preload에서 호출하는 IPC 채널 '${ch}'의 핸들러가 메인/모듈에 등록되어 있지 않습니다.`);
  }
}

function checkRendererBundleCleanliness(): void {
  const assetsDir = path.join(projectRoot, 'dist', 'assets');
  if (fs.existsSync(assetsDir)) {
    const jsFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
    for (const file of jsFiles) {
      const content = fs.readFileSync(path.join(assetsDir, file), 'utf8');
      assert.ok(!content.includes('exports.__esModule'), `렌더러 에셋 번들 '${file}'에 CommonJS exports가 포함되어 있습니다.`);
    }
  }
}

function checkCorruptedConfigResilience(): void {
  const configSource = read('src/modules/config.ts');
  assert.match(configSource, /다른 버전에서 추가된 설정이거나 값 형식이 맞지 않을 수 있습니다/,
    '격리 안내가 일반 사용자에게 원인과 안전한 보관 사실을 설명하지 않습니다.');
  assert.match(configSource, /해당 항목은 삭제하지 않고 별도 파일에 보관했으며/,
    '격리 안내가 설정값을 삭제하지 않았다는 사실을 설명하지 않습니다.');
  assert.doesNotMatch(configSource, /일부 미인식 또는 손상된 설정을 격리하고/,
    '정상적인 버전 전환을 설정 손상처럼 표현하는 기존 안내가 남아 있습니다.');

  const constantsModule = require('../dist/modules/constants');
  assert.equal(
    path.resolve(constantsModule.get_CONFIG_PATH()),
    path.join(isolatedUserData, 'config.json'),
    '회귀 테스트의 설정 파일이 격리된 userData 경로를 사용하지 않습니다.',
  );
  assert.equal(
    path.resolve(constantsModule.get_LOG_PATH()),
    path.join(isolatedUserData, 'debug.log'),
    '회귀 테스트의 로그 파일이 격리된 userData 경로를 사용하지 않습니다.',
  );

  const configModule = require('../dist/modules/config');
  const loaded = configModule.load();
  assert.ok(loaded && typeof loaded === 'object', '기본 설정 로드 시 유효한 객체가 반환되지 않았습니다.');
  assert.ok(loaded.shortcuts && typeof loaded.shortcuts === 'object', '설정 내 shortcuts 객체가 누락되었습니다.');
  const secondLoad = configModule.load();
  assert.notEqual(secondLoad, loaded, '설정 load 호출이 같은 최상위 객체를 노출합니다.');
  assert.notEqual(secondLoad.shortcuts, loaded.shortcuts, '설정 load 호출이 같은 중첩 객체를 노출합니다.');
  const selected = configModule.loadFields(['shortcuts', 'userServer']);
  assert.deepEqual(Object.keys(selected).sort(), ['shortcuts', 'userServer'],
    '선택 설정 읽기가 요청하지 않은 큰 설정 필드까지 반환합니다.');
  assert.notEqual(selected.shortcuts, loaded.shortcuts,
    '선택 설정 읽기가 중첩 객체의 내부 캐시 별칭을 노출합니다.');
  const originalShortcut = configModule.load().shortcuts.toggleOverlay;
  selected.shortcuts.toggleOverlay = 'mutated-by-regression-test';
  assert.equal(configModule.load().shortcuts.toggleOverlay, originalShortcut,
    '선택 설정 스냅샷 수정이 내부 설정 캐시를 오염시켰습니다.');
  assert.deepEqual(
    configModule.sanitizeExternalConfigPatch({
      fixedWindowPositions: { chatOverlay: { x: -120, y: 360 } },
    }),
    { fixedWindowPositions: { chatOverlay: { x: -120, y: 360 } } },
    '정상적인 다중 모니터 화면 좌표가 설정 검증에서 거부되었습니다.',
  );
  assert.deepEqual(
    configModule.sanitizeExternalConfigPatch({
      windowedFullscreenPositions: { chatOverlay: { offsetX: -940, offsetY: 130 } },
    }),
    { windowedFullscreenPositions: { chatOverlay: { offsetX: -940, offsetY: 130 } } },
    '정상적인 창모드 전체화면 상대 좌표가 설정 검증에서 거부되었습니다.',
  );
  assert.equal(
    configModule.sanitizeExternalConfigPatch({
      windowedFullscreenPositions: { chatOverlay: { offsetX: 'invalid', offsetY: 130 } },
    }),
    null,
    '손상된 창모드 전체화면 상대 좌표가 설정으로 허용되었습니다.',
  );
  assert.equal(
    configModule.sanitizeExternalConfigPatch({
      fixedWindowPositions: { chatOverlay: { x: 'invalid', y: 360 } },
    }),
    null,
    '손상된 화면 좌표가 창 배치 설정으로 허용되었습니다.',
  );
  assert.equal(
    configModule.sanitizeExternalConfigPatch({
      fixedWindowPositions: { unknownWindow: { x: 10, y: 20 } },
    }),
    null,
    '알 수 없는 창 키가 화면 좌표 설정으로 허용되었습니다.',
  );
  assert.deepEqual(
    configModule.sanitizeExternalConfigPatch({
      chatOverlayCustomTabs: [{
        id: 'custom_standard',
        name: '파티용',
        channels: ['general', 'team', 'club', 'shout'],
      }],
    }),
    {
      chatOverlayCustomTabs: [{
        id: 'custom_standard',
        name: '파티용',
        channels: ['general', 'team', 'club', 'shout'],
      }],
    },
    '시스템 채널이 없는 정상 사용자 정의 탭이 설정 검증에서 거부되었습니다.',
  );
  assert.deepEqual(
    configModule.sanitizeExternalConfigPatch({
      chatOverlayCustomTabs: [{
        id: 'custom_system',
        name: '시스템',
        channels: ['system'],
        systemColorFilters: ['purple', 'red'],
      }],
    }),
    {
      chatOverlayCustomTabs: [{
        id: 'custom_system',
        name: '시스템',
        channels: ['system'],
        systemColorFilters: ['purple', 'red'],
      }],
    },
    '시스템 색상 필터가 있는 정상 사용자 정의 탭이 설정 검증에서 거부되었습니다.',
  );
  assert.equal(
    configModule.sanitizeExternalConfigPatch({
      chatOverlayCustomTabs: [{
        id: 'custom_invalid',
        name: '잘못된탭',
        channels: ['general'],
        systemColorFilters: ['purple'],
      }],
    }),
    null,
    '시스템 채널 없이 시스템 색상 필터를 가진 잘못된 사용자 정의 탭이 허용되었습니다.',
  );

}

function checkShoutSuffixStripping(): void {
  const { stripShoutSuffix } = require('../dist/shared/chatChannels');
  assert.equal(typeof stripShoutSuffix, 'function', 'stripShoutSuffix 함수가 누락되었습니다.');

  // 1. 단어 끝 Click, From 제거 검증
  assert.equal(stripShoutSuffix('오늘의 마지막 외치기!! 삼?급처템 Click'), '오늘의 마지막 외치기!! 삼?급처템');
  assert.equal(stripShoutSuffix('드레스업하복상자400억팜 From'), '드레스업하복상자400억팜');
  assert.equal(stripShoutSuffix('시벨린도 1등이있어요? 신기하네 from'), '시벨린도 1등이있어요? 신기하네');
  assert.equal(stripShoutSuffix('12강 이블테오 14강뻑삭 삽니다....1:1주세용 CLICK'), '12강 이블테오 14강뻑삭 삽니다....1:1주세용');
  assert.equal(stripShoutSuffix('아이템 팝니다 From Click'), '아이템 팝니다');

  // 2. 문구 중간/앞 단어 보존 검증 (절대 지워지지 않아야 함)
  assert.equal(stripShoutSuffix('From 서울 to 부산 Click 이벤트 From'), 'From 서울 to 부산 Click 이벤트');
  assert.equal(stripShoutSuffix('Click & Buy From Me Click'), 'Click & Buy From Me');
  assert.equal(stripShoutSuffix('클릭(Click) 해주세요 From Me'), '클릭(Click) 해주세요 From Me');
  assert.equal(stripShoutSuffix('일반 외치기 메시지입니다'), '일반 외치기 메시지입니다');

  // 3. chatParser 연동 검증
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js'));
  let receivedMessage = '';
  const shoutListener = (data: { sender: string; message: string }) => {
    receivedMessage = data.message;
  };
  chatParser.on('TRADE_SHOUT', shoutListener);

  chatParser.parseLine('<font size="2" color="white"> [13시 34분 27초] </font> <font size="2" color="#c896c8">외치기 : 베한계 이클리스트 500베 효과 삽니다 Click [소온]</font></br>');
  assert.equal(receivedMessage, '베한계 이클리스트 500베 효과 삽니다', '외치기 Click 접미사가 제거되지 않았습니다.');

  chatParser.parseLine('<font size="2" color="white"> [13시 34분 28초] </font> <font size="2" color="#c896c8">외치기 : From 서울 to 부산 Click 이벤트 From [유저1]</font></br>');
  assert.equal(receivedMessage, 'From 서울 to 부산 Click 이벤트', '중간 단어가 훼손되었거나 끝 접미사가 제거되지 않았습니다.');

  chatParser.off('TRADE_SHOUT', shoutListener);
}

function checkMandatoryUpdateLogic(): void {
  const updaterModule = require(path.join(projectRoot, 'dist', 'modules', 'updater.js')) as {
    hasMandatoryTag: (text: unknown) => boolean;
    findLatestMandatoryRelease: (info: any, currentVersion?: string) => { version: string; tag: string; note?: string } | null;
    checkMandatory: (info: any, currentVersion?: string) => boolean;
    formatReleaseNotes: (releaseNotes: any) => string | undefined;
    isBetaVersion: (version?: string) => boolean;
  };

  const { hasMandatoryTag, findLatestMandatoryRelease, checkMandatory, formatReleaseNotes, isBetaVersion } = updaterModule;

  // 1. 태그 판별 대소문자/공백 무시 검증
  assert.equal(hasMandatoryTag('[Mandatory Update]'), true);
  assert.equal(hasMandatoryTag('[mandatory update]'), true);
  assert.equal(hasMandatoryTag('[  MANDATORY   UPDATE  ]'), true);
  assert.equal(hasMandatoryTag('긴급 패치 [Mandatory Update] 안내'), true);
  assert.equal(hasMandatoryTag('일반 업데이트 버전'), false);
  assert.equal(hasMandatoryTag(null), false);
  assert.equal(hasMandatoryTag(undefined), false);

  // 2. 다중 릴리즈 시나리오 검증:
  // 사용자 v1 환경에서 배포 이력: v6(일반), v5(강제), v4(일반), v3(강제), v2(강제)
  // 최신 강제 버전인 v5가 선별되어야 함
  const multiReleaseInfoScenario = {
    version: '6.0.0',
    releaseName: 'v6.0.0 일반 업데이트',
    releaseNotes: [
      { version: '6.0.0', note: 'v6 일반 기능 추가 및 개선' },
      { version: '5.0.0', note: '<h2>[Mandatory Update] v5.0.0 긴급 보안 패치</h2>' },
      { version: '4.0.0', note: 'v4 일반 UI 업데이트' },
      { version: '3.0.0', note: '<h1>[Mandatory Update] v3.0.0 데이터 마이그레이션</h1>' },
      { version: '2.0.0', note: '[Mandatory Update] v2.0.0 릴리즈' }
    ]
  };

  const targetRelease = findLatestMandatoryRelease(multiReleaseInfoScenario, '1.0.0');
  assert.ok(targetRelease !== null, '다중 릴리즈 히스토리에서 강제 업데이트 타겟을 찾지 못했습니다.');
  assert.equal(targetRelease.version, '5.0.0', '상위 버전 중 가장 최신 강제 업데이트 버전인 v5가 선택되지 않았습니다.');
  assert.equal(targetRelease.tag, 'v5.0.0', '타겟 태그명이 올바르지 않습니다.');
  assert.equal(checkMandatory(multiReleaseInfoScenario, '1.0.0'), true);

  // 3. 상위 버전 중 강제 업데이트가 하나도 없는 시나리오: v3(일반), v2(일반)
  const noMandatoryInfoScenario = {
    version: '3.0.0',
    releaseName: 'v3.0.0 일반 릴리즈',
    releaseNotes: [
      { version: '3.0.0', note: 'v3 일반 기능 개선' },
      { version: '2.0.0', note: 'v2 일반 버그 수정' }
    ]
  };
  assert.equal(findLatestMandatoryRelease(noMandatoryInfoScenario, '1.0.0'), null, '강제 업데이트가 없는데 타겟이 반환되었습니다.');
  assert.equal(checkMandatory(noMandatoryInfoScenario, '1.0.0'), false);

  // 4. 단일 릴리즈 (문자열) 시나리오 검증
  const singleMandatoryTitle = {
    version: '2.6.7',
    releaseName: '[Mandatory Update] v2.6.7 긴급 배포',
    releaseNotes: '단일 릴리즈 노트 내용'
  };
  const singleTarget1 = findLatestMandatoryRelease(singleMandatoryTitle, '2.6.0');
  assert.ok(singleTarget1 !== null);
  assert.equal(singleTarget1.version, '2.6.7');
  assert.equal(singleTarget1.tag, 'v2.6.7');

  const singleMandatoryBody = {
    version: '2.6.7',
    releaseName: 'v2.6.7 긴급 배포',
    releaseNotes: '<h1>[Mandatory Update]</h1> 버그 수정'
  };
  const singleTarget2 = findLatestMandatoryRelease(singleMandatoryBody, '2.6.0');
  assert.ok(singleTarget2 !== null);
  assert.equal(singleTarget2.version, '2.6.7');

  const singleRegular = {
    version: '2.6.8',
    releaseName: 'v2.6.8 일반 배포',
    releaseNotes: '일반 패치'
  };
  assert.equal(findLatestMandatoryRelease(singleRegular, '2.6.0'), null);
  assert.equal(checkMandatory(singleRegular, '2.6.0'), false);

  // 5. formatReleaseNotes 포매팅 검증
  const formatted = formatReleaseNotes(multiReleaseInfoScenario.releaseNotes);
  assert.ok(typeof formatted === 'string');
  assert.ok(formatted.includes('v6.0.0'));
  assert.ok(formatted.includes('v5.0.0'));
  assert.doesNotMatch(formatted, /<h3>|<hr|onerror\s*=/i);

  // 6. 베타 버전 판별 및 강제 업데이트 무시 검증
  assert.equal(isBetaVersion('2.7.0-beta.1'), true);
  assert.equal(isBetaVersion('2.7.0-beta'), true);
  assert.equal(isBetaVersion('2.7.0-rc.1'), true);
  assert.equal(isBetaVersion('2.7.0-alpha'), true);
  assert.equal(isBetaVersion('2.7.0-preview'), true);
  assert.equal(isBetaVersion('2.7.0'), false);
  assert.equal(isBetaVersion('2.6.8'), false);

  // 베타 버전 환경에서는 강제 릴리즈가 존재해도 null 반환 (강제 업데이트 무시)
  assert.equal(findLatestMandatoryRelease(multiReleaseInfoScenario, '2.7.0-beta.1'), null);
  assert.equal(checkMandatory(multiReleaseInfoScenario, '2.7.0-beta.1'), false);
  assert.equal(findLatestMandatoryRelease(singleMandatoryTitle, '2.7.0-beta.1'), null);
  assert.equal(checkMandatory(singleMandatoryTitle, '2.7.0-beta.1'), false);
}

function checkCustomTabHistoryContracts(): void {
  const { chatLogManager } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogManager.js'));
  assert.equal(typeof chatLogManager.resetLastReadIndex, 'function', 'chatLogManager.resetLastReadIndex가 누락되었습니다.');
  assert.equal(typeof chatLogManager.getMoreHistory, 'function', 'chatLogManager.getMoreHistory가 누락되었습니다.');

  // 커스텀 탭 ID로 리셋 및 더 불러오기 호출 시 예외 없이 동작하는지 검증
  assert.doesNotThrow(() => {
    chatLogManager.resetLastReadIndex('custom_123456789');
  }, '커스텀 탭 ID resetLastReadIndex 호출 시 예외가 발생했습니다.');
}

function checkPendingHomeworkOrdering(): void {
  const {
    mergePendingHomeworkEvent,
    resolvePendingHomeworkCount,
    isPendingHomeworkExpired,
    getHomeworkResetCycleKey,
    getPendingHomeworkCandidateIds,
    shouldAutoAssignSinglePendingCandidate,
    getNextHomeworkResetAt,
    resetExpiredHomeworkItems,
    queuePendingHomework,
  } = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as {
    mergePendingHomeworkEvent(
      existing: { id: string; count: number; isIncrement: boolean; timestamp: number } | undefined,
      id: string,
      count: number,
      isIncrement: boolean,
      timestamp: number,
      sourceEventId?: string,
      resetCycleKey?: string,
    ): {
      id: string;
      count: number;
      isIncrement: boolean;
      timestamp: number;
      sourceEventIds?: string[];
      resetCycleKey?: string;
    };
    resolvePendingHomeworkCount(
      current: number,
      pending: { id: string; count: number; isIncrement: boolean; timestamp: number },
      max: number,
    ): number;
    isPendingHomeworkExpired(
      pending: { id: string; count: number; isIncrement: boolean; timestamp: number },
      rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number },
      nowTimestamp: number,
    ): boolean;
    getHomeworkResetCycleKey(
      rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number },
      timestamp: number,
    ): string;
    getPendingHomeworkCandidateIds(
      presets: Array<{ id: string; name: string }>,
      items: Array<{
        id: string;
        maxCount?: number;
        completedState: Record<string, {
          isCompleted: boolean;
          isExcluded?: boolean;
          currentCount?: number;
        }>;
      }>,
      pendingList: Array<{ id: string; count: number; isIncrement: boolean; timestamp: number }>,
    ): string[];
    shouldAutoAssignSinglePendingCandidate(
      autoAssignSingleCandidate: boolean | undefined,
      candidateCharacterIds: string[],
    ): boolean;
    getNextHomeworkResetAt(
      items: Array<{ resetRule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number } }>,
      nowTimestamp?: number,
    ): number | undefined;
    resetExpiredHomeworkItems(
      items: Array<Record<string, any>>,
      nowTimestamp?: number,
    ): {
      items: Array<Record<string, any>>;
      resetEntries: Array<{ itemName: string; characterId: string; resetType: 'daily' | 'weekly' }>;
    };
    queuePendingHomework(
      id: string,
      count: number,
      isIncrement: boolean,
      sourceEventId?: string,
      eventTimestamp?: number,
    ): void;
  };

  const incrementFirst = mergePendingHomeworkEvent(undefined, 'weekly-test', 1, true, 100);
  const incrementThenAbsolute = mergePendingHomeworkEvent(incrementFirst, 'weekly-test', 3, false, 200);
  assert.equal(incrementThenAbsolute.isIncrement, false);
  assert.equal(incrementThenAbsolute.count, 3);
  assert.equal(resolvePendingHomeworkCount(2, incrementThenAbsolute, 10), 3,
    '증분 뒤 절대값은 감지된 절대 횟수로 설정되어야 합니다.');

  const absoluteFirst = mergePendingHomeworkEvent(undefined, 'weekly-test', 3, false, 100);
  const absoluteThenIncrement = mergePendingHomeworkEvent(absoluteFirst, 'weekly-test', 1, true, 200);
  assert.equal(absoluteThenIncrement.isIncrement, false);
  assert.equal(absoluteThenIncrement.count, 4);
  assert.equal(resolvePendingHomeworkCount(2, absoluteThenIncrement, 10), 4,
    '절대값 뒤 증분은 현재 캐릭터 횟수를 이중 가산하지 않아야 합니다.');

  const increments = mergePendingHomeworkEvent(
    mergePendingHomeworkEvent(undefined, 'weekly-test', 1, true, 100),
    'weekly-test',
    2,
    true,
    200,
  );
  assert.equal(increments.isIncrement, true);
  assert.equal(resolvePendingHomeworkCount(2, increments, 10), 5,
    '증분 이벤트만 있으면 기존 캐릭터 횟수에 누적되어야 합니다.');

  const beforeReset = new Date(2026, 7, 24, 5, 59, 0).getTime();
  const afterReset = new Date(2026, 7, 24, 6, 1, 0).getTime();
  const afterCurrentReset = new Date(2026, 7, 24, 6, 0, 30).getTime();
  const stalePending = mergePendingHomeworkEvent(undefined, 'daily-test', 1, true, beforeReset);
  const currentPending = mergePendingHomeworkEvent(undefined, 'daily-test', 1, true, afterCurrentReset);
  assert.equal(isPendingHomeworkExpired(stalePending, { type: 'daily', hour: 6 }, afterReset), true);
  assert.equal(isPendingHomeworkExpired(currentPending, { type: 'daily', hour: 6 }, afterReset), false);

  const cycleKey = getHomeworkResetCycleKey({ type: 'daily', hour: 6 }, afterCurrentReset);
  const deduplicatedOnce = mergePendingHomeworkEvent(
    undefined, 'daily-test', 1, true, afterCurrentReset, 'stable-event-1', cycleKey,
  );
  const deduplicatedTwice = mergePendingHomeworkEvent(
    deduplicatedOnce, 'daily-test', 1, true, afterCurrentReset + 1000, 'stable-event-1', cycleKey,
  );
  assert.strictEqual(deduplicatedTwice, deduplicatedOnce,
    '같은 채팅 이벤트 ID를 다시 처리하면 보류 횟수가 변경되지 않아야 합니다.');
  assert.equal(deduplicatedTwice.count, 1);

  const candidatePresets = [
    { id: 'char-main', name: '본캐' },
    { id: 'char-alt', name: '부캐' },
  ];
  const candidatePending = [{ id: 'weekly-a', count: 1, isIncrement: true, timestamp: afterCurrentReset }];
  const candidateItems = [{
    id: 'weekly-a',
    maxCount: 1,
    completedState: {
      'char-main': { isCompleted: true, currentCount: 1 },
      'char-alt': { isCompleted: false, currentCount: 0 },
    },
  }];
  assert.deepEqual(
    getPendingHomeworkCandidateIds(candidatePresets, candidateItems, candidatePending),
    ['char-alt'],
    '본캐가 완료한 숙제의 미완료 후보를 정확히 계산해야 합니다.',
  );
  assert.equal(shouldAutoAssignSinglePendingCandidate(undefined, ['char-alt']), true,
    '기존 설정이 없는 사용자는 단일 후보 자동 반영 동작을 유지해야 합니다.');
  assert.equal(shouldAutoAssignSinglePendingCandidate(true, ['char-alt']), true);
  assert.equal(shouldAutoAssignSinglePendingCandidate(false, ['char-alt']), false,
    '직접 선택 설정에서는 후보가 한 명이어도 자동 반영하면 안 됩니다.');
  assert.equal(shouldAutoAssignSinglePendingCandidate(true, ['char-main', 'char-alt']), false,
    '후보가 둘 이상이면 자동 반영 설정과 무관하게 선택 팝업을 사용해야 합니다.');

  const resetNow = new Date(2026, 7, 27, 9, 0, 0, 0).getTime();
  const previousCycle = new Date(2026, 7, 26, 23, 30, 0, 0).getTime();
  const currentCycle = new Date(2026, 7, 27, 0, 30, 0, 0).getTime();
  const resetFixture: Array<Record<string, any>> = [{
    id: 'daily-club-boss', name: '클럽 보스', category: '클럽', isVisible: true,
    resetRule: { type: 'daily', hour: 0 },
    completedState: { 'char-main': { isCompleted: true, currentCount: 2, lastCompletedAt: previousCycle } },
  }, {
    id: 'daily-eta-quest', name: '에타 퀘스트', category: '일반', isVisible: true,
    resetRule: { type: 'daily', hour: 0 },
    completedState: { 'char-main': { isCompleted: true, currentCount: 1, lastCompletedAt: previousCycle } },
  }, {
    id: 'daily-eta-will-upgrade', name: '에타 도전과제', category: '일반', isVisible: true,
    resetRule: { type: 'daily', hour: 0 },
    completedState: { 'char-main': { isCompleted: true, currentCount: 1, lastCompletedAt: currentCycle } },
  }];
  const resetResult = resetExpiredHomeworkItems(resetFixture, resetNow);
  assert.deepEqual(resetResult.resetEntries.map(entry => entry.itemName), ['클럽 보스', '에타 퀘스트'],
    '클라우드에서 받은 전날 일일 숙제만 현재 주기에서 초기화해야 합니다.');
  assert.deepEqual(resetResult.items[0].completedState['char-main'], {
    isCompleted: false, currentCount: 0, lastCompletedAt: undefined,
  });
  assert.equal(resetResult.items[2].completedState['char-main'].isCompleted, true,
    '오늘 리셋 경계 뒤 완료한 일일 숙제를 초기화했습니다.');
  assert.equal(resetFixture[0].completedState['char-main'].isCompleted, true,
    '리셋 정규화가 입력 스냅샷을 직접 변경했습니다.');

  assert.equal(getNextHomeworkResetAt([resetFixture[0] as any], resetNow),
    new Date(2026, 7, 28, 0, 0, 0, 0).getTime(),
    '앱을 켜 둔 상태의 다음 일일 리셋 경계를 잘못 계산했습니다.');
  assert.equal(getNextHomeworkResetAt([{
    resetRule: { type: 'weekly', dayOfWeek: 1, hour: 0 },
  }], resetNow), new Date(2026, 7, 31, 0, 0, 0, 0).getTime(),
  '앱을 켜 둔 상태의 다음 주간 리셋 경계를 잘못 계산했습니다.');

  candidateItems[0].completedState['char-main'] = { isCompleted: false, currentCount: 0 };
  assert.deepEqual(
    getPendingHomeworkCandidateIds(candidatePresets, candidateItems, candidatePending),
    ['char-main', 'char-alt'],
    '같은 숙제를 할 수 있는 미완료 캐릭터가 둘이면 선택 팝업을 유지해야 합니다.',
  );

  const nextCycleTimestamp = new Date(2026, 7, 25, 6, 1, 0).getTime();
  const nextCycleKey = getHomeworkResetCycleKey({ type: 'daily', hour: 6 }, nextCycleTimestamp);
  const nextCyclePending = mergePendingHomeworkEvent(
    deduplicatedOnce, 'daily-test', 2, true, nextCycleTimestamp, 'stable-event-2', nextCycleKey,
  );
  assert.equal(nextCyclePending.count, 2,
    '리셋 주기가 바뀌면 이전 주기의 압축 횟수를 이어받지 않아야 합니다.');
  assert.deepEqual(nextCyclePending.sourceEventIds, ['stable-event-2']);

  const configModule = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as any;
  const previousConfig = configModule.loadFields([
    'characterPresets',
    'contentsCheckerItems',
    'pendingHomeworks',
    'contentsAutoAssignSingleCandidate',
  ]);
  const originalSaveImmediate = configModule.saveImmediate;
  const completedAt = Date.now();
  try {
    originalSaveImmediate({
      characterPresets: [{ id: 'single-character', name: '단일 캐릭터' }],
      contentsCheckerItems: [{
        id: 'daily-repeat-save-regression',
        name: '반복 저장 방지 숙제',
        category: '회귀 검사',
        isVisible: true,
        maxCount: 1,
        resetRule: { type: 'daily', hour: 0 },
        completedState: {
          'single-character': {
            isCompleted: true,
            currentCount: 1,
            lastCompletedAt: completedAt,
          },
        },
      }],
      pendingHomeworks: [],
      contentsAutoAssignSingleCandidate: true,
    });
    let redundantSaveCount = 0;
    configModule.saveImmediate = (...args: unknown[]) => {
      redundantSaveCount++;
      return originalSaveImmediate(...args);
    };
    queuePendingHomework(
      'daily-repeat-save-regression',
      1,
      true,
      'repeat-save-regression-event',
      completedAt + 1000,
    );
    assert.equal(redundantSaveCount, 0,
      '현재 주기에 이미 완료된 단일 캐릭터 숙제를 반복 감지해 동일 config를 다시 저장했습니다.');
  } finally {
    configModule.saveImmediate = originalSaveImmediate;
    originalSaveImmediate(previousConfig);
  }

  const checkerSource = read('src/modules/contentsChecker.ts');
  assert.match(checkerSource,
    /config\.loadFields\(PENDING_HOMEWORK_CONFIG_KEYS\)/,
    '숙제 자동 감지 경로가 필요한 설정 필드만 읽지 않습니다.');
}

function checkLegacyHomeworkMergeContracts(): void {
  const { mergeHomeworkCompletedState } = require(
    path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js'),
  ) as {
    mergeHomeworkCompletedState(
      existing: Record<string, unknown> | undefined,
      incoming: Record<string, unknown> | undefined,
      rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number },
      max: number,
      nowTimestamp: number,
    ): { currentCount?: number; isCompleted: boolean; lastCompletedAt?: number; isExcluded?: boolean };
  };

  const now = new Date(2026, 7, 25, 12, 0, 0).getTime();
  const staleCompleted = new Date(2026, 7, 24, 5, 30, 0).getTime();
  const currentProgress = new Date(2026, 7, 25, 7, 0, 0).getTime();
  const currentWins = mergeHomeworkCompletedState(
    { isCompleted: true, currentCount: 7, lastCompletedAt: staleCompleted },
    { isCompleted: false, currentCount: 1, lastCompletedAt: currentProgress },
    { type: 'daily', hour: 6 },
    7,
    now,
  );
  assert.equal(currentWins.currentCount, 1,
    '과거 리셋 주기의 큰 완료 횟수가 현재 주기 진행도를 덮어쓰면 안 됩니다.');
  assert.equal(currentWins.isCompleted, false);

  const currentHigherProgress = new Date(2026, 7, 25, 8, 0, 0).getTime();
  const sameCycleMerged = mergeHomeworkCompletedState(
    { isCompleted: false, currentCount: 4, lastCompletedAt: currentProgress, isExcluded: true },
    { isCompleted: false, currentCount: 2, lastCompletedAt: currentHigherProgress },
    { type: 'daily', hour: 6 },
    7,
    now,
  );
  assert.equal(sameCycleMerged.currentCount, 4,
    '같은 리셋 주기의 중복 데이터에서는 더 큰 진행도를 보존해야 합니다.');
  assert.equal(sameCycleMerged.lastCompletedAt, currentHigherProgress,
    '같은 리셋 주기의 중복 데이터에서는 가장 최근 감지 시각을 보존해야 합니다.');
  assert.equal(sameCycleMerged.isExcluded, true,
    '레거시 중복 병합 중 사용자가 설정한 N/A가 사라지면 안 됩니다.');

  const checkerSource = read('src/modules/contentsChecker.ts');
  assert.ok(
    checkerSource.indexOf('const newId = ID_MIGRATION_MAP[previousId]')
      < checkerSource.indexOf('// 0-A. 고대 렐릭의 성소'),
    '일일형 고대 렐릭 ID 정규화가 렐릭 통합보다 늦게 실행되어 상태가 유실될 수 있습니다.',
  );
}

function checkHomeworkSourceEventIdContracts(): void {
  const { createHomeworkSourceEventId, parseHomeworkSourceTimestamp } = require(
    path.join(projectRoot, 'dist', 'modules', 'chatLogProcessor.js'),
  ) as {
    createHomeworkSourceEventId(eventName: string, homeworkId: string, data: Record<string, string>): string;
    parseHomeworkSourceTimestamp(data: Record<string, string>): number;
  };
  const event = {
    date: '2026-08-25',
    timestamp: '12시 34분 56초',
    message: '콘텐츠를 1회 완료했습니다.',
  };
  const first = createHomeworkSourceEventId('TEST_CLEAR', 'daily-test', event);
  assert.equal(createHomeworkSourceEventId('TEST_CLEAR', 'daily-test', event), first,
    '동일한 채팅 로그는 항상 같은 숙제 이벤트 ID를 생성해야 합니다.');
  assert.notEqual(createHomeworkSourceEventId('TEST_CLEAR', 'daily-other', event), first,
    '같은 채팅 줄에서 서로 다른 숙제 ID는 별개의 이벤트 ID여야 합니다.');
  assert.equal(
    parseHomeworkSourceTimestamp(event),
    new Date(2026, 7, 25, 12, 34, 56).getTime(),
    '숙제 리셋 주기는 처리 시각이 아니라 실제 채팅 로그 시각을 사용해야 합니다.',
  );
}

function checkContentsVisibilityContracts(): void {
  const checkerSource = read('src/modules/contentsChecker.ts');
  const checkerHtml = read('src/contents-checker.html');
  assert.doesNotMatch(checkerSource, /return i\.isVisible && !state\?\.isExcluded/,
    '모듈 통계가 isVisible 없는 레거시 숙제를 숨김 처리합니다.');
  assert.match(checkerSource, /item\.isVisible = item\.isVisible === false/,
    'isVisible 없는 레거시 숙제의 첫 토글이 숨김으로 전환되지 않습니다.');
  assert.doesNotMatch(checkerHtml, /filter\(i => i\.isVisible\)/,
    '화면에 isVisible 없는 레거시 숙제를 제외하는 truthy 필터가 남아 있습니다.');
  assert.match(checkerHtml, /filter\(i => i\.isVisible !== false\)/,
    '화면 가시성의 기본 보임 계약이 없습니다.');
}

function checkContentsInitializationContracts(): void {
  const contentsChecker = require(path.join(projectRoot, 'dist', 'modules', 'contentsChecker.js')) as {
    init(): boolean;
    reorderItem(sourceId: string, targetId: string, position: 'before' | 'after'): void;
  };
  const appConfig = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as {
    load(): Record<string, unknown>;
    saveImmediate(patch: Record<string, unknown>): boolean;
  };

  appConfig.saveImmediate({
    contentsCheckerItems: [
      {
        id: 'weekly-eclipse-boss-matias',
        name: '이클립스 (마티아)',
        category: '사용자 분류',
        isVisible: true,
        isCustom: false,
        resetRule: { type: 'weekly', dayOfWeek: 1, hour: 0 },
        maxCount: 7,
        auto: true,
        completedState: {},
      },
      {
        id: 'weekly-eclipse-boss-ethos',
        name: '이클립스 (에토스)',
        category: '보스',
        isVisible: true,
        isCustom: false,
        resetRule: { type: 'weekly', dayOfWeek: 1, hour: 0 },
        maxCount: 7,
        auto: true,
        completedState: {},
      },
      {
        id: 'daily-reset-boundary-regression',
        name: '일일 이동 경계 테스트',
        category: '일일 테스트',
        isVisible: true,
        isCustom: true,
        resetRule: { type: 'daily', hour: 0 },
        completedState: {},
      },
    ],
  });

  assert.equal(contentsChecker.init(), true, '숙제 체크리스트 최초 초기화가 실패했습니다.');
  const initializedItems = (appConfig.load().contentsCheckerItems as Array<{
    id: string;
    category: string;
  }>) || [];
  assert.deepEqual(
    initializedItems.slice(0, 2).map(item => item.id),
    ['weekly-eclipse-boss-matias', 'weekly-eclipse-boss-ethos'],
    '앱 재시작 초기화가 사용자가 바꾼 AUTO 숙제 순서를 되돌렸습니다.',
  );
  assert.equal(
    initializedItems.find(item => item.id === 'weekly-eclipse-boss-matias')?.category,
    '사용자 분류',
    '앱 재시작 초기화가 AUTO 숙제의 사용자 카테고리를 기본값으로 덮어썼습니다.',
  );
  const beforeCrossResetReorder = JSON.stringify(appConfig.load().contentsCheckerItems);
  contentsChecker.reorderItem(
    'weekly-eclipse-boss-matias',
    'daily-reset-boundary-regression',
    'before',
  );
  assert.equal(
    JSON.stringify(appConfig.load().contentsCheckerItems),
    beforeCrossResetReorder,
    '주간 숙제를 일간 영역으로 드래그해 리셋 유형 또는 순서를 바꿀 수 있습니다.',
  );
  const firstSnapshot = JSON.stringify(appConfig.load());
  assert.equal(contentsChecker.init(), true, '숙제 체크리스트 중복 초기화가 실패로 보고되었습니다.');
  assert.equal(JSON.stringify(appConfig.load()), firstSnapshot,
    '숙제 체크리스트 두 번째 초기화가 설정을 다시 변경했습니다.');

  const mainSource = read('src/main.ts');
  const initPosition = mainSource.indexOf('contentsChecker.init()');
  const processorStartPosition = mainSource.indexOf('chatLogProcessor.start()');
  assert.ok(initPosition >= 0 && processorStartPosition > initPosition,
    '숙제 체크리스트가 채팅 자동 감지보다 먼저 초기화되지 않습니다.');

  const { DEFAULT_CONFIG } = require(path.join(projectRoot, 'dist', 'modules', 'constants.js')) as {
    DEFAULT_CONFIG: Record<string, unknown>;
  };
  assert.equal(DEFAULT_CONFIG.ethosAlertEnabled, true, '에토스 기믹 알림 신규 기본값이 켜짐이 아닙니다.');
  assert.equal(DEFAULT_CONFIG.abyssApostleAlertEnabled, true, '심연의 제2사도 기믹 알림 신규 기본값이 켜짐이 아닙니다.');
  assert.equal(DEFAULT_CONFIG.lokagosAlertEnabled, true, '로카고스 기믹 알림 신규 기본값이 켜짐이 아닙니다.');
}

function checkXpExchangeContracts(): void {
  const { XP_PER_ESSENCE, getEssenceExchangeCount } = require(
    path.join(projectRoot, 'dist', 'modules', 'xpTracker.js'),
  ) as {
    XP_PER_ESSENCE: number;
    getEssenceExchangeCount(amount: number): number;
  };

  assert.equal(XP_PER_ESSENCE, 10_000_000_000);
  assert.equal(getEssenceExchangeCount(-10_000_000_000), 1);
  assert.equal(getEssenceExchangeCount(-20_000_000_000), 2);
  assert.equal(getEssenceExchangeCount(-9_000_000_000), 0,
    '100억 미만의 음수 XP를 경험의 정수 교환으로 오인했습니다.');
  assert.equal(getEssenceExchangeCount(-10_000_000_001), 0,
    '정확한 100억 배수가 아닌 음수 XP를 경험의 정수 교환으로 오인했습니다.');
  assert.equal(getEssenceExchangeCount(10_000_000_000), 0);

  const { updateEssenceWarningAccumulator } = require(
    path.join(projectRoot, 'dist', 'shared', 'experienceEssence.js'),
  ) as {
    updateEssenceWarningAccumulator(currentXp: number, amount: number): {
      accumulatedXp: number;
      exchangeCount: number;
      shouldAlert: boolean;
    };
  };
  let warning = updateEssenceWarningAccumulator(0, 10_999_999_999);
  assert.deepEqual(warning, {
    accumulatedXp: 10_999_999_999,
    exchangeCount: 0,
    shouldAlert: false,
  }, '110억 직전 경고용 경험치에서 알림이 너무 일찍 발생합니다.');
  warning = updateEssenceWarningAccumulator(warning.accumulatedXp, 1);
  assert.equal(warning.shouldAlert, true, '경고용 경험치가 110억에 도달해도 알림이 발생하지 않습니다.');
  warning = updateEssenceWarningAccumulator(warning.accumulatedXp, 9_999_999_999);
  assert.equal(warning.shouldAlert, false, '110억과 210억 사이에서 알림이 반복됩니다.');
  warning = updateEssenceWarningAccumulator(warning.accumulatedXp, 1);
  assert.equal(warning.shouldAlert, true, '교환 없이 210억에 도달한 두 번째 알림이 발생하지 않습니다.');
  warning = updateEssenceWarningAccumulator(warning.accumulatedXp, -10_000_000_000);
  assert.deepEqual(warning, {
    accumulatedXp: 0,
    exchangeCount: 1,
    shouldAlert: false,
  }, '정확한 100억 감소 교환이 경고용 경험치를 0으로 초기화하지 않습니다.');
  warning = updateEssenceWarningAccumulator(5_000_000_000, -9_000_000_000);
  assert.deepEqual(warning, {
    accumulatedXp: 5_000_000_000,
    exchangeCount: 0,
    shouldAlert: false,
  }, '정확한 교환이 아닌 음수 경험치가 경고용 누적을 변경합니다.');

  const trackerSource = read('src/modules/xpTracker.ts');
  assert.doesNotMatch(trackerSource, /_lastAlertTier/,
    '경고용 경험치 경계 외에 별도 알림 상태가 남아 있습니다.');
  assert.match(trackerSource,
    /updateEssenceWarningAccumulator\(this\._essenceWarningXp, data\.amount\)[\s\S]*?if \(!this\._isActive\)/,
    '경고용 경험치가 세션 활성 검사보다 먼저 독립 처리되지 않습니다.');
  assert.doesNotMatch(trackerSource,
    /resetXp\(\)[\s\S]*?this\._essenceWarningXp\s*=\s*0/,
    '세션 초기화가 경고용 경험치까지 초기화합니다.');

  const processorSource = read('src/modules/chatLogProcessor.ts');
  assert.match(processorSource, /const essenceCount = getEssenceExchangeCount\(data\.amount\)/,
    'XP HUD와 모험일지가 서로 다른 경험의 정수 교환 판정을 사용합니다.');
  assert.doesNotMatch(processorSource, /data\.amount <= -9_000_000_000/,
    '모험일지 경로에 기존 90억 교환 판정이 남아 있습니다.');
  assert.doesNotMatch(processorSource,
    /essenceCount > 0\s*&&\s*matchesRegisteredLoot/,
    '경험의 정수 자동 교환 기록이 일반 득템 등록 목록에 종속됩니다.');
  const syncWorkerSource = read('src/modules/chatLogSyncWorker.ts');
  assert.match(syncWorkerSource, /const essenceCount = getEssenceExchangeCount\(evt\.amount\)/,
    '과거 로그와 실시간 로그가 서로 다른 경험의 정수 교환 판정을 사용합니다.');
  assert.doesNotMatch(syncWorkerSource,
    /essenceCount > 0\s*&&\s*matchesRegisteredLoot|evt\.amount <= -9_000_000_000/,
    '과거 로그 경험의 정수 기록이 등록 목록에 종속되거나 90억 근사 판정을 사용합니다.');
  const syncManagerSource = read('src/modules/chatLogSyncManager.ts');
  assert.match(syncManagerSource, /lootMatchingPolicy:\s*3/,
    '기존 버전에서 완료 처리된 과거 로그를 다시 분석해 누락된 경험의 정수를 복원하지 않습니다.');
  assert.match(processorSource,
    /ITEM_LOOT_CONFIG_KEYS = \['lootKeywords'\] as const;[\s\S]*?chatParser\.on\('ITEM_LOOTED'[\s\S]*?config\.loadFields\(ITEM_LOOT_CONFIG_KEYS\)/,
    '고빈도 아이템 획득 경로가 전체 설정 스냅샷을 복사합니다.');
  assert.match(processorSource,
    /TRADE_SHOUT_CONFIG_KEYS =[\s\S]*?chatParser\.on\('TRADE_SHOUT'[\s\S]*?config\.loadFields\(TRADE_SHOUT_CONFIG_KEYS\)/,
    '외치기 경로가 실제 사용하는 설정 필드만 읽지 않습니다.');
  for (const keySet of [
    'SPECIAL_MONSTER_CONFIG_KEYS',
    'ABYSS_TREASURE_CONFIG_KEYS',
    'ETHOS_CONFIG_KEYS',
    'ABYSS_APOSTLE_CONFIG_KEYS',
    'WAVE_WARNING_CONFIG_KEYS',
    'LOKAGOS_CONFIG_KEYS',
  ]) {
    assert.ok(processorSource.includes(`config.loadFields(${keySet})`),
      `읽기 전용 알림 이벤트가 선택 설정 읽기를 사용하지 않습니다: ${keySet}`);
  }
}

function checkAbandonedFeeMatchingContracts(): void {
  const {
    ABANDONED_FEE_MATCH_WINDOW_MS,
    isAbandonedFeeMatchWithinWindow,
  } = require(path.join(projectRoot, 'dist', 'modules', 'abandonedTracker.js')) as {
    ABANDONED_FEE_MATCH_WINDOW_MS: number;
    isAbandonedFeeMatchWithinWindow(firstDetectedAt: number, secondDetectedAt: number): boolean;
  };

  assert.equal(ABANDONED_FEE_MATCH_WINDOW_MS, 15_000);
  assert.equal(isAbandonedFeeMatchWithinWindow(1_000, 15_999), true);
  assert.equal(isAbandonedFeeMatchWithinWindow(1_000, 16_000), false);
  assert.equal(isAbandonedFeeMatchWithinWindow(2_000, 1_000), false);

  const trackerSource = read('src/modules/abandonedTracker.ts');
  assert.match(trackerSource,
    /profit -= data\.amount;[\s\S]*?totalFee \+= data\.amount;[\s\S]*?unassignedFee/,
    '선도착 입장료가 감지 즉시 전체 수익에서 차감되지 않습니다.');
  assert.match(trackerSource, /시간 범위를 지난 입장료는 미귀속으로 유지/,
    '만료된 입장료를 다음 지역에 넘기지 않는 계약이 없습니다.');

  const { abandonedTracker } = require(path.join(projectRoot, 'dist', 'modules', 'abandonedTracker.js'));
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js'));
  abandonedTracker.start();
  abandonedTracker.reset();
  chatParser.emit('ABANDONED_FEE', {
    date: '2099-12-31', timestamp: '23시 59분 00초', amount: 100, message: '입장료',
  });
  let state = abandonedTracker.getState();
  assert.equal(state.profit, -100, '선도착 입장료가 즉시 수익에서 차감되지 않았습니다.');
  assert.equal(state.totalFee, 100);
  assert.equal(state.unassignedFee, 100);

  chatParser.emit('ABANDONED_ENTRY', {
    date: '2099-12-31', timestamp: '23시 59분 01초', region: '테스트 지역', count: 1, message: '입장',
  });
  state = abandonedTracker.getState();
  assert.equal(state.profit, -100, '지역 귀속 과정에서 입장료가 이중 차감되었습니다.');
  assert.equal(state.unassignedFee, 0);
  assert.equal(state.regionDetails['테스트 지역'].totalFee, 100);
  abandonedTracker.reset();

  chatParser.emit('ABANDONED_ENTRY', {
    date: '2099-12-31', timestamp: '23시 59분 02초', region: '후도착 지역', count: 2, message: '입장',
  });
  chatParser.emit('ABANDONED_FEE', {
    date: '2099-12-31', timestamp: '23시 59분 03초', amount: 200, message: '입장료',
  });
  state = abandonedTracker.getState();
  assert.equal(state.profit, -200);
  assert.equal(state.totalFee, 200);
  assert.equal(state.unassignedFee, 0);
  assert.equal(state.regionDetails['후도착 지역'].totalFee, 200,
    '도전 횟수 뒤에 도착한 입장료가 가까운 지역에 귀속되지 않았습니다.');
  abandonedTracker.reset();
}

function checkDigsiteBoardContracts(): void {
  const {
    DIGSITE_BOARD_VISIBLE_MS,
    applyDigsiteBoardEvent,
    createDigsiteBoardState,
    digsiteTracker,
  } = require(path.join(projectRoot, 'dist', 'modules', 'digsiteTracker.js')) as {
    DIGSITE_BOARD_VISIBLE_MS: number;
    applyDigsiteBoardEvent: (state: any, event: any, now: number) => any;
    createDigsiteBoardState: () => any;
    digsiteTracker: { start(): void; reset(): void; getState(): any };
  };
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js'));

  assert.equal(DIGSITE_BOARD_VISIBLE_MS, 5 * 60 * 1_000,
    '발굴지 현황판의 고정 표시 시간이 5분이 아닙니다.');
  const constants = require(path.join(projectRoot, 'dist', 'modules', 'constants.js')) as {
    DEFAULT_CONFIG: { digsiteHudEnabled?: boolean };
  };
  assert.equal(constants.DEFAULT_CONFIG.digsiteHudEnabled, true,
    '기존 사용자에게 발굴지 현황 HUD가 기본 활성화되지 않습니다.');
  const settingsSource = read('src/settings.html');
  assert.match(settingsSource, /id="digsite-hud-enabled-input"/,
    '설정 화면에 발굴지 현황 HUD 사용 여부가 없습니다.');
  assert.match(settingsSource, /digsiteHudEnabled:\s*document\.getElementById\('digsite-hud-enabled-input'\)/,
    '발굴지 현황 HUD 사용 여부가 설정 저장값에 포함되지 않습니다.');
  const startedAt = 1_000;
  const initial = applyDigsiteBoardEvent(createDigsiteBoardState(), { type: 'entry' }, startedAt);
  assert.equal(initial.expiresAt, startedAt + DIGSITE_BOARD_VISIBLE_MS);
  assert.equal(
    applyDigsiteBoardEvent(initial, { type: 'normal-reward' }, initial.expiresAt - 1).isActive,
    true,
    '발굴지 현황판이 고정 표시 시간이 끝나기 전에 종료됩니다.',
  );
  const expired = applyDigsiteBoardEvent(initial, { type: 'normal-reward' }, initial.expiresAt);
  assert.equal(expired.isActive, false, '발굴지 현황판이 고정 표시 시간 뒤에도 활성 상태입니다.');
  assert.equal(expired.normalRewards, 0, '만료 시점에 도착한 로그가 지난 세션에 반영되었습니다.');

  digsiteTracker.start();
  digsiteTracker.reset();
  const line = (message: string, second = 0) =>
    `<font size="2" color="white"> [1시 2분 ${second}초] </font><font size="2" color="#ff64ff">${message}</font></br>`;

  // 입장 전 상자 로그는 다음 판에 이월되면 안 됩니다.
  chatParser.parseLine(line('지역 보상상자를 열었습니다.'));
  assert.equal(digsiteTracker.getState().normalRewards, 0);

  chatParser.parseLine(line('무료 입장 횟수 7회 중 1회째 입장합니다.', 1));
  let state = digsiteTracker.getState();
  assert.equal(state.isActive, true, '기존 발굴지 입장 로그가 현황판을 시작하지 못했습니다.');
  assert.deepEqual(state.portalVisits, { 1: false, 2: false, 3: false, 4: false });

  for (let index = 0; index < 10; index += 1) chatParser.parseLine(line('지역 보상상자를 열었습니다.', 2));
  for (let index = 0; index < 6; index += 1) chatParser.parseLine(line('포탈 전용 상자를 열었습니다.', 3));
  chatParser.parseLine(line('포탈 3지역으로 이동합니다.', 4));
  chatParser.parseLine(line('포탈 1지역으로 이동합니다.', 5));
  chatParser.parseLine(line('포탈 3지역으로 이동합니다.', 6));
  chatParser.parseLine(line('이공간 보물상자를 열었습니다.', 7));
  chatParser.parseLine(line('이공간 보물상자를 열었습니다.', 8));

  state = digsiteTracker.getState();
  assert.equal(state.normalRewards, 8, '일반 지역 보상이 8개 상한에서 멈추지 않습니다.');
  assert.equal(state.portalRewards, 4, '포탈 보상이 4개 상한에서 멈추지 않습니다.');
  assert.equal(state.alternateRewards, 1, '이공간 보상이 1개 상한에서 멈추지 않습니다.');
  assert.deepEqual(state.portalVisits, { 1: true, 2: false, 3: true, 4: false },
    '포탈별 방문 상태가 로그와 일치하지 않습니다.');
  assert.equal(state.expiresAt - state.startedAt, DIGSITE_BOARD_VISIBLE_MS,
    '보상·방문 로그가 들어올 때 발굴지 현황판 만료 시각이 연장되었습니다.');
  digsiteTracker.reset();
}

async function checkMissedMinuteSchedulerContracts(): Promise<void> {
  const { getMissedMinuteTimestamps, MinuteAlignedScheduler } = require(
    path.join(projectRoot, 'dist', 'modules', 'minuteAlignedScheduler.js'),
  ) as {
    getMissedMinuteTimestamps(lastCheckedAt: number, resumedAt: number, maxLookbackMs?: number): number[];
    MinuteAlignedScheduler: new (runtime: any) => {
      start(callback: () => void | Promise<void>, onMissed?: (timestamps: number[]) => void): boolean;
      stop(): void;
    };
  };

  const at = (hour: number, minute: number, second = 0) =>
    new Date(2026, 7, 25, hour, minute, second).getTime();
  assert.deepEqual(
    getMissedMinuteTimestamps(at(10, 0, 10), at(10, 5, 30)),
    [at(10, 1), at(10, 2), at(10, 3), at(10, 4)],
    '절전 중 완전히 지나간 분 목록이 정확하지 않습니다.',
  );
  assert.deepEqual(getMissedMinuteTimestamps(at(10, 5), at(10, 5, 30)), [],
    '복귀한 현재 분을 놓친 알림으로 소급했습니다.');
  assert.deepEqual(getMissedMinuteTimestamps(at(10, 5), at(10, 4)), []);

  function createFakeRuntime(initialNow: number) {
    let now = initialNow;
    let nextTimerId = 1;
    const timers = new Map<number, { callback: () => void; dueAt: number }>();
    const listeners = new Map<string, Set<() => void>>();
    const runtime = {
      now: () => now,
      setTimeout(callback: () => void, delayMs: number) {
        const timerId = nextTimerId++;
        timers.set(timerId, { callback, dueAt: now + delayMs });
        return timerId;
      },
      clearTimeout(timerId: number) {
        timers.delete(timerId);
      },
      onPowerEvent(event: string, listener: () => void) {
        const eventListeners = listeners.get(event) || new Set<() => void>();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      removePowerEventListener(event: string, listener: () => void) {
        listeners.get(event)?.delete(listener);
      },
    };
    return {
      runtime,
      timers,
      setNow(value: number) { now = value; },
      emit(event: string) {
        for (const listener of [...(listeners.get(event) || [])]) listener();
      },
      listenerCount(event: string) { return listeners.get(event)?.size || 0; },
      async runNextTimer() {
        const next = [...timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        assert.ok(next, '실행할 가짜 분 타이머가 없습니다.');
        timers.delete(next[0]);
        now = next[1].dueAt;
        next[1].callback();
        await Promise.resolve();
        await Promise.resolve();
      },
      async flushMicrotasks() {
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  const errorRuntime = createFakeRuntime(at(10, 0, 10));
  const errorScheduler = new MinuteAlignedScheduler(errorRuntime.runtime);
  let callbackRuns = 0;
  const originalConsoleError = console.error;
  let callbackErrors = 0;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('[MinuteAlignedScheduler] callback failed:')) callbackErrors += 1;
    else originalConsoleError(...args);
  };
  try {
    assert.equal(errorScheduler.start(() => {
      callbackRuns += 1;
      if (callbackRuns === 1) throw new Error('expected scheduler fixture failure');
    }), true);
    await errorRuntime.runNextTimer();
    assert.equal(callbackRuns, 1);
    assert.equal(callbackErrors, 1, '스케줄 콜백 예외가 격리되지 않았습니다.');
    assert.equal(errorRuntime.timers.size, 1, '콜백 예외 뒤 다음 분 타이머가 재예약되지 않았습니다.');
    await errorRuntime.runNextTimer();
    assert.equal(callbackRuns, 2, '콜백 예외 뒤 다음 분 실행이 중단되었습니다.');
  } finally {
    console.error = originalConsoleError;
    errorScheduler.stop();
  }

  const resumeRuntime = createFakeRuntime(at(10, 0, 10));
  const resumeScheduler = new MinuteAlignedScheduler(resumeRuntime.runtime);
  let resumeRuns = 0;
  const missedBatches: number[][] = [];
  resumeScheduler.start(() => { resumeRuns += 1; }, timestamps => missedBatches.push(timestamps));
  resumeRuntime.setNow(at(10, 5, 30));
  resumeRuntime.emit('resume');
  resumeRuntime.emit('unlock-screen');
  assert.equal(resumeRuntime.timers.size, 1,
    'resume+unlock 연속 이벤트가 보정 타이머를 둘 이상 남겼습니다.');
  assert.deepEqual(missedBatches.flat(), [at(10, 1), at(10, 2), at(10, 3), at(10, 4)],
    'resume+unlock 연속 이벤트가 놓친 분을 중복 기록했습니다.');
  await resumeRuntime.runNextTimer();
  assert.equal(resumeRuns, 1, 'resume+unlock 연속 이벤트가 현재 분 콜백을 중복 실행했습니다.');
  assert.equal(resumeRuntime.timers.size, 1, '복귀 콜백 뒤 분 정렬 타이머가 하나가 아닙니다.');
  resumeScheduler.stop();
  assert.equal(resumeRuntime.timers.size, 0, 'stop()이 보정/분 타이머를 남겼습니다.');
  assert.equal(resumeRuntime.listenerCount('resume'), 0);
  assert.equal(resumeRuntime.listenerCount('unlock-screen'), 0);

  const slowRuntime = createFakeRuntime(at(11, 0, 10));
  const slowScheduler = new MinuteAlignedScheduler(slowRuntime.runtime);
  let resolveSlowCallback: (() => void) | undefined;
  let slowRuns = 0;
  slowScheduler.start(() => {
    slowRuns += 1;
    return new Promise<void>(resolve => { resolveSlowCallback = resolve; });
  });
  await slowRuntime.runNextTimer();
  assert.equal(slowRuns, 1);
  assert.equal(slowRuntime.timers.size, 0,
    '실행 중인 장기 콜백과 병렬로 다음 callback 타이머가 예약되었습니다.');
  slowRuntime.setNow(at(11, 3, 20));
  assert.ok(resolveSlowCallback);
  resolveSlowCallback();
  await slowRuntime.flushMicrotasks();
  assert.equal(slowRuntime.timers.size, 1,
    '장기 콜백 완료 뒤 현재 시각 기준 다음 분 타이머가 예약되지 않았습니다.');
  await slowRuntime.runNextTimer();
  assert.equal(slowRuns, 2, '장기 콜백 완료 뒤 분 실행이 재개되지 않았습니다.');
  slowScheduler.stop();
}

async function checkAudioPlaybackContracts(): Promise<void> {
  const sandbox: any = {
    window: {},
    console,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(read('dist/assets/audio-playback.js'), sandbox, {
    filename: 'dist/assets/audio-playback.js',
  });

  let monotonicNow = 1_000;
  const throttle = sandbox.window.createSoundThrottle({
    intervalMs: 800,
    maxEntries: 128,
    now: () => monotonicNow,
  });
  assert.equal(throttle.shouldPlay('same.mp3'), true);
  monotonicNow = 1_799;
  assert.equal(throttle.shouldPlay('same.mp3'), false,
    '동일 사운드의 800ms 미만 중복 재생을 허용했습니다.');
  monotonicNow = 1_800;
  assert.equal(throttle.shouldPlay('same.mp3'), true,
    '동일 사운드의 800ms 경계 재생을 차단했습니다.');
  for (let index = 0; index < 200; index += 1) {
    throttle.shouldPlay(`sound-${index}.mp3`);
  }
  assert.equal(throttle.size(), 128, '사운드 throttle Map 상한이 유지되지 않습니다.');

  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const createdAudios: Array<{
    source: string;
    onended: (() => void) | null;
    pauseCalls: number;
    volume: number;
    rejectPlay(error: unknown): void;
  }> = [];
  const controller = sandbox.window.createAudioPlaybackController({
    createCacheToken: () => 'fixture',
    getDefaultVolume: () => 0.35,
    setTimeout(callback: () => void) {
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(timerId: number) {
      timers.delete(timerId);
    },
    createAudio(source: string) {
      let rejectPlay: (error: unknown) => void = () => undefined;
      const audio = {
        source,
        onended: null as (() => void) | null,
        pauseCalls: 0,
        volume: 0,
        pause() { this.pauseCalls += 1; },
        play() {
          return new Promise<void>((_resolve, reject) => { rejectPlay = reject; });
        },
        rejectPlay(error: unknown) { rejectPlay(error); },
      };
      createdAudios.push(audio);
      return audio;
    },
  });

  controller.enqueue({ soundFile: 'first.mp3', volume: 70 });
  assert.equal(createdAudios.length, 1);
  assert.equal(createdAudios[0].source, 'tw-sound://default/first.mp3?t=fixture');
  assert.equal(createdAudios[0].volume, 0.7);
  createdAudios[0].onended?.();
  assert.equal(timers.size, 1, '재생 종료 뒤 다음 큐 전환 타이머가 예약되지 않았습니다.');

  controller.interruptAndPlay({ soundFile: 'custom_preview', volume: null });
  assert.equal(timers.size, 0, '미리보기가 이전 세대의 지연 전환 타이머를 취소하지 않았습니다.');
  assert.equal(createdAudios.length, 2);
  assert.equal(createdAudios[1].source, 'tw-sound://custom/custom_preview?t=fixture');
  assert.equal(createdAudios[1].volume, 0.35);
  createdAudios[0].rejectPlay({ name: 'AbortError' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(createdAudios.length, 2,
    '이전 Audio의 늦은 reject가 새 미리보기 재생을 교체했습니다.');
  assert.equal(createdAudios[1].pauseCalls, 0,
    '이전 Audio callback이 새 미리보기 Audio를 정지했습니다.');

  controller.enqueue({ soundFile: 'queued.mp3', volume: 20 });
  assert.equal(controller.pendingCount(), 1);
  createdAudios[1].onended?.();
  assert.equal(timers.size, 1);
  const transition = [...timers.entries()][0];
  timers.delete(transition[0]);
  transition[1]();
  assert.equal(createdAudios.length, 3, '미리보기 종료 뒤 대기 사운드가 순차 재생되지 않았습니다.');
  assert.equal(createdAudios[2].source, 'tw-sound://default/queued.mp3?t=fixture');
  controller.dispose();
  assert.equal(timers.size, 0);
  assert.equal(createdAudios[2].pauseCalls, 1);

  const indexSource = read('src/index.html');
  assert.match(indexSource, /createSoundThrottle\(\{ intervalMs: 800, maxEntries: 128 \}\)/,
    '사이드바 사운드 throttle이 단조 시계·상한 정책에 연결되지 않았습니다.');
  assert.doesNotMatch(indexSource, /_lastSoundPlayedTimes|const now = Date\.now\(\)/,
    '사이드바 사운드 경로에 벽시계 기반 무상한 throttle이 남았습니다.');
}

function checkViewRequestGenerationContracts(): void {
  const sandbox: any = { window: {} };
  vm.runInNewContext(read('dist/assets/request-generation.js'), sandbox, {
    filename: 'dist/assets/request-generation.js',
  });
  const requests = sandbox.window.createViewRequestGeneration();
  const january = requests.begin('2026-01');
  const february = requests.begin('2026-02');
  assert.equal(requests.isCurrent(january), false,
    '이전 월 요청 토큰이 최신 요청으로 남았습니다.');
  assert.equal(requests.isCurrent(february), true);
  requests.invalidate();
  assert.equal(requests.isCurrent(february), false,
    '탭/화면 전환이 진행 중 요청 토큰을 무효화하지 않았습니다.');

  const diarySource = read('src/diary.html');
  assert.match(diarySource,
    /const request = detailRequests\.begin\(`date:\$\{dateStr\}`\)[\s\S]*?await window\.electronAPI\.diaryGetByDate\(dateStr\)[\s\S]*?!detailRequests\.isCurrent\(request\)/,
    '일간 상세 응답에 날짜 generation guard가 없습니다.');
  assert.match(diarySource,
    /detailRequests\.begin\(`week:[\s\S]*?Promise\.all[\s\S]*?!detailRequests\.isCurrent\(request\)/,
    '주간 상세 응답이 일간 상세와 공유 generation을 사용하지 않습니다.');
  assert.match(diarySource,
    /const \[nextMonthlyData, nextSummary\] = await Promise\.all[\s\S]*?!monthRequests\.isCurrent\(request\)/,
    '월 데이터/요약 응답 역전 guard가 없습니다.');
  assert.match(diarySource,
    /diaryGetMonthlyRevenue\(yearMonth\)[\s\S]*?!statisticsRequests\.isCurrent\(request\)/,
    '통계 차트의 늦은 월 응답 guard가 없습니다.');
  assert.match(diarySource,
    /const renderedDate = selectedDateStr[\s\S]*?diaryRemoveActivity\(rowId\)[\s\S]*?selectedDateStr === renderedDate/,
    'row ID 삭제 완료 뒤 다른 날짜를 잘못 새로고침할 수 있습니다.');
  assert.match(diarySource,
    /singleItem\?\.source === 'manual'[\s\S]*?data-delete-row-id/,
    '단일 마정석 그룹의 manual 원본 row ID 삭제 경계가 없습니다.');
  assert.match(diarySource,
    /it\.source === 'manual'[\s\S]*?data-delete-row-id/,
    '복수 마정석 그룹의 manual 자식 row ID 삭제 경계가 없습니다.');

  const chatSource = read('src/chatOverlayRenderer.ts');
  assert.match(chatSource,
    /const chatViewRequests = window\.createViewRequestGeneration\(\)/,
    '채팅 history/search가 공유 view generation을 만들지 않습니다.');
  assert.match(chatSource,
    /async function executeSearch[\s\S]*?beginChatViewRequest\(`search:[\s\S]*?await window\.electronAPI\.searchChatLogs[\s\S]*?if \(!chatViewRequests\.isCurrent\(request\)\) return;[\s\S]*?catch[\s\S]*?if \(!chatViewRequests\.isCurrent\(request\)\) return;[\s\S]*?finally[\s\S]*?chatViewRequests\.isCurrent\(request\)/,
    '채팅 검색 success/catch/finally의 공유 generation guard가 없습니다.');
  assert.match(chatSource,
    /async function loadHistory[\s\S]*?beginChatViewRequest\(`history:[\s\S]*?await window\.electronAPI\.getChatHistory\(requestedTab\)[\s\S]*?if \(!chatViewRequests\.isCurrent\(request\)\) return;[\s\S]*?catch[\s\S]*?if \(!chatViewRequests\.isCurrent\(request\)\) return;[\s\S]*?finally[\s\S]*?chatViewRequests\.isCurrent\(request\)/,
    '채팅 history success/catch/finally의 공유 generation guard가 없습니다.');
  const liveHandler = chatSource.match(/window\.electronAPI\.onChatUpdated\(\(chatItem\) => \{([\s\S]*?)\n\}\);/)?.[1] || '';
  assert.doesNotMatch(liveHandler, /chatViewRequests/,
    '실시간 이벤트가 view generation을 무효화하고 있습니다.');

  const chatHtml = read('src/chat-overlay.html');
  assert.match(chatHtml,
    /assets\/request-generation\.js[\s\S]*?chatOverlayRenderer\.js/,
    '채팅 화면에서 request generation helper가 렌더러보다 먼저 로드되지 않습니다.');
  assert.match(chatHtml,
    /assets\/virtual-list\.js[\s\S]*?chatOverlayRenderer\.js/,
    '채팅 화면에서 가상 목록 helper가 렌더러보다 먼저 로드되지 않습니다.');
  assert.match(chatSource,
    /createVirtualList<BrowserChatItem>[\s\S]*?appendChatViewItems[\s\S]*?chatVirtualList\.appendItems[\s\S]*?prependChatViewItems[\s\S]*?chatVirtualList\.prependItems/,
    '채팅 history/live/과거 탐색 경로가 가상 목록 메모리 모델을 사용하지 않습니다.');
  assert.doesNotMatch(chatSource, /MAX_HARD_NODES|childNodes\.length\s*>\s*2500|removeChild\(chatArea\.firstChild/,
    '채팅 데이터가 고정 DOM 개수에서 삭제되는 이전 경로가 남았습니다.');

  const virtualListSource = read('src/assets/virtual-list.ts');
  assert.match(virtualListSource,
    /getRenderRange[\s\S]*?overscanPx[\s\S]*?content\.replaceChildren\(fragment\)/,
    '가상 목록이 viewport와 overscan 범위만 DOM으로 만들지 않습니다.');
  assert.match(virtualListSource,
    /getBoundingClientRect\(\)\.height[\s\S]*?heightCache\.set[\s\S]*?restoreAnchor\(anchor\)/,
    '가변 높이 실측과 앵커 복원 경로가 없습니다.');
  assert.match(virtualListSource, /ResizeObserver[\s\S]*?resetMeasurements\(true\)/,
    '채팅 폭 변경 시 높이 캐시를 다시 측정하지 않습니다.');
}

function checkMissedCustomAlertContracts(): void {
  const { getDueCustomAlertsAt } = require(
    path.join(projectRoot, 'dist', 'modules', 'customNotifier.js'),
  ) as {
    getDueCustomAlertsAt(alerts: any[], now: Date): Array<{ message: string; firedKey: string }>;
  };
  const daily = {
    id: 'daily-test', enabled: true, type: 'daily', time: '10:00', offsets: [5, 0],
    message: '일일 테스트', soundFile: 'orb.mp3',
  };
  assert.deepEqual(
    getDueCustomAlertsAt([daily], new Date(2026, 7, 25, 9, 55)).map(due => due.message),
    ['[5분 전] 일일 테스트'],
  );
  assert.deepEqual(
    getDueCustomAlertsAt([daily], new Date(2026, 7, 25, 10, 0)).map(due => due.message),
    ['일일 테스트'],
  );
  const hourly = {
    id: 'hourly-test', enabled: true, type: 'hourly', minute: 10, offsets: [5],
    message: '매시 테스트', soundFile: 'orb.mp3',
  };
  assert.deepEqual(
    getDueCustomAlertsAt([hourly], new Date(2026, 7, 25, 11, 5)).map(due => due.message),
    ['[5분 전] 매시 테스트'],
  );

  const customNotifierSource = read('src/modules/customNotifier.ts');
  assert.match(customNotifierSource,
    /minuteScheduler\.start\(checkAlerts, recordMissedAlerts\)/,
    '커스텀 알림이 절전 중 놓친 분 기록 콜백을 등록하지 않습니다.');
  assert.match(customNotifierSource,
    /'절전 중 놓친 알람'[\s\S]*?diaryDb\.addAlarmLog|diaryDb\.addAlarmLog\([\s\S]*?'절전 중 놓친 알람'/,
    '절전 중 놓친 커스텀 알림을 이력에 기록하지 않습니다.');
}

function checkMissedBossAlertContracts(): void {
  const {
    getDueBossAlertsAt,
    formatBossDateKey,
    getScheduledBossAnalyticsAt,
    takeUntrackedBossAnalytics,
  } = require(
    path.join(projectRoot, 'dist', 'modules', 'bossNotifier.js'),
  ) as {
    getDueBossAlertsAt(config: Record<string, unknown>, now: Date): Array<{ name: string; offset: number }>;
    formatBossDateKey(now: Date): string;
    getScheduledBossAnalyticsAt(now: Date): Array<{ eventName: string; analyticsKey: string }>;
    takeUntrackedBossAnalytics(
      now: Date,
      trackedKeys: Set<string>,
    ): Array<{ eventName: string; analyticsKey: string }>;
  };
  const bossConfig = {
    fieldBossNotifyEnabled: true,
    fieldBossNotifyOffsets: [5, 0],
    fieldBossSettings: {
      골론: { name: '골론', enabled: true, soundFile: 'boss.mp3' },
    },
  };
  assert.deepEqual(
    getDueBossAlertsAt(bossConfig, new Date(2026, 7, 25, 5, 55))
      .map(due => ({ name: due.name, offset: due.offset })),
    [{ name: '골론', offset: 5 }],
  );
  assert.deepEqual(
    getDueBossAlertsAt(bossConfig, new Date(2026, 7, 25, 6, 0))
      .map(due => ({ name: due.name, offset: due.offset })),
    [{ name: '골론', offset: 0 }],
  );
  assert.equal(formatBossDateKey(new Date(2026, 0, 15, 23, 59)), '2026-01-15');
  assert.equal(formatBossDateKey(new Date(2026, 1, 15, 0, 0)), '2026-02-15',
    '보스 알림 정리 날짜 키가 월 경계를 구분하지 않습니다.');
  assert.deepEqual(
    getScheduledBossAnalyticsAt(new Date(2026, 7, 25, 13, 0)),
    [
      { eventName: 'boss_time_골모답', analyticsKey: '2026-08-25 13:00_골모답' },
      { eventName: 'boss_time_혼란한_대지', analyticsKey: '2026-08-25 13:00_혼란한 대지' },
    ],
  );
  const trackedAnalyticsKeys = new Set<string>();
  assert.equal(takeUntrackedBossAnalytics(new Date(2026, 7, 25, 13, 0), trackedAnalyticsKeys).length, 2);
  assert.equal(takeUntrackedBossAnalytics(new Date(2026, 7, 25, 13, 0), trackedAnalyticsKeys).length, 0,
    '같은 분 보스 analytics 재검사가 중복 이벤트를 반환했습니다.');

  const bossSource = read('src/modules/bossNotifier.ts');
  assert.match(bossSource, /minuteScheduler\.start\(checkBossTime, recordMissedBossAlerts\)/,
    '필드보스 알림이 절전 중 놓친 분 기록 콜백을 등록하지 않습니다.');
  assert.match(bossSource, /diaryDb\.addAlarmLog\('boss', '절전 중 놓친 알람'/,
    '절전 중 놓친 필드보스 알림을 이력에 기록하지 않습니다.');
  assert.match(bossSource,
    /takeUntrackedBossAnalytics\(now, _trackedBossAnalyticsKeys\)[\s\S]*?analytics\.trackEvent/,
    '같은 분 재검사에서 보스 analytics 중복 기록을 차단하지 않습니다.');
  assert.match(bossSource, /let _lastCleanupDate = formatBossDateKey\(new Date\(\)\)/,
    '보스 알림 Set 정리 경계가 연-월-일 키를 사용하지 않습니다.');
}

async function checkGoogleSyncDataContracts(): Promise<void> {
  const syncDataHelper = require(path.join(projectRoot, 'dist', 'modules', 'syncDataHelper.js'));

  // 1. extractSyncData: 동기화 대상 필드만 추출하고 로컬 전용 필드(positions, chatLogPath 등)는 제외
  const sampleLocalConfig = {
    userServer: 16,
    lootKeywords: ['샤를란', '엔키라'],
    discordWebhookUrl: 'https://discord.com/api/webhooks/secret-token',
    customSounds: [{ name: '로컬 알림음', file: 'custom_123_local.mp3' }],
    wordAlarmSound: 'custom_123_local.mp3',
    buffTimerSound: 'orb.mp3',
    fieldBossSettings: {
      '골론': { name: '골론', enabled: true, soundFile: 'custom_123_local.mp3' },
      '아칸': { name: '아칸', enabled: true, soundFile: 'orb.mp3' },
    },
    customAlerts: [
      { id: 'custom-alert-1', enabled: true, type: 'daily', time: '12:30', offsets: [0], message: '테스트', soundFile: 'custom_123_local.mp3' },
    ],
    positions: { overlay: { x: 100, y: 100, width: 400, height: 300 } },
    chatLogPath: 'C:\\Nexon\\TalesWeaver\\ChatLog',
    googleSyncLastTime: 123456789,
    googleSyncUserEmail: 'test@gmail.com',
    contentsCheckerItems: [
      {
        id: 'daily-abyss',
        name: '어비스 심층',
        category: '일일 숙제',
        isVisible: true,
        resetRule: { type: 'daily' },
        completedState: {
          'char-1': { isCompleted: true, lastCompletedAt: 1000 },
          'char-2': { isCompleted: false, lastCompletedAt: 500 }
        }
      }
    ],
    characterPresets: [
      { id: 'char-1', name: '보리스' },
      { id: 'char-2', name: '루시안' }
    ],
    pendingHomeworks: [
      { id: 'pending-1', contentId: 'daily-abyss', detectedAt: 900 },
    ],
    contentsAutoAssignSingleCandidate: false,
  };

  const extracted = syncDataHelper.extractSyncData(sampleLocalConfig);
  assert.equal(extracted.userServer, 16);
  assert.deepEqual(extracted.lootKeywords, ['샤를란', '엔키라']);
  assert.equal(extracted.positions, undefined, 'positions 필드가 동기화 데이터에 포함되었습니다.');
  assert.equal(extracted.chatLogPath, undefined, 'chatLogPath 필드가 동기화 데이터에 포함되었습니다.');
  assert.deepEqual(extracted.pendingHomeworks, sampleLocalConfig.pendingHomeworks);
  assert.equal(extracted.discordWebhookUrl, undefined, 'Discord Webhook URL이 동기화 데이터에 포함되었습니다.');
  assert.equal(extracted.wordAlarmSound, undefined, '로컬 커스텀 사운드 ID가 동기화 데이터에 포함되었습니다.');
  assert.equal(extracted.buffTimerSound, 'orb.mp3', '내장 사운드 ID가 동기화 데이터에서 누락되었습니다.');
  assert.equal(extracted.fieldBossSettings['골론'].soundFile, undefined,
    '필드보스 설정의 로컬 커스텀 사운드가 포함되었습니다.');
  assert.equal(extracted.fieldBossSettings['아칸'].soundFile, 'orb.mp3');
  assert.equal(extracted.customAlerts[0].soundFile, undefined,
    '커스텀 알림의 로컬 커스텀 사운드가 포함되었습니다.');

  const settingsData = syncDataHelper.extractSettingsSyncData(sampleLocalConfig);
  const checklistData = syncDataHelper.extractChecklistSyncData(sampleLocalConfig);
  assert.equal(settingsData.contentsCheckerItems, undefined, '설정 파일에 숙제 상태가 섞였습니다.');
  assert.equal(settingsData.characterPresets, undefined, '설정 파일에 캐릭터 프리셋이 섞였습니다.');
  assert.equal(settingsData.contentsAutoAssignSingleCandidate, false,
    '단일 후보 자동 반영 설정이 PC 간 일반 설정 동기화에서 누락되었습니다.');
  assert.equal(checklistData.userServer, undefined, '숙제 파일에 일반 설정이 섞였습니다.');
  assert.equal(checklistData.contentsAutoAssignSingleCandidate, undefined,
    '단일 후보 자동 반영 설정이 숙제 진행 파일에 섞였습니다.');
  assert.deepEqual(checklistData.contentsCheckerItems, sampleLocalConfig.contentsCheckerItems);
  assert.deepEqual(checklistData.characterPresets, sampleLocalConfig.characterPresets);
  assert.deepEqual(checklistData.pendingHomeworks, sampleLocalConfig.pendingHomeworks);

  // 2. buildSyncPayload: 메타데이터 및 스키마 검증
  const payload = syncDataHelper.buildSyncPayload(sampleLocalConfig, 'device-preview-fixture');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.updatedBy, 'device-preview-fixture');
  assert.ok(payload.lastSyncedAt > 0);
  assert.equal(payload.data.userServer, 16);
  assert.equal(syncDataHelper.buildSettingsSyncPayload(sampleLocalConfig, 'device-preview-fixture').data.contentsCheckerItems, undefined);
  assert.equal(syncDataHelper.buildChecklistSyncPayload(sampleLocalConfig, 'tester@gmail.com').data.userServer, undefined);
  const settingsPayload = syncDataHelper.buildSettingsSyncPayload(sampleLocalConfig, 'device-1', 'generation-1');
  assert.equal(settingsPayload.kind, 'settings');
  assert.equal(settingsPayload.generationId, 'generation-1');
  assert.equal(typeof settingsPayload.revision, 'string');
  assert.equal(syncDataHelper.validateSyncPayload(settingsPayload, 'settings'), true);
  assert.equal(syncDataHelper.validateSyncPayload({
    ...settingsPayload,
    data: { ...settingsPayload.data, userServer: 99 },
  }, 'settings'), false, '내용이 바뀐 클라우드 payload의 checksum 검증이 실패하지 않았습니다.');
  assert.equal(syncDataHelper.validateSyncPayload(settingsPayload, 'checklist'), false,
    '설정 파일을 숙제 파일로 잘못 허용했습니다.');
  assert.equal(syncDataHelper.getSyncPayloadCompatibilityIssue({
    ...settingsPayload,
    schemaVersion: 2,
  }, 'settings'), 'schema-version');
  assert.equal(syncDataHelper.getSyncPayloadCompatibilityIssue({
    ...settingsPayload,
    kind: 'checklist',
  }, 'settings'), 'file-kind');
  assert.equal(syncDataHelper.getSyncPayloadCompatibilityIssue({
    ...settingsPayload,
    data: { ...settingsPayload.data, futureSetting: true },
  }, 'settings'), 'unknown-field');
  assert.equal(syncDataHelper.getSyncPayloadCompatibilityIssue({
    ...settingsPayload,
    checksum: 'broken',
  }, 'settings'), null,
  '현재 버전 비호환과 일반 체크섬 손상을 구분하지 못합니다.');

  // 3. mergeSyncData: 숙제 타임스탬프 기반 병합 및 설정 병합 검증
  const cloudPayload = {
    schemaVersion: 1,
    appVersion: '2.7.0',
    lastSyncedAt: 2000,
    updatedBy: 'tester@gmail.com',
    data: {
      userServer: 7, // 하이아칸으로 변경됨
      lootKeywords: ['샤를란', '엔키라', '아퀼루스'],
      contentsCheckerItems: [
        {
          id: 'daily-abyss',
          name: '어비스 심층',
          category: '일일 숙제',
          isVisible: true,
          resetRule: { type: 'daily' },
          completedState: {
            'char-1': { isCompleted: false, lastCompletedAt: 800 }, // 로컬(1000)이 더 최신이므로 로컬 유지되어야 함
            'char-2': { isCompleted: true, lastCompletedAt: 1500 }   // 클라우드(1500)가 더 최신이므로 클라우드 반영되어야 함
          }
        },
        {
          id: 'custom-homework-1',
          name: '신규 커스텀 숙제',
          category: '커스텀',
          isVisible: true,
          isCustom: true,
          resetRule: { type: 'weekly' },
          completedState: {}
        }
      ],
      characterPresets: [
        { id: 'char-1', name: '보리스(수정)' },
        { id: 'char-3', name: '티치엘' } // 신규 캐릭터 추가
      ]
    }
  };

  const merged = syncDataHelper.mergeSyncData(sampleLocalConfig, cloudPayload);

  // 일반 설정 병합 확인
  assert.equal(merged.userServer, 7);
  assert.deepEqual(merged.lootKeywords, ['샤를란', '엔키라', '아퀼루스']);
  // 로컬 전용 설정 유지 확인
  assert.equal(merged.chatLogPath, 'C:\\Nexon\\TalesWeaver\\ChatLog');
  assert.ok(merged.positions?.overlay);

  // 숙제 체크리스트 타임스탬프 기반 병합 검증
  const mergedAbyss = merged.contentsCheckerItems?.find((i: any) => i.id === 'daily-abyss');
  assert.ok(mergedAbyss);
  assert.equal(mergedAbyss.completedState['char-1'].isCompleted, true, '로컬의 최신 완료 기록(1000)이 보존되지 않았습니다.');
  assert.equal(mergedAbyss.completedState['char-1'].lastCompletedAt, 1000);
  assert.equal(mergedAbyss.completedState['char-2'].isCompleted, true, '클라우드의 최신 완료 기록(1500)이 반영되지 않았습니다.');
  assert.equal(mergedAbyss.completedState['char-2'].lastCompletedAt, 1500);

  // 클라우드의 신규 커스텀 숙제 추가 확인
  const customItem = merged.contentsCheckerItems?.find((i: any) => i.id === 'custom-homework-1');
  assert.ok(customItem, '클라우드의 신규 커스텀 숙제가 병합되지 않았습니다.');

  // 캐릭터 프리셋 병합 확인
  assert.equal(merged.characterPresets?.length, 3); // char-1, char-2, char-3
  assert.ok(merged.characterPresets?.some((c: any) => c.id === 'char-3'));

  const secretCloudPayload = {
    ...cloudPayload,
    data: {
      discordWebhookUrl: 'https://discord.com/api/webhooks/remote-secret',
      wordAlarmSound: 'C:\\Users\\remote\\secret.mp3',
      fieldBossSettings: {
        '골론': { name: '골론', enabled: false, soundFile: 'custom_remote.mp3' },
      },
      customAlerts: [
        { id: 'custom-alert-1', enabled: false, type: 'daily', time: '13:30', offsets: [0], message: '원격 변경', soundFile: 'custom_remote.mp3' },
      ],
    },
  };
  const secretMerged = syncDataHelper.mergeSyncData(sampleLocalConfig, secretCloudPayload);
  assert.equal(secretMerged.discordWebhookUrl, sampleLocalConfig.discordWebhookUrl,
    '비정상 클라우드 payload가 로컬 Webhook URL을 덮었습니다.');
  assert.equal(secretMerged.wordAlarmSound, sampleLocalConfig.wordAlarmSound,
    '원격 로컬 사운드 경로가 현재 PC 설정을 덮었습니다.');
  assert.equal(secretMerged.fieldBossSettings['골론'].soundFile, 'custom_123_local.mp3');
  assert.equal(secretMerged.fieldBossSettings['골론'].enabled, false);
  assert.equal(secretMerged.customAlerts[0].soundFile, 'custom_123_local.mp3');
  assert.equal(secretMerged.customAlerts[0].message, '원격 변경');

  const baseChecklist = {
    contentsCheckerItems: [
      {
        id: 'daily-abyss', name: '어비스 심층', category: '일일 숙제', isVisible: true,
        resetRule: { type: 'daily' },
        completedState: {
          'char-1': { isCompleted: false, currentCount: 0 },
          'char-2': { isCompleted: false, currentCount: 0 },
          'char-3': { isCompleted: false, currentCount: 0 },
        },
      },
      {
        id: 'custom-deleted-remotely', name: '원격 삭제', category: '커스텀', isVisible: true,
        isCustom: true, resetRule: { type: 'weekly' }, completedState: {},
      },
    ],
    characterPresets: [
      { id: 'char-1', name: '보리스' }, { id: 'char-2', name: '루시안' }, { id: 'char-3', name: '티치엘' },
    ],
    pendingHomeworks: [],
  };
  const threeWayLocal = {
    ...sampleLocalConfig,
    contentsCheckerItems: JSON.parse(JSON.stringify(baseChecklist.contentsCheckerItems)),
    characterPresets: JSON.parse(JSON.stringify(baseChecklist.characterPresets)),
    pendingHomeworks: [],
  };
  threeWayLocal.contentsCheckerItems[0].completedState['char-2'] = { isCompleted: true, currentCount: 1, lastCompletedAt: 2000 };
  threeWayLocal.contentsCheckerItems[0].completedState['char-3'] = { isCompleted: true, currentCount: 1, lastCompletedAt: 2100 };
  const remoteChecklist = JSON.parse(JSON.stringify(baseChecklist));
  remoteChecklist.contentsCheckerItems = remoteChecklist.contentsCheckerItems.filter((item: any) => item.id !== 'custom-deleted-remotely');
  remoteChecklist.contentsCheckerItems[0].completedState['char-1'] = { isCompleted: true, currentCount: 1, lastCompletedAt: 1900 };
  remoteChecklist.contentsCheckerItems[0].completedState['char-3'] = { isCompleted: true, currentCount: 2, lastCompletedAt: 2200 };
  const threeWay = syncDataHelper.mergeChecklistThreeWay(baseChecklist, threeWayLocal, remoteChecklist);
  const threeWayItem = threeWay.contentsCheckerItems.find((item: any) => item.id === 'daily-abyss');
  assert.equal(threeWayItem.completedState['char-1'].currentCount, 1,
    '원격 PC에서만 바뀐 숙제 완료가 로컬에 반영되지 않았습니다.');
  assert.equal(threeWayItem.completedState['char-2'].currentCount, 1,
    '로컬 PC에서만 바뀐 숙제 완료가 보존되지 않았습니다.');
  assert.equal(threeWayItem.completedState['char-3'].currentCount, 1,
    '양쪽에서 같은 숙제 필드를 바꾼 충돌에서 로컬 우선 정책이 지켜지지 않았습니다.');
  assert.equal(threeWay.contentsCheckerItems.some((item: any) => item.id === 'custom-deleted-remotely'), false,
    '원격에서만 삭제한 커스텀 숙제가 다시 살아났습니다.');

  // 교차 업로드에서 먼저 확인된 payload가 직후 다른 PC에 의해 덮인 경우를 재현한다.
  // 회사 PC의 base/local은 이미 자신의 완료를 확인한 상태이고, 원격에는 집 PC의
  // 서로 다른 완료만 남아 있다. operation 재게시 전에 두 변경을 모두 복구해야 한다.
  const crossedCompanyBase = JSON.parse(JSON.stringify(baseChecklist));
  crossedCompanyBase.contentsCheckerItems[0].completedState['char-1'] = {
    isCompleted: true, currentCount: 1, lastCompletedAt: 3000,
  };
  const crossedCompanyLocal = {
    ...sampleLocalConfig,
    ...JSON.parse(JSON.stringify(crossedCompanyBase)),
  };
  const crossedHomeRemote = JSON.parse(JSON.stringify(baseChecklist));
  crossedHomeRemote.contentsCheckerItems[0].completedState['char-2'] = {
    isCompleted: true, currentCount: 1, lastCompletedAt: 3100,
  };
  const companyOperation = {
    id: 'operation-company-complete',
    deviceId: 'company-pc',
    createdAt: 3000,
    keys: ['contentsCheckerItems'],
    mutations: syncDataHelper.createChecklistOperationMutations(baseChecklist, crossedCompanyBase),
  };
  const crossedRemoteWithReplay = syncDataHelper.replayChecklistOperations(
    crossedHomeRemote,
    [companyOperation],
  );
  const crossedMerged = syncDataHelper.mergeChecklistThreeWay(
    crossedCompanyBase,
    crossedCompanyLocal,
    crossedRemoteWithReplay,
  );
  const crossedItem = crossedMerged.contentsCheckerItems.find((item: any) => item.id === 'daily-abyss');
  assert.equal(crossedItem.completedState['char-1'].isCompleted, true,
    '업로드 확인 직후 다른 PC가 덮어쓰면 먼저 확인된 회사 PC 완료가 사라집니다.');
  assert.equal(crossedItem.completedState['char-2'].isCompleted, true,
    '교차 업로드 복구 중 집 PC의 서로 다른 완료가 사라집니다.');

  const crossConflictCases = [
    {
      name: '완료/횟수 충돌',
      base: { isCompleted: false, currentCount: 0 },
      company: { isCompleted: true, currentCount: 1, lastCompletedAt: 4000 },
      home: { isCompleted: false, currentCount: 2, lastCompletedAt: 4100 },
    },
    {
      name: '완료 해제/재완료 충돌',
      base: { isCompleted: true, currentCount: 1, lastCompletedAt: 4200 },
      company: { isCompleted: false, currentCount: 0, lastCompletedAt: 4200 },
      home: { isCompleted: true, currentCount: 2, lastCompletedAt: 4300 },
    },
    {
      name: '횟수 감소/증가 충돌',
      base: { isCompleted: false, currentCount: 2, lastCompletedAt: 4400 },
      company: { isCompleted: false, currentCount: 1, lastCompletedAt: 4400 },
      home: { isCompleted: true, currentCount: 3, lastCompletedAt: 4500 },
    },
  ];
  for (const [index, fixture] of crossConflictCases.entries()) {
    const conflictBase = JSON.parse(JSON.stringify(baseChecklist));
    conflictBase.contentsCheckerItems[0].completedState['char-1'] = fixture.base;
    const conflictCompany = JSON.parse(JSON.stringify(conflictBase));
    conflictCompany.contentsCheckerItems[0].completedState['char-1'] = fixture.company;
    const conflictHome = JSON.parse(JSON.stringify(conflictBase));
    conflictHome.contentsCheckerItems[0].completedState['char-1'] = fixture.home;
    const homeOperation = {
      id: `operation-home-${index}`,
      deviceId: 'home-pc',
      createdAt: 5000 + index,
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(conflictBase, conflictHome),
    };
    const replayedCompanyOperation = JSON.parse(JSON.stringify({
      id: `operation-company-${index}`,
      deviceId: 'company-pc',
      createdAt: 5100 + index,
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(conflictBase, conflictCompany),
    }));
    const convergedRemote = syncDataHelper.replayChecklistOperations(conflictHome, [replayedCompanyOperation]);
    const companyLocal = syncDataHelper.mergeChecklistThreeWay(conflictCompany, {
      ...sampleLocalConfig,
      ...conflictCompany,
    }, convergedRemote);
    const homeLocal = syncDataHelper.mergeChecklistThreeWay(conflictHome, {
      ...sampleLocalConfig,
      ...conflictHome,
    }, convergedRemote);
    assert.deepEqual(companyLocal, homeLocal, `${fixture.name}에서 회사/집 상태가 수렴하지 않았습니다.`);
    const finalPayload = syncDataHelper.buildChecklistSyncPayload({
      ...sampleLocalConfig,
      ...convergedRemote,
    }, 'company-pc', 'generation-cross', [homeOperation, replayedCompanyOperation]);
    assert.equal(syncDataHelper.validateSyncPayload(finalPayload, 'checklist'), true,
      `${fixture.name}의 재수렴 payload가 검증을 통과하지 못했습니다.`);
    assert.deepEqual(finalPayload.operations.map((operation: any) => operation.id),
      [homeOperation.id, replayedCompanyOperation.id],
      `${fixture.name}의 최종 원격 payload에 두 operation ID가 남지 않았습니다.`);
  }

  // 고정 fixture 밖의 완료/해제/횟수/operation 순서 조합도 결정론적으로 반복 검증한다.
  for (let index = 0; index < 256; index++) {
    const stressBase = JSON.parse(JSON.stringify(baseChecklist));
    const baseCount = index % 4;
    stressBase.contentsCheckerItems[0].completedState['char-1'] = {
      isCompleted: baseCount === 3,
      currentCount: baseCount,
      lastCompletedAt: 10_000 + index * 10,
    };
    stressBase.contentsCheckerItems[0].completedState['char-2'] = {
      isCompleted: false,
      currentCount: 0,
      lastCompletedAt: 10_000 + index * 10,
    };

    const companyChecklist = JSON.parse(JSON.stringify(stressBase));
    const companyCount = (baseCount + 1 + (index % 2)) % 4;
    companyChecklist.contentsCheckerItems[0].completedState['char-1'] = {
      isCompleted: companyCount === 3 || index % 5 === 0,
      currentCount: companyCount,
      lastCompletedAt: 10_001 + index * 10,
    };

    const sameFieldConflict = index % 3 !== 0;
    const homeCharacterId = sameFieldConflict ? 'char-1' : 'char-2';
    const homeChecklist = JSON.parse(JSON.stringify(stressBase));
    const homeCount = (baseCount + 2 + (index % 2)) % 4;
    homeChecklist.contentsCheckerItems[0].completedState[homeCharacterId] = {
      isCompleted: homeCount === 3 || index % 7 === 0,
      currentCount: homeCount,
      lastCompletedAt: 10_002 + index * 10,
    };

    const companyOperation = {
      id: `stress-company-${index}`,
      deviceId: 'company-pc',
      createdAt: 20_000 + index * 2 + (index % 2),
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(stressBase, companyChecklist),
    };
    const homeOperation = {
      id: `stress-home-${index}`,
      deviceId: 'home-pc',
      createdAt: 20_000 + index * 2 + (index % 2 === 0 ? 1 : 0),
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(stressBase, homeChecklist),
    };
    const companyFirst = syncDataHelper.replayChecklistOperations(
      stressBase, [companyOperation, homeOperation],
    );
    const homeFirst = syncDataHelper.replayChecklistOperations(
      stressBase, [homeOperation, companyOperation],
    );
    assert.deepEqual(companyFirst, homeFirst,
      `교차 stress ${index}에서 operation 입력 순서에 따라 원격 결과가 달라졌습니다.`);

    if (!sameFieldConflict) {
      const convergedItem = companyFirst.contentsCheckerItems
        .find((item: any) => item.id === 'daily-abyss');
      assert.deepEqual(convergedItem.completedState['char-1'],
        companyChecklist.contentsCheckerItems[0].completedState['char-1'],
        `교차 stress ${index}에서 회사 PC의 비충돌 변경이 사라졌습니다.`);
      assert.deepEqual(convergedItem.completedState['char-2'],
        homeChecklist.contentsCheckerItems[0].completedState['char-2'],
        `교차 stress ${index}에서 집 PC의 비충돌 변경이 사라졌습니다.`);
    }

    const companyBase = syncDataHelper.replayChecklistOperations(stressBase, [companyOperation]);
    const homeBase = syncDataHelper.replayChecklistOperations(stressBase, [homeOperation]);
    const convergedCompany = syncDataHelper.mergeChecklistThreeWay(companyBase, {
      ...sampleLocalConfig,
      ...companyBase,
    }, companyFirst);
    const convergedHome = syncDataHelper.mergeChecklistThreeWay(homeBase, {
      ...sampleLocalConfig,
      ...homeBase,
    }, companyFirst);
    assert.deepEqual(convergedCompany, convergedHome,
      `교차 stress ${index}에서 회사/집 로컬 상태가 수렴하지 않았습니다.`);

    const stressPayload = syncDataHelper.buildChecklistSyncPayload({
      ...sampleLocalConfig,
      ...companyFirst,
    }, 'stress-pc', 'generation-stress', [homeOperation, companyOperation]);
    assert.equal(syncDataHelper.validateSyncPayload(stressPayload, 'checklist'), true,
      `교차 stress ${index}의 최종 payload가 검증을 통과하지 못했습니다.`);
    assert.deepEqual(new Set(stressPayload.operations.map((operation: any) => operation.id)),
      new Set([companyOperation.id, homeOperation.id]),
      `교차 stress ${index}의 최종 payload에 두 operation ID가 남지 않았습니다.`);
  }

  // 캐릭터 선택 전 같은 숙제/리셋 주기를 두 PC가 동시에 감지하면 하나의 pending 키가 충돌한다.
  // 이 단계에서는 어느 캐릭터의 플레이인지 판단할 수 없으므로 operation의 결정적 순서에서
  // 마지막 값을 선택한다. 입력 배열 순서와 무관하게 같은 값으로 수렴하고 두 operation은 보존한다.
  const pendingCollisionBase = JSON.parse(JSON.stringify(baseChecklist));
  pendingCollisionBase.pendingHomeworks = [];
  const companyPending = JSON.parse(JSON.stringify(pendingCollisionBase));
  companyPending.pendingHomeworks = [{
    id: 'daily-abyss', count: 1, isIncrement: true, timestamp: 30_000,
    sourceEventIds: ['pending-company-event'], resetCycleKey: 'daily:2026-08-26',
  }];
  const homePending = JSON.parse(JSON.stringify(pendingCollisionBase));
  homePending.pendingHomeworks = [{
    id: 'daily-abyss', count: 1, isIncrement: true, timestamp: 30_001,
    sourceEventIds: ['pending-home-event'], resetCycleKey: 'daily:2026-08-26',
  }];
  const companyPendingOperation = {
    id: 'pending-company-detected',
    deviceId: 'company-pc',
    createdAt: 30_000,
    keys: ['pendingHomeworks'],
    mutations: syncDataHelper.createChecklistOperationMutations(pendingCollisionBase, companyPending),
  };
  const homePendingOperation = {
    id: 'pending-home-detected',
    deviceId: 'home-pc',
    createdAt: 30_001,
    keys: ['pendingHomeworks'],
    mutations: syncDataHelper.createChecklistOperationMutations(pendingCollisionBase, homePending),
  };
  const pendingCompanyFirst = syncDataHelper.replayChecklistOperations(
    pendingCollisionBase, [companyPendingOperation, homePendingOperation],
  );
  const pendingHomeFirst = syncDataHelper.replayChecklistOperations(
    pendingCollisionBase, [homePendingOperation, companyPendingOperation],
  );
  assert.deepEqual(pendingCompanyFirst, pendingHomeFirst,
    '동일 숙제 pending 충돌이 operation 입력 순서에 따라 다른 값으로 수렴했습니다.');
  assert.deepEqual(pendingCompanyFirst.pendingHomeworks, homePending.pendingHomeworks,
    '동일 숙제 pending 충돌에서 결정적 operation 순서의 마지막 값이 선택되지 않았습니다.');
  const pendingCollisionPayload = syncDataHelper.buildChecklistSyncPayload({
    ...sampleLocalConfig,
    ...pendingCompanyFirst,
  }, 'pending-policy-pc', 'generation-pending-policy', [
    homePendingOperation, companyPendingOperation,
  ]);
  assert.equal(syncDataHelper.validateSyncPayload(pendingCollisionPayload, 'checklist'), true,
    '동일 숙제 pending 충돌의 최종 payload가 검증을 통과하지 못했습니다.');
  assert.deepEqual(new Set(pendingCollisionPayload.operations.map((operation: any) => operation.id)),
    new Set([companyPendingOperation.id, homePendingOperation.id]),
    '동일 숙제 pending 충돌의 최종 payload에 두 operation ID가 남지 않았습니다.');

  // 각 PC에서 팝업의 캐릭터를 선택한 뒤에는 완료 상태가 서로 다른 characterId 경로가 된다.
  // 감지/선택 operation 네 개가 교차해도 양쪽 캐릭터 완료와 pending 제거를 모두 보존한다.
  const companySelected = JSON.parse(JSON.stringify(companyPending));
  companySelected.pendingHomeworks = [];
  companySelected.contentsCheckerItems[0].completedState['char-1'] = {
    isCompleted: true, currentCount: 1, lastCompletedAt: 30_002,
  };
  const homeSelected = JSON.parse(JSON.stringify(homePending));
  homeSelected.pendingHomeworks = [];
  homeSelected.contentsCheckerItems[0].completedState['char-2'] = {
    isCompleted: true, currentCount: 1, lastCompletedAt: 30_003,
  };
  const companySelectionOperation = {
    id: 'pending-company-selected-char-1',
    deviceId: 'company-pc',
    createdAt: 30_002,
    keys: ['contentsCheckerItems', 'pendingHomeworks'],
    mutations: syncDataHelper.createChecklistOperationMutations(companyPending, companySelected),
  };
  const homeSelectionOperation = {
    id: 'pending-home-selected-char-2',
    deviceId: 'home-pc',
    createdAt: 30_003,
    keys: ['contentsCheckerItems', 'pendingHomeworks'],
    mutations: syncDataHelper.createChecklistOperationMutations(homePending, homeSelected),
  };
  const selectionOperations = [
    homeSelectionOperation,
    companyPendingOperation,
    companySelectionOperation,
    homePendingOperation,
  ];
  const selectedResult = syncDataHelper.replayChecklistOperations(
    pendingCollisionBase, selectionOperations,
  );
  const selectedItem = selectedResult.contentsCheckerItems
    .find((item: any) => item.id === 'daily-abyss');
  assert.equal(selectedItem.completedState['char-1'].isCompleted, true,
    '회사 PC에서 선택한 캐릭터의 숙제 완료가 교차 pending 병합에서 사라졌습니다.');
  assert.equal(selectedItem.completedState['char-2'].isCompleted, true,
    '집 PC에서 선택한 캐릭터의 숙제 완료가 교차 pending 병합에서 사라졌습니다.');
  assert.deepEqual(selectedResult.pendingHomeworks, [],
    '양쪽 캐릭터 선택이 끝난 뒤 pending 항목이 다시 나타났습니다.');
  const selectedResultReversed = syncDataHelper.replayChecklistOperations(
    pendingCollisionBase, [...selectionOperations].reverse(),
  );
  assert.deepEqual(selectedResult, selectedResultReversed,
    '캐릭터 선택 operation 교차 결과가 입력 순서에 따라 달라졌습니다.');

  const dirtySettingsMerged = syncDataHelper.mergeSettingsSnapshot(sampleLocalConfig, settingsPayload, ['userServer']);
  assert.equal(dirtySettingsMerged.userServer, sampleLocalConfig.userServer,
    '아직 업로드하지 않은 로컬 설정이 원격 pull에 의해 사라졌습니다.');

  const driveSource = read('src/modules/googleDriveSync.ts');
  assert.match(driveSource, /SETTINGS_SYNC_FILE_NAME = 'tw_overlay_settings\.json'/);
  assert.match(driveSource, /CHECKLIST_SYNC_FILE_NAME = 'tw_overlay_checklist\.json'/);
  assert.match(driveSource, /META_SYNC_FILE_NAME = 'tw_overlay_sync_meta\.json'/);
  assert.match(driveSource, /export async function findSyncFileByName\(fileName: string\)/,
    '파일 분리를 위한 이름별 Drive 검색 경계가 없습니다.');
  assert.match(driveSource, /export async function uploadJsonPayload\(/,
    '파일 분리를 위한 범용 JSON 업로드 경계가 없습니다.');
  assert.doesNotMatch(driveSource, /tw_overlay_sync\.json|LEGACY_SYNC_FILE_NAME|findSyncFile\(|downloadSyncPayload\(|uploadSyncPayload\(/,
    'Drive 모듈에 개발 중 단일 파일 호환 API가 남아 있습니다.');

  const managerSource = read('src/modules/cloudSyncManager.ts');
  assert.doesNotMatch(managerSource, /findSyncFile\(|uploadSyncPayload\(|downloadSyncPayload\(/,
    '클라우드 매니저가 개발 중 단일 파일 경로를 계속 사용합니다.');
  assert.match(managerSource, /SETTINGS_DEBOUNCE_MS = 1_500/);
  assert.match(managerSource, /CHECKLIST_DEBOUNCE_MS = 500/);
  assert.match(managerSource, /GAME_RUNNING_PULL_MS = 30_000/,
    '게임 실행 중 다른 PC 변경을 받아오는 30초 pull 주기가 없습니다.');
  assert.match(managerSource, /mergeChecklistThreeWay/,
    '마지막 정상 동기화본 기준 숙제 3방향 병합이 실제 전송 경로에 연결되지 않았습니다.');
  assert.match(managerSource, /checklistOutbox/,
    '숙제 변경의 내구 outbox가 실제 전송 경로에 연결되지 않았습니다.');
  assert.match(managerSource, /verifiedIds[\s\S]*?outboxIds\.some/,
    '숙제 operation이 원격에서 확인되기 전에 outbox를 제거할 수 있습니다.');
  assert.match(managerSource, /prepareShutdownRecovery[\s\S]*?shutdownRecovery/,
    '종료 전 파일별 클라우드 recovery marker를 저장하지 않습니다.');
  assert.match(managerSource, /reconcileShutdownRecovery[\s\S]*?operationIds\.every/,
    '다음 실행에서 확인된 숙제 operation 기준으로 recovery marker를 정리하지 않습니다.');
  assert.match(managerSource, /export async function loginAndInit\(\)[\s\S]*?startBackgroundSync\(\);[\s\S]*?await syncFromCloud\(false\)/,
    'Google 로그인 완료 뒤 scheduler 시작과 최초 즉시 pull이 연결되지 않았습니다.');
  assert.match(managerSource, /enqueueTransfer\(`\$\{kind\} 자동 업로드`, 'upload'/,
    '자동 업로드 상태가 사용자에게 업로드로 구분되지 않습니다.');
  assert.match(managerSource, /useRestoreFlow \? 'download' : 'checking'/,
    '클라우드 불러오기와 원격 변경 확인 상태가 구분되지 않습니다.');
  assert.match(managerSource, /result\.success[\s\S]*?import\('\.\/contentsChecker'\)[\s\S]*?contentsChecker\.checkReset\(\)/,
    '클라우드 숙제 적용 완료 뒤 현재 리셋 주기 정규화가 연결되지 않았습니다.');

  const contentsCheckerSource = read('src/modules/contentsChecker.ts');
  assert.match(contentsCheckerSource,
    /function scheduleNextResetCheck[\s\S]*?getNextHomeworkResetAt[\s\S]*?setTimeout\([\s\S]*?checkReset\(\)/,
    '앱을 계속 켜 둔 경우 다음 일일·주간 리셋 경계를 다시 검사하지 않습니다.');

  const mainSource = read('src/main.ts');
  assert.match(mainSource, /const decision = shutdownGate\.requestQuit\(\);[\s\S]*?decision === 'allow'[\s\S]*?event\.preventDefault\(\);[\s\S]*?decision === 'wait'/,
    'flush 중 두 번째 quit가 종료 finalizer를 우회할 수 있습니다.');
  assert.match(mainSource, /wm\.hideAllForShutdown\(\)[\s\S]*?config\.hasPending\(\)/,
    '종료 flush 전에 모든 창을 즉시 숨기지 않습니다.');
  assert.match(mainSource, /outcome !== 'flushed'[\s\S]*?cancelPendingShutdownRequests/,
    '종료 flush 시간초과·실패 시 진행 중인 Drive 요청을 취소하지 않습니다.');
  assert.match(mainSource, /diaryDb\.checkpointWal\(\);\s*if \(!diaryDb\.closeDb\(\)\)/,
    '종료 시 WAL checkpoint 후 DB를 닫지 않습니다.');
  assert.match(mainSource, /browser-window-created[\s\S]*?query-session-end[\s\S]*?prepareFastSessionEnd/,
    'Windows 로그오프·시스템 종료 fast path가 창에 등록되지 않았습니다.');
  assert.match(mainSource, /function prepareFastSessionEnd[\s\S]*?config\.hasPending\(\)[\s\S]*?prepareShutdownRecovery\(\)[\s\S]*?flushPendingElso\(\)[\s\S]*?checkpointWal\(\)/,
    'Windows 세션 종료 전에 config·클라우드 marker·DB 상태를 동기 저장하지 않습니다.');
  assert.match(mainSource, /startBackgroundSync\(\);\s*cloudSync\.syncFromCloud\(false\)/,
    '앱 시작 시 로그인된 자동 동기화 프로필의 즉시 pull이 연결되지 않았습니다.');
  assert.match(mainSource, /powerMonitor\.on\('resume',[\s\S]*?requestImmediatePull\('system-resume'\)/,
    '절전 복귀가 클라우드 즉시 pull에 연결되지 않았습니다.');
  assert.match(mainSource, /powerMonitor\.on\('unlock-screen',[\s\S]*?requestImmediatePull\('screen-unlock'\)/,
    '잠금 해제가 클라우드 즉시 pull에 연결되지 않았습니다.');
  assert.match(mainSource, /let wasNetworkOnline = net\.isOnline\(\)[\s\S]*?!wasNetworkOnline && isNetworkOnline[\s\S]*?requestImmediatePull\('network-reconnected'\)[\s\S]*?10_000/,
    '10초 네트워크 복구 감지가 클라우드 즉시 pull에 연결되지 않았습니다.');
  const pollingSource = read('src/modules/pollingLoop.ts');
  assert.match(pollingSource, /gameJustStarted[\s\S]*?requestImmediatePull\('game-started'\)/,
    '게임 시작 전환이 클라우드 즉시 pull에 연결되지 않았습니다.');
  const ipcSource = read('src/modules/ipcHandlers.ts');
  assert.match(ipcSource, /google-sync-toggle-auto[\s\S]*?refreshBackgroundSchedule\(\)[\s\S]*?if \(enabled\) cloudSync\.requestImmediatePull\('auto-sync-enabled'\)/,
    '자동 동기화 활성화가 scheduler 갱신과 즉시 pull에 연결되지 않았습니다.');
  const settingsSource = read('src/settings.html');
  assert.doesNotMatch(settingsSource, /tw_overlay_sync\.json/,
    'Google 동기화 UI가 개발 중 단일 파일명을 표시합니다.');
  assert.match(settingsSource, /일반 설정과 숙제 체크리스트만 동기화합니다\.[\s\S]*?모험일지·채팅 로그 원본·알림 이력/,
    '설정 화면에 클라우드 동기화 제외 사용자 데이터 안내가 없습니다.');
  assert.match(settingsSource, /GOOGLE_SYNC_FILE_LABEL = 'tw_overlay_settings\.json, tw_overlay_checklist\.json'/,
    'Google 동기화 UI의 정식 분리 파일 fallback이 없습니다.');
  assert.match(settingsSource, /id="btn-google-logout"[\s\S]*?연결 해제/,
    'Google 계정 연결 해제 버튼이 계정 영역에 없습니다.');
  assert.match(settingsSource, /id="btn-google-backup"[^>]+data-settings-tooltip="[^"]*Google Drive에 바로 저장/,
    '지금 저장 버튼에 클라우드 저장 설명이 없습니다.');
  assert.match(settingsSource, /id="btn-google-restore"[^>]+data-settings-tooltip="[^"]*이 PC로 불러옵니다/,
    '불러오기 버튼에 클라우드 복원 설명이 없습니다.');
  assert.match(settingsSource, /id="settings-custom-tooltip"[^>]+role="tooltip"/,
    'Google 동기화 버튼의 커스텀 툴팁 컨테이너가 없습니다.');
  assert.match(settingsSource, /previewButton[\s\S]*?setSettingsCustomTooltip\(previewButton/,
    '파일별 데이터 확인 버튼이 커스텀 툴팁을 사용하지 않습니다.');
  assert.match(settingsSource, /setSettingsCustomTooltip\(rollbackBtn/,
    '마지막 불러오기 되돌리기 버튼이 커스텀 툴팁을 사용하지 않습니다.');
  assert.doesNotMatch(settingsSource, /btn-google-preview[^>]+title=|previewButton\.title|rollbackBtn\.title|local\.title|cloud\.title|retry\.title/,
    'Google 동기화 영역에 브라우저 기본 title 툴팁이 남아 있습니다.');

  const shutdownCoordinator = require(path.join(projectRoot, 'dist', 'modules', 'shutdownCoordinator.js'));
  const shutdownGate = shutdownCoordinator.createShutdownGate();
  assert.equal(shutdownGate.requestQuit(), 'start');
  assert.equal(shutdownGate.requestQuit(), 'wait');
  shutdownGate.allowFinalQuit();
  assert.equal(shutdownGate.requestQuit(), 'allow');
  assert.equal(await shutdownCoordinator.drainShutdownTask(Promise.resolve(), 50), 'flushed');
  assert.equal(await shutdownCoordinator.drainShutdownTask(Promise.reject(new Error('forced shutdown failure')), 50), 'failed');
  assert.equal(await shutdownCoordinator.drainShutdownTask(new Promise(() => undefined), 5), 'timeout');

  const authSource = read('src/modules/googleAuth.ts');
  assert.match(authSource, /const loginGeneration = \+\+_loginGeneration/,
    '취소된 OAuth 콜백의 늦은 토큰 저장을 막는 로그인 세대가 없습니다.');
  assert.match(authSource, /tokens\.access_token && tokens\.expiry_date[\s\S]*?if \(!tokens\.refresh_token\)/,
    '유효 access token만 있는 세션을 refresh token 검사보다 먼저 허용하지 않습니다.');
  assert.match(authSource, /if \(!tokens\.refresh_token\)[\s\S]*?invalidateAuth\(\)/,
    '만료된 access token에 refresh token이 없을 때 재로그인 필요 상태로 전환하지 않습니다.');
  const cloudManagerSource = read('src/modules/cloudSyncManager.ts');
  assert.match(cloudManagerSource, /reauthRequired:\s*!isLinked[\s\S]*?googleSyncEnabled === true/,
    '토큰 만료와 사용자의 명시적 연결 해제를 구분하는 상태가 없습니다.');
  assert.match(cloudManagerSource, /SyncFileCompatibilityError[\s\S]*?status:\s*'incompatible'/,
    '현재 버전 비호환 파일을 일반 손상과 다른 파일별 상태로 기록하지 않습니다.');
  const authInvalidatedHandler = cloudManagerSource.match(
    /googleAuth\.setOnAuthInvalidated\(\(\) => \{([\s\S]*?)\n\}\);/,
  )?.[1] || '';
  assert.doesNotMatch(authInvalidatedHandler, /googleSyncEnabled:\s*false/,
    '인증 만료가 사용자의 명시적 연결 해제처럼 자동 동기화 설정을 끕니다.');
  assert.match(settingsSource, /id="google-sync-unlinked-title"/,
    '설정 화면에 인증 만료 안내를 갱신할 제목 영역이 없습니다.');
  assert.match(settingsSource, /status\.reauthRequired[\s\S]*?다시 로그인/,
    '설정 화면이 인증 만료 상태에서 다시 로그인을 안내하지 않습니다.');
  assert.match(read('src/index.html'), /showCloudReauthToast[\s\S]*?data:google-sync/,
    '인증 만료 비차단 알림에서 Google 동기화 설정으로 이동할 수 없습니다.');

  const googleAuth = require(path.join(projectRoot, 'dist', 'modules', 'googleAuth.js'));
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(1723), false,
    '브라우저가 차단하는 OAuth 루프백 포트 1723을 허용했습니다.');
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(5779), true,
    '브라우저가 허용하는 낮은 OAuth 루프백 포트를 과도하게 차단했습니다.');
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(4190), false);
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(6667), false);
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(6679), false);
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(10_080), false);
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(10_081), true);
  assert.equal(googleAuth.isSafeOAuthLoopbackPort(65_535), true);
  const { safeStorage } = require('electron') as typeof import('electron');
  const authTokenPath = path.join(isolatedUserData, 'google_auth.enc');
  const expiredTokens = {
    access_token: 'expired-access-token',
    refresh_token: 'refresh-token-for-logout-race',
    expiry_date: 0,
    token_type: 'Bearer',
  };
  const tokenJson = JSON.stringify(expiredTokens);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(authTokenPath, safeStorage.encryptString(tokenJson));
  } else {
    fs.writeFileSync(authTokenPath, Buffer.from(tokenJson, 'utf8').toString('base64'), 'utf8');
  }

  const originalFetch = global.fetch;
  const withRegressionGoogleCredentials = async <T>(action: () => Promise<T>): Promise<T> => {
    const originalCredentialExistsSync = fs.existsSync;
    const originalCredentialReadFileSync = fs.readFileSync;
    try {
      fs.existsSync = ((candidate: fs.PathLike) => path.basename(String(candidate)) === 'env.json'
        || originalCredentialExistsSync(candidate)) as typeof fs.existsSync;
      fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: any[]) => {
        if (typeof candidate !== 'number' && path.basename(String(candidate)) === 'env.json') {
          return JSON.stringify({ GOOGLE_CLIENT_ID: 'regression-client-id' });
        }
        return (originalCredentialReadFileSync as any)(candidate, ...args);
      }) as typeof fs.readFileSync;
      return await action();
    } finally {
      fs.existsSync = originalCredentialExistsSync;
      fs.readFileSync = originalCredentialReadFileSync;
    }
  };
  let resolveRefresh: ((response: Response) => void) | undefined;
  let refreshStarted = false;
  let refreshedToken: string | null = null;
  let authResurrected = false;
  try {
    global.fetch = (async () => {
      refreshStarted = true;
      return new Promise<Response>(resolve => { resolveRefresh = resolve; });
    }) as typeof fetch;
    const refreshPromise = withRegressionGoogleCredentials(
      () => googleAuth.getValidAccessToken() as Promise<string | null>,
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(refreshStarted, true, '로그아웃 경쟁 검사에서 토큰 갱신 요청이 시작되지 않았습니다.');
    googleAuth.logout();
    resolveRefresh!(new Response(JSON.stringify({
      access_token: 'late-refreshed-access-token',
      expires_in: 3600,
      token_type: 'Bearer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    refreshedToken = await refreshPromise;
    authResurrected = googleAuth.isLoggedIn() || fs.existsSync(authTokenPath);
  } finally {
    global.fetch = originalFetch;
    googleAuth.logout();
  }
  assert.equal(refreshedToken, null,
    '로그아웃 전에 시작한 토큰 갱신 응답이 취소 뒤 access token을 반환했습니다.');
  assert.equal(authResurrected, false,
    '로그아웃 전에 시작한 토큰 갱신 응답이 삭제한 인증 상태를 다시 저장했습니다.');

  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(authTokenPath, safeStorage.encryptString(tokenJson));
  } else {
    fs.writeFileSync(authTokenPath, Buffer.from(tokenJson, 'utf8').toString('base64'), 'utf8');
  }
  let resolveStaleFailure: ((response: Response) => void) | undefined;
  let replacementAuthPreserved = false;
  try {
    global.fetch = (async () => new Promise<Response>(resolve => { resolveStaleFailure = resolve; })) as typeof fetch;
    const staleRefreshPromise = withRegressionGoogleCredentials(
      () => googleAuth.getValidAccessToken() as Promise<string | null>,
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    googleAuth.logout();
    const replacementTokens = {
      access_token: 'replacement-access-token',
      refresh_token: 'replacement-refresh-token',
      expiry_date: Date.now() + 3_600_000,
      token_type: 'Bearer',
    };
    const replacementJson = JSON.stringify(replacementTokens);
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(authTokenPath, safeStorage.encryptString(replacementJson));
    } else {
      fs.writeFileSync(authTokenPath, Buffer.from(replacementJson, 'utf8').toString('base64'), 'utf8');
    }
    assert.equal(googleAuth.loadStoredTokens()?.access_token, 'replacement-access-token');
    resolveStaleFailure!(new Response('stale refresh rejected', { status: 401 }));
    assert.equal(await staleRefreshPromise, null);
    replacementAuthPreserved = googleAuth.isLoggedIn() && fs.existsSync(authTokenPath);
  } finally {
    global.fetch = originalFetch;
    googleAuth.logout();
  }
  assert.equal(replacementAuthPreserved, true,
    '이전 세대 토큰 갱신 실패가 새 로그인 인증 상태를 삭제했습니다.');

  const { shell } = require('electron') as typeof import('electron');
  const originalOpenExternal = shell.openExternal;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  let profileFailureResult: { success: boolean; profile?: unknown; error?: string } | undefined;
  let profileFailureTokenStored = false;
  let browserOpenFailureResult: { success: boolean; profile?: unknown; error?: string } | undefined;
  let oauthErrorResult: { success: boolean; profile?: unknown; error?: string } | undefined;
  let oauthErrorCallbackBody = '';
  let oauthErrorCallbackRequest: Promise<void> | undefined;
  let invalidStateResult: { success: boolean; profile?: unknown; error?: string } | undefined;
  let invalidStateCallbackStatus = 0;
  let invalidStateCallbackRequest: Promise<void> | undefined;
  let tokenRequestCount = 0;
  let callbackRequest: Promise<Response> | undefined;
  try {
    fs.existsSync = ((candidate: fs.PathLike) => path.basename(String(candidate)) === 'env.json'
      || originalExistsSync(candidate)) as typeof fs.existsSync;
    fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (typeof candidate !== 'number' && path.basename(String(candidate)) === 'env.json') {
        return JSON.stringify({ GOOGLE_CLIENT_ID: 'regression-client-id' });
      }
      return (originalReadFileSync as any)(candidate, ...args);
    }) as typeof fs.readFileSync;
    global.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenRequestCount++;
        return new Response(JSON.stringify({
          access_token: 'profile-failure-access-token',
          refresh_token: 'profile-failure-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('www.googleapis.com/oauth2/v2/userinfo')) {
        return new Response('profile unavailable', { status: 503 });
      }
      throw new Error(`예상하지 못한 OAuth fetch: ${url}`);
    }) as typeof fetch;
    shell.openExternal = (async (url: string) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const state = authUrl.searchParams.get('state');
      assert.ok(redirectUri, 'OAuth 회귀 검사 redirect URI가 없습니다.');
      assert.ok(state, 'OAuth 회귀 검사 state가 없습니다.');
      assert.equal(googleAuth.isSafeOAuthLoopbackPort(Number(new URL(redirectUri).port)), true,
        'OAuth 로그인이 브라우저 제한 루프백 포트를 선택했습니다.');
      callbackRequest = originalFetch(
        `${redirectUri}?code=profile-failure-code&state=${encodeURIComponent(state)}`,
      );
      await callbackRequest;
    }) as typeof shell.openExternal;
    profileFailureResult = await googleAuth.startLogin();
    if (callbackRequest) await callbackRequest;
    profileFailureTokenStored = googleAuth.isLoggedIn() || fs.existsSync(authTokenPath);
    shell.openExternal = (async () => {
      throw new Error('forced browser open failure');
    }) as typeof shell.openExternal;
    browserOpenFailureResult = await googleAuth.startLogin();
    const injectedOAuthError = '<img src=x onerror="window.oauthInjected=true">';
    shell.openExternal = ((url: string) => {
      oauthErrorCallbackRequest = (async () => {
        const authUrl = new URL(url);
        const redirectUri = authUrl.searchParams.get('redirect_uri');
        const state = authUrl.searchParams.get('state');
        assert.ok(redirectUri, 'OAuth 오류 응답 검사 redirect URI가 없습니다.');
        assert.ok(state, 'OAuth 오류 응답 검사 state가 없습니다.');
        const response = await originalFetch(
          `${redirectUri}?error=${encodeURIComponent(injectedOAuthError)}&state=${encodeURIComponent(state)}`,
        );
        oauthErrorCallbackBody = await response.text();
      })();
      return oauthErrorCallbackRequest;
    }) as typeof shell.openExternal;
    oauthErrorResult = await googleAuth.startLogin();
    if (oauthErrorCallbackRequest) await oauthErrorCallbackRequest;
    const tokenRequestsBeforeInvalidState = tokenRequestCount;
    shell.openExternal = ((url: string) => {
      invalidStateCallbackRequest = (async () => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri');
        assert.ok(redirectUri, 'OAuth state 변조 검사 redirect URI가 없습니다.');
        const response = await originalFetch(`${redirectUri}?code=forged-code&state=forged-state`);
        invalidStateCallbackStatus = response.status;
        await response.text();
      })();
      return invalidStateCallbackRequest;
    }) as typeof shell.openExternal;
    invalidStateResult = await googleAuth.startLogin();
    if (invalidStateCallbackRequest) await invalidStateCallbackRequest;
    assert.equal(tokenRequestCount, tokenRequestsBeforeInvalidState,
      'state가 변조된 OAuth 콜백이 토큰 교환 요청까지 진행했습니다.');
  } finally {
    shell.openExternal = originalOpenExternal;
    global.fetch = originalFetch;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    googleAuth.logout();
  }
  assert.equal(profileFailureResult?.success, false,
    'Google 프로필 조회 실패를 OAuth 로그인 성공으로 처리했습니다.');
  assert.equal(profileFailureTokenStored, false,
    'Google 프로필 조회 실패 뒤 사용하지 못하는 OAuth 토큰이 저장됐습니다.');
  assert.equal(browserOpenFailureResult?.success, false,
    '기본 브라우저 실행 실패를 OAuth 로그인 성공으로 처리했습니다.');
  assert.equal(browserOpenFailureResult?.error, 'Google 로그인 브라우저를 열지 못했습니다.');
  assert.equal(oauthErrorResult?.success, false);
  assert.doesNotMatch(oauthErrorCallbackBody, /<img\b/i,
    'OAuth 오류 쿼리가 callback HTML 요소로 주입되었습니다.');
  assert.match(oauthErrorCallbackBody, /&lt;img\b/i,
    'OAuth 오류 쿼리의 사용자 표시 텍스트가 HTML escape되지 않았습니다.');
  assert.equal(invalidStateResult?.success, false,
    'state가 변조된 OAuth 콜백을 로그인 성공으로 처리했습니다.');
  assert.equal(invalidStateResult?.error, '유효하지 않은 Google 로그인 응답입니다.');
  assert.equal(invalidStateCallbackStatus, 400,
    'state가 변조된 OAuth 콜백에 HTTP 400을 반환하지 않았습니다.');
  assert.equal(googleAuth.escapeOAuthHtml(`<tag a="b">Tom & Jerry's</tag>`),
    '&lt;tag a=&quot;b&quot;&gt;Tom &amp; Jerry&#39;s&lt;/tag&gt;');

  const googleDrive = require(path.join(projectRoot, 'dist', 'modules', 'googleDriveSync.js'));
  const originalGetValidAccessToken = googleAuth.getValidAccessToken;
  const listRequestUrls: string[] = [];
  let paginatedFiles: Array<{ id: string; name: string }> = [];
  try {
    googleAuth.getValidAccessToken = async () => 'regression-drive-token';
    global.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      listRequestUrls.push(url);
      if (url.includes('pageToken=second-page')) {
        return new Response(JSON.stringify({
          files: [{ id: 'older-valid-meta', name: 'tw_overlay_sync_meta.json' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        files: [{ id: 'newer-corrupt-meta', name: 'tw_overlay_sync_meta.json' }],
        nextPageToken: 'second-page',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    paginatedFiles = await googleDrive.listSyncFiles();
  } finally {
    global.fetch = originalFetch;
    googleAuth.getValidAccessToken = originalGetValidAccessToken;
  }
  assert.equal(listRequestUrls.length, 2,
    'Drive AppData 파일 목록의 nextPageToken을 따라가지 않았습니다.');
  assert.deepEqual(paginatedFiles.map(file => file.id), ['newer-corrupt-meta', 'older-valid-meta'],
    '두 번째 Drive 목록 페이지의 중복 파일 후보가 복원 검사에서 누락됐습니다.');

  const driveRequestSource = read('src/modules/googleDriveSync.ts');
  assert.match(driveRequestSource, /cancelPendingRequests/);
  assert.match(driveRequestSource, /response\.status !== 401[\s\S]*?refreshAfterUnauthorized/,
    'Drive 401의 1회 refresh/retry 경계가 없습니다.');

  const cloudSyncDocs = read('docs/google-drive-sync.md');
  assert.match(cloudSyncDocs, /마지막으로 두 PC가 같았던 상태/,
    '사용자용 동기화 가이드가 3방향 병합의 기준 상태를 쉬운 말로 설명하지 않습니다.');
  assert.match(cloudSyncDocs, /서로 다른 캐릭터[\s\S]*?변경을 모두 유지/,
    '사용자용 동기화 가이드에 다른 캐릭터의 숙제 변경 병합 예시가 없습니다.');
  assert.match(cloudSyncDocs, /완료·해제[\s\S]*?횟수[\s\S]*?정해진 순서로 다시 적용/,
    '사용자용 동기화 가이드에 같은 숙제의 완료·해제·횟수 충돌 설명이 없습니다.');
  assert.match(cloudSyncDocs, /선택 대기 상태도 클라우드에 저장[\s\S]*?캐릭터 선택 팝업/,
    '사용자용 동기화 가이드에 pending 숙제의 다른 PC 팝업 동작이 없습니다.');
  const settingsEnvelope = syncDataHelper.buildSettingsSyncPayload(
    sampleLocalConfig,
    'device-doc-fixture',
    'generation-doc-fixture',
  );
  assert.equal(settingsEnvelope.updatedBy, 'device-doc-fixture');
  assert.doesNotMatch(settingsEnvelope.updatedBy, /@/,
    '설정 payload updatedBy에 Google 이메일이 사용되고 있습니다.');
  assert.match(managerSource, /buildSettingsSyncPayload\(current, state\.deviceId, state\.generationId\)/,
    '실제 설정 업로드가 이메일 대신 installation device ID를 사용하지 않습니다.');
  const operationFixture = {
    id: 'operation-doc-fixture',
    deviceId: 'device-doc-fixture',
    createdAt: 1,
    keys: ['pendingHomeworks'],
    mutations: [{
      path: ['pendingHomeworks', 'fixture'],
      beforeExists: false,
      afterExists: true,
      before: null,
      after: { id: 'fixture' },
    }],
  };
  const checklistEnvelope = syncDataHelper.buildChecklistSyncPayload(
    sampleLocalConfig,
    'device-doc-fixture',
    'generation-doc-fixture',
    [operationFixture],
  );
  assert.deepEqual(
    Object.keys(settingsEnvelope).sort(),
    ['appVersion', 'checksum', 'data', 'generationId', 'kind', 'lastSyncedAt',
      'revision', 'schemaVersion', 'updatedBy'].sort(),
    '설정 파일 최상위 allowlist가 실제 payload와 일치하지 않습니다.',
  );
  assert.deepEqual(
    Object.keys(checklistEnvelope).sort(),
    ['appVersion', 'checksum', 'data', 'generationId', 'kind', 'lastSyncedAt',
      'operations', 'operationsChecksum', 'revision', 'schemaVersion', 'updatedBy'].sort(),
    '숙제 파일 최상위 allowlist가 실제 payload와 일치하지 않습니다.',
  );
  assert.deepEqual(
    Object.keys(checklistEnvelope.operations![0]).sort(),
    ['createdAt', 'deviceId', 'id', 'keys', 'mutations'].sort(),
    '숙제 operation allowlist가 실제 payload와 일치하지 않습니다.',
  );
  assert.deepEqual(
    Object.keys(checklistEnvelope.operations![0].mutations[0]).sort(),
    ['after', 'afterExists', 'before', 'beforeExists', 'path'].sort(),
    '숙제 mutation allowlist가 실제 payload와 일치하지 않습니다.',
  );
  const metaEnvelope = syncDataHelper.buildSyncMetaPayload('generation-doc-fixture', 1, {
    settings: { id: 'settings-id', name: 'tw_overlay_settings.json' },
    checklist: { id: 'checklist-id', name: 'tw_overlay_checklist.json' },
  });
  assert.deepEqual(
    Object.keys(metaEnvelope).sort(),
    ['files', 'generationId', 'schemaVersion', 'updatedAt'].sort(),
    '메타 파일 최상위 allowlist가 실제 payload와 일치하지 않습니다.',
  );
  assert.deepEqual(
    Object.keys(metaEnvelope.files.settings!).sort(),
    ['id', 'name'],
    '메타 settings 참조 allowlist가 실제 payload와 일치하지 않습니다.',
  );
  assert.deepEqual(
    Object.keys(metaEnvelope.files.checklist!).sort(),
    ['id', 'name'],
    '메타 checklist 참조 allowlist가 실제 payload와 일치하지 않습니다.',
  );

  const highRiskExcludedKeys = [
    'discordWebhookUrl', 'chatLogPath', 'msgerLogPath', 'customSounds', 'positions',
    'windowedFullscreenPositions', 'storedPositionKeys', 'fixedWindowPositions', 'fixedWindowPositionsActive',
    'googleSyncEnabled', 'googleSyncAutoSync', 'googleSyncLastTime',
    'googleSyncUserEmail',
  ];
  for (const excluded of highRiskExcludedKeys) {
    assert.equal(syncDataHelper.SETTINGS_SYNCABLE_KEYS.includes(excluded), false,
      `민감·PC 종속 키가 설정 allowlist에 포함됐습니다: ${excluded}`);
    assert.equal(syncDataHelper.CHECKLIST_SYNCABLE_KEYS.includes(excluded), false,
      `민감·PC 종속 키가 숙제 allowlist에 포함됐습니다: ${excluded}`);
  }

  const privacyPolicyMarkdown = read('PRIVACY_POLICY.md');
  const privacyPolicyHtml = read('docs/privacy/index.html');
  const privacyParityTerms = [
    'tw_overlay_settings.json', 'tw_overlay_checklist.json', 'tw_overlay_sync_meta.json',
    'appDataFolder', 'Discord Webhook URL', 'Google OAuth 토큰', '채팅/메신저 로그 경로',
    '커스텀 사운드 절대경로', '창 위치·크기', '일지 DB', '채팅 로그', '알람 이력',
    '종단간 암호화', '이메일은 로컬 계정 표시에만 사용', '세 동기화 JSON에는 저장하지 않습니다',
    'google-drive-sync.md',
    'Google Analytics 사용 통계', '가명 설치 식별자', '배포 채널(Microsoft Store 또는 GitHub)', '사용 통계 전송',
  ];
  for (const term of privacyParityTerms) {
    assert.ok(privacyPolicyMarkdown.includes(term),
      `Markdown 개인정보처리방침에 클라우드 정책 항목이 누락됐습니다: ${term}`);
    assert.ok(privacyPolicyHtml.includes(term),
      `HTML 개인정보처리방침에 클라우드 정책 항목이 누락됐습니다: ${term}`);
  }
  const googleSyncGuide = read('docs/google-drive-sync.md');
  for (const requiredGuideText of [
    '설정 ⚙️ → 시스템 & 관리 → 데이터 관리',
    'Google Drive의 앱 전용 데이터 보기 및 관리',
    '체크박스 없이 요청 권한 목록',
    '`지금 저장`', '`불러오기`', '`연결 해제`',
    '숨겨진 앱 데이터 삭제',
  ]) {
    assert.ok(googleSyncGuide.includes(requiredGuideText),
      `Google 로그인 사용자 가이드에 필수 안내가 누락됐습니다: ${requiredGuideText}`);
  }
  for (const guideImage of [
    'google-sync-login-guide.svg',
    'google-sync-permission-guide.svg',
  ]) {
    assert.ok(googleSyncGuide.includes(`./screenshot/${guideImage}`),
      `Google 로그인 가이드에 이미지가 연결되지 않았습니다: ${guideImage}`);
    assert.equal(fs.existsSync(path.join(projectRoot, 'docs', 'screenshot', guideImage)), true,
      `Google 로그인 가이드 이미지 파일이 없습니다: ${guideImage}`);
  }

  const guideIndexSource = read('docs/guide/index.html');
  const guideNavDocs = new Set(Array.from(guideIndexSource.matchAll(/data-doc="([^"]+)"/g), match => match[1]));
  assert.equal(guideNavDocs.has('realtime-log-engine'), false,
    '직접 조작할 수 없는 로그 엔진 문서가 사용자 가이드 탐색에 다시 노출됐습니다.');
  for (const expectedLabel of [
    '마정석 계산기', '진화 재료 비용 계산기', '시에나의 기운',
    '제복 색상 시뮬레이터', '사기꾼 탐지(1:1 대화)', '필드보스 알림 설정',
  ]) {
    assert.ok(guideIndexSource.includes(expectedLabel),
      `가이드 탐색의 실제 메뉴명이 누락됐습니다: ${expectedLabel}`);
  }
  for (const docName of guideNavDocs) {
    const userDocPath = path.join(projectRoot, 'docs', `${docName}.md`);
    assert.equal(fs.existsSync(userDocPath), true,
      `가이드 탐색이 존재하지 않는 문서를 가리킵니다: ${docName}`);
    const userDoc = fs.readFileSync(userDocPath, 'utf8');
    const imageCount = Array.from(userDoc.matchAll(/^!\[[^\]]*\]\([^)]+\)$/gm)).length;
    assert.ok(imageCount >= 1, `사용자 가이드 본문에 기능 이미지가 없습니다: ${docName}`);
    if (!['quickstart', 'google-drive-sync', 'experience-hud'].includes(docName)) {
      for (const heading of ['언제 쓰는 기능인가요?', '어디에서 켜나요?', '기본 사용법', '자주 혼동하는 점', '문제 해결']) {
        assert.ok(userDoc.includes(`## ${heading}`),
          `사용자 흐름 중심 가이드 순서가 누락됐습니다: ${docName} -> ${heading}`);
      }
    }
  }
  assert.equal(cloudSyncDocs.includes('settings-data-allowlist:start'), false,
    '개발용 Google Drive allowlist가 공개 사용자 가이드에 다시 노출됐습니다.');

  const cloudSyncState = require(path.join(projectRoot, 'dist', 'modules', 'cloudSyncState.js'));
  const profileFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-profile-state-'));
  try {
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'fresh');
    fs.writeFileSync(path.join(profileFixture, 'config.json.tmp'), '{}', 'utf8');
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'needs-confirmation');
    fs.rmSync(path.join(profileFixture, 'config.json.tmp'));
    fs.writeFileSync(path.join(profileFixture, 'config.json'), '{}', 'utf8');
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'established');
    fs.rmSync(path.join(profileFixture, 'config.json'));
    fs.writeFileSync(path.join(profileFixture, 'diary.db'), '', 'utf8');
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'needs-confirmation');
    fs.writeFileSync(path.join(profileFixture, 'diary.db'), Buffer.from('SQLite format 3\0', 'utf8'));
    assert.equal(cloudSyncState.detectProfileStateAtPath(profileFixture), 'established');
  } finally {
    fs.rmSync(profileFixture, { recursive: true, force: true });
  }
  const cloudStatePath = path.join(isolatedUserData, 'cloud-sync-state.json');
  const validPersistedOperation = {
    id: 'valid-persisted-operation',
    deviceId: 'persisted-device',
    createdAt: 1000,
    keys: ['contentsCheckerItems'],
    mutations: [{
      path: ['contentsCheckerItems', 'daily-abyss', 'isVisible'],
      beforeExists: true,
      afterExists: true,
      before: true,
      after: false,
    }],
  };
  fs.writeFileSync(cloudStatePath, JSON.stringify({
    schemaVersion: 1,
    deviceId: 'persisted-device',
    generationId: 'persisted-generation',
    createdAt: 1000,
    profileState: 'established',
    fileIds: { settings: 123, checklist: 'valid-checklist-id', meta: '' },
    remoteRevisions: { settings: [], checklist: 'valid-checklist-revision' },
    settingsDirtyKeys: ['userServer', 'not-syncable', 'userServer'],
    settingsDirtyAt: { userServer: 1000, 'not-syncable': 2000 },
    checklistOutbox: [
      validPersistedOperation,
      {
        id: 'invalid-persisted-operation',
        deviceId: 'persisted-device',
        createdAt: 1001,
        keys: ['contentsCheckerItems'],
        mutations: [null],
      },
    ],
    confirmedChecklistOperations: [],
    restoreResults: [{
      kind: 'settings',
      selected: true,
      status: 'incompatible',
      error: '현재 버전에서 동기화할 수 없습니다.',
    }],
    restorePartial: true,
    shutdownRecovery: {
      createdAt: 1000,
      settings: {
        dirtyKeys: ['userServer', 'not-syncable', 'userServer'],
        checksum: 'a'.repeat(64),
        remoteRevision: 123,
      },
      checklist: {
        operationIds: ['valid-persisted-operation', '', 'x'.repeat(201), 'valid-persisted-operation'],
        checksum: 'b'.repeat(64),
        remoteRevision: 'valid-recovery-revision',
      },
    },
  }), 'utf8');
  cloudSyncState.resetCacheForTests();
  const normalizedCorruptState = cloudSyncState.load();
  assert.deepEqual(normalizedCorruptState.fileIds, { checklist: 'valid-checklist-id' },
    '손상된 Drive file ID가 로컬 동기화 상태에 남았습니다.');
  assert.deepEqual(normalizedCorruptState.remoteRevisions, { checklist: 'valid-checklist-revision' },
    '손상된 원격 revision이 로컬 동기화 상태에 남았습니다.');
  assert.deepEqual(normalizedCorruptState.settingsDirtyKeys, ['userServer'],
    '허용되지 않은 설정 dirty key가 로컬 동기화 상태에 남았습니다.');
  assert.deepEqual(normalizedCorruptState.settingsDirtyAt, { userServer: 1000 },
    '제거된 dirty key의 시각 정보가 로컬 동기화 상태에 남았습니다.');
  assert.deepEqual(normalizedCorruptState.checklistOutbox, [validPersistedOperation],
    '손상된 mutation을 가진 숙제 operation이 outbox에 남았습니다.');
  assert.equal(normalizedCorruptState.restoreResults?.[0]?.status, 'incompatible',
    '호환되지 않는 파일의 복원 결과가 재시작 뒤 사라졌습니다.');
  assert.equal(normalizedCorruptState.restorePartial, true,
    '파일별 부분 복원 상태가 재시작 뒤 사라졌습니다.');
  assert.deepEqual(normalizedCorruptState.shutdownRecovery?.settings, {
    dirtyKeys: ['userServer'],
    checksum: 'a'.repeat(64),
    remoteRevision: undefined,
  }, '손상된 설정 종료 recovery 필드가 로컬 동기화 상태에 남았습니다.');
  assert.deepEqual(normalizedCorruptState.shutdownRecovery?.checklist, {
    operationIds: ['valid-persisted-operation'],
    checksum: 'b'.repeat(64),
    remoteRevision: 'valid-recovery-revision',
  }, '손상된 숙제 종료 recovery operation ID가 로컬 동기화 상태에 남았습니다.');
  fs.writeFileSync(cloudStatePath, JSON.stringify({
    schemaVersion: 1,
    deviceId: '',
    generationId: '',
  }), 'utf8');
  cloudSyncState.resetCacheForTests();
  const invalidIdentityState = cloudSyncState.load();
  assert.notEqual(invalidIdentityState.deviceId, '', '빈 installation ID를 유효한 로컬 상태로 사용했습니다.');
  assert.notEqual(invalidIdentityState.generationId, '', '빈 generation ID를 유효한 로컬 상태로 사용했습니다.');
  assert.notEqual(invalidIdentityState.profileState, 'fresh',
    '식별자가 손상된 기존 프로필을 fresh 자동 복원 대상으로 판정했습니다.');
  fs.rmSync(cloudStatePath);
  const recoveredTempState = {
    schemaVersion: 1,
    deviceId: 'temp-recovery-device',
    generationId: 'temp-recovery-generation',
    createdAt: 1000,
    profileState: 'established',
    fileIds: {},
    remoteRevisions: {},
    settingsDirtyKeys: ['userServer'],
    settingsDirtyAt: { userServer: 1000 },
    checklistOutbox: [validPersistedOperation],
    confirmedChecklistOperations: [],
    shutdownRecovery: {
      createdAt: 1000,
      settings: { dirtyKeys: ['userServer'], checksum: 'a'.repeat(64) },
      checklist: { operationIds: ['valid-persisted-operation'], checksum: 'b'.repeat(64) },
    },
  };
  fs.writeFileSync(`${cloudStatePath}.tmp`, JSON.stringify(recoveredTempState), 'utf8');
  cloudSyncState.resetCacheForTests();
  const promotedTempState = cloudSyncState.load();
  assert.equal(promotedTempState.deviceId, recoveredTempState.deviceId,
    '원자 저장 중 남은 유효 임시 상태의 installation ID를 복구하지 못했습니다.');
  assert.deepEqual(promotedTempState.settingsDirtyKeys, ['userServer']);
  assert.deepEqual(promotedTempState.checklistOutbox, [validPersistedOperation]);
  assert.equal(fs.existsSync(cloudStatePath), true,
    '복구한 임시 클라우드 상태를 정식 상태 파일로 승격하지 않았습니다.');
  assert.equal(fs.existsSync(`${cloudStatePath}.tmp`), false,
    '승격이 끝난 임시 클라우드 상태 파일이 남았습니다.');
  fs.rmSync(cloudStatePath);
  cloudSyncState.resetCacheForTests();
  const initialState = cloudSyncState.load();
  assert.equal(typeof initialState.deviceId, 'string');
  assert.equal(fs.existsSync(cloudStatePath), true,
    '최초 installation ID를 변경 발생 전 디스크에 기록하지 않았습니다.');
  cloudSyncState.update((state: any) => {
    state.settingsDirtyKeys = ['userServer'];
    state.checklistOutbox.push({
      id: 'operation-1', deviceId: state.deviceId, createdAt: 1000,
      keys: ['contentsCheckerItems'], mutations: [],
    });
  });
  cloudSyncState.resetCacheForTests();
  const persistedState = cloudSyncState.load();
  assert.deepEqual(persistedState.settingsDirtyKeys, ['userServer']);
  assert.equal(persistedState.checklistOutbox[0].id, 'operation-1');

  // 실제 cloudSyncManager가 분리 파일을 사용하고 다른 PC의 숙제 변경을 echo 없이 받는지 모의 Drive로 검증
  const configModule = require(path.join(projectRoot, 'dist', 'modules', 'config.js'));
  const integrationCycleStartedAt = Date.now() - 10_000;
  const integrationChecklistItems = structuredClone(sampleLocalConfig.contentsCheckerItems);
  for (const item of integrationChecklistItems) {
    for (const state of Object.values(item.completedState) as Array<any>) {
      if (state.lastCompletedAt) state.lastCompletedAt = integrationCycleStartedAt;
    }
  }
  configModule.saveImmediate({
    googleSyncEnabled: true,
    googleSyncAutoSync: true,
    userServer: 16,
    contentsCheckerItems: integrationChecklistItems,
    characterPresets: sampleLocalConfig.characterPresets,
    pendingHomeworks: [],
  });

  googleAuth.isLoggedIn = () => true;
  googleAuth.loadStoredProfile = () => ({ email: 'integration@example.com' });

  const memoryFiles = new Map<string, { id: string; name: string; modifiedTime: string; payload: any }>();
  const downloadedFileIds: string[] = [];
  let nextFileId = 1;
  let uploadCount = 0;
  let loseNextChecklistResponse = false;
  googleDrive.listSyncFiles = async () => Array.from(memoryFiles.values()).map(file => ({
    id: file.id,
    name: file.name,
    modifiedTime: file.modifiedTime,
    size: String(Buffer.byteLength(JSON.stringify(file.payload), 'utf-8')),
  }));
  googleDrive.downloadJsonPayload = async (fileId: string) => {
    downloadedFileIds.push(fileId);
    const file = memoryFiles.get(fileId);
    return file ? structuredClone(file.payload) : null;
  };
  googleDrive.uploadJsonPayload = async (fileName: string, payloadValue: any, existingFileId?: string) => {
    uploadCount++;
    const id = existingFileId || `mock-file-${nextFileId++}`;
    memoryFiles.set(id, {
      id,
      name: fileName,
      modifiedTime: new Date(Date.now() + uploadCount).toISOString(),
      payload: structuredClone(payloadValue),
    });
    if (fileName === 'tw_overlay_checklist.json' && loseNextChecklistResponse) {
      loseNextChecklistResponse = false;
      throw new Error('mock checklist response lost after commit');
    }
    return id;
  };
  googleDrive.cancelPendingRequests = () => undefined;

  cloudSyncState.resetCacheForTests();
  const cloudManager = require(path.join(projectRoot, 'dist', 'modules', 'cloudSyncManager.js'));
  googleAuth.isLoggedIn = () => false;
  const dirtyBeforeAuthInvalidation = structuredClone(cloudSyncState.load());
  googleAuth.invalidateAuth();
  const authExpiredStatus = cloudManager.getSyncStatus();
  assert.equal(configModule.load().googleSyncEnabled, true,
    '인증 만료가 사용자의 자동 동기화 선택을 껐습니다.');
  assert.equal(authExpiredStatus.reauthRequired, true,
    '인증 만료 뒤 재로그인 필요 상태가 유지되지 않습니다.');
  assert.deepEqual(cloudSyncState.load().settingsDirtyKeys, dirtyBeforeAuthInvalidation.settingsDirtyKeys,
    '인증 만료가 설정 dirty 상태를 삭제했습니다.');
  assert.deepEqual(cloudSyncState.load().checklistOutbox, dirtyBeforeAuthInvalidation.checklistOutbox,
    '인증 만료가 숙제 outbox를 삭제했습니다.');
  configModule.saveImmediate({ galleryNotify: true });
  assert.equal(cloudSyncState.load().settingsDirtyKeys.includes('galleryNotify'), true,
    '인증 만료 중 바꾼 설정이 재로그인용 dirty 상태로 기록되지 않았습니다.');
  configModule.saveImmediate({ galleryNotify: false });
  googleAuth.isLoggedIn = () => true;
  const legacyPayload = { schemaVersion: 1, data: { userServer: 99 }, marker: 'legacy-single-file' };
  memoryFiles.set('legacy-single-file', {
    id: 'legacy-single-file',
    name: 'tw_overlay_sync.json',
    modifiedTime: '2026-08-25T09:00:00.000Z',
    payload: structuredClone(legacyPayload),
  });
  const backupResult = await cloudManager.syncToCloud(true);
  assert.equal(backupResult.success, true);
  const names = Array.from(memoryFiles.values()).map(file => file.name).sort();
  assert.deepEqual(names, [
    'tw_overlay_checklist.json',
    'tw_overlay_settings.json',
    'tw_overlay_sync.json',
    'tw_overlay_sync_meta.json',
  ]);
  assert.equal(downloadedFileIds.includes('legacy-single-file'), false,
    '개발 중 단일 동기화 파일을 정식 입력으로 읽었습니다.');
  assert.deepEqual(memoryFiles.get('legacy-single-file')?.payload, legacyPayload,
    '개발 중 단일 동기화 파일을 분할하거나 다시 업로드했습니다.');
  const uploadedSettings = Array.from(memoryFiles.values()).find(file => file.name === 'tw_overlay_settings.json')!;
  const uploadedChecklist = Array.from(memoryFiles.values()).find(file => file.name === 'tw_overlay_checklist.json')!;
  const currentChecklistFile = () => Array.from(memoryFiles.values())
    .find(file => file.name === 'tw_overlay_checklist.json')!;
  assert.equal(uploadedSettings.payload.data.contentsCheckerItems, undefined,
    '실제 설정 업로드 파일에 숙제 상태가 섞였습니다.');
  assert.equal(uploadedChecklist.payload.data.userServer, undefined,
    '실제 숙제 업로드 파일에 일반 설정이 섞였습니다.');

  let remoteChecklistPayload = structuredClone(uploadedChecklist.payload);
  const remoteChecklistBefore = structuredClone(remoteChecklistPayload.data);
  const remoteItem = remoteChecklistPayload.data.contentsCheckerItems.find((item: any) => item.id === 'daily-abyss');
  remoteItem.completedState['char-2'] = {
    isCompleted: true, currentCount: 1, lastCompletedAt: integrationCycleStartedAt + 1_000,
  };
  remoteChecklistPayload.operations = [
    ...(remoteChecklistPayload.operations || []),
    {
      id: 'operation-remote-office-complete',
      deviceId: 'remote-office-pc',
      createdAt: Date.now(),
      keys: ['contentsCheckerItems'],
      mutations: syncDataHelper.createChecklistOperationMutations(
        remoteChecklistBefore,
        remoteChecklistPayload.data,
      ),
    },
  ];
  remoteChecklistPayload = syncDataHelper.buildChecklistSyncPayload(
    { ...configModule.load(), ...remoteChecklistPayload.data },
    'remote-office-pc',
    remoteChecklistPayload.generationId,
    remoteChecklistPayload.operations,
  );
  uploadedChecklist.payload = remoteChecklistPayload;
  uploadedChecklist.modifiedTime = new Date(Date.now() + 10_000).toISOString();
  const remoteSettingsPayload = structuredClone(uploadedSettings.payload);
  remoteSettingsPayload.data.userServer = 7;
  remoteSettingsPayload.lastSyncedAt += 900;
  remoteSettingsPayload.revision = `${remoteSettingsPayload.lastSyncedAt}-remote-office`;
  remoteSettingsPayload.checksum = syncDataHelper.calculateSyncChecksum(remoteSettingsPayload.data);
  uploadedSettings.payload = remoteSettingsPayload;
  uploadedSettings.modifiedTime = new Date(Date.now() + 9_000).toISOString();
  const uploadsBeforePull = uploadCount;

  const pullResult = await cloudManager.syncFromCloud(false);
  assert.equal(pullResult.success, true);
  const received = configModule.load().contentsCheckerItems
    .find((item: any) => item.id === 'daily-abyss').completedState['char-2'];
  assert.equal(received.isCompleted, true,
    '회사 PC의 원격 숙제 완료가 집 PC 자동 pull에 반영되지 않았습니다.');
  assert.equal(received.lastCompletedAt, integrationCycleStartedAt + 1_000);
  assert.equal(configModule.load().userServer, 7,
    '같은 pull의 원격 설정 변경이 반영되지 않았습니다.');
  const combinedPullBackup = JSON.parse(fs.readFileSync(
    path.join(isolatedUserData, 'config.backup-sync.json'),
    'utf8',
  ));
  assert.equal(combinedPullBackup.userServer, 16,
    '설정과 숙제를 함께 받은 pull이 전체 적용 전 백업을 보존하지 않았습니다.');
  assert.equal(uploadCount, uploadsBeforePull,
    '원격 숙제 변경을 적용한 직후 불필요한 echo upload가 발생했습니다.');
  assert.equal(cloudSyncState.load().checklistOutbox.length, 0,
    '원격 숙제 적용 직후 파생 설정 저장이 echo outbox를 만들었습니다.');

  // 같은 Drive 파일 지문을 다시 확인할 때는 검증 완료 payload와 동일 로컬 상태를 재사용한다.
  downloadedFileIds.length = 0;
  const persistedPaths = new Set([
    path.join(isolatedUserData, 'config.json').toLowerCase(),
    cloudStatePath.toLowerCase(),
  ]);
  const originalRenameSync = fs.renameSync;
  const unchangedPullWrites: string[] = [];
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    const normalizedTarget = path.resolve(String(newPath)).toLowerCase();
    if (persistedPaths.has(normalizedTarget)) unchangedPullWrites.push(normalizedTarget);
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  let unchangedPull: any;
  try {
    unchangedPull = await cloudManager.syncFromCloud(false);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(unchangedPull.success, true);
  assert.deepEqual(
    unchangedPull.restoreResults.map((result: any) => result.status),
    ['unchanged', 'unchanged'],
  );
  const metaFileId = Array.from(memoryFiles.values())
    .find(file => file.name === 'tw_overlay_sync_meta.json')!.id;
  assert.deepEqual(downloadedFileIds, [metaFileId],
    '변경 없는 자동 pull이 검증 완료된 설정·숙제 payload를 다시 다운로드했습니다.');
  assert.deepEqual(unchangedPullWrites, [],
    '변경 없는 자동 pull이 config 또는 cloud state를 다시 원자 저장했습니다.');

  // 실제 매니저 흐름: 회사 PC 업로드가 확인된 직후 집 PC payload가 덮어쓴다.
  const beforeCompanyPayload = structuredClone(uploadedChecklist.payload);
  const baselineOperationIds = new Set((beforeCompanyPayload.operations || []).map((operation: any) => operation.id));
  const companyItems = structuredClone(configModule.load().contentsCheckerItems);
  const companyState = companyItems.find((item: any) => item.id === 'daily-abyss').completedState['char-1'];
  companyState.isCompleted = false;
  companyState.currentCount = 0;
  companyState.lastCompletedAt = integrationCycleStartedAt + 2_000;
  configModule.saveImmediate({ contentsCheckerItems: companyItems });
  const companyUpload = await cloudManager.syncToCloud(true);
  assert.equal(companyUpload.success, true);
  const companyPayload = structuredClone(currentChecklistFile().payload);
  const companyOperationIds = (companyPayload.operations || [])
    .map((operation: any) => operation.id)
    .filter((id: string) => !baselineOperationIds.has(id));
  assert.ok(companyOperationIds.length >= 1, '회사 PC의 로컬 operation이 payload에 기록되지 않았습니다.');

  const homeData = structuredClone(beforeCompanyPayload.data);
  const homeState = homeData.contentsCheckerItems
    .find((item: any) => item.id === 'daily-abyss').completedState['char-2'];
  homeState.isCompleted = true;
  homeState.currentCount = 2;
  homeState.lastCompletedAt = integrationCycleStartedAt + 3_000;
  const homeOperation = {
    id: 'operation-home-overwrite',
    deviceId: 'home-pc',
    createdAt: Date.now() + 1_000,
    keys: ['contentsCheckerItems'],
    mutations: syncDataHelper.createChecklistOperationMutations(beforeCompanyPayload.data, homeData),
  };
  const homePayload = syncDataHelper.buildChecklistSyncPayload({
    ...configModule.load(),
    ...homeData,
  }, 'home-pc', companyPayload.generationId, [
    ...(beforeCompanyPayload.operations || []),
    homeOperation,
  ]);
  currentChecklistFile().payload = structuredClone(homePayload);
  currentChecklistFile().modifiedTime = new Date(Date.now() + 20_000).toISOString();

  const crossPull = await cloudManager.syncFromCloud(false);
  assert.equal(crossPull.success, true);
  await cloudManager.flushPendingSync();
  const convergedItem = configModule.load().contentsCheckerItems
    .find((item: any) => item.id === 'daily-abyss');
  assert.equal(convergedItem.completedState['char-1'].isCompleted, false,
    '집 PC overwrite 뒤 회사 PC의 완료 해제가 복원되지 않았습니다.');
  assert.equal(convergedItem.completedState['char-2'].currentCount, 2,
    '회사 PC operation 재게시 중 집 PC의 횟수 변경이 사라졌습니다.');
  const convergedRemoteIds = new Set((currentChecklistFile().payload.operations || [])
    .map((operation: any) => operation.id));
  assert.equal(convergedRemoteIds.has(homeOperation.id), true,
    '최종 원격 payload에서 집 PC operation ID가 사라졌습니다.');
  for (const id of companyOperationIds) {
    assert.equal(convergedRemoteIds.has(id), true,
      `최종 원격 payload에서 회사 PC operation ID가 사라졌습니다: ${id}`);
  }
  let convergedLocalState = cloudSyncState.load();
  assert.equal(convergedLocalState.checklistOutbox.length, 0,
    '재수렴 확인 뒤에도 회사 PC outbox가 남았습니다.');
  assert.equal(convergedLocalState.confirmedChecklistOperations.some((operation: any) => operation.id === homeOperation.id), true,
    '회사 PC 로컬 상태에 집 PC operation ID가 확인 이력으로 남지 않았습니다.');

  // 상태 파일 재로드(앱 재시작 상당) 뒤 같은 overwrite가 다시 발생해도 조용히 재수렴한다.
  cloudSyncState.resetCacheForTests();
  const restartedState = cloudSyncState.load();
  assert.equal(restartedState.confirmedChecklistOperations.some((operation: any) =>
    companyOperationIds.includes(operation.id)), true,
    '재시작 후 회사 PC의 확인 operation 이력이 사라졌습니다.');
  const restartOverwrite = structuredClone(homePayload);
  restartOverwrite.lastSyncedAt += 10_000;
  restartOverwrite.revision = `${restartOverwrite.lastSyncedAt}-restart-overwrite`;
  restartOverwrite.checksum = syncDataHelper.calculateSyncChecksum(restartOverwrite.data);
  currentChecklistFile().payload = restartOverwrite;
  currentChecklistFile().modifiedTime = new Date(Date.now() + 30_000).toISOString();
  await cloudManager.syncFromCloud(false);
  await cloudManager.flushPendingSync();
  const restartedRemoteIds = new Set((currentChecklistFile().payload.operations || [])
    .map((operation: any) => operation.id));
  for (const id of companyOperationIds) {
    assert.equal(restartedRemoteIds.has(id), true,
      `재시작 후 재수렴한 payload에서 회사 PC operation ID가 사라졌습니다: ${id}`);
  }

  // 서버 commit 뒤 응답만 유실되면 outbox를 유지하고, 재시작 시 원격 operation을 확인해 제거한다.
  const responseLossItems = structuredClone(configModule.load().contentsCheckerItems);
  const responseLossState = responseLossItems
    .find((item: any) => item.id === 'daily-abyss').completedState['char-1'];
  responseLossState.isCompleted = true;
  responseLossState.currentCount = 1;
  responseLossState.lastCompletedAt = integrationCycleStartedAt + 4_000;
  configModule.saveImmediate({ contentsCheckerItems: responseLossItems });
  assert.equal(cloudManager.prepareShutdownRecovery(), true);
  loseNextChecklistResponse = true;
  await assert.rejects(cloudManager.syncToCloud(true), /response lost after commit/,
    '업로드 응답 유실 fixture가 실패로 관측되지 않았습니다.');
  assert.ok(cloudSyncState.load().checklistOutbox.length > 0,
    '응답 유실 직후 확인되지 않은 outbox가 제거되었습니다.');
  assert.ok(cloudSyncState.load().shutdownRecovery?.checklist,
    '응답 유실 직후 숙제 recovery marker가 유지되지 않았습니다.');
  const uploadsAfterLostResponse = uploadCount;
  cloudSyncState.resetCacheForTests();
  await cloudManager.flushPendingSync();
  assert.equal(uploadCount, uploadsAfterLostResponse,
    '재시작 reconciliation이 이미 commit된 payload를 중복 업로드했습니다.');
  convergedLocalState = cloudSyncState.load();
  assert.equal(convergedLocalState.checklistOutbox.length, 0,
    '재시작 reconciliation 뒤 원격에서 확인된 outbox가 제거되지 않았습니다.');
  assert.equal(convergedLocalState.shutdownRecovery, undefined,
    '재시작 후 원격 operation을 확인했는데 recovery marker가 남았습니다.');

  // fresh PC가 전날 완료 상태를 복원해도 현재 일일 주기에는 체크가 남지 않고,
  // 리셋 operation을 원격에 게시해 다른 PC도 같은 미완료 상태로 수렴해야 한다.
  memoryFiles.clear();
  const staleResetGeneration = 'generation-stale-daily-reset';
  const currentResetBoundary = new Date();
  currentResetBoundary.setHours(0, 0, 0, 0);
  const staleCompletedAt = currentResetBoundary.getTime() - 60_000;
  const staleRemoteConfig = {
    ...configModule.load(),
    characterPresets: [{ id: 'stale-reset-character', name: '리셋 확인 캐릭터' }],
    contentsCheckerItems: [{
      id: 'daily-cloud-reset',
      name: '클라우드 일일 리셋 확인',
      category: '일반',
      isVisible: true,
      isCustom: true,
      resetRule: { type: 'daily', hour: 0 },
      completedState: {
        'stale-reset-character': {
          isCompleted: true,
          currentCount: 1,
          lastCompletedAt: staleCompletedAt,
        },
      },
    }],
    pendingHomeworks: [],
  };
  const staleSettingsPayload = syncDataHelper.buildSettingsSyncPayload(
    staleRemoteConfig,
    'stale-remote-pc',
    staleResetGeneration,
  );
  const staleChecklistPayload = syncDataHelper.buildChecklistSyncPayload(
    staleRemoteConfig,
    'stale-remote-pc',
    staleResetGeneration,
    [],
  );
  memoryFiles.set('stale-reset-settings', {
    id: 'stale-reset-settings', name: 'tw_overlay_settings.json',
    modifiedTime: new Date(Date.now() + 40_000).toISOString(), payload: staleSettingsPayload,
  });
  memoryFiles.set('stale-reset-checklist', {
    id: 'stale-reset-checklist', name: 'tw_overlay_checklist.json',
    modifiedTime: new Date(Date.now() + 40_001).toISOString(), payload: staleChecklistPayload,
  });
  cloudSyncState.update((state: any) => {
    state.profileState = 'fresh';
    state.baseChecklist = undefined;
    state.baseSettings = undefined;
    state.remoteRevisions = {};
    state.checklistOutbox = [];
    state.confirmedChecklistOperations = [];
    state.settingsDirtyKeys = [];
    state.settingsDirtyAt = {};
    state.restoreResults = undefined;
    state.restorePartial = undefined;
  });
  configModule.saveImmediate({
    characterPresets: [{ id: 'fresh-local-character', name: '로컬 기본 캐릭터' }],
    contentsCheckerItems: [],
    pendingHomeworks: [],
  });
  const staleRestore = await cloudManager.syncFromCloud(false);
  assert.equal(staleRestore.success, true);
  assert.equal(cloudSyncState.load().profileState, 'established',
    '정상 설정·숙제 파일을 받은 fresh PC가 established 상태가 되지 않았습니다.');
  const resetLocalState = configModule.load().contentsCheckerItems
    .find((item: any) => item.id === 'daily-cloud-reset')
    .completedState['stale-reset-character'];
  assert.equal(resetLocalState.isCompleted, false,
    'fresh PC가 클라우드에서 받은 전날 일일 숙제를 체크 상태로 표시했습니다.');
  assert.equal(resetLocalState.currentCount, 0);
  assert.equal(resetLocalState.lastCompletedAt, undefined);
  const resetOperationIds = cloudSyncState.load().checklistOutbox.map((operation: any) => operation.id);
  assert.ok(resetOperationIds.length > 0,
    '클라우드 적용 뒤 발생한 일일 리셋이 숙제 outbox에 기록되지 않았습니다.');
  await cloudManager.flushPendingSync();
  const resetRemotePayload = currentChecklistFile().payload;
  const resetRemoteState = resetRemotePayload.data.contentsCheckerItems
    .find((item: any) => item.id === 'daily-cloud-reset')
    .completedState['stale-reset-character'];
  assert.equal(resetRemoteState.isCompleted, false,
    'fresh PC의 일일 리셋 결과가 최종 원격 payload에 반영되지 않았습니다.');
  const resetRemoteOperationIds = new Set((resetRemotePayload.operations || [])
    .map((operation: any) => operation.id));
  for (const operationId of resetOperationIds) {
    assert.equal(resetRemoteOperationIds.has(operationId), true,
      `일일 리셋 operation이 최종 원격 payload에서 사라졌습니다: ${operationId}`);
  }

  // fresh 프로필의 파일별 독립 복원: 지원하지 않는 설정 때문에 정상 숙제 복원이 막히지 않아야 한다.
  memoryFiles.clear();
  const partialGeneration = 'generation-partial-restore';
  const remoteFreshChecklist = syncDataHelper.buildChecklistSyncPayload({
    ...configModule.load(),
    characterPresets: [{ id: 'remote-character', name: '원격 캐릭터' }],
    contentsCheckerItems: integrationChecklistItems,
    pendingHomeworks: sampleLocalConfig.pendingHomeworks,
  }, 'remote-pc', partialGeneration, []);
  memoryFiles.set('incompatible-settings', {
    id: 'incompatible-settings',
    name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T10:00:00.000Z',
    payload: { schemaVersion: 2, kind: 'settings', data: { userServer: 16 } },
  });
  memoryFiles.set('valid-checklist', {
    id: 'valid-checklist',
    name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T10:00:01.000Z',
    payload: remoteFreshChecklist,
  });
  memoryFiles.set('corrupt-meta', {
    id: 'corrupt-meta',
    name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T10:00:02.000Z',
    payload: { schemaVersion: 999 },
  });
  cloudSyncState.update((state: any) => {
    state.profileState = 'fresh';
    state.baseChecklist = undefined;
    state.remoteRevisions = {};
    state.checklistOutbox = [];
    state.confirmedChecklistOperations = [];
    state.settingsDirtyKeys = [];
    state.settingsDirtyAt = {};
    state.restoreResults = undefined;
    state.restorePartial = undefined;
  });
  googleAuth.isLoggedIn = () => false;
  configModule.saveImmediate({
    characterPresets: [{ id: 'local-default', name: '로컬 기본 캐릭터' }],
    contentsCheckerItems: [],
    pendingHomeworks: [],
  });
  assert.equal(cloudSyncState.load().checklistOutbox.length, 0,
    'fresh 프로필의 로컬 기본 숙제 초기화가 사용자 변경 outbox로 기록되었습니다.');
  cloudSyncState.update((state: any) => { state.profileState = 'established'; });
  configModule.saveImmediate({
    characterPresets: [{ id: 'offline-established', name: '오프라인 기존 PC' }],
  });
  assert.equal(cloudSyncState.load().checklistOutbox.length, 1,
    'established 프로필의 로그인 전 숙제 변경이 outbox에 보존되지 않았습니다.');
  cloudSyncState.update((state: any) => {
    state.profileState = 'fresh';
    state.checklistOutbox = [];
  });
  configModule.saveImmediate({
    characterPresets: [{ id: 'local-default', name: '로컬 기본 캐릭터' }],
  });
  assert.equal(cloudSyncState.load().checklistOutbox.length, 0,
    'fresh 프로필의 재초기화가 숙제 outbox를 다시 만들었습니다.');
  googleAuth.isLoggedIn = () => true;
  configModule.saveImmediate({ pendingHomeworks: [] });
  assert.equal(cloudSyncState.load().checklistOutbox.length, 0,
    'fresh 프로필의 로그인 직후 변경이 원격 복원 전 outbox를 만들었습니다.');
  const partialRestore = await cloudManager.syncFromCloud(false);
  assert.equal(partialRestore.success, true);
  assert.equal(partialRestore.partial, true);
  assert.equal(partialRestore.restoreResults.find((result: any) => result.kind === 'settings').status, 'incompatible');
  assert.equal(partialRestore.restoreResults.find((result: any) => result.kind === 'checklist').status, 'restored');
  assert.deepEqual(configModule.load().characterPresets, [{ id: 'remote-character', name: '원격 캐릭터' }],
    'fresh 복원이 로컬 기본 캐릭터를 원격 체크리스트에 합쳐 남겼습니다.');
  assert.equal(cloudSyncState.load().profileState, 'needs-confirmation');
  configModule.saveImmediate({ userServer: 7 });
  memoryFiles.get('incompatible-settings')!.payload = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 16,
  }, 'remote-pc', partialGeneration);
  const blockedAutomaticRestore = await cloudManager.syncFromCloud(false);
  assert.equal(blockedAutomaticRestore.profileState, 'needs-confirmation');
  assert.equal(configModule.load().userServer, 7,
    'needs-confirmation 프로필에 클라우드 설정이 자동 적용되었습니다.');

  // 최신 메타가 손상되어도 이전의 유효 메타가 가리키는 중복 파일을 선택한다.
  memoryFiles.clear();
  const duplicateGeneration = 'generation-duplicate-fallback';
  const validSettings = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 13,
  }, 'remote-pc', duplicateGeneration);
  const validChecklist = syncDataHelper.buildChecklistSyncPayload(configModule.load(), 'remote-pc', duplicateGeneration, []);
  memoryFiles.set('valid-settings-older', {
    id: 'valid-settings-older', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T11:00:00.000Z', payload: validSettings,
  });
  memoryFiles.set('corrupt-settings-newer', {
    id: 'corrupt-settings-newer', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T11:00:03.000Z', payload: { invalid: true },
  });
  memoryFiles.set('valid-checklist-duplicate', {
    id: 'valid-checklist-duplicate', name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T11:00:01.000Z', payload: validChecklist,
  });
  memoryFiles.set('valid-meta-older', {
    id: 'valid-meta-older', name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T11:00:02.000Z',
    payload: {
      schemaVersion: 1,
      generationId: duplicateGeneration,
      updatedAt: Date.now(),
      files: {
        settings: { id: 'valid-settings-older', name: 'tw_overlay_settings.json' },
        checklist: { id: 'valid-checklist-duplicate', name: 'tw_overlay_checklist.json' },
      },
    },
  });
  memoryFiles.set('corrupt-meta-newer', {
    id: 'corrupt-meta-newer', name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T11:00:04.000Z', payload: { schemaVersion: 1, generationId: 123 },
  });
  memoryFiles.set('dangling-meta-newest', {
    id: 'dangling-meta-newest', name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T11:00:05.000Z',
    payload: {
      schemaVersion: 1,
      generationId: 'generation-with-no-data-files',
      updatedAt: Date.now(),
      files: {
        settings: { id: 'missing-settings-id', name: 'tw_overlay_settings.json' },
        checklist: { id: 'missing-checklist-id', name: 'tw_overlay_checklist.json' },
      },
    },
  });
  const duplicateRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(duplicateRestore.success, true);
  assert.equal(duplicateRestore.partial, false);
  assert.equal(configModule.load().userServer, 13,
    '손상된 최신 중복 파일 대신 메타가 가리키는 유효 설정 파일을 복원하지 않았습니다.');

  // established 자동 pull도 손상된 설정 파일과 정상 숙제 파일을 독립 처리한다.
  memoryFiles.clear();
  const establishedPartialGeneration = 'generation-established-partial';
  const establishedBaseChecklist = syncDataHelper.extractChecklistSyncData(configModule.load());
  const establishedRemoteConfig = structuredClone(configModule.load());
  establishedRemoteConfig.characterPresets = establishedRemoteConfig.characterPresets.map((character: any, index: number) => (
    index === 0 ? { ...character, name: 'established 원격 정상 캐릭터' } : character
  ));
  const establishedChecklist = syncDataHelper.buildChecklistSyncPayload(
    establishedRemoteConfig,
    'remote-established-pc',
    establishedPartialGeneration,
    [],
  );
  memoryFiles.set('established-corrupt-settings', {
    id: 'established-corrupt-settings', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T11:10:00.000Z', payload: { invalid: true },
  });
  memoryFiles.set('established-valid-checklist', {
    id: 'established-valid-checklist', name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T11:10:01.000Z', payload: establishedChecklist,
  });
  memoryFiles.set('established-partial-meta', {
    id: 'established-partial-meta', name: 'tw_overlay_sync_meta.json',
    modifiedTime: '2026-08-25T11:10:02.000Z',
    payload: {
      schemaVersion: 1,
      generationId: establishedPartialGeneration,
      updatedAt: Date.now(),
      files: {
        settings: { id: 'established-corrupt-settings', name: 'tw_overlay_settings.json' },
        checklist: { id: 'established-valid-checklist', name: 'tw_overlay_checklist.json' },
      },
    },
  });
  cloudSyncState.update((state: any) => {
    state.profileState = 'established';
    state.generationId = establishedPartialGeneration;
    state.fileIds = {};
    state.remoteRevisions = {};
    state.baseSettings = syncDataHelper.extractSettingsSyncData(configModule.load());
    state.baseChecklist = establishedBaseChecklist;
    state.settingsDirtyKeys = [];
    state.settingsDirtyAt = {};
    state.checklistOutbox = [];
    state.confirmedChecklistOperations = [];
  });
  const establishedPartialPull = await cloudManager.syncFromCloud(false);
  assert.equal(establishedPartialPull.success, true);
  assert.equal(establishedPartialPull.partial, true);
  assert.equal(establishedPartialPull.restoreResults.find((result: any) => result.kind === 'settings').status,
    'invalid');
  assert.equal(establishedPartialPull.restoreResults.find((result: any) => result.kind === 'checklist').status,
    'restored');
  assert.equal(configModule.load().characterPresets[0].name, 'established 원격 정상 캐릭터',
    'established pull에서 손상 설정 때문에 정상 숙제 변경이 누락됐습니다.');
  assert.equal(cloudSyncState.load().checklistOutbox.length, 0,
    'established 부분 pull이 원격 숙제 적용을 echo outbox로 만들었습니다.');

  // 메타가 없을 때 최신 세대와 다른 유효 파일은 독립적으로 제외한다.
  memoryFiles.clear();
  const mismatchedSettings = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 5,
  }, 'remote-pc', 'generation-old');
  const newestChecklist = syncDataHelper.buildChecklistSyncPayload(configModule.load(), 'remote-pc', 'generation-new', []);
  memoryFiles.set('mismatch-settings', {
    id: 'mismatch-settings', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T12:00:00.000Z', payload: mismatchedSettings,
  });
  memoryFiles.set('newest-checklist', {
    id: 'newest-checklist', name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T12:00:01.000Z', payload: newestChecklist,
  });
  const mismatchPreview = await cloudManager.getCloudDataPreview();
  assert.equal(mismatchPreview.success, true);
  assert.equal(mismatchPreview.partial, true);
  assert.equal(mismatchPreview.payload.data.characterPresets !== undefined, true,
    'generation 불일치 설정 때문에 정상 숙제 미리보기가 누락되었습니다.');
  assert.equal(mismatchPreview.restoreResults.find((result: any) => result.kind === 'settings').status,
    'generation-mismatch');
  const checklistPreview = await cloudManager.getCloudDataPreview('checklist');
  assert.equal(checklistPreview.success, true);
  assert.equal(checklistPreview.fileMeta.name, 'tw_overlay_checklist.json');
  assert.equal(checklistPreview.fileCount, 1);
  assert.deepEqual(checklistPreview.restoreResults.map((result: any) => result.kind), ['checklist']);
  assert.equal(checklistPreview.payload.data.characterPresets !== undefined, true);
  assert.equal(checklistPreview.payload.data.userServer, undefined,
    '숙제 카드 미리보기에 일반 설정 데이터가 섞였습니다.');
  const settingsPreview = await cloudManager.getCloudDataPreview('settings');
  assert.equal(settingsPreview.success, false,
    '공유 generation과 불일치하는 설정 파일을 카드 미리보기에서 정상 처리했습니다.');
  assert.deepEqual(settingsPreview.restoreResults.map((result: any) => result.kind), ['settings']);
  assert.equal(settingsPreview.restoreResults[0].status, 'generation-mismatch');
  const mismatchRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(mismatchRestore.success, true);
  assert.equal(mismatchRestore.partial, true);
  assert.equal(mismatchRestore.restoreResults.find((result: any) => result.kind === 'settings').status,
    'generation-mismatch');
  assert.equal(mismatchRestore.restoreResults.find((result: any) => result.kind === 'checklist').status,
    'restored');

  // 설정 파일만 존재해도 설정은 복원하고 숙제는 missing으로 분리 보고한다.
  memoryFiles.clear();
  const settingsOnlyPayload = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(), userServer: 21,
  }, 'remote-pc', 'generation-settings-only');
  memoryFiles.set('settings-only', {
    id: 'settings-only', name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T13:00:00.000Z', payload: settingsOnlyPayload,
  });
  const settingsOnlyRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(settingsOnlyRestore.success, true);
  assert.equal(settingsOnlyRestore.partial, true);
  assert.equal(settingsOnlyRestore.restoreResults.find((result: any) => result.kind === 'checklist').status, 'missing');
  assert.equal(configModule.load().userServer, 21);

  // 숙제 파일만 존재해도 숙제는 복원하고 설정은 missing으로 분리 보고한다.
  memoryFiles.clear();
  const checklistOnlyPayload = syncDataHelper.buildChecklistSyncPayload({
    ...configModule.load(),
    characterPresets: [{ id: 'checklist-only-character', name: '숙제 전용 캐릭터' }],
  }, 'remote-pc', 'generation-checklist-only', []);
  memoryFiles.set('checklist-only', {
    id: 'checklist-only', name: 'tw_overlay_checklist.json',
    modifiedTime: '2026-08-25T13:10:00.000Z', payload: checklistOnlyPayload,
  });
  const checklistOnlyRestore = await cloudManager.syncFromCloud(true, ['settings', 'checklist']);
  assert.equal(checklistOnlyRestore.success, true);
  assert.equal(checklistOnlyRestore.partial, true);
  assert.equal(checklistOnlyRestore.restoreResults.find((result: any) => result.kind === 'settings').status, 'missing');
  assert.equal(configModule.load().characterPresets.some((character: any) =>
    character.id === 'checklist-only-character'), true);

  // 실제 설정 복원 경로에서도 누락된 신규 기본값과 PC 종속·민감 값은 현재 PC 값을 보존한다.
  memoryFiles.clear();
  configModule.saveImmediate({
    userServer: 3,
    showTodaySummaryHud: false,
    discordWebhookUrl: 'https://discord.com/api/webhooks/local-secret',
    chatLogPath: 'C:\\local\\TalesWeaver\\ChatLog',
    positions: { overlay: { x: 321, y: 654, width: 400, height: 300 } },
    customSounds: [{ name: '로컬 알림음', file: 'custom_local_only.mp3' }],
    wordAlarmSound: 'custom_local_only.mp3',
  });
  const settingsPreservationPayload = syncDataHelper.buildSettingsSyncPayload({
    ...configModule.load(),
    userServer: 22,
  }, 'remote-pc', 'generation-settings-preservation');
  delete settingsPreservationPayload.data.showTodaySummaryHud;
  settingsPreservationPayload.checksum = syncDataHelper.calculateSyncChecksum(settingsPreservationPayload.data);
  memoryFiles.set('settings-preservation', {
    id: 'settings-preservation',
    name: 'tw_overlay_settings.json',
    modifiedTime: '2026-08-25T13:20:00.000Z',
    payload: settingsPreservationPayload,
  });
  const preservationPreview = await cloudManager.getCloudDataPreview();
  assert.equal(preservationPreview.success, true);
  const settingsSummary = preservationPreview.changeSummaries.find((summary: any) => summary.kind === 'settings');
  assert.equal(settingsSummary.changedKeys.includes('userServer'), true);
  assert.equal(settingsSummary.preservedLocalKeys.includes('showTodaySummaryHud'), true,
    '클라우드에 없는 신규 설정 키가 현재 PC 유지 항목으로 요약되지 않았습니다.');
  assert.equal(JSON.stringify(settingsSummary).includes('local-secret'), false,
    '변경 요약에 로컬 비밀값이 포함되었습니다.');
  const preservationRestore = await cloudManager.syncFromCloud(true, ['settings']);
  assert.equal(preservationRestore.success, true);
  const preservedConfig = configModule.load();
  assert.equal(preservedConfig.userServer, 22);
  assert.equal(preservedConfig.showTodaySummaryHud, false,
    '클라우드에 없는 설정 키의 기존 false 값이 기본값으로 덮였습니다.');
  assert.equal(preservedConfig.discordWebhookUrl, 'https://discord.com/api/webhooks/local-secret');
  assert.equal(preservedConfig.chatLogPath, 'C:\\local\\TalesWeaver\\ChatLog');
  assert.equal(preservedConfig.positions?.overlay?.x, 321);
  assert.equal(preservedConfig.positions?.overlay?.y, 654);
  assert.equal(preservedConfig.positions?.overlay?.width, 400);
  assert.equal(preservedConfig.positions?.overlay?.height, 300);
  assert.deepEqual(preservedConfig.customSounds, [{ name: '로컬 알림음', file: 'custom_local_only.mp3' }]);
  assert.equal(preservedConfig.wordAlarmSound, 'custom_local_only.mp3');
  const preRestoreBackup = JSON.parse(fs.readFileSync(
    path.join(isolatedUserData, 'config.backup-sync.json'),
    'utf8',
  ));
  assert.equal(preRestoreBackup.userServer, 3,
    '설정 복원 전 로컬 상태가 백업 파일에 보존되지 않았습니다.');
  assert.equal(preRestoreBackup.discordWebhookUrl, 'https://discord.com/api/webhooks/local-secret');
  const backupStatus = cloudManager.getSyncStatus();
  assert.equal(backupStatus.localBackupAvailable, true);
  assert.equal(typeof backupStatus.localBackupCreatedAt, 'number');
  assert.deepEqual(backupStatus.fileStatuses.map((status: any) => status.kind), ['settings', 'checklist']);
  assert.equal(backupStatus.fileStatuses.every((status: any) => /^[a-f0-9]{64}$/.test(status.localChecksum)), true);
  assert.equal(JSON.stringify(backupStatus.fileStatuses).includes('local-secret'), false,
    '파일별 상태에 로컬 비밀값이 포함되었습니다.');
  const rollbackResult = await cloudManager.rollbackLastRestore();
  assert.equal(rollbackResult.success, true);
  assert.equal(configModule.load().userServer, 3,
    '클라우드 복원 전 로컬 설정으로 되돌리지 못했습니다.');
  assert.equal(configModule.load().discordWebhookUrl, 'https://discord.com/api/webhooks/local-secret');

  // 로컬 dirty와 원격 변경이 충돌하면 pull이 로컬 값을 보존하고 이어서 업로드해야 한다.
  memoryFiles.clear();
  cloudSyncState.update((state: any) => {
    state.profileState = 'established';
    state.remoteRevisions = {};
    state.remoteFileFingerprints = {};
    state.fileIds = {};
    state.settingsDirtyKeys = [];
    state.settingsDirtyAt = {};
  });
  const settingsConflictGeneration = 'generation-settings-conflict';
  const conflictingRemoteSettingsPayload = syncDataHelper.buildSettingsSyncPayload(
    { ...configModule.load(), userServer: 7 },
    'remote-settings-pc',
    settingsConflictGeneration,
  );
  memoryFiles.set('settings-conflict', {
    id: 'settings-conflict',
    name: 'tw_overlay_settings.json',
    modifiedTime: new Date(Date.now() + 5_000).toISOString(),
    payload: conflictingRemoteSettingsPayload,
  });
  configModule.saveImmediate({ userServer: 21 });
  assert.equal(cloudSyncState.load().settingsDirtyKeys.includes('userServer'), true,
    '업로드 전 로컬 설정 변경이 dirty로 기록되지 않았습니다.');
  const settingsConflictPull = await cloudManager.syncFromCloud(false, ['settings']);
  assert.equal(settingsConflictPull.success, true, '원격 설정 충돌 확인이 실패했습니다.');
  assert.equal(configModule.load().userServer, 21,
    '원격 설정 충돌 확인 중 업로드 대기 로컬 값이 사라졌습니다.');
  const settingsConflictDeadline = Date.now() + 2_000;
  const currentSettingsFile = () => Array.from(memoryFiles.values())
    .find(file => file.name === 'tw_overlay_settings.json');
  while (
    (cloudSyncState.load().settingsDirtyKeys.includes('userServer')
      || currentSettingsFile()?.payload.data.userServer !== 21)
    && Date.now() < settingsConflictDeadline
  ) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(currentSettingsFile()?.payload.data.userServer, 21,
    '원격 변경과 충돌한 로컬 설정이 후속 업로드로 수렴하지 않았습니다.');
  assert.equal(cloudSyncState.load().settingsDirtyKeys.includes('userServer'), false,
    '충돌 설정의 검증된 후속 업로드 뒤 dirty 상태가 남았습니다.');

  // 종료 marker는 파일별 dirty/operation을 내구 저장하고 각각 확인된 뒤에만 제거한다.
  cloudSyncState.update((state: any) => {
    state.settingsDirtyKeys = ['userServer'];
    state.settingsDirtyAt = { userServer: Date.now() };
    state.checklistOutbox = [{
      id: 'shutdown-operation-1',
      deviceId: state.deviceId,
      createdAt: Date.now(),
      keys: ['contentsCheckerItems'],
      mutations: [],
    }];
  });
  assert.equal(cloudManager.prepareShutdownRecovery(), true);
  cloudSyncState.resetCacheForTests();
  let shutdownState = cloudSyncState.load();
  assert.deepEqual(shutdownState.shutdownRecovery.settings.dirtyKeys, ['userServer']);
  assert.deepEqual(shutdownState.shutdownRecovery.checklist.operationIds, ['shutdown-operation-1']);
  cloudSyncState.update((state: any) => {
    state.settingsDirtyKeys = [];
    state.settingsDirtyAt = {};
    state.checklistOutbox = [];
  });
  assert.equal(cloudManager.prepareShutdownRecovery(), true,
    '원격 확인 없이 다시 종료할 때 기존 recovery marker를 제거했습니다.');
  assert.ok(cloudSyncState.load().shutdownRecovery.settings);
  assert.ok(cloudSyncState.load().shutdownRecovery.checklist);
  cloudSyncState.update((state: any) => {
    state.settingsDirtyKeys = ['userServer'];
    state.settingsDirtyAt = { userServer: Date.now() };
    state.checklistOutbox = [{
      id: 'shutdown-operation-1',
      deviceId: state.deviceId,
      createdAt: Date.now(),
      keys: ['contentsCheckerItems'],
      mutations: [],
    }];
  });
  assert.equal(cloudManager.reconcileShutdownRecovery(), false,
    '미확인 dirty/outbox가 있는데 종료 recovery marker를 제거했습니다.');
  cloudSyncState.update((state: any) => {
    state.settingsDirtyKeys = [];
    state.settingsDirtyAt = {};
  });
  assert.equal(cloudManager.reconcileShutdownRecovery(), false);
  shutdownState = cloudSyncState.load();
  assert.equal(shutdownState.shutdownRecovery.settings, undefined);
  assert.ok(shutdownState.shutdownRecovery.checklist);
  cloudSyncState.update((state: any) => { state.checklistOutbox = []; });
  assert.equal(cloudManager.reconcileShutdownRecovery(), true);
  assert.equal(cloudSyncState.load().shutdownRecovery, undefined);

  // 실제 매니저 scheduler가 게임 실행/유휴 상태에 맞는 주기와 installation jitter를 예약한다.
  cloudSyncState.update((state: any) => { state.profileState = 'established'; });
  const pollingLoopModule = require(path.join(projectRoot, 'dist', 'modules', 'pollingLoop.js'));
  const originalGetGameStatus = pollingLoopModule.getGameStatus;
  const originalListSyncFiles = googleDrive.listSyncFiles;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduledPullDelays: number[] = [];
  let clearedPullTimers = 0;
  (globalThis as any).setTimeout = (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const callbackSource = typeof callback === 'function' ? Function.prototype.toString.call(callback) : '';
    const isCloudPullTimer = callbackSource.includes('syncFromCloud(false)')
      && callbackSource.includes('주기적 수신 실패');
    if (isCloudPullTimer && typeof delay === 'number' && delay >= 25_000 && delay <= 1_000_000) {
      scheduledPullDelays.push(delay);
      return { cloudPullProbeTimer: true };
    }
    return (originalSetTimeout as any)(callback, delay, ...args);
  };
  (globalThis as any).clearTimeout = (timer: any) => {
    if (timer?.cloudPullProbeTimer) {
      clearedPullTimers++;
      return;
    }
    return (originalClearTimeout as any)(timer);
  };
  const capturePullDelay = async (gameStatus: 'running' | 'stopped'): Promise<number> => {
    const before = scheduledPullDelays.length;
    pollingLoopModule.getGameStatus = () => gameStatus;
    cloudManager.startBackgroundSync();
    for (let attempt = 0; attempt < 5 && scheduledPullDelays.length === before; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    cloudManager.stopBackgroundSync();
    assert.equal(scheduledPullDelays.length, before + 1,
      `${gameStatus} 상태에서 다음 클라우드 pull 타이머를 하나 예약하지 않았습니다.`);
    return scheduledPullDelays[before];
  };
  try {
    const runningDelay = await capturePullDelay('running');
    assert.ok(runningDelay >= 27_000 && runningDelay <= 33_000,
      `게임 실행 중 pull 주기가 30초 installation jitter 범위를 벗어났습니다: ${runningDelay}`);
    const idleDelay = await capturePullDelay('stopped');
    assert.ok(idleDelay >= 270_000 && idleDelay <= 330_000,
      `게임 미실행 pull 주기가 5분 installation jitter 범위를 벗어났습니다: ${idleDelay}`);

    pollingLoopModule.getGameStatus = () => 'running';
    cloudManager.startBackgroundSync();
    await new Promise<void>(resolve => setImmediate(resolve));
    let before = scheduledPullDelays.length;
    googleDrive.listSyncFiles = async () => {
      throw new Error('forced periodic pull failure');
    };
    await assert.rejects(cloudManager.syncFromCloud(false), /forced periodic pull failure/);
    for (let attempt = 0; attempt < 5 && scheduledPullDelays.length === before; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(scheduledPullDelays.length, before + 1,
      '자동 pull 실패 뒤 다음 재시도 타이머를 예약하지 않았습니다.');
    const failureDelay = scheduledPullDelays[before];
    assert.ok(failureDelay >= 54_000 && failureDelay <= 66_000,
      `첫 pull 실패의 2배 backoff가 60초 installation jitter 범위를 벗어났습니다: ${failureDelay}`);

    googleDrive.listSyncFiles = originalListSyncFiles;
    before = scheduledPullDelays.length;
    const recoveredPull = await cloudManager.syncFromCloud(false);
    assert.equal(recoveredPull.success, true);
    for (let attempt = 0; attempt < 5 && scheduledPullDelays.length === before; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(scheduledPullDelays.length, before + 1,
      '자동 pull 성공 뒤 정상 주기 타이머를 다시 예약하지 않았습니다.');
    const recoveredDelay = scheduledPullDelays[before];
    assert.ok(recoveredDelay >= 27_000 && recoveredDelay <= 33_000,
      `성공 뒤 pull backoff가 30초 installation jitter 범위로 초기화되지 않았습니다: ${recoveredDelay}`);

    let immediateListCalls = 0;
    googleDrive.listSyncFiles = async () => {
      immediateListCalls++;
      return originalListSyncFiles();
    };
    before = scheduledPullDelays.length;
    const clearsBeforeImmediate = clearedPullTimers;
    cloudManager.requestImmediatePull('regression-immediate-pull');
    await cloudManager.flushPendingSync();
    for (let attempt = 0; attempt < 5 && scheduledPullDelays.length === before; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(immediateListCalls >= 1,
      '즉시 pull 요청이 Drive 파일 목록을 바로 조회하지 않았습니다.');
    assert.ok(clearedPullTimers > clearsBeforeImmediate,
      '즉시 pull 요청이 기존 장기 pull 타이머를 취소하지 않았습니다.');
    assert.equal(scheduledPullDelays.length, before + 1,
      '즉시 pull 완료 뒤 정상 주기 타이머를 하나 다시 예약하지 않았습니다.');
    const immediateFollowupDelay = scheduledPullDelays[before];
    assert.ok(immediateFollowupDelay >= 27_000 && immediateFollowupDelay <= 33_000,
      `즉시 pull 뒤 후속 주기가 30초 installation jitter 범위를 벗어났습니다: ${immediateFollowupDelay}`);
  } finally {
    cloudManager.stopBackgroundSync();
    pollingLoopModule.getGameStatus = originalGetGameStatus;
    googleDrive.listSyncFiles = originalListSyncFiles;
    (globalThis as any).setTimeout = originalSetTimeout;
    (globalThis as any).clearTimeout = originalClearTimeout;
  }
}

function checkLargeChatLogReadBoundary(): void {
  const {
    findLastCompleteChatLogOffset,
    readInitialChatLogSnapshot,
    trimRecentChatLogLines,
  } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogFileReader.js')) as {
    findLastCompleteChatLogOffset(filePath: string, snapshotSize?: number): number;
    readInitialChatLogSnapshot(
      filePath: string,
      options?: { maxFullReadBytes?: number; recentReadBytes?: number; headerReadBytes?: number },
    ): { lines: string[]; damaged: boolean; limited: boolean; fileSize: number };
    trimRecentChatLogLines(
      lines: readonly string[],
      maxChars?: number,
      targetChars?: number,
    ): { lines: string[]; removedCount: number; totalChars: number };
  };

  const fixtureDir = path.join(isolatedUserData, 'large-chat-log-fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const smallPath = path.join(fixtureDir, 'small.html');
  const dateHeader = 'Date : 2026년 8월 25일';
  fs.writeFileSync(smallPath, `${dateHeader}\nsmall-marker`, 'utf8');
  const small = readInitialChatLogSnapshot(smallPath, { maxFullReadBytes: 1024 });
  assert.equal(small.limited, false);
  assert.match(small.lines.join('\n'), /small-marker/);

  const largePath = path.join(fixtureDir, 'large.html');
  const middleLines = Array.from({ length: 80 }, (_, index) => (
    `<font color="white"> [ ${index % 24}시 1분 1초] </font><font color="#ffffff">line-${index}-${'x'.repeat(24)}</font></br>`
  ));
  fs.writeFileSync(
    largePath,
    [dateHeader, ...middleLines.slice(0, 30), 'middle-marker-must-not-remain', ...middleLines.slice(30), 'latest-marker-must-remain'].join('\n'),
    'utf8',
  );
  const large = readInitialChatLogSnapshot(largePath, {
    maxFullReadBytes: 256,
    recentReadBytes: 512,
    headerReadBytes: 64,
  });
  const largeText = large.lines.join('\n');
  assert.equal(large.limited, true);
  assert.match(largeText, /Date : 2026년 8월 25일/);
  assert.match(largeText, /latest-marker-must-remain/);
  assert.doesNotMatch(largeText, /middle-marker-must-not-remain/);

  const splitUtf8Path = path.join(fixtureDir, 'split-valid-utf8.html');
  const splitHeader = `${dateHeader}\n`;
  const splitBody = `${'가나다라마바사'.repeat(200)}\nlatest-valid-marker\n`;
  const splitBuffer = Buffer.from(splitHeader + splitBody, 'utf8');
  fs.writeFileSync(splitUtf8Path, splitBuffer);
  const firstKoreanByte = Buffer.byteLength(splitHeader, 'utf8');
  const splitUtf8 = readInitialChatLogSnapshot(splitUtf8Path, {
    maxFullReadBytes: 1,
    headerReadBytes: firstKoreanByte + 1,
    recentReadBytes: splitBuffer.length - firstKoreanByte - 1,
  });
  assert.equal(splitUtf8.limited, true);
  assert.equal(splitUtf8.damaged, false,
    '제한 구간 시작·끝의 폐기할 불완전 UTF-8 행을 실제 파일 손상으로 오인했습니다.');
  assert.equal(splitUtf8.lines.some(line => line.includes('\uFFFD')), false);
  assert.match(splitUtf8.lines.join('\n'), /latest-valid-marker/);

  const trimmed = trimRecentChatLogLines(['a'.repeat(60), 'b'.repeat(60), 'latest'], 100, 80);
  assert.ok(trimmed.removedCount > 0);
  assert.equal(trimmed.lines.includes('a'.repeat(60)), false);
  assert.equal(trimmed.lines.at(-1), 'latest');
  assert.ok(trimmed.totalChars <= 80);

  const completeBoundaryPath = path.join(fixtureDir, 'complete-boundary.html');
  const completeBoundaryPrefix = '<font>완전한 첫 줄</font></br>\n';
  const incompleteBoundarySuffix = '<font>작성 중인 둘째 줄';
  fs.writeFileSync(completeBoundaryPath, completeBoundaryPrefix + incompleteBoundarySuffix, 'utf8');
  assert.equal(
    findLastCompleteChatLogOffset(completeBoundaryPath),
    Buffer.byteLength(completeBoundaryPrefix, 'utf8'),
    '작성 중인 마지막 물리 줄이 전체 재구성 snapshot에 포함되었습니다.',
  );
  const noNewlineCompletePath = path.join(fixtureDir, 'complete-without-newline.html');
  fs.writeFileSync(noNewlineCompletePath, '<font>닫힌 한 줄</font></br>', 'utf8');
  assert.equal(
    findLastCompleteChatLogOffset(noNewlineCompletePath),
    fs.statSync(noNewlineCompletePath).size,
    '개행 없이 </br>로 닫힌 구형 로그 행을 불완전한 줄로 잘못 제외했습니다.',
  );
}

function checkStoreUpdateLogic(): void {
  const policy = require(path.join(projectRoot, 'dist', 'modules', 'storeUpdatePolicy.js')) as {
    resolveStoreUpdateStartupAction: (mandatory: boolean, autoUpdateEnabled: boolean) => string;
    normalizeStorePackageVersion: (version: string | undefined) => string | undefined;
  };
  assert.equal(policy.resolveStoreUpdateStartupAction(false, true), 'install-on-splash');
  assert.equal(policy.resolveStoreUpdateStartupAction(false, false), 'notify-only');
  assert.equal(policy.resolveStoreUpdateStartupAction(true, true), 'install-on-splash');
  assert.equal(policy.resolveStoreUpdateStartupAction(true, false), 'install-on-splash');
  assert.equal(policy.normalizeStorePackageVersion('3.0.3.0'), '3.0.3');
  assert.equal(policy.normalizeStorePackageVersion('3.0.3.4'), '3.0.3.4');

  const storeUpdater = require(path.join(projectRoot, 'dist', 'modules', 'storeUpdater.js')) as {
    parseStoreUpdateHelperEvent: (line: string) => any;
  };
  assert.deepEqual(
    storeUpdater.parseStoreUpdateHelperEvent('{"type":"check-result","updateAvailable":true,"mandatory":true,"canSilentlyInstall":false,"version":"3.0.3.0"}'),
    { type: 'check-result', updateAvailable: true, mandatory: true, canSilentlyInstall: false, version: '3.0.3.0' },
  );
  assert.deepEqual(
    storeUpdater.parseStoreUpdateHelperEvent('{"type":"progress","phase":"downloading","percent":105}'),
    { type: 'progress', phase: 'downloading', percent: 100 },
  );
  assert.deepEqual(
    storeUpdater.parseStoreUpdateHelperEvent('{"type":"install-result","state":"completed","completed":true,"mandatory":false,"noUpdate":false}'),
    { type: 'install-result', state: 'completed', completed: true, mandatory: false, noUpdate: false },
  );
  assert.throws(
    () => storeUpdater.parseStoreUpdateHelperEvent('{"type":"check-result","updateAvailable":"yes"}'),
    /올바르지 않습니다/,
  );

  const updaterSource = read('src/modules/updater.ts');
  const helperSource = read('native/store-update-helper/Program.cs');
  const settingsSource = read('src/settings.html');
  const splashSource = read('src/splash.html');
  const packageJson = JSON.parse(read('package.json')) as {
    scripts?: Record<string, string>;
    build?: { asarUnpack?: string[] };
  };
  assert.match(updaterSource, /process\.windowsStore[\s\S]*?checkStoreUpdatePolicy\(notifyReady\)/,
    'Store 설치본 실행 시 실제 Store 업데이트 확인이 시작되지 않습니다.');
  assert.match(updaterSource, /resolveStoreUpdateStartupAction/,
    'Store 강제/자동 업데이트 정책 연결이 누락되었습니다.');
  assert.match(updaterSource, /pendingStoreReadyToLaunch[\s\S]*?releaseStoreReadyToLaunch/,
    '필수 Store 업데이트 재시도 뒤 최초 앱 실행 콜백을 복구하는 경로가 누락되었습니다.');
  assert.match(updaterSource, /restoreSettingsAfterManualStoreAttempt/,
    '수동 Store 업데이트 실패 뒤 숨겨진 설정 창을 복구하는 경로가 누락되었습니다.');
  const installFailureHandler = updaterSource.slice(
    updaterSource.indexOf('async function handleStoreInstallFailure'),
    updaterSource.indexOf('async function startStoreUpdateInstallation'),
  );
  const optionalInstallFailure = installFailureHandler.slice(installFailureHandler.indexOf('isMandatory = false'));
  assert.match(optionalInstallFailure, /state: 'error'/,
    '선택 Store 업데이트 설치 실패가 오류 상태로 전달되지 않습니다.');
  assert.doesNotMatch(optionalInstallFailure, /state: 'available'/,
    '선택 Store 업데이트 설치 실패가 업데이트 가능 상태로 잘못 유지됩니다.');
  assert.doesNotMatch(helperSource, /Console\.OutputEncoding\s*=/,
    '콘솔이 없는 Store 환경에서 실패할 수 있는 출력 인코딩 설정이 남아 있습니다.');
  assert.doesNotMatch(helperSource, /Package\.Id\.Version/,
    'Store의 현재 설치 패키지 버전을 새 업데이트 버전으로 잘못 전달합니다.');
  assert.match(settingsSource, /case 'available':[\s\S]{0,300}version\s*\?[\s\S]{0,150}: '새 업데이트 발견!'/,
    'Store가 대상 버전을 제공하지 않을 때 사용할 업데이트 제목이 없습니다.');
  assert.match(settingsSource, /case 'error':[\s\S]{0,500}openStoreUpdates\(\)/,
    'Store 설치 실패 시 Microsoft Store를 직접 여는 복구 동작이 없습니다.');
  assert.match(helperSource, /update\.Mandatory/,
    'Partner Center 강제 업데이트 플래그 조회가 누락되었습니다.');
  assert.match(helperSource, /TrySilentDownloadStorePackageUpdatesAsync/,
    'Store 무음 다운로드 경로가 누락되었습니다.');
  assert.match(helperSource, /RequestDownloadAndInstallStorePackageUpdatesAsync/,
    'Store 사용자 승인 설치 경로가 누락되었습니다.');
  assert.match(splashSource, /retryStoreUpdate[\s\S]*?openStoreUpdates/,
    '필수 Store 업데이트 실패 시 재시도 UI가 누락되었습니다.');
  assert.match(packageJson.scripts?.['dist:appx'] || '', /build:store-helper/,
    'AppX 패키징 전에 Store 업데이트 도우미를 빌드하지 않습니다.');
  assert.ok(packageJson.build?.asarUnpack?.includes('dist/store-update-helper/**'),
    'Store 업데이트 도우미가 ASAR unpack 대상이 아닙니다.');
}

async function checkChatSearchSizeBoundaries(): Promise<void> {
  const { readInitialChatLogSnapshot } = require(
    path.join(projectRoot, 'dist', 'modules', 'chatLogFileReader.js'),
  ) as {
    readInitialChatLogSnapshot(
      filePath: string,
      options?: { maxFullReadBytes?: number; recentReadBytes?: number; headerReadBytes?: number },
    ): { lines: string[]; limited: boolean; fileSize: number };
  };
  const { chatLogManager } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogManager.js')) as any;
  const fixtureDirectory = path.join(isolatedUserData, 'chat-search-size-fixtures');
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  const fixturePath = path.join(fixtureDirectory, 'TWChatLog_2026_08_26.html');
  const chatLine = (hour: number, message: string) => (
    `<font color="white"> [ ${hour}시 1분 1초] </font><font color="#ffffff">검색자 : ${message}</font></br>`
  );
  const recentLines = [
    chatLine(20, 'recent-marker-1'),
    chatLine(21, 'recent-marker-2'),
    chatLine(22, 'recent-marker-3'),
  ];
  const fixtureLines = [
    'Date : 2026년 8월 26일',
    ...Array.from({ length: 300 }, (_, index) => chatLine(index % 20, `ordinary-${index}-${'x'.repeat(24)}`)),
    ...recentLines,
  ];
  fs.writeFileSync(fixturePath, fixtureLines.join('\n') + '\n', 'utf8');
  const fileSize = fs.statSync(fixturePath).size;
  const normal = readInitialChatLogSnapshot(fixturePath, { maxFullReadBytes: fileSize + 1 });
  const boundary = readInitialChatLogSnapshot(fixturePath, { maxFullReadBytes: fileSize });
  const oversized = readInitialChatLogSnapshot(fixturePath, {
    maxFullReadBytes: fileSize - 1,
    recentReadBytes: 2_048,
    headerReadBytes: 64,
  });
  assert.equal(normal.limited, false);
  assert.equal(boundary.limited, false);
  assert.equal(oversized.limited, true);

  const originalLines = chatLogManager._todayLines;
  try {
    const search = async (lines: string[]) => {
      chatLogManager._todayLines = lines;
      const result = await chatLogManager.searchChatLogs('recent-marker', { category: 'Basic', limit: 50 });
      return result.map((item: any) => ({
        type: item.type,
        timestamp: item.timestamp,
        sender: item.sender,
        message: item.message,
        color: item.color,
      }));
    };
    const normalResult = await search(normal.lines);
    assert.deepEqual(await search(boundary.lines), normalResult,
      '당일 로그 안전 모드 경계값에서 검색 결과가 달라졌습니다.');
    assert.deepEqual(await search(oversized.lines), normalResult,
      '초대형 최근 구간 안전 모드에서 보존 대상 검색 결과가 달라졌습니다.');
    assert.deepEqual(normalResult.map((item: any) => item.message), [
      'recent-marker-1',
      'recent-marker-2',
      'recent-marker-3',
    ]);
  } finally {
    chatLogManager._todayLines = originalLines;
  }
}

async function checkChatTailRecoveryBoundary(): Promise<void> {
  const {
    getTailRetryDelayMs,
    releaseFailedTail,
    shouldAutoDiscoverChatLogPath,
  } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogManager.js')) as {
    getTailRetryDelayMs(attempt: number): number;
    releaseFailedTail(tail: { unwatch(): void }): null;
    shouldAutoDiscoverChatLogPath(configuredPath: unknown): boolean;
  };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(getTailRetryDelayMs),
    [1000, 2000, 4000, 8000, 16000, 16000],
  );
  let unwatchCount = 0;
  const released = releaseFailedTail({ unwatch: () => { unwatchCount++; } });
  assert.equal(released, null);
  assert.equal(unwatchCount, 1);
  assert.doesNotThrow(() => releaseFailedTail({ unwatch: () => { throw new Error('already closed'); } }));
  assert.equal(shouldAutoDiscoverChatLogPath(''), true);
  assert.equal(shouldAutoDiscoverChatLogPath('   '), true);
  assert.equal(shouldAutoDiscoverChatLogPath('Z:\\Temporarily-Offline\\ChatLog'), false);

  const managerSource = read('src/modules/chatLogManager.ts');
  assert.match(
    managerSource,
    /tail\.on\('error',[\s\S]*?this\._tail = releaseFailedTail\(tail\);[\s\S]*?this\.scheduleTailReconnect\(filePath\);/,
    'Tail 오류 뒤 watcher 해제/null 처리와 재연결 예약이 이어지지 않습니다.',
  );
  assert.match(
    managerSource,
    /if \(currentPath !== filePath\) return;\s*if \(!fs\.existsSync\(filePath\)\) \{\s*this\.scheduleTailReconnect\(filePath\);\s*return;/,
    '재연결 시점에 파일이 아직 없으면 다음 지수 백오프 예약이 이어지지 않습니다.',
  );

  const { ChatLogManager } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogManager.js')) as any;
  const { chatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js')) as any;
  const catchUpDir = path.join(isolatedUserData, 'chat-tail-catch-up-fixture');
  fs.mkdirSync(catchUpDir, { recursive: true });
  const catchUpPath = path.join(catchUpDir, 'TWChatLog_2026_08_29.html');
  const ignoredPrefix = '<font size="2" color="white"> [10시 00분 00초] </font><font size="2" color="#ff64ff">경험치가 1 올랐습니다.</font></br>\n';
  const caughtUpLine = '<font size="2" color="white"> [10시 00분 01초] </font><font size="2" color="#ff64ff">콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.</font></br>\n';
  const splitLine = '<font size="2" color="white"> [10시 00분 02초] </font><font size="2" color="#ff64ff">콘텐츠 클리어 보상으로 1200만 SEED를 획득했습니다.</font></br>';
  const splitAt = Buffer.byteLength(splitLine, 'utf8') - 11;
  const splitBytes = Buffer.from(splitLine, 'utf8');
  fs.writeFileSync(catchUpPath, Buffer.concat([
    Buffer.from(ignoredPrefix + caughtUpLine, 'utf8'),
    splitBytes.subarray(0, splitAt),
  ]));

  const manager = new ChatLogManager() as any;
  manager._syncPaused = true;
  manager._syncPauseSequence = 1;
  manager._chatLogEncoding = 'utf8';
  const seedAmounts: number[] = [];
  const onSeed = (event: { amount: number }) => { seedAmounts.push(event.amount); };
  chatParser.on('SEED_GAINED', onSeed);
  try {
    const startOffset = Buffer.byteLength(ignoredPrefix, 'utf8');
    const result = manager.resumeAfterHistoricalSync({
      id: 1,
      filePath: catchUpPath,
      resumeOffset: startOffset,
      encoding: 'utf8',
    }, startOffset, 'utf8');
    assert.equal(result.startOffset, startOffset);
    assert.deepEqual(seedAmounts, [35_000_000],
      'snapshot 이후 완전한 로그 줄을 catch-up 순서로 처리하지 않았습니다.');

    fs.appendFileSync(catchUpPath, Buffer.concat([splitBytes.subarray(splitAt), Buffer.from('\n')]));
    const deadline = Date.now() + 3_000;
    while (seedAmounts.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(seedAmounts, [35_000_000, 12_000_000],
      '인계 EOF에서 잘린 UTF-8/HTML 줄이 다음 append와 결합되지 않았습니다.');
  } finally {
    chatParser.off('SEED_GAINED', onSeed);
    manager.stop();
  }
}

function checkNotificationKeywordBoundaries(): void {
  const {
    normalizeNotificationKeyword,
    normalizeNotificationKeywords,
  } = require(path.join(projectRoot, 'dist', 'shared', 'keywordSanitizer.js')) as {
    normalizeNotificationKeyword(value: unknown): string | null;
    normalizeNotificationKeywords(value: unknown): string[];
  };
  assert.deepEqual(
    normalizeNotificationKeywords(['', '   ', ' 보스 ', '보스', 123, 'Boss']),
    ['보스', 'Boss'],
  );
  assert.equal(normalizeNotificationKeyword('x'.repeat(101)), null);
  assert.equal(normalizeNotificationKeywords([]).length, 0);
  assert.equal(normalizeNotificationKeywords(Array.from({ length: 250 }, (_, index) => `키워드-${index}`)).length, 200);

  for (const file of [
    'src/modules/chatLogProcessor.ts',
    'src/modules/chatLogSyncManager.ts',
    'src/modules/tradeMonitor.ts',
    'src/modules/galleryMonitor.ts',
  ]) {
    assert.match(read(file), /normalizeNotificationKeyword/,
      `${file}이 소비 직전 키워드 정규화를 사용하지 않습니다.`);
  }
}

function checkTradeMonitorWindowReferenceContracts(): void {
  const tradeSource = read('src/modules/tradeMonitor.ts');
  assert.match(
    tradeSource,
    /export function updateWindows[\s\S]*?if \(sidebarWin\) sidebarWindowRef = sidebarWin;[\s\S]*?if \(tradeWin\) tradeWindowRef = tradeWin;/,
    '거래소 모니터가 null 갱신에서 기존 사이드바/거래소 창 참조를 보존하지 않습니다.',
  );
  assert.doesNotMatch(
    tradeSource,
    /export function updateWindows[\s\S]*?sidebarWindowRef = sidebarWin;\s*tradeWindowRef = tradeWin;/,
    '거래소 모니터가 설정 저장 또는 창 생성 시 기존 창 참조를 null로 지웁니다.',
  );

  const ipcSource = read('src/modules/ipcHandlers.ts');
  assert.match(
    ipcSource,
    /trade\.updateWindows\(null, null\)/,
    '설정 저장 경로의 거래소 모니터 갱신 계약이 바뀌었습니다.',
  );
  const windowManagerSource = read('src/modules/windowManager.ts');
  assert.match(
    windowManagerSource,
    /trade\.updateWindows\(null, win\)/,
    '거래소 창 생성 경로의 부분 갱신 계약이 바뀌었습니다.',
  );
}

function checkAutoStartRequestOrderingContracts(): void {
  const { AutoStartRequestTracker } = require(
    path.join(projectRoot, 'dist', 'modules', 'autoStart.js'),
  ) as {
    AutoStartRequestTracker: new () => {
      begin(enabled: boolean): number;
      isCurrent(generation: number, enabled: boolean): boolean;
      isDisabled(): boolean;
    };
  };
  const tracker = new AutoStartRequestTracker();
  const firstEnable = tracker.begin(true);
  const disable = tracker.begin(false);
  assert.equal(tracker.isCurrent(firstEnable, true), false,
    '늦게 끝난 자동 시작 켜기 요청이 현재 요청으로 남았습니다.');
  assert.equal(tracker.isCurrent(disable, false), true);
  assert.equal(tracker.isDisabled(), true);

  const secondEnable = tracker.begin(true);
  assert.equal(tracker.isCurrent(disable, false), false);
  assert.equal(tracker.isCurrent(secondEnable, true), true);
  assert.equal(tracker.isDisabled(), false);

  const source = read('src/modules/autoStart.ts');
  assert.match(source,
    /create_lnk-\$\{process\.pid\}-\$\{requestGeneration\}\.vbs/,
    '동시에 실행되는 자동 시작 바로가기 생성기가 요청별 임시 파일을 사용하지 않습니다.');
  assert.match(source,
    /autoStartRequests\.isCurrent\(requestGeneration, true\)[\s\S]*?openAtLogin: true/,
    '현재 자동 시작 켜기 요청만 레지스트리에 반영하는 세대 검사가 없습니다.');
  assert.match(source,
    /autoStartRequests\.isDisabled\(\)[\s\S]*?removeAutoStartFiles\(lnkPath, vbsPath\)/,
    '끄기 뒤 늦게 생성된 자동 시작 파일을 정리하지 않습니다.');
}

function checkLocalCalendarDateContracts(): void {
  const { formatLocalDateKey } = require(
    path.join(projectRoot, 'dist', 'shared', 'localDate.js'),
  ) as {
    formatLocalDateKey(now: {
      getFullYear(): number;
      getMonth(): number;
      getDate(): number;
    }): string;
  };
  const localAfterMidnight = {
    getFullYear: () => 2026,
    getMonth: () => 0,
    getDate: () => 2,
    toISOString: () => { throw new Error('로컬 날짜에 UTC 변환을 사용하면 안 됩니다.'); },
  };
  assert.equal(formatLocalDateKey(localAfterMidnight), '2026-01-02');

  const { isEtaCollectDateFresh } = require(
    path.join(projectRoot, 'dist', 'modules', 'etaCacheManager.js'),
  ) as {
    isEtaCollectDateFresh(collectDate: string | undefined, now: typeof localAfterMidnight): boolean;
  };
  assert.equal(isEtaCollectDateFresh('2026-01-02 00:10:00', localAfterMidnight), true);
  assert.equal(isEtaCollectDateFresh('2026-01-01 23:59:59', localAfterMidnight), false);
  assert.equal(isEtaCollectDateFresh(undefined, localAfterMidnight), false);

  const { ChatParser } = require(
    path.join(projectRoot, 'dist', 'modules', 'chatParser.js'),
  ) as { ChatParser: new (now: typeof localAfterMidnight) => any };
  const parser = new ChatParser(localAfterMidnight);
  let parsedDate = '';
  parser.once('SEED_GAINED', (event: { date: string }) => { parsedDate = event.date; });
  parser.parseLine('[ 0시 10분 00초] 콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.');
  assert.equal(parsedDate, '2026-01-02',
    '날짜 헤더가 없는 자정 직후 채팅이 이전 UTC 날짜로 기록됩니다.');

  for (const file of [
    'src/modules/chatParser.ts',
    'src/modules/chatLogManager.ts',
    'src/modules/diaryDb.ts',
    'src/modules/etaCacheManager.ts',
    'src/modules/contentsChecker.ts',
    'src/modules/todaySummary.ts',
    'src/preload.ts',
  ]) {
    assert.doesNotMatch(read(file), /toISOString\(\)\.(?:split\('T'\)|slice\(0, 10\))/,
      `${file}이 로컬 달력 날짜에 UTC 날짜를 사용합니다.`);
  }
}

function checkChatLogPathCandidateBoundaries(): void {
  const {
    buildChatLogPathCandidates,
    parseRegistryPathValue,
  } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogPathFinder.js')) as {
    buildChatLogPathCandidates(options?: {
      documentsPath?: string | null;
      homeDir?: string;
      env?: NodeJS.ProcessEnv;
    }): string[];
    parseRegistryPathValue(output: string, valueName: string, env?: NodeJS.ProcessEnv): string | null;
  };
  const env = {
    USERPROFILE: 'C:\\Users\\tester',
    OneDriveCommercial: 'D:\\CompanyDrive',
    OneDriveConsumer: 'E:\\PersonalDrive',
  };
  assert.equal(
    parseRegistryPathValue('    Personal    REG_EXPAND_SZ    %USERPROFILE%\\문서', 'Personal', env),
    path.normalize('C:\\Users\\tester\\문서'),
  );
  const candidates = buildChatLogPathCandidates({
    documentsPath: 'D:\\Redirected Documents',
    homeDir: 'C:\\Users\\tester',
    env,
  });
  assert.ok(candidates.includes(path.normalize('D:\\Redirected Documents\\Talesweaver\\ChatLog')));
  assert.ok(candidates.includes(path.normalize('D:\\CompanyDrive\\Documents\\Talesweaver\\ChatLog')));
  assert.ok(candidates.includes(path.normalize('E:\\PersonalDrive\\Documents\\Talesweaver\\ChatLog')));
  assert.equal(new Set(candidates.map(candidate => candidate.toLowerCase())).size, candidates.length);
}

async function checkChatLogWorkerReadRecovery(): Promise<void> {
  const {
    getChatLogReadRetryDelayMs,
    readChatLogFileWithRetry,
  } = require(path.join(projectRoot, 'dist', 'modules', 'chatLogFileRetry.js')) as {
    getChatLogReadRetryDelayMs(attempt: number): number;
    readChatLogFileWithRetry(
      filePath: string,
      readFile?: (target: string) => Promise<Buffer>,
      wait?: (delayMs: number) => Promise<void>,
    ): Promise<Buffer>;
  };
  const { inspectChatLogFileWithRetry, inspectChatLogFileAsyncWithRetry } = require(path.join(
    projectRoot,
    'dist',
    'modules',
    'chatLogSyncState.js',
  )) as {
    inspectChatLogFileWithRetry(
      filePath: string,
      dateStr: string,
      previous: unknown,
      inspect: () => {
        fingerprint: string;
        fingerprintBytes: number;
        snapshotSize: number;
        encoding: 'utf8' | 'euc-kr';
      },
      wait: (delayMs: number) => Promise<void>,
    ): Promise<{
      fingerprint: string;
      fingerprintBytes: number;
      snapshotSize: number;
      encoding: 'utf8' | 'euc-kr';
    }>;
    inspectChatLogFileAsyncWithRetry(
      filePath: string,
      dateStr: string,
      previous: unknown,
      inspect: () => Promise<{
        fingerprint: string;
        fingerprintBytes: number;
        snapshotSize: number;
        encoding: 'utf8' | 'euc-kr';
      }>,
      wait: (delayMs: number) => Promise<void>,
    ): Promise<{
      fingerprint: string;
      fingerprintBytes: number;
      snapshotSize: number;
      encoding: 'utf8' | 'euc-kr';
    }>;
  };
  assert.deepEqual([1, 2, 3, 4].map(getChatLogReadRetryDelayMs), [100, 200, 400, 800]);

  let attempts = 0;
  const delays: number[] = [];
  const recovered = await readChatLogFileWithRetry(
    'retry-fixture.html',
    async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error('locked') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return Buffer.from('recovered');
    },
    async delayMs => { delays.push(delayMs); },
  );
  assert.equal(recovered.toString(), 'recovered');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);

  let fatalAttempts = 0;
  await assert.rejects(() => readChatLogFileWithRetry(
    'fatal-fixture.html',
    async () => {
      fatalAttempts++;
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
    async () => undefined,
  ));
  assert.equal(fatalAttempts, 1);

  let inspectionAttempts = 0;
  const inspectionDelays: number[] = [];
  const inspection = await inspectChatLogFileWithRetry(
    'locked-inspection-fixture.html',
    '2026-08-26',
    undefined,
    () => {
      inspectionAttempts++;
      if (inspectionAttempts < 3) {
        const error = new Error('locked inspection') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return {
        fingerprint: 'recovered-inspection',
        fingerprintBytes: 32,
        snapshotSize: 64,
        encoding: 'utf8',
      };
    },
    async delayMs => { inspectionDelays.push(delayMs); },
  );
  assert.equal(inspection.fingerprint, 'recovered-inspection');
  assert.equal(inspectionAttempts, 3);
  assert.deepEqual(inspectionDelays, [100, 200]);

  let asyncInspectionAttempts = 0;
  const asyncInspectionDelays: number[] = [];
  const asyncInspection = await inspectChatLogFileAsyncWithRetry(
    'locked-async-inspection-fixture.html',
    '2026-08-26',
    undefined,
    async () => {
      asyncInspectionAttempts++;
      if (asyncInspectionAttempts < 3) {
        const error = new Error('locked async inspection') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return {
        fingerprint: 'async-recovered-inspection',
        fingerprintBytes: 32,
        snapshotSize: 64,
        encoding: 'utf8',
      };
    },
    async delayMs => { asyncInspectionDelays.push(delayMs); },
  );
  assert.equal(asyncInspection.fingerprint, 'async-recovered-inspection');
  assert.equal(asyncInspectionAttempts, 3);
  assert.deepEqual(asyncInspectionDelays, [100, 200]);

  const workerSource = read('src/modules/chatLogSyncWorker.ts');
  const managerSource = read('src/modules/chatLogSyncManager.ts');
  assert.match(workerSource, /failedFiles\.push\([\s\S]*?fileName: file\.fileName[\s\S]*?error: String\(error\)/);
  assert.match(managerSource, /preflightFailedFiles\.push\([\s\S]*?fileName: target\.fileName[\s\S]*?continue;/);
  assert.match(managerSource, /failedFiles = \[\.\.\.preflightFailedFiles, \.\.\.\(doneData\.failedFiles \|\| \[\]\)\]/);
  assert.match(managerSource, /partial = failedFiles\.length > 0/);
  assert.match(managerSource, /reanalyzeCompletedLogs \|\| target\.dateStr === todayStr/,
    '완료된 로그 재분석 옵션이 파일 전체 재구성 경로에 연결되지 않았습니다.');
  assert.match(managerSource, /mergeHomeworkCountFromSync\(hwId, detected\.count, MAIN_CHAR_ID\)/,
    '과거 로그 숙제가 메인 캐릭터에 명시적으로 반영되지 않습니다.');
  const settingsSource = read('src/settings.html');
  assert.match(settingsSource, /일부 복원 완료/);
  assert.match(settingsSource, /id="reanalyze-completed-chat-logs"/);
  assert.match(settingsSource, /과거 채팅 로그에는 수행 캐릭터 정보가 없으므로[\s\S]*?메인 캐릭터/);
}

async function checkChatLogWorkerBatchProtocol(): Promise<void> {
  const { Worker } = require('node:worker_threads') as typeof import('node:worker_threads');
  const iconv = require('iconv-lite') as typeof import('iconv-lite');
  const protocol = require(path.join(projectRoot, 'dist', 'modules', 'chatLogSyncProtocol.js')) as any;
  const stateModule = require(path.join(projectRoot, 'dist', 'modules', 'chatLogSyncState.js')) as any;
  const diaryDb = require(path.join(projectRoot, 'dist', 'modules', 'diaryDb.js')) as any;
  const { getHomeworkResetCycleKey } = require(path.join(projectRoot, 'dist', 'shared', 'homeworkResetCycle.js')) as any;
  const { getEssenceExchangeCount } = require(path.join(projectRoot, 'dist', 'shared', 'experienceEssence.js')) as any;
  const workerScript = path.join(projectRoot, 'dist', 'modules', 'chatLogSyncWorker.js');
  const fixtureDirectory = path.join(isolatedUserData, 'chat-sync-worker-fixtures');
  fs.mkdirSync(fixtureDirectory, { recursive: true });

  const runFixture = async (encoding: 'utf8' | 'euc-kr', holdFirstAck: boolean) => {
    const filePath = path.join(fixtureDirectory, `TWChatLog_2026_08_${encoding === 'utf8' ? '24' : '25'}.html`);
    const magicOne = '<font size="2" color="white"> [22시 39분 34초] </font> <font size="2" color="#ff64ff">하급 마정석 1개를 획득 하였습니다.</font></br>';
    const filler = Array.from({ length: 1_999 }, (_, index) => `ignored-${index}`);
    const magicTwo = '<font size="2" color="white"> [22시 40분 15초] </font><font>[하급 마정석] 2개를 획득하였습니다.</font></br>';
    const essenceDirect = '<font size="2" color="white"> [22시 41분 15초] </font><font>[경험의 정수] 아이템을 2개 획득하였습니다.</font></br>';
    const essenceXpDecrease = '<font size="2" color="white"> [22시 42분 15초] </font><font>경험치가 10000000000 감소했습니다.</font></br>';
    const essenceAutoExchange = '<font size="2" color="white"> [22시 42분 15초] </font><font>경험치 100억이 차감되고, 경험의 정수 1개를 획득 하였습니다.</font></br>';
    const eternalFloor = '<font size="2" color="white"> [17시 11분  8초] </font><font>[이터널 플로어 보상 상자] 아이템을 획득하였습니다.</font></br>';
    const etaDaily = '<font size="2" color="white"> [18시 11분  8초] </font><font>[루이나 및 제네로 일반 상자] 아이템을 습득했습니다.</font></br>';
    const longSeed = `<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">${'A'.repeat(270_000)} 콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.</font></br>`;
    const content = [
      magicOne,
      ...filler,
      magicTwo,
      essenceDirect,
      essenceXpDecrease,
      essenceAutoExchange,
      eternalFloor,
      etaDaily,
      longSeed,
    ].join('\n') + '\n';
    const encoded = encoding === 'utf8' ? Buffer.from(content, 'utf8') : iconv.encode(content, 'euc-kr');
    fs.writeFileSync(filePath, encoded);
    const fingerprint = crypto.createHash('sha256').update(encoded).digest('hex');
    const jobId = `regression-${encoding}-${crypto.randomUUID()}`;
    const policyFingerprint = 'regression-policy-v2';
    const batches: any[] = [];

    const worker = new Worker(workerScript, {
      workerData: {
        jobId,
        lootKeywords: ['하급 마정석'],
        homeworkCycleKeys: {
          'weekly-eternal-floor': {
            rule: { type: 'weekly', dayOfWeek: 1, hour: 0 },
            cycleKey: getHomeworkResetCycleKey({ type: 'weekly', dayOfWeek: 1, hour: 0 }, new Date(2026, 7, 25, 12).getTime()),
          },
          'daily-eta-quest': {
            rule: { type: 'daily', hour: 0 },
            cycleKey: getHomeworkResetCycleKey({ type: 'daily', hour: 0 }, new Date(2026, 7, 25, 12).getTime()),
          },
        },
        targetFiles: [{
          filePath,
          fileName: path.basename(filePath),
          dateStr: encoding === 'utf8' ? '2026-08-24' : '2026-08-25',
          fingerprint,
          policyFingerprint,
          fingerprintBytes: 4_096,
          startOffset: 0,
          snapshotSize: encoded.length,
          encoding,
          aggregate: protocol.createEmptyChatLogFileAggregate(),
        }],
      },
    });

    let firstBatchResolve!: () => void;
    const firstBatch = new Promise<void>(resolve => { firstBatchResolve = resolve; });
    let doneResolve!: () => void;
    let doneReject!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });
    worker.on('message', (message: any) => {
      if (message.type === 'batch') {
        batches.push(message.data);
        if (batches.length === 1) firstBatchResolve();
        if (!holdFirstAck || batches.length > 1) {
          worker.postMessage({
            type: 'batch-ack',
            jobId,
            batchId: message.data.batchId,
            success: true,
          });
        }
      } else if (message.type === 'done') {
        doneResolve();
      } else if (message.type === 'error') {
        doneReject(new Error(message.error));
      }
    });
    worker.on('error', doneReject);

    await firstBatch;
    if (holdFirstAck) {
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(batches.length, 1, '메인의 ACK 전에 워커가 다음 배치를 전송했습니다.');
      worker.postMessage({
        type: 'batch-ack',
        jobId,
        batchId: batches[0].batchId,
        success: true,
      });
    }
    await done;
    await worker.terminate();
    worker.removeAllListeners();

    assert.ok(batches.length >= 2, '2,000줄 경계에서 유한 배치가 분리되지 않았습니다.');
    assert.equal(batches[0].fileComplete, false);
    assert.equal(batches[0].loots.length, 0,
      '파일 완료 전 마정석 부분 합계가 DB 반영 배치에 포함되었습니다.');
    assert.equal(batches[0].aggregate.magicStones[encoding === 'utf8' ? '2026-08-24' : '2026-08-25'].하급.totalCount, 1);
    const finalBatch = batches.at(-1)!;
    assert.equal(finalBatch.fileComplete, true);
    assert.equal(finalBatch.confirmedOffset, encoded.length);
    assert.equal(finalBatch.loots.find((item: any) => item.diaryContent.includes('하급 마정석'))?.count, 3,
      '파일 완료 배치가 마정석의 파일 전체 합계를 전달하지 않았습니다.');
    assert.equal(finalBatch.seeds.length, 1,
      `${encoding} 다중 바이트 문자가 read chunk 경계에서 손상되었습니다.`);
    assert.equal(finalBatch.aggregate.seedsDetected, 1);
    assert.equal(finalBatch.essences.reduce((sum: number, item: any) => sum + item.count, 0), 3,
      '등록 아이템 목록에 없어도 직접 획득과 자동 전환 경험의 정수가 모두 복원되어야 합니다.');
    assert.equal(finalBatch.aggregate.essencesDetected, 3,
      '경험의 정수 과거 로그 집계가 실제 복원 건수와 다릅니다.');
    assert.deepEqual(finalBatch.aggregate.homework['weekly-eternal-floor'], { count: 1, isIncrement: true });
    if (encoding === 'utf8') {
      assert.equal(finalBatch.aggregate.homework['daily-eta-quest'], undefined,
        '이전 일일 리셋 주기의 숙제가 현재 체크리스트 집계에 포함되었습니다.');
    } else {
      assert.deepEqual(finalBatch.aggregate.homework['daily-eta-quest'], { count: 1, isIncrement: true },
        '현재 일일 리셋 주기의 숙제가 동기화 집계에서 누락되었습니다.');
    }
    assert.equal(
      Object.values(finalBatch.aggregate.homeworkByCycle as Record<string, Record<string, unknown>>)
        .some(items => !!items['daily-eta-quest']),
      true,
      '현재 체크리스트 주기 밖의 숙제 이벤트가 과거 모험일지 집계에서 사라졌습니다.',
    );

    const { ChatParser } = require(path.join(projectRoot, 'dist', 'modules', 'chatParser.js')) as any;
    const normalizer = require(path.join(projectRoot, 'dist', 'modules', 'chatLogNormalizer.js')) as any;
    const fullParser = new ChatParser();
    fullParser.setCurrentDate(encoding === 'utf8' ? '2026-08-24' : '2026-08-25');
    const golden = {
      magicEvents: 0,
      magicCount: 0,
      essenceCount: 0,
      seedEvents: 0,
      seedAmount: 0,
      eternalFloor: 0,
    };
    fullParser.on('MAGIC_STONE_GAIN', (event: any) => {
      golden.magicEvents++;
      golden.magicCount += event.count;
    });
    fullParser.on('ITEM_LOOTED', (event: any) => {
      if (event.isOwn && event.itemName === '경험의 정수') golden.essenceCount += event.count;
    });
    fullParser.on('XP_CHANGED', (event: any) => {
      golden.essenceCount += getEssenceExchangeCount(event.amount);
    });
    fullParser.on('SEED_GAINED', (event: any) => {
      golden.seedEvents++;
      golden.seedAmount += event.amount;
    });
    fullParser.on('ETERNAL_FLOOR_CLEAR', () => { golden.eternalFloor++; });
    const fullyDecoded = normalizer.decodeChatLogBuffer(encoded);
    normalizer.normalizeChatLogLines(fullyDecoded.content.split('\n')).forEach((line: string) => fullParser.parseLine(line));
    assert.deepEqual(
      {
        magicEvents: finalBatch.aggregate.lootsDetected,
        magicCount: finalBatch.loots.find((item: any) => item.diaryContent.includes('하급 마정석'))?.count,
        essenceCount: finalBatch.essences.reduce((sum: number, item: any) => sum + item.count, 0),
        seedEvents: finalBatch.aggregate.seedsDetected,
        seedAmount: finalBatch.seeds.reduce((sum: number, item: any) => sum + item.amount, 0),
        eternalFloor: finalBatch.aggregate.homework['weekly-eternal-floor']?.count || 0,
      },
      golden,
      `${encoding} 스트리밍 워커 결과가 기존 전파일 파싱 golden 결과와 다릅니다.`,
    );
    return { filePath, encoded, batches };
  };

  const utf8First = await runFixture('utf8', true);
  const utf8Replay = await runFixture('utf8', false);
  assert.equal(
    utf8First.batches.at(-1)!.seeds[0].eventId,
    utf8Replay.batches.at(-1)!.seeds[0].eventId,
    '같은 파일의 같은 byte offset 이벤트 ID가 재실행에서 달라졌습니다.',
  );
  await runFixture('euc-kr', false);

  const initialInspection = stateModule.inspectChatLogFile(utf8First.filePath, '2026-08-24');
  const durable = stateModule.createDurableFileState(
    utf8First.filePath,
    path.basename(utf8First.filePath),
    '2026-08-24',
    initialInspection.fingerprint,
    'regression-policy-v2',
    initialInspection.fingerprintBytes,
    initialInspection.snapshotSize,
  );
  durable.confirmedOffset = initialInspection.snapshotSize;
  const localState = { schemaVersion: 2, files: { [stateModule.getChatLogSyncStateKey(utf8First.filePath)]: durable } };
  stateModule.saveChatLogSyncStateAtPath(fixtureDirectory, localState);
  const reloaded = stateModule.loadChatLogSyncStateAtPath(fixtureDirectory);
  assert.equal(reloaded.files[stateModule.getChatLogSyncStateKey(utf8First.filePath)].confirmedOffset, initialInspection.snapshotSize);

  const manyFiles: Record<string, any> = {};
  for (let index = 0; index < 40; index++) {
    const cloned = { ...durable, filePath: `${utf8First.filePath}.${index}`, fileName: `fixture-${index}.html`, updatedAt: index + 1 };
    manyFiles[stateModule.getChatLogSyncStateKey(cloned.filePath)] = cloned;
  }
  stateModule.saveChatLogSyncStateAtPath(fixtureDirectory, { schemaVersion: 2, files: manyFiles });
  assert.equal(Object.keys(stateModule.loadChatLogSyncStateAtPath(fixtureDirectory).files).length, 40,
    '과거 로그 내구 상태가 기존 32개 제한으로 잘렸습니다.');

  fs.appendFileSync(utf8First.filePath, Buffer.from('append-only\n', 'utf8'));
  const appendInspection = stateModule.inspectChatLogFile(utf8First.filePath, '2026-08-24', durable);
  assert.equal(stateModule.canResumeChatLogFile(durable, appendInspection, '2026-08-24', 'regression-policy-v2'), true,
    '정상 append 뒤 확정 offset에서 재개하지 못합니다.');
  assert.equal(stateModule.canResumeChatLogFile(durable, appendInspection, '2026-08-24', 'changed-policy'), false,
    '득템/숙제 동기화 정책이 바뀌었는데 이전 offset을 재사용합니다.');
  fs.writeFileSync(utf8First.filePath, 'truncated\n', 'utf8');
  const truncateInspection = stateModule.inspectChatLogFile(utf8First.filePath, '2026-08-24', durable);
  assert.equal(stateModule.canResumeChatLogFile(durable, truncateInspection, '2026-08-24'), false,
    'truncate/replace된 파일에 이전 확정 offset을 재사용합니다.');

  const managerFixtureDirectory = path.join(fixtureDirectory, 'manager-integration');
  fs.mkdirSync(managerFixtureDirectory, { recursive: true });
  const managerFile = path.join(managerFixtureDirectory, 'TWChatLog_2026_08_26.html');
  const managerSeedMessage = '콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.';
  const managerLines = [
    '<font size="2" color="white"> [22시 39분 34초] </font> <font size="2" color="#ff64ff">하급 마정석 1개를 획득 하였습니다.</font></br>',
    '<font size="2" color="white"> [22시 39분 35초] </font> <font size="2" color="#c8ffc8">테스터 : 금화 주머니를 획득 했습니다.</font></br>',
    '<font size="2" color="white"> [22시 39분 35초] </font> <font size="2" color="#ff64ff">가짜 달여왕 군단의 군자금 [ 금화 주머니 80개 ]를 획득했습니다.</font></br>',
    ...Array.from({ length: 2_001 }, (_, index) => `manager-ignored-${index}`),
    '<font size="2" color="white"> [22시 41분 15초] </font><font>[경험의 정수] 아이템을 2개 획득하였습니다.</font></br>',
    '<font size="2" color="white"> [22시 42분 15초] </font><font>경험치가 10000000000 감소했습니다.</font></br>',
    '<font size="2" color="white"> [22시 42분 15초] </font><font>경험치 100억이 차감되고, 경험의 정수 1개를 획득 하였습니다.</font></br>',
    `<font size="2" color="white"> [ 0시 25분 25초] </font> <font size="2" color="#ff64ff">${managerSeedMessage}</font></br>`,
  ];
  fs.writeFileSync(managerFile, managerLines.join('\n') + '\n', 'utf8');
  const configModule = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as any;
  const syncManager = require(path.join(projectRoot, 'dist', 'modules', 'chatLogSyncManager.js')) as any;
  assert.equal(
    syncManager.getDiaryRetentionStartDate(180, new Date(2026, 7, 27)).getTime(),
    new Date(2026, 1, 28).getTime(),
    '과거 로그 기본 시작일이 모험일지 보관 기간과 일치하지 않습니다.',
  );
  const previousChatLogPath = configModule.load().chatLogPath;
  const previousLootKeywords = configModule.load().lootKeywords;
  const previousContentsCheckerItems = structuredClone(configModule.load().contentsCheckerItems || []);
  const previousCharacterPresets = structuredClone(configModule.load().characterPresets || []);
  const previousSelectedCharacterId = configModule.load().selectedCharacterId;
  try {
    configModule.saveImmediate({ chatLogPath: managerFixtureDirectory, lootKeywords: ['하급 마정석'] });
    const startDate = new Date(2026, 7, 26);
    const firstSyncPromise = syncManager.syncWeeklyChatLogs({ startDate, endDate: startDate });
    const duplicateSyncPromise = syncManager.syncWeeklyChatLogs({ startDate, endDate: startDate });
    assert.equal(duplicateSyncPromise, firstSyncPromise,
      '동시에 요청된 과거 로그 동기화가 single-flight로 합쳐지지 않았습니다.');
    const firstSync = await firstSyncPromise;
    assert.equal(firstSync.success, true);
    assert.equal(firstSync.totalFiles, 1);
    assert.equal(firstSync.seedsDetected, 3);
    assert.equal(firstSync.lootsDetected, 1);
    assert.equal(firstSync.essencesDetected, 3,
      '과거 동기화가 직접 획득 2개와 100억 교환 1개를 정확히 합산하지 못했습니다.');
    assert.equal(firstSync.seedsAdded, 2);
    assert.equal(firstSync.lootsAdded, 1);
    assert.equal(firstSync.essencesAdded, 3,
      '과거 동기화 결과가 실제 경험의 정수 수량이 아니라 로그 줄 수를 표시합니다.');
    const managerDiary = diaryDb.getDiaryByDate('2026-08-26');
    const managerEssenceTotal = managerDiary.activityLogs
      .filter((log: { type: string; content: string }) => (
        log.type === 'loot' && log.content === '[득템] 경험의 정수'
      ))
      .reduce((sum: number, log: { amount: number }) => sum + log.amount, 0);
    assert.equal(managerEssenceTotal, 3,
      '과거 동기화가 자동 교환 안내를 중복 집계하거나 직접 획득 수량을 누락했습니다.');
    const managerTodaySummary = require(path.join(projectRoot, 'dist', 'modules', 'todaySummary.js'))
      .buildTodaySummary(configModule.load(), managerDiary, '2026-08-26');
    assert.equal(managerTodaySummary.totalEssence, 3,
      '과거 동기화로 복원한 경험의 정수가 오늘 요약 전용 합계에 반영되지 않았습니다.');
    assert.equal(managerTodaySummary.lootItems.some(
      (item: { name: string }) => item.name === '경험의 정수'), false,
    '오늘 요약 전용 경험의 정수 합계가 일반 득템 목록에도 중복 표시됩니다.');
    const managerMonthlySummary = diaryDb.getMonthlySummary('2026-08', ['하급 마정석']);
    assert.equal(managerMonthlySummary.lootList.some(
      (log: { content: string }) => log.content === '[득템] 경험의 정수'), false,
    '과거 동기화된 경험의 정수가 이번 달 누적 득템 목록에 노출됩니다.');
    assert.equal(managerMonthlySummary.calendarLootList
      .filter((log: { content: string }) => log.content === '[득템] 경험의 정수')
      .reduce((sum: number, log: { amount: number }) => sum + log.amount, 0), 3,
    '일반 득템 목록에서 제외하면서 모험일지 달력의 경험의 정수 기록까지 사라졌습니다.');
    const managerGoldPouchRows = diaryDb.getDiaryByDate('2026-08-26').activityLogs
      .filter((log: { type: string; content: string }) => log.type === 'calc' && log.content === diaryDb.GOLD_POUCH_DAILY_CONTENT);
    assert.equal(managerGoldPouchRows.length, 1);
    assert.equal(managerGoldPouchRows[0].amount, 40_500_000,
      '주간 로그 동기화가 동일 시각 금화 주머니 획득을 날짜별 합계로 반영하지 못했습니다.');

    const resumedSync = await syncManager.syncWeeklyChatLogs({ startDate, endDate: startDate });
    assert.equal(resumedSync.success, true);
    assert.equal(resumedSync.totalLines, firstSync.totalLines);
    assert.equal(resumedSync.seedsAdded, 0, '확정 offset 재실행이 SEED를 중복 반영했습니다.');
    assert.equal(resumedSync.lootsAdded, 0, '확정 offset 재실행이 마정석 합계를 중복 증가시켰습니다.');
    assert.equal(resumedSync.essencesAdded, 0, '확정 offset 재실행이 경험의 정수를 중복 반영했습니다.');

    diaryDb.addActivityLogIfAbsent('2026-08-26', '07:59:00', 'loot', '[득템] [재분석 전 오래된 자동 기록]', 1, false);
    const preservedManualId = diaryDb.addManualActivityLog(
      '2026-08-26',
      '07:59:01',
      'loot',
      '[수동] 완료 파일 재분석 보존 기록',
      1,
    );
    const fullyReanalyzed = await syncManager.syncWeeklyChatLogs({
      startDate,
      endDate: startDate,
      reanalyzeCompletedLogs: true,
    });
    assert.equal(fullyReanalyzed.success, true);
    assert.equal(fullyReanalyzed.reanalyzedCompletedLogs, true);
    assert.equal(fullyReanalyzed.automaticRecordsRebuiltDates, 1,
      '완료된 과거 로그의 자동 기록이 날짜 단위로 재구성되지 않았습니다.');
    const rebuiltPastRows = diaryDb.getDiaryByDate('2026-08-26').activityLogs;
    assert.equal(rebuiltPastRows.some((row: { content: string }) => row.content === '[득템] [재분석 전 오래된 자동 기록]'), false,
      '완료 로그 재분석 뒤 이전 채팅 로그 기반 자동 기록이 남았습니다.');
    assert.equal(rebuiltPastRows.some((row: { id: number }) => row.id === preservedManualId), true,
      '완료 로그 재분석이 사용자의 수동 일지 기록을 삭제했습니다.');
    assert.equal(rebuiltPastRows
      .filter((row: { type: string; content: string }) => (
        row.type === 'loot' && row.content === '[득템] 경험의 정수'
      ))
      .reduce((sum: number, row: { amount: number }) => sum + row.amount, 0), 3,
    '완료 로그 전체 재분석이 경험의 정수를 중복하거나 누락했습니다.');
    const rebuiltGoldPouchRows = rebuiltPastRows
      .filter((log: { type: string; content: string }) => log.type === 'calc' && log.content === diaryDb.GOLD_POUCH_DAILY_CONTENT);
    assert.equal(rebuiltGoldPouchRows.length, 1);
    assert.equal(rebuiltGoldPouchRows[0].amount, 40_500_000,
      '완료 로그 전체 재분석이 금화 주머니 자동 기록을 중복 누적했습니다.');

    const persistedManagerState = stateModule.loadChatLogSyncStateAtPath(isolatedUserData);
    const managerState = persistedManagerState.files[stateModule.getChatLogSyncStateKey(managerFile)];
    assert.equal(managerState.confirmedOffset, fs.statSync(managerFile).size,
      '메인 ACK 뒤 snapshot 확정 offset이 내구 상태에 저장되지 않았습니다.');

    // 현재 주기와 무관한 지난주·지지난주 숙제 완료도 실제 수행 날짜의 모험일지에 복원한다.
    const historicalMainName = '과거 메인';
    const historicalItems = structuredClone(configModule.load().contentsCheckerItems || []);
    const eternalFloorItem = historicalItems.find((item: { id: string }) => item.id === 'weekly-eternal-floor');
    assert.ok(eternalFloorItem, '과거 주간 숙제 회귀 검사용 이터널 플로어 정의가 없습니다.');
    configModule.saveImmediate({
      contentsCheckerItems: historicalItems,
      characterPresets: [{ id: 'char-main', name: historicalMainName }],
      selectedCharacterId: 'char-main',
    });
    const historicalDates = ['2026-08-12', '2026-08-19'];
    for (const historicalDate of historicalDates) {
      const fileNameDate = historicalDate.replace(/-/g, '_');
      const historicalFile = path.join(managerFixtureDirectory, `TWChatLog_${fileNameDate}.html`);
      const completionLines = Array.from({ length: 10 }, (_, index) => (
        `<font size="2" color="white"> [17시 11분 ${String(index).padStart(2, '0')}초] </font>`
        + '<font>[이터널 플로어 보상 상자] 아이템을 획득하였습니다.</font></br>'
      ));
      fs.writeFileSync(historicalFile, `${completionLines.join('\n')}\n`, 'utf8');
    }
    const historicalStart = new Date(2026, 7, 12);
    const historicalEnd = new Date(2026, 7, 19);
    const historicalSync = await syncManager.syncWeeklyChatLogs({
      startDate: historicalStart,
      endDate: historicalEnd,
    });
    assert.equal(historicalSync.success, true);
    assert.equal(historicalSync.homeworkLogsDetected, 2,
      '지난주·지지난주 숙제 완료가 동기화 결과의 숙제 일지 건수에 표시되지 않았습니다.');
    for (const historicalDate of historicalDates) {
      const historicalHomework = diaryDb.getDiaryByDate(historicalDate).homeworkLogs
        .find((row: { content_id: string }) => row.content_id === 'weekly-eternal-floor_char-main');
      assert.ok(historicalHomework, `${historicalDate}의 과거 주간 숙제가 모험일지에 복원되지 않았습니다.`);
      assert.equal(historicalHomework.content_name, `[${historicalMainName}] ${eternalFloorItem.name}`);
      assert.equal(historicalHomework.source, 'chat-log-sync');
    }
    const historicalMonthRows = diaryDb.getDiariesByMonth('2026-08', 69);
    for (const historicalDate of historicalDates) {
      const historicalDiary = historicalMonthRows.find((row: { date: string }) => row.date === historicalDate);
      assert.equal(historicalDiary?.weekly_done, 1,
        `${historicalDate}가 포함된 주의 과거 숙제 완료 수가 달력 요약에 반영되지 않았습니다.`);
      assert.equal(historicalDiary?.weekly_total, 69,
        '과거 주간 숙제 전체 수가 현재 체크리스트 기준으로 보완되지 않았습니다.');
    }

    const preservedHistoricalCompletedAt = new Date(2026, 7, 12, 21, 30).getTime();
    assert.equal(diaryDb.addHomeworkLog(
      historicalDates[0],
      'weekly-eternal-floor_char-main',
      `[${historicalMainName}] ${eternalFloorItem.name}`,
      eternalFloorItem.category,
      'weekly',
      preservedHistoricalCompletedAt,
    ), true);
    const historicalRebuild = await syncManager.syncWeeklyChatLogs({
      startDate: historicalStart,
      endDate: historicalEnd,
      reanalyzeCompletedLogs: true,
    });
    assert.equal(historicalRebuild.success, true);
    const preservedHistoricalHomework = diaryDb.getDiaryByDate(historicalDates[0]).homeworkLogs
      .find((row: { content_id: string }) => row.content_id === 'weekly-eternal-floor_char-main');
    assert.equal(preservedHistoricalHomework?.source, 'checklist',
      '완료 로그 재분석이 사용자의 기존 체크리스트 숙제 이력을 자동 기록으로 덮어썼습니다.');
    assert.equal(preservedHistoricalHomework?.completed_at, preservedHistoricalCompletedAt,
      '완료 로그 재분석이 사용자의 기존 숙제 완료 시각을 덮어썼습니다.');
    assert.equal(
      diaryDb.getDiaryByDate(historicalDates[1]).homeworkLogs
        .filter((row: { content_id: string }) => row.content_id === 'weekly-eternal-floor_char-main').length,
      1,
      '지난주 숙제 전체 재분석이 동일한 모험일지 이력을 중복 생성했습니다.',
    );

    const now = new Date();
    const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayFile = path.join(
      managerFixtureDirectory,
      `TWChatLog_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}.html`,
    );
    const todayLines = [
      '<font size="2" color="white"> [10시 00분 00초] </font><font>[루이나 및 제네로 일반 상자] 아이템을 습득했습니다.</font></br>',
      '<font size="2" color="white"> [10시 00분 01초] </font><font>하급 마정석 2개를 획득 하였습니다.</font></br>',
      ...Array.from({ length: 2_050 }, (_, index) => `today-ignored-${index}`),
      '<font size="2" color="white"> [10시 00분 02초] </font><font>콘텐츠 클리어 보상으로 3500만 SEED를 획득했습니다.</font></br>',
    ];
    fs.writeFileSync(todayFile, `${todayLines.join('\n')}\n`, 'utf8');
    diaryDb.addActivityLogIfAbsent(todayDate, '08:00:00', 'loot', '[득템] [교체 전 자동 기록]', 1, false);
    const manualTodayId = diaryDb.addManualActivityLog(todayDate, '08:01:00', 'loot', '[수동] 보존 기록', 1);
    diaryDb.addActivityLog(todayDate, '08:02:00', 'calc', '[계산기] 보존 기록', 100);

    const mainCharacterId = 'char-main';
    const alternateCharacterId = 'char-regression-alt';
    const mainCharacterItems = structuredClone(configModule.load().contentsCheckerItems || []);
    const etaDailyItem = mainCharacterItems.find((item: { id: string }) => item.id === 'daily-eta-quest');
    assert.ok(etaDailyItem, '메인 캐릭터 과거 숙제 반영 검사용 에타 숙제가 없습니다.');
    etaDailyItem.completedState = etaDailyItem.completedState || {};
    etaDailyItem.completedState[mainCharacterId] = { isCompleted: false, currentCount: 0 };
    etaDailyItem.completedState[alternateCharacterId] = { isCompleted: false, currentCount: 0 };
    configModule.saveImmediate({
      contentsCheckerItems: mainCharacterItems,
      // 배열 첫 항목과 현재 선택을 모두 보조 캐릭터로 두어도 과거 숙제는 char-main이어야 한다.
      characterPresets: [
        { id: alternateCharacterId, name: '회귀 보조' },
        { id: mainCharacterId, name: '메인 캐릭터' },
      ],
      selectedCharacterId: alternateCharacterId,
    });

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const rebuiltToday = await syncManager.syncWeeklyChatLogs({ startDate: todayStart, endDate: todayStart });
    assert.equal(rebuiltToday.success, true);
    assert.equal(rebuiltToday.todayRebuilt, true, '변경 없는 오늘 snapshot을 정확히 재구성하지 않았습니다.');
    assert.equal(rebuiltToday.homeworkDetected >= 1, true, '현재 일일 주기의 숙제가 과거 로그 복원에서 누락되었습니다.');
    const rebuiltEtaItem = configModule.load().contentsCheckerItems
      .find((item: { id: string }) => item.id === 'daily-eta-quest');
    assert.equal(rebuiltEtaItem.completedState[mainCharacterId].isCompleted, true,
      '과거 로그 숙제가 메인 캐릭터에 반영되지 않았습니다.');
    assert.equal(rebuiltEtaItem.completedState[alternateCharacterId].isCompleted, false,
      '과거 로그 숙제가 선택 중이거나 배열 첫 번째인 보조 캐릭터에 잘못 반영되었습니다.');
    let todayRows = diaryDb.getDiaryByDate(todayDate).activityLogs;
    assert.equal(todayRows.some((row: { content: string }) => row.content === '[득템] [교체 전 자동 기록]'), false,
      '오늘의 이전 자동 채팅 로그 기록이 재구성 뒤 남았습니다.');
    assert.equal(todayRows.some((row: { id: number }) => row.id === manualTodayId), true,
      '오늘 자동 기록 재구성이 사용자의 수동 기록을 삭제했습니다.');
    assert.equal(todayRows.some((row: { content: string }) => row.content === '[계산기] 보존 기록'), true,
      '오늘 자동 기록 재구성이 채팅 로그와 무관한 자동 계산 기록을 삭제했습니다.');

    diaryDb.addActivityLogIfAbsent(todayDate, '08:03:00', 'loot', '[득템] [동시 기록 보존]', 1, false);
    const { chatLogManager: liveChatLogManager } = require(
      path.join(projectRoot, 'dist', 'modules', 'chatLogManager.js'),
    ) as any;
    const { chatLogProcessor: liveChatLogProcessor } = require(
      path.join(projectRoot, 'dist', 'modules', 'chatLogProcessor.js'),
    ) as any;
    liveChatLogProcessor.start();
    liveChatLogManager.start();
    let appendedDuringAnalysis = false;
    try {
      const caughtUpToday = await syncManager.syncWeeklyChatLogs({
        startDate: todayStart,
        endDate: todayStart,
        onProgress: (info: { phase?: string }) => {
          if (appendedDuringAnalysis || info.phase !== 'analyzing') return;
          appendedDuringAnalysis = true;
          fs.appendFileSync(
            todayFile,
            '<font size="2" color="white"> [10시 00분 03초] </font><font size="2" color="#ff64ff">콘텐츠 클리어 보상으로 777만 SEED를 획득했습니다.</font></br>\n',
            'utf8',
          );
        },
      });
      assert.equal(appendedDuringAnalysis, true, '오늘 로그 분석 중 append 회귀 조건이 실행되지 않았습니다.');
      assert.equal(caughtUpToday.todayRebuildDeferred, false,
        '실시간 감시가 대기 중인데도 증가한 오늘 로그의 전체 교체가 보류되었습니다.');
      assert.equal(caughtUpToday.todayCatchUpProcessed, true,
        '오늘 snapshot 이후에 추가된 로그를 실시간 경로로 따라잡지 않았습니다.');
      assert.equal(caughtUpToday.todayCatchUpBytes > 0, true,
        '오늘 로그 catch-up byte 범위가 결과에 기록되지 않았습니다.');
      todayRows = diaryDb.getDiaryByDate(todayDate).activityLogs;
      assert.equal(todayRows.some((row: { content: string }) => row.content === '[득템] [동시 기록 보존]'), false,
        '오늘 전체 재분석이 이전 자동 기록을 새 snapshot으로 교체하지 않았습니다.');
      assert.equal(todayRows.some((row: { content: string; amount: number }) => (
        row.content.includes('777만 SEED') && row.amount === 7_770_000
      )), true, '동기화 중 append된 SEED 로그가 catch-up에서 누락되었습니다.');
    } finally {
      liveChatLogManager.stop();
    }

    for (const row of todayRows) diaryDb.removeActivityLog(todayDate, row.type, row.content);
  } finally {
    diaryDb.removeActivityLog('2026-08-26', 'calc', diaryDb.GOLD_POUCH_DAILY_CONTENT);
    configModule.saveImmediate({
      chatLogPath: previousChatLogPath,
      lootKeywords: previousLootKeywords,
      contentsCheckerItems: previousContentsCheckerItems,
      characterPresets: previousCharacterPresets,
      selectedCharacterId: previousSelectedCharacterId,
    });
  }

  const eventDate = '2099-12-31';
  const eventId = protocol.createStableChatSyncEventId('regression-file', 123, 'loot', 0);
  const firstCommit = diaryDb.batchInsertSyncResults({
    loots: [{ eventId, date: eventDate, timeOnly: '12:00:00', diaryContent: '[득템] 안정 ID A', count: 1 }],
    essences: [], seeds: [], elsoPoints: [], shouts: [],
  });
  const replayCommit = diaryDb.batchInsertSyncResults({
    loots: [{ eventId, date: eventDate, timeOnly: '12:00:01', diaryContent: '[득템] 안정 ID B', count: 1 }],
    essences: [], seeds: [], elsoPoints: [], shouts: [],
  });
  assert.equal(firstCommit.lootsAdded, 1);
  assert.equal(replayCommit.lootsAdded, 0, '동일 event ID 재전송이 DB에 중복 반영되었습니다.');
  assert.equal(diaryDb.hasActivityLog(eventDate, '12:00:01', '[득템] 안정 ID B'), false);
  diaryDb.removeActivityLog(eventDate, 'loot', '[득템] 안정 ID A');

  const shoutReplaceDate = '2099-12-30';
  const shoutReplaceStart = Math.floor(new Date(2099, 11, 30, 0, 0, 0, 0).getTime() / 1000);
  diaryDb.addShoutLogWithTimestampIfAbsent(shoutReplaceStart + 10, '이전발신자', '재분석 전 외치기');
  const shoutReplace = diaryDb.batchInsertSyncResults({
    loots: [], essences: [], seeds: [], elsoPoints: [],
    shouts: [{ fullTimestamp: shoutReplaceStart + 20, sender: '새발신자', message: '재분석 후 외치기' }],
    replaceAutomaticDate: shoutReplaceDate,
  });
  assert.equal(shoutReplace.success, true);
  const rebuiltShouts = diaryDb.getShoutHistory(24 * 365 * 100);
  assert.equal(rebuiltShouts.some((row: { sender: string; message: string }) => (
    row.sender === '이전발신자' && row.message === '재분석 전 외치기'
  )), false, '완료 로그 재분석 뒤 같은 날짜의 이전 외치기 기록이 남았습니다.');
  assert.equal(rebuiltShouts.some((row: { sender: string; message: string }) => (
    row.sender === '새발신자' && row.message === '재분석 후 외치기'
  )), true, '완료 로그 재분석 결과의 외치기가 저장되지 않았습니다.');
}

function checkSponsorFeatureRemoval(): void {
  const sponsorPattern = /후원|fairy\.hada\.io|sponsor-btn|openSponsor/i;
  for (const file of ['src/index.html', 'src/dock.html', 'src/settings.html', 'docs/index.md']) {
    assert.doesNotMatch(read(file), sponsorPattern, `후원 기능 또는 링크가 다시 추가되었습니다: ${file}`);
  }
}

async function runRegressionChecks(): Promise<void> {
  checkSponsorFeatureRemoval();
  checkDiscordNotifierContracts();
  checkBossNotifierContracts();
  checkBackendServiceContracts();
  checkIpcChannelContracts();
  checkRendererBundleCleanliness();
  checkCorruptedConfigResilience();
  checkShoutSuffixStripping();
  checkMandatoryUpdateLogic();
  checkStoreUpdateLogic();
  checkCustomTabHistoryContracts();
  checkLargeChatLogReadBoundary();
  await checkChatTailRecoveryBoundary();
  checkNotificationKeywordBoundaries();
  checkTradeMonitorWindowReferenceContracts();
  checkAutoStartRequestOrderingContracts();
  checkLocalCalendarDateContracts();
  checkChatLogPathCandidateBoundaries();
  checkPendingHomeworkOrdering();
  checkLegacyHomeworkMergeContracts();
  checkHomeworkSourceEventIdContracts();
  checkContentsVisibilityContracts();
  checkContentsInitializationContracts();
  checkManualEvidenceCollector();
  checkManualEvidenceComparator();
  checkShutdownRecoveryAcrossProcessRestarts();
  checkMainQuitRecoveryScenarios();
  checkMainResponseLossRestartReconciliation();
  checkMainPartialRestoreConfirmationGate();
  checkXpExchangeContracts();
  checkAbandonedFeeMatchingContracts();
  checkDigsiteBoardContracts();
  checkMissedCustomAlertContracts();
  checkMissedBossAlertContracts();
  checkViewRequestGenerationContracts();
  await checkMissedMinuteSchedulerContracts();
  await checkAudioPlaybackContracts();
  await checkMainConcurrentCrossUploadConvergence();
  await checkChatLogWorkerReadRecovery();
  await checkChatSearchSizeBoundaries();
  await checkChatLogWorkerBatchProtocol();
  await checkGoogleSyncDataContracts();
}

void runRegressionChecks().then(() => {
  console.log('Refactor regression checks passed.');
  finishRegressionChecks(0);
}).catch(error => {
  console.error(error);
  finishRegressionChecks(1);
});

