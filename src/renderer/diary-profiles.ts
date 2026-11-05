interface DiaryProfileTarget {
  capture():Promise<string | undefined>;
  value():string | undefined;
  filter():import('../shared/diaryProfiles').DiaryProfileFilter | undefined;
  lock(locked:boolean):void;
  holdDraft():void;
  releaseDraft():void;
  error(message:string):void;
}
interface Window {
  diaryProfiles:{ready:Promise<void>;refresh():Promise<void>;acknowledgeArchive(id:string):void;state():import('../shared/diaryProfiles').DiaryProfileState;
    label(id:string):string;subscribe(callback:() => void):() => void;
    target(container:HTMLElement,options?:{isDirty?:() => boolean;onChange?:() => void;compact?:boolean;hint?:string;scope?:HTMLElement}):DiaryProfileTarget};
}

(() => {
  type State=import('../shared/diaryProfiles').DiaryProfileState;
  const api=window.electronAPI as typeof window.electronAPI & {
    getDiaryProfileState?:() => Promise<State>;
    onPlayProfilesChanged?:(callback:() => void) => void;
    toggleProfiles?:() => void;
  };
  let state:State={enabled:false,profiles:[],activeProfileId:null,selectionRequired:true,busy:false};
  let loaded=false,error='',generation=0;
  const listeners=new Set<() => void>();
  const targets=new WeakMap<HTMLElement,DiaryProfileTarget>();
  const notify=() => {for (const listener of listeners) listener();};
  const label=(id:string) => {
    const profile=state.profiles.find(item => item.id===id);
    if (!profile) return '프로필을 다시 선택해 주세요';
    return `${profile.name || '기본 프로필'} · ${profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '서버 미설정'}${profile.deletedAt ? ' (삭제됨)' : ''}`;
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
  api.onPlayProfilesChanged?.(() => {void refresh();});
  function acknowledgeArchive(id:string):void {
    // 저장 ACK 뒤의 목록 조회 실패가 성공한 정리를 되돌려 보이지 않게 한다.
    // 오래된 ACK의 현재 프로필/선택 상태를 적용하지 않고 정리한 ID만 제거한다.
    ++generation;
    state={...state,archivedProfiles:state.archivedProfiles?.filter(profile=>profile.id!==id)};
    error='';notify();void refresh();
  }

  function target(container:HTMLElement,options:{isDirty?:() => boolean;onChange?:() => void;compact?:boolean;hint?:string;scope?:HTMLElement}={}):DiaryProfileTarget {
    const existing=targets.get(container);if (existing) return existing;
    container.classList.add('diary-profile-target');container.classList.toggle('diary-profile-compact',!!options.compact);
    const title=document.createElement('label');title.textContent='새 수동 기록을 저장할 프로필';
    const select=document.createElement('select');select.className='ui-input';select.setAttribute('aria-label','기록할 프로필');
    title.append(select);
    const hint=document.createElement('p');hint.className='ui-description';hint.textContent=options.hint || '새로 추가하는 기록의 저장 대상입니다. 위 조회 범위의 기록 소유자와는 별개입니다.';
    const status=document.createElement('p');status.className='ui-status';status.setAttribute('role','status');
    const manage=document.createElement('button');manage.type='button';manage.className='ui-button';manage.textContent='프로필 관리';
    manage.addEventListener('click',() => api.toggleProfiles?.());
    const retry=document.createElement('button');retry.type='button';retry.className='ui-button';retry.textContent='다시 불러오기';retry.addEventListener('click',() => {void refresh();});
    container.replaceChildren(title,hint,status,manage,retry);
    let chosen='',explicit=false,pinned=false,locked=false,lastMessage='',firstRender=true;
    const current=() => !state.selectionRequired ? state.activeProfileId || '' : '';
    const render=() => {
      container.hidden=!state.enabled && !error;
      const before=select.value;
      if (!explicit && !pinned && !options.isDirty?.()) chosen=current();
      select.replaceChildren(new Option('프로필 선택',''));
      for (const profile of state.profiles) {
        if (profile.deletedAt && profile.id!==chosen) continue;
        const option=new Option(label(profile.id),profile.id);
        option.disabled=!!profile.deletedAt || !profile.name.trim() || profile.userServer!==7 && profile.userServer!==16;
        select.add(option);
      }
      if (chosen && !state.profiles.some(profile => profile.id===chosen)) {const option=new Option('사용할 수 없는 프로필',chosen);option.disabled=true;select.add(option);}
      select.value=chosen;
      select.title=chosen ? label(chosen) : '기록할 프로필을 선택하세요';
      select.disabled=locked || !!error || !loaded;
      retry.hidden=!error;manage.hidden=!!error || state.profiles.some(profile => !profile.deletedAt && profile.name.trim() && (profile.userServer===7 || profile.userServer===16));
      const unavailable=chosen && !state.profiles.some(profile => profile.id===chosen && !profile.deletedAt && profile.name.trim() && (profile.userServer===7 || profile.userServer===16));
      status.textContent=error || lastMessage || (unavailable ? '대상 프로필을 사용할 수 없습니다. 다른 프로필을 선택해 주세요.' : '');
      if (!firstRender && before!==select.value) options.onChange?.();
      firstRender=false;
    };
    select.addEventListener('change',() => {chosen=select.value;explicit=true;pinned=true;lastMessage='';render();options.onChange?.();});
    const handle:DiaryProfileTarget={
      async capture() {
        const selectedAtClick=select.value;chosen=selectedAtClick;pinned=true;
        await ready;
        if (!loaded) await refresh();
        if (error) {lastMessage=error;render();throw new Error(error);}
        if (!state.enabled) return undefined;
        const profile=state.profiles.find(item => item.id===selectedAtClick && !item.deletedAt);
        if (!profile || !profile.name.trim() || profile.userServer!==7 && profile.userServer!==16) {
          lastMessage='기록할 프로필을 선택하세요.';render();select.focus();throw new Error(lastMessage);
        }
        chosen=profile.id;pinned=true;lastMessage='';render();return profile.id;
      },
      value:() => state.enabled ? select.value : undefined,
      filter:() => state.enabled ? select.value ? {kind:'profile',profileId:select.value} : undefined : undefined,
      lock(value) {locked=value;render();},
      holdDraft() {chosen=select.value;pinned=true;render();},
      releaseDraft() {if (!explicit && !options.isDirty?.()) pinned=false;render();},
      error(message) {lastMessage=message;render();},
    };
    // 입력이 시작되면 당시 기본 대상을 고정한다. 이후 다른 창의 프로필 전환이 초안을 재배정하지 않는다.
    const scope=options.scope || container.parentElement;
    const pin=(event:Event) => {if (event.target!==select && !container.contains(event.target as Node)) {chosen=select.value;pinned=true;}};
    scope?.addEventListener('input',pin);scope?.addEventListener('change',pin);
    const listener=() => {if (!container.isConnected) {listeners.delete(listener);return;}render();};
    listeners.add(listener);targets.set(container,handle);render();return handle;
  }
  window.diaryProfiles={ready,refresh,acknowledgeArchive,state:() => state,label,subscribe(callback) {listeners.add(callback);return () => listeners.delete(callback);},target};
})();
