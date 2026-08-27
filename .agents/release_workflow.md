# 📦 TW-Overlay 릴리즈 워크플로우

이 문서는 새 버전의 검증, Windows 설치 파일 생성, 태그 및 GitHub Release 배포 절차를 정의합니다.

> **릴리즈 절대 조건:** 일반 자동 검사, 관리자 권한 Windows 통합 검사, 사용자 실기 체크리스트와 설치 파일 검증이 모두 통과하기 전에는 태그 생성, 원격 태그 푸시, GitHub Release 게시 또는 Microsoft Store 제출을 진행하지 않습니다. 미실행 항목은 통과로 간주하지 않습니다.

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
- [ ] `src/assets/notice/notice.json` 및 첨부 이미지(`src/assets/notice/`) 갱신
  - 공지 팝업은 프로그램 용량 최적화를 위해 버전별 누적이 아닌 `src/assets/notice/` 단일 폴더에서 최신 공지만 관리합니다.
  - **첨부 이미지는 사용자가 직접 제작/캡처하여 첨부합니다.** (AI 에이전트가 임의로 생성하지 않음)
  - 사용자가 준비한 이미지를 `src/assets/notice/` 폴더에 `notice_1.png`, `notice_2.png`, `notice_3.png` ... 형식으로 번호 순서대로 배치하면 앱에서 자동으로 감지하여 순서대로 노출하고 클릭 시 확대 보기(Lightbox)를 제공합니다.
  - 공지 텍스트는 일반 사용자가 이해하기 쉬운 단어들로 구성하고, 사용자 입장에서 읽어야 할 주요 변경 사항 및 사용법 위주로 작성합니다.
  - `notice.json`의 `version` 필드를 새 릴리즈 버전(`X.Y.Z`)과 반드시 일치시킵니다.
- [ ] 구조, 개발 규칙 또는 배포 방식이 달라졌다면 `.agents/AGENTS.md` 갱신
- [ ] 기술 스택, 디렉터리 역할 또는 핵심 실행 흐름이 달라졌다면 `.agents/PROJECT_GUIDE.md` 갱신
- [ ] UI 토큰이 달라졌다면 `.agents/DESIGN_TOKENS.md` 갱신

## 3. 의존성 및 검증

### 3.1 일반 자동 게이트

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
- `npm run test:stress`
  - 초당 100건 이상 burst와 10초간 1,200건 지속 유입에서 채팅·숙제·XP·렌더 DOM 정합성 및 이벤트 루프 지연 검사
- `npm audit --omit=dev`
  - 실제 설치 패키지에 포함되는 프로덕션 의존성의 알려진 취약점 검사
- `git diff --check`
  - 공백 오류, conflict marker와 잘못된 patch 형식 검사

### 3.2 관리자 권한 Windows Z-order 통합 게이트

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

[`docs/v3-release-manual-test-checklist.md`](../docs/v3-release-manual-test-checklist.md)를 실제 릴리즈 후보 설치 파일로 수행합니다.

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

Section 3.4와 Section 5의 모든 체크가 완료되고 working tree가 clean인지 확인한 뒤에만 아래 명령을 수행합니다.

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
   - `latest.yml`

Electron Builder의 GitHub Publisher를 직접 사용하지 않습니다. 설치 파일과 blockmap을 병렬 게시할 때 각각 Draft를 생성하는 경쟁 상태를 막기 위해 패키징과 Release 업로드를 분리합니다.

필요한 GitHub Secrets:

- `GA_MEASUREMENT_ID`
- `GA_API_SECRET`
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
  - ASAR의 앱 버전·main 진입점·Windows Store 업데이트 차단 분기
  - Windows x64용 Koffi·better-sqlite3 네이티브 모듈
* 이미 생성된 특정 파일은 다음과 같이 독립 검증합니다.

```powershell
npm run verify:appx -- dist_electron/twOverlay-X.Y.Z.appx
```

* **패키지 식별자**: `package.json`의 `appx` 설정(`applicationId: twOverlay`, `identityName: FilbertLab.TW-Overlay`, `publisher: CN=6BAF7511-7890-43A4-8630-498F620A5370`)을 참조합니다.
* **Store 아이콘**: `build/appx/` 폴더의 `StoreLogo.png`, `Square44x44Logo.png`, `Square150x150Logo.png`, `Wide310x150Logo.png`를 사용합니다. 파일이 누락되면 Electron 기본 AppX 자산으로 대체되므로 빌드 후 패키지 내부 자산을 확인합니다.
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
- [ ] 첫 실행과 완전 종료 후 두 번째 실행 모두 `A JavaScript error occurred in the main process` 대화상자가 없다.
- [ ] 주요 오버레이 하나와 숙제 체크리스트를 열고 종료할 수 있다.
- [ ] Store 빌드에서 GitHub 자체 업데이트 다운로드가 시작되지 않는다.
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

* MS Store를 통해 설치한 사용자는 **Windows OS의 Microsoft Store 서비스가 백그라운드에서 자동으로 최신 버전 패키지를 갱신**합니다.
* 앱 내부의 자체 GitHub 업데이터는 MS Store 환경(`process.windowsStore === true`)에서 안전하게 비활성화되어 스토어 샌드박스 충돌 및 앱 중복 설치를 원천 방지합니다.

