import { performance } from "node:perf_hooks";
import {
  MemoryJobQueue,
  MemoryQueueStore,
  createMemoryWorker,
} from "../src/modules/jobs/memory-adapter.js";

const CORRELATION_ID = "00000000-0000-4000-8000-000000000001";

function intArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} deve ser inteiro positivo.`);
  return value;
}

function ref({ tenant, index, conversations }) {
  const conversation = index % conversations;
  return {
    jobId: `job-${tenant}-${index}`,
    empresaId: `tenant-${tenant}`,
    conversationId: `conversation-${tenant}-${conversation}`,
    messageId: `message-${tenant}-${index}`,
    type: "process_inbound_message",
    correlationId: CORRELATION_ID,
    payloadVersion: 1,
  };
}

async function runScenario({ name, tenants, jobs, conversations, workerConcurrency, tenantConcurrency, heavyTenant = false }) {
  const store = new MemoryQueueStore();
  const queue = new MemoryJobQueue({ store, tenantConcurrency });
  const processedByTenant = new Map();
  const processor = {
    async process(reference) {
      processedByTenant.set(reference.empresaId, (processedByTenant.get(reference.empresaId) || 0) + 1);
      return { ok: true };
    },
  };

  for (let i = 0; i < jobs; i += 1) {
    const tenant = heavyTenant && i < Math.floor(jobs * 0.7) ? 1 : (i % tenants) + 1;
    await queue.add(ref({ tenant, index: i, conversations }));
  }

  const started = performance.now();
  const worker = createMemoryWorker({ queue, processor, concurrency: workerConcurrency });
  const counts = await worker.drain();
  const durationMs = Math.max(1, performance.now() - started);
  return {
    name,
    tenants,
    registeredTenants: tenants,
    jobs,
    conversationsPerTenant: conversations,
    workerConcurrency,
    tenantConcurrency,
    durationMs: Number(durationMs.toFixed(2)),
    throughputPerSecond: Number((jobs / (durationMs / 1000)).toFixed(2)),
    counts,
    processedByTenant: Object.fromEntries([...processedByTenant.entries()].sort()),
  };
}

const scale = intArg("scale", 1);
const scenarios = [
  { name: "5-active-tenants", tenants: 5, jobs: 250, conversations: 20, workerConcurrency: 4, tenantConcurrency: 1 },
  { name: "20-small-tenants", tenants: 20, jobs: 400, conversations: 10, workerConcurrency: 8, tenantConcurrency: 1 },
  { name: "100-registered-tenants", tenants: 100, jobs: 500, conversations: 5, workerConcurrency: 8, tenantConcurrency: 1 },
  { name: "distributed-spike", tenants: 20, jobs: 800, conversations: 20, workerConcurrency: 12, tenantConcurrency: 2 },
  { name: "single-heavy-tenant", tenants: 10, jobs: 800, conversations: 25, workerConcurrency: 12, tenantConcurrency: 1, heavyTenant: true },
].map((scenario) => ({ ...scenario, jobs: scenario.jobs * scale }));

const results = [];
for (const scenario of scenarios) results.push(await runScenario(scenario));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scale, results }, null, 2));
