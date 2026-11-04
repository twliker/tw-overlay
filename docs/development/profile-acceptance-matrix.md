# 로컬 프로필 기능 자동 검증 기준

사용자 요청에 따라 로컬 프로필 기능은 아래 요구사항을 자동 검사로 확인해 기능 검증 완료를 판정한다. Google 동기화 재개발은 대상에 포함하지 않는다.

## 실행과 판정

```powershell
npm run test:profiles:acceptance
npm run test:profiles:proof
```

첫 명령은 타입 검사·빌드 후 프로필 관련 검사만 순서대로 실행하고 현재 코드의 패키지를 새 폴더에 만든다. 기존 3.2.2 설치 파일 또는 추출된 `app.asar`, Windows/.NET SDK가 필요하다. 원본 설치 파일은 읽기만 하며 사용자 데이터 대신 임시 설정·SQLite·채팅 파일을 사용한다.

두 번째 명령은 완료 기록의 모든 단계가 통과했는지, 검증한 소스와 패키지가 그대로인지 확인한다. 증거는 `output/profile-acceptance/latest.json`과 실행별 폴더의 보고서/로그에 남긴다. 실패·시간 초과·필요한 파일 누락·실행 중 소스 변경은 완료로 처리하지 않는다. 자동 재시도로 실패를 숨기거나 필요한 검사를 건너뛰지 않는다.

일상 수정에는 계속 변경 관련 회귀 검사만 실행한다. 이 명령은 프로필 작업을 마무리할 때 사용하는 기능 전용 완료 검사이며 매 수정마다 전체 묶음을 실행하라는 규칙이 아니다. 소스가 바뀐 뒤 과거 완료 기록을 현재 코드의 증거로 사용하지 않는다.

## 요구사항과 검사 연결

아래의 **빈 기본 프로필**은 이름·서버·진행 기록이 비어 있다는 뜻이다. 숙제 목록은 실제 배포 기본 목록 전체를 포함해야 한다. 기본값을 임의 목록으로 바꾼 fixture만으로 이 조건을 통과 처리하지 않는다.

| ID | 사용자 관점의 합격 조건 | 검사 |
|---|---|---|
| P01 | 신규 설치는 빈 기본 프로필 하나이며 이름·서버 설정이 필수다. | profile-storage, profiles-ui, profile-lifecycle |
| P02 | 기존 캐릭터 N개는 N개 프로필로 이전하고 현재 사용자 설정·숙제 횟수·N/A를 보존한다. | profile-storage, profile-upgrade |
| P03 | 기존 일지를 단일 DB로 보존하고 귀속을 모르는 과거 기록은 미배정으로 남긴다. | profile-diary, profile-upgrade |
| P04 | 앱 먼저/게임 먼저/최소화된 게임 먼저 시작 모두 선택창을 표시한다. 사이드바/독 × 창모드/전체화면의 12개 조합을 확인한다. | profile-windows |
| P05 | 선택창을 닫아도 자동 기록은 대기하며 실제 시스템 메뉴로 다시 열어 선택하면 한 번 반영한다. | profile-windows, profile-recording |
| P06 | 최소화·복귀는 같은 세션이고 게임 재시작은 새 선택을 요구한다. 창을 닫은 뒤 최소화한 게임을 자동으로 펼치지 않는다. | profile-windows, profile-lifecycle, window-visibility |
| P07 | 프로필 이름은 자유로운 표시 이름이며 서버는 기존 환경설정과 같은 값이다. 오래된 요청은 다른 프로필에 쓰지 못한다. | profiles-ui, profile-settings, profile-settings-pages |
| P08 | 숙제는 프로필당 한 열이며 완료·N/A·정의·정렬·편집 입력과 실패 후 재시도를 분리한다. | profile-checklist |
| P09 | 설정 편집 중 전환의 저장/버리기/취소, 지연 응답·저장 실패·다음 입력을 보존한다. | profile-settings, profile-settings-pages |
| P10 | 계수 계산기·버프 입력을 분리하고 스톱워치는 시작 당시 프로필과 계산값에 고정한다. | profile-tools, profile-stopwatch |
| P11 | 일지 조회 필터와 수동 저장 대상을 구분하고 전체/프로필/미배정/삭제 프로필의 합계·내보내기가 일치한다. | profile-diary, diary-profiles-ui |
| P12 | 실제 파서 이벤트의 일지·숙제·ACK는 함께 확정한다. 실패 시 원문을 보존하며 재시도·같은 ID로 중복 적용하지 않는다. | profile-recording, profile-storage |
| P13 | 과거 복원의 시작 프로필/세션을 고정하고 이미 귀속되거나 배정 대기인 byte 구간을 다른 프로필에 복제하지 않는다. | profile-log-restore, profile-lifecycle, profile-crash |
| P14 | ZIP 복구의 실패 rollback·중단 후 재시작·새 파일 증가분을 이어받고 손상된 저장소는 빈 값으로 덮지 않는다. | profile-backup, profile-lifecycle |
| P15 | 앱을 다시 켜도 수정값·프로필 수/ID·숙제·도구 입력·기록·미배정 세션을 보존한다. | profile-lifecycle, profile-backup |
| P16 | 실제 강제 종료 후 미체크포인트 WAL의 설정·기록·대기 ID를 복구하고 이전 세션의 명시 배정·과거 재분석도 한 번만 반영한다. | profile-crash |
| P17 | 비활성 프로필의 일일/주간 만료는 선택 즉시 초기화한다. N/A·지난 완료 일지를 보존하며 집계 실패는 상태도 되돌린다. | profile-recording |
| P18 | 마지막 프로필 삭제 후 새 빈 기본 프로필을 만들고 삭제 프로필의 일지는 보존한다. | profile-storage, profiles-ui, profile-diary |
| P19 | 기존 Google 전송과 늦은 응답은 중지하고 인증·기존 로컬 변경 이력은 보존한다. 활동 프리셋 실행 경로는 제거한다. | profile-cloud-pause, profile-lifecycle, shared-contracts |
| P20 | 완료 원문 정리 후에도 중복 방지 영수증을 유지하고 같은 ID의 다른 내용은 거부한다. | profile-lifecycle, profile-storage |
| P21 | 구버전 DB 원본·이전 전 백업을 보존하며 만료된 숙제의 정상 초기화는 유지한다. | profile-upgrade |
| P22 | 패키지의 JS/HTML/CSS/JSON이 현재 빌드와 같고 검사 도구가 포함되지 않는다. 패키지 내부 코드로도 12개 창 조합과 3.2.2 이전을 통과한다. | package-integrity, packaged-windows-matrix, packaged-release-upgrade |
| P23 | 신규/추가/설정 복사/마지막 삭제의 프로필은 실제 기본 숙제 전체를 표시한다. 이전 베타의 누락은 기존 행·진행·정렬·커스텀·명시 삭제를 보존하며 복구하고, 실패 rollback·별도 재시작 후 중복 방지를 확인한다. | profile-homework-defaults, profile-checklist |

## 판정 범위

이 완료 판정은 로컬 프로필의 기능·저장·복구·제품 화면·패키지 내용에 대한 자동 검증이다. 실제 게임 대역은 프로세스/창 상태를 재현하고 제품의 tracker·폴링·preload·IPC·파서·SQLite를 실행한다. 시스템 자동 실행 변경과 원격 서비스는 분리한다.

실제 게임의 보호 모듈/권한 조합, 관리자 권한 Windows Z-order, NSIS 신규 설치·업데이트 실행은 배포 환경 검증으로 유지한다. 자동 기능 검증의 통과를 이 항목들의 수행 증거로 표시하지 않는다. 태그·게시 조건은 [릴리즈 워크플로우](../../.agents/release_workflow.md)를 따른다.
