# TW-Overlay v3.0.0 실기 검증 체크리스트

이 문서는 자동 fixture로 대체할 수 없는 실제 Google 계정·두 PC·Windows 세션·게임 환경 검증 절차다. 실행하지 않은 항목은 통과로 표시하지 않는다. 실패하면 시각, PC, 직전 동작, `debug.log`의 관련 구간과 화면 캡처를 남기고 릴리즈를 보류한다.

## 1. 테스트 준비

- [ ] 회사/집 역할의 서로 다른 Windows PC 두 대를 준비한다.
- [ ] 두 PC에 같은 검증 빌드를 사용하고 설치 파일의 SHA-256을 기록한다.
- [ ] 기존 사용자 데이터는 앱의 백업 기능으로 별도 보관한다.
- [ ] 테스트용 Google 계정을 사용하고 두 PC에서 같은 계정으로 로그인한다.
- [ ] Discord Webhook URL, OAuth token, 로그 경로, 커스텀 사운드 절대경로가 캡처나 공유 로그에 노출되지 않게 마스킹한다.
- [ ] 각 시나리오 시작 전 PC 이름 대신 `PC-A`, `PC-B`로 기록하고 실제 이메일은 기록하지 않는다.

### 공통 증거 수집

1. 두 PC에서 같은 설치 파일을 사용하고 `Get-FileHash -Algorithm SHA256 <설치파일>` 결과의 `Hash`만 기록한다.
2. 설정 > 백업 & 복구 > Google Drive 클라우드 동기화에서 파일별 `로컬` checksum, `클라우드` revision, `대기 N개/전송 완료`를 시나리오 전후에 기록한다. 계정 이메일이 보이는 영역은 캡처하지 않는다.
3. 원격 숙제 operation은 같은 화면의 `데이터 확인`에서 `tw_overlay_checklist.json`의 `revision`, `checksum`, `operations[].id`만 확인한다. `data` 전체에는 캐릭터 이름과 사용자 설정이 있으므로 원본 JSON 전체를 공유하지 않는다.
4. 데스크톱 설치판의 로컬 상태는 기본적으로 `%APPDATA%\twOverlay\cloud-sync-state.json`에 있다. 저장소 루트에서 다음 수집기를 실행하면 설치 파일은 SHA-256만, 로컬 상태는 판정에 필요한 generation/revision/dirty/operation/recovery만 JSON으로 출력한다. 실제 경로, device ID, Drive file ID, base snapshot, Webhook, 캐릭터 이름과 원문 오류는 출력하지 않는다. `-InstallerPath`는 생략할 수 있으며 PC-B에서는 `-DeviceLabel PC-B`를 사용한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collect-v3-manual-evidence.ps1 `
  -DeviceLabel PC-A `
  -InstallerPath 'C:\검증빌드\twOverlay-Setup.exe'
```

Microsoft Store 빌드처럼 userData 경로가 다르면 `debug.log`의 `[BOOT] UserData path`를 로컬에서 확인하고 `-StatePath`로 지정한다. 경로 자체는 결과 JSON에 포함되지 않는다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collect-v3-manual-evidence.ps1 `
  -DeviceLabel PC-B `
  -StatePath 'C:\실제 userData\cloud-sync-state.json'
```

수렴 직후 두 PC의 출력을 각각 `evidence-pc-a.json`, `evidence-pc-b.json`으로 저장하고, 사용자 조작 없이 2분 기다린 뒤 `evidence-later-pc-a.json`, `evidence-later-pc-b.json`을 같은 방식으로 저장한다. Windows PowerShell에서는 다음처럼 `Set-Content -Encoding UTF8`을 사용한다. 비교기는 Windows PowerShell의 기본 리다이렉션으로 만들어진 UTF-16 BOM 파일도 읽는다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collect-v3-manual-evidence.ps1 `
  -DeviceLabel PC-A `
  -InstallerPath 'C:\검증빌드\twOverlay-Setup.exe' |
  Set-Content -LiteralPath .\evidence-pc-a.json -Encoding UTF8
```

두 PC가 수렴한 뒤 다음 비교기를 실행한다. 교차 변경에서 기록한 operation ID는 쉼표로 연결한다. `passed: true`와 종료 코드 0이면 generation, 설정·숙제 revision, 설치 파일 hash, 빈 dirty/outbox/recovery, 양쪽 operation 보존과 2분 무 echo 조건이 모두 일치한다. 종료 코드 1은 검증 불일치, 2는 입력 파일·인수 오류다. 설치 hash를 수집하지 않은 경우에는 실패 대신 warning을 출력한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\compare-v3-manual-evidence.ps1 `
  -PcAPath .\evidence-pc-a.json `
  -PcBPath .\evidence-pc-b.json `
  -LaterPcAPath .\evidence-later-pc-a.json `
  -LaterPcBPath .\evidence-later-pc-b.json `
  -ExpectedOperationIds 'pc-a-operation-id,pc-b-operation-id'
```

수집기를 사용할 수 없는 경우에만 다음 최소 PowerShell을 사용한다. 값이 포함된 base snapshot과 Drive file ID는 출력하지 않는다.

```powershell
$twStatePath = Join-Path $env:APPDATA 'twOverlay\cloud-sync-state.json'
$twState = Get-Content -LiteralPath $twStatePath -Raw | ConvertFrom-Json
[pscustomobject]@{
  profileState = $twState.profileState
  generationId = $twState.generationId
  remoteRevisions = $twState.remoteRevisions
  settingsDirtyKeys = @($twState.settingsDirtyKeys)
  checklistOutboxIds = @($twState.checklistOutbox.id)
  confirmedOperationIds = @($twState.confirmedChecklistOperations.id)
  shutdownRecovery = $twState.shutdownRecovery
  lastPullAt = $twState.lastPullAt
} | ConvertTo-Json -Depth 6
```

5. `google_auth.enc`, `google_user.json`, `config.json`, `cloud-sync-state.json` 원본은 공유하지 않는다. `debug.log`는 `[CloudSyncManager]`, `[SHUTDOWN]`, `[DiaryDB]` 관련 줄만 복사하고 이메일·절대경로가 섞였는지 다시 확인한다.
6. echo upload 검증은 파일별 revision과 마지막 동기화 시각을 수렴 직후 기록하고 2분 뒤 다시 기록한다. 사용자 조작이 없었는데 revision이 바뀌면 두 PC 시각과 관련 로그 줄을 함께 남긴다.

자동 수집기 검증 기록(2026-08-26, `97a9ff8`): 비밀 device/file ID, Webhook, 캐릭터 이름, 원문 오류의 로컬 경로를 포함한 상태 fixture와 임의 설치 파일을 입력했다. 결과에는 허용한 generation/revision/dirty/operation/recovery와 정확한 설치 SHA-256만 남았으며 모든 비밀 표식과 입력 파일 경로가 제외됐다. Windows PowerShell에서 `Get-FileHash` 모듈이 없는 환경도 동작하도록 SHA-256은 .NET 스트림으로 계산한다.

자동 비교기 검증 기록(2026-08-26, `633a5f2`): UTF-8 PC-A 증거와 Windows PowerShell 리다이렉션 형식의 UTF-16 BOM PC-B 증거를 실제 `powershell.exe`로 비교했다. 정상 수렴과 2분 revision 유지가 통과했고 generation/checklist revision 불일치, 남은 outbox, operation 누락과 대기 중 revision 변화는 각각 실패 코드로 검출됐다. 비교 결과에는 원본 경로나 사용자 데이터가 포함되지 않는다.

## 2. 실제 두 PC 클라우드 교차 동기화

### 서로 다른 숙제 동시 변경

- [ ] 두 PC가 같은 원격 상태를 수신한 것을 확인한다.
- [ ] 네트워크를 유지한 채 PC-A와 PC-B에서 서로 다른 숙제를 1초 이내에 변경한다.
- [ ] 두 operation ID가 최종 원격 숙제 payload에 존재하는지 확인한다.
- [ ] 양쪽 로컬 상태가 두 변경을 모두 포함해 수렴하는지 확인한다.
- [ ] 수렴 뒤 설정/숙제의 불필요한 echo upload가 반복되지 않는지 2분 이상 관찰한다.

### 같은 숙제 충돌

- [ ] 같은 숙제를 양쪽에서 완료/해제로 교차 변경한다.
- [ ] 같은 숙제 횟수를 서로 다른 값으로 변경한다.
- [ ] 실제 플레이 중인 로컬 변경 우선 정책과 operation 보존 결과가 계획과 일치하는지 확인한다.
- [ ] 양쪽 앱을 계속 실행한 상태에서 게임 실행 중 약 30초, 게임 미실행 시 약 5분 안에 pull되는지 확인한다.

자동 강화 기록(2026-08-26, `8f643f1`, `9974c5a`, `ab443e9`, `2fe2491`, `5043162`, `8695630`, `d8711d2`): 완료·해제·횟수 0~3, 같은 필드 충돌·다른 캐릭터 변경과 operation 순서를 조합한 256개 결정론적 stress fixture에서 원격 결과와 두 로컬 상태가 모두 수렴하고 최종 payload에 두 operation ID가 유지됐다. 이어 독립 userData의 실제 `main.js` 두 프로세스를 동시에 실행해 같은 원격 revision에서 시작하게 했다. `5043162`에서 시도한 기준 캐릭터 기록 부재는 앱 초기화가 정상 기본값 `false/0`과 파생 operation으로 보정하는 비정상 fixture였으므로 정상 기준 상태로 정정했다. 반복 실행 중 두 operation ID가 모두 보존돼도 마지막 업로더에 따라 원격 또는 한쪽 로컬 횟수가 1/2로 갈리는 실제 결함이 재현됐다. `8695630`에서 업로드 전과 수신 병합 후 전체 operation을 결정적 순서로 재생해 canonical data를 사용하도록 수정했다. `d8711d2`에서는 메타 업로드가 섞인 전체 순서를 숙제 전용 순서로 분리하고, 두 첫 숙제 payload 생성 뒤 barrier를 풀어 상호 overwrite와 세 번째 이상의 누락 operation 재게시를 실제로 강제했다. 비충돌·동일 필드 시나리오 각각 5회에서 회사 완료와 집의 더 늦은 횟수 2·시각 변경이 최종 원격·양쪽 로컬에 동일하게 반영됐고, 두 operation ID 보존, outbox 정리, 양쪽 재시작 무 echo도 유지됐다. Windows 테스트 잠금 디렉터리 경합의 일시 `EPERM`은 제한 재시도로 보강했다. 실제 두 Windows PC와 Google Drive의 전송 시각·poll 간격·echo 여부를 대신하지 않으므로 실기 항목은 대기로 둔다.

주기 계측 기록(2026-08-26, `fb49591`, `055dfbd`, `54f9320`, `4021977`, `fc25244`): 실제 `cloudSyncManager` scheduler는 같은 installation ID의 jitter를 적용해 게임 실행 상태에서 27~33초, 미실행 상태에서 270~330초 범위의 다음 pull을 각각 하나 예약하고 중지 시 정리했다. 게임 실행 중 Drive 목록 조회 실패 뒤 첫 재시도는 54~66초 범위로 증가했고, 다음 성공 뒤 27~33초 범위로 초기화됐다. 즉시 pull은 기존 장기 타이머를 취소하고 Drive 목록을 바로 조회한 뒤 정상 후속 타이머 하나를 다시 예약했다. 후속 dirty 업로드 정리에는 별도 목록 조회가 추가될 수 있다. 로그인 성공·앱 시작·절전 복귀·잠금 해제·10초 네트워크 복구 감지·게임 시작·자동 동기화 활성화의 최초/즉시 pull 연결은 정적 회귀 검사로 고정했다. 실제 두 PC·Google Drive에서 변경이 해당 시간 안에 도착하고 Windows 이벤트와 계정 로그인이 즉시 요청을 발생시키는지는 실기로 남긴다.

### 응답 유실·overwrite·재시작

- [ ] PC-A 업로드 직후 PC-B가 같은 원격 파일을 덮어쓰는 상황을 만든다.
- [ ] 확인했던 operation이 사라지면 PC-A가 안정 mutation을 다시 게시하는지 확인한다.
- [ ] 업로드 요청 도중 네트워크를 끊어 응답 유실을 만들고 로컬 outbox/recovery가 유지되는지 확인한다.
- [ ] 앱을 종료·재시작한 뒤 원격 revision/checksum/operation 확인으로 중복 없이 재수렴하는지 확인한다.

### 새 PC·부분 복원

- [ ] 완전히 빈 사용자 데이터에서 `fresh`로 판정되고 설정/숙제를 독립 복원하는지 확인한다.
- [ ] 기존 `config.json` 또는 `diary.db`가 있는 설치는 `established`로 판정되는지 확인한다.
- [ ] 설정 파일만 있거나 숙제 파일만 있는 경우 정상 파일만 선택해 복원할 수 있는지 확인한다.
- [ ] 손상된 메타, 중복 파일명, generation 불일치에서 정상 데이터가 함께 실패하지 않는지 확인한다.
- [ ] 선택하지 않은 파일과 클라우드 제외 설정이 현재 PC 값으로 유지되는지 확인한다.
- [ ] 복원 전 로컬 백업으로 되돌리기가 가능한지 확인한다.

부분 계측 기록(2026-08-26, `b1fbef7`, `e7f7b57`, `26d95c2`, `0c5d6f0`): 지속형 모의 Drive에 손상된 설정·정상 숙제·손상된 메타를 두고 실제 `main.js`를 fresh 상태로 시작했다. 정상 숙제만 복원되고 설정은 `invalid`, 프로필은 `needs-confirmation`으로 남았다. 수정 전에는 같은 userData 재시작 중 사용자 선택 전에 원격 다운로드 3회와 숙제·메타 업로드가 발생했지만, 자동 전송 게이트 수정 후 2.2초 동안 다운로드·업로드 모두 0회였고 로컬 `userServer=7`과 원격 `userServer=16`이 그대로 유지됐다. 이어 설정만 선택해 복원하면 그 직후 숙제·캐릭터 상태와 숙제 무전송이 유지되고, `established` 전환 뒤 새 설정 변경은 1.5초 debounce로 원격에 다시 업로드됐다. 반대로 정상 설정·손상된 숙제도 별도 fresh userData로 시작해 설정만 적용되고 기존 로컬 캐릭터와 무전송 상태가 유지되는 것을 확인했다. 별도 프로세스에서는 설정·숙제를 모두 복원한 뒤 복원 전 백업으로 되돌려 로컬 두 종류가 원상복구되고, 되돌린 상태가 설정·숙제 원격 파일에 각각 재전송된 후 dirty/outbox가 정리되는 것까지 확인했다. 실제 Google 계정의 파일 선택 UI·복원·되돌리기는 수행하지 않았으므로 체크 항목은 대기로 둔다.

자동 경계 역감사(2026-08-26, `4ef6153`, `6f8558c`): 빈 폴더=`fresh`, 임시 config 또는 손상 DB=`needs-confirmation`, 정상 config 또는 SQLite header=`established` 판정을 다시 대조했다. 손상된 최신 중복 설정·메타보다 이전 유효 메타의 두 참조를 선택하는 경우, 메타 없이 generation이 다른 설정만 `generation-mismatch`로 격리하고 정상 숙제만 복원하는 경우, 설정 파일만 또는 숙제 파일만 존재하는 양방향 부분 복원도 모두 실행 단정에 포함돼 있었다. 새 결함이 재현되지 않아 제품 코드는 변경하지 않았다.

## 3. Windows 종료·복구

- [x] 일반 종료 직후 창과 트레이가 사라지고 전체 정리가 최대 3초를 넘지 않는지 측정한다.
- [x] 설정 dirty만 있는 종료, 숙제 outbox만 있는 종료, 두 파일 모두 dirty인 종료를 각각 확인한다.
- [ ] 업로드 중 네트워크를 끊거나 응답을 잃은 종료에서 파일별 recovery marker가 남는지 확인한다.
- [ ] 다음 실행에서 실제 원격 반영 여부에 따라 recovery가 제거되거나 재시도되는지 확인한다.
- [x] 종료 중 두 번째 종료 요청이 finalizer를 우회하지 않는지 확인한다.
- [ ] Windows 로그오프와 시스템 종료가 지연되거나 취소되지 않는지 확인한다.
- [ ] 재로그인 뒤 config, 숙제 outbox, 일지 DB와 WAL 데이터가 보존되는지 확인한다.

부분 계측 기록(2026-08-26): `bdb3fdc` 기반 빈 userData 격리 source Electron을 자동 `app.quit()`으로 종료했을 때 visible window가 1개에서 22ms 안에 0개가 되었고 전체 quit는 26ms였다. `93d2922`에서는 Electron 진입 전에 `appData`를 격리한 fresh 프로필을 실제 Windows UI의 `Alt+F4`로 종료했다. 생산자 중지부터 WAL 72/72 checkpoint와 DB close까지 로그 시각 기준 9ms였고 프로세스 종료로 창과 트레이가 함께 제거됐다. `0884202`의 별도 Electron 프로세스 재시작 검사에서는 설정 dirty만, 숙제 outbox만, 두 파일 모두 dirty인 세 조합의 dirty key·operation ID·recovery marker가 디스크에 동일하게 보존됐다. `65ea23d`는 같은 세 조합을 표시 창이 있는 실제 `main.js`로 각각 시작·종료해 창 숨김 100ms·전체 종료 3초 제한, marker 보존, WAL checkpoint와 DB close를 검증했다. `431c2a9`에서는 응답하지 않는 격리 Drive 요청을 약 3초 뒤 정확히 한 번 취소하고 종료 시점 dirty/outbox marker, WAL checkpoint와 DB close를 보존했다. `62dd7a6`에서는 timeout 시작 100ms 뒤 두 번째 외부 quit를 요청해도 최초 finalizer가 정리를 끝낸 뒤 내부 최종 quit에서만 종료되는 것을 확인했다. `35f3dab`에서는 main 창의 `query-session-end` 이벤트가 취소되지 않고 핸들러 반환 시점에 dirty/outbox marker가 저장되며 WAL checkpoint가 실행되는 fast path를 확인했다. `bb2e782`, `4257b5b`에서는 지속형 모의 Drive에 설정 또는 숙제 payload를 실제로 반영한 뒤 각 업로드 응답을 무기한 유실시켰다. 첫 `main.js` 프로세스는 3초 timeout 뒤 파일별 dirty/outbox와 recovery marker를 남겼고, 같은 userData로 재시작한 두 번째 프로세스는 설정 revision/checksum 또는 숙제 operation을 확인해 이미 반영된 대상 파일을 중복 업로드하지 않으면서 반대 파일의 미전송 변경까지 처리했다. `013e4ba`에서 설정/숙제 응답 유실 종료를 각각 10회 반복했고 20회 모두 operation·recovery marker·1회 취소와 약 3.03~3.06초 종료를 유지했다. 비동기 debug 로그 파일을 너무 일찍 읽던 probe 계측 경합은 동기 logger 관찰로 제거했다. `0a9c412`에서는 빠른 일반 종료 10회가 창 숨김 24~28ms·전체 34~42ms, timeout 종료 5회가 창 숨김 8~16ms·전체 약 3.04~3.05초로 통과했고 1ms poll 및 WAL/DB 로그 판독 경합을 제거했다. 실제 Google Drive 네트워크 조건의 응답 유실·재확인과 실제 로그오프·시스템 종료는 수행하지 않았으므로 해당 항목은 대기로 둔다.

## 4. DPI·모니터·RDP·창 크기

- [ ] 100%, 125%, 150% 배율에서 앱을 시작하고 게임 기준 오버레이 정렬을 확인한다.
- [ ] 보조 모니터 연결·분리와 주 모니터 변경을 반복한다.
- [ ] 배율을 반복 전환해 사용자 위치 offset이 누적 이동하지 않는지 확인한다.
- [ ] Remote Desktop 연결·해제 중 임시 display 상태가 사용자 저장 위치를 덮지 않는지 확인한다.
- [ ] 1280×720 및 800×600급 작업 영역에서 대형 도구 창이 화면 안에 맞고 내부 스크롤이 가능한지 확인한다.
- [x] 독 하단↔상단 변경과 퀵링크 변경이 숨겨진 창 재사용 상태에서도 즉시 반영되는지 확인한다.

부분 계측 기록(2026-08-26): `8715215` 기반 격리 source Electron을 2560×1440 물리 모니터에서 강제 1/1.25/1.5 배율로 각각 시작했다. renderer DPR은 1/1.25/1.5와 일치했고 2560×1392, 2048×1114, 1707×928 DIP 작업영역의 기본 계수 계산기는 영역 안에 표시됐다. 추가 2×/3× probe의 1280×696에서는 계수 계산기와 모험일지 모두 1240×656으로 clamp되고 내부 세로 스크롤이 동작했다. 854×464에서는 모험일지가 816×424로 정상인 반면 계수 계산기 문서 폭이 998px로 남아 183px가 잘리는 F-09를 재현했다. `750ec60` 수정 후 동일 계수 계산기 probe는 document client/scroll 폭 811/811px, 세로 1,241px와 실제 scroll 이동을 확인했고 일반 1100px 2열·360px 가이드도 유지했다. `1291779` 실게임 확인에서는 숨긴 독 재사용 상태에서 상단/하단 변경과 퀵링크가 즉시 반영됐다. 실제 Windows 배율 설정 전환과 게임 기준 오버레이 정렬, 1280×720·800×600 물리 작업영역은 수행하지 않았으므로 해당 체크 항목은 대기로 둔다.

## 5. Z-order·작업표시줄·포커스 소크

- [x] 독 메뉴 클릭, 독 숨김/표시, 같은 모니터 Alt+Tab, 다른 모니터 Alt+Tab을 조합한다.
- [x] 외부 앱이 전경일 때 해당 모니터 작업표시줄이 정상 표시되고 게임 복귀 뒤 게임 위에 남지 않는지 확인한다.
- [ ] 자동 생성되는 브라우저·채팅·숙제·독 창이 게임 포커스를 빼앗지 않는지 확인한다.
- [ ] 독과 입력 도구 창은 사용자가 명시적으로 클릭했을 때 정상 입력 가능한지 확인한다.
- [ ] 채팅, 보스, 거래, 갤러리 알림과 설정 자동 반영을 켠 상태로 30~60분 무조작 플레이한다.
- [ ] 작업표시줄 노출, 오버레이 후퇴, 독 클릭 불가, 반복 깜박임이 한 번도 발생하지 않는지 확인한다.

부분 실기 기록(2026-08-25, `1291779`): 사용자 실게임 환경에서 독 메뉴 클릭·숨김/표시, 같은/다른 모니터의 외부 프로그램 전환, 작업표시줄 복구와 게임 위 오버레이 유지가 정상임을 확인했다. 독은 재생성하지 않고 숨긴 창을 재사용하며 상단/하단 위치와 퀵링크 변경도 즉시 반영됐다. 자동 생성 창 전체의 포커스, 모든 입력 도구와 알림을 켠 30~60분 무조작 소크, 반복 깜박임 부재는 별도 증거가 없으므로 완료로 표시하지 않는다.

## 6. 실제 대형 로그·Tail 복구

- [x] 정상 수 MB 당일 로그가 기존 전체 검색 동작을 유지하는지 확인한다.
- [x] 32MB를 넘는 테스트 로그에서 제한 모드가 활성화되고 앱 메모리가 지속 증가하지 않는지 관찰한다.
- [x] UTF-8, EUC-KR, BOM 포함 파일과 멀티바이트 문자가 청크 경계에 걸린 파일을 확인한다.
- [x] 로그 파일을 잠그거나 일시적으로 접근 불가하게 만들어 1/2/4/8/16초 재연결을 확인한다.
- [x] 사용자 지정 로그 경로가 잠시 사라져도 다른 자동 탐색 경로로 설정을 덮어쓰지 않는지 확인한다.
- [x] 주간 동기화 중 잠긴 일부 파일이 부분 실패로 표시되고 정상 파일 결과는 반영되는지 확인한다.
- [x] 앱 재시작 뒤 확정 offset부터 재개하며 동일 event ID가 DB에 중복 반영되지 않는지 확인한다.

부분 계측 기록(2026-08-26, `be3c13b`, `85533d9`, `e034f88`): 실제 Electron 격리 프로세스에서 40MB 당일 로그에 4MB를 추가해 최근 16MB 제한 모드, 오래된 4,317줄 trim, 재시작 뒤 제한 모드와 최근 marker 보존을 확인했다. 2분 지속 검사에서는 40.0→42.05MB, 초당 120줄·총 14,400줄을 처리했고 16MB 도달 후 22,194줄을 제거해 12.77M chars로 복귀했다. heap은 80.96→44.37MB, RSS는 204.71→130.57MB, 최대 event-loop lag는 14ms였다. 8.05MB·50,002줄 정상 로그는 전체 검색 모드에서 앞·뒤 marker를 보존했다. Tail 파일 부재를 16초 최종 예약까지 유지한 검사에서는 1/2/4/8/16초 백오프를 모두 거쳐 재연결됐고 기존 50,002줄 중복 없이 live 한 줄만 추가됐다. PowerShell 별도 프로세스가 `FileShare.None`으로 2개 중 1개 로그를 실제 잠근 검사에서는 정상 파일만 반영한 부분 성공과 잠금 해제 후 두 파일·4줄·실패 0개 재수렴을 확인했다. UTF-8, UTF-8 BOM, EUC-KR 및 첫 한글 바이트가 256KB 경계 직전에 놓인 UTF-8 실제 파일 4개도 판별·처리하고 재실행 신규 반영 0건을 확인했다. 별도 Electron 프로세스 재시작은 확정 offset 188을 유지해 신규 반영 0건이었고, 사용자 지정 로그 폴더를 통째로 이동·복원해도 config 경로가 유지되고 watcher가 복구됐다. 2분 검사에서 발견한 유효 UTF-8 손상 오경고는 수정 후 동일 42MB 파일의 `damaged: false`, 대체 문자 0개로 확인했다. 실제 게임 로그 장시간 소크는 별도로 남긴다.

## 7. 결과 기록

| 항목 | 빌드/커밋 | 환경 | 시작~종료 시각 | 결과 | 증거/비고 |
|---|---|---|---|---|---|
| 두 PC 클라우드 | `8f643f1`, `9974c5a`, `ab443e9`, `2fe2491`, `5043162`, `fb49591`, `8695630`, `055dfbd`, `54f9320`, `4021977`, `fc25244`, `d8711d2` | 독립 userData 실제 `main.js` 2개 / 지속형 모의 Drive / 실제 매니저 scheduler | 2026-08-26 07:48~10:50 KST | 부분 통과 | 같은 revision 시작, 첫 숙제 payload 업로드 barrier로 실제 overwrite·세 번째 누락 operation 재게시 강제, 마지막 업로더에 따라 operation ID와 data가 불일치하던 결함 수정, 정상 기준의 완료·횟수 동일 필드 변경을 canonical 재생해 최종 원격/양쪽 로컬 두 operation 보존·outbox 정리, 양쪽 재시작 후 무 echo, 게임 실행 27~33초·유휴 270~330초, 첫 실패 54~66초·성공 후 초기화, 즉시 pull의 기존 타이머 취소·즉시 조회·후속 예약과 로그인 포함 일곱 시작/복구 이벤트 wiring 확인. 실제 Google 계정·두 Windows PC·poll/echo 대기 |
| 새 PC·부분 복원 | `b1fbef7`, `e7f7b57`, `26d95c2`, `0c5d6f0` | 실제 `main.js` / 지속형 모의 Drive / 동일 userData 재시작 | 2026-08-26 07:10~07:56 KST | 부분 통과 | 설정·숙제 양방향 독립 복원, 손상 파일 분리, `needs-confirmation` 재시작 무전송·양쪽 설정 보존, 설정 선택 복원 뒤 자동 전송 재개, 설정·숙제 복원 전 백업 되돌리기 및 후속 원격 수렴 확인. 실제 Google 계정 UI 조작 대기 |
| 종료·로그오프 | `93d2922`, `0884202`, `65ea23d`, `431c2a9`, `62dd7a6`, `35f3dab`, `bb2e782`, `4257b5b`, `013e4ba`, `0a9c412` | 격리 source Electron / Windows `Alt+F4` / 별도 Electron 재시작·main finalizer·Drive timeout·session-end 이벤트·지속형 모의 Drive | 2026-08-26 06:15~09:31 KST | 부분 통과 | 일반 종료, 세 dirty 조합, 3초 timeout 취소, 반복 quit 차단, session-end marker·WAL fast path, 설정/숙제별 원격 commit 후 응답 유실·재시작 무중복 수렴, 응답 유실 종료 20/20회 operation/recovery 보존, 일반 10회·timeout 5회 창 숨김/종료 계측 확인. 실제 Google Drive 응답 유실과 실제 로그오프·시스템 종료 대기 |
| DPI·모니터·RDP | `750ec60` | 격리 source Electron / 강제 100·125·150%·2×·3× | 2026-08-26 06:18~06:27 KST | 부분 통과 | DPR·창 clamp 확인, 854×464 계수 계산기 잘림 수정 및 scroll 검증. 실제 OS 배율 전환·게임 정렬·모니터/RDP 대기 |
| Z-order 소크 | `1291779` | 사용자 실게임 / 듀얼 모니터 / 외부 프로그램 전환 | 2026-08-25 | 부분 통과 | 독 클릭·숨김/표시·재사용, 같은/다른 모니터 전환, 작업표시줄 복구, 오버레이 유지, 독 위치·퀵링크 즉시 반영 확인. 자동 생성 창/입력 도구 전체와 30~60분 무조작 알림 소크 대기 |
| 대형 로그 소크 | `be3c13b`, `85533d9`, `e034f88` | 격리 Electron / UTF-8·BOM·EUC-KR / Windows 독점 잠금 | 2026-08-26 | 부분 통과 | 8.05MB 전체 검색, 40→42.05MB 2분·14,400줄·메모리 trim, Tail 1/2/4/8/16초 복원, 잠긴 1/2 파일 부분 성공·해제 후 재수렴, 256KB 경계, 실제 프로세스 재시작·지정 폴더 이동 복구. 장시간 게임 로그 대기 |

모든 행이 실제 증거와 함께 통과한 뒤에만 `implementation_plan.md`와 `walkthrough.md`의 실기 대기 상태를 완료로 갱신한다.
