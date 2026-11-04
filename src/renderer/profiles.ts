(() => {
  type Status=import('../shared/playProfiles').PlayProfileStatus;
  type Result=import('../shared/playProfiles').PlayProfileResult;
  type Profile=import('../shared/playProfiles').PlayProfile;
  const api=window.electronAPI as typeof window.electronAPI & import('../shared/playProfiles').PlayProfilesApi;
  const element=<T extends HTMLElement>(id:string):T => document.getElementById(id) as T;
  const name=element<HTMLInputElement>('profile-name');
  const server=element<HTMLSelectElement>('profile-server');
  const copy=element<HTMLSelectElement>('profile-copy');
  const form=element<HTMLFormElement>('profile-form');
  const dialog=element<HTMLDialogElement>('profile-confirm');
  let state:Status | null=null;
  let editing:string | null=null;
  let baseline='';
  let working=false;
  let allowClose=false;
  let closeQuestion=false;
  const values=() => JSON.stringify([name.value,server.value,editing===null ? copy.value : '']);
  const dirty=() => values()!==baseline;
  const message=(text:string,error=false) => {
    const target=element('profile-status');target.textContent=text;target.dataset.error=String(error);
  };
  const ask=(title:string,body:string,accept:string):Promise<boolean> => {
    element('confirm-title').textContent=title;element('confirm-body').textContent=body;element('confirm-accept').textContent=accept;
    dialog.returnValue='cancel';dialog.showModal();
    return new Promise(resolve => {
      const finish=(accepted:boolean) => {
        dialog.removeEventListener('submit',submit);dialog.removeEventListener('cancel',cancel);
        dialog.close(accepted ? 'accept' : 'cancel');resolve(accepted);
      };
      const submit=(event:SubmitEvent) => {event.preventDefault();finish((event.submitter as HTMLButtonElement | null)?.value==='accept');};
      const cancel=(event:Event) => {event.preventDefault();finish(false);};
      // close 이벤트는 다음 렌더 프레임까지 지연될 수 있으므로 사용자의 실제 선택 때 완료한다.
      dialog.addEventListener('submit',submit);dialog.addEventListener('cancel',cancel);
    });
  };
  const discard=() => !dirty() ? Promise.resolve(true) : ask('작성 중인 내용을 버릴까요?','아직 저장하지 않은 이름과 서버 설정이 있습니다.','버리고 계속');
  const button=(label:string,action:() => void,className='ui-button') => {
    const node=document.createElement('button');node.type='button';node.className=className;node.textContent=label;node.disabled=working || !!state?.busy;node.addEventListener('click',action);return node;
  };
  const profileLabel=(profile:Profile) => `${profile.name || '기본 프로필'} · ${profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '서버 선택 필요'}`;
  function render():void {
    const list=element('profiles-list');
    // 대기 기록 개수 알림은 잦다. 프로필 목록이 바뀌지 않으면 DOM과 키보드 포커스를 유지한다.
    const signature=JSON.stringify([state?.profiles,state?.activeProfileId,state?.selectionRequired,editing,working,state?.busy]);
    if (list.dataset.signature!==signature) {
      const focus=document.activeElement as HTMLElement | null;
      const focusKey=list.contains(focus) ? focus?.dataset.focusKey : undefined;
      list.replaceChildren();
      for (const profile of state?.profiles || []) {
        const row=document.createElement('article');row.className='profile-row';row.dataset.profileId=profile.id;row.dataset.editing=String(editing===profile.id);
        const title=document.createElement('strong');title.textContent=profile.name || '기본 프로필';
        const detail=document.createElement('p');detail.textContent=profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '사용하려면 서버를 선택하세요.';
        row.append(title,detail);
        if (state?.activeProfileId===profile.id) {const badge=document.createElement('span');badge.className='profile-badge';badge.textContent=state.selectionRequired ? '마지막 사용 프로필' : '현재 사용 중';row.append(badge);}
        const actions=document.createElement('div');actions.className='profile-row-actions';
        const edit=button('수정',() => {void changeEditor(profile.id);});edit.dataset.focusKey=`edit:${profile.id}`;
        const use=button('사용',() => {void useProfile(profile);},'ui-button ui-button-primary');use.dataset.focusKey=`use:${profile.id}`;
        actions.append(use,edit);row.append(actions);list.append(row);
      }
      list.dataset.signature=signature;
      if (focusKey) Array.from(list.querySelectorAll<HTMLElement>('[data-focus-key]')).find(node => node.dataset.focusKey===focusKey)?.focus();
    }
    const disabled=working || !!state?.busy || !state;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,select,button').forEach(node => {node.disabled=disabled;});
    element<HTMLButtonElement>('new-profile').disabled=disabled;
    const notice=element('selection-notice');
    if (state) notice.textContent=state.selectionRequired ? '프로필을 선택해 주세요. 선택 전 자동 기록은 보관한 뒤 이번 플레이에 함께 반영합니다.' : `${state.profiles.find(p => p.id===state!.activeProfileId)?.name || '기본 프로필'} 프로필을 사용하고 있습니다.`;
    const previousSessions=state?.pendingSessions.filter(session => session.sessionId!==state?.sessionId) || [];
    element('pending-section').hidden=previousSessions.length===0;
    const pending=element('pending-sessions');pending.replaceChildren();
    for (const session of previousSessions) {
      const row=document.createElement('div');row.className='pending-row';
      const text=document.createElement('p');text.textContent=`${new Date(session.firstOccurredAt).toLocaleString('ko-KR')} · ${session.count.toLocaleString()}건`;
      const assign=button('현재 프로필로 배정',() => {void assignSession(session.sessionId,session.count);});assign.disabled=disabled || !!state?.selectionRequired;
      row.append(text,assign);pending.append(row);
    }
  }
  function edit(id:string | null):void {
    editing=id;
    const profile=state?.profiles.find(p => p.id===id);
    name.value=profile?.name || '';server.value=profile?.userServer ? String(profile.userServer) : '';
    copy.replaceChildren(new Option('기본 설정으로 시작',''));
    for (const item of state?.profiles || []) copy.add(new Option(profileLabel(item),item.id));
    element('profile-copy-field').hidden=id!==null;
    element('delete-profile').hidden=id===null;
    element('profile-editor-title').textContent=id===null ? '새 프로필' : '프로필 수정';
    baseline=values();render();
  }
  async function changeEditor(id:string | null):Promise<void> {
    if (working || state?.busy || (id===editing && id!==null)) return;
    if (!await discard()) return;
    edit(id);name.focus();
  }
  async function perform(action:() => Promise<Result>,success:string):Promise<Result | null> {
    if (working || state?.busy) return null;
    working=true;message('처리 중입니다…');render();
    try {
      const result=await action();state=result.status;
      message(result.error || (result.success ? success : '처리하지 못했습니다. 다시 시도해 주세요.'),!result.success);
      return result;
    } catch (error) {message(error instanceof Error ? error.message : String(error),true);return null;}
    finally {working=false;render();}
  }
  async function select(id:string):Promise<void> {
    const result=await perform(() => api.selectPlayProfile(id),'프로필을 선택했습니다.');
    // 대기 기록 반영 실패 등의 안내는 사용자가 읽을 수 있게 창을 유지한다.
    if (result?.success && !result.error) {allowClose=true;api.closePlayProfiles();}
  }
  async function useProfile(profile:Profile):Promise<void> {
    if (working || state?.busy) return;
    if (!await discard()) return;
    if (!profile.userServer || !profile.name.trim()) {
      edit(profile.id);message('프로필 이름과 서버를 저장한 뒤 사용해 주세요.');
      (!profile.name.trim() ? name : server).focus();return;
    }
    edit(profile.id);await select(profile.id);
  }
  async function save(use:boolean):Promise<void> {
    if (!form.reportValidity()) return;
    const id=editing;
    const result=await perform(() => id ? api.updatePlayProfile(id,name.value,Number(server.value))
      : api.createPlayProfile(name.value,Number(server.value),copy.value || undefined),'프로필을 저장했습니다.');
    if (!result?.success) return;
    const savedId=id || result.profileId;
    if (!savedId) return;
    edit(savedId);
    if (use) await select(savedId);
  }
  async function assignSession(id:string,count:number):Promise<void> {
    const active=state?.profiles.find(p => p.id===state!.activeProfileId);
    if (!active || !await ask('미배정 기록 가져오기',`${count.toLocaleString()}건을 ${profileLabel(active)} 프로필에 배정할까요?\n기록만으로는 실제 플레이한 캐릭터를 확인할 수 없습니다.`,'배정')) return;
    await perform(() => api.assignPlayProfileSession(id),'미배정 기록을 반영했습니다.');
  }
  async function load():Promise<void> {
    try {
      state=await api.getPlayProfiles();
      element('retry-profiles').hidden=!!state;
      if (!state) {message('프로필 기능을 준비하고 있습니다. 잠시 후 다시 불러와 주세요.');render();return;}
      message('');edit(state.activeProfileId || state.profiles[0]?.id || null);
    } catch {message('프로필을 불러오지 못했습니다. 다시 시도해 주세요.',true);element('retry-profiles').hidden=false;render();}
  }
  element('new-profile').addEventListener('click',() => {void changeEditor(null);});
  form.addEventListener('submit',event => {event.preventDefault();void save(true);});
  element('save-profile').addEventListener('click',() => {void save(false);});
  element('delete-profile').addEventListener('click',() => {void (async () => {
    if (!editing || working) return;
    const profile=state?.profiles.find(p => p.id===editing);
    if (!profile || !await ask('프로필을 삭제할까요?',`${profileLabel(profile)} 프로필의 숙제와 설정을 삭제합니다.\n모험일지 기록은 남습니다.${state?.profiles.length===1 ? '\n마지막 프로필을 삭제하면 빈 기본 프로필이 만들어집니다.' : ''}`,'삭제')) return;
    const result=await perform(() => api.deletePlayProfile(profile.id),'프로필을 삭제했습니다.');
    if (result?.success) edit(state!.activeProfileId || state!.profiles[0]?.id || null);
  })();});
  async function requestClose():Promise<void> {
    if (working || closeQuestion || dialog.open) return;
    closeQuestion=true;
    try {if (await discard()) {allowClose=true;api.closePlayProfiles();}}
    finally {closeQuestion=false;}
  }
  element('close-profiles').addEventListener('click',() => {void requestClose();});
  window.addEventListener('keydown',event => {
    if (event.key==='Escape' && !dialog.open && !event.defaultPrevented) {event.preventDefault();void requestClose();}
  });
  window.addEventListener('beforeunload',event => {
    if (allowClose || (!working && !dirty())) return;
    event.preventDefault();event.returnValue=false;void requestClose();
  });
  element('retry-profiles').addEventListener('click',() => {void load();});
  api.onPlayProfilesChanged(next => {
    state=next;
    if (editing && !state.profiles.some(p => p.id===editing) && !dirty() && !working) edit(state.activeProfileId);
    else render();
  });
  void load();
})();
