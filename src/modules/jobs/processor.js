import { normalizeJobReference, RetryableJobError, sanitizeJobError } from "./job-reference.js";
import { TenantConcurrencyLimiter } from "./tenant-limiter.js";

function requireMethod(target, method, dependency) {
  if (typeof target?.[method] !== "function") {
    throw new TypeError(`${dependency}.${method} é obrigatório.`);
  }
}

function noLock() {
  return { async renew() { return true; }, async release() {} };
}

export function createJobProcessor({
  repository,
  handlers,
  lockManager,
  tenantLimiter = new TenantConcurrencyLimiter(),
  tenantRateLimiter,
  lockTtlMs = 30_000,
  logger = console,
} = {}) {
  requireMethod(repository, "claim", "repository");
  requireMethod(repository, "complete", "repository");
  requireMethod(repository, "retry", "repository");
  requireMethod(repository, "fail", "repository");
  if (!handlers || typeof handlers !== "object") throw new TypeError("handlers é obrigatório.");
  if (lockManager) requireMethod(lockManager, "acquire", "lockManager");
  if (tenantRateLimiter) requireMethod(tenantRateLimiter, "consume", "tenantRateLimiter");

  const inflight = new Set();
  let accepting = true;

  async function process(input, execution = {}) {
    if (!accepting) throw new RetryableJobError("Worker em encerramento.", "WORKER_SHUTTING_DOWN");
    const reference = normalizeJobReference(input);
    const attempt = Math.max(1, Number(execution.attempt) || 1);
    const maxAttempts = Math.max(attempt, Number(execution.maxAttempts) || 5);
    async function recordFailure(error) {
      const finalAttempt = error?.retryable === false || attempt >= maxAttempts;
      const sanitized = sanitizeJobError(error);
      if (finalAttempt) {
        await repository.fail(reference, { attempt, maxAttempts, error: sanitized });
        execution.discard?.();
        error.permanentFailureRecorded = true;
      } else {
        await repository.retry(reference, { attempt, maxAttempts, error: sanitized });
      }
      logger.warn?.("job_processing_failed", {
        empresaId: reference.empresaId,
        jobId: reference.jobId,
        correlationId: reference.correlationId,
        attempt,
        finalAttempt,
        code: sanitized.code,
      });
    }
    const rate = tenantRateLimiter
      ? await tenantRateLimiter.consume(reference.empresaId)
      : { allowed: true };
    if (!rate?.allowed) {
      const error = new RetryableJobError("Limite de processamento da empresa atingido.", "TENANT_RATE_LIMIT");
      error.retryAfterMs = rate?.retryAfterMs;
      await recordFailure(error);
      throw error;
    }
    const releaseTenant = await tenantLimiter.acquire(reference.empresaId);
    if (!releaseTenant) {
      const error = new RetryableJobError("Limite concorrente da empresa atingido.", "TENANT_CONCURRENCY_LIMIT");
      await recordFailure(error);
      throw error;
    }

    const running = (async () => {
      let lease;
      let renewTimer;
      let lockLost = false;
      try {
        if (reference.conversationId && lockManager) {
          lease = await lockManager.acquire(
            `${reference.empresaId}:${reference.conversationId}`,
            { ttlMs: lockTtlMs },
          );
          if (!lease) throw new RetryableJobError("Conversa ocupada.", "CONVERSATION_BUSY");
        } else {
          lease = noLock();
        }
        if (typeof lease?.renew === "function" || typeof releaseTenant?.renew === "function") {
          renewTimer = setInterval(async () => {
            try {
              if (typeof lease?.renew === "function" && !await lease.renew(lockTtlMs)) lockLost = true;
              if (typeof releaseTenant?.renew === "function" && !await releaseTenant.renew(lockTtlMs)) lockLost = true;
            } catch {
              lockLost = true;
            }
          }, Math.max(10, Math.floor(lockTtlMs / 3)));
          renewTimer.unref?.();
        }

        const claimed = await repository.claim(reference, { attempt, leaseMs: lockTtlMs });
        if (claimed?.outcome === "completed") return { outcome: "duplicate", reference };
        if (claimed?.outcome !== "claimed") {
          throw new RetryableJobError("Job ainda não pode ser processado em ordem.", "JOB_NOT_CLAIMED");
        }
        const handler = handlers[reference.type];
        if (typeof handler !== "function") {
          const error = new Error(`Tipo de job sem handler: ${reference.type}.`);
          error.code = "JOB_HANDLER_NOT_FOUND";
          error.retryable = false;
          throw error;
        }

        const result = await handler(reference, claimed.record);
        if (lockLost) throw new RetryableJobError("Lease de processamento foi perdido.", "PROCESSING_LEASE_LOST");
        await repository.complete(reference, { attempt, result });
        return { outcome: "completed", reference, result };
      } catch (error) {
        await recordFailure(error);
        throw error;
      } finally {
        if (renewTimer) clearInterval(renewTimer);
        try { await lease?.release(); } catch {
          logger.warn?.("conversation_lock_release_failed", {
            empresaId: reference.empresaId,
            conversationId: reference.conversationId,
          });
        }
        await releaseTenant();
      }
    })();

    inflight.add(running);
    try {
      return await running;
    } finally {
      inflight.delete(running);
    }
  }

  async function shutdown() {
    accepting = false;
    await Promise.allSettled([...inflight]);
  }

  return Object.freeze({ process, shutdown });
}
