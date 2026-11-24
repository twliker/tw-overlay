/** 캐릭터 XP 변동과 처치 집계를 구분한다. 룬·클럽 XP는 줄 앞에 별도 이름이 붙는다. */
export function parseCharacterXpLog(message:string):{amountText:string;isGain:boolean;countsAsKill:boolean} | undefined {
  if (typeof message!=='string') return undefined;
  const match=message.match(/^경험치가\s+([\[\]\d,억만\s]+)\s*(올랐|상승|감소|차감)/);
  if (!match) return undefined;
  const verb=match[2];
  // 사냥 로그는 ‘올랐습니다’, 콘텐츠 클리어 보상은 ‘상승했습니다’로 기록된다.
  return {amountText:match[1],isGain:verb==='올랐' || verb==='상승',countsAsKill:verb==='올랐'};
}
