# v3.5.0-beta.4 기본 숙제 누락 복구

사용자가 beta.3에서 숙제 기본 목록이 비어 있다고 보고했다. `DEFAULT_CONFIG.contentsCheckerItems`는 빈 초기값인데 `profileStartup`이 이를 그대로 저장소 생성 기본값으로 전달했다. 새 프로필·설정 복사·마지막 프로필 삭제 후 빈 기본 프로필이 실제 배포 목록을 받지 못했다. 기존 검사는 임의 숙제를 주입해 실제 기본값 연결 결함을 놓쳤다.

## 수정 계약

- 기존 `contentsChecker.loadDefaultItems()`의 검증을 통과한 배포 목록 66개를 프로필 생성 기본값으로 사용한다. 로딩 실패는 부팅 실패로 전달하며 빈 목록으로 대체하지 않는다.
- 시작 및 백업 재연결 때 살아 있는 프로필의 누락 기본 항목만 추가한다. 기존 행의 정의·완료 상태·N/A·숨김·위치와 커스텀 숙제를 수정하지 않는다. 프로필 수·ID도 유지한다.
- 기존 명시 삭제 이력과 영구 동기화 삭제 표식에 있는 항목은 추가하지 않는다. Google 수신 후 빈/일부 목록도 같은 기준으로 보충한다.
- 복구 원본과 전송 대기는 같은 transaction으로 확정한다. 중간 실패 시 부분 복구를 남기지 않는다. 다음 실행에서 중복 추가하지 않는다.

## 회귀 검증

`test:profile-homework-defaults`는 실제 배포 리소스와 실제 `profileApplication` 부팅을 독립 Electron 프로세스에서 사용한다. 수정 전 검사에서 누락을 재현한 뒤 수정 후 통과를 확인했다. beta.3처럼 빈 기본값으로 저장소를 만들고 기존 커스텀/일부 수정/명시 삭제 데이터를 준비해, 복구 실패 rollback·복구·별도 재시작·신규 설치/프로필/설정 복사/마지막 삭제/빈 기본 대체 생성을 확인한다. 임의 기본 목록을 검증 근거로 삼지 않는다.

`test:profile-checklist`는 실제 새 프로필의 제품 HTML/preload/IPC/DB에서 기본 목록 전체가 DOM에 표시되는지 확인하며 800×600 화면을 캡처한다. 기존 편집·완료/N/A·실패·전환·검색/추가 위치 검사도 유지한다.

관련 검사 통과: `test:profile-storage`, `test:profile-backup`, `test:profile-lifecycle`, `test:profile-homework-defaults`, `test:profile-checklist`, `test:profile-sync-model`, `test:profile-sync`, `test:profile-sync-ui`, `test:profile-sync-import-ui`. 실행 로그는 `output/homework-default-regressions`, 별도 재시작 결과는 `output/profile-homework-defaults/latest.json`에 보관한다. 복구 테스트는 소유 표시가 있는 임시 폴더만 사용하며 실제 Roaming 사용자 데이터를 읽거나 초기화하지 않았다.

타입 검사·최종 앱 빌드와 기존 `check-refactor-regressions.ts` 파일 단위 검사도 통과했다. `test:profile-checklist` 캡처는 편집 모드를 종료하고 실제 렌더링을 기다린 뒤 기본 목록의 일반 화면을 보관한다.

실제 Google 계정·물리 PC 2대·실게임·관리자 권한·실제 설치 업데이트는 아직 확인하지 않았다. 로컬 관련 검사 결과를 전체 CI나 실기 통과로 표시하지 않는다. 최종 버전/채널 일치를 확인 후 새 태그를 푸시하며 설치 파일은 Actions로 생성한다.

## CI 중단과 후속 수정

[beta.4 CI](https://github.com/twliker/tw-overlay/actions/runs/41796642444)는 실제 기본 목록 복구 및 앞선 저장/백업/설정 검사에 통과한 후 `profile-log-restore`에서 실패했다. 테스트가 숙제 ID 조건 없이 한 행을 읽어 기본 목록의 다른 항목을 읽었다. 설치 파일은 생성하지 않았고 태그를 보존한다. 제품 복구 구현은 유지하고 해당 검사의 ID 지정 및 전체 상태 rollback 검증을 강화한 [beta.5](./prerelease-3.5.0-beta.5.md)에서 다시 검증한다.
