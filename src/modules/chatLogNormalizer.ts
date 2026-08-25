import * as iconv from 'iconv-lite';

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
  return /(?:[습합됩입니]|같으|처)$/u.test(text)
    || /&(?:nbsp)?$/iu.test(text)
    || /(?:미션에\s+성공하여|보상으로|기본\s*보상으로|클리어\s*보상으로)[^.!?]*$/u.test(text);
}

function canMerge(previous: ParsedLogLine, current: ParsedLogLine): boolean {
  if (previous.timestamp !== current.timestamp || previous.color !== current.color) return false;
  const previousText = cleanContent(previous.content);
  const currentText = cleanContent(current.content);
  if (!previousText || !currentText || !isLikelyIncomplete(previous)) return false;
  if (isExplicitContinuation(previousText, currentText)) return true;

  return hasUnclosedPair(previousText)
    && hasBalancedPairs(`${previousText}${currentText}`);
}

function mergeLines(previous: ParsedLogLine, current: ParsedLogLine): string {
  return `${previous.prefix}${previous.content}${current.content}${previous.suffix}`;
}

/** Tail 스트림에서 명백히 잘린 동일 이벤트만 다음 조각과 결합합니다. */
export class ChatLogLineNormalizer {
  private pending: string | null = null;

  push(line: string): string[] {
    const output: string[] = [];
    let currentLine = line;

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
