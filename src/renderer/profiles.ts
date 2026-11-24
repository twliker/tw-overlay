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
  let editorOpen=false;
  let orderMode=false;
  let draggedId:string | null=null,dragOrder:string[] | null=null;
  let dragSource:HTMLElement | null=null,dragTarget:HTMLElement | null=null;
  let working=false;
  let allowClose=false;
  let closeQuestion=false;
  let homework:Status['homeworkProgress'];
  let pendingDetails:Status['pendingDetails'];
  let pendingPage=0,pendingPageSize=25,reviewingPending=false;
  let homeworkTimer:number | undefined,resetTimer:number | undefined;
  let homeworkLoading=false,homeworkQueued=false,homeworkRevision=0,lastHomeworkRead=Number.NEGATIVE_INFINITY;
  const values=() => [name.value,server.value,editing===null ? copy.value : ''];
  let baseline=values();
  const dirty=() => values().some((value,index)=>value!==baseline[index]);
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
  function finishDrag():void {
    if(dragSource)delete dragSource.dataset.dragging;
    if(dragTarget)delete dragTarget.dataset.drop;
    draggedId=null;dragOrder=null;dragSource=null;dragTarget=null;
  }
  async function reorder(ids:string[],movedId:string):Promise<void> {
    const current=state?.profiles.map(profile=>profile.id);
    if(!current || JSON.stringify(current)===JSON.stringify(ids))return;
    finishDrag();
    const result=await perform(()=>api.reorderPlayProfiles(ids),'프로필 순서를 저장했습니다.');
    if(result?.success) {
      const row=Array.from(element('profiles-list').querySelectorAll<HTMLElement>('.profile-row')).find(node=>node.dataset.profileId===movedId);
      row?.querySelector<HTMLButtonElement>('.profile-drag-handle')?.focus({preventScroll:true});row?.scrollIntoView({block:'nearest'});
    }
  }
  function moveProfile(id:string,direction:-1 | 1):void {
    if(!state || working || state.busy)return;
    const ids=state.profiles.map(profile=>profile.id),index=ids.indexOf(id),next=index+direction;
    if(index<0 || next<0 || next>=ids.length)return;
    [ids[index],ids[next]]=[ids[next],ids[index]];void reorder(ids,id);
  }
  function addOrderControls(profile:Profile,index:number,row:HTMLElement,identity:HTMLElement,actions:HTMLElement):void {
    const handle=button('⠿',()=>message('손잡이를 드래그하거나 ↑·↓ 방향키로 순서를 바꿀 수 있습니다.'));
    handle.classList.add('profile-drag-handle');handle.draggable=!handle.disabled;handle.dataset.focusKey=`order:${profile.id}`;
    handle.title='드래그 또는 ↑·↓ 방향키로 이동';handle.setAttribute('aria-label',`${profile.name || '기본 프로필'} 순서 이동`);
    handle.addEventListener('keydown',event=>{if(event.key==='ArrowUp' || event.key==='ArrowDown') {event.preventDefault();moveProfile(profile.id,event.key==='ArrowUp' ? -1 : 1);}});
    handle.addEventListener('dragstart',event=>{
      if(working || state?.busy || !orderMode) {event.preventDefault();return;}
      draggedId=profile.id;dragOrder=state!.profiles.map(item=>item.id);dragSource=row;row.dataset.dragging='true';
      if(event.dataTransfer) {event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',profile.id);}
    });
    handle.addEventListener('dragend',finishDrag);identity.prepend(handle);
    for(const [label,direction] of [['↑',-1],['↓',1]] as const) {
      const move=button(label,()=>moveProfile(profile.id,direction));move.dataset.focusKey=`move:${direction}:${profile.id}`;
      move.title=direction===-1 ? '위로 이동' : '아래로 이동';move.setAttribute('aria-label',`${profile.name || '기본 프로필'} ${move.title}`);
      move.disabled=move.disabled || (direction===-1 ? index===0 : index===(state?.profiles.length || 0)-1);actions.append(move);
    }
    row.addEventListener('dragover',event=>{
      if(!draggedId || draggedId===profile.id || working || state?.busy)return;
      event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';
      if(dragTarget && dragTarget!==row)delete dragTarget.dataset.drop;
      dragTarget=row;const bounds=row.getBoundingClientRect();row.dataset.drop=event.clientY>bounds.top+bounds.height/2 ? 'after' : 'before';
    });
    row.addEventListener('dragleave',event=>{if(!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget))delete row.dataset.drop;});
    row.addEventListener('drop',event=>{
      if(!draggedId || !dragOrder || draggedId===profile.id || working || state?.busy) {finishDrag();return;}
      event.preventDefault();
      const moving=draggedId,original=dragOrder;
      if(JSON.stringify(original)!==JSON.stringify(state?.profiles.map(item=>item.id))) {finishDrag();message('프로필 목록이 변경되었습니다. 다시 순서를 바꿔 주세요.',true);return;}
      const ids=original.filter(id=>id!==moving),bounds=row.getBoundingClientRect();
      const target=ids.indexOf(profile.id)+(event.clientY>bounds.top+bounds.height/2 ? 1 : 0);ids.splice(target,0,moving);
      finishDrag();void reorder(ids,moving);
    });
  }
  function renderHomeworkProgress():void {
    for(const row of Array.from(element('profiles-list').querySelectorAll<HTMLElement>('.profile-row'))) {
      const target=row.querySelector<HTMLElement>('.profile-homework-progress');if(!target)continue;
      const progress=homework?.profiles[row.dataset.profileId || ''];
      const unavailable=homework===null;
      const signature=JSON.stringify([progress,unavailable,state?.busy]);if(target.dataset.signature===signature)continue;
      target.replaceChildren();target.dataset.signature=signature;
      target.setAttribute('aria-busy',String(!progress && !unavailable || !!state?.busy));
      for(const [period,label] of [['daily','일일'],['weekly','주간']] as const) {
        const value=progress?.[period],percent=value && value.total>0 ? Math.round(value.done/value.total*100) : 0;
        const panel=document.createElement('div');panel.className='profile-progress-period';panel.dataset.period=period;
        const heading=document.createElement('div');heading.className='profile-progress-heading';
        const title=document.createElement('span');title.textContent=label;
        const ratio=document.createElement('span');ratio.className='profile-progress-percent';ratio.textContent=value ? value.total>0 ? `${percent}%` : '—' : '';
        heading.append(title,ratio);
        const count=document.createElement('span');count.className='profile-progress-count';
        count.textContent=value ? value.total>0 ? `${value.done} / ${value.total}` : '대상 없음' : unavailable && !state?.busy ? '확인 불가' : '확인 중';
        const bar=document.createElement('progress');bar.className='profile-progress-bar';bar.max=100;bar.value=percent;
        bar.setAttribute('aria-label',`${label} 숙제 ${value ? value.total>0 ? `${value.total}개 중 ${value.done}개 완료` : '대상 없음' : unavailable ? '현황 확인 불가' : '현황 확인 중'}`);
        panel.append(heading,count,bar);target.append(panel);
      }
    }
  }
  function acceptHomework(next:Status['homeworkProgress']):void {
    homework=next;renderHomeworkProgress();
    if(resetTimer!==undefined)clearTimeout(resetTimer);resetTimer=undefined;
    if(next?.nextResetAt)resetTimer=window.setTimeout(queueHomeworkRefresh,Math.max(50,Math.min(2_147_483_647,next.nextResetAt-next.generatedAt+50)));
  }
  function queueHomeworkRefresh():void {
    ++homeworkRevision;
    if(homeworkLoading || homeworkTimer!==undefined) {homeworkQueued=true;return;}
    homeworkTimer=window.setTimeout(()=>{homeworkTimer=undefined;void refreshHomework();},Math.max(0,1000-(performance.now()-lastHomeworkRead)));
  }
  async function refreshHomework():Promise<void> {
    if(!state || state.busy)return;
    homeworkLoading=true;homeworkQueued=false;
    const revision=homeworkRevision,requestedPage=pendingPage;
    try {
      const next=await api.getPlayProfiles(requestedPage);
      // 목록/선택/입력은 조회 응답으로 교체하지 않는다. 변경 알림 뒤 도착한 오래된 현황도 버린다.
      if(revision===homeworkRevision) {
        acceptPendingPage(next);
        acceptHomework(next?.homeworkProgress ?? null);
        renderPending();
      } else if (!state.busy && pendingPage===requestedPage && next?.pendingPage?.index===requestedPage && next.pendingDetails) {
        // 세션별 표시에서 최신 목록의 건수/시각과 맞는 요약만 사용한다.
        pendingDetails=next.pendingDetails;
        renderPending();
      }
    } catch {if(revision===homeworkRevision) {pendingDetails=null;acceptHomework(null);renderPending();}}
    finally {homeworkLoading=false;lastHomeworkRead=performance.now();if(homeworkQueued)queueHomeworkRefresh();}
  }
  function acceptPendingPage(next:Status | null):void {
    if (next?.pendingPage) {
      pendingPage=next.pendingPage.index;
      pendingPageSize=next.pendingPage.size;
    }
    pendingDetails=next?.pendingDetails ?? null;
  }
  function render():void {
    const list=element('profiles-list');
    if((state?.profiles.length || 0)<2)orderMode=false;
    // 대기 기록 개수 알림은 잦다. 프로필 목록이 바뀌지 않으면 DOM과 키보드 포커스를 유지한다.
    const signature=JSON.stringify([state?.profiles,state?.activeProfileId,state?.selectionRequired,editing,editorOpen,orderMode,working,state?.busy]);
    if (list.dataset.signature!==signature) {
      finishDrag();
      const focus=document.activeElement as HTMLElement | null;
      const focusKey=list.contains(focus) ? focus?.dataset.focusKey : undefined;
      list.replaceChildren();
      for (const [index,profile] of (state?.profiles || []).entries()) {
        const row=document.createElement('article');row.className='profile-row';row.dataset.profileId=profile.id;row.dataset.editing=String(editorOpen && editing===profile.id);
        const identity=document.createElement('div');identity.className='profile-identity';
        const title=document.createElement('strong');title.textContent=profile.name || '기본 프로필';
        const detail=document.createElement('p');detail.textContent=profile.userServer===7 ? '하이아칸' : profile.userServer===16 ? '네냐플' : '사용하려면 서버를 선택하세요.';
        identity.append(title,detail);
        if (state?.activeProfileId===profile.id) {const badge=document.createElement('span');badge.className='profile-badge';badge.textContent=state.selectionRequired ? '마지막 사용 프로필' : '현재 사용 중';identity.append(badge);}
        row.append(identity);
        const progress=document.createElement('div');progress.className='profile-homework-progress';progress.setAttribute('aria-label','숙제 진행 현황');row.append(progress);
        const actions=document.createElement('div');actions.className='profile-row-actions';
        const edit=button('수정',() => {void changeEditor(profile.id);});edit.dataset.focusKey=`edit:${profile.id}`;
        const use=button('사용',() => {void useProfile(profile);},'ui-button ui-button-primary');use.dataset.focusKey=`use:${profile.id}`;
        if(orderMode)addOrderControls(profile,index,row,identity,actions);else actions.append(use,edit);
        row.append(actions);list.append(row);
      }
      list.dataset.signature=signature;
      if (focusKey) Array.from(list.querySelectorAll<HTMLElement>('[data-focus-key]')).find(node => node.dataset.focusKey===focusKey)?.focus();
    }
    renderHomeworkProgress();
    element('profile-editor').hidden=!editorOpen;element('profiles-columns').dataset.editorOpen=String(editorOpen);
    const disabled=working || !!state?.busy || !state;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,select,button').forEach(node => {node.disabled=disabled;});
    element<HTMLButtonElement>('new-profile').disabled=disabled;
    const orderButton=element<HTMLButtonElement>('reorder-profiles');orderButton.hidden=(state?.profiles.length || 0)<2;orderButton.disabled=disabled;
    orderButton.textContent=orderMode ? '순서 변경 완료' : '순서 변경';orderButton.setAttribute('aria-pressed',String(orderMode));
    element('profile-order-note').hidden=!orderMode;
    element<HTMLButtonElement>('close-editor').disabled=disabled;
    const notice=element('selection-notice');
    notice.dataset.required=String(!!state?.selectionRequired);
    if (state) element('selection-notice-text').textContent=state.selectionRequired ? '프로필을 선택해 주세요. 선택 전 자동 기록은 보관한 뒤 이번 플레이에 함께 반영합니다.' : `${state.profiles.find(p => p.id===state!.activeProfileId)?.name || '기본 프로필'} 프로필을 사용하고 있습니다.`;
    renderPending();
  }
  function sessionDetails(session:Status['pendingSessions'][number]):NonNullable<Status['pendingDetails']>[string] | undefined {
    const details=pendingDetails?.[session.sessionId];
    return details && details.count===session.count && details.firstOccurredAt===session.firstOccurredAt && details.lastOccurredAt===session.lastOccurredAt ? details : undefined;
  }
  /** 대기 기록 시각 표시. 시각이 손상된 구형 보류 숙제는 occurred_at 0으로 보존되므로(legacyHomework 계약)
   * 1970년이 아니라 '시각 미상'으로 표시한다. 세션은 알려진 가장 이른 시각을 쓴다. 회귀: check-profiles-ui.ts */
  const pendingTime=(value:number,mode:'full' | 'time'='full')=>value>0
    ? (mode==='time' ? new Date(value).toLocaleTimeString('ko-KR') : new Date(value).toLocaleString('ko-KR')) : '시각 미상';
  const sessionTime=(session:Status['pendingSessions'][number])=>pendingTime(session.firstOccurredAt>0 ? session.firstOccurredAt : session.lastOccurredAt);
  const categorySummary=(details:NonNullable<Status['pendingDetails']>[string])=>details.categories.map(item=>`${item.label} ${item.count.toLocaleString()}${item.unit || '건'}`).join(' · ');
  function renderPending():void {
    const sessions=state?.pendingSessions.filter(session=>session.sessionId!==state?.sessionId) || [];
    const pageCount=Math.max(1,Math.ceil(sessions.length/pendingPageSize));
    pendingPage=Math.max(0,Math.min(pendingPage,pageCount-1));
    const previousSessions=sessions.slice(pendingPage*pendingPageSize,(pendingPage+1)*pendingPageSize);
    element('pending-section').hidden=sessions.length===0;
    const pending=element('pending-sessions'),disabled=working || !!state?.busy || !state;
    element('pending-pages').hidden=pageCount<=1;
    element('pending-page-label').textContent=`${pendingPage+1} / ${pageCount}`;
    element<HTMLButtonElement>('pending-previous').disabled=disabled || pendingPage===0;
    element<HTMLButtonElement>('pending-next').disabled=disabled || pendingPage+1>=pageCount;
    const signature=JSON.stringify([previousSessions,previousSessions.map(sessionDetails),pendingDetails===null,disabled,state?.selectionRequired]);
    if(pending.dataset.signature===signature)return;
    const expanded=new Set(Array.from(pending.querySelectorAll<HTMLElement>('.pending-row')).filter(row=>row.querySelector('details')?.open).map(row=>row.dataset.sessionId));
    const focus=document.activeElement as HTMLElement | null,focusId=pending.contains(focus) ? focus?.dataset.pendingFocus : undefined;
    pending.replaceChildren();pending.dataset.signature=signature;
    for (const session of previousSessions) {
      const row=document.createElement('div');row.className='pending-row';row.dataset.sessionId=session.sessionId;
      const preview=document.createElement('div');preview.className='pending-preview';
      const date=document.createElement('p');date.className='pending-date';date.textContent=`${sessionTime(session)} · 보관된 기록 ${session.count.toLocaleString()}건`;
      const summary=document.createElement('p');summary.className='pending-summary';
      const details=sessionDetails(session);summary.textContent=details ? categorySummary(details) : pendingDetails===null ? '기록 내용을 불러오지 못했습니다.' : '기록 내용을 확인하는 중입니다…';
      preview.append(date,summary);
      // 안내문은 모두 preview(1열) 안에 둔다. row에 직접 붙이면 2열 그리드가 [안내, preview, 버튼] 3칸으로 밀린다.
      if(details?.orphanedCount) preview.append(Object.assign(document.createElement('p'),{className:'pending-sample',textContent:`삭제된 프로필에 연결된 기록 ${details.orphanedCount}건`}));
      if(details?.unassignableCount) {
        const warning=document.createElement('p');warning.className='pending-sample';warning.textContent=details.unassignableCount===session.count
          ? '필수 정보가 누락되어 배정할 수 없습니다. 무시하기로 대기 목록에서 정리할 수 있습니다.'
          : '필수 정보가 누락된 기록은 배정 후에도 대기 목록에 남습니다.';preview.append(warning);
      }
      if(details?.samples.length) {
        const latest=document.createElement('p');latest.className='pending-sample';latest.textContent=details.samples.at(-1)!.text;preview.append(latest);
        if(details.samples.length>1) {
          const disclosure=document.createElement('details');disclosure.open=expanded.has(session.sessionId);
          const toggle=document.createElement('summary');toggle.textContent=`최근 감지 내용 ${details.samples.length}개 보기`;toggle.dataset.pendingFocus=`details:${session.sessionId}`;
          const samples=document.createElement('ul');
          for(const item of details.samples) {const entry=document.createElement('li');entry.textContent=`${pendingTime(item.occurredAt,'time')} · ${item.text}`;samples.append(entry);}
          disclosure.append(toggle,samples);preview.append(disclosure);
        }
      }
      const actions=document.createElement('div');actions.className='pending-actions';
      if(details?.orphanedCount) {
        const release=button('미배정으로 이동',()=>{void releaseOrphanedSession(session);});
        release.disabled=disabled;
        release.dataset.pendingFocus=`release:${session.sessionId}`;
        actions.append(release);
      } else if(details?.unassignableCount!==session.count) {
        const assign=button('현재 프로필로 배정',()=>{void assignSession(session);});assign.disabled=disabled || !!state?.selectionRequired || !details;assign.dataset.pendingFocus=`assign:${session.sessionId}`;actions.append(assign);
      }
      const ignore=button('무시하기',()=>{void ignoreSession(session);});ignore.dataset.pendingFocus=`ignore:${session.sessionId}`;
      ignore.disabled=disabled || !details;actions.append(ignore);
      if(!details && pendingDetails===null) {
        const retry=button('다시 확인',queueHomeworkRefresh);retry.dataset.pendingFocus=`retry:${session.sessionId}`;retry.disabled=disabled;actions.append(retry);
      }
      row.append(preview,actions);pending.append(row);
    }
    if(focusId)Array.from(pending.querySelectorAll<HTMLElement>('[data-pending-focus]')).find(node=>node.dataset.pendingFocus===focusId)?.focus({preventScroll:true});
  }
  function changePendingPage(step:number):void {
    pendingPage+=step;
    pendingDetails=undefined;
    renderPending();
    if (document.activeElement===document.body) {
      const available=element<HTMLButtonElement>('pending-next').disabled ? 'pending-previous' : 'pending-next';
      element(available).focus({preventScroll:true});
    }
    queueHomeworkRefresh();
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
    if (working || state?.busy || (editorOpen && id===editing && id!==null)) return;
    if (!await discard()) return;
    orderMode=false;editorOpen=true;edit(id);name.focus();
  }
  async function perform(action:() => Promise<Result>,success:string):Promise<Result | null> {
    if (working || state?.busy) return null;
    const focused=document.activeElement as HTMLElement | null;
    const key=focused?.dataset.focusKey, pendingKey=focused?.dataset.pendingFocus;
    working=true;message('처리 중입니다…');render();
    try {
      const result=await action();state=result.status;
      message(result.error || (result.success ? success : '처리하지 못했습니다. 다시 시도해 주세요.'),!result.success);
      return result;
    } catch (error) {message(error instanceof Error ? error.message : String(error),true);return null;}
    finally {
      working=false;render();
      if (document.activeElement===document.body && focused && focused!==document.body) {
        const target=key || pendingKey ? Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key],[data-pending-focus]'))
          .find(node=>key ? node.dataset.focusKey===key : node.dataset.pendingFocus===pendingKey) : focused;
        if (target?.isConnected && !target.matches(':disabled') && !target.closest('[hidden]')) target.focus({preventScroll:true});
        if (document.activeElement===document.body) element('profile-status').focus({preventScroll:true});
      }
    }
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
      editorOpen=true;edit(profile.id);message('프로필 이름과 서버를 저장한 뒤 사용해 주세요.');
      (!profile.name.trim() ? name : server).focus();return;
    }
    edit(profile.id);await select(profile.id);
  }
  async function save(use:boolean):Promise<void> {
    if (!form.reportValidity()) return;
    const id=editing;
    const [originalName,originalServer]=baseline;
    const result=await perform(() => id ? api.updatePlayProfile(id,
      name.value===originalName ? undefined : name.value,server.value===originalServer ? undefined : Number(server.value))
      : api.createPlayProfile(name.value,Number(server.value),copy.value || undefined),'프로필을 저장했습니다.');
    if (!result?.success) return;
    const savedId=id || result.profileId;
    if (!savedId) return;
    edit(savedId);
    if (use) await select(savedId);
  }
  async function reviewPending(session:Status['pendingSessions'][number]) {
    if (working || state?.busy || dialog.open || reviewingPending) return null;
    const page=pendingPage;
    reviewingPending=true;
    try {
      const details=await api.getPlayProfilePendingSession(session.sessionId);
      if (!details?.snapshotToken || details.count!==session.count || details.firstOccurredAt!==session.firstOccurredAt ||
        details.lastOccurredAt!==session.lastOccurredAt) {
        message('보관 기록이 바뀌었습니다. 갱신된 내용을 다시 확인해 주세요.',true);
        queueHomeworkRefresh();
        return null;
      }
      return !working && !state?.busy && !dialog.open && pendingPage===page ? details : null;
    } catch {
      message('보관 기록을 확인하지 못했습니다. 다시 시도해 주세요.',true);
      return null;
    } finally {reviewingPending=false;}
  }
  async function assignSession(session:Status['pendingSessions'][number]):Promise<void> {
    const active=state?.profiles.find(p => p.id===state!.activeProfileId);
    const details=await reviewPending(session);
    const token=details?.snapshotToken;
    if (!details || !token) return;
    const summary=`\n${categorySummary(details)}\n${details.samples.at(-1)?.text || ''}`;
    if (!active || !await ask('미배정 기록 가져오기',`감지 기록 ${session.count.toLocaleString()}건을 ${profileLabel(active)} 프로필에 배정할까요?${summary}\n기록만으로는 실제 플레이한 캐릭터를 확인할 수 없습니다. 지난 HUD·알림은 다시 재생하지 않습니다.`,'배정')) return;
    await perform(() => api.assignPlayProfileSession(session.sessionId,active.id,token),'미배정 기록을 반영했습니다.');
    queueHomeworkRefresh();
  }
  async function releaseOrphanedSession(session:Status['pendingSessions'][number]):Promise<void> {
    const details=await reviewPending(session),token=details?.snapshotToken;
    if (!token || !details.orphanedCount || !await ask('삭제된 프로필의 기록을 이동할까요?',`${details.orphanedCount}건을 미배정으로 이동합니다. 이후 사용할 프로필을 선택해 배정할 수 있습니다.`,'미배정으로 이동')) return;
    await perform(()=>api.releaseOrphanedPlayProfileSession(session.sessionId,token),'기록을 미배정으로 이동했습니다.');
    queueHomeworkRefresh();
  }
  async function ignoreSession(session:Status['pendingSessions'][number]):Promise<void> {
    if(working || state?.busy || dialog.open)return;
    const details=await reviewPending(session);if(!details?.snapshotToken)return;
    const token=details.snapshotToken;
    const body=`${sessionTime(session)} · 보관된 기록 ${session.count.toLocaleString()}건\n${categorySummary(details)}\n${details.samples.at(-1)?.text || ''}\n\n이 기록을 숙제·모험일지에 반영하지 않고 대기 목록에서 제외합니다.`;
    if(!await ask('이 기록을 무시할까요?',body,'무시하기'))return;
    await perform(()=>api.ignorePlayProfileSession(session.sessionId,token),'기록을 무시하고 대기 목록에서 정리했습니다.');
    queueHomeworkRefresh();
  }
  async function load():Promise<void> {
    try {
      state=await api.getPlayProfiles(pendingPage);
      element('retry-profiles').hidden=!!state;
      if (!state) {message('프로필 기능을 준비하고 있습니다. 잠시 후 다시 불러와 주세요.');render();return;}
      acceptPendingPage(state);acceptHomework(state.homeworkProgress ?? null);
      const active=state.profiles.find(profile=>profile.id===state!.activeProfileId) || state.profiles[0];
      editorOpen=!!active && (!active.name.trim() || !active.userServer);
      message('');edit(state.activeProfileId || state.profiles[0]?.id || null);
    } catch {message('프로필을 불러오지 못했습니다. 다시 시도해 주세요.',true);element('retry-profiles').hidden=false;render();}
  }
  element('new-profile').addEventListener('click',() => {void changeEditor(null);});
  element('reorder-profiles').addEventListener('click',()=>{if(working || state?.busy)return;finishDrag();orderMode=!orderMode;render();});
  element('close-editor').addEventListener('click',()=>{void (async()=>{
    if(working || state?.busy || !await discard())return;
    editorOpen=false;edit(state?.activeProfileId || state?.profiles[0]?.id || null);element('new-profile').focus();
  })();});
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
  const shutdownWindow=window as Window & {profileShutdown?:{prepare(expiresAt:number):string;approve():void;cancel():void}};
  shutdownWindow.profileShutdown={
    prepare(expiresAt) {
      if (Date.now()>=expiresAt || working || closeQuestion || dialog.open) return 'busy';
      document.body.inert=true;
      return dirty() ? 'dirty' : 'ready';
    },
    approve() {allowClose=true;},
    cancel() {document.body.inert=false;},
  };
  window.addEventListener('beforeunload',event => {
    if (allowClose || (!working && !dirty())) return;
    event.preventDefault();event.returnValue=false;void requestClose();
  });
  element('retry-profiles').addEventListener('click',() => {void load();});
  element('pending-previous').addEventListener('click',()=>changePendingPage(-1));
  element('pending-next').addEventListener('click',()=>changePendingPage(1));
  api.onPlayProfilesChanged(next => {
    state=next;
    if (working && next.pendingReplay) {
      const {processed,total}=next.pendingReplay;
      message(`기록 반영 중 · ${processed.toLocaleString()} / ${total.toLocaleString()}건`);
    }
    const edited=state.profiles.find(p=>p.id===editing);
    if (editing && !edited && !dirty() && !working) {
      const active=state.profiles.find(profile=>profile.id===state!.activeProfileId);editorOpen=editorOpen || !!active && (!active.name.trim() || !active.userServer);edit(state.activeProfileId);
    }
    else {
      if (edited && !working) {
        const nextName=edited.name || '',nextServer=edited.userServer ? String(edited.userServer) : '';
        if (name.value===baseline[0]) name.value=nextName;
        if (server.value===baseline[1]) server.value=nextServer;
        baseline=[nextName,nextServer,''];
      }
      render();
    }
    queueHomeworkRefresh();
  });
  api.onConfigData(()=>{if(state)queueHomeworkRefresh();});
  window.addEventListener('focus',queueHomeworkRefresh);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)queueHomeworkRefresh();});
  window.setInterval(()=>{if(!document.hidden)queueHomeworkRefresh();},30_000);
  void load();
})();
