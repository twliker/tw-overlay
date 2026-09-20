import type { NicknameInfo } from './types';

// tw-overlay-data/scraper.js의 CharacterCodeByName 인코딩과 일치한다.
const CHARACTER_NAMES = ['루시안', '보리스', '막시민', '시벨린', '조슈아', '란지에', '이자크', '밀라', '티치엘', '이스핀', '나야트레이', '아나이스', '클로에', '벤야', '이솔렛', '로아미니', '녹턴', '리체', '예프넨'];

export function describeNicknameInfo(rank: { level: number; characterCode: number } | null | undefined, collectDate: string | undefined, fresh: boolean): NicknameInfo {
  return {
    level: rank && Number.isFinite(rank.level) && rank.level >= 0 ? rank.level : null,
    characterName: rank && Number.isInteger(rank.characterCode) ? CHARACTER_NAMES[rank.characterCode] ?? null : null,
    collectDate: collectDate || null,
    stale: !fresh,
  };
}
