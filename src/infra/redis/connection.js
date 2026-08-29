import Redis from "ioredis";

export function createRedisConnection({ url = process.env.REDIS_URL, ...options } = {}) {
  if (!url) throw new Error("Redis não configurado. Informe REDIS_URL.");
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    ...options,
  });
}

export async function closeRedisConnection(connection) {
  if (!connection) return;
  try {
    await connection.quit();
  } catch {
    connection.disconnect?.();
  }
}
