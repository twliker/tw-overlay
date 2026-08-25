import fs = require('node:fs');
import path = require('node:path');
import { app } from 'electron';

type ProbeScenario = 'settings' | 'checklist' | 'both';
type ProbeMode = 'write' | 'read';

interface ProbeSummary {
  profileState: string;
  settingsDirtyKeys: string[];
  checklistOperationIds: string[];
  recoverySettingsDirtyKeys: string[];
  recoveryChecklistOperationIds: string[];
}

const projectRoot = path.resolve(__dirname, '..');
const [modeValue, scenarioValue, userData, resultPath] = process.argv.slice(2);
const mode = modeValue as ProbeMode;
const scenario = scenarioValue as ProbeScenario;

if (!['write', 'read'].includes(mode)
  || !['settings', 'checklist', 'both'].includes(scenario)
  || !path.isAbsolute(userData || '')
  || !path.isAbsolute(resultPath || '')) {
  throw new Error('runtime shutdown recovery probe arguments are invalid');
}

fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

function summarize(state: any): ProbeSummary {
  return {
    profileState: String(state.profileState),
    settingsDirtyKeys: [...state.settingsDirtyKeys],
    checklistOperationIds: state.checklistOutbox.map((operation: any) => String(operation.id)),
    recoverySettingsDirtyKeys: [...(state.shutdownRecovery?.settings?.dirtyKeys || [])],
    recoveryChecklistOperationIds: [...(state.shutdownRecovery?.checklist?.operationIds || [])],
  };
}

function finish(result: Record<string, unknown>, exitCode: number): void {
  fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  app.exit(exitCode);
}

void app.whenReady().then(() => {
  try {
    const configPath = path.join(userData, 'config.json');
    if (mode === 'write' && !fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify({
        userServer: 1,
        googleSyncEnabled: true,
        googleSyncAutoSync: false,
        characterPresets: [],
        contentsCheckerItems: [],
        pendingHomeworks: [],
      }), 'utf8');
    }

    const cloudState = require(path.join(projectRoot, 'dist', 'modules', 'cloudSyncState.js')) as any;
    if (mode === 'read') {
      finish({ ok: true, summary: summarize(cloudState.load()) }, 0);
      return;
    }

    const config = require(path.join(projectRoot, 'dist', 'modules', 'config.js')) as any;
    const googleAuth = require(path.join(projectRoot, 'dist', 'modules', 'googleAuth.js')) as any;
    const cloudManager = require(path.join(projectRoot, 'dist', 'modules', 'cloudSyncManager.js')) as any;
    googleAuth.isLoggedIn = () => true;

    cloudState.update((state: any) => {
      state.profileState = 'established';
      state.settingsDirtyKeys = [];
      state.settingsDirtyAt = {};
      state.checklistOutbox = [];
      state.confirmedChecklistOperations = [];
      delete state.shutdownRecovery;
    });

    if (scenario === 'settings' || scenario === 'both') {
      if (!config.saveImmediate({ userServer: 2 })) throw new Error('settings probe config save failed');
    }
    if (scenario === 'checklist' || scenario === 'both') {
      if (!config.saveImmediate({
        characterPresets: [{ id: 'shutdown-probe-character', name: '종료 복구 확인' }],
      })) throw new Error('checklist probe config save failed');
    }
    if (!cloudManager.prepareShutdownRecovery()) throw new Error('shutdown recovery marker was not created');

    finish({ ok: true, summary: summarize(cloudState.load()) }, 0);
  } catch (error) {
    finish({
      ok: false,
      error: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error),
    }, 1);
  }
}).catch(error => {
  finish({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
});
