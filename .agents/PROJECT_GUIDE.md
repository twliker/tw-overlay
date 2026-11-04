# TW-Overlay 프로젝트 가이드

이 문서는 TW-Overlay의 현재 구조와 주요 실행 흐름을 설명합니다. 버전별 변경 이력은 `release-note`, 사용자 기능 설명은 `README.md`, 작업 규칙은 `AGENTS.md`를 기준으로 합니다.

향후 검토할 작업은 [향후 할 일](./development/future-tasks.md)에 기록합니다.

프로필 숙제 기본값은 `profileStartup`이 `contentsChecker.loadDefaultItems()`로 검증한 실제 배포 목록을 주입합니다. `DEFAULT_CONFIG.contentsCheckerItems`는 빈 초기값이므로 새 프로필 기본 목록으로 직접 사용하지 않습니다. `ApplicationData`는 시작·백업 재연결·Google 수신 시 누락 기본 항목만 원자적으로 보충하고 기존 정의·상태·순서와 명시적 삭제를 보존합니다. 실제 목록/부팅/별도 재시작 검사는 `test:profile-homework-defaults`, 실제 화면 검사는 `test:profile-checklist`입니다.

로컬 프로필의 기능 완료 판정은 [프로필 자동 검증 기준](../docs/development/profile-acceptance-matrix.md)을 따릅니다. `npm run test:profiles:acceptance`가 관련 검사·강제 종료 복구·12개 실제 Windows 창 조합·현재 패키지 검사를 실행하고 소스/패키지 해시를 기록합니다. `test:profiles:proof`로 현재 결과인지 확인합니다. 일상 변경은 기존처럼 작업 관련 검사만 선택하며 배포 실기 게이트는 별도입니다.

## 프로젝트 개요

TW-Overlay는 테일즈위버 게임 창을 추적하여 사이드바, 게임 오버레이, 전용 브라우저와 각종 보조 도구를 제공하는 Windows용 Electron 애플리케이션입니다.

주요 기능 영역은 다음과 같습니다.

- 게임 창 추적 및 사이드바·오버레이 배치
- 채팅 로그 실시간 분석과 경험치·버프·숙제·알림 처리
- 원하는 사용자와 내 대화를 분리해 표시하는 집중 대화방
- 숙제 체크리스트와 모험 일지·통계
- 보스, 거래, 갤러리, 사용자 정의 조건 알림
- 계산기, 시뮬레이터, 사전과 편의 도구
- `llama-server`를 이용한 로컬 사기 탐지

## 기술 스택

- 언어: TypeScript
- 런타임: Node.js, Electron
- 화면: HTML, CSS, Tailwind CSS, Lucide Icons, Chart.js
- Windows 연동: Koffi를 통한 Win32 API 호출
- 로컬 데이터: `electron-store`, SQLite (`better-sqlite3`)
- 로그 감시: `tail`
- 로컬 LLM: `llama-server`와 GGUF 모델
- 패키징: `electron-builder`, NSIS
- 네이티브 모듈 ABI 동기화: `npm ci` 후 `electron-builder install-app-deps` 자동 실행
- 자동 배포: GitHub Actions의 Windows runner

브라우저에서 직접 로드되는 일부 HTML 화면에는 화면 전용 JavaScript가 남아 있습니다. 메인 프로세스, preload, 공통 모듈, 분리된 렌더러 모듈과 빌드·테스트 도구의 원본은 TypeScript를 사용합니다.

## 주요 디렉터리

- `src/main.ts`: 앱 생명주기와 최상위 초기화 순서를 관리합니다.
- `src/modules`: 메인 프로세스의 기능별 모듈입니다.
- `src/modules/scam`: 로컬 모델, 서버, 세션 등 사기 탐지 하위 모듈입니다.
- `src/shared`: 프로세스와 화면에서 공유하는 타입과 상수의 단일 원본입니다.
- `src/renderer`: HTML에서 로드하는 기능별 TypeScript 렌더러 모듈입니다.
- `src/assets`: 로컬 라이브러리, 데이터, 이미지와 사운드 리소스입니다.
- `src/*.html`: 각 창의 마크업과 화면 전용 로직입니다.
- `scripts`: TypeScript로 작성한 빌드·검증 도구입니다.
- `dist`: 앱 실행용 컴파일·복사 결과물입니다.
- `dist-tools`: `scripts`의 컴파일 결과물입니다.
- `dist_electron`: Windows 설치 파일 출력 디렉터리입니다.
- `.agents`: 프로젝트 구조, 작업 규칙, 디자인 토큰과 릴리즈 절차의 현행 문서입니다.
- `.gemini`: 과거 조사와 작업 기록 보관소이며 현행 기준 문서가 아닙니다.
- `release-note`: 버전별 변경 이력입니다.

`dist`, `dist-tools`, `dist_electron`은 생성물입니다. 원본 코드나 문서를 이 디렉터리에서 직접 수정하지 않습니다.

## 실행 구조

### 앱 초기화

로컬 프로필 개발은 `docs/development/profile-storage.md`와 `.agents/development/local-profiles-plan.md`를 따른다. 현재 저장 기반·관리 UI/IPC·게임 감지 경계·기존 Google 중지 경계·모험일지 공유 연결/프로필별 저장·조회 및 ZIP 백업 연결을 구현했다. main에서 profileApplication을 통해 일반 부팅과 기록 경계를 연결했다. 실제 사용자 폴더를 개발 검사에 사용하지 않는다. 프로필 이름은 자유로운 표시 이름이다. 기존 userServer를 필수 프로필 설정으로 사용하며 채팅로그 실제 닉네임의 에타 조회와 공유한다. 프로필 이름을 캐릭터 이름으로 요구하거나 에타 조회 키로 사용하지 않는다.

일지의 조회 범위와 수동 기록 대상은 독립적이다. `diaryProfileAccess.ts`가 IPC 필터/대상을 검증하고 `renderer/diary-profiles.ts`가 일지·마정석·보스 기록의 입력 대상을 고정한다. `renderer/diary/profile-filter.ts`의 조회 범위는 현재 플레이 프로필을 바꿔도 같은 ID를 유지하며 모든 조회 및 내보내기에 전달한다. 검사는 `npm run test:diary-profiles-ui`로 제품 화면/preload/IPC/공유 DB 및 최소 창 배치를 확인한다.

`profileStartup.initializePlayProfileStorage`는 기존 전송 중지·쓰기 확정·DB 이전/공유 연결·설정 projection·선택 대기를 순서대로 준비한다. main은 파서·게임 폴링 전에 저장소와 runtime/gate를 함께 준비한다. 로컬 ZIP의 `profileBackupRestore.ts`는 새 DB 묶음과 구형 부분 백업을 staging에서 검증/변환하며, 기기 ID는 휴대용 백업에서 제외한 `device-state.json`을 따른다. 실패 rollback 시 DB를 먼저 열고 config를 다시 읽는다. `test:profile-backup`으로 실제 ZIP·SQLite·별도 재시작을 검사한다.

이전 전 `contentsChecker.init({deferRuntime:true})`는 설정 정규화/숙제 만료 처리만 수행하고 기존 일지를 열지 않는다. 새 DB와 기록 귀속을 연결한 뒤 일지 집계·창 갱신·리셋 타이머를 시작한다. `test:profile-upgrade`는 실제 3.2.2 패키지의 저장 API로 만든 임시 데이터와 원본 DB/백업 보존을 검사한다. `test:profile-windows`는 실제 main/tracker/폴링과 제품 선택창의 세 시작 순서를 개발용 게임 대역으로 확인하고 패키지 `app.asar/dist`도 대상으로 삼을 수 있다. 현재 증거와 남은 외부 검증은 `docs/development/profile-completion-verification.md`에 기록한다.

프로필 자동 기록은 `profileParserEvents.ts`로 소유 소비자를 모으고 `ProfileService`에서 대기 원본/일지·숙제/ACK를 확정한다. 화면·소리와 추적기 상태는 `recordEffects.ts`가 commit 후 반영한다. `profileRecording.installProfileRecording`은 세션 수명과 프로필별 `profile_runtime_state`를 조립하며, 백업은 현재 실행 상태를 checkpoint한다. 실제 로그/재시도·진행 분리는 `test:profile-recording`으로 검사한다. main은 1분마다·일반 종료·Windows 세션 종료에 checkpoint하며 ZIP 실패 후 원래 실행 상태와 파일 입력을 이어받는다.

과거 채팅 로그 복원은 `ProfileService.beginHistoricalRestore`에서 선택된 ID/설정/세션을 고정한다. 작업 중 전환·삭제·프로필 설정/숙제 편집을 거부하고 자동 이벤트는 내구성 있는 대기열에 저장한다. 종료 시 원래 세션의 대기만 재생하며 새 미선택 세션은 남긴다. `profileLogRestore.ts`는 `app-data.db`의 프로필별 offset/집계와 공통 원본 fingerprint/귀속 구간을 사용한다. 기록·구간·확정 위치는 한 transaction으로 저장한 뒤 worker에 ACK한다. 이미 귀속된 구간은 다른 프로필에 복제하지 않으며 나중 추가 구간은 새 선택에 반영한다. 외치기는 공통으로 유지한다. 구형 JSON은 fingerprint/미배정 구간 증거로만 읽고 수정하지 않는다. 출처 위치 없는 구형 미배정 일 합계는 보존한 기준량을 빼 차액만 기록한다. 이 진행 정보는 Google 변경 이력에 넣지 않으며 ZIP의 DB에 포함한다. 실제 worker/SQLite/설정 창 검사는 `test:profile-log-restore`, 기존 오늘 tail/catch-up은 `check-refactor-regressions.ts`로 확인한다.

계수 계산기와 버프 백과의 캐릭터 입력은 `profile_tools`에 저장한다. `profileToolsIpc`는 로컬 도구 창과 허용 키를 검사하고 페이지마다 저장 대상 token을 고정하며, `profileToolTransition`은 전환 전에 실제 도구 입력을 저장한다. `renderer/profile-tool-storage.ts`는 프로필 모드에서 DB를 사용하고 기존 모드에서만 공용 localStorage를 사용한다. 최초 준비 시 실제 브라우저 저장값을 각 이전 프로필에 한 번 복사한다. 도구 입력은 ZIP에 DB와 함께 포함되며 새 DB 백업의 오래된 공용 키로 덮어쓰지 않는다. 관련 검사: `test:profile-tools`, `test:profile-backup`, `test:buffs`.

`src/main.ts`의 `app.whenReady()`가 최상위 오케스트레이터입니다.

정상 초기화 전에 중단된 ZIP 복원을 롤백하고, 대기 중인 `renderer-storage.json`을 `rendererStorageBackup.ts`의 숨김 file 창에서 적용합니다. 이 창을 닫는 시점에는 `window-all-closed`로 종료하지 않으며, 일반 시작 창을 만든 뒤부터 기존 종료 정책을 사용합니다. 로컬 ZIP 복원은 config·DB·Drive 전송을 잠근 상태에서 교체하고 성공 시 재시작까지 잠금을 유지합니다.

일반 설정의 외부 저장과 클라우드 수신은 `runtimeSettings.ts`를 공유합니다. 명시적 저장은 patch의 항목을 값이 같아도 재적용하고 수신은 실제 변경만 반영합니다. `renderer/settings/draft.ts`는 같은 프로필의 미저장 입력을 보존합니다. 새 Google 경로는 `profileSyncModel`의 원자 journal/후보/vector, `profileSyncDrive`의 PC별 압축 JSON/변경 feed/조건부 갱신, `profileSyncCoordinator`의 단일 예약, `profileCloudSync`의 프로필 잠금/백업/runtime 조립입니다. 본문 조회의 version과 ETag를 얻은 v2 version이 같은지 검사하고 If-Match로 갱신합니다. 구형 전송은 계속 중지하며 기존 JSON/outbox를 자동 수용하거나 삭제하지 않습니다. 현행 계약은 `development/google-drive-sync-contract.md`, 완료 검사는 `test:profile-sync:acceptance`, 실계정 검사는 사용자 직접 로그인하는 `test:profile-sync:live`입니다.

두 PC의 실제 요청 겹침은 `npm run test:profile-sync-concurrency`로 검사합니다. 별도 Electron 프로세스 2개와 SQLite 저장소에서 운영 HTTP 전송·동기화 실행기를 실행하며 Google 서버만 loopback 대역으로 바꿉니다. 두 업로드를 동시에 보류해 A/B 응답 순서를 바꾸고 전송·수신 중 편집, 한쪽 실패와 연결 해제, 삭제 경합을 확인합니다. 결과는 `output/profile-sync-concurrency/latest.json`에 프로세스 ID·요청 겹침·검사 파일 해시와 함께 기록합니다. 실제 Google 계정과 물리 PC 2대 실기 검증은 별도입니다.

프로필 설정 전환은 `profileSettingsTransition.ts`가 제품 설정 창의 초안·저장 중·위치 편집 상태를 확인하고 저장/버리기/취소를 받는다. 전환 확인 중 입력을 잠그고 저장은 원래 프로필 ID로 수행한다. `profileSettingsAccess`는 늦은 다른 프로필 요청을 메인에서 전체 거부한다. `draft.setOwner`는 실제 새 소유자 수신 뒤에만 초안을 초기화하며 이전 소유자의 성공 ACK를 무시한다. 선택/이름/서버 변경은 설정 창에도 새 설정을 보내고 같은 프로필의 수신은 기존 merge를 유지한다. 필수 서버가 없으면 기본 서버를 임의 선택하지 않는다. 관련 검사: `test:profile-settings`, `test:audit`, `test:hud-edit-settings`.

숙제창은 프로필 모드에서 `renderer/contents-checker/profile.ts`를 통해 고정 ID/요청 ID를 전달한다. `profileChecklistIpc.ts`는 로컬 숙제 페이지·인수·캐릭터 ID를 검증하고 설정/일지/요약/로컬 ACK를 한 transaction으로 확정한다. `pending_profile_events`의 `manual-checklist:<requestId>`는 enqueue+ACK가 원자적이며 프로필 선택 대기로 남지 않는다. 반복 확인은 이미 확정한 작업을 다시 적용하지 않는다. 화면은 저장 실패/늦은 응답에서도 편집값을 보존하고 `profileChecklistTransition`은 저장/버리기/취소와 결과 미확인 보호를 조립한다. 프로필의 기존 캐릭터 관리/선택 IPC는 차단하며 일반 모드의 기존 경로는 유지한다. 관련 검사: `test:profile-checklist`, `test:checklist`, `test:window-visibility`.

사냥 경험치 계산기·경험치 HUD·버프 타이머·보스 설정·커스텀 알림은 `renderer/profile-settings-page.ts`로 프로필 설정 화면을 연결한다. 각 화면의 입력을 받은 ID로 확정 저장하고, 현재 프로필의 미저장 값/편집 폼/진행 중 저장은 외부 config 수신으로 덮지 않는다. 저장 성공은 제출한 필드만 초안 기준에 반영하며 다른 입력과 이전 프로필의 늦은 ACK를 승인하지 않는다. `profileSettingsAccess.ts`는 이 로컬 페이지들의 ID 생략/다른 ID 저장도 거부하며 기존 `profileSettingsTransition`이 저장/버리기/취소와 실패 후 잠금 해제를 조립한다. 비동기 알림음 목록도 소유자 세대로 확인한다. 실패한 새 항목은 입력을 보존하되 취소하면 목록에 남지 않고 재시도는 같은 항목 ID를 사용한다. 관련 검사는 실제 5개 창/SQLite의 `test:profile-settings-pages`, 기존 화면만 검사하는 `test:settings-pages`, main 설정의 `test:profile-settings`, 보스 일지의 `test:diary-profiles-ui`다. 일반 부팅 연결은 profileApplication의 계약을 따른다.

설정의 즉시 적용은 `applySettingsWithDraft`에서 저장 성공을 확인한 뒤 제출한 필드와 배열만 초안 기준에 반영합니다. `form-collection.ts`가 값 수집과 함께 해당 필드 ID를 기록하므로 다른 탭의 초안은 저장 완료로 처리하지 않습니다. 라디오는 그룹별, 메뉴 표시 여부는 메뉴 ID별로 보존하며, 비동기 생성된 메뉴는 초기값 적용 후 초안 기준에 등록합니다.

게임 HUD 창에서 저장한 좌표는 메인에서 발신 창을 확인하고 `config-data`의 선택적 `ConfigDataContext.savedHudPositionKeys`로 알립니다. `windowManager.applySettings`는 저장 성공 때만 이 정보를 보내며, 설정 화면은 해당 좌표 필드의 이전 초안만 새 위치로 교체합니다. 숙제 항목 수정은 새 초기화 규칙을 원래 수행 시각에 먼저 적용한 뒤 최대 횟수를 보정하므로 지난 주기의 기록을 오늘 완료로 바꾸지 않습니다.

선택지가 없는 select는 아직 초안 기준에 넣지 않고 알림음 초기화 직후 등록합니다. 저장 중 설정 수신이 있었다면 수신값과 현재 입력을 비교하여 사용자 편집만 저장 승인하며, 객체는 하위 항목별로 처리합니다. 클라우드 적용과 되돌리기는 `applyLoadedConfigToRuntime`으로 기능·창 적용을 공유하지만, 백업 생성과 cloud dirty 억제는 수신 경로만 담당합니다.

거래 검색의 `tradeSearchState`는 키워드별 확인 위치와 이미 알린 글 번호 구간을 config에 보관합니다. 성공한 키워드는 일부 실패와 독립적으로 알리고, 실패한 키워드는 이전 위치부터 재개합니다. 모든 활성 키워드가 지나간 중복 방지 구간은 삭제합니다. 이 상태는 로컬 ZIP에는 포함하고 Drive 동기화에서는 제외합니다.

1. preload의 동기 기본 설정 조회가 가능하도록 IPC 핸들러를 먼저 등록합니다.
2. 사용자 사운드 프로토콜과 기본 창·트레이를 준비합니다.
3. 모험 일지 DB를 초기화하고 보존 기간에 따른 정리를 예약합니다.
4. 게임 창 추적기를 등록합니다.
5. 폴링, 보스, 사용자 정의 알림과 외부 모니터를 시작합니다.
6. 채팅 로그 경로를 복구하거나 자동 탐색합니다.
7. 에타 캐시를 먼저 불러온 뒤 채팅 처리기, 로그 감시기와 버프 타이머를 시작합니다.
8. 설정이 활성화된 경우 로컬 사기 탐지 모니터를 시작합니다.

반복 호출될 수 있는 `start()`와 등록 함수는 중복 타이머, 중복 이벤트 리스너와 중복 콘솔 출력이 생기지 않도록 멱등성을 유지해야 합니다.

### 사용자 전체 창 숨김·복원

사용자 전체 숨김은 `userWindowVisibility.ts`의 메모리 세션과 `windowManager.ts`의 공통 표시 가드로 처리합니다. 트레이와 선택 단축키가 같은 API를 호출하며, 영구 표시 설정을 끄거나 renderer를 닫지 않습니다. 게임 최소화/종료 중에도 이 세션의 창과 초안은 보존하고, 게임에 붙는 창은 현재 게임 가시성에 맞춰 복원합니다. 자동 대화 열기와 늦은 로딩 완료는 사용자 숨김을 해제하지 않습니다.

숙제 자동 접기는 renderer `contents-checker/auto-collapse.ts`의 조작·모달 보호와 `contentsWindowCollapse.ts`의 임시 네이티브 크기를 연결합니다. 접힌 56px 높이는 설정에 기록하지 않으며 프리셋 캡처에서도 펼친 높이를 사용합니다. 옵션 저장은 기존 확정 저장 IPC를 사용합니다.

### 시간 측정

시간 측정은 `stopwatchSession.ts`의 메인 세션이 단축키와 버튼을 함께 처리합니다. 시작 때 `rendererStorageBackup.ts`의 지정 키 조회로 file-origin 계수 프로필과 도핑을 캡처하고, 종료 때 SQLite에 한 번 저장합니다. 관리 창과 게임 HUD는 revision이 있는 상태를 구독하고 재생성 시 조회하므로 창 수명과 측정 수명이 분리됩니다. `stopwatchCalculation.ts`는 시작 스냅샷과 과거 기록 재계산의 공통 계산식입니다.

프로필 저장소가 연결되면 `profileStopwatch.ts`가 프로필별 메모리 세션을 제공하고 시작 입력 당시 DB의 계산기/도핑·프로필·플레이 세션을 고정합니다. 다른 프로필로 전환해도 원래 시계는 계속되며 원래 프로필에서 종료합니다. 선택 대기는 측정을 차단하고 진행/저장 중 소유자 삭제도 거부합니다. 앱 종료 시 미종료 측정은 기존처럼 보관하지 않습니다. 기록은 공유 app-data.db의 원래 프로필에 한 번 저장하며 Google 대상이 아닙니다. 기록 화면은 전체/현재/지정/미배정/삭제 프로필을 조회하며 제목 편집 중 갱신·프로필 전환·저장 실패에도 입력을 보존합니다. 확정 저장 IPC는 원래 행 ID를 사용하고 구형 도핑은 원래 소유자의 값만 읽습니다. 관련 검사: `test:profile-stopwatch`, 기존 모드 `test:stopwatch`. 일반 부팅은 profileApplication이 조립합니다.

### Windows 자동 실행

`autoStart.ts`는 배포 종류별로 등록을 분리한다. NSIS는 관리자 권한 VBS/Run 등록을 유지하고, Store는 manifest의 `TWOverlayStartup`을 `storeAutoStart.ts`와 Store 도우미의 WinRT API로 제어한다. StartupTask는 일반 권한 WinExe 도우미를 호출하며, 도우미가 버전 없는 패키지 AppsFolder ID를 활성화해 앱의 UAC 실행을 요청한다. 개발 실행은 등록을 변경하지 않는다.

Store의 첫 실행은 구버전 launcher의 내용과 Run 항목 소유권을 확인해 Store 등록만 정리한다. Store 설정 변경은 직렬 적용하고 Windows의 `DisabledByUser`/정책 상태를 보존한다. `scripts/check-auto-start.ts`와 `verify-appx-package.ts`가 마이그레이션·동시 변경·실제 NSIS 바로가기 및 Store 패키지 구성을 검사한다.

NSIS의 VBS 대상 바로가기는 Electron `shell.writeShortcutLink`로 동기 생성하고 성공한 경우에만 Run에 등록한다. WScript.Shell의 시스템 ANSI 문자셋 의존성과 cscript의 오류 시 종료 코드 0 문제를 피한다. 자동 실행 검사는 한글·공백 및 ANSI 문자셋 밖의 이모지 경로에서 실제 바로가기를 읽어 검증하고, 생성 실패 시 등록하지 않는지 확인한다.

### 채팅 로그 처리

채팅 기반 기능은 다음 흐름을 공유합니다.

```text
채팅 로그 파일
  → ChatLogManager: 파일 탐색·tail 감시·재연결
  → ChatLogNormalizer: 문자셋 판별·잘린 연속 메시지 복원
  → ChatParser: HTML 정리·메시지 분류·타입 이벤트 발생
  → ChatLogProcessor: 기능별 처리와 화면 전송
  → 숙제/일지/경험치/버프/알림 모듈
```

- `chatLogManager.ts`는 로그 파일의 변경과 교체를 감시하고 스트림을 복구합니다.
- `chatLogNormalizer.ts`는 EUC-KR·UTF-8 로그를 판별하고, 같은 시각·색상의 명백히 잘린 조각만 결합합니다.
- `chatParser.ts`는 정규화된 로그를 `src/shared/types.ts`에 정의된 이벤트 데이터로 변환합니다.
- `itemAcquisition.ts`는 직접 획득, 펫 줍기, 서버 알림 등 아이템 획득 표현을 이름·수량·출처가 있는 공통 데이터로 변환합니다.
- `chatLogProcessor.ts`는 파서 이벤트를 숙제 카운팅, 모험 일지, 경험치 추적, 오버레이와 알림에 연결합니다.
- `todaySummary.ts`는 오늘의 모험 일지 합계와 선택 캐릭터의 미완료 숙제를 읽기 전용 요약으로 만들며, 게임 오버레이는 이를 경험치 HUD 위에 최대 3개씩 간략히 표시합니다.
- 집중 대화방은 `chatLogProcessor.ts`의 현재 세션 채팅을 공유하며, 내 닉네임만 일반 설정에 저장하고 상대 및 자동완성 후보는 창이 열린 동안 메모리에만 유지합니다.
- 여러 소비자가 함께 쓰는 채팅 상수는 `src/shared/chatConstants.ts`에서 관리합니다.
- 큰 수치는 문자열의 정수 형식을 안전하게 파싱한 뒤 JavaScript `Number` 범위 안에서 처리합니다.

새 채팅 규칙을 추가할 때는 파서의 판별, 공유 이벤트 타입, 처리기의 부수 효과와 회귀 샘플을 함께 갱신합니다.

### 과거 채팅 로그 복원

설정에서 실행하는 과거 로그 복원은 실시간 tail 처리와 분리된 유한 작업으로 수행합니다.

```text
모험 일지 보관 기간의 ChatLog 파일
  → ChatLogSyncManager: 대상·fingerprint·정책 버전 확인
  → ChatLogSyncWorker: 별도 worker에서 인코딩 판별·배치 분석
  → 메인 프로세스: event ID 멱등 반영·파일별 ACK·진행 상태 저장
  → DiaryDB / 현재 reset cycle의 숙제 체크리스트
```

- `chatLogSyncState.ts`는 파일별 snapshot, 확정 offset과 정책 fingerprint를 원자 저장해 재시작 뒤에도 이어서 처리합니다.
- 숙제 이벤트는 로그 날짜가 아니라 이벤트 시각의 일일·주간 reset cycle이 현재 cycle과 같은 경우에만 체크리스트에 반영합니다.
- 오늘 날짜의 자동 채팅 기록을 재구성할 때는 실시간 tail을 완전한 로그 줄 경계에서 잠시 멈추고 해당 snapshot을 트랜잭션으로 교체합니다. 분석 중 파일에 추가된 로그는 snapshot 뒤 byte 범위를 순서대로 catch-up한 후 일반 tail에 빈틈없이 인계합니다. 안전한 tail 인계가 불가능한 실행 환경에서는 파일 변경 시 기존 기록을 보존하는 멱등 병합으로 전환합니다.
- 득템 등록 판정은 파싱된 실제 아이템명의 정확 일치를 사용하며, 부분 문자열 포함으로 다른 아이템을 기록하지 않습니다.

### 프로세스 경계와 IPC

- 메인 프로세스의 Node.js·Electron 기능은 `src/modules`에 둡니다.
- 화면에는 각 preload가 필요한 기능만 타입이 지정된 API로 노출합니다.
- IPC 채널 등록은 `ipcHandlers.ts`에서 관리하며 임의 채널을 전달받는 범용 API를 만들지 않습니다.
- sandbox preload의 창·HUD 기본 위치는 메인 프로세스가 제공하는 단일 기본 설정 원본을 동기 조회합니다.
- 브라우저 렌더러는 CommonJS 런타임에 의존하지 않아야 합니다.
- 공통 타입과 상수는 `src/shared`에 두고 메인, preload와 렌더러에 중복 선언하지 않습니다.
- 기본 설정은 `src/modules/constants.ts`의 `DEFAULT_CONFIG`를 단일 원본으로 사용합니다. sandbox preload와 설정 화면은 이 값을 노출받아 기본값 복원과 입력 보정에 사용합니다.
- 채팅 채널 목록·색상·시간 표시는 `src/shared/chatChannels.ts`, 사이드바 카테고리 표시 순서는 `src/shared/sidebarCategories.ts`를 사용합니다.
- 런처 메뉴 메타데이터는 `src/assets/data/sidebar_menus.json`을 단일 원본으로 사용하며, `src/shared/sidebarMenus.ts`가 형식과 동작 이름을 검증합니다. 트레이의 실제 동작 연결은 `src/modules/trayMenuActions.ts`에서 타입 완전성을 검사합니다.
- 사냥 경험치 계산기의 기본 도핑·사냥터와 계산식은 `src/shared/huntingExpCalculator.ts`에서 관리합니다. 사용자 추가·수정 목록, 적용 상태, 사냥터, 시간당 처치 수와 해피아워 여부는 일반 설정에 저장합니다.
- 렐릭 강화 계산기의 신조·루나리아 단계별 한도·재료·비용과 공식 강화 확률, 시뮬레이션·기댓값 계산은 `src/shared/relicCalculator.ts`에서 관리합니다. `relic-calculator-renderer.ts`는 펜던트·브라이슬릿 능력치 상세 입력과 결과 표시만 담당합니다.
- 루미나의 회랑 최적 경로 분석기의 노드 점수·소요 시간 모델·파티원 수별 시뮬레이션과 경로 탐색 엔진은 `src/shared/luminaCorridor.ts`에서 관리합니다. 스크린샷 이미지 판독 및 그리드 매칭은 `src/renderer/lumina-vision.ts`가 담당합니다.

### 데이터와 하위 호환성

- 일반 설정은 `electron-store`를 사용합니다.
- 모험 일지와 활동 통계는 `diaryDb.ts`의 SQLite DB를 사용합니다.
- `activity_logs.amount`는 합산 가능한 수치 데이터의 원본이며, 이전 문자열 기록을 보완하는 자동 마이그레이션을 유지합니다.
- 숙제 시스템 정의는 정적 리소스에서 읽고 사용자 정의 숙제와 캐릭터별 상태는 기존 사용자 설정과 호환되도록 마이그레이션합니다.
- 읽을 수 없는 설정 파일은 덮어쓰기 전에 별도 원본으로 보존하고 사용자에게 복구 경로를 알립니다.
- 구형 HUD 위치 필드는 로드 시 현재 필드로 한 번만 이전합니다.

DB 스키마나 저장 형식을 바꿀 때는 기존 사용자 데이터를 직접 폐기하거나 강제로 초기화하지 않고, 반복 실행해도 안전한 마이그레이션을 추가합니다.

### 윈도우와 UI

- `windowManager.ts`가 사이드바, 오버레이와 보조 창의 생성·배치·가시성을 관리합니다.
- 일반 보조 창의 정적 크기·HTML 정의는 `managedWindowRegistry.ts`, 저장 크기와 리사이즈 정책은 `managedWindowSizing.ts`에서 관리합니다. 런타임 창 참조와 기능별 열기·닫기 콜백은 `windowManager.ts`가 연결합니다.
- 멀티 모니터 교차 판정과 작업 영역 중앙 좌표 계산은 부수 효과가 없는 `windowPlacement.ts`에서 관리하며, 복구 위치 저장은 `windowManager.ts`가 담당합니다.
- 활성 창 순서, 네이티브 Z-Order용 핸들 배열, 개발자 도구 방어와 게임 포커스 복구 타이머는 `windowFocusController.ts`가 관리합니다.
- 프로그램이 요청한 창 이동과 빠른 사용자 드래그를 구분하는 상태는 `programmaticMoveTracker.ts`가 관리합니다.
- `windowMovePersistence.ts`는 드래그 중 설정 처리를 생략하고 이동 완료·숨김·닫힘 때 최종 위치를 저장합니다. 네이티브 드래그가 끝나기 전에는 커서가 멈춰도 자동 위치·Z-order 보정을 막습니다.
- 제복 색상·검 강화처럼 외부 페이지를 포함하는 도구의 `WebContentsView` 생성, 콘텐츠 영역 배치와 정리는 `embeddedWebTool.ts`가 담당합니다.
- 브라우저 오버레이 툴바의 마우스 진입·이탈 상태와 자동 숨김 타이머는 `overlayToolbarController.ts`가 관리합니다.
- 게임 해상도 캐시, 전체화면 판정, 오버레이·보조 창·사이드바의 목표 좌표와 크기 계산은 `windowLayout.ts`가 담당하며, Electron 창 조작은 `windowManager.ts`에 남깁니다.
- 게임 창 좌표는 멀티 모니터와 DPI 배율을 고려해 Electron DIP 좌표로 변환합니다.
- 게임 프로세스는 실행 파일 경로 조회에만 접근하며, 폴링이나 창 추적 과정에서 프로세스 우선순위를 변경하지 않습니다.
- 게임이 최소화되거나 종료된 경우 관련 창의 표시 상태를 함께 조정합니다.
- 자동 Z-order 관리는 게임 HWND를 anchor로만 읽고 외부 프로그램의 전경·순서를 바꾸지 않습니다. 단, 외부 프로그램에서 사용자가 작업표시줄의 TW-Overlay 창을 직접 선택한 경우에는 최소화되지 않은 게임을 한 번 전경으로 올린 뒤 선택 창에 포커스를 돌려 두 프로그램이 같은 작업 묶음처럼 보이게 합니다.
- 창·HUD 기본 위치는 `src/shared/windowPositions.ts`에서 관리하며, 사용자가 실제 저장한 위치와 기본값을 구분합니다.
- 오늘 요약 HUD는 기본적으로 경험치 HUD 위에 배치하고, 같은 위치의 어벤던로드 위젯이 활성화되면 겹치지 않도록 그 위로 이동합니다. 표시·접힘·위치는 `채팅 로그 설정 > 오늘 요약 HUD`에서 관리합니다. 기본 단축키 `Ctrl+Shift+Y`는 접힘 → 펼침 → 숨김 → 접힘 순서로 상태를 순환합니다.
- 보조 창은 어느 화면과도 전혀 겹치지 않을 때만 현재 게임 디스플레이 중앙으로 복구합니다.
- 공통 창 옵션과 메시징은 `windowOptions.ts`, `windowMessaging.ts` 등 전용 모듈을 우선 사용합니다.
- UI를 변경할 때는 `DESIGN_TOKENS.md`와 기존 DOM 계약을 유지합니다.
- 설정 화면의 저장 입력 수집, 수신 설정의 DOM 입력 반영, 전역 단축키 녹화·기본값 복원, 사이드바 메뉴 표시와 알림음·볼륨 제어처럼 독립 가능한 로직은 `src/renderer/settings`의 TypeScript 모듈로 분리하며, `settings.html`은 기존 마크업과 초기화 오케스트레이션을 유지합니다.
- 설정 화면의 왼쪽 메뉴는 9개의 1depth 분류만 표시하고, 2depth는 콘텐츠 상단 가로 탭으로 렌더링합니다. 2depth 항목은 앵커 이동이 아니라 선택한 설정 콘텐츠만 표시하는 독립 화면 방식으로 동작합니다.

## 빌드와 검증

### 읽기·알림·창 정렬

- `customChatFonts.ts`는 사용자가 선택한 글꼴을 `userData/custom_fonts`에 해시 ID로 복사합니다. 설정/프리셋/클라우드에는 ID만 저장하고 실제 파일은 로컬 ZIP 백업에 포함합니다. renderer의 `custom-chat-fonts.ts`가 실제 FontFace 로드와 기본 글꼴 대체를 담당합니다.
- 고정 메모의 글자 크기·색·배경은 기존 설정 초안/저장 경로와 `companion-hud.ts`에서 함께 사용합니다. 내용은 개인 기록으로 유지하고 읽기 설정은 프로필 환경설정에 포함합니다.
- `notification-priority.ts`는 겹치는 게임 안내의 시각 우선순위만 다룹니다. 기존 감지·기록·시간 경과는 바꾸지 않습니다. `desktopNotification.ts`의 득템 묶음은 Windows 토스트에만 적용하며 `ui-utils.ts`의 반복 토스트 묶음은 사이드바/게임 오버레이에서 공유합니다.
- `shared/windowSnap.ts`는 같은 좌표 공간에서 정렬할 위치를 계산합니다. HUD는 기존 위치 편집의 저장/취소를 사용하고, 독립 창은 기본 꺼짐인 `windowSnapEnabled`를 켠 경우에만 드래그 종료 때 `windowMovePersistence.ts`가 최종 위치를 맞춰 저장합니다.
- `check-companion-reading.ts`와 `check-window-visibility.ts`에서 글꼴 파일·저장 경합·실제 renderer와 BrowserWindow 좌표를 검증합니다. 실게임·실제 마우스 드래그·DPI 하드웨어·설치 검증과 구분합니다.

### 기록 내보내기·설정 공유·채팅 간단 표시

- `modules/companionFiles.ts`는 설정 파일 공유와 일지 HTML 내보내기의 typed IPC·네이티브 파일 선택을 담당합니다. renderer는 파일 경로/설정 payload 대신 main이 보관한 토큰을 사용하며, 선택 그룹별 비교 이후 관련 설정이 달라지면 적용을 거절합니다. 저장 성공 이후 기존 runtime 적용과 `windowManager.applySharedWindowLayout`을 호출합니다.
- `modules/settingsShare.ts`의 명시적 그룹/필드 목록은 공유 범위의 단일 원본입니다. 전체 백업과 달리 열림 상태·개인 데이터·연동·사용자 파일은 포함하지 않습니다. 가져온 창 배치는 현재 작업 영역으로 제한하며 숙제창 접힘 상태는 `ContentsWindowCollapse.updateExpandedSize`로 보존합니다.
- `diaryDb.getDiaryExportSnapshot`은 기존 득템 표시 기준·수익 amount를 사용해 기간 데이터를 읽고, `diaryExport.ts`는 외부 요청/스크립트 없는 HTML로 출력합니다. 확인한 스냅샷을 저장하며 채팅 원문과 개인 메모는 제외합니다.
- `chatChannels.applyReadingDisplay`는 채팅 간단 표시를 메인·보조·집중·설정 예시에 공통 적용합니다. 설정 변경은 기존 외관 갱신/가상 목록 앵커 보존 경로를 사용합니다. `check-companion-files`, `check-companion-reading`, `check-renderer-behavior`, `check-window-visibility`가 관련 실제 파일·DB·Electron 경로를 검사합니다.

### 개발 명령과 회귀 테스트 선택

일상 개발의 검증 범위는 [AGENTS.md](./AGENTS.md)의 **개발 중 검증 범위**를 따릅니다. 변경한 기능의 계약과 [기능 계약 인덱스](./development/feature-contract-index.md)에서 관련 테스트를 찾고, `package.json`에 정의된 명령만 선택합니다.

예를 들어 마정석 수익 기록만 변경했다면 다음과 같이 실행합니다. 다른 기능을 수정했다면 해당 테스트 명령으로 바꿉니다.

```powershell
npm run typecheck
npm run build
npm run test:magic-stone
```

- `npm run typecheck`: 코드 변경 시 앱과 도구 TypeScript를 검사합니다.
- `npm run build`: 최신 앱·도구 결과물을 만듭니다. 같은 소스 상태에서 이미 빌드했다면 반복하지 않으며, 실행 중인 검사와 겹치지 않습니다.
- `npm run test:<기능>`: 해당 작업과 직접 연결된 회귀 검사만 실행합니다. 실제 명령 이름은 `package.json`에서 확인합니다.
- 개별 npm 명령이 없는 관련 검사는 빌드 후 `electron dist-tools/<해당 검사 파일>.js`로 실행할 수 있습니다. 여러 기능이 묶인 검사에 부분 실행 기능이 없다면 관련 파일 전체를 실행합니다.
- `npm test`: 전체 빌드와 전체 회귀·Electron 검사를 실행합니다. 매 작업의 기본 검사가 아니며, 광범위한 영향으로 범위를 특정하기 어렵거나 공통 회귀가 확인된 경우, 사용자 요청 또는 릴리즈 최종 검증에 사용합니다.
- `npm run dev`: 빌드 후 개발 모드로 앱을 실행합니다.
- 문서만 수정했다면 내용·링크와 `git diff --check`만 확인합니다.

선택한 검사가 통과한 뒤에는 새 변경이나 실패 근거 없이 검사를 확대·반복하지 않습니다. 설치 파일 생성과 배포 시에는 `release_workflow.md`의 전체 검증 절차를 따릅니다.

## 문서 관리

- 구조, 핵심 데이터 흐름 또는 기술 스택이 바뀌면 이 문서를 갱신합니다.
- 개발 규칙과 검증 계약이 바뀌면 `AGENTS.md`를 갱신합니다.
- 디자인 규격이 바뀌면 `DESIGN_TOKENS.md`를 갱신합니다.
- 빌드, 패키징 또는 배포 과정이 바뀌면 `release_workflow.md`를 갱신합니다.
- 사용자 기능과 설치 안내는 `README.md`, 버전별 변경 이력은 `release-note`에 기록합니다.
- `.gemini/GEMINI.md`의 오래된 버전 이력과 경로 설명은 참고 기록일 뿐 현행 문서로 복원하지 않습니다.

### 프로필 일반 부팅/저장 수명 (2026-11-04)

`profileApplication`은 구형 Google 중지→이전 전 스냅샷→숙제 정규화→저장소/기록 gate→새 Google 조립 순서이며 main은 게임 폴링과 일반 창 전에 이를 기다립니다. main 시작 완료 뒤 새 스케줄러를 켜고 `observeProfileGameState`의 표시/최소화/종료 상태를 전달합니다. 1분·전환·백업·종료 checkpoint, byte 원본 귀속/대기/ACK, 완료 원문의 30일 영수증 및 ZIP 실패 catch-up은 기존 로컬 계약을 유지합니다. 새 동기화는 프로필·숙제·휴대 가능한 설정만 전송하고 일지/채팅/실행 상태를 제외합니다. 활동 프리셋 UI/IPC는 제거한 상태입니다. 계약/검사: feature-contract-index, `test:profile-lifecycle`, `test:profile-sync:acceptance`.
