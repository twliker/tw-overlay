interface Window { settingsProfileCloudSync:{render(status:import('../../shared/types').GoogleSyncStatus):boolean}; }
(() => {
  const api=window.electronAPI as unknown as import('../../shared/profileSync').ProfileSyncApi;
  let profileMode=false,busy=false;
  let resolvingReview=false,connectionGeneration=0;
  let setupMethod:'merge' | 'remote' | undefined;
  let setupAccount:string | undefined;
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls='')=>{
    const node=document.createElement(tag);if(text!==undefined) node.textContent=text;node.className=cls;return node;
  };
  const button=(label:string,action:()=>Promise<unknown>,primary=false,reviewPanel?:HTMLElement,canCancelCheck=false)=>{
    const node=el('button',label,primary ? 'ui-button ui-button-primary' : 'ui-button');node.type='button';node.disabled=busy && !canCancelCheck;
    node.addEventListener('click',async()=>{
      if (busy) {
        if (!canCancelCheck || node.disabled) return;
        node.disabled=true;connectionGeneration++;
        try {await action();}
        catch(error) {
          const feedback=document.getElementById('profile-sync-feedback');
          if (feedback) feedback.textContent=error instanceof Error ? error.message : String(error);
        } finally {await refresh();}
        return;
      }
      busy=true;node.disabled=true;
      const generation=connectionGeneration;
      const message=document.getElementById('profile-sync-feedback');
      const reviewActions=reviewPanel?.parentElement?.querySelector('fieldset');
      const reviewButtons=reviewPanel?.closest('#profile-sync-reviews')?.querySelectorAll<HTMLButtonElement>('button');
      if(reviewPanel) {
        resolvingReview=true;
        reviewButtons?.forEach(button=>{button.disabled=true;});
        reviewActions?.setAttribute('aria-busy','true');
        node.textContent='적용 중…';
        const spinner=el('span',undefined,'size-4 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin');
        spinner.setAttribute('aria-hidden','true');
        reviewPanel.replaceChildren(spinner,el('span','선택한 값을 적용하고 있습니다…'));
      }
      if(message) message.textContent='';
      try {
        const result=await action() as {success?:boolean;error?:string;message?:string} | undefined;
        if(result?.success===false) throw new Error(result.error || '요청을 완료하지 못했습니다.');
        reviewPanel?.replaceChildren();
        if(message && generation===connectionGeneration) message.textContent=result?.message ?? '적용했습니다.';
      } catch(error) {
        const errorText=error instanceof Error ? error.message : String(error);
        if(reviewPanel) reviewPanel.textContent=errorText;
        else if(message && generation===connectionGeneration) message.textContent=errorText;
      } finally {
        busy=false;resolvingReview=false;node.disabled=false;
        if(reviewPanel) {
          node.textContent=label;
          reviewActions?.removeAttribute('aria-busy');
          reviewButtons?.forEach(button=>{button.disabled=false;});
        }
        await refresh();
      }
    });return node;
  };
  async function refresh():Promise<void> {const status=await api.googleSyncGetStatus();if(status) renderProfile(status);}
  function renderProfile(status:import('../../shared/types').GoogleSyncStatus):void {
    const data=status.profileSync,card=document.getElementById('google-sync-card');if(!data || !card) return;
    if(!profileMode) {
      card.replaceChildren();profileMode=true;
      card.style.scrollMarginTop='88px';
      const header=el('div',undefined,'grid gap-2');header.append(el('h3','Google 동기화','text-white text-sm font-bold'),
        el('p','프로필·숙제·프로필 설정과 공통 알림 설정을 다른 PC에서 이어서 사용합니다.','ui-description'),
        el('p','모험일지·채팅 로그·창 배치·로그 경로는 이 PC에만 보관합니다.','ui-description'));
      const steps=el('ol',undefined,'flex flex-wrap gap-2');steps.id='profile-sync-steps';
      header.append(steps);
      steps.setAttribute('aria-label','Google 동기화 설정 단계');
      for(const label of ['1. Google 로그인','2. 동기화 설정','3. 설정 완료']) steps.append(el('li',label,'ui-chip'));
      const state=el('p',undefined,'ui-status');state.id='profile-sync-state';state.setAttribute('role','status');
      const account=el('p',undefined,'ui-description');account.id='profile-sync-account';
      const actions=el('div',undefined,'flex flex-wrap gap-3');actions.id='profile-sync-actions';
      const choice=el('div',undefined,'ui-inset space-y-3');choice.id='profile-sync-choice';
      const capacity=el('div',undefined,'space-y-2');capacity.id='profile-sync-capacity';
      const review=el('div',undefined,'space-y-3');review.id='profile-sync-reviews';
      const feedback=el('p',undefined,'ui-status');feedback.id='profile-sync-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
      card.append(header,state,account,actions,choice,capacity,review,feedback);
    }
    const state=document.getElementById('profile-sync-state')!,account=document.getElementById('profile-sync-account')!;
    const settingUp=data.connection==='checking' || data.connection==='choice';
    const steps=document.getElementById('profile-sync-steps')!;
    steps.hidden=data.connection==='ready';
    Array.from(steps.children).forEach((step,index)=>{
      if(!steps.hidden && index===(settingUp ? 1 : 0)) step.setAttribute('aria-current','step');
      else step.removeAttribute('aria-current');
    });
    state.className=settingUp ? 'text-sm text-white font-semibold' : 'ui-status';
    const stateText=status.reauthRequired ? '다시 로그인 필요 · 이 PC의 변경은 보관 중입니다.'
      : settingUp ? 'Google 로그인 완료 · 동기화 설정이 필요합니다'
        : data.connection==='disconnected' ? status.isLinked ? 'Google 로그인 유지 중 · 동기화 설정 일시 중지' : '이 PC에 저장 중 · Google 동기화 꺼짐'
          : status.isSyncing ? 'Google 변경을 확인하고 동기화하고 있습니다…'
            : status.error ? `${status.error} · 저장된 변경은 다음에 다시 전송합니다.`
              : data.uploadBlocked ? '이 PC의 Google 파일을 읽을 수 없어 전송이 보류됐습니다. 변경은 이 PC에 보관됩니다.'
              : data.damagedFiles ? `읽을 수 없는 Google 파일 ${data.damagedFiles}개 · 해당 파일의 기록은 보관됩니다.`
              : data.remoteDeferred ? data.remoteDeferred
              : data.reviews.length ? `확인할 변경 ${data.reviews.length}개 · 다른 항목은 정상 동기화됩니다.`
              : data.pending ? `이 PC 저장 완료 · 전송 대기 ${data.pending}건`
              : data.uploadSizing?.deferredTools ? `동기화 일부 보류 · 계산기 값 ${data.uploadSizing.deferredTools}개`
              : data.uploadSizing?.heldCells ? `동기화 일부 보류 · 형식을 확인할 수 없는 설정 ${data.uploadSizing.heldCells}개`
              : data.lastCheckedAt ? '동기화 완료' : '동기화 설정 완료';
    if(state.textContent!==stateText) state.textContent=stateText;
    const accountDetails=[status.email || 'Google 계정을 연결해 주세요.'];
    if (data.connection==='ready') {
      if (data.lastCheckedAt) accountDetails.push(`마지막 확인 ${new Date(data.lastCheckedAt).toLocaleString()}`);
      accountDetails.push(data.lastUploadedAt ? `마지막 전송 ${new Date(data.lastUploadedAt).toLocaleString()}` : '마지막 전송 시각 미기록');
    }
    account.textContent=accountDetails.join(' · ');
    const actions=document.getElementById('profile-sync-actions')!;
    const actionSignature=JSON.stringify([status.isLinked,data.connection,status.reauthRequired,status.autoSync,data.backupAvailable,busy,
      data.connection==='checking' && status.isSyncing]);
    if(actions.dataset.signature!==actionSignature) {
    actions.dataset.signature=actionSignature;actions.replaceChildren();
    // "나중에 설정"으로 끈 경우 로그인은 유지되어 있다. 브라우저 로그인 없이 다시 켜고 첫 연결 선택을 다시 보여 준다.
    // 회귀: check-profile-sync-ui.ts(나중에 설정 뒤 동기화 다시 켜기).
    if(status.isLinked && data.connection==='disconnected') actions.append(button('동기화 다시 켜기',()=>api.googleSyncResume(),true));
    else if(!status.isLinked || data.connection==='disconnected') actions.append(button(status.reauthRequired ? '다시 로그인' : 'Google 계정으로 연결',async()=>{
      const cancel=el('button','로그인 취소','ui-button');cancel.type='button';cancel.addEventListener('click',()=>{cancel.disabled=true;void api.googleSyncCancelLogin();});actions.append(cancel);
      try {
        const result=await api.googleSyncLogin();
        return {...result,message:result.status.profileSync?.connection==='ready' ? 'Google에 다시 연결했습니다.' : ''};
      } finally {cancel.remove();}
    },true));
    else if(data.connection==='checking' && !status.isSyncing) {
      actions.append(button('Google 데이터 다시 확인',()=>api.googleSyncBackup(),true));
    } else if(data.connection==='ready') {
      actions.append(button('지금 동기화',()=>api.googleSyncBackup(),true));
      const label=el('label',undefined,'ui-description flex items-center gap-2');const toggle=el('input');toggle.type='checkbox';toggle.checked=status.autoSync!==false;toggle.disabled=busy;
      toggle.addEventListener('change',async()=>{
        const requested=toggle.checked;
        const feedback=document.getElementById('profile-sync-feedback')!;
        toggle.disabled=true;feedback.textContent='';
        try {
          const saved=await api.googleSyncToggleAuto(requested);
          if (!toggle.isConnected) return;
          toggle.checked=saved.autoSync!==false;
          if (toggle.checked!==requested) feedback.textContent=saved.error || '자동 동기화 설정을 저장하지 못했습니다.';
          renderProfile(saved);
        } catch {
          if (!toggle.isConnected) return;
          toggle.checked=!requested;
          feedback.textContent='자동 동기화 설정을 확인하지 못했습니다. 다시 시도해 주세요.';
          try {await refresh();} catch { /* 저장 상태를 다시 읽을 수 없어 이전 표시를 유지한다. */ }
        } finally {toggle.disabled=false;}
      });
      const control=el('span',undefined,'ui-switch');control.append(toggle,el('span',undefined,'ui-switch-track'));
      label.append(control,document.createTextNode('자동 동기화'));actions.append(label);
    }
    if(status.isLinked) actions.append(button('연결 해제',()=>api.googleSyncLogout(),false,undefined,data.connection==='checking'));
    if(data.connection==='ready' && data.backupAvailable) actions.append(button('적용 전 백업 위치',()=>api.googleSyncShowBackup()));
    }
    actions.hidden=actions.childElementCount===0;
    const choice=document.getElementById('profile-sync-choice')!;choice.hidden=data.connection!=='choice';
    if(data.connection!=='choice' || setupAccount!==status.email) {setupMethod=undefined;setupAccount=status.email;}
    const choiceSignature=JSON.stringify([data.connection,status.email,data.remoteProfiles,data.remoteIdentityConflicts,data.damagedFiles,data.localProfileCount,busy,status.isSyncing && data.connection==='choice']);
    if(choice.dataset.signature!==choiceSignature) {
    choice.dataset.signature=choiceSignature;choice.replaceChildren();
    if(data.connection==='choice') {
      const remote=data.remoteProfiles || [];
      const conflicts=data.remoteIdentityConflicts ?? 0;
      const replacementBlocked=Boolean(conflicts || data.damagedFiles);
      if (replacementBlocked && setupMethod==='remote') setupMethod=undefined;
      const hasRemote=remote.length>0 || replacementBlocked;
      const applying=busy || status.isSyncing===true;
      const localCount=data.localProfileCount || 0;
      choice.append(el('h4','사용할 데이터 선택','text-sm text-white font-semibold'),
        el('p',`이 PC 프로필 ${localCount}개 · 가져올 수 있는 Google 프로필 ${remote.length}개`,'ui-description'));
      if (conflicts) choice.append(el('p',`이름 또는 서버를 확인할 Google 프로필 ${conflicts}개가 있습니다. 양쪽 병합 후 확인할 변경에서 값을 선택해 주세요.`,'ui-description'));
      if (data.damagedFiles) choice.append(el('p',`읽을 수 없는 Google 파일 ${data.damagedFiles}개가 있어 이 PC의 데이터를 교체할 수 없습니다. 읽을 수 있는 데이터는 병합할 수 있습니다.`,'ui-description'));
      const controls=el('div',undefined,'flex flex-wrap gap-3');
      const start=button(applying ? '설정 적용 중…' : '동기화 시작',()=>{
        const method=hasRemote ? setupMethod : 'merge';
        if(!method) throw new Error('사용할 데이터를 선택해 주세요.');
        return api.googleSyncConnectChoice(method);
      },true);
      start.id='profile-sync-apply-choice';
      start.disabled=applying || (hasRemote && !setupMethod);
      const later=button('나중에 설정',()=>api.googleSyncConnectChoice('local'));
      later.disabled=applying;
      controls.append(start,later);
      if (replacementBlocked) {
        const recheck=button('Google 데이터 다시 확인',()=>api.googleSyncBackup());
        recheck.disabled=applying;
        controls.append(recheck);
      }

      if(hasRemote) {
        const list=el('ul',undefined,'ui-description max-h-28 overflow-auto custom-scroll');
        list.setAttribute('aria-label','Google 프로필');
        for(const profile of remote) list.append(el('li',`${profile.name} · ${profile.server===7 ? '하이아칸' : '네냐플'}`,'break-words'));
        if (remote.length) choice.append(list);
        const methods=el('fieldset',undefined,'space-y-2');
        methods.disabled=applying;
        methods.append(el('legend','데이터 적용 방법','ui-description'));
        const addMethod=(value:'merge' | 'remote',title:string,description:string)=>{
          const label=el('label',undefined,'ui-filter-choice');
          const input=el('input');input.type='radio';input.name='profile-sync-initial-method';input.value=value;
          input.setAttribute('data-settings-transient','');
          input.checked=setupMethod===value;
          const text=el('span',undefined,'min-w-0');
          text.append(el('strong',title,'text-white text-sm'),el('span',description,'block ui-description'));
          input.addEventListener('change',()=>{setupMethod=value;start.disabled=applying;});
          label.append(input,text);methods.append(label);
        };
        addMethod('merge','양쪽 병합 (추천)','이 PC와 Google의 프로필을 함께 보관합니다. 이름이 같은 별도 프로필도 각각 유지합니다.');
        if (!replacementBlocked) addMethod('remote','Google 데이터로 가져오기','이 PC의 프로필·숙제·설정을 백업한 뒤 Google 데이터로 교체합니다. 모험일지는 이 PC에 보관됩니다.');
        choice.append(methods);
      } else {
        choice.append(el('p',localCount
          ? 'Google에 가져올 프로필이 없습니다. 동기화를 시작하면 이 PC의 프로필과 숙제를 Google에 저장합니다.'
          : 'Google에 가져올 프로필이 없습니다. 동기화 설정을 마친 뒤 프로필을 만들면 Google에 저장됩니다.','ui-description'));
      }
      choice.append(controls);
    }
    }
    if(data.connection==='checking') {
      choice.hidden=false;
      const hint=status.error || 'Google에 저장된 데이터를 확인하고 있습니다…';
      if(choice.textContent!==hint) choice.replaceChildren(el('p',hint,'ui-description'));
    }
    const reviews=document.getElementById('profile-sync-reviews')!;
    reviews.hidden=data.connection!=='ready';
    const capacity=document.getElementById('profile-sync-capacity')!;
    const sizing=data.uploadSizing;
    capacity.hidden=reviews.hidden || !sizing?.deferredTools && !sizing?.heldCells && !data.oversizedToolValues;
    const capacitySignature=JSON.stringify([sizing,data.oversizedToolValues]);
    if (capacity.dataset.signature!==capacitySignature) {
      capacity.dataset.signature=capacitySignature;
      capacity.replaceChildren();
      if (sizing?.deferredTools) {
        const mib=(bytes:number)=>(bytes/1048576).toFixed(1);
        capacity.append(el('p',`압축 전 JSON ${mib(sizing.uploadBytes)} MiB 전송 · 전체 ${mib(sizing.fullBytes)} MiB. 이번 전송에 들어가지 못한 계산기 값 ${sizing.deferredTools}개는 이 PC에 보관됩니다.`,'ui-description'));
        if (sizing.deferredLabels?.length) capacity.append(el('p',sizing.deferredLabels.join(' / '),'ui-description break-words'));
      }
      // 형식 검증에 실패한 값은 다른 PC를 보호하려고 전송하지 않는다(나머지는 정상 동기화). 회귀: check-profile-sync-ui.ts
      if (sizing?.heldCells) {
        capacity.append(el('p',`형식을 확인할 수 없는 설정 ${sizing.heldCells}개는 이 PC에만 보관하고 나머지를 동기화했습니다. 해당 설정을 다시 저장하면 전송됩니다.`,'ui-description'));
        if (sizing.heldLabels?.length) capacity.append(el('p',sizing.heldLabels.join(' / '),'ui-description break-words'));
      }
      if (data.oversizedToolValues) capacity.append(el('p',`저장 한도를 초과한 계산기 프리셋 ${data.oversizedToolValues}개는 이 PC에 보관 중입니다. 프리셋을 줄여 저장하면 동기화됩니다.`,'ui-description'));
    }
    if(resolvingReview) return;
    // 갱신 때 후보 카드 DOM을 보존하여 키보드 포커스와 스크롤이 튀지 않게 한다.
    const signature=JSON.stringify([data.reviews,busy]);if(reviews.dataset.signature===signature) return;
    reviews.dataset.signature=signature;reviews.replaceChildren();
    if(data.reviews.length) reviews.append(el('h4','확인할 변경','text-sm text-white font-semibold'),el('p','수정 순서가 불확실한 값은 양쪽을 보관합니다. 플레이 중 프로필의 이름·서버·삭제는 확인 후 반영하며 다시 선택하게 됩니다.','ui-description'));
    const display=(value:unknown,key:string):string=>{
      if(key.endsWith(',"userServer"]')) return value===7 ? '하이아칸' : value===16 ? '네냐플' : '서버 미설정';
      if(key.endsWith(',"deleted"]')) return value===true ? '프로필 삭제' : '프로필 유지';
      if(value===null) return '설정 없음';
      if(typeof value==='boolean') return value ? '사용 / 예' : '사용 안 함 / 아니요';
      if(typeof value==='string') return value.length>180 ? value.slice(0,180)+'…' : value;
      if(Array.isArray(value)) return value.every(v=>typeof v==='number') ? value.join(', ') : `${value.length}개 항목`;
      if(typeof value==='object' && value && 'state' in value) {
        const state=(value as {state:{currentCount?:number;isCompleted?:boolean}}).state;
        return `${state.currentCount || 0}회${state.isCompleted ? ' · 완료' : ''}`;
      }
      return typeof value==='number' ? String(value) : '저장된 설정값';
    };
    for(const review of data.reviews) {
      const section=el('div',undefined,'ui-inset space-y-2');section.dataset.syncReviewKey=review.key;
      section.append(el('p',review.label,'text-sm text-white font-semibold'),el('p',`이 PC에서 사용 중: ${display(review.current,review.key)}`,'ui-description break-words'));
      if (review.reason==='pending-records') {
        section.append(el('p','이 프로필에 저장할 자동 기록이 남아 삭제를 보류했습니다. 프로필 관리에서 기록을 먼저 처리해 주세요.','ui-description'));
        reviews.append(section);
        continue;
      }
      if (review.reason==='settings-profile') {
        section.append(el('p','환경설정에 표시된 프로필에 삭제 요청이 왔습니다. 작성 중인 설정을 저장하거나 닫은 뒤 삭제를 적용해 주세요.','ui-description'));
      }
      const panel=el('div',undefined,'ui-inset flex items-center gap-2 text-sm font-semibold text-slate-300');
      panel.dataset.syncReviewProgress='';panel.setAttribute('role','status');
      const buttons=el('fieldset',undefined,'flex min-w-0 flex-wrap gap-2');
      buttons.setAttribute('aria-label','변경 적용');
      const resolve=(label:string,candidate:string)=>button(label,()=>api.googleSyncResolve(review.key,candidate),false,panel);
      if(!review.key.endsWith(',"deleted"]')) buttons.append(resolve('이 PC 값 유지','local'));
      for(const candidate of review.candidates) {
        const row=el('div',undefined,'ui-inset space-y-2');
        row.append(el('p',display(candidate.value,review.key),'ui-description break-words'),el('p',new Date(candidate.changedAt).toLocaleString(),'ui-description'),resolve('이 값 사용',candidate.id));
        if(candidate.value && typeof candidate.value==='object' || typeof candidate.value==='string' && candidate.value.length>180) {
          const detail=el('details'),summary=el('summary','내용 자세히 보기','ui-description cursor-pointer'),content=el('pre',typeof candidate.value==='string' ? candidate.value : JSON.stringify(candidate.value,null,2),'ui-description whitespace-pre-wrap break-words max-h-40 overflow-auto custom-scroll');detail.append(summary,content);row.append(detail);
        }
        buttons.append(row);
      }
      section.append(panel,buttons);reviews.append(section);
    }
  }
  window.settingsProfileCloudSync={render(status){if(!status.profileSync)return false;renderProfile(status);return true;}};
})();
