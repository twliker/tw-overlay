/**
 * 동기화 대상 데이터 추출, 병합(Merge) 및 충돌 방지 헬퍼 모듈
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AppConfig, ContentsCheckerItem, GoogleSyncPayload, CharacterPreset } from '../shared/types';
import { log } from './logger';

const BACKUP_FILENAME = 'config.backup-sync.json';

/** 설정 파일에만 저장하는 휴대 가능한 필드. */
export const SETTINGS_SYNCABLE_KEYS: Array<keyof AppConfig> = [
  'contentsCheckerEnabled',
  'autoOpenContentsChecker',
  'selectedCharacterId',
  'galleryNotify',
  'galleryKeywords',
  'tradeServer',
  'tradeNotify',
  'tradeKeywords',
  'lootKeywords',
  'shoutKeywords',
  'wordAlarmKeywords',
  'wordAlarmSound',
  'wordAlarmVolume',
  'wordAlarmEnabled',
  'wordAlarmHistoryEnabled',
  'shortcuts',
  'quickSlots',
  'hiddenMenuIds',
  'visibleMenuIds',
  'sidebarPosition',
  'userServer',
  'huntingExpDopings',
  'huntingExpGrounds',
  'huntingExpSelectedGroundId',
  'huntingExpKillsPerHour',
  'huntingExpHappyHour',
  'showXpWidget',
  'xpAutoStart',
  'ignoreNegativeXp',
  'showTodaySummaryHud',
  'todaySummaryCollapsed',
  'buffTimerBuffs',
  'buffTimerWarnSeconds',
  'buffTimerCenterAlert',
  'buffTimerAudioAlert',
  'buffTimerVisualAlert',
  'buffTimerVolume',
  'buffTimerSound',
  'buffTimerEnabled',
  'showBuffHud',
  'showHudShortcuts',
  'fieldBossSettings',
  'fieldBossNotifyEnabled',
  'fieldBossNotifyOffsets',
  'fieldBossNotifyVolume',
  'customAlerts',
  'discordAlertEnabled',
  'discordKeywords',
  'discordRules',
  'ethosAlertEnabled',
  'ethosAlertSound',
  'ethosAlertVolume',
  'abyssApostleAlertEnabled',
  'abyssApostleStartSound',
  'abyssApostleEndSound',
  'abyssApostleVolume',
  'lokagosAlertEnabled',
  'lokagosAlertSound',
  'lokagosAlertVolume',
  'waveMonsterWarningEnabled',
  'waveMonsterWarningSound',
  'waveMonsterWarningVolume',
  'essenceAlertEnabled',
  'essenceAlertSound',
  'essenceAlertVolume',
  'specialMonsterAlertEnabled',
  'abandonedAlertEnabled',
  'pittaHillAlertEnabled',
  'questCompleteAlertEnabled',
  'abandonedAutoHideMinutes',
  'abandonedEnabled',
  'scamDetectorEnabled',
  'scamAlertSound',
  'volumeContentsChecker',
  'volumeCalculators',
  'followGameWindow',
  'gameExitReminderEnabled',
  'gameExitReminderMessage',
  'notifyWhenGameClosed',
  'chatLogAutoDeleteDays',
  'diaryKeepDays',
  'chatOverlayEnabled',
  'chatOverlaySubEnabled',
  'chatOverlaySub2Enabled',
  'chatOverlayFontSize',
  'chatOverlayOpacity',
  'chatOverlaySubOpacity',
  'chatOverlaySub2Opacity',
  'chatOverlayClickThrough',
  'chatOverlaySelectedChannels',
  'chatOverlayTab',
  'chatOverlaySubTab',
  'chatOverlaySub2Tab',
  'chatOverlayCustomTabs',
  'chatOverlayKeywords',
  'chatOverlayBlacklistFilters',
  'chatOverlayShowNpcChat',
  'chatOverlayShowXpGain',
  'chatOverlayShowElsoGain',
  'chatOverlayHighlightScamNicknames',
  'chatOverlayColorGeneral',
  'chatOverlayColorWhisper',
  'chatOverlayColorTeam',
  'chatOverlayColorClub',
  'chatOverlayColorShout',
  'chatOverlayNicknameColorMode',
  'chatOverlayNicknameColorGeneral',
  'chatOverlayNicknameColorWhisper',
  'chatOverlayNicknameColorTeam',
  'chatOverlayNicknameColorClub',
  'chatOverlayNicknameColorShout',
  'focusedChatSelfNickname',
  'showSidebarToastOnOverlay',
];

/** 숙제 진행 파일에만 저장하는 필드. */
export const CHECKLIST_SYNCABLE_KEYS: Array<keyof AppConfig> = [
  'contentsCheckerItems',
  'characterPresets',
  'pendingHomeworks',
];

const TOP_LEVEL_SOUND_KEYS = new Set<keyof AppConfig>([
  'wordAlarmSound',
  'buffTimerSound',
  'ethosAlertSound',
  'abyssApostleStartSound',
  'abyssApostleEndSound',
  'lokagosAlertSound',
  'waveMonsterWarningSound',
  'essenceAlertSound',
  'scamAlertSound',
]);

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getCustomSoundFileNames(cfg: AppConfig): Set<string> {
  return new Set((cfg.customSounds || []).map(sound => sound.file));
}

/** 다른 PC에서도 유효한 내장 사운드 ID인지 보수적으로 판별한다. */
function isPortableSoundId(value: unknown, customSoundFiles: Set<string> = new Set()): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  if (value === 'none') return true;
  if (customSoundFiles.has(value) || /^custom_/iu.test(value)) return false;
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  return true;
}

function sanitizeFieldBossSettings(
  settings: AppConfig['fieldBossSettings'],
  customSoundFiles: Set<string>,
): AppConfig['fieldBossSettings'] {
  if (!settings) return settings;
  const sanitized = cloneValue(settings);
  for (const boss of Object.values(sanitized)) {
    if (!isPortableSoundId(boss.soundFile, customSoundFiles)) delete (boss as Partial<typeof boss>).soundFile;
  }
  return sanitized;
}

function sanitizeCustomAlerts(
  alerts: AppConfig['customAlerts'],
  customSoundFiles: Set<string>,
): AppConfig['customAlerts'] {
  if (!alerts) return alerts;
  return cloneValue(alerts).map(alert => {
    if (!isPortableSoundId(alert.soundFile, customSoundFiles)) delete (alert as Partial<typeof alert>).soundFile;
    return alert;
  });
}

/** 로컬 설정에서 설정 파일 대상만 추출한다. */
export function extractSettingsSyncData(cfg: AppConfig): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};
  const customSoundFiles = getCustomSoundFileNames(cfg);
  for (const key of SETTINGS_SYNCABLE_KEYS) {
    if (cfg[key] !== undefined) {
      if (TOP_LEVEL_SOUND_KEYS.has(key) && !isPortableSoundId(cfg[key], customSoundFiles)) continue;
      if (key === 'fieldBossSettings') {
        result.fieldBossSettings = sanitizeFieldBossSettings(cfg.fieldBossSettings, customSoundFiles);
        continue;
      }
      if (key === 'customAlerts') {
        result.customAlerts = sanitizeCustomAlerts(cfg.customAlerts, customSoundFiles);
        continue;
      }
      (result as any)[key] = cloneValue(cfg[key]);
    }
  }
  return result;
}

/** 로컬 설정에서 숙제 파일 대상만 추출한다. */
export function extractChecklistSyncData(cfg: AppConfig): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};
  for (const key of CHECKLIST_SYNCABLE_KEYS) {
    if (cfg[key] !== undefined) (result as any)[key] = cloneValue(cfg[key]);
  }
  return result;
}

/** 기존 단일 파일 호환용 페이로드 데이터. */
export function extractSyncData(cfg: AppConfig): Partial<AppConfig> {
  const checklistData = extractChecklistSyncData(cfg);
  // 기존 단일 파일은 pending operation 병합 계약이 없었다.
  // 분리 파일의 outbox/3방향 병합이 연결되기 전까지 레거시 payload의 기존 동작을 보존한다.
  delete checklistData.pendingHomeworks;
  return {
    ...extractSettingsSyncData(cfg),
    ...checklistData,
  };
}

function buildPayload(data: Partial<AppConfig>, userEmail: string): GoogleSyncPayload {
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    lastSyncedAt: Date.now(),
    updatedBy: userEmail,
    data,
  };
}

export function buildSettingsSyncPayload(cfg: AppConfig, userEmail: string): GoogleSyncPayload {
  return buildPayload(extractSettingsSyncData(cfg), userEmail);
}

export function buildChecklistSyncPayload(cfg: AppConfig, userEmail: string): GoogleSyncPayload {
  return buildPayload(extractChecklistSyncData(cfg), userEmail);
}

/** 구글 드라이브 업로드용 페이로드 생성 */
export function buildSyncPayload(cfg: AppConfig, userEmail: string): GoogleSyncPayload {
  return buildPayload(extractSyncData(cfg), userEmail);
}

/** 동기화 전 로컬 config 안전 백업 생성 */
export function createLocalBackupBeforeSync(cfg: AppConfig): void {
  try {
    const backupPath = path.join(app.getPath('userData'), BACKUP_FILENAME);
    fs.writeFileSync(backupPath, JSON.stringify(cfg, null, 2), 'utf-8');
    log(`[SyncDataHelper] 동기화 전 로컬 백업 완료: ${backupPath}`);
  } catch (err) {
    log(`[SyncDataHelper] 로컬 백업 실패 (진행은 계속됨): ${err}`);
  }
}

/** 숙제 체크리스트 병합 (캐릭터별 lastCompletedAt 타임스탬프 기준 최신 우선) */
function mergeContentsCheckerItems(
  localItems: ContentsCheckerItem[] = [],
  cloudItems: ContentsCheckerItem[] = []
): ContentsCheckerItem[] {
  const localMap = new Map<string, ContentsCheckerItem>();
  for (const item of localItems) {
    localMap.set(item.id, JSON.parse(JSON.stringify(item)));
  }

  for (const cloudItem of cloudItems) {
    const localItem = localMap.get(cloudItem.id);
    if (!localItem) {
      // 로컬에 없는 아이템(신규 추가된 커스텀 숙제 등)은 추가
      localMap.set(cloudItem.id, JSON.parse(JSON.stringify(cloudItem)));
      continue;
    }

    // 기본 속성 병합 (커스텀 여부, 표시 여부 등)
    if (cloudItem.isVisible !== undefined) localItem.isVisible = cloudItem.isVisible;
    if (cloudItem.isCustom !== undefined) localItem.isCustom = cloudItem.isCustom;
    if (cloudItem.maxCount !== undefined) localItem.maxCount = cloudItem.maxCount;

    // 캐릭터별 완료 상태 병합
    if (cloudItem.completedState) {
      if (!localItem.completedState) localItem.completedState = {};

      for (const [charId, cloudState] of Object.entries(cloudItem.completedState)) {
        const localState = localItem.completedState[charId];
        if (!localState) {
          localItem.completedState[charId] = { ...cloudState };
          continue;
        }

        // 마지막 완료 시간 비교: 클라우드가 더 최신이고 클라우드 상태가 완료인 경우 덮어쓰기
        const localTime = localState.lastCompletedAt || 0;
        const cloudTime = cloudState.lastCompletedAt || 0;

        if (cloudTime > localTime && cloudState.isCompleted) {
          localItem.completedState[charId] = {
            ...localState,
            ...cloudState,
          };
        } else if (localTime === cloudTime) {
          // 시간이 같을 때 완료 여부, 제외 여부, 누적 횟수 반영
          if (cloudState.isExcluded !== undefined) {
            localState.isExcluded = cloudState.isExcluded;
          }
          if (cloudState.isCompleted && !localState.isCompleted && (cloudState.lastCompletedAt || 0) > (localState.lastCompletedAt || 0)) {
            localState.isCompleted = true;
          }
          if (cloudState.currentCount !== undefined && (localState.currentCount === undefined || cloudState.currentCount > (localState.currentCount || 0))) {
            localState.currentCount = cloudState.currentCount;
          }
        }
      }
    }
  }

  return Array.from(localMap.values());
}

/** 캐릭터 프리셋 목록 병합 */
function mergeCharacterPresets(
  localPresets: CharacterPreset[] = [],
  cloudPresets: CharacterPreset[] = []
): CharacterPreset[] {
  const map = new Map<string, CharacterPreset>();
  for (const p of localPresets) {
    map.set(p.id, { ...p });
  }
  for (const p of cloudPresets) {
    if (!map.has(p.id)) {
      map.set(p.id, { ...p });
    } else {
      // 이름이 업데이트되었을 수 있으므로 반영
      map.set(p.id, { ...p });
    }
  }
  return Array.from(map.values());
}

function mergeFieldBossSettings(
  localSettings: AppConfig['fieldBossSettings'],
  cloudSettings: AppConfig['fieldBossSettings'],
): AppConfig['fieldBossSettings'] {
  if (!cloudSettings) return localSettings;
  const merged = cloneValue(localSettings || {});
  for (const [bossId, cloudBossValue] of Object.entries(cloudSettings)) {
    const cloudBoss = cloneValue(cloudBossValue);
    if (!isPortableSoundId(cloudBoss.soundFile)) delete (cloudBoss as Partial<typeof cloudBoss>).soundFile;
    merged[bossId] = {
      ...(merged[bossId] || { name: cloudBoss.name, enabled: cloudBoss.enabled, soundFile: 'orb.mp3' }),
      ...cloudBoss,
    };
  }
  return merged;
}

function mergeCustomAlerts(
  localAlerts: AppConfig['customAlerts'],
  cloudAlerts: AppConfig['customAlerts'],
): AppConfig['customAlerts'] {
  if (!cloudAlerts) return localAlerts;
  const localById = new Map((localAlerts || []).map(alert => [alert.id, cloneValue(alert)]));
  return cloudAlerts.map(cloudAlertValue => {
    const cloudAlert = cloneValue(cloudAlertValue);
    if (!isPortableSoundId(cloudAlert.soundFile)) delete (cloudAlert as Partial<typeof cloudAlert>).soundFile;
    return {
      ...(localById.get(cloudAlert.id) || { soundFile: 'orb.mp3' }),
      ...cloudAlert,
    };
  });
}

/** 클라우드 데이터와 로컬 AppConfig 안전 병합 */
export function mergeSyncData(localCfg: AppConfig, cloudPayload: GoogleSyncPayload): AppConfig {
  const cloudData = cloudPayload.data || {};
  const merged: AppConfig = { ...localCfg };

  // 1. 숙제 체크리스트 정밀 병합
  if (cloudData.contentsCheckerItems) {
    merged.contentsCheckerItems = mergeContentsCheckerItems(
      localCfg.contentsCheckerItems,
      cloudData.contentsCheckerItems
    );
  }

  // 2. 캐릭터 프리셋 병합
  if (cloudData.characterPresets) {
    merged.characterPresets = mergeCharacterPresets(
      localCfg.characterPresets,
      cloudData.characterPresets
    );
  }

  // 3. 기타 일반 설정 필드 병합 (클라우드 데이터로 덮어쓰되, 제외 필드는 로컬 유지)
  for (const key of [...SETTINGS_SYNCABLE_KEYS, ...CHECKLIST_SYNCABLE_KEYS]) {
    if (key === 'contentsCheckerItems' || key === 'characterPresets') continue;
    if (cloudData[key] !== undefined) {
      if (TOP_LEVEL_SOUND_KEYS.has(key) && !isPortableSoundId(cloudData[key])) continue;
      if (key === 'fieldBossSettings') {
        merged.fieldBossSettings = mergeFieldBossSettings(localCfg.fieldBossSettings, cloudData.fieldBossSettings);
        continue;
      }
      if (key === 'customAlerts') {
        merged.customAlerts = mergeCustomAlerts(localCfg.customAlerts, cloudData.customAlerts);
        continue;
      }
      (merged as any)[key] = cloneValue(cloudData[key]);
    }
  }

  // 4. selectedCharacterId 무결성 보정 (존재하지 않는 캐릭터 선택 방지)
  if (merged.characterPresets && merged.characterPresets.length > 0) {
    const exists = merged.characterPresets.some(p => p.id === merged.selectedCharacterId);
    if (!exists) {
      merged.selectedCharacterId = merged.characterPresets[0].id;
    }
  }

  merged.googleSyncLastTime = cloudPayload.lastSyncedAt || Date.now();
  if (cloudPayload.updatedBy) {
    merged.googleSyncUserEmail = cloudPayload.updatedBy;
  }

  return merged;
}
