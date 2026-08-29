import { INTEGRATION_HEALTH } from "../core/contracts.js";

async function probe(name, dependency) {
  if (!dependency) return { name, state: "not_configured" };
  try {
    const result = typeof dependency.health === "function" ? await dependency.health() : await dependency();
    const state = result?.state || result?.status || "healthy";
    return { name, state: INTEGRATION_HEALTH.includes(state) ? state : "healthy" };
  } catch (error) {
    return { name, state: "unavailable", errorCode: error?.code || "UNAVAILABLE" };
  }
}

export function createHealthService({ database, redis, worker, integrations = {} } = {}) {
  let shuttingDown = false;
  return Object.freeze({
    markShuttingDown() { shuttingDown = true; },
    live() { return { status: "ok" }; },
    async ready() {
      const required = await Promise.all([probe("postgres", database), probe("redis", redis)]);
      return { status: !shuttingDown && required.every((item) => item.state === "healthy") ? "ready" : "not_ready" };
    },
    async diagnostics() {
      const entries = await Promise.all([
        probe("postgres", database), probe("redis", redis), probe("worker", worker),
        ...Object.entries(integrations).map(([name, value]) => probe(name, value)),
      ]);
      return { status: shuttingDown ? "shutting_down" : "running", components: entries };
    },
  });
}
