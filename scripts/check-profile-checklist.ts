/** 실제 숙제 HTML/preload/IPC/공유 SQLite. 사용자 데이터 대신 임시 폴더만 사용한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {randomUUID} from 'node:crypto';
import {app,BrowserWindow,ipcMain,dialog} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-checklist-'));
const output=path.join(root,'output/profile-checklist');
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const pause=(ms=30) => new Promise(resolve => setTimeout(resolve,ms));
const js=(win:BrowserWindow,code:string):Promise<any> => win.webContents.executeJavaScript(code);
async function until(win:BrowserWindow,code:string):Promise<void> {
  for (let n=0;n<220;n++) {if (await js(win,`Boolean(${code})`)) return;await pause();}
  throw new Error(`Timed out: ${code}`);
}
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(output,{recursive:true});
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  const items=Array.from({length:24},(_,index) => ({id:`custom-fixture-${index}`,name:`확인 숙제 ${index}`,category:'확인',isCustom:true,isVisible:true,
    resetRule:index===1 ? {type:'weekly',dayOfWeek:0,hour:0} : {type:'daily',hour:0},...(index===1 ? {maxCount:3} : {}),completedState:{}}));
  const defaultsList=JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/contents.json'),'utf8')) as {id:string;resetRule:{type:string};isVisible?:boolean}[];
  const initialCount=items.length+defaultsList.length;
  const initialDailyCount=[...items,...defaultsList].filter(item=>item.resetRule.type==='daily' && item.isVisible!==false).length;
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,analyticsEnabled:false,volumeContentsChecker:0,
    characterPresets:[{id:'A',name:'사냥 <A>'},{id:'B',name:'다른 프로필 B'}],selectedCharacterId:'A',contentsCheckerItems:items}),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  const a=store.list().find((p:any) => p.name==='사냥 <A>'),b=store.list().find((p:any) => p.name==='다른 프로필 B');
  store.update(b.id,b.name,16);
  let cancelAfterPrepare=false;
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {},prepareTransition:async () => !cancelAfterPrepare});
  const {service,replay}=controller.runtime;service.beginSession('checklist-game');assert.equal((await service.select(a.id,replay)).success,true);
  let before:Promise<void> | undefined,release:()=>void=() => {},entered=0,loseAck=false;
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler) => register(channel,async (event,...args) => {
    if (channel==='profile-checklist-mutate') {entered++;if (before) await before;}
    const result=await handler(event,...args);
    if (channel==='profile-checklist-mutate' && loseAck && result.success) {loseAck=false;throw new Error('fixture lost acknowledgement');}
    return result;
  });
  built('modules/ipcHandlers').register();ipcMain.handle=register;
  let response=2,questions=0,managed=0;
  ipcMain.removeAllListeners('toggle-profiles');ipcMain.on('toggle-profiles',() => {managed++;});
  const originalMessage=dialog.showMessageBox;
  dialog.showMessageBox=(async (parent:any,options:any) => {
    assert.equal(await js(parent,'document.body.inert'),true);assert.deepEqual(options.buttons,['저장 후 전환','저장하지 않고 전환','취소']);
    questions++;return {response};
  }) as typeof dialog.showMessageBox;
  const win=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{preload:path.join(root,'dist/preload.js'),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  const windows=[win];
  try {
    await win.loadFile(path.join(root,'dist/contents-checker.html'));win.webContents.send('config-data',config.load());
    const ready=async (id:string) => until(win,`window.profileChecklist?.status().profileId===${JSON.stringify(id)} && !document.body.inert`);
    await ready(a.id);
    const state=() => js(win,'window.profileChecklist.status()');
    const form=async (name:string) => js(win,`if(!isEditMode)toggleEditMode();document.getElementById('new-item-name').value=${JSON.stringify(name)};document.getElementById('new-item-category').value='추가 확인'`);
    const name=() => js(win,`document.getElementById('new-item-name').value`);
    const rows=(id:string) => store.homework(id);
    const count=(id:string,item=items[0].id) => rows(id).find((row:any) => row.id===item).completedState[id]?.currentCount || 0;
    const direct=async (kind:string,args:unknown[],id=a.id,requestId=randomUUID(),createdAt=Date.now()) => js(win,`electronAPI.mutateProfileChecklist(${JSON.stringify({kind,args,profileId:id,requestId,createdAt})})`);
    assert.equal((await state()).dirty,false);assert.equal(await js(win,`document.querySelectorAll('.char-header').length`),1);
    assert.match(await js(win,`document.getElementById('checklist-profile-target').textContent`),/사냥 <A>.*하이아칸/);
    assert.equal(await js(win,`document.getElementById('btn-char-mgmt').title`),'프로필 관리');
    await js(win,`document.getElementById('btn-char-mgmt').click()`);await pause();assert.equal(managed,1);
    assert.equal(await js(win,`document.getElementById('char-modal').classList.contains('hidden')`),true);
    await js(win,`electronAPI.contentsAddCharacter('생성 금지');electronAPI.contentsRenameCharacter(${JSON.stringify(a.id)},'덮어쓰기 금지');electronAPI.contentsSelectCharacter(${JSON.stringify(b.id)});electronAPI.contentsAddCustom('레거시 저장 금지','확인',{type:'daily',hour:0})`);await pause(60);
    assert.equal(store.list().length,2);assert.equal(store.list()[0].name,a.name);assert.equal(rows(a.id).length,initialCount);
    assert.equal((await direct('toggleItem',[items[0].id,b.id])).success,false);
    assert.equal((await direct('updateItemCount',[items[1].id,a.id,10001])).success,false);
    assert.equal((await direct('addCustomItem',['잘못된 규칙','확인',{type:'weekly',dayOfWeek:7,hour:0}])).success,false);
    const unauthorized=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true}});windows.push(unauthorized);
    await unauthorized.loadFile(path.join(root,'dist/storage-bridge.html'));
    assert.equal((await js(unauthorized,`electronAPI.mutateProfileChecklist(${JSON.stringify({kind:'checkReset',args:[],profileId:a.id,requestId:randomUUID(),createdAt:Date.now()})})`)).success,false);unauthorized.destroy();

    // 일지 실패는 완료 상태/일 집계/ACK까지 rollback한다. 같은 요청으로 한 번만 재시도한다.
    store.database.exec("CREATE TRIGGER fail_manual_diary BEFORE INSERT ON homework_logs BEGIN SELECT RAISE(ABORT,'manual diary failure');END");
    const request={kind:'toggleItem',args:[items[0].id,a.id],profileId:a.id,requestId:randomUUID(),createdAt:Date.now()};
    assert.equal((await js(win,`electronAPI.mutateProfileChecklist(${JSON.stringify(request)})`)).success,false);
    assert.equal(count(a.id),0);assert.equal(store.pending().length,0);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM pending_profile_events WHERE event_id=?').get(request.requestId).n,0);
    store.database.exec('DROP TRIGGER fail_manual_diary');
    assert.equal((await js(win,`electronAPI.mutateProfileChecklist(${JSON.stringify(request)})`)).success,true);
    assert.equal((await js(win,`electronAPI.mutateProfileChecklist(${JSON.stringify(request)})`)).success,true);assert.equal(count(a.id),1);assert.equal(count(b.id),0);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM homework_logs WHERE profile_id=?').get(a.id).n,1);
    assert.equal((await js(win,`electronAPI.mutateProfileChecklist(${JSON.stringify({...request,kind:'checkReset',args:[]})})`)).success,false);
    assert.equal((await direct('toggleExcludeItem',[items[0].id,a.id])).success,true);
    assert.equal(rows(a.id)[0].completedState[a.id].isExcluded,true);assert.equal(count(a.id),0);
    assert.equal(store.database.prepare('SELECT daily_done,daily_total FROM diary_profile_days WHERE profile_id=?').get(a.id).daily_total,initialDailyCount-1);
    assert.equal((await direct('toggleExcludeItem',[items[0].id,a.id])).success,true);
    assert.equal((await direct('toggleVisibility',[items[3].id])).success,true);assert.equal(rows(b.id)[3].isVisible,true);
    assert.equal((await direct('reorderItem',[items[3].id,items[0].id,'before'])).success,true);assert.equal(rows(a.id)[0].id,items[3].id);assert.equal(rows(b.id)[0].id,items[0].id);

    config.saveConfirmed({volumeContentsChecker:30});win.webContents.send('config-data',config.load());await pause(50);
    await js(win,`window.checklistSounds=[];window.contentsAudioFeedback={...window.contentsAudioFeedback,play:(_cfg,sound)=>window.checklistSounds.push(sound)};void 0`);
    store.database.exec("CREATE TRIGGER fail_checklist_sound BEFORE INSERT ON homework_logs BEGIN SELECT RAISE(ABORT,'sound fixture');END");
    await js(win,`handleToggle('${items[2].id}',${JSON.stringify(a.id)},false,false)`);await until(win,'!profileChecklist.status().busy');
    assert.equal(await js(win,'window.checklistSounds.length'),0);assert.equal(count(a.id,items[2].id),0);
    store.database.exec('DROP TRIGGER fail_checklist_sound');
    await js(win,`handleToggle('${items[2].id}',${JSON.stringify(a.id)},false,false)`);await until(win,'!profileChecklist.status().busy && window.checklistSounds.length===1');
    assert.equal(count(a.id,items[2].id),1);config.saveConfirmed({volumeContentsChecker:0});win.webContents.send('config-data',config.load());

    // 폼 실패/취소/버리기 및 뒤이은 전환 실패 시 입력 보존.
    await form('A 편집 초안');response=2;const q=questions;
    assert.equal((await service.select(a.id,replay)).success,true);assert.equal(questions,q);
    assert.equal((await service.select(b.id,replay)).success,false);await ready(a.id);assert.equal(await name(),'A 편집 초안');
    response=1;cancelAfterPrepare=true;assert.equal((await service.select(b.id,replay)).success,false);await ready(a.id);assert.equal(await name(),'A 편집 초안');
    cancelAfterPrepare=false;assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);assert.equal(await name(),'');assert.equal(rows(a.id).length,initialCount);
    assert.match(await js(win,`document.getElementById('checklist-profile-target').textContent`),/네냐플/);
    assert.equal((await direct('checkReset',[],a.id)).success,false,'늦은 이전 프로필 요청 거부');
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);
    await form('실패 뒤 재시도');response=0;
    store.database.exec("CREATE TRIGGER fail_checklist_config BEFORE INSERT ON profile_homework BEGIN SELECT RAISE(ABORT,'manual checklist failure');END");
    assert.equal((await service.select(b.id,replay)).success,false);await ready(a.id);assert.equal(await name(),'실패 뒤 재시도');assert.equal(rows(a.id).length,initialCount);
    store.database.exec('DROP TRIGGER fail_checklist_config');
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    assert.equal(rows(a.id).filter((row:any) => row.name==='실패 뒤 재시도').length,1);assert.equal(rows(b.id).length,initialCount);

    // 저장 중 다음 입력을 보존하고, 완료를 확인하기 전에는 프로필을 바꾸지 않는다.
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);await form('원래 저장');
    before=new Promise(resolve => {release=resolve;});const writes=entered;
    await js(win,'window.saveInFlight=profileChecklist.submitEditor();void 0');
    for(let n=0;n<100 && entered===writes;n++)await pause();assert.ok(entered>writes);
    await js(win,`document.getElementById('new-item-name').value='다음 입력'`);
    let result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/저장 중/);await ready(a.id);
    release();before=undefined;assert.equal(await js(win,'window.saveInFlight'),true);assert.equal(await name(),'다음 입력');assert.equal((await state()).dirty,true);
    assert.equal(rows(a.id).filter((row:any) => row.name==='원래 저장').length,1);
    response=1;assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);
    assert.equal((await service.select(a.id,replay)).success,true);await ready(a.id);

    // 응답을 잃어도 다시 확인은 같은 ID를 재사용하여 추가/토글을 중복 실행하지 않는다.
    await form('응답 유실 확인');loseAck=true;
    assert.equal(await js(win,'profileChecklist.submitEditor()'),false);assert.equal((await state()).uncertain,true);
    result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/저장 결과/);await ready(a.id);
    await js(win,`document.getElementById('checklist-profile-retry').click()`);await until(win,'!profileChecklist.status().busy && !profileChecklist.status().uncertain');
    assert.equal(await name(),'');assert.equal(rows(a.id).filter((row:any) => row.name==='응답 유실 확인').length,1);
    await form('원래 응답 확인');loseAck=true;assert.equal(await js(win,'profileChecklist.submitEditor()'),false);
    await js(win,`document.getElementById('new-item-name').value='확인 중 새 초안';document.getElementById('checklist-profile-retry').click()`);
    await until(win,'!profileChecklist.status().busy && !profileChecklist.status().uncertain');
    assert.equal(await name(),'확인 중 새 초안');assert.equal(rows(a.id).filter((row:any) => row.name==='원래 응답 확인').length,1);
    assert.equal(rows(a.id).filter((row:any) => row.name==='확인 중 새 초안').length,0);await js(win,'resetForm()');

    // 주간 수정의 일요일(0)을 월요일(1)로 바꾸지 않고 실패 때 기존 편집값도 유지한다.
    await js(win,`startEditItem('${items[1].id}')`);assert.equal(await js(win,`document.getElementById('new-item-day').value`),'0');
    await js(win,`document.getElementById('new-item-name').value='일요일 유지'`);assert.equal(await js(win,'profileChecklist.submitEditor()'),true);
    assert.equal(rows(a.id).find((row:any) => row.id===items[1].id).resetRule.dayOfWeek,0);
    await js(win,`showCustomPrompt('횟수','2',()=>{})`);result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/횟수나 이름/);
    await js(win,`document.getElementById('prompt-cancel').click()`);

    // 기존 내부 재시도 경로도 A 기록을 B에 쓰지 않는다.
    store.database.exec("CREATE TRIGGER fail_retry_diary BEFORE INSERT ON homework_logs BEGIN SELECT RAISE(ABORT,'retry owner fixture');END");
    built('modules/contentsChecker').updateItemCount(items[1].id,a.id,3);
    assert.equal((await service.select(b.id,replay)).success,true);await ready(b.id);store.database.exec('DROP TRIGGER fail_retry_diary');
    // 전환/실제 기본 목록 처리 동안 첫 250ms 재시도가 실패하면 다음 예약은 1초 뒤다.
    // 고정 sleep 대신 원래 프로필에 기록이 확정되는 조건을 기다린다.
    for (let retry=0;retry<200 && store.database.prepare('SELECT COUNT(*) n FROM homework_logs WHERE profile_id=? AND content_id=?').get(a.id,`${items[1].id}_${a.id}`).n!==1;retry++)await pause();
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM homework_logs WHERE profile_id=? AND content_id=?').get(a.id,`${items[1].id}_${a.id}`).n,1);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM homework_logs WHERE profile_id=?').get(b.id).n,0);assert.equal(store.getRecordContext().profileId,b.id);
    assert.equal(store.pending().length,0);
    assert.equal(service.update(b.id,'변경된 프로필 <B>',16).success,true);await until(win,`document.getElementById('checklist-profile-target').textContent.includes('변경된 프로필 <B>')`);

    // 검색은 유지하며 새 항목이 검색 밖에 있으면 안내한다. 정상 추가는 해당 목록 위치로 이동.
    await js(win,`document.getElementById('search-input').value='표시 안 함';render()`);await form('검색 밖 추가');assert.equal(await js(win,'profileChecklist.submitEditor()'),true);
    assert.equal(await js(win,`document.getElementById('search-input').value`),'표시 안 함');assert.match(await js(win,`document.getElementById('custom-item-feedback').textContent`),/현재 검색 조건/);
    await js(win,`document.getElementById('search-input').value='';render()`);await form('스크롤 확인 마지막 숙제');assert.equal(await js(win,'profileChecklist.submitEditor()'),true);
    await pause(600);assert.ok(await js(win,`document.querySelector('.matrix-wrapper').scrollTop>0`));
    fs.writeFileSync(path.join(output,'checklist-1100.png'),(await win.webContents.capturePage()).toPNG());
    const lastId=rows(b.id).find((row:any) => row.name==='스크롤 확인 마지막 숙제').id;
    win.setSize(800,600);await pause(180);await js(win,`revealProfileChecklistItem(${JSON.stringify(lastId)})`);await pause(650);fs.writeFileSync(path.join(output,'checklist-800.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js(win,`(()=>{const row=Array.from(document.querySelectorAll('[data-item-id]')).find(node=>node.dataset.itemId===${JSON.stringify(lastId)});const r=row.getBoundingClientRect();return document.elementFromPoint(r.left+10,r.top+r.height/2)?.closest('[data-item-id]')?.dataset.itemId===${JSON.stringify(lastId)}})()`),true,'작은 창에서도 추가 행이 고정 헤더/폼에 가리지 않는다');
    assert.equal(await js(win,`(()=>{const r=document.getElementById('checklist-profile-target').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && getComputedStyle(document.getElementById('checklist-profile-target')).fontSize==='14px'})()`),true);
    assert.equal(await js(win,`document.getElementById('pending-modal').classList.contains('hidden')`),true);
    // 임의 숙제 fixture만으로 통과시키지 않는다. 실제 새 프로필의 배포 기본 목록을 화면까지 확인한다.
    const seeded=service.create('신규 기본 목록',16);assert.equal(seeded.success,true,seeded.error);
    assert.equal((await service.select(seeded.profileId,replay)).success,true);await ready(seeded.profileId);
    const displayed=await js(win,`(()=>{document.getElementById('search-input').value='';if(isEditMode)toggleEditMode();render();document.querySelector('.matrix-wrapper').scrollTop=0;return Array.from(document.querySelectorAll('[data-item-id]')).map(row=>row.dataset.itemId)})()`);
    assert.deepEqual(displayed.sort(),defaultsList.filter(item=>item.isVisible!==false).map(item=>item.id).sort(),'새 프로필의 실제 숙제 화면에 기본 목록 전체가 표시되어야 합니다.');
    await until(win,`!isEditMode && getComputedStyle(document.getElementById('add-form')).display==='none' && document.querySelector('.matrix-wrapper').scrollTop===0`);
    await js(win,`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);await pause(100);
    fs.writeFileSync(path.join(output,'checklist-defaults-800.png'),(await win.webContents.capturePage()).toPNG());
    console.log('Profile checklist: actual profile UI, atomic checklist/diary/ACK, failures/retries, pending edits, Save/Discard/Cancel, frozen owner, legacy guards, Sunday, search/scroll and minimum-size UI passed.');
  } finally {
    dialog.showMessageBox=originalMessage;release();built('modules/contentsChecker').cancelPendingDiaryWriteRetries();
    for(const item of windows)if(!item.isDestroyed())item.destroy();controller.dispose();prepared.stopClock();config.flushPending();
  }
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
