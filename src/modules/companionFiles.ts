import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import * as config from './config';
import { getDiaryExportSnapshot } from './diaryDb';
import { renderDiaryExport, validateDiaryRange } from './diaryExport';
import { captureSharedSettings, parseSettingsShare, shareBaseline, shareChanges, sharedPatch, validateShareGroups } from './settingsShare';
import type { AppConfig } from '../shared/types';
import type { DiaryExportSnapshot, FileActionResult, ShareGroup } from '../shared/companionFiles';

interface Dependencies {
  settingsWindow(): BrowserWindow | null;
  isDragging(): boolean;
  apply(patch: Partial<AppConfig>): { success: boolean; error?: string };
  dialogs?: Pick<typeof dialog, 'showOpenDialog' | 'showSaveDialog'>;
}
interface ShareCandidate { token: string; groups: ShareGroup[]; settings: Partial<AppConfig>; review?: { patch: Partial<AppConfig>; baseline: string }; }
async function writeFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

/** 기능 계약: 파일 선택/저장은 해당 앱 창에서만 허용한다. 가져온 값은 main에 보관하고 renderer는
 * 토큰과 그룹만 전달한다. 비교 이후 관련 설정이 바뀌면 재비교가 필요하며, 저장 성공 후에만 런타임을
 * 적용한다. 일지 저장도 미리보기한 스냅샷 그대로 저장한다. 취소·실패는 설정/원본을 바꾸지 않는다. */
export function registerCompanionFiles(deps: Dependencies): void {
  const dialogs = deps.dialogs || dialog;
  const shares = new Map<number, ShareCandidate>();
  const diaries = new Map<number, { token: string; snapshot: DiaryExportSnapshot }>();
  const watched = new WeakSet<WebContents>();
  function watch(sender: WebContents): void {
    if (watched.has(sender)) return;
    const id = sender.id;
    watched.add(sender); sender.once('destroyed', () => { shares.delete(id); diaries.delete(id); });
  }
  function handle(channel: string, page: 'settings' | 'diary', callback: (sender: WebContents, parent: BrowserWindow, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const allowed = page === 'settings' ? deps.settingsWindow()?.webContents === event.sender
        : event.sender.getURL().split('?')[0] === pathToFileURL(path.join(__dirname, '../diary.html')).href;
      if (!parent || !allowed) return { success: false, error: '이 창에서 사용할 수 없는 기능입니다.' };
      watch(event.sender);
      try { return await callback(event.sender, parent, ...args); }
      catch (error) {
        return { success: false, error: error instanceof Error && !('code' in error) && !(error instanceof SyntaxError)
          ? error.message : '파일을 처리하지 못했습니다. 파일과 저장 위치를 확인해 주세요.' };
      }
    });
  }
  handle('settings-share-export', 'settings', async (sender, parent, selected: unknown) => {
    const groups = validateShareGroups(selected);
    const snapshot = JSON.stringify({ format: 'tw-overlay-settings', version: 1, groups,
      settings: captureSharedSettings(config.load(), groups) }, null, 2);
    const chosen = await dialogs.showSaveDialog(parent, { title: '선택한 설정 저장', defaultPath: 'TW-Overlay-설정.json', filters: [{ name: '설정 공유 파일', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePath || sender.isDestroyed()) return { success: false, canceled: true };
    await writeFile(chosen.filePath, snapshot); return { success: true };
  });
  handle('settings-share-open', 'settings', async (sender, parent) => {
    const chosen = await dialogs.showOpenDialog(parent, { title: '설정 공유 파일 선택', properties: ['openFile'], filters: [{ name: '설정 공유 파일', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePaths[0] || sender.isDestroyed()) return { success: false, canceled: true };
    const file = await fs.open(chosen.filePaths[0], 'r');
    let text: string;
    try {
      if ((await file.stat()).size > 1024 * 1024) throw new Error('설정 공유 파일이 너무 큽니다.');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error('설정 공유 파일이 너무 큽니다.');
      text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
    } finally { await file.close(); }
    if (sender.isDestroyed()) return { success: false, canceled: true };
    const candidate = { token: randomUUID(), ...parseSettingsShare(text) };
    shares.set(sender.id, candidate);
    return { success: true, token: candidate.token, groups: candidate.groups };
  });
  handle('settings-share-preview', 'settings', (sender, _parent, token: unknown, selected: unknown) => {
    const candidate = shares.get(sender.id);
    if (!candidate || candidate.token !== token) throw new Error('설정 파일을 다시 선택해 주세요.');
    candidate.review = undefined;
    const groups = validateShareGroups(selected);
    if (groups.some(group => !candidate.groups.includes(group))) throw new Error('파일에 포함된 항목만 선택해 주세요.');
    const current = config.load();
    const patch = sharedPatch(current, candidate.settings, groups);
    candidate.review = { patch, baseline: shareBaseline(current, patch) };
    return { success: true, token: candidate.token, groups, changes: shareChanges(current, patch, groups) };
  });
  handle('settings-share-apply', 'settings', (sender, _parent, token: unknown): FileActionResult => {
    const candidate = shares.get(sender.id);
    if (!candidate || candidate.token !== token || !candidate.review) throw new Error('변경 내용을 먼저 비교해 주세요.');
    if (deps.isDragging()) throw new Error('창 이동을 마친 뒤 적용해 주세요.');
    if (candidate.review.baseline !== shareBaseline(config.load(), candidate.review.patch)) {
      candidate.review = undefined; throw new Error('비교 이후 설정이 바뀌었습니다. 다시 비교해 주세요.');
    }
    const result = deps.apply(candidate.review.patch);
    if (!result.success) throw new Error('설정을 저장하지 못했습니다. 다시 시도해 주세요.');
    shares.delete(sender.id); return { success: true };
  });
  handle('diary-export-preview', 'diary', (sender, _parent, start: unknown, end: unknown) => {
    validateDiaryRange(start, end);
    const snapshot = getDiaryExportSnapshot(start, end as string, config.loadFields(['lootKeywords']).lootKeywords || []);
    const token = randomUUID(); diaries.set(sender.id, { token, snapshot });
    return { success: true, token, count: snapshot.rows.length, totalSeed: snapshot.totalSeed };
  });
  handle('diary-export-save', 'diary', async (sender, parent, token: unknown) => {
    const candidate = diaries.get(sender.id);
    if (!candidate || candidate.token !== token) throw new Error('기간의 기록을 먼저 확인해 주세요.');
    const { snapshot } = candidate;
    const chosen = await dialogs.showSaveDialog(parent, { title: '모험 일지 저장', defaultPath: `모험일지-${snapshot.start}-${snapshot.end}.html`, filters: [{ name: '브라우저로 읽는 모험 일지', extensions: ['html'] }] });
    if (chosen.canceled || !chosen.filePath || sender.isDestroyed()) return { success: false, canceled: true };
    await writeFile(chosen.filePath, renderDiaryExport(snapshot));
    return { success: true };
  });
}
