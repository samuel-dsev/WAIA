import { timingSafeEqual } from "node:crypto";
import { withPlatformTransaction } from "../infra/postgres/transaction.js";

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const SUMMARY_SCRIPT = `
redis.call('SADD', KEYS[2], ARGV[2])
local current = redis.call('HGET', KEYS[1], 'max')
redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HINCRBYFLOAT', KEYS[1], 'sum', ARGV[1])
if not current or tonumber(ARGV[1]) > tonumber(current) then
  redis.call('HSET', KEYS[1], 'max', ARGV[1])
end
return 1
`;

function metricName(value) {
  const name = String(value || "");
  if (!NAME.test(name)) throw new TypeError("Nome de métrica inválido.");
  return name;
}

function metricValue(value, { nonNegative = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (nonNegative && number < 0)) {
    throw new TypeError("Valor de métrica inválido.");
  }
  return number;
}

function numericObject(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [metricName(name), Number(item) || 0]));
}

export function formatPrometheus(snapshot = {}) {
  const counters = numericObject(snapshot.counters);
  const gauges = numericObject(snapshot.gauges);
  const summaries = snapshot.summaries || {};
  const lines = [];
  for (const name of Object.keys(counters).sort()) {
    lines.push(`# TYPE ${name} counter`, `${name} ${counters[name]}`);
  }
  for (const name of Object.keys(gauges).sort()) {
    lines.push(`# TYPE ${name} gauge`, `${name} ${gauges[name]}`);
  }
  for (const name of Object.keys(summaries).sort()) {
    metricName(name);
    const value = summaries[name] || {};
    lines.push(
      `# TYPE ${name} summary`,
      `${name}_count ${Number(value.count) || 0}`,
      `${name}_sum ${Number(value.sum) || 0}`,
      `# TYPE ${name}_max gauge`,
      `${name}_max ${Number(value.max) || 0}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export class MetricsRegistry {
  #counters = new Map();
  #gauges = new Map();
  #summaries = new Map();

  increment(name, value = 1) {
    name = metricName(name);
    const amount = metricValue(value, { nonNegative: true });
    this.#counters.set(name, (this.#counters.get(name) || 0) + amount);
  }
  set(name, value) { this.#gauges.set(metricName(name), metricValue(value)); }
  observe(name, value) {
    name = metricName(name);
    const observation = metricValue(value, { nonNegative: true });
    const current = this.#summaries.get(name) || { count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += observation;
    current.max = Math.max(current.max, observation);
    this.#summaries.set(name, current);
  }
  snapshot() {
    return Object.freeze({
      counters: Object.fromEntries(this.#counters),
      gauges: Object.fromEntries(this.#gauges),
      summaries: Object.fromEntries([...this.#summaries].map(([name, value]) => [name, { ...value }])),
    });
  }
  prometheus() { return formatPrometheus(this.snapshot()); }
}

export class RedisMetricsRegistry {
  constructor(redis, { prefix = "waia:metrics" } = {}) {
    if (["hincrbyfloat", "hset", "hgetall", "sadd", "smembers", "eval"].some((method) => typeof redis?.[method] !== "function")) {
      throw new TypeError("Cliente Redis inválido para métricas.");
    }
    this.redis = redis;
    this.prefix = String(prefix);
  }

  increment(name, value = 1) {
    return this.redis.hincrbyfloat(`${this.prefix}:counters`, metricName(name), metricValue(value, { nonNegative: true }));
  }

  set(name, value) {
    return this.redis.hset(`${this.prefix}:gauges`, metricName(name), metricValue(value));
  }

  async observe(name, value) {
    const normalizedName = metricName(name);
    const observation = metricValue(value, { nonNegative: true });
    await this.redis.eval(
      SUMMARY_SCRIPT,
      2,
      `${this.prefix}:summary:${normalizedName}`,
      `${this.prefix}:summaries`,
      observation,
      normalizedName,
    );
  }

  async snapshot() {
    const [counterValues, gaugeValues, summaryNames] = await Promise.all([
      this.redis.hgetall(`${this.prefix}:counters`),
      this.redis.hgetall(`${this.prefix}:gauges`),
      this.redis.smembers(`${this.prefix}:summaries`),
    ]);
    const orderedNames = summaryNames.map(metricName).sort();
    const summaryValues = await Promise.all(
      orderedNames.map((name) => this.redis.hgetall(`${this.prefix}:summary:${name}`)),
    );
    return Object.freeze({
      counters: numericObject(counterValues),
      gauges: numericObject(gaugeValues),
      summaries: Object.fromEntries(orderedNames.map((name, index) => [name, {
        count: Number(summaryValues[index]?.count) || 0,
        sum: Number(summaryValues[index]?.sum) || 0,
        max: Number(summaryValues[index]?.max) || 0,
      }])),
    });
  }

  async prometheus(extra = {}) {
    const snapshot = await this.snapshot();
    return formatPrometheus({
      counters: { ...snapshot.counters, ...(extra.counters || {}) },
      gauges: { ...snapshot.gauges, ...(extra.gauges || {}) },
      summaries: { ...snapshot.summaries, ...(extra.summaries || {}) },
    });
  }
}

export function recordMetric(metrics, method, ...args) {
  try {
    const operation = metrics?.[method]?.(...args);
    return Promise.resolve(operation).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

async function workerHeartbeatCount(redis) {
  if (typeof redis?.scan !== "function") return 0;
  let cursor = "0";
  let count = 0;
  do {
    const result = await redis.scan(cursor, "MATCH", "waia:worker:heartbeat:*", "COUNT", 100);
    cursor = String(result?.[0] ?? "0");
    count += Array.isArray(result?.[1]) ? result[1].length : 0;
  } while (cursor !== "0");
  return count;
}

export function createOperationalMetricsCollector({ metrics, pool, queue, redis, cacheTtlMs = 5_000 } = {}) {
  if (typeof metrics?.snapshot !== "function") throw new TypeError("Registry de métricas obrigatório.");
  if (!pool?.connect) throw new TypeError("Pool PostgreSQL obrigatório para métricas.");

  let cached = null;
  let cacheExpiresAt = 0;
  let inFlight = null;

  async function collectFresh() {
    const [snapshot, database, queueCounts, heartbeats] = await Promise.all([
      metrics.snapshot(),
      withPlatformTransaction(pool, {}, async ({ client }) => (await client.query(`SELECT
        (SELECT count(*)::int FROM empresas WHERE status = 'ativa' AND deleted_at IS NULL) AS active_tenants,
        (SELECT count(*)::int FROM outbox_jobs WHERE status = 'pendente') AS outbox_pending,
        (SELECT count(*)::int FROM outbox_jobs WHERE status = 'em_publicacao') AS outbox_processing,
        (SELECT count(*)::int FROM outbox_jobs WHERE status = 'publicado') AS outbox_published,
        (SELECT count(*)::int FROM outbox_jobs WHERE status = 'falhou') AS outbox_failed,
        (SELECT count(*)::int FROM jobs_falhos WHERE resolved_at IS NULL) AS failed_jobs_open,
        (SELECT count(*)::int FROM mensagens WHERE status IN ('recebida','enfileirada','processando')) AS messages_pending,
        (SELECT count(*)::int FROM mensagens WHERE status = 'falhou') AS messages_failed,
        (SELECT count(*)::int FROM uso_ia) AS ai_usage_records,
        (SELECT coalesce(sum(total_tokens),0)::float8 FROM uso_ia) AS ai_tokens_recorded,
        (SELECT coalesce(sum(custo_estimado),0)::float8 FROM uso_ia) AS ai_cost_recorded
      `)).rows[0]),
      typeof (queue?.queue || queue)?.getJobCounts === "function"
        ? (queue.queue || queue).getJobCounts("waiting", "active", "delayed", "failed")
        : {},
      workerHeartbeatCount(redis),
    ]);
    const gauges = {
      ...snapshot.gauges,
      waia_active_tenants: database.active_tenants,
      waia_outbox_jobs_pending: database.outbox_pending,
      waia_outbox_jobs_processing: database.outbox_processing,
      waia_outbox_jobs_published: database.outbox_published,
      waia_outbox_jobs_failed: database.outbox_failed,
      waia_failed_jobs_open: database.failed_jobs_open,
      waia_messages_pending: database.messages_pending,
      waia_messages_failed: database.messages_failed,
      waia_ai_usage_records: database.ai_usage_records,
      waia_ai_tokens_recorded: database.ai_tokens_recorded,
      waia_ai_cost_recorded: database.ai_cost_recorded,
      waia_bullmq_jobs_waiting: queueCounts.waiting || 0,
      waia_bullmq_jobs_active: queueCounts.active || 0,
      waia_bullmq_jobs_delayed: queueCounts.delayed || 0,
      waia_bullmq_jobs_failed: queueCounts.failed || 0,
      waia_worker_heartbeats: heartbeats,
      waia_metrics_collector_up: 1,
    };
    return Object.freeze({ ...snapshot, gauges });
  }

  async function collect() {
    if (cached && Date.now() < cacheExpiresAt) return cached;
    if (inFlight) return inFlight;
    inFlight = collectFresh().then((snapshot) => {
      cached = snapshot;
      cacheExpiresAt = Date.now() + Math.max(0, Number(cacheTtlMs) || 0);
      return snapshot;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return Object.freeze({
    collect,
    async prometheus() { return formatPrometheus(await collect()); },
  });
}

function authorizedMetricsRequest(request, token) {
  const authorization = String(request.get?.("authorization") || "");
  if (!authorization.startsWith("Bearer ") || !token) return false;
  const provided = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(String(token), "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createMetricsHandler({ collector, token } = {}) {
  if (typeof collector?.prometheus !== "function") throw new TypeError("Coletor de métricas obrigatório.");
  return async function metricsHandler(request, response, next) {
    if (!token) return response.status(404).end();
    if (!authorizedMetricsRequest(request, token)) {
      response.set("WWW-Authenticate", 'Bearer realm="metrics"');
      return response.status(401).type("text/plain").send("Unauthorized\n");
    }
    try {
      const output = await collector.prometheus();
      response.set({
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      return response.status(200).send(output);
    } catch (error) {
      return next(error);
    }
  };
}
