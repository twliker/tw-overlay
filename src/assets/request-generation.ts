/** 비동기 화면 요청의 최신 응답만 상태를 변경하도록 하는 작은 generation 경계. */

(() => {
interface ViewRequestToken {
  generation: number;
  key: string;
}

window.createViewRequestGeneration = function () {
  let generation = 0;
  let currentKey: string | null = null;
  return Object.freeze({
    begin(key: string): ViewRequestToken {
      generation += 1;
      currentKey = key;
      return { generation, key };
    },
    isCurrent(token: ViewRequestToken): boolean {
      return token.generation === generation && token.key === currentKey;
    },
    invalidate(): void {
      generation += 1;
      currentKey = null;
    },
    currentKey: () => currentKey,
  });
};
})();
