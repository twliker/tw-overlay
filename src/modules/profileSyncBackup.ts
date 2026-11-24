import * as fs from 'node:fs';
import * as path from 'node:path';
import {Worker,isMainThread,workerData} from 'node:worker_threads';
import AdmZip from 'adm-zip';
import type Database from 'better-sqlite3';
import {createUserDataSnapshot,verifyUserDataSnapshot} from './localSnapshot';

interface ArchiveJob {
  directory:string;
  stage:string;
  databasePath:string;
  appVersion:string;
}

function writeArchive({directory,stage,databasePath,appVersion}:ArchiveJob):void {
  const snapshot=path.join(stage,'snapshot');
  createUserDataSnapshot(directory,snapshot,{
    reason:'before-google-profile-sync',appVersion,allowedDestinationRoot:stage,profileDatabaseSnapshot:databasePath,
  });
  verifyUserDataSnapshot(snapshot,{enforceRestoreAllowlist:true});
  const file=path.join(stage,'archive.zip'),zip=new AdmZip();
  zip.addLocalFolder(snapshot);
  zip.writeZip(file);
  const fd=fs.openSync(file,'r+');
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  if (!new AdmZip(file).test()) throw new Error('연결 전 백업 ZIP 검증에 실패했습니다. 로컬 데이터를 유지했습니다.');
}

if (!isMainThread) writeArchive(workerData as ArchiveJob);

/** 기능 계약 — Google 연결 전 백업의 보관 개수와 작업 폴더 정리.
 * - 백업은 `<userData>/backups/before-google-profile-sync-XXXXXX.zip`(mkdtemp 6자)이며 연결·계정 전환·복원 뒤 재선택마다 생긴다.
 * - 새 백업을 확정한 뒤 최근 PROFILE_SYNC_BACKUP_LIMIT개만 남긴다. 설정 화면이 가리키는 백업(keep)은 개수와 무관하게 지우지 않는다.
 * - 작업 폴더 `.before-google-profile-sync-XXXXXX`는 정상 종료 때 지운다. 강제 종료로 남은 폴더는 다음 백업 생성과 앱 시작 때
 *   지운다. 이 프로세스가 쓰는 작업 폴더는 지우지 않는다.
 * - backups 폴더 바로 아래에서 정확히 이 이름 형식인 일반 파일·폴더만 지운다(심볼릭 링크·다른 백업은 건드리지 않음).
 * 회귀: check-profile-sync.ts(연결 전 백업 보관 개수와 작업 폴더 정리). */
export const PROFILE_SYNC_BACKUP_LIMIT=3;
const BACKUP_FILE=/^before-google-profile-sync-[A-Za-z0-9]{6}\.zip$/;
const BACKUP_STAGE=/^\.before-google-profile-sync-[A-Za-z0-9]{6}$/;
const activeStages=new Set<string>();

export async function removeStaleProfileSyncBackupStages(directory:string):Promise<number> {
  const root=path.resolve(directory,'backups');
  let names:string[];
  try {names=await fs.promises.readdir(root);} catch (error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return 0;throw error;}
  let removed=0;
  for (const name of names) {
    const stage=path.join(root,name);
    if (!BACKUP_STAGE.test(name) || activeStages.has(stage)) continue;
    const stat=await fs.promises.lstat(stage).catch(()=>undefined);
    if (!stat?.isDirectory()) continue;
    await fs.promises.rm(stage,{force:true,recursive:true,maxRetries:3});removed++;
  }
  return removed;
}

/** 최근 백업 limit개와 keep 경로만 남긴다. 반환값은 지운 파일 수. */
export async function pruneProfileSyncBackups(directory:string,keep:readonly string[]=[],limit=PROFILE_SYNC_BACKUP_LIMIT):Promise<number> {
  const root=path.resolve(directory,'backups');
  const kept=new Set(keep.map(file=>path.resolve(file)));
  let names:string[];
  try {names=await fs.promises.readdir(root);} catch (error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return 0;throw error;}
  const backups:Array<{file:string;time:number}>=[];
  for (const name of names) {
    if (!BACKUP_FILE.test(name)) continue;
    const file=path.join(root,name),stat=await fs.promises.lstat(file).catch(()=>undefined);
    if (stat?.isFile()) backups.push({file,time:stat.mtimeMs});
  }
  backups.sort((a,b)=>b.time-a.time || b.file.localeCompare(a.file));
  let removed=0;
  for (const {file} of backups.slice(Math.max(0,limit))) {
    if (kept.has(file)) continue;
    await fs.promises.rm(file,{force:true});removed++;
  }
  return removed;
}

/** WAL을 직접 복사하지 않고 SQLite 온라인 백업으로 일관된 DB를 얻는다.
 * 파일 검증과 압축은 워커에서 실행한다. ZIP을 검증한 뒤 최종 이름으로 옮긴다.
 */
export async function createProfileSyncBackup(
  database:Database.Database,directory:string,appVersion:string,onCleanupError:(error:unknown)=>void,
):Promise<string> {
  const root=path.resolve(directory,'backups');
  await fs.promises.mkdir(root,{recursive:true});
  await removeStaleProfileSyncBackupStages(directory).catch(onCleanupError);
  const stage=await fs.promises.mkdtemp(path.join(root,'.before-google-profile-sync-'));
  activeStages.add(stage);
  const databasePath=path.join(stage,'database.sqlite');
  const target=path.join(root,`${path.basename(stage).slice(1)}.zip`);
  try {
    await database.backup(databasePath);
    await new Promise<void>((resolve,reject)=>{
      const worker=new Worker(__filename,{workerData:{directory,stage,databasePath,appVersion} satisfies ArchiveJob});
      let failure:Error | undefined;
      worker.once('error',error=>{failure=error;});
      worker.once('exit',code=>{
        if (failure || code!==0) reject(failure ?? new Error(`백업 작업이 종료됐습니다 (${code}).`));
        else resolve();
      });
    });
    await fs.promises.rename(path.join(stage,'archive.zip'),target);
    return target;
  } finally {
    if (path.dirname(path.resolve(stage))===root) {
      await fs.promises.rm(stage,{force:true,recursive:true,maxRetries:3}).catch(onCleanupError);
    }
    activeStages.delete(stage);
  }
}
