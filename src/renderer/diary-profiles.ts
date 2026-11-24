interface DiaryProfileTarget {
  /**
   * 기능 계약: 수동 기록 한 건을 "대상 고정 → 저장 → 고정 해제" 순서로 처리하는 유일한 경로다.
   * 클릭 시점의 선택값을 고정하고 대상 선택을 잠근 뒤 save(profileId)를 실행한다.
   * save가 정상 종료하면(실패는 throw) 저장 중 새 초안이 시작되지 않은 경우에만 고정을 풀어
   * 다음 기록이 현재 사용 프로필을 따른다. 사용자가 직접 고른 대상과 작성 중인 초안은 유지한다.
   * 실패하면 같은 대상으로 재시도할 수 있게 고정을 유지한다. 대상 확인 실패는 상태 문구를 표시하고 throw한다.
   * 회귀: scripts/check-diary-profiles-ui.ts
   */
  record<T>(save:(profileId:string | undefined) => Promise<T>):Promise<T>;
  value():string | undefined;
  filter():import('../shared/diaryProfiles').DiaryProfileFilter | undefined;
  lock(locked:boolean):void;
  /** 입력 이벤트 없이 화면이 초안을 채울 때(예: 현황 불러오기) 현재 대상을 고정한다. */
  holdDraft():void;
  error(message:string):void;
}
interface DiaryProfileTargetOptions {
  isDirty?:() => boolean;onChange?:() => void;compact?:boolean;hint?:string;
  /** 기록 초안 입력이 있는 영역. 이 안의 input/change만 대상을 고정한다. 초안 입력이 없으면 null. */
  draftScope:HTMLElement | null;
}
interface Window {
  diaryProfiles:{ready:Promise<void>;refresh():Promise<void>;state():import('../shared/diaryProfiles').DiaryProfileState;
    label(id:string):string;subscribe(callback:() => void):() => void;
    target(container:HTMLElement,options:DiaryProfileTargetOptions):DiaryProfileTarget};
}

(() => {
  type State=import('../shared/diaryProfiles').DiaryProfileState;
  const api=window.electronAPI as typeof window.electronAPI & {
    getDiaryProfileState?:() => Promise<State>;
    onPlayProfilesChanged?:(callback:(status:import('../shared/playProfiles').PlayProfileStatus) => void) => void;
    openProfiles?:() => void;
  };
  let state:State={enabled:false,profiles:[],activeProfileId:null,selectionRequired:true,busy:false};
  let loaded=false,error='',generation=0;
  const listeners=new Set<() => void>();
  const targets=new WeakMap<HTMLElement,DiaryProfileTarget>();
  const notify=() => {for (const listener of listeners) listener();};
  const label=(id:string) => {
    const profile=state.profiles.find(item => item.id===id);
    if (!profile) return '프로필을 다시 선택해 주세요';
    return `${profile.name || '기본 프로필'} · ${profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '서버 미설정'}`;
  };
  async function refresh():Promise<void> {
    const request=++generation;
    try {
      const next=api.getDiaryProfileState ? await api.getDiaryProfileState() : {enabled:false,profiles:[],activeProfileId:null,selectionRequired:true,busy:false};
      if (request!==generation) return;
      state=next;loaded=true;error='';notify();
    } catch {
      if (request!==generation) return;
      loaded=true;error='프로필 정보를 불러오지 못했습니다. 다시 불러와 주세요.';notify();
    }
  }
  const ready=refresh();
  let profileSignature:string | undefined;
  api.onPlayProfilesChanged?.(status => {
    // 대기 건수와 게임 세션 ID 변화는 일지의 프로필 목록·조회 대상에 영향을 주지 않는다.
    const signature=JSON.stringify([status.profiles,status.activeProfileId,status.selectionRequired,status.busy]);
    if (profileSignature===signature) return;
    profileSignature=signature;
    void refresh();
  });

  function target(container:HTMLElement,options:DiaryProfileTargetOptions):DiaryProfileTarget {
    const existing=targets.get(container);if (existing) return existing;
    container.classList.add('diary-profile-target');container.classList.toggle('diary-profile-compact',!!options.compact);
    const title=document.createElement('label');title.textContent='새 수동 기록을 저장할 프로필';
    const select=document.createElement('select');select.className='ui-input';select.setAttribute('aria-label','기록할 프로필');
    title.append(select);
    const hint=document.createElement('p');hint.className='ui-description';hint.textContent=options.hint || '새로 추가하는 기록의 저장 대상입니다. 위 조회 범위의 기록 소유자와는 별개입니다.';
    const status=document.createElement('p');status.className='ui-status';status.setAttribute('role','status');
    const manage=document.createElement('button');manage.type='button';manage.className='ui-button';manage.textContent='프로필 관리';
    manage.addEventListener('click',() => api.openProfiles?.());
    const retry=document.createElement('button');retry.type='button';retry.className='ui-button';retry.textContent='다시 불러오기';retry.addEventListener('click',() => {void refresh();});
    container.replaceChildren(title,hint,status,manage,retry);
    // draftRevision은 초안 입력·holdDraft마다 증가한다. 저장 중 새 초안이 생겼는지 판정한다.
    let chosen='',explicit=false,pinned=false,locked=false,lastMessage='',firstRender=true,draftRevision=0;
    const current=() => !state.selectionRequired ? state.activeProfileId || '' : '';
    const canRecord=(profile:State['profiles'][number]) => !!profile.name.trim() && (profile.userServer===7 || profile.userServer===16);
    const render=() => {
      container.hidden=!state.enabled && !error;
      const before=select.value;
      if (!explicit && !pinned && !options.isDirty?.()) chosen=current();
      select.replaceChildren(new Option('프로필 선택',''));
      const selected=state.profiles.find(profile=>profile.id===chosen);
      for (const profile of state.profiles) {
        const option=new Option(label(profile.id),profile.id);
        option.disabled=!canRecord(profile);
        select.add(option);
      }
      // 초안의 대상이 삭제되면 목록에서는 제거하되 다른 프로필을 자동으로 선택하지 않는다.
      select.value=selected?.id ?? '';
      select.title=selected ? label(selected.id) : '기록할 프로필을 선택하세요';
      select.disabled=locked || !!error || !loaded;
      retry.hidden=!error;manage.hidden=!!error || state.profiles.some(canRecord);
      const unavailable=chosen && (!selected || !canRecord(selected));
      status.textContent=error || lastMessage || (unavailable ? '대상 프로필을 사용할 수 없습니다. 다른 프로필을 선택해 주세요.' : '');
      if (!firstRender && before!==select.value) options.onChange?.();
      firstRender=false;
    };
    select.addEventListener('change',() => {chosen=select.value;explicit=true;pinned=true;lastMessage='';render();options.onChange?.();});
    async function capture(selectedAtClick:string):Promise<string | undefined> {
      await ready;
      if (!loaded) await refresh();
      if (error) {lastMessage=error;render();throw new Error(error);}
      if (!state.enabled) return undefined;
      const profile=state.profiles.find(item => item.id===selectedAtClick);
      if (!profile || !canRecord(profile)) {
        lastMessage='기록할 프로필을 선택하세요.';render();select.focus();throw new Error(lastMessage);
      }
      chosen=profile.id;pinned=true;lastMessage='';render();return profile.id;
    }
    const handle:DiaryProfileTarget={
      async record(save) {
        // 선택값은 await 전에 읽는다. 클릭 뒤 도착한 프로필 전환이 이번 기록의 대상을 바꾸지 않는다.
        const selectedAtClick=select.value,revision=draftRevision;
        chosen=selectedAtClick;pinned=true;locked=true;render();
        try {
          const result=await save(await capture(selectedAtClick));
          if (!explicit && revision===draftRevision && !options.isDirty?.()) pinned=false;
          return result;
        } finally {locked=false;render();}
      },
      value:() => state.enabled ? select.value : undefined,
      filter:() => state.enabled ? select.value ? {kind:'profile',profileId:select.value} : undefined : undefined,
      lock(value) {locked=value;render();},
      holdDraft() {chosen=select.value;pinned=true;draftRevision++;render();},
      error(message) {lastMessage=message;render();},
    };
    // 초안 입력이 시작되면 당시 기본 대상을 고정한다. 이후 다른 창의 프로필 전환이 초안을 재배정하지 않는다.
    // 알림 설정·음량처럼 기록 초안이 아닌 조작은 draftScope 밖에 두어 대상을 고정하지 않는다.
    const pin=(event:Event) => {if (!container.contains(event.target as Node)) {chosen=select.value;pinned=true;draftRevision++;}};
    options.draftScope?.addEventListener('input',pin);options.draftScope?.addEventListener('change',pin);
    const listener=() => {if (!container.isConnected) {listeners.delete(listener);return;}render();};
    listeners.add(listener);targets.set(container,handle);render();return handle;
  }
  window.diaryProfiles={ready,refresh,state:() => state,label,subscribe(callback) {listeners.add(callback);return () => listeners.delete(callback);},target};
})();
