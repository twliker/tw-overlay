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
const BONUS_ITEM_RE = new RegExp(`^앞서\\s+획득한\\s+(.+?)(?:\\s+아이템)?은\\s+\\[1\\+1\\]\\s+이벤트를\\s+통해\\s+${ACQUISITION_VERB}`);
const ELSO_PICKUP_RE = /^\[([\d,]+)\]\s*ELSO를\s*습득했습니다\.?$/i;
const ELSO_BONUS_RE = /ELSO\s*포인트를\s*추가로\s*획득\s*(?:하였|했)습니다/i;
const ELSO_ITEM_RE = new RegExp(`^\\[엘소\\s*([\\d,]+)포인트\\](?:을\\(를\\)|을|를)\\s*\\[?([\\d,]+)\\]?개\\s*${ACQUISITION_VERB}`);
const ELSO_DAILY_RE = new RegExp(`^일일\\s+보상으로\\s+([\\d,]+)\\s*Elso\\s*포인트(?:을\\(를\\)|을|를)\\s*${ACQUISITION_VERB}`, 'i');

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

  // 경험치 차감 후 발생하는 경험의 정수 자동 교환 안내 메시지는 XP_CHANGED 이벤트에서 일지 기록을 전담하므로 중복 득템 파싱에서 제외합니다.
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

  // 경험치 차감 후 발생하는 경험의 정수 자동 교환 안내 메시지는 XP_CHANGED 이벤트에서 일지 기록을 전담하므로 중복 득템 파싱에서 제외합니다.
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
