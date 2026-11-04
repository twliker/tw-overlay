/** 실제 배포 기본 목록/부팅/프로필 생성/기존 빈 DB 복구. 사용자 데이터는 사용하지 않는다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {spawnSync} from 'node:child_process';
import {app} from 'electron';
const root=path.resolve(__dirname,'..');
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0 ? undefined : process.argv[i+1];};
const phase=arg('--phase'),fixture=arg('--fixture') || fs.mkdtempSync(path.join(os.tmpdir(),'tw-homework-defaults-'));
assert.equal(path.dirname(fs.realpathSync(fixture)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
assert.ok(path.basename(fixture).startsWith('tw-homework-defaults-'));
const marker=path.join(fixture,'owned-fixture');
if(phase)assert.equal(fs.readFileSync(marker,'utf8'),'homework defaults');else fs.writeFileSync(marker,'homework defaults');
const data=path.join(fixture,phase==='fresh' ? 'fresh' : phase ? 'legacy' : 'driver');fs.mkdirSync(data,{recursive:true});
app.setPath('userData',data);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name));
const catalog=()=>JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/contents.json'),'utf8')) as any[];
const expectedPath=path.join(fixture,'expected.json');
const snapshot=(store:any)=>store.database.prepare('SELECT profile_id,item_id,definition,state,position FROM profile_homework ORDER BY profile_id,position,item_id').all();
function assertDefaults(store:any,id:string,excluded:string[]=[]):void {
  const actual=new Set(store.homework(id).map((item:any)=>item.id));
  for(const item of catalog())assert.equal(actual.has(item.id),!excluded.includes(item.id),`${id}: 기본 숙제 ${item.id}`);
}
async function run():Promise<void> {
  await app.whenReady();
  if(!phase) {
    const output=path.join(root,'output/profile-homework-defaults');fs.mkdirSync(output,{recursive:true});
    for(const which of ['seed','recover-failure','recover','verify','fresh']) {
      const r=spawnSync(process.execPath,[__filename,'--phase',which,'--fixture',fixture],{windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:3*1024*1024});
      fs.writeFileSync(path.join(output,which+'.log'),(r.stdout || '')+(r.stderr || '')+(r.error ? String(r.error) : ''));
      assert.equal(r.status,0,`${which}: ${(r.stdout || '')+(r.stderr || '')}`);console.log(`PASS real homework defaults: ${which}`);
    }
    fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify({passed:true,productionCatalog:true,baseCount:catalog().length,
      actualStartup:true,independentRestarts:true,newAndCopiedProfiles:true,emptyAndPartialRecovery:true,
      completionCustomAndOrderPreserved:true,deletionPreserved:true,atomicRecoveryFailure:true,fallbackDefault:true},null,2));return;
  }
  const defaults=built('modules/constants').DEFAULT_CONFIG;
  if(phase==='seed') {
    // beta.3과 같이 빈 DEFAULT_CONFIG를 사용한 실제 저장 API로 누락 상태를 만든다.
    const legacy={...structuredClone(defaults),analyticsEnabled:false,userServer:7,
      characterPresets:[{id:'old',name:'기존 빈 프로필'}],selectedCharacterId:'old',contentsCheckerItems:[]};
    fs.writeFileSync(path.join(data,'config.json'),JSON.stringify(legacy));
    const {ApplicationData}=built('modules/applicationData');
    const store=await ApplicationData.initialize({directory:data,deviceId:'fixture-pc',defaults},legacy,{value:7});
    const empty=store.list()[0].id,partial=store.create('기존 일부 숙제',16).id,deleted=store.create('명시 삭제 보존',7).id;
    const custom={id:'custom-preserved',name:'내 숙제',category:'사용자 분류',isVisible:false,isCustom:true,maxCount:5,
      resetRule:{type:'weekly',dayOfWeek:1,hour:6},completedState:{[empty]:{currentCount:2,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()}}};
    let cfg=store.project(empty,legacy);cfg.contentsCheckerItems=[custom];store.saveProjection(empty,cfg);
    const item={...catalog()[0],name:'사용자 이름 보존',category:'보존 분류',isVisible:false,completedState:{[partial]:{
      currentCount:1,isCompleted:(catalog()[0].maxCount || 1)===1,isExcluded:true,lastCompletedAt:Date.now()}}};
    cfg=store.project(partial,legacy);cfg.contentsCheckerItems=[item];store.saveProjection(partial,cfg);
    const preserved=snapshot(store);const removed=catalog()[1];cfg=store.project(deleted,legacy);cfg.contentsCheckerItems=[{...removed,completedState:{}}];store.saveProjection(deleted,cfg);
    cfg.contentsCheckerItems=[];store.saveProjection(deleted,cfg);
    store.commitConfiguration(store.project(empty,legacy),store.project(empty,legacy));
    fs.writeFileSync(expectedPath,JSON.stringify({empty,partial,deleted,removed:removed.id,preserved}));store.close();return;
  }
  const config=built('modules/config');
  if(phase==='fresh')fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({analyticsEnabled:false,characterPresets:[],contentsCheckerItems:[]}));
  const application=built('modules/profileApplication');
  const clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline');});
  if(phase==='recover-failure') {
    const Database=require('better-sqlite3'),file=path.join(data,'app-data.db'),db=new Database(file);
    const failId=catalog()[2].id.replace(/'/g,"''");
    db.exec(`CREATE TRIGGER fail_default_repair BEFORE INSERT ON profile_homework WHEN NEW.item_id='${failId}' BEGIN SELECT RAISE(ABORT,'fixture default repair failure');END`);db.close();
    await assert.rejects(application.startProfileApplication(()=>{},clock),/fixture default repair failure/);
    const after=new Database(file);try {
      assert.deepEqual(after.prepare('SELECT profile_id,item_id,definition,state,position FROM profile_homework ORDER BY profile_id,position,item_id').all(),JSON.parse(fs.readFileSync(expectedPath,'utf8')).preserved,'복구 중 실패해도 원래 행 보존·부분 복구 rollback');
      after.exec('DROP TRIGGER fail_default_repair');
    } finally {after.close();}return;
  }
  const controller=await application.startProfileApplication(()=>{},clock),{store}=controller.runtime.service;
  try {
    if(phase==='recover' || phase==='verify') {
      const expected=JSON.parse(fs.readFileSync(expectedPath,'utf8'));assert.equal(store.list().length,3,'복구 시 프로필을 추가하지 않음');
      assertDefaults(store,expected.empty);assertDefaults(store,expected.partial);assertDefaults(store,expected.deleted,[expected.removed]);
      for(const row of expected.preserved)assert.deepEqual(store.database.prepare('SELECT profile_id,item_id,definition,state,position FROM profile_homework WHERE profile_id=? AND item_id=?').get(row.profile_id,row.item_id),row,
        '기존 이름/분류/숨김/N/A/완료 상태/순서를 덮어쓰지 않음');
      const statePath=path.join(fixture,'after-recovery.json');
      if(phase==='recover')fs.writeFileSync(statePath,JSON.stringify(snapshot(store)));
      else assert.deepEqual(snapshot(store),JSON.parse(fs.readFileSync(statePath,'utf8')),'다음 프로세스 시작 시 중복/변경 없음');
    } else {
      assert.equal(store.list().length,1);const first=store.list()[0];assert.equal(first.name,'');assert.equal(first.userServer,null);assertDefaults(store,first.id);
      const service=controller.runtime.service;assert.equal(service.update(first.id,'기본 프로필',7).success,true);
      const created=service.create('추가 프로필',16);assert.equal(created.success,true,created.error);assertDefaults(store,created.profileId);
      const cfg=store.project(first.id,config.load());cfg.contentsCheckerItems[0].completedState[first.id]={currentCount:1,isCompleted:true,lastCompletedAt:Date.now()};
      cfg.contentsCheckerItems.push({id:'custom-copy-excluded',name:'복사 제외',category:'일일',isVisible:true,isCustom:true,resetRule:{type:'daily',hour:6},completedState:{}});store.saveProjection(first.id,cfg);
      const copied=service.create('설정 복사',7,first.id);assert.equal(copied.success,true,copied.error);assertDefaults(store,copied.profileId);
      assert.equal(store.homework(copied.profileId).length,catalog().length);assert.ok(store.homework(copied.profileId).every((item:any)=>Object.keys(item.completedState[copied.profileId]).length===0));
      for(const profile of store.list())store.remove(profile.id);
      assert.equal(store.list().length,1);assert.equal(store.list()[0].name,'');assert.equal(store.list()[0].userServer,null);assertDefaults(store,store.list()[0].id);
      store.database.prepare('UPDATE play_profiles SET deleted_at=?').run(Date.now());store.ensureEmptyProfile();assertDefaults(store,store.list()[0].id);
    }
  } finally {application.stopProfileApplication();controller.dispose();built('modules/diaryDb').closeDb();}
}
run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
