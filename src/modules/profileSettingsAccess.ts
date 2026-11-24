import type {WebContents} from 'electron';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {getProfileRuntime} from './profileRuntime';

/** 프로필 설정 초안을 가진 화면과 사용자에게 보여 줄 창 이름(각 HTML의 title). */
const settingsPages=new Map(Object.entries({
  'settings.html':'환경 설정','hunting-exp-calculator.html':'사냥 경험치 계산기','xp-hud.html':'경험치 HUD',
  'buff-timer.html':'버프 타이머 알림 설정','boss-settings.html':'필드보스 알림 설정','custom-alert.html':'커스텀 알림',
  'pinned-note.html':'고정 메모',
}).map(([name,label]) => [pathToFileURL(path.resolve(__dirname,'..',name)).href,label]));
export const isProfileSettingsPage=(url:string):boolean => settingsPages.has(url.split(/[?#]/)[0]);
export const profileSettingsPageLabel=(url:string):string => settingsPages.get(url.split(/[?#]/)[0]) || '환경 설정';

/** 설정 초안의 저장 대상은 입력 화면이 받은 ID다. 전환 뒤 늦은 요청은 공통 항목까지
 * 한 묶음으로 거부해 부분 저장하지 않는다. 일반 설정 창은 ID 생략도 거부한다.
 * settings 및 독립 프로필 설정 5개 페이지는 같은 경계를 사용한다. 공통 전용 페이지는
 * 기존 호출 형식을 유지한다. 회귀: check-profile-settings.ts, check-profile-settings-pages.ts. */
export function validateSettingsProfileWrite(source:WebContents | undefined,expectedId:unknown):'profile-changed' | 'profile-restore-busy' | 'profile-storage-busy' | undefined {
  const runtime=getProfileRuntime();if (!runtime) return;
  try {
    if (isProfileSettingsPage(source?.getURL() || '') && runtime.service.isStorageMaintenanceActive()) return 'profile-storage-busy';
    if (isProfileSettingsPage(source?.getURL() || '') && runtime.service.isHistoricalRestoreActive()) return 'profile-restore-busy';
    if (expectedId===undefined && !isProfileSettingsPage(source?.getURL() || '')) return;
    const id=runtime.service.status().activeProfileId;
    if (typeof expectedId!=='string' || !id || expectedId!==id) return 'profile-changed';
  } catch {return 'profile-changed';} // 복원/창 종료 중에도 비동기 send가 메인을 종료하지 않는다.
}
