import * as path from 'path';

/**
 * 단일 파일명만 허용하고 지정한 부모 디렉터리 밖으로 벗어나는 경로를 거부합니다.
 */
export function resolveSafeChildFile(parentDirectory: string, filename: string): string | null {
  if (!filename || path.basename(filename) !== filename) return null;

  const resolvedParent = path.resolve(parentDirectory);
  const resolvedFile = path.resolve(resolvedParent, filename);
  return path.dirname(resolvedFile) === resolvedParent ? resolvedFile : null;
}
