import koffi from 'koffi';

let user32: any, dwmapi: any, kernel32: any;
try {
    user32 = koffi.load('user32.dll');
    dwmapi = koffi.load('dwmapi.dll');
    kernel32 = koffi.load('kernel32.dll');
} catch (e) {
    console.error('[WIN32] Failed to load native DLLs:', e);
    const mockDll = { func: () => () => 0 };
    user32 = mockDll;
    dwmapi = mockDll;
    kernel32 = mockDll;
}

// --- Structs ---
export const RECT = koffi.struct('RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long'
});

// --- User32 API ---
export const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', ['intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint']);
export const BeginDeferWindowPos = user32.func('__stdcall', 'BeginDeferWindowPos', 'intptr', ['int']);
export const DeferWindowPos = user32.func('__stdcall', 'DeferWindowPos', 'intptr', ['intptr', 'intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint']);
export const EndDeferWindowPos = user32.func('__stdcall', 'EndDeferWindowPos', 'bool', ['intptr']);
export const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'intptr', []);
export const GetWindow = user32.func('__stdcall', 'GetWindow', 'intptr', ['intptr', 'uint']);
export const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]);
export const IsIconic = user32.func('__stdcall', 'IsIconic', 'bool', ['intptr']);
export const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr']);
export const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'bool', ['intptr', 'int']);
export const BringWindowToTop = user32.func('__stdcall', 'BringWindowToTop', 'bool', ['intptr']);
export const keybd_event = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'intptr']);
export const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', koffi.out(koffi.pointer('uint32'))]);
export const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'bool', ['void *', 'intptr']);
export const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', ['intptr', koffi.out(koffi.pointer('char16')), 'int']);
export const GetWindowLongW = user32.func('__stdcall', 'GetWindowLongW', 'long', ['intptr', 'int']);
export const GetAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'short', ['int']);

// --- DWM API ---
export const DwmGetWindowAttribute = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int', ['intptr', 'uint32', koffi.out(koffi.pointer(RECT)), 'uint32']);

// --- Kernel32 API ---
export const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'intptr', ['uint32', 'bool', 'uint32']);
export const SetPriorityClass = kernel32.func('__stdcall', 'SetPriorityClass', 'bool', ['intptr', 'uint32']);
export const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr']);
export const GetProcessId = kernel32.func('__stdcall', 'GetProcessId', 'uint32', ['intptr']);
export const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['intptr', 'uint32', koffi.out(koffi.pointer('char16')), koffi.out(koffi.pointer('uint32'))]);

// --- Constants ---
// GDI 관련 미사용 상수 제거됨 (SRCCOPY, DIB_RGB_COLORS, BI_RGB)

// --- WinEventHook API ---
export const WINEVENTPROC = koffi.proto('__stdcall', 'void', ['intptr', 'uint32', 'intptr', 'int32', 'int32', 'uint32', 'uint32']);
export const SetWinEventHook = user32.func('__stdcall', 'SetWinEventHook', 'intptr', ['uint32', 'uint32', 'intptr', 'void *', 'uint32', 'uint32', 'uint32']);
export const UnhookWinEvent = user32.func('__stdcall', 'UnhookWinEvent', 'bool', ['intptr']);

// --- Constants ---
export const EVENT_OBJECT_LOCATIONCHANGE = 0x800B; // 위치/크기 변경
export const EVENT_SYSTEM_FOREGROUND = 0x0003;      // 창 활성화 변경
export const EVENT_SYSTEM_MINIMIZESTART = 0x0016;  // 최소화 시작
export const EVENT_SYSTEM_MINIMIZEEND = 0x0017;    // 최소화 종료 (복구)
export const WINEVENT_OUTOFCONTEXT = 0x0000;
export const HWND_TOP = 0n;
export const HWND_BOTTOM = 1n;
export const HWND_TOPMOST = -1n;
export const HWND_NOTOPMOST = -2n;

export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_SHOWWINDOW = 0x0040;
export const SWP_FRAMECHANGED = 0x0020;
export const SWP_NOOWNERZORDER = 0x0200;
export const SWP_NOSENDCHANGING = 0x0400;
export const SWP_DEFERERASE = 0x2000;
export const SWP_NOCOPYBITS = 0x0100;
export const SWP_NOREDRAW = 0x0008;

export const GW_HWNDPREV = 3;

export const GWL_EXSTYLE = -20;
export const WS_EX_TOPMOST = 0x00000008;

export const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
export const SW_RESTORE = 9;

export const VK_LBUTTON = 0x01;
export const VK_MENU = 0x12; // Alt key
export const KEYEVENTF_KEYUP = 0x0002;

export const PROCESS_SET_INFORMATION = 0x0200;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
export const HIGH_PRIORITY_CLASS = 0x00000080;
