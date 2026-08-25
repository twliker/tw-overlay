# TW-Overlay v3.0.0 구현 검증 기록

작성일: 2026-08-26

작업 브랜치: `beta/v2.7.0`

비교 기준: `origin/beta/v2.7.0` (`82a5387742b80754e0d8dcddf66ac88cf975b5f8`)

현재 상태: **로컬 구현·자동 검증 완료, 실계정·Windows 실기 및 릴리즈 버전 승인 대기**

이 문서는 `implementation_plan.md`의 실제 구현 결과와 검증 증거를 기록한다. 실기하지 않은 항목은 완료로 간주하지 않으며, 아래 대기 항목을 통과한 뒤 최종 릴리즈 판정을 갱신한다.

## 1. 구현 결과

### 데이터·설정·SQLite

- 설정은 독립 스냅샷으로 읽고 원자 저장 실패 시 pending을 보존한다. 기존 사용자의 `false`, `0`, 빈 문자열·배열을 유지하고 누락된 신규 기본 키만 추가한다.
- 자동 v3 백업과 수동 백업·복원은 검증 매니페스트가 있는 공통 snapshot 경로를 사용한다. SQLite는 마이그레이션 트랜잭션, WAL checkpoint, statement cache 정리와 종료 recovery journal을 적용한다.
- 숙제 리소스·레거시 ID·pending event를 검증하고 안정 ID, reset cycle, event ID를 기준으로 중복과 리셋 경계를 처리한다.
- 일지 활동은 `source=manual`인 원본 row ID 한 건만 삭제한다. grouped timeline의 합계 키와 삭제 ID를 분리하고 재완료 숙제는 같은 주기의 최신 한 건으로 갱신한다.

### Google Drive 동기화·복원·종료

- 설정, 숙제, 메타를 각각 `tw_overlay_settings.json`, `tw_overlay_checklist.json`, `tw_overlay_sync_meta.json`으로 분리했다.
- 설정과 숙제의 dirty/debounce를 분리하고 모든 Drive 요청을 single-flight 큐로 직렬화했다.
- 숙제는 base/local/remote 3방향 병합과 안정 operation/mutation을 사용한다. 업로드 뒤 revision·operation을 재확인하며 overwrite나 응답 유실 뒤에도 outbox를 유지해 재수렴한다.
- fresh/established/needs-confirmation 판정, 중복 파일 선택, generation 불일치, 파일별 선택·독립 복원, 부분 성공 상태와 로컬 되돌리기를 구현했다.
- 종료 시 창·트레이를 먼저 숨기고 최대 3초 안에서 config/outbox/Drive queue를 정리한다. 미확인 파일은 recovery marker를 보존하고 다음 실행에서 revision/checksum/operation을 재확인한다.
- 미배포된 구 단일 파일 `tw_overlay_sync.json`은 읽거나 마이그레이션하지 않는다.
- Discord Webhook URL, OAuth token, 로그 경로, 절대 커스텀 사운드 경로, 창 좌표·크기, 설치 정보, DB·채팅·알람 이력은 동기화하지 않는다. Google 이메일은 로컬 계정 표시에만 사용한다.

### 채팅·렌더러·알림·창 관리

- 비정상 대형 채팅 로그는 제한 읽기 모드로 전환하고, 주간 동기화는 유한 batch와 ACK, fingerprint, event ID, 내구 offset으로 재개한다.
- 채팅 history/search/live 요청의 generation을 분리하고 stale success/catch/finally가 최신 화면을 덮지 않게 했다.
- 채팅 데이터는 메모리에 보존하되 실제 DOM은 viewport+overscan으로 제한한다. 가변 높이, prepend, live append, 폭 변경 뒤 스크롤 anchor를 복원한다.
- 모험일지·갤러리·사운드 option의 외부 문자열은 escape 또는 DOM API로 렌더링하고 검증된 ID만 이벤트에 전달한다.
- 분 정렬 스케줄러, 사운드 queue/preview generation, 보스 중복 analytics, 버프 listener lifecycle, missed-sleep 이력을 강화했다.
- Z-order는 중앙 상태 관리자가 전담하고, 독은 숨긴 창을 재사용한다. 이 정책은 이전 실사용 확인 결과를 보존하며 불필요하게 재설계하지 않았다.

## 2. 데이터 호환성과 마이그레이션

- 기존 설정값은 값이 기본값과 같거나 비어 있어도 보존한다. 배열은 일반 deep merge하지 않는다.
- SQLite 마이그레이션은 버전별 단일 트랜잭션으로 실행하고 성공한 뒤에만 `user_version`을 올린다. 실패 fixture에서는 앞선 변경도 함께 롤백한다.
- 활동 로그에는 `manual`, `automatic`, `legacy-unknown` source를 사용한다. 출처가 불명확한 레거시 행은 보존 우선이며 UI 삭제 대상으로 노출하지 않는다.
- 클라우드 기능은 공개 배포 전이므로 개발 중 단일 파일 형식의 호환·마이그레이션은 제공하지 않는다.
- 현재 `package.json` 버전은 `2.7.0-beta.1`이다. 사용자 지시에 따라 v3.0.0 버전 변경, 릴리즈 노트 확정, 태그·배포는 수행하지 않았다.

## 3. 자동 검증 결과

2026-08-26 현재 다음 필수 게이트를 연속 실행해 통과했다.

```text
npm run typecheck
npm test
git diff --check
```

- TypeScript 앱·스크립트 검사 통과
- 전체 빌드 및 정적 회귀 검사 통과
- Electron renderer behavior 검사 40개 통과
- 확정 결함 74개 모두 코드·자동 검증 상태를 대조했으며, 그중 6개는 별도의 Windows 실기 재검증 상태를 유지한다.
- 채팅 20,000건 + 과거 150건 prepend + live 1,000건에서 실제 DOM 300개 미만, anchor 오차 2px 이내를 확인했다.
- 교차 숙제 변경, 동일 필드 충돌, 응답 유실, overwrite, 재시작 재수렴, 부분 복원과 종료 recovery fixture를 통과했다.
- 악성 문자열, DB 마이그레이션 실패·rollback, 대형/잠금/다중 바이트 채팅, scheduler·audio lifecycle fixture를 통과했다.

비교 기준부터 이 검증 기록을 포함한 현재 변경까지의 검토 범위는 56개 파일, 6,978줄 추가, 799줄 삭제다. `dist`, `dist-tools`, `dist_electron`, `release`, `out` 생성 산출물은 Git 변경 범위에 포함되지 않았다. `build/appx` PNG 4개는 Microsoft Store 패키징용 원본 자산이며 생성 결과물이 아니다.

## 4. 릴리즈 전 남은 실기 검증

- 실제 Google 계정과 서로 다른 두 PC에서 교차 업로드·pull·재시작 재수렴 확인
- 실제 Windows 일반 종료, 로그오프, 시스템 종료에서 recovery marker·WAL 복구 확인
- 100/125/150% DPI, 보조 모니터 분리, 작은 작업 영역, Remote Desktop 전환 확인
- 정상 게임 플레이 중 30~60분 무조작 Z-order·작업표시줄 소크 테스트
- 실제 비정상 대형 게임 로그 장시간 처리와 Tail 재연결 확인
- 독 위치 변경·메뉴 클릭·같은/다른 모니터 Alt+Tab 조합의 최종 재검증

## 5. 릴리즈 보류 항목

- v3.0.0 버전과 lockfile 정합성 변경
- 릴리즈 노트 및 백업 버전 조건 최종 일치 확인
- 실기 결과 반영과 이 문서의 최종 완료 판정
- 배포 빌드, 태그, 푸시

위 항목은 사용자의 명시적 승인과 실기 증거가 있기 전에는 완료로 표시하지 않는다.
