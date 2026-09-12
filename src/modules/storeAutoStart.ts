import { execFile } from 'child_process';
import * as path from 'path';
import { resolveStoreUpdateHelperPath } from './storeUpdater';

export type StoreStartupState = 'Disabled' | 'DisabledByUser' | 'Enabled' | 'DisabledByPolicy' | 'EnabledByPolicy';

export function parseStoreStartupResult(output: string): StoreStartupState {
    const result: unknown = JSON.parse(output.trim());
    if (!result || typeof result !== 'object'
        || !('type' in result) || result.type !== 'startup-result'
        || !('state' in result) || typeof result.state !== 'string'
        || !['Disabled', 'DisabledByUser', 'Enabled', 'DisabledByPolicy', 'EnabledByPolicy'].includes(result.state)) {
        throw new Error('Store 자동 실행 도우미 응답이 올바르지 않습니다.');
    }
    return result.state as StoreStartupState;
}

/** WinRT StartupTask는 패키지 안에서 실행되는 도우미를 통해서만 변경한다. */
export function configureStoreAutoStart(enable: boolean): Promise<StoreStartupState> {
    const helper = resolveStoreUpdateHelperPath();
    return new Promise((resolve, reject) => {
        execFile(helper, [enable ? 'startup-enable' : 'startup-disable'], {
            cwd: path.dirname(helper), windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
        }, (error, stdout) => {
            if (error) return reject(error);
            try { resolve(parseStoreStartupResult(stdout)); } catch (parseError) { reject(parseError); }
        });
    });
}

/** 실행 중인 enable 뒤에 disable이 오면 반드시 disable을 마지막에 적용한다. 실패 뒤에도 큐는 계속된다. */
export class StoreAutoStartQueue {
    private pending: Promise<void> = Promise.resolve();

    enqueue(operation: () => Promise<void>): Promise<void> {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => {});
        return result;
    }
}
