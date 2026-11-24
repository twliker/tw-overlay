/** 실제 두 SQLite 저장소 + 운영 coordinator. HTTP leaf만 메모리 Drive로 교체한다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {app} from 'electron';
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-sync-'));app.setPath('userData',fixture);
const root=path.resolve(__dirname,'..');const built=(p:string)=>require(path.join(root,'dist',p));
const {ApplicationData}=built('modules/applicationData'),{DEFAULT_CONFIG}=built('modules/constants');
const {ProfileSyncModel,localSyncProfileId,profileSyncResetCycle}=built('modules/profileSyncModel'),{ProfileSyncCoordinator,ProfileSyncApplyDeferred}=built('modules/profileSyncCoordinator');
const {PROFILE_SYNC_POLICY}=built('shared/profileSync');
const {ProfileDriveError,ProfileDriveNetworkError,InvalidProfileDriveFile}=built('modules/profileSyncDrive');
let now=Date.now();const actualNow=Date.now;Date.now=()=>now;
const clone=<T>(v:T):T=>structuredClone(v);
const cloud=new Map<string,{file:any;envelope:any;at:number}>();let revision=0,allocated=0;
let uploads=0,scans=0,downloads=0,failUpload=false,loseAck=false,delayUpload:(()=>Promise<void>) | undefined;
let invalidRetryAfter=false,offline=false,retryScanMs=0,omitUploadMeta=false;
let delayScan:(()=>Promise<void>) | undefined;
const damaged=new Set<string>();
const transport=()=>({
  cancel(){},async allocate(){return `file-${++allocated}`;},
  async scan(cursor?:string){scans++;if(delayScan) await delayScan();if(offline) throw new ProfileDriveNetworkError('offline fixture');if(invalidRetryAfter) throw new ProfileDriveError('invalid retry header',429,NaN);if(retryScanMs) throw new ProfileDriveError('account quota fixture',429,retryScanMs);return {files:[...cloud.values()].filter(v=>!cursor || v.at>Number(cursor)).map(v=>clone(v.file)),removed:[],cursor:String(revision),full:!cursor};},
  async download(file:any){downloads++;if(damaged.has(file.id)) throw new InvalidProfileDriveFile('damaged');return clone(cloud.get(file.id)!.envelope);},
  async upload(id:string,envelope:any,exists:boolean){
    uploads++;if(failUpload) throw new ProfileDriveError('quota fixture',429,60_000);
    if(delayUpload) await delayUpload();
    assert.equal(exists,cloud.has(id),'기존 파일에 조건부 갱신, 신규 파일에 지정 ID 생성');
    const prior=cloud.get(id);if(prior) assert.equal(prior.envelope.device,envelope.device,'타 PC 파일은 쓰지 않음');
    const version=String(++revision);cloud.set(id,{file:{id,name:`tw_overlay_profiles_${envelope.device}.json`,version,md5Checksum:version,
      appProperties:{twProfileSync:'1',device:envelope.device}},envelope:clone(envelope),at:revision});
    if(loseAck) {loseAck=false;throw new Error('upload response lost');}
    return omitUploadMeta ? undefined : {version,md5Checksum:version};
  },
});
const all:any[]=[];
async function pc(name:string,empty=false):Promise<any> {
  const directory=path.join(fixture,name);fs.mkdirSync(directory);
  // v3.2.2 캐릭터 ID는 PC·캐릭터마다 다르다(char-시각-난수). 같은 ID는 같은 캐릭터로 동기화되므로 PC별로 둔다.
  const character=`char-${name}`;
  const legacy={...clone(DEFAULT_CONFIG),userServer:7,characterPresets:empty ? [] : [{id:character,name}],selectedCharacterId:empty ? undefined : character};
  fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(empty ? {} : legacy));
  const store=await ApplicationData.initialize({directory,deviceId:name,defaults:DEFAULT_CONFIG,clock:()=>({utcMs:now,source:'unverified',uncertaintyMs:null})},legacy,{value:empty ? undefined : 7});
  const state={account:'test@example.invalid',enabled:true,auto:true,active:undefined as string | undefined,settings:undefined as string | undefined,
    dirtyEditor:false,backups:0,applies:0,selections:0,activeReads:0,ready:true,quitting:false,toolBusy:undefined as string | undefined};
  const model=new ProfileSyncModel(()=>store.database,name,()=>({utcMs:now,source:'unverified',uncertaintyMs:null}),()=>state.settings,(id:string)=>store.isPristineProfilePlaceholder(id));
  const sync=new ProfileSyncCoordinator(model,transport(),{
    account:()=>state.account,enabled:()=>state.enabled,auto:()=>state.auto,activeProfile:()=>{state.activeReads++;return state.active;},ready:()=>state.ready,
    async beforeImport(){state.backups++;model.setMeta('backupAvailable',true);},
    async apply(action:()=>void,selection=false,deletingId?:string){
      if (deletingId && deletingId===state.settings && state.dirtyEditor) throw new Error('fixture dirty profile editor');
      if (state.quitting) throw new Error('fixture quitting: 종료 중에는 프로필 runtime에 반영하지 않음');
      // 운영 apply hook은 계산기 창의 작성 중 입력(ProfileToolBusyError)을 이 오류로 바꾼다(profileCloudSync).
      if (state.toolBusy) throw new ProfileSyncApplyDeferred(state.toolBusy);
      state.applies++;if(selection){state.selections++;state.active=undefined;}action();store.ensureEmptyProfile();
    },changed(){},
  },()=>now,()=>0.5);all.push(store);return {store,model,sync,state};
}
function set(p:any,id:string,k:string,v:unknown):void {const cfg=p.store.project(id,DEFAULT_CONFIG);cfg[k]=v;p.store.saveProjection(id,cfg);}
async function exchange(a:any,b:any):Promise<void> {now+=3000;await a.sync.sync(true);now+=3000;await b.sync.sync(true);now+=3000;await a.sync.sync(true);}
async function run():Promise<void> {
  await app.whenReady();const a=await pc('PC-A'),b=await pc('PC-B',true);const aid=a.store.list()[0].id;
  a.state.enabled=false;
  await a.sync.runDueWork();
  a.state.enabled=true;a.state.auto=false;
  await a.sync.runDueWork();
  a.state.auto=true;a.state.account='';
  await a.sync.runDueWork();
  assert.equal(a.state.activeReads,0,'비활성 상태에서는 활성 프로필을 조회하지 않음');
  a.state.account='test@example.invalid';
  await a.sync.sync(true);
  assert.equal(a.sync.details().connection,'choice','빈 Google 저장소에도 첫 설정 확인 필요');
  assert.equal(uploads,0,'설정 전에는 빈 Google 저장소에 자동으로 쓰지 않음');
  const beforeChoice=scans;now+=60_000;a.sync.request();await a.sync.runDueWork();await a.sync.sync();
  assert.equal(scans,beforeChoice,'선택 대기 동안 예약 조회를 반복하지 않음');
  await assert.rejects(a.sync.choose('remote'),/가져올 프로필이 없습니다/);
  assert.equal(a.store.list()[0].id,aid);
  await a.sync.choose('merge');await a.sync.sync(true);assert.equal(a.model.pending(),0);assert.equal(uploads,1);
  const uploadsBeforeToggle=uploads;
  set(a,aid,'pinnedNoteText','자동 전송 중지 검사');
  now+=3000;a.sync.request();
  let finishAutoScan!:()=>void;
  delayScan=()=>new Promise<void>(resolve=>{finishAutoScan=resolve;});
  const autoWork=a.sync.sync();
  a.state.auto=false;
  delayScan=undefined;finishAutoScan();await autoWork;
  assert.equal(uploads,uploadsBeforeToggle,'자동 조회 중 끄면 업로드를 시작하지 않는다');
  assert.equal(a.sync.retryCount,0,'사용자가 끈 작업은 전송 실패로 재시도하지 않는다');
  assert.ok(a.model.pending()>0,'중지한 변경은 이 PC에 보관한다');
  await a.sync.sync(true);
  assert.equal(uploads,uploadsBeforeToggle+1,'자동을 꺼도 수동 동기화 가능');
  a.state.auto=true;
  await b.sync.sync(true);assert.equal(b.sync.details().connection,'choice');assert.equal(uploads,uploadsBeforeToggle+1,'첫 연결 선택 전 업로드 없음');
  const beforeImport=scans;now+=60_000;b.sync.activityChanged(true);await b.sync.runDueWork();
  assert.equal(scans,beforeImport,'Google 데이터가 있어도 선택 중에는 조회하지 않음');
  await b.sync.choose('remote');assert.equal(b.state.backups,1);assert.equal(b.store.list().length,1,'빈 기본+복원 프로필 중복 없음');
  const rid=JSON.parse(Object.keys(a.model.envelope().cells).find(k=>JSON.parse(k)[0]==='profile')!)[1],bid=localSyncProfileId(b.model.db,rid);
  assert.equal(bid,'profile-default');a.state.active=aid;b.state.active=bid;
  set(a,aid,'pinnedNoteText','A 변경');set(b,bid,'buffTimerWarnSeconds',[21]);await exchange(a,b);
  assert.equal(b.store.setting(bid,'pinnedNoteText'),'A 변경');assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[21]);
  assert.equal(a.state.active,aid);assert.equal(b.state.active,bid,'현재 선택은 PC별 유지');
  set(b,bid,'buffTimerWarnSeconds',[29]);now+=3000;await b.sync.sync(true);const cursorBefore=a.model.meta('cursor','');
  a.model.db.exec("CREATE TRIGGER reject_remote_settings BEFORE INSERT ON profile_settings WHEN NEW.key='buffTimerWarnSeconds' BEGIN SELECT RAISE(ABORT,'remote save failure');END");
  now+=3000;await assert.rejects(a.sync.sync(true),/remote save failure/);assert.equal(a.model.meta('cursor',''),cursorBefore);assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[21],'원격 DB 반영 실패는 원본/cursor 함께 보존');
  a.model.db.exec('DROP TRIGGER reject_remote_settings');now+=60_001;await a.sync.sync(true);assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[29]);
  const idle={uploads,downloads,applies:a.state.applies};now+=3000;await a.sync.sync(true);
  assert.equal(uploads,idle.uploads);assert.equal(downloads,idle.downloads);assert.equal(a.state.applies,idle.applies,'유휴 확인은 본문 재수신/원본 재적용 없음');
  // 업로드 응답의 revision을 보관해 다음 변경 feed의 자기 파일을 다시 받거나 반영하지 않는다.
  set(a,aid,'pinnedNoteText','자기 파일 재수신 검사');now+=3000;await a.sync.sync(true);
  const ownEcho={downloads,applies:a.state.applies};now+=3000;await a.sync.sync(true);
  assert.equal(downloads,ownEcho.downloads,'자기 업로드 revision은 다시 받지 않음');
  assert.equal(a.state.applies,ownEcho.applies,'자기 파일만 바뀐 확인은 반영 경로를 실행하지 않음');
  omitUploadMeta=true;set(a,aid,'pinnedNoteText','응답 메타 없음');now+=3000;await a.sync.sync(true);omitUploadMeta=false;
  const noMeta={downloads,applies:a.state.applies};now+=3000;await a.sync.sync(true);
  assert.equal(downloads,noMeta.downloads+1,'revision을 모르면 자기 파일을 한 번 다시 받는다');
  assert.equal(a.state.applies,noMeta.applies,'본문이 같으면 다시 반영하지 않는다');
  // 이 PC의 잘못된 값 하나는 보류하고 나머지를 전송한다. 안내는 보류 목록이 바뀔 때 한 번만 한다.
  set(a,aid,'customAlerts',[{id:'broken',enabled:true,type:'daily',message:'시간 없음',soundFile:'orb.mp3'}]);set(a,aid,'pinnedNoteText','보류와 함께 전송');
  now+=3000;const heldWarning=await a.sync.sync(true);
  assert.match(String(heldWarning),/설정 1개\(.*사용자 지정 알림.*\)는 이 PC에만 보관/);
  assert.equal(a.model.pending(),0);assert.equal(a.sync.retryCount,0,'보류한 값 때문에 전송 실패/재시도로 남지 않음');
  const heldUpload=[...cloud.values()].find(file=>file.envelope.device===a.model.device)!.envelope;
  assert.ok(Object.values(heldUpload.cells).some((cell:any)=>cell.value==='보류와 함께 전송'));
  assert.ok(!Object.values(heldUpload.cells).some((cell:any)=>Array.isArray(cell.value) && cell.value.some((alert:any)=>alert?.id==='broken')));
  set(a,aid,'pinnedNoteText','보류 후 두 번째 전송');now+=3000;assert.equal(await a.sync.sync(true),undefined,'같은 보류는 다시 안내하지 않음');
  set(a,aid,'customAlerts',[]);now+=3000;await a.sync.sync(true);assert.deepEqual(a.model.meta('heldCells',null),[]);
  const itemId='sync-upgrade-progress',rule={type:'daily',hour:6};
  const homework=b.store.homework(bid);
  homework.push({id:itemId,name:'숙제 복구',category:'일일',resetRule:rule,isCustom:true,completedState:{[bid]:{currentCount:1,isCompleted:true,lastCompletedAt:now}}});
  set(b,bid,'contentsCheckerItems',homework);await exchange(b,a);
  const progressKey=JSON.stringify(['homework',rid,itemId,'progress']);
  const today=b.model.envelope().cells[progressKey];assert.ok(today);
  const legacyZero={...today,clock:{utcMs:now,source:'unverified',uncertaintyMs:null},device:'legacy-writer',sequence:1,context:{},
    value:{cycle:profileSyncResetCycle(rule,now),state:{currentCount:0,isCompleted:false}}};
  const materialized=a.model.meta('materialized',{});materialized[progressKey]=legacyZero.value;
  a.model.setMeta('materialized',materialized);a.model.setMeta('homeworkProgressReconciled',false);
  a.store.database.prepare('UPDATE profile_sync_cells SET heads=? WHERE key=?').run(JSON.stringify([legacyZero]),progressKey);
  a.store.database.prepare('UPDATE profile_homework SET state=? WHERE profile_id=? AND item_id=?').run(JSON.stringify(legacyZero.value.state),aid,itemId);
  const cachedBefore={downloads,uploads,applies:a.state.applies};now+=3000;await a.sync.sync(true);
  assert.equal(a.store.homework(aid).find((item:any)=>item.id===itemId).completedState[aid].currentCount,1,'업데이트 후 파일이 바뀌지 않아도 기존 진행 복구');
  assert.equal(a.sync.details().reviews.length,0);assert.equal(downloads,cachedBefore.downloads);assert.equal(uploads,cachedBefore.uploads);
  now+=3000;await a.sync.sync(true);assert.equal(a.state.applies,cachedBefore.applies+1,'기존 숙제 복구는 한 번만 적용');
  const correctedTime=now;
  now+=86_400_000;
  const cfg=a.store.project(aid,DEFAULT_CONFIG);
  cfg.contentsCheckerItems=built('modules/contentsChecker').resetExpiredHomeworkItems(cfg.contentsCheckerItems,now).items;
  a.store.saveProjection(aid,cfg);
  assert.equal(a.store.homework(aid).find((item:any)=>item.id===itemId).completedState[aid].currentCount,0);
  now=correctedTime+3000;await a.sync.sync(true);
  assert.equal(a.store.homework(aid).find((item:any)=>item.id===itemId).completedState[aid].currentCount,1,'시계가 앞섰다가 인터넷 보정된 경우 파일 변경 없이도 복구');
  assert.equal(downloads,cachedBefore.downloads);assert.equal(uploads,cachedBefore.uploads);
  const aTime=now,nextCycle=profileSyncResetCycle(rule,now)+86_400_000;
  now=nextCycle+10_000;
  const future=b.store.homework(bid),futureItem=future.find((item:any)=>item.id===itemId);
  futureItem.maxCount=2;futureItem.completedState[bid]={currentCount:2,isCompleted:true,lastCompletedAt:now};
  set(b,bid,'contentsCheckerItems',future);await b.sync.sync(true);
  now=aTime+3000;await a.sync.sync(true);
  assert.equal(a.store.homework(aid).find((item:any)=>item.id===itemId).completedState[aid].currentCount,1,'아직 시작하지 않은 주기의 진행은 보류하고 현재 주기를 유지');
  const downloadsBeforeBoundary=downloads;
  now=nextCycle+20_000;await a.sync.sync(true);
  assert.equal(a.store.homework(aid).find((item:any)=>item.id===itemId).completedState[aid].currentCount,2,'뒤처진 시계가 보정되어 주기가 시작하면 보존된 진행을 표시');
  assert.equal(downloads,downloadsBeforeBoundary,'리셋 경계에서 본문 재요청 없음');
  set(a,aid,'pinnedNoteText','오프라인 A');set(b,bid,'pinnedNoteText','오프라인 B');await exchange(a,b);
  assert.equal(a.sync.details().reviews.length,1);assert.equal(b.sync.details().reviews.length,1);
  const review=b.sync.details().reviews[0];await b.sync.resolve(review.key,'local');await exchange(b,a);
  assert.equal(a.store.setting(aid,'pinnedNoteText'),'오프라인 B');assert.equal(a.sync.details().reviews.length,0);
  // 활동 중 3초/최대10초, 휴식 자동30초/최대60초. 실제 timer가 호출하는 진입점을 가상 시간으로 실행.
  a.sync.activityChanged(true);await a.sync.runDueWork();now+=3000;await a.sync.sync(true);
  let count=uploads;set(a,aid,'pinnedNoteText','debounce1');now+=2999;await a.sync.runDueWork();assert.equal(uploads,count);now++;await a.sync.runDueWork();assert.equal(uploads,count+1);
  count=uploads;for(let i=0;i<6;i++){set(a,aid,'pinnedNoteText',`burst${i}`);now+=2000;await a.sync.runDueWork();}
  assert.ok(uploads>count,'연속 입력에도 최대 대기 후 전송');
  await a.sync.sync(true);a.sync.activityChanged(false);await a.sync.runDueWork();count=uploads;
  a.store.withAutomaticSyncChange(()=>set(a,aid,'pinnedNoteText','자동 대역'));now+=29_999;await a.sync.runDueWork();assert.equal(uploads,count);now++;await a.sync.runDueWork();assert.equal(uploads,count+1);
  const scanIdle=scans;now+=299_999;await a.sync.runDueWork();assert.equal(scans,scanIdle);now++;await a.sync.runDueWork();assert.equal(scans,scanIdle+1,'휴식 5분 확인');
  now+=2001;a.sync.activityChanged(true);await a.sync.runDueWork();assert.equal(scans,scanIdle+2,'숨김 복귀 즉시 확인');
  // 저장 직후 아직 일반 debounce가 남아 있어도 종료 전송은 동일 계정에 반영한다.
  set(a,aid,'pinnedNoteText','종료 직전 변경');
  const quitUploads=uploads;await a.sync.sync();assert.equal(uploads,quitUploads);
  a.sync.stop();await a.sync.flushForShutdown();assert.equal(uploads,quitUploads+1);assert.equal(a.model.pending(),0);
  set(a,aid,'pinnedNoteText','자동 끔 유지');a.state.auto=false;
  await a.sync.flushForShutdown();assert.equal(uploads,quitUploads+1);assert.ok(a.model.pending()>0);a.state.auto=true;
  // 종료 flush 중 다른 PC 변경이 있어도 반영하지 않고 이 PC 변경만 보낸다. 원격 변경은 다음 실행에서 받는다.
  set(b,bid,'buffTimerWarnSeconds',[33]);now+=3000;await b.sync.sync(true);
  const quit={uploads,downloads,applies:a.state.applies,cursor:a.model.meta('cursor',''),files:clone(a.model.meta('files',{}))};
  a.state.quitting=true;
  try {await a.sync.flushForShutdown();} finally {a.state.quitting=false;}
  assert.equal(uploads,quit.uploads+1,'원격 변경이 있어도 종료 전 이 PC 변경을 전송');assert.equal(a.model.pending(),0);
  assert.equal(downloads,quit.downloads,'종료 전송은 반영하지 않을 다른 PC 파일을 내려받지 않음');
  assert.equal(a.state.applies,quit.applies,'종료 중에는 원격 반영을 시도하지 않음');
  assert.equal(a.model.meta('cursor',''),quit.cursor,'반영하지 않은 원격 파일의 cursor는 확정하지 않음');
  const bFile=Object.keys(quit.files).find(id=>quit.files[id].envelope.device===b.model.device)!;
  assert.deepEqual(a.model.meta('files',{})[bFile],quit.files[bFile],'반영하지 않은 다른 PC 파일은 캐시를 갱신하지 않음');
  assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[29]);
  now+=3000;await a.sync.sync(true);
  assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[33],'다음 실행의 확인에서 미뤄 둔 원격 변경을 반영');now+=3000;
  // 종료 직전 진행 중이던 자동 확인이 종료 때문에 원격 반영에 실패해도, 그 재시도 대기가 종료 전송을 막지 않는다.
  set(b,bid,'buffTimerWarnSeconds',[35]);now+=3000;await b.sync.sync(true);
  set(a,aid,'pinnedNoteText','종료 중 자동 확인 실패');now+=3000;
  const racingUploads=uploads;
  a.state.quitting=true;
  try {
    const racing=a.sync.sync(true).catch(()=>undefined);
    await a.sync.flushForShutdown();await racing;
  } finally {a.state.quitting=false;}
  assert.ok(uploads>racingUploads,'종료 중 실패한 자동 확인 뒤에도 이 PC 변경을 전송');assert.equal(a.model.pending(),0);
  now+=60_001;await a.sync.sync(true);
  assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[35]);now+=3000;
  // 계산기 창에 작성 중인 입력이 있으면 종료 전송처럼 원격 반영만 미루고 이 PC의 변경은 전송한다.
  // 실패로 세지 않아 재시도 대기(최대 15분)가 늘지 않고, 프로필 전환 안내가 아닌 동기화 안내를 쓴다.
  set(b,bid,'buffTimerWarnSeconds',[37]);now+=3000;await b.sync.sync(true);
  set(a,aid,'pinnedNoteText','계산기 편집 중 변경');now+=3000;
  const busy={uploads,applies:a.state.applies,cursor:a.model.meta('cursor','')};
  a.state.toolBusy='버프 백과';
  await a.sync.sync(true);
  assert.equal(uploads,busy.uploads+1,'계산기 편집 중에도 이 PC의 변경은 전송');assert.equal(a.model.pending(),0);
  assert.equal(a.state.applies,busy.applies);
  assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[35],'편집 중에는 원격 변경을 반영하지 않음');
  assert.equal(a.model.meta('cursor',''),busy.cursor,'반영하지 않은 원격 변경은 확인 위치를 넘기지 않음');
  assert.equal(a.sync.retryCount,0,'편집 중 반영 보류는 실패로 세지 않음');assert.equal(a.sync.error,undefined);
  assert.match(a.sync.details().remoteDeferred,/버프 백과에서 작성 중인 내용이 있어 Google 동기화 반영/);
  assert.doesNotMatch(a.sync.details().remoteDeferred,/프로필을 전환/);
  const heldDownloads=downloads;
  now+=PROFILE_SYNC_POLICY.editorRetryMs;await a.sync.runDueWork();
  assert.equal(downloads,heldDownloads,'편집이 이어지는 동안 받은 원격 파일을 다시 내려받지 않음');
  assert.equal(a.sync.retryCount,0);assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[35]);
  a.state.toolBusy=undefined;
  now+=PROFILE_SYNC_POLICY.editorRetryMs;await a.sync.runDueWork();
  assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[37],'편집이 끝나면 짧은 간격 안에 미룬 변경을 반영');
  assert.equal(a.sync.details().remoteDeferred,undefined);assert.equal(downloads,heldDownloads,'미뤄 둔 본문으로 반영');now+=3000;
  // 4차 집중 리뷰: 자동 동기화를 끈 사용자가 수동 동기화 중 반영을 미뤄도, 편집이 끝나면 미룬 반영을 마저 끝내고 안내를 지운다.
  set(b,bid,'buffTimerWarnSeconds',[39]);now+=3000;await b.sync.sync(true);
  a.state.auto=false;a.state.toolBusy='버프 백과';
  try {
    await a.sync.sync(true);
    assert.ok(a.sync.details().remoteDeferred,'자동 동기화가 꺼져 있어도 편집 중 반영 보류를 안내');
    a.state.toolBusy=undefined;
    now+=PROFILE_SYNC_POLICY.editorRetryMs;await a.sync.runDueWork();
    assert.deepEqual(a.store.setting(aid,'buffTimerWarnSeconds'),[39],'자동 동기화가 꺼져 있어도 미룬 반영은 편집 뒤 마저 반영');
    assert.equal(a.sync.details().remoteDeferred,undefined,'반영을 마치면 보류 안내를 지움');
    const idleScans=scans;now+=PROFILE_SYNC_POLICY.editorRetryMs;await a.sync.runDueWork();
    assert.equal(scans,idleScans,'미룬 반영이 없으면 자동 동기화가 꺼진 상태를 지킴');
  } finally {a.state.auto=true;a.state.toolBusy=undefined;}
  now+=3000;
  offline=true;await assert.rejects(a.sync.sync(true),/offline fixture/);
  const offlineScans=scans;offline=false;await a.sync.runDueWork();assert.equal(scans,offlineScans);
  a.sync.networkReconnected();await a.sync.runDueWork();assert.equal(scans,offlineScans+1);assert.equal(a.model.pending(),0);
  // 서버 429는 재연결·종료·수동 재클릭에서도 Retry-After를 지킨다.
  set(a,aid,'pinnedNoteText','quota 보존');failUpload=true;await assert.rejects(a.sync.sync(true));const quotaRequests=uploads;
  a.sync.networkReconnected();await a.sync.runDueWork();await a.sync.flushForShutdown();
  await assert.rejects(a.sync.sync(true));assert.equal(uploads,quotaRequests);assert.ok(a.model.pending()>0);failUpload=false;now+=60_001;await a.sync.sync(true);assert.equal(a.model.pending(),0);
  // ACK 유실은 같은 파일 ID 재발급/중복 생성 없이 확인 후 복구.
  const fileCount=cloud.size;set(a,aid,'pinnedNoteText','ACK 유실');loseAck=true;await assert.rejects(a.sync.sync(true));assert.ok(a.model.pending()>0);
  now+=60_001;await a.sync.sync(true);assert.equal(cloud.size,fileCount);assert.equal(a.model.pending(),0);
  // 전송 중 새 로컬 저장은 과거 payload의 ACK에 소비되지 않는다.
  set(a,aid,'pinnedNoteText','전송 시작');let unblock!:()=>void,started!:()=>void;const signal=new Promise<void>(r=>started=r);
  delayUpload=()=>{started();return new Promise<void>(r=>unblock=r);};const inFlight=a.sync.sync(true);await signal;
  set(a,aid,'pinnedNoteText','전송 중 저장');unblock();await inFlight;delayUpload=undefined;assert.ok(a.model.pending()>0);now+=3000;await a.sync.sync(true);assert.equal(a.model.pending(),0);
  // 활성 프로필 이름/서버 변경은 수락하기 전 저장값/귀속을 유지한다.
  await exchange(a,b);b.store.update(bid,'이름 변경',16);now+=3000;await b.sync.sync(true);now+=3000;await a.sync.sync(true);
  assert.equal(a.store.list().find((p:any)=>p.id===aid).name,'PC-A');assert.equal(a.store.setting(aid,'userServer'),7);
  assert.ok(a.sync.details().reviews.every((r:any)=>r.reason==='playing-profile'));
  for (const r of [...a.sync.details().reviews]) {await a.sync.resolve(r.key,r.candidates[0].id);}
  assert.ok(a.state.selections>0);assert.equal(a.store.list().find((p:any)=>p.id===aid).name,'이름 변경');assert.equal(a.store.setting(aid,'userServer'),16);
  // 별도 프로필은 기존 이름/선택/설정과 무관하게 합집합.
  const extra=b.store.create('두 번째',7);await exchange(b,a);assert.equal(a.store.list().length,2);assert.equal(a.store.setting(aid,'userServer'),16);
  const x=a.store.list().find((p:any)=>p.name==='두 번째');assert.equal(x.id,extra.id);
  const oldName=JSON.stringify(['profile',rid,'name']);
  const previewPc=await pc('PC-Preview');
  const ownCloud=[...cloud.entries()];
  const damagedFile=ownCloud.find(([,entry])=>entry.envelope.device===b.model.device)![0];
  const healthyFile=ownCloud.find(([,entry])=>entry.envelope.device===a.model.device)![0];
  damaged.add(damagedFile);
  now+=3000;await previewPc.sync.sync(true);
  assert.equal(previewPc.sync.details().damagedFiles,1);
  assert.ok(previewPc.sync.details().remoteProfiles.length>0,'손상된 파일과 별개로 정상 파일을 읽는다');
  await assert.rejects(previewPc.sync.choose('remote'),/읽을 수 없는/);
  assert.equal(previewPc.state.backups,0);
  await previewPc.sync.choose('merge');
  await previewPc.sync.sync(true);
  assert.equal(previewPc.model.pending(),0,'다른 기기의 파일 손상 중에도 이 PC의 변경 전송');
  damaged.delete(damagedFile);
  now+=3000;await previewPc.sync.sync(true);
  assert.equal(previewPc.sync.details().damagedFiles,0,'같은 버전도 수동 동기화로 재확인');
  const localFileId=previewPc.model.meta('ownFile',null);
  const own=cloud.get(localFileId)!;
  damaged.add(localFileId);
  own.at=++revision;own.file.version=String(revision);own.file.md5Checksum=String(revision);
  set(previewPc,previewPc.store.list().find((profile:any)=>profile.name==='PC-Preview').id,'pinnedNoteText','손상 중 로컬 저장');
  const beforeDamageUpload=uploads,beforeDamageCheck=previewPc.sync.details();
  assert.ok(beforeDamageCheck.lastUploadedAt);
  now+=3000;await previewPc.sync.sync(true);
  assert.equal(uploads,beforeDamageUpload,'자기 기기의 손상 파일도 덮어쓰지 않는다');
  assert.ok(previewPc.model.pending()>0);
  const blocked=previewPc.sync.details();
  assert.equal(blocked.connection,'ready');assert.equal(blocked.uploadBlocked,true);
  assert.equal(blocked.lastCheckedAt,now);assert.equal(blocked.lastUploadedAt,beforeDamageCheck.lastUploadedAt);
  damaged.delete(localFileId);
  now+=3000;await previewPc.sync.sync(true);
  assert.equal(previewPc.model.pending(),0,'자기 파일이 다시 읽히면 대기한 변경을 보낸다');
  assert.equal(previewPc.sync.details().uploadBlocked,false);assert.equal(previewPc.sync.details().lastUploadedAt,now);

  const cached=clone(ownCloud.find(([id])=>id===healthyFile)![1]);
  const importPc=await pc('PC-Import');
  const sibling=clone(cached);
  const aName=cached.envelope.cells[oldName];
  sibling.envelope.device='PC-Sibling';
  sibling.envelope.cells={[oldName]:{...aName,device:'PC-Sibling',value:'이전 이름',context:{},clock:{source:'unverified',utcMs:now,uncertaintyMs:null}}};
  const current={...aName,context:{...aName.context,'PC-Sibling':aName.sequence}};
  cached.envelope.cells[oldName]=current;
  importPc.model.setMeta('files',{current:cached,older:sibling});
  importPc.model.setMeta('awaitingChoice',true);
  importPc.model.setMeta('stagedAccount',importPc.state.account);
  assert.equal(importPc.sync.details().remoteProfiles.find((p:any)=>p.id===rid)?.name,current.value);
  importPc.model.setMeta('files',{older:sibling,current:cached});
  assert.equal(importPc.sync.details().remoteProfiles.find((p:any)=>p.id===rid)?.name,current.value);
  const serverKey=JSON.stringify(['setting',rid,'userServer']);
  const aServer=cached.envelope.cells[serverKey];
  assert.ok(aServer);
  sibling.envelope.cells[serverKey]={...aServer,device:'PC-Sibling',value:aServer.value===7 ? 16 : 7,context:{},
    clock:{source:'unverified',utcMs:now,uncertaintyMs:null}};
  sibling.envelope.sequence=Math.max(sibling.envelope.sequence,aServer.sequence);
  cached.envelope.cells[serverKey]={...aServer,context:{},clock:{source:'unverified',utcMs:now,uncertaintyMs:null}};
  cached.envelope.cells[oldName]={...aName,context:{},clock:{source:'unverified',utcMs:now,uncertaintyMs:null}};
  importPc.model.setMeta('files',{current:cached,older:sibling});
  assert.equal(importPc.sync.details().remoteIdentityConflicts,1);
  const localBefore=importPc.store.list();
  await assert.rejects(importPc.sync.choose('remote'),/이름 또는 서버/);
  assert.deepEqual(importPc.store.list(),localBefore);
  assert.equal(importPc.state.backups,0);
  await importPc.sync.choose('merge');
  assert.ok(importPc.store.list().some((profile:any)=>profile.id===localBefore[0].id));
  for(const key of [oldName,serverKey]) {
    const review=importPc.sync.details().reviews.find((item:any)=>item.key===key);
    assert.ok(review,'교체를 막았던 후보는 병합 후 선택할 수 있다');
    await importPc.sync.resolve(key,review.candidates[0].id);
  }
  assert.ok(localSyncProfileId(importPc.model.db,rid),'이름과 서버를 선택하면 원격 프로필이 표시된다');

  invalidRetryAfter=true;now+=3000;await assert.rejects(previewPc.sync.sync(true),/invalid retry header/);
  const limitedScans=scans;
  invalidRetryAfter=false;now+=600_000;await previewPc.sync.runDueWork();
  assert.ok(scans>limitedScans,'유효하지 않은 제한 헤더 이후에도 자동 재시도한다');
  // DB 백업 복원으로 기기 순번이 되돌아가도 기존 파일 덮어쓰기 대신 선택/새 writer 세대.
  const rollback=path.join(fixture,'rollback.db');await a.store.database.backup(rollback);
  set(a,aid,'pinnedNoteText','원격 최신');now+=3000;await a.sync.sync(true);a.store.close();
  fs.copyFileSync(rollback,a.store.filePath);for(const suffix of ['-wal','-shm']) if(fs.existsSync(a.store.filePath+suffix)) fs.unlinkSync(a.store.filePath+suffix);a.store.reopen();
  now+=3000;await a.sync.sync(true);assert.equal(a.sync.details().connection,'choice');const writer=a.model.device;
  await a.sync.choose('merge');assert.notEqual(a.model.device,writer);assert.ok(a.sync.details().reviews.length>0,'복원된 과거 값과 원격 최신 후보를 보존');
  // 전체 DB를 다른 PC에 복원해도 원본 PC 파일을 덮어쓰거나 ACK 때문에 저장을 누락하지 않는다.
  const crossBackup=path.join(fixture,'cross-pc.db');await a.store.database.backup(crossBackup);
  const cross=await pc('PC-Restored',true);cross.store.close();fs.copyFileSync(crossBackup,cross.store.filePath);cross.store.reopen();
  const sourceFiles=clone([...cloud.entries()]),beforeCross=uploads;assert.ok(cross.model.pending()>0);
  now+=3000;await cross.sync.sync(true);assert.equal(cross.sync.details().connection,'choice');assert.equal(uploads,beforeCross);
  await cross.sync.choose('merge');now+=3000;await cross.sync.sync(true);assert.equal(cross.model.pending(),0);
  for (const [fileId,body] of sourceFiles) assert.deepEqual(cloud.get(fileId),body,'원본 PC/다른 PC 파일은 보존');
  assert.ok([...cloud.values()].some(file=>file.envelope.device===cross.model.device));
  // 계정 변경은 새 계정이 비어 있어도 명시적으로 선택하기 전 업로드 금지.
  const beforeSwitch=uploads;a.state.account='other@example.invalid';cloud.clear();revision++;now+=3000;await a.sync.sync(true);
  assert.equal(a.sync.details().connection,'choice');assert.equal(uploads,beforeSwitch);
  await a.sync.choose('local');assert.equal(a.model.meta('localOnly',false),true);
  // 다른 PC 백업에서 계정 캐시는 비우더라도 원래 계정 힌트로 빈 새 계정 자동 전송을 막는다.
  cross.store.close();fs.copyFileSync(crossBackup,cross.store.filePath);cross.store.reopen();cross.state.account='new-empty@example.invalid';
  now+=3000;await cross.sync.sync(true);assert.equal(cross.sync.details().connection,'choice');assert.equal(uploads,beforeSwitch);
  // 이미 ACK된 원본도 빈 새 계정에서 명시적으로 병합하면 첫 파일을 보낸다.
  const mover=await pc('PC-Account-Change');
  const moverId=mover.store.list()[0].id;
  mover.state.account='old-uploader@example.invalid';cloud.clear();revision++;now+=3000;
  await mover.sync.sync(true);await mover.sync.choose('merge');await mover.sync.sync(true);
  assert.equal(mover.model.pending(),0);
  const previousWriter=mover.model.device;
  mover.state.account='empty-target@example.invalid';cloud.clear();revision++;now+=3000;
  await mover.sync.sync(true);assert.equal(mover.sync.details().connection,'choice');assert.equal(cloud.size,0);
  await mover.sync.choose('merge');assert.ok(mover.model.pending()>0);
  await mover.sync.sync(true);assert.equal(cloud.size,1);assert.equal(mover.model.pending(),0);
  assert.notEqual(mover.model.device,previousWriter);
  const moveFile=[...cloud.values()][0].envelope;
  assert.ok(Object.values(moveFile.cells).some((cell:any)=>cell.value==='PC-Account-Change'));
  assert.ok(Object.values(moveFile.cells).every((cell:any)=>!(previousWriter in cell.context)));
  assert.equal(mover.store.list()[0].id,moverId);
  // 계정 A → B → A에서 같은 원격 ID와 로컬 기록의 귀속을 복원한다.
  const returning=await pc('PC-Account-Return',true);
  const accountA=await pc('PC-Account-A'),accountB=await pc('PC-Account-B');
  const sourceA=accountA.store.list()[0].id;
  set(accountA,sourceA,'pinnedNoteText','A 계정 설정');
  async function stageAccount(source:any,email:string):Promise<void> {
    cloud.clear();
    const envelope=source.model.envelope();
    const version=String(++revision),id=`account-file-${envelope.device}`;
    cloud.set(id,{file:{id,name:`tw_overlay_profiles_${envelope.device}.json`,version,md5Checksum:version,
      appProperties:{twProfileSync:'1',device:envelope.device}},envelope,at:revision});
    returning.state.account=email;
    now+=3000;await returning.sync.sync(true);
    assert.equal(returning.sync.details().connection,'choice');
  }
  await stageAccount(accountA,'account-a@example.invalid');await returning.sync.choose('remote');
  const localA=returning.store.list()[0].id;
  returning.store.database.exec('CREATE TABLE fixture_diary (profile_id TEXT NOT NULL REFERENCES play_profiles(id))');
  returning.store.database.prepare('INSERT INTO fixture_diary VALUES (?)').run(localA);
  returning.store.enqueue('pending-import',{kind:'fixture'},now,'protected-import-record',localA);
  await stageAccount(accountB,'account-b@example.invalid');
  await assert.rejects(returning.sync.choose('remote'),/대기 기록을 먼저/);
  assert.deepEqual(returning.store.list().map((p:any)=>p.id),[localA]);
  assert.equal(returning.store.pending('pending-import').length,1);
  returning.store.ignorePendingSession('pending-import',returning.store.pendingSessionSnapshot('pending-import').token);
  await returning.sync.choose('remote');
  const localB=returning.store.list()[0].id;
  assert.notEqual(localB,localA);
  assert.ok(returning.model.meta('excludedProfiles',[]).includes(localA));
  await stageAccount(accountA,'account-a@example.invalid');await returning.sync.choose('remote');
  assert.deepEqual(returning.store.list().map((p:any)=>p.id),[localA]);
  assert.equal(returning.store.setting(localA,'pinnedNoteText'),'A 계정 설정');
  assert.equal(returning.store.database.prepare('SELECT profile_id FROM fixture_diary').get().profile_id,localA);
  assert.ok(!returning.model.meta('excludedProfiles',[]).includes(localA));

  returning.store.create('삭제 후에도 남아 있는 로컬 프로필',7);
  returning.store.remove(localA);
  await stageAccount(accountB,'account-b@example.invalid');await returning.sync.choose('remote');
  assert.deepEqual(returning.store.list().map((p:any)=>p.id),[localB]);
  await stageAccount(accountA,'account-a@example.invalid');
  await assert.rejects(returning.sync.choose('remote'),/모두 복원하지 못/);
  assert.deepEqual(returning.store.list().map((p:any)=>p.id),[localB],'실제 삭제는 복구하지 않고 교체를 롤백');
  // A의 Retry-After 중 B는 즉시 조회하며, A로 돌아오면 남은 시간만큼 기다린다.
  returning.state.account='rate-limited@example.invalid';
  retryScanMs=60_000;await assert.rejects(returning.sync.sync(true),/account quota fixture/);retryScanMs=0;
  assert.equal(returning.sync.retryCount,1);
  const beforeAccountSwitch=scans;
  await stageAccount(accountB,'fresh-rate-test@example.invalid');
  assert.ok(scans>beforeAccountSwitch);
  assert.equal(returning.sync.retryCount,0);
  returning.state.account='rate-limited@example.invalid';returning.state.auto=false;
  const scansBeforeReturn=scans;
  await assert.rejects(returning.sync.sync(true),/지금 동기화/);
  assert.equal(scans,scansBeforeReturn);
  now+=60_000;await returning.sync.sync(true);
  assert.ok(scans>scansBeforeReturn);
  // 로그아웃 전 조회의 늦은 실패로 새 계정의 첫 수동 확인이 취소되지 않는다.
  returning.state.account='late-old-account@example.invalid';
  let releaseScan!:()=>void;
  delayScan=()=>new Promise<void>(resolve=>{releaseScan=resolve;});
  const cancelled=assert.rejects(returning.sync.sync(true),/취소/);
  returning.sync.cancel();
  returning.state.account='next-account@example.invalid';
  const checking=returning.sync.sync(true);
  delayScan=undefined;releaseScan();
  await Promise.all([cancelled,checking]);
  assert.equal(returning.sync.details().connection,'choice');
  const budget=await pc('PC-Wire-Budget');
  cloud.clear();revision++;budget.state.account='wire-budget@example.invalid';
  await budget.sync.sync(true);await budget.sync.choose('merge');
  const toolKey='tw-coefficient-calculator-profiles-v1';
  const ids=[budget.store.list()[0].id,budget.store.create('큰 프리셋 2',7).id,budget.store.create('큰 프리셋 3',7).id];
  for (const [index,id] of ids.entries()) budget.store.saveToolValue(id,toolKey,String.fromCharCode(0xac00+index).repeat(2*1024*1024));
  set(budget,ids[0],'pinnedNoteText','큰 프리셋과 함께 보낸 일반 메모');
  const budgetTask={id:'budget-test-task',name:'용량 검수용 숙제',category:'일일',isCustom:true,resetRule:{type:'daily',hour:6},completedState:{}};
  set(budget,ids[0],'contentsCheckerItems',[budgetTask]);
  assert.equal(budget.model.oversizedToolCount(),0,'개별 값은 허용 범위');
  loseAck=true;now+=3000;await assert.rejects(budget.sync.sync(true),/upload response lost/);
  const accepted=[...cloud.values()].find(file=>file.envelope.device===budget.model.device)!.envelope;
  assert.ok(Buffer.byteLength(JSON.stringify(accepted))<=16*1024*1024,'JSON UTF-8 전체 한도를 지킨다');
  assert.ok(Object.values(accepted.cells).some((cell:any)=>cell.value==='큰 프리셋과 함께 보낸 일반 메모'));
  assert.ok(Object.keys(accepted.cells).some(k=>JSON.parse(k)[0]==='homework'));
  const omitted=Object.keys(budget.model.envelope().cells).find(k=>JSON.parse(k)[0]==='tool' && !Object.prototype.hasOwnProperty.call(accepted.cells,k))!;
  assert.ok(omitted);
  now+=3000;await budget.sync.sync(true);
  const sizing=budget.sync.details().uploadSizing;
  assert.equal(sizing.deferredTools,1,'응답 유실 후 다시 받은 파일도 생략한 값을 전송 완료로 표시하지 않는다');
  assert.ok(sizing.fullBytes>16*1024*1024);
  assert.match(sizing.deferredLabels[0],/계수 계산 프리셋/);
  const budgetPeer=await pc('PC-Wire-Budget-Receiver',true);
  budgetPeer.state.account=budget.state.account;
  await budgetPeer.sync.sync(true);await budgetPeer.sync.choose('remote');
  const memoKey=Object.keys(accepted.cells).find(k=>accepted.cells[k].value==='큰 프리셋과 함께 보낸 일반 메모')!;
  const peerId=localSyncProfileId(budgetPeer.model.db,JSON.parse(memoKey)[1]);
  assert.equal(budgetPeer.store.setting(peerId,'pinnedNoteText'),'큰 프리셋과 함께 보낸 일반 메모');
  assert.equal(budgetPeer.store.homework(peerId).some((item:any)=>item.id===budgetTask.id),true);
  const omittedLocal=localSyncProfileId(budget.model.db,JSON.parse(omitted)[1]);
  assert.equal(budget.store.toolValues(omittedLocal)[toolKey].length,2*1024*1024);
  const uploadAfterAck=uploads;now+=3000;await budget.sync.sync(true);assert.equal(uploads,uploadAfterAck,'같은 부분 파일을 계속 다시 올리지 않는다');
  budget.store.saveToolValue(omittedLocal,toolKey,'크기를 줄인 값');
  now+=3000;await budget.sync.sync(true);
  assert.equal(budget.sync.details().uploadSizing.deferredTools,0);
  const complete=[...cloud.values()].find(file=>file.envelope.device===budget.model.device)!.envelope;
  const preserved=budget.store.create('기존에 동기화한 추가 프리셋',7).id;
  budget.store.saveToolValue(preserved,toolKey,'저'.repeat(900_000));
  now+=3000;await budget.sync.sync(true);
  const previous:{cells:Record<string,{value:unknown}>}=[...cloud.values()].find(file=>file.envelope.device===budget.model.device)!.envelope;
  const priorPublished=Object.entries(previous.cells).filter(([k,cell])=>JSON.parse(k)[0]==='tool' && cell.value!==null);
  assert.equal(priorPublished.length,4);
  budget.store.saveToolValue(omittedLocal,toolKey,'큰'.repeat(2*1024*1024));
  now+=3000;await budget.sync.sync(true);
  const replacement=[...cloud.values()].find(file=>file.envelope.device===budget.model.device)!.envelope;
  for (const [k,cell] of priorPublished) assert.deepEqual(replacement.cells[k],cell,'크기를 늘린 값보다 기존 공개 값을 보존한다.');
  const freshBudgetPeer=await pc('PC-Published-Budget-Receiver',true);
  freshBudgetPeer.state.account=budget.state.account;
  await freshBudgetPeer.sync.sync(true);await freshBudgetPeer.sync.choose('remote');
  for (const [k,cell] of priorPublished) {
    const [,remoteId,field]=JSON.parse(k);
    const id=localSyncProfileId(freshBudgetPeer.model.db,remoteId);
    assert.equal(freshBudgetPeer.store.toolValues(id)[field],cell.value);
  }
  assert.equal(complete.cells[omitted].value,'크기를 줄인 값');
  cloud.clear();
  const receiver=await pc('PC-Settings-Receiver'),sender=await pc('PC-Settings-Sender',true);
  await receiver.sync.sync(true);
  await receiver.sync.choose('merge');
  await receiver.sync.sync(true);
  await sender.sync.sync(true);
  await sender.sync.choose('remote');
  const edited=receiver.store.list()[0].id;
  receiver.state.settings=edited;
  receiver.state.dirtyEditor=true;
  sender.store.create('Other profile',7);
  sender.store.remove(sender.store.list().find((profile:any)=>profile.name==='PC-Settings-Receiver').id);
  now+=3000;await sender.sync.sync(true);
  now+=3000;await receiver.sync.sync(true);
  const deletion=receiver.sync.details().reviews.find((review:any)=>review.reason==='settings-profile');
  assert.ok(deletion,'선택 대기 중 설정에 표시된 프로필도 원격 삭제 확인 대상이다.');
  assert.ok(receiver.store.list().some((profile:any)=>profile.id===edited));
  await assert.rejects(receiver.sync.resolve(deletion.key,deletion.candidates[0].id),/dirty profile editor/);
  assert.ok(receiver.store.list().some((profile:any)=>profile.id===edited));
  receiver.state.settings=undefined;
  assert.ok(receiver.sync.details().reviews.some((review:any)=>review.key===deletion.key),'설정 대상이 바뀌어도 보류한 삭제 요청을 확인할 수 있다.');
  receiver.state.dirtyEditor=false;
  await receiver.sync.resolve(deletion.key,deletion.candidates[0].id);
  assert.ok(!receiver.store.list().some((profile:any)=>profile.id===edited));
  await checkUnconnectedChangeLog();
  await checkBackupRetention();
  console.log(`PASS profile sync coordinator: two PCs, draft-safe deletion, initial choices, independent selection, field merge, conflict resolution, active identity review, debounce/idle/restore, quota, ACK loss, in-flight save, database restore/account isolation/reactivation (${scans} checks, ${uploads} uploads)`);
}
/** 동기화를 연결하지 않은 PC의 변경 이력은 항목별 최신 행만 남는다. 이전 버전이 쌓은 이력도 다시 열 때 줄인다.
 * 나중에 처음 연결해도 최신 값과 숙제 삭제를 빠짐없이 전송한다(전송은 이력을 재생하지 않고 원본 snapshot을 쓴다). */
async function checkUnconnectedChangeLog():Promise<void> {
  cloud.clear();
  const offline=await pc('PC-Unconnected');offline.state.enabled=false;
  const id=offline.store.list()[0].id,db=()=>offline.store.database;
  const count=(where='1=1',...args:unknown[])=>db().prepare(`SELECT COUNT(*) n FROM profile_change_log WHERE ${where}`).get(...args).n;
  for (let n=0;n<40;n++) {now+=1000;set(offline,id,'pinnedNoteText',`연결 전 메모 ${n}`);}
  assert.equal(count("profile_id=? AND scope='profile' AND field='pinnedNoteText'",id),1,'같은 설정을 여러 번 바꿔도 이력은 최신 행 하나');
  const removed='offline-task',cfg=offline.store.project(id,DEFAULT_CONFIG);
  cfg.contentsCheckerItems=[...cfg.contentsCheckerItems,{id:removed,name:'연결 전 숙제',category:'일일',isCustom:true,resetRule:{type:'daily',hour:6},completedState:{}}];
  offline.store.saveProjection(id,cfg);assert.ok(offline.store.homework(id).some((item:any)=>item.id===removed));
  cfg.contentsCheckerItems=cfg.contentsCheckerItems.filter((item:any)=>item.id!==removed);offline.store.saveProjection(id,cfg);
  assert.ok(!offline.store.homework(id).some((item:any)=>item.id===removed));
  // 이전 버전이 남긴 이력: 같은 항목의 행이 쌓여 있고, 숙제 삭제 행 뒤에 같은 숙제의 다른 행이 있다.
  db().prepare("DELETE FROM app_meta WHERE key='profile_change_history_compacted'").run();
  const insert=db().prepare('INSERT INTO profile_change_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  let legacySequence=0;const legacyRow=(scope:string,field:string,operation:string,value:unknown)=>insert.run(`legacy-${++legacySequence}`,'PC-Restored',legacySequence,id,scope,field,operation,JSON.stringify(value),now,'unverified',null,0);
  for (let n=0;n<30;n++) legacyRow('profile','xpAutoStart','set',n%2===0);
  legacyRow('homework','legacy-removed','delete',null);legacyRow('homework','legacy-removed','set',{definition:{}});
  const beforeReopen=count();
  offline.store.close();offline.store.reopen();
  assert.equal(count("scope='profile' AND field='xpAutoStart'"),1,'이전 버전이 쌓은 같은 항목 이력도 최신 행만 남김');
  assert.ok(count()<beforeReopen-29);
  assert.equal(db().prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM profile_change_log GROUP BY scope,profile_id,field HAVING COUNT(*)>1)').get().n,0);
  assert.ok(db().prepare("SELECT 1 FROM profile_homework_deleted_items WHERE profile_id=? AND item_id='legacy-removed'").get(id),
    '압축으로 지운 숙제 삭제 행은 영구 표식으로 먼저 옮김');
  offline.store.ensureDefaultHomework();
  assert.ok(!offline.store.homework(id).some((item:any)=>item.id===removed),'압축 뒤에도 삭제한 숙제를 되살리지 않음');
  // 처음 연결: 최신 메모와 숙제 삭제를 모두 전송하고 다른 PC가 그대로 받는다.
  offline.state.enabled=true;now+=3000;await offline.sync.sync(true);
  assert.equal(offline.sync.details().connection,'choice');
  await offline.sync.choose('merge');now+=3000;await offline.sync.sync(true);assert.equal(offline.model.pending(),0);
  const published=[...cloud.values()].find(file=>file.envelope.device===offline.model.device)!.envelope;
  const rid=JSON.parse(Object.keys(published.cells).find(k=>JSON.parse(k)[0]==='profile')!)[1];
  assert.equal(published.cells[JSON.stringify(['setting',rid,'pinnedNoteText'])].value,'연결 전 메모 39','압축한 이력과 무관하게 최신 값을 전송');
  assert.equal(published.cells[JSON.stringify(['homework',rid,removed,'deleted'])]?.value,true,'연결 전에 지운 숙제의 삭제를 전송');
  const peer=await pc('PC-Unconnected-Peer',true);
  now+=3000;await peer.sync.sync(true);await peer.sync.choose('remote');
  const peerId=localSyncProfileId(peer.model.db,rid);
  assert.equal(peer.store.setting(peerId,'pinnedNoteText'),'연결 전 메모 39');
  assert.ok(!peer.store.homework(peerId).some((item:any)=>item.id===removed));
  assert.ok(count()<=db().prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM profile_change_log GROUP BY scope,profile_id,field)').get().n);
}

/** 연결 전 백업은 최근 몇 개와 설정 화면이 가리키는 백업만 남긴다. 강제 종료로 남은 작업 폴더는 다음 백업 때 지운다.
 * 정확한 이름 형식이 아닌 파일·폴더는 건드리지 않는다. */
async function checkBackupRetention():Promise<void> {
  const backup=built('modules/profileSyncBackup');
  const userData=path.join(fixture,'backup-retention'),root=path.join(userData,'backups');fs.mkdirSync(root,{recursive:true});
  const file=(name:string,ageMs:number)=>{
    const target=path.join(root,name);fs.writeFileSync(target,'fixture');const at=new Date(actualNow()-ageMs);fs.utimesSync(target,at,at);return target;
  };
  const referenced=file('before-google-profile-sync-Ref001.zip',10*86_400_000);
  const older=[1,2,3,4].map(n=>file(`before-google-profile-sync-Old00${n}.zip`,n*3_600_000));
  const unrelated=[file('before-google-profile-sync-notes.txt',20*86_400_000),file('before-play-profiles-keep.zip',20*86_400_000)];
  const stale=path.join(root,'.before-google-profile-sync-Stale1');fs.mkdirSync(stale);fs.writeFileSync(path.join(stale,'database.sqlite'),'partial');
  const otherDir=path.join(root,'.before-google-profile-sync-keep-me');fs.mkdirSync(otherDir);
  const source=await pc('PC-Backup-Retention');
  const created=await backup.createProfileSyncBackup(source.store.database,userData,'fixture',(error:unknown)=>{throw error;});
  assert.equal(fs.existsSync(stale),false,'강제 종료로 남은 연결 전 백업 작업 폴더를 정리');
  assert.equal(fs.existsSync(otherDir),true,'이름 형식이 다른 폴더는 지우지 않음');
  assert.equal(await backup.pruneProfileSyncBackups(userData,[referenced,created]),2);
  const left=fs.readdirSync(root).filter(name=>/^before-google-profile-sync-[A-Za-z0-9]{6}\.zip$/.test(name)).sort();
  assert.deepEqual(left,[path.basename(created),...older.slice(0,2).map(f=>path.basename(f)),path.basename(referenced)].sort(),
    `최근 ${backup.PROFILE_SYNC_BACKUP_LIMIT}개와 설정 화면이 가리키는 백업만 남김`);
  for (const target of unrelated) assert.equal(fs.existsSync(target),true,'다른 백업과 파일은 지우지 않음');
  fs.mkdirSync(stale);
  assert.equal(await backup.removeStaleProfileSyncBackupStages(userData),1,'앱 시작 때도 남은 작업 폴더를 정리');
  assert.equal(fs.existsSync(otherDir),true);
}
run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);}).finally(()=>{Date.now=actualNow;for(const store of all) store.close();});
