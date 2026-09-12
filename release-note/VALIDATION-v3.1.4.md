# v3.1.4 검증 기록

- 검증일: 2026-09-12 (Asia/Seoul)
- 범위: v3.1.3 이후 변경, Store 자동 실행 수정 통합, 3.1.4 메타데이터 및 보안 의존성 갱신.
- 판정: 자동 검사·관리자 Z-order·패키지 검사 통과. 남은 필수 실기와 실제 설치·업데이트 검수는 사용자가 정상 동작을 확인했다.

| 검사 | 결과와 근거 |
| --- | --- |
| 의존성 설치·타입 검사 | npm ci, npm run typecheck 종료 코드 0 |
| 전체 회귀 | npm test 통과. Electron DOM, audit 및 자동 실행 회귀 포함 |
| 부하 검사 | 500건 burst, 10초간 1,200건 지속 유입 정합성 통과 |
| 프로덕션 의존성 | npm audit --omit=dev --audit-level=critical 종료 코드 0, 취약점 0건 |
| 관리자 Z-order | 20:46 KST 사용자 제공 실행 출력의 passed=true, elevated=true. windowed·borderless의 foreground 보존, 외부 창 우선과 오버레이 순서 복구 통과 |
| NSIS 패키지 | EXE에서 추출한 앱 리소스 816개가 빌드와 일치. 네이티브 모듈 및 개발 도구 제외 확인 |
| 자동 업데이트 파일 | latest.yml의 버전·파일명·크기·SHA-512 일치, blockmap 6,157개 블록 검증 |
| Store 패키지 | StartupTask, 도우미 asInvoker·GUI subsystem, 패키지 ID·권한·VCLibs·타일·네이티브 모듈 검사 통과 |
| 설치본·실기 | 사용자가 “나머지 다 정상동작 확인했어”라고 확인. 설치·업데이트·데이터 보존, 실게임·두 PC 및 Store 자동 실행 로그인 경로 포함 |

관리자 검사는 사용자 제공 로그, 나머지 실기는 사용자 확인에 근거한다. 개별 실기 환경·측정값이나 서명된 Store 테스트 사본의 해시는 별도로 제공되지 않았다. 선택적 고위험 복원 실기는 필수 게이트에 포함하지 않는다.

검증한 제품 코드와 설치 파일의 동일성을 다시 확인했다. 아래 AppX는 Store 제출용 미서명 원본이며, 실제 설치본 검수 확인과 파일 서명 상태는 별도로 기록한다.

| 산출물 | SHA-256 |
| --- | --- |
| twOverlay-Setup-3.1.4.exe | `1b325ff96128ec837bcbd4fcba8f013bafe2fba6e299b4898f206bd0571110eb` |
| twOverlay-Setup-3.1.4.exe.blockmap | `f8f86b94021752ca0459f09c842ce6338f27514ee6aac0000cbfbd335160b7b9` |
| latest.yml | `60de8c592e485b649e9ab3058fa4dfd2a84f8870bfdaab5e7452af1b8b838c1b` |
| twOverlay-3.1.4.appx | `706d9c622a9bd8ea248b8f500bf97dc89c2ecdc6f818a8635dc7de6d0eaa157c` |

통합 후보의 변경 파일 57개에 대한 SHA-256 목록 지문: `6d85def37d4ce645b4ba540d9f9c4d40f5d758fd2a02d0e9989cdd44d3b94a52`. 이 검증 기록 문서는 검사 후 추가했으며 제품 코드와 산출물에는 영향을 주지 않는다.

## GitHub Actions 실패 후속 수정

[최초 v3.1.4 실행](https://github.com/twliker/tw-overlay/actions/runs/34692684310)은 자동 실행의 실제 바로가기 검사에서 실패했다. 회귀 검사 이후 단계는 실행되지 않아 설치 파일과 Draft Release가 생성되지 않았다.

- 발생 조건: Windows 시스템 ANSI 문자셋으로 표현할 수 없는 문자가 설정 경로에 포함되는 경우. GitHub Windows 러너의 한글 경로에서 실패했고, 한국어 Windows에서도 이모지 경로로 재현했다.
- 변경 전: WScript.Shell의 바로가기 TargetPath 설정이 실패해도 cscript가 종료 코드 0을 반환했다. 앱은 바로가기가 없는 상태를 등록 성공으로 처리했다.
- 변경 후: Electron의 네이티브 `shell.writeShortcutLink`로 동기 생성하고, 성공한 경우에만 Run에 등록한다. VBS의 관리자 권한 실행, Store StartupTask와 사용자 데이터 처리 방식은 유지한다.
- 회귀 범위: 실제 한글·공백·이모지 바로가기의 대상·작업 폴더·아이콘, 켜기→끄기→다시 켜기, 생성 실패 반환 및 예외 시 미등록을 검사한다. 동일한 새 검사에서 원래 태그의 구현은 실패했다.

위 표와 산출물 해시는 최초 태그 후보의 기록이다. 후속 수정의 CI 재실행과 새 산출물 검증 결과는 별도로 기록하며, 최초 후보의 실기 결과를 새 설치본의 실기 통과로 표시하지 않는다.

후속 수정의 로컬 `npm run typecheck`, `npm test`, `npm run test:stress`와 프로덕션 의존성 감사가 통과했다(취약점 0건). 새 NSIS에서 추출한 앱 리소스 816개가 빌드와 일치하며 네이티브 바로가기 코드 포함, latest.yml 및 blockmap 일치를 확인했다. 새 설치본의 실제 설치·로그인 검수와 GitHub Actions 재실행은 별도 확인 대상이다.

| 후속 NSIS 산출물 | SHA-256 |
| --- | --- |
| twOverlay-Setup-3.1.4.exe | `e5cc2f63fb1041f583c91483c5c42a66400d8eaf031280d7ddfc11aae25326f9` |
| twOverlay-Setup-3.1.4.exe.blockmap | `96504c83a14f385375aedeb06aae55b7143caf67848ed6abb3b5941c5b10b602` |
| latest.yml | `dcac2a5a54f9294e55dfee0258acdfab057ed5f705c1c165c19d7e94b237b89e` |
