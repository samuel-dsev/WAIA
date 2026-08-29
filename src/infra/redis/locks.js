import { randomUUID } from "node:crypto";

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export class RedisConversationLockManager {
  constructor(redis, { prefix = "waia:conversation-lock:" } = {}) {
    if (typeof redis?.set !== "function" || typeof redis?.eval !== "function") {
      throw new TypeError("Cliente Redis inválido.");
    }
    this.redis = redis;
    this.prefix = prefix;
  }

  async acquire(resource, { ttlMs = 30_000 } = {}) {
    const key = `${this.prefix}${resource}`;
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, "PX", ttlMs, "NX");
    if (acquired !== "OK") return null;
    return Object.freeze({
      renew: async (nextTtlMs = ttlMs) => (
        Number(await this.redis.eval(RENEW_SCRIPT, 1, key, token, nextTtlMs)) === 1
      ),
      release: async () => {
        await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
      },
    });
  }
}
