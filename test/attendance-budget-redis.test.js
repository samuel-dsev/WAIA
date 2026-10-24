import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { AccountRateLimiter } from '../src/modules/accounts/rate-limiter.js';

test('M5 Redis: orçamento de simulação compartilhado por acesso/empresa e falha fechada', {
  skip: process.env.RUN_REDIS_INTEGRATION !== 'true',
}, async () => {
  const options = { maxRetriesPerRequest: 0 };
  const firstRedis = new Redis(process.env.REDIS_URL, options);
  const secondRedis = new Redis(process.env.REDIS_URL, options);
  // Redis errors must never print the endpoint or credentials in test output.
  firstRedis.on('error', () => {}); secondRedis.on('error', () => {});
  const first = new AccountRateLimiter({ redis: firstRedis, environment: 'production', windowMs: 60_000 });
  const second = new AccountRateLimiter({ redis: secondRedis, environment: 'production', windowMs: 60_000 });
  const userId = randomUUID(), companyId = randomUUID(), neighborId = randomUUID();
  const userKey = `attendance-simulate:user:${userId}`;
  const companyKey = `attendance-simulate:company:${companyId}`;
  const neighborKey = `attendance-simulate:company:${neighborId}`;
  const publishKey = `attendance-publish:user:${userId}`;
  const keys = [userKey, companyKey, neighborKey, publishKey].map((key) => `waia:account-rate:${key}`);
  try {
    await Promise.all([firstRedis.ping(), secondRedis.ping()]);
    // Two API instances must share a single budget despite simultaneous requests.
    const perUser = await Promise.all(Array.from({ length: 25 }, (_, index) =>
      (index % 2 ? first : second).consume({ key: userKey, max: 20 })));
    assert.equal(perUser.filter(({ allowed }) => allowed).length, 20);
    assert.ok(perUser.every(({ retryAfterMs }) => retryAfterMs > 0 && retryAfterMs <= 60_000));
    assert.equal((await second.consume({ key: userKey, max: 20 })).allowed, false);

    const perCompany = await Promise.all(Array.from({ length: 125 }, (_, index) =>
      (index % 2 ? first : second).consume({ key: companyKey, max: 120 })));
    assert.equal(perCompany.filter(({ allowed }) => allowed).length, 120);
    assert.equal((await first.consume({ key: companyKey, max: 120 })).allowed, false);
    assert.equal((await second.consume({ key: neighborKey, max: 120 })).allowed, true);
    assert.equal((await first.consume({ key: publishKey, max: 20 })).allowed, true);
    for (const key of keys) assert.ok(await secondRedis.pttl(key) > 0);

    // A disconnected real Redis client must reject, never switch to memory and
    // accidentally grant a fresh budget. Service-level 503/429 mapping is tested
    // alongside the PostgreSQL publication and authorization fixtures.
    firstRedis.disconnect();
    await assert.rejects(first.consume({ key: userKey, max: 20 }));
    assert.equal(first.buckets.size, 0);
    assert.equal((await second.consume({ key: userKey, max: 20 })).allowed, false);
  } finally {
    try { await secondRedis.del(...keys); }
    finally { firstRedis.disconnect(); secondRedis.disconnect(); }
  }
});
