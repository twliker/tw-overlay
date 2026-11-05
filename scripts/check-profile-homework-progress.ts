/** 실제 SQLite 프로필 목록 현황: 현재 주기·숨김/N/A·반복 숙제·조회 무변경을 검사한다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {app} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-progress-'));
app.setPath('userData',fixture);app.on('window-all-closed',()=>{});
const built=(name:string)=>require(path.join(root,'dist',name));
async function main():Promise<void> {
  await app.whenReady();
  const defaults=structuredClone(built('modules/constants').DEFAULT_CONFIG),catalog=JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/contents.json'),'utf8'));
  defaults.contentsCheckerItems=catalog;
  const before=new Date(2026,10,8,5,59,59).getTime(),after=before+1000;
  const state={isCompleted:true,currentCount:1,lastCompletedAt:before};
  const task=(id:string,type:string,options:any={})=>({id,name:id,category:'진행 현황',isVisible:true,isCustom:true,maxCount:1,
    resetRule:{type,hour:6,...(type==='weekly' ? {dayOfWeek:0} : {})},completedState:{A:{...state},B:{...state,isExcluded:true},C:{...state,lastCompletedAt:before-14*86400000}},...options});
  const items=[...catalog.map((item:any)=>({...item,isVisible:false})),task('daily-done','daily'),
    task('daily-partial','daily',{maxCount:3,completedState:{A:{isCompleted:false,currentCount:2,lastCompletedAt:before},B:{isCompleted:false,isExcluded:true},C:{isCompleted:false}}}),
    task('daily-hidden','daily',{isVisible:false}),task('daily-na','daily',{completedState:{A:{...state,isExcluded:true},B:{...state,isExcluded:true},C:{...state,isExcluded:true}}}),
    task('weekly-sunday','weekly'),task('weekly-monday','weekly',{resetRule:{type:'weekly',dayOfWeek:1,hour:6}}),
    task('weekly-partial','weekly',{maxCount:7,completedState:{A:{isCompleted:false,currentCount:2,lastCompletedAt:before},B:{isCompleted:false,isExcluded:true},C:{isCompleted:false}}})];
  const legacy={...structuredClone(defaults),userServer:7,characterPresets:[{id:'A',name:'현재 프로필'},{id:'B',name:'모두 N/A'},{id:'C',name:'비활성 만료'}],selectedCharacterId:'A',contentsCheckerItems:items};
  fs.writeFileSync(path.join(fixture,'config.json'),JSON.stringify(legacy));
  const store=await built('modules/applicationData').ApplicationData.initialize({directory:fixture,deviceId:'progress-fixture',defaults},legacy,{value:7});
  try {
    const profiles=store.list(),a=profiles.find((p:any)=>p.name==='현재 프로필'),b=profiles.find((p:any)=>p.name==='모두 N/A'),c=profiles.find((p:any)=>p.name==='비활성 만료');
    const read=built('modules/profileHomeworkProgress').readProfileHomeworkProgress;
    const snapshot=()=>JSON.stringify((store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[])
      .map(row=>[row.name,store.database.prepare('SELECT * FROM "'+row.name.replace(/"/g,'""')+'" ORDER BY rowid').all()]));
    const original=snapshot(),early=read(store,profiles,before),late=read(store,profiles,after);
    assert.deepEqual(early.profiles[a.id],{daily:{done:1,total:2},weekly:{done:2,total:3}},'부분 횟수는 완료한 항목 수에 포함하지 않음');
    assert.deepEqual(late.profiles[a.id],{daily:{done:0,total:2},weekly:{done:1,total:3}},'일요일 06시 경계에서 일일/일요일 주간만 만료');
    assert.equal(early.nextResetAt,after);assert.ok(late.nextResetAt>after);
    for(const result of [early,late]) {
      assert.deepEqual(result.profiles[b.id],{daily:{done:0,total:0},weekly:{done:0,total:0}});
      assert.deepEqual(result.profiles[c.id],{daily:{done:0,total:2},weekly:{done:0,total:3}},'비활성 프로필도 만료된 완료를 표시하지 않음');
    }
    assert.equal(snapshot(),original,'조회는 원본/선택/일지/모든 변경 이력과 전송 대기를 수정하지 않음');
    store.remove(c.id);assert.equal(read(store,store.list(),after).profiles[c.id],undefined,'삭제 프로필 제외');
    console.log('PASS profile homework progress: actual catalog/SQLite, per-profile daily/weekly, Sunday/hour boundary, hidden/N/A/partial/empty/deleted and read-only source/journal.');
  } finally {store.close();}
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
