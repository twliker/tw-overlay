import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { log } from './logger';

/**
 * 테일즈위버 채팅 로그 폴더를 자동으로 탐색하는 유틸리티
 */
export function findChatLogPath(): string | null {
  try {
    // 1. 레지스트리 기반 탐색 (InstallLocation)
    const regPath = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TalesWeaver';
    try {
      const output = execSync(`reg query "${regPath}" /v InstallLocation`, { encoding: 'utf-8' });
      const match = output.match(/InstallLocation\s+REG_SZ\s+(.*)/);
      if (match && match[1]) {
        const installPath = match[1].trim();
        const chatLogPath = path.join(installPath, 'ChatLog');
        if (fs.existsSync(chatLogPath)) {
          log(`[CHAT_LOG] 레지스트리 기반 경로 발견: ${chatLogPath}`);
          return chatLogPath;
        }
      }
    } catch (e) {
      log(`[CHAT_LOG] 레지스트리 조회 실패 또는 키 없음 (정상적인 상황일 수 있음)`);
    }

    // 2. 내 문서(Documents) 기반 탐색 (표준 경로)
    const homeDir = os.homedir();
    const standardPaths = [
      path.join(homeDir, 'Documents', 'Talesweaver', 'ChatLog'),
      path.join(homeDir, 'OneDrive', 'Documents', 'Talesweaver', 'ChatLog'), // 원드라이브 사용 시
    ];

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
