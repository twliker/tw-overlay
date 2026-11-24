interface Window {
  profileToolStorage:Pick<Storage,'getItem' | 'setItem' | 'removeItem'> & {
    setItemIfUnchanged(key:string,value:string,expected:string | null):void;
    ready:Promise<void>;flush():boolean;setFlusher(flush:() => boolean | string | void):void;profileId():string | null;
    prepareTransition(token:string,expiresAt:number,purpose?:'switch' | 'sync'):Promise<{success:boolean;error?:string}>;finishTransition(token:string,committed?:boolean):void;
  };
}
(() => {
  const api=(window.electronAPI || {}) as typeof window.electronAPI & Partial<import('../shared/profileTools').ProfileToolsApi> & {getConfig?:() => Promise<{activePlayProfileId?:string}>};
  let context:import('../shared/profileTools').ProfileToolContext={enabled:false,profileId:null,name:'',token:'',values:{}};
  let loaded=false,flush:() => boolean | string | void=() => '계산기를 준비하고 있습니다. 잠시 후 다시 선택해 주세요.',reloading=false;
  let transitionOwner:string | null=null,lastError='',prepared=false;
  let status:HTMLElement | null=null;
  const report=(message:string) => {if (status) {status.hidden=false;status.textContent=message;}};
  const write=(key:string,value:string | null,expected?:string | null) => {
    if (!loaded) throw new Error('프로필 데이터를 준비하고 있습니다.');
    if (!context.enabled) {
      if (expected!==undefined && localStorage.getItem(key)!==expected) throw new Error('최신 계산 프리셋을 확인해 주세요.');
      if (value===null) localStorage.removeItem(key);else localStorage.setItem(key,value);return;
    }
    if (expected===undefined && (context.values[key] ?? null)===value) return;
    const result=api.writeProfileTool!(context.token,key as import('../shared/profileTools').ProfileToolKey,value,expected);
    if (!result?.success) {report(result?.error || '저장하지 못했습니다. 다시 시도해 주세요.');throw new Error(result?.error || '계산기 저장 실패');}
    if (value===null) delete context.values[key];else context.values[key]=value;
  };
  // quiet: Google 변경 반영을 위한 확인. 사용자가 프로필을 전환한 것이 아니므로 전환 안내를 창에 남기지 않는다.
  // 반영은 main이 미루고 환경설정의 Google 동기화에 안내한다. 회귀: check-profile-tools.ts.
  const safeFlush=(quiet=false) => {
    try {
      const result=flush();
      if (result===false || typeof result==='string') {
        lastError=typeof result==='string' ? result : '편집 중인 내용을 확인한 뒤 다시 선택해 주세요.';if (!quiet) report(lastError);return false;
      }
      lastError='';return true;
    } catch {lastError='입력값을 저장하지 못해 프로필을 전환하지 않았습니다.';if (!quiet) report(lastError);return false;}
  };
  const finishTransition=(token:string,committed=false) => {
    if (transitionOwner!==token) return;
    transitionOwner=null;prepared=committed;
    document.body.inert=false;document.body.removeAttribute('aria-busy');
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
    setItem:(key,value) => write(key,String(value)),setItemIfUnchanged:(key,value,expected)=>write(key,value,expected),
    removeItem:key => write(key,null),flush:safeFlush,setFlusher:value => {flush=value;},profileId:() => context.profileId,
    prepareTransition:async (token,expiresAt,purpose='switch') => {
      await ready;
      if (Date.now()>=expiresAt) return {success:false,error:'프로필 전환을 취소했습니다.'};
      if (transitionOwner) return {success:false,error:'다른 프로필 전환이 끝난 뒤 다시 시도해 주세요.'};
      if (!context.enabled) return {success:true};
      transitionOwner=token;prepared=false;document.body.inert=true;document.body.setAttribute('aria-busy','true');
      const success=safeFlush(purpose==='sync');if (!success) finishTransition(token);
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
