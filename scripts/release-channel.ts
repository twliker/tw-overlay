import * as fs from 'node:fs';
import * as path from 'node:path';

/** 태그/앱 버전을 맞추고 Electron Builder의 업데이트 파일 채널을 선택한다.
 * beta 설치본을 latest.yml로 업로드하거나 정식 릴리즈로 표시하지 않는다.
 * 회귀: check-refactor-regressions.ts의 배포 문서/워크플로우 검사. */
export function resolveReleaseChannel(version:string,tag:string):{prerelease:boolean;updateFile:string} {
  const match=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(alpha|beta|rc|preview)\.(?:0|[1-9]\d*))?$/.exec(version);
  if (!match || tag!==`v${version}`) throw new Error('릴리즈 태그와 package.json 버전을 확인해 주세요.');
  return {prerelease:!!match[1],updateFile:`${match[1] || 'latest'}.yml`};
}

if (require.main===module) {
  const {version,build}=JSON.parse(fs.readFileSync(path.resolve('package.json'),'utf8')) as {
    version:string;build:{publish:Array<{provider:string;channel?:string}>};
  };
  const result=resolveReleaseChannel(version,process.env.RELEASE_TAG || '');
  const expectedChannel=result.updateFile.slice(0,-4);
  if (!build.publish.some(p=>p.provider==='github') || build.publish.some(p=>p.provider==='github' && (p.channel || 'latest')!==expectedChannel)) {
    throw new Error('Electron Builder의 GitHub publish.channel과 릴리즈 버전을 맞춰 주세요.');
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub Actions 출력 파일이 필요합니다.');
  fs.appendFileSync(process.env.GITHUB_OUTPUT,`prerelease=${result.prerelease}\nupdate_file=${result.updateFile}\n`);
  console.log(`Release ${version}: ${result.updateFile}, prerelease=${result.prerelease}`);
}
