import { config } from './config.js';
import { runCollectAll } from './collector/collect.js';
import { runReconcileAll } from './collector/reconcile.js';
import { purgeExpired } from './domain/observations.js';
import { recordAudit } from './domain/audit.js';

const state = { collectTimer: null, reconcileTimer: null, running: false, lastCollectAt: null, lastReconcileAt: null };

async function collectTick() {
  if (state.running) return;
  state.running = true;
  try {
    const results = await runCollectAll();
    state.lastCollectAt = Date.now();
    const failed = results.filter((r) => r.status === 'failed').length;
    if (failed) {
      recordAudit({
        action: 'scheduler.collect', entityType: 'device', source: 'scheduler',
        result: 'ok', after: { devices: results.length, failed },
      });
    }
  } catch (e) {
    recordAudit({ action: 'scheduler.collect', entityType: 'device', source: 'scheduler', result: 'fail', reason: e.message });
  } finally {
    state.running = false;
  }
}

function reconcileTick() {
  try {
    const created = runReconcileAll();
    state.lastReconcileAt = Date.now();
    purgeExpired();
    return created.length;
  } catch (e) {
    recordAudit({ action: 'scheduler.reconcile', entityType: 'ticket', source: 'scheduler', result: 'fail', reason: e.message });
    return 0;
  }
}

export function startScheduler() {
  if (state.collectTimer) return;
  state.collectTimer = setInterval(collectTick, config.collectIntervalMs);
  state.reconcileTimer = setInterval(reconcileTick, config.reconcileIntervalMs);
  collectTick();
}

export function stopScheduler() {
  if (state.collectTimer) clearInterval(state.collectTimer);
  if (state.reconcileTimer) clearInterval(state.reconcileTimer);
  state.collectTimer = null;
  state.reconcileTimer = null;
}

export function schedulerStatus() {
  return {
    collect_interval_ms: config.collectIntervalMs,
    reconcile_interval_ms: config.reconcileIntervalMs,
    last_collect_at: state.lastCollectAt,
    last_reconcile_at: state.lastReconcileAt,
    running: state.running,
  };
}

export { collectTick, reconcileTick };
