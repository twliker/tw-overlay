interface ChatConstants {
  LEGACY_NPC_SENDER_BLACKLIST: readonly string[];
  NPC_SENDER_BLACKLIST: readonly string[];
  isLegacyNpcSender(sender: string): boolean;
  isNpcSender(sender: string): boolean;
  isNpcDialogueSender(sender: string): boolean;
  isNpcChat(chat: Pick<import('./types').ChatItem, 'type' | 'sender' | 'message'>): boolean;
}

interface Window {
  chatConstants: ChatConstants;
}

(function exposeChatConstants(globalObject: Window | null): void {
  const LEGACY_NPC_SENDER_BLACKLIST = Object.freeze([
    '데스포이나', '신조', '키시니크', '에레오스', '로카고스',
    '마티아', '티로로스', '라이코스', '체리아', '실반',
    '샐리온', '실라이론', '샐레아나', '루미너스',
  ]);

  const NPC_SENDER_BLACKLIST = Object.freeze([
    ...LEGACY_NPC_SENDER_BLACKLIST,
    '크라모르',
  ]);

  /** NPC 숨김/배지 생략/줄 연결이 공유하는 발신자 판별 계약.
   * 2026-09-05~21 원본 로그에서 확인한 이름만 추가한다. 공백이나 콜론은 NPC의 증거가 아니다.
   * '남은 공격 횟수', '피버 효과', '봉인 결계' 같은 진행·상태 안내와 미확인 발신자는 보존한다.
   * 일반 사용자 대화의 NPC 이름 인용은 판별하지 않는다. 신규 이름은 원본 fixture와 함께 추가한다.
   */
  const dialogueSenders = new Set([
    ...NPC_SENDER_BLACKLIST,
    '운명의 심판자, 노아', '회랑의 파수꾼, 가고일', '양면의 군주, 야누아르', '회랑의 거목, 에테르',
    '수르트의 분신', '심연의 제2사도', '검의 사제, 셀리니아코스', '지팡이의 사제, 고이티아',
    '궤의 사제, 프로에드로스', '근위 부대장', '고문관 크로우', '원소의 정령', '유마 프레키', '유마 올름',
    '선봉대장, 로카고스', '수색대장, 에토스', '소매의 사제, 체리아', '서클릿의 사제, 마티아',
    '흉포한 라이코스', '메달의 사제, 티로로스', '경보 장치', '녹색 프토마', '푸른 프토마',
    '붉은 프토마', '회색 프토마', '정원사 기미르', '수상한 거지', '슬픔의 무희, 오페리아',
    '회랑의 잔재, 루이나스', '수액 괴물', '쉐프 레오', '과학자 이발디', '말랑 핑크빈',
  ]);
  const isNpcDialogueSender = (sender: string) => dialogueSenders.has(sender.trim());
  function isNpcChat(chat: Pick<import('./types').ChatItem, 'type' | 'sender' | 'message'>): boolean {
    if (NPC_SENDER_BLACKLIST.includes(chat.sender)) return true;
    if (chat.type !== 'system') return false;
    const match = chat.message.match(/^(.+?)\s*:\s*/);
    return !!match && isNpcDialogueSender(match[1]);
  }

  const chatConstants: ChatConstants = Object.freeze({
    LEGACY_NPC_SENDER_BLACKLIST,
    NPC_SENDER_BLACKLIST,
    isLegacyNpcSender: (sender: string) => LEGACY_NPC_SENDER_BLACKLIST.includes(sender),
    isNpcSender: (sender: string) => NPC_SENDER_BLACKLIST.includes(sender),
    isNpcDialogueSender,
    isNpcChat,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = chatConstants;
  }
  if (globalObject) {
    globalObject.chatConstants = chatConstants;
  }
})(typeof window !== 'undefined' ? window : null);
