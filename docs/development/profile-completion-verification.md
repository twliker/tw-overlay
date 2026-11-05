# 프로필 기능 마무리 검증

후속 사용자 검증에서 기본 숙제 목록 연결 누락과 설정 가져오기/최소화 시작의 잘못된 검사 조건이 발견됐다. 아래 내용은 당시 검사와 패키지의 역사적 결과이며 이 경로까지 검증했다는 뜻이 아니다. 현재 후속 수정과 검수 결과는 [통합 검수 기록](./profile-integration-review-2026-11-04.md)을 우선 확인한다.

이 문서는 로컬 프로필 목표의 검증 기록이다. 이후 Google 재개발로 변경된 소스의 최신 증거는 [Google 검증](./google-sync-verification.md)을 따른다. 과거 패키지/소스 해시를 후속 코드의 검증 결과로 재사용하지 않는다.

2026-11-04 작업 기록. 새 Google 동기화와 향후 메뉴 정리·로그 압축 아이디어는 이번 범위에 포함하지 않는다. 실제 사용자 폴더는 검증 데이터로 사용하지 않는다.

## 프로필 기능 완료 판정

**판정: 로컬 프로필 기능 자동 검증 완료 (2026-11-04).** 필수 26단계가 모두 통과했다. 소스/패키지의 Windows 시작 조합은 각각 12개, 총 24개를 확인했다. 실제 강제 종료/WAL 복구, 이전 세션 배정, 일일/주간 만료 초기화의 실패 rollback, 기존 DB 원본 보존과 패키지 내부 3.2.2 이전까지 통과했다. `test:profiles:proof`로 현재 소스/패키지와 완료 기록의 일치도 확인했다.

사용자 요청에 따라 기능 자체의 완료 판정은 강화한 [자동 검증 기준](./profile-acceptance-matrix.md)을 따른다. `npm run test:profiles:acceptance`는 프로필 관련 검사와 실제 제품 화면/IPC/DB/파일 감시, 강제 종료 복구, 현재 패키지의 같은 동작을 확인한다. `npm run test:profiles:proof`로 소스와 패키지 해시까지 재확인한다. 최종 결과는 `output/profile-acceptance/latest.json`에 남긴다.

추가 보완: 비활성 프로필의 일일·주간 숙제 만료를 선택 즉시 처리하고 상태/일지 집계 실패는 함께 되돌린다. N/A와 과거 완료 일지는 유지한다. 실제 SIGKILL 이후 WAL·확정 기록·미배정 ID를 복구하며 재배정·과거 재분석에서 중복이 없다. Windows 검사는 세 시작 순서 × 사이드바/독 × 창모드/전체화면의 12개 조합을 소스와 패키지에서 각각 검사한다.

아래 개별 검사와 NSIS 파일 정보는 이전 단계의 기록이다. 최신 기능 완료 판정과 현재 패키지는 위 완료 게이트의 실행별 보고서를 기준으로 한다.

## 수정한 문제

- 프로필 창을 닫은 직후 게임을 최소화하면 지연된 포커스 복구가 게임을 다시 펼칠 수 있었다. 자동 복구 허용 시점에 게임의 유효성·최소화·숨김 상태를 확인한다. 사용자가 명시적으로 실행하는 HUD 편집의 게임 복원은 유지한다.
- 프로필 이전 전 숙제 정규화가 일지 집계를 통해 기존 `diary.db`를 열고 변경할 수 있었다. 준비 단계는 설정 정규화와 만료된 숙제 초기화만 수행하며 일지·창 갱신·리셋 타이머는 새 DB 연결 후 시작한다.

## 자동 검증

| 항목 | 결과 | 근거 |
|---|---|---|
| 타입 검사·빌드 | 통과 | `npm run typecheck`, `npm run build` |
| 기존 로그·숙제·창 포커스 계약 | 통과 | `check-refactor-regressions.ts` 파일 단위 |
| 앱 종료·별도 프로세스 재시작·ZIP 실패 복구 | 통과 | `test:profile-lifecycle` |
| 실제 파서의 프로필별 기록·실패 재시도 | 통과 | `test:profile-recording` |
| 실제 main·tracker·폴링·프로필 창/IPC | 통과 | `test:profile-windows`: 앱 먼저 / 게임 먼저 / 최소화된 게임 먼저 |
| 3.2.2 저장 API가 만든 데이터 이전 | 통과 | `test:profile-upgrade`: 두 캐릭터→두 프로필, 기존 서버/설정/숙제/일지/계산기 입력·만료 처리·DB 원본 및 이전 전 백업 보존 |
| 검증용 NSIS 생성 | 통과 | `output/profile-qa-package/`, 버전은 개발 기준 3.2.2 그대로이며 배포본이 아님 |
| 패키지 내부 코드/화면의 Windows 통합 검사 | 통과 | 같은 Windows 검사를 `app.asar/dist` 대상으로 세 시작 순서 모두 실행 |
| 패키지 내부 코드로 3.2.2 데이터 이전 | 통과 | `test:profile-upgrade -- --new-root .../app.asar/dist` |
| 창모드·전체화면 Z-order 개발 검사 | 통과 | `runtime-zorder-windows-probe --allow-unelevated`, `passed=true`, `elevated=false` |
| 패키지 파일 일치·검사 도구 제외 | 통과 | 빌드 결과와 패키지의 주요 JS/HTML/preload 바이트 일치, scripts/dist-tools 제외 |

Windows 검사는 실제 게임 대역과 실제 제품 main/tracker/폴링/창/preload/IPC/SQLite/파일 감시를 사용한다. 시스템 자동 실행 변경과 원격 서비스는 분리한다. 일반 권한의 개발용 게임 대역이며 실게임 또는 관리자 권한 Z-order 통과 증거로 사용하지 않는다. 결과와 창 캡처는 `output/profile-windows/`에 남긴다.

```powershell
npm run test:profile-windows
npm run test:profile-windows -- --app-root output/profile-qa-package/win-unpacked/resources/app.asar/dist
npm run test:profile-upgrade -- --old-archive output/profile-upgrade-old/app/resources/app.asar --new-root output/profile-qa-package/win-unpacked/resources/app.asar/dist
```

이전 검사는 보관된 실제 `twOverlay-Setup-3.2.2.exe`에서 추출한 `app.asar`를 사용한다. 구버전 코드가 임시 설정·DB·file-origin 도구 입력을 만들고 새 저장소로 이전한다. OS에 설치하거나 기존 설치 경로/레지스트리를 변경하지 않으므로 설치 프로그램 자체의 업데이트 검사를 대신하지 않는다. 기본 `--old-archive` 경로에 추출본이 없으면 명시적으로 경로를 지정해야 한다.

검증용 설치 파일의 SHA-256은 `16fabb37b1fbc1102fe3a0f3869c862bcb3b4ba418c952d7434f1d66ef23db4e`이다. `output/profile-qa-package/verification.json`에 패키지 파일별 해시와 도구 제외 결과를 함께 저장했다. 기존 `dist_electron`의 3.2.2 설치 원본은 교체하지 않았다.

## 배포 환경 검증 (기능 자동 검증과 별도)

- [ ] 실행 중인 실제 테일즈위버에서 앱 시작/최소화/복귀/종료·서버가 다른 프로필 전환과 대표 콘텐츠 기록 확인.
- [ ] 관리자 권한 세션의 `npm run test:zorder:windows` 통과 (`passed=true`, `elevated=true`, windowed/borderless).
- [ ] 격리된 설치 환경에서 실제 설치 파일의 신규 설치·기존 데이터 유지 업데이트·재시작 확인.

현재 작업 세션은 일반 권한이며 실제 게임이 실행되어 있지 않다. Windows Sandbox/Hyper-V 관리 도구도 이 환경에 없다. 기존 사용자 설치를 검증 목적으로 교체하지 않는다. 위 항목은 자동 검사의 성공으로 체크하지 않는다. 릴리즈 게이트·버전 변경·태그·게시 완료로 표시하지 않는다. 상세 배포 조건은 [릴리즈 워크플로우](../../.agents/release_workflow.md)를 따른다.


## 2026-11-05 후속: 프로필 정렬·모험일지 정리

프로필 순서 저장/드래그·방향키/재시작·리마인더 연동, 삭제/유실된 소유자의 기록을 명시적으로 미배정으로 정리하는 흐름과 원본 보존, 입장료 구형/복원 이중 집계·음수 SEED 단위·디펜시오 명칭을 수정했다. 타입/빌드 및 관련 회귀 10개가 통과했다. 상세 검사와 소스/로그 증거는 [후속 검증 문서](profile-diary-fixes-2026-11-05.md) 및 `output/profile-diary-fixes/latest.json`이다. 기존 전체/관리자 검증은 이전 소스 기준이며 이번 관련 검사로 대체하지 않는다. 푸시하지 않았다.


추가 잠재 버그/부작용 검수에서는 조회 중복, 정리 저장/응답 불일치, 처리 중 동작, 불일치 입장료 보정, 저장 전 금화/엘소 분류를 보완하고 관련 회귀 17개를 통과했다. [검수 결과](profile-side-effects-review-2026-11-05.md)와 `output/profile-side-effects-review/latest.json`을 참조한다. 기존 전체/관리자 결과의 소스 해시는 그대로 보존한다.
