# v3.5.0-beta.3 기존 화면 검사 갱신

후속 사용자 검증에서 새 프로필의 기본 숙제 누락이 발견됐다. 아래 CI 성공은 당시 검사의 결과이며 이 회귀를 검증했다는 뜻이 아니다. 임의 기본값 fixture가 실제 부팅 기본값 연결을 누락한 원인과 수정·실제 목록 회귀는 [beta.4 검증 기록](./prerelease-3.5.0-beta.4.md)에 남긴다.

beta.2의 [CI 실행](https://github.com/twliker/tw-overlay/actions/runs/41788985688)에서 설정 화면 소프트웨어 캡처와 프로필·동기화·동시성 검사는 통과했다. 이후 집중 대화방 메모 검사에서 실제 IPC 등록 다음의 주석을 찾는 기준이 실패해 빌드가 중단됐다. 기존 태그와 실패 기록을 보존한다.

## 수정

- 집중 대화방 메모 검사는 TypeScript 구문 트리에서 실제 `nickname-note-save` IPC 등록을 찾아 실행한다. 주변 주석/들여쓰기에 의존하지 않는다. 저장·실패·읽던 위치·늦은 응답·동시 입력 검증은 유지한다.
- 메모·글꼴 검사 fixture에 현재 설정 저장 함수가 사용하는 설정 snapshot과 실제 프로필 쓰기 검증기를 연결한다.
- 설정 공유·HUD 편집·창 위치 검사는 현재의 설정 저장 IPC·공유 UI·공통 배치 snapshot/좌표 복원 경로를 사용한다. 제거한 활동 프리셋 메뉴/IPC의 부재도 확인한다. 첫 표시·로딩 중 적용 순서·다중 모니터·초안/저장 실패/늦은 응답 검증을 유지한다.
- 제품 동작 코드는 변경하지 않았다. 앱 버전·표시·공지·릴리즈 노트는 `3.5.0-beta.3`으로 올린다.

## 로컬 확인

- 화면 회귀 파일 전체 `test:renderer` 통과.
- 그 뒤에 남아 있던 24개 CI 회귀 명령 통과. 이미 통과한 프로필 묶음을 다시 실행하지 않고 실패한 fixture만 수정해 해당 검사와 남은 명령을 실행했다. 로그는 `output/prerelease-preflight`에 보관한다.
- 순간 유입/지속 유입 부하 검사 통과.
- 프로덕션 의존성 critical 기준 audit 통과(critical/high 0, moderate 1).

타입 검사·최종 빌드와 버전/채널 일치를 확인한 뒤 새 브랜치 커밋·태그를 푸시했다. 설치 파일은 Actions가 생성했다. 실계정 Google·물리 PC 2대·실게임·관리자 권한·실제 설치 업데이트는 아직 미검증이다. 작업에서는 게시 명령을 실행하지 않았다.

## CI 최종 결과

2026-11-04 16:32 KST 확인. [beta.3 CI 실행](https://github.com/twliker/tw-overlay/actions/runs/41791269848)은 12분 47초에 전체 성공으로 완료됐다. 빌드 커밋은 `b763310a3047ade886f4771cec2ebc1e3b1d9258`이다.

- [x] 타입 검사 및 전체 npm test 회귀
- [x] 순간/지속 유입 부하 검사
- [x] 프로덕션 의존성 critical 기준 audit
- [x] beta 채널/태그/버전 확인
- [x] Windows 설치 파일·blockmap·beta.yml 생성 및 Release 첨부

확인 시점 [v3.5.0-beta.3](https://github.com/twliker/tw-overlay/releases/tag/v3.5.0-beta.3)은 `draft=false`, `prerelease=true`였고 정식 latest는 v3.2.2였다. 실제 설치 실행 완료를 뜻하지 않는다.

GitHub가 제공한 설치 파일 메타데이터: `twOverlay-Setup-3.5.0-beta.3.exe`, 128,887,102 bytes, SHA-256 `76d6e72b32102ff5e9bc42d20fa4a40178ed7776ddbf69e74bfa1ee40cfc4966`. 실제 파일을 로컬에서 재빌드하거나 설치한 결과로 표시하지 않는다. 다른 PC·Google 실기는 이 프리릴리즈 설치본으로 진행한다.
