import "dotenv/config";
import { createServer } from "node:http";
import { config } from "./config.js";
import {
  assertConfigured,
  createApiApp,
  createPostgresRuntime,
} from "./bootstrap/app-runtime.js";
import { closePostgresPool } from "./infra/postgres/pool.js";
import { closeRedisConnection } from "./infra/redis/connection.js";

assertConfigured(config);

const runtime = createPostgresRuntime({ config });
await runtime.redis.ping();

const app = createApiApp({ runtime, config });
const server = createServer(app);
const port = Number(process.env.API_PORT || config.webhookPort || 3001);

function listen(serverInstance, selectedPort) {
  return new Promise((resolve, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(selectedPort, () => {
      serverInstance.off("error", reject);
      resolve();
    });
  });
}

async function shutdown(signal) {
  runtime.logger.info("api_shutdown_requested", { signal });
  runtime.health.markShuttingDown();
  await new Promise((resolve) => server.close(resolve));
  await closeRedisConnection(runtime.redis);
  await runtime.logSink?.flush?.();
  await closePostgresPool(runtime.pool);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await listen(server, port);
runtime.logger.info("api_started", {
  port,
  environment: config.environment,
  infrastructureMode: config.infrastructureMode,
});
