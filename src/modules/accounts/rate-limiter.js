export class AccountRateLimiter {
  constructor({ redis, environment, clock = Date.now, windowMs = 15 * 60_000 }) {
    if (!redis && !['test','development'].includes(environment)) throw new Error('Redis obrigatório para contas.');
    Object.assign(this, { redis, clock, windowMs }); this.buckets = new Map();
  }
  async consume({ key, max }) {
    if (this.redis) {
      const [count, ttl] = await this.redis.eval(`local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('pexpire',KEYS[1],ARGV[1]) end; return {n,redis.call('pttl',KEYS[1])}`, 1, `waia:account-rate:${key}`, this.windowMs);
      return { allowed: Number(count) <= max, retryAfterMs: Math.max(1, Number(ttl)) };
    }
    const now = this.clock();
    for (const [k,b] of this.buckets) if (b.until <= now) this.buckets.delete(k);
    const b = this.buckets.get(key) || { count: 0, until: now + this.windowMs };
    b.count++; this.buckets.set(key, b);
    return { allowed: b.count <= max, retryAfterMs: b.until - now };
  }
}
