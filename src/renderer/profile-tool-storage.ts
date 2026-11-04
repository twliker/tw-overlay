interface Window {
  profileToolStorage:Pick<Storage,'getItem' | 'setItem' | 'removeItem'> & {
    ready:Promise<void>;flush():boolean;setFlusher(flush:() => boolean | string | void):void;profileId():string | null;
    prepareTransition():Promise<{success:boolean;error?:string}>;finishTransition(committed?:boolean):void;
  };
}
(() => {
  const api=(window.electronAPI || {}) as typeof window.electronAPI & Partial<import('../shared/profileTools').ProfileToolsApi> & {getConfig?:() => Promise<{activePlayProfileId?:string}>};
  let context:import('../shared/profileTools').ProfileToolContext={enabled:false,profileId:null,name:'',token:'',values:{}};
  let loaded=false,flush:() => boolean | string | void=() => '계산기를 준비하고 있습니다. 잠시 후 다시 선택해 주세요.',reloading=false;
  let transitionLocked=false,lastError='',transitionRevision=0,prepared=false;
  let status:HTMLElement | null=null;
  const report=(message:string) => {if (status) {status.hidden=false;status.textContent=message;}};
  const write=(key:string,value:string | null) => {
    if (!loaded) throw new Error('프로필 데이터를 준비하고 있습니다.');
    if (!context.enabled) {if (value===null) localStorage.removeItem(key);else localStorage.setItem(key,value);return;}
    if ((context.values[key] ?? null)===value) return;
    const result=api.writeProfileTool!(context.token,key as import('../shared/profileTools').ProfileToolKey,value);
    if (!result?.success) {report('저장하지 못했습니다. 입력값은 유지됩니다. 다시 시도해 주세요.');throw new Error(result?.error || '계산기 저장 실패');}
    if (value===null) delete context.values[key];else context.values[key]=value;
  };
  const safeFlush=() => {
    try {
      const result=flush();
      if (result===false || typeof result==='string') {
        lastError=typeof result==='string' ? result : '편집 중인 내용을 확인한 뒤 다시 선택해 주세요.';report(lastError);return false;
      }
      lastError='';return true;
    } catch {lastError='입력값을 저장하지 못해 프로필을 전환하지 않았습니다.';report(lastError);return false;}
  };
  const finishTransition=(committed=false) => {
    ++transitionRevision;prepared=committed;
    if (transitionLocked) {document.body.inert=false;document.body.removeAttribute('aria-busy');transitionLocked=false;}
  };
  const ready=(async () => {
    if (api.getProfileToolContext) context=await api.getProfileToolContext();
    loaded=true;
    await new Promise<void>(resolve => {if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',() => resolve(),{once:true});else resolve();});
    status=document.createElement('div');status.className='ui-description profile-tool-context';status.setAttribute('role','status');status.hidden=!context.enabled;
    if (context.enabled) status.textContent=`입력 프로필: ${context.name}`;
    const header=document.querySelector('.win-header');if (header) header.after(status);else document.body.prepend(status);
  })().catch(error => {
    const show=() => {status=document.createElement('p');status.className='ui-status';document.body.prepend(status);report('프로필 데이터를 불러오지 못했습니다. 창을 다시 열어 주세요.');};
    if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',show,{once:true});else show();
    throw error;
  });
  window.profileToolStorage={ready,getItem:key => {if (!loaded) throw new Error('프로필 데이터를 준비하고 있습니다.');return context.enabled ? context.values[key] ?? null : localStorage.getItem(key);},
    setItem:(key,value) => write(key,String(value)),removeItem:key => write(key,null),flush:safeFlush,setFlusher:value => {flush=value;},profileId:() => context.profileId,
    prepareTransition:async () => {
      const revision=++transitionRevision;prepared=false;
      await ready;
      if (revision!==transitionRevision) return {success:false,error:'프로필 전환을 취소했습니다.'};
      if (!context.enabled) return {success:true};
      transitionLocked=true;document.body.inert=true;document.body.setAttribute('aria-busy','true');
      const success=safeFlush();if (!success) finishTransition();
      return {success,error:lastError || undefined};
    },finishTransition};
  api.onProfileToolsChanged?.(change => {
    if (!loaded || change.profileId!==context.profileId) return;
    const previous=context.values[change.key] ?? null;if (previous===change.value) return;
    if (change.value===null) delete context.values[change.key];else context.values[change.key]=change.value;
    window.dispatchEvent(new StorageEvent('storage',{key:change.key,oldValue:previous,newValue:change.value,storageArea:localStorage}));
  });
  const changed=async () => {
    await ready;if (!context.enabled || reloading) return;
    const next=await api.getConfig?.();
    if (next?.activePlayProfileId && next.activePlayProfileId!==context.profileId && (prepared || safeFlush())) {reloading=true;location.reload();}
    else if (next?.activePlayProfileId===context.profileId) {
      const name=(next as typeof next & {characterPresets?:Array<{name:string}>}).characterPresets?.[0]?.name || context.name;
      if (name!==context.name) {context.name=name;report(`입력 프로필: ${name}`);}
    }
  };
  (api as typeof api & {onPlayProfilesChanged?:(callback:() => void) => void}).onPlayProfilesChanged?.(() => {void changed();});
})();
