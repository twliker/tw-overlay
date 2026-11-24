interface Window {
  profileChecklist:{api:typeof window.electronAPI;enabled():boolean;acceptConfig(config:BrowserAppConfig):void;editorOpened():void;
    submitEditor(quiet?:boolean):Promise<boolean>;status():{ready:boolean;profileId:string | null;name:string;dirty:boolean;busy:boolean;prompt:boolean;uncertain:boolean};lock():void;finish():void};
}
(() => {
  type Request=import('../../shared/profileChecklist').ProfileChecklistRequest;
  type Result=import('../../shared/profileChecklist').ProfileChecklistResult;
  type Action=import('../../shared/profileChecklist').ProfileChecklistAction;
  type EditValues=import('../../shared/profileChecklist').ChecklistEditValues;
  const api=() => (window.electronAPI || {}) as typeof window.electronAPI & Partial<import('../../shared/profileChecklist').ProfileChecklistApi>;
  const host=window as typeof window & {getChecklistProfileState():{config:BrowserAppConfig | null;editingId:string | null};
    receiveChecklistConfig(config:BrowserAppConfig):void;resetForm():void;updateFormVisibility():void;showCustomItemFeedback(message:string,success:boolean):void};
  const mapping:Record<string,Action>={contentsToggleItem:'toggleItem',contentsUpdateCount:'updateItemCount',contentsToggleExclude:'toggleExcludeItem',
    contentsToggleVisibility:'toggleVisibility',contentsUpdateCategory:'updateCategory',contentsUpdateName:'updateName',contentsUpdateItem:'updateItem',
    contentsAddCustom:'addCustomItem',contentsRemoveItem:'removeItem',contentsMoveItem:'moveItem',contentsMoveCategory:'moveCategory',
    contentsReorderItem:'reorderItem',contentsReorderCategory:'reorderCategory',contentsManualReset:'checkReset',contentsApplyPending:'applyPendingHomeworks',contentsClearPending:'clearPendingHomeworks'};
  const fields=['new-item-name','new-item-category','new-item-type','new-item-hour','new-item-day','new-item-max-count'];
  const guideIds=['checklist-guide-title','checklist-guide-description','checklist-guide-manage-title','checklist-guide-manage-description','checklist-guide-exclude','checklist-guide-complete'];
  const legacyGuide=new Map(guideIds.map(id => [id,Array.from(document.getElementById(id)?.childNodes || []).map(node => node.cloneNode(true))]));
  const state=() => host.getChecklistProfileState?.() || {config:null,editingId:null};
  const form=() => ({editingId:state().editingId,values:fields.map(id => (document.getElementById(id) as HTMLInputElement)?.value || '')});
  const signature=() => JSON.stringify(form());
  // 입력 한도는 shared/profileChecklist.ts의 isProfileChecklistRequest와 같다(이름 200자·카테고리 100자·횟수 1~10000).
  // 이 스크립트는 런타임 import가 없어 값을 옮겨 적는다. 한도를 바꾸면 contents-checker.html의 maxlength/max도 함께 바꾼다.
  const NAME_MAX=200,CATEGORY_MAX=100,COUNT_MAX=10000;
  // 횟수 칸을 비우거나 소수를 넣어도 레거시 경로(parseInt || 1)와 같게 보정한다. 0을 보내면 서버가 거부해 같은 실패를 반복한다.
  const weeklyCount=(max:string):number => Math.min(COUNT_MAX,Math.max(1,Number.parseInt(max,10) || 1));
  const editValues=([name,category,type,hour,day,max]:string[]):EditValues => [name.trim(),category.trim() || '기타',
    type==='weekly' ? {type,hour:Number(hour),dayOfWeek:Number(day)} : {type:'daily',hour:Number(hour)},type==='weekly' ? weeklyCount(max) : 1];
  let editStart:{id:string;values:EditValues} | undefined;
  let editorRevision=0;
  const editorArguments=(snapshot:ReturnType<typeof form>,values=editValues(snapshot.values)):unknown[] | undefined=>{
    if (!snapshot.editingId) return values;
    if (editStart?.id!==snapshot.editingId) return;
    return [snapshot.editingId,structuredClone(editStart.values),values];
  };
  let owner:string | undefined,baseline='',pending=0,locked=false,transitionSave=false,failed:Request | null=null,uncertain=false;
  const enabled=() => !!state().config?.activePlayProfileId && !!api().mutateProfileChecklist;
  const statusElement=() => document.getElementById('checklist-profile-status');
  const report=(message:string,success=false) => {const el=statusElement();if (el) {el.textContent=message;el.dataset.saveState=success ? 'success' : '';}};
  const updateBusy=() => {const table=document.getElementById('matrix-table');if (table) table.inert=locked || pending>0;};
  function retryUi():void {const button=document.getElementById('checklist-profile-retry');if (button) button.hidden=!failed;}
  async function invoke(kind:Action,args:unknown[],retry?:Request):Promise<Result> {
    if (pending || locked && !transitionSave) return {success:false,error:'숙제를 저장 중입니다.'};
    const id=host.getChecklistProfileState().config?.activePlayProfileId;
    if (!id) return {success:false,error:'숙제 프로필을 먼저 선택해 주세요.'};
    const request=retry || {requestId:crypto.randomUUID(),createdAt:Date.now(),profileId:id,kind,args} as Request;
    failed=null;uncertain=false;retryUi();++pending;updateBusy();report('숙제를 저장하고 있습니다…');
    try {
      const result=await api().mutateProfileChecklist!(request);
      if (result.conflict) report('');
      else if (!result.success) {failed=request;report(result.error || '숙제를 저장하지 못했습니다. 다시 시도해 주세요.');}
      else if (host.getChecklistProfileState().config?.activePlayProfileId===request.profileId) {
        if (result.config) host.receiveChecklistConfig(result.config);
        report('저장했습니다.');
      }
      return result;
    } catch {
      failed=request;uncertain=true;report('저장 결과를 확인하지 못했습니다. 다시 확인을 눌러 주세요.');
      return {success:false,error:'저장 결과를 확인하지 못했습니다. 입력은 유지됩니다.'};
    } finally {--pending;updateBusy();retryUi();}
  }
  const proxied=new Proxy({} as typeof window.electronAPI,{get:(target,key) => (target as unknown as Record<PropertyKey,unknown>)[key] ?? (api() as unknown as Record<PropertyKey,unknown>)[key]});
  for (const [method,kind] of Object.entries(mapping)) {
    (proxied as unknown as Record<string,unknown>)[method]=(...args:unknown[]) => {
      if (!enabled()) return (api() as unknown as Record<string,(...values:unknown[]) => unknown>)[method](...args);
      return invoke(kind,args);
    };
  }
  async function submitEditor(quiet=false):Promise<boolean> {
    if (pending) return false;
    const submittedOwner=state().config?.activePlayProfileId;
    const snapshot=form(),serialized=JSON.stringify(snapshot),values=editValues(snapshot.values),[name]=values;
    const revision=editorRevision;
    if (!name) {host.showCustomItemFeedback('숙제 이름을 입력해 주세요.',false);return false;}
    if (name.length>NAME_MAX) {host.showCustomItemFeedback(`숙제 이름은 ${NAME_MAX}자까지 입력할 수 있습니다.`,false);return false;}
    if (values[1].length>CATEGORY_MAX) {host.showCustomItemFeedback(`카테고리는 ${CATEGORY_MAX}자까지 입력할 수 있습니다.`,false);return false;}
    const args=editorArguments(snapshot,values);
    if (!args) return false;
    const kind=snapshot.editingId ? 'editItem' : 'addCustomItem';
    const previous=failed;
    const retry=previous && previous.kind===kind && previous.profileId===owner && JSON.stringify(previous.args)===JSON.stringify(args) ? previous : undefined;
    const button=document.getElementById('btn-add-item') as HTMLButtonElement;
    button.disabled=true;button.textContent=snapshot.editingId ? '저장 중…' : '추가 중…';
    try {
      const result=await invoke(kind,args,retry);
      if (state().config?.activePlayProfileId!==submittedOwner) return result.success;
      if (!result.success) {
        if (revision!==editorRevision) return false;
        host.showCustomItemFeedback(result.error || '저장하지 못했습니다. 입력은 유지됩니다.',false);
        if (result.conflict && signature()===serialized) showConflictChoices(result.conflict,serialized);
        return false;
      }
      const unchanged=signature()===serialized;
      if (unchanged) {host.resetForm();baseline=signature();}
      host.showCustomItemFeedback(`${snapshot.editingId ? '수정' : '추가'} 완료 · ‘${name.trim()}’ 숙제를 저장했습니다.`,true);
      report(snapshot.editingId ? '✓ 수정 완료' : '✓ 추가 완료',true);
      if (!quiet && unchanged) document.getElementById('new-item-name')?.focus({preventScroll:true});
      if (!quiet && unchanged && result.itemId) reveal(result.itemId);
      return true;
    } finally {button.disabled=false;button.textContent=host.getChecklistProfileState().editingId ? '수정 완료' : '목록에 추가하기';}
  }
  function showConflictChoices(conflict:NonNullable<Result['conflict']>,submittedForm:string):void {
    const feedback=document.getElementById('custom-item-feedback');
    const actions=document.createElement('div');actions.className='mt-2 flex flex-wrap gap-2';
    const [name,category,rule,max]=conflict.current;
    for (const useLatest of [true,false]) {
      const button=document.createElement('button');button.type='button';button.className='ui-button';
      button.textContent=useLatest ? '최신 값 사용' : '내 입력으로 저장';
      button.addEventListener('click',()=>{
        if (!editStart || signature()!==submittedForm) {
          host.showCustomItemFeedback('입력이 바뀌었습니다. 내용을 확인하고 다시 저장해 주세요.',false);return;
        }
        const fieldsToSet:Record<string,string>={};
        if (conflict.fields.includes(0)) {editStart.values[0]=name;fieldsToSet['new-item-name']=name;}
        if (conflict.fields.includes(1)) {editStart.values[1]=category;fieldsToSet['new-item-category']=category;}
        if (conflict.fields.includes(2)) {
          editStart.values[2]=rule;editStart.values[3]=max;
          Object.assign(fieldsToSet,{'new-item-type':rule.type,'new-item-hour':String(rule.hour ?? 0),
            'new-item-day':String(rule.dayOfWeek ?? 1),'new-item-max-count':String(max)});
        }
        if (useLatest) {
          for (const [id,value] of Object.entries(fieldsToSet)) (document.getElementById(id) as HTMLInputElement).value=value;
          host.updateFormVisibility();
        }
        actions.remove();void submitEditor();
      });
      actions.append(button);
    }
    feedback?.append(actions);
  }
  function reveal(id:string):void {
    const config=host.getChecklistProfileState().config,item=config?.contentsCheckerItems?.find(row => row.id===id);
    const query=(document.getElementById('search-input') as HTMLInputElement).value.trim().toLowerCase();
    if (!item) return;
    if (query && !item.name.toLowerCase().includes(query) && !item.category.toLowerCase().includes(query)) {
      host.showCustomItemFeedback(`추가 완료 · ‘${item.name}’ (현재 검색 조건에서는 표시되지 않습니다.)`,true);return;
    }
    // 펼침/스크롤은 기존 제품 함수를 사용해 다음 입력과 검색어를 보존한다.
    (window as typeof window & {revealProfileChecklistItem(id:string):void}).revealProfileChecklistItem(id);
  }
  window.profileChecklist={api:proxied,enabled,editorOpened:() => {
    const snapshot=form();baseline=JSON.stringify(snapshot);editorRevision++;
    editStart=snapshot.editingId ? {id:snapshot.editingId,values:editValues(snapshot.values)} : undefined;
    const feedback=document.getElementById('custom-item-feedback');
    feedback?.replaceChildren();feedback?.classList.add('hidden');
  },submitEditor,
    acceptConfig(config) {
      const id=config.activePlayProfileId;
      if (owner!==undefined && owner!==id) {
        host.resetForm();
        for (const [field,value] of [['new-item-type','daily'],['new-item-hour','0'],['new-item-day','1']]) (document.getElementById(field) as HTMLInputElement).value=value;
        host.updateFormVisibility();baseline=signature();failed=null;uncertain=false;retryUi();report('');
        document.getElementById('custom-item-feedback')?.classList.add('hidden');
      }
      owner=id;if (!baseline) baseline=signature();
      document.body.classList.toggle('profile-checklist-mode',!!id);
      const bar=document.getElementById('checklist-profile-context');if (bar) bar.hidden=!id;
      const title=document.getElementById('checklist-profile-target');
      const server=config.userServer===7 ? '하이아칸' : config.userServer===16 ? '네냐플' : '서버 선택 필요';
      if (title) {title.textContent=`숙제 프로필: ${config.characterPresets?.[0]?.name || '기본 프로필'} · ${server}`;title.title=title.textContent;}
      const manage=document.getElementById('btn-char-mgmt');manage?.setAttribute('title',id ? '프로필 관리' : '캐릭터 관리');manage?.setAttribute('aria-label',id ? '프로필 관리' : '캐릭터 관리');
      if (id) {document.getElementById('char-modal')?.classList.add('hidden');document.getElementById('pending-modal')?.classList.add('hidden');}
      const descriptions=[['checklist-guide-title',id ? '프로필별 숙제' : '다캐릭 매트릭스 UI'],
        ['checklist-guide-description',id ? '현재 프로필의 숙제와 완료·제외 상태를 표시합니다. 다른 프로필의 숙제는 프로필 관리에서 전환해 확인하세요.' : '숙제(좌측)와 캐릭터(상단) 이름이 고정됩니다. Shift + 휠 스크롤로 가로로 이동할 수 있습니다.'],
        ['checklist-guide-manage-title',id ? '프로필 관리' : '캐릭터 관리'],
        ['checklist-guide-manage-description',id ? '상단 보라색 버튼에서 프로필을 추가하거나 선택할 수 있습니다. 프로필 이름은 자유롭게 정합니다.' : '상단 보라색 버튼에서 캐릭터를 추가하거나 이름을 수정합니다.'],
        ['checklist-guide-exclude',id ? '관리 모드에서 클릭하면 현재 프로필을 해당 숙제에서 제외합니다.' : '관리 모드에서 클릭하면 해당 캐릭터를 숙제에서 제외합니다.'],
        ['checklist-guide-complete',id ? '현재 프로필이 수행을 끝낸 숙제는 완료됨 섹션으로 이동합니다.' : '모든 참여 캐릭터가 숙제를 끝내면 완료됨 섹션으로 이동합니다.']];
      for (const [field,text] of descriptions) {
        const el=document.getElementById(field);if (!el) continue;
        if (id) el.textContent=text;else el.replaceChildren(...(legacyGuide.get(field) || []).map(node => node.cloneNode(true)));
      }
      updateBusy();
    },
    status() {const value=state();return {ready:!!value.config,profileId:value.config?.activePlayProfileId || null,
      name:value.config?.characterPresets?.[0]?.name || '기본 프로필',dirty:signature()!==baseline,busy:pending>0,
      prompt:!document.getElementById('custom-prompt')?.classList.contains('hidden'),uncertain};},
    lock() {locked=true;document.body.inert=true;document.body.setAttribute('aria-busy','true');updateBusy();},
    finish() {locked=false;document.body.inert=false;document.body.removeAttribute('aria-busy');updateBusy();},
  };
  document.getElementById('checklist-profile-retry')?.addEventListener('click',async () => {
    const request=failed;if (!request) return;
    const editor=request.kind==='addCustomItem' || request.kind==='editItem';
    const snapshot=signature(),editorArgs=editorArguments(form()),revision=editorRevision;
    const matches=editor && JSON.stringify(editorArgs)===JSON.stringify(request.args);
    const result=await invoke(request.kind,request.args,request);
    if (result.conflict && matches && editorRevision===revision && signature()===snapshot) {
      host.showCustomItemFeedback(result.error || '다른 곳에서 숙제를 수정했습니다.',false);
      showConflictChoices(result.conflict,snapshot);
    }
    if (result.success && editor && state().config?.activePlayProfileId===request.profileId) {
      if (matches && signature()===snapshot) host.resetForm();
      host.showCustomItemFeedback('저장 결과를 확인했습니다. 숙제에 반영되어 있습니다.',true);report('✓ 저장 확인');
    }
  });
  // 전환 저장만 입력 잠금 안에서 허용한다.
  const submit=window.profileChecklist.submitEditor;
  window.profileChecklist.submitEditor=async quiet => {transitionSave=quiet===true;try {return await submit(quiet);} finally {transitionSave=false;}};
  const wrapper=document.querySelector('.matrix-wrapper');
  if (wrapper) new ResizeObserver(() => document.body.classList.toggle('profile-checklist-compact',enabled() && wrapper.clientHeight<220)).observe(wrapper);
})();
