import test from "node:test";
import assert from "node:assert/strict";
import {
  RedisConversationLockManager,
  RedisTenantConcurrencyLimiter,
  RedisTenantRateLimiter,
} from "../src/infra/redis/index.js";

test("lock Redis usa token, renova lease e libera atomicamente", async () => {
  const calls = [];
  const redis = {
    async set(...args) { calls.push(["set", ...args]); return "OK"; },
    async eval(...args) { calls.push(["eval", ...args]); return 1; },
  };
  const manager = new RedisConversationLockManager(redis);
  const lease = await manager.acquire("tenant:conversation", { ttlMs: 500 });
  assert.ok(lease);
  assert.equal(await lease.renew(750), true);
  await lease.release();
  assert.deepEqual(calls[0].slice(0, 2), ["set", "waia:conversation-lock:tenant:conversation"]);
  assert.equal(calls.filter(([method]) => method === "eval").length, 2);
});

test("rate limit Redis usa bucket isolado por empresa", async () => {
  const keys = [];
  const redis = {
    async eval(_script, _numberOfKeys, key) { keys.push(key); return [1, 900, 1]; },
  };
  const limiter = new RedisTenantRateLimiter(redis, { maxPerWindow: 10, windowMs: 1_000 });
  assert.equal((await limiter.consume("tenant-a")).allowed, true);
  assert.equal((await limiter.consume("tenant-b")).allowed, true);
  assert.match(keys[0], /tenant-a/u);
  assert.match(keys[1], /tenant-b/u);
  assert.notEqual(keys[0], keys[1]);
});

test("limite concorrente Redis cria slot renovável por empresa", async () => {
  const calls = [];
  const redis = {
    async eval(...args) { calls.push(["eval", ...args]); return 1; },
    async zrem(...args) { calls.push(["zrem", ...args]); return 1; },
  };
  const limiter = new RedisTenantConcurrencyLimiter(redis, { maxPerTenant: 2, ttlMs: 500 });
  const release = await limiter.acquire("tenant-a");
  assert.equal(typeof release, "function");
  assert.equal(await release.renew(750), true);
  await release();
  assert.equal(calls[0][2], 1);
  assert.equal(calls.at(-1)[0], "zrem");
});
