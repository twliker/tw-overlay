interface Window {
  bindBossDiaryToast(toast:HTMLElement,bossName:string,spawnTime:string,onSaved?:() => void,dismiss?:() => void):void;
}

(() => {
  const api=window.electronAPI as typeof window.electronAPI & import('../shared/diaryProfiles').DiaryManualRecordsApi;
  // 토스트의 과거 '이미 기록됨' 값은 당시 프로필의 값이다. 수동 기록은 화면의
  // 명시적 대상을 고정하고 SQLite의 프로필별 중복 검사 결과로 완료를 판정한다.
  window.bindBossDiaryToast=(toast,bossName,spawnTime,onSaved,dismiss) => {
    const container=toast.querySelector<HTMLElement>('[data-boss-record-profile]');
    const button=toast.querySelector<HTMLButtonElement>('[data-boss-record-button]');
    if (!container || !button) return;
    const originalDisabled=button.disabled;
    const reset=() => {
      if (toast.dataset.saving==='true') return;
      if (!window.diaryProfiles.state().enabled && originalDisabled) return;
      button.disabled=false;button.textContent='일지 기록';
      button.className='ui-button';
    };
    const target=window.diaryProfiles.target(container,{compact:true,onChange:reset});
    void window.diaryProfiles.ready.then(reset);
    button.addEventListener('click',event => {
      event.stopPropagation();
      void record();
    });
    async function record():Promise<void> {
      if (toast.dataset.saving==='true') return;
      const now=new Date();
      const date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const time=spawnTime ? `${spawnTime}:00` : `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      const content=`[${bossName}] ${spawnTime || time.slice(0,5)} 스폰 처치 완료`;
      toast.dataset.saving='true';button!.disabled=true;button!.textContent='기록 중...';
      const captured=target.capture();target.lock(true);
      try {
        const profileId=await captured;
        const rowId=await api.diaryAddActivity(date,time,'boss',content,undefined,profileId);
        let duplicate=false;
        if (!Number.isSafeInteger(rowId)) {
          const data=await api.diaryGetByDate(date,profileId ? {kind:'profile',profileId} : undefined);
          duplicate=!!data?.activityLogs.some(row => row.type==='boss' && row.content===content);
          if (!duplicate) throw new Error('Save failed');
        }
        button!.textContent=duplicate ? '이미 기록됨!' : '기록 완료!';
        if (!duplicate) onSaved?.();
        target.error(profileId ? `${window.diaryProfiles.label(profileId)}에 기록되어 있습니다.` : '');
        setTimeout(() => {
          if (target.value()===profileId && toast.dataset.saving!=='true' && !toast.contains(document.activeElement)) dismiss?.();
        },duplicate ? 1500 : 1000);
      } catch {
        button!.disabled=false;button!.textContent='기록 실패 · 다시 시도';
        target.error('저장하지 못했습니다. 대상 프로필을 확인하고 다시 시도해 주세요.');
      } finally {
        toast.dataset.saving='false';target.lock(false);
      }
    }
  };
})();
