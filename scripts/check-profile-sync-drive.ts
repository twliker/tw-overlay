import assert=require('node:assert/strict');
import path=require('node:path');
import fs=require('node:fs');
import os=require('node:os');
import {app} from 'electron';
import {gzipSync} from 'node:zlib';
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-drive-')));
const {GoogleProfileDrive,ProfileDriveError,ProfileDriveNetworkError}=require(path.resolve(__dirname,'../dist/modules/profileSyncDrive'));
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
  assert.match(calls.at(-1)!.url.searchParams.get('fields')!,/trashed/);
  replies=[{body:{changes:[
    {fileId:'trashed',file:file('trashed')},{fileId:'trashed',file:{...file('trashed'),trashed:true}},
    {fileId:'restored',file:{...file('restored'),trashed:true}},{fileId:'restored',file:file('restored')},
  ],newStartPageToken:'next'}}];
  const trash=await api.scan('end');
  assert.deepEqual(trash.removed,['trashed']);assert.deepEqual(trash.files.map((item:any)=>item.id),['restored']);
  replies=[{status:410},{body:{startPageToken:'reset'}},{body:{files:[]}}];assert.equal((await api.scan('expired')).cursor,'reset');
  replies=[{body:{nextPageToken:'loop',changes:[]}},{body:{nextPageToken:'loop',changes:[]}}];await assert.rejects(api.scan('start'),/반복/);
  replies=[{body:envelope}];assert.deepEqual(await api.download(file('one')),envelope);
  replies=[{body:envelope}];await assert.rejects(api.download(file('other','PC-B')),/일치/);
  replies=[{body:envelope,headers:{'Content-Length':String(17*1024*1024)}}];await assert.rejects(api.download(file('large')),/크기/);
  // 새 버전이 추가했거나 이 버전이 전송하지 않는 키는 파일 전체를 보류하지 않는다(병합에서 건너뜀).
  const future:any=structuredClone(envelope);future.cells['["setting","uuid-a","discordWebhookUrl"]']=Object.values(future.cells)[0];
  future.cells['["homework","uuid-a","task","futureField"]']={...(Object.values(envelope.cells)[0] as object),value:[1]};
  replies=[{body:future}];assert.deepEqual(await api.download(file('future')),future);
  // 아는 키의 잘못된 값은 계속 해당 파일을 보류한다.
  const bad:any=structuredClone(envelope);bad.cells['["setting","uuid-a","userServer"]']={...(Object.values(bad.cells)[0] as object),value:'not-a-server'};replies=[{body:bad}];await assert.rejects(api.download(file('bad')),/항목/);
  replies=[{body:{ids:['new-id']}}];assert.equal(await api.allocate(),'new-id');assert.equal(calls.at(-1)!.url.searchParams.get('space'),'appDataFolder');
  replies=[{body:{id:'new-id',version:'7',md5Checksum:'md5-7'}}];
  assert.deepEqual(await api.upload('new-id',envelope,false),{version:'7',md5Checksum:'md5-7'},'생성 응답의 revision을 돌려준다');
  const create=calls.at(-1)!;assert.match(create.url.searchParams.get('fields')!,/version,md5Checksum/);assert.equal(create.init.method,'POST');assert.match(String(create.init.body),/"id":"new-id"/);assert.match(String(create.init.body),/"parents":\["appDataFolder"\]/);
  replies=[{body:{etag:'"version-1"',version:'1'}},{body:{version:'2',md5Checksum:'md5-2'}}];
  assert.deepEqual(await api.upload('new-id',envelope,true,'1'),{version:'2',md5Checksum:'md5-2'},'갱신 응답의 revision을 돌려준다');
  assert.equal(calls.at(-1)!.url.searchParams.get('fields'),'version,md5Checksum');
  assert.match(calls.at(-2)!.url.pathname,/\/v2\/files\/new-id$/);assert.equal(calls.at(-1)!.init.method,'PUT');assert.equal((calls.at(-1)!.init.headers as Record<string,string>)['If-Match'],'"version-1"');
  const beforeStop=calls.length;
  replies=[{body:{etag:'"v"',version:'1'}}];
  await assert.rejects(api.upload('new-id',envelope,true,'1',()=>{throw new Error('automatic sync off');}),/automatic sync off/);
  assert.equal(calls.length,beforeStop+1,'메타데이터 확인 뒤 전송을 중지하면 PUT은 실행하지 않는다');
  for(const status of [412,404]) {
    const before=calls.length;replies=[{body:{etag:'"v"',version:'1'}},{status}];await assert.rejects(api.upload('new-id',envelope,true,'1'),(e:any)=>e instanceof ProfileDriveError && e.status===status);
    assert.equal(calls.length,before+2,'충돌/삭제 후 무조건 새 파일을 만들지 않음');
  }
  const beforeVersionRace=calls.length;replies=[{body:{etag:'"newer"',version:'2'}}];await assert.rejects(api.upload('new-id',envelope,true,'1'),(e:any)=>e.status===412);assert.equal(calls.length,beforeVersionRace+1,'본문 조회 후 버전 변경이면 PUT도 실행하지 않음');
  const compressed:any=structuredClone(envelope);compressed.cells['["tool","uuid-a","buff_presets"]']={...Object.values(compressed.cells)[0] as object,value:JSON.stringify([{id:'test',name:'압축 검증',description:'압축할 내용'.repeat(2000)}])};
  const compressedBytes=gzipSync(JSON.stringify(compressed));replies=[{raw:compressedBytes}];assert.deepEqual(await api.download(file('gzip')),compressed);
  replies=[{body:{etag:'"v"',version:'1'}},{body:{id:'new-id'}}];await api.upload('new-id',compressed,true,'1');
  assert.equal((calls.at(-1)!.init.headers as Record<string,string>)['Content-Type'],'application/gzip');assert.ok((calls.at(-1)!.init.body as Uint8Array).length<JSON.stringify(compressed).length/4);
  const large={...envelope,cells:Object.fromEntries(Array.from({length:4600},(_,i)=>[
    JSON.stringify(['homework','uuid-a',`task-${i}`,'autoDescription']),
    {...Object.values(envelope.cells)[0],value:'x'.repeat(3800)},
  ]))};
  const largeJson=JSON.stringify(large);
  assert.ok(Buffer.byteLength(largeJson)>16*1024*1024);
  replies=[{body:{etag:'"v"',version:'1'}},{body:{id:'large'}}];await api.upload('large',large,true,'1');
  const largeBody=calls.at(-1)!.init.body as Uint8Array;
  assert.ok(largeBody.length<16*1024*1024);
  replies=[{raw:largeBody}];assert.deepEqual(await api.download(file('large')),large);
  replies=[{raw:gzipSync('x'.repeat(65*1024*1024))}];await assert.rejects(api.download(file('bomb')),/허용 범위/);
  await assert.rejects(api.removeIsolatedTestFiles(),/제품 동기화/);
  const samples:any[]=[],timed=new GoogleProfileDrive(http,async()=>'test-access',async()=>null,()=>{},'1',(sample:any)=>samples.push(sample));
  replies=[{body:{ids:['time-id']},headers:{Date:'Wed, 04 Nov 2026 00:00:00 GMT'}}];await timed.allocate();assert.equal(samples.length,1);assert.ok(samples[0].uncertaintyMs>=500);
  replies=[{body:{ids:['cached-time']},headers:{Date:'Wed, 04 Nov 2026 00:00:00 GMT',Age:'100'}}];await timed.allocate();assert.equal(samples.length,1,'캐시된 오래된 Date는 시간 보정에 쓰지 않음');
  replies=[{status:401},{body:{ids:['reauth-id']}}];assert.equal(await api.allocate(),'reauth-id');assert.equal(refreshes,1);
  assert.equal((calls.at(-1)!.init.headers as Record<string,string>).Authorization,'Bearer test-refreshed');
  replies=[{status:401},{status:401}];await assert.rejects(api.allocate(),(e:any)=>e.status===401);assert.equal(invalidations,1);
  for(const status of [403,429]) {replies=[{status,headers:{'Retry-After':'60'}}];await assert.rejects(api.allocate(),(e:any)=>e.status===status && e.retryAfterMs===60_000);}
  for(const header of ['invalid', '9'.repeat(400)]) {
    replies=[{status:429,headers:{'Retry-After':header}}];
    await assert.rejects(api.allocate(),(e:any)=>e.status===429 && e.retryAfterMs===0);
  }
  // refresh token을 보존한 일시 장애는 네트워크 오류로 분류하고 로그아웃하지 않는다. 거절(null)만 인증을 정리한다.
  const auth=require(path.resolve(__dirname,'../dist/modules/googleAuth'));
  const temporary=async()=>{throw new auth.GoogleAuthTemporaryError('fixture offline refresh');};
  const beforeTransient=invalidations;
  await assert.rejects(new GoogleProfileDrive(http,temporary,async()=>null,()=>invalidations++).allocate(),(e:unknown)=>e instanceof ProfileDriveNetworkError);
  replies=[{status:401}];
  await assert.rejects(new GoogleProfileDrive(http,async()=>'test-access',temporary,()=>invalidations++).allocate(),(e:unknown)=>e instanceof ProfileDriveNetworkError);
  assert.equal(invalidations,beforeTransient,'일시적인 토큰 갱신 실패로 로그아웃하지 않음');
  replies=[{status:401}];
  await assert.rejects(new GoogleProfileDrive(http,async()=>'test-access',async()=>null,()=>invalidations++).allocate(),(e:any)=>e.status===401);
  assert.equal(invalidations,beforeTransient+1,'거절된 갱신만 인증을 정리');
  const {safeStorage}=require('electron');
  const tokenFile=path.join(app.getPath('userData'),'google_auth.enc');
  const storeTokens=(tokens:object)=>{
    auth.logout();const raw=JSON.stringify(tokens);
    fs.writeFileSync(tokenFile,safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(raw) : Buffer.from(raw,'utf-8').toString('base64'));
  };
  const realFetch=globalThis.fetch;
  try {
    globalThis.fetch=(async()=>{throw new TypeError('fixture offline');}) as typeof fetch;
    storeTokens({access_token:'expired',refresh_token:'keep-refresh',expiry_date:1});
    await assert.rejects(auth.refreshAfterUnauthorized(),(e:unknown)=>e instanceof auth.GoogleAuthTemporaryError);
    await assert.rejects(auth.getSyncAccessToken(),(e:unknown)=>e instanceof auth.GoogleAuthTemporaryError);
    assert.equal(auth.isLoggedIn(),true);assert.equal(auth.loadStoredTokens().refresh_token,'keep-refresh','오프라인 갱신 실패 뒤 refresh token 보존');
    storeTokens({access_token:'expired-without-refresh',expiry_date:1});
    assert.equal(await auth.getSyncAccessToken(),null,'refresh token이 없으면 재로그인 필요');assert.equal(auth.isLoggedIn(),false);
  } finally {globalThis.fetch=realFetch;auth.logout();}
  const disconnected=new GoogleProfileDrive(async()=>{throw new TypeError('fixture fetch failed');},async()=>'test-access');
  await assert.rejects(disconnected.scan(),(error:unknown)=>error instanceof ProfileDriveNetworkError);
  let release!:(token:string)=>void;
  const delayed=new GoogleProfileDrive(http,()=>new Promise<string>(r=>release=r),async()=>null,()=>invalidations++);
  const request=delayed.allocate();await Promise.resolve();delayed.cancel();replies=[{body:{ids:['cancelled']}}];release('test-access');await assert.rejects(request,/cancelled/);
  assert.ok(api.requests>0 && api.uploadedBytes>0 && api.downloadedBytes>0);
  assert.equal(replies.length,0);
  console.log(`PASS profile Drive transport: appData scope/namespace, paging/cursor, bounded JSON validation, stable create ID, conditional update, 401/403/429/410/412/404, cancellation (${calls.length} HTTP contracts)`);
}
run().then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
