/** 두 Electron 프로세스/별도 SQLite + 운영 Drive HTTP/coordinator의 동시성 검사.
 * Google 서버만 loopback 대역이다. 실제 요청을 보류해 겹침과 응답 순서를 확인한다.
 * 실제 Google 계정/물리 PC 2대 검증을 대신하지 않으며 사용자 데이터는 사용하지 않는다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import http=require('node:http');
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {spawn,type ChildProcess} from 'node:child_process';
import {app} from 'electron';

const root=path.resolve(__dirname,'..');
const arg=(name:string)=>{const index=process.argv.indexOf(name);return index<0 ? undefined : process.argv[index+1];};
const workerName=arg('--worker'),fixture=arg('--fixture') || fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-concurrency-'));
assert.equal(path.dirname(fs.realpathSync(fixture)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
assert.ok(path.basename(fixture).startsWith('tw-profile-concurrency-'));
const marker=path.join(fixture,'owned-fixture');
if (workerName) assert.equal(fs.readFileSync(marker,'utf8'),'profile concurrency');else fs.writeFileSync(marker,'profile concurrency');
const directory=path.join(fixture,workerName || 'driver');fs.mkdirSync(directory,{recursive:true});
app.setPath('userData',directory);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name));
const clone=<T>(value:T):T=>structuredClone(value);
const timeout=<T>(work:Promise<T>,label:string,ms=10000):Promise<T>=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`${label}: timed out`)),ms);
  work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});

async function worker():Promise<void> {
  assert.ok(['PC-A','PC-B'].includes(workerName!));assert.ok(process.send,'IPC가 있는 독립 프로세스만 허용');
  const base=new URL(arg('--base-url')!);assert.equal(base.hostname,'127.0.0.1');
  const defaults=clone(built('modules/constants').DEFAULT_CONFIG);let now=Date.now();Date.now=()=>now;
  defaults.contentsCheckerItems=[{id:'task',name:'동시성 숙제',category:'일일',isCustom:true,isVisible:true,
    resetRule:{type:'daily',hour:6},maxCount:5,completedState:{}}];
  const legacy={...defaults,userServer:7,characterPresets:workerName==='PC-A' ? [{id:'old-A',name:'프로필 A'},{id:'old-B',name:'프로필 B'}] : [],selectedCharacterId:'old-A'};
  fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(workerName==='PC-A' ? legacy : {}));
  const stamp=()=>({utcMs:now,source:'unverified',uncertaintyMs:null});
  const store=await built('modules/applicationData').ApplicationData.initialize({directory,deviceId:workerName,defaults,clock:stamp},legacy,{value:workerName==='PC-A' ? 7 : undefined});
  const model=new (built('modules/profileSyncModel').ProfileSyncModel)(()=>store.database,workerName,stamp);
  const state={active:undefined as string | undefined,account:'fixture@example.invalid'};
  const redirectedFetch=(async(input:string | URL,init:RequestInit)=>{
    const original=new URL(String(input));assert.equal(original.hostname,'www.googleapis.com');
    // 경로/본문/헤더/취소는 운영 transport 그대로, 외부 Google 요청만 loopback으로 전환한다.
    return fetch(new URL(original.pathname+original.search,base),init);
  }) as typeof fetch;
  const drive=new (built('modules/profileSyncDrive').GoogleProfileDrive)(redirectedFetch,async()=>`fixture-${workerName}`,async()=>null,()=>{});
  const sync=new (built('modules/profileSyncCoordinator').ProfileSyncCoordinator)(model,drive,{
    account:()=>state.account || null,enabled:()=>true,auto:()=>false,activeProfile:()=>state.active,ready:()=>true,
    async beforeImport(){},async apply(write:()=>void){write();store.ensureEmptyProfile();},changed(){},
  },()=>now,()=>0.5);
  const profile=(name:string)=>{const p=store.list().find((p:any)=>p.name===name);assert.ok(p,`${workerName}: ${name}`);return p.id;};
  const snapshot=()=>({pid:process.pid,device:model.device,pending:model.pending(),cursor:model.meta('cursor',null),
    active:state.active,details:sync.details(),envelope:model.envelope(),profiles:store.list().map((p:any)=>({id:p.id,name:p.name,
      memo:store.setting(p.id,'pinnedNoteText'),warn:store.setting(p.id,'buffTimerWarnSeconds'),
      homework:store.homework(p.id).map((item:any)=>({id:item.id,...item.completedState[p.id]}))}))});
  process.on('message',async(message:any)=>{
    const {id,operation,args={}}=message;
    try {
      let result:unknown;
      switch(operation) {
        case 'snapshot':result=snapshot();break;
        case 'sync':now+=args.advance ?? 3000;await sync.sync(true);result=snapshot();break;
        case 'choose':await sync.choose(args.choice);result=snapshot();break;
        case 'use':state.active=profile(args.name);result=state.active;break;
        case 'edit':{
          const id=profile(args.name),config=store.project(id,defaults);Object.assign(config,args.settings || {});
          if(args.count!==undefined) config.contentsCheckerItems[0].completedState[id]={currentCount:args.count,isCompleted:false,lastCompletedAt:now};
          store.saveProjection(id,config);result=snapshot();break;
        }
        case 'resolve':await sync.resolve(args.key,args.candidate || 'local');result=snapshot();break;
        case 'create':result=store.create(args.name,7);break;
        case 'remove':store.remove(profile(args.name));result=snapshot();break;
        case 'logout':state.account='';sync.cancel();result=snapshot();break;
        case 'login':state.account='fixture@example.invalid';result=snapshot();break;
        case 'stop':store.close();process.send!({id,ok:true},()=>app.exit(0));return;
        default:throw new Error(`Unknown worker operation: ${operation}`);
      }
      process.send!({id,ok:true,result});
    } catch(error) {process.send!({id,ok:false,error:error instanceof Error ? error.stack : String(error)});}
  });
  process.send!({ready:true,pid:process.pid});
}

class PC {
  readonly process:ChildProcess;
  readonly ready:Promise<void>;
  log='';pid=0;private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  constructor(readonly name:string,origin:string) {
    this.process=spawn(process.execPath,[__filename,'--worker',name,'--fixture',fixture,'--base-url',origin],
      {windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    this.process.stdout!.on('data',chunk=>this.log+=String(chunk));this.process.stderr!.on('data',chunk=>this.log+=String(chunk));
    this.ready=new Promise((resolve,reject)=>{
      this.process.on('message',(message:any)=>{
        if(message.ready) {this.pid=message.pid;resolve();return;}
        const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);
        if(message.ok)pending.resolve(message.result);else pending.reject(new Error(message.error));
      });
      this.process.once('error',reject);
      this.process.once('exit',code=>{const error=new Error(`${name} exit ${code}\n${this.log.slice(-4000)}`);reject(error);
        for(const pending of this.pending.values())pending.reject(error);this.pending.clear();});
    });
  }
  call(operation:string,args:unknown={}):Promise<any> {
    const id=++this.sequence,work=new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});this.process.send!({id,operation,args},error=>{if(error){this.pending.delete(id);reject(error);}});
    });
    return timeout(work,`${this.name} ${operation}`,20000);
  }
  async stop():Promise<void> {
    if(this.process.exitCode===null && !this.process.killed) {
      try {await timeout(this.call('stop'),'worker shutdown',2000);} catch {this.process.kill();}
    }
  }
}

interface StoredFile {metadata:any;bytes:Buffer;envelope:any;revision:number}
interface Held {pc:string;fileId:string;kind:'upload' | 'download';done:boolean;finish:(status?:number)=>void}
class Gate {
  readonly held:Held[]=[];readonly order:string[]=[];readonly ready:Promise<void>;
  private complete!:()=>void;
  constructor(readonly label:string,readonly count:number,readonly matches:(value:Held)=>boolean) {
    this.ready=new Promise(resolve=>this.complete=resolve);
  }
  capture(value:Held):boolean {
    if(this.held.length>=this.count || !this.matches(value))return false;
    this.held.push(value);if(this.held.length===this.count)this.complete();return true;
  }
  release(pc:string,status?:number):void {
    const held=this.held.find(v=>v.pc===pc && !v.done);assert.ok(held,`${this.label}: ${pc}의 대기 요청 필요`);
    held.done=true;this.order.push(pc);held.finish(status);
  }
  releaseAll():void {for(const value of this.held)if(!value.done)this.release(value.pc);}
}

class DriveServer {
  readonly files=new Map<string,StoredFile>();
  readonly uploads:Array<{pc:string;fileId:string;sequence:number;version:string}>=[];
  readonly errors:string[]=[];requests=0;compressedUploads=0;maxHeldUploads=0;
  gate:Gate | undefined;private revision=0;private allocated=0;private ids=new Set<string>();
  readonly server=http.createServer((request,response)=>{void this.handle(request,response).catch(error=>{
    this.errors.push(String(error));if(!response.headersSent)response.writeHead(500);response.end(String(error));
  });});
  async start():Promise<string> {
    await new Promise<void>(resolve=>this.server.listen(0,'127.0.0.1',resolve));
    const address=this.server.address();assert.ok(address && typeof address!=='string');return `http://127.0.0.1:${address.port}`;
  }
  async close():Promise<void> {
    this.gate?.releaseAll();this.server.closeAllConnections();await new Promise<void>(resolve=>this.server.close(()=>resolve()));
  }
  private async handle(request:http.IncomingMessage,response:http.ServerResponse):Promise<void> {
    this.requests++;const url=new URL(request.url!,'http://127.0.0.1'),method=request.method;
    const pc=(request.headers.authorization || '').replace('Bearer fixture-','');assert.ok(['PC-A','PC-B'].includes(pc));
    const reply=(value:unknown,status=200,headers:Record<string,string>={})=>{
      response.writeHead(status,{'Content-Type':'application/json',...headers});response.end(JSON.stringify(value));
    };
    if(url.pathname==='/drive/v3/changes/startPageToken') {reply({startPageToken:String(this.revision)});return;}
    if(url.pathname==='/drive/v3/files/generateIds') {const id=`file-${++this.allocated}`;this.ids.add(id);reply({ids:[id]});return;}
    if(url.pathname==='/drive/v3/files' && method==='GET') {reply({files:[...this.files.values()].map(file=>file.metadata)});return;}
    if(url.pathname==='/drive/v3/changes') {
      const since=Number(url.searchParams.get('pageToken'));assert.ok(Number.isSafeInteger(since));
      reply({newStartPageToken:String(this.revision),changes:[...this.files.values()].filter(file=>file.revision>since)
        .map(file=>({fileId:file.metadata.id,file:file.metadata}))});return;
    }
    const match=url.pathname.match(/^\/(?:upload\/)?drive\/v([23])\/files(?:\/([^/]+))?$/);assert.ok(match,`Unknown fixture route ${method} ${url.pathname}`);
    let fileId=match[2],metadata:any,bytes:Buffer | undefined;
    if(method==='POST' || method==='PUT') {
      const buffers:Buffer[]=[];for await(const chunk of request)buffers.push(Buffer.from(chunk));bytes=Buffer.concat(buffers);
      if(method==='POST') {
        const boundary=String(request.headers['content-type']).split('boundary=')[1];assert.ok(boundary);
        const metaStart=bytes.indexOf('\r\n\r\n')+4,metaEnd=bytes.indexOf(`\r\n--${boundary}\r\n`,metaStart);
        assert.ok(metaStart>=4 && metaEnd>metaStart);metadata=JSON.parse(bytes.subarray(metaStart,metaEnd).toString());
        const bodyStart=bytes.indexOf('\r\n\r\n',metaEnd+4)+4,bodyEnd=bytes.lastIndexOf(`\r\n--${boundary}--`);
        assert.ok(bodyStart>metaEnd && bodyEnd>bodyStart);bytes=bytes.subarray(bodyStart,bodyEnd);fileId=metadata.id;
        assert.ok(this.ids.has(fileId));assert.deepEqual(metadata.parents,['appDataFolder']);assert.equal(metadata.appProperties.twProfileSync,'1');
        assert.equal(this.files.has(fileId),false,'파일 지정 ID 중복 생성 금지');
      }
    }
    const stored=this.files.get(fileId);
    if(method==='GET' && match[1]==='2') {assert.ok(stored);reply({etag:`"v-${stored.metadata.version}"`,version:stored.metadata.version});return;}
    if(method==='GET') {
      assert.ok(stored);assert.equal(url.searchParams.get('alt'),'media');const frozen=Buffer.from(stored.bytes);
      const held:Held={pc,fileId,kind:'download',done:false,finish:()=>{if(!response.destroyed){response.writeHead(200);response.end(frozen);}}};
      if(!this.gate?.capture(held))held.finish();return;
    }
    assert.ok(bytes);const compressed=bytes[0]===0x1f && bytes[1]===0x8b;
    const envelope=JSON.parse((compressed ? gunzipSync(bytes) : bytes).toString());assert.ok(envelope.device===pc || envelope.device.startsWith(pc+':'));
    if(stored)assert.equal(stored.envelope.device,envelope.device,'다른 PC 파일은 수정할 수 없음');
    const payload=Buffer.from(bytes),held:Held={pc,fileId,kind:'upload',done:false,finish:(status=200)=>{
      if(status!==200) {reply({error:'fixture request limit'},status,{'Retry-After':'60'});return;}
      const current=this.files.get(fileId);
      if(method==='PUT' && request.headers['if-match']!==`"v-${current?.metadata.version}"`) {reply({error:'etag mismatch'},412);return;}
      if(compressed)this.compressedUploads++;const version=String(++this.revision);
      const meta={...(metadata || current!.metadata),version,md5Checksum:createHash('md5').update(payload).digest('hex'),size:String(payload.length)};
      this.files.set(fileId,{metadata:meta,bytes:payload,envelope:clone(envelope),revision:this.revision});
      this.uploads.push({pc,fileId,sequence:envelope.sequence,version});reply({id:fileId});
    }};
    if(this.gate?.capture(held))this.maxHeldUploads=Math.max(this.maxHeldUploads,this.gate.held.filter(value=>value.kind==='upload' && !value.done).length);
    else held.finish();
  }
}

async function driver():Promise<void> {
  const output=path.join(root,'output/profile-sync-concurrency'),runId=new Date().toISOString().replace(/[:.]/g,'-');
  const runDirectory=path.join(output,runId);fs.mkdirSync(runDirectory,{recursive:true});
  const sourceFiles=['scripts/check-profile-sync-concurrency.ts','src/modules/applicationData.ts','src/modules/profileSyncModel.ts','src/modules/profileSyncDrive.ts','src/modules/profileSyncCoordinator.ts'];
  const hashes=()=>Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
  const report:any={status:'running',startedAt:new Date().toISOString(),twoProcesses:true,actualHTTP:true,
    realGoogleVerified:false,twoPhysicalPCsVerified:false,testedFiles:hashes(),checks:[],overlaps:[]};
  const save=()=>{fs.writeFileSync(path.join(runDirectory,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify(report,null,2));};save();
  const server=new DriveServer(),pcs:PC[]=[];
  const passed=(name:string)=>{report.checks.push(name);save();console.log(`PASS concurrent sync: ${name}`);};
  try {
    const origin=await server.start(),a=new PC('PC-A',origin),b=new PC('PC-B',origin);pcs.push(a,b);
    await timeout(Promise.all(pcs.map(pc=>pc.ready)),'two worker startup');assert.notEqual(a.pid,b.pid);assert.notEqual(a.pid,process.pid);
    report.pids={driver:process.pid,a:a.pid,b:b.pid};
    await a.call('sync');await b.call('sync');await b.call('choose',{choice:'remote'});
    await a.call('use',{name:'프로필 A'});await b.call('use',{name:'프로필 B'});
    const states=async()=>Promise.all(pcs.map(pc=>pc.call('snapshot')));
    const flush=async()=>{for(let round=0;round<2;round++)await Promise.all(pcs.map(pc=>pc.call('sync')));};
    const p=(state:any,name='프로필 A')=>{const profile=state.profiles.find((p:any)=>p.name===name);assert.ok(profile,name);return profile;};
    const memoReview=(state:any)=>state.details.reviews.find((r:any)=>(JSON.parse(r.key) as string[])[2]==='pinnedNoteText');
    const countReview=(state:any)=>state.details.reviews.find((r:any)=>(JSON.parse(r.key) as string[])[3]==='progress');
    const concurrent=async(label:string,order:PC[],failure?:string)=>{
      const gate=new Gate(label,2,value=>value.kind==='upload');server.gate=gate;
      const jobs=new Map(pcs.map(pc=>[pc.name,pc.call('sync')]));for(const job of jobs.values())void job.catch(()=>{});
      try {
        await timeout(gate.ready,label);assert.equal(new Set(gate.held.map(v=>v.fileId)).size,2,'동시 요청은 각자 자신의 파일에 전송');
        for(const pc of order) {
          gate.release(pc.name,pc.name===failure ? 429 : undefined);
          if(pc.name===failure)await assert.rejects(jobs.get(pc.name)!,/한도|저장공간/);else await jobs.get(pc.name);
        }
        report.overlaps.push({label,writers:gate.held.map(v=>v.pc),fileIds:gate.held.map(v=>v.fileId),completionOrder:gate.order});save();
      } finally {gate.releaseAll();server.gate=undefined;await Promise.allSettled(jobs.values());}
    };
    // 서로 다른 프로필을 사용하는 두 PC가 같은 시점에 수정/전송한다.
    await Promise.all([a.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'A 전용 변경'},count:1}),
      b.call('edit',{name:'프로필 B',settings:{pinnedNoteText:'B 전용 변경'},count:2})]);
    await concurrent('different profiles, B response first',[b,a]);await flush();let [sa,sb]=await states();
    for(const state of [sa,sb]) {assert.equal(p(state).memo,'A 전용 변경');assert.equal(p(state,'프로필 B').memo,'B 전용 변경');
      assert.equal(p(state).homework[0].currentCount,1);assert.equal(p(state,'프로필 B').homework[0].currentCount,2);assert.equal(state.pending,0);}
    assert.equal(sa.active,p(sa).id);assert.equal(sb.active,p(sb,'프로필 B').id);passed('different profiles and independent selection');
    // 같은 프로필의 서로 다른 필드, 반대 응답 순서.
    await Promise.all([a.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'서로 다른 필드'}}),
      b.call('edit',{name:'프로필 A',settings:{buffTimerWarnSeconds:[17]}})]);
    await concurrent('different fields, A response first',[a,b]);await flush();[sa,sb]=await states();
    for(const state of [sa,sb]) {assert.equal(p(state).memo,'서로 다른 필드');assert.deepEqual(p(state).warn,[17]);assert.equal(state.details.reviews.length,0);}
    passed('same profile, different fields merge');
    await Promise.all([a.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'A 동시 입력'}}),b.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'B 동시 입력'}})]);
    await concurrent('same field conflict',[b,a]);await flush();[sa,sb]=await states();
    assert.equal(p(sa).memo,'A 동시 입력');assert.equal(p(sb).memo,'B 동시 입력');
    for(const state of [sa,sb])assert.deepEqual(memoReview(state).candidates.map((c:any)=>c.value).sort(),['A 동시 입력','B 동시 입력']);
    await a.call('resolve',{key:memoReview(sa).key});await flush();[sa,sb]=await states();
    for(const state of [sa,sb]) {assert.equal(p(state).memo,'A 동시 입력');assert.equal(state.details.reviews.length,0);}
    passed('same field conflict and shared resolution');
    await Promise.all([a.call('edit',{name:'프로필 A',count:2}),b.call('edit',{name:'프로필 A',count:4})]);
    await concurrent('homework progress conflict',[a,b]);await flush();[sa,sb]=await states();
    assert.equal(p(sa).homework[0].currentCount,2);assert.equal(p(sb).homework[0].currentCount,4);
    for(const state of [sa,sb])assert.deepEqual(countReview(state).candidates.map((c:any)=>c.value.state.currentCount).sort(),[2,4]);
    await b.call('resolve',{key:countReview(sb).key});await flush();[sa,sb]=await states();
    for(const state of [sa,sb]) {assert.equal(p(state).homework[0].currentCount,4);assert.equal(state.details.reviews.length,0);}
    passed('homework progress preserved without sum or max merge');
    await Promise.all(pcs.map(pc=>pc.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'양쪽 같은 값'}})));
    await concurrent('identical simultaneous values',[b,a]);await flush();const stableUploads=server.uploads.length;await flush();
    for(const state of await states()) {assert.equal(p(state).memo,'양쪽 같은 값');assert.equal(state.details.reviews.length,0);assert.equal(state.pending,0);}
    assert.equal(server.uploads.length,stableUploads,'수신 반복으로 업로드가 무한 발생하지 않음');passed('identical edits without conflict or upload loop');
    // 수신 본문이 전송 중인 동안 새 로컬 입력이 저장된다.
    await b.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'B 수신 중 값'}});await b.call('sync');
    const bFile=[...server.files.values()].find(file=>file.envelope.device.startsWith('PC-B'))!.metadata.id;
    let gate=new Gate('edit while downloading',1,value=>value.kind==='download' && value.pc===a.name && value.fileId===bFile);server.gate=gate;
    let job=a.call('sync');void job.catch(()=>{});await timeout(gate.ready,gate.label);
    await a.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'A 수신 중 새 입력'}});gate.release(a.name);await job;server.gate=undefined;
    await flush();[sa,sb]=await states();assert.equal(p(sa).memo,'A 수신 중 새 입력');
    assert.deepEqual(memoReview(sa).candidates.map((c:any)=>c.value).sort(),['A 수신 중 새 입력','B 수신 중 값']);
    await a.call('resolve',{key:memoReview(sa).key});await flush();passed('local edit during remote HTTP download');
    // 업로드 본문과 ACK가 고정된 뒤 저장한 새 값은 다음 전송으로 남는다.
    await a.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'전송한 과거 값'}});
    gate=new Gate('edit while uploading',1,value=>value.kind==='upload' && value.pc===a.name);server.gate=gate;
    job=a.call('sync');void job.catch(()=>{});await timeout(gate.ready,gate.label);
    await a.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'전송 중 새 저장'}});gate.release(a.name);await job;server.gate=undefined;
    sa=await a.call('snapshot');assert.ok(sa.pending>0);assert.equal(p(sa).memo,'전송 중 새 저장');
    await flush();for(const state of await states()){assert.equal(p(state).memo,'전송 중 새 저장');assert.equal(state.pending,0);}
    passed('new save survives delayed upload acknowledgement');
    await Promise.all([a.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'A 성공 값'}}),b.call('edit',{name:'프로필 B',settings:{pinnedNoteText:'B 제한 후 복구'}})]);
    await concurrent('one PC rate limited',[a,b],b.name);[sa,sb]=await states();assert.equal(sa.pending,0);assert.ok(sb.pending>0);
    await Promise.all(pcs.map(pc=>pc.call('sync',{advance:60_001})));await flush();
    for(const state of await states()){assert.equal(p(state).memo,'A 성공 값');assert.equal(p(state,'프로필 B').memo,'B 제한 후 복구');assert.equal(state.pending,0);}
    passed('one PC fails while the other commits, then recovers');
    // 연결 해제 중 늦게 도착한 HTTP 본문은 cursor/로컬 데이터에 적용하지 않는다.
    await b.call('edit',{name:'프로필 A',settings:{pinnedNoteText:'연결 해제 후 받을 값'}});await b.call('sync');
    const beforeCancel=await a.call('snapshot');gate=new Gate('cancel download',1,value=>value.kind==='download' && value.pc===a.name && value.fileId===bFile);server.gate=gate;
    job=a.call('sync');void job.catch(()=>{});await timeout(gate.ready,gate.label);await a.call('logout');
    await assert.rejects(job,/abort|취소/i);gate.release(a.name);server.gate=undefined;sa=await a.call('snapshot');
    assert.equal(sa.cursor,beforeCancel.cursor);assert.equal(p(sa).memo,p(beforeCancel).memo);
    await a.call('login');await a.call('sync',{advance:60_001});await flush();
    assert.equal(p(await a.call('snapshot')).memo,'연결 해제 후 받을 값');passed('logout cancels in-flight receive without advancing cursor');
    await a.call('create',{name:'삭제 대상'});await flush();
    await Promise.all([a.call('remove',{name:'삭제 대상'}),b.call('edit',{name:'삭제 대상',settings:{pinnedNoteText:'삭제 전 늦은 입력'}})]);
    await concurrent('delete versus stale edit',[b,a]);await flush();
    for(const state of await states())assert.equal(state.profiles.some((profile:any)=>profile.name==='삭제 대상'),false);
    assert.equal(server.files.size,2,'작업마다 전송 파일을 추가하지 않음');passed('deletion survives another PC stale edit');
    assert.equal(server.errors.length,0,server.errors.join('\n'));assert.ok(server.maxHeldUploads>=2);assert.ok(server.compressedUploads>0);
    assert.deepEqual(hashes(),report.testedFiles,'검사 중 소스가 변경되지 않음');report.status='passed';
    console.log(`PASS two-process profile sync concurrency: ${report.checks.length} scenarios, ${report.overlaps.length} overlapping upload pairs`);
  } catch(error) {report.status='failed';report.error=error instanceof Error ? error.stack : String(error);throw error;}
  finally {
    server.gate?.releaseAll();await Promise.allSettled(pcs.map(pc=>pc.stop()));await server.close();
    for(const pc of pcs)fs.writeFileSync(path.join(runDirectory,pc.name+'.log'),pc.log);
    report.requests=server.requests;report.uploads=server.uploads.length;report.maxConcurrentUploads=server.maxHeldUploads;
    report.compressedUploads=server.compressedUploads;report.completedAt=new Date().toISOString();save();
  }
}

app.whenReady().then(()=>workerName ? worker() : driver()).then(()=>{if(!workerName)app.exit(0);},error=>{console.error(error);app.exit(1);});
