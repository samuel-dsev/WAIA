import test from "node:test";
import assert from "node:assert/strict";
import { createStructuredLogger } from "../src/operations/logger.js";
import { MetricsRegistry } from "../src/operations/metrics.js";
import { createHealthService } from "../src/operations/health.js";

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
