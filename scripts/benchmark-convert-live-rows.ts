/** v3.3.5 완료 대기 원문 변환(ApplicationData.convertResolvedLiveRows)의 1분 압축 한 번 시간을 줄 사이 끊김 비율별로 잰다.
 * - 실제 v3.3.5 DB는 기록 없는 채팅 줄 때문에 평균 2.19행마다 구간이 끊긴다. 끊김이 잦을수록 구간 수가 늘어 느려진다.
 * - 1회째는 처음 압축(변환 예산 120ms, commit 포함 약 150ms 안에서 바꾼 행 수), 2회째는 남은 행을 이어서 바꾼 시간이다.
 * 사용: npm run build && npx electron dist-tools/benchmark-convert-live-rows.js */
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app} from 'electron';

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-bench-convert-'));
app.setPath('userData',fixture);
const root=path.resolve(__dirname,'..');
const {ApplicationData}=require(path.join(root,'dist/modules/applicationData.js'));
const {DEFAULT_CONFIG}=require(path.join(root,'dist/modules/constants.js'));

async function scenario(name:string,rows:number,gapEvery:number,withPath=true):Promise<void> {
  const dir=path.join(fixture,name);fs.mkdirSync(dir);
  const store=await ApplicationData.initialize({directory:dir,deviceId:'PC-bench',defaults:structuredClone(DEFAULT_CONFIG)},structuredClone(DEFAULT_CONFIG));
  try {
    const owner=store.list()[0].id,line=100,total=rows*(gapEvery ? 2 : 1)+10;
    const logFile=path.join(dir,'TWChatLog_2026_11_26.html');
    fs.writeFileSync(logFile,Buffer.alloc(total*line,0x41));
    if (withPath) store.database.prepare('INSERT INTO profile_log_sources VALUES(?,?)').run('bench-key',JSON.stringify({fingerprint:'bench-fp',filePath:logFile}));
    const now=Date.now();
    store.database.transaction(()=>{
      let slot=0;
      for (let n=0;n<rows;n++) {
        if (gapEvery && n%gapEvery===0) slot++; // 기록 없는 채팅 줄 하나를 건너뛴다
        const start=slot*line,end=start+line;slot++;
        const key=n.toString(16).padStart(64,'0'),id=`live-line:${key}:XP_CHANGED:0`;
        store.enqueue('bench-session',{kind:'parsed-profile-event',version:1,event:'XP_CHANGED',sessionId:'bench-session',observedAt:now,
          data:{date:'2026-11-26',timestamp:'10시 00분 00초',message:'',amount:n},source:{fingerprint:'bench-fp',start,end,lineKey:key}},now,id,owner);
      }
      store.database.prepare("UPDATE pending_profile_events SET resolved_at=? WHERE session_id='bench-session'").run(now);
    })();
    const count=()=>(store.database.prepare("SELECT COUNT(*) n FROM pending_profile_events WHERE session_id='bench-session'").get() as {n:number}).n;
    const before=count();
    let t=performance.now();store.compactResolvedEvents(now);const first=performance.now()-t,afterFirst=count();
    t=performance.now();store.compactResolvedEvents(now);const second=performance.now()-t;
    const ranges=(store.database.prepare('SELECT COUNT(*) n FROM log_ranges').get() as {n:number}).n;
    console.log(`${name}: rows=${before} gapEvery=${gapEvery || 'none'} path=${withPath} 1회 ${first.toFixed(0)}ms(${before-afterFirst}행), 2회째 ${second.toFixed(0)}ms, 남은 행 ${count()}, log_ranges ${ranges}행`);
  } finally {store.close();}
}

app.whenReady().then(async()=>{
  await scenario('contiguous',5000,0);
  await scenario('contiguous-nopath',5000,0,false);
  await scenario('gap1-nopath',5000,1,false);
  await scenario('gap-every-4',5000,4);
  await scenario('gap-every-2',5000,2);
  await scenario('gap-every-1',5000,1);
  await scenario('gap-every-1-20k',20000,1);
}).then(()=>{try {fs.rmSync(fixture,{recursive:true,force:true});} catch {/* 임시 폴더 */} app.exit(0);},error=>{console.error(error);app.exit(1);});
