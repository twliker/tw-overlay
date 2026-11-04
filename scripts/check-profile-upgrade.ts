/** 실제 3.2.2 설치 패키지의 저장 API가 만든 임시 데이터를 새 프로필 저장소로 이전한다.
 * 설치 프로그램 실행/레지스트리 변경이나 실제 사용자 폴더 접근은 하지 않는다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {createHash} from 'node:crypto';
import {app,BrowserWindow,session} from 'electron';

const root=path.resolve(__dirname,'..');
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const oldArchive=path.resolve(argument('--old-archive') || path.join(root,'output/profile-upgrade-old/app/resources/app.asar'));
const newRoot=path.resolve(argument('--new-root') || path.join(root,'dist'));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-upgrade-')),data=path.join(fixture,'appData/twOverlay');
fs.mkdirSync(data,{recursive:true});app.setPath('appData',path.dirname(data));app.setPath('userData',data);app.on('window-all-closed',()=>{});
const old=(name:string)=>require(path.join(oldArchive,'dist',name+'.js'));
const current=(name:string)=>require(path.join(newRoot,name+'.js'));
const hash=(file:string)=>createHash('sha256').update((require('original-fs') as typeof fs).readFileSync(file)).digest('hex');

async function run():Promise<void> {
  await app.whenReady();
  assert.equal(require(path.join(oldArchive,'package.json')).version,'3.2.2');
  const oldConfig=old('modules/config'),oldDiary=old('modules/diaryDb'),defaults=old('modules/constants').DEFAULT_CONFIG;
  const today=new Date(),date=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
  const homework={id:'custom-release-upgrade',name:'이전할 숙제',category:'주간',isVisible:true,isCustom:true,maxCount:3,
    resetRule:{type:'weekly',dayOfWeek:0,hour:6},completedState:{
      A:{currentCount:1,isCompleted:false,lastCompletedAt:Date.now()},
      B:{currentCount:2,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()},
    }};
  const expired={...structuredClone(homework),id:'custom-release-expired',completedState:{
    A:{currentCount:3,isCompleted:true,lastCompletedAt:Date.now()-8*86400000},
    B:{currentCount:3,isCompleted:true,lastCompletedAt:Date.now()-8*86400000},
  }};
  const legacy={...structuredClone(defaults),analyticsEnabled:false,autoUpdateEnabled:false,userServer:7,
    pinnedNoteText:'3.2.2 사용자 메모',buffTimerEnabled:false,xpAutoStart:false,volumeContentsChecker:0,
    characterPresets:[{id:'A',name:'이전 A'},{id:'B',name:'이전 B'}],selectedCharacterId:'B',contentsCheckerItems:[homework,expired],pendingHomeworks:[]};
  assert.equal(oldConfig.saveConfirmed(legacy),true);
  oldDiary.initDb();
  assert.ok(oldDiary.addManualActivityLog(date,'09:00:00','calc','이전 수익',400));
  assert.ok(oldDiary.addManualActivityLog(date,'09:01:00','calc','이전 지출',-50));
  assert.equal(oldDiary.addActivityLog(date,'09:02:00','loot','이전 득템',1),true);
  assert.equal(oldDiary.addHomeworkLog(date,homework.id,homework.name,'주간','weekly',Date.now()),true);
  const before=oldDiary.getStmt('SELECT date,time,type,content,amount,source FROM activity_logs ORDER BY id').all();
  assert.equal(oldDiary.closeDb(),true);
  const sourceHash=hash(path.join(data,'diary.db'));
  const key='tw-coefficient-calculator-settings-v7final',toolValue=JSON.stringify({character:'release-fixture',attack:321});
  const bridge=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  await bridge.loadFile(path.join(oldArchive,'dist/storage-bridge.html'));
  await bridge.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(toolValue)})`);
  session.defaultSession.flushStorageData();bridge.destroy();

  const application=current('modules/profileApplication'),config=current('modules/config');
  const clock=new (current('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline fixture');});
  const controller=await application.startProfileApplication(()=>{},clock),{service,replay}=controller.runtime,store=service.store;
  const profiles=store.list();assert.equal(profiles.length,2,'기본 프로필을 별도로 더하지 않는다.');
  const a=profiles.find((item:any)=>item.name==='이전 A'),b=profiles.find((item:any)=>item.name==='이전 B');assert.ok(a && b);
  assert.equal(b.id,'profile-default','기존 선택 캐릭터가 기본 프로필을 사용한다.');
  for(const profile of profiles) {
    assert.equal(profile.userServer,7);
    const projection=store.project(profile.id,config.load());
    assert.equal(projection.pinnedNoteText,legacy.pinnedNoteText);assert.equal(projection.buffTimerEnabled,false);
    assert.equal(projection.xpAutoStart,false);assert.equal(projection.volumeContentsChecker,0);
    assert.equal(store.toolValues(profile.id)[key],toolValue,'기존 file-origin 계산기 입력을 각 프로필에 복사한다.');
    assert.equal(store.homework(profile.id).find((item:any)=>item.id===expired.id).completedState[profile.id].currentCount,0,'이전 준비의 지난 주기 초기화는 유지한다.');
  }
  assert.deepEqual(store.homework(a.id).find((item:any)=>item.id===homework.id).completedState[a.id],homework.completedState.A);
  assert.deepEqual(store.homework(b.id).find((item:any)=>item.id===homework.id).completedState[b.id],homework.completedState.B);
  assert.deepEqual(store.database.prepare('SELECT date,time,type,content,amount,source FROM activity_logs ORDER BY id').all(),before);
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM activity_logs WHERE profile_id IS NOT NULL').get().n,0,'과거 일지는 임의 귀속하지 않는다.');
  assert.equal(hash(path.join(data,'diary.db')),sourceHash,'기존 DB 원본을 변경하지 않는다.');
  const backups=path.join(data,'backups');
  const preparation=fs.readdirSync(backups).find(name=>name.startsWith('before-profile-preparation-'));assert.ok(preparation);
  current('modules/localSnapshot').verifyUserDataSnapshot(path.join(backups,preparation));
  assert.equal(hash(path.join(backups,preparation,'diary.db')),sourceHash,'이전 전 원본 백업을 검증한다.');
  controller.runtime.onGameState('running');assert.equal(service.status().selectionRequired,true);
  assert.equal((await service.select(a.id,replay)).success,true);
  assert.equal(config.saveConfirmed({pinnedNoteText:'이전 후 A 변경'}),true);
  assert.equal(store.project(b.id,config.load()).pinnedNoteText,legacy.pinnedNoteText);
  assert.equal(service.update(b.id,'이전 B',16).success,true);
  assert.equal((await service.select(b.id,replay)).success,true);assert.equal(config.load().userServer,16);
  assert.deepEqual(store.database.pragma('integrity_check'),[{integrity_check:'ok'}]);
  const output=path.join(root,'output/profile-upgrade');fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({passed:true,oldVersion:'3.2.2',oldArchiveHash:hash(oldArchive),
    newRoot,profiles:2,legacySourceUnchanged:true,backupVerified:true,settingsPreserved:true,homeworkPreserved:true,
    diaryPreserved:true,toolsPreserved:true,serverSwitch:true,installerExecuted:false},null,2));
  application.stopProfileApplication();controller.dispose();config.beginExternalRestore();current('modules/diaryDb').suspendForRestore();
  console.log('PASS profile release upgrade: actual 3.2.2 storage APIs -> profile storage, source/backup/settings/homework/diary/tools preserved');
}
run().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
