export function installGracefulShutdown(runtime, {
  processObject = process,
  signals = ["SIGTERM", "SIGINT"],
  logger = console,
} = {}) {
  let closing = false;
  const listeners = new Map();
  for (const signal of signals) {
    const listener = async () => {
      if (closing) return;
      closing = true;
      logger.info?.("worker_shutdown_started", { signal });
      try {
        await runtime.close();
        logger.info?.("worker_shutdown_completed", { signal });
      } catch (error) {
        logger.error?.("worker_shutdown_failed", {
          signal,
          code: typeof error?.code === "string" ? error.code : "WORKER_SHUTDOWN_ERROR",
        });
      }
    };
    listeners.set(signal, listener);
    processObject.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) processObject.removeListener(signal, listener);
  };
}
