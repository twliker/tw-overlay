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
  let profileReads=0;
  let failProfileRead=false,archiveGate:Promise<void> | undefined,archiveRelease:(()=>void) | undefined,failDiaryReads=false;
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,listener) => register(channel,async (event,...args) => {
    if(channel==='diary-profiles-get') {
      profileReads++;
      if(failProfileRead)throw new Error('fixture profile state unavailable');
    }
    if (channel==='diary-add-activity') {entered++;if (gate) await gate;}
    if (failDiaryReads && channel.startsWith('diary-get-')) throw new Error('fixture diary read failure');
    const result=await listener(event,...args);
    if(channel==='diary-archive-ignore' && archiveGate)await archiveGate;
    if (channel.startsWith('diary-get-') && delayFilter && args.at(-1)?.profileId===delayFilter && readGate) {readsEntered++;await readGate;}
    return result;
  });
  let savePath='';dialog.showSaveDialog=async () => ({canceled:!savePath,filePath:savePath});
  built('modules/ipcHandlers').register();ipcMain.handle=register;
  const diary=await page('diary.html');
  await until(diary,`currentSummary?.totalSeed===1280`);
  const baseStatus=service.status();
  diary.webContents.send('play-profiles-changed',baseStatus);
  await js(diary,'new Promise(resolve=>setTimeout(resolve,50))');
  const priorProfileReads=profileReads;
  for(let count=1;count<=25;count++) {
    diary.webContents.send('play-profiles-changed',{...baseStatus,pendingSessions:[{sessionId:'fixture',count,firstOccurredAt:1,lastOccurredAt:count}]});
  }
  await js(diary,'new Promise(resolve=>setTimeout(resolve,50))');
  assert.equal(profileReads,priorProfileReads,'미배정 건수만 바뀌면 이전 프로필 기록을 다시 집계하지 않는다');
  const filter=async (value:string) => {await js(diary,`document.getElementById('diary-profile-filter').value=${JSON.stringify(value)};document.getElementById('diary-profile-filter').dispatchEvent(new Event('change'));`);};
  await js(diary,`window.__filterChanges=0;window.addEventListener('diary-profile-filter-changed',()=>window.__filterChanges++);`);
  await filter('unassigned');await until(diary,'currentSummary?.totalSeed===30');
  assert.equal(await js(diary,'window.__filterChanges'),1,'조회 범위 선택 한 번은 한 번만 새로고침');
  await filter('all');await until(diary,'currentSummary?.totalSeed===1280');
  // 현재 사용 프로필 전환과 전환 중(busy) 표시만 바뀌면 선택지 문구만 갱신하고 일지를 비우거나 다시 읽지 않는다.
  const activeOption=(id:string) => `[...document.getElementById('diary-profile-filter').options].find(o=>o.value===${JSON.stringify(id)})?.textContent.includes('현재 사용')`;
  await js(diary,'window.__filterChanges=0');
  assert.equal((await service.select(b.id,() => {})).success,true);await until(diary,activeOption(b.id));
  assert.equal((await service.select(a.id,() => {})).success,true);await until(diary,activeOption(a.id));
  await js(diary,'new Promise(resolve=>setTimeout(resolve,100))');
  assert.equal(await js(diary,'window.__filterChanges'),0,'조회 범위가 그대로면 프로필 전환으로 일지를 다시 불러오지 않는다');
  assert.equal(await js(diary,'currentSummary?.totalSeed'),1280);
  // 조회 오류 안내는 최신 조회 결과를 따른다. 일시적 실패 뒤 다시 읽기에 성공하면 사라진다.
  const readError=`document.getElementById('diary-view-error')`;
  failDiaryReads=true;
  try {await js(diary,'loadMonthData()');await until(diary,`!${readError}.hidden`);}
  finally {failDiaryReads=false;}
  await js(diary,'loadMonthData()');await until(diary,`${readError}.hidden && currentSummary?.totalSeed===1280`);
  failDiaryReads=true;
  try {await js(diary,`selectDate('${date}')`);await until(diary,`!${readError}.hidden`);}
  finally {failDiaryReads=false;}
  await js(diary,`selectDate('${date}')`);await until(diary,`${readError}.hidden`);
  // 위에서 일부러 만든 읽기 실패의 console.error만 제외한다.
  errors.splice(0,errors.length,...errors.filter(message => !/fixture diary read failure/.test(message)));
  const target=async (win:BrowserWindow,id:string,value:string) => js(win,`{const select=document.querySelector(${JSON.stringify('#'+id+' select')});select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change'));}`);
  const fa={kind:'profile',profileId:a.id},fb={kind:'profile',profileId:b.id};
  for (const [scope,amount] of [[fa,1000],[fb,200],[{kind:'unassigned'},30]] as Array<[{kind:string;profileId?:string},number]>) {
    const result=await js(diary,`(async()=>{const f=${JSON.stringify(scope)};return {
      day:await electronAPI.diaryGetByDate('${date}',f),summary:await electronAPI.diaryGetMonthlySummary('${month}',f),
      stats:await electronAPI.diaryGetStatistics('${month}',f),revenue:await electronAPI.diaryGetMonthlyRevenue('${month}',f),
      loot:await electronAPI.diaryGetLootHistory('${date}','${date}',f),export:await electronAPI.previewDiaryExport('${date}','${date}',f)};})()`);
    assert.equal(result.summary.totalSeed,amount);assert.equal(result.stats.totalSeed,amount);assert.equal(result.export.totalSeed,amount);
    assert.equal(result.day.activityLogs.filter((row:any) => row.type==='calc').reduce((n:number,row:any) => n+row.amount,0),amount);
    assert.equal(result.revenue.reduce((n:number,row:any) => n+row.amount,0),amount);
    assert.equal(result.loot.length,scope.kind==='unassigned' ? 0 : 1);
  }
  const deletedFilter=JSON.stringify({kind:'profile',profileId:c.id});
  await assert.rejects(js(diary,`electronAPI.diaryGetByDate('${date}',${deletedFilter})`),/조회할 프로필/);
  const deletedExport=await js(diary,`electronAPI.previewDiaryExport('${date}','${date}',${deletedFilter})`);
  assert.equal(deletedExport.success,false);assert.match(deletedExport.error,/조회할 프로필/);
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
  // 기록에 성공하면 고정을 풀어 다음 기록은 현재 사용 프로필(B)로 간다. 표시 위치 같은 설정 입력은 대상을 고정하지 않는다.
  const stoneTarget=`document.querySelector('#stone-record-profile select').value`;
  await until(stone,`${stoneTarget}===${JSON.stringify(b.id)}`);
  await until(stone,`!document.getElementById('save-diary-btn').disabled`);
  await js(stone,`document.getElementById('save-diary-btn').click()`);
  await until(stone,`document.getElementById('save-diary-btn').textContent.includes('완료')`);
  const stoneSecond=store.database.prepare("SELECT id,profile_id FROM activity_logs WHERE content LIKE '%마정석 교환%' ORDER BY id DESC").get();
  assert.equal(stoneSecond.profile_id,b.id);
  // 아래 B 합계 검사에 영향을 주지 않도록 제품 삭제 경로로 되돌린다.
  assert.equal(await js(stone,`electronAPI.diaryRemoveActivity(${stoneSecond.id})`),true);
  await js(stone,`document.getElementById('ar-pos-left').dispatchEvent(new Event('input',{bubbles:true}))`);
  await service.select(a.id,() => {});await js(stone,'window.diaryProfiles.refresh()');
  await until(stone,`${stoneTarget}===${JSON.stringify(a.id)}`);
  await service.select(b.id,() => {});await js(stone,'window.diaryProfiles.refresh()');
  await until(stone,`${stoneTarget}===${JSON.stringify(b.id)}`);

  const boss=await page('boss-settings.html',460,800);
  boss.webContents.send('config-data',config.load());boss.webContents.send('boss-times-data',{'골론':['00:00']});
  await until(boss,`document.querySelector('.time-tag') && !bossLoading`);
  // 음량 같은 알림 설정 조작은 기록 대상을 고정하지 않는다. 처치 기록 뒤에도 대상은 현재 사용 프로필을 따른다.
  const bossTarget=`document.querySelector('#boss-record-profile select').value`;
  await until(boss,`${bossTarget}===${JSON.stringify(b.id)}`);
  await js(boss,`document.getElementById('boss-volume-input').dispatchEvent(new Event('input',{bubbles:true}))`);
  await service.select(a.id,() => {});await js(boss,'window.diaryProfiles.refresh()');
  await until(boss,`${bossTarget}===${JSON.stringify(a.id)} && !bossLoading`);
  await js(boss,`recordBossKillByTime('골론','00:00')`);
  assert.equal(store.database.prepare("SELECT profile_id FROM activity_logs WHERE type='boss' ORDER BY id DESC").get().profile_id,a.id);
  await service.select(b.id,() => {});await js(boss,'window.diaryProfiles.refresh()');
  await until(boss,`${bossTarget}===${JSON.stringify(b.id)} && !bossLoading && !document.querySelector('.time-tag').classList.contains('killed')`);
  // 같은 처치를 다시 눌러 지우면(토글) 아래 기존 검사와 같은 출발 상태가 된다.
  await service.select(a.id,() => {});await js(boss,'window.diaryProfiles.refresh()');
  await until(boss,`${bossTarget}===${JSON.stringify(a.id)} && !bossLoading && document.querySelector('.time-tag').classList.contains('killed')`);
  await js(boss,`recordBossKillByTime('골론','00:00')`);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='boss'").get().n,0);
  await service.select(b.id,() => {});await js(boss,'window.diaryProfiles.refresh()');
  await until(boss,`${bossTarget}===${JSON.stringify(b.id)} && !bossLoading`);
  await target(boss,'boss-record-profile',a.id);await until(boss,'!bossLoading');await js(boss,`recordBossKillByTime('골론','00:00')`);
  assert.equal(await js(boss,`document.querySelector('.time-tag').classList.contains('killed')`),true);
  await target(boss,'boss-record-profile',b.id);await until(boss,'!bossLoading');assert.equal(await js(boss,`document.querySelector('.time-tag').classList.contains('killed')`),false);
  await js(boss,`recordBossKillByTime('골론','00:00')`);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='boss'").get().n,2);
  await js(boss,`recordBossKillByTime('골론','00:00')`);assert.equal(store.database.prepare("SELECT profile_id FROM activity_logs WHERE type='boss'").get().profile_id,a.id);
  await capture(boss,'boss.png');

  const sidebar=await page('index.html',400,850);sidebar.webContents.send('config-data',config.load());
  const profileButton = "document.getElementById('profiles-btn')";
  const badge = `${profileButton}?.querySelector('.sidebar-profile-badge')`;
  const pending = `${profileButton}?.querySelector('.sidebar-profile-pending')`;
  const checkSystemMenuAlignment = async (position: 'left' | 'right') => {
    await js(sidebar, `document.body.dataset.sidebarPos = '${position}'`);
    const offsets = await js(sidebar, `(() => {
      const wrapper = document.getElementById('wrapper');
      const center = wrapper.getBoundingClientRect().left + wrapper.clientLeft + wrapper.clientWidth / 2;
      return Array.from(document.querySelectorAll('#system-menus button')).filter(button => button.getClientRects().length).map(button => {
        const icon = Array.from(button.children).find(child => !child.hidden && !child.hasAttribute('hidden') && !child.classList.contains('sidebar-profile-pending'));
        const rect = icon.getBoundingClientRect();
        return { id: button.id, offset: rect.left + rect.width / 2 - center };
      });
    })()`);
    assert.ok(offsets.some((item: { id: string }) => item.id === 'profiles-btn'));
    assert.deepEqual(offsets.filter((item: { offset: number }) => Math.abs(item.offset) > 1), [], `${position} 사이드바의 시스템 아이콘이 중앙에 정렬되어야 합니다.`);
  };
  await until(sidebar, `${badge}?.textContent === '거' && !${badge}.hidden`);
  await checkSystemMenuAlignment('left');
  await checkSystemMenuAlignment('right');
  assert.match(await js(sidebar, `${profileButton}.getAttribute('aria-label')`), /사용 중 · 거래 B · 하이아칸/);
  await js(sidebar, `${profileButton}.dispatchEvent(new MouseEvent('mouseenter'))`);
  assert.match(await js(sidebar, "document.getElementById('tooltip').textContent"), /거래 B · 하이아칸/);
  await js(sidebar, `${profileButton}.dispatchEvent(new MouseEvent('mouseleave'))`);
  const originalColor = await js(sidebar, `getComputedStyle(${badge}).backgroundColor`);
  assert.equal(service.update(a.id, '거래 A', 16).success, true);
  await service.select(a.id, () => {});
  await until(sidebar, `${profileButton}.dataset.tooltip === '사용 중 · 거래 A · 네냐플'`);
  const otherColor = await js(sidebar, `getComputedStyle(${badge}).backgroundColor`);
  await service.select(b.id, () => {});
  await until(sidebar, `${profileButton}.dataset.tooltip === '사용 중 · 거래 B · 하이아칸'`);
  assert.notEqual(await js(sidebar, `getComputedStyle(${badge}).backgroundColor`), otherColor,
    '같은 첫 글자를 쓰는 두 프로필의 배지 색을 구분한다.');
  assert.equal(service.update(a.id, '사냥 <A>', 7).success, true);
  service.beginSession('sidebar-profile-required');
  await until(sidebar, `${badge}.hidden && !${pending}.hidden && ${profileButton}.dataset.tooltip === '프로필을 선택해 주세요'`);
  await checkSystemMenuAlignment('left');
  await checkSystemMenuAlignment('right');
  await service.select(b.id, () => {});
  await until(sidebar, `!${badge}.hidden && ${pending}.hidden && getComputedStyle(${badge}).backgroundColor === ${JSON.stringify(originalColor)}`);
  await js(sidebar, `${profileButton}.click()`);
  const findProfilesWindow = () => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/profiles.html'));
  for (let attempt = 0; attempt < 100 && !findProfilesWindow(); attempt++) await pause();
  const profilesWindow = findProfilesWindow();
  assert.ok(profilesWindow, '프로필 버튼이 선택창을 열어야 합니다.');
  profilesWindow.destroy();
  await js(sidebar,`createToast('골론',false,'00:00',0,true)`);
  await until(sidebar,`document.querySelector('[data-boss-record-profile] select')`);
  await js(sidebar,`document.querySelector('[data-boss-record-profile] select').value=${JSON.stringify(b.id)};document.querySelector('[data-boss-record-profile] select').dispatchEvent(new Event('change'));`);
  await js(sidebar,`document.querySelector('[data-boss-record-profile]').nextElementSibling.querySelector('button').click()`);
  await until(sidebar,`document.querySelector('[data-boss-record-profile]').nextElementSibling.textContent.includes('기록 완료')`);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM activity_logs WHERE type='boss'").get().n,2);
  await capture(sidebar,'sidebar.png');
  // 열린 네 화면의 수동 대상이 삭제되면 옵션을 없애고, 다른 프로필에 자동 저장하지 않는다.
  const removed=service.create('작성 중 사라질 프로필',7).profileId;
  assert.ok(removed);
  await js(sidebar,`createToast('아칸',false,'01:00',0,false)`);
  const targets:Array<[BrowserWindow,string]>=[
    [diary,'#diary-record-profile select'],[stone,'#stone-record-profile select'],
    [boss,'#boss-record-profile select'],[sidebar,'[data-boss-record-profile] select'],
  ];
  for (const [win,selector] of targets) {
    await js(win,'window.diaryProfiles.refresh()');
    await js(win,`for (const select of document.querySelectorAll(${JSON.stringify(selector)})) {
      select.value=${JSON.stringify(removed)};select.dispatchEvent(new Event('change'));
    }`);
    assert.equal(await js(win,`document.querySelector(${JSON.stringify(selector)}).value`),removed);
  }
  await js(diary,`document.getElementById('manual-seed-desc').value='대상 삭제 후 남은 초안';document.getElementById('manual-seed-amount').value='9';`);
  assert.equal((await service.remove(removed)).success,true);
  for (const [win,selector] of targets) {
    const options=`[...document.querySelectorAll(${JSON.stringify(selector)})]`;
    await until(win,`${options}.length>0 && ${options}.every(select=>select.value==='' && [...select.options].every(option=>option.value!==${JSON.stringify(removed)} && option.value!==${JSON.stringify(c.id)}))`);
  }
  const deletedTargetWrites=entered;
  await js(diary,`document.getElementById('manual-seed-add-btn').click()`);
  await until(diary,`document.querySelector('#diary-record-profile .ui-status').textContent.includes('기록할 프로필을 선택')`);
  assert.equal(entered,deletedTargetWrites);
  assert.equal(await js(diary,`document.getElementById('manual-seed-desc').value`),'대상 삭제 후 남은 초안');
  await target(diary,'diary-record-profile',b.id);
  // 삭제된 프로필은 조회 선택지에서 숨기고, 별도 정리 창에서 미배정으로 보낸다.
  assert.equal(await js(diary,`[...document.getElementById('diary-profile-filter').options].some(o=>o.value===${JSON.stringify(c.id)})`),false);
  await filter('unassigned');await until(diary,'currentSummary?.totalSeed===30');
  assert.match(await js(diary,`document.getElementById('diary-profile-note').textContent`),/새 수동 기록/);
  assert.equal(await js(diary,`getComputedStyle(document.getElementById('diary-profile-filter')).colorScheme`),'dark');
  assert.equal(await js(diary,`getComputedStyle(document.getElementById('diary-profile-filter'), '::picker(select)').backgroundColor`),'rgb(18, 18, 28)');
  await assert.rejects(js(sidebar,`electronAPI.ignoreArchivedDiaryProfile(${JSON.stringify(c.id)})`),/모험일지/);
  await assert.rejects(js(sidebar,'electronAPI.getArchivedDiaryProfiles()'),/모험일지/);
  assert.equal((await js(sidebar,'electronAPI.getDiaryProfileState()')).archivedProfiles,undefined);
  await assert.rejects(js(diary,`electronAPI.ignoreArchivedDiaryProfile(${JSON.stringify(a.id)})`),/사용 중/);
  await assert.rejects(js(diary,`electronAPI.ignoreArchivedDiaryProfile('../bad')`));
  const beforeArchive=store.database.prepare('SELECT * FROM activity_logs WHERE profile_id=? ORDER BY id').all(c.id);
  const access=built('modules/diaryProfileAccess'),readState=access.getDiaryProfileState;
  access.getDiaryProfileState=()=>{throw new Error('fixture archive result read failure');};
  try {await assert.rejects(js(diary,`electronAPI.ignoreArchivedDiaryProfile(${JSON.stringify(c.id)})`),/fixture archive result read failure/);}
  finally {access.getDiaryProfileState=readState;}
  assert.equal(store.database.prepare('SELECT 1 FROM diary_profile_meta WHERE key=?').get('unassigned-profile:'+c.id),undefined,'결과 snapshot 실패는 분류 변경도 rollback');
  await js(diary,'window.diaryProfiles.refresh()');
  await js(diary,`document.getElementById('diary-archives-open').click()`);
  await until(diary,`!!document.querySelector('#diary-archives-list button')`);
  await js(diary,`document.querySelector('#diary-archives-list button').click()`);
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
    assert.equal(await js(diary,'window.__filterChanges'),1);
    assert.equal(await js(diary,`document.getElementById('diary-profile-note').textContent.startsWith('조회 중: 미배정')`),true);
  } finally {messaging.broadcastToAllWindows=broadcast;failProfileRead=false;}
  await until(diary,'currentSummary?.totalSeed===80');
  assert.equal(await js(diary,`document.getElementById('diary-profile-filter').value`),'unassigned');
  assert.match(await js(diary,`document.getElementById('diary-archives-list').textContent`),/정리할 이전 프로필 기록이 없습니다/);
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
  await js(diary,`document.getElementById('diary-archives-open').click()`);
  await until(diary,`!!document.querySelector('#diary-archives-list button')`);await confirmArchive();
  for(let n=0;n<100 && !store.database.prepare('SELECT 1 FROM diary_profile_meta WHERE key=?').get('unassigned-profile:'+delayed.id);n++)await pause();
  assert.ok(store.database.prepare('SELECT 1 FROM diary_profile_meta WHERE key=?').get('unassigned-profile:'+delayed.id));
  assert.equal((await service.select(a.id,()=>{})).success,true);await js(diary,'window.diaryProfiles.refresh()');
  archiveRelease!();archiveGate=undefined;
  await until(diary,`document.getElementById('diary-archives-status').textContent.includes('1건을')`);
  assert.equal(await js(diary,'window.diaryProfiles.state().activeProfileId'),a.id);
  assert.deepEqual(await js(diary,`[document.getElementById('manual-seed-desc').value,document.querySelector('#diary-record-profile select').value]`),draftBeforeArchive);
  await js(diary,`document.getElementById('diary-archives-close').click()`);
  await diary.reload();await js(diary,'window.diaryProfiles.ready');
  await js(diary,`document.getElementById('diary-archives-open').click()`);
  await until(diary,`document.getElementById('diary-archives-list').textContent.includes('정리할 이전 프로필 기록이 없습니다.')`);
  await js(diary,`document.getElementById('diary-archives-close').click()`);
  const addGold=store.database.prepare(`INSERT INTO activity_logs(date,time,type,content,amount,source,profile_id,record_uuid)
    VALUES(?,'04:30:00','calc',?,500000,'automatic',?,?)`);
  addGold.run(date,db.GOLD_POUCH_DAILY_CONTENT,null,'ui-legacy-gold');
  addGold.run(date,db.GOLD_POUCH_DAILY_CONTENT,a.id,'ui-restored-gold');
  store.database.prepare('INSERT INTO profile_log_sync_state VALUES(?,?,?)').run(a.id,'ui-restored-gold',JSON.stringify({goldPouchSeedByDate:{[date]:{totalAmount:500000}}}));
  assert.equal(db.getMonthlySummary(month).legacyGoldReviewSeed,500000);
  await filter('all');
  await js(diary,'loadMonthData()');
  await until(diary,`currentSummary?.legacyGoldReviewSeed===500000 && !document.getElementById('monthly-legacy-gold-review').classList.contains('hidden')`);
  await js(diary,`selectDate(${JSON.stringify(date)},null)`);
  assert.match(await js(diary,"document.getElementById('daily-summary-area').textContent"),/확인 필요 금화/);
  assert.match(await js(diary,"document.getElementById('timeline-list').textContent"),/확인 필요/);
  assert.equal((await js(diary,`electronAPI.previewDiaryExport('${date}','${date}',{kind:'all'})`)).legacyGoldReviewSeed,500000);

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
