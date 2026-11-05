# 2026-11-05 런타임·빌드 보안 후속 검증

후속 상태: 이 문서의 소스/패키지 해시는 런타임 이전 검증 당시 기록이다. 이후 실제 UI 확인에서 추가 결함을 발견해 logger·종료 안내·일반 창 검사 격리와 화면 표시를 수정했다. 관련 재검증·기본 크기 조작·남은 실기 범위는 [후속 문서](./manual-ux-review-2026-11-05.md)를 기준으로 한다.

## 변경과 작업 경계

전체 검수에서 남은 Electron 42 지원 종료와 minimatch 빌드 의존성 경고를 우선 처리한다. 사용 중인 관리자 개발 앱을 종료할 수 없어 `C:\Users\drt_0\.codex\worktrees\electron-security-upgrade\tw-overlay`, `codex/runtime-security-20261105`에서 작업한다. 원래 폴더의 당시 미커밋 변경 93개도 SHA-256을 확인하며 복사했다. 원래 앱/소스/의존성/빌드는 유지하며 실제 사용자 데이터를 읽거나 검사에 사용하지 않는다.

- Electron `^45.2.3`과 electron-builder `^26.18.0`으로 올렸다. CI Node.js 24는 유지한다. [공식 지원 정책](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)의 최근 세 안정 주버전 기준과 [45.2.3 릴리즈](https://github.com/electron/electron/releases/tag/v45.2.3)를 확인했다.
- [43~45 호환 변경](https://www.electronjs.org/docs/latest/breaking-changes)을 확인했다. sandbox의 Node shim 제거는 현재 preload가 런타임에 electron만 import하므로 별도 polyfill이 필요 없다. 실제 sandbox IPC로 검사한다. Clipboard는 제품에서 `navigator.clipboard`를 사용한다. Windows x64 배포를 유지한다.
- 45에서 `safeStorage` 동기 API는 deprecated지만 아직 동작한다. 기존 토큰 읽기/쓰기의 호환성을 유지하고 실제 암호화 왕복을 검사한다. 해당 API가 제거되는 다음 주버전 이전에는 인증 로드/저장의 비동기 전환을 별도 수행한다.
- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)의 수정 계열을 적용한다. `minimatch@>=7 <11`만 `^11.0.1`로 override하며 잠금 버전은 11.0.4이다. 구형 3/5의 함수 API를 유지한다. builder의 실제 matcher, universal의 named API, asar/glob/dir-compare의 함수 API와 unpacked 패키지를 검사해 강제 주버전 이전의 영향을 확인한다.

## 자동 검증 범위

- 독립 폴더의 새 `npm ci`로 잠금 파일의 재현성과 native 의존성을 확인한다. 원래 node_modules를 재사용하지 않는다.
- `test:build-dependencies`: 실제 builder의 Windows 포함/제외/brace·globstar/숨김 파일/asarUnpack 패턴과 구형 소비 API를 확인한다. `--archive`로 모든 현재 dist 파일의 바이트 일치, native unpack, 개발/검사 도구 제외를 확인한다.
- `test:runtime-compatibility`: 임시 SQLite의 WAL·실패 rollback·재연결·integrity, 소유한 실제 HWND의 Win32 PID, 실제 main/splash/overlay-view의 sandbox preload·수신자 교체·WebContentsView 이벤트·소비된 Escape 보존, 암호화 왕복을 검사한다. `--app-root`로 패키지 내부 코드도 검사한다.
- 런타임은 앱 전체에 영향을 주므로 이번 변경에서는 전체 `npm test`, stress, 강제 종료 복구, 실제 3.2.2 저장 API의 데이터 이전, 동기화 용량, Windows 시작/최소화/배치 행렬을 확인한다. 일상 기능 변경은 기존처럼 관련 회귀 검사만 선택한다.
- 패키지는 `electron-builder --win --dir --publish never`로 설치 없는 디렉터리 산출물을 만든다. NSIS 설치 파일을 만들거나 실행하지 않는다. 패키지의 파일 일치와 native/preload, 기존 데이터 이전·Windows 행렬을 검증한다.

## 실행 기록

실제 실행은 Electron 45.2.3 / Node.js 24.22.2 / module ABI 150이다. 새 `npm ci` 및 앱/도구 TypeScript 검사를 통과했다. 생산/전체 의존성 audit은 모두 0건이다. deprecated API/도구 안내까지 없다는 뜻은 아니다.

전체 파이프라인 최초 실행은 앞선 회귀 46단계를 통과한 뒤 자동 실행 검사에서 종료 코드 1을 반환했다. 자동 실행 기능과 실제 바로가기 검사는 모두 성공했지만 Electron이 계속 쓰는 userData와 사례 폴더를 동시에 삭제해 `ENOTEMPTY`가 발생했다. `check-auto-start.ts`의 사례 데이터와 Electron 임시 userData를 분리하고 소유한 사례 폴더의 제한된 삭제 재시도를 적용했다. 제품 자동 실행 구현·기능 검증은 바꾸지 않았다.

수정한 검사와 아직 실행하지 않은 나머지 5단계를 따로 실행해 모두 통과했다. 원래 실패 로그도 보존한다. 단일 `npm test` 명령이 처음부터 끝까지 종료 코드 0을 반환했다고 표시하지 않는다. 관련 검사만 재실행하는 개발 규칙에 따라 **회귀 52단계를 합산 완료**했다. 이후 소스 변경이 이 검사 파일 하나뿐인지 이전 fingerprint를 재구성해 확인했다.

| 검사 | 결과 |
|---|---|
| 새 npm ci / typecheck | 통과; 기존 node_modules 미사용 |
| 전체 회귀 범위 | 46단계 성공 + 자동 실행 검사 수정/재검증 + 잔여 5단계 성공 = 52단계 |
| 부하 | 고속 혼합 로그·초당 120개/10초 지속 부하 모두 통과 |
| profile-crash / profile-upgrade / profile-sync-budget | 강제 종료 WAL 복구, 실제 3.2.2 저장 API의 숙제/설정/일지/계산기 입력 이전, 1/5/20/50 프로필 용량 검사 통과 |
| Windows 개발 대역 | 12개 시작 순서/사이드바·독/창모드 조합 통과; 각 조합의 최소화·중앙 배치·선택·종료 리마인더 포함 |
| 디렉터리 패키징 / 파일 검사 | 새 builder로 통과; 최신 dist 파일 955개가 바이트 단위 일치, native unpack·개발/검사 파일 제외 확인 |
| 패키지 native/preload | 실제 app.asar 내부 코드의 SQLite·Koffi·3개 sandbox preload·암호화 왕복 통과 |
| 패키지 Windows 행렬 / 3.2.2 데이터 이전 | 같은 12개 조합과 구버전 저장 API 데이터 이전 통과. 개발/패키지 합계 24개 창 조합 |

자동 검증을 완료했다. 최종 결과는 작업 폴더의 `output/runtime-upgrade/latest.json`에 각 로그/런타임/패키지 SHA-256과 최초 실패·관련 재실행 경로를 포함해 기록했다. 원래 작업 폴더에서 복사한 93개 파일은 최종 검사에서도 바뀌지 않았다. 이전 `output/project-review`의 Electron 42 검사 결과를 새 런타임 결과로 소급하지 않는다. 최종 소스 fingerprint는 `45ffd12fbb4ff79bd5f147a37d18ef2d4fe7f053946014aedf8a17abae25da2f`(383개 파일)다.

## 남는 실제 환경 확인

원래 개발 앱/폴더에는 아직 반영하지 않았다. 앱 종료 후 변경을 통합하거나 검증 worktree로 전환해야 한다. 이 worktree를 사용하는 경우 의존성/빌드는 이미 분리돼 있다.

관리자 Z-order는 사용자가 새 런타임에서 `npm run test:zorder:windows`를 수행한다. 기존에 전달한 통과 결과는 당시 버전의 기록으로 보존한다. 실제 Google 왕복/물리 PC 2대/게임/설치·업데이트는 승인 후 CI 설치본으로 확인한다. 커밋·태그·푸시·Release 게시는 하지 않으며 푸시는 별도 승인이 필요하다.
