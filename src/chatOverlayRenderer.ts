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

// 숨김과 이름/대사 표시가 같은 NPC 판별을 사용한다.
function isNpcOrMonsterChat(chat: BrowserChatItem): boolean {
  return window.chatConstants.isNpcChat(chat);
}

function shouldShowChat(chat: BrowserChatItem): boolean {
  return !!chat && window.chatChannels.isOverlayChatVisible(
    chat, chatOverlayAppConfig || {}, chatOverlayCurrentTab, isNpcOrMonsterChat(chat),
  );
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

  const availableTab = resolveAvailableTab(savedTab);
  selectTab(availableTab, availableTab !== savedTab);
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

const builtInTabIds = [...window.chatChannels.OVERLAY_BUILT_IN_TABS];

function getVisibleBuiltInTabs(config: BrowserAppConfig | null = chatOverlayAppConfig): string[] {
  const configuredTabs = config?.chatOverlayVisibleTabs;
  if (!Array.isArray(configuredTabs)) return builtInTabIds;
  const visibleTabs = builtInTabIds.filter(tab => configuredTabs.includes(tab));
  return visibleTabs.length > 0 ? visibleTabs : ['Basic'];
}

function resolveAvailableTab(tabName: string): string {
  const visibleBuiltInTabs = getVisibleBuiltInTabs();
  if (visibleBuiltInTabs.includes(tabName)) return tabName;

  const customTabs = chatOverlayAppConfig?.chatOverlayCustomTabs || [];
  const customTab = window.chatChannels.resolveOverlayCustomTab(tabName, customTabs);
  if (customTab) return customTab.id;

  return visibleBuiltInTabs[0] || 'Basic';
}

function renderBuiltInTabs() {
  builtInTabIds.forEach(tabId => {
    const tab = tabsBar?.querySelector(`.tab-item[data-tab="${tabId}"]`);
    tab?.classList.toggle('tab-hidden', !getVisibleBuiltInTabs().includes(tabId));
  });
}

function renderCustomTabs() {
  if (!tabsBar) return;
  // 기존 커스텀 탭 제거
  tabsBar.querySelectorAll('.custom-tab-item').forEach(el => el.remove());

  const customTabs = chatOverlayAppConfig?.chatOverlayCustomTabs || [];
  customTabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab-item custom-tab-item';
    if (chatOverlayCurrentTab === tab.id) {
      tabEl.classList.add('active');
    }
    tabEl.setAttribute('data-tab', tab.id);
    tabEl.textContent = tab.name;
    tabEl.addEventListener('click', () => {
      selectTab(tab.id);
    });
    tabsBar.appendChild(tabEl);
  });

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

/**
 * NPC 표시 계약: 숨김과 같은 판별 기준을 사용하고 이름·대사 앞에 채널 배지나
 * 합성 발신자 `시스템 :`을 덧붙이지 않는다. 별도 NPC 배지도 만들지 않는다.
 * 시스템으로 분류된 대사의 원문에는 이름이 이미 들어 있으므로 본문을 그대로 표시한다.
 * 원본 ChatItem은 유지하여 탭·색상 필터·검색·중복 제거에 영향을 주지 않는다.
 * 메인·보조 창의 이력·검색·추가 페이지·실시간 수신을 check-npc-chat.ts로 검증한다.
 */
function createChatRow(chat: BrowserChatItem, highlightQuery?: string): HTMLDivElement {
  const isNpcDialogue = isNpcOrMonsterChat(chat);
  const displaySender = isNpcDialogue && chat.sender === '시스템' ? '' : chat.sender;
  const row = document.createElement('div');
  row.className = 'chat-message-row';
  row.dataset.chatId = getChatItemKey(chat);

  // 1. Time
  const timeSpan = document.createElement('span');
  timeSpan.className = 'chat-timestamp';
  timeSpan.textContent = window.chatChannels.formatTimestamp(chat.timestamp);
  row.appendChild(timeSpan);

  // 2. Channel Badge
  if (!isNpcDialogue) {
    const channelBadge = document.createElement('span');
    channelBadge.className = `channel-badge badge-${chat.type}`;
    channelBadge.textContent = getChannelBadgeText(chat.type);
    row.appendChild(channelBadge);
  }

  // 3. Eta Level Badge (If exists)
  if (chat.level !== undefined && chat.level !== null) {
    const badge = document.createElement('span');
    badge.className = 'eta-badge';
    badge.textContent = `에타 ${chat.level}`;
    const etaColor = window.chatChannels.getEtaColor(chat.level, chatOverlayAppConfig || {});
    if (etaColor) { badge.style.color = etaColor; badge.style.background = `${etaColor}18`; badge.style.border = `1px solid ${etaColor}80`; }
    row.appendChild(badge);
  }

  // 4. Sender
  const senderSpan = document.createElement('span');
  senderSpan.className = 'chat-sender';

  const hasSuspiciousColon = displaySender && displaySender.includes('：');
  const shouldHighlight = hasSuspiciousColon && (chatOverlayAppConfig?.chatOverlayHighlightScamNicknames !== false);

  if (highlightQuery && displaySender) {
    appendHighlightedText(senderSpan, displaySender, highlightQuery);
  } else {
    senderSpan.textContent = displaySender || '';
  }

  if (shouldHighlight) {
    senderSpan.className = 'chat-sender suspicious-sender';

    const warningBadge = document.createElement('span');
    warningBadge.className = 'suspicious-badge';
    warningBadge.textContent = '⚠️ 사칭주의';
    row.appendChild(warningBadge);
  }

  if (displaySender && displaySender !== '시스템') {
    senderSpan.dataset.senderCopy = displaySender;
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

  if (displaySender) row.appendChild(senderSpan);
  if (chat.type !== 'system' && !isNpcDialogue && chat.sender) {
    senderSpan.dataset.noteNickname = chat.sender;
    senderSpan.title = '클릭: 닉네임 복사 · 우클릭: 정보·메모';
    window.nicknameNotes?.appendBadge(row, chat.sender);
  }

  // Append separator outside of senderSpan
  if (displaySender) {
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

  window.chatChannels.applyReadingDisplay(row, chatOverlayAppConfig || {});
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

/** 기능 계약: 메모·서버별 배지·색상 변경은 조회 조건이 아니다.
 * 현재 항목, 검색어/강조, 과거 페이지 커서와 진행 중인 조회·실시간 수신을 유지하고 행만 다시 그린다.
 * 행 높이가 달라져도 읽던 행의 화면 위치를 보존하며, 맨 아래를 보던 창은 끝을 따라간다.
 * 회귀: check-renderer-behavior.ts의 검색 갱신 및 과거 탐색 중 표시 설정 검사.
 */
function refreshChatAppearance(): void {
  chatVirtualList.setItems(chatViewItems, {
    scrollToEnd: chatVirtualList.isAtEnd(2),
    preserveAnchor: true,
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

function prependChatViewItems(items: readonly BrowserChatItem[]): number {
  const uniqueOlderItems: BrowserChatItem[] = [];
  const batchKeys = new Set<string>();
  for (const item of items) {
    const key = getChatItemKey(item);
    if (chatViewItemKeys.has(key) || batchKeys.has(key)) continue;
    batchKeys.add(key);
    uniqueOlderItems.push(item);
  }
  if (uniqueOlderItems.length === 0) return 0;
  for (const key of batchKeys) chatViewItemKeys.add(key);
  chatViewItems = [...uniqueOlderItems, ...chatViewItems];
  chatEmptyState.classList.add('hidden');
  chatVirtualList.prependItems(uniqueOlderItems);
  return uniqueOlderItems.length;
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
    await loadMoreHistory(true);
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
  const resolvedTab = resolveAvailableTab(tabName);
  chatOverlayCurrentTab = resolvedTab;
  document.querySelectorAll('.tab-item').forEach(el => {
    if (el.getAttribute('data-tab') === resolvedTab) {
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
      window.electronAPI.applySettings({ chatOverlayTab: resolvedTab });
    } else if (chatOverlayMode === 'sub1') {
      window.electronAPI.applySettings({ chatOverlaySubTab: resolvedTab });
    } else if (chatOverlayMode === 'sub2') {
      window.electronAPI.applySettings({ chatOverlaySub2Tab: resolvedTab });
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
  document.body.classList.toggle('click-through', clickThrough);
  
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
let chatFontRevision = 0;
function applyConfigStyles(config: BrowserAppConfig) {
  if (!config) return;
  const font = window.chatChannels.resolveChatFont(config, chatOverlayMode);
  const fontSizeChanged = document.documentElement.style.getPropertyValue('--font-size-base') !== `${font.size}px`
    || document.body.style.fontFamily !== font.family;
  chatOverlayAppConfig = config;
  window.nicknameNotes?.updateConfig(config);

  // Font Size
  document.documentElement.style.setProperty('--font-size-base', `${font.size}px`);
  document.body.style.fontFamily = font.family;
  const fontRevision = ++chatFontRevision;
  if (font.key.startsWith('custom:')) {
    void window.customChatFonts?.load(font.key).then(() => {
      if (fontRevision === chatFontRevision) chatVirtualList.resetMeasurements(true);
    });
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

  renderBuiltInTabs();
  renderCustomTabs();

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
      e.preventDefault();
      e.stopPropagation();
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
function closeCurrentChatOverlay(): void {
  if (chatOverlayMode === 'main') {
    window.electronAPI.toggleChatOverlay();
  } else if (chatOverlayMode === 'sub1') {
    window.electronAPI.toggleChatOverlaySub(1);
  } else if (chatOverlayMode === 'sub2') {
    window.electronAPI.toggleChatOverlaySub(2);
  }
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearchBar(true);
  } else if (e.key === 'Escape' && isSearchMode) {
    e.preventDefault();
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
  // 날짜 변경·로그 재연결도 현재 조회 조건을 유지한다. 일반 이력으로 덮으면
  // 검색 상태 표시와 본문이 달라지고, 초기화 전 대기 중인 행/응답이 섞인다.
  clearPendingIncomingChat();
  isLoadingMore = false;
  hasReachedEnd = false;
  if (isSearchMode && currentSearchQuery) {
    void executeSearch(currentSearchQuery);
  } else {
    void loadHistory();
  }
});

window.electronAPI.onConfigData((config) => {
  const isFirstConfig = !lastKnownConfig;

  // Calculate current active tab configured for this specific window mode
  const configuredTab = chatOverlayMode === 'main'
    ? (config.chatOverlayTab || 'Basic')
    : (chatOverlayMode === 'sub1' ? (config.chatOverlaySubTab || 'Basic') : (config.chatOverlaySub2Tab || 'Basic'));

  // Detect if channel filters changed
  let channelsChanged = false;
  let npcChatSettingChanged = false;
  let blacklistFiltersChanged = false;
  let visibleTabsChanged = false;
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
    visibleTabsChanged = JSON.stringify(lastKnownConfig.chatOverlayVisibleTabs || builtInTabIds)
      !== JSON.stringify(config.chatOverlayVisibleTabs || builtInTabIds);

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
    visibleTabsChanged = true;
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

  // 표시 대상이 바뀌는 필터와 행의 표현만 바뀌는 설정을 분리한다.
  let gainSettingsChanged = false;
  let appearanceChanged = colorChanged;
  if (lastKnownConfig) {
    if (lastKnownConfig.chatOverlayShowElsoGain !== config.chatOverlayShowElsoGain ||
        lastKnownConfig.chatOverlayShowXpGain !== config.chatOverlayShowXpGain ||
        lastKnownConfig.chatOverlayShowFreeShout !== config.chatOverlayShowFreeShout ||
        lastKnownConfig.chatOverlayShowPaidShout !== config.chatOverlayShowPaidShout ||
        lastKnownConfig.chatOverlayShowNoticeShout !== config.chatOverlayShowNoticeShout) {
      gainSettingsChanged = true;
    }
    if (lastKnownConfig.chatCompactDisplay !== config.chatCompactDisplay ||
        lastKnownConfig.chatNicknameNotesCompact !== config.chatNicknameNotesCompact ||
        lastKnownConfig.chatEtaColorsEnabled !== config.chatEtaColorsEnabled ||
        JSON.stringify(lastKnownConfig.nicknameNotes) !== JSON.stringify(config.nicknameNotes) ||
        lastKnownConfig.userServer !== config.userServer ||
        JSON.stringify(lastKnownConfig.chatEtaColors) !== JSON.stringify(config.chatEtaColors)) {
      appearanceChanged = true;
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

  const currentConfigTab = resolveAvailableTab(configuredTab);
  const tabChangedExternally = (currentConfigTab !== chatOverlayCurrentTab);
  if (tabChangedExternally) {
    selectTab(currentConfigTab, currentConfigTab !== configuredTab);
  } else if ((channelsChanged && chatOverlayCurrentTab === 'Basic') || npcChatSettingChanged || blacklistFiltersChanged || customTabsChanged || gainSettingsChanged || visibleTabsChanged) {
    // 조회 조건이 바뀌면 현재 검색어를 유지하며 이전 응답은 요청 세대로 무효화한다.
    if (isSearchMode && currentSearchQuery) void executeSearch(currentSearchQuery);
    else void loadHistory();
  } else if (appearanceChanged) {
    refreshChatAppearance();
  }
});

// Mode configuration for Main/Sub windows
window.electronAPI.onChatOverlayMode((mode) => {
  chatOverlayMode = mode;
  isModeReceived = true;
  if (chatOverlayAppConfig) applyConfigStyles(chatOverlayAppConfig);
  
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
  btnClose.addEventListener('click', closeCurrentChatOverlay);
}

// Resize Drag Control
let chatOverlayIsResizing = false;
let chatOverlayStartX = 0;
let chatOverlayStartY = 0;
let chatOverlayStartWidth = 0;
let chatOverlayStartHeight = 0;
let chatOverlayResizeFrame: number | null = null;
let pendingChatOverlaySize: { width: number; height: number } | null = null;

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
  
  pendingChatOverlaySize = { width: newWidth, height: newHeight };
  if (chatOverlayResizeFrame === null) {
    chatOverlayResizeFrame = requestAnimationFrame(() => {
      chatOverlayResizeFrame = null;
      if (!pendingChatOverlaySize) return;
      window.electronAPI.setChatOverlaySize(
        chatOverlayMode,
        pendingChatOverlaySize.width,
        pendingChatOverlaySize.height,
      );
      pendingChatOverlaySize = null;
    });
  }
});

window.addEventListener('mouseup', (e) => {
  if (!chatOverlayIsResizing) return;
  chatOverlayIsResizing = false;
  if (chatOverlayResizeFrame !== null) cancelAnimationFrame(chatOverlayResizeFrame);
  chatOverlayResizeFrame = null;
  pendingChatOverlaySize = null;
  
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

// 필터로 빈 페이지가 이어져도 다음 스크롤 이벤트를 기다리지 않고 표시할 기록을 찾는다.
// 최초 화면은 스크롤 가능한 높이까지 채우고, 위쪽 탐색은 기존 앵커를 유지한다.
async function loadMoreHistory(fillViewport = false): Promise<void> {
  if (isSearchMode || isLoadingMore || hasReachedEnd || !activeChatViewRequest) return;
  isLoadingMore = true;
  const requestedTab = chatOverlayCurrentTab;
  const requestedView = activeChatViewRequest;
  const requestGeneration = ++paginationGeneration;
  const isCurrent = () => requestGeneration === paginationGeneration
    && chatViewRequests.isCurrent(requestedView)
    && requestedTab === chatOverlayCurrentTab && !isSearchMode;
  const needsMoreHeight = () => chatArea.scrollHeight <= chatArea.clientHeight + 1;
  try {
    // 가상 목록의 행 높이 측정과 탭/검색 전환이 페이지 사이에 실행될 수 있게 양보한다.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!isCurrent() || (fillViewport && !needsMoreHeight())) return;
    while (isCurrent() && !hasReachedEnd) {
      const newItems = await window.electronAPI.getMoreChatHistory(requestedTab);
      if (!isCurrent()) return;
      const followEnd = fillViewport && chatVirtualList.isAtEnd(2);
      const added = prependChatViewItems((newItems || []).filter(shouldShowChat));
      if (followEnd) chatVirtualList.scrollToEnd();
      hasReachedEnd = !newItems || newItems.length < 150;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (added > 0 && !needsMoreHeight()) break;
    }
  } catch (err) {
    if (isCurrent()) console.error('Failed to load more chat history:', err);
  } finally {
    if (requestGeneration === paginationGeneration) isLoadingMore = false;
  }
}

// Scroll Event for Infinite Scroll
chatArea.addEventListener('scroll', () => {
  if (!isSearchMode && !isChatViewLoading && chatArea.scrollTop <= 5) {
    void loadMoreHistory();
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
