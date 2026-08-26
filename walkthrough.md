# TW-Overlay v3.0.0 구현 검증 기록

작성일: 2026-08-26

작업 브랜치: `beta/v2.7.0`

비교 기준: `origin/beta/v2.7.0` (`93d2922fac98bb8a10c37fdaa6594e5f831b33d2`)

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
- fresh/established/needs-confirmation 판정, 중복 파일 선택, generation 불일치, 파일별 선택·독립 복원, 부분 성공 상태와 로컬 되돌리기를 구현했다. `c726061`에서 Drive 목록의 모든 페이지를 수집해 페이지 경계 뒤의 유효 중복 후보도 검사하도록 보강했고, `24db4f1`에서 실제 참조가 모두 끊긴 최신 메타가 이전 유효 메타를 가리지 못하게 했다.
- `6f8558c`에서 established 자동 pull도 손상된 한 파일을 `invalid`로 격리하고 같은 generation의 다른 정상 파일 변경을 계속 적용하도록 보강했다.
- fresh 프로필의 기본 숙제 초기화는 outbox로 기록하지 않는다. 원격이 없으면 최초 로그인에서 현재 전체 숙제를 업로드하고, established 프로필의 오프라인 변경은 계속 outbox에 보존한다.
- 종료 시 창·트레이를 먼저 숨기고 최대 3초 안에서 config/outbox/Drive queue를 정리한다. 미확인 파일은 recovery marker를 보존하고 다음 실행에서 revision/checksum/operation을 재확인한다.
- 미배포된 구 단일 파일 `tw_overlay_sync.json`은 읽거나 마이그레이션하지 않는다. `5b7fd7e`에서 남아 있던 구 파일용 공개 Drive API와 설정 UI fallback도 제거했다.
- 로그아웃 또는 새 로그인 전에 시작된 access token 갱신은 인증 세대를 확인한다. `cd23b9d`, `1ca8cbb`에서 늦은 성공 응답이 삭제한 토큰을 되살리는 경로와 오래된 401이 새 인증을 삭제하는 경로를 각각 재현·차단했다.
- `fae83a2`에서 OAuth token 교환 뒤 Google 프로필 조회가 실패하면 로그인 성공이나 토큰 저장으로 남기지 않도록 고정했다.
- `8681d5c`, `aa6383c`에서 OS가 실제 할당한 브라우저 차단 포트 `1723` 때문에 OAuth callback이 `bad port`로 거부되고 60초 타임아웃되던 결함을 수정했다. 공식 WHATWG Fetch Standard의 차단 포트만 다시 배정받으며 허용되는 낮은 포트는 유지하고, 기본 브라우저 실행 실패는 즉시 반환한다.
- `fe6e7d9`에서 악성 OAuth `error`가 callback HTML 요소로 삽입되는 결함을 실제 loopback 요청으로 재현했다. 오류·이메일·내부 오류 표시를 escape하고 요청별 `state`가 일치하지 않는 callback은 token 교환 전에 거부한다.
- `c908f19`, `1789baf`에서 부분 손상된 `cloud-sync-state.json`의 잘못된 Drive file ID·revision·dirty key·숙제 mutation·종료 recovery 필드와 빈 installation/generation ID가 정상 항목과 함께 로드되는 결함을 재현했다. 공통 operation 검증과 필드별 정규화로 손상 값만 버리고 정상 dirty/outbox/recovery는 보존하며 기존 프로필을 `fresh`로 오인하지 않는다.
- `6753832`에서 최초 상태가 첫 변경 전 디스크에 기록되지 않고, 원자 저장 중 유효한 `.tmp`만 남으면 다음 실행이 새 UUID와 빈 outbox로 대체하는 결함을 재현했다. 새 상태를 즉시 저장하고 정식 상태가 없거나 손상된 경우에만 검증된 임시 상태를 승격한다.
- Discord Webhook URL, OAuth token, 로그 경로, 절대 커스텀 사운드 경로, 창 좌표·크기, 설치 정보, DB·채팅·알람 이력은 동기화하지 않는다. Google 이메일은 로컬 계정 표시에만 사용한다.

### 채팅·렌더러·알림·창 관리

- 비정상 대형 채팅 로그는 제한 읽기 모드로 전환하고, 주간 동기화는 유한 batch와 ACK, fingerprint, event ID, 내구 offset으로 재개한다.
- Tail 오류 뒤 첫 재시도 때 로그 파일이 아직 없어도 같은 경로라면 1/2/4/8/16초 지수 백오프를 계속하며, 복원 뒤 기존 내용을 재생하지 않고 실시간 append부터 처리한다.
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
- 확정 결함 90개 모두 코드·자동 검증 상태를 대조했으며, Windows 실기 항목은 실제 증거가 확보된 범위만 개별 완료 처리한다.
- 채팅 20,000건 + 과거 150건 prepend + live 1,000건에서 실제 DOM 300개 미만, anchor 오차 2px 이내를 확인했다.
- 교차 숙제 변경, 동일 필드 충돌, 응답 유실, overwrite, 재시작 재수렴, 부분 복원과 종료 recovery fixture를 통과했다. `8f643f1`에서는 완료·해제·횟수·operation 순서를 바꾼 256개 결정론적 교차 조합으로 원격/양쪽 로컬 수렴과 두 operation ID 보존을 추가 검증했다. `9974c5a`에서는 독립 userData의 실제 `main.js` 두 개가 같은 원격 revision에서 시작하도록 했고, `ab443e9`는 수렴한 양쪽 프로세스를 각각 재시작해 확인 operation·숙제 상태 유지와 무 echo upload를 검증했다. `2fe2491`은 같은 숙제·캐릭터의 횟수 1 대 2 충돌을 실제 두 프로세스에서 필드별로 결합·수렴하고 재시작 후 유지되는 것을 고정했다. `5043162`에서 기준 캐릭터 기록을 비운 fixture는 앱 초기화가 정상 기본값과 파생 operation으로 보정하는 비정상 전제로 판명돼 되돌렸고, Windows 테스트 잠금의 일시 `EPERM` 재시도만 유지했다. 정상 기준으로 반복하자 두 ID가 모두 있어도 마지막 업로더와 로컬 우선 병합 순서에 따라 원격·로컬 횟수가 1/2로 갈리는 결함이 재현됐다. `8695630`은 업로드 전과 수신 병합 후 전체 operation을 결정적으로 재생해 canonical data를 사용하도록 수정했다. 이후 `d8711d2`에서 메타 파일 쓰기가 섞인 장치별 업로드 순서를 숙제 파일 전용 계측으로 분리하고, 양쪽 첫 숙제 payload가 만들어진 뒤에만 업로드를 풀어 실제 상호 overwrite를 보장했다. 비충돌·동일 필드 시나리오를 각각 5회 반복해 매번 세 번째 숙제 업로드의 누락 operation 재게시, 최종 완료·횟수 2·시각 20000, 두 ID, 빈 outbox와 양쪽 재시작 무 echo가 일치했다.
- `fb49591`은 실제 `cloudSyncManager` scheduler가 게임 실행 시 27~33초, 유휴 시 270~330초의 installation jitter 범위로 각각 다음 pull 하나를 예약하고 중지 시 정리하는 것을 런타임으로 확인했다. `055dfbd`는 게임 실행 중 첫 Drive 조회 실패 후 재시도가 54~66초로 증가하고 다음 성공 뒤 27~33초로 초기화되는 backoff 경계를 고정했다. `54f9320`은 즉시 pull이 기존 장기 타이머를 취소하고 Drive 목록을 바로 조회한 뒤 정상 후속 타이머 하나를 재예약하는 것을 확인했다. `4021977`은 앱 시작·절전 복귀·잠금 해제·네트워크 복구·게임 시작·자동 동기화 활성화가 즉시 pull에 연결된 계약을 고정했고, `fc25244`는 로그인 성공 직후 scheduler 시작과 최초 pull 연결을 추가했다. pull 중 생긴 dirty를 정리하는 후속 업로드 조회는 별개이며 실제 Windows 이벤트·계정 로그인과 두 PC 도착 시간은 실기로 남겼다.
- `b1fbef7`의 지속형 모의 Drive + 실제 `main.js` 검사에서 손상 설정과 정상 숙제를 파일별로 분리해 숙제만 복원했다. 이어진 `needs-confirmation` 재시작에서 사용자 선택 전 파생 변경이 원격을 읽고 덮어쓰는 결함을 재현해 자동 전송을 대기시키도록 수정했으며, 이후 2.2초 동안 다운로드·업로드 0회와 로컬/원격 설정값 보존을 확인했다. `e7f7b57`은 설정만 선택한 복원 직후 숙제·캐릭터가 유지되고, 확인 완료 뒤 새 설정 변경의 자동 업로드가 재개되는 것까지 실제 메인 프로세스로 검증했다. `26d95c2`는 정상 설정과 손상 숙제의 역방향에서도 설정만 복원되고 기존 로컬 숙제·캐릭터와 확인 전 무전송이 유지되는 것을 같은 실행 경로로 고정했다. `0c5d6f0`은 설정·숙제 동시 복원 후 복원 전 백업 되돌리기, 두 로컬 값 복구, 두 원격 파일 재수렴과 dirty/outbox 정리까지 검증했다.
- 악성 문자열, DB 마이그레이션 실패·rollback, 대형/잠금/다중 바이트 채팅, scheduler·audio lifecycle fixture를 통과했다.
- 실제 Electron 격리 검사에서 40MB 당일 로그에 4MB를 append한 뒤 최근 16MB 제한과 4,317줄 trim, 재시작 뒤 최근 marker 검색을 확인했다. Tail 오류 직후 파일을 일시 이동한 검사에서는 1초 실패 뒤 2초 재예약, 복원 후 기존 marker 1건 유지와 live marker 1건 처리를 확인했다.
- 실제 Windows 독점 잠금 검사에서 2개 로그 중 1개를 `FileShare.None`으로 잠갔다. 수정 전 사전 검사는 1ms 만에 전체 throw했지만, 수정 후 약 773ms에 정상 파일 1개를 반영하고 잠긴 파일만 부분 실패로 보고했다. 잠금 해제 후 재실행은 두 파일·4줄, 실패 0개로 수렴했다.
- UTF-8, UTF-8 BOM, EUC-KR, 256KB 경계 직전에서 한글 멀티바이트가 갈라지는 UTF-8 실제 파일 4개를 Electron 주간 동기화로 처리해 SEED 4건을 반영했고, 재실행에서는 신규 반영이 0건임을 확인했다.
- 8.05MB·50,002줄 정상 당일 로그는 전체 검색 모드를 유지해 앞·뒤 marker를 모두 찾았다. 파일 부재를 16초 최종 예약까지 유지한 Tail 검사는 1/2/4/8/16초 백오프를 모두 거쳐 복원됐고 기존 줄 중복 없이 live 한 줄만 추가했다.
- 실제 Electron 프로세스를 종료·재시작한 주간 동기화는 첫 실행의 확정 offset 188과 SEED event ID를 재사용해 두 번째 실행 신규 반영 0건으로 끝났다. 사용자 지정 로그 폴더를 통째로 이동·복원하는 동안 config 경로는 유지됐고 watcher도 같은 경로로 복구됐다.
- 40.0→42.05MB 로그에 2분간 14,400줄을 추가한 소크에서 최근 창은 16MB 도달 후 22,194줄을 제거해 12.77M chars로 복귀했다. heap 80.96→44.37MB, RSS 204.71→130.57MB, 최대 event-loop lag 14ms였다. 이 검사에서 유효 UTF-8 제한 구간을 손상으로 잘못 경고하는 E-11을 찾아 수정했다.
- `93d2922` 격리 fresh 프로필을 실제 Windows UI의 `Alt+F4`로 종료했다. 생산자 중지, WAL 72/72 checkpoint, DB close와 프로세스 종료가 로그 시각 기준 9ms 안에 완료되어 일반 종료 3초 제한을 통과했다. `0884202`에서는 설정 dirty만, 숙제 outbox만, 두 파일 모두 dirty인 상태를 각각 별도 Electron 프로세스에서 저장하고 재시작해 dirty key·operation ID·파일별 recovery marker가 그대로 유지되는 것을 확인했다. `65ea23d`에서는 같은 세 조합을 표시 창이 있는 실제 `main.js` finalizer로 종료해 100ms 창 숨김·3초 전체 종료 제한, marker 보존, WAL checkpoint와 DB close를 모두 확인했다. `431c2a9`에서는 응답하지 않는 Drive 요청을 약 3초 뒤 한 번 취소하고 종료 시점의 모든 dirty/outbox marker와 WAL/DB를 보존한 채 종료했다. `62dd7a6`에서는 timeout 시작 100ms 뒤 두 번째 외부 quit를 넣어도 finalizer 정리를 우회하지 않는 것을 확인했다. `35f3dab`에서는 main 창의 `query-session-end`가 이벤트를 취소하지 않고 반환 전에 dirty/outbox marker를 저장하고 WAL checkpoint를 실행하는 fast path를 확인했다. `bb2e782`, `4257b5b`에서는 지속형 모의 Drive를 연결한 첫 `main.js` 프로세스가 설정 또는 숙제 payload를 원격에 commit한 뒤 응답을 받지 못해 3초 timeout으로 종료됐고, 같은 userData로 재시작한 두 번째 프로세스가 revision/checksum 또는 operation을 확인해 이미 반영된 대상 파일을 중복 업로드하지 않으면서 반대 파일의 남은 변경까지 처리했다. `013e4ba`에서는 설정/숙제 응답 유실 종료를 각각 10회 반복해 20회 모두 operation·recovery marker·1회 취소와 약 3.03~3.06초 종료를 확인하고 비동기 로그 파일 판독에 의존하던 probe 경합만 제거했다. `0a9c412`에서는 빠른 일반 종료 10/10회(창 숨김 24~28ms, 전체 34~42ms)와 timeout 종료 5/5회(창 숨김 8~16ms, 전체 약 3.04~3.05초)가 통과하도록 1ms poll·WAL/DB 로그 계측 경합을 제거했다. 실제 Google Drive 네트워크 조건과 실제 로그오프·시스템 종료는 별도 실기로 남겼다.
- `8715215` 격리 source Electron을 강제 100/125/150% 배율로 각각 시작해 renderer DPR 1/1.25/1.5를 확인했다. 추가 2×/3× probe의 1280×696에서는 기존 계수 계산기 2열이 유지됐지만 854×464에서는 816px 창 안의 문서 폭이 998px로 남아 183px가 잘리는 F-09를 재현했다. `750ec60`에서 소형 입력 줄바꿈, 가이드 하단 배치, 문서 세로·테이블 가로 스크롤을 적용했고 동일 probe의 document client/scroll 폭 811/811px와 실제 세로 scroll 이동을 확인했다. 일반 1100px 2열·360px 가이드도 회귀 검사로 유지했다.

자동 감사 커밋 `d202343` 기준 검토 범위는 56개 파일, 6,978줄 추가, 799줄 삭제다. `dist`, `dist-tools`, `dist_electron`, `release`, `out` 생성 산출물은 Git 변경 범위에 포함되지 않았다. `build/appx` PNG 4개는 Microsoft Store 패키징용 원본 자산이며 생성 결과물이 아니다.

후속 감사 커밋 `3437723` 기준 `origin/beta/v2.7.0`의 `93d2922` 이후는 12개 파일, 2,059줄 추가, 50줄 삭제다. 실제 제품 변경은 `cloudSyncManager.ts`의 canonical operation 수렴과 `coefficient-calculator.html`의 소형 화면 overflow 수정 두 파일이며, 나머지는 런타임 probe·회귀 검사·문서다. 생성 산출물이나 미완료 TODO/FIXME는 추가되지 않았다.

구형 클라우드 계약 제거 커밋 `5b7fd7e` 기준 같은 범위는 14개 파일, 2,081줄 추가, 74줄 삭제다. 제품 변경은 위 두 파일과 `googleDriveSync.ts`, `settings.html`까지 네 파일이며, 마지막 두 파일은 미배포 구 단일 파일 API 제거와 정식 분리 파일 UI 표시 수정이다. 생성 산출물은 추가되지 않았다.

OAuth 갱신 경쟁 수정 커밋 `1ca8cbb` 기준 같은 범위는 15개 파일, 2,187줄 추가, 78줄 삭제다. 제품 변경은 `googleAuth.ts`까지 다섯 파일이며, 늦은 갱신 응답의 인증 상태 역전을 막는 세대 검사와 실행 회귀 검사가 추가됐다. 생성 산출물은 추가되지 않았다.

Drive 목록 pagination 수정 커밋 `c726061` 기준 같은 범위는 16개 파일, 2,254줄 추가, 90줄 삭제다. 제품 파일은 같은 다섯 파일이며, `googleDriveSync.ts`의 전체 AppData 후보 수집과 2페이지 실행 fixture가 추가됐다. 생성 산출물은 추가되지 않았다.

끊긴 메타 참조 수정 커밋 `24db4f1` 기준 같은 범위는 16개 파일, 2,286줄 추가, 97줄 삭제다. 제품 파일은 같은 다섯 파일이며, `cloudSyncManager.ts`의 메타 채택 조건과 이전 유효 메타 fallback fixture가 보강됐다. 생성 산출물은 추가되지 않았다.

OAuth 프로필 실패 수정 커밋 `fae83a2` 기준 같은 범위는 16개 파일, 2,348줄 추가, 99줄 삭제다. 제품 파일은 같은 다섯 파일이며, `googleAuth.ts`의 로그인 완료 조건과 실제 루프백 callback fixture가 보강됐다. 생성 산출물은 추가되지 않았다.

established 파일별 pull 격리 커밋 `6f8558c` 기준 같은 범위는 16개 파일, 2,468줄 추가, 120줄 삭제다. 제품 파일은 같은 다섯 파일이며, `cloudSyncManager.ts`의 파일별 자동 pull 결과와 손상 설정·정상 숙제 fixture가 보강됐다. 생성 산출물은 추가되지 않았다.

교차 overwrite 계측 강화 커밋 `d8711d2`는 제품 파일을 바꾸지 않고 두 프로세스 probe와 회귀 단정만 수정했다. 전체 `uploadOrder`를 숙제 재게시 증거로 사용하던 오판을 제거하고, 실제 숙제 overwrite와 재게시를 강제한 반복 10회 및 전체 자동 게이트를 통과했다.

OAuth 루프백 포트 수정 커밋 `8681d5c`, `aa6383c` 기준 같은 범위는 16개 파일, 2,587줄 추가, 144줄 삭제다. 제품 파일은 같은 다섯 개이며, `googleAuth.ts`에 공식 WHATWG 차단 포트 재배정과 `shell.openExternal()` 실패 즉시 정리를 추가했다. 생성 산출물은 추가되지 않았다.

OAuth callback 응답 보안 수정 커밋 `fe6e7d9` 기준 같은 범위는 16개 파일, 2,671줄 추가, 149줄 삭제다. 제품 파일은 같은 다섯 개이며, `googleAuth.ts`의 callback HTML escape, OAuth `state` 검증과 실제 loopback 공격 fixture를 추가했다. 변조된 state에서는 token 요청이 발생하지 않았고 생성 산출물도 추가되지 않았다.

로컬 클라우드 상태 손상 복구 수정 커밋 `c908f19`, `1789baf` 기준 같은 범위는 18개 파일, 2,839줄 추가, 192줄 삭제다. `cloudSyncState.ts`와 `syncDataHelper.ts`가 잘못된 installation/generation ID, file ID·revision·dirty key·operation·recovery 필드를 제거하고 정상 항목을 보존하도록 공통 검증을 적용했다. 생성 산출물은 추가되지 않았다.

중단된 로컬 상태 저장 복구 수정 커밋 `6753832` 기준 같은 범위는 18개 파일, 2,898줄 추가, 196줄 삭제다. `cloudSyncState.ts`가 새 installation ID를 즉시 원자 저장하고, 정식 파일이 없거나 손상된 경우 검증된 `.tmp`의 dirty/outbox/recovery를 정식 상태로 승격한다. 생성 산출물은 추가되지 않았다.

Phase 3 후속 자동 범위 최종 감사 커밋 `1f310a9` 기준 `origin/beta/v2.7.0`의 `93d2922` 이후는 18개 파일, 2,906줄 추가, 196줄 삭제와 로컬 80개 커밋이다. 작업 트리는 clean이고 생성 산출물·신규 TODO/FIXME·HEAD tag가 없으며 버전은 `2.7.0-beta.1`이다. 자동화로 가능한 교차 업로드·부분 복원·종료 recovery와 추가 손상 경계는 완료했고, 실제 계정·두 PC·Windows 세션·게임 환경 항목만 대기한다.

실기 증거 수집기 커밋 `97a9ff8`은 실제 Windows PowerShell에서 상태 fixture와 설치 파일을 읽어 SHA-256, generation/revision/dirty/operation/recovery만 출력했다. device/file ID, base snapshot, Webhook, 캐릭터 이름, 원문 오류의 로컬 경로와 입력 파일 경로가 모두 결과에서 제외되는 회귀 검사를 통과했다.

두 PC 실기 증거 비교기 커밋 `633a5f2`는 수렴 직후와 2분 뒤의 PC-A/PC-B 수집 결과를 실제 Windows PowerShell로 대조한다. 동일 설치 hash·profile/generation·파일별 revision, 빈 dirty/outbox/recovery, 기대 operation의 양쪽 보존과 무 echo 조건을 한 번에 판정한다. 정상 UTF-8/UTF-16 BOM 조합은 종료 코드 0으로 통과했고 generation·checklist revision·outbox·operation 및 대기 중 revision 변화 fixture는 종료 코드 1로 실패했다. 제품 코드는 변경하지 않았으며 실제 계정 결과는 여전히 대기한다.

새 PC·부분 복원 자동 경계 역감사에서는 `fresh / needs-confirmation / established`의 정상·손상 파일 판정, 손상된 최신 중복 후보 대신 이전 유효 메타 참조 선택, generation 불일치 파일만 격리, 설정만·숙제만 존재하는 양방향 부분 복원이 모두 기존 실행 단정에 포함돼 있음을 확인했다. 새 결함은 재현되지 않아 제품 코드는 변경하지 않았다.

실기 도구 반영 후 `aac0973` 기준으로 원격을 다시 fetch했다. `origin/beta/v2.7.0`은 `93d2922`, 로컬은 86개 커밋 앞선 clean 상태이며 범위는 20개 파일, 3,440줄 추가, 202줄 삭제다. 생성 산출물·신규 TODO/FIXME·HEAD tag는 없다. `package.json`의 `2.7.0-beta.1`과 lockfile 루트의 기존 `2.4.0`은 최종 v3 버전 승인 시 함께 변경할 보류 항목이며 push·버전·태그·배포는 수행하지 않았다.

## 4. 릴리즈 전 남은 실기 검증

실행 순서와 합격 기준은 [`docs/v3-manual-validation.md`](docs/v3-manual-validation.md)에 정리했다. 대형 로그·Tail, 일반 종료, 강제 DPI 렌더링의 격리 런타임 범위만 부분 통과했으며 나머지 실환경 결과는 대기 상태다.

- 실제 Google 계정과 서로 다른 두 PC에서 교차 업로드·pull·재시작 재수렴 확인
- 실제 Drive 응답 유실 종료·원격 재확인과 Windows 로그오프·시스템 종료에서 recovery marker·WAL 복구 확인
- 100/125/150% DPI, 보조 모니터 분리, 작은 작업 영역, Remote Desktop 전환 확인
- 정상 게임 플레이 중 30~60분 무조작 Z-order·작업표시줄 소크 테스트
- 실제 비정상 대형 게임 로그 장시간 처리와 Tail 재연결 확인
- 자동 생성 창·입력 도구 전체 조합과 알림 활성 상태의 무조작 포커스 재검증

`1291779`은 사용자 실게임·듀얼 모니터 환경에서 독 클릭·숨김/표시, 같은/다른 모니터의 외부 프로그램 전환, 작업표시줄 복구와 게임 위 오버레이 유지, 숨긴 독의 위치·퀵링크 즉시 반영까지 확인됐다. 위 대기 항목 중 남은 범위는 자동 생성 창과 입력 도구 전체 조합 및 30~60분 무조작 알림 소크다.

## 5. 릴리즈 보류 항목

- v3.0.0 버전과 lockfile 정합성 변경
- 릴리즈 노트 및 백업 버전 조건 최종 일치 확인
- 실기 결과 반영과 이 문서의 최종 완료 판정
- 배포 빌드, 태그, 푸시

위 항목은 사용자의 명시적 승인과 실기 증거가 있기 전에는 완료로 표시하지 않는다.

실기 증거는 `docs/v3-manual-validation.md`의 공통 수집 절차에 따라 설치 파일 SHA-256, 파일별 checksum/revision/pending, 필요한 operation ID와 시각만 기록한다. OAuth token·Google 이메일·Webhook URL·절대경로·캐릭터 이름이 포함될 수 있는 원본 파일과 전체 JSON은 공유하지 않는다.
