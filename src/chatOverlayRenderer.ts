// Electron API type definition
interface Window {
  electronAPI: {
    toggleChatOverlay: () => void;
    toggleChatOverlaySub: (subNum: 1 | 2) => void;
    getChatHistory: (category: string) => Promise<BrowserChatItem[]>;
    getFocusedChatHistory: () => Promise<BrowserChatItem[]>;
    getFocusedChatState: () => Promise<BrowserFocusedChatState>;
    setFocusedChatSelfNickname: (nickname: string) => void;
    setFocusedChatTargets: (nicknames: string[]) => void;
    setFocusedChatSize: (width: number, height: number) => void;
    getMoreChatHistory: (category: string) => Promise<BrowserChatItem[]>;
    searchChatLogs: (
      query: string,
      options?: { category?: string; limit?: number }
    ) => Promise<BrowserChatItem[]>;
    getConfig: () => Promise<BrowserAppConfig>;
    openTodayLog: () => void;
    fetchEtaRankings: () => Promise<boolean>;
    onChatUpdated: (callback: (chatItem: BrowserChatItem) => void) => void;
    onChatHistoryCleared: (callback: () => void) => void;
    onConfigData: (callback: (config: BrowserAppConfig) => void) => void;
    onChatOverlayMode: (callback: (mode: 'main' | 'sub1' | 'sub2') => void) => void;
    cleanupAllListeners: () => void;
    setChatOverlaySize: (mode: 'main' | 'sub1' | 'sub2', width: number, height: number) => void;
    applySettings: (settings: Partial<BrowserAppConfig>) => void;
    toggleSettings: (tabId?: string) => void;
    triggerFireworkGlobal?: () => void;
  };
}

const FIREWORK_NICKNAMES_SET = new Set<string>([
  '전기세비싸', '오화싸개', '모시떡',
  '딸기가좋아요', '스피들리', '곰돌이아빠', '주말쉬는시간', '뿌잉뿌잉🖤', '폭스', '만만이',
  '홍', '핑크돌고래핵펀', '비둘기오락실', '빅쭈쭈', '딱닥', '빵특', '코선인',
  '응꼬개통식', '정지우', '따몽', '귀여운하루나기', '크힛이', '거리유지', 'YounHaHolic˚',
  '아아'
]);

const chatViewRequests = window.createViewRequestGeneration();
type ChatViewRequestToken = ReturnType<ViewRequestGeneration['begin']>;
let activeChatViewRequest: ChatViewRequestToken | null = null;
let paginationGeneration = 0;
let isChatViewLoading = false;

function beginChatViewRequest(key: string): ChatViewRequestToken {
  paginationGeneration += 1;
  isLoadingMore = false;
  isChatViewLoading = true;
  const request = chatViewRequests.begin(key);
  activeChatViewRequest = request;
  return request;
}

// NPC/몬스터 대사 여부 판별 함수
function isNpcOrMonsterChat(chat: BrowserChatItem): boolean {
  if (!chat) return false;
  const sender = chat.sender || '';
  const message = chat.message || '';
  
  // 1. 보낸 사람이 NPC인 경우
  if (window.chatConstants.isNpcSender(sender)) return true;
  
  // 2. 시스템 메시지 내에서 "NPC이름 : 대사" 형태인 경우
  if (chat.type === 'system') {
    const match = message.match(/^(.+?)\s*:\s*(.*)$/);
    if (match) {
      const parsedSender = match[1].trim();
      if (window.chatConstants.isNpcSender(parsedSender)) return true;
      // 공백이 있는 이름은 보통 NPC/몬스터 (예: "심연의 제2사도", "수색대장, 에토스")
      if (parsedSender.includes(' ') && !parsedSender.includes(']') && !parsedSender.includes('[')) {
        return true;
      }
    }
  }
  return false;
}

function isElsoGainMessage(msg: string): boolean {
  if (!msg) return false;
  return /\[엘소\s*[\d,]+포인트\]/i.test(msg) ||
         /\[엘소\s*스크롤\s*\([\d,]+\s*포인트\)\]/i.test(msg) ||
         /루미나의\s*회랑\s*ELSO\s*획득량\s*증가\s*효과로/i.test(msg) ||
         /\[[\d,]+\]\s*ELSO를\s*습득했습니다/i.test(msg) ||
         /ELSO\s*포인트를\s*추가로\s*획득/i.test(msg);
}

function isXpGainMessage(msg: string): boolean {
  if (!msg) return false;
  return /경험치가\s+([\[\]\d,억만\s]+)\s*(올랐|상승)/.test(msg);
}

// 오버레이 노출 조건 판별 함수
function shouldShowChat(chat: BrowserChatItem): boolean {
  if (!chat) return false;

  // 1. NPC/몬스터 대사 필터 적용
  const showNpcChat = chatOverlayAppConfig?.chatOverlayShowNpcChat !== false;
  if (!showNpcChat && isNpcOrMonsterChat(chat)) {
    return false;
  }

  // 2. 블랙리스트 필터 적용 (설정된 제외 문구/정규식이 메시지에 일치하면 숨김)
  const blacklist = chatOverlayAppConfig?.chatOverlayBlacklistFilters;
  if (blacklist && blacklist.length > 0 && chat.message) {
    const isFiltered = window.chatChannels && typeof window.chatChannels.isMessageBlacklisted === 'function'
      ? window.chatChannels.isMessageBlacklisted(chat.message, blacklist)
      : blacklist.some(f => f && f.trim().length > 0 && chat.message.includes(f.trim()));
    if (isFiltered) {
      return false;
    }
  }

  // 3. 엘소/경험치 표시 옵션 검사 (통합, 시스템, 커스텀 탭 전체 공통 적용)
  if (chatOverlayAppConfig?.chatOverlayShowElsoGain === false && isElsoGainMessage(chat.message)) {
    return false;
  }
  if (chatOverlayAppConfig?.chatOverlayShowXpGain === false && isXpGainMessage(chat.message)) {
    return false;
  }

  // 4. 채널별 / 커스텀 탭별 필터 적용
  if (chatOverlayCurrentTab === 'Basic') {
    const channels = chatOverlayAppConfig?.chatOverlaySelectedChannels || window.chatChannels.OVERLAY_CHANNELS;
    return channels.includes(chat.type);
  } else if (tabTypeMap[chatOverlayCurrentTab]) {
    const expectedType = tabTypeMap[chatOverlayCurrentTab];
    return chat.type === expectedType;
  } else {
    // 커스텀 탭 (ID: custom_xxx 또는 탭 이름)
    const customTabs = chatOverlayAppConfig?.chatOverlayCustomTabs || [];
    const customTab = customTabs.find(t => t.id === chatOverlayCurrentTab || t.name === chatOverlayCurrentTab || t.name.toLowerCase() === chatOverlayCurrentTab.toLowerCase());
    if (customTab && Array.isArray(customTab.channels)) {
      if (!customTab.channels.includes(chat.type)) return false;
      // 커스텀 탭에 지정된 시스템 색상 필터 검사
      if (chat.type === 'system' && Array.isArray(customTab.systemColorFilters) && customTab.systemColorFilters.length > 0 && window.chatChannels && typeof window.chatChannels.getSystemColorGroup === 'function') {
        const group = window.chatChannels.getSystemColorGroup(chat.color);
        if (!customTab.systemColorFilters.includes(group)) {
          return false;
        }
      }
      return true;
    }
    return true;
  }
}

let chatOverlayCurrentTab = 'Basic';
let chatOverlayHoverTimer: ReturnType<typeof setTimeout> | null = null;
let chatOverlayAppConfig: BrowserAppConfig | null = null;
let lastKnownConfig: BrowserAppConfig | null = null;
let isLoadingMore = false;
let hasReachedEnd = false;
let chatOverlayMode: 'main' | 'sub1' | 'sub2' = 'main';
let isInitialTabLoaded = false;
let isModeReceived = false;
let isConfigReceived = false;

// Config 정보와 Mode 정보가 모두 수신된 안전한 시점에 단 한 번만 초기 탭을 로드합니다.
function checkAndLoadInitialTab() {
  if (isInitialTabLoaded || !isModeReceived || !isConfigReceived || !chatOverlayAppConfig) return;
  isInitialTabLoaded = true;

  const savedTab = chatOverlayMode === 'main'
    ? (chatOverlayAppConfig.chatOverlayTab || 'Basic')
    : (chatOverlayMode === 'sub1' ? (chatOverlayAppConfig.chatOverlaySubTab || 'Basic') : (chatOverlayAppConfig.chatOverlaySub2Tab || 'Basic'));

  selectTab(savedTab, false);
}

const btnOpenSub1 = document.getElementById('btnOpenSub1') as HTMLButtonElement;
const btnOpenSub2 = document.getElementById('btnOpenSub2') as HTMLButtonElement;
const btnOpenLog = document.getElementById('btnOpenLog') as HTMLButtonElement;
const btnToggleSearch = document.getElementById('btnToggleSearch') as HTMLButtonElement;
const btnSettings = document.getElementById('btnSettings') as HTMLButtonElement;

// HTML Elements
const overlayPanel = document.getElementById('overlayPanel') as HTMLDivElement;
const dragHeader = document.getElementById('dragHeader') as HTMLDivElement;
const tabsBar = document.getElementById('tabsBar') as HTMLDivElement;
const chatArea = document.getElementById('chatArea') as HTMLDivElement;
const copyToast = document.getElementById('copyToast') as HTMLDivElement;
const resizeHandle = document.getElementById('resizeHandle') as HTMLDivElement;

// Search Elements
const searchContainer = document.getElementById('searchContainer') as HTMLDivElement;
const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const btnClearSearchInput = document.getElementById('btnClearSearchInput') as HTMLButtonElement;
const btnExecuteSearch = document.getElementById('btnExecuteSearch') as HTMLButtonElement;
const btnCloseSearch = document.getElementById('btnCloseSearch') as HTMLButtonElement;
const searchStatusBar = document.getElementById('searchStatusBar') as HTMLDivElement;
const searchResultText = document.getElementById('searchResultText') as HTMLSpanElement;
const btnExitSearchMode = document.getElementById('btnExitSearchMode') as HTMLButtonElement;

// Tab mapping (UI tab -> chat.type)
const tabTypeMap: Record<string, string> = {
  'General': 'general',
  'Team': 'team',
  'Club': 'club',
  'Shout': 'shout',
  'Whisper': 'whisper',
  'System': 'system'
};

function renderCustomTabs() {
  if (!tabsBar) return;
  // 기존 커스텀 탭 제거
  tabsBar.querySelectorAll('.custom-tab-item').forEach(el => el.remove());

  const customTabs = chatOverlayAppConfig?.chatOverlayCustomTabs || [];
  customTabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab-item custom-tab-item';
    if (chatOverlayCurrentTab === tab.id || chatOverlayCurrentTab === tab.name) {
      tabEl.classList.add('active');
    }
    tabEl.setAttribute('data-tab', tab.id);
    tabEl.textContent = tab.name;
    tabEl.addEventListener('click', () => {
      selectTab(tab.id);
    });
    tabsBar.appendChild(tabEl);
  });

  // 현재 활성화된 탭이 삭제된 커스텀 탭인 경우 Basic(통합) 탭으로 안전 복귀
  const isDefaultTab = ['Basic', 'General', 'Team', 'Club', 'Shout', 'Whisper', 'System'].includes(chatOverlayCurrentTab);
  const isCustomTabExist = customTabs.some(t => t.id === chatOverlayCurrentTab || t.name === chatOverlayCurrentTab);
  if (!isDefaultTab && !isCustomTabExist && isInitialTabLoaded) {
    selectTab('Basic');
  }
}

// Initialize Icons
function initIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Copy sender nickname to clipboard
async function copyNickname(nickname: string) {
  if (!nickname) return;
  try {
    await navigator.clipboard.writeText(nickname);
    showCopyToast();
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
}

// Show temporary toast on copy
function showCopyToast() {
  copyToast.classList.add('show');
  setTimeout(() => {
    copyToast.classList.remove('show');
  }, 1500);
}

// Get Korean Channel Display Name
function getChannelBadgeText(type: string): string {
  switch (type) {
    case 'general': return '일반';
    case 'team': return '팀';
    case 'club': return '클럽';
    case 'shout': return '외치기';
    case 'whisper': return '귓속말';
    case 'system': return '시스템';
    default: return type;
  }
}

// Append text with search query highlighted safely via DOM API
function appendHighlightedText(container: HTMLElement, text: string, query?: string) {
  if (!query || !query.trim()) {
    container.textContent = text;
    return;
  }

  const q = query.trim().toLowerCase();
  const lowerText = text.toLowerCase();
  let startIndex = 0;
  let matchIndex = lowerText.indexOf(q, startIndex);

  if (matchIndex === -1) {
    container.textContent = text;
    return;
  }

  container.textContent = '';
  while (matchIndex !== -1) {
    if (matchIndex > startIndex) {
      const beforeText = text.substring(startIndex, matchIndex);
      container.appendChild(document.createTextNode(beforeText));
    }
    const matchText = text.substring(matchIndex, matchIndex + q.length);
    const mark = document.createElement('span');
    mark.className = 'search-highlight';
    mark.textContent = matchText;
    container.appendChild(mark);

    startIndex = matchIndex + q.length;
    matchIndex = lowerText.indexOf(q, startIndex);
  }

  if (startIndex < text.length) {
    const afterText = text.substring(startIndex);
    container.appendChild(document.createTextNode(afterText));
  }
}

// Build chat row element
function createChatRow(chat: BrowserChatItem, highlightQuery?: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'chat-message-row';
  row.dataset.chatId = getChatItemKey(chat);

  // 1. Time
  const timeSpan = document.createElement('span');
  timeSpan.className = 'chat-timestamp';
  timeSpan.textContent = window.chatChannels.formatTimestamp(chat.timestamp);
  row.appendChild(timeSpan);

  // 2. Channel Badge
  const channelBadge = document.createElement('span');
  channelBadge.className = `channel-badge badge-${chat.type}`;
  channelBadge.textContent = getChannelBadgeText(chat.type);
  row.appendChild(channelBadge);

  // 3. Eta Level Badge (If exists)
  if (chat.level !== undefined && chat.level !== null) {
    const badge = document.createElement('span');
    badge.className = 'eta-badge';
    badge.textContent = `에타 ${chat.level}`;
    row.appendChild(badge);
  }

  // 4. Sender
  const senderSpan = document.createElement('span');
  senderSpan.className = 'chat-sender';

  const hasSuspiciousColon = chat.sender && chat.sender.includes('：');
  const shouldHighlight = hasSuspiciousColon && (chatOverlayAppConfig?.chatOverlayHighlightScamNicknames !== false);

  if (highlightQuery && chat.sender) {
    appendHighlightedText(senderSpan, chat.sender, highlightQuery);
  } else {
    senderSpan.textContent = chat.sender ? chat.sender : '';
  }

  if (shouldHighlight) {
    senderSpan.className = 'chat-sender suspicious-sender';

    const warningBadge = document.createElement('span');
    warningBadge.className = 'suspicious-badge';
    warningBadge.textContent = '⚠️ 사칭주의';
    row.appendChild(warningBadge);
  }

  if (chat.sender && chat.sender !== '시스템') {
    senderSpan.dataset.senderCopy = chat.sender;
  } else {
    senderSpan.style.cursor = 'default';
    senderSpan.style.textDecoration = 'none';
  }

  let nicknameColor = '';
  if (chatOverlayAppConfig) {
    const mode = chatOverlayAppConfig.chatOverlayNicknameColorMode || 'same';
    if (mode === 'custom') {
      if (chat.type === 'general' && chatOverlayAppConfig.chatOverlayNicknameColorGeneral) {
        nicknameColor = chatOverlayAppConfig.chatOverlayNicknameColorGeneral;
      } else if (chat.type === 'whisper' && chatOverlayAppConfig.chatOverlayNicknameColorWhisper) {
        nicknameColor = chatOverlayAppConfig.chatOverlayNicknameColorWhisper;
      } else if (chat.type === 'team' && chatOverlayAppConfig.chatOverlayNicknameColorTeam) {
        nicknameColor = chatOverlayAppConfig.chatOverlayNicknameColorTeam;
      } else if (chat.type === 'club' && chatOverlayAppConfig.chatOverlayNicknameColorClub) {
        nicknameColor = chatOverlayAppConfig.chatOverlayNicknameColorClub;
      } else if (chat.type === 'shout' && chatOverlayAppConfig.chatOverlayNicknameColorShout) {
        nicknameColor = chatOverlayAppConfig.chatOverlayNicknameColorShout;
      }
    } else {
      if (chat.type === 'general' && chatOverlayAppConfig.chatOverlayColorGeneral) {
        nicknameColor = chatOverlayAppConfig.chatOverlayColorGeneral;
      } else if (chat.type === 'whisper' && chatOverlayAppConfig.chatOverlayColorWhisper) {
        nicknameColor = chatOverlayAppConfig.chatOverlayColorWhisper;
      } else if (chat.type === 'team' && chatOverlayAppConfig.chatOverlayColorTeam) {
        nicknameColor = chatOverlayAppConfig.chatOverlayColorTeam;
      } else if (chat.type === 'club' && chatOverlayAppConfig.chatOverlayColorClub) {
        nicknameColor = chatOverlayAppConfig.chatOverlayColorClub;
      } else if (chat.type === 'shout' && chatOverlayAppConfig.chatOverlayColorShout) {
        nicknameColor = chatOverlayAppConfig.chatOverlayColorShout;
      }
    }
  }

  if (nicknameColor) {
    senderSpan.style.color = nicknameColor;
  } else if (chat.color) {
    senderSpan.style.color = chat.color;
  }

  row.appendChild(senderSpan);

  // Append separator outside of senderSpan
  if (chat.sender) {
    const separatorSpan = document.createElement('span');
    separatorSpan.className = 'chat-sender-separator';
    separatorSpan.textContent = ':';
    separatorSpan.style.color = '#94a3b8';
    separatorSpan.style.fontWeight = '700';
    separatorSpan.style.marginRight = '2px';
    separatorSpan.style.flexShrink = '0';
    row.appendChild(separatorSpan);
  }

  // 5. Message Content
  const textSpan = document.createElement('span');
  textSpan.className = 'chat-text';
  let messageContent = chat.message;
  if (chat.type === 'shout' && window.chatChannels && typeof window.chatChannels.stripShoutSuffix === 'function') {
    messageContent = window.chatChannels.stripShoutSuffix(messageContent);
  }
  const normalizedMessage = ` ${window.normalizeChatDisplayText(messageContent)}`;
  if (highlightQuery) {
    appendHighlightedText(textSpan, normalizedMessage, highlightQuery);
  } else {
    textSpan.textContent = normalizedMessage;
  }

  let customColor = '';
  if (chatOverlayAppConfig) {
    if (chat.type === 'general' && chatOverlayAppConfig.chatOverlayColorGeneral) {
      customColor = chatOverlayAppConfig.chatOverlayColorGeneral;
    } else if (chat.type === 'whisper' && chatOverlayAppConfig.chatOverlayColorWhisper) {
      customColor = chatOverlayAppConfig.chatOverlayColorWhisper;
    } else if (chat.type === 'team' && chatOverlayAppConfig.chatOverlayColorTeam) {
      customColor = chatOverlayAppConfig.chatOverlayColorTeam;
    } else if (chat.type === 'club' && chatOverlayAppConfig.chatOverlayColorClub) {
      customColor = chatOverlayAppConfig.chatOverlayColorClub;
    } else if (chat.type === 'shout' && chatOverlayAppConfig.chatOverlayColorShout) {
      customColor = chatOverlayAppConfig.chatOverlayColorShout;
    }
  }

  if (customColor) {
    textSpan.style.color = customColor;
  } else if (chat.color) {
    textSpan.style.color = chat.color;
  }
  row.appendChild(textSpan);

  return row;
}

function getChatItemKey(chat: BrowserChatItem): string {
  if (chat.id !== undefined && chat.id !== null && String(chat.id).length > 0) {
    return String(chat.id);
  }
  return [chat.type, chat.timestamp, chat.sender, chat.message, chat.color, chat.level ?? ''].join('\u001f');
}

let chatViewItems: BrowserChatItem[] = [];
let chatViewItemKeys = new Set<string>();
let chatViewHighlightQuery = '';

const chatVirtualList = window.createVirtualList<BrowserChatItem>({
  container: chatArea,
  renderRow: chat => createChatRow(chat, chatViewHighlightQuery || undefined),
  getKey: chat => getChatItemKey(chat),
  estimatedHeight: 22,
  gap: 6,
  overscanPx: 600,
  paddingStart: 10,
  paddingEnd: 10,
  insetStart: 10,
  insetEnd: 10,
});

const chatEmptyState = document.createElement('div');
chatEmptyState.className = 'chat-empty-state hidden';
chatArea.appendChild(chatEmptyState);

function uniqueChatItems(items: readonly BrowserChatItem[]): BrowserChatItem[] {
  const seen = new Set<string>();
  const unique: BrowserChatItem[] = [];
  for (const item of items) {
    const key = getChatItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function setChatViewItems(
  items: readonly BrowserChatItem[],
  options: { scrollToEnd?: boolean; preserveAnchor?: boolean; highlightQuery?: string; emptyMessage?: string } = {},
): void {
  chatViewItems = uniqueChatItems(items);
  chatViewItemKeys = new Set(chatViewItems.map(getChatItemKey));
  chatViewHighlightQuery = options.highlightQuery || '';
  chatEmptyState.textContent = options.emptyMessage || '';
  chatEmptyState.classList.toggle('hidden', chatViewItems.length > 0 || !options.emptyMessage);
  chatVirtualList.setItems(chatViewItems, {
    scrollToEnd: options.scrollToEnd,
    preserveAnchor: options.preserveAnchor,
    resetMeasurements: true,
  });
}

function applyChatResponse(
  responseItems: readonly BrowserChatItem[],
  options: { highlightQuery?: string; emptyMessage: string },
): void {
  const pendingLiveItems = chatViewItems;
  setChatViewItems([...responseItems, ...pendingLiveItems], {
    scrollToEnd: true,
    highlightQuery: options.highlightQuery,
    emptyMessage: options.emptyMessage,
  });
}

function appendChatViewItems(items: readonly BrowserChatItem[], followEnd: boolean): void {
  const uniqueNewItems: BrowserChatItem[] = [];
  for (const item of items) {
    const key = getChatItemKey(item);
    if (chatViewItemKeys.has(key)) continue;
    chatViewItemKeys.add(key);
    chatViewItems.push(item);
    uniqueNewItems.push(item);
  }
  if (uniqueNewItems.length === 0) return;
  chatEmptyState.classList.add('hidden');
  chatVirtualList.appendItems(uniqueNewItems, { followEnd });
}

function prependChatViewItems(items: readonly BrowserChatItem[]): void {
  const uniqueOlderItems: BrowserChatItem[] = [];
  const batchKeys = new Set<string>();
  for (const item of items) {
    const key = getChatItemKey(item);
    if (chatViewItemKeys.has(key) || batchKeys.has(key)) continue;
    batchKeys.add(key);
    uniqueOlderItems.push(item);
  }
  if (uniqueOlderItems.length === 0) return;
  for (const key of batchKeys) chatViewItemKeys.add(key);
  chatViewItems = [...uniqueOlderItems, ...chatViewItems];
  chatEmptyState.classList.add('hidden');
  chatVirtualList.prependItems(uniqueOlderItems);
}

// Search State
let isSearchMode = false;
let currentSearchQuery = '';
let isSearching = false;

// Open Search Bar UI
function openSearchBar(focus = true) {
  if (!searchContainer) return;
  searchContainer.classList.remove('hidden');
  initIcons();
  if (focus && searchInput) {
    searchInput.focus();
    searchInput.select();
  }
}

// Close Search Bar UI & Reset Search Mode
function closeSearchBar() {
  if (!searchContainer) return;
  searchContainer.classList.add('hidden');
  if (searchStatusBar) {
    searchStatusBar.classList.add('hidden');
  }
  if (searchInput) {
    searchInput.value = '';
  }
  if (btnClearSearchInput) {
    btnClearSearchInput.style.display = 'none';
  }
  if (isSearchMode) {
    isSearchMode = false;
    currentSearchQuery = '';
    isSearching = false;
    void loadHistory();
  }
}

// Execute Backend Search
async function executeSearch(query?: string) {
  const q = query !== undefined ? query.trim() : (searchInput ? searchInput.value.trim() : '');
  if (!q) {
    closeSearchBar();
    return;
  }

  isSearching = true;
  isSearchMode = true;
  currentSearchQuery = q;
  const requestedTab = chatOverlayCurrentTab;
  const request = beginChatViewRequest(`search:${requestedTab}:${q}`);

  if (searchStatusBar) {
    searchStatusBar.classList.remove('hidden');
    if (searchResultText) {
      searchResultText.textContent = `"${q}" 검색 중...`;
    }
  }

  setChatViewItems([], { highlightQuery: q });

  try {
    const results = await window.electronAPI.searchChatLogs(q, {
      category: requestedTab,
      limit: 500
    });
    if (!chatViewRequests.isCurrent(request)) return;

    if (results && results.length > 0) {
      const filtered = results.filter((chat: BrowserChatItem) => shouldShowChat(chat));
      applyChatResponse(filtered, {
        highlightQuery: q,
        emptyMessage: '일치하는 채팅 내역이 없습니다.',
      });
      if (searchResultText) {
        searchResultText.textContent = `검색 결과: ${filtered.length}건 ("${q}")`;
      }
    } else {
      if (searchResultText) {
        searchResultText.textContent = `검색 결과 없음 ("${q}")`;
      }
      applyChatResponse([], {
        highlightQuery: q,
        emptyMessage: '일치하는 채팅 내역이 없습니다.',
      });
    }
  } catch (err) {
    if (!chatViewRequests.isCurrent(request)) return;
    console.error('채팅 검색 실패:', err);
    if (searchResultText) {
      searchResultText.textContent = `검색 실패 ("${q}")`;
    }
  } finally {
    if (chatViewRequests.isCurrent(request)) {
      isSearching = false;
      isChatViewLoading = false;
      initIcons();
    }
  }
}

// Load history for selected tab
async function loadHistory() {
  clearPendingIncomingChat();
  isLoadingMore = false;
  hasReachedEnd = false;
  isSearching = false;
  const requestedTab = chatOverlayCurrentTab;
  const request = beginChatViewRequest(`history:${requestedTab}`);
  setChatViewItems([]);
  try {
    const history = await window.electronAPI.getChatHistory(requestedTab);
    if (!chatViewRequests.isCurrent(request)) return;

    if (history && history.length > 0) {
      const filtered = history.filter((chat: BrowserChatItem) => shouldShowChat(chat));

      if (filtered.length > 0) {
        applyChatResponse(filtered, { emptyMessage: '일치하는 채팅 내역이 없습니다.' });
      } else {
        applyChatResponse([], { emptyMessage: '일치하는 채팅 내역이 없습니다.' });
      }
    } else {
      applyChatResponse([], { emptyMessage: '채팅 내역이 없습니다.' });
    }
  } catch (e) {
    if (!chatViewRequests.isCurrent(request)) return;
    console.error('Failed to load chat history:', e);
  } finally {
    if (chatViewRequests.isCurrent(request)) isChatViewLoading = false;
  }
}

// Scroll chat area to bottom
function scrollToBottom() {
  chatVirtualList.scrollToEnd();
}

// Switch Active Tab
function selectTab(tabName: string, save = true) {
  chatOverlayCurrentTab = tabName;
  document.querySelectorAll('.tab-item').forEach(el => {
    if (el.getAttribute('data-tab') === tabName) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
  isLoadingMore = false;
  hasReachedEnd = false;

  if (isSearchMode && currentSearchQuery) {
    void executeSearch(currentSearchQuery);
  } else {
    void loadHistory();
  }

  if (save) {
    if (chatOverlayMode === 'main') {
      window.electronAPI.applySettings({ chatOverlayTab: tabName });
    } else if (chatOverlayMode === 'sub1') {
      window.electronAPI.applySettings({ chatOverlaySubTab: tabName });
    } else if (chatOverlayMode === 'sub2') {
      window.electronAPI.applySettings({ chatOverlaySub2Tab: tabName });
    }
  }
}

// Handle Mouse Hover (Fade In/Out Control Panels) - Disabled as visibility is now controlled strictly by click-through status
function handleMouseEnter() {
  return;
}

function handleMouseLeave() {
  return;
}

// Update Header, Tabs, and Resize Handle visibility based on Click Through config
function updateHeaderVisibility(config: BrowserAppConfig) {
  if (!config) return;
  const clickThrough = !!config.chatOverlayClickThrough;
  
  // clickThrough 상태가 변경되었는지 또는 최초 설정 로드인지 확인
  const prevClickThrough = lastKnownConfig ? !!lastKnownConfig.chatOverlayClickThrough : null;
  const clickThroughChanged = (prevClickThrough !== clickThrough);

  if (clickThrough) {
    // 마우스 투과 일때는 헤더 완전히 숨김
    overlayPanel.classList.remove('hover-active');
    dragHeader.classList.remove('visible');
    tabsBar.classList.remove('visible');
    if (resizeHandle) {
      resizeHandle.classList.remove('visible');
    }
  } else {
    // 마우스 투과 아닐때는 헤더 항상 표시
    overlayPanel.classList.add('hover-active');
    dragHeader.classList.add('visible');
    tabsBar.classList.add('visible');
    if (resizeHandle) {
      resizeHandle.classList.add('visible');
    }
  }
  // 스크롤 보정은 clickThrough가 실제로 변경되었을 때만 실행 (타 오버레이 탭 변경 시 스크롤 리셋 방지)
  if (clickThroughChanged) {
    setTimeout(() => scrollToBottom(), 250);
  }
}

// Update Styles based on Config
function applyConfigStyles(config: BrowserAppConfig) {
  if (!config) return;
  const fontSizeChanged = chatOverlayAppConfig?.chatOverlayFontSize !== config.chatOverlayFontSize;
  chatOverlayAppConfig = config;

  // Font Size
  if (config.chatOverlayFontSize) {
    document.documentElement.style.setProperty('--font-size-base', `${config.chatOverlayFontSize}px`);
  }
  if (fontSizeChanged) {
    requestAnimationFrame(() => chatVirtualList.resetMeasurements(true));
  }

  // Opacity
  let normalOpacity = 0.8;
  if (chatOverlayMode === 'main') {
    normalOpacity = config.chatOverlayOpacity !== undefined ? config.chatOverlayOpacity : 0.8;
  } else if (chatOverlayMode === 'sub1') {
    normalOpacity = config.chatOverlaySubOpacity !== undefined ? config.chatOverlaySubOpacity : 0.8;
  } else if (chatOverlayMode === 'sub2') {
    normalOpacity = config.chatOverlaySub2Opacity !== undefined ? config.chatOverlaySub2Opacity : 0.8;
  }
  const hoverOpacity = Math.min(normalOpacity + 0.25, 1.0);
  document.documentElement.style.setProperty('--bg-overlay', `rgba(15, 14, 26, ${normalOpacity})`);
  document.documentElement.style.setProperty('--bg-overlay-hover', `rgba(15, 14, 26, ${hoverOpacity})`);

  isConfigReceived = true;
  if (!isInitialTabLoaded) {
    checkAndLoadInitialTab();
  }

  // Main 창인 경우 Sub 1, Sub 2 각 개별 창 활성화 여부에 따라 버튼 스타일 토글 처리 (항상 클릭 가능)
  if (chatOverlayMode === 'main') {
    const sub1Open = !!config.chatOverlaySubEnabled;
    const sub2Open = !!config.chatOverlaySub2Enabled;
    
    if (btnOpenSub1) {
      if (sub1Open) {
        btnOpenSub1.style.background = 'rgba(52, 211, 153, 0.15)'; // bg-emerald-500/15
        btnOpenSub1.style.color = '#34d399'; // text-emerald-400
        btnOpenSub1.style.borderColor = 'rgba(52, 211, 153, 0.3)'; // border-emerald-500/30
        btnOpenSub1.title = 'Sub 1 창 닫기';
      } else {
        btnOpenSub1.style.background = 'transparent';
        btnOpenSub1.style.color = 'var(--tab-inactive)';
        btnOpenSub1.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        btnOpenSub1.title = 'Sub 1 창 열기';
      }
    }

    if (btnOpenSub2) {
      if (sub2Open) {
        btnOpenSub2.style.background = 'rgba(52, 211, 153, 0.15)';
        btnOpenSub2.style.color = '#34d399';
        btnOpenSub2.style.borderColor = 'rgba(52, 211, 153, 0.3)';
        btnOpenSub2.title = 'Sub 2 창 닫기';
      } else {
        btnOpenSub2.style.background = 'transparent';
        btnOpenSub2.style.color = 'var(--tab-inactive)';
        btnOpenSub2.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        btnOpenSub2.title = 'Sub 2 창 열기';
      }
    }
  }

  // 커스텀 탭 렌더링
  renderCustomTabs();

  updateHeaderVisibility(config);
}

// Header Action Buttons Event Bindings
if (btnOpenLog) {
  btnOpenLog.addEventListener('click', () => {
    window.electronAPI.openTodayLog();
  });
}
if (btnToggleSearch) {
  btnToggleSearch.addEventListener('click', () => {
    if (searchContainer && searchContainer.classList.contains('hidden')) {
      openSearchBar(true);
    } else {
      closeSearchBar();
    }
  });
}
if (btnSettings) {
  btnSettings.addEventListener('click', () => {
    window.electronAPI.toggleSettings('chatlog:sub-tab-overlay');
  });
}

// Event Bindings
document.querySelectorAll('.tab-item').forEach(el => {
  el.addEventListener('click', () => {
    const tab = el.getAttribute('data-tab');
    if (tab) {
      selectTab(tab);
    }
  });
});

// Search UI Event Bindings
if (btnExecuteSearch) {
  btnExecuteSearch.addEventListener('click', () => executeSearch());
}
if (btnCloseSearch) {
  btnCloseSearch.addEventListener('click', () => closeSearchBar());
}
if (btnExitSearchMode) {
  btnExitSearchMode.addEventListener('click', () => closeSearchBar());
}
if (searchInput) {
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      executeSearch();
    } else if (e.key === 'Escape') {
      closeSearchBar();
    }
  });
  searchInput.addEventListener('input', () => {
    if (btnClearSearchInput) {
      btnClearSearchInput.style.display = searchInput.value ? 'inline-flex' : 'none';
    }
  });
}
if (btnClearSearchInput) {
  btnClearSearchInput.addEventListener('click', () => {
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    btnClearSearchInput.style.display = 'none';
  });
}

// Global Shortcuts (Ctrl+F, Esc)
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearchBar(true);
  } else if (e.key === 'Escape' && isSearchMode) {
    closeSearchBar();
  }
});

overlayPanel.addEventListener('mouseenter', handleMouseEnter);
overlayPanel.addEventListener('mouseleave', handleMouseLeave);

let pendingIncomingChatItems: BrowserChatItem[] = [];
let renderIncomingRafId: number | null = null;
let renderIncomingTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingIncomingChat(): void {
  pendingIncomingChatItems = [];
  if (renderIncomingRafId !== null) {
    cancelAnimationFrame(renderIncomingRafId);
    renderIncomingRafId = null;
  }
  if (renderIncomingTimer !== null) {
    clearTimeout(renderIncomingTimer);
    renderIncomingTimer = null;
  }
}

function flushIncomingChatItems(): void {
  if (renderIncomingRafId !== null) {
    cancelAnimationFrame(renderIncomingRafId);
    renderIncomingRafId = null;
  }
  if (renderIncomingTimer !== null) {
    clearTimeout(renderIncomingTimer);
    renderIncomingTimer = null;
  }
  if (pendingIncomingChatItems.length === 0) return;

  const items = pendingIncomingChatItems;
  pendingIncomingChatItems = [];

  const isAtBottom = chatVirtualList.isAtEnd(50);
  const visibleItems: BrowserChatItem[] = [];

  for (const chatItem of items) {
    if (isSearchMode && currentSearchQuery) {
      const q = currentSearchQuery.toLowerCase();
      const senderMatch = chatItem.sender ? chatItem.sender.toLowerCase().includes(q) : false;
      const messageMatch = chatItem.message ? chatItem.message.toLowerCase().includes(q) : false;

      if (senderMatch || messageMatch) {
        visibleItems.push(chatItem);
      }
    } else {
      visibleItems.push(chatItem);
    }
  }

  appendChatViewItems(visibleItems, isAtBottom);
}

// Register Electron IPC Listeners
window.electronAPI.onChatUpdated((chatItem) => {
  // Check if item should be shown in current tab
  const show = shouldShowChat(chatItem);

  if (show) {
    pendingIncomingChatItems.push(chatItem);
    if (renderIncomingRafId === null && renderIncomingTimer === null) {
      renderIncomingRafId = requestAnimationFrame(flushIncomingChatItems);
      // Chromium 백그라운드/숨김 창에서 rAF 지연 대비 40ms 타이머 폴백
      renderIncomingTimer = setTimeout(flushIncomingChatItems, 40);
    }
  }
});

window.electronAPI.onChatHistoryCleared(() => {
  isLoadingMore = false;
  hasReachedEnd = false;
  loadHistory();
});

window.electronAPI.onConfigData((config) => {
  const isFirstConfig = !lastKnownConfig;

  // Calculate current active tab configured for this specific window mode
  const currentConfigTab = chatOverlayMode === 'main'
    ? (config.chatOverlayTab || 'Basic')
    : (chatOverlayMode === 'sub1' ? (config.chatOverlaySubTab || 'Basic') : (config.chatOverlaySub2Tab || 'Basic'));

  // Detect if channel filters changed
  let channelsChanged = false;
  let npcChatSettingChanged = false;
  let blacklistFiltersChanged = false;
  if (lastKnownConfig) {
    const oldChannels = lastKnownConfig.chatOverlaySelectedChannels || [];
    const newChannels = config.chatOverlaySelectedChannels || [];
    if (oldChannels.length !== newChannels.length) {
      channelsChanged = true;
    } else {
      const sortedOld = [...oldChannels].sort();
      const sortedNew = [...newChannels].sort();
      for (let i = 0; i < sortedOld.length; i++) {
        if (sortedOld[i] !== sortedNew[i]) {
          channelsChanged = true;
          break;
        }
      }
    }
    npcChatSettingChanged = (lastKnownConfig.chatOverlayShowNpcChat !== config.chatOverlayShowNpcChat);

    const oldFilters = lastKnownConfig.chatOverlayBlacklistFilters || [];
    const newFilters = config.chatOverlayBlacklistFilters || [];
    if (oldFilters.length !== newFilters.length) {
      blacklistFiltersChanged = true;
    } else {
      for (let i = 0; i < oldFilters.length; i++) {
        if (oldFilters[i] !== newFilters[i]) {
          blacklistFiltersChanged = true;
          break;
        }
      }
    }
  } else {
    channelsChanged = true;
    npcChatSettingChanged = true;
    blacklistFiltersChanged = true;
  }

  // 색상 변경 감지
  let colorChanged = false;
  if (lastKnownConfig) {
    const colorKeys: Array<keyof BrowserAppConfig> = [
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
      'chatOverlayNicknameColorShout'
    ];
    for (const key of colorKeys) {
      if (lastKnownConfig[key] !== config[key]) {
        colorChanged = true;
        break;
      }
    }
  } else {
    colorChanged = true;
  }

  // 엘소/경험치 필터 변경 감지
  let gainSettingsChanged = false;
  if (lastKnownConfig) {
    if (lastKnownConfig.chatOverlayShowElsoGain !== config.chatOverlayShowElsoGain ||
        lastKnownConfig.chatOverlayShowXpGain !== config.chatOverlayShowXpGain) {
      gainSettingsChanged = true;
    }
  }

  // 커스텀 탭 목록 변경 감지
  let customTabsChanged = false;
  if (lastKnownConfig) {
    const oldTabs = JSON.stringify(lastKnownConfig.chatOverlayCustomTabs || []);
    const newTabs = JSON.stringify(config.chatOverlayCustomTabs || []);
    if (oldTabs !== newTabs) {
      customTabsChanged = true;
    }
  }

  applyConfigStyles(config);
  lastKnownConfig = config;

  if (isFirstConfig) {
    // Initial loading is managed inside applyConfigStyles -> checkAndLoadInitialTab
    return;
  }

  const tabChangedExternally = (currentConfigTab !== chatOverlayCurrentTab);
  if (tabChangedExternally) {
    selectTab(currentConfigTab, false);
  } else if ((channelsChanged || npcChatSettingChanged || colorChanged || blacklistFiltersChanged || customTabsChanged || gainSettingsChanged) && chatOverlayCurrentTab === 'Basic') {
    loadHistory();
  } else if (npcChatSettingChanged || colorChanged || blacklistFiltersChanged || customTabsChanged || gainSettingsChanged) {
    loadHistory();
  }
});

// Mode configuration for Main/Sub windows
window.electronAPI.onChatOverlayMode((mode) => {
  chatOverlayMode = mode;
  isModeReceived = true;
  
  // 헤더 타이틀 표시 치환
  const titleTextEl = document.getElementById('dragHeaderTitleText');
  if (titleTextEl) {
    if (mode === 'main') {
      titleTextEl.innerText = 'CHAT HISTORY (MAIN)';
    } else if (mode === 'sub1') {
      titleTextEl.innerText = 'CHAT HISTORY (SUB 1)';
    } else if (mode === 'sub2') {
      titleTextEl.innerText = 'CHAT HISTORY (SUB 2)';
    }
  }

  if (btnOpenSub1) {
    btnOpenSub1.style.display = mode === 'main' ? 'inline-flex' : 'none';
  }
  if (btnOpenSub2) {
    btnOpenSub2.style.display = mode === 'main' ? 'inline-flex' : 'none';
  }
  initIcons(); // Re-render Lucide icons inside header

  if (!isInitialTabLoaded) {
    checkAndLoadInitialTab();
  }
});

if (btnOpenSub1) {
  btnOpenSub1.addEventListener('click', () => {
    window.electronAPI.toggleChatOverlaySub(1);
  });
}
if (btnOpenSub2) {
  btnOpenSub2.addEventListener('click', () => {
    window.electronAPI.toggleChatOverlaySub(2);
  });
}

const btnClose = document.getElementById('btnCloseOverlay') as HTMLButtonElement;
if (btnClose) {
  btnClose.addEventListener('click', () => {
    if (chatOverlayMode === 'main') {
      window.electronAPI.toggleChatOverlay();
    } else if (chatOverlayMode === 'sub1') {
      window.electronAPI.toggleChatOverlaySub(1);
    } else if (chatOverlayMode === 'sub2') {
      window.electronAPI.toggleChatOverlaySub(2);
    }
  });
}

// Resize Drag Control
let chatOverlayIsResizing = false;
let chatOverlayStartX = 0;
let chatOverlayStartY = 0;
let chatOverlayStartWidth = 0;
let chatOverlayStartHeight = 0;

if (resizeHandle) {
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatOverlayIsResizing = true;
    chatOverlayStartX = e.screenX;
    chatOverlayStartY = e.screenY;
    if (chatOverlayMode === 'main') {
      chatOverlayStartWidth = window.outerWidth || chatOverlayAppConfig?.chatOverlayWidth || 450;
      chatOverlayStartHeight = window.outerHeight || chatOverlayAppConfig?.chatOverlayHeight || 400;
    } else if (chatOverlayMode === 'sub1') {
      chatOverlayStartWidth = window.outerWidth || chatOverlayAppConfig?.chatOverlaySubWidth || 450;
      chatOverlayStartHeight = window.outerHeight || chatOverlayAppConfig?.chatOverlaySubHeight || 400;
    } else {
      chatOverlayStartWidth = window.outerWidth || chatOverlayAppConfig?.chatOverlaySub2Width || 450;
      chatOverlayStartHeight = window.outerHeight || chatOverlayAppConfig?.chatOverlaySub2Height || 400;
    }
  });
}

window.addEventListener('mousemove', (e) => {
  if (!chatOverlayIsResizing) return;
  const deltaX = e.screenX - chatOverlayStartX;
  const deltaY = e.screenY - chatOverlayStartY;
  
  const newWidth = Math.max(300, chatOverlayStartWidth + deltaX);
  const newHeight = Math.max(80, chatOverlayStartHeight + deltaY);
  
  window.electronAPI.setChatOverlaySize(chatOverlayMode, newWidth, newHeight);
});

window.addEventListener('mouseup', (e) => {
  if (!chatOverlayIsResizing) return;
  chatOverlayIsResizing = false;
  
  const deltaX = e.screenX - chatOverlayStartX;
  const deltaY = e.screenY - chatOverlayStartY;
  const newWidth = Math.max(300, chatOverlayStartWidth + deltaX);
  const newHeight = Math.max(80, chatOverlayStartHeight + deltaY);
  
  if (chatOverlayMode === 'main') {
    window.electronAPI.applySettings({
      chatOverlayWidth: newWidth,
      chatOverlayHeight: newHeight
    });
  } else if (chatOverlayMode === 'sub1') {
    window.electronAPI.applySettings({
      chatOverlaySubWidth: newWidth,
      chatOverlaySubHeight: newHeight
    });
  } else if (chatOverlayMode === 'sub2') {
    window.electronAPI.applySettings({
      chatOverlaySub2Width: newWidth,
      chatOverlaySub2Height: newHeight
    });
  }
});

// Scroll Event for Infinite Scroll
chatArea.addEventListener('scroll', async () => {
  if (isSearchMode || isChatViewLoading) return;
  if (chatArea.scrollTop <= 5 && !isLoadingMore && !hasReachedEnd) {
    isLoadingMore = true;
    const requestedTab = chatOverlayCurrentTab;
    const requestedView = activeChatViewRequest;
    const requestGeneration = ++paginationGeneration;
    try {
      const newItems = await window.electronAPI.getMoreChatHistory(requestedTab);
      
      // 비동기 로딩 도중 사용자가 탭을 바꿨으면 렌더링 스킵
      if (requestGeneration !== paginationGeneration || !requestedView
        || !chatViewRequests.isCurrent(requestedView)
        || requestedTab !== chatOverlayCurrentTab || isSearchMode) return;

      if (newItems && newItems.length > 0) {
        const filtered = newItems.filter((chat: BrowserChatItem) => shouldShowChat(chat));
        prependChatViewItems(filtered);

        if (newItems.length < 150) {
          hasReachedEnd = true;
        }
      } else {
        hasReachedEnd = true;
      }
    } catch (err) {
      if (requestGeneration !== paginationGeneration) return;
      console.error('Failed to load more chat history:', err);
    } finally {
      if (requestGeneration === paginationGeneration) isLoadingMore = false;
    }
  }
});

// Chat Area Event Delegation (Nickname Copy & EasterEgg)
chatArea.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement | null)?.closest('[data-sender-copy]') as HTMLElement | null;
  if (!target) return;
  const sender = target.dataset.senderCopy;
  if (!sender) return;

  copyNickname(sender);

  if (FIREWORK_NICKNAMES_SET.has(sender)) {
    console.log('[EasterEgg] Clicking target nickname detected. Sender:', sender);
    if (window.electronAPI && window.electronAPI.triggerFireworkGlobal) {
      window.electronAPI.triggerFireworkGlobal();
    }
  }
});

// Window Load Handler
window.onload = async () => {
  initIcons();
  
  // 탭바 마우스 휠 좌우 스크롤 연동 (반응형 휠 편의성 제공)
  if (tabsBar) {
    tabsBar.addEventListener('wheel', (e) => {
      e.preventDefault();
      tabsBar.scrollLeft += e.deltaY;
    });
  }
};
