import fs = require('fs');
import path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');

/** 폴더가 없으면 생성 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 파일 복사 (와일드카드 지원 x, 직접 리스트업) */
function copyFile(src: string, dest: string): void {
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  } catch (err) {
    console.error(`Error copying ${src} to ${dest}:`, err);
  }
}

/** 디렉토리 전체 복사 (.bak 파일 제외) */
function copyDir(src: string, dest: string): void {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    // .bak 파일은 빌드 결과물에서 제외
    if (
      entry.name.endsWith('.bak')
      || entry.name.endsWith('.ts')
      || entry.name.endsWith('.d.ts')
    ) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

/** 특정 폴더만 청소 */
function cleanDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ensureDir(dir);
}

// 1. 이전 빌드 산출물이 남지 않도록 dist 전체를 초기화
if (path.dirname(distDir) !== projectRoot || path.basename(distDir) !== 'dist') {
  throw new Error(`Unexpected build output path: ${distDir}`);
}
cleanDir(distDir);

// 2. 개별 리소스 복사 (.html, .css)
const files = fs.readdirSync(srcDir);
files.forEach(file => {
  if (file.endsWith('.html') || file.endsWith('.css') || file === 'env.json') {
    copyFile(path.join(srcDir, file), path.join(distDir, file));
  }
});

// 3. 디렉토리 복사 (아이콘, 정적 자산, 브라우저 렌더러 모듈)
const dirsToCopy = ['icons', 'assets', 'renderer'];
dirsToCopy.forEach(dir => {
  const s = path.join(srcDir, dir);
  const d = path.join(distDir, dir);
  if (fs.existsSync(s)) {
    cleanDir(d); // 복사 전 대상 폴더 청소
    copyDir(s, d);
  }
});

console.log('✅ Resources copied to dist/ successfully.');
