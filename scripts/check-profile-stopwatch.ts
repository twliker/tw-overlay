/** 실제 관리 창/HUD/preload/IPC/공유 SQLite. 임시 userData만 사용한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow,ipcMain} from 'electron';

const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-stopwatch-'));
const output=path.join(root,'output/profile-stopwatch');
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const pause=(ms=30) => new Promise(resolve => setTimeout(resolve,ms));
const js=(win:BrowserWindow,code:string):Promise<any> => win.webContents.executeJavaScript(code);
async function until(win:BrowserWindow,code:string):Promise<void> {
  for (let n=0;n<200;n++) {if (await js(win,`Boolean(${code})`)) return;await pause();}
  throw new Error(`Timed out: ${code}`);
}
async function page(name:string,native=false):Promise<BrowserWindow> {
  const win=new BrowserWindow({show:native,frame:false,width:1000,height:800,webPreferences:{preload:path.join(root,'dist/preload.js'),sandbox:true,contextIsolation:true,offscreen:!native,backgroundThrottling:false}});
  await win.loadFile(path.join(root,'dist',name));return win;
}
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(output,{recursive:true});
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  const timer=built('modules/stopwatchSession'),key='tw-coefficient-calculator-profiles-v1';
  const data=(value:string) => ({currentType:'stab',mainCore:'none',stats:{stab:value,hack:'20',dex:'30'},buffPreset:'same-preset'});
  const legacy=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  await legacy.loadFile(path.join(root,'dist/storage-bridge.html'));
  // Migration copies these actual values, but unassigned old records continue to use this source.
  await js(legacy,`localStorage.setItem('buff_presets',JSON.stringify([{id:'same-preset',buffIds:['stat_izabel_fixed']}]));localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify({only:{data:data('75')}}))})`);
  diary.initDb();
  const old=built('modules/stopwatchCalculation').captureStopwatchSnapshot({[key]:JSON.stringify({only:{data:data('75')}})});
  const raw=JSON.stringify(data('75'));
  diary.addTimerRecord({...old,date:'2026-10-01',title:'이전 미배정 기록',duration:1000,raw_profile_data:raw});
  assert.equal(config.saveConfirmed({...structuredClone(defaults),analyticsEnabled:false,userServer:7,characterPresets:[{id:'A',name:'사냥 <A>'},{id:'B',name:'다른 프로필 B'}],selectedCharacterId:'A'}),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  const a=store.list().find((p:any) => p.name==='사냥 <A>'),b=store.list().find((p:any) => p.name==='다른 프로필 B');
  store.update(b.id,b.name,16);
  const values=(id:string,value:string,buffIds:string[]) => {
    store.saveToolValue(id,key,JSON.stringify({only:{id:'only',name:'사냥 계산',data:data(value)}}));
    store.saveToolValue(id,key+'_last','missing-preset'); // Calculator falls back to its first saved entry.
    store.saveToolValue(id,'buff_presets',JSON.stringify([{id:'same-preset',buffIds}]));
  };
  values(a.id,'100',['stat_izabel_fixed']);values(b.id,'800',[]);
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {}});
  const {service,replay}=controller.runtime;service.beginSession('stopwatch-game');
  let deferred:Promise<void> | null=null,release=() => {},delayed=0;
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler) => register(channel,async (event,...args) => {
    const result=await handler(event,...args);
    if (channel==='timer-get-records' && deferred) {const wait=deferred;deferred=null;delayed++;await wait;}
    return result;
  });
  built('modules/ipcHandlers').register();ipcMain.handle=register;
  let requestedProfiles=0;
  ipcMain.removeAllListeners('toggle-profiles');ipcMain.on('toggle-profiles',() => requestedProfiles++);
  const hud=await page('game-overlay.html'),win=await page('stopwatch.html',true),unauthorized=await page('storage-bridge.html');
  const windows=[hud,win,legacy,unauthorized];
  const ready=async (id:string) => until(win,`stopwatchContext?.profileId===${JSON.stringify(id)} && !stopwatchContext.busy`);
  const choose=async (id:string) => {assert.equal((await service.select(id,replay)).success,true);await ready(id);};
  const filter=async (value:string) => {await js(win,`(()=>{const filter=document.getElementById('stopwatch-record-filter');filter.value=${JSON.stringify(value)};filter.dispatchEvent(new Event('change'));})()`);};
  const rows=(id?:string) => diary.getTimerRecords(id ? {kind:'profile',profileId:id} : {kind:'all'});
  const mutate=(change:unknown) => js(win,`electronAPI.timerMutateRecord(${JSON.stringify(change)})`);
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/buffs.json'),'utf8')),buff=catalog.find((v:any) => v.id==='stat_izabel_fixed').effects.stat;
  try {
    await until(win,`stopwatchContext?.selectionRequired && document.getElementById('btn-toggle-timer').disabled`);
    assert.equal(await js(win,`recordFilter`),'all');
    await assert.rejects(timer.controlStopwatch('start'),/선택/);
    await js(win,`document.getElementById('btn-select-profile').click()`);await pause();assert.equal(requestedProfiles,1);
    await choose(a.id);assert.equal(await js(win,'recordFilter'),'current');
    await js(win,`document.getElementById('btn-toggle-timer').click()`);
    await until(win,`timerIsRunningLocal && !document.getElementById('btn-toggle-timer').disabled`);
    const startA=timer.getStopwatchState().startedAt,startSession=service.status().sessionId;
    await until(hud,`timerIsRunning && timerStartTime===${startA}`);
    assert.equal(await js(hud,`document.getElementById('timer-hud-profile').textContent`),a.name);
    await until(hud,`Number(getComputedStyle(document.getElementById('timer-hud')).opacity)>.99`);await pause(50);
    const timerBounds=await js(hud,`(()=>{const r=document.getElementById('timer-hud').getBoundingClientRect();return {x:Math.floor(r.left-20),y:Math.floor(r.top-20),width:Math.ceil(r.width+40),height:Math.ceil(r.height+40)};})()`);
    fs.writeFileSync(path.join(output,'stopwatch-hud.png'),(await hud.webContents.capturePage(timerBounds)).toPNG());
    values(a.id,'9999',[]);
    await choose(b.id);assert.equal(timer.getStopwatchState().running,false);
    await until(hud,`!timerIsRunning && document.getElementById('timer-hud').classList.contains('hidden')`);
    await assert.rejects(js(win,`electronAPI.timerToggleSession('start',${JSON.stringify(a.id)})`),/프로필/);
    await assert.rejects(js(win,`electronAPI.timerToggleSession('start')`),/프로필/);
    assert.equal((await service.remove(a.id)).success,false,'inactive running owner cannot be deleted');
    await timer.controlStopwatch('start');const startB=timer.getStopwatchState().startedAt;
    await choose(a.id);assert.equal(timer.getStopwatchState().startedAt,startA);
    await until(hud,`timerIsRunning && timerStartTime===${startA}`);
    await timer.controlStopwatch('stop');await timer.controlStopwatch('stop');
    assert.equal(rows(a.id).length,1);const first=rows(a.id)[0];
    assert.equal(first.char_main,100+buff);assert.equal(first.record_session_id,startSession);
    assert.equal(JSON.parse(first.raw_profile_data).stopwatchPlayProfileId,a.id);
    await choose(b.id);assert.equal(timer.getStopwatchState().startedAt,startB);
    store.database.exec("CREATE TRIGGER fail_stopwatch BEFORE INSERT ON timer_records BEGIN SELECT RAISE(ABORT,'fixture disk full');END");
    await until(win,`timerIsRunningLocal && !document.getElementById('btn-toggle-timer').disabled`);
    await js(win,`document.getElementById('btn-toggle-timer').click()`);
    await until(win,`timerIsRunningLocal && !controlPending && !document.getElementById('stopwatch-error').classList.contains('hidden')`);
    assert.equal(timer.getStopwatchState().running,true);assert.equal(rows(b.id).length,0);
    store.database.exec('DROP TRIGGER fail_stopwatch');await js(win,`document.getElementById('btn-toggle-timer').click()`);
    await until(win,`!timerIsRunningLocal && !controlPending`);assert.equal(rows(b.id).length,1);assert.equal(rows(b.id)[0].char_main,800);
    // A record recalculates with captured effects while B is playing and both preset IDs match.
    assert.equal((await mutate({kind:'recalculate',id:first.id,series:'hack',core:null})).success,true);
    assert.equal(diary.getTimerRecord(first.id).char_main,20+buff);
    const before=diary.getTimerRecord(first.id).title;
    await js(win,`electronAPI.timerUpdateTitle(${first.id},'legacy blocked');electronAPI.timerDeleteRecord(${first.id})`);await pause();assert.equal(diary.getTimerRecord(first.id).title,before);
    assert.equal((await mutate({kind:'recalculate',id:first.id,series:'invalid',core:null})).success,false);
    assert.equal((await js(unauthorized,`electronAPI.timerMutateRecord({kind:'delete',id:${first.id}})`)).success,false);
    // Old owned records use A's saved presets; old NULL records use the preserved legacy browser store.
    values(a.id,'123',['stat_izabel_fixed']);
    store.withRecordContext(a.id,null,() => diary.addTimerRecord({...old,date:'2026-10-02',duration:2000,raw_profile_data:raw}));
    const oldOwned=rows(a.id).find((record:any) => record.duration===2000);
    const unassigned=rows().find((record:any) => !record.profile_id);
    assert.equal((await mutate({kind:'recalculate',id:oldOwned.id,series:'hack',core:null})).success,true);
    assert.equal(diary.getTimerRecord(oldOwned.id).char_main,20+buff);
    assert.equal((await mutate({kind:'recalculate',id:unassigned.id,series:'hack',core:null})).success,true);
    assert.equal(diary.getTimerRecord(unassigned.id).char_main,20+buff);
    // Default/current follows playing profile; all and explicit owner remain stable.
    await filter('current');await until(win,`document.getElementById('record-count').innerText==='총 1건'`);
    await choose(a.id);await until(win,`document.getElementById('record-count').innerText==='총 2건'`);
    await filter('all');await until(win,`document.getElementById('record-count').innerText==='총 4건'`);
    await choose(b.id);assert.equal(await js(win,'recordFilter'),'all');
    await filter('unassigned');await until(win,`document.getElementById('record-count').innerText==='총 1건'`);
    assert.match(await js(win,`document.getElementById('record-tbody').textContent`),/미배정 기록/);
    await filter('current');
    // A slow read must not replace B's current results.
    deferred=new Promise(resolve => {release=resolve;});await choose(a.id);
    for (let n=0;n<100 && !delayed;n++) await pause();assert.equal(delayed,1);
    await choose(b.id);await until(win,`document.getElementById('record-count').innerText==='총 1건'`);release();await pause(80);
    assert.equal(await js(win,`document.querySelectorAll('.record-title').length`),1);
    assert.equal(await js(win,`document.querySelector('.record-title').getAttribute('data-id')`),String(rows(b.id)[0].id));
    // A title draft survives refresh, playing-profile switch and a real DB failure.
    await choose(a.id);await until(win,`!!document.querySelector('.record-title[data-id="${first.id}"]')`);
    const edit=async (text:string) => js(win,`(()=>{document.querySelector('.record-title[data-id="${first.id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const input=document.querySelector('#record-tbody input');input.value=${JSON.stringify(text)};input.focus();})()`);
    await edit('편집 중인 A 제목');win.webContents.send('timer-updated');await pause();
    assert.equal(await js(win,`document.querySelector('#record-tbody input').value`),'편집 중인 A 제목');
    await choose(b.id);assert.equal(await js(win,'recordFilter'),a.id);assert.equal(await js(win,'profileFilter.disabled'),true);
    store.database.exec("CREATE TRIGGER fail_title BEFORE UPDATE OF title ON timer_records BEGIN SELECT RAISE(ABORT,'fixture title disk full');END");
    await js(win,`document.querySelector('#record-tbody input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await until(win,`!!activeTitleEdit && !activeTitleEdit.saving && !document.getElementById('stopwatch-error').classList.contains('hidden')`);
    assert.equal(await js(win,`document.querySelector('#record-tbody input').value`),'편집 중인 A 제목');assert.equal(diary.getTimerRecord(first.id).title,'');
    store.database.exec('DROP TRIGGER fail_title');
    await js(win,`document.querySelector('#record-tbody input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await until(win,`!activeTitleEdit && !!document.querySelector('.record-title[data-id="${first.id}"]')`);
    assert.equal(diary.getTimerRecord(first.id).title,'편집 중인 A 제목');assert.equal(rows(b.id)[0].title,'');
    await edit('취소할 제목');win.show();win.focus();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(win,'!activeTitleEdit');await pause();assert.equal(diary.getTimerRecord(first.id).title,'편집 중인 A 제목');
    await edit('포커스 이동 저장');await js(win,`document.getElementById('btn-toggle-guide').focus()`);
    await until(win,'!activeTitleEdit');assert.equal(diary.getTimerRecord(first.id).title,'포커스 이동 저장');
    // A queued start is protected from deletion even before the timer operation runs.
    const queued=timer.controlStopwatch('start');const rejected=service.remove(b.id);
    await queued;assert.equal((await rejected).success,false);await timer.controlStopwatch('stop');
    assert.equal((await service.remove(a.id)).success,true);
    await filter(a.id);await until(win,`document.getElementById('record-count').innerText==='총 2건'`);
    assert.match(await js(win,`document.getElementById('record-tbody').textContent`),/삭제됨/);
    assert.equal((await mutate({kind:'recalculate',id:first.id,series:'stab',core:null})).success,true,'frozen snapshot survives owner deletion');
    assert.equal((await mutate({kind:'recalculate',id:oldOwned.id,series:'stab',core:null})).success,false,'deleted old owner never borrows B presets');
    assert.equal((await mutate({kind:'title',id:first.id,title:'삭제된 프로필의 기록도 보존'})).success,true);
    await filter('all');await until(win,`document.getElementById('record-count').innerText==='총 5건'`);
    await pause(100);fs.writeFileSync(path.join(output,'stopwatch-1000.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(800,600);await pause(150);fs.writeFileSync(path.join(output,'stopwatch-800.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js(win,`document.documentElement.scrollWidth<=innerWidth`),true);
    assert.equal(await js(win,`(()=>{const title=document.querySelector('.record-title'),r=title.getBoundingClientRect();return r.top>0 && r.bottom<innerHeight && document.elementFromPoint(r.left+5,r.top+5)?.closest('#record-tbody')!==null;})()`),true,'minimum-size window must show an editable history row');
    await timer.controlStopwatch('start');
    const clone=store.create('복사 프로필',7,b.id);await choose(clone.id);assert.equal(timer.getStopwatchState().running,false);
    await choose(b.id);assert.equal(timer.getStopwatchState().running,true);
    const originalStart=timer.getStopwatchState().startedAt,originalSession=service.status().sessionId;
    service.beginSession('next-stopwatch-game');
    await until(hud,`!timerIsRunning && document.getElementById('timer-hud').classList.contains('hidden')`);
    await assert.rejects(timer.controlStopwatch('stop'),/선택/);
    await choose(b.id);assert.equal(timer.getStopwatchState().startedAt,originalStart);
    await timer.controlStopwatch('stop');assert.equal(rows(b.id).sort((x:any,y:any) => y.id-x.id)[0].record_session_id,originalSession);

    // 실제 계산기 입력 → DB 저장 → 프로필 전환/복원 → 스톱워치 저장을 한 흐름으로 확인한다.
    const calculator=await page('coefficient-calculator.html');windows.push(calculator);
    const calculatorReady=async (id:string) => until(calculator,`window.profileToolStorage?.profileId()===${JSON.stringify(id)} && typeof saveCurrentProfile==='function' && !!gearData?.defense?.['투구']?.length && window.profileToolStorage.flush() && !document.body.inert`);
    const input=async (id:string,value:string) => js(calculator,`(()=>{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(el.tagName==='SELECT' ? 'change' : 'input',{bubbles:true}));})()`);
    const savedInput=(id:string) => {const stored=store.toolValues(id);return JSON.parse(stored[key])[stored[key+'_last']].data;};
    const latestRecord=(id:string) => rows(id).sort((x:any,y:any) => y.id-x.id)[0];
    await calculatorReady(b.id);
    await input('stat-stab','321');await input('preview-helm-main','111');await input('upg-helm-main','17');await input('main-core-select','mercurial');
    await input('bonus-core-mercurial','25');
    await js(calculator,`document.getElementById('btn-add-profile').click();document.getElementById('modal-input').value='보스용 계산';document.getElementById('modal-confirm').click()`);
    await until(calculator,`document.getElementById('modal-overlay').classList.contains('hidden') && Object.values(profiles).some(p=>p.name==='보스용 계산')`);
    const bossPreset=store.toolValues(b.id)[key+'_last'];
    await input('stat-stab','333');
    assert.equal(savedInput(b.id).stats.stab,'333');assert.equal(savedInput(b.id).upgradesMain.helm,'17');
    await choose(clone.id);await calculatorReady(clone.id);
    assert.equal(await js(calculator,`document.getElementById('stat-stab').value`),'800');
    assert.equal(await js(calculator,`Object.values(profiles).some(p=>p.name==='보스용 계산')`),false);
    await input('stat-stab','654');await input('buff-preset-select','standard');
    await choose(b.id);await calculatorReady(b.id);
    assert.equal(await js(calculator,`document.getElementById('stat-stab').value`),'333');
    assert.equal(await js(calculator,`document.getElementById('profile-select').value`),bossPreset);
    assert.equal(await js(calculator,`document.getElementById('preview-helm-main').value`),'111');
    assert.equal(await js(calculator,`document.getElementById('upg-helm-main').value`),'17');
    assert.equal(await js(calculator,`document.getElementById('main-core-select').value`),'mercurial');
    assert.equal(await js(calculator,`document.getElementById('buff-preset-select').value`),'same-preset');
    await timer.controlStopwatch('start');
    const capturedB=savedInput(b.id);
    await input('stat-stab','987');await input('preview-helm-main','777');await input('upg-helm-main','88');
    await choose(clone.id);await calculatorReady(clone.id);
    assert.equal(await js(calculator,`document.getElementById('stat-stab').value`),'654');
    assert.equal(await js(calculator,`document.getElementById('buff-preset-select').value`),'standard');
    await timer.controlStopwatch('start');await timer.controlStopwatch('stop');
    const cloneRecord=latestRecord(clone.id);
    assert.equal(JSON.parse(cloneRecord.raw_profile_data).stats.stab,'654');
    assert.equal(JSON.parse(cloneRecord.raw_profile_data).buffPreset,'standard');
    assert.ok(JSON.parse(cloneRecord.raw_profile_data).stopwatchBuffEffects.fixed>0 || JSON.parse(cloneRecord.raw_profile_data).stopwatchBuffEffects.percent>0);
    await choose(b.id);await calculatorReady(b.id);await timer.controlStopwatch('stop');
    const bRecord=latestRecord(b.id),recordedB=JSON.parse(bRecord.raw_profile_data);
    for (const field of ['stats','gears','basesMain','upgradesMain','mainCore','buffPreset','bonuses']) assert.deepEqual(recordedB[field],capturedB[field],`stopwatch must capture original calculator ${field}`);
    assert.equal(bRecord.char_main,333);assert.equal(bRecord.core_master,'mercurial');
    calculator.destroy();
    await timer.controlStopwatch('start');
    const savedCount=rows().length;
    // App quit/re-initialization deliberately does not persist an unfinished stopwatch.
    controller.dispose();
    const restarted=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {}});
    assert.equal(timer.getStopwatchState().running,false);assert.equal(rows().length,savedCount);restarted.dispose();
    console.log('PASS profile stopwatch: ownership, concurrent timers, captured stats, actual calculator inputs/presets/equipment/buffs end-to-end, filters, draft/failure, deleted history and real HUD');
  } finally {
    release();for (const win of windows) if (!win.isDestroyed()) win.destroy();
    controller.dispose();prepared.stopClock();config.flushPending();
  }
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
