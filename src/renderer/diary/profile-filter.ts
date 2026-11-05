interface Window {
  diaryProfileView:{ready:Promise<void>;filter():import('../../shared/diaryProfiles').DiaryProfileFilter | undefined;key():string;label():string};
}
(() => {
  const provider=window.diaryProfiles;
  const bar=document.getElementById('diary-profile-bar')!;
  const select=document.getElementById('diary-profile-filter') as HTMLSelectElement;
  const note=document.getElementById('diary-profile-note')!;
  const archiveOpen=document.getElementById('diary-archives-open') as HTMLButtonElement;
  const archiveDialog=document.getElementById('diary-archives-dialog') as HTMLDialogElement;
  const archiveList=document.getElementById('diary-archives-list')!;
  const archiveStatus=document.getElementById('diary-archives-status')!;
  const archiveClose=document.getElementById('diary-archives-close') as HTMLButtonElement;
  const api=window.electronAPI as typeof window.electronAPI & {ignoreArchivedDiaryProfile(id:string):Promise<import('../../shared/diaryProfiles').DiaryProfileState>};
  let archiveBusy=false,armedArchive:string | null=null;
  const action=(text:string,run:()=>void)=>{const node=document.createElement('button');node.type='button';node.className='ui-button';node.textContent=text;node.disabled=archiveBusy || provider.state().busy;node.addEventListener('click',run);return node;};
  function renderArchives():void {
    const profiles=provider.state().archivedProfiles || [];
    archiveOpen.hidden=!profiles.length;archiveOpen.disabled=archiveBusy || provider.state().busy;archiveClose.disabled=archiveBusy;
    archiveList.replaceChildren();
    for(const profile of profiles) {
      if(armedArchive && armedArchive!==profile.id)continue;
      const row=document.createElement('div');row.className='diary-archive-row';row.dataset.profileId=profile.id;
      const text=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('p');
      name.textContent=profile.name;detail.textContent=`${profile.firstDate} ~ ${profile.lastDate} · ${profile.recordCount.toLocaleString()}건`;text.append(name,detail);row.append(text);
      if(armedArchive===profile.id) {
        row.append(action('취소',()=>{armedArchive=null;archiveStatus.textContent='';renderArchives();}),action('미배정으로 옮기기',()=>{void moveArchived(profile.id,profile.recordCount);}));
      } else row.append(action('무시하기',()=>{armedArchive=profile.id;archiveStatus.textContent='이 프로필의 기록을 미배정으로 옮깁니다. 기록 원문은 보존됩니다.';renderArchives();}));
      archiveList.append(row);
    }
    if(!profiles.length) {const empty=document.createElement('p');empty.className='ui-description';empty.textContent=archiveBusy ? '기록을 정리하는 중입니다…' : provider.state().busy ? '진행 중인 프로필 작업이 끝나면 다시 확인합니다.' : '정리할 이전 프로필 기록이 없습니다.';archiveList.append(empty);}
  }
  async function moveArchived(id:string,count:number):Promise<void> {
    if(archiveBusy)return;
    archiveBusy=true;archiveStatus.textContent='기록을 옮기는 중입니다…';renderArchives();
    try {
      await api.ignoreArchivedDiaryProfile(id);armedArchive=null;value='unassigned';
      provider.acknowledgeArchive(id);archiveStatus.textContent=`${count.toLocaleString()}건을 미배정 기록으로 옮겼습니다.`;
    } catch(error) {archiveStatus.textContent=error instanceof Error ? error.message : String(error);}
    finally {archiveBusy=false;renderArchives();}
  }
  archiveOpen.addEventListener('click',()=>{armedArchive=null;archiveStatus.textContent='';renderArchives();archiveDialog.showModal();});
  archiveClose.addEventListener('click',()=>{if(!archiveBusy)archiveDialog.close();});
  archiveDialog.addEventListener('cancel',event=>{if(archiveBusy)event.preventDefault();});
  let value='all',signature='',initialized=false,revision=0;
  const filter=():import('../../shared/diaryProfiles').DiaryProfileFilter | undefined => !provider.state().enabled ? undefined
    :value==='all' ? {kind:'all'} :value==='unassigned' ? {kind:'unassigned'} : {kind:'profile',profileId:value};
  const label=() => value==='all' ? '모든 프로필' :value==='unassigned' ? '미배정 기록' :provider.label(value);
  const changed=() => {++revision;window.dispatchEvent(new CustomEvent('diary-profile-filter-changed'));};
  const render=() => {
    const state=provider.state();
    const profiles=state.profiles.filter(profile=>!profile.deletedAt);
    if(value!=='all' && value!=='unassigned' && !profiles.some(profile=>profile.id===value))value='all';
    const next=JSON.stringify([value,state.enabled,state.profiles,state.activeProfileId,state.selectionRequired,state.archivedProfiles,state.busy]);
    if (next===signature) return;
    signature=next;bar.hidden=!state.enabled;
    document.body.classList.toggle('diary-has-profiles',state.enabled);
    select.replaceChildren(new Option('모든 프로필','all'),new Option('미배정 기록','unassigned'));
    for (const profile of profiles) select.add(new Option(`${provider.label(profile.id)}${profile.id===state.activeProfileId && !state.selectionRequired ? ' · 현재 사용' : ''}`,profile.id));
    select.value=value;
    note.textContent=value==='unassigned' ? '조회 중: 미배정 기록. 아래 프로필 선택은 새 수동 기록의 저장 대상입니다.' : '조회 범위와 새 수동 기록의 저장 대상은 별도로 선택합니다.';
    renderArchives();
    if (initialized) changed();
  };
  select.addEventListener('change',() => {value=select.value;render();});
  provider.subscribe(render);
  window.diaryProfileView={ready:provider.ready.then(() => {render();initialized=true;}),filter,key:() => JSON.stringify([filter() || {kind:'all'},revision]),label};
})();
