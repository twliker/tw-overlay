/** Capture real renderer output for visual review without foreground desktop input. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import path = require('node:path');
import {BrowserWindow} from 'electron';

const pause=(ms=60)=>new Promise(resolve=>setTimeout(resolve,ms));
const js=(win:BrowserWindow,source:string)=>win.webContents.executeJavaScript(source);
async function until<T>(check:()=>T|Promise<T>,label:string):Promise<NonNullable<T>> {
  const deadline=Date.now()+6500;
  while(Date.now()<deadline) {const value=await check();if(value)return value as NonNullable<T>;await pause();}
  throw new Error(`화면 검수 대기 실패: ${label}`);
}
const page=(file:string)=>BrowserWindow.getAllWindows().find(win=>!win.isDestroyed() && win.webContents.getURL().split('?')[0].endsWith(`/${file}.html`));
type ReviewContext={wm:Record<string,(...args:unknown[])=>unknown>;runtime:{service:{status:()=>{selectionRequired:boolean};store:{database:{prepare:(sql:string)=>{get:()=>unknown}}}}};output:string;errors:Array<{kind:string;page:string;message:string}>};

export async function captureProductScreens({wm,runtime,output,errors}:ReviewContext):Promise<void> {
  const requested=new Set((process.argv.find(arg=>arg.startsWith('--screens='))?.slice('--screens='.length) || '').split(',').filter(Boolean));
  const dir=path.join(output,requested.size ? 'captures-focused' : 'captures');fs.mkdirSync(dir,{recursive:true});
  const screens:unknown[]=[],interactions:string[]=[],failures:Array<{screen:string;error:string}>=[];
  const write=()=>fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify({screens,interactions,failures,errors,desktopInput:false,remoteContent:false},null,2));
  async function loaded(file:string,open?:()=>unknown):Promise<BrowserWindow> {
    if(!page(file))open?.();
    return until(()=>{const win=page(file);return win&&!win.webContents.isLoadingMainFrame() ? win : undefined;},file);
  }
  async function capture(win:BrowserWindow,name:string):Promise<void> {
    await pause(160);
    await js(win,'new Promise(resolve=>{const fallback=setTimeout(resolve,400);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(fallback);resolve()}));})');
    const metrics=await js(win,`({title:document.title,width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,text:document.body.innerText.trim().slice(0,220)})`);
    const png=(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG();
    assert.ok(png.length>300,`empty capture ${name}`);
    fs.writeFileSync(path.join(dir,`${name}.png`),png);screens.push({name,...metrics});write();
  }
  async function check(name:string,work:()=>Promise<void>):Promise<void> {
    if(requested.size && !requested.has(name))return;
    try {await work();} catch(error) {failures.push({screen:name,error:String(error)});write();}
  }
  async function selectFixtureProfile(win:BrowserWindow):Promise<void> {
    await until(()=>js(win,`!!document.querySelector('[data-focus-key="use:profile-default"]')`),'검수용 프로필 사용 버튼');
    await js(win,`document.querySelector('[data-focus-key="use:profile-default"]').click()`);
    await until(()=>!runtime.service.status().selectionRequired,'선택 완료');
  }
  if(requested.size && !requested.has('profiles'))await selectFixtureProfile(await loaded('profiles'));
  await check('profiles',async()=>{
    const win=await loaded('profiles');
    await until(()=>js(win,"document.querySelectorAll('.profile-row').length===2"),'프로필 두 개');
    await capture(win,'profiles-640');win.setSize(560,400);await capture(win,'profiles-560');
    await js(win,"document.getElementById('new-profile').click()");await capture(win,'profiles-add-560');
    await js(win,"document.getElementById('close-editor').click();document.getElementById('reorder-profiles').click()");await capture(win,'profiles-reorder-560');
    await js(win,"document.getElementById('reorder-profiles').click();document.getElementById('pending-section').scrollIntoView({block:'start'});");await capture(win,'profiles-pending-560');
    await selectFixtureProfile(win);interactions.push('프로필 추가 폼·순서 모드 열기/닫기, 실제 사용 버튼으로 선택');
  });
  await check('contents-checker',async()=>{
    const win=await loaded('contents-checker',()=>wm.toggleContentsCheckerWindow());
    await until(()=>js(win,"document.querySelectorAll('[data-item-id]').length>10"),'기본 숙제 목록');await capture(win,'contents-checker-default');
    win.setSize(400,600);await capture(win,'contents-checker-400');
    await js(win,"document.getElementById('btn-edit').click();document.getElementById('new-item-name').value='UX 검수용 새 숙제';document.getElementById('new-item-category').value='검수용';document.getElementById('btn-add-item').scrollIntoView({block:'nearest'});");
    await capture(win,'contents-checker-edit-400');
    assert.equal(await js(win,'profileChecklist.submitEditor()'),true);
    await until(()=>js(win,"document.getElementById('custom-item-feedback').textContent.includes('UX 검수용 새 숙제')"),'숙제 추가 피드백');
    await pause(500);await capture(win,'contents-checker-added-400');
    const reach=await js(win,`(()=>{const row=[...document.querySelectorAll('[data-item-id]')].find(r=>r.innerText.includes('UX 검수용 새 숙제'));const r=row?.getBoundingClientRect(),w=document.querySelector('.matrix-wrapper'),f=document.getElementById('add-form');const hit=r&&document.elementFromPoint(r.left+10,r.top+r.height/2);return {reached:!!r && hit?.closest('[data-item-id]')===row,row:r?.toJSON(),wrapper:w.getBoundingClientRect().toJSON(),scroll:w.scrollTop,formScroll:f.scrollTop,status:document.getElementById('checklist-profile-status').textContent,hit:hit?.className,wide:[...document.querySelectorAll('body *')].filter(x=>x.getBoundingClientRect().right>innerWidth&&x.getBoundingClientRect().width>0).slice(0,12).map(x=>[x.id,x.className?.toString()])}})()`);
    fs.writeFileSync(path.join(dir,'checklist-layout.json'),JSON.stringify(reach,null,2));
    assert.equal(reach.reached,true,'추가된 숙제가 실제 보이는 위치까지 이동');
    assert.equal(await js(win,`(()=>{const close=document.querySelector('.win-close-btn');const r=close.getBoundingClientRect();return r.right<=innerWidth&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===close})()`),true,'400px 관리 모드에서 닫기 버튼 접근 가능');
    assert.equal(await js(win,"document.getElementById('checklist-profile-status').dataset.saveState"),'success');
    interactions.push('실제 기본 숙제 표시, 편집과 새 숙제 저장/피드백/행 이동, 400px 닫기 접근');
  });
  await check('diary',async()=>{
    const win=await loaded('diary',()=>wm.toggleDiaryWindow());await capture(win,'diary-default');win.setSize(900,650);
    await capture(win,'diary-900');
    await js(win,`document.getElementById('manual-seed-mode').value='expense';document.getElementById('manual-seed-mode').dispatchEvent(new Event('change'));document.getElementById('manual-seed-desc').value='UX 검수용 입장 지출';document.getElementById('manual-seed-amount').value='52800000';document.getElementById('manual-seed-add-btn').scrollIntoView({block:'center'});`);
    await capture(win,'diary-expense-before');
    await js(win,"document.getElementById('manual-seed-add-btn').click()");
    await until(()=>runtime.service.store.database.prepare("SELECT amount FROM activity_logs WHERE content LIKE '%UX 검수용 입장 지출%'").get(),'일지 지출 저장');
    const record=runtime.service.store.database.prepare("SELECT amount FROM activity_logs WHERE content LIKE '%UX 검수용 입장 지출%'").get() as {amount:number};
    assert.equal(record.amount,-52800000);await capture(win,'diary-expense-after');
    assert.equal(await js(win,`['current-month','monthly-total-loot-badge','monthly-total-seed-badge'].every(id=>{const el=document.getElementById(id),r=document.createRange();r.selectNodeContents(el);return r.getClientRects().length===1})`),true,'900px에서 월 제목과 수익 숫자가 한 줄씩 유지됨');
    interactions.push('수동 지출 모드·저장·음수 SEED DB 확인, 900px 월 제목/합계 줄바꿈 확인');
  });
  const screensToOpen:Array<[string,()=>unknown]>= [
    ['index',()=>wm.createMainWindow()],['dock',()=>wm.toggleDockWindow()],['update-notice',()=>wm.toggleUpdateNoticeWindow()],
    ['settings',()=>wm.toggleSettingsWindow()],['game-exit-reminder',()=>wm.showGameExitReminder()],['welcome-guide',()=>wm.toggleWelcomeGuideWindow()],
    ['coefficient-calculator',()=>wm.toggleCoefficientCalculatorWindow()],['magic-stone-calculator',()=>wm.toggleMagicStoneCalculatorWindow()],
    ['hunting-exp-calculator',()=>wm.toggleHuntingExpCalculatorWindow()],['evolution-calculator',()=>wm.toggleEvolutionCalculatorWindow()],
    ['thesis-core-calculator',()=>wm.toggleThesisCoreCalculatorWindow()],['relic-calculator',()=>wm.toggleRelicCalculatorWindow()],['stopwatch',()=>wm.toggleStopwatchWindow()],
    ['equipment-dic',()=>wm.toggleEquipmentDicWindow()],['abbreviation',()=>wm.toggleAbbreviationWindow()],['buffs',()=>wm.toggleBuffsWindow()],
    ['equipment-simulator',()=>wm.toggleEquipmentSimulatorWindow()],['siena-aura',()=>wm.toggleSienaAuraWindow()],['hunting-path-simulator',()=>wm.toggleHuntingPathSimulatorWindow()],
    ['lumina-corridor',()=>wm.toggleLuminaCorridorWindow()],['boss-settings',()=>wm.toggleBossSettingsWindow()],['xp-hud',()=>wm.toggleXpHudWindow()],
    ['buff-timer',()=>wm.toggleBuffTimerWindow()],['word-alarm',()=>wm.toggleWordAlarmWindow()],['custom-alert',()=>wm.toggleCustomAlertWindow()],
    ['discord-alarm',()=>wm.toggleDiscordAlarmWindow()],['scam-detector',()=>wm.toggleScamDetectorWindow()],['trade',()=>wm.toggleTradeWindow()],
    ['gallery',()=>wm.toggleGalleryWindow()],['shout-history',()=>wm.toggleShoutHistoryWindow()],['focused-chat',()=>wm.toggleFocusedChatWindow()],['eta-ranking',()=>wm.toggleEtaRankingWindow()],
    ['chat-overlay',()=>wm.toggleChatOverlayWindow()],['uniform-color',()=>wm.toggleUniformColorWindow()],['sword-enhance',()=>wm.toggleSwordEnhanceWindow()],
    ['qte-challenge',()=>wm.toggleQteChallengeWindow()],['overlay',()=>wm.toggleOverlay()],['splash',()=>wm.createSplashWindow()],['game-overlay',()=>wm.createGameOverlayWindow()],
  ];
  for(const [file,open] of screensToOpen) await check(file,async()=>{
    const win=await loaded(file,open);
    try {
      if(file==='settings')await until(()=>js(win,"document.getElementById('loading-overlay')?.classList.contains('fade-out')"),'설정 로딩 완료');
      if(file==='game-overlay') {
        win.setSize(1280,720);await pause(250);
        win.webContents.send('today-summary-config',{showTodaySummaryHud:true,todaySummaryCollapsed:false});
        await until(()=>js(win,"!document.getElementById('today-summary-hud')?.classList.contains('hidden')"),'HUD 렌더링');
      }
      if(file==='eta-ranking')await until(()=>js(win,"document.getElementById('ranking-list').textContent.includes('검색 결과가 없습니다.')"),'에타 빈 검색 결과');
      await capture(win,file);
      if(file==='settings') {
        win.setSize(800,600);await capture(win,'settings-800');
        for(const group of ['game','chat','alerts','system','about']) {
          await js(win,`document.querySelector('[data-settings-group="${group}"]').click()`);
          await until(()=>js(win,`document.querySelector('[data-settings-group="${group}"]').getAttribute('aria-current')==='page'`),`설정 ${group}`);
          await capture(win,`settings-${group}-800`);
          if(group==='system') {
            await js(win,"document.querySelector('[data-settings-route=\"system:1\"]').click()");
            await until(()=>js(win,"document.querySelector('[data-settings-route=\"system:1\"]').classList.contains('active')"),'데이터 관리 탭 강조');
            // A hidden window can keep an unpainted CSS transition. Inspect the settled frame.
            const tabs=await js(win,`(()=>{const tabs=[...document.querySelectorAll('.settings-context-item')];for(const tab of tabs){getComputedStyle(tab).backgroundColor;tab.getAnimations().forEach(animation=>animation.finish());}return tabs.map(tab=>({route:tab.dataset.settingsRoute,active:tab.classList.contains('active'),background:getComputedStyle(tab).backgroundColor}));})()`);
            assert.equal(tabs[1].active,true);assert.notEqual(tabs[1].background,tabs[0].background);
            fs.writeFileSync(path.join(dir,'settings-data-tab.json'),JSON.stringify(tabs,null,2));
            await capture(win,'settings-data-800');
          }
        }
        interactions.push('800×600 환경설정 주 메뉴 6개 전환');
      }
      if(file==='index') {
        assert.equal(errors.some(error=>error.page.endsWith('/index.html')&&error.message.includes("reading 'setAttribute'")),false,'메뉴 초기화 전 상태 이벤트가 오류를 내지 않는다');
        await until(()=>js(win,"document.getElementById('click-through-btn')?.classList.contains('text-green-400')"),'초기 마우스 투과 버튼 반영');
        interactions.push('사이드바 초기 마우스 투과 상태가 동적 메뉴에 반영됨');
      }
      if(file==='eta-ranking') {
        assert.equal(await js(win,"document.getElementById('last-update').textContent"),'갱신 시각 정보 없음');
        assert.equal(await js(win,"getComputedStyle(document.querySelector('#ranking-list > div')).opacity"),'1');
        interactions.push('에타 랭킹의 빈 결과·갱신 시각 안내 확인');
      }
      if(file==='game-exit-reminder') {
        await until(()=>js(win,"document.querySelectorAll('[role=tab]').length===2"),'종료 안내 탭');
        await js(win,"document.querySelectorAll('[role=tab]')[1].click()");
        assert.equal(await js(win,"document.querySelectorAll('[role=tab]')[1].getAttribute('aria-selected')"),'true');
        await capture(win,'game-exit-reminder-second-profile');interactions.push('게임 종료 안내에서 보조 프로필의 남은 숙제로 전환');
      }
    } finally {if(!['index','dock'].includes(file) && !win.isDestroyed())win.destroy();}
  });
  for(const sub of [1,2]) await check(`chat-overlay-sub${sub}`,async()=>{
    const win=await loaded('chat-overlay',()=>wm.toggleSubWindow(sub));
    try {await capture(win,`chat-overlay-sub${sub}`);} finally {if(!win.isDestroyed())win.destroy();}
  });
  write();console.log(`Rendered review: ${screens.length} captures, ${interactions.length} flows, ${failures.length} unfinished checks`);
}
