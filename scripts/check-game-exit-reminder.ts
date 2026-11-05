/** 실제 SQLite/서비스/종료창/preload/DOM으로 프로필별 남은 숙제와 조회 무변경을 검증한다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import {createHash} from 'node:crypto';
import {app,BrowserWindow,ipcMain} from 'electron';
const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-exit-reminder-'));
const output=path.join(root,'output/game-exit-reminder');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fixture);app.on('window-all-closed',()=>{});
setTimeout(()=>{console.error('종료 리마인더 검사 시간 초과');app.exit(1);},60000).unref();
let verified=false;
app.on('before-quit',event=>{if(!verified){event.preventDefault();console.error('종료 리마인더 검증 완료 전 종료');app.exit(1);}});
const built=(name:string)=>require(path.join(root,'dist',name));
const pause=(ms=25)=>new Promise(resolve=>setTimeout(resolve,ms));
async function main():Promise<void> {
  await app.whenReady();
  const config=built('modules/config'),defaults=built('modules/constants').DEFAULT_CONFIG;
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/contents.json'),'utf8'));
  const now=Date.now(),done={isCompleted:true,currentCount:1,lastCompletedAt:now},old={...done,lastCompletedAt:now-14*86400000};
  const task=(id:string,type='daily',options:any={})=>({id,name:id,category:'리마인더',isCustom:true,isVisible:true,maxCount:1,
    resetRule:{type,hour:6,...(type==='weekly' ? {dayOfWeek:0} : {})},completedState:{A:{isCompleted:false},B:{...done},C:{...done}},...options});
  const tasks=[...catalog.map((item:any)=>({...item,isVisible:false})),task('일일 남은 숙제'),task('주간 남은 숙제','weekly'),
    task('부분 반복','weekly',{maxCount:3,completedState:{A:{isCompleted:false,currentCount:2,lastCompletedAt:now},B:{...done,currentCount:3},C:{...done,currentCount:3}}}),
    task('기한 만료','daily',{completedState:{A:{...old},B:{...old},C:{...done}}}),task('숨긴 숙제','daily',{isVisible:false}),
    task('제외한 숙제','daily',{completedState:{A:{isExcluded:true},B:{isExcluded:true},C:{isExcluded:true}}}),
    task('<img src=x onerror="window.injected=true">','daily',{category:'<b>사용자 분류</b>'}),
    ...Array.from({length:14},(_,index)=>task(`추가 숙제 ${index+1}`))];
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,analyticsEnabled:false,gameExitReminderEnabled:true,
    gameExitReminderMessage:'오늘도 수고하셨습니다!\n다른 프로필의 남은 숙제도 확인해 보세요.',contentsCheckerItems:tasks,
    characterPresets:[{id:'A',name:'사냥 프로필'},{id:'B',name:'사냥 프로필'},{id:'C',name:'완료한 프로필'}],selectedCharacterId:'A'}),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async()=>{throw new Error('offline fixture');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  const [a,b]=store.list().filter((profile:any)=>profile.name==='사냥 프로필');
  const c=store.list().find((profile:any)=>profile.name==='완료한 프로필');store.update(b.id,b.name,16);config.refreshFromPersistence();
  const deleted=store.create('삭제한 프로필',7);store.remove(deleted.id);
  const service=new (built('modules/profileService').ProfileService)(store,config),runtime={service,replay:()=>{}};
  built('modules/profileRuntime').setProfileRuntime(runtime);
  service.beginSession('exit-reminder-fixture');assert.equal((await service.select(b.id,()=>{})).success,true);service.endSession();
  store.setProfileOrder([c.id,a.id,b.id]);
  const collect=built('modules/gameExitReminderContents').collectProfileIncompleteContents;
  const snapshot=()=>Object.fromEntries((store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[])
    .map(row=>[row.name,createHash('sha256').update(JSON.stringify(store.database.prepare('SELECT * FROM "'+row.name.replace(/"/g,'""')+'" ORDER BY rowid').all())).digest('hex')]));
  const original=snapshot(),cfg=structuredClone(config.load()),status=structuredClone(service.status());
  const payload=collect(config.load(),runtime,now);
  assert.deepEqual(payload.profiles.map((profile:any)=>profile.profileId),[c.id,a.id,b.id],'종료 안내 탭도 지정한 순서를 사용');
  const group=(id:string)=>payload.profiles.find((profile:any)=>profile.profileId===id)!;
  // 같은 표시 이름을 가진 프로필도 원래 숙제 상태와 ID로 분리한다.
  const remaining=payload.profiles.find((profile:any)=>profile.items.length>2)!;
  const expiredOnly=payload.profiles.find((profile:any)=>profile.items.length===1)!;
  assert.ok(remaining);assert.ok(expiredOnly);assert.equal(payload.profiles.length,3);assert.equal(payload.activeProfileId,b.id);
  assert.equal(group(c.id).items.length,0);assert.ok(!group(deleted.id));
  assert.ok(remaining.items.some((item:any)=>item.name==='부분 반복'));assert.ok(remaining.items.some((item:any)=>item.name==='기한 만료'));
  assert.deepEqual(expiredOnly.items.map((item:any)=>item.name),['기한 만료']);
  assert.ok(remaining.items.every((item:any)=>!['숨긴 숙제','제외한 숙제'].includes(item.name)));
  assert.deepEqual(snapshot(),original);assert.deepEqual(config.load(),cfg);assert.deepEqual(service.status(),status);
  const maintenance=service.beginStorageMaintenance();assert.equal(collect(cfg,runtime,now).unavailable,true);maintenance.finish(()=>{});
  const row=store.database.prepare('SELECT definition FROM profile_homework WHERE profile_id=? LIMIT 1').get(a.id);
  const breakRead=store.database.transaction(()=>{
    store.database.prepare('UPDATE profile_homework SET definition=? WHERE profile_id=?').run('{',a.id);
    assert.equal(collect(cfg,runtime,now).unavailable,true);
    throw new Error('rollback fixture');
  });assert.throws(breakRead,/rollback fixture/);assert.ok(row);
  store.close();assert.equal(collect(cfg,runtime,now).unavailable,true);store.reopen();
  const legacy=collect({...cfg,characterPresets:[{id:'A',name:'같은 이름'},{id:'B',name:'같은 이름'}],contentsCheckerItems:[tasks[catalog.length]]},null,now);
  assert.deepEqual(legacy.profiles.map((profile:any)=>profile.items.length),[1,0],'구형 경로도 같은 이름의 다른 ID를 합치지 않음');
  ipcMain.on('get-default-config-sync',event=>{event.returnValue=defaults;});
  const errors:string[]=[];
  app.on('web-contents-created',(_event,contents)=>contents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);}));
  const wm=built('modules/windowManager');
  const beforeUi=snapshot();
  const reminder=()=>BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && win.webContents.getURL().endsWith('/game-exit-reminder.html'));
  let page:BrowserWindow;
  const js=(source:string):Promise<any>=>page.webContents.executeJavaScript(source);
  async function wait(expression:string):Promise<void> {
    const end=Date.now()+6000;while(Date.now()<end){if(await js(`Boolean(${expression})`))return;await pause();}
    throw new Error(`종료창 대기 실패: ${expression}`);
  }
  const click=(id:string)=>js(`Array.from(document.querySelectorAll('[role=tab]')).find(button=>button.dataset.profileId===${JSON.stringify(id)}).click()`);
  try {
    wm.showGameExitReminder();
    wm.showGameExitReminder();
    assert.equal(BrowserWindow.getAllWindows().filter(win=>!win.isDestroyed()).length,1,'로딩 중 반복 종료 감지에도 안내 창은 하나만 생성한다.');
    const end=Date.now()+6000;while(!reminder()?.isVisible()){assert.ok(Date.now()<end,'종료창 표시');await pause();}
    page=reminder()!;
    await wait("document.querySelectorAll('[role=tab]').length===3");
    assert.equal(await js("document.querySelector('[aria-selected=true]').dataset.profileId"),b.id);
    assert.equal(await js("document.getElementById('reminder-message').textContent"),cfg.gameExitReminderMessage);
    assert.equal(await js("document.getElementById('profile-summary').textContent.includes('네냐플')"),true);
    await click(remaining.profileId);assert.equal(await js("document.querySelectorAll('.task-card').length"),remaining.items.length);
    const firstWindowId=page.id;
    page.webContents.send('reminder-message','이전 안내');await wait("document.getElementById('reminder-message').textContent==='이전 안내'");
    page.minimize();wm.showGameExitReminder();
    await wait(`document.getElementById('reminder-message').textContent===${JSON.stringify(cfg.gameExitReminderMessage)}`);
    assert.equal(reminder()!.id,firstWindowId,'이미 열린 안내 창을 재사용한다.');
    assert.equal(page.isMinimized(),false,'재사용하는 최소화 안내 창은 복원한다.');
    assert.equal(BrowserWindow.getAllWindows().filter(win=>!win.isDestroyed()).length,1);
    assert.equal(await js("document.querySelector('[aria-selected=true]').dataset.profileId"),remaining.profileId,'다시 알릴 때 사용자가 보고 있던 프로필 탭을 유지한다.');
    assert.equal(await js("document.querySelectorAll('#incomplete-list img,#incomplete-list b').length"),0,'사용자 입력은 HTML로 실행하지 않음');
    assert.equal(await js('Boolean(window.injected)'),false);
    const periods=await js("Array.from(document.querySelectorAll('.task-card')).map(card=>card.dataset.period)");
    assert.ok(periods.indexOf('weekly')>periods.lastIndexOf('daily'),'일일 다음 주간 정렬');
    assert.ok(await js("document.getElementById('task-scroll').scrollHeight>document.getElementById('task-scroll').clientHeight"));
    await js("document.getElementById('task-scroll').scrollTop=80");const position=await js("document.getElementById('task-scroll').scrollTop");
    await click(c.id);assert.equal(await js("document.querySelectorAll('.task-card').length"),0);
    assert.equal(await js("document.getElementById('incomplete-empty').hidden"),false);
    await click(remaining.profileId);assert.equal(await js("document.getElementById('task-scroll').scrollTop"),position);
    const assertFits=async()=>assert.deepEqual(await js(`(()=>{const button=document.getElementById('confirm-reminder').getBoundingClientRect(),scroller=document.getElementById('task-scroll');return {button:button.bottom<=innerHeight && button.top>=0,width:document.body.scrollWidth<=innerWidth,tasks:scroller.clientHeight>=25};})()`),{button:true,width:true,tasks:true});
    await assertFits();
    await js("document.getElementById('task-scroll').scrollTop=0");
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    fs.writeFileSync(path.join(output,'profile-tabs.png'),(await page.webContents.capturePage()).toPNG());
    const many={...payload,profiles:[...payload.profiles,...Array.from({length:20},(_,index)=>({...remaining,profileId:`long-${index}`,profileName:'이름이 아주 긴 프로필 '.repeat(8)+index}))]};
    // 이전 선택이 사라진 새 알림의 기본 탭도 가로 스크롤 안쪽에서 보여야 한다.
    page.webContents.send('incomplete-contents',{profiles:[]});await wait("document.querySelectorAll('[role=tab]').length===0");
    page.webContents.send('incomplete-contents',{...many,activeProfileId:'long-19'});await wait("document.querySelectorAll('[role=tab]').length===23");
    assert.equal(await js("document.querySelector('[aria-selected=true]').dataset.profileId"),'long-19');
    assert.ok(await js("document.getElementById('profile-tabs').scrollLeft>0"),'마지막 사용 탭이 처음부터 보임');
    page.webContents.send('incomplete-contents',many);await wait("document.querySelectorAll('[role=tab]').length===23");
    await js("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
    assert.equal(await js("document.querySelector('[aria-selected=true]').dataset.profileId"),'long-19');
    assert.equal(await js("document.activeElement.id===document.querySelector('[aria-selected=true]').id"),true);
    assert.ok(await js("document.getElementById('profile-tabs').scrollLeft>0"));
    page.webContents.send('reminder-message','긴 안내 메시지입니다.\n'.repeat(50));await wait("document.getElementById('reminder-message').textContent.length>400");await assertFits();
    for(const key of ['Home','ArrowLeft','ArrowRight'])await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);
    assert.equal(await js("document.querySelector('[aria-selected=true]').dataset.profileId"),many.profiles[0].profileId);
    page.webContents.send('incomplete-contents',{profiles:[],unavailable:true});await wait("document.getElementById('incomplete-empty').textContent.includes('불러오지 못')");
    assert.equal(await js("document.querySelectorAll('.task-card,[role=tab]').length"),0,'실패 시 오래된 목록 제거');
    page.webContents.send('incomplete-contents',[]);await wait("document.getElementById('incomplete-empty').textContent.includes('표시할 프로필')");
    page.webContents.send('incomplete-contents',remaining.items);await wait("document.querySelectorAll('[role=tab]').length===1");
    page.webContents.send('incomplete-contents',{...payload,activeProfileId:'deleted-id'});await wait("document.querySelectorAll('[role=tab]').length===3");
    assert.equal(await js("document.querySelector('[aria-selected=true]').dataset.profileId"),payload.profiles[0].profileId);
    page.webContents.send('incomplete-contents',payload);await pause();assert.equal(await js("document.querySelectorAll('[role=tab]').length"),3);
    assert.deepEqual(snapshot(),beforeUi,'생성/탭 전환/여러 수신은 DB/이력을 쓰지 않음');assert.deepEqual(config.load(),cfg);assert.deepEqual(service.status(),status);
    await js("document.getElementById('confirm-reminder').click()");while(!page.isDestroyed())await pause();
    wm.showGameExitReminder();while(!reminder()?.isVisible())await pause();page=reminder()!;await wait("document.querySelectorAll('[role=tab]').length===3");
    const closed=new Promise<void>(resolve=>page.once('closed',()=>resolve()));page.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await closed;
    assert.equal(config.saveConfirmed({gameExitReminderEnabled:false}),true);wm.showGameExitReminder();assert.equal(reminder(),undefined);
    assert.equal(config.saveConfirmed({gameExitReminderEnabled:true,gameExitReminderMessage:'   '}),true);wm.showGameExitReminder();assert.equal(reminder(),undefined);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'behavior.json'),JSON.stringify({passed:true,profiles:3,readOnly:true,actualWindowManager:true,actualPreload:true,tabSwitch:true,resetExpired:true,hiddenExcluded:true,completedEmpty:true,duplicateNames:true,overflow23Tabs:true,unavailable:true,legacy:true,confirmEscape:true,errors},null,2));
    console.log('PASS game exit reminder: actual SQLite/service/windowManager/preload/DOM, profile tabs, reset/hidden/N/A/partial/empty/deleted, safe text, keyboard/overflow, readonly selection/DB, failure/restore and close gates.');
    verified=true;
  } finally {BrowserWindow.getAllWindows().forEach(win=>win.destroy());prepared.stopClock();store.close();built('modules/profileRuntime').setProfileRuntime(null);}
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
