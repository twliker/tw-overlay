/** 파일에 저장되는 가짜 Google Drive와 재시작 가능한 독립 앱 프로세스로 동기화 시나리오를 검사한다.
 * - 가짜 Drive: loopback HTTP 서버. Drive API 경로·조건부 갱신(If-Match)·변경 목록을 흉내 내고,
 *   상태를 drive-state.json에 저장해 서버를 내렸다 올려도(시간이 흐른 뒤) 같은 "드라이브"를 이어 쓴다.
 * - PC: 별도 Electron 프로세스가 운영 저장소·동기화 모델·coordinator·Drive HTTP 클라이언트를 그대로 쓴다.
 *   같은 데이터 폴더로 다시 띄우면 앱을 껐다 켠 것과 같다.
 * - 검사: v3.2.2 두 PC 업그레이드 병합, 종료 전송(제한 시간·다른 PC 파일 미수신·다음 실행 반영),
 *   전송 전 종료 뒤 재시작(중복 파일·중복 업로드 없음).
 * 실제 Google 계정의 변경 목록 지연·할당량·토큰 갱신은 검증하지 않는다(test:profile-sync:live). */
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
const workerName=arg('--worker'),fixture=arg('--fixture') || fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-sync-scenarios-'));
assert.ok(path.basename(fixture).startsWith('tw-profile-sync-scenarios-'),'임시 검사 폴더만 사용한다');
const directory=path.join(fixture,workerName || 'driver');fs.mkdirSync(directory,{recursive:true});
app.setPath('userData',directory);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name));
const clone=<T>(value:T):T=>structuredClone(value);
const timeout=<T>(work:Promise<T>,label:string,ms=15000):Promise<T>=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`${label}: timed out`)),ms);
  work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});

/** v3.2.2에서 두 PC가 동기화하던 같은 캐릭터 목록. 캐릭터 ID는 v3.2.2 형식(char-시각-난수)이다. */
const V322_CHARACTERS=[{id:'char-m1x7k2-ab3cd',name:'본캐'},{id:'char-m1x7k9-ef4gh',name:'부캐'}];

async function worker():Promise<void> {
  assert.ok(/^PC-[A-D]$/.test(workerName!));assert.ok(process.send,'IPC가 있는 독립 프로세스만 허용');
  const base=new URL(arg('--base-url')!);assert.equal(base.hostname,'127.0.0.1');
  const defaults=clone(built('modules/constants').DEFAULT_CONFIG);
  let now=Date.now();Date.now=()=>now;
  const legacy={...defaults,userServer:7,characterPresets:clone(V322_CHARACTERS),selectedCharacterId:V322_CHARACTERS[0].id};
  const configPath=path.join(directory,'config.json');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath,JSON.stringify(legacy));
  const stamp=()=>({utcMs:now,source:'unverified',uncertaintyMs:null});
  const store=await built('modules/applicationData').ApplicationData.initialize({directory,deviceId:workerName,defaults,clock:stamp},legacy,{value:7});
  const model=new (built('modules/profileSyncModel').ProfileSyncModel)(()=>store.database,workerName,stamp);
  const state={quitting:false};
  const redirectedFetch=(async(input:string | URL,init:RequestInit)=>{
    const original=new URL(String(input));assert.equal(original.hostname,'www.googleapis.com');
    // 경로·본문·헤더·취소는 운영 Drive 클라이언트 그대로 두고, 외부 Google 요청만 loopback 서버로 보낸다.
    return fetch(new URL(original.pathname+original.search,base),init);
  }) as typeof fetch;
  const drive=new (built('modules/profileSyncDrive').GoogleProfileDrive)(redirectedFetch,async()=>`fixture-${workerName}`,async()=>null,()=>{});
  const sync=new (built('modules/profileSyncCoordinator').ProfileSyncCoordinator)(model,drive,{
    account:()=>'fixture@example.invalid',enabled:()=>true,auto:()=>true,activeProfile:()=>undefined,ready:()=>true,
    async beforeImport(){},
    async apply(write:()=>void){
      // 운영과 같이 종료 중에는 프로필 runtime에 원격 변경을 반영하지 않는다.
      if (state.quitting) throw new Error('종료 중에는 원격 변경을 반영하지 않습니다.');
      write();store.ensureEmptyProfile();
    },changed(){},
  },()=>now,()=>0.5);
  const profile=(name:string)=>{const p=store.list().find((item:any)=>item.name===name);assert.ok(p,`${workerName}: ${name}`);return p.id;};
  const snapshot=()=>({device:model.device,pending:model.pending(),cursor:model.meta('cursor',null),connection:sync.details().connection,
    reviews:sync.details().reviews.length,reviewKeys:sync.details().reviews.map((r:any)=>r.key),profiles:store.list().map((p:any)=>({id:p.id,name:p.name,
      memo:store.setting(p.id,'pinnedNoteText'),warn:store.setting(p.id,'buffTimerWarnSeconds')}))});
  process.on('message',async(message:any)=>{
    const {id,operation,args={}}=message;
    try {
      let result:unknown;
      switch(operation) {
        case 'snapshot':result=snapshot();break;
        case 'sync':now+=args.advance ?? 3000;await sync.sync(true);result=snapshot();break;
        case 'choose':await sync.choose(args.choice);result=snapshot();break;
        case 'edit':{
          const target=profile(args.name),config=store.project(target,defaults);Object.assign(config,args.settings || {});
          store.saveProjection(target,config);result=snapshot();break;
        }
        case 'shutdown':{
          // 운영 종료 순서: 종료 플래그 → 자동 동기화 중지 → 제한 시간 안의 종료 전송.
          state.quitting=true;now+=3000;
          const started=performance.now();sync.stop();await sync.flushForShutdown();
          result={...snapshot(),elapsedMs:performance.now()-started};break;
        }
        case 'stop':store.close();process.send!({id,ok:true},()=>app.exit(0));return;
        default:throw new Error(`Unknown worker operation: ${operation}`);
      }
      process.send!({id,ok:true,result});
    } catch(error) {process.send!({id,ok:false,error:error instanceof Error ? error.stack : String(error)});}
  });
  process.send!({ready:true,pid:process.pid});
}

/** 같은 데이터 폴더로 다시 띄우면 그 PC의 앱을 다시 실행한 것과 같다. */
class PC {
  readonly process:ChildProcess;
  readonly ready:Promise<void>;
  log='';private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  constructor(readonly name:string,origin:string) {
    this.process=spawn(process.execPath,[__filename,'--worker',name,'--fixture',fixture,'--base-url',origin],
      {windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    this.process.stdout!.on('data',chunk=>this.log+=String(chunk));this.process.stderr!.on('data',chunk=>this.log+=String(chunk));
    this.ready=new Promise((resolve,reject)=>{
      this.process.on('message',(message:any)=>{
        if(message.ready) {resolve();return;}
        const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);
        if(message.ok)pending.resolve(message.result);else pending.reject(new Error(message.error));
      });
      this.process.once('error',reject);
      this.process.once('exit',code=>{const error=new Error(`${name} exit ${code}\n${this.log.slice(-4000)}`);reject(error);
        for(const pending of this.pending.values())pending.reject(error);this.pending.clear();});
    });
  }
  static async start(name:string,origin:string):Promise<PC> {const pc=new PC(name,origin);await timeout(pc.ready,`${name} startup`,30000);return pc;}
  call(operation:string,args:unknown={}):Promise<any> {
    const id=++this.sequence,work=new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});this.process.send!({id,operation,args},error=>{if(error){this.pending.delete(id);reject(error);}});
    });
    return timeout(work,`${this.name} ${operation}`);
  }
  async stop():Promise<void> {
    if(this.process.exitCode!==null || this.process.killed) return;
    const exited=new Promise<void>(resolve=>this.process.once('exit',()=>resolve()));
    try {await timeout(this.call('stop'),`${this.name} stop`,5000);} catch {this.process.kill();}
    await timeout(exited,`${this.name} exit`,5000).catch(()=>this.process.kill());
  }
}

interface StoredFile {metadata:any;bytes:string;revision:number}
interface DriveState {revision:number;allocated:number;ids:string[];files:Record<string,StoredFile>;
  uploads:Array<{pc:string;fileId:string;sequence:number}>;downloads:Array<{pc:string;fileId:string}>}

/** 상태를 파일에 저장하는 가짜 Google Drive. 서버를 다시 만들면 파일에서 이어서 읽는다. */
class FileDriveServer {
  readonly state:DriveState;
  readonly errors:string[]=[];
  readonly server=http.createServer((request,response)=>{void this.handle(request,response).catch(error=>{
    this.errors.push(String(error));if(!response.headersSent)response.writeHead(500);response.end(String(error));
  });});
  constructor(readonly statePath:string) {
    this.state=fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath,'utf8'))
      : {revision:0,allocated:0,ids:[],files:{},uploads:[],downloads:[]};
  }
  private save():void {fs.writeFileSync(this.statePath,JSON.stringify(this.state,null,2));}
  async start():Promise<string> {
    await new Promise<void>(resolve=>this.server.listen(0,'127.0.0.1',resolve));
    const address=this.server.address();assert.ok(address && typeof address!=='string');return `http://127.0.0.1:${address.port}`;
  }
  async close():Promise<void> {this.server.closeAllConnections();await new Promise<void>(resolve=>this.server.close(()=>resolve()));}
  ownFile(pc:string):StoredFile | undefined {return Object.values(this.state.files).find(file=>file.metadata.appProperties.device===pc);}
  uploadsBy(pc:string):number {return this.state.uploads.filter(item=>item.pc===pc).length;}
  downloadsBy(pc:string):number {return this.state.downloads.filter(item=>item.pc===pc).length;}
  private async handle(request:http.IncomingMessage,response:http.ServerResponse):Promise<void> {
    const url=new URL(request.url!,'http://127.0.0.1'),method=request.method;
    const pc=(request.headers.authorization || '').replace('Bearer fixture-','');assert.ok(/^PC-[A-D]$/.test(pc));
    const reply=(value:unknown,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
    const files=Object.values(this.state.files);
    if(url.pathname==='/drive/v3/changes/startPageToken') {reply({startPageToken:String(this.state.revision)});return;}
    if(url.pathname==='/drive/v3/files/generateIds') {
      const id=`file-${++this.state.allocated}`;this.state.ids.push(id);this.save();reply({ids:[id]});return;
    }
    if(url.pathname==='/drive/v3/files' && method==='GET') {reply({files:files.map(file=>file.metadata)});return;}
    if(url.pathname==='/drive/v3/changes') {
      const since=Number(url.searchParams.get('pageToken'));assert.ok(Number.isSafeInteger(since));
      reply({newStartPageToken:String(this.state.revision),changes:files.filter(file=>file.revision>since)
        .map(file=>({fileId:file.metadata.id,file:file.metadata}))});return;
    }
    const match=url.pathname.match(/^\/(?:upload\/)?drive\/v([23])\/files(?:\/([^/]+))?$/);assert.ok(match,`Unknown fixture route ${method} ${url.pathname}`);
    let fileId=match[2],metadata:any,bytes:Buffer | undefined;
    if(method==='POST' || method==='PUT') {
      const buffers:Buffer[]=[];for await(const chunk of request)buffers.push(Buffer.from(chunk));bytes=Buffer.concat(buffers);
      if(method==='POST') {
        const boundary=String(request.headers['content-type']).split('boundary=')[1];assert.ok(boundary);
        const metaStart=bytes.indexOf('\r\n\r\n')+4,metaEnd=bytes.indexOf(`\r\n--${boundary}\r\n`,metaStart);
        metadata=JSON.parse(bytes.subarray(metaStart,metaEnd).toString());
        const bodyStart=bytes.indexOf('\r\n\r\n',metaEnd+4)+4,bodyEnd=bytes.lastIndexOf(`\r\n--${boundary}--`);
        bytes=bytes.subarray(bodyStart,bodyEnd);fileId=metadata.id;
        assert.ok(this.state.ids.includes(fileId),'발급한 파일 ID로만 만든다');assert.equal(this.state.files[fileId],undefined,'같은 파일 ID 중복 생성 금지');
      }
    }
    const stored=this.state.files[fileId];
    if(method==='GET' && match[1]==='2') {assert.ok(stored);reply({etag:`"v-${stored.metadata.version}"`,version:stored.metadata.version});return;}
    if(method==='GET') {
      assert.ok(stored);assert.equal(url.searchParams.get('alt'),'media');
      this.state.downloads.push({pc,fileId});this.save();
      response.writeHead(200);response.end(Buffer.from(stored.bytes,'base64'));return;
    }
    assert.ok(bytes);const compressed=bytes[0]===0x1f && bytes[1]===0x8b;
    const envelope=JSON.parse((compressed ? gunzipSync(bytes) : bytes).toString());assert.ok(envelope.device===pc || envelope.device.startsWith(pc+':'));
    if(stored)assert.equal(stored.metadata.appProperties.device,pc,'다른 PC 파일은 수정할 수 없음');
    if(method==='PUT' && request.headers['if-match']!==`"v-${stored?.metadata.version}"`) {reply({error:'etag mismatch'},412);return;}
    const version=String(++this.state.revision);
    const meta={...(metadata || stored!.metadata),version,md5Checksum:createHash('md5').update(bytes).digest('hex'),size:String(bytes.length)};
    this.state.files[fileId]={metadata:meta,bytes:bytes.toString('base64'),revision:this.state.revision};
    this.state.uploads.push({pc,fileId,sequence:envelope.sequence});this.save();reply({id:fileId});
  }
}

async function driver():Promise<void> {
  const statePath=path.join(fixture,'drive-state.json');
  let server=new FileDriveServer(statePath),origin=await server.start();
  const running:PC[]=[];
  const start=async(name:string)=>{const pc=await PC.start(name,origin);running.push(pc);return pc;};
  const stop=async(pc:PC)=>{await pc.stop();running.splice(running.indexOf(pc),1);};
  /** 서버를 내렸다가 파일에서 다시 올린다(앱이 꺼진 동안 시간이 흐른 상황). 실행 중인 PC가 없어야 한다. */
  const restartDrive=async()=>{
    assert.equal(running.length,0,'드라이브를 다시 올리기 전 모든 PC를 종료한다');
    assert.deepEqual(server.errors,[]);await server.close();
    server=new FileDriveServer(statePath);origin=await server.start();
  };
  const passed=(name:string)=>console.log(`PASS profile sync scenario: ${name}`);
  const names=(state:any)=>state.profiles.map((p:any)=>p.name).sort();
  const find=(state:any,name:string)=>{const p=state.profiles.find((item:any)=>item.name===name);assert.ok(p,name);return p;};
  try {
    // 1. v3.2.2 두 PC 업그레이드: A가 먼저 올리고 꺼진 뒤, 나중에 B가 켜서 "양쪽 병합"을 고른다.
    let a=await start('PC-A');
    assert.equal((await a.call('sync')).connection,'choice','첫 연결은 데이터 선택을 기다린다');
    await a.call('choose',{choice:'merge'});await a.call('sync');
    assert.ok(server.ownFile('PC-A'),'A의 프로필 파일이 드라이브에 저장된다');
    await stop(a);await restartDrive();
    assert.ok(server.ownFile('PC-A'),'드라이브 상태가 파일에서 이어진다');
    let b=await start('PC-B');
    assert.equal((await b.call('sync')).connection,'choice');
    await b.call('choose',{choice:'merge'});const merged=await b.call('sync');
    assert.deepEqual(names(merged),['본캐','부캐'],'같은 v3.2.2 캐릭터는 병합해도 두 배가 되지 않는다');
    assert.equal(merged.reviews,0,'두 PC가 이전한 같은 값은 확인할 변경으로 남지 않는다: '+JSON.stringify(merged.reviewKeys));
    await b.call('edit',{name:'부캐',settings:{pinnedNoteText:'B에서 고친 부캐 메모'}});await b.call('sync');
    await stop(b);
    a=await start('PC-A');const resumed=await a.call('sync');
    assert.deepEqual(names(resumed),['본캐','부캐'],'다시 켠 A에도 중복 프로필이 생기지 않는다');
    assert.equal(find(resumed,'부캐').memo,'B에서 고친 부캐 메모','다시 켠 A가 B의 변경을 받는다');
    assert.equal(Object.keys(server.state.files).length,2,'PC마다 파일 하나만 쓴다');
    passed('v3.2.2 two-PC upgrade merges the same characters across restarts');

    // 2. 종료 전송: B가 먼저 원격 변경을 올린 상태에서 A가 변경 직후 종료한다.
    b=await start('PC-B');await b.call('sync');
    await b.call('edit',{name:'본캐',settings:{buffTimerWarnSeconds:[33]}});await b.call('sync');
    await a.call('edit',{name:'부캐',settings:{pinnedNoteText:'A 종료 직전 메모'}});
    const beforeShutdown={uploads:server.uploadsBy('PC-A'),downloads:server.downloadsBy('PC-A'),cursor:(await a.call('snapshot')).cursor};
    const shutdown=await a.call('shutdown');
    assert.ok(shutdown.elapsedMs<3000,`종료 전송은 제한 시간 안에 끝난다 (${Math.round(shutdown.elapsedMs)}ms)`);
    assert.equal(shutdown.pending,0,'종료 전에 이 PC의 변경을 전송한다');
    assert.equal(server.uploadsBy('PC-A'),beforeShutdown.uploads+1);
    assert.equal(server.downloadsBy('PC-A'),beforeShutdown.downloads,'종료 중에는 반영하지 않을 다른 PC 파일을 받지 않는다');
    assert.equal(shutdown.cursor,beforeShutdown.cursor,'받지 않은 원격 변경은 다음 실행에서 다시 받도록 확인 위치를 넘기지 않는다');
    assert.deepEqual(find(shutdown,'본캐').warn,find(merged,'본캐').warn,'종료 중에는 원격 변경을 반영하지 않는다');
    await stop(a);
    a=await start('PC-A');const nextRun=await a.call('sync');
    assert.deepEqual(find(nextRun,'본캐').warn,[33],'다음 실행에서 미뤄 둔 원격 변경을 반영한다');
    assert.equal(find(await b.call('sync'),'부캐').memo,'A 종료 직전 메모','B가 종료 전에 보낸 A의 변경을 받는다');
    passed('shutdown upload stays within the limit and defers remote changes to the next run');

    // 3. 전송 전 종료: 변경을 보내기 전에 앱이 꺼져도 다음 실행에서 한 번만 보낸다.
    await a.call('edit',{name:'본캐',settings:{pinnedNoteText:'보내기 전에 꺼진 메모'}});
    const uploadsBeforeCrash=server.uploadsBy('PC-A'),fileId=server.ownFile('PC-A')!.metadata.id;
    await stop(a);await stop(b);await restartDrive();
    a=await start('PC-A');
    assert.ok((await a.call('snapshot')).pending>0,'보내지 못한 변경은 재시작 뒤에도 남는다');
    assert.equal((await a.call('sync')).pending,0);
    assert.equal(server.uploadsBy('PC-A'),uploadsBeforeCrash+1,'재시작 뒤 정확히 한 번 전송한다');
    assert.equal(server.ownFile('PC-A')!.metadata.id,fileId,'같은 자기 파일을 이어 쓴다');
    assert.equal(Object.keys(server.state.files).length,2);
    b=await start('PC-B');
    assert.equal(find(await b.call('sync'),'본캐').memo,'보내기 전에 꺼진 메모');
    passed('restart after an unsent change uploads it once to the same file');
    assert.deepEqual(server.errors,[],'가짜 드라이브 요청 오류 없음');
  } catch (error) {
    for (const pc of running) console.error(`--- ${pc.name} log ---\n${pc.log.slice(-3000)}`);
    throw error;
  } finally {
    for (const pc of [...running]) await stop(pc).catch(()=>{});
    await server.close().catch(()=>{});
  }
}

if (workerName) {
  app.whenReady().then(worker).catch(error=>{console.error(error);app.exit(1);});
} else {
  app.whenReady().then(driver).then(()=>{
    // 이 프로세스의 데이터 폴더(driver)는 실행 중 잠겨 있다. PC 폴더와 드라이브 파일만 지우고 나머지는 OS 임시 정리에 맡긴다.
    for (const name of fs.readdirSync(fixture)) {
      if (name==='driver') continue;
      try {fs.rmSync(path.join(fixture,name),{recursive:true,force:true});} catch {/* 임시 폴더 정리 실패는 결과와 무관하다. */}
    }
    app.exit(0);
  },error=>{console.error(error);console.error(`검사 폴더: ${fixture}`);app.exit(1);});
}
