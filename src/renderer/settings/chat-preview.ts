interface Window { settingsChatPreview: { refresh(): void }; }

/** 설정 초안의 글꼴을 실제 채팅과 같은 resolver로 미리 보여 준다. 저장은 기존 설정 버튼이 담당한다. */
(() => {
  let generation = 0;
  const value = (id: string) => (document.getElementById(`chat-overlay-${id}-input`) as HTMLInputElement | null)?.value;
  function refresh(): void {
    const revision = ++generation;
    const readingPreview = document.getElementById('chat-reading-preview');
    if (readingPreview) window.chatChannels.applyReadingDisplay(readingPreview, {
      chatCompactDisplay: (document.getElementById('chat-compact-display') as HTMLInputElement | null)?.checked,
    });
    const pending: Promise<boolean>[] = [];
    const config: BrowserAppConfig = {
      chatOverlayFontSize: Number(value('fontsize')) || 14,
      chatOverlayFontFamily: value('fontfamily'),
      chatOverlaySubFontSize: Number(value('sub-fontsize')) || 0,
      chatOverlaySubFontFamily: value('sub-fontfamily'),
      chatOverlaySub2FontSize: Number(value('sub2-fontsize')) || 0,
      chatOverlaySub2FontFamily: value('sub2-fontfamily'),
    } as BrowserAppConfig;
    const eta = {
      chatEtaColorsEnabled: (document.getElementById('chat-eta-colors-enabled') as HTMLInputElement | null)?.checked,
      chatEtaColors: [0, 1, 2, 3, 4].map(index => (document.getElementById(`chat-eta-color-${index}`) as HTMLInputElement | null)?.value || '#facc15'),
    };
    for (let index = 0; index < 5; index++) {
      const badge = document.getElementById(`chat-eta-preview-${index}`);
      const color = window.chatChannels.getEtaColor(index * 20 + 1, eta);
      if (badge) { badge.style.color = color || '#fff'; badge.style.background = color ? `${color}18` : 'linear-gradient(135deg,#a855f7,#3b82f6)'; }
    }
    for (const mode of ['main', 'sub1', 'sub2'] as const) {
      const preview = document.getElementById(`chat-font-preview-${mode}`);
      if (!preview) continue;
      const font = window.chatChannels.resolveChatFont(config, mode);
      preview.style.fontFamily = font.family;
      preview.style.fontSize = `${font.size}px`;
      pending.push(window.customChatFonts?.load(font.key) || Promise.resolve(true));
    }
    void Promise.all(pending).then(results => {
      if (revision !== generation) return;
      const status = document.getElementById('chat-font-status');
      if (status) status.textContent = results.includes(false) ? '글꼴을 읽을 수 없어 기본 글꼴로 표시합니다. 파일을 다시 추가해 주세요.' : '';
    });
  }
  document.getElementById('chat-font-add')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    const status = document.getElementById('chat-font-status');
    button.disabled = true;
    try {
      const result = await (window.electronAPI as typeof window.electronAPI & ChatFontApi).importChatFont();
      if (result.error) throw new Error(result.error);
      if (!result.font) return;
      if (!await window.customChatFonts.load(result.font.id)) throw new Error('이 글꼴을 읽을 수 없습니다. 다른 파일을 선택해 주세요.');
      await window.customChatFonts.refreshOptions();
      const select = document.getElementById('chat-overlay-fontfamily-input') as HTMLSelectElement;
      select.value = result.font.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) { if (status) status.textContent = error instanceof Error ? error.message : '글꼴을 추가하지 못했습니다.'; }
    finally { button.disabled = false; }
  });
  document.getElementById('chat-font-use-main')?.addEventListener('click', () => {
    for (const mode of ['sub', 'sub2']) {
      const select = document.getElementById(`chat-overlay-${mode}-fontfamily-input`) as HTMLSelectElement;
      select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  void window.customChatFonts?.refreshOptions().then(refresh);
  document.getElementById('chat-font-settings')?.addEventListener('input', refresh);
  document.getElementById('chat-font-settings')?.addEventListener('change', refresh);
  document.getElementById('eta-color-settings')?.addEventListener('input', refresh);
  document.getElementById('chat-compact-display')?.addEventListener('input', refresh);
  window.settingsChatPreview = { refresh };
})();
