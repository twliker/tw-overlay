/** 동기화 목표 완료 시 한 번 실행하는 관련 회귀 묶음. 전체 npm test/실계정 로그인을 실행하지 않는다. */
import fs=require('node:fs');
import path=require('node:path');
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(__dirname,'..'),output=path.join(root,'output/profile-sync-acceptance');
const runId=new Date().toISOString().replace(/[:.]/g,'-'),directory=path.join(output,runId);fs.mkdirSync(directory,{recursive:true});
function fingerprint():string {
  const files:string[]=[];const walk=(dir:string)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const absolute=path.join(dir,entry.name);if(entry.isDirectory()) {if(!['bin','obj'].includes(entry.name))walk(absolute);}
    else if(/\.(ts|html|css|json|cs|csproj|manifest)$/.test(entry.name) && entry.name!=='env.json')files.push(absolute);
  }};walk(path.join(root,'src'));walk(path.join(root,'scripts'));
  for(const file of ['package.json','package-lock.json','tsconfig.json','tsconfig.scripts.json'])files.push(path.join(root,file));
  const hash=createHash('sha256');for(const file of files.sort()) {hash.update(path.relative(root,file));hash.update(fs.readFileSync(file));}return hash.digest('hex');
}
const report:any={status:'running',startedAt:new Date().toISOString(),scope:'profile-google-sync-offline-acceptance',
  realGoogleVerified:false,actualProjectQuotaVerified:false,sourceFingerprint:fingerprint(),gates:[]};
const save=()=>{fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify(report,null,2));};save();
const npm=process.env.npm_execpath || path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const electron=require('electron') as string;
const gates=[['typecheck',process.execPath,[npm,'run','typecheck']],['build',process.execPath,[npm,'run','build']],
  ...['profile-sync-model','profile-sync-drive','profile-sync','profile-sync-concurrency','profile-sync-ui','profile-storage','profile-homework-defaults','profile-recording','profile-backup',
    'profile-settings','profile-settings-pages','profile-tools','profile-checklist','profile-stopwatch','profile-lifecycle','profile-cloud-pause',
    'refactor-regressions','profile-windows','profile-upgrade','profile-crash','profile-sync-budget'].map(name=>[name,electron,[path.join(root,'dist-tools',`check-${name}.js`)]]),
  ['profile-sync-import-ui',electron,[path.join(root,'dist-tools/check-profile-sync-ui.js'),'--remote-import']],
] as [string,string,string[]][];
try {
  for(const [name,executable,args] of gates) {
    const stage={name,status:'running',startedAt:new Date().toISOString(),log:path.join(directory,`${name}.log`)};report.gates.push(stage);save();
    console.log(`RUN ${name}`);const result=spawnSync(executable,args,{cwd:root,encoding:'utf8',windowsHide:false,timeout:180_000,maxBuffer:16*1024*1024});
    fs.writeFileSync(stage.log,(result.stdout || '')+(result.stderr || '')+(result.error ? String(result.error) : ''));
    stage.status=result.status===0 && !result.error ? 'passed' : 'failed';save();
    if(stage.status==='failed')throw new Error(`${name} failed; ${stage.log}`);
    console.log(`PASS ${name}`);
  }
  if(fingerprint()!==report.sourceFingerprint)throw new Error('검사 중 소스가 변경되어 현재 소스 검증으로 인정하지 않습니다.');
  report.status='passed';console.log(`PASS Google profile sync acceptance: ${gates.length} gates`);
} catch(error) {report.status='failed';report.error=String(error);console.error(report.error);process.exitCode=1;}
finally {report.completedAt=new Date().toISOString();save();}
