// 창/프로필을 오가는 늦은 응답을 같은 순서로 비교한다.
let revision=0;
export const stopwatchRevision=():number => revision;
export const nextStopwatchRevision=():number => ++revision;
