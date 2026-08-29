const RATE_SCRIPT = `
local current = redis.call('incr', KEYS[1])
if current == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
local ttl = redis.call('pttl', KEYS[1])
if current > tonumber(ARGV[2]) then return {0, ttl, current} end
return {1, ttl, current}`;

export class RedisTenantRateLimiter {
  constructor(redis, {
    maxPerWindow = 60,
    windowMs = 1_000,
    prefix = "waia:tenant-rate:",
  } = {}) {
    if (typeof redis?.eval !== "function") throw new TypeError("Cliente Redis inválido.");
    this.redis = redis;
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  async consume(empresaId) {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const [allowed, ttl, current] = await this.redis.eval(
      RATE_SCRIPT,
      1,
      `${this.prefix}${empresaId}:${bucket}`,
      this.windowMs,
      this.maxPerWindow,
    );
    return {
      allowed: Number(allowed) === 1,
      retryAfterMs: Math.max(1, Number(ttl) || this.windowMs),
      remaining: Math.max(0, this.maxPerWindow - Number(current)),
    };
  }
}
