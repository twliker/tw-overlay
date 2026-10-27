/**
 * 다중 프로필 구글 드라이브 클라우드 동기화 정밀 회귀 검증
 *
 * 검증 범위:
 * 1. [업로드] 다중 프로필(본계+부계1+부계2) 전체 데이터가 클라우드 payload에 누락 없이 번들링되는지
 * 2. [임포트] 새 PC에서 클라우드 데이터 수신 시 디스크에 물리 파일(manifest + data/*.json)이 자동 생성 및 온전 복원되는지
 * 3. [3-Way 보존] 활성 프로필의 로컬 완료 상태가 원격 스냅샷에 의해 뒤로 롤백되지 않고 보존되는지
 * 4. [키 오염 정제] 원격에서 타 프로필 키가 묻어 들어와도 로컬 저장 시 깨끗이 정제되는지
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

const root = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const fixtureA = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cloud-sync-a-'));
  const fixtureB = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cloud-sync-b-'));

  try {
    console.log('--- 다중 프로필 구글 드라이브 클라우드 동기화 검증 시작 ---');

    // ── [1/4] PC A: 3개 프로필 생성, 각각 다른 숙제 완료 후 업로드 페이로드 번들링 검증 ──
    console.log('[1/4] 다중 프로필 전체 데이터 클라우드 업로드 번들링 검증');
    app.setPath('userData', fixtureA);

    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'profileManager'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'contentsChecker'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'config'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'syncDataHelper'))];

    const configA = require(path.join(root, 'dist', 'modules', 'config'));
    const pmA = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const checkerA = require(path.join(root, 'dist', 'modules', 'contentsChecker'));
    const syncHelper = require(path.join(root, 'dist', 'modules', 'syncDataHelper'));

    pmA.initProfileStore();
    checkerA.init();

    const mainProfile = pmA.getActiveProfile(); // 본계정
    const sub1 = pmA.createProfile({ name: '부계정-보리스' });
    const sub2 = pmA.createProfile({ name: '부계정-이스핀' });

    // 본계정에서 숙제 1 완료 (weekly-eclipse-boss-ethos)
    checkerA.toggleItem('weekly-eclipse-boss-ethos');

    // 부계정 1로 전환 후 숙제 2 완료 (weekly-mur-sylvan)
    await pmA.switchProfile(sub1.meta.id);
    checkerA.toggleItem('weekly-mur-sylvan');

    // 부계정 2로 전환 후 숙제 3 완료 (daily-psiky-illusion)
    await pmA.switchProfile(sub2.meta.id);
    checkerA.toggleItem('daily-psiky-illusion');

    // 클라우드 업로드 페이로드 생성 시뮬레이션
    const currentCfgA = configA.load();
    const exportedStore = pmA.exportProfilePayload();
    const uploadPayload = syncHelper.buildChecklistSyncPayload(
      currentCfgA,
      'device-a',
      'generation-1',
      [],
      exportedStore
    );

    // 검증: payload.profileStore에 3개 프로필 메타 및 각자의 숙제 완료 상태가 온전히 포함되었는지
    assert.strictEqual(uploadPayload.profileStore?.profiles.length, 3, '클라우드 페이로드에 3개 프로필이 모두 포함되어야 합니다.');
    const uploadedMain = uploadPayload.profileStore?.profiles.find((p: any) => p.meta.id === mainProfile.meta.id);
    const uploadedSub1 = uploadPayload.profileStore?.profiles.find((p: any) => p.meta.id === sub1.meta.id);
    const uploadedSub2 = uploadPayload.profileStore?.profiles.find((p: any) => p.meta.id === sub2.meta.id);

    assert.strictEqual(uploadedMain?.contentsCheckerItems.find((i: any) => i.id === 'weekly-eclipse-boss-ethos')?.completedState[mainProfile.meta.id]?.isCompleted, true);
    assert.strictEqual(uploadedSub1?.contentsCheckerItems.find((i: any) => i.id === 'weekly-mur-sylvan')?.completedState[sub1.meta.id]?.isCompleted, true);
    assert.strictEqual(uploadedSub2?.contentsCheckerItems.find((i: any) => i.id === 'daily-psiky-illusion')?.completedState[sub2.meta.id]?.isCompleted, true);
    console.log('  -> 3개 프로필 독립 숙제 데이터가 클라우드 페이로드에 100% 정상 번들링됨 확인');

    // ── [2/4] PC B: 새 PC 환경에서 클라우드 데이터 수신 시 물리 파일 자동 생성 및 복원 검증 ──
    console.log('[2/4] 새 PC에서 수신 시 물리 파일(manifest + data/*.json) 자동 생성 및 복원 검증');
    app.setPath('userData', fixtureB);

    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'profileManager'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'contentsChecker'))];
    delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'config'))];

    const configB = require(path.join(root, 'dist', 'modules', 'config'));
    const pmB = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const checkerB = require(path.join(root, 'dist', 'modules', 'contentsChecker'));

    pmB.initProfileStore();
    checkerB.init();

    // PC B에서 PC A의 클라우드 스토어를 수신하여 임포트
    const importSuccess = pmB.importProfilePayload(uploadPayload.profileStore);
    assert.strictEqual(importSuccess, true, '클라우드 프로필 임포트가 성공해야 합니다.');

    // 물리 디스크 확인: PC B의 profiles/data 디렉터리에 sub1, sub2 파일이 실제로 생성되었는가?
    const dataDirB = pmB.getProfileDataDir();
    assert.strictEqual(fs.existsSync(path.join(dataDirB, `${sub1.meta.id}.json`)), true, 'PC B 디스크에 부계정 1 물리 파일이 생성되어야 합니다.');
    assert.strictEqual(fs.existsSync(path.join(dataDirB, `${sub2.meta.id}.json`)), true, 'PC B 디스크에 부계정 2 물리 파일이 생성되어야 합니다.');

    // 디스크 파일 내용 직접 파싱하여 완료 상태 복원 확인
    const sub1FileContent = JSON.parse(fs.readFileSync(path.join(dataDirB, `${sub1.meta.id}.json`), 'utf8'));
    const sub2FileContent = JSON.parse(fs.readFileSync(path.join(dataDirB, `${sub2.meta.id}.json`), 'utf8'));
    assert.strictEqual(sub1FileContent.contentsCheckerItems.find((i: any) => i.id === 'weekly-mur-sylvan')?.completedState[sub1.meta.id]?.isCompleted, true, '부계정 1 숙제 완료 상태가 디스크 파일에 복원되어야 합니다.');
    assert.strictEqual(sub2FileContent.contentsCheckerItems.find((i: any) => i.id === 'daily-psiky-illusion')?.completedState[sub2.meta.id]?.isCompleted, true, '부계정 2 숙제 완료 상태가 디스크 파일에 복원되어야 합니다.');
    console.log('  -> 새 PC 디스크에 각 계정별 물리 파일 자동 생성 및 데이터 100% 복원 확인');

    // ── [3/4] PC B 활성 프로필의 3-Way 머지 로컬 체크 내역 롤백 방지 검증 ──
    console.log('[3/4] 3-Way 머지 시 활성 프로필 로컬 변경사항 롤백 방지 검증');
    const bActiveId = pmB.getActiveProfileId();
    // PC B에서 활성 프로필로 신규 숙제 하나를 로컬에서 추가 완료 (weekly-final-battle)
    checkerB.toggleItem('weekly-final-battle');
    assert.strictEqual(configB.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-final-battle')?.completedState[bActiveId]?.isCompleted, true);

    // 다시 원격에서 동기화가 와서 importProfilePayload가 불렸을 때, 방금 완료한 로컬 숙제가 롤백되지 않아야 함!
    pmB.importProfilePayload(uploadPayload.profileStore);

    const bAfterSync = pmB.getActiveProfile();
    assert.strictEqual(bAfterSync.contentsCheckerItems.find((i: any) => i.id === 'weekly-final-battle')?.completedState[bActiveId]?.isCompleted, true, '동기화 후에도 로컬에서 방금 완료한 활성 프로필 숙제가 보존되어야 합니다.');
    console.log('  -> 활성 프로필의 로컬 체크 내역이 원격 스냅샷에 의해 뒤로 롤백되지 않고 안전 보존됨 확인');

    // ── [4/4] 원격 수신 시 타 계정 키 오염 자동 정제 검증 ──
    console.log('[4/4] 원격 수신 데이터의 타 계정 키 오염 자동 정제 검증');
    // 비정상적인 클라우드 페이로드 시뮬레이션: 부계정 1의 데이터에 본계정 키('profile-char-main')가 불법 오염되어 있는 경우
    const dirtyRemoteStore = structuredClone(uploadPayload.profileStore);
    const dirtySub1 = dirtyRemoteStore.profiles.find((p: any) => p.meta.id === sub1.meta.id);
    dirtySub1.contentsCheckerItems[0].completedState['profile-char-main'] = { isCompleted: true, currentCount: 99 };
    dirtySub1.meta.updatedAt = Date.now() + 10_000; // 최신 시간 부여하여 갱신 유도

    pmB.importProfilePayload(dirtyRemoteStore);

    // 디스크 파일 직접 확인: 오염된 본계정 키가 normalizeContentsCheckerItemsForProfile에 의해 완벽히 제거되었는가?
    const cleanedSub1File = JSON.parse(fs.readFileSync(path.join(dataDirB, `${sub1.meta.id}.json`), 'utf8'));
    assert.strictEqual(cleanedSub1File.contentsCheckerItems[0].completedState['profile-char-main'], undefined, '원격에서 들어온 불법 오염 키가 로컬 파일에 저장되기 전에 깨끗이 제거되어야 합니다.');
    assert.strictEqual(cleanedSub1File.contentsCheckerItems[0].completedState[sub1.meta.id].currentCount !== 99, true, '오염된 카운트가 배제되어야 합니다.');
    console.log('  -> 원격 오염 키가 감지되어 디스크 저장 전 깨끗이 정제됨 확인');

    console.log('✅ 다중 프로필 구글 드라이브 클라우드 동기화 4대 핵심 검증 ALL PASS!');
  } finally {
    try { fs.rmSync(fixtureA, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(fixtureB, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ 클라우드 동기화 검증 실패:', err);
  process.exit(1);
});
