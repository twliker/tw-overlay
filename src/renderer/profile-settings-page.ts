type ProfilePageConfig=import('../shared/types').AppConfig;
interface ProfileSettingsPageHooks {
  capture():Partial<ProfilePageConfig>;
  apply(config:ProfilePageConfig,isCurrent:()=>boolean):void | Promise<void>;
  extra?():unknown;
  save?():boolean | Promise<boolean>;
  reset?():void;
  commonNotice?:string;
}
interface Window {
  profileSettingsPage:{
    init(hooks:ProfileSettingsPageHooks):void;
    write(patch:Partial<ProfilePageConfig>):Promise<boolean>;
    enabled():boolean;guard():()=>boolean;report(message:string):void;
    refresh():void;
  };
}
/** 독립 프로필 설정 화면의 공통 경계. 입력을 받은 ID로 확정 저장하고 같은 소유자의
 * 수신은 미저장/저장 중 입력을 덮지 않는다. 비동기 목록은 세대로 검사한다. 전환 전에
 * Save/Discard/Cancel을 조립하며 버리기는 실제 새 ID 수신 때만 수행한다.
 * 회귀: check-profile-settings-pages.ts(제품 HTML/preload/IPC/SQLite·지연/실패/최소 창). */
(() => {
  const api=window.electronAPI as typeof window.electronAPI & {applySettingsConfirmed(patch:Partial<ProfilePageConfig>,profileId:string):Promise<{success:boolean;error?:string}>;getConfig():Promise<ProfilePageConfig>};
  let hooks:ProfileSettingsPageHooks,current:ProfilePageConfig | null=null,baseline:Record<string,unknown>={};
  let pending=0,loading=false,applied=false,locked=false,transitionSave=false,generation=0,error='',editRevision=0;
  let queue:Promise<unknown>=Promise.resolve();
  const pendingKeys=new Map<string,number>();
  let notice:HTMLElement,title:HTMLElement,message:HTMLElement,saveButton:HTMLButtonElement;
  const copy=<T>(value:T):T => JSON.parse(JSON.stringify(value));
  const equal=(a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
  const enabled=() => !!current?.activePlayProfileId;
  const dirty=() => !!current && !!hooks && (Object.entries(hooks.capture()).some(([key,value]) => !equal(value,baseline[key])) || !!hooks.extra?.());
  /** 저장 거부 사유는 반드시 사용자에게 보인다. 프로필 안내 영역은 프로필 모드에서만 표시되므로,
   * 숨겨져 있으면(비프로필 모드·초기화 전) 대화상자로 알린다. 빈 문자열은 오류 해제다.
   * 회귀: check-profile-settings-pages.ts(비프로필 모드 검증 실패 안내) */
  const report=(value:string) => {
    error=value;refresh();
    if (value && (!notice || notice.hidden)) alert(value);
  };
  const setInert=() => {document.body.inert=!current || loading || enabled() && locked;document.body.toggleAttribute('aria-busy',document.body.inert);};
  function refresh() {
    if (!notice) return;
    notice.hidden=!enabled();
    const name=current?.characterPresets?.[0]?.name || '기본 프로필';
    const server=current?.userServer===7 ? '하이아칸' : current?.userServer===16 ? '네냐플' : '서버 선택 필요';
    title.textContent=`설정 프로필: ${name} · ${server}`;
    title.title=title.textContent;
    message.textContent=error || (pending ? '저장 중…' : dirty() ? '저장하지 않은 변경이 있습니다.' : '');
    message.hidden=!message.textContent;message.classList.toggle('text-rose-300',!!error);
    saveButton.hidden=!error && (!dirty() || pending>0);saveButton.disabled=pending>0 || locked || loading;
    saveButton.textContent=error ? '다시 저장' : '변경 내용 저장';
  }
  /**
   * 기능 계약: 설정 수신. 처음 불러올 때와 설정 프로필이 바뀔 때만 화면을 잠그고(inert) 전체를 다시 적용한다.
   * 같은 프로필의 재조회(내 저장 확인, 다른 창의 저장)는 잠그지 않아 포커스·열린 선택 목록·클릭을 유지한다.
   * 이때 적용이 알림음 목록 등을 기다리는 동안 사용자가 입력하면 isCurrent()가 false가 되어 남은 적용을 멈추고,
   * 그 입력은 미저장 초안으로 남는다. 적용의 동기 구간이 이미 반영한 새 값만 기준값(baseline)에 합친다.
   * 회귀: scripts/check-profile-settings-pages.ts
   */
  async function receive(value:ProfilePageConfig):Promise<void> {
    const same=current?.activePlayProfileId===value.activePlayProfileId,hasDraft=!!current && !loading && (dirty() || pending>0);
    current=value;
    if (same && enabled() && hasDraft) {refresh();return;}
    if (same && applied && !loading) {await refreshInPlace(value);return;}
    const revision=++generation;loading=true;applied=false;setInert();
    if (!same) {baseline={};error='';hooks.reset?.();}
    try {
      await hooks.apply(value,() => revision===generation);
      if (revision!==generation) return;
      baseline=copy(hooks.capture()) as Record<string,unknown>;
      applied=true;
    } catch {if (revision===generation) error='설정을 불러오지 못했습니다. 창을 다시 열어 주세요.';}
    finally {if (revision===generation) {loading=false;setInert();refresh();}}
  }
  async function refreshInPlace(value:ProfilePageConfig):Promise<void> {
    const revision=++generation,edits=editRevision,before=copy(hooks.capture()) as Record<string,unknown>;
    const isCurrent=() => revision===generation && edits===editRevision;
    try {
      const applying=hooks.apply(value,isCurrent);
      // 첫 대기 전까지 화면에 반영된 새 값은 사용자 입력과 무관하게 확정 값이다.
      for (const [key,next] of Object.entries(copy(hooks.capture()))) if (!equal(next,before[key])) baseline[key]=next;
      await applying;
      if (isCurrent()) baseline=copy(hooks.capture()) as Record<string,unknown>;
      // 적용 중 입력으로 남은 적용을 멈췄는데 그 입력이 설정 변경이 아니었다면(예: 기록 프로필 선택)
      // 남은 화면이 이전 값으로 남지 않게 최신 설정으로 한 번 더 적용한다. 설정 초안이면 기존 규칙대로 보존한다.
      else if (revision===generation && !dirty() && !pending) {await refreshInPlace(current!);return;}
    } catch {if (revision===generation) error='설정을 불러오지 못했습니다. 창을 다시 열어 주세요.';}
    finally {if (revision===generation) refresh();}
  }
  async function write(patch:Partial<ProfilePageConfig>):Promise<boolean> {
    if (!enabled()) {api.applySettings(patch);return true;}
    if (!applied || loading || locked && !transitionSave) {report('설정 화면을 준비하고 있습니다. 잠시 후 다시 저장해 주세요.');return false;}
    const profileId=current!.activePlayProfileId!,revision=generation;
    // 화면 전체의 저장도 사용자가 바꾼 필드만 제출한다. 다른 창의 공통 값 변경을
    // 오래된 DOM 기본값으로 되돌리지 않는다. 아직 저장 중인 필드의 되돌리기 입력은 보존한다.
    const submitted=copy(Object.fromEntries(Object.entries(patch).filter(([key,value]) => !equal(value,baseline[key]) || pendingKeys.get(`${profileId}:${key}`)))) as Partial<ProfilePageConfig>;
    const keys=Object.keys(submitted).map(key=>`${profileId}:${key}`);
    if (!keys.length) {error='';refresh();return true;}
    for (const key of keys) pendingKeys.set(key,(pendingKeys.get(key) || 0)+1);
    ++pending;refresh();
    const work=queue.catch(() => {}).then(async () => {
      let failureMessage='저장하지 못했습니다. 입력은 유지됩니다. 다시 저장해 주세요.';
      try {
        const result=await api.applySettingsConfirmed(submitted,profileId);
        if (!result?.success) {
          if (result?.error==='profile-restore-busy') failureMessage='과거 로그 복원 중입니다. 완료 후 다시 저장해 주세요. 입력은 유지됩니다.';
          if (result?.error==='profile-storage-busy') failureMessage='데이터 복구 중입니다. 완료 후 다시 저장해 주세요. 입력은 유지됩니다.';
          throw new Error('save failed');
        }
        if (revision===generation && current?.activePlayProfileId===profileId) {
          for (const [key,value] of Object.entries(submitted)) baseline[key]=copy(value);
          error='';
        }
        return true;
      } catch {if (revision===generation) error=failureMessage;return false;}
      finally {
        for (const key of keys) {const count=(pendingKeys.get(key) || 1)-1;if (count) pendingKeys.set(key,count);else pendingKeys.delete(key);}
        --pending;refresh();
        if (!pending && !dirty() && !error && revision===generation) void api.getConfig().then(value => {
          if (revision===generation && value.activePlayProfileId===profileId && !pending && !dirty()) return receive(value);
        }).catch(() => {});
      }
    });
    queue=work;return work;
  }
  const save=async () => {
    transitionSave=true;
    try {return await (hooks.save ? hooks.save() : write(hooks.capture()));}
    finally {transitionSave=false;refresh();}
  };
  window.profileSettingsPage={enabled,write,report,refresh,guard:() => {const value=generation;return () => value===generation;},
    init(value) {
      hooks=value;
      notice=document.createElement('section');notice.className='profile-settings-context';notice.hidden=true;
      const row=document.createElement('div');row.className='profile-settings-context-row';
      title=document.createElement('span');title.className='min-w-0 truncate';
      saveButton=document.createElement('button');saveButton.className='ui-button shrink-0';saveButton.type='button';saveButton.addEventListener('click',() => {void save();});
      message=document.createElement('p');message.className='ui-description';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
      row.append(title,saveButton);notice.append(row,message);
      if (value.commonNotice) {const scope=document.createElement('p');scope.className='ui-description';scope.textContent=value.commonNotice;notice.append(scope);}
      const header=document.querySelector('.win-header');if (header) header.after(notice);else document.body.prepend(notice);
      document.querySelector('.app-shell')?.classList.add('profile-settings-shell');
      setInert();
      api.onConfigData(config => {void receive(config);});
      for (const event of ['input','change','click']) document.addEventListener(event,() => {queueMicrotask(refresh);});
      // 사용자의 값 입력. 진행 중인 같은 프로필 재적용이 이 입력을 덮지 않게 한다.
      for (const event of ['input','change']) document.addEventListener(event,() => {editRevision++;},true);
      window.settingsProfileTransition={
        status:() => ({ready:!!current && !loading && applied,profileId:current?.activePlayProfileId || null,name:current?.characterPresets?.[0]?.name || '기본 프로필',dirty:dirty(),busy:pending>0,editing:false}),
        lock() {locked=true;setInert();},finish() {locked=false;setInert();},save,
        beginSave:() => false,refreshLabel:refresh,report,
      };
    },
  };
})();
