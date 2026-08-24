import type { AppConfig, IncompleteContentItem } from '../shared/types';
import { DEFAULT_CHAR_NAME, MAIN_CHAR_ID } from '../shared/types';

/** 종료 알림에 표시할 캐릭터별 미완료 숙제 목록을 계산합니다. */
export function collectIncompleteContents(config: AppConfig): IncompleteContentItem[] {
  const presets = config.characterPresets || [{ id: MAIN_CHAR_ID, name: DEFAULT_CHAR_NAME }];
  const items = config.contentsCheckerItems || [];
  const incompleteItems: IncompleteContentItem[] = [];

  for (const character of presets) {
    for (const item of items) {
      const state = item.completedState?.[character.id];
      if (item.isVisible !== false && !state?.isExcluded && !state?.isCompleted) {
        incompleteItems.push({
          charName: character.name,
          name: item.name,
          category: item.category,
          type: item.resetRule.type,
        });
      }
    }
  }

  return incompleteItems;
}
