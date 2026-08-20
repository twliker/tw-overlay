interface HuntingExpDopingDefinition {
  id: string;
  name: string;
  percent: number;
  duration: string;
  enabled: boolean;
  note: string;
}

interface HuntingGroundDefinition {
  id: string;
  name: string;
  baseXp: number;
}

interface HuntingExpCalculationInput {
  dopings: readonly HuntingExpDopingDefinition[];
  baseXp: number;
  killsPerHour: number;
  happyHour: boolean;
}

const EXPERIENCE_ESSENCE_XP = 10_000_000_000;

const DEFAULT_DOPINGS: readonly HuntingExpDopingDefinition[] = Object.freeze([
  { id: 'stray-cat-1-exp', name: '길고양이1 경험치 버프', percent: 30, duration: '60분', enabled: true, note: '1일 1회' },
  { id: 'pass-rune-garden', name: '패스 룬 정원 경험치', percent: 200, duration: '120분', enabled: true, note: '1일 2회' },
  { id: 'izabel-secret-exp', name: '이자벨의 비법 (경험)', percent: 100, duration: '30분', enabled: true, note: '' },
  { id: 'izabel-special-exp', name: '이자벨의 특선 묘약 (경험)', percent: 500, duration: '30분', enabled: true, note: '' },
  { id: 'izabel-elixir-exp', name: '이자벨의 선약 (경험)', percent: 1000, duration: '30분', enabled: false, note: '' },
  { id: 'club-buff-e2', name: '클럽 버프 스크롤 (E-2)', percent: 200, duration: '30분', enabled: true, note: '클럽 포인트 1,000' },
  { id: 'exp-heart', name: '경험의 심장', percent: 400, duration: '20분', enabled: true, note: '' },
  { id: 'supreme-eos', name: '최상급 에오스의 파편', percent: 500, duration: '30분', enabled: true, note: '' },
  { id: 'earlybird-exp', name: '얼리버드 경험치 부스터', percent: 300, duration: '30분', enabled: true, note: '' },
  { id: 'legend-potato', name: '전설의 군고구마', percent: 1000, duration: '30분', enabled: true, note: '' },
  { id: 'exp-potato', name: '경험의 군고구마', percent: 900, duration: '30분', enabled: false, note: '재사용 40분 · 공백 10분' },
  { id: 'challenge-stamp', name: '도전 과제 완료 도장', percent: 400, duration: '60분', enabled: true, note: '500개' },
  { id: 'good-job-150', name: '참 잘했어요 도장', percent: 150, duration: '60분', enabled: true, note: '50개' },
  { id: 'good-job-100', name: '참 잘했어요 도장 (100%)', percent: 100, duration: '120분', enabled: false, note: '20개' },
  { id: 'advice-flower', name: '조언의 꽃', percent: 50, duration: '30일', enabled: true, note: '캐시' },
  { id: 'shol-book', name: '스홀책', percent: 100, duration: '60분', enabled: true, note: '' },
  { id: 'helm-boogie', name: '헬름부기', percent: 50, duration: '무제한', enabled: true, note: '' },
  { id: 'title-moon-rabbit', name: '칭호 (달토끼)', percent: 150, duration: '상시', enabled: true, note: '' },
  { id: 'title-23rd', name: '칭호 (23주년)', percent: 50, duration: '상시', enabled: false, note: '' },
  { id: 'core-siokan', name: '코어 (시오칸)', percent: 380, duration: '상시', enabled: true, note: '' },
  { id: 'exploration-30', name: '탐험 포인트 30분', percent: 100, duration: '30분', enabled: true, note: '' },
  { id: 'exploration-60', name: '탐험 포인트 1시간', percent: 100, duration: '60분', enabled: true, note: '' },
  { id: 'illumination', name: '일루미네이션 축제 음료', percent: 15, duration: '120분', enabled: true, note: '' },
  { id: 'blue-coral', name: '블루 코럴', percent: 50, duration: '120분', enabled: true, note: '' },
  { id: 'pet-exp', name: '펫 경험치', percent: 50, duration: '30일', enabled: true, note: '' },
  { id: 'teacher-advanced', name: '스승의 증표 (고급)', percent: 80, duration: '3시간 36분', enabled: false, note: '따뜻한 에오스와 세트' },
  { id: 'warm-eos', name: '따뜻한 에오스의 파편', percent: 100, duration: '60분', enabled: false, note: '클럽 버프 미사용 시' },
  { id: 'snowman-potion', name: '눈사람족 특제 포션', percent: 100, duration: '60분', enabled: false, note: '따뜻한 에오스·일루미네이션과 중첩 불가' },
].map(item => Object.freeze(item)));

const DEFAULT_GROUNDS: readonly HuntingGroundDefinition[] = Object.freeze([
  Object.freeze({ id: 'forge', name: '대장간', baseXp: 200_000 }),
  Object.freeze({ id: 'golgotha', name: '골고다', baseXp: 720_000 }),
  Object.freeze({ id: 'void', name: '공허', baseXp: 980_000 }),
]);

function finiteNonNegative(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, Number.MAX_SAFE_INTEGER);
}

function calculate(input: HuntingExpCalculationInput): {
  appliedPercent: number;
  experiencePerKill: number;
  experiencePerHour: number;
  experienceEssencePerHour: number;
} {
  const appliedPercent = input.dopings.reduce((total, doping) => (
    doping.enabled ? total + finiteNonNegative(doping.percent) : total
  ), 0);
  const multiplier = 1 + appliedPercent / 100;
  const happyHourMultiplier = input.happyHour ? 1.5 : 1;
  const experiencePerKill = Math.round(finiteNonNegative(
    finiteNonNegative(input.baseXp) * multiplier * happyHourMultiplier,
  ));
  const experiencePerHour = Math.round(finiteNonNegative(
    experiencePerKill * finiteNonNegative(input.killsPerHour),
  ));
  const experienceEssencePerHour = experiencePerHour / EXPERIENCE_ESSENCE_XP;
  return { appliedPercent, experiencePerKill, experiencePerHour, experienceEssencePerHour };
}

const huntingExpCalculator = Object.freeze({
  EXPERIENCE_ESSENCE_XP,
  DEFAULT_DOPINGS,
  DEFAULT_GROUNDS,
  calculate,
});

if (typeof module !== 'undefined' && module.exports) module.exports = huntingExpCalculator;
if (typeof window !== 'undefined') window.huntingExpCalculator = huntingExpCalculator;
