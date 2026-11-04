import type {ProfileClockStamp} from './playProfiles';

export type SyncVector=Record<string,number>;
export interface SyncValue {
  device:string;
  sequence:number;
  context:SyncVector;
  clock:ProfileClockStamp;
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
  reason:'conflict' | 'playing-profile';
}
export interface ProfileSyncDetails {
  version:1;
  connection:'disconnected' | 'checking' | 'choice' | 'ready';
  pending:number;
  reviews:ProfileSyncReview[];
  remoteProfiles?:Array<{id:string;name:string;server:number | null}>;
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
  googleSyncConnectChoice(choice:ProfileSyncConnectionChoice):Promise<{success:boolean;error?:string}>;
  googleSyncResolve(key:string,candidate:string):Promise<{success:boolean;error?:string}>;
}
export const PROFILE_SYNC_POLICY=Object.freeze({activeMs:30_000,idleMs:300_000,
  userDebounceMs:3_000,userMaxMs:10_000,idleAutoDebounceMs:30_000,idleAutoMaxMs:60_000,
  maxFileBytes:16*1024*1024,maxCells:100_000,retryMaxMs:900_000,shutdownMs:3_000});
