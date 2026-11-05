import type Database = require('better-sqlite3');

interface FeeRow {record_uuid:string;date:string;time:string;content:string;amount:number;profile_id:string | null;record_device_id:string | null;record_session_id:string | null}
const canonicalFeePattern=/^\[자동\] 어벤던로드 입장료 \(-([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*) SEED\)$/;
export const isCanonicalDiaryFee=(content:string):boolean => canonicalFeePattern.test(content);

/** 구형 지불 원문의 정수·조/억/만 단위만 검증한다. 불완전/추정 금액은 보정 대상이 아니다. */
function paidAmount(text:string):number | null {
  const value=text.replace(/[,\s]/g,'');
  let total=0,matched='',previous=Infinity;
  for(const part of value.matchAll(/(\d+)(조|억|만|$)/gu)) {
    const unit=part[2]==='조' ? 1e12 : part[2]==='억' ? 1e8 : part[2]==='만' ? 1e4 : 1;
    if(unit>=previous)return null;
    previous=unit;matched+=part[0];total+=Number(part[1])*unit;
  }
  return matched===value && total>0 && Number.isSafeInteger(total) ? total : null;
}

/**
 * 기능 계약 — 구버전 입장료와 재복원 입장료의 이중 집계 보정.
 * 날짜·초·음수가 일치하는 구형 지불 원문과 새 입장료 문구만 1:1로 연결한다.
 * 구형 행에 기기/세션이 없고 같은 소유자이거나 소유자가 삭제/유실된 경우만 허용한다.
 * 지불 원문/새 문구의 실제 금액과 저장 amount도 일치해야 하며 손상된 자료는 숨기지 않는다.
 * 서로 다른 현재 프로필·수동 입력·서로 다른 초·같은 형식의 반복 지불은 합치지 않는다.
 * 원본 행/UUID는 보존하고 모든 일지 조회가 동일한 view를 사용한다. 상대 원본이 제거되면
 * 보존한 구형 행을 다시 표시한다. 초기화/입장료 저장 transaction에서만 갱신하며 getter는 쓰지 않는다.
 * 회귀: check-profile-diary.ts의 구형/복원/2PC/반복/rollback/재시작 경계.
 */
export function initializeDiaryFeeVisibility(db:Database.Database,hasProfiles:boolean):void {
  db.exec(`CREATE TABLE IF NOT EXISTS diary_fee_duplicates(legacy_uuid TEXT PRIMARY KEY,canonical_uuid TEXT NOT NULL);
    DROP VIEW IF EXISTS diary_visible_activity_logs;
    CREATE VIEW diary_visible_activity_logs AS SELECT a.* FROM activity_logs a
    WHERE NOT EXISTS(SELECT 1 FROM diary_fee_duplicates d JOIN activity_logs c ON c.record_uuid=d.canonical_uuid
      WHERE d.legacy_uuid=a.record_uuid AND (a.profile_id IS c.profile_id ${hasProfiles ? "OR NOT EXISTS(SELECT 1 FROM play_profiles p WHERE p.id=a.profile_id AND p.deleted_at IS NULL)" : ''}));`);
  reconcileDiaryFees(db,hasProfiles);
}
export function reconcileDiaryFees(db:Database.Database,hasProfiles:boolean,date?:string):void {
  const live=new Set(hasProfiles ? (db.prepare('SELECT id FROM play_profiles WHERE deleted_at IS NULL').all() as {id:string}[]).map(p=>p.id) : []);
  const rows=db.prepare(`SELECT record_uuid,date,time,content,amount,profile_id,record_device_id,record_session_id FROM activity_logs
    WHERE type='calc' AND amount<0 AND source IN ('automatic','legacy-unknown') AND content LIKE '[자동] %입장료%'${date ? ' AND date=?' : ''} ORDER BY id`).all(...(date ? [date] : [])) as FeeRow[];
  const groups=new Map<string,{old:FeeRow[];current:FeeRow[]}>();
  for(const row of rows) {
    const current=isCanonicalDiaryFee(row.content);
    if(current) {
      if(paidAmount(row.content.match(canonicalFeePattern)![1])!==-row.amount)continue;
    } else {
      const original=row.content.match(/^\[자동\] 입장료 ([\d,조억만\s]+) Seed를 지불\s*하였습니다\.\s*\(-[\d,조억만\s]+(?: SEED| 시드)?\)$/);
      if(!original || row.record_device_id || row.record_session_id || paidAmount(original[1])!==-row.amount)continue;
    }
    const parts=row.time.split(':').map(Number);
    if(parts.length!==3 || parts.some((n,i)=>!Number.isInteger(n) || n<0 || n>=[24,60,60][i]))continue;
    const key=JSON.stringify([row.date,parts,row.amount]);
    let group=groups.get(key);if(!group)groups.set(key,group={old:[],current:[]});
    group[current ? 'current' : 'old'].push(row);
  }
  db.transaction(()=>{
    if(date)db.prepare('DELETE FROM diary_fee_duplicates WHERE legacy_uuid IN (SELECT record_uuid FROM activity_logs WHERE date=?)').run(date);
    else db.prepare('DELETE FROM diary_fee_duplicates').run();
    const insert=db.prepare('INSERT INTO diary_fee_duplicates VALUES(?,?)');
    for(const {old,current} of groups.values()) {
      // 소유자가 확인된 쌍을 먼저 확정해야 더 오래된 미배정 행이 그 상대를 가져가지 않는다.
      const unmatched=old.filter(legacy=>{
        const index=current.findIndex(row=>row.profile_id===legacy.profile_id);
        if(index<0)return true;
        insert.run(legacy.record_uuid,current[index].record_uuid);current.splice(index,1);return false;
      });
      for(const legacy of unmatched) {
        if(legacy.profile_id!==null && live.has(legacy.profile_id))continue;
        const index=current.findIndex(row=>row.profile_id!==null && live.has(row.profile_id));
        if(index<0)continue;
        insert.run(legacy.record_uuid,current[index].record_uuid);current.splice(index,1);
      }
    }
  })();
}
