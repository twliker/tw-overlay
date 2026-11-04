/** 실제 두 SQLite 저장소 + 운영 coordinator. HTTP leaf만 메모리 Drive로 교체한다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {app} from 'electron';
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-sync-'));app.setPath('userData',fixture);
const root=path.resolve(__dirname,'..');const built=(p:string)=>require(path.join(root,'dist',p));
const {ApplicationData}=built('modules/applicationData'),{DEFAULT_CONFIG}=built('modules/constants');
const {ProfileSyncModel,localSyncProfileId}=built('modules/profileSyncModel'),{ProfileSyncCoordinator}=built('modules/profileSyncCoordinator');
const {ProfileDriveError}=built('modules/profileSyncDrive');
let now=Date.now();const actualNow=Date.now;Date.now=()=>now;
const clone=<T>(v:T):T=>structuredClone(v);
const cloud=new Map<string,{file:any;envelope:any;at:number}>();let revision=0,allocated=0;
let uploads=0,scans=0,downloads=0,failUpload=false,loseAck=false,delayUpload:(()=>Promise<void>) | undefined;
const transport=()=>({
  cancel(){},async allocate(){return `file-${++allocated}`;},
  async scan(cursor?:string){scans++;return {files:[...cloud.values()].filter(v=>!cursor || v.at>Number(cursor)).map(v=>clone(v.file)),removed:[],cursor:String(revision),full:!cursor};},
  async download(file:any){downloads++;return clone(cloud.get(file.id)!.envelope);},
  async upload(id:string,envelope:any,exists:boolean){
    uploads++;if(failUpload) throw new ProfileDriveError('quota fixture',429,60_000);
    if(delayUpload) await delayUpload();
    assert.equal(exists,cloud.has(id),'기존 파일에 조건부 갱신, 신규 파일에 지정 ID 생성');
    const prior=cloud.get(id);if(prior) assert.equal(prior.envelope.device,envelope.device,'타 PC 파일은 쓰지 않음');
    const version=String(++revision);cloud.set(id,{file:{id,name:`tw_overlay_profiles_${envelope.device}.json`,version,md5Checksum:version,
      appProperties:{twProfileSync:'1',device:envelope.device}},envelope:clone(envelope),at:revision});
    if(loseAck) {loseAck=false;throw new Error('upload response lost');}
  },
});
const all:any[]=[];
async function pc(name:string,empty=false):Promise<any> {
  const directory=path.join(fixture,name);fs.mkdirSync(directory);
  const legacy={...clone(DEFAULT_CONFIG),userServer:7,characterPresets:empty ? [] : [{id:'char',name}],selectedCharacterId:empty ? undefined : 'char'};
  fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(empty ? {} : legacy));
  const store=await ApplicationData.initialize({directory,deviceId:name,defaults:DEFAULT_CONFIG,clock:()=>({utcMs:now,source:'unverified',uncertaintyMs:null})},legacy,{value:empty ? undefined : 7});
  const state={account:'test@example.invalid',enabled:true,auto:true,active:undefined as string | undefined,backups:0,applies:0,selections:0,ready:true};
  const model=new ProfileSyncModel(()=>store.database,name,()=>({utcMs:now,source:'unverified',uncertaintyMs:null}));
  const sync=new ProfileSyncCoordinator(model,transport(),{
    account:()=>state.account,enabled:()=>state.enabled,auto:()=>state.auto,activeProfile:()=>state.active,ready:()=>state.ready,
    async beforeImport(){state.backups++;model.setMeta('backupAvailable',true);},
    async apply(action:()=>void,selection=false){state.applies++;if(selection){state.selections++;state.active=undefined;}action();store.ensureEmptyProfile();},changed(){},
  },()=>now,()=>0.5);all.push(store);return {store,model,sync,state};
}
function set(p:any,id:string,k:string,v:unknown):void {const cfg=p.store.project(id,DEFAULT_CONFIG);cfg[k]=v;p.store.saveProjection(id,cfg);}
async function exchange(a:any,b:any):Promise<void> {now+=3000;await a.sync.sync(true);now+=3000;await b.sync.sync(true);now+=3000;await a.sync.sync(true);}
async function run():Promise<void> {
  await app.whenReady();const a=await pc('PC-A'),b=await pc('PC-B',true);const aid=a.store.list()[0].id;
  await a.sync.sync(true);assert.equal(a.model.pending(),0);assert.equal(uploads,1);
  await b.sync.sync(true);assert.equal(b.sync.details().connection,'choice');assert.equal(uploads,1,'첫 연결 선택 전 업로드 없음');
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
  // 서버 429는 수동 재클릭도 Retry-After를 지킨다. 로컬 저장과 pending은 유지.
  set(a,aid,'pinnedNoteText','quota 보존');failUpload=true;await assert.rejects(a.sync.sync(true));const quotaRequests=uploads;
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
  console.log(`PASS profile sync coordinator: two PCs, initial choices, independent selection, field merge, conflict resolution, active identity review, debounce/idle/restore, quota, ACK loss, in-flight save, database restore/account isolation (${scans} checks, ${uploads} uploads)`);
}
run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);}).finally(()=>{Date.now=actualNow;for(const store of all) store.close();});
