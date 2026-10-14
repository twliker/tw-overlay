import {
    LuminaGridConnections,
    LuminaMissionId,
    LuminaNodeData
} from '../shared/types';
import { LUMINA_COL_COUNT, LUMINA_ROW_COUNT } from '../modules/lumina-pathfinder';

export interface LuminaDetectedGrid {
    found: boolean;
    startX: number;
    startY: number;
    stepX: number;
    stepY: number;
    confidence: number;
    nodePoints: Array<Array<{ x: number; y: number }>>;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function pixelStats(data: Uint8ClampedArray, offset: number) {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    return {
        luma: (r * 0.299) + (g * 0.587) + (b * 0.114),
        chroma: Math.max(r, g, b) - Math.min(r, g, b)
    };
}

function buildNeutralMask(imageData: ImageData): Uint8Array {
    const { width, height, data } = imageData;
    const mask = new Uint8Array(width * height);
    for (let index = 0, offset = 0; index < mask.length; index++, offset += 4) {
        const { luma, chroma } = pixelStats(data, offset);
        if (luma >= 175 && chroma <= 34) mask[index] = 1;
    }
    return mask;
}

interface Component {
    x: number;
    y: number;
    width: number;
    height: number;
    size: number;
    count: number;
    quality: number;
}

function findSquareComponents(mask: Uint8Array, width: number, height: number): Component[] {
    const visited = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    const components: Component[] = [];
    const neighbors = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];

    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || visited[start]) continue;

        let head = 0;
        let tail = 0;
        let count = 0;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        queue[tail++] = start;
        visited[start] = 1;

        while (head < tail) {
            const current = queue[head++];
            const x = current % width;
            const y = Math.floor(current / width);
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (const delta of neighbors) {
                const next = current + delta;
                if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
                const nx = next % width;
                const ny = Math.floor(next / width);
                if (Math.abs(nx - x) > 1 || Math.abs(ny - y) > 1) continue;
                visited[next] = 1;
                queue[tail++] = next;
            }
        }

        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        const aspect = componentWidth / componentHeight;
        const perimeterDensity = count / Math.max(1, 2 * (componentWidth + componentHeight));

        if (
            componentWidth >= 13 && componentWidth <= 74 &&
            componentHeight >= 13 && componentHeight <= 74 &&
            aspect >= 0.68 && aspect <= 1.46 &&
            count >= 24 && count <= componentWidth * componentHeight * 0.82 &&
            perimeterDensity >= 0.34
        ) {
            components.push({
                x: (minX + maxX) / 2,
                y: (minY + maxY) / 2,
                width: componentWidth,
                height: componentHeight,
                size: (componentWidth + componentHeight) / 2,
                count,
                quality: clamp(perimeterDensity / 1.7, 0, 1)
            });
        }
    }
    return components;
}

function deduplicateComponents(components: Component[]): Component[] {
    const sorted = [...components].sort((a, b) => (b.count * b.quality) - (a.count * a.quality));
    const kept: Component[] = [];
    for (const component of sorted) {
        const duplicate = kept.some((other) => {
            const distance = Math.hypot(component.x - other.x, component.y - other.y);
            return distance < Math.min(component.size, other.size) * 0.3;
        });
        if (!duplicate) kept.push(component);
    }
    return kept;
}

function createSpatialIndex(points: Component[], cellSize = 10) {
    const cells = new Map<string, Component[]>();
    for (const point of points) {
        const cellX = Math.floor(point.x / cellSize);
        const cellY = Math.floor(point.y / cellSize);
        const key = `${cellX},${cellY}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key)!.push(point);
    }

    return function findNear(x: number, y: number, tolerance: number, expectedSize?: number): Component | null {
        const range = Math.ceil(tolerance / cellSize);
        const baseX = Math.floor(x / cellSize);
        const baseY = Math.floor(y / cellSize);
        let best: Component | null = null;
        let bestDistance = Infinity;
        for (let oy = -range; oy <= range; oy++) {
            for (let ox = -range; ox <= range; ox++) {
                const bucket = cells.get(`${baseX + ox},${baseY + oy}`);
                if (!bucket) continue;
                for (const point of bucket) {
                    if (expectedSize && (point.size < expectedSize * 0.58 || point.size > expectedSize * 1.62)) continue;
                    const distance = Math.hypot(point.x - x, point.y - y);
                    if (distance <= tolerance && distance < bestDistance) {
                        best = point;
                        bestDistance = distance;
                    }
                }
            }
        }
        return best;
    };
}

function linearFit(samples: Array<{ index: number; point: { x: number; y: number } }>, key: 'x' | 'y') {
    if (!samples.length) return { intercept: 0, slope: 0 };
    let sumIndex = 0;
    let sumValue = 0;
    let sumIndexSquared = 0;
    let sumProduct = 0;
    for (const sample of samples) {
        const index = sample.index;
        const value = sample.point[key];
        sumIndex += index;
        sumValue += value;
        sumIndexSquared += index * index;
        sumProduct += index * value;
    }
    const count = samples.length;
    const denominator = (count * sumIndexSquared) - (sumIndex * sumIndex);
    if (Math.abs(denominator) < 0.0001) {
        return { intercept: sumValue / count, slope: 0 };
    }
    const slope = ((count * sumProduct) - (sumIndex * sumValue)) / denominator;
    return { intercept: (sumValue - slope * sumIndex) / count, slope };
}

function evaluateLattice(
    origin: Component,
    spacing: number,
    findNear: (x: number, y: number, tolerance: number, expectedSize?: number) => Component | null
) {
    const tolerance = Math.max(3.2, spacing * 0.16);
    const matches: Array<{ row: number; column: number; point: Component }> = [];
    for (let row = 0; row < LUMINA_ROW_COUNT; row++) {
        for (let column = 0; column < LUMINA_COL_COUNT; column++) {
            const point = findNear(origin.x + column * spacing, origin.y + row * spacing, tolerance, origin.size);
            if (point) matches.push({ row, column, point });
        }
    }

    const rowCoverage = new Set(matches.map((m) => m.row)).size;
    const columnCoverage = new Set(matches.map((m) => m.column)).size;
    const score = matches.length + rowCoverage * 1.6 + columnCoverage * 1.3;
    return { score, matches, rowCoverage, columnCoverage };
}

/**
 * 캡처 이미지에서 10x5 루미나의 회랑 그리드 중심점 자동 탐지 (LuminaDetector 기반)
 */
export function detectLuminaGrid(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
): LuminaDetectedGrid {
    const imageData = ctx.getImageData(0, 0, width, height);
    const mask = buildNeutralMask(imageData);
    const components = deduplicateComponents(findSquareComponents(mask, width, height));
    const findNear = createSpatialIndex(components, 9);
    let best: any = null;

    for (const origin of components) {
        const spacingCandidates = new Set<number>([
            origin.size * 1.06,
            origin.size * 1.14,
            origin.size * 1.22,
            origin.size * 1.3
        ].map((v) => Math.round(v * 4) / 4));

        for (const other of components) {
            const dx = other.x - origin.x;
            if (dx < origin.size * 0.82 || dx > origin.size * 1.52) continue;
            if (Math.abs(other.y - origin.y) > origin.size * 0.24) continue;
            spacingCandidates.add(Math.round(dx * 4) / 4);
        }

        for (const spacing of spacingCandidates) {
            if (spacing < 16 || spacing > 88) continue;
            const evaluation = evaluateLattice(origin, spacing, findNear);
            if (!best || evaluation.score > best.score) {
                best = { ...evaluation, origin, spacing };
            }
        }
    }

    if (!best || best.matches.length < 20) {
        // Fallback: 기본 50px 그리드 중심
        const stepX = 50;
        const stepY = 50;
        const startX = 114;
        const startY = 121;
        const fallbackPoints: Array<Array<{ x: number; y: number }>> = [];
        for (let r = 0; r < LUMINA_ROW_COUNT; r++) {
            const rowPoints: Array<{ x: number; y: number }> = [];
            for (let c = 0; c < LUMINA_COL_COUNT; c++) {
                rowPoints.push({ x: startX + c * stepX, y: startY + r * stepY });
            }
            fallbackPoints.push(rowPoints);
        }
        return {
            found: false,
            startX,
            startY,
            stepX,
            stepY,
            confidence: 0,
            nodePoints: fallbackPoints
        };
    }

    const xSamples = best.matches.map((m: any) => ({ index: m.column, point: m.point }));
    const ySamples = best.matches.map((m: any) => ({ index: m.row, point: m.point }));
    const xFit = linearFit(xSamples, 'x');
    const yFit = linearFit(ySamples, 'y');
    const stepX = Math.round(xFit.slope || best.spacing);
    const stepY = Math.round(yFit.slope || best.spacing);
    const startX = Math.round(xFit.intercept);
    const startY = Math.round(yFit.intercept);

    const hitConfidence = best.matches.length / 50;
    const regularity = 1 - clamp((Math.abs(stepX - stepY) / Math.max(stepX, stepY)) * 3, 0, 1);
    const confidence = clamp(hitConfidence * 0.82 + regularity * 0.18, 0, 1);

    const nodePoints: Array<Array<{ x: number; y: number }>> = [];
    for (let r = 0; r < LUMINA_ROW_COUNT; r++) {
        const rowPoints: Array<{ x: number; y: number }> = [];
        for (let c = 0; c < LUMINA_COL_COUNT; c++) {
            rowPoints.push({
                x: Math.round(startX + c * stepX),
                y: Math.round(startY + r * stepY)
            });
        }
        nodePoints.push(rowPoints);
    }

    return {
        found: true,
        startX,
        startY,
        stepX,
        stepY,
        confidence,
        nodePoints
    };
}

function sampleBand(
    isLinePixel: (x: number, y: number) => boolean,
    start: { x: number; y: number },
    end: { x: number; y: number },
    fromT: number,
    toT: number,
    halfWidth: number
) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const nx = length ? -dy / length : 0;
    const ny = length ? dx / length : 0;
    const samples = Math.max(3, Math.ceil(length * (toT - fromT)));
    const radius = Math.max(1, Math.round(halfWidth));
    let dark = 0;
    let total = 0;

    for (let index = 0; index <= samples; index++) {
        const t = fromT + ((toT - fromT) * index / samples);
        const x = start.x + dx * t;
        const y = start.y + dy * t;
        for (let offset = -radius; offset <= radius; offset++) {
            total++;
            if (isLinePixel(x + nx * offset, y + ny * offset)) dark++;
        }
    }
    return { dark, total, density: total ? dark / total : 0 };
}

/**
 * 점선(이동 통로) 연결선 감지
 */
export function detectLuminaConnections(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    nodePoints: Array<Array<{ x: number; y: number }>>,
    spacing = 50
): LuminaGridConnections {
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;

    const isLinePixel = (x: number, y: number) => {
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= width || py >= height) return false;
        const offset = (py * width + px) * 4;
        const { luma, chroma } = pixelStats(data, offset);
        return luma < 182 && chroma < 54;
    };

    const horizontal: boolean[][] = Array.from({ length: LUMINA_ROW_COUNT }, () =>
        Array(LUMINA_COL_COUNT - 1).fill(false)
    );
    const vertical: boolean[][] = Array.from({ length: LUMINA_ROW_COUNT - 1 }, () =>
        Array(LUMINA_COL_COUNT).fill(false)
    );
    const diagDownLeft: boolean[][] = Array.from({ length: LUMINA_ROW_COUNT - 1 }, () =>
        Array(LUMINA_COL_COUNT).fill(false)
    );
    const diagDownRight: boolean[][] = Array.from({ length: LUMINA_ROW_COUNT - 1 }, () =>
        Array(LUMINA_COL_COUNT).fill(false)
    );

    // 1. 수평선 (0.43..0.57 대역 샘플링)
    for (let r = 0; r < LUMINA_ROW_COUNT; r++) {
        for (let c = 0; c < LUMINA_COL_COUNT - 1; c++) {
            const p1 = nodePoints[r][c];
            const p2 = nodePoints[r][c + 1];
            const sample = sampleBand(isLinePixel, p1, p2, 0.43, 0.57, spacing * 0.055);
            horizontal[r][c] = sample.dark >= 1 && sample.density >= 0.045;
        }
    }

    // 2. 수직선 (0.43..0.57 대역 샘플링)
    for (let r = 0; r < LUMINA_ROW_COUNT - 1; r++) {
        for (let c = 0; c < LUMINA_COL_COUNT; c++) {
            const sample = sampleBand(isLinePixel, nodePoints[r][c], nodePoints[r + 1][c], 0.43, 0.57, spacing * 0.055);
            vertical[r][c] = sample.dark >= 1 && sample.density >= 0.045;
        }
    }

    // 3. 대각선 (0.26..0.74 대역 샘플링)
    const minDiagPixels = Math.max(2, Math.round(spacing * 0.13));
    for (let r = 0; r < LUMINA_ROW_COUNT - 1; r++) {
        for (let c = 0; c < LUMINA_COL_COUNT; c++) {
            const current = nodePoints[r][c];

            // 우하향: (r, c) -> (r+1, c+1)
            if (c < LUMINA_COL_COUNT - 1) {
                const targetRight = nodePoints[r + 1][c + 1];
                const sampleR = sampleBand(isLinePixel, current, targetRight, 0.26, 0.74, spacing * 0.04);
                diagDownRight[r][c] = sampleR.dark >= minDiagPixels && sampleR.density >= 0.05;
            }

            // 좌하향: (r, c) -> (r+1, c-1)
            if (c > 0) {
                const targetLeft = nodePoints[r + 1][c - 1];
                const sampleL = sampleBand(isLinePixel, current, targetLeft, 0.26, 0.74, spacing * 0.04);
                diagDownLeft[r][c] = sampleL.dark >= minDiagPixels && sampleL.density >= 0.05;
            }
        }
    }

    return { horizontal, vertical, diagDownLeft, diagDownRight };
}

/**
 * 12종 미션 템플릿과 노드 영역 정밀 비교 매칭
 */
export function matchLuminaMissions(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    nodePoints: Array<Array<{ x: number; y: number }>>,
    templates: Map<LuminaMissionId, ImageData>
): LuminaNodeData[][] {
    const canvasData = ctx.getImageData(0, 0, width, height).data;
    const grid: LuminaNodeData[][] = [];

    for (let r = 0; r < LUMINA_ROW_COUNT; r++) {
        const rowData: LuminaNodeData[] = [];
        for (let c = 0; c < LUMINA_COL_COUNT; c++) {
            const pt = nodePoints[r][c];
            let bestMission: LuminaMissionId | undefined;
            let bestDiff = Infinity;

            for (const [mId, tplData] of templates.entries()) {
                let totalDiff = 0;
                let count = 0;
                const tplW = tplData.width;
                const tplH = tplData.height;
                const tplCenterX = Math.floor(tplW / 2);
                const tplCenterY = Math.floor(tplH / 2);

                // 마름모 내부 |dx| + |dy| <= 10 영역 정밀 비교
                for (let dy = -10; dy <= 10; dy++) {
                    for (let dx = -10; dx <= 10; dx++) {
                        if (Math.abs(dx) + Math.abs(dy) > 10) continue;
                        const imgX = pt.x + dx;
                        const imgY = pt.y + dy;
                        if (imgX < 0 || imgX >= width || imgY < 0 || imgY >= height) continue;

                        const imgIdx = (imgY * width + imgX) * 4;
                        const tplIdx = ((tplCenterY + dy) * tplW + (tplCenterX + dx)) * 4;

                        const dr = canvasData[imgIdx] - tplData.data[tplIdx];
                        const dg = canvasData[imgIdx + 1] - tplData.data[tplIdx + 1];
                        const db = canvasData[imgIdx + 2] - tplData.data[tplIdx + 2];
                        totalDiff += Math.sqrt(dr * dr + dg * dg + db * db);
                        count++;
                    }
                }

                const avgDiff = count ? totalDiff / count : Infinity;
                if (avgDiff < bestDiff) {
                    bestDiff = avgDiff;
                    bestMission = mId;
                }
            }

            rowData.push({
                row: r,
                col: c,
                missionId: bestMission,
                baseScore: 109 + 10 * (r + 1)
            });
        }
        grid.push(rowData);
    }

    return grid;
}
