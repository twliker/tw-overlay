# TW-Overlay 프로젝트 가이드

이 문서는 TW-Overlay의 현재 구조와 주요 실행 흐름을 설명합니다. 버전별 변경 이력은 `release-note`, 사용자 기능 설명은 `README.md`, 작업 규칙은 `AGENTS.md`를 기준으로 합니다.

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

`src/main.ts`의 `app.whenReady()`가 최상위 오케스트레이터입니다.

1. preload의 동기 기본 설정 조회가 가능하도록 IPC 핸들러를 먼저 등록합니다.
2. 사용자 사운드 프로토콜과 기본 창·트레이를 준비합니다.
3. 모험 일지 DB를 초기화하고 보존 기간에 따른 정리를 예약합니다.
4. 게임 창 추적기를 등록합니다.
5. 폴링, 보스, 사용자 정의 알림과 외부 모니터를 시작합니다.
6. 채팅 로그 경로를 복구하거나 자동 탐색합니다.
7. 에타 캐시를 먼저 불러온 뒤 채팅 처리기, 로그 감시기와 버프 타이머를 시작합니다.
8. 설정이 활성화된 경우 로컬 사기 탐지 모니터를 시작합니다.

반복 호출될 수 있는 `start()`와 등록 함수는 중복 타이머, 중복 이벤트 리스너와 중복 콘솔 출력이 생기지 않도록 멱등성을 유지해야 합니다.

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
- 제복 색상·검 강화처럼 외부 페이지를 포함하는 도구의 `WebContentsView` 생성, 콘텐츠 영역 배치와 정리는 `embeddedWebTool.ts`가 담당합니다.
- 브라우저 오버레이 툴바의 마우스 진입·이탈 상태와 자동 숨김 타이머는 `overlayToolbarController.ts`가 관리합니다.
- 게임 해상도 캐시, 전체화면 판정, 오버레이·보조 창·사이드바의 목표 좌표와 크기 계산은 `windowLayout.ts`가 담당하며, Electron 창 조작은 `windowManager.ts`에 남깁니다.
- 게임 창 좌표는 멀티 모니터와 DPI 배율을 고려해 Electron DIP 좌표로 변환합니다.
- 게임이 최소화되거나 종료된 경우 관련 창의 표시 상태를 함께 조정합니다.
- 창·HUD 기본 위치는 `src/shared/windowPositions.ts`에서 관리하며, 사용자가 실제 저장한 위치와 기본값을 구분합니다.
- 오늘 요약 HUD는 기본적으로 경험치 HUD 위에 배치하고, 같은 위치의 어벤던로드 위젯이 활성화되면 겹치지 않도록 그 위로 이동합니다. 표시·접힘·위치는 `채팅 로그 설정 > 오늘 요약 HUD`에서 관리합니다. 기본 단축키 `Ctrl+Shift+Y`는 접힘 → 펼침 → 숨김 → 접힘 순서로 상태를 순환합니다.
- 보조 창은 어느 화면과도 전혀 겹치지 않을 때만 현재 게임 디스플레이 중앙으로 복구합니다.
- 공통 창 옵션과 메시징은 `windowOptions.ts`, `windowMessaging.ts` 등 전용 모듈을 우선 사용합니다.
- UI를 변경할 때는 `DESIGN_TOKENS.md`와 기존 DOM 계약을 유지합니다.
- 설정 화면의 저장 입력 수집, 수신 설정의 DOM 입력 반영, 전역 단축키 녹화·기본값 복원, 사이드바 메뉴 표시와 알림음·볼륨 제어처럼 독립 가능한 로직은 `src/renderer/settings`의 TypeScript 모듈로 분리하며, `settings.html`은 기존 마크업과 초기화 오케스트레이션을 유지합니다.
- 설정 화면의 왼쪽 메뉴는 9개의 1depth 분류만 표시하고, 2depth는 콘텐츠 상단 가로 탭으로 렌더링합니다. 2depth 항목은 앵커 이동이 아니라 선택한 설정 콘텐츠만 표시하는 독립 화면 방식으로 동작합니다.

## 빌드와 검증

일상 개발에서 사용하는 명령은 다음과 같습니다.

```powershell
npm run typecheck
npm test
npm run dev
```

- `npm run typecheck`: 앱과 도구 TypeScript를 출력 없이 검사합니다.
- `npm test`: 전체 빌드, 정적 회귀 검사와 Electron 렌더러 동작 검사를 실행합니다.
- `npm run dev`: 빌드 후 개발 모드로 앱을 실행합니다.

설치 파일 생성과 배포 절차는 `release_workflow.md`를 따릅니다.

## 문서 관리

- 구조, 핵심 데이터 흐름 또는 기술 스택이 바뀌면 이 문서를 갱신합니다.
- 개발 규칙과 검증 계약이 바뀌면 `AGENTS.md`를 갱신합니다.
- 디자인 규격이 바뀌면 `DESIGN_TOKENS.md`를 갱신합니다.
- 빌드, 패키징 또는 배포 과정이 바뀌면 `release_workflow.md`를 갱신합니다.
- 사용자 기능과 설치 안내는 `README.md`, 버전별 변경 이력은 `release-note`에 기록합니다.
- `.gemini/GEMINI.md`의 오래된 버전 이력과 경로 설명은 참고 기록일 뿐 현행 문서로 복원하지 않습니다.
