import { Queue, Worker } from "bullmq";
import { normalizeJobReference, queueJobId } from "../../modules/jobs/job-reference.js";

export class BullMqJobQueue {
  constructor({
    connection,
    queueName = "waia-messages",
    attempts = 5,
    baseDelayMs = 1_000,
    jitter = 0.25,
  } = {}) {
    if (!connection) throw new TypeError("Conexão Redis obrigatória.");
    this.attempts = attempts;
    this.queue = new Queue(queueName, {
      connection,
      defaultJobOptions: {
        attempts,
        backoff: { type: "exponential", delay: baseDelayMs, jitter },
        removeOnComplete: { age: 3_600, count: 10_000 },
        removeOnFail: { age: 604_800, count: 20_000 },
      },
    });
  }

  add(input, options = {}) {
    const reference = normalizeJobReference(input);
    return this.queue.add(reference.type, reference, {
      jobId: queueJobId(reference),
      attempts: options.attempts || this.attempts,
      ...options,
    });
  }

  close() {
    return this.queue.close();
  }
}

export function createBullMqWorker({
  connection,
  queueName = "waia-messages",
  processor,
  concurrency = 4,
  logger = console,
} = {}) {
  if (typeof processor?.process !== "function") throw new TypeError("processor.process é obrigatório.");
  const worker = new Worker(queueName, async (job) => processor.process(job.data, {
    attempt: job.attemptsMade + 1,
    maxAttempts: Number(job.opts.attempts) || 1,
    discard: () => job.discard(),
  }), { connection, concurrency });
  worker.on("error", (error) => logger.error?.("bullmq_worker_error", {
    code: typeof error?.code === "string" ? error.code : "BULLMQ_WORKER_ERROR",
  }));

  let closing = false;
  return Object.freeze({
    worker,
    async close() {
      if (closing) return;
      closing = true;
      await worker.pause(true);
      await worker.close();
      await processor.shutdown?.();
    },
  });
}
