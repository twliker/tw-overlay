import type { ActivityPreset, AppConfig, WindowPositionKey } from './types';

export const ACTIVITY_WINDOWS = ['xpHud', 'buffTimer', 'trade', 'diary', 'focusedChat', 'shoutHistory', 'contentsChecker', 'chatOverlay', 'chatOverlaySub', 'chatOverlaySub2'] as const satisfies readonly WindowPositionKey[];
export const ACTIVITY_SETTING_KEYS = [
  'positions', 'windowedFullscreenPositions', 'fixedWindowPositions', 'managedWindowSizes',
  'contentsCheckerEnabled', 'contentsAutoCollapse', 'chatOverlayEnabled', 'chatOverlaySubEnabled', 'chatOverlaySub2Enabled',
  'chatOverlayOpacity', 'chatOverlaySubOpacity', 'chatOverlaySub2Opacity',
  'chatOverlayFontSize', 'chatOverlaySubFontSize', 'chatOverlaySub2FontSize',
  'chatOverlayFontFamily', 'chatOverlaySubFontFamily', 'chatOverlaySub2FontFamily',
  'pinnedNoteFontSize', 'pinnedNoteColor', 'pinnedNoteBackground', 'windowSnapEnabled',
  'chatOverlayWidth', 'chatOverlayHeight', 'chatOverlaySubWidth', 'chatOverlaySubHeight', 'chatOverlaySub2Width', 'chatOverlaySub2Height',
  'focusedChatWidth', 'focusedChatHeight', 'contentsCheckerWidth', 'contentsCheckerHeight',
  'chatOverlayClickThrough', 'chatOverlayVisibleTabs', 'chatOverlayTab', 'chatOverlaySubTab', 'chatOverlaySub2Tab',
  'chatOverlaySelectedChannels', 'chatOverlayShowNpcChat', 'chatOverlayShowXpGain', 'chatOverlayShowElsoGain',
  'chatOverlayShowFreeShout', 'chatOverlayShowPaidShout', 'chatOverlayShowNoticeShout',
  'chatNicknameNotesCompact', 'chatCompactDisplay', 'chatEtaColorsEnabled', 'chatEtaColors',
  'showXpWidget', 'showBuffHud', 'showHudShortcuts', 'showTodaySummaryHud', 'todaySummaryCollapsed',
  'xpWidgetPos', 'buffTimerHudPos', 'todaySummaryHudPos', 'abandonedWidgetPos', 'digsiteWidgetPos', 'forgeQuestHudPos',
  'abandonedEnabled', 'digsiteHudEnabled', 'pinnedNoteEnabled', 'pinnedNotePos', 'supplyHelperEnabled', 'supplyMapEnabled', 'supplyMapLarge', 'supplyHudPos',
  'xpAutoStart', 'xpAutoPauseEnabled', 'xpAutoPauseSeconds', 'xpEfficiencyAlertEnabled', 'xpEfficiencyDropPercent', 'xpEfficiencyMinAmount',
  'xpEfficiencyAlertSound', 'xpEfficiencyAlertVolume', 'ignoreNegativeXp',
  'fieldBossNotifyEnabled', 'fieldBossNotifyOffsets', 'fieldBossNotifyVolume', 'fieldBossSettings', 'bossEntryCountdownBosses',
  'wordAlarmEnabled', 'wordAlarmSound', 'wordAlarmVolume',
  'buffTimerEnabled', 'buffTimerWarnSeconds', 'buffTimerAudioAlert', 'buffTimerVisualAlert', 'buffTimerVolume', 'buffTimerSound', 'buffTimerBuffs', 'buffTimerCenterAlert',
  'essenceAlertEnabled', 'essenceAlertSound', 'essenceAlertVolume',
  'specialMonsterAlertEnabled', 'abandonedAlertEnabled', 'pittaHillAlertEnabled', 'questCompleteAlertEnabled', 'questCompleteAlertSound', 'questCompleteAlertVolume',
  'abyssTreasureAlertEnabled', 'abyssTreasureAlertSound', 'abyssTreasureAlertVolume',
  'waveMonsterWarningEnabled', 'waveMonsterWarningSound', 'waveMonsterWarningVolume', 'ethosAlertEnabled', 'ethosAlertSound', 'ethosAlertVolume',
  'abyssApostleAlertEnabled', 'abyssApostleStartSound', 'abyssApostleEndSound', 'abyssApostleVolume', 'lokagosAlertEnabled', 'lokagosAlertSound', 'lokagosAlertVolume',
  'showSidebarToastOnOverlay', 'notificationPositions',
] as const satisfies readonly (keyof AppConfig)[];
const maps = new Set(['positions', 'windowedFullscreenPositions', 'fixedWindowPositions', 'managedWindowSizes']);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** 활동 전환은 표시·배치·알림만 바꾼다. 기록/캐릭터/개인 메모/로그 경로/연동 자격은 저장하지 않는다. */
export function captureActivitySettings(config: Partial<AppConfig>): Partial<AppConfig> {
  const result: Record<string, unknown> = {};
  for (const key of ACTIVITY_SETTING_KEYS) {
    const value = config[key];
    if (value === undefined) continue;
    result[key] = maps.has(key)
      ? Object.fromEntries(Object.entries(value as object).filter(([window]) => (ACTIVITY_WINDOWS as readonly string[]).includes(window)))
      : value;
  }
  return clone(result);
}

/** 기능 계약: 버프 ID가 생략된 기존 스냅샷도 저장 당시의 기본 ON 상태를 복원한다.
 * 현재 설정에 나중에 생긴 ID도 같은 기본값을 적용하되, 맵 자체가 없는 부분 프리셋은 유지한다.
 * 일반 부분 설정 저장·비활동 설정은 변경하지 않는다. 회귀: check-companion-features의 실제 파일/버프 감지 검사.
 */
export function mergeActivitySettings(current: AppConfig, saved: Partial<AppConfig>): Partial<AppConfig> {
  const patch = captureActivitySettings(saved) as Record<string, unknown>;
  for (const key of maps) {
    if (patch[key]) patch[key] = { ...(current as unknown as Record<string, object>)[key], ...(patch[key] as object) };
  }
  // 버프 ID 생략은 기본 ON이다. 기존 프리셋에도 적용되도록 복원 시 현재 맵의 추가 키까지
  // 명시한다. 일반 설정의 재귀 부분 병합이 이후에 저장한 false를 남기지 않게 한다.
  // 프리셋에 buffTimerBuffs 필드 자체가 없다면 그 설정은 전환하지 않는다.
  if (saved.buffTimerBuffs !== undefined) {
    const ids = new Set([...Object.keys(current.buffTimerBuffs || {}), ...Object.keys(saved.buffTimerBuffs)]);
    patch.buffTimerBuffs = Object.fromEntries([...ids].map(id => [id, saved.buffTimerBuffs![id] !== false]));
  }
  return patch;
}

export function isActivityPresets(value: unknown): value is ActivityPreset[] {
  if (!Array.isArray(value) || value.length > 12) return false;
  const ids = new Set<string>();
  return value.every(preset => {
    if (!preset || typeof preset !== 'object' || typeof preset.id !== 'string' || !/^[\w-]{1,64}$/.test(preset.id)
      || ids.has(preset.id) || typeof preset.name !== 'string' || !preset.name.trim() || preset.name.length > 32
      || !Number.isSafeInteger(preset.updatedAt) || preset.updatedAt < 0
      || !Array.isArray(preset.openWindows) || new Set(preset.openWindows).size !== preset.openWindows.length
      || (preset.openWindows.some((key: string) => key === 'chatOverlaySub' || key === 'chatOverlaySub2') && !preset.openWindows.includes('chatOverlay'))
      || preset.openWindows.some((key: string) => !(ACTIVITY_WINDOWS as readonly string[]).includes(key))
      || !preset.settings || typeof preset.settings !== 'object' || Array.isArray(preset.settings)
      || Object.keys(preset.settings).some(key => !(ACTIVITY_SETTING_KEYS as readonly string[]).includes(key))) return false;
    for (const key of maps) {
      const map = preset.settings[key];
      if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map)
        || Object.keys(map).some(window => !(ACTIVITY_WINDOWS as readonly string[]).includes(window)))) return false;
    }
    ids.add(preset.id);
    return true;
  });
}
