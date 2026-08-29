import test from "node:test";
import assert from "node:assert/strict";
import {
  createJobProcessor,
  createMemoryWorker,
  MemoryJobQueue,
  MemoryJobRepository,
  MemoryLockManager,
  MemoryQueueStore,
} from "../src/modules/jobs/index.js";

function reference(empresaId, index, conversationId = `conversation-${index}`) {
  return {
    jobId: `${empresaId}-job-${index}`,
    empresaId,
    conversationId,
    messageId: `${empresaId}-message-${index}`,
    type: "process_inbound_message",
    correlationId: `${empresaId}-correlation-${index}`,
    payloadVersion: 1,
  };
}

function platform(handler, references, options = {}) {
  const queue = new MemoryJobQueue(options);
  const repository = new MemoryJobRepository();
  for (const item of references) repository.seed(item);
  const processor = createJobProcessor({
    repository,
    handlers: { process_inbound_message: handler },
    lockManager: new MemoryLockManager(options),
    lockTtlMs: 1_000,
    logger: { warn() {} },
  });
  return { queue, repository, processor };
}

test("retry transitório conclui sem duplicar efeito", async () => {
  const item = reference("tenant-a", 1);
  let calls = 0;
  const setup = platform(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("temporário"), { retryable: true });
    return "ok";
  }, [item]);
  await setup.queue.add(item, { attempts: 5 });
  const worker = createMemoryWorker({ queue: setup.queue, processor: setup.processor });
  const counts = await worker.drain();
  assert.equal(calls, 3);
  assert.deepEqual(counts, { waiting: 0, active: 0, completed: 1, failed: 0 });
});

test("ordem é preservada por conversa mesmo com concorrência", async () => {
  const items = [1, 2, 3, 4].map((index) => reference("tenant-a", index, "same-conversation"));
  const order = [];
  const setup = platform(async (item) => {
    order.push(item.jobId);
    await new Promise((resolve) => setImmediate(resolve));
  }, items);
  for (const item of items) await setup.queue.add(item);
  await createMemoryWorker({ queue: setup.queue, processor: setup.processor, concurrency: 4 }).drain();
  assert.deepEqual(order, items.map(({ jobId }) => jobId));
});

test("round-robin evita que tenant volumoso monopolize o worker", async () => {
  const items = [
    reference("tenant-a", 1), reference("tenant-a", 2), reference("tenant-a", 3),
    reference("tenant-b", 1), reference("tenant-b", 2),
  ];
  const order = [];
  const setup = platform(async (item) => { order.push(item.empresaId); }, items);
  for (const item of items) await setup.queue.add(item);
  await createMemoryWorker({ queue: setup.queue, processor: setup.processor }).drain();
  assert.deepEqual(order.slice(0, 4), ["tenant-a", "tenant-b", "tenant-a", "tenant-b"]);
  assert.deepEqual(setup.queue.counts(), { waiting: 0, active: 0, completed: 5, failed: 0 });
});

test("reinício recupera job cujo lease expirou", async () => {
  let now = 1_000;
  const clock = () => now;
  const store = new MemoryQueueStore();
  const item = reference("tenant-a", 1);
  const first = platform(async () => "ok", [item], { store, now: clock });
  await first.queue.add(item);
  const abandoned = first.queue.claim({ leaseMs: 100 });
  assert.equal(abandoned.state, "active");
  now += 101;

  const restartedQueue = new MemoryJobQueue({ store, now: clock });
  const restartedWorker = createMemoryWorker({ queue: restartedQueue, processor: first.processor });
  await restartedWorker.drain();
  assert.equal(restartedQueue.counts().completed, 1);
  assert.equal(store.jobs.get("tenant-a__tenant-a-job-1").attempts, 2);
});

test("dois workers compartilham store sem processar job duas vezes", async () => {
  const items = Array.from({ length: 12 }, (_, index) => reference(
    index % 2 ? "tenant-b" : "tenant-a",
    index + 1,
  ));
  const seen = new Set();
  const setup = platform(async (item) => {
    assert.equal(seen.has(item.jobId), false);
    seen.add(item.jobId);
    await new Promise((resolve) => setImmediate(resolve));
  }, items);
  for (const item of items) await setup.queue.add(item);
  const workerA = createMemoryWorker({ queue: setup.queue, processor: setup.processor, concurrency: 2 });
  const workerB = createMemoryWorker({ queue: setup.queue, processor: setup.processor, concurrency: 2 });
  await Promise.all([workerA.drain(), workerB.drain()]);
  assert.equal(seen.size, items.length);
  assert.equal(setup.queue.counts().completed, items.length);
});
