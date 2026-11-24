interface Window {
  bindBossDiaryToast(toast:HTMLElement,bossName:string,spawnTime:string,onSaved?:() => void,dismiss?:() => void):void;
  isToastInUse(toast:HTMLElement):boolean;
}

(() => {
  const api=window.electronAPI as typeof window.electronAPI & import('../shared/diaryProfiles').DiaryManualRecordsApi;
  /**
   * 기능 계약: 사이드바 토스트의 자동 닫기 보류 조건.
   * 기록 저장 중이거나, 사이드바 창이 실제로 포커스를 가진 채 토스트 안의 컨트롤(기록할 프로필 선택 등)을
   * 사용 중일 때만 "사용 중"으로 본다. 선택 후 게임 화면을 클릭해 창이 포커스를 잃으면 activeElement가
   * 그대로 남아도 사용 중이 아니므로 다음 만료 확인에서 닫힌다. 토스트 만료(index.html)와 기록 완료 후
   * 자동 닫기가 같은 판정을 쓴다. 회귀: scripts/check-renderer-behavior.ts
   */
  window.isToastInUse=toast => toast.dataset.saving==='true' || document.hasFocus() && toast.contains(document.activeElement);
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
    const target=window.diaryProfiles.target(container,{compact:true,draftScope:null,onChange:reset});
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
      try {
        const {profileId,duplicate}=await target.record(async id => {
          const rowId=await api.diaryAddActivity(date,time,'boss',content,undefined,id);
          if (Number.isSafeInteger(rowId)) return {profileId:id,duplicate:false};
          const data=await api.diaryGetByDate(date,id ? {kind:'profile',profileId:id} : undefined);
          if (!data?.activityLogs.some(row => row.type==='boss' && row.content===content)) throw new Error('Save failed');
          return {profileId:id,duplicate:true};
        });
        button!.textContent=duplicate ? '이미 기록됨!' : '기록 완료!';
        if (!duplicate) onSaved?.();
        target.error(profileId ? `${window.diaryProfiles.label(profileId)}에 기록되어 있습니다.` : '');
        setTimeout(() => {
          // 저장하는 동안 사용 프로필이 바뀌어 대상이 따라갔으면 새 대상으로 다시 기록할 수 있게 버튼을 되돌린다.
          if (target.value()!==profileId) {reset();return;}
          if (!window.isToastInUse(toast)) dismiss?.();
        },duplicate ? 1500 : 1000);
      } catch {
        button!.disabled=false;button!.textContent='기록 실패 · 다시 시도';
        target.error('저장하지 못했습니다. 대상 프로필을 확인하고 다시 시도해 주세요.');
      } finally {
        toast.dataset.saving='false';
      }
    }
  };
})();
