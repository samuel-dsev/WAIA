import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { BullMqJobQueue, createBullMqWorker } from "../src/infra/redis/bullmq-adapter.js";
import { createJobProcessor, MemoryJobRepository } from "../src/modules/jobs/index.js";

test("Redis real: espera não consome attempts nem bloqueia outra conversa e preserva ordem", {
  skip: process.env.RUN_REDIS_INTEGRATION !== "true", timeout: 15_000,
}, async () => {
  assert.ok(process.env.REDIS_URL);
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queueName = "waia-ai-delay-test-" + randomUUID();
  const queue = new BullMqJobQueue({ connection, queueName, attempts: 1 });
  const repository = new MemoryJobRepository();
  const reference = (id, conversationId) => ({ jobId: id, empresaId: "synthetic", conversationId, messageId: id, type: "process_inbound_message", correlationId: id, payloadVersion: 1 });
  const first = reference("first", "same"), next = reference("next", "same"), other = reference("other", "other");
  for (const item of [first, next, other]) repository.seed(item);
  const events = [], completed = [], failed = [];
  let deadline = null, generations = 0;
  const processor = createJobProcessor({ repository, handlers: { process_inbound_message: async ({ jobId }) => {
    if (jobId === "first" && deadline === null) { generations++; deadline = Date.now() + 250; return { deferUntil: new Date(deadline).toISOString() }; }
    if (jobId === "first") assert.ok(Date.now() >= deadline);
    events.push(jobId); return { replied: true };
  } }, logger: { warn() {} } });
  const worker = createBullMqWorker({ connection, queueName, processor, concurrency: 1, logger: { error() {} } });
  worker.worker.on("completed", job => completed.push(job.id));
  worker.worker.on("failed", (_job, error) => failed.push(error.message));
  try {
    for (const item of [first, next, other]) await queue.add(item);
    const timeout = Date.now() + 8_000;
    while (completed.length < 3 && !failed.length && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(failed, []);
    assert.equal(completed.length, 3);
    assert.equal(generations, 1);
    assert.ok(events.indexOf("other") < events.indexOf("first"));
    assert.ok(events.indexOf("first") < events.indexOf("next"));
    assert.equal(repository.failed.size, 0);
  } finally {
    await worker.close();
    // Only this test's uniquely named queue is removed; existing Redis queues remain intact.
    await queue.queue.obliterate({ force: true });
    await queue.close(); await connection.quit();
  }
});
