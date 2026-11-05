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
| P04 | 앱 먼저/보이는 게임 먼저는 선택창을 표시한다. 최소화·숨김 시작은 세션/기록 대기만 준비하고 게임이 처음 보일 때 한 번 표시한다. 숨김 중 직접 선택했으면 복귀 때 재표시하지 않는다. 사이드바/독 × 창모드/전체화면의 12개 조합을 확인한다. | profile-windows, profile-storage, profile-lifecycle |
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
| P23 | 기본 설정으로 만든 신규/추가/마지막 삭제의 프로필은 실제 기본 숙제 전체를 표시한다. 이전 베타의 누락은 기존 행·진행·정렬·커스텀·명시 삭제를 보존하며 복구하고, 실패 rollback·별도 재시작 후 중복 방지를 확인한다. 설정 가져오기는 P24를 따른다. | profile-homework-defaults, profile-checklist |
| P24 | 설정 가져오기 UI는 실제 기본/커스텀 숙제의 수정값·숨김·순서·N/A와 원본 삭제를 복사하며 완료 횟수/시각을 새로 시작한다. 원본 보존·복사 실패 rollback·재시작·다른 PC 수신을 확인한다. | profiles-ui, profile-homework-defaults, profile-storage, profile-sync-model |
| P25 | 선택창은 최초 표시부터 최신 게임창 중앙이며 다른 모니터/DPI·작업 영역 이탈·저장 위치를 처리한다. 직접 이동은 유지하고 다시 열면 중앙을 사용한다. 좌표 조회 중 새 전체 숨김/닫기와 입력을 보존한다. | profile-placement, profile-windows, window-visibility |
| P26 | 각 프로필의 일일/주간 완료 수·퍼센트·진행률 바가 체크리스트 기준과 일치한다. 숨김/N/A·부분 횟수·비활성 만료·일요일/시간 경계·대상 없음을 처리하며 조회는 선택/DB/이력을 바꾸지 않는다. 갱신/실패/늦은 응답/복구 중에도 초안·포커스·선택을 보존한다. | profile-homework-progress, profiles-ui, profile-checklist |
| P27 | 게임 종료 안내에 살아 있는 모든 프로필의 탭·남은 개수와 마지막 사용 기본 선택을 제공한다. 완료한 프로필도 유지하며 숨김/N/A/완료 제외·비활성 만료/부분 횟수를 체크리스트 기준으로 표시한다. 이름 중복/긴 이름/많은 탭·키보드/안내·닫기·실패/복구를 처리하고 실제 선택/세션/DB/이력은 바꾸지 않는다. | game-exit-reminder, profile-homework-progress, profiles-ui, profile-windows --with-reminder |
| P28 | 프로필 선택은 작은 기본/최소 창에서 목록·진행률을 유지하고 편집은 필요할 때 펼친다. 필수 설정 노출·초안 보호, 미배정 감지 종류/최근 대표 내용/배정 확인, 현재 세션 제외·원본 무변경·과거 형식/손상/긴 원문/다중 종류/실패/늦은 응답을 처리한다. | profiles-ui, shared-contracts, profile-placement, profile-windows의 관련 조합 |

## 판정 범위

이 완료 판정은 로컬 프로필의 기능·저장·복구·제품 화면·패키지 내용에 대한 자동 검증이다. 실제 게임 대역은 프로세스/창 상태를 재현하고 제품의 tracker·폴링·preload·IPC·파서·SQLite를 실행한다. 시스템 자동 실행 변경과 원격 서비스는 분리한다.

실제 게임의 보호 모듈/권한 조합, 관리자 권한 Windows Z-order, NSIS 신규 설치·업데이트 실행은 배포 환경 검증으로 유지한다. 자동 기능 검증의 통과를 이 항목들의 수행 증거로 표시하지 않는다. 태그·게시 조건은 [릴리즈 워크플로우](../../.agents/release_workflow.md)를 따른다.


## 2026-11-05 후속: 프로필 정렬·모험일지 정리

프로필 순서 저장/드래그·방향키/재시작·리마인더 연동, 삭제/유실된 소유자의 기록을 명시적으로 미배정으로 정리하는 흐름과 원본 보존, 입장료 구형/복원 이중 집계·음수 SEED 단위·디펜시오 명칭을 수정했다. 타입/빌드 및 관련 회귀 10개가 통과했다. 상세 검사와 소스/로그 증거는 [후속 검증 문서](profile-diary-fixes-2026-11-05.md) 및 `output/profile-diary-fixes/latest.json`이다. 기존 전체/관리자 검증은 이전 소스 기준이며 이번 관련 검사로 대체하지 않는다. 푸시하지 않았다.
