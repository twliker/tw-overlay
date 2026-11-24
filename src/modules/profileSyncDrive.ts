import {randomUUID} from 'crypto';
import * as auth from './googleAuth';
import {PROFILE_SYNC_POLICY,type ProfileSyncEnvelope} from '../shared/profileSync';
import {validateProfileSyncEnvelope} from './profileSyncModel';
import {gzipSync,gunzipSync} from 'zlib';
import type {InternetTimeSample} from './profileClock';

export interface ProfileDriveFile {id:string;name:string;version?:string;md5Checksum?:string;size?:string;trashed?:boolean;appProperties?:Record<string,string>}
export type UploadedProfileDriveFile=Pick<ProfileDriveFile,'version' | 'md5Checksum'>;
export interface ProfileDriveScan {files:ProfileDriveFile[];removed:string[];cursor:string;full:boolean}
export interface ProfileSyncTransport {
  scan(cursor?:string):Promise<ProfileDriveScan>;
  download(file:ProfileDriveFile):Promise<ProfileSyncEnvelope>;
  allocate():Promise<string>;
  /** 확정된 새 revision의 version/md5를 돌려주면 coordinator가 다음 변경 feed에서 자기 파일 재수신을 생략한다. */
  upload(id:string,envelope:ProfileSyncEnvelope,existing:boolean,expectedVersion?:string,beforeSend?:()=>void):Promise<UploadedProfileDriveFile | void>;
  cancel():void;
}
export class ProfileDriveError extends Error {
  constructor(message:string,readonly status=0,readonly retryAfterMs=0) {super(message);}
}
export class InvalidProfileDriveFile extends Error {}
export class ProfileDriveNetworkError extends Error {}
const fields='id,name,version,md5Checksum,size,trashed,appProperties';
const uploadedFields='version,md5Checksum';
const api='https://www.googleapis.com/drive';

/** 새 프로토콜 전용 전송. 옛 세 파일은 검색/덮어쓰지 않는다.
 * 변경 feed의 cursor는 전 페이지 검증과 로컬 commit 뒤에 확정한다.
 * 생성 ID를 먼저 보관해 응답 유실에도 재사용하고 기존 갱신은 명시 ETag를 사용한다.
 * 회귀: check-profile-sync-drive.ts (HTTP 계약/401/403/429/중단/페이지). */
export class GoogleProfileDrive implements ProfileSyncTransport {
  private controller=new AbortController();
  requests=0;uploadedBytes=0;downloadedBytes=0;
  constructor(private readonly http:typeof fetch=fetch,private readonly token=()=>auth.getValidAccessToken(),
    private readonly refresh=()=>auth.refreshAfterUnauthorized(),private readonly invalidate=()=>auth.invalidateAuth(),
    private readonly namespace='1',private readonly observeTime?:(sample:InternetTimeSample)=>void) {if (!/^[a-zA-Z0-9_-]{1,100}$/.test(namespace)) throw new Error('동기화 저장 영역이 올바르지 않습니다.');}
  cancel():void {this.controller.abort();this.controller=new AbortController();}
  private async request(url:string,init:RequestInit={},beforeSend?:()=>void):Promise<Response> {
    const signal=this.controller.signal;
    const execute=async (token:string)=>{
      beforeSend?.();
      this.requests++;
      const start=process.hrtime.bigint();
      let response:Response;
      try {
        response=await this.http(url,{...init,headers:{...init.headers,Authorization:`Bearer ${token}`},
          signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)])});
      } catch (error) {
        if (!signal.aborted && (error instanceof TypeError || error instanceof Error && error.name==='TimeoutError')) {
          throw new ProfileDriveNetworkError('Google에 연결하지 못했습니다. 네트워크를 확인해 주세요.',{cause:error});
        }
        throw error;
      }
      const elapsed=Number(process.hrtime.bigint()-start)/1_000_000,date=Date.parse(response.headers.get('Date') || '');
      if (!signal.aborted && Number.isFinite(date) && !Number(response.headers.get('Age'))
        && new URL(response.url || url).hostname==='www.googleapis.com') {
        this.observeTime?.({utcMs:date+500+elapsed/2,uncertaintyMs:500+elapsed/2});
      }
      return response;
    };
    // token 공급자는 거절(재로그인 필요)을 null로, refresh token을 보존한 일시 장애를 예외로 구분한다.
    // 일시 장애는 네트워크 오류로 분류해 로그아웃하지 않고 재연결 시 즉시 재시도하게 한다.
    const acquire=async (get:()=>Promise<string | null>)=>{
      try {return await get();}
      catch (error) {
        if (error instanceof auth.GoogleAuthTemporaryError) throw new ProfileDriveNetworkError('Google에 연결하지 못했습니다. 네트워크를 확인해 주세요.',{cause:error});
        throw error;
      }
    };
    let token=await acquire(this.token);if (!token) throw new ProfileDriveError('Google에 다시 로그인해 주세요.',401);
    let response=await execute(token);
    if (response.status===401) {
      await response.body?.cancel();token=await acquire(this.refresh);
      if (!token) {this.invalidate();throw new ProfileDriveError('Google 인증이 만료되었습니다. 다시 로그인해 주세요.',401);}
      response=await execute(token);
      if (response.status===401) this.invalidate();
    }
    if (!response.ok) {
      const retry=response.headers.get('Retry-After');
      const retryMs=retry ? /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now() : 0;
      const message=response.status===401 ? 'Google에 다시 로그인해 주세요.' : response.status===403 || response.status===429
        ? 'Google 요청 한도 또는 저장공간을 확인해 주세요. 로컬 변경은 보존됩니다.' : response.status===412
          ? '이 PC의 원격 파일이 변경되었습니다. 다시 확인한 뒤 동기화합니다.' : `Google 동기화 요청 실패 (HTTP ${response.status})`;
      await response.body?.cancel();throw new ProfileDriveError(message,response.status,Number.isFinite(retryMs) ? Math.max(0,retryMs) : 0);
    }
    return response;
  }
  private async bytes(response:Response,limit=PROFILE_SYNC_POLICY.maxFileBytes):Promise<Buffer> {
    if (Number(response.headers.get('Content-Length'))>limit) {await response.body?.cancel();throw new InvalidProfileDriveFile('동기화 파일의 허용 크기를 초과했습니다.');}
    const reader=response.body?.getReader();if (!reader) throw new InvalidProfileDriveFile('동기화 응답이 비어 있습니다.');
    const buffers:Uint8Array[]=[];let length=0;
    try {
      for (;;) {const part=await reader.read();if (part.done) break;length+=part.value.length;
        if (length>limit) throw new InvalidProfileDriveFile('동기화 응답의 허용 크기를 초과했습니다.');buffers.push(part.value);}
    } catch (error) {await reader.cancel().catch(()=>undefined);throw error;}
    this.downloadedBytes+=length;return Buffer.concat(buffers);
  }
  private async json<T>(response:Response,limit=PROFILE_SYNC_POLICY.maxFileBytes):Promise<T> {return JSON.parse((await this.bytes(response,limit)).toString('utf8')) as T;}
  private isOurs(file:ProfileDriveFile):boolean {return file.appProperties?.twProfileSync===this.namespace;}
  async scan(cursor?:string):Promise<ProfileDriveScan> {
    if (!cursor) {
      const start=await this.json<{startPageToken:string}>(await this.request(`${api}/v3/changes/startPageToken?fields=startPageToken`));
      const files:ProfileDriveFile[]=[];let page:string | undefined;const seen=new Set<string>();
      do {
        const params=new URLSearchParams({spaces:'appDataFolder',q:`trashed=false and appProperties has { key='twProfileSync' and value='${this.namespace}' }`,fields:`nextPageToken,files(${fields})`,pageSize:'1000'});
        if (page) params.set('pageToken',page);
        const result=await this.json<{nextPageToken?:string;files:ProfileDriveFile[]}>(await this.request(`${api}/v3/files?${params}`));
        if (!Array.isArray(result.files)) throw new Error('Google 파일 목록이 올바르지 않습니다.');
        files.push(...result.files.filter(f=>!f.trashed && this.isOurs(f)));page=result.nextPageToken;
        if (page && seen.has(page)) throw new Error('Google 파일 목록의 페이지가 반복됩니다.');if (page) seen.add(page);
        if (files.length>1000) throw new Error('동기화 기기 파일이 너무 많습니다. 기존 데이터는 보존됩니다.');
      } while (page);
      if (!start.startPageToken) throw new Error('Google 변경 확인 기준을 받지 못했습니다.');
      return {files,removed:[],cursor:start.startPageToken,full:true};
    }
    const files=new Map<string,ProfileDriveFile>(),removed=new Set<string>();let page=cursor,next:string | undefined;const seen=new Set<string>();
    do {
      const params=new URLSearchParams({pageToken:page,spaces:'appDataFolder',includeRemoved:'true',pageSize:'1000',
        fields:`nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields}))`});
      let result:{nextPageToken?:string;newStartPageToken?:string;changes:Array<{fileId:string;removed?:boolean;file?:ProfileDriveFile}>};
      try {result=await this.json(await this.request(`${api}/v3/changes?${params}`));}
      catch (error) {if (error instanceof ProfileDriveError && error.status===410) return this.scan();throw error;}
      if (!Array.isArray(result.changes)) throw new Error('Google 변경 목록이 올바르지 않습니다.');
      for (const change of result.changes) {
        if (change.removed || change.file?.trashed) {files.delete(change.fileId);removed.add(change.fileId);}
        else if (change.file && this.isOurs(change.file)) {removed.delete(change.fileId);files.set(change.fileId,change.file);}
      }
      next=result.nextPageToken;
      if (seen.has(next || '')) throw new Error('Google 변경 목록의 페이지가 반복됩니다.');if (next) {seen.add(next);page=next;}
      if (!next) {if (!result.newStartPageToken) throw new Error('Google 변경 확인 기준이 비어 있습니다.');page=result.newStartPageToken;}
    } while (next);
    return {files:[...files.values()],removed:[...removed],cursor:page,full:false};
  }
  async download(file:ProfileDriveFile):Promise<ProfileSyncEnvelope> {
    if (Number(file.size)>PROFILE_SYNC_POLICY.maxFileBytes) throw new InvalidProfileDriveFile('동기화 파일의 허용 크기를 초과했습니다.');
    const bytes=await this.bytes(await this.request(`${api}/v3/files/${encodeURIComponent(file.id)}?alt=media`));
    let value:ProfileSyncEnvelope;
    try {
      const decoded=bytes[0]===0x1f && bytes[1]===0x8b ? gunzipSync(bytes,{maxOutputLength:PROFILE_SYNC_POLICY.maxDecodedBytes}) : bytes;
      value=JSON.parse(decoded.toString('utf8')) as ProfileSyncEnvelope;
    } catch {throw new InvalidProfileDriveFile('동기화 파일이 손상되었거나 압축을 푼 크기가 허용 범위를 초과했습니다.');}
    try {validateProfileSyncEnvelope(value);} catch (error) {throw new InvalidProfileDriveFile(String(error));}
    if (file.appProperties?.device!==value.device) throw new InvalidProfileDriveFile('동기화 파일의 기기 정보가 일치하지 않습니다.');
    return value;
  }
  async allocate():Promise<string> {
    const result=await this.json<{ids:string[]}>(await this.request(`${api}/v3/files/generateIds?count=1&space=appDataFolder&type=files`));
    if (!/^[\w-]{1,200}$/.test(result.ids?.[0] || '')) throw new Error('Google 파일 식별자를 받지 못했습니다.');return result.ids[0];
  }
  async upload(fileId:string,envelope:ProfileSyncEnvelope,existing:boolean,expectedVersion?:string,beforeSend?:()=>void):Promise<UploadedProfileDriveFile> {
    validateProfileSyncEnvelope(envelope);const json=JSON.stringify(envelope);
    const compressed=Buffer.byteLength(json)>4096,payload=compressed ? gzipSync(json) : Buffer.from(json);
    if (payload.length>PROFILE_SYNC_POLICY.maxFileBytes) throw new Error('압축한 동기화 파일이 전송 한도를 초과했습니다. 로컬 데이터는 보존됩니다.');
    const contentType=compressed ? 'application/gzip' : 'application/json';
    const body=compressed ? new Uint8Array(payload) : json;
    const escaped=encodeURIComponent(fileId);
    let uploaded:UploadedProfileDriveFile;
    if (existing) {
      const meta=await this.json<{etag:string;version:string}>(await this.request(`${api}/v2/files/${escaped}?fields=etag,version`));
      if (!meta.etag) throw new Error('원격 파일 버전을 확인하지 못해 업로드하지 않았습니다.');
      // 본문을 읽은 revision과 지금 캡처한 ETag가 같은 버전이어야 한다.
      if (!expectedVersion || meta.version!==expectedVersion) throw new ProfileDriveError('원격 파일이 변경되어 다시 확인합니다. 로컬 변경은 보존됩니다.',412);
      uploaded=await this.uploadedFile(await this.request(`https://www.googleapis.com/upload/drive/v2/files/${escaped}?uploadType=media&fields=${uploadedFields}`,
        {method:'PUT',headers:{'Content-Type':contentType,'If-Match':meta.etag},body},beforeSend));
    } else {
      const boundary=`tw-profile-${randomUUID()}`;
      const metadata={id:fileId,name:`tw_overlay_profiles_${envelope.device}.json`,mimeType:contentType,parents:['appDataFolder'],
        appProperties:{twProfileSync:this.namespace,device:envelope.device}};
      const prefix=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
      const suffix=`\r\n--${boundary}--`;
      const multipart=compressed ? new Uint8Array(Buffer.concat([Buffer.from(prefix),payload,Buffer.from(suffix)])) : prefix+json+suffix;
      uploaded=await this.uploadedFile(await this.request(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,${uploadedFields}`,
        {method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body:multipart},beforeSend));
    }
    this.uploadedBytes+=payload.length;
    return uploaded;
  }
  /** 전송은 이미 확정되었으므로 응답 메타데이터를 읽지 못해도 실패로 바꾸지 않는다. 다음 변경 feed에서 다시 받는다. */
  private async uploadedFile(response:Response):Promise<UploadedProfileDriveFile> {
    try {
      const meta=await this.json<Record<string,unknown>>(response,64*1024);
      const text=(value:unknown)=>typeof value==='string' && value.length<=200 ? value : undefined;
      return {version:text(meta.version),md5Checksum:text(meta.md5Checksum)};
    } catch {return {};}
  }
  /** 명시적 실서비스 검사에서 생성한 격리 namespace만 정리한다. 제품 namespace는 삭제할 수 없다. */
  async removeIsolatedTestFiles():Promise<void> {
    if (!/^test-[a-zA-Z0-9_-]+$/.test(this.namespace)) throw new Error('제품 동기화 데이터는 자동 삭제할 수 없습니다.');
    const scan=await this.scan();
    for (const file of scan.files) {
      if (file.appProperties?.twProfileSync!==this.namespace) throw new Error('검사 영역 밖의 파일 삭제를 거부했습니다.');
      await (await this.request(`${api}/v3/files/${encodeURIComponent(file.id)}`,{method:'DELETE'})).body?.cancel();
    }
  }
}
