/** 앱 소유 로컬 도구 데이터만 백업한다. 외부 웹사이트·세션·인증 저장소는 포함하지 않는다. */
export const RENDERER_STORAGE_FILE = 'renderer-storage.json';
export const RENDERER_STORAGE_KEYS = [
  'buff_presets', 'buff_current_selection', 'buff_active_preset_id',
  'tw-coefficient-calculator-profiles-v1', 'tw-coefficient-calculator-profiles-v1_last',
  'tw-coefficient-calculator-settings-v7final',
  'tw-overlay:evolution-history:v1', 'tw-overlay:evolution-draft:v1',
  'tw-overlay:qte-challenge:v1', 'tw-overlay:diary-loot-summary-height:v1', 'evo_elso_enabled',
  'hps-arrows-enabled', 'hps-loop-enabled', 'hps-overlay-opacity', 'hps-overlay-scale', 'hps-path-color',
  'tc_box_price', 'tc_box_qty', 'tc_currency', 'tc_discount', 'tc_from', 'tc_qty', 'tc_region', 'tc_stat_type', 'tc_to',
] as const;
export const RENDERER_STORAGE_PREFIXES = ['evo_price_'] as const;
export interface RendererStorageSnapshot { schemaVersion: 1; values: Record<string, string> }

export function validateRendererStorageSnapshot(value: unknown): RendererStorageSnapshot {
  const snapshot = value as RendererStorageSnapshot | null;
  if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.values
    || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values)
    || Object.keys(snapshot.values).length > 10_000
    || JSON.stringify(snapshot).length > 20 * 1024 * 1024) throw new Error('도구 저장소 백업 형식이 올바르지 않습니다.');
  for (const [key, stored] of Object.entries(snapshot.values)) {
    if (key.length > 1_000 || typeof stored !== 'string'
      || (!RENDERER_STORAGE_KEYS.some(allowed => allowed === key)
        && !RENDERER_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix)))) {
      throw new Error(`백업이 지원하지 않는 도구 저장소 키입니다: ${key}`);
    }
  }
  return snapshot;
}
