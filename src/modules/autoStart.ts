import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { exec } from 'child_process';

/**
 * 자동 실행 설정 (바로가기 .lnk + 레지스트리 혼합 방식)
 * 
 * 1. userData 폴더에 'twOverlayLauncher.vbs' 생성 (관리자 권한 실행용)
 * 2. 같은 폴더에 이 VBS를 가리키는 'twOverlay.lnk' 생성 (아이콘/이름 표시용)
 * 3. 이 'twOverlay.lnk' 경로를 레지스트리(Run 키)에 등록
 */
export function setupAutoStart(enable: boolean): void {
    const exePath = app.getPath('exe');
    const userDataPath = app.getPath('userData');
    const vbsPath = path.join(userDataPath, 'twOverlayLauncher.vbs');
    const lnkPath = path.join(userDataPath, 'twOverlay.lnk');

    if (enable) {
        // 1. 실행 전용 VBScript 생성
        const safeExePath = exePath.replace(/"/g, '""');
        const vbsContent = 'Set UAC = CreateObject("Shell.Application")\r\nUAC.ShellExecute "' + safeExePath + '", "", "", "runas", 1';
        try {
            fs.writeFileSync(vbsPath, vbsContent, 'utf8');
        } catch (err) {
            log('[AUTOSTART] VBS Write FAIL: ' + err);
            return;
        }

        // 2. 바로가기(.lnk) 생성용 스크립트 (userData 폴더 내에 생성)
        const escapedLnkPath = lnkPath.replace(/\\/g, "\\\\");
        const escapedVbsPath = vbsPath.replace(/\\/g, "\\\\");
        const escapedExePath = exePath.replace(/\\/g, "\\\\");
        const escapedWorkingDir = path.dirname(exePath).replace(/\\/g, "\\\\");

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
        
        const lnkCreatorPath = path.join(userDataPath, 'create_lnk.vbs');
        try {
            fs.writeFileSync(lnkCreatorPath, createLnkScript, 'utf8');
            exec(`cscript //Nologo "${lnkCreatorPath}"`, (error) => {
                if (error) {
                    log('[AUTOSTART] LNK Creation FAIL: ' + error);
                } else {
                    // 3. 생성된 .lnk 파일을 레지스트리에 등록
                    app.setLoginItemSettings({
                        openAtLogin: true,
                        path: lnkPath // exe 대신 lnk 경로를 등록하여 아이콘/이름 유지
                    });
                    log('[AUTOSTART] Successfully registered LNK to registry');
                }
                try { fs.unlinkSync(lnkCreatorPath); } catch {}
            });
        } catch (err) {
            log('[AUTOSTART] LNK Process Error: ' + err);
        }

    } else {
        // 비활성화: 레지스트리 등록 해제 및 파일 삭제
        app.setLoginItemSettings({ openAtLogin: false, path: lnkPath });
        try {
            if (fs.existsSync(lnkPath)) fs.unlinkSync(lnkPath);
            if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
        } catch (err) {
            log('[AUTOSTART] Cleanup FAIL: ' + err);
        }
    }
}
