import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { AccountRateLimiter } from '../src/modules/accounts/rate-limiter.js';

test('contas: rate limit Redis é compartilhado e falha fechado', { skip: process.env.RUN_REDIS_INTEGRATION !== 'true' }, async () => {
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0 });
  const key = `f1-test:${randomUUID()}`;
  const a = new AccountRateLimiter({ redis, environment: 'production' });
  const b = new AccountRateLimiter({ redis, environment: 'production' });
  try {
    const results = await Promise.all([a,b,a,b].map((l) => l.consume({ key, max: 3 })));
    assert.equal(results.filter((r) => r.allowed).length, 3);
    assert.ok(results.every((r) => r.retryAfterMs > 0));
    assert.ok(await redis.pttl(`waia:account-rate:${key}`) > 0);
  } finally {
    await redis.del(`waia:account-rate:${key}`); redis.disconnect();
  }
  const unavailable = new AccountRateLimiter({ redis: { async eval() { throw Error('offline'); } }, environment: 'production' });
  await assert.rejects(unavailable.consume({ key, max: 3 }));
});
