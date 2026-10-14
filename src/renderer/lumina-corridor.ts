(() => {
    // ── DOM 요소 참조 ──
    const $ = (id: string) => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`Element #${id} not found`);
        return el;
    };

    const api = (window as any).luminaCorridor;
    if (!api) {
        console.error('luminaCorridor shared module not loaded.');
        return;
    }

    // ── 상태 변수 ──
    let currentImage: HTMLImageElement | null = null;
    let currentDifficulty: 'normal' | 'hard' | 'hell' = 'normal';
    let currentPartySize: 1 | 2 | 3 | 4 = 1;
    let currentMode: 'highScore' | 'maxNodes' | 'fastClear' = 'highScore';
    let currentGridPoints: Array<Array<{ x: number; y: number }>> = [];
    let currentConnections: any = api.createEmptyLuminaConnections();
    let currentGridData: any[][] = api.createDefaultLuminaGridData('normal');
    let currentPaths: any[] = [];
    let selectedPathIndex = 0;

    // 미션 템플릿 캐시
    const missionTemplates = new Map<string, ImageData>();

    // ── 12종 아이콘 템플릿 비동기 로드 ──
    async function loadMissionTemplates() {
        const missions = Object.keys(api.LUMINA_MISSIONS);
        const tCanvas = document.createElement('canvas');
        const tCtx = tCanvas.getContext('2d');
        if (!tCtx) return;

        for (const mId of missions) {
            const meta = api.LUMINA_MISSIONS[mId];
            const img = new Image();
            img.src = `assets/lumina/icons/${meta.iconFileName}`;
            await new Promise(resolve => {
                img.onload = () => {
                    tCanvas.width = img.width;
                    tCanvas.height = img.height;
                    tCtx.drawImage(img, 0, 0);
                    const imgData = tCtx.getImageData(0, 0, img.width, img.height);
                    missionTemplates.set(mId, imgData);
                    resolve(null);
                };
                img.onerror = () => resolve(null);
            });
        }
    }

    // ── 이미지 분석 파이프라인 ──
    function processImage(img: HTMLImageElement) {
        currentImage = img;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.drawImage(img, 0, 0);

        // 1. 10x5 그리드 좌표 탐지
        const detectedGrid = detectGrid(ctx, canvas.width, canvas.height);
        currentGridPoints = detectedGrid.nodePoints;

        // 2. 점선 연결 상태 감지
        currentConnections = detectConnections(ctx, canvas.width, canvas.height, currentGridPoints);

        // 3. 미션 매칭
        currentGridData = matchMissions(ctx, canvas.width, canvas.height, currentGridPoints);

        // 4. 경로 탐색 및 UI 렌더링
        updatePathsAndUI();

        // 뷰어 활성화
        $('dropZone').classList.add('hidden');
        $('viewerContainer').classList.remove('hidden');
    }

    // ── 그리드 정밀 탐지 (LuminaDetector 기반) ──
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
                    quality: Math.max(0, Math.min(1, perimeterDensity / 1.7))
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

    function detectGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const mask = buildNeutralMask(imageData);
        const components = deduplicateComponents(findSquareComponents(mask, width, height));

        // Spatial index
        const cellSize = 10;
        const cells = new Map<string, Component[]>();
        for (const point of components) {
            const cellX = Math.floor(point.x / cellSize);
            const cellY = Math.floor(point.y / cellSize);
            const key = `${cellX},${cellY}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key)!.push(point);
        }

        const findNear = (x: number, y: number, tolerance: number, expectedSize?: number): Component | null => {
            const range = Math.ceil(tolerance / cellSize);
            const baseX = Math.floor(x / cellSize);
            const baseY = Math.floor(y / cellSize);
            let bestNear: Component | null = null;
            let bestDistance = Infinity;
            for (let oy = -range; oy <= range; oy++) {
                for (let ox = -range; ox <= range; ox++) {
                    const bucket = cells.get(`${baseX + ox},${baseY + oy}`);
                    if (!bucket) continue;
                    for (const pt of bucket) {
                        if (expectedSize && (pt.size < expectedSize * 0.58 || pt.size > expectedSize * 1.62)) continue;
                        const dist = Math.hypot(pt.x - x, pt.y - y);
                        if (dist <= tolerance && dist < bestDistance) {
                            bestNear = pt;
                            bestDistance = dist;
                        }
                    }
                }
            }
            return bestNear;
        };

        let bestLattice: any = null;
        for (const origin of components) {
            const spacingCandidates = new Set<number>([
                origin.size * 1.06, origin.size * 1.14, origin.size * 1.22, origin.size * 1.3
            ].map((v) => Math.round(v * 4) / 4));

            for (const other of components) {
                const dx = other.x - origin.x;
                if (dx < origin.size * 0.82 || dx > origin.size * 1.52) continue;
                if (Math.abs(other.y - origin.y) > origin.size * 0.24) continue;
                spacingCandidates.add(Math.round(dx * 4) / 4);
            }

            for (const spacing of spacingCandidates) {
                if (spacing < 16 || spacing > 88) continue;
                const tolerance = Math.max(3.2, spacing * 0.16);
                const matches: Array<{ row: number; column: number; point: Component }> = [];
                for (let row = 0; row < api.LUMINA_ROW_COUNT; row++) {
                    for (let col = 0; col < api.LUMINA_COL_COUNT; col++) {
                        const pt = findNear(origin.x + col * spacing, origin.y + row * spacing, tolerance, origin.size);
                        if (pt) matches.push({ row, column: col, point: pt });
                    }
                }
                const rowCov = new Set(matches.map((m) => m.row)).size;
                const colCov = new Set(matches.map((m) => m.column)).size;
                const score = matches.length + rowCov * 1.6 + colCov * 1.3;
                if (!bestLattice || score > bestLattice.score) {
                    bestLattice = { score, matches, origin, spacing };
                }
            }
        }

        let startX = 114;
        let startY = 121;
        let stepX = 50;
        let stepY = 50;

        if (bestLattice && bestLattice.matches.length >= 20) {
            const xSamples = bestLattice.matches.map((m: any) => ({ index: m.column, point: m.point }));
            const ySamples = bestLattice.matches.map((m: any) => ({ index: m.row, point: m.point }));
            const xFit = linearFit(xSamples, 'x');
            const yFit = linearFit(ySamples, 'y');
            stepX = Math.round(xFit.slope || bestLattice.spacing);
            stepY = Math.round(yFit.slope || bestLattice.spacing);
            startX = Math.round(xFit.intercept);
            startY = Math.round(yFit.intercept);
        }

        const nodePoints: Array<Array<{ x: number; y: number }>> = [];
        for (let r = 0; r < api.LUMINA_ROW_COUNT; r++) {
            const rowPoints: Array<{ x: number; y: number }> = [];
            const y = Math.round(startY + r * stepY);
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                const x = Math.round(startX + c * stepX);
                rowPoints.push({ x, y });
            }
            nodePoints.push(rowPoints);
        }

        console.log(`[LUMINA-VISION] Robust grid detected: startX=${startX}, startY=${startY}, stepX=${stepX}, stepY=${stepY}`);
        return { nodePoints, stepX, stepY };
    }

    // ── 점선 밴드 샘플링 ──
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

    function detectConnections(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        points: Array<Array<{ x: number; y: number }>>,
        spacing = 50
    ) {
        const { data } = ctx.getImageData(0, 0, width, height);
        const isLinePixel = (x: number, y: number) => {
            const px = Math.round(x);
            const py = Math.round(y);
            if (px < 0 || py < 0 || px >= width || py >= height) return false;
            const offset = (py * width + px) * 4;
            const { luma, chroma } = pixelStats(data, offset);
            return luma < 182 && chroma < 54;
        };

        const connections = api.createEmptyLuminaConnections();

        // 수평선 (0.43..0.57 대역 샘플링)
        for (let r = 0; r < api.LUMINA_ROW_COUNT; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT - 1; c++) {
                const sample = sampleBand(isLinePixel, points[r][c], points[r][c + 1], 0.43, 0.57, spacing * 0.055);
                connections.horizontal[r][c] = sample.dark >= 1 && sample.density >= 0.045;
            }
        }

        // 대각선 (0.26..0.74 대역 샘플링)
        const minDiagPixels = Math.max(2, Math.round(spacing * 0.13));
        for (let r = 0; r < api.LUMINA_ROW_COUNT - 1; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                const cur = points[r][c];

                if (c < api.LUMINA_COL_COUNT - 1) {
                    const targetRight = points[r + 1][c + 1];
                    const sampleR = sampleBand(isLinePixel, cur, targetRight, 0.26, 0.74, spacing * 0.04);
                    connections.diagDownRight[r][c] = sampleR.dark >= minDiagPixels && sampleR.density >= 0.05;
                }

                if (c > 0) {
                    const targetLeft = points[r + 1][c - 1];
                    const sampleL = sampleBand(isLinePixel, cur, targetLeft, 0.26, 0.74, spacing * 0.04);
                    connections.diagDownLeft[r][c] = sampleL.dark >= minDiagPixels && sampleL.density >= 0.05;
                }
            }
        }

        // 수직선 (0.43..0.57 대역 샘플링)
        for (let r = 0; r < api.LUMINA_ROW_COUNT - 1; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                const sample = sampleBand(isLinePixel, points[r][c], points[r + 1][c], 0.43, 0.57, spacing * 0.055);
                if (connections.vertical) {
                    connections.vertical[r][c] = sample.dark >= 1 && sample.density >= 0.045;
                }
            }
        }

        return connections;
    }

    // ── 미션 매칭 ──
    function matchMissions(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        points: Array<Array<{ x: number; y: number }>>
    ) {
        const canvasData = ctx.getImageData(0, 0, width, height).data;
        const grid: any[][] = [];

        for (let r = 0; r < api.LUMINA_ROW_COUNT; r++) {
            const row: any[] = [];
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                const pt = points[r][c];
                let bestMId: string | undefined;
                let bestDiff = Infinity;

                for (const [mId, tplData] of missionTemplates.entries()) {
                    let totalDiff = 0;
                    let count = 0;
                    const tw = tplData.width;
                    const th = tplData.height;
                    const tcx = Math.floor(tw / 2);
                    const tcy = Math.floor(th / 2);

                    // 마름모 내부 |dx| + |dy| <= 10 영역 정밀 비교
                    for (let dy = -10; dy <= 10; dy++) {
                        for (let dx = -10; dx <= 10; dx++) {
                            if (Math.abs(dx) + Math.abs(dy) > 10) continue;
                            const nx = pt.x + dx;
                            const ny = pt.y + dy;
                            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

                            const nIdx = (ny * width + nx) * 4;
                            const tIdx = ((tcy + dy) * tw + (tcx + dx)) * 4;

                            const dr = canvasData[nIdx] - tplData.data[tIdx];
                            const dg = canvasData[nIdx + 1] - tplData.data[tIdx + 1];
                            const db = canvasData[nIdx + 2] - tplData.data[tIdx + 2];
                            totalDiff += Math.sqrt(dr * dr + dg * dg + db * db);
                            count++;
                        }
                    }

                    const avgDiff = count ? totalDiff / count : Infinity;
                    if (avgDiff < bestDiff) {
                        bestDiff = avgDiff;
                        bestMId = mId;
                    }
                }

                row.push({
                    row: r,
                    col: c,
                    missionId: bestMId,
                    baseScore: api.calculateLuminaNodeScore
                        ? api.calculateLuminaNodeScore(r, bestMId, currentDifficulty)
                        : api.calculateLuminaBaseScore(r, currentDifficulty)
                });
            }
            grid.push(row);
        }

        return grid;
    }

    // ── 경로 탐색 및 UI 업데이트 ──
    function updatePathsAndUI() {
        // 난이도 및 미션에 따른 점수 갱신
        for (let r = 0; r < api.LUMINA_ROW_COUNT; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                if (currentGridData[r]?.[c]) {
                    const mId = currentGridData[r][c].missionId;
                    currentGridData[r][c].baseScore = api.calculateLuminaNodeScore
                        ? api.calculateLuminaNodeScore(r, mId, currentDifficulty)
                        : api.calculateLuminaBaseScore(r, currentDifficulty);
                }
            }
        }

        currentPaths = api.findLuminaOptimalPaths(
            currentConnections,
            currentGridData,
            currentMode,
            3,
            {
                difficulty: currentDifficulty,
                partySize: currentPartySize
            }
        );

        (window as any).luminaCorridorPaths = currentPaths;
        (window as any).luminaDebugConnections = currentConnections;

        if (selectedPathIndex >= currentPaths.length) {
            selectedPathIndex = 0;
        }

        renderViewer();
        renderSummary();
    }

    // ── 뷰어 렌더링 ──
    function renderViewer() {
        if (!currentImage || currentGridPoints.length === 0) return;

        const imgEl = $('sourceImage') as HTMLImageElement;
        imgEl.src = currentImage.src;

        const svg = $('overlaySvg') as unknown as SVGSVGElement;
        svg.setAttribute('viewBox', `0 0 ${currentImage.naturalWidth} ${currentImage.naturalHeight}`);
        svg.innerHTML = '';

        const activePath = currentPaths[selectedPathIndex];
        const pathCoords = activePath ? activePath.path : [];

        // 경로에 포함된 선분 맵 생성
        const inPathHorizontal = new Set<string>();
        const inPathDiag = new Set<string>();

        for (let i = 0; i < pathCoords.length - 1; i++) {
            const cur = pathCoords[i];
            const nxt = pathCoords[i + 1];
            if (cur.row === nxt.row) {
                const minC = Math.min(cur.col, nxt.col);
                inPathHorizontal.add(`${cur.row},${minC}`);
            } else {
                inPathDiag.add(`${cur.row},${cur.col}->${nxt.row},${nxt.col}`);
            }
        }

        // 1. 모든 감지된 점선 렌더링
        // 수평선
        for (let r = 0; r < api.LUMINA_ROW_COUNT; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT - 1; c++) {
                const p1 = currentGridPoints[r][c];
                const p2 = currentGridPoints[r][c + 1];
                const hasEdge = currentConnections.horizontal[r][c];
                const isPath = inPathHorizontal.has(`${r},${c}`);

                // 클릭 가능한 인터랙티브 히트박스 라인
                const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                hitLine.setAttribute('x1', String(p1.x));
                hitLine.setAttribute('y1', String(p1.y));
                hitLine.setAttribute('x2', String(p2.x));
                hitLine.setAttribute('y2', String(p2.y));
                hitLine.setAttribute('stroke', 'transparent');
                hitLine.setAttribute('stroke-width', '16');
                hitLine.setAttribute('cursor', 'pointer');
                hitLine.addEventListener('click', () => {
                    currentConnections.horizontal[r][c] = !currentConnections.horizontal[r][c];
                    updatePathsAndUI();
                });

                svg.appendChild(hitLine);

                if (hasEdge || isPath) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', String(p1.x));
                    line.setAttribute('y1', String(p1.y));
                    line.setAttribute('x2', String(p2.x));
                    line.setAttribute('y2', String(p2.y));

                    if (isPath) {
                        line.setAttribute('stroke', '#38bdf8');
                        line.setAttribute('stroke-width', '4');
                        line.setAttribute('filter', 'url(#glow)');
                    } else {
                        line.setAttribute('stroke', 'rgba(148, 163, 184, 0.4)');
                        line.setAttribute('stroke-width', '2');
                        line.setAttribute('stroke-dasharray', '3,3');
                    }
                    svg.appendChild(line);
                }
            }
        }

        // 대각선
        for (let r = 0; r < api.LUMINA_ROW_COUNT - 1; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                const cur = currentGridPoints[r][c];

                // 좌하향
                if (c > 0) {
                    const left = currentGridPoints[r + 1][c - 1];
                    const hasEdge = currentConnections.diagDownLeft[r][c];
                    const isPath = inPathDiag.has(`${r},${c}->${r + 1},${c - 1}`);

                    const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    hitLine.setAttribute('x1', String(cur.x));
                    hitLine.setAttribute('y1', String(cur.y));
                    hitLine.setAttribute('x2', String(left.x));
                    hitLine.setAttribute('y2', String(left.y));
                    hitLine.setAttribute('stroke', 'transparent');
                    hitLine.setAttribute('stroke-width', '16');
                    hitLine.setAttribute('cursor', 'pointer');
                    hitLine.addEventListener('click', () => {
                        currentConnections.diagDownLeft[r][c] = !currentConnections.diagDownLeft[r][c];
                        updatePathsAndUI();
                    });
                    svg.appendChild(hitLine);

                    if (hasEdge || isPath) {
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                        line.setAttribute('x1', String(cur.x));
                        line.setAttribute('y1', String(cur.y));
                        line.setAttribute('x2', String(left.x));
                        line.setAttribute('y2', String(left.y));

                        if (isPath) {
                            line.setAttribute('stroke', '#38bdf8');
                            line.setAttribute('stroke-width', '4');
                            line.setAttribute('filter', 'url(#glow)');
                        } else {
                            line.setAttribute('stroke', 'rgba(148, 163, 184, 0.4)');
                            line.setAttribute('stroke-width', '2');
                            line.setAttribute('stroke-dasharray', '3,3');
                        }
                        svg.appendChild(line);
                    }
                }

                // 우하향
                if (c < api.LUMINA_COL_COUNT - 1) {
                    const right = currentGridPoints[r + 1][c + 1];
                    const hasEdge = currentConnections.diagDownRight[r][c];
                    const isPath = inPathDiag.has(`${r},${c}->${r + 1},${c + 1}`);

                    const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    hitLine.setAttribute('x1', String(cur.x));
                    hitLine.setAttribute('y1', String(cur.y));
                    hitLine.setAttribute('x2', String(right.x));
                    hitLine.setAttribute('y2', String(right.y));
                    hitLine.setAttribute('stroke', 'transparent');
                    hitLine.setAttribute('stroke-width', '16');
                    hitLine.setAttribute('cursor', 'pointer');
                    hitLine.addEventListener('click', () => {
                        currentConnections.diagDownRight[r][c] = !currentConnections.diagDownRight[r][c];
                        updatePathsAndUI();
                    });
                    svg.appendChild(hitLine);

                    if (hasEdge || isPath) {
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                        line.setAttribute('x1', String(cur.x));
                        line.setAttribute('y1', String(cur.y));
                        line.setAttribute('x2', String(right.x));
                        line.setAttribute('y2', String(right.y));

                        if (isPath) {
                            line.setAttribute('stroke', '#38bdf8');
                            line.setAttribute('stroke-width', '4');
                            line.setAttribute('filter', 'url(#glow)');
                        } else {
                            line.setAttribute('stroke', 'rgba(148, 163, 184, 0.4)');
                            line.setAttribute('stroke-width', '2');
                            line.setAttribute('stroke-dasharray', '3,3');
                        }
                        svg.appendChild(line);
                    }
                }
            }
        }

        // 수직선
        for (let r = 0; r < api.LUMINA_ROW_COUNT - 1; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                const cur = currentGridPoints[r][c];
                const down = currentGridPoints[r + 1][c];
                const hasEdge = currentConnections.vertical?.[r]?.[c];
                const isPath = inPathDiag.has(`${r},${c}->${r + 1},${c}`);

                const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                hitLine.setAttribute('x1', String(cur.x));
                hitLine.setAttribute('y1', String(cur.y));
                hitLine.setAttribute('x2', String(down.x));
                hitLine.setAttribute('y2', String(down.y));
                hitLine.setAttribute('stroke', 'transparent');
                hitLine.setAttribute('stroke-width', '16');
                hitLine.setAttribute('cursor', 'pointer');
                hitLine.addEventListener('click', () => {
                    if (!currentConnections.vertical) currentConnections.vertical = api.createEmptyLuminaConnections().vertical;
                    currentConnections.vertical[r][c] = !currentConnections.vertical[r][c];
                    updatePathsAndUI();
                });
                svg.appendChild(hitLine);

                if (hasEdge || isPath) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', String(cur.x));
                    line.setAttribute('y1', String(cur.y));
                    line.setAttribute('x2', String(down.x));
                    line.setAttribute('y2', String(down.y));

                    if (isPath) {
                        line.setAttribute('stroke', '#38bdf8');
                        line.setAttribute('stroke-width', '4');
                        line.setAttribute('filter', 'url(#glow)');
                    } else {
                        line.setAttribute('stroke', 'rgba(148, 163, 184, 0.4)');
                        line.setAttribute('stroke-width', '2');
                        line.setAttribute('stroke-dasharray', '3,3');
                    }
                    svg.appendChild(line);
                }
            }
        }

        // 2. 노드 뱃지 및 인터랙션 렌더링
        const stepMap = new Map<string, number>();
        pathCoords.forEach((p: any, idx: number) => {
            stepMap.set(`${p.row},${p.col}`, idx + 1);
        });

        for (let r = 0; r < api.LUMINA_ROW_COUNT; r++) {
            for (let c = 0; c < api.LUMINA_COL_COUNT; c++) {
                const pt = currentGridPoints[r][c];
                const nodeData = currentGridData[r]?.[c];
                const stepNum = stepMap.get(`${r},${c}`);
                const mission = nodeData?.missionId ? api.LUMINA_MISSIONS[nodeData.missionId] : null;

                // 노드 그룹
                const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                g.setAttribute('class', 'cursor-pointer');

                // 마우스 호버 툴팁 이벤트
                g.addEventListener('mouseenter', (e) => {
                    showNodeTooltip(e, r, c, nodeData, mission, stepNum);
                });
                g.addEventListener('mouseleave', () => {
                    hideNodeTooltip();
                });

                if (stepNum !== undefined) {
                    // 경로에 포함된 노드: 반투명 골드/블루 원 & 순번 번호 (마우스 호버 시 더 투명해져 아이콘 가시성 확보)
                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('cx', String(pt.x));
                    circle.setAttribute('cy', String(pt.y));
                    circle.setAttribute('r', '15');
                    circle.setAttribute('fill', 'rgba(15, 23, 42, 0.45)');
                    circle.setAttribute('stroke', '#38bdf8');
                    circle.setAttribute('stroke-width', '2.5');
                    circle.setAttribute('filter', 'url(#glow)');
                    circle.setAttribute('id', `svg-node-${r}-${c}`);
                    circle.setAttribute('style', 'transition: fill 0.15s, stroke 0.15s, stroke-width 0.15s;');
                    g.appendChild(circle);

                    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    text.setAttribute('x', String(pt.x));
                    text.setAttribute('y', String(pt.y + 4.5));
                    text.setAttribute('text-anchor', 'middle');
                    text.setAttribute('fill', '#f0f9ff');
                    text.setAttribute('font-size', '12');
                    text.setAttribute('font-weight', '900');
                    text.setAttribute('font-family', 'sans-serif');
                    text.setAttribute('pointer-events', 'none');
                    text.textContent = String(stepNum);
                    g.appendChild(text);

                    // 캔버스 마커 호버 시 미션 아이콘 확인이 용이하도록 배경 투명화
                    g.addEventListener('mouseenter', () => {
                        circle.setAttribute('fill', 'rgba(15, 23, 42, 0.15)');
                        circle.setAttribute('stroke-width', '3.5');
                    });
                    g.addEventListener('mouseleave', () => {
                        circle.setAttribute('fill', 'rgba(15, 23, 42, 0.45)');
                        circle.setAttribute('stroke-width', '2.5');
                    });
                } else {
                    // 미포함 노드: 투명 원 (호버 감지용)
                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('cx', String(pt.x));
                    circle.setAttribute('cy', String(pt.y));
                    circle.setAttribute('r', '16');
                    circle.setAttribute('fill', 'transparent');
                    circle.setAttribute('stroke', 'transparent');
                    circle.setAttribute('id', `svg-node-${r}-${c}`);
                    g.appendChild(circle);
                }

                svg.appendChild(g);
            }
        }
    }

    // ── 시간 포맷팅 헬퍼 ──
    function formatClearTime(sec: number): string {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        if (m === 0) return `${s}초`;
        if (s === 0) return `약 ${m}분`;
        return `약 ${m}분 ${s}초`;
    }

    // ── 툴팁 처리 ──
    const tooltipEl = $('nodeTooltip');
    function showNodeTooltip(e: MouseEvent, r: number, c: number, node: any, mission: any, stepNum?: number) {
        if (!tooltipEl) return;
        const stageName = `${r + 1}단계 (노드 ${c + 1})`;
        const scoreVal = node?.baseScore ?? (api.calculateLuminaNodeScore
            ? api.calculateLuminaNodeScore(r, mission?.id, currentDifficulty)
            : api.calculateLuminaBaseScore(r, currentDifficulty));
        const mName = mission ? (mission.nameKo || mission.name) : '미확인 미션';
        const guide = mission ? mission.guideTip : '일반 미션';

        $('tooltipStage').textContent = stageName;
        $('tooltipOrder').textContent = stepNum ? `방문 순서: ${stepNum}번째` : '미경유 노드';
        $('tooltipMission').textContent = mName;
        $('tooltipScore').textContent = `기본 점수: ${scoreVal.toLocaleString()}점`;
        $('tooltipGuide').textContent = guide;

        const tierBadgeEl = $('tooltipTierBadge');
        if (tierBadgeEl) {
            const tag = mission?.tag || mission?.recommendation;
            if (tag) {
                tierBadgeEl.textContent = tag;
                if (tag === '추천') {
                    tierBadgeEl.className = 'text-[9px] font-black px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
                } else if (tag === '비추천') {
                    tierBadgeEl.className = 'text-[9px] font-black px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30';
                } else {
                    tierBadgeEl.className = 'text-[9px] font-black px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30';
                }
                tierBadgeEl.classList.remove('hidden');
            } else {
                tierBadgeEl.classList.add('hidden');
            }
        }

        if (mission?.iconFileName) {
            ($('tooltipIcon') as HTMLImageElement).src = `assets/lumina/icons/${mission.iconFileName}`;
            $('tooltipIcon').classList.remove('hidden');
        } else {
            $('tooltipIcon').classList.add('hidden');
        }

        const rect = $('viewerContainer').getBoundingClientRect();
        tooltipEl.style.left = `${e.clientX - rect.left + 16}px`;
        tooltipEl.style.top = `${e.clientY - rect.top - 20}px`;
        tooltipEl.classList.remove('hidden');
    }

    function hideNodeTooltip() {
        if (tooltipEl) tooltipEl.classList.add('hidden');
    }

    // ── 요약 패널 렌더링 ──
    function renderSummary() {
        const activePath = currentPaths[selectedPathIndex];
        if (!activePath) {
            $('totalScoreText').textContent = '0점';
            $('totalNodesText').textContent = '0개';
            if ($('totalTimeText')) $('totalTimeText').textContent = '0분 0초';
            $('rewardGauge').style.width = '0%';
            $('rewardStatusText').textContent = '도달 가능한 10단계 경로가 없습니다. (연결선 확인)';
            $('pathStepList').innerHTML = '<div class="text-xs text-slate-500 py-4 text-center">경로 없음</div>';
            return;
        }

        $('totalScoreText').textContent = `${activePath.totalScore.toLocaleString()}점`;
        $('totalNodesText').textContent = `${activePath.nodeCount}개`;
        if ($('totalTimeText')) {
            $('totalTimeText').textContent = formatClearTime(activePath.totalTimeSec || 0);
        }

        // 보상 달성도 (다캐릭터 편성 가산점 반영 finalScore 기준)
        const maxScore = 7250;
        const pct = Math.min(100, Math.round((activePath.totalScore / maxScore) * 100));
        $('rewardGauge').style.width = `${pct}%`;

        if (activePath.achievedReward) {
            const cut = activePath.achievedReward;
            $('rewardBadge').textContent = `${cut.rankPercent} 달성`;
            $('rewardBadge').className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30';
            $('rewardSealText').textContent = `회랑의 인장 ${cut.sealCount.toLocaleString()}개 획득 가능`;

            if (activePath.nextReward) {
                $('rewardStatusText').textContent = `다음 목표 [${activePath.nextReward.target.rankPercent} / 인장 ${activePath.nextReward.target.sealCount}개]까지 +${activePath.nextReward.neededScore.toLocaleString()}점 필요`;
            } else {
                $('rewardStatusText').textContent = '최고 보상 컷 (상위 2.0%) 충족! 🏆';
            }
        } else {
            $('rewardBadge').textContent = '점수 부족';
            $('rewardBadge').className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-slate-800 text-slate-400 border border-slate-700';
            const lowest = api.LUMINA_REWARD_CUTS[api.LUMINA_REWARD_CUTS.length - 1];
            $('rewardSealText').textContent = '인장 보상 미달';
            $('rewardStatusText').textContent = `최소 보상 [${lowest.rankPercent} / 600점]까지 +${(lowest.minScore - activePath.totalScore).toLocaleString()}점 필요`;
        }

        // 경로 단계별 목록
        const listEl = $('pathStepList');
        listEl.innerHTML = '';
        activePath.path.forEach((p: any, idx: number) => {
            const node = currentGridData[p.row]?.[p.col];
            const mission = node?.missionId ? api.LUMINA_MISSIONS[node.missionId] : null;
            const stepDetail = activePath.stepDetails?.[idx];

            const item = document.createElement('div');
            item.className = 'flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-white/5 hover:border-sky-500/40 hover:bg-slate-800/60 transition-all text-xs cursor-pointer';

            const leftDiv = document.createElement('div');
            leftDiv.className = 'flex items-center gap-2 min-w-0 flex-wrap';

            const badge = document.createElement('span');
            badge.className = 'w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 font-black flex items-center justify-center text-[10px] shrink-0 border border-sky-500/30';
            badge.textContent = String(idx + 1);

            const mName = document.createElement('span');
            mName.className = 'font-bold text-slate-200 truncate';
            mName.textContent = mission ? (mission.nameKo || mission.name) : `${p.row + 1}단계 노드`;

            leftDiv.appendChild(badge);
            leftDiv.appendChild(mName);

            const tag = mission?.tag || mission?.recommendation;
            if (tag) {
                const recBadge = document.createElement('span');
                if (tag === '추천') {
                    recBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shrink-0';
                } else if (tag === '비추천') {
                    recBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 shrink-0';
                } else {
                    recBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 shrink-0';
                }
                recBadge.textContent = tag;
                leftDiv.appendChild(recBadge);
            }

            // 연속 미션 페널티 경고 뱃지
            if (stepDetail?.hasConsecutivePenalty) {
                const penBadge = document.createElement('span');
                penBadge.className = 'text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0';
                penBadge.textContent = `연속 페널티 (-${stepDetail.penaltyAmount}점)`;
                leftDiv.appendChild(penBadge);
            }

            const rightDiv = document.createElement('div');
            rightDiv.className = 'text-right font-mono font-bold text-slate-300 text-[11px] shrink-0 ml-2';
            const stepScore = stepDetail?.nodeScore ?? (node?.baseScore || 0);
            rightDiv.textContent = `+${stepScore.toLocaleString()}점`;

            item.appendChild(leftDiv);
            item.appendChild(rightDiv);

            // 목록 항목 호버 시 캔버스 SVG 마커 하이라이트 연동
            item.addEventListener('mouseenter', () => {
                const targetCircle = document.getElementById(`svg-node-${p.row}-${p.col}`);
                if (targetCircle) {
                    targetCircle.setAttribute('fill', 'rgba(56, 189, 248, 0.4)');
                    targetCircle.setAttribute('stroke-width', '4');
                }
            });
            item.addEventListener('mouseleave', () => {
                const targetCircle = document.getElementById(`svg-node-${p.row}-${p.col}`);
                if (targetCircle) {
                    targetCircle.setAttribute('fill', 'rgba(15, 23, 42, 0.45)');
                    targetCircle.setAttribute('stroke-width', '2.5');
                }
            });

            listEl.appendChild(item);
        });

        // 대체 경로 탭 업데이트 (간결한 칩 스타일)
        const pathTabContainer = $('altPathTabs');
        pathTabContainer.innerHTML = '';
        if (currentPaths.length > 1) {
            currentPaths.forEach((pathItem, idx) => {
                const btn = document.createElement('button');
                const isSel = idx === selectedPathIndex;
                btn.className = `flex-1 py-1.5 px-1 rounded-lg text-xs font-bold transition-all text-center whitespace-nowrap ${
                    isSel
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm shadow-sky-500/10'
                        : 'bg-slate-950/60 text-slate-400 border border-white/5 hover:bg-slate-800/40 hover:text-slate-200'
                }`;
                btn.textContent = idx === 0 ? '1순위 (최적)' : `${idx + 1}순위`;
                const timeStr = formatClearTime(pathItem.totalTimeSec || 0);
                btn.title = `${idx + 1}순위: ${pathItem.totalScore.toLocaleString()}점 / ${pathItem.nodeCount}개 노드 / ${timeStr}`;
                btn.addEventListener('click', () => {
                    selectedPathIndex = idx;
                    renderViewer();
                    renderSummary();
                });
                pathTabContainer.appendChild(btn);
            });
        }
    }

    // ── 이벤트 리스너 등록 ──
    function initEvents() {
        // 클립보드 붙여넣기 (Ctrl + V)
        window.addEventListener('paste', (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const blob = items[i].getAsFile();
                    if (blob) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                            const img = new Image();
                            img.onload = () => processImage(img);
                            img.src = event.target?.result as string;
                        };
                        reader.readAsDataURL(blob);
                    }
                    break;
                }
            }
        });

        // 드래그 앤 드롭
        const dropZone = $('dropZone');
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            const files = e.dataTransfer?.files;
            if (files && files.length > 0 && files[0].type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const img = new Image();
                    img.onload = () => processImage(img);
                    img.src = event.target?.result as string;
                };
                reader.readAsDataURL(files[0]);
            }
        });

        // 파일 선택 인풋
        $('fileInput').addEventListener('change', (e: any) => {
            const files = e.target.files;
            if (files && files.length > 0) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const img = new Image();
                    img.onload = () => processImage(img);
                    img.src = event.target?.result as string;
                };
                reader.readAsDataURL(files[0]);
            }
        });

        // 샘플 로드 버튼 (헤더 및 드롭존)
        const bindSample = (id: string, path: string) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('click', () => {
                    const img = new Image();
                    img.onload = () => processImage(img);
                    img.src = path;
                });
            }
        };
        bindSample('btnSample1', 'assets/lumina/path1.png');
        bindSample('btnSample1_drop', 'assets/lumina/path1.png');
        bindSample('btnSample2', 'assets/lumina/path2.png');
        bindSample('btnSample2_drop', 'assets/lumina/path2.png');

        // 난이도 선택 라디오 버튼
        ['normal', 'hard', 'hell'].forEach((diff) => {
            $(`diff-${diff}`)?.addEventListener('click', () => {
                currentDifficulty = diff as any;
                ['normal', 'hard', 'hell'].forEach((d) => {
                    $(`diff-${d}`)?.classList.remove('active');
                });
                $(`diff-${diff}`)?.classList.add('active');
                updatePathsAndUI();
            });
        });

        // 편성 캐릭터 수 선택 (1명 ~ 4명)
        [1, 2, 3, 4].forEach((pSize) => {
            $(`party-${pSize}`)?.addEventListener('click', () => {
                currentPartySize = pSize as any;
                [1, 2, 3, 4].forEach((s) => {
                    $(`party-${s}`)?.classList.remove('active');
                });
                $(`party-${pSize}`)?.classList.add('active');
                updatePathsAndUI();
            });
        });

        // 탐색 모드 탭
        const modeBtnIds = [
            { id: 'mode-highest_score', mode: 'highScore' },
            { id: 'mode-max_nodes', mode: 'maxNodes' },
            { id: 'mode-shortest', mode: 'fastClear' }
        ];

        modeBtnIds.forEach(({ id, mode }) => {
            $(id)?.addEventListener('click', () => {
                currentMode = mode as any;
                modeBtnIds.forEach((m) => {
                    $(m.id)?.classList.remove('active');
                });
                $(id)?.classList.add('active');
                selectedPathIndex = 0;
                updatePathsAndUI();
            });
        });

        // 리셋 / 새 이미지 등록
        $('btnReset')?.addEventListener('click', () => {
            currentImage = null;
            $('dropZone').classList.remove('hidden');
            $('viewerContainer').classList.add('hidden');
        });

        // 창 닫기 / 최소화
        $('btnClose')?.addEventListener('click', () => {
            if ((window as any).electronAPI?.closeCurrentWindow) {
                (window as any).electronAPI.closeCurrentWindow();
            } else {
                window.close();
            }
        });

        $('btnMinimize')?.addEventListener('click', () => {
            if ((window as any).electronAPI?.minimizeCurrentWindow) {
                (window as any).electronAPI.minimizeCurrentWindow();
            }
        });
    }

    // ── 초기화 실행 ──
    async function init() {
        initEvents();
        await loadMissionTemplates();
        if ((window as any).lucide) {
            (window as any).lucide.createIcons();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
