// ── 난이도 배율 및 다캐릭 편성 가산점 상수 ──
const DIFFICULTY_MULTIPLIER: Record<string, number> = {
    normal: 1.0, // 일반
    hard: 2.5,   // 어려움
    hell: 5.0    // 지옥
};

const PARTY_BONUS_MULTIPLIER: Record<number, number> = {
    1: 1.00,
    2: 1.04,
    3: 1.07,
    4: 1.10
};

// ── 12종 미션 기본 메타데이터 및 지옥 난이도 실측 점수표 ──
const MISSIONS: Record<string, any> = {
    WHEEL: {
        id: 'WHEEL',
        nameKo: '운명의 수레바퀴',
        category: 'BOSS',
        defaultTimeBonus: 18, // Normal Stg1: 118, Hell Stg1: 590 (595 if <=14s)
        fastTimeBonus: 19,
        expectedClearSec: 18,
        tag: '추천',
        iconFileName: '운명의수레바퀴.png',
        guideTip: '붉은색 발판 회피하며 안전 지대 유지 (빠른 통과 권장)',
        hellScores: [590, 640, 690, 740, 790, 840, 890, 940, 990, 1040]
    },
    ROLE: {
        id: 'ROLE',
        nameKo: '역할 분담 전투',
        category: 'BOSS',
        defaultTimeBonus: 18, // Normal Stg1: 118, Hell Stg1: 590
        fastTimeBonus: 19,
        expectedClearSec: 22,
        tag: '추천',
        iconFileName: '역할분담전투.png',
        guideTip: '⚡ 추천 1순위: 역할(어그로/딜러) 분담 및 약점 속성 공략으로 빠른 클리어',
        hellScores: [590, 640, 690, 740, 790, 840, 890, 940, 990, 1040]
    },
    TILE: {
        id: 'TILE',
        nameKo: '속성 타일 건너기',
        category: 'TILE',
        defaultTimeBonus: 18, // Normal Stg1: 118, Hell Stg1: 590
        fastTimeBonus: 18,
        expectedClearSec: 25,
        tag: '추천',
        iconFileName: '속성타일건너기.png',
        guideTip: '머리 위 구슬 색상과 일치하는 타일만 밟으며 신속 돌파 (비전투 고득점)',
        hellScores: [590, 640, 690, 740, 790, 840, 890, 940, 990, 1040]
    },
    DEBUFF: {
        id: 'DEBUFF',
        nameKo: '디버프 분산',
        category: 'BOSS',
        defaultTimeBonus: 18, // Normal Stg1: 118, Hell Stg1: 590
        fastTimeBonus: 19,
        expectedClearSec: 22,
        tag: '보통',
        iconFileName: '디버프분산.png',
        guideTip: '원형 범위 피격 주의(피해량 증가 디버프), 분신 신속 처치 후 극딜',
        hellScores: [590, 640, 690, 740, 790, 840, 890, 940, 990, 1040]
    },
    MUTATION: {
        id: 'MUTATION',
        nameKo: '보스 변이 전투',
        category: 'BOSS',
        defaultTimeBonus: 18, // Normal Stg1: 118, Hell Stg1: 590
        fastTimeBonus: 19,
        expectedClearSec: 22,
        tag: '보통',
        iconFileName: '보스변이전투.png',
        guideTip: '보스 광역 장판 패턴 회피 후 순간 폭딜 집중 클리어',
        hellScores: [590, 640, 690, 740, 790, 840, 890, 940, 990, 1040]
    },
    ELEMENT: {
        id: 'ELEMENT',
        nameKo: '속성 상성 전투',
        category: 'BOSS',
        defaultTimeBonus: 18, // Normal Stg1: 118, Hell Stg1: 590
        fastTimeBonus: 19,
        expectedClearSec: 22,
        tag: '보통',
        iconFileName: '속성상성전투.png',
        guideTip: '보스의 약점 속성에 맞는 공격 집중 시 빠른 클리어',
        hellScores: [590, 640, 690, 740, 790, 840, 890, 940, 990, 1040]
    },
    MONARCH: {
        id: 'MONARCH',
        nameKo: '양면의 군주',
        category: 'BOSS',
        defaultTimeBonus: 18, // Normal Stg1: 118, Hell Stg1: 590
        fastTimeBonus: 19,
        expectedClearSec: 22,
        tag: '보통',
        iconFileName: '양면의군주.png',
        guideTip: '푸른색 방어벽 시 공격 회피/대기, 붉은색 방어벽 시 집중 극딜',
        hellScores: [590, 640, 690, 740, 790, 840, 890, 940, 990, 1040]
    },
    CORE: {
        id: 'CORE',
        nameKo: '고대 병기의 핵 파괴',
        category: 'CORE',
        defaultTimeBonus: 17, // 4:15 remaining -> +17 (Normal Stg1: 117, Hell Stg1: 585)
        fastTimeBonus: 17,
        expectedClearSec: 45,
        tag: '보통',
        iconFileName: '고대병기의핵파괴.png',
        guideTip: '핵을 이동시켜 기계 장치 파괴 (표준 대비 5점 감점, 고단계 감점 주의)',
        hellScores: [585, 635, 685, 735, 785, 835, 885, 935, 985, 1035]
    },
    ESCAPE: {
        id: 'ESCAPE',
        nameKo: '이스케이프 룸',
        category: 'ESCAPE',
        defaultTimeBonus: 14, // 3:43 remaining -> +14 (Normal Stg1: 114, Hell Stg1: 570)
        fastTimeBonus: 14,
        expectedClearSec: 77,
        tag: '보통',
        iconFileName: '이스케이프룸.png',
        guideTip: '닫힌 문 벽을 피해 텔레포트/이동기로 출구 즉시 진입 (표준 대비 20점 감점)',
        hellScores: [570, 620, 670, 720, 770, 820, 870, 920, 970, 1020]
    },
    OVERLOAD: {
        id: 'OVERLOAD',
        nameKo: '과부하 제어',
        category: 'OVERLOAD',
        defaultTimeBonus: 6,  // 1:35 remaining -> +6 on Stg 1~7 (Normal: 106, Hell: 530), +5 on Stg 8~10
        fastTimeBonus: 6,
        expectedClearSec: 115,
        tag: '비추천',
        iconFileName: '과부하제어.png',
        guideTip: '⚠️ 비추천: 주기적 과부하 해제 필요, 시간 소요 커서 회피 권장 (최대 65점 감점)',
        hellScores: [530, 580, 630, 680, 730, 780, 830, 875, 925, 975]
    },
    ZONE: {
        id: 'ZONE',
        nameKo: '속성 장판 생존',
        category: 'SURVIVAL',
        defaultTimeBonus: 0,  // 0:00 remaining -> +0 (Normal Stg1: 100, Hell Stg1: 500)
        fastTimeBonus: 0,
        expectedClearSec: 120,
        tag: '비추천',
        iconFileName: '속성장판생존.png',
        guideTip: '⏳ 비추천: 바닥 장판 순서대로 회피, 2분 고정 소요되어 점수 손실 큼 (-90점 감점)',
        hellScores: [500, 550, 600, 650, 700, 750, 800, 850, 900, 950]
    },
    SCALE: {
        id: 'SCALE',
        nameKo: '죄악의 저울',
        category: 'SURVIVAL',
        defaultTimeBonus: 0,  // 0:00 remaining -> +0 (Normal Stg1: 100, Hell Stg1: 500)
        fastTimeBonus: 0,
        expectedClearSec: 120,
        tag: '비추천',
        iconFileName: '죄악의저울.png',
        guideTip: '⏳ 비추천: 양쪽 저울 균형 유지 필요, 2분 고정 소요되어 점수 손실 큼 (-90점 감점)',
        hellScores: [500, 550, 600, 650, 700, 750, 800, 850, 900, 950]
    }
};

// ── 기존 소문자 ID와 사양서 대문자 ID 간 양방향 매핑 ──
const MISSION_ALIASES: Record<string, string> = {
    wheel_of_fortune: 'WHEEL',
    role_division: 'ROLE',
    attr_tile: 'TILE',
    debuff: 'DEBUFF',
    boss_mutation: 'MUTATION',
    attr_counter: 'ELEMENT',
    two_faced: 'MONARCH',
    ancient_weapon: 'CORE',
    escape_room: 'ESCAPE',
    overload: 'OVERLOAD',
    attr_zone: 'ZONE',
    scale_of_sin: 'SCALE'
};

function normalizeMissionId(id?: string): string {
    if (!id) return 'MUTATION';
    const trimmed = id.trim();
    if (MISSIONS[trimmed]) return trimmed;
    const upper = trimmed.toUpperCase();
    if (MISSIONS[upper]) return upper;
    const lower = trimmed.toLowerCase();
    if (MISSION_ALIASES[lower]) return MISSION_ALIASES[lower];
    return 'MUTATION';
}

// ── 하위 호환성을 위해 LUMINA_MISSIONS에 기존 및 대문자 키 모두 등록 ──
const LUMINA_MISSIONS: Record<string, any> = {};
for (const [key, meta] of Object.entries(MISSIONS)) {
    const legacyItem = {
        ...meta,
        name: meta.nameKo,
        tier: meta.tag === '추천' ? 1 : meta.tag === '비추천' ? 3 : 2,
        recommendation: meta.tag
    };
    LUMINA_MISSIONS[key] = legacyItem;
    // 소문자 alias 등록
    for (const [alias, targetKey] of Object.entries(MISSION_ALIASES)) {
        if (targetKey === key) {
            LUMINA_MISSIONS[alias] = {
                ...legacyItem,
                id: alias
            };
        }
    }
}

// ── 순위별 보상 최소 점수컷 ──
const LUMINA_REWARD_CUTS = [
    { rankPercent: '상위 2.0%', minScore: 7250, sealCount: 2000 },
    { rankPercent: '상위 10.0%', minScore: 3800, sealCount: 1200 },
    { rankPercent: '상위 35.0%', minScore: 2000, sealCount: 1000 },
    { rankPercent: '상위 70.0%', minScore: 1200, sealCount: 600 },
    { rankPercent: '상위 100.0%', minScore: 600, sealCount: 200 }
];

const LUMINA_ROW_COUNT = 10;
const LUMINA_COL_COUNT = 5;

/**
 * 단일 노드 점수 계산 공식
 * NodeScore = (BaseScore + TimeBonus + EffectiveStageBonus) * DifficultyMultiplier
 */
function evaluateNodeStep(
    missionId: string,
    stage: number, // 1 to 10
    prevMissionId: string | null,
    options: any
): { nodeScore: number; estimatedSec: number; hasConsecutivePenalty: boolean; penaltyAmount: number } {
    const normId = normalizeMissionId(missionId);
    const meta = MISSIONS[normId] || MISSIONS.MUTATION;
    const baseScore = 100;

    // 1. Time Bonus calculation
    let timeBonus = options.isUltraFastBossClear ? meta.fastTimeBonus : meta.defaultTimeBonus;
    if (meta.category === 'OVERLOAD' && stage >= 8) {
        // High-stage penalty on Stages 8, 9, 10 for Overload Control (875, 925, 975 in Hell)
        timeBonus = 5;
    }

    // 2. Stage Bonus & Consecutive Same-Mission Penalty (-10 to stageBonus, floor at 0)
    const rawStageBonus = (stage - 1) * 10;
    const isConsecutive = prevMissionId !== null && normalizeMissionId(prevMissionId) === normId;
    const effectiveStageBonus = isConsecutive ? Math.max(0, rawStageBonus - 10) : rawStageBonus;

    // 3. Apply Difficulty Multiplier
    const diffMult = DIFFICULTY_MULTIPLIER[options.difficulty] ?? 1.0;
    const nodeScore = (baseScore + timeBonus + effectiveStageBonus) * diffMult;
    const penaltyAmount = (rawStageBonus - effectiveStageBonus) * diffMult;

    return {
        nodeScore,
        estimatedSec: meta.expectedClearSec,
        hasConsecutivePenalty: penaltyAmount > 0,
        penaltyAmount
    };
}

function evaluateFullRoute(nodes: Array<{ stage: number; col: number; missionId: string }>, options: any) {
    let rawTotalScore = 0;
    let totalTimeSec = 0;
    let notRecommendedCount = 0;
    const stepDetails: any[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const curr = nodes[i];
        const prevMissionId = i > 0 ? nodes[i - 1].missionId : null;
        const step = evaluateNodeStep(curr.missionId, curr.stage, prevMissionId, options);

        rawTotalScore += step.nodeScore;
        totalTimeSec += step.estimatedSec;
        const normId = normalizeMissionId(curr.missionId);
        if (MISSIONS[normId]?.tag === '비추천') {
            notRecommendedCount++;
        }
        stepDetails.push(step);
    }

    // Canonical key: sorted list of visited "stage-col" coordinates
    const nodeSetKey = [...nodes]
        .map((n) => `${n.stage}-${n.col}`)
        .sort()
        .join('|');

    const partyMult = PARTY_BONUS_MULTIPLIER[options.partySize] ?? 1.0;
    const finalScore = Math.floor(rawTotalScore * partyMult);

    return {
        nodes,
        nodeSetKey,
        rawTotalScore,
        finalScore,
        totalTimeSec,
        notRecommendedCount,
        stepDetails
    };
}

/**
 * Deduplicates routes that visit the exact same set of nodes (e.g. A->B->C vs B->A->C),
 * keeping ONLY the traversal order that yields the highest score (least consecutive penalty).
 * Then sorts the unique routes according to the active RouteMode.
 */
function getTopUniqueRoutes(
    candidateRoutes: Array<Array<{ stage: number; col: number; missionId: string }>>,
    mode: string,
    options: any,
    topK = 3
) {
    const bestByNodeSet = new Map<string, any>();

    for (const rawNodes of candidateRoutes) {
        const evaluated = evaluateFullRoute(rawNodes, options);
        const existing = bestByNodeSet.get(evaluated.nodeSetKey);

        // If same set of nodes is visited in a different order, keep the order with higher score
        if (!existing || evaluated.finalScore > existing.finalScore) {
            bestByNodeSet.set(evaluated.nodeSetKey, evaluated);
        }
    }

    const uniqueRoutes = Array.from(bestByNodeSet.values());

    // Sort according to the 3 distinct modes
    uniqueRoutes.sort((a, b) => {
        if (mode === 'highScore') {
            // Mode 1: 고득점 루트 (High Score)
            if (options.avoidNotRecommended && a.notRecommendedCount !== b.notRecommendedCount) {
                return a.notRecommendedCount - b.notRecommendedCount;
            }
            // 1st: Highest Final Score
            if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
            // 2nd: Shortest Clear Time
            if (a.totalTimeSec !== b.totalTimeSec) return a.totalTimeSec - b.totalTimeSec;
            // 3rd: Fewer '비추천' missions
            return a.notRecommendedCount - b.notRecommendedCount;
        }

        if (mode === 'maxNodes') {
            // Mode 2: 최다 노드 (Max Visited Nodes)
            // 1st: Most Visited Nodes
            if (b.nodes.length !== a.nodes.length) return b.nodes.length - a.nodes.length;
            // 2nd: Highest Final Score
            if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
            // 3rd: Shortest Clear Time
            return a.totalTimeSec - b.totalTimeSec;
        }

        // Mode 3: 최단 쾌속 (Fastest Clear)
        // 1st: Shortest Total Clear Time
        if (a.totalTimeSec !== b.totalTimeSec) return a.totalTimeSec - b.totalTimeSec;
        // 2nd: Highest Final Score
        return b.finalScore - a.finalScore;
    });

    return uniqueRoutes.slice(0, topK);
}

/**
 * 단계별 고정 기본 점수 계산 (하위 호환성 유지)
 */
function calculateLuminaBaseScore(row: number, difficulty: string = 'normal'): number {
    const stage = row + 1;
    const base = 109 + (10 * stage);
    if (difficulty === 'hard') {
        return Math.round(base * 1.5);
    }
    if (difficulty === 'hell') {
        return Math.round(base * 2.0);
    }
    return base;
}

/**
 * 노드별 미션 및 난이도 기반 점수 계산
 */
function calculateLuminaNodeScore(row: number, missionId?: string, difficulty: string = 'normal'): number {
    const stage = Math.max(1, Math.min(row + 1, LUMINA_ROW_COUNT));
    const normId = missionId ? normalizeMissionId(missionId) : 'MUTATION';
    const diff = (difficulty === 'hard' || difficulty === 'hell') ? difficulty : 'normal';
    return evaluateNodeStep(normId, stage, null, { difficulty: diff, partySize: 1 }).nodeScore;
}

/**
 * 기본 10x5 빈 연결 상태 생성
 */
function createEmptyLuminaConnections() {
    return {
        horizontal: Array.from({ length: LUMINA_ROW_COUNT }, () => Array(LUMINA_COL_COUNT - 1).fill(false)),
        vertical: Array.from({ length: LUMINA_ROW_COUNT - 1 }, () => Array(LUMINA_COL_COUNT).fill(false)),
        diagDownLeft: Array.from({ length: LUMINA_ROW_COUNT - 1 }, () => Array(LUMINA_COL_COUNT).fill(false)),
        diagDownRight: Array.from({ length: LUMINA_ROW_COUNT - 1 }, () => Array(LUMINA_COL_COUNT).fill(false))
    };
}

/**
 * 기본 10x5 노드 데이터 생성
 */
function createDefaultLuminaGridData(difficulty: string = 'normal') {
    const grid: any[][] = [];
    for (let r = 0; r < LUMINA_ROW_COUNT; r++) {
        const row: any[] = [];
        for (let c = 0; c < LUMINA_COL_COUNT; c++) {
            row.push({
                row: r,
                col: c,
                baseScore: calculateLuminaNodeScore(r, undefined, difficulty)
            });
        }
        grid.push(row);
    }
    return grid;
}

/**
 * 특정 행(row)에서 startCol에서 시작하여 연결된 수평 간선을 따라 이동 가능한 모든 단순 경로 탐색
 */
function findRowHorizontalPaths(
    row: number,
    startCol: number,
    horizontalEdges: boolean[][]
): number[][] {
    const results: number[][] = [];
    const visited = new Set<number>();
    visited.add(startCol);

    function dfs(currentCol: number, currentPath: number[]) {
        results.push([...currentPath]);

        // 왼쪽 이동 (c-1)
        if (currentCol > 0 && horizontalEdges[row][currentCol - 1] && !visited.has(currentCol - 1)) {
            visited.add(currentCol - 1);
            currentPath.push(currentCol - 1);
            dfs(currentCol - 1, currentPath);
            currentPath.pop();
            visited.delete(currentCol - 1);
        }

        // 오른쪽 이동 (c+1)
        if (currentCol < LUMINA_COL_COUNT - 1 && horizontalEdges[row][currentCol] && !visited.has(currentCol + 1)) {
            visited.add(currentCol + 1);
            currentPath.push(currentCol + 1);
            dfs(currentCol + 1, currentPath);
            currentPath.pop();
            visited.delete(currentCol + 1);
        }
    }

    dfs(startCol, [startCol]);
    return results;
}

/**
 * 루미나의 회랑 최적 경로 탐색기
 * - candidateRoutes 수집 후 getTopUniqueRoutes를 통해 삼각 연결 중복 제거 및 3대 모드 정렬
 */
function findLuminaOptimalPaths(
    connections: any,
    gridData: any[][],
    mode: string = 'highScore',
    maxResults: number = 3,
    options?: any
): any[] {
    const completedPaths: Array<Array<{ row: number; col: number }>> = [];

    function searchStage(
        currentRow: number,
        entryCol: number,
        accumulatedPath: Array<{ row: number; col: number }>
    ) {
        const hPaths = findRowHorizontalPaths(currentRow, entryCol, connections.horizontal);

        for (const hPath of hPaths) {
            const stageCoords = hPath.map((col) => ({ row: currentRow, col }));
            const nextAccumulated = [...accumulatedPath, ...stageCoords];

            if (currentRow === LUMINA_ROW_COUNT - 1) {
                completedPaths.push(nextAccumulated);
            } else {
                const exitCol = hPath[hPath.length - 1];

                // 직하향 (수직)
                if (connections.vertical?.[currentRow]?.[exitCol]) {
                    searchStage(currentRow + 1, exitCol, nextAccumulated);
                }

                // 대각선 좌하향
                if (exitCol > 0 && connections.diagDownLeft[currentRow][exitCol]) {
                    searchStage(currentRow + 1, exitCol - 1, nextAccumulated);
                }

                // 대각선 우하향
                if (exitCol < LUMINA_COL_COUNT - 1 && connections.diagDownRight[currentRow][exitCol]) {
                    searchStage(currentRow + 1, exitCol + 1, nextAccumulated);
                }
            }
        }
    }

    for (let c = 0; c < LUMINA_COL_COUNT; c++) {
        searchStage(0, c, []);
    }

    if (completedPaths.length === 0) {
        return [];
    }

    // EvalOptions 설정
    const evalOptions = {
        difficulty: options?.difficulty || 'normal',
        partySize: options?.partySize || 1,
        isUltraFastBossClear: options?.isUltraFastBossClear,
        avoidNotRecommended: options?.avoidNotRecommended
    };

    // 모드 정규화
    let normalizedMode = 'highScore';
    if (mode === 'maxNodes' || mode === 'max_nodes') {
        normalizedMode = 'maxNodes';
    } else if (mode === 'fastClear' || mode === 'shortest') {
        normalizedMode = 'fastClear';
    }

    // candidateRoutes 변환
    const candidateRoutes = completedPaths.map((coords) => {
        return coords.map((c) => {
            const node = gridData[c.row]?.[c.col];
            return {
                stage: c.row + 1,
                col: c.col,
                missionId: node?.missionId || 'MUTATION'
            };
        });
    });

    const evaluatedRoutes = getTopUniqueRoutes(candidateRoutes, normalizedMode, evalOptions, maxResults);

    return evaluatedRoutes.map((er) => {
        const path = er.nodes.map((n: any) => ({
            row: n.stage - 1,
            col: n.col
        }));

        let achievedReward: any = undefined;
        let nextReward: any = undefined;

        for (let i = 0; i < LUMINA_REWARD_CUTS.length; i++) {
            const cut = LUMINA_REWARD_CUTS[i];
            if (er.finalScore >= cut.minScore) {
                achievedReward = cut;
                if (i > 0) {
                    const higherCut = LUMINA_REWARD_CUTS[i - 1];
                    nextReward = {
                        target: higherCut,
                        neededScore: higherCut.minScore - er.finalScore
                    };
                }
                break;
            }
        }

        if (!achievedReward && LUMINA_REWARD_CUTS.length > 0) {
            const lowestCut = LUMINA_REWARD_CUTS[LUMINA_REWARD_CUTS.length - 1];
            nextReward = {
                target: lowestCut,
                neededScore: lowestCut.minScore - er.finalScore
            };
        }

        return {
            path,
            totalScore: er.finalScore,
            rawTotalScore: er.rawTotalScore,
            finalScore: er.finalScore,
            nodeCount: er.nodes.length,
            totalTimeSec: er.totalTimeSec,
            notRecommendedCount: er.notRecommendedCount,
            stepDetails: er.stepDetails,
            achievedReward,
            nextReward
        };
    });
}

const luminaCorridor = Object.freeze({
    DIFFICULTY_MULTIPLIER,
    PARTY_BONUS_MULTIPLIER,
    MISSIONS,
    LUMINA_MISSIONS,
    LUMINA_REWARD_CUTS,
    LUMINA_ROW_COUNT,
    LUMINA_COL_COUNT,
    normalizeMissionId,
    evaluateNodeStep,
    evaluateFullRoute,
    getTopUniqueRoutes,
    calculateLuminaBaseScore,
    calculateLuminaNodeScore,
    createEmptyLuminaConnections,
    createDefaultLuminaGridData,
    findRowHorizontalPaths,
    findLuminaOptimalPaths
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = luminaCorridor;
}
if (typeof window !== 'undefined') {
    (window as any).luminaCorridor = luminaCorridor;
}
