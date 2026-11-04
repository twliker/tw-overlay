# Google 프로필 동기화 재개발 검증

2026-11-04. 범위는 프로필·숙제·휴대 가능한 설정이며 모험일지·채팅 원본·실행 중 HUD는 제외한다. 실제 사용자 Roaming 데이터는 검사에 사용하지 않는다. 현행 계약은 [Google 계약](../../.agents/development/google-drive-sync-contract.md), 사용자 흐름은 [Google 가이드](../google-drive-sync.md)를 따른다.

기능 구현 후 2026-11-04 14:28 KST에 당시 관련 자동 게이트 22개를 모두 통과했다. 검증 소스 SHA-256은 `bb9993e9592fe04df4959660752ae5215b00e420945fd11effa71f10db52a527`이며 실행 중 소스 불변을 확인했다. 해당 기록은 `output/profile-sync-acceptance/2026-11-04T05-24-13-257Z/report.json`에 보존한다. 이후 두 프로세스 동시성 검사를 추가했으며 아래 별도 결과를 따른다. 실계정 검증은 직접 OAuth 로그인이 필요하며 자동 검사 통과와 별도로 판정한다.

## 검증 명령과 근거

`npm run test:profile-sync:acceptance`는 타입 검사·빌드 후 새 model/transport/coordinator/실제 설정 UI 검사와 직접 영향받은 프로필 저장/기록/ZIP/설정/도구/숙제/스톱워치/부팅/구형 전송 중지 및 실제 Windows 창 조합, 3.2.2 업그레이드, 강제 종료 복구, 크기·비용, 실제 교체 UI를 실행한다. 한 단계라도 실패하거나 실행 중 소스가 바뀌면 완료 판정을 하지 않는다. 전체 npm test는 실행하지 않는다. 일상 변경은 해당 관련 파일만 검사한다.

| 요구사항 | 증거 |
|---|---|
| 원본과 변경 이력의 원자 저장, 실패 rollback | check-profile-sync-model.ts, check-profile-storage.ts |
| 다른 필드 병합, 같은 필드 후보 보존, 인터넷 시각/오차·인과 순서 | check-profile-sync-model.ts, check-profile-sync.ts |
| 두 PC 업로드 실제 겹침, 역순 응답, 수신 중 저장, 한쪽 실패/취소 | check-profile-sync-concurrency.ts (별도 프로세스 2개 + loopback HTTP) |
| 숙제 횟수/완료 해제/N/A/정의/정렬·주기 분리, 삭제 후 구 PC 복귀 | model/coordinator 검사 |
| 새 PC 빈 기본 재사용·첫 연결 선택·ZIP | check-profile-sync.ts, check-profile-sync-ui.ts |
| 전송 중 새 저장·ACK 유실·재시작/DB 복원·계정 전환 | check-profile-sync.ts, check-profile-lifecycle.ts |
| 다른 PC 백업의 ACK/파일 ID 격리, 원래 변경 시각/프로필 ID 보존 | model/coordinator 검사, check-profile-backup.ts |
| Google 교체 전 미저장 입력 보호, ZIP 확인, 설정/DB/cursor 원자 확정 | check-profile-sync-ui.ts 및 --remote-import 실행 |
| 현재 프로필 선택/편집 초안 유지, 원격 식별 정보의 명시 수락 | check-profile-sync-ui.ts, check-profile-settings.ts |
| 비활성 프로필이라도 진행 중 측정 소유자 삭제 보호 | check-profile-sync-ui.ts, check-profile-stopwatch.ts |
| 일지/로그/미배정/기기 설정/인증 제외, 중첩 소리/음량 제외 | model/UI 검사 및 개인정보 안내 parity |
| 페이지/cursor/If-Match·version 경합/401·403·429·410·412·404/압축·크기 | check-profile-sync-drive.ts |
| 활동30초·휴식5분, 사용자3초/10초·휴식 자동30초/60초, 요청 제한 | 가상 시간으로 운영 coordinator 실행 |
| 실제 main/tracker/선택창·최소화/서버 전환 | check-profile-windows.ts, check-refactor-regressions.ts |
| 실제 3.2.2 데이터 이전, 강제 종료 후 미전송 변경과 시각 보존 | check-profile-upgrade.ts, check-profile-crash.ts |

## 두 프로세스 동시성 추가 검증

2026-11-04 14:37 KST, `npm run test:profile-sync-concurrency`의 10가지 시나리오가 모두 통과했다. 서로 다른 프로세스 ID와 별도 SQLite를 사용하며 운영 GoogleProfileDrive의 URL만 loopback HTTP 서버로 전환한다. 인증과 서버 응답만 검사 대역이며 원본 저장·압축·버전/ETag·본문 검증·병합·ACK·취소는 운영 구현을 실행한다.

| 동시 상황 | 확인 결과 |
|---|---|
| 서로 다른 프로필의 설정/숙제 수정 | 양쪽 변경 유지, 현재 선택 프로필은 PC별로 유지 |
| 같은 프로필의 서로 다른 설정 | 자동 병합 |
| 같은 설정의 서로 다른 값/같은 값 | 다른 값은 양쪽 후보 보존·해결 전파, 같은 값은 충돌/업로드 반복 없음 |
| 같은 숙제의 서로 다른 횟수 | 각 로컬 횟수와 후보 유지, 선택 후 수렴. 합산/최댓값 자동 병합 없음 |
| 원격 본문 수신 중 로컬 편집 | 새 입력 보존, 상대 값과 충돌 후보 유지 |
| 업로드 응답 대기 중 새 저장 | 과거 ACK로 새 저장을 소비하지 않고 다음 전송에 유지 |
| 한쪽 성공/한쪽 요청 제한 | 실패 PC 대기 보존, 대기 후 재시도로 양쪽 수렴 |
| 수신 중 연결 해제 | 취소된 본문/cursor 미적용, 재연결 후 정상 수신 |
| 삭제와 다른 PC의 늦은 수정 | 삭제된 프로필 부활 없음 |

실제 업로드 요청 2개가 동시에 보류된 7차례를 기록하고 A→B/B→A 응답 순서를 모두 검사했다. 해당 실행은 loopback 요청 185회, 업로드 성공 24회, 동시 업로드 최대 2개였다. `output/profile-sync-concurrency/latest.json`은 개별 시나리오·프로세스 ID·응답 순서·검사 대상 파일별 SHA-256을 기록한다. `realGoogleVerified=false`, `twoPhysicalPCsVerified=false`를 명시한다.

이 변경에서는 제품 동작을 수정하지 않았다. 타입 검사·빌드와 새 동시성 검사를 실행했으며 전체 npm test/기존 22개 묶음은 반복하지 않는다. 향후 전체 Google 완료 명령에는 새 검사를 포함한 23개 게이트가 실행된다. 기존 22개 기록을 현재 23개 통과로 해석하지 않는다.

## 크기와 비용

`output/profile-sync-budget/latest.json`은 실제66개 기본 숙제와1/5/20/50프로필의 합성 데이터를 직렬화/압축하고 로컬 저장20회 median/p95를 측정한다. 네트워크 p95가 아니다. 1,000회 수정 뒤 필드 수가 증가하지 않는 압축 journal, 전송 확정 상세 이력 정리와 순번 보존도 검사한다.

최종 관련 검사의 데이터 압축률은 약96~97%였다. 5프로필은 약29 KiB,20프로필은 약109 KiB,50프로필은 약269 KiB의 압축 본문이었다. 로컬 저장 p95는 각각 약13/44/119 ms였다. 최신 값은 재실행 결과를 기준으로 한다. 50프로필의 저장 비용을 일반 사용자의 체감 지연이나 Google 응답 속도로 일반화하지 않는다.

공개 신규 quota 모델에서 changes.list는100 units, 본문 다운로드200, 쓰기50, metadata get5다. 변경이 없는 활동 PC100/1,000/10,000대의 확인 비용은 분당20,000/200,000/2,000,000 units다. 1,000대가 각각 분당 한 번 쓰고 한 번 받는 예시는 약455,000 units/분이다. 이 모델에는 계정별 여러 수신 PC·재시도·초기 복원 폭주를 추가해야 한다. 공개1,000,000 units/분 기준에서10,000대/30초 확인은 한도를 넘으므로 프로젝트 실효 한도/예산에 따라 정책을 조정해야 한다. 간격은 PROFILE_SYNC_POLICY 한 곳에서 관리한다.

Google 계정의 숨김 앱 데이터도 저장공간을 사용한다. 일지/로그를 전송하지 않으며 이벤트별 파일을 만들지 않는다. 필요 삭제 표식·미전송·충돌/중복 방지 정보는 기간만으로 삭제하지 않는다.

공식 근거(2026-11-04): [Google 한도/비용](https://developers.google.com/workspace/drive/api/guides/limits), [앱 데이터 저장](https://developers.google.com/workspace/drive/api/guides/appdata), [숨김 앱 데이터 용량](https://support.google.com/drive/answer/17196458).

## 실제 Google 및 배포 확인

`npm run test:profile-sync:live`는 임시 userData/임의의 test namespace와 두 저장소로 OAuth·왕복·빈 기본 재사용·숙제/설정·조건부 갱신·충돌 해결을 검사하고 만든 검사 파일만 정리한다. 결과는 `output/profile-sync-live/latest.json`의 realGoogleVerified/cleaned를 확인한다. 제품 namespace의 파일을 삭제하는 코드는 거부한다.

- 실제 Google 계정 왕복: 2026-11-04 14:28 KST에 격리 검사를 시작했으나 60초 OAuth 로그인 제한시간이 끝나 미검증이다. 결과는 `output/profile-sync-live/latest.json`의 failed/realGoogleVerified=false로 보존한다. 인증 단계에서 종료되어 검사 Drive 파일은 생성하지 않았고 임시 인증은 해제했다. 직접 로그인 후 재검사가 필요하다.
- 실제 Cloud Console quota/계정 저장공간/네트워크 p95: 미확인.
- 실게임/관리자 Windows/설치 업데이트: 기존 릴리즈 환경 확인 절차를 유지한다.
- 개발 검증 단계에서는 버전 변경·설치 파일 배포·태그·push를 수행하지 않았다. 이후 사용자가 요청한 `3.5.0-beta.1` 테스트 배포는 [별도 준비 기록](./prerelease-3.5.0-beta.1.md)을 따른다. 설치 파일은 CI에서 생성하며 실기 항목은 해당 설치본으로 확인한다.
