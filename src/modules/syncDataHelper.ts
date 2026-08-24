/**
 * 동기화 대상 데이터 추출, 병합(Merge) 및 충돌 방지 헬퍼 모듈
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AppConfig, ContentsCheckerItem, GoogleSyncPayload, CharacterPreset } from '../shared/types';
import { log } from './logger';

const BACKUP_FILENAME = 'config.backup-sync.json';

/** 클라우드 동기화 대상 필드 목록 */
const SYNCABLE_KEYS: Array<keyof AppConfig> = [
  'contentsCheckerItems',
  'contentsCheckerEnabled',
  'autoOpenContentsChecker',
  'characterPresets',
  'selectedCharacterId',
  'lootKeywords',
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
  'discordWebhookUrl',
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
];

/** 로컬 설정에서 동기화 대상 필드만 추출 */
export function extractSyncData(cfg: AppConfig): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};
  for (const key of SYNCABLE_KEYS) {
    if (cfg[key] !== undefined) {
      result[key] = JSON.parse(JSON.stringify(cfg[key]));
    }
  }
  return result;
}

/** 구글 드라이브 업로드용 페이로드 생성 */
export function buildSyncPayload(cfg: AppConfig, userEmail: string): GoogleSyncPayload {
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    lastSyncedAt: Date.now(),
    updatedBy: userEmail,
    data: extractSyncData(cfg),
  };
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
  for (const key of SYNCABLE_KEYS) {
    if (key === 'contentsCheckerItems' || key === 'characterPresets') continue;
    if (cloudData[key] !== undefined) {
      (merged as any)[key] = JSON.parse(JSON.stringify(cloudData[key]));
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
