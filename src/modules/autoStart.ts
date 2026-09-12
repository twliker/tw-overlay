/**
 * 기능 계약 — Windows 로그인 자동 실행
 *
 * - Store는 패키지의 StartupTask를 사용한다. 일반 권한 도우미가 버전 없는 AppsFolder ID로
 *   앱을 활성화하며, WindowsApps의 EXE를 직접 runas 실행하지 않는다. 앱의 관리자 권한은 유지한다.
 * - NSIS는 userData의 VBS가 `runas`로 EXE를 실행하고 그 VBS의 바로가기를 Run에 등록한다.
 * - 개발 실행은 설치본의 자동 시작 설정을 변경하지 않는다. Store는 구버전 VBS가 실제로
 *   TW-Overlay Store EXE를 가리킬 때만 기존 Run/바로가기를 정리하며 NSIS 등록은 보존한다.
 * - 해제 시 로그인 항목과 앱이 만든 VBS/바로가기만 제거합니다. 다른 시작프로그램이나 임의 경로는
 *   삭제하지 않습니다.
 * - 설정 저장이 빠르게 연속 호출될 수 있으므로 generation이 가장 최신인 요청만 등록 결과를
 *   확정합니다. 늦게 끝난 이전 enable 작업이 최종 disable 선택을 되돌리면 안 됩니다.
 * - Store의 비동기 변경은 직렬 적용하고 Windows에서 사용자가 해제한 상태를 덮어쓰지 않는다.
 *   관련 회귀 검사는 scripts/check-auto-start.ts와 AppX 검증에 포함한다.
 */
import { app, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { exec } from 'child_process';
import { configureStoreAutoStart, StoreAutoStartQueue } from './storeAutoStart';

export class AutoStartRequestTracker {
    private generation = 0;
    private enabled = false;

    begin(enabled: boolean): number {
        this.enabled = enabled;
        return ++this.generation;
    }

    isCurrent(generation: number, enabled: boolean): boolean {
        return this.generation === generation && this.enabled === enabled;
    }

    isDisabled(): boolean {
        return !this.enabled;
    }
}

const autoStartRequests = new AutoStartRequestTracker();
const storeAutoStartQueue = new StoreAutoStartQueue();

/** 다른 설치본/사용자 스크립트를 지우지 않도록 예전 생성 형식과 Store 패키지 경로를 모두 확인한다. */
export function isLegacyStoreLauncher(source: string): boolean {
    return /^Set UAC = CreateObject\("Shell\.Application"\)\r?\nUAC\.ShellExecute "[A-Z]:\\(?:[^"\r\n]+\\)?WindowsApps\\FilbertLab\.TW-Overlay_\d+\.\d+\.\d+\.\d+_x64__f5qg8d8cz1kn2\\app\\twOverlay\.exe", "", "", "runas", 1\s*$/i.test(source);
}

export function removeLegacyStoreAutoStart(userDataPath: string): void {
    const vbsPath = path.join(userDataPath, 'twOverlayLauncher.vbs');
    const lnkPath = path.join(userDataPath, 'twOverlay.lnk');
    if (!fs.existsSync(vbsPath) || !isLegacyStoreLauncher(fs.readFileSync(vbsPath, 'utf8'))) return;
    const items = app.getLoginItemSettings({ path: lnkPath }).launchItems;
    for (const item of items) {
        if (item.scope === 'user' && item.name === 'com.filbertlab.twoverlay'
            && path.resolve(item.path).toLowerCase() === path.resolve(lnkPath).toLowerCase()) {
            app.setLoginItemSettings({ openAtLogin: false, name: item.name, path: lnkPath });
        }
    }
    removeAutoStartFiles(lnkPath, vbsPath);
}

function removeAutoStartFiles(lnkPath: string, vbsPath: string): void {
    try {
        if (fs.existsSync(lnkPath)) fs.unlinkSync(lnkPath);
        if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
    } catch (err) {
        log('[AUTOSTART] Cleanup FAIL: ' + err);
    }
}

/**
 * NSIS 자동 실행은 바로가기 .lnk + 레지스트리 혼합 방식이다. Store는 아래 절차를 사용하지 않는다.
 *
 * 1. userData 폴더에 'twOverlayLauncher.vbs' 생성 (관리자 권한 실행용)
 * 2. 같은 폴더에 이 VBS를 가리키는 'twOverlay.lnk' 생성 (아이콘/이름 표시용)
 * 3. 이 'twOverlay.lnk' 경로를 레지스트리(Run 키)에 등록
 */
export function setupAutoStart(enable: boolean, interactive = false): void {
    if (process.platform !== 'win32' || !app.isPackaged) return;
    const requestGeneration = autoStartRequests.begin(enable);
    const exePath = app.getPath('exe');
    const userDataPath = app.getPath('userData');
    const vbsPath = path.join(userDataPath, 'twOverlayLauncher.vbs');
    const lnkPath = path.join(userDataPath, 'twOverlay.lnk');

    if (process.windowsStore) {
        void storeAutoStartQueue.enqueue(async () => {
            if (!autoStartRequests.isCurrent(requestGeneration, enable)) return;
            removeLegacyStoreAutoStart(userDataPath);
            const state = await configureStoreAutoStart(enable);
            if (!autoStartRequests.isCurrent(requestGeneration, enable)) return;
            log(`[AUTOSTART] Store startup state: ${state}`, true);
            const actuallyEnabled = state === 'Enabled' || state === 'EnabledByPolicy';
            if (actuallyEnabled !== enable && interactive) {
                void dialog.showMessageBox({
                    type: 'info', title: 'Windows 자동 실행',
                    message: enable ? 'Windows에서 TW-Overlay 자동 실행이 비활성화되어 있습니다.'
                        : 'Windows 정책에 의해 TW-Overlay 자동 실행이 켜져 있습니다.',
                    detail: 'Windows 시작 앱 설정에서 TW-Overlay의 상태를 확인해 주세요. 조직 정책으로 제한된 경우에는 관리자에게 문의해 주세요.',
                    buttons: ['시작 앱 설정 열기', '닫기'], defaultId: 0, cancelId: 1,
                }).then(result => {
                    if (result.response === 0) return shell.openExternal('ms-settings:startupapps');
                }).catch(error => log(`[AUTOSTART] Startup settings dialog FAIL: ${error}`));
            }
        }).catch(error => {
            log(`[AUTOSTART] Store FAIL: ${error}`);
            if (interactive && autoStartRequests.isCurrent(requestGeneration, enable)) {
                void dialog.showMessageBox({ type: 'error', title: 'Windows 자동 실행',
                    message: '자동 실행 설정을 적용하지 못했습니다.',
                    detail: '앱을 다시 실행한 뒤 설정을 저장해 주세요.' })
                    .catch(dialogError => log(`[AUTOSTART] Error dialog FAIL: ${dialogError}`));
            }
        });
        return;
    }

    if (enable) {
        // 1. 실행 전용 VBScript 생성
        const safeExePath = exePath.replace(/"/g, '""');
        const vbsContent = 'Set UAC = CreateObject("Shell.Application")\r\nUAC.ShellExecute "' + safeExePath + '", "", "", "runas", 1';
        try {
            fs.writeFileSync(vbsPath, '\ufeff' + vbsContent, 'utf16le');
        } catch (err) {
            log('[AUTOSTART] VBS Write FAIL: ' + err);
            return;
        }

        // 2. 바로가기(.lnk) 생성용 스크립트 (userData 폴더 내에 생성)
        // VBScript는 역슬래시를 escape 문자로 해석하지 않는다.
        const escapedLnkPath = lnkPath.replace(/"/g, '""');
        const escapedVbsPath = vbsPath.replace(/"/g, '""');
        const escapedExePath = exePath.replace(/"/g, '""');
        const escapedWorkingDir = path.dirname(exePath).replace(/"/g, '""');

        const createLnkScript = `
            Set oWS = WScript.CreateObject("WScript.Shell")
            sLinkFile = "${escapedLnkPath}"
            Set oLink = oWS.CreateShortcut(sLinkFile)
            oLink.TargetPath = "${escapedVbsPath}"
            oLink.IconLocation = "${escapedExePath}, 0"
            oLink.Description = "twOverlay Auto Start"
            oLink.WorkingDirectory = "${escapedWorkingDir}"
            oLink.Save
        `;
        
        // 겹쳐 실행된 설정 저장이 같은 임시 스크립트를 덮어쓰지 않도록 요청별로 분리한다.
        const lnkCreatorPath = path.join(
            userDataPath,
            `create_lnk-${process.pid}-${requestGeneration}.vbs`,
        );
        try {
            fs.writeFileSync(lnkCreatorPath, '\ufeff' + createLnkScript, 'utf16le');
            exec(`cscript //Nologo "${lnkCreatorPath}"`, (error) => {
                if (error) {
                    log('[AUTOSTART] LNK Creation FAIL: ' + error);
                } else if (autoStartRequests.isCurrent(requestGeneration, true)) {
                    // 3. 생성된 .lnk 파일을 레지스트리에 등록
                    app.setLoginItemSettings({
                        openAtLogin: true,
                        path: lnkPath // exe 대신 lnk 경로를 등록하여 아이콘/이름 유지
                    });
                    log('[AUTOSTART] Successfully registered LNK to registry');
                } else if (autoStartRequests.isDisabled()) {
                    // 끄기 뒤 늦게 끝난 cscript가 공유 .lnk를 다시 만들 수 있으므로 제거한다.
                    removeAutoStartFiles(lnkPath, vbsPath);
                }
                try { fs.unlinkSync(lnkCreatorPath); } catch {}
            });
        } catch (err) {
            log('[AUTOSTART] LNK Process Error: ' + err);
        }

    } else {
        // 비활성화: 레지스트리 등록 해제 및 파일 삭제
        app.setLoginItemSettings({ openAtLogin: false, path: lnkPath });
        removeAutoStartFiles(lnkPath, vbsPath);
    }
}
