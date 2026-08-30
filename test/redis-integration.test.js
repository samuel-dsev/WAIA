import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BullMqJobQueue, closeRedisConnection, createRedisConnection } from "../src/infra/redis/index.js";

const enabled = process.env.RUN_REDIS_INTEGRATION === "true";

test("Redis real recebe somente referências da resposta humana", { skip: !enabled }, async () => {
  assert.ok(process.env.REDIS_URL, "REDIS_URL é obrigatória no teste Redis");
  const suffix = randomUUID();
  const connection = createRedisConnection({ url: process.env.REDIS_URL });
  const queue = new BullMqJobQueue({ connection, queueName: `waia-human-integration-${suffix}` });
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
  } finally {
    await queue.close();
    await closeRedisConnection(connection);
  }
});
