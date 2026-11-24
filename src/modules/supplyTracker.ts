import {onProfileProgress} from './profileParserEvents';
import {recordEventTime} from './recordEffects';
import { SupplyRun } from '../shared/supplyRecapture';
import type {SupplyRunState} from '../shared/types';
import { sendToFirstWindowByPage } from './windowMessaging';

const run = new SupplyRun();
let started = false;
export function startSupplyTracker(): void {
  if (started) return;
  started = true;
  onProfileProgress('SUPPLY_RECAPTURE', event => {
    if (run.observe(event, recordEventTime())) sendToFirstWindowByPage('game-overlay.html', 'supply-run-update', run.snapshot());
  });
}
export const getSupplyRun = () => run.snapshot();
export function restoreSupplyRun(state:SupplyRunState | null):void {
  run.restore(state);sendToFirstWindowByPage('game-overlay.html','supply-run-update',run.snapshot());
}
