/** 설정 화면의 사용자 입력 기반 목록을 안전하게 생성합니다. */
(() => {
  function createIcon(name: string, className: string): HTMLElement {
    const icon = document.createElement('i');
    icon.className = className;
    icon.setAttribute('data-lucide', name);
    return icon;
  }

  function createKeywordTag(
    keyword: string,
    className: string,
    onRemove: () => void,
  ): HTMLSpanElement {
    const tag = document.createElement('span');
    tag.className = className;
    tag.appendChild(document.createTextNode(`${keyword} `));

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.appendChild(createIcon('x', 'w-3.5 h-3.5'));
    removeButton.addEventListener('click', onRemove);
    tag.appendChild(removeButton);
    return tag;
  }

  function createCustomSoundRow(options: {
    sound: SoundListItem;
    onPreview: () => void;
    onRename: (name: string) => void;
    onDelete: () => void;
  }): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 p-3 bg-white/5 border border-white/5 rounded-xl transition-all hover:bg-white/[0.08]';

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500 hover:text-white flex items-center justify-center transition-all active:scale-95';
    previewButton.title = '미리듣기';
    previewButton.appendChild(createIcon('play', 'w-4 h-4'));
    previewButton.addEventListener('click', options.onPreview);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = options.sound.name;
    nameInput.className = 'w-full bg-black/40 border border-white/10 focus:border-purple-500 transition-all rounded-xl px-3 py-1.5 text-sm text-white';
    nameInput.placeholder = '알림음 이름 입력';
    nameInput.addEventListener('change', () => options.onRename(nameInput.value));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all active:scale-95';
    deleteButton.title = '삭제';
    deleteButton.appendChild(createIcon('trash-2', 'w-4 h-4'));
    deleteButton.addEventListener('click', options.onDelete);

    row.append(previewButton, nameInput, deleteButton);
    return row;
  }

  window.settingsListRendering = Object.freeze({
    createKeywordTag,
    createCustomSoundRow,
  });
})();
