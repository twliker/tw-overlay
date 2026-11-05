/** 실제 제품 HTML→preload→IPC→공유 SQLite. 임시 사용자 폴더만 사용한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow,ipcMain,dialog} from 'electron';

const root=path.resolve(__dirname,'..');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-diary-profiles-ui-'));
const output=path.join(root,'output/profile-diary-ui');
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const pause=(ms=30) => new Promise(resolve => setTimeout(resolve,ms));
const js=async (win:BrowserWindow,code:string):Promise<any> => {
  try {return await win.webContents.executeJavaScript(code);} catch (error) {throw new Error(`${String(error)}\nPage: ${code.slice(0,250)}`);}
};
async function until(win:BrowserWindow,code:string):Promise<void> {
  for (let n=0;n<200;n++) {if (await js(win,`Boolean(${code})`)) return;await pause();}
  throw new Error(`Timed out: ${code}`);
}
const errors:string[]=[];
async function page(name:string,width=1000,height=900):Promise<BrowserWindow> {
  const win=new BrowserWindow({show:false,width,height,webPreferences:{preload:path.join(root,'dist/preload.js'),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event => {if (event.level==='error' && !/ERR_FILE_NOT_FOUND/.test(event.message)) errors.push(`${name}: ${event.message}`);});
  await win.loadFile(path.join(root,'dist',name));
  await js(win,'window.diaryProfiles.ready');return win;
}
async function capture(win:BrowserWindow,name:string):Promise<void> {
  await pause(200);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());
}
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(output,{recursive:true});
  const config=built('modules/config'),db=built('modules/diaryDb');
  const defaults=built('modules/constants').DEFAULT_CONFIG;
  const legacy={...structuredClone(defaults),userServer:7,volumeCalculators:0,lootKeywords:['확인 품목'],
    characterPresets:[{id:'A',name:'사냥 <A>'},{id:'B',name:'거래 B'}],selectedCharacterId:'A'};
  assert.equal(config.saveConfirmed(legacy),true);
  const today=new Date(),date=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`,month=date.slice(0,7);
  db.initDb();db.addManualActivityLog(date,'01:00:00','calc','미배정 수익',30);assert.equal(db.closeDb(),true);
  const store=await built('modules/applicationData').ApplicationData.initialize({directory:fixture,deviceId:'ui-diary',defaults},legacy);
  db.connectApplicationData(store);
  config.installPersistence({read:(value:any) => store.readConfiguration(value),commit:(value:any,previous:any) => store.commitConfiguration(value,previous)});
  const service=new (built('modules/profileService').ProfileService)(store,config,{changed:(state:any) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('play-profiles-changed',state);
  }});
  const a=store.list().find((profile:any) => profile.name==='사냥 <A>');
  const b=store.list().find((profile:any) => profile.name==='거래 B');const c=store.create('보관 프로필',16);
  for (const [id,amount] of [[a.id,1000],[b.id,200],[c.id,50]]) store.withRecordContext(id,null,() => {
    db.addManualActivityLog(date,'02:00:00','calc',`수익 ${id}`,amount);
    db.addManualActivityLog(date,'02:01:00','loot','[득템] 확인 품목',1);
  });
  store.remove(c.id);
  const runtime=built('modules/profileRuntime');runtime.setProfileRuntime({service,replay:() => {}});
  service.beginSession('ui-game');assert.equal((await service.select(a.id,() => {})).success,true);
  let gate:Promise<void> | undefined,release:(() => void) | undefined,entered=0,delayFilter='',readGate:Promise<void> | undefined,readRelease:(() => void) | undefined,readsEntered=0;
  let failProfileRead=false,archiveGate:Promise<void> | undefined,archiveRelease:(()=>void) | undefined;
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,listener) => register(channel,async (event,...args) => {
    if(channel==='diary-profiles-get' && failProfileRead)throw new Error('fixture profile state unavailable');
    if (channel==='diary-add-activity') {entered++;if (gate) await gate;}
    const result=await listener(event,...args);
    if(channel==='diary-archive-ignore' && archiveGate)await archiveGate;
    if (channel.startsWith('diary-get-') && delayFilter && args.at(-1)?.profileId===delayFilter && readGate) {readsEntered++;await readGate;}
    return result;
  });
  let savePath='';dialog.showSaveDialog=async () => ({canceled:!savePath,filePath:savePath});
  built('modules/ipcHandlers').register();ipcMain.handle=register;
  const diary=await page('diary.html');
  await until(diary,`currentSummary?.totalSeed===1280`);
  const filter=async (value:string) => {await js(diary,`document.getElementById('diary-profile-filter').value=${JSON.stringify(value)};document.getElementById('diary-profile-filter').dispatchEvent(new Event('change'));`);};
  await js(diary,`window.__filterChanges=0;window.addEventListener('diary-profile-filter-changed',()=>window.__filterChanges++);`);
  await filter('unassigned');await until(diary,'currentSummary?.totalSeed===30');
  assert.equal(await js(diary,'window.__filterChanges'),1,'조회 범위 선택 한 번은 한 번만 새로고침');
  await filter('all');await until(diary,'currentSummary?.totalSeed===1280');
  const target=async (win:BrowserWindow,id:string,value:string) => js(win,`{const select=document.querySelector(${JSON.stringify('#'+id+' select')});select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change'));}`);
  const fa={kind:'profile',profileId:a.id},fb={kind:'profile',profileId:b.id};
  for (const [scope,amount] of [[fa,1000],[fb,200],[{kind:'unassigned'},30],[{kind:'profile',profileId:c.id},50]] as Array<[{kind:string;profileId?:string},number]>) {
    const result=await js(diary,`(async()=>{const f=${JSON.stringify(scope)};return {
      day:await electronAPI.diaryGetByDate('${date}',f),summary:await electronAPI.diaryGetMonthlySummary('${month}',f),
      stats:await electronAPI.diaryGetStatistics('${month}',f),revenue:await electronAPI.diaryGetMonthlyRevenue('${month}',f),
      loot:await electronAPI.diaryGetLootHistory('${date}','${date}',f),export:await electronAPI.previewDiaryExport('${date}','${date}',f)};})()`);
    assert.equal(result.summary.totalSeed,amount);assert.equal(result.stats.totalSeed,amount);assert.equal(result.export.totalSeed,amount);
    assert.equal(result.day.activityLogs.filter((row:any) => row.type==='calc').reduce((n:number,row:any) => n+row.amount,0),amount);
    assert.equal(result.revenue.reduce((n:number,row:any) => n+row.amount,0),amount);
    assert.equal(result.loot.length,scope.kind==='unassigned' ? 0 : 1);
  }
  await assert.rejects(js(diary,`electronAPI.diaryGetByDate('${date}',{kind:'profile',profileId:'missing'})`));
  await assert.rejects(js(diary,`electronAPI.diaryGetByDate('${date}',{kind:'all',profileId:'ignored'})`));
  assert.equal(await js(diary,`electronAPI.diaryAddActivity('${date}','03:00:00','calc','미지정',10)`),null);
  assert.equal(await js(diary,`electronAPI.diaryAddActivity('${date}','03:00:00','calc','삭제됨',10,${JSON.stringify(c.id)})`),null);

  // 늦은 A 응답이 B의 월간 합계를 덮지 않는다.
  delayFilter=a.id;readGate=new Promise(resolve => {readRelease=resolve;});await filter(a.id);
  await until(diary,'true');for (let n=0;n<100 && !readsEntered;n++) await pause();assert.ok(readsEntered);
  await filter(b.id);await until(diary,'currentSummary?.totalSeed===200');readRelease!();readGate=undefined;delayFilter='';await pause(100);
  assert.equal(await js(diary,'currentSummary.totalSeed'),200);
  await filter(a.id);await until(diary,'currentSummary?.totalSeed===1000');await js(diary,`selectDate('${date}')`);
  await js(diary,`selectWeek(1,['${date}'],null,0,0)`);
  assert.match(await js(diary,`document.getElementById('weekly-summary-area').textContent+document.getElementById('daily-summary-area').textContent`),/1,000/);
  await filter(b.id);await until(diary,`currentSummary?.totalSeed===200 && selectedWeekView!==null`);
  await until(diary,`document.getElementById('weekly-summary-area').textContent.includes('200')`);
  await filter(a.id);await until(diary,'currentSummary?.totalSeed===1000');await js(diary,`selectDate('${date}')`);
  await target(diary,'diary-record-profile',b.id);
  await js(diary,`document.getElementById('manual-seed-desc').value='프로필 지출';document.getElementById('manual-seed-amount').value='45';document.getElementById('manual-seed-mode').value='expense';`);
  gate=new Promise(resolve => {release=resolve;});const writesBefore=entered;
  await js(diary,`document.getElementById('manual-seed-add-btn').click();document.getElementById('manual-seed-add-btn').click()`);
  for (let n=0;n<100 && entered===writesBefore;n++) await pause();assert.equal(entered,writesBefore+1);
  await service.select(a.id,() => {});
  await js(diary,`document.getElementById('manual-seed-desc').value='저장 중 새 초안'`);
  release!();gate=undefined;
  await until(diary,`document.getElementById('manual-record-status').textContent.includes('현재 조회 범위')`);
  assert.equal(store.database.prepare("SELECT profile_id,amount FROM activity_logs WHERE content LIKE '%프로필 지출%'").get().profile_id,b.id);
  assert.equal(db.getMonthlySummary(month,undefined,fb).totalSeed,155);
  assert.equal(await js(diary,`document.getElementById('manual-seed-desc').value`),'저장 중 새 초안');
  await js(diary,`document.getElementById('loot-name').value='수동 득템';document.getElementById('loot-count').value='2';saveLoot()`);
  assert.equal(store.database.prepare("SELECT profile_id FROM activity_logs WHERE content LIKE '%수동 득템%'").get().profile_id,b.id);
  db.getStmt("CREATE TRIGGER reject_profile_manual BEFORE INSERT ON activity_logs BEGIN SELECT RAISE(ABORT,'fixture save failure');END").run();
  await js(diary,`document.getElementById('manual-seed-desc').value='재시도 초안';document.getElementById('manual-seed-amount').value='9';document.getElementById('manual-seed-add-btn').click()`);
  await until(diary,`document.getElementById('manual-record-status').textContent.includes('저장하지 못')`);
  assert.equal(await js(diary,`document.getElementById('manual-seed-desc').value`),'재시도 초안');db.getStmt('DROP TRIGGER reject_profile_manual').run();
  // 저장 대상과 조회 범위가 달라도 export는 조회 범위의 고정 snapshot이다.
  const review=await js(diary,`electronAPI.previewDiaryExport('${date}','${date}',${JSON.stringify(fa)})`);
  assert.match(review.profileLabel,/<A>/);
  assert.equal((await js(diary,`electronAPI.saveDiaryExport('${review.token}',${JSON.stringify(fb)})`)).success,false);
  savePath=path.join(fixture,'profile.html');assert.equal((await js(diary,`electronAPI.saveDiaryExport('${review.token}',${JSON.stringify(fa)})`)).success,true);
  const exported=fs.readFileSync(savePath,'utf8');assert.match(exported,/사냥 &lt;A&gt;/);assert.doesNotMatch(exported,/프로필 지출/);
  await js(diary,`document.getElementById('diary-export-open').click();document.getElementById('diary-export-preview').click()`);
  await until(diary,`!document.getElementById('diary-export-save').disabled`);await filter(b.id);
  assert.equal(await js(diary,`document.getElementById('diary-export-save').disabled`),true);await js(diary,`document.getElementById('diary-export-close').click()`);
  await capture(diary,'diary-1000.png');diary.setSize(900,650);await capture(diary,'diary-min.png');
  await js(diary,`document.getElementById('manual-seed-add-btn').scrollIntoView({block:'center'})`);
  assert.equal(await js(diary,`document.getElementById('manual-seed-add-btn').getBoundingClientRect().bottom<=innerHeight`),true);
  await capture(diary,'diary-min-input.png');

  // 마정석 입력을 시작한 대상은 다른 창에서 현재 프로필을 바꿔도 유지된다.
  await service.select(a.id,() => {});const stone=await page('magic-stone-calculator.html',420,850);
  await js(stone,`{const input=document.getElementById('direct-pouch-count');input.value='2';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await service.select(b.id,() => {});await js(stone,'window.diaryProfiles.refresh()');
  assert.equal(await js(stone,`document.querySelector('#stone-record-profile select').value`),a.id);
  gate=new Promise(resolve => {release=resolve;});const stoneBefore=entered;await js(stone,`document.getElementById('save-diary-btn').click();document.getElementById('save-diary-btn').click()`);
  for (let n=0;n<100 && entered===stoneBefore;n++) await pause();assert.equal(entered,stoneBefore+1);
  release!();gate=undefined;await until(stone,`document.getElementById('save-diary-btn').textContent.includes('완료')`);
  assert.equal(store.database.prepare("SELECT profile_id FROM activity_logs WHERE content LIKE '%마정석 교환%'").get().profile_id,a.id);await capture(stone,'stone.png');
  await js(stone,`document.getElementById('save-diary-btn').scrollIntoView({block:'center'})`);await capture(stone,'stone-save.png');

  const boss=await page('boss-settings.html',460,800);
  boss.webContents.send('config-data',config.load());boss.webContents.send('boss-times-data',{'골론':['00:00']});
  await until(boss,`document.querySelector('.time-tag') && !bossLoading`);
  await target(boss,'boss-record-profile',a.id);await until(boss,'!bossLoading');await js(boss,`recordBossKillByTime('골론','00:00')`);
  assert.equal(await js(boss,`document.querySelector('.time-tag').classList.contains('killed')`),true);
  await target(boss,'boss-record-profile',b.id);await until(boss,'!bossLoading');assert.equal(await js(boss,`document.querySelector('.time-tag').classList.contains('killed')`),false);
  await js(boss,`recordBossKillByTime('골론','00:00')`);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='boss'").get().n,2);
  await js(boss,`recordBossKillByTime('골론','00:00')`);assert.equal(store.database.prepare("SELECT profile_id FROM activity_logs WHERE type='boss'").get().profile_id,a.id);
  await capture(boss,'boss.png');

  const sidebar=await page('index.html',400,850);sidebar.webContents.send('config-data',config.load());
  await js(sidebar,`createToast('골론',false,'00:00',0,true)`);
  await until(sidebar,`document.querySelector('[data-boss-record-profile] select')`);
  await js(sidebar,`document.querySelector('[data-boss-record-profile] select').value=${JSON.stringify(b.id)};document.querySelector('[data-boss-record-profile] select').dispatchEvent(new Event('change'));`);
  await js(sidebar,`document.querySelector('[data-boss-record-profile]').nextElementSibling.querySelector('button').click()`);
  await until(sidebar,`document.querySelector('[data-boss-record-profile]').nextElementSibling.textContent.includes('기록 완료')`);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='boss'").get().n,2);
  await capture(sidebar,'sidebar.png');
  // 삭제된 프로필은 조회 선택지에서 숨기고, 별도 정리 창에서 미배정으로 보낸다.
  assert.equal(await js(diary,`[...document.getElementById('diary-profile-filter').options].some(o=>o.value===${JSON.stringify(c.id)})`),false);
  await filter('unassigned');await until(diary,'currentSummary?.totalSeed===30');
  assert.match(await js(diary,`document.getElementById('diary-profile-note').textContent`),/새 수동 기록/);
  assert.equal(await js(diary,`getComputedStyle(document.getElementById('diary-profile-filter')).colorScheme`),'dark');
  assert.equal(await js(diary,`getComputedStyle(document.querySelector('#diary-profile-filter option')).backgroundColor`),'rgb(15, 18, 30)');
  await assert.rejects(js(sidebar,`electronAPI.ignoreArchivedDiaryProfile(${JSON.stringify(c.id)})`),/모험일지/);
  await assert.rejects(js(diary,`electronAPI.ignoreArchivedDiaryProfile(${JSON.stringify(a.id)})`),/사용 중/);
  await assert.rejects(js(diary,`electronAPI.ignoreArchivedDiaryProfile('../bad')`));
  const beforeArchive=store.database.prepare('SELECT * FROM activity_logs WHERE profile_id=? ORDER BY id').all(c.id);
  const access=built('modules/diaryProfileAccess'),readState=access.getDiaryProfileState;
  access.getDiaryProfileState=()=>{throw new Error('fixture archive result read failure');};
  try {await assert.rejects(js(diary,`electronAPI.ignoreArchivedDiaryProfile(${JSON.stringify(c.id)})`),/fixture archive result read failure/);}
  finally {access.getDiaryProfileState=readState;}
  assert.equal(store.database.prepare('SELECT 1 FROM diary_profile_meta WHERE key=?').get('unassigned-profile:'+c.id),undefined,'결과 snapshot 실패는 분류 변경도 rollback');
  await js(diary,'window.diaryProfiles.refresh()');
  await js(diary,`document.getElementById('diary-archives-open').click();document.querySelector('#diary-archives-list button').click()`);
  assert.equal(await js(diary,`document.getElementById('diary-archives-status').textContent.includes('미배정')`),true);
  await capture(diary,'archives-confirm.png');
  await js(diary,`document.querySelector('#diary-archives-list button').click()`);
  assert.deepEqual(store.database.prepare('SELECT * FROM activity_logs WHERE profile_id=? ORDER BY id').all(c.id),beforeArchive,'취소는 원본 보존');
  const restoring=service.beginHistoricalRestore(b.id);
  await js(diary,'window.diaryProfiles.refresh()');
  assert.equal(await js(diary,`[...document.querySelectorAll('#diary-archives-list button')].every(button=>button.disabled)`),true,'복원/전환 중 정리 동작 잠금');
  await assert.rejects(js(diary,`electronAPI.ignoreArchivedDiaryProfile(${JSON.stringify(c.id)})`),/다른 작업/);
  restoring.finish(()=>{});await js(diary,'window.diaryProfiles.refresh()');
  store.database.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON diary_profile_meta WHEN NEW.key LIKE 'unassigned-profile:%' BEGIN SELECT RAISE(ABORT,'fixture archive failure');END");
  const confirmArchive=()=>js(diary,`document.querySelector('#diary-archives-list button').click();[...document.querySelectorAll('#diary-archives-list button')].find(b=>b.textContent==='미배정으로 옮기기').click()`);
  await confirmArchive();await until(diary,`document.getElementById('diary-archives-status').textContent.includes('기록을 정리하지 못했습니다')`);
  assert.equal(db.getMonthlySummary(month,undefined,{kind:'unassigned'}).totalSeed,30);
  store.database.exec('DROP TRIGGER reject_archive');
  await filter(b.id);await until(diary,'currentSummary?.totalSeed===155');
  const messaging=built('modules/windowMessaging'),broadcast=messaging.broadcastToAllWindows;
  failProfileRead=true;messaging.broadcastToAllWindows=()=>{throw new Error('fixture notification failure');};
  try {
    await js(diary,`window.__filterChanges=0;[...document.querySelectorAll('#diary-archives-list button')].find(b=>b.textContent==='미배정으로 옮기기').click()`);
    await until(diary,`document.getElementById('diary-archives-status').textContent.includes('2건을')`);
    await until(diary,`document.querySelector('#diary-record-profile .ui-status').textContent.includes('불러오지 못')`);
    assert.equal(await js(diary,'window.__filterChanges'),1);
    assert.equal(await js(diary,`document.getElementById('diary-profile-note').textContent.startsWith('조회 중: 미배정')`),true);
  } finally {messaging.broadcastToAllWindows=broadcast;failProfileRead=false;}
  await until(diary,'currentSummary?.totalSeed===80');
  assert.equal(await js(diary,`document.getElementById('diary-profile-filter').value`),'unassigned');
  assert.equal(await js(diary,`document.getElementById('diary-archives-open').hidden`),true);
  assert.deepEqual(store.database.prepare('SELECT * FROM activity_logs WHERE profile_id=? ORDER BY id').all(c.id),beforeArchive,'정리는 원문/소유자/UUID 보존');
  assert.equal(db.getMonthlySummary(month,undefined,fb).totalSeed,155,'현재 대상 프로필로 보내지 않음');
  await js(diary,'window.diaryProfiles.refresh()');
  await capture(diary,'archives-complete.png');await js(diary,`document.getElementById('diary-archives-close').click()`);
  // 정리 ACK가 늦게 도착해도 그 사이 선택한 현재 프로필과 작성 중인 입력은 되돌리지 않는다.
  const delayed=store.create('늦은 정리 결과',7);
  store.withRecordContext(delayed.id,null,()=>db.addManualActivityLog(date,'04:00:00','calc','늦은 정리',5));store.remove(delayed.id);
  await js(diary,'window.diaryProfiles.refresh()');
  const draftBeforeArchive=await js(diary,`[document.getElementById('manual-seed-desc').value,document.querySelector('#diary-record-profile select').value]`);
  archiveGate=new Promise(resolve=>{archiveRelease=resolve;});
  await js(diary,`document.getElementById('diary-archives-open').click()`);await confirmArchive();
  for(let n=0;n<100 && !store.database.prepare('SELECT 1 FROM diary_profile_meta WHERE key=?').get('unassigned-profile:'+delayed.id);n++)await pause();
  assert.ok(store.database.prepare('SELECT 1 FROM diary_profile_meta WHERE key=?').get('unassigned-profile:'+delayed.id));
  assert.equal((await service.select(a.id,()=>{})).success,true);await js(diary,'window.diaryProfiles.refresh()');
  archiveRelease!();archiveGate=undefined;
  await until(diary,`document.getElementById('diary-archives-status').textContent.includes('1건을')`);
  assert.equal(await js(diary,'window.diaryProfiles.state().activeProfileId'),a.id);
  assert.deepEqual(await js(diary,`[document.getElementById('manual-seed-desc').value,document.querySelector('#diary-record-profile select').value]`),draftBeforeArchive);
  await js(diary,`document.getElementById('diary-archives-close').click()`);
  await diary.reload();await js(diary,'window.diaryProfiles.ready');
  assert.equal(await js(diary,`document.getElementById('diary-archives-open').hidden`),true,'재시작해도 정리된 목록은 다시 나오지 않음');
  // 기능 활성화 전의 토스트도 같은 제품 경로로 저장하며 기존 완료 표시는 유지한다.
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  await pause(100);
  runtime.setProfileRuntime(null);
  const legacySidebar=await page('index.html',400,850);legacySidebar.webContents.send('config-data',config.load());
  await js(legacySidebar,`createToast('골론',false,'00:00',0,true);createToast('아칸',false,'00:00',0,false)`);
  assert.equal(await js(legacySidebar,`document.querySelectorAll('[data-boss-record-button]')[0].disabled`),true);
  await js(legacySidebar,`document.querySelectorAll('[data-boss-record-button]')[1].click()`);
  await until(legacySidebar,`document.querySelectorAll('[data-boss-record-button]')[1]?.textContent.includes('기록 완료')`);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='boss'").get().n,3);
  for (const script of ['renderer/diary-profiles.js','renderer/diary/profile-filter.js','renderer/boss-diary-toast.js']) assert.doesNotMatch(fs.readFileSync(path.join(root,'dist',script),'utf8'),/\brequire\(|\bexports\./);
  assert.deepEqual(errors,[]);
  for (const win of BrowserWindow.getAllWindows()) win.destroy();runtime.setProfileRuntime(null);db.closeDb();
  console.log(`Diary profiles UI passed; screenshots: ${output}`);
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
