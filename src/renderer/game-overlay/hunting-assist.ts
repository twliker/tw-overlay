/** 절대 종료 시각으로 입장 안내를 갱신한다. 게임을 가리는 별도 창은 만들지 않는다. */
(() => {
  type Entry = import('../../shared/types').BossEntryWindow;
  type Warning = import('../../shared/types').XpEfficiencyWarning;
  type Stats = import('../../shared/types').XpStats;
  const api = window.electronAPI as typeof window.electronAPI & {
    getBossEntryWindows(): Promise<Entry[]>;
    onBossEntryUpdate(callback: (entries: Entry[]) => void): void;
    onXpEfficiencyAlert(callback: (warning: Warning) => void): void;
  };
  let entries: Entry[] = [];
  let generation = 0;
  let alertUntil = 0;
  const list = document.getElementById('boss-entry-list');
  const alert = document.getElementById('xp-efficiency-alert');

  function renderEntries(): void {
    if (!list) return;
    const now = Date.now();
    const active = entries.filter(entry => entry.opensAt <= now && now < entry.closesAt);
    const keep = new Set(active.map(entry => entry.id));
    for (const child of Array.from(list.children)) {
      if (!keep.has((child as HTMLElement).dataset.entryId || '')) child.remove();
    }
    for (const entry of active) {
      let card = Array.from(list.children).find(child => (child as HTMLElement).dataset.entryId === entry.id) as HTMLElement | undefined;
      if (!card) {
        card = document.createElement('section');
        card.className = 'hunting-assist-card ui-hud-card';
        card.dataset.uiAccent = 'boss';
        card.dataset.entryId = entry.id;
        const name = document.createElement('div');
        name.className = 'hunting-assist-label';
        name.textContent = entry.name;
        const time = document.createElement('div');
        time.className = 'boss-entry-time';
        const bar = document.createElement('div');
        bar.className = 'boss-entry-track';
        bar.appendChild(document.createElement('span'));
        card.append(name, time, bar);
        list.appendChild(card);
      }
      const seconds = Math.ceil((entry.closesAt - now) / 1000);
      card.classList.toggle('urgent', seconds <= 60);
      card.querySelector('.boss-entry-time')!.textContent = `입장 마감까지 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      (card.querySelector('.boss-entry-track span') as HTMLElement).style.width = `${Math.max(0, Math.min(100, (entry.closesAt - now) / (entry.closesAt - entry.opensAt) * 100))}%`;
    }
    if (alert && Date.now() >= alertUntil) alert.hidden = true;
  }

  api.onBossEntryUpdate(next => { generation++; entries = next; renderEntries(); });
  const requestGeneration = generation;
  void api.getBossEntryWindows().then(next => {
    if (generation !== requestGeneration) return;
    entries = next;
    renderEntries();
  }).catch(error => console.error('입장 마감 안내를 불러오지 못했습니다.', error));
  api.onXpEfficiencyAlert(warning => {
    if (!alert) return;
    alertUntil = warning.at + 12_000;
    document.getElementById('xp-efficiency-alert-comparison')!.textContent = `평균 ${warning.average.toLocaleString()} → 현재 ${warning.current.toLocaleString()} (${warning.dropPercent}% 감소)`;
    alert.hidden = Date.now() >= alertUntil;
  });
  const timer = setInterval(renderEntries, 1000);
  window.addEventListener('unload', () => clearInterval(timer), { once: true });

  const host = window as typeof window & { huntingAssist?: { updateXp(data: Stats): void; updateConfig(config: BrowserAppConfig): void } };
  host.huntingAssist = {
    updateConfig(config) {
      if (config.xpEfficiencyAlertEnabled === false && alert) { alert.hidden = true; alertUntil = 0; }
    },
    updateXp(data) {
      const label = document.getElementById('xp-activity-label');
      if (label) {
        label.textContent = data.pauseReason === 'idle' ? '자동 휴식 · 획득 시 재개' : !data.isActive ? '수동 정지' : data.efficiency?.status === 'warming' ? '측정 중 · 사냥 기준 준비' : '측정 중';
        label.dataset.paused = data.pauseReason || '';
      }
      if (data.efficiency?.status !== 'low' && alert) { alert.hidden = true; alertUntil = 0; }
    },
  };
})();
