/**
 * 로컬 설정 저장과 클라우드 수신이 공유하는 런타임 적용 경계.
 * 명시적 저장은 patch에 들어온 값을 같아도 재적용한다. 클라우드 수신은 변경된 값만 적용한다.
 * 자동 실행 안내는 해당 설정을 직접 저장할 때만 표시한다. 동기화·롤백 적용은 대화상자를 띄우지 않는다.
 */
import { isDeepStrictEqual } from 'util';
import type { AppConfig } from '../shared/types';
import * as sm from './shortcutManager';
import * as gallery from './galleryMonitor';
import * as trade from './tradeMonitor';
import { analytics } from './analytics';
import { setupAutoStart } from './autoStart';
import * as diaryDb from './diaryDb';
import { broadcastToAllWindows } from './windowMessaging';

export function applyRuntimeSettings(previous: AppConfig, next: AppConfig, explicitPatch?: Partial<AppConfig>): void {
  const changed = (key: keyof AppConfig) => Object.prototype.hasOwnProperty.call(explicitPatch || {}, key)
    || !isDeepStrictEqual(previous[key], next[key]);
  if (changed('analyticsEnabled')) analytics.refreshEnabledState();
  if (changed('autoLaunch') && next.autoLaunch !== undefined) {
    setupAutoStart(next.autoLaunch, explicitPatch?.autoLaunch !== undefined);
  }
  if (changed('shortcuts')) sm.reloadShortcuts();
  if (explicitPatch || changed('galleryKeywords') || changed('galleryNotify')) gallery.updateWindows(null, null, null);
  if (explicitPatch || changed('tradeKeywords') || changed('tradeServer') || changed('tradeNotify')) trade.updateWindows(null, null);
  if (changed('diaryKeepDays') && next.diaryKeepDays && next.diaryKeepDays > 0) {
    analytics.trackEvent('diary_data_cleanup', { keepDays: next.diaryKeepDays, trigger: 'settings_change' });
    diaryDb.cleanOldDiaryData(next.diaryKeepDays);
  }
  if (changed('lootKeywords')) broadcastToAllWindows('diary-updated');
}
