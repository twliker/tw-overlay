# v3.5.0-beta.2 CI 화면 캡처 수정

beta.1의 [CI 실행](https://github.com/twliker/tw-overlay/actions/runs/41787833688)은 profile-settings-pages 검사에서 GPU 프로세스 종료(exit -2147483645) 직후 `UnknownVizError`로 실패했다. 부하·의존성 검사와 패키징은 실행되지 않았고 Draft/설치 파일도 생성되지 않았다. 실패 기록과 기존 태그를 보존한다.

## 수정과 관련 확인

- `scripts/check-profile-settings-pages.ts`는 앱 ready 전에 `app.disableHardwareAcceleration()`을 호출해 Electron의 [software output device](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering#software-output-device)를 사용한다.
- 실제 설정 5개 화면의 DOM/preload/IPC/SQLite·저장 실패·초안 검사를 유지하고 화면 캡처도 모두 실행한다. 모든 캡처는 비어 있지 않아야 하며 이 조건을 충족하지 못하면 실패한다.
- 제품 앱의 그래픽 설정과 실제 Windows 창 검사는 변경하지 않았다.
- `npm run typecheck`, `npm run build`, `npm run test:profile-settings-pages`가 통과했다. 800×600의 화면 5개와 편집 화면 2개를 캡처했고 알림 편집 화면도 육안 확인했다.
- package/lock/설정/공지/README/새 릴리즈 노트는 `3.5.0-beta.2`로 일치한다. 실제 CI 채널 출력은 `prerelease=true`, `update_file=beta.yml`이다.

## 이후 판정

[beta.2 CI 결과](https://github.com/twliker/tw-overlay/actions/runs/41788985688): profile-settings-pages와 프로필·동기화·두 프로세스 동시성 검사는 통과했다. 이후 test:renderer의 집중 대화방 메모 검사에서 저장 IPC 뒤의 주석을 찾는 구형 추출 기준이 실패했다. 부하·의존성·패키징은 CI에서 미실행이다. 후속 수정은 beta.3에 기록한다.

수정된 작업 브랜치와 `v3.5.0-beta.2` 태그를 새로 푸시하고 Actions의 전체 자동 검사·부하·의존성·패키징 결과를 확인한다. 로컬 설치 파일은 생성하지 않는다. CI 성공 전에는 전체 검사·설치 파일 생성 완료라고 표현하지 않는다. 실제 Google·물리 PC 2대·실게임·관리자 권한·설치 업데이트는 프리릴리즈 설치본으로 확인하며 Draft 자동 게시는 하지 않는다.
