import type { AppConfig } from '../shared/types';
import type { ShareChange, ShareGroup } from '../shared/companionFiles';
import { ACTIVITY_WINDOWS } from '../shared/activityPresets';
import { sanitizeExternalConfigPatch } from './config';

type Field = readonly [keyof AppConfig, string];
/** 기능 계약: 공유는 아래 명시한 표시·배치·알림만 허용한다. 개인 기록, 키워드, 연동, 경로,
 * 창 열림 상태/단축키/폰트·소리 파일은 전송하지 않는다. ZIP 복구/활동 전환과 별개다.
 * 파일의 미지원 필드/버전/잘못된 값은 적용 전에 거절한다. 회귀: check-companion-files.ts. */
export const SHARE_FIELDS: Record<ShareGroup, readonly Field[]> = {
  layout: [
    ['positions', '창모드 창 위치'], ['windowedFullscreenPositions', '전체화면 창 위치'],
    ['fixedWindowPositions', '고정 창 위치'], ['managedWindowSizes', '도구 창 크기'],
    ['chatOverlayWidth', '메인 채팅 너비'], ['chatOverlayHeight', '메인 채팅 높이'],
    ['chatOverlaySubWidth', '보조 1 너비'], ['chatOverlaySubHeight', '보조 1 높이'],
    ['chatOverlaySub2Width', '보조 2 너비'], ['chatOverlaySub2Height', '보조 2 높이'],
    ['focusedChatWidth', '집중 채팅 너비'], ['focusedChatHeight', '집중 채팅 높이'],
    ['contentsCheckerWidth', '숙제창 너비'], ['contentsCheckerHeight', '숙제창 높이'],
    ['xpWidgetPos', '경험치 HUD 위치'], ['buffTimerHudPos', '버프 HUD 위치'],
    ['todaySummaryHudPos', '오늘 요약 위치'], ['abandonedWidgetPos', '어벤던 HUD 위치'],
    ['digsiteWidgetPos', '발굴지 HUD 위치'], ['forgeQuestHudPos', '퀘스트 HUD 위치'], ['pinnedNotePos', '메모 위치'],
  ],
  appearance: [
    ['chatOverlayFontFamily', '메인 채팅 글꼴'], ['chatOverlaySubFontFamily', '보조 1 글꼴'], ['chatOverlaySub2FontFamily', '보조 2 글꼴'],
    ['chatOverlayFontSize', '메인 채팅 글자 크기'], ['chatOverlaySubFontSize', '보조 1 글자 크기'], ['chatOverlaySub2FontSize', '보조 2 글자 크기'],
    ['chatOverlayOpacity', '메인 채팅 불투명도'], ['chatOverlaySubOpacity', '보조 1 불투명도'], ['chatOverlaySub2Opacity', '보조 2 불투명도'],
    ['chatOverlayColorGeneral', '일반 채팅 색'], ['chatOverlayColorWhisper', '귓속말 색'], ['chatOverlayColorTeam', '팀 채팅 색'],
    ['chatOverlayColorClub', '클럽 채팅 색'], ['chatOverlayColorShout', '외치기 색'],
    ['chatCompactDisplay', '채팅 간단 표시'], ['chatNicknameNotesCompact', '메모 간단 표시'],
    ['chatEtaColorsEnabled', '에타 구간 색상'], ['chatEtaColors', '에타 색상'],
    ['pinnedNoteFontSize', '고정 메모 글자 크기'], ['pinnedNoteColor', '고정 메모 글자 색'], ['pinnedNoteBackground', '고정 메모 배경'],
  ],
  alerts: [
    ['notificationPositions', '알림 위치'], ['fieldBossNotifyEnabled', '필드보스 알림'], ['fieldBossNotifyOffsets', '필드보스 사전 알림'], ['fieldBossNotifyVolume', '필드보스 음량'],
    ['wordAlarmEnabled', '지정 단어 알림'], ['wordAlarmVolume', '지정 단어 음량'],
    ['buffTimerAudioAlert', '버프 소리 알림'], ['buffTimerVisualAlert', '버프 화면 알림'], ['buffTimerWarnSeconds', '버프 사전 알림'], ['buffTimerVolume', '버프 음량'],
    ['xpEfficiencyAlertEnabled', '사냥 효율 알림'], ['xpEfficiencyDropPercent', '사냥 효율 감소 기준'], ['xpEfficiencyAlertVolume', '사냥 효율 음량'],
    ['essenceAlertEnabled', '정수 알림'], ['essenceAlertVolume', '정수 음량'],
    ['specialMonsterAlertEnabled', '특수 몬스터 알림'], ['abandonedAlertEnabled', '어벤던 알림'], ['pittaHillAlertEnabled', '피타 힐 알림'],
    ['questCompleteAlertEnabled', '퀘스트 완료 알림'], ['questCompleteAlertVolume', '퀘스트 음량'],
    ['abyssTreasureAlertEnabled', '심연 보물 알림'], ['abyssTreasureAlertVolume', '심연 보물 음량'],
    ['waveMonsterWarningEnabled', '웨이브 알림'], ['waveMonsterWarningVolume', '웨이브 음량'],
    ['ethosAlertEnabled', '에토스 알림'], ['ethosAlertVolume', '에토스 음량'],
    ['abyssApostleAlertEnabled', '심연의 사도 알림'], ['abyssApostleVolume', '심연의 사도 음량'],
    ['lokagosAlertEnabled', '로카고스 알림'], ['lokagosAlertVolume', '로카고스 음량'], ['showSidebarToastOnOverlay', '게임 화면 토스트'],
  ],
};
export const SHARE_GROUPS = Object.keys(SHARE_FIELDS) as ShareGroup[];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const maps = new Set(['positions', 'windowedFullscreenPositions', 'fixedWindowPositions', 'managedWindowSizes']);
export function validateShareGroups(value: unknown): ShareGroup[] {
  if (!Array.isArray(value) || !value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some(v => !SHARE_GROUPS.includes(v))) throw new Error('공유할 항목을 선택해 주세요.');
  return value;
}
function validPortableValue(key: string, value: unknown): boolean {
  if (key.endsWith('FontFamily')) return ['', 'system', 'malgun', 'gulim', 'dotum', 'batang'].includes(String(value));
  if (key.includes('Color') && key !== 'chatEtaColorsEnabled') return Array.isArray(value)
    ? value.every(v => typeof v === 'string' && /^#[\da-f]{6,8}$/i.test(v))
    : typeof value === 'string' && /^#[\da-f]{6,8}$/i.test(value);
  if (maps.has(key)) return object(value) && Object.entries(value).every(([name, entry]) =>
    (ACTIVITY_WINDOWS as readonly string[]).includes(name) && object(entry) &&
    Object.keys(entry).length === 2 && (key === 'managedWindowSizes' ? ['width', 'height'] : key === 'fixedWindowPositions' ? ['x', 'y'] : ['offsetX', 'offsetY'])
      .every(axis => typeof entry[axis] === 'number' && Number.isFinite(entry[axis]) && Math.abs(entry[axis] as number) <= 100_000
        && (key !== 'managedWindowSizes' || ((entry[axis] as number) >= 100 && (entry[axis] as number) <= 16384))));
  if (/Width$|Height$/.test(key)) return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 16384;
  if (key.endsWith('Pos')) return object(value) && Object.keys(value).length === 2
    && typeof value.left === 'number' && typeof value[key === 'todaySummaryHudPos' || key === 'pinnedNotePos' ? 'top' : 'bottom'] === 'number'
    && Object.values(value).every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000);
  if (key === 'notificationPositions') return object(value) && Object.keys(value).every(k => ['center', 'buff', 'hunting', 'toast'].includes(k));
  if (Array.isArray(value)) return value.length <= 100 && value.every(v => Number.isInteger(v) && v >= 0 && v <= 86400);
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000);
}
export function captureSharedSettings(config: Partial<AppConfig>, groups: ShareGroup[]): Partial<AppConfig> {
  const result: Record<string, unknown> = {};
  for (const group of groups) for (const [key] of SHARE_FIELDS[group]) {
    let value: unknown = config[key];
    if (maps.has(key) && object(value)) value = Object.fromEntries(Object.entries(value).filter(([name]) => (ACTIVITY_WINDOWS as readonly string[]).includes(name)));
    if (key.endsWith('Pos') && object(value)) {
      const axis = key === 'todaySummaryHudPos' || key === 'pinnedNotePos' ? 'top' : 'bottom';
      value = { left: value.left, [axis]: value[axis] };
    }
    if (value !== undefined && validPortableValue(key, value)) result[key] = value;
  }
  return JSON.parse(JSON.stringify(result));
}
export function parseSettingsShare(text: string): { groups: ShareGroup[]; settings: Partial<AppConfig> } {
  const data: unknown = JSON.parse(text);
  if (!object(data) || data.format !== 'tw-overlay-settings' || data.version !== 1 || !object(data.settings)
    || Object.keys(data).some(k => !['format', 'version', 'groups', 'settings'].includes(k))) throw new Error('지원하는 설정 공유 파일이 아닙니다.');
  const groups = validateShareGroups(data.groups);
  const allowed = new Set<string>(groups.flatMap(group => SHARE_FIELDS[group].map(([key]) => key)));
  if (!Object.keys(data.settings).length || Object.entries(data.settings).some(([key, value]) => !allowed.has(key) || !validPortableValue(key, value))) throw new Error('공유 범위를 벗어나거나 올바르지 않은 설정이 있습니다.');
  const settings = sanitizeExternalConfigPatch(data.settings);
  if (!settings) throw new Error('설정 값을 확인할 수 없습니다.');
  return { groups, settings };
}
export function sharedPatch(current: AppConfig, saved: Partial<AppConfig>, groups: ShareGroup[]): Partial<AppConfig> {
  const patch = captureSharedSettings(saved, groups) as Record<string, unknown>;
  // 같은 그룹의 파일에 없는 하위 창/알림 값도 현재 값을 유지한다.
  for (const [key, value] of Object.entries(patch)) if (object(value)) patch[key] = { ...(current as unknown as Record<string, object>)[key], ...value };
  return patch;
}
const windowLabels: Record<string, string> = { xpHud: '경험치 창', buffTimer: '버프 창', trade: '거래 창', diary: '모험 일지', focusedChat: '집중 채팅', shoutHistory: '외치기 기록', contentsChecker: '숙제창', chatOverlay: '메인 채팅', chatOverlaySub: '보조 1', chatOverlaySub2: '보조 2', left: '가로', top: '위', bottom: '아래', width: '너비', height: '높이', x: '가로', y: '세로', center: '게임 진행', buff: '버프', hunting: '사냥', toast: '토스트' };
function describe(value: unknown): string {
  if (value === undefined) return '기본값';
  if (typeof value === 'boolean') return value ? '켜짐' : '꺼짐';
  if (typeof value === 'string' && value.startsWith('custom:')) return '사용자 글꼴';
  if (Array.isArray(value)) return value.map(describe).join(', ') || '없음';
  if (object(value)) return Object.entries(value).map(([key, child]) => `${key === 'offsetX' ? '가로' : key === 'offsetY' ? '세로' : windowLabels[key] || key}: ${describe(child)}`).join(' / ') || '없음';
  const labels: Record<string, string> = { '': '메인과 같게', system: '기본 글꼴', malgun: '맑은 고딕', gulim: '굴림', dotum: '돋움', batang: '바탕', default: '기존 위치', 'top-left': '왼쪽 위', 'top-center': '가운데 위', 'top-right': '오른쪽 위', 'middle-left': '왼쪽 가운데', 'middle-center': '화면 가운데', 'middle-right': '오른쪽 가운데', 'bottom-left': '왼쪽 아래', 'bottom-center': '가운데 아래', 'bottom-right': '오른쪽 아래' };
  return labels[String(value)] ?? String(value);
}
export function shareChanges(current: AppConfig, patch: Partial<AppConfig>, groups: ShareGroup[]): ShareChange[] {
  return groups.flatMap(group => SHARE_FIELDS[group].flatMap(([key, label]) => patch[key] !== undefined
    && JSON.stringify(current[key]) !== JSON.stringify(patch[key]) ? [{ group, label, before: describe(current[key]), after: describe(patch[key]) }] : []));
}
export function shareBaseline(current: AppConfig, patch: Partial<AppConfig>): string {
  return JSON.stringify(Object.keys(patch).sort().map(key => [key, current[key as keyof AppConfig]]));
}
