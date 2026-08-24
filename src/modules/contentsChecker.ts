/**
 * 일일/주간 컨텐츠 체크 리스트 로직 모듈
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import * as config from './config';
import { AppConfig, ContentsCheckerItem, ResetRule, MAIN_CHAR_ID, DEFAULT_CHAR_NAME, PendingHomework } from '../shared/types';
import { log } from './logger';
import * as diaryDb from './diaryDb';

type LegacyContentsCheckerItem = ContentsCheckerItem & {
  isCompleted?: boolean;
  lastCompletedAt?: number;
};

interface ContentsResourceMeta {
  schemaVersion: number;
  resourceVersion: string;
  expectedItemCount: number;
  sentinelIds: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateDefaultItem(value: unknown, index: number): ContentsCheckerItem {
  if (!isPlainObject(value)) throw new Error(`${index}번 항목이 객체가 아닙니다.`);
  const id = value.id;
  const name = value.name;
  const category = value.category;
  const resetRule = value.resetRule;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,127}$/.test(id)) {
    throw new Error(`${index}번 항목 ID가 유효하지 않습니다.`);
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
    throw new Error(`${id}의 이름이 유효하지 않습니다.`);
  }
  if (typeof category !== 'string' || category.trim().length === 0 || category.length > 100) {
    throw new Error(`${id}의 분류가 유효하지 않습니다.`);
  }
  if (typeof value.isVisible !== 'boolean') throw new Error(`${id}의 isVisible이 boolean이 아닙니다.`);
  if (value.isCustom !== undefined && typeof value.isCustom !== 'boolean') {
    throw new Error(`${id}의 isCustom이 boolean이 아닙니다.`);
  }
  if (value.auto !== undefined && typeof value.auto !== 'boolean') {
    throw new Error(`${id}의 auto가 boolean이 아닙니다.`);
  }
  if (!isPlainObject(resetRule) || (resetRule.type !== 'daily' && resetRule.type !== 'weekly')) {
    throw new Error(`${id}의 resetRule이 유효하지 않습니다.`);
  }
  if (!Number.isInteger(resetRule.hour) || (resetRule.hour as number) < 0 || (resetRule.hour as number) > 23) {
    throw new Error(`${id}의 리셋 시각이 유효하지 않습니다.`);
  }
  if (
    resetRule.type === 'weekly'
    && (!Number.isInteger(resetRule.dayOfWeek)
      || (resetRule.dayOfWeek as number) < 0
      || (resetRule.dayOfWeek as number) > 6)
  ) {
    throw new Error(`${id}의 주간 리셋 요일이 유효하지 않습니다.`);
  }
  if (value.maxCount !== undefined && (!Number.isInteger(value.maxCount) || (value.maxCount as number) < 1 || (value.maxCount as number) > 10_000)) {
    throw new Error(`${id}의 maxCount가 유효하지 않습니다.`);
  }

  return {
    id,
    name,
    category,
    isVisible: value.isVisible,
    isCustom: value.isCustom as boolean | undefined,
    resetRule: {
      type: resetRule.type,
      ...(resetRule.type === 'weekly' ? { dayOfWeek: resetRule.dayOfWeek as number } : {}),
      hour: resetRule.hour as number
    },
    maxCount: value.maxCount as number | undefined,
    auto: value.auto as boolean | undefined,
    completedState: {}
  };
}

function validateResourceMeta(value: unknown): ContentsResourceMeta {
  if (!isPlainObject(value)) throw new Error('contents.meta.json 최상위 값이 객체가 아닙니다.');
  if (value.schemaVersion !== 1) throw new Error(`지원하지 않는 contents schemaVersion: ${String(value.schemaVersion)}`);
  if (typeof value.resourceVersion !== 'string' || value.resourceVersion.trim().length === 0) {
    throw new Error('contents resourceVersion이 없습니다.');
  }
  if (!Number.isInteger(value.expectedItemCount) || (value.expectedItemCount as number) < 1) {
    throw new Error('contents expectedItemCount가 유효하지 않습니다.');
  }
  if (!Array.isArray(value.sentinelIds) || value.sentinelIds.length < 3 || value.sentinelIds.some(id => typeof id !== 'string')) {
    throw new Error('contents sentinelIds가 유효하지 않습니다.');
  }
  return {
    schemaVersion: 1,
    resourceVersion: value.resourceVersion,
    expectedItemCount: value.expectedItemCount as number,
    sentinelIds: [...value.sentinelIds] as string[]
  };
}

/** 기본 컨텐츠와 동반 메타데이터를 모두 검증한 뒤에만 반환한다. */
function loadDefaultItems(): ContentsCheckerItem[] | null {
  try {
    const dataDirectory = path.join(app.getAppPath(), 'dist', 'assets', 'data');
    const jsonPath = path.join(dataDirectory, 'contents.json');
    const metaPath = path.join(dataDirectory, 'contents.meta.json');
    if (!fs.existsSync(jsonPath) || !fs.existsSync(metaPath)) {
      throw new Error(`리소스 파일 누락: ${!fs.existsSync(jsonPath) ? jsonPath : metaPath}`);
    }

    const rawItems = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as unknown;
    const meta = validateResourceMeta(JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as unknown);
    if (!Array.isArray(rawItems)) throw new Error('contents.json 최상위 값이 배열이 아닙니다.');
    if (rawItems.length !== meta.expectedItemCount) {
      throw new Error(`contents 항목 수 불일치: expected=${meta.expectedItemCount}, actual=${rawItems.length}`);
    }

    const items = rawItems.map(validateDefaultItem);
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) throw new Error(`contents 중복 ID: ${item.id}`);
      ids.add(item.id);
    }
    for (const sentinelId of meta.sentinelIds) {
      if (!ids.has(sentinelId)) throw new Error(`contents sentinel 누락: ${sentinelId}`);
    }
    log(`[Contents] 기본 리소스 검증 완료: ${meta.resourceVersion}, ${items.length}개`);
    return items;
  } catch (error) {
    log(`[Contents] 기본 데이터 검증 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

const cloneItems = (items: ContentsCheckerItem[] | undefined): ContentsCheckerItem[] => structuredClone(items || []);
const clonePresets = <T>(presets: T[] | undefined): T[] => structuredClone(presets || []);
const clonePending = (pending: PendingHomework[] | undefined): PendingHomework[] => structuredClone(pending || []);

/** 초기화 및 병합 (앱 시작 시 호출) */
export function init(): void {
  const defaultItems = loadDefaultItems();
  // 치명적 데이터 삭제 방어 가드 (contents.json 로드 실패 시 기존 사용자 데이터 보존)
  if (!defaultItems) {
    log('[Contents Checker] 기본 데이터 검증 실패로 인해 모든 마이그레이션·필터링·저장을 중단합니다.');
    return;
  }

  const cfg = config.load();
  let currentItems = cloneItems(cfg.contentsCheckerItems) as LegacyContentsCheckerItem[];
  let changed = false;

  // 구버전 클럽던전 데이터 삭제 처리 (신규 클럽 보스로 대체)
  const hasOldClubDungeon = currentItems.some(i => i.id === 'daily-club-dungeon');
  if (hasOldClubDungeon) {
    log(`[Contents Checker] 구버전 클럽던전 데이터 삭제`);
    currentItems = currentItems.filter(i => i.id !== 'daily-club-dungeon');
    changed = true;
  }

  // 구버전 임시 등록된 주간 pitta/eta-will-upgrade ID를 일일형으로 변경
  currentItems.forEach(item => {
    if (item.id === 'weekly-pitta') {
      log(`[Contents Checker] 주간 pitta -> 일일 pitta 마이그레이션`);
      item.id = 'daily-pitta';
      item.resetRule = { type: 'daily', hour: 0 };
      changed = true;
    }
    if (item.id === 'weekly-eta-will-upgrade') {
      log(`[Contents Checker] 주간 에타 도전과제 -> 일일 에타 도전과제 마이그레이션`);
      item.id = 'daily-eta-will-upgrade';
      item.resetRule = { type: 'daily', hour: 0 };
      changed = true;
    }
  });

  // 0-A. 고대 렐릭의 성소 (신조/키시니크) 단일 항목 병합 마이그레이션
  const relicShinjoIdx = currentItems.findIndex(i => i.id === 'weekly-ancient-relic-shinjo');
  const relicKishinikIdx = currentItems.findIndex(i => i.id === 'weekly-ancient-relic-kishinik');
  
  if (relicShinjoIdx !== -1 || relicKishinikIdx !== -1) {
    log(`[Contents Checker] 고대 렐릭의 성소 병합 마이그레이션 수행`);
    const relicDef = defaultItems.find(d => d.id === 'weekly-ancient-relic');
    if (relicDef) {
      let relicItem = currentItems.find(i => i.id === 'weekly-ancient-relic');
      if (!relicItem) {
        relicItem = {
          ...relicDef,
          completedState: {}
        };
        currentItems.push(relicItem);
      }
      
      const shinjoItem = relicShinjoIdx !== -1 ? currentItems[relicShinjoIdx] : null;
      const kishinikItem = relicKishinikIdx !== -1 ? currentItems[relicKishinikIdx] : null;
      
      relicItem.isVisible = (shinjoItem?.isVisible !== false) || (kishinikItem?.isVisible !== false);
      
      const presets = cfg.characterPresets || [{ id: MAIN_CHAR_ID, name: DEFAULT_CHAR_NAME }];
      presets.forEach(char => {
        const charId = char.id;
        const sState = shinjoItem?.completedState?.[charId];
        const kState = kishinikItem?.completedState?.[charId];
        
        const sCount = sState?.currentCount || 0;
        const kCount = kState?.currentCount || 0;
        const totalCount = Math.min(relicDef.maxCount || 7, sCount + kCount);
        
        const isExcluded = !!(sState?.isExcluded && kState?.isExcluded);
        
        relicItem.completedState[charId] = {
          currentCount: totalCount,
          isCompleted: totalCount >= (relicDef.maxCount || 7),
          isExcluded,
          lastCompletedAt: sState?.lastCompletedAt || kState?.lastCompletedAt
        };
      });
      
      if (relicShinjoIdx !== -1) {
        currentItems = currentItems.filter(i => i.id !== 'weekly-ancient-relic-shinjo');
      }
      if (relicKishinikIdx !== -1) {
        currentItems = currentItems.filter(i => i.id !== 'weekly-ancient-relic-kishinik');
      }
      changed = true;
    }
  }

  // 0. ID 및 리셋 룰 마이그레이션 (일일 -> 주간)
  const ID_MIGRATION_MAP: Record<string, string> = {
    'daily-mur-1': 'weekly-mur-1',
    'daily-abyss-treasure': 'weekly-abyss-treasure',
    'daily-power-root': 'weekly-power-root',
    'daily-rune-dungeon': 'weekly-rune-dungeon',
    'daily-tesis-core': 'weekly-tesis-core',
    'daily-digsite': 'weekly-digsite',
    'daily-fortress-ghost': 'weekly-fortress-ghost',
    'daily-eclipse-6boss': 'weekly-eclipse-6boss',
    'daily-eclipse-recapture-supplies': 'weekly-eclipse-recapture-supplies',
    'daily-eclipse-special-force-suppression': 'weekly-eclipse-special-force-suppression',
    'daily-apethiria-ex': 'weekly-apethiria-ex',
    'daily-moon-queen': 'weekly-moon-queen',
    'daily-eclipse-boss': 'weekly-eclipse-boss',
    'daily-ancient-relic-shinjo': 'weekly-ancient-relic-shinjo',
    'daily-ancient-relic-kishinik': 'weekly-ancient-relic-kishinik',
    'weekly-eclipse-boss-selfina': 'weekly-eclipse-boss-lokagos'
  };

  currentItems.forEach(item => {
    if (ID_MIGRATION_MAP[item.id]) {
      const newId = ID_MIGRATION_MAP[item.id];
      log(`[Contents Checker] 마이그레이션: ${item.id} -> ${newId}`);
      item.id = newId;
      // 로카고스로의 단순 ID 마이그레이션의 경우 주간 룰로의 일방적인 강제 덮어쓰기 방지
      if (item.id !== 'weekly-eclipse-boss-lokagos') {
        item.resetRule = { type: 'weekly', dayOfWeek: 1, hour: 0 };
        item.maxCount = 7;
      }

      if (item.completedState) {
        Object.keys(item.completedState).forEach(charId => {
          const state = item.completedState[charId];
          if (state.currentCount === undefined) {
            state.currentCount = state.isCompleted ? (item.maxCount || 7) : 0;
          }
        });
      }
      changed = true;
    }
  });

  // 0-1. 기존 뭉뚱그려진 주간 보스 숙제의 세분화 마이그레이션 (가시성 및 캐릭터별 제외 상태 승계)
  const SPLIT_MIGRATION_MAP: Record<string, string[]> = {
    'weekly-mur-1': [
      'weekly-mur-sylvan',
      'weekly-mur-salion',
      'weekly-mur-silyron',
      'weekly-mur-saleana',
      'weekly-mur-luminous',
      'weekly-mur-luminous-ex'
    ],
    'weekly-eclipse-6boss': [
      'weekly-eclipse-boss-ethos',
      'weekly-eclipse-boss-matias',
      'weekly-eclipse-boss-tyrorost',
      'weekly-eclipse-boss-lycos',
      'weekly-eclipse-boss-cheria',
      'weekly-eclipse-boss-lokagos'
    ],
    'weekly-abyss-core-master': [
      'weekly-abyss-core-master-1',
      'weekly-abyss-core-master-2',
      'weekly-abyss-core-master-3'
    ],
    'weekly-mercurial-core-master': [
      'weekly-mur-core-master-sylvan',
      'weekly-mur-core-master-salion',
      'weekly-mur-core-master-silyron',
      'weekly-mur-core-master-saleana',
      'weekly-mur-core-master-luminous'
    ],
    'weekly-abyss-dungeon': [
      'weekly-abyss-dungeon-1',
      'weekly-abyss-dungeon-2',
      'weekly-abyss-dungeon-3'
    ],
    'weekly-abandon-road': [
      'weekly-abandon-road-mortal',
      'weekly-abandon-road-cardiff',
      'weekly-abandon-road-orlanne'
    ]
  };

  Object.entries(SPLIT_MIGRATION_MAP).forEach(([oldId, newIds]) => {
    const oldItemIdx = currentItems.findIndex(item => item.id === oldId);
    if (oldItemIdx !== -1) {
      const oldItem = currentItems[oldItemIdx];
      log(`[Contents Checker] 분할 마이그레이션 시작: ${oldId} -> ${newIds.join(', ')}`);
      
      newIds.forEach(newId => {
        const def = defaultItems.find(d => d.id === newId);
        if (!def) return;

        let newItem = currentItems.find(item => item.id === newId);
        if (!newItem) {
          newItem = {
            ...def,
            completedState: {}
          };
          currentItems.push(newItem);
        }

        // 이전 설정 승계
        newItem.isVisible = oldItem.isVisible;
        
        if (oldItem.completedState) {
          Object.keys(oldItem.completedState).forEach(charId => {
            const oldState = oldItem.completedState[charId];
            if (!newItem.completedState[charId]) {
              newItem.completedState[charId] = {
                isCompleted: !!oldState.isCompleted,
                currentCount: oldState.isCompleted ? (def.maxCount || 1) : 0,
                lastCompletedAt: oldState.lastCompletedAt
              };
            }
            if (oldState.isExcluded !== undefined) {
              newItem.completedState[charId].isExcluded = oldState.isExcluded;
            }
          });
        }
      });

      // 구 버전 숙제 제거
      currentItems.splice(oldItemIdx, 1);
      changed = true;
    }
  });

  // 0-2. ID 기준 중복 항목 제거 및 상태 병합
  const uniqueMap = new Map<string, LegacyContentsCheckerItem>();
  const deduplicatedItems: LegacyContentsCheckerItem[] = [];

  currentItems.forEach(item => {
    if (!uniqueMap.has(item.id)) {
      uniqueMap.set(item.id, item);
      deduplicatedItems.push(item);
    } else {
      const existing = uniqueMap.get(item.id)!;
      log(`[Contents Checker] 중복 항목 감지 및 병합: ${item.id} (${item.name})`);

      // 더 가치 있는 설정 보존 (가시성이 켜져 있거나 완료 횟수가 더 많은 상태 우선)
      if (item.isVisible) {
        existing.isVisible = true;
      }
      if (item.completedState) {
        if (!existing.completedState) existing.completedState = {};
        Object.keys(item.completedState).forEach(charId => {
          const extState = existing.completedState[charId];
          const itemState = item.completedState[charId];
          if (!extState) {
            existing.completedState[charId] = { ...itemState };
          } else {
            const extCount = extState.currentCount || 0;
            const itemCount = itemState.currentCount || 0;
            if (itemCount > extCount || itemState.isCompleted) {
              existing.completedState[charId] = { ...itemState };
            }
          }
        });
      }
      changed = true;
    }
  });
  currentItems = deduplicatedItems;

  // currentItems를 순회하며 defaultItems에 정의된 maxCount를 동기화
  currentItems.forEach(item => {
    const def = defaultItems.find(d => d.id === item.id);
    if (def && item.maxCount !== def.maxCount) {
      item.maxCount = def.maxCount;
      changed = true;
    }
  });

  // 1. 캐릭터 프리셋 초기화
  let characterPresets = cfg.characterPresets || [];
  if (characterPresets.length === 0) {
    characterPresets = [{ id: MAIN_CHAR_ID, name: DEFAULT_CHAR_NAME }];
    changed = true;
  }
  const selectedCharacterId = cfg.selectedCharacterId || characterPresets[0].id;
  if (!cfg.selectedCharacterId) {
    changed = true;
  }

  // 2. 데이터 마이그레이션 및 구조 일원화
  currentItems.forEach(item => {
    if (!item.completedState) {
      item.completedState = {};
      changed = true;
    }

    // maxCount가 변경/지정되었으나 캐릭터별 currentCount 필드가 누락된 경우 안전하게 마이그레이션
    // 또한 currentCount가 새로운 maxCount를 초과하는 경우 한도 내로 자동 조정
    const max = item.maxCount || 1;
    if (item.completedState) {
      Object.keys(item.completedState).forEach(charId => {
        const state = item.completedState[charId];
        if (state.currentCount === undefined) {
          state.currentCount = state.isCompleted ? max : 0;
          changed = true;
        } else if (state.currentCount > max) {
          state.currentCount = max;
          state.isCompleted = true;
          changed = true;
        }
      });
    }

    // [v1.12.7 일원화] 기존 단일 필드가 존재한다면 마이그레이션 후 삭제
    if (item.isCompleted !== undefined) {
      if (!item.completedState[MAIN_CHAR_ID]) {
        item.completedState[MAIN_CHAR_ID] = {
          isCompleted: !!item.isCompleted,
          lastCompletedAt: item.lastCompletedAt
        };
      }
      // 마이그레이션 완료 후 구버전 필드 제거 (중복 관리 배제)
      delete item.isCompleted;
      delete item.lastCompletedAt;
      changed = true;
      log(`[Contents] 마이그레이션 완료: ${item.name}의 상태를 completedState로 통합`);
    }
  });

  // 3. 기본 아이템 병합 및 업데이트 (사용자 상태 보존하면서 신규 속성 반영)
  defaultItems.forEach(def => {
    const exists = currentItems.find(item => item.id === def.id);
    if (!exists) {
      currentItems.push({ 
        ...def, 
        completedState: {}
      });
      changed = true;
    } else {
      const merged: ContentsCheckerItem = {
        ...def,
        isVisible: exists.isVisible ?? true,
        isCustom: exists.isCustom ?? false,
        completedState: exists.completedState || {}
      };
      if (JSON.stringify(exists) !== JSON.stringify(merged)) {
        Object.assign(exists, merged);
        changed = true;
      }
    }
  });

  // 3-1. 프리셋에서 제거된 기본 아이템 자동 삭제 (isCustom이 아니고 contents.json에 없는 항목 제거)
  const initialCount = currentItems.length;
  currentItems = currentItems.filter(item => {
    if (item.isCustom || item.id.startsWith('custom-')) {
      return true;
    }
    const existsInDefault = defaultItems.some(def => def.id === item.id);
    if (existsInDefault) {
      return true;
    }
    log(`[Contents Checker] 프리셋에서 제외된 미사용 기본 숙제 자동 삭제: ${item.id} (${item.name})`);
    return false;
  });
  if (currentItems.length !== initialCount) {
    changed = true;
  }

  // 3-2. 병합 후 maxCount 초과 카운트 안전 보정
  currentItems.forEach(item => {
    const max = item.maxCount || 1;
    if (item.completedState) {
      Object.keys(item.completedState).forEach(charId => {
        const state = item.completedState[charId];
        if (state.currentCount === undefined) {
          state.currentCount = state.isCompleted ? max : 0;
          changed = true;
        } else if (state.currentCount > max) {
          state.currentCount = max;
          state.isCompleted = true;
          changed = true;
        }
      });
    }
  });

  if (changed || !cfg.contentsCheckerItems) {
    config.saveImmediate({ 
      contentsCheckerItems: currentItems,
      characterPresets,
      selectedCharacterId
    });
    import('./windowManager').then(wm => wm.applySettings({}));
  }
  
  checkReset();
}

/** 초기화 로직 (정기적으로 또는 수동 호출) */
export function checkReset(): boolean {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const now = new Date();
  const nowTs = now.getTime();
  const lastCheck = cfg.lastContentsResetCheck || 0;

  let changed = false;

  items.forEach(item => {
    // 캐릭터별 상태 초기화
    if (item.completedState) {
      Object.keys(item.completedState).forEach(charId => {
        const state = item.completedState[charId];
        // 진행중이거나 완료된 상태인 경우 초기화 검사
        if (state.isCompleted || (state.currentCount && state.currentCount > 0)) {
          const lastCompleted = state.lastCompletedAt ? new Date(state.lastCompletedAt) : new Date(0);
          if (shouldReset(item.resetRule, lastCompleted, now)) {
            state.isCompleted = false;
            state.lastCompletedAt = undefined;
            state.currentCount = 0;
            changed = true;
            log(`[Contents] 초기화됨: ${item.name} (캐릭터: ${charId}, ${item.resetRule.type})`);
          }
        }
      });
    }
  });

  if (changed || lastCheck === 0) {
    config.saveImmediate({ 
      contentsCheckerItems: items,
      lastContentsResetCheck: nowTs 
    });
    syncDiaryStats(items);
    refreshUI();
  }

  return changed;
}

/** 특정 규칙에 따라 초기화 여부 판단 (직전 리셋 시점 기준 안전 판정) */
function shouldReset(rule: ResetRule, lastCompleted: Date, now: Date): boolean {
  const resetHour = rule.hour ?? 0;

  if (rule.type === 'daily') {
    // 현재 시점(now) 기준 가장 최근에 지난 일일 리셋 시점 계산
    const mostRecentReset = new Date(now);
    mostRecentReset.setHours(resetHour, 0, 0, 0);

    // 아직 오늘의 리셋 시각에 도달하지 않은 경우 어제의 리셋 시각이 기준
    if (now < mostRecentReset) {
      mostRecentReset.setDate(mostRecentReset.getDate() - 1);
    }

    // 마지막 완료 시점이 직전 리셋 시점 이전이면 초기화 대상
    return lastCompleted < mostRecentReset;
  }

  if (rule.type === 'weekly') {
    const resetDay = rule.dayOfWeek ?? 1; // 기본 월요일 (1)

    // 현재 시점(now) 기준 가장 최근에 지난 주간 리셋 시점 계산
    const mostRecentReset = new Date(now);
    mostRecentReset.setHours(resetHour, 0, 0, 0);

    // 요일 차이 계산 (0 ~ 6)
    const dayDiff = (now.getDay() - resetDay + 7) % 7;
    mostRecentReset.setDate(mostRecentReset.getDate() - dayDiff);

    // 요일은 같으나 아직 오늘의 resetHour 이전인 경우 지난주(7일 전)가 직전 리셋 시점
    if (dayDiff === 0 && now < mostRecentReset) {
      mostRecentReset.setDate(mostRecentReset.getDate() - 7);
    }

    // 마지막 완료 시점이 직전 주간 리셋 시점 이전이면 초기화 대상
    return lastCompleted < mostRecentReset;
  }

  return false;
}

/** 일지(다이어리) 통계 동기화 */
function syncDiaryStats(items: ContentsCheckerItem[]) {
  const cfg = config.load();
  const presets = cfg.characterPresets || [{ id: MAIN_CHAR_ID, name: DEFAULT_CHAR_NAME }];
  
  let dailyTotal = 0;
  let dailyDone = 0;
  let weeklyTotal = 0;
  let weeklyDone = 0;

  // 모든 캐릭터의 숙제 현황을 합산
  presets.forEach(char => {
    const charId = char.id;
    // 해당 캐릭터에 대해 가시성이 있고 제외되지 않은 아이템만 필터링
    const visibleItems = items.filter(i => {
      const state = i.completedState?.[charId];
      return i.isVisible && !state?.isExcluded;
    });
    
    dailyTotal += visibleItems.filter(i => i.resetRule.type === 'daily').length;
    weeklyTotal += visibleItems.filter(i => i.resetRule.type === 'weekly').length;

    dailyDone += visibleItems.filter(i => {
      return i.resetRule.type === 'daily' && (i.completedState?.[charId]?.isCompleted);
    }).length;

    weeklyDone += visibleItems.filter(i => {
      return i.resetRule.type === 'weekly' && (i.completedState?.[charId]?.isCompleted);
    }).length;
  });
  
  diaryDb.updateHomeworkStats(
    getLocalDateKey(),
    dailyDone,
    dailyTotal,
    weeklyDone,
    weeklyTotal,
  );
}

/** 화면 갱신 알림 유틸리티 */
function refreshUI() {
  import('./windowManager').then(wm => wm.applySettings({}));
}

function getLocalDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function syncHomeworkDiary(
  cfg: AppConfig,
  item: ContentsCheckerItem,
  characterId: string,
  state: ContentsCheckerItem['completedState'][string],
  previousCompleted?: boolean,
): void {
  const date = getLocalDateKey();
  const characterName =
    cfg.characterPresets?.find(preset => preset.id === characterId)?.name
    || '알수없음';
  const contentId = `${item.id}_${characterId}`;
  const contentName = `[${characterName}] ${item.name}`;
  const shouldAdd = state.isCompleted
    && (previousCompleted === undefined || !previousCompleted);
  const shouldRemove = !state.isCompleted
    && (previousCompleted === undefined || previousCompleted);

  if (shouldAdd) {
    diaryDb.addHomeworkLog(
      date,
      contentId,
      contentName,
      item.category,
      item.resetRule.type,
      Date.now(),
    );
  } else if (shouldRemove) {
    diaryDb.removeHomeworkLog(date, contentId);
  }
}

function getItemStateContext(id: string, characterId?: string) {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const targetCharId = characterId || cfg.selectedCharacterId || MAIN_CHAR_ID;
  const item = items.find(candidate => candidate.id === id);
  if (!item) return null;

  if (!item.completedState) item.completedState = {};
  if (!item.completedState[targetCharId]) {
    item.completedState[targetCharId] = { isCompleted: false };
  }

  return {
    cfg,
    items,
    targetCharId,
    item,
    state: item.completedState[targetCharId],
  };
}

/** 항목 토글 */
export function toggleItem(id: string, characterId?: string): void {
  const context = getItemStateContext(id, characterId);
  if (context) {
    const { cfg, items, targetCharId, item, state } = context;

    // 제외된 항목은 체크 불가 (방어 로직)
    if (state.isExcluded) return;

    const max = item.maxCount || 1;

    state.isCompleted = !state.isCompleted;
    state.currentCount = state.isCompleted ? max : 0;
    state.lastCompletedAt = state.currentCount > 0 ? Date.now() : undefined;

    config.saveImmediate({ contentsCheckerItems: items });

    syncHomeworkDiary(cfg, item, targetCharId, state);

    // 전 캐릭터 통합 다이어리 통계 동기화
    syncDiaryStats(items);

    refreshUI();
  }
}

/** 캐릭터별 숙제 제외(N/A) 토글 */
export function toggleExcludeItem(id: string, characterId: string): void {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const item = items.find(i => i.id === id);
  
  if (item) {
    if (!item.completedState) item.completedState = {};
    if (!item.completedState[characterId]) {
      item.completedState[characterId] = { isCompleted: false };
    }

    const state = item.completedState[characterId];
    state.isExcluded = !state.isExcluded;
    
    // 제외 처리 시 완료 상태는 해제
    if (state.isExcluded) {
      state.isCompleted = false;
      state.lastCompletedAt = undefined;
      
      // 일지에서도 제거
      const diaryContentId = `${item.id}_${characterId}`;
      diaryDb.removeHomeworkLog(getLocalDateKey(), diaryContentId);
    }

    config.saveImmediate({ contentsCheckerItems: items });
    
    // 전 캐릭터 통합 다이어리 통계 동기화
    syncDiaryStats(items);
    
    refreshUI();
  }
}

/** 캐릭터 관리: 추가 */
export function addCharacter(name: string): void {
  const cfg = config.load();
  const presets = clonePresets(cfg.characterPresets);
  // 더 안전한 고유 ID 생성 (시간 기반 36진수 + 랜덤 36진수)
  const newId = `char-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  presets.push({ id: newId, name });
  
  config.saveImmediate({ 
    characterPresets: presets,
    selectedCharacterId: newId // 추가하면 바로 선택
  });
  refreshUI();
}

/** 캐릭터 관리: 삭제 */
export function removeCharacter(id: string): void {
  const cfg = config.load();
  let presets = clonePresets(cfg.characterPresets);
  if (presets.length <= 1) return; // 최소 1개는 유지

  presets = presets.filter(p => p.id !== id);
  let selectedId = cfg.selectedCharacterId;
  if (selectedId === id) {
    selectedId = presets[0].id;
  }

  // 모든 아이템에서 해당 캐릭터의 상태 삭제
  const items = cloneItems(cfg.contentsCheckerItems);
  items.forEach(item => {
    if (item.completedState) {
      delete item.completedState[id];
    }
  });

  config.saveImmediate({ 
    characterPresets: presets, 
    selectedCharacterId: selectedId,
    contentsCheckerItems: items
  });
  syncDiaryStats(items);
  refreshUI();
}

/** 캐릭터 관리: 이름 변경 */
export function renameCharacter(id: string, newName: string): void {
  const cfg = config.load();
  const presets = clonePresets(cfg.characterPresets);
  const char = presets.find(p => p.id === id);
  if (char) {
    char.name = newName;
    config.saveImmediate({ characterPresets: presets });
    refreshUI();
  }
}

/** 캐릭터 선택 */
export function selectCharacter(id: string): void {
  config.saveImmediate({ selectedCharacterId: id });
  refreshUI();
}

/** 가시성 토글 */
export function toggleVisibility(id: string): void {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const item = items.find(i => i.id === id);
  if (item) {
    item.isVisible = !item.isVisible;
    config.saveImmediate({ contentsCheckerItems: items });
    refreshUI();
  }
}

/** 항목 수정 (이름, 카테고리, 초기화 규칙, 주간 최대 횟수) */
export function updateItem(id: string, name: string, category: string, rule: ResetRule, maxCount?: number): void {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const item = items.find(i => i.id === id);
  if (item) {
    item.name = name;
    item.category = category;
    item.resetRule = rule;
    
    if (rule.type === 'weekly') {
      const newMax = maxCount !== undefined ? maxCount : 1;
      item.maxCount = newMax;
      
      // 캐릭터별 완료 횟수가 새로운 maxCount를 초과하는 경우 한도 내로 자동 조정
      if (item.completedState) {
        Object.keys(item.completedState).forEach(charId => {
          const state = item.completedState[charId];
          if (state.currentCount !== undefined && state.currentCount > newMax) {
            state.currentCount = newMax;
            state.isCompleted = true;
          }
        });
      }
    } else {
      // daily일 경우 maxCount 제거
      delete item.maxCount;
      if (item.completedState) {
        Object.keys(item.completedState).forEach(charId => {
          const state = item.completedState[charId];
          state.currentCount = state.isCompleted ? 1 : 0;
        });
      }
    }
    
    // 규칙이 변경되었을 수 있으므로 초기화 체크 수행
    config.saveImmediate({ contentsCheckerItems: items });
    checkReset(); 
    refreshUI();
  }
}

/** 카테고리 수정 */
export function updateCategory(id: string, newCategory: string): void {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const item = items.find(i => i.id === id);
  if (item) {
    item.category = newCategory;
    config.saveImmediate({ contentsCheckerItems: items });
    refreshUI();
  }
}

/** 이름 수정 */
export function updateName(id: string, newName: string): void {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const item = items.find(i => i.id === id);
  if (item) {
    item.name = newName;
    config.saveImmediate({ contentsCheckerItems: items });
    refreshUI();
  }
}

/** 커스텀 항목 추가 */
export function addCustomItem(name: string, category: string, rule: ResetRule, maxCount?: number): void {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const newItem: ContentsCheckerItem = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`,
    name,
    category,
    isVisible: true,
    isCustom: true,
    resetRule: rule,
    completedState: {}
  };
  
  if (rule.type === 'weekly' && maxCount !== undefined) {
    newItem.maxCount = maxCount;
  }
  
  items.push(newItem);
  config.saveImmediate({ contentsCheckerItems: items });
  refreshUI();
}

/** 항목 삭제 (커스텀 전용) */
export function removeItem(id: string): void {
  const cfg = config.load();
  let items = cloneItems(cfg.contentsCheckerItems);
  items = items.filter(i => i.id !== id);
  config.saveImmediate({ contentsCheckerItems: items });
  refreshUI();
}

type MoveDirection = 'up' | 'down';
type DropPosition = 'before' | 'after';

function getMoveOffset(direction: MoveDirection): number {
  return direction === 'up' ? -1 : 1;
}

function getCategoryName(item: ContentsCheckerItem): string {
  return item.category || '기타';
}

/** 같은 초기화 유형과 카테고리 안에서 숙제 순서를 이동합니다. */
export function moveItem(id: string, direction: MoveDirection): void {
  if (direction !== 'up' && direction !== 'down') return;

  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const itemIndex = items.findIndex(item => item.id === id);
  if (itemIndex === -1) return;

  const target = items[itemIndex];
  const siblingIndices = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.resetRule.type === target.resetRule.type && getCategoryName(item) === getCategoryName(target))
    .map(({ index }) => index);
  const siblingIndex = siblingIndices.indexOf(itemIndex);
  const destinationIndex = siblingIndices[siblingIndex + getMoveOffset(direction)];
  if (destinationIndex === undefined) return;

  [items[itemIndex], items[destinationIndex]] = [items[destinationIndex], items[itemIndex]];
  config.saveImmediate({ contentsCheckerItems: items });
  refreshUI();
}

/** 같은 또는 다른 카테고리로 숙제를 드롭 위치로 이동하고 카테고리를 변경합니다. */
export function reorderItem(sourceId: string, targetId: string, position: DropPosition): void {
  if (sourceId === targetId || (position !== 'before' && position !== 'after')) return;

  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const source = items.find(item => item.id === sourceId);
  const target = items.find(item => item.id === targetId);
  if (!source || !target) return;

  const sameCategory = source.resetRule.type === target.resetRule.type && getCategoryName(source) === getCategoryName(target);

  if (sameCategory) {
    const siblingIndices = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.resetRule.type === source.resetRule.type && getCategoryName(item) === getCategoryName(source))
      .map(({ index }) => index);
    const siblings = siblingIndices.map(index => items[index]);
    const sourceIndex = siblings.findIndex(item => item.id === sourceId);
    const targetIndex = siblings.findIndex(item => item.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) return;
    const [movedItem] = siblings.splice(sourceIndex, 1);
    const adjustedTargetIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0);
    siblings.splice(adjustedTargetIndex + (position === 'after' ? 1 : 0), 0, movedItem);
    siblingIndices.forEach((itemIndex, index) => {
      items[itemIndex] = siblings[index];
    });
  } else {
    source.category = target.category;
    if (source.resetRule.type !== target.resetRule.type) {
      source.resetRule = {
        ...source.resetRule,
        type: target.resetRule.type,
        hour: target.resetRule.hour ?? source.resetRule.hour ?? 0,
        dayOfWeek: target.resetRule.dayOfWeek ?? source.resetRule.dayOfWeek ?? 1,
      };
      if (source.resetRule.type === 'weekly') {
        source.maxCount = source.maxCount || 1;
      } else {
        delete source.maxCount;
        if (source.completedState) {
          Object.keys(source.completedState).forEach(charId => {
            const state = source.completedState[charId];
            state.currentCount = state.isCompleted ? 1 : 0;
          });
        }
      }
    }
    const sourceIndex = items.findIndex(item => item.id === sourceId);
    if (sourceIndex === -1) return;
    const [movedItem] = items.splice(sourceIndex, 1);
    const targetIndex = items.findIndex(item => item.id === targetId);
    if (targetIndex === -1) {
      items.push(movedItem);
    } else {
      items.splice(targetIndex + (position === 'after' ? 1 : 0), 0, movedItem);
    }
  }

  config.saveImmediate({ contentsCheckerItems: items });
  refreshUI();
}

/** 같은 초기화 유형 안에서 카테고리 묶음의 순서를 이동합니다. */
export function moveCategory(resetType: ResetRule['type'], category: string, direction: MoveDirection): void {
  if ((resetType !== 'daily' && resetType !== 'weekly') || (direction !== 'up' && direction !== 'down')) return;

  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const typeIndices = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.resetRule.type === resetType)
    .map(({ index }) => index);
  const typeItems = typeIndices.map(index => items[index]);
  const categories = [...new Set(typeItems.map(getCategoryName))];
  const categoryIndex = categories.indexOf(category);
  const destinationCategoryIndex = categoryIndex + getMoveOffset(direction);
  if (categoryIndex === -1 || destinationCategoryIndex < 0 || destinationCategoryIndex >= categories.length) return;

  [categories[categoryIndex], categories[destinationCategoryIndex]] = [categories[destinationCategoryIndex], categories[categoryIndex]];
  const reorderedItems = categories.flatMap(categoryName => typeItems.filter(item => getCategoryName(item) === categoryName));
  typeIndices.forEach((itemIndex, index) => {
    items[itemIndex] = reorderedItems[index];
  });

  config.saveImmediate({ contentsCheckerItems: items });
  refreshUI();
}

/** 같은 초기화 유형 안에서 카테고리 묶음을 드롭 위치로 이동합니다. */
export function reorderCategory(
  resetType: ResetRule['type'],
  sourceCategory: string,
  targetCategory: string,
  position: DropPosition,
): void {
  if ((resetType !== 'daily' && resetType !== 'weekly') || sourceCategory === targetCategory || (position !== 'before' && position !== 'after')) return;

  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const typeIndices = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.resetRule.type === resetType)
    .map(({ index }) => index);
  const typeItems = typeIndices.map(index => items[index]);
  const categories = [...new Set(typeItems.map(getCategoryName))];
  const sourceIndex = categories.indexOf(sourceCategory);
  const targetIndex = categories.indexOf(targetCategory);
  if (sourceIndex === -1 || targetIndex === -1) return;

  const [movedCategory] = categories.splice(sourceIndex, 1);
  const adjustedTargetIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0);
  categories.splice(adjustedTargetIndex + (position === 'after' ? 1 : 0), 0, movedCategory);
  const reorderedItems = categories.flatMap(categoryName => typeItems.filter(item => getCategoryName(item) === categoryName));
  typeIndices.forEach((itemIndex, index) => {
    items[itemIndex] = reorderedItems[index];
  });

  config.saveImmediate({ contentsCheckerItems: items });
  refreshUI();
}

/** 특정 숙제의 완료 횟수 직접 업데이트 */
export function updateItemCount(id: string, characterId: string, count: number): void {
  const context = getItemStateContext(id, characterId);
  if (context) {
    const { cfg, items, targetCharId, item, state } = context;
    if (state.isExcluded) return;

    const max = item.maxCount || 1;
    const prevCompleted = state.isCompleted;

    state.currentCount = Math.max(0, Math.min(max, count));
    state.isCompleted = (state.currentCount === max);
    state.lastCompletedAt = state.currentCount > 0 ? Date.now() : undefined;

    config.saveImmediate({ contentsCheckerItems: items });

    syncHomeworkDiary(cfg, item, targetCharId, state, prevCompleted);

    // 전 캐릭터 통합 다이어리 통계 동기화
    syncDiaryStats(items);
    refreshUI();
  }
}

/** 주간/과거 로그 동기화 시 완료 횟수를 안전하게 병합 (Math.max) */
export function mergeHomeworkCountFromSync(id: string, detectedCount: number, characterId?: string): boolean {
  const cfg = config.load();
  const presets = clonePresets(cfg.characterPresets);
  const targetCharId = characterId || presets[0]?.id || cfg.selectedCharacterId || MAIN_CHAR_ID;

  const context = getItemStateContext(id, targetCharId);
  if (!context) return false;

  const { items, item, state } = context;
  if (state.isExcluded || item.isVisible === false) return false;

  const max = item.maxCount || 1;
  const current = state.currentCount || 0;
  const targetCount = Math.max(0, Math.min(max, detectedCount));

  if (targetCount > current) {
    const prevCompleted = state.isCompleted;
    state.currentCount = targetCount;
    state.isCompleted = (state.currentCount === max);
    state.lastCompletedAt = Date.now();

    config.saveImmediate({ contentsCheckerItems: items });
    syncHomeworkDiary(cfg, item, targetCharId, state, prevCompleted);
    syncDiaryStats(items);
    refreshUI();
    return true;
  }
  return false;
}

/** 특정 숙제의 완료 횟수 증감 (채팅 로그 등 외부 연동용) */
export function incrementItemCount(id: string, characterId: string, amount: number = 1): void {
  const cfg = config.load();
  const items = cloneItems(cfg.contentsCheckerItems);
  const targetCharId = characterId || cfg.selectedCharacterId || MAIN_CHAR_ID;
  
  const item = items.find(i => i.id === id);
  if (item) {
    const current = item.completedState?.[targetCharId]?.currentCount || 0;
    updateItemCount(id, targetCharId, current + amount);
  }
}

/** 채팅 로그 감지 시 캐릭터 개수에 따라 즉시 반영 또는 보류 대기열 추가 */
export function queuePendingHomework(id: string, count: number, isIncrement: boolean): void {
  const cfg = config.load();
  const presets = clonePresets(cfg.characterPresets);

  log(`[Contents Checker] queuePendingHomework 호출 - ID: ${id}, Count: ${count}, isIncrement: ${isIncrement}`);

  const items = cloneItems(cfg.contentsCheckerItems);
  const targetItem = items.find(i => i.id === id);

  // 1. 해당 숙제가 존재하지 않거나 숨김 처리(isVisible: false)된 경우 감지 및 보류 대기열 추가 무시
  if (!targetItem || targetItem.isVisible === false) {
    log(`[Contents Checker] 감지된 숙제(${id})가 숨김 상태이거나 존재하지 않아 적립을 무시합니다.`);
    return;
  }

  // 2. 등록된 캐릭터 중 해당 숙제에 참여하는(isExcluded: false) 캐릭터 목록 추출
  const activeCharacters = presets.filter(char => {
    const state = targetItem.completedState?.[char.id];
    return !state?.isExcluded;
  });

  if (activeCharacters.length === 0) {
    log(`[Contents Checker] 모든 캐릭터가 이 숙제(${id})에 참여하지 않도록 설정되어 있어 적립을 무시합니다.`);
    return;
  }

  // 3. 이 숙제에 참여하는 캐릭터가 오직 1명이면 보류 대기열 없이 즉시 해당 캐릭터에 안전하게 반영
  if (activeCharacters.length === 1) {
    const targetCharId = activeCharacters[0].id;
    log(`[Contents Checker] 단일 참여 캐릭터 감지 - '${activeCharacters[0].name}' (${targetCharId})에게 즉시 반영`);
    if (isIncrement) {
      incrementItemCount(id, targetCharId, count);
    } else {
      updateItemCount(id, targetCharId, count);
    }
    return;
  }

  // 4. 참여 가능한 캐릭터가 2개 이상일 때는 사용자가 선택할 수 있도록 보류 대기열에 추가
  const pendingList: PendingHomework[] = cfg.pendingHomeworks || [];
  const existingIdx = pendingList.findIndex(p => p.id === id);

  if (existingIdx !== -1) {
    const existing = pendingList[existingIdx];
    if (isIncrement) {
      existing.count += count;
      existing.isIncrement = true;
    } else {
      // 절대값 설정 이벤트가 오면 절대값 모드로 전환
      existing.count = Math.max(existing.count, count);
      existing.isIncrement = false;
    }
    existing.timestamp = Date.now();
    log(`[Contents Checker] 보류 대기열 병합 업데이트 - ID: ${id}, 새 보류수량: ${existing.count}`);
  } else {
    pendingList.push({
      id,
      count,
      isIncrement,
      timestamp: Date.now()
    });
    log(`[Contents Checker] 보류 대기열 신규 추가 - ID: ${id}, 수량: ${count}`);
  }

  config.saveImmediate({ pendingHomeworks: pendingList });
  refreshUI();
}

/** 보류 대기열의 내역을 특정 캐릭터에 반영 */
export function applyPendingHomeworks(characterId: string): void {
  const cfg = config.load();
  const pendingList = clonePending(cfg.pendingHomeworks);
  if (pendingList.length === 0) return;

  const items = cloneItems(cfg.contentsCheckerItems);
  const now = new Date();
  const appliedPendingIds = new Set<string>();

  log(`[Contents Checker] 보류 내역을 캐릭터(${characterId})에 일괄 반영 시작. 보류 건수: ${pendingList.length}`);

  pendingList.forEach(pending => {
    const item = items.find(i => i.id === pending.id);
    if (!item) return;

    if (!item.completedState) item.completedState = {};
    if (!item.completedState[characterId]) {
      item.completedState[characterId] = { isCompleted: false, currentCount: 0 };
    }

    const state = item.completedState[characterId];
    if (state.isExcluded) {
      log(`[Contents Checker] 캐릭터(${characterId})가 숙제(${item.name})에서 제외 상태(N/A)이므로 이력 반영을 생략하고 대기열을 유지합니다.`);
      return;
    }

    const max = item.maxCount || 1;
    const current = state.currentCount || 0;
    const prevCompleted = state.isCompleted;

    let targetCount = current;
    if (pending.isIncrement) {
      targetCount = current + pending.count;
    } else {
      targetCount = pending.count;
    }

    // 범위 보정 (최대 완료 횟수 제한 적용)
    state.currentCount = Math.max(0, Math.min(max, targetCount));
    state.isCompleted = (state.currentCount === max);
    state.lastCompletedAt = state.currentCount > 0 ? Date.now() : undefined;

    appliedPendingIds.add(pending.id);
    log(`[Contents Checker] 반영 완료 - 숙제: ${item.name}, 카운트: ${current} -> ${state.currentCount} (${state.isCompleted ? '완료' : '진행중'})`);

    syncHomeworkDiary(cfg, item, characterId, state, prevCompleted);
  });

  // 반영되지 못한 항목(N/A 제외 캐릭터 선택 등) 중, 리셋 주기가 지나지 않은 유효 항목만 보존
  const remainingPending = pendingList.filter(pending => {
    if (appliedPendingIds.has(pending.id)) return false;
    const item = items.find(i => i.id === pending.id);
    if (!item) return false;
    // 보류 항목 발생 시점 기준 리셋 경과 여부 확인
    const pendingTime = pending.timestamp ? new Date(pending.timestamp) : new Date(0);
    return !shouldReset(item.resetRule, pendingTime, now);
  });

  // 대기열 저장
  config.saveImmediate({
    contentsCheckerItems: items,
    pendingHomeworks: remainingPending
  });

  // 다이어리 동기화 및 UI 갱신
  syncDiaryStats(items);
  refreshUI();
  log(`[Contents Checker] 보류 내역 반영 완료 (남은 보류 건수: ${remainingPending.length})`);
}

/** 보류 대기열 초기화 (적용 없이 취소) */
export function clearPendingHomeworks(): void {
  log(`[Contents Checker] 보류 대기열 초기화 호출 (삭제)`);
  config.saveImmediate({ pendingHomeworks: [] });
  refreshUI();
}

