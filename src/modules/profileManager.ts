/**
 * 기능 계약 — 다중 프로필(Multi-Profile) 관리 모듈 (File-per-Profile Architecture)
 *
 * - 각 프로필의 숙제 체크리스트(completedState)와 UI/알림/스코프 설정을 profiles/data/{profileId}.json 파일로 물리 격리합니다.
 * - profiles/manifest.json은 활성 프로필 ID와 프로필 목록 메타데이터만 경량 관리합니다.
 * - 프로필 간 데이터 오염(본계/부계 상태 복제)을 원천 방지하며, 각 프로필은 오직 자신의 profileId 키만 소유합니다.
 * - 자정 및 주간 리셋 시 활성 프로필뿐만 아니라 모든 비활성 프로필 파일도 전수 리셋(resetAllProfilesExpiredHomeworks)합니다.
 * - 최초 실행 시 기존 profiles.json 단일 파일을 안전하게 manifest.json과 data/{profileId}.json들로 1회성 자동 마이그레이션합니다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import {
  AppConfig,
  ContentsCheckerItem,
  ProfileDataFile,
  ProfileManifest,
  ProfileStoreData,
  UserProfileData,
  UserProfileMeta,
  UserProfileSummary
} from '../shared/types';
import { PROFILE_SCOPED_CONFIG_KEYS } from '../shared/profileScopedKeys';
import { resetExpiredHomeworkItems } from '../shared/homeworkReset';
import * as config from './config';
import { log } from './logger';
import { broadcastToAllWindows } from './windowMessaging';
import { DEFAULT_CHARACTER_PRESETS, CharacterPreset, resolveProfileAvatarUrl } from '../shared/characterPresets';

export { DEFAULT_CHARACTER_PRESETS, CharacterPreset, resolveProfileAvatarUrl };

let _manifest: ProfileManifest | null = null;
const _profileDataCache = new Map<string, ProfileDataFile>();
let _isSwitchingProfile = false;

function getProfilesDir(): string {
  const dir = path.join(app.getPath('userData'), 'profiles');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getAvatarsDir(): string {
  const dir = path.join(getProfilesDir(), 'avatars');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getManifestFilePath(): string {
  return path.join(getProfilesDir(), 'manifest.json');
}

export function getProfileDataDir(): string {
  const dir = path.join(getProfilesDir(), 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getProfileDataFilePath(profileId: string): string {
  return path.join(getProfileDataDir(), `${profileId}.json`);
}

function getLegacyStoreFilePath(): string {
  return path.join(getProfilesDir(), 'profiles.json');
}

/** 원자적 JSON 쓰기 (임시 파일 생성 후 rename) */
function atomicWriteJson(filePath: string, data: unknown): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    log(`[ProfileManager] 파일 쓰기 실패 (${filePath}): ${error}`);
    return false;
  }
}

/** 프로필 스코프 설정만 추출 */
export function extractProfileScopedSettings(source: Partial<AppConfig>): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};
  for (const key of PROFILE_SCOPED_CONFIG_KEYS) {
    if (key in source && (source as any)[key] !== undefined) {
      (result as any)[key] = structuredClone((source as any)[key]);
    }
  }
  return result;
}

/**
 * 프로필 항목의 completedState를 해당 profileId 키로만 안전하게 격리 정규화합니다.
 * 타 프로필의 완료 상태(values[0])를 도용/복제하지 않고, 해당 profileId의 상태만 보존합니다.
 */
export function normalizeContentsCheckerItemsForProfile(items: ContentsCheckerItem[], profileId: string): ContentsCheckerItem[] {
  return items.map(item => {
    const existing = item.completedState?.[profileId];
    if (existing) {
      return {
        ...item,
        completedState: { [profileId]: structuredClone(existing) }
      };
    }
    return {
      ...item,
      completedState: {
        [profileId]: { isCompleted: false, currentCount: 0 }
      }
    };
  });
}

/** 프로필 요약(일일/주간 숙제 진행률) 계산 */
export function calculateProfileSummary(profile: UserProfileData): UserProfileSummary {
  const items = profile.contentsCheckerItems || [];
  let dailyCompleted = 0;
  let dailyTotal = 0;
  let weeklyCompleted = 0;
  let weeklyTotal = 0;

  for (const item of items) {
    if (item.isVisible === false) continue;
    const ruleType = item.resetRule?.type || 'daily';
    const state = item.completedState?.[profile.meta.id];
    const max = item.maxCount || 1;
    const current = state?.currentCount ?? (state?.isCompleted ? max : 0);
    const isDone = current >= max;

    if (ruleType === 'daily') {
      dailyTotal++;
      if (isDone) dailyCompleted++;
    } else {
      weeklyTotal++;
      if (isDone) weeklyCompleted++;
    }
  }

  return {
    meta: { ...profile.meta },
    dailyCompleted,
    dailyTotal,
    weeklyCompleted,
    weeklyTotal
  };
}

/** 프로필 데이터 파일 로드 (캐시 우선, 없으면 디스크에서 로드) */
function loadProfileDataFile(profileId: string): ProfileDataFile {
  const cached = _profileDataCache.get(profileId);
  if (cached) return cached;

  const filePath = getProfileDataFilePath(profileId);
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as ProfileDataFile;
      if (parsed && parsed.id === profileId) {
        _profileDataCache.set(profileId, parsed);
        return parsed;
      }
    } catch (e) {
      log(`[ProfileManager] 프로필 데이터 파일(${profileId}) 읽기 실패: ${e}`);
    }
  }

  // 파일이 없거나 손상된 경우 기본 구조 생성
  const defaultData: ProfileDataFile = {
    version: 2,
    id: profileId,
    contentsCheckerItems: normalizeContentsCheckerItemsForProfile(config.load().contentsCheckerItems || [], profileId),
    settings: extractProfileScopedSettings(config.load()),
    updatedAt: Date.now()
  };
  saveProfileDataFile(defaultData);
  return defaultData;
}

/** 프로필 데이터 파일 저장 */
function saveProfileDataFile(data: ProfileDataFile): boolean {
  _profileDataCache.set(data.id, data);
  return atomicWriteJson(getProfileDataFilePath(data.id), data);
}

/** 매니페스트 파일 저장 */
function saveManifest(): boolean {
  if (!_manifest) return false;
  return atomicWriteJson(getManifestFilePath(), _manifest);
}

/** 매니페스트 및 데이터 파일 로드 & 1회성 마이그레이션 보장 */
function ensureManifestAndDataFiles(): ProfileManifest {
  if (_manifest) return _manifest;

  const manifestPath = getManifestFilePath();
  const legacyStorePath = getLegacyStoreFilePath();

  // 1. 이미 manifest.json이 존재하는 경우
  if (fs.existsSync(manifestPath)) {
    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(content) as ProfileManifest;
      if (parsed && Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
        _manifest = parsed;
        log(`[ProfileManager] 프로필 매니페스트 로드 성공 (${_manifest.profiles.length}개 프로필)`);
        return _manifest;
      }
    } catch (e) {
      log(`[ProfileManager] manifest.json 파싱 실패, 복구 시도: ${e}`);
    }
  }

  // 2. manifest.json이 없고 기존 profiles.json(레거시 단일 파일)이 존재하는 경우
  if (fs.existsSync(legacyStorePath)) {
    try {
      const content = fs.readFileSync(legacyStorePath, 'utf-8');
      const legacyStore = JSON.parse(content) as ProfileStoreData;
      if (legacyStore && Array.isArray(legacyStore.profiles) && legacyStore.profiles.length > 0) {
        log(`[ProfileManager] 기존 profiles.json에서 개별 파일 구조로 마이그레이션 시작 (${legacyStore.profiles.length}개)`);

        const manifestProfiles: UserProfileMeta[] = [];
        const now = Date.now();

        for (const p of legacyStore.profiles) {
          manifestProfiles.push(structuredClone(p.meta));

          // 각 프로필별 숙제 아이템 정제 (타 프로필 키 오염 제거, 자기 ID 키만 단독 보존)
          const cleanedItems = (p.contentsCheckerItems || []).map(item => {
            const myState = item.completedState?.[p.meta.id];
            return {
              ...item,
              completedState: myState
                ? { [p.meta.id]: structuredClone(myState) }
                : { [p.meta.id]: { isCompleted: false, currentCount: 0 } }
            };
          });

          const profileData: ProfileDataFile = {
            version: 2,
            id: p.meta.id,
            contentsCheckerItems: cleanedItems,
            settings: structuredClone(p.settings || {}),
            updatedAt: p.meta.updatedAt || now
          };

          saveProfileDataFile(profileData);
        }

        _manifest = {
          version: 2,
          activeProfileId: legacyStore.activeProfileId || manifestProfiles[0].id,
          profiles: manifestProfiles,
          showOnGameLaunch: legacyStore.showOnGameLaunch ?? true,
          showOnAppLaunch: legacyStore.showOnAppLaunch ?? true,
          legacyMigrationTargetProfileId: legacyStore.legacyMigrationTargetProfileId || manifestProfiles[0].id
        };

        saveManifest();

        // profiles.json을 profiles.json.bak으로 안전하게 백업
        try {
          fs.renameSync(legacyStorePath, `${legacyStorePath}.bak`);
          log(`[ProfileManager] 기존 profiles.json을 profiles.json.bak으로 백업 완료`);
        } catch (renameErr) {
          log(`[ProfileManager] profiles.json 백업 중 경고: ${renameErr}`);
        }

        return _manifest;
      }
    } catch (e) {
      log(`[ProfileManager] 기존 profiles.json 변환 실패, config에서 복구 시도: ${e}`);
    }
  }

  // 3. 둘 다 없는 경우: config.json에서 초기 생성
  _manifest = migrateFromLegacyConfig();
  saveManifest();
  return _manifest;
}

/** 기존 config 데이터에서 초기 프로필 생성 */
function migrateFromLegacyConfig(): ProfileManifest {
  const currentConfig = config.load();
  const legacyPresets = currentConfig.characterPresets || [];
  const legacyItems = currentConfig.contentsCheckerItems || [];
  const scopedSettings = extractProfileScopedSettings(currentConfig);

  const manifestProfiles: UserProfileMeta[] = [];
  const now = Date.now();

  if (legacyPresets.length > 0) {
    for (let i = 0; i < legacyPresets.length; i++) {
      const preset = legacyPresets[i];
      const profileId = `profile-${preset.id || (i + 1)}`;

      let matchedAvatar = 'preset:boris';
      for (const char of DEFAULT_CHARACTER_PRESETS) {
        if (preset.name.includes(char.name)) {
          matchedAvatar = `preset:${char.id}`;
          break;
        }
      }

      const meta: UserProfileMeta = {
        id: profileId,
        name: preset.name || `캐릭터 ${i + 1}`,
        avatarUrl: matchedAvatar,
        createdAt: now,
        updatedAt: now,
        lastPlayedAt: i === 0 ? now : undefined
      };
      manifestProfiles.push(meta);

      const cleanedItems: ContentsCheckerItem[] = structuredClone(legacyItems).map(item => {
        const charState = item.completedState?.[preset.id]
          || (i === 0 ? item.completedState?.['char-main'] || item.completedState?.['char-1'] : undefined);
        return {
          ...item,
          completedState: charState ? { [profileId]: charState } : { [profileId]: { isCompleted: false, currentCount: 0 } }
        };
      });

      const profileData: ProfileDataFile = {
        version: 2,
        id: profileId,
        contentsCheckerItems: cleanedItems,
        settings: structuredClone(scopedSettings),
        updatedAt: now
      };

      saveProfileDataFile(profileData);
    }
  } else {
    const defaultProfileId = 'profile-default';
    const meta: UserProfileMeta = {
      id: defaultProfileId,
      name: '기본 프로필',
      avatarUrl: 'preset:boris',
      createdAt: now,
      updatedAt: now,
      lastPlayedAt: now
    };
    manifestProfiles.push(meta);

    const profileData: ProfileDataFile = {
      version: 2,
      id: defaultProfileId,
      contentsCheckerItems: normalizeContentsCheckerItemsForProfile(legacyItems, defaultProfileId),
      settings: structuredClone(scopedSettings),
      updatedAt: now
    };

    saveProfileDataFile(profileData);
  }

  const legacyTargetId = manifestProfiles[0].id;
  const manifest: ProfileManifest = {
    version: 2,
    activeProfileId: legacyTargetId,
    profiles: manifestProfiles,
    showOnGameLaunch: true,
    showOnAppLaunch: true,
    legacyMigrationTargetProfileId: legacyTargetId
  };

  log(`[ProfileManager] config에서 ${manifestProfiles.length}개 프로필 독립 파일 생성 완료`);
  return manifest;
}

/** config 변경 리스너 등록: 활성 프로필에 실시간 동기화 */
let _configListenerSetup = false;
function setupConfigChangeListener(): void {
  if (_configListenerSetup) return;
  _configListenerSetup = true;

  config.addConfigChangeListener((changedConfig) => {
    if (_isSwitchingProfile || !_manifest) return;
    const activeId = _manifest.activeProfileId;
    if (!activeId) return;

    const profileData = loadProfileDataFile(activeId);
    let hasChange = false;

    for (const key of PROFILE_SCOPED_CONFIG_KEYS) {
      if (key in changedConfig && (changedConfig as any)[key] !== undefined) {
        (profileData.settings as any)[key] = structuredClone((changedConfig as any)[key]);
        hasChange = true;
      }
    }

    if ('contentsCheckerItems' in changedConfig && Array.isArray(changedConfig.contentsCheckerItems)) {
      profileData.contentsCheckerItems = structuredClone(changedConfig.contentsCheckerItems);
      hasChange = true;
    }

    if (hasChange) {
      profileData.updatedAt = Date.now();
      saveProfileDataFile(profileData);

      const targetMeta = _manifest.profiles.find(p => p.id === activeId);
      if (targetMeta) {
        targetMeta.updatedAt = profileData.updatedAt;
        saveManifest();
      }
    }
  });
}

/** 초기화 진입점 */
export function initProfileStore(): ProfileStoreData {
  const manifest = ensureManifestAndDataFiles();
  setupConfigChangeListener();

  // 기존 호환성을 위해 ProfileStoreData 인터페이스 규격으로 조합하여 반환
  return getStoreDataSnapshot();
}

/** 현재 매니페스트 및 활성 상태를 결합한 ProfileStoreData 스냅샷 반환 */
function getStoreDataSnapshot(): ProfileStoreData {
  const manifest = ensureManifestAndDataFiles();
  const allProfiles = getAllProfiles();
  return {
    version: 1,
    activeProfileId: manifest.activeProfileId,
    profiles: allProfiles,
    showOnGameLaunch: manifest.showOnGameLaunch,
    showOnAppLaunch: manifest.showOnAppLaunch,
    legacyMigrationTargetProfileId: manifest.legacyMigrationTargetProfileId
  };
}

/** 전체 프로필 데이터 목록 반환 */
export function getAllProfiles(): UserProfileData[] {
  const manifest = ensureManifestAndDataFiles();
  const currentConfig = config.load();

  return manifest.profiles.map(meta => {
    const data = loadProfileDataFile(meta.id);
    let items = data.contentsCheckerItems || [];

    // 현재 활성화된 프로필인 경우 메모리/config의 최신 내용 반영
    if (meta.id === manifest.activeProfileId && currentConfig.contentsCheckerItems && currentConfig.contentsCheckerItems.length > 0) {
      items = structuredClone(currentConfig.contentsCheckerItems);
    }

    return {
      meta: { ...meta },
      contentsCheckerItems: items,
      settings: structuredClone(data.settings)
    };
  });
}

/** ID로 프로필 조회 */
export function getProfileById(profileId: string): UserProfileData | undefined {
  const manifest = ensureManifestAndDataFiles();
  const meta = manifest.profiles.find(p => p.id === profileId);
  if (!meta) return undefined;

  const data = loadProfileDataFile(profileId);
  let items = data.contentsCheckerItems || [];
  if (profileId === manifest.activeProfileId) {
    const currentConfig = config.load();
    if (currentConfig.contentsCheckerItems && currentConfig.contentsCheckerItems.length > 0) {
      items = structuredClone(currentConfig.contentsCheckerItems);
    }
  }

  return {
    meta: { ...meta },
    contentsCheckerItems: items,
    settings: structuredClone(data.settings)
  };
}

/** 특정 프로필의 숙제 체크리스트 갱신 및 파일 저장 */
export function updateProfileContentsItems(profileId: string, items: ContentsCheckerItem[]): boolean {
  const manifest = ensureManifestAndDataFiles();
  const targetMeta = manifest.profiles.find(p => p.id === profileId);
  if (!targetMeta) return false;

  const normalized = normalizeContentsCheckerItemsForProfile(items, profileId);
  const data = loadProfileDataFile(profileId);
  data.contentsCheckerItems = structuredClone(normalized);
  data.updatedAt = Date.now();
  targetMeta.updatedAt = data.updatedAt;

  saveProfileDataFile(data);
  saveManifest();

  if (manifest.activeProfileId === profileId) {
    config.saveImmediate({ contentsCheckerItems: data.contentsCheckerItems });
  }

  const profileObj: UserProfileData = {
    meta: targetMeta,
    contentsCheckerItems: data.contentsCheckerItems,
    settings: data.settings
  };

  broadcastToAllWindows('profile-changed', {
    profileId,
    meta: targetMeta,
    summary: calculateProfileSummary(profileObj)
  });
  broadcastToAllWindows('contents-items-updated');
  return true;
}

/** 전체 프로필 요약 목록 반환 */
export function getAllProfileSummaries(): UserProfileSummary[] {
  return getAllProfiles().map(calculateProfileSummary);
}

/** 현재 활성화된 프로필 반환 */
export function getActiveProfile(): UserProfileData {
  const manifest = ensureManifestAndDataFiles();
  const found = getProfileById(manifest.activeProfileId);
  if (found) return found;

  if (manifest.profiles.length > 0) {
    manifest.activeProfileId = manifest.profiles[0].id;
    saveManifest();
    return getProfileById(manifest.activeProfileId)!;
  }

  return getAllProfiles()[0];
}

/** 활성 프로필 ID */
export function getActiveProfileId(): string {
  const manifest = ensureManifestAndDataFiles();
  return manifest.activeProfileId;
}

/**
 * 모든 프로필의 만료된 숙제를 일괄 리셋 검사합니다.
 * 활성 프로필뿐만 아니라 비활성 프로필 파일(data/*.json) 전체를 전수 리셋합니다.
 * @returns 리셋이 적용된 총 건수
 */
export function resetAllProfilesExpiredHomeworks(nowTs: number = Date.now()): number {
  const manifest = ensureManifestAndDataFiles();
  let totalResetCount = 0;

  for (const meta of manifest.profiles) {
    const profileId = meta.id;
    const data = loadProfileDataFile(profileId);
    const resetResult = resetExpiredHomeworkItems(data.contentsCheckerItems, nowTs);

    if (resetResult.resetEntries.length > 0) {
      data.contentsCheckerItems = resetResult.items;
      data.updatedAt = nowTs;
      saveProfileDataFile(data);
      totalResetCount += resetResult.resetEntries.length;

      log(`[ProfileManager] 프로필 '${meta.name}' (${profileId}) 만료 숙제 ${resetResult.resetEntries.length}건 리셋 완료`);

      // 만약 현재 활성 프로필인 경우 config의 contentsCheckerItems도 동기화
      if (profileId === manifest.activeProfileId) {
        config.saveImmediate({ contentsCheckerItems: resetResult.items });
      }
    }
  }

  return totalResetCount;
}

/** 활성 프로필 전환 */
export async function switchProfile(targetProfileId: string): Promise<boolean> {
  const manifest = ensureManifestAndDataFiles();
  const targetMeta = manifest.profiles.find(p => p.id === targetProfileId);
  if (!targetMeta) {
    log(`[ProfileManager] 전환 실패: 존재하지 않는 프로필 ID (${targetProfileId})`);
    return false;
  }

  if (manifest.activeProfileId === targetProfileId) {
    log(`[ProfileManager] 이미 활성화된 프로필: ${targetProfileId}`);
    return true;
  }

  log(`[ProfileManager] 프로필 전환 시작: ${manifest.activeProfileId} -> ${targetProfileId} (${targetMeta.name})`);
  _isSwitchingProfile = true;

  try {
    // 1. 현재 활성 프로필의 상태를 해당 프로필 파일에 즉시 영구 저장
    const currentActiveId = manifest.activeProfileId;
    if (currentActiveId) {
      const currentConfig = config.load();
      const currentData = loadProfileDataFile(currentActiveId);
      currentData.settings = extractProfileScopedSettings(currentConfig);
      if (currentConfig.contentsCheckerItems) {
        currentData.contentsCheckerItems = structuredClone(currentConfig.contentsCheckerItems);
      }
      currentData.updatedAt = Date.now();
      saveProfileDataFile(currentData);

      const currentMeta = manifest.profiles.find(p => p.id === currentActiveId);
      if (currentMeta) {
        currentMeta.updatedAt = currentData.updatedAt;
      }
    }

    // 2. 대상 프로필 데이터 로드 및 만료된 숙제 사전 리셋 검사
    const targetData = loadProfileDataFile(targetProfileId);
    const resetResult = resetExpiredHomeworkItems(targetData.contentsCheckerItems, Date.now());
    let itemsToApply = resetResult.items;
    itemsToApply = normalizeContentsCheckerItemsForProfile(itemsToApply, targetProfileId);
    targetData.contentsCheckerItems = itemsToApply;
    targetData.updatedAt = Date.now();
    saveProfileDataFile(targetData);

    // 3. 매니페스트 활성 프로필 갱신
    manifest.activeProfileId = targetProfileId;
    targetMeta.lastPlayedAt = Date.now();
    targetMeta.updatedAt = Date.now();
    saveManifest();

    // 4. config에 대상 프로필 설정 및 숙제 마운트
    const patchToApply: Partial<AppConfig> = {
      ...targetData.settings,
      activeProfileId: targetProfileId,
      selectedCharacterId: targetProfileId,
      characterPresets: [{ id: targetProfileId, name: targetMeta.name }],
      contentsCheckerItems: structuredClone(itemsToApply)
    };

    config.saveConfirmed(patchToApply);

    const targetProfileObj: UserProfileData = {
      meta: targetMeta,
      contentsCheckerItems: itemsToApply,
      settings: targetData.settings
    };

    // 5. 모든 창에 프로필 전환 브로드캐스트
    broadcastToAllWindows('profile-changed', {
      profileId: targetProfileId,
      meta: targetMeta,
      summary: calculateProfileSummary(targetProfileObj)
    });
    broadcastToAllWindows('contents-items-updated');
    broadcastToAllWindows('config-data', config.load());

    log(`[ProfileManager] 프로필 전환 완료: ${targetMeta.name}`);
    return true;
  } catch (error) {
    log(`[ProfileManager] 프로필 전환 중 오류: ${error}`);
    return false;
  } finally {
    _isSwitchingProfile = false;
  }
}

/** 새 프로필 생성 (옵션: 기존 프로필 복제) */
export function createProfile(options: {
  name: string;
  avatarUrl?: string;
  copyFromProfileId?: string;
}): UserProfileData {
  const manifest = ensureManifestAndDataFiles();
  const now = Date.now();
  const profileId = `profile-${randomUUID().slice(0, 8)}`;

  let initialSettings: Partial<AppConfig> = {};
  let initialItems: ContentsCheckerItem[] = [];

  if (options.copyFromProfileId) {
    const sourceData = loadProfileDataFile(options.copyFromProfileId);
    initialSettings = structuredClone(sourceData.settings);
    // 복제 시 기존 완료 상태는 0으로 초기화하여 새 프로필에 승계
    initialItems = normalizeContentsCheckerItemsForProfile(sourceData.contentsCheckerItems || [], profileId);
  } else {
    initialSettings = extractProfileScopedSettings(config.load());
    initialItems = normalizeContentsCheckerItemsForProfile(config.load().contentsCheckerItems || [], profileId);
  }

  const meta: UserProfileMeta = {
    id: profileId,
    name: options.name.trim() || '새 프로필',
    avatarUrl: options.avatarUrl || 'preset:boris',
    createdAt: now,
    updatedAt: now,
    lastPlayedAt: undefined
  };

  const data: ProfileDataFile = {
    version: 2,
    id: profileId,
    contentsCheckerItems: initialItems,
    settings: initialSettings,
    updatedAt: now
  };

  manifest.profiles.push(meta);
  saveManifest();
  saveProfileDataFile(data);

  log(`[ProfileManager] 새 프로필 생성됨: ${meta.name} (${profileId})`);
  return {
    meta,
    contentsCheckerItems: initialItems,
    settings: initialSettings
  };
}

/** 원클릭 프로필 복제 (Duplicate) */
export function duplicateProfile(sourceProfileId: string, customName?: string): UserProfileData | null {
  const manifest = ensureManifestAndDataFiles();
  const sourceMeta = manifest.profiles.find(p => p.id === sourceProfileId);
  if (!sourceMeta) return null;

  const newName = customName || `${sourceMeta.name}의 사본`;
  return createProfile({
    name: newName,
    avatarUrl: sourceMeta.avatarUrl,
    copyFromProfileId: sourceProfileId
  });
}

/** 프로필 수정 */
export function updateProfile(id: string, updates: { name?: string; avatarUrl?: string }): UserProfileData | null {
  const manifest = ensureManifestAndDataFiles();
  const targetMeta = manifest.profiles.find(p => p.id === id);
  if (!targetMeta) return null;

  if (updates.name !== undefined && updates.name.trim().length > 0) {
    targetMeta.name = updates.name.trim();
  }
  if (updates.avatarUrl !== undefined) {
    targetMeta.avatarUrl = updates.avatarUrl;
  }
  targetMeta.updatedAt = Date.now();
  saveManifest();

  const data = loadProfileDataFile(id);

  if (manifest.activeProfileId === id) {
    if (updates.name !== undefined) {
      config.saveConfirmed({
        characterPresets: [{ id, name: targetMeta.name }]
      });
      broadcastToAllWindows('config-data', config.load());
    }
    broadcastToAllWindows('profile-changed', {
      profileId: id,
      meta: targetMeta,
      summary: calculateProfileSummary({
        meta: targetMeta,
        contentsCheckerItems: data.contentsCheckerItems,
        settings: data.settings
      })
    });
  }

  return {
    meta: targetMeta,
    contentsCheckerItems: data.contentsCheckerItems,
    settings: data.settings
  };
}

/** 프로필 삭제 (최소 1개는 유지) */
export async function deleteProfile(id: string): Promise<boolean> {
  const manifest = ensureManifestAndDataFiles();
  if (manifest.profiles.length <= 1) {
    log(`[ProfileManager] 삭제 실패: 최소 1개의 프로필은 유지되어야 합니다.`);
    return false;
  }

  const index = manifest.profiles.findIndex(p => p.id === id);
  if (index === -1) return false;

  const wasActive = (manifest.activeProfileId === id);
  if (wasActive) {
    const nextProfile = manifest.profiles.find(p => p.id !== id);
    if (nextProfile) {
      await switchProfile(nextProfile.id);
    }
  }

  const removeIndex = manifest.profiles.findIndex(p => p.id === id);
  if (removeIndex !== -1) {
    manifest.profiles.splice(removeIndex, 1);
  }
  saveManifest();

  // 데이터 파일 및 캐시 삭제
  _profileDataCache.delete(id);
  const dataPath = getProfileDataFilePath(id);
  if (fs.existsSync(dataPath)) {
    try {
      fs.unlinkSync(dataPath);
    } catch (e) {
      log(`[ProfileManager] 데이터 파일 삭제 중 경고 (${dataPath}): ${e}`);
    }
  }

  if (!wasActive) {
    const active = getActiveProfile();
    broadcastToAllWindows('profile-changed', {
      profileId: manifest.activeProfileId,
      meta: active.meta,
      summary: calculateProfileSummary(active)
    });
  }

  log(`[ProfileManager] 프로필 삭제됨: ${id}`);
  return true;
}

/** 사용자가 업로드한 아바타 이미지 저장 (base64 Data URL) */
export function saveUploadedAvatar(fileName: string, buffer: Buffer): string {
  const ext = path.extname(fileName).toLowerCase() || '.png';
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

/** 선택창 노출 옵션 조회/설정 */
export function getSelectorDisplayOptions(): { showOnGameLaunch: boolean; showOnAppLaunch: boolean } {
  const manifest = ensureManifestAndDataFiles();
  return {
    showOnGameLaunch: manifest.showOnGameLaunch ?? true,
    showOnAppLaunch: manifest.showOnAppLaunch ?? true
  };
}

/** 시작 시(앱 실행 or 게임 시작) 프로필 선택창을 자동으로 띄워야 하는지 판별 */
export function shouldShowSelectorAutomatically(context: 'app' | 'game'): boolean {
  const manifest = ensureManifestAndDataFiles();
  if (!manifest.profiles || manifest.profiles.length <= 1) {
    return false;
  }
  if (context === 'game') {
    return manifest.showOnGameLaunch ?? true;
  }
  if (context === 'app') {
    return manifest.showOnAppLaunch ?? true;
  }
  return false;
}

export function setSelectorDisplayOptions(options: { showOnGameLaunch?: boolean; showOnAppLaunch?: boolean }): void {
  const manifest = ensureManifestAndDataFiles();
  if (options.showOnGameLaunch !== undefined) manifest.showOnGameLaunch = options.showOnGameLaunch;
  if (options.showOnAppLaunch !== undefined) manifest.showOnAppLaunch = options.showOnAppLaunch;
  saveManifest();
}

/** 클라우드 동기화용 프로필 페이로드 내보내기 */
export function exportProfilePayload(): ProfileStoreData {
  return getStoreDataSnapshot();
}

/** 클라우드 동기화로 수신한 원격 프로필 스토어 병합/적용 */
export function importProfilePayload(remoteStore: ProfileStoreData): boolean {
  if (!remoteStore || !Array.isArray(remoteStore.profiles) || remoteStore.profiles.length === 0) {
    return false;
  }
  const manifest = ensureManifestAndDataFiles();
  const manifestMap = new Map<string, UserProfileMeta>();
  for (const p of manifest.profiles) {
    manifestMap.set(p.id, p);
  }

  const activeId = manifest.activeProfileId;

  for (const remote of remoteStore.profiles) {
    const localMeta = manifestMap.get(remote.meta.id);
    const isTargetActive = (remote.meta.id === activeId);

    if (!localMeta) {
      manifestMap.set(remote.meta.id, remote.meta);
      saveProfileDataFile({
        version: 2,
        id: remote.meta.id,
        contentsCheckerItems: normalizeContentsCheckerItemsForProfile(remote.contentsCheckerItems || [], remote.meta.id),
        settings: remote.settings,
        updatedAt: remote.meta.updatedAt || Date.now()
      });
    } else {
      if ((remote.meta.updatedAt || 0) >= (localMeta.updatedAt || 0)) {
        manifestMap.set(remote.meta.id, remote.meta);
        // 활성 프로필의 숙제/설정은 이미 applyConfigFromCloud에서 3-way 머지로 안전하게 반영되었으므로,
        // 원격 스냅샷으로 덮어쓰지 않고 로컬의 머지 결과를 보존합니다.
        // 비활성 프로필(부계정들)에 대해서만 원격 데이터 파일로 안전하게 갱신합니다.
        if (!isTargetActive) {
          saveProfileDataFile({
            version: 2,
            id: remote.meta.id,
            contentsCheckerItems: normalizeContentsCheckerItemsForProfile(remote.contentsCheckerItems || [], remote.meta.id),
            settings: remote.settings,
            updatedAt: remote.meta.updatedAt || Date.now()
          });
        }
      }
    }
  }

  manifest.profiles = Array.from(manifestMap.values());
  saveManifest();

  const active = getActiveProfile();
  broadcastToAllWindows('profile-changed', {
    profileId: manifest.activeProfileId,
    meta: active.meta,
    summary: calculateProfileSummary(active)
  });
  return true;
}
