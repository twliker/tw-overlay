# 기능 계약 주석 인덱스

이 문서는 기능별 사용자 약속이 어느 소스의 `기능 계약` 주석에 정의되어 있는지 찾기 위한 인덱스입니다.
구현 설명을 중복하는 문서가 아니라, 기능을 수정할 때 반드시 함께 읽을 코드·테스트·사용자 문서의 출발점입니다.

## 로그·기록·HUD

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 실시간 로그 파일 입력 | `src/modules/chatLogManager.ts` | `chatLogFileReader.ts`, `chatLogNormalizer.ts`, `docs/realtime-log-engine.md` |
| 게임 로그 분류 | `src/modules/chatParser.ts` | `itemAcquisition.ts`, `CHAT_SYSTEM_COLOR_PIPELINE.md`, `scripts/check-refactor-regressions.ts` |
| 실시간 기능 분배 | `src/modules/chatLogProcessor.ts` | `chatLogSyncWorker.ts`, `scripts/check-refactor-regressions.ts` |
| 과거 로그 복구 | `src/modules/chatLogSyncManager.ts` | `chatLogSyncWorker.ts`, `chatLogSyncState.ts`, `docs/realtime-log-engine.md` |
| 모험일지 저장·조회 | `src/modules/diaryDb.ts` | `src/diary.html`, `renderer/diary/homework-progress.ts`, `scripts/check-diary-calendar-behavior.ts` |
| 오늘 요약 HUD | `src/modules/todaySummary.ts` | `renderer/game-overlay/today-summary.ts`, `docs/experience-hud.md` |
| 경험치 HUD·경험의 정수 | `src/shared/experienceEssence.ts`, `src/modules/xpTracker.ts` | `lootPolicy.ts`, `docs/experience-hud.md`, 실제 로그 fixture 검사 |
| 어벤던로드 | `src/modules/abandonedTracker.ts` | `chatParser.ts`, `renderer/game-overlay`, abandoned 회귀 검사 |

## 숙제·알림

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 일일·주간 숙제 | `src/modules/contentsChecker.ts` | `contents-checker.html`, `shared/homeworkResetCycle.ts`, `docs/contents-checker.md` |
| 버프 타이머 | `src/modules/buffTimerManager.ts` | `assets/data/buffs.json`, `buff-timer.html`, `scripts/check-buff-regressions.ts` |
| 필드보스 알림 | `src/modules/bossNotifier.ts` | `boss-settings.html`, `docs/boss-settings.md` |
| 사용자 지정 알림 | `src/modules/customNotifier.ts` | `custom-alert.html`, `docs/custom-alert.md` |
| 게임 상황·기믹 알림 | `src/modules/chatLogProcessor.ts` | `settings.html`, `renderer/game-overlay/alerts.ts`, `docs/settings.md` |
| 지정 단어·Discord | `src/modules/chatLogProcessor.ts`, `src/modules/discordNotifier.ts` | `word-alarm.html`, `discord-alarm.html`, `docs/word-alarm.md` |
| 알람 이력·절전 누락 | `src/modules/diaryDb.ts` | `bossNotifier.ts`, `buffTimerManager.ts`, `customNotifier.ts` |

## 외부 모니터링·로컬 AI

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 갤러리 새 글·댓글 | `src/modules/galleryMonitor.ts` | `webMonitorUtils.ts`, `gallery.html`, `docs/gallery.md` |
| 거래 게시판 | `src/modules/tradeMonitor.ts` | `webMonitorUtils.ts`, `trade.html`, `docs/trade.md` |
| 사기 탐지 AI | `src/modules/scamMonitor.ts`, `src/modules/scam/modelManager.ts` | `scam/serverManager.ts`, `scam/sessionManager.ts`, `docs/scam-detector.md` |

## 창·설정·시스템

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 게임 창 탐지·z-order | `src/modules/tracker.ts`, `src/modules/zOrderController.ts` | `windowManager.ts`, `package.json`, `npm run test:zorder:windows` |
| 사이드바 플라이아웃 입력 | `src/shared/sidebarMenuActivation.ts` | `index.html`, `scripts/check-renderer-behavior.ts`, `docs/index.md` |
| 창 생성·배치·가시성 | `src/modules/windowManager.ts`, `src/modules/windowPositionPolicy.ts` | `managedWindowRegistry.ts`, `windowLayout.ts`, `windowOptions.ts`, `docs/settings.md` |
| 창모드↔창모드 전체화면 전환 | `src/modules/gameWindowModePolicy.ts`, `src/modules/windowManager.ts` | `tracker.ts`, `pollingLoop.ts`, `scripts/check-refactor-regressions.ts`, `docs/settings.md` |
| 전역 단축키 | `src/modules/shortcutManager.ts`, `src/modules/tracker.ts` | `settings.html`, `renderer/settings/shortcuts.ts`, `scripts/check-refactor-regressions.ts` |
| 설정 기본값·마이그레이션 | `src/modules/config.ts` | `constants.ts`, `shared/types.ts`, `docs/settings.md` |
| Windows 자동 실행 | `src/modules/autoStart.ts` | `bootstrap.ts`, `package.json` 관리자 권한 정책 |
| Fast Ping | `src/modules/optimizer.ts` | `ipcHandlers.ts`, `docs/settings.md` |
| 업데이트 공지 | `src/modules/noticeManager.ts` | `assets/notice/notice.json`, `updater.ts`, 릴리즈 체크리스트 |

## 계산기·도구

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 계수·주스탯·명중 계산기 | `src/coefficient-calculator-renderer.ts` | `coefficient-calculator.html`, `stopwatch-renderer.ts`, `scripts/check-renderer-behavior.ts`, `docs/coefficient-calculator.md` |

## 데이터 보호·외부 전송

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 로컬 백업·복원 | `src/modules/backupManager.ts` | `localSnapshot.ts`, `docs/settings.md` |
| Google Drive 동기화 | `src/modules/cloudSyncManager.ts` | `syncDataHelper.ts`, `google-drive-sync-contract.md`, `docs/google-drive-sync.md` |
| GA4 사용 통계 | `src/modules/analytics.ts` | `analyticsProtocol.ts`, `PRIVACY_POLICY.md`, `docs/privacy/index.html` |

## 변경 절차

1. 기능을 수정하기 전에 위 기준 계약 주석, 실제 입력 자료, 현재 테스트를 함께 읽습니다.
2. 해석이 둘 이상이면 기존 동작이라고 추측하지 말고 사용자에게 기대 동작을 확인합니다.
3. 계약 변경은 코드, 실제 입력 기반 회귀 테스트, 사용자 문서를 같은 변경 묶음으로 갱신합니다.
4. 권한, 데이터 삭제·복원, 외부 전송 범위를 바꾸는 경우 일반 기능 변경보다 먼저 사용자에게 명시적으로 확인합니다.
