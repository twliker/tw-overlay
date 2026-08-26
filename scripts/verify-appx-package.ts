import assert = require('node:assert/strict');
import crypto = require('node:crypto');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import AdmZip = require('adm-zip');

const asar = require('@electron/asar') as {
  extractFile(archivePath: string, fileName: string): Buffer;
};

interface PackageMetadata {
  version: string;
  main: string;
  build: {
    productName: string;
    directories?: { output?: string };
    appx: {
      applicationId: string;
      identityName: string;
      publisher: string;
      publisherDisplayName: string;
      displayName: string;
      minVersion: string;
      maxVersionTested?: string;
    };
  };
}

const projectRoot = path.resolve(__dirname, '..');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as PackageMetadata;

const expectedAssets = new Map<string, string>([
  ['StoreLogo.png', '74e22227a1aa69d90dad76fa25624dff450891c0572957344cc9baaa78f44f43'],
  ['Square44x44Logo.png', '0b4ead6e1c757fcb5d24e56de2dde5a936a0f8f01d15e5af843fc48cf80b3649'],
  ['Square150x150Logo.png', '0db92596324033e4b1d788380e80b98360d7d2551e62fbe735cbd0cfc7ef457b'],
  ['Wide310x150Logo.png', '97131c22282b57a887e21ec989e91e08a3a4ad5a720f9492efe5a8dbf4f02f67'],
]);

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function normalizeEntryName(entryName: string): string {
  return entryName.replace(/\\/g, '/').toLowerCase();
}

function resolveArtifactPath(): string {
  if (process.argv[2]) return path.resolve(process.cwd(), process.argv[2]);
  const outputDirectory = packageMetadata.build.directories?.output || 'dist_electron';
  return path.join(
    projectRoot,
    outputDirectory,
    `${packageMetadata.build.productName}-${packageMetadata.version}.appx`
  );
}

function requireEntry(entries: Map<string, AdmZip.IZipEntry>, entryName: string): AdmZip.IZipEntry {
  const entry = entries.get(normalizeEntryName(entryName));
  assert.ok(entry, `AppX 내부 파일이 누락되었습니다: ${entryName}`);
  return entry;
}

function assertManifestValue(manifest: string, pattern: RegExp, message: string): void {
  assert.match(manifest, pattern, message);
}

function extractAsarFile(archivePath: string, fileName: string): Buffer {
  try {
    return asar.extractFile(archivePath, fileName);
  } catch (error) {
    if (!fileName.includes('/')) throw error;
    return asar.extractFile(archivePath, fileName.replace(/\//g, '\\'));
  }
}

function verifyManifest(manifest: string): void {
  const appx = packageMetadata.build.appx;
  const windowsVersion = `${packageMetadata.version.split('-')[0]}.0`;

  assertManifestValue(manifest, new RegExp(`<Identity\\s[^>]*Name=["']${appx.identityName.replace('.', '\\.')}["']`, 'i'),
    'AppX Identity Name이 package.json과 다릅니다.');
  assertManifestValue(manifest, new RegExp(`Publisher=["']${appx.publisher.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}["']`, 'i'),
    'AppX Publisher가 package.json과 다릅니다.');
  assertManifestValue(manifest, new RegExp(`Version=["']${windowsVersion.replace(/\\./g, '\\.')}["']`, 'i'),
    'AppX 버전이 package.json 버전과 다릅니다.');
  assertManifestValue(manifest, new RegExp(`<Application\\s[^>]*Id=["']${appx.applicationId}["'][^>]*Executable=["']app\\\\${packageMetadata.build.productName}\\.exe["']`, 'i'),
    'AppX 실행 진입점이 올바르지 않습니다.');
  assertManifestValue(manifest, /<rescap:Capability\s+Name=["']runFullTrust["']\s*\/>/i,
    'AppX runFullTrust capability가 누락되었습니다.');
  assertManifestValue(manifest, /<rescap:Capability\s+Name=["']allowElevation["']\s*\/>/i,
    '관리자 권한 실행에 필요한 AppX allowElevation capability가 누락되었습니다.');
  assertManifestValue(manifest, new RegExp(`MinVersion=["']${appx.minVersion.replace(/\\./g, '\\.')}["']`, 'i'),
    'AppX 최소 Windows 버전이 package.json과 다릅니다.');
  if (appx.maxVersionTested) {
    assertManifestValue(manifest, new RegExp(`MaxVersionTested=["']${appx.maxVersionTested.replace(/\\./g, '\\.')}["']`, 'i'),
      'AppX MaxVersionTested가 package.json과 다릅니다.');
  }

  for (const fileName of expectedAssets.keys()) {
    assert.ok(manifest.toLowerCase().includes(`assets\\${fileName}`.toLowerCase()),
      `AppX manifest가 ${fileName}을 참조하지 않습니다.`);
  }
}

function verifyPackagedApplication(entries: Map<string, AdmZip.IZipEntry>): void {
  requireEntry(entries, `app/${packageMetadata.build.productName}.exe`);
  const asarEntry = requireEntry(entries, 'app/resources/app.asar');
  const entryNames = [...entries.keys()];
  assert.ok(entryNames.some(name => /app\/resources\/app\.asar\.unpacked\/node_modules\/(?:%40|@)koromix\/koffi-win32-x64\/win32_x64\/koffi\.node$/i.test(name)),
    'AppX에 Windows x64 Koffi 네이티브 모듈이 없습니다.');
  assert.ok(entryNames.some(name => /app\/resources\/app\.asar\.unpacked\/node_modules\/better-sqlite3\/prebuilds\/win32-x64\.node$/i.test(name)),
    'AppX에 Windows x64 better-sqlite3 네이티브 모듈이 없습니다.');

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-overlay-appx-verify-'));
  const asarPath = path.join(temporaryDirectory, 'app.asar');
  try {
    fs.writeFileSync(asarPath, asarEntry.getData());
    const embeddedPackage = JSON.parse(extractAsarFile(asarPath, 'package.json').toString('utf8')) as {
      version?: string;
      main?: string;
    };
    assert.equal(embeddedPackage.version, packageMetadata.version, 'AppX 내부 앱 버전이 package.json과 다릅니다.');
    assert.equal(embeddedPackage.main, packageMetadata.main, 'AppX 내부 main 진입점이 package.json과 다릅니다.');
    assert.ok(extractAsarFile(asarPath, packageMetadata.main).length > 0, 'AppX 내부 main 스크립트가 비어 있습니다.');

    const updaterSource = extractAsarFile(asarPath, 'dist/modules/updater.js').toString('utf8');
    assert.match(updaterSource, /process\.windowsStore/,
      'AppX 실행 시 GitHub 자동 업데이트를 차단하는 Windows Store 분기가 누락되었습니다.');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main(): void {
  const artifactPath = resolveArtifactPath();
  assert.ok(fs.existsSync(artifactPath), `검증할 AppX 파일이 없습니다: ${artifactPath}`);
  const zip = new AdmZip(artifactPath);
  const entries = new Map(zip.getEntries().map(entry => [normalizeEntryName(entry.entryName), entry]));
  const manifest = requireEntry(entries, 'AppxManifest.xml').getData().toString('utf8');
  verifyManifest(manifest);

  for (const [fileName, expectedHash] of expectedAssets) {
    const sourcePath = path.join(projectRoot, 'build', 'appx', fileName);
    assert.ok(fs.existsSync(sourcePath), `Store 원본 이미지가 누락되었습니다: ${fileName}`);
    const sourceHash = sha256(fs.readFileSync(sourcePath));
    assert.equal(sourceHash, expectedHash, `${fileName}이 승인된 TW-Overlay Store 이미지와 다릅니다.`);
    const packagedHash = sha256(requireEntry(entries, `assets/${fileName}`).getData());
    assert.equal(packagedHash, sourceHash, `AppX의 ${fileName}이 저장소 원본과 다릅니다.`);
  }

  verifyPackagedApplication(entries);
  process.stdout.write(`${JSON.stringify({
    passed: true,
    artifact: artifactPath,
    sha256: sha256(fs.readFileSync(artifactPath)),
    identity: packageMetadata.build.appx.identityName,
    version: packageMetadata.version,
    capabilities: ['runFullTrust', 'allowElevation'],
    verifiedAssets: [...expectedAssets.keys()],
    verifiedNativeModules: ['koffi-win32-x64', 'better-sqlite3-win32-x64'],
  }, null, 2)}\n`);
}

main();
