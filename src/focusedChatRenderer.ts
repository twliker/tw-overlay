namespace FocusedChatRenderer {

const targetForm = document.getElementById('targetForm') as HTMLFormElement;
const selfForm = document.getElementById('selfForm') as HTMLFormElement;
const selfNicknameInput = document.getElementById('selfNicknameInput') as HTMLInputElement;
const nicknameInput = document.getElementById('nicknameInput') as HTMLInputElement;
const selfNicknameSuggestions = document.getElementById('selfNicknameSuggestions') as HTMLDivElement;
const targetNicknameSuggestions = document.getElementById('targetNicknameSuggestions') as HTMLDivElement;
const targetList = document.getElementById('targetList') as HTMLDivElement;
const messageList = document.getElementById('messageList') as HTMLElement;
const roomStatus = document.getElementById('roomStatus') as HTMLDivElement;
const nicknameSettingsPanel = document.getElementById('nicknameSettingsPanel') as HTMLElement;
const panelToggleButton = document.getElementById('panelToggleButton') as HTMLButtonElement;
const closeButton = document.getElementById('closeButton') as HTMLButtonElement;
const resizeHandle = document.getElementById('resizeHandle') as HTMLDivElement;

let targets: string[] = [];
let selfNickname = '';
let knownNicknames: string[] = [];
let history: BrowserChatItem[] = [];

interface AutocompleteController {
  refresh: () => void;
  close: () => void;
}

let selfAutocomplete: AutocompleteController | null = null;
let targetAutocomplete: AutocompleteController | null = null;

const visibleChannels = new Set(['general', 'team', 'club', 'whisper']);

function normalizeNickname(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('ko-KR');
}

function isSelfMessage(item: BrowserChatItem): boolean {
  const sender = normalizeNickname(item.sender || '');
  return (selfNickname !== '' && sender === normalizeNickname(selfNickname))
    || item.isSelf === true
    || item.color.toLowerCase() === window.chatChannels.COLORS.selfGeneral;
}

function isVisibleMessage(item: BrowserChatItem): boolean {
  if (!visibleChannels.has(item.type)) return false;
  if (isSelfMessage(item)) return true;
  const sender = normalizeNickname(item.sender || '');
  return targets.some(target => normalizeNickname(target) === sender);
}

function getChannelLabel(type: string): string {
  const labels: Record<string, string> = {
    general: '일반', team: '팀', club: '클럽', whisper: '귓속말'
  };
  return labels[type] || type;
}

function createEmptyState(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  const card = document.createElement('div');
  card.className = 'empty-card';
  const icon = document.createElement('div');
  icon.className = 'empty-icon';
  const iconElement = document.createElement('i');
  iconElement.setAttribute('data-lucide', targets.length === 0 ? 'user-plus' : 'message-circle');
  icon.appendChild(iconElement);
  const title = document.createElement('h2');
  title.className = 'empty-title';
  title.textContent = targets.length === 0 ? '대화 상대를 추가해주세요' : '아직 표시할 대화가 없습니다';
  const description = document.createElement('p');
  description.className = 'empty-description';
  description.textContent = targets.length === 0
    ? '내 닉네임과 놓치고 싶지 않은 상대 닉네임을 등록하면 해당 사용자들의 대화만 모아 보여줍니다.'
    : '등록한 사용자에게서 새 메시지가 오면 실시간으로 표시됩니다. 내 닉네임의 메시지는 오른쪽에 표시됩니다.';
  card.append(icon, title, description);
  wrapper.appendChild(card);
  return wrapper;
}

function createMessage(item: BrowserChatItem): HTMLElement {
  const self = isSelfMessage(item);
  const row = document.createElement('article');
  row.className = `message-row${self ? ' self' : ''}`;
  const block = document.createElement('div');
  block.className = 'message-block';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = item.sender;
  const channel = document.createElement('span');
  channel.className = `channel channel-${item.type}`;
  channel.textContent = getChannelLabel(item.type);
  meta.append(sender, channel);
  if (item.level !== undefined && item.level !== null) {
    const etaBadge = document.createElement('span');
    etaBadge.className = 'eta-badge';
    etaBadge.textContent = `에타 ${item.level}`;
    meta.appendChild(etaBadge);
  }
  const bubbleLine = document.createElement('div');
  bubbleLine.className = 'bubble-line';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = item.message;
  const time = document.createElement('time');
  time.className = 'time';
  time.textContent = window.chatChannels.formatTimestamp(item.timestamp);
  bubbleLine.append(bubble, time);
  block.append(meta, bubbleLine);
  row.appendChild(block);
  return row;
}

function refreshIcons(): void {
  if (window.lucide) window.lucide.createIcons();
}

function renderMessages(scrollToBottom = true): void {
  const visible = history.filter(isVisibleMessage);
  messageList.replaceChildren();
  if (visible.length === 0) {
    messageList.appendChild(createEmptyState());
  } else {
    const fragment = document.createDocumentFragment();
    visible.forEach(item => fragment.appendChild(createMessage(item)));
    messageList.appendChild(fragment);
  }
  refreshIcons();
  if (scrollToBottom) messageList.scrollTop = messageList.scrollHeight;
}

function saveTargets(): void {
  window.electronAPI.setFocusedChatTargets([...targets]);
}

function getSuggestionCandidates(): string[] {
  const candidates = [...knownNicknames, selfNickname, ...targets]
    .map(value => value.normalize('NFC').trim())
    .filter(Boolean);
  const unique = new Map(candidates.map(value => [normalizeNickname(value), value]));
  return [...unique.values()].sort((left, right) => left.localeCompare(right, 'ko'));
}

function setupAutocomplete(input: HTMLInputElement, menu: HTMLDivElement): AutocompleteController {
  let activeIndex = -1;
  let filtered: string[] = [];

  function close(): void {
    activeIndex = -1;
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function choose(index: number): void {
    const value = filtered[index];
    if (!value) return;
    input.value = value;
    close();
  }

  function render(open = document.activeElement === input): void {
    const query = normalizeNickname(input.value);
    filtered = getSuggestionCandidates().filter(value => !query || normalizeNickname(value).includes(query));
    if (activeIndex >= filtered.length) activeIndex = filtered.length - 1;
    menu.replaceChildren();

    filtered.forEach((value, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = `${menu.id}-option-${index}`;
      option.className = `autocomplete-option${index === activeIndex ? ' active' : ''}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === activeIndex));
      option.textContent = value;
      option.addEventListener('mousedown', event => {
        event.preventDefault();
        choose(index);
      });
      menu.appendChild(option);
    });

    menu.hidden = !open || filtered.length === 0;
    input.setAttribute('aria-expanded', String(!menu.hidden));
    const active = menu.querySelector('.autocomplete-option.active') as HTMLElement | null;
    if (active) {
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  input.addEventListener('focus', () => render(true));
  input.addEventListener('input', () => {
    activeIndex = -1;
    render(true);
  });
  input.addEventListener('blur', () => window.setTimeout(close, 0));
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) {
        activeIndex = event.key === 'ArrowDown' ? 0 : filtered.length - 1;
      } else if (filtered.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        activeIndex = (activeIndex + direction + filtered.length) % filtered.length;
      }
      render(true);
      return;
    }
    if (event.key === 'Enter' && !menu.hidden && activeIndex >= 0) {
      event.preventDefault();
      event.stopPropagation();
      choose(activeIndex);
    }
  });

  return { refresh: () => render(), close };
}

function renderSuggestions(): void {
  selfAutocomplete?.refresh();
  targetAutocomplete?.refresh();
}

function rememberSuggestion(sender: string): void {
  const nickname = sender.normalize('NFC').trim();
  const excluded = new Set(['나', '시스템', '시스템 공지', '시스템 알림', '귓속말', '팀 알림', '클럽 알림', '클럽 공지']);
  if (!nickname || excluded.has(nickname)) return;
  if (!knownNicknames.some(value => normalizeNickname(value) === normalizeNickname(nickname))) {
    knownNicknames.push(nickname);
    if (knownNicknames.length > 300) knownNicknames.shift();
    renderSuggestions();
  }
}

function removeTarget(target: string): void {
  const normalized = normalizeNickname(target);
  targets = targets.filter(item => normalizeNickname(item) !== normalized);
  saveTargets();
  renderTargets();
  renderMessages();
}

function renderTargets(): void {
  targetList.replaceChildren();
  renderSuggestions();
  const selfStatus = selfNickname ? `${selfNickname} 기준` : '내 닉네임 미설정';
  roomStatus.textContent = targets.length > 0 ? `${selfStatus} · 상대 ${targets.length}명` : `${selfStatus} · 대화 상대를 등록해주세요`;
  if (targets.length === 0) {
    const help = document.createElement('span');
    help.className = 'target-help';
    help.textContent = '닉네임은 정확히 일치할 때만 표시됩니다.';
    targetList.appendChild(help);
    return;
  }
  targets.forEach(target => {
    const chip = document.createElement('div');
    chip.className = 'target-chip';
    const label = document.createElement('span');
    label.textContent = target;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-target';
    remove.title = `${target} 제거`;
    remove.setAttribute('aria-label', `${target} 제거`);
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'x');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    remove.appendChild(icon);
    remove.addEventListener('click', () => removeTarget(target));
    chip.append(label, remove);
    targetList.appendChild(chip);
  });
  refreshIcons();
}

function applyState(state: BrowserFocusedChatState): void {
  selfNickname = typeof state.selfNickname === 'string'
    ? state.selfNickname.normalize('NFC').trim()
    : '';
  selfNicknameInput.value = selfNickname;
  const configuredTargets = Array.isArray(state.targets) ? state.targets : [];
  const nextTargets = configuredTargets
    .map(value => value.normalize('NFC').trim())
    .filter(Boolean);
  const unique = new Map(nextTargets.map(value => [normalizeNickname(value), value]));
  targets = [...unique.values()];
  knownNicknames = Array.isArray(state.knownNicknames) ? [...state.knownNicknames] : [];
  renderTargets();
  renderMessages(false);
  renderSuggestions();
}

selfForm.addEventListener('submit', event => {
  event.preventDefault();
  selfNickname = selfNicknameInput.value.normalize('NFC').trim();
  window.electronAPI.setFocusedChatSelfNickname(selfNickname);
  selfAutocomplete?.close();
  renderTargets();
  renderMessages();
  selfNicknameInput.blur();
});

targetForm.addEventListener('submit', event => {
  event.preventDefault();
  const nickname = nicknameInput.value.normalize('NFC').trim();
  if (!nickname) return;
  if (!targets.some(target => normalizeNickname(target) === normalizeNickname(nickname))) {
    targets.push(nickname);
    saveTargets();
  }
  nicknameInput.value = '';
  targetAutocomplete?.close();
  renderTargets();
  renderMessages();
  nicknameInput.focus();
});

closeButton.addEventListener('click', () => window.close());

panelToggleButton.addEventListener('click', () => {
  const collapsed = nicknameSettingsPanel.classList.toggle('collapsed');
  panelToggleButton.classList.toggle('is-collapsed', collapsed);
  panelToggleButton.setAttribute('aria-expanded', String(!collapsed));
  panelToggleButton.title = collapsed ? '닉네임 설정 펼치기' : '닉네임 설정 접기';
  panelToggleButton.setAttribute('aria-label', panelToggleButton.title);
});

let isResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;
let resizeFrame: number | null = null;
let pendingResize: { width: number; height: number } | null = null;

resizeHandle.addEventListener('mousedown', event => {
  event.preventDefault();
  event.stopPropagation();
  isResizing = true;
  resizeStartX = event.screenX;
  resizeStartY = event.screenY;
  resizeStartWidth = window.outerWidth || 460;
  resizeStartHeight = window.outerHeight || 720;
});

window.addEventListener('mousemove', event => {
  if (!isResizing) return;
  const width = Math.max(360, resizeStartWidth + event.screenX - resizeStartX);
  const height = Math.max(360, resizeStartHeight + event.screenY - resizeStartY);
  pendingResize = { width, height };
  if (resizeFrame === null) {
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (!pendingResize) return;
      window.electronAPI.setFocusedChatSize(pendingResize.width, pendingResize.height);
      pendingResize = null;
    });
  }
});

window.addEventListener('mouseup', () => {
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
  resizeFrame = null;
  if (pendingResize) window.electronAPI.setFocusedChatSize(pendingResize.width, pendingResize.height);
  pendingResize = null;
  isResizing = false;
});

selfAutocomplete = setupAutocomplete(selfNicknameInput, selfNicknameSuggestions);
targetAutocomplete = setupAutocomplete(nicknameInput, targetNicknameSuggestions);

function appendSingleMessage(item: BrowserChatItem): void {
  const emptyState = messageList.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }

  const isAtBottom = (messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight) < 50;
  const messageNode = createMessage(item);
  messageList.appendChild(messageNode);

  const messageRows = messageList.querySelectorAll('.message-row');
  if (messageRows.length > 150) {
    messageRows[0].remove();
  }

  if (isAtBottom) {
    messageList.scrollTop = messageList.scrollHeight;
  }
}

window.electronAPI.onChatUpdated(item => {
  if (item.type !== 'system' && item.type !== 'shout') rememberSuggestion(item.sender || '');
  history.push(item);
  if (history.length > 150) history.shift();
  if (isVisibleMessage(item)) appendSingleMessage(item);
});
window.electronAPI.onChatHistoryCleared(async () => {
  history = await window.electronAPI.getFocusedChatHistory();
  renderMessages();
});

window.addEventListener('beforeunload', () => window.electronAPI.cleanupAllListeners());

async function initialize(): Promise<void> {
  const [state, chatHistory] = await Promise.all([
    window.electronAPI.getFocusedChatState(),
    window.electronAPI.getFocusedChatHistory()
  ]);
  history = chatHistory;
  applyState(state);
  renderMessages();
  refreshIcons();
}

void initialize();
}
