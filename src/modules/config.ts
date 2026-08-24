/**
 * 설정 관리 모듈 - 검증/누락 기본값 병합/원자 저장/디바운스
 */
import * as fs from 'fs';
import * as path from 'path';
import { get_CONFIG_PATH, DEFAULT_CONFIG, SAVE_DEBOUNCE_MS, AppConfig, get_RESOURCE_PATH } from './constants';
import { log } from './logger';
import type { WindowPositionKey } from '../shared/types';

const CONFIG_QUARANTINE_FILENAME = 'config.quarantine.json';
const WRITE_RETRY_DELAYS_MS = [0, 25, 75, 150];
const SAVE_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EXTERNAL_PATCH_MAX_BYTES = 2 * 1024 * 1024;

/** AppConfig의 알려진 최상위 키. DEFAULT_CONFIG에 아직 없는 optional 키도 포함한다. */
const KNOWN_CONFIG_KEYS = new Set<string>([
  'width', 'height', 'opacity', 'url', 'homeUrl', 'quickSlots',
  'galleryLastSeen', 'galleryWatched', 'galleryNotify', 'overlayVisible', 'autoLaunch',
  'autoOpenContentsChecker', 'contentsCheckerEnabled', 'autoUpdateEnabled', 'hasSeenWelcomeGuide',
  'lastNoticeVersion', 'galleryKeywords', 'hiddenMenuIds', 'visibleMenuIds',
  'fieldBossNotifyEnabled', 'fieldBossNotifyOffsets', 'fieldBossNotifyVolume', 'fieldBossSettings',
  'notifyWhenGameClosed', 'positions', 'storedPositionKeys', 'tradeServer', 'tradeKeywords',
  'tradeNotify', 'tradeLastSeen', 'gameExitReminderEnabled', 'gameExitReminderMessage',
  'contentsCheckerItems', 'characterPresets', 'selectedCharacterId', 'pendingHomeworks',
  'lastContentsResetCheck', 'shortcuts', 'customAlerts', 'customSounds', 'chatLogPath',
  'chatLogAutoDeleteDays', 'diaryKeepDays', 'lootKeywords', 'lootKeywordsMigratedV2',
  'quickSlotsMigratedV2', 'shoutKeywords', 'ethosAlertEnabled', 'abyssApostleAlertEnabled',
  'wordAlarmEnabled', 'wordAlarmKeywords', 'wordAlarmSound', 'wordAlarmVolume',
  'wordAlarmHistoryEnabled', 'showXpWidget', 'xpAutoStart', 'ignoreNegativeXp', 'xpWidgetPos',
  'showTodaySummaryHud', 'todaySummaryCollapsed', 'todaySummaryHudPos', 'huntingExpDopings',
  'huntingExpGrounds', 'huntingExpSelectedGroundId', 'huntingExpKillsPerHour',
  'huntingExpHappyHour', 'waveMonsterWarningEnabled', 'waveMonsterWarningSound',
  'waveMonsterWarningVolume', 'ethosAlertSound', 'ethosAlertVolume', 'abyssApostleStartSound',
  'abyssApostleEndSound', 'abyssApostleVolume', 'lokagosAlertEnabled', 'lokagosAlertSound',
  'lokagosAlertVolume', 'buffTimerEnabled', 'showBuffHud', 'showHudShortcuts',
  'buffTimerWarnSeconds', 'buffTimerAudioAlert', 'buffTimerVisualAlert', 'buffTimerVolume',
  'buffTimerSound', 'buffTimerBuffs', 'buffTimerCenterAlert', 'buffTimerHudPos',
  'essenceAlertEnabled', 'essenceAlertSound', 'essenceAlertVolume', 'specialMonsterAlertEnabled',
  'abandonedAlertEnabled', 'pittaHillAlertEnabled', 'questCompleteAlertEnabled',
  'abandonedAutoHideMinutes', 'abandonedEnabled', 'abandonedWidgetPos', 'scamDetectorEnabled',
  'msgerLogPath', 'scamAlertSound', 'scamGpuVariant', 'scamLlmDisabled', 'discordWebhookUrl',
  'discordAlertEnabled', 'discordKeywords', 'discordRules', 'volumeContentsChecker',
  'volumeCalculators', 'sidebarPosition', 'chatOverlayEnabled', 'chatOverlaySubEnabled',
  'chatOverlaySub2Enabled', 'chatOverlayOpacity', 'chatOverlaySubOpacity',
  'chatOverlaySub2Opacity', 'chatOverlayFontSize', 'chatOverlayClickThrough',
  'chatOverlayKeywords', 'userServer', 'etaDataUrl', 'chatOverlayWidth', 'chatOverlayHeight',
  'focusedChatWidth', 'focusedChatHeight', 'contentsCheckerWidth', 'contentsCheckerHeight',
  'followGameWindow', 'chatOverlaySelectedChannels', 'chatOverlaySubWidth',
  'chatOverlaySubHeight', 'chatOverlayTab', 'chatOverlaySubTab', 'chatOverlaySub2Width',
  'chatOverlaySub2Height', 'chatOverlaySub2Tab', 'chatOverlayShowNpcChat',
  'chatOverlayBlacklistFilters', 'chatOverlayShowXpGain', 'chatOverlayShowElsoGain',
  'chatOverlayHighlightScamNicknames', 'chatOverlayColorGeneral', 'chatOverlayColorWhisper',
  'chatOverlayColorTeam', 'chatOverlayColorClub', 'chatOverlayColorShout',
  'chatOverlayNicknameColorMode', 'chatOverlayNicknameColorGeneral',
  'chatOverlayNicknameColorWhisper', 'chatOverlayNicknameColorTeam',
  'chatOverlayNicknameColorClub', 'chatOverlayNicknameColorShout', 'focusedChatSelfNickname',
  'forgeQuestHudPos', 'questHudPos', 'showSidebarToastOnOverlay', 'setupCompleted',
  'chatOverlayCustomTabs', 'googleSyncEnabled', 'googleSyncAutoSync', 'googleSyncLastTime',
  'googleSyncUserEmail'
]);
for (const key of Object.keys(DEFAULT_CONFIG)) KNOWN_CONFIG_KEYS.add(key);
// v2 계열에서 저장되었지만 현재 UI/타입에서 제거된 값도 삭제하지 않고 향후 마이그레이션까지 보존한다.
[
  'chatOverlaySystemColorFilters', 'timerHudPos', 'focusedChatNicknames',
  'chatOverlayColorSystem', 'buffTimerBuffSettings', 'discordAlertLoot',
  'discordAlertScam', 'discordAlertWord', 'buffWatcherAutoStart', 'dangerThreshold',
  'dangerSoundEnabled', 'dangerSoundVolume', 'dangerSoundFile', 'tradeNotifyVolume',
  'macroSkillKey', 'macroTargetX', 'macroTargetY', 'ga_client_id', 'ga_session_id',
  'ga_session_number', 'ga_last_active_time',
].forEach(key => KNOWN_CONFIG_KEYS.add(key));

let _saveTimer: NodeJS.Timeout | null = null;
let _pendingConfig: AppConfig | null = null;
let _cachedConfig: AppConfig | null = null;
let _loadWarning: string | null = null;
let _lastSaveError: string | null = null;
let _saveRetryIndex = 0;
const _storedPositionKeys = new Set<WindowPositionKey>();

type ConfigChangeListener = (changedConfig: Partial<AppConfig>) => void;
const _changeListeners: ConfigChangeListener[] = [];

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!isPlainObject(value)) return null;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_OBJECT_KEYS.has(key)) continue;
    sanitized[key] = sanitizeJsonValue(child);
  }
  return sanitized;
}

function isSafeExternalJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 20_000;
  if (Array.isArray(value)) {
    return value.length <= 5_000 && value.every(child => isSafeExternalJsonValue(child, depth + 1));
  }
  if (!isPlainObject(value) || Object.keys(value).length > 2_000) return false;
  return Object.entries(value).every(([key, child]) => (
    !BLOCKED_OBJECT_KEYS.has(key)
    && key.length <= 200
    && isSafeExternalJsonValue(child, depth + 1)
  ));
}

const EXTERNAL_NUMBER_RANGES: Partial<Record<keyof AppConfig, [number, number]>> = {
  width: [100, 16_384],
  height: [100, 16_384],
  opacity: [0.2, 1],
  chatOverlayOpacity: [0.2, 1],
  chatOverlaySubOpacity: [0.2, 1],
  chatOverlaySub2Opacity: [0.2, 1],
  chatOverlayFontSize: [8, 72],
  wordAlarmVolume: [0, 100],
  fieldBossNotifyVolume: [0, 100],
  buffTimerVolume: [0, 100],
  essenceAlertVolume: [0, 100],
  ethosAlertVolume: [0, 100],
  abyssApostleVolume: [0, 100],
  lokagosAlertVolume: [0, 100],
  waveMonsterWarningVolume: [0, 100],
  volumeContentsChecker: [0, 100],
  volumeCalculators: [0, 100],
  abandonedAutoHideMinutes: [0, 1_440],
  chatLogAutoDeleteDays: [0, 3_650],
  diaryKeepDays: [1, 3_650],
  huntingExpKillsPerHour: [0, 10_000_000]
};

const OPTIONAL_BOOLEAN_KEYS = new Set([
  'autoLaunch', 'hasSeenWelcomeGuide', 'lootKeywordsMigratedV2', 'scamDetectorEnabled',
  'scamLlmDisabled', 'followGameWindow', 'setupCompleted', 'googleSyncEnabled',
  'googleSyncAutoSync',
]);
const OPTIONAL_STRING_KEYS = new Set([
  'selectedCharacterId', 'msgerLogPath', 'scamAlertSound', 'buffTimerSound',
  'googleSyncUserEmail',
]);
const OPTIONAL_ARRAY_KEYS = new Set([
  'galleryKeywords', 'hiddenMenuIds', 'visibleMenuIds', 'storedPositionKeys',
  'characterPresets', 'pendingHomeworks', 'customAlerts',
]);
const OPTIONAL_OBJECT_KEYS = new Set(['galleryWatched']);
const OPTIONAL_NUMBER_KEYS = new Set([
  'galleryLastSeen', 'tradeLastSeen', 'chatLogAutoDeleteDays', 'contentsCheckerWidth',
  'contentsCheckerHeight', 'googleSyncLastTime',
]);

/** renderer IPC에서 들어온 설정 patch를 크기·타입·범위·키 allowlist 기준으로 검증한다. */
export function sanitizeExternalConfigPatch(value: unknown): Partial<AppConfig> | null {
  if (!isPlainObject(value) || !isSafeExternalJsonValue(value)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (Buffer.byteLength(serialized, 'utf-8') > EXTERNAL_PATCH_MAX_BYTES) return null;

  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) return null;
    const defaultValue = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (defaultValue !== undefined) {
      if (Array.isArray(defaultValue) && !Array.isArray(fieldValue)) return null;
      if (isPlainObject(defaultValue) && !isPlainObject(fieldValue)) return null;
      if (!Array.isArray(defaultValue) && !isPlainObject(defaultValue) && typeof fieldValue !== typeof defaultValue) {
        return null;
      }
    }
    if (defaultValue === undefined) {
      if (OPTIONAL_BOOLEAN_KEYS.has(key) && typeof fieldValue !== 'boolean') return null;
      if (OPTIONAL_STRING_KEYS.has(key) && typeof fieldValue !== 'string') return null;
      if (OPTIONAL_ARRAY_KEYS.has(key) && !Array.isArray(fieldValue)) return null;
      if (OPTIONAL_OBJECT_KEYS.has(key) && !isPlainObject(fieldValue)) return null;
      if (OPTIONAL_NUMBER_KEYS.has(key) && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))) return null;
    }
    if (key === 'scamGpuVariant' && !['cpu', 'vulkan', 'cuda-12.4', 'cuda-13.1'].includes(String(fieldValue))) return null;
    if (key === 'quickSlots' && (!Array.isArray(fieldValue) || fieldValue.length > 100
      || fieldValue.some(slot => {
        if (!isPlainObject(slot)
          || typeof slot.label !== 'string' || slot.label.length > 100
          || typeof slot.icon !== 'string' || slot.icon.length > 200
          || typeof slot.url !== 'string' || slot.url.length > 4_096
          || typeof slot.external !== 'boolean'
          || (slot.iconType !== undefined && slot.iconType !== 'icon' && slot.iconType !== 'text')
          || (slot.textChar !== undefined && (typeof slot.textChar !== 'string' || slot.textChar.length > 10))) return true;
        try {
          const parsedUrl = new URL(slot.url);
          return parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:';
        } catch {
          return true;
        }
      }))) return null;
    if (key === 'buffTimerWarnSeconds' && (!Array.isArray(fieldValue)
      || fieldValue.length > 100
      || fieldValue.some(value => !Number.isInteger(value) || (value as number) < 0 || (value as number) > 86_400))) return null;
    if (['galleryKeywords', 'hiddenMenuIds', 'visibleMenuIds'].includes(key)
      && (!Array.isArray(fieldValue) || fieldValue.length > 2_000
        || fieldValue.some(value => typeof value !== 'string' || value.length > 500))) return null;
    const range = EXTERNAL_NUMBER_RANGES[key as keyof AppConfig];
    if (range) {
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < range[0] || fieldValue > range[1]) {
        return null;
      }
    }
    result[key] = sanitizeJsonValue(fieldValue);
  }
  return result as Partial<AppConfig>;
}

function mergeMissingDefaults(
  defaultValue: unknown,
  userValue: unknown,
  fieldPath: string,
  quarantined: Record<string, unknown>
): unknown {
  if (Array.isArray(defaultValue)) {
    if (!Array.isArray(userValue)) {
      quarantined[fieldPath] = userValue;
      return deepClone(defaultValue);
    }
    return sanitizeJsonValue(userValue);
  }

  if (isPlainObject(defaultValue)) {
    if (!isPlainObject(userValue)) {
      quarantined[fieldPath] = userValue;
      return deepClone(defaultValue);
    }

    const result: Record<string, unknown> = {};
    for (const [key, childDefault] of Object.entries(defaultValue)) {
      if (Object.prototype.hasOwnProperty.call(userValue, key)) {
        result[key] = mergeMissingDefaults(childDefault, userValue[key], `${fieldPath}.${key}`, quarantined);
      } else {
        result[key] = deepClone(childDefault);
      }
    }
    for (const [key, childValue] of Object.entries(userValue)) {
      if (BLOCKED_OBJECT_KEYS.has(key) || Object.prototype.hasOwnProperty.call(defaultValue, key)) continue;
      result[key] = sanitizeJsonValue(childValue);
    }
    return result;
  }

  if (defaultValue === null) return sanitizeJsonValue(userValue);
  if (typeof userValue !== typeof defaultValue || (typeof userValue === 'number' && !Number.isFinite(userValue))) {
    quarantined[fieldPath] = userValue;
    return defaultValue;
  }
  return userValue;
}

/** 부분 설정 저장은 객체 필드별로 병합하고 배열은 사용자가 선택한 전체 값으로 교체한다. */
function mergeConfigPatch(currentValue: unknown, patchValue: unknown): unknown {
  if (Array.isArray(patchValue)) return deepClone(patchValue);
  if (isPlainObject(currentValue) && isPlainObject(patchValue)) {
    const result: Record<string, unknown> = deepClone(currentValue);
    for (const [key, value] of Object.entries(patchValue)) {
      if (BLOCKED_OBJECT_KEYS.has(key)) continue;
      result[key] = mergeConfigPatch(result[key], value);
    }
    return result;
  }
  return deepClone(patchValue);
}

function mergeAndValidateConfig(parsed: Record<string, unknown>): {
  config: AppConfig;
  quarantined: Record<string, unknown>;
} {
  const quarantined: Record<string, unknown> = {};
  const knownUserValues: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (BLOCKED_OBJECT_KEYS.has(key) || !KNOWN_CONFIG_KEYS.has(key)) {
      quarantined[key] = value;
      continue;
    }
    knownUserValues[key] = value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG as unknown as Record<string, unknown>)) {
    if (Object.prototype.hasOwnProperty.call(knownUserValues, key)) {
      result[key] = mergeMissingDefaults(defaultValue, knownUserValues[key], key, quarantined);
    } else {
      result[key] = deepClone(defaultValue);
    }
  }
  for (const [key, value] of Object.entries(knownUserValues)) {
    if (Object.prototype.hasOwnProperty.call(result, key)) continue;
    result[key] = sanitizeJsonValue(value);
  }

  return { config: result as unknown as AppConfig, quarantined };
}

function waitSync(ms: number): void {
  if (ms <= 0) return;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, ms);
}

/** 같은 폴더의 완전한 임시 파일을 flush한 뒤 원본 경로로 원자 교체한다. */
function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, serialized, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  let lastError: unknown;
  for (const delay of WRITE_RETRY_DELAYS_MS) {
    waitSync(delay);
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function readJsonCandidate(filePath: string): { value: Record<string, unknown>; mtimeMs: number; path: string } | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!isPlainObject(parsed)) throw new Error('설정 최상위 값이 객체가 아닙니다.');
    return { value: parsed, mtimeMs: fs.statSync(filePath).mtimeMs, path: filePath };
  } catch (error) {
    log(`[CONFIG] 설정 후보 무시 (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function selectConfigCandidate(configPath: string): { value: Record<string, unknown>; sourcePath: string } | null {
  const candidates = [readJsonCandidate(configPath), readJsonCandidate(`${configPath}.tmp`)]
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) return null;
  return { value: candidates[0].value, sourcePath: candidates[0].path };
}

function writeQuarantine(configPath: string, quarantined: Record<string, unknown>): void {
  if (Object.keys(quarantined).length === 0) return;
  const quarantinePath = path.join(path.dirname(configPath), CONFIG_QUARANTINE_FILENAME);
  try {
    writeJsonAtomicSync(quarantinePath, {
      quarantinedAt: new Date().toISOString(),
      fields: sanitizeJsonValue(quarantined)
    });
    log(`[CONFIG] 미인식/손상 필드를 격리했습니다: ${quarantinePath}`);
  } catch (error) {
    log(`[CONFIG] 격리 파일 저장 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function restoreKnownQuarantineFields(configPath: string, parsed: Record<string, unknown>): boolean {
  const quarantinePath = path.join(path.dirname(configPath), CONFIG_QUARANTINE_FILENAME);
  if (!fs.existsSync(quarantinePath)) return false;
  try {
    const quarantine = JSON.parse(fs.readFileSync(quarantinePath, 'utf-8')) as unknown;
    if (!isPlainObject(quarantine) || !isPlainObject(quarantine.fields)) return false;
    let restored = false;
    for (const [key, value] of Object.entries(quarantine.fields)) {
      if (KNOWN_CONFIG_KEYS.has(key) && !Object.prototype.hasOwnProperty.call(parsed, key)) {
        parsed[key] = sanitizeJsonValue(value);
        restored = true;
      }
    }
    return restored;
  } catch (error) {
    log(`[CONFIG] 격리 설정 재검토 실패: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function addConfigChangeListener(listener: ConfigChangeListener): () => void {
  _changeListeners.push(listener);
  return () => {
    const idx = _changeListeners.indexOf(listener);
    if (idx !== -1) _changeListeners.splice(idx, 1);
  };
}

function notifyConfigChange(changedConfig: Partial<AppConfig>): void {
  for (const listener of _changeListeners) {
    try {
      listener(deepClone(changedConfig));
    } catch (err) {
      log(`[CONFIG] 리스너 호출 에러: ${err}`);
    }
  }
}

function applyVersionedMigrations(parsed: Record<string, unknown>): boolean {
  let migrated = false;

  if (typeof parsed.opacity === 'number' && parsed.opacity < 0.2) {
    parsed.opacity = 0.2;
    migrated = true;
  }
  for (const key of ['chatOverlayOpacity', 'chatOverlaySubOpacity', 'chatOverlaySub2Opacity']) {
    if (typeof parsed[key] === 'number' && (parsed[key] as number) < 0.2) {
      parsed[key] = 0.2;
      migrated = true;
    }
  }
  if (isPlainObject(parsed.questHudPos)) {
    parsed.forgeQuestHudPos = sanitizeJsonValue(parsed.questHudPos);
    delete parsed.questHudPos;
    migrated = true;
  }
  if (
    isPlainObject(parsed.todaySummaryHudPos)
    && (typeof parsed.todaySummaryHudPos.top !== 'number'
      || (parsed.todaySummaryHudPos.left === 200
        && (parsed.todaySummaryHudPos.bottom === 105 || parsed.todaySummaryHudPos.bottom === 71)))
  ) {
    parsed.todaySummaryHudPos = deepClone(DEFAULT_CONFIG.todaySummaryHudPos || { left: 0, top: 200 });
    migrated = true;
  }

  // 기존 사용자 배열은 빈 배열이어도 보존한다. 키 자체가 없을 때만 신규 기본값을 채운다.
  if (parsed.lootKeywordsMigratedV2 !== true) {
    if (!Object.prototype.hasOwnProperty.call(parsed, 'lootKeywords')) {
      try {
        const defaultJsonPath = get_RESOURCE_PATH('assets', 'data', 'contents_items_default.json');
        if (fs.existsSync(defaultJsonPath)) {
          const defaultItems = JSON.parse(fs.readFileSync(defaultJsonPath, 'utf-8')) as Array<{ name?: unknown }>;
          parsed.lootKeywords = defaultItems
            .map(item => item?.name)
            .filter((name): name is string => typeof name === 'string');
        }
      } catch (error) {
        log(`[CONFIG] 득템 키워드 마이그레이션 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    parsed.lootKeywordsMigratedV2 = true;
    migrated = true;
  }

  // 제품 변경으로 추가된 기본 퀵슬롯은 버전 센티널이 있는 1회 마이그레이션으로만 적용한다.
  if (parsed.quickSlotsMigratedV2 !== true) {
    if (Array.isArray(parsed.quickSlots)) {
      const quickSlots = deepClone(parsed.quickSlots) as Array<Record<string, unknown>>;
      const hasTwDb = quickSlots.some(slot => typeof slot?.url === 'string' && slot.url.includes('twhome-git.github.io/TWPage'));
      if (!hasTwDb) {
        quickSlots.push({
          label: 'TW DB',
          icon: 'database',
          url: 'https://twhome-git.github.io/TWPage/',
          external: true,
          iconType: 'icon'
        });
        parsed.quickSlots = quickSlots;
      }
    }
    parsed.quickSlotsMigratedV2 = true;
    migrated = true;
  }
  return migrated;
}

/** 설정 파일 로드. 반환값은 깊게 동결된 불변 스냅샷이며 변경 시에만 새 객체로 교체된다. */
export function load(): AppConfig {
  if (_cachedConfig) return _cachedConfig;

  const configPath = get_CONFIG_PATH();
  try {
    const selected = selectConfigCandidate(configPath);
    if (selected) {
      const parsed = selected.value;
      const restoredQuarantine = restoreKnownQuarantineFields(configPath, parsed);
      const migrated = applyVersionedMigrations(parsed) || restoredQuarantine;
      const { config, quarantined } = mergeAndValidateConfig(parsed);

      _storedPositionKeys.clear();
      const storedPositionKeys = Array.isArray(config.storedPositionKeys)
        ? config.storedPositionKeys
        : Object.entries(config.positions || {})
          .filter(([key, position]) => {
            const defaultPosition = DEFAULT_CONFIG.positions?.[key as WindowPositionKey];
            return !defaultPosition
              || position?.offsetX !== defaultPosition.offsetX
              || position?.offsetY !== defaultPosition.offsetY;
          })
          .map(([key]) => key as WindowPositionKey);
      storedPositionKeys.forEach(key => _storedPositionKeys.add(key));
      config.storedPositionKeys = [..._storedPositionKeys];
      _cachedConfig = deepFreeze(deepClone(config));

      if (selected.sourcePath !== configPath || migrated || Object.keys(quarantined).length > 0) {
        try {
          writeJsonAtomicSync(configPath, _cachedConfig);
          if (selected.sourcePath !== configPath) log('[CONFIG] 중단된 임시 설정 파일을 복구했습니다.');
          if (migrated) log('[CONFIG] 설정 마이그레이션 적용');
        } catch (error) {
          _pendingConfig = deepClone(_cachedConfig);
          _lastSaveError = error instanceof Error ? error.message : String(error);
          log(`[CONFIG] 로드 후 정규화 저장 실패: ${_lastSaveError}`);
        }
      }
      writeQuarantine(configPath, quarantined);
      if (Object.keys(quarantined).length > 0) {
        _loadWarning = `일부 미인식 또는 손상된 설정을 격리하고 안전한 값으로 복구했습니다.\n${path.join(path.dirname(configPath), CONFIG_QUARANTINE_FILENAME)}`;
      }
      return _cachedConfig;
    }

    if (fs.existsSync(configPath) || fs.existsSync(`${configPath}.tmp`)) {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-');
      for (const candidatePath of [configPath, `${configPath}.tmp`]) {
        if (!fs.existsSync(candidatePath)) continue;
        const backupPath = `${candidatePath}.corrupt-${suffix}`;
        fs.copyFileSync(candidatePath, backupPath);
        log(`[CONFIG] 손상된 설정 원본 보존: ${backupPath}`);
      }
      _loadWarning = '유효한 설정 파일을 찾지 못해 기본 설정으로 시작했습니다. 손상된 원본은 별도 파일로 보존했습니다.';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    _loadWarning = '설정 파일을 읽지 못해 기본 설정으로 시작했습니다.';
    log(`[CONFIG] 설정 로드 실패: ${message}`);
  }

  _cachedConfig = deepFreeze(deepClone(DEFAULT_CONFIG));
  return _cachedConfig;
}

function schedulePendingRetry(): void {
  if (_saveTimer || !_pendingConfig || _saveRetryIndex >= SAVE_RETRY_DELAYS_MS.length) return;
  const delay = SAVE_RETRY_DELAYS_MS[_saveRetryIndex++];
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushPending();
  }, delay);
}

/** 현재 pending을 원자 저장한다. 실패 시 pending을 유지한다. */
export function flushPending(): boolean {
  if (!_pendingConfig) return true;
  try {
    writeJsonAtomicSync(get_CONFIG_PATH(), _pendingConfig);
    _cachedConfig = deepFreeze(deepClone(_pendingConfig));
    _pendingConfig = null;
    _lastSaveError = null;
    _saveRetryIndex = 0;
    return true;
  } catch (error) {
    _lastSaveError = error instanceof Error ? error.message : String(error);
    log(`[CONFIG] 설정 원자 저장 실패, pending 유지: ${_lastSaveError}`);
    schedulePendingRetry();
    return false;
  }
}

/** 디바운스 저장 - move/resize 등 빈번한 이벤트에 사용 */
export function save(newConfig: Partial<AppConfig>): void {
  try {
    const changed = deepClone(newConfig);
    if (!_pendingConfig) _pendingConfig = load();
    _pendingConfig = mergeConfigPatch(_pendingConfig, changed) as AppConfig;
    _pendingConfig.storedPositionKeys = [..._storedPositionKeys];
    _cachedConfig = deepFreeze(deepClone(_pendingConfig));
    _saveRetryIndex = 0;
    notifyConfigChange(changed);
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      flushPending();
    }, SAVE_DEBOUNCE_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    _lastSaveError = message;
    log(`[CONFIG] 저장 준비 실패: ${message}`);
  }
}

/** 즉시 저장 - 앱 종료·복원 등 결과 확인이 필요한 경로에서 사용 */
export function saveImmediate(newConfig: Partial<AppConfig> = {}): boolean {
  try {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = null;
    const current = _pendingConfig || load();
    const changed = deepClone(newConfig);
    _pendingConfig = mergeConfigPatch(current, changed) as AppConfig;
    _pendingConfig.storedPositionKeys = [..._storedPositionKeys];
    _cachedConfig = deepFreeze(deepClone(_pendingConfig));
    notifyConfigChange(changed);
    return flushPending();
  } catch (error) {
    _lastSaveError = error instanceof Error ? error.message : String(error);
    log(`[CONFIG] 즉시 저장 실패, pending 유지: ${_lastSaveError}`);
    return false;
  }
}

export function hasPending(): boolean {
  return _pendingConfig !== null;
}

export function getLastSaveError(): string | null {
  return _lastSaveError;
}

export function hasStoredPosition(key: WindowPositionKey): boolean {
  return _storedPositionKeys.has(key);
}

export function markStoredPosition(key: WindowPositionKey): void {
  _storedPositionKeys.add(key);
}

export function consumeLoadWarning(): string | null {
  const warning = _loadWarning;
  _loadWarning = null;
  return warning;
}
