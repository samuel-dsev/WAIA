import { hostname } from "node:os";

export function startWorkerHeartbeat(redis, { intervalMs = 10_000, ttlMs = 30_000, workerId = hostname(), logger = console } = {}) {
  const key = `waia:worker:heartbeat:${workerId}`;
  let timer = null;
  let closed = false;
  const beat = async () => {
    if (closed) return;
    try {
      await redis.set(key, new Date().toISOString(), "PX", ttlMs);
    } catch (error) {
      logger.error?.("worker_heartbeat_failed", { error });
    }
  };
  void beat();
  timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();
  return Object.freeze({
    key,
    async close() {
      closed = true;
      clearInterval(timer);
      try { await redis.del(key); } catch { /* expira automaticamente */ }
    },
  });
}
