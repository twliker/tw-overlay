/** 합성 데이터의 실제 직렬화/압축/저장 비용. Google 네트워크 p95/프로젝트 quota 실측과 구분한다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {app} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-sync-budget-'));app.setPath('userData',fixture);
const built=(p:string)=>require(path.join(root,'dist',p));
async function run():Promise<void> {
  await app.whenReady();const defaults=structuredClone(built('modules/constants').DEFAULT_CONFIG),{ApplicationData}=built('modules/applicationData');
  defaults.contentsCheckerItems=JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/contents.json'),'utf8')).map((item:any)=>({...item,completedState:{}}));
  const {ProfileSyncModel,validateProfileSyncEnvelope}=built('modules/profileSyncModel');const rows:any[]=[];
  for(const profiles of [1,5,20,50]) {
    const directory=path.join(fixture,`profiles-${profiles}`);fs.mkdirSync(directory);
    const legacy={...structuredClone(defaults),characterPresets:Array.from({length:profiles},(_,i)=>({id:`old-${i}`,name:`프로필 ${i+1}`})),selectedCharacterId:'old-0'};
    for(const item of legacy.contentsCheckerItems) item.completedState=Object.fromEntries(legacy.characterPresets.map((p:any,i:number)=>[p.id,{currentCount:Math.min(i%4,item.maxCount || 1),isCompleted:i%4>=(item.maxCount || 1),lastCompletedAt:Date.now(),isExcluded:i%5===0}]));
    fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({...legacy,userServer:7}));
    const store=await ApplicationData.initialize({directory,deviceId:`BUDGET-${profiles}`,defaults},legacy,{value:7});
    try {
      const model=new ProfileSyncModel(store.database,`BUDGET-${profiles}`,()=>({utcMs:Date.now(),source:'unverified',uncertaintyMs:null}));
      const timings:number[]=[],id=store.list()[0].id;
      for(let i=0;i<20;i++) {
        const cfg=store.project(id,defaults);cfg.pinnedNoteText=`저장 ${i}`;const start=performance.now();store.saveProjection(id,cfg);timings.push(performance.now()-start);
      }
      const envelope=model.envelope();validateProfileSyncEnvelope(envelope);const json=JSON.stringify(envelope),compressed=gzipSync(json);timings.sort((a,b)=>a-b);
      rows.push({profiles,homeworkPerProfile:store.homework(id).length,cells:Object.keys(envelope.cells).length,jsonBytes:Buffer.byteLength(json),gzipBytes:compressed.length,
        savingPercent:Number(((1-compressed.length/Buffer.byteLength(json))*100).toFixed(1)),saveMedianMs:Number(timings[10].toFixed(2)),saveP95Ms:Number(timings[18].toFixed(2))});
      assert.ok(compressed.length<Buffer.byteLength(json));
      // 이벤트별 무한 이력 대신 필드별 최신 값으로 압축되는지 1,000회 수정을 한 profile에서 확인.
      if(profiles===1) {
        const before=Object.keys(envelope.cells).length;
        for(let i=0;i<1000;i++){const cfg=store.project(id,defaults);cfg.pinnedNoteText=`반복 ${i}`;store.saveProjection(id,cfg);}
        assert.equal(Object.keys(model.envelope().cells).length,before);
        const boundary=model.legacyBoundary();model.acknowledge(model.envelope().sequence,boundary);assert.equal(model.legacyBoundary(),0,'전송 확정된 구형 상세 journal 정리');
        assert.ok(model.envelope().sequence>1000,'상세 journal 정리 뒤에도 순번/최종 값/중복 기준 보존');
      }
    } finally {store.close();}
  }
  const budget=[100,1000,10000].map(pcs=>({pcs,activeChecksPerMinute:pcs*2,activeUnitsPerMinute:pcs*2*100,
    idleUnitsPerMinute:pcs/5*100,withOneWriteAndReadPerMinute:pcs*(2*100+50+5+200),
    // 한 번 변경마다 작성 PC 한 개 + 수신 PC 한 개 가정. 실제 수신 PC 수/게임 시간은 별도 측정.
    example8HourDownloadMiB:Math.round(pcs*480*rows[1].gzipBytes/1024/1024)}));
  const report={status:'passed',measuredAt:new Date().toISOString(),kind:'synthetic-local-cost-and-quota-model',rows,budget,
    publishedQuotaUnitsPerMinute:1_000_000,actualProjectQuotaVerified:false,realNetworkLatencyMeasured:false};
  const output=path.join(root,'output/profile-sync-budget');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify(report,null,2));
  console.log('PASS profile sync size/retention budget: '+JSON.stringify(rows));
}
run().then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
