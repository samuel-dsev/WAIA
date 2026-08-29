import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxDispatcher } from "../src/modules/jobs/outbox-dispatcher.js";

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
  const dispatcher = createOutboxDispatcher({
    repository: {
      async claimBatch() { return [candidate(1), candidate(2)]; },
      async markPublished(item) { marked.push(item.jobId); },
      async release() {},
    },
    queue: { async add(item) { published.push(item); } },
  });
  const result = await dispatcher.dispatchOnce();
  assert.deepEqual(result.map(({ outcome }) => outcome), ["published", "published"]);
  assert.deepEqual(marked, ["job-1", "job-2"]);
  assert.deepEqual(Object.keys(published[0]).sort(), [
    "conversationId", "correlationId", "empresaId", "jobId", "messageId",
    "payloadVersion", "statusEventId", "type",
  ]);
});

test("falha de Redis devolve job para outbox com erro sanitizado externamente", async () => {
  const released = [];
  const dispatcher = createOutboxDispatcher({
    repository: {
      async claimBatch() { return [candidate()]; },
      async markPublished() { assert.fail("não deveria confirmar"); },
      async release(item, details) { released.push({ item, details }); },
    },
    queue: { async add() { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); } },
    logger: { warn() {} },
  });
  const result = await dispatcher.dispatchOnce();
  assert.equal(result[0].outcome, "released");
  assert.equal(released[0].item.jobId, "job-1");
  assert.equal(released[0].details.error.code, "ECONNREFUSED");
});
