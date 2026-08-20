/**
 * 숙제 체크리스트에서 동적 텍스트를 안전하게 렌더링하는 DOM 헬퍼.
 * 사용자 입력은 innerHTML 보간 없이 항상 textContent로 삽입합니다.
 */
(() => {
  function createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className = '',
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createIcon(name: string, className: string): HTMLElement {
    const icon = createElement('i', className);
    icon.setAttribute('data-lucide', name);
    return icon;
  }

  function createBadge(text: string, className: string): HTMLSpanElement {
    return createElement('span', className, text);
  }

  function createIconButton(options: {
    icon: string;
    className: string;
    iconClassName: string;
    title?: string;
    onClick: (event: MouseEvent) => void;
  }): HTMLButtonElement {
    const button = createElement('button', options.className);
    button.type = 'button';
    if (options.title) button.title = options.title;
    button.appendChild(createIcon(options.icon, options.iconClassName));
    button.addEventListener('click', options.onClick);
    return button;
  }

  function setStatusButtonContent(
    button: HTMLButtonElement,
    characterName: string,
    statusText: string,
    statusClassName: string,
  ): void {
    button.replaceChildren(
      createElement('span', '', characterName),
      createElement('span', statusClassName, statusText),
    );
  }

  window.contentsDomRendering = Object.freeze({
    createElement,
    createIcon,
    createBadge,
    createIconButton,
    setStatusButtonContent,
  });
})();
