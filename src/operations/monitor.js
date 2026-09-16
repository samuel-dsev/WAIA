function prometheusValues(text) {
  const values = new Map();
  for (const line of String(text || "").split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?[0-9]+(?:\.[0-9]+)?)$/u.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]));
  }
  return values;
}

export function createOperationalMonitor({
  baseUrl = "http://api:3001",
  metricsToken,
  alertSink,
  queueWaitingThreshold = 100,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  if (!metricsToken) throw new TypeError("METRICS_BEARER_TOKEN e obrigatorio para o monitor.");
  if (typeof alertSink?.notify !== "function") throw new TypeError("Destino de alertas e obrigatorio para o monitor.");
  const active = new Set();

  async function deliver(code, triggered, fields = {}) {
    if (triggered && !active.has(code)) {
      active.add(code);
      await alertSink.notify({ eventCode: code, severity: "critical", state: "triggered", fields });
    } else if (!triggered && active.delete(code)) {
      await alertSink.notify({ eventCode: code, severity: "info", state: "recovered", fields });
    }
  }

  async function check() {
    let health;
    let metrics;
    try {
      [health, metrics] = await Promise.all([
        fetchImpl(`${baseUrl}/health/ready`),
        fetchImpl(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } }),
      ]);
      await deliver("api_not_ready", !health.ok, { status: health.status });
      if (!metrics.ok) throw Object.assign(new Error("Coleta de metricas recusada."), { status: metrics.status });
      const values = prometheusValues(await metrics.text());
      await deliver("worker_heartbeat_missing", Number(values.get("waia_worker_heartbeats") || 0) < 1);
      await deliver("failed_jobs_open", Number(values.get("waia_failed_jobs_open") || 0) > 0, { count: values.get("waia_failed_jobs_open") || 0 });
      await deliver("outbox_jobs_failed", Number(values.get("waia_outbox_jobs_failed") || 0) > 0, { count: values.get("waia_outbox_jobs_failed") || 0 });
      await deliver("bullmq_jobs_failed", Number(values.get("waia_bullmq_jobs_failed") || 0) > 0, { count: values.get("waia_bullmq_jobs_failed") || 0 });
      await deliver("queue_backlog_high", Number(values.get("waia_bullmq_jobs_waiting") || 0) > queueWaitingThreshold, { count: values.get("waia_bullmq_jobs_waiting") || 0, threshold: queueWaitingThreshold });
      return { healthy: active.size === 0, active: [...active] };
    } catch (error) {
      try { await deliver("monitor_probe_failed", true, { status: error?.status || null, code: error?.code || "MONITOR_PROBE_FAILED" }); }
      catch (deliveryError) { logger.error?.("monitor_alert_delivery_failed", { code: deliveryError?.code || "ALERT_DELIVERY_FAILED" }); }
      return { healthy: false, active: [...active], errorCode: error?.code || "MONITOR_PROBE_FAILED" };
    }
  }

  return Object.freeze({ check });
}

export function startOperationalMonitor(monitor, { intervalMs = 60_000 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5_000) throw new TypeError("ALERT_MONITOR_INTERVAL_MS invalido.");
  let closed = false;
  let timer;
  const run = async () => {
    if (closed) return;
    await monitor.check();
    if (!closed) timer = setTimeout(run, intervalMs);
  };
  void run();
  return Object.freeze({ close() { closed = true; clearTimeout(timer); } });
}
