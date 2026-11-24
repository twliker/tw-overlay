/** 업그레이드 검사용 이전 버전 빌드를 저장소의 git 태그에서 만든다(설치 파일을 내려받지 않는다).
 * - `git archive <tag>`로 태그의 소스를 output 아래에 풀고, 현재 node_modules를 연결해 그 버전의 빌드 명령을 실행한다.
 *   네이티브 모듈(better-sqlite3)은 현재 Electron에 맞춘 것을 함께 써야 같은 프로세스에서 불러올 수 있다.
 * - 결과는 태그 커밋 ID로 캐시한다. 같은 커밋으로 이미 만들었으면 다시 빌드하지 않는다.
 * - 태그가 없는 얕은 clone(CI)에서는 그 태그만 원격에서 가져온다.
 * - check-profile-upgrade.ts가 `--old-archive <출력 폴더>`로 이 빌드의 실제 저장 코드를 사용한다.
 * 사용: node dist-tools/prepare-upgrade-baseline.js [--tag v3.2.2] [--out output/profile-upgrade-baseline/v3.2.2] */
import fs=require('node:fs');
import path=require('node:path');
import {execFileSync} from 'node:child_process';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const tag=argument('--tag') || 'v3.2.2';
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`지원하지 않는 태그 형식입니다: ${tag}`);
const out=path.resolve(root,argument('--out') || path.join('output/profile-upgrade-baseline',tag));
const outputRoot=path.resolve(root,'output');
if (!out.startsWith(outputRoot+path.sep)) throw new Error('이전 버전 빌드는 output 폴더 안에만 만든다.');
const markerPath=path.join(out,'.baseline.json');
/** 같은 프로세스에서 두 버전이 함께 불러오면 전역 상태가 충돌하는 네이티브 모듈. 이전 버전에 별도 사본을 둔다.
 * koffi의 네이티브 바이너리는 @koromix/koffi-<플랫폼> 패키지에 있으므로 함께 복사한다. */
const ISOLATED_NATIVE_MODULES=['koffi','@koromix'];
/** 빌드 방식이 바뀌면 올려 기존 캐시를 다시 만든다. */
const BASELINE_FORMAT=3;

const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function tagCommit():string {
  try {return git('rev-parse','--verify',`refs/tags/${tag}^{commit}`);}
  catch {
    // 얕은 clone에는 태그가 없다. 필요한 태그 하나만 가져온다.
    git('fetch','--no-tags','--depth','1','origin',`refs/tags/${tag}:refs/tags/${tag}`);
    return git('rev-parse','--verify',`refs/tags/${tag}^{commit}`);
  }
}

/** 이전 빌드를 지운다. node_modules 안의 연결(junction)은 먼저 끊어, 재귀 삭제가 원본 패키지로 들어가지 않게 한다. */
function removeBaseline():void {
  const modules=path.join(out,'node_modules');
  const stat=fs.lstatSync(modules,{throwIfNoEntry:false});
  if (stat?.isSymbolicLink()) fs.unlinkSync(modules);
  else if (stat?.isDirectory()) {
    for (const name of fs.readdirSync(modules)) {
      const entry=path.join(modules,name);
      if (fs.lstatSync(entry).isSymbolicLink()) fs.unlinkSync(entry);
    }
  }
  fs.rmSync(out,{recursive:true,force:true});
}

function main():void {
  const commit=tagCommit();
  const marker=fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath,'utf8')) as {commit?:string;format?:number} : undefined;
  if (marker?.commit===commit && marker.format===BASELINE_FORMAT && fs.existsSync(path.join(out,'dist/modules/config.js'))) {
    console.log(`Upgrade baseline ${tag} (${commit.slice(0,7)}) is up to date: ${out}`);
    return;
  }
  removeBaseline();
  fs.mkdirSync(out,{recursive:true});
  // 별도 index로 태그 트리를 꺼낸다. 작업 중인 index·작업 트리는 건드리지 않고, 셸별 tar 경로 해석 차이도 피한다.
  const index=path.join(path.dirname(out),`${tag}.index`);
  const prefix=path.relative(root,out).split(path.sep).join('/')+'/';
  const env={...process.env,GIT_INDEX_FILE:index};
  try {
    execFileSync('git',['read-tree',commit],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    execFileSync('git',['checkout-index','--all','--force',`--prefix=${prefix}`],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  } finally {fs.rmSync(index,{force:true});}
  // 이전 버전의 빌드 도구와 런타임 모듈은 현재 설치본을 연결해 쓴다(네이티브 모듈 ABI를 현재 Electron에 맞춘다).
  // 단, koffi는 구조체 타입 이름을 프로세스 전체에 한 번만 등록하므로 같은 프로세스에서 두 버전의 win32 모듈을
  // 불러오면 충돌한다. 설치본처럼 이전 버전에는 별도 사본을 둔다.
  const modules=path.join(out,'node_modules'),sourceModules=path.join(root,'node_modules');
  fs.mkdirSync(modules);
  for (const name of fs.readdirSync(sourceModules)) {
    if (name.startsWith('.')) continue;
    const source=path.join(sourceModules,name),target=path.join(modules,name);
    if (ISOLATED_NATIVE_MODULES.includes(name)) fs.cpSync(source,target,{recursive:true,dereference:true});
    else fs.symlinkSync(source,target,'junction');
  }
  const tsc=path.join(root,'node_modules/typescript/bin/tsc');
  // 현재 타입 정의와 맞지 않는 구버전 소스의 타입 오류는 JS 출력에 영향이 없으므로 결과 파일로 판정한다.
  const run=(label:string,args:string[])=>{
    try {execFileSync(process.execPath,args,{cwd:out,stdio:['ignore','pipe','pipe']});}
    catch (error) {
      const output=String((error as {stdout?:Buffer}).stdout || '')+String((error as {stderr?:Buffer}).stderr || '');
      console.warn(`${label}: 종료 코드가 0이 아닙니다. 생성된 파일로 계속 판정합니다.\n${output.split(/\r?\n/).slice(0,8).join('\n')}`);
    }
  };
  run('build-tools',[tsc,'-p','tsconfig.scripts.json']);
  run('copy-resources',[path.join(out,'dist-tools/copy-resources.js')]);
  run('tsc',[tsc]);
  for (const required of ['package.json','dist/modules/config.js','dist/modules/diaryDb.js','dist/storage-bridge.html']) {
    if (!fs.existsSync(path.join(out,required))) throw new Error(`${tag} 빌드 결과에 ${required}가 없습니다.`);
  }
  const version=(JSON.parse(fs.readFileSync(path.join(out,'package.json'),'utf8')) as {version:string}).version;
  if (`v${version}`!==tag) throw new Error(`${tag} 소스의 package.json 버전이 ${version}입니다.`);
  fs.writeFileSync(markerPath,JSON.stringify({tag,commit,version,format:BASELINE_FORMAT,builtAt:new Date().toISOString()},null,2));
  console.log(`Upgrade baseline ${tag} (${commit.slice(0,7)}) built: ${out}`);
}

main();
