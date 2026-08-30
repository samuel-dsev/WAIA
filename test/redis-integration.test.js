import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BullMqJobQueue, closeRedisConnection, createRedisConnection } from "../src/infra/redis/index.js";
import { RedisMetricsRegistry } from "../src/operations/metrics.js";

const enabled = process.env.RUN_REDIS_INTEGRATION === "true";

test("Redis real recebe somente referências da resposta humana", { skip: !enabled }, async () => {
  assert.ok(process.env.REDIS_URL, "REDIS_URL é obrigatória no teste Redis");
  const suffix = randomUUID();
  const connection = createRedisConnection({ url: process.env.REDIS_URL });
  const queue = new BullMqJobQueue({ connection, queueName: `waia-human-integration-${suffix}` });
  const metricsPrefix = `waia:metrics:integration:${suffix}`;
  const metrics = new RedisMetricsRegistry(connection, { prefix: metricsPrefix });
  const reference = {
    jobId: randomUUID(),
    empresaId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    statusEventId: null,
    type: "send_human_message",
    correlationId: randomUUID(),
    payloadVersion: 1,
  };
  try {
    assert.equal(await connection.ping(), "PONG");
    const job = await queue.add(reference);
    assert.equal(job.name, "send_human_message");
    assert.deepEqual(job.data, reference);
    assert.deepEqual(Object.keys(job.data).sort(), [
      "conversationId", "correlationId", "empresaId", "jobId", "messageId",
      "payloadVersion", "statusEventId", "type",
    ]);
    await job.remove();
    await queue.queue.obliterate({ force: true });
    await metrics.increment("waia_jobs_completed_total", 2);
    await metrics.observe("waia_job_processing_duration_seconds", 0.25);
    await metrics.observe("waia_job_processing_duration_seconds", 0.75);
    const metricsSnapshot = await metrics.snapshot();
    assert.equal(metricsSnapshot.counters.waia_jobs_completed_total, 2);
    assert.deepEqual(metricsSnapshot.summaries.waia_job_processing_duration_seconds, {
      count: 2,
      sum: 1,
      max: 0.75,
    });
  } finally {
    await connection.del(
      `${metricsPrefix}:counters`,
      `${metricsPrefix}:gauges`,
      `${metricsPrefix}:summaries`,
      `${metricsPrefix}:summary:waia_job_processing_duration_seconds`,
    ).catch(() => {});
    await queue.close();
    await closeRedisConnection(connection);
  }
});
