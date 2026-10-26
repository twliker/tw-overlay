/**
 * 기능 계약 — 다중 프로필(Multi-Profile) 관리 모듈
 *
 * - 사용자의 여러 캐릭터/계정을 개별 프로필로 관리합니다.
 * - 프로필별로 숙제 체크리스트(completedState)와 UI 위치, 버프 타이머, 채팅 오버레이, 알림 설정을 독립 유지합니다.
 * - 원클릭 프로필 복제(Duplicate)를 지원하여 새 부캐 생성 시 기존 설정을 빠르게 승계할 수 있습니다.
 * - 최초 실행 시 기존 characterPresets 및 contentsCheckerItems 데이터를 안전하게 독립 프로필로 자동 마이그레이션합니다.
 * - 활성 프로필 전환 시 config 및 관련 오버레이 창에 즉시 변경 사항을 전파합니다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import {
  AppConfig,
  ContentsCheckerItem,
  ProfileStoreData,
  UserProfileData,
  UserProfileMeta,
  UserProfileSummary
} from '../shared/types';
import { PROFILE_SCOPED_CONFIG_KEYS } from '../shared/profileScopedKeys';
import * as config from './config';
import { log } from './logger';
import { broadcastToAllWindows } from './windowMessaging';

import { DEFAULT_CHARACTER_PRESETS, CharacterPreset, resolveProfileAvatarUrl } from '../shared/characterPresets';

export { DEFAULT_CHARACTER_PRESETS, CharacterPreset, resolveProfileAvatarUrl };

let _store: ProfileStoreData | null = null;
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

function getStoreFilePath(): string {
  return path.join(getProfilesDir(), 'profiles.json');
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

/** 프로필 항목의 completedState를 해당 profileId 키로 정규화 */
export function normalizeContentsCheckerItemsForProfile(items: ContentsCheckerItem[], profileId: string): ContentsCheckerItem[] {
  return items.map(item => {
    if (!item.completedState) return { ...item, completedState: {} };
    if (item.completedState[profileId]) return item;
    const values = Object.values(item.completedState);
    if (values.length > 0) {
      return {
        ...item,
        completedState: { [profileId]: values[0] }
      };
    }
    return item;
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
    let state = item.completedState?.[profile.meta.id]
      || item.completedState?.['default']
      || item.completedState?.['char-1'];
    if (!state && item.completedState) {
      const values = Object.values(item.completedState);
      if (values.length > 0) state = values[0];
    }
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

/** 스토어 파일 저장 */
function saveStoreInternal(): boolean {
  if (!_store) return false;
  try {
    const filePath = getStoreFilePath();
    const tempPath = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(_store, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    log(`[ProfileManager] 스토어 저장 실패: ${error}`);
    return false;
  }
}

/** 초기화 및 마이그레이션 */
export function initProfileStore(): ProfileStoreData {
  if (_store) return _store;

  const filePath = getStoreFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      _store = JSON.parse(content) as ProfileStoreData;
      if (_store && Array.isArray(_store.profiles) && _store.profiles.length > 0) {
        log(`[ProfileManager] 프로필 스토어 로드 성공 (${_store.profiles.length}개 프로필)`);
        setupConfigChangeListener();
        return _store;
      }
    } catch (e) {
      log(`[ProfileManager] 기존 profiles.json 로드 실패, 마이그레이션 재시도: ${e}`);
    }
  }

  // 파일이 없거나 유효하지 않으면 마이그레이션 수행
  _store = migrateFromLegacyConfig();
  saveStoreInternal();
  setupConfigChangeListener();
  return _store;
}

/** 기존 config 데이터에서 마이그레이션 */
function migrateFromLegacyConfig(): ProfileStoreData {
  const currentConfig = config.load();
  const legacyPresets = currentConfig.characterPresets || [];
  const legacyItems = currentConfig.contentsCheckerItems || [];
  const scopedSettings = extractProfileScopedSettings(currentConfig);

  const profiles: UserProfileData[] = [];
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

      const migratedItems: ContentsCheckerItem[] = structuredClone(legacyItems).map(item => {
        const charState = item.completedState?.[preset.id]
          || item.completedState?.['char-1']
          || (item.completedState ? Object.values(item.completedState)[0] : undefined);
        return {
          ...item,
          completedState: charState ? { [profileId]: charState } : {}
        };
      });

      profiles.push({
        meta: {
          id: profileId,
          name: preset.name || `캐릭터 ${i + 1}`,
          avatarUrl: matchedAvatar,
          createdAt: now,
          updatedAt: now,
          lastPlayedAt: i === 0 ? now : undefined
        },
        contentsCheckerItems: migratedItems,
        settings: structuredClone(scopedSettings)
      });
    }
  } else {
    const defaultProfileId = 'profile-default';
    profiles.push({
      meta: {
        id: defaultProfileId,
        name: '기본 프로필',
        avatarUrl: 'preset:boris',
        createdAt: now,
        updatedAt: now,
        lastPlayedAt: now
      },
      contentsCheckerItems: structuredClone(legacyItems),
      settings: structuredClone(scopedSettings)
    });
  }

  const legacyTargetId = profiles[0].meta.id;

  const storeData: ProfileStoreData = {
    version: 1,
    activeProfileId: legacyTargetId,
    profiles,
    showOnGameLaunch: true,
    showOnAppLaunch: true,
    legacyMigrationTargetProfileId: legacyTargetId
  };

  log(`[ProfileManager] 기존 데이터에서 ${profiles.length}개 프로필 마이그레이션 완료 (기준 프로필: ${legacyTargetId})`);
  return storeData;
}

/** config 변경 리스너 등록: 활성 프로필에 실시간 동기화 */
function setupConfigChangeListener(): void {
  config.addConfigChangeListener((changedConfig) => {
    if (_isSwitchingProfile || !_store) return;
    const active = getActiveProfile();
    if (!active) return;

    let hasChange = false;
    for (const key of PROFILE_SCOPED_CONFIG_KEYS) {
      if (key in changedConfig && (changedConfig as any)[key] !== undefined) {
        (active.settings as any)[key] = structuredClone((changedConfig as any)[key]);
        hasChange = true;
      }
    }

    if ('contentsCheckerItems' in changedConfig && Array.isArray(changedConfig.contentsCheckerItems)) {
      active.contentsCheckerItems = structuredClone(changedConfig.contentsCheckerItems);
      hasChange = true;
    }

    if (hasChange) {
      active.meta.updatedAt = Date.now();
      saveStoreInternal();
    }
  });
}

/** 전체 프로필 요약 목록 반환 */
export function getAllProfileSummaries(): UserProfileSummary[] {
  const store = initProfileStore();
  const active = store.profiles.find(p => p.meta.id === store.activeProfileId);
  if (active) {
    const currentConfig = config.load();
    if (currentConfig.contentsCheckerItems && currentConfig.contentsCheckerItems.length > 0) {
      active.contentsCheckerItems = structuredClone(currentConfig.contentsCheckerItems);
    }
  }
  return store.profiles.map(calculateProfileSummary);
}

/** 현재 활성화된 프로필 반환 */
export function getActiveProfile(): UserProfileData {
  const store = initProfileStore();
  const found = store.profiles.find(p => p.meta.id === store.activeProfileId);
  if (found) return found;
  if (store.profiles.length > 0) {
    store.activeProfileId = store.profiles[0].meta.id;
    return store.profiles[0];
  }
  const fallback = initProfileStore();
  return fallback.profiles[0];
}

/** 활성 프로필 ID */
export function getActiveProfileId(): string {
  const store = initProfileStore();
  return store.activeProfileId;
}

/** 활성 프로필 전환 */
export async function switchProfile(targetProfileId: string): Promise<boolean> {
  const store = initProfileStore();
  const target = store.profiles.find(p => p.meta.id === targetProfileId);
  if (!target) {
    log(`[ProfileManager] 전환 실패: 존재하지 않는 프로필 ID (${targetProfileId})`);
    return false;
  }

  if (store.activeProfileId === targetProfileId) {
    log(`[ProfileManager] 이미 활성화된 프로필: ${targetProfileId}`);
    return true;
  }

  log(`[ProfileManager] 프로필 전환 시작: ${store.activeProfileId} -> ${targetProfileId} (${target.meta.name})`);
  _isSwitchingProfile = true;

  try {
    const currentActive = store.profiles.find(p => p.meta.id === store.activeProfileId);
    if (currentActive) {
      const currentConfig = config.load();
      currentActive.settings = extractProfileScopedSettings(currentConfig);
      if (currentConfig.contentsCheckerItems) {
        currentActive.contentsCheckerItems = structuredClone(currentConfig.contentsCheckerItems);
      }
      currentActive.meta.updatedAt = Date.now();
    }

    store.activeProfileId = targetProfileId;
    target.meta.lastPlayedAt = Date.now();

    let itemsToApply = target.contentsCheckerItems;
    if (itemsToApply && itemsToApply.length > 0) {
      itemsToApply = normalizeContentsCheckerItemsForProfile(itemsToApply, targetProfileId);
      target.contentsCheckerItems = itemsToApply;
    } else {
      itemsToApply = normalizeContentsCheckerItemsForProfile(config.load().contentsCheckerItems || [], targetProfileId);
      target.contentsCheckerItems = itemsToApply;
    }

    const patchToApply: Partial<AppConfig> = {
      ...target.settings,
      activeProfileId: targetProfileId,
      selectedCharacterId: targetProfileId,
      characterPresets: [{ id: targetProfileId, name: target.meta.name }],
      contentsCheckerItems: structuredClone(itemsToApply)
    };

    config.saveConfirmed(patchToApply);
    saveStoreInternal();

    broadcastToAllWindows('profile-changed', {
      profileId: targetProfileId,
      meta: target.meta,
      summary: calculateProfileSummary(target)
    });
    broadcastToAllWindows('contents-items-updated');
    broadcastToAllWindows('config-data', config.load());

    log(`[ProfileManager] 프로필 전환 완료: ${target.meta.name}`);
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
  const store = initProfileStore();
  const now = Date.now();
  const profileId = `profile-${randomUUID().slice(0, 8)}`;

  let initialSettings: Partial<AppConfig> = {};
  let initialItems: ContentsCheckerItem[] = [];

  if (options.copyFromProfileId) {
    const source = store.profiles.find(p => p.meta.id === options.copyFromProfileId);
    if (source) {
      initialSettings = structuredClone(source.settings);
      initialItems = structuredClone(source.contentsCheckerItems || []).map(item => ({
        ...item,
        completedState: {}
      }));
    }
  } else {
    initialSettings = extractProfileScopedSettings(config.load());
    initialItems = structuredClone(config.load().contentsCheckerItems || []).map(item => ({
      ...item,
      completedState: {}
    }));
  }

  const newProfile: UserProfileData = {
    meta: {
      id: profileId,
      name: options.name.trim() || '새 프로필',
      avatarUrl: options.avatarUrl || 'preset:boris',
      createdAt: now,
      updatedAt: now,
      lastPlayedAt: undefined
    },
    contentsCheckerItems: initialItems,
    settings: initialSettings
  };

  store.profiles.push(newProfile);
  saveStoreInternal();
  log(`[ProfileManager] 새 프로필 생성됨: ${newProfile.meta.name} (${profileId})`);
  return newProfile;
}

/** 원클릭 프로필 복제 (Duplicate) */
export function duplicateProfile(sourceProfileId: string, customName?: string): UserProfileData | null {
  const store = initProfileStore();
  const source = store.profiles.find(p => p.meta.id === sourceProfileId);
  if (!source) return null;

  const newName = customName || `${source.meta.name}의 사본`;
  return createProfile({
    name: newName,
    avatarUrl: source.meta.avatarUrl,
    copyFromProfileId: sourceProfileId
  });
}

/** 프로필 수정 */
export function updateProfile(id: string, updates: { name?: string; avatarUrl?: string }): UserProfileData | null {
  const store = initProfileStore();
  const target = store.profiles.find(p => p.meta.id === id);
  if (!target) return null;

  if (updates.name !== undefined && updates.name.trim().length > 0) {
    target.meta.name = updates.name.trim();
  }
  if (updates.avatarUrl !== undefined) {
    target.meta.avatarUrl = updates.avatarUrl;
  }
  target.meta.updatedAt = Date.now();

  saveStoreInternal();

  if (store.activeProfileId === id) {
    broadcastToAllWindows('profile-changed', {
      profileId: id,
      meta: target.meta,
      summary: calculateProfileSummary(target)
    });
  }

  return target;
}

/** 프로필 삭제 (최소 1개는 유지) */
export async function deleteProfile(id: string): Promise<boolean> {
  const store = initProfileStore();
  if (store.profiles.length <= 1) {
    log(`[ProfileManager] 삭제 실패: 최소 1개의 프로필은 유지되어야 합니다.`);
    return false;
  }

  const index = store.profiles.findIndex(p => p.meta.id === id);
  if (index === -1) return false;

  if (store.activeProfileId === id) {
    const nextProfile = store.profiles.find(p => p.meta.id !== id);
    if (nextProfile) {
      await switchProfile(nextProfile.meta.id);
    }
  }

  const removeIndex = store.profiles.findIndex(p => p.meta.id === id);
  if (removeIndex !== -1) {
    store.profiles.splice(removeIndex, 1);
  }
  saveStoreInternal();
  log(`[ProfileManager] 프로필 삭제됨: ${id}`);
  return true;
}

/** 사용자가 업로드한 아바타 이미지 저장 (base64 Data URL로 인라인 보관하여 클라우드 동기화 및 렌더러 표시 보장) */
export function saveUploadedAvatar(fileName: string, buffer: Buffer): string {
  const ext = path.extname(fileName).toLowerCase() || '.png';
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

/** 선택창 노출 옵션 조회/설정 */
export function getSelectorDisplayOptions(): { showOnGameLaunch: boolean; showOnAppLaunch: boolean } {
  const store = initProfileStore();
  return {
    showOnGameLaunch: store.showOnGameLaunch ?? true,
    showOnAppLaunch: store.showOnAppLaunch ?? true
  };
}

/**
 * 시작 시(앱 실행 or 게임 시작) 프로필 선택창을 자동으로 띄워야 하는지 판별합니다.
 * - 사용자가 자동 표시 옵션을 켰더라도, 등록된 프로필이 1개 이하이면 선택할 대상이 없으므로 자동으로 띄우지 않습니다.
 * - 프로필이 2개 이상일 때만 설정된 자동 노출 옵션에 따라 표시합니다.
 */
export function shouldShowSelectorAutomatically(context: 'app' | 'game'): boolean {
  const store = initProfileStore();
  if (!store.profiles || store.profiles.length <= 1) {
    return false;
  }
  if (context === 'game') {
    return store.showOnGameLaunch ?? true;
  }
  if (context === 'app') {
    return store.showOnAppLaunch ?? true;
  }
  return false;
}

export function setSelectorDisplayOptions(options: { showOnGameLaunch?: boolean; showOnAppLaunch?: boolean }): void {
  const store = initProfileStore();
  if (options.showOnGameLaunch !== undefined) store.showOnGameLaunch = options.showOnGameLaunch;
  if (options.showOnAppLaunch !== undefined) store.showOnAppLaunch = options.showOnAppLaunch;
  saveStoreInternal();
}

/** 클라우드 동기화용 프로필 페이로드 내보내기 */
export function exportProfilePayload(): ProfileStoreData {
  return structuredClone(initProfileStore());
}

/** 클라우드 동기화로 수신한 원격 프로필 스토어 병합/적용 */
export function importProfilePayload(remoteStore: ProfileStoreData): boolean {
  if (!remoteStore || !Array.isArray(remoteStore.profiles) || remoteStore.profiles.length === 0) {
    return false;
  }
  const localStore = initProfileStore();

  const profileMap = new Map<string, UserProfileData>();
  for (const local of localStore.profiles) {
    profileMap.set(local.meta.id, local);
  }

  for (const remote of remoteStore.profiles) {
    const local = profileMap.get(remote.meta.id);
    if (!local) {
      profileMap.set(remote.meta.id, remote);
    } else {
      if ((remote.meta.updatedAt || 0) >= (local.meta.updatedAt || 0)) {
        profileMap.set(remote.meta.id, remote);
      }
    }
  }

  localStore.profiles = Array.from(profileMap.values());
  saveStoreInternal();
  broadcastToAllWindows('profile-changed', {
    profileId: localStore.activeProfileId,
    meta: getActiveProfile().meta,
    summary: calculateProfileSummary(getActiveProfile())
  });
  return true;
}
