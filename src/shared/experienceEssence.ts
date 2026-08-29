export const XP_PER_ESSENCE = 10_000_000_000;
export const ESSENCE_WARNING_BUFFER_XP = 1_000_000_000;

export interface EssenceWarningAccumulatorUpdate {
  accumulatedXp: number;
  exchangeCount: number;
  shouldAlert: boolean;
}

/**
 * 경험의 정수 교환 판정의 단일 계약입니다.
 *
 * 실제 게임 로그는 교환 방식에 따라 다음처럼 다릅니다.
 * - 수동 교환: `경험치가 10000000000 감소했습니다.` 한 줄이 기록됩니다.
 * - 자동 전환 버프: 위 100억 감소 로그 뒤에
 *   `경험치 100억이 차감되고, 경험의 정수 1개를 획득...` 안내가 한 줄 더 기록됩니다.
 *
 * 두 방식 모두 정확히 한 번 집계하려면 공통으로 존재하는 XP 감소 이벤트만 사용해야 합니다.
 * 뒤따르는 자동 전환 획득 안내는 `itemAcquisition`과 `chatParser`에서 의도적으로 무시합니다.
 * 반면 보상으로 직접 얻는 `[경험의 정수] 아이템을 ... 획득` 문구는 XP 교환과 무관하며
 * `ITEM_LOOTED` 경로에서 별도로 기록됩니다.
 *
 * 이 함수는 실시간 XP HUD, 실시간 모험일지, 과거 로그 워커가 같은 판정을 공유하도록
 * 유지합니다. 근사값이나 일반 음수 XP는 교환으로 오인하지 않으며, 정확한 100억 배수만
 * 정수 개수로 환산합니다.
 */
export function getEssenceExchangeCount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount >= 0) return 0;
  const loss = Math.abs(amount);
  if (loss < XP_PER_ESSENCE || loss % XP_PER_ESSENCE !== 0) return 0;
  return loss / XP_PER_ESSENCE;
}

/**
 * 경험의 정수 자동 교환 버프 경고용 누적 경험치를 갱신합니다.
 *
 * 이 값은 세션 총 경험치나 실제 캐릭터의 잔여 경험치가 아닙니다. 마지막으로 정확한
 * 100억 감소 교환 로그를 본 뒤 얻은 양수 경험치만 누적하는 독립적인 감시 값입니다.
 * 따라서 교환을 감지하면 초과분을 계산하지 않고 0으로 초기화합니다.
 *
 * 별도의 `경고 표시됨` 상태를 두지 않습니다. 변경 전·후 누적값이 110억, 210억,
 * 310억... 경계를 통과했는지만 비교하므로 한 경계 안에서 경험치 로그가 계속 들어와도
 * 경고가 반복되지 않습니다. 한 번의 큰 획득으로 여러 경계를 건너더라도 같은 순간에
 * 경고창을 여러 개 겹쳐 띄우지 않고 한 번만 알립니다. 정확한 100억 배수가 아닌 음수
 * 경험치는 경고 누적에 영향을 주지 않습니다.
 */
export function updateEssenceWarningAccumulator(
  currentXp: number,
  amount: number,
): EssenceWarningAccumulatorUpdate {
  const accumulatedXp = Number.isSafeInteger(currentXp) && currentXp > 0 ? currentXp : 0;
  const exchangeCount = getEssenceExchangeCount(amount);
  if (exchangeCount > 0) {
    return { accumulatedXp: 0, exchangeCount, shouldAlert: false };
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { accumulatedXp, exchangeCount: 0, shouldAlert: false };
  }

  const nextXp = accumulatedXp + amount;
  const safeNextXp = Number.isSafeInteger(nextXp) ? nextXp : Number.MAX_SAFE_INTEGER;
  const previousTier = Math.floor(
    Math.max(0, accumulatedXp - ESSENCE_WARNING_BUFFER_XP) / XP_PER_ESSENCE,
  );
  const nextTier = Math.floor(
    Math.max(0, safeNextXp - ESSENCE_WARNING_BUFFER_XP) / XP_PER_ESSENCE,
  );

  return {
    accumulatedXp: safeNextXp,
    exchangeCount: 0,
    shouldAlert: nextTier > previousTier,
  };
}
