interface SidebarMenuActivationApi {
  bind(element: HTMLElement, action: () => void): void;
}

interface Window {
  sidebarMenuActivation: SidebarMenuActivationApi;
}

(function exposeSidebarMenuActivation(globalObject: Window | null): void {
  /**
   * [기능 계약: 사이드바 플라이아웃 메뉴의 첫 클릭]
   *
   * - 1depth 카테고리는 기존처럼 hover/focus로 플라이아웃을 열며, 클릭식 메뉴로 바꾸지 않는다.
   * - 외부 프로그램이 foreground인 상태에서 플라이아웃 항목을 누르면 Windows가 먼저
   *   사이드바를 활성화한다. 이때 main 프로세스의 `외부 < 게임 < TW-Overlay` 복구가
   *   게임과 사이드바 사이에서 포커스를 한 번 왕복시키므로, `mouseup`까지 같은 창에
   *   남아 있어야 생성되는 일반 `click` 이벤트는 취소될 수 있다.
   * - 따라서 실제 마우스의 주 버튼은 포커스 왕복 전인 `mousedown`에서 한 번 실행하고,
   *   뒤이어 도착하는 `click(detail > 0)`은 중복 실행하지 않는다.
   * - 키보드 Enter/Space와 `element.click()`은 `mousedown` 없이 `click(detail === 0)`만
   *   발생하므로 기존 접근성·자동화 동작을 그대로 실행한다. 보조 버튼은 실행하지 않는다.
   *
   * 이 경계는 z-order/관리자 권한 정책을 우회하기 위한 것이 아니다. 창 활성화 정책을
   * 변경하지 않고 사용자가 누른 메뉴 명령만 포커스 전환 전에 확정하기 위한 입력 계약이다.
   */
  const api: SidebarMenuActivationApi = Object.freeze({
    bind(element: HTMLElement, action: () => void) {
      element.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.button === 0) action();
      });
      element.addEventListener('click', (event: MouseEvent) => {
        if (event.detail === 0) action();
      });
    },
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (globalObject) {
    globalObject.sidebarMenuActivation = api;
  }
})(typeof window !== 'undefined' ? window : null);
