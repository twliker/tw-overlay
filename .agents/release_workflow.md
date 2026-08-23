# 📦 TW-Overlay 릴리즈 워크플로우

이 문서는 새 버전의 검증, Windows 설치 파일 생성, 태그 및 GitHub Release 배포 절차를 정의합니다.

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

PowerShell에서는 아래 명령을 각각 한 줄씩 순서대로 실행합니다.

```powershell
npm ci
npm run typecheck
npm test
npm audit --omit=dev
```

검증 범위:

- `npm run typecheck`
  - 앱 소스 `tsconfig.json`
  - 빌드·테스트 도구 `tsconfig.scripts.json`
- `npm test`
  1. 전체 빌드
  2. `check-refactor-regressions.ts` 정적·기능 회귀 검사
  3. `check-renderer-behavior.ts` Electron DOM 통합 검사
- `npm audit --omit=dev`
  - 실제 설치 패키지에 포함되는 프로덕션 의존성의 알려진 취약점 검사

태그를 생성하기 전에 모든 검사가 통과해야 합니다.

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

## 6. 커밋, 병합 및 태그

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
4. `npm run typecheck`, `npm test`, `npm audit --omit=dev` 검증
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

Actions가 성공한 뒤 Draft Release가 하나만 생성됐는지, 위 세 파일과 릴리즈 노트가 모두 포함됐는지 확인하고 게시합니다.

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
* **패키지 식별자**: `package.json`의 `appx` 설정(`applicationId: twOverlay`, `identityName: FilbertLab.TW-Overlay`, `publisher: CN=6BAF7511-7890-43A4-8630-498F620A5370`)을 참조합니다.

### 2. Microsoft Partner Center 등록 및 제출

1. **[Microsoft Partner Center 대시보드](https://partner.microsoft.com/dashboard)** 에 로그인합니다.
2. **TW-Overlay** 앱을 선택하고 **[새 제출 시작 (Start submission)]** 을 클릭합니다.
3. **[패키지 (Packages)]** 단계에서:
   * 생성된 `dist_electron/twOverlay-X.Y.Z.appx` 파일을 업로드합니다.
4. **[스토어 등록정보 (Store listings)]** 단계에서:
   * **설명 / 기능 목록**: 릴리즈 노트 및 주요 기능 요약 입력
   * **개인정보처리방침 URL**: `https://twliker.github.io/tw-overlay/privacy/` 입력
   * **스크린샷**: `screenshot/` 폴더의 대표 기능 스크린샷 이미지 업로드
5. 검토 완료 후 **[스토어에 제출 (Submit to the Store)]** 을 클릭합니다.

### 3. MS Store 업데이트 동작 특이사항

* MS Store를 통해 설치한 사용자는 **Windows OS의 Microsoft Store 서비스가 백그라운드에서 자동으로 최신 버전 패키지를 갱신**합니다.
* 앱 내부의 자체 GitHub 업데이터는 MS Store 환경(`process.windowsStore === true`)에서 안전하게 비활성화되어 스토어 샌드박스 충돌 및 앱 중복 설치를 원천 방지합니다.

