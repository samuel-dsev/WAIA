import { randomUUID } from "node:crypto";

const ACQUIRE_SCRIPT = `
redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
redis.call('pexpire', KEYS[1], ARGV[5])
return 1`;

const RENEW_SCRIPT = `
if redis.call('zscore', KEYS[1], ARGV[1]) then
  redis.call('zadd', KEYS[1], ARGV[2], ARGV[1])
  redis.call('pexpire', KEYS[1], ARGV[3])
  return 1
end
return 0`;

export class RedisTenantConcurrencyLimiter {
  constructor(redis, { maxPerTenant = 1, ttlMs = 30_000, prefix = "waia:tenant-slots:" } = {}) {
    if (typeof redis?.eval !== "function") throw new TypeError("Cliente Redis inválido.");
    this.redis = redis;
    this.maxPerTenant = maxPerTenant;
    this.ttlMs = ttlMs;
    this.prefix = prefix;
  }

  async acquire(empresaId) {
    const key = `${this.prefix}${empresaId}`;
    const token = randomUUID();
    const now = Date.now();
    const acquired = Number(await this.redis.eval(
      ACQUIRE_SCRIPT,
      1,
      key,
      now,
      this.maxPerTenant,
      now + this.ttlMs,
      token,
      this.ttlMs,
    ));
    if (acquired !== 1) return null;
    const release = async () => { await this.redis.zrem(key, token); };
    release.renew = async (ttlMs = this.ttlMs) => Number(await this.redis.eval(
      RENEW_SCRIPT,
      1,
      key,
      token,
      Date.now() + ttlMs,
      ttlMs,
    )) === 1;
    return release;
  }
}
