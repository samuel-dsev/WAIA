import { config } from "./config.js";
import { createConfiguredAlertSink } from "./operations/alert-sink.js";
import { createOperationalMonitor, startOperationalMonitor } from "./operations/monitor.js";

const alertSink = createConfiguredAlertSink(config.alerts);
if (!alertSink) throw new Error("ALERT_WEBHOOK_URL e obrigatorio para iniciar o monitor operacional.");

const monitor = createOperationalMonitor({
  baseUrl: process.env.MONITOR_API_URL || "http://api:3001",
  metricsToken: config.metrics.bearerToken,
  alertSink,
  queueWaitingThreshold: Number(process.env.ALERT_QUEUE_WAITING_THRESHOLD || 100),
});
const scheduler = startOperationalMonitor(monitor, {
  intervalMs: Number(process.env.ALERT_MONITOR_INTERVAL_MS || 60_000),
});

function shutdown() {
  scheduler.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
