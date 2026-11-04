/** 사용자가 직접 Google에 로그인하는 격리 실서비스 검사. 일반 자동 검사에 포함하지 않는다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import path=require('node:path');
import os=require('node:os');
import {randomUUID} from 'node:crypto';
import {app} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-sync-live-'));
app.setPath('userData',fixture);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name));
const namespace=`test-${randomUUID()}`,stores:any[]=[],drives:any[]=[];
const report:any={status:'running',namespace,startedAt:new Date().toISOString(),realGoogleVerified:false,cleaned:false,fixture};
const output=path.join(root,'output/profile-sync-live');fs.mkdirSync(output,{recursive:true});
const save=()=>fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify(report,null,2));save();
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function pc(device:string,empty=false):Promise<any> {
  const defaults=structuredClone(built('modules/constants').DEFAULT_CONFIG);
  defaults.contentsCheckerItems=[{id:'live-task',name:'검사 숙제',category:'일일',isCustom:true,isVisible:true,resetRule:{type:'daily',hour:6},maxCount:5,completedState:{}}];
  const legacy={...defaults,characterPresets:empty ? [] : [{id:'old',name:'Google 동기화 검사'}],selectedCharacterId:empty ? undefined : 'old'};
  const directory=path.join(fixture,device);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(legacy));
  const store=await built('modules/applicationData').ApplicationData.initialize({directory,deviceId:device,defaults,
    clock:()=>({utcMs:Date.now(),source:'unverified',uncertaintyMs:null})},legacy,{value:empty ? undefined : 7});stores.push(store);
  const model=new (built('modules/profileSyncModel').ProfileSyncModel)(()=>store.database,device,()=>({utcMs:Date.now(),source:'unverified',uncertaintyMs:null}));
  const auth=built('modules/googleAuth'),drive=new (built('modules/profileSyncDrive').GoogleProfileDrive)(fetch,()=>auth.getValidAccessToken(),()=>auth.refreshAfterUnauthorized(),()=>auth.invalidateAuth(),namespace);drives.push(drive);
  const sync=new (built('modules/profileSyncCoordinator').ProfileSyncCoordinator)(model,drive,{
    account:()=>auth.loadStoredProfile()?.email || null,enabled:()=>true,auto:()=>false,activeProfile:()=>undefined,ready:()=>true,
    async beforeImport(){report.backups=(report.backups || 0)+1;},async apply(write:()=>void){write();store.ensureEmptyProfile();},changed(){},
  });return {store,model,sync,defaults};
}
async function exchange(a:any,b:any,predicate:()=>boolean):Promise<void> {
  for(let attempt=0;attempt<12;attempt++) {
    await pause(2200);
    await a.sync.sync(true);if(a.sync.details().connection==='choice') await a.sync.choose('merge');
    await b.sync.sync(true);if(b.sync.details().connection==='choice') await b.sync.choose('remote');
    if(predicate()) return;
    console.log(`Google 반영 확인 ${attempt+1}/12`);
  }
  throw new Error('실제 Google 데이터 반영을 제한 시간 안에 확인하지 못했습니다.');
}
async function run():Promise<void> {
  await app.whenReady();const auth=built('modules/googleAuth');
  console.log('검사용 Google 로그인 창을 엽니다. 브라우저에서 직접 로그인해 주세요. 기존 앱 데이터는 읽거나 수정하지 않습니다.');
  const login=await auth.startLogin();if(!login.success) throw new Error(login.error || '검사용 Google 로그인이 필요합니다.');
  const a=await pc('LIVE-PC-A'),b=await pc('LIVE-PC-B',true);const aid=a.store.list()[0].id;
  await a.sync.sync(true);
  await exchange(a,b,()=>b.store.list().some((p:any)=>p.name==='Google 동기화 검사'));
  assert.equal(b.store.list().length,1);const bid=b.store.list()[0].id;
  const cfg=b.store.project(bid,b.defaults);cfg.pinnedNoteText='PC B에서 보낸 메모';cfg.contentsCheckerItems[0].completedState[bid]={currentCount:2,isCompleted:false,lastCompletedAt:Date.now()};b.store.saveProjection(bid,cfg);
  await exchange(b,a,()=>a.store.setting(aid,'pinnedNoteText')==='PC B에서 보낸 메모');
  assert.equal(a.store.homework(aid)[0].completedState[aid].currentCount,2);
  const ac=a.store.project(aid,a.defaults),bc=b.store.project(bid,b.defaults);ac.pinnedNoteText='A 동시';bc.pinnedNoteText='B 동시';a.store.saveProjection(aid,ac);b.store.saveProjection(bid,bc);
  await exchange(a,b,()=>a.sync.details().reviews.length>0 && b.sync.details().reviews.length>0);
  const review=a.sync.details().reviews.find((r:any)=>r.label.includes('메모'));assert.ok(review);await a.sync.resolve(review.key,'local');
  await exchange(a,b,()=>b.store.setting(bid,'pinnedNoteText')==='A 동시' && b.sync.details().reviews.length===0);
  report.realGoogleVerified=true;report.requests=drives.reduce((n,d)=>n+d.requests,0);report.uploadedBytes=drives.reduce((n,d)=>n+d.uploadedBytes,0);report.downloadedBytes=drives.reduce((n,d)=>n+d.downloadedBytes,0);
  report.checks=['real OAuth','isolated appData namespace','two PC upload/download','empty default reuse','homework and settings','conditional overwrite','conflict resolution','gzip transfer'];
}
(async()=>{
  try {await run();report.status='passed';}
  catch(error) {report.status='failed';report.error=error instanceof Error ? error.message : String(error);console.error(report.error);}
  finally {
    for(const store of stores) store.close();
    if(drives.length) try {await drives[0].removeIsolatedTestFiles();report.cleaned=true;} catch(error){report.status='failed';report.cleanupError=String(error);}
    built('modules/googleAuth').logout();report.completedAt=new Date().toISOString();save();
    console.log(`Google 실서비스 검사 ${report.status}; 결과 output/profile-sync-live/latest.json`);app.exit(report.status==='passed' ? 0 : 1);
  }
})();
