import type {ProfileClockStamp} from './playProfiles';

export type SyncVector=Record<string,number>;
export interface SyncValue {
  device:string;
  sequence:number;
  context:SyncVector;
  /** legacyMigration: v3.2.2에서 PC마다 따로 보관하던 값을 이전할 때 처음 기록한 셀(메모·발굴지 안내만). */
  clock:ProfileClockStamp & {homeworkExpiresAt?:number;homeworkCutoffAt?:number;legacyMigration?:true};
  value:unknown;
}
export interface ProfileSyncEnvelope {
  format:'tw-overlay-profiles';
  version:1;
  device:string;
  sequence:number;
  cells:Record<string,SyncValue>;
}
export interface ProfileSyncReview {
  key:string;
  label:string;
  current:unknown;
  candidates:Array<{id:string;device:string;changedAt:number;value:unknown}>;
  reason:'conflict' | 'playing-profile' | 'settings-profile' | 'pending-records';
}
export interface ProfileSyncDetails {
  version:1;
  connection:'disconnected' | 'checking' | 'choice' | 'ready';
  pending:number;
  reviews:ProfileSyncReview[];
  remoteProfiles?:Array<{id:string;name:string;server:number | null}>;
  remoteIdentityConflicts?:number;
  damagedFiles?:number;
  oversizedToolValues?:number;
  /** heldCells: 형식 검증을 통과하지 못해 이 PC에만 보관한 셀 수(나머지는 전송). */
  uploadSizing?:{fullBytes:number;uploadBytes:number;deferredTools:number;deferredLabels?:string[];heldCells?:number;heldLabels?:string[]};
  uploadBlocked?:boolean;
  lastCheckedAt?:number;
  lastUploadedAt?:number;
  /** 편집 중인 계산기 창 때문에 다른 PC의 변경 반영만 미룬 상태의 안내(오류 아님). 이 PC의 변경은 계속 전송한다. */
  remoteDeferred?:string;
  localProfileCount?:number;
  backupAvailable:boolean;
  requests:number;
  uploadedBytes:number;
  downloadedBytes:number;
}
export type ProfileSyncConnectionChoice='merge' | 'remote' | 'local';
export interface ProfileSyncApi {
  googleSyncGetStatus():Promise<import('./types').GoogleSyncStatus>;
  googleSyncLogin():Promise<{success:boolean;status:import('./types').GoogleSyncStatus;error?:string}>;
  googleSyncCancelLogin():Promise<boolean>;
  googleSyncLogout():Promise<import('./types').GoogleSyncStatus>;
  googleSyncBackup():Promise<import('./types').GoogleSyncResult>;
  googleSyncToggleAuto(enabled:boolean):Promise<import('./types').GoogleSyncStatus>;
  googleSyncShowBackup():Promise<void>;
  googleSyncConnectChoice(choice:ProfileSyncConnectionChoice):Promise<{success:boolean;error?:string;message?:string}>;
  /** "나중에 설정"으로 끈 동기화를 유지 중인 로그인으로 다시 켠다(브라우저 로그인 없음). */
  googleSyncResume():Promise<{success:boolean;status:import('./types').GoogleSyncStatus;error?:string;message?:string}>;
  googleSyncResolve(key:string,candidate:string):Promise<{success:boolean;error?:string;message?:string}>;
}
export const PROFILE_SYNC_POLICY=Object.freeze({activeMs:30_000,idleMs:300_000,
  userDebounceMs:3_000,userMaxMs:10_000,idleAutoDebounceMs:30_000,idleAutoMaxMs:60_000,
  maxFileBytes:16*1024*1024,maxDecodedBytes:64*1024*1024,maxCells:400_000,retryMaxMs:900_000,shutdownMs:3_000,
  // 편집 중인 계산기 창 때문에 원격 반영을 미뤘을 때 다시 확인하는 간격. 실패 재시도(지수 대기)와 별개다.
  editorRetryMs:15_000});
