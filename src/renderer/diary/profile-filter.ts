interface Window {
  diaryProfileView:{ready:Promise<void>;filter():import('../../shared/diaryProfiles').DiaryProfileFilter | undefined;key():string;label():string};
}
(() => {
  const provider=window.diaryProfiles;
  const bar=document.getElementById('diary-profile-bar')!;
  const select=document.getElementById('diary-profile-filter') as HTMLSelectElement;
  const note=document.getElementById('diary-profile-note')!;
  let value='all',signature='',initialized=false,revision=0;
  const filter=():import('../../shared/diaryProfiles').DiaryProfileFilter | undefined => !provider.state().enabled ? undefined
    :value==='all' ? {kind:'all'} :value==='unassigned' ? {kind:'unassigned'} : {kind:'profile',profileId:value};
  const label=() => value==='all' ? '모든 프로필' :value==='unassigned' ? '미배정 기록' :provider.label(value);
  const changed=() => {++revision;window.dispatchEvent(new CustomEvent('diary-profile-filter-changed'));};
  const render=() => {
    const state=provider.state();
    const next=JSON.stringify([state.enabled,state.profiles,state.activeProfileId,state.selectionRequired]);
    if (next===signature) return;
    signature=next;bar.hidden=!state.enabled;
    document.body.classList.toggle('diary-has-profiles',state.enabled);
    select.replaceChildren(new Option('모든 프로필','all'),new Option('미배정 기록','unassigned'));
    const profiles=[...state.profiles].sort((a,b) => Number(b.id===state.activeProfileId && !state.selectionRequired)-Number(a.id===state.activeProfileId && !state.selectionRequired));
    for (const profile of profiles) select.add(new Option(`${provider.label(profile.id)}${profile.id===state.activeProfileId && !state.selectionRequired ? ' · 현재 사용' : ''}`,profile.id));
    select.value=value;
    note.textContent=state.selectionRequired ? '플레이 프로필 선택 전입니다. 조회 범위는 기록할 프로필과 별도로 적용됩니다.' : `사용 중: ${provider.label(state.activeProfileId!)}. 저장 대상은 기록 입력에서 선택하세요.`;
    if (initialized) changed();
  };
  select.addEventListener('change',() => {value=select.value;changed();});
  provider.subscribe(render);
  window.diaryProfileView={ready:provider.ready.then(() => {render();initialized=true;}),filter,key:() => JSON.stringify([filter() || {kind:'all'},revision]),label};
})();
