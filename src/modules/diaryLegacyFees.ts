import type Database = require('better-sqlite3');

export const GOLD_POUCH_DAILY_CONTENT='[자동] 금화 주머니 환산';

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

export const ELSO_DAILY_CONTENT='엘소 포인트 획득';
/** 같은 날짜에 프로필 복원이 실제로 그 일합계를 집계했고(state_json의 날짜별 집계 > 0) 그 결과로 만든
 * 프로필 소유 자동 행이 있을 때만 참이다. 복원이 구버전 확정 구간을 제외해 새 행을 만들지 않았다면
 * 구버전 행은 유일한 기록이므로 그대로 보인다. */
// 짝(b)은 프로필 소유 행만 본다. v2.7.1 이전 DB에서는 출처를 지정하지 않은 자동 행이 'legacy-unknown'으로 저장됐다.
const restoredDailySql=(aggregate:string,valueJoin:string,valuePath:string)=>`EXISTS(SELECT 1 FROM activity_logs b
  JOIN profile_log_sync_state s ON s.profile_id=b.profile_id
  JOIN json_each(s.state_json,'$.${aggregate}') g ON g.key=a.date ${valueJoin}
  WHERE b.date=a.date AND b.type=a.type AND b.content=a.content AND b.amount>0 AND b.source IN ('automatic','legacy-unknown')
    AND json_extract(${valuePath})>0)`;
/**
 * 기능 계약 — 구버전(v3.2.2) 실시간 일합계와 프로필 복원 일합계의 이중 집계 보정.
 * v3.2.2 실시간 tail은 복원 진행 위치를 남기지 않아 프로필 복원이 같은 줄을 다시 집계한다. 출처 없는
 * (프로필·기기·세션 NULL) 구형 금화 주머니·엘소 포인트·등급별 마정석 일합계는 같은 날 같은 내용의
 * 복원 행과 복원 집계 증거가 있을 때만 '확인 필요'(legacy_review=1)로 분리한다. 원본 행/UUID는 보존하고
 * 모든 일지 조회(일/주/월 합계·통계·달력·득템 목록·내보내기)는 이 열로 합계에서 제외해 별도 표시한다.
 * legacy_gold_review는 금화 행만 표시하는 기존 열이다. 회귀: check-profile-log-restore.ts, check-profile-upgrade.ts.
 */
const legacyDailyReviewSql=`CASE WHEN a.profile_id IS NULL AND a.record_device_id IS NULL AND a.record_session_id IS NULL
  AND a.amount>0 AND a.source IN ('automatic','legacy-unknown') AND (
    (a.type='calc' AND a.content='${GOLD_POUCH_DAILY_CONTENT}' AND ${restoredDailySql('goldPouchSeedByDate','',"g.value,'$.totalAmount'")})
    OR (a.type='elso' AND a.content='${ELSO_DAILY_CONTENT}' AND ${restoredDailySql('elsoByDate','',"g.value,'$.totalAmount'")})
    OR (a.type='loot' AND a.content LIKE '[득템] [% 마정석]' AND ${restoredDailySql('magicStones',
      "JOIN json_each(g.value) k ON a.content='[득템] ['||k.key||' 마정석]'","k.value,'$.totalCount'")}))
  THEN 1 ELSE 0 END`;

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
    CREATE VIEW diary_visible_activity_logs AS SELECT v.*,CASE WHEN v.type='calc' THEN v.legacy_review ELSE 0 END AS legacy_gold_review FROM (
      SELECT a.*, ${hasProfiles ? legacyDailyReviewSql : '0'} AS legacy_review FROM activity_logs a
      WHERE NOT EXISTS(SELECT 1 FROM diary_fee_duplicates d JOIN activity_logs c ON c.record_uuid=d.canonical_uuid
        WHERE d.legacy_uuid=a.record_uuid AND (a.profile_id IS c.profile_id ${hasProfiles ? "OR NOT EXISTS(SELECT 1 FROM play_profiles p WHERE p.id=a.profile_id AND p.deleted_at IS NULL)" : ''}))) v;`);
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
