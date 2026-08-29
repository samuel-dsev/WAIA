import { retryDelay } from "./backoff.js";
import { normalizeJobReference, queueJobId } from "./job-reference.js";

export class MemoryQueueStore {
  constructor() {
    this.jobs = new Map();
    this.activeConversations = new Set();
    this.activeTenants = new Map();
    this.tenantCursor = 0;
  }

  recoverStalled(now = Date.now()) {
    for (const record of this.jobs.values()) {
      if (record.state === "active" && record.lockedUntil <= now) {
        record.state = "waiting";
        record.availableAt = now;
        if (record.conversationKey) this.activeConversations.delete(record.conversationKey);
        const active = (this.activeTenants.get(record.reference.empresaId) || 1) - 1;
        if (active > 0) this.activeTenants.set(record.reference.empresaId, active);
        else this.activeTenants.delete(record.reference.empresaId);
      }
    }
  }
}

export class MemoryJobQueue {
  constructor({ store = new MemoryQueueStore(), now = Date.now, tenantConcurrency = 1 } = {}) {
    this.store = store;
    this.now = now;
    this.tenantConcurrency = tenantConcurrency;
  }

  async add(input, options = {}) {
    const reference = normalizeJobReference(input);
    const id = queueJobId(reference);
    if (this.store.jobs.has(id)) return this.store.jobs.get(id);
    const record = {
      id,
      reference,
      state: "waiting",
      attempts: 0,
      maxAttempts: Number(options.attempts) || 5,
      availableAt: this.now() + (Number(options.delay) || 0),
      lockedUntil: 0,
      result: null,
      error: null,
      conversationKey: reference.conversationId
        ? `${reference.empresaId}:${reference.conversationId}`
        : null,
    };
    this.store.jobs.set(id, record);
    return record;
  }

  claim({ leaseMs = 30_000 } = {}) {
    const now = this.now();
    this.store.recoverStalled(now);
    const waiting = [...this.store.jobs.values()].filter((record) => (
      record.state === "waiting"
      && record.availableAt <= now
      && (this.store.activeTenants.get(record.reference.empresaId) || 0) < this.tenantConcurrency
      && (!record.conversationKey || !this.store.activeConversations.has(record.conversationKey))
    ));
    if (!waiting.length) return null;
    const tenantIds = [...new Set(waiting.map((record) => record.reference.empresaId))].sort();
    const cursor = this.store.tenantCursor % tenantIds.length;
    const selectedTenant = tenantIds[cursor];
    this.store.tenantCursor = (cursor + 1) % tenantIds.length;
    const selected = waiting
      .filter((record) => record.reference.empresaId === selectedTenant)
      .sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))[0];
    selected.state = "active";
    selected.attempts += 1;
    selected.lockedUntil = now + leaseMs;
    this.store.activeTenants.set(
      selected.reference.empresaId,
      (this.store.activeTenants.get(selected.reference.empresaId) || 0) + 1,
    );
    if (selected.conversationKey) this.store.activeConversations.add(selected.conversationKey);
    return selected;
  }

  complete(record, result) {
    record.state = "completed";
    record.result = result;
    record.lockedUntil = 0;
    this.#releaseTenant(record);
    if (record.conversationKey) this.store.activeConversations.delete(record.conversationKey);
  }

  reject(record, error, options = {}) {
    record.error = error;
    record.lockedUntil = 0;
    this.#releaseTenant(record);
    if (record.conversationKey) this.store.activeConversations.delete(record.conversationKey);
    if (error?.retryable !== false && record.attempts < record.maxAttempts) {
      record.state = "waiting";
      record.availableAt = this.now() + retryDelay(record.attempts, options);
    } else {
      record.state = "failed";
    }
  }

  counts() {
    const counts = { waiting: 0, active: 0, completed: 0, failed: 0 };
    for (const record of this.store.jobs.values()) counts[record.state] += 1;
    return counts;
  }

  #releaseTenant(record) {
    const active = (this.store.activeTenants.get(record.reference.empresaId) || 1) - 1;
    if (active > 0) this.store.activeTenants.set(record.reference.empresaId, active);
    else this.store.activeTenants.delete(record.reference.empresaId);
  }
}

export function createMemoryWorker({
  queue,
  processor,
  concurrency = 1,
  leaseMs = 30_000,
  retry = { baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
} = {}) {
  let closing = false;
  const inflight = new Set();

  async function runRecord(record) {
    try {
      const result = await processor.process(record.reference, {
        attempt: record.attempts,
        maxAttempts: record.maxAttempts,
      });
      queue.complete(record, result);
    } catch (error) {
      queue.reject(record, error, retry);
    }
  }

  async function drain() {
    while (!closing) {
      while (inflight.size < concurrency) {
        const record = queue.claim({ leaseMs });
        if (!record) break;
        const promise = runRecord(record).finally(() => inflight.delete(promise));
        inflight.add(promise);
      }
      if (!inflight.size) break;
      await Promise.race(inflight);
    }
    await Promise.allSettled([...inflight]);
    return queue.counts();
  }

  async function close() {
    closing = true;
    await Promise.allSettled([...inflight]);
  }

  return Object.freeze({ drain, close });
}

export class MemoryJobRepository {
  constructor({ records = new Map() } = {}) {
    this.records = records;
    this.failed = new Map();
  }

  seed(reference, state = "published") {
    this.records.set(queueJobId(reference), { reference: normalizeJobReference(reference), state, attempts: 0 });
  }

  async claim(reference, { attempt } = {}) {
    const record = this.records.get(queueJobId(reference));
    if (!record) return { outcome: "missing" };
    if (record.state === "completed") return { outcome: "completed" };
    if (record.state === "processing") return { outcome: "busy" };
    if (record.state === "failed") return { outcome: "failed" };
    record.state = "processing";
    record.attempts = Math.max(record.attempts, attempt || 1);
    return { outcome: "claimed", record };
  }

  async complete(reference) {
    const record = this.records.get(queueJobId(reference));
    if (record) record.state = "completed";
  }

  async retry(reference, { error } = {}) {
    const record = this.records.get(queueJobId(reference));
    if (record) {
      record.state = "published";
      record.error = error;
    }
  }

  async fail(reference, details = {}) {
    const id = queueJobId(reference);
    const record = this.records.get(id);
    if (record) record.state = "failed";
    this.failed.set(id, { reference, ...details });
  }
}

export class MemoryLockManager {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.locks = new Map();
  }

  async acquire(key, { ttlMs = 30_000 } = {}) {
    const current = this.locks.get(key);
    if (current && current.expiresAt > this.now()) return null;
    const token = Symbol(key);
    this.locks.set(key, { token, expiresAt: this.now() + ttlMs });
    return {
      renew: async (nextTtlMs = ttlMs) => {
        const lock = this.locks.get(key);
        if (!lock || lock.token !== token) return false;
        lock.expiresAt = this.now() + nextTtlMs;
        return true;
      },
      release: async () => {
        if (this.locks.get(key)?.token === token) this.locks.delete(key);
      },
    };
  }
}

export class MemoryTenantRateLimiter {
  constructor({ maxPerWindow = 60, windowMs = 1_000, now = Date.now } = {}) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.now = now;
    this.events = new Map();
  }

  async consume(empresaId) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const current = (this.events.get(empresaId) || []).filter((timestamp) => timestamp > cutoff);
    if (current.length >= this.maxPerWindow) {
      this.events.set(empresaId, current);
      return { allowed: false, retryAfterMs: Math.max(1, current[0] + this.windowMs - now) };
    }
    current.push(now);
    this.events.set(empresaId, current);
    return { allowed: true, remaining: this.maxPerWindow - current.length };
  }
}
