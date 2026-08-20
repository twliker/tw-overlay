import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from './logger';

const execAsync = promisify(exec);

export interface OptimizationStatus {
  enabled: boolean;
  isAdmin: boolean;
}

/**
 * PowerShell 스크립트를 안전하게 실행하기 위해 Base64로 인코딩합니다.
 * PowerShell의 -EncodedCommand는 UTF-16LE 인코딩된 Base64를 요구합니다.
 */
function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 관리자 권한 여부 확인
 */
export async function checkIsAdmin(): Promise<boolean> {
  try {
    await execAsync('net session');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 현재 네트워크 최적화(Nagle OFF) 상태 확인
 */
export async function getOptimizationStatus(): Promise<OptimizationStatus> {
  const isAdmin = await checkIsAdmin();

  const script = `
    $interfacesPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces"
    $activeGuids = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceGuid
    
    $enabled = $false
    foreach ($guid in $activeGuids) {
      $path = Join-Path $interfacesPath $guid
      if (Test-Path $path) {
        $taf = Get-ItemProperty -Path $path -Name "TcpAckFrequency" -ErrorAction SilentlyContinue
        $tnd = Get-ItemProperty -Path $path -Name "TCPNoDelay" -ErrorAction SilentlyContinue
        if ($taf -and $taf.TcpAckFrequency -eq 1 -and $tnd -and $tnd.TCPNoDelay -eq 1) {
          $enabled = $true
          break
        }
      }
    }
    Write-Output $enabled
  `;

  try {
    const encoded = encodePowerShell(script);
    const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 10000 });
    return {
      enabled: stdout.trim().toLowerCase() === 'true',
      isAdmin
    };
  } catch (e) {
    log(`[Optimizer] Status check failed (Timeout/Error): ${e}`);
    return { enabled: false, isAdmin };
  }
}

/**
 * 네트워크 최적화 적용 또는 해제
 */
export async function setOptimization(enable: boolean): Promise<{ success: boolean; message: string }> {
  const isAdmin = await checkIsAdmin();
  if (!isAdmin) {
    return { success: false, message: '관리자 권한이 필요합니다. 앱을 관리자 권한으로 다시 실행해주세요.' };
  }

  // 보안: enable 값을 PowerShell 문자열 보간 대신 TypeScript에서 분기하여 인젝션 방지
  const enableScript = `
    $interfacesPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces"
    $activeGuids = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceGuid
    
    foreach ($guid in $activeGuids) {
      $path = Join-Path $interfacesPath $guid
      if (Test-Path $path) {
        Set-ItemProperty -Path $path -Name "TcpAckFrequency" -Value 1 -Type DWord -Force
        Set-ItemProperty -Path $path -Name "TCPNoDelay" -Value 1 -Type DWord -Force
      }
    }
  `;

  const disableScript = `
    $interfacesPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces"
    $activeGuids = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty InterfaceGuid
    
    foreach ($guid in $activeGuids) {
      $path = Join-Path $interfacesPath $guid
      if (Test-Path $path) {
        Remove-ItemProperty -Path $path -Name "TcpAckFrequency" -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $path -Name "TCPNoDelay" -ErrorAction SilentlyContinue
      }
    }
  `;

  const script = enable ? enableScript : disableScript;

  try {
    const encoded = encodePowerShell(script);
    await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 15000 });
    return {
      success: true,
      message: enable ? '네트워크 최적화가 적용되었습니다.\n효과를 위해 재부팅을 권장합니다.' : '최적화가 해제되었습니다.'
    };
  } catch (e) {
    log(`[Optimizer] Set failed (Timeout/Error): ${e}`);
    return { success: false, message: `설정 적용 중 오류가 발생했습니다.\n관리자 권한 여부를 다시 확인해주세요. (Timeout: 15s)` };
  }
}

