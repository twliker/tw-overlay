# Google 프로필 동기화 계약

2026-11-04 재개발의 현행 계약. 사용자 합의는 `profile-storage-design.md`, `profile-sync-lifecycle.md`, 원본은 `local-profiles-plan.md`를 함께 따른다. 옛 settings/checklist/meta JSON과 syncDataHelper의 병합 형식은 새 프로필 동기화의 계약이 아니다.

## 원본과 전송 범위

ApplicationData 최상위 저장 transaction 안에서 captureProfileSyncChanges를 호출해 원본과 durable 전송 대기를 함께 commit/rollback한다. Google 응답은 로컬 저장 조건이 아니다. 프로필 UUID/자유로운 이름/기존 userServer, 숙제, PROFILE_SETTING_KEYS, 허용 도구 키와 공통 거래/지정 단어/외치기/갤러리/Discord 조건만 전송한다. DB의 SHARED_SETTING_KEYS와 Google 허용 목록은 별개다. 닉네임 메모의 기존 로컬 전용 정책을 유지한다.

중첩 알림/보스/도핑 객체도 허용 필드만 추린다. soundFile/volume은 전송하지 않고 수신 시 로컬 선택을 유지한다. 새 알림에 로컬 선택이 없으면 내장 기본음을 쓴다. 일지/채팅/미배정 원본/실행 세션/HUD/시간 측정 기록/경로/창 배치/음량/단축키/인증은 payload를 만들기 위해 조회하지 않는다.

빈 프로필 초안은 이름/서버 확정 전 업로드하지 않는다. profile-default는 profile_sync_ids에서 원격 UUID로 매핑해 독립 PC의 기본 프로필이 충돌하지 않게 한다. 수신은 이름과 서버가 없는 기본 프로필만 재사용한다.

## 파일과 압축

PC별 tw_overlay_profiles_<writer ID>.json 파일, appDataFolder의 appProperties.twProfileSync=1만 사용한다. JSON이 4 KiB를 넘으면 gzip으로 전송하며 magic과 압축 해제 크기 제한으로 읽는다. SQLite를 업로드하지 않는다.

Envelope 허용 필드: format(tw-overlay-profiles), version(1), device, sequence, cells. Cell은 device, sequence, context, clock, value다. 주소는 scope/원격 프로필 ID/숙제 ID/필드의 JSON 배열 문자열. validCellKey/validPortableSetting에서 타입·범위·중첩 허용 목록을 검증한다. 이메일은 없다.

프로필 이름/서버, 공통 scope, 숙제 정의 각 필드/정렬/N/A/진행을 구분한다. 설정 배열과 도구별 직렬화 입력은 각각 하나의 논리 필드로 취급하며 내부 상충은 후보 전체를 보관한다. 숙제 진행은 한국 리셋 경계와 횟수/완료 시각의 묶음이다. 목표 횟수/주기 변경으로 생긴 정규화도 새 인과 변경으로 확정한다.

필드/기기별 최종 변경과 context로 압축한다. 이벤트마다 파일을 추가하지 않는다. profile_sync_cells는 후보, profile_sync_own은 writer 송신 상태, profile_sync_tombstones는 영구 삭제 증거다. ACK는 캡처 순번에만 적용해 전송 중 새 저장을 남긴다. 전송에 포함한 기준까지의 옛 profile_change_log 상세 행은 정리하되 새 journal/candidate/vector/tombstone을 유지한다.

## 병합과 UX

인과 context로 선후를 판단한다. 동시 후보라도 인터넷 UTC의 신뢰한 오차 구간이 분리되면 최신을 선택한다. 확인하지 못한 과거 시각을 전송 시각으로 고치지 않는다. 다른 필드/같은 값은 자동 병합한다. 불확실한 상충은 현재 확정값과 양쪽 후보를 보존한다. 해결도 모든 후보를 알고 수행한 새 변경으로 저장한다.

삭제 표식은 날짜로 만료시키지 않으며 오래된 PC가 항목을 부활시킬 수 없다. 복구는 새 ID로 한다. 현재 플레이/시간 측정 프로필의 원격 이름·서버·삭제는 비차단 확인 대상으로 남긴다. 수락 시 해당 소유자만 필요한 선택 대기로 돌린다. 다른 프로필 삭제 수락으로 현재 선택을 해제하지 않는다. 측정 소유자 삭제는 로컬 삭제와 같이 거부한다.

첫 연결은 병합/Google 가져오기/로컬 유지(동기화 끄기)를 선택받고 적용 전 일관된 로컬 ZIP을 만든다. 가져오기에서 교체된 프로필의 일지는 원래 귀속으로 남긴다. 설정 수신은 기존 draft 병합을 사용하고 계산기 편집은 원래 소유자에 먼저 저장한다. 수신으로 현재 프로필을 자동 전환하지 않는다.

Google 데이터로 교체할 때 설정·숙제의 미저장 입력이 있으면 입력을 보존하고 먼저 저장하도록 안내한다. 계산기는 저장 후 적용 종료까지 같은 잠금을 유지한다. 원본/선택 설정 JSON/cursor는 기존 config commit journal로 함께 확정하며 실패 시 함께 되돌린다. 적용 전 ZIP은 같은 저장 잠금 안에서 만들고 fsync·CRC를 확인한 뒤 교체한다.

오래된 DB 복원/원격 자기 파일 삭제는 자동 덮어쓰기 없이 다시 선택받는다. 필요한 경우 새 writer 세대로 이어가며 원래 후보 시각을 보존한다. Google 계정별 cursor/파일 캐시를 분리하고 새 선택 전 쓰지 않는다. 복원/동기화 선택은 프로필 저장 잠금과 generation 검증을 공유한다.

DB의 localDevice와 현재 device-state.json의 기기 ID가 다르면 저장소를 여는 단계에서 복원 PC의 새 writer를 만든다. 프로필 ID·후보·인과 정보·삭제 표식·원래 변경 시각은 유지하고 원래 PC의 ACK/파일 ID/계정 연결/cache/cursor는 제거한다. 원래 계정 힌트만 로컬에 남겨 다른 빈 계정으로도 선택 없이 자동 업로드하지 않는다. 실행 중 백업 복원으로 DB를 다시 여는 경로에도 같은 처리를 적용한다.

## API와 예약

GoogleProfileDrive는 기존 OAuth만 사용한다. changes.list(spaces=appDataFolder)로 변경 metadata를 확인하고 version/md5가 바뀐 본문만 받는다. 최초 목록 전 start token을 확보하고 전 페이지/본문 검증/로컬 commit 뒤 cursor를 확정한다. 410은 전체 재확인, 반복 페이지는 오류다.

신규 ID는 files.generateIds(space=appDataFolder)에서 받아 보관한 뒤 생성한다. 기존 갱신은 읽은 v3 version과 v2 version의 일치를 확인하고 그때 얻은 명시 ETag로 같은 v2 리소스에 If-Match PUT한다. 404/412는 재조회하며 무조건 새 파일로 우회하지 않는다. 자기 writer 이외 파일은 수정하지 않는다.

스케줄러 하나가 활동30초/휴식5분, 사용자 변경3초/최대10초, 휴식 자동 숙제30초/최대60초를 합친다. 성공 조회 캐시·single-flight·지터·지수 지연·Retry-After·15분 상한을 적용한다. 수동 요청도 서버 대기 제한을 지킨다. 일반 채팅과 로컬 전용 저장은 예약하지 않는다. 종료는 journal을 먼저 보존하고 main의3초 한도 안에서 flush한다.

인터넷 시각은 NTP와 이미 수행한 Google HTTPS 응답의 Date를 사용한다. Date는 왕복 시간과 초 단위 정밀도의 오차를 포함하고 캐시된 응답을 제외하며 정확한 NTP 기준을 낮추지 않는다. 이를 위해 Drive 요청을 추가하지 않는다. 절전 복귀 시 이전 기준을 무효화하고 다시 확인한다. 새 시간 표본으로 과거 변경의 stamp를 수정하지 않는다.

본문 최대16 MiB, cell 최대100,000, context 기기 최대1,000. 프로젝트 quota/Google 네트워크 p95를 합성 검사로 검증했다고 표현하지 않는다.

## 관련 검사

- test:profile-sync-model — 실제 SQLite/원자성/필드·주기 병합/충돌/삭제/ACK/재시작/허용 목록.
- test:profile-sync-drive — HTTP/버전·ETag 경합/페이지/압축/크기/인증/요청 제한/취소.
- test:profile-sync — 두 PC/활동·휴식/최초 선택/오프라인/재전송/복원/계정 격리.
- test:profile-sync-concurrency — 독립 Electron 프로세스 2개/별도 SQLite/운영 HTTP transport·coordinator를 loopback Drive 대역에 연결한다. 실제 요청 두 개를 보류하고 양쪽 응답 순서를 바꾸며 다른 프로필·같은 필드·숙제 경합, 수신 중 편집, 전송 중 저장, 한쪽 실패/취소, 삭제와 늦은 입력을 검사한다. 실제 Google/물리 PC 2대 검증과 구분한다.
- test:profile-sync-ui — 제품 설정/preload/IPC/DB/ZIP/초안/선택 대기/측정 소유자 보호.
- test:profile-sync-budget — 실제66개 숙제,1/5/20/50프로필의 합성 크기·저장 비용/호출 예산.
- test:profile-sync:acceptance — 완료 시 관련 검사와 직접 영향받은 앱 회귀를 한 번 실행하고 소스 해시/로그 보관. 일상 변경마다 반복하지 않는다.
- test:profile-sync:live — 사용자 직접 OAuth, 임시 userData/격리 test namespace의 실서비스 왕복/조건부 갱신/충돌 후 검사 파일 정리. 일반 자동 검사에 포함하지 않는다.

측정/증거는 [재개발 검증](../../docs/development/google-sync-verification.md)을 따른다. 공식 참조(2026-11-04): [appData](https://developers.google.com/workspace/drive/api/guides/appdata), [changes](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list), [파일 ID](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds), [v2 version/ETag](https://developers.google.com/workspace/drive/api/reference/rest/v2/files), [한도](https://developers.google.com/workspace/drive/api/guides/limits).
