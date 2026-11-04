# 📦 TW-Overlay 릴리즈 워크플로우

이 문서는 새 버전의 검증, Windows 설치 파일 생성, 태그 및 GitHub Release 배포 절차를 정의합니다.

> **정식 릴리즈 절대 조건:** 일반 자동 검사, 관리자 권한 Windows 통합 검사, 사용자 실기 체크리스트와 설치 파일 검증이 모두 통과하기 전에는 정식 태그 생성, 원격 태그 푸시, 정식 GitHub Release 게시 또는 Microsoft Store 제출을 진행하지 않습니다. 미실행 항목은 통과로 간주하지 않습니다. 사용자가 요청한 실기 검증용 프리릴리즈는 아래 Section 0을 따릅니다.

## 0. 사용자가 요청한 실기 검증용 프리릴리즈

2026-11-04 사용자는 다른 PC에서 검증하려면 프리릴리즈 설치본이 먼저 필요하며, 로컬 설치 파일을 만들지 않고 푸시해 GitHub Actions로 생성하도록 지시했다. 과거 3.4.x 설치 사용자도 업데이트할 수 있도록 `3.5.0-beta.1`을 확정했다. 이 승인은 해당 테스트용 브랜치·태그 푸시와 CI 빌드를 위한 것이며 정식 배포나 미검증 항목의 통과 승인이 아니다.

- 버전은 `X.Y.Z-beta.N` 등 프리릴리즈 형식으로 package.json·package-lock.json 루트·설정 화면·공지·README·릴리즈 노트를 맞춘다. `build.publish`의 GitHub `channel`도 베타는 `beta`, 정식은 `latest`(또는 생략)로 맞춘다. 기존 태그는 재사용하지 않는다.
- 로컬에서는 이번 배포 변경의 타입 검사·빌드·관련 회귀와 비밀 파일/생성물 제외를 확인한다. 설치 파일 생성과 전체 자동 검사·부하·프로덕션 의존성 검사는 기존 Actions가 수행한다. 실패한 검사를 skip/continue-on-error로 우회하지 않는다.
- CI offscreen 화면 캡처의 GPU 종료/UnknownVizError는 실패 로그를 보존하고 해당 검사의 렌더링 설정을 점검한다. `check-profile-settings-pages.ts`는 앱 ready 전 `app.disableHardwareAcceleration()`으로 software output device를 사용하고 비어 있지 않은 캡처를 필수로 확인한다. 제품의 그래픽 설정이나 실제 Windows 창 검사를 이 설정으로 대체하지 않는다. 실패한 원격 태그는 재작성하지 않고 수정된 새 `beta.N`으로 검증한다.
- 실계정 Google·실제 PC 2대·실게임·관리자 권한·실제 설치 업데이트는 해당 설치본으로 확인할 항목이다. 미검증 상태를 릴리즈 노트에 명시하고 정식 배포 전에 완료한다.
- 현재 작업 브랜치와 베타 태그만 푸시한다. main 병합이나 기존 태그 재작성은 이 절차에 포함하지 않는다.
- Actions는 `scripts/release-channel.ts`로 태그·앱 버전·GitHub publish.channel의 일치를 확인한다. GitHub provider의 채널을 명시해 베타의 `beta.yml`, 정식의 `latest.yml`처럼 해당 파일만 생성/업로드한다. 베타는 `prerelease: true`, `make_latest: false`로 Draft를 만든다. 정식 사용자는 베타를 직접 선택해 설치한다.
- 푸시만 요청받은 경우 CI 시작을 확인하고 결과 링크를 제공한다. Draft를 자동 게시하지 않는다. 정식 배포에는 Section 3.4/5의 기존 실기·설치 게이트를 모두 적용한다.

## 1. 버전 결정

Semantic Versioning 형식 `X.Y.Z`를 사용합니다.

- Major: 기존 버전과 호환되지 않는 변경
- Minor: 하위 호환되는 신규 기능
- Patch: 하위 호환되는 버그 수정

## 2. 버전 및 문서 갱신

- [ ] `package.json`의 `version`을 새 버전으로 변경 (`X.Y.Z`)
- [ ] `src/settings.html`의 앱 정보 버전(`id="app-version"` 엘리먼트 텍스트, 예: `2.6.4`)을 새 버전으로 변경 (접두사 `v` 없이 `X.Y.Z` 형식)
- [ ] `README.md`의 버전 뱃지, 최신 버전 섹션, 다운로드 링크 파일명(`twOverlay-Setup-X.Y.Z.exe`) 및 주요 기능 설명 갱신
- [ ] `release-note/CHANGELOG-vX.X.X.md` 작성
  - `Added`, `Changed`, `Fixed` 기준으로 사용자에게 의미 있는 변경 정리
- [ ] `src/assets/notice/notice.json` 및 필요한 경우 첨부 이미지(`src/assets/notice/`) 갱신
  - 공지 팝업은 프로그램 용량 최적화를 위해 버전별 누적이 아닌 `src/assets/notice/` 단일 폴더에서 최신 공지만 관리합니다.
  - 공지에 이미지가 필요하지 않으면 `images`를 빈 배열로 두고 이전 버전의 `notice_*` 이미지를 제거합니다. 이 경우 이미지 갤러리는 표시되지 않습니다.
  - **첨부 이미지는 사용자가 직접 제작/캡처하여 첨부합니다.** (AI 에이전트가 임의로 생성하지 않음)
  - 사용자가 준비한 이미지를 `src/assets/notice/` 폴더에 `notice_1.png`, `notice_2.png`, `notice_3.png` ... 형식으로 번호 순서대로 배치하면 앱에서 자동으로 감지하여 순서대로 노출하고 클릭 시 확대 보기(Lightbox)를 제공합니다.
  - 공지 텍스트는 일반 사용자가 이해하기 쉬운 단어들로 구성하고, 사용자 입장에서 읽어야 할 주요 변경 사항 및 사용법 위주로 작성합니다.
  - `notice.json`의 `version` 필드를 새 릴리즈 버전(`X.Y.Z`)과 반드시 일치시킵니다.
- [ ] 구조, 개발 규칙 또는 배포 방식이 달라졌다면 `.agents/AGENTS.md` 갱신
- [ ] 기술 스택, 디렉터리 역할 또는 핵심 실행 흐름이 달라졌다면 `.agents/PROJECT_GUIDE.md` 갱신
- [ ] UI 토큰이 달라졌다면 `.agents/DESIGN_TOKENS.md` 갱신

## 3. 의존성 및 검증

일상 개발에서는 `AGENTS.md`의 규칙에 따라 작업 관련 회귀 테스트만 선택합니다. 아래 전체 게이트는 최종 릴리즈 후보 검증에 적용하며, 개발 중 선택 검사 결과만으로 릴리즈 게이트를 통과한 것으로 간주하지 않습니다.

Google 재개발 목표의 자동 검증은 `npm run test:profile-sync:acceptance`로 관련 회귀만 실행하고 `output/profile-sync-acceptance/latest.json`에 현재 소스 해시와 단계별 로그를 보관합니다. 개발 중 작은 수정마다 전체 검사를 반복하지 않습니다. 실계정은 `npm run test:profile-sync:live`의 직접 OAuth 로그인과 격리 test namespace로 확인하며 기존 사용자 데이터/원격 파일을 사용하지 않습니다. 이 검사는 일반 자동 게이트에 넣지 않고 성공·미실행을 구분합니다. Google 기능을 정식 배포할 때에는 실제 계정 왕복·조건부 갱신·최초 복원·충돌 해결과 실효 프로젝트 quota 확인도 완료해야 합니다. 합성 크기/호출 예산은 `test:profile-sync-budget`으로 확인하며 네트워크 지연 실측을 대신하지 않습니다.

### 3.1 일반 자동 게이트

두 PC 동시 전송의 개별 회귀 명령은 `npm run test:profile-sync-concurrency`입니다. 독립 프로세스 2개와 운영 HTTP transport/coordinator에서 요청 겹침·응답 역순·전송/수신 중 저장·부분 실패·연결 해제·삭제 경합을 검사하며 전체 `npm test`와 Google 완료 acceptance에도 포함됩니다. 현재 Google 완료 묶음은 이 검사를 추가한 23개 게이트입니다. 일상 수정에는 이 개별 검사와 직접 영향받는 검사만 실행하며 이전 22개 완료 기록을 23개 통과로 소급해서 표시하지 않습니다.

PowerShell에서는 아래 명령을 각각 한 줄씩 순서대로 실행합니다. 버전·문서 갱신을 모두 반영한 최종 릴리즈 후보 커밋에서 다시 실행해야 합니다.

```powershell
npm ci
npm run typecheck
npm test
npm run test:stress
git diff --check
npm audit --omit=dev --audit-level=critical
```

검증 범위:

- `npm run typecheck`
  - 앱 소스 `tsconfig.json`
  - 빌드·테스트 도구 `tsconfig.scripts.json`
- `npm test`
  1. 전체 빌드
  2. `check-refactor-regressions.ts` 정적·기능 회귀 검사
  3. `check-renderer-behavior.ts` Electron DOM 통합 검사
  - `check-audit-regressions.ts`도 실행하여 백업·동시 동기화·설정 초안·알림 복구·계산기 경계 조건을 격리 userData에서 검사합니다.
  - 프로필 검사는 `check-profile-storage.ts`, `check-profiles-ui.ts`, `check-profile-cloud-pause.ts`를 포함합니다. 기존 캐릭터 이전 수·서버 출처·프로필/숙제 격리·저장 중단 복구·세션별 기록 배정, 실제 관리 화면/IPC와 초안·삭제, 기존 Google 전송 중지 및 인증/로컬 이력 보존을 임시 사용자 폴더에서 확인합니다. 일반 부팅/기록 경계는 profileApplication에 연결했고 릴리즈에는 실제 게임·설치 업데이트 검증도 완료해야 합니다.
  - `check-profile-diary.ts`는 공유 DB 연결/재연결·원본 보존, 프로필별 수익/지출·숙제·일 합계와 전체 집계, journal v1/v2·대기 이벤트 rollback/ACK·삭제 프로필 보존, 조회/내보내기와 보존 기간 정리를 확인합니다. 실제 과거 로그 worker의 일 합계 ID와 재구성은 `check-refactor-regressions.ts`에 포함합니다.
  - `check-diary-profiles-ui.ts`는 실제 일지/계산기/보스/사이드바 화면·preload·IPC·공유 DB로 조회 필터와 수동 대상의 분리, 삭제/미지정 대상 거부, 합계/내보내기 일치, 늦은 응답과 입력 보존, 중복 클릭·실패를 검사하고 작은 창의 화면을 캡처합니다. 실제 부팅 활성화 검증을 대신하지 않습니다.
  - `check-profile-backup.ts`는 부팅 준비 API와 실제 ZIP·공유 SQLite·별도 재시작을 검사합니다. 프로필 전체/구형 부분 복원, 기기 ID 보존, 실패 rollback·성공 후 늦은 쓰기 차단, 중단 journal 복구·손상 DB 거부를 포함하며 실제 main 부팅/종료는 refactor 격리 실행으로 확인합니다.
  - `check-profile-recording.ts`는 실제 parser/소비자/공유 DB로 선택 전 대기와 채팅 지속, commit/ACK 실패 후 한 번 재시도, 프로필별 XP·버프·어벤던로드/현황판 보존, 지난 알림 억제·이전 세션 배정 및 실제 ZIP checkpoint를 검사합니다. ZIP 입력 중지/catch-up와 종료·주기 저장은 test:profile-lifecycle로 확인합니다.
  - `check-profile-log-restore.ts` / `npm run test:profile-log-restore`는 실제 worker/SQLite/설정 HTML·preload·IPC에서 고정 프로필/세션, 구간별 중복 방지·추가 로그, 구형 미배정 합계와 수동 기록 보존, 전환/삭제 차단, 확정 위치 실패 rollback·손상 거부·재시도, 공통 외치기, 실제 오늘 tail/catch-up, 게임 종료 중 대기 및 800×600 안내를 검사합니다. 전체 `npm test`에 포함합니다. 일상 변경은 이 검사와 직접 영향 경계만 선택하며 기존 worker/오늘 이어받기는 `check-refactor-regressions.ts` 파일로 확인합니다. `test:profile-backup`은 복원 진행 정보의 실제 ZIP 보존도 검사합니다. 일반 부팅 연결은 완료했습니다.
  - `check-profile-lifecycle.ts` / `npm run test:profile-lifecycle`는 전체 npm test에 포함합니다. 임시 사용자 폴더의 실제 부팅 조립, 신규 설치의 빈 프로필/서버 필수, CRLF 원본 위치와 실시간→과거 복원 중복 방지, 미배정 세션 구간 보존, 30일 원문 압축과 영수증 재확인, ZIP 실패/복구 도중 게임 재시작·catch-up, 진행 checkpoint 및 종료 차단을 검사합니다. 실제 main 종료 probe는 기존 Drive dirty/outbox 보존과 새 전송 중지를 검사합니다. 과거 main 자동 pull/클라우드 응답 유실·부분 복원 probe는 새 프로필 부팅 정책에 맞지 않아 일반 회귀 묶음에서 제거했으며, 별도 legacy cloud 저장·재시작 검사는 유지합니다. 활동 프리셋 전용 renderer/IPC 검사는 제거하고 실제 설정 DOM/명령 부재·외부 입력 거부를 검사합니다. 공유 배치·기존 창 크기 호환 검사는 유지합니다.
  - `check-profile-tools.ts`는 실제 계산기/버프 HTML·preload·IPC·공유 DB에서 실제 저장값의 일회 이전, 프로필별 능력치/도핑, 고정 저장 대상과 잘못된 요청 거부, 편집·저장 실패 시 입력/선택 보존, 설정 복사와 활성 프로필 삭제 및 작은 창 표시를 검사합니다. `check-profile-backup.ts`는 도구 DB의 ZIP 보존과 구형 도구 저장소만 복원할 때의 변환·실패 rollback도 포함합니다.
  - `check-profile-settings.ts`는 제품 설정 HTML·preload·IPC·DB와 전환 제어를 연결해 저장/버리기/취소, 저장/전환 실패 뒤 초안 보존, 늦은 요청 전체 거부·이전 ACK 격리, 저장 중/위치 편집 보호, 미등록 입력·서버 필수, 이름 변경·삭제 및 최소 창을 검사합니다. 기존 초안/동시 저장과 HUD 편집 검사는 각각 `test:audit`, `test:hud-edit-settings`에 유지합니다.
  - `check-profile-settings-pages.ts` / `test:profile-settings-pages`는 사냥 경험치 계산기·경험치 HUD·버프 타이머·보스 설정·커스텀 알림의 실제 HTML/preload/IPC/공유 DB로 프로필별 복원, 저장/버리기/취소, 부분 저장 ACK와 다음 입력, 실패한 새 항목 취소/중복 없는 재시도, 이전 소유자/ACK/알림음 목록, 공통 0% 음량·임의 휴식 시간 보존 및 800×600 화면을 검사합니다. 전체 `npm test`에 포함하며, 기존 5개 화면과 음량 경계만 검사할 때는 `test:settings-pages`를 사용합니다.
  - `check-profile-checklist.ts`는 실제 숙제 HTML/preload/IPC/공유 DB로 프로필 관리 진입점·단일 열, 완료/N/A/정의/정렬, 일지 실패 rollback·같은 요청 재확인·응답 유실, 편집 중 저장/버리기/취소, 다음 입력/원래 귀속/효과음, 일요일·검색·추가 스크롤 및 800×600 화면을 검사합니다. 일상 개발의 기존 숙제 UI는 `npm run test:checklist`로 해당 renderer 검사와 보류 UI만 실행할 수 있습니다. 전체 `test:renderer`도 기존과 같이 이를 포함합니다.
  - `check-profile-stopwatch.ts` / `npm run test:profile-stopwatch`는 실제 관리 창/HUD/preload/IPC/SQLite에서 프로필별 동시 측정·전환/선택 대기, 시작 시 DB 스냅샷·도핑/세션 귀속, 저장 실패 재시도·삭제 보호, 전체/프로필/미배정/삭제 기록, 구형 재계산·늦은 조회·제목 초안/저장 실패와 800×600 표시를 검사합니다. 기존 스톱워치 경로는 `test:stopwatch`로 함께 확인하며 전체 `npm test`에도 포함합니다.
  - `check-shared-layout.ts`는 실제 설정 공유 UI·파일·IPC와 native 창을 연결하여 로딩 중 배치, 프리셋/다른 창 저장 순서, 숨김·접힘·입력 보존을 검사합니다.
  - `check-hud-edit-settings.ts`는 전체 설정/HUD UI와 프리셋·공유 파일·IPC·디스크를 연결해 편집 종료 후 최신 배치·표시 상태, 실패·지연 응답·창 닫기를 검사합니다.
- `npm run test:stress`
  - 초당 100건 이상 burst와 10초간 1,200건 지속 유입에서 채팅·숙제·XP·렌더 DOM 정합성 및 이벤트 루프 지연 검사
- `npm audit --omit=dev`
  - 실제 설치 패키지에 포함되는 프로덕션 의존성의 알려진 취약점 검사
- `git diff --check`
  - 공백 오류, conflict marker와 잘못된 patch 형식 검사

### 3.2 관리자 권한 Windows Z-order 통합 게이트

로컬 프로필 기능의 자동 완료 판정은 `npm run test:profiles:acceptance`와 `npm run test:profiles:proof`로 확인할 수 있다. 모든 필수 단계의 성공과 소스/패키지 해시를 기록하며, 실패·중단·변경된 과거 결과를 완료로 사용하지 않는다. 요구사항별 기준은 [`../docs/development/profile-acceptance-matrix.md`](../docs/development/profile-acceptance-matrix.md)를 따른다. 이 기능 완료 판정은 아래 관리자/실게임/실제 설치 프로그램의 배포 검증과 별개이며 해당 항목의 체크를 바꾸지 않는다.

프로필 개발의 별도 로컬 검사는 `npm run test:profile-windows`와 `npm run test:profile-upgrade`를 사용한다. 전자는 실제 main/tracker/폴링/제품 창을 일반 권한의 개발용 게임 대역으로 검사하며 `--app-root`로 패키지 내부 코드를 지정할 수 있다. 후자는 실제 3.2.2 패키지의 저장 API로 만든 임시 데이터를 이전하며 구버전 `app.asar` 추출본이 필요하다. 둘 다 아래 관리자 게이트 및 실제 설치 파일 실행을 대체하지 않는다. 준비 경로·결과·미완료 실기는 [`../docs/development/profile-completion-verification.md`](../docs/development/profile-completion-verification.md)를 따른다.

관리자 권한으로 실행한 Codex 또는 PowerShell에서 다음 검사를 실행합니다.

```powershell
npm run test:zorder:windows
```

합격 조건:

- [ ] 명령이 종료 코드 0으로 끝남
- [ ] 최종 JSON의 `passed`가 `true`
- [ ] 최종 JSON의 `elevated`가 `true`
- [ ] `windowed`와 `borderless` 결과가 모두 존재함
- [ ] 두 모드 모두 게임 foreground 보존, 외부 창 우선과 오버레이 순서 복구가 `true`

이 검사는 실제 tracker가 관리자 권한 가짜 테일즈위버를 탐지하고 실제 HWND를 사용해 창모드·창모드 전체화면 Z-order를 검증합니다. 일반 권한의 `--allow-unelevated` 실행은 테스트 도구 개발용이며 릴리즈 통과 증거가 아닙니다.

현재 `.github/workflows/build.yml`은 `npm test`만 실행하고 `npm run test:zorder:windows`는 실행하지 않습니다. 따라서 GitHub Actions 성공은 이 관리자 통합 게이트를 대체하지 않습니다. 향후 Actions에 추가하더라도 GitHub 호스팅 runner에서 실제 foreground/Z-order 안정성이 확인되기 전까지는 로컬 관리자 결과를 함께 유지합니다.

### 3.3 사용자 실기 게이트

[`development/v3-release-manual-test-checklist.md`](development/v3-release-manual-test-checklist.md)를 실제 릴리즈 후보 설치 파일로 수행합니다.

- [ ] 필수 실기 항목이 모두 체크됨
- [ ] 실패하거나 애매한 항목은 수정 후 같은 시나리오를 재검증함
- [ ] 필수 항목에 미수행 상태가 없음
- [ ] `릴리즈 차단 결함`이 비어 있음
- [ ] 최종 결과가 `통과`임

자동 테스트로 정책을 고정해 실기에서 제외한 물리적 동시 충돌과 `선택적 고위험 복원 경계`는 필수 체크 대상이 아닙니다. 그 외 필수 항목은 미실행 상태로 태그를 생성하지 않습니다. 환경상 수행할 수 없는 항목을 필수 범위에서 제외하려면 태그 작업 전에 사용자의 명시적 승인과 제외 사유를 체크리스트 및 릴리즈 기록에 반영해야 합니다.

### 3.4 태그 전 검증 판정

아래 다섯 묶음이 모두 통과해야 Section 6의 커밋·병합·태그 단계로 진행합니다.

- [ ] 일반 자동 게이트 통과
- [ ] 고처리량·지속 부하 게이트 통과
- [ ] 관리자 권한 Windows Z-order 통합 게이트 통과
- [ ] 사용자 실기 게이트 통과
- [ ] Section 5의 실제 설치 파일 검증 통과

하나라도 실패하거나 결과를 확인할 수 없으면 릴리즈를 보류합니다. 테스트 실패를 `continue-on-error`, 조건부 skip, 임의 재실행 성공 한 번 또는 구두 확인만으로 우회하지 않습니다.

## 4. 빌드 구조

`npm run build`는 다음 순서로 실행됩니다.

1. `npm run build-tools`
   - `scripts/**/*.ts`를 `dist-tools/**/*.js`로 컴파일
2. `node dist-tools/copy-resources.js`
   - 이전 `dist`를 정리
   - HTML, CSS, 정적 에셋과 렌더러 리소스를 복사
3. `tsc`
   - 메인 프로세스, preload, 공통 모듈과 렌더러 TypeScript를 `dist`로 컴파일

직접 작성한 원본 JavaScript는 사용하지 않습니다. `scripts`와 `dist-tools`는 빌드 및 테스트 전용이며 설치 패키지에는 포함되지 않습니다.

## 5. 로컬 설치 파일 검증

```powershell
npm run dist
```

`npm run dist`는 전체 빌드 후 `electron-builder --win`을 실행합니다.

- 결과 경로: `dist_electron`
- 설치 형식: NSIS one-click installer
- 파일명: `twOverlay-Setup-X.Y.Z.exe`
- 패키지 포함 대상:
  - `dist/**/*`
  - `package.json`
  - 런타임 `node_modules/**/*`
- `better-sqlite3`, `koffi` 네이티브 모듈은 ASAR 외부로 풀어 패키징

설치 파일로 다음 항목을 확인합니다.

- [ ] 신규 설치 및 앱 실행
- [ ] 기존 설정·DB를 유지한 업데이트 설치
- [ ] preload 로드 오류와 DevTools 콘솔 오류가 없는지 확인
- [ ] 주요 오버레이, 숙제 체크리스트, 채팅 감지와 계산기 화면 확인
- [ ] 앱 종료 및 자동 업데이트 재시작 확인

위 항목은 소스 개발 실행이 아닌 최종 `twOverlay-Setup-X.Y.Z.exe` 설치본으로 확인합니다. Microsoft Store를 함께 배포하는 릴리즈는 Section 9의 AppX/MSIX도 별도로 설치·실행 검증해야 합니다.

## 6. 커밋, 병합 및 태그

정식 릴리즈는 Section 3.4와 Section 5의 모든 체크가 완료되고 working tree가 clean인지 확인한 뒤에만 아래 명령을 수행합니다. 사용자 요청 프리릴리즈는 Section 0을 따릅니다.

```powershell
git status
git add .
git commit -m "chore: release vX.Y.Z"
git checkout main
git merge <작업-브랜치명>
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

- 기존 태그를 재사용하거나 덮어쓰지 않습니다.
- 잘못 생성한 로컬 태그만 삭제해야 할 경우 `git tag -d vX.Y.Z`를 사용합니다.
- 원격 태그 삭제나 재작성은 이미 배포된 업데이트에 영향을 줄 수 있으므로 별도 확인 없이 수행하지 않습니다.

## 7. GitHub Actions 배포

`.github/workflows/build.yml`은 `v*` 태그 푸시로 실행됩니다.

1. Windows runner에서 저장소 체크아웃
2. Node.js 24 설치
3. `npm ci`로 잠금 파일 기준 의존성 설치
4. `npm run typecheck`, `npm test`, `npm run test:stress`, `npm audit --omit=dev --audit-level=critical` 검증
5. GitHub Secrets의 Analytics 값을 `dist/env.json`에 주입
6. `electron-builder --publish never`로 Windows 설치 파일만 생성
7. `softprops/action-gh-release`를 한 번 실행하여 Draft Release 하나를 생성
8. 같은 단계에서 다음 자동 업데이트 파일을 해당 Draft에 일괄 업로드
   - `twOverlay-Setup-X.Y.Z.exe`
   - `twOverlay-Setup-X.Y.Z.exe.blockmap`
   - 정식은 `latest.yml`, 베타는 `beta.yml` 등 `release-channel.ts`가 선택한 채널 파일

Electron Builder의 GitHub Publisher를 직접 사용하지 않습니다. 설치 파일과 blockmap을 병렬 게시할 때 각각 Draft를 생성하는 경쟁 상태를 막기 위해 패키징과 Release 업로드를 분리합니다.

필요한 GitHub Secrets:

- `GA_MEASUREMENT_ID`
- `GA_API_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GITHUB_TOKEN`은 Actions에서 자동 제공

Actions가 성공한 뒤 Draft Release가 하나만 생성됐는지, 위 세 파일과 릴리즈 노트가 모두 포함됐는지 확인합니다. 로컬 관리자 통합 검사와 사용자 실기 게이트의 통과 기록도 다시 확인한 뒤 게시합니다.

## 8. 업데이트 정책 및 동작 방식

앱이 실행되면 **스플래시 화면에서 GitHub 최신 릴리즈를 즉시 확인**하며, 배포 유형과 사용자 설정에 따라 다음과 같이 동작합니다.

### 일반 배포 (기본 릴리즈)
릴리즈 제목이나 본문에 `[Mandatory Update]` 태그가 없는 일반 기능 개선 및 업데이트 버전입니다.

- **자동 업데이트 켜짐 (`autoUpdateEnabled: true`, 기본값)**:
  1. 앱 실행 시 스플래시 화면에 `업데이트 확인 중...` 표시
  2. 새 버전 감지 시 **스플래시 화면에서 실시간 다운로드 프로그레스바 진행** (`업데이트 다운로드 중... N%`)
  3. 다운로드 완료 시 **자동으로 앱을 재시작하여 새 버전 설치 및 업데이트 완료**
- **자동 업데이트 꺼짐 (`autoUpdateEnabled: false`)**:
  1. 앱 실행 시 스플래시 화면에서 업데이트 확인 후 스플래시가 닫히며 메인 앱 기동
  2. **사이드바 환경설정 아이콘 및 설정창 [앱 정보] 메뉴에 레드닷(알림 뱃지)만 표시** 및 새 버전 알림 전송
  3. 사용자가 설정창의 [앱 정보]에서 `다운로드 시작` 버튼을 눌러 수동으로 다운로드 및 업데이트 진행

### 강제 업데이트 (`[Mandatory Update]`)
보안 패치, 심각한 결함 수정 등 모든 사용자가 즉시 설치해야 하는 긴급 릴리즈에만 사용합니다.

Draft Release의 제목 또는 본문에 다음 태그를 포함하여 배포합니다:

```text
[Mandatory Update]
```

동작:
1. 사용자의 자동 업데이트 설정 활성화/비활성화 여부와 무관하게 **무조건 스플래시 화면 잠금**
2. 스플래시 화면에서 필수 업데이트 즉시 다운로드 진행 (`필수 업데이트 다운로드 중... N%`)
3. 다운로드 완료 시 1.5초 후 자동 재시작 및 강제 설치 완료

> Draft Release를 최종 **게시(Publish)**해야 사용자에게 실제로 적용됩니다.

## 9. Microsoft Store (AppX/MSIX) 배포 절차

Microsoft Store 등록 및 배포는 다음 순서로 진행합니다.

### 1. MS Store 전용 패키지 빌드

```powershell
npm run dist:appx
```

* **빌드 결과**: `dist_electron/twOverlay-X.Y.Z.appx`
* `npm run dist:appx`는 패키지 생성 직후 `scripts/verify-appx-package.ts`를 자동 실행합니다. 다음 항목 중 하나라도 다르면 명령 전체가 실패하므로 해당 파일을 제출하지 않습니다.
  - manifest의 Identity·Publisher·버전·실행 진입점
  - `runFullTrust`, `allowElevation`, 최소 Windows 버전
  - Koffi의 `MSVCP140.dll`·`VCRUNTIME140.dll`·`VCRUNTIME140_1.dll`을 제공하는 `Microsoft.VCLibs.140.00.UWPDesktop` framework 의존성
  - TW-Overlay 전용 타일 이미지 4개의 승인된 SHA-256과 패키지 내부 원본 일치
  - ASAR의 앱 버전·main 진입점·Windows Store 업데이트 정책 분기
  - Windows x64용 Koffi·better-sqlite3 네이티브 모듈과 Store 업데이트 도우미
* 이미 생성된 특정 파일은 다음과 같이 독립 검증합니다.

```powershell
npm run verify:appx -- dist_electron/twOverlay-X.Y.Z.appx
```

* **패키지 식별자**: `package.json`의 `appx` 설정(`applicationId: twOverlay`, `identityName: FilbertLab.TW-Overlay`, `publisher: CN=6BAF7511-7890-43A4-8630-498F620A5370`)을 참조합니다.
* **Store 아이콘**: `build/appx/` 폴더의 `StoreLogo.png`, `Square44x44Logo.png`, `Square150x150Logo.png`, `Wide310x150Logo.png`를 사용합니다. 파일이 누락되면 Electron 기본 AppX 자산으로 대체되므로 빌드 후 패키지 내부 자산을 확인합니다.
* **Store 자동 실행**: `TWOverlayStartup`은 ASAR 밖의 Store 도우미를 가리켜야 합니다. 도우미는 `asInvoker` Windows GUI 실행 파일이며, 인수 없이 시작되면 패키지 ID로 앱을 활성화합니다. `startup-enable`/`startup-disable` 명령은 WinRT StartupTask를 제어합니다. `npm test`의 자동 실행 검사와 AppX 검증이 이 구성을 확인합니다.
* **관리자 권한**: EXE의 `requireAdministrator`와 AppX의 `runFullTrust`, `allowElevation` capability를 함께 유지합니다. `allowElevation`은 Microsoft Store의 제한 capability이므로 제출 메모에 게임 창 추적·Win32 오버레이 및 네트워크 최적화 기능에 승격이 필요한 이유와 테스트 방법을 명시합니다.

### 2. 실제 Store 패키지 설치·실행 게이트

Store 제출용 AppX는 로컬에서 의도적으로 서명하지 않으며 Microsoft Store가 제출 뒤 서명합니다. 따라서 `-AllowUnsigned` 설치 실패를 제품 실행 실패로 판정하지 않습니다. 실제 실행 검증은 다음 중 하나로 수행합니다.

- Partner Center에서 서명된 패키지 또는 비공개 flight를 내려받아 설치한다.
- 제출 파일의 복사본만 Publisher가 일치하는 테스트 인증서로 서명해 격리된 테스트 PC에 설치한다. 테스트 서명본 자체는 제출하지 않는다.

설치 뒤 다음 항목을 모두 확인합니다.

- [ ] Windows 11 최신 일반 사용자 환경에서 설치가 완료된다.
- [ ] 설치된 package dependency에 `Microsoft.VCLibs.140.00.UWPDesktop` x64가 존재한다.
- [ ] 시작 메뉴의 정사각형·와이드 타일이 Electron 기본 이미지가 아니라 TW-Overlay 전용 이미지다.
- [ ] 앱을 실행하면 UAC가 한 번 표시되고 승인 뒤 사이드바가 열린다.
- [ ] 3.1.3의 Store 자동 실행이 켜진 상태에서 업데이트 후 앱을 실행하면 구형 Run/launcher가 정리되고 `TWOverlayStartup`이 켜진다. 일반 설치본을 가리키는 기존 등록은 보존된다.
- [ ] 로그아웃·로그인 후 경로 접근 오류와 콘솔 창 없이 UAC 승인 뒤 앱이 실행된다. Store 버전을 한 번 더 업데이트해도 같은 결과다.
- [ ] 앱에서 자동 실행을 끄면 다음 로그인에 실행되지 않는다. Windows에서 직접 끈 항목은 앱이 강제로 활성화하지 않는다.
- [ ] 첫 실행과 완전 종료 후 두 번째 실행 모두 `A JavaScript error occurred in the main process` 대화상자가 없다.
- [ ] 주요 오버레이 하나와 숙제 체크리스트를 열고 종료할 수 있다.
- [ ] Store 빌드에서 GitHub 자체 업데이트 다운로드가 시작되지 않는다.
- [ ] Store 일반 업데이트에서 `자동 업데이트`를 켜면 스플래시 다운로드·설치·재실행이 진행된다.
- [ ] Store 일반 업데이트에서 `자동 업데이트`를 끄면 앱이 시작되고 앱 정보 메뉴에 레드닷이 표시된다.
- [ ] Partner Center 강제 업데이트는 `자동 업데이트` 설정과 관계없이 스플래시를 잠그고 설치를 진행한다.
- [ ] Store 자동 설치가 허용되지 않은 환경에서는 Windows 동의 UI 또는 Store 열기·재시도 안내가 표시된다.
- [ ] AppX SHA-256, Windows 빌드, 설치 시각과 실행 결과를 릴리즈 체크리스트에 기록한다.

위 실행 게이트는 정적 AppX 검증으로 대체하지 않습니다. 서명된 설치본을 실제로 실행하지 못했으면 Microsoft Store 제출 준비 완료로 표시하지 않습니다.

### 3. Microsoft Partner Center 등록 및 제출

1. **[Microsoft Partner Center 대시보드](https://partner.microsoft.com/dashboard)** 에 로그인합니다.
2. **TW-Overlay** 앱을 선택하고 **[새 제출 시작 (Start submission)]** 을 클릭합니다.
3. **[패키지 (Packages)]** 단계에서:
   * 생성된 `dist_electron/twOverlay-X.Y.Z.appx` 파일을 업로드합니다.
   * 제한 capability 사용 안내에 `allowElevation` 필요성과 UAC 확인 절차를 적습니다. Microsoft의 사전 승인이 필요한 경우 `reportapp@microsoft.com`으로 사용 목적을 제출합니다.
4. **[스토어 등록정보 (Store listings)]** 단계에서:
   * **설명 / 기능 목록**: 릴리즈 노트 및 주요 기능 요약 입력
   * **개인정보처리방침 URL**: `https://twliker.github.io/tw-overlay/privacy/` 입력
   * **스크린샷**: `screenshot/` 폴더의 대표 기능 스크린샷 이미지 업로드
5. 검토 완료 후 **[스토어에 제출 (Submit to the Store)]** 을 클릭합니다.

### 4. MS Store 업데이트 동작 특이사항

* MS Store를 통해 설치한 사용자는 Windows의 백그라운드 자동 업데이트와 함께 앱 실행 시 `Windows.Services.Store` 업데이트 확인을 사용합니다.
* 일반 업데이트는 로컬 `자동 업데이트` 설정을 따릅니다. 켜져 있으면 스플래시에서 Store 패키지를 내려받아 설치하고 재실행하며, 꺼져 있으면 앱을 시작한 뒤 앱 정보 메뉴에 레드닷만 표시합니다.
* Partner Center에서 강제로 지정한 패키지는 로컬 설정에 관계없이 스플래시를 잠그고 설치합니다. `StorePackageUpdate.Mandatory` 값은 Windows가 대신 강제하지 않으므로 앱 정책으로 직접 적용합니다.
* Store의 무음 설치는 Microsoft Store 자동 업데이트가 허용되고 데이터 통신 제한이 없을 때 사용합니다. 허용되지 않으면 Windows 동의 UI를 사용하고, 실패하거나 취소하면 재시도와 `ms-windows-store://downloadsandupdates` 진입 경로를 제공합니다.
* Store 패키지에서 GitHub `electron-updater`는 계속 비활성화합니다. Store API만 사용해 NSIS 중복 설치와 패키지 ID 충돌을 방지합니다.

