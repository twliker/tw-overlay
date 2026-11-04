# Google 프로필 동기화 재개발 (2026-11-04)

사용자 요청: 프로필·숙제·휴대 가능한 설정의 Google 동기화 재개발을 완료까지 진행한다. 이전 형식에 종속하지 않는다. 모험일지·채팅 원본·HUD 실행 세션은 전송하지 않는다. 실제 사용자 Roaming 데이터는 개발 검사에 사용하지 않는다.

## 구현한 구조

- `profileSyncModel.ts`: 명시적 필드 허용 목록, PC별 변경 snapshot, 변경 시점 UTC/오차, 기기 순번과 인과 vector. 서로 다른 필드 병합, 인과 또는 신뢰한 시각으로 정렬, 불확실한 동시 변경 후보 보존. 숙제 진행/제외/정의/정렬을 구분하고 한국 리셋 주기로 비교한다. 삭제 표식 영구 보존. 현재 기록 프로필 이름/서버/삭제는 확인 전 유지한다.
- `ApplicationData`의 원본 transaction 안에서 journal을 확정한다. 내부 변경 함수마다 전체를 반복 스캔하지 않고 최상위 저장 한 번에 capture한다. 일지/로그/실행 상태 변경은 전송 대기를 생성하지 않는다.
- `profileSyncDrive.ts`: 기존 OAuth만 사용. appDataFolder의 `twProfileSync=1` 파일만 읽고 쓴다. changes feed cursor로 유휴 확인 한 번, 변경 파일만 다운로드. 신규 파일은 생성 ID를 먼저 저장하고 기존 파일은 명시 ETag로 조건부 갱신한다. 옛 settings/checklist/meta 파일을 읽거나 덮어쓰지 않는다.
- `profileSyncCoordinator.ts`: 앱 단위 single-flight, 활동 30초/휴식 5분, 수동 편집 3초/최대10초, 휴식 자동 30초/최대60초. 재시도·Retry-After·상한과 지터. ACK 유실/전송 중 저장/오래된 DB 복원/계정 변경을 구분한다.
- `profileCloudSync.ts`: 프로필 기록 잠금과 기존 설정 runtime에 통합. 기존 관리 IPC 이름은 facade로 새 경로에 전달하되 옛 구현은 계속 중지한다. 최초 선택 전 자동 덮어쓰기 없음. 병합/Google 가져오기/로컬 유지(동기화 끄기). 적용 전 로컬 ZIP, 빈 기본 프로필 재사용. 현재 프로필의 원격 식별 정보는 명시 수락 후 선택 대기로 전환한다.
- UI: 기존 설정 카드 자리, 저장/동기화 상태 분리, 비차단 후보 선택. `profileSyncIpc.ts`의 새 쓰기 IPC는 로컬 settings main frame만 허용한다.
- 백업으로 순번이 돌아간 PC는 기존 파일을 덮어쓰지 않고 선택 후 새 writer 세대를 사용한다. 과거 변경 시각을 업로드 시각으로 바꾸지 않는다. 평상시 변경은 항목별 최신 값/인과 정보로 압축하므로 이벤트마다 파일/이력이 늘어나지 않는다. 삭제·미전송·충돌에 필요한 정보는 유지한다.
- 알림의 soundFile/volume은 기기 전용이다. 알림 내용은 전송하되 소리/음량은 제외하고 수신 시 기존 로컬 선택을 유지한다.
- 다른 PC 백업 복원은 DB localDevice를 확인해 원본 PC의 ACK/파일 ID/cache/cursor를 제거하고 현재 PC의 새 writer로 전송 대기를 구성한다. 원격 프로필 ID·후보 시각·삭제 표식은 유지한다. 원래 계정과 다른 빈 계정도 선택 전 자동 업로드하지 않는다. DB 재개방 시 capture보다 먼저 수행한다.
- 설정/숙제의 미저장 입력이 있으면 Google 교체를 멈추고 입력을 보존한다. 계산기는 저장 후 적용이 끝날 때까지 잠금을 유지한다. 원본/설정 JSON/cursor는 기존 commit journal로 함께 확정하고 적용 전 ZIP은 같은 잠금 안에서 fsync·CRC 확인까지 완료한다.
- NTP와 기존 Google HTTPS 응답 Date로 시간을 보정한다. 캐시 응답을 제외하고 왕복·정밀도 오차를 포함하며 더 정확한 기준을 낮추지 않는다. 추가 API 호출은 없으며 절전 복귀 시 기준을 다시 확인한다.

## 현재 관련 검사

- `check-profile-sync-model.ts`: 실제 SQLite 원자 journal/실패/병합/충돌/시각/삭제/재전송/ACK/재시작/다른 PC 백업/민감 정보 제외.
- `check-profile-sync.ts`: 두 SQLite PC + 운영 coordinator, 동시/오프라인/첫 연결/선택 격리/타이머/쿼터/ACK 유실/전송 중 저장/DB 복원/계정 변경 — 개별 검사 43회 확인·21회 업로드 통과.
- `check-profile-sync-drive.ts`: 운영 HTTP transport, 페이지/cursor/본문 크기/타입/기기/생성 ID/If-Match/401·403·429·410·412·404/취소 — 36 HTTP 계약.
- `check-profile-sync-ui.ts`: 제품 설정/preload/IPC/SQLite/ZIP, 첫 연결·병합·충돌·미저장 교체 보호·실제 교체·실패 rollback·측정 소유자 삭제 보호와 800×600 표시를 검사한다.
- `check-profile-sync-budget.ts`: 실제 66개 숙제와 1/5/20/50프로필의 합성 압축 크기/저장 시간, 1,000회 저장 후 journal 압축과 호출 예산.
- 직접 영향받은 기존 저장/lifecycle 검사는 통과. lifecycle의 옛 전체 동기화 중지 단언은 새 프로필 protocol 준비로 갱신했으며, 옛 전송 취소 검사는 별도로 유지한다.

## 최종 판정과 외부 확인

완료 판정은 [재개발 검증](../../docs/development/google-sync-verification.md)과 `output/profile-sync-acceptance/latest.json`의 소스 해시/관련 게이트를 따른다. 이전 실패/통과 결과는 각각의 실행 폴더에 그대로 보존한다. Windows 검사 파일의 짧은 공유 잠금은 완성된 명령 파일 교체와 한정 재시도로 보완하며 제품 실패를 숨기지 않는다.

2026-11-04 14:28 KST, 최종 22개 게이트 모두 통과. 소스 SHA-256: `bb9993e9592fe04df4959660752ae5215b00e420945fd11effa71f10db52a527`. 구현과 관련 자동 검증은 완료했다.

14:37 KST, 두 PC 요청 겹침 보강: `check-profile-sync-concurrency.ts`가 독립 Electron 프로세스 2개/별도 DB/운영 HTTP transport·coordinator + loopback Drive로 10가지 상황과 실제 업로드 겹침 7차례를 통과했다. 다른 프로필/같은 필드/숙제, 응답 역순, 전송·수신 중 저장, 한쪽 실패/취소, 삭제 경합을 확인했다. 제품 코드는 수정하지 않았다. 관련 타입 검사·빌드·동시성 개별 검사를 실행했고 전체 묶음은 반복하지 않는다. 이후 완료 acceptance는 이 검사를 포함해 23개 게이트이며, 기존 22개 결과는 과거 소스의 기록으로 보존한다. 실계정/물리 PC 두 대 검증을 대신하지 않는다.

실서비스 검사는 `npm run test:profile-sync:live`로 제공한다. 임시 userData/격리 test namespace에서 사용자 직접 OAuth 후 왕복·조건부 갱신·충돌 해결을 검사하고 검사 파일만 정리한다. 실제 Google 계정/Cloud Console quota·p95는 자동 검사로 확인할 수 없다. 미실행을 통과로 표현하지 않는다.

14:28 KST 격리 실서비스 검사를 시도했으나 OAuth 직접 로그인 60초 제한시간이 종료됐다. Drive 파일 생성 전에 끝났으며 임시 인증은 해제했다. `output/profile-sync-live/latest.json`은 failed/realGoogleVerified=false다. 남은 외부 확인은 직접 로그인 후 실계정 왕복, 실제 Cloud Console quota/저장공간/네트워크 p95와 기존 릴리즈 실기 절차다.

조사: Google 공식 appdata, changes.list, files.generateIds, manage-uploads, limits 문서를 2026-11-04 확인했다. changes.list 100 units, 본문 다운로드 200, 쓰기 50, 신규 공개 프로젝트 기준 1,000,000 units/분. 실제 프로젝트의 적용 quota는 Cloud Console 확인이 필요하다.

일상 변경은 관련 검사만 선택한다. 전체 npm test/전체 프로필 acceptance를 매번 반복하지 않는다. 개발 검증 단계에서는 버전·커밋·push·릴리즈를 수행하지 않았다. 이후 사용자가 명시적으로 요청한 `3.5.0-beta.1` 프리릴리즈 준비와 브랜치/태그 push는 [테스트 배포 기록](../../docs/development/prerelease-3.5.0-beta.1.md)을 따른다. CI가 설치 파일을 만들며 main 병합·Draft 자동 게시는 포함하지 않는다.
