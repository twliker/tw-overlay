/** 빌드 의존성 보안 패치의 실제 소비 API와 배포 파일 선택을 검사한다.
 * minimatch 9/10만 11로 이전하며 함수 API를 쓰는 3/5 계열은 유지한다.
 * --archive는 설치 없이 생성한 app.asar의 최신 파일/도구 제외 여부도 확인한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import path = require('node:path');
import {createRequire} from 'node:module';
import {FileMatcher} from 'app-builder-lib/out/fileMatcher';

const root=path.resolve(__dirname,'..'),config=require(path.join(root,'package.json'));
const builderRequire=createRequire(require.resolve('app-builder-lib'));
const universalRequire=createRequire(builderRequire.resolve('@electron/universal'));
for(const consumer of [builderRequire,universalRequire]) {
  assert.ok(Number(consumer('minimatch/package.json').version.split('.')[0])>=11);
  const {minimatch,Minimatch}=consumer('minimatch');
  assert.equal(minimatch('native/addon.node','*.node',{matchBase:true}),true);
  assert.equal(new Minimatch('dist/**/*',{dot:true}).match('dist/.hidden/config.json'),true);
}
for(const consumer of ['@electron/asar','dir-compare','glob']) {
  const legacy=createRequire(builderRequire.resolve(consumer));
  assert.equal(typeof legacy('minimatch'),'function',`${consumer}: 구형 함수 API를 보존한다.`);
  assert.equal(legacy('minimatch')('dist/main.js','dist/**/*.js'),true);
}

const stat={isDirectory:()=>false} as fs.Stats;
function verify(patterns:string[],cases:[string,boolean][]):void {
  const filter=new FileMatcher(root,path.join(root,'output/matcher-fixture'),value=>value,patterns).createFilter();
  for(const [file,expected] of cases)assert.equal(filter(path.join(root,file),stat),expected,file);
}
verify(config.build.files,[['dist/main.js',true],['dist/renderer/diary/index.js',true],['dist/assets/data.json',true],
  ['dist/.hidden/config.json',true],['package.json',true],['node_modules/koffi/index.js',true],
  ['scripts/check-profiles-ui.ts',false],['dist-tools/check-profiles-ui.js',false],['src/env.json',false],
  ['output/fixture/config.json',false],['.agents/AGENTS.md',false],['package-lock.json',false]]);
verify(config.build.asarUnpack,[['node_modules/better-sqlite3/prebuilds/win32-x64/better_sqlite3.node',true],
  ['node_modules/koffi/build/koffi/win32_x64/koffi.node',true],['dist/store-update-helper/helper.exe',true],
  ['dist/main.js',false],['node_modules/adm-zip/adm-zip.js',false]]);
verify(['dist/**/*','!dist/**/*.{map,ts}','!dist/{private,fixtures}{,/**/*}'],[
  ['dist/main.js',true],['dist/renderer/module.js',true],['dist/main.js.map',false],['dist/types.ts',false],
  ['dist/private/nested/config.json',false],['dist/fixtures/game.json',false]]);
console.log('PASS build dependencies: patched class/named API, legacy function API, Windows file selection/unpack/exclusion patterns');

const archiveIndex=process.argv.indexOf('--archive');
if(archiveIndex>=0) {
  const archive=path.resolve(process.argv[archiveIndex+1]),asar=builderRequire('@electron/asar');
  const walk=(dir:string):string[]=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(dir,entry.name);return entry.isDirectory() ? walk(file) : [file];
  });
  const files=walk(path.join(root,'dist'));
  for(const file of files)assert.ok(asar.extractFile(archive,path.relative(root,file)).equals(fs.readFileSync(file)),`패키지 파일 불일치: ${file}`);
  const names=(asar.listPackage(archive) as string[]).map(name=>name.replace(/\\/g,'/'));
  assert.ok(!names.some(name=>/^\/(?:scripts|dist-tools|src|output|\.agents)(?:\/|$)/.test(name)));
  assert.ok(!names.some(name=>/^\/node_modules\/(?:electron-builder|app-builder-lib|typescript)(?:\/|$)/.test(name)));
  const packaged=JSON.parse(asar.extractFile(archive,'package.json').toString());
  assert.equal(packaged.version,config.version);assert.equal(packaged.main,config.main);
  for(const module of ['better-sqlite3','koffi'])assert.ok(fs.existsSync(path.join(archive+'.unpacked','node_modules',module)));
  console.log(`PASS package integrity: ${files.length} current build files, native modules unpacked, development/test files excluded`);
}
