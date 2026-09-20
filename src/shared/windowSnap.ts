interface SnapRectangle { x: number; y: number; width: number; height: number }
interface WindowSnapApi {
  snap(rect: SnapRectangle, peers: SnapRectangle[], area: SnapRectangle, distance?: number): { x: number; y: number; guideX?: number; guideY?: number };
}
interface Window { windowSnap: WindowSnapApi }
/** 모든 좌표는 같은 공간의 DIP/CSS px이다. 가까우며 서로 맞닿는 범위의 창만 후보로 삼는다.
 * 화면 밖으로 끌려가는 맞춤은 제외한다. 자동 배치·프리셋 복원에는 호출하지 않는다.
 */
((host: Window | null) => {
  const snap: WindowSnapApi['snap'] = (rect, peers, area, distance = 8) => {
    const minX = area.x, maxX = Math.max(minX, area.x + area.width - rect.width);
    const minY = area.y, maxY = Math.max(minY, area.y + area.height - rect.height);
    const result: ReturnType<WindowSnapApi['snap']> = { x: Math.max(minX, Math.min(maxX, rect.x)), y: Math.max(minY, Math.min(maxY, rect.y)) };
    const xs = [{ value: minX, guide: minX }, { value: maxX, guide: area.x + area.width }];
    const ys = [{ value: minY, guide: minY }, { value: maxY, guide: area.y + area.height }];
    for (const peer of peers) {
      if (rect.y <= peer.y + peer.height + distance && rect.y + rect.height >= peer.y - distance) {
        xs.push({ value: peer.x, guide: peer.x }, { value: peer.x + peer.width - rect.width, guide: peer.x + peer.width },
          { value: peer.x - rect.width - 8, guide: peer.x - 8 }, { value: peer.x + peer.width + 8, guide: peer.x + peer.width + 8 });
      }
      if (rect.x <= peer.x + peer.width + distance && rect.x + rect.width >= peer.x - distance) {
        ys.push({ value: peer.y, guide: peer.y }, { value: peer.y + peer.height - rect.height, guide: peer.y + peer.height },
          { value: peer.y - rect.height - 8, guide: peer.y - 8 }, { value: peer.y + peer.height + 8, guide: peer.y + peer.height + 8 });
      }
    }
    const nearest = (items: typeof xs, value: number, min: number, max: number) => items
      .filter(item => item.value >= min && item.value <= max && Math.abs(item.value - value) <= distance)
      .sort((a, b) => Math.abs(a.value - value) - Math.abs(b.value - value))[0];
    const x = nearest(xs, result.x, minX, maxX), y = nearest(ys, result.y, minY, maxY);
    if (x) { result.x = x.value; result.guideX = x.guide; }
    if (y) { result.y = y.value; result.guideY = y.guide; }
    return result;
  };
  const api = { snap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (host) host.windowSnap = api;
})(typeof window !== 'undefined' ? window : null);
