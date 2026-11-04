import type { AppConfig, ContentsCheckerItem } from './types';

/** 사용자와 합의한 소유권 목록. 공통/기기 설정을 프로필 전체 복사로 오염시키지 않는다. */
export const PROFILE_SETTING_KEYS = [
  'userServer', 'lootKeywords', 'customAlerts', 'buffTimerEnabled', 'buffTimerBuffs',
  'buffTimerWarnSeconds', 'buffTimerAudioAlert', 'buffTimerVisualAlert', 'buffTimerCenterAlert',
  'xpAutoStart', 'xpAutoPauseEnabled', 'xpAutoPauseSeconds', 'xpEfficiencyAlertEnabled',
  'xpEfficiencyDropPercent', 'xpEfficiencyMinAmount', 'ignoreNegativeXp',
  'huntingExpDopings', 'huntingExpGrounds', 'huntingExpSelectedGroundId',
  'huntingExpKillsPerHour', 'huntingExpHappyHour', 'fieldBossNotifyEnabled',
  'fieldBossNotifyOffsets', 'fieldBossSettings', 'bossEntryCountdownBosses',
  'pinnedNoteText', 'abandonedEnabled', 'abandonedAutoHideMinutes', 'digsiteHudEnabled',
  'essenceAlertEnabled', 'specialMonsterAlertEnabled', 'golgothaAlertEnabled',
  'abandonedAlertEnabled', 'pittaHillAlertEnabled', 'questCompleteAlertEnabled',
  'abyssTreasureAlertEnabled', 'waveMonsterWarningEnabled', 'ethosAlertEnabled',
  'abyssApostleAlertEnabled', 'lokagosAlertEnabled', 'supplyHelperEnabled',
] as const satisfies readonly (keyof AppConfig)[];

/** 프로필 공통 DB 데이터. Google 전송 여부는 별도 허용 목록(닉네임 메모 제외)을 따른다. */
export const SHARED_SETTING_KEYS = [
  'tradeServer', 'tradeKeywords', 'tradeNotify', 'wordAlarmEnabled', 'wordAlarmKeywords',
  'wordAlarmHistoryEnabled', 'shoutKeywords', 'galleryKeywords', 'galleryNotify',
  'nicknameNotes', 'discordKeywords', 'discordRules',
] as const satisfies readonly (keyof AppConfig)[];

export const CHECKLIST_PROJECTION_KEYS = [
  'contentsCheckerItems', 'characterPresets', 'selectedCharacterId', 'pendingHomeworks',
  'lastContentsResetCheck', 'contentsAutoAssignSingleCandidate',
] as const satisfies readonly (keyof AppConfig)[];

export const DATABASE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...PROFILE_SETTING_KEYS, ...SHARED_SETTING_KEYS, ...CHECKLIST_PROJECTION_KEYS, 'activityPresets',
]);

export interface PlayProfile {
  id: string;
  name: string;
  /** 기존 환경설정 userServer와 같은 값이며 별도 서버 필드가 아니다. */
  userServer: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  deletedAt: number | null;
}

export interface ProfileClockStamp {
  utcMs: number;
  source: 'internet' | 'unverified';
  uncertaintyMs: number | null;
}

export interface PlayProfileStatus {
  profiles: PlayProfile[];
  activeProfileId: string;
  selectionRequired: boolean;
  sessionId: string | null;
  busy: boolean;
  pendingSessions: Array<{sessionId:string;count:number;firstOccurredAt:number;lastOccurredAt:number}>;
}

export interface PlayProfileResult { success:boolean; error?:string; profileId?:string; status:PlayProfileStatus }

export interface PlayProfilesApi {
  getPlayProfiles(): Promise<PlayProfileStatus | null>;
  createPlayProfile(name:string,userServer:number,copySettingsFrom?:string): Promise<PlayProfileResult>;
  updatePlayProfile(id:string,name:string,userServer:number): Promise<PlayProfileResult>;
  selectPlayProfile(id:string): Promise<PlayProfileResult>;
  deletePlayProfile(id:string): Promise<PlayProfileResult>;
  assignPlayProfileSession(sessionId:string): Promise<PlayProfileResult>;
  onPlayProfilesChanged(callback:(status:PlayProfileStatus) => void): void;
  closePlayProfiles(): void;
}

export type HomeworkState = ContentsCheckerItem['completedState'][string];

export function isProfileServer(value: unknown): value is number {
  return value === 7 || value === 16;
}

export function assertProfileName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40
    || /[\u0000-\u001f]/u.test(value)) throw new Error('프로필 이름은 1~40자로 입력하세요.');
}

export function deviceConfigOnly(config: Partial<AppConfig>): Partial<AppConfig> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !DATABASE_CONFIG_KEYS.has(key)));
}
