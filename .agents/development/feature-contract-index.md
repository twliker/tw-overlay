# 기능 계약 주석 인덱스

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

## 데이터 보호·외부 전송

| 기능 | 기준 계약 위치 | 함께 확인할 경로 |
|---|---|---|
| 로컬 백업·복원 | `src/modules/backupManager.ts` | `localSnapshot.ts`, `docs/settings.md` |
| 도구 localStorage 백업 | `src/modules/rendererStorageBackup.ts` | `shared/rendererStorage.ts`, `storage-bridge.html`, `scripts/check-audit-regressions.ts`, `docs/settings.md` |
| 설정 초안·런타임 적용 | `src/renderer/settings/draft.ts`, `src/modules/runtimeSettings.ts` | `settings.html`, `ipcHandlers.ts`, `cloudSyncManager.ts`, `scripts/check-audit-regressions.ts`, `docs/settings.md` |
| 장비 강화·인챈트·인크립트 기댓값 / 0원 구간·횟수 입력 | `src/shared/equipmentSimulator.ts`, `src/renderer/equipment-simulator.ts` | `scripts/check-audit-regressions.ts`, `scripts/check-renderer-behavior.ts --equipment-simulator`, `docs/equipment-simulator.md` |
| Google Drive 동기화 | `src/modules/cloudSyncManager.ts` | `syncDataHelper.ts`, `google-drive-sync-contract.md`, `docs/google-drive-sync.md` |
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

| 활동 프리셋 | `src/shared/activityPresets.ts`의 `mergeActivitySettings`, `src/modules/ipcHandlers.ts`의 `applyActivityPreset` | `windowManager.ts`의 `captureActivityLayout`/`restoreActivityLayout`, `modules/config.ts`, `scripts/check-companion-features.ts`의 `checkActivityBuffRestoration`/`checkActivityWindowSizes`, `scripts/check-preset-position.ts`, `docs/companion-tools.md` |

| 알림 위치·실화면 미리보기 | `src/renderer/game-overlay/notification-layout.ts` | `shared/notificationLayout.ts`, `renderer/settings/notification-layout.ts`, `docs/companion-tools.md` |

신규 보조 기능은 `scripts/check-companion-features.ts`의 실제 파서/DB/IPC 검증과 `scripts/check-renderer-behavior.ts`의 실제 DOM 검증을 함께 실행합니다. 집중 채팅의 초기 표시 설정 응답은 더 최신인 서버·메모 설정을 되돌리지 않습니다.


플레이 보조 화면의 정보·관리 분리: `renderer/nickname-notes.ts`의 정보 조회 세션과 메모 저장 계약, `shared/nicknameInfo.ts`의 캐릭터 매핑, `renderer/settings/activity-presets.ts`의 상세 펼침·이름 초안, `modules/gameOverlayEditSession.ts`의 저장 확인 후 입력 복귀를 함께 확인합니다. 회귀 검사는 `scripts/check-companion-design.ts`(실제 preload·IPC·임시 디스크·Electron), `scripts/check-renderer-behavior.ts`(채팅 이력·초안·긴 메모), `scripts/check-companion-features.ts`(프리셋 실제 창 복원)입니다. 사용자 문서는 `docs/companion-tools.md`, `docs/chat-overlay.md`입니다.
