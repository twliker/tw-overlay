/**
 * 다중 프로필(Multi-Profile) 환경에서의 중복 숙제 보류(Pending) 및 귀속·전환 검증
 */
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { app } from 'electron';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-profile-pending-'));
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const root = path.resolve(__dirname, '..');
const built = (file: string) => require(path.join(root, 'dist', file));

async function main(): Promise<void> {
  console.log('--- 다중 프로필 중복 숙제 보류/귀속/전환 회귀 검증 시작 ---');

  const config = built('modules/config');
  const profileManager = built('modules/profileManager');
  const checker = built('modules/contentsChecker');

  const origConfig = config.load();

  try {
    const store = profileManager.initProfileStore();
    const pA = store.profiles[0];
    let pB = store.profiles.find((p: any) => p.meta.name === '회귀테스트 부캐 B');
    if (!pB) {
      pB = profileManager.createProfile({ name: '회귀테스트 부캐 B' });
    }
    let pC = store.profiles.find((p: any) => p.meta.name === '회귀테스트 부캐 C');
    if (!pC) {
      pC = profileManager.createProfile({ name: '회귀테스트 부캐 C' });
    }

    await profileManager.switchProfile(pA.meta.id);
    assert.strictEqual(profileManager.getActiveProfileId(), pA.meta.id);

    const testItem = {
      id: 'reg-profile-hw-1',
      name: '프로필 연동 테스트 던전',
      category: '일일던전',
      resetRule: { type: 'daily', hour: 6 },
      maxCount: 1,
      isVisible: true,
      completedState: {} as any
    };

    const itemsA = [
      {
        ...testItem,
        completedState: {
          [pA.meta.id]: { currentCount: 1, isCompleted: true, lastCompletedAt: Date.now() }
        }
      }
    ];
    const itemsB = [
      {
        ...testItem,
        completedState: {
          [pB.meta.id]: { currentCount: 0, isCompleted: false }
        }
      }
    ];
    const itemsC = [
      {
        ...testItem,
        completedState: {
          [pC.meta.id]: { currentCount: 0, isCompleted: false, isExcluded: true }
        }
      }
    ];

    config.saveImmediate({ contentsCheckerItems: itemsA, pendingHomeworks: [] });
    profileManager.updateProfileContentsItems(pA.meta.id, itemsA);
    profileManager.updateProfileContentsItems(pB.meta.id, itemsB);
    profileManager.updateProfileContentsItems(pC.meta.id, itemsC);

    // 1. 단일 후보 자동 반영
    config.saveImmediate({ contentsAutoAssignSingleCandidate: true, pendingHomeworks: [] });
    checker.queuePendingHomework(testItem.id, 1, true, 'evt-single', Date.now());

    const updatedPB = profileManager.getProfileById(pB.meta.id);
    const pBState = updatedPB?.contentsCheckerItems?.find((i: any) => i.id === testItem.id)?.completedState?.[pB.meta.id];
    assert.strictEqual(pBState?.currentCount, 1, '단일 미완료 후보에 자동 반영되어야 합니다.');
    assert.strictEqual(pBState?.isCompleted, true);
    assert.strictEqual((config.loadFields(['pendingHomeworks']).pendingHomeworks || []).length, 0);

    // 2. 복수 후보 보류 대기열 등록 및 getPendingCandidates 판정
    itemsB[0].completedState[pB.meta.id] = { currentCount: 0, isCompleted: false, isExcluded: false } as any;
    itemsC[0].completedState[pC.meta.id] = { currentCount: 0, isCompleted: false, isExcluded: false } as any;
    profileManager.updateProfileContentsItems(pB.meta.id, itemsB);
    profileManager.updateProfileContentsItems(pC.meta.id, itemsC);
    config.saveImmediate({ pendingHomeworks: [] });

    checker.queuePendingHomework(testItem.id, 1, true, 'evt-multi', Date.now());
    const pendingList = config.loadFields(['pendingHomeworks']).pendingHomeworks || [];
    assert.strictEqual(pendingList.length, 1, '복수 후보 시 보류 큐에 등록되어야 합니다.');

    const candidates = checker.getPendingCandidates();
    const candA = candidates.find((c: any) => c.profileId === pA.meta.id);
    const candB = candidates.find((c: any) => c.profileId === pB.meta.id);
    const candC = candidates.find((c: any) => c.profileId === pC.meta.id);
    assert.strictEqual(candA?.status, 'completed');
    assert.strictEqual(candA?.isActive, true);
    assert.strictEqual(candB?.status, 'available');
    assert.strictEqual(candC?.status, 'available');

    // 3. 비활성 프로필 pB에 반영
    checker.applyPendingHomeworks(pB.meta.id);
    const updatedPB2 = profileManager.getProfileById(pB.meta.id);
    assert.strictEqual(updatedPB2?.contentsCheckerItems?.find((i: any) => i.id === testItem.id)?.completedState?.[pB.meta.id]?.isCompleted, true);
    assert.strictEqual(profileManager.getActiveProfileId(), pA.meta.id, '활성 프로필은 pA로 유지되어야 합니다.');
    assert.strictEqual((config.loadFields(['pendingHomeworks']).pendingHomeworks || []).length, 0);

    // 4. 프로필 전환 후 반영
    config.saveImmediate({
      pendingHomeworks: [{ id: testItem.id, count: 1, isIncrement: true, timestamp: Date.now() }]
    });
    const switched = await checker.applyPendingHomeworksAndSwitch(pC.meta.id);
    assert.strictEqual(switched, true);
    assert.strictEqual(profileManager.getActiveProfileId(), pC.meta.id);
    const pCState = config.load().contentsCheckerItems.find((i: any) => i.id === testItem.id)?.completedState?.[pC.meta.id];
    assert.strictEqual(pCState?.isCompleted, true);
    assert.strictEqual((config.load().pendingHomeworks || []).length, 0);

    // 5. 모든 프로필 완료 시 중복 감지 무시
    checker.queuePendingHomework(testItem.id, 1, true, 'evt-all-done', Date.now());
    assert.strictEqual((config.loadFields(['pendingHomeworks']).pendingHomeworks || []).length, 0);

    // 6. 형식 오류(id 누락: undefined 143회) 및 고아 숙제 자동 정제 검증
    console.log('  -> 형식 오류 및 고아 보류 숙제 자동 정제 검증');
    const syncHelper = built('modules/syncDataHelper');
    config.saveImmediate({
      pendingHomeworks: [
        { count: 143, timestamp: Date.now() }, // id 누락
        { id: '', count: 1, timestamp: Date.now() }, // 빈 id
        { id: 'non-existent-orphan-hw', count: 1, timestamp: Date.now() }, // 고아 id
      ] as any
    });
    const candidatesCleaned = checker.getPendingCandidates();
    assert.strictEqual(candidatesCleaned.length, 0, '유효하지 않은 보류 숙제만 있을 경우 후보가 없어야 합니다.');
    const storedPendingAfterClean = config.loadFields(['pendingHomeworks']).pendingHomeworks || [];
    assert.strictEqual(storedPendingAfterClean.length, 0, 'id 누락 및 고아 숙제는 디스크에서 자동 제거되어야 합니다.');

    // 7. 리셋 경계를 지난 만료 보류 숙제 자동 폐기 검증 (과거 숙제 팝업 방어)
    console.log('  -> 리셋 경계 지난 만료 보류 숙제 자동 폐기 검증');
    const pastDailyTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3일 전
    const freshTimestamp = Date.now();
    config.saveImmediate({
      pendingHomeworks: [
        { id: testItem.id, count: 1, isIncrement: true, timestamp: pastDailyTimestamp },
        { id: testItem.id, count: 1, isIncrement: true, timestamp: freshTimestamp }
      ]
    });
    // pB와 pC 미완료 상태로 복원
    itemsB[0].completedState[pB.meta.id] = { currentCount: 0, isCompleted: false, isExcluded: false } as any;
    itemsC[0].completedState[pC.meta.id] = { currentCount: 0, isCompleted: false, isExcluded: false } as any;
    profileManager.updateProfileContentsItems(pB.meta.id, itemsB);
    profileManager.updateProfileContentsItems(pC.meta.id, itemsC);

    const candidatesWithExpired = checker.getPendingCandidates();
    const storedPendingAfterExpiry = config.loadFields(['pendingHomeworks']).pendingHomeworks || [];
    assert.strictEqual(storedPendingAfterExpiry.length, 1, '만료된 과거 보류 숙제는 폐기되고 당일 유효 숙제만 남아야 합니다.');
    assert.strictEqual(storedPendingAfterExpiry[0].timestamp, freshTimestamp);

    // 8. 클라우드 3-way 동기화 손상 객체 배제 검증
    console.log('  -> 클라우드 동기화 비정상 보류 항목 배제 검증');
    const threeWayMerged = syncHelper.mergeChecklistThreeWay(
      { pendingHomeworks: [] },
      { pendingHomeworks: [] } as any,
      {
        pendingHomeworks: [
          { count: 143, timestamp: Date.now() } as any,
          { id: 'valid-hw-id', count: 1, resetCycleKey: 'cycle-1' } as any
        ]
      }
    );
    assert.strictEqual(threeWayMerged.pendingHomeworks?.length, 1, 'id가 누락된 손상 객체는 동기화 병합에서 배제되어야 합니다.');
    assert.strictEqual(threeWayMerged.pendingHomeworks?.[0].id, 'valid-hw-id');

    // 복원 및 정리
    await profileManager.switchProfile(pA.meta.id);
    await profileManager.deleteProfile(pB.meta.id);
    await profileManager.deleteProfile(pC.meta.id);

    console.log('✅ 다중 프로필 중복 숙제 보류/귀속/전환 회귀 검증 통과');
  } finally {
    config.saveImmediate(origConfig);
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('검증 실패:', err);
  process.exit(1);
});
