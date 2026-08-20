# 🎨 TW-Overlay 디자인 토큰 가이드

이 문서는 TW-Overlay의 모든 HTML 화면에서 일관된 사용자 경험(UX)과 시각적 정체성을 유지하기 위한 디자인 표준을 정의합니다. 모든 UI 개발 시 본 문서를 엄격히 준수하십시오.

## 1. 기본 테마 (Base Theme & Glassmorphism)
- **배경 (Background)**: 다크 테마를 기본으로 하며, 투명도와 블러 효과를 적극 활용합니다.
  - `Panel Glass`: `rgba(15, 18, 30, 0.96)` 배경 + `backdrop-filter: blur(20px) saturate(180%)`
  - `Sidebar Glass`: `rgba(20, 20, 35, 0.95)` + `backdrop-filter: blur(15px)`
  - `Card Background`: `rgba(255, 255, 255, 0.03)` 또는 `rgba(30, 35, 60, 0.4)`
  - `Borders`: `1px solid rgba(255, 255, 255, 0.08)` (Subtle) 또는 `rgba(255, 255, 255, 0.12)` (Medium)

## 2. 창 규격 및 가독성 표준 (Window Size & Readability)
사용자가 오버레이 및 창 내부의 텍스트를 게임 플레이 도중에도 쉽고 기민하게 인지할 수 있도록 아래 규격을 반드시 준수합니다.

### 2.1 창 최소 규격 표준
- **메인 설정 창 (`settings.html`)**: 최소 **`800px x 600px`** 권장 (글자가 짤리거나 버튼이 겹치지 않도록 충분한 여백 확보)
- **독 런처 (`dock.html`)**: 가로 **`800px`**, 세로 **`380px`**로 창 영역을 생성하여 팝업 메뉴 배치 공간 확보
- **간이 팝업 및 독립 설정 창**: 최소 너비 **`400px`**, 최소 높이 **`300px`** 이상 확보
- **인게임 오버레이 브라우저**: 가로/세로 비율에 맞춰 사용성을 해치지 않는 영역 지정

### 2.2 폰트 및 시인성 하한선
- **최소 폰트 크기**: 일반 텍스트, 설명 텍스트, 캡션 등 모든 텍스트는 최소 **`0.75rem` (12px, Tailwind `text-xs`) 이상**을 만족해야 합니다. (이보다 작을 경우 글자 뭉개짐 발생)
- **가이드 및 레이블 크기**: 중요 타이틀이나 양식 설명글은 **`0.875rem` (14px, Tailwind `text-sm`) 이상**을 지향합니다.
- **명도 대비 보장**: 어두운 유리 배경 위에서 텍스트 색상은 `#ffffff` (`text-white`) 혹은 최소 `#cbd5e1` (`text-slate-300`)을 유지하여 가독성을 확보하고, `#475569` 등 어두운 텍스트 배치를 지양합니다.

## 3. 색상 (Colors)

### 3.1 시스템 컬러 (System Colors)
- **Brand (Purple)**: `#a855f7` (Tailwind `purple-500`) - 강조색, 핵심 버튼, 브랜드 정체성
- **Danger (Red)**: `#ef4444` (Tailwind `red-500`) - 종료, 경보, 삭제, 필드보스 경보
- **Info (Blue)**: `#3b82f6` (Tailwind `blue-500`) - 안내, 정보, 도움말 FAQ
- **Success (Green)**: `#22c55e` (Tailwind `green-500`) - 완료, 활성화, 최적화 적용

### 3.2 기능별 시그니처 컬러 (Feature Signature Colors)
TW-Overlay의 각 기능은 고유의 시그니처 색상을 가집니다. **기능의 아이콘 색상, UI 포인트 색상, 그리고 서브메뉴 칩 컬러는 반드시 아래 표와 일치시켜야 합니다.**

| 기능 (Feature) | 시그니처 색상 (Signature Color) | Tailwind Class | 주요 용도 |
| :--- | :--- | :--- | :--- |
| **모험 일지** | Teal (`#14b8a6`) | `teal-400` | 일지 메인 탭, 활동 기록 |
| **갤러리 모니터** | Purple (`#a855f7`) | `purple-400` | 갤러리 모니터링 화면 |
| **외치기 히스토리** | Sky (`#38bdf8`) | `sky-400` | 최근 24시간 외치기 기록 |
| **마정석 계산기 / 수익** | Orange (`#f97316`) | `orange-400` | 수익 그래프, 시드 합계, 마정석 정산 |
| **필드 보스 / 사기 감지** | Red (`#f87171`) | `red-400` | 보스 알림, 처치 기록, 사기꾼 탐지 AI |
| **숙제 체크 리스트** | Violet (`#a78bfa`) | `violet-400` | 컨텐츠 수행 여부, 완료 상태 |
| **약어 사전** | Blue (`#60a5fa`) | `blue-400` | 테일즈위버 용어/약어 사전 |
| **장비 사전** | Pink (`#f472b6`) | `pink-400` | 테일즈위버 장비 사전 |
| **버프 백과 / 득템** | Amber (`#fbbf24`) | `amber-400` | 도핑 아이템 정보, 득템 알림 |
| **버프 타이머** | Orange (`#fb923c`) | `orange-400` | 핵심 버프 게이지, 타이머 설정 |
| **거래 게시판** | Emerald (`#34d399`) | `emerald-400` | 매직위버 연동, 매물 알림 |
| **계수 계산기 / 로그** | Indigo (`#818cf8`) | `indigo-400` | 캐릭터 계수 분석, 로그 분석 설정 |
| **디스코드 알림** | Cyan (`#22d3ee`) | `cyan-400` | 디스코드 알림 소리 및 웹훅 전송 설정 |
| **경험치 HUD** | Blue (`#60a5fa`) | `blue-400` | 경험치 HUD 설정 및 초기화 |
| **에타 랭킹** | Yellow (`#facc15`) | `yellow-400` | 실시간 에타 랭킹 조회 |
| **진화 계산기** | Lime (`#a3e635`) | `lime-400` | 진화 재료 및 비용 계산 |
| **커스텀 알림** | Pink (`#f472b6`) | `pink-400` | 사용자 지정 반복 알림 |
| **제복 시뮬레이터** | Rose (`#fb7185`) | `rose-400` | 제복 염색 미리보기 |
| **시스템 공통** | Slate (`#94a3b8`) | `slate-400` | 홈, 오버레이 토글, 마우스 투과, 환경 설정 |

## 4. 모양 및 간격 (Layout & Shape)
- **Border Radius**:
  - `Card / Section`: `1.5rem` (`rounded-2xl` / 24px)
  - `Button / Input / Menu Chip`: `0.75rem` (`rounded-xl` / 12px)
  - `Outer Window`: `0.75rem` (`rounded-xl` / 12px) - 윈도우 모서리
- **Shadows & Glows**:
  - `Box Shadow`: `0 10px 30px rgba(0, 0, 0, 0.5)` (미려하고 차분한 깊이감)
  - `Glow Effect`: 버튼 호버 시 테마 색상과 매칭되는 미세 발광 그림자 지원 (`box-shadow: 0 0 16px var(--theme-glow)`)
- **Spacing**:
  - `Section Padding`: `1.5rem` (`p-6`)
  - `Item Gap`: `1rem` (`gap-4` 또는 `space-y-4`)

## 5. 런처 배치 및 플라이아웃 서브메뉴 규격 (Launcher & Submenu)
메인 런처(사이드바/독바)는 22개 이상의 메뉴를 5대 카테고리로 압축 노출하며, 호버 시 가로/세로 방향으로 서브메뉴를 팝업합니다.

### 5.1 사이드바 배치 (왼쪽 / 오른쪽)
- 사이드바 위치 설정을 몸체(`body`)의 `data-sidebar-pos` 데이터 속성에 바인딩하여 팝업 방향을 자동 대칭시킵니다.
- **오른쪽 배치**: 서브메뉴 플라이아웃이 **왼쪽**으로 뻗어나갑니다 (`right: 48px`, `left: auto`, `flex-direction: row-reverse`).
- **왼쪽 배치**: 서브메뉴 플라이아웃이 **오른쪽**으로 뻗어나갑니다 (`left: 48px`, `right: auto`, `flex-direction: row`).
- 마우스 오버 감지 버퍼(10px)를 적용하여 메뉴 이동 시 창이 강제로 좁아지거나 투과되는 현상을 방지합니다.

### 5.2 독(Dock) 배치 (상단 독 / 하단 독)
- **하단 독 (`dock`)**: 독바가 창 하단에 부착되며 서브메뉴가 **위쪽(Top)**으로 팝업됩니다 (`bottom: 56px`, `top: auto`).
- **상단 독 (`dock-top`)**: 독바가 창 상단에 부착되며 서브메뉴가 **아래쪽(Bottom)**으로 팝업됩니다 (`top: 56px`, `bottom: auto`). 툴팁 역시 아래로 슬라이드 팝업되도록 오버라이드합니다.

## 6. 공통 컴포넌트 스타일 (Common Components)

### 입력 필드 (Input Field)
- `bg-black/40`, `border-white/10`, `focus:border-purple-500`, `transition-all`, `rounded-xl`
- 텍스트 크기: `0.875rem` (`text-sm`)

### 버튼 (Buttons)
- **Primary**: `bg-purple-600`, `hover:bg-purple-500`, `shadow-lg shadow-purple-900/20`
- **Icon Button**: `bg-purple-500/10`, `border-purple-500/30`, `text-purple-400`, `hover:bg-purple-500`, `hover:text-white`

### 소리 및 알림음 설정 (Sound & Alarms)
- 환경 설정의 사운드 관련 탭 공식 명칭은 **`소리 및 알림음 설정`**으로 지칭합니다.
- 사용자가 볼륨 크기를 조정함과 동시에, 보스 알림/지정 단어 알림/사용자 지정 알림/디스코드 등 상황별 알림음 설정 창으로 바로 전환할 수 있는 **바로가기 링크 카드**를 반드시 함께 제공하십시오.

### 스크롤바 (Scrollbar)
- `custom-scroll` 클래스 사용
- 트랙: `transparent`, 핸들: `rgba(255, 255, 255, 0.1)`, 핸들 호버: `rgba(255, 255, 255, 0.2)`

## 7. 애니메이션 (Animations)
- `transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1)`
- 클릭 시: `active:scale-95`
- 카드 호버: `hover:translate-y-[-2px]`, `hover:bg-white/[0.08]`
