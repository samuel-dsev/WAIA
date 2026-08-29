function assertMemoryEnvironment(environment = process.env.NODE_ENV || "development") {
  if (environment !== "development" && environment !== "test") {
    throw new Error("Rate limiter em memória permitido apenas em development ou test.");
  }
}

export class MemoryAuthRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60_000, now = Date.now, environment } = {}) {
    assertMemoryEnvironment(environment);
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.now = now;
    this.attempts = new Map();
  }

  async consume({ key }) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const current = (this.attempts.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (current.length >= this.maxAttempts) {
      this.attempts.set(key, current);
      return { allowed: false, retryAfterMs: Math.max(1, current[0] + this.windowMs - now) };
    }
    current.push(now);
    this.attempts.set(key, current);
    return { allowed: true, remaining: this.maxAttempts - current.length };
  }
}

export class RedisAuthRateLimiter {
  constructor(redis, { maxAttempts = 5, windowMs = 15 * 60_000, prefix = "waia:auth-rate:" } = {}) {
    if (typeof redis?.eval !== "function") throw new TypeError("Cliente Redis invalido.");
    this.redis = redis;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  async consume({ key }) {
    const [allowed, ttl, current] = await this.redis.eval(
      `
local current = redis.call('incr', KEYS[1])
if current == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
local ttl = redis.call('pttl', KEYS[1])
if current > tonumber(ARGV[2]) then return {0, ttl, current} end
return {1, ttl, current}`,
      1,
      `${this.prefix}${key}`,
      this.windowMs,
      this.maxAttempts,
    );
    return {
      allowed: Number(allowed) === 1,
      retryAfterMs: Math.max(1, Number(ttl) || this.windowMs),
      remaining: Math.max(0, this.maxAttempts - Number(current)),
    };
  }
}
