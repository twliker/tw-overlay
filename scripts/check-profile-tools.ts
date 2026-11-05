/** 제품 도구 HTML/preload/IPC/SQLite를 임시 userData에서 연결한다. */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {app,BrowserWindow} from 'electron';

const root=path.resolve(__dirname,'..'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-tools-'));
const output=path.join(root,'output/profile-tools');
app.setPath('userData',fixture);app.on('window-all-closed',() => {});
const built=(name:string) => require(path.join(root,'dist',name+'.js'));
const wait=(ms=30) => new Promise(resolve => setTimeout(resolve,ms));
const js=(win:BrowserWindow,code:string):Promise<any> => win.webContents.executeJavaScript(code);
async function until(win:BrowserWindow,code:string):Promise<void> {
  for (let n=0;n<200;n++) {if (await js(win,`Boolean(${code})`)) return;await wait();}
  throw new Error(`Timed out: ${code}`);
}
async function page(name:string,width=1000,height=800):Promise<BrowserWindow> {
  const win=new BrowserWindow({show:false,width,height,webPreferences:{preload:path.join(root,'dist/preload.js'),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(path.join(root,'dist',name));return win;
}
async function ready(win:BrowserWindow,id:string):Promise<void> {
  await until(win,`window.profileToolStorage?.profileId()===${JSON.stringify(id)} && window.profileToolStorage.flush()`);
  assert.equal(await js(win,'document.body.inert'),false);
}
async function capture(win:BrowserWindow,name:string):Promise<void> {
  await wait(150);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());
}
async function main():Promise<void> {
  await app.whenReady();fs.mkdirSync(output,{recursive:true});
  const cleanName=require('./parse-equipment').cleanEquipmentName;
  for(const prefix of ['프시키','아크론','이클립스'])for(const kind of ['물리력','마참력','마력','신성','참력','자력']) {
    const name=prefix+'의 '+kind;
    assert.equal(cleanName(name+' - 디펜시오 피해 감소 +20%'),name+' - 디펜시오');
    assert.equal(cleanName(name+' (공격력 +20%)'),name);
  }
  const config=built('modules/config'),diary=built('modules/diaryDb'),defaults=built('modules/constants').DEFAULT_CONFIG;
  const storage=built('modules/rendererStorageBackup');
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'dist/assets/data/buffs.json'),'utf8'));
  const key='tw-coefficient-calculator-profiles-v1';
  const values={buff_presets:JSON.stringify([{id:42,name:'기존 도핑',buffIds:[catalog[0].id]}]),
    buff_current_selection:JSON.stringify([catalog[0].id]),buff_active_preset_id:'42',
    [key]:JSON.stringify({default:{id:'default',name:'기존 계산',data:{stats:{stab:'111'},buffPreset:'42',currentType:'stab',mainCore:'none'}}}),
    [key+'_last']:'default','tw-coefficient-calculator-settings-v7final':JSON.stringify({stats:{stab:'9'}})};
  const bridge=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  await bridge.loadFile(path.join(root,'dist/storage-bridge.html'));
  await js(bridge,`Object.entries(${JSON.stringify(values)}).forEach(([key,value])=>localStorage.setItem(key,value));localStorage.setItem('evolution-calculator-history','공통 이력')`);
  bridge.destroy();
  assert.equal(config.saveConfirmed({...structuredClone(defaults),userServer:7,characterPresets:[{id:'A',name:'사냥 <A>'},{id:'B',name:'거래 B'}],selectedCharacterId:'A'}),true);
  const clock=new (built('modules/profileClock').ProfileClock)(async () => {throw new Error('offline fixture');});
  const prepared=await built('modules/profileStartup').initializePlayProfileStorage(clock),store=prepared.store;
  assert.equal(store.list().length,2);
  const a=store.list().find((p:any) => p.name==='사냥 <A>'),b=store.list().find((p:any) => p.name==='거래 B');
  assert.deepEqual(store.toolValues(a.id),values);assert.deepEqual(store.toolValues(b.id),values);
  const controller=built('modules/profileRecording').installProfileRecording(store,{openSelection:() => {}});
  const {service,replay}=controller.runtime;service.beginSession('tool-fixture');
  assert.equal((await service.select(a.id,replay)).success,true);
  built('modules/ipcHandlers').register();
  const coef=await page('coefficient-calculator.html'),buff=await page('buffs.html');
  await ready(coef,a.id);await ready(buff,a.id);
  assert.equal(await js(coef,`document.getElementById('stat-stab').value`),'111');
  await until(coef,'gearData.artifacts && Object.keys(gearData.artifacts).length>0');
  const artifactNames=await js(coef,'Object.values(gearData.artifacts).flat().map(item=>item.name)');
  for(const prefix of ['프시키','아크론','이클립스'])for(const kind of ['물리력','마참력','마력','신성','참력','자력']) {
    assert.equal(artifactNames.filter((name:string)=>name===prefix+'의 '+kind).length,1);
    assert.equal(artifactNames.filter((name:string)=>name===prefix+'의 '+kind+' - 디펜시오').length,1);
  }

  assert.equal(await js(coef,`document.querySelector('.profile-tool-context').textContent`),'입력 프로필: 사냥 <A>');
  assert.equal(await js(coef,`document.querySelector('.profile-tool-context a')`),null);
  await js(coef,`document.getElementById('stat-stab').value='333';document.getElementById('stat-stab').dispatchEvent(new Event('input',{bubbles:true}))`);
  const stats=(id:string) => JSON.parse(store.toolValues(id)[key]).default.data.stats.stab;
  assert.equal(stats(a.id),'333');assert.equal(stats(b.id),'111');
  await js(buff,`document.getElementById('begin-selected-preset-button').click();document.getElementById('preset-name').value='A 전용 도핑';document.getElementById('save-preset-button').click()`);
  await until(coef,`Array.from(document.querySelector('#buff-preset-select').options).some(o=>o.textContent.includes('A 전용 도핑'))`);
  assert.equal(JSON.parse(store.toolValues(b.id).buff_presets).length,1);
  const clone=store.create('설정 복사',16,a.id),empty=store.create('빈 설정',16);
  assert.deepEqual(store.toolValues(clone.id),store.toolValues(a.id));assert.deepEqual(store.toolValues(empty.id),{});
  store.migrateToolValues({[key]:'덮어쓰면 안 됨'});assert.equal(stats(a.id),'333');
  assert.deepEqual(await storage.readRendererStorage(Object.keys(values)),values,'이전 뒤 원본 file 저장소를 다시 쓰지 않는다');

  // 늦게 도착한 저장도 화면에 고정된 A로만 간다. 임의 키/다른 창/다른 token은 거부한다.
  const bound=await js(coef,'electronAPI.getProfileToolContext()');
  assert.equal(config.saveConfirmed({activePlayProfileId:b.id}),true);
  assert.equal((await js(coef,`electronAPI.writeProfileTool(${JSON.stringify(bound.token)},'buff_active_preset_id','null')`)).success,true);
  assert.equal(store.toolValues(a.id).buff_active_preset_id,'null');assert.equal(store.toolValues(b.id).buff_active_preset_id,'42');
  assert.equal((await js(coef,`electronAPI.writeProfileTool('bad','buff_presets','[]')`)).success,false);
  assert.equal((await js(coef,`electronAPI.writeProfileTool(${JSON.stringify(bound.token)},'volumeMaster','0')`)).success,false);
  const unauthorized=await page('storage-bridge.html');
  await assert.rejects(js(unauthorized,'electronAPI.getProfileToolContext()'),/지원하지 않는/);
  assert.equal((await js(unauthorized,`electronAPI.writeProfileTool(${JSON.stringify(bound.token)},'buff_presets','[]')`)).success,false);unauthorized.destroy();
  assert.equal(config.saveConfirmed({activePlayProfileId:a.id}),true);
  await coef.loadFile(path.join(root,'dist/coefficient-calculator.html'));await ready(coef,a.id);

  // 편집 중인 새 이름을 버리지 않고 전환을 취소하며 다른 창의 잠금도 풀린다.
  await js(buff,`document.getElementById('begin-selected-preset-button').click();document.getElementById('preset-name').value='아직 작성 중'`);
  assert.equal((await service.select(a.id,replay)).success,true,'같은 프로필 확인은 도구 초안을 방해하지 않는다');
  let result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/버프 백과/);
  assert.equal(config.load().activePlayProfileId,a.id);
  assert.equal(await js(buff,`document.getElementById('preset-name').value`),'아직 작성 중');
  assert.equal(await js(coef,'document.body.inert'),false);assert.equal(await js(buff,'document.body.inert'),false);
  await js(buff,`document.getElementById('cancel-preset-edit-button').click()`);
  await js(coef,`document.getElementById('btn-add-profile').click();document.getElementById('modal-input').value='작성 중인 계산 프리셋'`);
  result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/이름 입력/);
  assert.equal(await js(coef,`document.getElementById('modal-input').value`),'작성 중인 계산 프리셋');
  await js(coef,`document.getElementById('modal-cancel').click()`);

  // 자동 저장 이벤트 이전의 DOM 입력도 commit 전에 flush. 디스크 실패면 입력과 선택 보존.
  await js(coef,`document.getElementById('stat-stab').value='444'`);
  store.database.exec("CREATE TRIGGER reject_tools BEFORE INSERT ON profile_tools BEGIN SELECT RAISE(ABORT,'tool fixture failure');END");
  result=await service.select(b.id,replay);assert.equal(result.success,false);assert.match(result.error,/저장하지 못/);
  assert.equal(config.load().activePlayProfileId,a.id);assert.equal(stats(a.id),'333');
  assert.equal(await js(coef,`document.getElementById('stat-stab').value`),'444');
  assert.equal(await js(coef,'document.body.inert'),false);assert.equal(await js(buff,'document.body.inert'),false);
  store.database.exec('DROP TRIGGER reject_tools');
  assert.equal((await service.select(b.id,replay)).success,true);await ready(coef,b.id);await ready(buff,b.id);
  assert.equal(stats(a.id),'444');assert.equal(await js(coef,`document.getElementById('stat-stab').value`),'111');
  assert.equal(await js(coef,`Array.from(document.querySelector('#buff-preset-select').options).some(o=>o.textContent.includes('A 전용'))`),false);
  await js(coef,`document.getElementById('stat-stab').value='222';document.getElementById('stat-stab').dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(stats(b.id),'222');assert.equal(stats(a.id),'444');
  assert.equal((await service.select(a.id,replay)).success,true);await ready(coef,a.id);await ready(buff,a.id);
  assert.equal(await js(coef,`document.getElementById('stat-stab').value`),'444');
  assert.equal(await js(buff,`getPresets().some(p=>p.name==='A 전용 도핑')`),true);
  assert.equal(service.update(a.id,'표시 이름 <변경>',7).success,true);
  await until(coef,`document.querySelector('.profile-tool-context').textContent.includes('표시 이름 <변경>')`);
  await capture(coef,'coefficient-1000.png');await capture(buff,'buffs-1000.png');
  coef.setSize(800,600);buff.setSize(800,600);await capture(coef,'coefficient-800.png');await capture(buff,'buffs-800.png');
  for (const win of [coef,buff]) assert.equal(await js(win,`(()=>{const r=document.querySelector('.profile-tool-context').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && getComputedStyle(document.querySelector('.profile-tool-context')).fontSize==='14px'})()`),true);
  // 활성 프로필 삭제 뒤 이미 저장된 도구를 삭제된 소유자에게 다시 flush하지 않는다.
  assert.equal((await service.remove(a.id)).success,true);await ready(coef,b.id);await ready(buff,b.id);
  assert.equal(store.database.prepare('SELECT COUNT(*) n FROM profile_tools WHERE profile_id=?').get(a.id).n,0);
  assert.equal(stats(b.id),'222');
  coef.destroy();buff.destroy();controller.dispose();prepared.stopClock();assert.equal(config.flushPending(),true);assert.equal(diary.closeDb(),true);
  console.log('Profile tools: actual saved migration, per-profile inputs/buffs, frozen IPC owner, draft/failure-safe transitions, copy/delete and minimum-size UI passed.');
}
main().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
