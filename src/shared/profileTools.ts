/** 캐릭터 계산 입력/도핑 선택. 가격·창 배치·공용 도구 이력은 기존 공용 저장소에 둔다. */
export const PROFILE_TOOL_KEYS=[
  'buff_presets','buff_current_selection','buff_active_preset_id',
  'tw-coefficient-calculator-profiles-v1','tw-coefficient-calculator-profiles-v1_last',
  'tw-coefficient-calculator-settings-v7final',
] as const;
export type ProfileToolKey=typeof PROFILE_TOOL_KEYS[number];
export const isProfileToolKey=(key:unknown):key is ProfileToolKey => typeof key==='string' && (PROFILE_TOOL_KEYS as readonly string[]).includes(key);
export interface ProfileToolContext {enabled:boolean;profileId:string | null;name:string;token:string;values:Record<string,string>}
export interface ProfileToolsApi {
  getProfileToolContext():Promise<ProfileToolContext>;
  writeProfileTool(token:string,key:ProfileToolKey,value:string | null):{success:boolean;error?:string};
  onProfileToolsChanged(callback:(change:{profileId:string;key:string;value:string | null}) => void):void;
}
