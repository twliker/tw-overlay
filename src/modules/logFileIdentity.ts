import * as fs from 'fs';
import {createHash} from 'crypto';
import iconv = require('iconv-lite');
import {detectChatLogEncoding} from './chatLogNormalizer';

const CONTENT_KEY_PROBE_BYTES=64*1024;
/** 같은 내용 키의 다른 파일(같은 날짜 파일을 다른 내용으로 다시 쓴 경우)을 가려내는 앞부분 표본 크기. */
const PREFIX_PROBE_BYTES=4096;
const TIMESTAMP=/\[\s*\d{1,2}\s*시\s*\d{1,2}\s*분\s*\d{1,2}\s*초\s*\]/;

function readPrefix(filePath:string,bytes:number):Buffer | undefined {
  try {
    const fd=fs.openSync(filePath,'r');
    try {
      const size=Math.min(fs.fstatSync(fd).size,bytes);
      const head=Buffer.alloc(size);fs.readSync(fd,head,0,size,0);
      return head;
    } finally {fs.closeSync(fd);}
  } catch {return;}
}

/** 기능 계약 — 경로와 무관한 채팅 로그 파일의 정체(처리 구간 log_files의 content_key).
 * - 원본 파일 지문(inspectChatLogFile)은 경로·생성 시각을 섞어 같은 로그를 다른 폴더로 복사하면 다른 파일이 된다.
 *   처리 구간과 일지 행의 원본 위치는 "경로가 달라도 같은 줄은 같은 기록" 계약을 지켜야 하므로 내용으로 파일을 정한다.
 * - 키 = sha256(로그 날짜, 파일의 첫 시각 표시 줄의 원본 byte). 줄이 생긴 뒤에는 파일이 커져도 바뀌지 않고,
 *   복사본은 같은 키다. 첫 64KB 안에 시각 표시 줄이 없으면 undefined(그때는 기록 줄도 없다).
 * - 함께 앞부분 표본(처음 등록할 때의 앞 최대 4KB 길이와 해시)을 돌려준다. 같은 키의 다른 경로가 들어오면 그 길이만큼
 *   다시 읽어 비교해, 같은 날짜 파일을 다른 내용으로 다시 쓴 경우를 다른 파일로 가린다(위치 기반 구간이 엉뚱한 줄을 덮지 않게).
 * 회귀: check-profile-lifecycle.ts(다른 폴더 복사본), check-profile-log-restore.ts(같은 날짜 파일 다시 쓰기). */
export function computeLogIdentity(filePath:string,logDate:string):{contentKey:string;probeLength:number;probeHash:string} | undefined {
  const head=readPrefix(filePath,CONTENT_KEY_PROBE_BYTES);
  if (!head) return;
  const encoding=detectChatLogEncoding(head);
  let from=0;
  for (let index=head.indexOf(10);index!==-1;index=head.indexOf(10,from)) {
    const raw=head.subarray(from,index);
    if (TIMESTAMP.test(iconv.decode(raw,encoding))) {
      const probe=head.subarray(0,Math.min(head.length,PREFIX_PROBE_BYTES));
      return {contentKey:createHash('sha256').update(logDate).update('\0').update(raw).digest('hex'),
        probeLength:probe.length,probeHash:createHash('sha256').update(probe).digest('hex')};
    }
    from=index+1;
  }
}

export function computeLogContentKey(filePath:string,logDate:string):string | undefined {
  return computeLogIdentity(filePath,logDate)?.contentKey;
}

/** 저장한 앞부분 표본과 이 파일의 같은 길이 앞부분이 같은지. 파일이 그보다 짧으면 다르다. */
export function matchesLogPrefix(filePath:string,probeLength:number,probeHash:string):boolean {
  const head=readPrefix(filePath,probeLength);
  return !!head && head.length===probeLength && createHash('sha256').update(head).digest('hex')===probeHash;
}

/** 파일 크기. 없거나 읽지 못하면 undefined. */
export function logFileSize(filePath:string):number | undefined {
  try {return fs.statSync(filePath).size;} catch {return;}
}

function hashEnd(fd:number,size:number,end:number):string | undefined {
  if (size<end) return;
  const start=Math.max(0,end-64),bytes=Buffer.alloc(end-start);
  fs.readSync(fd,bytes,0,bytes.length,start);
  return createHash('sha256').update(bytes).digest('hex').slice(0,16);
}

/** 처리 구간 끝 바로 앞 64byte의 해시. 파일이 그 위치보다 짧으면 undefined.
 * 구간을 늘릴 때 저장하고, 복원·실시간 준비 때 다시 계산해 파일이 다른 내용으로 바뀐 구간을 가려낸다. */
export function sampleLogEnd(filePath:string,end:number):string | undefined {
  try {
    const fd=fs.openSync(filePath,'r');
    try {return hashEnd(fd,fs.fstatSync(fd).size,end);}
    finally {fs.closeSync(fd);}
  } catch {return;}
}

/** sampleLogEnd와 같은 표본이지만 "파일이 그 위치보다 짧음"(null, 내용이 바뀐 것)과 "열거나 읽지 못함"(undefined:
 * 없음·백신 등의 잠깐 잠금)을 구분한다. 미룬 구간 쓰기(ApplicationData.flushDeferredRange)가 잠깐 못 읽은 파일의 구간을
 * 바뀐 파일로 보고 버리지 않게 하려고 쓴다. */
export function readLogEndSample(filePath:string,end:number):string | null | undefined {
  let fd:number;
  try {fd=fs.openSync(filePath,'r');} catch {return;}
  try {return hashEnd(fd,fs.fstatSync(fd).size,end) ?? null;}
  catch {return;}
  finally {try {fs.closeSync(fd);} catch {/* 이미 닫힘 */}}
}

/** 기능 계약 — 여러 구간을 한꺼번에 쓰는 동안(v3.3.5 대기 원문 변환 한 번) 파일마다 한 번만 열고 크기를 한 번만 잰다.
 * 구간마다 statSync·open·close를 하면 줄 사이가 자주 끊기는 실제 로그에서 1분 압축이 메인 스레드를 1초 넘게 막았다.
 * 결과는 sampleLogEnd·logFileSize와 같다(같은 호출 안에서는 파일이 바뀌지 않는다고 본다). close()로 핸들을 닫는다.
 * 회귀: check-profile-storage.ts(변환 결과), 측정: scripts/benchmark-convert-live-rows.ts. */
export class LogFileProbe {
  private readonly files=new Map<string,{fd?:number;size?:number}>();
  private open(filePath:string):{fd?:number;size?:number} {
    let entry=this.files.get(filePath);
    if (entry===undefined) {
      try {const fd=fs.openSync(filePath,'r');entry={fd,size:fs.fstatSync(fd).size};}
      // 열지 못해도(잠깐 잠금) 크기는 stat으로 잰다(logFileSize와 같다). 이미 잘린 파일보다 긴 구간을 쓰지 않게 한다.
      catch {entry={size:logFileSize(filePath)};}
      this.files.set(filePath,entry);
    }
    return entry;
  }
  size(filePath:string):number | undefined {return this.open(filePath).size;}
  sampleEnd(filePath:string,end:number):string | undefined {
    const entry=this.open(filePath);
    if (entry.fd===undefined || entry.size===undefined) return;
    try {return hashEnd(entry.fd,entry.size,end);} catch {return;}
  }
  close():void {
    for (const entry of this.files.values()) if (entry.fd!==undefined) {try {fs.closeSync(entry.fd);} catch {/* 이미 닫힘 */}}
    this.files.clear();
  }
}
