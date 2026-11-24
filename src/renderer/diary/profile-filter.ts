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
  type ProfileState=import('../../shared/diaryProfiles').DiaryProfileState;
  type ArchiveList=NonNullable<ProfileState['archivedProfiles']>;
  const api=window.electronAPI as typeof window.electronAPI & {
    getArchivedDiaryProfiles():Promise<ArchiveList>;
    ignoreArchivedDiaryProfile(id:string):Promise<ProfileState>;
  };
  let archiveBusy=false,archiveLoading=false,armedArchive:string | null=null;
  let archives:ArchiveList | null=null;
  const action=(text:string,run:()=>void)=>{const node=document.createElement('button');node.type='button';node.className='ui-button';node.textContent=text;node.disabled=archiveBusy || provider.state().busy;node.addEventListener('click',run);return node;};
  function renderArchives():void {
    const profiles=archives || [];
    archiveOpen.hidden=!provider.state().enabled;archiveOpen.disabled=archiveLoading || archiveBusy || provider.state().busy;archiveClose.disabled=archiveBusy;
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
    if(!profiles.length && archives!==null) {const empty=document.createElement('p');empty.className='ui-description';empty.textContent='정리할 이전 프로필 기록이 없습니다.';archiveList.append(empty);}
  }
  async function moveArchived(id:string,count:number):Promise<void> {
    if(archiveBusy)return;
    archiveBusy=true;archiveStatus.textContent='기록을 옮기는 중입니다…';renderArchives();
    try {
      const result=await api.ignoreArchivedDiaryProfile(id);
      archives=result.archivedProfiles || [];armedArchive=null;value='unassigned';
      render();archiveStatus.textContent=`${count.toLocaleString()}건을 미배정 기록으로 옮겼습니다.`;
    } catch(error) {archiveStatus.textContent=error instanceof Error ? error.message : String(error);}
    finally {archiveBusy=false;renderArchives();}
  }
  archiveOpen.addEventListener('click',async()=>{
    if(archiveLoading)return;
    archiveLoading=true;archives=null;armedArchive=null;
    archiveStatus.textContent='이전 프로필 기록을 불러오는 중입니다…';
    renderArchives();archiveDialog.showModal();
    try {archives=await api.getArchivedDiaryProfiles();archiveStatus.textContent='';}
    catch {archiveStatus.textContent='이전 프로필 기록을 불러오지 못했습니다. 창을 다시 열어 주세요.';}
    finally {archiveLoading=false;renderArchives();}
  });
  archiveClose.addEventListener('click',()=>{if(!archiveBusy)archiveDialog.close();});
  archiveDialog.addEventListener('cancel',event=>{if(archiveBusy)event.preventDefault();});
  let value='all',signature='',filterSignature='',initialized=false,revision=0;
  const filter=():import('../../shared/diaryProfiles').DiaryProfileFilter | undefined => !provider.state().enabled ? undefined
    :value==='all' ? {kind:'all'} :value==='unassigned' ? {kind:'unassigned'} : {kind:'profile',profileId:value};
  const label=() => value==='all' ? '모든 프로필' :value==='unassigned' ? '미배정 기록' :provider.label(value);
  const changed=() => {++revision;window.dispatchEvent(new CustomEvent('diary-profile-filter-changed'));};
  /**
   * 기능 계약: 조회 범위 표시와 조회 범위 변경 알림을 분리한다.
   * 프로필 이름·현재 사용 표시·전환 중(busy) 상태가 바뀌면 선택지 문구만 다시 그린다.
   * 일지 전체를 비우고 다시 읽는 'diary-profile-filter-changed'는 실제 조회 조건(filter(): 사용 여부·종류·프로필)이
   * 바뀔 때만 보낸다. 프로필 전환마다 화면이 깜박이고 타임라인 스크롤이 처음으로 돌아가지 않게 하기 위함이다.
   * 회귀: scripts/check-diary-profiles-ui.ts
   */
  const render=() => {
    const state=provider.state();
    const profiles=state.profiles;
    if(value!=='all' && value!=='unassigned' && !profiles.some(profile=>profile.id===value))value='all';
    const next=JSON.stringify([value,state.enabled,state.profiles,state.activeProfileId,state.selectionRequired,state.busy]);
    if (next===signature) return;
    signature=next;bar.hidden=!state.enabled;
    document.body.classList.toggle('diary-has-profiles',state.enabled);
    select.replaceChildren(new Option('모든 프로필','all'),new Option('미배정 기록','unassigned'));
    for (const profile of profiles) select.add(new Option(`${provider.label(profile.id)}${profile.id===state.activeProfileId && !state.selectionRequired ? ' · 현재 사용' : ''}`,profile.id));
    select.value=value;
    note.textContent=value==='unassigned' ? '조회 중: 미배정 기록. 아래 프로필 선택은 새 수동 기록의 저장 대상입니다.' : '조회 범위와 새 수동 기록의 저장 대상은 별도로 선택합니다.';
    renderArchives();
    const nextFilter=JSON.stringify(filter() ?? null);
    if (nextFilter===filterSignature) return;
    filterSignature=nextFilter;
    if (initialized) changed();
  };
  select.addEventListener('change',() => {value=select.value;render();});
  provider.subscribe(render);
  window.diaryProfileView={ready:provider.ready.then(() => {render();initialized=true;}),filter,key:() => JSON.stringify([filter() || {kind:'all'},revision]),label};
})();
