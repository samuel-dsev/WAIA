import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { createStructuredLogger } from "../src/operations/logger.js";
import {
  MetricsRegistry,
  createMetricsHandler,
  createOperationalMetricsCollector,
} from "../src/operations/metrics.js";
import { createHealthService } from "../src/operations/health.js";
import { assertMetricsConfiguration } from "../src/config.js";

test("logger estruturado remove segredos", () => {
  const lines = [];
  const logger = createStructuredLogger({ output: { info: (line) => lines.push(line) } });
  logger.info("test", { authorization: "Bearer synthetic-secret", safe: "ok" });
  assert.doesNotMatch(lines[0], /synthetic-secret/u);
  assert.equal(JSON.parse(lines[0]).safe, "ok");
});

test("métricas agregam sem labels de alta cardinalidade", () => {
  const metrics = new MetricsRegistry();
  metrics.increment("waia_messages_received_total", 2);
  metrics.observe("waia_queue_seconds", 1.5);
  assert.match(metrics.prometheus(), /waia_messages_received_total 2/u);
  assert.equal(metrics.snapshot().summaries.waia_queue_seconds.count, 1);
  assert.throws(() => metrics.increment('waia_requests_total{tenant="a"}'), /Nome de métrica inválido/u);
  assert.throws(() => metrics.observe("waia_queue_seconds", -1), /Valor de métrica inválido/u);
});

function metricsPool(row) {
  return {
    async connect() {
      return {
        async query(sql) {
          if (String(sql).includes("active_tenants")) return { rows: [row] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

async function request(app, path, options = {}) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`, options);
  } finally {
    server.close();
  }
}

test("coletor combina contadores compartilhados e gauges operacionais sem identificar tenants", async () => {
  const metrics = new MetricsRegistry();
  metrics.increment("waia_jobs_completed_total", 3);
  const collector = createOperationalMetricsCollector({
    metrics,
    pool: metricsPool({
      active_tenants: 2, outbox_pending: 4, outbox_processing: 1, outbox_published: 3,
      outbox_failed: 2, failed_jobs_open: 2, messages_pending: 5, messages_failed: 2,
      ai_usage_records: 7, ai_tokens_recorded: 100, ai_cost_recorded: 0.25,
    }),
    queue: { async getJobCounts() { return { waiting: 2, active: 1, delayed: 3, failed: 4 }; } },
    redis: { async scan() { return ["0", ["waia:worker:heartbeat:worker-a"]]; } },
  });
  const output = await collector.prometheus();
  assert.match(output, /waia_jobs_completed_total 3/u);
  assert.match(output, /waia_outbox_jobs_pending 4/u);
  assert.match(output, /waia_bullmq_jobs_delayed 3/u);
  assert.match(output, /waia_worker_heartbeats 1/u);
  assert.doesNotMatch(output, /\{|tenant-a|empresa-|conversation_id|message_id/iu);
});

test("endpoint Prometheus exige Bearer dedicado e envia headers seguros", async () => {
  const token = "synthetic-metrics-token-at-least-32-characters";
  const app = express();
  app.get("/metrics", createMetricsHandler({
    collector: { async prometheus() { return "# TYPE waia_up gauge\nwaia_up 1\n"; } },
    token,
  }));
  const denied = await request(app, "/metrics");
  const accepted = await request(app, "/metrics", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /Bearer/u);
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get("content-type"), /text\/plain;[^\n]*version=0\.0\.4/u);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.equal(await accepted.text(), "# TYPE waia_up gauge\nwaia_up 1\n");
});

test("produção exige token de métricas dedicado com entropia mínima", () => {
  const production = {
    environment: "production",
    infrastructureMode: "postgres",
    database: { url: "postgres://app@example.invalid/db" },
    redis: { url: "redis://example.invalid" },
    security: { masterKeyring: "synthetic-keyring", sessionPepper: "synthetic-pepper" },
    metrics: { bearerToken: "curto" },
    media: { storageRoot: "/synthetic-media" },
    whatsapp: { verifyToken: "synthetic-verify", appSecret: "synthetic-secret" },
  };
  assert.throws(() => assertMetricsConfiguration(production), /METRICS_BEARER_TOKEN>=32/u);
  assert.doesNotThrow(() => assertMetricsConfiguration({
    ...production,
    metrics: { bearerToken: "synthetic-metrics-token-at-least-32-characters" },
  }));
});

test("health público é mínimo e prontidão depende só da infraestrutura essencial", async () => {
  const service = createHealthService({
    database: async () => ({ state: "healthy" }),
    redis: async () => ({ state: "healthy" }),
    integrations: { openai: async () => ({ state: "not_configured" }) },
  });
  assert.deepEqual(service.live(), { status: "ok" });
  assert.deepEqual(await service.ready(), { status: "ready" });
  assert.equal((await service.diagnostics()).components.at(-1).state, "not_configured");
});
