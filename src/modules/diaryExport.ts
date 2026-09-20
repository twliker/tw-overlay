import type { DiaryExportSnapshot } from '../shared/companionFiles';

export function validateDiaryRange(start: unknown, end: unknown): asserts start is string {
  const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 9999
    && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!date(start) || !date(end) || start > end) throw new Error('시작일과 종료일을 확인해 주세요.');
  if (Date.parse(end) - Date.parse(start) > 365 * 86400000) throw new Error('한 번에 최대 366일의 기록을 저장할 수 있습니다.');
}
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
/** 브라우저에서 바로 읽는 정적 파일. 원문은 모두 이스케이프하고 외부 요청·스크립트를 허용하지 않는다. */
export function renderDiaryExport(snapshot: DiaryExportSnapshot): string {
  const rows = snapshot.rows.map(row => `<tr><td>${escape(row.date)}</td><td>${escape(row.time)}</td><td>${row.kind}</td><td>${escape(row.content)}</td><td>${row.amount.toLocaleString('ko-KR')}${row.kind === '수익' ? ' SEED' : row.kind === '득템' ? '개' : '회'}</td></tr>`).join('\n');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>모험 일지 · ${snapshot.start} ~ ${snapshot.end}</title><style>body{font:14px/1.65 "Malgun Gothic",sans-serif;background:#0f121e;color:#cbd5e1;margin:0;padding:32px}main{max-width:1100px;margin:auto}h1{color:#fff;font-size:24px}strong{color:#14b8a6}.table{overflow:auto}table{width:100%;border-collapse:collapse;background:#1e2338}th,td{text-align:left;padding:12px;border-bottom:1px solid #334155}td:nth-child(4){min-width:220px;overflow-wrap:anywhere}td:not(:nth-child(4)){white-space:nowrap}th{color:#fff}@media print{body,table{background:#fff;color:#111}h1,th,strong{color:#111}body{padding:0}}</style></head><body><main><h1>모험 일지</h1><p>${snapshot.start} ~ ${snapshot.end} · ${snapshot.rows.length.toLocaleString('ko-KR')}건</p><p>총수익 <strong>${snapshot.totalSeed.toLocaleString('ko-KR')} SEED</strong></p><p>현재 일지의 숙제·득템·확정 수익 기록입니다. 금화 주머니 환산은 수익에 포함됩니다. 채팅 원문과 개인 메모는 포함하지 않습니다.</p><div class="table"><table><thead><tr><th>날짜</th><th>시각</th><th>종류</th><th>내용</th><th>수량·금액</th></tr></thead><tbody>${rows}</tbody></table></div>${rows ? '' : '<p>이 기간에 저장된 기록이 없습니다.</p>'}</main></body></html>`;
}
