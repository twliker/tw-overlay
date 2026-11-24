interface Window {
  settingsProfileCloudPause:{render(status:import('../../shared/types').GoogleSyncStatus):boolean};
}

(() => {
  window.settingsProfileCloudPause={render(status) {
    if(window.settingsProfileCloudSync?.render(status)) return true;
    const notice=document.getElementById('google-sync-profile-paused');
    if (notice) notice.hidden=!status.pausedReason;
    if (!status.pausedReason) return false;
    const description=document.getElementById('google-sync-description');
    if (description) description.textContent='프로필 기능에 맞춰 동기화를 개선하고 있습니다.';
    document.getElementById('google-sync-unlinked-view')?.classList.add('hidden');
    document.getElementById('google-sync-linked-view')?.classList.add('hidden');
    const badge=document.getElementById('google-sync-badge');
    if (badge) {badge.textContent='일시 중지';badge.className='ui-status';}
    const text=document.getElementById('google-sync-profile-paused-text');
    if (text) text.textContent=status.pausedReason;
    const account=document.getElementById('google-sync-profile-paused-account');
    if (account) account.textContent=status.email ? `${status.email} · 기존 연결 정보는 보관됩니다.` : '기존 연결 정보는 보관됩니다.';
    return true;
  }};
})();
