# ☁️ Google Drive 클라우드 동기화 가이드

> 이 문서는 TW-Overlay v3.0.0의 개발·검증 기준입니다. 실제 릴리즈 전에는 구현된 클라우드 allowlist와 이 문서의 항목이 자동 검사로 일치해야 합니다.

TW-Overlay는 사용자가 선택적으로 Google 계정을 연결한 경우에만 Google Drive의 앱 전용 숨김 영역(`appDataFolder`)에 설정과 숙제 체크리스트를 저장합니다. 개발자 서버를 경유하지 않으며 사용자의 일반 Google Drive 파일에는 접근하지 않습니다.

## 1. 저장 파일과 갱신 시점

| 파일 | 저장 내용 | 자동 갱신 |
|---|---|---|
| `tw_overlay_settings.json` | 다른 PC에서도 사용할 수 있는 일반 설정 | 마지막 설정 변경 후 1~2초 동안 변경을 모아 이 파일만 갱신. 명시적 저장·종료 flush에서는 즉시 시도 |
| `tw_overlay_checklist.json` | 숙제 정의, 캐릭터, 리셋 주기별 진행 상태, 미반영 감지 이력 | 로컬 저장과 outbox 기록이 성공한 뒤 즉시 또는 최대 500ms 안에 이 파일만 갱신 |
| `tw_overlay_sync_meta.json` | 위 두 파일의 Drive file ID, 파일 종류, 스키마, 생성 세대 | 파일 생성·교체·마이그레이션 때만 갱신 |

파일명에는 버전을 붙이지 않습니다. 각 JSON 내부의 `schemaVersion`과 `revision`으로 호환성과 최신 상태를 판별합니다.

설정 변경은 숙제 파일을 다시 올리지 않고, 숙제 감지는 설정 파일을 다시 올리지 않습니다. 입력 한 글자나 슬라이더 이동마다 Drive 요청을 보내지는 않습니다.

백그라운드의 주기적 동기화 표시는 다른 PC의 변경을 확인하는 수신(pull) 작업입니다. 설정 dirty key나 숙제 outbox가 없으면 데이터 파일 업로드를 수행하지 않습니다. 채팅 오버레이 크기 조절은 동기화 대상 설정 변경이므로 조절이 끝난 뒤 설정 파일은 debounce하여 한 번 갱신할 수 있지만, 숙제 파일을 dirty로 만들거나 다시 업로드하지 않습니다.

## 2. 사용 방법

1. 설정 > 데이터 관리에서 Google 계정으로 로그인하고 `drive.appdata` 권한을 승인합니다.
2. 자동 동기화를 켜면 설정과 숙제 변경이 각 파일의 갱신 규칙에 따라 백그라운드에서 저장됩니다.
3. `지금 백업`은 설정과 숙제의 현재 로컬 상태를 모두 즉시 확인·업로드합니다.
4. `불러오기`에서는 일반 설정과 숙제 체크리스트를 각각 선택할 수 있습니다. 설정에는 클라우드 스냅샷을 적용하고 숙제에는 3방향 병합을 적용하며, 적용 전에 현재 로컬 설정을 백업합니다.
5. 일반 설정과 숙제 체크리스트 상태 카드의 `데이터 확인`은 공유 generation을 검증한 뒤 해당 파일의 JSON만 읽기 전용으로 보여줍니다. 상단의 `전체 데이터 확인`은 두 정상 파일을 합쳐 보여줍니다. 파일이 없거나 손상됐거나 생성 세대가 다르면 해당 파일의 상태를 따로 표시하며 정상인 다른 파일은 계속 확인할 수 있습니다.
6. 복원 전에 파일별 추가·변경·현재 PC 유지 키 수를 확인할 수 있습니다. 최근 복원 전 백업이 있으면 `최근 복원 되돌리기`로 이 PC의 설정을 복구할 수 있으며, 되돌린 설정은 이후 자동 동기화로 다른 PC에도 반영될 수 있습니다.

다른 PC의 변경은 게임 실행 중 약 30초, 게임 미실행 유휴 상태에서는 약 5분 간격으로 확인합니다. PC별 요청 시점이 몰리지 않도록 약간의 시간 차이를 두며, 실패가 반복되면 재시도 간격을 점차 늘립니다. 앱 시작, 게임 시작, 절전 복귀, 화면 잠금 해제, 네트워크 복구, 자동 동기화 재활성화 때에는 주기를 기다리지 않고 즉시 확인합니다.

## 여러 PC에서 숙제를 바꾸면 어떻게 합쳐지나요?

TW-Overlay는 한쪽 PC의 체크리스트를 다른 쪽에 통째로 덮어쓰지 않습니다. `마지막으로 두 PC가 같았던 상태`를 기준으로 집 PC와 회사 PC에서 무엇이 달라졌는지 비교합니다.

| 사용 상황 | 반영 결과 |
|---|---|
| 한쪽 PC에서만 숙제를 변경함 | 변경한 내용을 다른 PC에도 반영합니다. |
| 두 PC에서 같은 내용으로 변경함 | 같은 결과를 한 번만 반영합니다. |
| 서로 다른 캐릭터의 숙제를 진행함 | 각 캐릭터의 변경을 모두 유지합니다. |
| 같은 캐릭터의 같은 숙제를 완료·해제하거나 횟수를 서로 다르게 변경함 | 각 PC에 기록된 변경을 정해진 순서로 다시 적용해 두 PC가 같은 최종 결과가 되게 합니다. |

예를 들어 집 PC에서 본캐의 A 숙제를 완료하고 회사 PC에서 부캐의 A 숙제를 완료했다면 두 캐릭터의 완료 상태가 모두 남습니다. 같은 캐릭터의 횟수를 한쪽에서 1회, 다른 쪽에서 2회로 바꾼 경우에는 각 변경 기록을 비교해 최종 결과를 정하고 두 PC가 그 결과로 맞춰집니다. 앱을 껐다 켜거나 업로드 응답이 늦어져도 확인되지 않은 변경 기록은 바로 버리지 않습니다.

게임 로그로 숙제 완료를 감지했지만 적용할 캐릭터가 여러 명이면, 그 선택 대기 상태도 클라우드에 저장됩니다. 다른 PC에서도 캐릭터 선택 팝업이 표시되며 앱이 캐릭터를 임의로 정하지 않습니다. 이미 완료했거나 제외한 캐릭터를 빼고 미완료 후보가 한 명뿐이면 그 캐릭터에 자동으로 반영합니다. 숙제의 일일·주간 초기화 시각이 지난 오래된 선택 대기는 다음 주기로 넘기지 않습니다.

## 3. `tw_overlay_settings.json`에 동기화되는 항목

아래 표가 설정 파일의 전체 허용 범위입니다. 표에 없는 설정은 자동으로 클라우드에 추가하지 않습니다.

파일 최상위 허용 필드는 다음과 같습니다.

<!-- settings-payload-allowlist:start -->

| 범위 | 허용 필드 | 의미 |
|---|---|---|
| 설정 payload 최상위 | `schemaVersion`, `appVersion`, `lastSyncedAt`, `updatedBy`, `kind`, `revision`, `generationId`, `checksum`, `data` | `updatedBy`는 Google 이메일이 아니라 이 설치의 device ID이며, `kind`는 `settings`입니다. `checksum`은 `data` 검증용입니다. |

<!-- settings-payload-allowlist:end -->

<!-- settings-data-allowlist:start -->

| 기능 | 동기화 항목 | 내부 설정 키 |
|---|---|---|
| 숙제 체크리스트 표시 | 기능 사용 여부, 자동 열기, 마지막 선택 캐릭터, 알림 음량 | `contentsCheckerEnabled`, `autoOpenContentsChecker`, `selectedCharacterId`, `volumeContentsChecker` |
| 사이드바·메뉴 | 퀵슬롯, 단축키, 숨김/표시 메뉴, 사이드바 방향·독 위치, 오버레이 토스트 표시 | `quickSlots`, `shortcuts`, `hiddenMenuIds`, `visibleMenuIds`, `sidebarPosition`, `showSidebarToastOnOverlay` |
| 갤러리 모니터 | 전체 알림 사용 여부, 갤러리 키워드 | `galleryNotify`, `galleryKeywords` |
| 거래 게시판 모니터 | 서버, 알림 사용 여부, 거래 키워드 | `tradeServer`, `tradeNotify`, `tradeKeywords` |
| 채팅·득템·외치기 알림 | 득템/외치기 키워드, 지정 단어 알림 사용 여부·키워드·음량·이력 사용 여부 | `lootKeywords`, `shoutKeywords`, `wordAlarmEnabled`, `wordAlarmKeywords`, `wordAlarmVolume`, `wordAlarmHistoryEnabled` |
| 지정 단어 알림 사운드 | 내장 사운드 asset ID만 동기화 | `wordAlarmSound` |
| 필드보스 알림 | 보스별 설정, 알림 사용 여부, 사전 알림 시각, 음량. 보스별 `soundFile`은 내장 asset ID만 포함 | `fieldBossSettings`, `fieldBossNotifyEnabled`, `fieldBossNotifyOffsets`, `fieldBossNotifyVolume` |
| 커스텀 알람 | 사용자가 만든 알람 정의. `soundFile`은 내장 asset ID만 포함 | `customAlerts` |
| 버프 타이머 | 감지 버프, 경고 초, 중앙/소리/시각 알림, 음량, 내장 사운드, 기능/HUD/단축키 표시 | `buffTimerBuffs`, `buffTimerWarnSeconds`, `buffTimerCenterAlert`, `buffTimerAudioAlert`, `buffTimerVisualAlert`, `buffTimerVolume`, `buffTimerSound`, `buffTimerEnabled`, `showBuffHud`, `showHudShortcuts` |
| 콘텐츠별 알림 | 에토스, 심연의 사도, 로카고스, 웨이브 몬스터, 경험의 정수, 특수 몬스터, 어벤던로드, 피타의 언덕, 퀘스트 완료 알림의 사용 여부·음량·내장 사운드 | `ethosAlertEnabled`, `ethosAlertSound`, `ethosAlertVolume`, `abyssApostleAlertEnabled`, `abyssApostleStartSound`, `abyssApostleEndSound`, `abyssApostleVolume`, `lokagosAlertEnabled`, `lokagosAlertSound`, `lokagosAlertVolume`, `waveMonsterWarningEnabled`, `waveMonsterWarningSound`, `waveMonsterWarningVolume`, `essenceAlertEnabled`, `essenceAlertSound`, `essenceAlertVolume`, `specialMonsterAlertEnabled`, `abandonedAlertEnabled`, `pittaHillAlertEnabled`, `questCompleteAlertEnabled` |
| 어벤던로드 | 기능 사용 여부, 자동 숨김 시간 | `abandonedEnabled`, `abandonedAutoHideMinutes` |
| 사기 탐지 | 기능 사용 여부, 내장 경고 사운드 | `scamDetectorEnabled`, `scamAlertSound` |
| Discord 알림 | 알림 사용 여부, 키워드, 채널별 키워드 규칙. Webhook URL은 제외 | `discordAlertEnabled`, `discordKeywords`, `discordRules` |
| 경험치·오늘 요약 | XP 위젯 표시/자동 시작/음수 처리, 오늘 요약 HUD 표시·접힘 | `showXpWidget`, `xpAutoStart`, `ignoreNegativeXp`, `showTodaySummaryHud`, `todaySummaryCollapsed` |
| 사냥 경험치 계산기 | 도핑, 사냥터, 선택 사냥터, 시간당 처치 수, 해피아워 | `huntingExpDopings`, `huntingExpGrounds`, `huntingExpSelectedGroundId`, `huntingExpKillsPerHour`, `huntingExpHappyHour` |
| 게임·일지 동작 | 게임 창 따라가기, 게임 종료 알림, 알림 문구, 게임 종료 감지, 채팅/일지 보존 기간, 계산기 음량 | `followGameWindow`, `gameExitReminderEnabled`, `gameExitReminderMessage`, `notifyWhenGameClosed`, `chatLogAutoDeleteDays`, `diaryKeepDays`, `volumeCalculators` |
| 채팅 오버레이 기본 | 메인/서브 창 사용 여부, 글자 크기, 각 창 투명도, 클릭 투과, 선택 채널 | `chatOverlayEnabled`, `chatOverlaySubEnabled`, `chatOverlaySub2Enabled`, `chatOverlayFontSize`, `chatOverlayOpacity`, `chatOverlaySubOpacity`, `chatOverlaySub2Opacity`, `chatOverlayClickThrough`, `chatOverlaySelectedChannels` |
| 채팅 오버레이 탭·필터 | 각 창 선택 탭, 커스텀 탭, 키워드, 블랙리스트, NPC/XP/엘소 표시, 사기 닉네임 강조 | `chatOverlayTab`, `chatOverlaySubTab`, `chatOverlaySub2Tab`, `chatOverlayCustomTabs`, `chatOverlayKeywords`, `chatOverlayBlacklistFilters`, `chatOverlayShowNpcChat`, `chatOverlayShowXpGain`, `chatOverlayShowElsoGain`, `chatOverlayHighlightScamNicknames` |
| 채팅 오버레이 색상 | 채널별 색상, 닉네임 색상 방식과 채널별 닉네임 색상 | `chatOverlayColorGeneral`, `chatOverlayColorWhisper`, `chatOverlayColorTeam`, `chatOverlayColorClub`, `chatOverlayColorShout`, `chatOverlayNicknameColorMode`, `chatOverlayNicknameColorGeneral`, `chatOverlayNicknameColorWhisper`, `chatOverlayNicknameColorTeam`, `chatOverlayNicknameColorClub`, `chatOverlayNicknameColorShout` |
| 사용자·서버 | 테일즈위버 서버, 포커스 채팅의 내 닉네임 | `userServer`, `focusedChatSelfNickname` |

<!-- settings-data-allowlist:end -->

최상위 사운드 설정과 `fieldBossSettings`·`customAlerts` 안의 `soundFile`은 TW-Overlay에 포함된 내장 asset ID일 때만 동기화합니다. 사용자 PC의 절대 파일 경로이면 해당 사운드 값은 업로드하지 않고 다른 PC의 로컬 선택을 유지합니다.

## 4. `tw_overlay_checklist.json`에 동기화되는 항목

<!-- checklist-data-allowlist:start -->

숙제 파일의 data 객체 최상위 허용 키는 `contentsCheckerItems`, `characterPresets`, `pendingHomeworks` 세 가지입니다.

<!-- checklist-data-allowlist:end -->

<!-- checklist-payload-allowlist:start -->

| 범위 | 허용 필드 | 의미 |
|---|---|---|
| 숙제 payload 최상위 | `schemaVersion`, `appVersion`, `lastSyncedAt`, `updatedBy`, `kind`, `revision`, `generationId`, `checksum`, `operations`, `operationsChecksum`, `data` | `updatedBy`는 Google 이메일이 아니라 이 설치의 device ID이며, `kind`는 `checklist`입니다. |
| operation | `id`, `deviceId`, `createdAt`, `keys`, `mutations` | 한 PC에서 만든 안정 operation과 변경 대상 최상위 키입니다. |
| mutation | `path`, `beforeExists`, `afterExists`, `before`, `after` | 숙제·캐릭터 안정 ID 경로와 변경 전후 값입니다. `before`/`after`는 해당 값이 존재할 때만 포함합니다. |

<!-- checklist-payload-allowlist:end -->

| 구분 | 정확한 내용 |
|---|---|
| 숙제 정의 | ID, 이름, 분류, 표시 여부, 커스텀 여부, 콘텐츠별/사용자 지정 리셋 규칙, 최대 횟수, 자동 감지 지원 여부 |
| 캐릭터 프리셋 | 캐릭터 ID와 사용자가 지정한 캐릭터 이름 |
| 캐릭터별 숙제 상태 | 완료/해제, N/A 여부, 현재 횟수, 최신 완료 시각, 적용 리셋 주기 |
| 미반영 완료 이력 | 캐릭터를 결정하기 전에 감지된 숙제 ID, 증가/절대 횟수, 감지 시각, 안정 operation ID |
| 동기화 제어 상태 | payload revision/checksum, operation ID, 숙제·캐릭터 안정 ID 경로의 `before/after` mutation. 마지막 정상 동기화 기준본과 미전송 outbox 자체는 각 PC의 로컬 `cloud-sync-state.json`에만 저장 |

로컬 `cloud-sync-state.json`을 다시 읽을 때는 installation/generation ID, Drive file ID·revision·설정 dirty key, 숙제 operation/mutation과 종료 recovery marker를 필드별로 검증합니다. 일부 값이 손상돼도 정상 file ID와 미전송 operation/recovery는 함께 버리지 않고 독립적으로 보존하며, 핵심 식별자가 손상된 기존 프로필을 새 PC로 오인하지 않습니다.

최초 installation/generation ID는 상태를 처음 읽는 즉시 원자 저장합니다. 저장 도중 정식 파일로 rename되기 전에 프로세스가 중단돼 유효한 `.tmp`만 남으면 다음 실행에서 이를 검증해 정식 상태로 승격하므로 dirty/outbox/recovery marker를 잃지 않습니다.

숙제 상태는 `contentId + characterId + resetCycle`을 키로 마지막 정상 동기화본·현재 로컬·현재 클라우드를 비교하는 3방향 병합을 수행합니다.

- 로컬만 바뀜: 로컬 적용
- 클라우드만 바뀜: 클라우드 적용
- 양쪽이 같은 값으로 바뀜: 해당 값 적용
- 양쪽이 서로 다르게 바뀜: 실제 게임 로그를 추적한 로컬 적용

완료 해제, N/A 해제, 횟수 감소, 커스텀 숙제 삭제도 변경으로 기록합니다. 미반영 완료 이력은 같은 operation ID를 두 번 적용하지 않으며 해당 숙제의 리셋 경계가 지나면 이월하지 않습니다.

캐릭터가 둘 이상일 때 자동 감지 후 표시되는 선택 팝업의 대기 정보도 `pendingHomeworks`로 동기화합니다. 서로 다른 PC가 같은 숙제와 같은 리셋 주기를 캐릭터 선택 전에 각각 감지하면 두 값은 하나의 논리 pending 키에서 충돌하므로, operation의 `createdAt`·device ID·operation ID 순서로 결정한 마지막 값에 수렴합니다. 캐릭터를 임의로 추측하거나 한 감지를 여러 캐릭터에 자동 적용하지 않습니다. 각 PC에서 캐릭터를 선택한 뒤에는 서로 다른 `characterId`의 완료 상태가 되므로 두 결과와 두 operation을 모두 보존합니다. 여러 게임 계정이 같은 Google 계정으로 동일 숙제를 동시에 감지하고 양쪽 모두 선택을 미루는 경우까지 두 감지의 누적을 보장하지는 않습니다.

업로드 직후 다른 PC가 같은 파일을 덮어써 확인했던 operation ID가 원격에서 사라지면, 해당 operation의 안정 ID mutation만 최신 원격 상태 위에 다시 적용합니다. 따라서 다른 PC가 바꾼 비충돌 숙제 상태는 유지하면서 사라진 완료·해제·횟수 변경을 재게시할 수 있습니다. operation에는 Discord Webhook URL, OAuth 토큰, 로컬 경로, 커스텀 사운드가 포함되지 않습니다.

## 5. `tw_overlay_sync_meta.json`에 동기화되는 항목

메타 파일은 사용자 설정값이나 숙제 내용을 복제하지 않고 같은 generation의 두 데이터 파일을 찾는 참조만 저장합니다.

<!-- meta-payload-allowlist:start -->

| 범위 | 허용 필드 | 의미 |
|---|---|---|
| 메타 payload 최상위 | `schemaVersion`, `generationId`, `updatedAt`, `files` | 메타 스키마, 공유 generation, 메타 갱신 시각, 파일 참조 묶음입니다. |
| `files.settings` | `id`, `name` | 설정 Drive file ID와 고정 이름 `tw_overlay_settings.json`입니다. 설정 파일이 아직 없으면 이 참조 전체를 생략합니다. |
| `files.checklist` | `id`, `name` | 숙제 Drive file ID와 고정 이름 `tw_overlay_checklist.json`입니다. 숙제 파일이 아직 없으면 이 참조 전체를 생략합니다. |

<!-- meta-payload-allowlist:end -->

메타 파일에는 이메일, device ID, OAuth 토큰, Webhook URL, 로컬 경로, 설정값, 숙제 상태를 저장하지 않습니다.

## 6. 클라우드에 동기화하지 않는 항목

| 제외 범주 | 제외 항목·내부 키 | 제외 이유 |
|---|---|---|
| 비밀 자격증명 | Discord Webhook URL(`discordWebhookUrl`), Google OAuth access/refresh token | PC방·공용 PC 복원 및 로그를 통한 전송 권한 노출 방지 |
| 로컬 파일·폴더 | 채팅 로그 경로(`chatLogPath`), 메신저 로그 경로(`msgerLogPath`), 커스텀 사운드 목록·절대경로(`customSounds` 및 사운드 필드의 로컬 경로) | 다른 PC에서 존재하지 않는 경로 |
| 창 위치·크기 | `positions`, `storedPositionKeys`, `width`, `height`, `opacity`, `xpWidgetPos`, `todaySummaryHudPos`, `buffTimerHudPos`, `abandonedWidgetPos`, `forgeQuestHudPos`, `questHudPos`, `chatOverlayWidth/Height`, `chatOverlaySubWidth/Height`, `chatOverlaySub2Width/Height`, `focusedChatWidth/Height`, `contentsCheckerWidth/Height` | 모니터, DPI, 해상도마다 달라지는 PC 종속 정보 |
| 원본·이력 데이터 | 일지 SQLite DB, 채팅 로그 원본, 알람 이력, 갤러리/거래 마지막 확인 위치(`galleryLastSeen`, `galleryWatched`, `tradeLastSeen`) | 설정 동기화와 수명·용량·충돌 정책이 다름 |
| 장치·실행 상태 | `autoLaunch`, `autoUpdateEnabled`, `overlayVisible`, `scamGpuVariant`, `scamLlmDisabled`, `setupCompleted` | 해당 PC의 하드웨어·설치·실행 환경에 종속 |
| 내부 상태 | `lastContentsResetCheck`, `lootKeywordsMigratedV2`, `quickSlotsMigratedV2`, `googleSyncEnabled`, `googleSyncAutoSync`, `googleSyncLastTime`, `googleSyncUserEmail`, `hasSeenWelcomeGuide`, `lastNoticeVersion`, `url`, `homeUrl`, `etaDataUrl` | 앱 내부에서 재생성하거나 각 PC가 독립적으로 관리 |

동기화에서 제외된 값은 클라우드 복원으로 지우거나 기본값으로 덮어쓰지 않습니다.

## 7. 설정 복원과 새 PC 판정

- 일반 설정은 클라우드 파일에 존재하는 필드를 사용합니다. 적용 직전에 로컬 백업을 만들고 변경 요약과 되돌리기를 제공합니다.
- 클라우드에 없는 신규 설정 키는 앱의 신규 기본값을 추가합니다. 기존 사용자 값은 `false`, `0`, 빈 문자열, 빈 배열이어도 보존합니다.
- 동기화가 꺼져 있거나 오프라인인 동안 바꾼 일반 설정과 다른 PC의 클라우드 설정이 충돌하면 클라우드가 우선합니다.
- 숙제 체크리스트는 설정처럼 통째로 덮지 않고 3방향 병합합니다.
- 설치 표식·`config.json`·`diary.db`가 모두 없던 프로필만 `fresh`로 봅니다. 유효한 기존 config/DB가 있으면 `established`, 임시·손상 파일만 남아 판정이 애매하면 `needs-confirmation`으로 기록하고 자동 복원하지 않습니다.
- `fresh` 복원은 메타 파일이 가리키는 파일 ID를 우선 사용합니다. Drive AppData 목록의 모든 페이지를 확인하며, 중복 파일은 checksum·종류·생성 세대 검증을 통과한 후보만 사용합니다. 최신 메타가 손상됐거나 모든 데이터 파일 참조가 끊겼으면 다음 유효 메타 후보를 확인합니다. 한 파일 참조만 정상인 메타는 해당 파일의 독립 복원을 위해 사용할 수 있습니다.
- 설정 파일과 숙제 파일은 독립적으로 복원합니다. 한 파일이 없거나 손상됐거나 생성 세대가 달라도 정상인 다른 파일은 적용하고 파일별 결과와 부분 복원 상태를 로컬에 기록합니다.
- 기존 PC의 백그라운드 pull에서도 한 파일의 검증·적용 실패가 다른 정상 파일 수신을 중단하지 않습니다. 정상 파일 변경은 적용하고 손상 파일은 `invalid`인 partial 결과로 분리합니다.
- 명시적 복원에서는 설정과 숙제를 각각 선택할 수 있으며, 선택하지 않은 데이터는 현재 PC 상태를 유지합니다.

## 8. 종료와 다음 실행 복구

- 일반 종료를 시작하면 모든 앱 창과 트레이를 먼저 숨겨 사용자가 종료 지연을 느끼지 않게 합니다.
- 신규 변경 생산을 멈추고 로컬 config와 숙제 outbox를 저장한 뒤, 클라우드 대기 작업을 최대 3초 동안 정리합니다. 업데이트 설치 종료 경로는 최대 500ms만 기다립니다.
- 제한 시간 안에 완료되지 않거나 요청 응답이 유실되면 진행 중인 Drive 요청을 취소하고 `cloud-sync-state.json`에 설정 dirty key·숙제 operation ID와 당시 checksum·원격 revision을 파일별 recovery marker로 보존합니다.
- 다음 로그인 실행은 원격 revision·checksum·operation을 다시 확인합니다. 서버에 이미 반영된 작업은 중복 업로드 없이 완료 처리하고, 확인되지 않은 파일만 다시 전송하며 파일별 확인이 끝난 뒤에만 해당 marker를 제거합니다.
- Windows 로그오프·시스템 종료처럼 긴 대기가 불가능한 경우에는 OS 종료를 막지 않고 로컬 config, 숙제 outbox·recovery marker, DB recovery journal과 WAL을 먼저 보존하는 빠른 경로를 사용합니다.
- 일반 종료에서는 클라우드 정리 뒤 SQLite WAL checkpoint를 실행하고 DB를 닫습니다. 제한 시간 초과가 데이터의 성공 처리로 기록되지는 않습니다.

## 9. 보안과 개인정보

- 앱은 `drive.appdata` 권한만 요청하며 TW-Overlay가 만든 앱 데이터 파일만 읽고 씁니다.
- 클라우드 파일은 Google Drive UI에서 일반 문서처럼 보이지 않지만, TW-Overlay가 별도의 종단간 암호화를 추가하는 것은 아닙니다.
- Google 계정 이메일은 연결된 계정 표시를 위해 로컬에서 사용하며 세 동기화 JSON의 사용자 데이터 항목으로 저장하지 않습니다.
- 캐릭터 이름, 포커스 채팅 닉네임, 키워드, 단축키, 사용자 알람은 사용자가 입력한 내용 그대로 설정/숙제 파일에 저장될 수 있습니다.
- Discord Webhook URL은 클라우드 payload, 데이터 미리보기, 로그, 오류 메시지, 진단 내보내기에 포함하지 않습니다.
- 로그아웃하면 로컬 OAuth 토큰을 삭제합니다. 로그아웃 또는 새 로그인 전에 시작된 토큰 갱신 응답은 늦게 도착해도 저장하거나 현재 인증을 무효화하지 않습니다. Google 계정 권한 관리에서도 언제든지 앱 권한을 철회할 수 있습니다.
- 사용자가 누른 연결 해제는 이 PC의 자동 동기화 선택을 끄지만, 토큰 만료·권한 철회는 `다시 로그인 필요` 상태로 구분합니다. 이때 설정 dirty key, 숙제 outbox, 종료 recovery marker와 로컬 계정 표시는 보존하며, 재로그인 성공 후 즉시 원격 변경 확인과 미완료 전송 확인을 재개합니다.
- OAuth token 교환 뒤 연결 계정 프로필을 확인해야만 로그인을 완료하고 토큰을 저장합니다. 프로필 확인이 실패하면 인증 상태를 남기지 않고 다시 로그인을 안내합니다.
- OAuth callback은 브라우저가 허용하는 임시 로컬 루프백 포트만 사용합니다. OS가 차단 포트를 배정하면 새 포트를 요청하고, 기본 브라우저를 열지 못하면 60초를 기다리지 않고 즉시 다시 시도하도록 안내합니다.
- OAuth 로그인마다 임의 `state`를 생성해 callback에서 일치 여부를 확인합니다. 누락되거나 변조된 callback은 token 교환 전에 거부하며, callback 페이지의 오류·이메일 등 외부 문자열은 HTML 요소로 실행되지 않도록 escape합니다.

## 10. 사용자가 확인할 수 있어야 하는 정보

설정의 클라우드 데이터 화면은 다음 정보를 파일별로 표시해야 합니다.

- 파일 종류와 마지막 정상 동기화 시각
- 로컬/클라우드 revision과 대기 중인 변경 여부
- 마지막 성공·실패 상태와 재시도 여부
- 이번 복원에서 추가·변경·제외되는 항목 요약
- 설정만 복원, 숙제만 복원, 전체 복원 선택
- 동기화 제외 항목과 제외 이유

원본 JSON 미리보기는 허용하되 토큰, Webhook URL, 로컬 절대경로 같은 제외 값이 섞여 들어오지 않았는지 먼저 검증합니다.

현재 구현은 파일별 선택 복원, 검증 결과, 부분 복원 상태, 값 비노출 변경 키 요약과 일반 설정·숙제 체크리스트 각각의 JSON 미리보기 및 전체 합친 미리보기를 제공합니다. 설정 화면에서 로컬 checksum, 마지막 확인 클라우드 revision, 대기 변경 수, 업로드·원격 확인 재시도 상태를 파일별로 확인할 수 있으며 최근 복원 전 백업으로 되돌릴 수 있습니다.

인증이 만료되면 설정 카드는 일반 미연결과 구분해 `다시 로그인 필요`를 표시합니다. 사이드바·독·숙제 체크리스트의 오류 아이콘과 비차단 알림에서 이 카드로 이동할 수 있으며, 게임 시작 중 설정 창을 강제로 열어 포커스를 바꾸지는 않습니다.

## 11. 권한 철회와 데이터 삭제

1. 앱의 설정 > 데이터 관리에서 Google 연동을 해제합니다.
2. [Google 계정 권한 관리](https://myaccount.google.com/permissions)에서 TW-Overlay 권한을 철회할 수 있습니다.
3. Google Drive 설정 > 앱 관리 > TW-Overlay > 숨겨진 앱 데이터 삭제에서 클라우드 파일을 삭제할 수 있습니다.
