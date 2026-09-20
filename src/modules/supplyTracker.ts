import { chatParser } from './chatParser';
import { SupplyRun } from '../shared/supplyRecapture';
import { sendToFirstWindowByPage } from './windowMessaging';

const run = new SupplyRun();
let started = false;
export function startSupplyTracker(): void {
  if (started) return;
  started = true;
  chatParser.on('SUPPLY_RECAPTURE', event => {
    if (run.observe(event, Date.now())) sendToFirstWindowByPage('game-overlay.html', 'supply-run-update', run.snapshot());
  });
}
export const getSupplyRun = () => run.snapshot();
