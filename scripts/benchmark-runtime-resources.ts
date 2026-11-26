/** 실행 리소스 비교 측정(v3.2.2 태그 빌드 ↔ 현재 빌드). 실제 게임 없이 같은 사냥 채팅 로그를 실시간 감시 경로에 흘려
 * 메인 프로세스 메모리(RSS)·CPU·디스크 쓰기·DB 커밋 수·이벤트 루프 지연·기믹 알림 지연을 잰다.
 *
 * - 비교 모드(node): node dist-tools/benchmark-runtime-resources.js [--duration 60] [--rate 40] [--repeat 2]
 *     [--affinities all,3,1] [--builds baseline,current] [--writer batch|spread] [--out output/runtime-benchmark/result.json]
 *   --writer spread는 게임이 줄마다 따로 쓰는 경우(읽기 한 번에 한 줄)다. 기본 batch는 100ms마다 몇 줄씩 쓴다.
 *   --mix tw는 실제 테일즈위버 사냥(경험치 줄만, 30초마다 정수 교환, 60초마다 기믹 알림, 줄마다 따로 씀)이다.
 *   실제 사냥 평균에 맞추려면 --rate 2.3 을 함께 준다. 기본 mixed는 득템·SEED·채팅이 섞인 부하용 비율이다.
 *   v3.2.2 빌드는 prepare-upgrade-baseline.js로 output/profile-upgrade-baseline/v3.2.2에 만든다.
 * - 측정 모드(electron): electron dist-tools/benchmark-runtime-resources.js --run --build <루트> --out <json> ...
 *   `--affinity <마스크>`를 주면 앱 준비 전에 프로세스 affinity를 제한한다(GPU·로그 작성 프로세스도 상속).
 *
 * 로그 작성은 별도 프로세스(benchmark-log-writer.js)가 해 앱 프로세스의 쓰기 횟수에 섞이지 않는다.
 * 현재 빌드는 게임 실행 중·프로필 선택 상태(사냥 중 실제 경로)로, v3.2.2는 그 버전의 main.ts 순서대로 감시를 시작한다.
 * 알림 지연은 기믹 줄을 파일에 쓴 시각부터 파서가 SPECIAL_MONSTER_SPAWN을 발행한 시각까지다(알림 처리기와 같은 동기 호출). */
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {execFileSync,fork} from 'node:child_process';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';

const root=path.resolve(__dirname,'..');
const argument=(name:string,fallback?:string)=>{const index=process.argv.indexOf(name);return index<0 ? fallback : process.argv[index+1];};
const BASELINE=path.join(root,'output/profile-upgrade-baseline/v3.2.2');

interface RunResult {
  label:string;version:string;affinity:string;cores:number;durationS:number;rate:number;writer:string;
  linesWritten:number;events:Record<string,number>;
  rssMB:{start:number;end:number;max:number};heapUsedMB:{start:number;end:number};allProcessesMB:{end:number};
  cpu:{mainPctOfCore:number;mainCpuMs:number;cpuMsPer1000Lines:number;mainThreadMs:number;mainThreadPctOfCore:number;mainThreadMsPer1000Lines:number};
  io:{writeOps:number;writeKB:number;otherOps:number;readOps:number;writeOpsPerSec:number};
  commits:{transactions:number;autocommitWrites:number;perSec:number};
  eventLoopMs:{p50:number;p95:number;p99:number;max:number};dbMsPerSec:number;
  alertLatencyMs:{n:number;expected:number;p50:number;p95:number;max:number};
  retainedLogLines:{lines:number;chars:number};
  dbFilesKB:Record<string,number>;dbGrowthMBPerHour:number;
  /** 측정 구간에 늘어난 테이블·인덱스별 행 수와 KB(dbstat, 본 DB 파일 기준). */
  tableGrowth?:{file:string;name:string;rows?:number;KB:number;KBPerHour:number}[];
}

const round=(value:number,digits=1)=>Number(value.toFixed(digits));
function percentile(values:number[],p:number):number {
  if (!values.length) return NaN;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(p/100*sorted.length)-1)];
}

/* ───────────── 측정 모드 (Electron 메인 프로세스) ───────────── */
async function measure():Promise<void> {
  const koffi=require('koffi');
  const kernel32=koffi.load('kernel32.dll');
  const GetCurrentProcess=kernel32.func('__stdcall','GetCurrentProcess','void *',[]);
  const IoCounters=koffi.struct({ReadOperationCount:'uint64',WriteOperationCount:'uint64',OtherOperationCount:'uint64',
    ReadTransferCount:'uint64',WriteTransferCount:'uint64',OtherTransferCount:'uint64'});
  const GetProcessIoCounters=kernel32.func('__stdcall','GetProcessIoCounters','bool',['void *',koffi.out(koffi.pointer(IoCounters))]);
  const SetProcessAffinityMask=kernel32.func('__stdcall','SetProcessAffinityMask','bool',['void *','uintptr']);
  const affinity=argument('--affinity','all')!;
  if (affinity!=='all' && !SetProcessAffinityMask(GetCurrentProcess(),BigInt(affinity))) throw new Error('affinity 설정 실패');
  const io=()=>{const value:Record<string,number|bigint>={};GetProcessIoCounters(GetCurrentProcess(),value);
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,Number(v)])) as Record<string,number>;};
  // 메인 프로세스 전체 스레드의 CPU 시간(100ns 단위). process.cpuUsage는 일부 실행에서 0을 돌려줘 직접 읽는다.
  const FileTime=koffi.struct({low:'uint32',high:'uint32'});
  const GetProcessTimes=kernel32.func('__stdcall','GetProcessTimes','bool',['void *',koffi.out(koffi.pointer(FileTime)),
    koffi.out(koffi.pointer(FileTime)),koffi.out(koffi.pointer(FileTime)),koffi.out(koffi.pointer(FileTime))]);
  const cpuMs=()=>{
    const created={},exited={},kernel:{low?:number;high?:number}={},user:{low?:number;high?:number}={};
    GetProcessTimes(GetCurrentProcess(),created,exited,kernel,user);
    const ms=(t:{low?:number;high?:number})=>((t.high ?? 0)*2**32+(t.low ?? 0))/1e4;
    return {kernel:ms(kernel),user:ms(user)};
  };
  // JS 메인 스레드만의 CPU 시간. 프로세스 전체는 Chromium·V8 보조 스레드 때문에 같은 빌드도 실행마다 5배까지 흔들린다.
  const GetCurrentThread=kernel32.func('__stdcall','GetCurrentThread','void *',[]);
  const GetThreadTimes=kernel32.func('__stdcall','GetThreadTimes','bool',['void *',koffi.out(koffi.pointer(FileTime)),
    koffi.out(koffi.pointer(FileTime)),koffi.out(koffi.pointer(FileTime)),koffi.out(koffi.pointer(FileTime))]);
  const threadCpuMs=()=>{
    const created={},exited={},kernel:{low?:number;high?:number}={},user:{low?:number;high?:number}={};
    GetThreadTimes(GetCurrentThread(),created,exited,kernel,user);
    const ms=(t:{low?:number;high?:number})=>((t.high ?? 0)*2**32+(t.low ?? 0))/1e4;
    return ms(kernel)+ms(user);
  };

  const build=path.resolve(argument('--build',root)!);
  const durationS=Number(argument('--duration','60')),rate=Number(argument('--rate','40'));
  const writerMode=argument('--writer','batch')!,mix=argument('--mix','mixed')!;
  const out=path.resolve(argument('--out')!);
  // --user-data <폴더>: 이전 실행이 만든 userData를 다시 쓴다(첫 실행 이전·백업 비용을 뺀 두 번째 실행 측정).
  // --setup-only: 감시 시작까지 준비하고 측정 없이 끝낸다(userData를 남긴다).
  const reuse=argument('--user-data'),setupOnly=process.argv.includes('--setup-only');
  const fixture=reuse ? path.resolve(reuse) : fs.mkdtempSync(path.join(os.tmpdir(),'tw-runtime-bench-'));
  if (reuse) fs.mkdirSync(fixture,{recursive:true});
  process.env.TW_OVERLAY_DISABLE_ANALYTICS='1';
  const {app}=require('electron') as typeof import('electron');
  app.setPath('userData',fixture);
  app.on('window-all-closed',()=>{});

  // DB 커밋 수: 바깥 transaction 완료와 transaction 밖에서 실행한 쓰기 문장을 센다(앱 모듈보다 먼저 패치).
  // dbMs: 메인 스레드가 바깥 transaction·자동 커밋 문장 안에 머문 시간(디스크 flush 대기 포함).
  const commits={transactions:0,autocommitWrites:0,dbMs:0};
  // BENCH_TRACE_SQL=1: 커밋을 일으킨 문장별로 센다(transaction은 안에서 처음 실행한 쓰기 문장 기준).
  const trace=process.env.BENCH_TRACE_SQL==='1' ? new Map<string,number>() : undefined;
  let currentTransaction:{first?:string} | undefined;
  const traced=(key:string)=>{if (trace) trace.set(key,(trace.get(key) ?? 0)+1);};
  const Database=require(require.resolve('better-sqlite3',{paths:[build]}));
  const originalTransaction=Database.prototype.transaction;
  Database.prototype.transaction=function(this:any,fn:(...args:unknown[])=>unknown) {
    const transaction=originalTransaction.call(this,fn),db=this;
    const wrap=(variant:(...args:unknown[])=>unknown)=>function(this:unknown,...args:unknown[]) {
      const top=!db.inTransaction;
      if (top) currentTransaction={};
      const started=top ? performance.now() : 0;
      try {
        const result=variant.apply(this,args);
        if (top && currentTransaction?.first) {commits.transactions++;traced('TX '+currentTransaction.first);}
        return result;
      } finally {if (top) {currentTransaction=undefined;commits.dbMs+=performance.now()-started;}}
    };
    const wrapped:any=wrap(transaction);
    for (const key of ['deferred','immediate','exclusive']) wrapped[key]=wrap(transaction[key]);
    wrapped.default=wrapped;
    return wrapped;
  };
  const probe=new Database(':memory:'),Statement=Object.getPrototypeOf(probe.prepare('SELECT 1'));probe.close();
  const originalRun=Statement.run;
  Statement.run=function(this:any,...args:unknown[]) {
    // better-sqlite3의 transaction()도 내부에서 BEGIN 문장을 run()한다. 커밋은 transaction 쪽에서 센다.
    const control=/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(String(this.source));
    const autocommit=!this.database.inTransaction && !control && !this.reader;
    if (!autocommit && !control && currentTransaction && !currentTransaction.first && !this.reader) currentTransaction.first=String(this.source).replace(/\s+/g,' ').slice(0,90);
    const started=autocommit ? performance.now() : 0;
    const result=originalRun.apply(this,args);
    if (autocommit) {commits.autocommitWrites++;commits.dbMs+=performance.now()-started;traced('AUTO '+String(this.source).replace(/\s+/g,' ').slice(0,90));}
    return result;
  };

  await app.whenReady();
  const built=(name:string)=>require(path.join(build,'dist/modules',name+'.js'));
  const version=(JSON.parse(fs.readFileSync(path.join(build,'package.json'),'utf8')) as {version:string}).version;
  const profiles=fs.existsSync(path.join(build,'dist/modules/profileApplication.js'));
  const config=built('config'),diary=built('diaryDb'),contents=built('contentsChecker');
  const processor=built('chatLogProcessor').chatLogProcessor,live=built('chatLogManager').chatLogManager;
  const {chatParser}=built('chatParser'),{buffTimerManager}=built('buffTimerManager');
  const directory=path.join(fixture,'chat');
  fs.mkdirSync(directory,{recursive:true});
  if (!config.saveConfirmed({chatLogPath:directory,userServer:7,analyticsEnabled:false})) throw new Error('설정 저장 실패');

  let stopProfiles=()=>{};
  if (profiles) {
    // main.ts 순서: 프로필 저장소 → 공유 DB 연결 → 숙제 → 감시. 게임 실행 중이며 프로필을 선택한 사냥 상태로 만든다.
    const clock=new (built('profileClock').ProfileClock)(async()=>{throw new Error('offline benchmark');});
    const application=built('profileApplication');
    const controller=await application.startProfileApplication(()=>{},clock);
    diary.initDb();
    contents.init();
    const {service,replay}=controller.runtime;
    await controller.runtime.onGameState('running');
    const id=service.store.list()[0].id;
    if (!service.update(id,'측정용',7).success) throw new Error('프로필 갱신 실패');
    const selection=await service.select(id,replay);
    if (!selection.success) throw new Error(selection.error);
    stopProfiles=()=>application.stopProfileApplication();
  } else {
    diary.initDb();
    contents.init();
  }
  // 실험용: --sync NORMAL|FULL 이면 측정 전에 앱 DB 연결의 synchronous를 바꾼다(코드 변경 전 효과 확인용).
  const syncOverride=argument('--sync');
  if (syncOverride) {
    const db=profiles ? built('profileRuntime').getProfileRuntime().service.store.database : diary.getDb?.();
    if (!db) throw new Error('synchronous를 바꿀 DB 연결을 찾지 못했습니다.');
    db.pragma(`synchronous = ${syncOverride}`);
  }
  const file=live.getTodayFilePath();
  if (!file) throw new Error('오늘 로그 경로 없음');
  fs.writeFileSync(file,'');
  const startupRssMB=round(process.memoryUsage().rss/2**20);
  processor.start();
  live.start();
  buffTimerManager.start();

  const events:Record<string,number>={};
  for (const name of ['XP_CHANGED','ITEM_LOOTED','SEED_GAINED','BUFF_USED','TRADE_SHOUT']) {
    events[name]=0;chatParser.on(name,()=>{events[name]++;});
  }
  const received=new Map<number,number>(),written=new Map<number,number>();
  chatParser.on('SPECIAL_MONSTER_SPAWN',(data:{message:string})=>{
    const seq=Number(/#(\d+)/.exec(data.message)?.[1]);
    if (seq && !received.has(seq)) received.set(seq,Date.now());
  });

  const runWriter=(ms:number)=>new Promise<{lines:number;alerts:number}>((resolve,reject)=>{
    const child=fork(path.join(__dirname,'benchmark-log-writer.js'),[file,String(rate),String(ms),writerMode,mix],
      {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','inherit','inherit','ipc']});
    let done:{lines:number;alerts:number} | undefined;
    child.on('message',(message:{type:string;seq?:number;writtenAt?:number;lines?:number;alerts?:number})=>{
      if (message.type==='alert') written.set(message.seq!,message.writtenAt!);
      else if (message.type==='done') done={lines:message.lines!,alerts:message.alerts!};
    });
    child.on('error',reject);
    child.on('exit',code=>done ? resolve(done) : reject(new Error(`로그 작성 프로세스 종료 코드 ${code}`)));
  });
  const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

  // 예열: 인코딩 확인·첫 북마크·JIT. 측정에서 제외한다.
  if (setupOnly) {
    await sleep(3000);
    console.log(JSON.stringify({setupOnly:true,version,startupRssMB,rssAfterIdleMB:round(process.memoryUsage().rss/2**20),heapUsedMB:round(process.memoryUsage().heapUsed/2**20)}));
    try {live.stop();stopProfiles();config.flushPending?.();diary.closeDb();} catch { /* 측정용 */ }
    return;
  }
  await runWriter(5000);
  await sleep(2500);
  for (const key of Object.keys(events)) events[key]=0;
  written.clear();received.clear();
  commits.transactions=0;commits.autocommitWrites=0;commits.dbMs=0;trace?.clear();
  // 데이터 증가량은 WAL을 본 DB에 반영한 뒤 본 DB 파일 크기로 잰다(WAL 파일 크기는 재사용되어 증가량이 아니다).
  const dbBytes=()=>{diary.checkpointWal();return fs.readdirSync(fixture).filter(name=>/.db$/.test(name)).reduce((sum,name)=>sum+fs.statSync(path.join(fixture,name)).size,0);};
  const startDbBytes=dbBytes();
  // 테이블별 크기: 앱이 연 연결(잠금 모드라 다른 연결은 못 연다)로 dbstat 집계한다. 행 수는 테이블만.
  const connections=()=>{
    const list=new Map<string,any>();
    const add=(db:any)=>{if (db?.open && db.name && !list.has(path.basename(db.name))) list.set(path.basename(db.name),db);};
    if (profiles) add(built('profileRuntime').getProfileRuntime()?.service.store.database);
    add(diary.getDb?.());
    return list;
  };
  const tableStats=()=>{
    const stats=new Map<string,{file:string;name:string;rows?:number;bytes:number}>();
    for (const [file,reader] of connections()) {
      const tables=new Set((reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
      for (const row of reader.prepare('SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all() as {name:string;bytes:number}[]) {
        const rows=tables.has(row.name) ? (reader.prepare(`SELECT COUNT(*) AS n FROM "${row.name.replace(/"/g,'""')}"`).get() as {n:number}).n : undefined;
        stats.set(`${file}|${row.name}`,{file,name:row.name,rows,bytes:row.bytes});
      }
    }
    return stats;
  };
  const startTables=tableStats();

  const lag=monitorEventLoopDelay({resolution:5});
  const rssSamples:number[]=[];
  const memory=()=>process.memoryUsage();
  const startMemory=memory(),startIo=io(),startCpu=cpuMs(),startThread=threadCpuMs(),startAt=performance.now();
  lag.enable();
  const sampler=setInterval(()=>rssSamples.push(memory().rss),1000);
  const writer=await runWriter(durationS*1000);
  await sleep(3000); // 마지막 묶음 처리(줄 결합 대기·재시도)까지 기다린다.
  clearInterval(sampler);lag.disable();
  const elapsedMs=performance.now()-startAt,endCpu=cpuMs(),endThread=threadCpuMs(),endIo=io(),endMemory=memory();
  rssSamples.push(endMemory.rss);
  const latencies=[...written].filter(([seq])=>received.has(seq)).map(([seq,at])=>received.get(seq)!-at);
  const totalMB=app.getAppMetrics().reduce((sum,metric)=>sum+metric.memory.workingSetSize,0)/1024;
  const dbFilesKB:Record<string,number>={};
  for (const name of fs.readdirSync(fixture)) if (/\.db(-wal)?$/.test(name)) dbFilesKB[name]=round(fs.statSync(path.join(fixture,name)).size/1024);
  const mainCpuMs=endCpu.kernel+endCpu.user-startCpu.kernel-startCpu.user,measuredS=durationS;
  const result:RunResult={
    label:argument('--label',version)!,version,affinity,cores:affinity==='all' ? os.cpus().length : BigInt(affinity).toString(2).replace(/0/g,'').length,
    durationS,rate,writer:mix==='mixed' ? writerMode : `${writerMode}/${mix}`,linesWritten:writer.lines,events,
    rssMB:{start:round(startMemory.rss/2**20),end:round(endMemory.rss/2**20),max:round(Math.max(...rssSamples)/2**20)},
    heapUsedMB:{start:round(startMemory.heapUsed/2**20),end:round(endMemory.heapUsed/2**20)},
    allProcessesMB:{end:round(totalMB)},
    cpu:{mainPctOfCore:round(mainCpuMs/elapsedMs*100),mainCpuMs:Math.round(mainCpuMs),cpuMsPer1000Lines:round(mainCpuMs/writer.lines*1000),
      mainThreadMs:Math.round(endThread-startThread),mainThreadPctOfCore:round((endThread-startThread)/elapsedMs*100,2),mainThreadMsPer1000Lines:round((endThread-startThread)/writer.lines*1000)},
    io:{writeOps:endIo.WriteOperationCount-startIo.WriteOperationCount,writeKB:round((endIo.WriteTransferCount-startIo.WriteTransferCount)/1024),
      otherOps:endIo.OtherOperationCount-startIo.OtherOperationCount,readOps:endIo.ReadOperationCount-startIo.ReadOperationCount,
      writeOpsPerSec:round((endIo.WriteOperationCount-startIo.WriteOperationCount)/measuredS)},
    commits:{transactions:commits.transactions,autocommitWrites:commits.autocommitWrites,perSec:round((commits.transactions+commits.autocommitWrites)/measuredS)},
    eventLoopMs:{p50:round(lag.percentile(50)/1e6,2),p95:round(lag.percentile(95)/1e6,2),p99:round(lag.percentile(99)/1e6,2),max:round(lag.max/1e6,2)},
    dbMsPerSec:round(commits.dbMs/measuredS,2),
    alertLatencyMs:{n:latencies.length,expected:writer.alerts,p50:percentile(latencies,50),p95:percentile(latencies,95),max:Math.max(...latencies)},
    retainedLogLines:{lines:live._todayLines?.length ?? 0,chars:live._todayLineChars ?? 0},
    dbFilesKB,dbGrowthMBPerHour:round((dbBytes()-startDbBytes)/2**20/elapsedMs*3_600_000),
  };
  result.tableGrowth=[...tableStats()].map(([key,end])=>{
    const start=startTables.get(key),bytes=end.bytes-(start?.bytes ?? 0);
    return {file:end.file,name:end.name,...(end.rows===undefined ? {} : {rows:end.rows-(start?.rows ?? 0)}),KB:round(bytes/1024),KBPerHour:round(bytes/1024/elapsedMs*3_600_000)};
  }).filter(row=>row.KB!==0 || (row.rows ?? 0)!==0).sort((a,b)=>b.KB-a.KB);
  if (trace) console.log('SQL_TRACE '+JSON.stringify([...trace].sort((a,b)=>b[1]-a[1]),null,1));
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  try {live.stop();stopProfiles();config.flushPending?.();diary.closeDb();} catch (error) {console.warn('정리 실패',error);}
  if (!reuse) try {fs.rmSync(fixture,{recursive:true,force:true});} catch { /* Windows가 잠근 파일은 남긴다. */ }
}

/* ───────────── 비교 모드 (node) ───────────── */
function compare():void {
  const electron=require('electron') as unknown as string;
  const durationS=argument('--duration','60')!,rate=argument('--rate','40')!,repeat=Number(argument('--repeat','2'));
  const affinities=argument('--affinities','all,3,1')!.split(',');
  const builds=argument('--builds','baseline,current')!.split(',').map(name=>name==='baseline' ? BASELINE : name==='current' ? root : path.resolve(name));
  const out=path.resolve(argument('--out',path.join(root,'output/runtime-benchmark/result.json'))!);
  const tag=argument('--tag','')!,sync=argument('--sync'),writerMode=argument('--writer','batch')!,mix=argument('--mix','mixed')!;
  if (builds.includes(BASELINE) && !fs.existsSync(path.join(BASELINE,'dist/modules/config.js'))) {
    throw new Error('v3.2.2 빌드가 없습니다. 먼저 node dist-tools/prepare-upgrade-baseline.js 를 실행하세요.');
  }
  const results:RunResult[]=[];
  for (let round=0;round<repeat;round++) {
    for (const affinity of affinities) {
      for (const build of builds) {
        const file=path.join(path.dirname(out),`run-${path.basename(build)}-${writerMode}-${mix}-${affinity}-${round}.json`);
        // 태그 빌드(output/profile-upgrade-baseline/vX)는 태그 이름, 작업 트리는 current로 표시한다.
        const label=(build===root ? 'current' : path.basename(build))+(tag ? `-${tag}` : '')+(writerMode==='batch' ? '' : `-${writerMode}`)+(mix==='mixed' ? '' : `-${mix}`);
        console.log(`▶ ${label} affinity=${affinity} round=${round+1}/${repeat}`);
        execFileSync(electron,[__filename,'--run','--build',build,'--duration',durationS,'--rate',rate,'--affinity',affinity,'--label',label,'--out',file,...(sync ? ['--sync',sync] : []),'--writer',writerMode,'--mix',mix],
          {stdio:['ignore','ignore','inherit'],timeout:(Number(durationS)+120)*1000});
        results.push(JSON.parse(fs.readFileSync(file,'utf8')));
      }
    }
  }
  fs.writeFileSync(out,JSON.stringify(results,null,2));
  console.log(table(results));
}

/** 같은 (빌드, affinity) 묶음의 반복 결과를 중앙값으로 합쳐 Markdown 표로 만든다. */
function table(results:RunResult[]):string {
  const groups=new Map<string,RunResult[]>();
  for (const result of results) {
    const key=`${result.label}|${result.affinity}`;
    groups.set(key,[...(groups.get(key) ?? []),result]);
  }
  const median=(values:number[])=>percentile(values,50);
  const rows=[...groups.values()].map(items=>{
    const pick=(get:(r:RunResult)=>number)=>median(items.map(get));
    const first=items[0];
    return `| ${first.label} | ${first.affinity==='all' ? `전체(${first.cores})` : `${first.cores}코어`} | ${pick(r=>r.rssMB.end)} / ${pick(r=>r.rssMB.max)} | ${pick(r=>r.cpu.mainThreadPctOfCore ?? NaN)} | ${pick(r=>r.cpu.mainThreadMsPer1000Lines ?? NaN)} | ${pick(r=>r.io.writeOpsPerSec)} | ${pick(r=>Math.round(r.io.writeKB/r.durationS))} | ${pick(r=>r.commits.perSec)} | ${pick(r=>r.dbMsPerSec)} | ${pick(r=>r.eventLoopMs.p95)} / ${pick(r=>r.eventLoopMs.max)} | ${pick(r=>r.alertLatencyMs.p50)} / ${pick(r=>r.alertLatencyMs.p95)} / ${pick(r=>r.alertLatencyMs.max)} | ${pick(r=>r.dbGrowthMBPerHour)} | ${items.map(r=>`${r.alertLatencyMs.n}/${r.alertLatencyMs.expected}`).join(',')} |`;
  });
  return ['| 빌드 | CPU | RSS 끝/최대 MB | JS 메인 스레드 CPU %(1코어 기준) | 메인 스레드 CPU ms/1000줄 | 쓰기 횟수/초 | 쓰기 KB/초 | DB 커밋/초 | DB 대기 ms/초 | 이벤트 루프 p95/최대 ms | 알림 지연 p50/p95/최대 ms | DB 증가 MB/시간 | 알림 수신 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',...rows].join('\n');
}

if (process.versions.electron && process.argv.includes('--run')) {
  measure().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
} else if (process.argv.includes('--table')) {
  console.log(table(JSON.parse(fs.readFileSync(path.resolve(argument('--table')!),'utf8'))));
} else compare();
