import type { SupplyInstruction, SupplyRunState, SupplyPadColor } from './types';

const patterns: Array<[RegExp, SupplyPadColor[]]> = [
  [/^파란\s*하늘\s*아래\s*개나리\s*한\s*송이와\s*붉은\s*장미/, ['파랑', '노랑', '빨강']],
  [/^붉은\s*노을이\s*지고\s*칠흑\s*같은\s*어둠이\s*내려앉은\s*바다/, ['빨강', '검정', '파랑']],
  [/^하얀\s*종이\s*위에\s*펼쳐져\s*있는\s*푸른\s*바다와\s*달콤한\s*꿀\s*내음/, ['흰색', '파랑', '노랑']],
];

/** 기능 계약: 실제 시스템 안내의 입장/세 가지 암호/성공·실패만 해석한다.
 * 닉네임이나 외치기 접두사가 있는 인용 대화는 매칭하지 않는다. 미확인 암호를 추측하지 않는다.
 * 실시간 파서만 게임 기믹 알림에 연결하며, 과거 로그 분석으로 안내를 재생하지 않는다.
 * 입장 자체는 화면에 표시하지 않고, 유효한 암호의 색상 순서만 10초간 표시한다.
 * 성공·실패는 즉시 안내를 지우며, 종료 로그 누락 시 입장 상태는 30분 후 만료된다.
 */
export function parseSupplyInstruction(message: string): SupplyInstruction | null {
  const text = message.trim();
  if (/^경보\s*장치\s*4개를\s*모두\s*해제하고\s*보급품이\s*보관\s*되어\s*있는\s*막사를\s*찾으시오\.$/.test(text)) return { phase: 'start' };
  if (/^보급품\s*탈환에\s*(?:성공|실패)\s*하였/.test(text)) return { phase: 'end' };
  for (const [pattern, colors] of patterns) if (pattern.test(text)) return { phase: 'order', colors: [...colors] };
  return null;
}

export class SupplyRun {
  private state: SupplyRunState = { expiresAt: 0, orderExpiresAt: 0, colors: [] };
  observe(event: SupplyInstruction, now: number): boolean {
    if (event.phase === 'start') {
      this.state = { expiresAt: now + 30 * 60_000, orderExpiresAt: 0, colors: [] };
    } else if (event.phase === 'end') {
      this.state = { expiresAt: 0, orderExpiresAt: 0, colors: [] };
    } else if (now < this.state.expiresAt && this.state.expiresAt - now <= 30 * 60_000) {
      this.state = { ...this.state, orderExpiresAt: now + 10_000, colors: [...(event.colors || [])] };
    } else return false;
    return true;
  }
  snapshot(): SupplyRunState { return structuredClone(this.state); }
}
