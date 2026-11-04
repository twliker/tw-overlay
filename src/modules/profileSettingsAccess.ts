import type {WebContents} from 'electron';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {getProfileRuntime} from './profileRuntime';

const settingsUrls=new Set(['settings.html','hunting-exp-calculator.html','xp-hud.html','buff-timer.html','boss-settings.html','custom-alert.html']
  .map(name => pathToFileURL(path.resolve(__dirname,'..',name)).href));
export const isProfileSettingsPage=(url:string):boolean => settingsUrls.has(url.split(/[?#]/)[0]);

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
