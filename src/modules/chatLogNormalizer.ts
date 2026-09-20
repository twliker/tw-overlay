import * as iconv from 'iconv-lite';

const { isNpcDialogueSender } = require('../shared/chatConstants') as ChatConstants;

export type ChatLogEncoding = 'euc-kr' | 'utf8';

interface ParsedLogLine {
  timestamp: string;
  color: string;
  prefix: string;
  content: string;
  suffix: string;
}

const LOG_LINE_RE = /^(.*?<font[^>]*color=["']white["'][^>]*>\s*\[\s*([^\]]+)\s*\]\s*<\/font>\s*<font[^>]*color=["'](#[0-9a-fA-F]{6})["'][^>]*>)(.*?)(<\/font>\s*<\/br>[\s\S]*)$/i;
const HTML_TAG_RE = /<[^>]*>/g;
// 게임이 한 대사를 나눈 후속 행에는 긴 NBSP 들여쓰기가 붙는다(실측 13개).
const NPC_CONTINUATION_INDENT_RE = /^(?:[ \t]*&(?:nbsp|#160|#xa0);?){4,}[ \t]*/i;

function parseLogLine(line: string): ParsedLogLine | null {
  const match = line.match(LOG_LINE_RE);
  if (!match) return null;
  return {
    timestamp: match[2].replace(/\s+/g, ''),
    color: match[3].toLowerCase(),
    prefix: match[1],
    content: match[4],
    suffix: match[5],
  };
}

function cleanContent(content: string): string {
  return content.replace(HTML_TAG_RE, '').trim();
}

function npcDialoguePrefix(line: ParsedLogLine): string | null {
  // 유저 대화 채널은 이름이 같은 경우에도 연결하지 않는다. NPC의 보라색 대사는 허용한다.
  if (['#c8ffc8', '#64ff64', '#f7b73c', '#94ddfa', '#c896c8'].includes(line.color)) return null;
  const match = cleanContent(line.content).match(/^(.+?)\s*:\s*/);
  return match && isNpcDialogueSender(match[1].trim()) ? match[0] : null;
}

function isNpcContinuation(previous: ParsedLogLine, current: ParsedLogLine): boolean {
  const previousText = cleanContent(previous.content);
  const currentText = cleanContent(current.content);
  return previous.timestamp === current.timestamp && previous.color === current.color
    && npcDialoguePrefix(previous) !== null && (NPC_CONTINUATION_INDENT_RE.test(current.content)
      // 9/5·9/9 마티아는 !뿐 아니라 "돌아가다" + "니..."도 들여쓰기 없이 나눈다.
      // 확인된 NPC의 미완성 문장/접미만 연결한다. flush 뒤에도 같은 조건으로 발신부를 복원한다.
      || (!hasCompleteEnding(previousText) && (/^[!?…]+$/u.test(currentText)
        || isExplicitContinuation(previousText, currentText)
        || (/다$/u.test(previousText) && /^니[.!?…]+$/u.test(currentText)))));
}

function hasBalancedPairs(text: string): boolean {
  const pairs: Array<[string, string]> = [['[', ']'], ['(', ')'], ['{', '}']];
  return pairs.every(([open, close]) => (
    text.split(open).length - 1 === text.split(close).length - 1
  ));
}

function hasCompleteEnding(text: string): boolean {
  return /(?:[.!?♪…\])}]|니다|습니다|됩니다|했습니다|하였습니다|되었습니다|없습니다|있습니다|사라졌습니다|종료되었습니다)$/u.test(text);
}

function hasUnclosedPair(text: string): boolean {
  const pairs: Array<[string, string]> = [['[', ']'], ['(', ')'], ['{', '}']];
  return pairs.some(([open, close]) => (
    text.split(open).length - 1 > text.split(close).length - 1
  ));
}

function isExplicitContinuation(previousText: string, currentText: string): boolean {
  return (
    /[습합됩입]$/u.test(previousText) && /^니다(?:\b|[.!?♪…]|$)/u.test(currentText)
  ) || (
    /[습합됩입]?니$/u.test(previousText) && /^다(?:\b|[.!?♪…]|$)/u.test(currentText)
  ) || (
    /같으$/u.test(previousText) && /^니(?:\s|까|다|$)/u.test(currentText)
  ) || (
    /처$/u.test(previousText) && /^치/u.test(currentText)
  ) || (
    /&(?:nbsp)?$/iu.test(previousText) && /^[가-힣0-9]/u.test(currentText)
  ) || (
    /(?:미션에\s+성공하여|보상으로|기본\s*보상으로|클리어\s*보상으로)[^.!?]*$/u.test(previousText)
    && /(?:획득|습득|입수)\s*(?:하였|했)습니다/u.test(currentText)
  );
}

function isLikelyIncomplete(line: ParsedLogLine): boolean {
  const text = cleanContent(line.content);
  if (!text) return false;
  if (hasUnclosedPair(text)) return true;
  if (hasCompleteEnding(text)) return false;
  if (npcDialoguePrefix(line)) return true;
  return /(?:[습합됩입니]|같으|처)$/u.test(text)
    || /&(?:nbsp)?$/iu.test(text)
    || /(?:미션에\s+성공하여|보상으로|기본\s*보상으로|클리어\s*보상으로)[^.!?]*$/u.test(text);
}

function canMerge(previous: ParsedLogLine, current: ParsedLogLine): boolean {
  if (previous.timestamp !== current.timestamp || previous.color !== current.color) return false;
  if (isNpcContinuation(previous, current)) return true;
  const previousText = cleanContent(previous.content);
  const currentText = cleanContent(current.content);
  if (!previousText || !currentText || !isLikelyIncomplete(previous)) return false;
  if (isExplicitContinuation(previousText, currentText)) return true;

  return hasUnclosedPair(previousText)
    && hasBalancedPairs(`${previousText}${currentText}`);
}

function mergeLines(previous: ParsedLogLine, current: ParsedLogLine): string {
  const content = isNpcContinuation(previous, current)
    ? current.content.replace(NPC_CONTINUATION_INDENT_RE, '') : current.content;
  return `${previous.prefix}${previous.content}${content}${previous.suffix}`;
}

/** 기능 계약: 명백히 잘린 동일 이벤트만 결합한다. 확인된 NPC 대사는 동일 시각·색상의
 * NBSP 들여쓰기·미완성 대사 직후 구두점·확인된 문장 접미를 이어 NPC 숨김을 뒷부분에도 적용한다.
 * 실시간 flush 뒤 늦게 도착한 조각은 앞 행을 다시 보내지 않고 NPC 발신부만 복원한다.
 * 다른 시각/색상/중간 행 및 reset은 연결하지 않는다. 원본 파일은 변경하지 않는다.
 * 초기 이력·검색·추가 페이지·실시간·로그 복원이 이 정규화를 공유한다.
 * 원본 접미 fixture: origin-of-doom-logs.json. 회귀: check-chat-visibility, check-npc-chat,
 * checkChatLogNormalizationAndItemAcquisition.
 */
export class ChatLogLineNormalizer {
  private pending: string | null = null;
  private previousNpcDialogue: ParsedLogLine | null = null;

  push(line: string): string[] {
    const output: string[] = [];
    let currentLine = line;
    const incoming = parseLogLine(line);
    if (!this.pending && this.previousNpcDialogue && incoming
      && isNpcContinuation(this.previousNpcDialogue, incoming)) {
      // flush로 이미 보낸 앞 행은 재발행하지 않는다. 별도 행이어도 발신 정보를 유지한다.
      currentLine = `${incoming.prefix}${npcDialoguePrefix(this.previousNpcDialogue)}${incoming.content.replace(NPC_CONTINUATION_INDENT_RE, '')}${incoming.suffix}`;
    }

    if (this.pending) {
      const previous = parseLogLine(this.pending);
      const current = parseLogLine(currentLine);
      if (previous && current && canMerge(previous, current)) {
        currentLine = mergeLines(previous, current);
      } else {
        output.push(this.pending);
      }
      this.pending = null;
    }

    const parsed = parseLogLine(currentLine);
    this.previousNpcDialogue = parsed && npcDialoguePrefix(parsed) ? parsed : null;
    if (parsed && isLikelyIncomplete(parsed)) this.pending = currentLine;
    else output.push(currentLine);
    return output;
  }

  flush(): string[] {
    if (!this.pending) return [];
    const pending = this.pending;
    this.pending = null;
    return [pending];
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  reset(): void {
    this.pending = null;
    this.previousNpcDialogue = null;
  }
}

export function normalizeChatLogLines(lines: readonly string[]): string[] {
  const normalizer = new ChatLogLineNormalizer();
  return lines.flatMap(line => normalizer.push(line)).concat(normalizer.flush());
}

function decodingScore(value: string): number {
  const replacementPenalty = (value.match(/\uFFFD/g) || []).length * 20;
  const timestampScore = Math.min((value.match(/\d+\s*시\s*\d+\s*분\s*\d+\s*초/g) || []).length, 20) * 5;
  const dateScore = /Date\s*:\s*\d+년\s*\d+월\s*\d+일/.test(value) ? 30 : 0;
  return timestampScore + dateScore - replacementPenalty;
}

function buildEncodingProbe(buffer: Buffer): Buffer {
  const segmentBytes = 32 * 1024;
  if (buffer.length <= segmentBytes * 3) return buffer;
  const middleStart = Math.max(0, Math.floor((buffer.length - segmentBytes) / 2));
  return Buffer.concat([
    buffer.subarray(0, segmentBytes),
    Buffer.from('\n'),
    buffer.subarray(middleStart, middleStart + segmentBytes),
    Buffer.from('\n'),
    buffer.subarray(buffer.length - segmentBytes),
  ]);
}

export function detectChatLogEncoding(buffer: Buffer): ChatLogEncoding {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf8';
  }

  const header = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString('latin1');
  const declaredCharset = header.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>]+)/i)?.[1]?.toLowerCase();
  if (declaredCharset && /^(?:utf-8|utf8)$/.test(declaredCharset)) return 'utf8';
  if (declaredCharset && /^(?:euc-kr|cp949|ks_c_5601-1987)$/.test(declaredCharset)) return 'euc-kr';

  const probe = buildEncodingProbe(buffer);
  const eucKrScore = decodingScore(iconv.decode(probe, 'euc-kr'));
  const utf8Score = decodingScore(iconv.decode(probe, 'utf8'));
  return utf8Score > eucKrScore ? 'utf8' : 'euc-kr';
}

/** 원본 로그가 EUC-KR 또는 UTF-8인지 표본을 비교해 안전하게 디코딩합니다. */
export function decodeChatLogBuffer(buffer: Buffer): { content: string; encoding: ChatLogEncoding; damaged: boolean } {
  const encoding = detectChatLogEncoding(buffer);
  const content = iconv.decode(buffer, encoding);
  return {
    content,
    encoding,
    damaged: content.includes('\uFFFD'),
  };
}
