import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateStatusInfo } from './shared/types';

contextBridge.exposeInMainWorld('splashAPI', {
    onUpdateStatus: (callback: (data: UpdateStatusInfo) => void) => {
        ipcRenderer.on('update-status', (_e, data: UpdateStatusInfo) => callback(data));
    }
});
