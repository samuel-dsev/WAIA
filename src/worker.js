import { config } from "./config.js";
import {
  assertConfigured,
  createPostgresRuntime,
  createWorkerRuntime,
} from "./bootstrap/app-runtime.js";
import { closePostgresPool } from "./infra/postgres/pool.js";
import { closeRedisConnection } from "./infra/redis/connection.js";

assertConfigured(config);

const runtime = createPostgresRuntime({ config });

await runtime.redis.ping();
const workerRuntime = createWorkerRuntime({ runtime, config });

runtime.logger.info("worker_started", {
  queueName: config.redis.queueName,
  concurrency: config.redis.workerConcurrency,
});

async function shutdown(signal) {
  runtime.logger.info("worker_shutdown_requested", { signal });
  await workerRuntime.close();
  await closeRedisConnection(runtime.redis);
  await runtime.logSink?.flush?.();
  await closePostgresPool(runtime.pool);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
