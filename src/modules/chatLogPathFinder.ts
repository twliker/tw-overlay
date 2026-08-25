import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { log } from './logger';

function expandWindowsEnvironmentPath(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const actualKey = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
    return actualKey && env[actualKey] ? env[actualKey] as string : match;
  });
}

export function parseRegistryPathValue(output: string, valueName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pattern = new RegExp(`${valueName}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, 'mi');
  const match = output.match(pattern);
  if (!match?.[1]) return null;
  return path.normalize(expandWindowsEnvironmentPath(match[1].trim(), env));
}

export function buildChatLogPathCandidates(options: {
  documentsPath?: string | null;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const roots = [
    options.documentsPath,
    path.join(homeDir, 'Documents'),
    ...['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']
      .map(key => env[key])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(root => path.join(root, 'Documents')),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const root of roots) {
    const candidate = path.normalize(path.join(root, 'Talesweaver', 'ChatLog'));
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

function findWindowsDocumentsPath(): string | null {
  try {
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v',
      'Personal',
    ], {
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegistryPathValue(output, 'Personal');
  } catch {
    return null;
  }
}

/**
 * 테일즈위버 채팅 로그 폴더를 자동으로 탐색하는 유틸리티
 */
export function findChatLogPath(): string | null {
  try {
    // 1. 레지스트리 기반 탐색 (InstallLocation)
    const regPath = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TalesWeaver';
    try {
      const output = execFileSync('reg', ['query', regPath, '/v', 'InstallLocation'], {
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const installPath = parseRegistryPathValue(output, 'InstallLocation');
      if (installPath) {
        const chatLogPath = path.join(installPath, 'ChatLog');
        if (fs.existsSync(chatLogPath)) {
          log(`[CHAT_LOG] 레지스트리 기반 경로 발견: ${chatLogPath}`);
          return chatLogPath;
        }
      }
    } catch (e) {
      log(`[CHAT_LOG] 레지스트리 조회 실패 또는 키 없음 (정상적인 상황일 수 있음)`);
    }

    // 2. Windows Known Folder와 실제 OneDrive 루트를 포함한 문서 경로 탐색
    const standardPaths = buildChatLogPathCandidates({
      documentsPath: findWindowsDocumentsPath(),
    });

    for (const p of standardPaths) {
      if (fs.existsSync(p)) {
        log(`[CHAT_LOG] 표준 문서 경로 발견: ${p}`);
        return p;
      }
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[CHAT_LOG] 경로 탐색 중 오류 발생: ${msg}`);
  }

  log(`[CHAT_LOG] 로그 경로 자동 탐색 실패`);
  return null;
}
