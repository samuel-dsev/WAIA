import test from "node:test";
import assert from "node:assert/strict";
import {
  createJobProcessor,
  MemoryJobRepository,
  MemoryLockManager,
  MemoryTenantRateLimiter,
  normalizeJobReference,
  retryDelay,
} from "../src/modules/jobs/index.js";

function job(overrides = {}) {
  return {
    jobId: overrides.jobId || "job-1",
    empresaId: overrides.empresaId || "tenant-a",
    conversationId: overrides.conversationId || "conversation-1",
    messageId: overrides.messageId || "message-1",
    type: overrides.type || "process_inbound_message",
    correlationId: overrides.correlationId || "correlation-1",
    payloadVersion: 1,
  };
}

function setup(handler, references = [job()]) {
  const repository = new MemoryJobRepository();
  for (const reference of references) repository.seed(reference);
  const processor = createJobProcessor({
    repository,
    handlers: { process_inbound_message: handler },
    lockManager: new MemoryLockManager(),
    lockTtlMs: 100,
    logger: { warn() {} },
  });
  return { repository, processor };
}

test("retry exponencial aplica limite e jitter controlável", () => {
  assert.equal(retryDelay(1, { baseDelayMs: 100, jitter: 0, random: () => 1 }), 100);
  assert.equal(retryDelay(3, { baseDelayMs: 100, jitter: 0, random: () => 1 }), 400);
  assert.equal(retryDelay(8, { baseDelayMs: 100, maxDelayMs: 500, jitter: 0 }), 500);
  assert.equal(retryDelay(1, { baseDelayMs: 100, jitter: 0.25, random: () => 0 }), 75);
});

test("rate limit afeta somente a empresa que excedeu sua janela", async () => {
  const limiter = new MemoryTenantRateLimiter({ maxPerWindow: 1, windowMs: 1_000 });
  assert.equal((await limiter.consume("tenant-a")).allowed, true);
  assert.equal((await limiter.consume("tenant-a")).allowed, false);
  assert.equal((await limiter.consume("tenant-b")).allowed, true);
});

test("job duplicado é idempotente no repositório e não executa duas vezes", async () => {
  let calls = 0;
  const reference = job();
  const { processor } = setup(async () => { calls += 1; return "ok"; });
  const first = await processor.process(reference);
  const duplicate = await processor.process(reference);
  assert.equal(first.outcome, "completed");
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(calls, 1);
});

test("falha final vai para dead-letter sanitizada", async () => {
  const reference = job();
  const error = new Error("falha\nBearer abcdefghijklmnop");
  error.code = "INVALID_INPUT";
  error.retryable = false;
  const { repository, processor } = setup(async () => { throw error; });
  let discarded = false;
  await assert.rejects(processor.process(reference, {
    attempt: 1,
    maxAttempts: 5,
    discard: () => { discarded = true; },
  }), /falha/u);
  const failure = repository.failed.values().next().value;
  assert.equal(discarded, true);
  assert.equal(failure.error.code, "INVALID_INPUT");
  assert.equal(failure.error.message, "falha Bearer [REDACTED]");
});

test("referência da fila rejeita conteúdo operacional", () => {
  assert.throws(() => normalizeJobReference({ ...job(), body: "conteúdo da mensagem" }), /somente IDs/u);
});

test("shutdown gracioso aguarda job em andamento e recusa novos jobs", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = job({ jobId: "job-running" });
  const second = job({ jobId: "job-new", conversationId: "conversation-2" });
  const { repository, processor } = setup(async () => gate, [first, second]);
  const running = processor.process(first);
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = processor.shutdown();
  await assert.rejects(processor.process(second), /encerramento/u);
  release("done");
  await Promise.all([running, shutdown]);
  assert.equal(repository.records.get("tenant-a__job-running").state, "completed");
});

test("perda da renovação do slot por tenant impede concluir o job", async () => {
  const reference = job();
  const repository = new MemoryJobRepository();
  repository.seed(reference);
  const releaseTenant = async () => {};
  releaseTenant.renew = async () => false;
  const processor = createJobProcessor({
    repository,
    handlers: { process_inbound_message: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { replied: true };
    } },
    tenantLimiter: { async acquire() { return releaseTenant; } },
    lockTtlMs: 30,
    logger: { warn() {} },
  });
  await assert.rejects(
    processor.process(reference, { attempt: 1, maxAttempts: 2 }),
    (error) => error?.code === "PROCESSING_LEASE_LOST",
  );
  assert.equal(repository.records.get("tenant-a__job-1").state, "published");
});
