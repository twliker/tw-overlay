/** 실제 windowManager의 표시 전 좌표 해석을 검사한다. 게임/디스플레이 경계만 대역으로 제공한다. */
import assert=require('node:assert/strict');
import fs=require('node:fs');
import os=require('node:os');
import path=require('node:path');
import vm=require('node:vm');
import {createRequire} from 'node:module';
import * as electron from 'electron';
const {app}=electron,root=path.resolve(__dirname,'..');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'tw-profile-placement-')));
app.on('window-all-closed',()=>{});
async function main():Promise<void> {
  await app.whenReady();
  const primary={x:0,y:0,width:2560,height:1400};
  let current:any,converted:any,workArea=primary,conversions=0;
  const display=()=>({bounds:workArea,workArea,workAreaSize:{width:workArea.width,height:workArea.height}});
  const filename=path.join(root,'dist/modules/windowManager.js'),original=createRequire(filename),module={exports:{} as any};
  const dependencies:Record<string,any>={
    electron:{...electron,screen:{getPrimaryDisplay:()=>({...display(),workArea:primary}),getDisplayMatching:()=>display(),getDisplayNearestPoint:()=>display(),getAllDisplays:()=>[display()],on(){},
      screenToDipRect:(parent:unknown,physical:unknown)=>{assert.equal(parent,null,'사이드바 모니터가 아닌 게임 HWND 좌표의 DPI를 사용');assert.equal(physical,current);conversions++;return converted;}}},
    './tracker':{queryGameRect:async()=>{if(current instanceof Error)throw current;return current;},canAutomaticallyRestoreGameFocus:()=>false},
    './galleryMonitor':{},'./tradeMonitor':{},'./bossNotifier':{},'./tray':{},'./buffTimerManager':{buffTimerManager:{}},'./contentsChecker':{},
  };
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){'+fs.readFileSync(filename,'utf8')+'\nexports.__profilePosition=resolveProfileWindowPosition;exports.__centerProfile=win=>{windowRegistry.profiles.ref=win;centeredProfileWindows.add(win)};exports.__syncProfile=anchor=>resolveManagedWindowPosition("profiles",anchor,windowRegistry.profiles);exports.__dragProfile=(position,anchor)=>saveUserWindowPosition("profiles",position,anchor);\n})',{filename})(module.exports,
    (key:string)=>Object.prototype.hasOwnProperty.call(dependencies,key) ? dependencies[key] : original(key),module,filename,path.dirname(filename));
  let destroyed=false;
  const win={isDestroyed:()=>destroyed,getBounds:()=>({x:15,y:25,width:820,height:680})};
  const resolve=module.exports.__profilePosition as (win:unknown)=>Promise<{x:number;y:number} | undefined>;
  const cases=[
    {name:'게임 위치/크기',raw:{x:640,y:336,width:1280,height:720},dip:{x:640,y:336,width:1280,height:720},area:primary,expected:{x:870,y:356}},
    {name:'왼쪽 모니터 200% DPI',raw:{x:-3600,y:200,width:2560,height:1440},dip:{x:-1800,y:100,width:1280,height:720},area:{x:-1920,y:0,width:1920,height:1040},expected:{x:-1570,y:120}},
    {name:'위쪽 모니터',raw:{x:100,y:-1000,width:1280,height:720},dip:{x:100,y:-1000,width:1280,height:720},area:{x:0,y:-1080,width:1920,height:1040},expected:{x:330,y:-980}},
    {name:'부분 이탈한 게임',raw:{x:2500,y:1300,width:800,height:600},dip:{x:2500,y:1300,width:800,height:600},area:primary,expected:{x:1740,y:720}},
    {name:'선택창보다 작은 게임',raw:{x:0,y:0,width:640,height:480},dip:{x:0,y:0,width:640,height:480},area:primary,expected:{x:0,y:0}},
  ];
  for(const test of cases) {current=test.raw;converted=test.dip;workArea=test.area;conversions=0;assert.deepEqual(await resolve(win),test.expected,test.name);assert.equal(conversions,1);}
  workArea=primary;
  for(const raw of [null,{notRunning:true},new Error('fixture query failed')]) {
    current=raw;conversions=0;assert.deepEqual(await resolve(win),{x:870,y:360},'미실행/최소화/조회 실패는 작업 영역 fallback');assert.equal(conversions,0);
  }
  const config=original('./config'),anchor=cases[0].dip;
  config.saveImmediate({followGameWindow:false,fixedWindowPositionsActive:true,fixedWindowPositions:{profiles:{x:15,y:25}}});
  module.exports.__centerProfile(win);assert.deepEqual(module.exports.__syncProfile(anchor),{x:870,y:356},'저장 위치/고정 배치가 최초 중앙 위치를 덮어쓰지 않음');
  module.exports.__dragProfile({x:1000,y:500},anchor);
  assert.deepEqual(module.exports.__syncProfile(anchor),{x:1000,y:500},'사용자가 옮긴 뒤에는 중앙으로 강제 복귀하지 않음');
  module.exports.__centerProfile(win);assert.deepEqual(module.exports.__syncProfile(anchor),{x:870,y:356},'다시 열면 저장된 드래그 위치보다 게임 중앙 우선');
  current=cases[0].raw;converted=cases[0].dip;destroyed=true;assert.equal(await resolve(win),undefined,'대기 중 닫힌 창을 다시 표시하지 않음');
  console.log('PASS profile placement: production resolver, fresh game before first poll, game center, negative monitors, DPI conversion, work-area clamp, no-game/minimized/failure and destroyed window.');
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
