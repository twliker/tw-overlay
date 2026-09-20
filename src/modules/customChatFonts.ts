import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 기능 계약: 사용자가 선택한 글꼴만 앱 전용 폴더에 복사한다. 설정에는 내용 해시만 저장한다.
 * 원본 경로를 IPC 읽기 권한으로 쓰지 않으며, 다른 PC에 파일이 없으면 기본 글꼴로 표시한다.
 * 글꼴 파일은 클라우드 설정 동기화/프리셋에 포함하지 않는다. 가져오기는 적용과 별개다.
 */
const idPattern = /^custom:([a-f0-9]{64})$/;
const limit = 20 * 1024 * 1024;
const directory = () => path.join(app.getPath('userData'), 'custom_fonts');
export interface CustomChatFont { id: string; label: string }
function validFont(data: Buffer): boolean {
  return data.length >= 12 && data.length <= limit &&
    (data.readUInt32BE(0) === 0x00010000 || ['OTTO', 'wOFF', 'wOF2', 'true'].includes(data.toString('ascii', 0, 4)));
}
export async function importChatFont(source: string): Promise<CustomChatFont> {
  if (!/\.(ttf|otf|woff2?)$/i.test(source)) throw new Error('TTF, OTF, WOFF, WOFF2 파일을 선택해 주세요.');
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size > limit) throw new Error('20MB 이하의 글꼴 파일을 선택해 주세요.');
  const data = await fs.readFile(source);
  if (!validFont(data)) throw new Error('사용할 수 있는 글꼴 파일이 아닙니다.');
  const hash = createHash('sha256').update(data).digest('hex');
  const font = { id: `custom:${hash}`, label: path.basename(source).slice(0, 120) };
  await fs.mkdir(directory(), { recursive: true });
  await fs.writeFile(path.join(directory(), `${hash}.font`), data);
  await fs.writeFile(path.join(directory(), `${hash}.json`), JSON.stringify(font), 'utf8');
  return font;
}
export async function listChatFonts(): Promise<CustomChatFont[]> {
  const names = await fs.readdir(directory()).catch(() => [] as string[]);
  const fonts: CustomChatFont[] = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 200)) {
    try {
      const font = JSON.parse(await fs.readFile(path.join(directory(), name), 'utf8'));
      if (font.id === `custom:${name.slice(0, 64)}` && typeof font.label === 'string') fonts.push({ id: font.id, label: font.label.slice(0, 120) });
    } catch { /* 손상된 항목은 선택 목록에서 제외한다. 설정의 기존 ID는 유지한다. */ }
  }
  return fonts;
}
export async function readChatFont(id: unknown): Promise<Uint8Array | null> {
  if (typeof id !== 'string') return null;
  const hash = idPattern.exec(id)?.[1];
  if (!hash) return null;
  try {
    const file = path.join(directory(), `${hash}.font`);
    if ((await fs.stat(file)).size > limit) return null;
    const data = await fs.readFile(file);
    return validFont(data) && createHash('sha256').update(data).digest('hex') === hash ? data : null;
  } catch { return null; }
}
