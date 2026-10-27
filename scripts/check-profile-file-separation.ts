/**
 * 프로필 물리 파일 분리 구조 (File-per-Profile Architecture) 및 리셋 전수 검증
 *
 * 검증 항목:
 * 1. manifest.json과 data/{profileId}.json 물리 파일 생성 및 독립 격리 확인
 * 2. 한 프로필의 숙제 완료가 타 프로필의 파일에 전혀 영향을 미치지 않음 (오염 차단)
 * 3. 새 프로필 생성 / 복제 시 타 프로필의 완료 상태를 훔치지 않음
 * 4. 활성 프로필 외의 비활성 프로필(부계)도 checkReset() 호출 시 자정 리셋으로 0회 초기화됨
 * 5. 프로필 전환(switchProfile) 시 지난 숙제의 자동 리셋 및 config 동기화
 * 6. 레거시 profiles.json 단일 파일 및 꼬인 completedState의 1회성 자동 분리 마이그레이션 & 정제
 */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app } from 'electron';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-profile-separation-'));
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const root = path.resolve(__dirname, '..');
const built = (file: string) => require(path.join(root, 'dist', file));

async function main(): Promise<void> {
  console.log('--- 프로필 물리 파일 분리 및 전수 리셋 정밀 검증 시작 ---');

  const config = built('modules/config');
  const profileManager = built('modules/profileManager');
  const checker = built('modules/contentsChecker');

  try {
    // ── 검증 1: 초기 생성 시 manifest.json 및 data/{profileId}.json 물리 파일 존재 확인 ──
    console.log('[1/6] 매니페스트 및 독립 데이터 파일 물리 구조 검증');
    const store = profileManager.initProfileStore();
    const manifestPath = profileManager.getManifestFilePath();
    const profileDataDir = profileManager.getProfileDataDir();

    assert.strictEqual(fs.existsSync(manifestPath), true, 'manifest.json 파일이 존재해야 합니다.');
    assert.strictEqual(fs.existsSync(profileDataDir), true, 'profiles/data 디렉터리가 존재해야 합니다.');

    const initialProfiles = profileManager.getAllProfiles();
    assert.strictEqual(initialProfiles.length >= 1, true);
    const mainProfile = initialProfiles[0];
    const mainDataPath = profileManager.getProfileDataFilePath(mainProfile.meta.id);
    assert.strictEqual(fs.existsSync(mainDataPath), true, '활성 프로필의 data/{profileId}.json 파일이 존재해야 합니다.');

    // ── 검증 2: 부계정 프로필 생성 및 숙제 데이터 물리 격리 검증 ──
    console.log('[2/6] 프로필 간 숙제 데이터 물리 격리 및 오염 차단 검증');
    const subProfile = profileManager.createProfile({ name: '부계정-루시안' });
    const subDataPath = profileManager.getProfileDataFilePath(subProfile.meta.id);
    assert.strictEqual(fs.existsSync(subDataPath), true, '새 부계정의 data/{profileId}.json 파일이 존재해야 합니다.');

    const testHwId = 'daily-test-isolation-hw';
    const testItemsForMain = [
      {
        id: testHwId,
        name: '격리 테스트 던전',
        category: '일일던전',
        resetRule: { type: 'daily', hour: 0 },
        maxCount: 1,
        isVisible: true,
        completedState: {
          [mainProfile.meta.id]: { currentCount: 1, isCompleted: true, lastCompletedAt: Date.now() }
        }
      }
    ];

    // 본계정 숙제 완료 저장
    profileManager.updateProfileContentsItems(mainProfile.meta.id, testItemsForMain);

    // 부계정 파일 읽기 -> 본계정의 완료 상태가 부계정 파일에 전혀 존재하지 않아야 함
    const subFileContent = JSON.parse(fs.readFileSync(subDataPath, 'utf-8'));
    const subItem = subFileContent.contentsCheckerItems?.find((i: any) => i.id === testHwId);
    if (subItem) {
      assert.strictEqual(subItem.completedState?.[mainProfile.meta.id], undefined, '부계정 파일에 본계정 ID 키가 오염되어 들어가면 안 됩니다.');
      assert.strictEqual(subItem.completedState?.[subProfile.meta.id]?.isCompleted, false, '부계정의 숙제는 미완료 상태여야 합니다.');
    }

    // ── 검증 3: 프로필 복제 시 타 프로필 완료 상태 도용/복제 차단 검증 ──
    console.log('[3/6] 프로필 복제(Duplicate) 시 타 프로필 완료 상태 미승계(0 초기화) 검증');
    const dupProfile = profileManager.duplicateProfile(mainProfile.meta.id, '본계정 복제본');
    assert.notStrictEqual(dupProfile, null);
    const dupDataPath = profileManager.getProfileDataFilePath(dupProfile!.meta.id);
    const dupFileContent = JSON.parse(fs.readFileSync(dupDataPath, 'utf-8'));
    const dupItem = dupFileContent.contentsCheckerItems?.find((i: any) => i.id === testHwId);
    assert.notStrictEqual(dupItem, undefined);
    assert.strictEqual(dupItem.completedState?.[mainProfile.meta.id], undefined, '복제 프로필에 원본 프로필의 ID 키가 복제되면 안 됩니다.');
    assert.strictEqual(dupItem.completedState?.[dupProfile!.meta.id]?.isCompleted, false, '복제된 프로필의 숙제 상태는 0으로 초기화되어야 합니다.');
    assert.strictEqual(dupItem.completedState?.[dupProfile!.meta.id]?.currentCount, 0);

    // ── 검증 4: 비활성 프로필(부계)의 일일 숙제 자정 리셋 검증 ──
    console.log('[4/6] 비활성 프로필(부계정)의 일일 숙제 자정 리셋 전수 검사 검증');
    // 부계정의 숙제를 3일 전에 완료된 것으로 설정
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const subItemsWithOldDone = [
      {
        id: testHwId,
        name: '격리 테스트 던전',
        category: '일일던전',
        resetRule: { type: 'daily', hour: 0 },
        maxCount: 1,
        isVisible: true,
        completedState: {
          [subProfile.meta.id]: { currentCount: 1, isCompleted: true, lastCompletedAt: threeDaysAgo }
        }
      }
    ];
    profileManager.updateProfileContentsItems(subProfile.meta.id, subItemsWithOldDone);

    // 현재 활성 프로필은 mainProfile인 상태에서 checkReset 실행
    assert.strictEqual(profileManager.getActiveProfileId(), mainProfile.meta.id);
    const resetOccurred = checker.checkReset();
    assert.strictEqual(resetOccurred, true, '비활성 프로필 숙제가 리셋되어 true를 반환해야 합니다.');

    // 부계정 파일 확인 -> 자정 리셋으로 완료 상태가 false, currentCount가 0으로 초기화되었는지 검증
    const subAfterReset = JSON.parse(fs.readFileSync(subDataPath, 'utf-8'));
    const subItemAfterReset = subAfterReset.contentsCheckerItems?.find((i: any) => i.id === testHwId);
    assert.strictEqual(subItemAfterReset?.completedState?.[subProfile.meta.id]?.isCompleted, false, '부계정 숙제가 자정 리셋되어 isCompleted: false여야 합니다.');
    assert.strictEqual(subItemAfterReset?.completedState?.[subProfile.meta.id]?.currentCount, 0, '부계정 숙제가 자정 리셋되어 currentCount: 0이어야 합니다.');

    // ── 검증 5: switchProfile 프로필 전환 시 사전 리셋 및 config 완벽 동기화 검증 ──
    console.log('[5/6] switchProfile 프로필 전환 시 숙제 만료 검사 및 config 동기화 검증');
    const switchTarget = profileManager.createProfile({ name: '전환 테스트용' });
    const switchTargetItems = [
      {
        id: 'daily-switch-test',
        name: '전환 테스트 숙제',
        category: '일일',
        resetRule: { type: 'daily', hour: 0 },
        maxCount: 2,
        isVisible: true,
        completedState: {
          [switchTarget.meta.id]: { currentCount: 2, isCompleted: true, lastCompletedAt: threeDaysAgo }
        }
      }
    ];
    profileManager.updateProfileContentsItems(switchTarget.meta.id, switchTargetItems);

    // 전환 실행
    const switchSuccess = await profileManager.switchProfile(switchTarget.meta.id);
    assert.strictEqual(switchSuccess, true);
    assert.strictEqual(profileManager.getActiveProfileId(), switchTarget.meta.id);

    // config에 마운트된 숙제 상태 확인 -> 전환 시 즉시 리셋되어 currentCount: 0, isCompleted: false여야 함
    const currentCfg = config.load();
    assert.strictEqual(currentCfg.activeProfileId, switchTarget.meta.id);
    assert.strictEqual(currentCfg.selectedCharacterId, switchTarget.meta.id);
    const switchedItem = currentCfg.contentsCheckerItems?.find((i: any) => i.id === 'daily-switch-test');
    assert.strictEqual(switchedItem?.completedState?.[switchTarget.meta.id]?.isCompleted, false, '전환된 프로필의 과거 완료 숙제가 즉시 리셋되어야 합니다.');
    assert.strictEqual(switchedItem?.completedState?.[switchTarget.meta.id]?.currentCount, 0);

    // ── 검증 6: 레거시 profiles.json 단일 파일 및 꼬인 completedState 1회성 자동 분리 마이그레이션 검증 ──
    console.log('[6/6] 레거시 profiles.json 및 꼬인 completedState 1회성 마이그레이션 검증');
    const migrationFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-migration-test-'));
    app.setPath('userData', migrationFixture);

    const legacyProfilesDir = path.join(migrationFixture, 'profiles');
    fs.mkdirSync(legacyProfilesDir, { recursive: true });

    // 사용자의 실제 PC에서 발생했던 꼬인 데이터 형태 재현:
    // 본계정(profile-char-main)과 부계정(profile-aafab344)에 서로의 키가 섞여 있고 완료 상태가 복제된 데이터
    const legacyStorePayload = {
      version: 1,
      activeProfileId: 'profile-aafab344',
      profiles: [
        {
          meta: {
            id: 'profile-char-main',
            name: '본캐',
            avatarUrl: 'preset:boris',
            createdAt: 1000,
            updatedAt: 1000
          },
          contentsCheckerItems: [
            {
              id: 'daily-eclipse-boss',
              name: '이클립스 보스전',
              category: '일일던전',
              resetRule: { type: 'daily', hour: 0 },
              completedState: {
                'profile-char-main': { currentCount: 1, isCompleted: true },
                'profile-aafab344': { currentCount: 1, isCompleted: true } // 본계정에 부계정 키가 오염됨
              }
            }
          ],
          settings: {}
        },
        {
          meta: {
            id: 'profile-aafab344',
            name: '부계정1',
            avatarUrl: 'preset:boris',
            createdAt: 2000,
            updatedAt: 2000
          },
          contentsCheckerItems: [
            {
              id: 'daily-eclipse-boss',
              name: '이클립스 보스전',
              category: '일일던전',
              resetRule: { type: 'daily', hour: 0 },
              completedState: {
                'profile-char-main': { currentCount: 1, isCompleted: true }, // 부계정에 본계정 키가 오염됨
                'profile-aafab344': { currentCount: 0, isCompleted: false }
              }
            }
          ],
          settings: {}
        }
      ],
      showOnGameLaunch: true,
      showOnAppLaunch: true
    };

    fs.writeFileSync(path.join(legacyProfilesDir, 'profiles.json'), JSON.stringify(legacyStorePayload, null, 2), 'utf-8');

    // 새 세션으로 profileManager 초기화 실행 -> 마이그레이션 트리거
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'profileManager'))];
    const newProfileManager = require(path.join(root, 'dist', 'modules', 'profileManager'));
    newProfileManager.initProfileStore();

    // 검증: manifest.json 생성 확인
    const migratedManifestPath = path.join(legacyProfilesDir, 'manifest.json');
    assert.strictEqual(fs.existsSync(migratedManifestPath), true, '마이그레이션 후 manifest.json이 생성되어야 합니다.');

    // 검증: profiles.json.bak 백업 파일 생성 확인
    assert.strictEqual(fs.existsSync(path.join(legacyProfilesDir, 'profiles.json.bak')), true, '기존 profiles.json이 profiles.json.bak으로 백업되어야 합니다.');

    // 검증: 각 프로필의 data 파일이 분리 생성되고, 타 프로필 키가 깨끗하게 정제되었는지 확인
    const mainMigratedData = JSON.parse(fs.readFileSync(path.join(legacyProfilesDir, 'data', 'profile-char-main.json'), 'utf-8'));
    const subMigratedData = JSON.parse(fs.readFileSync(path.join(legacyProfilesDir, 'data', 'profile-aafab344.json'), 'utf-8'));

    assert.strictEqual(mainMigratedData.contentsCheckerItems[0].completedState['profile-aafab344'], undefined, '본계정 파일에서 부계정 오염 키가 제거되어야 합니다.');
    assert.strictEqual(mainMigratedData.contentsCheckerItems[0].completedState['profile-char-main'].isCompleted, true);

    assert.strictEqual(subMigratedData.contentsCheckerItems[0].completedState['profile-char-main'], undefined, '부계정 파일에서 본계정 오염 키가 제거되어야 합니다.');
    assert.strictEqual(subMigratedData.contentsCheckerItems[0].completedState['profile-aafab344'].isCompleted, false);

    // ── 검증 7: 본계+부계 실기 게임플레이 및 재시작 엔드투엔드(E2E) 시뮬레이션 검증 ──
    console.log('[7/7] 본계+부계 실기 게임플레이 및 재시작 엔드투엔드(E2E) 검증');
    const e2eFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-e2e-profile-'));
    app.setPath('userData', e2eFixture);

    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'profileManager'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'contentsChecker'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'config'))];

    const e2eConfig = require(path.join(root, 'dist', 'modules', 'config'));
    const e2ePM = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const e2eChecker = require(path.join(root, 'dist', 'modules', 'contentsChecker'));

    // 초기화: 본계 생성
    e2ePM.initProfileStore();
    e2eChecker.init();
    const e2eMain = e2ePM.getActiveProfile();

    // 부계 추가
    const e2eSub = e2ePM.createProfile({ name: 'E2E 부계정' });

    // 부계정으로 전환
    await e2ePM.switchProfile(e2eSub.meta.id);
    assert.strictEqual(e2ePM.getActiveProfileId(), e2eSub.meta.id);
    assert.strictEqual(e2eConfig.load().activeProfileId, e2eSub.meta.id);

    // E2E 1: 부계정 활성 상태에서 UI 클릭으로 숙제 토글 (characterId 파라미터 없이 호출)
    const testItemId = 'weekly-mur-sylvan';
    e2eChecker.toggleItem(testItemId);

    // 검증: 부계정에는 완료가 저장되고, 본계정에는 절대 완료가 들어가지 않아야 함
    const subAfterToggle = e2ePM.getProfileById(e2eSub.meta.id);
    const mainAfterToggle = e2ePM.getProfileById(e2eMain.meta.id);
    assert.strictEqual(subAfterToggle.contentsCheckerItems.find((i: any) => i.id === testItemId)?.completedState[e2eSub.meta.id]?.isCompleted, true, '부계정 숙제가 완료 처리되어야 합니다.');
    assert.strictEqual(Boolean(mainAfterToggle.contentsCheckerItems.find((i: any) => i.id === testItemId)?.completedState[e2eMain.meta.id]?.isCompleted), false, '본계정 숙제는 완료 처리되면 안 됩니다.');

    // E2E 2: 부계정 플레이 중 게임 채팅 로그 실시간 클리어 감지
    const logHwId = 'weekly-shinjo-nest';
    e2eChecker.queuePendingHomework(logHwId, 7, false, 'evt-shinjo-clear', Date.now());

    // 검증: 게임 로그 완료가 본계정으로 가지 않고 부계정에 즉시 반영되어야 함
    const subAfterLog = e2ePM.getProfileById(e2eSub.meta.id);
    const mainAfterLog = e2ePM.getProfileById(e2eMain.meta.id);
    assert.strictEqual(subAfterLog.contentsCheckerItems.find((i: any) => i.id === logHwId)?.completedState[e2eSub.meta.id]?.isCompleted, true, '게임 로그가 현재 플레이 중인 부계정에 즉시 반영되어야 합니다.');
    assert.strictEqual(Boolean(mainAfterLog.contentsCheckerItems.find((i: any) => i.id === logHwId)?.completedState[e2eMain.meta.id]?.isCompleted), false, '본계정으로 게임 로그가 가로채이면 안 됩니다.');

    // E2E 3: 앱 재시작 시뮬레이션
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'profileManager'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'contentsChecker'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'config'))];

    const restartPM = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const restartChecker = require(path.join(root, 'dist', 'modules', 'contentsChecker'));

    restartPM.initProfileStore();
    restartChecker.init();

    // 검증: 껐다 켜도 부계정이 여전히 활성 프로필이고, 방금 완료한 숙제들이 그대로 유지되어야 함
    assert.strictEqual(restartPM.getActiveProfileId(), e2eSub.meta.id, '재시작 후에도 직전 활성 프로필인 부계정이 유지되어야 합니다.');
    const restartSub = restartPM.getActiveProfile();
    assert.strictEqual(restartSub.contentsCheckerItems.find((i: any) => i.id === testItemId)?.completedState[e2eSub.meta.id]?.isCompleted, true, '재시작 후 부계정의 UI 토글 숙제가 보존되어야 합니다.');
    assert.strictEqual(restartSub.contentsCheckerItems.find((i: any) => i.id === logHwId)?.completedState[e2eSub.meta.id]?.isCompleted, true, '재시작 후 부계정의 게임 로그 숙제가 보존되어야 합니다.');

    try { fs.rmSync(e2eFixture, { recursive: true, force: true }); } catch (_) {}
    console.log('✅ 프로필 물리 파일 분리 및 실기 E2E 전수 검증 ALL PASS!');
  } finally {
    try {
      fs.rmSync(fixture, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ 검증 실패:', err);
  process.exit(1);
});
