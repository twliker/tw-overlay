import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {app} from 'electron';

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-stress-'));
app.setPath('userData',fixture);
app.on('window-all-closed',()=>{}); // The startup storage bridge closes before the benchmark starts.
const built=(name:string)=>require(path.resolve(__dirname,'../dist/modules',name+'.js'));

/** Run the real watched file and SQLite with increasing numbers of inactive profiles. */
async function run():Promise<void> {
  const config=built('config'),diary=built('diaryDb');
  const processor=built('chatLogProcessor').chatLogProcessor;
  const live=built('chatLogManager').chatLogManager;
  const contents=built('contentsChecker');
  const {collectRecordEffects}=built('recordEffects');
  const directory=path.join(fixture,'chat');
  fs.mkdirSync(directory);
  assert.equal(config.saveConfirmed({chatLogPath:directory,userServer:7,analyticsEnabled:false}),true);
  const clock=new (built('profileClock').ProfileClock)(async()=>{throw new Error('offline fixture');});
  const prepared=await built('profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  processor.start();
  const controller=built('profileRecording').installProfileRecording(store,{openSelection:()=>{}});
  const {service,replay}=controller.runtime;
  try {
    await controller.runtime.onGameState('running');
    const id=store.list()[0].id;
    assert.equal(service.update(id,'부하 검사용',7).success,true);
    const selection=await service.select(id,replay);
    assert.equal(selection.success,true,selection.error);
    const file=live.getTodayFilePath();
    assert.ok(file);
    fs.writeFileSync(file,'\ufeff');
    live.start(false);
    const count=store.database.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE type='calc' AND profile_id=? AND amount BETWEEN ? AND ?");
    const logLine=(message:string)=>{
      const d=new Date();
      const time=`${d.getHours()}시 ${d.getMinutes()}분 ${d.getSeconds()}초`;
      return `<font color="white">[${time}]</font><font color="#ff64ff">${message}</font></br>\r\n`;
    };
    for (const profileCount of [1,5,20,50]) {
      while (store.list().length<profileCount) store.create(`부하 검사용 ${store.list().length}`,7,id);
      const lag=monitorEventLoopDelay({resolution:10});
      const firstAmount=profileCount*10000;
      const rows=120;
      const wal=path.join(fixture,'app-data.db-wal');
      store.database.pragma('wal_checkpoint(TRUNCATE)');
      lag.enable();
      const start=performance.now();
      try {
        for (let offset=0;offset<rows;offset+=12) {
          const batch=Array.from({length:12},(_,i)=>{
            const amount=firstAmount+offset+i;
            return logLine(`콘텐츠 클리어 보상으로 ${amount} SEED를 획득했습니다.`)
              +logLine('체력이 [159994] 회복되었습니다.');
          }).join('');
          fs.appendFileSync(file,batch);
          const homework=config.load().contentsCheckerItems?.find((item:{isVisible?:boolean})=>item.isVisible!==false);
          if (homework) store.database.transaction(()=>collectRecordEffects(()=>config.withConfirmedWrites(()=>
            store.withRecordContext(id,service.currentSessionId,()=>contents.toggleItem(homework.id,id))),true))()();
          await delay(25);
        }
        const recorded=()=>count.get(id,firstAmount,firstAmount+rows-1).n;
        const deadline=start+10_000;
        while (recorded()<rows && performance.now()<deadline) await delay(25);
        assert.equal(recorded(),rows,'모든 로그가 같은 프로필에 한 번씩 반영된다.');
        assert.equal(store.pending().length,0,'기록 대기열이 남지 않는다.');
        console.log(JSON.stringify({profiles:profileCount,seedEvents:rows,elapsedMs:Math.round(performance.now()-start),
          eventLoopP95Ms:Number((lag.percentile(95)/1e6).toFixed(2)),walBytes:fs.existsSync(wal) ? fs.statSync(wal).size : 0}));
      } finally {lag.disable();}
    }
  } finally {
    live.stop();
    controller.dispose();
    prepared.stopClock();
    // Let the committed checklist refresh finish before closing its settings store.
    await delay(0);
    assert.equal(config.flushPending(),true);
    assert.equal(diary.closeDb(),true);
  }
}

app.whenReady().then(run).then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
