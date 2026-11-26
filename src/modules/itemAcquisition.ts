import { isAlwaysTrackedLoot, matchesRegisteredLoot } from '../shared/lootPolicy';

export type ItemAcquisitionSource = 'direct' | 'pet' | 'other';

export interface ItemAcquisition {
  itemName: string;
  count: number;
  source: ItemAcquisitionSource;
  isOwn: boolean;
}

export interface ItemAcquisitionContext {
  isSelfChat?: boolean;
}

/** 모험일지에는 획득 문구나 수량을 섞지 않고 정규화된 아이템명만 저장합니다. */
export function formatLootDiaryContent(itemName: string): string {
  const normalizedName = itemName
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\s\u00A0]+/gu, ' ')
    .trim();
  return `[득템] ${normalizedName}`;
}

const ACQUISITION_VERB = '(?:(?:추가로\\s+)?(?:획득\\s*(?:하였|했)습니다|습득\\s*(?:하였|했)습니다|입수\\s*(?:하였|했)습니다))';
const PET_PICKUP_RE = new RegExp(`^펫이\\s*\\[(.+?)\\](?:을\\(를\\)|을|를)?\\s*주웠습니다\\.?$`);
const BRACKET_ITEM_RE = new RegExp(
  `\\[([^\\]]+)\\]\\s*(?:을\\(를\\)|을|를)?\\s*(?:아이템(?:을\\(를\\)|을|를)?\\s*)?(?:추가로\\s*)?(?:\\[?([\\d,]+)\\]?개(?:를|을)?\\s*)?${ACQUISITION_VERB}`,
);
const PLAIN_ITEM_RE = new RegExp(
  `^(누군가\\s+)?(.{1,60}?)\\s+([\\d,]+)개(?:를|을)?\\s+${ACQUISITION_VERB}`,
);
const SELF_CHAT_ITEM_RE = new RegExp(`^[^:]{1,40}:\\s*(.{1,60}?)(?:을\\(를\\)|을|를)\\s+${ACQUISITION_VERB}`);
const OTHER_BROADCAST_RE = new RegExp(`^누군가\\s+.+?에게서\\s+(.{1,60}?)(?:을\\(를\\)|을|를)\\s+대량으로\\s+${ACQUISITION_VERB}`);
const OTHER_ROUTE_COUNT_RE = new RegExp(`^누군가\\s+.+?\\s+통해\\s+(.{1,60}?)\\s+([\\d,]+)개(?:를|을)?\\s+${ACQUISITION_VERB}`);
const OTHER_PLAIN_RE = new RegExp(`^누군가\\s+(.{1,60}?)(?:을\\(를\\)|을|를)\\s+${ACQUISITION_VERB}`);
const NESTED_BRACKET_ITEM_RE = new RegExp(`(?:^|등급\\s*보상으로\\s*)(\\[\\[[^\\]]+\\]\\s*[^\\]]+\\])\\s*(?:을\\(를\\)|을|를)?\\s*(?:아이템을\\s*)?(?:\\[?([\\d,]+)\\]?개(?:를|을)?\\s*)?${ACQUISITION_VERB}`);
const EXPLICIT_ITEM_RE = new RegExp(`(?:^|보상으로\\s+)(.{1,80}?)\\s+아이템(?:을\\(를\\)|을|를)\\s+${ACQUISITION_VERB}`);
const ITEM_COUNT_AFTER_PARTICLE_RE = new RegExp(`(?:^|보상으로\\s+)(.{1,60}?)(?:을\\(를\\)|을|를)\\s+([\\d,]+)개\\s+더\\s+${ACQUISITION_VERB}`);
const MIXED_REWARD_RE = new RegExp(`보상으로\\s+(.{1,60}?)\\s+([\\d,]+)개와\\s+.+?Seed를\\s+${ACQUISITION_VERB}`, 'i');
const PASS_RE = new RegExp(`^테일즈\\s*패스\\s*보상을\\s+${ACQUISITION_VERB}\\s*:\\s*(?:\\[테일즈\\s*패스\\]\\s*)?(.+)$`);
const ETA_ESSENCE_REWARD_RE = /^에타\s*성장\s*지원\s*이벤트로\s*보상을\s*추가\s*획득\s*(?:하였|했)습니다\.?\s*\(\s*경험의\s*정수\s+([\d,]+)개\s*\)$/u;
const BONUS_ITEM_RE = new RegExp(`^앞서\\s+획득한\\s+(.+?)(?:\\s+아이템)?은\\s+\\[1\\+1\\]\\s+이벤트를\\s+통해\\s+${ACQUISITION_VERB}`);
const DOUBLE_REWARD_RE = new RegExp(
  '^더블\\s*리워드\\s*추가\\s*보상으로\\s*\\[(.+?)\\]\\s*아이템(?:을\\(를\\)|을|를)?\\s*\\[?([\\d,]+)\\]?\\s*개\\s*추가\\s*획득\\s*(?:하였|했)습니다\\.?$',
  'i',
);
const ELSO_PICKUP_RE = /^\[([\d,]+)\]\s*ELSO를\s*습득했습니다\.?$/i;
const ELSO_BONUS_RE = /ELSO\s*포인트를\s*추가로\s*획득\s*(?:하였|했)습니다/i;
const ELSO_ITEM_RE = new RegExp(`^\\[엘소\\s*([\\d,]+)포인트\\](?:을\\(를\\)|을|를)\\s*\\[?([\\d,]+)\\]?개\\s*${ACQUISITION_VERB}`);
const ELSO_DAILY_RE = new RegExp(`^일일\\s+보상으로\\s+([\\d,]+)\\s*Elso\\s*포인트(?:을\\(를\\)|을|를)\\s*${ACQUISITION_VERB}`, 'i');
const GOLD_POUCH_BRACKET_RE = new RegExp(
  `\\[\\s*금화\\s*주머니\\s+([\\d,]+)개\\s*\\]\\s*(?:을\\(를\\)|을|를)?\\s*${ACQUISITION_VERB}`,
);

export const GOLD_POUCH_SEED_VALUE = 500_000;

function countValue(rawCount: string | undefined): number {
  if (!rawCount) return 1;
  const parsed = Number(rawCount.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function itemNameValue(rawName: string): string {
  return rawName
    .replace(/^.+?\s+보상으로\s+/u, '')
    .trim();
}

/** 서로 다른 게임 문구를 장부에서 사용할 수 있는 하나의 아이템 획득 정보로 정규화합니다. */
export function parseItemAcquisition(
  message: string,
  context: ItemAcquisitionContext = {},
): ItemAcquisition | null {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // 에타 추가 보상은 획득 동사 뒤의 괄호에 수량을 기록한다. 실시간과 과거 복원이 공유한다.
  const etaEssence=normalized.match(ETA_ESSENCE_REWARD_RE);
  if (etaEssence) return {itemName:'경험의 정수',count:countValue(etaEssence[1]),source:'direct',isOwn:true};

  // 자동 교환은 앞선 "경험치가 100억 감소" 로그에서 집계하므로 뒤따르는 획득 안내는 중복 파싱하지 않습니다.
  if (/^경험치\s*[\d,억만\s]+(?:이|가)?\s*차감되고.*경험의\s*정수.*획득/i.test(normalized)) {
    return null;
  }

  // 순수 SEED 획득 문구는 아이템 획득이 아닌 SEED 전용 파서에서 처리합니다.
  if (/(?:SEED|Seed|시드)(?:를|을|가)?\s*(?:획득|습득|입수|얻었|받았|지급|증가|올랐|주웠)/i.test(normalized) && !/개와/i.test(normalized)) {
    return null;
  }

  const petMatch = normalized.match(PET_PICKUP_RE);
  if (petMatch) {
    return { itemName: petMatch[1].trim(), count: 1, source: 'pet', isOwn: true };
  }

  const elsoPickupMatch = normalized.match(ELSO_PICKUP_RE);
  if (elsoPickupMatch) {
    return { itemName: 'ELSO', count: countValue(elsoPickupMatch[1]), source: 'direct', isOwn: true };
  }

  const elsoItemMatch = normalized.match(ELSO_ITEM_RE);
  if (elsoItemMatch) {
    return {
      itemName: 'ELSO',
      count: countValue(elsoItemMatch[1]) * countValue(elsoItemMatch[2]),
      source: 'direct',
      isOwn: true,
    };
  }

  const elsoDailyMatch = normalized.match(ELSO_DAILY_RE);
  if (elsoDailyMatch) {
    return { itemName: 'ELSO', count: countValue(elsoDailyMatch[1]), source: 'direct', isOwn: true };
  }

  const generalElsoMatch = normalized.match(/(?:^|보상으로\s+|성공하여\s+|으로\s+)?\[?([\d,]+)\]?\s*ELSO(?:를|을)?\s*(?:추가로\s*)?(?:획득|습득|입수)\s*(?:하였|했)습니다/i);
  if (generalElsoMatch) {
    return { itemName: 'ELSO', count: countValue(generalElsoMatch[1]), source: 'direct', isOwn: true };
  }

  if (ELSO_BONUS_RE.test(normalized)) {
    const amountMatch = normalized.match(/\[([\d,]+)\]\s*ELSO\s*포인트/i);
    return { itemName: 'ELSO', count: countValue(amountMatch?.[1]), source: 'direct', isOwn: true };
  }

  const passMatch = normalized.match(PASS_RE);
  if (passMatch) {
    return { itemName: passMatch[1].trim(), count: 1, source: 'direct', isOwn: true };
  }

  const bonusMatch = normalized.match(BONUS_ITEM_RE);
  if (bonusMatch) {
    return { itemName: bonusMatch[1].trim(), count: 1, source: 'direct', isOwn: true };
  }

  // 더블 리워드는 기본 보상과 별개의 시스템 로그이므로 추가 수량을 독립 획득으로 기록합니다.
  // 이 공통 파서를 실시간 감지와 과거 채팅 로그 복원이 함께 사용하므로 두 경로의 결과가 같습니다.
  const doubleRewardMatch = normalized.match(DOUBLE_REWARD_RE);
  if (doubleRewardMatch) {
    return {
      itemName: doubleRewardMatch[1].trim(),
      count: countValue(doubleRewardMatch[2]),
      source: 'direct',
      isOwn: true,
    };
  }

  const nestedBracketMatch = normalized.match(NESTED_BRACKET_ITEM_RE);
  if (nestedBracketMatch) {
    return {
      itemName: nestedBracketMatch[1].slice(1, -1).trim(),
      count: countValue(nestedBracketMatch[2]),
      source: 'direct',
      isOwn: true,
    };
  }

  const routeCountMatch = normalized.match(OTHER_ROUTE_COUNT_RE);
  if (routeCountMatch) {
    return {
      itemName: routeCountMatch[1].trim(),
      count: countValue(routeCountMatch[2]),
      source: 'other',
      isOwn: false,
    };
  }

  // 군자금·마정석 교환 보상은 수량이 대괄호 안에 들어가므로 일반 대괄호 아이템보다 먼저 분리합니다.
  const goldPouchBracketMatch = normalized.match(GOLD_POUCH_BRACKET_RE);
  if (goldPouchBracketMatch) {
    const isOwn = !normalized.startsWith('누군가');
    return {
      itemName: '금화 주머니',
      count: countValue(goldPouchBracketMatch[1]),
      source: isOwn ? 'direct' : 'other',
      isOwn,
    };
  }

  const bracketMatch = normalized.match(BRACKET_ITEM_RE);
  if (bracketMatch) {
    const isOwn = !normalized.startsWith('누군가');
    return {
      itemName: bracketMatch[1].trim(),
      count: countValue(bracketMatch[2]),
      source: isOwn ? 'direct' : 'other',
      isOwn,
    };
  }

  const plainMatch = normalized.match(PLAIN_ITEM_RE);
  if (plainMatch) {
    const isOwn = !plainMatch[1];
    return {
      itemName: itemNameValue(plainMatch[2]),
      count: countValue(plainMatch[3]),
      source: isOwn ? 'direct' : 'other',
      isOwn,
    };
  }

  const countAfterParticleMatch = normalized.match(ITEM_COUNT_AFTER_PARTICLE_RE);
  if (countAfterParticleMatch) {
    return {
      itemName: countAfterParticleMatch[1].trim(),
      count: countValue(countAfterParticleMatch[2]),
      source: 'direct',
      isOwn: true,
    };
  }

  const mixedRewardMatch = normalized.match(MIXED_REWARD_RE);
  if (mixedRewardMatch) {
    return {
      itemName: mixedRewardMatch[1].trim(),
      count: countValue(mixedRewardMatch[2]),
      source: 'direct',
      isOwn: true,
    };
  }

  const explicitItemMatch = normalized.match(EXPLICIT_ITEM_RE);
  if (explicitItemMatch) {
    return { itemName: explicitItemMatch[1].trim(), count: 1, source: 'direct', isOwn: true };
  }

  const otherBroadcastMatch = normalized.match(OTHER_BROADCAST_RE);
  if (otherBroadcastMatch) {
    return { itemName: otherBroadcastMatch[1].trim(), count: 1, source: 'other', isOwn: false };
  }

  const otherPlainMatch = normalized.match(OTHER_PLAIN_RE);
  if (otherPlainMatch) {
    return { itemName: otherPlainMatch[1].trim(), count: 1, source: 'other', isOwn: false };
  }

  if (context.isSelfChat) {
    const selfChatMatch = normalized.match(SELF_CHAT_ITEM_RE);
    if (selfChatMatch) {
      return { itemName: selfChatMatch[1].trim(), count: 1, source: 'direct', isOwn: true };
    }
  }

  // 쉼표(,)로 나열된 복수 아이템 획득 문구 중 첫 번째 아이템 폴백
  const multiItems = parseMultiItemAcquisition(normalized);
  if (multiItems.length > 0) {
    return multiItems[0];
  }

  return null;
}

/** 자신의 금화 주머니 획득 이벤트를 SEED로 환산합니다. 시간 문자열은 중복될 수 있으므로 식별자로 사용하지 않습니다. */
export function getGoldPouchSeedAmount(acquisition: ItemAcquisition): number {
  if (!acquisition.isOwn || acquisition.count <= 0) return 0;
  const normalizedName = acquisition.itemName
    .normalize('NFC')
    .replace(/[\s\u00A0]+/gu, ' ')
    .trim();
  if (normalizedName !== '금화 주머니') return 0;
  return acquisition.count * GOLD_POUCH_SEED_VALUE;
}

/** 획득 줄의 아이템이 모험일지 득템 행으로 남는지(자기 획득, 경험의 정수 또는 등록 아이템, 마정석 제외).
 * 실시간 기록(chatLogProcessor ITEM_LOOTED)과 줄 귀속 판단(recordsLootLine)이 같이 쓴다. 과거 로그 복원
 * (chatLogSyncWorker)도 같은 조건이다. lootKeywords는 normalizeNotificationKeywords를 거친 값을 받는다. */
export function lootItemRecord(acquisition: {itemName: string; isOwn: boolean; message: string}, lootKeywords: readonly string[]): {alwaysTracked: boolean; record: boolean} {
  const alwaysTracked = isAlwaysTrackedLoot(acquisition.itemName);
  const registered = alwaysTracked || matchesRegisteredLoot(lootKeywords, acquisition.itemName);
  return {alwaysTracked, record: acquisition.isOwn && registered && !acquisition.itemName.includes('마정석') && !acquisition.message.includes('마정석')};
}

/** 기능 계약 — 획득 줄 하나가 지금 설정으로 모험일지에 무엇이든 남기는지(엘소 포인트·금화 주머니 SEED·득템 행).
 * 실시간 줄 귀속(profile_log_line_owners)은 이 값이 참인 줄에만 만든다. 이전에는 자기 획득 줄 전부에 남겨, 등록하지 않은
 * 아이템 줄(실제 사냥 로그 하루 약 200~700행)도 귀속이 쌓였다. 엘소 스크롤 줄은 일일 엘소 누적에 남는 기록이라 귀속을
 * 유지한다(파일 교체 뒤 다시 읽어도 누적에 두 번 더하지 않게). 기록하지 않은 줄은 귀속이 없어도
 * 다시 읽을 때 다시 기록되지 않으므로(같은 조건) 중복이 생기지 않는다. 등록 아이템을 나중에 추가하면 그 뒤 재분석이
 * 그 줄을 새로 기록할 수 있는데, 그때까지 일지에 없던 줄이므로 중복이 아니다. 다른 프로필의 복원은 이 프로필의 반영 구간
 * (log_ranges applied)으로 그 줄을 건너뛴다(profileLogRestore otherLive). 파일 교체로 그 구간이 지워진 뒤에는 다른 프로필이
 * 등록한 아이템이면 그 프로필에 기록될 수 있다(알려진 한계: 이 프로필 일지에는 없던 줄이라 중복은 아니다).
 * 엘소 문구를 읽지 못하면(예외) 남는 줄로 본다(귀속을 남기는 쪽이 안전).
 * 회귀: check-profile-durability.ts(실제 감시에서 등록·미등록 획득 줄의 귀속 수), check-refactor-regressions.ts(조건). */
export function recordsLootLine(acquisition: {itemName: string; count: number; isOwn: boolean; message: string}, lootKeywords: readonly string[]): boolean {
  try {if (parseElsoMessage(acquisition.message) > 0) return true;} catch {return true;}
  if (getGoldPouchSeedAmount({...acquisition, source: 'direct'}) > 0) return true;
  return lootItemRecord(acquisition, lootKeywords).record;
}

function parseMultiItemAcquisition(normalized: string): ItemAcquisition[] {
  // 예: 색을 잃은 땅 미션에 성공하여 경험의 정수 2개, 레이티아의 시든 꽃 1개, 루비코나 코어 상자 10개를 획득했습니다.
  const multiMatch = normalized.match(/^(?:누군가\s+)?(?:.+?(?:성공하여|보상으로)\s+)?(.+?)\s*(?:를|을)?\s*(?:추가로\s+)?(?:획득|습득|입수)\s*(?:하였|했)습니다\.?$/i);
  if (multiMatch && multiMatch[1].includes(',')) {
    const isOwn = !normalized.startsWith('누군가');
    const items: ItemAcquisition[] = [];
    // 수량 안의 천 단위 쉼표(1,000)는 유지하고 아이템 구분 쉼표만 나눈다.
    const parts = multiMatch[1].split(/,(?!\d)/u);
    for (const part of parts) {
      const itemMatch = part.trim().match(/^(?:\[([^\]]+)\]|([^,\d]+?))\s*(?:아이템(?:을\(를\)|을|를)?\s*)?\[?([\d,]+)\]?개(?:를|을)?$/);
      if (itemMatch) {
        const rawName = (itemMatch[1] || itemMatch[2] || '').trim();
        const count = countValue(itemMatch[3]);
        if (rawName) {
          items.push({
            itemName: itemNameValue(rawName),
            count,
            source: isOwn ? 'direct' : 'other',
            isOwn,
          });
        }
      }
    }
    return items;
  }
  return [];
}

/** 단일 또는 복수 아이템 획득 메시지에서 모든 아이템 획득 목록을 반환합니다. */
export function parseItemAcquisitions(
  message: string,
  context: ItemAcquisitionContext = {},
): ItemAcquisition[] {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  // 자동 교환은 앞선 "경험치가 100억 감소" 로그에서 집계하므로 뒤따르는 획득 안내는 중복 파싱하지 않습니다.
  if (/^경험치\s*[\d,억만\s]+(?:이|가)?\s*차감되고.*경험의\s*정수.*획득/i.test(normalized)) {
    return [];
  }

  // 순수 SEED 획득 문구는 아이템 획득이 아닌 SEED 전용 파서에서 처리합니다.
  if (/(?:SEED|Seed|시드)(?:를|을|가)?\s*(?:획득|습득|입수|얻었|받았|지급|증가|올랐|주웠)/i.test(normalized) && !/개와/i.test(normalized)) {
    return [];
  }

  const multi = parseMultiItemAcquisition(normalized);
  if (multi.length > 0) {
    return multi;
  }

  const single = parseItemAcquisition(message, context);
  return single ? [single] : [];
}

/** 다양한 형태의 엘소(Elso) 획득 메시지에서 최종 포인트 총합을 계산합니다. */
export function parseElsoMessage(msg: string): number {
  // 1. [엘소 스크롤 (N 포인트)] 관련 다양한 획득 패턴 (단품, 복수 개수, 클리어 보상, 1+1 등)
  const scrollMatch = msg.match(/\[엘소\s*스크롤\s*\(([\d,]+)\s*포인트\)\]/);
  if (scrollMatch) {
    const pt = parseInt(scrollMatch[1].replace(/,/g, ''), 10);
    // 개수 매칭: [K]개, K개, 아이템을 K개, 아이템을 [K]개 등
    const countMatch = msg.match(/(?:아이템(?:을\(를\)|을|를)?\s*)?\[?([\d,]+)\]?개(?:를|을)?\s*(?:더\s*)?(?:획득|습득|입수)/);
    const count = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : 1;
    return pt * count;
  }

  // 2. [엘소 N포인트] 관련 획득 패턴 (단품, 복수 개수 등)
  const pointItemMatch = msg.match(/\[엘소\s*([\d,]+)포인트\]/);
  if (pointItemMatch) {
    const pt = parseInt(pointItemMatch[1].replace(/,/g, ''), 10);
    const countMatch = msg.match(/(?:아이템(?:을\(를\)|을|를)?\s*)?\[?([\d,]+)\]?개(?:를|을)?\s*(?:더\s*)?(?:획득|습득|입수)/);
    const count = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : 1;
    return pt * count;
  }

  // 3. 일일 보상으로 N Elso 포인트 획득
  const dailyMatch = msg.match(/일일\s+보상으로\s+([\d,]+)\s*Elso\s*포인트/i);
  if (dailyMatch) {
    return parseInt(dailyMatch[1].replace(/,/g, ''), 10);
  }

  // 4. 루미나의 회랑 ELSO 획득량 증가 효과로 [N] ELSO 포인트를 추가로 획득했습니다.
  const match4 = msg.match(/루미나의\s*회랑\s*ELSO\s*획득량\s*증가\s*효과로\s*\[([\d,]+)\]\s*ELSO\s*포인트를\s*추가로\s*획득(?:했|하였)습니다/i);
  if (match4) {
    return parseInt(match4[1].replace(/,/g, ''), 10);
  }

  // 5. [N] ELSO 포인트 추가 획득 (이벤트/보너스)
  const matchBonus = msg.match(/\[([\d,]+)\]\s*ELSO\s*포인트를\s*추가로\s*획득/i);
  if (matchBonus) {
    return parseInt(matchBonus[1].replace(/,/g, ''), 10);
  }

  // 6. [N]ELSO를 습득했습니다.
  const match5 = msg.match(/\[([\d,]+)\]\s*ELSO를\s*습득했습니다/i);
  if (match5) {
    return parseInt(match5[1].replace(/,/g, ''), 10);
  }

  // 7. 일반 ELSO 획득 및 추가 획득 (혼란한 대지, 색을 잃은 땅, 방어 보상, 미션 효과 미적용 등)
  const generalMatch = msg.match(/(?:^|보상으로\s+|성공하여\s+|으로\s+)?\[?([\d,]+)\]?\s*ELSO(?:를|을)?\s*(?:추가로\s*)?(?:획득|습득|입수)\s*(?:하였|했)습니다/i);
  if (generalMatch) {
    return parseInt(generalMatch[1].replace(/,/g, ''), 10);
  }

  return 0;
}
