import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import vm = require('node:vm');
import { app, shell } from 'electron';

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

function createHarness(store = true, packaged = true, directoryPrefix = '설정-') {
    const data = fs.mkdtempSync(path.join(fixtureRoot, directoryPrefix));
    const registry: Array<Record<string, unknown>> = [];
    const requests: boolean[] = [];
    const dialogs: unknown[] = [];
    const logs: string[] = [];
    let run: (enable: boolean) => Promise<string> = async () => 'Enabled';
    const lnk = path.join(data, 'twOverlay.lnk');
    const vbs = path.join(data, 'twOverlayLauncher.vbs');
    const exports: Record<string, any> = {};
    let shortcutWrites = 0;
    let writeShortcut: (() => boolean) | undefined;
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
                shell: { openExternal: async () => {},
                    writeShortcutLink: (shortcutPath: string, operation: 'create', options: Electron.ShortcutDetails) => {
                        shortcutWrites++;
                        return writeShortcut ? writeShortcut() : shell.writeShortcutLink(shortcutPath, operation, options);
                    },
                },
            };
            if (name === './logger') return { log: (line: string) => logs.push(line) };
            if (name === './storeAutoStart') return {
                StoreAutoStartQueue,
                configureStoreAutoStart: (enabled: boolean) => { requests.push(enabled); return run(enabled); },
            };
            return require(name);
        },
    });
    return { data, lnk, vbs, registry, requests, dialogs, logs, exports, app,
        setRun: (value: typeof run) => { run = value; }, shortcutWrites: () => shortcutWrites,
        setShortcutWriter: (writer: () => boolean) => { writeShortcut = writer; } };
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
    assert.equal(store.shortcutWrites(), 0, 'Store에서 버전별 EXE 바로가기를 생성했습니다.');
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
    assert.equal(dev.shortcutWrites(), 0);
    assert.equal(dev.registry.length, 0);

    // 시스템 ANSI 문자셋 밖의 경로도 검사한다. 실제 바로가기를 쓰고 읽되 앱 실행·Run 등록은 하지 않는다.
    for (const directoryPrefix of ['설정-', '설정-🧪-']) {
        const normal = createHarness(false, true, directoryPrefix);
        fs.mkdirSync(path.dirname(normal.app.getPath('exe')), { recursive: true });
        fs.writeFileSync(normal.app.getPath('exe'), 'shortcut icon path fixture; never executed');
        normal.exports.setupAutoStart(true);
        await until(() => normal.registry.length === 1 || normal.logs.some(line => line.includes('FAIL')));
        assert.equal(normal.registry[0]?.openAtLogin, true, normal.logs.join('\n'));
        assert.equal(fs.existsSync(normal.lnk), true, '바로가기 생성 실패를 등록 성공으로 처리했습니다.');
        const inspected = shell.readShortcutLink(normal.lnk);
        assert.ok(inspected.cwd, '바로가기 작업 폴더가 비어 있습니다.');
        assert.ok(inspected.icon, '바로가기 아이콘 경로가 비어 있습니다.');
        // Shell은 RUNNER~1 같은 8.3 별칭을 긴 이름으로 확장할 수 있다. 실제 파일 경로를 비교한다.
        assert.equal(fs.realpathSync.native(inspected.cwd), fs.realpathSync.native(path.dirname(normal.app.getPath('exe'))));
        assert.equal(fs.realpathSync.native(inspected.target), fs.realpathSync.native(normal.vbs));
        assert.equal(fs.realpathSync.native(inspected.icon), fs.realpathSync.native(normal.app.getPath('exe')));
        assert.equal(inspected.iconIndex, 0);
        assert.equal(inspected.description, 'twOverlay Auto Start');
        assert.equal(fs.readFileSync(normal.vbs, 'utf16le'), '\ufeff' + legacy(normal.app.getPath('exe')));
        normal.exports.setupAutoStart(false);
        assert.equal(normal.registry[normal.registry.length - 1]?.openAtLogin, false);
        assert.equal(fs.existsSync(normal.vbs), false);
        assert.equal(fs.existsSync(normal.lnk), false);
        normal.exports.setupAutoStart(true);
        assert.equal(normal.registry[normal.registry.length - 1]?.openAtLogin, true);
        assert.equal(fs.realpathSync.native(shell.readShortcutLink(normal.lnk).target), fs.realpathSync.native(normal.vbs));
        normal.exports.setupAutoStart(false);
        assert.deepEqual(normal.registry.map(item => item.openAtLogin), [true, false, true, false]);
    }

    for (const writeShortcut of [() => false, () => { throw new Error('fixture shortcut failure'); }]) {
        const failed = createHarness(false);
        failed.setShortcutWriter(writeShortcut);
        failed.exports.setupAutoStart(true);
        assert.equal(failed.registry.length, 0, '바로가기 생성 실패 후 Run에 등록했습니다.');
        assert.equal(failed.logs.some(line => line.includes('FAIL')), true);
        assert.equal(failed.shortcutWrites(), 1);
    }
    console.log(JSON.stringify({ passed: true, storeMigration: true, coexistence: true,
        requestOrdering: true, windowsDisabledState: true, developmentIsolation: true,
        nativeShortcut: true, unicodeShortcut: true, shortcutFailure: true }));
}

main().then(() => { fs.rmSync(fixtureRoot, { recursive: true, force: true }); process.exit(0); })
    .catch(error => { console.error(error); process.exit(1); });
