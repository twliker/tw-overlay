import assert=require('node:assert/strict');
import path=require('node:path');
import fs=require('node:fs');
import os=require('node:os');
import {app} from 'electron';
import {gzipSync} from 'node:zlib';
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-drive-')));
const {GoogleProfileDrive,ProfileDriveError}=require(path.resolve(__dirname,'../dist/modules/profileSyncDrive'));
type Reply={status?:number;body?:unknown;headers?:Record<string,string>;raw?:Uint8Array};
const file=(id:string,device='PC-A')=>({id,name:`tw_overlay_profiles_${device}.json`,version:'1',appProperties:{twProfileSync:'1',device}});
const envelope={format:'tw-overlay-profiles',version:1,device:'PC-A',sequence:1,cells:{'["profile","uuid-a","name"]':{device:'PC-A',sequence:1,context:{},clock:{utcMs:1,source:'unverified',uncertaintyMs:null},value:'테스트'}}};
const calls:Array<{url:URL;init:RequestInit}>=[];let replies:Reply[]=[],refreshes=0,invalidations=0;
const http=(async(url:string|URL,init:RequestInit)=>{
  calls.push({url:new URL(String(url)),init});const next=replies.shift();assert.ok(next,'예정하지 않은 HTTP 요청');
  if(init.signal?.aborted) throw new DOMException('cancelled','AbortError');
  return new Response(next.raw ? new Uint8Array(next.raw) : JSON.stringify(next.body ?? {}),{status:next.status || 200,headers:next.headers});
}) as typeof fetch;
const drive=()=>new GoogleProfileDrive(http,async()=>'test-access',async()=>{refreshes++;return 'test-refreshed';},()=>invalidations++);
async function run():Promise<void> {
  await app.whenReady();const api=drive();
  replies=[{body:{startPageToken:'start'}},{body:{nextPageToken:'p2',files:[file('one'),{id:'legacy',name:'tw_overlay_settings.json'}]}},{body:{files:[file('two','PC-B')]}}];
  const scan=await api.scan();assert.equal(scan.full,true);assert.deepEqual(scan.files.map((f:any)=>f.id),['one','two']);assert.equal(scan.cursor,'start');
  assert.equal(calls[1].url.searchParams.get('spaces'),'appDataFolder');assert.match(calls[1].url.searchParams.get('q')!,/twProfileSync/);assert.equal(calls[2].url.searchParams.get('pageToken'),'p2');
  replies=[{body:{nextPageToken:'changes2',changes:[{fileId:'one',file:file('one')}]}},{body:{newStartPageToken:'end',changes:[{fileId:'gone',removed:true},{fileId:'legacy',file:{id:'legacy'}}]}}];
  const changes=await api.scan('start');assert.equal(changes.cursor,'end');assert.deepEqual(changes.removed,['gone']);assert.equal(changes.files.length,1);
  replies=[{status:410},{body:{startPageToken:'reset'}},{body:{files:[]}}];assert.equal((await api.scan('expired')).cursor,'reset');
  replies=[{body:{nextPageToken:'loop',changes:[]}},{body:{nextPageToken:'loop',changes:[]}}];await assert.rejects(api.scan('start'),/반복/);
  replies=[{body:envelope}];assert.deepEqual(await api.download(file('one')),envelope);
  replies=[{body:envelope}];await assert.rejects(api.download(file('other','PC-B')),/일치/);
  replies=[{body:envelope,headers:{'Content-Length':String(17*1024*1024)}}];await assert.rejects(api.download(file('large')),/크기/);
  const bad:any=structuredClone(envelope);bad.cells['["setting","uuid-a","discordWebhookUrl"]']=Object.values(bad.cells)[0];replies=[{body:bad}];await assert.rejects(api.download(file('bad')),/항목/);
  replies=[{body:{ids:['new-id']}}];assert.equal(await api.allocate(),'new-id');assert.equal(calls.at(-1)!.url.searchParams.get('space'),'appDataFolder');
  replies=[{body:{id:'new-id'}}];await api.upload('new-id',envelope,false);
  const create=calls.at(-1)!;assert.equal(create.init.method,'POST');assert.match(String(create.init.body),/"id":"new-id"/);assert.match(String(create.init.body),/"parents":\["appDataFolder"\]/);
  replies=[{body:{etag:'"version-1"',version:'1'}},{body:{id:'new-id'}}];await api.upload('new-id',envelope,true,'1');
  assert.match(calls.at(-2)!.url.pathname,/\/v2\/files\/new-id$/);assert.equal(calls.at(-1)!.init.method,'PUT');assert.equal((calls.at(-1)!.init.headers as Record<string,string>)['If-Match'],'"version-1"');
  for(const status of [412,404]) {
    const before=calls.length;replies=[{body:{etag:'"v"',version:'1'}},{status}];await assert.rejects(api.upload('new-id',envelope,true,'1'),(e:any)=>e instanceof ProfileDriveError && e.status===status);
    assert.equal(calls.length,before+2,'충돌/삭제 후 무조건 새 파일을 만들지 않음');
  }
  const beforeVersionRace=calls.length;replies=[{body:{etag:'"newer"',version:'2'}}];await assert.rejects(api.upload('new-id',envelope,true,'1'),(e:any)=>e.status===412);assert.equal(calls.length,beforeVersionRace+1,'본문 조회 후 버전 변경이면 PUT도 실행하지 않음');
  const compressed:any=structuredClone(envelope);compressed.cells['["tool","uuid-a","buff_presets"]']={...Object.values(compressed.cells)[0] as object,value:JSON.stringify([{id:'test',name:'압축 검증',description:'압축할 내용'.repeat(2000)}])};
  const compressedBytes=gzipSync(JSON.stringify(compressed));replies=[{raw:compressedBytes}];assert.deepEqual(await api.download(file('gzip')),compressed);
  replies=[{body:{etag:'"v"',version:'1'}},{body:{id:'new-id'}}];await api.upload('new-id',compressed,true,'1');
  assert.equal((calls.at(-1)!.init.headers as Record<string,string>)['Content-Type'],'application/gzip');assert.ok((calls.at(-1)!.init.body as Uint8Array).length<JSON.stringify(compressed).length/4);
  replies=[{raw:gzipSync('x'.repeat(17*1024*1024))}];await assert.rejects(api.download(file('bomb')),/허용 범위/);
  await assert.rejects(api.removeIsolatedTestFiles(),/제품 동기화/);
  const samples:any[]=[],timed=new GoogleProfileDrive(http,async()=>'test-access',async()=>null,()=>{},'1',(sample:any)=>samples.push(sample));
  replies=[{body:{ids:['time-id']},headers:{Date:'Wed, 04 Nov 2026 00:00:00 GMT'}}];await timed.allocate();assert.equal(samples.length,1);assert.ok(samples[0].uncertaintyMs>=500);
  replies=[{body:{ids:['cached-time']},headers:{Date:'Wed, 04 Nov 2026 00:00:00 GMT',Age:'100'}}];await timed.allocate();assert.equal(samples.length,1,'캐시된 오래된 Date는 시간 보정에 쓰지 않음');
  replies=[{status:401},{body:{ids:['reauth-id']}}];assert.equal(await api.allocate(),'reauth-id');assert.equal(refreshes,1);
  assert.equal((calls.at(-1)!.init.headers as Record<string,string>).Authorization,'Bearer test-refreshed');
  replies=[{status:401},{status:401}];await assert.rejects(api.allocate(),(e:any)=>e.status===401);assert.equal(invalidations,1);
  for(const status of [403,429]) {replies=[{status,headers:{'Retry-After':'60'}}];await assert.rejects(api.allocate(),(e:any)=>e.status===status && e.retryAfterMs===60_000);}
  let release!:(token:string)=>void;
  const delayed=new GoogleProfileDrive(http,()=>new Promise<string>(r=>release=r),async()=>null,()=>invalidations++);
  const request=delayed.allocate();await Promise.resolve();delayed.cancel();replies=[{body:{ids:['cancelled']}}];release('test-access');await assert.rejects(request,/cancelled/);
  assert.ok(api.requests>0 && api.uploadedBytes>0 && api.downloadedBytes>0);
  assert.equal(replies.length,0);
  console.log(`PASS profile Drive transport: appData scope/namespace, paging/cursor, bounded JSON validation, stable create ID, conditional update, 401/403/429/410/412/404, cancellation (${calls.length} HTTP contracts)`);
}
run().then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
