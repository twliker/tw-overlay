(() => {
  type Payload=import('../shared/types').IncompleteContentsPayload;
  type Contents=import('../shared/types').GameExitReminderContents;
  type Profile=import('../shared/types').ProfileIncompleteContents;
  const api=window.electronAPI as typeof window.electronAPI & import('../shared/types').GameExitReminderApi;
  const element=(id:string)=>document.getElementById(id)!;
  const section=element('incomplete-section'),tabs=element('profile-tabs'),panel=element('profile-tasks');
  const list=element('incomplete-list'),summary=element('profile-summary'),empty=element('incomplete-empty'),scroll=element('task-scroll');
  let profiles:Profile[]=[],selectedId:string | undefined;
  const positions=new Map<string,number>();
  const serverName=(profile:Profile)=>profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '서버 미설정';
  const normalize=(payload:Payload):Contents=>{
    if(!Array.isArray(payload))return payload;
    const groups=new Map<string,Profile>();
    for(const item of payload) {
      let group=groups.get(item.charName);
      if(!group) {group={profileId:`legacy-${groups.size}`,profileName:item.charName,userServer:null,items:[]};groups.set(item.charName,group);}
      group.items.push(item);
    }
    return {profiles:[...groups.values()]};
  };
  // 탭은 이 창의 조회 상태일 뿐이다. 실제 프로필 선택/기록 소유자를 바꾸는 IPC는 호출하지 않는다.
  function select(id:string,focus=false):void {
    if(selectedId)positions.set(selectedId,scroll.scrollTop);
    selectedId=id;
    const profile=profiles.find(item=>item.profileId===id);
    if(!profile)return;
    for(const button of Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role=tab]'))) {
      const selected=button.dataset.profileId===id;
      button.setAttribute('aria-selected',String(selected));button.tabIndex=selected ? 0 : -1;
      if(selected) {
        panel.setAttribute('aria-labelledby',button.id);
        button.scrollIntoView({block:'nearest',inline:'nearest'});
        if(focus)button.focus({preventScroll:true});
      }
    }
    summary.textContent=`${serverName(profile)} · 남은 숙제 ${profile.items.length}개`;
    list.replaceChildren();empty.hidden=profile.items.length>0;empty.textContent='남은 숙제가 없습니다.';
    const sorted=[...profile.items].sort((a,b)=>(a.type===b.type ? a.category.localeCompare(b.category) : a.type==='daily' ? -1 : 1));
    for(const item of sorted) {
      const card=document.createElement('div');card.className='task-card';card.dataset.period=item.type;
      const dot=document.createElement('span');dot.className='cat-dot';dot.setAttribute('aria-hidden','true');
      const text=document.createElement('div');text.className='task-text';
      const meta=document.createElement('div');meta.className='task-meta';meta.textContent=`${item.type==='weekly' ? '주간' : '일일'} · ${item.category}`;
      const name=document.createElement('div');name.className='task-name';name.textContent=item.name;name.title=item.name;
      text.append(meta,name);card.append(dot,text);list.append(card);
    }
    scroll.scrollTop=positions.get(id) || 0;
  }
  function render(payload:Payload):void {
    const data=normalize(payload),previous=selectedId;
    if(previous)positions.set(previous,scroll.scrollTop);
    profiles=data.profiles;tabs.replaceChildren();list.replaceChildren();section.classList.remove('hidden');
    tabs.hidden=data.unavailable===true || profiles.length===0;panel.removeAttribute('aria-labelledby');
    if(data.unavailable || profiles.length===0) {
      selectedId=undefined;summary.textContent='';empty.hidden=false;
      empty.textContent=data.unavailable ? '남은 숙제를 불러오지 못했습니다. 숙제 체크리스트에서 다시 확인해 주세요.' : '표시할 프로필이 없습니다.';
      return;
    }
    for(const [index,profile] of profiles.entries()) {
      const button=document.createElement('button');button.type='button';button.className='profile-tab no-drag';
      button.id=`reminder-profile-${index}`;button.dataset.profileId=profile.profileId;button.setAttribute('role','tab');
      button.setAttribute('aria-controls',panel.id);button.title=`${profile.profileName} · ${serverName(profile)} · 남은 숙제 ${profile.items.length}개`;
      button.setAttribute('aria-label',button.title);
      const label=document.createElement('span');label.className='profile-tab-name';label.textContent=profile.profileName;
      const count=document.createElement('span');count.className='profile-tab-count';count.textContent=String(profile.items.length);
      button.append(label,count);button.addEventListener('click',()=>select(profile.profileId,true));tabs.append(button);
    }
    selectedId=undefined;
    const chosen=profiles.find(profile=>profile.profileId===previous) || profiles.find(profile=>profile.profileId===data.activeProfileId) || profiles[0];
    select(chosen.profileId);
  }
  tabs.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !profiles.length)return;
    event.preventDefault();
    const index=profiles.findIndex(profile=>profile.profileId===selectedId);
    const next=event.key==='Home' ? 0 : event.key==='End' ? profiles.length-1 : (index+(event.key==='ArrowRight' ? 1 : -1)+profiles.length)%profiles.length;
    select(profiles[next].profileId,true);
  });
  api?.onReminderMessage(message=>{
    element('reminder-message').textContent=message || '오늘의 숙제는 다 하셨나요?\n내일 또 만나요! 👋';
  });
  api?.onIncompleteContents(render);
  element('confirm-reminder').addEventListener('click',()=>window.close());
  window.lucide?.createIcons();window.bindEscapeClose();
})();
