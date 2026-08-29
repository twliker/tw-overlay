import assert = require('node:assert/strict');
import { spawnSync } from 'node:child_process';
import fs = require('node:fs');
import path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const helperProject = path.join(projectRoot, 'native', 'store-update-helper', 'TWOverlay.StoreUpdateHelper.csproj');
const outputDirectory = path.join(projectRoot, 'dist', 'store-update-helper');
const helperExecutable = path.join(outputDirectory, 'TWOverlay.StoreUpdateHelper.exe');

function main(): void {
  assert.equal(process.platform, 'win32', 'Microsoft Store 업데이트 도우미는 Windows에서만 빌드할 수 있습니다.');
  assert.ok(fs.existsSync(helperProject), `Store 업데이트 도우미 프로젝트가 없습니다: ${helperProject}`);

  // npm run build가 만든 dist 안의 전용 하위 폴더만 교체한다. 다른 앱 리소스는 건드리지 않는다.
  const resolvedOutput = path.resolve(outputDirectory);
  assert.equal(path.dirname(resolvedOutput), path.join(projectRoot, 'dist'));
  assert.equal(path.basename(resolvedOutput), 'store-update-helper');
  fs.rmSync(resolvedOutput, { recursive: true, force: true });
  fs.mkdirSync(resolvedOutput, { recursive: true });

  const publish = spawnSync('dotnet', [
    'publish', helperProject,
    '--configuration', 'Release',
    '--output', resolvedOutput,
    '--nologo',
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  assert.equal(publish.status, 0, `Store 업데이트 도우미 빌드가 실패했습니다: ${publish.error?.message || publish.status}`);
  assert.ok(fs.existsSync(helperExecutable), 'Store 업데이트 도우미 실행 파일이 생성되지 않았습니다.');

  const selfTest = spawnSync(helperExecutable, ['self-test'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(selfTest.status, 0, `Store 업데이트 도우미 self-test가 실패했습니다: ${selfTest.stderr}`);
  const result = JSON.parse(selfTest.stdout.trim()) as { type?: string; protocolVersion?: number };
  assert.deepEqual(
    { type: result.type, protocolVersion: result.protocolVersion },
    { type: 'self-test', protocolVersion: 1 },
    'Store 업데이트 도우미 프로토콜 버전이 앱과 다릅니다.',
  );

  process.stdout.write(`${JSON.stringify({
    passed: true,
    executable: helperExecutable,
    bytes: fs.statSync(helperExecutable).size,
    protocolVersion: result.protocolVersion,
  }, null, 2)}\n`);
}

main();

