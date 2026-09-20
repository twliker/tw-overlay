interface ChatFontApi {
  importChatFont(): Promise<{ font?: { id: string; label: string }; error?: string }>;
  listChatFonts(): Promise<Array<{ id: string; label: string }>>;
  readChatFont(id: string): Promise<Uint8Array | null>;
}
interface Window {
  customChatFonts: {
    load(key: string): Promise<boolean>;
    ensureOption(select: HTMLSelectElement | null, key: string): void;
    refreshOptions(): Promise<void>;
  };
}
/** 브라우저의 글꼴 검증을 통과한 파일만 사용한다. 로드 실패는 기본 글꼴로 표시하고 설정 ID는 보존한다. */
(() => {
  const api = window.electronAPI as typeof window.electronAPI & ChatFontApi;
  const loaded = new Map<string, Promise<boolean>>();
  let available: Array<{ id: string; label: string }> = [];
  const selectors = ['chat-overlay-fontfamily-input', 'chat-overlay-sub-fontfamily-input', 'chat-overlay-sub2-fontfamily-input'];
  function ensureOption(select: HTMLSelectElement | null, key: string): void {
    if (!select || !/^custom:[a-f0-9]{64}$/.test(key)) return;
    let option = Array.from(select.options).find(option => option.value === key);
    if (!option) { option = document.createElement('option'); option.value = key; select.add(option); }
    option.textContent = available.find(font => font.id === key)?.label || '이 PC에 없는 글꼴 (기본 글꼴로 표시)';
  }
  async function load(key: string): Promise<boolean> {
    if (!/^custom:[a-f0-9]{64}$/.test(key)) return true;
    let task = loaded.get(key);
    if (!task) {
      task = (async () => {
        try {
          const data = await api.readChatFont(key);
          if (!data) return false;
          const font = new FontFace(`tw-${key.slice(7)}`, new Uint8Array(data));
          await font.load(); (document.fonts as FontFaceSet & { add(font: FontFace): void }).add(font); return true;
        } catch { return false; }
      })();
      loaded.set(key, task);
    }
    const result = await task;
    if (!result) loaded.delete(key); // 같은 파일을 나중에 추가하면 다시 시도할 수 있다.
    return result;
  }
  async function refreshOptions(): Promise<void> {
    available = api.listChatFonts ? await api.listChatFonts().catch(() => []) : [];
    for (const id of selectors) {
      const select = document.getElementById(id) as HTMLSelectElement | null;
      for (const font of available) ensureOption(select, font.id);
    }
  }
  window.customChatFonts = { load, ensureOption, refreshOptions };
})();
