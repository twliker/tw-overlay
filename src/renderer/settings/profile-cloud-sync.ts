interface Window { settingsProfileCloudSync:{render(status:import('../../shared/types').GoogleSyncStatus):boolean}; }
(() => {
  const api=window.electronAPI as unknown as import('../../shared/profileSync').ProfileSyncApi;
  let profileMode=false,busy=false;
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls='')=>{
    const node=document.createElement(tag);if(text!==undefined) node.textContent=text;node.className=cls;return node;
  };
  const button=(label:string,action:()=>Promise<unknown>,primary=false)=>{
    const node=el('button',label,primary ? 'ui-button ui-button-primary' : 'ui-button');node.type='button';node.disabled=busy;
    node.addEventListener('click',async()=>{
      if(busy) return;busy=true;node.disabled=true;
      const message=document.getElementById('profile-sync-feedback');
      try {
        const result=await action() as {success?:boolean;error?:string;message?:string} | undefined;
        if(result?.success===false) throw new Error(result.error || '요청을 완료하지 못했습니다.');
        if(message) message.textContent=result?.message || '적용했습니다.';
      } catch(error) {if(message) message.textContent=error instanceof Error ? error.message : String(error);}
      finally {busy=false;node.disabled=false;await refresh();}
    });return node;
  };
  async function refresh():Promise<void> {const status=await api.googleSyncGetStatus();if(status) renderProfile(status);}
  function renderProfile(status:import('../../shared/types').GoogleSyncStatus):void {
    const data=status.profileSync,card=document.getElementById('google-sync-card');if(!data || !card) return;
    if(!profileMode) {
      card.replaceChildren();profileMode=true;
      card.style.scrollMarginTop='88px';
      const header=el('div',undefined,'space-y-2');header.append(el('h3','Google 동기화','text-white text-sm font-bold'),
        el('p','프로필·숙제·프로필 설정과 공통 알림 설정을 다른 PC에서 이어서 사용합니다.','ui-description'),
        el('p','모험일지·채팅 로그·창 배치·로그 경로는 이 PC에만 보관합니다.','ui-description'));
      const state=el('p',undefined,'ui-status');state.id='profile-sync-state';state.setAttribute('role','status');
      const account=el('p',undefined,'ui-description');account.id='profile-sync-account';
      const actions=el('div',undefined,'flex flex-wrap gap-3');actions.id='profile-sync-actions';
      const choice=el('div',undefined,'ui-inset space-y-3');choice.id='profile-sync-choice';
      const review=el('div',undefined,'space-y-3');review.id='profile-sync-reviews';
      const feedback=el('p',undefined,'ui-status');feedback.id='profile-sync-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
      card.append(header,state,account,actions,choice,review,feedback);
    }
    const state=document.getElementById('profile-sync-state')!,account=document.getElementById('profile-sync-account')!;
    state.textContent=status.reauthRequired ? '다시 로그인 필요 · 이 PC의 변경은 보관 중입니다.' : status.isSyncing ? 'Google 변경을 확인하고 동기화하고 있습니다…'
      : data.connection==='choice' ? '첫 연결 · 사용할 데이터를 선택해 주세요.' : data.connection==='disconnected' ? '이 PC에 저장 중 · Google 동기화 꺼짐'
        : status.error ? `${status.error} · 저장된 변경은 다음에 다시 전송합니다.` : data.reviews.length ? `확인할 변경 ${data.reviews.length}개 · 다른 항목은 정상 동기화됩니다.`
          : data.pending ? `이 PC 저장 완료 · 전송 대기 ${data.pending}건` : '동기화 완료';
    account.textContent=`${status.email || 'Google 계정을 연결해 주세요.'}${status.lastSyncedAt ? ` · 마지막 완료 ${new Date(status.lastSyncedAt).toLocaleString()}` : ''}`;
    const actions=document.getElementById('profile-sync-actions')!;
    const actionSignature=JSON.stringify([status.isLinked,data.connection,status.reauthRequired,status.autoSync,data.backupAvailable,busy]);
    if(actions.dataset.signature!==actionSignature) {
    actions.dataset.signature=actionSignature;actions.replaceChildren();
    if(!status.isLinked || data.connection==='disconnected') actions.append(button(status.reauthRequired ? '다시 로그인' : 'Google 계정으로 연결',async()=>{
      const cancel=el('button','로그인 취소','ui-button');cancel.type='button';cancel.addEventListener('click',()=>{cancel.disabled=true;void api.googleSyncCancelLogin();});actions.append(cancel);
      try {return await api.googleSyncLogin();} finally {cancel.remove();}
    },true));
    else {
      actions.append(button('지금 동기화',()=>api.googleSyncBackup(),true),button('연결 해제',()=>api.googleSyncLogout()));
      const label=el('label',undefined,'ui-description flex items-center gap-2');const toggle=el('input');toggle.type='checkbox';toggle.checked=status.autoSync!==false;toggle.disabled=busy;
      toggle.addEventListener('change',async()=>{toggle.disabled=true;try{await api.googleSyncToggleAuto(toggle.checked);await refresh();}finally{toggle.disabled=false;}});
      label.append(toggle,document.createTextNode('자동 동기화'));actions.append(label);
    }
    if(data.backupAvailable) actions.append(button('적용 전 백업 위치',()=>api.googleSyncShowBackup()));
    }
    const choice=document.getElementById('profile-sync-choice')!;choice.hidden=data.connection!=='choice';
    const choiceSignature=JSON.stringify([data.connection,data.remoteProfiles,busy]);
    if(choice.dataset.signature!==choiceSignature) {
    choice.dataset.signature=choiceSignature;choice.replaceChildren();
    if(data.connection==='choice') {
      choice.append(el('p','이 PC와 Google의 데이터를 어떻게 사용할까요?','text-sm text-white font-semibold'),
        el('p','병합은 양쪽 프로필을 보존합니다. Google 데이터로 가져오기는 이 PC의 프로필·숙제·설정을 백업한 뒤 교체하며, 기존 모험일지는 원래 귀속으로 남습니다. 이름이 같아도 서로 다른 프로필은 자동으로 합치지 않습니다.','ui-description'));
      const list=el('ul',undefined,'ui-description');
      for(const profile of data.remoteProfiles || []) list.append(el('li',`${profile.name} · ${profile.server===7 ? '하이아칸' : profile.server===16 ? '네냐플' : '서버 미설정'}`));choice.append(list);
      const choices=el('div',undefined,'flex flex-wrap gap-3');
      choices.append(button('양쪽 병합 (추천)',()=>api.googleSyncConnectChoice('merge'),true),
        button('Google 데이터로 가져오기',async()=>{
          if(!window.confirm('이 PC의 프로필·숙제·설정을 적용 전 백업한 뒤 Google 데이터로 교체합니다. 계속할까요?')) return {success:true,message:'가져오기를 취소했습니다.'};
          return api.googleSyncConnectChoice('remote');
        }),button('이 PC 유지 · 동기화 끄기',()=>api.googleSyncConnectChoice('local')));choice.append(choices);
    }
    }
    const reviews=document.getElementById('profile-sync-reviews')!;
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
      const buttons=el('div',undefined,'flex flex-wrap gap-2');
      if(!review.key.endsWith(',"deleted"]')) buttons.append(button('이 PC 값 유지',()=>api.googleSyncResolve(review.key,'local')));
      for(const candidate of review.candidates) {
        const row=el('div',undefined,'ui-inset space-y-2');
        row.append(el('p',display(candidate.value,review.key),'ui-description break-words'),el('p',new Date(candidate.changedAt).toLocaleString(),'ui-description'),button('이 값 사용',()=>api.googleSyncResolve(review.key,candidate.id)));
        if(candidate.value && typeof candidate.value==='object' || typeof candidate.value==='string' && candidate.value.length>180) {
          const detail=el('details'),summary=el('summary','내용 자세히 보기','ui-description cursor-pointer'),content=el('pre',typeof candidate.value==='string' ? candidate.value : JSON.stringify(candidate.value,null,2),'ui-description whitespace-pre-wrap break-words max-h-40 overflow-auto custom-scroll');detail.append(summary,content);row.append(detail);
        }
        buttons.append(row);
      }
      section.append(buttons);reviews.append(section);
    }
  }
  window.settingsProfileCloudSync={render(status){if(!status.profileSync)return false;renderProfile(status);return true;}};
})();
