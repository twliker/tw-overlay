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
const {prepareProfileSyncSchema}=require(path.join(root,'dist/modules/profileSyncModel'));
const k=(...parts:string[])=>JSON.stringify(parts);
const stores:any[]=[];
let stamp:ProfileClockStamp={utcMs:Date.now(),source:'unverified',uncertaintyMs:null};
// v3.2.2 캐릭터 ID는 PC·캐릭터마다 다르다. 같은 ID는 같은 캐릭터로 동기화되므로 기본은 PC별 ID를 쓴다.
async function create(pc:string,empty=false,character=`old-${pc}`):Promise<{store:any;model:any;id:string}> {
  const directory=path.join(fixture,pc),defaults=structuredClone(DEFAULT_CONFIG);
  defaults.contentsCheckerItems=[{id:'task',name:'숙제',category:'일일',isVisible:true,resetRule:{type:'daily',dayOfWeek:undefined,hour:6},maxCount:5,completedState:{}}];
  const legacy={...defaults,characterPresets:empty ? [] : [{id:character,name:'프로필 A'}],selectedCharacterId:empty ? undefined : character,userServer:7,
    pinnedNoteText:empty ? defaults.pinnedNoteText : '보존',discordWebhookUrl:'NEVER-SYNC',chatLogPath:'C:/private/log',contentsCheckerItems:defaults.contentsCheckerItems,
    nicknameNotes:[{server:7,nickname:'메모 대상',note:'LOCAL_ONLY_NOTE'}],
    customAlerts:empty ? defaults.customAlerts : [{id:'alert',enabled:true,type:'daily',time:'12:00',offsets:[0],message:'알림',soundFile:'C:/private/audio.wav',volume:91}]};
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(empty ? {} : legacy));
  const store=await ApplicationData.initialize({directory,deviceId:pc,defaults,clock:()=>stamp},legacy,{value:empty ? undefined : 7});stores.push(store);
  return {store,model:new ProfileSyncModel(store.database,pc,()=>stamp,undefined,(id:string)=>store.isPristineProfilePlaceholder(id)),id:store.list()[0].id};
}
function setting(store:any,id:string,key:string,value:unknown):void {const cfg=store.project(id,DEFAULT_CONFIG);cfg[key]=value;store.saveProjection(id,cfg);}
async function checkOvernightHomework():Promise<void> {
  const {resetExpiredHomeworkItems}=require(path.join(root,'dist/modules/contentsChecker'));
  const previousStamp=stamp;
  const dayOne=Date.parse('2026-11-10T11:00:00Z'),dayTwo=Date.parse('2026-11-11T03:22:23Z');
  stamp={utcMs:dayOne,source:'unverified',uncertaintyMs:null};
  try {
    const a=await create('Overnight-A'),b=await create('Overnight-B',true);
    const remote=JSON.parse(Object.keys(a.model.envelope().cells).find(key=>JSON.parse(key)[0]==='profile')!)[1];
    const progressKey=k('homework',remote,'task','progress');
    const setCount=(pc:typeof a,id:string,count:number)=>{
      const cfg=pc.store.project(id,DEFAULT_CONFIG);
      cfg.contentsCheckerItems[0].completedState[id]={currentCount:count,isCompleted:count===5,lastCompletedAt:stamp.utcMs};
      pc.store.saveProjection(id,cfg);
    };
    const state=(pc:typeof a,id:string)=>pc.store.homework(id)[0].completedState[id];
    setCount(a,a.id,5);
    const published:ProfileSyncEnvelope=a.model.envelope();
    a.model.acknowledge(published.sequence);a.store.close();
    b.model.merge(published);b.model.apply();
    const bid=localSyncProfileId(b.model.db,remote)!;
    assert.equal(state(b,bid).currentCount,5,'B가 켜진 상태에서 A의 전날 숙제를 받음');

    stamp={...stamp,utcMs:dayTwo};
    const beforeExpiry=b.model.envelope();b.model.apply();
    assert.equal(state(b,bid).currentCount,0,'B에서 다음 날 시작 시 로컬 진행만 초기화');
    assert.deepEqual(b.model.envelope(),beforeExpiry,'원격 적용에 따른 주기 초기화도 전송하지 않음');
    setCount(b,bid,2);
    const dayTwoEnvelope:ProfileSyncEnvelope=b.model.envelope();

    stamp={...stamp,utcMs:Date.parse('2026-11-11T11:19:16Z')};
    a.store.reopen();a.model=new ProfileSyncModel(a.store.database,'Overnight-A',()=>stamp);
    const startup=a.store.project(a.id,DEFAULT_CONFIG);
    startup.contentsCheckerItems=resetExpiredHomeworkItems(startup.contentsCheckerItems,stamp.utcMs).items;
    a.store.withAutomaticSyncChange(()=>a.store.saveProjection(a.id,startup));
    assert.equal(state(a,a.id).currentCount,0);
    assert.equal(a.model.pending(),0,'A 부팅 중 주기 초기화로 새 0회가 전송 대기에 생기지 않음');
    assert.deepEqual(a.model.envelope(),published);

    const dayTwoProgress=dayTwoEnvelope.cells[progressKey];
    const legacyZero={device:'Legacy-PC',sequence:1,context:{[published.device]:published.sequence},
      clock:{utcMs:stamp.utcMs,source:'internet' as const,uncertaintyMs:1},
      value:{cycle:(dayTwoProgress.value as {cycle:number}).cycle,state:{currentCount:0,isCompleted:false}}};
    a.model.merge(dayTwoEnvelope);
    // 이전 버전의 자동 0회가 당일 B 기록을 보지 않은 상태에서 발행되는 실제 순서다.
    a.model.merge({...dayTwoEnvelope,device:legacyZero.device,sequence:1,cells:{[progressKey]:legacyZero}});a.model.apply();
    assert.equal(state(a,a.id).currentCount,2,'A의 재접속 시 B의 당일 숙제가 자동 반영됨');
    assert.equal(a.model.reviews().length,0);assert.equal(a.model.pending(),0);

    setCount(a,a.id,0);b.model.merge(a.model.envelope());b.model.apply();
    assert.equal(state(b,bid).currentCount,0,'사용자가 같은 주기에 직접 수정한 0회는 전송됨');
    assert.equal(state(b,bid).lastCompletedAt,stamp.utcMs);assert.equal(b.model.reviews().length,0);
    b.model.merge(dayTwoEnvelope);b.model.apply();
    assert.equal(state(b,bid).currentCount,0,'이전 진행이 지연 수신되어도 수동 0회를 되돌리지 않음');
  } finally {stamp=previousStamp;}
}
async function checkProgressEdgeCases():Promise<void> {
  const original=stamp;
  const day=86_400_000;
  const dayStart=Date.parse('2026-11-10T21:00:00Z');
  const daily={type:'daily',hour:6},weekly={type:'weekly',hour:6,dayOfWeek:1};
  const edit=(pc:any,change:(item:any)=>void)=>{
    const cfg=pc.store.project(pc.id,DEFAULT_CONFIG);
    change(cfg.contentsCheckerItems[0]);
    pc.store.saveProjection(pc.id,cfg);
  };
  const set=(pc:any,count:number)=>edit(pc,item=>{item.completedState[pc.id]={currentCount:count,isCompleted:count>=(item.maxCount || 1),lastCompletedAt:stamp.utcMs};});
  const state=(pc:any)=>pc.store.homework(pc.id)[0].completedState[pc.id];
  const pull=(receiver:any,sender:any)=>{receiver.model.merge(sender.model.envelope());receiver.model.apply();};
  async function pair(name:string,rule:typeof daily | typeof weekly) {
    stamp={utcMs:dayStart+8*3_600_000,source:'unverified',uncertaintyMs:null};
    const a=await create(name+'-A'),b=await create(name+'-B',true);
    if(rule.type==='weekly') edit(a,item=>{item.resetRule=rule;});
    pull(b,a);
    const rid=JSON.parse(Object.keys(a.model.envelope().cells).find(key=>JSON.parse(key)[0]==='profile')!)[1];
    b.id=localSyncProfileId(b.model.db,rid)!;
    return {a,b,rid,key:k('homework',rid,'task','progress')};
  }
  try {
    const shorter=await pair('shorter',weekly);
    set(shorter.a,5);
    edit(shorter.b,item=>{item.resetRule=daily;delete item.maxCount;});
    pull(shorter.a,shorter.b);pull(shorter.b,shorter.a);
    for (const pc of [shorter.a,shorter.b]) {
      assert.equal(state(pc).currentCount,1,'일일 경계 이후의 완료가 규칙 변경에서 유지');
      assert.equal(state(pc).isCompleted,true);
    }
    stamp={...stamp,utcMs:stamp.utcMs+day};
    edit(shorter.b,item=>{item.resetRule=weekly;item.maxCount=5;});
    pull(shorter.a,shorter.b);
    assert.equal(state(shorter.a).currentCount,0,'중간 일일 주기에 이미 만료된 주간 진행은 규칙 복원 후에도 만료');

    const longer=await pair('longer',daily);
    set(longer.a,2);pull(longer.b,longer.a);
    const old=longer.a.model.envelope();
    stamp={...stamp,utcMs:stamp.utcMs+day};
    longer.b.model.apply();assert.equal(state(longer.b).currentCount,0);
    edit(longer.b,item=>{item.resetRule=weekly;});
    pull(longer.a,longer.b);longer.a.model.merge(old);longer.a.model.apply();
    assert.equal(state(longer.a).currentCount,0,'일일→주간 변경 뒤 늦게 받은 전날 기록도 만료');

    const conflict=await pair('expired',daily);
    set(conflict.a,2);set(conflict.b,3);pull(conflict.a,conflict.b);
    assert.equal(conflict.a.model.reviews().length,1);
    const before=conflict.a.model.envelope();
    stamp={...stamp,utcMs:stamp.utcMs+day};
    assert.equal(conflict.a.model.reviews().length,0,'리셋 직후 지난 주기 확인을 숨김');
    assert.throws(()=>conflict.a.model.resolve(conflict.key,'local'),/다시 확인/,'이미 열어둔 오래된 확인도 적용 거부');
    conflict.a.model.apply();
    assert.equal(state(conflict.a).currentCount,0);
    assert.deepEqual(conflict.a.model.envelope(),before,'지난 주기를 닫으면서 현재 0회를 작성하지 않음');

    const equal=await pair('equal',daily);
    set(equal.a,2);pull(equal.b,equal.a);
    stamp={...stamp,utcMs:stamp.utcMs+1000};set(equal.a,0);
    stamp={...stamp,utcMs:stamp.utcMs+1000};set(equal.b,0);
    pull(equal.a,equal.b);pull(equal.b,equal.a);
    for (const pc of [equal.a,equal.b]) {
      assert.equal(pc.model.reviews().length,0,'같은 주기의 동시 0회는 확인 불필요');
      assert.equal(state(pc).currentCount,0);
    }

    const legacy=await pair('legacy-clear',daily);
    set(legacy.a,2);pull(legacy.b,legacy.a);
    const aFile=legacy.a.model.envelope(),bFile=legacy.b.model.envelope();
    const zero={device:bFile.device,sequence:bFile.sequence+1,context:{[aFile.device]:aFile.sequence},clock:stamp,
      value:{cycle:dayStart,state:{currentCount:0,isCompleted:false}}};
    const reader=await create('legacy-clear-late-reader',true);
    reader.model.merge({...bFile,sequence:zero.sequence,cells:{[legacy.key]:zero}});
    reader.model.merge(aFile);reader.model.apply();reader.id=localSyncProfileId(reader.model.db,legacy.rid)!;
    assert.equal(state(reader).currentCount,0,'구버전 수동 해제가 먼저 와도 같은 주기의 선행 기록을 받은 뒤 반영');
    legacy.a.model.merge({...bFile,sequence:zero.sequence,cells:{[legacy.key]:zero}});legacy.a.model.apply();
    assert.equal(state(legacy.a).currentCount,0);assert.equal(legacy.a.model.reviews().length,0);
  } finally {stamp=original;}
}

/** v3.2.2에서 같은 캐릭터를 동기화하던 두 PC가 각각 업그레이드한 뒤 연결해도 프로필이 중복되지 않는다.
 * 이전할 때 프로필 ID는 PC마다 새로 정해지지만, 동기화 ID는 v3.2.2 캐릭터 ID에서 같게 정한다. */
async function checkLegacyUpgradeIdentity():Promise<void> {
  const remoteProfiles=(envelope:ProfileSyncEnvelope)=>[...new Set(Object.keys(envelope.cells)
    .filter(key=>JSON.parse(key)[0]==='profile').map(key=>JSON.parse(key)[1]))];
  const shared='char-shared-legacy';
  const a=await create('upgrade-A',false,shared),published:ProfileSyncEnvelope=a.model.envelope();
  const [rid]=remoteProfiles(published);
  assert.match(rid,/^legacy-character-[0-9a-f]{32}$/,'이전한 프로필의 동기화 ID는 캐릭터 ID에서 정한다');
  assert.equal(JSON.stringify(published).includes(shared),false,'원본 캐릭터 ID는 그대로 보내지 않는다');
  // B는 자기 상태를 먼저 만든 뒤 A를 받는다. 같은 캐릭터라 같은 동기화 ID를 쓴다.
  const b=await create('upgrade-B',false,shared);
  assert.deepEqual(remoteProfiles(b.model.envelope()),[rid],'두 PC의 같은 캐릭터는 같은 동기화 ID');
  b.model.merge(published);b.model.apply();
  assert.equal(b.store.list().length,1,'병합해도 같은 캐릭터가 두 프로필이 되지 않는다');
  assert.equal(localSyncProfileId(b.model.db,rid),b.id);
  assert.deepEqual(b.model.reviews(),[],'PC마다 다른 생성 시각은 확인할 변경으로 남기지 않는다');
  // 다른 캐릭터(다른 v3.2.2 캐릭터 ID)는 지금처럼 별도 프로필로 유지한다.
  const other=await create('upgrade-other');
  assert.notDeepEqual(remoteProfiles(other.model.envelope()),[rid],'다른 캐릭터는 다른 동기화 ID');
  other.model.merge(published);other.model.apply();
  assert.equal(other.store.list().length,2,'다른 캐릭터는 합치지 않는다');
}

/** v3.2.2는 고정 메모·발굴지 안내를 PC마다 따로 보관했다. 두 PC를 업그레이드하면 같은 캐릭터의 이전 값이 서로 다르다.
 * 캐릭터마다 확인할 변경을 만들지 않고, 메모는 양쪽 내용을 모두 남기며 발굴지 안내는 한쪽이라도 켰으면 켠다.
 * 이전 뒤 사용자가 고친 값은 기존 충돌 규칙을 그대로 따른다. */
async function checkLegacyDeviceLocalSettings():Promise<void> {
  const original=stamp;
  try {
    const characters=[{id:'char-memo-1',name:'본캐'},{id:'char-memo-2',name:'부캐'},{id:'char-memo-3',name:'창고'}];
    const upgrade=async(pc:string,memo:string,digsite:boolean,server:number | null=7)=>{
      const directory=path.join(fixture,pc),defaults=structuredClone(DEFAULT_CONFIG);
      const legacy={...defaults,characterPresets:characters,selectedCharacterId:characters[0].id,userServer:server ?? undefined,pinnedNoteText:memo,digsiteHudEnabled:digsite};
      fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(legacy));
      const store=await ApplicationData.initialize({directory,deviceId:pc,defaults,clock:()=>stamp},legacy,{value:server});stores.push(store);
      return {store,model:new ProfileSyncModel(store.database,pc,()=>stamp)};
    };
    const memos=(pc:{store:any})=>pc.store.list().map((p:any)=>pc.store.setting(p.id,'pinnedNoteText'));
    stamp={utcMs:Date.parse('2026-11-20T01:00:00Z'),source:'unverified',uncertaintyMs:null};
    const a=await upgrade('memo-A','A PC 메모',false);
    stamp={...stamp,utcMs:stamp.utcMs+60_000};
    const b=await upgrade('memo-B','B PC 메모',true);
    const memoCells=Object.entries(a.model.envelope().cells as ProfileSyncEnvelope['cells']).filter(([key])=>JSON.parse(key)[2]==='pinnedNoteText');
    assert.equal(memoCells.length,3);
    assert.ok(memoCells.every(([,cell])=>(cell.clock as any).legacyMigration===true),'이전 직후 기록한 메모에만 이전 값 표식');
    validateProfileSyncEnvelope(a.model.envelope());
    const sequences=[a.model.envelope().sequence,b.model.envelope().sequence];
    b.model.merge(a.model.envelope());b.model.apply();
    a.model.merge(b.model.envelope());a.model.apply();
    assert.deepEqual([a.model.envelope().sequence,b.model.envelope().sequence],sequences,'병합한 값을 새 변경으로 다시 보내지 않음');
    for (const pc of [a,b]) {
      assert.deepEqual(pc.model.reviews(),[],'캐릭터마다 메모·발굴지 확인할 변경을 만들지 않음');
      assert.equal(pc.store.list().length,3);
      assert.deepEqual(memos(pc),Array(3).fill('A PC 메모\n---\nB PC 메모'),'두 PC의 메모를 모두 남김(기기 ID 순서)');
      assert.ok(pc.store.list().every((p:any)=>pc.store.setting(p.id,'digsiteHudEnabled')===true),'한쪽이라도 켠 발굴지 안내는 켬');
    }
    // 같은 메모는 하나로 유지하고, 이전 뒤 사용자가 고친 값은 기존 규칙(순서가 불확실하면 확인)을 따른다.
    stamp={...stamp,utcMs:stamp.utcMs+60_000};
    const c=await upgrade('memo-C','A PC 메모',false);
    c.model.merge(a.model.envelope());c.model.merge(b.model.envelope());c.model.apply();
    assert.deepEqual(memos(c),Array(3).fill('A PC 메모\n---\nB PC 메모'),'같은 내용은 한 번만');
    assert.deepEqual(c.model.reviews(),[]);
    // 4차 집중 리뷰: 병합 뒤 한쪽 PC가 백업 복원 등으로 자기 셀을 다시 기록해도(rebaseOwn) 확인할 변경이 다시 생기지 않는다.
    a.model.rebaseOwn(true);
    b.model.merge(a.model.envelope());b.model.apply();
    assert.deepEqual(b.model.reviews(),[],'자동 병합한 메모를 다시 기록해도 확인할 변경이 생기지 않음');
    assert.deepEqual(memos(b),Array(3).fill('A PC 메모\n---\nB PC 메모'),'다시 기록한 병합 메모로 수렴');
    a.model.merge(b.model.envelope());a.model.apply();
    assert.deepEqual(a.model.reviews(),[]);
    // 서버를 정하지 않은 v3.2.2 캐릭터는 서버를 고를 때 처음 기록된다. 그 사이 사용자가 고친 메모는 이전 값이 아니므로
    // 이전 값 표식을 붙이지 않는다(자동 병합 대상이 아님).
    stamp={...stamp,utcMs:stamp.utcMs+60_000};
    const d=await upgrade('memo-D','D PC 메모',false,null);
    assert.equal(Object.keys(d.model.envelope().cells).filter(key=>JSON.parse(key)[2]==='pinnedNoteText').length,0,'서버가 없으면 아직 기록하지 않음');
    const edited=d.store.list()[0].id;
    setting(d.store,edited,'pinnedNoteText','D에서 고친 메모');
    setting(d.store,edited,'userServer',7);
    const dMemo=Object.entries(d.model.envelope().cells as ProfileSyncEnvelope['cells']).filter(([key])=>JSON.parse(key)[2]==='pinnedNoteText');
    assert.equal(dMemo.length,1);
    assert.equal((dMemo[0][1].clock as any).legacyMigration,undefined,'이전 뒤 고친 메모에는 이전 값 표식을 붙이지 않음');
    const keep=d.store.list()[1].id;
    setting(d.store,keep,'userServer',7);
    const kept=Object.entries(d.model.envelope().cells as ProfileSyncEnvelope['cells']).find(([key])=>JSON.parse(key)[2]==='pinnedNoteText' && JSON.parse(key)[1]!==JSON.parse(dMemo[0][0])[1]);
    assert.equal((kept?.[1].clock as any)?.legacyMigration,true,'고치지 않은 이전 값은 서버를 늦게 골라도 표식을 붙임');
    // 4차 리뷰 후속: PC 세 대에서 한 PC가 둘만 병합한 뒤 다시 기록해도(rebaseOwn) 늦게 온 셋째 PC의 이전 값과 확인 없이 합친다.
    stamp={...stamp,utcMs:stamp.utcMs+60_000};
    const e1=await upgrade('memo-E1','E1 메모',false),e2=await upgrade('memo-E2','E2 메모',false),e3=await upgrade('memo-E3','E3 메모',false);
    e1.model.merge(e2.model.envelope());e1.model.apply();
    e1.model.rebaseOwn(true);
    e1.model.merge(e3.model.envelope());e1.model.apply();
    assert.deepEqual(e1.model.reviews(),[],'다시 기록한 병합 메모도 이전 값으로 남아 셋째 PC와 확인 없이 합침');
    assert.ok(memos(e1).every((memo:string)=>['E1 메모','E2 메모','E3 메모'].every(text=>memo.includes(text))),'세 PC의 메모를 모두 남김');
    // 구형 설정 ZIP 복원으로 들어온 v3.2.2 값도 이전 값으로 인정한다.
    const originalsOf=(pc:{store:any})=>JSON.parse(pc.store.database.prepare("SELECT value FROM app_meta WHERE key='legacy_device_local_settings'").get().value);
    assert.deepEqual(originalsOf(e1).pinnedNoteText,['E1 메모']);
    e1.store.restoreLegacyConfiguration({...structuredClone(DEFAULT_CONFIG),characterPresets:characters,selectedCharacterId:characters[0].id,userServer:7,pinnedNoteText:'복원한 메모'},{value:7});
    assert.deepEqual(originalsOf(e1).pinnedNoteText,['E1 메모','복원한 메모'],'구형 설정 복원의 원래 값을 목록에 더함');
    const target=a.store.list()[0].id;
    setting(a.store,target,'pinnedNoteText','A에서 고친 메모');
    setting(b.store,b.store.list().find((p:any)=>p.name===a.store.list()[0].name).id,'pinnedNoteText','B에서 고친 메모');
    a.model.merge(b.model.envelope());a.model.apply();
    assert.deepEqual(a.model.reviews().map((review:any)=>review.reason),['conflict'],'이전 뒤 두 PC가 고친 메모는 기존처럼 확인');
    // 이어 붙인 메모가 저장 한도를 넘으면 자동으로 정하지 않고 확인할 변경으로 남긴다(어느 쪽도 버리지 않음).
    stamp={...stamp,utcMs:stamp.utcMs+60_000};
    const long1=await upgrade('memo-long-1','가'.repeat(600),false),long2=await upgrade('memo-long-2','나'.repeat(600),false);
    long1.model.merge(long2.model.envelope());long1.model.apply();
    assert.equal(long1.model.reviews().length,3,'한도를 넘으면 캐릭터별 확인');
    assert.deepEqual(memos(long1),Array(3).fill('가'.repeat(600)),'확인 전에는 이 PC 값을 유지');
  } finally {stamp=original;}
}

async function checkMultipleWriters():Promise<void> {
  const original=stamp;
  try {
    stamp={utcMs:Date.parse('2026-11-11T05:00:00Z'),source:'unverified',uncertaintyMs:null};
    const first=await create('relay-0'),initial=first.model.envelope();
    const rid=JSON.parse(Object.keys(initial.cells).find((key:string)=>JSON.parse(key)[0]==='profile')!)[1];
    const progress=k('homework',rid,'task','progress'),memo=k('setting',rid,'pinnedNoteText');
    const join=async (name:string)=>{
      const pc=await create(name,true);
      pc.model.merge(initial);pc.model.apply();pc.id=localSyncProfileId(pc.model.db,rid)!;
      return pc;
    };
    const files:ProfileSyncEnvelope[]=[],writers=[first];
    for(let n=0;n<8;n++){
      const pc=n===0 ? first : await join('relay-'+n);
      if(n>0){pc.model.merge(files[n-1]);pc.model.apply();writers.push(pc);}
      const cfg=pc.store.project(pc.id,DEFAULT_CONFIG);
      cfg.contentsCheckerItems[0].completedState[pc.id]={currentCount:n%4+1,isCompleted:false,lastCompletedAt:stamp.utcMs};
      if(n===0) cfg.pinnedNoteText='A만 수정한 다른 필드';
      pc.store.saveProjection(pc.id,cfg);
      const file=pc.model.envelope();validateProfileSyncEnvelope(file);files.push(file);
      stamp={utcMs:stamp.utcMs+10_000,source:'internet',uncertaintyMs:1};
    }
    assert.equal(files.at(-1)!.cells[progress].context[files[0].device],files[0].cells[progress].sequence,'직접 받지 않은 조상도 같은 필드에서 이어짐');
    const isolation=await join('relay-unrelated');
    isolation.model.merge(files.at(-1));isolation.model.apply();
    stamp={...stamp,source:'unverified',uncertaintyMs:null};
    setting(isolation.store,isolation.id,'pinnedNoteText','별도로 편집한 메모');
    assert.equal(isolation.model.envelope().cells[memo].context[files[0].device],initial.cells[memo].sequence,'다른 필드의 보지 못한 변경까지 지우지 않음');
    isolation.model.merge(files[0]);isolation.model.apply();
    assert.ok(isolation.model.reviews().some((review:any)=>review.key===memo));
    const orders=[files,files.slice().reverse(),[...files.filter((_,i)=>i%2),...files.filter((_,i)=>!(i%2))]];
    // 기존 PC가 만든 간접 계보 누락 파일도 중간 원본이 늦게 도착하면 수렴한다.
    const legacy=files.slice(0,4).map((file,i)=>{
      const copy=structuredClone(file);
      if(i>1) copy.cells[progress].context=Object.fromEntries(Object.entries(copy.cells[progress].context).filter(([writer])=>writer===file.device || writer===files[i-1].device));
      return copy;
    });
    orders.push(legacy.slice().reverse());
    for(const [i,order] of orders.entries()){
      const pc=await join('relay-reader-'+i);
      for(const file of order){pc.model.merge(file);pc.model.apply();}
      assert.equal(pc.store.homework(pc.id)[0].completedState[pc.id].currentCount,4);
      assert.equal(pc.model.reviews().length,0,'수신 순서와 상관없이 마지막 수정만 남음');
    }
    for(const pc of writers){
      for(const file of files.slice().reverse()){pc.model.merge(file);pc.model.apply();}
      assert.equal(pc.store.homework(pc.id)[0].completedState[pc.id].currentCount,4);
      assert.equal(pc.model.reviews().length,0);
    }
  } finally {stamp=original;}
}

async function checkStorageCompatibility():Promise<void> {
  const {getHomeworkCycleEnd}=require(path.join(root,'dist/shared/homeworkResetCycle'));
  const pc=await create('reopen-with-older-client');
  const cfg=pc.store.project(pc.id,DEFAULT_CONFIG),item=cfg.contentsCheckerItems[0];
  const expires=getHomeworkCycleEnd(item.resetRule,stamp.utcMs);
  item.completedState[pc.id]={currentCount:1,isCompleted:false,lastCompletedAt:stamp.utcMs,progressExpiresAt:expires};
  pc.store.saveProjection(pc.id,cfg);
  const envelope=pc.model.envelope(),progressKey=Object.keys(envelope.cells).find(field=>JSON.parse(field)[3]==='progress')!;
  const wire=envelope.cells[progressKey];
  const raw=pc.model.db.prepare('SELECT state FROM profile_homework WHERE profile_id=? AND item_id=?').get(pc.id,item.id);
  assert.deepEqual(JSON.parse(raw.state),wire.value.state,'이전 앱이 읽는 숙제 JSON과 전송 형식은 그대로 유지');
  assert.deepEqual(pc.model.meta('materialized',{})[progressKey],wire.value,'이전 앱이 열 때 만료 정보로 불필요한 새 변경을 만들지 않음');
  assert.equal(pc.store.homework(pc.id)[0].completedState[pc.id].progressExpiresAt,expires);

  // 구버전 앱이 같은 DB에서 오프라인으로 수정하면 송신 원본에는 남지만 새 버전의 원본 테이블에는 없다.
  const olderEdit={...wire,clock:stamp,sequence:envelope.sequence+1,value:{cycle:wire.value.cycle,state:{currentCount:0,isCompleted:false}}};
  pc.model.db.prepare('UPDATE profile_homework SET state=? WHERE profile_id=? AND item_id=?').run(JSON.stringify(olderEdit.value.state),pc.id,item.id);
  pc.model.db.prepare('UPDATE profile_sync_own SET value=? WHERE key=?').run(JSON.stringify(olderEdit),progressKey);
  pc.model.setMeta('vector',{[envelope.device]:olderEdit.sequence});
  const oldMaterialized=pc.model.meta('materialized',{});oldMaterialized[progressKey]=olderEdit.value;pc.model.setMeta('materialized',oldMaterialized);
  pc.store.close();pc.store.reopen();pc.model=new ProfileSyncModel(pc.store.database,envelope.device,()=>stamp);
  pc.model.apply();
  assert.equal(pc.store.homework(pc.id)[0].completedState[pc.id].currentCount,0,'다시 업데이트할 때 구버전의 미전송 수동 해제가 살아 있음');
  assert.equal(pc.model.envelope().cells[progressKey].sequence,olderEdit.sequence);
}
/** 새 버전이 추가한 키는 그 셀만 건너뛰고 같은 파일의 나머지는 반영한다. 아는 키의 잘못된 값은 계속 거부한다. */
async function checkForwardCompatibility():Promise<void> {
  const sender=await create('future-sender'),receiver=await create('future-receiver',true);
  setting(sender.store,sender.id,'pinnedNoteText','새 버전 파일의 아는 값');
  const envelope=sender.model.envelope();
  const rid=JSON.parse(Object.keys(envelope.cells).find(key=>JSON.parse(key)[0]==='profile')!)[1];
  const template=envelope.cells[k('profile',rid,'name')];
  const add=(parts:string[],value:unknown)=>{envelope.cells[k(...parts)]={...template,value};};
  add(['setting',rid,'discordWebhookUrl'],'https://discord.invalid/never-applied');
  add(['setting',rid,'futureSetting'],{nested:true});
  add(['homework',rid,'task','futureField'],[1]);
  add(['futureScope',rid,'value'],1);
  add(['shared','futureShared'],'x');
  validateProfileSyncEnvelope(envelope);
  receiver.model.prepareRemoteImport([envelope]);receiver.model.merge(envelope);receiver.model.apply();
  const local=localSyncProfileId(receiver.model.db,rid);
  assert.equal(receiver.store.setting(local,'pinnedNoteText'),'새 버전 파일의 아는 값','모르는 키가 있어도 같은 파일의 나머지 셀은 반영');
  const keys=receiver.store.database.prepare('SELECT key FROM profile_settings WHERE profile_id=?').all(local).map((row:any)=>row.key);
  assert.ok(!keys.includes('discordWebhookUrl') && !keys.includes('futureSetting'),'모르는 키와 기기 전용 키는 저장하지 않음');
  assert.equal(receiver.store.database.prepare("SELECT COUNT(*) n FROM profile_sync_cells WHERE key LIKE '%future%' OR key LIKE '%discordWebhookUrl%'").get().n,0);
  assert.ok(!Object.keys(receiver.model.envelope().cells).some(key=>/future|discordWebhookUrl/.test(key)),'모르는 키를 다시 전송하지 않음');
  for (const [parts,value] of [[['setting',rid,'userServer'],'not-a-server'],[['homework',rid,'task','maxCount'],0],[['profile',rid,'deleted'],'yes']] as Array<[string[],unknown]>) {
    const malformed=structuredClone(envelope);malformed.cells[k(...parts)]={...template,value};
    assert.throws(()=>validateProfileSyncEnvelope(malformed),/항목/,`아는 키의 잘못된 값은 거부: ${parts.join('.')}`);
  }
}
/** 구버전 알림 모양은 실행 기본값으로 정규화해 보내고, 그래도 잘못된 셀은 보류한 채 나머지를 전송한다. */
async function checkLegacyAndHeldCells():Promise<void> {
  const pc=await create('legacy-alert-sender');
  setting(pc.store,pc.id,'customAlerts',[{id:'hourly',enabled:true,type:'hourly',message:'매시',soundFile:'orb.mp3'},
    {id:'daily',enabled:true,type:'daily',time:'09:30',message:'매일',soundFile:'orb.mp3'}]);
  const first=pc.model.planUpload();
  validateProfileSyncEnvelope(first.envelope);assert.deepEqual(first.held,[]);assert.equal(first.sizing.heldCells,undefined);
  const alertKey=Object.keys(first.envelope.cells).find(key=>JSON.parse(key)[2]==='customAlerts')!;
  assert.deepEqual(first.envelope.cells[alertKey].value,[{id:'hourly',enabled:true,type:'hourly',message:'매시',offsets:[0],minute:0},
    {id:'daily',enabled:true,type:'daily',time:'09:30',message:'매일',offsets:[0]}],'offsets/minute 없는 구버전 알림은 실행 기본값으로 전송');
  pc.model.acknowledgeEnvelope(first.envelope,pc.model.legacyBoundary(),first.sizing);
  setting(pc.store,pc.id,'customAlerts',[{id:'broken',enabled:true,type:'daily',message:'시간 없음',soundFile:'orb.mp3'}]);
  setting(pc.store,pc.id,'pinnedNoteText','함께 보낼 메모');
  const plan=pc.model.planUpload(first.envelope);
  validateProfileSyncEnvelope(plan.envelope);
  assert.deepEqual(plan.held,[alertKey]);assert.equal(plan.sizing.heldCells,1);assert.match(plan.sizing.heldLabels[0],/사용자 지정 알림/);
  assert.deepEqual(plan.envelope.cells[alertKey],first.envelope.cells[alertKey],'이전에 올린 정상 값은 그대로 유지');
  assert.ok(Object.values(plan.envelope.cells).some((cell:any)=>cell.value==='함께 보낼 메모'),'나머지 변경은 전송');
  pc.model.acknowledgeEnvelope(plan.envelope,pc.model.legacyBoundary(),plan.sizing);
  assert.equal(pc.model.pending(),0,'보류한 셀 때문에 같은 전송을 반복하지 않음');
  assert.equal(pc.model.envelope().cells[alertKey].value[0].id,'broken','보류한 값은 이 PC의 송신 원본에 보관');
}
/** 삭제한 기본 숙제는 전송 확인(변경 이력 정리)과 Google 계정 전환(동기화 삭제 표식 정리) 뒤에도 되살리지 않는다. */
async function checkDeletedDefaultHomework():Promise<void> {
  const hasTask=(store:any,id:string)=>store.homework(id).some((item:any)=>item.id==='task');
  const taskCells=(model:any)=>Object.keys(model.envelope().cells).filter(key=>{const p=JSON.parse(key);return p[0]==='homework' && p[2]==='task' && p[3]!=='deleted';});
  const pc=await create('deleted-default-homework');
  const cfg=pc.store.project(pc.id,DEFAULT_CONFIG);
  cfg.contentsCheckerItems=cfg.contentsCheckerItems.filter((item:any)=>item.id!=='task');pc.store.saveProjection(pc.id,cfg);
  assert.equal(hasTask(pc.store,pc.id),false);
  pc.model.acknowledge(pc.model.envelope().sequence,pc.model.legacyBoundary());
  assert.equal(pc.store.database.prepare("SELECT COUNT(*) n FROM profile_change_log WHERE scope='homework' AND operation='delete'").get().n,0);
  pc.model.rebaseOwn(true,true);
  assert.equal(pc.store.database.prepare('SELECT COUNT(*) n FROM profile_sync_tombstones').get().n,0);
  pc.store.ensureDefaultHomework();pc.store.close();pc.store.reopen();pc.model=new ProfileSyncModel(pc.store.database,'deleted-default-homework',()=>stamp);
  assert.equal(hasTask(pc.store,pc.id),false,'계정 전환·재시작 뒤에도 삭제한 기본 숙제를 되살리지 않음');
  assert.deepEqual(taskCells(pc.model),[],'삭제한 기본 숙제의 생성을 새 계정에 전송하지 않음');
  // 다른 PC의 삭제를 반영한 경우도 같은 표식을 남긴다.
  const sender=await create('deleted-default-sender'),receiver=await create('deleted-default-receiver',true);
  const initial=sender.model.envelope();receiver.model.prepareRemoteImport([initial]);receiver.model.merge(initial);receiver.model.apply();
  const rid=JSON.parse(Object.keys(initial.cells).find(key=>JSON.parse(key)[0]==='profile')!)[1],local=localSyncProfileId(receiver.model.db,rid);
  assert.equal(hasTask(receiver.store,local),true);
  const removed=sender.store.project(sender.id,DEFAULT_CONFIG);
  removed.contentsCheckerItems=removed.contentsCheckerItems.filter((item:any)=>item.id!=='task');sender.store.saveProjection(sender.id,removed);
  const update=sender.model.envelope();receiver.model.merge(update);receiver.model.apply();
  assert.equal(hasTask(receiver.store,local),false);
  receiver.model.rebaseOwn(true,true);receiver.store.ensureDefaultHomework();
  assert.equal(hasTask(receiver.store,local),false,'반영한 원격 삭제도 계정 전환 뒤 되살리지 않음');
}
async function run():Promise<void> {
  await app.whenReady();
  const {ProfileClock}=require(path.join(root,'dist/modules/profileClock'));let elapsed=0;
  const clock=new ProfileClock(async()=>({utcMs:100_000,uncertaintyMs:1}),()=>elapsed);
  const beforeClock=clock.now();clock.observeInternetTime({utcMs:100_000,uncertaintyMs:600});assert.equal(clock.now().source,'internet');
  await clock.refresh();clock.observeInternetTime({utcMs:500_000,uncertaintyMs:900});assert.equal(clock.now().utcMs,100_000,'더 부정확한 HTTP 표본으로 정확한 NTP 기준을 낮추지 않음');
  elapsed=100;assert.equal(clock.now().utcMs,100_100);clock.invalidate();assert.equal(clock.now().source,'unverified','절전 복귀는 갱신 전 검증되지 않음');
  assert.equal(beforeClock.source,'unverified','새 보정으로 과거 stamp를 소급 변경하지 않음');
  const migration=await create('Snapshot-migration');
  const other=migration.store.create('동기화 비교용',7);
  const oldSnapshot=migration.model.meta('materialized',{});
  const db=migration.store.database;
  db.exec('DELETE FROM profile_sync_materialized');
  db.prepare("INSERT INTO profile_sync_meta VALUES('materialized',?)").run(JSON.stringify(oldSnapshot));
  prepareProfileSyncSchema(db);
  assert.deepEqual(migration.model.meta('materialized',{}),oldSnapshot,'기존 단일 저장 상태를 모두 이전한다.');
  const readPartition=db.prepare('SELECT value FROM profile_sync_materialized WHERE profile=?');
  const previousOther=readPartition.get(other.id);
  assert.ok(previousOther);
  setting(migration.store,migration.id,'pinnedNoteText','현재 프로필만 변경');
  assert.deepEqual(readPartition.get(other.id),previousOther,'현재 프로필의 저장으로 다른 프로필 스냅숏을 다시 쓰지 않는다.');
  const projection=migration.store.project(migration.id,DEFAULT_CONFIG);
  projection.contentsCheckerItems.push({...structuredClone(projection.contentsCheckerItems[0]),id:'untouched-task'});
  migration.store.saveProjection(migration.id,projection);
  db.exec(`CREATE TRIGGER reject_untouched_homework_delete BEFORE DELETE ON profile_homework
    WHEN OLD.item_id='untouched-task' BEGIN SELECT RAISE(ABORT,'unrelated homework rewrite');END`);
  projection.contentsCheckerItems[0].completedState[migration.id]={isCompleted:false,currentCount:1,lastCompletedAt:stamp.utcMs};
  migration.store.saveProjection(migration.id,projection);
  assert.equal(migration.store.homework(migration.id)[0].completedState[migration.id].currentCount,1);
  const a=await create('PC-A'),b=await create('PC-B',true);
  a.store.saveToolValue(a.id,'buff_active_preset_id','preset-local-id');
  const first:ProfileSyncEnvelope=a.model.envelope();validateProfileSyncEnvelope(first);
  assert.ok(!JSON.stringify(first).includes('NEVER-SYNC'));assert.ok(!JSON.stringify(first).includes('C:/private'));
  assert.ok(!JSON.stringify(first).includes('LOCAL_ONLY_NOTE'));assert.ok(!JSON.stringify(first).includes('"volume":91'));
  assert.ok(!Object.keys(first.cells).some(k=>/diary|session|device-state|runtime/.test(k)));
  assert.ok(!Object.keys(b.model.envelope().cells).some(k=>JSON.parse(k)[0]==='profile'),'빈 기본 초안은 업로드하지 않음');
  const remote=JSON.parse(Object.keys(first.cells).find(k=>JSON.parse(k)[0]==='profile')!)[1];
  const customized=await create('PC-Customized-Placeholder',true);
  setting(customized.store,customized.id,'pinnedNoteText','이름을 정하기 전에 저장한 메모');
  customized.model.merge(first);customized.model.apply();
  const customizedRemote=localSyncProfileId(customized.model.db,remote);
  assert.ok(customizedRemote && customizedRemote!==customized.id,'설정이 있는 기본 슬롯과 원격 프로필은 독립적인 ID를 유지한다');
  assert.equal(customized.store.setting(customized.id,'pinnedNoteText'),'이름을 정하기 전에 저장한 메모');
  assert.equal(customized.store.setting(customizedRemote,'pinnedNoteText'),'보존');
  b.model.db.prepare("UPDATE shared_settings SET value=? WHERE key='nicknameNotes'").run(JSON.stringify([{server:7,nickname:'B 메모',note:'B_LOCAL_NOTE'}]));
  b.model.db.transaction(()=>{b.model.prepareRemoteImport([first]);b.model.merge(first);b.model.apply();})();
  const changes=()=>b.model.db.prepare('SELECT total_changes() AS count').get().count as number;
  const beforeRepeat=changes();
  b.model.merge(first);
  assert.equal(changes()-beforeRepeat,1,'재수신한 동일 원본은 버전 확인 외에 DB 변경을 만들지 않는다.');
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
  const sameDirectory=path.join(fixture,'same-pc-restore');fs.mkdirSync(sameDirectory);
  fs.copyFileSync(portableCopy,path.join(sameDirectory,'app-data.db'));
  const restoredDb=new (require('better-sqlite3'))(path.join(sameDirectory,'app-data.db'));
  restoredDb.prepare("INSERT INTO app_meta VALUES('restore_generation','same-pc-restore')").run();restoredDb.close();
  const sameStore=await ApplicationData.initialize({directory:sameDirectory,deviceId:'PC-C',defaults:DEFAULT_CONFIG,clock:()=>stamp},DEFAULT_CONFIG);
  stores.push(sameStore);
  const sameModel=new ProfileSyncModel(()=>sameStore.database,'PC-C',()=>stamp);
  assert.notEqual(sameModel.device,sourceEnvelope.device,'같은 PC 복원도 오프라인 입력 전에 writer를 교체');
  assert.ok(sameModel.pending()>0);
  for (const field of ['ownFile','cursor','boundAccount','transportAccount']) assert.ok(sameModel.meta(field,undefined)==null,field);
  const sameWriter=sameModel.device;sameStore.close();sameStore.reopen();
  assert.equal(sameModel.device,sameWriter,'같은 세대의 일반 재시작은 writer 유지');
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
  const bad=structuredClone(first);bad.cells[k('setting',remote,'userServer')]={...Object.values(bad.cells)[0],value:'not-a-server'};assert.throws(()=>validateProfileSyncEnvelope(bad));
  const forged=structuredClone(first);Object.values(forged.cells)[0].device='imposter';assert.throws(()=>validateProfileSyncEnvelope(forged));
  const changed=structuredClone(first);Object.values(changed.cells)[0].value='changed';persisted.merge(first);assert.throws(()=>persisted.merge(changed),'동일 변경 ID 변조는 거부');
  await checkLegacyUpgradeIdentity();
  await checkLegacyDeviceLocalSettings();
  await checkOvernightHomework();
  await checkProgressEdgeCases();
  await checkMultipleWriters();
  await checkStorageCompatibility();
  await checkForwardCompatibility();
  await checkLegacyAndHeldCells();
  await checkDeletedDefaultHomework();
  const oversized=await create('oversized-legacy-tool');
  const tool='tw-coefficient-calculator-profiles-v1',huge='가'.repeat(2*1024*1024+1);
  assert.throws(()=>oversized.store.saveToolValue(oversized.id,tool,huge),/한도/);
  oversized.store.saveToolValue(oversized.id,tool,'기존 정상값');
  const toolKey=Object.keys(oversized.model.envelope().cells).find(key=>JSON.parse(key)[0]==='tool')!;
  oversized.store.database.prepare('UPDATE profile_tools SET value=? WHERE profile_id=? AND key=?').run(huge,oversized.id,tool);
  for (const table of ['profile_sync_own','profile_sync_sources']) oversized.store.database.prepare(`UPDATE ${table} SET value=json_set(value,'$.value',?) WHERE key=?`).run(huge,toolKey);
  oversized.store.close();oversized.store.reopen();
  const repairedModel=new ProfileSyncModel(oversized.store.database,'oversized-legacy-tool',()=>stamp);
  setting(oversized.store,oversized.id,'pinnedNoteText','프리셋 초과 시 별도 설정은 전송');
  const repairedEnvelope=repairedModel.envelope();
  validateProfileSyncEnvelope(repairedEnvelope);
  assert.ok(!repairedEnvelope.cells[toolKey]);
  assert.ok(Object.values(repairedEnvelope.cells).some((cell:any)=>cell.value==='프리셋 초과 시 별도 설정은 전송'));
  assert.equal(oversized.store.toolValues(oversized.id)[tool],huge);
  assert.equal(repairedModel.oversizedToolCount(),1);
  oversized.store.saveToolValue(oversized.id,tool,'줄인 값');
  assert.equal(repairedModel.envelope().cells[toolKey].value,'줄인 값');
  oversized.store.saveToolValue(oversized.id,tool,'새 프리셋');
  assert.deepEqual(oversized.store.database.prepare("SELECT value FROM profile_change_log WHERE scope='profile-tool' AND profile_id=? AND field=?")
    .all(oversized.id,tool),[{value:JSON.stringify('새 프리셋')}]);
  console.log('PASS profile sync model: atomic journal, compact causal merge, UTC ordering, conflict resolution, profile isolation, tombstones, ACK/restart, cross-PC backup ownership, privacy validation');
}
run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);}).finally(()=>{for(const store of stores) store.close();});
