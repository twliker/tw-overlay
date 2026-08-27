# 가짜 테일즈위버 Windows 테스트 도구

실제 테일즈위버를 실행하지 않고 tracker, 창모드, 창모드 전체화면, foreground와 Z-order 정책을 반복 검증하는 Windows 전용 fixture다. 제품 코드에 테스트용 탐지 우회는 넣지 않는다. 실행 파일 이름의 `InphaseNXD`를 실제 tracker가 정상 경로로 탐지한다.

## 권한과 준비

- .NET 8 Desktop Runtime/SDK와 프로젝트의 Node.js 의존성이 필요하다.
- 실제 테일즈위버와 배포된 TW-Overlay가 관리자 권한으로 실행되므로 fixture도 기본적으로 `requireAdministrator` 매니페스트를 사용한다.
- 실제 HWND 통합 검사는 Electron 실행기와 fixture의 무결성 수준을 맞추기 위해 **관리자 PowerShell**에서 실행해야 한다.
- 검사는 foreground를 전환하고 테스트 창을 표시한다. PC를 사용하지 않는 동안 실행한다.

관리자 PowerShell에서 다음 한 명령으로 앱, fixture, 창모드와 창모드 전체화면 시나리오를 모두 빌드·실행한다.

```powershell
cd C:\git\trendlog2day\tw-overlay
npm run test:zorder:windows
```

검사는 다음을 확인한다.

- 실제 tracker가 fixture HWND를 게임으로 탐지한다.
- 창모드는 caption을 유지하고, 창모드 전체화면은 선택 모니터 전체를 borderless로 채운다.
- 게임 또는 TW-Overlay가 전경이면 게임 HWND를 바꾸지 않고 TW-Overlay 창만 게임 위에 표시한다.
- 외부 앱이 전경이면 TW-Overlay가 즉시 Non-Topmost로 복귀하고 `외부 앱 > TW-Overlay > 게임`의 보이는 순서를 유지한다.
- Electron의 숨은 보조 HWND를 사용자에게 보이는 창으로 오인하지 않는다.
- 모든 정렬은 게임과 외부 앱의 foreground, 게임 위치·크기·Topmost 상태를 바꾸지 않는다.

## 수동 실행

먼저 fixture만 빌드한다.

```powershell
npm run build:zorder-fixture
```

빌드 결과는 Git에서 제외되는 아래 경로에 생성된다.

```text
scripts\fixtures\FakeTalesWeaver\bin\Release\net8.0-windows\InphaseNXD-zorder-fixture.exe
```

창모드와 주 모니터 창모드 전체화면 실행 예시는 다음과 같다. 실행 시 Windows UAC 확인이 표시된다.

```powershell
.\scripts\fixtures\FakeTalesWeaver\bin\Release\net8.0-windows\InphaseNXD-zorder-fixture.exe --mode windowed
.\scripts\fixtures\FakeTalesWeaver\bin\Release\net8.0-windows\InphaseNXD-zorder-fixture.exe --mode borderless --monitor 0
```

수동 조작 키는 다음과 같다.

- `F11`: 창모드와 창모드 전체화면 전환
- `F8`: fixture 자체 Topmost 전환
- `F9`: 최소화
- `Ctrl+Q`: 종료

주요 인자는 `--mode windowed|borderless`, `--monitor N`, `--bounds x,y,width,height`, `--topmost`, `--activate`, `--lifetime-ms N`이다.

## 자동화 채널

`--status-file`에는 PID, HWND, mode, bounds, monitor bounds, foreground HWND와 마지막 명령 번호를 JSON으로 원자 저장한다. `--command-file`은 증가하는 `sequence`를 가진 JSON 명령을 받는다.

```json
{"sequence":1,"action":"activate"}
```

지원 action은 `activate`, `minimize`, `restore`, `close`다. 같은 명령에서 `mode`와 `topMost`도 변경할 수 있다.

```json
{"sequence":2,"action":"restore","mode":"borderless","topMost":false}
```

이 채널을 이용하면 이후 최소화·복원, Topmost 특수 상태, 모니터 이동, DPI 전환, 게임 시작·종료와 자동 생성 창 시나리오를 실제 게임 없이 확장할 수 있다.

## fixture 개발 전용 일반 권한 실행

현재 터미널이 관리자가 아닐 때 fixture와 probe 자체를 개발하는 용도로만 아래 경로를 사용할 수 있다.

```powershell
npm run build
dotnet build scripts/fixtures/FakeTalesWeaver/FakeTalesWeaver.csproj --configuration Release --nologo -p:FixtureRequireAdministrator=false
.\node_modules\.bin\electron.cmd dist-tools/runtime-zorder-windows-probe.js --allow-unelevated
```

이 결과는 권한 경계가 실제 배포 환경과 다르므로 최종 통과 증거로 사용하지 않는다. 개발 확인 뒤 `npm run build:zorder-fixture`를 다시 실행하면 기본 관리자 매니페스트 결과로 복원된다.
