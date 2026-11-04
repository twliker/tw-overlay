import {app} from 'electron';
import * as config from './config';
import * as diary from './diaryDb';
import {ApplicationData} from './applicationData';
import {ProfileClock} from './profileClock';
import {DEFAULT_CONFIG} from './constants';
import {getPlayProfileDeviceId} from './profileBackupRestore';
import {pauseForPlayProfiles} from './cloudSyncManager';
import {readRendererStorage} from './rendererStorageBackup';
import {PROFILE_TOOL_KEYS} from '../shared/profileTools';
import {loadDefaultItems} from './contentsChecker';

export interface PreparedPlayProfileStorage {store:ApplicationData;clock:ProfileClock;stopClock():void}
let initialization:Promise<PreparedPlayProfileStorage> | null=null;

/** 부팅 조립 계약 — 단일 인스턴스 잠금/중단 복원 복구 후, UI·파서·타이머 시작 전에 호출한다.
 * 옛 전송을 배출한 뒤 지연 저장을 확정하고, 기존 일지를 닫고 이전·공유 연결·설정 projection을
 * 설치한다. 새 실행은 항상 선택 대기다. 실패는 부팅 실패로 전달하며 diary.db로 폴백하지 않는다.
 * runtime/gate/도구 격리를 준비한 호출자만 반환 후 기록을 시작할 수 있다.
 * main은 profileApplication을 통해 조립하며 이 함수만으로 파서나 창을 시작하지 않는다.
 */
export function initializePlayProfileStorage(clock=new ProfileClock(),options?:{freshInstall:boolean}):Promise<PreparedPlayProfileStorage> {
  if (initialization) return initialization;
  initialization=(async () => {
    await pauseForPlayProfiles();
    if (!config.flushPending()) throw new Error('프로필 이전 전 설정을 저장하지 못했습니다.');
    const legacy=config.load(),directory=app.getPath('userData');
    // DEFAULT_CONFIG의 숙제 배열은 빈 초기값이다. 프로필 생성/복구에는 검증한 배포 목록을 사용한다.
    const defaultItems=loadDefaultItems();
    if (!defaultItems) throw new Error('프로필 기본 숙제 목록을 불러오지 못했습니다. 기존 데이터를 보존했습니다.');
    const defaults={...DEFAULT_CONFIG,contentsCheckerItems:defaultItems};
    if (options?.freshInstall) {legacy.characterPresets=[];legacy.selectedCharacterId=undefined;}
    const deviceId=getPlayProfileDeviceId(directory,legacy.profileDeviceId);
    if (!diary.closeDb()) throw new Error('프로필 이전 전 일지 기록을 저장하지 못했습니다.');
    // 재실행 시 DB가 중단된 JSON commit을 복구할 수 있다. 그 뒤에 캐시를 다시 읽는다.
    const reload=config.beginExternalRestore();
    let store:ApplicationData | undefined;
    try {
      store=await ApplicationData.initialize({directory,deviceId,defaults,clock:() => clock.now()},legacy,{value:config.getLegacyUserServer()});
      reload();
      diary.connectApplicationData(store);
      config.installPersistence({read:value => store!.readConfiguration(value),commit:(value,previous) => store!.commitConfiguration(value,previous)});
      if (!store.database.prepare("SELECT 1 FROM app_meta WHERE key='legacy_profile_tools_migrated'").get()) store.migrateToolValues(await readRendererStorage(PROFILE_TOOL_KEYS));
      if (!config.saveConfirmed({profileDeviceId:deviceId,profileSelectionRequired:true,profileSessionId:undefined})) throw new Error('프로필 선택 대기 상태를 저장하지 못했습니다.');
      store.setRecordContext(null,null);
    } catch (error) {
      store?.close();
      throw new Error(`프로필 저장소 준비에 실패했습니다. 원본과 backups 폴더를 보존했습니다. ${String(error)}`);
    }
    // 인터넷 연결은 실행 조건이 아니다. 실패한 변경은 unverified로 저장한다.
    void clock.refresh();
    const timer=setInterval(() => {void clock.refresh();},30*60*1000);timer.unref();
    return {store,clock,stopClock:() => clearInterval(timer)};
  })();
  return initialization;
}
