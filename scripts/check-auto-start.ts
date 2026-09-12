import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import childProcess = require('node:child_process');
import { app } from 'electron';

const root = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-autostart-'));
app.setPath('userData', fixtureRoot);
const { StoreAutoStartQueue, parseStoreStartupResult } = require(path.join(root, 'dist', 'modules', 'storeAutoStart.js')) as {
    StoreAutoStartQueue: new () => { enqueue(operation: () => Promise<void>): Promise<void> };
    parseStoreStartupResult(output: string): string;
};
const source = fs.readFileSync(path.join(root, 'dist', 'modules', 'autoStart.js'), 'utf8');
const storeExe = 'C:\\Program Files\\WindowsApps\\FilbertLab.TW-Overlay_3.1.3.0_x64__f5qg8d8cz1kn2\\app\\twOverlay.exe';
const legacy = (exe: string) => `Set UAC = CreateObject("Shell.Application")\r\nUAC.ShellExecute "${exe}", "", "", "runas", 1`;

function createHarness(store = true, packaged = true) {
    const data = fs.mkdtempSync(path.join(fixtureRoot, '설정-'));
    const registry: Array<Record<string, unknown>> = [];
    const requests: boolean[] = [];
    const dialogs: unknown[] = [];
    const logs: string[] = [];
    let run: (enable: boolean) => Promise<string> = async () => 'Enabled';
    const lnk = path.join(data, 'twOverlay.lnk');
    const vbs = path.join(data, 'twOverlayLauncher.vbs');
    const exports: Record<string, any> = {};
    let cscriptRuns = 0;
    const app = {
        isPackaged: packaged,
        getPath: (key: string) => key === 'exe' ? (store ? storeExe : path.join(data, '일반 설치', 'twOverlay.exe')) : data,
        getLoginItemSettings: () => ({ launchItems: [
            { scope: 'user', name: 'com.filbertlab.twoverlay', path: lnk },
            { scope: 'user', name: 'another-app', path: lnk },
            { scope: 'machine', name: 'com.filbertlab.twoverlay', path: lnk },
        ] }),
        setLoginItemSettings: (settings: Record<string, unknown>) => registry.push(settings),
    };
    vm.runInNewContext(source, {
        exports, process: { platform: 'win32', windowsStore: store, pid: process.pid },
        require: (name: string) => {
            if (name === 'electron') return { app,
                dialog: { showMessageBox: async (options: unknown) => { dialogs.push(options); return { response: 1 }; } },
                shell: { openExternal: async () => {} },
            };
            if (name === './logger') return { log: (line: string) => logs.push(line) };
            if (name === './storeAutoStart') return {
                StoreAutoStartQueue,
                configureStoreAutoStart: (enabled: boolean) => { requests.push(enabled); return run(enabled); },
            };
            if (name === 'child_process') return {
                exec: (...args: Parameters<typeof childProcess.exec>) => { cscriptRuns++; return childProcess.exec(...args); },
            };
            return require(name);
        },
    });
    return { data, lnk, vbs, registry, requests, dialogs, logs, exports, app,
        setRun: (value: typeof run) => { run = value; }, cscriptRuns: () => cscriptRuns };
}

async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('자동 실행 비동기 검사 시간 초과');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function main(): Promise<void> {
    for (const state of ['Disabled', 'DisabledByUser', 'Enabled', 'DisabledByPolicy', 'EnabledByPolicy']) {
        assert.equal(parseStoreStartupResult(JSON.stringify({ type: 'startup-result', state })), state);
    }
    for (const output of ['{}', 'null', '{"type":"startup-result","state":"unknown"}', 'oops']) {
        assert.throws(() => parseStoreStartupResult(output));
    }

    const store = createHarness();
    fs.writeFileSync(store.vbs, legacy(storeExe));
    fs.writeFileSync(store.lnk, 'old shortcut');
    store.exports.setupAutoStart(true);
    await until(() => store.requests.length === 1);
    assert.equal(fs.existsSync(store.vbs), false, '기존 오류 launcher가 남았습니다.');
    assert.equal(fs.existsSync(store.lnk), false);
    assert.equal(store.registry.length, 1, '다른 앱 또는 시스템 등록을 변경했습니다.');
    assert.equal(store.registry[0].openAtLogin, false);
    assert.equal(store.cscriptRuns(), 0, 'Store에서 버전별 EXE 바로가기를 생성했습니다.');
    assert.equal(store.exports.isLegacyStoreLauncher(legacy(storeExe.replace('3.1.3.0', '3.0.0.0'))), true);
    assert.equal(store.exports.isLegacyStoreLauncher(legacy(storeExe.replace('C:\\Program Files\\', 'D:\\'))), true);
    assert.equal(store.exports.isLegacyStoreLauncher(legacy(storeExe) + '\r\nRunOtherProgram'), false);

    const coexist = createHarness();
    const normalSource = legacy('C:\\Users\\sample\\AppData\\Local\\Programs\\twOverlay\\twOverlay.exe');
    fs.writeFileSync(coexist.vbs, normalSource);
    fs.writeFileSync(coexist.lnk, 'normal shortcut');
    coexist.exports.setupAutoStart(false);
    await until(() => coexist.requests.length === 1);
    assert.equal(fs.readFileSync(coexist.vbs, 'utf8'), normalSource, '일반 설치본 launcher가 삭제되었습니다.');
    assert.equal(coexist.registry.length, 0);

    const ordering = createHarness();
    let finishEnable!: (state: string) => void;
    ordering.setRun(async enabled => enabled
        ? new Promise(resolve => { finishEnable = resolve; }) : 'Disabled');
    ordering.exports.setupAutoStart(true);
    await until(() => ordering.requests.length === 1);
    ordering.exports.setupAutoStart(false);
    finishEnable('Enabled');
    await until(() => ordering.requests.length === 2);
    assert.deepEqual(ordering.requests, [true, false], '늦은 enable이 disable을 되돌렸습니다.');

    const recovery = createHarness();
    recovery.setRun(async () => { throw new Error('fixture failure'); });
    recovery.exports.setupAutoStart(true);
    await until(() => recovery.logs.some(line => line.includes('FAIL')));
    recovery.setRun(async () => 'Disabled');
    recovery.exports.setupAutoStart(false);
    await until(() => recovery.requests.length === 2);

    const blocked = createHarness();
    blocked.setRun(async () => 'DisabledByUser');
    blocked.exports.setupAutoStart(true, true);
    await until(() => blocked.dialogs.length === 1);
    assert.equal(blocked.registry.length, 0, 'Windows에서 해제한 항목을 Run으로 우회했습니다.');
    const policy = createHarness();
    policy.setRun(async () => 'EnabledByPolicy');
    policy.exports.setupAutoStart(false, true);
    await until(() => policy.dialogs.length === 1);

    const dev = createHarness(false, false);
    dev.exports.setupAutoStart(true);
    assert.equal(dev.cscriptRuns(), 0);
    assert.equal(dev.registry.length, 0);

    // 실제 Windows Script Host로 한글/공백 경로의 바로가기를 만들되 앱 실행은 하지 않는다.
    const normal = createHarness(false);
    fs.mkdirSync(path.dirname(normal.app.getPath('exe')), { recursive: true });
    normal.exports.setupAutoStart(true);
    await until(() => normal.registry.length === 1 || normal.logs.some(line => line.includes('FAIL')));
    assert.equal(normal.registry[0]?.openAtLogin, true, normal.logs.join('\n'));
    const inspectScript = path.join(normal.data, 'inspect.vbs');
    const inspectOutput = path.join(normal.data, 'shortcut.txt');
    fs.writeFileSync(inspectScript, '\ufeff' + [
        'Set s = CreateObject("WScript.Shell").CreateShortcut(WScript.Arguments(0))',
        'Set f = CreateObject("Scripting.FileSystemObject").CreateTextFile(WScript.Arguments(1), True, True)',
        'f.WriteLine s.WorkingDirectory', 'f.WriteLine s.TargetPath', 'f.Close',
    ].join('\r\n'), 'utf16le');
    const inspection = childProcess.spawnSync('cscript.exe', ['//Nologo', inspectScript, normal.lnk, inspectOutput],
        { windowsHide: true });
    assert.equal(inspection.status, 0);
    const inspected = fs.readFileSync(inspectOutput, 'utf16le').trim().split(/\r?\n/);
    assert.equal(inspected[0], path.dirname(normal.app.getPath('exe')));
    assert.equal(inspected[1], normal.vbs);
    normal.exports.setupAutoStart(false);
    assert.equal(normal.registry[normal.registry.length - 1]?.openAtLogin, false);
    assert.equal(fs.existsSync(normal.vbs), false);
    assert.equal(fs.existsSync(normal.lnk), false);
    console.log(JSON.stringify({ passed: true, storeMigration: true, coexistence: true,
        requestOrdering: true, windowsDisabledState: true, developmentIsolation: true, nativeShortcut: true }));
}

main().then(() => { fs.rmSync(fixtureRoot, { recursive: true, force: true }); process.exit(0); })
    .catch(error => { console.error(error); process.exit(1); });
