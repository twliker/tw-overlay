interface ChatConstants {
  LEGACY_NPC_SENDER_BLACKLIST: readonly string[];
  NPC_SENDER_BLACKLIST: readonly string[];
  isLegacyNpcSender(sender: string): boolean;
  isNpcSender(sender: string): boolean;
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

  const chatConstants: ChatConstants = Object.freeze({
    LEGACY_NPC_SENDER_BLACKLIST,
    NPC_SENDER_BLACKLIST,
    isLegacyNpcSender: (sender: string) => LEGACY_NPC_SENDER_BLACKLIST.includes(sender),
    isNpcSender: (sender: string) => NPC_SENDER_BLACKLIST.includes(sender),
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = chatConstants;
  }
  if (globalObject) {
    globalObject.chatConstants = chatConstants;
  }
})(typeof window !== 'undefined' ? window : null);
