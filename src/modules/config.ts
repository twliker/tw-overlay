/**
 * 설정 관리 모듈 - 로드/저장/디바운스 + 메모리 캐시
 */
import * as fs from 'fs';
import { get_CONFIG_PATH, DEFAULT_CONFIG, SAVE_DEBOUNCE_MS, AppConfig, get_RESOURCE_PATH } from './constants';
import { log } from './logger';
import type { WindowPositionKey } from '../shared/types';

let _saveTimer: NodeJS.Timeout | null = null;
let _pendingConfig: AppConfig | null = null;
/** 메모리 캐시: 디스크 I/O를 최소화하기 위해 로드된 설정을 캐싱 */
let _cachedConfig: AppConfig | null = null;
let _loadWarning: string | null = null;
const _storedPositionKeys = new Set<WindowPositionKey>();

type ConfigChangeListener = (changedConfig: Partial<AppConfig>) => void;
const _changeListeners: ConfigChangeListener[] = [];

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
      listener(changedConfig);
    } catch (err) {
      log(`[CONFIG] 리스너 호출 에러: ${err}`);
    }
  }
}

/** 설정 파일 로드 (메모리 캐시 우선, 없으면 디스크 읽기) */
export function load(): AppConfig {
  if (_cachedConfig) return { ..._cachedConfig };
  try {
    const configPath = get_CONFIG_PATH();
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<AppConfig>;
      const storedPositionKeys = parsed.storedPositionKeys || Object.entries(parsed.positions || {})
        .filter(([key, position]) => {
          const defaultPosition = DEFAULT_CONFIG.positions?.[key as WindowPositionKey];
          return !defaultPosition
            || position?.offsetX !== defaultPosition.offsetX
            || position?.offsetY !== defaultPosition.offsetY;
        })
        .map(([key]) => key as WindowPositionKey);
      storedPositionKeys.forEach(key => _storedPositionKeys.add(key));

      let migrated = false;
      if (parsed.galleryNotify === undefined) {
        parsed.galleryNotify = true;
        migrated = true;
      }
      if (parsed.opacity !== undefined && parsed.opacity < 0.2) {
        parsed.opacity = 0.2;
        migrated = true;
      }
      if (parsed.chatOverlayOpacity !== undefined && parsed.chatOverlayOpacity < 0.2) {
        parsed.chatOverlayOpacity = 0.2;
        migrated = true;
      }
      if (parsed.chatOverlaySubOpacity !== undefined && parsed.chatOverlaySubOpacity < 0.2) {
        parsed.chatOverlaySubOpacity = 0.2;
        migrated = true;
      }
      if (parsed.chatOverlaySub2Opacity !== undefined && parsed.chatOverlaySub2Opacity < 0.2) {
        parsed.chatOverlaySub2Opacity = 0.2;
        migrated = true;
      }
      // 구형 필드는 기존 렌더러에서 새 필드보다 우선했으므로 해당 값을 보존해 한 번만 이전합니다.
      if (parsed.questHudPos) {
        parsed.forgeQuestHudPos = { ...parsed.questHudPos };
        delete parsed.questHudPos;
        migrated = true;
      }
      // 오늘의 요약 HUD 위치가 기존 기본값(200, 105 / 200, 71)이거나 구형 bottom 좌표계인 경우 새 기본값(0, 200)으로 자동 마이그레이션합니다.
      if (
        parsed.todaySummaryHudPos &&
        (typeof parsed.todaySummaryHudPos.top !== 'number'
          || (parsed.todaySummaryHudPos.left === 200 && (parsed.todaySummaryHudPos.bottom === 105 || parsed.todaySummaryHudPos.bottom === 71)))
      ) {
        parsed.todaySummaryHudPos = { ...(DEFAULT_CONFIG.todaySummaryHudPos || { left: 0, top: 200 }) };
        migrated = true;
      }
      // 득템 키워드 2차 마이그레이션 (기존 데이터를 74종 기본값으로 강제 덮어쓰기)
      if (parsed.lootKeywordsMigratedV2 !== true) {
        try {
          const defaultJsonPath = get_RESOURCE_PATH('assets', 'data', 'contents_items_default.json');
          if (fs.existsSync(defaultJsonPath)) {
            const defaultItems = JSON.parse(fs.readFileSync(defaultJsonPath, 'utf-8'));
            parsed.lootKeywords = defaultItems.map((item: any) => item.name);
            parsed.lootKeywordsMigratedV2 = true;
            migrated = true;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`[CONFIG] 득템 키워드 마이그레이션 실패: ${errMsg}`);
        }
      }
      // 퀵슬롯 2차 마이그레이션 (기존 유저에게 TW DB 링크 1회 자동 추가)
      if (parsed.quickSlotsMigratedV2 !== true) {
        if (Array.isArray(parsed.quickSlots)) {
          const hasTwDb = parsed.quickSlots.some(s => s && s.url && s.url.includes('twhome-git.github.io/TWPage'));
          if (!hasTwDb) {
            parsed.quickSlots.push({
              label: "TW DB",
              icon: "database",
              url: "https://twhome-git.github.io/TWPage/",
              external: true,
              iconType: "icon"
            });
          }
        }
        parsed.quickSlotsMigratedV2 = true;
        migrated = true;
      }

      _cachedConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        storedPositionKeys: [..._storedPositionKeys],
        positions: { ...DEFAULT_CONFIG.positions, ...(parsed.positions || {}) },
        shortcuts: { ...DEFAULT_CONFIG.shortcuts, ...(parsed.shortcuts || {}) },
        fieldBossSettings: { ...DEFAULT_CONFIG.fieldBossSettings, ...(parsed.fieldBossSettings || {}) },
        buffTimerBuffs: { ...DEFAULT_CONFIG.buffTimerBuffs, ...(parsed.buffTimerBuffs || {}) },
      } as AppConfig;

      if (migrated) {
        log('[CONFIG] 설정 마이그레이션 적용');
        try {
          fs.writeFileSync(configPath, JSON.stringify(_cachedConfig, null, 2));
        } catch (saveErr) {
          const saveErrMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
          log(`[CONFIG] 마이그레이션 후 파일 쓰기 실패: ${saveErrMsg}`);
        }
      }

      return { ..._cachedConfig };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[CONFIG] 설정 로드 실패: ${msg}`);
    try {
      const configPath = get_CONFIG_PATH();
      if (fs.existsSync(configPath)) {
        const suffix = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${configPath}.corrupt-${suffix}`;
        fs.copyFileSync(configPath, backupPath);
        _loadWarning = `설정 파일을 읽지 못해 기본 설정으로 시작했습니다. 손상된 원본은 다음 위치에 보존했습니다.\n${backupPath}`;
        log(`[CONFIG] 손상된 설정 원본 보존: ${backupPath}`);
      }
    } catch (backupError) {
      const backupMessage = backupError instanceof Error ? backupError.message : String(backupError);
      _loadWarning = '설정 파일을 읽지 못해 기본 설정으로 시작했으며, 손상된 원본 백업에도 실패했습니다.';
      log(`[CONFIG] 손상된 설정 원본 백업 실패: ${backupMessage}`);
    }
  }
  _cachedConfig = { ...DEFAULT_CONFIG };
  return { ..._cachedConfig };
}

/** 디바운스 저장 - move/resize 등 빈번한 이벤트에 사용 */
export function save(newConfig: Partial<AppConfig>): void {
  try {
    if (!_pendingConfig) _pendingConfig = load();
    _pendingConfig = { ..._pendingConfig, ...newConfig, storedPositionKeys: [..._storedPositionKeys] };
    // 메모리 캐시도 즉시 업데이트 (디스크 쓰기 전에도 최신 상태 반영)
    _cachedConfig = { ..._pendingConfig };
    notifyConfigChange(newConfig);
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      try {
        if (_pendingConfig) {
          fs.writeFileSync(get_CONFIG_PATH(), JSON.stringify(_pendingConfig, null, 2));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[CONFIG] 디바운스 저장 실패: ${msg}`);
      }
      _pendingConfig = null;
      _saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[CONFIG] 저장 준비 실패: ${msg}`);
  }
}

/** 즉시 저장 - 앱 종료 시 사용 */
export function saveImmediate(newConfig: Partial<AppConfig> = {}): void {
  try {
    if (_saveTimer) clearTimeout(_saveTimer);
    const current = _pendingConfig || load();
    const merged = { ...current, ...newConfig, storedPositionKeys: [..._storedPositionKeys] };
    fs.writeFileSync(get_CONFIG_PATH(), JSON.stringify(merged, null, 2));
    _cachedConfig = merged;
    _pendingConfig = null;
    _saveTimer = null;
    notifyConfigChange(newConfig);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[CONFIG] 즉시 저장 실패: ${msg}`);
  }
}

/** 미저장 데이터 존재 여부 */
export function hasPending(): boolean {
  return _pendingConfig !== null;
}

/** 기본값 병합과 무관하게 사용자가 실제로 저장한 창 위치인지 확인합니다. */
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
