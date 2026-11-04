import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {app} from 'electron';
type ProfileClockStamp={utcMs:number;source:'internet' | 'unverified';uncertaintyMs:number | null};
type ProfileSyncEnvelope={format:string;version:number;device:string;sequence:number;cells:Record<string,{device:string;sequence:number;context:Record<string,number>;clock:ProfileClockStamp;value:unknown}>};
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-sync-model-'));app.setPath('userData',fixture);
const root=path.resolve(__dirname,'..');
const {ApplicationData}=require(path.join(root,'dist/modules/applicationData'));
const {DEFAULT_CONFIG}=require(path.join(root,'dist/modules/constants'));
const {ProfileSyncModel,validateProfileSyncEnvelope,localSyncProfileId}=require(path.join(root,'dist/modules/profileSyncModel'));
const k=(...parts:string[])=>JSON.stringify(parts);
const stores:any[]=[];
let stamp:ProfileClockStamp={utcMs:Date.now(),source:'unverified',uncertaintyMs:null};
async function create(pc:string,empty=false):Promise<{store:any;model:any;id:string}> {
  const directory=path.join(fixture,pc),defaults=structuredClone(DEFAULT_CONFIG);
  defaults.contentsCheckerItems=[{id:'task',name:'숙제',category:'일일',isVisible:true,resetRule:{type:'daily',hour:6},maxCount:5,completedState:{}}];
  const legacy={...defaults,characterPresets:empty ? [] : [{id:'old',name:'프로필 A'}],selectedCharacterId:empty ? undefined : 'old',userServer:7,
    pinnedNoteText:'보존',discordWebhookUrl:'NEVER-SYNC',chatLogPath:'C:/private/log',contentsCheckerItems:defaults.contentsCheckerItems,
    nicknameNotes:[{server:7,nickname:'메모 대상',note:'LOCAL_ONLY_NOTE'}],
    customAlerts:[{id:'alert',enabled:true,type:'daily',time:'12:00',offsets:[0],message:'알림',soundFile:'C:/private/audio.wav',volume:91}]};
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(empty ? {} : legacy));
  const store=await ApplicationData.initialize({directory,deviceId:pc,defaults,clock:()=>stamp},legacy,{value:empty ? undefined : 7});stores.push(store);
  return {store,model:new ProfileSyncModel(store.database,pc,()=>stamp),id:store.list()[0].id};
}
function setting(store:any,id:string,key:string,value:unknown):void {const cfg=store.project(id,DEFAULT_CONFIG);cfg[key]=value;store.saveProjection(id,cfg);}
async function run():Promise<void> {
  await app.whenReady();
  const {ProfileClock}=require(path.join(root,'dist/modules/profileClock'));let elapsed=0;
  const clock=new ProfileClock(async()=>({utcMs:100_000,uncertaintyMs:1}),()=>elapsed);
  const beforeClock=clock.now();clock.observeInternetTime({utcMs:100_000,uncertaintyMs:600});assert.equal(clock.now().source,'internet');
  await clock.refresh();clock.observeInternetTime({utcMs:500_000,uncertaintyMs:900});assert.equal(clock.now().utcMs,100_000,'더 부정확한 HTTP 표본으로 정확한 NTP 기준을 낮추지 않음');
  elapsed=100;assert.equal(clock.now().utcMs,100_100);clock.invalidate();assert.equal(clock.now().source,'unverified','절전 복귀는 갱신 전 검증되지 않음');
  assert.equal(beforeClock.source,'unverified','새 보정으로 과거 stamp를 소급 변경하지 않음');
  const a=await create('PC-A'),b=await create('PC-B',true);
  a.store.saveToolValue(a.id,'buff_active_preset_id','preset-local-id');
  const first:ProfileSyncEnvelope=a.model.envelope();validateProfileSyncEnvelope(first);
  assert.ok(!JSON.stringify(first).includes('NEVER-SYNC'));assert.ok(!JSON.stringify(first).includes('C:/private'));
  assert.ok(!JSON.stringify(first).includes('LOCAL_ONLY_NOTE'));assert.ok(!JSON.stringify(first).includes('"volume":91'));
  assert.ok(!Object.keys(first.cells).some(k=>/diary|session|device-state|runtime/.test(k)));
  assert.ok(!Object.keys(b.model.envelope().cells).some(k=>JSON.parse(k)[0]==='profile'),'빈 기본 초안은 업로드하지 않음');
  const remote=JSON.parse(Object.keys(first.cells).find(k=>JSON.parse(k)[0]==='profile')!)[1];
  b.model.db.prepare("UPDATE shared_settings SET value=? WHERE key='nicknameNotes'").run(JSON.stringify([{server:7,nickname:'B 메모',note:'B_LOCAL_NOTE'}]));
  b.model.db.transaction(()=>{b.model.prepareRemoteImport([first]);b.model.merge(first);b.model.apply();})();
  assert.equal(b.store.list().length,1,'새 PC에서 불필요한 기본 프로필 없음');
  const bid=localSyncProfileId(b.model.db,remote);assert.equal(bid,b.id,'빈 기본 프로필을 실제 원격 데이터로 재사용');
  assert.equal(b.store.setting(bid,'pinnedNoteText'),'보존');assert.equal(b.store.setting(bid,'userServer'),7);
  assert.equal(b.store.toolValues(bid).buff_active_preset_id,'preset-local-id','도구의 단순 ID 문자열도 JSON으로 재해석하지 않음');
  assert.equal(b.store.project(bid,DEFAULT_CONFIG).nicknameNotes[0].note,'B_LOCAL_NOTE','Google 가져오기에서도 로컬 전용 공통 메모 보존');
  const bAudio=b.store.project(bid,DEFAULT_CONFIG);bAudio.customAlerts[0].soundFile='C:/private/B-local.wav';b.store.saveProjection(bid,bAudio);const audioSequence=b.model.envelope().sequence;
  const aAlert=a.store.project(a.id,DEFAULT_CONFIG);aAlert.customAlerts[0].message='변경된 알림';a.store.saveProjection(a.id,aAlert);b.model.merge(a.model.envelope());b.model.apply();
  assert.equal(b.store.setting(bid,'customAlerts')[0].soundFile,'C:/private/B-local.wav','원격 알림 내용 갱신에도 로컬 소리 보존');
  assert.equal(b.model.envelope().sequence,audioSequence,'수신/로컬 음향 차이는 새 송신 변경을 만들지 않음');
  const audioImport=a.model.envelope();b.model.prepareRemoteImport([audioImport]);b.model.merge(audioImport);b.model.apply();
  assert.equal(b.store.setting(bid,'customAlerts')[0].soundFile,'C:/private/B-local.wav','Google 전체 가져오기도 기존 로컬 소리 보존');
  const draftStore=await create('PC-Draft'),draftBefore=draftStore.model.envelope();const draft=draftStore.store.project(draftStore.id,DEFAULT_CONFIG);delete draft.userServer;draftStore.store.saveProjection(draftStore.id,draft);
  validateProfileSyncEnvelope(draftStore.model.envelope());assert.deepEqual(draftStore.model.envelope(),draftBefore,'이미 게시한 프로필의 미완성 초안은 삭제/null로 전송하지 않음');
  draftStore.store.update(draftStore.id,'다시 완성',16);validateProfileSyncEnvelope(draftStore.model.envelope());assert.ok(draftStore.model.envelope().sequence>draftBefore.sequence);
  setting(a.store,a.id,'pinnedNoteText','A 메모');setting(b.store,bid,'buffTimerWarnSeconds',[19]);
  a.model.merge(b.model.envelope());a.model.apply();b.model.merge(a.model.envelope());b.model.apply();
  assert.deepEqual(a.store.setting(a.id,'buffTimerWarnSeconds'),[19]);assert.equal(b.store.setting(bid,'pinnedNoteText'),'A 메모');
  setting(a.store,a.id,'pinnedNoteText','A 동시');setting(b.store,bid,'pinnedNoteText','B 동시');
  const ae=a.model.envelope(),be=b.model.envelope();a.model.merge(be);b.model.merge(ae);a.model.apply();b.model.apply();
  const conflict=a.model.reviews().find((r:any)=>r.key===k('setting',remote,'pinnedNoteText'));assert.ok(conflict);
  assert.equal(conflict.candidates.length,2);assert.equal(a.store.setting(a.id,'pinnedNoteText'),'A 동시','미해결 중 확정 로컬값 보존');
  assert.equal(b.store.setting(bid,'pinnedNoteText'),'B 동시');
  a.model.resolve(conflict.key,conflict.candidates.find((c:any)=>c.device==='PC-B').id);a.model.apply();
  b.model.merge(a.model.envelope());b.model.apply();
  assert.equal(a.store.setting(a.id,'pinnedNoteText'),'B 동시');assert.equal(b.store.setting(bid,'pinnedNoteText'),'B 동시');
  assert.equal(b.model.reviews().length,0);b.model.merge(a.model.envelope());assert.equal(b.model.reviews().length,0,'재전송 해결 반복 없음');
  // 인과관계가 없는 변경도 신뢰한 인터넷 시각의 오차구간이 분리되면 자동 선택.
  stamp={utcMs:Date.now(),source:'internet',uncertaintyMs:10};setting(a.store,a.id,'buffTimerWarnSeconds',[11]);
  stamp={...stamp,utcMs:stamp.utcMs+1000};setting(b.store,bid,'buffTimerWarnSeconds',[22]);
  a.model.merge(b.model.envelope());a.model.apply();assert.deepEqual(a.store.setting(a.id,'buffTimerWarnSeconds'),[22]);
  stamp={utcMs:Date.now(),source:'unverified',uncertaintyMs:null};
  // 숙제의 횟수/제외/정의는 독립, 같은 횟수 경합은 합산/최댓값으로 숨기지 않음.
  const edit=(s:any,id:string,count:number)=>{const cfg=s.project(id,DEFAULT_CONFIG);cfg.contentsCheckerItems[0].completedState[id]={currentCount:count,isCompleted:false,lastCompletedAt:Date.now()};s.saveProjection(id,cfg);};
  edit(a.store,a.id,3);edit(b.store,bid,1);a.model.merge(b.model.envelope());a.model.apply();
  assert.ok(a.model.reviews().some((r:any)=>r.key===k('homework',remote,'task','progress')));
  const cfg=b.store.project(bid,DEFAULT_CONFIG);cfg.contentsCheckerItems[0].completedState[bid].isExcluded=true;b.store.saveProjection(bid,cfg);
  a.model.merge(b.model.envelope());a.model.apply();assert.equal(a.store.homework(a.id)[0].completedState[a.id].isExcluded,true);
  const earlier=a.model.envelope();a.store.remove(a.id);b.model.merge(a.model.envelope());b.model.apply();
  assert.equal(b.store.list().some((p:any)=>p.id===bid),false);b.model.merge(earlier);b.model.apply();
  assert.equal(b.store.list().some((p:any)=>p.id===bid),false,'구 PC의 snapshot으로 삭제 프로필 부활 없음');
  const c=await create('PC-C');const before=c.model.envelope();
  assert.throws(()=>c.model.db.transaction(()=>{setting(c.store,c.id,'pinnedNoteText','실패');throw new Error('fault');})());
  assert.deepEqual(c.model.envelope(),before,'원본 실패와 outbox rollback');assert.equal(c.store.setting(c.id,'pinnedNoteText'),'보존');
  c.model.db.exec("CREATE TRIGGER reject_sync_journal BEFORE INSERT ON profile_sync_own BEGIN SELECT RAISE(ABORT,'sync journal failure');END");
  assert.throws(()=>setting(c.store,c.id,'pinnedNoteText','journal 실패'),/sync journal failure/);assert.equal(c.store.setting(c.id,'pinnedNoteText'),'보존');assert.deepEqual(c.model.envelope(),before,'새 sync journal 실패도 원본과 함께 rollback');c.model.db.exec('DROP TRIGGER reject_sync_journal');
  const captured=c.model.envelope().sequence;setting(c.store,c.id,'pinnedNoteText','전송중 새 변경');c.model.acknowledge(captured);assert.ok(c.model.pending()>0,'이전 ACK가 새 저장을 소비하지 않음');
  c.model.acknowledge(c.model.envelope().sequence);assert.equal(c.model.pending(),0);
  const file=c.store.filePath;c.store.close();c.store.reopen();assert.equal(c.store.filePath,file);
  const persisted=new ProfileSyncModel(c.store.database,'PC-C',()=>stamp);assert.equal(persisted.pending(),0);assert.equal(c.store.setting(c.id,'pinnedNoteText'),'전송중 새 변경');
  // 다른 PC의 전체 DB 복원은 원래 PC의 ACK/파일 ID/계정/변경feed를 승계하지 않는다.
  persisted.setMeta('ownFile','source-pc-file');persisted.setMeta('ownPublished',true);persisted.setMeta('cursor','source-cursor');
  persisted.setMeta('boundAccount','source@example.invalid');persisted.setMeta('transportAccount','source@example.invalid');
  const sourceEnvelope=persisted.envelope(),copyDirectory=path.join(fixture,'PC-Restored');fs.mkdirSync(copyDirectory);
  const portableCopy=path.join(fixture,'portable.db');await c.store.database.backup(portableCopy);
  fs.copyFileSync(portableCopy,path.join(copyDirectory,'app-data.db'));
  const copied=await ApplicationData.initialize({directory:copyDirectory,deviceId:'PC-Restored',defaults:DEFAULT_CONFIG,clock:()=>stamp},DEFAULT_CONFIG);
  stores.push(copied);const copiedModel=new ProfileSyncModel(()=>copied.database,'PC-Restored',()=>stamp);
  const assertCopied=()=>{
    const envelope:ProfileSyncEnvelope=copiedModel.envelope();validateProfileSyncEnvelope(envelope);
    assert.ok(envelope.device.startsWith('PC-Restored:'));assert.ok(copiedModel.pending()>0,'원본 PC에서 ACK한 값도 복원 PC의 전송 대기로 구성');
    for (const field of ['ownFile','cursor','boundAccount','transportAccount']) assert.ok(copiedModel.meta(field,undefined)==null,field);
    assert.equal(copiedModel.meta('restoreAccountHint',''),'source@example.invalid');assert.equal(copied.list().length,c.store.list().length);
    assert.deepEqual(Object.keys(envelope.cells).sort(),Object.keys(sourceEnvelope.cells).sort(),'프로필/항목의 공통 ID 유지');
    const memoKey=Object.keys(sourceEnvelope.cells).find(key=>JSON.parse(key)[2]==='pinnedNoteText')!;
    assert.equal(envelope.cells[memoKey].value,sourceEnvelope.cells[memoKey].value);
    assert.deepEqual(envelope.cells[memoKey].clock,sourceEnvelope.cells[memoKey].clock,'복원 시 원래 변경 시각 유지');
    assert.ok(Object.values(envelope.cells).every(cell=>cell.device===envelope.device));
  };
  assertCopied();const firstWriter=copiedModel.device;
  copiedModel.acknowledge(copiedModel.envelope().sequence);copied.close();fs.copyFileSync(portableCopy,copied.filePath);copied.reopen();
  assertCopied();assert.notEqual(copiedModel.device,firstWriter,'실행 중 저장소 재개방 경로도 새 PC writer로 격리');
  assert.equal(persisted.pending(),0);assert.equal(persisted.meta('ownFile',''),'source-pc-file','원래 PC 전송 상태 보존');
  // 지난 일일/주간의 지연 전송, 새 주기 초기화 및 목표 감소/재증가에서 진행이 부활하지 않는다.
  const d=await create('PC-D'),e=await create('PC-E',true),de=d.model.envelope();e.model.prepareRemoteImport([de]);e.model.merge(de);e.model.apply();
  const did=JSON.parse(Object.keys(de.cells).find(k=>JSON.parse(k)[0]==='profile')!)[1],eid=localSyncProfileId(e.model.db,did);
  const oldDay=d.store.project(d.id,DEFAULT_CONFIG);oldDay.contentsCheckerItems[0].completedState[d.id]={currentCount:4,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()-86_400_000};d.store.saveProjection(d.id,oldDay);
  const delayed=d.model.envelope();e.model.merge(delayed);e.model.apply();let state=e.store.homework(eid)[0].completedState[eid];assert.equal(state.currentCount,0);assert.equal(state.isExcluded,true);assert.equal(state.lastCompletedAt,undefined);
  e.model.merge(delayed);e.model.apply();assert.equal(e.store.homework(eid)[0].completedState[eid].currentCount,0,'옛 일일 snapshot 재전송으로 초기화 취소 없음');
  d.model.merge(e.model.envelope());d.model.apply();
  const oldWeek=d.store.project(d.id,DEFAULT_CONFIG);oldWeek.contentsCheckerItems[0].resetRule={type:'weekly',dayOfWeek:1,hour:6};oldWeek.contentsCheckerItems[0].completedState[d.id]={currentCount:4,isCompleted:false,isExcluded:true,lastCompletedAt:Date.now()-8*86_400_000};d.store.saveProjection(d.id,oldWeek);
  e.model.merge(d.model.envelope());e.model.apply();assert.equal(e.store.homework(eid)[0].completedState[eid].currentCount,0);d.model.merge(e.model.envelope());d.model.apply();
  const full=d.store.project(d.id,DEFAULT_CONFIG);full.contentsCheckerItems[0].completedState[d.id]={currentCount:5,isCompleted:true,isExcluded:true,lastCompletedAt:Date.now()};d.store.saveProjection(d.id,full);
  const smaller=e.store.project(eid,DEFAULT_CONFIG);smaller.contentsCheckerItems[0].maxCount=2;e.store.saveProjection(eid,smaller);e.model.merge(d.model.envelope());e.model.apply();assert.equal(e.store.homework(eid)[0].completedState[eid].currentCount,2);
  d.model.merge(e.model.envelope());d.model.apply();const larger=d.store.project(d.id,DEFAULT_CONFIG);larger.contentsCheckerItems[0].maxCount=5;d.store.saveProjection(d.id,larger);e.model.merge(d.model.envelope());e.model.apply();assert.equal(e.store.homework(eid)[0].completedState[eid].currentCount,2,'목표 재증가로 버렸던 진행 5회가 부활하지 않음');
  const custom=(p:any,id:string,itemId:string)=>{const cfg=p.store.project(id,DEFAULT_CONFIG);cfg.contentsCheckerItems.push({id:itemId,name:itemId,category:'일일',isVisible:true,isCustom:true,resetRule:{type:'daily',hour:6},completedState:{[id]:{}}});p.store.saveProjection(id,cfg);};
  custom(d,d.id,'custom-D');custom(e,eid,'custom-E');d.model.merge(e.model.envelope());d.model.apply();e.model.merge(d.model.envelope());e.model.apply();assert.equal(d.store.homework(d.id).length,3);assert.equal(e.store.homework(eid).length,3,'서로 다른 커스텀 숙제 동시 추가 보존');
  const bad=structuredClone(first);bad.cells[k('setting',remote,'discordWebhookUrl')]=Object.values(bad.cells)[0];assert.throws(()=>validateProfileSyncEnvelope(bad));
  const forged=structuredClone(first);Object.values(forged.cells)[0].device='imposter';assert.throws(()=>validateProfileSyncEnvelope(forged));
  const changed=structuredClone(first);Object.values(changed.cells)[0].value='changed';persisted.merge(first);assert.throws(()=>persisted.merge(changed),'동일 변경 ID 변조는 거부');
  console.log('PASS profile sync model: atomic journal, compact causal merge, UTC ordering, conflict resolution, profile isolation, tombstones, ACK/restart, cross-PC backup ownership, privacy validation');
}
run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);}).finally(()=>{for(const store of stores) store.close();});
