export function createGoogleSheetsSyncRunner({ configurationResolver, integration, logger = console } = {}) {
  if (typeof configurationResolver?.listEnabledTenants !== "function") throw new TypeError("configurationResolver.listEnabledTenants é obrigatório.");
  if (typeof integration?.syncTenant !== "function") throw new TypeError("integration.syncTenant é obrigatório.");
  return Object.freeze({
    async runOnce() {
      const results = [];
      for (const tenant of await configurationResolver.listEnabledTenants()) {
        try {
          results.push({ empresaId: tenant.empresaId, ...await integration.syncTenant(tenant) });
        } catch (error) {
          logger.error?.("google_sheets_tenant_sync_failed", { empresaId: tenant.empresaId, code: error?.code || "GOOGLE_SYNC_FAILED" });
          results.push({ empresaId: tenant.empresaId, health: "unavailable" });
        }
      }
      return results;
    },
  });
}

export function startGoogleSheetsSyncScheduler(runner, { intervalMs = 120_000, logger = console } = {}) {
  let timer;
  let running;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(run, intervalMs);
    timer.unref?.();
  };
  const run = () => {
    if (closed || running) return running;
    running = runner.runOnce().catch((error) => logger.error?.("google_sheets_sync_cycle_failed", { code: error?.code || "GOOGLE_SYNC_FAILED" })).finally(() => {
      running = null;
      schedule();
    });
    return running;
  };
  run();
  return Object.freeze({ runNow: run, async close() { closed = true; if (timer) clearTimeout(timer); await running; } });
}
