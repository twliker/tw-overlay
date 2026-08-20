/**
 * HTML 파싱, 프롬프트, 응답 파싱, 테스트 시나리오
 */
import * as config from '../config';
import * as wm from '../windowManager';
import * as path from 'path';
import type { MessengerMessage, ScamAnalysisResult } from '../../shared/types';

const chatChannels = require('../../shared/chatChannels') as ChatChannelConstants;
const CHAT_COLORS = chatChannels.COLORS;

// ── 상수 ──
export const MAX_MESSAGES_FOR_PROMPT = 80;
export const SCAM_ALERT_SOUND = 'orb.mp3';
export const END_KEYWORDS = ['종료', '나가셨습니다', '대화를 마쳤습니다', '채팅이 종료'];

// ── HTML 파싱 ──
const TS_RE = /color="white">\s*\[(\d+)(?:시|분)\s+(\d+)분\s+(\d+)(?:초|분)\]/;
const MSG_RE = new RegExp(`color="(${CHAT_COLORS.selfGeneral}|${CHAT_COLORS.general})">([\\s\\S]*?)<\\/font>`);
const SYS_RE = /color="#c8c8ff">([\s\S]*?)<\/font>/;

export function parseLine(line: string): MessengerMessage | null {
  const tsMatch = line.match(TS_RE);
  const timestamp = tsMatch
    ? `${String(tsMatch[1]).padStart(2, '0')}:${String(tsMatch[2]).padStart(2, '0')}:${String(tsMatch[3]).padStart(2, '0')}`
    : '';

  const sysMatch = line.match(SYS_RE);
  if (sysMatch) {
    const content = sysMatch[1].trim();
    if (!content) return null;
    return { timestamp, sender: 'SYSTEM', content, isSystem: true };
  }

  const msgMatch = line.match(MSG_RE);
  if (msgMatch) {
    const color = msgMatch[1];
    const raw = msgMatch[2].trim();
    const colonIdx = raw.indexOf(':');
    if (colonIdx < 0) return null;
    const sender = raw.slice(0, colonIdx).trim();
    const content = raw.slice(colonIdx + 1).trim();
    if (!sender || !content) return null;
    const isSelf = color === CHAT_COLORS.selfGeneral;
    return { timestamp, sender, content, isSystem: false, isSelf };
  }

  return null;
}

// ── 시스템 프롬프트 ──
export const SCAM_SYSTEM_PROMPT = `[Role & Objective]

너는 테일즈위버 게임 내 1:1 채팅 및 거래 로그를 분석하여 사기 위험성을 판독하는 전문 보안 조사관이야.

사용자가 대화 내용, 정황, 또는 채팅 로그를 입력하면, 아래의 [테일즈위버 사기 패턴 데이터베이스]를 바탕으로 뉘앙스와 키워드를 분석해 위험도(안전/주의/위험)를 엄격하게 평가하고 그 이유를 설명해줘.



[테일즈위버 사기 패턴 데이터베이스]

1. 존재하지 않는 시스템/단어 언급 (위험도: 1000%)

- 정상적인 1:1 거래는 교환창에 아이템을 올리고 그에 맞는 '시드'를 교환하는 것뿐이다.
- 위험 키워드: 쪽지, 코드, 별전, 보증, Ctrl 1 2, 가중치, 상속거래, 녜힁, 롤벤 등. (사기꾼은 매번 단어를 지어내므로, 단순 교환 이외의 시스템이나 절차를 언급하면 무조건 사기)
- 행동 패턴: 거래를 풀기 위해 특정 과정이 필요하다거나, 쪽지로 코드를 입력하라고 유도함.


2. 교묘한 2인 1조 사칭 (위험도: 1000%)

- 상황: 거래 중인 판매자와 동시에, 소속 클럽장/클럽원으로 위장한 아이디가 1:1 대화를 걸어옴.
- 위장 패턴: 아이디 앞에 특수문자나 직책을 붙임 (예: 클럽장- 햄찌, M- 햄찌, [클럽]햄찌).
- 목적: 가짜 시스템(가중치, 롤벤 등)이 실제 존재하는 것처럼 바람을 잡음. 뉴비/복귀 유저의 판단력을 흐리게 만듦.


3. 추가 시드 및 현금 유도 (위험도: 1000%)

- 사기 진행 중 "시드가 막혔다", "거래 정지를 먹었다", "가중치를 풀어야 한다" 등의 핑계를 댐.
- 네냐플 시드 판매자나 외부 거래소(매니아 등)에서 추가로 시드를 구매해 넘기도록 유도함. (고소를 피하기 위해 현금 대신 시드를 집요하게 요구함)


4. 거래 상대방의 스펙 및 행동 이상 (위험도: 99%)

- 레벨 및 에타 레벨 확인: 거래 상대방의 레벨이 310 미만이거나, '에타 레벨'이 없거나 현저히 낮은 경우. (에타 레벨은 육성 난이도가 매우 높아 사기꾼의 도용/급조 계정은 에타 레벨이 높은 경우가 거의 없음. 특히 Lv 200 언저리의 녹턴, 로아미니는 도용 계정일 확률이 매우 높음)
- 아이템 미등록: 교환창을 열고 3분 이상 구매하려는 아이템을 올리지 않고 말로만 시간을 끄는 경우.


5. 3자 사기 정황 (위험도: 99%)

- 사기꾼이 아이템 판매자와 구매자 사이에서 중개인 행세를 하며, 타 게임(예: 메이플스토리 등)의 재화 거래를 엮어 계좌 입금을 유도함.
- 방어책 회피: 무통장/계좌이체 거래 시 입금자명을 '테일즈위버 본인아이디 @@@억' 형태로 강제하는 것을 회피하거나 거부하면 사기.


6. 🟢 정상 거래 판단 기준 — 아래 조건을 모두 충족할 때만 🟢안전으로 판정할 것

- 거래 절차가 "교환창 아이템 확인 → 시드 확인 → 교환" 이외의 추가 절차를 요구하지 않는다.
- 쪽지, 코드, 가중치, 별전, 보증, 외부 거래소, 추가 시드 요구 등 1~3번, 5번 패턴이 전혀 없다.
- 4번 행동 이상(레벨 310 미만, 에타 레벨 없음, 아이템 미등록 지연)도 전혀 없다.
- 시드 액수가 크더라도(수십억~수백억) 그 자체는 사기 근거가 아니다. 테일즈위버에서 고가 아이템 거래는 일상적이다.
- 거래가 성사되었다는 시스템 메시지가 있으면 정상 거래로 간주한다.
- 불필요한 주의 경고를 남발하지 않되, 4번 행동 이상이 하나라도 있으면 반드시 🟡주의 이상으로 판정한다.



[Output Format]

반드시 아래의 1~5번 양식에 맞추어 답변을 출력해.

1. 판정: [🟢안전 / 🟡주의 / 🚨위험(사기 1000%)]

2. 감지된 사기 유형: (예: 시스템 단어 조작, 2인 1조 사칭, 3자 사기 의심, 감지된 특이사항 없음 등)

3. 분석 이유: 입력된 채팅 로그에서 어떤 부분(키워드, 뉘앙스, 정황)이 데이터베이스의 패턴과 일치하는지 구체적으로 지적해서 설명.

4. 행동 지침: (예: "즉시 1:1 대화를 종료하고 Ctrl+B를 눌러 차단하세요.", "상대방의 에타 레벨을 꼭 확인해보세요.")

5. ⚠️ 필수 안내: "※ AI의 판정 결과는 참고용입니다. '안전' 판정이 나오더라도 신종 사기 수법일 수 있으므로 100% 안전을 보장하지 않습니다. 거래 시에는 항상 [상대방 레벨 310 및 에타 레벨 확인], [교환창 아이템 직접 확인] 등 기본 수칙을 반드시 지켜주세요."`;

// ── 대화 텍스트 빌드 ──
export function buildConversationText(messages: MessengerMessage[]): string {
  return messages
    .slice(-MAX_MESSAGES_FOR_PROMPT)
    .map((m) => {
      if (m.isSystem) return `[시스템] ${m.content}`;
      return `[${m.timestamp}] ${m.sender}: ${m.content}`;
    })
    .join('\n');
}

// ── 응답 파싱 ──
export function parseResponse(raw: string): Omit<ScamAnalysisResult, 'filePath' | 'analyzedAt'> {
  let verdict: ScamAnalysisResult['verdict'] = 'UNKNOWN';

  const verdictLine = raw.match(/1\s*[.:）)]\s*판정[^\n]*/)?.[0] ?? raw;

  if (/🚨|위험|사기\s*1000|1000\s*%/.test(verdictLine)) verdict = 'SCAM';
  else if (/🟡|주의/.test(verdictLine)) verdict = 'SUSPICIOUS';
  else if (/🟢|안전/.test(verdictLine)) verdict = 'SAFE';

  if (verdict === 'UNKNOWN') {
    if (/🚨|위험|사기\s*1000|1000\s*%/.test(raw)) verdict = 'SCAM';
    else if (/🟡|주의/.test(raw)) verdict = 'SUSPICIOUS';
    else if (/🟢|안전/.test(raw)) verdict = 'SAFE';
  }

  const getSection = (n: number): string => {
    const endPattern = n < 5 ? String(n + 1) + '\\.' : '$';
    const m = raw.match(new RegExp(`${n}\\s*[.:）)]?\\s*[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*${endPattern}|$)`, ''));
    return m?.[1]?.trim() ?? '';
  };

  return {
    verdict,
    detectedScamTypes: getSection(2),
    analysisReason: getSection(3),
    actionGuidance: getSection(4),
    rawResponse: raw,
  };
}

// ── 알림 ──
export async function sendAlert(result: ScamAnalysisResult): Promise<void> {
  const isScam = result.verdict === 'SCAM';
  const label = isScam
    ? '🚨 사기 위험 감지! 즉시 대화를 종료하세요!'
    : '⚠️ 사기 의심 대화 감지 - 주의하세요!';

  const alertSound = config.load().scamAlertSound || SCAM_ALERT_SOUND;
  
  // wm.sendPlaySound를 통해 사운드 및 토스트 노출 제어 통합 전송
  wm.sendPlaySound({
    label,
    soundFile: alertSound,
    volume: 50,
    isCustom: true
  });

  const sidebar = wm.getMainWindow();
  const cfg = config.load();
  const sidebarPos = cfg.sidebarPosition || 'right';
  const isDock = sidebarPos === 'dock' || sidebarPos === 'dock-top';
  const showOnOverlay = !!cfg.showSidebarToastOnOverlay;

  // 사이드바 모드이고 오버레이에만 노출하는 옵션이 꺼져 있을 때만 index.html에 scam-alert UI 전송
  if (sidebar && !sidebar.isDestroyed() && !isDock && !showOnOverlay) {
    sidebar.webContents.send('scam-alert', result);
  }

  // 독 모드이거나, 사이드바 모드이면서 오버레이 옵션이 켜져 있을 때 오버레이 창에 scam-alert UI 전송
  if (isDock || showOnOverlay) {
    const gameOverlay = wm.getGameOverlayWindow();
    if (gameOverlay && !gameOverlay.isDestroyed()) {
      gameOverlay.webContents.send('scam-alert', result);
    }
  }
}

// ── 테스트 시나리오 ──
function makeLogLine(hour: number, min: number, sec: number, color: string, content: string): string {
  return `<font color="white">[${hour}분 ${min}분 ${sec}분]</font><font color="${color}">${content}</font><br>`;
}

export const TEST_SCENARIOS: Record<string, (h: number, m: number) => string[]> = {
  scam_keyword: (h, m) => [
    makeLogLine(h, m, 0, '#ffffff', '룰러: 안녕하세요~ 아이템 판매하시나요?'),
    makeLogLine(h, m, 5, '#c8ffc8', '나: 네 맞습니다'),
    makeLogLine(h, m, 10, '#ffffff', '룰러: 거래 전에 가중치 코드 확인해야 해요'),
    makeLogLine(h, m, 15, '#c8ffc8', '나: 가중치 코드가 뭔가요?'),
    makeLogLine(h, m, 20, '#ffffff', '룰러: 테일즈위버 거래 시스템인데요 쪽지로 코드 보내드릴게요'),
    makeLogLine(h, m, 25, '#ffffff', '룰러: Ctrl+1 누르고 코드 입력하시면 거래 잠금 풀려요'),
    makeLogLine(h, m, 30, '#c8ffc8', '나: 그런 시스템이 있나요?'),
    makeLogLine(h, m, 35, '#ffffff', '룰러: 네 최근에 업데이트됐어요 가중치 안 풀면 시드가 막혀요'),
    makeLogLine(h, m, 40, '#ffffff', '룰러: 빨리 해주셔야 해요 다른 분도 기다리고 계셔서'),
    makeLogLine(h, m, 45, '#c8ffc8', '나: 잠깐만요 좀 이상한거같은데'),
    makeLogLine(h, m, 50, '#ffffff', '룰러: 별전으로 보증금 먼저 주시면 바로 처리해드려요'),
  ],
  scam_duo: (h, m) => [
    makeLogLine(h, m, 0, '#ffffff', '판매자햄찌: 안녕하세요 아이템 사고싶어서요'),
    makeLogLine(h, m, 5, '#c8ffc8', '나: 네 교환창 열게요'),
    makeLogLine(h, m, 10, '#ffffff', '클럽장-햄찌: 잠깐요 저희 클럽원이랑 거래 중이신가요?'),
    makeLogLine(h, m, 15, '#c8ffc8', '나: 네 그런데요?'),
    makeLogLine(h, m, 20, '#ffffff', '클럽장-햄찌: 저희 클럽에서는 상속거래 시스템 써야 해요'),
    makeLogLine(h, m, 25, '#ffffff', '클럽장-햄찌: 녜힁 코드 입력 안 하면 거래 취소돼요'),
    makeLogLine(h, m, 30, '#ffffff', '판매자햄찌: 클럽장님 말씀이 맞아요 롤벤 피하려면 해야해요'),
    makeLogLine(h, m, 35, '#c8ffc8', '나: 롤벤이 뭔가요?'),
    makeLogLine(h, m, 40, '#ffffff', '클럽장-햄찌: 계정 정지예요 빨리 쪽지로 코드 받으세요'),
    makeLogLine(h, m, 45, '#ffffff', '판매자햄찌: 서두르세요 다른 분 기다려요'),
  ],
  scam_seed: (h, m) => [
    makeLogLine(h, m, 0, '#ffffff', '할리퀸: 아이템 교환창 열었는데 제 시드가 막혔어요'),
    makeLogLine(h, m, 5, '#c8ffc8', '나: 시드가 왜 막혀요?'),
    makeLogLine(h, m, 10, '#ffffff', '할리퀸: 거래 정지 먹어서 가중치를 풀어야 해요'),
    makeLogLine(h, m, 15, '#ffffff', '할리퀸: 네냐플에서 시드 50억 사서 저한테 보내주시면 풀어드릴게요'),
    makeLogLine(h, m, 20, '#c8ffc8', '나: 그게 말이 되나요?'),
    makeLogLine(h, m, 25, '#ffffff', '할리퀸: 네 운영자 규정이에요 안 하시면 아이템 못 받아요'),
    makeLogLine(h, m, 30, '#ffffff', '할리퀸: 매니아에서 사셔도 돼요 빠르게 부탁드려요'),
    makeLogLine(h, m, 35, '#c8ffc8', '나: 처음 듣는 시스템인데'),
    makeLogLine(h, m, 40, '#ffffff', '할리퀸: 뉴비분들은 잘 모르세요 고소 피하려면 해야해요'),
    makeLogLine(h, m, 45, '#ffffff', '할리퀸: 현금 말고 시드로만 받아요'),
  ],
  suspicious: (h, m) => {
    const m2 = (m + 1) % 60, m5 = (m + 5) % 60, m6 = (m + 6) % 60;
    const m8 = (m + 8) % 60, m9 = (m + 9) % 60, m11 = (m + 11) % 60;
    const m12 = (m + 12) % 60, m13 = (m + 13) % 60;
    return [
      makeLogLine(h, m,  0, '#ffffff', '췌릴: 안녕하세요 아이템 팔려고요'),
      makeLogLine(h, m,  30, '#c8ffc8', '나: 네 교환창 열게요'),
      makeLogLine(h, m2, 10, '#ffffff', '췌릴: 잠깐만요 준비 중이에요'),
      makeLogLine(h, m2, 50, '#c8ffc8', '나: 아이템 올려주세요'),
      makeLogLine(h, m5, 20, '#ffffff', '췌릴: 조금만요 확인 중이에요'),
      makeLogLine(h, m6,  0, '#c8ffc8', '나: 교환창 연 지 5분이 넘었는데 아직도 아이템을 안 올리시네요'),
      makeLogLine(h, m6, 30, '#ffffff', '췌릴: 죄송해요 컴퓨터가 느려서요'),
      makeLogLine(h, m8,  0, '#c8ffc8', '나: 레벨이 몇이세요?'),
      makeLogLine(h, m8, 20, '#ffffff', '췌릴: 185레벨이에요 에타는 아직 못 했어요'),
      makeLogLine(h, m9,  0, '#c8ffc8', '나: 10분 가까이 됐는데 아이템을 왜 안 올리시나요'),
      makeLogLine(h, m11, 0, '#ffffff', '췌릴: 기다려주세요 곧 올릴게요'),
      makeLogLine(h, m12, 0, '#c8ffc8', '나: 이상한데 그냥 교환창 닫을게요'),
      makeLogLine(h, m13, 0, '#ffffff', '췌릴: 잠깐만요 지금 올릴게요 꼭 거래해야해요'),
    ];
  },
  safe: (h, m) => [
    makeLogLine(h, m, 0, '#ffffff', '밍키: 안녕하세요 전설 반지 팔려고 올리셨나요?'),
    makeLogLine(h, m, 5, '#c8ffc8', '나: 네 맞아요 교환창 열게요'),
    makeLogLine(h, m, 10, '#ffffff', '밍키: 감사합니다 확인할게요'),
    makeLogLine(h, m, 15, '#ffffff', '밍키: 아이템 올렸어요 가격은 30억으로 알고 있는데 맞나요?'),
    makeLogLine(h, m, 20, '#c8ffc8', '나: 네 30억 맞아요'),
    makeLogLine(h, m, 25, '#ffffff', '밍키: 시드 확인했어요 교환 누를게요'),
    makeLogLine(h, m, 30, '#c8ffc8', '나: 저도 확인했어요 교환할게요'),
    makeLogLine(h, m, 35, '#c8c8ff', '거래가 성사되었습니다.'),
    makeLogLine(h, m, 40, '#ffffff', '밍키: 감사합니다 좋은 하루 되세요'),
    makeLogLine(h, m, 45, '#c8ffc8', '나: 감사합니다'),
  ],
  scam_impersonation: (h, m) => [
    makeLogLine(h, m, 0, '#ffffff', '대표：: 안녕하세요~ 아이템 거래하러 왔습니다.'),
    makeLogLine(h, m, 5, '#c8ffc8', '나: 앗 대표님이시군요! 교환창 열겠습니다.'),
    makeLogLine(h, m, 10, '#ffffff', '대표：: 네, 교환 신청했습니다.'),
    makeLogLine(h, m, 15, '#c8ffc8', '나: 대표님 닉네임 상태가 좀 이상한데요? 뒤에 콜론이 붙어있네요.'),
    makeLogLine(h, m, 20, '#ffffff', '대표：: 아, 제 부계정이라 닉네임 중복 때문에 특수문자가 붙은 거예요. 안심하셔도 됩니다.'),
    makeLogLine(h, m, 25, '#c8ffc8', '나: 아 그렇군요...'),
    makeLogLine(h, m, 30, '#ffffff', '대표：: 일단 제 본캐(대표)가 시드 지급해 드려야 하니까 보증으로 아이템 먼저 올려주세요.'),
    makeLogLine(h, m, 35, '#c8ffc8', '나: 아무래도 사칭 사기 같은데요. 차단하겠습니다.'),
  ],
};
