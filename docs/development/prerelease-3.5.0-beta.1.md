# v3.5.0-beta.1 테스트 배포 준비

2026-11-04 사용자는 이전 3.4.x 설치 사용자도 상위 버전으로 인식하도록 `3.5.0-beta.1`을 확정했다. 설치 파일은 GitHub Actions가 생성하도록 작업 브랜치와 베타 태그만 푸시한다. 로컬 설치 파일 생성·main 병합·Draft 자동 게시는 이 작업에 포함하지 않는다.

## 로컬 확인

- [x] package.json·package-lock.json 루트·설정 화면·공지·README·릴리즈 노트 버전 일치
- [x] 타입 검사와 앱/테스트 도구 빌드
- [x] check-refactor-regressions.ts 관련 회귀 통과
- [x] 정식/beta/alpha/rc/preview 채널 선택과 태그 불일치 거부
- [x] 실제 Electron Builder GitHub publish 설정의 beta 채널 확인
- [x] CI helper 실행 결과 `prerelease=true`, `update_file=beta.yml`
- [x] CI 워크플로우 YAML·단일 Draft 생성·프리릴리즈 표시 확인
- [x] env.json·Google 인증 파일·생성물은 소스 목록에서 제외

## Actions 및 설치본에서 확인할 항목

- [ ] 이번 태그의 전체 자동 검사·부하 검사·프로덕션 의존성 검사 완료 — [CI 실행](https://github.com/twliker/tw-overlay/actions/runs/41787833688)의 profile-settings-pages 화면 캡처에서 GPU 종료/UnknownVizError로 실패. 이후 부하/의존성/패키징은 미실행. 수정본은 beta.2에서 검증한다.
- [ ] 베타 설치 파일·blockmap·beta.yml이 포함된 프리릴리즈 Draft 생성
- [ ] 실제 Google OAuth·왕복·첫 복원·충돌 해결
- [ ] 실제 PC 2대의 다른 프로필/같은 프로필 동시 사용·종료/재접속
- [ ] 실제 게임·관리자 권한·신규 설치 및 기존 데이터 유지 업데이트
- [ ] Google 프로젝트의 적용 호출 한도·저장공간·전송 지연 확인

미검증 항목은 통과로 간주하지 않는다. 설치본을 받기 위한 프리릴리즈와 이후 정식 배포의 완료 판정을 구분한다. [배포 절차](../../.agents/release_workflow.md)의 Section 0과 [릴리즈 노트](../../release-note/CHANGELOG-v3.5.0-beta.1.md)를 따른다.
