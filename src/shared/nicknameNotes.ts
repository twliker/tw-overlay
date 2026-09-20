import type { NicknameNote } from './types';

export const noteNicknameKey = (value: string): string => value.normalize('NFC').trim().toLocaleLowerCase('ko-KR');

export function isNicknameNotes(value: unknown): value is NicknameNote[] {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const keys = new Set<string>();
  return value.every(note => {
    if (!note || typeof note !== 'object' || ![7, 16].includes(note.server)
      || typeof note.nickname !== 'string' || !note.nickname.trim() || note.nickname.length > 40
      || typeof note.note !== 'string' || !note.note.trim() || note.note.length > 200) return false;
    const key = `${note.server}:${noteNicknameKey(note.nickname)}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

/** 기능 계약: 서버+정규화 닉네임으로 한 메모만 저장한다. 빈 내용은 해당 메모만 삭제한다.
 * 채팅 우클릭/설정 목록이 같은 IPC를 쓰며 메인에서 최신 목록에 병합한다.
 * 로컬 설정 및 ZIP 백업에 포함하고 활동 프리셋과 Drive 동기화에는 포함하지 않는다.
 */
export function updateNicknameNote(notes: NicknameNote[], server: unknown, nickname: unknown, note: unknown): NicknameNote[] | null {
  if (![7, 16].includes(server as number) || typeof nickname !== 'string' || !nickname.trim() || nickname.length > 40
    || typeof note !== 'string' || note.length > 200) return null;
  const key = noteNicknameKey(nickname);
  const next = notes.filter(item => item.server !== server || noteNicknameKey(item.nickname) !== key);
  if (note.trim()) next.push({ server: server as number, nickname: nickname.normalize('NFC').trim(), note: note.trim() });
  return isNicknameNotes(next) ? next : null;
}
