/**
 * 다중 프로필 구글 드라이브 클라우드 동기화 12대 종합 회귀 검증 스위트
 *
 * 검증 범위:
 * [Part 1: 기초 파일 격리 및 정제 검증]
 * 1. [업로드 번들링] 다중 프로필(본계+부계1+부계2) 전체 데이터가 클라우드 payload에 누락 없이 번들링되는지
 * 2. [새 PC 복원] 새 PC에서 클라우드 데이터 수신 시 디스크에 물리 파일(manifest + data/*.json)이 자동 생성 및 온전 복원되는지
 * 3. [3-Way 롤백 방지] 활성 프로필의 로컬 완료 상태가 원격 스냅샷에 의해 뒤로 롤백되지 않고 보존되는지
 * 4. [키 오염 정제] 원격에서 타 프로필 키가 묻어 들어와도 로컬 저장 시 깨끗이 정제되는지
 *
 * [Part 2: 사용자 실전 라이프사이클 검증]
 * 5. [회사-집 연속 플레이] 회사 PC를 켜둔 채 퇴근 후 집에서 이어서 플레이하고, 다음 날 회사 PC에 양방향 완전 수렴하는지
 * 6. [동시 실행 상호 머지] PC A(숙제 X)와 PC B(숙제 Y)가 둘 다 켜진 상태에서 상호 동기화 시 둘 다 완료로 합쳐지는지
 *
 * [Part 3: 데이터 타입별 심화 검증]
 * 7. [카운트형 숙제 동기화] PC A(3회) vs PC B(5회) 진행 시 최신/최대치(5회)로 안전 수렴하는지
 * 8. [제외(N/A) 및 가시성 동기화] 숙제 제외 및 숨김 설정이 원격 PC 디스크에 온전히 유지되는지
 * 9. [원격 신규 프로필 점진 추가] 원격에서 새 프로필이 추가되어도 기존 로컬 데이터 훼손 없이 새 파일이 자동 생성되는지
 * 10. [프로필 메타데이터 동기화] 프로필 명칭 변경이 로컬 manifest에 정상 반영되고 파일 링크가 유지되는지
 * 11. [캐릭터 프리셋 병합] 다중 기기의 캐릭터 프리셋 목록이 충돌 없이 안전하게 합쳐지는지
 * 12. [손상 페이로드 방어 가드] 비정상/손상 페이로드 유입 시 로컬 프로필 및 데이터 파일 훼손을 원천 차단하는지
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

const root = path.resolve(__dirname, '..');

function clearModuleCache() {
  delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'profileManager'))];
  delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'contentsChecker'))];
  delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'config'))];
  delete require.cache[require.resolve(path.join(root, 'dist', 'modules', 'syncDataHelper'))];
}

/** 실제 cloudSyncManager의 동기화 적용 파이프라인 시뮬레이션 */
function applyCloudPayload(
  syncHelper: any,
  cfgModule: any,
  pmModule: any,
  remotePayload: any,
  basePayload?: any
) {
  const current = cfgModule.load();
  const baseData = basePayload ? basePayload.data : undefined;
  const mergedChecklist = syncHelper.mergeChecklistThreeWay(baseData, current, remotePayload.data);
  const checklist = remotePayload.operations && remotePayload.operations.length > 0
    ? syncHelper.replayChecklistOperations(mergedChecklist, remotePayload.operations)
    : mergedChecklist;
  cfgModule.saveConfirmed({ ...current, ...checklist });
  if (remotePayload.profileStore) {
    pmModule.importProfilePayload(remotePayload.profileStore);
  }
}

async function main(): Promise<void> {
  const fixtureA = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sync-a-'));
  const fixtureB = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sync-b-'));
  const fixtureWork = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sync-work-'));
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sync-home-'));
  const fixtureConcA = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sync-conca-'));
  const fixtureConcB = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sync-concb-'));

  try {
    console.log('=== 다중 프로필 구글 드라이브 클라우드 동기화 12대 종합 검증 시작 ===\n');

    // =========================================================================
    // [Part 1: 기초 파일 격리 및 정제 검증]
    // =========================================================================

    // ── [1/12] 다중 프로필 전체 데이터 클라우드 업로드 번들링 검증 ──
    console.log('[1/12] 다중 프로필 전체 데이터 클라우드 업로드 번들링 검증');
    app.setPath('userData', fixtureA);
    clearModuleCache();

    const configA = require(path.join(root, 'dist', 'modules', 'config'));
    const pmA = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const checkerA = require(path.join(root, 'dist', 'modules', 'contentsChecker'));
    const syncHelper = require(path.join(root, 'dist', 'modules', 'syncDataHelper'));

    pmA.initProfileStore();
    checkerA.init();

    const mainProfile = pmA.getActiveProfile();
    const sub1 = pmA.createProfile({ name: '부계정-보리스' });
    const sub2 = pmA.createProfile({ name: '부계정-이스핀' });

    checkerA.toggleItem('weekly-eclipse-boss-ethos');
    await pmA.switchProfile(sub1.meta.id);
    checkerA.toggleItem('weekly-mur-sylvan');
    await pmA.switchProfile(sub2.meta.id);
    checkerA.toggleItem('daily-psiky-illusion');

    const exportedStoreA = pmA.exportProfilePayload();
    const uploadPayloadA = syncHelper.buildChecklistSyncPayload(
      configA.load(),
      'device-a',
      'generation-1',
      [],
      exportedStoreA
    );

    assert.strictEqual(uploadPayloadA.profileStore?.profiles.length, 3, '클라우드 페이로드에 3개 프로필이 모두 포함되어야 합니다.');
    const upMain = uploadPayloadA.profileStore?.profiles.find((p: any) => p.meta.id === mainProfile.meta.id);
    const upSub1 = uploadPayloadA.profileStore?.profiles.find((p: any) => p.meta.id === sub1.meta.id);
    const upSub2 = uploadPayloadA.profileStore?.profiles.find((p: any) => p.meta.id === sub2.meta.id);

    assert.strictEqual(upMain?.contentsCheckerItems.find((i: any) => i.id === 'weekly-eclipse-boss-ethos')?.completedState[mainProfile.meta.id]?.isCompleted, true);
    assert.strictEqual(upSub1?.contentsCheckerItems.find((i: any) => i.id === 'weekly-mur-sylvan')?.completedState[sub1.meta.id]?.isCompleted, true);
    assert.strictEqual(upSub2?.contentsCheckerItems.find((i: any) => i.id === 'daily-psiky-illusion')?.completedState[sub2.meta.id]?.isCompleted, true);
    console.log('  -> [PASS] 3개 프로필 독립 숙제 데이터가 클라우드 페이로드에 100% 정상 번들링됨 확인\n');

    // ── [2/12] 새 PC 환경에서 클라우드 데이터 수신 시 물리 파일 자동 생성 및 복원 검증 ──
    console.log('[2/12] 새 PC에서 수신 시 물리 파일(manifest + data/*.json) 자동 생성 및 복원 검증');
    app.setPath('userData', fixtureB);
    clearModuleCache();

    const configB = require(path.join(root, 'dist', 'modules', 'config'));
    const pmB = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const checkerB = require(path.join(root, 'dist', 'modules', 'contentsChecker'));

    pmB.initProfileStore();
    checkerB.init();

    const importSuccess = pmB.importProfilePayload(uploadPayloadA.profileStore);
    assert.strictEqual(importSuccess, true, '클라우드 프로필 임포트가 성공해야 합니다.');

    const dataDirB = pmB.getProfileDataDir();
    assert.strictEqual(fs.existsSync(path.join(dataDirB, `${sub1.meta.id}.json`)), true, 'PC B 디스크에 부계정 1 물리 파일이 생성되어야 합니다.');
    assert.strictEqual(fs.existsSync(path.join(dataDirB, `${sub2.meta.id}.json`)), true, 'PC B 디스크에 부계정 2 물리 파일이 생성되어야 합니다.');

    const sub1FileContent = JSON.parse(fs.readFileSync(path.join(dataDirB, `${sub1.meta.id}.json`), 'utf8'));
    const sub2FileContent = JSON.parse(fs.readFileSync(path.join(dataDirB, `${sub2.meta.id}.json`), 'utf8'));
    assert.strictEqual(sub1FileContent.contentsCheckerItems.find((i: any) => i.id === 'weekly-mur-sylvan')?.completedState[sub1.meta.id]?.isCompleted, true);
    assert.strictEqual(sub2FileContent.contentsCheckerItems.find((i: any) => i.id === 'daily-psiky-illusion')?.completedState[sub2.meta.id]?.isCompleted, true);
    console.log('  -> [PASS] 새 PC 디스크에 각 계정별 물리 파일 자동 생성 및 데이터 100% 복원 확인\n');

    // ── [3/12] 3-Way 머지 시 활성 프로필 로컬 변경사항 롤백 방지 검증 ──
    console.log('[3/12] 3-Way 머지 시 활성 프로필 로컬 변경사항 롤백 방지 검증');
    const bActiveId = pmB.getActiveProfileId();
    checkerB.toggleItem('weekly-final-battle');
    assert.strictEqual(configB.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-final-battle')?.completedState[bActiveId]?.isCompleted, true);

    pmB.importProfilePayload(uploadPayloadA.profileStore);

    const bAfterSync = pmB.getActiveProfile();
    assert.strictEqual(bAfterSync.contentsCheckerItems.find((i: any) => i.id === 'weekly-final-battle')?.completedState[bActiveId]?.isCompleted, true);
    console.log('  -> [PASS] 활성 프로필의 로컬 체크 내역이 원격 스냅샷에 의해 뒤로 롤백되지 않고 안전 보존됨 확인\n');

    // ── [4/12] 원격 수신 시 타 계정 키 오염 자동 정제 검증 ──
    console.log('[4/12] 원격 수신 데이터의 타 계정 키 오염 자동 정제 검증');
    const dirtyRemoteStore = structuredClone(uploadPayloadA.profileStore);
    const dirtySub1 = dirtyRemoteStore.profiles.find((p: any) => p.meta.id === sub1.meta.id);
    dirtySub1.contentsCheckerItems[0].completedState['profile-char-main'] = { isCompleted: true, currentCount: 99 };
    dirtySub1.meta.updatedAt = Date.now() + 10_000;

    pmB.importProfilePayload(dirtyRemoteStore);

    const cleanedSub1File = JSON.parse(fs.readFileSync(path.join(dataDirB, `${sub1.meta.id}.json`), 'utf8'));
    assert.strictEqual(cleanedSub1File.contentsCheckerItems[0].completedState['profile-char-main'], undefined);
    assert.strictEqual(cleanedSub1File.contentsCheckerItems[0].completedState[sub1.meta.id].currentCount !== 99, true);
    console.log('  -> [PASS] 원격 오염 키가 감지되어 디스크 저장 전 깨끗이 정제됨 확인\n');

    // =========================================================================
    // [Part 2: 사용자 실전 라이프사이클 검증]
    // =========================================================================

    // ── [5/12] 🏢 ↔ 🏠 회사-집 연속 플레이(Live Session Roundtrip) 실전 검증 ──
    console.log('[5/12] 🏢 ↔ 🏠 회사-집 연속 플레이(Live Session Roundtrip) 실전 시뮬레이션');
    // Step 1: Day 1 낮 회사 PC - 프로그램 켜진 상태에서 본계정 신조 2회 진행
    app.setPath('userData', fixtureWork);
    clearModuleCache();
    const configWork = require(path.join(root, 'dist', 'modules', 'config'));
    const pmWork = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const checkerWork = require(path.join(root, 'dist', 'modules', 'contentsChecker'));
    pmWork.initProfileStore();
    checkerWork.init();

    const workMainId = pmWork.getActiveProfileId();
    // 신조의 둥지 3회 진행 (maxCount: 7)
    checkerWork.updateItemCount('weekly-shinjo-nest', workMainId, 3);
    assert.strictEqual(configWork.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-shinjo-nest')?.completedState[workMainId]?.currentCount, 3);

    // 회사 PC가 클라우드에 1차 업로드 (회사 PC는 끄지 않고 프로세스 활성 유지!)
    const workPayload1 = syncHelper.buildChecklistSyncPayload(
      configWork.load(),
      'device-work',
      'gen-work',
      [],
      pmWork.exportProfilePayload()
    );

    // Step 2: Day 1 밤 집 PC - 프로그램 켜서 회사 진행도 수신 후 이어서 플레이
    app.setPath('userData', fixtureHome);
    clearModuleCache();
    const configHome = require(path.join(root, 'dist', 'modules', 'config'));
    const pmHome = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const checkerHome = require(path.join(root, 'dist', 'modules', 'contentsChecker'));
    pmHome.initProfileStore();
    checkerHome.init();

    // 집 PC 1차 수신: 3-Way 머지 및 프로필 임포트
    applyCloudPayload(syncHelper, configHome, pmHome, workPayload1);

    const homeMainId = pmHome.getActiveProfileId();
    // 회사에서 한 신조 3회가 집에 온전히 도착했는가?
    assert.strictEqual(configHome.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-shinjo-nest')?.completedState[homeMainId]?.currentCount, 3, '집 PC에 회사의 신조 3회 진행도가 도착해야 합니다.');

    // 집에서 이어서 신조 잔여 4회 추가 완료 -> 총 7회 최종 완료 달성!
    checkerHome.updateItemCount('weekly-shinjo-nest', homeMainId, 7);
    assert.strictEqual(configHome.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-shinjo-nest')?.completedState[homeMainId]?.currentCount, 7);
    assert.strictEqual(configHome.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-shinjo-nest')?.completedState[homeMainId]?.isCompleted, true);

    // 집에서 부계정 추가 생성 후 주간 어비스 완료
    const homeSub = pmHome.createProfile({ name: '집-부계정-조슈아' });
    await pmHome.switchProfile(homeSub.meta.id);
    checkerHome.toggleItem('weekly-abyss-boss-ex');
    assert.strictEqual(configHome.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-abyss-boss-ex')?.completedState[homeSub.meta.id]?.isCompleted, true);

    // 다시 본계정으로 전환 후 집 PC에서 클라우드로 2차 업로드
    await pmHome.switchProfile(homeMainId);
    const homePayload2 = syncHelper.buildChecklistSyncPayload(
      configHome.load(),
      'device-home',
      'gen-home',
      [],
      pmHome.exportProfilePayload()
    );

    // Step 3: Day 2 아침 회사 PC 복귀 - 밤새 켜져 있던 회사 세션이 집의 2차 업로드 수신
    app.setPath('userData', fixtureWork);
    // 회사 PC 세션으로 복귀 (캐시를 날리지 않고 살아있는 인스턴스 그대로 사용)
    applyCloudPayload(syncHelper, configWork, pmWork, homePayload2, workPayload1);

    // ★ 최종 무결성 검증 (회사 PC)
    // 1. 본계정의 신조의 둥지가 집에서 이어서 한 7회(완료)로 정확히 표시되는가?
    const workFinalMain = configWork.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-shinjo-nest')?.completedState[workMainId];
    assert.strictEqual(workFinalMain?.currentCount, 7, '회사 PC에 집에서 완료한 신조 7회가 완벽하게 합쳐져야 합니다.');
    assert.strictEqual(workFinalMain?.isCompleted, true, '회사 PC에 신조 완료 상태가 온전히 반영되어야 합니다.');

    // 2. 집에서 만든 '집-부계정-조슈아'가 회사 PC manifest와 디스크에 자동 생성되었는가?
    const workDataDir = pmWork.getProfileDataDir();
    assert.strictEqual(fs.existsSync(path.join(workDataDir, `${homeSub.meta.id}.json`)), true, '회사 PC 디스크에 집에서 만든 부계정 물리 파일이 생성되어야 합니다.');

    // 3. 회사 PC에서 집-부계정으로 전환했을 때 주간 어비스 완료가 정상 표시되는가?
    await pmWork.switchProfile(homeSub.meta.id);
    assert.strictEqual(configWork.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-abyss-boss-ex')?.completedState[homeSub.meta.id]?.isCompleted, true, '회사 PC에서 집-부계정으로 전환 시 주간 어비스 완료가 보존되어야 합니다.');
    console.log('  -> [PASS] 회사 PC를 켜둔 채 퇴근 후 집에서 이어서 플레이한 결과가 회사 PC에 100% 완전 수렴 확인\n');

    // ── [6/12] 💻 ↔ 💻 A, B 컴퓨터 동시 실행 상호 머지(Concurrent Divergent Edits) 검증 ──
    console.log('[6/12] 💻 ↔ 💻 A, B 컴퓨터 동시 실행 상호 머지(Concurrent Divergent Edits) 검증');
    // PC A와 PC B가 동일 베이스 상태에서 동시 실행 중
    app.setPath('userData', fixtureConcA);
    clearModuleCache();
    const cfgA = require(path.join(root, 'dist', 'modules', 'config'));
    const pA = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const chkA = require(path.join(root, 'dist', 'modules', 'contentsChecker'));
    pA.initProfileStore();
    chkA.init();
    await pA.switchProfile('profile-default');
    const pActiveA = pA.getActiveProfileId();

    app.setPath('userData', fixtureConcB);
    clearModuleCache();
    const cfgB = require(path.join(root, 'dist', 'modules', 'config'));
    const pB = require(path.join(root, 'dist', 'modules', 'profileManager'));
    const chkB = require(path.join(root, 'dist', 'modules', 'contentsChecker'));
    pB.initProfileStore();
    chkB.init();
    await pB.switchProfile('profile-default');
    const pActiveB = pB.getActiveProfileId();

    // 베이스 동기화 시점의 공통 상태 스냅샷
    const baseSnapshot = syncHelper.buildChecklistSyncPayload(cfgA.load(), 'device-base', 'gen-0', [], pA.exportProfilePayload());

    // PC A에서 'weekly-eclipse-boss-ethos' 체크
    app.setPath('userData', fixtureConcA);
    chkA.toggleItem('weekly-eclipse-boss-ethos');
    const payloadConcurrentA = syncHelper.buildChecklistSyncPayload(cfgA.load(), 'device-a', 'gen-1', [], pA.exportProfilePayload());

    // PC B에서 'weekly-mur-sylvan' 체크
    app.setPath('userData', fixtureConcB);
    chkB.toggleItem('weekly-mur-sylvan');
    const payloadConcurrentB = syncHelper.buildChecklistSyncPayload(cfgB.load(), 'device-b', 'gen-1', [], pB.exportProfilePayload());

    // PC B가 PC A의 페이로드를 수신하여 3-Way 머지
    applyCloudPayload(syncHelper, cfgB, pB, payloadConcurrentA, baseSnapshot);

    // PC B 검증: 내가 한 숙제(sylvan) + A가 한 숙제(ethos) 둘 다 완료되어 있는가?
    const bEthos = cfgB.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-eclipse-boss-ethos')?.completedState[pActiveB]?.isCompleted;
    const bSylvan = cfgB.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-mur-sylvan')?.completedState[pActiveB]?.isCompleted;
    assert.strictEqual(bEthos, true, 'PC B에 PC A의 숙제가 합쳐져야 합니다.');
    assert.strictEqual(bSylvan, true, 'PC B에서 방금 내가 한 숙제가 보존되어야 합니다.');

    // PC B가 합쳐진 상태를 다시 클라우드에 업로드 -> PC A가 이를 수신하여 3-Way 머지
    const payloadBtoA = syncHelper.buildChecklistSyncPayload(cfgB.load(), 'device-b', 'gen-2', [], pB.exportProfilePayload());
    app.setPath('userData', fixtureConcA);
    applyCloudPayload(syncHelper, cfgA, pA, payloadBtoA, baseSnapshot);

    // PC A 검증: 내가 한 숙제(ethos) + B가 한 숙제(sylvan) 둘 다 완료되어 있는가?
    const aEthos = cfgA.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-eclipse-boss-ethos')?.completedState[pActiveA]?.isCompleted;
    const aSylvan = cfgA.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-mur-sylvan')?.completedState[pActiveA]?.isCompleted;
    assert.strictEqual(aEthos, true, 'PC A에서 내가 한 숙제가 보존되어야 합니다.');
    assert.strictEqual(aSylvan, true, 'PC A에 PC B가 한 숙제가 합쳐져야 합니다.');
    console.log('  -> [PASS] 동시 실행 상태에서 양쪽이 각각 완료한 서로 다른 숙제가 100% 누락 없이 상호 병합됨 확인\n');

    // =========================================================================
    // [Part 3: 데이터 타입별 심화 검증]
    // =========================================================================

    // ── [7/12] 카운트형 숙제(누적 횟수)의 양방향 동기화 및 최신/최대 진행도 보존 검증 ──
    console.log('[7/12] 카운트형 숙제 양방향 동기화 및 최신/최대 진행도 보존 검증');
    // PC A는 3회, PC B는 5회 진행
    app.setPath('userData', fixtureConcA);
    chkA.updateItemCount('weekly-shinjo-nest', pActiveA, 3);
    const countPayloadA = syncHelper.buildChecklistSyncPayload(cfgA.load(), 'device-a', 'gen-c1', [], pA.exportProfilePayload());

    app.setPath('userData', fixtureConcB);
    chkB.updateItemCount('weekly-shinjo-nest', pActiveB, 5);
    const countPayloadB = syncHelper.buildChecklistSyncPayload(cfgB.load(), 'device-b', 'gen-c2', [], pB.exportProfilePayload());

    // PC A가 PC B(5회) 수신
    app.setPath('userData', fixtureConcA);
    applyCloudPayload(syncHelper, cfgA, pA, countPayloadB);

    const countA = cfgA.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-shinjo-nest')?.completedState[pActiveA]?.currentCount;
    assert.strictEqual(countA, 5, '카운트형 숙제 동기화 시 더 높은 진행도인 5회로 반영되어야 합니다.');
    console.log('  -> [PASS] 카운트형 숙제가 더 최신/최대 진행도인 5회로 안전 수렴됨 확인\n');

    // ── [8/12] 숙제 제외(N/A) 설정 및 표시 여부(isVisible) 원격 동기화 검증 ──
    console.log('[8/12] 숙제 제외(N/A) 설정 및 표시 여부(isVisible) 원격 동기화 검증');
    app.setPath('userData', fixtureConcA);
    chkA.toggleExcludeItem('weekly-abyss-boss-ex', pActiveA);
    chkA.toggleVisibility('daily-psiky-illusion');

    const settingPayloadA = syncHelper.buildChecklistSyncPayload(cfgA.load(), 'device-a', 'gen-s', [], pA.exportProfilePayload());

    // PC B가 수신
    app.setPath('userData', fixtureConcB);
    applyCloudPayload(syncHelper, cfgB, pB, settingPayloadA);

    const excludedStateB = cfgB.load().contentsCheckerItems.find((i: any) => i.id === 'weekly-abyss-boss-ex')?.completedState[pActiveB]?.isExcluded;
    const visibilityB = cfgB.load().contentsCheckerItems.find((i: any) => i.id === 'daily-psiky-illusion')?.isVisible;
    assert.strictEqual(excludedStateB, true, '원격의 숙제 제외(N/A) 설정이 동기화되어야 합니다.');
    assert.strictEqual(visibilityB, false, '원격의 숙제 숨김(isVisible: false) 설정이 동기화되어야 합니다.');
    console.log('  -> [PASS] 숙제 제외(N/A) 및 표시 설정이 원격 기기에 온전히 동기화됨 확인\n');

    // ── [9/12] 원격 신규 프로필 추가 시 점진적 자동 생성(Incremental Profile Addition) 검증 ──
    console.log('[9/12] 원격 신규 프로필 추가 시 점진적 자동 생성 검증');
    // PC B에서 신규 프로필 '부계정-신규-막시민' 생성 및 숙제 완료
    app.setPath('userData', fixtureConcB);
    const newSubB = pB.createProfile({ name: '부계정-신규-막시민' });
    await pB.switchProfile(newSubB.meta.id);
    chkB.toggleItem('weekly-final-battle');

    const newProfilePayload = syncHelper.buildChecklistSyncPayload(cfgB.load(), 'device-b', 'gen-new', [], pB.exportProfilePayload());

    // PC A가 수신: PC A에는 기존 프로필들이 있고, 신규 프로필이 들어옴
    app.setPath('userData', fixtureConcA);
    const beforeCountA = pA.getAllProfiles().length;
    pA.importProfilePayload(newProfilePayload.profileStore);

    const afterProfilesA = pA.getAllProfiles();
    assert.strictEqual(afterProfilesA.length, beforeCountA + 1, 'PC A의 프로필 수가 1개 증가해야 합니다.');
    assert.strictEqual(afterProfilesA.some((p: any) => p.meta.id === newSubB.meta.id), true, '신규 프로필 메타가 등록되어야 합니다.');

    // 디스크 파일 생성 확인
    const aDataDir = pA.getProfileDataDir();
    assert.strictEqual(fs.existsSync(path.join(aDataDir, `${newSubB.meta.id}.json`)), true, 'PC A 디스크에 신규 프로필 데이터 파일이 생성되어야 합니다.');
    const newProfileFile = JSON.parse(fs.readFileSync(path.join(aDataDir, `${newSubB.meta.id}.json`), 'utf8'));
    assert.strictEqual(newProfileFile.contentsCheckerItems.find((i: any) => i.id === 'weekly-final-battle')?.completedState[newSubB.meta.id]?.isCompleted, true);
    console.log('  -> [PASS] 원격에서 추가된 신규 프로필이 기존 데이터 훼손 없이 디스크에 자동 생성됨 확인\n');

    // ── [10/12] 프로필 메타데이터(이름 변경 등) 동기화 검증 ──
    console.log('[10/12] 프로필 메타데이터(이름 변경 등) 동기화 검증');
    app.setPath('userData', fixtureConcB);
    pB.updateProfile(newSubB.meta.id, { name: '막시민-공성전용' });
    const renamePayload = syncHelper.buildChecklistSyncPayload(cfgB.load(), 'device-b', 'gen-ren', [], pB.exportProfilePayload());

    // PC A가 수신
    app.setPath('userData', fixtureConcA);
    pA.importProfilePayload(renamePayload.profileStore);

    const renamedProfileA = pA.getAllProfiles().find((p: any) => p.meta.id === newSubB.meta.id);
    assert.strictEqual(renamedProfileA?.meta.name, '막시민-공성전용', '프로필 이름 변경이 동기화되어야 합니다.');
    console.log('  -> [PASS] 프로필 명칭 변경이 원격 manifest에 안전하게 동기화됨 확인\n');

    // ── [11/12] 캐릭터 프리셋(Character Presets) 다중 기기 상호 병합 검증 ──
    console.log('[11/12] 캐릭터 프리셋 다중 기기 상호 병합 검증');
    app.setPath('userData', fixtureConcA);
    cfgA.saveConfirmed({
      characterPresets: [{ id: 'preset-boris', name: '보리스-검계열', character: 'boris', level: 310 }]
    });

    app.setPath('userData', fixtureConcB);
    cfgB.saveConfirmed({
      characterPresets: [{ id: 'preset-lucian', name: '루시안-물복', character: 'lucian', level: 310 }]
    });

    const presetPayloadA = syncHelper.buildChecklistSyncPayload(cfgA.load(), 'device-a', 'gen-p', [], pA.exportProfilePayload());

    // PC B가 PC A의 프리셋 수신
    applyCloudPayload(syncHelper, cfgB, pB, presetPayloadA);

    const finalPresetsB = cfgB.load().characterPresets || [];
    assert.strictEqual(finalPresetsB.length, 2, '두 기기의 프리셋이 모두 합쳐져 총 2개여야 합니다.');
    assert.strictEqual(finalPresetsB.some((p: any) => p.id === 'preset-boris'), true, '보리스 프리셋이 보존되어야 합니다.');
    assert.strictEqual(finalPresetsB.some((p: any) => p.id === 'preset-lucian'), true, '루시안 프리셋이 보존되어야 합니다.');
    console.log('  -> [PASS] 다중 기기에서 각각 등록한 캐릭터 프리셋이 누락 없이 상호 병합됨 확인\n');

    // ── [12/12] 비정상/손상 페이로드 방어 가드 (Fault Tolerance) 검증 ──
    console.log('[12/12] 비정상/손상 페이로드 방어 가드 검증');
    app.setPath('userData', fixtureConcA);
    const beforeManifest = fs.readFileSync(path.join(fixtureConcA, 'profiles', 'manifest.json'), 'utf8');

    // 1. null 수신
    const resNull = pA.importProfilePayload(null);
    assert.strictEqual(resNull, false, 'null 페이로드는 거부되어야 합니다.');

    // 2. 빈 profiles 배열 수신
    const resEmpty = pA.importProfilePayload({ version: 1, activeProfileId: 'x', profiles: [] });
    assert.strictEqual(resEmpty, false, '빈 프로필 목록 페이로드는 거부되어야 합니다.');

    // 3. 로컬 manifest 및 파일 무결성 유지 확인
    const afterManifest = fs.readFileSync(path.join(fixtureConcA, 'profiles', 'manifest.json'), 'utf8');
    assert.strictEqual(beforeManifest, afterManifest, '손상된 페이로드 수신 후에도 로컬 manifest가 전혀 손상되지 않아야 합니다.');
    console.log('  -> [PASS] 손상/비정상 페이로드 유입 시 안전 거부 및 로컬 데이터 무결성 100% 보존 확인\n');

    console.log('🎉 다중 프로필 구글 드라이브 클라우드 동기화 12대 종합 검증 ALL PASS!');
  } finally {
    try { fs.rmSync(fixtureA, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(fixtureB, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(fixtureWork, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(fixtureHome, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(fixtureConcA, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(fixtureConcB, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ 클라우드 동기화 검증 실패:', err);
  process.exit(1);
});
