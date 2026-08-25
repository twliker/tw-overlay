/**
 * TW-Overlay 공통 UI 유틸리티
 */

(() => {
const getElectronApi = (): any => (window as any).electronAPI;

window.REAL_BOSSES = Object.freeze([
  '골론',
  '파멸의 기원',
  '스페르첸드',
  '골모답',
  '아칸',
  '혼란한 대지',
]);

// 아이콘 새로고침
window.refreshIcons = function () {
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
};

// CSS 애니메이션을 처음부터 다시 재생
window.replayAnimation = function (element, className = 'show') {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
};

// Escape 키로 창 닫기 바인딩
window.bindEscapeClose = function () {
  if (window.__twEscapeCloseBound) return;
  window.__twEscapeCloseBound = true;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 닫기 전 추가 로직이 필요한 경우를 위해 이벤트를 전파하지 않음
      window.close();
    }
  });
};

// preload에 등록된 IPC 이벤트 구독 정리 바인딩
window.bindElectronListenerCleanup = function () {
  if (window.__twElectronListenerCleanupBound) return;
  window.__twElectronListenerCleanupBound = true;
  window.addEventListener('beforeunload', () => {
    const electronApi = getElectronApi();
    if (electronApi && electronApi.cleanupAllListeners) {
      electronApi.cleanupAllListeners();
    }
  });
};

// 설정 카드 강조 애니메이션
window.highlightElement = function (
  element: HTMLElement | null,
  activeStyle: { borderColor: string; boxShadow: string },
): void {
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.style.transition = 'all 0.4s ease';

  let count = 0;
  const interval = setInterval(() => {
    if (count % 2 === 0) {
      element.style.borderColor = activeStyle.borderColor;
      element.style.boxShadow = activeStyle.boxShadow;
    } else {
      element.style.borderColor = 'rgba(255, 255, 255, 0.05)';
      element.style.boxShadow = 'none';
    }
    count++;
    if (count > 5) {
      clearInterval(interval);
      element.style.borderColor = '';
      element.style.boxShadow = '';
    }
  }, 300);
};

// 사운드 목록 로드 (공통)
window.loadSoundList = async function (): Promise<SoundListItem[]> {
  try {
    const response = await fetch('assets/data/sounds.json');
    const defaultSounds = await response.json() as SoundListItem[];

    const electronApi = getElectronApi();
    if (electronApi && electronApi.getConfig) {
      const config = await electronApi.getConfig();
      if (config && config.customSounds && config.customSounds.length > 0) {
        return [...defaultSounds, ...config.customSounds];
      }
    }

    return defaultSounds;
  } catch (e) {
    console.error('Failed to load sound list:', e);
    return [];
  }
};

// 슬라이더 값 퍼센트 표시 업데이트
window.updateRangeValue = function (inputEl: HTMLInputElement, targetId: string): void {
  const target = document.getElementById(targetId);
  if (target) {
    target.innerText = inputEl.value + '%';
  }
};

window.formatElapsedTime = function (milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

window.formatLocaleNumber = function (value: number): string {
  return value.toLocaleString('ko-KR');
};

const koreanTextCollator = new Intl.Collator('ko-KR', {
  sensitivity: 'base',
  numeric: true,
});

window.compareKoreanText = function (left: unknown, right: unknown): number {
  return koreanTextCollator.compare(String(left ?? ''), String(right ?? ''));
};

window.normalizeChatDisplayText = function (value: unknown): string {
  return String(value ?? '')
    .replace(/(?:&nbsp;?|&#0*160;?|&#x0*a0;?|\u00a0)/gi, ' ')
    .trim();
};

window.formatSeedAmount = function (seed: number): string {
  if (seed === 0) return '0 시드';
  const units = [
    { label: '조', value: 1000000000000 },
    { label: '억', value: 100000000 },
    { label: '만', value: 10000 },
  ];
  let result = '';
  let remaining = seed;

  for (const unit of units) {
    if (remaining >= unit.value) {
      result += Math.floor(remaining / unit.value) + unit.label + ' ';
      remaining %= unit.value;
    }
  }
  if (result === '') result = remaining.toLocaleString();
  return result.trim() + ' 시드';
};

// 사운드 미리보기
window.playPreview = function (
  soundFile: string,
  volume: number | null = null,
  bossName: string = '미리보기',
): void {
  const electronApi = getElectronApi();
  if (electronApi && electronApi.previewBossSound) {
    electronApi.previewBossSound(soundFile, volume, bossName);
  }
};

// innerHTML 보간용 이스케이프. 기존 화면별 출력 차이를 용도별 함수로 보존한다.
window.escapeHtml = function (value: unknown): string {
  if (!value) return '';
  return (value as string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

window.escapeHtmlText = function (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

window.escapeHtmlAttribute = function (value: string): string {
  if (!value) return '';
  return window.escapeHtml(value).replace(/'/g, '&#039;');
};

window.getBossToastPresentation = function (
  bossName: string,
  isCustomFromApi: boolean,
  spawnTime: string | null | undefined,
  offset: number,
): BossToastPresentation {
  const isRealBoss = window.REAL_BOSSES.includes(bossName) && !isCustomFromApi;
  const validSpawnTime = (
    spawnTime
    && spawnTime !== 'undefined'
    && spawnTime !== 'null'
  ) ? spawnTime : null;
  let displayName = bossName;

  if (isRealBoss && validSpawnTime) {
    displayName = `[${validSpawnTime}] ${bossName}`;
    if (offset > 0) {
      displayName += ` <span class="text-xs text-slate-500 font-medium ml-1">${offset}분 전</span>`;
    }
  }

  return {
    isRealBoss,
    validSpawnTime,
    displayName,
    iconName: isRealBoss ? 'skull' : 'bell-ring',
    iconColor: isRealBoss ? 'text-[#a855f7]' : 'text-amber-400',
  };
};

window.getScamToastPresentation = function (result: {
  verdict: string;
  analysisReason?: string;
  detectedScamTypes?: string;
}): ScamToastPresentation {
  const isScam = result.verdict === 'SCAM';
  const rawReason = result.analysisReason?.split('\n')[0]?.trim()
    || result.detectedScamTypes
    || '';

  return {
    isScam,
    title: isScam ? '🚨 사기 위험 감지!' : '⚠️ 사기 의심 감지',
    colorClass: isScam ? 'text-red-400' : 'text-yellow-400',
    reason: window.escapeHtmlText(rawReason),
  };
};

/** 여러 interactive 토스트의 수명을 ID로 추적해 마지막 토스트 종료 시점을 정확히 알립니다. */
window.createInteractiveToastRegistry = function (
  onCountChanged: (count: number) => void,
): InteractiveToastRegistry {
  const ids = new Set<string>();
  return {
    add(id: string): void {
      const previousSize = ids.size;
      ids.add(id);
      if (ids.size !== previousSize) onCountChanged(ids.size);
    },
    remove(id: string): void {
      if (!ids.delete(id)) return;
      onCountChanged(ids.size);
    },
    count(): number {
      return ids.size;
    },
  };
};

// 채팅 로그 경로가 유효하지 않을 때 모든 렌더러에서 공통으로 표시하는 경고 배너
window.showChatLogWarningBanner = function (
  options: { variant?: 'overlay' } = {},
): void {
  if (document.getElementById('chatlog-warning-banner')) return;
  const isOverlay = options.variant === 'overlay';
  const banner = document.createElement('div');
  banner.id = 'chatlog-warning-banner';
  banner.className = `w-full ${isOverlay ? 'bg-amber-950/95' : 'bg-amber-500/10'} border-b border-amber-500/30 px-4 py-2 flex items-center justify-between text-xs text-amber-200 z-[9999] shrink-0`;
  banner.style.cssText = 'position: relative; top: 0; left: 0;';
  banner.innerHTML = `
    <div class="flex items-center gap-2">
      <i data-lucide="alert-triangle" class="w-3.5 h-3.5 text-amber-400"></i>
      <span>${isOverlay
        ? '채팅로그 폴더가 올바르게 설정되지 않았습니다.'
        : '채팅로그 폴더가 올바르게 설정되지 않아 실시간 감지가 동작하지 않습니다.'}</span>
    </div>
    <button onclick="window.electronAPI.toggleSettings('chatlog')"
      class="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded font-bold transition-all active:scale-95 text-xs shrink-0">
      설정으로 이동
    </button>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
  if (typeof window.refreshIcons === 'function') window.refreshIcons();
};

// 채팅 로그 경로 상태 확인과 변경 이벤트 연결
window.bindChatLogStatusWarning = function (
  options: { variant?: 'overlay' } = {},
): void {
  const api = getElectronApi();
  if (!api || !api.checkChatLogStatus) return;
  if (window.__twChatLogStatusWarningBound) return;
  window.__twChatLogStatusWarningBound = true;

  api.checkChatLogStatus().then((isValid: boolean) => {
    if (!isValid) {
      window.showChatLogWarningBanner(options);
    }
  });

  if (api.onChatLogStatusChanged) {
    api.onChatLogStatusChanged((isValid: boolean) => {
      if (isValid) {
        const banner = document.getElementById('chatlog-warning-banner');
        if (banner) banner.remove();
      } else {
        window.showChatLogWarningBanner(options);
      }
    });
  }
};
})();
