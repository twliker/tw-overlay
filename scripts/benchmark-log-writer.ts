/** benchmark-runtime-resources.ts가 띄우는 채팅 로그 작성 프로세스.
 * 앱 프로세스의 디스크 쓰기 횟수에 로그 작성이 섞이지 않도록 별도 프로세스에서 게임처럼 EUC-KR 로그를 덧붙인다.
 * 100ms마다 rate/10줄을 쓰고, 2초마다 그 묶음의 마지막 줄로 기믹 알림 줄을 넣어 쓴 시각을 부모에게 보낸다.
 * 사용: fork(benchmark-log-writer.js, [file, rate, durationMs, 'batch' | 'spread']) */
import fs = require('node:fs');
import iconv = require('iconv-lite');

const [file,rateText,durationText]=process.argv.slice(2);
const rate=Number(rateText),duration=Number(durationText);
const TICK_MS=100,ALERT_EVERY_TICKS=20;

function line(color:string,message:string):string {
  const d=new Date();
  const time=`${String(d.getHours()).padStart(2,'0')}시 ${String(d.getMinutes()).padStart(2,'0')}분 ${String(d.getSeconds()).padStart(2,'0')}초`;
  return `<font size="2" color="white"> [ ${time}] </font> <font size="2" color="${color}">${message}</font></br>\r\n`;
}

/** 사냥 중 채팅 로그 비율: 경험치 40%, 득템 10%, SEED 10%, 회복 15%, 채팅·외치기·버프 25%. */
function huntingLine(index:number):string {
  switch (index%20) {
    case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
      return line('#ff64ff',`경험치가 ${(1_250_000+index*37).toLocaleString('en-US')} 올랐습니다.`);
    case 8: case 9: return line('#ff64ff','[하급 마력석] 아이템을 획득하였습니다.');
    case 10: case 11: return line('#ff64ff',`펫이 [${(15_000+index%1000).toLocaleString('en-US')}] SEED를 주웠습니다.`);
    case 12: case 13: case 14: return line('#ff64ff','체력이 [159994] 회복되었습니다.');
    case 15: case 16: return line('#94ddfa',`열혈사냥꾼 : 몬스터 리젠 빠르네요 ${index}`);
    case 17: return line('#c896c8',`외치기 : [사냥 파티 구합니다] 유저_${index%10}`);
    case 18: return line('#ff64ff','[머큐리얼 케이브 코어] 진화 4단계-6세트 효과가 발동되었습니다.');
    default: return line('#c8ffc8',`나 : 잡담 ${index}`);
  }
}

let index=0,tick=0,alerts=0;
const start=Date.now();
if (process.argv[6]==='tw') startTalesWeaverHunting();
else if (process.argv[5]==='spread') {
  // 게임이 줄마다 따로 쓰는 최악의 경우: 한 줄씩 덧붙이고 2초마다 기믹 줄을 넣는다.
  const everyMs=1000/rate,alertEvery=Math.max(1,Math.round(rate*2));
  let next=start;
  const writeOne=()=>{
    const alert=++tick%alertEvery===0;
    const text=alert ? line('#ff64ff',`맵 어딘가에 특별 몬스터가 출현하였습니다. #${++alerts}`) : huntingLine(index++);
    fs.appendFileSync(file,iconv.encode(text,'euc-kr'));
    if (alert) process.send?.({type:'alert',seq:alerts,writtenAt:Date.now()});
    if (Date.now()-start>=duration) {
      process.send?.({type:'done',lines:index,alerts});
      setTimeout(()=>process.exit(0),50);
      return;
    }
    next+=everyMs;
    setTimeout(writeOne,Math.max(0,next-Date.now()));
  };
  writeOne();
} else startBatches();

/** 실제 테일즈위버 사냥(--mix tw): 사냥 중에는 득템·SEED 줄이 없고 처치마다 경험치 줄만 남는다.
 * 경험의 정수 교환(100억 감소 한 줄)이 30초마다, 기믹 알림 줄은 지연 측정용으로 60초마다 들어간다.
 * 게임처럼 줄마다 따로 덧붙인다(rate는 초당 줄 수, 실제 사냥 평균은 약 2.3). */
function startTalesWeaverHunting():void {
  const everyMs=1000/rate,ESSENCE_MS=30_000,ALERT_MS=60_000;
  let next=start,nextEssence=start+ESSENCE_MS,nextAlert=start+ALERT_MS;
  const writeOne=()=>{
    const now=Date.now();
    let text=line('#ff64ff',`경험치가 ${(1_250_000+index*37).toLocaleString('en-US')} 올랐습니다.`);
    let alert=false;
    if (now>=nextEssence) {nextEssence+=ESSENCE_MS;text=line('#ff64ff','경험치가 10000000000 감소했습니다.');}
    else if (now>=nextAlert) {nextAlert+=ALERT_MS;alert=true;text=line('#ff64ff',`맵 어딘가에 특별 몬스터가 출현하였습니다. #${++alerts}`);}
    if (!alert) index++;
    fs.appendFileSync(file,iconv.encode(text,'euc-kr'));
    if (alert) process.send?.({type:'alert',seq:alerts,writtenAt:Date.now()});
    if (Date.now()-start>=duration) {
      process.send?.({type:'done',lines:index,alerts});
      setTimeout(()=>process.exit(0),50);
      return;
    }
    next+=everyMs;
    setTimeout(writeOne,Math.max(0,next-Date.now()));
  };
  writeOne();
}

function startBatches():void {
const perTick=Math.max(1,Math.round(rate*TICK_MS/1000));
const timer=setInterval(()=>{
  const lines:string[]=[];
  for (let i=0;i<perTick;i++) lines.push(huntingLine(index++));
  const alert=++tick%ALERT_EVERY_TICKS===0;
  if (alert) lines.push(line('#ff64ff',`맵 어딘가에 특별 몬스터가 출현하였습니다. #${++alerts}`));
  fs.appendFileSync(file,iconv.encode(lines.join(''),'euc-kr'));
  if (alert) process.send?.({type:'alert',seq:alerts,writtenAt:Date.now()});
  if (Date.now()-start>=duration) {
    clearInterval(timer);
    process.send?.({type:'done',lines:index,alerts});
    setTimeout(()=>process.exit(0),50);
  }
},TICK_MS);
}
