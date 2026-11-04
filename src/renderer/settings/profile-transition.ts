interface Window {
  settingsProfileTransition: {
    status():{ready:boolean;profileId:string | null;name:string;dirty:boolean;busy:boolean;editing:boolean};
    lock():void;finish():void;save():Promise<boolean>;beginSave():(() => void) | false;
    refreshLabel():void;report(message:string):void;
  };
}
(() => {
  const host=window as typeof window & {
    collectSettingsDraftExtras():Record<string,unknown>;saveSettings(keepOpen?:boolean):Promise<boolean>;
    isProfileSettingsEditing():boolean;hasPendingCustomChatTabDraft():boolean;
    updateProfileLogRestoreNotice?():void;
  };
  let locked=false,pending=0,transitionSave=false,displayedOwner:string | undefined;
  const notice=document.getElementById('settings-profile-context');
  const message=document.getElementById('settings-profile-status');
  const report=(text:string) => {if (message) message.textContent=text;};
  const refreshLabel=() => {
    host.updateProfileLogRestoreNotice?.();
    const config=window.lastConfig;if (!notice) return;
    if (displayedOwner!==undefined && displayedOwner!==config?.activePlayProfileId) report('');
    displayedOwner=config?.activePlayProfileId;
    notice.hidden=!config?.activePlayProfileId;
    const title=document.getElementById('settings-profile-target');
    const name=config?.characterPresets?.[0]?.name || '기본 프로필';
    const server=document.querySelector<HTMLOptionElement>(`#chat-overlay-user-server-input option[value="${Number(config?.userServer)}"]`)?.textContent || '서버 선택 필요';
    if (title) title.textContent=`프로필 설정: ${name} · ${server}`;
    const serverLabel=document.getElementById('settings-user-server-label');
    if (serverLabel) serverLabel.textContent=config?.activePlayProfileId ? '프로필 서버' : '주 사용 캐릭터 서버';
  };
  window.settingsProfileTransition={
    status() {
      const config=window.lastConfig;
      return {ready:!!config,profileId:config?.activePlayProfileId || null,name:config?.characterPresets?.[0]?.name || '기본 프로필',
        dirty:window.settingsDraft.hasChanges(host.collectSettingsDraftExtras()) || host.hasPendingCustomChatTabDraft(),
        busy:pending>0,editing:host.isProfileSettingsEditing()};
    },
    lock() {locked=true;document.body.inert=true;document.body.setAttribute('aria-busy','true');},
    finish() {locked=false;document.body.inert=false;document.body.removeAttribute('aria-busy');},
    async save() {transitionSave=true;try {const saved=await host.saveSettings(true);if (saved) report('');return saved;} finally {transitionSave=false;}},
    beginSave() {
      if (locked && !transitionSave) return false;
      ++pending;let released=false;
      return () => {if (!released) {released=true;--pending;}};
    },refreshLabel,report,
  };
  refreshLabel();
})();
