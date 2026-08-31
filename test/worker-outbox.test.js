import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxDispatcher } from "../src/modules/jobs/outbox-dispatcher.js";
import { MetricsRegistry } from "../src/operations/metrics.js";

function candidate(index = 1) {
  return {
    jobId: `job-${index}`,
    empresaId: `tenant-${index}`,
    conversationId: `conversation-${index}`,
    messageId: `message-${index}`,
    statusEventId: null,
    type: "process_inbound_message",
    correlationId: `correlation-${index}`,
    payloadVersion: 1,
  };
}

test("dispatcher publica somente IDs e confirma a outbox", async () => {
  const published = [];
  const marked = [];
  const metrics = new MetricsRegistry();
  const dispatcher = createOutboxDispatcher({
    repository: {
      async claimBatch() { return [candidate(1), candidate(2)]; },
      async markPublished(item) { marked.push(item.jobId); },
      async release() {},
    },
    queue: { async add(item) { published.push(item); } },
    metrics,
  });
  const result = await dispatcher.dispatchOnce();
  assert.deepEqual(result.map(({ outcome }) => outcome), ["published", "published"]);
  assert.deepEqual(marked, ["job-1", "job-2"]);
  assert.deepEqual(Object.keys(published[0]).sort(), [
    "conversationId", "correlationId", "empresaId", "jobId", "messageId",
    "orderId", "payloadVersion", "statusEventId", "type",
  ]);
  assert.equal(metrics.snapshot().counters.waia_outbox_jobs_published_total, 2);
  assert.equal(metrics.snapshot().summaries.waia_outbox_dispatch_duration_seconds.count, 1);
});

test("falha de Redis devolve job para outbox com erro sanitizado externamente", async () => {
  const released = [];
  const metrics = new MetricsRegistry();
  const dispatcher = createOutboxDispatcher({
    repository: {
      async claimBatch() { return [candidate()]; },
      async markPublished() { assert.fail("não deveria confirmar"); },
      async release(item, details) { released.push({ item, details }); },
    },
    queue: { async add() { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); } },
    logger: { warn() {} },
    metrics,
  });
  const result = await dispatcher.dispatchOnce();
  assert.equal(result[0].outcome, "released");
  assert.equal(released[0].item.jobId, "job-1");
  assert.equal(released[0].details.error.code, "ECONNREFUSED");
  assert.equal(metrics.snapshot().counters.waia_outbox_publication_failures_total, 1);
});
