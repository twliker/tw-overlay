/**
 * 동기화 대상 데이터 추출, 병합(Merge) 및 충돌 방지 헬퍼 모듈
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { AppConfig, ContentsCheckerItem, GoogleChecklistSyncOperation, GoogleSyncPayload, CharacterPreset } from '../shared/types';
import { log } from './logger';
import { sanitizeExternalConfigPatch } from './config';

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
  if (value === undefined || value === null) return value;
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

/** 분리 전송 큐를 연결하는 동안의 내부 통합 페이로드 데이터. */
export function extractSyncData(cfg: AppConfig): Partial<AppConfig> {
  return {
    ...extractSettingsSyncData(cfg),
    ...extractChecklistSyncData(cfg),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function calculateSyncChecksum(data: Partial<AppConfig>): string {
  return crypto.createHash('sha256').update(stableJson(data), 'utf-8').digest('hex');
}

function calculateValueChecksum(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value), 'utf-8').digest('hex');
}

function buildPayload(
  kind: 'settings' | 'checklist',
  data: Partial<AppConfig>,
  userEmail: string,
  generationId?: string,
): GoogleSyncPayload {
  const lastSyncedAt = Date.now();
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    lastSyncedAt,
    updatedBy: userEmail,
    kind,
    revision: `${lastSyncedAt}-${crypto.randomUUID()}`,
    generationId,
    checksum: calculateSyncChecksum(data),
    data,
  };
}

export function buildSettingsSyncPayload(
  cfg: AppConfig,
  userEmail: string,
  generationId?: string,
): GoogleSyncPayload {
  return buildPayload('settings', extractSettingsSyncData(cfg), userEmail, generationId);
}

export function buildChecklistSyncPayload(
  cfg: AppConfig,
  installationId: string,
  generationId?: string,
  operations: GoogleChecklistSyncOperation[] = [],
): GoogleSyncPayload {
  const payload = buildPayload('checklist', extractChecklistSyncData(cfg), installationId, generationId);
  payload.operations = cloneValue(operations.slice(-1_000));
  payload.operationsChecksum = calculateValueChecksum(payload.operations);
  return payload;
}

/** 구글 드라이브 업로드용 페이로드 생성 */
export function buildSyncPayload(cfg: AppConfig, userEmail: string): GoogleSyncPayload {
  const data = extractSyncData(cfg);
  const payload = buildPayload('settings', data, userEmail);
  // 구 단일 payload API는 UI 미리보기 호환용으로만 남긴다.
  delete payload.kind;
  return payload;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Drive에서 받은 JSON을 config에 적용하기 전 형식·종류·체크섬을 검증한다. */
export function validateSyncPayload(
  value: unknown,
  expectedKind: 'settings' | 'checklist',
): value is GoogleSyncPayload {
  if (!isPlainObject(value)
    || value.schemaVersion !== 1
    || value.kind !== expectedKind
    || typeof value.appVersion !== 'string'
    || typeof value.lastSyncedAt !== 'number'
    || !Number.isFinite(value.lastSyncedAt)
    || typeof value.updatedBy !== 'string'
    || typeof value.revision !== 'string'
    || typeof value.generationId !== 'string'
    || !isPlainObject(value.data)) return false;

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (Buffer.byteLength(serialized, 'utf-8') > 5 * 1024 * 1024) return false;

  const allowedKeys = new Set<string>(expectedKind === 'settings'
    ? SETTINGS_SYNCABLE_KEYS
    : CHECKLIST_SYNCABLE_KEYS);
  if (Object.keys(value.data).some(key => !allowedKeys.has(key))) return false;
  if (!sanitizeExternalConfigPatch(value.data)) return false;
  if (expectedKind === 'checklist' && value.operations !== undefined) {
    if (!Array.isArray(value.operations) || value.operations.length > 1_000
      || value.operations.some(operation => !isPlainObject(operation)
        || typeof operation.id !== 'string' || operation.id.length > 200
        || typeof operation.deviceId !== 'string' || operation.deviceId.length > 200
        || typeof operation.createdAt !== 'number' || !Number.isFinite(operation.createdAt)
        || !Array.isArray(operation.keys) || operation.keys.length > CHECKLIST_SYNCABLE_KEYS.length
        || operation.keys.some(key => typeof key !== 'string'
          || !CHECKLIST_SYNCABLE_KEYS.includes(key as keyof AppConfig)))) return false;
    if (typeof value.operationsChecksum !== 'string'
      || value.operationsChecksum !== calculateValueChecksum(value.operations)) return false;
  }
  if (typeof value.checksum !== 'string'
    || value.checksum !== calculateSyncChecksum(value.data as Partial<AppConfig>)) return false;
  return true;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function resolveValue<T>(base: T | undefined, local: T | undefined, remote: T | undefined): T | undefined {
  const localChanged = !valuesEqual(local, base);
  const remoteChanged = !valuesEqual(remote, base);
  if (!localChanged) return cloneValue(remote);
  if (!remoteChanged) return cloneValue(local);
  // 동일 필드를 양쪽에서 바꾼 경우에는 실제 플레이 PC인 로컬을 우선한다.
  return cloneValue(local);
}

function mergeRecordThreeWay(
  base: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
  remote: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const resolved = resolveValue(base[key], local[key], remote[key]);
    if (resolved !== undefined) result[key] = resolved;
  }
  return result;
}

function mergeCompletedStatesThreeWay(
  base: ContentsCheckerItem['completedState'] = {},
  local: ContentsCheckerItem['completedState'] = {},
  remote: ContentsCheckerItem['completedState'] = {},
): ContentsCheckerItem['completedState'] {
  const result: ContentsCheckerItem['completedState'] = {};
  const characterIds = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const characterId of characterIds) {
    const baseState = base[characterId];
    const localState = local[characterId];
    const remoteState = remote[characterId];
    const resolvedWhole = resolveValue(baseState, localState, remoteState);
    if (!localState || !remoteState || valuesEqual(localState, baseState) || valuesEqual(remoteState, baseState)) {
      if (resolvedWhole) result[characterId] = resolvedWhole;
      continue;
    }
    result[characterId] = mergeRecordThreeWay(
      (baseState || {}) as Record<string, unknown>,
      localState as Record<string, unknown>,
      remoteState as Record<string, unknown>,
    ) as unknown as ContentsCheckerItem['completedState'][string];
  }
  return result;
}

function mergeItemsThreeWay(
  baseItems: ContentsCheckerItem[] = [],
  localItems: ContentsCheckerItem[] = [],
  remoteItems: ContentsCheckerItem[] = [],
): ContentsCheckerItem[] {
  const base = new Map(baseItems.map(item => [item.id, item]));
  const local = new Map(localItems.map(item => [item.id, item]));
  const remote = new Map(remoteItems.map(item => [item.id, item]));
  const result: ContentsCheckerItem[] = [];
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);

  for (const id of ids) {
    const baseItem = base.get(id);
    const localItem = local.get(id);
    const remoteItem = remote.get(id);
    const resolvedWhole = resolveValue(baseItem, localItem, remoteItem);
    if (!localItem || !remoteItem || valuesEqual(localItem, baseItem) || valuesEqual(remoteItem, baseItem)) {
      if (resolvedWhole) result.push(resolvedWhole);
      continue;
    }

    const merged = mergeRecordThreeWay(
      (baseItem || {}) as unknown as Record<string, unknown>,
      localItem as unknown as Record<string, unknown>,
      remoteItem as unknown as Record<string, unknown>,
    ) as unknown as ContentsCheckerItem;
    merged.id = id;
    merged.completedState = mergeCompletedStatesThreeWay(
      baseItem?.completedState,
      localItem.completedState,
      remoteItem.completedState,
    );
    result.push(merged);
  }
  return result;
}

function mergeIdArrayThreeWay<T extends { id: string }>(
  baseValues: T[] = [],
  localValues: T[] = [],
  remoteValues: T[] = [],
): T[] {
  const base = new Map(baseValues.map(value => [value.id, value]));
  const local = new Map(localValues.map(value => [value.id, value]));
  const remote = new Map(remoteValues.map(value => [value.id, value]));
  const result: T[] = [];
  for (const id of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
    const resolved = resolveValue(base.get(id), local.get(id), remote.get(id));
    if (resolved) result.push(resolved);
  }
  return result;
}

function pendingKey(value: AppConfig['pendingHomeworks'] extends Array<infer T> | undefined ? T : never): string {
  return `${value.id}:${value.resetCycleKey || 'unknown'}`;
}

function mergePendingThreeWay(
  baseValues: NonNullable<AppConfig['pendingHomeworks']> = [],
  localValues: NonNullable<AppConfig['pendingHomeworks']> = [],
  remoteValues: NonNullable<AppConfig['pendingHomeworks']> = [],
): NonNullable<AppConfig['pendingHomeworks']> {
  const base = new Map(baseValues.map(value => [pendingKey(value), value]));
  const local = new Map(localValues.map(value => [pendingKey(value), value]));
  const remote = new Map(remoteValues.map(value => [pendingKey(value), value]));
  const result: NonNullable<AppConfig['pendingHomeworks']> = [];
  for (const id of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
    const resolved = resolveValue(base.get(id), local.get(id), remote.get(id));
    if (resolved) result.push(resolved);
  }
  return result;
}

/**
 * 마지막 정상 동기화본(base)을 기준으로 숙제를 3방향 병합한다.
 * 한쪽만 바뀐 값은 그쪽을 사용하고, 동일 필드가 양쪽에서 바뀐 경우만 로컬을 우선한다.
 */
export function mergeChecklistThreeWay(
  baseData: Partial<AppConfig> | undefined,
  localCfg: AppConfig,
  remoteData: Partial<AppConfig>,
): Partial<AppConfig> {
  if (!baseData) {
    const bootstrapPayload: GoogleSyncPayload = {
      schemaVersion: 1,
      appVersion: app.getVersion(),
      lastSyncedAt: Date.now(),
      updatedBy: '',
      data: remoteData,
    };
    return extractChecklistSyncData(mergeSyncData(localCfg, bootstrapPayload));
  }
  return {
    contentsCheckerItems: mergeItemsThreeWay(
      baseData.contentsCheckerItems,
      localCfg.contentsCheckerItems,
      remoteData.contentsCheckerItems,
    ),
    characterPresets: mergeIdArrayThreeWay(
      baseData.characterPresets,
      localCfg.characterPresets,
      remoteData.characterPresets,
    ),
    pendingHomeworks: mergePendingThreeWay(
      baseData.pendingHomeworks,
      localCfg.pendingHomeworks,
      remoteData.pendingHomeworks,
    ),
  };
}

/** 클라우드 설정 스냅샷에 아직 업로드하지 않은 로컬 필드만 다시 얹는다. */
export function mergeSettingsSnapshot(
  localCfg: AppConfig,
  remotePayload: GoogleSyncPayload,
  localDirtyKeys: string[] = [],
): AppConfig {
  const merged = mergeSyncData(localCfg, remotePayload);
  const dirty = new Set(localDirtyKeys);
  for (const key of SETTINGS_SYNCABLE_KEYS) {
    if (dirty.has(String(key)) && localCfg[key] !== undefined) {
      (merged as any)[key] = cloneValue(localCfg[key]);
    }
  }
  return merged;
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
  // 분리 파일의 updatedBy는 개인정보가 아닌 PC 식별자다. 구 단일 payload에서만
  // 과거 UI 호환용 이메일 필드로 해석한다.
  if (cloudPayload.updatedBy && !cloudPayload.kind) {
    merged.googleSyncUserEmail = cloudPayload.updatedBy;
  }

  return merged;
}
