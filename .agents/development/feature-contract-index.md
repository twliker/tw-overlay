# 기능 계약 주석 인덱스

새 Google 프로필 동기화: `ApplicationData.syncTransaction`/`profileSyncModel.ts`가 원본과 압축 journal을 함께 저장하고 `profileSyncCoordinator.ts`가 PC별 파일/활동·휴식 예약/ACK/오프라인·복원·계정 경계를 조립한다. `profileSyncDrive.ts`는 appData 변경 feed·gzip·읽은 version+명시 ETag를 사용하고 옛 파일은 전송하지 않는다. `profileCloudSync.ts`/`profileSyncIpc.ts`/`renderer/settings/profile-cloud-sync.ts`는 첫 연결/ZIP/초안/활성 소유자 확인/측정 중 삭제 보호를 맡는다. 기존 Google 중지 검사는 **구형 경로**를 계속 검증한다. 현행 계약: `google-drive-sync-contract.md`, 관련 완료 게이트: `test:profile-sync:acceptance`, 실서비스는 별도 사용자 로그인 `test:profile-sync:live`.

프로필 기능 완료 검사는 `npm run test:profiles:acceptance`를 사용하며 요구사항별 연결은 `docs/development/profile-acceptance-matrix.md`를 따른다. 프로필 관련 검사와 12개 Windows 시작/런처/창모드 조합, 현재 패키지 및 3.2.2 이전을 한 묶음으로 확인한다. `test:profile-crash`는 실제 SIGKILL 이후 WAL·미배정 원본·확정 기록·이전 세션 배정 및 재분석 중복을 확인한다. `profileRecording`의 선택 후 만료 초기화는 상태/일지 집계를 함께 확정하며 실패 시 기존 선택을 유지한다. 일상 변경은 해당 계약의 회귀 검사만 선택하고 기능 완료 시 이 묶음을 실행한다. 배포 실기 게이트를 대신하지 않는다.

프로필 부팅 마무리: `contentsChecker.init({deferRuntime:true})`는 기존 일지를 열지 않고 설정/만료 상태만 정규화하며 `profileApplication`이 새 DB/기록 귀속 연결 후 집계·리셋 타이머를 시작합니다. 검사: `test:profile-upgrade`(실제 3.2.2 패키지 저장 API·원본/백업·두 캐릭터/설정/숙제/일지/도구 입력), `test:profile-lifecycle`, `test:profile-recording` 및 refactor의 숙제 초기화 계약. `tracker.canAutomaticallyRestoreGameFocus`는 게임 최소화/숨김을 자동 복구로 되돌리지 않습니다. `test:profile-windows`는 실제 main/tracker/폴링/선택창과 세 가지 시작 순서·최소화·서버 전환·기록 귀속을 확인합니다. 개발용 게임 대역이며 실게임/관리자/설치 게이트를 대체하지 않습니다. 상세: `docs/development/profile-completion-verification.md`.

앱 재시작 보존은 `test:profile-lifecycle`의 별도 Electron 프로세스 경로로 확인합니다. 이전된 프로필 수/ID·서버별 설정·숙제/N/A·계산기 입력·일지·영수증을 유지하고 새 실행의 선택 대기, 이전 미배정 세션의 명시 배정 및 중복 방지를 검사합니다. 실제 사용자 폴더를 검사 입력으로 받지 않습니다.

프로필 앱 수명/실시간 원본: `profileApplication.ts`의 부팅·주기/종료 저장, `profileLogSource.ts`와 `chatLogManager.ts`의 완전한 원본 byte 구간, `profileParserEvents.ts`의 안정 ID/대기·귀속, `ProfileService.beginStorageMaintenance`와 `profileRecording.suspendForRestore`, `backupManager.ts`의 입력 중지/rollback/catch-up을 함께 확인합니다. 기존 Google 전송은 준비 전에 중지하고 인증/outbox는 유지합니다. 완료 원문 30일 뒤에는 해시 영수증을 남겨 중복/변조 재시도를 검증하며 미배정은 보존합니다. 활동 프리셋 UI/IPC는 제거했고 기존 배치/읽기 도구는 호환 검사만 유지합니다. 검사: `test:profile-lifecycle`(실제 부팅 조립/CRLF tail/선택/과거 복원/원본 보존/ZIP 실패·게임 재시작/영수증/종료/신규 설치/실제 설정 DOM), `check-refactor-regressions.ts`의 격리된 실제 main 부팅·종료 및 기존 tail, 직접 소비 경계의 프로필 기록/저장/백업/선택 UI/Google 중지 검사.

프로필 과거 로그 복원: `chatLogSyncManager.ts`의 고정 대상/ACK 계약, `profileLogRestore.ts`의 DB 진행 상태·원본 구간·구형 미배정 합계, `ProfileService.beginHistoricalRestore`의 작업 잠금·대기 재생, `chatLogSyncWorker.ts`의 소유 이벤트/공통 외치기 분기를 함께 확인합니다. 시작 당시 ID/설정/세션을 유지하고 전환·삭제·설정/숙제 편집을 거부합니다. 기록·원본 구간·확정 offset은 함께 commit하며 다른 프로필/미배정 구간은 복제하지 않습니다. 기존 JSON은 원본 증거로만 사용합니다. 검사: `test:profile-log-restore`(실제 worker/SQLite/설정 HTML·실패/손상/재시도·추가 구간·게임 종료 중 대기·800×600), `check-refactor-regressions.ts` 파일(기존 worker 및 오늘 tail/catch-up), 직접 영향 경계의 `test:profile-recording`, `test:profile-storage`, `test:profile-backup`, `test:profile-settings`, `test:profile-checklist`. 문서: `docs/realtime-log-engine.md`, `docs/settings.md`, `docs/contents-checker.md`, `docs/development/profile-storage.md`. 일반 부팅은 profileApplication의 통합 계약을 따릅니다.

독립 프로필 설정 화면: `renderer/profile-settings-page.ts`의 수신/확정 저장/초안 계약, `profileSettingsAccess.ts`의 로컬 페이지/ID 검증, `profileSettingsTransition.ts`의 Save/Discard/Cancel을 기준으로 합니다. 사냥 경험치 계산기·경험치 HUD·버프 타이머·보스 설정·커스텀 알림에서 입력 시 ID, 부분 저장 ACK, 늦은 응답/알림음 목록, 저장 중 다음 입력·편집 폼, 실패 후 취소/중복 없는 재시도를 보존합니다. 공통 소리/배치는 기존 소유권을 유지합니다. 검사: `test:profile-settings-pages`(실제 5개 제품 창/preload/IPC/SQLite·전환/실패/지연·800×600), `test:settings-pages`(해당 기존 renderer와 0% 음량만), `test:profile-settings`, `test:profile-recording`, `test:diary-profiles-ui`. 사용자 문서는 각 기능과 개발 진행 문서를 함께 확인합니다. 일반 부팅은 profileApplication의 통합 계약을 따릅니다.

프로필 스톱워치: `stopwatchSession.ts`/`profileStopwatch.ts`의 입력 시각·소유권 계약, `stopwatchCalculation.ts`, `stopwatchRevision.ts`, `profileRecording.ts`의 상태 알림/삭제 보호, `stopwatch-renderer.ts`/`game-overlay.html`을 함께 확인합니다. 선택 전 차단, 전환 중 원래 측정 유지, 시작 당시 DB 계산값·도핑·세션 ID, 원래 프로필 저장/실패 재시도, 삭제 프로필의 과거 기록 보존과 재계산 경계, 늦은 화면 상태/조회와 제목 초안 보존을 유지합니다. 검사: `test:profile-stopwatch`(실제 관리/HUD/계산기/preload/IPC/SQLite·최소 창, 계산기 능력치/장비 수치/강화/코어/계산 프리셋·도핑 입력→전환 복원→시작 시 기록 고정), `test:stopwatch`(기존 모드), 전환/도구 경계는 `test:profile-recording`, `test:profile-storage`, `test:profiles-ui`, `test:profile-tools`. 사용자 문서 `docs/stopwatch.md`, `docs/coefficient-calculator.md`, 진행 문서 `docs/development/profile-storage.md`. 일반 부팅 연결을 완료했습니다.

프로필 숙제 UI/수동 조작: `shared/profileChecklist.ts`의 요청 검증, `profileChecklistIpc.ts`의 소유권·원자 commit·중복 ACK 계약, `renderer/contents-checker/profile.ts`와 `profileChecklistTransition.ts`, `contentsChecker.runDiaryWriteWithRetry`를 함께 확인합니다. 1프로필 1열, 프로필 관리 진입점, 기존 캐릭터 CRUD 차단, 완료/N/A/정의·정렬 격리, 저장 실패/응답 유실/전환 중 다음 입력 보존, 재확인의 같은 ID, 일요일 및 검색/추가 위치를 유지합니다. 검사: `test:profile-checklist`, `test:checklist`(기존 숙제/보류 UI만 실행), `test:window-visibility`(실제 자동 접기), `test:audit`, `test:profile-recording`, `test:profile-settings`, `test:companion` 및 `check-refactor-regressions.ts` 파일 단위. 일반 부팅 연결을 완료했습니다.

프로필 설정 초안: `renderer/settings/draft.ts`의 소유자/ACK 경계, `renderer/settings/profile-transition.ts`, `profileSettingsTransition.ts`, `profileSettingsAccess.ts`, `settings.html`의 저장 시작 ID 고정과 `preload.onConfigData`를 함께 확인합니다. 미저장 저장/버리기/취소, 전환 실패 시 초안 보존, 다른 프로필에 늦은 저장 거부, 같은 프로필 재확인·검색에는 확인 생략, 프로필 ID가 바뀐 수신에서만 초안 초기화, 미등록 키워드/탭과 필수 서버를 유지합니다. 검사: `test:profile-settings`(제품 HTML/preload/IPC/DB·실패/지연·작은 창), `test:audit`(기존 초안/동시 저장), `test:hud-edit-settings`(실제 위치 편집), `test:profile-tools`, `test:profile-recording` 및 `check-refactor-regressions.ts` 파일 단위. 일반 부팅 연결을 완료했습니다.

프로필 도구 입력: `shared/profileTools.ts`, `ApplicationData.saveToolValue`/`migrateToolValues`, `profileToolsIpc.ts`, `profileToolTransition.ts`, `renderer/profile-tool-storage.ts`. 실제 저장값의 일회 이전·프로필별 능력치/버프 프리셋·선택 분리, 창별 고정 저장 대상, 편집/저장 실패 시 전환 취소, 같은 프로필 확인 시 초안 유지, 설정 복사/삭제와 ZIP 복원을 보존합니다. 검사: `check-profile-tools.ts` / `npm run test:profile-tools`, 기존 버프 연동은 `test:buffs`, 백업은 `test:profile-backup`, 전환 계층은 `test:profile-storage`와 `test:profile-recording`. `docs/buffs.md`, `docs/coefficient-calculator.md` 및 개발 진행 문서를 함께 확인합니다. 스톱워치는 별도 계약과 검사로, 사냥 경험치 계산기는 독립 프로필 설정 화면의 계약과 검사로 연결했습니다.

프로필 저장 기반(앱 연결 전): `src/modules/applicationData.ts`의 단일 원본 계약과 `shared/playProfiles.ts`, `modules/profileClock.ts`, `modules/config.ts`의 persistence 경계를 함께 확인합니다. 검사: `scripts/check-profile-storage.ts` / `npm run test:profile-storage`. 현재 통합 상태 및 후속 작업: `docs/development/profile-storage.md`. 사용자 정책은 `local-profiles-plan.md`, `profile-storage-design.md`, `profile-sync-lifecycle.md`를 따릅니다.

프로필 선택/관리: `modules/profileService.ts`, `profileGameLifecycle.ts`, `profileIpc.ts`, `renderer/profiles.ts`. 선택 전 기록 대기, 세션 저장 실패, 전환 취소/게임 종료 중 늦은 선택, 자유로운 표시 이름(캐릭터명/에타 조회 키가 아님), 서버 필수·기존 userServer 단일 원본, 삭제 후 빈 기본 및 초안 보존을 유지합니다. 검사: `check-profile-storage.ts`, `check-profiles-ui.ts`. 기존 Google 중지 경계: `cloudSyncManager.pauseForPlayProfiles` 및 `renderer/settings/profile-cloud-pause.ts`, 검사: `check-profile-cloud-pause.ts`. main에서 저장소와 기록 경계를 준비하고 원본 백업 뒤 자동 이전합니다.

프로필 창의 게임 최소화/종료 보존 및 사용자 전체 숨김은 `windowManager.hideAll`과 `pollingLoop.ts`의 최소화 감지 순서를 함께 확인합니다. `check-window-visibility.ts`에서 실제 native 창·입력 보존과 명시적 숨김을 검사합니다.

프로필 자동 기록/실행 상태: `profileParserEvents.ts`의 raw/소유 처리 분리 계약, `ProfileService.dispatch`/`applyRecords`, `config.withConfirmedWrites`, `recordEffects.ts`, `profileRecording.ts`와 각 tracker의 capture/restore를 함께 확인합니다. 검사: `check-profile-recording.ts`(실제 parser/SQLite·일지/숙제/ACK 실패·진행/알림·이전 세션·ZIP), `check-profile-storage.ts`, `check-profile-backup.ts`, `check-xp-hud-policy.ts`, `check-buffs-behavior.ts`, `check-companion-features.ts`, `check-magic-stone-revenue.ts`, parser/실시간/과거 계약은 `check-refactor-regressions.ts` 파일 단위입니다. main 연결은 profileApplication의 계약을 따릅니다.

프로필 모험일지 저장/조회: `diaryDb.ts`의 선두 계약, `connectApplicationData`·journal v2·`diary_profile_days`, `diaryAttribution.ts`, `shared/diaryProfiles.ts`, `ApplicationData.reopen`을 함께 확인합니다. 검사: `check-profile-diary.ts`, `check-profile-storage.ts`, `check-magic-stone-revenue.ts`. 과거 날짜 합계의 안정적인 ID는 `chatLogSyncWorker.ts` 및 `chatLogSyncProtocol.ts`, 검사: `check-refactor-regressions.ts`의 실제 worker·재구성 계약과 `test:profile-log-restore`의 프로필별 복원 계약. 부팅 조립은 profileApplication의 계약을 따릅니다.

일지 조회/수동 기록 대상 UI: `diaryProfileAccess.ts`의 명시적 대상 계약, `renderer/diary-profiles.ts`, `renderer/diary/profile-filter.ts`, `diary.html`의 조회 generation·입력 보존, `renderer/boss-diary-toast.ts`, `boss-settings.html`, `magic-stone-calculator.html`을 함께 확인합니다. 검사: `check-diary-profiles-ui.ts`(제품 HTML/preload/IPC/공유 DB·지연/실패/중복·작은 창 캡처), `check-companion-files.ts`(기존 내보내기), `check-magic-stone-revenue.ts`(기존 수익/지출), `check-diary-calendar-behavior.ts`(달력). 프로필 전체 기능이 활성화되기 전에는 기존 호출 형식을 유지합니다.

보급품 발판 기믹 안내: `src/shared/supplyRecapture.ts`의 계약과 `supplyTracker.ts`, `renderer/game-overlay/companion-hud.ts`, `notification-layout.ts`, `scripts/check-companion-features.ts`, `scripts/check-renderer-behavior.ts`, `docs/companion-tools.md`를 함께 확인합니다. 입장 대기에는 표시하지 않고 암호 순서만 10초간 게임 진행 알림 위치에 표시합니다.

이 문서는 기능별 사용자 약속이 어느 소스의 `기능 계약` 주석에 정의되어 있는지 찾기 위한 인덱스입니다.
구현 설명을 중복하는 문서가 아니라, 기능을 수정할 때 반드시 함께 읽을 코드·테스트·사용자 문서의 출발점입니다.

## 로그·기록·HUD

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 실시간 로그 파일 입력 | `src/modules/chatLogManager.ts` | `chatLogFileReader.ts`, `chatLogNormalizer.ts`, `docs/realtime-log-engine.md` |
| 게임 로그 분류 | `src/modules/chatParser.ts` | `itemAcquisition.ts`, `CHAT_SYSTEM_COLOR_PIPELINE.md`, `scripts/check-refactor-regressions.ts` |
| NPC 대사 표시·숨김·줄바꿈 복원 | `src/chatOverlayRenderer.ts`의 `createChatRow`, `src/modules/chatLogNormalizer.ts`, `src/shared/chatConstants.ts` | `chatLogFileReader.ts`, `chatLogManager.ts`, `scripts/check-npc-chat.ts`, `check-chat-visibility.ts`, `fixtures/npc-dialogue-logs.json`, `docs/chat-overlay.md` |
| 검색 한도·탭 ID 해석과 화면 공통 표시 필터 | `src/shared/chatChannels.ts`의 `isOverlayChatVisible`/`resolveOverlayCustomTab` | `chatOverlayRenderer.ts`, `modules/chatLogManager.ts`, `chatLogProcessor.ts`, `scripts/check-chat-visibility.ts`, `docs/chat-overlay.md` |
| 실시간 기능 분배 | `src/modules/chatLogProcessor.ts` | `chatLogSyncWorker.ts`, `scripts/check-refactor-regressions.ts` |
| 과거 로그 복구 | `src/modules/chatLogSyncManager.ts` | `chatLogSyncWorker.ts`, `chatLogSyncState.ts`, `docs/realtime-log-engine.md` |
| 모험일지 저장·조회 | `src/modules/diaryDb.ts` | `src/diary.html`, `renderer/diary/homework-progress.ts`, `scripts/check-diary-calendar-behavior.ts` |
| 모험일지 월간 성실도·월 일수 | `src/diary.html`의 `loadStatistics` | `modules/diaryDb.ts`의 `getMonthlyStatistics`, `scripts/check-companion-files.ts`, `docs/diary.md` |
| 모험일지 수익 묶음·타임라인 시각 | `src/renderer/diary/log-utils.ts`의 `parseAutoLogAmount`/`normalizeLogTime` | `src/diary.html`의 월 수익·일/주 타임라인, `modules/diaryDb.ts`의 `getMonthlySummary`, `scripts/check-companion-files.ts`, `scripts/check-refactor-regressions.ts`, `docs/diary.md` |
| 모험일지 득템 기록 영역 높이 조절 | `src/renderer/diary/loot-split-pane.ts` | `src/diary.html`, `scripts/check-renderer-behavior.ts`, `scripts/check-refactor-regressions.ts` |
| 오늘 요약 HUD·최근 감지 숙제 한 줄 | `src/modules/todaySummary.ts`, `contentsChecker.ts`의 최근 자동 감지 계약 | `renderer/game-overlay/today-summary.ts`, `scripts/check-companion-features.ts`, `scripts/check-refactor-regressions.ts`, `scripts/check-renderer-behavior.ts`, `docs/contents-checker.md`, `docs/experience-hud.md` |
| 경험치 HUD·경험의 정수 | `src/shared/experienceEssence.ts`, `src/modules/xpTracker.ts` | `lootPolicy.ts`, `docs/experience-hud.md`, 실제 로그 fixture 검사 |
| 어벤던로드 | `src/modules/abandonedTracker.ts` | `chatParser.ts`, `renderer/game-overlay`, abandoned 회귀 검사 |

## 숙제·알림

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 일일·주간 숙제 | `src/modules/contentsChecker.ts` | `contents-checker.html`, `shared/homeworkResetCycle.ts`, `docs/contents-checker.md` |
| 숙제창 자동 접기·단일 설정 수신·펼치기 클릭 | `src/modules/contentsWindowCollapse.ts`, `src/renderer/contents-checker/auto-collapse.ts`, `contents-checker.html`의 설정 전달 | `windowManager.ts`, `ipcHandlers.ts`, `scripts/check-window-visibility.ts`의 전체 페이지/포인터 이동 검사, `docs/contents-checker.md` |
| 설계자의 채굴장 포탈 생성 감지 | `src/modules/chatParser.ts`의 채굴장 완료 계약 | `chatLogProcessor.ts`, `chatLogSyncWorker.ts`, `chatLogSyncManager.ts`, `scripts/fixtures/architect-mine-logs.json`, `scripts/check-refactor-regressions.ts`, `docs/contents-checker.md` |
| 상위 컨텐츠 5종 숙제 및 감지 (골고다 Semi-Auto, 최후의 결전, 공허 수동, 환희·슬픔) | `src/modules/chatParser.ts`의 상위 컨텐츠 계약, `src/modules/contentsChecker.ts` | `chatLogProcessor.ts`, `chatLogSyncWorker.ts`, `contents-checker.html`, `scripts/check-refactor-regressions.ts`, `docs/contents-checker.md` |
| 버프 타이머 | `src/modules/buffTimerManager.ts` | `assets/data/buffs.json`, `buff-timer.html`, `scripts/check-buff-regressions.ts` |
| 필드보스 알림 | `src/modules/bossNotifier.ts` | `boss-settings.html`, `docs/boss-settings.md` |
| 보스 음량 저장·정수 알림 미리듣기의 0% 무음 | `boss-settings.html`의 `saveBossGlobal`, `xp-hud.html`의 `btn-essence-preview` | `assets/ui-utils.ts`, `preload.ts`, `scripts/check-renderer-behavior.ts`의 `checkAlarmVolumeBoundaries`, `docs/boss-settings.md`, `docs/experience-hud.md` |
| 사용자 지정 알림 | `src/modules/customNotifier.ts` | `custom-alert.html`, `docs/custom-alert.md` |
| 게임 상황·기믹 알림 | `src/modules/chatLogProcessor.ts` | `settings.html`, `renderer/game-overlay/alerts.ts`, `docs/settings.md` |
| 지정 단어·Discord | `src/modules/chatLogProcessor.ts`, `src/modules/discordNotifier.ts` | `word-alarm.html`, `discord-alarm.html`, `docs/word-alarm.md` |
| 알람 이력·절전 누락 | `src/modules/diaryDb.ts` | `bossNotifier.ts`, `buffTimerManager.ts`, `customNotifier.ts` |

## 외부 모니터링·로컬 AI

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 갤러리 새 글·댓글 | `src/modules/galleryMonitor.ts` | `webMonitorUtils.ts`, `gallery.html`, `docs/gallery.md` |
| 거래 게시판 | `src/modules/tradeMonitor.ts` | `webMonitorUtils.ts`, `trade.html`, `docs/trade.md` |
| 거래 검색 확인 위치·중복 방지 | `src/shared/tradeSearchState.ts` | `tradeMonitor.ts`, `config.ts`, `scripts/check-audit-regressions.ts`, `docs/trade.md` |
| 사기 탐지 AI | `src/modules/scamMonitor.ts`, `src/modules/scam/modelManager.ts` | `scam/serverManager.ts`, `scam/sessionManager.ts`, `docs/scam-detector.md` |

## 창·설정·시스템

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 게임 창 탐지·z-order | `src/modules/tracker.ts`, `src/modules/zOrderController.ts` | `windowManager.ts`, `package.json`, `npm run test:zorder:windows` |
| 사이드바 플라이아웃 입력·가림·일시 크기 | `src/shared/sidebarMenuActivation.ts`, `index.html`의 `checkMouseIgnore`, `windowFocusController.ts`의 `setLauncherInteractive`, `ipcHandlers.ts`의 사이드바 전용 크기 검증 | `dock.html`, `windowManager.ts`, `scripts/check-renderer-behavior.ts`, `scripts/check-window-visibility.ts`, `docs/index.md` |
| 채팅 오버레이 탭·스크롤·마우스 투과 | `src/chatOverlayRenderer.ts` | `chat-overlay.html`, `renderer/settings/form-collection.ts`, `scripts/check-renderer-behavior.ts`, `docs/chat-overlay.md` |
| 집중 대화방 표시 이력·설정 갱신 | `src/focusedChatRenderer.ts`의 `applyAppearanceConfig` | `renderer/nickname-notes.ts`, `scripts/check-renderer-behavior.ts`의 `checkFocusedChatSettings`, `docs/focused-chat.md` |
| 창 생성·배치·가시성·Escape 닫기 | `src/modules/windowManager.ts`, `src/modules/windowPositionPolicy.ts`, `src/assets/ui-utils.ts` | `managedWindowRegistry.ts`, `embeddedWebTool.ts`, `overlay-view-preload.ts`, `scripts/check-refactor-regressions.ts`, `docs/settings.md` |
| 보조 창 크기 조절·저장 | `src/modules/managedWindowSizing.ts` | `windowManager.ts`, `assets/ui-utils.ts`, `scripts/check-refactor-regressions.ts`, `docs/settings.md` |
| 창 드래그·최종 위치 저장 | `src/modules/windowMovePersistence.ts` | `programmaticMoveTracker.ts`, `windowManager.ts`, `scripts/check-window-move-persistence.ts`, `scripts/check-refactor-regressions.ts`, `docs/settings.md` |
| 사용자 전체 창 숨김·복원 | `src/modules/userWindowVisibility.ts` | `windowManager.ts`, `tray.ts`, `shortcutManager.ts`, `scripts/check-window-visibility.ts`, `docs/settings.md` |
| renderer 표시 실패 안전장치 | `src/modules/rendererHealthGuard.ts` | `main.ts`, `windowManager.ts`, `scripts/check-refactor-regressions.ts` |
| 창모드↔창모드 전체화면 전환 | `src/modules/gameWindowModePolicy.ts`, `src/modules/windowManager.ts` | `tracker.ts`, `pollingLoop.ts`, `scripts/check-refactor-regressions.ts`, `docs/settings.md` |
| HUD 위치 편집·손상 좌표 복구 | `src/renderer/game-overlay/edit-mode.ts`, `src/modules/gameOverlayEditSession.ts`의 종료 후 최신 설정 재적용, `src/shared/windowPositions.ts` | `game-overlay.html`의 콘텐츠 표시 상태, `settings.html`, `modules/config.ts`, `scripts/check-renderer-behavior.ts`, `scripts/check-hud-edit-settings.ts`(프리셋/공유/다른 창 저장·취소·실패·지연·창 닫기), `docs/settings.md` |
| 전역 단축키 | `src/modules/shortcutManager.ts`, `src/modules/tracker.ts` | `settings.html`, `renderer/settings/shortcuts.ts`, `scripts/check-refactor-regressions.ts` |
| 설정 기본값·마이그레이션·저장 확정 | `src/modules/config.ts`의 `saveConfirmed`와 자동 저장 계약 | `windowManager.ts`, `constants.ts`, `shared/types.ts`, `scripts/check-audit-regressions.ts`, `docs/settings.md` |
| Windows 자동 실행 | `src/modules/autoStart.ts`, `src/modules/storeAutoStart.ts` | `runtimeSettings.ts`, `native/store-update-helper/Program.cs`, `build/appx/appxmanifest.xml`, `scripts/check-auto-start.ts`, `scripts/check-audit-regressions.ts`, `scripts/verify-appx-package.ts`, `docs/settings.md`, `package.json` 관리자 권한 정책 |
| Fast Ping | `src/modules/optimizer.ts` | `ipcHandlers.ts`, `docs/settings.md` |
| 업데이트 공지 | `src/modules/noticeManager.ts` | `assets/notice/notice.json`, `updater.ts`, 릴리즈 체크리스트 |

## 계산기·도구

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 계수·주스탯·명중 계산기 | `src/coefficient-calculator-renderer.ts` | `coefficient-calculator.html`, `stopwatch-renderer.ts`, `scripts/check-renderer-behavior.ts`, `docs/coefficient-calculator.md` |
| 테시스 코어 입력 복원·범위 오류 비용 | `src/thesis-core-calculator.html`의 `init`/`calculate`/`updateBoxCosts` | `scripts/check-renderer-behavior.ts`의 `checkThesisCoreCalculator`(제품 HTML 재실행·동일/역순 단계·시드/엘소·상자 입력), `docs/thesis-core-calculator.md` |
| 마정석 계산 결과의 수익 기록·과거 금액 복구 | `src/magic-stone-calculator.html`의 `saveToDiary`, `modules/diaryDb.ts`의 v8 마이그레이션 | `scripts/check-magic-stone-revenue.ts`(제품 IPC/SQLite·실패·지연·일/주/월/내보내기·보수적 과거 보정), `docs/magic-stone-calculator.md` |
| 버프 백과 합산·계산기 도핑 복원·다른 창 저장 반영 | `src/buffs.html`의 `updateSummary`, `src/coefficient-calculator-renderer.ts`의 `initBuffPresets`/`calculate` | `scripts/check-buffs-behavior.ts`의 실제 두 제품 창 검사, `stopwatchCalculation.ts`, `docs/buffs.md`, `docs/coefficient-calculator.md` |
| 시간 측정·기록 | `src/modules/stopwatchSession.ts` | `stopwatchCalculation.ts`, `stopwatch-renderer.ts`, `game-overlay.html`, `shortcutManager.ts`, `scripts/check-stopwatch-session.ts`, `docs/stopwatch.md` |
| 사냥 동선 오버레이 배율·투명도 복원 | `src/hunting-path-simulator.html`의 `enableOverlayMode`/`syncWindowBounds` | `scripts/check-hunting-path.ts`(제품 HTML/IPC·0% 복원·최소 배율·실제 창 크기), `docs/hunting-path-simulator.md` |
| 시에나 능력치·추가 옵션 기댓값 | `src/siena-aura-renderer.ts`의 `updateExpectation`/`extraAllSuccessProbability` | `scripts/check-renderer-behavior.ts --siena-aura`(전체 HTML·무기/방어구·0~10단계·잠금·중복 제외 순열·실제 추첨), `docs/siena-aura.md` |
| QTE 최종 라운드·도달 스테이지 | `src/qte-challenge-renderer.ts`의 `currentStage`/`beginRound` | `scripts/check-renderer-behavior.ts --qte`(실제 입력·시간초과·10/40라운드 탈락·41라운드 진입·기록·도전과제), `docs/qte-challenge.md` |
| 제복 색상 외부 화면·창 크기 | `src/modules/windowManager.ts`의 `toggleUniformColorWindow` | `scripts/check-embedded-tools.ts`(실제 창·preload·크기 IPC·native view·CSS·하단 접근), `docs/uniform-color.md` |
| 루미나의 회랑 경로 분석·노드 매칭·점수 산출 | `src/shared/luminaCorridor.ts`, `src/renderer/lumina-vision.ts` | `src/lumina-corridor.html`, `src/renderer/lumina-corridor.ts`, `scripts/check-lumina-corridor.ts` |

## 데이터 보호·외부 전송

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 로컬 백업·복원 | `src/modules/backupManager.ts`, `profileBackupRestore.ts`의 staging 계약 | `localSnapshot.ts`, `ApplicationData.restoreLegacyConfiguration`, `config.load`의 projection 재로드, `profileStartup.ts`, `check-profile-backup.ts`(ZIP/SQLite·부분 복원·rollback·재시작), `check-audit-regressions.ts`, `docs/settings.md` |
| 도구 localStorage 백업 | `src/modules/rendererStorageBackup.ts` | `shared/rendererStorage.ts`, `storage-bridge.html`, `scripts/check-audit-regressions.ts`, `docs/settings.md` |
| 설정 초안·런타임 적용 | `src/renderer/settings/draft.ts`, `src/modules/runtimeSettings.ts` | `settings.html`, `ipcHandlers.ts`, `cloudSyncManager.ts`, `scripts/check-audit-regressions.ts`, `docs/settings.md` |
| 장비 강화·인챈트·인크립트 기댓값 / 0원 구간·횟수 입력 | `src/shared/equipmentSimulator.ts`, `src/renderer/equipment-simulator.ts` | `scripts/check-audit-regressions.ts`, `scripts/check-renderer-behavior.ts --equipment-simulator`, `docs/equipment-simulator.md` |
| Google Drive 프로필 동기화 | `profileSyncModel.ts`, `profileSyncCoordinator.ts`, `profileSyncDrive.ts`, `profileCloudSync.ts` | `ApplicationData.syncTransaction`, `profileSyncIpc.ts`, `renderer/settings/profile-cloud-sync.ts`, `google-drive-sync-contract.md`, `test:profile-sync:acceptance` |
| 두 PC 동시 전송 회귀 | `scripts/check-profile-sync-concurrency.ts` | 독립 프로세스/별도 DB/실제 loopback HTTP/운영 transport·coordinator, 응답 순서·수신 중 편집·ACK·실패·취소·삭제, `test:profile-sync-concurrency` |
| GA4 사용 통계 | `src/modules/analytics.ts` | `analyticsProtocol.ts`, `PRIVACY_POLICY.md`, `docs/privacy/index.html` |

## 변경 절차

3차 읽기·알림·정렬 계약: `modules/customChatFonts.ts`/`renderer/custom-chat-fonts.ts`(로컬 파일·기본 글꼴 대체·ZIP 백업), `renderer/settings/companion-controls.ts`/`renderer/game-overlay/companion-hud.ts`(메모 초안·읽기), `renderer/game-overlay/notification-priority.ts`/`modules/desktopNotification.ts`/`assets/ui-utils.ts`(시각 우선순위·반복 묶기), `shared/windowSnap.ts`/`modules/windowSnap.ts`/`windowMovePersistence.ts`(DIP 정렬·최종 좌표 저장)을 함께 확인합니다. 검사는 `scripts/check-companion-reading.ts`, `check-window-visibility.ts`, 기존 renderer/audit 회귀에 포함하며 사용자 문서는 `docs/companion-tools.md`, `docs/chat-overlay.md`, `docs/settings.md`입니다.

1. 기능을 수정하기 전에 위 기준 계약 주석, 실제 입력 자료, 현재 테스트를 함께 읽습니다.
2. 해석이 둘 이상이면 기존 동작이라고 추측하지 말고 사용자에게 기대 동작을 확인합니다.
3. 계약 변경은 코드, 실제 입력 기반 회귀 테스트, 사용자 문서를 같은 변경 묶음으로 갱신합니다.
4. 권한, 데이터 삭제·복원, 외부 전송 범위를 바꾸는 경우 일반 기능 변경보다 먼저 사용자에게 명시적으로 확인합니다.

## 기록 내보내기·설정 공유·읽기 설정

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 채팅 간단 표시 | `shared/chatChannels.ts`의 `applyReadingDisplay` | `chatOverlayRenderer.ts`, `focusedChatRenderer.ts`, `renderer/settings/chat-preview.ts`, `check-companion-reading.ts`, `check-renderer-behavior.ts`, `docs/chat-overlay.md` |
| 선택 설정 공유 | `modules/settingsShare.ts`, `modules/companionFiles.ts`, `windowManager.applySharedWindowLayout`의 초기 배치 대기 계약 | `renderer/settings/sharing.ts`, `check-companion-files.ts`, `check-shared-layout.ts`(10개 창의 첫 표시·공유/프리셋/다른 창 저장 순서), `check-window-visibility.ts`, `docs/settings.md` |
| 모험 일지 내보내기 | `diaryDb.getDiaryExportSnapshot`, `modules/diaryExport.ts` | `modules/companionFiles.ts`, `renderer/diary/export.ts`, `check-companion-files.ts`, `docs/diary.md` |

## 사냥 보조

보조 기능의 표시 규격은 `DESIGN_TOKENS.md`와 `src/style.css`의 `--ui-*` 토큰을 공유합니다. UI 정리 시 아래 기능 계약·입력 ID·저장 경로·그래프를 유지하고 `scripts/check-renderer-behavior.ts` 및 실제 화면 캡처로 확인합니다.

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 보스 입장 마감·파멸의 기원 참여 시 숨김 | `src/shared/bossEntry.ts`, `src/modules/bossNotifier.ts`의 `dismissOriginOfDoomEntry` | `chatParser.ts`, `scripts/check-hunting-assist.ts`, `scripts/fixtures/origin-of-doom-logs.json`, `scripts/check-renderer-behavior.ts`, `docs/boss-settings.md` |
| 경험치 자동 휴식·감소 감지 | `src/modules/xpTracker.ts`, `src/shared/xpEfficiency.ts` | `scripts/check-hunting-assist.ts`, `docs/experience-hud.md` |

| 채팅창별 글꼴 | `src/shared/chatChannels.ts`의 `resolveChatFont` | `chatOverlayRenderer.ts`, `renderer/settings/chat-preview.ts`, `docs/chat-overlay.md` |

| 외치기 종류 분류·필터 | `src/shared/chatChannels.ts`의 `parseShoutContent` | `chatParser.ts`, `chatLogManager.ts`, `diaryDb.ts`, `docs/chat-overlay.md` |

| 에타 구간 색상 | `src/shared/chatChannels.ts`의 `getEtaColor` | `focusedChatRenderer.ts`, `scripts/check-companion-features.ts`, `docs/chat-overlay.md` |

| 에타 랭킹 조회·HTML 이름 복원 | `src/modules/etaRanking.ts`의 `fetchEtaRanking` | `eta-ranking.html`의 안전한 표시, `scripts/check-eta-ranking-behavior.ts`의 실제 파서·preload·목록/검색/서버 전환, `docs/eta-ranking.md` |

| 닉네임 개인 메모 | `src/shared/nicknameNotes.ts` | `ipcHandlers.ts`, `renderer/nickname-notes.ts`, `docs/chat-overlay.md` |

| 화면 고정 메모·긴 내용 읽기 | `src/renderer/game-overlay/companion-hud.ts`의 `refreshNoteLayout` | `renderer/settings/companion-controls.ts`, `renderer/game-overlay/edit-mode.ts`, `scripts/check-renderer-behavior.ts`의 `checkPinnedNoteReading`, `docs/companion-tools.md` |


| 알림 위치·실화면 미리보기 | `src/renderer/game-overlay/notification-layout.ts` | `shared/notificationLayout.ts`, `renderer/settings/notification-layout.ts`, `docs/companion-tools.md` |

신규 보조 기능은 `scripts/check-companion-features.ts`의 실제 파서/DB/IPC 검증과 `scripts/check-renderer-behavior.ts`의 실제 DOM 검증을 함께 실행합니다. 집중 채팅의 초기 표시 설정 응답은 더 최신인 서버·메모 설정을 되돌리지 않습니다.


플레이 보조 화면의 정보·관리 분리: `renderer/nickname-notes.ts`의 정보 조회 세션과 메모 저장 계약, `shared/nicknameInfo.ts`의 캐릭터 매핑, `renderer/settings/activity-presets.ts`의 상세 펼침·이름 초안, `modules/gameOverlayEditSession.ts`의 저장 확인 후 입력 복귀를 함께 확인합니다. 회귀 검사는 `scripts/check-companion-design.ts`(실제 preload·IPC·임시 디스크·Electron), `scripts/check-renderer-behavior.ts`(채팅 이력·초안·긴 메모), `scripts/check-companion-features.ts`(프리셋 실제 창 복원)입니다. 사용자 문서는 `docs/companion-tools.md`, `docs/chat-overlay.md`입니다.

어벤던로드 입장료 지출은 `chatLogProcessor.ts`의 입장료 계약, `chatLogSyncWorker.ts`, `chatLogSyncManager.ts` 정책 fingerprint를 함께 유지합니다. 수동 수익·지출은 `diary.html`의 `saveManualSeed`, 숙제 추가 확인은 `contents-checker.html`의 추가 계약과 `renderer/contents-checker/profile.ts`를 기준으로 합니다. 일상 검증은 변경한 경로에 맞춰 `test:magic-stone`, `test:checklist`, `test:profile-checklist` 및 과거 복원 변경 시 refactor 검사 파일을 선택합니다. 사용자 문서: `docs/diary.md`, `docs/realtime-log-engine.md`, `docs/contents-checker.md`.
