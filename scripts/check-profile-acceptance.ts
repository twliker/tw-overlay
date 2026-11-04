/** 프로필 요구사항 전용 완료 게이트. 실패/누락/실행 중 소스 변경을 통과로 기록하지 않는다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import path = require('node:path');
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';

const root=path.resolve(__dirname,'..'),output=path.join(root,'output/profile-acceptance');
fs.mkdirSync(output,{recursive:true});
const latest=path.join(output,'latest.json');
const sha=(value:Buffer | string)=>createHash('sha256').update(value).digest('hex');
function files(directory:string):string[] {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const full=path.join(directory,entry.name);if(entry.isSymbolicLink())return [];
    return entry.isDirectory() ? files(full) : [full];
  });
}
function sourceSnapshot():{fingerprint:string;fileCount:number} {
  const inputs=[...files(path.join(root,'src')),...files(path.join(root,'scripts')),
    ...['package.json','package-lock.json','tsconfig.json','tsconfig.scripts.json'].map(name=>path.join(root,name))]
    .filter(file=>/\.(?:ts|html|css|json|cs|csproj|manifest)$/.test(file) && !file.includes(`${path.sep}bin${path.sep}`)
      && !file.includes(`${path.sep}obj${path.sep}`) && path.basename(file)!=='env.json').sort();
  return {fingerprint:sha(inputs.map(file=>`${path.relative(root,file).replace(/\\/g,'/')}:${sha(fs.readFileSync(file))}`).join('\n')),fileCount:inputs.length};
}
if(process.argv.includes('--verify')) {
  const proof=JSON.parse(fs.readFileSync(latest,'utf8'));
  assert.equal(proof.status,'passed');assert.equal(proof.source.fingerprint,sourceSnapshot().fingerprint,'검증 후 소스가 바뀌었습니다. 최신 변경에 해당하는 검증을 다시 수행하세요.');
  assert.ok(proof.steps.length>0 && proof.steps.every((step:any)=>step.status==='passed'));
  assert.equal(sha(fs.readFileSync(proof.packageArchive)),proof.steps.find((step:any)=>step.name==='package-integrity').archiveSha256,'검증한 패키지가 변경됐습니다.');
  console.log(`PASS current profile acceptance proof: ${proof.steps.length} gates, ${proof.source.fileCount} source files`);
} else void run().catch(error=>{console.error(error);process.exitCode=1;});

async function run():Promise<void> {
  assert.equal(process.platform,'win32','이 완료 게이트에는 실제 Windows 창 검사가 포함됩니다.');
  const id=new Date().toISOString().replace(/[:.]/g,'-'),directory=path.join(output,id);fs.mkdirSync(directory);
  const original=sourceSnapshot(),steps:any[]=[],report:any={status:'running',startedAt:new Date().toISOString(),source:original,
    commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
    scope:'local-profile-functional-acceptance',realGameVerified:false,elevatedWindowsVerified:false,installerExecuted:false,steps};
  const save=()=>{const value=JSON.stringify(report,null,2);fs.writeFileSync(path.join(directory,'report.json'),value);fs.writeFileSync(latest,value);};
  save();
  const npm=process.env.npm_execpath;assert.ok(npm && fs.existsSync(npm),'npm run test:profiles:acceptance로 실행하세요.');
  const electron=require('electron') as string;
  async function step(name:string,executable:string,args:string[],timeoutMs=120000):Promise<void> {
    const item={name,status:'running',startedAt:new Date().toISOString(),log:path.join(directory,name+'.log')} as any;
    steps.push(item);save();console.log(`START ${name}`);
    const stream=fs.createWriteStream(item.log),started=Date.now();let tail='';
    try {
      const result=await new Promise<{code:number | null;signal:NodeJS.Signals | null}>((resolve,reject)=>{
        // 실제 창 가시성 검사의 GUI 프로세스는 숨김 시작 옵션을 사용하지 않는다.
        const child=spawn(executable,args,{cwd:root,windowsHide:executable!==electron,stdio:'pipe'});
        const consume=(data:Buffer)=>{stream.write(data);tail=(tail+String(data)).slice(-12000);};
        child.stdout.on('data',consume);child.stderr.on('data',consume);
        const timer=setTimeout(()=>{child.kill();reject(new Error(`${name}: timeout`));},timeoutMs);
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
      });
      item.exitCode=result.code;item.signal=result.signal;
      assert.equal(result.code,0,`${name} failed\n${tail}`);
      item.status='passed';console.log(`PASS ${name} (${Date.now()-started} ms)`);
    } catch(error) {item.status='failed';item.error=String(error);throw error;}
    finally {item.elapsedMs=Date.now()-started;item.completedAt=new Date().toISOString();await new Promise<void>(resolve=>stream.end(resolve));save();}
  }
  async function local(name:string,file:string,args:string[]=[],timeout=120000):Promise<void> {
    await step(name,electron,[path.join(root,'dist-tools',file+'.js'),...args],timeout);
  }
  try {
    await step('typecheck',process.execPath,[npm,'run','typecheck']);
    await step('build',process.execPath,[npm,'run','build']);
    const suite=[
      ['window-visibility','check-window-visibility'],
      ['storage','check-profile-storage'],['diary','check-profile-diary'],['backup','check-profile-backup'],
      ['recording','check-profile-recording'],['tools','check-profile-tools'],['settings','check-profile-settings'],
      ['settings-pages','check-profile-settings-pages'],['log-restore','check-profile-log-restore'],['lifecycle','check-profile-lifecycle'],
      ['checklist','check-profile-checklist'],['stopwatch','check-profile-stopwatch'],['diary-ui','check-diary-profiles-ui'],
      ['profiles-ui','check-profiles-ui'],['cloud-pause','check-profile-cloud-pause'],['crash-recovery','check-profile-crash'],
      ['shared-contracts','check-refactor-regressions'],
    ];
    for(const [name,file] of suite)await local(name,file);
    await local('windows-matrix','check-profile-windows',[],300000);
    const archiveIndex=process.argv.indexOf('--legacy-archive');
    let legacyArchive=archiveIndex<0 ? path.join(root,'output/profile-upgrade-old/app/resources/app.asar') : path.resolve(process.argv[archiveIndex+1]);
    if(!fs.existsSync(legacyArchive)) {
      const oldInstaller=path.join(root,'dist_electron/twOverlay-Setup-3.2.2.exe'),extract=path.join(directory,'legacy');
      assert.ok(fs.existsSync(oldInstaller),'3.2.2 원본 설치 파일 또는 --legacy-archive 추출본이 필요합니다.');
      const sevenZip=require.resolve('electron-winstaller/vendor/7z.exe');
      await step('extract-legacy-installer',sevenZip,['x',oldInstaller,'$PLUGINSDIR\\app-64.7z',`-o${extract}`,'-y']);
      const appDir=path.join(extract,'app');
      await step('extract-legacy-app',sevenZip,['x',path.join(extract,'$PLUGINSDIR/app-64.7z'),`-o${appDir}`,'-y']);
      legacyArchive=path.join(appDir,'resources/app.asar');
    }
    await local('release-upgrade','check-profile-upgrade',['--old-archive',legacyArchive]);
    const packageOutput=path.join(directory,'package');
    await step('package-build',process.execPath,[require.resolve('electron-builder/out/cli/cli.js'),'--win','--dir','--publish','never',`--config.directories.output=${packageOutput}`],240000);
    const archive=path.join(packageOutput,'win-unpacked/resources/app.asar'),asar=require('@electron/asar');
    const integrity={name:'package-integrity',status:'running',files:0} as any;steps.push(integrity);save();
    for(const file of files(path.join(root,'dist')).filter(file=>/\.(?:js|html|css|json)$/.test(file))) {
      assert.ok(asar.extractFile(archive,path.relative(root,file)).equals(fs.readFileSync(file)),`패키지가 최신 빌드와 다릅니다: ${file}`);++integrity.files;
    }
    const names=(asar.listPackage(archive) as string[]).map(name=>name.replace(/\\/g,'/'));
    assert.ok(!names.some(name=>/^\/(?:scripts|dist-tools)\//.test(name)));
    integrity.status='passed';integrity.archiveSha256=sha(fs.readFileSync(archive));report.packageArchive=archive;save();
    const packagedRoot=path.join(archive,'dist');
    await local('packaged-windows-matrix','check-profile-windows',['--app-root',packagedRoot],300000);
    await local('packaged-release-upgrade','check-profile-upgrade',['--old-archive',legacyArchive,'--new-root',packagedRoot]);
    await local('development-zorder','runtime-zorder-windows-probe',['--allow-unelevated',path.join(root,'output/profile-game-fixture/InphaseNXD-zorder-fixture.exe')]);
    assert.equal(sourceSnapshot().fingerprint,original.fingerprint,'검증 중 소스가 변경되어 결과를 완료로 처리할 수 없습니다.');
    report.status='passed';report.completedAt=new Date().toISOString();save();
    console.log(`PASS profile functional acceptance: ${steps.length} gates; proof ${latest}`);
  } catch(error) {report.status='failed';report.error=String(error);report.completedAt=new Date().toISOString();for(const item of steps)if(item.status==='running')item.status='failed';save();throw error;}
}
