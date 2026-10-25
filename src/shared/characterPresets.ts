/**
 * 테일즈위버 19종 캐릭터 프리셋 정보 및 프로필 아바타 헬퍼
 */

export interface CharacterPreset {
  id: string;
  name: string;
  avatar: string;
}

export const DEFAULT_CHARACTER_PRESETS: readonly CharacterPreset[] = [
  { id: 'lucian', name: '루시안', avatar: 'assets/img/characters/lucian.png' },
  { id: 'boris', name: '보리스', avatar: 'assets/img/characters/boris.png' },
  { id: 'maximin', name: '막시민', avatar: 'assets/img/characters/maximin.png' },
  { id: 'sibalmin', name: '시벨린', avatar: 'assets/img/characters/sibalmin.png' },
  { id: 'tichiel', name: '티치엘', avatar: 'assets/img/characters/tichiel.png' },
  { id: 'milla', name: '밀라', avatar: 'assets/img/characters/milla.png' },
  { id: 'ispin', name: '이스핀', avatar: 'assets/img/characters/ispin.png' },
  { id: 'nayana', name: '나야트레이', avatar: 'assets/img/characters/nayana.png' },
  { id: 'joshua', name: '조슈아', avatar: 'assets/img/characters/joshua.png' },
  { id: 'cloe', name: '클로에', avatar: 'assets/img/characters/cloe.png' },
  { id: 'ranzie', name: '란지에', avatar: 'assets/img/characters/ranzie.png' },
  { id: 'issac', name: '이자크', avatar: 'assets/img/characters/issac.png' },
  { id: 'anarrose', name: '아나이스', avatar: 'assets/img/characters/anarrose.png' },
  { id: 'iseol', name: '이솔렛', avatar: 'assets/img/characters/iseol.png' },
  { id: 'benya', name: '벤야', avatar: 'assets/img/characters/benya.png' },
  { id: 'roamini', name: '로아미니', avatar: 'assets/img/characters/roamini.png' },
  { id: 'nocturn', name: '녹턴', avatar: 'assets/img/characters/nocturn.png' },
  { id: 'reche', name: '리체', avatar: 'assets/img/characters/reche.png' },
  { id: 'yvnen', name: '예프넨', avatar: 'assets/img/characters/yvnen.png' },
] as const;

/**
 * 프로필 메타데이터의 avatarUrl(preset:xxx, data:xxx, http:xxx 등)을
 * 화면에서 바로 로드할 수 있는 상대/절대 이미지 URL로 해석합니다.
 */
export function resolveProfileAvatarUrl(avatarUrl?: string | null): string {
  if (!avatarUrl) {
    return 'assets/img/characters/boris.png';
  }
  if (
    avatarUrl.startsWith('data:') ||
    avatarUrl.startsWith('http://') ||
    avatarUrl.startsWith('https://') ||
    avatarUrl.startsWith('file://')
  ) {
    return avatarUrl;
  }
  if (avatarUrl.startsWith('preset:')) {
    const presetId = avatarUrl.replace('preset:', '');
    const found = DEFAULT_CHARACTER_PRESETS.find(p => p.id === presetId);
    return found ? found.avatar : `assets/img/characters/${presetId}.png`;
  }
  // 단순 id 문자열이거나 assets/ 경로인 경우
  if (avatarUrl.startsWith('assets/')) {
    return avatarUrl;
  }
  const found = DEFAULT_CHARACTER_PRESETS.find(p => p.id === avatarUrl);
  if (found) {
    return found.avatar;
  }
  return `assets/img/characters/${avatarUrl}.png`;
}
