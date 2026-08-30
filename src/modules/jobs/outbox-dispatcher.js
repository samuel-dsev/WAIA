import { normalizeJobReference } from "./job-reference.js";
import { recordMetric } from "../../operations/metrics.js";

export function createOutboxDispatcher({
  repository,
  queue,
  batchSize = 100,
  leaseMs = 30_000,
  retryDelayMs = 1_000,
  reconcileAfterMs = 300_000,
  logger = console,
  metrics,
} = {}) {
  if (typeof repository?.claimBatch !== "function"
      || typeof repository?.markPublished !== "function"
      || typeof repository?.release !== "function") {
    throw new TypeError("Repositório de outbox incompleto.");
  }
  if (typeof queue?.add !== "function") throw new TypeError("queue.add é obrigatório.");

  async function dispatchOnce() {
    const started = process.hrtime.bigint();
    const results = [];
    try {
      const claimed = await repository.claimBatch({ limit: batchSize, leaseMs, reconcileAfterMs });
      for (const candidate of claimed) {
        const reference = normalizeJobReference(candidate);
        try {
          await queue.add(reference);
          await repository.markPublished(reference);
          void recordMetric(metrics, "increment", "waia_outbox_jobs_published_total");
          results.push({ jobId: reference.jobId, outcome: "published" });
        } catch (error) {
          await repository.release(reference, { delayMs: retryDelayMs, error });
          void recordMetric(metrics, "increment", "waia_outbox_publication_failures_total");
          logger.warn?.("outbox_publication_failed", {
            empresaId: reference.empresaId,
            jobId: reference.jobId,
            correlationId: reference.correlationId,
            code: typeof error?.code === "string" ? error.code : "QUEUE_UNAVAILABLE",
          });
          results.push({ jobId: reference.jobId, outcome: "released" });
        }
      }
      return results;
    } finally {
      void recordMetric(metrics, "observe", "waia_outbox_dispatch_duration_seconds", Number(process.hrtime.bigint() - started) / 1e9);
    }
  }

  return Object.freeze({ dispatchOnce });
}

export function startOutboxDispatcher(dispatcher, {
  intervalMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  let stopped = false;
  let timer = null;
  let current = null;
  const tick = async () => {
    if (stopped) return;
    current = dispatcher.dispatchOnce().catch((error) => {
      logger.error?.("outbox_dispatch_failed", {
        code: typeof error?.code === "string" ? error.code : "OUTBOX_DISPATCH_ERROR",
      });
    });
    await current;
    current = null;
    if (!stopped) timer = setTimer(tick, intervalMs);
  };
  timer = setTimer(tick, 0);
  return Object.freeze({
    async close() {
      stopped = true;
      if (timer) clearTimer(timer);
      if (current) await current;
    },
  });
}
