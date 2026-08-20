/**
 * game-overlay DevTools 테스트 진입점.
 * 스크립트가 실수로 두 번 로드되어도 가이드와 전역 함수는 한 번만 등록한다.
 */
declare const gameOverlayAlerts: GameOverlayAlerts;
declare const currentConfig: Record<string, any> | null | undefined;
declare const ETHOS_PASSWORD_BY_DIRECTION: Record<string, string>;
declare function triggerLokagosAlert(type: string, zone: string): void;
declare function showEthosAlert(password: string): string | null;
declare function showAbyssApostleAlert(onStart: () => void, onEnd: () => void): boolean;

(function initializeGameOverlayDevtools() {
  if (window.__twOverlayDevtoolsInitialized) return;
  window.__twOverlayDevtoolsInitialized = true;

  window.testEssenceAlert = function () {
    if (!document.getElementById('essence-alert')) {
      console.error('essence-alert 엘리먼트를 찾을 수 없습니다.');
      return;
    }
    gameOverlayAlerts.showEssenceAlert();
    console.log('✅ 경험의 정수 버프 경고 테스트 실행');
  };

  window.testSpecialMonsterAlert = function () {
    if (!document.getElementById('special-monster-alert')) {
      console.error('special-monster-alert 엘리먼트를 찾을 수 없습니다.');
      return;
    }
    gameOverlayAlerts.showSpecialMonsterAlert();
    console.log('✅ 공허 특별 몬스터 출현 알림 테스트 실행');
  };

  window.testLokagos = function (type: string = 'EXCLUDE', zone: string = '알파'): void {
    const validTypes = ['EXCLUDE', 'TARGET'];
    const validZones = ['알파', '브라보', '찰리', '델타'];
    if (!validTypes.includes(type) || !validZones.includes(zone)) {
      console.error('올바르지 않은 파라미터입니다. 예: testLokagos("EXCLUDE", "알파") 또는 testLokagos("TARGET", "브라보")');
      return;
    }
    triggerLokagosAlert(type, zone);

    if (
      currentConfig
      && currentConfig.lokagosAlertEnabled
      && currentConfig.lokagosAlertSound
      && currentConfig.lokagosAlertSound !== 'none'
    ) {
      const volume = currentConfig.lokagosAlertVolume !== undefined
        ? currentConfig.lokagosAlertVolume
        : 40;
      window.playPreview(
        currentConfig.lokagosAlertSound,
        volume,
        '로카고스 기믹 알림 테스트',
      );
    }

    console.log(`✅ 로카고스 기믹 테스트: ${type === 'EXCLUDE' ? zone + ' 제외 구역 대피' : zone + ' 구역 회피'} (${zone})`);
  };

  window.testEthos = function (passwordOrDir: string = '번개'): void {
    const password = ETHOS_PASSWORD_BY_DIRECTION[passwordOrDir] || passwordOrDir;
    const direction = showEthosAlert(password);
    if (!direction) {
      console.error('올바르지 않은 에토스 암호입니다:', passwordOrDir);
      return;
    }

    if (
      currentConfig
      && currentConfig.ethosAlertEnabled
      && currentConfig.ethosAlertSound
      && currentConfig.ethosAlertSound !== 'none'
    ) {
      const volume = currentConfig.ethosAlertVolume !== undefined
        ? currentConfig.ethosAlertVolume
        : 40;
      window.playPreview(
        currentConfig.ethosAlertSound,
        volume,
        '에토스 기믹 알림 테스트',
      );
    }

    console.log(`✅ 에토스 기믹 테스트: ${password} (${direction} 방향)`);
  };

  window.testAbyssApostle = function () {
    const played = showAbyssApostleAlert(
      () => {
        if (
          currentConfig?.abyssApostleAlertEnabled
          && currentConfig.abyssApostleStartSound
          && currentConfig.abyssApostleStartSound !== 'none'
        ) {
          window.playPreview(
            currentConfig.abyssApostleStartSound,
            currentConfig.abyssApostleVolume ?? 40,
            '제2사도 반사 시작 테스트',
          );
        }
      },
      () => {
        if (
          currentConfig?.abyssApostleAlertEnabled
          && currentConfig.abyssApostleEndSound
          && currentConfig.abyssApostleEndSound !== 'none'
        ) {
          window.playPreview(
            currentConfig.abyssApostleEndSound,
            currentConfig.abyssApostleVolume ?? 40,
            '제2사도 반사 종료 테스트',
          );
        }
      },
    );
    if (!played) return;

    console.log('✅ 심연의 제2사도 기믹 테스트 시작 (6.5초 경고 -> 2초 복구)');
  };

  console.log('%c[TW-Overlay 테스트 가이드]', 'color: #4ade80; font-size: 16px; font-weight: bold;');
  console.log('%c1. 팔색조 언덕 알람 UI 즉시 테스트:', 'color: #facc15; font-weight: bold;');
  console.log(`const el = document.getElementById('pitta-alert'); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');`);
  console.log('%c2. 에토스 기믹 알림 테스트:', 'color: #facc15; font-weight: bold;');
  console.log(`testEthos('번개') // N, NE, E, SE, S, SW, W, NW 중 택1 혹은 암호 입력`);
  console.log('%c3. 심연의 제2사도 기믹 알림 테스트:', 'color: #facc15; font-weight: bold;');
  console.log(`testAbyssApostle()`);
  console.log('%c4. 로카고스 기믹 알림 테스트:', 'color: #facc15; font-weight: bold;');
  console.log(`testLokagos('EXCLUDE', '알파') // EXCLUDE(대피), TARGET(폭격) 및 알파, 브라보, 찰리, 델타 중 택1`);
  console.log('%c5. 경험의 정수 버프 경고 알림 테스트:', 'color: #facc15; font-weight: bold;');
  console.log(`testEssenceAlert()`);
  console.log('%c6. 공허 특별 몬스터 출현 알림 테스트:', 'color: #facc15; font-weight: bold;');
  console.log(`testSpecialMonsterAlert()`);
  console.log('----------------------------------------------------');
})();
