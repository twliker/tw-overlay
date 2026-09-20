export type ShareGroup = 'layout' | 'appearance' | 'alerts';
export interface FileActionResult { success: boolean; canceled?: boolean; error?: string; }
export interface ShareChange { group: ShareGroup; label: string; before: string; after: string; }
export interface ShareReview extends FileActionResult {
  token?: string;
  groups?: ShareGroup[];
  changes?: ShareChange[];
}
export interface DiaryExportRow { date: string; time: string; kind: '숙제' | '득템' | '수익'; content: string; amount: number; }
export interface DiaryExportSnapshot { start: string; end: string; rows: DiaryExportRow[]; totalSeed: number; }
export interface DiaryExportReview extends FileActionResult { token?: string; count?: number; totalSeed?: number; }
export interface CompanionFilesApi {
  exportSettingsShare(groups: ShareGroup[]): Promise<FileActionResult>;
  openSettingsShare(): Promise<ShareReview>;
  previewSettingsShare(token: string, groups: ShareGroup[]): Promise<ShareReview>;
  applySettingsShare(token: string): Promise<FileActionResult>;
  previewDiaryExport(start: string, end: string): Promise<DiaryExportReview>;
  saveDiaryExport(token: string): Promise<FileActionResult>;
}
